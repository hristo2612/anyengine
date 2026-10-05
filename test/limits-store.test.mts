import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { AccountLedger } from '../src/accounts-ledger.mjs'
import { identifyProcess } from '../src/accounts-processes.mjs'
import { LimitsStore } from '../src/limits-store.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
test('fenced samples merge from another connection, survive reopen, and reject closed sources', async () => {
  const p = await accountFixture(),
    ledger = new AccountLedger(p),
    limits = new LimitsStore(ledger)
  const identity = identifyProcess(process.pid)
  assert.ok(identity)
  ledger.register({ id: 'app', kind: 'adapter', process: identity, socket: '', generation: 0 })
  ledger.reserveFamily({
    id: 'family',
    participant: 'app',
    account: 'home',
    purpose: 'model',
    generation: 0,
    supervisor: identity,
  })
  ledger.attachNativeFamily('family', identity)
  const permit = limits.issue('family', 'source', 1),
    old = limits.sample(permit, 1000),
    newer = limits.sample(permit, 2000)
  const other = new AccountLedger(p),
    otherLimits = new LimitsStore(other)
  assert.equal(
    otherLimits.accept({
      sample: newer,
      kind: 'openai-read',
      payload: { rateLimits: {}, ordinaryUsageAllowed: false },
    }),
    true,
  )
  assert.equal(
    limits.accept({
      sample: old,
      kind: 'openai-read',
      payload: {
        rateLimits: { limitId: 'spark', primary: { usedPercent: 42 } },
        ordinaryUsageAllowed: true,
      },
    }),
    true,
  )
  const held = limits.sample(permit)
  limits.revoke('family')
  assert.equal(
    otherLimits.accept({
      sample: held,
      kind: 'openai-read',
      payload: { rateLimits: {}, ordinaryUsageAllowed: true },
    }),
    false,
  )
  ledger.close()
  other.close()
  const reopened = new AccountLedger(p),
    readings = new LimitsStore(reopened).readings()
  assert.equal(readings.home?.ordinary?.value, false)
  assert.equal(readings.home?.buckets.spark?.value.primary?.usedPercent, 42)
  reopened.metadata.project()
  reopened.close()
})

test('catalog aliases retain their previously observed scoped bucket', async () => {
  const ledger = new AccountLedger(await accountFixture()),
    limits = new LimitsStore(ledger)
  try {
    ledger.metadata.tx(() => {
      ledger.metadata.db
        .prepare('INSERT INTO model_scope VALUES(?,?,?)')
        .run('home', 'gpt-alias', 'restricted')
      ledger.metadata.db
        .prepare('INSERT INTO model_scope VALUES(?,?,?)')
        .run('home', 'gpt-normal', 'codex')
      ledger.metadata.db
        .prepare('INSERT INTO catalog_alias VALUES(?,?)')
        .run('gpt-alias', 'gpt-normal')
    })
    assert.deepEqual(limits.modelScopes('home')['gpt-alias'], ['restricted', 'codex'])
  } finally {
    ledger.close()
  }
})
