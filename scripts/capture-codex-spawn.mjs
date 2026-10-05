#!/usr/bin/env node
// Zero-spend recording of how a bundled codex announces a `spawn_agent` child
// and what the child's model requests carry. The claim design (a spawned
// Claude child runs on the adapter that owns its parent) rests on both.
//
// Runs `codex app-server` in an isolated CODEX_HOME logged in with a fake
// ChatGPT account (scripts/lib/fake-chatgpt-auth.mjs: unsigned JWTs), with
// openai_base_url on one loopback fake backend and chatgpt_base_url on a
// second. The first serves /models (a GPT entry and the router's `opus`
// clone, both multi-agent v1) and /responses: the first request of each
// parent turn gets one `exec` call running that step's multi-agent tools
// (tools.multi_agent_v1__*), later parent requests `done`, a child PONG. The
// second answers the ChatGPT login's workspace routing discovery (GET
// wham/accounts/check: 0.159 needs it, cached per account and base URL,
// before it sends a model request, and fails the turn without it) with an
// https workspace origin, and 404s everything else. The model backend's
// origin is neither, as the router's is neither chatgpt.com nor the
// workspace's, so the discovered routing is not applied to model requests,
// as in production.
//
// Why the ChatGPT login: an API-key login (--login apikey) is offered the
// same multi_agent_v1 tools and runs the same spawn, but its wire is not the
// one the app's codex sends: no /models fetch (the catalog has to come from
// model_catalog_json), plain JSON bodies instead of zstd over HTTP, and no
// x-codex-routing-hint or chatgpt-account-id header.
//
// Passes, each its own app-server and parent thread:
//   persisted http       persisted threads, as the app's; the fake answers
//                        every WebSocket upgrade with 426, so codex falls
//                        back to HTTP POST; one child. The primary recording.
//   persisted websocket  persisted; sockets accepted; two children spawned
//                        before the parent waits for either.
//   ephemeral http       an extra: the same as the first on an ephemeral
//                        thread, where the link and the child's own
//                        notifications arrive closer together.
//   shapes               persisted, one parent turn per spawn: no `model`
//                        (the child inherits the parent's), then
//                        `fork_context: true`.
//   follow-ups           persisted, one parent turn per call: spawn,
//                        send_input, close_agent, resume_agent, send_input.
// Between the turns of a pass the harness waits, on notifications, until the
// parent's turn and every child turn it started have completed.
//
// The order the fixture keeps is the one codex guarantees, not the order the
// notifications arrived in (orderInvariant): the parent's spawn item/started
// precedes its item/completed, which names the child (the link) and reaches
// the client before the child's first model request (in every run so far by
// about 70 ms or more); but notifications on the child's own thread
// (thread/status/changed, mcpServer/startupStatus/updated, even turn/started)
// may reach it before the link, by up to about 10 ms on persisted threads.
// So notifications are written in canonical order (each child's own after
// its link), and the capture checks the link against the first request. The
// timings, and how each child's notifications fell against its link, go to
// stdout only. Ids are labels (PARENT, CHILD, CHILD_n, TURN_<thread>,
// SPAWN_n): a rerun against the same codex writes the same bytes; Biome
// skips the file (biome.json), so commit it as written.
//
// Every codex call runs under sandbox-exec: loopback only, and no write
// under the real ~/.codex, ~/.anyengine and ~/.claude
// (scripts/lib/codex-probe.mjs). Each child request is read with the
// router's wire contract (src/codex-wire.mts; the probe builds first): the
// capture exits 1, naming what is missing, when a child is not linked, when
// its link does not precede its first model request, or when a child request
// does not name its own thread and its parent. If the multi-agent tools are
// not offered at all, it still writes the fixture (multiAgentToolsOffered:
// false) and exits 1 with the reason.
//
// Usage: node scripts/capture-codex-spawn.mjs [--codex PATH] [--out FILE] [--login chatgpt|apikey]
//   --codex  default: the app's bundled codex (src/bundled-codex.mts rule)
//   --out    default: test/fixtures/codex-spawn-<version>.json
//   --login  default: chatgpt (the fixture's login)
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'
import { WebSocketServer } from 'ws'
import {
  codexVersion,
  probeCodex,
  probeDirs,
  QUICK_MS,
  requireSandbox,
  sandboxed,
} from './lib/codex-probe.mjs'
import { writeFakeChatgptAuth } from './lib/fake-chatgpt-auth.mjs'
import {
  briefRequest,
  canonicalNotifications,
  childLink,
  childRequestsOf,
  httpChildRequest,
  isCollabItem,
  isResponsesPost,
  isSpawnItem,
  labelsFor,
  linkBeforeFirstRequest,
  linkEvent,
  noteOf,
  parseJson,
  record,
  socketOf,
  spawnedChildren,
  threadOfEvent,
  threadRead,
  toolsOf,
} from './lib/spawn-recording.mjs'

