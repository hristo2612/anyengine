import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { type MuxLocalServer, NativeCodexMux } from '../src/codex-mux.mjs'
import { CodexUpstream } from '../src/codex-upstream.mjs'
import { inheritedInfo, NativeChildren } from '../src/native-children.mjs'
import {
  DEFAULT_POSTURE,
  outcomeRank,
  type Posture,
  postureContext,
  reach,
  STRICTEST_POSTURE,
  sandboxedOutcome,
} from '../src/posture.mjs'
import { SessionStore } from '../src/store.mjs'
import type { RpcPeer, WireMessage } from '../src/types.mjs'
import { killChildren } from './helpers/children.mjs'
import { everyPosture, probes } from './helpers/postures.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const stops: Array<() => Promise<void>> = []
after(async () => {
  for (const stop of stops.splice(0)) await stop()
  await killChildren()
  await removeTempDirs()
})

const recordings = [
  'test/fixtures/codex-spawn-0.160.0.json',
  'test/fixtures/codex-spawn-0.159.0.json',
  'test/fixtures/codex-spawn-0.155-spike.json',
]
  .map((p) => resolve(p))
  .map((p) => JSON.parse(readFileSync(p, 'utf8')))
  .filter((r) => r.multiAgentToolsOffered !== false)

test('children: every recorded link shape names the child and its parent', () => {
  assert.ok(recordings.length > 0)
  for (const rec of recordings) {
    const children = new NativeChildren()
    for (const n of rec.notifications as Array<{
      method: string
      item?: Record<string, unknown>
      thread?: Record<string, unknown>
    }>) {
      if (n.item) children.observeItem(n.item)
      if (n.method === 'thread/started' && n.thread) children.observeThread(n.thread)
    }
    const child = children.get('CHILD')
    assert.equal(child?.parentThreadId, 'PARENT', rec.codexVersion)
  }
})

test('children: an in-progress spawn, a wait, and a non-collab item link nothing', () => {
  const children = new NativeChildren()
  assert.deepEqual(
    children.observeItem({
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      senderThreadId: 'p',
      receiverThreadIds: [],
      model: 'opus',
    }),
    [],
  )
  assert.deepEqual(
    children.observeItem({
      type: 'collabAgentToolCall',
      tool: 'wait',
      senderThreadId: 'p',
      receiverThreadIds: ['c'],
    }),
    [],
  )
  assert.deepEqual(children.observeItem({ type: 'agentMessage', text: 'x' }), [])
  const linked = children.observeItem({
    type: 'collabAgentToolCall',
    tool: 'spawnAgent',
    senderThreadId: 'p',
    receiverThreadIds: ['c1', 'c2'],
    model: 'opus',
  })
  assert.deepEqual(
    linked.map((c) => [c.threadId, c.parentThreadId, c.model]),
    [
      ['c1', 'p', 'opus'],
      ['c2', 'p', 'opus'],
    ],
  )
  assert.equal(
    children.observeThread({
      id: 'c3',
      source: { subagent: { thread_spawn: { parent_thread_id: 'p' } } },
    })?.parentThreadId,
    'p',
  )
  assert.equal(
    children.observeThread({
      id: 'c4',
      source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } },
    })?.parentThreadId,
    'p',
  )
  assert.equal(children.observeThread({ id: 'root' }), null)
})

test('children: a waiter wakes when the link arrives, and gives up after its time', async () => {
  const children = new NativeChildren()
  const waiting = children.waitFor('late', 30_000)
  children.observeItem({
    type: 'collabAgentToolCall',
    tool: 'spawnAgent',
    senderThreadId: 'p',
    receiverThreadIds: ['late'],
    model: 'opus',
  })
  assert.equal((await waiting)?.parentThreadId, 'p')
  assert.equal(await children.waitFor('never', 50), null)
  assert.deepEqual(
    inheritedInfo({ threadId: 'x', parentThreadId: 'p', model: 'opus', cwd: null }, null).posture,
    STRICTEST_POSTURE,
  )
})

