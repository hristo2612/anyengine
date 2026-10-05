import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { AccountMetadata } from '../src/accounts-metadata.mjs'
import {
  accountPaths,
  initialAccounts,
  initializeAccounts,
  loadAccounts,
  validateAccounts,
} from '../src/accounts-store.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(killChildren)
after(removeTempDirs)
async function fixture() {
  const base = await tempDir('accounts-store-')
  const paths = accountPaths(join(base, 'engine'), join(base, 'canonical'))
  mkdirSync(paths.canonical, { mode: 0o700 })
  return paths
}
test('registry rejects credentials, unsafe IDs and duplicate vendor identities', async () => {
  const r = initialAccounts(await fixture())
  assert.throws(() => validateAccounts({ ...r, authToken: 'FAKE_TOKEN' }), /Unknown/)
  assert.throws(
    () => validateAccounts({ ...r, accounts: [{ ...r.accounts[0], id: '../b' }] }),
    /Invalid/,
  )
  assert.throws(
    () =>
      validateAccounts({
        ...r,
        accounts: [
          { ...r.accounts[0], vendorAccountId: 'fake-account' },
          { ...r.accounts[0], id: 'b', kind: 'managed', vendorAccountId: 'fake-account' },
        ],
      }),
    /Duplicate/,
  )
  assert.equal(r.accounts[0]?.login, 'needs-login')
  assert.equal(r.rotation.enabled, false)
  assert.equal(r.replay, 'none')
})
test('metadata remains authoritative after reopen and preserves edited or corrupt projections', async () => {
  const p = await fixture()
  initializeAccounts(p)
  const metadata = new AccountMetadata(p)
  metadata.editRegistry((r) => ({ ...r, rotation: { ...r.rotation, enabled: true } }))
  metadata.close()
  assert.equal(loadAccounts(p).rotation.enabled, true)
  assert.equal(JSON.parse(readFileSync(p.registry, 'utf8')).rotation.enabled, true)
  writeFileSync(p.registry, '{corrupt')
  assert.throws(() => loadAccounts(p), SyntaxError)
  assert.equal(readFileSync(p.registry, 'utf8'), '{corrupt')
})
test('read-only metadata inspection never creates a missing registry or database', async () => {
  const p = await fixture()
  assert.throws(() => new AccountMetadata(p, { readOnly: true }))
  assert.equal(existsSync(p.root), false)
})
test('linked metadata directories are rejected before creation through them', async () => {
  const p = await fixture()
  symlinkSync(p.canonical, p.root)
  assert.throws(() => initializeAccounts(p), /Linked/)
  assert.equal(existsSync(join(p.canonical, 'accounts-state.sqlite')), false)
})
const worker = resolve('test/fixtures/accounts-metadata-worker.mjs')
async function start(p: Awaited<ReturnType<typeof fixture>>, kind: string) {
  const child = spawn(process.execPath, [worker, p.root, p.canonical, kind], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  await once(child, 'message')
  return child
}
test('independent concurrent registry edits both survive projection and reopen', async () => {
  const p = await fixture()
  initializeAccounts(p)
  const children = await Promise.all([start(p, 'label'), start(p, 'rotation')])
  const closed = children.map((child) => once(child, 'close'))
  for (const child of children) child.send('go')
  for (const result of await Promise.all(closed)) assert.equal(result[0], 0)
  const r = loadAccounts(p)
  assert.equal(r.accounts[0]?.label, 'Updated')
  assert.equal(r.rotation.enabled, true)
})
test('killed writer after SQL commit before projection is visible and repairable', async () => {
  const p = await fixture()
  initializeAccounts(p)
  const child = await start(p, 'kill')
  const committed = once(child, 'message')
  child.send('go')
  await committed
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  await closed
  assert.equal(JSON.parse(readFileSync(p.registry, 'utf8')).rotation.enabled, false)
  assert.equal(loadAccounts(p).rotation.enabled, true)
})
