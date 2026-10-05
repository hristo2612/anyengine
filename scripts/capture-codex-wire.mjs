#!/usr/bin/env node
// Zero-spend capture of what a bundled codex sends to its model backend.
// Runs `codex app-server` with an isolated CODEX_HOME (an API-key login with
// a fake key, so nothing reaches OpenAI), points openai_base_url at a loopback
// fake backend (and chatgpt_base_url at a dead loopback port), hands it a
// two-entry catalog through the documented model_catalog_json key, and records
// the shape (never the values of credentials or ids) of every request.
//
// Two passes, each with one ephemeral thread per catalog entry:
//   http       the fake answers every WebSocket upgrade with 426, so codex
//              falls back to HTTP POST; one turn per thread.
//   websocket  the fake accepts the socket and answers response.create
//              frames; four turns per thread, and the fake closes a socket
//              after it has carried two turns, so the third reconnects and
//              the fourth runs under the reconnect's (by then stale) headers.
// The catalog's GPT entry speaks responses-lite; `opus` is the router's Claude
// entry as src/router-catalog.mts clones it (the GPT entry with
// use_responses_lite off), so both wires the router receives are recorded.
// Turn and response ids are written as labels (T1, T2, f0, ...), so a rerun
// against the same codex writes the same bytes.
//
// Every codex it runs is under sandbox-exec: outbound traffic is denied except
// to loopback (0.159's curated-plugin sync goes to github.com and to a
// chatgpt.com URL no base-URL setting moves), and writes under the real
// ~/.codex, ~/.anyengine and ~/.claude are denied. The router's wire contract
// (src/codex-wire.mts) is checked against the result: the capture exits 1,
// naming what is missing, when a field the contract reads is absent. The
// update gate runs this against every new app version (src/update-watch.mts)
// and relies on that exit code alone.
//
// The fixture is this script's output byte for byte; Biome skips it
// (biome.json), so a regenerated fixture passes `npm run check` unformatted.
//
// Usage: node scripts/capture-codex-wire.mjs [--codex PATH] [--out FILE] [--catalog-from FILE]
//   --codex        default: the app's bundled codex (src/bundled-codex.mts rule)
//   --out          default: test/fixtures/codex-wire-<version>.json
//   --catalog-from a models_cache.json or /models answer to take one entry
//                  from (read only); default: a minimal built-in entry
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { WebSocketServer } from 'ws'
import {
  codexVersion,
  probeCodex,
  probeDirs,
  QUICK_MS,
  requireSandbox,
  sandboxed as sandboxedCodex,
} from './lib/codex-probe.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({
  options: {
    codex: { type: 'string' },
    out: { type: 'string' },
    'catalog-from': { type: 'string' },
  },
})

const codex = await probeCodex(repo, values.codex)
if (!codex) {
  console.error('capture-codex-wire: no bundled codex found; pass --codex')
  process.exit(1)
}
requireSandbox('capture-codex-wire')

// The probe home exists before codex first runs (scripts/lib/codex-probe.mjs),
// and every codex call runs in the sandbox: nothing but loopback, and no
// write under the real homes even if the isolation were lost.
const { probe, work, env } = probeDirs('codex-wire-probe-')
const sandboxed = sandboxedCodex(codex)
const version = codexVersion(sandboxed, env)
if (!version) {
  console.error(`capture-codex-wire: ${codex} --version gave no version`)
  process.exit(1)
}
const out = values.out ?? join(repo, 'test', 'fixtures', `codex-wire-${version}.json`)

