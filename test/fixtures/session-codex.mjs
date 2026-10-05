#!/usr/bin/env node
// Synthetic vendor RPC fixture for optional session controls; no auth or models.
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import readline from 'node:readline'

const path = process.env.SESSION_TEST_STATE
if (process.argv.includes('--resume') || process.argv.includes('resume')) {
  writeFileSync(
    process.env.SESSION_TEST_LAUNCH,
    JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }),
  )
  process.exit(0)
}
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  if (req.id === undefined) return
  const state = JSON.parse(readFileSync(path, 'utf8'))
  const p = req.params ?? {}
  let result = {}
  if (req.method === 'thread/list')
    result = {
      data: state.filter((s) => !!s.archived === !!p.archived).map((s) => ({ ...s, turns: [] })),
      nextCursor: null,
    }
  if (req.method === 'thread/read') {
    const thread = state.find((s) => s.id === p.threadId)
    result = { thread: thread?.historyMode === 'paginated' ? { ...thread, turns: [] } : thread }
  }
  if (req.method === 'thread/turns/list') {
    const turns = state.find((s) => s.id === p.threadId).turns
    const index = Number(p.cursor ?? 0)
    result = {
      data: turns.slice(index, index + 1),
      nextCursor: index + 1 < turns.length ? String(index + 1) : null,
    }
  }
  if (req.method === 'thread/name/set') {
    state.find((s) => s.id === p.threadId).name = p.name
    writeFileSync(path, JSON.stringify(state))
  }
  if (req.method === 'externalAgentConfig/import') {
    const importId = randomUUID()
    const source = p.migrationItems[0].details.sessions[0]
    const rows = readFileSync(source.path, 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s))
    const thread = {
      id: randomUUID(),
      cwd: source.cwd,
      name: source.title,
      updatedAt: 100,
      turns: [
        {
          items: rows
            .filter((r) => r.message)
            .map((r) =>
              r.type === 'user'
                ? { type: 'userMessage', content: r.message.content }
                : { type: 'agentMessage', text: r.message.content[0].text },
            ),
        },
      ],
    }
    const fail = process.env.SESSION_TEST_IMPORT_ERROR === '1'
    if (!fail) {
      state.push(thread)
      writeFileSync(path, JSON.stringify(state))
    }
    // Completion may precede the response; the real RPC allows that ordering.
    send({
      method: 'externalAgentConfig/import/completed',
      params: {
        importId,
        itemTypeResults: [
          {
            itemType: 'SESSIONS',
            successes: fail ? [] : [{ target: thread.id }],
            failures: fail ? [{ message: 'synthetic import refused' }] : [],
          },
        ],
      },
    })
    result = { importId }
  }
  send({ id: req.id, result })
})
