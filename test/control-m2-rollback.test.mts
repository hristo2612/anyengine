import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import test, { after } from 'node:test'
import { enginePaths } from '../src/anyengine-config.mjs'
import { ROUTER_LABEL, SMOKE_LABEL } from '../src/control-launchd.mjs'
import { readLayers } from '../src/control-layers.mjs'
import {
  clearFlipMarker,
  flipMarkerPath,
  readFlipMarker,
  writeFlipMarker,
} from '../src/control-marker.mjs'
import { publicRecoveryScript, publishRecovery, shellQuote } from '../src/control-scripts.mjs'
import { activate, applyClaude, setup, snapshot } from './helpers/milestone-recovery.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

function run(s: Awaited<ReturnType<typeof setup>>, ...args: string[]) {
  return spawnSync('/bin/bash', [join(s.root, 'recovery/m2/recover.sh'), ...args], {
    env: s.env,
    encoding: 'utf8',
    timeout: 30_000,
  })
}

test('prepare durably captures the immediate verified M1 baseline and publishes independent private recovery', async () => {
  const s = await setup(false)
  const baseline = s.api.prepare(s.system, s.root, s.plan)
  assert.equal(baseline.version, 1)
  assert.equal(baseline.priorLib, s.m1Lib)
  assert.notEqual(baseline.priorLib, s.m0Lib)
  assert.equal(baseline.m1LayersSha256, hash(s.beforeLayers))
  assert.deepEqual(readFileSync(baseline.m1LayersBackup), s.beforeLayers)
  assert.ok(s.api.pins(s.root).includes(s.m1Lib))
  assert.deepEqual(
    baseline.jobs.map(({ label, loaded }) => ({ label, loaded })),
    [
      { label: ROUTER_LABEL, loaded: true },
      { label: SMOKE_LABEL, loaded: false },
    ],
  )
  for (const path of [
    join(s.root, 'm2-upgrade.json'),
    baseline.recoveryJournal,
    join(s.root, 'recovery/m2/current.json'),
  ])
    assert.equal(lstatSync(path).mode & 0o777, 0o600)
  for (const path of [baseline.recoveryScript, join(s.root, 'recovery/m2/recover.sh')])
    assert.equal(lstatSync(path).mode & 0o777, 0o700)
  const pointer = json(join(s.root, 'recovery/m2/current.json'))
  assert.equal(pointer.script, baseline.recoveryScript)
  assert.equal(pointer.journal, baseline.recoveryJournal)
  assert.equal(pointer.scriptSha256, hash(readFileSync(baseline.recoveryScript)))
  assert.ok(
    readFileSync(join(s.root, 'recovery/m2/RECOVER.txt'), 'utf8').includes(
      join(s.root, 'recovery/m2/recover.sh'),
    ),
  )
  assert.deepEqual(snapshot(s.control.concat(join(s.root, 'lib/current'))), s.before)
})

test('repeat preparation preserves the first M1 baseline even after the M2 library is current', async () => {
  const s = await setup()
  const before = s.api.prepare(s.system, s.root, s.plan)
  activate(s)
  const again = s.api.prepare(s.system, s.root, { ...s.plan, stamp: 'm2-update' })
  assert.equal(again.priorLib, s.m1Lib)
  assert.equal(again.rollbackDir, before.rollbackDir)
  assert.equal(again.recoveryScript, before.recoveryScript)
  assert.deepEqual(readFileSync(again.m1LayersBackup), s.beforeLayers)
})

test('unhealthy M1 and changed installed manifest are rejected before advertising recovery', async () => {
  for (const failure of ['health', 'manifest']) {
    const s = await setup()
    if (failure === 'health') s.setUnhealthy()
    else writeFileSync(join(s.m1Lib, 'dist/src/adapter.mjs'), 'tampered\n')
    assert.throws(
      () => s.api.prepare(s.system, s.root, s.plan),
      /health|manifest|installed|byte|M1/,
    )
    assert.equal(existsSync(join(s.root, 'm2-upgrade.json')), false)
    assert.deepEqual(snapshot(s.control.concat(join(s.root, 'lib/current'))), s.before)
  }
})

