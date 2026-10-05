import assert from 'node:assert/strict'
import test, { after, type TestContext } from 'node:test'
import { setConfigValue } from '../src/anyengine-config.mjs'
import { findCodexResults } from '../src/trampoline-tools.mjs'
import { killChildren } from './helpers/children.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'
import { body, frames, output, setup, textOf, user, wsTurn } from './helpers/trampoline-router.mjs'

after(killChildren)
after(removeTempDirs)
const callOf = (events: any[]) => {
  const call = output(events).find((item: any) => item.type === 'function_call')
  assert.ok(call, JSON.stringify(events))
  return call
}
const result = (call: any) => ({
  type: 'function_call_output',
  call_id: call.call_id,
  output: 'answer',
})
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
function holdOwns(t: TestContext, h: Awaited<ReturnType<typeof setup>>) {
  const original = h.claimHost.waitForClaimThread.bind(h.claimHost)
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let first = true
  t.mock.method(h.claimHost, 'waitForClaimThread', async (id: string, ms: number) => {
    if (first) {
      first = false
      enter()
      await held
    }
    return original(id, ms)
  })
  t.after(() => release())
  return { entered, release }
}
const malformedCall = () => ({
  type: 'function_call',
  call_id: 'historical',
  name: { toString: null },
  arguments: '{}',
})
const failedPrompt = (events: any[]) => {
  assert.equal(events.at(-1)?.type, 'response.failed')
  assert.equal(events.at(-1)?.response.error.code, 'invalid_prompt')
}

for (const thread of ['a', 'b']) {
  test(`retired result-only input preserves the current child on ${thread === 'a' ? 'the same' : 'another'} thread`, async (t) => {
    const h = await setup(t)
    const retired = callOf(await h.send())
    await h.send(body([result(retired)]))
    const current = callOf(await h.send(body(), thread))
    const pid = h.calls()[1].pid
    assert.ok(alive(pid))
    const rejected = await h.send(body([result(retired)]), thread)
    assert.equal(rejected.at(-1).type, 'response.failed')
    assert.ok(alive(pid), 'retired result cancelled the current child')
    assert.equal(
      textOf(output(await h.send(body([result(current)]), thread))),
      'Codex said: answer',
    )
    assert.equal(h.calls().length, 2)
  })
}

test('delayed model ownership cannot launch after a newer agent request completes', async (t) => {
  const h = await setup(t)
  const hold = holdOwns(t, h)
  const earlier = h.send()
  await hold.entered
  setConfigValue(h.root, 'modes.codexClaude', 'agent')
  assert.equal(textOf(output(await h.send(body([user('agent replacement')])))), 'agent answer')
  assert.equal(h.calls().length, 0)
  hold.release()
  const events = await earlier
  assert.equal(h.calls().length, 0, 'superseded request launched print after its replacement')
  assert.equal(events.at(-1).type, 'response.failed')
})

test('invalid results cannot supersede pending ownership or disturb either live child', async (t) => {
  const h = await setup(t)
  const retired = callOf(await h.send())
  await h.send(body([result(retired)]))
  const a = callOf(await h.send())
  const b = callOf(await h.send(body(), 'b'))
  const pids = h
    .calls()
    .slice(1)
    .map((call) => call.pid)
  const hold = holdOwns(t, h)
  const pending = h.send(body([user('new message after old tools')]))
  await hold.entered
  for (const input of [[result(retired)], [result(b)], [result(a), result(b)]]) {
    assert.equal((await h.send(body(input))).at(-1).type, 'response.failed')
    assert.ok(pids.every(alive), 'invalid results cancelled a live child')
  }
  hold.release()
  const current = callOf(await pending)
  assert.equal(h.calls().length, 4)
  assert.ok(!alive(pids[0]), 'valid replacement must join old child cleanup')
  assert.ok(alive(pids[1]))
  assert.equal(textOf(output(await h.send(body([result(current)])))), 'Codex said: answer')
  assert.equal(textOf(output(await h.send(body([result(b)]), 'b'))), 'Codex said: answer')
})

