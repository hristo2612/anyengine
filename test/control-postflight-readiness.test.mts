import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { applyOnFiles } from '../src/control-install.mjs'
import { postflight } from '../src/control-postflight.mjs'
import { gatherStatus } from '../src/control-status.mjs'
import { settingsHash } from '../src/degraded.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { CODE, ROUTER, scripted } from './helpers/flip-deps.mjs'
import { fakeLib, m0Home, pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)

async function relaunched() {
  const home = await m0Home()
  const system = fakeSystem(home)
  const fixture = scripted(system, { gate: true })
  const plan = fakeLib(home)
  const root = join(home, '.anyengine')
  applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
  const snapshot = fixture.deps.currentSnapshot()
  const input = {
    expect: 'router' as const,
    since: system.now(),
    appVersionBefore: system.version ?? '',
    versionChangeExpected: false,
    libVersion: plan.version,
    routerUrl: ROUTER,
    baselineOther: [],
    frozen: { codeIdentity: CODE, key: { ...snapshot.key }, mode: snapshot.mode },
  }
  system.quitApp()
  system.openApp()
  let gates = 0
  const gate = fixture.deps.mandatoryGate
  assert.ok(gate)
  fixture.deps.mandatoryGate = async (request, observe) => {
    gates += 1
    return gate(request, observe)
  }
  const adapter = system.procs.find((p) => p.command.includes('adapter.mjs app-server'))
  const child = system.procs.find((p) => p.ppid === adapter?.pid)
  assert.ok(adapter && child)
  const transient = { ...adapter, pid: adapter.pid + 1000 }
  const born = () => system.procs.push(transient)
  const ready = () => {
    system.procs.push({ ...child, pid: child.pid + 1000, ppid: transient.pid })
    fixture.events.push(
      ...fixture.events.flatMap((event) => {
        if (event.pid === adapter.pid) return [{ ...event, pid: transient.pid }]
        if (event.pid === child.pid) return [{ ...event, pid: child.pid + 1000 }]
        return []
      }),
    )
  }
  // Use production status classification on synthetic public process/event metadata.
  const inspect = async () => {
    const previous = process.env.ANYENGINE_DEBUG_LOG
    const log = join(home, 'doctor-events.jsonl')
    writeFileSync(log, fixture.events.map((event) => JSON.stringify(event)).join('\n'))
    process.env.ANYENGINE_DEBUG_LOG = log
    try {
      const status = await gatherStatus(
        { ...system, launchctl: () => ({ status: 113, stdout: '', stderr: '' }) },
        root,
      )
      assert.deepEqual(status.inspectionErrors, [])
      const missing = status.adapters.filter((p) => p.codexChild !== 'running')
      return {
        ok: missing.length === 0,
        text: missing.length ? 'codex child: fail codex child unknown' : 'current children running',
      }
    } finally {
      if (previous === undefined) delete process.env.ANYENGINE_DEBUG_LOG
      else process.env.ANYENGINE_DEBUG_LOG = previous
    }
  }
  return { ...fixture, system, input, born, ready, inspect, gates: () => gates, transient }
}

for (const outcome of ['ready', 'exited'] as const)
  test(`doctor retries a new unknown App transport until ${outcome}`, async () => {
    const s = await relaunched()
    let doctors = 0
    let sleeps = 0
    s.deps.doctor = async () => {
      if (++doctors === 1) s.born()
      return s.inspect()
    }
    s.system.sleep = async (ms) => {
      assert.equal(ms, 2000)
      sleeps += 1
      if (outcome === 'ready') s.ready()
      else s.system.procs = s.system.procs.filter((p) => p.pid !== s.transient.pid)
    }
    const gate = s.deps.mandatoryGate
    assert.ok(gate)
    s.deps.mandatoryGate = async (request, observe) => {
      assert.equal(
        request.adapters.some((p) => p.pid === s.transient.pid),
        outcome === 'ready',
      )
      return gate(request, observe)
    }
    const checks = await postflight(s.system, s.deps, s.input)
    assert.ok(
      checks.every((c) => c.ok),
      JSON.stringify(checks),
    )
    assert.equal(doctors, 2)
    assert.equal(sleeps, 1)
    assert.equal(s.gates(), 1)
  })

