import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { readConfig, setConfigValue } from '../src/anyengine-config.mjs'
import { runControl } from '../src/control-cli.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { m0Home } from './helpers/m0-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)

test('registered flips refuse app ancestry before creating state or launching a runner', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const processStart = '2026-10-01T00:00:00.000Z'
  system.procs = [
    { pid: 100, ppid: 1, command: `${system.app}/Contents/MacOS/ChatGPT`, processStart },
    { pid: process.pid, ppid: 100, command: 'node adapter.mjs on', processStart },
  ]
  for (const op of ['on', 'off', 'restart']) {
    const out: string[] = []
    assert.equal(await runControl([op, '--yes'], system, root, (s) => out.push(s)), 1)
    assert.match(out.join(''), /inside ChatGPT\.app/)
    assert.equal(existsSync(join(root, 'state')), false)
    assert.equal(system.calls.length, 0)
  }
})

import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { readLayers } from '../src/control-layers.mjs'
import { readM2Journal, writeM2Journal } from '../src/control-m2-recovery-state.mjs'
import { prepareM2Upgrade } from '../src/control-m2-upgrade.mjs'
import { clearFlipMarker, readFlipMarker, writeFlipMarker } from '../src/control-marker.mjs'
import { ON, setup } from './helpers/flip-controller.mjs'
import { fakeLib } from './helpers/m0-home.mjs'

const restarts = (s: Awaited<ReturnType<typeof setup>>) =>
  s.system.calls.filter((c) => ['quitApp', 'openApp'].includes(c))

test('healthy on performs all job mutations after positive quit, verifies installed identity and clears marker', async () => {
  const s = await setup()
  setConfigValue(s.root, 'router.multiAgentV1', 'true')
  const launch = s.system.launchctl
  s.system.launchctl = (args) => {
    if (['bootstrap', 'bootout', 'kickstart'].includes(args[0] ?? ''))
      assert.equal(s.system.running, false)
    return launch(args)
  }
  assert.equal(await s.run('on'), 0, s.out.join(''))
  assert.deepEqual(restarts(s), ['quitApp', 'openApp'])
  assert.deepEqual(
    readLayers(s.root).layers.map((l) => l.name),
    ['adapter', 'router'],
  )
  assert.equal(readFlipMarker(s.root), null)
  assert.equal(existsSync(join(s.root, 'state/flip.lock')), false)
  assert.equal(readConfig(s.root).config?.router.multiAgentV1, true)
})

