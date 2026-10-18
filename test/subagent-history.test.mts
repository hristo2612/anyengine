import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { type MuxLocalServer, NativeCodexMux } from '../src/codex-mux.mjs'
import type { CodexUpstream } from '../src/codex-upstream.mjs'
import { transcriptEntriesFromTurns } from '../src/rehome.mjs'
import { SessionStore } from '../src/store.mjs'
import type { RpcPeer } from '../src/types.mjs'
import { UpstreamSubagents } from '../src/upstream-subagents.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

type Wire = Record<string, any>

// Synthetic native history: public messages surround deliberately non-message
// records. No production messages, reasoning bodies or credentials are fixtures.
const turns = [
  {
    id: 'first',
    status: 'completed',
    itemsView: 'full',
    items: [
      {
        type: 'userMessage',
        id: 'ask',
        content: [{ type: 'text', text: 'Check the child transcript.' }],
      },
      { type: 'reasoning', id: 'private', summary: [], content: ['SYNTHETIC_PRIVATE'] },
      { type: 'commandExecution', id: 'tool', aggregatedOutput: 'SYNTHETIC_TOOL_OUTPUT' },
      {
        type: 'agentMessage',
        id: 'progress',
        text: 'I checked the public records.',
        phase: 'commentary',
      },
    ],
  },
  {
    id: 'last',
    status: 'completed',
    itemsView: 'full',
    items: [
      {
        type: 'agentMessage',
        id: 'answer',
        text: 'The transcript is available.',
        phase: 'final_answer',
      },
    ],
  },
]
const expected = [
  { role: 'user', text: 'Check the child transcript.' },
  { role: 'assistant', text: 'I checked the public records.' },
  { role: 'assistant', text: 'The transcript is available.' },
]

async function fixture(mode = 'paginated') {
  const home = await tempDir('subagent-history-')
  const native = join(home, 'native-history.json')
  await writeFile(native, JSON.stringify(turns))
  const path = join(home, 'state.sqlite')
  const seed = new SessionStore(path)
  new UpstreamSubagents(seed).record('child', {
    parentThreadId: 'parent',
    spawnerThreadId: 'parent',
    agentRole: 'reviewer',
  })
  seed.close()
  const connect = () => {
    const store = new SessionStore(path)
    const calls: Array<{ method: string; params: Wire }> = []
    const messages: Wire[] = []
    let badPage: 'cursor' | 'schema' | null = null
    const request = async (method: string, params: Wire): Promise<Wire> => {
      calls.push({ method, params })
      const history = JSON.parse(await readFile(native, 'utf8'))
      if (method === 'thread/read') {
        if (mode === 'paginated' && params.includeTurns === true)
          throw new Error('Paginated threads require turns/list')
        return {
          native: true,
          thread: {
            id: params.threadId,
            source: 'vscode',
            status: { type: 'idle' },
            historyMode: mode,
            turns: params.includeTurns ? history : [],
          },
        }
      }
      assert.equal(method, 'thread/turns/list')
      assert.equal(params.threadId, 'child')
      assert.equal(params.sortDirection, 'asc')
      assert.equal(params.itemsView, 'full')
      if (badPage === 'schema') return { data: 'invalid', nextCursor: null }
      const first = params.cursor == null
      return {
        data: [history[first ? 0 : 1]],
        nextCursor: first || badPage === 'cursor' ? 'tail' : null,
      }
    }
    const upstream = {
      available: true,
      request,
      forwardRequest: (peer: RpcPeer, id: number, method: string, params: Wire) => {
        void request(method, params).then((result) => peer.send({ jsonrpc: '2.0', id, result }))
      },
    } as unknown as CodexUpstream
    const mux = new NativeCodexMux({
      store,
      upstream,
      local: {
        localThreadOwner: () => null,
      } as unknown as MuxLocalServer,
    })
    const peer: RpcPeer = {
      id: 'desktop',
      send: (message) => messages.push(message),
      close: () => {},
    }
    const read = async (id = 'child') => {
      const at = messages.length
      await mux.handle(peer, {
        jsonrpc: '2.0',
        id: at + 1,
        method: 'thread/read',
        params: { threadId: id, includeTurns: false },
      })
      // Old forwarding is asynchronous, just like the real upstream child.
      for (let i = 0; messages.length === at && i < 100; i++)
        await new Promise((resolve) => setTimeout(resolve, 1))
      assert.ok(messages.length > at, 'thread/read answered')
      const reply = messages.at(-1)
      assert.ok(reply)
      return reply
    }
    return {
      store,
      calls,
      read,
      bad: (value: typeof badPage) => {
        badPage = value
      },
    }
  }
  return { connect }
}

test('metadata-only native child reads hydrate paginated public history after a store reopen', async () => {
  const f = await fixture()
  for (let restart = 0; restart < 2; restart++) {
    const c = f.connect()
    try {
      const reply = await c.read()
      assert.equal(reply.error, undefined)
      assert.equal(reply.result.native, true)
      const thread = reply.result.thread
      assert.equal(thread.parentThreadId, 'parent')
      assert.equal(thread.status.type, 'idle')
      assert.deepEqual(
        thread.turns.map((turn: Wire) => turn.id),
        ['first', 'last'],
      )
      const publicView = transcriptEntriesFromTurns(thread.turns)
      assert.deepEqual(publicView, expected)
      assert.doesNotMatch(JSON.stringify(publicView), /SYNTHETIC_PRIVATE|SYNTHETIC_TOOL_OUTPUT/)
    } finally {
      c.store.close()
    }
  }
})

test('ordinary metadata-only reads keep their metadata-only behavior', async () => {
  const c = (await fixture()).connect()
  try {
    const reply = await c.read('ordinary')
    assert.deepEqual(reply.result.thread.turns, [])
    assert.equal(c.calls.length, 1)
    assert.equal(c.calls[0]?.params.includeTurns, false)
  } finally {
    c.store.close()
  }
})

test('legacy native child histories are hydrated without paginated RPCs', async () => {
  const c = (await fixture('full')).connect()
  try {
    const reply = await c.read()
    assert.deepEqual(transcriptEntriesFromTurns(reply.result.thread.turns), expected)
    assert.deepEqual(
      c.calls.map((call) => call.method),
      ['thread/read', 'thread/read'],
    )
    assert.equal(c.calls[1]?.params.includeTurns, true)
  } finally {
    c.store.close()
  }
})

test('invalid or cyclic native history pages fail instead of returning an empty success', async () => {
  for (const bad of ['cursor', 'schema'] as const) {
    const c = (await fixture()).connect()
    c.bad(bad)
    try {
      await assert.rejects(c.read(), /history page|pagination did not finish/)
    } finally {
      c.store.close()
    }
  }
})