test('persistent unknown child exhausts bounded doctor attempts and never runs mandatory work', async () => {
  const s = await relaunched()
  let doctors = 0
  let sleeps = 0
  s.deps.doctor = async () => {
    if (++doctors === 1) s.born()
    return s.inspect()
  }
  s.system.sleep = async (ms) => {
    assert.equal(ms, 2000)
    sleeps += 1
  }
  const checks = await postflight(s.system, s.deps, s.input)
  assert.equal(checks.find((c) => c.name === 'doctor')?.ok, false)
  assert.match(checks.find((c) => c.name === 'doctor')?.detail ?? '', /child unknown/)
  assert.match(checks.find((c) => c.name === 'smoke')?.detail ?? '', /prerequisites failed/)
  assert.equal(doctors, 4)
  assert.equal(sleeps, 3)
  assert.equal(s.gates(), 0)
})

for (const drift of ['settings', 'code', 'app', 'rollback-app', 'codex', 'bundled'] as const)
  test(`fresh frozen identity refuses ${drift} drift between doctor retries`, async () => {
    const s = await relaunched()
    s.input.versionChangeExpected = drift === 'rollback-app'
    const snapshot = s.deps.currentSnapshot
    const bundled = s.deps.bundledCodex
    let changed = false
    let doctors = 0
    s.deps.bundledCodex = () =>
      changed && drift === 'bundled' ? '/controlled/moved-bundle/codex' : bundled()
    s.deps.currentSnapshot = () => {
      const current = snapshot()
      if (!changed) return current
      if (drift === 'code') return { ...current, codeIdentity: 'b'.repeat(64) }
      if (drift === 'bundled') return { ...current, bundled: s.deps.bundledCodex() }
      if (drift === 'settings') {
        const config = structuredClone(current.config)
        config.router.multiAgentV1 = !config.router.multiAgentV1
        const key = { ...current.key, settings: settingsHash(config) }
        assert.notEqual(key.settings, current.key.settings)
        return { ...current, config, key }
      }
      return {
        ...current,
        key: {
          ...current.key,
          ...(drift.endsWith('app') ? { appVersion: '99.1.1' } : {}),
          ...(drift === 'codex' ? { codexVersion: '99.1.1' } : {}),
        },
      }
    }
    s.deps.doctor = async () => {
      doctors += 1
      return { ok: false, text: 'startup child unknown' }
    }
    s.system.sleep = async () => {
      changed = true
    }
    const checks = await postflight(s.system, s.deps, s.input)
    assert.match(checks.find((c) => c.name === 'doctor')?.detail ?? '', /drift/)
    assert.equal(doctors, 1, 'changed identity must not receive a second doctor attempt')
    assert.equal(s.gates(), 0)
  })

test('identity drift during a successful doctor result fails before mandatory work', async () => {
  const s = await relaunched()
  s.deps.doctor = async () => {
    s.system.version = '99.1.1'
    return { ok: true, text: 'old identity inspected successfully' }
  }
  const checks = await postflight(s.system, s.deps, s.input)
  assert.equal(checks.find((c) => c.name === 'doctor')?.ok, false)
  assert.equal(s.gates(), 0)
})

test('all restarted adapters exiting between retries cannot run mandatory work with an empty family', async () => {
  const s = await relaunched()
  let doctors = 0
  s.deps.doctor = async () => {
    if (++doctors === 1) s.born()
    return s.inspect()
  }
  s.system.sleep = async () => {
    s.system.procs = s.system.procs.filter((p) => !p.command.includes('app-server'))
  }
  const checks = await postflight(s.system, s.deps, s.input)
  assert.equal(checks.find((c) => c.name === 'doctor')?.ok, true, 'doctor sees no live adapters')
  assert.equal(checks.find((c) => c.name === 'smoke')?.ok, false)
  assert.match(checks.find((c) => c.name === 'smoke')?.detail ?? '', /no restarted adapter remains/)
  assert.equal(doctors, 2)
  assert.equal(s.gates(), 0)
})
