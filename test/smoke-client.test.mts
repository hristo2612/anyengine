import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import type { PathContext } from '../src/smoke.mjs'
import {
  AppServerClient,
  responseText,
  routerCleanupLog,
  successfulPong,
} from '../src/smoke-client.mjs'
import { startProbeThread } from '../src/smoke-paths.mjs'
import { type AdapterProbe, requirePtySession, strictEvents } from '../src/smoke-probes.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

async function clientCase(mode: string, fn: (client: AppServerClient) => Promise<void>) {
  const client = AppServerClient.launch(
    process.execPath,
    [resolve('test/fixtures/smoke-client.mjs'), mode],
    process.env,
  )
  try {
    await fn(client)
  } finally {
    await client.close()
  }
}

test('smoke client arms turn reception before a fast reply and matches exact thread/turn', async () => {
  await clientCase('fast', async (client) => {
    const result = await client.turn('parent', 'PONG', 30000)
    assert.equal(result.threadId, 'parent')
    assert.equal(result.turnId, 'turn-1')
    assert.equal(result.text, 'PONG')
    assert.equal(result.status, 'completed')
    assert.equal(result.items.length, 1)
    assert.equal(successfulPong(result), true)
  })
})
for (const mode of ['failed', 'interrupted', 'error', 'no-final']) {
  test(`smoke client rejects ${mode} even when deltas mention PONG`, async () => {
    await clientCase(mode, async (client) => {
      assert.equal(successfulPong(await client.turn('parent', 'PONG', 30000)), false)
    })
  })
}
test('smoke client excludes another thread and an old queued completed turn', async () => {
  await clientCase('unrelated', async (client) => {
    const result = await client.turn('parent', 'PONG', 30000)
    assert.equal(result.text, 'NO')
    assert.equal(successfulPong(result), false)
  })
})
test('smoke client rejects server errors and pending work on process exit', async () => {
  await clientCase('exit', async (client) => {
    await assert.rejects(client.request('bad', {}), /fixture refusal/)
    await assert.rejects(client.request('leave', {}), /closed|exited/)
  })
})
test('smoke client closes a silent process and rejects its pending request', async () => {
  await clientCase('silent', async (client) => {
    const waiting = client.request('silent', {}, 30000)
    const rejected = assert.rejects(waiting, /closed|exited/)
    await client.close()
    await rejected
  })
})
test('smoke client joins its detached family when the direct child exits before a resistant grandchild', async () => {
  await clientCase('fast', async (client) => {
    const { pid } = await client.request('family', {})
    try {
      await client.close()
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  })
})

test('smoke reads the fake bundled server final agent message, including a non-PONG reply', async () => {
  for (const reply of ['PONG', 'not the requested reply']) {
    const client = AppServerClient.launch(
      process.execPath,
      [resolve('test/fixtures/fake-codex-app-server.mjs')],
      {
        ...process.env,
        FAKE_CODEX_NO_APPROVAL: '1',
        FAKE_CODEX_REPLY: reply,
      },
    )
    try {
      await client.initialize()
      const started = await client.request('thread/start', {
        model: 'gpt-5.6-sol',
        ephemeral: true,
      })
      const result = await client.turn(started.thread.id, 'Reply with exactly the word PONG')
      assert.equal(result.text, reply)
      assert.equal(successfulPong(result), reply === 'PONG')
    } finally {
      await client.close()
    }
  }
})

test('smoke rejects an oversized unterminated or invalid UTF8 message before request timeout', async () => {
  for (const mode of ['oversized', 'bad-utf8'])
    await clientCase(mode, async (client) => {
      await assert.rejects(client.request('invalid-bytes', {}, 4000), /limit|UTF|encoded/)
    })
})

test('bounded HTTP smoke receipt cancels overflow and rejects malformed UTF8', async () => {
  let canceled = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(Buffer.alloc(11))
    },
    cancel() {
      canceled = true
    },
  })
  await assert.rejects(responseText(new Response(stream), 10), /limit/)
  assert.equal(canceled, true)
  await assert.rejects(responseText(new Response(Buffer.from([255])), 10), /encoded/)
  assert.equal(await responseText(new Response('{"ok":true}'), 20), '{"ok":true}')
})

