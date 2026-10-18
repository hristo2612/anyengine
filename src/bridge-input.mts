import type { BridgeHost, BridgeThreadInfo } from './bridge-control.mjs'
import type { SpawnLineage } from './bridge-lineage.mjs'
import type { Posture } from './posture.mjs'
import { engineForModel } from './rehome.mjs'

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
): void {
  lineage.assertMayDrive(caller, threadId)
  const target = host.threadInfo(threadId)
  if (!target) throw new Error(`unknown thread: ${threadId}`)
  if (!caller?.posture.readRestricted) return
  assertChildCanEnforceReads(host, caller.posture, target.model)
  // A child may predate its caller's restriction. Tighten before starting the
  // next turn; Claude's spawn key then removes reads from any warm PTY too.
  host.inheritFromCaller(threadId, caller.posture)
}

export function resolveBridgeCaller(
  host: Pick<BridgeHost, 'activeThreadIds' | 'threadInfo'>,
  callerId: string | null,
): BridgeThreadInfo | null {
  const named = callerId ? host.threadInfo(callerId) : null
  if (named) return named
  const active = [...new Set(host.activeThreadIds())]
  if (!callerId && active.length === 1) return host.threadInfo(active[0] ?? '')
  if (active.some((id) => host.threadInfo(id)?.posture.readRestricted)) {
    throw new Error(
      'Calling thread unknown while an active thread restricts reads; child control refused.',
    )
  }
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
