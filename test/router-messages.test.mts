import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import nodeTest, { after, type TestContext } from 'node:test'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import type { AccountAdmission, BrokerLease, TokenBroker } from '../src/broker-types.mjs'
import type { GptCatalogs } from '../src/claude-catalog.mjs'
import type { GptModel } from '../src/claude-models.mjs'
import { MAX_BODY_BYTES } from '../src/router-relay.mjs'
import { type RunningRouter, startRouter } from '../src/router-server.mjs'
import { type FakeBackend, startFakeBackend } from './helpers/fake-backend.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const test = (name: string, run: (context: TestContext) => Promise<void>) =>
  nodeTest(name, { timeout: 30_000 }, run)
const load = () => import('../src/' + 'router-messages.mjs')
const CLAUDE_AUTH = 'FAKE-CLAUDE-ONLY'
const CLAUDE_KEY = 'FAKE-CLAUDE-API-ONLY'
const GPT_AUTH = 'FAKE-GPT-BROKER-ONLY'
const PRIVATE_SOURCE = 'private-source-fixture'
const PRIVATE_ACCOUNT = 'private-account-fixture'
const BODY_MARKER = 'CLAUDE_BODY_NEVER_OBSERVED'
const model: GptModel = {
  id: 'gpt-6.1-sol',
  label: 'GPT fixture',
  contextWindow: 272000,
  lite: false,
  efforts: ['low'],
}
const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${CLAUDE_AUTH}`,
  'x-api-key': CLAUDE_KEY,
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20,future-beta',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

interface WireAnswer {
  status: number
  headers: IncomingHttpHeaders
  rawHeaders: string[]
  body: Buffer
}

function wire(
  origin: string,
  input: {
    path?: string
    method?: string
    headers?: Record<string, string>
    body?: Buffer | undefined
  } = {},
): Promise<WireAnswer> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      origin,
      {
        path: input.path ?? '/v1/messages',
        method: input.method ?? 'POST',
        headers: input.headers ?? headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.once('error', reject)
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            rawHeaders: response.rawHeaders,
            body: Buffer.concat(chunks),
          }),
        )
      },
    )
    request.once('error', reject)
    request.end(input.body)
  })
}

interface Recorded {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: Buffer
}

function success(res: ServerResponse) {
  const item = {
    type: 'message',
    id: 'item_fixture',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'PONG', annotations: [] }],
  }
  const events = [
    { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: item.id, delta: 'PONG' },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'resp_fixture',
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [item],
        usage: { input_tokens: 8, output_tokens: 1 },
      },
    },
  ]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
}

async function fixture(t: TestContext) {
  const { messagesHook } = await load()
  const root = await tempDir('rm-')
  let router: RunningRouter | null = null
  let gpt: FakeBackend | null = null
  let anthropic: http.Server | null = null
  t.after(async () => {
    await router?.close(0)
    if (anthropic) {
      anthropic.closeAllConnections()
      await new Promise<void>((done) => anthropic?.close(() => done()))
    }
    await gpt?.close()
  })
  const captured: Recorded[] = []
  const state = {
    available: true,
    lease: {
      bearer: GPT_AUTH,
      accountId: PRIVATE_ACCOUNT,
      generation: 1,
      sourceId: PRIVATE_SOURCE,
      sourceRevision: 7,
      cacheRevision: 13,
    } satisfies BrokerLease,
    models: [model] as readonly GptModel[],
    gets: 0,
    catalogGets: 0,
    admissions: 0,
    releases: 0,
    observers: 0,
    admissionGate: null as Promise<{ generation: number; release(): Promise<void> }> | null,
    admissionEntered: deferred<void>(),
    respond: (_request: Recorded, response: ServerResponse) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ type: 'message', content: [{ type: 'text', text: BODY_MARKER }] }),
      )
    },
  }
  const broker: TokenBroker = {
    get: async () => {
      state.gets++
      if (!state.available) throw new Error(`broker.auth-failed ${GPT_AUTH}`)
      return state.lease
    },
    isCurrent: (lease) => state.available && lease === state.lease,
    invalidate: () => {},
    close: async () => {},
    status: () => ({
      ready: state.available,
      source: 'adapter',
      generation: state.lease.generation,
      reason: state.available ? null : 'broker.auth-failed',
    }),
  }
  const admission: AccountAdmission = {
    begin: async () => {
      state.admissions++
      state.admissionEntered.resolve()
      if (state.admissionGate) return state.admissionGate
      return {
        generation: state.lease.generation,
        release: async () => {
          state.releases++
        },
      }
    },
  }
  const catalogs: GptCatalogs = {
    get: async (lease, signal) => {
      state.catalogGets++
      assert.equal(signal.aborted, false)
      return {
        generation: lease.generation,
        sourceId: lease.sourceId,
        sourceRevision: lease.sourceRevision,
        cacheRevision: lease.cacheRevision,
        fetchedAt: 4242,
        models: state.models,
      }
    },
    invalidate: () => {},
  }
  anthropic = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.once('end', () => {
      const record = {
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks),
      }
      captured.push(record)
      state.respond(record, response)
    })
  })
  await new Promise<void>((done) => anthropic?.listen(0, '127.0.0.1', done))
  const address = anthropic.address()
  assert.ok(address && typeof address === 'object')
  const anthropicOrigin = `http://127.0.0.1:${address.port}`
  gpt = await startFakeBackend()
  gpt.respond = (_request, response) => success(response)
  const deps = { broker, admission, catalogs, anthropicOrigin, gptOrigin: new URL(gpt.url).origin }
  const hooks = {
    messages: messagesHook(deps),
    observeGptBody: () => {
      state.observers++
    },
    observeUpstreamError: () => {
      state.observers++
    },
  }
  router = await startRouter({ root, port: 0, upstream: gpt.url, hooks })
  return {
    root,
    router,
    origin: new URL(router.baseUrl).origin,
    captured,
    state,
    deps,
    gpt,
    messagesHook,
  }
}

