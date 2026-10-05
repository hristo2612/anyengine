import { randomUUID } from 'node:crypto'
import type { AccountWork } from './accounts-work.mjs'
import { asRecord, idOf, threadIdOf } from './rpc-shape.mjs'
import type { JsonRpcRequest, RpcPeer, WireMessage } from './types.mjs'
import { debugLog } from './util.mjs'

export const CONTINUE_PROMPT =
  'The previous turn stopped at a usage limit; continue from where you left off.'
interface Caller {
  peer: RpcPeer
  params: Record<string, unknown>
}
const KEYS = [
  'model',
  'cwd',
  'approvalPolicy',
  'approvalsReviewer',
  'sandboxPolicy',
  'effort',
  'serviceTier',
]

// A new visible continue turn, never a resend of the failed user/tool request.
export class AccountReplay {
  private readonly work: AccountWork
  private readonly dispatch: (peer: RpcPeer, request: JsonRpcRequest) => Promise<unknown>
  private readonly session = randomUUID()
  private readonly peers = new Map<string, RpcPeer>()
  private readonly callers = new Map<string, Caller>()
  private readonly exhausted = new Set<string>()
  constructor(
    work: AccountWork,
    dispatch: (peer: RpcPeer, request: JsonRpcRequest) => Promise<unknown>,
  ) {
    this.work = work
    this.dispatch = dispatch
    work.runtime.ledger.metadata.db.exec(`CREATE TABLE IF NOT EXISTS account_replay(
      thread TEXT NOT NULL,turn TEXT NOT NULL,session TEXT NOT NULL,peer TEXT NOT NULL,
      generation INTEGER NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(thread,turn));`)
  }
  user(peer: RpcPeer, request: JsonRpcRequest): void {
    if (request.method !== 'turn/start' || String(request.id).startsWith('account-continue:'))
      return
    const params = asRecord(request.params),
      thread = threadIdOf(params)
    if (!thread) return
    this.cancel('thread', thread)
    this.peers.set(peer.id, peer)
    this.callers.set(thread, { peer, params })
  }
  disconnect(peer: string): void {
    this.peers.delete(peer)
    this.cancel('peer', peer)
    for (const [thread, c] of this.callers) if (c.peer.id === peer) this.callers.delete(thread)
  }
  private cancel(column: 'thread' | 'peer', value: string): void {
    this.work.runtime.ledger.metadata.tx(() => {
      this.work.runtime.ledger.metadata.db
        .prepare(
          `UPDATE account_replay SET status='cancelled' WHERE ${column}=? AND status='pending'${column === 'peer' ? ' AND session=?' : ''}`,
        )
        .run(...(column === 'peer' ? [value, this.session] : [value]))
    })
  }
  observe(message: WireMessage): void {
    if (!('method' in message)) return
    const p = asRecord(message.params),
      thread = threadIdOf(p)
    if (!thread) return
    const turn = asRecord(p.turn),
      turnId = typeof p.turnId === 'string' ? p.turnId : idOf(turn)
    if (!turnId) return
    const key = JSON.stringify([thread, turnId])
    if (
      message.method === 'error' &&
      p.willRetry !== true &&
      asRecord(p.error).codexErrorInfo === 'usageLimitExceeded'
    )
      this.exhausted.add(key)
    if (message.method !== 'turn/completed') return
    const quota =
      asRecord(turn.error).codexErrorInfo === 'usageLimitExceeded' || this.exhausted.delete(key)
    this.exhausted.delete(key)
    const caller = this.callers.get(thread)
    this.callers.delete(thread)
    const runtime = this.work.runtime
    if (
      turn.status !== 'failed' ||
      !quota ||
      !caller ||
      runtime.ledger.registry().replay !== 'continue-prompt'
    )
      return
    const params = Object.fromEntries(
      KEYS.filter((k) => Object.hasOwn(caller.params, k)).map((k) => [k, caller.params[k]]),
    )
    runtime.ledger.metadata.tx(() => {
      runtime.ledger.metadata.db
        .prepare('INSERT OR IGNORE INTO account_replay VALUES(?,?,?,?,?,?,?)')
        .run(
          thread,
          turnId,
          this.session,
          caller.peer.id,
          runtime.participant.generation,
          'pending',
          JSON.stringify(params),
        )
    })
  }
  afterRestart(): void {
    setImmediate(() => {
      void this.flush().catch((error) =>
        debugLog('accounts.replay.failed', { message: String(error) }),
      )
    })
  }
  async flush(): Promise<void> {
    const runtime = this.work.runtime
    if (runtime.ledger.registry().replay !== 'continue-prompt') return
    const rows = runtime.ledger.metadata.db
      .prepare("SELECT * FROM account_replay WHERE session=? AND status='pending' AND generation<?")
      .all(this.session, runtime.participant.generation)
    for (const row of rows) {
      const peer = this.peers.get(String(row.peer))
      if (!peer) {
        this.cancel('peer', String(row.peer))
        continue
      }
      const claimed = runtime.ledger.metadata.tx(
        () =>
          runtime.ledger.metadata.db
            .prepare(
              "UPDATE account_replay SET status='sent' WHERE thread=? AND turn=? AND status='pending'",
            )
            .run(String(row.thread), String(row.turn)).changes,
      )
      if (claimed !== 1) continue
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: `account-continue:${randomUUID()}`,
        method: 'turn/start',
        params: {
          ...asRecord(JSON.parse(String(row.body))),
          threadId: String(row.thread),
          input: [{ type: 'text', text: CONTINUE_PROMPT }],
        },
      }
      const admitted = this.work.admit(peer, request)
      if (!admitted) continue
      try {
        await this.dispatch(admitted, request)
      } catch (error) {
        admitted.send({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        })
      }
    }
  }
}
