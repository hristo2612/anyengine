import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareOverlay } from '../../src/accounts-overlay.mjs'
import {
  accountHome,
  accountPaths,
  initialAccounts,
  initializeAccounts,
} from '../../src/accounts-store.mjs'
import { tempDir } from './tmp.mjs'
export async function accountFixture() {
  const root = await tempDir('accounts-transition-')
  const p = accountPaths(join(root, 'engine'), join(root, 'canonical'))
  mkdirSync(p.canonical, { mode: 0o700 })
  writeFileSync(join(p.canonical, 'auth.json'), 'FAKE_HOME', { mode: 0o600 })
  const registry = initialAccounts(p)
  for (const id of ['b', 'c']) {
    const dir = accountHome(p, id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'auth.json'), `FAKE_${id.toUpperCase()}`, { mode: 0o600 })
    registry.accounts.push({
      id,
      label: id.toUpperCase(),
      kind: 'managed',
      vendorAccountId: null,
      email: null,
      planType: null,
      login: 'ready',
    })
  }
  initializeAccounts(p, registry)
  prepareOverlay(p)
  return p
}
