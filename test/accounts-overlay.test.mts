import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { prepareOverlay, verifyOverlay } from '../src/accounts-overlay.mjs'
import { reconcileOverlay } from '../src/accounts-overlay-reconcile.mjs'
import { accountPaths, initializeAccounts } from '../src/accounts-store.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
async function fixture() {
  const base = await tempDir('accounts-overlay-')
  const p = accountPaths(join(base, 'engine'), join(base, 'canonical'))
  mkdirSync(p.canonical, { mode: 0o700 })
  mkdirSync(join(p.canonical, 'sessions'))
  writeFileSync(join(p.canonical, 'auth.json'), 'FAKE_HOME', { mode: 0o600 })
  writeFileSync(join(p.canonical, 'config.toml'), 'old\n')
  initializeAccounts(p)
  return p
}
test('overlay shares state, follows canonical-only sidecars and preserves home auth', async () => {
  const p = await fixture()
  chmodSync(p.canonical, 0o755)
  const manifest = prepareOverlay(p)
  assert.equal(readlinkSync(join(p.overlay, 'auth.json')), join(p.canonical, 'auth.json'))
  assert.equal(
    statSync(join(p.overlay, 'config.toml')).ino,
    statSync(join(p.canonical, 'config.toml')).ino,
  )
  writeFileSync(join(p.canonical, 'state.sqlite-wal'), 'FAKE_SIDECAR')
  reconcileOverlay(p, manifest)
  assert.deepEqual(verifyOverlay(p), [])
  assert.equal(
    statSync(join(p.overlay, 'state.sqlite-wal')).ino,
    statSync(join(p.canonical, 'state.sqlite-wal')).ino,
  )
  assert.equal(statSync(p.canonical).mode & 0o777, 0o755)
  chmodSync(p.canonical, 0o775)
  assert.throws(() => prepareOverlay(p), /Unsafe account directory/)
})
test('atomic config replacement reaches canonical state only when its original is unchanged', async () => {
  const p = await fixture(),
    manifest = prepareOverlay(p)
  unlinkSync(join(p.overlay, 'config.toml'))
  writeFileSync(join(p.overlay, 'config.toml'), 'overlay edit\n')
  reconcileOverlay(p, manifest)
  assert.equal(readFileSync(join(p.canonical, 'config.toml'), 'utf8'), 'overlay edit\n')
  assert.deepEqual(verifyOverlay(p), [])
})
test('conflicting edits preserve both files and detached SQLite never replaces shared state', async () => {
  const p = await fixture(),
    manifest = prepareOverlay(p)
  unlinkSync(join(p.overlay, 'config.toml'))
  writeFileSync(join(p.overlay, 'config.toml'), 'overlay edit\n')
  writeFileSync(join(p.canonical, 'config.toml'), 'outside edit\n')
  assert.throws(() => reconcileOverlay(p, manifest), /conflict/)
  assert.equal(readFileSync(join(p.canonical, 'config.toml'), 'utf8'), 'outside edit\n')
  assert.equal(readFileSync(join(p.overlay, 'config.toml'), 'utf8'), 'overlay edit\n')
  const clean = await fixture(),
    m = prepareOverlay(clean)
  writeFileSync(join(clean.overlay, 'new.sqlite'), 'FAKE_DATABASE')
  assert.throws(() => reconcileOverlay(clean, m), /stop families/)
  reconcileOverlay(clean, m, { familiesStopped: true })
  assert.deepEqual(verifyOverlay(clean), [])
})