test('corrupt or escaped M2 authority fails closed and retains the M1 library pin', async () => {
  const s = await setup()
  s.api.prepare(s.system, s.root, s.plan)
  writeFileSync(join(s.root, 'm2-upgrade.json'), '{"version":1,"priorLib":"/outside"}\n')
  assert.throws(() => s.api.read(s.root), /M2|baseline|record|recovery/)
  assert.throws(() => s.api.pins(s.root), /M2|baseline|record|recovery/)
  assert.equal(existsSync(s.m1Lib), true)
})

test('a symlink recovery directory is refused without writing outside the owned namespace', async () => {
  const s = await setup()
  const outside = join(s.home, 'outside')
  mkdirSync(outside)
  mkdirSync(join(s.root, 'recovery'), { recursive: true })
  symlinkSync(outside, join(s.root, 'recovery/m2'))
  assert.throws(() => s.api.prepare(s.system, s.root, s.plan), /directory|symlink|physical|owned/)
  assert.equal(existsSync(join(outside, 'recover.sh')), false)
  assert.equal(existsSync(join(s.root, 'm2-upgrade.json')), false)
})

test('write-ahead control deltas restore M1 bytes and original M1 layer records without broad off', async () => {
  const s = await setup()
  const baseline = s.api.prepare(s.system, s.root, s.plan)
  activate(s)
  const result = await s.api.rollback(s.system, s.root, { noRestart: true })
  assert.deepEqual(result, { ok: true, restoredLib: s.m1Lib, conflicts: [], m1Verified: true })
  assert.equal(realpathSync(join(s.root, 'lib/current')), s.m1Lib)
  assert.deepEqual(snapshot(s.control.concat(join(s.root, 'lib/current'))), s.before)
  assert.deepEqual(readFileSync(enginePaths(s.root).layers), s.beforeLayers)
  assert.equal(readFileSync(s.cache, 'utf8'), 'M1 CACHE MUST SURVIVE')
  assert.equal(s.system.jobs.has(ROUTER_LABEL), true)
  assert.equal(s.system.jobs.has(SMOKE_LABEL), true)
  assert.equal(s.api.read(s.root)?.phase, 'rolled-back')
  assert.equal(existsSync(baseline.recoveryJournal), true)
  assert.equal(existsSync(baseline.recoveryScript), true)
})

test('no-restart rejects a running app before restoring any dependencies', async () => {
  const s = await setup()
  s.api.prepare(s.system, s.root, s.plan)
  activate(s)
  s.system.running = true
  const result = await s.api.rollback(s.system, s.root, { noRestart: true })
  assert.equal(result.ok, false)
  assert.ok(result.conflicts.some((value) => /app|running|exit/.test(value)))
  assert.equal(realpathSync(join(s.root, 'lib/current')), s.m2Lib)
  assert.ok(s.api.pins(s.root).includes(s.m1Lib))
  assert.equal(s.system.calls.includes('quitApp'), false)
})

test('foreign shared marker is preserved and prevents the M1 bootstrap switch', async () => {
  const s = await setup()
  s.api.prepare(s.system, s.root, s.plan)
  activate(s)
  writeFlipMarker(s.root, {
    id: 'foreign-op',
    op: 'on',
    args: [],
    pid: process.pid,
    processStart: '2026-10-01T00:00:00.000Z',
    runner: 'foreground',
    phase: 'between',
    startedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    log: join(s.root, 'log'),
    state: {},
  })
  const result = await s.api.rollback(s.system, s.root, { noRestart: true })
  assert.equal(result.ok, false)
  assert.equal(readFlipMarker(s.root)?.id, 'foreign-op')
  assert.equal(realpathSync(join(s.root, 'lib/current')), s.m2Lib)
  assert.ok(s.api.pins(s.root).includes(s.m1Lib))
})

