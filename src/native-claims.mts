// Claim bookkeeping is separate from mux transport/routing to keep its size ratchet.
import type { ClaimThread } from './claim-types.mjs'
import type { UpstreamThreadInfo } from './codex-mux.mjs'
import type { CodexUpstream } from './codex-upstream.mjs'
import {
  inheritedInfo,
  type NativeChild,
  NativeChildren,
  nativeChildFromThread,
} from './native-children.mjs'
import { claimPosture, type Posture, postureContext } from './posture.mjs'
import { asRecord } from './rpc-shape.mjs'

export class NativeClaims {
  private stopped = false
  private readonly children = new NativeChildren()
  private readonly bounds = new Map<string, Posture>()
  private readonly generations = new Map<string, number>()
  private readonly pending = new Map<string, Set<() => void>>()
  private readonly waits = new Set<Promise<ClaimThread | null>>()
  private readonly upstream: CodexUpstream
  private readonly threads: Map<string, UpstreamThreadInfo>
  private readonly record: (child: string, parent: string) => void
  private readonly knows: (id: string) => boolean

  constructor(
    upstream: CodexUpstream,
    threads: Map<string, UpstreamThreadInfo>,
    record: (child: string, parent: string) => void,
    knows: (id: string) => boolean,
  ) {
    this.upstream = upstream
    this.threads = threads
    this.record = record
    this.knows = knows
  }

  observeItem(item: Record<string, unknown>): void {
    for (const child of this.children.observeItem(item)) this.adopt(child)
  }

  observeThread(thread: Record<string, unknown>): void {
    const child = this.children.observeThread(thread)
    if (child) this.adopt(child)
  }

  private adopt(child: NativeChild): void {
    this.record(child.threadId, child.parentThreadId)
    const parent = this.get(child.parentThreadId)
    const inherited = inheritedInfo(
      child,
      parent ? { cwd: parent.cwd, model: parent.model, posture: parent.posture } : null,
    )
    const info = this.threads.get(child.threadId)
    if (!this.bounds.has(child.threadId)) {
      const bound = info
        ? claimPosture(
            info.posture,
            inherited.posture,
            postureContext(inherited.cwd ?? process.cwd()),
          )
        : inherited.posture
      this.bounds.set(child.threadId, structuredClone(bound))
    }
    if (!info) this.threads.set(child.threadId, inherited)
  }

  get(threadId: string): ClaimThread | null {
    if (this.stopped) return null
    // Resolve from the oldest known ancestor down, using effective, sticky
    // bounds at every generation. Missing ancestors and cycles start closed;
    // iterating also avoids recursion limits on deep or malformed lineage.
    const lineage: string[] = []
    const seen = new Set<string>()
    for (let id = threadId; !seen.has(id); ) {
      seen.add(id)
      lineage.push(id)
      const child = this.children.get(id)
      if (!child) break
      id = child.parentThreadId
    }
    let parent: ClaimThread | null = null
    for (const id of lineage.reverse()) {
      const info = this.threads.get(id)
      const child = this.children.get(id)
      if (!child) {
        parent = info
          ? {
              threadId: id,
              parentThreadId: null,
              parentCwd: info.cwd,
              cwd: info.cwd,
              model: info.model,
              posture: info.posture,
            }
          : null
        continue
      }
      const ctx = postureContext(parent?.cwd ?? info?.cwd ?? process.cwd())
      const childBound = claimPosture(info?.posture ?? null, this.bounds.get(id) ?? null, ctx)
      const posture = claimPosture(childBound, parent?.posture ?? null, ctx)
      // Remember tightening: later relaxation anywhere in the lineage cannot undo it.
      this.bounds.set(id, structuredClone(posture))
      parent = {
        threadId: id,
        parentThreadId: child.parentThreadId,
        parentCwd: parent?.cwd ?? null,
        cwd: child.cwd ?? info?.cwd ?? null,
        model: child.model,
        posture,
      }
    }
    return parent
  }

  waitFor(threadId: string, ms: number): Promise<ClaimThread | null> {
    const known = this.get(threadId)
    if (known || this.stopped) return Promise.resolve(known)
    const generation = this.generations.get(threadId) ?? 0
    let cancel!: () => void
    const cancelled = new Promise<null>((resolve) => {
      cancel = () => resolve(null)
    })
    const pending = this.pending.get(threadId) ?? new Set<() => void>()
    pending.add(cancel)
    this.pending.set(threadId, pending)
    const waiting = Promise.race([this.discover(threadId, ms, generation), cancelled]).finally(
      () => {
        pending.delete(cancel)
        if (pending.size === 0 && this.pending.get(threadId) === pending)
          this.pending.delete(threadId)
        this.waits.delete(waiting)
      },
    )
    this.waits.add(waiting)
    return waiting
  }

  private current(threadId: string, generation: number): boolean {
    return !this.stopped && (this.generations.get(threadId) ?? 0) === generation
  }

  private async discover(
    threadId: string,
    ms: number,
    generation: number,
  ): Promise<ClaimThread | null> {
    await this.children.waitFor(threadId, ms)
    if (!this.current(threadId, generation)) return null
    if (!this.get(threadId)) await this.learnFromChild(threadId, generation)
    return this.current(threadId, generation) ? this.get(threadId) : null
  }

  private async learnFromChild(threadId: string, generation: number): Promise<void> {
    if (!this.current(threadId, generation) || !this.upstream.available) return
    try {
      const read = asRecord(
        await this.upstream.request('thread/read', { threadId, includeTurns: false }),
      )
      const thread = asRecord(read.thread)
      const child = nativeChildFromThread(thread)
      // Validate without modifying the tracker, including the returned identity.
      if (
        this.current(threadId, generation) &&
        child?.threadId === threadId &&
        this.knows(child.parentThreadId)
      )
        this.observeThread(thread)
    } catch {
      // Unknown or unavailable: no claim.
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const pending of this.pending.values()) for (const cancel of pending) cancel()
    this.pending.clear()
    this.children.stop()
    this.bounds.clear()
    await Promise.allSettled([...this.waits])
  }

  forget(threadId: string): void {
    this.generations.set(threadId, (this.generations.get(threadId) ?? 0) + 1)
    for (const cancel of this.pending.get(threadId) ?? []) cancel()
    this.pending.delete(threadId)
    this.children.forget(threadId)
    this.bounds.delete(threadId)
    this.threads.delete(threadId)
  }
}
