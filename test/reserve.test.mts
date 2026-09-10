import assert from 'node:assert/strict'
import test from 'node:test'

// ReserveState logs its transitions through debugLog, which would otherwise
// append to the developer's own adapter home.
process.env.ANYENGINE_DEBUG_LOG = '0'

import {
  accountUpdatedFor,
  autoReserveEnabled,
  RESERVE_ACCOUNT_READ,
  RESERVE_ACCOUNT_UPDATED,
  ReserveState,
  rateLimitReached,
  stripReserveMarkers,
} from '../src/reserve.mjs'

// Auto-reserve, on fixtures shaped like the real child's answers. The field
// names come from the bundled binary's own schema
// (`codex app-server generate-json-schema`, v2/GetAccountRateLimitsResponse.json).

const snapshot = (reachedType: string | null) => ({
  limitId: 'codex',
  limitName: 'Codex',
  primary: {
    usedPercent: reachedType ? 100 : 12,
    resetsAt: 1_800_000_000,
    windowDurationMins: 300,
  },
  secondary: null,
  credits: null,
  planType: 'pro',
  rateLimitReachedType: reachedType,
})

// `account/rateLimits/read` while the account is out of Codex usage.
const LIMITED = {
  accountId: 'acct-1',
  rateLimits: snapshot('rate_limit_reached'),
  rateLimitsByLimitId: { codex: snapshot('rate_limit_reached') },
  rateLimitUpsell: { banner_type: 'luna_reserve', priority: 1, ctas: [] },
}

// The same read after the window rolled (or a banked reset credit was used).
const NOT_LIMITED = {
  accountId: 'acct-1',
  rateLimits: snapshot(null),
  rateLimitsByLimitId: { codex: snapshot(null) },
  rateLimitUpsell: null,
}

test('rateLimitReached reads the limited fixture and not the cleared one', () => {
  assert.equal(rateLimitReached(LIMITED), true)
  assert.equal(rateLimitReached(NOT_LIMITED), false)
  assert.equal(rateLimitReached(null), false)
  assert.equal(rateLimitReached({}), false)
})

test('rateLimitReached accepts either marker on its own', () => {
  assert.equal(rateLimitReached({ rateLimits: snapshot('rate_limit_reached') }), true)
  assert.equal(
    rateLimitReached({
      rateLimits: snapshot(null),
      rateLimitUpsell: { banner_type: 'luna_reserve' },
    }),
    true,
  )
  // A bucket other than the single-bucket view still counts.
  assert.equal(
    rateLimitReached({
      rateLimits: snapshot(null),
      rateLimitsByLimitId: { codex: snapshot('workspace_owner_usage_limit_reached') },
    }),
    true,
  )
  // A different backend banner is not the reserve banner.
  assert.equal(
    rateLimitReached({ rateLimits: snapshot(null), rateLimitUpsell: { banner_type: 'upgrade' } }),
    false,
  )
})

test('stripReserveMarkers keeps the usage numbers and drops both markers', () => {
  const masked = stripReserveMarkers(LIMITED) as typeof LIMITED
  assert.equal(masked.rateLimits.rateLimitReachedType, null)
  assert.equal(masked.rateLimitsByLimitId.codex.rateLimitReachedType, null)
  assert.equal(masked.rateLimitUpsell, null)
  assert.equal(masked.rateLimits.primary.usedPercent, 100)
  assert.equal(masked.rateLimits.primary.resetsAt, 1_800_000_000)
  assert.equal(masked.accountId, 'acct-1')
  assert.equal(rateLimitReached(masked), false)
  // The input is untouched.
  assert.equal(LIMITED.rateLimits.rateLimitReachedType, 'rate_limit_reached')
  // A cleared read is already free of markers.
  assert.deepEqual(stripReserveMarkers(NOT_LIMITED), NOT_LIMITED)
})

test('the account transform is the externally-authenticated shape', () => {
  assert.deepEqual(RESERVE_ACCOUNT_READ, {
    account: { type: 'amazonBedrock' },
    requiresOpenaiAuth: false,
  })
  assert.deepEqual(RESERVE_ACCOUNT_UPDATED, { authMode: 'apikey', planType: null })
})

test('a full read moves the state in both directions, once per transition', () => {
  const state = new ReserveState(true)
  assert.equal(state.limited, false)

  assert.equal(state.observeRead(LIMITED), true, 'entered')
  assert.equal(state.limited, true)
  assert.equal(state.observeRead(LIMITED), false, 'no second transition while still limited')
  assert.equal(state.limited, true)

  assert.equal(state.observeRead(NOT_LIMITED), true, 'cleared')
  assert.equal(state.limited, false)
  assert.equal(state.observeRead(NOT_LIMITED), false, 'no second transition while clear')
  assert.equal(state.limited, false)

  // And back again when the next window is spent.
  assert.equal(state.observeRead(LIMITED), true)
  assert.equal(state.limited, true)
})

test('a sparse rate-limit notification can enter reserve but never clear it', () => {
  const state = new ReserveState(true)
  assert.equal(state.observeUpdate({ rateLimits: snapshot('rate_limit_reached') }), true)
  assert.equal(state.limited, true)
  // `account/rateLimits/updated` carries a snapshot that may omit fields, so it
  // is not evidence the limit lifted; only a full read clears.
  assert.equal(state.observeUpdate({ rateLimits: {} }), false)
  assert.equal(state.limited, true)
  assert.equal(state.observeRead(NOT_LIMITED), true)
  assert.equal(state.limited, false)
})

test('the kill switch pins the state to "not limited"', () => {
  const state = new ReserveState(false)
  assert.equal(state.active, false)
  assert.equal(state.observeRead(LIMITED), false)
  assert.equal(state.limited, false)
  assert.equal(state.observeUpdate(LIMITED), false)
  assert.equal(state.limited, false)
})

test('accountUpdatedFor maps the child account onto an AuthMode', () => {
  assert.deepEqual(
    accountUpdatedFor({ account: { type: 'chatgpt', email: 'a@b.c', planType: 'pro' } }),
    { authMode: 'chatgpt', planType: 'pro' },
  )
  assert.deepEqual(accountUpdatedFor({ account: { type: 'apiKey' } }), {
    authMode: 'apikey',
    planType: null,
  })
  assert.deepEqual(accountUpdatedFor(RESERVE_ACCOUNT_READ), {
    authMode: 'bedrockApiKey',
    planType: null,
  })
  assert.equal(accountUpdatedFor({ account: null }), null)
  assert.equal(accountUpdatedFor(null), null)
})

test('ANYENGINE_AUTO_RESERVE=0 is the only value that disables it', () => {
  assert.equal(autoReserveEnabled({}), true)
  assert.equal(autoReserveEnabled({ ANYENGINE_AUTO_RESERVE: '1' }), true)
  assert.equal(autoReserveEnabled({ ANYENGINE_AUTO_RESERVE: '' }), true)
  assert.equal(autoReserveEnabled({ ANYENGINE_AUTO_RESERVE: '0' }), false)
  assert.equal(autoReserveEnabled({ ANYENGINE_AUTO_RESERVE: ' 0 ' }), false)
})