test('Node-free stable entry restores M1 with Node absent and supports verified repeated invocation', async () => {
  const s = await setup(false)
  const m1Layer = readLayers(s.root).layers.find((layer) => layer.name === 'router')
  assert.ok(m1Layer)
  writeFileSync(join(m1Layer.rollbackDir, 'ROLLBACK.sh'), '#!/bin/bash\nexit 64\n', {
    mode: 0o700,
  })
  s.api.prepare(s.system, s.root, s.plan)
  const writer = activate(s)
  const publicEntry = join(s.root, 'bin/anyengine-off')
  writer.writeFile(publicEntry, publicRecoveryScript(s.root), 0o700)
  publishRecovery({
    root: s.root,
    codexHome: join(s.home, '.codex'),
    app: s.system.app,
    bundleId: s.plan.bundleId,
    ...(s.plan.recoveryCommands ? { commands: s.plan.recoveryCommands } : {}),
  })
  const first = spawnSync('/bin/bash', [publicEntry, '--m2-only', '--no-restart'], {
    env: s.env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.deepEqual(snapshot(s.control.concat(join(s.root, 'lib/current'))), s.before)
  assert.deepEqual(readFileSync(enginePaths(s.root).layers), s.beforeLayers)
  assert.equal(existsSync(join(s.jobs, ROUTER_LABEL)), true)
  assert.equal(existsSync(join(s.jobs, SMOKE_LABEL)), false)
  assert.equal(readFlipMarker(s.root), null)
  const repeated = run(s, '--no-restart')
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr)
  assert.deepEqual(snapshot(s.control.concat(join(s.root, 'lib/current'))), s.before)
  assert.equal(readFileSync(s.cache, 'utf8'), 'M1 CACHE MUST SURVIVE')
})

test('M2-only recovery preserves repeated-on user settings and detaches its matching shared marker', async () => {
  const s = await setup()
  const baseline = s.api.prepare(s.system, s.root, s.plan)
  writeFlipMarker(s.root, {
    id: 'owned-m2',
    op: 'on',
    args: [],
    pid: process.pid,
    processStart: '2026-10-01T00:00:00.000Z',
    runner: 'foreground',
    phase: 'between',
    startedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    log: join(s.root, 'log'),
    state: { m2BaselineId: basename(baseline.rollbackDir), failureTarget: 'm2' },
  })
  activate(s)
  const agent = applyClaude(s)
  const marker = readFlipMarker(s.root)
  assert.ok(marker)
  clearFlipMarker(s.root)
  writeFlipMarker(s.root, { ...marker, id: 'owned-m2-update', phase: 'prepare' })
  const layer = readLayers(s.root).layers.find((entry) => entry.name === 'claude-code')
  assert.ok(layer)
  assert.throws(() => s.api.record(s.root, layer, 'checkpoint'), /another flip transaction/)
  const { setM2UpgradePhase } = await import('../src/control-m2-upgrade.mjs')
  setM2UpgradePhase(s.root, 'active')
  const current = JSON.parse(readFileSync(s.settings, 'utf8'))
  current.theme = 'light'
  current.modelPicker.options.push({ model: 'gpt-user', label: 'My row' })
  writeFileSync(s.settings, JSON.stringify(current))
  applyClaude(s)
  const result = run(s, '--no-restart')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const restored = JSON.parse(readFileSync(s.settings, 'utf8'))
  assert.equal(restored.theme, 'light')
  assert.deepEqual(restored.modelPicker.options, [{ model: 'gpt-user', label: 'My row' }])
  assert.equal(restored.env?.ANTHROPIC_BASE_URL, undefined)
  assert.equal(existsSync(agent), false)
  assert.equal(readFlipMarker(s.root), null)
  const journal = json(baseline.recoveryJournal)
  assert.equal(journal.transactionId, 'owned-m2-update')
  assert.equal(journal.sharedMarkerDetached, true)
  assert.equal(realpathSync(join(s.root, 'lib/current')), s.m1Lib)
  assert.deepEqual(readFileSync(enginePaths(s.root).layers), s.beforeLayers)
})

test('M2-only edited-agent conflict retains Claude routing and restores the functional M2 router job', async () => {
  const s = await setup()
  s.api.prepare(s.system, s.root, s.plan)
  activate(s)
  const agent = applyClaude(s)
  const settings = readFileSync(s.settings, 'utf8')
  writeFileSync(agent, 'operator edited GPT agent\n')
  const result = run(s, '--no-restart')
  assert.notEqual(result.status, 0)
  assert.ok((result.stdout + result.stderr).includes(agent))
  assert.equal(readFileSync(agent, 'utf8'), 'operator edited GPT agent\n')
  assert.equal(readFileSync(s.settings, 'utf8'), settings)
  assert.equal(realpathSync(join(s.root, 'lib/current')), s.m2Lib)
  assert.equal(existsSync(join(s.jobs, ROUTER_LABEL)), true)
  assert.ok(readLayers(s.root).layers.some((layer) => layer.name === 'claude-code'))
  assert.ok(s.api.pins(s.root).includes(s.m1Lib))
})

test('changed control bytes remain a conflict and never activate M0 or retire the recovery pin', async () => {
  const s = await setup()
  const baseline = s.api.prepare(s.system, s.root, s.plan)
  activate(s)
  writeFileSync(join(s.root, 'bin/anyengine'), 'operator replaced this entire command\n')
  const result = await s.api.rollback(s.system, s.root, { noRestart: true })
  assert.equal(result.ok, false)
  assert.ok(result.conflicts.some((value) => value.includes(join(s.root, 'bin/anyengine'))))
  assert.equal(
    readFileSync(join(s.root, 'bin/anyengine'), 'utf8'),
    'operator replaced this entire command\n',
  )
  assert.notEqual(realpathSync(join(s.root, 'lib/current')), s.m0Lib)
  assert.ok(s.api.pins(s.root).includes(s.m1Lib))
  assert.equal(existsSync(baseline.recoveryJournal), true)
})

test('terminal recovery refuses a superseding installation without mutating it', async () => {
  const s = await setup()
  s.api.prepare(s.system, s.root, s.plan)
  activate(s)
  assert.equal(run(s, '--no-restart').status, 0)
  unlinkSync(join(s.root, 'lib/current'))
  symlinkSync(s.m2Lib, join(s.root, 'lib/current'))
  const before = snapshot(s.control.concat(join(s.root, 'lib/current')))
  const result = run(s, '--no-restart')
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /supersed|changed|conflict/)
  assert.deepEqual(snapshot(s.control.concat(join(s.root, 'lib/current'))), before)
})

