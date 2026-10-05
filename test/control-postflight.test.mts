import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { classifyCodexProcesses, type FlipDeps, postflight } from '../src/control-postflight.mjs'
import { proveRollback } from '../src/control-proof.mjs'
import { processOwnership } from '../src/control-system.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { fakeLib, m0Home, pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

const names = [
  'app version',
  'handshake',
  'adapter process',
  'GPT child',
  'router attached',
  'foreign codex',
  'router health',
  'claim socket',
  'doctor',
  'smoke',
]
const deps = (): FlipDeps => ({
  preflip: () => ({ quiet: true, staged: false, text: 'quiet' }),
  verifyLib: () => [],
  doctor: async () => ({ ok: true, text: 'fixture' }),
  smoke: null,
  mandatoryGate: null,
  currentSnapshot: () => {
    throw new Error('snapshot absent')
  },
  routerHealth: async () => null,
  claimPing: async () => true,
  bundledCodex: () => null,
  appLog: () => [],
  debugEvents: () => [],
})
const input = {
  expect: 'vanilla' as const,
  since: new Date('2026-10-01T00:00:00Z'),
  appVersionBefore: '26.928.20755',
  versionChangeExpected: false,
  libVersion: null,
  routerUrl: null,
  baselineOther: [],
}

test('classify: node wrappers, app paths with spaces and actual remote proxy arguments', () => {
  const app = '/Applications/Chat GPT.app'
  const system = fakeSystem('/controlled')
  const commands = [
    `"${app}/Contents/Resources/codex" app-server`,
    '/opt/.nvm/versions/node/v24/bin/node /opt/.nvm/versions/node/v24/bin/codex app-server proxy',
    '/opt/node/bin/node /opt/node/bin/codex app-server proxy',
    'node /x/dist/src/adapter.mjs app-server',
  ]
  const procs = commands.map((command, index) => ({
    pid: 10 + index,
    ppid: index === 0 ? 800 : 900,
    processStart: '2026-10-01T00:00:00.000Z',
    command,
  }))
  procs.push(
    {
      pid: 800,
      ppid: 1,
      processStart: '2026-10-01T00:00:00.000Z',
      command: `${system.app}/Contents/MacOS/ChatGPT`,
    },
    {
      pid: 900,
      ppid: 1,
      processStart: '2026-10-01T00:00:00.000Z',
      command: 'node /service/web/launch.cjs',
    },
  )
  assert.deepEqual(
    classifyCodexProcesses(procs, app, processOwnership(system, procs)).map((p) => p.kind),
    ['app', 'ssh-remote', 'other', 'other'],
  )
})

test('postflight always reports every check; unknown app/process state never means vanilla', async () => {
  const system = fakeSystem(await tempDir('postflight-'))
  system.version = null
  system.processError = new Error('ps cannot inspect')
  const checks = await postflight(system, deps(), input)
  assert.deepEqual(
    checks.map((c) => c.name),
    names,
  )
  for (const name of ['app version', 'adapter process', 'foreign codex'])
    assert.equal(checks.find((c) => c.name === name)?.ok, false, name)
})

test('missing Task27 callable deployment gate cannot certify adapter acceptance', async () => {
  const checks = await postflight(fakeSystem(await tempDir('postflight-')), deps(), {
    ...input,
    expect: 'adapter',
    libVersion: 'v1',
  })
  assert.equal(checks.find((c) => c.name === 'smoke')?.ok, false)
  assert.match(checks.find((c) => c.name === 'smoke')?.detail ?? '', /not wired/)
})

