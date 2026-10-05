import assert from 'node:assert/strict'
import http, { type ServerResponse } from 'node:http'
import test, { after, type TestContext } from 'node:test'
import type {
  AccountAdmission,
  AuthSource,
  BrokerLease,
  BrokerOwner,
  TokenBroker,
} from '../src/broker-types.mjs'
import { createGptCatalogs } from '../src/claude-catalog.mjs'
import type { Obj } from '../src/vendor/claude-code-proxy/types.mjs'
import { gptEntry, startFakeBackend } from './helpers/fake-backend.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const load = () => import('../src/' + 'claude-gpt.mjs')
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const request: Obj = {
  model: 'gpt-shared',
  stream: true,
  messages: [{ role: 'user', content: 'Read marker.txt' }],
  tools: [
    {
      name: 'Read',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
    },
  ],
}
const output = {
  id: 'msg-fake',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'MARKER-42', annotations: [] }],
}
function pong(res: ServerResponse, terminal = true) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`)
  send({ type: 'response.created', response: { id: 'response-fake' } })
  send({ type: 'response.output_item.added', output_index: 0, item: { ...output, content: [] } })
  send({ type: 'response.output_text.delta', output_index: 0, delta: 'MARKER-42' })
  if (terminal) {
    send({ type: 'response.output_item.done', output_index: 0, item: output })
    send({
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [output],
        usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 75 }, output_tokens: 8 },
      },
    })
    res.end()
  }
}

async function fixture(t: TestContext) {
  const { serveGpt } = await load()
  const root = await tempDir('gt-')
  const backend = await startFakeBackend()
  t.after(() => backend.close())
  backend.models = [
    gptEntry('gpt-shared', 1, { use_responses_lite: true }),
    gptEntry('gpt-a-only', 2, { use_responses_lite: true }),
  ]
  backend.respond = (_req, res) => pong(res)
  let lease: BrokerLease = {
    bearer: 'FAKE_BROKER_ONLY_A',
    accountId: 'acct-fixture-A',
    generation: 1,
    sourceId: 'A',
    sourceRevision: 1,
    cacheRevision: 1,
  }
  const changes = new Set<Parameters<BrokerOwner['onChange']>[0]>()
  const source = (): AuthSource => ({
    id: lease.sourceId,
    home: '/fixture',
    generation: lease.generation,
    request: async () => ({ authMethod: null, authToken: null, requiresOpenaiAuth: true }),
  })
  const owner: BrokerOwner = {
    current: () => ({ revision: lease.sourceRevision, source: source() }),
    source: async () => ({ revision: lease.sourceRevision, source: source() }),
    onChange: (listener) => {
      changes.add(listener)
      return () => changes.delete(listener)
    },
    stopSources: async () => {},
    close: async () => {},
  }
  const gets: (BrokerLease | undefined)[] = []
  let refresh = () => {},
    brokerError: Error | null = null
  const broker: TokenBroker = {
    async get(options) {
      gets.push(options?.rejected)
      if (brokerError) throw brokerError
      if (options?.rejected) refresh()
      return lease
    },
    isCurrent: (value) => value === lease,
    invalidate: () => {},
    close: async () => {},
    status: () => ({ ready: true, source: 'adapter', generation: lease.generation, reason: null }),
  }
  let active = 0,
    releases = 0,
    gate: Promise<void> | null = null
  const admitting = deferred<void>()
  const released = deferred<void>()
  let releaseTarget = 1
  const quotas: Array<{ generation: number; model: string }> = []
  const admission: AccountAdmission = {
    quota: (lease, model) => {
      quotas.push({ generation: lease.generation, model })
    },
    async begin(signal) {
      admitting.resolve()
      if (gate) await gate
      if (signal?.aborted) throw new Error('broker.request-aborted')
      active++
      return {
        generation: lease.generation,
        release: async () => {
          releases++
          active--
          if (releases >= releaseTarget) released.resolve()
        },
      }
    },
  }
  const catalogs = createGptCatalogs({ broker, owner, root, upstream: new URL(backend.url) })
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Obj
      void serveGpt({
        req,
        res,
        body,
        requestedModel: String(body.model),
        broker,
        catalogs,
        admission,
        upstream: new URL(backend.url),
        signal: new AbortController().signal,
      }).catch(() => res.destroy())
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    backend,
    quotas,
    gets,
    admitting,
    released,
    active: () => active,
    releases: () => releases,
    releaseTarget: (count: number) => {
      releaseTarget = count
    },
    freeze: (promise: Promise<void>) => {
      gate = promise
    },
    refresh: (next: () => void) => {
      refresh = next
    },
    brokerError: (next: Error) => {
      brokerError = next
    },
    elect(id: string, generation = lease.generation) {
      lease = {
        bearer: `FAKE_BROKER_ONLY_${id}`,
        accountId: `acct-fixture-${id}`,
        generation,
        sourceId: id,
        sourceRevision: lease.sourceRevision + 1,
        cacheRevision: lease.cacheRevision + 1,
      }
      for (const listener of changes) listener(owner.current())
    },
    post: (body: Obj = request, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${address.port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    modelCalls: () => backend.requests.filter((call) => call.path.endsWith('/responses')),
  }
}

test('transport injects only broker auth, honors the Lite lane and returns authoritative streamed usage', async (t) => {
  const f = await fixture(t)
  const response = await f.post(
    { ...request, model: 'gpt-shared[1m]' },
    {
      authorization: 'Bearer FAKE_CLAUDE_ONLY',
      'x-api-key': 'FAKE_CLAUDE_API_KEY',
      cookie: 'FAKE_COOKIE',
      'anthropic-beta': 'fake-beta',
      'proxy-authorization': 'FAKE_PROXY',
    },
  )
  assert.equal(response.status, 200)
  const text = await response.text()
  await f.released.promise
  assert.equal(f.releases(), 1)
  assert.equal(f.active(), 0)
  assert.ok(text.includes('gpt-shared[1m]'))
  assert.ok(text.includes('MARKER-42'))
  assert.ok(text.includes('"cache_read_input_tokens":75'))
  assert.ok(text.includes('"input_tokens":25'))
  const [call] = f.modelCalls()
  assert.ok(call)
  assert.equal(call.headers.authorization, 'Bearer FAKE_BROKER_ONLY_A')
  assert.equal(call.headers['chatgpt-account-id'], 'acct-fixture-A')
  assert.equal(call.headers['x-openai-internal-codex-responses-lite'], 'true')
  for (const header of ['x-api-key', 'cookie', 'anthropic-beta', 'proxy-authorization'])
    assert.equal(call.headers[header], undefined)
  assert.equal(JSON.stringify(call.headers).includes('FAKE_CLAUDE'), false)
  const translated = JSON.parse(call.raw.toString('utf8'))
  assert.equal(translated.model, 'gpt-shared')
  assert.equal(translated.store, false)
  assert.equal(translated.input[0]?.type, 'additional_tools')
})

test('nonstreaming input returns one Anthropic message with the same content and final usage', async (t) => {
  const f = await fixture(t)
  const response = await f.post({ ...request, stream: false })
  assert.equal(response.status, 200)
  const value = (await response.json()) as {
    type: string
    content: { text: string }[]
    stop_reason: string
    usage: unknown
  }
  await f.released.promise
  assert.equal(value.type, 'message')
  assert.equal(value.content[0]?.text, 'MARKER-42')
  assert.equal(value.stop_reason, 'end_turn')
  assert.deepEqual(value.usage, {
    input_tokens: 25,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 75,
    output_tokens: 8,
  })
  assert.equal(f.releases(), 1)
})

for (const requested of ['gpt-a-only', 'gpt-shared']) {
  test(`frozen request performs no I/O and resolves ${requested} only against admitted B`, async (t) => {
    const f = await fixture(t)
    const thaw = deferred<void>()
    f.freeze(thaw.promise)
    const pending = f.post({ ...request, model: requested })
    await f.admitting.promise
    assert.equal(f.gets.length, 0)
    assert.equal(f.backend.requests.length, 0)
    f.elect('B', 2)
    f.backend.models = [gptEntry('gpt-shared', 1, { use_responses_lite: false })]
    thaw.resolve()
    const response = await pending
    const text = await response.text()
    await f.released.promise
    assert.equal(response.status, requested === 'gpt-a-only' ? 400 : 200)
    assert.equal(f.modelCalls().length, requested === 'gpt-a-only' ? 0 : 1)
    assert.equal(f.releases(), 1)
    if (requested === 'gpt-shared') {
      const call = f.modelCalls()[0]
      assert.ok(call)
      assert.equal(call.headers.authorization, 'Bearer FAKE_BROKER_ONLY_B')
      assert.equal(call.headers['chatgpt-account-id'], 'acct-fixture-B')
      assert.equal(call.headers['x-openai-internal-codex-responses-lite'], undefined)
      assert.ok(Array.isArray(JSON.parse(call.raw.toString('utf8')).tools))
    } else assert.ok(text.includes('unsupported_model'))
  })
}

test('one pre-output 401 reacquires source, catalog and lane under the original admission', async (t) => {
  const f = await fixture(t)
  f.backend.respond = (_req, res) => {
    if (f.modelCalls().length === 1) {
      res.writeHead(401)
      res.end('{}')
    } else pong(res)
  }
  f.refresh(() => {
    f.elect('B')
    f.backend.models = [gptEntry('gpt-shared', 1, { use_responses_lite: false })]
  })
  const response = await f.post()
  assert.equal(response.status, 200)
  await response.text()
  await f.released.promise
  assert.equal(f.modelCalls().length, 2)
  assert.equal(f.gets.filter(Boolean).length, 1)
  const second = f.modelCalls()[1]
  assert.ok(second)
  assert.equal(second.headers.authorization, 'Bearer FAKE_BROKER_ONLY_B')
  assert.equal(second.headers['x-openai-internal-codex-responses-lite'], undefined)
  assert.ok(Array.isArray(JSON.parse(second.raw.toString('utf8')).tools))
  assert.equal(f.releases(), 1)
})

test('401 twice is authentication failure and generation change during retry sends no B model bytes', async (t) => {
  for (const changeGeneration of [false, true]) {
    const f = await fixture(t)
    f.backend.respond = (_req, res) => {
      res.writeHead(401)
      res.end('{"error":{"message":"FAKE_SECRET"}}')
    }
    f.refresh(() => f.elect('B', changeGeneration ? 2 : 1))
    const response = await f.post()
    const text = await response.text()
    await f.released.promise
    assert.equal(response.status, changeGeneration ? 503 : 401)
    assert.equal(f.modelCalls().length, changeGeneration ? 1 : 2)
    assert.equal(f.gets.filter(Boolean).length, 1)
    assert.equal(text.includes('FAKE_SECRET'), false)
    assert.equal(f.releases(), 1)
  }
})

for (const [status, code, expected] of [
  [429, 'usage_limit_reached', 429],
  [429, 'rate_limit_exceeded', 429],
  [400, 'context_length_exceeded', 400],
  [403, 'permission_denied', 403],
  [529, 'overloaded_error', 529],
] as const) {
  test(`HTTP ${status} preserves safe ${code} semantics without retry`, async (t) => {
    const f = await fixture(t)
    f.backend.respond = (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '15' })
      res.end(JSON.stringify({ error: { code, message: 'FAKE_SECRET_CONTEXT' } }))
    }
    const response = await f.post()
    const text = await response.text()
    await f.released.promise
    assert.equal(response.status, expected)
    if (status === 429) assert.equal(response.headers.get('retry-after'), '15')
    assert.deepEqual(
      f.quotas,
      code === 'usage_limit_reached' ? [{ generation: 1, model: 'gpt-shared' }] : [],
    )
    assert.equal(text.includes('FAKE_SECRET'), false)
    assert.equal(f.modelCalls().length, 1)
    assert.equal(f.releases(), 1)
  })
}

test('EOF after content emits one SSE error without message_stop or replay', async (t) => {
  const f = await fixture(t)
  f.backend.respond = (_req, res) => {
    pong(res, false)
    res.end()
  }
  const response = await f.post()
  const text = await response.text()
  await f.released.promise
  assert.equal(response.status, 200)
  assert.ok(text.includes('incomplete_stream'))
  assert.equal(text.includes('event: message_stop'), false)
  assert.equal((text.match(/event: error/g) ?? []).length, 1)
  assert.equal(f.modelCalls().length, 1)
  assert.equal(f.releases(), 1)
})

test('pre-header broker failure releases once and returns no model or credential details', async (t) => {
  const f = await fixture(t)
  f.brokerError(new Error('broker.login-required'))
  const response = await f.post()
  const text = await response.text()
  await f.released.promise
  assert.equal(response.status, 401)
  assert.ok(text.includes('Run codex login'))
  assert.equal(f.backend.requests.length, 0)
  assert.equal(f.releases(), 1)
  assert.equal(text.includes('acct-fixture'), false)
})

test('seven open streams retain seven admissions until each client disconnect joins upstream', async (t) => {
  const f = await fixture(t)
  f.releaseTarget(7)
  f.backend.respond = (_req, res) => pong(res, false)
  const answers = await Promise.all(Array.from({ length: 7 }, () => f.post()))
  assert.equal(f.active(), 7)
  assert.equal(f.releases(), 0)
  assert.equal(f.modelCalls().length, 7)
  await Promise.all(answers.map((answer) => answer.body?.cancel()))
  await f.released.promise
  assert.equal(f.active(), 0)
  assert.equal(f.releases(), 7)
})

for (const [status, code] of [
  [400, 'context_length_exceeded'],
  [429, 'usage_limit_reached'],
  [401, 'authentication_error'],
] as const) {
  test(`in-stream ${code} after content remains one failure and never replays`, async (t) => {
    const f = await fixture(t)
    f.backend.respond = (_req, res) => {
      pong(res, false)
      res.end(
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: {
            status: 'failed',
            error: { status, code, message: 'FAKE_SECRET_CONTEXT', retry_after: 12 },
          },
        })}\n\n`,
      )
    }
    const response = await f.post()
    const text = await response.text()
    await f.released.promise
    assert.equal(response.status, 200)
    assert.ok(text.includes(code === 'authentication_error' ? 'authentication_required' : code))
    assert.equal(text.includes('FAKE_SECRET'), false)
    assert.equal(text.includes('event: message_stop'), false)
    assert.equal((text.match(/event: error/g) ?? []).length, 1)
    assert.equal(f.modelCalls().length, 1)
    assert.equal(f.gets.filter(Boolean).length, 0)
    assert.equal(f.releases(), 1)
  })
}

