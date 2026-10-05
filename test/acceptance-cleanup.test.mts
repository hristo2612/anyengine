import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { AppServerClient } from '../src/smoke-client.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
for (const order of ['normal', 'late', 'withheld', 'after-snapshot']) {
  test(`stdio acceptance owns only exact start replies and joins cleanup: ${order}`, async () => {
    const { AcceptanceThreads } = await import('../../scripts/' + 'probe-acceptance.mjs')
    const work = await tempDir('acceptance-cleanup-')
    const client = AppServerClient.launch(
      process.execPath,
      [resolve('test/fixtures/acceptance-client.mjs')],
      { ...process.env, FAKE_ORDER: order === 'normal' ? 'normal' : 'withheld' },
    )
    const threads = new AcceptanceThreads(client)
    try {
      const start = threads.start(
        { model: 'gpt-fake', cwd: '/fixed', ephemeral: false },
        false,
        1000,
      )
      if (order === 'normal') await start
      else await assert.rejects(start, /timed out/)
      if (order === 'late') await client.request('fixture/reply', {})
      await threads.release()
      if (order === 'after-snapshot') await client.request('fixture/reply', {})
      await client.close()
      if (['withheld', 'after-snapshot'].includes(order)) {
        assert.throws(() => threads.verify(work), /cleanup unknown/)
        const record = JSON.parse(readFileSync(join(work, 'thread-cleanup.json'), 'utf8'))
        assert.equal(record.starts.length, 1)
        assert.equal(
          record.owned.some(([id]: string[]) => id === 'unrelated'),
          false,
        )
        assert.equal(existsSync(work), true)
      } else {
        threads.verify(work)
        assert.deepEqual([...threads.released], ['owned'])
      }
    } finally {
      await client.close()
      threads.detach()
    }
  })
}
test('stdio reply observer is armed before send, survives deadline and refuses callback errors', async () => {
  const client = AppServerClient.launch(
    process.execPath,
    [resolve('test/fixtures/acceptance-client.mjs')],
    { ...process.env, FAKE_ORDER: 'withheld' },
  )
  const replies: any[] = []
  try {
    await assert.rejects(
      (client.request as any)(
        'thread/start',
        { model: 'gpt-fake', cwd: '/fixed' },
        1000,
        (message: any) => replies.push(message),
      ),
      /timed out/,
    )
    await client.request('fixture/reply', {})
    assert.equal(replies[0]?.result.thread.id, 'owned')
    const rejected = assert.rejects(
      (client.request as any)('thread/start', { model: 'gpt-fake', cwd: '/fixed' }, 30_000, () => {
        throw new Error('observer rejected')
      }),
      /observer rejected/,
    )
    await client.request('fixture/reply', {}).catch(() => {})
    await rejected
  } finally {
    await client.close()
  }
})
test('malformed/conflicting exact replies retain identities without granting unrelated deletion', async () => {
  const { AcceptanceThreads } = await import('../../scripts/' + 'probe-acceptance.mjs')
  for (const order of ['wrong-model', 'conflict']) {
    const work = await tempDir('acceptance-uncertain-')
    const client = AppServerClient.launch(
      process.execPath,
      [resolve('test/fixtures/acceptance-client.mjs')],
      { ...process.env, FAKE_ORDER: 'withheld' },
    )
    const threads = new AcceptanceThreads(client)
    try {
      const start = threads.start({ model: 'gpt-fake', cwd: '/fixed', ephemeral: false })
      await client.request('fixture/reply', { wrongModel: order === 'wrong-model' })
      await start
      if (order === 'conflict') await client.request('fixture/reply', { conflict: true })
      await threads.release()
      await client.close()
      assert.throws(() => threads.verify(work), /cleanup unknown/)
      const record = JSON.parse(readFileSync(join(work, 'thread-cleanup.json'), 'utf8'))
      assert.deepEqual(
        record.starts[0].replyIds,
        order === 'conflict' ? ['owned', 'conflicting'] : ['owned'],
      )
      assert.deepEqual([...threads.released], ['owned'])
    } finally {
      await client.close()
      threads.detach()
    }
  }
})
test('existing stdio turn collector keeps fast completion and optional model selection', async () => {
  const client = AppServerClient.launch(
    process.execPath,
    [resolve('test/fixtures/acceptance-client.mjs')],
    process.env,
  )
  try {
    assert.equal((await client.turn('owned', 'PONG', 1000, 'opus')).text, 'opus')
    assert.equal((await client.turn('owned', 'PONG', 1000)).text, 'default')
  } finally {
    await client.close()
  }
})
test('acceptance wrapper joins actual client and removes only its files on assertion/unknown cleanup', async () => {
  const { AcceptanceThreads, acceptanceFiles } = await import(
    '../../scripts/' + 'probe-acceptance.mjs'
  )
  const { settleAcceptance } = await import('../../scripts/lib/' + 'acceptance-lifecycle.mjs')
  for (const defect of ['none', 'assertion', 'pending']) {
    const work = await tempDir('acceptance-lifetime-')
    const project = await tempDir('acceptance-project-')
    const cleanupFiles = acceptanceFiles(project)
    const client = AppServerClient.launch(
      process.execPath,
      [resolve('test/fixtures/acceptance-client.mjs')],
      { ...process.env, FAKE_ORDER: defect === 'pending' ? 'withheld' : 'normal' },
    )
    const threads = new AcceptanceThreads(client)
    let joined = false,
      sessions = false
    try {
      const start = threads.start(
        { model: 'gpt-fake', cwd: '/fixed', ephemeral: false },
        false,
        1000,
      )
      if (defect === 'pending') await assert.rejects(start, /timed out/)
      else await start
      const promise = settleAcceptance({
        client,
        threads,
        work,
        stamp: lstatSync(work),
        settled: defect !== 'assertion',
        error: defect === 'assertion' ? new Error('work assertion') : null,
        cleanupFiles,
        collect() {},
        verify() {},
        pruneSessions() {
          sessions = true
        },
        processes: {
          sample() {},
          async close() {
            joined = true
          },
        },
      })
      if (defect === 'none') {
        await promise
        assert.equal(existsSync(work), false)
      } else {
        await assert.rejects(promise, /assertion|cleanup unknown/)
        assert.equal(existsSync(join(work, 'acceptance-cleanup.json')), true)
      }
      assert.equal(joined, true)
      assert.equal(sessions, true)
      assert.equal(existsSync(join(project, 'README.md')), false)
      assert.equal(existsSync(join(project, 'main.txt')), false)
      assert.throws(() => process.kill(-client.pid, 0), { code: 'ESRCH' })
    } finally {
      await client.close()
      threads.detach()
    }
  }
})
