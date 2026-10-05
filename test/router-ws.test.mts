import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { DEFAULT_CONFIG, enginePaths } from '../src/anyengine-config.mjs'
import { ClaimServer } from '../src/claim-server.mjs'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { DEFAULT_POSTURE } from '../src/posture.mjs'
import { ResponsesStream, usageObject } from '../src/responses-stream.mjs'
import { CatalogCache, modelsHook } from '../src/router-catalog.mjs'
import { FanoutMonitor } from '../src/router-fanout.mjs'
import { buildRouterRuntime } from '../src/router-hooks.mjs'
import { createRouterLog } from '../src/router-log.mjs'
import { startRouter } from '../src/router-server.mjs'
import { type ClaudeTurns, claudeHttpHook, unavailable } from '../src/router-turns.mjs'
import { wsUpgradeHook } from '../src/router-ws.mjs'
import { startFakeBackend } from './helpers/fake-backend.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const closers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await removeTempDirs()
})

const stubClaude = (calls: string[]): ClaudeTurns => ({
  mode: 'agent',
  run: async (_ctx, request) => {
    calls.push(String(request.body.model))
    const stream = new ResponsesStream(request.sink, { model: String(request.body.model) })
    stream.begin()
    stream.textDelta('CLAUDE')
    stream.complete(usageObject())
  },
})

async function setup(turns: ClaudeTurns | null, upstream?: string) {
  const root = await tempDir('anyengine-ws-')
  const backend = await startFakeBackend()
  closers.push(() => backend.close())
  // Each read of this clock is eleven minutes later: past the grace in which
  // v2 evidence is ignored after a start (Task 9).
  let t = Date.now()
  const fanout = new FanoutMonitor(
    () => DEFAULT_CONFIG,
    null,
    undefined,
    () => (t += 11 * 60_000),
  )
  fanout.noteServed(['gpt-6-sol'])
  const router = await startRouter({
    root,
    port: 0,
    upstream: upstream ?? backend.url,
    hooks: {
      models: modelsHook(new CatalogCache(join(root, 'catalogs.json')), fanout),
      upgrade: wsUpgradeHook({ fanout, turns: () => turns }),
      claudeHttp: claudeHttpHook(() => turns),
      observeGptBody: (b) => fanout.observeGptBody(b),
    },
  })
  closers.push(() => router.close(0))
  return { backend, fanout, router, ws: router.baseUrl.replace('http', 'ws'), http: router.baseUrl }
}

function open(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((ok, fail) => {
    const socket = new WebSocket(`${url}/responses`, { headers })
    socket.once('open', () => ok(socket))
    socket.once('error', fail)
    socket.once('unexpected-response', (_req, res) => fail(new Error(`status ${res.statusCode}`)))
    closers.push(async () => socket.terminate())
  })
}

function until(
  socket: WebSocket,
  done: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> {
  return new Promise((ok, fail) => {
    const seen: Record<string, unknown>[] = []
    const timer = setTimeout(() => finish(new Error('no terminal frame')), 30_000)
    const finish = (error?: Error) => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      if (error) fail(error)
      else ok(seen)
    }
    const onClose = () => finish(new Error('socket closed before terminal frame'))
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      seen.push(frame)
      if (done(frame)) finish()
    }
    socket.on('message', onMessage)
    socket.once('close', onClose)
  })
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'condition did not become true')
    await delay(10)
  }
}