test('pinned fake Codex distinguishes ephemeral unsubscribe from persisted deletion', async () => {
  const client = AppServerClient.launch(
    process.execPath,
    [resolve('test/fixtures/fake-codex-app-server.mjs')],
    process.env,
  )
  try {
    const ephemeral = await client.request('thread/start', {
      model: 'gpt-fixture',
      ephemeral: true,
    })
    assert.equal(ephemeral.thread.ephemeral, true)
    await assert.rejects(
      client.request('thread/delete', { threadId: ephemeral.thread.id }),
      /not persisted/,
    )
    await client.releaseThread(ephemeral.thread.id, false)
    const persisted = await client.request('thread/start', {
      model: 'gpt-fixture',
      ephemeral: false,
    })
    assert.equal(persisted.thread.ephemeral, false)
    await client.releaseThread(persisted.thread.id, true)
    await assert.rejects(
      client.request('thread/read', { threadId: persisted.thread.id }),
      /not found/,
    )
  } finally {
    await client.close()
  }
})

for (const mode of ['null-ack', 'array-ack']) {
  test(`persisted cleanup rejects ${mode} even with a matching deletion notification`, async () => {
    await clientCase(mode, async (client) => {
      await assert.rejects(client.releaseThread('owned', true), /result|acknowledgment/)
    })
  })
}

after(removeTempDirs)
for (const defect of [
  'none',
  'failed-joined',
  'missing',
  'unknown',
  'stale',
  'truncated',
  'malformed',
  'mismatch',
  'write-failure',
]) {
  test(`router cleanup metadata fails closed for ${defect}`, async () => {
    const root = await tempDir('smoke-router-life-')
    const path = join(root, 'log.jsonl')
    let pending = 0
    const ctx = {
      request: { attempt: 'owned-attempt' },
      run: {
        pending() {
          pending++
        },
      },
      cohort: [],
      uncertain: false,
    } as unknown as PathContext
    const life = routerCleanupLog(ctx, path, () => strictEvents(path))
    if (defect === 'write-failure') mkdirSync(path)
    const launch = { launchId: 'owned-launch', threadId: 'owned-thread', turnId: 'owned-turn' }
    if (defect === 'write-failure') {
      assert.throws(() => life.log.info('trampoline.group.launch', launch))
      assert.equal(ctx.uncertain, true)
      assert.equal(pending, 1)
      return
    }
    life.log.info('trampoline.group.launch', launch)
    if (defect === 'failed-joined') life.log.error('trampoline.failed', { code: 1 })
    if (defect !== 'missing')
      life.log.info('trampoline.group.settled', {
        ...launch,
        groupPid: 123,
        joined: defect !== 'unknown',
        ...(defect === 'mismatch' ? { turnId: 'foreign' } : {}),
      })
    if (defect === 'stale')
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('owned-attempt', 'old-attempt'))
    if (defect === 'truncated') writeFileSync(path, readFileSync(path).subarray(0, -10))
    if (defect === 'malformed') writeFileSync(path, Buffer.from([255, 10]))
    if (['none', 'failed-joined'].includes(defect)) {
      life.joined()
      assert.equal(ctx.uncertain, false)
    } else {
      assert.throws(() => life.joined())
      assert.equal(ctx.uncertain, true)
    }
    assert.ok(pending > 0)
  })
}

