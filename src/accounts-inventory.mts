import { type CredentialStamp, credentialInventory } from './accounts-credentials.mjs'
import type { AuthOp } from './accounts-files.mjs'
import type { AccountPaths, AccountRegistry } from './accounts-types.mjs'

export interface SealedCredentials {
  inventory: CredentialStamp[]
  operations: AuthOp[]
}
function comparable(s: CredentialStamp): unknown {
  return s.kind === 'file' ? [s.path, s.kind, s.dev, s.ino] : [s.path, s.kind, s.target]
}
export function verifySealedInventory(
  p: AccountPaths,
  r: AccountRegistry,
  sealed: SealedCredentials,
  prefixes: number[],
): void {
  const actual = credentialInventory(p, r)
  if (
    !Array.isArray(sealed.inventory) ||
    sealed.inventory.length !== actual.length ||
    new Set(sealed.inventory.map((s) => s.path)).size !== actual.length ||
    !sealed.inventory.every((s) => actual.some((a) => a.path === s.path)) ||
    !Array.isArray(sealed.operations) ||
    sealed.operations.length > 2
  )
    throw new Error('Sealed credential inventory invalid')
  for (const count of prefixes) {
    if (!Number.isInteger(count) || count < 0 || count > sealed.operations.length) continue
    const expected = new Map(sealed.inventory.map((s) => [s.path, { ...s }]))
    for (const op of sealed.operations.slice(0, count)) {
      if (op.kind === 'move') {
        expected.set(op.from, { path: op.from, kind: 'absent', dev: null, ino: null, target: null })
        expected.set(op.to, { path: op.to, kind: 'file', dev: op.dev, ino: op.ino, target: null })
      } else
        expected.set(op.path, {
          path: op.path,
          kind: op.kind === 'link' ? 'home-link' : 'absent',
          dev: null,
          ino: null,
          target: op.kind === 'link' ? op.target : null,
        })
    }
    if (
      actual.every(
        (a) =>
          JSON.stringify(comparable(a)) ===
          JSON.stringify(comparable(expected.get(a.path) as CredentialStamp)),
      )
    )
      return
  }
  throw new Error('Credential inventory changed; admission remains closed')
}
