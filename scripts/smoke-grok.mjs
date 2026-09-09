#!/usr/bin/env node
// Real-grok smoke for the grok runtime: boots the adapter on a WebSocket
// listener, starts a thread with a grok-* model (which routes it to the grok
// runtime regardless of the configured default backend), runs a text-only turn,
// then a Bash turn and asserts the App-side approval round-trips. Needs a
// logged-in `grok` CLI (`grok login`). Usage: npm run smoke:grok
//   ANYENGINE_SMOKE_PORT   listener port (default 8793)
//   ANYENGINE_SMOKE_MODEL  grok model id (default: first Grok entry in model/list)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

const root = resolve(process.env.ANYENGINE_SMOKE_ROOT ?? tmpdir())
const home = await mkdtemp(join(root, 'claude-codex-grok-smoke-'))
const workspace = join(home, 'workspace')
await mkdir(workspace, { recursive: true })
const port = Number(process.env.ANYENGINE_SMOKE_PORT ?? 8793)
const listen = `ws://127.0.0.1:${port}`

const adapter = spawn(
  process.execPath,
  [resolve('dist/src/adapter.mjs'), 'app-server', '--listen', listen],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Default route stays whatever the host uses; the grok-* model selects
      // the grok runtime per thread. Mock must be off for that rule to apply.
      ANYENGINE_MOCK: '',
      ANYENGINE_HOME: join(home, 'adapter-home'),
      CODEX_HOME: join(home, 'codex-home'),
      ANYENGINE_DEBUG_LOG: join(home, 'debug.jsonl'),
      NODE_NO_WARNINGS: '1',
    },
  },
)
adapter.stderr.setEncoding('utf8')
adapter.stderr.on('data', (chunk) => process.stderr.write(chunk))
adapter.stdout.setEncoding('utf8')
adapter.stdout.on('data', (chunk) => process.stderr.write(chunk))

const log = (line) => console.log(`[smoke-grok] ${line}`)
const timeout = setTimeout(() => {
  console.error('grok smoke timed out')
  cleanup(1)
}, 300_000)

function cleanup(code) {
  clearTimeout(timeout)
  adapter.kill('SIGTERM')
  setTimeout(() => {
    if (code !== 0) {
      console.error(`[smoke-grok] keeping ${home} for inspection (debug.jsonl inside)`)
      process.exit(code)
    }
    void rm(home, { recursive: true, force: true }).finally(() => process.exit(code))
  }, 1500)
}

async function connect() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const ws = new WebSocket(listen)
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      return ws
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
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
  next() {
    const existing = this.queue.shift()
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

async function runTurn(rpc, threadId, text) {
  const started = await rpc.request('turn/start', {
    threadId,
    input: [{ type: 'text', text, text_elements: [] }],
  })
  assert.equal(started.turn.status, 'inProgress')
  const result = { text: '', approvals: [], commands: [], reasoning: 0, turn: null, deltas: 0 }
  while (!result.turn) {
    const message = await rpc.next()
    if (message.method === 'item/agentMessage/delta') {
      result.text += message.params.delta
      result.deltas += 1
    }
    if (
      message.method === 'item/reasoning/textDelta' ||
      message.method === 'item/reasoning/summaryTextDelta'
    ) {
      result.reasoning += 1
    }
    if (message.method === 'item/started' && message.params.item?.type === 'commandExecution') {
      result.commands.push(message.params.item.command)
    }
    if (message.method === 'item/commandExecution/requestApproval') {
      result.approvals.push(message.params.command)
      log(`approval requested for: ${message.params.command} -> accept`)
      rpc.respond(message.id, { decision: 'accept' })
    }
    if (message.method === 'item/fileChange/requestApproval') {
      result.approvals.push('<fileChange>')
      rpc.respond(message.id, { decision: 'accept' })
    }
    if (message.method === 'error') throw new Error(JSON.stringify(message.params))
    if (message.method === 'turn/completed') result.turn = message.params.turn
  }
  return result
}

try {
  const ws = await connect()
  const rpc = new Rpc(ws)
  await rpc.request('initialize', {
    clientInfo: { name: 'smoke-grok', title: 'Smoke', version: '0' },
    capabilities: null,
  })
  const models = await rpc.request('model/list', {})
  const grokModels = models.data.filter((entry) => /^grok/i.test(entry.id))
  log(`model/list grok entries: ${JSON.stringify(grokModels.map((m) => [m.id, m.displayName]))}`)
  assert.ok(grokModels.length > 0, 'model/list exposes Grok models')
  const model = process.env.ANYENGINE_SMOKE_MODEL ?? grokModels[0].id

  const started = await rpc.request('thread/start', {
    cwd: workspace,
    model,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  })
  const threadId = started.thread.id
  log(`thread ${threadId} model=${started.model} cwd=${workspace}`)
  assert.equal(started.model, model)

  const first = await runTurn(rpc, threadId, 'Reply with exactly the word PONG')
  log(
    `turn 1 status=${first.turn.status} deltas=${first.deltas} reasoningDeltas=${first.reasoning} text=${JSON.stringify(first.text.trim())}`,
  )
  assert.equal(first.turn.status, 'completed')
  assert.match(first.text, /PONG/)

  const second = await runTurn(
    rpc,
    threadId,
    'Use your shell tool to run exactly this command: echo hi. Then reply with only the command output.',
  )
  log(
    `turn 2 status=${second.turn.status} approvals=${JSON.stringify(second.approvals)} commands=${JSON.stringify(second.commands)} text=${JSON.stringify(second.text.trim())}`,
  )
  assert.equal(second.turn.status, 'completed')
  assert.ok(
    second.commands.some((command) => /echo hi/.test(command)),
    'Bash item rendered',
  )
  assert.match(second.text, /hi/)

  // grok pre-allows harmless commands itself (`echo`), so use one it always
  // asks about to prove the App approval round-trips end to end.
  const third = await runTurn(
    rpc,
    threadId,
    'Use your shell tool to run exactly this command: rm -f nothing-to-remove.txt. Then reply with only the word DONE.',
  )
  log(
    `turn 3 status=${third.turn.status} approvals=${JSON.stringify(third.approvals)} commands=${JSON.stringify(third.commands)} text=${JSON.stringify(third.text.trim())}`,
  )
  assert.equal(third.turn.status, 'completed')
  assert.ok(
    third.approvals.some((command) => /rm -f nothing-to-remove\.txt/.test(command)),
    'Bash approval round-tripped through the App',
  )
  assert.match(third.text, /DONE/)

  const read = await rpc.request('thread/read', { threadId, includeTurns: true })
  log(`thread/read turns=${read.thread?.turns?.length ?? 'n/a'}`)
  log('grok smoke passed')
  ws.close()
  cleanup(0)
} catch (error) {
  console.error(error)
  cleanup(1)
}