for (const persistent of [false, true]) {
  test(`group EPERM is retried but never treated as absence: persistent=${persistent}`, async (t) => {
    const client = AppServerClient.launch(
      process.execPath,
      [resolve('test/fixtures/smoke-client.mjs'), 'fast'],
      process.env,
    )
    const kill = process.kill.bind(process)
    let observed = 0
    let signals = 0
    const mocked = t.mock.method(
      process,
      'kill',
      (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -client.pid && signal !== 0) signals++
        if (pid === -client.pid && signal === 0 && (++observed === 1 || persistent))
          throw Object.assign(new Error('controlled group observation unknown'), { code: 'EPERM' })
        return kill(pid, signal)
      },
    )
    try {
      if (persistent) await assert.rejects(client.close(), /remains alive/)
      else await client.close()
      assert.ok(observed > 1)
      assert.equal(signals, 0, 'unknown observation must not trigger group signals')
    } finally {
      mocked.mock.restore()
      await client.close().catch(() => {})
      assert.throws(() => process.kill(-client.pid, 0), { code: 'ESRCH' })
    }
  })
}

// Real compiled local protocol, mock runtime only: no installed/PTY acceptance.
for (const defect of ['none', 'missing-start-model', 'wrong-start-model']) {
  test(`compiled local thread model comes from start response, not thread/read: ${defect}`, async () => {
    const home = await tempDir('smoke-local-read-')
    const client = AppServerClient.launch(
      process.execPath,
      [resolve('dist/src/adapter.mjs'), 'app-server'],
      {
        ...process.env,
        ANYENGINE_MOCK: '1',
        ANYENGINE_NATIVE_CODEX: '0',
        ANYENGINE_HOME: home,
        ANYENGINE_DEBUG_LOG: join(home, 'debug.jsonl'),
      },
    )
    const probe = { client, root: home, threads: new Map() } as unknown as AdapterProbe
    const ctx = { deps: { project: home }, sequence: 1 } as PathContext
    const request = client.request.bind(client)
    client.request = async (method, params, timeout, observer) => {
      const result = await request(method, params, timeout, observer)
      if (method === 'thread/start' && defect === 'missing-start-model') delete result.model
      if (method === 'thread/start' && defect === 'wrong-start-model')
        result.model = 'wrong-selected-model'
      return result
    }
    try {
      await client.initialize()
      if (defect !== 'none') {
        await assert.rejects(startProbeThread(probe, ctx, 'haiku', true), /model/)
        return
      }
      const id = await startProbeThread(probe, ctx, 'haiku', true)
      const work = await client.turn(id, 'PONG')
      const response = await client.request('thread/read', { threadId: id, includeTurns: true })
      assert.equal(Object.hasOwn(response.thread, 'model'), false)
      const terminal = await client.terminal(id, work.turnId, 'haiku', home)
      assert.equal(terminal.success, true)
      const selected = strictEvents(join(home, 'debug.jsonl')).find(
        (e) => e.event === 'runtime.turn.select' && e.threadId === id && e.turnId === work.turnId,
      )
      assert.equal(selected?.model, 'haiku')
      assert.notEqual(selected?.selectedType, 'anyengine', 'mock success must remain non-PTY')
    } finally {
      for (const id of probe.threads.keys()) await client.releaseThread(id, false)
      await client.close()
    }
  })
}
test('PTY selection rejects missing or mismatched actual runtime model', () => {
  const selected: Record<string, unknown> = {
    event: 'runtime.turn.select',
    pid: 123,
    threadId: 'thread',
    turnId: 'turn',
    model: 'haiku',
    selectedType: 'anyengine',
  }
  const session = {
    event: 'anyengine.session',
    pid: 123,
    threadId: 'thread',
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  }
  const probe = {
    identity: { pid: 123 },
    events: () => [selected, session],
  } as unknown as AdapterProbe
  requirePtySession(probe, 'thread', 'turn', 'haiku')
  for (const model of [undefined, 'wrong']) {
    if (model === undefined) delete selected.model
    else selected.model = model
    assert.throws(() => requirePtySession(probe, 'thread', 'turn', 'haiku'), /actual interactive/)
  }
})
