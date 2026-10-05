import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { join } from 'node:path'
import test, { after } from 'node:test'
import zlib from 'node:zlib'
import { createRouterLog, scrubForLog } from '../src/router-log.mjs'
import { upstreamTarget } from '../src/router-relay.mjs'
import {
  countRejections,
  decodeBody,
  forwardHeaders,
  type RouterHooks,
  type RouterOptions,
  readJsonBody,
  startRouter,
  trimInPlace,
} from '../src/router-server.mjs'
import { type FakeBackend, startFakeBackend } from './helpers/fake-backend.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const closers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await removeTempDirs()
})

interface Setup {
  backend: FakeBackend
  base: string
  health: string
  port: number
  root: string
}

async function setup(
  hooks: RouterHooks = {},
  options: Pick<RouterOptions, 'maxBodyBytes' | 'requestTimeoutMs'> = {},
): Promise<Setup> {
  const root = await tempDir('anyengine-router-')
  const backend = await startFakeBackend()
  closers.push(() => backend.close())
  const router = await startRouter({ root, port: 0, upstream: backend.url, hooks, ...options })
  closers.push(() => router.close(0))
  return { backend, base: router.baseUrl, health: router.healthUrl, port: router.port, root }
}

function post(
  url: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    req.end(body)
  })
}

// The raw answer: status, headers and body bytes exactly as the router sent
// them (no decompression, unlike fetch).
interface RawAnswer {
  status: number
  headers: http.IncomingHttpHeaders
  raw: Buffer
}

function send(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method ?? 'GET', headers: options.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            raw: Buffer.concat(chunks),
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

// Opens a POST and hands back its response unread.
function open(
  url: string,
  body: Buffer,
): Promise<{ req: http.ClientRequest; res: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => resolve({ req, res }),
    )
    req.on('error', reject)
    req.end(body)
  })
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const giveUp = Date.now() + 30_000
  while (!(await check())) {
    if (Date.now() > giveUp) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// The status line of a request written by hand, byte for byte.
function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text))
    let out = ''
    socket.on('data', (chunk) => {
      out += chunk
    })
    socket.on('close', () => resolve(out.split('\r\n')[0] ?? ''))
    socket.on('error', () => {})
  })
}

// The status line of a request written by hand, as soon as it arrives.
function statusLine(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text))
    let out = ''
    socket.on('data', (chunk) => {
      out += chunk
      if (!out.includes('\r\n')) return
      resolve(out.split('\r\n')[0] ?? '')
      socket.destroy()
    })
    socket.on('close', () => resolve(out.split('\r\n')[0] ?? ''))
    socket.on('error', () => {})
  })
}

async function healthOf(url: string): Promise<{
  ok: boolean
  inflight: { gpt: number; claude: number }
  upstream: { lastOkAt: string | null; lastError: string | null }
  faults: { unhandledRejections: number; hookErrors: number }
}> {
  return (await (await fetch(url)).json()) as never
}

const SECRET = `Bearer ${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"sub":"fixture"}').toString('base64url')}.test-signature`

test('router: a GPT request is relayed byte for byte, headers and all', async () => {
  const { backend, base } = await setup()
  const body = Buffer.from('{"model":"gpt-6-sol","input":[],  "stream":true}')
  const res = await post(`${base}/responses`, body, {
    'content-type': 'application/json',
    authorization: SECRET,
    'chatgpt-account-id': 'acct-1',
    'thread-id': 't1',
  })
  assert.equal(res.status, 200)
  assert.match(res.text, /response\.completed/)
  const seen = backend.requests.find((r) => r.path.endsWith('/responses'))
  assert.ok(seen)
  assert.deepEqual(seen.raw, body)
  assert.equal(seen.headers.authorization, SECRET)
  assert.equal(seen.headers['chatgpt-account-id'], 'acct-1')
  assert.equal(seen.headers['thread-id'], 't1')
})

test('router: no credential reaches the router log', async () => {
  const { base, root } = await setup()
  await post(`${base}/responses`, Buffer.from('{"model":"gpt-6-sol","input":[]}'), {
    'content-type': 'application/json',
    authorization: SECRET,
    'chatgpt-account-id': 'acct-secret-42',
  })
  const logs = join(root, 'logs')
  const text = existsSync(logs)
    ? readdirSync(logs)
        .map((f) => readFileSync(join(logs, f), 'utf8'))
        .join('\n')
    : ''
  assert.ok(!text.includes('eyJhbGci'), 'bearer in log')
  assert.ok(!text.includes('acct-secret-42'), 'account id in log')
})

test('router: browser origins, foreign hosts and non-loopback peers are refused', async () => {
  const { base } = await setup()
  const origin = await post(`${base}/responses`, Buffer.from('{}'), {
    origin: 'https://evil.example',
  })
  assert.equal(origin.status, 403)
  const host = await post(`${base}/responses`, Buffer.from('{}'), { host: 'evil.example' })
  assert.equal(host.status, 403)
})

