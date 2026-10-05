import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import http, { type ServerResponse } from 'node:http'
import { join } from 'node:path'
import test, { after, type TestContext } from 'node:test'
import type {
  AccountAdmission,
  AuthSource,
  BrokerLease,
  BrokerOwner,
  TokenBroker,
} from '../src/broker-types.mjs'
import { gptEntry } from './helpers/fake-backend.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const load = () => import('../src/' + 'claude-catalog.mjs')
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(t: TestContext) {
  const root = await tempDir('gc-')
  let lease: BrokerLease = {
    bearer: 'FAKE_BROKER_ONLY_A',
    accountId: 'acct-fixture-A',
    generation: 1,
    sourceId: 'A',
    sourceRevision: 1,
    cacheRevision: 1,
  }
  const changes = new Set<Parameters<BrokerOwner['onChange']>[0]>()
  const source = (): AuthSource => ({
    id: lease.sourceId,
    home: '/fixture',
    generation: lease.generation,
    request: async () => ({ authMethod: null, authToken: null, requiresOpenaiAuth: true }),
  })
  const owner: BrokerOwner = {
    current: () => ({ revision: lease.sourceRevision, source: source() }),
    source: async () => ({ revision: lease.sourceRevision, source: source() }),
    onChange: (listener) => {
      changes.add(listener)
      return () => changes.delete(listener)
    },
    stopSources: async () => {},
    close: async () => {},
  }
  let gets = 0
  const broker: TokenBroker = {
    get: async () => {
      gets++
      return lease
    },
    isCurrent: (value) => value === lease,
    invalidate: () => {},
    close: async () => {},
    status: () => ({ ready: true, source: 'adapter', generation: lease.generation, reason: null }),
  }
  const requests: { path: string; headers: http.IncomingHttpHeaders }[] = []
  let respond: (res: ServerResponse) => void = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ models: [gptEntry('gpt-shared', 1, { use_responses_lite: true })] }))
  }
  const received = deferred<ServerResponse>()
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url ?? '', headers: req.headers })
    received.resolve(res)
    respond(res)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const upstream = new URL(`http://127.0.0.1:${address.port}/backend-api/codex`)
  const catalogs = (await load()).createGptCatalogs({
    root,
    upstream,
    broker,
    owner,
    now: () => 1_000,
  })
  return {
    root,
    upstream,
    broker,
    owner,
    catalogs,
    requests,
    received,
    current: () => lease,
    gets: () => gets,
    respond: (next: typeof respond) => {
      respond = next
    },
    elect(id: string, generation = lease.generation) {
      lease = {
        bearer: `FAKE_BROKER_ONLY_${id}`,
        accountId: `acct-fixture-${id}`,
        generation,
        sourceId: id,
        sourceRevision: lease.sourceRevision + 1,
        cacheRevision: lease.cacheRevision + 1,
      }
      for (const listener of changes) listener(owner.current())
    },
  }
}

test('catalog coalesces by exact lease and writes only private diagnostic model metadata', async (t) => {
  const f = await fixture(t)
  const snapshots = await Promise.all(
    Array.from({ length: 7 }, () => f.catalogs.get(f.current(), new AbortController().signal)),
  )
  assert.equal(f.requests.length, 1)
  const first = snapshots[0]
  assert.equal(first.generation, 1)
  assert.equal(first.sourceId, 'A')
  assert.equal(first.sourceRevision, 1)
  assert.equal(first.cacheRevision, 1)
  assert.equal(first.models[0]?.lite, true)
  assert.ok(snapshots.every((snapshot) => snapshot === first))
  assert.equal(f.requests[0]?.headers.authorization, 'Bearer FAKE_BROKER_ONLY_A')
  assert.equal(f.requests[0]?.headers['chatgpt-account-id'], 'acct-fixture-A')
  const path = join(f.root, 'router/claude-gpt-catalog.json')
  assert.equal(lstatSync(path).mode & 0o777, 0o600)
  const raw = readFileSync(path, 'utf8')
  assert.equal(raw.includes('FAKE_BROKER'), false)
  assert.equal(raw.includes('acct-fixture'), false)
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), [
    'cacheRevision',
    'fetchedAt',
    'generation',
    'models',
    'sourceId',
    'sourceRevision',
  ])
  f.catalogs.invalidate()
  await f.catalogs.get(f.current(), new AbortController().signal)
  assert.equal(f.requests.length, 2)
})

