import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IPty } from 'node-pty'
import {
  type HookPayload,
  PtyHookServer,
  writePtyMcpConfig,
  writePtySettings,
} from './jinn-pty-hooks.mjs'
import {
  CompactionStreamGate,
  MAIN_AGENT_SENTINEL,
  type SseDataEvent,
  SsePtyProxy,
  sseEventToDeltas,
} from './jinn-pty-proxy.mjs'
import {
  chooseApproval,
  chooseRejection,
  composerReady,
  keystrokesToSelect,
  PtyScreen,
  parsePermissionPrompt,
  parseStartupPrompt,
  pasteAndSubmit,
} from './jinn-pty-screen.mjs'
import {
  lastAssistantTextFromTranscript,
  sanitizeAssistantText,
  sumTranscriptUsage,
} from './jinn-pty-transcript.mjs'
import type {
  ClaudeRuntime,
  PermissionDecision,
  RuntimeHandlers,
  RuntimeTurnContext,
} from './types.mjs'
import { debugLog } from './util.mjs'

// node-pty is CommonJS; resolve it through require so the ESM interop shape
// never matters. Loaded lazily so importing this module (tests, factory) does
// not need the native binding until a PTY is actually spawned.
const require = createRequire(import.meta.url)

export interface JinnPtyRuntimeOptions {
  // `claude` binary (or a .mjs/.js script run under the current node, used by
  // the tests' fake CLI).
  cli: string
  cols: number
  rows: number
  // Wall-clock cap for one turn; 0 disables. On expiry the transcript is
  // consulted before the turn is failed.
  turnTimeoutMs: number
  // How long to wait for the composer after a cold spawn (trust dialog etc).
  startupTimeoutMs: number
  streamProxy: boolean
  extraArgs: string[]
  hookTimeoutSec: number
  autoApproveSafetyPrompts: boolean
  // Keep ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the child env. Off by
  // default so the TUI always authenticates with the subscription login.
  keepApiKey: boolean
  stateDir: string
  relayScript: string
  nodeBinary: string
}

const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'Task',
  'Agent',
])
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'max'])
const IMMEDIATE_STOP_FAILURE_ERRORS = new Set([
  'rate_limit',
  'billing_error',
  'authentication_failed',
  'max_output_tokens',
])
const STOP_FAILURE_GRACE_MS = 20_000
const STARTUP_POLL_MS = 250
const STARTUP_HOOK_GRACE_MS = 3000
const PERMISSION_PROMPT_SETTLE_MS = 400
const PERMISSION_PROMPT_VERIFY_MS = 1500
const PERMISSION_PROMPT_MAX_ATTEMPTS = 3
// Claude-native slash commands run locally and never fire a Stop hook; the
// turn settles once the TUI goes quiet instead.
const NATIVE_COMMANDS = new Set(['/compact', '/clear', '/model', '/cost', '/status', '/help'])
const NATIVE_COMMAND_MIN_MS = 3000
const NATIVE_COMMAND_QUIET_MS = 1800
const NATIVE_COMMAND_MAX_MS = 90_000

interface PtySession {
  threadId: string
  proc: IPty
  screen: PtyScreen
  proxy: SsePtyProxy | null
  cwd: string
  model: string | null
  claudeSessionId: string | null
  settingsPath: string
  mcpPath: string | null
  exited: boolean
  disposed: boolean
  sessionStarted: boolean
  lastOutputAt: number
}

interface PendingTool {
  toolName: string
  input: Record<string, unknown>
  decision: 'allow' | 'deny' | null
}

interface ActiveTurn {
  context: RuntimeTurnContext
  handlers: RuntimeHandlers
  session: PtySession
  startedAt: number
  settled: boolean
  resolve: () => void
  reject: (error: Error) => void
  gate: CompactionStreamGate
  streamedChars: number
  promptSubmitted: boolean
  pendingTools: Map<string, PendingTool>
  lastToolUseId: string | null
  cancelSubmit: (() => void) | null
  stopFailure: HookPayload | null
  graceTimer: NodeJS.Timeout | null
  timeoutTimer: NodeJS.Timeout | null
  nativeTimer: NodeJS.Timeout | null
  approvingPrompt: boolean
}

