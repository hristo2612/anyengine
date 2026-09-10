// One-release compatibility shim for the pre-rebrand environment variables.
//
// Every setting used to be spelled `CLAUDE_CODEX_*`; it is now `ANYENGINE_*`.
// For one release the adapter still accepts the old spelling: on startup each
// `CLAUDE_CODEX_X` that is set copies itself to `ANYENGINE_X` unless the new
// name is already set (the new name always wins). Nothing is deleted, so a
// process that reads the old name directly keeps working.
//
// `adapter.mts` imports this module for its side effect alone, above every
// module that reads `process.env`, so the copy is already done by the time
// they are evaluated. Delete it, that import and the matching shell block in
// `scripts/codex-shim` in the release after next.

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

// The side effect the import exists for. Nothing reads the return value; the
// point is that `process.env` carries both spellings from here on.
applyLegacyEnvNames()
