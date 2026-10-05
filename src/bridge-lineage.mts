import { isUnrestricted, type Posture } from './posture.mjs'

// `send_to_session` runs a turn on another thread under that thread's own
// posture, which can be looser than the caller's (spec 5.6: never looser than
// the parent). A thread the bridge started got no more than its spawner held,
// so only that spawner, directly or through its own children, may drive it;
// an unrestricted caller has nothing left to gain and may drive any thread.
//
// Kept in memory for the adapter's life. A GPT child has no row in the store,
// and after a restart a continue is refused (fail closed) until the caller
// spawns afresh.
export class SpawnLineage {
  private readonly spawnerOf = new Map<string, string>()

  record(childId: string, spawnerId: string | null): void {
    if (spawnerId) this.spawnerOf.set(childId, spawnerId)
  }

  assertMayDrive(caller: { id: string; posture: Posture } | null, targetId: string): void {
    if (!caller) {
      throw new Error(
        'send_to_session needs a known calling thread (the bridge could not infer which thread is running)',
      )
    }
    if (isUnrestricted(caller.posture)) return
    const seen = new Set<string>()
    for (let at = this.spawnerOf.get(targetId); at && !seen.has(at); at = this.spawnerOf.get(at)) {
      if (at === caller.id) return
      seen.add(at)
    }
    throw new Error(
      `thread ${targetId} was not started by the calling thread ${caller.id}: only its spawner, or a thread with full access, may send to it`,
    )
  }
}
