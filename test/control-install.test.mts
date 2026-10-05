import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { DEFAULT_CONFIG, enginePaths } from '../src/anyengine-config.mjs'
import { duplicateTopLevelKeys } from '../src/codex-config-toml.mjs'
import {
  applyOffFiles,
  applyOnFiles,
  applySharedConfig,
  finishOff,
  restoreSharedConfig,
} from '../src/control-install.mjs'
import {
  jobLoaded,
  loadJob,
  reloadJob,
  routerPlist,
  smokePlist,
  unloadJob,
} from '../src/control-launchd.mjs'
import {
  LayerWriter,
  readLayers,
  restoreChange,
  sha256Of,
  writeLayers,
} from '../src/control-layers.mjs'
import { findCodexCliBlock, RC_BEGIN } from '../src/control-rc.mjs'
import { publicRecoveryScript, publishRecovery, shellQuote } from '../src/control-scripts.mjs'
import { fakeSystem as rawFakeSystem } from './helpers/fake-system.mjs'
import { fakeLib, m0Home, pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

function fakeSystem(home: string) {
  const system = rawFakeSystem(home)
  const launch = system.launchctl
  system.launchctl = (args) => {
    const result = launch(args)
    if (
      args[0] === 'print' &&
      args[1] === `gui/${process.getuid?.() ?? 0}` &&
      !system.execs.has(`launchctl ${args.join(' ')}`)
    )
      return { status: 0, stdout: 'domain', stderr: '' }
    if (args[0] === 'print' && result.status === 113 && !result.stderr) {
      const label = args[1]?.split('/').at(-1)
      return {
        ...result,
        stderr: `Bad request.\nCould not find service "${label}" in domain for user gui: ${process.getuid?.() ?? 0}\n`,
      }
    }
    return result
  }
  return system
}

const snapshot = (home: string, paths: string[]) =>
  Object.fromEntries(
    paths.map((p) => {
      const full = join(home, p)
      const stat = lstatSync(full, { throwIfNoEntry: false })
      if (!stat) return [p, 'absent']
      if (stat.isSymbolicLink()) return [p, `-> ${readlinkSync(full)}`]
      return [p, `${sha256Of(full)} ${(stat.mode & 0o777).toString(8)}`]
    }),
  )
const WATCHED = [
  // anyengine-off and layers.json are AnyEngine's own record, checked separately.
  '.zshrc',
  'bin/codex',
  '.anyengine/runtime.env',
  '.anyengine/lib/current',
  '.anyengine/bin/anyengine',
  'Library/LaunchAgents/dev.anyengine.router.plist',
  'Library/LaunchAgents/dev.anyengine.smoke.plist',
  '.codex/config.toml',
  '.codex/anyengine/app-model-pick.json',
]

test('on adopts the hand-flipped M0 state without writing the rc block or the backup again', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const rcBefore = readFileSync(join(home, '.zshrc'), 'utf8')
  const result = applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  assert.equal(result.adopted, true)
  assert.deepEqual(result.layers, ['adapter', 'router'])
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), rcBefore, 'rc untouched')
  assert.equal(readlinkSync(join(root, 'lib', 'current')), '0.1.0-m1test')
  assert.match(readFileSync(join(home, 'bin', 'codex'), 'utf8'), /m1/)
  assert.ok(system.jobs.has('dev.anyengine.router'))
  assert.ok(system.jobs.has('dev.anyengine.smoke'))
  assert.match(readLayers(root).layers[0]?.adoptedFrom ?? '', /rollback-20260930T114234Z$/)
  const again = applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  assert.deepEqual(again.wrote, [], 'an upgrade preserves the legacy shell baseline')
  assert.equal(readLayers(root).layers.length, 2)
})

test('on refuses a half-on M0', async () => {
  const home = await m0Home()
  writeFileSync(
    join(home, 'bin', 'codex'),
    readFileSync(join(home, '.anyengine', 'rollback-20260930T114234Z', '01-codex.bak')),
  )
  const result = applyOnFiles(fakeSystem(home), join(home, '.anyengine'), fakeLib(home), {
    dryRun: false,
    paths: pathsFor(home),
  })
  assert.match(result.refused ?? '', /half on/)
  assert.deepEqual(result.wrote, [])
  assert.ok(!existsSync(enginePaths(join(home, '.anyengine')).layers))
})

test('off --router-only returns exactly to M0; off returns exactly to before M0', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const m0 = snapshot(home, WATCHED)
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  const routerOff = applyOffFiles(system, root, { routerOnly: true, paths: pathsFor(home) })
  assert.equal(routerOff.ok, true)
  assert.deepEqual(snapshot(home, WATCHED), m0)
  assert.ok(
    system.jobs.has('dev.anyengine.router'),
    'the running app still needs the router until it has quit',
  )
  assert.equal(readLayers(root).layers.find((l) => l.name === 'router')?.pending, 'after-quit')
  system.running = false
  finishOff(system, root, pathsFor(home))
  assert.ok(!system.jobs.has('dev.anyengine.router'))
  assert.deepEqual(
    readLayers(root).layers.map((l) => l.name),
    ['adapter'],
  )
  assert.deepEqual(
    applyOffFiles(system, root, { routerOnly: true, paths: pathsFor(home) }).popped,
    [],
    '--router-only pops only a layer named router',
  )
  assert.deepEqual(
    readLayers(root).layers.map((l) => l.name),
    ['adapter'],
  )
  assert.match(
    readFileSync(join(root, 'bin', 'anyengine-off'), 'utf8'),
    /recovery\/anyengine-off/,
    'the public forwarder reaches private live-journal recovery',
  )
  assert.doesNotMatch(
    readFileSync(join(root, 'bin', 'anyengine-off'), 'utf8'),
    /rollback-\d{8}T\d{6}Z-router/,
  )
  const full = applyOffFiles(system, root, { routerOnly: false, paths: pathsFor(home) })
  assert.equal(full.ok, true)
  system.running = false
  finishOff(system, root, pathsFor(home))
  const bk = join(root, 'rollback-20260930T114234Z')
  assert.equal(sha256Of(join(home, '.zshrc')), sha256Of(join(bk, '00-.zshrc.bak')))
  assert.equal(sha256Of(join(home, 'bin', 'codex')), sha256Of(join(bk, '01-codex.bak')))
  assert.equal(findCodexCliBlock(readFileSync(join(home, '.zshrc'), 'utf8')).state, 'commented')
  assert.ok(!existsSync(enginePaths(root).layers))
  assert.ok(!existsSync(join(root, 'bin', 'anyengine-off')))
})

test('on on a fresh Mac writes one marked rc block, and off removes it', async () => {
  const dir = await tempDir('anyengine-install-')
  const home = join(dir, 'home')
  mkdirSync(join(home, '.anyengine', 'lib'), { recursive: true })
  writeFileSync(join(home, '.zshrc'), 'export A=1\n')
  const system = fakeSystem(home)
  const before = snapshot(home, WATCHED)
  applyOnFiles(system, join(home, '.anyengine'), fakeLib(home), {
    dryRun: false,
    paths: pathsFor(home),
  })
  const rc = readFileSync(join(home, '.zshrc'), 'utf8')
  assert.equal(rc.split(RC_BEGIN).length - 1, 1)
  assert.equal(findCodexCliBlock(rc).state, 'active')
  writeFileSync(join(home, '.anyengine/bin/anyengine'), '#!/bin/sh\necho setup-ready\n', {
    mode: 0o755,
  })
  const terminal = spawnSync('/bin/bash', ['-c', '. "$HOME/.zshrc"; anyengine'], {
    env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin', CODEX_SHELL: '' },
    encoding: 'utf8',
  })
  assert.equal(terminal.status, 0, terminal.stderr)
  assert.equal(terminal.stdout.trim(), 'setup-ready')
  // Restore the installed bytes before testing ownership-aware off.
  writeFileSync(
    join(home, '.anyengine/bin/anyengine'),
    readFileSync(fakeLib(home).launcherSource),
    { mode: 0o755 },
  )
  applyOffFiles(system, join(home, '.anyengine'), { routerOnly: false, paths: pathsFor(home) })
  system.running = false
  finishOff(system, join(home, '.anyengine'), pathsFor(home))
  assert.deepEqual(snapshot(home, WATCHED), before)
})

