#!/usr/bin/env node
// Optional, zero-spend differential recorder. The pinned upstream executable
// is a reference only: no upstream authentication/server code ships in M2.
// Usage: node scripts/capture-raine-translation.mjs --proxy PATH [--out FILE]
// Every invocation, including --version, gets fake homes and a refusing sandbox.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const VERSION = '0.1.42'
const COMMIT = '1e30e301a48c01a797308e2d24f6c66515363cbf'
const BINARY_SHA256 = '480d16882ab327230d3b8728330bc45fac9e9637f0534cfabf990bd62b9bb15c'
const MAX_BYTES = 2 * 1024 * 1024
const FAKE_ACCESS = 'fixture-only-dummy-access'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { proxy: { type: 'string' }, out: { type: 'string' } } })
assert.equal(process.platform, 'darwin', 'recorder requires macOS sandbox-exec')
assert.equal(process.arch, 'arm64', 'pinned release is darwin-arm64')
assert.ok(values.proxy, 'pass the pinned release executable with --proxy')
assert.ok(existsSync('/usr/bin/sandbox-exec'), 'sandbox-exec is required')
const proxy = realpathSync(values.proxy)
assert.equal(createHash('sha256').update(readFileSync(proxy)).digest('hex'), BINARY_SHA256)
const out = resolve(values.out ?? join(repo, 'test/fixtures/raine-translation-v0.1.42.json'))
assert.ok(!existsSync(out), 'output exists; capture to a new file before comparing')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'raine-capture-')))
chmodSync(scratch, 0o700)
const realHome = realpathSync(homedir())
const home = join(scratch, 'home')
const config = join(scratch, 'config')
for (const path of [home, config, join(config, 'codex'), join(scratch, 'state')]) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}
// These values are fabricated here, not borrowed from Codex or a proxy store.
writeFileSync(
  join(config, 'codex/auth.json'),
  JSON.stringify({
    access: FAKE_ACCESS,
    refresh: 'fixture-only-dummy-refresh',
    expires: 4102444800000,
    accountId: 'acct-fixture',
  }),
  { mode: 0o600 },
)
writeFileSync(join(config, 'config.json'), '{}\n', { mode: 0o600 })

const quote = (value) => JSON.stringify(value)
const profile = `(version 1)
(allow default)
(deny file-read* (require-all (subpath ${quote(realHome)})
  (require-not (subpath ${quote(scratch)}))))
(deny file-read* (subpath "/Library/Keychains") (subpath "/System/Library/Keychains")
  (subpath ${quote(join(realHome, 'Library/Keychains'))}))
(deny file-write* (require-not (subpath ${quote(scratch)})))
(deny network*)
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(deny mach-lookup (global-name "com.apple.securityd"))
(deny mach-lookup (global-name "com.apple.securityd.xpc"))
(deny mach-lookup (global-name "com.apple.secd"))
(deny process-fork)
(deny process-exec (require-not (literal ${quote(proxy)})))
`
const env = {
  HOME: home,
  PATH: '/usr/bin:/bin',
  TMPDIR: scratch,
  XDG_CONFIG_HOME: config,
  XDG_STATE_HOME: join(scratch, 'state'),
  XDG_CACHE_HOME: join(scratch, 'cache'),
  CCP_CONFIG_DIR: config,
  CCP_BIND_ADDRESS: '127.0.0.1',
  CCP_CODEX_TRANSPORT: 'http',
  CCP_CODEX_PREVIOUS_RESPONSE_ID: 'false',
  CCP_CODEX_SERVER_COMPACTION: 'false',
  CCP_CODEX_HEADER_TIMEOUT_MS: '5000',
  CCP_LOG_STDERR: 'false',
}
const children = new Set()
const servers = new Set()
let cleanupKnown = true
let stopping = false
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

function start(args, additions = {}) {
  const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, proxy, ...args], {
    cwd: scratch,
    env: { ...env, ...additions },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const owned = { child, closed: false, start: null, text: '' }
  owned.done = new Promise((done, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      owned.closed = true
      children.delete(owned)
      done({ code, signal })
    })
  })
  // Observe every pipe; never print upstream logs or use them as fixtures.
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      if (owned.text.length + chunk.length > MAX_BYTES) {
        cleanupKnown = false
        child.stdout.pause()
        child.stderr.pause()
      } else owned.text += chunk.toString('utf8')
    })
  }
  children.add(owned)
  return owned
}

