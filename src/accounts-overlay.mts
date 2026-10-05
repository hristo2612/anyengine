import { readdirSync, readlinkSync, statSync, symlinkSync } from 'node:fs'
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
export function sharedLink(p: AccountPaths, name: string): void {
  const source = join(p.canonical, name),
    dest = join(p.overlay, name)
  const s = entry(dest)
  if (s) {
    if (!s.isSymbolicLink() || readlinkSync(dest) !== source)
      throw new Error(`Overlay conflict: ${name}`)
  } else symlinkSync(source, dest)
}
export function verifyOverlay(p: AccountPaths, registry = loadAccounts(p)): string[] {
  const errors: string[] = []
  for (const name of new Set([...readdirSync(p.canonical), ...readdirSync(p.overlay)])) {
    if (name === 'auth.json') continue
    const dest = join(p.overlay, name)
    const s = entry(dest)
    if (!s?.isSymbolicLink() || readlinkSync(dest) !== join(p.canonical, name))
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
