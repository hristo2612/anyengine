// One-release compatibility shim for the pre-rebrand environment variables.
//
// Every setting used to be spelled `CLAUDE_CODEX_*`; it is now `ANYENGINE_*`.
// For one release the adapter still accepts the old spelling: on startup each
// `CLAUDE_CODEX_X` that is set copies itself to `ANYENGINE_X` unless the new
// name is already set (the new name always wins). Nothing is deleted, so a
// process that reads the old name directly keeps working.
//
// This module is imported FIRST by `adapter.mts` so the copy happens before
// any other module can read `process.env`. Delete it, its import and the
// matching shell block in `scripts/codex-shim` in the release after next.

const LEGACY_PREFIX = 'CLAUDE_CODEX_'
const PREFIX = 'ANYENGINE_'

/** Copies legacy `CLAUDE_CODEX_*` names onto their `ANYENGINE_*` equivalents. */
export function applyLegacyEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const migrated: string[] = []
  for (const name of Object.keys(env)) {
    if (!name.startsWith(LEGACY_PREFIX)) continue
    const value = env[name]
    if (value === undefined) continue
    const renamed = `${PREFIX}${name.slice(LEGACY_PREFIX.length)}`
    if (env[renamed] !== undefined) continue
    env[renamed] = value
    migrated.push(renamed)
  }
  return migrated
}

/** Names migrated at startup, for the adapter's debug log. */
export const migratedLegacyEnvNames: string[] = applyLegacyEnvNames()
