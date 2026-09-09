#!/usr/bin/env node
// Real-Claude smoke for the anyengine runtime: boots the adapter on a WebSocket
// listener with CLAUDE_CODEX_RUNTIME_TYPE=anyengine, runs a text-only turn, then
// a Bash turn and asserts the App-side approval round-trips. Needs a logged-in
// `claude` CLI (subscription). Usage: npm run smoke:anyengine
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

const root = resolve(process.env.CLAUDE_CODEX_SMOKE_ROOT ?? tmpdir())
const home = await mkdtemp(join(root, 'anyengine-smoke-'))
const workspace = join(home, 'workspace')
await import('node:fs/promises').then((fs) => fs.mkdir(workspace, { recursive: true }))
const port = Number(process.env.CLAUDE_CODEX_SMOKE_PORT ?? 8791)
const listen = `ws://127.0.0.1:${port}`

const adapter = spawn(
  process.execPath,
  [resolve('dist/src/adapter.mjs'), 'app-server', '--listen', listen],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_CODEX_RUNTIME_TYPE: 'anyengine',
      CLAUDE_CODEX_HOME: join(home, 'adapter-home'),
      CODEX_HOME: join(home, 'codex-home'),
      CLAUDE_CODEX_DEBUG_LOG: join(home, 'debug.jsonl'),
      NODE_NO_WARNINGS: '1',
    },
  },
)
adapter.stderr.setEncoding('utf8')
adapter.stderr.on('data', (chunk) => process.stderr.write(chunk))
adapter.stdout.setEncoding('utf8')
adapter.stdout.on('data', (chunk) => process.stderr.write(chunk))

const log = (line) => console.log(`[smoke-anyengine] ${line}`)
const timeout = setTimeout(() => {
  console.error('anyengine smoke timed out')
  cleanup(1)
}, 240_000)

function cleanup(code) {
  clearTimeout(timeout)
  adapter.kill('SIGTERM')
  setTimeout(() => {
    if (code !== 0) {
      console.error(`[smoke-anyengine] keeping ${home} for inspection (debug.jsonl inside)`)
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
  const result = { text: '', approvals: [], commands: [], turn: null, deltas: 0 }
  while (!result.turn) {
    const message = await rpc.next()
    if (message.method === 'item/agentMessage/delta') {
      result.text += message.params.delta
      result.deltas += 1
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
    clientInfo: { name: 'smoke-anyengine', title: 'Smoke', version: '0' },
    capabilities: null,
  })
  // Omitting the policy defaults the thread to full access (no approvals);
  // ask for on-request approvals the way the Codex App does.
  const started = await rpc.request('thread/start', {
    cwd: workspace,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  })
  const threadId = started.thread.id
  log(`thread ${threadId} cwd=${workspace}`)

  const first = await runTurn(rpc, threadId, 'Reply with exactly the word PONG')
  log(
    `turn 1 status=${first.turn.status} deltas=${first.deltas} text=${JSON.stringify(first.text.trim())}`,
  )
  assert.equal(first.turn.status, 'completed')
  assert.match(first.text, /PONG/)

  const second = await runTurn(
    rpc,
    threadId,
    'Use the Bash tool to run exactly this command: echo hi. Then reply with only the command output.',
  )
  log(
    `turn 2 status=${second.turn.status} approvals=${JSON.stringify(second.approvals)} commands=${JSON.stringify(second.commands)} text=${JSON.stringify(second.text.trim())}`,
  )
  assert.equal(second.turn.status, 'completed')
  assert.ok(
    second.approvals.some((command) => /echo hi/.test(command)),
    'Bash approval round-tripped',
  )
  assert.match(second.text, /hi/)

  const read = await rpc.request('thread/read', { threadId, includeTurns: true })
  log(`thread/read turns=${read.thread?.turns?.length ?? 'n/a'}`)
  log('anyengine smoke passed')
  ws.close()
  cleanup(0)
} catch (error) {
  console.error(error)
  cleanup(1)
}
