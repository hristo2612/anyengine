import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import readline from 'node:readline'
import test, { after } from 'node:test'
import { type HeaderBag, parentThreadIdOfRequest, threadIdOfRequest } from '../src/codex-wire.mjs'
import { codexCompatVersion } from '../src/util.mjs'
import { killChildren, spawn } from './helpers/children.mjs'

after(() => killChildren())

// Recordings of how codex announces a spawn_agent child: 0.159's, written by
// scripts/capture-codex-spawn.mjs, and the 0.155 spike's, the fallback
// reference. Ids are labels (PARENT, CHILD, CHILD_n, TURN_<thread>).
const pinned = codexCompatVersion()
const CURRENT = resolve(`test/fixtures/codex-spawn-${pinned}.json`)
const PREVIOUS = resolve('test/fixtures/codex-spawn-0.159.0.json')
const SPIKE = resolve('test/fixtures/codex-spawn-0.155-spike.json')
const FAKE_CODEX = resolve('test/fixtures/fake-codex-app-server.mjs')
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const recordings = [CURRENT, PREVIOUS, SPIKE].filter((p) => existsSync(p)).map(read)

type Note = {
  method: string
  threadId?: string | undefined
  turnId?: string | undefined
  parentThreadId?: string | null | undefined
  item?: Record<string, any> | undefined
}

// The current pinned recording, which the tests below read: committed with them, so
// a missing or tool-less one is a failure, never a skip.
function current(): Record<string, any> {
  assert.ok(existsSync(CURRENT), `${CURRENT} is missing: run scripts/capture-codex-spawn.mjs`)
  const rec = read(CURRENT)
  assert.notEqual(rec.multiAgentToolsOffered, false, 'the pinned recording has no spawn')
  assert.equal(rec.codexVersion, pinned)
  return rec
}

const isLink = (m: Note, child: string) =>
  (m.method === 'item/completed' &&
    m.item?.type === 'collabAgentToolCall' &&
    m.item?.tool === 'spawnAgent' &&
    m.item?.receiverThreadIds?.includes(child)) ||
  (m.method === 'thread/started' && m.threadId === child && m.parentThreadId === 'PARENT')

test('spawn recording: at least one recording exists', () => {
  assert.ok(recordings.length > 0)
})

// What codex guarantees (the recording's orderInvariant): the link precedes
// the child's first model request. Where the child's own notifications fall
// against the link is a race (on persisted threads its turn/started came up
// to ~10 ms before it), so the lists are canonical and no test reads an
// order into them.
test('spawn recording: every child is linked to its parent and starts a turn', () => {
  for (const rec of recordings.filter((r) => r.multiAgentToolsOffered !== false)) {
    const links: Array<[string, Note[]]> = [['CHILD', rec.notifications]]
    for (const l of rec.websocket?.links ?? []) links.push([l.child, l.notifications])
    if (rec.ephemeral) links.push(['CHILD', rec.ephemeral.notifications])
    for (const [child, notes] of links) {
      assert.ok(
        notes.some((m) => isLink(m, child)),
        `${rec.codexVersion}: no notification links ${child}`,
      )
      assert.ok(
        notes.some((m) => m.method === 'turn/started' && m.threadId === child),
        `${rec.codexVersion}: ${child} starts no turn`,
      )
    }
  }
})