test('Node-free recovery resumes after interrupted Claude undo when settings were originally absent', async () => {
  const s = await setup()
  rmSync(s.settings)
  const baseline = s.api.prepare(s.system, s.root, s.plan)
  activate(s)
  const agent = applyClaude(s)
  assert.equal(existsSync(s.settings), true)
  const original = readFileSync(baseline.recoveryScript, 'utf8')
  const checkpoint = `checkpoint ${shellQuote('before-marker-detach')}`
  assert.ok(original.includes(checkpoint))
  const fault = original.replace(checkpoint, () => `${checkpoint}\n/bin/kill -KILL $$`)
  const pointerPath = join(s.root, 'recovery/m2/current.json')
  const pointer = json(pointerPath)
  writeFileSync(baseline.recoveryScript, fault, { mode: 0o700 })
  writeFileSync(pointerPath, JSON.stringify({ ...pointer, scriptSha256: hash(fault) }), {
    mode: 0o600,
  })
  const interrupted = run(s, '--no-restart')
  assert.equal(interrupted.signal, 'SIGKILL', interrupted.stdout + interrupted.stderr)
  assert.equal(existsSync(s.settings), false)
  assert.equal(existsSync(agent), false)
  assert.ok(readLayers(s.root).layers.some((layer) => layer.name === 'claude-code'))
  assert.equal(realpathSync(join(s.root, 'lib/current')), s.m2Lib)
  writeFileSync(baseline.recoveryScript, original, { mode: 0o700 })
  writeFileSync(pointerPath, JSON.stringify(pointer), { mode: 0o600 })
  const resumed = run(s, '--no-restart')
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr)
  assert.equal(existsSync(s.settings), false)
  assert.equal(existsSync(agent), false)
  assert.deepEqual(snapshot(s.control.concat(join(s.root, 'lib/current'))), s.before)
  assert.deepEqual(readFileSync(enginePaths(s.root).layers), s.beforeLayers)
  assert.equal(s.api.read(s.root)?.phase, 'rolled-back')
  assert.equal(run(s, '--no-restart').status, 0)
})

