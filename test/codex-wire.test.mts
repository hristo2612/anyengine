import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  type HeaderBag,
  isPrewarm,
  modelHint,
  parentThreadIdOfRequest,
  parentTurnIdOfRequest,
  threadIdOfRequest,
  turnIdOfRequest,
  turnMetadata,
} from '../src/codex-wire.mjs'

import { codexCompatVersion } from '../src/util.mjs'

const pinned = codexCompatVersion()
const fixture = JSON.parse(readFileSync(resolve(`test/fixtures/codex-wire-${pinned}.json`), 'utf8'))
const THREAD = '01a0f297-8ac5-7862-bd5c-50e6ed797973'
const OTHER = '01a0f297-9f00-7000-8000-000000000002'
const TURN = '01a0f297-8acd-7b93-a3d6-0bb7238f5bce'
const LATER = '01a0f297-8ad0-7000-8000-000000000003'
const metadata = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    thread_id: THREAD,
    turn_id: TURN,
    session_id: THREAD,
    agent_name: '/root',
    request_kind: 'turn',
    sandbox_mode: 'read-only',
    model: 'opus',
    ...extra,
  })

test('wire: the pinned capture carries every field the contract reads', () => {
  assert.equal(fixture.codexVersion, pinned)
  for (const shape of [fixture, fixture.plain]) {
    for (const name of ['thread-id', 'session-id', 'x-codex-turn-metadata']) {
      assert.ok(shape.responsesHeaderNames.includes(name), name)
    }
    for (const key of ['thread_id', 'turn_id', 'request_kind', 'model', 'agent_name']) {
      assert.ok(shape.responsesTurnMetadataKeys.includes(key), key)
    }
    for (const key of ['x-codex-turn-metadata', 'turn_id']) {
      assert.ok(shape.responsesBody.clientMetadataKeys.includes(key), key)
    }
  }
  assert.ok(fixture.modelListIds.includes('opus'))
})

test('wire: the thread id comes from the header, then the metadata, then the body', () => {
  assert.equal(threadIdOfRequest({ 'thread-id': THREAD }, null), THREAD)
  assert.equal(threadIdOfRequest({ 'x-codex-turn-metadata': metadata() }, null), THREAD)
  assert.equal(threadIdOfRequest({}, { client_metadata: { thread_id: THREAD } }), THREAD)
  assert.equal(threadIdOfRequest({ 'session-id': THREAD }, null), THREAD)
  assert.equal(threadIdOfRequest({}, { prompt_cache_key: THREAD }), THREAD)
  assert.equal(threadIdOfRequest({}, {}), null)
})

test('wire: when the thread sources disagree, the earlier one in that order wins', () => {
  const body = (thread: string) => ({
    client_metadata: { 'x-codex-turn-metadata': metadata({ thread_id: thread }) },
  })
  assert.equal(threadIdOfRequest({ 'thread-id': THREAD, 'session-id': OTHER }, null), THREAD)
  assert.equal(threadIdOfRequest({ 'thread-id': THREAD }, body(OTHER)), THREAD)
  assert.equal(
    threadIdOfRequest({ 'session-id': OTHER, 'x-codex-turn-metadata': metadata() }, null),
    THREAD,
  )
  assert.equal(
    threadIdOfRequest({ 'session-id': OTHER }, { client_metadata: { thread_id: THREAD } }),
    THREAD,
  )
  assert.equal(threadIdOfRequest({ 'session-id': THREAD }, { prompt_cache_key: OTHER }), THREAD)
  // The socket's thread-id header can go first: the capture saw every frame
  // on a socket name that socket's thread.
  const frames = Object.values(fixture.websocket).flatMap((sockets: any) =>
    sockets.flatMap((socket: any) => socket.frames),
  )
  assert.ok(frames.length > 0 && frames.every((frame: any) => frame.sameThread))
})

test('wire: turn id, request kind and model come from the turn metadata', () => {
  const headers = { 'x-codex-turn-metadata': metadata() }
  assert.equal(turnIdOfRequest(headers, null), TURN)
  assert.equal(turnMetadata(headers, null).requestKind, 'turn')
  assert.equal(turnMetadata(headers, null).agentName, '/root')
  assert.equal(modelHint(headers), 'opus')
  assert.equal(modelHint({ 'x-codex-routing-hint': 'model=gpt-6-sol' }), 'gpt-6-sol')
  assert.equal(
    isPrewarm({ 'x-codex-turn-metadata': metadata({ request_kind: 'prewarm' }) }, null),
    true,
  )
  assert.equal(isPrewarm({}, { generate: false }), true)
  assert.equal(isPrewarm(headers, {}), false)
})