// The mux, in process, against the fake codex child: what a claim will see.
async function muxWithFakeChild(root: string, order = 'child-first', model = 'opus') {
  mkdirSync(join(root, 'home'), { recursive: true })
  const store = new SessionStore(join(root, 'state.sqlite'))
  let mux: NativeCodexMux | null = null
  const upstream = new CodexUpstream({
    binary: process.execPath,
    args: [resolve('test/fixtures/fake-codex-app-server.mjs'), 'app-server'],
    env: {
      ...process.env,
      FAKE_CODEX_SPAWN_CHILD: model,
      FAKE_CODEX_SPAWN_ORDER: order,
      FAKE_CODEX_NO_APPROVAL: '1',
    },
    onMessage: (message: WireMessage) => mux?.onUpstreamMessage(message),
  })
  const local: MuxLocalServer = {
    dispatch: async () => ({}),
    localThreadOwner: () => null,
    localThreadModel: () => null,
    localThreadPosture: () => DEFAULT_POSTURE,
    hasActiveTurn: () => false,
    adoptThread: () => {},
  }
  mux = new NativeCodexMux({ store, upstream, local })
  stops.push(async () => {
    await mux?.stop()
    store.close()
  })
  const sent: WireMessage[] = []
  const peer: RpcPeer = { id: 'app', send: (m) => sent.push(m), close: () => {} }
  let id = 0
  const request = async (method: string, params: unknown) => {
    const n = ++id
    await mux?.handle(peer, { jsonrpc: '2.0', id: n, method, params } as WireMessage)
    for (const until = Date.now() + 30_000; Date.now() < until; ) {
      const answer = sent.find((m) => 'id' in m && m.id === n && !('method' in m))
      if (answer) return answer as Record<string, any>
      await new Promise((ok) => setTimeout(ok, 10))
    }
    throw new Error(`no answer to ${method}`)
  }
  return { mux, request, sent, upstream }
}

test('mux: a spawned child is claimable under its parent posture; a later tightening narrows it; an unknown parent is the strictest', async () => {
  const root = await tempDir('ae-mux-')
  const { mux, request } = await muxWithFakeChild(root)
  await request('initialize', { clientInfo: { name: 't', version: '0' } })
  const started = await request('thread/start', {
    model: 'gpt-6-sol',
    cwd: root,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
  })
  const parent = started.result.thread.id as string
  await request('turn/start', { threadId: parent, input: [{ type: 'text', text: 'spawn one' }] })
  const child = await mux.waitForClaimThread('fake-child-fake-turn-1', 2000)
  assert.ok(child, 'the child is known without any thread/started')
  assert.equal(child.parentThreadId, parent)
  assert.equal(child.parentCwd, root)
  assert.equal(child.posture.fileSystem.kind, 'workspace-write')
  await request('turn/start', {
    threadId: parent,
    sandboxPolicy: { type: 'readOnly' },
    input: [{ type: 'text', text: 'again' }],
  })
  assert.equal(
    mux.claimThread(child.threadId)?.posture.fileSystem.kind,
    'read-only',
    'the parent tightened, so the child did',
  )
  mux.onUpstreamMessage({
    jsonrpc: '2.0',
    method: 'item/completed',
    params: {
      threadId: 'ghost',
      item: {
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        senderThreadId: 'ghost',
        receiverThreadIds: ['orphan'],
        model: 'opus',
      },
    },
  } as WireMessage)
  assert.deepEqual(mux.claimThread('orphan')?.posture, STRICTEST_POSTURE)
  assert.equal(mux.knowsThread(parent), true)
  assert.equal(mux.knowsThread('never-seen'), false)
  // An announcement the adapter missed: the codex child still knows the
  // thread and its parent (thread/read), so the claim finds it after the wait.
  const missed = await mux.waitForClaimThread(`fake-missed-child-of-${parent}`, 50)
  assert.ok(missed, 'learned through thread/read')
  assert.equal(missed.parentThreadId, parent)
  assert.equal(missed.posture.fileSystem.kind, 'read-only', 'under the parent’s current posture')
  assert.equal(
    await mux.waitForClaimThread('fake-missed-child-of-nobody', 50),
    null,
    'a parent this adapter does not know',
  )
})

