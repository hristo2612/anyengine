import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as settleMicrotasks } from 'node:timers/promises'
import type {
  ActiveAccount,
  AuthSource,
  AuthStatus,
  BrokerOwner,
  SourceSelection,
  TokenBroker,
} from '../src/broker-types.mjs'

const load = () => import('../src/' + 'broker-cache.mjs')
const HOME = '/fake/codex'
const SECRET = 'FAKE_SECRET_MARKER_broker'
const NOW = 1_000_000

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fakeJwt(claims: unknown) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(claims)}.unsigned-fixture`
}

function auth(exp = 2000, identity = 'A'): AuthStatus {
  return {
    authMethod: 'chatgpt',
    authToken: fakeJwt({
      exp,
      fixture: `${SECRET}-${identity}`,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-fake' },
    }),
    requiresOpenaiAuth: true,
  }
}

function source(
  id: string,
  request: AuthSource['request'],
  extra: Partial<AuthSource> = {},
): AuthSource {
  return { id, generation: 1, home: HOME, request, ...extra }
}

function owner(initial: AuthSource | null) {
  let selection: SourceSelection = { revision: 1, source: initial }
  const listeners = new Set<(selection: SourceSelection) => void>()
  let closes = 0
  const result: BrokerOwner = {
    current: () => selection,
    source: async () => {
      if (!selection.source) throw new Error(SECRET)
      return { revision: selection.revision, source: selection.source }
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stopSources: async () => {},
    close: async () => {
      closes++
    },
  }
  return {
    owner: result,
    elect(next: AuthSource | null) {
      selection = { revision: selection.revision + 1, source: next }
      for (const listener of listeners) listener(selection)
    },
    subscribers: () => listeners.size,
    closes: () => closes,
  }
}

async function create(
  selected: AuthSource | null,
  account: () => ActiveAccount = () => ({ home: HOME, generation: 1 }),
  now = () => NOW,
) {
  const { createTokenBroker } = await load()
  const election = owner(selected)
  const broker: TokenBroker = createTokenBroker({ owner: election.owner, account, now })
  return { broker, ...election }
}

test('seven callers share one RPC and status exposes no account or bearer', async () => {
  const started = deferred<void>()
  const reply = deferred<AuthStatus>()
  let calls = 0
  const { broker } = await create(
    source('A', async (method, params) => {
      assert.equal(method, 'getAuthStatus')
      assert.deepEqual(params, { includeToken: true, refreshToken: false })
      calls++
      started.resolve()
      return reply.promise
    }),
  )
  try {
    const waiters = Array.from({ length: 7 }, () => broker.get())
    await started.promise
    assert.equal(calls, 1)
    reply.resolve(auth())
    const leases = await Promise.all(waiters)
    assert.ok(
      leases.every(
        (lease) =>
          lease.accountId === 'acct-fake' &&
          lease.generation === 1 &&
          lease.sourceId === 'A' &&
          lease.sourceRevision === 1,
      ),
    )
    assert.ok(leases.every((lease) => broker.isCurrent(lease)))
    assert.equal((await broker.get()).bearer, leases[0]?.bearer)
    assert.equal(calls, 1)
    assert.deepEqual(broker.status(), {
      ready: true,
      source: 'adapter',
      generation: 1,
      reason: null,
    })
    assert.ok(!JSON.stringify(broker.status()).includes('acct-fake'))
    assert.ok(!JSON.stringify(broker.status()).includes(SECRET))
    assert.ok(!JSON.stringify(broker.status()).includes(leases[0]?.bearer ?? 'missing'))
  } finally {
    await broker.close()
  }
})

for (const order of ['A-before-B', 'B-before-A', 'A-rejects-after-B'] as const) {
  test(`same-generation replacement wakes seven A waiters and fences the late result: ${order}`, async () => {
    const aStarted = deferred<void>()
    const bStarted = deferred<void>()
    const aReply = deferred<AuthStatus>()
    const bReply = deferred<AuthStatus>()
    let aCalls = 0
    let bCalls = 0
    const a = source('A', async () => {
      aCalls++
      aStarted.resolve()
      return aReply.promise
    })
    const b = source('B', async () => {
      bCalls++
      bStarted.resolve()
      return bReply.promise
    })
    const { broker, elect, owner: elected } = await create(a)
    try {
      const waiters = Array.from({ length: 7 }, () => broker.get())
      await aStarted.promise
      assert.equal(aCalls, 1)
      elect(b)
      await bStarted.promise
      assert.equal(bCalls, 1)
      if (order === 'A-before-B') {
        aReply.resolve(auth(2000, 'A'))
        // Drain promise reactions; this is a scheduling barrier, not a timed sleep.
        await settleMicrotasks()
        waiters.push(broker.get())
        await settleMicrotasks()
        assert.equal(bCalls, 1, 'A finalizer must not clear the pending B flight')
      }
      bReply.resolve(auth(3000, 'B'))
      const leases = await Promise.all(waiters)
      if (order === 'B-before-A') aReply.resolve(auth(2000, 'A'))
      if (order === 'A-rejects-after-B') aReply.reject(new Error(SECRET))
      await settleMicrotasks()
      assert.equal(elected.current().source?.id, 'B')
      assert.ok(leases.every((lease) => lease.sourceId === 'B' && lease.sourceRevision === 2))
      assert.equal((await broker.get()).sourceId, 'B')
      assert.equal(aCalls, 1)
      assert.equal(bCalls, 1)
    } finally {
      await broker.close()
    }
  })
}

test('a second election while retrying fails closed instead of following endless churn', async () => {
  const aStarted = deferred<void>()
  const bStarted = deferred<void>()
  const aReply = deferred<AuthStatus>()
  const bReply = deferred<AuthStatus>()
  let cCalls = 0
  const { broker, elect } = await create(
    source('A', async () => {
      aStarted.resolve()
      return aReply.promise
    }),
  )
  try {
    const waiting = assert.rejects(broker.get(), { message: 'broker.source-changed' })
    await aStarted.promise
    elect(
      source('B', async () => {
        bStarted.resolve()
        return bReply.promise
      }),
    )
    await bStarted.promise
    elect(
      source('C', async () => {
        cCalls++
        return auth(4000, 'C')
      }),
    )
    await waiting
    assert.equal(cCalls, 0)
    aReply.resolve(auth())
    bReply.resolve(auth(3000, 'B'))
  } finally {
    await broker.close()
  }
})

test('same-generation explicit invalidation wakes and replaces a pending flight', async () => {
  const started = deferred<void>()
  const oldReply = deferred<AuthStatus>()
  let calls = 0
  const { broker } = await create(
    source('A', async () => {
      calls++
      if (calls === 1) {
        started.resolve()
        return oldReply.promise
      }
      return auth(3000, 'replacement')
    }),
  )
  try {
    const waiting = broker.get()
    await started.promise
    broker.invalidate(1)
    const newLease = await waiting
    oldReply.resolve(auth())
    await settleMicrotasks()
    assert.equal(calls, 2)
    assert.equal((await broker.get()).bearer, newLease.bearer)
    const revision = newLease.cacheRevision
    broker.invalidate(1)
    assert.equal(broker.isCurrent(newLease), false)
    assert.equal(broker.status().ready, false)
    const later = await broker.get()
    assert.ok(later.cacheRevision > revision)
    assert.equal(calls, 3)
  } finally {
    await broker.close()
  }
})

test('seven matching 401s force one refresh and late rejected leases preserve the new cache', async () => {
  const renewed = deferred<AuthStatus>()
  const refreshing = deferred<void>()
  const modes: boolean[] = []
  const { broker } = await create(
    source('A', async (_method, params) => {
      modes.push(params.refreshToken)
      if (params.refreshToken) {
        refreshing.resolve()
        return renewed.promise
      }
      return auth()
    }),
  )
  try {
    const old = await broker.get()
    const waiters = Array.from({ length: 7 }, () => broker.get({ rejected: old }))
    await refreshing.promise
    assert.deepEqual(modes, [false, true])
    assert.equal(broker.isCurrent(old), false)
    renewed.resolve(auth(3000, 'renewed'))
    const leases = await Promise.all(waiters)
    assert.ok(
      leases.every(
        (lease) => lease.bearer === leases[0]?.bearer && lease.cacheRevision > old.cacheRevision,
      ),
    )
    assert.equal((await broker.get({ rejected: old })).bearer, leases[0]?.bearer)
    assert.deepEqual(modes, [false, true])
  } finally {
    await broker.close()
  }
})

test('a rejected A lease never invalidates B, including identical bearer bytes', async () => {
  let bCalls = 0
  const same = auth()
  const { broker, elect } = await create(source('A', async () => same))
  try {
    const old = await broker.get()
    elect(
      source('B', async () => {
        bCalls++
        return same
      }),
    )
    assert.equal(broker.isCurrent(old), false)
    const next = await broker.get()
    assert.equal((await broker.get({ rejected: old })).cacheRevision, next.cacheRevision)
    assert.equal(bCalls, 1)
  } finally {
    await broker.close()
  }
})

test('near-expiry cache misses request false then true once, while repeated cache hits do not refresh', async () => {
  const modes: boolean[] = []
  const { broker } = await create(
    source('A', async (_method, params) => {
      modes.push(params.refreshToken)
      return auth(params.refreshToken ? 3000 : 1040)
    }),
  )
  try {
    const lease = await broker.get()
    assert.ok(broker.isCurrent(lease))
    await broker.get()
    assert.deepEqual(modes, [false, true])
  } finally {
    await broker.close()
  }
})

test('tokens still expired or within the refresh margin after renewal fail without looping', async () => {
  for (const exp of [999, 1000, 1040, 1060]) {
    const modes: boolean[] = []
    const { broker } = await create(
      source('A', async (_method, params) => {
        modes.push(params.refreshToken)
        return auth(exp)
      }),
    )
    try {
      await assert.rejects(broker.get(), { message: 'broker.token-expired' })
      assert.deepEqual(modes, [false, true])
      assert.equal(broker.status().ready, false)
      assert.ok(!JSON.stringify(broker.status()).includes(SECRET))
    } finally {
      await broker.close()
    }
  }
})

test('cache expires at the earlier five-minute ceiling or token refresh margin', async () => {
  for (const exp of [10000, 1100]) {
    let time = NOW
    let calls = 0
    const { broker } = await create(
      source('A', async () => {
        calls++
        return auth(calls === 1 ? exp : 10000)
      }),
      undefined,
      () => time,
    )
    try {
      await broker.get()
      time = NOW + (exp === 10000 ? 299999 : 39999)
      await broker.get()
      assert.equal(calls, 1)
      time++
      await broker.get()
      assert.equal(calls, 2)
    } finally {
      await broker.close()
    }
  }
})

test('empty login, API-key auth and malformed claims have stable secret-free errors', async () => {
  const failures: [AuthStatus, string][] = [
    [{ authMethod: null, authToken: null, requiresOpenaiAuth: true }, 'broker.login-required'],
    [
      { authMethod: 'apikey', authToken: SECRET, requiresOpenaiAuth: true },
      'broker.chatgpt-required',
    ],
    [
      { authMethod: 'chatgpt', authToken: SECRET, requiresOpenaiAuth: true },
      'broker.invalid-token',
    ],
    [
      {
        ...auth(),
        authToken: fakeJwt({
          exp: '2000',
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct-fake' },
        }),
      },
      'broker.invalid-token',
    ],
    [{ ...auth(), authToken: fakeJwt({ exp: 2000 }) }, 'broker.invalid-token'],
    [
      {
        ...auth(),
        authToken: fakeJwt({
          exp: 2000,
          'https://api.openai.com/auth': { chatgpt_account_id: '' },
        }),
      },
      'broker.invalid-token',
    ],
    [
      {
        ...auth(),
        authToken: fakeJwt({
          exp: 2000,
          'https://api.openai.com/auth': { chatgpt_account_id: 123 },
        }),
      },
      'broker.invalid-token',
    ],
  ]
  for (const [reply, code] of failures) {
    const { broker } = await create(source('A', async () => reply))
    try {
      await assert.rejects(broker.get(), { message: code })
      assert.equal(broker.status().reason, code)
      assert.ok(!JSON.stringify(broker.status()).includes(SECRET))
    } finally {
      await broker.close()
    }
  }
})

test('RPC and refresh rejection messages never expose source error text', async () => {
  for (const refreshFails of [false, true]) {
    let calls = 0
    const { broker } = await create(
      source('A', async () => {
        calls++
        if (refreshFails && calls === 1) return auth(1040)
        throw new Error(SECRET)
      }),
    )
    try {
      await assert.rejects(broker.get(), { message: 'broker.auth-failed' })
      assert.equal(calls, refreshFails ? 2 : 1)
      assert.equal(broker.status().reason, 'broker.auth-failed')
    } finally {
      await broker.close()
    }
  }
})

test('no source, wrong home and wrong generation are refused without an auth RPC', async () => {
  const none = await create(null)
  try {
    await assert.rejects(none.broker.get(), { message: 'broker.no-source' })
  } finally {
    await none.broker.close()
  }
  for (const extra of [{ home: '/fake/other' }, { generation: 2 }]) {
    let calls = 0
    const { broker } = await create(
      source(
        'A',
        async () => {
          calls++
          return auth()
        },
        extra,
      ),
    )
    try {
      await assert.rejects(broker.get(), { message: 'broker.source-changed' })
      assert.equal(calls, 0)
    } finally {
      await broker.close()
    }
  }
})

test('loss of an elected source synchronously makes old leases stale', async () => {
  const { broker, elect } = await create(source('A', async () => auth()))
  try {
    const old = await broker.get()
    elect(null)
    assert.equal(broker.isCurrent(old), false)
    assert.equal(broker.status().ready, false)
    assert.equal(broker.status().source, 'none')
    await assert.rejects(broker.get(), { message: 'broker.no-source' })
  } finally {
    await broker.close()
  }
})

test('a generation change during an RPC cannot return the previous account lease', async () => {
  const oldReply = deferred<AuthStatus>()
  const started = deferred<void>()
  let account = { home: HOME, generation: 1 }
  const { broker, elect } = await create(
    source('A', async () => {
      started.resolve()
      return oldReply.promise
    }),
    () => account,
  )
  try {
    const waiting = broker.get()
    await started.promise
    account = { home: '/fake/next', generation: 2 }
    elect(source('B', async () => auth(3000, 'B'), { home: account.home, generation: 2 }))
    const next = await waiting
    oldReply.resolve(auth())
    await settleMicrotasks()
    assert.equal(next.sourceId, 'B')
    assert.equal(next.generation, 2)
    assert.equal((await broker.get()).generation, 2)
  } finally {
    await broker.close()
  }
})

test('close unsubscribes, wakes pending calls, drops readiness and is idempotent', async () => {
  const started = deferred<void>()
  const reply = deferred<AuthStatus>()
  const { broker, subscribers } = await create(
    source('A', async () => {
      started.resolve()
      return reply.promise
    }),
  )
  assert.equal(subscribers(), 1)
  const waiting = assert.rejects(broker.get(), { message: 'broker.closed' })
  await started.promise
  await broker.close()
  await waiting
  reply.resolve(auth())
  await settleMicrotasks()
  assert.equal(subscribers(), 0)
  assert.deepEqual(broker.status(), {
    ready: false,
    source: 'none',
    generation: 1,
    reason: 'broker.closed',
  })
  await broker.close()
  await assert.rejects(broker.get(), { message: 'broker.closed' })
})

test('standalone readiness is represented without publishing source IDs', async () => {
  const { broker } = await create(
    source('standalone-private-id', async () => auth(), { kind: 'standalone' }),
  )
  try {
    await broker.get()
    assert.deepEqual(broker.status(), {
      ready: true,
      source: 'standalone',
      generation: 1,
      reason: null,
    })
  } finally {
    await broker.close()
  }
})