// Minimal catalog entry (the shape claude-in-codex's FALLBACK_TEMPLATE uses),
// or one real entry taken read-only from a cache the caller names. The GPT
// entry speaks responses-lite (`use_responses_lite`, `tool_mode`), as every
// entry of 0.159's bundled catalog and the live catalog's current GPT models
// do (an older listed model, gpt-5.5, has it off). `opus` is the router's
// Claude entry: the GPT entry with use_responses_lite off and v1 multi-agent,
// as src/router-catalog.mts builds it.
const GPT = 'gpt-wire-probe'
const CLAUDE = 'opus'
function catalog() {
  const minimal = {
    slug: GPT,
    display_name: 'Wire probe',
    description: 'capture-codex-wire',
    default_reasoning_level: 'low',
    supported_reasoning_levels: [{ effort: 'low', description: 'low' }],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    availability_nux: null,
    upgrade: null,
    base_instructions: '',
    supports_reasoning_summaries: true,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    context_window: 272000,
    multi_agent_version: 'v1',
    tool_mode: 'code_mode_only',
  }
  let first = minimal
  if (values['catalog-from']) {
    const models = JSON.parse(readFileSync(values['catalog-from'], 'utf8')).models ?? []
    first = models.find((m) => m.visibility === 'list') ?? minimal
  }
  const gpt = {
    ...first,
    slug: GPT,
    priority: 1,
    multi_agent_version: 'v1',
    use_responses_lite: true,
  }
  const claude = {
    ...gpt,
    slug: CLAUDE,
    display_name: 'Claude Opus',
    priority: 2,
    use_responses_lite: false,
  }
  return { models: [gpt, claude] }
}
const catalogFile = join(probe, 'catalog.json')
writeFileSync(catalogFile, JSON.stringify(catalog()))

const scrub = (headers) =>
  Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k,
      /authorization|cookie/i.test(k) ? '<redacted>' : v,
    ]),
  )
const parseJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
const record = (value) => (value && typeof value === 'object' ? value : {})
const metadataOf = (raw) => record(typeof raw === 'string' ? parseJson(raw) : null)

// The fake Responses backend. Every response it sends has an id of its own,
// so a later previous_response_id can be told back to the frame it answers.
async function startBackend(acceptWebSocket) {
  const seen = []
  let responses = 0
  const answer = (body, write) => {
    const id = `resp_wire_${++responses}`
    const prewarm = body?.generate === false
    const item = {
      id: `msg_wire_${responses}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'PONG', annotations: [] }],
    }
    const response = {
      id,
      object: 'response',
      status: 'completed',
      model: body?.model,
      output: prewarm ? [] : [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }
    let seq = 0
    const send = (type, payload) => write({ type, sequence_number: seq++, ...payload })
    send('response.created', { response: { ...response, status: 'in_progress', output: [] } })
    if (!prewarm) send('response.output_item.done', { output_index: 0, item })
    send('response.completed', { response })
    return id
  }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = parseJson(Buffer.concat(chunks).toString('utf8'))
      const entry = { kind: 'http', method: req.method, path: req.url.split('?')[0] }
      seen.push({ ...entry, headers: scrub(req.headers), body })
      if (!req.url.includes('/responses')) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      answer(body, (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
      res.end()
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const upgrade = { kind: 'upgrade', path: req.url.split('?')[0], headers: scrub(req.headers) }
    seen.push(upgrade)
    if (!acceptWebSocket) {
      socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n')
      return
    }
    upgrade.frames = []
    wss.handleUpgrade(req, socket, head, (ws) => {
      let turns = 0
      ws.on('message', (data) => {
        const body = parseJson(data.toString())
        const id = answer(body, (event) => ws.send(JSON.stringify(event)))
        upgrade.frames.push({ body, id })
        if (body?.generate !== false && ++turns === 2) ws.close(1000)
      })
    })
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const close = () => {
    for (const client of wss.clients) client.terminate()
    server.close()
  }
  return { port: server.address().port, seen, close }
}

// A loopback port nothing listens on: whatever codex asks of the ChatGPT
// backend (plugins, analytics, account state) is refused locally.
async function deadPort() {
  const server = net.createServer()
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const { port: free } = server.address()
  await new Promise((ok) => server.close(ok))
  return free
}

let running = null
const timer = setTimeout(() => {
  console.error('capture-codex-wire: timed out')
  running?.kill('SIGKILL')
  process.exit(1)
}, 120_000)

const login = spawnSync(...sandboxed(['login', '--with-api-key']), {
  env,
  input: 'sk-anyengine-wire-probe\n',
  encoding: 'utf8',
  timeout: QUICK_MS,
})
if (login.status !== 0) {
  console.error(`capture-codex-wire: fake API-key login failed: ${login.stderr}`)
  process.exit(1)
}

// One app-server against one fake backend: a thread per catalog entry, and
// `turns` turns on each, one after the other.
async function runPass(acceptWebSocket, turns) {
  const backend = await startBackend(acceptWebSocket)
  const dead = await deadPort()
  const args = [
    'app-server',
    '-c',
    `openai_base_url="http://127.0.0.1:${backend.port}/backend-api/codex"`,
    '-c',
    `chatgpt_base_url="http://127.0.0.1:${dead}/backend-api/"`,
    '-c',
    `model_catalog_json="${catalogFile}"`,
    '-c',
    'mcp_servers={}',
    '-c',
    'notify=[]',
  ]
  const child = spawn(...sandboxed(args), { env, stdio: ['pipe', 'pipe', 'ignore'] })
  running = child
  const exited = new Promise((ok) => child.once('exit', ok))
  const pending = new Map()
  const events = []
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const m = parseJson(line)
    if (!m) return
    if (m.id != null && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method) events.push(m.method)
  })
  let nextId = 0
  const request = (method, params) =>
    new Promise((ok) => {
      const id = ++nextId
      pending.set(id, ok)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const completed = () => events.filter((method) => method === 'turn/completed').length
  await request('initialize', {
    clientInfo: { name: 'anyengine-wire', version: '0' },
    capabilities: { experimentalApi: true },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`)
  const list = await request('model/list', { includeHidden: true, limit: 100 })
  const threads = {}
  for (const model of [GPT, CLAUDE]) {
    const started = await request('thread/start', {
      model,
      cwd: work,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ephemeral: true,
    })
    const threadId = started.result?.thread?.id ?? null
    const turnIds = []
    for (let i = 0; threadId && i < turns; i += 1) {
      const before = completed()
      const turn = await request('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'Reply with the single word PONG' }],
        effort: 'low',
      })
      turnIds.push(turn.result?.turn?.id ?? null)
      for (let j = 0; j < 100 && completed() === before; j += 1)
        await new Promise((ok) => setTimeout(ok, 100))
    }
    threads[model] = { threadId, turnIds }
  }
  child.kill('SIGTERM')
  // codex writes into its home while it shuts down; the probe goes only after.
  await exited
  running = null
  backend.close()
  return { list, threads, seen: backend.seen, events }
}

