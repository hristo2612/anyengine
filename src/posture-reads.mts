// Codex's per-path read policies cannot be represented by M0. Remember the
// restriction, rather than projecting it into the broader read-only sandbox.
// This wire scan is a conservative superset, not requirements detection:
// Codex 0.159 loads denies locally (see requirements-reads.mts), not over RPC.
const BUILTIN_PROFILES = new Set([':read-only', ':workspace', ':danger-full-access'])

export function hasReadRestriction(params: Record<string, unknown>): boolean {
  for (const key of ['permissions', 'permissionProfile', 'activePermissionProfile']) {
    const value = params[key]
    if (value == null) continue
    const id = typeof value === 'string' ? value : record(value).id
    if (typeof id !== 'string' || !BUILTIN_PROFILES.has(id.trim())) return true
  }
  return containsReadDeny(params)
}

function containsReadDeny(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsReadDeny)
  for (const [key, entry] of Object.entries(record(value))) {
    if (/(?:^|\.)(deny_read|denyRead)$/.test(key) && nonempty(entry)) return true
    // FileSystemAccessMode occurs in server-to-client permission requests,
    // not requirements. Also fail closed if a future policy contains it.
    if ((key === 'access' || key === 'mode') && entry === 'deny') return true
    if (containsReadDeny(entry)) return true
  }
  return false
}

function nonempty(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value != null && value !== false
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

// A `permissions` value this build cannot read (not a 1-128 character id) is
// a custom profile it cannot see into, like any other: the default sandbox.
const UNREADABLE_PROFILE = '?unreadable'

export function profileIdOf(params: Record<string, unknown>): string | null {
  const value = params.permissions
  if (value == null) return null
  const id = typeof value === 'string' ? value.trim() : ''
  return id.length > 0 && id.length <= 128 ? id : UNREADABLE_PROFILE
}