const NAME = 'capture-codex-spawn'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({
  options: {
    codex: { type: 'string' },
    out: { type: 'string' },
    login: { type: 'string', default: 'chatgpt' },
  },
})
if (!['chatgpt', 'apikey'].includes(values.login)) {
  console.error(`${NAME}: --login is chatgpt or apikey`)
  process.exit(2)
}

const codex = await probeCodex(repo, values.codex)
if (!codex) {
  console.error(`${NAME}: no bundled codex found; pass --codex`)
  process.exit(1)
}
requireSandbox(NAME)
const wire = await import(pathToFileURL(join(repo, 'dist', 'src', 'codex-wire.mjs')).href)
const { probe, home, work, env } = probeDirs('codex-spawn-probe-')
const run = sandboxed(codex)
const version = codexVersion(run, env)
if (!version) {
  console.error(`${NAME}: ${codex} --version gave no version`)
  process.exit(1)
}
const out = values.out ?? join(repo, 'test', 'fixtures', `codex-spawn-${version}.json`)

const GPT = 'gpt-spawn-probe'
const CLAUDE = 'opus'
const PONG = 'Reply with exactly the word PONG'
const PING = 'Reply with exactly the word PING'
const PANG = 'Reply with exactly the word PANG'
const SPAWN_TOOL = 'multi_agent_v1__spawn_agent'

const ORDER_INVARIANT =
  "The parent's collabAgentToolCall spawnAgent item/started precedes its item/completed, which names the child in receiverThreadIds (the link). The link reaches the client before the child's first model request, by about 70 ms or more in every run so far; the capture fails if it does not. Notifications on the child's own thread (thread/status/changed, mcpServer/startupStatus/updated, even turn/started) may reach the client before the link, by up to about 10 ms on persisted threads. No thread/started names a child. Notification lists here are in canonical order: the parent's own as observed, each child's own right after its link."

// The catalog the fake serves: a GPT entry that speaks responses-lite and
// the router's Claude clone of it (lite off), both multi-agent v1, as
// src/router-catalog.mts marks them while native fan-out is on.
function catalog() {
  const gpt = {
    slug: GPT,
    display_name: 'Spawn probe',
    description: NAME,
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

// --- Steps --------------------------------------------------------------------

// A step is one parent turn: `code(children)` is the JavaScript its exec
// call runs (`children` are the ids the spawns so far linked), and
// `childTurns` the child turns it starts, which the harness waits for.
const call = (tool, args) => `await tools.multi_agent_v1__${tool}(${JSON.stringify(args)})`
const spawnArgs = (message, extra = {}) => ({
  model: CLAUDE,
  reasoning_effort: 'low',
  message,
  ...extra,
})

function spawnAndWait(count) {
  const spawns = Array.from(
    { length: count },
    (_, i) => `const c${i} = ${call('spawn_agent', spawnArgs(PONG))}`,
  )
  const waits = Array.from(
    { length: count },
    (_, i) =>
      `await tools.multi_agent_v1__wait_agent({ targets: [c${i}.agent_id], timeout_ms: 30000 })`,
  )
  return {
    name: 'spawn_agent',
    code: () => [...spawns, ...waits, 'text("spawned")'].join('\n'),
    childTurns: count,
  }
}

const step = (name, args, childTurns) => ({
  name,
  args,
  code: (children) =>
    `${call(name, typeof args === 'function' ? args(children) : args)}\ntext("done")`,
  childTurns,
})

const SHAPE_STEPS = [
  step('spawn_agent', { reasoning_effort: 'low', message: PONG }, 1),
  step('spawn_agent', spawnArgs(PING, { fork_context: true }), 1),
]
const FOLLOW_UP_STEPS = [
  step('spawn_agent', spawnArgs(PONG), 1),
  step('send_input', ([child]) => ({ target: child, message: PING }), 1),
  step('close_agent', ([child]) => ({ target: child }), 0),
  step('resume_agent', ([child]) => ({ id: child }), 0),
  step('send_input', ([child]) => ({ target: child, message: PANG }), 1),
]

// --- The fake backends ----------------------------------------------------------

const scrub = (headers) =>
  Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k,
      /authorization|cookie/i.test(k) ? '<redacted>' : v,
    ]),
  )