test('wire: every metadata field is read, from one source as a whole', () => {
  const header = {
    'x-codex-turn-metadata': metadata({ agent_name: '/root/a', sandbox_mode: 'workspace-write' }),
  }
  const whole = {
    threadId: THREAD,
    turnId: TURN,
    sessionId: THREAD,
    agentName: '/root/a',
    requestKind: 'turn',
    sandboxMode: 'workspace-write',
    model: 'opus',
  }
  assert.deepEqual(turnMetadata(header, null), whole)
  assert.deepEqual(turnMetadata(header, {}), whole)
  const own = {
    thread_id: OTHER,
    turn_id: LATER,
    session_id: OTHER,
    agent_name: '/root/b',
    request_kind: 'compact',
    sandbox_mode: 'read-only',
  }
  const body = { client_metadata: { 'x-codex-turn-metadata': JSON.stringify(own) } }
  // The body's copy wins over the header, and a field it lacks (model) is not
  // filled in from the header.
  assert.deepEqual(turnMetadata(header, body), {
    threadId: OTHER,
    turnId: LATER,
    sessionId: OTHER,
    agentName: '/root/b',
    requestKind: 'compact',
    sandboxMode: 'read-only',
    model: null,
  })
  assert.deepEqual(turnMetadata({}, body), turnMetadata(header, body))
})

test("wire: with no metadata header, the body's copy of it is read", () => {
  assert.ok(fixture.responsesBody.clientMetadataKeys.includes('x-codex-turn-metadata'))
  const body = { client_metadata: { 'x-codex-turn-metadata': metadata() } }
  assert.equal(turnMetadata({}, body).turnId, TURN)
  assert.equal(turnIdOfRequest({}, body), TURN)
  assert.equal(threadIdOfRequest({}, body), THREAD)
})

test('wire: a body that says anything about its turn is the only word on it', () => {
  const stale = { 'x-codex-turn-metadata': metadata({ turn_id: TURN }) }
  assert.equal(turnIdOfRequest(stale, { client_metadata: { turn_id: LATER } }), LATER)
  const prewarmFrame = {
    generate: false,
    client_metadata: {
      turn_id: '',
      'x-codex-turn-metadata': metadata({ request_kind: 'prewarm', turn_id: '' }),
    },
  }
  assert.equal(turnIdOfRequest(stale, prewarmFrame), null)
  assert.equal(turnIdOfRequest(stale, { client_metadata: {} }), TURN)
  assert.equal(turnIdOfRequest({ 'turn-id': LATER }, null), LATER)
  // Within the body, the turn metadata's copy comes first, as in turnMetadata.
  const both = {
    client_metadata: { turn_id: TURN, 'x-codex-turn-metadata': metadata({ turn_id: LATER }) },
  }
  assert.equal(turnIdOfRequest(stale, both), LATER)
  assert.equal(turnIdOfRequest(stale, both), turnMetadata(stale, both).turnId)
})

test('wire: a prewarm is what the request says, not what its socket was opened for', () => {
  const socket = { 'x-codex-turn-metadata': metadata({ request_kind: 'prewarm', turn_id: '' }) }
  assert.equal(isPrewarm(socket, null), true)
  assert.equal(isPrewarm(socket, {}), false)
  assert.equal(
    isPrewarm(socket, { client_metadata: { 'x-codex-turn-metadata': metadata() } }),
    false,
  )
  const own = {
    client_metadata: { 'x-codex-turn-metadata': metadata({ request_kind: 'prewarm' }) },
  }
  assert.equal(isPrewarm({ 'x-codex-turn-metadata': metadata() }, own), true)
})