test('on on a fresh Mac rewrites a stale ANYENGINE_ADAPTER in runtime.env as a tracked change, and off puts it back', async () => {
  const dir = await tempDir('anyengine-install-')
  const home = join(dir, 'home')
  mkdirSync(join(home, '.anyengine', 'lib'), { recursive: true })
  writeFileSync(join(home, '.zshrc'), 'export A=1\n')
  const stale =
    'export ANYENGINE_RUNTIME_TYPE="anyengine"\nexport ANYENGINE_ADAPTER="$HOME/Projects/anyengine/dist/src/adapter.mjs"\n'
  writeFileSync(join(home, '.anyengine', 'runtime.env'), stale)
  const system = fakeSystem(home)
  applyOnFiles(system, join(home, '.anyengine'), fakeLib(home), {
    dryRun: false,
    paths: pathsFor(home),
  })
  assert.match(
    readFileSync(join(home, '.anyengine', 'runtime.env'), 'utf8'),
    /^export ANYENGINE_ADAPTER="\$HOME\/\.anyengine\/lib\/current\/dist\/src\/adapter\.mjs"$/m,
  )
  applyOffFiles(system, join(home, '.anyengine'), { routerOnly: false, paths: pathsFor(home) })
  system.running = false
  finishOff(system, join(home, '.anyengine'), pathsFor(home))
  assert.equal(readFileSync(join(home, '.anyengine', 'runtime.env'), 'utf8'), stale)
})

test('off reverts only its own hunk when the rc changed since', async () => {
  const dir = await tempDir('anyengine-install-')
  const home = join(dir, 'home')
  mkdirSync(join(home, '.anyengine', 'lib'), { recursive: true })
  writeFileSync(join(home, '.zshrc'), 'export A=1\n')
  const system = fakeSystem(home)
  applyOnFiles(system, join(home, '.anyengine'), fakeLib(home), {
    dryRun: false,
    paths: pathsFor(home),
  })
  writeFileSync(
    join(home, '.zshrc'),
    `${readFileSync(join(home, '.zshrc'), 'utf8')}alias ll='ls -l'\n`,
  )
  const off = applyOffFiles(system, join(home, '.anyengine'), {
    routerOnly: false,
    paths: pathsFor(home),
  })
  system.running = false
  finishOff(system, join(home, '.anyengine'), pathsFor(home))
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), "export A=1\nalias ll='ls -l'\n")
  assert.equal(off.results.find((r) => r.target.endsWith('.zshrc'))?.outcome, 'reverted-hunk')
})

test('a file changed beyond recognition is left alone and reported, and its layer stays recorded', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  writeFileSync(join(home, 'bin', 'codex'), '#!/bin/sh\necho mine\n')
  const off = applyOffFiles(system, root, { routerOnly: true, paths: pathsFor(home) })
  assert.equal(off.ok, false)
  assert.equal(off.results.find((r) => r.target.endsWith('bin/codex'))?.outcome, 'left-changed')
  assert.equal(readFileSync(join(home, 'bin', 'codex'), 'utf8'), '#!/bin/sh\necho mine\n')
  assert.equal(
    readlinkSync(join(root, 'lib', 'current')),
    '0.1.0-986ab707750e',
    'the rest was still undone',
  )
  assert.deepEqual(off.kept, ['router'])
  assert.deepEqual(
    readLayers(root).layers.map((l) => l.name),
    ['adapter', 'router'],
    'layers.json keeps what is not undone',
  )
})

test('write-ahead: an on killed in the middle is undone by anyengine-off alone', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const m0 = snapshot(home, WATCHED)
  const launchctl = system.launchctl
  system.launchctl = (args) => {
    if (args[0] === 'bootstrap') throw new Error('killed at the first job load')
    return launchctl(args)
  }
  assert.throws(
    () => applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) }),
    /killed/,
  )
  assert.ok(existsSync(join(root, 'bin', 'anyengine-off')))
  assert.ok(readLayers(root).layers.some((l) => l.name === 'router'))
  assert.equal(system.jobs.size, 0, 'interruption preceded the first bootstrap')
  const recoveryCalls = join(home, 'recovery-job-calls')
  const stub = (name: string, body: string) => {
    const path = join(home, `${name}.sh`)
    writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o755 })
    return path
  }
  publishRecovery({
    root,
    app: system.app,
    bundleId: 'com.openai.codex',
    codexHome: pathsFor(home).codexHome,
    commands: {
      launchctl: stub(
        'launchctl',
        `printf '%s\\n' "$*" >> ${shellQuote(recoveryCalls)}
        [ "$1" = print ] || exit 9
        case "$2" in */dev.anyengine.router|*/dev.anyengine.smoke)
          label=$(/usr/bin/basename "$2")
          printf 'Bad request.\\nCould not find service "%s" in domain for user gui: %s\\n' "$label" "$(/usr/bin/id -u)" >&2
          exit 113;; esac
        [ "$2" = "gui/$(/usr/bin/id -u)" ] || exit 2`,
      ),
      plutil: stub('plutil', 'echo FakeApp'),
      pgrep: stub('pgrep', 'exit 1'),
    },
  })
  const off = spawnSync(
    '/bin/bash',
    [join(root, 'bin', 'anyengine-off'), '--router-only', '--no-restart'],
    {
      encoding: 'utf8',
      env: {
        HOME: home,
        PATH: '/usr/bin:/bin',
        ANYENGINE_LAUNCHCTL: '/usr/bin/true',
        ANYENGINE_PGREP: '/usr/bin/false',
      },
    },
  )
  assert.equal(off.status, 0, off.stdout + off.stderr)
  assert.match(readFileSync(recoveryCalls, 'utf8'), /print gui\/\d+\/dev\.anyengine\.router/)
  assert.doesNotMatch(readFileSync(recoveryCalls, 'utf8'), /bootout/)
  assert.deepEqual(snapshot(home, WATCHED), m0)
})

test('the shared config: only the top-level non-GPT model line goes, the pick moves, and off puts both back', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const toml = [
    'model = "sonnet"',
    'model_reasoning_effort = "medium"',
    '',
    '[profiles.work]',
    'model = "opus"',
    '',
  ].join('\n')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'config.toml'), toml, { mode: 0o600 })
  chmodSync(join(home, '.codex', 'config.toml'), 0o600)
  const m0 = snapshot(home, WATCHED)
  const early = applySharedConfig(system, root, fakeLib(home), {
    dryRun: true,
    paths: pathsFor(home),
  })
  assert.deepEqual(early.removed, ['model = "sonnet"'], 'a dry run needs no router layer')
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  const dry = applySharedConfig(system, root, fakeLib(home), {
    dryRun: true,
    paths: pathsFor(home),
  })
  assert.deepEqual(dry.removed, ['model = "sonnet"'])
  assert.equal(
    readFileSync(join(home, '.codex', 'config.toml'), 'utf8'),
    toml,
    'a dry run writes nothing',
  )
  system.running = false
  applySharedConfig(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  assert.equal(
    readFileSync(join(home, '.codex', 'config.toml'), 'utf8'),
    toml.replace('model = "sonnet"\n', ''),
  )
  assert.deepEqual(JSON.parse(readFileSync(pathsFor(home).pickFile, 'utf8')), { model: 'sonnet' })
  assert.equal(lstatSync(join(home, '.codex', 'config.toml')).mode & 0o777, 0o600)
  assert.deepEqual(
    applySharedConfig(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) }).wrote,
    [],
    'idempotent',
  )
  applyOffFiles(system, root, { routerOnly: true, paths: pathsFor(home) })
  assert.equal(
    readFileSync(join(home, '.codex', 'config.toml'), 'utf8'),
    toml.replace('model = "sonnet"\n', ''),
    'the line waits for the quit',
  )
  system.running = false
  finishOff(system, root, pathsFor(home))
  assert.deepEqual(snapshot(home, WATCHED), m0)
})