function identity(owned) {
  const current = spawnSync('/bin/ps', ['-p', String(owned.child.pid), '-o', 'pgid=,lstart='], {
    encoding: 'utf8',
    timeout: 1000,
    env: { PATH: '/usr/bin:/bin' },
  })
  const text = current.status === 0 ? current.stdout.trim() : ''
  if (!text || Number(text.split(/\s+/)[0]) !== owned.child.pid) return null
  return text
}

async function stop(owned) {
  if (owned.closed) return
  const current = identity(owned)
  if (!current || (owned.start !== null && owned.start !== current)) {
    await Promise.race([owned.done, delay(100)])
    if (!owned.closed) cleanupKnown = false
    return
  }
  owned.start ??= current
  process.kill(-owned.child.pid, 'SIGTERM')
  await Promise.race([owned.done, delay(2000)])
  if (!owned.closed && identity(owned) === owned.start) {
    process.kill(-owned.child.pid, 'SIGKILL')
    await Promise.race([owned.done, delay(2000)])
  }
  if (!owned.closed) cleanupKnown = false
}

async function cleanup() {
  if (stopping) return
  stopping = true
  for (const server of servers) server.closeAllConnections()
  for (const owned of [...children]) await stop(owned)
  for (const server of servers) await new Promise((done) => server.close(done))
  if (cleanupKnown && children.size === 0) rmSync(scratch, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void cleanup().then(() => process.exit(1))
  })
}