// A real loopback WebSocket peer with controlled handshake and terminal frames.
async function peer(
  options: {
    headers?: string[]
    refusal?: number
    frame?: (socket: WebSocket, data: WebSocket.RawData, binary: boolean) => void
  } = {},
) {
  const server = http.createServer()
  const wss = new WebSocketServer({ noServer: true })
  const received: string[] = []
  const peers: WebSocket[] = []
  wss.on('headers', (headers) => headers.push(...(options.headers ?? [])))
  server.on('upgrade', (req, socket, head) => {
    if (options.refusal) {
      socket.end(
        `HTTP/1.1 ${options.refusal} Upgrade Required\r\nX-Rate-Limit: 17\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      )
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      peers.push(ws)
      ws.on('message', (data, binary) => {
        received.push(data.toString())
        options.frame?.(ws, data, binary)
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  closers.push(async () => {
    for (const socket of peers) socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { url: `http://127.0.0.1:${address.port}/backend-api/codex`, received, peers }
}

const meta = (model: string) =>
  JSON.stringify({ thread_id: 't1', turn_id: 'u1', request_kind: 'turn', model })
const completed = (f: Record<string, unknown>) =>
  f.type === 'response.completed' || f.type === 'response.failed' || f.type === 'error'

test('housekeeping: before any catalog is known, Claude fails clearly without reaching upstream', async () => {
  const { ws, http, backend } = await setup(null)
  const socket = await open(ws)
  const done = until(socket, completed)
  socket.send('{"type":"response.create","model":"opus","input":[]}')
  assert.equal(((await done).at(-1)?.error as { code: string }).code, 'anyengine_no_gpt_model')
  const response = await fetch(`${http}/responses`, {
    method: 'POST',
    body: '{"model":"opus","input":[]}',
  })
  assert.equal(response.status, 400)
  assert.match(await response.text(), /anyengine_no_gpt_model/)
  assert.equal(backend.frames.length, 0)
  assert.equal(backend.requests.length, 0)
})

test('ws: a GPT socket reaches the upstream with its headers, and frames pass byte for byte', async () => {
  const { backend, ws } = await setup(null)
  const socket = await open(ws, {
    authorization: 'Bearer t',
    'x-codex-turn-metadata': meta('gpt-6-sol'),
  })
  const frame = '{"type":"response.create","model":"gpt-6-sol","input":[] }'
  const answer = until(socket, completed)
  socket.send(frame)
  await answer
  assert.equal(backend.upgrades[0]?.headers.authorization, 'Bearer t')
  assert.equal(backend.frames[0], frame)
})

test('ws: a Claude frame goes to the Claude handler, a GPT frame on the same socket upstream', async () => {
  const calls: string[] = []
  const { backend, ws } = await setup(stubClaude(calls))
  const socket = await open(ws)
  const claude = until(socket, completed)
  socket.send(
    JSON.stringify({
      type: 'response.create',
      model: 'opus',
      input: [{ type: 'additional_tools', tools: [] }],
    }),
  )
  const frames = await claude
  assert.deepEqual(calls, ['opus'])
  assert.ok(frames.some((f) => f.type === 'response.output_text.delta'))
  assert.equal(backend.frames.length, 0)
  const gpt = until(socket, completed)
  socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-sol', input: [] }))
  await gpt
  assert.equal(backend.frames.length, 1)
})

test('ws: without a Claude handler a Claude frame gets a clear error, not a hang', async () => {
  const { ws } = await setup(null)
  const socket = await open(ws)
  const frames = until(socket, completed)
  socket.send(
    JSON.stringify({
      type: 'response.create',
      model: 'opus',
      input: [{ type: 'additional_tools', tools: [] }],
    }),
  )
  const last = (await frames).at(-1) as { type: string; error: { code: string } }
  assert.equal(last.type, 'error')
  assert.equal(last.error.code, 'anyengine_claude_unavailable')
})

test('ws: a Claude prewarm is answered at once without running Claude', async () => {
  const calls: string[] = []
  const { ws } = await setup(stubClaude(calls))
  const socket = await open(ws)
  const frames = until(socket, completed)
  socket.send(
    JSON.stringify({ type: 'response.create', model: 'opus', generate: false, input: [] }),
  )
  await frames
  assert.deepEqual(calls, [])
})

test('ws: router items are stripped from GPT frames; v2 collaboration tools move fan-out to the bridge', async () => {
  const { backend, ws, fanout } = await setup(null)
  const socket = await open(ws, { 'x-codex-turn-metadata': meta('gpt-6-sol') })
  const done = until(socket, completed)
  socket.send(
    JSON.stringify({
      type: 'response.create',
      model: 'gpt-6-sol',
      input: [
        {
          type: 'message',
          id: 'msg_ae_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'x' }],
        },
        {
          type: 'additional_tools',
          tools: [
            {
              type: 'namespace',
              name: 'collaboration',
              tools: [
                {
                  type: 'function',
                  name: 'spawn_agent',
                  parameters: { properties: { message: { encrypted: true } } },
                },
              ],
            },
          ],
        },
      ],
    }),
  )
  await done
  assert.ok(!(backend.frames[0] ?? '').includes('msg_ae_1'))
  assert.equal(fanout.state.path, 'bridge')
})

test('ws: another upgrade path (a realtime socket) is tunnelled to the upstream untouched', async () => {
  const { backend, ws } = await setup(null)
  const socket = await new Promise<WebSocket>((ok, fail) => {
    const s = new WebSocket(`${ws}/realtime?intent=x`, { headers: { authorization: 'Bearer t' } })
    s.once('open', () => ok(s))
    s.once('error', fail)
    closers.push(async () => s.terminate())
  })
  const answer = until(socket, completed)
  socket.send('{"type":"response.create","model":"gpt-realtime"}')
  await answer
  const upgrade = backend.upgrades.find((u) => u.path.endsWith('/realtime'))
  assert.ok(upgrade)
  assert.equal(upgrade.headers.authorization, 'Bearer t')
  assert.equal(backend.frames.at(-1), '{"type":"response.create","model":"gpt-realtime"}')
})

test('ws: a browser origin is refused at the upgrade', async () => {
  const { ws } = await setup(null)
  await assert.rejects(open(ws, { origin: 'https://evil.example' }), /403/)
})

test('http: a Claude request goes to the handler; previous_response_id over HTTP asks for a replay', async () => {
  const calls: string[] = []
  const { http } = await setup(stubClaude(calls))
  const res = await fetch(`${http}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'opus', input: [{ type: 'additional_tools', tools: [] }] }),
  })
  assert.match(await res.text(), /CLAUDE/)
  const replay = await fetch(`${http}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'opus', previous_response_id: 'resp_ae_x', input: [] }),
  })
  assert.equal(replay.status, 400)
  assert.match(await replay.text(), /previous_response_not_found/)
})

test('ws: the GPT upgrade preserves upstream rate limits and duplicate response headers', async () => {
  const upstream = await peer({ headers: ['X-Rate-Limit: 19', 'X-Dup: one', 'X-Dup: two'] })
  const { ws } = await setup(null, upstream.url)
  const socket = new WebSocket(`${ws}/responses`, {
    headers: { 'x-codex-turn-metadata': meta('gpt-6-sol') },
  })
  closers.push(async () => socket.terminate())
  const headers = await new Promise<string[]>((resolve, reject) => {
    socket.once('upgrade', (response) => resolve(response.rawHeaders))
    socket.once('error', reject)
  })
  assert.ok(headers.includes('19'))
  assert.deepEqual(
    headers.filter((_value, index) => headers[index - 1] === 'X-Dup'),
    ['one', 'two'],
  )
})

test('ws: an upstream upgrade refusal reaches Codex with its rate-limit header', async () => {
  const upstream = await peer({ refusal: 426 })
  const { ws, router } = await setup(null, upstream.url)
  const socket = new WebSocket(`${ws}/responses`, {
    headers: { 'x-codex-turn-metadata': meta('gpt-6-sol') },
  })
  const refused = await new Promise<{ status: number | undefined; header: unknown }>(
    (resolve, reject) => {
      socket.once('unexpected-response', (_req, response) => {
        resolve({ status: response.statusCode, header: response.headers['x-rate-limit'] })
        response.resume()
        socket.terminate()
      })
      socket.once('error', reject)
    },
  )
  assert.deepEqual(refused, { status: 426, header: '17' })
  assert.deepEqual(router.context.inflight, { gpt: 0, claude: 0 })
})

test('ws: a plain-shape Claude prewarm with tools does not start a turn', async () => {
  const calls: string[] = []
  const { ws, backend, router } = await setup(stubClaude(calls))
  const socket = await open(ws)
  const answer = until(socket, completed)
  socket.send(
    JSON.stringify({
      type: 'response.create',
      model: 'opus',
      generate: false,
      tools: [{ type: 'function', name: 'exec' }],
      input: [],
    }),
  )
  const frames = await answer
  assert.equal(frames.at(-1)?.type, 'response.completed')
  assert.deepEqual(calls, [])
  assert.equal(backend.frames.length, 0)
  assert.deepEqual(router.context.inflight, { gpt: 0, claude: 0 })
})

test('http: a plain-shape Claude prewarm completes locally before turn detection', async () => {
  const calls: string[] = []
  const { http, backend, router } = await setup(stubClaude(calls))
  const response = await fetch(`${http}/responses`, {
    method: 'POST',
    body: JSON.stringify({
      model: 'opus',
      generate: false,
      tools: [{ type: 'function', name: 'exec' }],
      input: [],
    }),
  })
  assert.equal(response.status, 200)
  assert.match(await response.text(), /response.completed/)
  assert.deepEqual(calls, [])
  assert.equal(backend.requests.length, 0)
  assert.deepEqual(router.context.inflight, { gpt: 0, claude: 0 })
})

test('http: an unavailable Claude turn returns a nonretryable error', async () => {
  const { http } = await setup(null)
  const response = await fetch(`${http}/responses`, {
    method: 'POST',
    body: JSON.stringify({ model: 'opus', tools: [{ name: 'exec' }], input: [] }),
  })
  assert.equal(response.status, 400)
  const body = (await response.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'anyengine_claude_unavailable')
})

test('housekeeping: HTTP and WebSocket use the best eligible GPT catalog entry', async () => {
  const { http, ws, backend } = await setup(null)
  backend.models = [
    { slug: 'opus', visibility: 'list', priority: -3 },
    { slug: 'ghost', visibility: 'list', priority: -2, description: 'via AnyEngine' },
    { slug: 'hidden', visibility: 'hide', priority: -1 },
    { slug: 'future-default', visibility: 'list', priority: 1 },
  ]
  assert.equal((await fetch(`${http}/models`)).status, 200)
  const response = await fetch(`${http}/responses?kind=title`, {
    method: 'POST',
    body: JSON.stringify({
      model: 'opus',
      reasoning: { effort: 'max', summary: 'auto' },
      input: [],
    }),
  })
  assert.match(await response.text(), /PONG/)
  const request = backend.requests.find((r) => r.path.endsWith('/responses'))
  assert.ok(request)
  assert.deepEqual(JSON.parse(request.raw.toString()), {
    model: 'future-default',
    reasoning: { effort: 'medium', summary: 'auto' },
    input: [],
  })
  assert.equal(request.query, '?kind=title')
  const socket = await open(ws)
  const done = until(socket, completed)
  socket.send(
    JSON.stringify({
      type: 'response.create',
      model: 'opus',
      reasoning: { effort: 'high' },
      input: [{ id: 'msg_ae_x', type: 'message', role: 'assistant', content: [] }],
    }),
  )
  await done
  const forwarded = JSON.parse(backend.frames.at(-1) ?? '{}')
  assert.equal(forwarded.model, 'future-default')
  assert.equal(forwarded.reasoning.effort, 'high')
  assert.equal(forwarded.input[0].id, undefined)
})

test('ws: router response deltas retain Claude context and expand it before a GPT switch', async () => {
  const { ws, backend } = await setup(stubClaude([]))
  const socket = await open(ws)
  const first = until(socket, completed)
  socket.send(
    JSON.stringify({
      type: 'response.create',
      model: 'opus',
      input: [{ type: 'additional_tools', tools: [] }],
    }),
  )
  const response = (await first).at(-1)?.response as { id: string }
  assert.match(response.id, /^resp_ae_/)
  const next = until(socket, completed)
  socket.send(
    JSON.stringify({
      type: 'response.create',
      model: 'gpt-6-sol',
      previous_response_id: response.id,
      input: [{ type: 'message', role: 'user', content: 'continue' }],
    }),
  )
  await next
  const forwarded = JSON.parse(backend.frames[0] ?? '{}')
  assert.equal(forwarded.previous_response_id, undefined)
  assert.equal(forwarded.input.length, 3)
  assert.equal(forwarded.input[1].content[0].text, 'CLAUDE')
  assert.equal(forwarded.input[1].id, undefined)
})

test('ws: an unknown router response asks for replay without forwarding upstream', async () => {
  const { ws, backend } = await setup(null)
  const socket = await open(ws)
  const done = until(socket, completed)
  socket.send(
    JSON.stringify({
      type: 'response.create',
      model: 'gpt-6-sol',
      previous_response_id: 'resp_ae_\ud800',
      input: [],
    }),
  )
  const error = (await done).at(-1)?.error as { code: string; message: string }
  assert.equal(error.code, 'previous_response_not_found')
  assert.ok(!error.message.includes('\ud800'), 'error JSON contains no lone surrogate')
  assert.equal(backend.frames.length, 0)
})

test('ws: many Claude turns on one socket release their close listeners', async () => {
  let serverSocket: WebSocket | undefined
  const handler: ClaudeTurns = {
    mode: 'agent',
    run: async (_ctx, request) => {
      serverSocket = (request.sink as import('../src/responses-stream.mjs').WebSocketSink).socket
      const stream = new ResponsesStream(request.sink, { model: 'opus' })
      stream.begin()
      stream.complete(usageObject())
    },
  }
  const { ws, router } = await setup(handler)
  const socket = await open(ws)
  for (let i = 0; i < 15; i += 1) {
    const done = until(socket, completed)
    socket.send(
      JSON.stringify({
        type: 'response.create',
        model: 'opus',
        tools: [{ name: 'exec' }],
        input: [],
      }),
    )
    await done
  }
  assert.ok(serverSocket)
  assert.ok(
    serverSocket.listenerCount('close') <= 2,
    'turn cleanup leaves only socket lifecycle listeners',
  )
  assert.equal(router.context.inflight.claude, 0)
})

test('ws: GPT terminal frames count down regardless of JSON whitespace and key order', async () => {
  const upstream = await peer()
  const { ws, router } = await setup(null, upstream.url)
  const socket = await open(ws)
  for (const type of ['response.completed', 'response.failed', 'response.incomplete', 'error']) {
    const done = until(socket, (frame) => frame.type === type)
    socket.send('{"type":"response.create","model":"gpt-6-sol","input":[]}')
    await eventually(() => router.context.inflight.gpt === 1)
    await eventually(() => upstream.received.length > 0 && upstream.peers.length > 0)
    upstream.peers[0]?.send(` { "response": {"id":"upstream"}, "type": "${type}" }`)
    await done
    assert.equal(router.context.inflight.gpt, 0)
  }
})

test('ws: caller close releases GPT requests awaiting upstream completion', async () => {
  const upstream = await peer()
  const { ws, router } = await setup(null, upstream.url)
  const socket = await open(ws)
  socket.send('{"type":"response.create","model":"gpt-6-sol","input":[]}')
  await eventually(() => router.context.inflight.gpt === 1)
  socket.terminate()
  await eventually(() => router.context.inflight.gpt === 0)
})

test('ws: upstream failure releases a queued GPT request and closes the client', async () => {
  const upstream = await peer({ refusal: 426 })
  const { ws, router } = await setup(null, upstream.url)
  const socket = await open(ws)
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  socket.send('{"type":"response.create","model":"gpt-6-sol","input":[]}')
  await closed
  assert.equal(router.context.inflight.gpt, 0)
  assert.ok(router.context.health.lastError)
})

test('ws: a synchronous Claude handler throw is contained and releases the counter', async () => {
  const { ws, router } = await setup({
    mode: 'agent',
    run: () => {
      throw new Error('boom')
    },
  })
  const socket = await open(ws)
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  socket.send('{"type":"response.create","model":"opus","tools":[{"name":"exec"}],"input":[]}')
  await closed
  assert.equal(router.context.inflight.claude, 0)
  assert.equal((await fetch(router.healthUrl)).status, 200)
})

test('ws: hostile tool declarations cannot throw out of the frame handler', async () => {
  const { ws, router, fanout } = await setup(null)
  const socket = await open(ws)
  fanout.noteServed(['gpt-6-sol'])
  const done = until(socket, completed)
  socket.send(
    '{"type":"response.create","model":"gpt-6-sol","tools":[{"name":{"toString":null}}],"input":[]}',
  )
  const frame = (await done).at(-1)
  assert.equal(frame?.type, 'error')
  assert.equal(router.context.faults.hookErrors, 1)
  assert.deepEqual(router.context.inflight, { gpt: 0, claude: 0 })
  assert.equal((await fetch(router.healthUrl)).status, 200)
})

test('ws: a caller closing Claude aborts and counts out even if its handler is still settling', async () => {
  let signal: AbortSignal | undefined
  let finish = () => {}
  const settled = new Promise<void>((resolve) => {
    finish = resolve
  })
  const { ws, router } = await setup({
    mode: 'agent',
    run: async (_ctx, request) => {
      signal = request.signal
      await settled
      request.sink.end()
    },
  })
  const socket = await open(ws)
  socket.send('{"type":"response.create","model":"opus","tools":[{"name":"exec"}],"input":[]}')
  await eventually(() => router.context.inflight.claude === 1)
  socket.terminate()
  await eventually(() => signal?.aborted === true && router.context.inflight.claude === 0)
  finish()
})

test('http: caller close aborts Claude and counts out before its handler settles', async () => {
  let signal: AbortSignal | undefined
  let finish = () => {}
  const settled = new Promise<void>((resolve) => {
    finish = resolve
  })
  const { http: url, router } = await setup({
    mode: 'agent',
    run: async (_ctx, request) => {
      signal = request.signal
      await settled
      request.sink.end()
    },
  })
  const request = http.request(`${url}/responses`, { method: 'POST' })
  request.on('error', () => {})
  request.end('{"model":"opus","tools":[{"name":"exec"}],"input":[]}')
  await eventually(() => router.context.inflight.claude === 1)
  request.destroy()
  await eventually(() => signal?.aborted === true && router.context.inflight.claude === 0)
  finish()
})

test('http: Claude handler failure cannot leave an in-flight request or hang', async () => {
  const { http, router } = await setup({
    mode: 'agent',
    run: async () => {
      throw new Error('failure')
    },
  })
  const response = await fetch(`${http}/responses`, {
    method: 'POST',
    body: '{"model":"opus","tools":[{"name":"exec"}],"input":[]}',
  })
  assert.equal(response.status, 500)
  await response.text()
  assert.equal(router.context.inflight.claude, 0)
})

test('daemon runtime: registered HTTP and WebSocket routes use the owned agent handler', async () => {
  const root = await tempDir('ae-wr-')
  const backend = await startFakeBackend()
  closers.push(() => backend.close())
  const runtime = buildRouterRuntime(root, createRouterLog(join(root, 'router.jsonl')))
  runtime.claude.agent = stubClaude([])
  const thread = {
    threadId: 'registered',
    parentThreadId: null,
    parentCwd: null,
    cwd: root,
    model: 'opus',
    posture: DEFAULT_POSTURE,
  }
  const claims = new ClaimServer(
    {
      claimThread: (id) => (id === 'registered' ? thread : null),
      waitForClaimThread: async (id) => (id === 'registered' ? thread : null),
      knowsThread: (id) => id === 'registered',
      runtime: new MockRuntime(),
      mcpServersFor: () => null,
    },
    { runDir: enginePaths(root).run, graceMs: 0, idleReleaseMs: 60_000 },
  )
  await claims.start()
  closers.push(() => claims.stop())
  const router = await startRouter({ root, port: 0, upstream: backend.url, hooks: runtime.hooks })
  closers.push(() => router.close(0))
  const socket = await open(router.baseUrl.replace('http', 'ws'), { 'thread-id': 'registered' })
  const done = until(socket, completed)
  socket.send('{"type":"response.create","model":"opus","tools":[{"name":"exec"}],"input":[]}')
  assert.ok((await done).some((frame) => frame.delta === 'CLAUDE'))
  const response = await fetch(`${router.baseUrl}/responses`, {
    method: 'POST',
    headers: { 'thread-id': 'registered' },
    body: '{"model":"opus","tools":[{"name":"exec"}],"input":[]}',
  })
  assert.match(await response.text(), /CLAUDE/)
})

test('http: GPT continuation is passed unchanged to the upstream', async () => {
  const { http, backend } = await setup(null)
  const body = '{"model":"gpt-6-sol","previous_response_id":"resp_ae_opaque","input":[] }'
  const response = await fetch(`${http}/responses`, { method: 'POST', body })
  assert.equal(response.status, 200)
  await response.text()
  assert.equal(backend.requests[0]?.raw.toString(), body)
})

test('http: Claude replay errors contain well-formed JSON even for a hostile response id', async () => {
  const { http } = await setup(null)
  const response = await fetch(`${http}/responses`, {
    method: 'POST',
    body: JSON.stringify({ model: 'opus', previous_response_id: 'resp_ae_\ud800', input: [] }),
  })
  assert.equal(response.status, 400)
  const body = (await response.json()) as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'previous_response_not_found')
  assert.ok(!body.error.message.includes('\ud800'), 'the replay error has no lone surrogate')
})

