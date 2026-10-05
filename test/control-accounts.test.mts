import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import test, { after } from 'node:test'
import { AccountLedger } from '../src/accounts-ledger.mjs'
import { accountOwner } from '../src/accounts-rotation.mjs'
import { accountsCommand } from '../src/control-accounts.mjs'
import { takeFlipLock } from '../src/control-flip-lock.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
test('recovery dry-run is read-only and account mutations cannot cross an install lock', async () => {
  const paths = await accountFixture(),
    ledger = new AccountLedger(paths)
  const system = fakeSystem(paths.root)
  system.procs = [
    {
      pid: process.pid,
      ppid: 1,
      command: 'node fixture',
      processStart: '2026-10-01T00:00:00.000Z',
    },
  ]
  const before = readFileSync(paths.registry),
    inode = statSync(paths.ledger).ino
  const old = process.env.CODEX_HOME
  process.env.CODEX_HOME = paths.canonical
  let release: (() => void) | undefined
  try {
    const owner = accountOwner()
    ledger.freeze(owner, 'b', 'manual')
    const output: string[] = []
    assert.equal(
      await accountsCommand(['recover', '--dry-run'], system, paths.root, (s) => output.push(s)),
      0,
    )
    const dry = JSON.parse(output.join(''))
    assert.equal(dry.gate.phase, 'draining')
    assert.equal(dry.credentials.length, 4)
    assert.equal(output.join('').includes('FAKE_HOME'), false)
    assert.deepEqual(ledger.state().owner, owner)
    assert.deepEqual(readFileSync(paths.registry), before)
    assert.equal(statSync(paths.ledger).ino, inode)
    ledger.cancelDrain(owner, () => {})
    const lock = takeFlipLock(paths.root, system)
    assert.ok(lock.ok)
    release = lock.release
    assert.equal(await accountsCommand(['use', 'b'], system, paths.root, () => {}), 3)
    assert.equal(ledger.state().active, 'home')
  } finally {
    release?.()
    if (old === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = old
    ledger.close()
  }
})
