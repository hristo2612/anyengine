import { AccountContinuity, CONTINUITY_STARTS, encryptedFailure } from './accounts-continuity.mjs'
import type { AccountParticipant } from './accounts-participant.mjs'
import type { CodexUpstream } from './codex-upstream.mjs'
import { rewriteThreadIds } from './rehome.mjs'
import { asRecord, idOf, threadIdOf } from './rpc-shape.mjs'
import type { JsonRpcRequest, JsonRpcResponse, RpcPeer, WireMessage } from './types.mjs'

interface Attempt {
  appId: string
  nativeId: string
  peer: RpcPeer
  request: JsonRpcRequest
  turnId: string | null
  replacementTurn: string | null
  effect: boolean
  answered: boolean
  retrying: boolean
  failure: WireMessage | null
}

// Only the first turn after an account switch may be replaced, before any effect.
export class AccountThreadRetry {
  readonly context: AccountContinuity
  private readonly upstream: CodexUpstream
  private readonly connected: (peer: string) => boolean
  private readonly deliver: (message: WireMessage) => void
  private readonly attempts = new Map<string, Attempt>()
  constructor(
    runtime: AccountParticipant,
    upstream: CodexUpstream,
    hooks: ConstructorParameters<typeof AccountContinuity>[2],
  ) {
    this.context = new AccountContinuity(runtime, upstream, hooks)
    this.upstream = upstream
    this.connected = hooks.connected ?? (() => true)
    this.deliver = (message) => hooks.message?.(message)
    upstream.onChildLifecycle((event) => {
      if (event.type === 'exit') this.attempts.clear()
    })
  }
  async forward(peer: RpcPeer, request: JsonRpcRequest, appId: string | null): Promise<boolean> {
    if (!appId || !CONTINUITY_STARTS.has(request.method)) return false
    try {
      const prepared = await this.context.prepare(
        peer,
        appId,
        threadIdOf(asRecord(request.params)) ?? appId,
        asRecord(request.params),
        request.method === 'turn/start',
      )
      if (!this.connected(peer.id))
        throw new Error('Client disconnected before account continuation')
      request.params =
        request.method === 'turn/start'
          ? prepared.params
          : { ...asRecord(request.params), threadId: prepared.params.threadId }
      if (!prepared.firstAfterSwitch || request.method !== 'turn/start') return false
      const a: Attempt = {
        appId,
        nativeId: String(prepared.params.threadId),
        peer,
        request,
        turnId: null,
        replacementTurn: null,
        effect: false,
        answered: false,
        retrying: false,
        failure: null,
      }
      this.attempts.set(a.nativeId, a)
      this.send(a, false)
    } catch (error) {
      peer.send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      })
    }
    return true
  }
  private send(a: Attempt, replacement: boolean): void {
    const capture: RpcPeer = {
      id: a.peer.id,
      close: () => a.peer.close(),
      send: (message) => {
        const response = message as JsonRpcResponse
        if (response.error && !replacement && !a.effect && encryptedFailure(response.error)) {
          a.failure = message
          void this.retry(a)
          return
        }
        if (response.error) {
          this.forget(a)
          if (replacement && a.failure) this.deliverFailure(a)
          else a.peer.send(message)
          return
        }
        const turnId = idOf(asRecord(asRecord(response.result).turn))
        if (replacement) {
          a.replacementTurn = turnId
          if (!a.answered) {
            a.turnId = turnId
            a.answered = true
            a.peer.send(message)
          }
        } else {
          a.turnId = turnId
          a.answered = true
          a.peer.send(message)
        }
      },
    }
    this.upstream.forwardRequest(capture, a.request.id, a.request.method, a.request.params)
  }
  filter(incoming: WireMessage): WireMessage | null {
    const message = this.context.filter(incoming)
    if (!message || !('method' in message)) return message
    const p = asRecord(message.params),
      id = threadIdOf(p)
    const a = id ? this.attempts.get(id) : null
    if (!a) return message
    const turnId = typeof p.turnId === 'string' ? p.turnId : idOf(asRecord(p.turn))
    if (a.retrying) return this.replacement(a, message, id, turnId)
    if (turnId && a.turnId && turnId !== a.turnId) return message
    if (message.method === 'turn/started') {
      a.turnId ??= turnId
      return message
    }
    if (message.method === 'error') {
      if (p.willRetry !== true && !a.effect && encryptedFailure(p.error)) {
        a.failure = message
        return null
      }
      return message
    }
    if (message.method === 'turn/completed') {
      const turn = asRecord(p.turn)
      if (turn.status === 'failed' && !a.effect && encryptedFailure(turn.error)) {
        a.failure = message
        void this.retry(a)
        return null
      }
      this.forget(a)
      return message
    }
    // User items and bookkeeping carry no model/tool effect; everything else fails closed.
    const harmless =
      ['thread/status/changed', 'thread/tokenUsage/updated'].includes(message.method) ||
      (['item/started', 'item/completed'].includes(message.method) &&
        asRecord(p.item).type === 'userMessage')
    if (!harmless) a.effect = true
    return message
  }
  private replacement(
    a: Attempt,
    message: WireMessage & { method: string },
    id: string | null,
    turnId: string | null,
  ): WireMessage | null {
    if (id !== a.nativeId) return null
    if (turnId && a.turnId && turnId === a.turnId && turnId !== a.replacementTurn) return null
    if (message.method === 'turn/started') {
      a.replacementTurn ??= turnId
      if (a.answered && a.turnId && turnId !== a.turnId) return null
    }
    const rewritten =
      a.replacementTurn && a.turnId
        ? rewriteThreadIds(message, a.replacementTurn, a.turnId)
        : message
    if (message.method === 'turn/completed') this.forget(a)
    return rewritten
  }
  async read(peer: RpcPeer, request: JsonRpcRequest): Promise<boolean> {
    if (request.method !== 'thread/read') return false
    const params = asRecord(request.params)
    const view = await this.context.readView(threadIdOf(params) ?? '', params)
    if (!view) return false
    peer.send({ jsonrpc: '2.0', id: request.id, result: view })
    return true
  }
  private async retry(a: Attempt): Promise<void> {
    if (a.retrying) return
    a.retrying = true
    try {
      const params = await this.context.rehome(a.appId, asRecord(a.request.params), a.turnId)
      if (!this.connected(a.peer.id)) throw new Error('Client disconnected before account retry')
      const oldId = a.nativeId
      a.nativeId = String(params.threadId)
      a.request = { ...a.request, params }
      this.attempts.set(a.nativeId, a)
      // The old failed terminal is suppressed while the original work lease spans the retry.
      this.attempts.set(oldId, a)
      this.send(a, true)
    } catch {
      this.forget(a)
      this.deliverFailure(a)
    }
  }
  private deliverFailure(a: Attempt): void {
    if (!a.failure) return
    if ('method' in a.failure) this.deliver(a.failure)
    else a.peer.send(a.failure)
  }
  private forget(a: Attempt): void {
    for (const [id, current] of this.attempts) if (current === a) this.attempts.delete(id)
  }
}