const httpPass = await runPass(false, 1)
const wsPass = await runPass(true, 4)
clearTimeout(timer)

// Ids become labels: a thread's turns T1, T2, ... in the order they started,
// an empty turn id `empty`; a frame's response f0, f1, ... in the order the
// fake answered the thread's frames.
function labeller(turnIds) {
  return (id) => {
    if (id === undefined || id === null) return null
    if (id === '') return 'empty'
    const index = turnIds.indexOf(id)
    return index >= 0 ? `T${index + 1}` : 'other'
  }
}
const sortedKeys = (value) => Object.keys(record(value)).sort()
const inputTypes = (body) =>
  (Array.isArray(body?.input) ? body.input : []).map(
    (i) => `${i?.type}${i?.role ? `:${i.role}` : ''}`,
  )

function shapeOfBody(body, turn, threadId) {
  if (!body || typeof body !== 'object') return null
  const client = record(body.client_metadata)
  const meta = metadataOf(client['x-codex-turn-metadata'])
  return {
    keys: sortedKeys(body),
    clientMetadataKeys: sortedKeys(client),
    inputTypes: inputTypes(body),
    promptCacheKeyIsThread: body.prompt_cache_key === threadId,
    requestKind: meta.request_kind ?? null,
    turn: turn(meta.turn_id),
    clientTurn: turn(client.turn_id),
  }
}

function httpShape(pass, model) {
  const { threadId, turnIds } = pass.threads[model]
  const turn = labeller(turnIds)
  const mine = pass.seen.filter((s) => s.headers?.['thread-id'] === threadId)
  const upgrade = mine.find((s) => s.kind === 'upgrade')
  const post = mine.find(
    (s) => s.kind === 'http' && s.method === 'POST' && s.path.endsWith('/responses'),
  )
  return {
    websocketFirst: Boolean(upgrade),
    upgradeHeaderNames: upgrade ? sortedKeys(upgrade.headers) : [],
    upgradeTurnMetadataKeys: sortedKeys(metadataOf(upgrade?.headers?.['x-codex-turn-metadata'])),
    responsesHeaderNames: post ? sortedKeys(post.headers) : [],
    responsesTurnMetadataKeys: sortedKeys(metadataOf(post?.headers?.['x-codex-turn-metadata'])),
    responsesBody: shapeOfBody(post?.body, turn, threadId),
  }
}

