import type { Posture } from './posture.mjs'

// A thread a claim may run on the adapter's Claude: a child codex spawned
// (its parent known or not) or a thread the adapter forwarded itself.
export interface ClaimThread {
  threadId: string
  parentThreadId: string | null
  parentCwd: string | null
  cwd: string | null
  model: string | null
  posture: Posture
}
