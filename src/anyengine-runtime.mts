import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ptyEnv } from './anyengine-env.mjs'
import {
  type HookPayload,
  PtyHookServer,
  writePtyMcpConfig,
  writePtySettings,
} from './anyengine-hooks.mjs'
import {
  CompactionStreamGate,
  MAIN_AGENT_SENTINEL,
  type SseDataEvent,
  SsePtyProxy,
  type SseStreamInfo,
  sseEventToDeltas,
  streamIsCurrent,
} from './anyengine-proxy.mjs'
import {
  chooseApproval,
  chooseRejection,
  keystrokesToSelect,
  PtyScreen,
  parsePermissionPrompt,
  pasteAndSubmit,
} from './anyengine-screen.mjs'
import { steerComposer, waitForComposer } from './anyengine-startup.mjs'
import {
  type ActiveTurn,
  type AsyncSubagent,
  type PendingTool,
  type PtySession,
  removePtyFiles,
  type StreamTag,
  TurnCancellation,
  TurnLifecycles,
  type TurnPreparation,
} from './anyengine-turn-lifecycle.mjs'
import { captureClaudeLimit } from './limits-claude.mjs'

export type { StreamTag } from './anyengine-turn-lifecycle.mjs'

import {
  lastAssistantTextFromTranscript,
  parseTaskNotifications,
  sanitizeAssistantText,
  sumTranscriptUsage,
  type TaskNotification,
  taskNotificationsFromTranscript,
} from './anyengine-transcript.mjs'
import { modelPrompt } from './model-prompt.mjs'
import { claudeLaunchFor, claudeSpawnKey, relayDecision, trustRefusal } from './posture-claude.mjs'
import { asRecord } from './rpc-shape.mjs'
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

export interface AnyengineRuntimeOptions {
  // `claude` binary (or a .mjs/.js script run under the current node, used by
  // the tests' fake CLI).
  cli: string
  cols: number
  rows: number
  // Wall-clock cap for one turn; 0 disables. On expiry the transcript is
  // consulted before the turn is failed.
  turnTimeoutMs: number
  // How long a turn stays open waiting for background (async) Task sub-agents
  // to report back after the main agent has gone idle; on expiry the turn
  // completes with what it has. 0 disables the wait.
  asyncSubagentTimeoutMs: number
  // How long to wait for the composer after a cold spawn (trust dialog etc).
  startupTimeoutMs: number
  streamProxy: boolean
  extraArgs: string[]
  hookTimeoutSec: number
  autoApproveSafetyPrompts: boolean
  // Legacy option, ignored: credentials never come from the adapter environment.
  keepApiKey: boolean
  stateDir: string
  relayScript: string
  nodeBinary: string
}

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'max'])
const TUI_DIALOG_TOOLS = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']
const IMMEDIATE_STOP_FAILURE_ERRORS = new Set([
  'rate_limit',
  'billing_error',
  'authentication_failed',
  'max_output_tokens',
])
const STOP_FAILURE_GRACE_MS = 20_000
const PERMISSION_PROMPT_SETTLE_MS = 400
const PERMISSION_PROMPT_VERIFY_MS = 1500
const PERMISSION_PROMPT_MAX_ATTEMPTS = 3
// Claude-native slash commands run locally and never fire a Stop hook; the
// turn settles once the TUI goes quiet instead.
const NATIVE_COMMANDS = new Set(['/compact', '/clear', '/model', '/cost', '/status', '/help'])
const NATIVE_COMMAND_MIN_MS = 3000
const NATIVE_COMMAND_QUIET_MS = 1800
const NATIVE_COMMAND_MAX_MS = 90_000
// Once every background sub-agent has stopped, the CLI injects their results
// into the idle main agent as a user message within ~1.5 s; wait this long for
// that before completing the turn on the Stop already in hand.
const ASYNC_NOTIFY_GRACE_MS = 6000
const ASYNC_SUBAGENT_TOOLS = new Set(['task', 'agent'])

export class AnyengineRuntime implements ClaudeRuntime {
  private readonly options: AnyengineRuntimeOptions
  private readonly sessions = new Map<string, PtySession>()
  private readonly turns = new Map<string, ActiveTurn>()
  private readonly hooks: PtyHookServer
  private hooksStarted: Promise<number> | null = null
  private spawnSeq = 0
  private readonly lifecycle = new TurnLifecycles()
  private stopping: Promise<void> | null = null

