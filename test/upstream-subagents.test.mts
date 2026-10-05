import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionStore } from '../src/store.mjs'
import type { ThreadRecord, WireMessage } from '../src/types.mjs'
import {
  nicknameFor,
  SUBAGENT_START_PARAM,
  takeSubagentStart,
  UpstreamSubagents,
} from '../src/upstream-subagents.mjs'

// The lineage and presentation of bridge sub-agents that live on the real
// Codex child (src/upstream-subagents.mts), without a child: what the store
// keeps, how a Thread is decorated, and how thread/list rows are placed.
// test/bridge.test.mts runs the same through the adapter and the fake child.

type Wire = Record<string, any>

async function withStore(run: (store: SessionStore) => Promise<void> | void) {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-subagents-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  try {
    await run(store)
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true })
  }
}

// A plain thread as the child answers it: no parent, a desktop source.
function childThread(id: string, extra: Wire = {}): Wire {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 100,
    updatedAt: 100,
    cwd: '/work',
    source: 'vscode',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    name: null,
    turns: [],
    ...extra,
  }
}

function localThread(id: string, parent: string | null): ThreadRecord {
  return {
    id,
    sessionId: id,
    forkedFromId: parent,
    preview: '',
    name: null,
    archived: false,
    cwd: '/work',
    model: 'sonnet',
    reasoningEffort: null,
    modelProvider: 'claude-code',
    runtimeBackend: 'claude',
    claudeSessionId: null,
    codexSessionId: null,
    source: 'appServer',
    createdAt: 0,
    updatedAt: 0,
    status: { type: 'idle' },
    approvalPolicy: 'never',
    sandboxMode: 'read-only',
    ephemeral: parent != null,
    threadSource: parent ? 'subagent' : 'user',
    agentRole: null,
    agentNickname: null,
    baseInstructions: null,
    developerInstructions: null,
    personality: null,
  }
}

const start = (parentThreadId: string, agentRole: string | null = 'luna') => ({
  parentThreadId,
  spawnerThreadId: parentThreadId,
  agentRole,
})

test('upstream sub-agents: a linked Thread carries the parent the app reads, wherever it appears', async () => {
  await withStore((store) => {
    const view = new UpstreamSubagents(store)
    view.record('gpt-child', start('claude-parent'))
    const nickname = nicknameFor('gpt-child')
    const expected = {
      parentThreadId: 'claude-parent',
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: 'claude-parent',
            depth: 1,
            agent_path: `/root/${nickname}`,
            agent_nickname: nickname,
            agent_role: 'luna',
          },
        },
      },
      threadSource: 'subagent',
      agentNickname: nickname,
      agentRole: 'luna',
    }
    const linked = (thread: Wire) => {
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(thread[key], value, key)
    }
    const started = view.present({
      jsonrpc: '2.0',
      method: 'thread/started',
      params: { thread: childThread('gpt-child') },
    }) as Wire
    linked(started.params.thread)
    // Everything else about the thread is the child's own.
    assert.equal(started.params.thread.cwd, '/work')
    assert.equal(started.params.thread.forkedFromId, null)
    const read = view.present({ id: 1, result: { thread: childThread('gpt-child') } }) as Wire
    linked(read.result.thread)
    const list = view.present({
      id: 2,
      result: { data: [childThread('other'), childThread('gpt-child')], nextCursor: null },
    }) as Wire
    assert.equal(list.result.data[0].parentThreadId, null)
    linked(list.result.data[1])
    const search = view.present({
      id: 3,
      result: { data: [{ thread: childThread('gpt-child'), snippet: 'x' }] },
    }) as Wire
    linked(search.result.data[0].thread)
    assert.equal(search.result.data[0].snippet, 'x')

    // Nothing to present: the very same message goes through.
    const plain: WireMessage = { jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'x' } }
    assert.equal(view.present(plain), plain)
    const unknown = { id: 4, result: { thread: childThread('other') } }
    assert.equal(view.present(unknown), unknown)
    const models = { id: 5, result: { data: [{ id: 'gpt-5.6-sol' }, 'loaded-id'] } }
    assert.equal(view.present(models), models)
  })
})

test('upstream sub-agents: a thread the child already shows as a sub-agent is not linked again', async () => {
  await withStore((store) => {
    const view = new UpstreamSubagents(store)
    view.record('gpt-child', start('parent'))
    const native = childThread('gpt-child', {
      parentThreadId: 'native-parent',
      source: { subAgent: { thread_spawn: { parent_thread_id: 'native-parent', depth: 1 } } },
    })
    assert.equal(view.presentThread(native), native)
    // Presenting twice is presenting once.
    const once = view.presentThread(childThread('gpt-child'))
    assert.equal(view.presentThread(once), once)
  })
})

