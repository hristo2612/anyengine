// Grok backend: drives xAI's `grok` CLI through its agent protocol
// (`grok agent stdio` = Agent Client Protocol JSON-RPC over stdio) and projects
// the stream onto our RuntimeEvent surface. Selected per thread whenever the
// App picks a `grok-*` model (see server.mts turn/start + grok-models.mts).
//
// One warm `grok agent` process per thread, kept across turns so the grok
// session stays resident (MCP init happens once) and `turn/interrupt` can be
// delivered as `session/cancel`. The grok session id is persisted through the
// thread's claudeSessionId slot as `grok:<uuid>`; a thread whose process is
// gone (adapter restart, idle reap, model change) comes back with
// `session/load`, which grok supports (`agentCapabilities.loadSession`).
//
// Approvals: grok asks the client through `session/request_permission` for
// every tool its own permission rules don't pre-allow. Read-only tools are
// answered here; everything else is forwarded to the App as a native
// command / file-change approval, unless the thread runs with Full access
// (`approvalPolicy=never` / `sandbox=danger-full-access`), in which case the
// process is spawned with `--always-approve` and grok never asks.
//
// Technique ported from Jinn's grok engines (headless stream + ACP transcript
// shapes); self-contained here, no runtime dependency on Jinn.

import { type ChildProcess, spawn } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import {
  acpMcpServers,
  asRecord,
  buildGrokAgentArgs,
  type GrokAgentSpec,
  type GrokPermissionOption,
  grokAgentSpec,
  grokPermissionOutcome,
  grokPromptText,
  grokSessionIdFor,
  grokSessionIdFrom,
  grokToolCallInfo,
  grokUpdateToEvents,
  grokUsageFromPromptResult,
  stringOr,
} from './grok-acp.mjs'
import { resolveGrokBinary } from './grok-models.mjs'
import type { ClaudeRuntime, RuntimeHandlers, RuntimeTurnContext } from './types.mjs'
import { debugLog } from './util.mjs'

export interface GrokRuntimeOptions {
  binary: string | null
  extraArgs: string[]
  turnTimeoutMs: number
  startupTimeoutMs: number
  idleExitMs: number
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

interface ActiveTurn {
  context: RuntimeTurnContext
  handlers: RuntimeHandlers
  seenToolNames: Map<string, string>
  // Events are delivered in wire order; onEvent may be async so they chain.
  chain: Promise<void>
  text: string
  cancelled: boolean
}

interface GrokProcess {
  threadId: string
  spec: GrokAgentSpec
  proc: ChildProcess
  rl: Interface
  nextId: number
  pending: Map<number, PendingRequest>
  sessionId: string | null
  // session/load replays the whole history as session/update notifications
  // before its response; those must not be re-rendered as a new turn.
  loading: boolean
  activeTurn: ActiveTurn | null
  idleTimer: NodeJS.Timeout | null
  exited: boolean
  stderrTail: string
}

const ACP_PROTOCOL_VERSION = 1

export class GrokRuntime implements ClaudeRuntime {
  private processes = new Map<string, GrokProcess>()
  private readonly options: GrokRuntimeOptions

  constructor(options: GrokRuntimeOptions) {
    this.options = options
  }

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    const binary = this.options.binary ?? resolveGrokBinary()
    if (!binary) {
      const message =
        'grok CLI not found. Install Grok Build or set CLAUDE_CODEX_GROK_BIN=/abs/path/to/grok.'
      await handlers.onEvent({ type: 'error', message })
      await handlers.onEvent({ type: 'completed', success: false, result: message })
      throw new Error(message)
    }

    const spec = grokAgentSpec(context)
    const wantedSessionId = context.forkSession ? null : grokSessionIdFrom(context.claudeSessionId)
    let gp: GrokProcess
    let freshSession = false
    try {
      ;({ process: gp, freshSession } = await this.attachSession(
        binary,
        context,
        spec,
        wantedSessionId,
        handlers,
      ))
    } catch (error) {
      // Spawn / initialize / session setup failed: settle the turn explicitly
      // so the App sees the reason instead of a hung turn.
      const message = errorMessage(error)
      debugLog('grok.session.failed', { threadId: context.threadId, message })
      await handlers.onEvent({ type: 'error', message })
      await handlers.onEvent({ type: 'completed', success: false, result: message })
      throw error instanceof Error ? error : new Error(message)
    }
    const sessionId = gp.sessionId
    if (!sessionId) throw new Error('grok did not return a session id')
    await handlers.onEvent({ type: 'session', claudeSessionId: grokSessionIdFor(sessionId) })

