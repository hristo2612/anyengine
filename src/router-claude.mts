// Every Claude turn passes the ownership gate. Agent turns run on only that
// adapter; the router emits its progress and answer as Codex Responses events.
import { randomUUID } from 'node:crypto'
import type { ClaimEvent } from './claim-protocol.mjs'
import { claudePromptText, makeMarker, parseCodexRequest } from './codex-input.mjs'
import {
  parentThreadIdOfRequest,
  parentTurnIdOfRequest,
  threadIdOfRequest,
  turnIdOfRequest,
} from './codex-wire.mjs'
import { ResponsesStream, usageObject } from './responses-stream.mjs'
import type { AdapterOwner } from './router-claim-client.mjs'
import {
  adapterOwns,
  type ClaimOutcome,
  claimOnAdapters,
  claimTimeoutMs,
} from './router-claim-client.mjs'
import type { RouterContext } from './router-server.mjs'
import type { ClaudeTurnRequest, ClaudeTurns } from './router-turns.mjs'

export const UNCLAIMED_MESSAGE =
  'Claude runs through the AnyEngine adapter that started this thread, and no running adapter knows it. Continue in ChatGPT.app with AnyEngine on, or pick a GPT model here.'

export interface ClaudeTurnAdmission {
  signal: AbortSignal
  finish(): void
}

function modelOf(request: ClaudeTurnRequest): string {
  return typeof request.body?.model === 'string' ? request.body.model : 'claude'
}

function failTurn(request: ClaudeTurnRequest, message: string): void {
  const stream = new ResponsesStream(request.sink, { model: modelOf(request) })
  stream.begin()
  stream.fail(message)
}

// Includes the ownership/discovery phase, before a Responses stream exists.
// Sinks may emit close twice; completing a live sink is not caller cancellation.
function turnScope(request: ClaudeTurnRequest) {
  const abort = new AbortController()
  const cancelled = () => abort.abort()
  const closed = () => {
    if (request.sink.destroyed || !request.sink.writableEnded) cancelled()
  }
  request.signal.addEventListener('abort', cancelled, { once: true })
  request.sink.on('close', closed)
  if (request.signal.aborted || request.sink.destroyed) cancelled()
  return {
    signal: abort.signal,
    cancel: cancelled,
    cleanup: () => {
      request.signal.removeEventListener('abort', cancelled)
      request.sink.off?.('close', closed)
    },
  }
}

async function isEvidence(
  ctx: RouterContext,
  request: ClaudeTurnRequest,
  runDir: string,
): Promise<boolean> {
  if (request.signal.aborted) return false
  const parent = parentThreadIdOfRequest(request.headers, request.body)
  if (!parent) return false
  const owner = await adapterOwns(
    runDir,
    parent,
    request.signal,
    claimTimeoutMs(ctx.config().claims.graceMs),
    'parent',
  )
  return owner !== null && !request.signal.aborted
}

export class OwnedClaudeTurns implements ClaudeTurns {
  readonly mode: ClaudeTurns['mode']
  private readonly inner: ClaudeTurns
  private readonly runDir: string
  private readonly onClaim: (claimed: boolean) => void
  private readonly admit:
    | ((
        threadId: string | null,
        request: ClaudeTurnRequest,
      ) => ClaudeTurnAdmission | string | undefined)
    | undefined
  private readonly prepare:
    | ((
        threadId: string | null,
        owner: AdapterOwner | null,
        request: ClaudeTurnRequest,
        mode: ClaudeTurns['mode'],
      ) => Promise<void>)
    | undefined

  constructor(
    inner: ClaudeTurns,
    runDir: string,
    onClaim: (claimed: boolean) => void = () => {},
    prepare?: OwnedClaudeTurns['prepare'],
    admit?: OwnedClaudeTurns['admit'],
  ) {
    this.inner = inner
    this.runDir = runDir
    this.onClaim = onClaim
    this.mode = inner.mode
    this.prepare = prepare
    this.admit = admit
  }

  async run(ctx: RouterContext, request: ClaudeTurnRequest): Promise<void> {
    const scope = turnScope(request)
    let admission: ClaudeTurnAdmission | undefined
    try {
      const threadId = threadIdOfRequest(request.headers, request.body)
      if (scope.signal.aborted) return
      const offered = this.admit?.(threadId, request)
      if (typeof offered === 'string') {
        failTurn(request, offered)
        return
      }
      admission = offered
      const signal = admission ? AbortSignal.any([scope.signal, admission.signal]) : scope.signal
      const scoped = { ...request, signal }
      const stopped = () => {
        if (!signal.aborted) return false
        if (!scope.signal.aborted) failTurn(request, 'This Claude turn was superseded or stopped.')
        return true
      }
      const owner = threadId
        ? await adapterOwns(
            this.runDir,
            threadId,
            signal,
            claimTimeoutMs(ctx.config().claims.graceMs),
          )
        : null
      if (stopped()) return
      await this.prepare?.(threadId, owner, scoped, this.mode)
      if (stopped()) return
      if (!owner) {
        ctx.log.info('claim.unclaimed', { threadId, mode: this.mode })
        if (await isEvidence(ctx, scoped, this.runDir)) this.onClaim(false)
        failTurn(request, UNCLAIMED_MESSAGE)
        return
      }
      let observed = false
      await this.inner.run(ctx, {
        ...scoped,
        owner,
        observeAgentClaim: async (claimed) => {
          if (this.mode !== 'agent' || observed || signal.aborted) return
          observed = true
          if (claimed) this.onClaim(true)
          else if (await isEvidence(ctx, scoped, this.runDir)) this.onClaim(false)
        },
      })
    } finally {
      admission?.finish()
      scope.cleanup()
    }
  }
}

