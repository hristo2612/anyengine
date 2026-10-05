import assert from 'node:assert/strict'
import test from 'node:test'
import { formatLimits } from '../src/limits-format.mjs'
import { blocked, decodeOpenAIRead, emptyLimits, observeOpenAI } from '../src/limits-openai.mjs'

const sample = (sequence: number) => ({ sequence, startedAt: sequence * 1000 })
test('reset credit details remain exact display metadata, never ordinary allowance', () => {
  for (const credits of [
    undefined,
    null,
    [],
    [
      {
        id: 'fake-credit',
        resetType: 'codexRateLimits',
        status: 'available',
        grantedAt: 1000,
        expiresAt: null,
        title: 'Weekly reset',
        description: null,
        secret: 'ignored',
      },
    ],
  ]) {
    const read = decodeOpenAIRead({
      rateLimits: {},
      rateLimitResetCredits: { availableCount: 2, ...(credits !== undefined ? { credits } : {}) },
    })
    const state = observeOpenAI(emptyLimits('b'), read, sample(1), true)
    assert.equal(state.ordinary, null)
    assert.equal(state.resetCredits?.value.availableCount, 2)
    assert.deepEqual(
      state.resetCredits?.value.credits,
      Array.isArray(credits) && credits.length
        ? [
            {
              id: 'fake-credit',
              resetType: 'codexRateLimits',
              status: 'available',
              grantedAt: 1000,
              expiresAt: null,
              title: 'Weekly reset',
              description: null,
            },
          ]
        : credits,
    )
  }
})
test('ordinary permission is explicit; sparse resets never clear scoped quota or spend evidence', () => {
  let s = observeOpenAI(
    emptyLimits('b'),
    decodeOpenAIRead({
      ordinaryUsageAllowed: true,
      rateLimits: {
        limitId: 'spark',
        rateLimitReachedType: 'rate_limit_reached',
        spendControlReached: true,
      },
    }),
    sample(1),
    true,
  )
  assert.equal(blocked(s, 'bucket:spark'), true)
  assert.equal(blocked(s, 'global'), false)
  s = observeOpenAI(
    s,
    decodeOpenAIRead({
      rateLimits: { limitId: 'spark', primary: { usedPercent: 0, resetsAt: 1 } },
    }),
    sample(2),
    false,
  )
  assert.equal(blocked(s, 'bucket:spark'), true)
  s = observeOpenAI(
    s,
    decodeOpenAIRead({
      ordinaryUsageAllowed: true,
      rateLimits: { limitId: 'spark', spendControlReached: false },
    }),
    sample(3),
    true,
  )
  assert.equal(s.denials['bucket:spark']?.spendAt, null)
  assert.notEqual(s.denials['bucket:spark']?.quotaAt, null)
})
test('older reads cannot overwrite a later field or denial but still merge an unrelated bucket', () => {
  let s = observeOpenAI(
    emptyLimits('b'),
    decodeOpenAIRead({
      ordinaryUsageAllowed: false,
      rateLimits: { limitId: 'codex', primary: { usedPercent: 100 } },
    }),
    sample(2),
    true,
  )
  s = observeOpenAI(
    s,
    decodeOpenAIRead({
      ordinaryUsageAllowed: true,
      rateLimits: { limitId: 'codex', primary: { usedPercent: 0 } },
      rateLimitsByLimitId: { spark: { primary: { usedPercent: 31 } } },
    }),
    sample(1),
    true,
  )
  assert.equal(blocked(s, 'global'), true)
  assert.equal(s.ordinary?.value, false)
  assert.equal(s.buckets.codex?.value.primary?.usedPercent, 100)
  assert.equal(s.buckets.spark?.value.primary?.usedPercent, 31)
  s = observeOpenAI(
    s,
    decodeOpenAIRead({ ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' } }),
    sample(3),
    true,
  )
  assert.equal(blocked(s, 'global'), false)
})
test('single explicit bucket remains scoped with absent, null, empty and mirrored maps', () => {
  const spark = { limitId: 'spark', rateLimitReachedType: 'rate_limit_reached' }
  for (const map of [undefined, null, {}, { spark }]) {
    const s = observeOpenAI(
      emptyLimits('b'),
      decodeOpenAIRead({ rateLimits: spark, ordinaryUsageAllowed: true, rateLimitsByLimitId: map }),
      sample(1),
      true,
    )
    assert.deepEqual(Object.keys(s.buckets), ['spark'])
    assert.equal(blocked(s, 'global'), false)
    assert.equal(blocked(s, 'bucket:spark'), true)
  }
  assert.throws(
    () =>
      decodeOpenAIRead({ rateLimits: {}, rateLimitsByLimitId: { spark: { limitId: 'codex' } } }),
    /Mismatched/,
  )
})
test('weekly in primary and decimal credit strings are displayed without invented five-hour data', () => {
  const s = observeOpenAI(
    emptyLimits('home'),
    decodeOpenAIRead({
      rateLimits: {
        primary: { usedPercent: 8, windowDurationMins: 10080 },
        credits: { hasCredits: true, unlimited: false, balance: '12.0000000000000001' },
      },
    }),
    sample(1),
    true,
  )
  const text = formatLimits(
    {
      version: 1,
      active: 'home',
      home: 'home',
      generation: 0,
      rotation: { enabled: false, threshold: 100, cooldownMs: 300_000 },
      replay: 'none',
      accounts: [
        {
          id: 'home',
          label: 'Home',
          kind: 'home',
          vendorAccountId: null,
          email: null,
          planType: null,
          login: 'ready',
        },
      ],
    },
    { home: s },
  )
  assert.match(text, /\| — \| 8% \| 12\.0000000000000001/)
  assert.match(text, /Claude \| not observed/)
})
