import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { mkdirSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { type ClaimRequest, claimSocketPath, onLines, writeLine } from '../src/claim-protocol.mjs'
import {
  adapterOwns,
  adapterOwnsAt,
  claimOnAdapters,
  claimTimeoutMs,
} from '../src/router-claim-client.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const closers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await removeTempDirs()
})

const request: ClaimRequest = {
  op: 'claim',
  threadId: 'child',
  parentThreadId: 'parent',
  turnId: 'turn',
  model: 'opus',
  prompt: 'PONG',
  cwd: '/forged',
  effort: 'high',
}

async function peer(
  runDir: string,
  pid: number,
  handle: (socket: net.Socket, message: Record<string, unknown>) => void,
) {
  mkdirSync(runDir, { recursive: true })
  const path = claimSocketPath(runDir, pid)
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    onLines(socket, (message) => handle(socket, message))
  })
  await new Promise<void>((ok) => server.listen(path, ok))
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((ok) => server.close(() => ok()))
  }
  closers.push(close)
  return { path, sockets, close }
}

async function directory() {
  return join(await tempDir('ae-rc-'), 'run')
}
const signal = () => new AbortController().signal

test('ownership selects one adapter and only that socket receives the claim', async () => {
  const runDir = await directory()
  const claims: string[] = []
  const first = await peer(runDir, process.pid, (socket, message) => {
    if (message.op === 'owns') {
      writeLine(socket, { type: 'owns', owned: true, cwd: '/trusted' })
      socket.end()
    } else {
      claims.push('first')
      writeLine(socket, { type: 'accepted', posture: 'read-only', cwd: '/trusted' })
      writeLine(socket, { type: 'done', success: true, text: 'PONG' })
    }
  })
  await peer(runDir, process.ppid, (socket, message) => {
    if (message.op === 'owns')
      setTimeout(() => {
        writeLine(socket, { type: 'owns', owned: true, cwd: '/other' })
        socket.end()
      }, 40)
    else claims.push('other')
  })
  const abort = new AbortController()
  const owner = await adapterOwns(runDir, 'child', abort.signal, 200)
  assert.deepEqual(owner, { socketPath: first.path, cwd: '/trusted' })
  assert.ok(owner)
  assert.equal(await claimOnAdapters(owner, request, () => {}, abort.signal, 200), 'claimed')
  assert.deepEqual(claims, ['first'])
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
})

test('ownership preserves trusted null and rejects missing or forged metadata', async () => {
  const runDir = await directory()
  await peer(runDir, process.pid, (socket, message) => {
    writeLine(
      socket,
      message.threadId === 'null'
        ? { type: 'owns', owned: true, cwd: null }
        : { type: 'owns', owned: true, cwd: { path: '/forged' } },
    )
    socket.end()
  })
  assert.deepEqual(await adapterOwns(runDir, 'null', signal(), 100), {
    socketPath: claimSocketPath(runDir),
    cwd: null,
  })
  assert.equal(await adapterOwns(runDir, 'bad', signal(), 100), null)
  assert.equal(await adapterOwns(join(runDir, 'missing'), 'child', signal(), 100), null)
})

test('selected owner loss fails without claiming a conflicting adapter', async () => {
  const runDir = await directory()
  const first = await peer(runDir, process.pid, (socket) => {
    writeLine(socket, { type: 'owns', owned: true, cwd: null })
    socket.end()
  })
  let claims = 0
  await peer(runDir, process.ppid, (socket, message) => {
    if (message.op === 'claim') claims += 1
    else socket.end()
  })
  const owner = await adapterOwns(runDir, 'child', signal(), 100)
  assert.ok(owner)
  await first.close()
  assert.equal(await adapterOwnsAt(first.path, 'child', signal(), 100), null)
  assert.equal(await claimOnAdapters(owner, request, () => {}, signal(), 100), 'failed')
  assert.equal(claims, 0)
})

