import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const load = () => import('../src/' + 'broker-runtime.mjs')

test('router broker stays lazy and exposes active admissions for the drain gate', async () => {
  const root = await tempDir('br-')
  const home = join(root, 'h')
  mkdirSync(home, { mode: 0o700 })
  let generation = 1
  let launches = 0
  const runtime = (await load()).createRouterBroker({
    root,
    account: () => ({ home, generation }),
    launch: async () => {
      launches++
      throw new Error('no auth child should be requested')
    },
  })
  try {
    assert.equal(runtime.broker.status().ready, false)
    assert.equal(launches, 0)
    assert.equal(runtime.activeRequests(), 0)
    const first = await runtime.admission.begin()
    assert.equal(first.generation, 1)
    generation = 2
    const second = await runtime.admission.begin()
    assert.equal(second.generation, 2)
    assert.equal(first.generation, 1)
    assert.equal(runtime.activeRequests(), 2)
    await first.release()
    await first.release()
    assert.equal(runtime.activeRequests(), 1)
    const aborted = AbortSignal.abort()
    await assert.rejects(runtime.admission.begin(aborted), /broker\.request-aborted/)
    assert.equal(runtime.activeRequests(), 1)
    await second.release()
    assert.equal(runtime.activeRequests(), 0)
    assert.equal(launches, 0)
  } finally {
    await runtime.close()
  }
  await assert.rejects(runtime.admission.begin(), /broker\.no-source/)
})

test('a missing Codex home leaves health and shutdown usable without launching a child', async () => {
  const root = await tempDir('br-')
  let launches = 0
  const runtime = (await load()).createRouterBroker({
    root,
    account: () => ({ home: join(root, 'missing'), generation: 1 }),
    launch: async () => {
      launches++
      throw new Error('missing home must prevent a launch')
    },
  })
  try {
    assert.equal(runtime.broker.status().ready, false)
    assert.equal(runtime.broker.status().source, 'none')
    await assert.rejects(runtime.broker.get(), /broker\.no-source/)
    assert.equal(launches, 0)
  } finally {
    await runtime.close()
  }
})

test('shutdown denies new admission immediately and joins every live request before sources close', async () => {
  const root = await tempDir('br-')
  const runtime = (await load()).createRouterBroker({
    root,
    account: () => ({ home: join(root, 'missing'), generation: 1 }),
    launch: async () => {
      throw new Error('unexpected auth launch')
    },
  })
  const lease = await runtime.admission.begin()
  let joined = false
  const closing = runtime.close().then(() => {
    joined = true
  })
  await assert.rejects(runtime.admission.begin(), /broker\.no-source/)
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(joined, false)
  assert.equal(runtime.activeRequests(), 1)
  await lease.release()
  await closing
  assert.equal(joined, true)
  assert.equal(runtime.activeRequests(), 0)
})