interface TurnState {
  answered: boolean
  error: string | null
  done: boolean | null
}

export class AgentClaudeTurns implements ClaudeTurns {
  readonly mode = 'agent' as const
  private readonly keepAliveMs: number
  private readonly lastTurnByThread = new Map<string, string>()

  constructor(_runDir: string, keepAliveMs = 15_000) {
    this.keepAliveMs = keepAliveMs
  }

  async run(ctx: RouterContext, request: ClaudeTurnRequest): Promise<void> {
    const { body, headers, sink, owner } = request
    const scope = turnScope(request)
    const stream = new ResponsesStream(sink, { model: modelOf(request) })
    let keep: NodeJS.Timeout | undefined
    try {
      stream.begin()
      const threadId = threadIdOfRequest(headers, body)
      if (!threadId || !owner) {
        stream.fail(UNCLAIMED_MESSAGE)
        return
      }
      const parsed = parseCodexRequest(
        body,
        (sid, turnId) => this.lastTurnByThread.get(sid) === turnId,
      )
      if (scope.signal.aborted) return
      if (parsed.hasCompactionTrigger) {
        stream.compaction(makeMarker(threadId, 'compacted'))
        stream.complete(usageObject())
        return
      }
      keep = setInterval(() => {
        try {
          stream.keepAlive()
        } catch {
          scope.cancel()
        }
      }, this.keepAliveMs)
      keep.unref()
      const state: TurnState = { answered: false, error: null, done: null }
      let observation: Promise<void> | undefined
      const outcome = await claimOnAdapters(
        owner,
        {
          op: 'claim',
          threadId,
          parentThreadId: parentThreadIdOfRequest(headers, body),
          turnId: turnIdOfRequest(headers, body),
          model: modelOf(request),
          prompt: claudePromptText(parsed, { newSession: !parsed.resume }),
          cwd: parsed.cwd,
          effort: effortOf(body),
        },
        (event) => {
          // Receipt is the claim evidence, even if writing its answer fails
          // or closes the caller. Start observing before touching the sink.
          if (event.type === 'done') observation = request.observeAgentClaim?.(true)
          this.onEvent(stream, state, event)
        },
        scope.signal,
        claimTimeoutMs(ctx.config().claims.graceMs),
      )
      await observation
      if (scope.signal.aborted) return
      if (outcome === 'unknown') await request.observeAgentClaim?.(false)
      this.finish(ctx, stream, state, outcome, threadId)
      if (outcome === 'claimed' && state.done === true && !state.error)
        ctx.log.info('claim.done', {
          threadId,
          turnId: turnIdOfRequest(headers, body),
          parentThreadId: parentThreadIdOfRequest(headers, body),
          parentTurnId: parentTurnIdOfRequest(headers, body),
          model: modelOf(request),
          owner: owner.socketPath,
          success: true,
        })
    } catch {
      stream.fail('Claude could not handle this task.')
    } finally {
      clearInterval(keep)
      scope.cleanup()
      stream.end()
    }
  }

  private rememberTurn(threadId: string, turnKey: string): void {
    this.lastTurnByThread.delete(threadId)
    this.lastTurnByThread.set(threadId, turnKey)
    if (this.lastTurnByThread.size > 2000) {
      const oldest = this.lastTurnByThread.keys().next().value
      if (oldest !== undefined) this.lastTurnByThread.delete(oldest)
    }
  }

  private finish(
    ctx: RouterContext,
    stream: ResponsesStream,
    state: TurnState,
    outcome: ClaimOutcome,
    threadId: string,
  ): void {
    if (outcome === 'unknown') {
      ctx.log.info('claim.unclaimed', { threadId, mode: 'agent', after: 'owns' })
      stream.fail(UNCLAIMED_MESSAGE)
    } else if (outcome === 'failed' || state.done !== true) {
      ctx.log.info('claim.failed', { threadId })
      stream.fail(
        `Claude could not finish this task: ${state.error ?? 'the adapter did not finish successfully'}`,
      )
    } else {
      const turnKey = randomUUID()
      this.rememberTurn(threadId, turnKey)
      stream.marker(makeMarker(threadId, turnKey))
      stream.complete(usageObject())
    }
  }

  private onEvent(stream: ResponsesStream, state: TurnState, event: ClaimEvent): void {
    switch (event.type) {
      case 'progress':
        stream.reasoning(event.text)
        return
      case 'text':
        state.answered ||= Boolean(event.delta)
        stream.textDelta(event.delta)
        return
      case 'done':
        state.done = event.success
        if (!state.answered && event.text) stream.textDelta(event.text)
        return
      case 'error':
        state.error = event.message
        return
      default:
        return
    }
  }
}

function effortOf(body: Record<string, unknown>): string | null {
  const effort = (body.reasoning as { effort?: unknown } | undefined)?.effort
  return typeof effort === 'string' ? effort : null
}

export function pickClaudeTurns(
  ctx: RouterContext,
  available: { agent: ClaudeTurns | null; model: ClaudeTurns | null },
): ClaudeTurns | null {
  return ctx.config().modes.codexClaude === 'model' ? available.model : available.agent
}

export { ModelClaudeTurns } from './router-model.mjs'