const created = { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }
const usage = { input_tokens: 100, output_tokens: 9, input_tokens_details: { cached_tokens: 20 } }
const completed = (output, counts = usage) => ({
  type: 'response.completed',
  response: {
    id: 'resp_1',
    status: 'completed',
    error: null,
    incomplete_details: null,
    output,
    usage: counts,
  },
})
const textItem = { type: 'message', id: 'item_text', role: 'assistant', content: [] }
function textEvents(text = 'hello') {
  const item = { ...textItem, content: [{ type: 'output_text', text, annotations: [] }] }
  return [
    created,
    { type: 'response.output_item.added', output_index: 0, item: textItem },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'item_text', delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    completed([item]),
  ]
}
const args = '{"q":"fixture"}'
const tool = {
  type: 'function_call',
  id: 'item_tool',
  call_id: 'call_1',
  name: 'Lookup',
  arguments: args,
}
const toolEvents = [
  created,
  { type: 'response.output_item.added', output_index: 0, item: { ...tool, arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"q":' },
  { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"fixture"}' },
  { type: 'response.function_call_arguments.done', output_index: 0, arguments: args },
  { type: 'response.output_item.done', output_index: 0, item: tool },
  completed([tool]),
]
const lookup = {
  name: 'Lookup',
  description: 'Fixture lookup',
  input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
}
const request = (content, extra = {}) => ({
  model: 'gpt-5.5',
  max_tokens: 32,
  stream: true,
  messages: [{ role: 'user', content }],
  ...extra,
})
const signature = 'ccp:codex:v1:cnNfMQ:opaque-fixture'
const reasoning = {
  type: 'reasoning',
  id: 'rs_1',
  summary: [],
  encrypted_content: 'opaque-fixture',
}
const cases = [
  { id: 'text-stream', request: request('hello'), events: textEvents() },
  { id: 'text-json', request: request('hello', { stream: false }), events: textEvents() },
  {
    id: 'tool-call',
    request: request('lookup', { tools: [lookup], tool_choice: { type: 'any' } }),
    events: toolEvents,
  },
  {
    id: 'tool-result',
    request: request('lookup', {
      tools: [lookup],
      messages: [
        { role: 'user', content: 'lookup' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'Lookup', input: { q: 'fixture' } }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: [
                { type: 'text', text: 'first' },
                { type: 'text', text: 'second' },
              ],
            },
          ],
        },
      ],
    }),
    events: textEvents('done'),
  },
  {
    id: 'image',
    request: request([
      { type: 'text', text: 'image' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        },
      },
    ]),
    events: textEvents('image'),
  },
  { id: 'cached-usage', request: request('usage'), events: textEvents('usage') },
  {
    id: 'reasoning-replay',
    request: request('continue', {
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'plan', signature },
            { type: 'text', text: 'first answer' },
          ],
        },
        { role: 'user', content: 'continue' },
      ],
    }),
    events: [
      created,
      { type: 'response.output_item.added', output_index: 0, item: reasoning },
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        summary_index: 0,
        delta: 'plan',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', summary: [] },
      },
      ...textEvents('answer')
        .slice(1)
        .map((event) => (event.output_index === 0 ? { ...event, output_index: 1 } : event)),
    ],
  },
  {
    id: 'rate-limit',
    request: request('quota'),
    status: 429,
    retryAfter: '0',
    body: { error: { code: 'usage_limit_reached', message: 'FAKE_SECRET_MARKER_fixture' } },
  },
  {
    id: 'context-overflow',
    request: request('context'),
    status: 400,
    body: {
      error: {
        code: 'context_length_exceeded',
        message: 'maximum context length exceeded FAKE_SECRET_MARKER_fixture',
      },
    },
  },
  {
    id: 'truncated-stream',
    request: request('truncate'),
    events: textEvents('partial').slice(0, 3),
  },
  {
    id: 'read-rewrite',
    request: request('read', {
      tools: [
        {
          name: 'Read',
          description: 'Original read description',
          input_schema: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              offset: { type: 'integer', description: 'original offset' },
              limit: { type: 'integer', description: 'original limit' },
            },
          },
        },
      ],
    }),
    events: textEvents('read'),
  },
]
const expectedDeltas = [
  {
    cases: ['read-rewrite'],
    rule: 'Preserve caller tool description/schema and exact arguments; omit upstream Read offset guidance, argument sanitation, result rewrites and stalled-argument repair.',
  },
  {
    cases: ['context-overflow'],
    rule: 'Map context overflow to HTTP 400 invalid_request_error, code context_length_exceeded, with safe message: prompt is too long: context length exceeded.',
  },
  {
    cases: ['rate-limit', 'context-overflow', 'truncated-stream'],
    rule: 'Redact backend text. No automatic quota, ordinary 5xx, EOF or incomplete-stream replay; never emit a successful terminal after failure.',
  },
  {
    cases: ['cached-usage'],
    rule: 'Use authoritative final usage, with saturating subtraction when cached tokens exceed input tokens; never estimated final totals.',
  },
  {
    cases: ['reasoning-replay'],
    rule: 'Replay supplied full history only; no process-global continuation or previous_response_id. Validate owned signature grammar and bounds; preserve unknown signatures.',
  },
  {
    cases: ['text-stream', 'text-json', 'image', 'tool-call', 'tool-result'],
    rule: 'Choose backend model/lane/effort from the current admitted catalog; do not import upstream Claude aliases or a static GPT allowlist.',
  },
]

function labelIds(text) {
  const labels = new Map()
  return text.replace(
    /msg_[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    (id) => {
      if (!labels.has(id))
        labels.set(id, id.startsWith('msg_') ? 'msg_fixture' : `uuid_${labels.size + 1}`)
      return labels.get(id)
    },
  )
}
const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
async function listen(server) {
  servers.add(server)
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  return server.address().port
}
async function freePort() {
  const server = http.createServer()
  const port = await listen(server)
  await new Promise((done) => server.close(done))
  servers.delete(server)
  return port
}

async function boundedBody(response) {
  const chunks = []
  let bytes = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      assert.ok(bytes <= MAX_BYTES, 'reference response exceeded capture bound')
      chunks.push(value)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } finally {
    await reader.cancel()
  }
}

