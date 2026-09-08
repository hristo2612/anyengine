#!/usr/bin/env node
// Real smoke for the cross-engine bridge (docs/guide/bridge.md). Boots the
// adapter on a WebSocket listener with the host's runtime.env, starts ONE
// calling thread on the chosen engine and asks the model to use the
// `jinn_bridge` MCP tools; records every notification the App would see and
// asserts the cross-engine answer made it back.
//
//   source ~/.claude-codex/runtime.env
//   node scripts/smoke-bridge.mjs claude   # sonnet thread spawns a grok-4.6 session (port 8797)
//   node scripts/smoke-bridge.mjs grok     # grok thread fans out 2x haiku + 2x grok sub-agents (8798)
//   node scripts/smoke-bridge.mjs gpt      # gpt thread (native child) spawns a haiku session (8799);
//                                          # a usageLimitExceeded turn is recorded, not failed
//   node scripts/smoke-bridge.mjs natural  # NO tool names: "spawn another session with claude opus
//                                          # and say hi" in a sonnet thread, then "spawn 4 sub-agents,
//                                          # 2 with grok and 2 with claude, ..." in a grok thread (8796)
//   CLAUDE_CODEX_SMOKE_PORT / CLAUDE_CODEX_SMOKE_MODEL / CLAUDE_CODEX_SMOKE_CWD override.
// The adapter process it spawns is the only pid it kills. Report + debug log
// land under .claude-codex/bridge-smoke-<engine>-<stamp>/.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

const engine = ['claude', 'grok', 'gpt', 'natural'].includes(process.argv[2])
  ? process.argv[2]
  : 'claude'
const repo = resolve(process.cwd())
const cwd = resolve(
  process.env.CLAUDE_CODEX_SMOKE_CWD ?? join(repo, '.claude-codex', 'bridge-smoke'),
)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const home = join(repo, '.claude-codex', `bridge-smoke-${engine}-${stamp}`)
await mkdir(cwd, { recursive: true })
await mkdir(home, { recursive: true })
const port = Number(
  process.env.CLAUDE_CODEX_SMOKE_PORT ??
    { claude: 8797, grok: 8798, gpt: 8799, natural: 8796 }[engine],
)
const listen = `ws://127.0.0.1:${port}`
const debugLog = join(home, 'debug.jsonl')
const TURN_TIMEOUT_MS = 420_000

const log = (line) => console.log(`[smoke-bridge:${engine}] ${line}`)
const t0 = Date.now()
const ms = () => Date.now() - t0

const env = {
  ...process.env,
  CLAUDE_CODEX_MOCK: '',
  // The adapter's own store/log are isolated; CODEX_HOME stays the real one
  // so the native child (gpt) finds the ChatGPT login.
  CLAUDE_CODEX_HOME: join(home, 'adapter-home'),
  CLAUDE_CODEX_DEBUG_LOG: debugLog,
  CLAUDE_CODEX_RUNTIME_TYPE: 'jinn-pty',
  CLAUDE_CODEX_SUBAGENT_COMPLETED: '1',
  NODE_NO_WARNINGS: '1',
}
if (engine !== 'gpt') env.CLAUDE_CODEX_NATIVE_CODEX = '0'
else delete env.CLAUDE_CODEX_NATIVE_CODEX

const adapter = spawn(
  process.execPath,
  [resolve('dist/src/adapter.mjs'), 'app-server', '--listen', listen],
  { stdio: ['ignore', 'pipe', 'pipe'], env },
)
log(`adapter pid=${adapter.pid} listen=${listen} home=${home}`)
const adapterStderr = []
adapter.stderr.setEncoding('utf8')
adapter.stderr.on('data', (chunk) => {
  adapterStderr.push(chunk)
  process.stderr.write(chunk)
})
adapter.stdout.setEncoding('utf8')
adapter.stdout.on('data', (chunk) => process.stderr.write(chunk))

const trace = []
const report = { engine, port, cwd, home, debugLog, adapterPid: adapter.pid, turns: [] }

function finish(code) {
  adapter.kill('SIGTERM')
  const out = join(home, 'report.json')
  writeFile(out, JSON.stringify({ ...report, trace }, null, 2)).finally(() => {
    log(`report ${out}`)
    setTimeout(() => process.exit(code), 1500)
  })
}

