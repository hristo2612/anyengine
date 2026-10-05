import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { AccountMetadata } from '../src/accounts-metadata.mjs'
import {
  claudeReadings,
  decodeClaudeLimit,
  formatClaudeLimits,
  observeClaudeLimit,
} from '../src/limits-claude.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
test('Claude structured events retain ordinary and overage fields independently across a reopen', async () => {
  const p = await accountFixture()
  let m = new AccountMetadata(p)
  assert.equal(
    observeClaudeLimit(
      m,
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          rateLimitType: 'seven_day_opus',
          utilization: 0.8125,
          resetsAt: 2000,
          overageStatus: 'rejected',
          overageDisabledReason: 'out_of_credits',
          secret: 'ignored',
        },
      },
      1000,
    ),
    true,
  )
  observeClaudeLimit(
    m,
    {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        utilization: 0.2,
      },
    },
    2000,
  )
  observeClaudeLimit(
    m,
    {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'seven_day_opus',
        utilization: null,
      },
    },
    3000,
  )
  m.close()
  m = new AccountMetadata(p)
  try {
    const r = claudeReadings(m)
    assert.equal(r.seven_day_opus?.value.usedPercent, 81.25)
    assert.equal(r.seven_day_opus?.fieldTimes.usedPercent, 1000)
    assert.equal(r.seven_day_opus?.value.overageStatus, 'rejected')
    assert.equal(r.five_hour?.value.usedPercent, 20)
    assert.equal(r.seven_day_opus?.value.secret, undefined)
    assert.match(formatClaudeLimits(r, 4000), /seven_day_opus \| allowed \| 81.25%/)
  } finally {
    m.close()
  }
})
test('screen strings and malformed rate-limit events cannot become Claude capacity', () => {
  assert.equal(decodeClaudeLimit({ type: 'rate_limit_event', message: 'usage 0%' }), null)
  assert.equal(
    decodeClaudeLimit({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', utilization: '0' },
    }),
    null,
  )
  assert.equal(formatClaudeLimits({}), 'Claude | not observed')
})
