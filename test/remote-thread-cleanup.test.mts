import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { startWebSocketTransport } from '../src/transports.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
test('remote project preflight accepts a fixed location and rejects canonical temporary paths', async () => {
  const { requireFixedProject } = await import('../../scripts/' + 'probe-remote-headless.mjs')
  assert.doesNotThrow(() => requireFixedProject('/fixed-claude-project'))
  const temporaryProject = await tempDir('remote-project-')
  for (const path of [realpathSync(tmpdir()), realpathSync('/tmp'), realpathSync(temporaryProject)])
    assert.throws(() => requireFixedProject(path), /must be fixed outside the temporary directory/)
})
for (const evidence of ['matched', 'absent']) {
  test(`remote GPT work requires a persistent thread and current upstream evidence: ${evidence}`, async () => {
    const { remoteGptWork } = await import('../../scripts/' + 'probe-remote-headless.mjs')
    let persistent: boolean | undefined
    const events: any[] = [
      {
        event: 'codex.mux.route',
        pid: 123,
        threadId: 'old',
        method: 'turn/start',
        id: 'old',
        route: 'upstream',
      },
    ]
    const ctx = {
      api: { successfulPong: (turn: any) => turn.status === 'completed' && turn.text === 'PONG' },
      start: async (model: string, value: boolean) => {
        assert.equal(model, 'gpt-fake')
        persistent = value
        return 'owned'
      },
      owner: () => ({ pid: 123 }),
      events: () => events,
      terminal: async () => ({ success: true }),
      client: {
        turn: async () => {
          if (evidence === 'matched')
            events.push(
              {
                event: 'codex.mux.route',
                pid: 123,
                threadId: 'owned',
                method: 'turn/start',
                id: 'request',
                route: 'upstream',
              },
              {
                event: 'codex.upstream.forward',
                pid: 123,
                method: 'turn/start',
                downId: 'request',
                upId: 'forward',
              },
              {
                event: 'codex.upstream.response',
                pid: 123,
                method: 'turn/start',
                downId: 'request',
                upId: 'forward',
                ok: true,
              },
            )
          return { threadId: 'owned', turnId: 'turn', status: 'completed', text: 'PONG' }
        },
      },
    }
    if (evidence === 'matched') await remoteGptWork(ctx, 'gpt-fake')
    else await assert.rejects(remoteGptWork(ctx, 'gpt-fake'), /upstream/)
    assert.equal(persistent, true)
  })
}
async function port() {
  const socket = net.createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const value = (socket.address() as net.AddressInfo).port
  await new Promise<void>((done) => socket.close(() => done()))
  return value
}
for (const ordering of [
  'withheld',
  'late',
  'after-snapshot',
  'normal',
  'announced-last',
  'partial',
]) {
  test(`persistent remote start ownership: ${ordering}`, async () => {
    const { RemoteClient } = await import('../../scripts/' + 'probe-remote-headless.mjs')
    const work = await tempDir('remote-start-cleanup-')
    const cwd = join(work, 'fixed-project')
    const url = `ws://127.0.0.1:${await port()}`
    const persisted = new Set(['unrelated'])
    const deleted: string[] = []
    let answer = () => {}
    const server = await startWebSocketTransport(
      url,
      (peer, m: any) => {
        if (m.method === 'thread/start') {
          persisted.add('owned')
          const thread = { id: 'owned', cwd, ephemeral: false }
          answer = () =>
            peer.send({ jsonrpc: '2.0', id: m.id, result: { thread, model: 'gpt-fake' } })
          peer.send({
            method: 'thread/started',
            params: { thread: { ...thread, id: 'unrelated' } },
          })
          if (ordering === 'announced-last') answer()
          peer.send({
            method: 'thread/started',
            params: { thread: ordering === 'partial' ? { cwd, ephemeral: false } : thread },
          })
          if (ordering === 'normal') answer()
        } else if (m.method === 'thread/unsubscribe') {
          peer.send({ jsonrpc: '2.0', id: m.id, result: { status: 'unsubscribed' } })
        } else if (m.method === 'thread/delete') {
          deleted.push(m.params.threadId)
          persisted.delete(m.params.threadId)
          peer.send({ method: 'thread/deleted', params: { threadId: m.params.threadId } })
          peer.send({ jsonrpc: '2.0', id: m.id, result: {} })
        }
      },
      () => {},
    )
    const client = await RemoteClient.connect(url, 'fake-run-token')
    const owned = new Map<string, string>()
    const released = new Set<string>()
    try {
      const start = client.startThread(
        { model: 'gpt-fake', cwd, ephemeral: false, baseInstructions: 'private-test-prompt' },
        false,
        1000,
      )
      if (['normal', 'announced-last'].includes(ordering)) await start
      else await assert.rejects(start, /timed out/)
      assert.equal(persisted.has('owned'), true)
      const late = async () => {
        let off = () => {}
        const received = new Promise<void>((done) => {
          off = client.onNotification((m: any) => {
            if (m.id != null && m.result?.thread?.id === 'owned') done()
          })
        })
        answer()
        await received.finally(off)
      }
      if (ordering === 'late') await late()
      client.collectThreadStarts(owned)
      for (const [id, kind] of owned) {
        await client.releaseThread(id, kind === 'persistent')
        released.add(id)
      }
      if (ordering === 'after-snapshot') await late()
      await client.close()
      if (['withheld', 'after-snapshot', 'partial'].includes(ordering)) {
        assert.throws(() => client.verifyThreadCleanup(work, owned, released), /thread.*unknown/)
        assert.equal(existsSync(work), true)
        const evidence = JSON.parse(readFileSync(join(work, 'thread-cleanup.json'), 'utf8'))
        assert.equal(evidence.status, 'unknown')
        assert.equal(evidence.starts.length, 1)
        assert.equal(evidence.starts[0].cwd, cwd)
        assert.equal(evidence.starts[0].model, 'gpt-fake')
        assert.equal(persisted.has('owned'), true)
        assert.deepEqual(deleted, [])
        if (ordering === 'withheld') assert.ok(evidence.starts[0].announcements.includes('owned'))
        if (ordering === 'after-snapshot') assert.equal(evidence.starts[0].threadId, 'owned')
        assert.equal(statSync(join(work, 'thread-cleanup.json')).mode & 0o777, 0o600)
        assert.equal(JSON.stringify(evidence).includes('fake-run-token'), false)
        assert.equal(JSON.stringify(evidence).includes('private-test-prompt'), false)
      } else {
        client.verifyThreadCleanup(work, owned, released)
        assert.equal(persisted.has('owned'), false)
        assert.deepEqual(deleted, ['owned'])
        assert.equal(existsSync(join(work, 'thread-cleanup.json')), false)
      }
      assert.equal(owned.has('unrelated'), false)
      assert.equal(persisted.has('unrelated'), true)
    } finally {
      await client.close()
      await server.close()
    }
  })
}