function socketShapes(pass, model) {
  const { threadId, turnIds } = pass.threads[model]
  const turn = labeller(turnIds)
  const sockets = pass.seen.filter((s) => s.frames && s.headers['thread-id'] === threadId)
  const answered = sockets.flatMap((s) => s.frames.map((f) => f.id))
  const frameLabel = (id) => {
    if (typeof id !== 'string') return null
    const index = answered.indexOf(id)
    return index >= 0 ? `f${index}` : 'other'
  }
  return sockets.map((socket) => {
    const meta = metadataOf(socket.headers['x-codex-turn-metadata'])
    return {
      headerNames: sortedKeys(socket.headers),
      turnMetadataKeys: sortedKeys(meta),
      requestKind: meta.request_kind ?? null,
      turn: turn(meta.turn_id),
      frames: socket.frames.map(({ body, id }) => {
        const shape = shapeOfBody(body, turn, threadId)
        const client = record(body?.client_metadata)
        return {
          frame: frameLabel(id),
          type: body?.type ?? null,
          generate: typeof body?.generate === 'boolean' ? body.generate : null,
          previousResponse: frameLabel(body?.previous_response_id),
          sameThread: client.thread_id === threadId,
          turnMetadataKeys: sortedKeys(metadataOf(client['x-codex-turn-metadata'])),
          ...shape,
        }
      }),
    }
  })
}

const lite = httpShape(httpPass, GPT)
const fixture = {
  codexVersion: version,
  modelListIds: (httpPass.list.result?.data ?? []).map((m) => m.id),
  ...lite,
  notifications: [...new Set([...httpPass.events, ...wsPass.events])].sort(),
  plain: httpShape(httpPass, CLAUDE),
  websocket: { lite: socketShapes(wsPass, GPT), plain: socketShapes(wsPass, CLAUDE) },
}

// What the router's contract reads (src/codex-wire.mts), in every shape.
const missing = []
const need = (ok, what) => {
  if (!ok) missing.push(what)
}
need(fixture.modelListIds.includes(CLAUDE), `catalog entry "${CLAUDE}" in model/list`)
for (const [name, shape] of [
  ['http lite', lite],
  ['http plain', fixture.plain],
]) {
  for (const header of ['thread-id', 'session-id', 'x-codex-turn-metadata']) {
    need(shape.responsesHeaderNames.includes(header), `${name}: header ${header}`)
  }
  for (const key of ['thread_id', 'turn_id', 'request_kind', 'model', 'agent_name']) {
    need(shape.responsesTurnMetadataKeys.includes(key), `${name}: turn metadata ${key}`)
  }
  const client = shape.responsesBody?.clientMetadataKeys ?? []
  for (const key of ['x-codex-turn-metadata', 'turn_id']) {
    need(client.includes(key), `${name}: body client_metadata ${key}`)
  }
}
for (const [name, sockets] of Object.entries(fixture.websocket)) {
  const frames = sockets.flatMap((socket) => socket.frames)
  const turnFrames = frames.filter((frame) => frame.generate !== false)
  need(frames[0]?.generate === false, `websocket ${name}: a generate:false prewarm frame first`)
  need(
    sockets.some((socket) => socket.frames.filter((f) => f.generate !== false).length >= 2),
    `websocket ${name}: one socket carrying two turns`,
  )
  need(sockets.length >= 2, `websocket ${name}: a reconnect`)
  need(
    turnFrames.map((frame) => frame.turn).join() === 'T1,T2,T3,T4',
    `websocket ${name}: each turn frame's client_metadata turn metadata naming its own turn`,
  )
  need(
    turnFrames.every((frame) => frame.clientTurn === frame.turn),
    `websocket ${name}: client_metadata.turn_id on every turn frame`,
  )
  // The contract takes the thread from the socket's thread-id header first.
  need(
    frames.every((frame) => frame.sameThread),
    `websocket ${name}: every frame's client_metadata.thread_id equal to its socket's thread-id`,
  )
}
if (missing.length > 0) {
  console.error(`capture-codex-wire: ${version} is missing:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`capture-codex-wire: ${version} ok -> ${out}`)
