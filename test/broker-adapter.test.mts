import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { connectBrokerSource, readBrokerSources } from '../src/broker-source.mjs'
import type { CodexChildEvent } from '../src/codex-upstream.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const load = () => import('../src/' + 'broker-adapter.mjs')
const auth = { authMethod: 'chatgpt', authToken: 'fake-memory-only', requiresOpenaiAuth: true }

async function fixture(enabled = true) {
  const root = await tempDir('ba-')
  const home = join(root, 'h')
  mkdirSync(home, { mode: 0o700 })
  const listeners = new Set<(event: CodexChildEvent) => void>()
  const calls: unknown[] = []
  const upstream = {
    onChildLifecycle(listener: (event: CodexChildEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async requestForChild(...args: unknown[]) {
      calls.push(args)
      return auth
    },
  }
  const registration = (await load()).registerAdapterBrokerSource({
    root,
    enabled,
    account: () => ({ home, generation: 1 }),
    upstream,
  })
  const emit = (event: CodexChildEvent) => {
    for (const listener of listeners) listener(event)
  }
  return { root, home, calls, registration, emit, listeners }
}

test('adapter registers only initialized children and binds the auth RPC to that child', async () => {
  const f = await fixture()
  const account = { home: f.home, generation: 1 }
  try {
    assert.deepEqual(readBrokerSources(f.root, account), [])
    f.emit({ type: 'ready', childId: 'A', pid: process.pid })
    await f.registration.settled()
    const [first] = readBrokerSources(f.root, account)
    assert.ok(first)
    assert.equal(first.childId, 'A')
    const client = await connectBrokerSource(first, () => {})
    try {
      assert.deepEqual(
        await client.request('getAuthStatus', { includeToken: true, refreshToken: true }),
        auth,
      )
      assert.deepEqual(f.calls, [
        ['A', 'getAuthStatus', { includeToken: true, refreshToken: true }, 10_000],
      ])
      f.emit({ type: 'exit', childId: 'A' })
      assert.deepEqual(readBrokerSources(f.root, account), [])
      f.emit({ type: 'ready', childId: 'B', pid: process.pid })
      await f.registration.settled()
      const [second] = readBrokerSources(f.root, account)
      assert.ok(second)
      assert.equal(second.childId, 'B')
      assert.notEqual(second.id, first.id)
      f.emit({ type: 'exit', childId: 'A' })
      assert.equal(readBrokerSources(f.root, account)[0]?.id, second.id)
    } finally {
      await client.close()
    }
  } finally {
    await f.registration.close()
  }
  assert.equal(f.listeners.size, 0)
  assert.deepEqual(readBrokerSources(f.root, account), [])
})

test('an exit or shutdown during socket creation cannot publish a late source', async () => {
  const f = await fixture()
  try {
    f.emit({ type: 'ready', childId: 'A', pid: process.pid })
    f.emit({ type: 'exit', childId: 'A' })
    await f.registration.settled()
    assert.deepEqual(readBrokerSources(f.root, { home: f.home, generation: 1 }), [])
    f.emit({ type: 'ready', childId: 'B', pid: process.pid })
    await f.registration.close()
    assert.deepEqual(readBrokerSources(f.root, { home: f.home, generation: 1 }), [])
  } finally {
    await f.registration.close()
  }
})

test('mocked and reserve-only adapters publish no broker source', async () => {
  const f = await fixture(false)
  try {
    f.emit({ type: 'ready', childId: 'mock', pid: process.pid })
    await f.registration.settled()
    assert.equal(f.listeners.size, 0)
    assert.deepEqual(readBrokerSources(f.root, { home: f.home, generation: 1 }), [])
  } finally {
    await f.registration.close()
  }
})
