#!/usr/bin/env node
// Real smoke for the native-codex multiplexer: boots the adapter over stdio
// the way the desktop does (leading `-c` global + `app-server` + flags), with
// the REAL bundled `codex app-server` as its child, then
//   1. gpt thread: "Reply with exactly the word PONG" streams through,
//   2. gpt thread: a shell command triggers a NATIVE
//      item/commandExecution/requestApproval which this client answers,
//   3. Claude thread (model `opus`): PONG through the configured Claude runtime.
// Needs the ChatGPT login in ~/.codex (spends a little quota) and a logged-in
// `claude` CLI with the runtime env sourced (`source ~/.claude-codex/runtime.env`).
// Usage: npm run smoke:native-codex
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import readline from 'node:readline'

const root = resolve(process.env.CLAUDE_CODEX_SMOKE_ROOT ?? tmpdir())
const home = await mkdtemp(join(root, 'claude-codex-native-smoke-'))
const workspace = join(home, 'workspace')
await mkdir(workspace, { recursive: true })
const claudeModel = process.env.CLAUDE_CODEX_SMOKE_CLAUDE_MODEL ?? 'opus'

const adapter = spawn(
  process.execPath,
  [
    resolve('dist/src/adapter.mjs'),
    '-c',
    'features.code_mode_host=true',
    'app-server',
    '--analytics-default-enabled',
  ],
  {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // The adapter's own store/log are isolated; CODEX_HOME stays the real
      // one so the child shares the ChatGPT login.
      CLAUDE_CODEX_HOME: join(home, 'adapter-home'),
      CLAUDE_CODEX_DEBUG_LOG: join(home, 'debug.jsonl'),
      NODE_NO_WARNINGS: '1',
    },
  },
)
adapter.stderr.setEncoding('utf8')
adapter.stderr.on('data', (chunk) => process.stderr.write(chunk))

const log = (line) => console.log(`[smoke-native-codex] ${line}`)
const timeout = setTimeout(() => {
  console.error('native-codex smoke timed out')
  cleanup(1)
}, 420_000)

function cleanup(code) {
  clearTimeout(timeout)
  adapter.stdin.end()
  setTimeout(() => {
    if (adapter.exitCode == null) adapter.kill('SIGTERM')
    if (code !== 0) {
      console.error(`[smoke-native-codex] keeping ${home} for inspection (debug.jsonl inside)`)
      process.exit(code)
    }
    void rm(home, { recursive: true, force: true }).finally(() => process.exit(code))
  }, 2000)
}

