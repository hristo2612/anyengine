import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { verifyCredentialLayout } from '../src/accounts-credentials.mjs'
import { applyAuthOp } from '../src/accounts-files.mjs'
import {
  applyJournal,
  beginJournal,
  finishTransition,
  publishTransition,
  recoverAccounts,
  sealTransition,
} from '../src/accounts-journal.mjs'
import { AccountLedger } from '../src/accounts-ledger.mjs'
import { identifyProcess } from '../src/accounts-processes.mjs'
import { accountHome, loadAccounts } from '../src/accounts-store.mjs'
import type { OwnerToken } from '../src/accounts-types.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(killChildren)
after(removeTempDirs)
function owner(claim = 1): OwnerToken {
  const processIdentity = identifyProcess(process.pid)
  assert.ok(processIdentity)
  return { transaction: 'fixture-switch', claim, process: processIdentity }
}
function switchNow(ledger: AccountLedger, to: string) {
  const o = { ...owner(), transaction: randomUUID() }
  ledger.freeze(o, to, 'manual')
  ledger.phase(o, 'draining', 'stopped')
  const j = sealTransition(ledger, o)
  beginJournal(ledger, o, j)
  applyJournal(ledger, o, j)
  publishTransition(ledger, o, j)
  finishTransition(ledger, o)
}
const worker = resolve('test/fixtures/accounts-switch-worker.mjs')
function checkpoint(child: ChildProcess): Promise<{ checkpoint: string }> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    const output = (bytes: Buffer) => {
      stderr = (stderr + bytes.toString()).slice(-4096)
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('message', received)
      child.off('close', closed)
      child.off('error', failed)
      child.stderr?.off('data', output)
    }
    const failed = (error: Error) => {
      cleanup()
      reject(error)
    }
    const closed = () => failed(new Error(`Checkpoint worker exited before its message: ${stderr}`))
    const received = (message: unknown) => {
      cleanup()
      resolve(message as { checkpoint: string })
    }
    const timer = setTimeout(
      () => failed(new Error(`Checkpoint worker timed out: ${stderr}`)),
      10_000,
    )
    child.stderr?.on('data', output)
    child.once('message', received)
    child.once('close', closed)
    child.once('error', failed)
  })
}
async function killAt(p: Awaited<ReturnType<typeof accountFixture>>, point: string, to: string) {
  const child = spawn(process.execPath, [worker, p.root, p.canonical, point, to], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const message = await checkpoint(child)
  assert.equal(message.checkpoint, point)
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  await closed
}
for (const [from, to] of [
  ['home', 'c'],
  ['b', 'c'],
  ['b', 'home'],
] as const)
  for (const point of [
    'freeze',
    'sealed',
    'journal',
    'renamed-0',
    'recorded-1',
    'renamed-1',
    'recorded-2',
    'published',
    'finished',
  ]) {
    test(`recover killed ${from}→${to} switch at ${point} without duplicate credentials`, async () => {
      const p = await accountFixture(),
        original = lstatSync(join(p.canonical, 'auth.json'))
      let ledger = new AccountLedger(p)
      if (from === 'b') switchNow(ledger, 'b')
      ledger.close()
      const child = spawn(process.execPath, [worker, p.root, p.canonical, point, to], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
      const message = await checkpoint(child)
      assert.equal(message.checkpoint, point)
      const closed = once(child, 'close')
      child.kill('SIGKILL')
      await closed
      ledger = new AccountLedger(p)
      recoverAccounts(ledger, owner(2))
      recoverAccounts(ledger, owner(2))
      const r = ledger.registry()
      assert.equal(ledger.state().phase, 'open')
      assert.equal(ledger.state().active, r.active)
      assert.equal(ledger.state().generation, r.generation)
      assert.equal(r.active, ['published', 'finished'].includes(point) ? to : from)
      verifyCredentialLayout(p, r)
      assert.equal(existsSync(p.journal), false)
      assert.equal(lstatSync(join(p.canonical, 'auth.json')).ino, original.ino)
      assert.equal(lstatSync(join(p.canonical, 'auth.json')).mtimeMs, original.mtimeMs)
      const files = [
        join(p.canonical, 'auth.json'),
        join(p.overlay, 'auth.json'),
        join(accountHome(p, 'b'), 'auth.json'),
        join(accountHome(p, 'c'), 'auth.json'),
      ].filter((path) => existsSync(path) && lstatSync(path).isFile())
      assert.deepEqual(files.map((path) => readFileSync(path, 'utf8')).sort(), [
        'FAKE_B',
        'FAKE_C',
        'FAKE_HOME',
      ])
      assert.equal(readdirSync(p.overlay).filter((name) => name.startsWith('auth')).length, 1)
      ledger.close()
      assert.equal(loadAccounts(p).active, r.active)
    })
  }
for (const [from, to] of [
  ['home', 'c'],
  ['b', 'c'],
  ['b', 'home'],
] as const)
  for (const point of ['reversed-0', 'reverse-recorded--1', 'cleanup-unlinked'])
    test(`a second kill during ${from}→${to} recovery at ${point} remains recoverable`, async () => {
      const p = await accountFixture()
      let ledger = new AccountLedger(p)
      if (from === 'b') switchNow(ledger, 'b')
      ledger.close()
      await killAt(p, 'renamed-1', to)
      await killAt(p, point, 'recover')
      ledger = new AccountLedger(p)
      recoverAccounts(ledger, owner(3))
      recoverAccounts(ledger, owner(3))
      assert.equal(ledger.registry().active, from)
      assert.equal(ledger.state().phase, 'open')
      verifyCredentialLayout(p, ledger.registry())
      ledger.close()
    })
test('a kill after committed journal cleanup preserves the new generation', async () => {
  const p = await accountFixture()
  await killAt(p, 'cleanup-unlinked', 'c')
  const ledger = new AccountLedger(p)
  recoverAccounts(ledger, owner(2))
  assert.equal(ledger.registry().active, 'c')
  assert.equal(ledger.registry().generation, 1)
  assert.equal(ledger.state().phase, 'open')
  verifyCredentialLayout(p, ledger.registry())
  ledger.close()
})
test('missing move journal and substituted parked credential leave admission closed', async () => {
  const p = await accountFixture(),
    ledger = new AccountLedger(p),
    o = owner()
  ledger.freeze(o, 'c', 'manual')
  ledger.phase(o, 'draining', 'stopped')
  const j = sealTransition(ledger, o)
  beginJournal(ledger, o, j)
  unlinkSync(p.journal)
  assert.throws(() => recoverAccounts(ledger, o), /journal missing/)
  assert.equal(ledger.state().phase, 'journal')
  // Restore the same write-ahead record, then substitute an unrelated parked slot.
  writeFileSync(p.journal, JSON.stringify(j), { mode: 0o600 })
  const parked = join(accountHome(p, 'b'), 'auth.json')
  renameSync(parked, join(accountHome(p, 'b'), 'fixture-original'))
  writeFileSync(parked, 'FAKE_SUBSTITUTED', { mode: 0o600 })
  assert.throws(() => {
    applyJournal(ledger, o, j)
    publishTransition(ledger, o, j)
  }, /inventory changed/)
  assert.equal(ledger.registry().generation, 0)
  assert.equal(ledger.state().phase, 'journal')
  ledger.close()
})
test('credential moves refuse occupied targets and substituted links without mutation', async () => {
  const p = await accountFixture(),
    from = join(accountHome(p, 'b'), 'auth.json'),
    s = lstatSync(from)
  const occupied = join(accountHome(p, 'c'), 'auth.json')
  assert.throws(
    () => applyAuthOp({ kind: 'move', from, to: occupied, dev: s.dev, ino: s.ino }),
    /conflict/,
  )
  const link = join(p.overlay, 'foreign.json')
  symlinkSync(occupied, link)
  assert.throws(
    () => applyAuthOp({ kind: 'move', from, to: link, dev: s.dev, ino: s.ino }),
    /Unsafe/,
  )
  writeFileSync(from, 'FAKE_B_REFRESH')
  assert.equal(readFileSync(occupied, 'utf8'), 'FAKE_C')
})
