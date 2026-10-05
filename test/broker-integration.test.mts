import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { createTokenBroker } from '../src/broker-cache.mjs'
import { createBrokerOwner } from '../src/broker-owner.mjs'
import { startBrokerSource } from '../src/broker-source.mjs'
import type { AuthSource, AuthStatus, SourceSelection } from '../src/broker-types.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const bounded = { timeout: 30_000 }
const NOW = 1_000_000
const SECRET = 'FAKE_SECRET_MARKER_integration'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function auth(id: string): AuthStatus {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return {
    authMethod: 'chatgpt',
    authToken: `${encode({ alg: 'none' })}.${encode({ exp: 3000, fixture: `${SECRET}-${id}`, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-fixture' } })}.unsigned`,
    requiresOpenaiAuth: true,
  }
}

async function fixture() {
  const root = realpathSync(await tempDir('bi-'))
  const home = join(root, 'h')
  mkdirSync(home, { mode: 0o700 })
  const account = () => ({ home, generation: 1 })
  return { root, home, account }
}

const refuseLaunch = async (): Promise<AuthSource & { close(): Promise<void> }> => {
  throw new Error('registered adapter must prevent a standalone launch')
}

function nextSource(owner: ReturnType<typeof createBrokerOwner>, id: string) {
  const changed = deferred<SourceSelection>()
  const unsubscribe = owner.onChange((selection) => {
    if (selection.source?.id === id) changed.resolve(selection)
  })
  return { changed: changed.promise, unsubscribe }
}

test(
  'cold cache and real owner/socket coalesce seven callers into one auth RPC',
  bounded,
  async () => {
    const f = await fixture()
    const entered = deferred<void>()
    const reply = deferred<AuthStatus>()
    let calls = 0
    const registration = await startBrokerSource({
      root: f.root,
      home: f.home,
      generation: 1,
      childId: 'cold',
      pid: process.pid,
      request: async (method, params) => {
        assert.equal(method, 'getAuthStatus')
        assert.deepEqual(params, { includeToken: true, refreshToken: false })
        calls++
        entered.resolve()
        return reply.promise
      },
    })
    const owner = createBrokerOwner({ ...f, launch: refuseLaunch })
    const broker = createTokenBroker({ owner, account: f.account, now: () => NOW })
    try {
      assert.equal(owner.current().source, null)
      const joined = Promise.all(Array.from({ length: 7 }, () => broker.get()))
      void joined.catch(() => {})
      await entered.promise
      assert.equal(calls, 1)
      reply.resolve(auth('cold'))
      const leases = await joined
      assert.ok(
        leases.every((lease) => lease.sourceId === registration.id && broker.isCurrent(lease)),
      )
      assert.equal((await broker.get()).bearer, leases[0]?.bearer)
      assert.equal(calls, 1)
      assert.equal(JSON.stringify(broker.status()).includes(SECRET), false)
    } finally {
      reply.resolve(auth('cleanup'))
      await broker.close()
      await registration.close()
    }
  },
)

