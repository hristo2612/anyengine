import assert from 'node:assert/strict'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { BridgeControl, type BridgeHost, type BridgeThreadInfo } from '../src/bridge-control.mjs'
import { BridgeClient, mcpCallerThreadId } from '../src/bridge-mcp.mjs'
import { DEFAULT_POSTURE } from '../src/posture.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

test('MCP caller identity comes from client metadata, never tool arguments', () => {
  assert.equal(mcpCallerThreadId({ _meta: { threadId: 'parent' } }, null), 'parent')
  assert.equal(
    mcpCallerThreadId(
      { arguments: { _meta: { threadId: 'forged' }, parentThreadId: 'forged' } },
      null,
    ),
    null,
  )
  assert.equal(mcpCallerThreadId({}, 'fixed'), 'fixed')
  for (const malformed of [null, [], '', 42, false, undefined])
    assert.throws(() => mcpCallerThreadId({ _meta: malformed }, null), /Invalid MCP/)

  assert.throws(() => mcpCallerThreadId({ _meta: { threadId: '' } }, null), /Invalid MCP/)
  assert.throws(() => mcpCallerThreadId({ _meta: { threadId: 4 } }, null), /Invalid MCP/)
  assert.throws(
    () => mcpCallerThreadId({ _meta: { threadId: 'other' } }, 'fixed'),
    /does not match/,
  )
})

test('shared bridge keeps concurrent callers and follow-ups under their own permissions', async () => {
  const home = await tempDir('bridge-caller-')
  const threads = new Map<string, BridgeThreadInfo>()
  const starts: Record<string, unknown>[] = []
  const sent: string[] = []
  const full: BridgeThreadInfo = {
    id: 'full',
    owner: 'upstream',
    cwd: home,
    model: 'gpt-test',
    activeTurnId: 'p1',
    posture: {
      ...DEFAULT_POSTURE,
      fileSystem: { kind: 'full-access' },
      network: true,
      approval: 'never',
    },
  }
  const restricted: BridgeThreadInfo = {
    ...full,
    id: 'restricted',
    activeTurnId: 'p2',
    posture: DEFAULT_POSTURE,
  }
  threads.set(full.id, full)
  threads.set(restricted.id, restricted)
  let count = 0
  const host: BridgeHost = {
    handle: async (peer, message) => {
      if (!('method' in message) || !('id' in message)) return
      const params = (message.params ?? {}) as Record<string, unknown>
      let result: unknown = {}
      if (message.method === 'model/list') result = { data: [{ id: 'gpt-test' }] }
      if (message.method === 'thread/start') {
        const id = `child-${++count}`
        starts.push(params)
        threads.set(id, { ...full, id, activeTurnId: null })
        result = { thread: { id }, model: 'gpt-test' }
      }
      if (message.method === 'turn/start') {
        sent.push(String(params.threadId))
        result = { turn: { id: `turn-${sent.length}` } }
      }
      peer.send({ jsonrpc: '2.0', id: message.id, result })
    },
    closePeer: () => {},
    appPeerFor: () => null,
    threadInfo: (id) => threads.get(id) ?? null,
    activeThreadIds: () => ['full', 'restricted'],
    routeForModel: () => 'upstream',
    createSubagentThread: () => {
      throw new Error('unexpected local child')
    },
    inheritFromCaller: () => {},
    emitParentItem: () => {},
    supportsCompletedActivity: () => false,
  }
  const env = {
    ANYENGINE_BRIDGE_SOCKET: join(home, 'b.sock'),
    ANYENGINE_BRIDGE_TOKEN: 'fixture-only',
  }
  const control = new BridgeControl(host, { env })
  const client = new BridgeClient(env)
  const fixed = new BridgeClient({ ...env, ANYENGINE_BRIDGE_THREAD: 'restricted' })
  await control.start()
  try {
    // Older clients without per-call identity must not borrow a default from
    // either of two active chats, even when neither restricts reads.
    for (const posture of [
      restricted.posture,
      { ...restricted.posture, plan: true },
      { ...restricted.posture, approval: 'untrusted' as const },
      { ...restricted.posture, trust: 'untrusted' as const },
    ]) {
      threads.set(restricted.id, { ...restricted, posture })
      for (const [method, args] of [
        ['bridge/spawnSession', { model: 'gpt-test', prompt: 'x', wait: false }],
        [
          'bridge/spawnSubagents',
          { tasks: [{ model: 'gpt-test', prompt: 'x' }], parentThreadId: full.id },
        ],
        ['bridge/exec', { command: 'must not execute' }],
      ] as const)
        await assert.rejects(client.call(method, args, 5000), /multiple active threads/)
      assert.equal(starts.length, 0)
      assert.equal(sent.length, 0)
    }
    threads.set(restricted.id, restricted)
    const [a, b] = (await Promise.all([
      client.call(
        'bridge/spawnSession',
        { model: 'gpt-test', prompt: 'a', wait: false },
        5000,
        'full',
      ),
      client.call(
        'bridge/spawnSession',
        { model: 'gpt-test', prompt: 'b', wait: false },
        5000,
        'restricted',
      ),
    ])) as Array<{ threadId: string }>
    assert.equal(starts[0]?.approvalPolicy, 'never')
    assert.equal(starts[0]?.sandbox, 'danger-full-access')
    assert.equal(starts[1]?.approvalPolicy, 'on-request')
    assert.equal(starts[1]?.sandbox, 'read-only')
    await client.call(
      'bridge/send',
      { threadId: a?.threadId, prompt: 'continue', wait: false },
      5000,
      'full',
    )
    await client.call(
      'bridge/send',
      { threadId: b?.threadId, prompt: 'continue', wait: false },
      5000,
      'restricted',
    )
    assert.equal(sent.length, 4)
    await assert.rejects(
      client.call(
        'bridge/spawnSession',
        { model: 'gpt-test', prompt: 'x', wait: false },
        5000,
        'missing',
      ),
      /Unknown bridge caller/,
    )
    await assert.rejects(
      fixed.call(
        'bridge/spawnSession',
        { model: 'gpt-test', prompt: 'x', wait: false },
        5000,
        'full',
      ),
      /does not match/,
    )
    assert.equal(starts.length, 2)
  } finally {
    client.close()
    fixed.close()
    await control.stop()
  }
})
