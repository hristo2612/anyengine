import assert from 'node:assert/strict'
import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { after } from 'node:test'
import { prepareOverlay, verifyOverlay } from '../src/accounts-overlay.mjs'
import { reconcileOverlay } from '../src/accounts-overlay-reconcile.mjs'
import { accountPaths, initializeAccounts, loadAccounts } from '../src/accounts-store.mjs'
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

// 2026-10-19, the MacBook: Codex's external-session import wrote
// external_agent_session_imports.json into the overlay (its CODEX_HOME), and the
// next ChatGPT launch died at 'Unshared overlay entry'.
test('startup adopts a new overlay file into the canonical home and links it back', async () => {
  const p = await fixture()
  prepareOverlay(p)
  const name = 'external_agent_session_imports.json',
    overlay = join(p.overlay, name),
    canonical = join(p.canonical, name)
  writeFileSync(overlay, '{"a":1}', { mode: 0o644 })
  const writer = openSync(overlay, 'r+')
  try {
    const manifest = prepareOverlay(p)
    assert.equal(readlinkSync(overlay), canonical)
    assert.ok(lstatSync(canonical).isFile())
    assert.equal(lstatSync(canonical).nlink, 1)
    assert.equal(lstatSync(canonical).mode & 0o777, 0o644)
    assert.deepEqual(manifest.targets[name], {
      dev: statSync(canonical).dev,
      ino: statSync(canonical).ino,
      size: 7,
      mtimeMs: statSync(canonical).mtimeMs,
    })
    // A writer that held the overlay file open now writes the canonical one.
    writeSync(writer, '{"a":2}', 0)
  } finally {
    closeSync(writer)
  }
  assert.equal(readFileSync(canonical, 'utf8'), '{"a":2}')
  assert.equal(readlinkSync(join(p.overlay, 'auth.json')), join(p.canonical, 'auth.json'))
  assert.equal(readFileSync(join(p.canonical, 'auth.json'), 'utf8'), 'FAKE_HOME')
  assert.ok(!readdirSync(p.overlay).some((n) => n.startsWith('.anyengine-adopt-')))
  assert.deepEqual(verifyOverlay(p), [])
})

test('an overlay file whose name the canonical home also holds still fails closed', async () => {
  const p = await fixture()
  prepareOverlay(p)
  writeFileSync(join(p.canonical, 'later.json'), 'canonical')
  writeFileSync(join(p.overlay, 'later.json'), 'overlay')
  assert.throws(
    () => prepareOverlay(p),
    /Overlay conflict: later\.json exists separately in .+ and .+; keep one copy before restarting/,
  )
  assert.equal(readFileSync(join(p.canonical, 'later.json'), 'utf8'), 'canonical')
  assert.equal(readFileSync(join(p.overlay, 'later.json'), 'utf8'), 'overlay')
  // An atomically replaced shared file is the same conflict.
  unlinkSync(join(p.overlay, 'config.toml'))
  writeFileSync(join(p.overlay, 'config.toml'), 'overlay edit\n')
  unlinkSync(join(p.overlay, 'later.json'))
  assert.throws(() => prepareOverlay(p), /Overlay conflict: config\.toml exists separately/)
  assert.equal(readFileSync(join(p.canonical, 'config.toml'), 'utf8'), 'old\n')
  assert.equal(readFileSync(join(p.overlay, 'config.toml'), 'utf8'), 'overlay edit\n')
})

test('a start interrupted after the hard link finishes the adoption', async () => {
  const p = await fixture()
  prepareOverlay(p)
  writeFileSync(join(p.overlay, 'imports.json'), 'kept')
  linkSync(join(p.overlay, 'imports.json'), join(p.canonical, 'imports.json'))
  // The interrupted start's swap link, left by a process that no longer runs.
  const stale = join(p.overlay, '.anyengine-adopt-99999999-0a1b2c3d')
  symlinkSync(join(p.canonical, 'imports.json'), stale)
  prepareOverlay(p)
  assert.equal(readlinkSync(join(p.overlay, 'imports.json')), join(p.canonical, 'imports.json'))
  assert.equal(lstatSync(join(p.canonical, 'imports.json')).nlink, 1)
  assert.equal(readFileSync(join(p.canonical, 'imports.json'), 'utf8'), 'kept')
  assert.ok(!readdirSync(p.overlay).some((n) => n.startsWith('.anyengine-adopt-')))
  assert.deepEqual(verifyOverlay(p), [])
})

test('startup never adopts overlay databases or their sidecars', async () => {
  const p = await fixture()
  writeFileSync(join(p.canonical, 'kept.sqlite'), '')
  writeFileSync(join(p.canonical, 'kept.sqlite-wal'), 'canonical wal')
  prepareOverlay(p)
  // A detached sidecar of a shared database conflicts with its canonical one.
  unlinkSync(join(p.overlay, 'kept.sqlite-wal'))
  writeFileSync(join(p.overlay, 'kept.sqlite-wal'), 'detached')
  assert.throws(() => prepareOverlay(p), /Overlay conflict: kept\.sqlite-wal/)
  assert.equal(readFileSync(join(p.canonical, 'kept.sqlite-wal'), 'utf8'), 'canonical wal')
  unlinkSync(join(p.overlay, 'kept.sqlite-wal'))
  symlinkSync(join(p.canonical, 'kept.sqlite-wal'), join(p.overlay, 'kept.sqlite-wal'))
  // A database, or a sidecar, only the overlay holds stays where it is.
  for (const name of ['new.sqlite', 'new.db-journal', 'orphan.sqlite-shm']) {
    writeFileSync(join(p.overlay, name), 'FAKE_DATABASE')
    assert.throws(
      () => prepareOverlay(p),
      new RegExp(`Detached SQLite state; stop families before repair: ${name.replace('.', '\\.')}`),
    )
    assert.ok(lstatSync(join(p.overlay, name)).isFile())
    assert.equal(lstatSync(join(p.canonical, name), { throwIfNoEntry: false }), undefined)
    unlinkSync(join(p.overlay, name))
  }
  // Canonical-only sidecars of a linked database still need no link.
  writeFileSync(join(p.canonical, 'kept.sqlite-shm'), '')
  assert.deepEqual(verifyOverlay(p), [])
})

test('adoption leaves overlay credentials to the account rules', async () => {
  const p = await fixture()
  prepareOverlay(p)
  const managed = { ...loadAccounts(p), active: 'managed-fixture' }
  unlinkSync(join(p.overlay, 'auth.json'))
  writeFileSync(join(p.overlay, 'auth.json'), 'FAKE_MANAGED', { mode: 0o600 })
  writeFileSync(join(p.overlay, 'imports.json'), '{}')
  prepareOverlay(p, managed)
  assert.ok(lstatSync(join(p.overlay, 'auth.json')).isFile())
  assert.equal(readFileSync(join(p.overlay, 'auth.json'), 'utf8'), 'FAKE_MANAGED')
  assert.equal(readFileSync(join(p.canonical, 'auth.json'), 'utf8'), 'FAKE_HOME')
  assert.equal(readlinkSync(join(p.overlay, 'imports.json')), join(p.canonical, 'imports.json'))
  // With the home account active, a real overlay credential is never adopted.
  assert.throws(() => prepareOverlay(p), /Overlay home auth link differs/)
  assert.equal(readFileSync(join(p.canonical, 'auth.json'), 'utf8'), 'FAKE_HOME')
  assert.equal(readFileSync(join(p.overlay, 'auth.json'), 'utf8'), 'FAKE_MANAGED')
})
