import type { BridgeHost, BridgeThreadInfo } from './bridge-control.mjs'
import type { SpawnLineage } from './bridge-lineage.mjs'
import { inheritFromCaller } from './claude-project-guard.mjs'
import { childStart, claimPosture, type Posture, postureContext } from './posture.mjs'
import { engineForModel } from './rehome.mjs'
import { durablePosture, withLocalReadRestrictions } from './requirements-reads.mjs'

export function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`)
  return value
}

// M0 only enforces the conservative read restriction in Claude. Projecting
// it into a Codex sandbox mode, or Grok's read-only classification, loses it.
export function assertChildCanEnforceReads(
  host: Pick<BridgeHost, 'routeForModel'>,
  posture: Posture,
  model: string | null,
): void {
  if (
    posture.readRestricted &&
    (host.routeForModel(model ?? '') !== 'local' || engineForModel(model) !== 'claude')
  ) {
    throw new Error(
      'This parent restricts reads; only Claude children can enforce that restriction.',
    )
  }
}

export function prepareChildSend(
  host: BridgeHost,
  lineage: SpawnLineage,
  caller: BridgeThreadInfo | null,
  threadId: string,
): Posture {
  lineage.assertMayDrive(caller, threadId)
  if (!caller) throw new Error('Calling thread unknown; child control refused')
  const target = host.threadInfo(threadId)
  if (!target) throw new Error(`unknown thread: ${threadId}`)
  const cwd = target.cwd ?? caller.cwd ?? process.cwd()
  // Compare durable permissions first: the live read overlay can otherwise
  // hide write differences, then disappear at the persistence boundary.
  const parent = durablePosture(caller.posture)
  const bounded = claimPosture(durablePosture(target.posture), parent, postureContext(cwd))
  const posture = withLocalReadRestrictions(inheritFromCaller(bounded, parent))
  // Workspace/external permissions include the turn's own cwd. A parent
  // tightened since spawning must still own that root, not accidentally grant
  // a different child's cwd by projecting its new posture there.
  if (posture.fileSystem.kind === 'workspace-write' || posture.fileSystem.kind === 'external')
    childStart(caller, cwd)
  assertChildCanEnforceReads(host, posture, target.model)
  // Preserve private trust/read/baseline fields before the public turn params
  // apply the complete tightened posture to either the local or native child.
  host.inheritFromCaller(threadId, posture)
  return posture
}

export function resolveBridgeCaller(
  host: Pick<BridgeHost, 'activeThreadIds' | 'threadInfo'>,
  callerId: string | null,
): BridgeThreadInfo | null {
  const named = callerId ? host.threadInfo(callerId) : null
  if (named) return named
  if (callerId) throw new Error('Unknown bridge caller identity; child control refused')
  const active = [...new Set(host.activeThreadIds())]
  if (active.length === 1) {
    const only = host.threadInfo(active[0] ?? '')
    if (!only) throw new Error('Calling thread unknown; child control refused')
    return only
  }
  if (active.some((id) => host.threadInfo(id)?.posture.readRestricted)) {
    throw new Error(
      'Calling thread unknown while an active thread restricts reads; child control refused.',
    )
  }
  if (active.length > 1)
    throw new Error(
      'Calling thread unknown among multiple active threads; client caller metadata is required.',
    )
  return null
}

// A shared Codex MCP process carries identity per call. Fixed Claude/Grok
// bridges remain bound to their original thread, including concurrent calls.
export function resolveBridgeRequestCaller(
  host: Pick<BridgeHost, 'threadInfo'>,
  fixed: string | null,
  value: unknown,
): string | null {
  if (value == null) return fixed
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid bridge caller identity')
  if (fixed && value !== fixed)
    throw new Error('Bridge caller identity does not match this connection')
  if (!host.threadInfo(value))
    throw new Error('Unknown bridge caller identity; child control needs a known calling thread')
  return value
}

export function uniqueName(name: string, used: Set<string>): string {
  let candidate = name
  let n = 2
  while (used.has(candidate)) candidate = `${name}-${n++}`
  used.add(candidate)
  return candidate
}
