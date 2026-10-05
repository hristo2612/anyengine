import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { buildInteractiveArgs } from '../src/anyengine-runtime.mjs'
import { type ClaimEvent, liveClaimSockets, onLines, writeLine } from '../src/claim-protocol.mjs'
import { type ClaimHost, ClaimServer } from '../src/claim-server.mjs'
import { claimEventsFor, claimTurnContext } from '../src/claim-turn.mjs'
import type { ClaimThread } from '../src/claim-types.mjs'
import { DEFAULT_POSTURE, type Posture } from '../src/posture.mjs'
import type { ClaudeRuntime, RuntimeHandlers, RuntimeTurnContext } from '../src/types.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { preparationHarness } from './helpers/pty-preparation.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const servers: ClaimServer[] = []
after(async () => {
  await killChildren()
  for (const server of servers.splice(0)) await server.stop()
  await removeTempDirs()
})

const WORKSPACE: Posture = {
  fileSystem: {
    kind: 'workspace-write',
    writableRoots: [],
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  network: false,
  approval: 'on-request',
  reviewer: 'user',
  plan: false,
  trust: 'trusted',
}

class StubRuntime implements ClaudeRuntime {
  contexts: RuntimeTurnContext[] = []
  interrupted: string[] = []
  released: string[] = []
  decisions: string[] = []
  hold: Promise<void> | null = null
  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    this.contexts.push(context)
    await handlers.onEvent({
      type: 'session',
      claudeSessionId: context.claudeSessionId ?? 'sess-1',
    })
    await handlers.onEvent({
      type: 'tool_use',
      toolUseId: 'u1',
      toolName: 'Read',
      input: { file_path: `${context.cwd}/a.ts` },
    })
    const decision = await handlers.onPermissionRequest({
      type: 'permission_request',
      requestId: 'r',
      toolUseId: 'u2',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
    })
    this.decisions.push(decision.decision)
    if (this.hold) await this.hold
    await handlers.onEvent({ type: 'text_delta', delta: 'PONG' })
    await handlers.onEvent({ type: 'completed', success: true, claudeSessionId: 'sess-1' })
  }
  async steer(): Promise<void> {}
  async interrupt(threadId: string): Promise<void> {
    this.interrupted.push(threadId)
  }
  async stop(): Promise<void> {}
  async release(threadId: string): Promise<void> {
    this.released.push(threadId)
  }
}

async function serve(
  threads: Map<string, ClaimThread>,
  runtime: StubRuntime,
  options: { graceMs?: number; idleReleaseMs?: number; host?: Partial<ClaimHost> } = {},
) {
  const runDir = join(await tempDir('ae-cl-'), 'run')
  const host: ClaimHost = {
    claimThread: (id) => threads.get(id) ?? null,
    knowsThread: (id) => id === 'p' || threads.has(id),
    waitForClaimThread: async (id, ms) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const found = threads.get(id)
        if (found) return found
        await new Promise((ok) => setTimeout(ok, 20))
      }
      return threads.get(id) ?? null
    },
    runtime,
    mcpServersFor: (id) => ({ anyengine: { thread: id } }),
    ...options.host,
  }
  const server = new ClaimServer(host, {
    runDir,
    graceMs: options.graceMs ?? 200,
    idleReleaseMs: options.idleReleaseMs ?? 60_000,
  })
  servers.push(server)
  const path = await server.start()
  return { server, path, runDir }
}

function claim(
  path: string,
  threadId: string,
  extra: Record<string, unknown> = {},
): Promise<ClaimEvent[]> {
  return new Promise((ok, fail) => {
    const socket = net.connect(path)
    const events: ClaimEvent[] = []
    socket.on('error', fail)
    onLines(socket, (message) => events.push(message as ClaimEvent))
    socket.on('close', () => ok(events))
    writeLine(socket, {
      op: 'claim',
      threadId,
      parentThreadId: 'parent',
      turnId: 'turn-1',
      model: 'opus',
      prompt: 'Reply PONG',
      cwd: null,
      effort: 'low',
      ...extra,
    })
  })
}

