// Ported from EthanSK/claude-in-codex (MIT) src/server.js @ e2adced; see THIRD_PARTY_NOTICES.md.
// Changes: owned, tracked model turns; response segments have independent lifetimes.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { makeMarker, parseCodexRequest } from './codex-input.mjs'
import {
  parentThreadIdOfRequest,
  parentTurnIdOfRequest,
  threadIdOfRequest,
  turnIdOfRequest,
} from './codex-wire.mjs'
import { ResponsesStream, usageObject } from './responses-stream.mjs'
import { type AdapterOwner, claimTimeoutMs } from './router-claim-client.mjs'
import { type ClaudeTurnAdmission, UNCLAIMED_MESSAGE } from './router-claude.mjs'
import type { RouterLog } from './router-log.mjs'
import type { RouterContext } from './router-server.mjs'
import type { ClaudeTurnRequest, ClaudeTurns } from './router-turns.mjs'
import { compactTrampolineSession, runTrampolineTurn } from './trampoline-runner.mjs'
import { TrampolineState } from './trampoline-state.mjs'
import {
  cancelWaitingCodexTurns,
  closeCodexTurns,
  findCodexResults,
  hasWaitingCodexResults,
} from './trampoline-tools.mjs'

export class ModelClaudeTurns implements ClaudeTurns {
  readonly mode = 'model' as const
  private readonly root: string
  private readonly log: RouterLog
  private readonly state: TrampolineState
  private readonly runs = new Map<AbortController, Promise<void>>()
  private readonly admissions = new Map<string, AbortController>()
  private closing = false
  constructor(root: string, log: RouterLog) {
    this.root = root
    this.log = log
    this.state = new TrampolineState(join(root, 'router', 'trampoline-state.json'))
  }
  admit(
    threadId: string | null,
    request: ClaudeTurnRequest,
  ): ClaudeTurnAdmission | string | undefined {
    // Reject invalid results before they can supersede even a pending owns lookup.
    const invalid = this.resultError(threadId, request)
    if (invalid) return invalid
    if (this.closing) return 'Claude model router is stopping.'
    if (!threadId) return undefined
    if (!this.admissions.has(threadId) && this.admissions.size >= 512)
      return 'Too many pending Claude turns.'
    const abort = new AbortController()
    this.admissions.get(threadId)?.abort()
    this.admissions.set(threadId, abort)
    return {
      signal: abort.signal,
      finish: () => {
        if (this.admissions.get(threadId) === abort) this.admissions.delete(threadId)
      },
    }
  }
  async prepare(
    threadId: string | null,
    owner: AdapterOwner | null,
    request: ClaudeTurnRequest,
    mode: ClaudeTurns['mode'],
  ): Promise<void> {
    if (this.resultError(threadId, request)) return
    const found = findCodexResults(request.body.input)
    if (mode === 'model' && owner && hasWaitingCodexResults(request.body.input)) {
      // Invalid cross-thread/mixed submissions cannot disturb another live turn.
      if (!found || found.turn.threadId !== threadId || found.turn.engineRoot !== this.root) return
      if (found.turn.ownerPath === owner.socketPath && found.turn.ownerCurrent()) return
    }
    await cancelWaitingCodexTurns(threadId, this.root)
  }
  async close(): Promise<void> {
    this.closing = true
    for (const abort of this.admissions.values()) abort.abort()
    this.admissions.clear()
    for (const abort of this.runs.keys()) abort.abort()
    await closeCodexTurns(this.root)
    await Promise.all(this.runs.values())
  }
  async run(ctx: RouterContext, request: ClaudeTurnRequest): Promise<void> {
    const { body, headers, sink, owner } = request
    const stream = new ResponsesStream(sink, {
      model: typeof body.model === 'string' ? body.model : 'claude',
    })
    stream.begin()
    let onClose = () => {}
    const ended = new Promise<void>((resolve) => {
      onClose = resolve
    })
    sink.on('close', onClose)
    try {
      if (this.closing || request.signal.aborted) {
        stream.fail('Claude model router is stopping.')
        return
      }
      const threadId = threadIdOfRequest(headers, body)
      if (!threadId || !owner) {
        stream.fail(UNCLAIMED_MESSAGE)
        return
      }
      const parsed = parseCodexRequest(body, (sid, turnId) => this.state.isLatestTurn(sid, turnId))
      const found = findCodexResults(body.input)
      if (hasWaitingCodexResults(body.input)) {
        if (
          !found ||
          found.turn.threadId !== threadId ||
          found.turn.engineRoot !== this.root ||
          found.turn.ownerPath !== owner.socketPath ||
          !found.turn.resume(stream, found)
        ) {
          stream.fail('Codex tool results do not belong to this owned Claude turn.')
          return
        }
        await ended
        return
      }
      if (this.staleResultOnly(request)) {
        stream.fail('This Claude tool call is no longer waiting for a result.')
        return
      }
      await cancelWaitingCodexTurns(threadId, this.root)
      if (request.signal.aborted || sink.destroyed || stream.closed || this.closing) {
        stream.fail('This Claude turn was superseded or stopped.')
        return
      }
      const abort = new AbortController()
      const cancel = () => {
        if (!stream.closed) abort.abort()
      }
      request.signal.addEventListener('abort', cancel, { once: true })
      if (request.signal.aborted) cancel()
      const claudePath = ctx.config().claude.cli ?? 'claude'
      const model = ctx.config().claude.models.find((entry) => entry.id === body.model)
      if (!model) throw new Error('unknown Claude model')
      const lifetime = parsed.hasCompactionTrigger
        ? this.compact(stream, parsed, threadId, claudePath, owner.cwd, abort.signal)
        : runTrampolineTurn({
            stream,
            parsed: {
              ...parsed,
              threadId,
              codexTurnId: turnIdOfRequest(headers, body) ?? randomUUID(),
              fork: !!parsed.resume && this.state.ownerThread(parsed.resume.sid) !== threadId,
            },
            model,
            effort:
              typeof (body.reasoning as { effort?: unknown } | undefined)?.effort === 'string'
                ? (body.reasoning as { effort: string }).effort
                : null,
            codexTools: Array.isArray(body.tools) ? body.tools : [],
            claudePath,
            trustedCwd: owner.cwd,
            engineRoot: this.root,
            state: this.state,
            log: this.log,
            owner,
            parentThreadId: parentThreadIdOfRequest(headers, body),
            parentTurnId: parentTurnIdOfRequest(headers, body),
            ownerTimeoutMs: claimTimeoutMs(ctx.config().claims.graceMs),
            signal: abort.signal,
          })
      const joined = lifetime.finally(() => {
        request.signal.removeEventListener('abort', cancel)
        this.runs.delete(abort)
      })
      this.runs.set(abort, joined)
      await Promise.race([joined, ended])
    } catch {
      stream.fail('Claude could not handle this model task.')
    } finally {
      sink.off?.('close', onClose)
    }
  }
  private resultError(threadId: string | null, request: ClaudeTurnRequest): string | null {
    try {
      if (hasWaitingCodexResults(request.body.input)) {
        const found = findCodexResults(request.body.input)
        if (!found || found.turn.threadId !== threadId || found.turn.engineRoot !== this.root)
          return 'Codex tool results do not belong to this owned Claude turn.'
      } else if (this.staleResultOnly(request)) {
        return 'This Claude tool call is no longer waiting for a result.'
      }
      return null
    } catch {
      // Admission and post-owns preparation both precede the turn's parser catch.
      return 'Claude could not parse this task.'
    }
  }
  private staleResultOnly(request: ClaudeTurnRequest): boolean {
    const { body } = request
    if (hasWaitingCodexResults(body.input)) return false
    const parsed = parseCodexRequest(body, (sid, turnId) => this.state.isLatestTurn(sid, turnId))
    return (
      !parsed.hasCompactionTrigger &&
      !parsed.promptText &&
      Array.isArray(body.input) &&
      body.input.some(
        (item) => item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output',
      )
    )
  }
  private async compact(
    stream: ResponsesStream,
    parsed: ReturnType<typeof parseCodexRequest>,
    threadId: string,
    claudePath: string,
    trustedCwd: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    const marker = parsed.marker
    let sid: string | null = null
    if (marker) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(marker.sid) ||
        !this.state.isLatestTurn(marker.sid, marker.turnId) ||
        this.state.ownerThread(marker.sid) !== threadId
      ) {
        stream.fail('Cannot compact an unrecorded Claude session.')
        return
      }
      const result = await compactTrampolineSession({
        claudePath,
        sid: marker.sid,
        trustedCwd,
        engineRoot: this.root,
        signal,
      })
      sid = result.sessionId
      if (!sid) {
        stream.fail('Claude context compaction failed.')
        return
      }
    }
    if (signal.aborted) {
      stream.fail('Claude context compaction stopped.')
      return
    }
    const turnId = randomUUID()
    if (sid) this.state.recordTurn(sid, turnId, threadId)
    stream.compaction(sid ? makeMarker(sid, turnId) : 'ae:v1:none:none')
    stream.complete(usageObject())
  }
}