// What the parent is offered: the multi-agent tools named in `exec`'s
// description, and the models spawn_agent lists as overrides.
function offerOf(body) {
  const exec = toolsOf(body).find(([name]) => name === 'exec')?.[1]
  const description = typeof exec?.description === 'string' ? exec.description : ''
  const tools = [...new Set(description.match(/multi_agent_v\d+__\w+/g) ?? [])].sort()
  // The section opens with "Available model overrides (...):" and one
  // "- `<slug>`: ..." line per model.
  const section = (description.split(`### \`${SPAWN_TOOL}\``)[1] ?? '').split('\n')
  const start = section.findIndex((line) => line.startsWith('Available model overrides'))
  const models = []
  for (const line of start >= 0 ? section.slice(start + 1) : []) {
    const match = /^- `([^`]+)`:/.exec(line)
    if (!match) break
    models.push(match[1])
  }
  return { exec: Boolean(exec), tools, spawnModelOverrides: models }
}

const message = (n, text) => ({
  id: `msg_spawn_${n}`,
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
})

// The answer to one request: the step's exec call for the first request of
// a parent turn, `done` for the parent's later ones, PONG for a child.
function outputFor(pass, headers, body, n) {
  const client = record(body?.client_metadata)
  const threadId = client.thread_id ?? headers['thread-id']
  // On a socket the tools come once, in the prewarm frame; a turn frame
  // after it carries only new input.
  if (threadId === pass.parent && !pass.offer?.exec) {
    const offer = offerOf(body)
    if (offer.exec || !pass.offer) pass.offer = offer
  }
  if (body?.generate === false) return []
  if (threadId !== pass.parent) return [message(n, 'PONG')]
  const turn = client.turn_id
  const step = pass.steps[pass.step]
  if (!turn || pass.issued.has(turn) || !step || !pass.offer?.tools.includes(SPAWN_TOOL))
    return [message(n, 'done')]
  pass.issued.add(turn)
  const input = step.code(spawnedChildren({ events: pass.all }))
  const id = `call_spawn_${n}`
  return [
    {
      id: `ctc_${n}`,
      type: 'custom_tool_call',
      status: 'completed',
      call_id: id,
      name: 'exec',
      input,
    },
  ]
}

// The fake model backend (openai_base_url).
async function startModelBackend(pass) {
  let responses = 0
  const answer = (headers, body, write) => {
    const n = ++responses
    const items = outputFor(pass, headers, body, n)
    const response = {
      id: `resp_spawn_${n}`,
      object: 'response',
      status: 'completed',
      model: body?.model,
      output: items,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }
    let seq = 0
    const send = (type, payload) => write({ type, sequence_number: seq++, ...payload })
    send('response.created', { response: { ...response, status: 'in_progress', output: [] } })
    items.forEach((item, i) => {
      send('response.output_item.done', { output_index: i, item })
    })
    send('response.completed', { response })
  }
  const server = http.createServer((req, res) => {
    const at = performance.now()
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let raw = Buffer.concat(chunks)
      if (req.headers['content-encoding'] === 'zstd') raw = zstdDecompressSync(raw)
      const body = parseJson(raw.toString('utf8'))
      const path = req.url.split('?')[0]
      const headers = scrub(req.headers)
      pass.requests.push({ kind: 'http', at, method: req.method, path, headers, body })
      if (path === '/backend-api/codex/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(catalog()))
        return
      }
      if (req.method !== 'POST' || path !== '/backend-api/codex/responses') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"detail":"not found"}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      answer(req.headers, body, (e) =>
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`),
      )
      res.end()
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const upgrade = {
      kind: 'upgrade',
      at: performance.now(),
      path: req.url.split('?')[0],
      headers: scrub(req.headers),
      frames: [],
    }
    pass.requests.push(upgrade)
    if (!pass.acceptWebSocket) {
      socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => {
        const body = parseJson(data.toString())
        upgrade.frames.push({ at: performance.now(), body })
        answer(req.headers, body, (event) => ws.send(JSON.stringify(event)))
      })
    })
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const close = () => {
    for (const client of wss.clients) client.terminate()
    server.close()
  }
  return { port: server.address().port, close }
}

