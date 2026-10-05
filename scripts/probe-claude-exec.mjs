#!/usr/bin/env node
// One real, tiny Claude turn in an isolated adapter: does Claude find the
// sandboxed `exec` tool without being told? The adapter runs from this
// tree's dist/ over stdio with the app's bundled codex as its child (in an
// isolated CODEX_HOME: `command/exec` needs no login) and the operator's own
// `claude` login. A haiku thread in workspace-write + on-request is asked to
// run `pwd`; the probe passes when Claude called `exec`, nothing asked for an
// approval, and the answer names the project directory.
//
// Usage: npm run build && node scripts/probe-claude-exec.mjs [--project DIR]
//   --project  the one fixed directory every live Claude run works in
//              (default ~/.anyengine/smoke/claude-project), created if
//              missing and never removed: Claude Code adds one project entry
//              to ~/.claude.json, once. The probe never opens that file.
// Prints `exec-called` and `approval-requested` when they happened, then the
// answer. Exit 0 only for exec-called, no approval-requested and an answer
// that contains DIR. Never touches ~/.codex. The probe's own directory sits
// next to DIR, outside every root the thread may write, and is removed at
// the end.
import { spawn } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { projectFromArgs, scratchNextTo } from './lib/claude-scratch.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROMPT = 'run pwd and reply with its output only'
const TURN_TIMEOUT_MS = 180_000
// Starting the adapter, its codex child and a first Claude PTY, on top.
const PROBE_TIMEOUT_MS = TURN_TIMEOUT_MS + 60_000
const APPROVALS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
])
// Engine settings inherited from the caller (a Claude Code session, the
// operator's shell) would point the adapter, its codex or Claude elsewhere;
// only the probe's own reach them. CLAUDE_CONFIG_DIR is the operator's login.
const INHERITED = /^(ANYENGINE_|CODEX_|CLAUDE|ANTHROPIC_|OPENAI_)/

function probeEnv(probe) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (INHERITED.test(key) && key !== 'CLAUDE_CONFIG_DIR') continue
    env[key] = value
  }
  const dirs = { codex: join(probe, 'codex'), adapter: join(probe, 'adapter') }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  return {
    ...env,
    // A CODEX_HOME that does not exist kills the codex child at start.
    CODEX_HOME: dirs.codex,
    ANYENGINE_HOME: dirs.adapter,
    ANYENGINE_ROOT: join(probe, 'root'),
    ANYENGINE_DEBUG_LOG: join(probe, 'debug.jsonl'),
    // The relay's hooks and MCP config (default ~/.anyengine/pty), which a
    // sandboxed command must not reach: the probe's directory is outside
    // every writable root (scratchNextTo).
    ANYENGINE_PTY_STATE_DIR: join(probe, 'pty'),
    ANYENGINE_RUNTIME_TYPE: 'anyengine',
    ANYENGINE_MODELS: 'haiku',
    NODE_NO_WARNINGS: '1',
  }
}

class Rpc {
  constructor(child, onServerRequest, onNotification) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (!line.trim()) return
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.method == null) this.settle(message)
      else if (message.id != null) onServerRequest(message)
      else onNotification(message)
    })
  }
  settle(message) {
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message))
    else pending.resolve(message.result)
  }
  send(message) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  request(method, params) {
    const id = this.nextId++
    this.send({ id, method, params })
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
}

// A Claude thread's tool call is an mcpToolCall item under Claude Code's own
// name for the tool (server `claude-code`, tool `mcp__anyengine__exec`); a
// native MCP item names the server and the tool apart.
function isExec(item) {
  if (item?.type !== 'mcpToolCall') return false
  return (
    item.tool === 'mcp__anyengine__exec' || (item.server === 'anyengine' && item.tool === 'exec')
  )
}

function watchTurn(state) {
  return (message) => {
    const params = message.params ?? {}
    const item = params.item
    if (message.method === 'item/agentMessage/delta') state.deltas += params.delta ?? ''
    if (message.method === 'item/started' || message.method === 'item/completed') {
      if (item?.type === 'mcpToolCall' || item?.type === 'commandExecution') {
        const what = item.type === 'mcpToolCall' ? `${item.server}/${item.tool}` : item.command
        state.transcript.push(`${message.method} ${item.type} ${what} ${item.status ?? ''}`)
      }
    }
    if (message.method === 'item/completed' && isExec(item)) state.execCalled = true
    if (message.method === 'item/completed' && item?.type === 'agentMessage')
      state.answer = item.text ?? state.answer
    if (message.method === 'error') state.transcript.push(`error ${JSON.stringify(params)}`)
    if (message.method === 'turn/completed' && params.threadId === state.threadId) {
      state.transcript.push(`turn/completed ${params.turn?.status}`)
      state.done?.()
    }
  }
}