test('router: a browser is refused however it reaches the port; codex and node are not', async () => {
  const { backend, base, port } = await setup()
  const body = Buffer.from('{"model":"gpt-6-sol"}')
  const json = { 'content-type': 'application/json' }
  // DNS rebinding: the page's own name, resolved to 127.0.0.1.
  for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`]) {
    assert.equal(
      (await send(`${base}/responses`, { method: 'POST', body, headers: { ...json, host } }))
        .status,
      403,
      host,
    )
  }
  // No Host at all (HTTP/1.1 without one Node itself refuses).
  assert.match(await rawRequest(port, 'GET /health HTTP/1.0\r\n\r\n'), / 403 /)
  // Every modern browser sends Sec-Fetch-Site, and a page cannot remove it.
  const fetched = { ...json, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }
  assert.equal(
    (await send(`${base}/responses`, { method: 'POST', body, headers: fetched })).status,
    403,
  )
  assert.equal(
    (await send(`${base}/models`, { headers: { 'sec-fetch-dest': 'image' } })).status,
    403,
  )
  assert.equal(
    (
      await send(`${base}/responses`, {
        method: 'POST',
        body,
        headers: { ...json, origin: 'null' },
      })
    ).status,
    403,
  )
  assert.equal(backend.requests.length, 0, 'nothing refused reached the upstream')
  // Codex sends `originator`, not `origin`; Node's fetch sends Sec-Fetch-Mode only.
  const codex = { ...json, originator: 'codex_cli_rs', host: `localhost:${port}` }
  assert.equal(
    (await send(`${base}/responses`, { method: 'POST', body, headers: codex })).status,
    200,
  )
  assert.equal(
    (await fetch(`${base}/responses`, { method: 'POST', body, headers: json })).status,
    200,
  )
})

test('router: WebSocket upgrades pass the same guard, and 404 while no relay is registered', async () => {
  const { port } = await setup()
  const upgrade = (headers: string) =>
    rawRequest(
      port,
      `GET /backend-api/codex/responses HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${headers}\r\n`,
    )
  assert.match(await upgrade('Origin: https://evil.example\r\n'), / 403 /)
  assert.match(await upgrade(''), / 404 /)
})

test('router: an unreachable upstream is a 502 with a reason, and health records it', async () => {
  const root = await tempDir('anyengine-router-')
  const router = await startRouter({
    root,
    port: 0,
    upstream: 'http://127.0.0.1:9/backend-api/codex',
  })
  closers.push(() => router.close(0))
  const res = await post(`${router.baseUrl}/responses`, Buffer.from('{"model":"gpt-6-sol"}'), {
    'content-type': 'application/json',
  })
  assert.equal(res.status, 502)
  assert.match(res.text, /could not reach upstream/)
  const health = (await (await fetch(router.healthUrl)).json()) as {
    ok: boolean
    upstream: { lastError: string | null }
  }
  assert.equal(health.ok, true)
  assert.match(String(health.upstream.lastError), /ECONNREFUSED/)
})

test('router: health names the process and its version', async () => {
  const { health } = await setup()
  const body = (await (await fetch(health)).json()) as Record<string, unknown>
  assert.equal(body.ok, true)
  assert.equal(body.pid, process.pid)
  assert.match(String(body.version), /^\d+\.\d+\.\d+/)
})

test('router: the launchd log is trimmed in place to its bound', async () => {
  const dir = await tempDir('anyengine-router-trim-')
  const path = join(dir, 'router.launchd.log')
  writeFileSync(path, `${'x'.repeat(5000)}END`)
  const before = statSync(path).ino
  trimInPlace(path, 1000)
  assert.equal(statSync(path).size, 1000)
  assert.equal(statSync(path).ino, before, 'same inode')
  assert.ok(readFileSync(path, 'utf8').endsWith('END'))
})

test('router log: rotates at its bound and keeps at most `keep` old files', async () => {
  const dir = await tempDir('anyengine-router-log-')
  const log = createRouterLog(join(dir, 'router.jsonl'), { maxBytes: 2000, keep: 2 })
  for (let i = 0; i < 200; i += 1) log.info('tick', { i, pad: 'x'.repeat(50) })
  const files = readdirSync(dir).sort()
  assert.deepEqual(files, ['router.jsonl', 'router.jsonl.1', 'router.jsonl.2'])
  log.info('auth', { authorization: SECRET, note: `sent ${SECRET}` })
  const last = readFileSync(join(dir, 'router.jsonl'), 'utf8')
  assert.ok(!last.includes('eyJhbGci'))
})

// Tokens shaped like the real ones: a ChatGPT access token is an RS256 JWT
// with a 256-byte signature; API keys carry their vendor prefixes.
const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')
function accessToken(): string {
  const header = b64url(
    JSON.stringify({ alg: 'RS256', kid: randomBytes(16).toString('hex'), typ: 'JWT' }),
  )
  const payload = b64url(
    JSON.stringify({
      aud: ['https://api.openai.com/v1'],
      exp: 1_790_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct', chatgpt_plan_type: 'pro' },
      iss: 'https://auth.openai.com',
      scp: ['openid', 'profile', 'email', 'offline_access'],
      sub: `auth0|${randomBytes(12).toString('hex')}`,
    }),
  )
  return `${header}.${payload}.${b64url(randomBytes(256))}`
}
const alnum = (length: number) =>
  randomBytes(length * 2)
    .toString('base64url')
    .replace(/[-_]/g, '')
    .slice(0, length)

test('router log: real-shaped credentials are scrubbed wherever they sit', async () => {
  const jwt = accessToken()
  const refresh = `rt_${alnum(43)}`
  const projectKey = `sk-proj-${alnum(40)}_${alnum(40)}-${alnum(40)}`
  const claudeOauth = `sk-ant-oat01-${alnum(86)}-${alnum(6)}AA`
  const claudeKey = `sk-ant-api03-${alnum(93)}AA`
  const cookie = `__Secure-next-auth.session-token=${alnum(900)}; oai-did=${randomBytes(16).toString('hex')}`
  const accountId = '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
  const secrets = [jwt, refresh, projectKey, claudeOauth, claudeKey, cookie, accountId]
  const pieces = secrets.flatMap((s) => [s.slice(8, 24), s.slice(-16)])
  const scrubbed = JSON.stringify(
    scrubForLog({
      headers: {
        authorization: `Bearer ${jwt}`,
        'chatgpt-account-id': accountId,
        cookie,
        'set-cookie': [cookie],
        'x-api-key': claudeKey,
        'proxy-authorization': `Basic ${b64url('user:pass')}`,
      },
      tokens: { access_token: jwt, refresh_token: refresh, id_token: jwt },
      message: `upstream said: Authorization: Bearer ${jwt} for ${projectKey}`,
      body: `{"refresh_token":"${refresh}","api_key":"${claudeOauth}"}`,
      url: `/backend-api/codex/models?client_version=1&access_token=${refresh}&x=1`,
      line: `cookie: ${cookie}`,
      bare: jwt,
      nested: [[{ deep: [`key ${claudeKey}`] }]],
      // A token that straddles the truncation point is scrubbed whole.
      long: `${'a'.repeat(1990)} ${jwt}`,
      error: new Error(`request failed: Bearer ${jwt}`),
      thread: 'thread 019a-kept',
    }),
  )
  for (const piece of pieces) assert.ok(!scrubbed.includes(piece), `leaked ${piece}`)
  assert.ok(!scrubbed.includes('eyJ'), 'no base64 JSON segment left')
  assert.match(scrubbed, /thread 019a-kept/, 'what is not a credential is kept')
  assert.match(scrubbed, /request failed: Bearer \[redacted\]/, 'an error keeps its message')
  // The log file itself: every line is scrubbed on the way out.
  const dir = await tempDir('anyengine-router-scrub-')
  const log = createRouterLog(join(dir, 'router.jsonl'))
  log.error('upstream.error', { reason: `ECONNRESET Bearer ${jwt}`, cookie })
  log.info('request.refused', { path: `/x?refresh_token=${refresh}` })
  const written = readFileSync(join(dir, 'router.jsonl'), 'utf8')
  for (const piece of pieces) assert.ok(!written.includes(piece), `log file leaked ${piece}`)
})

test('router: forwarded headers drop only what belongs to the connection', () => {
  const out = forwardHeaders({
    host: '127.0.0.1:18790',
    connection: 'keep-alive, x-hop',
    'keep-alive': 'timeout=5',
    'x-hop': 'dropped: named by Connection',
    'transfer-encoding': 'chunked',
    'proxy-authorization': 'Basic abc',
    upgrade: 'websocket',
    te: 'trailers',
    expect: '100-continue',
    authorization: SECRET,
    'chatgpt-account-id': 'acct-1',
    cookie: 'a=b',
    'content-encoding': 'zstd',
    'content-type': 'application/json',
    'x-codex-turn-metadata': '{"turn_id":"t"}',
    originator: 'codex_cli_rs',
  })
  assert.deepEqual(Object.keys(out).sort(), [
    'authorization',
    'chatgpt-account-id',
    'content-encoding',
    'content-type',
    'cookie',
    'originator',
    'x-codex-turn-metadata',
  ])
  assert.equal(out.authorization, SECRET)
})

test('router: every relayed URL stays on the configured upstream', () => {
  const chatgpt = 'https://chatgpt.com/backend-api/codex'
  assert.equal(
    upstreamTarget(chatgpt, '/responses', '?x=1')?.href,
    'https://chatgpt.com/backend-api/codex/responses?x=1',
  )
  assert.equal(upstreamTarget(chatgpt, '', '')?.href, chatgpt)
  // A path without its slash would name another host: 'https://chatgpt.com' +
  // 'evil.example/x' is chatgpt.comevil.example.
  for (const subpath of [
    'evil.example/x',
    '.evil.example/x',
    '@evil.example/x',
    ':1@evil.example',
  ]) {
    assert.equal(upstreamTarget('https://chatgpt.com', subpath, ''), null, subpath)
    assert.equal(upstreamTarget(chatgpt, subpath, ''), null, subpath)
  }
  assert.equal(
    upstreamTarget('http://127.0.0.1:5000', '//evil.example/x', '')?.host,
    '127.0.0.1:5000',
  )
})

test('router: request bodies are opened only to read them, within a bound', () => {
  const json = Buffer.from('{"model":"opus","input":[]}')
  for (const [encoding, packed] of [
    ['zstd', zlib.zstdCompressSync(json)],
    ['gzip', zlib.gzipSync(json)],
    ['br', zlib.brotliCompressSync(json)],
    ['deflate', zlib.deflateSync(json)],
    [undefined, json],
  ] as const) {
    assert.deepEqual(decodeBody(packed, encoding), json, String(encoding))
    assert.deepEqual(readJsonBody(packed, encoding), { model: 'opus', input: [] })
  }
  const bomb = zlib.gzipSync(Buffer.alloc(1024 * 1024))
  assert.throws(() => decodeBody(bomb, 'gzip', 1000), RangeError)
  assert.equal(readJsonBody(Buffer.from('not json'), undefined), null)
  assert.equal(readJsonBody(Buffer.from('[1]'), undefined), null)
  assert.equal(readJsonBody(Buffer.from('{}'), 'compress'), null)
  assert.equal(readJsonBody(Buffer.alloc(0), undefined), null)
})

test('router: a compressed body goes upstream as sent, and the Claude hook reads it decoded', async () => {
  const seen: unknown[] = []
  const { backend, base } = await setup({
    claudeHttp: async (_ctx, _req, res, body) => {
      seen.push(body.model)
      if (body.model !== 'opus') return false
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('claude')
      return true
    },
  })
  const headers = { 'content-type': 'application/json', 'content-encoding': 'zstd' }
  const gpt = zlib.zstdCompressSync(Buffer.from('{"model":"gpt-6-sol","input":[]}'))
  const answer = await send(`${base}/responses`, { method: 'POST', headers, body: gpt })
  assert.equal(answer.status, 200)
  const upstream = backend.requests.find((r) => r.path.endsWith('/responses'))
  assert.deepEqual(upstream?.raw, gpt, 'the compressed bytes, unchanged')
  assert.equal(upstream?.headers['content-encoding'], 'zstd')
  const claude = zlib.zstdCompressSync(Buffer.from('{"model":"opus","input":[]}'))
  const kept = await send(`${base}/responses`, { method: 'POST', headers, body: claude })
  assert.equal(kept.raw.toString(), 'claude')
  assert.deepEqual(seen, ['gpt-6-sol', 'opus'])
  assert.equal(backend.requests.length, 1, 'a Claude turn never reaches the upstream')
})

test('router: an SSE stream reaches the client event by event, not buffered', async () => {
  const { backend, base } = await setup()
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = 'event: response.created\ndata: {"type":"response.created"}\n\n'
  const rest = 'event: response.completed\ndata: {"type":"response.completed"}\n\n'
  backend.respond = (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': 'req-upstream-1',
      'openai-processing-ms': '42',
    })
    res.write(first)
    void released.then(() => res.end(rest))
  }
  const { res } = await open(
    `${base}/responses`,
    Buffer.from('{"model":"gpt-6-sol","stream":true}'),
  )
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/event-stream')
  assert.equal(res.headers['x-request-id'], 'req-upstream-1')
  assert.equal(res.headers['openai-processing-ms'], '42')
  let text = ''
  res.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8')
  })
  // The upstream sends the rest only once the first event arrived here.
  await until(() => text === first, 'the first event before the upstream finished')
  release()
  await new Promise((resolve) => res.on('end', resolve))
  assert.equal(text, first + rest)
})

test('router: large bodies pass byte for byte both ways', async () => {
  const { backend, base } = await setup()
  const request = Buffer.concat([
    Buffer.from('{"model":"gpt-6-sol","input":"'),
    Buffer.from(randomBytes(9 * 1024 * 1024).toString('base64')),
    Buffer.from('"}'),
  ])
  const response = randomBytes(24 * 1024 * 1024)
  backend.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(response)
  }
  const answer = await send(`${base}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: request,
  })
  const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  assert.equal(answer.status, 200)
  assert.equal(digest(backend.requests[0]?.raw ?? Buffer.alloc(0)), digest(request))
  assert.equal(answer.raw.length, response.length)
  assert.equal(digest(answer.raw), digest(response))
})