  constructor(options: AnyengineRuntimeOptions) {
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
    const preparation = this.lifecycle.begin(context.threadId)
    try {
      try {
        await this.runTurnOnce(context, handlers, preparation)
      } catch (error) {
        preparation.check()
        const message = error instanceof Error ? error.message : String(error)
        // A stored Claude session id can stop resolving (rollout pruned, thread
        // opened from another cwd, `claude` upgraded): the CLI prints
        // "No conversation found with session ID" and exits 1 before the prompt
        // lands. Fall back to a fresh session once; SessionStart then reports
        // the new id and the server replaces the stale one.
        // The screen tail can be empty when the CLI dies within milliseconds, so
        // any early exit of a resumed spawn (before the prompt was accepted) is
        // treated the same way, once.
        const staleResume =
          /No conversation found with session ID/i.test(message) ||
          /exited \(code 1\) before the turn completed/i.test(message)
        if (context.claudeSessionId && staleResume) {
          preparation.prepare()
          debugLog('anyengine.resumeFallback', {
            threadId: context.threadId,
            staleSessionId: context.claudeSessionId,
          })
          await handlers.onEvent({
            type: 'notice',
            level: 'warning',
            message:
              'Previous Claude session could not be resumed; starting a fresh Claude session for this thread.',
          })
          preparation.check()
          await this.runTurnOnce(
            { ...context, claudeSessionId: null, forkSession: false },
            handlers,
            preparation,
          )
          return
        }
        throw error
      }
    } catch (error) {
      if (!(error instanceof TurnCancellation) || error.reason) throw error
    } finally {
      this.lifecycle.finish(context.threadId, preparation)
    }
  }