test('off keeps a GPT pick made while M1 was on, puts back a changed Claude pick, never duplicates a key, never reports left-changed', async () => {
  const cases = [
    {
      name: 'a GPT pick while on',
      now: 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n',
      pick: null,
      outcome: 'kept-newer',
      after: 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n',
    },
    {
      name: 'a changed Claude pick',
      now: 'model_reasoning_effort = "high"\n',
      pick: { model: 'opus' },
      outcome: 'restored',
      after: 'model = "opus"\nmodel_reasoning_effort = "high"\n',
    },
  ]
  for (const c of cases) {
    const home = await m0Home()
    const root = join(home, '.anyengine')
    const system = fakeSystem(home)
    applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
    system.running = false
    applySharedConfig(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
    // What the app and codex did while M1 was on (Task 5: a GPT pick clears the adapter's pick).
    writeFileSync(join(home, '.codex', 'config.toml'), c.now)
    if (c.pick) writeFileSync(pathsFor(home).pickFile, JSON.stringify(c.pick))
    else rmSync(pathsFor(home).pickFile, { force: true })
    const off = applyOffFiles(system, root, { routerOnly: true, paths: pathsFor(home) })
    assert.equal(off.ok, true, c.name)
    system.running = false
    const done = finishOff(system, root, pathsFor(home))
    assert.deepEqual(
      done.sharedConfig.map((r) => r.outcome),
      [c.outcome],
      c.name,
    )
    const text = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    assert.equal(text, c.after, c.name)
    assert.deepEqual(duplicateTopLevelKeys(text), [], c.name)
    assert.ok(!existsSync(pathsFor(home).pickFile), c.name)
  }
})

test('the router job is reloaded when the lib changes under it', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  system.calls.length = 0
  applyOnFiles(system, root, fakeLib(home, '0.1.0-m1next'), {
    dryRun: false,
    paths: pathsFor(home),
  })
  assert.ok(
    system.calls.some((c) => /^launchctl kickstart -k gui\/\d+\/dev\.anyengine\.router$/.test(c)),
  )
  assert.equal(
    readLayers(root)
      .layers.find((l) => l.name === 'router')
      ?.changes.find((c) => c.target.endsWith('lib/current'))?.beforeLink,
    '0.1.0-986ab707750e',
    'the rollback target stays M0',
  )
})

test('the models cache is cleaned into the popped router layer', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  const routerDir = readLayers(root).layers.find((l) => l.name === 'router')?.rollbackDir ?? ''
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(
    join(home, '.codex', 'models_cache.json'),
    JSON.stringify({ models: [{ slug: 'opus', description: 'Claude Opus, via AnyEngine' }] }),
  )
  applyOffFiles(system, root, { routerOnly: true, paths: pathsFor(home) })
  assert.ok(existsSync(join(home, '.codex', 'models_cache.json')), 'not before the quit')
  system.running = false
  assert.equal(finishOff(system, root, pathsFor(home)).cacheRemoved, true)
  assert.ok(!existsSync(join(home, '.codex', 'models_cache.json')))
  assert.ok(readdirSync(routerDir).some((name) => name.startsWith('cache-')))
})

for (const state of ['running', 'unknown'] as const) {
  test(`dependent shared config and off cleanup refuse ${state} app`, async () => {
    const home = await m0Home()
    const root = join(home, '.anyengine')
    const plan = fakeLib(home)
    const system = fakeSystem(home)
    const paths = pathsFor(home)
    mkdirSync(paths.codexHome, { recursive: true })
    writeFileSync(join(paths.codexHome, 'config.toml'), 'model = "sonnet"\n')
    applyOnFiles(system, root, plan, { dryRun: false, paths })
    const before = snapshot(home, WATCHED)
    if (state === 'unknown') system.runningError = new Error('unknown app')
    assert.throws(
      () => applySharedConfig(system, root, plan, { dryRun: false, paths }),
      /app|exit|unknown/,
    )
    assert.deepEqual(snapshot(home, WATCHED), before)
    applyOffFiles(system, root, { routerOnly: true, paths })
    const calls = [...system.calls]
    assert.throws(() => finishOff(system, root, paths), /app|exit|unknown/)
    assert.deepEqual(system.calls, calls)
    assert.equal(readLayers(root).layers.at(-1)?.pending, 'after-quit')
  })
}

test('unowned active marked M0 without a complete receipt refuses before artifacts', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  rmSync(join(root, 'rollback-20260930T114234Z'), { recursive: true })
  const plan = fakeLib(home)
  const before = snapshot(home, WATCHED)
  const result = applyOnFiles(fakeSystem(home), root, plan, {
    dryRun: false,
    paths: pathsFor(home),
  })
  assert.match(result.refused ?? '', /M0|baseline|receipt/i)
  assert.deepEqual(snapshot(home, WATCHED), before)
  assert.ok(!existsSync(join(root, 'recovery')))
  assert.ok(!existsSync(enginePaths(root).layers))
})

test('dry-run describes file changes with no recovery/config/job artifacts', async () => {
  const home = await tempDir('anyengine-install-')
  const plan = fakeLib(home)
  const root = join(home, '.anyengine')
  const before = snapshot(home, WATCHED)
  const result = applyOnFiles(fakeSystem(home), root, plan, { dryRun: true, paths: pathsFor(home) })
  assert.ok(result.wrote.includes(join(root, 'lib/current')))
  assert.deepEqual(snapshot(home, WATCHED), before)
  assert.ok(!existsSync(join(root, 'recovery')))
  assert.ok(!existsSync(enginePaths(root).config))
})

test('dry-run previews strict M0 adoption while preserving runtime mode and all receipt artifacts', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const plan = fakeLib(home)
  const system = fakeSystem(home)
  const runtime = join(root, 'runtime.env')
  chmodSync(runtime, 0o644)
  const receipt = join(root, 'rollback-20260930T114234Z')
  const watched = [
    ...WATCHED,
    ...readdirSync(receipt).map((name) => `.anyengine/rollback-20260930T114234Z/${name}`),
  ]
  const before = snapshot(home, watched)
  const entries = readdirSync(root)
  const metadata = [root, receipt, runtime, join(home, '.zshrc')].map((path) => {
    const stat = lstatSync(path)
    return [stat.mode, stat.ino, stat.mtimeMs]
  })
  const result = applyOnFiles(system, root, plan, { dryRun: true, paths: pathsFor(home) })
  assert.equal(result.refused, null)
  assert.equal(result.adoptedFrom, receipt)
  assert.equal(result.wrote.includes(runtime), false)
  assert.equal(result.wrote.includes(join(home, '.zshrc')), false)
  assert.ok(result.unchanged.includes(runtime))
  assert.equal(result.adopted, false, 'preview does not create an adopted layer')
  assert.deepEqual(snapshot(home, watched), before)
  assert.deepEqual(readdirSync(root), entries)
  assert.deepEqual(
    [root, receipt, runtime, join(home, '.zshrc')].map((path) => {
      const stat = lstatSync(path)
      return [stat.mode, stat.ino, stat.mtimeMs]
    }),
    metadata,
  )
  assert.deepEqual(readLayers(root).layers, [])
  assert.equal(system.jobs.size, 0)
  assert.equal(
    system.calls.some((call) => /bootstrap|bootout|kickstart|quitApp|openApp/.test(call)),
    false,
  )
  assert.equal(existsSync(join(root, 'recovery')), false)
  assert.equal(existsSync(join(root, 'logs')), false)
})