test('Claude counters: a completed sink is counted out while its handler is still settling', async () => {
  let finish = () => {}
  const settled = new Promise<void>((resolve) => {
    finish = resolve
  })
  const handler: ClaudeTurns = {
    mode: 'agent',
    run: async (_ctx, request) => {
      const stream = new ResponsesStream(request.sink, { model: 'opus' })
      stream.begin()
      stream.complete(usageObject())
      await settled
    },
  }
  const { ws, http, router } = await setup(handler)
  const socket = await open(ws)
  const done = until(socket, completed)
  socket.send('{"type":"response.create","model":"opus","tools":[{"name":"exec"}],"input":[]}')
  await done
  assert.equal(router.context.inflight.claude, 0)
  const response = await fetch(`${http}/responses`, {
    method: 'POST',
    body: '{"model":"opus","tools":[{"name":"exec"}],"input":[]}',
  })
  await response.text()
  assert.equal(router.context.inflight.claude, 0)
  finish()
})

test('Claude unavailable: its failure reaches Codex as a well-formed terminal event', async () => {
  const handler: ClaudeTurns = {
    mode: 'agent',
    run: async (_ctx, request) => {
      unavailable(request.sink, String(request.body.model), 'cannot run \ud800')
    },
  }
  const { ws, router } = await setup(handler)
  const socket = await open(ws)
  const done = until(socket, completed)
  socket.send('{"type":"response.create","model":"opus","tools":[{"name":"exec"}],"input":[]}')
  const frame = (await done).at(-1)
  assert.equal(frame?.type, 'response.failed')
  const response = frame?.response as { error: { message: string } }
  assert.equal(response.error.message, 'cannot run �')
  assert.equal(router.context.inflight.claude, 0)
})