test('proof actually restores full, router-only and immediate last-good via isolated Bash and Node', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const plan = fakeLib(home)
  const scratchParent = await tempDir('proof-parent-')
  const watched = ['.zshrc', 'bin/codex', '.codex/config.toml']
  const before = watched.map((p) => readFileSync(join(home, p)))
  const system = fakeSystem(home)
  system.exec = () => {
    throw new Error('source exec must not run')
  }
  system.launchctl = () => {
    throw new Error('source launchctl must not run')
  }
  system.quitApp = () => {
    throw new Error('source app must not quit')
  }
  system.openApp = () => {
    throw new Error('source app must not open')
  }
  const result = proveRollback(system, root, plan, { paths: pathsFor(home), scratchParent })
  assert.equal(result.ok, true, result.lines.join('\n'))
  for (const route of [
    'bash anyengine-off',
    'node off',
    'bash anyengine-off --router-only',
    'bash anyengine-off --last-good',
    'node off --last-good',
  ])
    assert.ok(
      result.lines.some((line) => line.includes(`${route}: ok`)),
      result.lines.join('\n'),
    )
  assert.deepEqual(
    watched.map((p) => readFileSync(join(home, p))),
    before,
  )
  assert.deepEqual(readdirSync(scratchParent), [])
})

test('proof names changed targets and preserves source evidence', async () => {
  const home = await m0Home()
  const result = proveRollback(fakeSystem(home), join(home, '.anyengine'), fakeLib(home), {
    paths: pathsFor(home),
    scratchParent: await tempDir('proof-parent-'),
    afterOn: (scratchHome) =>
      writeFileSync(join(scratchHome, 'bin/codex'), '#!/bin/sh\necho changed\n'),
  })
  assert.equal(result.ok, false)
  assert.match(result.lines.join('\n'), /bin\/codex/)
})

async function relaunched(options: { version?: string; gate?: boolean } = {}) {
  const { applyOnFiles } = await import('../src/control-install.mjs')
  const { scripted, CODE } = await import('./helpers/flip-deps.mjs')
  const home = await m0Home()
  const system = fakeSystem(home)
  const fixture = scripted(system, {
    gate: options.gate ?? true,
    ...(options.version ? { versionOnOpen: { 1: options.version } } : {}),
  })
  const plan = fakeLib(home)
  applyOnFiles(system, join(home, '.anyengine'), plan, { dryRun: false, paths: pathsFor(home) })
  const snapshot = fixture.deps.currentSnapshot()
  const request = {
    ...input,
    expect: 'router' as const,
    since: system.now(),
    libVersion: plan.version,
    routerUrl: 'http://127.0.0.1:18790/backend-api/codex',
    frozen: { codeIdentity: CODE, key: snapshot.key, mode: snapshot.mode },
  }
  system.quitApp()
  system.openApp()
  return { ...fixture, request, system, home }
}

test('postflight validates every current check and a structured successful mandatory gate', async () => {
  const s = await relaunched()
  const result = await postflight(s.system, s.deps, s.request)
  assert.deepEqual(
    result.map((c) => c.name),
    names,
  )
  assert.ok(
    result.every((c) => c.ok),
    JSON.stringify(result),
  )
})

test('postflight excludes an adapter that exits before its claim ping from mandatory work', async () => {
  const s = await relaunched()
  const adapter = s.system.procs.find((process) =>
    process.command.includes('adapter.mjs app-server'),
  )
  assert.ok(adapter)
  const transient = { ...adapter, pid: adapter.pid + 1000 }
  const child = s.system.procs.find((process) => process.ppid === adapter.pid)
  assert.ok(child)
  s.system.procs.push(transient, { ...child, pid: child.pid + 1000, ppid: transient.pid })
  s.events.push(
    ...s.events.flatMap((event) => {
      if (event.pid === adapter.pid) return [{ ...event, pid: transient.pid }]
      if (event.pid === child.pid) return [{ ...event, pid: child.pid + 1000 }]
      return []
    }),
  )
  s.deps.claimPing = async (pid) => {
    if (pid !== transient.pid) return true
    s.system.procs = s.system.procs.filter((process) => process.pid !== pid && process.ppid !== pid)
    return false
  }
  const gate = s.deps.mandatoryGate
  assert.ok(gate)
  s.deps.mandatoryGate = async (request, observe) => {
    assert.deepEqual(
      request.adapters.map(({ pid }) => pid),
      [adapter.pid],
    )
    return gate(request, observe)
  }
  const result = await postflight(s.system, s.deps, s.request)
  assert.ok(
    result.every((check) => check.ok),
    JSON.stringify(result),
  )
})