test('router: a slow reader holds the upstream back (backpressure), and every byte arrives', async () => {
  const { backend, base } = await setup()
  // Far more than the kernel can hold between the two ends (4 MB per socket
  // buffer on macOS): the upstream can finish while the client reads
  // nothing only if the router buffers the body itself.
  const total = 64 * 1024 * 1024
  const chunk = randomBytes(64 * 1024)
  const sent = createHash('sha256')
  const pump = { written: 0, waiting: false, finished: false }
  backend.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    const write = () => {
      while (pump.written < total) {
        pump.written += chunk.length
        sent.update(chunk)
        if (!res.write(chunk)) {
          pump.waiting = true
          res.once('drain', () => {
            pump.waiting = false
            write()
          })
          return
        }
      }
      pump.finished = true
      res.end()
    }
    write()
  }
  const { res } = await open(`${base}/responses`, Buffer.from('{"model":"gpt-6-sol"}'))
  res.pause()
  // Wait until the upstream is held: waiting for drain, with no progress for
  // half a second (or finished, which fails below).
  let last = -1
  await until(async () => {
    if (pump.finished) return true
    const now = pump.written
    await new Promise((resolve) => setTimeout(resolve, 500))
    const held = pump.waiting && pump.written === now && now === last
    last = now
    return held
  }, 'the upstream to be held back')
  assert.equal(
    pump.finished,
    false,
    'the router buffered the body instead of passing backpressure on',
  )
  const got = createHash('sha256')
  let received = 0
  res.on('data', (c: Buffer) => {
    received += c.length
    got.update(c)
  })
  res.resume()
  await new Promise((resolve) => res.on('end', resolve))
  assert.equal(received, total)
  assert.equal(got.digest('hex'), sent.digest('hex'))
})

