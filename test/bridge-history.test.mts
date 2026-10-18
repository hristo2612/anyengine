import assert from 'node:assert/strict'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ThreadItem } from '../src/types.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

function item(
  id: string,
  tool: 'spawnAgent' | 'wait' = 'spawnAgent',
): Extract<ThreadItem, { type: 'collabAgentToolCall' }> {
  return {
    type: 'collabAgentToolCall',
    id,
    tool,
    status: 'completed',
    senderThreadId: 'parent',
    receiverThreadIds: ['claude-child'],
    prompt: null,
    model: 'opus',
    reasoningEffort: null,
    agentsStates: { 'claude-child': { status: 'completed', message: null } },
  }
}

test('native parent hook upserts ordered navigation after store reopen without local rows', async () => {
  const path = join(await tempDir('bridge-history-'), 'state.sqlite')
  let store = new SessionStore(path)
  const host = new CodexClaudeAppServer(store, new MockRuntime()).bridgeHost()
  const first = item('spawn')
  host.emitParentItem('parent', 'turn', { ...first, status: 'inProgress' }, 'begin')
  host.emitParentItem('parent', 'turn', item('wait', 'wait'), 'begin')
  host.emitParentItem('parent', 'turn', first, 'end')
  host.emitParentItem('parent', 'turn', { ...first, status: 'inProgress' }, 'begin')
  host.emitParentItem('parent', 'turn', item('second'), 'end')
  host.emitParentItem('parent', 'turn', item('wait', 'wait'), 'endMove')
  host.emitParentItem(
    'parent',
    'turn',
    {
      type: 'subAgentActivity',
      id: 'activity',
      kind: 'started',
      agentThreadId: 'claude-child',
      agentPath: '/root/child',
    },
    'lifecycle',
  )
  assert.equal(store.getThread('parent'), null)
  assert.equal(store.getTurn('turn'), null)
  store.close()
  store = new SessionStore(path)
  try {
    const native = [
      { id: 'earlier', status: 'completed', items: [] },
      {
        id: 'turn',
        status: 'completed',
        itemsView: 'full',
        items: [
          { type: 'userMessage', id: 'ask' },
          { type: 'agentMessage', id: 'answer', text: 'Public answer', phase: null },
        ],
      },
    ]
    const projected = store.bridgeHistory.projectTurns('parent', native) as typeof native
    assert.ok(projected[1])
    assert.ok(native[1])
    assert.equal(projected[0], native[0])
    assert.equal(projected[1].status, 'completed')
    assert.deepEqual(
      projected[1].items.map((x) => x.id),
      ['ask', 'spawn', 'second', 'wait', 'answer'],
    )
    assert.deepEqual(projected[1].items[1], first)
    assert.deepEqual(
      native[1].items.map((x) => x.id),
      ['ask', 'answer'],
    )
  } finally {
    store.close()
  }
})

test('projection deduplicates native IDs, preserves native order and explicit lazy history', async () => {
  const store = new SessionStore(join(await tempDir('bridge-dedup-'), 'state.sqlite'))
  try {
    store.bridgeHistory.record('parent', 'turn', item('shared'), 'end')
    store.bridgeHistory.record('parent', 'turn', item('extra'), 'end')
    const native = {
      id: 'turn',
      items: [
        { type: 'userMessage', id: 'ask' },
        { ...item('shared'), status: 'failed' },
        { type: 'agentMessage', id: 'final', phase: 'final_answer' },
      ],
    }
    const [full] = store.bridgeHistory.projectTurns('parent', [native]) as (typeof native)[]
    assert.ok(full)
    assert.deepEqual(
      full.items.map((x) => x.id),
      ['ask', 'shared', 'extra', 'final'],
    )
    assert.deepEqual(full.items[1], native.items[1])
    const lazy = { ...native, items: [], itemsView: 'notLoaded' }
    assert.equal(store.bridgeHistory.projectTurns('parent', [lazy])[0], lazy)
  } finally {
    store.close()
  }
})

test('only exact native thread deletion clears its bridge items across reopen', async () => {
  const path = join(await tempDir('bridge-delete-'), 'state.sqlite')
  let store = new SessionStore(path)
  store.bridgeHistory.record('parent', 'turn', item('parent-item'), 'end')
  store.bridgeHistory.record('sibling', 'turn', item('sibling-item'), 'end')
  store.setNativeCodexThread('parent')
  store.setNativeCodexThread('sibling')
  store.deleteNativeCodexThread('sibling')
  assert.equal(store.bridgeHistory.has('parent'), true)
  assert.equal(store.bridgeHistory.has('sibling'), false)
  store.close()
  store = new SessionStore(path)
  try {
    assert.equal(store.bridgeHistory.has('parent'), true)
    store.deleteNativeCodexThread('parent')
    assert.equal(store.bridgeHistory.has('parent'), false)
  } finally {
    store.close()
  }
})
