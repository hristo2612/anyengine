import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { readConfig, setConfigValue } from '../src/anyengine-config.mjs'
import { runControl } from '../src/control-cli.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { m0Home } from './helpers/m0-home.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

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
    for (const args of [
      [op, '--yes'],
      ['desktop', 'chatgpt', op, '--yes'],
    ]) {
      out.length = 0
      assert.equal(await runControl(args, system, root, (s) => out.push(s)), 1)
      assert.match(out.join(''), /inside ChatGPT\.app/)
    }
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
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { readLayers } from '../src/control-layers.mjs'
import { readM2Journal, writeM2Journal } from '../src/control-m2-recovery-state.mjs'
import { prepareM2Upgrade } from '../src/control-m2-upgrade.mjs'
import { clearFlipMarker, readFlipMarker, writeFlipMarker } from '../src/control-marker.mjs'
import { realFlipDeps } from '../src/control-postflight.mjs'
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
  test(`on ${check.text} does not alter targets or quit, and leaves nothing to resume`, async () => {
    const s = await setup()
    const before = readFileSync(join(s.home, 'bin/codex'))
    s.deps.preflip = () => check
    assert.equal(await s.run('on'), 1)
    assert.deepEqual(restarts(s), [])
    assert.deepEqual(readFileSync(join(s.home, 'bin/codex')), before)
    assert.equal(readLayers(s.root).layers.length, 0)
    // 2026-10-16 MacBook: a refused preflight left flip.json behind, so the
    // next run only "resumed" it and a third was needed; and the advice said
    // --force, which never skips a forward on's quiet check.
    const out = s.out.join('')
    assert.equal(readFlipMarker(s.root), null, out)
    assert.match(out, /on stopped before changing anything; this run changed nothing/)
    assert.doesNotMatch(out, /Recovery retained/)
    for (const path of ['recovery', 'RECOVER.txt', 'state/layers.json'])
      assert.equal(existsSync(join(s.root, path)), false, `${path} was written before prepare`)
    if (!check.staged) assert.match(out, /--force does not skip this check for on or restart/)
    s.out.length = 0
    s.deps.preflip = () => ({ quiet: true, staged: false, text: 'quiet' })
    assert.equal(await s.run('on'), 0, s.out.join(''))
    assert.doesNotMatch(s.out.join(''), /resumed an interrupted/)
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

test('only a fresh on asks preflight for the first-install exception', async () => {
  const s = await setup()
  const seen: unknown[] = []
  s.deps.preflip = (_seconds, options) => {
    seen.push(options?.firstInstall)
    return { quiet: false, staged: false, text: 'busy' }
  }
  assert.equal(await s.run('on'), 1)
  assert.deepEqual(seen, [false], 'an M0 home is not a first install')
  for (const name of readdirSync(s.root))
    if (name.startsWith('rollback-')) renameSync(join(s.root, name), join(s.home, `kept-${name}`))
  seen.length = 0
  assert.equal(await s.run('on'), 1)
  assert.deepEqual(seen, [true], 'nothing installed: the exception may apply')
})

const installedRestarts = (s: Awaited<ReturnType<typeof setup>>) =>
  s.system.calls.filter((call) => ['quitApp', 'openApp'].includes(call))

// Review 2026-10-16: a refused restart kept its marker, and running restart
// again resumed it under recovery's quiet rules, which accept a staged update
// and --force: the app quit onto a staged update, or past a busy check.
for (const check of [
  {
    quiet: false,
    staged: true,
    text: 'preflip-check: not quiet: an app update is staged and would install on restart:\n x',
    again: [] as string[],
  },
  {
    quiet: false,
    staged: false,
    text: 'preflip-check: not quiet; wait, then run again:\n busy',
    again: ['--yes', '--force'],
  },
])
  test(`a refused restart (${check.staged ? 'staged' : 'busy'}) leaves no marker and the next one checks afresh`, async () => {
    const s = await setup()
    assert.equal(await s.run('on'), 0, s.out.join(''))
    s.system.calls.length = 0
    s.deps.preflip = () => check
    assert.equal(await s.run('restart'), 1)
    assert.equal(readFlipMarker(s.root), null, s.out.join(''))
    assert.match(s.out.join(''), /restart stopped before changing anything/)
    s.out.length = 0
    assert.equal(await s.run('restart', check.again), 1)
    assert.deepEqual(installedRestarts(s), [], s.out.join(''))
    assert.doesNotMatch(s.out.join(''), /resumed an interrupted/)
  })

test('a restart interrupted before it quit the app resumes without quitting it', async () => {
  const s = await setup()
  assert.equal(await s.run('on'), 0, s.out.join(''))
  for (const phase of ['preflight', 'prepare', 'restart']) {
    s.system.calls.length = 0
    writeFlipMarker(s.root, {
      id: `stale-restart-${phase}`,
      op: 'restart',
      args: ['--yes'],
      pid: 999_999,
      processStart: '2026-10-16T00:00:00.000Z',
      runner: 'foreground',
      phase,
      startedAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
      log: join(s.root, 'state/flip-stale.log'),
      state: {},
    })
    s.deps.preflip = () => ({
      quiet: false,
      staged: true,
      text: 'preflip-check: not quiet: an app update is staged and would install on restart:\n x',
    })
    assert.equal(await s.run('restart', ['--yes', '--force']), 1)
    assert.deepEqual(installedRestarts(s), [], `${phase}: ${s.out.join('')}`)
    assert.equal(readFlipMarker(s.root), null)
  }
})

test('a restart refused at its second check, or whose quit failed, resumes without quitting the app', async () => {
  for (const how of ['second check', 'failed quit']) {
    const s = await setup()
    assert.equal(await s.run('on'), 0, s.out.join(''))
    s.system.calls.length = 0
    let checks = 0
    if (how === 'second check')
      s.deps.preflip = () =>
        ++checks > 1
          ? {
              quiet: false,
              staged: false,
              text: 'preflip-check: not quiet; wait, then run again:\n busy',
            }
          : { quiet: true, staged: false, text: 'quiet' }
    else s.system.quitResult = false
    assert.equal(await s.run('restart'), 1, s.out.join(''))
    const kept = readFlipMarker(s.root)
    assert.ok(kept, `${how}: the marker stays (recovery files may exist)`)
    s.system.quitResult = true
    s.system.calls.length = 0
    s.deps.preflip = () => ({
      quiet: false,
      staged: true,
      text: 'preflip-check: not quiet: an app update is staged and would install on restart:\n x',
    })
    assert.equal(await s.run('restart', ['--yes', '--force']), 1)
    assert.deepEqual(installedRestarts(s), [], `${how}: ${s.out.join('')}`)
    assert.equal(readFlipMarker(s.root), null, `${how}: resumed to complete`)
  }
})

test('an on stopped after prepare with nothing installed resumes without a quiet check', async () => {
  // A first install that stopped at its second check leaves this marker; its
  // resume used to ask preflight without --first-install, which on a real
  // first install can never be quiet, and setup cannot pass --force.
  const s = await setup()
  writeFlipMarker(s.root, {
    id: 'first-install-prepare',
    op: 'on',
    args: ON,
    pid: 999_999,
    processStart: '2026-10-16T00:00:00.000Z',
    runner: 'foreground',
    phase: 'prepare',
    startedAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    log: join(s.root, 'state/flip-first-install.log'),
    state: { mutationsStarted: false },
  })
  let checks = 0
  s.deps.preflip = () => {
    checks += 1
    return { quiet: false, staged: false, text: 'preflip-check: cannot tell' }
  }
  assert.equal(await s.run('on'), 1, s.out.join(''))
  assert.equal(checks, 0, 'the resume asked no quiet question')
  assert.deepEqual(installedRestarts(s), [])
  assert.equal(readFlipMarker(s.root), null, s.out.join(''))
  assert.doesNotMatch(s.out.join(''), /resume failed/)
})

test('the real preflight passes --first-install only when asked', () => {
  const system = fakeSystem('/home/u')
  const calls: string[][] = []
  system.exec = (_command, args) => {
    calls.push(args)
    return { status: 0, stdout: 'preflip-check: quiet', stderr: '' }
  }
  const deps = realFlipDeps(system, '/home/u/.anyengine', '/lib/v')
  deps.preflip(30, { firstInstall: true })
  deps.preflip(30, { firstInstall: false })
  deps.preflip(30)
  assert.deepEqual(
    calls.map((args) => args.includes('--first-install')),
    [true, false, false],
  )
})

test('a restart marker at quit resumes without quitting only if the app runs and no postflight or rollback began', async () => {
  const stale = (s: Awaited<ReturnType<typeof setup>>, state: Record<string, unknown>) =>
    writeFlipMarker(s.root, {
      id: 'stale-restart-quit',
      op: 'restart',
      args: ['--yes'],
      pid: 999_999,
      processStart: '2026-10-16T00:00:00.000Z',
      runner: 'foreground',
      phase: 'quit',
      startedAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
      log: join(s.root, 'state/flip-stale.log'),
      state,
    })
  const quiet = { quiet: true, staged: false, text: 'quiet' }
  // Its quit failed and the app still runs: nothing to finish.
  const kept = await setup()
  assert.equal(await kept.run('on'), 0, kept.out.join(''))
  kept.system.calls.length = 0
  stale(kept, { quitDone: false })
  kept.deps.preflip = () => quiet
  assert.equal(await kept.run('restart', ['--yes']), 1)
  assert.deepEqual(installedRestarts(kept), [], kept.out.join(''))
  // A rollback's quit (route, with or without expect) is not a forward restart's.
  for (const state of [
    { quitDone: false, expect: 'router', route: 'router' },
    { quitDone: false, route: 'router' },
  ]) {
    const rolled = await setup()
    assert.equal(await rolled.run('on'), 0, rolled.out.join(''))
    rolled.system.calls.length = 0
    stale(rolled, state)
    rolled.deps.preflip = () => quiet
    await rolled.run('restart', ['--yes'])
    assert.ok(
      installedRestarts(rolled).includes('quitApp'),
      `${JSON.stringify(state)} resumes for real: ${rolled.out.join('')}`,
    )
  }
  // A resume that was itself interrupted after a postflight and rollback
  // began keeps that progress at the top level; the next run must see it.
  const twice = await setup()
  assert.equal(await twice.run('on'), 0, twice.out.join(''))
  twice.system.calls.length = 0
  stale(twice, {
    expect: 'router',
    route: 'router',
    interrupted: { op: 'restart', args: ['--yes'], phase: 'quit', state: { quitDone: false } },
  })
  twice.deps.preflip = () => quiet
  await twice.run('restart', ['--yes'])
  assert.ok(
    installedRestarts(twice).includes('quitApp'),
    `a re-resume resumes for real: ${twice.out.join('')}`,
  )
  // The app is not running: the quit may have happened, so it is finished for real.
  const down = await setup()
  assert.equal(await down.run('on'), 0, down.out.join(''))
  down.system.calls.length = 0
  stale(down, { quitDone: false })
  down.system.running = false
  down.deps.preflip = () => quiet
  await down.run('restart', ['--yes'])
  assert.ok(installedRestarts(down).includes('openApp'), down.out.join(''))
  assert.doesNotMatch(down.out.join(''), /app did not reopen during resume/)
})

test('a pre-quit restart resume fails when the app will not reopen', async () => {
  const s = await setup()
  assert.equal(await s.run('on'), 0, s.out.join(''))
  writeFlipMarker(s.root, {
    id: 'stale-restart-closed',
    op: 'restart',
    args: ['--yes'],
    pid: 999_999,
    processStart: '2026-10-16T00:00:00.000Z',
    runner: 'foreground',
    phase: 'prepare',
    startedAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    log: join(s.root, 'state/flip-stale.log'),
    state: {},
  })
  s.system.running = false
  s.system.openApp = () => {
    s.system.calls.push('openApp')
  }
  assert.equal(await s.run('restart', ['--yes']), 1)
  assert.match(s.out.join(''), /app did not reopen during resume/)
  assert.ok(readFlipMarker(s.root), 'the marker stays for another try')
})

// 2026-10-16, the MacBook: TMPDIR is /var/folders/.../T and /var links to
// /private/var, so the scratch proof refused 'indirect scratch/source parent:
// /var' on every Mac. The same shape here: TMPDIR under a linked parent.
test('on proves rollback when TMPDIR sits under a symlinked parent, as on macOS', async () => {
  const s = await setup()
  // Outside the observed home and root, as the proof requires.
  const outside = await tempDir('linked-tmp-')
  const real = join(outside, 'private-var')
  mkdirSync(join(real, 'folders', 'T'), { recursive: true })
  symlinkSync(real, join(outside, 'var'))
  const saved = process.env.TMPDIR
  process.env.TMPDIR = join(outside, 'var', 'folders', 'T')
  try {
    assert.equal(await s.run('on'), 0, s.out.join(''))
    const out = s.out.join('')
    assert.doesNotMatch(out, /indirect scratch\/source parent/)
    assert.ok(
      out.includes(
        `copied independently to ${join(realpathSync(real), 'folders', 'T')}/rollback-proof-`,
      ),
      out,
    )
  } finally {
    if (saved === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = saved
  }
})

// The MacBook's journal after 0.1.1's second run (captured 2026-10-17): the
// accounts bootstrap failed after the quit, the app was reopened, nothing was
// installed. Resuming must not quit the app again, and the next on is fresh.
test('the captured open-phase journal of a refused first install resumes without a quit, then on runs', async () => {
  const s = await setup()
  writeFlipMarker(s.root, {
    id: '152c1ba9-98a8-498e-a723-13d4afd3d087',
    op: 'on',
    args: ['--lib', '0.1.1', '--auto-rollback', '--yes'],
    pid: 50_344,
    processStart: '2026-10-16T22:21:23.000Z',
    runner: 'detached',
    phase: 'open',
    startedAt: '2026-10-16T22:21:23.947Z',
    updatedAt: '2026-10-16T22:21:45.718Z',
    log: join(s.root, 'state/flip-152c1ba9-98a8-498e-a723-13d4afd3d087.log'),
    state: {
      runnerId: '152c1ba9-98a8-498e-a723-13d4afd3d087',
      routerLayerWasNew: true,
      appVersionBefore: '26.1013.31256',
      mutationsStarted: false,
      quitDone: true,
    },
  })
  s.system.calls.length = 0
  assert.equal(await s.run('on'), 1, s.out.join(''))
  assert.deepEqual(installedRestarts(s), [], s.out.join(''))
  assert.match(s.out.join(''), /resumed an interrupted on \(it stopped at open\)/)
  assert.equal(readFlipMarker(s.root), null)
  s.out.length = 0
  assert.equal(await s.run('on'), 0, s.out.join(''))
})