test('router: a client that goes away closes the upstream request too', async () => {
  const { backend, base, health } = await setup()
  let closed = 0
  backend.respond = (req, res) => {
    res.on('close', () => {
      closed += 1
    })
    // One answers with a stream it never ends; the other never answers.
    if (req.raw.includes('"stream"')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: response.created\ndata: {}\n\n')
    }
  }
  const streaming = await open(
    `${base}/responses`,
    Buffer.from('{"model":"gpt-6-sol","stream":true}'),
  )
  streaming.res.on('error', () => {})
  await new Promise((resolve) => streaming.res.once('data', resolve))
  streaming.req.destroy()
  await until(() => closed === 1, 'the streaming upstream request to close')
  const silent = http.request(`${base}/responses`, { method: 'POST' })
  silent.on('error', () => {})
  silent.end('{"model":"gpt-6-sol"}')
  await until(() => backend.requests.length === 2, 'the silent request to reach the upstream')
  silent.destroy()
  await until(() => closed === 2, 'the silent upstream request to close')
  await until(async () => (await healthOf(health)).inflight.gpt === 0, 'no GPT request in flight')
  assert.equal(
    (await healthOf(health)).upstream.lastError,
    null,
    'a client abort is no upstream error',
  )
})

test('router: a caller gone before its turn is relayed sends nothing upstream', async () => {
  const hook = { entered: false, done: false }
  const { backend, base, health } = await setup({
    claudeHttp: async (_ctx, req, _res, body) => {
      if (body.input !== 'abandoned') return false
      hook.entered = true
      await until(() => req.socket.destroyed, 'the caller to go')
      hook.done = true
      return false
    },
  })
  const gone = http.request(`${base}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
  gone.on('error', () => {})
  gone.end('{"model":"gpt-6-sol","input":"abandoned"}')
  await until(() => hook.entered, 'the hook to run')
  gone.destroy()
  await until(() => hook.done, 'the hook to see the caller go')
  assert.equal((await healthOf(health)).inflight.gpt, 0, 'never counted in flight')
  const next = await send(`${base}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"model":"gpt-6-sol","input":"next"}'),
  })
  assert.equal(next.status, 200)
  assert.deepEqual(
    backend.requests.map((r) => JSON.parse(r.raw.toString()).input),
    ['next'],
    'the abandoned turn never reached the upstream',
  )
})