test('in-stream 401 before semantic content can retry without publishing a duplicate start', async (t) => {
  const f = await fixture(t)
  f.backend.respond = (_req, res) => {
    if (f.modelCalls().length > 1) {
      pong(res)
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(
      `data: ${JSON.stringify({ type: 'response.created', response: { id: 'discarded' } })}\n\n`,
    )
    res.end(
      `data: ${JSON.stringify({
        type: 'error',
        status: 401,
        error: { code: 'authentication_error', message: 'FAKE_SECRET' },
      })}\n\n`,
    )
  }
  f.refresh(() => f.elect('B'))
  const response = await f.post()
  const text = await response.text()
  await f.released.promise
  assert.equal(response.status, 200)
  assert.equal((text.match(/event: message_start/g) ?? []).length, 1)
  assert.equal((text.match(/event: message_stop/g) ?? []).length, 1)
  assert.equal(text.includes('event: error'), false)
  assert.equal(f.modelCalls().length, 2)
  assert.equal(f.releases(), 1)
})

test('GPT redirect is never followed with broker credentials', async (t) => {
  const f = await fixture(t)
  let hits = 0
  const target = http.createServer((_req, res) => {
    hits++
    res.end('{}')
  })
  await new Promise<void>((done) => target.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>((done) => target.close(() => done())))
  const address = target.address()
  assert.ok(address && typeof address === 'object')
  f.backend.respond = (_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${address.port}` })
    res.end()
  }
  const response = await f.post()
  await response.text()
  await f.released.promise
  assert.equal(response.status, 502)
  assert.equal(hits, 0)
  assert.equal(f.modelCalls().length, 1)
  assert.equal(f.releases(), 1)
})