class Rpc {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.queue = []
    this.waiters = []
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (!line.trim()) return
      const message = JSON.parse(line)
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
  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  request(method, params) {
    const id = this.nextId++
    this.send({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  respond(id, result) {
    this.send({ jsonrpc: '2.0', id, result })
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
  const result = {
    text: '',
    approvals: [],
    approvalIds: [],
    resolved: [],
    commands: [],
    turn: null,
    deltas: 0,
  }
  while (!result.turn) {
    const message = await rpc.next()
    const p = message.params ?? {}
    if (p.threadId && p.threadId !== threadId) continue
    if (message.method === 'item/agentMessage/delta') {
      result.text += p.delta
      result.deltas += 1
    }
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage' && !result.deltas) {
      result.text += p.item.text ?? ''
    }
    if (message.method === 'item/started' && p.item?.type === 'commandExecution') {
      result.commands.push(p.item.command)
    }
    if (message.method === 'item/commandExecution/requestApproval') {
      result.approvals.push(p.command)
      result.approvalIds.push(message.id)
      log(`native approval requested (id=${message.id}) for: ${p.command} -> accept`)
      rpc.respond(message.id, { decision: 'accept' })
    }
    if (message.method === 'item/fileChange/requestApproval') {
      result.approvals.push('<fileChange>')
      result.approvalIds.push(message.id)
      rpc.respond(message.id, { decision: 'accept' })
    }
    if (message.method === 'serverRequest/resolved') result.resolved.push(p.requestId)
    if (message.method === 'error') throw new Error(JSON.stringify(p))
    if (message.method === 'turn/completed') result.turn = p.turn
  }
  return result
}

try {
  const rpc = new Rpc(adapter)
  const init = await rpc.request('initialize', {
    clientInfo: { name: 'smoke-native-codex', title: 'Smoke', version: '0' },
    capabilities: { experimentalApi: true },
  })
  rpc.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
  log(`initialize userAgent=${JSON.stringify(init.userAgent)} codexHome=${init.codexHome}`)
  assert.match(String(init.userAgent), /^codex_app_server\//, 'real child answered initialize')

  const models = await rpc.request('model/list', { includeHidden: false })
  const ids = models.data.map((m) => m.id)
  const gptModel =
    models.data.find((m) => m.isDefault && /^gpt/.test(m.id))?.id ??
    ids.find((id) => /^gpt/.test(id))
  log(`model/list ids=${JSON.stringify(ids)} gpt=${gptModel}`)
  assert.ok(gptModel, 'child returned a gpt model')
  assert.ok(ids.includes(claudeModel), `Claude model ${claudeModel} appended to model/list`)

  const auth = await rpc.request('getAuthStatus', { includeToken: false })
  log(`getAuthStatus (default route) -> ${JSON.stringify(auth).slice(0, 120)}`)

  const gpt = await rpc.request('thread/start', {
    cwd: workspace,
    model: gptModel,
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  })
  const gptThread = gpt.thread.id
  log(`gpt thread ${gptThread} model=${gpt.model} provider=${gpt.modelProvider}`)
  assert.equal(gpt.modelProvider, 'openai')

  const pong = await runTurn(rpc, gptThread, 'Reply with exactly the word PONG')
  log(
    `gpt turn 1 status=${pong.turn.status} deltas=${pong.deltas} text=${JSON.stringify(pong.text.trim())}`,
  )
  assert.equal(pong.turn.status, 'completed')
  assert.match(pong.text, /PONG/)

  const shell = await runTurn(
    rpc,
    gptThread,
    'Run exactly this shell command in the current directory and then reply with only its output: mkdir native-smoke-dir && ls',
  )
  log(
    `gpt turn 2 status=${shell.turn.status} approvals=${JSON.stringify(shell.approvals)} approvalIds=${JSON.stringify(shell.approvalIds)} resolved=${JSON.stringify(shell.resolved)} commands=${JSON.stringify(shell.commands)} text=${JSON.stringify(shell.text.trim())}`,
  )
  assert.equal(shell.turn.status, 'completed')
  assert.ok(shell.approvals.length > 0, 'native command approval round-tripped')
  assert.ok(
    shell.approvalIds.every((id) => /^s\d+$/.test(String(id))),
    'approval ids were rewritten by the adapter',
  )

  const claude = await rpc.request('thread/start', {
    cwd: workspace,
    model: claudeModel,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  })
  const claudeThread = claude.thread.id
  log(`claude thread ${claudeThread} model=${claude.model} provider=${claude.modelProvider}`)
  assert.equal(claude.modelProvider, 'claude-code')
  const claudePong = await runTurn(rpc, claudeThread, 'Reply with exactly the word PONG')
  log(
    `claude turn status=${claudePong.turn.status} deltas=${claudePong.deltas} text=${JSON.stringify(claudePong.text.trim())}`,
  )
  assert.equal(claudePong.turn.status, 'completed')
  assert.match(claudePong.text, /PONG/)

  const list = await rpc.request('thread/list', { limit: 20, sortKey: 'updated_at' })
  const listed = list.data.map((t) => t.id)
  log(
    `thread/list page1 has gpt=${listed.includes(gptThread)} claude=${listed.includes(claudeThread)} nextCursor=${list.nextCursor != null}`,
  )
  assert.ok(listed.includes(gptThread) && listed.includes(claudeThread), 'both threads listed')

  log('native-codex smoke passed')
  cleanup(0)
} catch (error) {
  console.error(error)
  cleanup(1)
}
