import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import readline from 'node:readline'
import test from 'node:test'
import { WebSocket } from 'ws'
import { BridgeControl, mcpServerRecord, providerFor } from '../src/bridge-control.mjs'
import { BRIDGE_TOOLS, renderResult } from '../src/bridge-mcp.mjs'
import { routeForModel } from '../src/codex-mux.mjs'
import { acpMcpServers } from '../src/grok-acp.mjs'

// The cross-engine bridge (src/bridge-control.mts + src/bridge-mcp.mts)
// against the mock Claude runtime and the FAKE `codex app-server` child. A
// real `jinn_bridge` MCP process is spawned exactly as an engine would spawn
// it (stdio JSON-RPC) and its tools are exercised end to end: model routing
// (opus -> local mock, gpt-* -> fake child), approvals surfacing on the
// desktop peer, and sub-agent fan-out linked under the calling thread.

const adapter = resolve('dist/src/adapter.mjs')
const fakeCodex = resolve('test/fixtures/fake-codex-app-server.mjs')
const TOKEN = 'bridge-test-token'

type Wire = Record<string, any>

class LineClient {
  readonly child: ChildProcess
  readonly messages: Wire[] = []
  private waiters: Array<{ predicate: (m: Wire) => boolean; resolve: (m: Wire) => void }> = []
  private nextId = 100

  constructor(child: ChildProcess) {
    this.child = child
    const rl = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream })
    rl.on('line', (line) => {
      if (!line.trim()) return
      const message = JSON.parse(line) as Wire
      this.messages.push(message)
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.predicate(message)) return true
        waiter.resolve(message)
        return false
      })
    })
  }

  send(message: Wire): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  async request(
    method: string,
    params: unknown,
    id: number | string = this.nextId++,
  ): Promise<Wire> {
    const response = this.waitFor((m) => m.id === id && !('method' in m))
    this.send({ jsonrpc: '2.0', id, method, params })
    return response
  }

  waitFor(predicate: (m: Wire) => boolean, timeoutMs = 15_000): Promise<Wire> {
    const existing = this.messages.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs)
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer)
          resolvePromise(m)
        },
      })
    })
  }

  async close(): Promise<void> {
    if (this.child.exitCode != null) return
    const exited = new Promise<void>((resolveExit) => this.child.once('exit', () => resolveExit()))
    this.child.stdin?.end()
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))])
    if (this.child.exitCode == null) this.child.kill('SIGKILL')
  }
}

function socketPathFor(home: string): string {
  return join(home, 'b.sock')
}

function launchAdapter(home: string): LineClient {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODEX_MOCK: '1',
    CLAUDE_CODEX_HOME: home,
    CLAUDE_CODEX_DEBUG_LOG: join(home, 'debug.jsonl'),
    CLAUDE_CODEX_REAL_CODEX: fakeCodex,
    CLAUDE_CODEX_MODELS: 'opus,sonnet',
    CLAUDE_CODEX_DEFAULT_MODEL: 'opus',
    CLAUDE_CODEX_RUNTIME_TYPE: 'mock',
    CLAUDE_CODEX_BRIDGE_SOCKET: socketPathFor(home),
    CLAUDE_CODEX_BRIDGE_TOKEN: TOKEN,
    CLAUDE_CODEX_SUBAGENT_COMPLETED: '1',
  }
  delete env.CLAUDE_CODEX_GPT_ROUTE
  delete env.CLAUDE_CODEX_RUNTIME_ENV
  delete env.CLAUDE_CODEX_NATIVE_CODEX
  const child = spawn(process.execPath, [adapter, 'app-server'], {
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  return new LineClient(child)
}

// The `jinn_bridge` MCP process, spawned the way an engine spawns it.
function launchBridge(home: string, threadId: string | null): LineClient {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODEX_BRIDGE_SOCKET: socketPathFor(home),
    CLAUDE_CODEX_BRIDGE_TOKEN: TOKEN,
  }
  if (threadId) env.CLAUDE_CODEX_BRIDGE_THREAD = threadId
  else delete env.CLAUDE_CODEX_BRIDGE_THREAD
  const child = spawn(process.execPath, [adapter, 'bridge-mcp'], {
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  return new LineClient(child)
}

async function initializeDesktop(desktop: LineClient): Promise<void> {
  const init = await desktop.request(
    'initialize',
    {
      clientInfo: { name: 'codex_desktop', title: 'Codex Desktop', version: '26.901' },
      capabilities: { subAgentActivityKinds: ['started', 'completed'] },
    },
    '__init__',
  )
  assert.equal(init.result.userAgent, 'codex_app_server/0.153.4 (fake)')
  desktop.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
}

async function initializeBridge(bridge: LineClient): Promise<void> {
  const init = await bridge.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-engine', version: '0' },
  })
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal(init.result.serverInfo.name, 'jinn-bridge')
  bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
}