function answerServerRequest(state, rpc) {
  return (message) => {
    state.transcript.push(`server request ${message.method}`)
    if (APPROVALS.has(message.method)) {
      state.approvalRequested = true
      rpc.send({ id: message.id, result: { decision: 'decline' } })
      return
    }
    rpc.send({ id: message.id, error: { code: -32601, message: 'not handled by the probe' } })
  }
}

function exited(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      done(true)
    })
  })
}

// Only the adapter this probe started; it takes its codex child and Claude
// PTY down with it when its stdin closes.
async function stopAdapter(child) {
  child.stdin.end()
  if (await exited(child, 15_000)) return
  child.kill('SIGTERM')
  if (await exited(child, 5_000)) return
  child.kill('SIGKILL')
  await exited(child, 5_000)
}

async function runProbe(rpc, state, project) {
  const init = await rpc.request('initialize', {
    clientInfo: { name: 'probe-claude-exec', title: 'Probe', version: '0' },
    capabilities: { experimentalApi: true },
  })
  rpc.send({ method: 'initialized', params: {} })
  const pid = rpc.child.pid
  console.log(`probe-claude-exec: adapter pid ${pid} up (${init.userAgent ?? 'no userAgent'})`)
  const started = await rpc.request('thread/start', {
    model: 'haiku',
    cwd: project,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
  })
  state.threadId = started.thread.id
  const completed = new Promise((done, fail) => {
    state.done = done
    setTimeout(() => fail(new Error('no turn/completed within 180 s')), TURN_TIMEOUT_MS).unref()
  })
  await rpc.request('turn/start', {
    threadId: state.threadId,
    input: [{ type: 'text', text: PROMPT, text_elements: [] }],
  })
  await completed
}

function verdict(state, project) {
  const answer = (state.answer || state.deltas).trim()
  let real = project
  try {
    real = realpathSync(project)
  } catch {}
  const named = answer.includes(project) || answer.includes(real)
  if (state.execCalled) console.log('exec-called')
  if (state.approvalRequested) console.log('approval-requested')
  console.log(`answer: ${JSON.stringify(answer)}`)
  return state.execCalled && !state.approvalRequested && named
}

const project = projectFromArgs(
  process.argv.slice(2),
  join(homedir(), '.anyengine', 'smoke', 'claude-project'),
  'usage: node scripts/probe-claude-exec.mjs [--project DIR]',
)
mkdirSync(project, { recursive: true })
const probe = scratchNextTo(project, 'claude-exec.', 'probe-claude-exec')
const adapter = spawn(process.execPath, [join(repo, 'dist', 'src', 'adapter.mjs'), 'app-server'], {
  cwd: probe,
  env: probeEnv(probe),
  stdio: ['pipe', 'pipe', 'pipe'],
})
const stderr = []
adapter.stderr.setEncoding('utf8')
adapter.stderr.on('data', (chunk) => stderr.push(chunk))
const state = {
  threadId: null,
  done: null,
  execCalled: false,
  approvalRequested: false,
  answer: '',
  deltas: '',
  transcript: [],
}
const rpc = new Rpc(adapter, (message) => onRequest(message), watchTurn(state))
const onRequest = answerServerRequest(state, rpc)
// The probe gives up when the adapter exits or the whole run overruns.
const stopped = new Promise((_, fail) => {
  adapter.once('exit', (code, signal) => fail(new Error(`adapter exited (${code ?? signal})`)))
  setTimeout(() => fail(new Error('the probe overran its time')), PROBE_TIMEOUT_MS).unref()
})
stopped.catch(() => {})
let passed = false
try {
  await Promise.race([runProbe(rpc, state, project), stopped])
  passed = verdict(state, project)
} catch (error) {
  verdict(state, project)
  console.error(`probe-claude-exec: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await stopAdapter(adapter)
  rmSync(probe, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
if (!passed) {
  console.error('probe-claude-exec: FAIL. Transcript:')
  for (const line of state.transcript) console.error(`  ${line}`)
  const tail = stderr.join('').trim().split('\n').slice(-30)
  if (tail.join('')) console.error(`adapter stderr (last lines):\n${tail.join('\n')}`)
}
console.log(`probe-claude-exec: ${passed ? 'PASS' : 'FAIL'}`)
process.exit(passed ? 0 : 1)
