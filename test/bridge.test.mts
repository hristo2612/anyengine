import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import readline from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import test, { after } from 'node:test'
import { WebSocket } from 'ws'
import {
  BridgeControl,
  type BridgeThreadInfo,
  nicknameFor,
  providerFor,
} from '../src/bridge-control.mjs'
import { registerSandboxUpstream, runBridgeExec } from '../src/bridge-exec.mjs'
import {
  appendBridgeInstructions,
  BRIDGE_LINE,
  BRIDGE_LINE_GPT,
  type BridgeCatalogModel,
  bridgeInstructions,
  bridgeInstructionsEnabled,
  resolveModelAlias,
} from '../src/bridge-instructions.mjs'
import { BRIDGE_TOOLS, renderResult, toolsFor } from '../src/bridge-mcp.mjs'
import { routeForModel } from '../src/codex-mux.mjs'
import { acpMcpServers } from '../src/grok-acp.mjs'
import { mcpServerRecord } from '../src/mcp.mjs'
import { DEFAULT_POSTURE, type Posture } from '../src/posture.mjs'
import { killChildren, spawn } from './helpers/children.mjs'

import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(() => killChildren())
after(removeTempDirs)

// The cross-engine bridge (src/bridge-control.mts + src/bridge-mcp.mts)
// against the mock Claude runtime and the FAKE `codex app-server` child. A
// real `anyengine` MCP process is spawned exactly as an engine would spawn
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

function launchAdapter(home: string, extraEnv: NodeJS.ProcessEnv = {}): LineClient {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANYENGINE_MOCK: '1',
    ANYENGINE_HOME: home,
    ANYENGINE_DEBUG_LOG: join(home, 'debug.jsonl'),
    ANYENGINE_REAL_CODEX: fakeCodex,
    ANYENGINE_MODELS: 'opus,sonnet',
    ANYENGINE_DEFAULT_MODEL: 'opus',
    ANYENGINE_RUNTIME_TYPE: 'mock',
    ANYENGINE_BRIDGE_SOCKET: socketPathFor(home),
    ANYENGINE_BRIDGE_TOKEN: TOKEN,
    ANYENGINE_SUBAGENT_COMPLETED: '1',
    ...extraEnv,
  }
  delete env.ANYENGINE_GPT_ROUTE
  delete env.ANYENGINE_RUNTIME_ENV
  delete env.ANYENGINE_NATIVE_CODEX
  const child = spawn(process.execPath, [adapter, 'app-server'], {
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  return new LineClient(child)
}

// The `anyengine` MCP process, spawned the way an engine spawns it.
function launchBridge(home: string, threadId: string | null): LineClient {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANYENGINE_BRIDGE_SOCKET: socketPathFor(home),
    ANYENGINE_BRIDGE_TOKEN: TOKEN,
  }
  if (threadId) env.ANYENGINE_BRIDGE_THREAD = threadId
  else delete env.ANYENGINE_BRIDGE_THREAD
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
  assert.equal(init.result.serverInfo.name, 'anyengine')
  assert.equal(init.result.instructions, undefined, 'tool descriptions carry bridge details')
  bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
}

async function callTool(bridge: LineClient, name: string, args: unknown): Promise<Wire> {
  const response = await bridge.request('tools/call', { name, arguments: args })
  assert.ok(response.result, `tools/call ${name} answered`)
  return response.result
}

// Accept every native approval the fake child raises on the desktop peer.
// Accepts every command approval the desktop sees, except those `answers`
// leaves to the test: a test that parks a turn on its own approval answers it
// itself, when it is done with the turn.
function autoApprove(desktop: LineClient, answers: (m: Wire) => boolean = () => true): void {
  const answered = new Set<string>()
  const tick = () => {
    for (const m of desktop.messages) {
      if (m.method !== 'item/commandExecution/requestApproval' || m.id == null) continue
      if (answered.has(String(m.id)) || !answers(m)) continue
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
      activeThreadIds: () => [],
      createSubagentThread: () => ({ threadId: 'x', agentNickname: 'a', agentPath: '/root/a' }),
      inheritFromCaller: () => {},
      emitParentItem: () => {},
      supportsCompletedActivity: () => false,
    },
    { socketPath: '/tmp/unused.sock', token: 'secret-token' },
  )
  const merged = control.mergeMcpServers('thread-1', {
    mcpServers: { github: { command: 'github-mcp' } },
  })
  assert.deepEqual(Object.keys(merged), ['github', 'anyengine'])
  const spec = merged.anyengine as Record<string, any>
  assert.equal(spec.command, process.execPath)
  assert.equal(spec.args[1], 'bridge-mcp')
  assert.equal(spec.env.ANYENGINE_BRIDGE_THREAD, 'thread-1')
  assert.equal(spec.env.ANYENGINE_BRIDGE_TOKEN, 'secret-token')
  assert.deepEqual(mcpServerRecord(null), {})

  const acp = acpMcpServers(merged)
  assert.equal(acp.length, 2)
  const bridgeAcp = acp.find((s) => s.name === 'anyengine') as Record<string, any>
  assert.ok(
    bridgeAcp.env.some((e: any) => e.name === 'ANYENGINE_BRIDGE_THREAD' && e.value === 'thread-1'),
  )

  const codexArgs = control.codexConfigArgs()
  assert.equal(codexArgs[0], '-c')
  assert.match(codexArgs[1] ?? '', /^mcp_servers\.anyengine=\{command=/)
  assert.match(codexArgs[1] ?? '', /tool_timeout_sec=3600/)
  assert.ok(!codexArgs[1]?.includes('secret-token'), 'token never appears in argv')
  assert.equal(control.codexChildEnv().ANYENGINE_BRIDGE_TOKEN, 'secret-token')

  assert.deepEqual(
    BRIDGE_TOOLS.map((t) => t.name),
    ['list_models', 'spawn_session', 'spawn_subagents', 'send_to_session', 'wait_session', 'exec'],
  )
  assert.ok(!toolsFor(null).some((t) => t.name === 'exec'), 'no thread id, no exec')
  assert.match(
    renderResult('exec', { exitCode: 2, stdout: 'out\n', stderr: 'err\n' }),
    /^exit 2\nout\n\n\[stderr\]\nerr$/,
  )
  assert.match(
    renderResult('spawn_session', { threadId: 't', turnId: 'u', status: 'completed', text: 'hi' }),
    /thread=t turn=u status=completed\nhi/,
  )
})