function noCredentials(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const secret of [CLAUDE_AUTH, CLAUDE_KEY, GPT_AUTH, PRIVATE_ACCOUNT, PRIVATE_SOURCE]) {
    assert.equal(text.includes(secret), false, `public value contains ${secret}`)
  }
}

test('Claude Messages retain exact entity bytes, query and end-to-end credential headers', async (t) => {
  const f = await fixture(t)
  const raw = Buffer.from('{ "model" : "claude-opus-5-5", "messages":[], "future": {"n":1} }\n')
  const upstreamBody = Buffer.from(` { "future": "${BODY_MARKER}", "spaces": [ 1, 2 ] }\n`)
  f.state.respond = (_request, response) => {
    response.writeHead(201, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    })
    response.end(upstreamBody)
  }
  const answer = await wire(f.origin, {
    path: '/v1/messages?beta=true&future=%2F',
    body: raw,
    headers: { ...headers, 'x-future-header': 'keep-exact' },
  })
  assert.equal(answer.status, 201)
  assert.deepEqual(answer.body, upstreamBody)
  assert.equal(answer.headers['anthropic-ratelimit-unified-5h-status'], 'allowed')
  assert.equal(f.captured[0]?.path, '/v1/messages?beta=true&future=%2F')
  assert.deepEqual(f.captured[0]?.body, raw)
  assert.equal(f.captured[0]?.headers.authorization, `Bearer ${CLAUDE_AUTH}`)
  assert.equal(f.captured[0]?.headers['x-api-key'], CLAUDE_KEY)
  assert.equal(f.captured[0]?.headers['anthropic-beta'], headers['anthropic-beta'])
  assert.equal(f.captured[0]?.headers['x-future-header'], 'keep-exact')
  assert.equal(f.state.gets, 0)
  assert.equal(f.state.admissions, 0)
  assert.equal(f.state.observers, 0)
  assert.equal(f.gpt.requests.length, 0)
})

