#!/usr/bin/env node
// Real-Claude smoke for the anyengine runtime: boots the adapter on a WebSocket
// listener with ANYENGINE_RUNTIME_TYPE=anyengine and no codex child (so no
// sandbox), runs a text-only turn, then a write outside the workspace whose
// App-side approval round-trips (declined, so nothing is written), then a
// shell turn that must get no shell: no approval card, no command run, and
// the thread says why. Needs a logged-in `claude` CLI (subscription).
// Usage: npm run smoke:anyengine -- --project DIR
//   --project  the one fixed folder the smoke's Claude works in, or
//              ANYENGINE_SMOKE_PROJECT when the flag is not given; with
//              neither the smoke stops (exit 2). It is created if missing and
//              never removed: one stable folder, so runs do not each add a new
//              Claude project entry. The adapter's state, the relay's settings
//              included, goes in a scratch folder next to it, outside TMPDIR
//              and /tmp (scripts/lib/claude-scratch.mjs), never ~/.anyengine;
//              it is removed after a pass and kept for inspection otherwise.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { projectFromArgs, scratchNextTo } from './lib/claude-scratch.mjs'

const USAGE = [
  'usage: node scripts/smoke-anyengine.mjs --project DIR  (or ANYENGINE_SMOKE_PROJECT=DIR)',
  '  DIR is the one stable folder Claude works in on every run, created if missing and',
  '  never removed: a new folder per run would add a new Claude project entry each time.',
].join('\n')
const workspace = projectFromArgs(process.argv.slice(2), process.env.ANYENGINE_SMOKE_PROJECT, USAGE)
mkdirSync(workspace, { recursive: true })
const home = scratchNextTo(workspace, 'anyengine-smoke.', 'smoke-anyengine')
mkdirSync(join(home, 'codex-home'))
const port = Number(process.env.ANYENGINE_SMOKE_PORT ?? 8791)
const listen = `ws://127.0.0.1:${port}`

const adapter = spawn(
  process.execPath,
  [resolve('dist/src/adapter.mjs'), 'app-server', '--listen', listen],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ANYENGINE_RUNTIME_TYPE: 'anyengine',
      ANYENGINE_HOME: join(home, 'adapter-home'),
      CODEX_HOME: join(home, 'codex-home'),
      ANYENGINE_DEBUG_LOG: join(home, 'debug.jsonl'),
      // The relay's hooks and MCP config, which default to ~/.anyengine/pty.
      ANYENGINE_PTY_STATE_DIR: join(home, 'pty'),
      // No codex child, so nothing sandboxes a shell command: the case where
      // Claude's shell must fail closed (docs/guide/bridge.md, "Shell").
      ANYENGINE_NATIVE_CODEX: '0',
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

async function runTurn(rpc, threadId, text, decision = 'accept') {
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
      log(`approval requested for: ${message.params.command} -> ${decision}`)
      rpc.respond(message.id, { decision })
    }
    if (message.method === 'item/fileChange/requestApproval') {
      result.approvals.push('<fileChange>')
      log(`file-change approval requested -> ${decision}`)
      rpc.respond(message.id, { decision })
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
  // Omitting the policy gives the read-only default; ask for workspace-write
  // with on-request approvals the way the Codex App does.
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

  // The thread's first launch says the shell is off.
  assert.match(first.text, /Shell commands are off in this thread/)

  // A write outside the workspace (and outside TMPDIR and /tmp) asks the App;
  // the smoke declines, so nothing lands in the home directory.
  const outside = join(homedir(), `anyengine-smoke-${process.pid}.txt`)
  const second = await runTurn(
    rpc,
    threadId,
    `Use the Write tool to create the file ${outside} containing exactly: hi. Then reply DONE.`,
    'decline',
  )
  log(
    `turn 2 status=${second.turn.status} approvals=${JSON.stringify(second.approvals)} text=${JSON.stringify(second.text.trim())}`,
  )
  assert.equal(second.turn.status, 'completed')
  assert.ok(second.approvals.includes('<fileChange>'), 'file-change approval round-tripped')
  assert.equal(existsSync(outside), false, 'the declined write did not happen')

  // No sandbox bounds a shell here: no card, no command runs.
  const third = await runTurn(
    rpc,
    threadId,
    'Use the Bash tool to run exactly this command: echo hi. Then reply with only the command output.',
  )
  log(
    `turn 3 status=${third.turn.status} approvals=${JSON.stringify(third.approvals)} commands=${JSON.stringify(third.commands)} text=${JSON.stringify(third.text.trim())}`,
  )
  assert.equal(third.turn.status, 'completed')
  assert.deepEqual(third.approvals, [], 'no approval card for a shell no sandbox bounds')
  assert.deepEqual(third.commands, [], 'no shell command ran')

  const read = await rpc.request('thread/read', { threadId, includeTurns: true })
  log(`thread/read turns=${read.thread?.turns?.length ?? 'n/a'}`)
  log('anyengine smoke passed')
  ws.close()
  cleanup(0)
} catch (error) {
  console.error(error)
  cleanup(1)
}