test('Node-free rollback waits for M1 startup and verifies its model mode', async () => {
  const s = await setup(true, 'model')
  s.api.prepare(s.system, s.root, s.plan)
  activate(s)
  const m1Status = { since: '2026-10-01T00:00:00Z', reason: 'M1 failure must survive' }
  const launchctl = s.plan.recoveryCommands?.launchctl
  assert.ok(launchctl)
  const retiring = join(s.home, 'router-retiring')
  const polls = join(s.home, 'router-retirement-polls')
  const jobs = join(s.home, 'jobs')
  writeFileSync(
    launchctl,
    readFileSync(launchctl, 'utf8')
      .replace(
        'case "$1" in',
        `if [ "$1" = print ] && [ "$label" = dev.anyengine.router ] && [ -f ${shellQuote(retiring)} ]; then
echo poll >> ${shellQuote(polls)}
if [ "$(/usr/bin/wc -l < ${shellQuote(polls)})" -ge 25 ]; then /bin/rm -f ${shellQuote(retiring)} ${shellQuote(join(jobs, 'dev.anyengine.router'))}; fi
fi
case "$1" in`,
      )
      .replace(
        'bootout) /bin/rm -f',
        `bootout) if [ "$label" = dev.anyengine.router ]; then /usr/bin/touch ${shellQuote(retiring)}; exit 0; fi; /bin/rm -f`,
      ),
    { mode: 0o700 },
  )
  const degraded = join(s.root, 'state/degraded.json')
  writeFileSync(
    degraded,
    JSON.stringify({ paths: { 'native-fanout': m1Status, 'claude-code-gpt': m1Status } }),
    { mode: 0o600 },
  )
  const proven = join(s.root, 'state/proven.json')
  writeFileSync(proven, readFileSync(degraded), { mode: 0o600 })
  const curl = s.plan.recoveryCommands?.curl
  assert.ok(curl)
  const ready = readFileSync(curl, 'utf8')
  const attempts = join(s.home, 'health-startup-attempts')
  writeFileSync(
    curl,
    `#!/bin/bash\necho attempt >> ${shellQuote(attempts)}\n[ "$(/usr/bin/wc -l < ${shellQuote(attempts)})" -gt 2 ] || exit 7\n${ready}`,
    { mode: 0o700 },
  )
  const result = run(s, '--no-restart')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(json(degraded), { paths: { 'native-fanout': m1Status } })
  assert.deepEqual(json(proven), { paths: { 'native-fanout': m1Status } })
  assert.match(readFileSync(s.calls, 'utf8'), /bootout .*dev\.anyengine\.smoke/)
  assert.equal(readFileSync(attempts, 'utf8').trim().split('\n').length, 3)
  assert.equal(realpathSync(join(s.root, 'lib/current')), s.m1Lib)
  assert.deepEqual(readFileSync(enginePaths(s.root).layers), s.beforeLayers)
  assert.equal(s.api.read(s.root)?.phase, 'rolled-back')
  assert.equal(run(s, '--no-restart').status, 0)
})

for (const phase of [
  'shared-marker-detached',
  'control-restored',
  'layers-restored',
  'jobs-restored',
]) {
  test(`actual kill after ${phase} resumes through the retained absolute Node-free entry`, async () => {
    const s = await setup()
    const baseline = s.api.prepare(s.system, s.root, s.plan)
    activate(s)
    const original = readFileSync(baseline.recoveryScript, 'utf8')
    const checkpoint = `checkpoint ${shellQuote(phase)}`
    assert.ok(original.includes(checkpoint), 'named private checkpoint exists for fault injection')
    const fault = original.replace(checkpoint, () => `${checkpoint}\n/bin/kill -KILL $$`)
    writeFileSync(baseline.recoveryScript, fault, { mode: 0o700 })
    const pointerPath = join(s.root, 'recovery/m2/current.json')
    const pointer = json(pointerPath)
    writeFileSync(pointerPath, JSON.stringify({ ...pointer, scriptSha256: hash(fault) }), {
      mode: 0o600,
    })
    const interrupted = run(s, '--no-restart')
    assert.equal(interrupted.signal, 'SIGKILL', interrupted.stdout + interrupted.stderr)
    assert.equal(readFlipMarker(s.root), null)
    assert.equal(existsSync(baseline.recoveryJournal), true)
    assert.equal(existsSync(join(s.root, 'recovery/m2/recover.sh')), true)
    writeFileSync(baseline.recoveryScript, original, { mode: 0o700 })
    writeFileSync(pointerPath, JSON.stringify(pointer), { mode: 0o600 })
    const resumed = run(s, '--no-restart')
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr)
    assert.deepEqual(snapshot(s.control.concat(join(s.root, 'lib/current'))), s.before)
    assert.deepEqual(readFileSync(enginePaths(s.root).layers), s.beforeLayers)
    assert.equal(readFlipMarker(s.root), null)
    assert.equal(existsSync(flipMarkerPath(s.root)), false)
    assert.equal(run(s, '--no-restart').status, 0)
  })
}
