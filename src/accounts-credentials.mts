import { readlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type AuthOp,
  canonicalDirectory,
  entry,
  privateDirectory,
  privateFile,
} from './accounts-files.mjs'
import { accountHome } from './accounts-store.mjs'
import type { AccountPaths, AccountRegistry } from './accounts-types.mjs'

export interface CredentialStamp {
  path: string
  kind: 'file' | 'home-link' | 'absent'
  dev: number | null
  ino: number | null
  target: string | null
}
function stamp(path: string, homeTarget?: string, canonical = false): CredentialStamp {
  if (canonical) canonicalDirectory(dirname(path))
  else privateDirectory(dirname(path), false)
  const s = entry(path)
  if (!s) return { path, kind: 'absent', dev: null, ino: null, target: null }
  if (s.isSymbolicLink() && homeTarget && readlinkSync(path) === homeTarget)
    return { path, kind: 'home-link', dev: s.dev, ino: s.ino, target: homeTarget }
  privateFile(path)
  return { path, kind: 'file', dev: s.dev, ino: s.ino, target: null }
}
export function credentialInventory(p: AccountPaths, r: AccountRegistry): CredentialStamp[] {
  const home = join(p.canonical, 'auth.json'),
    overlay = join(p.overlay, 'auth.json')
  const values = [stamp(home, undefined, true), stamp(overlay, home)]
  for (const account of r.accounts) {
    if (account.kind === 'home') continue
    const dir = accountHome(p, account.id)
    if (entry(dir)) values.push(stamp(join(dir, 'auth.json')))
    else
      values.push({
        path: join(dir, 'auth.json'),
        kind: 'absent',
        dev: null,
        ino: null,
        target: null,
      })
  }
  const regular = values.filter((s) => s.kind === 'file')
  if (new Set(regular.map((s) => `${s.dev}:${s.ino}`)).size !== regular.length)
    throw new Error('Duplicate credential inode')
  return values
}
export function verifyCredentialLayout(p: AccountPaths, r: AccountRegistry): void {
  const inventory = credentialInventory(p, r)
  const at = (path: string) => inventory.find((s) => s.path === path)
  const overlay = at(join(p.overlay, 'auth.json'))
  if (
    r.accounts.find((a) => a.id === r.home)?.login === 'ready' &&
    at(join(p.canonical, 'auth.json'))?.kind !== 'file'
  )
    throw new Error('Canonical home credential missing')
  if (r.active === r.home ? overlay?.kind !== 'home-link' : overlay?.kind !== 'file')
    throw new Error('Active credential layout conflict')
  for (const a of r.accounts) {
    if (a.kind === 'home') continue
    const parked = at(join(accountHome(p, a.id), 'auth.json'))
    if (
      a.id === r.active ? parked?.kind !== 'absent' : a.login === 'ready' && parked?.kind !== 'file'
    )
      throw new Error(`Parked credential layout conflict: ${a.id}`)
  }
}
export function planAuthMoves(p: AccountPaths, r: AccountRegistry, to: string): AuthOp[] {
  verifyCredentialLayout(p, r)
  if (!r.accounts.some((a) => a.id === to)) throw new Error('Unknown target account')
  if (to === r.active) return []
  const overlay = join(p.overlay, 'auth.json'),
    home = join(p.canonical, 'auth.json')
  const move = (from: string, dest: string, vacated = false): AuthOp => {
    privateFile(from)
    const s = entry(from)
    if (!s?.isFile() || (!vacated && entry(dest)))
      throw new Error('Credential move destination occupied or source absent')
    return { kind: 'move', from, to: dest, dev: s.dev, ino: s.ino }
  }
  const outgoing: AuthOp =
    r.active === r.home
      ? { kind: 'unlink', path: overlay, target: home }
      : move(overlay, join(accountHome(p, r.active), 'auth.json'))
  const incoming: AuthOp =
    to === r.home
      ? { kind: 'link', path: overlay, target: home }
      : move(join(accountHome(p, to), 'auth.json'), overlay, true)
  // The outgoing operation vacates overlay; never use a temporary credential file.
  return [outgoing, incoming]
}