test('router: upstream errors keep their status, headers and body, and reach the observer', async () => {
  const observed: Array<[number, string]> = []
  const { backend, base, health } = await setup({
    observeUpstreamError: (status, text) => observed.push([status, text]),
  })
  const rejected = zlib.gzipSync(
    Buffer.from('{"error":{"message":"multi_agent_version v1 is not supported"}}'),
  )
  backend.respond = (req, res) => {
    const model = JSON.parse(req.raw.toString()).model
    if (model === 'rate') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
      res.end('{"error":{"type":"usage_limit_reached"}}')
    } else if (model === 'gz') {
      res.writeHead(400, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(rejected)
    } else {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('upstream broke')
    }
  }
  const call = (model: string) =>
    send(`${base}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ model })),
    })
  const rate = await call('rate')
  assert.equal(rate.status, 429)
  assert.equal(rate.headers['retry-after'], '7')
  assert.equal(rate.raw.toString(), '{"error":{"type":"usage_limit_reached"}}')
  assert.ok((await healthOf(health)).upstream.lastOkAt, 'a 4xx is an upstream that answered')
  const gz = await call('gz')
  assert.equal(gz.status, 400)
  assert.equal(gz.headers['content-encoding'], 'gzip')
  assert.deepEqual(gz.raw, rejected, 'the encoded bytes, unchanged')
  const broke = await call('boom')
  assert.equal(broke.status, 500)
  assert.equal(broke.raw.toString(), 'upstream broke')
  assert.match(String((await healthOf(health)).upstream.lastError), /answered 500/)
  await until(() => observed.length === 3, 'three observed errors')
  assert.deepEqual(observed, [
    [429, '{"error":{"type":"usage_limit_reached"}}'],
    [400, '{"error":{"message":"multi_agent_version v1 is not supported"}}'],
    [500, 'upstream broke'],
  ])
})

test('router: an upstream that dies mid-stream ends the client stream too, never a hang', async () => {
  const { backend, base } = await setup()
  backend.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: response.created\ndata: {}\n\n', () => res.socket?.destroy())
  }
  const { res } = await open(
    `${base}/responses`,
    Buffer.from('{"model":"gpt-6-sol","stream":true}'),
  )
  res.on('error', () => {})
  let text = ''
  res.on('data', (c: Buffer) => {
    text += c.toString()
  })
  let closed = false
  res.on('close', () => {
    closed = true
  })
  await until(() => closed, 'the client stream to close')
  assert.equal(res.complete, false, 'an incomplete stream, not a clean end')
  assert.match(text, /response\.created/)
})

test('router: paths outside the Codex face are 404; GETs are relayed with their query', async () => {
  const { backend, base, port } = await setup()
  backend.respond = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: req.path, query: req.query }))
  }
  const root = `http://127.0.0.1:${port}`
  assert.equal((await send(`${root}/backend-api/codexevil.example/x`)).status, 404)
  assert.equal((await send(`${root}/v1/responses`)).status, 404)
  const got = await send(`${base}/wham/usage?client=1&x=%2F`)
  assert.equal(got.status, 200)
  assert.deepEqual(JSON.parse(got.raw.toString()), {
    path: '/backend-api/codex/wham/usage',
    query: '?client=1&x=%2F',
  })
  assert.ok(backend.requests.every((r) => r.path.startsWith('/backend-api/codex/')))
})

test('router: it adds no credential of its own, and a failing observer never fails a turn', async () => {
  const { backend, base, health } = await setup({
    observeGptBody: () => {
      throw new Error('observer broke')
    },
  })
  const answer = await send(`${base}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"model":"gpt-6-sol"}'),
  })
  assert.equal(answer.status, 200)
  const seen = backend.requests[0]?.headers ?? {}
  for (const name of ['authorization', 'chatgpt-account-id', 'cookie']) {
    assert.equal(seen[name], undefined, name)
  }
  assert.deepEqual((await healthOf(health)).faults, { unhandledRejections: 0, hookErrors: 1 })
})

test('router: /health counts hook failures, so a router up but broken can be told apart', async () => {
  const { backend, base, health } = await setup({
    claudeHttp: async () => {
      throw new Error('claude hook broke')
    },
    status: () => {
      throw new Error('status hook broke')
    },
  })
  const answer = await send(`${base}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"model":"opus"}'),
  })
  assert.equal(answer.status, 500)
  assert.equal(backend.requests.length, 0)
  // The status hook fails on this read too: counted, and /health still answers.
  const body = await healthOf(health)
  assert.equal(body.ok, true)
  assert.deepEqual(body.faults, { unhandledRejections: 0, hookErrors: 2 })
  const dir = await tempDir('anyengine-router-faults-')
  const log = createRouterLog(join(dir, 'router.jsonl'))
  const faults = { unhandledRejections: 0, hookErrors: 0 }
  countRejections(log, faults)(new Error('nobody awaited this'))
  assert.equal(faults.unhandledRejections, 1)
  assert.match(
    readFileSync(log.path, 'utf8'),
    /"event":"router\.unhandledRejection".*nobody awaited/,
  )
})

