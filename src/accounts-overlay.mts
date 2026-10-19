import { randomBytes } from 'node:crypto'
import {
  linkSync,
  readdirSync,
  readlinkSync,
  renameSync,
  type Stats,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  canonicalDirectory,
  entry,
  privateDirectory,
  privateFile,
  syncDir,
} from './accounts-files.mjs'
import { loadAccounts } from './accounts-store.mjs'
import type { AccountPaths, AccountRegistry } from './accounts-types.mjs'

export interface FileStamp {
  dev: number
  ino: number
  size: number
  mtimeMs: number
}
export interface OverlayManifest {
  targets: Record<string, FileStamp | null>
}
export function fileStamp(path: string): FileStamp | null {
  try {
    const s = statSync(path)
    return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
function overlayConflict(p: AccountPaths, name: string): Error {
  return new Error(
    `Overlay conflict: ${name} exists separately in ${p.overlay} and ${p.canonical}; keep one copy before restarting`,
  )
}
export function sharedLink(p: AccountPaths, name: string): void {
  const source = join(p.canonical, name),
    dest = join(p.overlay, name)
  const s = entry(dest)
  if (s) {
    if (!s.isSymbolicLink() || readlinkSync(dest) !== source) throw overlayConflict(p, name)
  } else symlinkSync(source, dest)
}
// SQLite opens a linked database at its real path, so a shared database's
// -wal, -shm and -journal files live next to the canonical file, appearing and
// vanishing as connections open and close (2026-10-16: the official app-server
// created memories_1.sqlite-wal/-shm after the overlay was built). The overlay
// needs no link for them while the database itself is linked.
const SQLITE_SIDECAR = /^(.+\.(?:sqlite3?|db))-(?:wal|shm|journal)$/i
function linked(p: AccountPaths, name: string): boolean {
  const dest = join(p.overlay, name)
  return !!entry(dest)?.isSymbolicLink() && readlinkSync(dest) === join(p.canonical, name)
}
// The official app-server runs with CODEX_HOME at the overlay, so a top-level
// file a newer Codex introduces lands there as a real file (2026-10-19, the
// MacBook: external_agent_session_imports.json stopped every start at
// 'Unshared overlay entry'). When the canonical home has no entry of that name
// the file is adopted: hard-linked into the canonical home, which refuses to
// replace anything that appeared there meanwhile, then the overlay file is
// atomically swapped for the link back. An open writer keeps its inode, now the
// canonical one. Databases and their sidecars are never adopted while families
// may run: a live connection's -wal/-shm would stay detached in the overlay.
const DATABASE = /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i
const ADOPTING = /^\.anyengine-adopt-(\d+)-[0-9a-f]+$/
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
function sameFile(a: Stats | null, b: Stats | null): boolean {
  return !!a && !!b && a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino
}
function adoptOverlayFile(p: AccountPaths, name: string): void {
  const source = join(p.overlay, name),
    dest = join(p.canonical, name)
  const current = entry(source)
  if (!current?.isFile()) return
  let canonical = entry(dest)
  // A start interrupted after the hard link left one inode under both names.
  if (canonical && !sameFile(current, canonical)) throw overlayConflict(p, name)
  if (!canonical) {
    if (DATABASE.test(name))
      throw new Error(`Detached SQLite state; stop families before repair: ${name}`)
    if (current.uid !== process.getuid?.() || current.nlink !== 1)
      throw new Error(`Unsafe overlay entry: ${name}`)
    if (entry(p.canonical)?.dev !== current.dev)
      throw new Error('Overlay repair requires one filesystem')
    try {
      linkSync(source, dest)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    canonical = entry(dest)
    if (!sameFile(current, canonical)) throw overlayConflict(p, name)
    syncDir(p.canonical)
  }
  const swap = join(p.overlay, `.anyengine-adopt-${process.pid}-${randomBytes(4).toString('hex')}`)
  symlinkSync(dest, swap)
  try {
    // Another participant may have finished the same adoption first.
    if (linked(p, name)) return
    if (!sameFile(entry(source), canonical)) throw new Error(`Overlay write conflict: ${name}`)
    renameSync(swap, source)
  } finally {
    if (entry(swap)) unlinkSync(swap)
  }
  syncDir(p.overlay)
}
function adoptOverlay(p: AccountPaths): void {
  for (const name of readdirSync(p.overlay)) {
    if (name === 'auth.json') continue
    const pid = ADOPTING.exec(name)?.[1]
    if (pid) {
      if (entry(join(p.overlay, name))?.isSymbolicLink() && !alive(Number(pid)))
        unlinkSync(join(p.overlay, name))
      continue
    }
    adoptOverlayFile(p, name)
  }
}
export function verifyOverlay(p: AccountPaths, registry = loadAccounts(p)): string[] {
  const errors: string[] = []
  for (const name of new Set([...readdirSync(p.canonical), ...readdirSync(p.overlay)])) {
    if (name === 'auth.json') continue
    if (linked(p, name)) continue
    // Another participant's adoption in flight: a link into the canonical home.
    if (ADOPTING.test(name) && entry(join(p.overlay, name))?.isSymbolicLink()) continue
    const base = SQLITE_SIDECAR.exec(name)?.[1]
    if (base && !entry(join(p.overlay, name)) && linked(p, base)) continue
    errors.push(`Unshared overlay entry: ${name}`)
  }
  const auth = join(p.overlay, 'auth.json'),
    s = entry(auth)
  if (registry.active === registry.home) {
    if (!s?.isSymbolicLink() || readlinkSync(auth) !== join(p.canonical, 'auth.json'))
      errors.push('Overlay home auth link differs')
  } else {
    try {
      privateFile(auth)
    } catch {
      errors.push('Managed overlay credential is unsafe')
    }
    if (!s?.isFile()) errors.push('Managed overlay credential absent')
  }
  return errors
}
export function prepareOverlay(
  p: AccountPaths,
  registry: AccountRegistry = loadAccounts(p),
): OverlayManifest {
  if (entry(p.journal)) throw new Error('Account recovery required before overlay startup')
  canonicalDirectory(p.canonical)
  privateDirectory(p.overlay)
  adoptOverlay(p)
  const targets: OverlayManifest['targets'] = {}
  for (const name of readdirSync(p.canonical)) {
    if (name === 'auth.json') continue
    targets[name] = fileStamp(join(p.canonical, name))
    sharedLink(p, name)
  }
  const auth = join(p.overlay, 'auth.json')
  if (!entry(auth)) {
    if (registry.active !== registry.home) throw new Error('Managed active credential absent')
    symlinkSync(join(p.canonical, 'auth.json'), auth)
  }
  const errors = verifyOverlay(p, registry)
  if (errors.length) throw new Error(errors.join('; '))
  syncDir(p.overlay)
  return { targets }
}
