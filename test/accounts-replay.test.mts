import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { AccountParticipant } from '../src/accounts-participant.mjs'
import { AccountReplay, CONTINUE_PROMPT } from '../src/accounts-replay.mjs'
import { rotateAccount } from '../src/accounts-rotation.mjs'
import { AccountWork } from '../src/accounts-work.mjs'
import { asRecord } from '../src/rpc-shape.mjs'
import type { JsonRpcRequest } from '../src/types.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
for (const scenario of ['on', 'off', 'new-user', 'disconnect', 'restart', 'disabled-later']) {
  test(`usage continuation is once, after rotation, with a fresh lease (${scenario})`, async () => {
    const runtime = new AccountParticipant(await accountFixture(), 'adapter')
    await runtime.ready
    runtime.setHooks({ async stop() {}, async restart() {} })
    const work = new AccountWork(runtime),
      sent: JsonRpcRequest[] = []
    const dispatch = async (peer: Parameters<AccountWork['admit']>[0], request: JsonRpcRequest) => {
      assert.equal(runtime.ledger.workCount(), 1)
      sent.push(request)
      work.observe({
        method: 'turn/started',
        params: { threadId: 'thread', turn: { id: 'continue' } },
      })
      peer.send({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId: 'thread', turn: { id: 'continue', status: 'completed' } },
      })
    }
    let replay = new AccountReplay(work, dispatch)
    const peer = { id: 'app', send() {}, close() {} }
    try {
      if (scenario !== 'off')
        runtime.ledger.metadata.editRegistry((r) => ({ ...r, replay: 'continue-prompt' }))
      replay.user(peer, {
        id: 1,
        method: 'turn/start',
        params: {
          threadId: 'thread',
          model: 'gpt-6.1-sol',
          input: [{ type: 'text', text: 'DO NOT RESEND ORIGINAL' }],
        },
      })
      const failed = {
        jsonrpc: '2.0' as const,
        method: 'turn/completed',
        params: {
          threadId: 'thread',
          turn: { id: 'failed', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } },
        },
      }
      replay.observe(failed)
      replay.observe(failed)
      await replay.flush()
      assert.equal(sent.length, 0, 'same generation cannot replay')
      if (scenario === 'new-user')
        replay.user(peer, { id: 2, method: 'turn/start', params: { threadId: 'thread' } })
      if (scenario === 'disconnect') replay.disconnect(peer.id)
      if (scenario === 'restart') replay = new AccountReplay(work, dispatch)
      if (scenario === 'disabled-later')
        runtime.ledger.metadata.editRegistry((r) => ({ ...r, replay: 'none' }))
      await rotateAccount(runtime.ledger, 'b', 'manual')
      await replay.flush()
      await replay.flush()
      assert.equal(sent.length, scenario === 'on' ? 1 : 0)
      if (scenario === 'on') {
        assert.deepEqual(asRecord(sent[0]?.params).input, [{ type: 'text', text: CONTINUE_PROMPT }])
        assert.doesNotMatch(JSON.stringify(sent), /DO NOT RESEND ORIGINAL/)
      }
      assert.equal(runtime.ledger.workCount(), 0)
    } finally {
      await work.close()
    }
  })
}

test('closing one surface does not cancel another surface with the same peer ID', async () => {
  const runtime = new AccountParticipant(await accountFixture(), 'adapter')
  await runtime.ready
  runtime.setHooks({ async stop() {}, async restart() {} })
  runtime.ledger.metadata.editRegistry((r) => ({ ...r, replay: 'continue-prompt' }))
  const work = new AccountWork(runtime),
    sent: string[] = []
  const dispatch = async (peer: Parameters<AccountWork['admit']>[0], request: JsonRpcRequest) => {
    const threadId = String(asRecord(request.params).threadId)
    sent.push(threadId)
    peer.send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId, turn: { id: 'continued', status: 'completed' } },
    })
  }
  const first = new AccountReplay(work, dispatch),
    second = new AccountReplay(work, dispatch)
  const peer = { id: 'stdio', send() {}, close() {} }
  try {
    for (const [replay, thread] of [
      [first, 'a'],
      [second, 'b'],
    ] as const) {
      replay.user(peer, { id: 1, method: 'turn/start', params: { threadId: thread } })
      replay.observe({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {
          threadId: thread,
          turn: { id: 'failed', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } },
        },
      })
    }
    first.disconnect(peer.id)
    await rotateAccount(runtime.ledger, 'b', 'manual')
    await first.flush()
    await second.flush()
    assert.deepEqual(sent, ['b'])
    assert.equal(runtime.ledger.workCount(), 0)
  } finally {
    await work.close()
  }
})