test('router: a request line the URL parser rejects is a 400, and the router keeps serving', async () => {
  const { port, health } = await setup()
  const raw = (target: string) =>
    rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
  for (const target of ['//[', 'http://[::1/', '//a:b:c/x']) {
    assert.match(await raw(target), / 400 /, target)
  }
  assert.equal((await healthOf(health)).ok, true)
})

test('router: it binds loopback only and relays only to chatgpt.com or a loopback test backend', async () => {
  const root = await tempDir('anyengine-router-')
  // A router that starts where it should not is closed, and fails the test.
  const refused = (options: Parameters<typeof startRouter>[0]) =>
    startRouter(options).then(
      (router) => {
        closers.push(() => router.close(0))
        return null
      },
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
  assert.match(String(await refused({ root, port: 0, host: '0.0.0.0' })), /loopback/)
  for (const upstream of [
    'https://evil.example/backend-api/codex',
    'http://10.0.0.1:8080/backend-api/codex',
    'http://chatgpt.com/backend-api/codex',
    'https://user:pw@chatgpt.com/backend-api/codex',
    'https://chatgpt.com:8443/backend-api/codex',
    'https://chatgpt.com/backend-api/codex?x=1',
  ]) {
    const message = await refused({ root, port: 0, upstream })
    assert.match(String(message), /chatgpt\.com|credentials/, upstream)
    assert.ok(!String(message).includes('pw@'), 'the refusal does not echo credentials')
  }
})

// A raw TCP upstream that records every byte it gets and answers each request
// head it sees with a two-byte 200: a byte the router should not have sent
// shows up here as a byte.
async function rawUpstream(): Promise<{
  url: string
  received: () => string
  close: () => Promise<void>
}> {
  let received = ''
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    let pending = ''
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1')
      pending += chunk.toString('latin1')
      while (pending.includes('\r\n\r\n')) {
        pending = pending.slice(pending.indexOf('\r\n\r\n') + 4)
        socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')
      }
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/backend-api/codex`,
    received: () => received,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((ok) => server.close(() => ok()))
    },
  }
}

test('router: a GET or HEAD with a body is refused, and the upstream sees no stray byte', async () => {
  const upstream = await rawUpstream()
  closers.push(() => upstream.close())
  const root = await tempDir('anyengine-router-')
  const router = await startRouter({ root, port: 0, upstream: upstream.url })
  closers.push(() => router.close(0))
  const head = (method: string, extra: string) =>
    `${method} /backend-api/codex/wham/usage HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${extra}`
  // A request hidden in a GET's chunked body: with Transfer-Encoding dropped
  // as hop-by-hop, relaying these bytes would put it on a pooled socket.
  const smuggled = 'GET /smuggled HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n'
  const chunked = `Transfer-Encoding: chunked\r\n\r\n${smuggled.length.toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`
  assert.match(await rawRequest(router.port, head('GET', chunked)), / 400 /)
  assert.match(
    await rawRequest(router.port, head('HEAD', 'Content-Length: 5\r\n\r\nhello')),
    / 400 /,
  )
  assert.match(await rawRequest(router.port, head('GET', 'Content-Length: 0\r\n\r\n')), / 200 /)
  assert.match(await rawRequest(router.port, head('GET', '\r\n')), / 200 /)
  const received = upstream.received()
  assert.ok(!received.includes('smuggled'), 'no hidden request reached the upstream')
  const heads = received.split('\r\n\r\n')
  assert.equal(heads.length, 3, 'two request heads and nothing after the last one')
  assert.equal(heads[2], '', 'no stray bytes after a head')
  for (const one of heads.slice(0, 2))
    assert.match(one, /^GET \/backend-api\/codex\/wham\/usage HTTP\/1\.1/)
})

test('router: its relay verifies the upstream certificate even with NODE_TLS_REJECT_UNAUTHORIZED=0', async () => {
  const dir = await tempDir('anyengine-router-tls-')
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
  const tls = https.createServer(
    { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) },
    (_req, res) => {
      served += 1
      res.end('{}')
    },
  )
  await new Promise<void>((ok) => tls.listen(0, '127.0.0.1', ok))
  closers.push(() => new Promise<void>((ok) => tls.close(() => ok())))
  const address = tls.address()
  const port = typeof address === 'object' && address ? address.port : 0
  // The configured upstream can only be chatgpt.com; point this router's
  // context at the self-signed server behind the setting's back.
  const running = await startRouter({ root: dir, port: 0 })
  closers.push(() => running.close(0))
  running.context.upstream = () => `https://127.0.0.1:${port}/backend-api/codex`
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  try {
    const answer = await send(`${running.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: SECRET },
      body: Buffer.from('{"model":"gpt-6-sol"}'),
    })
    assert.equal(answer.status, 502)
    assert.match(answer.raw.toString(), /SELF_SIGNED|CERT|ALTNAME/)
  } finally {
    if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before
  }
  assert.equal(served, 0, 'no request, and no bearer, reached an unverified server')
})

test('router: a request body over the bound is a 413 and never reaches the upstream', async () => {
  const { backend, base, port } = await setup({}, { maxBodyBytes: 1024 * 1024 })
  const post = (extra: string) =>
    `POST /backend-api/codex/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n${extra}`
  // Declared too large: refused before a byte of it is read.
  assert.match(await statusLine(port, post(`Content-Length: ${2 * 1024 * 1024}\r\n\r\n`)), / 413 /)
  // Too large as it arrives (chunked, no length): refused at the bound.
  const chunk = 'x'.repeat(1536 * 1024)
  assert.match(
    await statusLine(
      port,
      post(`Transfer-Encoding: chunked\r\n\r\n${chunk.length.toString(16)}\r\n${chunk}\r\n`),
    ),
    / 413 /,
  )
  const fits = Buffer.concat([
    Buffer.from('{"model":"gpt-6-sol","input":"'),
    Buffer.alloc(1024 * 1024 - 40, 'y'),
    Buffer.from('"}'),
  ])
  const ok = await send(`${base}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: fits,
  })
  assert.equal(ok.status, 200)
  assert.equal(backend.requests.length, 1, 'only the body within the bound was relayed')
  // The default bound is 128 MB.
  const plain = await setup()
  assert.match(
    await statusLine(plain.port, post(`Content-Length: ${200 * 1024 * 1024}\r\n\r\n`)),
    / 413 /,
  )
  assert.equal(plain.backend.requests.length, 0)
})

test('router: a request that stalls while it is sent is cut (408); a long answer is not', async () => {
  const { backend, base, port } = await setup({}, { requestTimeoutMs: 400 })
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  backend.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: response.created\ndata: {}\n\n')
    void released.then(() => res.end('event: response.completed\ndata: {}\n\n'))
  }
  const { res } = await open(
    `${base}/responses`,
    Buffer.from('{"model":"gpt-6-sol","stream":true}'),
  )
  let text = ''
  res.on('data', (c: Buffer) => {
    text += c.toString()
  })
  await until(() => text.includes('response.created'), 'the first event')
  // Started after the stream: once it has been cut, the stream is older
  // than the bound too.
  const stalled = await rawRequest(
    port,
    'POST /backend-api/codex/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n0123456789',
  )
  assert.match(stalled, / 408 /)
  release()
  await new Promise((resolve) => res.on('end', resolve))
  assert.equal(res.complete, true)
  assert.match(text, /response\.completed/)
})