for (const defect of ['half', 'conflicting', 'invalid', 'absent', 'runtime-absent'])
  test(`dry-run refuses unsafe M0 adoption before artifacts: ${defect}`, async () => {
    const home = await m0Home()
    const root = join(home, '.anyengine')
    const plan = fakeLib(home)
    const receipt = join(root, 'rollback-20260930T114234Z')
    if (defect === 'half')
      writeFileSync(join(home, 'bin/codex'), readFileSync(join(receipt, '01-codex.bak')))
    if (defect === 'conflicting') {
      const other = join(root, 'rollback-20260930T114235Z')
      cpSync(receipt, other, { recursive: true })
      const manifest = JSON.parse(readFileSync(join(other, 'manifest.json'), 'utf8'))
      const rc = manifest.entries.find(
        (entry: { target: string }) => entry.target === join(home, '.zshrc'),
      )
      assert.ok(rc)
      writeFileSync(join(other, rc.backup), '# distinct valid off baseline\n')
    }
    if (defect === 'invalid') writeFileSync(join(receipt, 'manifest.json'), '{bad')
    if (defect === 'absent') rmSync(receipt, { recursive: true })
    if (defect === 'runtime-absent') rmSync(join(root, 'runtime.env'))
    const before = snapshot(home, WATCHED)
    const entries = readdirSync(root)
    const system = fakeSystem(home)
    const result = applyOnFiles(system, root, plan, { dryRun: true, paths: pathsFor(home) })
    assert.match(result.refused ?? '', /M0|receipt|baseline|evidence/)
    assert.deepEqual(result.wrote, [])
    assert.deepEqual(snapshot(home, WATCHED), before)
    assert.deepEqual(readdirSync(root), entries)
    assert.equal(system.jobs.size, 0)
    assert.equal(existsSync(join(root, 'recovery')), false)
    assert.equal(existsSync(enginePaths(root).layers), false)
  })

test('launchd plists escape XML paths, keep the environment explicit and schedule smoke correctly', () => {
  const input = {
    root: "/tmp/a & <b>' root",
    launcher: "/tmp/a & <b>' launch",
    node: '/tmp/node',
    pathDirs: ['/tmp/bin'],
    log: '/tmp/log',
  }
  const router = routerPlist(input)
  assert.match(router, /a &amp; &lt;b&gt;' launch/)
  assert.match(router, /a &amp; &lt;b&gt;' root/)
  assert.throws(() => routerPlist({ ...input, root: 'relative/root' }), /absolute path/)
  assert.throws(() => routerPlist({ ...input, root: '/tmp/\u0000root' }), /invalid XML/)
  assert.match(router, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(router, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(router, /<string>\/tmp\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/)
  const smoke = smokePlist({ ...input, hour: 3, minute: 30, watchPaths: ['/tmp/watch'] })
  assert.match(smoke, /<key>RunAtLoad<\/key>\s*<false\/>/)
  assert.match(smoke, /<key>Hour<\/key>\s*<integer>3<\/integer>/)
  assert.match(smoke, /<key>Minute<\/key>\s*<integer>30<\/integer>/)
  assert.match(smoke, /<key>WatchPaths<\/key>\s*<array><string>\/tmp\/watch<\/string>/)
  assert.match(smoke, /--scheduled/)
  assert.doesNotMatch(smoke, /KeepAlive|proxy|NODE_TLS|NODE_EXTRA/)
})

test('both installed jobs execute the actual launcher in the chosen custom root', async () => {
  const home = await tempDir('anyengine-custom-root-')
  const initial = fakeLib(home)
  const root = join(home, "custom & <root>'")
  const libDir = join(root, 'lib', initial.version)
  mkdirSync(dirname(libDir), { recursive: true })
  cpSync(initial.libDir, libDir, { recursive: true })
  const plan = {
    ...initial,
    libDir,
    shimSource: join(libDir, 'scripts/codex-shim'),
    launcherSource: join(libDir, 'scripts/anyengine-launch'),
  }
  writeFileSync(plan.launcherSource, readFileSync('scripts/anyengine-launch'))
  mkdirSync(join(libDir, 'dist/src'), { recursive: true })
  writeFileSync(
    join(libDir, 'dist/src/adapter.mjs'),
    'console.log(JSON.stringify({root: process.env.ANYENGINE_ROOT, argv: process.argv.slice(2)}))\n',
  )
  const untouched = ['.anyengine/runtime.env', '.anyengine/lib/current', '.anyengine/config.json']
  const before = snapshot(home, untouched)
  applyOnFiles(fakeSystem(home), root, plan, { dryRun: false, paths: pathsFor(home) })
  const terminal = spawnSync('/bin/bash', ['-c', '. "$HOME/.zshrc"; anyengine status'], {
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  })
  assert.equal(terminal.status, 0, terminal.stderr)
  assert.deepEqual(JSON.parse(terminal.stdout), { root, argv: ['status'] })
  for (const [label, args] of [
    ['router', ['router']],
    ['smoke', ['smoke', '--scheduled', '--notify']],
  ] as const) {
    const plist = join(home, `Library/LaunchAgents/dev.anyengine.${label}.plist`)
    const decoded = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], {
      encoding: 'utf8',
    })
    assert.equal(decoded.status, 0, decoded.stderr)
    const job = JSON.parse(decoded.stdout)
    const run = spawnSync(job.ProgramArguments[0], job.ProgramArguments.slice(1), {
      env: { HOME: home, ...job.EnvironmentVariables },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(JSON.parse(run.stdout), { root, argv: args })
  }
  assert.deepEqual(snapshot(home, untouched), before)
})

test('launchctl reload waits for acknowledged bootout to finish before bootstrap', () => {
  const system = fakeSystem('/tmp/hermetic-home')
  system.running = false
  const label = 'dev.anyengine.router'
  system.jobs.set(label, { plist: '/tmp/router.plist', pid: 1 })
  const original = system.launchctl
  let retiring = false
  let waits = 0
  system.exec = (command, args) => {
    assert.equal(command, '/bin/sleep')
    assert.deepEqual(args, ['0.5'])
    if (++waits === 25) system.jobs.delete(label)
    return { status: 0, stdout: '', stderr: '' }
  }
  system.launchctl = (args) => {
    if (args[0] === 'print' && args[1] === `gui/${process.getuid?.() ?? 0}`)
      return { status: 0, stdout: 'domain', stderr: '' }
    if (args[0] === 'bootout') {
      retiring = true
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'bootstrap') assert.equal(system.jobs.has(label), false)
    if (args[0] === 'print' && retiring && !system.jobs.has(label))
      return {
        status: 113,
        stdout: '',
        stderr: `Bad request.\nCould not find service "${label}" in domain for user gui: ${process.getuid?.() ?? 0}\n`,
      }
    return original(args)
  }
  loadJob(system, label, '/tmp/router.plist')
  assert.equal(waits, 25)
})

for (const verb of ['print', 'bootout', 'bootstrap', 'kickstart'] as const) {
  test(`launchctl ${verb} unknown/failure never masquerades as success`, () => {
    const system = fakeSystem('/tmp/hermetic-home')
    system.running = false
    const target = `gui/${process.getuid?.() ?? 0}/dev.anyengine.router`
    system.jobs.set('dev.anyengine.router', { plist: '/tmp/router.plist', pid: 1 })
    const args =
      verb === 'bootstrap'
        ? ['bootstrap', `gui/${process.getuid?.() ?? 0}`, '/tmp/router.plist']
        : verb === 'kickstart'
          ? ['kickstart', '-k', target]
          : [verb, target]
    system.execs.set(`launchctl ${args.join(' ')}`, {
      status: null,
      stdout: '',
      stderr: 'unknown failure',
    })
    assert.throws(
      () =>
        verb === 'print'
          ? jobLoaded(system, 'dev.anyengine.router')
          : verb === 'bootout'
            ? unloadJob(system, 'dev.anyengine.router')
            : verb === 'bootstrap'
              ? loadJob(system, 'dev.anyengine.router', '/tmp/router.plist')
              : reloadJob(system, 'dev.anyengine.router'),
      /launchctl|unknown|fail/,
    )
  })
}

test('finishOff retains pending evidence and shared files on bootout status zero with error stderr', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const paths = pathsFor(home)
  const system = fakeSystem(home)
  const plan = fakeLib(home)
  applyOnFiles(system, root, plan, { dryRun: false, paths })
  system.running = false
  applySharedConfig(system, root, plan, { dryRun: false, paths })
  const cache = join(paths.codexHome, 'models_cache.json')
  writeFileSync(
    cache,
    JSON.stringify({ models: [{ slug: 'opus', description: 'Claude Opus, via AnyEngine' }] }),
  )
  applyOffFiles(system, root, { routerOnly: true, paths })
  const watched = [
    enginePaths(root).layers,
    join(paths.codexHome, 'config.toml'),
    paths.pickFile,
    cache,
  ]
  const before = watched.map((path) => readFileSync(path))
  system.execs.set(`launchctl bootout gui/${process.getuid?.() ?? 0}/dev.anyengine.router`, {
    status: 0,
    stdout: '',
    stderr: 'failed to unload service',
  })
  assert.throws(() => finishOff(system, root, paths), /bootout|failed/)
  assert.deepEqual(
    watched.map((path) => readFileSync(path)),
    before,
  )
  assert.equal(readLayers(root).layers.at(-1)?.pending, 'after-quit')
  assert.ok(system.jobs.has('dev.anyengine.router'))
  assert.ok(existsSync(join(root, 'recovery/anyengine-off')))
  system.execs.clear()
  assert.equal(finishOff(system, root, paths).cacheRemoved, true)
  assert.deepEqual(
    readLayers(root).layers.map((layer) => layer.name),
    ['adapter'],
  )
})

test('direct shared restore refuses running/unknown app, invalid TOML/pick and actual write failure', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const paths = pathsFor(home)
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths })
  system.running = false
  applySharedConfig(system, root, fakeLib(home), { dryRun: false, paths })
  const record = readLayers(root).layers.find((layer) => layer.name === 'router')?.sharedConfig
  assert.ok(record)
  const before = readFileSync(record.target)
  for (const state of ['running', 'unknown']) {
    system.running = true
    system.runningError = state === 'unknown' ? new Error('unknown app') : null
    assert.throws(() => restoreSharedConfig(record, system), /app|exit|unknown/)
    assert.deepEqual(readFileSync(record.target), before)
    assert.ok(existsSync(record.pickFile))
  }
  system.running = false
  system.runningError = null
  writeFileSync(record.target, 'model = "gpt-a"\nmodel = "gpt-b"\n')
  assert.throws(() => restoreSharedConfig(record, system), /duplicate|TOML|key/i)
  writeFileSync(record.target, before)
  const bad = Buffer.concat([Buffer.from('{"model":"'), Buffer.from([0xff]), Buffer.from('"}')])
  writeFileSync(record.pickFile, bad)
  assert.throws(() => restoreSharedConfig(record, system), /invalid|evidence/i)
  assert.deepEqual(readFileSync(record.pickFile), bad)
  writeFileSync(record.pickFile, '{"model":"�","future":{"keep":true}}')
  const restored = restoreSharedConfig(record, system)
  assert.equal(restored[0]?.outcome, 'restored')
  assert.match(readFileSync(record.target, 'utf8'), /�/)
  assert.deepEqual(JSON.parse(readFileSync(record.pickFile, 'utf8')), { future: { keep: true } })
  rmSync(record.target)
  mkdirSync(record.target)
  assert.throws(() => restoreSharedConfig(record, system), /regular|file|EISDIR/i)
  assert.ok(existsSync(enginePaths(root).layers))
})