test('claim: a known child runs under its parent posture and cwd, and streams progress and the answer', async () => {
  const cwd = await tempDir('anyengine-claim-cwd-')
  const runtime = new StubRuntime()
  const threads = new Map([
    [
      'child-1',
      {
        threadId: 'child-1',
        parentThreadId: 'parent',
        parentCwd: cwd,
        cwd,
        model: 'opus',
        posture: WORKSPACE,
      },
    ],
  ])
  const { path } = await serve(threads, runtime)
  const events = await claim(path, 'child-1')
  assert.equal(events[0]?.type, 'accepted')
  assert.ok(events.some((e) => e.type === 'progress' && e.text === 'Read `a.ts`'))
  assert.deepEqual(events.at(-1), { type: 'done', success: true, text: 'PONG' })
  const context = runtime.contexts[0]
  assert.ok(context)
  assert.deepEqual(context.posture, WORKSPACE)
  assert.equal(context.cwd, cwd)
  assert.equal(context.allowedTools, null)
  assert.equal(context.threadId, 'child-1')
  assert.equal((context.systemPromptAddendum ?? '').split('\n').length, 1)
  assert.deepEqual(context.mcpServers, { anyengine: { thread: 'child-1' } })
  assert.deepEqual(runtime.decisions, ['decline'])
  const receipt = readFileSync(process.env.ANYENGINE_DEBUG_LOG!, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .findLast((event) => event.event === 'claim.done' && event.threadId === 'child-1')
  assert.ok(receipt, 'completed runtime must produce a terminal claim receipt')
  assert.deepEqual(
    [
      receipt.parentThreadId,
      receipt.turnId,
      receipt.model,
      receipt.sessionId,
      receipt.owner,
      receipt.success,
    ],
    ['parent', 'turn-1', 'opus', 'sess-1', path, true],
  )
})

test('claim: a follow-up on the same child resumes its Claude session', async () => {
  const runtime = new StubRuntime()
  const threads = new Map([
    [
      'child-2',
      {
        threadId: 'child-2',
        parentThreadId: 'parent',
        parentCwd: null,
        cwd: null,
        model: 'opus',
        posture: DEFAULT_POSTURE,
      },
    ],
  ])
  const { path } = await serve(threads, runtime)
  await claim(path, 'child-2')
  await claim(path, 'child-2')
  assert.equal(runtime.contexts[1]?.claudeSessionId, 'sess-1')
})

test('claim: a claim waits for the thread to appear, then answers unknown after the grace period', async () => {
  const runtime = new StubRuntime()
  const threads = new Map<string, ClaimThread>()
  const { path } = await serve(threads, runtime, { graceMs: 300 })
  setTimeout(
    () =>
      threads.set('late', {
        threadId: 'late',
        parentThreadId: 'p',
        parentCwd: null,
        cwd: null,
        model: 'opus',
        posture: DEFAULT_POSTURE,
      }),
    100,
  )
  assert.equal((await claim(path, 'late'))[0]?.type, 'accepted')
  assert.deepEqual(await claim(path, 'never'), [{ type: 'unknown' }])
})

test('claim: a disconnect interrupts the claimed turn', async () => {
  const runtime = new StubRuntime()
  let release: () => void = () => {}
  runtime.hold = new Promise((ok) => {
    release = ok
  })
  const threads = new Map([
    [
      'child-3',
      {
        threadId: 'child-3',
        parentThreadId: 'p',
        parentCwd: null,
        cwd: null,
        model: 'opus',
        posture: DEFAULT_POSTURE,
      },
    ],
  ])
  const { path } = await serve(threads, runtime)
  const socket = net.connect(path)
  onLines(socket, (message) => {
    if (message.type === 'accepted') setTimeout(() => socket.destroy(), 50)
  })
  writeLine(socket, {
    op: 'claim',
    threadId: 'child-3',
    parentThreadId: 'p',
    turnId: null,
    model: 'opus',
    prompt: 'x',
    cwd: null,
    effort: null,
  })
  await new Promise((ok) => setTimeout(ok, 300))
  release()
  assert.deepEqual(runtime.interrupted, ['child-3'])
})

test('claim: an idle claimed child releases its PTY; a cwd outside the parent roots is refused', async () => {
  const runtime = new StubRuntime()
  const cwd = await tempDir('anyengine-claim-cwd-')
  const threads = new Map([
    [
      'child-4',
      {
        threadId: 'child-4',
        parentThreadId: 'p',
        parentCwd: cwd,
        cwd,
        model: 'opus',
        posture: WORKSPACE,
      },
    ],
  ])
  const { path } = await serve(threads, runtime, { idleReleaseMs: 100 })
  await claim(path, 'child-4')
  await new Promise((ok) => setTimeout(ok, 250))
  assert.deepEqual(runtime.released, ['child-4'])
  const refused = await claim(path, 'child-4', { cwd: '/' })
  assert.equal(refused.at(-1)?.type, 'error')
})

test('claim: the socket is private, listed while its adapter lives, and gone after stop', async () => {
  const { server, path, runDir } = await serve(new Map(), new StubRuntime())
  assert.equal(statSync(runDir).mode & 0o777, 0o700)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(liveClaimSockets(runDir), [path])
  await server.stop()
  assert.deepEqual(liveClaimSockets(runDir), [])
})

test('claim: `owns` answers whether this adapter knows a thread, without running anything', async () => {
  const runtime = new StubRuntime()
  const threads = new Map([
    [
      'mine',
      {
        threadId: 'mine',
        parentThreadId: 'p',
        parentCwd: null,
        cwd: null,
        model: 'opus',
        posture: DEFAULT_POSTURE,
      },
    ],
  ])
  const { path } = await serve(threads, runtime, { graceMs: 50 })
  const ask = (threadId: string) =>
    new Promise<ClaimEvent[]>((ok) => {
      const socket = net.connect(path)
      const events: ClaimEvent[] = []
      onLines(socket, (m) => events.push(m as ClaimEvent))
      socket.on('close', () => ok(events))
      writeLine(socket, { op: 'owns', threadId })
    })
  assert.deepEqual(await ask('mine'), [{ type: 'owns', owned: true, cwd: null }])
  assert.deepEqual(await ask('theirs'), [{ type: 'owns', owned: false }])
  assert.equal(runtime.contexts.length, 0)
  const asParent = (threadId: string) =>
    new Promise<ClaimEvent[]>((ok) => {
      const socket = net.connect(path)
      const events: ClaimEvent[] = []
      onLines(socket, (m) => events.push(m as ClaimEvent))
      socket.on('close', () => ok(events))
      writeLine(socket, { op: 'owns', threadId, as: 'parent' })
    })
  assert.deepEqual(
    await asParent('p'),
    [{ type: 'owns', owned: true, cwd: null }],
    'p is a thread of this adapter’s codex child',
  )
  assert.deepEqual(await asParent('elsewhere'), [{ type: 'owns', owned: false }])
})

function child(threadId: string): ClaimThread {
  return {
    threadId,
    parentThreadId: 'p',
    parentCwd: null,
    cwd: null,
    model: 'opus',
    posture: DEFAULT_POSTURE,
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((ok) => {
    resolve = ok
  })
  return { promise, resolve }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition was not reached')
    await new Promise((ok) => setTimeout(ok, 10))
  }
}

function exchange(path: string, message: object | string): Promise<ClaimEvent[]> {
  return new Promise((ok, fail) => {
    const socket = net.connect(path)
    const events: ClaimEvent[] = []
    socket.on('error', fail)
    socket.setTimeout(30_000, () => socket.destroy(new Error('claim did not finish')))
    onLines(socket, (m) => events.push(m as ClaimEvent))
    socket.on('close', () => ok(events))
    if (typeof message === 'string') socket.write(message)
    else writeLine(socket, message)
  })
}

// Mutation caught: passing an unmarked, verbatim model prompt can run local
// Claude commands instead of a claimed model turn.
test('claim: model-authored slash commands and PTY control bytes are prose', () => {
  for (const prompt of ['/config', '  /heapdump', '\x1b[201~\x03/config']) {
    const context = claimTurnContext({
      thread: child('c'),
      request: {
        op: 'claim',
        threadId: 'c',
        parentThreadId: 'p',
        turnId: null,
        model: 'opus',
        prompt,
        cwd: null,
        effort: null,
      },
      sessionId: null,
      mcpServers: null,
    })
    assert.equal(context.modelAuthored, true)
    assert.ok(!/^\s*\//u.test(context.prompt))
    assert.ok(!context.prompt.includes('\x1b'))
    assert.ok(
      buildInteractiveArgs({
        context,
        settingsPath: '/settings',
        mcpPath: null,
        extraArgs: [],
      }).includes('--disable-slash-commands'),
    )
  }
})

test('claim: a connection cancelled during discovery never runs the late child', async () => {
  const waiting = deferred()
  let entered = false
  const runtime = new StubRuntime()
  const threads = new Map<string, ClaimThread>()
  const { path } = await serve(threads, runtime, {
    host: {
      waitForClaimThread: async () => {
        entered = true
        await waiting.promise
        return child('late')
      },
    },
  })
  const socket = net.connect(path)
  writeLine(socket, {
    op: 'claim',
    threadId: 'late',
    parentThreadId: null,
    turnId: null,
    model: 'opus',
    prompt: 'x',
    cwd: null,
    effort: null,
  })
  await until(() => entered)
  socket.destroy()
  await new Promise<void>((ok) => socket.once('close', ok))
  waiting.resolve()
  await exchange(path, { op: 'ping' })
  assert.equal(runtime.contexts.length, 0)
})

test('claim: grace bounds a host discovery that never resolves', async () => {
  const { path } = await serve(new Map(), new StubRuntime(), {
    graceMs: 30,
    host: {
      waitForClaimThread: () => new Promise(() => {}),
    },
  })
  assert.deepEqual(await claim(path, 'never'), [{ type: 'unknown' }])
})

test('claim: separate children run concurrently while a duplicate child is refused', async () => {
  const runtime = new StubRuntime()
  const hold = deferred()
  runtime.hold = hold.promise
  const threads = new Map(['a', 'b', 'c'].map((id) => [id, child(id)]))
  const { path } = await serve(threads, runtime)
  const pending = ['a', 'b', 'c'].map((id) => claim(path, id))
  await until(() => runtime.contexts.length === 3)
  const duplicate = await claim(path, 'a')
  assert.equal(duplicate[0]?.type, 'error')
  assert.equal(runtime.contexts.length, 3)
  hold.resolve()
  assert.ok((await Promise.all(pending)).every((events) => events.at(-1)?.type === 'done'))
})

test('claim: stopping closes discovery and active sockets and awaits runtime cleanup', async () => {
  const runtime = new StubRuntime()
  const hold = deferred()
  const release = deferred()
  runtime.hold = hold.promise
  runtime.interrupt = async (id) => {
    runtime.interrupted.push(id)
    hold.resolve()
  }
  runtime.release = async (id) => {
    runtime.released.push(id)
    await release.promise
  }
  const { server, path } = await serve(new Map([['a', child('a')]]), runtime, {
    graceMs: 1000,
    idleReleaseMs: 20,
  })
  const active = claim(path, 'a')
  const waiting = claim(path, 'never')
  await until(() => runtime.contexts.length === 1)
  let stopped = false
  const stopping = server.stop().then(() => {
    stopped = true
  })
  await until(() => runtime.released.length > 0)
  assert.equal(stopped, false)
  release.resolve()
  await stopping
  await Promise.all([active, waiting])
  assert.deepEqual(runtime.interrupted, ['a'])
  assert.equal(existsSync(path), false)
  await server.stop()
})

test('claim: a follow-up waits for an in-flight idle release before starting', async () => {
  const runtime = new StubRuntime()
  const releasing = deferred()
  runtime.release = async (id) => {
    runtime.released.push(id)
    await releasing.promise
  }
  const { path } = await serve(new Map([['a', child('a')]]), runtime, { idleReleaseMs: 20 })
  await claim(path, 'a')
  await until(() => runtime.released.length === 1)
  const next = claim(path, 'a')
  await exchange(path, { op: 'ping' })
  assert.equal(runtime.contexts.length, 1)
  releasing.resolve()
  await next
  assert.equal(runtime.contexts[1]?.claudeSessionId, 'sess-1')
})

test('claim: rejected discovery, ownership, MCP and runtime callbacks close with an error', async () => {
  for (const host of [
    {
      waitForClaimThread: async () => {
        throw new Error('discovery failed')
      },
    },
    {
      mcpServersFor: () => {
        throw new Error('MCP failed')
      },
    },
  ]) {
    const { path } = await serve(new Map([['a', child('a')]]), new StubRuntime(), { host })
    assert.equal((await claim(path, 'a')).at(-1)?.type, 'error')
  }
  const runtime = new StubRuntime()
  runtime.runTurn = async (_context, handlers) => {
    await handlers.onEvent({
      type: 'tool_use',
      toolUseId: 'u',
      toolName: 'Bash',
      input: {
        command: {
          toString: () => {
            throw new Error('event failed')
          },
        },
      },
    })
  }
  const { path } = await serve(new Map([['a', child('a')]]), runtime, {
    host: {
      knowsThread: () => {
        throw new Error('ownership failed')
      },
    },
  })
  assert.equal(
    (await exchange(path, { op: 'owns', threadId: 'p', as: 'parent' })).at(-1)?.type,
    'error',
  )
  assert.equal((await claim(path, 'a')).at(-1)?.type, 'error')
  assert.deepEqual(await exchange(path, { op: 'ping' }), [
    { type: 'pong', pid: process.pid, threads: 1 },
  ])
})

test('claim: malformed and oversized frames are refused and one connection runs one request', async () => {
  const runtime = new StubRuntime()
  const { path } = await serve(new Map([['a', child('a')]]), runtime)
  for (const message of [
    '{bad json}\n',
    '[]\n',
    'null\n',
    `${JSON.stringify({ op: 'claim', threadId: 'a', model: 'opus', prompt: 'x', cwd: 7 })}\n`,
    'x'.repeat(8 * 1024 * 1024 + 1),
  ]) {
    assert.equal((await exchange(path, message)).at(-1)?.type, 'error')
  }
  const events = await exchange(
    path,
    JSON.stringify({ op: 'ping' }) +
      '\n' +
      JSON.stringify({ op: 'claim', threadId: 'a', model: 'opus', prompt: 'x' }) +
      '\n',
  )
  assert.equal(events[0]?.type, 'pong')
  assert.equal(runtime.contexts.length, 0)
})

test('claim: listing ignores plain files and symlinks; start refuses a path already in use', async () => {
  const { server, path, runDir } = await serve(new Map(), new StubRuntime())
  const other = join(runDir, `claim-${process.ppid}.sock`)
  writeFileSync(other, 'not a socket')
  assert.deepEqual(liveClaimSockets(runDir), [path])
  const duplicate = new ClaimServer(
    {
      claimThread: () => null,
      waitForClaimThread: async () => null,
      knowsThread: () => false,
      runtime: new StubRuntime(),
      mcpServersFor: () => null,
    },
    { runDir, graceMs: 20, idleReleaseMs: 20 },
  )
  await assert.rejects(duplicate.start(), /exists|use/u)
  assert.equal((await exchange(path, { op: 'ping' }))[0]?.type, 'pong')
  await server.stop()
  symlinkSync(other, path)
  assert.deepEqual(liveClaimSockets(runDir), [])
  await assert.rejects(duplicate.start(), /exists|socket/u)
})

test('claim: warning and error events remain observable and result-only completions return an answer', async () => {
  assert.deepEqual(claimEventsFor({ type: 'notice', level: 'info', message: 'quiet' }, null), [])
  assert.deepEqual(claimEventsFor({ type: 'notice', level: 'warning', message: 'warning' }, null), [
    { type: 'progress', text: 'warning' },
  ])
  assert.deepEqual(claimEventsFor({ type: 'error', message: 'failed' }, null), [
    { type: 'error', message: 'failed' },
  ])
  const runtime = new StubRuntime()
  runtime.runTurn = async (_context, handlers) => {
    await handlers.onEvent({ type: 'completed', success: false, result: 'partial' })
  }
  const { path } = await serve(new Map([['a', child('a')]]), runtime)
  assert.deepEqual((await claim(path, 'a')).at(-1), {
    type: 'done',
    success: false,
    text: 'partial',
  })
})

test('claim: owns reports only the adapter record cwd, including an explicit null', async () => {
  const cwd = await tempDir('ae-own-')
  const threads = new Map([
    ['rooted', { ...child('rooted'), parentCwd: cwd, cwd: '/' }],
    ['empty', child('empty')],
  ])
  const { path } = await serve(threads, new StubRuntime())
  assert.deepEqual(await exchange(path, { op: 'owns', threadId: 'rooted', cwd: '/forged' }), [
    { type: 'owns', owned: true, cwd },
  ])
  assert.deepEqual(await exchange(path, { op: 'owns', threadId: 'empty', cwd: '/forged' }), [
    { type: 'owns', owned: true, cwd: null },
  ])
})

test('claim: stop closes a connected client that sent no request', async () => {
  const { server, path } = await serve(new Map(), new StubRuntime())
  const socket = net.connect(path)
  await new Promise<void>((ok, fail) => {
    socket.once('connect', ok)
    socket.once('error', fail)
  })
  const closed = new Promise<void>((ok) => socket.once('close', ok))
  await server.stop()
  await closed
})

test('claim: failed idle release blocks the next turn and shutdown still completes', async () => {
  const runtime = new StubRuntime()
  runtime.release = async (id) => {
    runtime.released.push(id)
    throw new Error('release failed')
  }
  const { server, path } = await serve(new Map([['a', child('a')]]), runtime, { idleReleaseMs: 20 })
  await claim(path, 'a')
  await until(() => runtime.released.length === 1)
  assert.equal((await claim(path, 'a')).at(-1)?.type, 'error')
  assert.equal(runtime.contexts.length, 1)
  await server.stop()
})

test('claim: the session cap evicts and releases an idle child', async () => {
  const runtime = new StubRuntime()
  const threads = new Map(Array.from({ length: 501 }, (_, i) => [`c-${i}`, child(`c-${i}`)]))
  const { path } = await serve(threads, runtime)
  for (const id of threads.keys()) assert.equal((await claim(path, id)).at(-1)?.type, 'done')
  assert.deepEqual(await exchange(path, { op: 'ping' }), [
    { type: 'pong', pid: process.pid, threads: 500 },
  ])
  await until(() => runtime.released.includes('c-0'))
})

test('claim: overlong socket paths fail before listening and symlink run directories are refused', async () => {
  const root = await tempDir('ae-long-')
  const host: ClaimHost = {
    claimThread: () => null,
    waitForClaimThread: async () => null,
    knowsThread: () => false,
    runtime: new StubRuntime(),
    mcpServersFor: () => null,
  }
  const long = new ClaimServer(host, {
    runDir: join(root, 'é'.repeat(50)),
    graceMs: 10,
    idleReleaseMs: 10,
  })
  await assert.rejects(long.start(), /byte limit/u)
  const link = join(root, 'link')
  symlinkSync(root, link)
  await assert.rejects(
    new ClaimServer(host, { runDir: link, graceMs: 10, idleReleaseMs: 10 }).start(),
    /owned directory/u,
  )
})

test('claim: the adapter exposes learned native children and unlinks its socket on shutdown', async () => {
  const root = await tempDir('ae-ad-')
  const proc = spawn(process.execPath, [resolve('dist/src/adapter.mjs'), 'app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: root,
      ANYENGINE_ROOT: root,
      ANYENGINE_MOCK: '1',
      ANYENGINE_NATIVE_CODEX: '1',
      ANYENGINE_REAL_CODEX: resolve('test/fixtures/fake-codex-app-server.mjs'),
      FAKE_CODEX_SPAWN_CHILD: 'opus',
      FAKE_CODEX_SPAWN_ORDER: 'child-first',
      FAKE_CODEX_NO_APPROVAL: '1',
    },
  })
  const messages: Record<string, unknown>[] = []
  let output = ''
  proc.stdout.on('data', (chunk) => {
    output += chunk.toString()
    let end = output.indexOf('\n')
    while (end >= 0) {
      messages.push(JSON.parse(output.slice(0, end)))
      output = output.slice(end + 1)
      end = output.indexOf('\n')
    }
  })
  const request = async (id: number, method: string, params: object) => {
    proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    await until(() => messages.some((m) => m.id === id))
    const response = messages.find((m) => m.id === id)
    assert.equal(response?.error, undefined)
    return response?.result as Record<string, unknown>
  }
  const path = join(root, 'run', `claim-${proc.pid}.sock`)
  try {
    await request(1, 'initialize', { clientInfo: { name: 'claim-test', version: '1' } })
    await until(() => existsSync(path))
    const started = await request(2, 'thread/start', {
      model: 'gpt-5.6-sol',
      cwd: root,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    })
    const threadId = (started.thread as { id: string }).id
    await request(3, 'turn/start', { threadId, input: [{ type: 'text', text: 'spawn a child' }] })
    const owned = await exchange(path, { op: 'owns', threadId: 'fake-child-fake-turn-1' })
    assert.deepEqual(owned, [{ type: 'owns', owned: true, cwd: root }])
    const missed = await exchange(path, {
      op: 'owns',
      threadId: `fake-missed-child-of-${threadId}`,
    })
    assert.deepEqual(missed, [{ type: 'owns', owned: true, cwd: root }])
    const events = await claim(path, 'fake-child-fake-turn-1')
    assert.equal(events[0]?.type, 'accepted')
    assert.equal(events.at(-1)?.type, 'done')
  } finally {
    await killChildren()
  }
  assert.equal(existsSync(path), false)
})

test('claim: a runtime that swallows an event callback failure is cancelled and the caller gets an error', async () => {
  const runtime = new StubRuntime()
  const held = deferred()
  runtime.runTurn = async (_context, handlers) => {
    try {
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: 'u',
        toolName: 'Bash',
        input: {
          command: {
            toString: () => {
              throw new Error('display failed')
            },
          },
        },
      })
    } catch {
      /* Some runtime event sources swallow consumer exceptions. */
    }
    await held.promise
  }
  runtime.interrupt = async (id) => {
    runtime.interrupted.push(id)
    held.resolve()
  }
  const { path } = await serve(new Map([['a', child('a')]]), runtime)
  let timer: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([
      claim(path, 'a'),
      new Promise<'hanging'>((ok) => {
        timer = setTimeout(() => ok('hanging'), 30_000)
      }),
    ])
    assert.notEqual(result, 'hanging', 'callback failure left the claim hanging')
    assert.equal((result as ClaimEvent[]).at(-1)?.type, 'error')
    assert.deepEqual(runtime.interrupted, ['a'])
  } finally {
    clearTimeout(timer)
    held.resolve()
  }
})