async function callTool(bridge: LineClient, name: string, args: unknown): Promise<Wire> {
  const response = await bridge.request('tools/call', { name, arguments: args })
  assert.ok(response.result, `tools/call ${name} answered`)
  return response.result
}

// Accept every native approval the fake child raises on the desktop peer.
function autoApprove(desktop: LineClient): void {
  const answered = new Set<string>()
  const tick = () => {
    for (const m of desktop.messages) {
      if (m.method !== 'item/commandExecution/requestApproval' || m.id == null) continue
      if (answered.has(String(m.id))) continue
      answered.add(String(m.id))
      desktop.send({ jsonrpc: '2.0', id: m.id, result: { decision: 'accept' } })
    }
  }
  const timer = setInterval(tick, 20)
  timer.unref()
}

test('bridge: pure helpers (routing, MCP records, codex override, rendering)', () => {
  assert.equal(routeForModel('gpt-5.6-sol'), 'upstream')
  assert.equal(routeForModel('opus'), 'local')
  assert.equal(routeForModel('grok-4.6'), 'local')
  assert.equal(routeForModel('claude-opus-4'), 'local')
  assert.equal(routeForModel('mystery'), 'upstream')
  assert.equal(providerFor('gpt-5.6-sol'), 'openai')
  assert.equal(providerFor('grok-4.6'), 'xai')
  assert.equal(providerFor('haiku'), 'anthropic')

  const control = new BridgeControl(
    {
      handle: async () => {},
      closePeer: () => {},
      appPeerFor: () => null,
      threadInfo: () => null,
      routeForModel: () => 'local',
      soleActiveThread: () => null,
      createSubagentThread: () => ({ threadId: 'x', agentNickname: 'a', agentPath: '/root/a' }),
      emitParentItem: () => {},
      supportsCompletedActivity: () => false,
    },
    { socketPath: '/tmp/unused.sock', token: 'secret-token' },
  )
  const merged = control.mergeMcpServers('thread-1', {
    mcpServers: { github: { command: 'github-mcp' } },
  })
  assert.deepEqual(Object.keys(merged), ['github', 'jinn_bridge'])
  const spec = merged.jinn_bridge as Record<string, any>
  assert.equal(spec.command, process.execPath)
  assert.equal(spec.args[1], 'bridge-mcp')
  assert.equal(spec.env.CLAUDE_CODEX_BRIDGE_THREAD, 'thread-1')
  assert.equal(spec.env.CLAUDE_CODEX_BRIDGE_TOKEN, 'secret-token')
  assert.deepEqual(mcpServerRecord(null), {})

  const acp = acpMcpServers(merged)
  assert.equal(acp.length, 2)
  const bridgeAcp = acp.find((s) => s.name === 'jinn_bridge') as Record<string, any>
  assert.ok(
    bridgeAcp.env.some(
      (e: any) => e.name === 'CLAUDE_CODEX_BRIDGE_THREAD' && e.value === 'thread-1',
    ),
  )

  const codexArgs = control.codexConfigArgs()
  assert.equal(codexArgs[0], '-c')
  assert.match(codexArgs[1] ?? '', /^mcp_servers\.jinn_bridge=\{command=/)
  assert.match(codexArgs[1] ?? '', /tool_timeout_sec=3600/)
  assert.ok(!codexArgs[1]?.includes('secret-token'), 'token never appears in argv')
  assert.equal(control.codexChildEnv().CLAUDE_CODEX_BRIDGE_TOKEN, 'secret-token')

  assert.deepEqual(
    BRIDGE_TOOLS.map((t) => t.name),
    ['list_models', 'spawn_session', 'spawn_subagents', 'send_to_session', 'wait_session'],
  )
  assert.match(
    renderResult('spawn_session', { threadId: 't', turnId: 'u', status: 'completed', text: 'hi' }),
    /thread=t turn=u status=completed\nhi/,
  )
})

test('bridge: control socket refuses a bad token', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-'))
  const desktop = launchAdapter(home)
  try {
    await initializeDesktop(desktop)
    const status = await new Promise<number | string>((resolveStatus) => {
      const ws = new WebSocket(`ws+unix://${socketPathFor(home)}:/bridge`, {
        headers: { authorization: 'Bearer wrong' },
      })
      ws.once('unexpected-response', (_req, res) => resolveStatus(res.statusCode ?? 0))
      ws.once('error', (error) => resolveStatus(error.message))
      ws.once('open', () => resolveStatus('open'))
    })
    assert.equal(status, 401)
  } finally {
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('bridge: tools/list, list_models, spawn_session routes by model, send/wait', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-'))
  const desktop = launchAdapter(home)
  let bridge: LineClient | null = null
  try {
    await initializeDesktop(desktop)
    autoApprove(desktop)
    bridge = launchBridge(home, null)
    await initializeBridge(bridge)

    const tools = await bridge.request('tools/list', {})
    assert.deepEqual(
      tools.result.tools.map((t: Wire) => t.name),
      ['list_models', 'spawn_session', 'spawn_subagents', 'send_to_session', 'wait_session'],
    )

    const models = await callTool(bridge, 'list_models', {})
    const ids = models.structuredContent.models.map((m: Wire) => `${m.id}:${m.provider}`)
    assert.ok(ids.includes('gpt-5.6-sol:openai'), `child model listed: ${ids}`)
    assert.ok(ids.includes('opus:anthropic') && ids.includes('sonnet:anthropic'))
    assert.match(models.content[0].text, /gpt-5\.6-sol {2}\(GPT-5\.6 Sol, openai, default\)/)

    // Claude (display name) -> local mock runtime, new top-level thread.
    const claude = await callTool(bridge, 'spawn_session', {
      model: 'Claude Opus',
      prompt: 'Reply with PONG',
      title: 'bridge child',
    })
    assert.equal(claude.isError, false)
    const claudeResult = claude.structuredContent
    assert.equal(claudeResult.model, 'opus')
    assert.equal(claudeResult.status, 'completed')
    assert.match(claudeResult.text, /mock response for: Reply with PONG/)
    const claudeThread = claudeResult.threadId as string
    const started = await desktop.waitFor(
      (m) => m.method === 'thread/started' && m.params?.thread?.id === claudeThread,
    )
    assert.equal(started.params.thread.modelProvider, 'claude-code')
    assert.equal(started.params.thread.parentThreadId, null)
    await desktop.waitFor(
      (m) => m.method === 'turn/completed' && m.params?.threadId === claudeThread,
    )
    const listed = await desktop.request('thread/list', {})
    const row = listed.result.data.find((t: Wire) => t.id === claudeThread)
    assert.ok(row, 'spawned thread appears in the merged thread/list')
    assert.equal(row.name, 'bridge child')

    // gpt-* -> the fake child; its approval reaches the desktop peer.
    const gpt = await callTool(bridge, 'spawn_session', { model: 'gpt-5.6-sol', prompt: 'hi' })
    assert.equal(gpt.isError, false, gpt.content?.[0]?.text)
    assert.equal(gpt.structuredContent.threadId, 'fake-thread-1')
    assert.equal(gpt.structuredContent.status, 'completed')
    assert.equal(gpt.structuredContent.text, 'PONG')
    const approval = desktop.messages.find(
      (m) =>
        m.method === 'item/commandExecution/requestApproval' &&
        m.params?.threadId === 'fake-thread-1',
    )
    assert.ok(approval, 'child approval surfaced on the desktop peer')
    assert.match(String(approval.id), /^s\d+$/)
    await desktop.waitFor(
      (m) => m.method === 'turn/completed' && m.params?.threadId === 'fake-thread-1',
    )

    // Unknown model names are refused with the catalog.
    const bad = await callTool(bridge, 'spawn_session', { model: 'llama-9', prompt: 'x' })
    assert.equal(bad.isError, true)
    assert.match(bad.content[0].text, /unknown model "llama-9"; available: gpt-5\.6-sol/)

    // send_to_session continues the Claude thread; wait_session is idle after.
    const sent = await callTool(bridge, 'send_to_session', {
      threadId: claudeThread,
      prompt: 'Reply with PONG2',
    })
    assert.match(sent.structuredContent.text, /PONG2/)
    // Nothing running: wait_session answers with the last finished turn.
    const settled = await callTool(bridge, 'wait_session', { threadId: claudeThread })
    assert.equal(settled.structuredContent.status, 'completed')
    assert.equal(settled.structuredContent.turnId, sent.structuredContent.turnId)

    // A session that never ran is idle.
    const fresh = await desktop.request('thread/start', { cwd: home, model: 'sonnet' })
    const idle = await callTool(bridge, 'wait_session', { threadId: fresh.result.thread.id })
    assert.equal(idle.structuredContent.status, 'idle')

    // wait:false returns at once; wait_session then collects the text.
    const async = await callTool(bridge, 'send_to_session', {
      threadId: claudeThread,
      prompt: 'Reply with PONG3',
      wait: false,
    })
    assert.equal(async.structuredContent.status, 'inProgress')
    const waited = await callTool(bridge, 'wait_session', { threadId: claudeThread })
    assert.equal(waited.structuredContent.turnId, async.structuredContent.turnId)
    assert.match(waited.structuredContent.text, /PONG3/)
  } finally {
    await bridge?.close()
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('bridge: spawn_subagents fans out under the calling thread across engines', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-'))
  const desktop = launchAdapter(home)
  let bridge: LineClient | null = null
  try {
    await initializeDesktop(desktop)
    autoApprove(desktop)
    // The calling thread: a local Claude thread whose turn is parked on a
    // permission request, so the parent turn is active while the bridge works.
    const parentStart = await desktop.request('thread/start', {
      cwd: home,
      model: 'opus',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
    const parentId = parentStart.result.thread.id as string
    const parentTurn = await desktop.request('turn/start', {
      threadId: parentId,
      input: [{ type: 'text', text: 'run the approval command' }],
    })
    const parentTurnId = parentTurn.result.turn.id as string
    const parked = await desktop.waitFor(
      (m) =>
        m.method === 'item/commandExecution/requestApproval' && m.params?.threadId === parentId,
    )

    bridge = launchBridge(home, parentId)
    await initializeBridge(bridge)
    const fanout = await callTool(bridge, 'spawn_subagents', {
      tasks: [
        { model: 'sonnet', prompt: 'Reply with ALPHA', name: 'alpha' },
        { model: 'gpt-5.6-sol', prompt: 'Reply with BRAVO', name: 'bravo' },
        { model: 'opus', prompt: 'Reply with CHARLIE' },
      ],
    })
    assert.equal(fanout.isError, false, fanout.content?.[0]?.text)
    const { results } = fanout.structuredContent
    assert.equal(fanout.structuredContent.parentThreadId, parentId)
    assert.equal(fanout.structuredContent.parentTurnId, parentTurnId)
    assert.deepEqual(
      results.map((r: Wire) => [r.name, r.model, r.status]),
      [
        ['alpha', 'sonnet', 'completed'],
        ['bravo', 'gpt-5.6-sol', 'completed'],
        ['task-3', 'opus', 'completed'],
      ],
    )
    assert.match(results[0].text, /ALPHA/)
    assert.equal(results[1].text, 'PONG')
    assert.match(results[2].text, /CHARLIE/)
    assert.match(
      fanout.content[0].text,
      /\[bravo\] model=gpt-5\.6-sol thread=fake-thread-1 status=completed\nPONG/,
    )

    // Local children are linked under the parent like Task sub-agents.
    const alphaId = results[0].threadId as string
    const alphaStarted = await desktop.waitFor(
      (m) => m.method === 'thread/started' && m.params?.thread?.id === alphaId,
    )
    assert.equal(alphaStarted.params.thread.parentThreadId, parentId)
    assert.equal(alphaStarted.params.thread.threadSource, 'subagent')
    assert.equal(alphaStarted.params.thread.agentRole, 'alpha')
    assert.equal(alphaStarted.params.thread.name, 'alpha')
    await desktop.waitFor((m) => m.method === 'turn/completed' && m.params?.threadId === alphaId)

    // The parent's turn carries the collab timeline for every child.
    const spawns = desktop.messages.filter(
      (m) =>
        m.method === 'item/completed' &&
        m.params?.threadId === parentId &&
        m.params?.item?.type === 'collabAgentToolCall' &&
        m.params?.item?.tool === 'spawnAgent',
    )
    assert.deepEqual(
      spawns.map((m) => m.params.item.receiverThreadIds[0]).sort(),
      results.map((r: Wire) => r.threadId).sort(),
    )
    const waits = desktop.messages.filter(
      (m) =>
        m.method === 'item/completed' &&
        m.params?.threadId === parentId &&
        m.params?.item?.type === 'collabAgentToolCall' &&
        m.params?.item?.tool === 'wait',
    )
    assert.equal(waits.length, 3)
    for (const wait of waits) {
      assert.equal(wait.params.item.status, 'completed')
      const child = wait.params.item.receiverThreadIds[0]
      assert.equal(wait.params.item.agentsStates[child].status, 'completed')
    }
    const activities = desktop.messages.filter(
      (m) =>
        m.method === 'item/completed' &&
        m.params?.threadId === parentId &&
        m.params?.item?.type === 'subAgentActivity',
    )
    assert.deepEqual(activities.map((m) => m.params.item.kind).sort(), [
      'completed',
      'completed',
      'completed',
      'started',
      'started',
      'started',
    ])

    // Release the parent turn; its persisted items include the collab calls.
    desktop.send({ jsonrpc: '2.0', id: parked.id, result: { decision: 'accept' } })
    await desktop.waitFor((m) => m.method === 'turn/completed' && m.params?.threadId === parentId)
    const read = await desktop.request('thread/read', { threadId: parentId, includeTurns: true })
    const items = read.result.thread.turns[0].items as Wire[]
    assert.equal(
      items.filter((i) => i.type === 'collabAgentToolCall' && i.tool === 'spawnAgent').length,
      3,
    )
    assert.equal(
      items.filter((i) => i.type === 'collabAgentToolCall' && i.tool === 'wait').length,
      3,
    )
  } finally {
    await bridge?.close()
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})
