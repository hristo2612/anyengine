import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { AccountLedger } from '../src/accounts-ledger.mjs'
import { readAccountStatus } from '../src/control-account-status.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
test('account status settles a concurrent projection publication without reporting drift', async () => {
  const paths = await accountFixture()
  const ledger = new AccountLedger(paths)
  try {
    ledger.metadata.editRegistry((registry) => {
      registry.accounts[0]!.label = 'Updated Home'
      return registry
    })
    const system = fakeSystem(paths.root)
    let projected = false
    system.processes = () => {
      if (!projected) {
        ledger.metadata.project()
        projected = true
      }
      return []
    }
    const status = readAccountStatus(paths.root, paths.canonical, system)
    assert.equal(status?.label, 'Updated Home')
    assert.deepEqual(status?.conflicts, [])
    assert.equal(status?.revisions.registry?.stored, status?.revisions.registry?.projected)
  } finally {
    ledger.close()
  }
})

test('account status is read-only and warns about possible canonical consumers', async () => {
  const paths = await accountFixture()
  const ledger = new AccountLedger(paths)
  try {
    ledger.metadata.tx(() => {
      ledger.metadata.mutate('registry', () => ({
        ...ledger.registry(),
        active: 'b',
        generation: 1,
      }))
      ledger.save({ ...ledger.state(), active: 'b', generation: 1 })
    })
    const before = readFileSync(paths.registry)
    const system = fakeSystem(paths.root)
    system.procs = [
      {
        pid: 900,
        ppid: 1,
        command: '/vendor/codex app-server',
        processStart: '2026-10-01T00:00:00Z',
      },
    ]
    const status = readAccountStatus(paths.root, paths.canonical, system)
    assert.equal(status?.active, 'b')
    assert.equal(status?.generation, 1)
    assert.equal(status?.rotation, false)
    assert.deepEqual(status?.possibleCanonicalPids, [900])
    assert.ok(status?.conflicts.includes('registry projection drift'))
    assert.ok(status?.conflicts.includes('Active credential layout conflict'))
    writeFileSync(join(paths.overlay, 'detached.txt'), 'detached')
    assert.ok(
      readAccountStatus(paths.root, paths.canonical, system)?.conflicts.includes(
        'Unshared overlay entry: detached.txt',
      ),
    )
    assert.deepEqual(readFileSync(paths.registry), before)
    ledger.save({ ...ledger.state(), phase: 'invalid' as never })
    assert.throws(() => readAccountStatus(paths.root, paths.canonical, system), /disagree/)
  } finally {
    ledger.close()
  }
})