export class JinnPtyRuntime implements ClaudeRuntime {
  private readonly options: JinnPtyRuntimeOptions
  private readonly sessions = new Map<string, PtySession>()
  private readonly turns = new Map<string, ActiveTurn>()
  private readonly hooks: PtyHookServer
  private hooksStarted: Promise<number> | null = null
  private spawnSeq = 0
  private stopped = false

  constructor(options: JinnPtyRuntimeOptions) {
    this.options = options
    this.hooks = new PtyHookServer((threadId, payload) => this.onHook(threadId, payload))
  }

  // True while any warm PTY exists — the daemon must not idle-exit then.
  hasLivePtys(): boolean {
    return this.sessions.size > 0
  }

  livePids(): number[] {
    return [...this.sessions.values()].map((session) => session.proc.pid)
  }

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    if (this.stopped) throw new Error('jinn-pty runtime is stopped')
    if (this.turns.has(context.threadId)) {
      throw new Error('jinn-pty runtime: a turn is already running for this thread')
    }
    await this.ensureHooks()

    let session = this.sessions.get(context.threadId)
    let fresh = false
    if (session && (session.exited || session.model !== (context.model ?? null))) {
      // `--model` binds at spawn; a changed model means a cold respawn that
      // resumes the same Claude session.
      this.releaseSession(session, 'respawn')
      session = undefined
    }
    if (!session) {
      session = await this.spawn(context)
      fresh = true
    }
    const active = session