test('failed bootout retains pending evidence; retry succeeds without replacing partial cache backups', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const paths = pathsFor(home)
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths })
  const dir = readLayers(root).layers.find((layer) => layer.name === 'router')?.rollbackDir
  assert.ok(dir)
  mkdirSync(join(dir, 'cache-old'))
  writeFileSync(join(dir, 'cache-old/models_cache.json'), 'partial evidence')
  writeFileSync(
    join(paths.codexHome, 'models_cache.json'),
    JSON.stringify({ models: [{ slug: 'opus', description: 'Claude Opus, via AnyEngine' }] }),
  )
  applyOffFiles(system, root, { routerOnly: true, paths })
  system.running = false
  system.execs.set(`launchctl bootout gui/${process.getuid?.() ?? 0}/dev.anyengine.router`, {
    status: 9,
    stdout: '',
    stderr: 'cannot unload',
  })
  assert.throws(() => finishOff(system, root, paths), /bootout|failed/)
  assert.equal(readLayers(root).layers.at(-1)?.pending, 'after-quit')
  assert.ok(existsSync(join(paths.codexHome, 'models_cache.json')))
  system.execs.clear()
  assert.equal(finishOff(system, root, paths).cacheRemoved, true)
  assert.equal(readFileSync(join(dir, 'cache-old/models_cache.json'), 'utf8'), 'partial evidence')
  assert.equal(readdirSync(dir).filter((name) => name.startsWith('cache-')).length, 2)
})

test('on honors disabled smoke and preserves unknown settings; invalid JSON refuses without recovery artifacts', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const plan = fakeLib(home)
  const config = structuredClone(DEFAULT_CONFIG)
  config.smoke.enabled = false
  writeFileSync(enginePaths(root).config, JSON.stringify({ ...config, future: { keep: true } }))
  const system = fakeSystem(home)
  applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
  assert.ok(!system.jobs.has('dev.anyengine.smoke'))
  assert.ok(!existsSync(join(home, 'Library/LaunchAgents/dev.anyengine.smoke.plist')))
  assert.deepEqual(JSON.parse(readFileSync(enginePaths(root).config, 'utf8')).future, {
    keep: true,
  })
  const fresh = await tempDir('anyengine-install-')
  const freshPlan = fakeLib(fresh)
  const badRoot = join(fresh, '.anyengine')
  const bytes = Buffer.concat([Buffer.from('{"future":"'), Buffer.from([0xff]), Buffer.from('"}')])
  writeFileSync(enginePaths(badRoot).config, bytes)
  assert.throws(
    () =>
      applyOnFiles(fakeSystem(fresh), badRoot, freshPlan, {
        dryRun: false,
        paths: pathsFor(fresh),
      }),
    /UTF|invalid/i,
  )
  assert.deepEqual(readFileSync(enginePaths(badRoot).config), bytes)
  assert.ok(!existsSync(join(badRoot, 'recovery')))
})