test('gzip, Brotli and identity Claude bodies are routed from a copy and relayed unchanged', async (t) => {
  const f = await fixture(t)
  const raw = Buffer.from('{ "model": "claude-future", "messages":[], "unknown":"é" }\n')
  for (const [encoding, body] of [
    ['gzip', gzipSync(raw)],
    ['br', brotliCompressSync(raw)],
    ['identity', raw],
  ] as const) {
    const answer = await wire(f.origin, {
      body,
      headers: { ...headers, 'content-encoding': encoding },
    })
    assert.equal(answer.status, 200)
    assert.deepEqual(f.captured.at(-1)?.body, body)
    assert.equal(f.captured.at(-1)?.headers['content-encoding'], encoding)
  }
  assert.equal(f.state.gets, 0)
  assert.equal(f.state.observers, 0)
})

test('missing or unknown non-GPT models and malformed JSON belong to Anthropic unchanged', async (t) => {
  const f = await fixture(t)
  const bodies = [
    Buffer.from('{ "model":"unreleased-engine", "future":true }\n'),
    Buffer.from('{ "messages":[], "future":true }\n'),
    Buffer.from('{"model":"gpt-6.1-sol",'),
    Buffer.from('["not","an","object"]'),
    Buffer.from('{"model":42}'),
    Buffer.from([0xff, 0x00, 0x7b]),
    Buffer.concat([
      Buffer.from('{"model":"gpt-6.1-sol","future":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]),
  ]
  for (const body of bodies) {
    await wire(f.origin, { body })
    assert.deepEqual(f.captured.at(-1)?.body, body)
  }
  assert.equal(f.captured.length, bodies.length)
  assert.equal(f.state.gets, 0)
  assert.equal(f.gpt.requests.length, 0)
})

test('HEAD, unknown Anthropic paths and Claude count_tokens preserve methods, queries and bytes', async (t) => {
  const f = await fixture(t)
  const head = await wire(f.origin, { method: 'HEAD', path: '/api/hello?beta=true' })
  assert.equal(head.status, 200)
  assert.equal(head.body.length, 0)
  assert.equal(f.captured[0]?.method, 'HEAD')
  assert.equal(f.captured[0]?.path, '/api/hello?beta=true')
  const raw = Buffer.from('{ "model":"claude-future", "messages":[], "future":false }\n')
  await wire(f.origin, { path: '/v1/messages/count_tokens?future=1', body: raw })
  assert.deepEqual(f.captured.at(-1)?.body, raw)
  await wire(f.origin, { method: 'PATCH', path: '/v1/future-endpoint?q=%3F', body: raw })
  assert.equal(f.captured.at(-1)?.method, 'PATCH')
  assert.equal(f.captured.at(-1)?.path, '/v1/future-endpoint?q=%3F')
  assert.deepEqual(f.captured.at(-1)?.body, raw)
  assert.equal(f.state.gets, 0)
})

test('Claude SSE bytes and duplicate rate-limit headers preserve values and order', async (t) => {
  const f = await fixture(t)
  const raw = Buffer.from(
    `: comment\r\nevent: content_block_delta\r\ndata: { "text":"é ${BODY_MARKER}" }\r\n\r\nevent: message_stop\ndata: {}\n\n`,
  )
  f.state.respond = (_request, response) => {
    response.writeHead(200, [
      'Content-Type',
      'text/event-stream',
      'Anthropic-Ratelimit-Unified-5h-Status',
      'allowed',
      'anthropic-ratelimit-unified-5h-status',
      'restricted',
      'Set-Cookie',
      'fixture=one',
      'Set-Cookie',
      'fixture=two',
    ])
    response.end(raw)
  }
  const answer = await wire(f.origin, {
    body: Buffer.from('{"model":"claude-opus-5-5","stream":true}'),
  })
  assert.deepEqual(answer.body, raw)
  const selected: string[] = []
  for (let i = 0; i < answer.rawHeaders.length; i += 2) {
    if (answer.rawHeaders[i]?.toLowerCase() === 'anthropic-ratelimit-unified-5h-status')
      selected.push(answer.rawHeaders[i] ?? '', answer.rawHeaders[i + 1] ?? '')
  }
  assert.deepEqual(selected, [
    'Anthropic-Ratelimit-Unified-5h-Status',
    'allowed',
    'anthropic-ratelimit-unified-5h-status',
    'restricted',
  ])
  assert.deepEqual(answer.headers['set-cookie'], ['fixture=one', 'fixture=two'])
  assert.equal(f.state.observers, 0)
})

test('Claude 401 and 429 pass through without GPT error observers or body logging', async (t) => {
  const f = await fixture(t)
  for (const status of [401, 429]) {
    const body = Buffer.from(`{ "type":"error", "message":"${BODY_MARKER}" }\n`)
    f.state.respond = (_request, response) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'retry-after': '15',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
      })
      response.end(body)
    }
    const answer = await wire(f.origin, { body: Buffer.from('{"model":"claude-future"}') })
    assert.equal(answer.status, status)
    assert.equal(answer.headers['retry-after'], '15')
    assert.deepEqual(answer.body, body)
  }
  assert.equal(f.state.observers, 0)
  const log = existsSync(f.router.context.log.path)
    ? readFileSync(f.router.context.log.path, 'utf8')
    : ''
  assert.equal(log.includes(BODY_MARKER), false)
  noCredentials(log)
})

