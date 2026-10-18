import type { AccountParticipant } from './accounts-participant.mjs'
import type { WorkLease } from './accounts-types.mjs'
import { asRecord, threadIdOf } from './rpc-shape.mjs'
import type { RpcPeer, WireMessage } from './types.mjs'

const STARTS = new Set([
  'turn/start',
  'review/start',
  'thread/compact/start',
  'thread/realtime/start',
  'command/exec',
])
export class AccountWork {
  readonly runtime: AccountParticipant
  private readonly leases = new Map<string, WorkLease>()
  private readonly active = new Set<string>()
  private readonly starting = new Set<string>()
  private readonly completed = new Set<string>()
  private readonly spawnItems = new Set<string>()
  private readonly finished = new Set<string>()
  private readonly realtime = new Set<string>()
  constructor(runtime: AccountParticipant) {
    this.runtime = runtime
  }
  admit(peer: RpcPeer, message: WireMessage): RpcPeer | false {
    if (!('method' in message) || !('id' in message)) return peer
    if (!STARTS.has(message.method)) {
      const ongoing = this.realtime.has(threadIdOf(asRecord(message.params)) ?? '')
      if (
        message.method !== 'thread/start' &&
        !ongoing &&
        /\/(?:start|appendText|appendAudio)$/.test(message.method)
      ) {
        peer.send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32000,
            message: 'Account switching is in progress; retry after it completes',
          },
        })
        return false
      }
      return peer
    }
    const thread = threadIdOf(asRecord(message.params))
    const key = thread ?? `request:${peer.id}:${message.id}`
    if (this.starting.has(key) || this.active.has(key) || this.realtime.has(key)) {
      peer.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'A managed turn is already running' },
      })
      return false
    }
    try {
      // Account-rotation protection can outlive a completed turn while another
      // chat or native child is active. It is not a per-chat busy flag.
      // Admit afresh so a frozen/retired account still refuses new work, then
      // replace the retained lease without an unprotected switching window.
      const lease = this.runtime.begin()
      const retained = this.leases.get(key)
      this.leases.set(key, lease)
      void retained?.release().catch(() => {})
      this.starting.add(key)
      this.completed.delete(key)
      if (message.method === 'thread/realtime/start') this.realtime.add(key)
    } catch {
      peer.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: 'Account switching is in progress; retry after it completes',
        },
      })
      return false
    }
    return {
      id: peer.id,
      close: () => peer.close(),
      send: (outgoing) => {
        this.observe(outgoing)
        if (
          'id' in outgoing &&
          outgoing.id === message.id &&
          ('error' in outgoing || message.method === 'command/exec')
        ) {
          this.starting.delete(key)
          if (message.method === 'thread/realtime/start') this.realtime.delete(key)
          if (message.method === 'command/exec') this.release(key)
          else {
            this.completed.add(key)
            this.flushCompleted()
          }
        }
        peer.send(outgoing)
      },
    }
  }
  observe(message: WireMessage | { method: string; params: unknown }): void {
    if (!('method' in message) || !message.method) return
    const params = asRecord(message.params),
      thread = threadIdOf(params)
    if (message.method === 'turn/started' && thread) {
      this.starting.delete(thread)
      this.completed.delete(thread)
      this.active.add(thread)
      this.finished.delete(thread)
    }
    this.observeSpawn(message.method, asRecord(params.item))
    if (
      thread &&
      ['turn/completed', 'thread/compacted', 'thread/realtime/closed'].includes(message.method)
    ) {
      this.starting.delete(thread)
      this.active.delete(thread)
      this.finished.add(thread)
      if (message.method === 'thread/realtime/closed') this.realtime.delete(thread)
      if (!this.realtime.has(thread)) this.completed.add(thread)
    }
    this.flushCompleted()
  }
  private flushCompleted(): void {
    if (this.active.size || this.starting.size || this.spawnItems.size) return
    for (const id of this.completed) this.release(id)
    this.completed.clear()
  }
  private observeSpawn(method: string, item: Record<string, unknown>): void {
    if (
      item.type === 'collabAgentToolCall' &&
      item.tool === 'spawnAgent' &&
      typeof item.id === 'string'
    ) {
      if (method === 'item/started') this.spawnItems.add(item.id)
      if (method === 'item/completed') {
        this.spawnItems.delete(item.id)
        for (const id of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [])
          if (typeof id === 'string' && !this.finished.has(id)) this.active.add(id)
      }
    }
  }
  private release(key: string): void {
    const lease = this.leases.get(key)
    this.leases.delete(key)
    this.starting.delete(key)
    this.realtime.delete(key)
    // SQLite release is synchronous before the returned Promise settles.
    void lease?.release().catch(() => {})
  }
  async close(): Promise<void> {
    for (const key of [...this.leases.keys()]) this.release(key)
    await this.runtime.close()
  }
}