test('spawn recording (0.159): every link preceded its child first model request', () => {
  const rec = current()
  assert.match(rec.orderInvariant, /before the child's first model request/)
  assert.equal(rec.threads, 'persisted')
  const flags = [
    rec.linkBeforeFirstModelRequest,
    ...rec.websocket.links.map((l: Record<string, any>) => l.linkBeforeFirstModelRequest),
    rec.ephemeral.linkBeforeFirstModelRequest,
    rec.shapes.inheritModel.linkBeforeFirstModelRequest,
    rec.shapes.forkContext.linkBeforeFirstModelRequest,
  ]
  assert.deepEqual(flags, [true, true, true, true, true, true])
})

test('spawn recording: the link is the spawn item, started without receivers', () => {
  for (const rec of recordings.filter((r) => r.multiAgentToolsOffered !== false)) {
    const spawns = (rec.notifications as Note[]).filter((m) => m.item?.tool === 'spawnAgent')
    const started = spawns.find((m) => m.method === 'item/started')
    const completed = spawns.find((m) => m.method === 'item/completed')
    assert.deepEqual(started?.item?.receiverThreadIds, [], rec.codexVersion)
    assert.equal(completed?.item?.senderThreadId, 'PARENT', rec.codexVersion)
    assert.equal(completed?.item?.id, started?.item?.id, rec.codexVersion)
    assert.ok(completed?.item?.model, rec.codexVersion)
    assert.equal(rec.childThreadStarted, false, `${rec.codexVersion}: a child's thread/started`)
  }
})

test('spawn recording (0.159): the child request names its own thread', () => {
  assert.equal(current().childRequest.threadIdHeader, 'CHILD')
})

test('spawn recording (0.159): two children, each linked, each on its own socket', () => {
  const { websocket } = current()
  assert.equal(websocket.spawned, 2)
  assert.deepEqual(
    websocket.links.map((l: { child: string }) => l.child),
    ['CHILD_1', 'CHILD_2'],
  )
  assert.deepEqual(
    websocket.sockets.map((s: { threadIdHeader: string }) => s.threadIdHeader),
    ['CHILD_1', 'CHILD_2'],
  )
  assert.equal(websocket.childThreadStarted, false)
})

test('spawn recording (0.159): thread/read names the parent of a child (the thread/read fallback)', () => {
  const rec = current()
  for (const thread of [rec.childThread, ...rec.websocket.childThreads]) {
    assert.equal(thread.parentThreadId, 'PARENT')
    assert.equal(thread.source.subAgent.thread_spawn.parent_thread_id, 'PARENT')
    assert.equal(thread.model, 'opus')
    assert.equal(thread.ephemeral, false)
  }
})

// A child request rebuilt from the recording: the headers that carry an id,
// the sub-agent header, the turn metadata, and the body's client_metadata.
function rebuilt(
  shape: Record<string, any>,
  body: Record<string, any>,
): { headers: HeaderBag; body: Record<string, unknown> } {
  const headers: HeaderBag = { ...shape.idHeaders }
  if (shape.subagentHeader) headers['x-openai-subagent'] = shape.subagentHeader
  headers['x-codex-turn-metadata'] = JSON.stringify(shape.turnMetadata)
  return {
    headers,
    body: {
      model: body.model,
      prompt_cache_key: body.promptCacheKey,
      client_metadata: {
        ...body.clientMetadata,
        'x-codex-turn-metadata': JSON.stringify(body.turnMetadata),
      },
    },
  }
}

test('spawn recording (0.159): the wire contract reads each child request as recorded', () => {
  const rec = current()
  const requests: Array<[string, Record<string, any>, Record<string, any>]> = [
    ['CHILD', rec.childRequest, rec.childRequest.body],
  ]
  for (const socket of rec.websocket.sockets) {
    for (const frame of socket.frames) requests.push([socket.child, socket, frame])
  }
  assert.equal(requests.length, 5)
  for (const [child, shape, body] of requests) {
    const request = rebuilt(shape, body)
    // Its own thread, in several places, although session-id and
    // prompt_cache_key name the root.
    assert.equal(shape.sessionIdHeader, 'PARENT')
    assert.equal(body.promptCacheKey, 'PARENT')
    assert.equal(shape.idHeaders['x-client-request-id'], child)
    assert.equal(shape.idHeaders['x-codex-window-id'], `${child}:0`)
    assert.equal(body.clientMetadata.thread_id, child)
    assert.equal(threadIdOfRequest(request.headers, request.body), child)
    // Its parent: in the body and in the header, each enough on its own.
    assert.equal(shape.parentThreadIdHeader, 'PARENT')
    assert.equal(body.clientMetadata['x-codex-parent-thread-id'], 'PARENT')
    assert.equal(parentThreadIdOfRequest(request.headers, request.body), 'PARENT')
    assert.equal(parentThreadIdOfRequest({}, request.body), 'PARENT')
    assert.equal(parentThreadIdOfRequest(request.headers), 'PARENT')
    assert.equal(shape.subagentHeader, 'collab_spawn')
    assert.equal(body.turnMetadata.parent_thread_id, 'PARENT')
  }
})

const spawnItems = (notes: Note[]) => notes.filter((m) => m.item?.tool === 'spawnAgent')

test('spawn shapes (0.159): no model, the child inherits the parent model', () => {
  const { inheritModel } = current().shapes
  assert.equal(inheritModel.spawnArgs.model, undefined)
  const [started, completed] = spawnItems(inheritModel.notifications)
  // Only the completion names the model codex resolved.
  assert.equal(started?.item?.model, '')
  assert.equal(started?.item?.reasoningEffort, 'low')
  assert.equal(completed?.item?.model, 'gpt-spawn-probe')
  assert.equal(completed?.item?.reasoningEffort, 'low')
  assert.deepEqual(completed?.item?.receiverThreadIds, ['CHILD_INHERIT'])
  assert.equal(inheritModel.childRequest.model, 'gpt-spawn-probe')
  assert.equal(inheritModel.childRequest.parentThreadIdHeader, 'PARENT')
})

test('spawn shapes (0.159): fork_context announces the same, and forks the history', () => {
  const { forkContext, inheritModel } = current().shapes
  assert.equal(forkContext.spawnArgs.fork_context, true)
  const [started, completed] = spawnItems(forkContext.notifications)
  assert.equal(started?.item?.model, 'opus')
  assert.deepEqual(completed?.item?.receiverThreadIds, ['CHILD_FORK'])
  const texts: string[] = forkContext.childRequest.userTexts
  // The parent's user messages come before the task; an unforked child gets
  // only its environment and the task.
  assert.equal(texts.at(-1), 'Reply with exactly the word PING')
  assert.ok(texts.includes('Step 1: spawn_agent'))
  assert.deepEqual(inheritModel.childRequest.userTexts, [
    '<environment_context>',
    'Reply with exactly the word PONG',
  ])
})

test('spawn shapes (0.159): follow-ups start child turns without a new spawn item', () => {
  const { steps, childRequests } = current().shapes.followUps
  const tools = (s: Record<string, any>) =>
    [...new Set(s.parentItems.map((n: Note) => n.item?.tool))] as string[]
  assert.deepEqual(
    steps.map((s: Record<string, any>) => [s.call, tools(s), s.childTurnsStarted]),
    [
      ['spawn_agent', ['spawnAgent'], 1],
      ['send_input', ['sendInput'], 1],
      ['close_agent', ['closeAgent'], 0],
      ['resume_agent', ['resumeAgent'], 0],
      ['send_input', ['sendInput'], 1],
    ],
  )
  for (const s of steps.slice(1)) {
    for (const n of s.parentItems) assert.deepEqual(n.item?.receiverThreadIds, ['CHILD'])
  }
  assert.equal(steps[2].childUnloaded, true)
  assert.match(steps[3].childWarnings.join('\n'), /recorded with model `opus` but is resuming/)
  // After close and resume the child runs on the parent's model, still as a
  // spawned child of PARENT.
  assert.deepEqual(
    childRequests.map((r: Record<string, any>) => r.model),
    ['opus', 'opus', 'gpt-spawn-probe'],
  )
  for (const r of childRequests) {
    assert.equal(r.subagentHeader, 'collab_spawn')
    assert.equal(r.parentThreadIdHeader, 'PARENT')
    assert.equal(r.clientMetadataParent, 'PARENT')
  }
})

// --- The fake codex (test/fixtures/fake-codex-app-server.mjs) ------------------

type FakeEvent = Note & { params: Record<string, any> }

interface FakeRun {
  parent: string
  child: string
  events: FakeEvent[]
  thread: Record<string, any>
}

// One turn on the fake with FAKE_CODEX_SPAWN_CHILD, its notifications, and
// thread/read of the child it spawned.
async function fakeSpawn(env: Record<string, string>): Promise<FakeRun> {
  const proc = spawn(process.execPath, [FAKE_CODEX], {
    env: { ...process.env, FAKE_CODEX_NO_APPROVAL: '1', ...env },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const { stdin, stdout } = proc
  if (!stdin || !stdout) throw new Error('the fake codex has no stdio pipes')
  const events: FakeEvent[] = []
  const pending = new Map<number, (result: any) => void>()
  readline.createInterface({ input: stdout }).on('line', (line) => {
    const m = JSON.parse(line)
    if (m.id != null && pending.has(m.id)) pending.get(m.id)?.(m.result)
    else if (m.method) {
      const p = m.params ?? {}
      events.push({
        method: m.method,
        threadId: p.threadId ?? p.thread?.id,
        item: p.item,
        params: p,
      })
    }
  })
  let nextId = 0
  const request = (method: string, params: unknown) =>
    new Promise<any>((ok) => {
      const id = ++nextId
      pending.set(id, ok)
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  await request('initialize', { clientInfo: { name: 'test', version: '0' } })
  const parent = (await request('thread/start', { model: 'gpt-spawn-probe' })).thread.id
  await request('turn/start', { threadId: parent, input: [] })
  const deadline = Date.now() + 30_000
  const done = () => events.some((e) => e.method === 'turn/completed' && e.threadId === parent)
  while (!done() && Date.now() < deadline) await new Promise((ok) => setTimeout(ok, 20))
  const link = events.find((e) => e.method === 'item/completed' && e.item?.tool === 'spawnAgent')
  const child = link?.params?.item.receiverThreadIds[0]
  const { thread } = await request('thread/read', { threadId: child })
  stdin.end()
  return { parent, child, events, thread }
}

// The fake's notifications as the capture writes them: labelled, link
// notifications only, in canonical order (each child's own after its link).
function canonical(run: FakeRun, childLabel: string): Note[] {
  const label = (id: string | undefined) =>
    id === run.parent ? 'PARENT' : id === run.child ? childLabel : id
  const turnLabel = (id: string | undefined) =>
    id?.endsWith('-child') ? `TURN_${childLabel}` : 'TURN_PARENT'
  const note = (e: FakeEvent): Note => {
    const n: Note = { method: e.method, threadId: label(e.threadId) }
    const turn = e.params?.turnId ?? e.params?.turn?.id
    if (turn) n.turnId = turnLabel(turn)
    const item = e.params?.item
    if (item) {
      n.item = {
        type: item.type,
        id: 'SPAWN_1',
        tool: item.tool,
        status: item.status,
        senderThreadId: label(item.senderThreadId),
        receiverThreadIds: item.receiverThreadIds.map(label),
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        prompt: item.prompt,
      }
    }
    return n
  }
  const own = run.events.filter(
    (e) => e.threadId === run.parent && (e.method === 'turn/started' || e.item !== undefined),
  )
  const childTurn = run.events.find((e) => e.method === 'turn/started' && e.threadId === run.child)
  const out: Note[] = []
  for (const e of own) {
    if (e.method === 'turn/started' || e.item?.tool === 'spawnAgent') out.push(note(e))
    if (e.method === 'item/completed' && e.item?.tool === 'spawnAgent' && childTurn)
      out.push(note(childTurn))
  }
  return out
}

const position = (run: FakeRun, pick: (e: FakeEvent) => boolean) => run.events.findIndex(pick)

for (const order of ['link-first', 'child-first']) {
  test(`fake codex: ${order} spawns announce the child as the recording does`, async () => {
    const rec = current()
    const run = await fakeSpawn({ FAKE_CODEX_SPAWN_CHILD: 'opus', FAKE_CODEX_SPAWN_ORDER: order })
    assert.deepEqual(canonical(run, 'CHILD'), rec.notifications)
    const link = position(
      run,
      (e) => e.method === 'item/completed' && e.item?.tool === 'spawnAgent',
    )
    const turn = position(run, (e) => e.method === 'turn/started' && e.threadId === run.child)
    const status = position(
      run,
      (e) => e.method === 'thread/status/changed' && e.threadId === run.child,
    )
    assert.ok(status >= 0 && status < link, 'the child is named before its link, as recorded')
    if (order === 'child-first') assert.ok(turn < link, 'child-first: turn/started before the link')
    else assert.ok(turn > link, 'link-first: turn/started after the link')
    assert.equal(
      run.events.some((e) => e.method === 'thread/started' && e.threadId === run.child),
      false,
    )
    assert.equal(run.thread.parentThreadId, run.parent)
    assert.equal(run.thread.source.subAgent.thread_spawn.parent_thread_id, run.parent)
  })
}

test('fake codex: an inherit spawn announces the parent model only on completion', async () => {
  const rec = current()
  const run = await fakeSpawn({ FAKE_CODEX_SPAWN_CHILD: 'inherit' })
  for (const e of run.events) (e as Note).item = (e as any).params?.item
  const recorded = rec.shapes.inheritModel.notifications as Note[]
  // The recorded shape pass's parent turn was its first, as the fake's is.
  assert.deepEqual(canonical(run, 'CHILD_INHERIT').slice(1), recorded)
  assert.equal(run.thread.model, 'gpt-spawn-probe')
})

test('fake codex: FAKE_CODEX_CHILD_THREAD_STARTED adds the second source', async () => {
  const run = await fakeSpawn({
    FAKE_CODEX_SPAWN_CHILD: 'opus',
    FAKE_CODEX_CHILD_THREAD_STARTED: '1',
  })
  const started = run.events.find((e) => e.method === 'thread/started' && e.threadId === run.child)
  const thread = started?.params.thread
  assert.equal(thread?.parentThreadId, run.parent)
  assert.equal(thread?.source?.subAgent?.thread_spawn?.parent_thread_id, run.parent)
})