test('upstream sub-agents: depth counts the ancestry across both engines', async () => {
  await withStore((store) => {
    store.upsertThread(localThread('claude-root', null))
    store.upsertThread(localThread('claude-child', 'claude-root'))
    const view = new UpstreamSubagents(store)
    assert.equal(view.record('gpt-a', start('claude-root')).depth, 1)
    assert.equal(view.record('gpt-b', start('claude-child')).depth, 2)
    assert.equal(view.record('gpt-c', start('gpt-b')).depth, 3)
    assert.equal(view.record('gpt-d', start('unknown-parent')).depth, 1)
  })
})

test('upstream sub-agents: the lineage survives a restart, and a bad row is skipped', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-subagents-'))
  const path = join(home, 'state.sqlite')
  try {
    const first = new SessionStore(path)
    const linkedAt = new UpstreamSubagents(first).record(
      'gpt-child',
      start('parent', null),
    ).createdAt
    assert.ok(linkedAt > 0)
    first.setNativeCodexSubagent('broken', '{not json')
    first.setNativeCodexSubagent('partial', JSON.stringify({ id: 'partial' }))
    first.close()
    const store = new SessionStore(path)
    try {
      assert.equal(store.isNativeCodexThread('gpt-child'), true)
      const restored = new UpstreamSubagents(store)
      assert.deepEqual(restored.get('gpt-child'), {
        id: 'gpt-child',
        parentThreadId: 'parent',
        spawnerThreadId: 'parent',
        agentRole: null,
        depth: 1,
        agentNickname: nicknameFor('gpt-child'),
        agentPath: `/root/${nicknameFor('gpt-child')}`,
        createdAt: linkedAt,
      })
      assert.equal(restored.get('broken'), null)
      assert.equal(restored.get('partial'), null)
      // A deleted thread takes its lineage with it.
      store.deleteNativeCodexThread('gpt-child')
      assert.equal(new UpstreamSubagents(store).get('gpt-child'), null)
    } finally {
      store.close()
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('upstream sub-agents: a sub-agent announced before its start is answered is announced again, linked', async () => {
  await withStore((store) => {
    const view = new UpstreamSubagents(store)
    const again: Wire[] = []
    const deliver = (message: WireMessage) => again.push(message as Wire)
    const started = (id: string): WireMessage => ({
      jsonrpc: '2.0',
      method: 'thread/started',
      params: { thread: childThread(id) },
    })
    // Nothing in flight: nothing is noted, nothing comes again.
    view.announced('plain', started('plain'), deliver)

    // Announced before the answer (two starts in flight, one unrelated thread).
    view.beginStart()
    view.beginStart()
    view.announced('gpt-a', started('gpt-a'), deliver)
    view.announced('desktop', started('desktop'), deliver)
    assert.equal(again.length, 0, 'nothing is held back or sent here')
    view.endStart('gpt-a', start('parent'))
    assert.deepEqual(
      again.map((m) => [m.params.thread.id, m.params.thread.parentThreadId]),
      [['gpt-a', 'parent']],
      'the linked one comes again once its start is answered',
    )
    view.endStart(null, start('parent'))
    assert.equal(again.length, 1, 'an unrelated thread never comes again')

    // Announced after the answer (codex 0.159): linked on the way, never again.
    view.beginStart()
    view.endStart('gpt-b', start('parent'))
    view.announced('gpt-b', started('gpt-b'), deliver)
    assert.equal(again.length, 1)
    const presented = view.present(started('gpt-b')) as Wire
    assert.equal(presented.params.thread.parentThreadId, 'parent')
  })
})

test('upstream sub-agents: a start the child never answers holds nothing back', async () => {
  await withStore((store) => {
    const view = new UpstreamSubagents(store)
    const again: string[] = []
    view.beginStart()
    for (const id of ['desktop-1', 'desktop-2']) {
      const message: WireMessage = {
        jsonrpc: '2.0',
        method: 'thread/started',
        params: { thread: childThread(id) },
      }
      view.announced(id, message, (m) => again.push((m as Wire).params.thread.id))
    }
    // The start fails: the plain announcements stand, nothing is repeated.
    view.endStart(null, start('parent'))
    view.beginStart()
    view.endStart('desktop-1', start('parent'))
    assert.deepEqual(again, [], 'forgotten once no start was left')
  })
})

test('upstream sub-agents: thread/list keeps them out of plain lists and in sub-agent ones', async () => {
  await withStore(async (store) => {
    store.upsertThread(localThread('claude-root', null))
    store.upsertThread(localThread('claude-child', 'claude-root'))
    const view = new UpstreamSubagents(store)
    view.record('gpt-a', start('claude-root'))
    view.record('gpt-b', start('claude-child'))
    view.record('gpt-c', start('gpt-a'))
    view.record('gpt-far', start('elsewhere'))
    const reads: string[] = []
    const read = async (id: string) => {
      reads.push(id)
      if (id === 'gpt-far') throw new Error('gone')
      return { thread: childThread(id, { cwd: id === 'gpt-c' ? '/other' : '/work' }) }
    }
    const ids = (rows: unknown[]) => rows.map((row) => (row as Wire).id)
    const upstream = [childThread('plain'), childThread('gpt-a')]

    // The sidebar: plain threads only, the child's order kept.
    const sidebar = { sourceKinds: [], modelProviders: [], parentThreadId: null }
    assert.deepEqual(ids(await view.listRows(sidebar, upstream, true, read)), ['plain'])
    assert.deepEqual(reads, [])

    // The app's sub-agent panel query, on the root: every descendant, linked.
    const panel = {
      ancestorThreadId: 'claude-root',
      sourceKinds: ['subAgentThreadSpawn'],
      useStateDbOnly: true,
    }
    const rows = (await view.listRows(panel, [], true, read)) as Wire[]
    assert.deepEqual(ids(rows).sort(), ['gpt-a', 'gpt-b', 'gpt-c'])
    assert.ok(rows.every((row) => row.source.subAgent.thread_spawn.parent_thread_id))
    // Direct children only, and a row the child did list is not read again.
    reads.length = 0
    const direct = { parentThreadId: 'claude-root', sourceKinds: ['subAgentThreadSpawn'] }
    assert.deepEqual(ids(await view.listRows(direct, [childThread('gpt-a')], true, read)), [
      'gpt-a',
    ])
    assert.deepEqual(reads, [])
    // The child's own filters hold for what is added; a read that fails is skipped.
    assert.deepEqual(ids(await view.listRows({ ...panel, cwd: '/other' }, [], true, read)), [
      'gpt-c',
    ])
    assert.deepEqual(
      ids(await view.listRows({ ...panel, modelProviders: ['claude-code'] }, [], true, read)),
      [],
    )
    assert.deepEqual(
      ids(await view.listRows({ sourceKinds: ['subAgent'] }, [], true, read)).sort(),
      ['gpt-a', 'gpt-b', 'gpt-c'],
    )
    // Later pages, archived lists and non-spawn source kinds add nothing.
    reads.length = 0
    assert.deepEqual(ids(await view.listRows(panel, [], false, read)), [])
    assert.deepEqual(ids(await view.listRows({ ...panel, archived: true }, [], true, read)), [])
    assert.deepEqual(
      ids(await view.listRows({ ...panel, sourceKinds: ['subAgentReview'] }, [], true, read)),
      [],
    )
    assert.deepEqual(reads, [])
  })
})

// The app's worktrees page asks for every thread-spawn sub-agent each minute.
test('upstream sub-agents: a list adds at most a page, newest first, a few reads at a time', async () => {
  await withStore(async (store) => {
    const view = new UpstreamSubagents(store)
    for (let n = 1; n <= 12; n += 1) view.record(`gpt-${n}`, start('parent'))
    let inFlight = 0
    let most = 0
    const reads: string[] = []
    const read = async (id: string) => {
      reads.push(id)
      inFlight += 1
      most = Math.max(most, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { thread: childThread(id) }
    }
    const everySpawn = { sourceKinds: ['subAgentThreadSpawn'], limit: 3 }
    const ids = (rows: unknown[]) => rows.map((row) => (row as Wire).id)
    assert.deepEqual(ids(await view.listRows(everySpawn, [], true, read)), [
      'gpt-12',
      'gpt-11',
      'gpt-10',
    ])
    assert.equal(reads.length, 3)
    const oldest = { ...everySpawn, sortDirection: 'asc' }
    assert.deepEqual(ids(await view.listRows(oldest, [], true, read)), ['gpt-1', 'gpt-2', 'gpt-3'])
    reads.length = 0
    most = 0
    const all = await view.listRows({ sourceKinds: ['subAgentThreadSpawn'] }, [], true, read)
    assert.equal(all.length, 12, 'the default page (50) holds them all')
    assert.equal(most, 4, 'never more than four reads in flight')
  })
})

test('upstream sub-agents: only a bridge peer can link a thread/start, and the field never reaches the child', () => {
  const request = {
    jsonrpc: '2.0' as const,
    id: 'b1',
    method: 'thread/start',
    params: {
      model: 'gpt-5.6-sol',
      approvalPolicy: 'on-request',
      [SUBAGENT_START_PARAM]: { parentThreadId: 'p', spawnerThreadId: 'p', agentRole: 'luna' },
    },
  }
  const fromBridge = takeSubagentStart(request, true)
  assert.deepEqual(fromBridge.start, {
    parentThreadId: 'p',
    spawnerThreadId: 'p',
    agentRole: 'luna',
  })
  assert.deepEqual(fromBridge.request.params, {
    model: 'gpt-5.6-sol',
    approvalPolicy: 'on-request',
  })
  const fromDesktop = takeSubagentStart(request, false)
  assert.equal(fromDesktop.start, null)
  assert.deepEqual(fromDesktop.request.params, fromBridge.request.params)
  const plain = { jsonrpc: '2.0' as const, id: 2, method: 'thread/start', params: { model: 'x' } }
  assert.equal(takeSubagentStart(plain, true).request, plain)
  const other = { ...request, method: 'turn/start' }
  assert.equal(takeSubagentStart(other, true).request, other)
})
