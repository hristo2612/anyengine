#!/usr/bin/env node
// Sub-agent smoke for the two local runtimes (anyengine Claude, grok ACP).
// Boots the adapter on a WebSocket listener, starts a thread with an
// approval-free policy, asks the model to fan out to two sub-agents, and
// records every notification the App would see (method, item type, tool),
// the streamed vs. final text, timings, and adapter debug/error events.
//
// Usage:
//   source ~/.claude-codex/runtime.env
//   ANYENGINE_NATIVE_CODEX=0 node scripts/smoke-subagents.mjs claude   # port 8795
//   ANYENGINE_NATIVE_CODEX=0 node scripts/smoke-subagents.mjs grok     # port 8796
//   ANYENGINE_SMOKE_PORT / ANYENGINE_SMOKE_MODEL / ANYENGINE_SMOKE_CWD override;
//   ANYENGINE_SMOKE_TURN_GAP_MS waits (and records stray notifications) between turns.
// The adapter process it spawns is the only pid it kills.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

const runtime = process.argv[2] === 'grok' ? 'grok' : 'claude'
const repo = resolve(process.cwd())
const cwd = resolve(
  process.env.ANYENGINE_SMOKE_CWD ?? join(repo, '.claude-codex', 'subagent-smoke'),
)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const home = join(repo, '.claude-codex', `subagent-smoke-home-${runtime}-${stamp}`)
await mkdir(cwd, { recursive: true })
await mkdir(home, { recursive: true })
const port = Number(process.env.ANYENGINE_SMOKE_PORT ?? (runtime === 'grok' ? 8796 : 8795))
const listen = `ws://127.0.0.1:${port}`
const model = process.env.ANYENGINE_SMOKE_MODEL ?? (runtime === 'grok' ? 'grok-4.6' : 'sonnet')
const debugLog = join(home, 'debug.jsonl')
const TURN_TIMEOUT_MS = 300_000

const log = (line) => console.log(`[smoke-subagents:${runtime}] ${line}`)
const t0 = Date.now()
const ms = () => Date.now() - t0

const env = {
  ...process.env,
  ANYENGINE_MOCK: '',
  ANYENGINE_NATIVE_CODEX: '0',
  ANYENGINE_HOME: join(home, 'adapter-home'),
  CODEX_HOME: join(home, 'codex-home'),
  ANYENGINE_DEBUG_LOG: debugLog,
  NODE_NO_WARNINGS: '1',
}
if (runtime === 'claude') env.ANYENGINE_RUNTIME_TYPE = 'anyengine'

const adapter = spawn(
  process.execPath,
  [resolve('dist/src/adapter.mjs'), 'app-server', '--listen', listen],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  },
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

// Every notification the App would see, in order.
const trace = []
const report = { runtime, model, port, cwd, home, debugLog, turns: [], adapterPid: adapter.pid }

function finish(code) {
  adapter.kill('SIGTERM')
  const out = join(home, 'report.json')
  writeFile(out, JSON.stringify({ ...report, trace }, null, 2)).finally(() => {
    log(`report ${out}`)
    setTimeout(() => process.exit(code), 1200)
  })
}

async function connect() {
  for (let attempt = 0; attempt < 75; attempt += 1) {
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
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
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
  if (item.type === 'commandExecution') entry.command = item.command
  if (item.type === 'subAgentActivity') entry.kind = item.kind ?? item.activity?.type ?? null
  if (item.type === 'agentMessage') entry.text = String(item.text ?? '').slice(0, 300)
  if (item.type === 'userMessage') entry.text = JSON.stringify(item.content).slice(0, 120)
  if (message.method === 'thread/started') entry.threadId = p.thread?.id ?? entry.threadId
  if (message.method === 'error') entry.error = p
  if (message.method?.endsWith('requestApproval')) entry.command = p.command ?? '<fileChange>'
  return entry
}

async function runTurn(rpc, threadId, text, label) {
  const started = Date.now()
  const turn = {
    label,
    prompt: text,
    status: null,
    streamedText: '',
    deltas: 0,
    finalMessages: [],
    notifications: [],
    childThreads: [],
    approvals: [],
    errors: [],
    durationMs: null,
  }
  const res = await rpc.request('turn/start', {
    threadId,
    input: [{ type: 'text', text, text_elements: [] }],
  })
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
        turn.streamedText += p.delta
        turn.deltas += 1
        break
      case 'item/completed':
        if (p.item?.type === 'agentMessage') turn.finalMessages.push(p.item.text)
        break
      case 'thread/started':
        if (p.thread?.id && p.thread.id !== threadId) turn.childThreads.push(p.thread.id)
        break
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        turn.approvals.push(p.command ?? '<fileChange>')
        log(`${label}: approval requested (${p.command ?? 'fileChange'}) -> accept`)
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
        if (p.threadId === threadId || p.turn?.id === turn.turnId) {
          turn.status = p.turn?.status ?? 'completed'
        }
        break
      default:
        break
    }
  }
  turn.durationMs = Date.now() - started
  const methods = {}
  for (const n of turn.notifications) {
    const key = n.itemType ? `${n.method}(${n.itemType}${n.tool ? ':' + n.tool : ''})` : n.method
    methods[key] = (methods[key] ?? 0) + 1
  }
  turn.methodCounts = methods
  log(
    `${label}: status=${turn.status} ${turn.durationMs} ms deltas=${turn.deltas} children=${turn.childThreads.length} approvals=${turn.approvals.length} errors=${turn.errors.length}`,
  )
  log(`${label}: streamed=${JSON.stringify(turn.streamedText.trim().slice(0, 300))}`)
  log(`${label}: final=${JSON.stringify(turn.finalMessages.map((t) => t.trim().slice(0, 300)))}`)
  log(`${label}: methods=${JSON.stringify(methods)}`)
  report.turns.push(turn)
  return turn
}