function smokePreference(root: string, enabled: boolean): void {
  const path = enginePaths(root).config
  const config = JSON.parse(readFileSync(path, 'utf8'))
  config.smoke.enabled = enabled
  writeFileSync(path, JSON.stringify(config))
}

test('owned smoke disabled and reenabled at the same lib keeps last-good and original off baselines', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const paths = pathsFor(home)
  const plan = fakeLib(home)
  const system = fakeSystem(home)
  const before = snapshot(home, WATCHED)
  applyOnFiles(system, root, plan, { dryRun: false, paths })
  const plist = join(home, 'Library/LaunchAgents/dev.anyengine.smoke.plist')
  const enabled = readFileSync(plist)
  system.running = false
  smokePreference(root, false)
  const result = applyOnFiles(system, root, plan, { dryRun: false, paths })
  assert.equal(result.refused, null)
  assert.ok(result.wrote.includes(plist))
  assert.equal(system.jobs.has('dev.anyengine.smoke'), false)
  assert.equal(existsSync(plist), false)
  let router = readLayers(root).layers.at(-1)
  assert.ok(router?.upgrade)
  let smoke = router.changes.find((change) => change.target === plist)
  assert.equal(smoke?.before, 'absent')
  assert.equal(smoke?.afterSha, null)
  assert.equal(smoke?.pending, null)
  assert.ok(smoke?.lastGood?.sha)
  assert.ok(router.jobs.includes('dev.anyengine.smoke'))
  assert.ok(readLayers(root).recovery?.pinnedLibs.includes(plan.libDir))
  assert.ok(existsSync(join(root, 'recovery/anyengine-off')))
  const checkpoint = structuredClone(router.upgrade)
  assert.equal(applyOnFiles(system, root, plan, { dryRun: false, paths }).wrote.length, 0)
  smokePreference(root, true)
  applyOnFiles(system, root, plan, { dryRun: false, paths })
  assert.equal(system.jobs.has('dev.anyengine.smoke'), true)
  assert.deepEqual(readFileSync(plist), enabled)
  router = readLayers(root).layers.at(-1)
  assert.deepEqual(router?.upgrade, checkpoint)
  smoke = router?.changes.find((change) => change.target === plist)
  assert.equal(smoke?.before, 'absent')
  applyOffFiles(system, root, { routerOnly: true, paths })
  finishOff(system, root, paths)
  assert.deepEqual(snapshot(home, WATCHED), before)
  applyOffFiles(system, root, { routerOnly: false, paths })
  finishOff(system, root, paths)
  for (const [target, backup] of [
    ['.zshrc', '00-.zshrc.bak'],
    ['bin/codex', '01-codex.bak'],
    ['.anyengine/runtime.env', '02-runtime.env.bak'],
  ] as const)
    assert.deepEqual(
      readFileSync(join(home, target)),
      readFileSync(join(root, 'rollback-20260930T114234Z', backup)),
    )
})

for (const state of ['running', 'unknown', 'bootout'] as const) {
  test(`owned smoke disable ${state} refusal retains targets, ownership and recovery for retry`, async () => {
    const home = await m0Home()
    const root = join(home, '.anyengine')
    const paths = pathsFor(home)
    const plan = fakeLib(home)
    const system = fakeSystem(home)
    applyOnFiles(system, root, plan, { dryRun: false, paths })
    smokePreference(root, false)
    system.running = state === 'running'
    if (state === 'unknown') system.runningError = new Error('app state unknown')
    if (state === 'bootout')
      system.execs.set(`launchctl bootout gui/${process.getuid?.() ?? 0}/dev.anyengine.smoke`, {
        status: 9,
        stdout: '',
        stderr: 'cannot unload smoke',
      })
    const before = snapshot(home, WATCHED)
    assert.throws(
      () => applyOnFiles(system, root, plan, { dryRun: false, paths }),
      /exit|unknown|bootout|failed/,
    )
    assert.deepEqual(snapshot(home, WATCHED), before)
    assert.ok(system.jobs.has('dev.anyengine.smoke'))
    assert.ok(readLayers(root).layers.at(-1)?.jobs.includes('dev.anyengine.smoke'))
    assert.ok(existsSync(join(root, 'recovery/anyengine-off')))
    system.running = false
    system.runningError = null
    system.execs.clear()
    applyOnFiles(system, root, plan, { dryRun: false, paths })
    assert.equal(system.jobs.has('dev.anyengine.smoke'), false)
    assert.equal(existsSync(join(home, 'Library/LaunchAgents/dev.anyengine.smoke.plist')), false)
  })
}

for (const failure of ['publication', 'deletion'] as const) {
  test(`owned smoke disable actual ${failure} failure retains recoverable bytes and supports retry`, async () => {
    const home = await m0Home()
    const root = join(home, '.anyengine')
    const paths = pathsFor(home)
    const plan = fakeLib(home)
    const system = fakeSystem(home)
    applyOnFiles(system, root, plan, { dryRun: false, paths })
    system.running = false
    smokePreference(root, false)
    const plist = join(home, 'Library/LaunchAgents/dev.anyengine.smoke.plist')
    const before = readFileSync(plist)
    const blocked = failure === 'publication' ? join(root, 'recovery') : dirname(plist)
    chmodSync(blocked, 0o500)
    try {
      assert.throws(
        () => applyOnFiles(system, root, plan, { dryRun: false, paths }),
        /EACCES|EPERM|permission/i,
      )
      assert.deepEqual(readFileSync(plist), before)
      const router = readLayers(root).layers.at(-1)
      assert.ok(router)
      assert.ok(router?.jobs.includes('dev.anyengine.smoke'))
      assert.ok(existsSync(join(root, 'recovery/anyengine-off')))
      if (failure === 'deletion') {
        const smoke = router.changes.find((change) => change.target === plist)
        assert.equal(smoke?.pending?.kind, 'absent')
        assert.ok(smoke?.afterSha)
        assert.ok(smoke?.lastGood?.sha)
        assert.equal(system.jobs.has('dev.anyengine.smoke'), false)
      } else assert.ok(system.jobs.has('dev.anyengine.smoke'))
    } finally {
      chmodSync(blocked, 0o700)
    }
    if (failure === 'deletion') {
      const router = readLayers(root).layers.at(-1)
      assert.ok(router?.upgrade)
      for (const change of [...router.changes].reverse())
        assert.notEqual(
          restoreChange(change, router.rollbackDir, true, 'last-good').outcome,
          'left-changed',
        )
      loadJob(system, 'dev.anyengine.smoke', plist)
      new LayerWriter(root, router, 'router', 'recovered-smoke').finishUpgrade('recovered')
      assert.equal(readlinkSync(join(root, 'lib/current')), plan.version)
    }
    applyOnFiles(system, root, plan, { dryRun: false, paths })
    assert.equal(existsSync(plist), false)
    assert.equal(system.jobs.has('dev.anyengine.smoke'), false)
  })
}