for (const order of ['A-before-B', 'B-before-A', 'A-error-after-B'] as const) {
  test(
    `socket loss elects pre-connected B while A auth remains held: ${order}`,
    bounded,
    async () => {
      const f = await fixture()
      const aEntered = deferred<void>()
      const bEntered = deferred<void>()
      const aReply = deferred<AuthStatus>()
      const bReply = deferred<AuthStatus>()
      const aFinished = deferred<void>()
      let aSettled = false
      let aCalls = 0
      let bCalls = 0
      const a = await startBrokerSource({
        root: f.root,
        home: f.home,
        generation: 1,
        childId: 'A',
        pid: process.pid,
        request: async () => {
          aCalls++
          aEntered.resolve()
          try {
            return await aReply.promise
          } finally {
            aSettled = true
            aFinished.resolve()
          }
        },
      })
      const b = await startBrokerSource({
        root: f.root,
        home: f.home,
        generation: 1,
        childId: 'B',
        pid: process.pid,
        request: async () => {
          bCalls++
          bEntered.resolve()
          return bReply.promise
        },
      })
      utimesSync(join(f.root, 'broker/sources', `${a.id}.json`), 1, 1)
      utimesSync(join(f.root, 'broker/sources', `${b.id}.json`), 2, 2)
      const owner = createBrokerOwner({ ...f, launch: refuseLaunch })
      const first = await owner.source()
      assert.equal(first.source.id, a.id)
      const switched = nextSource(owner, b.id)
      const broker = createTokenBroker({ owner, account: f.account, now: () => NOW })
      try {
        const joined = Promise.all(Array.from({ length: 7 }, () => broker.get()))
        // Observe rejection immediately even if a broken replacement drops a waiter.
        void joined.catch(() => {})
        await aEntered.promise
        assert.equal(aCalls, 1)
        await a.close()
        const elected = await switched.changed
        assert.equal(aSettled, false, 'source election must not wait for old auth')
        assert.ok(elected.revision > first.revision)
        assert.equal(owner.current().source?.id, b.id)
        await bEntered.promise
        assert.equal(bCalls, 1)
        if (order === 'A-before-B') {
          aReply.resolve(auth('A'))
          await aFinished.promise
          assert.equal(owner.current().source?.id, b.id)
        }
        bReply.resolve(auth('B'))
        const leases = await joined
        if (order === 'B-before-A') aReply.resolve(auth('A'))
        if (order === 'A-error-after-B') aReply.reject(new Error(SECRET))
        await aFinished.promise
        assert.ok(
          leases.every(
            (lease) => lease.sourceId === b.id && lease.sourceRevision === elected.revision,
          ),
        )
        assert.equal((await broker.get()).bearer, leases[0]?.bearer)
        assert.equal(aCalls, 1)
        assert.equal(bCalls, 1)
      } finally {
        switched.unsubscribe()
        aReply.resolve(auth('cleanup-A'))
        bReply.resolve(auth('cleanup-B'))
        await broker.close()
        await a.close()
        await b.close()
      }
    },
  )
}

test(
  'same-generation invalidate renews elected B without changing its source revision',
  bounded,
  async () => {
    const f = await fixture()
    let bCalls = 0
    const a = await startBrokerSource({
      root: f.root,
      home: f.home,
      generation: 1,
      childId: 'A',
      pid: process.pid,
      request: async () => auth('A'),
    })
    const b = await startBrokerSource({
      root: f.root,
      home: f.home,
      generation: 1,
      childId: 'B',
      pid: process.pid,
      request: async () => {
        bCalls++
        return auth(`B-${bCalls}`)
      },
    })
    utimesSync(join(f.root, 'broker/sources', `${a.id}.json`), 1, 1)
    utimesSync(join(f.root, 'broker/sources', `${b.id}.json`), 2, 2)
    const owner = createBrokerOwner({ ...f, launch: refuseLaunch })
    await owner.source()
    const switched = nextSource(owner, b.id)
    const broker = createTokenBroker({ owner, account: f.account, now: () => NOW })
    try {
      const old = await broker.get()
      await a.close()
      await switched.changed
      assert.equal(broker.isCurrent(old), false)
      const before = await broker.get()
      assert.equal(bCalls, 1)
      broker.invalidate(1)
      assert.equal(broker.isCurrent(before), false)
      assert.equal(broker.status().ready, false)
      const after = await broker.get()
      assert.equal(after.sourceId, b.id)
      assert.equal(after.sourceRevision, before.sourceRevision)
      assert.ok(after.cacheRevision > before.cacheRevision)
      assert.equal(bCalls, 2)
    } finally {
      switched.unsubscribe()
      await broker.close()
      await a.close()
      await b.close()
    }
  },
)