test('Anthropic redirects are returned unchanged and never followed', async (t) => {
  const f = await fixture(t)
  const location = `${f.deps.anthropicOrigin}/must-not-follow`
  f.state.respond = (_request, response) => {
    response.writeHead(307, { location })
    response.end('redirect body')
  }
  const answer = await wire(f.origin, { body: Buffer.from('{"model":"claude-future"}') })
  assert.equal(answer.status, 307)
  assert.equal(answer.headers.location, location)
  assert.equal(answer.body.toString(), 'redirect body')
  assert.equal(f.captured.length, 1)
})

test('Messages and control models obey the existing browser/Host gate before touching providers', async (t) => {
  const f = await fixture(t)
  for (const path of ['/v1/messages', '/control/claude-code/models']) {
    for (const extra of [
      { origin: 'https://page.invalid' },
      { origin: 'null' },
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-dest': 'empty' },
      { host: 'foreign.invalid' },
    ]) {
      const answer = await wire(f.origin, {
        path,
        method: path.startsWith('/control') ? 'GET' : 'POST',
        body: path.startsWith('/control') ? undefined : Buffer.from('{"model":"gpt-6.1-sol"}'),
        headers: { ...headers, ...extra },
      })
      assert.equal(answer.status, 403)
    }
  }
  assert.equal(f.captured.length, 0)
  assert.equal(f.gpt.requests.length, 0)
  assert.equal(f.state.gets, 0)
  assert.equal(f.state.admissions, 0)
})

test('absolute-form and cross-origin request targets cannot relay Claude credentials', async (t) => {
  const f = await fixture(t)
  for (const path of ['http://foreign.invalid/v1/messages', '//foreign.invalid/v1/messages']) {
    const answer = await wire(f.origin, { path, body: Buffer.from('{"model":"claude-future"}') })
    assert.equal(answer.status, 400)
  }
  assert.equal(f.captured.length, 0)
  assert.equal(f.gpt.requests.length, 0)
})

test('the Messages face leaves Codex, health and unrecognized control routes with their owners', async (t) => {
  const f = await fixture(t)
  const raw = Buffer.from('{ "model":"gpt-wire", "input":[] }\n')
  const codex = await wire(f.origin, {
    path: '/backend-api/codex/responses?future=true',
    body: raw,
  })
  assert.equal(codex.status, 200)
  assert.deepEqual(f.gpt.requests[0]?.raw, raw)
  assert.equal(f.gpt.requests[0]?.query, '?future=true')
  const health = await wire(f.origin, { path: '/health', method: 'GET', headers: {} })
  assert.equal(health.status, 200)
  noCredentials(health.body.toString())
  const control = await wire(f.origin, { path: '/control/unknown', method: 'GET' })
  assert.equal(control.status, 404)
  assert.equal(f.captured.length, 0)
  assert.equal(f.state.gets, 0)
})