test('election wakes stale catalog waiters before held A settles and cannot publish A over B', async (t) => {
  const f = await fixture(t)
  f.respond(() => {})
  const old = f.catalogs.get(f.current(), new AbortController().signal)
  const rejected = assert.rejects(old, /catalog\.source-changed/)
  const a = await f.received.promise
  f.elect('B')
  await rejected
  f.respond((res) =>
    res.end(JSON.stringify({ models: [gptEntry('gpt-shared', 1, { use_responses_lite: false })] })),
  )
  const replacement = await f.catalogs.get(f.current(), new AbortController().signal)
  assert.equal(replacement.sourceId, 'B')
  assert.equal(replacement.models[0]?.lite, false)
  a.end(JSON.stringify({ models: [gptEntry('gpt-a-only', 1, { use_responses_lite: true })] }))
  assert.equal((await f.catalogs.get(f.current(), new AbortController().signal)).sourceId, 'B')
  assert.equal(
    JSON.parse(readFileSync(join(f.root, 'router/claude-gpt-catalog.json'), 'utf8')).sourceId,
    'B',
  )
})

test('catalog never follows redirects or trusts a persisted snapshot after restart', async (t) => {
  const f = await fixture(t)
  await f.catalogs.get(f.current(), new AbortController().signal)
  f.respond((res) => {
    res.writeHead(302, { location: 'https://example.invalid/steal' })
    res.end()
  })
  const restarted = (await load()).createGptCatalogs({
    root: f.root,
    upstream: f.upstream,
    broker: f.broker,
    owner: f.owner,
  })
  await assert.rejects(
    restarted.get(f.current(), new AbortController().signal),
    /catalog\.unavailable/,
  )
  assert.equal(f.requests.length, 2)
})

test('settings view waits for admission, uses B only and releases once without source or auth fields', async (t) => {
  const f = await fixture(t)
  const gate = deferred<void>()
  let released = 0
  const admission: AccountAdmission = {
    async begin() {
      await gate.promise
      return {
        generation: 2,
        release: async () => {
          released++
        },
      }
    },
  }
  const pending = (await load()).readGptSettingsView({
    admission,
    broker: f.broker,
    catalogs: f.catalogs,
    signal: new AbortController().signal,
  })
  assert.equal(f.gets(), 0)
  assert.equal(f.requests.length, 0)
  f.elect('B', 2)
  gate.resolve()
  const view = await pending
  assert.equal(view.generation, 2)
  assert.equal(released, 1)
  assert.deepEqual(Object.keys(view).sort(), ['fetchedAt', 'generation', 'models'])
  assert.equal(JSON.stringify(view).includes('FAKE_BROKER'), false)
  assert.equal(JSON.stringify(view).includes('acct-fixture'), false)
})

test('catalog abort and generation mismatch release settings admission and publish no snapshot', async (t) => {
  const f = await fixture(t)
  f.respond(() => {})
  const signal = new AbortController()
  const request = f.catalogs.get(f.current(), signal.signal)
  const rejected = assert.rejects(request, /catalog\.(request-aborted|unavailable)/)
  await f.received.promise
  signal.abort()
  await rejected
  assert.equal(existsSync(join(f.root, 'router/claude-gpt-catalog.json')), false)
  let released = 0
  const admission: AccountAdmission = {
    begin: async () => ({
      generation: 99,
      release: async () => {
        released++
      },
    }),
  }
  await assert.rejects(
    (await load()).readGptSettingsView({
      admission,
      broker: f.broker,
      catalogs: f.catalogs,
      signal: new AbortController().signal,
    }),
    /catalog\.source-changed/,
  )
  assert.equal(released, 1)
  assert.equal(f.requests.length, 1)
})