test(
  'closing during a held standalone launch joins the returned source before unlocking',
  bounded,
  async () => {
    const f = await fixture()
    const launching = deferred<void>()
    const launched = deferred<AuthSource & { close(): Promise<void> }>()
    const joining = deferred<void>()
    const joined = deferred<void>()
    let otherLaunches = 0
    const owner = createBrokerOwner({
      ...f,
      launch: async () => {
        launching.resolve()
        return launched.promise
      },
    })
    const other = createBrokerOwner({
      ...f,
      launch: async (home) => {
        otherLaunches++
        return {
          id: 'other',
          kind: 'standalone',
          home,
          generation: 1,
          request: async () => auth('other'),
          close: async () => {},
        }
      },
    })
    const selection = owner.source()
    const refused = assert.rejects(selection, /broker\.source-changed/)
    try {
      await launching.promise
      const closed = owner.close()
      await assert.rejects(other.source(), /broker\.owner-busy/)
      launched.resolve({
        id: 'late',
        kind: 'standalone',
        home: f.home,
        generation: 1,
        request: async () => auth('late'),
        close: async () => {
          joining.resolve()
          await joined.promise
        },
      })
      await joining.promise
      await assert.rejects(other.source(), /broker\.owner-busy/)
      assert.equal(otherLaunches, 0)
      joined.resolve()
      await closed
      await refused
      assert.equal((await other.source()).source.id, 'other')
      assert.equal(otherLaunches, 1)
    } finally {
      joined.resolve()
      launched.resolve({
        id: 'cleanup',
        kind: 'standalone',
        home: f.home,
        generation: 1,
        request: async () => auth('cleanup'),
        close: async () => {},
      })
      await owner.close().catch(() => {})
      await other.close()
    }
  },
)

test(
  'failed standalone shutdown retains the ownership lock and refuses the dead source',
  bounded,
  async () => {
    const f = await fixture()
    let generation = 1
    let allowJoin = false
    let authCalls = 0
    let launches = 0
    let closes = 0
    const account = () => ({ home: f.home, generation })
    const owner = createBrokerOwner({
      root: f.root,
      account,
      launch: async (home) => {
        launches++
        return {
          id: 'owned',
          kind: 'standalone',
          home,
          generation,
          request: async () => {
            authCalls++
            return auth('owned')
          },
          close: async () => {
            closes++
            if (!allowJoin) throw new Error(SECRET)
          },
        }
      },
    })
    const other = createBrokerOwner({ root: f.root, account, launch: refuseLaunch })
    try {
      const selected = await owner.source()
      assert.equal(selected.source.id, 'owned')
      await assert.rejects(owner.stopSources(), /broker\.source-unavailable/)
      assert.equal(owner.current().source, null)
      generation = 2
      await assert.rejects(owner.source(), /broker\.source-unavailable/)
      assert.equal(launches, 1, 'failed cleanup must not permit another standalone launch')
      assert.equal(authCalls, 0, 'a stopped source must not serve an auth request')
      await assert.rejects(other.source(), /broker\.owner-busy/)
      assert.equal(closes, 1)
      allowJoin = true
      await owner.stopSources()
      assert.equal(closes, 2)
    } finally {
      allowJoin = true
      await owner.stopSources().catch(() => {})
      await owner.close().catch(() => {})
      await other.close()
    }
  },
)

test(
  'a failed join of a late launch retains ownership until that source can be joined',
  bounded,
  async () => {
    const f = await fixture()
    const launching = deferred<void>()
    const launched = deferred<AuthSource & { close(): Promise<void> }>()
    let allowJoin = false
    let closes = 0
    const owner = createBrokerOwner({
      ...f,
      launch: async () => {
        launching.resolve()
        return launched.promise
      },
    })
    const other = createBrokerOwner({ ...f, launch: refuseLaunch })
    const selection = owner.source()
    const failedSelection = assert.rejects(selection, /broker\.source-unavailable/)
    try {
      await launching.promise
      const closing = owner.close()
      launched.resolve({
        id: 'late',
        kind: 'standalone',
        home: f.home,
        generation: 1,
        request: async () => auth('late'),
        close: async () => {
          closes++
          if (!allowJoin) throw new Error(SECRET)
        },
      })
      await failedSelection
      await closing.catch(() => {})
      assert.equal(owner.current().source, null)
      await assert.rejects(other.source(), /broker\.owner-busy/)
      assert.equal(closes, 1)
      allowJoin = true
      await owner.stopSources()
      assert.equal(closes, 2)
    } finally {
      allowJoin = true
      launched.resolve({
        id: 'cleanup',
        kind: 'standalone',
        home: f.home,
        generation: 1,
        request: async () => auth('cleanup'),
        close: async () => {},
      })
      await owner.stopSources().catch(() => {})
      await owner.close().catch(() => {})
      await other.close()
    }
  },
)