for (const order of ['link-first', 'child-first']) {
  test(`mux: ${order}, inherited model resolves only at completion; follow-ups retain identity`, async () => {
    const root = await tempDir('ae-child-order-')
    const { mux, request, sent } = await muxWithFakeChild(root, order, 'inherit')
    await request('initialize', { clientInfo: { name: 't', version: '0' } })
    const parent = (await request('thread/start', { model: 'gpt-6-sol', cwd: root })).result.thread
      .id
    await request('turn/start', { threadId: parent, input: [] })
    const id = 'fake-child-fake-turn-1'
    const child = await mux.waitForClaimThread(id, 30_000)
    assert.equal(child?.model, 'gpt-6-sol')
    const events = sent.filter((m) => 'method' in m) as Array<{ method: string; params: any }>
    const link = events.findIndex(
      (n) => n.method === 'item/completed' && n.params.item?.tool === 'spawnAgent',
    )
    const turn = events.findIndex((n) => n.method === 'turn/started' && n.params.threadId === id)
    assert.ok(link >= 0 && turn >= 0)
    assert.equal(turn < link, order === 'child-first')
    assert.ok(!events.some((n) => n.method === 'thread/started' && n.params.thread?.id === id))
    for (const tool of ['sendInput', 'closeAgent', 'resumeAgent']) {
      mux.onUpstreamMessage({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          threadId: parent,
          item: {
            type: 'collabAgentToolCall',
            tool,
            senderThreadId: parent,
            receiverThreadIds: [id],
            model: 'gpt-after-resume',
          },
        },
      })
      if (tool === 'sendInput') {
        mux.onUpstreamMessage({
          jsonrpc: '2.0',
          method: 'turn/started',
          params: { threadId: id, turn: { id: 'follow-up' } },
        })
        mux.onUpstreamMessage({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId: id, turn: { id: 'follow-up' } },
        })
      }
      assert.deepEqual(mux.claimThread(id), child, tool)
    }
    mux.onUpstreamMessage({ jsonrpc: '2.0', method: 'thread/deleted', params: { threadId: id } })
    assert.equal(mux.claimThread(id), null)
    assert.equal(mux.knowsThread(id), false)
  })
}

test('mux: an early child turn grants no claim; a waiter wakes at the completed link', async () => {
  const { mux } = await muxWithFakeChild(await tempDir('ae-wait-'))
  mux.onUpstreamMessage({
    jsonrpc: '2.0',
    method: 'turn/started',
    params: { threadId: 'early', turn: { id: 't' } },
  })
  assert.equal(mux.claimThread('early'), null)
  const waiting = mux.waitForClaimThread('early', 30_000)
  mux.onUpstreamMessage({
    jsonrpc: '2.0',
    method: 'item/completed',
    params: {
      item: {
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        senderThreadId: 'missing',
        receiverThreadIds: ['early'],
        model: 'opus',
      },
    },
  })
  assert.deepEqual((await waiting)?.posture, STRICTEST_POSTURE)
})

test('mux: rejected fallback never becomes a claim, even on a second lookup', async () => {
  const { mux, request } = await muxWithFakeChild(await tempDir('ae-reject-'))
  await request('initialize', {})
  for (let i = 0; i < 2; i++) {
    assert.equal(await mux.waitForClaimThread('fake-missed-child-of-nobody', 0), null)
    assert.equal(mux.claimThread('fake-missed-child-of-nobody'), null)
    assert.equal(mux.knowsThread('fake-missed-child-of-nobody'), false)
  }
})

test('mux: every recorded persisted, ephemeral, fork, inherited and follow-up shape stays learned', async () => {
  const { mux } = await muxWithFakeChild(await tempDir('ae-recordings-'))
  let passes = 0
  const linkedIds = new Set<string>()
  function replay(value: any): void {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value.notifications)) {
      passes++
      const expected = new Map<string, { parent: string; model: string }>()
      for (const n of value.notifications) {
        const { method, ...params } = n
        if (n.turnId && method.startsWith('turn/')) params.turn = { id: n.turnId }
        mux.onUpstreamMessage({ jsonrpc: '2.0', method, params })
        if (method === 'item/completed' && n.item?.tool === 'spawnAgent') {
          for (const child of n.item.receiverThreadIds) {
            linkedIds.add(child)
            expected.set(child, { parent: n.item.senderThreadId, model: n.item.model })
          }
        }
        for (const [id, expectedChild] of expected) {
          assert.equal(mux.claimThread(id)?.parentThreadId, expectedChild.parent, method)
          assert.equal(mux.claimThread(id)?.model, expectedChild.model, method)
        }
      }
    }
    for (const [key, nested] of Object.entries(value)) if (key !== 'notifications') replay(nested)
  }
  for (const recording of recordings) {
    replay(recording)
    // Fixture labels repeat across independent captures, unlike real ids.
    for (const threadId of linkedIds)
      mux.onUpstreamMessage({ jsonrpc: '2.0', method: 'thread/deleted', params: { threadId } })
    linkedIds.clear()
  }
  assert.ok(passes >= 7, `covered ${passes} recording passes`)
})