test('bridge: refused child admission never announces running work', async () => {
  const home = await tempDir('bridge-admission')
  const emitted: unknown[] = []
  const control = new BridgeControl(
    {
      handle: async (peer, message) => {
        if (!('id' in message) || !('method' in message)) return
        peer.send({
          jsonrpc: '2.0',
          id: message.id,
          ...(message.method === 'model/list'
            ? { result: { data: [{ id: 'opus' }] } }
            : { error: { code: -32000, message: 'Account switching is in progress' } }),
        })
      },
      closePeer() {},
      appPeerFor: () => null,
      threadInfo: () => ({
        id: 'parent',
        owner: 'local',
        cwd: home,
        model: 'opus',
        posture: DEFAULT_POSTURE,
        activeTurnId: 'parent-turn',
      }),
      routeForModel: () => 'local',
      activeThreadIds: () => ['parent'],
      createSubagentThread: () => ({ threadId: 'child', agentNickname: 'a', agentPath: '/root/a' }),
      inheritFromCaller() {},
      emitParentItem: (_thread, _turn, item) => emitted.push(item),
      supportsCompletedActivity: () => true,
    },
    { socketPath: socketPathFor(home), token: TOKEN },
  )
  let bridge: LineClient | null = null
  try {
    await control.start()
    bridge = launchBridge(home, 'parent')
    await initializeBridge(bridge)
    const response = await callTool(bridge, 'spawn_subagents', {
      tasks: [{ model: 'opus', prompt: 'Read-only review' }],
    })
    assert.equal(response.structuredContent.results[0].status, 'failed')
    assert.match(response.structuredContent.results[0].error, /Account switching/)
    assert.deepEqual(emitted, [], 'refused turns cannot hold the managed work gate')
  } finally {
    await bridge?.close()
    await control.stop()
  }
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

    // Nothing running: wait_session answers with the last finished turn.
    const settled = await callTool(bridge, 'wait_session', { threadId: claudeThread })
    assert.equal(settled.structuredContent.status, 'completed')
    assert.equal(settled.structuredContent.turnId, claudeResult.turnId)

    // A session that never ran is idle.
    const fresh = await desktop.request('thread/start', { cwd: home, model: 'sonnet' })
    const idle = await callTool(bridge, 'wait_session', { threadId: fresh.result.thread.id })
    assert.equal(idle.structuredContent.status, 'idle')

    // With no calling thread known, nothing may be continued, not even what
    // this connection spawned.
    const orphan = await callTool(bridge, 'send_to_session', {
      threadId: claudeThread,
      prompt: 'x',
    })
    assert.equal(orphan.isError, true)
    assert.match(orphan.content[0].text, /needs a known calling thread/)
  } finally {
    await bridge?.close()
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

// send_to_session runs a turn under the TARGET's posture, so a thread may
// drive only what it started (at any depth): a child got no more than its
// spawner held. Anything else would let a read-only thread run turns on a
// full-access one. A caller with full access has nothing left to gain.
test('bridge: send_to_session drives only threads the caller started', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-send-'))
  const desktop = launchAdapter(home)
  const bridges: LineClient[] = []
  const connect = async (threadId: string | null): Promise<LineClient> => {
    const bridge = launchBridge(home, threadId)
    bridges.push(bridge)
    await initializeBridge(bridge)
    return bridge
  }
  const refused = async (bridge: LineClient, threadId: string, pattern: RegExp) => {
    const result = await callTool(bridge, 'send_to_session', { threadId, prompt: 'x' })
    assert.equal(result.isError, true, `send to ${threadId} was refused`)
    assert.match(result.content[0].text, pattern)
  }
  try {
    await initializeDesktop(desktop)
    autoApprove(desktop)
    const start = async (params: Wire): Promise<string> =>
      (await desktop.request('thread/start', { cwd: home, model: 'opus', ...params })).result.thread
        .id
    const reader = await start({ approvalPolicy: 'on-request', sandbox: 'read-only' })
    const open = await start({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
    const caller = await connect(reader)
    const notMine = /was not started by the calling thread/

    // A read-only caller cannot run a turn on a full-access thread.
    await refused(caller, open, notMine)

    // It continues what it spawned, on every route, and what those spawned.
    const child = await callTool(caller, 'spawn_session', { model: 'sonnet', prompt: 'x' })
    assert.equal(child.isError, false, child.content?.[0]?.text)
    const childId = child.structuredContent.threadId as string
    const fanout = await callTool(caller, 'spawn_subagents', {
      tasks: [
        { model: 'sonnet', prompt: 'x' },
        { model: 'gpt-5.6-sol', prompt: 'x' },
      ],
    })
    assert.equal(fanout.isError, false, fanout.content?.[0]?.text)
    const fromChild = await connect(childId)
    const grandchild = await callTool(fromChild, 'spawn_session', { model: 'sonnet', prompt: 'x' })
    const targets = [
      childId,
      ...fanout.structuredContent.results.map((r: Wire) => r.threadId as string),
      grandchild.structuredContent.threadId as string,
    ]
    for (const threadId of targets) {
      const sent = await callTool(caller, 'send_to_session', { threadId, prompt: 'Reply with ON' })
      assert.equal(sent.isError, false, sent.content?.[0]?.text)
      assert.equal(sent.structuredContent.status, 'completed', threadId)
    }
    const again = await callTool(caller, 'send_to_session', {
      threadId: childId,
      prompt: 'Reply with PONG2',
    })
    assert.match(again.structuredContent.text, /PONG2/)
    const settled = await callTool(caller, 'wait_session', { threadId: childId })
    assert.equal(settled.structuredContent.turnId, again.structuredContent.turnId)
    // wait:false returns at once; wait_session then collects the text.
    const async = await callTool(caller, 'send_to_session', {
      threadId: childId,
      prompt: 'Reply with PONG3',
      wait: false,
    })
    assert.equal(async.structuredContent.status, 'inProgress')
    const waited = await callTool(caller, 'wait_session', { threadId: childId })
    assert.equal(waited.structuredContent.turnId, async.structuredContent.turnId)
    assert.match(waited.structuredContent.text, /PONG3/)

    // A child cannot drive the thread that spawned it, nor a sibling's tree.
    await refused(fromChild, reader, notMine)
    await refused(fromChild, targets[1] as string, notMine)
    // A caller the bridge cannot identify drives nothing.
    await refused(await connect(null), childId, /needs a known calling thread/)
    // Nor does a thread id no store knows.
    await refused(await connect('no-such-thread'), childId, /needs a known calling thread/)

    // Full access with nothing that asks may drive any thread.
    const unrestricted = await connect(open)
    const sent = await callTool(unrestricted, 'send_to_session', { threadId: reader, prompt: 'x' })
    assert.equal(sent.isError, false, sent.content?.[0]?.text)
  } finally {
    for (const bridge of bridges) await bridge.close()
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('bridge: spawn_subagents fans out under the calling thread across engines', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-'))
  const desktop = launchAdapter(home, { FAKE_CODEX_REQUESTS_FILE: join(home, 'requests.jsonl') })
  let bridge: LineClient | null = null
  try {
    await initializeDesktop(desktop)
    // The calling thread: a local Claude thread whose turn is parked on a
    // question to the user, so the parent turn is active while the bridge works.
    const parentStart = await desktop.request('thread/start', {
      cwd: home,
      model: 'opus',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
    const parentId = parentStart.result.thread.id as string
    // The children's approvals, not the parent's: answering that one would end
    // the parent turn before the bridge asks for it (parentTurnId null under load).
    autoApprove(desktop, (m) => m.params?.threadId !== parentId)
    const parentTurn = await desktop.request('turn/start', {
      threadId: parentId,
      input: [{ type: 'text', text: 'ask user question check' }],
    })
    const parentTurnId = parentTurn.result.turn.id as string
    const parked = await desktop.waitFor(
      (m) => m.method === 'item/tool/requestUserInput' && m.params?.threadId === parentId,
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
    const receipts = (await readFile(join(home, 'debug.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === 'bridge.subagent.done')
    assert.equal(receipts.length, 3, 'all actual terminal subagents have correlated receipts')
    const gptReceipt = receipts.find((event) => event.threadId === results[1].threadId)
    assert.deepEqual(
      [
        gptReceipt?.parentThreadId,
        gptReceipt?.parentTurnId,
        gptReceipt?.model,
        gptReceipt?.status,
        gptReceipt?.success,
      ],
      [parentId, parentTurnId, 'gpt-5.6-sol', 'completed', true],
    )
    assert.equal(typeof gptReceipt?.turnId, 'string')
    const selections = (await readFile(join(home, 'debug.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((e) => e.event === 'bridge.thread.started' && e.threadId === results[1].threadId)
    assert.equal(selections.length, 1)
    assert.equal(selections[0].model, 'gpt-5.6-sol')
    // The GPT child starts under the parent's posture, roots and network
    // included (on the first turn), not the child's config defaults.
    const requests = (await readFile(join(home, 'requests.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Wire)
    const childStart = requests.find(
      (r) => r.method === 'thread/start' && r.params?.model === 'gpt-5.6-sol',
    )
    assert.equal(childStart?.params.approvalPolicy, 'on-request')
    assert.equal(childStart?.params.approvalsReviewer, 'user')
    assert.equal(childStart?.params.sandbox, 'workspace-write')
    const childTurn = requests.find(
      (r) => r.method === 'turn/start' && r.params?.threadId === results[1].threadId,
    )
    assert.deepEqual(childTurn?.params.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    })
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
    const answers = { q0: { answers: ['OAuth'] } }
    desktop.send({ jsonrpc: '2.0', id: parked.id, result: { answers } })
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

// ChatGPT.app 26.928's own requests: the parent's sub-agent panel, a direct
// children list, and the sidebar.
const panelQuery = (ancestorThreadId: string) => ({
  limit: 200,
  cursor: null,
  modelProviders: null,
  archived: false,
  ancestorThreadId,
  sourceKinds: ['subAgentThreadSpawn'],
  sortDirection: 'desc',
  sortKey: 'created_at',
  useStateDbOnly: true,
})
const SIDEBAR_QUERY = {
  archived: false,
  cursor: null,
  limit: 100,
  modelProviders: [],
  parentThreadId: null,
  sortKey: 'updated_at',
  sortDirection: 'desc',
  sourceKinds: [],
  useStateDbOnly: true,
}

// The app treats a thread as a sub-agent of `parent` when `parentThreadId`,
// else `source.subAgent.thread_spawn.parent_thread_id`, names it; both are
// set, as on a local child (src/upstream-subagents.mts).
function assertSubagentOf(thread: Wire, parent: string, role: string, depth = 1): void {
  const nickname = nicknameFor(thread.id)
  assert.equal(thread.parentThreadId, parent, `${thread.id} parentThreadId`)
  assert.deepEqual(thread.source, {
    subAgent: {
      thread_spawn: {
        parent_thread_id: parent,
        depth,
        agent_path: `/root/${nickname}`,
        agent_nickname: nickname,
        agent_role: role,
      },
    },
  })
  assert.equal(thread.agentNickname, nickname)
  assert.equal(thread.agentRole, role)
}

// Every `thread/started` the desktop saw for `id`: its Thread and its place.
function announcements(desktop: LineClient, id: string): Array<{ thread: Wire; at: number }> {
  return desktop.messages.flatMap((m, at) =>
    m.method === 'thread/started' && m.params?.thread?.id === id
      ? [{ thread: m.params.thread as Wire, at }]
      : [],
  )
}

// The one `thread/started` the desktop saw for `id`.
function announced(desktop: LineClient, id: string): { thread: Wire; at: number } {
  const all = announcements(desktop, id)
  assert.equal(all.length, 1, `one thread/started for ${id}`)
  return all[0] as { thread: Wire; at: number }
}

// Until the fake child has received `method` (FAKE_CODEX_REQUESTS_FILE).
async function untilRequested(file: string, method: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const log = await readFile(file, 'utf8').catch(() => '')
    if (log.includes(`{"method":"${method}"`)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`the fake child never received ${method}`)
}

// 2026-09-30: a Sonnet parent fanned out to sonnet + gpt-6-luna; the Sonnet
// child opened from the parent, the Luna one did not, and sat in the sidebar
// as a thread of its own. The child records a bridge `thread/start` as a plain
// desktop thread, so the adapter now links it and presents it.
test('bridge: a GPT sub-agent of a Claude parent is a sub-agent wherever the app reads it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-'))
  const env = { FAKE_CODEX_LIST_STARTED: '1', FAKE_CODEX_REQUESTS_FILE: join(home, 'req.jsonl') }
  let desktop = launchAdapter(home, env)
  let bridge: LineClient | null = null
  let gptId = ''
  let parentId = ''
  try {
    await initializeDesktop(desktop)
    autoApprove(desktop)
    const parent = await desktop.request('thread/start', {
      cwd: home,
      model: 'opus',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
    parentId = parent.result.thread.id as string
    bridge = launchBridge(home, parentId)
    await initializeBridge(bridge)
    const fanout = await callTool(bridge, 'spawn_subagents', {
      tasks: [
        { model: 'sonnet', prompt: 'Reply with exactly: PONG', name: 'sonnet' },
        { model: 'gpt-5.6-sol', prompt: 'Reply with exactly: PONG', name: 'luna' },
      ],
    })
    assert.equal(fanout.isError, false, fanout.content?.[0]?.text)
    const results = fanout.structuredContent.results as Wire[]
    const sonnet = results[0] as Wire
    const luna = results[1] as Wire
    assert.deepEqual([sonnet.status, luna.status], ['completed', 'completed'])
    gptId = luna.threadId as string
    assert.equal(gptId, 'fake-thread-1')

    // The fake announces the thread before answering the start, so that
    // announcement goes out plain; the answer links it and it is announced
    // again, naming the parent, ahead of the child's turn. (Codex 0.159
    // answers first: one linked announcement, next test.)
    const [plain, linked] = announcements(desktop, gptId)
    assert.equal(announcements(desktop, gptId).length, 2)
    assert.equal(plain?.thread.parentThreadId, null)
    assertSubagentOf(linked?.thread ?? {}, parentId, 'luna')
    const firstTurn = desktop.messages.findIndex(
      (m) => m.method === 'turn/started' && m.params?.threadId === gptId,
    )
    assert.ok((linked?.at ?? Infinity) < firstTurn, 'announced, linked, before its turn')
    // The linkage is the adapter's: the child's request carries none of it,
    // and the child's posture is what the parent gave it, as before.
    const childStart = (await requestLog(join(home, 'req.jsonl'))).find(
      (r) => r.method === 'thread/start',
    )
    assert.ok(childStart && !('anyengineSubagent' in childStart.params))
    assert.equal(childStart.params.sandbox, 'workspace-write')

    // The parent's panel lists both children, newest first, both linked.
    const panel = await desktop.request('thread/list', panelQuery(parentId))
    const rows = panel.result.data as Wire[]
    assert.deepEqual(rows.map((t) => t.id).sort(), [gptId, sonnet.threadId].sort())
    const created = rows.map((t) => Number(t.createdAt))
    assert.deepEqual(
      created,
      [...created].sort((a, b) => b - a),
      'newest first',
    )
    assertSubagentOf(rows.find((t) => t.id === gptId) as Wire, parentId, 'luna')
    assert.equal(rows.find((t) => t.id === sonnet.threadId)?.parentThreadId, parentId)
    const direct = await desktop.request('thread/list', {
      parentThreadId: parentId,
      sourceKinds: ['subAgentThreadSpawn'],
    })
    assert.deepEqual(direct.result.data.map((t: Wire) => t.id).sort(), rows.map((t) => t.id).sort())
    // The sidebar keeps it out, although the child lists it as a plain thread.
    const sidebar = await desktop.request('thread/list', SIDEBAR_QUERY)
    const sidebarIds = sidebar.result.data.map((t: Wire) => t.id)
    assert.ok(sidebarIds.includes(parentId) && sidebarIds.includes('fake-newest'))
    assert.ok(!sidebarIds.includes(gptId), 'no GPT sub-agent in the sidebar')
    assert.ok(!sidebarIds.includes(sonnet.threadId), 'no Claude sub-agent in the sidebar')

    // Opening it: the reads and the resume the app sends, answered by the child.
    const meta = await desktop.request('thread/read', { threadId: gptId, includeTurns: false })
    assert.equal(meta.result.fake, true)
    assertSubagentOf(meta.result.thread, parentId, 'luna')
    const resumed = await desktop.request('thread/resume', { threadId: gptId })
    assertSubagentOf(resumed.result.thread, parentId, 'luna')
    const full = await desktop.request('thread/read', { threadId: gptId, includeTurns: true })
    assertSubagentOf(full.result.thread, parentId, 'luna')
    const said = (full.result.thread.turns as Wire[]).flatMap((turn) => turn.items)
    assert.ok(said.some((item: Wire) => item.type === 'agentMessage' && item.text === 'PONG'))
  } finally {
    await bridge?.close()
    await desktop.close()
  }

  // A fresh adapter and child: the child knows nothing, the store does.
  desktop = launchAdapter(home, env)
  try {
    await initializeDesktop(desktop)
    const panel = await desktop.request('thread/list', panelQuery(parentId))
    const restored = (panel.result.data as Wire[]).find((t) => t.id === gptId)
    assert.ok(restored, 'still listed under its parent after a restart')
    assertSubagentOf(restored, parentId, 'luna')
    const meta = await desktop.request('thread/read', { threadId: gptId, includeTurns: false })
    assertSubagentOf(meta.result.thread, parentId, 'luna')
  } finally {
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

// The first cut held every unlinked thread/started while a sub-agent start
// was unanswered: a chat the operator opened during a fan-out was announced
// after its own turn had started, and the app reset it to idle.
test('bridge: a new chat opened while a sub-agent start is unanswered is announced at once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-'))
  const requests = join(home, 'req.jsonl')
  const desktop = launchAdapter(home, {
    FAKE_CODEX_SLOW_FIRST_START: '3000',
    FAKE_CODEX_REQUESTS_FILE: requests,
  })
  let bridge: LineClient | null = null
  try {
    await initializeDesktop(desktop)
    autoApprove(desktop)
    const parent = await desktop.request('thread/start', { cwd: home, model: 'opus' })
    const parentId = parent.result.thread.id as string
    bridge = launchBridge(home, parentId)
    await initializeBridge(bridge)
    const tasks = [{ model: 'gpt-5.6-sol', prompt: 'x', name: 'luna' }]
    const fanout = callTool(bridge, 'spawn_subagents', { tasks })
    // The child has the sub-agent start and sits on it for 3 s.
    await untilRequested(requests, 'thread/start')
    const chat = await desktop.request('thread/start', { cwd: home, model: 'gpt-5.6-sol' })
    const chatId = chat.result.thread.id as string
    await completedTurn(desktop, {
      threadId: chatId,
      input: [{ type: 'text', text: 'hi', text_elements: [] }],
    })
    const chatStarted = announced(desktop, chatId)
    const chatTurn = desktop.messages.findIndex(
      (m) => m.method === 'turn/started' && m.params?.threadId === chatId,
    )
    assert.ok(chatStarted.at < chatTurn, 'the chat is announced ahead of its own turn')
    assert.equal(chatStarted.thread.parentThreadId, null)

    const result = await fanout
    assert.equal(result.isError, false, result.content?.[0]?.text)
    const lunaId = result.structuredContent.results[0].threadId as string
    const luna = announcements(desktop, lunaId)
    assert.ok(chatStarted.at < (luna[0]?.at ?? -1), 'while the sub-agent start was unanswered')
    assertSubagentOf(luna.at(-1)?.thread ?? {}, parentId, 'luna')
  } finally {
    await bridge?.close()
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

// A GPT parent's bridge children are plain threads to the child as well:
// codex links only the sub-agents it spawns itself. Here the child answers
// `thread/start` first and announces the thread after, as codex 0.159 does.
test('bridge: GPT sub-agents of a GPT parent are linked once, at every depth', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-'))
  const desktop = launchAdapter(home, { FAKE_CODEX_STARTED_LAST: '1' })
  const bridges: LineClient[] = []
  const spawnFrom = async (caller: string, name: string): Promise<string> => {
    const bridge = launchBridge(home, caller)
    bridges.push(bridge)
    await initializeBridge(bridge)
    const tasks = [{ model: 'gpt-5.6-sol', prompt: 'x', name }]
    const fanout = await callTool(bridge, 'spawn_subagents', { tasks })
    assert.equal(fanout.isError, false, fanout.content?.[0]?.text)
    assert.equal(fanout.structuredContent.results[0].status, 'completed')
    return fanout.structuredContent.results[0].threadId as string
  }
  try {
    await initializeDesktop(desktop)
    autoApprove(desktop)
    const parent = await desktop.request('thread/start', { cwd: home, model: 'gpt-5.6-sol' })
    const parentId = parent.result.thread.id as string
    const child = await spawnFrom(parentId, 'child')
    const grandchild = await spawnFrom(child, 'grandchild')
    assert.deepEqual(
      [parentId, child, grandchild],
      ['fake-thread-1', 'fake-thread-2', 'fake-thread-3'],
    )

    // One announcement each, linked; the parent stays a plain thread.
    assert.equal(announced(desktop, parentId).thread.parentThreadId, null)
    assertSubagentOf(announced(desktop, child).thread, parentId, 'child')
    assertSubagentOf(announced(desktop, grandchild).thread, child, 'grandchild', 2)

    const panel = await desktop.request('thread/list', panelQuery(parentId))
    assert.deepEqual(panel.result.data.map((t: Wire) => t.id).sort(), [child, grandchild])
    const direct = await desktop.request('thread/list', {
      parentThreadId: parentId,
      sourceKinds: ['subAgentThreadSpawn'],
    })
    assert.deepEqual(
      direct.result.data.map((t: Wire) => t.id),
      [child],
    )
    const childPanel = await desktop.request('thread/list', panelQuery(child))
    assert.deepEqual(
      childPanel.result.data.map((t: Wire) => t.id),
      [grandchild],
    )
    const read = await desktop.request('thread/read', { threadId: parentId, includeTurns: false })
    assert.equal(read.result.thread.parentThreadId, null)
    assert.equal(read.result.thread.source, 'appServer')
    const resumed = await desktop.request('thread/resume', { threadId: grandchild })
    assertSubagentOf(resumed.result.thread, child, 'grandchild', 2)
  } finally {
    for (const bridge of bridges) await bridge.close()
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

const ALIAS_CATALOG: BridgeCatalogModel[] = [
  { id: 'fable', displayName: 'Claude Fable 5.1', provider: 'anthropic', isDefault: true },
  { id: 'opus', displayName: 'Claude Opus', provider: 'anthropic' },
  { id: 'sonnet', displayName: 'Claude Sonnet', provider: 'anthropic' },
  { id: 'sonnet-1m', displayName: 'Claude Sonnet 1M', provider: 'anthropic' },
  { id: 'haiku', displayName: 'Claude Haiku', provider: 'anthropic' },
  { id: 'grok-4.6', displayName: 'Grok 4.6', provider: 'xai' },
  { id: 'grok-4.5', displayName: 'Grok 4.5', provider: 'xai' },
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', provider: 'openai', isDefault: true },
  { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', provider: 'openai' },
  { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', provider: 'openai' },
]

async function requestLog(file: string): Promise<Wire[]> {
  const raw = await readFile(file, 'utf8')
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Wire)
}

async function completedTurn(desktop: LineClient, params: Wire): Promise<void> {
  const started = await desktop.request('turn/start', params)
  assert.ok(started.result?.turn?.id, `turn/start rejected: ${JSON.stringify(started.error)}`)
  await desktop.waitFor(
    (m) => m.method === 'turn/completed' && m.params?.turn?.id === started.result.turn.id,
  )
}

// A thread born on Claude and moved to GPT answers under the child's id, but
// the bridge knows it by the app's: its children must take the posture the
// app set while it was on GPT, not the one its last Claude turn left.
test('bridge: children of a thread moved to GPT take the posture set there', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-'))
  const requestsFile = join(home, 'requests.jsonl')
  const desktop = launchAdapter(home, { FAKE_CODEX_REQUESTS_FILE: requestsFile })
  let bridge: LineClient | null = null
  try {
    await initializeDesktop(desktop)
    autoApprove(desktop)
    const start = await desktop.request('thread/start', {
      cwd: home,
      model: 'opus',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
    const threadId = start.result.thread.id as string
    await completedTurn(desktop, {
      threadId,
      model: 'gpt-5.6-sol',
      input: [{ type: 'text', text: 'a' }],
    })
    await completedTurn(desktop, {
      threadId,
      input: [{ type: 'text', text: 'b' }],
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })

    bridge = launchBridge(home, threadId)
    await initializeBridge(bridge)
    const spawned = await callTool(bridge, 'spawn_session', { model: 'gpt-5.6-sol', prompt: 'hi' })
    assert.equal(spawned.isError, false, spawned.content?.[0]?.text)
    const childId = spawned.structuredContent.threadId
    const log = await requestLog(requestsFile)
    const childStart = log.filter((r) => r.method === 'thread/start').at(-1)
    assert.equal(childStart?.params.approvalPolicy, 'untrusted')
    assert.equal(childStart?.params.sandbox, 'read-only')
    const childTurn = log.find((r) => r.method === 'turn/start' && r.params?.threadId === childId)
    assert.deepEqual(childTurn?.params.sandboxPolicy, { type: 'readOnly', networkAccess: false })
  } finally {
    await bridge?.close()
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

test("bridge: exec runs through the child's command/exec under the caller's sandbox", async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-exec-'))
  const requests = join(home, 'requests.jsonl')
  const desktop = launchAdapter(home, { FAKE_CODEX_REQUESTS_FILE: requests })
  const bridges: LineClient[] = []
  try {
    await initializeDesktop(desktop)
    const parent = await desktop.request('thread/start', {
      cwd: home,
      model: 'opus',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    })
    const bridge = launchBridge(home, parent.result.thread.id)
    bridges.push(bridge)
    await initializeBridge(bridge)
    const tools = await bridge.request('tools/list', {})
    const listed = tools.result.tools as Array<{ name: string; _meta?: Record<string, unknown> }>
    // exec is never deferred behind Claude Code's tool search; nothing else is forced in.
    for (const tool of listed) {
      assert.equal(tool._meta?.['anthropic/alwaysLoad'] === true, tool.name === 'exec', tool.name)
    }
    assert.ok(
      tools.result.tools.some((t: Wire) => t.name === 'exec'),
      'a bridge that knows its thread offers exec',
    )
    const ran = await callTool(bridge, 'exec', { command: 'echo hi' })
    assert.equal(ran.isError, false, ran.content?.[0]?.text)
    assert.match(ran.content[0].text, /^exit 0\nsandboxed: echo hi/)
    const exec = (await readFile(requests, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Wire)
      .find((r) => r.method === 'command/exec')
    assert.deepEqual(exec?.params.command, ['/bin/bash', '-lc', 'echo hi'])
    assert.equal(exec?.params.cwd, home)
    assert.deepEqual(exec?.params.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [home],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    })

    // An untrusted thread asks before every command, which exec cannot do.
    const untrusted = await desktop.request('thread/start', {
      cwd: home,
      model: 'opus',
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    })
    const asking = launchBridge(home, untrusted.result.thread.id)
    bridges.push(asking)
    await initializeBridge(asking)
    const refused = await callTool(asking, 'exec', { command: 'echo hi' })
    assert.equal(refused.isError, true)
    assert.match(refused.content[0].text, /asks before every command/)
    assert.match(refused.content[0].text, /this thread runs no shell commands$/)
  } finally {
    for (const bridge of bridges) await bridge.close()
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

// Asking before every command, a thread runs one in the engine's own shell
// (which asks) under full access, and nowhere otherwise (shellMode).
test('bridge: exec says where a thread that asks before every command can run one', async () => {
  registerSandboxUpstream({ running: true, request: async () => ({}) })
  const caller = (model: string, fileSystem: Posture['fileSystem']): BridgeThreadInfo => ({
    id: 'thread',
    owner: 'local',
    cwd: process.cwd(),
    model,
    activeTurnId: null,
    posture: { ...DEFAULT_POSTURE, fileSystem, approval: 'untrusted' },
  })
  const refusal = (info: BridgeThreadInfo) =>
    runBridgeExec(info, { command: 'ls' }).then(
      () => 'ran',
      (error: Error) => error.message,
    )
  const bounded: Posture['fileSystem'] = {
    kind: 'workspace-write',
    writableRoots: [],
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
  try {
    const full: Posture['fileSystem'] = { kind: 'full-access' }
    assert.match(await refusal(caller('opus', full)), /; use Bash, which asks first$/)
    assert.match(
      await refusal(caller('grok-4.6', full)),
      /; use grok's own shell, which asks first$/,
    )
    assert.match(
      await refusal(caller('grok-4.6', bounded)),
      /; this thread runs no shell commands$/,
    )
    assert.match(await refusal(caller('opus', bounded)), /; this thread runs no shell commands$/)
  } finally {
    registerSandboxUpstream(null)
  }
})

test('bridge: exec refuses to run anything without a sandbox', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-nosandbox-'))
  const desktop = launchAdapter(home, { ANYENGINE_REAL_CODEX: '' })
  let bridge: LineClient | null = null
  try {
    await desktop.request('initialize', { clientInfo: { name: 'test', version: '0' } }, '__init__')
    const parent = await desktop.request('thread/start', { cwd: home, model: 'opus' })
    bridge = launchBridge(home, parent.result.thread.id)
    await initializeBridge(bridge)
    const refused = await callTool(bridge, 'exec', { command: 'echo hi' })
    assert.equal(refused.isError, true)
    assert.match(refused.content[0].text, /no sandbox is available/)
  } finally {
    await bridge?.close()
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

// Codex's thread/start carries no trust, so a child the bridge starts takes
// its caller's from the adapter on every route: a Claude child on its row,
// a GPT child in the posture its own children inherit. `untrusted` marks the
// project untrusted for good, so the caller keeps it after asking less.
test("bridge: children take the caller's trust on every spawn route", async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-trust-'))
  const desktop = launchAdapter(home)
  const bridges: LineClient[] = []
  const spawnFrom = async (threadId: string, tool: string, args: Wire): Promise<Wire> => {
    const bridge = launchBridge(home, threadId)
    bridges.push(bridge)
    await initializeBridge(bridge)
    const result = await callTool(bridge, tool, args)
    assert.equal(result.isError, false, result.content?.[0]?.text)
    return result.structuredContent
  }
  try {
    await initializeDesktop(desktop)
    autoApprove(desktop)
    const start = await desktop.request('thread/start', {
      cwd: home,
      model: 'opus',
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
    })
    const caller = start.result.thread.id as string
    await completedTurn(desktop, {
      threadId: caller,
      input: [{ type: 'text', text: 'a' }],
      approvalPolicy: 'on-request',
    })
    // Claude children directly; a GPT child's trust shows in its own child.
    const claude = { model: 'sonnet', prompt: 'x' }
    const gpt = { model: 'gpt-5.6-sol', prompt: 'x' }
    const session = await spawnFrom(caller, 'spawn_session', claude)
    const fanout = await spawnFrom(caller, 'spawn_subagents', { tasks: [claude, gpt] })
    const viaSession = await spawnFrom(
      (await spawnFrom(caller, 'spawn_session', gpt)).threadId,
      'spawn_session',
      claude,
    )
    const viaSubagent = await spawnFrom(fanout.results[1].threadId, 'spawn_session', claude)
    const children = [session, fanout.results[0], viaSession, viaSubagent]
    const db = new DatabaseSync(join(home, 'state.sqlite'), { readOnly: true })
    try {
      const postures = children.map((child) => {
        const row = db.prepare('SELECT posture_json FROM threads WHERE id = ?').get(child.threadId)
        return JSON.parse(String(row?.posture_json))
      })
      assert.deepEqual(
        postures.map((posture) => `${posture.trust} ${posture.approval}`),
        Array(4).fill('untrusted on-request'),
      )
    } finally {
      db.close()
    }
  } finally {
    for (const bridge of bridges) await bridge.close()
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

// The app records the project Claude config when it starts (or first
// resumes) a thread; a spawn never re-takes it, so config written during the
// session does not become the child's baseline, on any route, from a Claude
// or a GPT caller.
test('bridge: the project baseline is taken by the app once and inherited by every child', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-baseline-'))
  const desktop = launchAdapter(home)
  const bridges: LineClient[] = []
  const spawnFrom = async (threadId: string | null, tool: string, args: Wire): Promise<Wire> => {
    const bridge = launchBridge(home, threadId)
    bridges.push(bridge)
    await initializeBridge(bridge)
    const result = await callTool(bridge, tool, args)
    assert.equal(result.isError, false, result.content?.[0]?.text)
    return result.structuredContent
  }
  const db = () => new DatabaseSync(join(home, 'state.sqlite'), { readOnly: true })
  const baselineOf = (threadId: string) => {
    const conn = db()
    try {
      const row = conn.prepare('SELECT posture_json FROM threads WHERE id = ?').get(threadId)
      return JSON.parse(String(row?.posture_json)).projectBaseline
    } finally {
      conn.close()
    }
  }
  try {
    await initializeDesktop(desktop)
    autoApprove(desktop)
    const start = (model: string) => desktop.request('thread/start', { cwd: home, model })
    const caller = (await start('opus')).result.thread.id as string
    const gptThread = (await start('gpt-5.6-sol')).result.thread.id as string
    const recorded = baselineOf(caller)
    const settings = join(realpathSync(home), '.claude', 'settings.json')
    assert.equal(recorded?.[settings], 'absent', 'taken at app thread/start')

    await mkdir(join(home, '.claude'))
    await writeFile(join(home, '.claude', 'settings.json'), '{"hooks":{}}')
    const claude = { model: 'sonnet', prompt: 'x' }
    const gpt = { model: 'gpt-5.6-sol', prompt: 'x' }
    const session = await spawnFrom(caller, 'spawn_session', claude)
    const fanout = await spawnFrom(caller, 'spawn_subagents', { tasks: [claude, gpt] })
    const viaGptChild = await spawnFrom(fanout.results[1].threadId, 'spawn_session', claude)
    const viaAppGpt = await spawnFrom(gptThread, 'spawn_session', claude)
    for (const child of [session, fanout.results[0], viaGptChild, viaAppGpt]) {
      assert.deepEqual(baselineOf(child.threadId), recorded, `baseline of ${child.threadId}`)
    }

    await desktop.request('thread/resume', { threadId: caller })
    assert.deepEqual(baselineOf(caller), recorded, 'a resume keeps the baseline it has')
    // A child of no known caller has none: the app's resume takes it then.
    const orphan = await spawnFrom(null, 'spawn_session', { ...claude, cwd: home })
    assert.equal(baselineOf(orphan.threadId), undefined)
    await desktop.request('thread/resume', { threadId: orphan.threadId })
    assert.notEqual(baselineOf(orphan.threadId)?.[settings], 'absent')
  } finally {
    for (const bridge of bridges) await bridge.close()
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

// A workspace-write child writes to its own cwd, so it gets one of the
// caller's own roots: anything else, a subdirectory included, the caller could
// swap for a link to anywhere once the child runs. And the children's posture
// comes from the calling thread, never from a thread the model names.
test('bridge: a child cwd other than a caller root and a foreign parent are refused', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-'))
  const desktop = launchAdapter(home)
  const bridges: LineClient[] = []
  const connect = async (threadId: string | null): Promise<LineClient> => {
    const bridge = launchBridge(home, threadId)
    bridges.push(bridge)
    await initializeBridge(bridge)
    return bridge
  }
  try {
    await initializeDesktop(desktop)
    const work = join(home, 'work')
    const extra = join(home, 'extra')
    await mkdir(join(work, 'sub'), { recursive: true })
    await mkdir(extra)
    await symlink('/usr', join(work, 'out'))
    await symlink(work, join(home, 'alias'))
    const thread = async (params: Wire): Promise<string> =>
      (await desktop.request('thread/start', { model: 'opus', ...params })).result.thread.id
    const caller = await thread({ cwd: work, approvalPolicy: 'on-request' })
    const roots = { type: 'workspaceWrite', writableRoots: [extra] }
    await completedTurn(desktop, {
      threadId: caller,
      input: [{ type: 'text', text: 'roots' }],
      sandboxPolicy: roots,
    })
    const bridge = await connect(caller)
    const task = [{ model: 'sonnet', prompt: 'Reply with OK' }]
    const spawn = (cwd: string) =>
      callTool(bridge, 'spawn_session', { model: 'sonnet', prompt: 'x', cwd })

    const refused = ['/', '/usr', 'out', 'sub', join(work, 'sub'), join(extra, 'x'), '..']
    for (const cwd of refused) {
      const session = await spawn(cwd)
      assert.equal(session.isError, true, cwd)
      assert.match(session.content[0].text, /is not the calling thread's cwd or one of its roots/)
      const fanout = await callTool(bridge, 'spawn_subagents', { tasks: task, cwd })
      assert.equal(fanout.isError, true, cwd)
    }
    const inRoot = await spawn(extra)
    assert.equal(inRoot.isError, false, inRoot.content?.[0]?.text)
    assert.equal(inRoot.structuredContent.cwd, extra)

    // A link to the caller's cwd is matched by real path, and the child gets
    // the caller's own path: swapping the link later moves nothing.
    const viaLink = await spawn(join(home, 'alias'))
    assert.equal(viaLink.isError, false, viaLink.content?.[0]?.text)
    assert.equal(viaLink.structuredContent.cwd, work)
    await rm(join(home, 'alias'))
    await symlink('/', join(home, 'alias'))
    const swapped = await desktop.request('thread/resume', {
      threadId: viaLink.structuredContent.threadId,
    })
    assert.equal(swapped.result.cwd, work)

    // A read-only caller's children cannot write anywhere, so any cwd is fine.
    const reader = await thread({ cwd: work, approvalPolicy: 'on-request', sandbox: 'read-only' })
    const readOnly = await connect(reader)
    const anywhere = await callTool(readOnly, 'spawn_session', {
      model: 'sonnet',
      prompt: 'x',
      cwd: '/',
    })
    assert.equal(anywhere.isError, false, anywhere.content?.[0]?.text)

    // A named parent must be the caller...
    const open = await thread({ cwd: work, approvalPolicy: 'never', sandbox: 'danger-full-access' })
    const foreign = await callTool(bridge, 'spawn_subagents', { tasks: task, parentThreadId: open })
    assert.equal(foreign.isError, true)
    assert.match(foreign.content[0].text, /is not the calling thread/)
    // ...and with no caller known it only links the children: they get the
    // default posture, not the named thread's full access.
    const unknown = await connect(null)
    const linked = await callTool(unknown, 'spawn_subagents', { tasks: task, parentThreadId: open })
    assert.equal(linked.isError, false, linked.content?.[0]?.text)
    const childId = linked.structuredContent.results[0].threadId
    const child = await desktop.request('thread/resume', { threadId: childId })
    assert.equal(child.result.approvalPolicy, 'on-request')
    assert.equal(child.result.sandbox.type, 'readOnly')
  } finally {
    for (const bridge of bridges) await bridge.close()
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('bridge: informal model names resolve to catalog ids', () => {
  const cases: Array<[string, string]> = [
    ['opus', 'opus'],
    ['Claude Opus', 'opus'],
    ['claude opus', 'opus'],
    ['CLAUDE OPUS 5', 'opus'],
    ['opus 5', 'opus'],
    ['claude-opus-4', 'opus'],
    ['claude', 'fable'],
    ['claude fable 5.1', 'fable'],
    ['claude sonnet', 'sonnet'],
    ['sonnet 1m', 'sonnet-1m'],
    ['the claude haiku model', 'haiku'],
    ['grok', 'grok-4.6'],
    ['Grok 4.6', 'grok-4.6'],
    ['grok 4.5', 'grok-4.5'],
    ['grok-4.5', 'grok-4.5'],
    ['gpt', 'gpt-5.6-sol'],
    ['GPT 5.6', 'gpt-5.6-sol'],
    ['gpt 5.6 terra', 'gpt-5.6-terra'],
    ['gpt-5.4-mini', 'gpt-5.4-mini'],
    ['codex', 'gpt-5.6-sol'],
    ['openai', 'gpt-5.6-sol'],
  ]
  for (const [requested, expected] of cases) {
    assert.equal(resolveModelAlias(requested, ALIAS_CATALOG), expected, `"${requested}"`)
  }
  assert.throws(
    () => resolveModelAlias('llama-9', ALIAS_CATALOG),
    /unknown model "llama-9"; available: fable \(Claude Fable 5\.1\), opus \(Claude Opus\)/,
  )
  assert.throws(() => resolveModelAlias('   ', ALIAS_CATALOG), /model is required/)
  // Engine named but not attached (native child down): refused with the catalog.
  const noGpt = ALIAS_CATALOG.filter((m) => m.provider !== 'openai')
  assert.throws(() => resolveModelAlias('gpt', noGpt), /unknown model "gpt"; available: fable/)
})

test('bridge: standing instructions stay one line and respect the environment toggle', () => {
  assert.equal(bridgeInstructions(ALIAS_CATALOG), BRIDGE_LINE)
  assert.equal(bridgeInstructions([]), BRIDGE_LINE)
  const appended = appendBridgeInstructions('Avoid SELECT *.', ALIAS_CATALOG)
  assert.equal(appended, `Avoid SELECT *.\n\n${BRIDGE_LINE}`)
  assert.equal(appendBridgeInstructions(appended, ALIAS_CATALOG), appended, 'idempotent')
  assert.equal(appendBridgeInstructions(null, ALIAS_CATALOG), BRIDGE_LINE)
  assert.equal(bridgeInstructionsEnabled({}), true)
  assert.equal(bridgeInstructionsEnabled({ ANYENGINE_BRIDGE_INSTRUCTIONS: '0' }), false)
  assert.equal(bridgeInstructionsEnabled({ ANYENGINE_BRIDGE_INSTRUCTIONS: '1' }), true)
})

// The same addendum reaches every engine: Claude through the per-turn
// systemPromptAddendum (the mock runtime echoes it), GPT through
// developerInstructions on the thread/start the mux forwards to the child
// (the fake child echoes what it received).
test('bridge: instructions reach Claude (system prompt) and GPT (developerInstructions)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-'))
  const desktop = launchAdapter(home)
  try {
    await initializeDesktop(desktop)
    // The merged model/list primes the child's catalog for the addendum.
    const models = await desktop.request('model/list', {})
    assert.ok(models.result.data.some((m: Wire) => m.id === 'gpt-5.6-sol'))

    const claude = await desktop.request('thread/start', {
      cwd: home,
      model: 'opus',
      developerInstructions: 'Avoid SELECT *.',
    })
    const claudeId = claude.result.thread.id as string
    await desktop.request('turn/start', {
      threadId: claudeId,
      input: [{ type: 'text', text: 'system prompt check', text_elements: [] }],
    })
    await desktop.waitFor((m) => m.method === 'turn/completed' && m.params?.threadId === claudeId)
    const echoed = desktop.messages
      .filter((m) => m.method === 'item/agentMessage/delta' && m.params?.threadId === claudeId)
      .map((m) => m.params.delta)
      .join('')
    const addendum = JSON.parse(echoed.replace(/^systemPromptAddendum=/, ''))
    assert.equal(typeof addendum, 'string')
    assert.ok(addendum.startsWith('# Developer instructions\nAvoid SELECT *.'), addendum)
    assert.equal(addendum.split(BRIDGE_LINE).length - 1, 1)

    const gpt = await desktop.request('thread/start', {
      cwd: home,
      model: 'gpt-5.6-sol',
      developerInstructions: 'Be terse.',
    })
    assert.equal(gpt.result.thread.id, 'fake-thread-1')
    const received = gpt.result.receivedDeveloperInstructions as string
    assert.equal(received, `Be terse.\n\n${BRIDGE_LINE_GPT}`)
    assert.equal(gpt.result.receivedBaseInstructions, null, 'baseInstructions untouched')

    // The desktop resending the panel state does not stack a second copy.
    const resumed = await desktop.request('thread/resume', {
      threadId: 'fake-thread-1',
      developerInstructions: received,
    })
    const again = resumed.result.receivedDeveloperInstructions as string
    assert.equal(again.split(BRIDGE_LINE_GPT).length - 1, 1)

    // A GPT thread started without instructions still gets the addendum.
    const bare = await desktop.request('thread/start', { cwd: home, model: 'gpt-5.6-sol' })
    assert.equal(bare.result.receivedDeveloperInstructions, BRIDGE_LINE_GPT)
  } finally {
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('bridge model prompts cannot enter Claude slash-command dispatch on spawn, fanout or send', async () => {
  const home = await tempDir('bridge-slash-')
  const desktop = launchAdapter(home)
  let bridge: LineClient | null = null
  try {
    await initializeDesktop(desktop)
    const parent = await desktop.request('thread/start', { cwd: home, model: 'gpt-5.6-sol' })
    bridge = launchBridge(home, parent.result.thread.id)
    await initializeBridge(bridge)
    const prompt = ' \t\n/config permissionMode=acceptEdits'
    const spawned = await callTool(bridge, 'spawn_session', { model: 'opus', prompt })
    assert.equal(spawned.isError, false)
    const id = spawned.structuredContent.threadId
    const sent = await callTool(bridge, 'send_to_session', {
      threadId: id,
      prompt: '\uFEFF/heapdump',
    })
    assert.equal(sent.isError, false)
    const fanout = await callTool(bridge, 'spawn_subagents', { tasks: [{ model: 'opus', prompt }] })
    assert.equal(fanout.isError, false)
    for (const threadId of [id, fanout.structuredContent.results[0].threadId]) {
      const read = await desktop.request('thread/read', { threadId, includeTurns: true })
      const messages = read.result.thread.turns
        .flatMap((turn: Wire) => turn.items)
        .filter((item: Wire) => item.type === 'userMessage')
      assert.ok(messages.length)
      for (const item of messages) {
        const text = item.content.map((part: Wire) => part.text ?? '').join('')
        assert.ok(!/^\s*\//u.test(text), text)
        assert.match(text, /\/(config|heapdump)/)
      }
    }
  } finally {
    await bridge?.close()
    await desktop.close()
  }
})

test('bridge re-applies later read restrictions on send and refuses children that cannot enforce them', async () => {
  const home = await tempDir('bridge-reads-')
  const desktop = launchAdapter(home)
  let bridge: LineClient | null = null
  try {
    await initializeDesktop(desktop)
    autoApprove(desktop)
    const parent = await desktop.request('thread/start', { cwd: home, model: 'opus' })
    const parentId = parent.result.thread.id
    bridge = launchBridge(home, parentId)
    await initializeBridge(bridge)
    const oldChild = await callTool(bridge, 'spawn_session', { model: 'opus', prompt: 'hello' })
    const oldGpt = await callTool(bridge, 'spawn_session', {
      model: 'gpt-5.6-sol',
      prompt: 'hello',
    })
    assert.equal(oldChild.isError, false)
    assert.equal(oldGpt.isError, false)
    const changed = await desktop.request('thread/settings/update', {
      threadId: parentId,
      permissions: 'private-paths',
    })
    assert.ok(changed.result, JSON.stringify(changed))
    const sent = await callTool(bridge, 'send_to_session', {
      threadId: oldChild.structuredContent.threadId,
      prompt: 'hello again',
    })
    assert.equal(sent.isError, false)
    const fresh = await callTool(bridge, 'spawn_session', { model: 'opus', prompt: 'hello' })
    assert.equal(fresh.isError, false)
    const db = new DatabaseSync(join(home, 'state.sqlite'), { readOnly: true })
    try {
      for (const id of [oldChild.structuredContent.threadId, fresh.structuredContent.threadId]) {
        const row = db.prepare('SELECT posture_json FROM threads WHERE id = ?').get(id)
        assert.equal(JSON.parse(String(row?.posture_json)).readRestricted, true, id)
      }
    } finally {
      db.close()
    }
    const gptSend = await callTool(bridge, 'send_to_session', {
      threadId: oldGpt.structuredContent.threadId,
      prompt: 'hello',
    })
    assert.equal(gptSend.isError, true, 'old GPT child cannot enforce no reads')
    const gpt = await callTool(bridge, 'spawn_session', { model: 'gpt-5.6-sol', prompt: 'hello' })
    assert.equal(gpt.isError, true, 'new GPT child cannot enforce no reads')
    const fanout = await callTool(bridge, 'spawn_subagents', {
      tasks: [{ model: 'gpt-5.6-sol', prompt: 'hello' }],
    })
    assert.equal(fanout.structuredContent.results[0].status, 'failed')
    assert.match(fanout.structuredContent.results[0].error, /read/i)
  } finally {
    await bridge?.close()
    await desktop.close()
  }
})

test('bridge refuses an unknown caller with ambiguous active local/upstream read restrictions', async () => {
  for (const restrictedOwner of ['local', 'upstream']) {
    const home = await tempDir('bridge-ambiguous-')
    const desktop = launchAdapter(home)
    let bridge: LineClient | null = null
    try {
      await initializeDesktop(desktop)
      const ids: string[] = []
      for (const model of ['opus', 'gpt-5.6-sol']) {
        const start = await desktop.request('thread/start', {
          cwd: home,
          model,
          approvalPolicy: 'untrusted',
          sandbox: 'workspace-write',
        })
        const threadId = start.result.thread.id
        ids.push(threadId)
        await desktop.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: model === 'opus' ? 'ask user question check' : 'hello' }],
        })
        await desktop.waitFor(
          (m) =>
            m.method ===
              (model === 'opus'
                ? 'item/tool/requestUserInput'
                : 'item/commandExecution/requestApproval') && m.params.threadId === threadId,
        )
      }
      const restrictedId = ids[restrictedOwner === 'local' ? 0 : 1]
      await desktop.request('thread/resume', {
        threadId: restrictedId,
        permissions: 'private-paths',
      })
      bridge = launchBridge(home, null)
      await initializeBridge(bridge)
      for (const [tool, args] of [
        ['spawn_session', { model: 'opus', prompt: 'hello', wait: false }],
        [
          'spawn_subagents',
          { tasks: [{ model: 'opus', prompt: 'hello' }], parentThreadId: ids[0] },
        ],
      ] as const) {
        const result = await callTool(bridge, tool, args)
        assert.equal(result.isError, true, `${restrictedOwner}: ${tool}`)
        assert.match(result.content[0].text, /calling thread unknown.*restricts reads/i)
      }
    } finally {
      await bridge?.close()
      await desktop.close()
    }
  }
})