async function connect() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const ws = new WebSocket(listen)
      await new Promise((res, rej) => {
        ws.once('open', res)
        ws.once('error', rej)
      })
      return ws
    } catch {
      await new Promise((res) => setTimeout(res, 200))
    }
  }
  throw new Error(`adapter did not listen on ${listen}`)
}

class Rpc {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.queue = []
    this.waiters = []
    ws.on('message', (data) => {
      const message = JSON.parse(String(data))
      if (message.id != null && message.method == null) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) {
          const err = new Error(message.error.message)
          err.data = message.error.data
          pending.reject(err)
        } else pending.resolve(message.result)
        return
      }
      const waiter = this.waiters.shift()
      if (waiter) waiter(message)
      else this.queue.push(message)
    })
  }
  request(method, params) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  respond(id, result) {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
  }
  next(timeoutMs) {
    const existing = this.queue.shift()
    if (existing) return Promise.resolve(existing)
    return new Promise((res, rej) => {
      let timer
      const waiter = (m) => {
        clearTimeout(timer)
        res(m)
      }
      timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter)
        if (idx >= 0) this.waiters.splice(idx, 1)
        rej(new Error(`no notification for ${timeoutMs} ms`))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }
}

function describe(message) {
  const p = message.params ?? {}
  const item = p.item ?? {}
  const entry = { t: ms(), method: message.method, threadId: p.threadId ?? null }
  if (item.type) entry.itemType = item.type
  if (item.tool) entry.tool = item.tool
  if (item.type === 'mcpToolCall') entry.tool = `${item.server ?? ''}/${item.tool ?? ''}`
  if (item.type === 'collabAgentToolCall') entry.receivers = item.receiverThreadIds
  if (item.type === 'subAgentActivity') entry.kind = item.kind
  if (item.type === 'agentMessage') entry.text = String(item.text ?? '').slice(0, 300)
  if (message.method === 'thread/started') {
    entry.threadId = p.thread?.id ?? entry.threadId
    entry.parentThreadId = p.thread?.parentThreadId ?? null
    entry.model = p.thread?.modelProvider ?? null
  }
  if (message.method === 'error') entry.error = p
  if (message.method?.endsWith('requestApproval')) entry.command = p.command ?? '<fileChange>'
  return entry
}

// Runs one turn on `threadId`; keeps consuming notifications until that
// thread's turn/completed. Child-thread traffic (spawned sessions/sub-agents)
// is recorded on the way.
async function runTurn(rpc, threadId, text, label) {
  const started = Date.now()
  const turn = {
    label,
    prompt: text,
    status: null,
    streamedText: '',
    finalMessages: [],
    notifications: [],
    childThreads: [],
    childTexts: {},
    approvals: [],
    errors: [],
    durationMs: null,
  }
  let res
  try {
    res = await rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
  } catch (error) {
    turn.status = 'startFailed'
    turn.errors.push(error.message)
    turn.startError = { message: error.message, data: error.data ?? null }
    report.turns.push(turn)
    log(`${label}: turn/start failed: ${error.message}`)
    return turn
  }
  turn.turnId = res.turn?.id ?? null
  log(`${label}: turn/start -> ${res.turn?.status}`)
  const deadline = Date.now() + TURN_TIMEOUT_MS
  while (turn.status == null) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      turn.status = 'timeout'
      turn.errors.push(`turn did not complete within ${TURN_TIMEOUT_MS} ms`)
      break
    }
    let message
    try {
      message = await rpc.next(remaining)
    } catch (err) {
      turn.status = 'timeout'
      turn.errors.push(String(err.message))
      break
    }
    const entry = describe(message)
    trace.push(entry)
    turn.notifications.push(entry)
    const p = message.params ?? {}
    switch (message.method) {
      case 'item/agentMessage/delta':
        if (p.threadId === threadId) turn.streamedText += p.delta
        else turn.childTexts[p.threadId] = (turn.childTexts[p.threadId] ?? '') + p.delta
        break
      case 'item/completed':
        if (p.item?.type === 'agentMessage') {
          if (p.threadId === threadId) turn.finalMessages.push(p.item.text)
          else turn.childTexts[p.threadId] = p.item.text
        }
        break
      case 'thread/started':
        if (p.thread?.id && p.thread.id !== threadId)
          turn.childThreads.push({
            id: p.thread.id,
            parentThreadId: p.thread.parentThreadId ?? null,
          })
        break
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'item/permissions/requestApproval':
        turn.approvals.push(p.command ?? message.method)
        log(`${label}: approval requested (${p.command ?? message.method}) -> accept`)
        rpc.respond(message.id, { decision: 'accept' })
        break
      case 'item/tool/requestUserInput':
        turn.approvals.push('<userInput>')
        rpc.respond(message.id, { answers: {} })
        break
      case 'error':
        turn.errors.push(JSON.stringify(p))
        log(`${label}: error notification ${JSON.stringify(p).slice(0, 300)}`)
        break
      case 'turn/completed':
        if (p.threadId === threadId) turn.status = p.turn?.status ?? 'completed'
        break
      default:
        break
    }
  }
  turn.durationMs = Date.now() - started
  const methods = {}
  for (const n of turn.notifications) {
    const key = n.itemType ? `${n.method}(${n.itemType}${n.tool ? `:${n.tool}` : ''})` : n.method
    methods[key] = (methods[key] ?? 0) + 1
  }
  turn.methodCounts = methods
  log(
    `${label}: status=${turn.status} ${turn.durationMs} ms children=${turn.childThreads.length} approvals=${turn.approvals.length} errors=${turn.errors.length}`,
  )
  log(`${label}: final=${JSON.stringify(turn.finalMessages.map((t) => t.trim().slice(0, 300)))}`)
  log(`${label}: streamed=${JSON.stringify(turn.streamedText.trim().slice(0, 300))}`)
  log(`${label}: methods=${JSON.stringify(methods)}`)
  report.turns.push(turn)
  return turn
}