test('mux: child claims never loosen any enumerable parent, including a later tightening', async () => {
  const base = await tempDir('ae-mux-property-')
  const root = join(base, 'work')
  mkdirSync(root)
  const { mux, request } = await muxWithFakeChild(root)
  await request('initialize', {})
  const parentId = (await request('thread/start', { model: 'gpt-6-sol', cwd: root })).result.thread
    .id
  await request('turn/start', { threadId: parentId, input: [] })
  const id = 'fake-child-fake-turn-1'
  assert.ok(await mux.waitForClaimThread(id, 30_000))
  const ctx = postureContext(root)
  const tree = { base, ctx, extra: join(base, 'extra'), outside: join(base, 'outside') }
  const effects = probes(tree).map((p) => p.effect)
  const vector = (p: Posture) => [
    ...effects.map((effect) => reach(p, effect, ctx)),
    sandboxedOutcome(p),
  ]
  for (const parent of everyPosture(tree)) {
    mux.onUpstreamMessage({ jsonrpc: '2.0', method: 'thread/deleted', params: { threadId: id } })
    mux.updateUpstreamPosture(parentId, () => parent)
    mux.onUpstreamMessage({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: {
        item: {
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          senderThreadId: parentId,
          receiverThreadIds: [id],
          model: 'opus',
        },
      },
    })
    const spawned = mux.claimThread(id)!
    assert.deepEqual(vector(spawned.posture), vector(parent))
    const tightened: Posture = {
      ...parent,
      network: false,
      approval: 'untrusted',
      fileSystem: { kind: 'read-only' },
    }
    mux.updateUpstreamPosture(parentId, () => tightened)
    const got = vector(mux.claimThread(id)!.posture)
    for (const bound of [vector(parent), vector(tightened)]) {
      assert.ok(got.every((outcome, i) => outcomeRank(outcome) <= outcomeRank(bound[i]!)))
    }
    // Relaxation after a claim must not undo the tighter posture already used.
    mux.updateUpstreamPosture(parentId, () => parent)
    assert.deepEqual(vector(mux.claimThread(id)!.posture), got)
  }
})

test('mux: secondary thread announcement works, missing parents stay strict, deleted parents tighten', async () => {
  const { mux, request } = await muxWithFakeChild(await tempDir('ae-secondary-'))
  mux.onUpstreamMessage({
    jsonrpc: '2.0',
    method: 'thread/started',
    params: { thread: { id: 'secondary', parentThreadId: 'fake-thread-1', model: 'opus' } },
  })
  assert.deepEqual(mux.claimThread('secondary')?.posture, STRICTEST_POSTURE)
  await request('initialize', {})
  const parent = (await request('thread/start', { model: 'gpt-6-sol' })).result.thread.id
  assert.equal(parent, 'fake-thread-1')
  assert.deepEqual(mux.claimThread('secondary')?.posture, STRICTEST_POSTURE)
  await request('turn/start', { threadId: parent, input: [] })
  const child = await mux.waitForClaimThread('fake-child-fake-turn-1', 30_000)
  assert.equal(child?.posture.fileSystem.kind, 'workspace-write')
  mux.onUpstreamMessage({ jsonrpc: '2.0', method: 'thread/deleted', params: { threadId: parent } })
  assert.deepEqual(mux.claimThread('fake-child-fake-turn-1')?.posture, STRICTEST_POSTURE)
})