test('forward app update fails; expected rollback re-resolves moved bundled executable and re-verifies the fresh key', async () => {
  const s = await relaunched({ version: '26.935.1' })
  const forward = await postflight(s.system, s.deps, s.request)
  assert.equal(forward[0]?.ok, false)
  const back = await postflight(s.system, s.deps, { ...s.request, versionChangeExpected: true })
  assert.ok(
    back.every((c) => c.ok),
    JSON.stringify(back),
  )
  assert.match(back[0]?.detail ?? '', /expected on the way back/)
  assert.match(back.find((c) => c.name === 'GPT child')?.detail ?? '', /NewBundle/)
})

for (const failure of [
  'old-event',
  'wrong-child',
  'wrong-code',
  'settings-drift',
  'health-fault',
  'health-library',
  'gate-failed-turn',
  'gate-wrong-owner',
  'gate-drift',
  'disabled-not-wired',
])
  test(`postflight refuses ${failure} and preserves all check names`, async () => {
    const s = await relaunched()
    if (failure === 'old-event') for (const e of s.events) e.ts = '2000-01-01T00:00:00Z'
    if (failure === 'wrong-child') s.system.procs = s.system.procs.filter((p) => p.ppid === 1)
    if (failure === 'wrong-code') s.request.frozen.codeIdentity = 'b'.repeat(64)
    if (failure === 'settings-drift') s.request.frozen.key.settings = 'bad'
    if (failure.startsWith('health-')) {
      const health = s.deps.routerHealth
      s.deps.routerHealth = async (timeout) => ({
        ...(await health(timeout)),
        ...(failure === 'health-fault'
          ? { faults: { hookErrors: 1, unhandledRejections: 0 } }
          : { version: 'wrong-lib' }),
      })
    }
    if (failure.startsWith('gate-')) {
      const { successfulGate } = await import('./helpers/flip-deps.mjs')
      s.deps.mandatoryGate = async (request, observe) => {
        const result = successfulGate(request, observe, s.system)
        if (failure === 'gate-failed-turn') {
          const turn = result.turns[0]
          assert.ok(turn)
          turn.success = false
        }
        if (failure === 'gate-wrong-owner') {
          const turn = result.turns.find((t) => t.path === 'bridge')
          assert.ok(turn)
          turn.probeId = 'self-declared-owner'
        }
        if (failure === 'gate-drift') s.system.version = '99.1.1'
        return result
      }
    }
    if (failure === 'disabled-not-wired') {
      s.deps.mandatoryGate = null
      s.deps.smoke = async () => ({ ok: true, text: 'scheduled disabled' })
    }
    const result = await postflight(s.system, s.deps, s.request)
    assert.deepEqual(
      result.map((c) => c.name),
      names,
    )
    assert.ok(
      result.some((c) => !c.ok),
      failure,
    )
    assert.equal(result.at(-1)?.ok, false, 'no model work can certify failed readiness')
  })

test('readiness polling is bounded and accepts evidence that arrives after relaunch', async () => {
  const s = await relaunched()
  const logs = s.log.splice(0)
  const events = s.events.splice(0)
  let sleeps = 0
  s.system.sleep = async (ms) => {
    assert.equal(ms, 2000)
    if (++sleeps === 3) {
      s.log.push(...logs)
      s.events.push(...events)
    }
  }
  assert.ok((await postflight(s.system, s.deps, s.request)).every((c) => c.ok))
  assert.equal(sleeps, 3)
  s.log.length = 0
  s.events.length = 0
  sleeps = 0
  s.system.sleep = async () => {
    sleeps += 1
  }
  assert.equal(
    (await postflight(s.system, s.deps, s.request)).find((c) => c.name === 'handshake')?.ok,
    false,
  )
  assert.equal(sleeps, 30)
})

for (const bad of ['wrong-model', 'duplicate-turn', 'unrelated-handshake'])
  test(`postflight rejects ${bad} as authentic current success`, async () => {
    const s = await relaunched()
    if (bad === 'unrelated-handshake')
      s.log[s.log.length - 1] = (s.log.at(-1) ?? '').replace(
        'transportKind=stdio',
        'transportKind=websocket',
      )
    else {
      const { successfulGate } = await import('./helpers/flip-deps.mjs')
      s.deps.mandatoryGate = async (request, observe) => {
        const result = successfulGate(request, observe, s.system)
        if (bad === 'wrong-model') {
          const turn = result.turns.find((t) => t.path === 'claude-pty')
          assert.ok(turn)
          turn.model = 'wrong-model'
        } else
          result.turns.forEach((turn) => {
            turn.threadId = 'one'
            turn.turnId = 'one'
          })
        return result
      }
    }
    const result = await postflight(s.system, s.deps, s.request)
    assert.equal(result.at(-1)?.ok, false, JSON.stringify(result))
  })

