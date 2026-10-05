// Controlled app-server fixture using recorded thread/turn/item envelopes.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const mode = process.argv[2]
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const item = (threadId, turnId, text) =>
  send({
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: `${turnId}-msg`, text, phase: null },
    },
  })
const terminal = (threadId, id, status = 'completed', error = null) =>
  send({
    method: 'turn/completed',
    params: { threadId, turn: { id, status, error, items: [] } },
  })
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialized') return
  if (method === 'bad') return send({ id, error: { code: -1, message: 'fixture refusal' } })
  if (method === 'leave') return process.exit(0)
  if (method === 'invalid-bytes') {
    process.stdout.write(
      mode === 'oversized' ? Buffer.alloc(4 * 1024 * 1024 + 1, 120) : Buffer.from([255, 10]),
    )
    return
  }
  if (method === 'thread/unsubscribe') return send({ id, result: { status: 'unsubscribed' } })
  if (method === 'thread/delete') {
    send({ id, result: mode === 'null-ack' ? null : mode === 'array-ack' ? [] : {} })
    send({ method: 'thread/deleted', params: { threadId: params.threadId } })
    return
  }
  if (method === 'silent') return
  if (method === 'family') {
    const child = spawn(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    child.stdout.once('data', () => send({ id, result: { pid: child.pid } }))
    return
  }
  if (method !== 'turn/start') return send({ id, result: {} })
  item('parent', 'old', 'PONG')
  terminal('parent', 'old')
  item('other', 'turn-1', 'PONG')
  terminal('other', 'turn-1')
  send({
    method: 'item/agentMessage/delta',
    params: { threadId: params.threadId, turnId: 'turn-1', delta: 'PONG' },
  })
  if (mode !== 'no-final') item(params.threadId, 'turn-1', mode === 'unrelated' ? 'NO' : 'PONG')
  terminal(
    params.threadId,
    'turn-1',
    ['failed', 'interrupted'].includes(mode) ? mode : 'completed',
    mode === 'error' ? { message: 'failed PONG' } : null,
  )
  send({ id, result: { turn: { id: 'turn-1', status: 'inProgress', error: null, items: [] } } })
})