test('interrupted M2 On hands off recovery without broad fallback or clearing a superseding marker', async () => {
  const s = await setup()
  assert.equal(await s.run('on'), 0, s.out.join(''))
  const lib = s.plan.libDir
  mkdirSync(join(lib, 'dist/src'), { recursive: true })
  writeFileSync(join(lib, 'dist/src/adapter.mjs'), 'console.log("fixture selfcheck")\n')
  cpSync('scripts/lib-verify.mjs', join(lib, 'scripts/lib-verify.mjs'))
  const { writeManifest } = createRequire(import.meta.url)('../../scripts/lib-verify.mjs')
  writeManifest(lib, { version: s.plan.version })
  const exec = s.system.exec
  s.system.exec = (command, args, options) =>
    command === '/usr/bin/curl'
      ? {
          status: 0,
          stderr: '',
          stdout: JSON.stringify({
            ok: true,
            version: s.plan.version,
            pid: 4242,
            mode: 'agent',
            faults: { hookErrors: 0, unhandledRejections: 0 },
          }),
        }
      : exec(command, args, options)
  const baseline = prepareM2Upgrade(s.system, s.root, {
    ...s.plan,
    version: 'm2-test',
    libDir: join(s.root, 'lib/m2-test'),
    claudeCode: true,
  })
  const recovery = join(s.root, 'recovery/m2/recover.sh')
  const ts = '2026-10-01T00:00:00.000Z'
  const original = {
    id: 'interrupted-m2',
    op: 'on' as const,
    args: ON,
    pid: 999998,
    processStart: ts,
    runner: 'foreground' as const,
    phase: 'files',
    startedAt: ts,
    updatedAt: ts,
    log: join(s.root, 'state/flip-interrupted-m2.log'),
    state: {
      mutationsStarted: true,
      failureTarget: 'm2',
      m2BaselineId: basename(baseline.rollbackDir),
      recoveryCommand: recovery,
    },
  }
  writeFlipMarker(s.root, original)
  const layers = readFileSync(join(s.root, 'state/layers.json'))
  const runtime = readFileSync(join(s.root, 'runtime.env'))
  const current = readlinkSync(join(s.root, 'lib/current'))
  let shellCalls = 0
  let superseding: Buffer | null = null
  // Only the external shell boundary is replaced; admission, resume, handoff and
  // terminal cleanup run through the real controller and private journal readers.
  s.system.exec = (command, args, options) => {
    if (command !== '/bin/bash') return exec(command, args, options)
    shellCalls += 1
    assert.deepEqual(args, [recovery])
    assert.equal(existsSync(join(s.root, 'state/flip.lock')), false, 'release before handoff')
    const resumed = readFlipMarker(s.root)
    assert.equal(resumed?.id, original.id)
    assert.equal(resumed?.state.failureTarget, 'm2')
    assert.equal(resumed?.state.m2BaselineId, basename(baseline.rollbackDir))
    const journal = readM2Journal(s.root)
    assert.ok(journal)
    journal.transactionId = original.id
    journal.sharedMarkerDetached = true
    journal.baseline.phase = 'rolled-back'
    writeM2Journal(s.root, journal)
    clearFlipMarker(s.root)
    writeFlipMarker(s.root, {
      ...original,
      id: 'superseding-operation',
      op: 'off',
      args: ['--yes'],
      phase: 'preflight',
      state: {},
    })
    superseding = readFileSync(join(s.root, 'state/flip.json'))
    return { status: 0, stdout: '', stderr: '' }
  }
  s.deps.preflip = () => {
    throw new Error('M1 broad fallback must not run')
  }
  s.system.launchctl = () => {
    throw new Error('M1 broad job mutation must not run')
  }
  s.system.quitApp = () => {
    throw new Error('M1 broad quit must not run')
  }
  assert.equal(await s.run('on'), 1, s.out.join(''))
  assert.equal(shellCalls, 1, s.out.join(''))
  assert.ok(superseding)
  assert.deepEqual(readFileSync(join(s.root, 'state/flip.json')), superseding)
  assert.deepEqual(readFileSync(join(s.root, 'state/layers.json')), layers)
  assert.deepEqual(readFileSync(join(s.root, 'runtime.env')), runtime)
  assert.equal(readlinkSync(join(s.root, 'lib/current')), current)
  assert.equal(existsSync(join(s.root, 'state/flip.lock')), false)
})

for (const check of [
  { quiet: true, staged: true, text: 'staged' },
  { quiet: false, staged: false, text: 'busy' },
])
  test(`on ${check.text} does not alter targets or quit`, async () => {
    const s = await setup()
    const before = readFileSync(join(s.home, 'bin/codex'))
    s.deps.preflip = () => check
    assert.equal(await s.run('on'), 1)
    assert.deepEqual(restarts(s), [])
    assert.deepEqual(readFileSync(join(s.home, 'bin/codex')), before)
    assert.equal(readLayers(s.root).layers.length, 0)
  })

