import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import readline from 'node:readline'
import test, { after } from 'node:test'
import { readBrokerSources } from '../src/broker-source.mjs'
import { SessionStore } from '../src/store.mjs'
import { killChildren, spawn } from './helpers/children.mjs'

after(() => killChildren())

// The native-codex multiplexer against a FAKE `codex app-server` child
// (test/fixtures/fake-codex-app-server.mjs). Everything here runs without
// Claude or ChatGPT credentials: Claude threads use the mock runtime, gpt-*
// threads reach the fake child over stdio.

const adapter = resolve('dist/src/adapter.mjs')
const shim = resolve('scripts/codex-shim')
const fakeCodex = resolve('test/fixtures/fake-codex-app-server.mjs')

// ChatGPT.app 26.911 passes its own subcommand-level `-c` after `app-server`;
// 26.901 did not.
const DESKTOP_ARGV = [
  '-c',
  'features.code_mode_host=true',
  'app-server',
  '--analytics-default-enabled',
  '-c',
  'mcp_servers.codex_app={command="/tmp/launch",enabled=true}',
]
const LEGACY_DESKTOP_ARGV = [
  '-c',
  'features.code_mode_host=true',
  'app-server',
  '--analytics-default-enabled',
]

type Wire = Record<string, any>

// The adapter adds its own `-c mcp_servers.anyengine=...` (the cross-engine
// bridge, test/bridge.test.mts). codex ignores every root-level `-c` once the
// subcommand has one, so the override follows the app's subcommand `-c` flags
// when there are any and precedes `app-server` otherwise. Everything else is
// replayed verbatim.
function assertDesktopArgvReplayed(argv: string[], desktop: string[] = DESKTOP_ARGV): void {
  const index = argv.findIndex((arg) => arg.startsWith('mcp_servers.anyengine='))
  assert.ok(index > 0 && argv[index - 1] === '-c', 'bridge override is a -c flag')
  const subcommand = argv.indexOf('app-server')
  if (desktop.slice(desktop.indexOf('app-server')).includes('-c')) {
    assert.ok(index > subcommand, 'bridge override follows the app subcommand -c')
  } else {
    assert.ok(index < subcommand, 'bridge override precedes app-server')
  }
  assert.match(argv[index] ?? '', /env_vars=\["ANYENGINE_BRIDGE_SOCKET","ANYENGINE_BRIDGE_TOKEN"\]/)
  assert.deepEqual([...argv.slice(0, index - 1), ...argv.slice(index + 1)], desktop)
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

  // 10 s was enough on an idle laptop and not on a loaded CI runner: a
  // mid-thread handover spawns a fake child, resumes or starts its thread and
  // injects a transcript before the message being waited for appears, and
  // `node (ubuntu-latest)` failed here four times in one afternoon, green on
  // every rerun, twice on a tree byte-identical to one that had just passed
  // (docs/hardening-log.md). This wait exists to stop a hung test hanging the
  // file, and `--test-timeout=180000` already bounds that, so it only has to
  // be short enough to fail before the backstop — not short enough to race a
  // busy runner.
  waitFor(predicate: (m: Wire) => boolean, timeoutMs = 60_000): Promise<Wire> {
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

function launch(
  home: string,
  extraEnv: NodeJS.ProcessEnv = {},
  viaShim = false,
  argv: string[] = DESKTOP_ARGV,
): StdioClient {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANYENGINE_MOCK: '1',
    ANYENGINE_HOME: home,
    ANYENGINE_DEBUG_LOG: join(home, 'debug.jsonl'),
    ANYENGINE_REAL_CODEX: fakeCodex,
    ANYENGINE_MODELS: 'opus,sonnet',
    ANYENGINE_DEFAULT_MODEL: 'opus',
    ANYENGINE_RUNTIME_TYPE: 'mock',
    CODEX_APP_TOOLS_PIPE_PATH: '/tmp/codex-browser-use/test.sock',
    FAKE_CODEX_ARGV_FILE: join(home, 'fake-argv.json'),
    ...extraEnv,
  }
  delete env.ANYENGINE_GPT_ROUTE
  delete env.ANYENGINE_RUNTIME_ENV
  // These tests ARE the native-codex passthrough, against a fake child, so the
  // suite-wide kill switch in `npm test` (and its legacy spelling) must not
  // reach the adapter here.
  delete env.ANYENGINE_NATIVE_CODEX
  delete env.CLAUDE_CODEX_NATIVE_CODEX
  const child = viaShim
    ? spawn(shim, argv, {
        env: {
          ...env,
          ANYENGINE_ADAPTER: adapter,
          ANYENGINE_NODE: process.execPath,
          ANYENGINE_RUNTIME_ENV: join(home, 'missing.env'),
        },
        stdio: ['pipe', 'pipe', 'inherit'],
      })
    : spawn(process.execPath, [adapter, ...argv], {
        env,
        stdio: ['pipe', 'pipe', 'inherit'],
      })
  return new StdioClient(child)
}

// 2026-09-30: ChatGPT.app 26.928 moved its codex. runtime.env still named the
// 26.911 path, the adapter spawned it (ENOENT) and served the app with no GPT
// engine at all. The stale name is now skipped for the app's own codex, and
// said out loud.
test('native-codex mux: a named codex that moved is skipped for the app layout, loudly', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-mux-moved-'))
  const app = join(home, 'ChatGPT.app')
  const layout = join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  await mkdir(dirname(layout), { recursive: true })
  await writeFile(layout, `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`)
  await chmod(layout, 0o755)
  const moved = join(app, 'Contents/Resources/codex')
  const root = await mkdtemp(join(process.env.HOME ?? home, 'mux-'))
  // Not a mock run: a mock run never looks for the app.
  const client = launch(home, {
    ANYENGINE_MOCK: '',
    ANYENGINE_ROOT: root,
    CODEX_HOME: home,
    ANYENGINE_REAL_CODEX: moved,
    ANYENGINE_CHATGPT_APP: app,
  })
  try {
    const init = await client.request(
      'initialize',
      { clientInfo: { name: 'codex_desktop', title: 'Codex Desktop', version: '26.928' } },
      '__codex_initialize__',
    )
    assert.equal(init.result.userAgent, 'codex_app_server/0.153.4 (fake)', 'the GPT child is up')
    const auth = await client.request('getAuthStatus', { includeToken: false }, 42)
    assert.equal(auth.result.fake, true)
    const account = { home, generation: 1 }
    const deadline = Date.now() + 5000
    while (!readBrokerSources(root, account).length && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 20))
    const [source] = readBrokerSources(root, account)
    assert.ok(source, 'desktop initialize without a notification registers the ready child')
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    await client.request('getAuthStatus', { includeToken: false })
    assert.equal(readBrokerSources(root, account)[0]?.id, source.id)
    const events = (await readFile(join(home, 'debug.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const stale = events.find((event) => event.event === 'codex.upstream.staleRealCodex')
    assert.deepEqual([stale?.configured, stale?.using], [moved, layout])
    const spawned = events.find((event) => event.event === 'codex.upstream.spawn')
    assert.equal(spawned?.binary, layout)
    assert.ok(!events.some((event) => event.event === 'codex.upstream.unavailable'))
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

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
    // An empty filter means every provider (app-server schema), not none:
    // this is the app's own first `thread/list` call.
    const everyProvider = await client.request('thread/list', { limit: 50, modelProviders: [] })
    assert.deepEqual(
      everyProvider.result.data.map((t: Wire) => t.id),
      ['fake-newest', claudeThreadId, 'fake-older'],
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

test('native-codex mux: with the 26.901 argv the bridge override still precedes app-server', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-mux-legacy-'))
  const client = launch(home, {}, false, LEGACY_DESKTOP_ARGV)
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    const recorded = JSON.parse(await readFile(join(home, 'fake-argv.json'), 'utf8'))
    assertDesktopArgvReplayed(recorded.argv, LEGACY_DESKTOP_ARGV)
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

// Auto-reserve through the real forwarding path (src/reserve.mts). The fake
// child reports a ChatGPT account and, with FAKE_CODEX_RATE_LIMIT=reached, an
// account that is out of Codex usage — the state the desktop turns into
// "reserve mode".
async function accountRead(client: StdioClient, timeoutMs = 60_000): Promise<Wire> {
  const deadline = Date.now() + timeoutMs
  let last = await client.request('account/read', {})
  while (last.result?.account?.type === 'chatgpt' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    last = await client.request('account/read', {})
  }
  return last
}

test('auto-reserve: while the limit is reached the account report loses its ChatGPT shape', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-reserve-'))
  const client = launch(home, { FAKE_CODEX_RATE_LIMIT: 'reached' })
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })

    // The adapter re-read the child's limits before the handshake returned
    // (the desktop never asks for them), so the desktop's FIRST account read
    // already carries the externally-authenticated shape.
    const account = await client.request('account/read', {})
    assert.deepEqual(account.result, {
      account: { type: 'amazonBedrock' },
      requiresOpenaiAuth: false,
    })

    // ...and so does the auth status the desktop calls its own backend with.
    const auth = await client.request('getAuthStatus', { includeToken: true })
    assert.deepEqual(auth.result, {
      authMethod: null,
      authToken: null,
      requiresOpenaiAuth: false,
    })

    // The reserve markers are gone from the forwarded read; the real usage
    // numbers are not.
    const limits = await client.request('account/rateLimits/read', {})
    assert.equal(limits.result.rateLimits.rateLimitReachedType, null)
    assert.equal(limits.result.rateLimitsByLimitId.codex.rateLimitReachedType, null)
    assert.equal(limits.result.rateLimitUpsell, null)
    assert.equal(limits.result.rateLimits.primary.usedPercent, 100)

    // The child is still there: gpt-* threads keep going to it.
    const start = await client.request('thread/start', { cwd: home, model: 'gpt-5.6-sol' })
    assert.equal(start.result.thread.id, 'fake-thread-1')
    assert.equal(start.result.modelProvider, 'openai')

    const transitions = (await readFile(join(home, 'debug.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line.includes('"reserve.'))
      .map((line) => JSON.parse(line).event)
    assert.deepEqual(transitions, ['reserve.entered'], 'one line, once')
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('auto-reserve: ANYENGINE_AUTO_RESERVE=0 forwards the child verbatim', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-reserve-off-'))
  const client = launch(home, { FAKE_CODEX_RATE_LIMIT: 'reached', ANYENGINE_AUTO_RESERVE: '0' })
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    const account = await accountRead(client, 1_000)
    assert.equal(account.result.account.type, 'chatgpt')
    assert.equal(account.result.requiresOpenaiAuth, true)
    const auth = await client.request('getAuthStatus', { includeToken: true })
    assert.equal(auth.result.fake, true, 'the child answers the auth status itself')
    const limits = await client.request('account/rateLimits/read', {})
    assert.equal(limits.result.rateLimits.rateLimitReachedType, 'rate_limit_reached')
    assert.equal(limits.result.rateLimitUpsell.banner_type, 'luna_reserve')
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('auto-reserve: a child that is not over its limit is forwarded verbatim', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-reserve-clear-'))
  const client = launch(home)
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    const account = await accountRead(client, 1_000)
    assert.equal(account.result.account.type, 'chatgpt')
    const limits = await client.request('account/rateLimits/read', {})
    assert.equal(limits.result.rateLimits.rateLimitReachedType, null)
    assert.equal(limits.result.rateLimits.primary.usedPercent, 12)
    const log = await readFile(join(home, 'debug.jsonl'), 'utf8')
    assert.ok(!log.includes('"reserve.entered"'), 'no transition without a reached limit')
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Mid-thread engine switching (src/rehome.mts). The desktop keeps ONE thread
// while its model picker moves between engines; routing follows the model on
// each turn. Claude/Grok run on the mock runtime here, gpt-* on the fake child.
// ---------------------------------------------------------------------------

// Grok models are hidden in mock mode unless they are named explicitly, and
// `thread/settings/update` only accepts a model the picker offers.
const SWITCH_ENV = { FAKE_CODEX_NO_APPROVAL: '1', ANYENGINE_GROK_MODELS: 'grok-4.6,grok-4.5' }

function text(value: string): Wire {
  return { type: 'text', text: value }
}

// The mock runtime echoes the prompt it was handed, so the completed agent
// message is where a carried transcript becomes observable.
async function localAnswer(client: StdioClient, threadId: string, turnId: string): Promise<string> {
  const completed = await client.waitFor(
    (m) =>
      m.method === 'item/completed' &&
      m.params?.threadId === threadId &&
      m.params?.turnId === turnId &&
      m.params?.item?.type === 'agentMessage',
  )
  return String(completed.params.item.text ?? '')
}

async function runLocalTurn(
  client: StdioClient,
  threadId: string,
  model: string,
  prompt: string,
): Promise<string> {
  const started = await client.request('turn/start', {
    threadId,
    model,
    input: [text(prompt)],
  })
  assert.ok(started.result?.turn?.id, `turn/start rejected: ${JSON.stringify(started.error)}`)
  const answer = await localAnswer(client, threadId, started.result.turn.id)
  await client.waitFor(
    (m) => m.method === 'turn/completed' && m.params?.turn?.id === started.result.turn.id,
  )
  return answer
}

async function runUpstreamTurn(
  client: StdioClient,
  threadId: string,
  model: string,
  prompt: string,
): Promise<Wire> {
  const started = await client.request('turn/start', {
    threadId,
    model,
    input: [text(prompt)],
  })
  assert.ok(started.result?.turn?.id, `turn/start rejected: ${JSON.stringify(started.error)}`)
  const completed = await client.waitFor(
    (m) => m.method === 'turn/completed' && m.params?.turn?.id === started.result.turn.id,
  )
  return completed
}

function readState(home: string): Promise<Wire> {
  return readFile(join(home, 'fake-state.json'), 'utf8').then((raw) => JSON.parse(raw) as Wire)
}

function rehomeLines(home: string): Promise<Wire[]> {
  return readFile(join(home, 'debug.jsonl'), 'utf8').then((raw) =>
    raw
      .split('\n')
      .filter((line) => line.includes('"thread.rehomed"'))
      .map((line) => JSON.parse(line) as Wire),
  )
}

function switchPairs(home: string): Promise<string[][]> {
  return rehomeLines(home).then((lines) =>
    lines.map((line) => [String(line.from), String(line.to)]),
  )
}

test('mid-thread switch: a GPT thread answers on Claude and goes back to GPT', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-switch-gpt-'))
  const client = launch(home, {
    ...SWITCH_ENV,
    FAKE_CODEX_STATE_FILE: join(home, 'fake-state.json'),
  })
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })

    // Born on GPT: the child owns the thread and its id.
    const start = await client.request('thread/start', { cwd: home, model: 'gpt-5.6-sol' })
    const threadId = start.result.thread.id
    assert.equal(threadId, 'fake-thread-1')
    await runUpstreamTurn(client, threadId, 'gpt-5.6-sol', 'remember the codeword BANANA')

    // Picker moved to Sonnet. This used to come back as the child's "the
    // 'sonnet' model is not supported when using Codex with a ChatGPT account".
    const answer = await runLocalTurn(client, threadId, 'sonnet', 'what is the codeword')
    assert.match(answer, /Claude Code adapter mock response/, 'answered by the local runtime')
    assert.match(answer, /Conversation so far, continued from another model/)
    assert.match(answer, /remember the codeword BANANA/, 'the GPT turn was carried over')
    // The Claude side took the child's posture (its thread/start answer:
    // on-request, workspace-write), not the old full-access default.
    const onClaude = await client.request('thread/resume', { threadId })
    assert.equal(onClaude.result.approvalPolicy, 'on-request')
    assert.equal(onClaude.result.sandbox.type, 'workspaceWrite')

    // One thread, both halves of the history, in order.
    const read = await client.request('thread/read', { threadId, includeTurns: true })
    assert.equal(read.result.thread.id, threadId)
    const roles = read.result.thread.turns.flatMap((turn: Wire) =>
      turn.items.filter((i: Wire) => i.type === 'userMessage').map((i: Wire) => i.content[0].text),
    )
    assert.deepEqual(roles, ['remember the codeword BANANA', 'what is the codeword'])

    // ...and back to GPT: the same child thread is resumed and the Claude turn
    // is injected into it, so nothing is lost in either direction.
    const backToGpt = await runUpstreamTurn(client, threadId, 'gpt-5.6-sol', 'codeword again')
    assert.equal(backToGpt.params.threadId, threadId)
    const state = await readState(home)
    const injected = JSON.stringify(state.injected[threadId])
    assert.match(injected, /what is the codeword/, 'the Claude turn reached the child')
    assert.ok(!state.turnInputs[threadId].at(-1)[0].text.includes('Conversation so far'))

    assert.deepEqual(await switchPairs(home), [
      ['gpt', 'claude'],
      ['claude', 'gpt'],
    ])
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

// A posture the app sends on one engine is the one the other engine starts
// under: a tightening left behind at a switch would be a loosening.
test('mid-thread switch: the posture crosses the switch in both directions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-switch-posture-'))
  const requestsFile = join(home, 'requests.jsonl')
  const client = launch(home, { ...SWITCH_ENV, FAKE_CODEX_REQUESTS_FILE: requestsFile })
  const untrusted = {
    approvalPolicy: 'untrusted',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  }
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })

    // GPT -> Claude: the posture of the GPT turn, not the child's start answer.
    const gpt = await client.request('thread/start', { cwd: home, model: 'gpt-5.6-sol' })
    const gptId = gpt.result.thread.id
    const turn = await client.request('turn/start', {
      threadId: gptId,
      model: 'gpt-5.6-sol',
      input: [text('first')],
      ...untrusted,
    })
    await client.waitFor(
      (m) => m.method === 'turn/completed' && m.params?.turn?.id === turn.result.turn.id,
    )
    await runLocalTurn(client, gptId, 'sonnet', 'second')
    const onClaude = await client.request('thread/resume', { threadId: gptId })
    assert.equal(onClaude.result.approvalPolicy, 'untrusted')
    assert.equal(onClaude.result.sandbox.type, 'readOnly')

    // Claude -> GPT: the child thread starts under the local thread's posture.
    const local = await client.request('thread/start', {
      cwd: home,
      model: 'sonnet',
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
    })
    await runLocalTurn(client, local.result.thread.id, 'sonnet', 'third')
    await runUpstreamTurn(client, local.result.thread.id, 'gpt-5.6-sol', 'fourth')
    const starts = (await readFile(requestsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Wire)
      .filter((r) => r.method === 'thread/start')
    assert.equal(starts.length, 2)
    assert.equal(starts[1]?.params.approvalPolicy, 'untrusted')
    assert.equal(starts[1]?.params.sandbox, 'read-only')
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

function requestLog(file: string): Promise<Wire[]> {
  return readFile(file, 'utf8').then((raw) =>
    raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Wire),
  )
}

async function completedTurn(client: StdioClient, params: Wire): Promise<Wire> {
  const started = await client.request('turn/start', params)
  assert.ok(started.result?.turn?.id, `turn/start rejected: ${JSON.stringify(started.error)}`)
  return client.waitFor(
    (m) => m.method === 'turn/completed' && m.params?.turn?.id === started.result.turn.id,
  )
}

// A thread born on Claude keeps its row while it is on GPT: a tightening sent
// there, and the profile it names, must be what its next Claude turn runs
// under, after a switch back that names only the model (the desktop's
// settings/update), even when the child answered a resume in between with
// its own reading.
test('mid-thread switch: a tightening made on GPT holds on the next Claude turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-switch-tighten-'))
  const client = launch(home, SWITCH_ENV)
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    const start = await client.request('thread/start', {
      cwd: home,
      model: 'sonnet',
      permissions: ':workspace',
    })
    const threadId = start.result.thread.id
    await runLocalTurn(client, threadId, 'sonnet', 'first')
    await runUpstreamTurn(client, threadId, 'gpt-5.6-sol', 'second')
    await completedTurn(client, {
      threadId,
      input: [text('third')],
      permissions: ':read-only',
      approvalPolicy: 'untrusted',
    })
    // The fake child answers on-request / workspace-write, as a respawned
    // child reads its own config.
    const childAnswer = await client.request('thread/resume', { threadId })
    assert.equal(childAnswer.result.approvalPolicy, 'on-request')
    await client.request('thread/settings/update', { threadId, model: 'sonnet', effort: 'low' })
    const turn = await client.request('turn/start', { threadId, input: [text('policy check')] })
    const delta = await client.waitFor(
      (m) => m.method === 'item/agentMessage/delta' && m.params?.turnId === turn.result.turn.id,
    )
    assert.equal(delta.params.delta, 'approvalPolicy=untrusted sandboxMode=read-only')
    const onClaude = await client.request('thread/resume', { threadId })
    assert.deepEqual(onClaude.result.activePermissionProfile, { id: ':read-only', extends: null })
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

// thread/start and thread/resume carry only the mode string, so the child
// gets the local posture there and its roots and network on the turn.
test('mid-thread switch: the child takes the local posture on start and on resume', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-switch-child-'))
  const requestsFile = join(home, 'requests.jsonl')
  const client = launch(home, { ...SWITCH_ENV, FAKE_CODEX_REQUESTS_FILE: requestsFile })
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    const start = await client.request('thread/start', {
      cwd: home,
      model: 'sonnet',
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    })
    const threadId = start.result.thread.id
    const roots = { type: 'workspaceWrite', writableRoots: ['/data'], networkAccess: true }
    await completedTurn(client, { threadId, input: [text('one')], sandboxPolicy: roots })

    // Start path: a new child thread.
    await runUpstreamTurn(client, threadId, 'gpt-5.6-sol', 'two')
    let log = await requestLog(requestsFile)
    const childStart = log.find((r) => r.method === 'thread/start')
    assert.equal(childStart?.params.approvalPolicy, 'untrusted')
    assert.equal(childStart?.params.sandbox, 'workspace-write')
    const firstTurn = log.find((r) => r.method === 'turn/start')
    assert.equal(firstTurn?.params.threadId, 'fake-thread-1')
    assert.equal(firstTurn?.params.approvalPolicy, 'untrusted')
    assert.deepEqual(firstTurn?.params.sandboxPolicy, {
      ...roots,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    })

    // Resume path: back on Claude the thread is made read-only, then returns.
    await completedTurn(client, {
      threadId,
      model: 'sonnet',
      input: [text('three')],
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })
    await runUpstreamTurn(client, threadId, 'gpt-5.6-sol', 'four')
    log = await requestLog(requestsFile)
    const resumed = log.filter((r) => r.method === 'thread/resume').at(-1)
    assert.equal(resumed?.params.threadId, 'fake-thread-1')
    assert.equal(resumed?.params.approvalPolicy, 'untrusted')
    assert.equal(resumed?.params.sandbox, 'read-only')
    const nextTurn = log.filter((r) => r.method === 'turn/start').at(-1)
    assert.deepEqual(nextTurn?.params.sandboxPolicy, { type: 'readOnly', networkAccess: false })
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('mid-thread switch: a Claude thread moves to GPT under one id, and Grok in between', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-switch-claude-'))
  const client = launch(home, {
    ...SWITCH_ENV,
    FAKE_CODEX_STATE_FILE: join(home, 'fake-state.json'),
  })
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })

    const start = await client.request('thread/start', { cwd: home, model: 'sonnet' })
    const threadId = start.result.thread.id
    assert.notEqual(threadId, 'fake-thread-1')
    await runLocalTurn(client, threadId, 'sonnet', 'remember the codeword BANANA')

    // Claude -> Grok: never leaves the local layer, but the session is reset,
    // so the conversation only survives because it is carried over.
    const grok = await runLocalTurn(client, threadId, 'grok-4.6', 'what is the codeword')
    assert.match(grok, /Conversation so far, continued from another model/)
    assert.match(grok, /remember the codeword BANANA/)

    // Grok -> GPT: a NEW child thread is created and aliased, so every
    // notification the desktop sees still carries the id it started with.
    const completed = await runUpstreamTurn(client, threadId, 'gpt-5.6-sol', 'and again')
    assert.equal(completed.params.threadId, threadId)
    const state = await readState(home)
    assert.equal(state.injected[threadId], undefined, 'the child thread has its own id')
    assert.match(JSON.stringify(state.injected['fake-thread-1']), /remember the codeword BANANA/)

    // One row in the list, under the app's id; the child's id never surfaces.
    const list = await client.request('thread/list', { limit: 50, sortKey: 'updated_at' })
    const ids = list.result.data.map((entry: Wire) => entry.id)
    assert.equal(ids.filter((id: string) => id === threadId).length, 1)
    assert.ok(!ids.includes('fake-thread-1'))

    // GPT -> Grok closes the loop: the child's turns come back with it.
    const back = await runLocalTurn(client, threadId, 'grok-4.6', 'one more time')
    assert.match(back, /and again/, 'the GPT turn was carried back')

    // ...and Grok -> Claude, the fourth switch on the same thread.
    const claudeAgain = await runLocalTurn(client, threadId, 'sonnet', 'last time')
    assert.match(claudeAgain, /remember the codeword BANANA/, 'still one conversation')
    assert.match(claudeAgain, /one more time/)

    assert.deepEqual(await switchPairs(home), [
      ['claude', 'grok'],
      ['grok', 'gpt'],
      ['gpt', 'grok'],
      ['grok', 'claude'],
    ])
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('mid-thread switch: ownership survives a restart, and a same-engine turn is untouched', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-switch-restart-'))
  let client = launch(home, SWITCH_ENV)
  let threadId = ''
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    const start = await client.request('thread/start', { cwd: home, model: 'gpt-5.6-sol' })
    threadId = start.result.thread.id
    await runUpstreamTurn(client, threadId, 'gpt-5.6-sol', 'remember the codeword BANANA')
    await runLocalTurn(client, threadId, 'sonnet', 'what is the codeword')
  } finally {
    await client.close()
  }

  const store = new SessionStore(join(home, 'state.sqlite'))
  const engine = store.getThreadEngine(threadId)
  store.close()
  assert.deepEqual(engine, {
    id: threadId,
    engine: 'claude',
    upstreamThreadId: threadId,
    pendingPrefix: null,
    carriedTurnId: null,
  })

  // A fresh adapter (and a fresh fake child, which knows nothing about the
  // switch) still answers this thread on Claude.
  client = launch(home, SWITCH_ENV)
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    const answer = await runLocalTurn(client, threadId, 'sonnet', 'still here')
    assert.match(answer, /Claude Code adapter mock response/)
    // Same engine as the thread already has: nothing is re-homed, and the
    // conversation is not carried over a second time.
    assert.ok(!answer.includes('Conversation so far'), 'no-op for a same-engine turn')
    // debug.jsonl spans both launches: still only the one switch from before.
    assert.deepEqual(await switchPairs(home), [['gpt', 'claude']])
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('mid-thread switch: a failed handover keeps the previous owner, and the injection has a fallback', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-switch-fail-'))
  let client = launch(home, { ...SWITCH_ENV, FAKE_CODEX_FAIL_START: '1' })
  let threadId = ''
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    const start = await client.request('thread/start', { cwd: home, model: 'sonnet' })
    threadId = start.result.thread.id
    await runLocalTurn(client, threadId, 'sonnet', 'remember the codeword BANANA')

    const refused = await client.request('turn/start', {
      threadId,
      model: 'gpt-5.6-sol',
      input: [text('and now')],
    })
    assert.equal(refused.result, undefined)
    assert.match(String(refused.error.message), /could not switch this thread to gpt-5\.6-sol/)
    assert.match(String(refused.error.message), /refuses to start a thread/)

    const store = new SessionStore(join(home, 'state.sqlite'))
    const engine = store.getThreadEngine(threadId)
    store.close()
    assert.equal(engine, null, 'ownership did not move')

    // The thread still answers on the engine it had.
    const answer = await runLocalTurn(client, threadId, 'sonnet', 'what is the codeword')
    assert.match(answer, /Claude Code adapter mock response/)
    assert.ok(!answer.includes('Conversation so far'), 'and it was never handed over')
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }

  // A child that refuses `thread/inject_items` (older protocol) still gets the
  // conversation — prefixed onto the first turn's input instead.
  const fallbackHome = await mkdtemp(join(tmpdir(), 'ccx-switch-noinject-'))
  client = launch(fallbackHome, {
    ...SWITCH_ENV,
    FAKE_CODEX_NO_INJECT: '1',
    FAKE_CODEX_STATE_FILE: join(fallbackHome, 'fake-state.json'),
  })
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    const start = await client.request('thread/start', { cwd: fallbackHome, model: 'sonnet' })
    const localThreadId = start.result.thread.id
    await runLocalTurn(client, localThreadId, 'sonnet', 'remember the codeword BANANA')
    await runUpstreamTurn(client, localThreadId, 'gpt-5.6-sol', 'what is the codeword')
    const state = await readState(fallbackHome)
    assert.equal(state.injected['fake-thread-1'], undefined)
    const firstInput = state.turnInputs['fake-thread-1'][0]
    assert.match(firstInput[0].text, /Conversation so far, continued from another model/)
    assert.match(firstInput[0].text, /remember the codeword BANANA/)
    assert.deepEqual(firstInput[1], { type: 'text', text: 'what is the codeword' })
  } finally {
    await client.close()
    await rm(fallbackHome, { recursive: true, force: true })
  }
})

test('mid-thread switch: a switch waits for the turn that is already running', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-switch-busy-'))
  const client = launch(home, SWITCH_ENV)
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    // The mock runtime asks the user a question and holds the turn open
    // until it is answered: a turn that is genuinely still running.
    const start = await client.request('thread/start', {
      cwd: home,
      model: 'sonnet',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })
    const threadId = start.result.thread.id
    const running = client.request('turn/start', {
      threadId,
      model: 'sonnet',
      input: [text('ask user question check')],
    })
    const question = await client.waitFor(
      (m) => m.method === 'item/tool/requestUserInput' && m.params?.threadId === threadId,
    )

    const refused = await client.request('turn/start', {
      threadId,
      model: 'gpt-5.6-sol',
      input: [text('switch now')],
    })
    assert.equal(refused.result, undefined)
    assert.match(String(refused.error.message), /still answering/)
    assert.match(String(refused.error.message), /gpt-5\.6-sol/)

    const answers = { q0: { answers: ['OAuth'] } }
    client.send({ jsonrpc: '2.0', id: question.id, result: { answers } })
    await running
    await client.waitFor((m) => m.method === 'turn/completed' && m.params?.threadId === threadId)

    // Once the turn is done the same switch goes through.
    const moved = await runUpstreamTurn(client, threadId, 'gpt-5.6-sol', 'switch now')
    assert.equal(moved.params.threadId, threadId)
    assert.deepEqual(await switchPairs(home), [['claude', 'gpt']])
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test("mid-thread switch: the desktop's own signal is thread/settings/update, not the turn", async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-switch-settings-'))
  const client = launch(home, {
    ...SWITCH_ENV,
    FAKE_CODEX_STATE_FILE: join(home, 'fake-state.json'),
  })
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    const start = await client.request('thread/start', { cwd: home, model: 'sonnet' })
    const threadId = start.result.thread.id
    await runLocalTurn(client, threadId, 'sonnet', 'remember the codeword BANANA')

    // Exactly what ChatGPT.app 26.901 sends when the picker moves: the model on
    // a settings update, then a turn that names no model at all.
    const settings = await client.request('thread/settings/update', {
      threadId,
      model: 'grok-4.6',
      effort: 'medium',
      multiAgentMode: 'explicitRequestOnly',
    })
    assert.equal(settings.result.model, 'grok-4.6')
    const turn = await client.request('turn/start', {
      threadId,
      cwd: home,
      model: null,
      input: [text('what is the codeword')],
    })
    const answer = await localAnswer(client, threadId, turn.result.turn.id)
    assert.match(answer, /Conversation so far, continued from another model/)
    assert.match(answer, /remember the codeword BANANA/)
    await client.waitFor(
      (m) => m.method === 'turn/completed' && m.params?.turn?.id === turn.result.turn.id,
    )

    // ...and the same signal moves the thread to the real Codex child.
    await client.request('thread/settings/update', { threadId, model: 'gpt-5.6-sol' })
    const upstream = await client.request('turn/start', {
      threadId,
      model: null,
      input: [text('and again')],
    })
    assert.ok(upstream.result?.turn?.id)
    await client.waitFor((m) => m.method === 'turn/completed' && m.params?.threadId === threadId)
    const state = await readState(home)
    assert.match(JSON.stringify(state.injected['fake-thread-1']), /remember the codeword BANANA/)

    assert.deepEqual(await switchPairs(home), [
      ['claude', 'grok'],
      ['grok', 'gpt'],
    ])
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})
