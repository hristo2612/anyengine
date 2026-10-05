import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const load = () => import('../../scripts/' + 'probe-acceptance.mjs')
const parent = {
  threadId: 'parent',
  turnId: 'turn-parent',
  status: 'completed',
  error: null,
  text: Array.from(
    { length: 7 },
    (_, i) => `${i + 1}. ${i < 3 ? 'opus' : 'gpt-default'}: Sentence ${i + 1}.`,
  ).join('\n'),
  items: Array.from({ length: 7 }, (_, i) => ({
    id: `spawn-${i}`,
    type: 'collabAgentToolCall',
    tool: 'spawnAgent',
    status: 'completed',
    senderThreadId: 'parent',
    receiverThreadIds: [`child-${i}`],
    model: i < 3 ? 'opus' : 'gpt-default',
  })),
}
function fixture(path: string) {
  const children = Array.from({ length: 7 }, (_, i) => ({
    threadId: `child-${i}`,
    parentThreadId: 'parent',
    turnId: `turn-${i}`,
    model: i < 3 ? 'opus' : 'gpt-default',
    cwd: '/fixed',
    kind: path === 'bridge' && i < 3 ? 'local' : 'persistent',
    ephemeral: path === 'bridge' && i < 3,
    status: 'completed',
    error: null,
    text: `Sentence ${i + 1}.`,
  }))
  const events: Record<string, any>[] = children.flatMap<Record<string, any>>((c) =>
    path === 'native'
      ? c.model === 'opus'
        ? [
            {
              event: 'claim.done',
              pid: 123,
              threadId: c.threadId,
              parentThreadId: 'parent',
              parentTurnId: 'turn-parent',
              turnId: c.turnId,
              model: c.model,
              owner: '/claim-123.sock',
              sessionId: '00000000-0000-4000-8000-000000000001',
              success: true,
              status: 'completed',
            },
          ]
        : []
      : [
          {
            event: 'bridge.spawnSubagent',
            pid: 123,
            parentThreadId: 'parent',
            parentTurnId: 'turn-parent',
            childThreadId: c.threadId,
            model: c.model,
          },
          {
            event: 'bridge.subagent.done',
            pid: 123,
            parentThreadId: 'parent',
            parentTurnId: 'turn-parent',
            threadId: c.threadId,
            turnId: c.turnId,
            model: c.model,
            status: 'completed',
            success: true,
          },
        ],
  )
  const routerEvents =
    path === 'native' ? structuredClone(events).map(({ status, ...event }) => event) : []
  if (path === 'native')
    for (const event of events) {
      delete event.status
      delete event.parentTurnId
    }
  return {
    path,
    mode: 'agent',
    parent: structuredClone(parent),
    children,
    events,
    routerEvents,
    owner: { pid: 123, socketPath: '/claim-123.sock' },
    model: 'gpt-default',
    project: '/fixed',
  }
}
test('acceptance model-mode terminal source requires the actual trampoline owner and zero exit', async () => {
  const { verifyFanout } = await load()
  const f = fixture('native')
  f.mode = 'model'
  f.events = []
  f.routerEvents = f.routerEvents.map((event) => ({
    ...event,
    event: 'trampoline.done',
    code: 0,
    sessionId: 'fake-session',
  }))
  assert.equal(verifyFanout(f).children.length, 7)
  assert.ok(f.routerEvents[0])
  f.routerEvents[0].code = 1
  assert.throws(() => verifyFanout(f), /acceptance/)
  f.routerEvents[0].code = 0
  delete f.routerEvents[0].sessionId
  assert.throws(() => verifyFanout(f), /acceptance/)
})
test('native fanout counts completed children after a failed attempt that created none', async () => {
  const { verifyFanout } = await load()
  const f = fixture('native')
  f.parent.items.push({
    id: 'failed-attempt',
    type: 'collabAgentToolCall',
    tool: 'spawnAgent',
    status: 'failed',
    senderThreadId: 'parent',
    receiverThreadIds: [],
    model: '',
  })
  assert.equal(verifyFanout(f).children.length, 7)
  for (const broken of ['receiver', 'foreign', 'unknown', 'unsettled', 'missing-success']) {
    const bad = structuredClone(f)
    const attempt = bad.parent.items.at(-1) as any
    if (broken === 'receiver') attempt.receiverThreadIds = ['unverified-child']
    if (broken === 'foreign') attempt.senderThreadId = 'foreign'
    if (broken === 'unknown') delete attempt.receiverThreadIds
    if (broken === 'unsettled') attempt.status = 'inProgress'
    if (broken === 'missing-success') bad.parent.items.shift()
    assert.throws(() => verifyFanout(bad), /acceptance/)
  }
})
for (const path of ['native', 'bridge']) {
  test(`acceptance ${path} consumes repeated answers with exact multiplicity`, async () => {
    const { verifyFanout } = await load()
    const f = fixture(path)
    for (const child of f.children) child.text = 'The README describes a tiny project.'
    f.parent.text = f.children
      .map((child, i) => `${i + 1}. ${child.model}: ${child.text}`)
      .join('\n')
    assert.equal(verifyFanout(f).children.length, 7)
    for (const broken of ['missing', 'extra', 'reuse']) {
      const bad = structuredClone(f)
      if (broken === 'missing') bad.parent.text = bad.parent.text.split('\n').slice(1).join('\n')
      if (broken === 'extra') bad.parent.text += '\n8. opus: The README describes a tiny project.'
      if (broken === 'reuse')
        bad.parent.text = bad.parent.text.replace('3. opus:', '3. gpt-default:')
      assert.throws(() => verifyFanout(bad), /acceptance/)
    }
  })
  test(`acceptance ${path} requires seven correlated successful children including three Opus`, async () => {
    const { verifyFanout, FANOUT_PROMPT } = await load()
    const observed = fixture(path)
    for (const event of [...observed.events, ...observed.routerEvents, ...observed.parent.items])
      Object.assign(event, { prompt: 'fixture-prompt', authorization: 'fixture-auth' })
    const result = verifyFanout(observed)
    assert.equal(result.children.length, 7)
    assert.equal(result.receipts.length, 7)
    assert.equal(result.receipts.filter((r: any) => r.completion?.model === 'opus').length, 3)
    assert.equal(JSON.stringify(result.receipts).includes('fixture-prompt'), false)
    assert.equal(JSON.stringify(result.receipts).includes('fixture-auth'), false)
    assert.match(FANOUT_PROMPT, /7 sub-agents: 3 with model "opus"/)
    for (const broken of ['failed', 'foreign', 'model', 'parent', 'answer', 'count', 'owner']) {
      const f = fixture(path)
      assert.ok(f.children[0])
      assert.ok(f.events[0])
      if (broken === 'failed') f.children[0].status = 'failed'
      if (broken === 'foreign') f.events[0].parentThreadId = 'foreign'
      if (broken === 'model') f.children[0].model = 'sonnet'
      if (broken === 'parent') f.children[0].parentThreadId = 'foreign'
      if (broken === 'answer') f.parent.text = 'PONG'
      if (broken === 'count') f.children.pop()
      if (broken === 'owner') {
        f.events[0].owner = '/foreign.sock'
        if (path === 'bridge') f.events[0].pid = 999
      }
      assert.throws(() => verifyFanout(f), /acceptance/)
    }
  })
}
for (const mode of ['agent', 'model'])
  test(`same-thread switching accepts only actual ${mode} producer evidence`, async () => {
    const { switchWork } = await load()
    const debug: any[] = [
      { event: 'claim.listen', pid: 123, socketPath: '/fixed/root/run/claim-123.sock' },
      ...(mode === 'agent'
        ? [{ event: 'thread.rehomed', pid: 123, threadId: 'parent', from: 'gpt', to: 'claude' }]
        : []),
    ]
    const router: any[] =
      mode === 'model'
        ? [
            {
              event: 'trampoline.done',
              threadId: 'parent',
              turnId: 'turn-2',
              parentThreadId: null,
              parentTurnId: null,
              model: 'opus',
              owner: '/fixed/root/run/claim-123.sock',
              success: true,
              code: 0,
              sessionId: 'fake-owned-session',
            },
          ]
        : []
    let turns = 0,
      pty = 0
    const ctx = {
      root: '/fixed/root',
      check: 'switch',
      frozen: { mode },
      project: '/fixed',
      routerLog: 'router',
      owner: { pid: 123, processStart: 'owned-start' },
      events: (path?: string) => (path === 'router' ? router : debug),
      api: {
        successfulPong: (turn: any) => turn.status === 'completed' && turn.text === 'PONG',
        requirePtySession: () => {
          pty++
        },
      },
      client: {
        async request(_method: string, params: any) {
          assert.equal(params.threadId, 'parent')
          return {}
        },
        async turn(threadId: string) {
          assert.equal(threadId, 'parent')
          if (turns !== 1) {
            const requestId = `request-${turns + 1}`
            debug.push(
              {
                event: 'codex.mux.route',
                pid: 123,
                threadId,
                method: 'turn/start',
                id: requestId,
                route: 'upstream',
              },
              {
                event: 'codex.upstream.forward',
                pid: 123,
                method: 'turn/start',
                downId: requestId,
                upId: requestId,
              },
              {
                event: 'codex.upstream.response',
                pid: 123,
                method: 'turn/start',
                downId: requestId,
                upId: requestId,
                ok: true,
              },
            )
          }
          return { threadId, turnId: `turn-${++turns}`, status: 'completed', text: 'PONG' }
        },
        async terminal(
          threadId: string,
          _turnId: string,
          model: string,
          _cwd: string,
          _parent: undefined,
          persistent: boolean,
        ) {
          assert.equal(threadId, 'parent')
          assert.ok(['gpt-default', 'opus'].includes(model))
          assert.equal(persistent, true)
          return { success: true, status: 'completed' }
        },
      },
    }
    assert.equal((await switchWork(ctx, 'gpt-default', 'parent')).turns.length, 3)
    assert.equal(pty, mode === 'agent' ? 1 : 0)
    for (const defect of [
      'missing',
      'local',
      'foreign-thread',
      'foreign-owner',
      'failed-response',
      'wrong-response',
      'duplicate',
    ]) {
      const original = ctx.client.turn
      ctx.client.turn = async (threadId: string) => {
        const offset = debug.length
        const turn = await original(threadId)
        const rows = debug.slice(offset)
        if (rows.length) {
          if (defect === 'missing') debug.splice(offset)
          if (defect === 'local') rows[0].route = 'local'
          if (defect === 'foreign-thread') rows[0].threadId = 'foreign'
          if (defect === 'foreign-owner') for (const row of rows) row.pid = 999
          if (defect === 'failed-response') rows[2].ok = false
          if (defect === 'wrong-response') rows[2].upId = 'foreign'
          if (defect === 'duplicate') debug.push({ ...rows[0] })
        }
        return turn
      }
      turns = 0
      await assert.rejects(switchWork(ctx, 'gpt-default', 'parent'), /acceptance.*upstream/)
      ctx.client.turn = original
    }
    if (mode === 'agent')
      debug.splice(
        debug.findIndex((e) => e.event === 'thread.rehomed'),
        1,
      )
    else router[0].code = 1
    turns = 0
    await assert.rejects(switchWork(ctx, 'gpt-default', 'parent'), /acceptance/)
    if (mode === 'model') {
      router[0].code = 0
      for (const field of ['threadId', 'turnId', 'owner', 'model']) {
        const saved = router[0][field]
        router[0][field] = 'foreign'
        turns = 0
        await assert.rejects(switchWork(ctx, 'gpt-default', 'parent'), /acceptance/)
        router[0][field] = saved
      }
    }
  })
