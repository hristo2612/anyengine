#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.160.0\n')
  process.exit(0)
}
const path = process.env.FAKE_ACCOUNT_STATE_PATH
let state = { counter: 0, turns: 0, threads: {}, requests: [] }
try {
  state = JSON.parse(readFileSync(path, 'utf8'))
} catch {}
const home = lstatSync(join(process.env.CODEX_HOME, 'auth.json')).isSymbolicLink()
const mode = process.env.FAKE_ACCOUNT_FAILURE
const save = () => writeFileSync(path, JSON.stringify(state), { mode: 0o600 })
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
const notify = (method, params) => send({ method, params })
const error = {
  code: -32000,
  message: 'encrypted request rejected',
  data: { code: 'invalid_encrypted_content' },
}
const turnError =
  mode === 'usage'
    ? { message: 'Quota reached', codexErrorInfo: 'usageLimitExceeded' }
    : { message: 'invalid_encrypted_content', codexErrorInfo: 'badRequest' }
const thread = (id) => state.threads[id]
const answer = (t) => ({
  thread: t,
  model: t.model,
  cwd: t.cwd,
  approvalPolicy: t.approvalPolicy ?? 'never',
  approvalsReviewer: 'user',
  sandbox: { type: 'readOnly', networkAccess: false },
  reasoningEffort: 'high',
  serviceTier: null,
})
const terminal = (threadId, turn) => notify('turn/completed', { threadId, turn })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params: p = {} } = JSON.parse(line)
  if (id === undefined) return
  state.requests.push({ method, params: p })
  save()
  switch (method) {
    case 'initialize':
      if (process.env.FAKE_ACCOUNT_BOOTSTRAP === '1') {
        const db = join(process.env.CODEX_HOME, 'state_1.sqlite')
        if (!existsSync(db)) writeFileSync(db, 'fixture state', { mode: 0o600 })
        mkdirSync(join(process.env.CODEX_HOME, 'shell_snapshots'), { recursive: true, mode: 0o700 })
      }
      send({ id, result: { userAgent: 'fake', codexHome: process.env.CODEX_HOME } })
      return
    case 'thread/start': {
      const t = {
        id: `account-thread-${++state.counter}`,
        createdHome: home,
        model: p.model,
        cwd: p.cwd,
        approvalPolicy: p.approvalPolicy,
        preview: 'Original title',
        createdAt: state.counter,
        modelProvider: 'openai',
        updatedAt: state.counter,
        turns: [],
        injection: [],
      }
      state.threads[t.id] = t
      save()
      if (process.env.FAKE_ACCOUNT_ANNOUNCE_LAST !== '1') notify('thread/started', { thread: t })
      send({ id, result: answer(t) })
      if (process.env.FAKE_ACCOUNT_ANNOUNCE_LAST === '1') notify('thread/started', { thread: t })
      return
    }
    case 'thread/resume':
      if (mode === 'resume' && !home && thread(p.threadId).createdHome) send({ id, error })
      else send({ id, result: answer(thread(p.threadId)) })
      return
    case 'thread/inject_items':
      if (process.env.FAKE_ACCOUNT_REFUSE_INJECT === '1')
        send({ id, error: { code: -32601, message: 'not supported' } })
      else {
        thread(p.threadId).injection = p.items
        save()
        send({ id, result: {} })
      }
      return
    case 'thread/archive':
      delete state.threads[p.threadId]
      save()
      send({ id, result: {} })
      return
    case 'thread/read':
      send({ id, result: { thread: thread(p.threadId) } })
      return
    case 'thread/list':
      send({ id, result: { data: Object.values(state.threads), nextCursor: null } })
      return
    case 'thread/loaded/list':
      send({ id, result: { data: Object.keys(state.threads) } })
      return
    case 'model/list':
      send({
        id,
        result: { data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol' }], nextCursor: null },
      })
      return
    case 'turn/start': {
      const t = thread(p.threadId),
        turnId = `account-turn-${++state.turns}`
      const fails =
        !home &&
        mode &&
        (t.createdHome || mode === 'repeated') &&
        mode !== 'resume' &&
        (mode !== 'usage' || p.input.some((item) => item.text === 'Recall the word'))
      if (fails && mode === 'rpc') {
        send({ id, error })
        return
      }
      const turn = {
        id: turnId,
        status: 'inProgress',
        items: [{ id: `${turnId}-user`, type: 'userMessage', content: p.input }],
      }
      t.turns.push(turn)
      save()
      send({ id, result: { turn } })
      notify('turn/started', { threadId: t.id, turn })
      if (fails) {
        if (mode === 'tool')
          notify('item/started', {
            threadId: t.id,
            turnId,
            item: { id: 'command', type: 'commandExecution', command: 'effect' },
          })
        if (mode === 'output')
          notify('item/agentMessage/delta', { threadId: t.id, turnId, delta: 'Visible output' })
        const failed = { ...turn, status: 'failed', error: turnError }
        t.turns[t.turns.length - 1] = failed
        save()
        notify('error', { threadId: t.id, turnId, error: turnError, willRetry: false })
        terminal(t.id, failed)
        return
      }
      turn.items.push({ id: `${turnId}-assistant`, type: 'agentMessage', text: 'PONG' })
      turn.status = 'completed'
      save()
      notify('item/agentMessage/delta', { threadId: t.id, turnId, delta: 'PONG' })
      terminal(t.id, turn)
      return
    }
    default:
      send({ id, result: { data: [] } })
  }
})
