import { readdirSync, readlinkSync, renameSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalDirectory, entry, privateDirectory, syncDir } from './accounts-files.mjs'
import { fileStamp, type OverlayManifest, sharedLink } from './accounts-overlay.mjs'
import type { AccountPaths } from './accounts-types.mjs'

const database = /\.(sqlite3?|db)(-(wal|shm|journal))?$/i
export function reconcileOverlay(
  p: AccountPaths,
  manifest: OverlayManifest,
  options: { familiesStopped?: boolean } = {},
): OverlayManifest {
  canonicalDirectory(p.canonical)
  privateDirectory(p.overlay, false)
  // Plan every move first, so a conflict preserves both writers' files.
  const moves: Array<{ source: string; dest: string; name: string }> = []
  for (const name of readdirSync(p.overlay)) {
    if (name === 'auth.json') continue
    const source = join(p.overlay, name),
      dest = join(p.canonical, name)
    const current = entry(source)
    if (current?.isSymbolicLink()) {
      if (readlinkSync(source) !== dest) throw new Error(`Overlay link conflict: ${name}`)
      continue
    }
    if (!current?.isFile() && !current?.isDirectory()) throw new Error(`Overlay conflict: ${name}`)
    const before = manifest.targets[name] ?? null,
      now = fileStamp(dest)
    if (JSON.stringify(before) !== JSON.stringify(now))
      throw new Error(`Overlay write conflict: ${name}`)
    if (database.test(name) && (now || !options.familiesStopped))
      throw new Error(`Detached SQLite state; stop families before repair: ${name}`)
    if (entry(p.canonical)?.dev !== current.dev)
      throw new Error('Overlay repair requires one filesystem')
    moves.push({ source, dest, name })
  }
  for (const move of moves) {
    renameSync(move.source, move.dest)
    syncDir(p.canonical)
    syncDir(p.overlay)
    symlinkSync(move.dest, move.source)
  }
  const targets: OverlayManifest['targets'] = {}
  for (const name of readdirSync(p.canonical)) {
    if (name === 'auth.json') continue
    sharedLink(p, name)
    targets[name] = fileStamp(join(p.canonical, name))
  }
  syncDir(p.overlay)
  return { targets }
}