function debugSummary() {
  if (!existsSync(debugLog)) return { present: false }
  const lines = readFileSync(debugLog, 'utf8').split('\n').filter(Boolean)
  const counts = {}
  const bridge = []
  const errors = []
  for (const line of lines) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const ev = e.event ?? 'unknown'
    counts[ev] = (counts[ev] ?? 0) + 1
    if (ev.startsWith('bridge.')) bridge.push(line.slice(0, 300))
    if (/error|fail|denied|timeout|unauthorized/i.test(ev)) errors.push(line.slice(0, 300))
  }
  return {
    present: true,
    lines: lines.length,
    counts,
    bridge: bridge.slice(0, 40),
    errors: errors.slice(0, 20),
  }
}

const PROMPTS = {
  claude:
    'Use the spawn_session tool from the jinn_bridge MCP server to start a session with model "grok-4.6" and the prompt "Reply with exactly the single word GROKPONG". Then reply with exactly: GROK SAID: <the text it answered>',
  grok: 'Use the spawn_subagents tool from the jinn_bridge MCP server exactly once, with four tasks: name "h1" model "haiku" prompt "Reply with exactly the single word APPLE"; name "h2" model "haiku" prompt "Reply with exactly the single word BANANA"; name "g1" model "grok-4.6" prompt "Reply with exactly the single word CHERRY"; name "g2" model "grok-4.6" prompt "Reply with exactly the single word DATE". When it returns, reply with exactly: h1=<word> h2=<word> g1=<word> g2=<word>',
  gpt: 'Use the spawn_session tool from the jinn_bridge MCP server to start a session with model "haiku" and the prompt "Reply with exactly the single word HAIKUPONG". Then reply with exactly: HAIKU SAID: <the text it answered>',
}
const EXPECT = {
  claude: ['GROKPONG'],
  grok: ['APPLE', 'BANANA', 'CHERRY', 'DATE'],
  gpt: ['HAIKUPONG'],
}

// The two prompts the standing instructions must make "just work", verbatim
// (docs/guide/bridge.md, "Natural language").
const NATURAL_PROMPTS = {
  session: 'spawn another session with claude opus and say hi',
  fanout:
    'spawn 4 sub-agents, 2 with grok and 2 with claude, each should reply with a different fruit, then list what they said',
}
const FRUITS = [
  'apple',
  'banana',
  'cherry',
  'date',
  'fig',
  'grape',
  'kiwi',
  'lemon',
  'lime',
  'mango',
  'melon',
  'orange',
  'papaya',
  'peach',
  'pear',
  'pineapple',
  'plum',
  'strawberry',
  'watermelon',
  'blueberry',
  'raspberry',
  'apricot',
  'pomegranate',
  'guava',
  'lychee',
  'coconut',
  'blackberry',
  'tangerine',
  'nectarine',
  'dragonfruit',
  'passionfruit',
]