for (const invalid of ['owner', 'bytes', 'config', 'launchctl'] as const) {
  test(`owned smoke disable refuses unknown ${invalid} without target or job mutation`, async () => {
    const home = await m0Home()
    const root = join(home, '.anyengine')
    const plan = fakeLib(home)
    const system = fakeSystem(home)
    applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
    system.running = false
    smokePreference(root, false)
    if (invalid === 'owner') {
      const file = readLayers(root)
      const router = file.layers.at(-1)
      assert.ok(router)
      router.jobs = router.jobs.filter((label) => label !== 'dev.anyengine.smoke')
      writeLayers(root, file)
    } else if (invalid === 'bytes')
      writeFileSync(join(home, 'Library/LaunchAgents/dev.anyengine.smoke.plist'), 'foreign edit')
    else if (invalid === 'config') writeFileSync(enginePaths(root).config, Buffer.from([0xff]))
    else
      system.execs.set(`launchctl print gui/${process.getuid?.() ?? 0}/dev.anyengine.smoke`, {
        status: null,
        stdout: '',
        stderr: 'unknown launchctl',
      })
    const before = snapshot(home, [
      ...WATCHED,
      '.anyengine/config.json',
      '.anyengine/state/layers.json',
    ])
    system.calls.length = 0
    assert.throws(
      () => applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) }),
      /ownership|changed|invalid|launchctl/i,
    )
    assert.deepEqual(
      snapshot(home, [...WATCHED, '.anyengine/config.json', '.anyengine/state/layers.json']),
      before,
    )
    assert.ok(system.jobs.has('dev.anyengine.smoke'))
    assert.ok(!system.calls.some((call) => /bootout|bootstrap|kickstart/.test(call)))
  })
}

for (const state of ['running', 'unknown']) {
  test(`owned smoke re-enable ${state} refusal preserves disabled files and recovery`, async () => {
    const home = await m0Home()
    const root = join(home, '.anyengine')
    const plan = fakeLib(home)
    const system = fakeSystem(home)
    const paths = pathsFor(home)
    applyOnFiles(system, root, plan, { dryRun: false, paths })
    system.running = false
    smokePreference(root, false)
    applyOnFiles(system, root, plan, { dryRun: false, paths })
    smokePreference(root, true)
    system.running = state === 'running'
    if (state === 'unknown') system.runningError = new Error('app unknown')
    const before = snapshot(home, [...WATCHED, '.anyengine/state/layers.json'])
    assert.throws(() => applyOnFiles(system, root, plan, { dryRun: false, paths }), /exit|unknown/)
    assert.deepEqual(snapshot(home, [...WATCHED, '.anyengine/state/layers.json']), before)
    assert.equal(system.jobs.has('dev.anyengine.smoke'), false)
    system.running = false
    system.runningError = null
    applyOnFiles(system, root, plan, { dryRun: false, paths })
    assert.equal(system.jobs.has('dev.anyengine.smoke'), true)
  })
}

test('shared config preserves multiline/quoted TOML bytes and restores absent config without duplicate keys', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const plan = fakeLib(home)
  const paths = pathsFor(home)
  const text =
    'note = """literal\r\nmodel = "opus"\r\n"""\r\n"model" = """\r\nsonnet""" # chosen\r\n[[projects]]\r\nmodel = "opus"\r\n'
  writeFileSync(join(paths.codexHome, 'config.toml'), text)
  applyOnFiles(system, root, plan, { dryRun: false, paths })
  system.running = false
  applySharedConfig(system, root, plan, { dryRun: false, paths })
  assert.equal(
    readFileSync(join(paths.codexHome, 'config.toml'), 'utf8'),
    text.replace('"model" = """\r\nsonnet""" # chosen\r\n', ''),
  )
  applyOffFiles(system, root, { routerOnly: true, paths })
  system.running = false
  finishOff(system, root, paths)
  assert.equal(readFileSync(join(paths.codexHome, 'config.toml'), 'utf8'), text)
})

test('last-good checkpoint survives failed M1 reload and differs from router-only initial rollback', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const paths = pathsFor(home)
  const old = fakeLib(home)
  applyOnFiles(system, root, old, { dryRun: false, paths })
  const next = fakeLib(home, 'm1-next')
  system.execs.set(`launchctl kickstart -k gui/${process.getuid?.() ?? 0}/dev.anyengine.router`, {
    status: 9,
    stdout: '',
    stderr: 'failed reload',
  })
  assert.throws(
    () => applyOnFiles(system, root, next, { dryRun: false, paths }),
    /kickstart|failed/,
  )
  const layer = readLayers(root).layers.find((row) => row.name === 'router')
  assert.ok(layer?.upgrade)
  const current = layer.changes.find((change) => change.target === join(root, 'lib/current'))
  assert.equal(current?.beforeLink, '0.1.0-986ab707750e')
  assert.equal(current?.lastGood?.link, old.version)
  assert.ok(readLayers(root).recovery?.pinnedLibs.includes(old.libDir))
  assert.ok(readLayers(root).recovery?.pinnedLibs.includes(next.libDir))
  for (const change of [...layer.changes].reverse())
    restoreChange(change, layer.rollbackDir, true, 'last-good')
  assert.equal(readlinkSync(join(root, 'lib/current')), old.version)
  new LayerWriter(root, layer, 'router', 'finish').finishUpgrade('recovered')
  applyOffFiles(system, root, { routerOnly: true, paths })
  assert.equal(readlinkSync(join(root, 'lib/current')), '0.1.0-986ab707750e')
})

test('unknown later public recovery edit retains terminal journal and original baseline', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const paths = pathsFor(home)
  const publicPath = join(root, 'bin/anyengine-off')
  mkdirSync(dirname(publicPath), { recursive: true })
  writeFileSync(publicPath, 'original public entry', { mode: 0o640 })
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths })
  applyOffFiles(system, root, { routerOnly: false, paths })
  assert.equal(readFileSync(publicPath, 'utf8'), 'original public entry')
  writeFileSync(publicPath, 'later user edit')
  system.running = false
  assert.throws(() => finishOff(system, root, paths), /changed|public|recovery/i)
  assert.equal(readFileSync(publicPath, 'utf8'), 'later user edit')
  assert.ok(existsSync(enginePaths(root).layers))
})

test('on/off refuse invalid journal, pick and TOML bytes before changing install files', async () => {
  for (const input of ['journal', 'pick', 'toml']) {
    const home = await m0Home()
    const root = join(home, '.anyengine')
    const system = fakeSystem(home)
    const paths = pathsFor(home)
    const plan = fakeLib(home)
    applyOnFiles(system, root, plan, { dryRun: false, paths })
    const path =
      input === 'journal'
        ? enginePaths(root).layers
        : input === 'pick'
          ? paths.pickFile
          : join(paths.codexHome, 'config.toml')
    mkdirSync(dirname(path), { recursive: true })
    const bad =
      input === 'toml'
        ? Buffer.from('model="a"\nmodel="b"\n')
        : Buffer.concat([Buffer.from('{"model":"'), Buffer.from([0xff]), Buffer.from('"}')])
    writeFileSync(path, bad)
    const before = snapshot(home, WATCHED)
    assert.throws(
      () => applyOnFiles(system, root, plan, { dryRun: false, paths }),
      /invalid|UTF|key|TOML|recovery/i,
    )
    assert.throws(
      () => applyOffFiles(system, root, { routerOnly: true, paths }),
      /invalid|UTF|key|TOML|recovery/i,
    )
    assert.deepEqual(snapshot(home, WATCHED), before)
    assert.deepEqual(readFileSync(path), bad)
  }
})

test('all-POPPED journal finishes public retirement and preserves private recovery; absent is inert', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const paths = pathsFor(home)
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths })
  applyOffFiles(system, root, { routerOnly: false, paths })
  for (const layer of readLayers(root).layers) writeFileSync(join(layer.rollbackDir, 'POPPED'), '')
  assert.deepEqual(readLayers(root).layers, [])
  system.running = false
  finishOff(system, root, paths)
  assert.ok(!existsSync(enginePaths(root).layers))
  assert.ok(existsSync(join(root, 'recovery/anyengine-off')))
  assert.ok(existsSync(join(root, 'RECOVER.txt')))
  assert.deepEqual(finishOff(system, root, paths), {
    bootedOut: [],
    sharedConfig: [],
    cacheRemoved: false,
  })
})