for (const expect of ['adapter', 'vanilla'] as const)
  test(`actual off files lead to truthful ${expect} postflight with positive job absence`, async () => {
    const { applyOffFiles, finishOff } = await import('../src/control-install.mjs')
    const s = await relaunched()
    const root = join(s.home, '.anyengine')
    s.system.quitApp()
    assert.equal(
      applyOffFiles(s.system, root, { routerOnly: expect === 'adapter', paths: pathsFor(s.home) })
        .ok,
      true,
    )
    finishOff(s.system, root, pathsFor(s.home))
    const snapshot = s.deps.currentSnapshot()
    const since = s.system.now()
    s.system.openApp()
    const result = await postflight(s.system, s.deps, {
      ...s.request,
      expect,
      since,
      libVersion: snapshot.key.lib,
      routerUrl: null,
      frozen: { codeIdentity: snapshot.codeIdentity ?? '', key: snapshot.key, mode: snapshot.mode },
    })
    assert.ok(
      result.every((check) => check.ok),
      JSON.stringify(result),
    )
    s.system.launchctl = () => ({ status: 113, stdout: '', stderr: '' })
    const unknown = await postflight(s.system, s.deps, { ...s.request, expect, since })
    assert.equal(unknown.find((check) => check.name === 'router health')?.ok, false)
  })

for (const failure of [
  'claim',
  'doctor',
  'verify',
  'new-foreign',
  'nonbundled',
  'native-unproven',
  'degraded',
  'health-upstream',
  'health-malformed',
])
  test(`postflight current ${failure} failure cannot be certified by successful work`, async () => {
    const s = await relaunched()
    if (failure === 'claim') s.deps.claimPing = async () => false
    if (failure === 'doctor') s.deps.doctor = async () => ({ ok: false, text: 'failed inspection' })
    if (failure === 'verify') s.deps.verifyLib = () => ['changed manifested bytes']
    if (failure === 'new-foreign')
      s.system.procs.push({
        pid: 1,
        ppid: 1,
        processStart: s.system.now().toISOString(),
        command: '/foreign/codex exec',
      })
    if (failure === 'nonbundled')
      s.events.push({ event: 'shim.nonBundledCodex', ts: s.system.now().toISOString() })
    if (failure === 'degraded') {
      const snapshot = s.deps.currentSnapshot
      s.deps.currentSnapshot = () => ({ ...snapshot(), degraded: ['gpt'] })
    }
    if (['native-unproven', 'health-upstream', 'health-malformed'].includes(failure)) {
      const health = s.deps.routerHealth
      s.deps.routerHealth = async (timeout) => ({
        ...(await health(timeout)),
        ...(failure === 'native-unproven'
          ? { fanout: { path: 'native', reason: 'pretend', since: s.system.now().toISOString() } }
          : failure === 'health-upstream'
            ? {
                upstream: {
                  lastOkAt: null,
                  lastError: 'broken',
                  lastErrorAt: s.system.now().toISOString(),
                },
              }
            : { inflight: { gpt: -1, claude: 'unknown' } }),
      })
    }
    const result = await postflight(s.system, s.deps, s.request)
    assert.equal(result.at(-1)?.ok, false, JSON.stringify(result))
  })

test('pre-existing foreign executable is preserved in the baseline', async () => {
  const s = await relaunched()
  s.system.procs.push({
    pid: 1,
    ppid: 1,
    processStart: s.system.now().toISOString(),
    command: '/foreign/codex exec',
  })
  const result = await postflight(s.system, s.deps, {
    ...s.request,
    baselineOther: ['/foreign/codex'],
  })
  assert.ok(
    result.every((check) => check.ok),
    JSON.stringify(result),
  )
})
