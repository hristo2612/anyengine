import assert from 'node:assert/strict'
import { lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { HomeDesktopIdentity } from '../src/accounts-identity.mjs'
import { AccountLedger } from '../src/accounts-ledger.mjs'
import { AccountParticipant } from '../src/accounts-participant.mjs'
import { probeParked, readParkedHome } from '../src/accounts-probe.mjs'
import { rotateAccount } from '../src/accounts-rotation.mjs'
import { LimitsStore } from '../src/limits-store.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
test('parked official metadata read joins its family, persists identity and respects the durable floor', {
  timeout: 30_000,
}, async () => {
  const p = await accountFixture(),
    ledger = new AccountLedger(p),
    limits = new LimitsStore(ledger)
  try {
    assert.equal(
      await probeParked({
        ledger,
        limits,
        account: 'b',
        binary: resolve('test/fixtures/fake-codex-app-server.mjs'),
      }),
      'read',
    )
    assert.equal(ledger.holders().length, 0)
    assert.equal(ledger.workCount(), 0)
    assert.equal(ledger.participants().length, 0)
    assert.equal(ledger.registry().accounts.find((a) => a.id === 'b')?.planType, 'pro')
    assert.equal(limits.readings().b?.buckets.codex?.value.primary?.usedPercent, 12)
    assert.equal(readFileSync(join(p.root, 'accounts/openai/b/auth.json'), 'utf8'), 'FAKE_B')
    assert.equal(
      await probeParked({
        ledger,
        limits,
        account: 'b',
        binary: resolve('test/fixtures/fake-codex-app-server.mjs'),
      }),
      'throttled',
    )
    await assert.rejects(probeParked({ ledger, limits, account: 'home' }), /passive/)
  } finally {
    ledger.close()
  }
})

test('managed desktop identity reads the official parked Home without persisting its bearer', {
  timeout: 30_000,
}, async () => {
  const p = await accountFixture(),
    ledger = new AccountLedger(p)
  await rotateAccount(ledger, 'b', 'manual')
  ledger.close()
  const runtime = new AccountParticipant(p, 'adapter'),
    identity = new HomeDesktopIdentity(runtime, {
      ...process.env,
      ANYENGINE_REAL_CODEX: resolve('test/fixtures/fake-codex-app-server.mjs'),
    }),
    original = lstatSync(join(p.canonical, 'auth.json'))
  await runtime.ready
  try {
    const [account, auth] = await Promise.all([
      identity.request('account/read', { refreshToken: false }),
      identity.request('getAuthStatus', { includeToken: true, refreshToken: true }),
    ])
    assert.deepEqual(account, {
      account: { type: 'chatgpt', email: 'fake@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
    })
    assert.deepEqual(auth, {
      authMethod: 'chatgpt',
      authToken: 'FAKE_HOME_BEARER',
      requiresOpenaiAuth: true,
    })
    assert.deepEqual(await identity.request('getAuthStatus', { includeToken: false }), {
      authMethod: 'chatgpt',
      authToken: null,
      requiresOpenaiAuth: true,
    })
    assert.equal(await identity.request('turn/start', {}), undefined)
    await assert.rejects(identity.request('account/logout', {}), /Home account/)
    assert.equal(runtime.ledger.holders().length, 0)
    assert.equal(runtime.ledger.workCount(), 0)
    assert.equal(runtime.ledger.registry().active, 'b')
    assert.equal(lstatSync(join(p.canonical, 'auth.json')).ino, original.ino)
    assert.equal(runtime.limits.readings().home, undefined)
    assert.equal(readFileSync(p.ledger).includes(Buffer.from('FAKE_HOME_BEARER')), false)
    assert.equal(readFileSync(p.registry, 'utf8').includes('FAKE_HOME_BEARER'), false)
    await assert.rejects(
      readParkedHome({ ledger: runtime.ledger }, 'turn/start', {}),
      /identity method/,
    )
  } finally {
    await runtime.close()
  }
})

test('failed official probe launch releases its work and participant', async () => {
  const p = await accountFixture(),
    ledger = new AccountLedger(p),
    limits = new LimitsStore(ledger)
  try {
    assert.equal(
      await probeParked({ ledger, limits, account: 'b', binary: '/nonexistent/codex' }),
      'unavailable',
    )
    assert.equal(ledger.holders().length, 0)
    assert.equal(ledger.workCount(), 0)
    assert.equal(ledger.participants().length, 0)
  } finally {
    ledger.close()
  }
})