test('claim: stop waits for a runtime still preparing before releasing its busy PTY', async () => {
  const runtime = new StubRuntime()
  const preparing = deferred()
  let busy = false
  runtime.runTurn = async (_context, handlers) => {
    busy = true
    try {
      await preparing.promise
      await handlers.onEvent({ type: 'session', claudeSessionId: 'late' })
    } finally {
      busy = false
    }
  }
  runtime.release = async (id) => {
    if (!busy) runtime.released.push(id)
  }
  const { server, path } = await serve(new Map([['a', child('a')]]), runtime)
  const pending = claim(path, 'a')
  await until(() => busy)
  let stopped = false
  const stopping = server.stop().then(() => {
    stopped = true
  })
  try {
    await until(() => runtime.interrupted.length === 1)
    assert.equal(stopped, false, 'stop returned while the runtime could still create its PTY')
  } finally {
    preparing.resolve()
    await stopping
    await pending
  }
  assert.ok(runtime.released.includes('a'))
})

test('claim: owns does not revive a child deleted while discovery was resolving', async () => {
  const { path } = await serve(new Map(), new StubRuntime(), {
    host: {
      waitForClaimThread: async () => child('gone'),
    },
  })
  assert.deepEqual(await exchange(path, { op: 'owns', threadId: 'gone' }), [
    { type: 'owns', owned: false },
  ])
})