test('mux: stopping settles pending discovery and cannot relearn a child', async () => {
  const { mux } = await muxWithFakeChild(await tempDir('ae-stop-'))
  let settled = false
  const waiting = mux.waitForClaimThread('pending', 30_000).then((result) => {
    settled = true
    return result
  })
  await mux.stop()
  assert.equal(settled, true, 'stop cancels discovery before returning')
  assert.equal(await waiting, null)
  assert.equal(await mux.waitForClaimThread('pending', 0), null)
})

test('children: identity survives more than 1000 later spawns until explicitly forgotten', () => {
  const children = new NativeChildren()
  for (let i = 0; i <= 1000; i++) {
    children.observeItem({
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      senderThreadId: 'p',
      receiverThreadIds: [`c${i}`],
      model: 'opus',
    })
  }
  assert.equal(children.get('c0')?.parentThreadId, 'p')
  children.forget('c0')
  assert.equal(children.get('c0'), null)
})

test('mux: later child settings cannot erase the posture recorded at spawn', async () => {
  const { mux, request } = await muxWithFakeChild(await tempDir('ae-spawn-bound-'))
  await request('initialize', {})
  const parent = (await request('thread/start', { model: 'gpt-6-sol' })).result.thread.id
  const tight: Posture = { ...DEFAULT_POSTURE, approval: 'never' }
  mux.updateUpstreamPosture(parent, () => tight)
  await request('turn/start', { threadId: parent, input: [] })
  const id = 'fake-child-fake-turn-1'
  assert.ok(await mux.waitForClaimThread(id, 30_000))
  const loose: Posture = {
    ...DEFAULT_POSTURE,
    fileSystem: { kind: 'full-access' },
    network: true,
    approval: 'never',
  }
  mux.updateUpstreamPosture(parent, () => loose)
  mux.updateUpstreamPosture(id, () => loose)
  assert.deepEqual(mux.claimThread(id)?.posture, tight)
})

test('mux: a resumed child with an unknown parent is never mistaken for a root', async () => {
  const { mux, request } = await muxWithFakeChild(await tempDir('ae-resumed-child-'))
  await request('initialize', {})
  const id = 'fake-missed-child-of-nobody'
  await request('thread/resume', { threadId: id })
  assert.equal(mux.claimThread(id)?.parentThreadId, 'nobody')
  assert.deepEqual(mux.claimThread(id)?.posture, STRICTEST_POSTURE)
})

test('mux: deletion during announcement discovery cancels the wait and no fallback can restore ownership', async () => {
  const { mux, upstream } = await muxWithFakeChild(await tempDir('ae-delete-wait-'))
  let reads = 0
  upstream.request = async () => {
    reads++
    return {}
  }
  const waiting = mux.waitForClaimThread('deleted-wait', 30_000)
  mux.onUpstreamMessage({
    jsonrpc: '2.0',
    method: 'thread/deleted',
    params: { threadId: 'deleted-wait' },
  })
  assert.equal(await waiting, null)
  assert.equal(reads, 0)
  assert.equal(mux.claimThread('deleted-wait'), null)
  assert.equal(mux.knowsThread('deleted-wait'), false)
})

test('mux: deletion during fallback discovery rejects the late child read and ownership remains deleted', async () => {
  const { mux, upstream, request } = await muxWithFakeChild(await tempDir('ae-delete-read-'))
  await request('initialize', {})
  const parent = (await request('thread/start', { model: 'gpt-6-sol' })).result.thread.id
  let reply!: (value: unknown) => void
  const response = new Promise<unknown>((done) => {
    reply = done
  })
  let started!: () => void
  const requested = new Promise<void>((done) => {
    started = done
  })
  upstream.request = async (method, params) => {
    assert.equal(method, 'thread/read')
    assert.deepEqual(params, { threadId: 'deleted-read', includeTurns: false })
    started()
    return response
  }
  const waiting = mux.waitForClaimThread('deleted-read', 0)
  await requested
  mux.onUpstreamMessage({
    jsonrpc: '2.0',
    method: 'thread/deleted',
    params: { threadId: 'deleted-read' },
  })
  assert.equal(await waiting, null)
  reply({ thread: { id: 'deleted-read', parentThreadId: parent, model: 'opus', cwd: null } })
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(mux.claimThread('deleted-read'), null)
  assert.equal(mux.knowsThread('deleted-read'), false)
})
