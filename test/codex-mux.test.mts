import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import readline from 'node:readline'
import test from 'node:test'
import { SessionStore } from '../src/store.mjs'

// The native-codex multiplexer against a FAKE `codex app-server` child
// (test/fixtures/fake-codex-app-server.mjs). Everything here runs without
// Claude or ChatGPT credentials: Claude threads use the mock runtime, gpt-*
// threads reach the fake child over stdio.

const adapter = resolve('dist/src/adapter.mjs')
const shim = resolve('scripts/codex-shim')
const fakeCodex = resolve('test/fixtures/fake-codex-app-server.mjs')

const DESKTOP_ARGV = [
  '-c',
  'features.code_mode_host=true',
  'app-server',
  '--analytics-default-enabled',
  '-c',
  'mcp_servers.codex_app={command="/tmp/launch",enabled=true}',
]

type Wire = Record<string, any>

// The adapter inserts its own `-c mcp_servers.jinn_bridge=...` override (the
// cross-engine bridge, test/bridge.test.mts) after the desktop's globals;
// everything else must be replayed verbatim.
function assertDesktopArgvReplayed(argv: string[]): void {
  const index = argv.findIndex((arg) => arg.startsWith('mcp_servers.jinn_bridge='))
  assert.ok(index > 0 && argv[index - 1] === '-c', 'bridge override is a -c global')
  assert.ok(index < argv.indexOf('app-server'), 'bridge override precedes app-server')
  assert.match(
    argv[index] ?? '',
    /env_vars=\["CLAUDE_CODEX_BRIDGE_SOCKET","CLAUDE_CODEX_BRIDGE_TOKEN"\]/,
  )
  assert.deepEqual([...argv.slice(0, index - 1), ...argv.slice(index + 1)], DESKTOP_ARGV)
}

class StdioClient {
  readonly child: ChildProcess
  readonly messages: Wire[] = []
  private waiters: Array<{ predicate: (m: Wire) => boolean; resolve: (m: Wire) => void }> = []
  // Starts above the explicit ids the tests use (1, 7, 42) so waitFor never
  // matches an earlier response by accident.
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

  waitFor(predicate: (m: Wire) => boolean, timeoutMs = 10_000): Promise<Wire> {
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

function launch(home: string, extraEnv: NodeJS.ProcessEnv = {}, viaShim = false): StdioClient {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODEX_MOCK: '1',
    CLAUDE_CODEX_HOME: home,
    CLAUDE_CODEX_DEBUG_LOG: join(home, 'debug.jsonl'),
    CLAUDE_CODEX_REAL_CODEX: fakeCodex,
    CLAUDE_CODEX_MODELS: 'opus,sonnet',
    CLAUDE_CODEX_DEFAULT_MODEL: 'opus',
    CLAUDE_CODEX_RUNTIME_TYPE: 'mock',
    CODEX_APP_TOOLS_PIPE_PATH: '/tmp/codex-browser-use/test.sock',
    FAKE_CODEX_ARGV_FILE: join(home, 'fake-argv.json'),
    ...extraEnv,
  }
  delete env.CLAUDE_CODEX_GPT_ROUTE
  delete env.CLAUDE_CODEX_RUNTIME_ENV
  const child = viaShim
    ? spawn(shim, DESKTOP_ARGV, {
        env: {
          ...env,
          CLAUDE_CODEX_ADAPTER: adapter,
          CLAUDE_CODEX_NODE: process.execPath,
          CLAUDE_CODEX_RUNTIME_ENV: join(home, 'missing.env'),
        },
        stdio: ['pipe', 'pipe', 'inherit'],
      })
    : spawn(process.execPath, [adapter, ...DESKTOP_ARGV], {
        env,
        stdio: ['pipe', 'pipe', 'inherit'],
      })
  return new StdioClient(child)
}

test('native-codex mux: argv replay, id rewriting both ways, approval round-trip, default route', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-mux-'))
  const client = launch(home)
  try {
    const init = await client.request(
      'initialize',
      { clientInfo: { name: 'codex_desktop', title: 'Codex Desktop', version: '26.901' } },
      '__codex_initialize__',
    )
    // The child's initialize answer wins (real userAgent), local fields kept.
    assert.equal(init.result.userAgent, 'codex_app_server/0.153.4 (fake)')
    assert.equal(init.result.platformFamily, 'unix')
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })

    // The child was spawned with the desktop's argv, globals first, verbatim.
    const recorded = JSON.parse(await readFile(join(home, 'fake-argv.json'), 'utf8'))
    assertDesktopArgvReplayed(recorded.argv)
    assert.equal(recorded.env.CODEX_APP_TOOLS_PIPE_PATH, '/tmp/codex-browser-use/test.sock')

    // Default route: a method the adapter has no idea about reaches the child
    // and comes back under the desktop's own id.
    const auth = await client.request('getAuthStatus', { includeToken: false }, 42)
    assert.equal(auth.id, 42)
    assert.equal(auth.result.fake, true)
    assert.equal(auth.result.method, 'getAuthStatus')

    // gpt-* thread/start is owned by the child; thread/started is forwarded.
    const start = await client.request('thread/start', { cwd: home, model: 'gpt-5.6-sol' }, 7)
    assert.equal(start.result.thread.id, 'fake-thread-1')
    assert.equal(start.result.modelProvider, 'openai')
    const started = await client.waitFor(
      (m) => m.method === 'thread/started' && m.params?.thread?.id === 'fake-thread-1',
    )
    assert.equal(started.params.thread.modelProvider, 'openai')

    // turn/start with desktop id 1 while the child's server request also uses
    // id 1: both directions must be rewritten for this to resolve cleanly.
    const turnResponse = client.request(
      'turn/start',
      { threadId: 'fake-thread-1', input: [{ type: 'text', text: 'Reply with PONG' }] },
      1,
    )
    const approval = await client.waitFor(
      (m) => m.method === 'item/commandExecution/requestApproval' && m.id != null,
    )
    assert.equal(approval.params.threadId, 'fake-thread-1')
    assert.notEqual(approval.id, 1, 'server request id must not collide with the desktop id')
    assert.match(String(approval.id), /^s\d+$/)
    const turn = await turnResponse
    assert.equal(turn.result.turn.id, 'fake-turn-1')

    client.send({ jsonrpc: '2.0', id: approval.id, result: { decision: 'accept' } })
    const resolved = await client.waitFor((m) => m.method === 'serverRequest/resolved')
    assert.equal(resolved.params.requestId, approval.id, 'resolved id is the rewritten one')
    const completedItem = await client.waitFor(
      (m) => m.method === 'item/completed' && m.params?.item?.id === 'fake-turn-1-cmd',
    )
    assert.equal(completedItem.params.item.status, 'completed')
    assert.deepEqual(completedItem.params.item.approvalDecision, { decision: 'accept' })
    const delta = await client.waitFor((m) => m.method === 'item/agentMessage/delta')
    assert.equal(delta.params.delta, 'PONG')
    await client.waitFor(
      (m) => m.method === 'turn/completed' && m.params?.turn?.id === 'fake-turn-1',
    )

    // Thread-scoped request on a child-owned thread goes upstream even though
    // the adapter implements the method itself.
    const read = await client.request('thread/read', { threadId: 'fake-thread-1' })
    assert.equal(read.result.fake, true)

