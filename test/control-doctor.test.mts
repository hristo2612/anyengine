import assert from 'node:assert/strict'
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { enginePaths, setConfigValue } from '../src/anyengine-config.mjs'
import { runControl } from '../src/control-cli.mjs'
import { DOCTOR_CHECKS, runDoctor } from '../src/control-doctor.mjs'
import { writeFlipMarker } from '../src/control-marker.mjs'
import { gatherStatus } from '../src/control-status.mjs'
import { realSystem } from '../src/control-system.mjs'
import { markProven, proofKey } from '../src/degraded.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const START = '2026-10-01T00:00:00.000Z'
async function setup() {
  const home = await tempDir('doctor-')
  const root = join(home, '.anyengine')
  const codex = join(home, '.codex')
  mkdirSync(enginePaths(root).state, { recursive: true })
  mkdirSync(codex)
  const system = fakeSystem(home)
  const lib = join(root, 'lib/v1')
  // The fake System intercepts execution, but admission inspects the real packaged cohort.
  for (const entry of [
    'scripts',
    'dist/src',
    'test/fixtures/claude-permission-modes.json',
    'test/fixtures/posture-schema.json',
    'crates/anyengine-protocol/fixtures',
  ]) {
    mkdirSync(join(lib, entry, '..'), { recursive: true })
    cpSync(resolve(entry), join(lib, entry), { recursive: true })
  }
  symlinkSync('v1', join(root, 'lib/current'))
  const binary = join(system.app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  mkdirSync(join(binary, '..'), { recursive: true })
  writeFileSync(binary, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  system.execs.set(`${process.execPath} ${join(lib, 'scripts/doctor.mjs')} --json --schemas`, {
    status: 0,
    stdout: JSON.stringify({
      checks: [{ name: 'fixture', ok: true }],
      codex: { path: binary, version: '0.159.0' },
    }),
    stderr: '',
  })
  return { home, root, codex, system, lib, binary }
}
const check = (checks: Awaited<ReturnType<typeof runDoctor>>, name: string) => {
  const found = checks.find((item) => item.name === name)
  assert.ok(found, name)
  return found
}

for (const outcome of ['ended', 'unhealthy', 'unknown', 'new-unhealthy']) {
  test(`doctor observes the runtime after the installed probe: ${outcome}`, async () => {
    const f = await setup()
    const app = {
      pid: 800,
      ppid: 1,
      processStart: START,
      command: `${f.system.app}/Contents/MacOS/ChatGPT`,
    }
    const adapter = {
      pid: 99,
      ppid: 800,
      processStart: START,
      command: `node ${f.lib}/dist/src/adapter.mjs app-server`,
    }
    f.system.procs = outcome === 'new-unhealthy' ? [app] : [app, adapter]
    const exec = f.system.exec.bind(f.system)
    f.system.exec = (command, args, options) => {
      const result = exec(command, args, options)
      if (args[0] === join(f.lib, 'scripts/doctor.mjs')) {
        if (outcome === 'ended') f.system.procs = [app]
        if (outcome === 'new-unhealthy') f.system.procs = [app, adapter]
        if (outcome === 'unknown') f.system.processError = new Error('current census unavailable')
      }
      return result
    }
    const report = await runDoctor(f.system, f.root, { codexHome: f.codex })
    assert.equal(check(report, 'codex child').level, outcome === 'ended' ? 'ok' : 'fail')
    if (outcome === 'ended') assert.equal(check(report, 'claim sockets').level, 'ok')
  })
}

test('status captures its process cohort after asynchronous router health returns', async (t) => {
  const f = await setup()
  const app = {
    pid: 800,
    ppid: 1,
    processStart: START,
    command: `${f.system.app}/Contents/MacOS/ChatGPT`,
  }
  const router = {
    pid: 42,
    ppid: 1,
    processStart: START,
    command: `node ${f.lib}/dist/src/adapter.mjs router`,
  }
  f.system.procs = [
    app,
    router,
    {
      pid: 99,
      ppid: 800,
      processStart: START,
      command: `node ${f.lib}/dist/src/adapter.mjs app-server`,
    },
  ]
  const server = http.createServer((_req, res) => {
    f.system.procs = [app, router]
    res.end(
      JSON.stringify({
        ok: true,
        pid: 42,
        version: 'v1',
        startedAt: START,
        mode: 'agent',
        fanout: { path: 'bridge', reason: 'unproven' },
        faults: { hookErrors: 0, unhandledRejections: 0 },
        upstream: {},
        inflight: {},
      }),
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>((done) => server.close(() => done())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  setConfigValue(f.root, 'router.port', String(address.port))
  f.system.jobs.set('dev.anyengine.router', { plist: 'fixture', pid: 42 })
  assert.deepEqual((await gatherStatus(f.system, f.root, { codexHome: f.codex })).adapters, [])
})

test('doctor refuses current version evidence if lib/current changes during its probe', async () => {
  const f = await setup()
  mkdirSync(join(f.root, 'lib/legacy'))
  const fixtureExec = f.system.exec.bind(f.system)
  f.system.exec = (command, args, options) => {
    const result = fixtureExec(command, args, options)
    if (args[0] === join(f.lib, 'scripts/doctor.mjs')) {
      unlinkSync(join(f.root, 'lib/current'))
      symlinkSync('legacy', join(f.root, 'lib/current'))
    }
    return result
  }
  const report = await runDoctor(f.system, f.root, { codexHome: f.codex })
  assert.equal(report.length, 20)
  assert.equal(report[0]?.level, 'fail')
  assert.match(report[0]?.detail ?? '', /lib\/current changed/)
  assert.match(check(report, 'fan-out path').detail, /"codexVersion":null/)
})

test('doctor production command reports all 20 ordered checks and failures affect exit', async () => {
  const f = await setup()
  assert.equal(DOCTOR_CHECKS.length, 20)
  assert.deepEqual(
    (await runDoctor(f.system, f.root, { codexHome: f.codex })).map((c) => c.name),
    [...DOCTOR_CHECKS],
  )
  f.system.processError = new Error('ps failed')
  let out = ''
  assert.equal(
    await runControl(['doctor'], f.system, f.root, (value) => {
      out += value
    }),
    1,
  )
  for (const name of DOCTOR_CHECKS) assert.ok(out.includes(name))
  assert.match(out, /ps failed/)
})

test('doctor shared models and router URL warn, preserve bytes, and profiles stay operator-owned', async () => {
  const f = await setup()
  const path = join(f.codex, 'config.toml')
  const text =
    '"model"="sonnet"\r\nopenai_base_url="http://127.0.0.1:18790/backend-api/codex"\r\n[profiles.work]\r\nreview_model="opus"\r\n'
  writeFileSync(path, text)
  const before = readdirSync(f.codex)
  const checks = await runDoctor(f.system, f.root, { codexHome: f.codex })
  assert.equal(check(checks, 'shared config model').level, 'warn')
  assert.match(
    check(checks, 'shared config model').detail,
    /sonnet.*line 1.*terminal codex with no -m/s,
  )
  assert.match(check(checks, 'shared config model').detail, /profile.*yours to edit/s)
  assert.equal(check(checks, 'terminal codex and the router').level, 'warn')
  assert.equal(readFileSync(path, 'utf8'), text)
  assert.deepEqual(readdirSync(f.codex), before)
  writeFileSync(path, 'model="gpt-6-astra"\n')
  assert.equal(
    check(await runDoctor(f.system, f.root, { codexHome: f.codex }), 'shared config model').level,
    'ok',
  )
})

test('doctor uses captured process start and durable recovery for interrupted/running flips', async () => {
  const f = await setup()
  const marker = {
    id: 'f',
    op: 'on' as const,
    args: [],
    pid: 4321,
    processStart: START,
    runner: 'detached' as const,
    phase: 'quit-app',
    startedAt: START,
    updatedAt: START,
    log: join(f.root, 'state/flip-f.log'),
    state: {},
  }
  writeFlipMarker(f.root, marker)
  writeFileSync(join(f.root, 'RECOVER.txt'), "'/private/control with spaces/recover' --resume f\n")
  let checks = await runDoctor(f.system, f.root, { codexHome: f.codex })
  assert.equal(check(checks, 'flip').level, 'fail')
  assert.match(check(checks, 'flip').detail, /interrupted at quit-app.*control with spaces/s)
  assert.doesNotMatch(check(checks, 'flip').detail, /run anyengine (on|off)/)
  f.system.procs = [
    {
      pid: 4321,
      ppid: 1,
      command: `node ${f.lib}/dist/src/adapter.mjs flip-run f on`,
      processStart: START,
    },
  ]
  checks = await runDoctor(f.system, f.root, { codexHome: f.codex })
  assert.equal(check(checks, 'flip').level, 'warn', JSON.stringify(checks))
  assert.ok(f.system.procs[0])
  f.system.procs[0].processStart = '2026-10-02T00:00:00.000Z'
  assert.equal(
    check(await runDoctor(f.system, f.root, { codexHome: f.codex }), 'flip').level,
    'fail',
  )
})

for (const file of [
  'flip.json',
  'layers.json',
  'known-good.json',
  'proven.json',
  'degraded.json',
  'smoke.json',
]) {
  test(`doctor retains and diagnoses invalid ${file} rather than an empty/healthy state`, async () => {
    const f = await setup()
    const path = join(f.root, 'state', file)
    const bytes = Buffer.from('{"paths":{"native-fanout":{"detail":"X"}}}')
    bytes[bytes.indexOf('X')] = 0xff
    writeFileSync(path, bytes)
    const checks = await runDoctor(f.system, f.root, { codexHome: f.codex })
    assert.ok(
      checks.some((item) => item.level === 'fail' && item.detail.includes(file)),
      JSON.stringify(checks),
    )
    assert.ok(readFileSync(path).equals(bytes))
    assert.notEqual(check(checks, 'fan-out path').detail.startsWith('native proven'), true)
  })
}

test('doctor each failed real System producer stays failed and does not crash aggregation', async () => {
  const f = await setup()
  const system = realSystem({ HOME: f.home, ANYENGINE_CHATGPT_APP: f.system.app }, (command) => ({
    status: command.endsWith('pgrep') ? 2 : null,
    stdout: '',
    stderr: 'fixture tool refused',
  }))
  const checks = await runDoctor(system, f.root, { codexHome: f.codex })
  assert.equal(checks.length, 20)
  for (const name of [
    'adapter checks (scripts/doctor.mjs)',
    'adapters run the current lib',
    'codex child',
    'claim sockets',
    'router job',
    'app update',
  ])
    assert.equal(check(checks, name).level, 'fail', name)
  assert.ok(checks.some((item) => /app running|app version/.test(item.detail)))
})

test('doctor malformed or invalid-UTF8 TOML and app-pick are failures, not no model', async () => {
  const f = await setup()
  for (const content of ['model="sonnet"\nmodel="opus"\n', Buffer.from([0xff])]) {
    writeFileSync(join(f.codex, 'config.toml'), content)
    assert.equal(
      check(await runDoctor(f.system, f.root, { codexHome: f.codex }), 'shared config model').level,
      'fail',
    )
  }
  writeFileSync(join(f.codex, 'config.toml'), 'model="gpt-6-astra"\n')
  mkdirSync(join(f.codex, 'anyengine'))
  writeFileSync(join(f.codex, 'anyengine/app-model-pick.json'), '{')
  assert.equal(
    check(await runDoctor(f.system, f.root, { codexHome: f.codex }), 'shared config model').level,
    'fail',
  )
})

test('doctor missing, refusing and mismatched claim sockets cannot be successful inspection', async (t) => {
  const f = await setup()
  f.system.procs = [
    {
      pid: process.pid,
      ppid: 800,
      processStart: START,
      command: `node ${f.lib}/dist/src/adapter.mjs app-server`,
    },
    { pid: 800, ppid: 1, processStart: START, command: `${f.system.app}/Contents/MacOS/ChatGPT` },
  ]
  assert.equal(
    check(await runDoctor(f.system, f.root, { codexHome: f.codex }), 'claim sockets').level,
    'warn',
  )
  const socketDir = await tempDir('ds-')
  symlinkSync(socketDir, enginePaths(f.root).run)
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('data', () => socket.end('{"type":"pong","pid":99999,"threads":0}\n'))
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((done) =>
    server.listen(join(socketDir, `claim-${process.pid}.sock`), done),
  )
  t.after(
    () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => done())
      }),
  )
  assert.equal(
    check(await runDoctor(f.system, f.root, { codexHome: f.codex }), 'claim sockets').level,
    'fail',
  )
})

test('doctor current native requires independently probed version, matching current lib and proof', async (t) => {
  const f = await setup()
  const health: Record<string, unknown> = {}
  const server = http.createServer((_req, res) => res.end(JSON.stringify(health)))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>((done) => server.close(() => done())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  setConfigValue(f.root, 'router.port', String(address.port))
  f.system.jobs.set('dev.anyengine.router', { plist: 'fixture', pid: 42 })
  f.system.procs = [
    { pid: 42, ppid: 1, command: `node ${f.lib}/dist/src/adapter.mjs router`, processStart: START },
  ]
  const key = proofKey(f.root, {
    lib: () => 'v1',
    appVersion: () => f.system.version,
    codexVersion: () => '0.159.0',
  })
  markProven(f.root, 'native-fanout', 'correlated fake pass', key)
  Object.assign(health, {
    ok: true,
    pid: 42,
    version: 'v1',
    startedAt: START,
    mode: 'agent',
    proofKey: key,
    fanout: { path: 'native', reason: 'proven' },
    faults: { hookErrors: 0, unhandledRejections: 0 },
    upstream: {},
    inflight: {},
  })
  let checks = await runDoctor(f.system, f.root, { codexHome: f.codex })
  assert.equal(check(checks, 'fan-out path').level, 'ok', JSON.stringify(checks))
  assert.match(check(checks, 'fan-out path').detail, /native proven.*correlated fake pass/s)
  health.proofKey = { ...key, codexVersion: 'changed' }
  checks = await runDoctor(f.system, f.root, { codexHome: f.codex })
  assert.equal(check(checks, 'fan-out path').level, 'fail')
})

test('doctor identifies stale router process start and cannot call historical native current', async (t) => {
  const f = await setup()
  const health: Record<string, unknown> = {}
  const server = http.createServer((_req, res) => res.end(JSON.stringify(health)))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>((done) => server.close(() => done())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  setConfigValue(f.root, 'router.port', String(address.port))
  f.system.jobs.set('dev.anyengine.router', { plist: 'fixture', pid: 42 })
  f.system.procs = [
    {
      pid: 42,
      ppid: 1,
      command: `node ${f.lib}/dist/src/adapter.mjs router`,
      processStart: '2026-10-02T00:00:00.000Z',
    },
  ]
  const key = proofKey(f.root, {
    lib: () => 'v1',
    appVersion: () => f.system.version,
    codexVersion: () => '0.159.0',
  })
  markProven(f.root, 'native-fanout', 'old pass', key)
  Object.assign(health, {
    ok: true,
    pid: 42,
    version: 'v1',
    startedAt: START,
    mode: 'agent',
    proofKey: key,
    fanout: { path: 'native', reason: 'proven' },
    faults: { hookErrors: 0, unhandledRejections: 0 },
    upstream: {},
    inflight: {},
  })
  assert.equal(
    check(await runDoctor(f.system, f.root, { codexHome: f.codex }), 'fan-out path').level,
    'fail',
  )
  health.fanout = { path: 'bridge', reason: 'unproven' }
  assert.equal(
    check(await runDoctor(f.system, f.root, { codexHome: f.codex }), 'router health').level,
    'fail',
  )
})

test('doctor rejects invalid or historical router link timestamps', async (t) => {
  const f = await setup()
  writeFileSync(enginePaths(f.root).layers, JSON.stringify(layer(f.root)))
  f.system.procs = [
    {
      pid: 42,
      ppid: 800,
      processStart: START,
      command: `node ${f.lib}/dist/src/adapter.mjs app-server`,
    },
    { pid: 800, ppid: 1, processStart: START, command: `${f.system.app}/Contents/MacOS/ChatGPT` },
  ]
  mkdirSync(join(f.codex, 'anyengine'))
  const previous = process.env.ANYENGINE_DEBUG_LOG
  process.env.ANYENGINE_DEBUG_LOG = join(f.codex, 'anyengine/debug.jsonl')
  t.after(() => {
    if (previous === undefined) delete process.env.ANYENGINE_DEBUG_LOG
    else process.env.ANYENGINE_DEBUG_LOG = previous
  })
  for (const checkedAt of ['invalid', '2026-09-01T00:00:00.000Z']) {
    writeFileSync(
      join(f.codex, 'anyengine/debug.jsonl'),
      JSON.stringify({ ts: START, pid: 42, event: 'router.link', attached: true, checkedAt }) +
        '\n',
    )
    assert.equal(
      check(await runDoctor(f.system, f.root, { codexHome: f.codex }), 'router attached').level,
      'warn',
    )
  }
})

test('doctor distinguishes staged update warning from failed preflight and unknown jobs', async () => {
  const f = await setup()
  const invocation = `${process.execPath} ${join(f.lib, 'scripts/preflip-check.mjs')} --quiet-seconds 0 --app ${f.system.app} --codex-home ${f.codex}`
  f.system.execs.set(invocation, {
    status: 1,
    stdout: '',
    stderr: 'an app update is staged and would install on restart',
  })
  assert.equal(
    check(await runDoctor(f.system, f.root, { codexHome: f.codex }), 'app update').level,
    'warn',
  )
  f.system.execs.set(invocation, {
    status: 1,
    stdout: '',
    stderr: 'cannot tell whether an update is staged',
  })
  assert.equal(
    check(await runDoctor(f.system, f.root, { codexHome: f.codex }), 'app update').level,
    'fail',
  )
  f.system.execs.set(`launchctl print gui/${process.getuid?.() ?? 0}/dev.anyengine.smoke`, {
    status: null,
    stdout: '',
    stderr: 'spawn failed',
  })
  assert.equal(
    check(await runDoctor(f.system, f.root, { codexHome: f.codex }), 'update hold').level,
    'fail',
  )
})

function layer(root: string) {
  mkdirSync(join(root, 'rollback-fixture'), { recursive: true })
  return {
    version: 1,
    layers: [
      {
        name: 'router',
        rollbackDir: join(root, 'rollback-fixture'),
        createdAt: START,
        changes: [],
        adoptedFrom: null,
        jobs: [],
        cleansCache: true,
      },
    ],
  }
}
test('doctor requires the job and health of an active router layer, and diagnoses cache after removal', async () => {
  const f = await setup()
  writeFileSync(enginePaths(f.root).layers, JSON.stringify(layer(f.root)))
  let checks = await runDoctor(f.system, f.root, { codexHome: f.codex })
  assert.equal(check(checks, 'router job').level, 'fail')
  assert.equal(check(checks, 'router health').level, 'fail')
  assert.equal(check(checks, 'update hold').level, 'warn')
  writeFileSync(enginePaths(f.root).layers, JSON.stringify({ version: 1, layers: [] }))
  writeFileSync(
    join(f.codex, 'models_cache.json'),
    JSON.stringify({ client_version: '0.159.0', models: [{ slug: 'opus' }] }),
  )
  checks = await runDoctor(f.system, f.root, { codexHome: f.codex })
  assert.equal(check(checks, 'models cache').level, 'fail')
  assert.match(check(checks, 'models cache').detail, /anyengine cache clean/)
})

test('doctor silent claim socket has a bounded failure and leaves no live connection', async (t) => {
  const f = await setup()
  const socketDir = await tempDir('ds-')
  symlinkSync(socketDir, enginePaths(f.root).run)
  f.system.procs = [
    {
      pid: process.pid,
      ppid: 800,
      processStart: START,
      command: `node ${f.lib}/dist/src/adapter.mjs app-server`,
    },
    { pid: 800, ppid: 1, processStart: START, command: `${f.system.app}/Contents/MacOS/ChatGPT` },
  ]
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('data', () => {})
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((done) =>
    server.listen(join(socketDir, `claim-${process.pid}.sock`), done),
  )
  t.after(
    () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => done())
      }),
  )
  const result = check(await runDoctor(f.system, f.root, { codexHome: f.codex }), 'claim sockets')
  assert.equal(result.level, 'fail')
  assert.match(result.detail, /within 1000 ms/)
})
