import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

// 2026-10-16, the MacBook: ~/.codex held memories_1.sqlite with no sidecars
// while the overlay was built (state_5/logs_2/goals_1/queue_1 had theirs from
// earlier opens). The official app-server then opened it
// through the overlay link, SQLite put -wal/-shm next to the real file, and
// every on stopped at 'Unshared overlay entry: memories_1.sqlite-shm'.
test('a linked database opened through the overlay keeps its sidecars canonical, and that verifies', async () => {
  const p = await fixture()
  for (const db of ['state_5.sqlite', 'logs_2.sqlite', 'goals_1.sqlite', 'queue_1.sqlite']) {
    writeFileSync(join(p.canonical, db), '')
    for (const suffix of ['-shm', '-wal']) writeFileSync(join(p.canonical, `${db}${suffix}`), '')
  }
  const memories = new DatabaseSync(join(p.canonical, 'memories_1.sqlite'))
  memories.exec('CREATE TABLE m (v TEXT); INSERT INTO m VALUES (1)')
  memories.close()
  prepareOverlay(p)
  // What the official app-server does: open the overlay path, WAL, write, stay open.
  const viaOverlay = new DatabaseSync(join(p.overlay, 'memories_1.sqlite'))
  try {
    viaOverlay.exec("PRAGMA journal_mode=WAL; INSERT INTO m VALUES ('from overlay')")
    const canonical = readdirSync(p.canonical).filter((name) => name.startsWith('memories_1'))
    assert.deepEqual(canonical.sort(), [
      'memories_1.sqlite',
      'memories_1.sqlite-shm',
      'memories_1.sqlite-wal',
    ])
    assert.ok(
      !readdirSync(p.overlay).some((name) => /^memories_1\.sqlite-/.test(name)),
      'SQLite resolved the link: no sidecar in the overlay',
    )
    assert.deepEqual(verifyOverlay(p), [])
  } finally {
    viaOverlay.close()
  }
  // Both homes read the same rows: nothing was detached.
  const reread = new DatabaseSync(join(p.canonical, 'memories_1.sqlite'), { readOnly: true })
  assert.equal(reread.prepare('SELECT COUNT(*) AS n FROM m').get()?.n, 2)
  reread.close()
})

test('only a linked database excuses a missing sidecar link', async () => {
  const p = await fixture()
  prepareOverlay(p)
  // A sidecar written into the overlay as a real file and a new non-database
  // entry stay unshared; so does a sidecar whose database is not shared.
  writeFileSync(join(p.canonical, 'kept.sqlite'), '')
  prepareOverlay(p)
  writeFileSync(join(p.canonical, 'kept.sqlite-wal'), '')
  writeFileSync(join(p.overlay, 'kept.sqlite-wal'), 'detached')
  writeFileSync(join(p.canonical, 'later.json'), '{}')
  assert.deepEqual(verifyOverlay(p).sort(), [
    'Unshared overlay entry: kept.sqlite-wal',
    'Unshared overlay entry: later.json',
  ])
  unlinkSync(join(p.overlay, 'kept.sqlite-wal'))
  unlinkSync(join(p.canonical, 'later.json'))
  writeFileSync(join(p.canonical, 'unshared.sqlite-shm'), '')
  assert.deepEqual(verifyOverlay(p), ['Unshared overlay entry: unshared.sqlite-shm'])
})
