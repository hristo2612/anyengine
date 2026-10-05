import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { runDoctor } from '../src/control-doctor.mjs'
import { applyOnFiles } from '../src/control-install.mjs'
import { classifyCodexProcesses, postflight } from '../src/control-postflight.mjs'
import { formatStatus, gatherStatus } from '../src/control-status.mjs'
import { type ProcessInfo, processOwnership } from '../src/control-system.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { CODE, ROUTER, scripted } from './helpers/flip-deps.mjs'
import { fakeLib, m0Home, pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
const START = '2026-10-01T00:00:00.000Z'
const OLD = '2026-09-30T00:00:00.000Z'
async function fixture() {
  const home = await m0Home()
  const system = fakeSystem(home)
  const f = scripted(system, { gate: true })
  const plan = fakeLib(home)
  const root = join(home, '.anyengine')
  applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
  const snapshot = f.deps.currentSnapshot()
  const input = {
    expect: 'router' as const,
    since: system.now(),
    appVersionBefore: system.version!,
    versionChangeExpected: false,
    libVersion: plan.version,
    routerUrl: ROUTER,
    baselineOther: [],
    frozen: { codeIdentity: CODE, key: snapshot.key, mode: snapshot.mode },
  }
  system.quitApp()
  system.openApp()
  return { ...f, system, root, input, plan }
}
function independent(lib: string, start: string, pid = 600): ProcessInfo[] {
  return [
    {
      pid,
      ppid: pid + 1,
      processStart: start,
      command: `node ${lib}/dist/src/adapter.mjs app-server`,
    },
    { pid: pid + 1, ppid: 1, processStart: OLD, command: 'node /service/web/launch.cjs' },
    {
      pid: pid + 2,
      ppid: pid,
      processStart: start,
      command: '/vendor/codex app-server -c openai_base_url="http://127.0.0.1:19000"',
    },
  ]
}
const check = (checks: Awaited<ReturnType<typeof postflight>>, name: string) => {
  const item = checks.find((c) => c.name === name)
  assert.ok(item, name)
  return item
}

for (const kind of ['older-client', 'concurrent-client', 'scheduled-smoke'])
  test(`App postflight preserves ${kind} without borrowing its debug or claim evidence`, async () => {
    const f = await fixture()
    const rows = independent(
      kind === 'older-client' ? '/other/.anyengine/lib/old' : f.plan.libDir,
      kind === 'older-client' ? OLD : f.system.now().toISOString(),
    )
    if (kind === 'scheduled-smoke')
      rows[1]!.command = `node ${f.plan.libDir}/dist/src/adapter.mjs smoke --paths native-fanout`
    f.system.procs.push(...rows)
    const pinged: number[] = []
    f.deps.claimPing = async (pid) => {
      pinged.push(pid)
      return true
    }
    const checks = await postflight(f.system, f.deps, f.input)
    assert.ok(
      checks.every((c) => c.ok),
      JSON.stringify(checks),
    )
    assert.deepEqual(pinged, [12830])
    assert.deepEqual(
      f.system.procs.filter((p) => rows.some((r) => r.pid === p.pid)),
      rows,
    )
  })

for (const origin of ['independent', 'stale', 'unattributed', 'app'] as const)
  test(`shim fallback evidence retains its ${origin} process ownership`, async () => {
    const f = await fixture()
    const ts = f.system.now().toISOString()
    f.system.procs.push(...independent(f.plan.libDir, ts))
    f.events.push({
      event: 'shim.nonBundledCodex',
      pid: origin === 'app' ? 12830 : origin === 'unattributed' ? 999 : 602,
      ts: origin === 'stale' ? new Date(Date.parse(ts) - 1000).toISOString() : ts,
    })
    const checks = await postflight(f.system, f.deps, f.input)
    assert.equal(check(checks, 'foreign codex').ok, origin === 'independent')
    assert.equal(check(checks, 'smoke').ok, origin === 'independent')
  })

test('independent adapters remain visible in status and do not fail App child or claim checks', async () => {
  const f = await fixture()
  f.system.procs = independent(f.plan.libDir, START)
  const report = await gatherStatus(f.system, f.root, { codexHome: join(f.system.home, '.codex') })
  assert.deepEqual(report.adapters, [])
  assert.match(formatStatus(report), /other adapter.*600/s)
  const checks = await runDoctor(f.system, f.root, { codexHome: join(f.system.home, '.codex') })
  for (const name of ['codex child', 'claim sockets'])
    assert.equal(checks.find((c) => c.name === name)?.level, 'ok', JSON.stringify(checks))
})

test('adapter processes are included in the foreign baseline inventory', async () => {
  const rows = independent('/other/.anyengine/lib/old', START)
  const system = fakeSystem('/controlled')
  assert.ok(
    classifyCodexProcesses(rows, system.app, processOwnership(system, rows)).some(
      (p) => p.kind === 'other' && p.path === '/other/.anyengine/lib/old/dist/src/adapter.mjs',
    ),
  )
})

test('vanilla ignores independent adapters and their router URL but retains App-owned old adapters', async () => {
  const f = await fixture()
  const ts = f.system.now().toISOString()
  f.system.procs = [
    { pid: 800, ppid: 1, processStart: ts, command: `${f.system.app}/Contents/MacOS/ChatGPT` },
    { pid: 900, ppid: 800, processStart: ts, command: `${f.deps.bundledCodex()} app-server` },
    ...independent(f.plan.libDir, ts),
  ]
  f.log.splice(
    0,
    f.log.length,
    `${ts} info stdio_transport_spawned executablePath=${f.deps.bundledCodex()} pid=900`,
    `${ts} info initialize_handshake_result outcome=success transportKind=stdio`,
  )
  f.events.length = 0
  f.system.jobs.clear()
  const input = { ...f.input, expect: 'vanilla' as const }
  let checks = await postflight(f.system, f.deps, input)
  assert.ok(
    checks.every((c) => c.ok),
    JSON.stringify(checks),
  )
  f.system.procs.push({
    pid: 700,
    ppid: 800,
    processStart: ts,
    command: `node ${f.plan.libDir}/dist/src/adapter.mjs app-server`,
  })
  checks = await postflight(f.system, f.deps, { ...input, since: new Date(Date.parse(ts) + 1000) })
  assert.equal(check(checks, 'adapter process').ok, false)
})

for (const failure of [
  'missing-parent',
  'orphan',
  'newer-parent',
  'cycle',
  'duplicate-pid',
  'invalid-start',
  'app-path-impostor',
])
  test(`ambiguous ${failure} adapter ownership cannot certify App postflight`, async () => {
    const f = await fixture()
    const adapter = f.system.procs.find((p) => p.pid === 12830)!
    const parent = f.system.procs.find((p) => p.pid === 800)!
    if (failure === 'missing-parent') adapter.ppid = 777
    if (failure === 'orphan') adapter.ppid = 1
    if (failure === 'newer-parent')
      parent.processStart = new Date(Date.parse(adapter.processStart) + 1000).toISOString()
    if (failure === 'cycle') parent.ppid = adapter.pid
    if (failure === 'duplicate-pid')
      f.system.procs.push({ ...parent, command: 'node /service/web/launch.cjs' })
    if (failure === 'invalid-start') parent.processStart = 'invalid'
    if (failure === 'app-path-impostor')
      parent.command = `${f.system.app}/Contents/MacOS/ChatGPT-impostor`
    const checks = await postflight(f.system, f.deps, f.input)
    assert.equal(check(checks, 'adapter process').ok, false, JSON.stringify(checks))
    assert.equal(check(checks, 'smoke').ok, false)
  })

for (const failure of ['wrong-lib', 'missing-child', 'bad-claim', 'bad-link', 'wrong-url'])
  test(`independent client cannot conceal App ${failure}`, async () => {
    const f = await fixture()
    f.system.procs.push(...independent(f.plan.libDir, f.system.now().toISOString()))
    const adapter = f.system.procs.find((p) => p.pid === 12830)!
    if (failure === 'wrong-lib')
      adapter.command = 'node /other/.anyengine/lib/old/dist/src/adapter.mjs app-server'
    if (failure === 'missing-child') f.system.procs = f.system.procs.filter((p) => p.pid !== 12930)
    if (failure === 'bad-claim') f.deps.claimPing = async (pid) => pid !== 12830
    if (failure === 'bad-link')
      for (const e of f.events) if (e.event === 'router.link') e.attached = false
    if (failure === 'wrong-url')
      for (const e of f.events)
        if (e.event === 'codex.upstream.spawn')
          e.args = ['app-server', '-c', 'openai_base_url="http://127.0.0.1:19000"']
    const checks = await postflight(f.system, f.deps, f.input)
    assert.equal(check(checks, 'smoke').ok, false)
    const name = {
      'wrong-lib': 'adapter process',
      'missing-child': 'GPT child',
      'bad-claim': 'claim socket',
      'bad-link': 'router attached',
      'wrong-url': 'router attached',
    }[failure]!
    assert.equal(check(checks, name).ok, false, JSON.stringify(checks))
  })

test('ownership inspection failure blocks doctor without probing unknown claim sockets', async () => {
  const f = await fixture()
  f.system.procs = [
    {
      pid: 600,
      ppid: 777,
      processStart: START,
      command: `node ${f.plan.libDir}/dist/src/adapter.mjs app-server`,
    },
  ]
  const report = await gatherStatus(f.system, f.root, { codexHome: join(f.system.home, '.codex') })
  assert.ok(report.inspectionErrors.some((e) => /ownership/.test(e)))
  const checks = await runDoctor(f.system, f.root, { codexHome: join(f.system.home, '.codex') })
  assert.equal(checks.find((c) => c.name === 'claim sockets')?.level, 'fail')
})

test('a foreign child predating its independent adapter parent is not exempted by a reused PPID', async () => {
  const f = await fixture()
  const rows = independent(f.plan.libDir, f.system.now().toISOString())
  rows[2]!.processStart = OLD
  f.system.procs.push(...rows)
  const checks = await postflight(f.system, f.deps, {
    ...f.input,
    baselineOther: [join(f.plan.libDir, 'dist/src/adapter.mjs')],
  })
  assert.equal(check(checks, 'foreign codex').ok, false, JSON.stringify(checks))
})

test('an independent successful transport cannot supply the configured App handshake', async () => {
  const f = await fixture()
  const ts = f.system.now().toISOString()
  f.system.procs.push(...independent(f.plan.libDir, ts))
  f.log.splice(
    0,
    f.log.length,
    `${ts} info stdio_transport_spawned executablePath=~/bin/codex pid=600`,
    `${ts} info initialize_handshake_result outcome=success transportKind=stdio`,
  )
  const checks = await postflight(f.system, f.deps, f.input)
  assert.equal(check(checks, 'handshake').ok, false)
})

test('a real census includes launchd PID 1 with parent 0 without losing App ownership', async () => {
  const f = await fixture()
  f.system.procs.push({ pid: 1, ppid: 0, processStart: OLD, command: '/sbin/launchd' })
  const checks = await postflight(f.system, f.deps, f.input)
  assert.ok(
    checks.every((c) => c.ok),
    JSON.stringify(checks),
  )
})

test('status does not borrow a child whose parent PID was reused after the child started', async () => {
  const f = await fixture()
  f.system.procs.find((p) => p.pid === 12930)!.processStart = OLD
  const spawn = f.events.find((e) => e.event === 'codex.upstream.spawn')!
  writeFileSync(process.env.ANYENGINE_DEBUG_LOG!, JSON.stringify(spawn))
  const report = await gatherStatus(f.system, f.root, { codexHome: join(f.system.home, '.codex') })
  assert.equal(report.adapters[0]?.codexChild, 'unknown')
})

test('an unquoted orphan App helper with spaces does not become an independent launcher', async () => {
  const f = await fixture()
  const app = '/Applications/Chat GPT.app'
  const rows = independent(f.plan.libDir, START)
  rows[1]!.command = `${app}/Contents/Helpers/worker --flag`
  f.system.procs = rows
  const system = { ...f.system, app, appExecutable: () => `${app}/Contents/MacOS/Chat GPT` }
  const report = await gatherStatus(system, f.root, { codexHome: join(system.home, '.codex') })
  assert.equal(report.adapters[0]?.pid, 600)
  assert.deepEqual(report.otherAdapters, [])
  assert.ok(report.inspectionErrors.some((error) => /ownership/.test(error)))
})
