import assert from 'node:assert/strict'
import { lstatSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import {
  bootstrapAccounts,
  officialCodexVersion,
  requireAccountBootstrap,
} from '../src/accounts-bootstrap.mjs'
import { recoverAccounts } from '../src/accounts-journal.mjs'
import { AccountLedger } from '../src/accounts-ledger.mjs'
import { AccountParticipant } from '../src/accounts-participant.mjs'
import { accountOwner, rotateAccount } from '../src/accounts-rotation.mjs'
import { CodexUpstream } from '../src/codex-upstream.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
const binary = resolve('test/fixtures/fake-account-continuity.mjs')
for (const existing of [false, true]) {
  test(`canonical warmup shares state and spends no model turn (${existing ? 'existing participant' : 'first install'})`, async () => {
    const paths = await accountFixture()
    const runtime = existing ? new AccountParticipant(paths, 'adapter') : null
    await runtime?.ready
    const ledger = runtime?.ledger ?? new AccountLedger(paths)
    const env = {
      ...process.env,
      FAKE_ACCOUNT_STATE_PATH: join(paths.root, 'fake-state.json'),
      FAKE_ACCOUNT_BOOTSTRAP: '1',
    }
    const upstream = runtime
      ? new CodexUpstream({
          binary,
          args: ['app-server'],
          env,
          reserveEnabled: false,
          processLifecycle: runtime.lifecycle,
          onMessage() {},
        })
      : null
    runtime?.setHooks({
      stop: async () => {
        await upstream?.stop()
      },
      restart: async () => {
        await upstream?.restartForAccounts()
      },
    })
    const before = lstatSync(join(paths.canonical, 'auth.json'))
    try {
      if (upstream) {
        upstream.start()
        await upstream.initialize({ clientInfo: { name: 'test', version: '1' } })
        upstream.markInitialized()
      }
      assert.throws(() => requireAccountBootstrap(ledger, '0.160.0'), /bootstrap/)
      const version = officialCodexVersion(binary, env)
      assert.equal(version, '0.160.0')
      await bootstrapAccounts(ledger, { binary, version, env })
      requireAccountBootstrap(ledger, version)
      assert.equal(ledger.state().phase, 'open')
      assert.equal(ledger.state().generation, 0)
      assert.equal(ledger.state().active, 'home')
      assert.equal(
        readlinkSync(join(paths.overlay, 'state_1.sqlite')),
        join(paths.canonical, 'state_1.sqlite'),
      )
      const after = lstatSync(join(paths.canonical, 'auth.json'))
      assert.equal(after.ino, before.ino)
      assert.equal(after.dev, before.dev)
      assert.equal(lstatSync(join(paths.overlay, 'auth.json')).isSymbolicLink(), true)
      const state = JSON.parse(await readFile(env.FAKE_ACCOUNT_STATE_PATH, 'utf8'))
      assert.equal(state.requests.filter((r: any) => r.method === 'turn/start').length, 0)
      assert.equal(state.requests.filter((r: any) => r.method === 'thread/archive').length, 1)
      const count = state.requests.length
      const hooks = join(paths.canonical, 'hooks.json')
      writeFileSync(hooks, '{"hooks":{}}\n', { mode: 0o600 })
      const hookBefore = lstatSync(hooks)
      await bootstrapAccounts(ledger, { binary, version, env })
      assert.equal(readlinkSync(join(paths.overlay, 'hooks.json')), hooks)
      assert.equal(readFileSync(hooks, 'utf8'), '{"hooks":{}}\n')
      assert.equal(lstatSync(hooks).ino, hookBefore.ino)
      assert.equal(lstatSync(join(paths.canonical, 'auth.json')).ino, before.ino)
      assert.equal(
        JSON.parse(await readFile(env.FAKE_ACCOUNT_STATE_PATH, 'utf8')).requests.length,
        count,
      )
      assert.throws(() => requireAccountBootstrap(ledger, '0.161.0'), /bootstrap/)
    } finally {
      await upstream?.stop()
      if (runtime) await runtime.close()
      else ledger.close()
    }
  })
}
test('interrupted bootstrap opens only after joined families and credential layout verification', async () => {
  const ledger = new AccountLedger(await accountFixture()),
    owner = accountOwner()
  try {
    ledger.freeze(owner, 'home', 'bootstrap')
    ledger.phase(owner, 'draining', 'stopped')
    ledger.phase(owner, 'stopped', 'bootstrap')
    recoverAccounts(ledger, owner)
    assert.equal(ledger.state().phase, 'open')
    assert.equal(ledger.state().generation, 0)
  } finally {
    ledger.close()
  }
})

for (const conflict of ['canonical-copy', 'foreign-link']) {
  test(`completed bootstrap preserves and refuses ${conflict} overlay conflicts`, async () => {
    const paths = await accountFixture()
    const ledger = new AccountLedger(paths)
    const canonical = join(paths.canonical, 'hooks.json')
    const overlay = join(paths.overlay, 'hooks.json')
    const auth = lstatSync(join(paths.canonical, 'auth.json'))
    try {
      ledger.metadata.db.exec(
        "CREATE TABLE account_bootstrap(version TEXT PRIMARY KEY,completed INTEGER NOT NULL); INSERT INTO account_bootstrap VALUES('0.160.0',1)",
      )
      if (conflict !== 'overlay-only') writeFileSync(canonical, 'native hooks', { mode: 0o600 })
      if (conflict === 'foreign-link') symlinkSync(join(paths.root, 'foreign.json'), overlay)
      else writeFileSync(overlay, 'independent hooks', { mode: 0o600 })
      await assert.rejects(
        bootstrapAccounts(ledger, { binary: '/must-not-spawn', version: '0.160.0', env: {} }),
        /Overlay conflict|Unshared overlay entry/,
      )
      if (conflict === 'foreign-link') {
        assert.equal(readlinkSync(overlay), join(paths.root, 'foreign.json'))
      } else assert.equal(readFileSync(overlay, 'utf8'), 'independent hooks')
      if (conflict !== 'overlay-only') assert.equal(readFileSync(canonical, 'utf8'), 'native hooks')
      assert.equal(lstatSync(join(paths.canonical, 'auth.json')).ino, auth.ino)
      assert.equal(
        readlinkSync(join(paths.overlay, 'auth.json')),
        join(paths.canonical, 'auth.json'),
      )
      assert.equal(ledger.state().phase, 'open')
    } finally {
      ledger.close()
    }
  })
}

// A file only the overlay holds is new Codex state, adopted rather than refused.
test('completed bootstrap adopts overlay-only state into the canonical home', async () => {
  const paths = await accountFixture()
  const ledger = new AccountLedger(paths)
  const canonical = join(paths.canonical, 'hooks.json')
  const overlay = join(paths.overlay, 'hooks.json')
  const auth = lstatSync(join(paths.canonical, 'auth.json'))
  try {
    ledger.metadata.db.exec(
      "CREATE TABLE account_bootstrap(version TEXT PRIMARY KEY,completed INTEGER NOT NULL); INSERT INTO account_bootstrap VALUES('0.160.0',1)",
    )
    writeFileSync(overlay, 'independent hooks', { mode: 0o600 })
    await bootstrapAccounts(ledger, { binary: '/must-not-spawn', version: '0.160.0', env: {} })
    assert.equal(readlinkSync(overlay), canonical)
    assert.equal(readFileSync(canonical, 'utf8'), 'independent hooks')
    assert.equal(lstatSync(join(paths.canonical, 'auth.json')).ino, auth.ino)
    assert.equal(readlinkSync(join(paths.overlay, 'auth.json')), join(paths.canonical, 'auth.json'))
    assert.equal(ledger.state().phase, 'open')
  } finally {
    ledger.close()
  }
})

test('completed bootstrap adds native hooks without changing the active managed account', async () => {
  const paths = await accountFixture()
  const ledger = new AccountLedger(paths)
  try {
    await rotateAccount(ledger, 'b', 'manual')
    ledger.metadata.db.exec(
      "CREATE TABLE account_bootstrap(version TEXT PRIMARY KEY,completed INTEGER NOT NULL); INSERT INTO account_bootstrap VALUES('0.160.0',1)",
    )
    const before = lstatSync(join(paths.overlay, 'auth.json'))
    const state = ledger.state()
    writeFileSync(join(paths.canonical, 'hooks.json'), '{"hooks":{}}', { mode: 0o600 })
    await bootstrapAccounts(ledger, { binary: '/must-not-spawn', version: '0.160.0', env: {} })
    const after = lstatSync(join(paths.overlay, 'auth.json'))
    assert.ok(after.isFile())
    assert.equal(after.ino, before.ino)
    assert.equal(after.dev, before.dev)
    assert.equal(readFileSync(join(paths.overlay, 'auth.json'), 'utf8'), 'FAKE_B')
    assert.equal(ledger.state().active, state.active)
    assert.equal(ledger.state().generation, state.generation)
    assert.equal(
      readlinkSync(join(paths.overlay, 'hooks.json')),
      join(paths.canonical, 'hooks.json'),
    )
  } finally {
    ledger.close()
  }
})