let currentCase = null
const requests = []
const backend = http.createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/responses')
    assert.ok(currentCase, 'backend received a request outside a capture case')
    assert.equal(req.headers.authorization, `Bearer ${FAKE_ACCESS}`)
    let body = ''
    for await (const chunk of req) {
      body += chunk.toString('utf8')
      assert.ok(Buffer.byteLength(body) <= MAX_BYTES)
    }
    const normalized = labelIds(body)
    requests.push({
      body: normalized,
      json: JSON.parse(normalized),
      fakeAuthorizationVerified: true,
    })
    res.writeHead(currentCase.status ?? 200, {
      'content-type': currentCase.body ? 'application/json' : 'text/event-stream',
      ...(currentCase.retryAfter ? { 'retry-after': currentCase.retryAfter } : {}),
    })
    res.end(currentCase.body ? JSON.stringify(currentCase.body) : sse(currentCase.events))
  } catch {
    cleanupKnown = false
    res.writeHead(500).end('fixture backend refused unexpected request')
  }
})

try {
  const versionChild = start(['--version'])
  const versionResult = await Promise.race([versionChild.done, delay(5000).then(() => null)])
  assert.ok(versionResult, 'pinned version invocation exceeded deadline')
  assert.equal(
    versionResult.code,
    0,
    `pinned version invocation failed: ${versionChild.text.replaceAll(scratch, '<scratch>').replaceAll(proxy, '<proxy>').replaceAll(realHome, '<home>')}`,
  )
  assert.equal(versionChild.text.trim(), `claude-code-proxy ${VERSION}`)
  const backendPort = await listen(backend)
  const proxyPort = await freePort()
  const serverChild = start(['serve', '--port', String(proxyPort), '--no-monitor'], {
    CCP_CODEX_BASE_URL: `http://127.0.0.1:${backendPort}/responses`,
  })
  const readyDeadline = Date.now() + 10000
  let ready = false
  while (!serverChild.closed && Date.now() < readyDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/healthz`, {
        signal: AbortSignal.timeout(1000),
      })
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      /* listener is not ready yet */
    }
    await delay(50)
  }
  assert.ok(ready, 'pinned reference server did not become ready')
  serverChild.start = identity(serverChild)
  assert.ok(serverChild.start, 'reference process ownership is unknown')
  const captured = []
  for (const sample of cases) {
    currentCase = sample
    requests.length = 0
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': 'fixture-only',
      },
      body: JSON.stringify(sample.request),
      signal: AbortSignal.timeout(20000),
    })
    const text = labelIds(await boundedBody(response))
    assert.ok(requests.length > 0, `no translated request for ${sample.id}`)
    captured.push({
      id: sample.id,
      input: sample.request,
      backend: {
        status: sample.status ?? 200,
        ...(sample.retryAfter ? { retryAfter: sample.retryAfter } : {}),
        ...(sample.body
          ? { json: sample.body }
          : { sse: sse(sample.events), events: sample.events }),
      },
      upstream: { requests: [...requests], attempts: requests.length },
      output: {
        status: response.status,
        contentType: response.headers.get('content-type'),
        retryAfter: response.headers.get('retry-after'),
        body: text,
      },
    })
    currentCase = null
  }
  await stop(serverChild)
  await cleanup()
  assert.ok(cleanupKnown && children.size === 0, 'capture cleanup was not proven')
  const fixture = {
    upstream: {
      repository: 'https://github.com/raine/claude-code-proxy',
      version: VERSION,
      commit: COMMIT,
      release: `https://github.com/raine/claude-code-proxy/releases/tag/v${VERSION}`,
      platform: 'darwin-arm64',
      binarySha256: BINARY_SHA256,
    },
    isolation: {
      sandboxEveryInvocation: true,
      externalNetworkDenied: true,
      keychainDenied: true,
      realHomesDenied: true,
      subprocessForkDenied: true,
      fakeAuthOnly: true,
      cleanupJoined: true,
    },
    normalization:
      'Generated message IDs and UUIDs are deterministic labels; request JSON and response SSE otherwise retain their exact bytes. HTTP dates/transport headers and credentials are excluded.',
    expectedDeltas,
    cases: captured,
  }
  const bytes = `${JSON.stringify(fixture, null, 2)}\n`
  assert.ok(!bytes.includes(realHome), 'fixture contains a real home')
  assert.ok(!bytes.includes(FAKE_ACCESS), 'fixture contains a bearer value')
  writeFileSync(out, bytes, { flag: 'wx', mode: 0o600 })
  console.log(
    `capture-raine-translation: ${captured.length} cases; pinned v${VERSION}; cleanup joined`,
  )
} finally {
  await cleanup()
}