// Parsed debug.jsonl rows for one bridge event (what the bridge resolved,
// e.g. `model` after alias resolution).
function bridgeEvents(name) {
  if (!existsSync(debugLog)) return []
  return readFileSync(debugLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((e) => e && e.event === name)
}

async function startThread(rpc, model) {
  const started = await rpc.request('thread/start', {
    cwd,
    model,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  })
  log(
    `thread ${started.thread.id} model=${started.model} provider=${started.modelProvider} cwd=${cwd}`,
  )
  return started.thread.id
}

// Prompt 1 in a sonnet thread, prompt 2 in a grok thread; neither names a
// tool. Asserts the children the bridge actually spawned (from debug.jsonl)
// and the relayed text.
async function naturalMode(rpc, models) {
  const grokModel = models.find((id) => /^grok/i.test(id)) ?? 'grok-4.6'
  const claudeIds = new Set(models.filter((id) => !/^(grok|gpt|o[0-9]|codex)/i.test(id)))
  const problems = []
  const natural = { session: null, fanout: null }

  const sonnetThread = await startThread(rpc, 'sonnet')
  const t1 = await runTurn(rpc, sonnetThread, NATURAL_PROMPTS.session, 'natural1-claude')
  const spawned = bridgeEvents('bridge.spawnSession').filter(
    (e) => e.callerThreadId === sonnetThread,
  )
  const t1Text = `${t1.finalMessages.join('\n')}\n${t1.streamedText}`
  natural.session = {
    threadId: sonnetThread,
    status: t1.status,
    spawned: spawned.map((e) => ({ threadId: e.threadId, model: e.model })),
    childTexts: t1.childTexts,
    final: t1.finalMessages.map((t) => t.trim().slice(0, 300)),
  }
  if (t1.status !== 'completed') problems.push(`prompt 1: turn status ${t1.status}`)
  if (spawned.length !== 1)
    problems.push(`prompt 1: expected 1 spawned session, got ${spawned.length}`)
  if (spawned[0] && spawned[0].model !== 'opus')
    problems.push(`prompt 1: spawned model ${spawned[0].model}, expected opus`)
  if (!/\b(hi|hello|hey|greetings)\b/i.test(t1Text)) problems.push('prompt 1: no greeting relayed')
  log(
    `prompt 1: spawned=${JSON.stringify(natural.session.spawned)} final=${JSON.stringify(natural.session.final)}`,
  )

  const grokThread = await startThread(rpc, grokModel)
  const t2 = await runTurn(rpc, grokThread, NATURAL_PROMPTS.fanout, 'natural2-grok')
  const children = bridgeEvents('bridge.spawnSubagent').filter(
    (e) => e.parentThreadId === grokThread,
  )
  const t2Text = `${t2.finalMessages.join('\n')}\n${t2.streamedText}`.toLowerCase()
  const fruits = FRUITS.filter((fruit) => new RegExp(`\\b${fruit}s?\\b`).test(t2Text))
  const grokChildren = children.filter((e) => /^grok/i.test(e.model))
  const claudeChildren = children.filter((e) => claudeIds.has(e.model))
  natural.fanout = {
    threadId: grokThread,
    status: t2.status,
    children: children.map((e) => ({ name: e.name, threadId: e.childThreadId, model: e.model })),
    childTexts: t2.childTexts,
    fruits,
    final: t2.finalMessages.map((t) => t.trim().slice(0, 400)),
  }
  if (t2.status !== 'completed') problems.push(`prompt 2: turn status ${t2.status}`)
  if (children.length !== 4)
    problems.push(`prompt 2: expected 4 sub-agents, got ${children.length}`)
  if (grokChildren.length !== 2 || grokChildren.some((e) => e.model !== grokModel))
    problems.push(
      `prompt 2: expected 2x ${grokModel}, got ${JSON.stringify(grokChildren.map((e) => e.model))}`,
    )
  if (claudeChildren.length !== 2)
    problems.push(
      `prompt 2: expected 2 Claude sub-agents, got ${JSON.stringify(claudeChildren.map((e) => e.model))}`,
    )
  if (fruits.length < 3)
    problems.push(`prompt 2: only ${fruits.length} distinct fruits in the final text`)
  log(
    `prompt 2: children=${JSON.stringify(natural.fanout.children)} fruits=${JSON.stringify(fruits)}`,
  )
  log(`prompt 2: final=${JSON.stringify(natural.fanout.final)}`)

  report.natural = natural
  report.problems = problems
  report.verdict = problems.length === 0 ? 'pass' : 'fail'
  log(`verdict=${report.verdict} problems=${JSON.stringify(problems)}`)
  return grokThread
}

try {
  const ws = await connect()
  const rpc = new Rpc(ws)
  await rpc.request('initialize', {
    clientInfo: { name: 'smoke-bridge', title: 'Smoke', version: '0' },
    capabilities: { subAgentActivityKinds: ['started', 'completed'] },
  })
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }))
  const models = await rpc.request('model/list', {})
  report.models = models.data.map((m) => m.id)
  log(`model/list: ${report.models.join(', ')}`)
  let model = process.env.CLAUDE_CODEX_SMOKE_MODEL
  if (!model) {
    if (engine === 'claude' || engine === 'natural') model = 'sonnet'
    else if (engine === 'grok') model = report.models.find((id) => /^grok/i.test(id)) ?? 'grok-4.6'
    else model = report.models.find((id) => /^gpt/i.test(id)) ?? 'gpt-5.6-sol'
  }
  report.model = model

  if (engine === 'gpt') {
    // With the native child attached, mcpServerStatus/list is the child's:
    // prove the bridge is registered for the GPT side even if the turn
    // cannot run (quota), and record the codex_app create_thread schema.
    try {
      const status = await rpc.request('mcpServerStatus/list', { cursor: null, limit: 100 })
      const servers = (status.data ?? []).map((s) => ({
        name: s.name,
        tools: Object.keys(s.tools ?? {}),
        authStatus: s.authStatus ?? null,
      }))
      report.mcpServers = servers
      log(`mcpServerStatus/list: ${JSON.stringify(servers).slice(0, 1200)}`)
      const codexApp = (status.data ?? []).find((s) => s.name === 'codex_app')
      const createThread = codexApp?.tools?.create_thread ?? codexApp?.tools?.createThread ?? null
      report.codexAppCreateThreadSchema = createThread?.inputSchema ?? null
      if (createThread)
        log(`codex_app create_thread schema: ${JSON.stringify(createThread.inputSchema)}`)
      else log('codex_app MCP not listed (the desktop injects it; absent outside the App)')
    } catch (error) {
      report.mcpServersError = error.message
      log(`mcpServerStatus/list failed: ${error.message}`)
    }
  }

  let threadId
  if (engine === 'natural') {
    threadId = await naturalMode(rpc, report.models)
    report.threadId = threadId
  } else {
    threadId = await startThread(rpc, model)
    report.threadId = threadId
    const turn = await runTurn(rpc, threadId, PROMPTS[engine], 'turn1-bridge')
    const usageLimited =
      engine === 'gpt' &&
      (turn.startError?.data === 'usageLimitExceeded' ||
        /usage ?limit|usageLimitExceeded|quota/i.test(JSON.stringify(turn.errors)))
    if (usageLimited) {
      report.verdict = 'usage-limited'
      log('GPT turn hit the usage limit; recorded, skipping the assertion')
    } else {
      const text = `${turn.finalMessages.join('\n')}\n${turn.streamedText}`
      const missing = EXPECT[engine].filter((word) => !text.includes(word))
      report.expected = EXPECT[engine]
      report.missing = missing
      report.verdict = turn.status === 'completed' && missing.length === 0 ? 'pass' : 'fail'
      log(
        `verdict=${report.verdict} missing=${JSON.stringify(missing)} children=${JSON.stringify(turn.childThreads)}`,
      )
    }
  }
  try {
    const read = await rpc.request('thread/read', { threadId, includeTurns: true })
    const items = read.thread?.turns?.flatMap((t) => t.items ?? []) ?? []
    report.persistedItems = items.map((i) => `${i.type}${i.tool ? `:${i.tool}` : ''}`)
    log(`thread/read items=${JSON.stringify(report.persistedItems)}`)
  } catch (err) {
    report.threadReadError = String(err.message)
  }
  report.debug = debugSummary()
  log(`debug.jsonl bridge events: ${JSON.stringify(report.debug.bridge).slice(0, 1500)}`)
  if (report.debug.errors?.length)
    log(`debug errors: ${JSON.stringify(report.debug.errors).slice(0, 1200)}`)
  report.adapterStderr = adapterStderr.join('').slice(-2000)
  ws.close()
  finish(report.verdict === 'fail' ? 1 : 0)
} catch (error) {
  console.error(error)
  report.fatal = String(error?.stack ?? error)
  report.debug = debugSummary()
  finish(1)
}