// The fake ChatGPT backend (chatgpt_base_url): the workspace routing
// discovery of the fake account (an https workspace origin, as discovery
// requires), and a 404 for everything else (plugins, analytics, settings).
async function startChatgptBackend() {
  const server = http.createServer((req, res) => {
    req.resume()
    if (req.url.split('?')[0] === '/backend-api/wham/accounts/check') {
      const id = 'acct-anyengine-probe'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          accounts: [
            {
              id,
              plan_type: 'pro',
              workspace_backend_origin: 'https://workspace.invalid',
              account_routing_override: 'NO_CONSTRAINT',
              name: null,
              profile_picture_url: null,
              structure: 'personal',
            },
          ],
          account_ordering: [id],
          default_account_id: id,
        }),
      )
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"detail":"not found"}')
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  return { port: server.address().port, close: () => server.close() }
}

// --- Codex --------------------------------------------------------------------

function login() {
  if (values.login === 'chatgpt') {
    writeFakeChatgptAuth(home)
    const status = spawnSync(...run(['login', 'status']), {
      env,
      encoding: 'utf8',
      timeout: QUICK_MS,
    })
    const said = `${status.stdout ?? ''}${status.stderr ?? ''}`
    return /Logged in using ChatGPT/.test(said) ? null : `login status: ${said.trim()}`
  }
  const status = spawnSync(...run(['login', '--with-api-key']), {
    env,
    input: 'sk-anyengine-spawn-probe\n',
    encoding: 'utf8',
    timeout: QUICK_MS,
  })
  return status.status === 0 ? null : `fake API-key login failed: ${status.stderr}`
}

let running = null
const timer = setTimeout(() => {
  console.error(`${NAME}: timed out`)
  running?.kill('SIGKILL')
  process.exit(1)
}, 300_000)