test('dry-run proves real Bash rollback without creating lock, marker, log or changing target metadata', async () => {
  const s = await setup()
  const runtime = join(s.root, 'runtime.env')
  const config = join(s.home, '.codex/config.toml')
  const pick = join(s.home, '.codex/anyengine/app-model-pick.json')
  chmodSync(runtime, 0o644)
  const configBytes = '# opaque fixture config must not be printed\nmodel = "grok-4.7"\n'
  writeFileSync(config, configBytes)
  const watched = [s.root, join(s.home, '.zshrc'), runtime, join(s.root, 'lib/current'), config]
  const before = watched.map((p) => {
    const t = lstatSync(p)
    return [t.mode, t.ino, t.mtimeMs]
  })
  const entries = readdirSync(s.root)
  assert.equal(await s.run('on', [...ON, '--dry-run']), 0, s.out.join(''))
  assert.match(s.out.join(''), /proof bash anyengine-off: ok/)
  assert.ok(
    s.out.join('').includes(`would adopt M0 from ${join(s.root, 'rollback-20260930T114234Z')}\n`),
  )
  for (const target of [config, pick]) assert.ok(s.out.join('').includes(`would write ${target}\n`))
  for (const target of [runtime, join(s.home, '.zshrc')])
    assert.equal(s.out.join('').includes(`would write ${target}\n`), false)
  assert.equal(s.out.join('').includes(configBytes.trim()), false)
  assert.equal(readFileSync(config, 'utf8'), configBytes)
  assert.equal(existsSync(pick), false)
  assert.deepEqual(readdirSync(s.root), entries)
  assert.deepEqual(
    watched.map((p) => {
      const t = lstatSync(p)
      return [t.mode, t.ino, t.mtimeMs]
    }),
    before,
  )
  assert.deepEqual(restarts(s), [])
})

test('quit failure preserves dependencies and marker, never reopens, and resume preserves untouched baseline', async () => {
  const s = await setup()
  s.system.quitResult = false
  assert.equal(await s.run('on'), 1, s.out.join(''))
  assert.deepEqual(restarts(s), ['quitApp'])
  assert.equal(s.system.jobs.size, 0)
  assert.equal(readlinkSync(join(s.root, 'lib/current')), '0.1.0-986ab707750e')
  assert.ok(readFlipMarker(s.root))
  s.system.quitResult = true
  assert.equal(await s.run('on'), 1, s.out.join(''))
  assert.equal(readFlipMarker(s.root), null)
})

test('late staged update leaves source files intact, never quits and keeps durable recovery', async () => {
  const s = await setup()
  let checks = 0
  s.deps.preflip = () => ({ quiet: true, staged: ++checks > 1, text: 'staged' })
  assert.equal(await s.run('on'), 1)
  assert.deepEqual(restarts(s), [])
  assert.equal(readLayers(s.root).layers.length, 0)
  assert.ok(existsSync(join(s.root, 'RECOVER.txt')))
})

test('signal after confirmed quit reopens exactly once and retains terminal recovery authority when no install began', async () => {
  const s = await setup()
  const stop = { requested: null as NodeJS.Signals | null }
  const quit = s.system.quitApp
  s.system.quitApp = () => {
    const ok = quit()
    stop.requested = 'SIGTERM'
    return ok
  }
  assert.equal(await s.run('on', ON, stop), 1, s.out.join(''))
  assert.equal(s.system.running, true)
  assert.deepEqual(restarts(s), ['quitApp', 'openApp'])
})

test('off quit failure keeps loaded jobs, shared configuration and cache until resume completes', async () => {
  const s = await setup()
  assert.equal(await s.run('on'), 0, s.out.join(''))
  const cache = join(s.home, '.codex/models_cache.json')
  writeFileSync(
    cache,
    JSON.stringify({ models: [{ slug: 'opus', description: 'Claude via AnyEngine' }] }),
  )
  s.system.calls.length = 0
  s.system.quitResult = false
  assert.equal(await s.run('off', ['--yes', '--router-only']), 1)
  assert.equal(s.system.jobs.has('dev.anyengine.router'), true)
  assert.ok(existsSync(cache))
  assert.deepEqual(restarts(s), ['quitApp'])
  assert.equal(readLayers(s.root).layers.find((l) => l.name === 'router')?.pending, undefined)
  assert.equal(readFlipMarker(s.root)?.state.routerOnly, true)
  s.system.quitResult = true
  assert.equal(await s.run('off', ['--yes', '--force']), 1, s.out.join(''))
  assert.deepEqual(
    readLayers(s.root).layers.map((l) => l.name),
    ['adapter'],
  )
  assert.equal(s.system.jobs.has('dev.anyengine.router'), false)
  assert.equal(existsSync(cache), false)
  assert.equal(readFlipMarker(s.root), null)
})