  private async runTurnOnce(
    context: RuntimeTurnContext,
    handlers: RuntimeHandlers,
    preparation: TurnPreparation,
  ): Promise<void> {
    preparation.check()
    await this.ensureHooks()
    preparation.check()

    let session = this.sessions.get(context.threadId)
    if (session && (session.exited || session.spawnKey !== claudeSpawnKey(context))) {
      // `--model`, `--permission-mode` and `--disallowedTools` bind at spawn; a
      // change means a cold respawn that resumes the same Claude session.
      this.releaseSession(session, 'respawn')
      session = undefined
    }
    if (!session) {
      session = await this.spawn(context, preparation)
      preparation.check()
      const notice = claudeLaunchFor(context).notice
      if (notice) await handlers.onEvent({ type: 'notice', level: 'warning', message: notice })
    }
    preparation.check()
    const active = session

    let resolveTurn!: () => void
    let rejectTurn!: (error: Error) => void
    const done = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve
      rejectTurn = reject
    })
    // The CLI can die (bad --resume id, auth error) before this method reaches
    // `await done`; mark the rejection handled so an early failure is reported
    // once, through the await below, instead of as an unhandled rejection.
    done.catch(() => {})
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
      promptAcceptedAt: null,
      pendingTools: new Map(),
      lastToolUseId: null,
      cancelSubmit: null,
      stopFailure: null,
      graceTimer: null,
      timeoutTimer: null,
      nativeTimer: null,
      approvingPrompt: false,
      asyncAgents: new Map(),
      heldStop: null,
      asyncTimer: null,
      notifyTimer: null,
      continuation: false,
    }
    this.turns.set(context.threadId, turn)
    preparation.commit()

    try {
      await this.awaitReady(active, turn)
      preparation.check()
      if (turn.settled) return await done
      if (active.claudeSessionId) {
        await handlers.onEvent({ type: 'session', claudeSessionId: active.claudeSessionId })
        preparation.check()
      }
      const prompt = await this.composePrompt(context, handlers)
      preparation.check()
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
                debugLog('anyengine.submit.retry', { threadId: context.threadId, attempt }),
              onUnconfirmed: () =>
                void handlers.onEvent({
                  type: 'notice',
                  level: 'warning',
                  message:
                    'anyengine: Claude Code never acknowledged the prompt; it may be stranded in the TUI composer.',
                }),
            },
        {
          beforeWrite: async (phase) => {
            preparation.check()
            const interrupted = await this.awaitReady(
              active,
              turn,
              phase === 'submit' ? prompt : undefined,
            )
            preparation.check()
            if (phase === 'submit' && interrupted) {
              throw new Error('anyengine: a dialog interrupted prompt input; retry the turn.')
            }
          },
          onError: (error) => {
            this.releaseSession(active, 'unsafe input screen')
            this.settle(turn, error)
          },
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
    if (!session || session.exited) throw new Error('anyengine runtime: no live PTY for thread')
    try {
      await steerComposer(session.screen, session.proc, prompt, session.cwd)
    } catch (error) {
      this.releaseSession(session, 'unsafe steer screen')
      const turn = this.turns.get(threadId)
      if (turn) this.settle(turn, error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  async interrupt(threadId: string): Promise<void> {
    this.lifecycle.interrupt(threadId)
    const session = this.sessions.get(threadId)
    const turn = this.turns.get(threadId)
    if (session && !session.exited) {
      try {
        session.proc.write('\x1b')
      } catch {}
    }
    if (turn) this.settle(turn)
  }

  async release(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId)
    if (session && !this.turns.has(threadId)) this.releaseSession(session, 'release')
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    const preparing = this.lifecycle.stop()
    for (const turn of [...this.turns.values()]) {
      this.settle(turn, new Error('anyengine runtime stopped'))
    }
    for (const session of [...this.sessions.values()]) this.releaseSession(session, 'stop')
    this.hooks.stop()
    this.stopping = preparing.then(() => {
      // A start already in flight can finish after the first stop sweep.
      this.hooks.stop()
      this.hooksStarted = null
      try {
        rmSync(this.options.stateDir, { recursive: true, force: true })
      } catch {}
    })
    return this.stopping
  }

  // -------------------------------------------------------------------------
  // Spawn / lifecycle

  private ensureHooks(): Promise<number> {
    if (!this.hooksStarted) this.hooksStarted = this.hooks.start()
    return this.hooksStarted
  }

  private async spawn(
    context: RuntimeTurnContext,
    preparation: TurnPreparation,
  ): Promise<PtySession> {
    preparation.check()
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
    let mcpPath: string | null = null
    preparation.own(() => removePtyFiles([settingsPath, mcpPath]))
    mcpPath = context.mcpServers
      ? writePtyMcpConfig(this.options.stateDir, fileStem, context.mcpServers)
      : null

    let proxy: SsePtyProxy | null = null
    if (this.options.streamProxy) {
      const candidate = new SsePtyProxy(
        context.threadId,
        (event, stream) => this.onSseEvent(context.threadId, event, stream),
        { tagStream: () => this.streamTag(context.threadId) },
      )
      proxy = candidate
      preparation.own(() => candidate.stop())
      try {
        await candidate.start()
        proxy = candidate
      } catch (err) {
        candidate.stop()
        proxy = null
        debugLog('anyengine.proxy.startFailed', {
          threadId: context.threadId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    preparation.check()

    const spawnKey = claudeSpawnKey(context) // before the flags: a change between respawns
    const args = buildInteractiveArgs({
      context,
      settingsPath,
      mcpPath,
      extraArgs: this.options.extraArgs,
    })
    const env = ptyEnv({
      hookUrl: this.hooks.url,
      hookToken: this.hooks.token,
      proxyPort: proxy?.port ?? null,
      shell: claudeLaunchFor(context).shell,
      keepApiKey: this.options.keepApiKey,
    })
    const { file, argv } = resolveCliInvocation(this.options.cli, args)
    debugLog('anyengine.spawn', {
      threadId: context.threadId,
      cwd: context.cwd,
      resume: context.claudeSessionId,
      model: context.model,
      proxyPort: proxy?.port ?? 0,
    })
    preparation.check()
    const proc = spawn(file, argv, {
      name: 'xterm-256color',
      cols: this.options.cols,
      rows: this.options.rows,
      cwd: context.cwd,
      env,
    })
    const session: PtySession = {
      rawTail: '',
      threadId: context.threadId,
      proc,
      screen: new PtyScreen(this.options.cols, this.options.rows),
      proxy,
      cwd: context.cwd,
      spawnKey,
      claudeSessionId: context.claudeSessionId ?? null,
      settingsPath,
      mcpPath,
      exited: false,
      disposed: false,
      sessionStarted: false,
      lastOutputAt: Date.now(),
    }
    preparation.own(() => this.releaseSession(session, 'cancelled preparation'))
    proc.onData((data) => {
      session.rawTail = (session.rawTail + data).slice(-4000)
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
          let tail = viewport
            .filter((line) => line.trim())
            .slice(-6)
            .join('\n')
          if (!tail) {
            tail = session.rawTail
              .replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007|\r/g, '')
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
              .slice(-6)
              .join('\n')
          }
          debugLog('anyengine.exit', {
            threadId: session.threadId,
            exitCode: event.exitCode,
            tail,
          })
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
    preparation.check()
    this.sessions.set(context.threadId, session)
    return session
  }

  private releaseSession(session: PtySession, reason: string): void {
    if (session.disposed) return
    if (this.sessions.get(session.threadId) === session) this.sessions.delete(session.threadId)
    debugLog('anyengine.release', { threadId: session.threadId, reason, pid: session.proc.pid })
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
    removePtyFiles([session.settingsPath, session.mcpPath])
  }

  private async awaitReady(
    session: PtySession,
    turn: ActiveTurn,
    expectedPrompt?: string,
  ): Promise<boolean> {
    try {
      return await waitForComposer(session.screen, session.proc, {
        timeoutMs: this.options.startupTimeoutMs,
        cwd: session.cwd,
        ...(expectedPrompt === undefined ? {} : { expectedPrompt }),
        stopped: () => turn.settled || session.exited,
        refusal: (label) => trustRefusal(turn.context, label),
        onAnswer: (label, attempt) =>
          debugLog('anyengine.startupPrompt', {
            threadId: session.threadId,
            label,
            attempt,
          }),
      })
    } catch (error) {
      this.releaseSession(session, 'startup input refused')
      throw error
    }
  }

  private async composePrompt(
    context: RuntimeTurnContext,
    handlers: RuntimeHandlers,
  ): Promise<string> {
    let prompt = context.modelAuthored ? modelPrompt(context.prompt) : context.prompt
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
        message: 'anyengine: image attachments could not be materialised; sending text only.',
      })
      return prompt
    }
    // Backticks keep the TUI from auto-attaching the file during the paste
    // (an async state that swallows the submit CR); Claude reads it instead.
    prompt += `\n\nAttached files:\n${paths.map((p) => `- \`${p}\``).join('\n')}`
    return context.modelAuthored ? modelPrompt(prompt) : prompt
  }

  // -------------------------------------------------------------------------
  // Hooks
  private async onHook(threadId: string, payload: HookPayload): Promise<unknown> {
    const session = this.sessions.get(threadId)
    const turn = this.turns.get(threadId)
    const event = payload.hook_event_name
    debugLog('anyengine.hook', { threadId, event, tool: payload.tool_name ?? null })
    if (event === 'SessionStart') {
      if (session) {
        session.sessionStarted = true
        if (typeof payload.session_id === 'string' && payload.session_id) {
          session.claudeSessionId = payload.session_id
          debugLog('anyengine.session', { threadId, sessionId: payload.session_id })
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
        turn.promptAcceptedAt = Date.now()
        this.clearNotifyGrace(turn)
        // Whatever the agent says next answers a new (injected) message.
        if (turn.streamedChars > 0) turn.continuation = true
        {
          const notifications = parseTaskNotifications(String(payload.prompt ?? ''))
          if (notifications.length > 0 || turn.asyncAgents.size > 0) {
            debugLog('anyengine.promptAccepted', {
              threadId,
              notifications: notifications.length,
              held: turn.heldStop !== null,
            })
          }
          await this.onTaskNotifications(turn, notifications)
        }
        return undefined
      case 'PreToolUse':
        turn.promptSubmitted = true
        return await this.onPreToolUse(turn, payload)
      case 'PostToolUse':
        turn.promptSubmitted = true
        await this.onPostToolUse(turn, payload)
        return undefined
      case 'SubagentStop':
        await this.onSubagentStop(turn, payload)
        return undefined
      case 'Stop':
        turn.promptSubmitted = true
        this.clearGrace(turn)
        turn.stopFailure = null
        if (await this.holdForAsyncSubagents(turn, payload)) return undefined
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

    const relay = relayDecision(turn.context, toolName, input)
    if (relay.verdict !== 'ask') {
      pending.decision = relay.verdict
      return permissionOutput(relay.verdict, relay.reason)
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

  private async onPostToolUse(turn: ActiveTurn, payload: HookPayload): Promise<void> {
    const toolUseId =
      typeof payload.tool_use_id === 'string' && payload.tool_use_id
        ? payload.tool_use_id
        : (turn.lastToolUseId ?? `pty-${randomUUID()}`)
    // A call completes once: a report for one no longer pending is dropped.
    if (!turn.pendingTools.delete(toolUseId)) return
    const launch = asyncLaunch(payload.tool_name, payload.tool_response)
    if (launch) {
      // Claude Code 2.1.x runs Task/Agent in the background: the tool returns `async_launched`
      // at once and the result arrives later. Leave the App's wait item open (the child shows
      // as running) and keep the turn alive until the sub-agent reports back.
      turn.asyncAgents.set(launch.agentId, {
        agentId: launch.agentId,
        toolUseId,
        description: launch.description,
        finished: false,
        delivered: false,
      })
      this.armAsyncTimeout(turn)
      debugLog('anyengine.subagent.launched', {
        threadId: turn.context.threadId,
        agentId: launch.agentId,
        toolUseId,
      })
      return
    }
    const { content, isError } = shapeToolResult(payload.tool_name, payload.tool_response)
    await turn.handlers.onEvent({ type: 'tool_result', toolUseId, content, isError })
  }

  // -------------------------------------------------------------------------
  // Background (async) Task sub-agents

  private async onSubagentStop(turn: ActiveTurn, payload: HookPayload): Promise<void> {
    const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : ''
    const agent = agentId ? turn.asyncAgents.get(agentId) : undefined
    // Synchronous sub-agents and the CLI's own helper agents (title, follow-up
    // suggestions) stop through the same hook; only launched ones matter.
    if (!agent || agent.finished) return
    let text = sanitizeAssistantText(String(payload.last_assistant_message ?? ''))
    if (!text && typeof payload.agent_transcript_path === 'string') {
      text = sanitizeAssistantText(
        lastAssistantTextFromTranscript(payload.agent_transcript_path) ?? '',
      )
    }
    await this.finishAsyncSubagent(turn, agent, text, false)
  }

  private async finishAsyncSubagent(
    turn: ActiveTurn,
    agent: AsyncSubagent,
    text: string,
    isError: boolean,
  ): Promise<void> {
    if (agent.finished) return
    agent.finished = true
    debugLog('anyengine.subagent.finished', {
      threadId: turn.context.threadId,
      agentId: agent.agentId,
      chars: text.length,
      isError,
    })
    // The trailer mirrors the Agent SDK's result shape so the server adopts
    // the CLI's agent id as the child thread's handle.
    const body = text || `Sub-agent "${agent.description}" finished without a final message.`
    await turn.handlers.onEvent({
      type: 'tool_result',
      toolUseId: agent.toolUseId,
      content: `${body}\n\nagentId: ${agent.agentId}`,
      isError,
    })
    if (turn.heldStop && this.asyncAgentsOutstanding(turn).length === 0) {
      this.armNotifyGrace(turn)
    }
  }

  // Results the main agent has consumed. Idle-time delivery arrives as an
  // injected prompt (UserPromptSubmit); mid-turn delivery only shows in the
  // transcript. A notification for an agent whose SubagentStop never reached
  // us closes it here.
  private async onTaskNotifications(
    turn: ActiveTurn,
    notifications: TaskNotification[],
  ): Promise<void> {
    for (const notification of notifications) {
      const agent = turn.asyncAgents.get(notification.taskId)
      if (!agent) continue
      if (!agent.finished) {
        await this.finishAsyncSubagent(
          turn,
          agent,
          sanitizeAssistantText(notification.result),
          notification.status !== '' && notification.status !== 'completed',
        )
      }
      agent.delivered = true
    }
  }

  private asyncAgentsOutstanding(turn: ActiveTurn): AsyncSubagent[] {
    return [...turn.asyncAgents.values()].filter((agent) => !agent.finished)
  }

  // A Task/Agent tool_use has been emitted whose tool_result has not.
  private subagentResultPending(turn: ActiveTurn): boolean {
    if (this.asyncAgentsOutstanding(turn).length > 0) return true
    for (const tool of turn.pendingTools.values()) {
      if (ASYNC_SUBAGENT_TOOLS.has(tool.toolName.toLowerCase())) return true
    }
    return false
  }

  // A Stop while launched sub-agents are still running, or have finished but
  // the main agent has not yet answered their results, ends nothing: the CLI
  // will inject the results and the agent will speak again.
  private async holdForAsyncSubagents(turn: ActiveTurn, payload: HookPayload): Promise<boolean> {
    if (turn.asyncAgents.size === 0) return false
    const outstanding = this.asyncAgentsOutstanding(turn)
    if (outstanding.length === 0) {
      const transcriptPath =
        typeof payload.transcript_path === 'string' ? payload.transcript_path : null
      if (transcriptPath) {
        await this.onTaskNotifications(
          turn,
          taskNotificationsFromTranscript(transcriptPath, turn.startedAt - 1000),
        )
      }
      const undelivered = [...turn.asyncAgents.values()].filter((agent) => !agent.delivered)
      if (undelivered.length === 0) return false
    }
    turn.heldStop = payload
    // Nothing the CLI requests from here until the next accepted prompt is
    // this turn's text (the follow-up-suggestion call, most notably).
    turn.promptAcceptedAt = null
    turn.continuation = true
    if (outstanding.length === 0) this.armNotifyGrace(turn)
    debugLog('anyengine.stop.held', {
      threadId: turn.context.threadId,
      outstanding: outstanding.length,
      launched: turn.asyncAgents.size,
    })
    return true
  }

  private armAsyncTimeout(turn: ActiveTurn): void {
    if (turn.asyncTimer || this.options.asyncSubagentTimeoutMs <= 0) return
    turn.asyncTimer = setTimeout(() => {
      turn.asyncTimer = null
      void this.expireAsyncSubagents(turn)
    }, this.options.asyncSubagentTimeoutMs)
    turn.asyncTimer.unref()
  }

  private async expireAsyncSubagents(turn: ActiveTurn): Promise<void> {
    if (turn.settled) return
    const outstanding = this.asyncAgentsOutstanding(turn)
    debugLog('anyengine.subagent.timeout', {
      threadId: turn.context.threadId,
      outstanding: outstanding.length,
    })
    for (const agent of outstanding) {
      await this.finishAsyncSubagent(
        turn,
        agent,
        `Sub-agent "${agent.description}" did not report back within ${this.options.asyncSubagentTimeoutMs}ms.`,
        true,
      )
    }
    // Complete only when the main agent is idle; while it is still working
    // the next Stop completes the turn as usual.
    if (turn.heldStop) await this.completeHeldStop(turn)
  }

  private armNotifyGrace(turn: ActiveTurn): void {
    this.clearNotifyGrace(turn)
    turn.notifyTimer = setTimeout(() => {
      turn.notifyTimer = null
      void this.completeHeldStop(turn)
    }, ASYNC_NOTIFY_GRACE_MS)
    turn.notifyTimer.unref()
  }

  private clearNotifyGrace(turn: ActiveTurn): void {
    if (turn.notifyTimer) clearTimeout(turn.notifyTimer)
    turn.notifyTimer = null
  }

  private async completeHeldStop(turn: ActiveTurn): Promise<void> {
    if (turn.settled || !turn.heldStop) return
    const payload = turn.heldStop
    turn.heldStop = null
    await this.completeTurn(turn, payload)
  }

  // Claude Code's hardcoded safety prompts ignore hook decisions; answer the
  // TUI consistently with the decision the App already made for the pending
  // tool (or ask it now when we never got to decide).
  private async answerPermissionPrompt(turn: ActiveTurn, attempt = 1): Promise<void> {
    if (!this.options.autoApproveSafetyPrompts) {
      await turn.handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message:
          'anyengine: Claude Code is blocked on a safety prompt; auto-answering is disabled.',
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
          message: `anyengine: unrecognised safety prompt (${prompt.reason ?? 'no reason'}); leaving it unanswered.`,
        })
        return
      }
      const target = allow ? chooseApproval(prompt) : chooseRejection(prompt)
      if (!target) return
      debugLog('anyengine.safetyPrompt', {
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
      debugLog('anyengine.safetyPrompt.error', {
        threadId: turn.context.threadId,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (attempt === 1) turn.approvingPrompt = false
    }
  }

  // -------------------------------------------------------------------------
  // Streaming

  private streamTag(threadId: string): StreamTag | null {
    const turn = this.turns.get(threadId)
    if (!turn || turn.settled) return null
    return { turnId: turn.context.turnId, acceptedAt: turn.promptAcceptedAt }
  }

  private onSseEvent(threadId: string, event: SseDataEvent, stream: SseStreamInfo): void {
    const turn = this.turns.get(threadId)
    if (
      !turn ||
      turn.settled ||
      !streamIsCurrent(stream, turn.context.turnId, turn.promptAcceptedAt)
    )
      return
    captureClaudeLimit(event)
    if (event.type === 'message_start') turn.gate.reset()
    const deltas = turn.gate.accept(sseEventToDeltas(event))
    if (event.type === 'message_stop') deltas.push(...turn.gate.end())
    for (const delta of deltas) {
      if (delta.type === 'text') {
        let content = delta.content
        // The server hides main-agent text while a spawned sub-agent has no
        // result yet, so only text streamed outside that window counts as
        // shown (and deserves a paragraph break after a held Stop).
        const shown = !this.subagentResultPending(turn)
        if (turn.continuation) {
          turn.continuation = false
          if (shown && turn.streamedChars > 0) content = `\n\n${content}`
        }
        if (shown) turn.streamedChars += content.length
        void turn.handlers.onEvent({ type: 'text_delta', delta: content })
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
      debugLog('anyengine.turn.completed', {
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
    debugLog('anyengine.turn.failed', { threadId: turn.context.threadId, message })
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
      void this.failTurn(turn, `anyengine turn timed out after ${this.options.turnTimeoutMs}ms`)
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
    this.clearNotifyGrace(turn)
    if (turn.asyncTimer) clearTimeout(turn.asyncTimer)
    turn.asyncTimer = null
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
  if (context.modelAuthored) args.push('--disable-slash-commands')
  if (context.model) args.push('--model', context.model)
  if (context.effort && EFFORT_LEVELS.has(context.effort)) args.push('--effort', context.effort)
  args.push('--settings', input.settingsPath)
  // AskUserQuestion / ExitPlanMode render TUI dialogs no hook can answer, so a
  // plan mode EnterPlanMode starts could not be left either; Bash goes unless
  // nothing is bounded (shellMode, src/posture-claude.mts).
  const launch = claudeLaunchFor(context)
  args.push('--disallowedTools', ...TUI_DIALOG_TOOLS, ...launch.disallowedTools)
  const addendum = context.systemPromptAddendum?.trim()
  args.push(
    '--append-system-prompt',
    addendum ? `${addendum}\n\n${MAIN_AGENT_SENTINEL}` : MAIN_AGENT_SENTINEL,
  )
  if (launch.permissionMode) args.push('--permission-mode', launch.permissionMode)
  if (launch.settingSources) args.push('--setting-sources', 'user', '--strict-mcp-config')
  if (input.mcpPath) args.push('--mcp-config', input.mcpPath)
  if (context.addDirs.length > 0) args.push('--add-dir', ...context.addDirs)
  if (context.allowedTools?.length) args.push('--allowedTools', ...context.allowedTools)
  args.push(...input.extraArgs)
  return args
}

export { streamIsCurrent } from './anyengine-proxy.mjs'

export function asyncLaunch(
  toolName: unknown,
  response: unknown,
): { agentId: string; description: string } | null {
  if (typeof toolName !== 'string' || !ASYNC_SUBAGENT_TOOLS.has(toolName.toLowerCase())) {
    return null
  }
  const record = asRecord(response)
  if (record.isAsync !== true && record.status !== 'async_launched') return null
  const agentId = typeof record.agentId === 'string' ? record.agentId : ''
  if (!agentId) return null
  return { agentId, description: String(record.description ?? '') }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref())
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
  // dist/src/anyengine-runtime.mjs → <repo>/scripts/anyengine-hook-relay.mjs
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'scripts',
    'anyengine-hook-relay.mjs',
  )
}