// Replays every WebSocket frame the capture recorded: the headers its socket
// was opened with, and the frame's own client_metadata. Ids are the fixture's
// labels made concrete.
const idOf = (label: string | null) => (label === 'empty' ? '' : label && `turn-${label}`)
function replay(socket: any, frame: any): { headers: HeaderBag; body: Record<string, unknown> } {
  const headers = {
    'thread-id': THREAD,
    'x-codex-turn-metadata': metadata({
      request_kind: socket.requestKind,
      turn_id: idOf(socket.turn),
    }),
  }
  const body: Record<string, unknown> = {
    type: frame.type,
    client_metadata: {
      thread_id: THREAD,
      turn_id: idOf(frame.clientTurn),
      'x-codex-turn-metadata': metadata({
        request_kind: frame.requestKind,
        turn_id: idOf(frame.turn),
      }),
    },
  }
  if (frame.generate !== null) body.generate = frame.generate
  return { headers, body }
}

test('wire: every frame of the captured prewarm and reconnect sequences is read as its own turn', () => {
  let prewarmSocket = 0
  let staleReconnect = 0
  for (const [shape, sockets] of Object.entries(fixture.websocket) as [string, any[]][]) {
    assert.ok(sockets.length >= 2, `${shape}: a reconnect was captured`)
    for (const socket of sockets) {
      for (const frame of socket.frames) {
        const { headers, body } = replay(socket, frame)
        const where = `${shape} ${frame.frame}`
        const turnId = idOf(frame.turn) || null
        assert.equal(turnIdOfRequest(headers, body), turnId, where)
        assert.equal(isPrewarm(headers, body), frame.generate === false, where)
        assert.equal(turnMetadata(headers, body).requestKind, frame.requestKind, where)
        assert.equal(threadIdOfRequest(headers, body), THREAD, where)
        if (socket.requestKind === 'prewarm' && frame.generate !== false) prewarmSocket += 1
        if (/^T/.test(socket.turn) && socket.turn !== frame.turn) staleReconnect += 1
      }
    }
  }
  // The capture holds both traps: turns on a socket opened for a prewarm, and
  // a turn on a reconnected socket whose headers name the turn before it.
  assert.ok(prewarmSocket >= 2, `turns on a prewarm socket: ${prewarmSocket}`)
  assert.ok(staleReconnect >= 1, `turns under a reconnect's stale turn id: ${staleReconnect}`)
})

test('wire: a spawned child names its parent in the body, else in the header', () => {
  const header = { 'x-codex-parent-thread-id': ' p1 ' }
  const body = { client_metadata: { 'x-codex-parent-thread-id': 'p2' } }
  assert.equal(parentThreadIdOfRequest(header), 'p1')
  assert.equal(parentThreadIdOfRequest(header, { client_metadata: {} }), 'p1')
  assert.equal(parentThreadIdOfRequest(header, body), 'p2')
  assert.equal(parentThreadIdOfRequest({}, body), 'p2')
  // A root thread sends neither.
  assert.ok(!fixture.responsesHeaderNames.includes('x-codex-parent-thread-id'))
  assert.ok(!fixture.responsesBody.clientMetadataKeys.includes('x-codex-parent-thread-id'))
})

test('wire: junk metadata and arrays read as nothing, never throw', () => {
  assert.equal(turnMetadata({ 'x-codex-turn-metadata': '{not json' }, null).threadId, null)
  assert.equal(
    turnMetadata({}, { client_metadata: { 'x-codex-turn-metadata': '[1]' } }).threadId,
    null,
  )
  // A junk copy in the body is no copy: the header still speaks.
  const junkCopy = { client_metadata: { 'x-codex-turn-metadata': '["x"]' } }
  assert.equal(turnMetadata({ 'x-codex-turn-metadata': metadata() }, junkCopy).turnId, TURN)
  assert.equal(threadIdOfRequest({ 'thread-id': ['a', 'b'] }, null), 'a')
  assert.equal(parentThreadIdOfRequest({ 'x-codex-parent-thread-id': ' p1 ' }), 'p1')
  assert.equal(parentThreadIdOfRequest({}), null)
})

test('wire: parent turn comes from the current frame, never stale upgrade metadata', () => {
  const headers = { 'x-codex-turn-metadata': metadata({ parent_turn_id: 'old' }) }
  assert.equal(parentTurnIdOfRequest(headers, null), 'old')
  assert.equal(
    parentTurnIdOfRequest(headers, {
      client_metadata: { 'x-codex-turn-metadata': metadata({ parent_turn_id: 'current' }) },
    }),
    'current',
  )
  assert.equal(
    parentTurnIdOfRequest(headers, { client_metadata: { 'x-codex-turn-metadata': metadata() } }),
    null,
  )
})
