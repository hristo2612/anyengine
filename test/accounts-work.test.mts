import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { accountControl } from '../src/accounts-control.mjs'
import { AccountParticipant } from '../src/accounts-participant.mjs'
import { accountOwner } from '../src/accounts-rotation.mjs'
import { AccountWork } from '../src/accounts-work.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
for (const order of ['link-first', 'child-first', 'child-completed-first']) {
  test(`native child work retains the admitted parent across freeze (${order})`, async () => {
    const runtime = new AccountParticipant(await accountFixture(), 'adapter')
    await runtime.ready
    const work = new AccountWork(runtime)
    try {
      const peer = { id: 'app', send() {}, close() {} }
      assert.notEqual(
        work.admit(peer, {
          jsonrpc: '2.0',
          id: 1,
          method: 'turn/start',
          params: { threadId: 'parent' },
        }),
        false,
      )
      work.observe({ method: 'turn/started', params: { threadId: 'parent' } })
      work.observe({
        method: 'item/started',
        params: {
          threadId: 'parent',
          item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent' },
        },
      })
      const started = () => work.observe({ method: 'turn/started', params: { threadId: 'child' } })
      const done = () => work.observe({ method: 'turn/completed', params: { threadId: 'child' } })
      const link = () =>
        work.observe({
          method: 'item/completed',
          params: {
            threadId: 'parent',
            item: {
              id: 'spawn',
              type: 'collabAgentToolCall',
              tool: 'spawnAgent',
              receiverThreadIds: ['child'],
            },
          },
        })
      if (order !== 'link-first') started()
      if (order === 'child-completed-first') done()
      const owner = accountOwner()
      runtime.ledger.freeze(owner, 'b', 'manual')
      work.observe({ method: 'turn/completed', params: { threadId: 'parent' } })
      assert.equal(runtime.ledger.workCount(), 1)
      link()
      if (order === 'link-first') started()
      if (order !== 'child-completed-first') {
        assert.equal(runtime.ledger.workCount(), 1)
        done()
      }
      assert.equal(runtime.ledger.workCount(), 0)
      assert.equal(
        work.admit(peer, {
          jsonrpc: '2.0',
          id: 2,
          method: 'turn/start',
          params: { threadId: 'late' },
        }),
        false,
      )
      runtime.ledger.cancelDrain(owner, () => {})
    } finally {
      await work.close()
    }
  })
}

test('realtime stays admitted until closed, and unknown starts cannot enter a drain', async () => {
  const runtime = new AccountParticipant(await accountFixture(), 'adapter')
  await runtime.ready
  const work = new AccountWork(runtime)
  const peer = { id: 'app', send() {}, close() {} }
  const request = (id: number, method: string, threadId: string) =>
    work.admit(peer, { jsonrpc: '2.0', id, method, params: { threadId } })
  const owner = accountOwner()
  try {
    assert.notEqual(request(1, 'thread/realtime/start', 'realtime'), false)
    work.observe({ method: 'turn/started', params: { threadId: 'realtime' } })
    runtime.ledger.freeze(owner, 'b', 'manual')
    work.observe({ method: 'turn/completed', params: { threadId: 'realtime' } })
    assert.equal(runtime.ledger.workCount(), 1)
    assert.notEqual(request(2, 'thread/realtime/appendText', 'realtime'), false)
    assert.equal(request(3, 'unknown/model/start', 'late'), false)
    assert.equal(request(4, 'thread/realtime/appendAudio', 'late'), false)
    work.observe({ method: 'thread/realtime/closed', params: { threadId: 'realtime' } })
    assert.equal(runtime.ledger.workCount(), 0)
    runtime.ledger.cancelDrain(owner, () => {})
  } finally {
    await work.close()
  }
})

test('unknown model starts are refused while open; metadata thread creation stays available', async () => {
  const runtime = new AccountParticipant(await accountFixture(), 'adapter')
  await runtime.ready
  const work = new AccountWork(runtime)
  try {
    const peer = { id: 'app', send() {}, close() {} }
    assert.equal(
      work.admit(peer, { jsonrpc: '2.0', id: 1, method: 'unknown/model/start', params: {} }),
      false,
    )
    assert.notEqual(
      work.admit(peer, { jsonrpc: '2.0', id: 2, method: 'thread/start', params: {} }),
      false,
    )
    assert.equal(runtime.ledger.workCount(), 0)
  } finally {
    await work.close()
  }
})

test('retired participants cannot admit work or launch after recovery reopens Home', async () => {
  const runtime = new AccountParticipant(await accountFixture(), 'adapter')
  await runtime.ready
  const owner = accountOwner()
  try {
    runtime.ledger.freeze(owner, 'home', 'manual')
    await assert.rejects(
      accountControl(runtime.participant, { command: 'retire', generation: 0, owner }),
      /refused/,
    )
    runtime.ledger.phase(owner, 'draining', 'stopped')
    await accountControl(runtime.participant, { command: 'retire', generation: 0, owner })
    assert.equal(runtime.ledger.participants().length, 0)
    const state = runtime.ledger.state()
    runtime.ledger.save({ ...state, phase: 'open', owner: null, intent: null })
    assert.throws(() => runtime.begin(), /retired/)
    await assert.rejects(runtime.lifecycle.spawn(process.execPath, ['--version'], {}), /retired/)
  } finally {
    await runtime.close()
  }
})
