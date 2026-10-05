import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { encryptedFailure } from '../src/accounts-continuity.mjs'
import { AccountParticipant } from '../src/accounts-participant.mjs'
import { CONTINUE_PROMPT } from '../src/accounts-replay.mjs'
import { rotateAccount } from '../src/accounts-rotation.mjs'
import { AccountWork } from '../src/accounts-work.mjs'
import { NativeCodexMux } from '../src/codex-mux.mjs'
import { CodexUpstream } from '../src/codex-upstream.mjs'
import { DEFAULT_POSTURE } from '../src/posture.mjs'
import { asRecord, idOf } from '../src/rpc-shape.mjs'
import { SessionStore } from '../src/store.mjs'
import type { JsonRpcResponse, RpcPeer, WireMessage } from '../src/types.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
const pause = () => new Promise((r) => setTimeout(r, 10))
async function until(predicate: () => boolean) {
  const end = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Missing fixture message')
    await pause()
  }
}
test('encrypted error matching accepts structured code and exact token, never generic badRequest', () => {
  assert.equal(encryptedFailure({ data: { code: 'invalid_encrypted_content' } }), true)
  assert.equal(encryptedFailure({ additionalDetails: 'invalid_encrypted_content' }), true)
  assert.equal(encryptedFailure({ message: 'invalid_encrypted_content_extra' }), false)
  assert.equal(encryptedFailure({ code: 'badRequest' }), false)
})
for (const mode of [
  'turn',
  'resume',
  'rpc',
  'tool',
  'output',
  'repeated',
  'prefix',
  'late',
  'usage-replay',
  'usage-default',
]) {
  test(`account switch preserves the app thread; encrypted fallback safety (${mode})`, async () => {
    const paths = await accountFixture()
    const runtime = new AccountParticipant(paths, 'adapter')
    await runtime.ready
    const work = new AccountWork(runtime),
      store = new SessionStore(join(paths.root, 'threads.sqlite'))
    const stateFile = join(paths.root, 'fake-state.json')
    const messages: WireMessage[] = []
    const peer: RpcPeer = { id: 'app', send: (m) => messages.push(m), close() {} }
    let mux: NativeCodexMux | null = null
    const upstream = new CodexUpstream({
      binary: resolve('test/fixtures/fake-account-continuity.mjs'),
      args: ['app-server'],
      env: {
        ...process.env,
        FAKE_ACCOUNT_STATE_PATH: stateFile,
        FAKE_ACCOUNT_FAILURE: mode.startsWith('usage')
          ? 'usage'
          : ['prefix', 'late'].includes(mode)
            ? 'turn'
            : mode,
        FAKE_ACCOUNT_REFUSE_INJECT: mode === 'prefix' ? '1' : '0',
        FAKE_ACCOUNT_ANNOUNCE_LAST: mode === 'late' ? '1' : '0',
      },
      reserveEnabled: false,
      processLifecycle: runtime.lifecycle,
      onMessage: (m) => mux?.onUpstreamMessage(m),
    })
    mux = new NativeCodexMux({
      store,
      upstream,
      accountWork: work,
      local: {
        async dispatch() {
          return { data: [] }
        },
        localThreadOwner() {
          return null
        },
        localThreadModel() {
          return null
        },
        localThreadPosture() {
          return DEFAULT_POSTURE
        },
        hasActiveTurn() {
          return false
        },
        async adoptThread() {},
      },
    })
    runtime.setHooks({
      stop: () => upstream.stop(),
      restart: async () => {
        await upstream.restartForAccounts()
        mux?.afterAccountRestart()
      },
    })
    let next = 1
    const request = async (method: string, params: Record<string, unknown>) => {
      const id = next++
      const message = { jsonrpc: '2.0' as const, id, method, params }
      const admitted = work.admit(peer, message)
      assert.notEqual(admitted, false)
      assert.equal(await mux?.handle(admitted || peer, message), true)
      await until(() => messages.some((m) => 'id' in m && m.id === id && !('method' in m)))
      return messages.find((m) => 'id' in m && m.id === id && !('method' in m)) as JsonRpcResponse
    }
    try {
      await request('initialize', { clientInfo: { name: 'test', version: '1' } })
      const started = await request('thread/start', {
        model: 'gpt-6.1-sol',
        cwd: paths.root,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        developerInstructions: 'keep instruction',
      })
      const appId = idOf(asRecord(asRecord(started.result).thread))
      assert.ok(appId)
      await request('turn/start', {
        threadId: appId,
        input: [{ type: 'text', text: 'Remember ORCHID' }],
      })
      await until(() => runtime.ledger.workCount() === 0)
      if (mode === 'usage-replay')
        runtime.ledger.metadata.editRegistry((r) => ({ ...r, replay: 'continue-prompt' }))
      await rotateAccount(runtime.ledger, 'b', 'manual')
      const before = messages.length
      const original = [
        { type: 'text', text: 'Recall the word' },
        { type: 'localImage', path: '/fixture/image.png' },
      ]
      await request('turn/start', { threadId: appId, input: original })
      await until(() => runtime.ledger.workCount() === 0)
      if (mode.startsWith('usage')) {
        const replayStart = messages.length
        await rotateAccount(runtime.ledger, 'c', 'manual')
        if (mode === 'usage-replay') {
          await until(() =>
            messages.slice(replayStart).some((m) => 'method' in m && m.method === 'turn/completed'),
          )
          await until(() => runtime.ledger.workCount() === 0)
        }
        const replayState = JSON.parse(await readFile(stateFile, 'utf8'))
        const continuations = replayState.requests.filter(
          (r: any) => r.method === 'turn/start' && r.params.input?.[0]?.text === CONTINUE_PROMPT,
        )
        assert.equal(continuations.length, mode === 'usage-replay' ? 1 : 0)
        assert.equal(Object.keys(replayState.threads).length, 1)
        if (mode === 'usage-replay') {
          const completed = messages
            .slice(replayStart)
            .find((m) => 'method' in m && m.method === 'turn/completed')
          assert.equal(asRecord(asRecord(completed).params).threadId, appId)
        }
        return
      }
      const state = JSON.parse(await readFile(stateFile, 'utf8'))
      const rows = Object.values(state.threads) as Record<string, any>[]
      const unsafe = mode === 'tool' || mode === 'output'
      assert.equal(rows.length, unsafe ? 1 : 2)
      const terminals = messages
        .slice(before)
        .filter((m) => 'method' in m && m.method === 'turn/completed')
      assert.equal(terminals.length, 1)
      const terminal = asRecord(asRecord(terminals[0]).params)
      assert.equal(terminal.threadId, appId)
      assert.equal(
        asRecord(terminal.turn).status,
        unsafe || mode === 'repeated' ? 'failed' : 'completed',
      )
      if (!unsafe) {
        const current = rows.at(-1)
        assert.ok(current)
        const retries = state.requests.filter(
          (r: any) => r.method === 'turn/start' && r.params.threadId === current.id,
        )
        assert.equal(retries.length, 1)
        assert.deepEqual(
          mode === 'prefix' ? retries[0].params.input.slice(1) : retries[0].params.input,
          original,
        )
        assert.match(
          mode === 'prefix' ? retries[0].params.input[0].text : JSON.stringify(current.injection),
          /ORCHID/,
        )
        assert.doesNotMatch(JSON.stringify(current.injection), /localImage|encrypted/)
        assert.equal(current.model, 'gpt-6.1-sol')
        assert.equal(current.cwd, paths.root)
        const listed = await request('thread/list', {})
        const list = asRecord(listed.result).data as unknown[]
        assert.equal(list.length, 1)
        assert.equal(asRecord(list[0]).createdAt, 1)
        const loaded = await request('thread/loaded/list', {})
        assert.deepEqual(asRecord(loaded.result).data, [appId])
        const view = await request('thread/read', { threadId: appId, includeTurns: true })
        assert.equal(asRecord(asRecord(view.result).thread).createdAt, 1)
      }
    } finally {
      await mux.stop()
      await work.close()
      store.close()
    }
  })
}
