import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test, { after } from 'node:test'
import { AccountLedger } from '../src/accounts-ledger.mjs'
import { AccountObservations } from '../src/accounts-observations.mjs'
import { AccountParticipant } from '../src/accounts-participant.mjs'
import {
  chooseAccount,
  eligibleForModel,
  quotaFailure,
  thresholdReached,
} from '../src/accounts-policy.mjs'
import { CodexUpstream } from '../src/codex-upstream.mjs'
import { emptyLimits, observeOpenAI, observeQuotaFailure } from '../src/limits-openai.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
const model = 'gpt-5.6-sol',
  map = { [model]: ['codex'], 'gpt-special': ['special'] },
  now = 1_000_000
function reading(id: string, at = now, percent = 12) {
  return observeOpenAI(
    emptyLimits(id),
    {
      rateLimits: { limitId: 'codex', primary: { usedPercent: percent } },
      ordinaryUsageAllowed: true,
    },
    { sequence: 1, startedAt: at },
    true,
  )
}
test('automatic candidates require fresh positive permission and preserve scoped exhaustion', () => {
  const allowed = reading('b'),
    denied = observeQuotaFailure(allowed, 'bucket:special', { sequence: 2, startedAt: now })
  assert.equal(eligibleForModel(denied, model, map, now), true)
  assert.equal(eligibleForModel(denied, 'gpt-special', map, now), false)
  assert.equal(eligibleForModel(denied, 'unknown-alias', map, now), false)
  assert.equal(eligibleForModel(reading('b', now - 600_001), model, map, now), false)
  assert.equal(eligibleForModel(reading('b', now + 1), model, map, now), false)
  const global = observeQuotaFailure(denied, 'global', { sequence: 3, startedAt: now })
  const sparse = observeOpenAI(
    global,
    { rateLimits: { primary: { usedPercent: 0, resetsAt: 0 } } },
    { sequence: 4, startedAt: now },
    false,
  )
  assert.equal(eligibleForModel(sparse, model, map, now + 1), false)
  const account = {
    id: 'b',
    label: 'B',
    kind: 'managed' as const,
    login: 'ready' as const,
    email: null,
    planType: null,
    vendorAccountId: null,
  }
  assert.equal(
    chooseAccount(
      'home',
      [{ account, limits: sparse, credentialPresent: true, scopeMap: map }],
      now,
      model,
    ),
    null,
  )
})
test('only exact terminal quota errors and valid fresh applicable percentages trigger rotation', () => {
  assert.equal(
    quotaFailure({ error: { codexErrorInfo: 'usageLimitExceeded' }, willRetry: true }),
    false,
  )
  for (const error of ['rateLimitExceeded', '429', 'badRequest'])
    assert.equal(quotaFailure({ error: { codexErrorInfo: error } }), false)
  assert.equal(
    quotaFailure({ turn: { status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } } }),
    true,
  )
  assert.equal(thresholdReached(reading('home', now, 100), model, map, 100, now), true)
  assert.equal(thresholdReached(reading('home', now, 101), model, map, 100, now), false)
  assert.equal(thresholdReached(reading('home', now - 600_001, 100), model, map, 100, now), false)
  assert.equal(thresholdReached(reading('home', now, 100), 'unknown', map, 100, now), false)
})
async function until(predicate: () => boolean) {
  const end = Date.now() + 20_000
  while (!predicate()) {
    assert.ok(Date.now() < end, 'account policy did not settle')
    await new Promise((done) => setTimeout(done, 20))
  }
}
for (const source of ['native', 'disable', 'translator', 'child', 'child-first', 'threshold'])
  test(`automatic ${source} switch drains both surfaces and respects scoped capacity`, {
    timeout: 30_000,
  }, async () => {
    const p = await accountFixture(),
      ledger = new AccountLedger(p),
      app = new AccountParticipant(p, 'adapter'),
      broker = new AccountParticipant(p, 'broker')
    let upstream: CodexUpstream
    const observations = new AccountObservations(app, () => upstream?.pid ?? null)
    upstream = new CodexUpstream({
      binary: resolve('test/fixtures/fake-codex-app-server.mjs'),
      args: ['app-server'],
      env: { ...process.env, CODEX_HOME: p.overlay },
      processLifecycle: app.lifecycle,
      reserveEnabled: false,
      beforeRequest: (method) => observations.before(method),
      onRawMessage: (method, payload, sample) => observations.observe(method, payload, sample),
      onMessage: () => {},
    })
    app.setHooks({ stop: () => upstream.stop(), restart: () => upstream.restartForAccounts() })
    broker.setHooks({ stop: async () => {}, restart: async () => {} })
    upstream.onChildLifecycle((event) => {
      if (event.type === 'exit') observations.close()
    })
    let desktop: ReturnType<AccountParticipant['begin']> | undefined, translator: typeof desktop
    try {
      await Promise.all([app.ready, broker.ready])
      upstream.start()
      await upstream.initialize({ clientInfo: { name: 'fixture', version: '1' } })
      upstream.markInitialized()
      await upstream.request('model/list', {})
      const at = Date.now()
      ledger.metadata.tx(() =>
        ledger.metadata.mutate('limits', () => ({
          home: reading('home', at),
          b: reading('b', at),
          c: reading('c', at),
        })),
      )
      desktop = app.begin()
      translator = broker.begin()
      ledger.metadata.editRegistry((r) => ({ ...r, rotation: { ...r.rotation, enabled: true } }))
      const disableDuringDrain = source === 'disable'
      observations.observe('thread/started', { thread: { id: 'thread', model } })
      observations.observe('turn/started', { threadId: 'thread' })
      const error = {
        threadId: 'thread',
        turnId: 'turn',
        error: { codexErrorInfo: 'usageLimitExceeded' },
        willRetry: false,
      }
      if (source === 'translator')
        app.policy.translationQuota(model, 0, (scope) => app.recordQuota(scope))
      else if (source === 'child' || source === 'child-first') {
        if (source === 'child-first') observations.observe('error', { ...error, threadId: 'child' })
        observations.observe('item/completed', {
          threadId: 'thread',
          item: {
            type: 'collabAgentToolCall',
            tool: 'spawnAgent',
            model,
            receiverThreadIds: ['child'],
          },
        })
        observations.observe('error', { ...error, threadId: 'child' })
      } else if (source === 'threshold') {
        ledger.metadata.tx(() => {
          ledger.metadata.db
            .prepare('INSERT INTO model_scope VALUES(?,?,?)')
            .run('home', model, 'special')
          ledger.metadata.mutate<Record<string, ReturnType<typeof reading>>>('limits', (all) => ({
            ...all,
            home: observeOpenAI(
              all.home ?? reading('home', at),
              {
                rateLimits: {},
                rateLimitsByLimitId: {
                  special: { normalModelSlug: model, primary: { usedPercent: 100 } },
                },
              },
              { sequence: 2, startedAt: at },
              false,
            ),
          }))
        })
        app.policy.wake()
      } else {
        observations.observe('error', error)
        observations.observe('error', error)
      }
      await until(() => ledger.state().phase === 'draining')
      assert.equal(ledger.workCount(), 2)
      assert.equal(ledger.state().active, 'home')
      assert.throws(() => app.begin(), /frozen/)
      if (disableDuringDrain)
        ledger.metadata.editRegistry((r) => ({ ...r, rotation: { ...r.rotation, enabled: false } }))
      await desktop.release()
      desktop = undefined
      assert.equal(ledger.state().active, 'home')
      await translator.release()
      translator = undefined
      await until(
        () =>
          ledger.state().phase === 'open' &&
          ledger.holders().length === 1 &&
          app.participant.generation === ledger.state().generation,
      )
      assert.equal(ledger.state().active, disableDuringDrain ? 'home' : 'b')
      assert.equal(ledger.state().generation, disableDuringDrain ? 0 : 1)
      assert.equal(
        Number(ledger.metadata.db.prepare('SELECT count(*) AS n FROM rotation_event').get()?.n),
        disableDuringDrain ? 0 : 1,
      )
      assert.equal(
        Number(ledger.metadata.db.prepare('SELECT count(*) AS n FROM rotation_request').get()?.n),
        1,
      )
      assert.equal(ledger.probeAttempt('c'), 0, 'stop at the first eligible candidate')
    } finally {
      await desktop?.release()
      await translator?.release()
      await app.policy.close()
      await broker.policy.close()
      await upstream.stop()
      await app.close()
      await broker.close()
      ledger.close()
    }
  })