    let resolveTurn!: () => void
    let rejectTurn!: (error: Error) => void
    const done = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve
      rejectTurn = reject
    })
    const turn: ActiveTurn = {
      context,
      handlers,
      session: active,
      startedAt: Date.now(),
      settled: false,
      resolve: resolveTurn,
      reject: rejectTurn,
      gate: new CompactionStreamGate(),
      streamedChars: 0,
      promptSubmitted: false,
      pendingTools: new Map(),
      lastToolUseId: null,
      cancelSubmit: null,
      stopFailure: null,
      graceTimer: null,
      timeoutTimer: null,
      nativeTimer: null,
      approvingPrompt: false,
    }
    this.turns.set(context.threadId, turn)

    try {
      if (fresh) await this.awaitReady(active, turn)
      if (turn.settled) return await done
      if (active.claudeSessionId) {
        await handlers.onEvent({ type: 'session', claudeSessionId: active.claudeSessionId })
      }
      const prompt = await this.composePrompt(context, handlers)
      const native = isNativeClaudeCommand(prompt)
      turn.cancelSubmit = pasteAndSubmit(
        active.proc,
        prompt,
        native
          ? undefined
          : {
              submitted: () => turn.promptSubmitted || turn.settled,
              busy: () => turn.pendingTools.size > 0 || (active.proxy?.activeStreams ?? 0) > 0,
              onRetry: (attempt) =>
                debugLog('jinnPty.submit.retry', { threadId: context.threadId, attempt }),
              onUnconfirmed: () =>
                void handlers.onEvent({
                  type: 'notice',
                  level: 'warning',
                  message:
                    'jinn-pty: Claude Code never acknowledged the prompt; it may be stranded in the TUI composer.',
                }),
            },
      )
      if (native) this.armNativeCommandTimer(turn)
      this.armTurnTimeout(turn)
      await done
    } finally {
      this.clearTurnTimers(turn)
      turn.cancelSubmit?.()
      if (this.turns.get(context.threadId) === turn) this.turns.delete(context.threadId)
    }
  }

  async steer(threadId: string, prompt: string): Promise<void> {
    const session = this.sessions.get(threadId)
    if (!session || session.exited) throw new Error('jinn-pty runtime: no live PTY for thread')
    pasteAndSubmit(session.proc, prompt)
  }

  async interrupt(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId)
    const turn = this.turns.get(threadId)
    if (session && !session.exited) {
      try {
        session.proc.write('\x1b')
      } catch {}
    }
    if (turn) this.settle(turn)
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const turn of [...this.turns.values()]) {
      this.settle(turn, new Error('jinn-pty runtime stopped'))
    }
    for (const session of [...this.sessions.values()]) this.releaseSession(session, 'stop')
    this.hooks.stop()
    this.hooksStarted = null
    try {
      rmSync(this.options.stateDir, { recursive: true, force: true })
    } catch {}
  }

  // -------------------------------------------------------------------------
  // Spawn / lifecycle

  private ensureHooks(): Promise<number> {
    if (!this.hooksStarted) this.hooksStarted = this.hooks.start()
    return this.hooksStarted
  }

  private async spawn(context: RuntimeTurnContext): Promise<PtySession> {
    repairNodePtySpawnHelper()
    const { spawn } = require('node-pty') as typeof import('node-pty')
    this.spawnSeq += 1
    const fileStem = `${context.threadId}-${this.spawnSeq}`
    const settingsPath = writePtySettings(this.options.stateDir, {
      threadId: context.threadId,
      fileStem,
      relayScript: this.options.relayScript,
      nodeBinary: this.options.nodeBinary,
      hookTimeoutSec: this.options.hookTimeoutSec,
    })
    const mcpPath = context.mcpServers
      ? writePtyMcpConfig(this.options.stateDir, fileStem, context.mcpServers)
      : null

    let proxy: SsePtyProxy | null = null
    if (this.options.streamProxy) {
      const candidate = new SsePtyProxy(context.threadId, (event) =>
        this.onSseEvent(context.threadId, event),
      )
      try {
        await candidate.start()
        proxy = candidate
      } catch (err) {
        candidate.stop()
        debugLog('jinnPty.proxy.startFailed', {
          threadId: context.threadId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const args = buildInteractiveArgs({
      context,
      settingsPath,
      mcpPath,
      extraArgs: this.options.extraArgs,
    })
    const env = this.buildEnv(proxy)
    const { file, argv } = resolveCliInvocation(this.options.cli, args)
    debugLog('jinnPty.spawn', {
      threadId: context.threadId,
      cwd: context.cwd,
      resume: context.claudeSessionId,
      model: context.model,
      proxyPort: proxy?.port ?? 0,
    })
    const proc = spawn(file, argv, {
      name: 'xterm-256color',
      cols: this.options.cols,
      rows: this.options.rows,
      cwd: context.cwd,
      env,
    })
    const session: PtySession = {
      threadId: context.threadId,
      proc,
      screen: new PtyScreen(this.options.cols, this.options.rows),
      proxy,
      cwd: context.cwd,
      model: context.model ?? null,
      claudeSessionId: context.claudeSessionId ?? null,
      settingsPath,
      mcpPath,
      exited: false,
      disposed: false,
      sessionStarted: false,
      lastOutputAt: Date.now(),
    }
    proc.onData((data) => {
      session.lastOutputAt = Date.now()
      session.screen.write(data)
    })
    proc.onExit((event) => {
      session.exited = true
      if (this.sessions.get(session.threadId) === session) this.sessions.delete(session.threadId)
      // Read the last screen lines before disposing: they are the only account
      // of why the CLI died (auth error, bad flag, crash).
      void session.screen
        .viewport()
        .catch(() => [] as string[])
        .then((viewport) => {
          const tail = viewport
            .filter((line) => line.trim())
            .slice(-6)
            .join('\n')
          debugLog('jinnPty.exit', { threadId: session.threadId, exitCode: event.exitCode, tail })
          this.disposeSession(session)
          const turn = this.turns.get(session.threadId)
          if (turn && turn.session === session && !turn.settled) {
            void this.failTurn(
              turn,
              `claude process exited (code ${event.exitCode ?? 'unknown'}) before the turn completed${tail ? `:\n${tail}` : ''}`,
            )
          }
        })
    })
    this.sessions.set(context.threadId, session)
    return session
  }

  private releaseSession(session: PtySession, reason: string): void {
    if (this.sessions.get(session.threadId) === session) this.sessions.delete(session.threadId)
    debugLog('jinnPty.release', { threadId: session.threadId, reason, pid: session.proc.pid })
    if (!session.exited) {
      try {
        session.proc.kill('SIGTERM')
      } catch {}
      const force = setTimeout(() => {
        if (!session.exited) {
          try {
            session.proc.kill('SIGKILL')
          } catch {}
        }
      }, 2000)
      force.unref()
    }
    this.disposeSession(session)
  }

  private disposeSession(session: PtySession): void {
    if (session.disposed) return
    session.disposed = true
    session.proxy?.stop()
    session.proxy = null
    session.screen.dispose()
    for (const file of [session.settingsPath, session.mcpPath]) {
      if (!file) continue
      try {
        rmSync(file, { force: true })
      } catch {}
    }
  }

  private buildEnv(proxy: SsePtyProxy | null): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue
      // Nested-session markers would make the child refuse to start.
      if (key === 'CLAUDECODE' || key === 'CLAUDE_CODE_ENTRYPOINT') continue
      if (key === 'ANTHROPIC_BASE_URL') continue
      if (
        !this.options.keepApiKey &&
        (key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_AUTH_TOKEN')
      )
        continue
      env[key] = value
    }
    env.TERM = 'xterm-256color'
    // Main-screen renderer so the headless screen keeps scrollback; suppress
    // the "resume from summary?" picker so --resume always full-resumes.
    env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1'
    env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = '999999999'
    env.CLAUDE_CODEX_PTY_HOOK_URL = this.hooks.url
    env.CLAUDE_CODEX_PTY_HOOK_TOKEN = this.hooks.token
    if (proxy) {
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxy.port}`
      // The proxy forwards unchanged, so this still is a first-party session;
      // the CLI decides that by host string, and a loopback host would drop
      // the model's context ceiling to the 200K fallback.
      env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
    }
    return env
  }

  // Poll the screen after a cold spawn: answer startup dialogs (workspace
  // trust defaults to "No, exit"), then wait for the composer or SessionStart.
  private async awaitReady(session: PtySession, turn: ActiveTurn): Promise<void> {
    const startedAt = Date.now()
    const deadline = startedAt + this.options.startupTimeoutMs
    let answered = false
    while (Date.now() < deadline && !turn.settled && !session.exited) {
      const viewport = await session.screen.viewport()
      // The answered dialog may linger in scrollback; only answer it once.
      const dialog = answered ? null : parseStartupPrompt(viewport)
      if (dialog) {
        debugLog('jinnPty.startupPrompt', { threadId: session.threadId, label: dialog.label })
        for (const key of dialog.keystrokes) session.proc.write(key)
        answered = true
        await delay(STARTUP_POLL_MS * 2)
        continue
      }
      if (composerReady(viewport)) return
      // SessionStart alone is accepted only after a grace period, since a
      // startup dialog can render after the hook fires.
      if (session.sessionStarted && Date.now() - startedAt > STARTUP_HOOK_GRACE_MS) return
      await delay(STARTUP_POLL_MS)
    }
    if (!turn.settled && !session.exited) {
      await turn.handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: 'jinn-pty: Claude Code composer not detected in time; submitting anyway.',
      })
    }
  }

  private async composePrompt(
    context: RuntimeTurnContext,
    handlers: RuntimeHandlers,
  ): Promise<string> {
    let prompt = context.prompt
    if (context.imageInputs.length === 0) return prompt
    const paths: string[] = []
    for (const [index, image] of context.imageInputs.entries()) {
      if (image.kind === 'url' && /^https?:/.test(image.data)) {
        paths.push(image.data)
        continue
      }
      if (image.kind === 'url' && existsSync(image.data)) {
        paths.push(image.data)
        continue
      }
      if (image.kind === 'base64') {
        const ext = image.mediaType.split('/')[1] ?? 'png'
        const file = join(this.options.stateDir, `${context.turnId}-${index}.${ext}`)
        mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 })
        writeFileSync(file, Buffer.from(image.data, 'base64'), { mode: 0o600 })
        paths.push(file)
      }
    }
    if (paths.length === 0) {
      await handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: 'jinn-pty: image attachments could not be materialised; sending text only.',
      })
      return prompt
    }
    // Backticks keep the TUI from auto-attaching the file during the paste
    // (an async state that swallows the submit CR); Claude reads it instead.
    prompt += `\n\nAttached files:\n${paths.map((p) => `- \`${p}\``).join('\n')}`
    return prompt
  }

  // -------------------------------------------------------------------------
  // Hooks

  private async onHook(threadId: string, payload: HookPayload): Promise<unknown> {
    const session = this.sessions.get(threadId)
    const turn = this.turns.get(threadId)
    const event = payload.hook_event_name
    debugLog('jinnPty.hook', { threadId, event, tool: payload.tool_name ?? null })
    if (event === 'SessionStart') {
      if (session) {
        session.sessionStarted = true
        if (typeof payload.session_id === 'string' && payload.session_id) {
          session.claudeSessionId = payload.session_id
          if (turn && !turn.settled) {
            await turn.handlers.onEvent({ type: 'session', claudeSessionId: payload.session_id })
          }
        }
      }
      return undefined
    }
    if (!turn || turn.settled || (session && turn.session !== session)) {
      // No Codex turn owns this PTY right now (interrupted, or a stale
      // process). Tools may not run unattended.
      if (event === 'PreToolUse') return permissionOutput('deny', 'no active Codex turn')
      return undefined
    }
    switch (event) {
      case 'UserPromptSubmit':
        turn.promptSubmitted = true
        return undefined
      case 'PreToolUse':
        turn.promptSubmitted = true
        return await this.onPreToolUse(turn, payload)
      case 'PostToolUse':
        turn.promptSubmitted = true
        await this.onPostToolUse(turn, payload)
        return undefined
      case 'Stop':
        turn.promptSubmitted = true
        this.clearGrace(turn)
        turn.stopFailure = null
        await this.completeTurn(turn, payload)
        return undefined
      case 'StopFailure':
        turn.promptSubmitted = true
        turn.stopFailure = payload
        if (IMMEDIATE_STOP_FAILURE_ERRORS.has(String(payload.error ?? 'unknown'))) {
          await this.failTurn(turn, stopFailureMessage(payload))
        } else {
          // The CLI usually retries invalid_request / server_error; a later
          // Stop supersedes the failure.
          this.armGrace(turn)
        }
        return undefined
      case 'Notification':
        if (payload.notification_type === 'permission_prompt') {
          void this.answerPermissionPrompt(turn)
        }
        return undefined
      default:
        return undefined
    }
  }

  private async onPreToolUse(turn: ActiveTurn, payload: HookPayload): Promise<unknown> {
    const toolName = String(payload.tool_name ?? 'tool')
    const toolUseId =
      typeof payload.tool_use_id === 'string' && payload.tool_use_id
        ? payload.tool_use_id
        : `pty-${randomUUID()}`
    const input = asRecord(payload.tool_input)
    const pending: PendingTool = { toolName, input, decision: null }
    turn.pendingTools.set(toolUseId, pending)
    turn.lastToolUseId = toolUseId
    await turn.handlers.onEvent({ type: 'tool_use', toolUseId, toolName, input })

    if (!this.needsApproval(turn.context, toolName)) {
      pending.decision = 'allow'
      return permissionOutput('allow', 'auto-approved by claude-codex')
    }
    const requestId = `${turn.context.threadId}:${turn.context.turnId}:${toolName}:${toolUseId}`
    let decision: PermissionDecision
    try {
      decision = await turn.handlers.onPermissionRequest({
        type: 'permission_request',
        requestId,
        toolUseId,
        toolName,
        input,
      })
    } catch (err) {
      pending.decision = 'deny'
      return permissionOutput('deny', err instanceof Error ? err.message : String(err))
    }
    if (decision.decision === 'accept' || decision.decision === 'acceptForSession') {
      pending.decision = 'allow'
      return permissionOutput('allow', 'approved in Codex', decision.updatedInput)
    }
    pending.decision = 'deny'
    return permissionOutput('deny', 'denied by user')
  }

  private needsApproval(context: RuntimeTurnContext, toolName: string): boolean {
    if (READ_ONLY_TOOLS.has(toolName)) return false
    if (context.approvalPolicy === 'never' || context.sandboxMode === 'danger-full-access')
      return false
    if (context.allowedTools?.includes(toolName)) return false
    return true
  }

  private async onPostToolUse(turn: ActiveTurn, payload: HookPayload): Promise<void> {
    const toolUseId =
      typeof payload.tool_use_id === 'string' && payload.tool_use_id
        ? payload.tool_use_id
        : (turn.lastToolUseId ?? `pty-${randomUUID()}`)
    turn.pendingTools.delete(toolUseId)
    const { content, isError } = shapeToolResult(payload.tool_name, payload.tool_response)
    await turn.handlers.onEvent({ type: 'tool_result', toolUseId, content, isError })
  }

  // Claude Code's hardcoded safety prompts ignore hook decisions; answer the
  // TUI consistently with the decision the App already made for the pending
  // tool (or ask it now when we never got to decide).
  private async answerPermissionPrompt(turn: ActiveTurn, attempt = 1): Promise<void> {
    if (!this.options.autoApproveSafetyPrompts) {
      await turn.handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: 'jinn-pty: Claude Code is blocked on a safety prompt; auto-answering is disabled.',
      })
      return
    }
    if (turn.approvingPrompt && attempt === 1) return
    turn.approvingPrompt = true
    try {
      await delay(attempt === 1 ? PERMISSION_PROMPT_SETTLE_MS : PERMISSION_PROMPT_VERIFY_MS)
      if (turn.settled || turn.session.exited) return
      const viewport = await turn.session.screen.viewport()
      const prompt = parsePermissionPrompt(viewport)
      if (!prompt) {
        if (attempt >= PERMISSION_PROMPT_MAX_ATTEMPTS) return
        return await this.answerPermissionPrompt(turn, attempt + 1)
      }
      const pending = turn.lastToolUseId ? turn.pendingTools.get(turn.lastToolUseId) : undefined
      let allow: boolean
      if (pending?.decision) {
        allow = pending.decision === 'allow'
      } else if (pending && turn.lastToolUseId) {
        const decision = await turn.handlers.onPermissionRequest({
          type: 'permission_request',
          requestId: `${turn.context.threadId}:${turn.context.turnId}:prompt:${turn.lastToolUseId}`,
          toolUseId: turn.lastToolUseId,
          toolName: pending.toolName,
          input: pending.input,
        })
        allow = decision.decision === 'accept' || decision.decision === 'acceptForSession'
        pending.decision = allow ? 'allow' : 'deny'
      } else {
        await turn.handlers.onEvent({
          type: 'notice',
          level: 'warning',
          message: `jinn-pty: unrecognised safety prompt (${prompt.reason ?? 'no reason'}); leaving it unanswered.`,
        })
        return
      }
      const target = allow ? chooseApproval(prompt) : chooseRejection(prompt)
      if (!target) return
      debugLog('jinnPty.safetyPrompt', {
        threadId: turn.context.threadId,
        attempt,
        reason: prompt.reason ?? null,
        answer: target.label,
      })
      for (const key of keystrokesToSelect(prompt.selectedPosition, target.position)) {
        turn.session.proc.write(key)
      }
      if (attempt < PERMISSION_PROMPT_MAX_ATTEMPTS) {
        return await this.answerPermissionPrompt(turn, attempt + 1)
      }
    } catch (err) {
      debugLog('jinnPty.safetyPrompt.error', {
        threadId: turn.context.threadId,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (attempt === 1) turn.approvingPrompt = false
    }
  }

  // -------------------------------------------------------------------------
  // Streaming

  private onSseEvent(threadId: string, event: SseDataEvent): void {
    const turn = this.turns.get(threadId)
    if (!turn || turn.settled) return
    if (event.type === 'message_start') turn.gate.reset()
    const deltas = turn.gate.accept(sseEventToDeltas(event))
    if (event.type === 'message_stop') deltas.push(...turn.gate.end())
    for (const delta of deltas) {
      if (delta.type === 'text') {
        turn.streamedChars += delta.content.length
        void turn.handlers.onEvent({ type: 'text_delta', delta: delta.content })
      } else if (delta.type === 'thinking') {
        void turn.handlers.onEvent({ type: 'reasoning_delta', delta: delta.content })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Completion

  private async completeTurn(turn: ActiveTurn, payload: HookPayload): Promise<void> {
    if (turn.settled) return
    const transcriptPath =
      typeof payload.transcript_path === 'string' ? payload.transcript_path : null
    let text = sanitizeAssistantText(String(payload.last_assistant_message ?? ''))
    if (!text && transcriptPath) {
      text = sanitizeAssistantText(
        lastAssistantTextFromTranscript(transcriptPath, turn.startedAt - 1000) ?? '',
      )
    }
    await this.finishTurn(turn, text, transcriptPath, 'stop')
  }

  private async finishTurn(
    turn: ActiveTurn,
    text: string,
    transcriptPath: string | null,
    reason: string,
  ): Promise<void> {
    if (turn.settled) return
    const handlers = turn.handlers
    try {
      // Without the SSE tee (or when it never saw this message) the App has
      // not received the text yet; deliver it in one delta.
      if (turn.streamedChars === 0 && text) {
        await handlers.onEvent({ type: 'text_delta', delta: text })
      }
      if (transcriptPath) {
        const usage = sumTranscriptUsage(transcriptPath, turn.startedAt - 1000)
        if (usage.input_tokens + usage.output_tokens > 0) {
          await handlers.onEvent({
            type: 'usage',
            usage: {
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens,
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
            },
          })
        }
        await handlers.onEvent({
          type: 'metrics',
          durationMs: Date.now() - turn.startedAt,
          apiDurationMs: null,
          numTurns: usage.assistant_turns || null,
          costUsd: null,
        })
      }
      debugLog('jinnPty.turn.completed', {
        threadId: turn.context.threadId,
        turnId: turn.context.turnId,
        reason,
        chars: text.length,
      })
      await handlers.onEvent({
        type: 'completed',
        success: true,
        result: text || null,
        claudeSessionId: turn.session.claudeSessionId,
      })
      this.settle(turn)
    } catch (err) {
      this.settle(turn, err instanceof Error ? err : new Error(String(err)))
    }
  }

  private async failTurn(turn: ActiveTurn, message: string): Promise<void> {
    if (turn.settled) return
    debugLog('jinnPty.turn.failed', { threadId: turn.context.threadId, message })
    try {
      await turn.handlers.onEvent({
        type: 'completed',
        success: false,
        result: message,
        claudeSessionId: turn.session.claudeSessionId,
      })
    } catch {}
    this.settle(turn, new Error(message))
  }

  private settle(turn: ActiveTurn, error?: Error): void {
    if (turn.settled) return
    turn.settled = true
    this.clearTurnTimers(turn)
    turn.cancelSubmit?.()
    turn.cancelSubmit = null
    if (this.turns.get(turn.context.threadId) === turn) this.turns.delete(turn.context.threadId)
    if (error) turn.reject(error)
    else turn.resolve()
  }

  private armGrace(turn: ActiveTurn): void {
    this.clearGrace(turn)
    turn.graceTimer = setTimeout(() => {
      turn.graceTimer = null
      if (turn.settled || !turn.stopFailure) return
      void this.failTurn(turn, stopFailureMessage(turn.stopFailure))
    }, STOP_FAILURE_GRACE_MS)
    turn.graceTimer.unref()
  }

  private clearGrace(turn: ActiveTurn): void {
    if (turn.graceTimer) clearTimeout(turn.graceTimer)
    turn.graceTimer = null
  }

  private armTurnTimeout(turn: ActiveTurn): void {
    if (this.options.turnTimeoutMs <= 0) return
    turn.timeoutTimer = setTimeout(() => {
      turn.timeoutTimer = null
      if (turn.settled) return
      const transcript = findTranscript(turn.session)
      const recovered = transcript
        ? lastAssistantTextFromTranscript(transcript, turn.startedAt - 1000)
        : undefined
      if (recovered?.trim()) {
        void this.finishTurn(
          turn,
          sanitizeAssistantText(recovered),
          transcript,
          'timeout-recovered',
        )
        return
      }
      void this.failTurn(turn, `jinn-pty turn timed out after ${this.options.turnTimeoutMs}ms`)
    }, this.options.turnTimeoutMs)
    turn.timeoutTimer.unref()
  }

  private armNativeCommandTimer(turn: ActiveTurn): void {
    const startedAt = Date.now()
    turn.nativeTimer = setInterval(() => {
      const now = Date.now()
      const quietFor = now - turn.session.lastOutputAt
      const elapsed = now - startedAt
      if (
        (elapsed >= NATIVE_COMMAND_MIN_MS && quietFor >= NATIVE_COMMAND_QUIET_MS) ||
        elapsed >= NATIVE_COMMAND_MAX_MS
      ) {
        void this.finishTurn(turn, '', null, 'native-command')
      }
    }, 500)
    turn.nativeTimer.unref()
  }

  private clearTurnTimers(turn: ActiveTurn): void {
    this.clearGrace(turn)
    if (turn.timeoutTimer) clearTimeout(turn.timeoutTimer)
    turn.timeoutTimer = null
    if (turn.nativeTimer) clearInterval(turn.nativeTimer)
    turn.nativeTimer = null
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)

export interface InteractiveArgsInput {
  context: RuntimeTurnContext
  settingsPath: string
  mcpPath: string | null
  extraArgs: string[]
}

export function buildInteractiveArgs(input: InteractiveArgsInput): string[] {
  const { context } = input
  const args: string[] = []
  if (context.claudeSessionId) {
    args.push('--resume', context.claudeSessionId)
    if (context.forkSession) args.push('--fork-session')
  }
  if (context.model) args.push('--model', context.model)
  if (context.effort && EFFORT_LEVELS.has(context.effort)) args.push('--effort', context.effort)
  args.push('--settings', input.settingsPath)
  // AskUserQuestion / ExitPlanMode render TUI dialogs no hook can answer.
  args.push('--disallowedTools', 'AskUserQuestion', 'ExitPlanMode')
  const addendum = context.systemPromptAddendum?.trim()
  args.push(
    '--append-system-prompt',
    addendum ? `${addendum}\n\n${MAIN_AGENT_SENTINEL}` : MAIN_AGENT_SENTINEL,
  )
  if (context.planMode) args.push('--permission-mode', 'plan')
  if (input.mcpPath) args.push('--mcp-config', input.mcpPath)
  if (context.addDirs.length > 0) args.push('--add-dir', ...context.addDirs)
  if (context.allowedTools && context.allowedTools.length > 0) {
    args.push('--allowedTools', ...context.allowedTools)
  }
  args.push(...input.extraArgs)
  return args
}

export function isNativeClaudeCommand(prompt: string): boolean {
  const first = prompt.trim().split(/\s+/, 1)[0]?.toLowerCase()
  return first !== undefined && NATIVE_COMMANDS.has(first)
}

export function permissionOutput(
  decision: 'allow' | 'deny',
  reason: string,
  updatedInput?: Record<string, unknown>,
): Record<string, unknown> {
  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: 'PreToolUse',
    permissionDecision: decision,
    permissionDecisionReason: reason,
  }
  if (updatedInput) hookSpecificOutput.updatedInput = updatedInput
  return { hookSpecificOutput }
}

export function shapeToolResult(
  toolName: unknown,
  response: unknown,
): { content: unknown; isError: boolean } {
  if (typeof response === 'string') return { content: response, isError: false }
  const record = asRecord(response)
  const isError = record.is_error === true || record.isError === true
  if (toolName === 'Bash') {
    const stdout = String(record.stdout ?? '')
    const stderr = String(record.stderr ?? '')
    const content = stderr ? (stdout ? `${stdout}\n${stderr}` : stderr) : stdout
    return { content, isError: isError || record.interrupted === true }
  }
  if (Array.isArray(record.content) || typeof record.content === 'string') {
    return { content: record.content, isError }
  }
  if (typeof record.text === 'string') return { content: record.text, isError }
  if (response == null) return { content: '', isError }
  return { content: JSON.stringify(response), isError }
}

function resolveCliInvocation(cli: string, args: string[]): { file: string; argv: string[] } {
  if (/\.(mjs|cjs|js)$/.test(cli)) return { file: process.execPath, argv: [cli, ...args] }
  return { file: cli, argv: args }
}

function findTranscript(session: PtySession): string | null {
  if (!session.claudeSessionId) return null
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? '', '.claude')
  const slug = session.cwd.replace(/[/.]/g, '-')
  const direct = join(configDir, 'projects', slug, `${session.claudeSessionId}.jsonl`)
  return existsSync(direct) ? direct : null
}

function stopFailureMessage(payload: HookPayload): string {
  const detail = typeof payload.error_details === 'string' ? `: ${payload.error_details}` : ''
  return `Claude Code turn failed (${payload.error ?? 'unknown'})${detail}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

// node-pty publishes spawn-helper without the executable bit; without it every
// spawn dies with `posix_spawnp failed.`. Mirrors scripts/fix-node-pty-permissions.mjs.
export function repairNodePtySpawnHelper(): void {
  if (process.platform === 'win32') return
  let root: string
  try {
    root = dirname(require.resolve('node-pty/package.json'))
  } catch {
    return
  }
  for (const helper of [
    join(root, 'build', 'Release', 'spawn-helper'),
    join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ]) {
    try {
      const mode = statSync(helper).mode
      if ((mode & 0o111) !== 0o111) chmodSync(helper, (mode & 0o7777) | 0o755)
    } catch {}
  }
}

export function defaultRelayScript(): string {
  // dist/src/jinn-pty-runtime.mjs → <repo>/scripts/jinn-pty-hook-relay.mjs
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'scripts',
    'jinn-pty-hook-relay.mjs',
  )
}

export function defaultStateDir(): string {
  return join(tmpdir(), `claude-codex-pty-${process.pid}`)
}
