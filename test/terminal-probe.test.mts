import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { realSystem } from '../src/control-system.mjs'
import { joinDetachedGroup } from '../src/smoke-client.mjs'
import { joinedGroups, observedFamily } from '../src/smoke-probes.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

const groupLife = { pid: 123, processStart: '2000-01-01T00:00:00.000Z' }

for (const mode of ['transient', 'persistent', 'escalation'] as const)
  test(`owned group retries ${mode} EPERM without treating it as absence or signalling it`, async (t) => {
    let observations = 0
    let signals = 0
    const ctx: any = {
      cohort: [groupLife],
      system: {
        processes: () => (mode === 'escalation' && observations <= 101 ? [groupLife] : []),
        exec: () => ({ status: 0, stdout: '123' }),
      },
    }
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      assert.equal(pid, -123)
      if (signal !== 0) {
        signals++
        return true
      }
      observations++
      if (observations > 250) throw new Error('observation budget exceeded')
      if (
        mode === 'persistent' ||
        (mode === 'transient' && observations === 1) ||
        (mode === 'escalation' && observations === 101)
      )
        throw Object.assign(new Error('controlled unknown group'), { code: 'EPERM' })
      if (mode === 'escalation' && observations <= 100) return true
      throw Object.assign(new Error('controlled absent group'), { code: 'ESRCH' })
    })
    if (mode === 'persistent')
      await assert.rejects(joinedGroups(ctx, new Map([[123, groupLife]])), /not joined/)
    else await joinedGroups(ctx, new Map([[123, groupLife]]))
    assert.ok(observations > 1)
    assert.equal(signals, 0, 'an unknown signal-zero observation cannot authorize SIGKILL')
  })

for (const processStart of [groupLife.processStart, '2001-01-01T00:00:00.000Z'])
  test(`group absence cannot hide a live or reused cohort PID: ${processStart}`, async (t) => {
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      assert.equal(pid, -123)
      assert.equal(signal, 0)
      throw Object.assign(new Error('controlled absent group'), { code: 'ESRCH' })
    })
    const ctx: any = {
      cohort: [groupLife],
      system: { processes: () => [{ ...groupLife, processStart }] },
    }
    await assert.rejects(joinedGroups(ctx, new Map([[123, groupLife]])), /cohort remains alive/)
  })

test('group absence cannot certify an unavailable cohort census', async (t) => {
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('controlled absent group'), { code: 'ESRCH' })
  })
  const ctx: any = {
    cohort: [groupLife],
    system: {
      processes: () => {
        throw new Error('controlled census unavailable')
      },
    },
  }
  await assert.rejects(joinedGroups(ctx, new Map([[123, groupLife]])), /census unavailable/)
})

test('unexpected group observation errors still refuse cleanup', async (t) => {
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('controlled invalid observation'), { code: 'EINVAL' })
  })
  await assert.rejects(
    joinedGroups({ cohort: [], system: {} } as any, new Map([[123, groupLife]])),
    /invalid observation/,
  )
})

test('owned family uses one identity/group census when a short child exits before later queries', () => {
  const root = { pid: 123, ppid: 1, processStart: 'root-start', processGroup: 123 }
  const child = { pid: 124, ppid: 123, processStart: 'child-start', processGroup: 123 }
  const cohort: any[] = []
  let censuses = 0
  const ctx: any = {
    cohort,
    system: {
      processes: () => {
        censuses++
        return [root, child]
      },
      exec: () => {
        throw new Error('short child already exited; later group queries are not the census')
      },
    },
    run: { pending: (value: any[]) => assert.deepEqual(value, cohort) },
  }
  assert.deepEqual([...observedFamily(ctx, root.pid)], [[root.pid, root]])
  assert.equal(censuses, 1)
  assert.deepEqual(cohort, [
    { pid: root.pid, processStart: root.processStart },
    { pid: child.pid, processStart: child.processStart },
  ])
  for (const processGroup of [0, -1, NaN, 999, null, 9007199254740992]) {
    ctx.system.processes = () => [root, { ...child, processGroup }]
    assert.throws(() => observedFamily(ctx, root.pid), /group identity unknown/)
  }
  ctx.system.processes = () => [{ pid: root.pid, ppid: 1, processStart: root.processStart }]
  ctx.system.exec = () => ({ status: 0, stdout: String(root.pid) })
  assert.equal(observedFamily(ctx, root.pid).size, 1)
  ctx.system.exec = () => ({ status: 1, stdout: '' })
  assert.throws(() => observedFamily(ctx, root.pid), /group identity unknown/)
})

