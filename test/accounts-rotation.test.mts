import assert from 'node:assert/strict'
import { lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { AccountLedger } from '../src/accounts-ledger.mjs'
import { AccountParticipant } from '../src/accounts-participant.mjs'
import { rotateAccount } from '../src/accounts-rotation.mjs'
import { CodexUpstream } from '../src/codex-upstream.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
test('global switch drains overlapping desktop and translator work, joins both families and restarts on one generation', {
  timeout: 30_000,
}, async () => {
  const p = await accountFixture(),
    ledger = new AccountLedger(p)
  const home = lstatSync(join(p.canonical, 'auth.json'))
  const clients = ['adapter', 'broker'].map((kind) => {
    const participant = new AccountParticipant(p, kind as 'adapter' | 'broker')
    const upstream = new CodexUpstream({
      binary: resolve('test/fixtures/fake-codex-app-server.mjs'),
      args: ['app-server'],
      env: {
        ...process.env,
        CODEX_HOME: p.overlay,
        ANYENGINE_AUTO_RESERVE: '0',
        FAKE_CODEX_STATE_FILE: join(p.root, `${kind}-state.json`),
      },
      processLifecycle: participant.lifecycle,
      onMessage: () => {},
    })
    participant.setHooks({
      stop: () => upstream.stop(),
      restart: () => upstream.restartForAccounts(),
    })
    return { participant, upstream }
  })
  try {
    for (const c of clients) {
      await c.participant.ready
      c.upstream.start()
      await c.upstream.initialize({ clientInfo: { name: 'fixture', version: '1' } })
      c.upstream.markInitialized()
    }
    const old = ledger.holders().map((f) => f.native?.pid)
    const desktop = clients[0]?.participant.begin(),
      translator = clients[1]?.participant.begin()
    assert.ok(desktop && translator)
    const switching = rotateAccount(ledger, 'b', 'manual')
    assert.equal(ledger.state().phase, 'draining')
    assert.throws(() => clients[0]?.participant.begin(), /frozen/)
    assert.throws(() => new AccountParticipant(p, 'adapter'), /recovery required/)
    await desktop.release()
    await new Promise((done) => setTimeout(done, 80))
    assert.equal(ledger.state().active, 'home')
    assert.equal(ledger.holders().length, 2)
    await translator.release()
    await switching
    assert.equal(ledger.state().phase, 'open')
    assert.equal(ledger.state().active, 'b')
    assert.equal(ledger.state().generation, 1)
    assert.equal(readFileSync(join(p.overlay, 'auth.json'), 'utf8'), 'FAKE_B')
    assert.equal(lstatSync(join(p.canonical, 'auth.json')).ino, home.ino)
    assert.equal(ledger.holders().length, 2)
    assert.ok(
      ledger
        .holders()
        .every((f) => f.account === 'b' && f.generation === 1 && !old.includes(f.native?.pid)),
    )
    for (const c of clients)
      assert.ok(await c.upstream.request('thread/start', { model: 'gpt-test', ephemeral: true }))
    await rotateAccount(ledger, 'home', 'off')
    assert.ok(lstatSync(join(p.overlay, 'auth.json')).isSymbolicLink())
    assert.equal(readFileSync(join(p.root, 'accounts/openai/b/auth.json'), 'utf8'), 'FAKE_B')
  } finally {
    for (const c of clients) {
      await c.upstream.stop()
      await c.participant.close()
    }
    ledger.close()
  }
})
