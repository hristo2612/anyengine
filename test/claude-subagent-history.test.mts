import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { transcriptEntriesFromTurns } from '../src/rehome.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ThreadItem, ThreadRecord } from '../src/types.mjs'
import { AdapterClient, fakeCodexAt } from './helpers/adapter-client.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(killChildren)
after(removeTempDirs)

// Mirrors the real Opus records' topology: a native GPT parent has no local
// row/turn; its Claude children have a persisted prompt and public final reply.
// Every message here is synthetic; production text and reasoning were not copied.
test('Claude children of a native parent reopen with their persisted public replies', async () => {
  const home = await tempDir('claude-child-history-')
  const store = new SessionStore(join(home, 'state.sqlite'))
  const parent = 'native-parent'
  store.setNativeCodexThread(parent)
  const bodies = ['Synthetic public reply. '.repeat(300), 'Synthetic shorter reply. '.repeat(55)]
  for (const [index, body] of bodies.entries()) {
    const id = `claude-child-${index}`
    const child: ThreadRecord = {
      id,
      sessionId: parent,
      forkedFromId: parent,
      preview: 'Inspect public records',
      name: null,
      archived: false,
      cwd: home,
      model: 'opus',
      reasoningEffort: null,
      modelProvider: 'claude-code',
      runtimeBackend: 'claude',
      claudeSessionId: null,
      codexSessionId: null,
      source: 'appServer',
      createdAt: 1,
      updatedAt: 2,
      status: { type: 'idle' },
      approvalPolicy: 'on-request',
      sandboxMode: 'read-only',
      ephemeral: true,
      threadSource: 'subagent',
      agentRole: 'bridge',
      agentNickname: id,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
    }
    store.upsertThread(child)
    store.upsertTurn({
      id: `turn-${id}`,
      threadId: id,
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      durationMs: 1000,
      diff: '',
      error: null,
      items: [
        {
          type: 'userMessage',
          id: `ask-${id}`,
          content: [{ type: 'text', text: 'Inspect public records' }],
        },
        { type: 'agentMessage', id: `answer-${id}`, text: body, phase: null, memoryCitation: null },
      ],
    })
  }
  const host = new CodexClaudeAppServer(store, new MockRuntime()).bridgeHost()
  for (let index = 0; index < 2; index++) {
    const child = `claude-child-${index}`
    const call: ThreadItem = {
      type: 'collabAgentToolCall',
      id: `spawn-${index}`,
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: parent,
      receiverThreadIds: [child],
      prompt: 'Inspect public records',
      model: 'opus',
      reasoningEffort: null,
      agentsStates: { [child]: { status: 'completed', message: null } },
    }
    host.emitParentItem(parent, 'parent-turn', { ...call, status: 'inProgress' }, 'begin')
    host.emitParentItem(parent, 'parent-turn', call, 'end')
    host.emitParentItem(
      parent,
      'parent-turn',
      { ...call, id: `wait-${index}`, tool: 'wait' },
      'endMove',
    )
  }
  const history = join(home, 'native-history.json')
  const native = JSON.stringify({
    [parent]: [
      { id: 'older-turn', status: 'completed', itemsView: 'full', items: [] },
      {
        id: 'parent-turn',
        status: 'completed',
        itemsView: 'full',
        items: [
          {
            type: 'userMessage',
            id: 'parent-ask',
            content: [{ type: 'text', text: 'Review records' }],
          },
          {
            type: 'agentMessage',
            id: 'parent-answer',
            text: 'Both reviews complete.',
            phase: null,
          },
        ],
      },
    ],
  })
  await writeFile(history, native)
  const fake = fakeCodexAt(home)
  assert.equal(store.getThread(parent), null)
  store.close()
  for (let restart = 0; restart < 2; restart++) {
    const app = new AdapterClient(
      spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../src/adapter.mjs', import.meta.url)),
          'app-server',
          '--listen',
          'stdio://',
        ],
        {
          stdio: ['pipe', 'pipe', 'inherit'],
          env: {
            ...process.env,
            ANYENGINE_MOCK: '1',
            ANYENGINE_HOME: home,
            ANYENGINE_NATIVE_CODEX: '1',
            ANYENGINE_REAL_CODEX: fake,
            ANYENGINE_RUNTIME_TYPE: 'mock',
            FAKE_CODEX_HISTORY_INPUT: history,
          },
        },
      ),
    )
    try {
      const opened = await app.request('thread/read', { threadId: parent, includeTurns: false })
      assert.equal(opened.error, undefined)
      const parentTurns = opened.result.thread.turns
      assert.deepEqual(
        parentTurns.map((turn: any) => turn.id),
        ['older-turn', 'parent-turn'],
      )
      const items = parentTurns[1].items
      assert.deepEqual(
        items.map((entry: any) => entry.id),
        ['parent-ask', 'spawn-0', 'wait-0', 'spawn-1', 'wait-1', 'parent-answer'],
      )
      assert.deepEqual(
        items
          .filter((entry: any) => entry.type === 'collabAgentToolCall')
          .flatMap((entry: any) => entry.receiverThreadIds),
        ['claude-child-0', 'claude-child-0', 'claude-child-1', 'claude-child-1'],
      )
      assert.deepEqual(transcriptEntriesFromTurns(parentTurns), [
        { role: 'user', text: 'Review records' },
        { role: 'assistant', text: 'Both reviews complete.' },
      ])
      const page = await app.request('thread/turns/list', {
        threadId: parent,
        cursor: '1',
        limit: 1,
        sortDirection: 'asc',
        itemsView: 'full',
      })
      assert.equal(page.error, undefined)
      assert.deepEqual(page.result.data, [parentTurns[1]])
      assert.equal(page.result.backwardsCursor, '0')
      assert.equal(page.result.nextCursor, null)
      for (const [index, body] of bodies.entries()) {
        const id = `claude-child-${index}`
        const reply = await app.request('thread/read', { threadId: id, includeTurns: false })
        assert.equal(reply.error, undefined)
        const thread = reply.result.thread
        assert.equal(thread.parentThreadId, parent)
        assert.equal(thread.status.type, 'idle')
        assert.equal(thread.turns[0].status, 'completed')
        assert.equal(thread.turns[0].itemsView, 'full')
        assert.deepEqual(transcriptEntriesFromTurns(thread.turns), [
          { role: 'user', text: 'Inspect public records' },
          { role: 'assistant', text: body.trim() },
        ])
        assert.equal(thread.turns[0].items[1].id, `answer-${id}`)
        const full = await app.request('thread/turns/list', { threadId: id, itemsView: 'full' })
        assert.deepEqual(full.result.data, thread.turns)
      }
      assert.equal((await app.request('thread/archive', { threadId: parent })).error, undefined)
      assert.equal((await app.request('thread/unsubscribe', { threadId: parent })).error, undefined)
      assert.equal(await readFile(history, 'utf8'), native)
    } finally {
      await app.close()
    }
  }
})