    // Client notification scoped to a child thread is forwarded, not dropped.
    client.send({ jsonrpc: '2.0', method: 'thread/unsubscribe', params: { threadId: 'x' } })
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('native-codex mux: merged lists, Claude threads stay local, ownership survives restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-mux-'))
  let client = launch(home)
  let claudeThreadId = ''
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })

    const gpt = await client.request('thread/start', { cwd: home, model: 'gpt-5.6-sol' })
    assert.equal(gpt.result.thread.id, 'fake-thread-1')
    const claude = await client.request('thread/start', { cwd: home, model: 'opus' })
    claudeThreadId = claude.result.thread.id
    assert.equal(claude.result.modelProvider, 'claude-code')
    assert.notEqual(claudeThreadId, 'fake-thread-1')

    // model/list: child catalog first, Claude appended with isDefault=false.
    const models = await client.request('model/list', { includeHidden: true })
    const ids = models.result.data.map((m: Wire) => m.id)
    assert.deepEqual(ids, ['gpt-5.6-sol', 'opus', 'sonnet'])
    assert.equal(models.result.data[0].isDefault, true)
    assert.equal(models.result.data[1].isDefault, false)

    // config/read: child config verbatim plus the claude-code provider.
    const config = await client.request('config/read', {})
    assert.equal(config.result.config.model, 'gpt-5.6-sol')
    assert.ok(config.result.config.model_providers.openai)
    assert.equal(config.result.config.model_providers['claude-code'].name, 'Claude Code')

    // thread/list page 1 = child page 1 + Claude threads, updated_at desc,
    // cursor semantics the child's; page 2 is child-only.
    const page1 = await client.request('thread/list', {
      limit: 50,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    })
    const page1Ids = page1.result.data.map((t: Wire) => t.id)
    assert.deepEqual(page1Ids, ['fake-newest', claudeThreadId, 'fake-older'])
    assert.equal(page1.result.nextCursor, 'fake-page-2')
    const page2 = await client.request('thread/list', { limit: 50, cursor: 'fake-page-2' })
    assert.deepEqual(
      page2.result.data.map((t: Wire) => t.id),
      ['fake-old'],
    )
    assert.equal(page2.result.nextCursor, null)

    // Provider filter that excludes claude-code skips the local half.
    const openaiOnly = await client.request('thread/list', { modelProviders: ['openai'] })
    assert.deepEqual(
      openaiOnly.result.data.map((t: Wire) => t.id),
      ['fake-newest', 'fake-older'],
    )

    const loaded = await client.request('thread/loaded/list', {})
    assert.ok(loaded.result.data.includes('fake-loaded'))
    assert.ok(loaded.result.data.includes(claudeThreadId))

    // Claude thread is served locally (mock runtime), never by the child.
    const readLocal = await client.request('thread/read', { threadId: claudeThreadId })
    assert.equal(readLocal.result.thread.id, claudeThreadId)
    assert.equal(readLocal.result.fake, undefined)
  } finally {
    await client.close()
  }

  // Ownership is persisted: a fresh adapter (fresh fake child, which knows
  // nothing) still routes the gpt thread upstream and the Claude thread locally.
  const store = new SessionStore(join(home, 'state.sqlite'))
  assert.equal(store.isNativeCodexThread('fake-thread-1'), true)
  assert.equal(store.isNativeCodexThread('fake-newest'), true, 'learned from thread/list')
  assert.equal(store.isNativeCodexThread(claudeThreadId), false)
  store.close()

  client = launch(home)
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    const resumed = await client.request('thread/resume', { threadId: 'fake-thread-1' })
    assert.equal(resumed.result.thread.preview, 'resumed by fake')
    const readLocal = await client.request('thread/read', { threadId: claudeThreadId })
    assert.equal(readLocal.result.thread.id, claudeThreadId)
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('codex-shim passes the desktop -c globals through to the adapter and child', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-mux-shim-'))
  const client = launch(home, {}, true)
  try {
    const init = await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    assert.equal(init.result.userAgent, 'codex_app_server/0.153.4 (fake)')
    const recorded = JSON.parse(await readFile(join(home, 'fake-argv.json'), 'utf8'))
    assertDesktopArgvReplayed(recorded.argv)
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})
