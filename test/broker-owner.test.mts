import assert from 'node:assert/strict'
import { mkdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { readBrokerSources, startBrokerSource } from '../src/broker-source.mjs'
import type { AuthSource } from '../src/broker-types.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const load = () => import('../src/' + 'broker-owner.mjs')
const result = { authMethod: 'chatgpt', authToken: 'fake-memory-only', requiresOpenaiAuth: true }
async function setup() {
  const root = await tempDir('bo-')
  const home = join(root, 'codex')
  mkdirSync(home)
  let launches = 0,
    closes = 0
  const owner = (await load()).createBrokerOwner({
    root,
    account: () => ({ home, generation: 1 }),
    launch: async (canonical: string) => {
      assert.equal(canonical, home)
      launches++
      return {
        id: 'fake-standalone',
        kind: 'standalone' as const,
        home,
        generation: 1,
        request: async () => result,
        close: async () => {
          closes++
        },
      }
    },
  })
  return { root, home, owner, counts: () => ({ launches, closes }) }
}

test('owner lazily coalesces its standalone launch and shutdown joins that source once', async () => {
  const s = await setup()
  try {
    assert.equal(s.owner.current().source, null)
    assert.deepEqual(s.counts(), { launches: 0, closes: 0 })
    const selections = await Promise.all(Array.from({ length: 7 }, () => s.owner.source()))
    assert.equal(new Set(selections.map((item) => item.source.id)).size, 1)
    assert.deepEqual(s.counts(), { launches: 1, closes: 0 })
    const revisions: number[] = []
    s.owner.onChange((next: { revision: number }) => revisions.push(next.revision))
    await s.owner.stopSources()
    assert.equal(s.owner.current().source, null)
    assert.deepEqual(s.counts(), { launches: 1, closes: 1 })
    assert.equal(revisions.length, 1)
    await assert.rejects(s.owner.source(), /broker\.no-source/)
  } finally {
    await s.owner.close()
  }
  assert.deepEqual(s.counts(), { launches: 1, closes: 1 })
})

test('oldest ready adapter wins and shutdown closes IPC without terminating adapters', async () => {
  const s = await setup()
  const start = (childId: string) =>
    startBrokerSource({
      root: s.root,
      home: s.home,
      generation: 1,
      childId,
      pid: process.pid,
      request: async () => result,
    })
  const first = await start('first'),
    second = await start('second')
  utimesSync(join(s.root, 'broker/sources', `${first.id}.json`), 1, 1)
  utimesSync(join(s.root, 'broker/sources', `${second.id}.json`), 2, 2)
  try {
    const selected = await s.owner.source()
    assert.equal(selected.source.id, first.id)
    assert.deepEqual(s.counts(), { launches: 0, closes: 0 })
    await s.owner.close()
    assert.equal(readBrokerSources(s.root, { home: s.home, generation: 1 }).length, 2)
    assert.doesNotThrow(() => process.kill(process.pid, 0))
  } finally {
    await s.owner.close()
    await first.close()
    await second.close()
  }
})

test('a ready replacement is elected when the selected socket closes, without waiting for its RPC', async () => {
  const s = await setup()
  const first = await startBrokerSource({
    root: s.root,
    home: s.home,
    generation: 1,
    childId: 'A',
    pid: process.pid,
    request: async () => result,
  })
  const second = await startBrokerSource({
    root: s.root,
    home: s.home,
    generation: 1,
    childId: 'B',
    pid: process.pid,
    request: async () => result,
  })
  utimesSync(join(s.root, 'broker/sources', `${first.id}.json`), 1, 1)
  utimesSync(join(s.root, 'broker/sources', `${second.id}.json`), 2, 2)
  try {
    const before = await s.owner.source()
    assert.equal(before.source.id, first.id)
    let changed: (source: AuthSource) => void = () => {}
    const replaced = new Promise<AuthSource>((done) => {
      changed = done
    })
    s.owner.onChange((next: { source: AuthSource | null }) => {
      if (next.source?.id === second.id) changed(next.source)
    })
    await first.close()
    assert.equal((await replaced).id, second.id)
    assert.ok(s.owner.current().revision > before.revision)
    assert.equal(s.owner.current().source?.id, second.id)
    assert.deepEqual(s.counts(), { launches: 0, closes: 0 })
  } finally {
    await s.owner.close()
    await first.close()
    await second.close()
  }
})

test('standalone ownership excludes another router and releases only after its child is joined', async () => {
  const s = await setup()
  const other = (await load()).createBrokerOwner({
    root: s.root,
    account: () => ({ home: s.home, generation: 1 }),
    launch: async () => {
      throw new Error('second launcher must never run')
    },
  })
  try {
    await s.owner.source()
    await assert.rejects(other.source(), /broker\.owner-busy/)
    assert.deepEqual(s.counts(), { launches: 1, closes: 0 })
    await s.owner.close()
  } finally {
    await s.owner.close()
    await other.close()
  }
})
