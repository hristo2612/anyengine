import type { JsonRpcId, JsonRpcResponse, RpcPeer } from './types.mjs'
import { debugLog } from './util.mjs'

// Approval IDs stay distinct from both the desktop and upstream request spaces.
export class CodexServerRequests {
  private nextId = 0
  private readonly entries = new Map<
    string,
    { upId: JsonRpcId; peer: RpcPeer; answered: boolean }
  >()
  rewrite(upId: JsonRpcId, peer: RpcPeer): string {
    const id = `s${++this.nextId}`
    this.entries.set(id, { upId, peer, answered: false })
    return id
  }
  answer(response: JsonRpcResponse, write: (response: JsonRpcResponse) => void): boolean {
    const entry = this.entries.get(String(response.id))
    if (!entry || entry.answered) return false
    entry.answered = true
    this.prune()
    debugLog('codex.upstream.serverRequestAnswered', { downId: response.id, upId: entry.upId })
    const translated: JsonRpcResponse = { jsonrpc: '2.0', id: entry.upId }
    if (response.error) translated.error = response.error
    else translated.result = response.result ?? null
    write(translated)
    return true
  }
  resolved(upId: JsonRpcId): JsonRpcId | null {
    for (const [id, entry] of this.entries)
      if (String(entry.upId) === String(upId)) {
        this.entries.delete(id)
        return id
      }
    return null
  }
  private prune(): void {
    let answered = [...this.entries.values()].filter((entry) => entry.answered).length
    if (answered <= 512) return
    for (const [id, entry] of this.entries) {
      if (!entry.answered) continue
      this.entries.delete(id)
      if (--answered <= 256) break
    }
  }
  clear(): void {
    this.entries.clear()
  }
}