test('known GPT uses the broker bearer and sends no Anthropic or caller credential headers', async (t) => {
  const f = await fixture(t)
  const answer = await wire(f.origin, {
    body: Buffer.from(
      JSON.stringify({
        model: model.id,
        max_tokens: 16,
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ),
    headers: { ...headers, cookie: 'fixture-private-cookie', 'x-future-credential': CLAUDE_AUTH },
  })
  assert.equal(answer.status, 200)
  assert.equal(JSON.parse(answer.body.toString()).model, model.id)
  assert.ok(answer.body.includes(Buffer.from('PONG')))
  assert.equal(f.captured.length, 0)
  const request = f.gpt.requests[0]
  assert.ok(request)
  assert.equal(request.headers.authorization, `Bearer ${GPT_AUTH}`)
  assert.equal(request.headers['chatgpt-account-id'], PRIVATE_ACCOUNT)
  for (const name of [
    'x-api-key',
    'anthropic-beta',
    'anthropic-version',
    'cookie',
    'x-future-credential',
  ])
    assert.equal(request.headers[name], undefined, name)
  assert.equal(f.state.admissions, 1)
  assert.equal(f.state.releases, 1)
  noCredentials(answer.body.toString())
})

test('unknown GPT is a local invalid request, while broker degradation leaves Claude usable', async (t) => {
  const f = await fixture(t)
  const message = (id: string) =>
    Buffer.from(
      JSON.stringify({ model: id, max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }),
    )
  const unknown = await wire(f.origin, { body: message('gpt-missing') })
  assert.equal(unknown.status, 400)
  assert.equal(f.gpt.requests.length, 0)
  assert.equal(f.captured.length, 0)
  f.state.available = false
  const unavailable = await wire(f.origin, { body: message(model.id) })
  assert.equal(unavailable.status, 503)
  noCredentials(unavailable.body.toString())
  const claude = await wire(f.origin, { body: message('claude-future') })
  assert.equal(claude.status, 200)
  assert.equal(f.captured.length, 1)
  const health = await wire(f.origin, { path: '/health', method: 'GET', headers: {} })
  assert.equal(health.status, 200)
  noCredentials(health.body.toString())
  const log = existsSync(f.router.context.log.path)
    ? readFileSync(f.router.context.log.path, 'utf8')
    : ''
  noCredentials(log)
})

test('GPT count_tokens is a deterministic local UTF-8/image estimate with no provider requests', async (t) => {
  const f = await fixture(t)
  for (const [content, expected] of [
    ['', 1],
    ['abcdef', 2],
    ['é🐈', 2],
  ] as const) {
    const body = Buffer.from(
      JSON.stringify({ model: model.id, messages: [{ role: 'user', content }] }),
    )
    const answer = await wire(f.origin, { path: '/v1/messages/count_tokens', body })
    assert.equal(answer.status, 200)
    assert.deepEqual(JSON.parse(answer.body.toString()), { input_tokens: expected })
  }
  const blocks = [
    { type: 'text', text: 'abcdef' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture-image' } },
  ]
  const body = Buffer.from(
    JSON.stringify({ model: model.id, messages: [{ role: 'user', content: blocks }] }),
  )
  const answer = await wire(f.origin, { path: '/v1/messages/count_tokens', body })
  assert.deepEqual(JSON.parse(answer.body.toString()), { input_tokens: 1026 })
  const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
  const toolBody = Buffer.from(
    JSON.stringify({
      model: model.id,
      messages: [],
      tools: [{ name: 'Lookup', input_schema: schema }],
    }),
  )
  const first = await wire(f.origin, { path: '/v1/messages/count_tokens', body: toolBody })
  const second = await wire(f.origin, { path: '/v1/messages/count_tokens', body: toolBody })
  assert.ok(
    JSON.parse(first.body.toString()).input_tokens >=
      Math.ceil(Buffer.byteLength(JSON.stringify(schema)) / 3),
  )
  assert.deepEqual(first.body, second.body)
  assert.equal(f.captured.length, 0)
  assert.equal(f.gpt.requests.length, 0)
})

test('control models waits for admission and returns only credential-free settings fields', async (t) => {
  const f = await fixture(t)
  const gate = deferred<{ generation: number; release(): Promise<void> }>()
  f.state.admissionGate = gate.promise
  const pending = wire(f.origin, { path: '/control/claude-code/models', method: 'GET' })
  void pending.catch(() => {})
  await f.state.admissionEntered.promise
  assert.equal(f.state.gets, 0)
  assert.equal(f.state.catalogGets, 0)
  gate.resolve({
    generation: 1,
    release: async () => {
      f.state.releases++
    },
  })
  const answer = await pending
  assert.equal(answer.status, 200)
  const view = JSON.parse(answer.body.toString())
  assert.deepEqual(Object.keys(view).sort(), ['fetchedAt', 'generation', 'models'])
  assert.deepEqual(view, { generation: 1, fetchedAt: 4242, models: [model] })
  noCredentials(answer.body.toString())
  assert.equal(f.state.releases, 1)
  assert.equal(f.captured.length, 0)
})

test('a settings view does not authorize a GPT model after the admitted account changes', async (t) => {
  const f = await fixture(t)
  const settings = await wire(f.origin, { path: '/control/claude-code/models', method: 'GET' })
  assert.equal(JSON.parse(settings.body.toString()).models[0].id, model.id)
  f.state.lease = { ...f.state.lease, generation: 2, cacheRevision: 14 }
  f.state.models = []
  const answer = await wire(f.origin, {
    body: Buffer.from(
      JSON.stringify({
        model: model.id,
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 16,
      }),
    ),
  })
  assert.equal(answer.status, 400)
  assert.equal(f.gpt.requests.length, 0)
  assert.equal(f.captured.length, 0)
  assert.equal(f.state.admissions, 2)
  assert.equal(f.state.releases, 2)
})

test('control model unavailability is 503 and cannot masquerade as an empty successful catalog', async (t) => {
  const f = await fixture(t)
  f.state.available = false
  const answer = await wire(f.origin, { path: '/control/claude-code/models', method: 'GET' })
  assert.equal(answer.status, 503)
  noCredentials(answer.body.toString())
  assert.notDeepEqual(JSON.parse(answer.body.toString()), { models: [] })
  assert.equal(f.state.releases, 1)
  assert.equal(f.captured.length, 0)
})

test('a declared oversized Messages body is refused before any upstream request', async (t) => {
  const f = await fixture(t)
  const answer = await wire(f.origin, {
    body: Buffer.from('{}'),
    headers: { ...headers, 'content-length': String(MAX_BODY_BYTES + 1), connection: 'close' },
  })
  assert.equal(answer.status, 413)
  assert.equal(f.captured.length, 0)
  assert.equal(f.gpt.requests.length, 0)
  assert.equal(f.state.gets, 0)
})

test('a disconnected Claude stream closes its actual upstream response', async (t) => {
  const f = await fixture(t)
  const ended = deferred<void>()
  f.state.respond = (_request, response) => {
    response.once('close', () => ended.resolve())
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('event: ping\ndata: {}\n\n')
  }
  const request = http.request(f.origin, {
    path: '/v1/messages',
    method: 'POST',
    headers,
    agent: false,
  })
  request.on('error', () => {})
  const response = await new Promise<http.IncomingMessage>((done) => {
    request.once('response', done)
    request.end('{"model":"claude-future","stream":true}')
  })
  response.on('error', () => {})
  response.destroy()
  request.destroy()
  await ended.promise
  assert.equal(f.captured.length, 1)
  assert.equal(f.state.observers, 0)
})

test('explicit test origins reject foreign hosts, credentials and non-origin URLs', async (t) => {
  const f = await fixture(t)
  for (const bad of [
    'https://foreign.invalid',
    'http://127.0.0.1@foreign.invalid',
    'http://fixture:dummy@127.0.0.1:1',
    'http://127.0.0.1:1/path',
    'http://127.0.0.1:1?query=1',
  ]) {
    assert.throws(() => f.messagesHook({ ...f.deps, anthropicOrigin: bad }))
    assert.throws(() => f.messagesHook({ ...f.deps, gptOrigin: bad }))
  }
})

test('the control client consumes only the admitted model settings view from the router base URL', async (t) => {
  const { fetchGptSettingsView } = await load()
  assert.equal(typeof fetchGptSettingsView, 'function')
  const f = await fixture(t)
  f.state.lease = { ...f.state.lease, generation: 0 }
  const view = await fetchGptSettingsView(f.router.baseUrl, new AbortController().signal)
  assert.deepEqual(view, { generation: 0, fetchedAt: 4242, models: [model] })
  noCredentials(view)
  assert.equal(f.state.admissions, 1)
  assert.equal(f.state.releases, 1)
  assert.equal(f.captured.length, 0)
  assert.equal(f.gpt.requests.length, 0)
})

test('the control client reports 503 as a sanitized preflight failure', async (t) => {
  const { fetchGptSettingsView } = await load()
  assert.equal(typeof fetchGptSettingsView, 'function')
  const f = await fixture(t)
  f.state.available = false
  await assert.rejects(
    fetchGptSettingsView(f.router.baseUrl, new AbortController().signal),
    (cause: unknown) => {
      assert.ok(cause instanceof Error)
      noCredentials(cause.message)
      assert.match(cause.message, /models-unavailable/)
      return true
    },
  )
  assert.equal(f.state.releases, 1)
})

test('the control client refuses redirects and malformed or oversized catalog bodies', async (t) => {
  const { fetchGptSettingsView } = await load()
  assert.equal(typeof fetchGptSettingsView, 'function')
  let received = 0
  let reply = (response: ServerResponse) => {
    response.writeHead(307, { location: 'http://127.0.0.1:1/must-not-follow' })
    response.end('private redirect fixture')
  }
  const server = http.createServer((request, response) => {
    received++
    assert.equal(request.url, '/control/claude-code/models')
    assert.equal(request.method, 'GET')
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.headers['x-api-key'], undefined)
    reply(response)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}/backend-api/codex`
  const fails = () =>
    assert.rejects(fetchGptSettingsView(base, new AbortController().signal), /models-unavailable/)
  await fails()
  assert.equal(received, 1)
  for (const body of [
    Buffer.from('{ malformed'),
    Buffer.from(
      JSON.stringify({ generation: 1, fetchedAt: 4242, models: [{ ...model, lite: null }] }),
    ),
    Buffer.alloc(1024 * 1024 + 1, 32),
  ]) {
    reply = (response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
    }
    await fails()
  }
  assert.equal(received, 4)
})

test('the control client rejects foreign destinations and pre-aborted reads without provider I/O', async (t) => {
  const { fetchGptSettingsView } = await load()
  assert.equal(typeof fetchGptSettingsView, 'function')
  const f = await fixture(t)
  for (const bad of [
    'https://foreign.invalid/backend-api/codex',
    'http://127.0.0.1@foreign.invalid/backend-api/codex',
    `${f.origin}/other`,
    `${f.origin}/backend-api/codex?private=fixture`,
  ])
    await assert.rejects(
      fetchGptSettingsView(bad, new AbortController().signal),
      /models-unavailable/,
    )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(fetchGptSettingsView(f.router.baseUrl, controller.signal), /request-aborted/)
  assert.equal(f.state.admissions, 0)
  assert.equal(f.state.gets, 0)
  assert.equal(f.captured.length, 0)
  assert.equal(f.gpt.requests.length, 0)
})