function debugSummary() {
  if (!existsSync(debugLog)) return { present: false }
  const lines = readFileSync(debugLog, 'utf8').split('\n').filter(Boolean)
  const counts = {}
  const errors = []
  const hookTools = {}
  for (const line of lines) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const ev = e.event ?? e.type ?? e.msg ?? 'unknown'
    counts[ev] = (counts[ev] ?? 0) + 1
    if (/error|fail|denied|timeout/i.test(ev) || e.error || e.data?.error)
      errors.push(line.slice(0, 400))
    if (ev === 'anyengine.hook') {
      const k = `${e.data?.event ?? e.event}:${e.data?.tool ?? e.tool ?? '-'}`
      hookTools[k] = (hookTools[k] ?? 0) + 1
    }
  }
  return { present: true, lines: lines.length, counts, errors: errors.slice(0, 20), hookTools }
}

const CLAUDE_PROMPT =
  "Use your Agent/Task tool to spawn exactly two sub-agents in parallel. Sub-agent A must reply with the single word ALPHA and sub-agent B with the single word BRAVO. After both finish, reply with exactly: A=<A's word> B=<B's word>"
const GROK_PROMPT =
  "If you have a sub-agent/delegation tool, use it to spawn exactly two sub-agents in parallel: sub-agent A must reply with the single word ALPHA and sub-agent B with the single word BRAVO, then reply with exactly: A=<A's word> B=<B's word>. If you have no sub-agent/delegation tool, say NO_SUBAGENT_TOOL and stop."

try {
  const ws = await connect()
  const rpc = new Rpc(ws)
  await rpc.request('initialize', {
    clientInfo: { name: 'smoke-subagents', title: 'Smoke', version: '0' },
    capabilities: null,
  })
  const models = await rpc.request('model/list', {})
  report.models = models.data.map((m) => m.id)
  log(`model/list: ${report.models.join(', ')}`)
  const started = await rpc.request('thread/start', {
    cwd,
    model,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  })
  const threadId = started.thread.id
  report.threadId = threadId
  log(`thread ${threadId} model=${started.model} cwd=${cwd}`)

  await runTurn(rpc, threadId, runtime === 'grok' ? GROK_PROMPT : CLAUDE_PROMPT, 'turn1-subagents')
  // Optional quiet gap between turns; anything the adapter emits while no
  // turn is active (e.g. a late stream from the previous turn) is captured.
  const gapMs = Number(process.env.ANYENGINE_SMOKE_TURN_GAP_MS ?? 0)
  if (gapMs > 0) {
    const until = Date.now() + gapMs
    report.gapNotifications = []
    while (Date.now() < until) {
      try {
        const m = await rpc.next(until - Date.now())
        const entry = describe(m)
        trace.push(entry)
        report.gapNotifications.push({ ...entry, delta: m.params?.delta ?? undefined })
      } catch {
        break
      }
    }
    log(`gap ${gapMs} ms: ${JSON.stringify(report.gapNotifications).slice(0, 600)}`)
  }
  await runTurn(rpc, threadId, 'Reply with exactly the word PONG2 and nothing else.', 'turn2-plain')

  try {
    const read = await rpc.request('thread/read', { threadId, includeTurns: true })
    report.threadReadTurns = read.thread?.turns?.length ?? null
    log(`thread/read turns=${report.threadReadTurns}`)
  } catch (err) {
    report.threadReadError = String(err.message)
  }
  report.debug = debugSummary()
  log(`debug.jsonl: ${JSON.stringify(report.debug).slice(0, 1500)}`)
  report.adapterStderr = adapterStderr.join('').slice(-2000)
  ws.close()
  finish(0)
} catch (error) {
  console.error(error)
  report.fatal = String(error?.stack ?? error)
  report.debug = debugSummary()
  finish(1)
}
