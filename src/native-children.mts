// Children codex spawned itself (spawn_agent). Codex announces one through
// its parent's `collabAgentToolCall` items (tool `spawnAgent`): `item/started`
// with no receivers, then `item/completed` naming the child in
// `receiverThreadIds`, before the first model request; the child's own
// `turn/started` may precede this link; `thread/started` is absent for children
// (test/fixtures/codex-spawn-*.json). Both sources are read. A claim for a
// child can arrive before either, hence the waiters.
import type { UpstreamThreadInfo } from './codex-mux.mjs'
import { STRICTEST_POSTURE } from './posture.mjs'
import { asRecord } from './rpc-shape.mjs'

export interface NativeChild {
  threadId: string
  parentThreadId: string
  model: string | null
  cwd: string | null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// The posture a child is spawned with: its parent's, as the mux knows it at
// that moment (claimPosture narrows it later if the parent tightens).
export function inheritedInfo(
  child: NativeChild,
  parent: UpstreamThreadInfo | null,
): UpstreamThreadInfo {
  return {
    cwd: child.cwd ?? parent?.cwd ?? null,
    model: child.model,
    posture: structuredClone(parent?.posture ?? STRICTEST_POSTURE),
  }
}

export class NativeChildren {
  private stopped = false
  private readonly children = new Map<string, NativeChild>()
  private readonly waiters = new Map<string, Array<(child: NativeChild | null) => void>>()

  private remember(child: NativeChild): NativeChild {
    const known = this.children.get(child.threadId)
    const merged = known
      ? { ...known, model: known.model ?? child.model, cwd: known.cwd ?? child.cwd }
      : child
    this.children.set(child.threadId, merged)
    for (const wake of this.waiters.get(child.threadId) ?? []) wake(merged)
    this.waiters.delete(child.threadId)
    return merged
  }

  observeItem(item: Record<string, unknown>): NativeChild[] {
    if (item.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent') return []
    const parentThreadId = text(item.senderThreadId)
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
    if (!parentThreadId) return []
    return receivers.flatMap((id) => {
      const threadId = text(id)
      return threadId
        ? [this.remember({ threadId, parentThreadId, model: text(item.model), cwd: null })]
        : []
    })
  }

  observeThread(thread: Record<string, unknown>): NativeChild | null {
    const child = nativeChildFromThread(thread)
    return child ? this.remember(child) : null
  }

  get(threadId: string): NativeChild | null {
    return this.children.get(threadId) ?? null
  }

  waitFor(threadId: string, ms: number): Promise<NativeChild | null> {
    if (this.stopped) return Promise.resolve(null)
    const known = this.get(threadId)
    if (known || ms <= 0) return Promise.resolve(known)
    return new Promise((resolve) => {
      const wake = (child: NativeChild | null) => {
        clearTimeout(timer)
        resolve(child)
      }
      const timer = setTimeout(() => {
        const rest = (this.waiters.get(threadId) ?? []).filter((w) => w !== wake)
        if (rest.length > 0) this.waiters.set(threadId, rest)
        else this.waiters.delete(threadId)
        resolve(null)
      }, ms)
      this.waiters.set(threadId, [...(this.waiters.get(threadId) ?? []), wake])
    })
  }

  stop(): void {
    this.stopped = true
    for (const waiters of this.waiters.values()) for (const wake of waiters) wake(null)
    this.waiters.clear()
    this.children.clear()
  }

  forget(threadId: string): void {
    for (const wake of this.waiters.get(threadId) ?? []) wake(null)
    this.waiters.delete(threadId)
    this.children.delete(threadId)
  }
}
export function nativeChildFromThread(thread: Record<string, unknown>): NativeChild | null {
  const threadId = text(thread.id)
  // The generated schema spells it `subagent`; ChatGPT.app 26.928 reads `subAgent`.
  const source = asRecord(thread.source)
  const spawn = asRecord(asRecord(source.subagent ?? source.subAgent).thread_spawn)
  const parentThreadId = text(thread.parentThreadId) ?? text(spawn.parent_thread_id)
  if (!threadId || !parentThreadId) return null
  return { threadId, parentThreadId, model: text(thread.model), cwd: text(thread.cwd) }
}