test('selected-path ownership rechecks refresh trusted cwd and never query other adapters', async () => {
  const runDir = await directory()
  const selected = await peer(runDir, process.pid, (socket, message) => {
    assert.equal(message.as, 'child')
    writeLine(socket, { type: 'owns', owned: true, cwd: '/refreshed' })
    socket.end()
  })
  let queried = false
  await peer(runDir, process.ppid, () => {
    queried = true
  })
  assert.deepEqual(await adapterOwnsAt(selected.path, 'child', signal(), 100), {
    socketPath: selected.path,
    cwd: '/refreshed',
  })
  assert.equal(queried, false)
})

test('silent ownership and preacceptance sockets terminate and release abort listeners', async () => {
  const runDir = await directory()
  const fake = await peer(runDir, process.pid, () => {})
  const abort = new AbortController()
  assert.equal(await adapterOwns(runDir, 'child', abort.signal, 30), null)
  assert.equal(
    await claimOnAdapters(
      { socketPath: fake.path, cwd: null },
      request,
      () => {},
      abort.signal,
      30,
    ),
    'failed',
  )
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
  const preaborted = new AbortController()
  preaborted.abort()
  assert.equal(await adapterOwns(runDir, 'child', preaborted.signal, 30), null)
  assert.equal(
    await claimOnAdapters(
      { socketPath: fake.path, cwd: null },
      request,
      () => {},
      preaborted.signal,
      30,
    ),
    'failed',
  )
})

test('accepted silent claims have no acceptance deadline and abort cleanly', async () => {
  const runDir = await directory()
  let accepted = () => {}
  const ready = new Promise<void>((ok) => {
    accepted = ok
  })
  const fake = await peer(runDir, process.pid, (socket) => {
    writeLine(socket, { type: 'accepted', posture: 'read-only', cwd: '/w' })
  })
  const abort = new AbortController()
  let settled = false
  const outcome = claimOnAdapters(
    { socketPath: fake.path, cwd: '/w' },
    request,
    () => accepted(),
    abort.signal,
    30,
  ).then((value) => {
    settled = true
    return value
  })
  await ready
  await delay(100)
  assert.equal(settled, false)
  abort.abort()
  assert.equal(await outcome, 'failed')
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0)
})

for (const kind of ['early-close', 'malformed', 'callback', 'unknown', 'failed-done'] as const) {
  test(`claim terminal semantics: ${kind}`, async () => {
    const runDir = await directory()
    const fake = await peer(runDir, process.pid, (socket) => {
      if (kind === 'unknown') {
        writeLine(socket, { type: 'unknown' })
        return
      }
      writeLine(socket, { type: 'accepted', posture: 'read-only', cwd: '/w' })
      if (kind === 'malformed') socket.write('bad json\n')
      else if (kind === 'early-close') socket.end()
      else writeLine(socket, { type: 'done', success: kind !== 'failed-done', text: 'PONG' })
    })
    const events: string[] = []
    const outcome = await claimOnAdapters(
      { socketPath: fake.path, cwd: '/w' },
      request,
      (event) => {
        if (kind === 'callback') throw new Error('sink failed')
        events.push(event.type)
      },
      signal(),
      100,
    )
    assert.equal(
      outcome,
      kind === 'unknown' ? 'unknown' : kind === 'failed-done' ? 'claimed' : 'failed',
    )
    if (kind === 'failed-done') assert.deepEqual(events, ['accepted', 'done'])
  })
}

test('discovery budget includes maximum announcement grace, read fallback, and transport margin', async (t) => {
  const runDir = await directory()
  let requested = () => {}
  const ready = new Promise<void>((ok) => {
    requested = ok
  })
  await peer(runDir, process.pid, (socket) => {
    setTimeout(() => {
      writeLine(socket, { type: 'owns', owned: true, cwd: null })
      socket.end()
    }, 35_000)
    requested()
  })
  // 30s is the configured maximum grace; discovery may also need a 5s read.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = adapterOwns(runDir, 'late', signal(), claimTimeoutMs(30_000))
  await ready
  t.mock.timers.tick(35_000)
  assert.ok(await pending)
})