    if (context.imageInputs.length > 0) {
      await handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: 'grok runtime does not accept image attachments; sending the text prompt only.',
      })
    }

    const turn: ActiveTurn = {
      context,
      handlers,
      seenToolNames: new Map(),
      chain: Promise.resolve(),
      text: '',
      cancelled: false,
    }
    gp.activeTurn = turn
    try {
      const result = await this.request(
        gp,
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: grokPromptText(context, freshSession) }],
        },
        this.options.turnTimeoutMs,
      )
      await turn.chain
      const { usage, metrics } = grokUsageFromPromptResult(result)
      if (usage) await handlers.onEvent({ type: 'usage', usage })
      if (metrics) {
        await handlers.onEvent({
          type: 'metrics',
          durationMs: null,
          apiDurationMs: metrics.apiDurationMs,
          numTurns: metrics.numTurns,
          costUsd: null,
        })
      }
      const stopReason = stringOr(result.stopReason) ?? 'end_turn'
      debugLog('grok.turn.completed', {
        threadId: context.threadId,
        turnId: context.turnId,
        stopReason,
        cancelled: turn.cancelled,
      })
      await handlers.onEvent({
        type: 'completed',
        success: true,
        result: turn.text || null,
        claudeSessionId: grokSessionIdFor(sessionId),
      })
    } catch (error) {
      await turn.chain.catch(() => {})
      const message = errorMessage(error)
      debugLog('grok.turn.failed', { threadId: context.threadId, turnId: context.turnId, message })
      try {
        await handlers.onEvent({ type: 'error', message })
        await handlers.onEvent({
          type: 'completed',
          success: false,
          result: message,
          claudeSessionId: grokSessionIdFor(sessionId),
        })
      } catch {}
      throw error instanceof Error ? error : new Error(message)
    } finally {
      if (gp.activeTurn === turn) gp.activeTurn = null
      this.armIdle(gp)
    }
  }

  async steer(threadId: string, prompt: string): Promise<void> {
    // grok's agent protocol has no mid-turn injection; the server already
    // records the steer text on the turn, so this is a logged no-op.
    debugLog('grok.steer.unsupported', { threadId, promptLen: prompt.length })
  }

  async interrupt(threadId: string): Promise<void> {
    const gp = this.processes.get(threadId)
    if (!gp || !gp.activeTurn || !gp.sessionId) return
    gp.activeTurn.cancelled = true
    this.notify(gp, 'session/cancel', { sessionId: gp.sessionId })
    // grok answers the pending prompt with stopReason=cancelled; if it does
    // not, tear the process down so the turn settles.
    const turn = gp.activeTurn
    setTimeout(() => {
      if (gp.activeTurn === turn && !gp.exited) {
        debugLog('grok.interrupt.forceKill', { threadId })
        this.dispose(gp)
      }
    }, 10_000).unref()
  }

  async stop(): Promise<void> {
    for (const gp of [...this.processes.values()]) this.dispose(gp)
    this.processes.clear()
  }

  // ── process lifecycle ──

  // Warm process + grok session for this thread: reuse, respawn on spec
  // change, `session/load` a persisted id, or `session/new`.
  private async attachSession(
    binary: string,
    context: RuntimeTurnContext,
    spec: GrokAgentSpec,
    wantedSessionId: string | null,
    handlers: RuntimeHandlers,
  ): Promise<{ process: GrokProcess; freshSession: boolean }> {
    let gp = this.processes.get(context.threadId)
    if (gp && (gp.exited || !sameSpec(gp.spec, spec))) {
      debugLog('grok.process.replace', {
        threadId: context.threadId,
        exited: gp.exited,
        oldSpec: gp.spec,
        newSpec: spec,
      })
      this.dispose(gp)
      gp = undefined
    }
    if (!gp) gp = await this.spawnProcess(binary, context, spec)
    this.clearIdle(gp)

    let freshSession = false
    if (!wantedSessionId) {
      if (!gp.sessionId || context.forkSession) {
        await this.newSession(gp, context)
        freshSession = true
      }
    } else if (gp.sessionId !== wantedSessionId) {
      try {
        await this.loadSession(gp, wantedSessionId, context)
      } catch (error) {
        await handlers.onEvent({
          type: 'notice',
          level: 'warning',
          message: `grok could not resume session ${wantedSessionId} (${errorMessage(error)}); starting a new one.`,
        })
        await this.newSession(gp, context)
        freshSession = true
      }
    }
    return { process: gp, freshSession }
  }

  private async spawnProcess(
    binary: string,
    context: RuntimeTurnContext,
    spec: GrokAgentSpec,
  ): Promise<GrokProcess> {
    const args = buildGrokAgentArgs(spec, this.options.extraArgs)
    debugLog('grok.spawn', { binary, args, threadId: context.threadId, cwd: context.cwd })
    const proc = spawn(binary, args, {
      cwd: context.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // grok's OpenTelemetry exporter can cancel a turn mid-run when its
      // traces endpoint misbehaves (observed by Jinn); this env only affects
      // the child we spawn, never the operator's own grok shell.
      env: { ...process.env, OTEL_SDK_DISABLED: process.env.OTEL_SDK_DISABLED ?? 'true' },
    })
    const gp: GrokProcess = {
      threadId: context.threadId,
      spec,
      proc,
      rl: createInterface({ input: proc.stdout ?? undefined }),
      nextId: 1,
      pending: new Map(),
      sessionId: null,
      loading: false,
      activeTurn: null,
      idleTimer: null,
      exited: false,
      stderrTail: '',
    }
    this.processes.set(context.threadId, gp)

    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      gp.stderrTail = (gp.stderrTail + chunk).slice(-4000)
      debugLog('grok.stderr', { threadId: gp.threadId, chunk: chunk.slice(0, 400) })
    })
    gp.rl.on('line', (line) => this.onLine(gp, line))
    proc.on('error', (error) => this.onExit(gp, null, null, error))
    proc.on('exit', (code, signal) => this.onExit(gp, code, signal, null))

    await this.request(
      gp,
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'claude-codex-adapter', version: '0.1.0' },
      },
      this.options.startupTimeoutMs,
    )
    return gp
  }

  private async newSession(gp: GrokProcess, context: RuntimeTurnContext): Promise<void> {
    const cwd = context.cwd
    const result = await this.request(
      gp,
      'session/new',
      { cwd, mcpServers: acpMcpServers(context.mcpServers) },
      this.options.startupTimeoutMs,
    )
    const sessionId = stringOr(result.sessionId)
    if (!sessionId) throw new Error('grok session/new returned no sessionId')
    gp.sessionId = sessionId
    debugLog('grok.session.new', { threadId: gp.threadId, sessionId, cwd })
  }

  private async loadSession(
    gp: GrokProcess,
    sessionId: string,
    context: RuntimeTurnContext,
  ): Promise<void> {
    const cwd = context.cwd
    gp.loading = true
    try {
      await this.request(
        gp,
        'session/load',
        { sessionId, cwd, mcpServers: acpMcpServers(context.mcpServers) },
        this.options.startupTimeoutMs,
      )
    } finally {
      gp.loading = false
    }
    gp.sessionId = sessionId
    debugLog('grok.session.load', { threadId: gp.threadId, sessionId, cwd })
  }

  private dispose(gp: GrokProcess): void {
    this.clearIdle(gp)
    if (this.processes.get(gp.threadId) === gp) this.processes.delete(gp.threadId)
    if (gp.exited) return
    try {
      gp.proc.kill('SIGTERM')
    } catch {}
    const proc = gp.proc
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {}
      }
    }, 2000).unref()
  }

  private armIdle(gp: GrokProcess): void {
    this.clearIdle(gp)
    if (this.options.idleExitMs <= 0 || gp.exited) return
    gp.idleTimer = setTimeout(() => {
      if (gp.activeTurn) return
      debugLog('grok.process.idleExit', { threadId: gp.threadId, sessionId: gp.sessionId })
      this.dispose(gp)
    }, this.options.idleExitMs)
    gp.idleTimer.unref()
  }

  private clearIdle(gp: GrokProcess): void {
    if (gp.idleTimer) clearTimeout(gp.idleTimer)
    gp.idleTimer = null
  }

  private onExit(
    gp: GrokProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    error: Error | null,
  ): void {
    if (gp.exited) return
    gp.exited = true
    debugLog('grok.exit', { threadId: gp.threadId, code, signal, error: error?.message ?? null })
    this.clearIdle(gp)
    if (this.processes.get(gp.threadId) === gp) this.processes.delete(gp.threadId)
    const detail = gp.stderrTail.trim().split('\n').slice(-3).join(' ').slice(0, 400)
    const reason = error
      ? `failed to spawn grok: ${error.message}`
      : `grok exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`
    for (const pending of gp.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    gp.pending.clear()
  }

  // ── wire ──

  private request(
    gp: GrokProcess,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (gp.exited) return Promise.reject(new Error('grok process is not running'))
    const id = gp.nextId++
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              gp.pending.delete(id)
              reject(new Error(`grok ${method} timed out after ${timeoutMs}ms`))
              this.dispose(gp)
            }, timeoutMs)
          : null
      timer?.unref()
      gp.pending.set(id, { resolve, reject, timer })
      this.write(gp, { jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(gp: GrokProcess, method: string, params: Record<string, unknown>): void {
    this.write(gp, { jsonrpc: '2.0', method, params })
  }

  private write(gp: GrokProcess, message: Record<string, unknown>): void {
    if (gp.exited) return
    try {
      gp.proc.stdin?.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      debugLog('grok.write.failed', { threadId: gp.threadId, error: errorMessage(error) })
    }
  }

  private onLine(gp: GrokProcess, line: string): void {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return
    let message: Record<string, unknown>
    try {
      message = asRecord(JSON.parse(trimmed))
    } catch {
      debugLog('grok.parseError', { threadId: gp.threadId, line: trimmed.slice(0, 200) })
      return
    }
    const method = stringOr(message.method)
    const hasId = message.id !== undefined && message.id !== null
    if (!method && hasId) {
      const id = Number(message.id)
      const pending = gp.pending.get(id)
      if (!pending) return
      gp.pending.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      const error = asRecord(message.error)
      if (Object.keys(error).length > 0) {
        pending.reject(new Error(stringOr(error.message) ?? `grok error ${String(error.code)}`))
      } else {
        pending.resolve(asRecord(message.result))
      }
      return
    }
    if (!method) return
    if (hasId) {
      void this.onRequest(gp, message.id as string | number, method, asRecord(message.params))
      return
    }
    this.onNotification(gp, method, asRecord(message.params))
  }

  private onNotification(gp: GrokProcess, method: string, params: Record<string, unknown>): void {
    if (method !== 'session/update') return
    if (gp.loading) return
    const turn = gp.activeTurn
    if (!turn) return
    const sessionId = stringOr(params.sessionId)
    if (sessionId && gp.sessionId && sessionId !== gp.sessionId) return
    const update = asRecord(params.update)
    const events = grokUpdateToEvents(update, turn.seenToolNames)
    for (const event of events) {
      if (event.type === 'text_delta') turn.text += event.delta
      turn.chain = turn.chain.then(() => turn.handlers.onEvent(event))
    }
  }

  private async onRequest(
    gp: GrokProcess,
    id: string | number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (method !== 'session/request_permission') {
      debugLog('grok.request.unsupported', { threadId: gp.threadId, method })
      this.write(gp, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `${method} is not supported by claude-codex-adapter` },
      })
      return
    }
    const toolCall = asRecord(params.toolCall)
    const info = grokToolCallInfo(toolCall)
    const options = (Array.isArray(params.options) ? params.options : [])
      .map((entry) => asRecord(entry))
      .filter((entry) => typeof entry.optionId === 'string')
      .map((entry) => ({
        optionId: String(entry.optionId),
        kind: String(entry.kind ?? ''),
        name: stringOr(entry.name) ?? undefined,
      })) as GrokPermissionOption[]
    const turn = gp.activeTurn
    let decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
    if (!turn) {
      decision = 'cancel'
    } else if (gp.spec.alwaysApprove || info.readOnly) {
      decision = 'accept'
    } else {
      // Let the tool_use that opened this call reach the server first so the
      // approval can attach to its item.
      await turn.chain.catch(() => {})
      try {
        const answer = await turn.handlers.onPermissionRequest({
          type: 'permission_request',
          requestId: `grok-permission-${String(id)}`,
          toolUseId: info.toolUseId,
          toolName: info.toolName,
          input: info.input,
        })
        decision = answer.decision
      } catch (error) {
        debugLog('grok.permission.handlerFailed', {
          threadId: gp.threadId,
          error: errorMessage(error),
        })
        decision = 'cancel'
      }
    }
    const outcome = grokPermissionOutcome(decision, options)
    debugLog('grok.permission', {
      threadId: gp.threadId,
      toolUseId: info.toolUseId,
      toolName: info.toolName,
      decision,
      outcome,
    })
    this.write(gp, { jsonrpc: '2.0', id, result: { outcome } })
  }
}

function sameSpec(a: GrokAgentSpec, b: GrokAgentSpec): boolean {
  return a.model === b.model && a.effort === b.effort && a.alwaysApprove === b.alwaysApprove
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