for (const phase of ['hooks', 'proxy'] as const) {
  test(`claim: production ${phase} preparation cannot spawn after disconnect and the server shutdown deadline`, async (t) => {
    const h = await preparationHarness(t, phase)
    const { server, path } = await serve(new Map([['a', child('a')]]), new StubRuntime(), {
      host: { runtime: h.runtime },
    })
    const socket = net.connect(path)
    socket.on('error', () => {})
    writeLine(socket, { op: 'claim', threadId: 'a', model: 'opus', prompt: 'x', cwd: h.dir })
    try {
      await h.entered.promise
      socket.destroy()
      // Keep preparation held beyond the server's bounded settlement wait.
      await server.stop()
      let stopped = false
      const stopping = h.runtime.stop().then(() => {
        stopped = true
      })
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(stopped, false, 'shared runtime stop did not join late preparation')
      h.resume.resolve()
      await stopping
      await until(() => !h.listening && h.alive === 0)
      assert.equal(h.starts, 0, 'stopped preparation created a late PTY')
      assert.ok(!h.writes.some((s) => s.includes('\x1b[200~') || s === '\r'))
    } finally {
      h.resume.resolve()
      socket.destroy()
      await new Promise<void>((ok) => setImmediate(ok))
      await h.runtime.stop()
      await server.stop()
    }
  })
}