test('short fake terminal execution uses the real family census and closes its exact owned group', async () => {
  const { execProbe } = await load()
  const { probeProcesses } = await import('../../scripts/lib/' + 'probe-processes.mjs')
  const home = await tempDir('terminal-family-')
  const system = realSystem({ ...process.env, ANYENGINE_PS: '/bin/ps' })
  const lifetime = probeProcesses({ observedFamily, joinedGroups }, system, home)
  try {
    const result = await execProbe(
      process.execPath,
      [resolve('test/fixtures/terminal-exec.mjs'), 'success'],
      { ...process.env, HOME: home },
      joinDetachedGroup,
      30_000,
      lifetime,
    )
    assert.equal(result.status, 0)
    assert.equal(result.completed, true)
  } finally {
    await lifetime.close()
  }
  const cleanup = JSON.parse(readFileSync(join(home, 'process-cleanup.json'), 'utf8'))
  assert.equal(cleanup.status, 'joined')
  assert.ok(cleanup.cohort.length)
  assert.equal(
    cleanup.cohort.some((p: any) => system.processes().some((live) => live.pid === p.pid)),
    false,
  )
})

test('installed current-pointer probe entry points execute through the immutable library symlink', async () => {
  const work = await tempDir('probe-entry-')
  const libs = join(work, 'lib')
  mkdirSync(libs)
  symlinkSync(resolve('.'), join(libs, 'current'))
  for (const name of ['probe-terminal-codex', 'probe-acceptance']) {
    const script = join(libs, 'current', 'scripts', `${name}.mjs`)
    const result = spawnSync(process.execPath, [script, '--unknown'], {
      env: process.env,
      timeout: 15_000,
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr.toString(), /usage:|Unknown option/)
  }
})

const load = () => import('../../scripts/' + 'probe-terminal-codex.mjs')
test('terminal version differential requires two actual distinct reported client versions', async () => {
  const { versionPair } = await load()
  const selected = { status: 0, stdout: 'codex-cli 0.200.0\n' }
  assert.deepEqual(versionPair(selected, { status: 0, stdout: 'codex-cli 0.199.0-alpha.1\n' }), {
    selected: '0.200.0',
    old: '0.199.0-alpha.1',
  })
  assert.equal(versionPair(selected).old, null)
  assert.throws(() => versionPair(selected, selected), /P2d refused/)
  for (const broken of [
    { status: 1, stdout: selected.stdout },
    { status: 0, stdout: 'unavailable' },
  ])
    assert.throws(() => versionPair(selected, broken), /unavailable/)
})
test('terminal differential refuses failed terminal outcomes even with expected wire model', async () => {
  const { verifyExec } = await load()
  assert.deepEqual(
    verifyExec(
      { status: 0, completed: true, model: 'gpt-6.1-sol' },
      ['gpt-6.1-sol'],
      'gpt-6.1-sol',
    ),
    'gpt-6.1-sol',
  )
  for (const value of [
    { status: 1, completed: true, model: 'gpt-6.1-sol' },
    { status: 0, completed: false, model: 'gpt-6.1-sol' },
    { status: 0, completed: true, model: 'opus' },
  ])
    assert.throws(() => verifyExec(value, ['gpt-6.1-sol'], 'gpt-6.1-sol'), /terminal/)
  assert.throws(
    () =>
      verifyExec(
        { status: 0, completed: true, model: 'gpt-6.1-sol' },
        ['gpt-6.1-sol', 'gpt-6.1-sol'],
        'gpt-6.1-sol',
      ),
    /terminal/,
  )
})
test('loopback terminal fixtures observe actual models, compressed requests and refused paths', async () => {
  const { terminalBackend } = await load()
  const backend = await terminalBackend()
  const discovery = await terminalBackend(true)
  try {
    const catalog = (await (await fetch(`${backend.url}/models`)).json()) as any
    assert.deepEqual(
      catalog.models.map((m: any) => m.slug),
      ['gpt-6.1-sol'],
    )
    const response = await fetch(`${backend.url}/responses`, {
      method: 'POST',
      headers: { 'content-encoding': 'zstd', authorization: 'fake-test' },
      body: zstdCompressSync(Buffer.from('{"model":"gpt-6.1-sol"}')),
    })
    assert.match(await response.text(), /response.completed/)
    assert.equal(backend.requests.at(-1).model, 'gpt-6.1-sol')
    assert.equal(
      (await fetch(`${backend.url}/responses`, { method: 'POST', body: 'invalid' })).status,
      400,
    )
    assert.equal((await fetch(`${backend.url}/unexpected`)).status, 404)
    assert.equal((await fetch(`${discovery.url}wham/accounts/check`)).status, 200)
    assert.equal(JSON.stringify(backend.requests).includes('fake-test'), false)
  } finally {
    await Promise.all([backend.close(), discovery.close()])
  }
})
test('terminal exec waits for actual status and joins family on success, assertion, timeout and startup failure', async () => {
  const { execProbe } = await load()
  const home = await tempDir('terminal-exec-')
  for (const order of ['success', 'failed', 'malformed', 'family', 'timeout', 'startup']) {
    let ownedPid: number | undefined
    const joiner = async (pid: number, kill: boolean) => {
      ownedPid = pid
      await joinDetachedGroup(pid, kill)
    }
    const promise = execProbe(
      order === 'startup' ? join(home, 'absent') : process.execPath,
      [resolve('test/fixtures/terminal-exec.mjs'), order],
      { ...process.env, HOME: home },
      joiner,
      500,
    )
    if (['malformed', 'timeout', 'startup'].includes(order))
      await assert.rejects(promise, /JSON|Unexpected|deadline|ENOENT/)
    else {
      const value = await promise
      assert.equal(value.status, order === 'failed' ? 2 : 0)
      assert.equal(value.completed, true)
    }
    if (ownedPid) {
      const gone = ownedPid
      assert.throws(() => process.kill(-gone, 0), { code: 'ESRCH' })
    }
  }
  let pid: number | undefined
  await assert.rejects(
    execProbe(
      process.execPath,
      [resolve('test/fixtures/terminal-exec.mjs'), 'timeout'],
      { ...process.env, HOME: home },
      async (value: number, kill: boolean) => {
        pid = value
        await joinDetachedGroup(value, kill)
      },
      500,
      {
        pending() {},
        add() {
          throw new Error('startup assertion')
        },
      },
    ),
    /startup assertion/,
  )
  assert.ok(pid)
  const gone = pid
  assert.throws(() => process.kill(-gone, 0), { code: 'ESRCH' })
})
test('private cohort adapter preserves unknown process identity and joins accepted helpers', async () => {
  const { probeProcesses } = await import('../../scripts/lib/' + 'probe-processes.mjs')
  const work = await tempDir('probe-processes-')
  let live = [{ pid: 123, processStart: 'fake-first' }]
  const seen: string[] = []
  const lifetime = probeProcesses(
    {
      observedFamily(ctx: any, pid: number) {
        assert.equal(
          readFileSync(join(work, 'process-cleanup.json'), 'utf8').includes('pending'),
          true,
        )
        ctx.cohort.push(live[0])
        return new Map([[pid, live[0]]])
      },
      async joinedGroups(ctx: any) {
        seen.push(ctx.cohort[0].processStart)
      },
    },
    { processes: () => live },
    work,
  )
  lifetime.pending()
  lifetime.add(123)
  live = [{ pid: 123, processStart: 'fake-reused' }]
  lifetime.sample()
  await assert.rejects(lifetime.close(), /identity reused/)
  assert.deepEqual(seen, ['fake-first'])
  assert.equal(
    JSON.parse(readFileSync(join(work, 'process-cleanup.json'), 'utf8')).status,
    'unknown',
  )
})
test('terminal differential reports skipped old binary and unexercised copied caches', async () => {
  const { differential } = await load()
  const requests: string[] = []
  const fake = {
    cache: Buffer.from(
      JSON.stringify({
        client_version: 'fake',
        models: ['opus', 'sonnet', 'haiku'].map((slug) => ({ slug })),
      }),
    ),
    identity: () => ({ client_version: 'fake' }),
    async list(label: string) {
      requests.push(label)
      return label === 'write' ? ['gpt-6.1-sol', 'opus', 'sonnet', 'haiku'] : ['gpt-6.1-sol']
    },
    async exec(label: string) {
      requests.push(label)
      return { status: 0, completed: true, model: 'gpt-6.1-sol', models: ['gpt-6.1-sol'] }
    },
    modelsFetched: () => true,
  }
  const result = await differential(fake, {
    oldCodex: null,
    cache: Buffer.from('{"models":[{"slug":"gpt-6.1-sol"}]}'),
  })
  assert.equal(result.exitCode, 2)
  assert.equal(result.lines.find((r: any) => r.name === 'P2d').status, 'skipped')
  assert.equal(result.lines.find((r: any) => r.name === 'P2c').status, 'not exercised')
  assert.equal(result.lines.find((r: any) => r.name === 'P4a').status, 'not exercised')
  assert.ok(requests.includes('M7'))
})