test('switch acceptance starts an owned persistent GPT thread rather than a title helper', async () => {
  const { checkWork } = await load()
  let params: any
  await assert.rejects(
    checkWork({
      check: 'switch',
      project: '/fixed',
      client: { request: async () => ({ data: [{ model: 'gpt-default', isDefault: true }] }) },
      threads: {
        start: async (value: any) => {
          params = value
          throw new Error('captured start')
        },
      },
    }),
    /captured start/,
  )
  assert.equal(params.model, 'gpt-default')
  assert.equal(params.ephemeral, false)
})
test('acceptance fixtures preserve occupied names and exact externally changed files', async () => {
  const { acceptanceFiles } = await load()
  const project = await tempDir('acceptance-files-')
  writeFileSync(join(project, 'main.txt'), 'existing')
  assert.throws(() => acceptanceFiles(project), /exist|occupied/)
  assert.equal(existsSync(join(project, 'README.md')), false)
  assert.equal(readFileSync(join(project, 'main.txt'), 'utf8'), 'existing')
  const fresh = await tempDir('acceptance-owned-')
  const cleanup = acceptanceFiles(fresh)
  writeFileSync(join(fresh, 'main.txt'), 'operator edit')
  assert.throws(cleanup, /changed/)
  assert.equal(readFileSync(join(fresh, 'main.txt'), 'utf8'), 'operator edit')
})
