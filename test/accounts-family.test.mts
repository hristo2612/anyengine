import assert from 'node:assert/strict'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { createAccountFamily } from '../src/accounts-family.mjs'
import { AccountLedger } from '../src/accounts-ledger.mjs'
import { familyAlive, identifyProcess } from '../src/accounts-processes.mjs'
import type { Participant } from '../src/accounts-types.mjs'
import { CodexUpstream } from '../src/codex-upstream.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
async function fixture() {
  const p = await accountFixture(),
    ledger = new AccountLedger(p)
  const identity = identifyProcess(process.pid)
  assert.ok(identity)
  const participant: Participant = {
    id: 'owner',
    kind: 'adapter',
    process: identity,
    socket: '',
    generation: 0,
  }
  ledger.register(participant)
  return { p, ledger, participant, lifecycle: createAccountFamily(ledger, participant) }
}
test('managed official protocol stays usable and its credential family is joined before release', async () => {
  const { p, ledger, lifecycle } = await fixture()
  const observed: string[] = []
  const upstream = new CodexUpstream({
    binary: resolve('test/fixtures/fake-codex-app-server.mjs'),
    args: ['app-server'],
    env: {
      ...process.env,
      CODEX_HOME: p.overlay,
      ANYENGINE_AUTO_RESERVE: '0',
      FAKE_CODEX_NO_APPROVAL: '1',
      FAKE_CODEX_STATE_FILE: join(p.root, 'fake-state.json'),
    },
    onMessage: () => {},
    onRawMessage: (method) => {
      observed.push(method)
    },
    processLifecycle: lifecycle,
  })
  try {
    upstream.start()
    await upstream.initialize({ clientInfo: { name: 'fixture', version: '1' } })
    upstream.markInitialized()
    const response = await upstream.request('thread/start', { model: 'gpt-test', ephemeral: true })
    assert.ok(response)
    assert.ok(observed.includes('thread/start'))
    assert.equal(ledger.holders().length, 1)
    assert.equal(ledger.holders()[0]?.native?.pid, upstream.pid)
  } finally {
    await upstream.stop()
    ledger.close()
  }
})
test('supervisor loses parent IPC and joins the native group without releasing it early', {
  timeout: 20_000,
}, async () => {
  const { ledger, lifecycle } = await fixture()
  const child = await lifecycle.spawn(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    process.env,
  )
  try {
    const holder = ledger.holders()[0]
    assert.ok(holder?.native)
    child.stdout?.resume()
    assert.equal(familyAlive(holder.native), 'alive')
    const exited = once(child, 'exit')
    child.disconnect()
    await exited
    assert.equal(ledger.holders().length, 1)
    await lifecycle.stop(child)
    assert.equal(ledger.holders().length, 0)
    assert.equal(familyAlive(holder.native), 'dead')
  } finally {
    await lifecycle.stopAll()
    ledger.close()
  }
})
