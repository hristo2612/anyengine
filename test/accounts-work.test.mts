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

test('a completed chat accepts follow-ups while another chat stays active, without leaking rotation leases', async () => {
  const runtime = new AccountParticipant(await accountFixture(), 'adapter')
  await runtime.ready
  const work = new AccountWork(runtime)
  const peer = { id: 'app', send() {}, close() {} }
  let id = 0
  const start = (threadId: string) =>
    work.admit(peer, {
      jsonrpc: '2.0',
      id: ++id,
      method: 'turn/start',
      params: { threadId },
    })
  const event = (method: string, threadId: string) => work.observe({ method, params: { threadId } })
  try {
    assert.notEqual(start('long-running'), false)
    event('turn/started', 'long-running')
    for (let turn = 0; turn < 3; turn++) {
      assert.notEqual(start('finished-chat'), false, 'finished chat can continue')
      assert.equal(start('finished-chat'), false, 'a pending start still blocks duplicates')
      event('turn/started', 'finished-chat')
      assert.equal(start('finished-chat'), false, 'an actual active turn still blocks duplicates')
      event('turn/completed', 'finished-chat')
      assert.equal(
        runtime.ledger.workCount(),
        2,
        'one retained lease per chat, never one per reply',
      )
    }
    event('turn/completed', 'long-running')
    assert.equal(runtime.ledger.workCount(), 0)
  } finally {
    await work.close()
  }
})

test('a retained completed-chat lease cannot admit a new turn while account switching is frozen', async () => {
  const runtime = new AccountParticipant(await accountFixture(), 'adapter')
  await runtime.ready
  const work = new AccountWork(runtime)
  const peer = { id: 'app', send() {}, close() {} }
  const start = (id: number, threadId: string) =>
    work.admit(peer, {
      jsonrpc: '2.0',
      id,
      method: 'turn/start',
      params: { threadId },
    })
  const owner = accountOwner()
  try {
    assert.notEqual(start(1, 'long-running'), false)
    work.observe({ method: 'turn/started', params: { threadId: 'long-running' } })
    assert.notEqual(start(2, 'finished-chat'), false)
    work.observe({ method: 'turn/started', params: { threadId: 'finished-chat' } })
    work.observe({ method: 'turn/completed', params: { threadId: 'finished-chat' } })
    runtime.ledger.freeze(owner, 'b', 'manual')
    assert.equal(start(3, 'finished-chat'), false)
    assert.equal(runtime.ledger.workCount(), 2)
    work.observe({ method: 'turn/completed', params: { threadId: 'long-running' } })
    assert.equal(runtime.ledger.workCount(), 0)
    runtime.ledger.cancelDrain(owner, () => {})
  } finally {
    await work.close()
  }
})

for (const method of ['turn/start', 'thread/realtime/start']) {
  test(`a failed ${method} clears its pending state and preserves rotation protection for other active work`, async () => {
    const runtime = new AccountParticipant(await accountFixture(), 'adapter')
    await runtime.ready
    const work = new AccountWork(runtime)
    const peer = { id: 'app', send() {}, close() {} }
    const start = (id: number, threadId: string, startMethod = method) =>
      work.admit(peer, {
        jsonrpc: '2.0',
        id,
        method: startMethod,
        params: { threadId },
      })
    try {
      assert.notEqual(start(1, 'long-running', 'turn/start'), false)
      work.observe({ method: 'turn/started', params: { threadId: 'long-running' } })
      const failed = start(2, 'retrying')
      if (!failed) throw new Error('initial admission failed')
      failed.send({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'fixture refusal' } })
      assert.equal(runtime.ledger.workCount(), 2)
      assert.notEqual(start(3, 'retrying'), false)
      assert.equal(runtime.ledger.workCount(), 2)
      work.observe({ method: 'turn/started', params: { threadId: 'retrying' } })
      work.observe({
        method: method === 'thread/realtime/start' ? 'thread/realtime/closed' : 'turn/completed',
        params: { threadId: 'retrying' },
      })
      work.observe({ method: 'turn/completed', params: { threadId: 'long-running' } })
      assert.equal(runtime.ledger.workCount(), 0)
    } finally {
      await work.close()
    }
  })
}