test('quoted home paths and original public symlink round-trip; recovery forwarder passes Bash 3.2 syntax', async () => {
  const base = await tempDir('anyengine-install-')
  const home = join(base, "space and user's home")
  mkdirSync(home)
  const root = join(home, '.anyengine')
  const plan = fakeLib(home)
  const publicPath = join(root, 'bin/anyengine-off')
  mkdirSync(dirname(publicPath), { recursive: true })
  symlinkSync("old user's entry", publicPath)
  const system = fakeSystem(home)
  const before = snapshot(home, WATCHED)
  applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
  for (const path of [publicPath, join(root, 'recovery/anyengine-off')]) {
    const syntax = spawnSync('/bin/bash', ['-n', path], { encoding: 'utf8' })
    assert.equal(syntax.status, 0, syntax.stderr)
  }
  const plist = spawnSync(
    '/usr/bin/plutil',
    ['-lint', join(home, 'Library/LaunchAgents/dev.anyengine.router.plist')],
    { encoding: 'utf8' },
  )
  assert.equal(plist.status, 0, plist.stdout + plist.stderr)
  applyOffFiles(system, root, { routerOnly: false, paths: pathsFor(home) })
  system.running = false
  finishOff(system, root, pathsFor(home))
  assert.deepEqual(snapshot(home, WATCHED), before)
  assert.equal(readlinkSync(publicPath), "old user's entry")
})

for (const state of ['unknown-absence', 'failed-domain', 'running-unload'] as const) {
  test(`launchctl ${state} is a refusal`, () => {
    const system = fakeSystem('/tmp/hermetic-home')
    const label = 'dev.anyengine.router'
    if (state === 'unknown-absence') {
      system.launchctl = () => ({ status: 113, stdout: '', stderr: '' })
    } else if (state === 'failed-domain') {
      system.execs.set(`launchctl print gui/${process.getuid?.() ?? 0}`, {
        status: 1,
        stdout: '',
        stderr: 'cannot inspect domain',
      })
    } else {
      system.jobs.set(label, { plist: '/tmp/a', pid: 1 })
      assert.throws(() => unloadJob(system, label), /app|exit/)
      assert.ok(!system.calls.some((call) => call.includes('bootout')))
      return
    }
    assert.throws(() => jobLoaded(system, label), /failed|launchctl/)
  })
}

test('initial admission supports inactive marked/unmarked controls and refuses unsupported shells', async () => {
  for (const marked of [false, true]) {
    const home = await tempDir('anyengine-install-')
    const plan = fakeLib(home)
    const root = join(home, '.anyengine')
    mkdirSync(join(home, 'bin'), { recursive: true })
    writeFileSync(
      join(home, 'bin/codex'),
      marked ? '# (marker: ANYENGINE_ADAPTER) off shim\n' : 'old unmarked shim\n',
    )
    const system = fakeSystem(home)
    const result = applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
    assert.equal(result.refused, null)
    applyOffFiles(system, root, { routerOnly: false, paths: pathsFor(home) })
    system.running = false
    finishOff(system, root, pathsFor(home))
    assert.equal(
      readFileSync(join(home, 'bin/codex'), 'utf8'),
      marked ? '# (marker: ANYENGINE_ADAPTER) off shim\n' : 'old unmarked shim\n',
    )
  }
  const shell = process.env.SHELL
  try {
    process.env.SHELL = '/bin/fish'
    const home = await tempDir('anyengine-install-')
    const plan = fakeLib(home)
    const result = applyOnFiles(fakeSystem(home), join(home, '.anyengine'), plan, {
      dryRun: false,
      paths: pathsFor(home),
    })
    assert.match(result.refused ?? '', /shell/)
    assert.ok(!existsSync(join(home, '.anyengine/recovery')))
  } finally {
    if (shell === undefined) delete process.env.SHELL
    else process.env.SHELL = shell
  }
})

test('shared restore handles a missing config and reports actual publication failure without clearing pick', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const plan = fakeLib(home)
  const paths = pathsFor(home)
  applyOnFiles(system, root, plan, { dryRun: false, paths })
  system.running = false
  applySharedConfig(system, root, plan, { dryRun: false, paths })
  const record = readLayers(root).layers.find((layer) => layer.name === 'router')?.sharedConfig
  assert.ok(record)
  rmSync(record.target)
  assert.equal(restoreSharedConfig(record, system)[0]?.outcome, 'restored')
  assert.match(readFileSync(record.target, 'utf8'), /model = "sonnet"/)
  rmSync(record.target)
  mkdirSync(record.target)
  writeFileSync(record.pickFile, '{"model":"opus"}')
  assert.throws(() => restoreSharedConfig(record, system), /regular|EISDIR|file/i)
  assert.equal(readFileSync(record.pickFile, 'utf8'), '{"model":"opus"}')
  assert.ok(existsSync(enginePaths(root).layers))
})

test('absent finishOff is inert even with unknown app; prepared empty journal retires only proven absent public state', async () => {
  const home = await tempDir('anyengine-install-')
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  system.runningError = new Error('unknown app')
  assert.deepEqual(finishOff(system, root, pathsFor(home)), {
    bootedOut: [],
    sharedConfig: [],
    cacheRemoved: false,
  })
  publishRecovery({
    root,
    app: system.app,
    bundleId: 'com.openai.codex',
    codexHome: pathsFor(home).codexHome,
  })
  writeLayers(root, {
    version: 1,
    layers: [],
    recovery: { entry: join(root, 'recovery/anyengine-off'), controlLib: root, pinnedLibs: [root] },
  })
  system.runningError = null
  system.running = false
  finishOff(system, root, pathsFor(home))
  assert.ok(!existsSync(enginePaths(root).layers))
  assert.ok(existsSync(join(root, 'recovery/anyengine-off')))
})

test('actual config publication error keeps pick and pending recovery, then succeeds on a writable retry', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const paths = pathsFor(home)
  const plan = fakeLib(home)
  applyOnFiles(system, root, plan, { dryRun: false, paths })
  system.running = false
  applySharedConfig(system, root, plan, { dryRun: false, paths })
  const record = readLayers(root).layers.find((layer) => layer.name === 'router')?.sharedConfig
  assert.ok(record)
  const before = readFileSync(record.target)
  const pick = readFileSync(record.pickFile)
  chmodSync(paths.codexHome, 0o500)
  try {
    assert.throws(() => restoreSharedConfig(record, system), /EACCES|EPERM|permission/i)
    assert.deepEqual(readFileSync(record.target), before)
    assert.deepEqual(readFileSync(record.pickFile), pick)
    assert.ok(existsSync(enginePaths(root).layers))
  } finally {
    chmodSync(paths.codexHome, 0o700)
  }
  assert.equal(restoreSharedConfig(record, system)[0]?.outcome, 'restored')
})

test('preexisting identical public forwarder is journaled as the original baseline and survives full off', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const paths = pathsFor(home)
  const publicPath = join(root, 'bin/anyengine-off')
  mkdirSync(dirname(publicPath), { recursive: true })
  writeFileSync(publicPath, publicRecoveryScript(root), { mode: 0o755 })
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths })
  assert.ok(readLayers(root).layers[0]?.changes.some((change) => change.target === publicPath))
  applyOffFiles(system, root, { routerOnly: false, paths })
  system.running = false
  finishOff(system, root, paths)
  assert.equal(readFileSync(publicPath, 'utf8'), publicRecoveryScript(root))
})
