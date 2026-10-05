// The real temp directory's `anyengine-*` entries, which
// scripts/test-hermetic.mjs compares before and after a run.
import { readdirSync } from 'node:fs'

export function listAnyengine(dir) {
  try {
    return readdirSync(dir).filter((name) => name.startsWith('anyengine-'))
  } catch {
    return []
  }
}

// Entries new since `before`. Another run's root is not one: every run on the
// machine shares this directory, and a run that overlaps this one leaves its
// root there until it ends, then removes it.
export function findStrays(dir, before) {
  return listAnyengine(dir).filter(
    (name) => !before.has(name) && !name.startsWith('anyengine-hermetic-'),
  )
}