// An app-server client over stdio: requests by id, every notification kept
// (in `events`) with the time it arrived.
function appServer(args, events) {
  const child = spawn(...run(args), { env, stdio: ['pipe', 'pipe', 'ignore'] })
  running = child
  const exited = new Promise((ok) => child.once('exit', ok))
  const pending = new Map()
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const m = parseJson(line)
    if (!m) return
    if (m.id != null && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method) events.push({ at: performance.now(), method: m.method, params: m.params })
  })
  let nextId = 0
  const request = (method, params) =>
    new Promise((ok) => {
      const id = ++nextId
      pending.set(id, ok)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  const stop = async () => {
    child.kill('SIGTERM')
    // codex writes into its home while it shuts down; the probe goes only after.
    await exited
    running = null
  }
  return { request, notify, stop }
}

const until = async (done, tries = 600) => {
  for (let i = 0; i < tries && !done(); i += 1) await new Promise((ok) => setTimeout(ok, 50))
}

// One app-server, one parent thread, one parent turn per step. `pass.events`
// keeps only what turn/start caused; `pass.windows[i]` is where step i's
// notifications begin.
async function runPass({ name, acceptWebSocket, ephemeral, steps }) {
  const pass = {
    name,
    acceptWebSocket,
    steps,
    step: 0,
    parent: null,
    offer: null,
    issued: new Set(),
    events: [],
    requests: [],
    reads: {},
    windows: [],
  }
  const all = []
  pass.all = all
  const model = await startModelBackend(pass)
  const chatgpt = await startChatgptBackend()
  const args = [
    '-c',
    `openai_base_url="http://127.0.0.1:${model.port}/backend-api/codex"`,
    '-c',
    `chatgpt_base_url="http://127.0.0.1:${chatgpt.port}/backend-api/"`,
    '-c',
    'mcp_servers={}',
    '-c',
    'notify=[]',
    '-c',
    'features.code_mode_host=true',
  ]
  // An API key fetches no /models; the catalog comes from the file.
  if (values.login === 'apikey') args.push('-c', `model_catalog_json="${catalogFile}"`)
  const server = appServer([...args, 'app-server'], all)
  await server.request('initialize', {
    clientInfo: { name: 'anyengine-spawn', version: '0' },
    capabilities: { experimentalApi: true },
  })
  server.notify('initialized')
  pass.list = await server.request('model/list', { includeHidden: true, limit: 100 })
  const started = await server.request('thread/start', {
    model: GPT,
    cwd: work,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    ephemeral,
  })
  pass.parent = started.result?.thread?.id ?? null
  // The parent's own thread/started can trail the thread/start answer; the
  // recording starts after it, with what turn/start causes.
  await until(() =>
    all.some((e) => e.method === 'thread/started' && threadOfEvent(e) === pass.parent),
  )
  const from = all.length
  const count = (method, mine) =>
    all.filter((e) => e.method === method && mine(threadOfEvent(e))).length
  const isParent = (id) => id === pass.parent
  const isChild = (id) => Boolean(id) && id !== pass.parent
  let childTurns = 0
  for (let i = 0; i < steps.length && pass.parent; i += 1) {
    pass.step = i
    pass.windows.push(all.length - from)
    const parentDone = count('turn/completed', isParent)
    childTurns += steps[i].childTurns
    await server.request('turn/start', {
      threadId: pass.parent,
      input: [{ type: 'text', text: `Step ${i + 1}: ${steps[i].name}` }],
      effort: 'low',
    })
    await until(
      () =>
        count('turn/completed', isParent) > parentDone &&
        count('turn/completed', isChild) >= childTurns,
    )
  }
  pass.events = all.slice(from)
  for (const id of spawnedChildren(pass)) {
    pass.reads[id] = await server.request('thread/read', { threadId: id })
  }
  await server.stop()
  model.close()
  chatgpt.close()
  pass.offer ??= { exec: false, tools: [], spawnModelOverrides: [] }
  return pass
}

// --- Checks ---------------------------------------------------------------------

// Every child request, read as the router reads it (src/codex-wire.mts):
// its own thread, and its parent from the body alone and the header alone.
function contractProblems(pass, children) {
  const problems = []
  for (const child of children) {
    const bodies = childRequestsOf(pass, child).flatMap((r) =>
      r.kind === 'http' ? [[r.headers, r.body]] : r.frames.map((f) => [r.headers, f.body]),
    )
    if (bodies.length === 0) problems.push(`${pass.name}: no model request from a spawned child`)
    for (const [headers, body] of bodies) {
      if (wire.threadIdOfRequest(headers, body) !== child)
        problems.push(`${pass.name}: a child request that does not name its own thread`)
      if (wire.parentThreadIdOfRequest({}, body) !== pass.parent)
        problems.push(`${pass.name}: a child request whose body does not name its parent`)
      if (wire.parentThreadIdOfRequest(headers, null) !== pass.parent)
        problems.push(`${pass.name}: a child request whose headers do not name its parent`)
    }
  }
  return [...new Set(problems)]
}

// Every child is linked, starts a turn, and its link precedes its first
// model request.
function linkProblems(pass, children, expected) {
  const problems = []
  if (children.length !== expected)
    problems.push(`${pass.name}: ${children.length} children linked, not ${expected}`)
  for (const child of children) {
    const turn = pass.events.some((e) => e.method === 'turn/started' && threadOfEvent(e) === child)
    if (!turn) problems.push(`${pass.name}: a linked child never starts a turn`)
    if (!linkBeforeFirstRequest(pass, child))
      problems.push(`${pass.name}: a child's first model request came before its link`)
  }
  return problems
}

// --- Timings (stdout only) ------------------------------------------------------

function timings(pass, labels) {
  const ms = (a, b) => (a == null || b == null ? 'n/a' : `${(b - a).toFixed(1)} ms`)
  return labels.children.map((child) => {
    const done = linkEvent(pass, child)
    const started = pass.events.find(
      (e) =>
        e.method === 'item/started' &&
        isSpawnItem(e.params?.item) &&
        e.params.item.id === done?.params?.item?.id,
    )
    const turn = pass.events.find((e) => e.method === 'turn/started' && threadOfEvent(e) === child)
    const named = pass.all.find((e) => threadOfEvent(e) === child)
    const first = childRequestsOf(pass, child)[0]?.at
    return `${pass.name} ${labels.label(child)}: spawn item started -> link ${ms(started?.at, done?.at)}; link -> child turn/started ${ms(done?.at, turn?.at)}; child first named by ${named?.method} ${ms(done?.at, named?.at)} after the link; link -> first model request ${ms(done?.at, first)}`
  })
}

// --- The fixture ----------------------------------------------------------------

const childThreadStarted = (pass, children) =>
  pass.all.some((e) => e.method === 'thread/started' && children.includes(threadOfEvent(e)))

// The primary recording (and the ephemeral extra): one child over HTTP.
function httpRecording(pass) {
  const labels = labelsFor(pass, () => 'CHILD')
  const [child] = labels.children
  return {
    labels,
    part: {
      notifications: canonicalNotifications(pass, labels),
      childThreadStarted: childThreadStarted(pass, labels.children),
      linkBeforeFirstModelRequest: child ? linkBeforeFirstRequest(pass, child) : false,
      childThread: child ? threadRead(pass, child, labels) : null,
      childRequest: child ? httpChildRequest(pass, child, labels) : null,
    },
  }
}

function websocketRecording(pass) {
  const labels = labelsFor(pass, (i) => `CHILD_${i + 1}`)
  const { children } = labels
  return {
    labels,
    part: {
      threads: 'persisted',
      spawned: children.length,
      childThreadStarted: childThreadStarted(pass, children),
      links: children.map((child) => ({
        child: labels.label(child),
        notifications: childLink(pass, child, labels),
        linkBeforeFirstModelRequest: linkBeforeFirstRequest(pass, child),
      })),
      childThreads: children.map((child) => threadRead(pass, child, labels)),
      sockets: children.map((child) => socketOf(pass, child, labels)),
    },
  }
}

// One spawn shape: its link and the child's first model request, in brief.
function shapeOf(pass, child, labels) {
  const post = childRequestsOf(pass, child).find(isResponsesPost)
  return {
    notifications: childLink(pass, child, labels),
    linkBeforeFirstModelRequest: linkBeforeFirstRequest(pass, child),
    childRequest: post ? briefRequest(post, labels) : null,
  }
}

function shapesRecording(pass) {
  const labels = labelsFor(pass, (i) => ['CHILD_INHERIT', 'CHILD_FORK'][i] ?? `CHILD_${i + 1}`)
  const [inherit, fork] = labels.children
  return {
    labels,
    part: {
      inheritModel: inherit
        ? { spawnArgs: SHAPE_STEPS[0].args, ...shapeOf(pass, inherit, labels) }
        : null,
      forkContext: fork ? { spawnArgs: SHAPE_STEPS[1].args, ...shapeOf(pass, fork, labels) } : null,
    },
  }
}

// The follow-ups, step by step: the parent's collab items in the step (in
// order: one thread), and what happened on the child's thread in it.
function followUpsRecording(pass) {
  const labels = labelsFor(pass, () => 'CHILD')
  const [child] = labels.children
  const bounds = [...pass.windows, pass.events.length]
  const steps = pass.steps.map((s, i) => {
    const window = pass.events.slice(bounds[i], bounds[i + 1])
    const mine = window.filter((e) => threadOfEvent(e) === child)
    return {
      call: s.name,
      parentItems: window
        .filter((e) => threadOfEvent(e) === pass.parent && isCollabItem(e.params?.item))
        .filter((e) => e.params.item.tool !== 'wait')
        .map((e) => noteOf(e, labels)),
      childTurnsStarted: mine.filter((e) => e.method === 'turn/started').length,
      childUnloaded: mine.some(
        (e) => e.method === 'thread/status/changed' && e.params?.status?.type === 'notLoaded',
      ),
      childWarnings: mine
        .filter((e) => e.method === 'warning')
        .map((e) => labels.label(e.params?.message ?? null)),
    }
  })
  return {
    labels,
    part: {
      steps,
      childRequests: child
        ? childRequestsOf(pass, child)
            .filter(isResponsesPost)
            .map((r) => briefRequest(r, labels))
        : [],
    },
  }
}

// --- Run ------------------------------------------------------------------------

const missing = []
let fixture
const loginProblem = login()
if (loginProblem) {
  missing.push(`the fake ${values.login} login was refused (${loginProblem})`)
  fixture = { codexVersion: version, login: values.login, multiAgentToolsOffered: false }
} else {
  const primary = await runPass({
    name: 'persisted http',
    acceptWebSocket: false,
    ephemeral: false,
    steps: [spawnAndWait(1)],
  })
  const offered = primary.offer.tools.includes(SPAWN_TOOL)
  const passes = offered
    ? {
        websocket: await runPass({
          name: 'persisted websocket',
          acceptWebSocket: true,
          ephemeral: false,
          steps: [spawnAndWait(2)],
        }),
        ephemeral: await runPass({
          name: 'ephemeral http',
          acceptWebSocket: false,
          ephemeral: true,
          steps: [spawnAndWait(1)],
        }),
        shapes: await runPass({
          name: 'shapes',
          acceptWebSocket: false,
          ephemeral: false,
          steps: SHAPE_STEPS,
        }),
        followUps: await runPass({
          name: 'follow-ups',
          acceptWebSocket: false,
          ephemeral: false,
          steps: FOLLOW_UP_STEPS,
        }),
      }
    : {}
  const h = httpRecording(primary)
  fixture = {
    codexVersion: version,
    login: values.login,
    threads: 'persisted',
    orderInvariant: ORDER_INVARIANT,
    modelListIds: (primary.list?.result?.data ?? []).map((m) => m.id),
    multiAgentToolsOffered: offered,
    multiAgentTools: primary.offer.tools,
    spawnModelOverrides: primary.offer.spawnModelOverrides,
    spawnVia: offered ? `exec:tools.${SPAWN_TOOL}` : null,
    ...h.part,
  }
  if (!primary.offer.exec) missing.push('the parent was offered no exec tool')
  if (!offered) missing.push(`exec's description does not list ${SPAWN_TOOL}`)
  if (offered) {
    const w = websocketRecording(passes.websocket)
    const e = httpRecording(passes.ephemeral)
    const s = shapesRecording(passes.shapes)
    const f = followUpsRecording(passes.followUps)
    fixture.websocket = w.part
    const { childThread: _thread, childRequest: _request, ...ephemeralPart } = e.part
    fixture.ephemeral = { threads: 'ephemeral', ...ephemeralPart }
    fixture.shapes = { ...s.part, followUps: f.part }
    const recorded = [
      [primary, h.labels, 1],
      [passes.websocket, w.labels, 2],
      [passes.ephemeral, e.labels, 1],
      [passes.shapes, s.labels, 2],
      [passes.followUps, f.labels, 1],
    ]
    for (const [pass, labels, expected] of recorded) {
      missing.push(...linkProblems(pass, labels.children, expected))
      missing.push(...contractProblems(pass, labels.children))
      for (const line of timings(pass, labels)) console.log(`${NAME}: ${line}`)
    }
    const calls = f.part.steps.flatMap((s) => s.parentItems.map((n) => n.item?.tool))
    for (const tool of ['sendInput', 'closeAgent', 'resumeAgent'])
      if (!calls.includes(tool)) missing.push(`follow-ups: no ${tool} item`)
  }
}

clearTimeout(timer)
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`)
if (missing.length > 0) {
  console.error(`${NAME}: ${version} -> ${out}, but:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}
console.log(`${NAME}: ${version} ok -> ${out}`)