test('router: answer headers keep their duplicates, order and case; the hop-by-hop ones stay behind', async () => {
  const { backend, base } = await setup()
  backend.respond = (_req, res) => {
    res.writeHead(200, [
      'Content-Type',
      'application/json',
      'Set-Cookie',
      'a=1; Path=/; HttpOnly',
      'X-Dup',
      'one',
      'Set-Cookie',
      'b=2; Path=/; Secure',
      'X-Dup',
      'two',
      'X-Request-Id',
      'req-1',
      'Connection',
      'keep-alive, X-Hop',
      'X-Hop',
      'hop-only',
      'Keep-Alive',
      'timeout=999',
    ])
    res.end('{}')
  }
  const raw = await new Promise<string[]>((resolve, reject) => {
    const req = http.request(`${base}/responses`, { method: 'POST' }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.rawHeaders))
    })
    req.on('error', reject)
    req.end('{"model":"gpt-6-sol"}')
  })
  const pairs = [] as string[]
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push(`${raw[i]}: ${raw[i + 1]}`)
  const kept = pairs.filter((p) => /^(Set-Cookie|X-Dup|X-Request-Id|Content-Type):/.test(p))
  assert.deepEqual(kept, [
    'Content-Type: application/json',
    'Set-Cookie: a=1; Path=/; HttpOnly',
    'X-Dup: one',
    'Set-Cookie: b=2; Path=/; Secure',
    'X-Dup: two',
    'X-Request-Id: req-1',
  ])
  assert.ok(!pairs.some((p) => /^x-hop:/i.test(p)), 'a header Connection names stays behind')
  assert.ok(!pairs.includes('Keep-Alive: timeout=999'), "the upstream's Keep-Alive stays behind")
})

test('router: a caller leaving mid-body is logged as info, not as a failure', async () => {
  const { backend, port, root } = await setup()
  await new Promise<void>((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'POST /backend-api/codex/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n0123456789',
        () => socket.destroy(),
      )
    })
    socket.on('close', () => resolve())
    socket.on('error', () => {})
  })
  const logPath = join(root, 'logs', 'router.jsonl')
  await until(
    () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('request.abandoned'),
    'the abandoned request in the log',
  )
  const lines = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    lines.map((l) => [l.level, l.event]),
    [['info', 'request.abandoned']],
  )
  assert.equal(backend.requests.length, 0)
})