test('replacement during awaited child cleanup prevents the older model launch', async (t) => {
  const h = await setup(t)
  const current = callOf(await h.send())
  const turn = findCodexResults([result(current)])?.turn
  assert.ok(turn)
  const cancel = turn.cancel.bind(turn)
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  t.after(() => release())
  t.mock.method(turn, 'cancel', async () => {
    await cancel()
    enter()
    await held
  })
  const earlier = h.send(body([user('replace current child')]))
  await entered
  assert.ok(!alive(h.calls()[0].pid))
  setConfigValue(h.root, 'modes.codexClaude', 'agent')
  assert.equal(textOf(output(await h.send(body([user('newer agent request')])))), 'agent answer')
  release()
  assert.equal((await earlier).at(-1).type, 'response.failed')
  assert.equal(h.calls().length, 1, 'a request superseded during cleanup must not launch')
  assert.deepEqual(h.sockets(), [])
})

test('a different thread WebSocket request preserves pending HTTP model admission', async (t) => {
  const h = await setup(t)
  const hold = holdOwns(t, h)
  const earlier = h.send()
  await hold.entered
  setConfigValue(h.root, 'modes.codexClaude', 'agent')
  const ws = await h.socket()
  const answer = await wsTurn(
    ws,
    body([user('agent request on b')], { client_metadata: { thread_id: 'b' } }),
  )
  assert.equal(textOf(output(answer)), 'agent answer')
  hold.release()
  const current = callOf(await earlier)
  assert.equal(h.calls().length, 1)
  setConfigValue(h.root, 'modes.codexClaude', 'model')
  assert.equal(textOf(output(await h.send(body([result(current)])))), 'Codex said: answer')
  assert.equal(h.calls().length, 1)
})

for (const mode of ['model', 'agent']) {
  for (const transport of ['HTTP', 'WS']) {
    test(`malformed ${mode} history fails only the ${transport} request and accepts valid follow-up`, async (t) => {
      const h = await setup(t)
      setConfigValue(h.root, 'modes.codexClaude', mode)
      const ws = transport === 'WS' ? await h.socket() : null
      const send = async (input: unknown[]) => {
        if (ws) return wsTurn(ws, body(input, { client_metadata: { thread_id: 'a' } }))
        const response = await fetch(`${h.router.baseUrl}/responses`, {
          method: 'POST',
          headers: { 'thread-id': 'a' },
          body: JSON.stringify(body(input)),
          signal: AbortSignal.timeout(30000),
        })
        const raw = await response.text()
        assert.equal(response.status, 200, raw)
        return frames(raw)
      }
      failedPrompt(await send([malformedCall(), user('continue')]))
      assert.equal(h.calls().length, 0)
      assert.equal(h.contexts.length, 0)
      if (ws) assert.equal(ws.readyState, 1)
      const next = await send([user('valid follow-up')])
      if (mode === 'model') {
        const current = callOf(next)
        assert.equal(h.calls().length, 1)
        assert.equal(textOf(output(await send([result(current)]))), 'Codex said: answer')
        assert.equal(h.calls().length, 1)
      } else {
        assert.equal(textOf(output(next)), 'agent answer')
        assert.equal(h.contexts.length, 1)
        assert.equal(h.calls().length, 0)
      }
      if (ws) assert.equal(ws.readyState, 1)
    })
  }
}

test('malformed history cannot supersede pending ownership or cancel the current child', async (t) => {
  const h = await setup(t)
  callOf(await h.send())
  const pid = h.calls()[0].pid
  const hold = holdOwns(t, h)
  const pending = h.send(body([user('valid replacement')]))
  await hold.entered
  failedPrompt(await h.send(body([malformedCall(), user('bad replacement')])))
  assert.ok(alive(pid))
  assert.equal(h.calls().length, 1)
  hold.release()
  const current = callOf(await pending)
  assert.ok(!alive(pid))
  assert.equal(h.calls().length, 2)
  assert.equal(textOf(output(await h.send(body([result(current)])))), 'Codex said: answer')
})

test('malformed history is contained when live results retire during ownership discovery', async (t) => {
  const h = await setup(t)
  const current = callOf(await h.send())
  const turn = findCodexResults([result(current)])?.turn
  assert.ok(turn)
  const hold = holdOwns(t, h)
  const pending = h.send(body([malformedCall(), result(current)]))
  await hold.entered
  await turn.cancel()
  assert.equal(findCodexResults([result(current)]), null)
  hold.release()
  failedPrompt(await pending)
  assert.equal(h.calls().length, 1)
  const next = callOf(await h.send(body([user('valid follow-up after retirement')])))
  assert.equal(h.calls().length, 2)
  assert.equal(textOf(output(await h.send(body([result(next)])))), 'Codex said: answer')
})