test('ws: opaque binary data stays binary on both the response relay and another upgrade path', async () => {
  const upstream = await peer({ frame: (socket, data, binary) => socket.send(data, { binary }) })
  const { ws, router } = await setup(null, upstream.url)
  for (const path of ['/responses', '/realtime?intent=x']) {
    const socket = new WebSocket(`${ws}${path}`)
    closers.push(async () => socket.terminate())
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const answer = new Promise<{ data: Buffer; binary: boolean }>((resolve) => {
      socket.once('message', (data, binary) => resolve({ data: data as Buffer, binary }))
    })
    const data = Buffer.from([0, 255, 128, 13, 10, 33])
    socket.send(data)
    assert.deepEqual(await answer, { data, binary: true })
    assert.equal(router.context.inflight.gpt, 0)
  }
})

test('ws: neither response upgrades nor other tunnels send a bearer to an unverified TLS peer', async () => {
  const dir = await tempDir('anyengine-ws-tls-')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  )
  let served = 0
  const server = https.createServer({
    key: readFileSync(join(dir, 'key.pem')),
    cert: readFileSync(join(dir, 'cert.pem')),
  })
  server.on('upgrade', (_req, socket) => {
    served += 1
    socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const { ws, router } = await setup(null)
  router.context.upstream = () => `https://127.0.0.1:${address.port}/backend-api/codex`
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  try {
    for (const path of ['/responses', '/realtime']) {
      const socket = new WebSocket(`${ws}${path}`, {
        headers: { authorization: 'Bearer tls-test', 'x-codex-turn-metadata': meta('gpt-6-sol') },
      })
      const status = await new Promise<number | undefined>((resolve, reject) => {
        socket.once('unexpected-response', (_req, response) => {
          response.resume()
          resolve(response.statusCode)
          socket.terminate()
        })
        socket.once('error', (error) => reject(new Error(`${path}: ${error.message}`)))
      })
      assert.equal(status, 502)
    }
    // Lazy GPT connections must verify TLS as well.
    const socket = await open(ws)
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    socket.send('{"type":"response.create","model":"gpt-6-sol","input":[]}')
    await closed
  } finally {
    if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before
  }
  assert.equal(served, 0)
  assert.equal(router.context.inflight.gpt, 0)
})

test('ws: closing the router drains idle upgraded sockets within its grace period', async () => {
  const { ws, router } = await setup(null)
  const socket = await open(ws)
  let drained = false
  const closing = router.close(0).then(() => {
    drained = true
  })
  // An idle WS has no turn that could be allowed to extend a zero grace period.
  await Promise.race([closing, delay(1_000)])
  const result = drained
  socket.terminate()
  await closing
  assert.equal(result, true, 'router.close must not wait indefinitely for the thread socket')
})

test('ws: router shutdown releases GPT, Claude and raw tunnel sockets', async () => {
  const upstream = await peer()
  let signal: AbortSignal | undefined
  let finish = () => {}
  const settled = new Promise<void>((resolve) => {
    finish = resolve
  })
  const { ws, router } = await setup(
    {
      mode: 'agent',
      run: async (_ctx, request) => {
        signal = request.signal
        await settled
        request.sink.end()
      },
    },
    upstream.url,
  )
  const gpt = await open(ws)
  const claude = await open(ws)
  const raw = new WebSocket(`${ws}/realtime`)
  closers.push(async () => raw.terminate())
  await new Promise<void>((resolve, reject) => {
    raw.once('open', resolve)
    raw.once('error', reject)
  })
  gpt.send('{"type":"response.create","model":"gpt-6-sol","input":[]}')
  claude.send('{"type":"response.create","model":"opus","tools":[{"name":"exec"}],"input":[]}')
  await eventually(() => router.context.inflight.gpt === 1 && router.context.inflight.claude === 1)
  await router.close(0)
  await eventually(() => [gpt, claude, raw].every((s) => s.readyState === WebSocket.CLOSED))
  assert.deepEqual(router.context.inflight, { gpt: 0, claude: 0 })
  assert.equal(signal?.aborted, true)
  finish()
})

test('ws: a turn can finish during the router shutdown grace period', async () => {
  let finish = () => {}
  const settled = new Promise<void>((resolve) => {
    finish = resolve
  })
  const { ws, router } = await setup({
    mode: 'agent',
    run: async (_ctx, request) => {
      await settled
      const stream = new ResponsesStream(request.sink, { model: 'opus' })
      stream.begin()
      stream.textDelta('finished during drain')
      stream.complete(usageObject())
    },
  })
  const socket = await open(ws)
  const done = until(socket, completed)
  socket.send('{"type":"response.create","model":"opus","tools":[{"name":"exec"}],"input":[]}')
  await eventually(() => router.context.inflight.claude === 1)
  const closing = router.close(10_000)
  finish()
  assert.ok((await done).some((frame) => frame.delta === 'finished during drain'))
  socket.terminate()
  await closing
  assert.equal(router.context.inflight.claude, 0)
})
