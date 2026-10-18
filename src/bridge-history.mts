import type { DatabaseSync } from 'node:sqlite'
import type { ParentItemPhase } from './bridge-control.mjs'
import { readNativeThread } from './codex-history.mjs'
import type { CodexUpstream } from './codex-upstream.mjs'
import { asRecord } from './rpc-shape.mjs'
import type { JsonRpcRequest, RpcPeer, ThreadItem } from './types.mjs'

// Only adapter-created bridge navigation items, never native transcript bodies.
export class BridgeHistory {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`CREATE TABLE IF NOT EXISTS bridge_parent_items (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
      position INTEGER NOT NULL, item_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id, item_id)
    )`)
  }

  private key(threadId: string): string {
    const row = this.db
      .prepare('SELECT upstream_thread_id FROM thread_engines WHERE id = ?')
      .get(threadId) as { upstream_thread_id?: string } | undefined
    return row?.upstream_thread_id || threadId
  }

  record(threadId: string, turnId: string, item: ThreadItem, phase: ParentItemPhase): void {
    if (phase === 'lifecycle') return
    if (!threadId || !turnId || !item.id || item.type !== 'collabAgentToolCall')
      throw new Error('Invalid bridge parent item')
    const id = this.key(threadId)
    this.db
      .prepare(`INSERT INTO bridge_parent_items
      (thread_id, turn_id, item_id, position, item_json)
      VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1
        FROM bridge_parent_items WHERE thread_id = ? AND turn_id = ?), ?)
      ON CONFLICT (thread_id, turn_id, item_id) DO UPDATE SET
        item_json = excluded.item_json,
        position = CASE WHEN ? = 'endMove' THEN excluded.position ELSE position END
      WHERE ? != 'begin'`)
      .run(id, turnId, item.id, id, turnId, JSON.stringify(item), phase, phase)
  }

  has(threadId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM bridge_parent_items WHERE thread_id = ? LIMIT 1')
        .get(this.key(threadId)) != null
    )
  }

  deleteThread(threadId: string): void {
    this.db.prepare('DELETE FROM bridge_parent_items WHERE thread_id = ?').run(threadId)
  }

  projectTurns(threadId: string, turns: unknown[]): unknown[] {
    const id = this.key(threadId)
    return turns.map((value) => {
      const turn = asRecord(value)
      if (
        typeof turn.id !== 'string' ||
        !Array.isArray(turn.items) ||
        turn.itemsView === 'notLoaded'
      )
        return value
      const nativeIds = new Set(turn.items.map((item) => asRecord(item).id))
      const rows = this.db
        .prepare(`SELECT item_json FROM bridge_parent_items
        WHERE thread_id = ? AND turn_id = ? ORDER BY position`)
        .all(id, turn.id) as { item_json: string }[]
      const extras = rows
        .map((row) => JSON.parse(row.item_json) as ThreadItem)
        .filter((item) => !nativeIds.has(item.id))
      if (extras.length === 0) return value
      const items = [...turn.items]
      let at = items.length
      for (let index = items.length - 1; index >= 0; index--) {
        const item = asRecord(items[index])
        if (item.type === 'agentMessage' && item.phase !== 'commentary') {
          at = index
          break
        }
      }
      items.splice(at, 0, ...extras)
      return { ...turn, items }
    })
  }

  projectRead(threadId: string, value: unknown): unknown {
    const result = asRecord(value)
    const thread = asRecord(result.thread)
    return Array.isArray(thread.turns)
      ? { ...result, thread: { ...thread, turns: this.projectTurns(threadId, thread.turns) } }
      : value
  }

  async replyToRead(
    peer: RpcPeer,
    request: JsonRpcRequest,
    upstream: CodexUpstream,
  ): Promise<boolean> {
    if (request.method !== 'thread/read' && request.method !== 'thread/turns/list') return false
    const params = asRecord(request.params)
    const id = typeof params.threadId === 'string' ? params.threadId : ''
    if (!id || !this.has(id)) return false
    let result: unknown
    if (request.method === 'thread/read') {
      result = this.projectRead(
        id,
        await readNativeThread(params, (method, input) => upstream.request(method, input)),
      )
    } else {
      const page = asRecord(await upstream.request(request.method, params))
      if (!Array.isArray(page.data)) throw new Error('Invalid native turn page')
      result = { ...page, data: this.projectTurns(id, page.data) }
    }
    peer.send({ jsonrpc: '2.0', id: request.id, result })
    return true
  }
}
