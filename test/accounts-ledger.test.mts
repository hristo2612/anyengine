import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { AccountLedger } from '../src/accounts-ledger.mjs'
import { identifyProcess } from '../src/accounts-processes.mjs'
import type { OwnerToken, Participant } from '../src/accounts-types.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
test('global freeze drains existing work and rejects late work, participants and credential families', async () => {
  const p = await accountFixture(),
    ledger = new AccountLedger(p)
  const processIdentity = identifyProcess(process.pid)
  assert.ok(processIdentity)
  const participant: Participant = {
    id: 'app',
    kind: 'adapter',
    process: processIdentity,
    socket: '',
    generation: 0,
  }
  const owner: OwnerToken = { transaction: 'test', claim: 1, process: processIdentity }
  ledger.register(participant)
  const work = ledger.begin('app', 0)
  ledger.freeze(owner, 'b', 'manual')
  assert.equal(ledger.workCount(), 1)
  assert.throws(() => ledger.begin('app', 0), /frozen/)
  assert.throws(() => ledger.register({ ...participant, id: 'late' }), /frozen/)
  assert.throws(() => ledger.reserveProbe('c', Date.now()), /frozen/)
  assert.throws(() => ledger.adopt({ ...owner, claim: 2 }, owner), /Live or unknown/)
  ledger.metadata.editRegistry((r) => ({ ...r, rotation: { ...r.rotation, enabled: false } }))
  await work.release()
  await work.release()
  assert.equal(ledger.workCount(), 0)
  ledger.close()
  const reopened = new AccountLedger(p)
  assert.equal(reopened.state().phase, 'draining')
  assert.throws(() => reopened.begin('app', 0), /frozen/)
  reopened.close()
})
test('credential leases exclude same-account probes and retain a surviving family after supervisor death', async () => {
  const p = await accountFixture()
  let family: 'alive' | 'dead' | 'unknown' = 'alive'
  const ledger = new AccountLedger(p, { process: () => 'dead', family: () => family })
  const identity = { pid: 101, pgid: 101, start: 'fake-start' }
  ledger.register({ id: 'probe', kind: 'probe', process: identity, socket: '', generation: 0 })
  const f = {
    id: 'first',
    participant: 'probe',
    account: 'b',
    purpose: 'probe' as const,
    generation: 0,
    supervisor: identity,
  }
  ledger.reserveFamily(f)
  ledger.attachNativeFamily(f.id, identity)
  assert.throws(() => ledger.reserveFamily({ ...f, id: 'second' }), /busy/)
  assert.throws(() => ledger.releaseFamily(f.id), /unproven/)
  assert.throws(() => ledger.retireDeadParticipant('probe'), /unproven/)
  family = 'unknown'
  assert.throws(() => ledger.releaseFamily(f.id), /unproven/)
  family = 'dead'
  ledger.releaseFamily(f.id)
  ledger.retireDeadParticipant('probe')
  assert.equal(ledger.holders().length, 0)
  ledger.close()
})
test('parked probe floor survives restart, failures and a backward clock', async () => {
  const p = await accountFixture()
  const first = new AccountLedger(p)
  assert.equal(first.reserveProbe('b', 1000), true)
  first.close()
  const second = new AccountLedger(p)
  assert.equal(second.reserveProbe('b', 500), false)
  assert.equal(second.reserveProbe('b', 600_999), false)
  assert.equal(second.reserveProbe('b', 601_000), true)
  second.close()
})

test('dead pre-grant launcher can be retired, while changed launcher metadata fails closed', async () => {
  const { retireExitedParticipants } = await import('../src/accounts-rotation.mjs')
  const ledger = new AccountLedger(await accountFixture())
  const dead = { pid: 2_000_000_000, pgid: 2_000_000_000, start: 'dead fixture' }
  ledger.register({ id: 'dead', kind: 'adapter', process: dead, socket: '', generation: 0 })
  try {
    assert.throws(
      () =>
        ledger.reserveFamily({
          id: 'wrong',
          account: 'home',
          generation: 0,
          participant: 'dead',
          purpose: 'model',
          supervisor: { ...dead, pid: dead.pid - 1 },
        }),
      /launcher/,
    )
    ledger.reserveFamily({
      id: 'pending',
      account: 'home',
      generation: 0,
      participant: 'dead',
      purpose: 'model',
      supervisor: dead,
    })
    await retireExitedParticipants(ledger)
    assert.deepEqual(ledger.holders(), [])
    assert.deepEqual(ledger.participants(), [])
  } finally {
    ledger.close()
  }
})