for (const unknown of [false, true])
  test(`no-restart refuses ${unknown ? 'unknown' : 'running'} app without dependency mutation`, async () => {
    const s = await setup()
    assert.equal(await s.run('on'), 0, s.out.join(''))
    if (unknown) s.system.runningError = new Error('app state unknown')
    s.system.calls.length = 0
    const before = readFileSync(join(s.home, 'Library/LaunchAgents/dev.anyengine.router.plist'))
    assert.equal(await s.run('off', ['--yes', '--no-restart']), 1)
    assert.deepEqual(
      readFileSync(join(s.home, 'Library/LaunchAgents/dev.anyengine.router.plist')),
      before,
    )
    assert.equal(s.system.jobs.has('dev.anyengine.router'), true)
    assert.deepEqual(restarts(s), [])
  })

test('failed after-quit cleanup reopens and preserves marker/journal for a clean retry', async () => {
  const s = await setup()
  assert.equal(await s.run('on'), 0, s.out.join(''))
  const launch = s.system.launchctl
  s.system.launchctl = (args) =>
    args[0] === 'bootout' ? { status: 0, stdout: '', stderr: 'bootout denied' } : launch(args)
  s.system.calls.length = 0
  assert.equal(await s.run('off', ['--yes', '--router-only']), 1)
  assert.deepEqual(restarts(s), ['quitApp', 'openApp'])
  assert.ok(readFlipMarker(s.root))
  assert.ok(readLayers(s.root).layers.some((l) => l.pending))
  s.system.launchctl = launch
  assert.equal(await s.run('off', ['--yes']), 1, s.out.join(''))
  assert.equal(readFlipMarker(s.root), null)
})

test('failed immediate M1 upgrade returns to last-good M1 before the original M0 ladder', async () => {
  const s = await setup()
  assert.equal(await s.run('on'), 0, s.out.join(''))
  fakeLib(s.home, '0.1.0-next')
  s.manifest('0.1.0-next')
  const health = s.deps.routerHealth
  s.deps.routerHealth = async (ms) =>
    s.deps.currentSnapshot().key.lib === '0.1.0-next' ? null : health(ms)
  assert.equal(
    await s.run('on', ['--yes', '--auto-rollback', '--lib', '0.1.0-next']),
    1,
    s.out.join(''),
  )
  assert.equal(readlinkSync(join(s.root, 'lib/current')), '0.1.0-m1test')
  assert.deepEqual(
    readLayers(s.root).layers.map((l) => l.name),
    ['adapter', 'router'],
  )
  assert.equal(readLayers(s.root).layers.find((l) => l.name === 'router')?.upgrade, undefined)
  assert.equal(readFlipMarker(s.root), null)
})

test('invalid UTF8 native evidence is preserved before any target write; unsupported valid evidence only selects bridge', async () => {
  const s = await setup()
  const path = join(s.root, 'proof.json')
  const invalid = Buffer.concat([Buffer.from('{"detail":"'), Buffer.from([255]), Buffer.from('"}')])
  writeFileSync(path, invalid)
  assert.equal(await s.run('on', [...ON, '--native-proof', path]), 1)
  assert.deepEqual(readFileSync(path), invalid)
  assert.equal(readLayers(s.root).layers.length, 0)
  assert.equal(readFlipMarker(s.root), null)
  writeFileSync(
    path,
    JSON.stringify({ detail: '\uFFFD', paths: { 'native-fanout': { ok: true } } }),
  )
  assert.equal(await s.run('on', [...ON, '--native-proof', path]), 0, s.out.join(''))
  assert.match(s.out.join(''), /native pre-proof rejected/)
  assert.equal(existsSync(join(s.root, 'state/proven.json')), false)
})

test('missing mandatory producer rolls back to vanilla', async () => {
  const s = await setup({ gate: false })
  assert.equal(await s.run('on'), 1, s.out.join(''))
  assert.match(s.out.join(''), /Task27 mandatory installed deployment gate/)
  assert.deepEqual(readLayers(s.root).layers, [])
  assert.equal(s.system.running, true)
})
