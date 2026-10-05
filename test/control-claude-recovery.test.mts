import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { applyClaudeLayer } from '../src/control-claude-layer.mjs'
import { applyOffFiles, applyOnFiles } from '../src/control-install.mjs'
import { LayerWriter, readLayers } from '../src/control-layers.mjs'
import { prepareM2Upgrade, retainedM2Libraries } from '../src/control-m2-upgrade.mjs'
import { publishRecovery, shellQuote } from '../src/control-scripts.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { fakeLib, m0Home, pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
async function fixture(withM2 = false) {
  const home = await m0Home(),
    root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const launch = system.launchctl
  system.launchctl = (args) => {
    const result = launch(args)
    if (args[0] === 'print' && args[1] === `gui/${process.getuid?.() ?? 0}`)
      return { status: 0, stdout: 'domain', stderr: '' }
    if (args[0] === 'print' && result.status === 113)
      return {
        ...result,
        stderr: `Bad request.\nCould not find service "${args[1]?.split('/').at(-1)}" in domain for user gui: ${process.getuid?.() ?? 0}\n`,
      }
    return result
  }
  let plan = fakeLib(home)
  applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
  const m1Lib = plan.libDir
  let baseline: ReturnType<typeof prepareM2Upgrade> | null = null
  if (withM2) {
    mkdirSync(join(m1Lib, 'dist/src'), { recursive: true })
    writeFileSync(join(m1Lib, 'dist/src/adapter.mjs'), '// fake installed M1\n')
    writeFileSync(join(m1Lib, 'scripts/lib-verify.mjs'), 'process.exit(0)\n')
    const files = [
      'dist/src/adapter.mjs',
      'scripts/lib-verify.mjs',
      'scripts/codex-shim',
      'scripts/anyengine-launch',
    ]
    writeFileSync(
      join(m1Lib, 'install-manifest.json'),
      JSON.stringify({
        version: plan.version,
        links: {},
        files: Object.fromEntries(
          files.map((name) => [
            name,
            createHash('sha256')
              .update(readFileSync(join(m1Lib, name)))
              .digest('hex'),
          ]),
        ),
      }),
    )
    const jobs = join(home, 'shell-jobs')
    mkdirSync(jobs)
    writeFileSync(join(jobs, 'dev.anyengine.router'), '')
    const stub = (name: string, body: string) => {
      const path = join(home, `${name}.sh`)
      writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o700 })
      return path
    }
    const launchctl = stub(
      'launchctl',
      `label="\${2##*/}"
case "$1" in
print) if [ "$2" = "gui/$(/usr/bin/id -u)" ]; then echo domain; exit 0; fi
if [ -f ${shellQuote(jobs)}/"$label" ]; then echo 'pid = 41001'; exit 0; fi
printf 'Bad request.\\nCould not find service "%s" in domain for user gui: %s\\n' "$label" "$(/usr/bin/id -u)" >&2; exit 113;;
bootout) /bin/rm -f ${shellQuote(jobs)}/"$label";;
esac`,
    )
    plan = {
      ...fakeLib(home, '0.1.0-m2test'),
      recoveryCommands: {
        launchctl,
        pgrep: stub('pgrep', 'exit 1'),
        plutil: stub('plutil', 'echo ChatGPT'),
        osascript: stub('quit', 'exit 0'),
        open: stub('open', 'exit 0'),
      },
    }
    system.procs = [
      {
        pid: 41001,
        ppid: 1,
        processStart: '2026-10-01T00:00:00.000Z',
        command: `node ${m1Lib}/dist/src/adapter.mjs router`,
      },
    ]
    system.jobs.set('dev.anyengine.router', {
      pid: 41001,
      plist: join(home, 'Library/LaunchAgents/dev.anyengine.router.plist'),
    })
    const exec = system.exec
    system.exec = (command, args, options) =>
      command === '/usr/bin/curl'
        ? {
            status: 0,
            stderr: '',
            stdout: JSON.stringify({
              ok: true,
              version: '0.1.0-m1test',
              pid: 41001,
              mode: 'agent',
              faults: { hookErrors: 0, unhandledRejections: 0 },
            }),
          }
        : exec(command, args, options)
    baseline = prepareM2Upgrade(system, root, plan)
    applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
  }
  const dir = join(home, '.claude'),
    settings = join(dir, 'settings.json')
  mkdirSync(dir)
  writeFileSync(settings, '{"theme":"dark"}\n', { mode: 0o640 })
  const recovery = {
    root,
    app: plan.app,
    bundleId: plan.bundleId,
    codexHome: pathsFor(home).codexHome,
    ...(plan.recoveryCommands ? { commands: plan.recoveryCommands } : {}),
  }
  const writer = new LayerWriter(root, null, 'claude-code', 'claude-recovery', () =>
    publishRecovery(recovery),
  )
  applyClaudeLayer({
    root,
    home,
    writer,
    catalog: {
      generation: 1,
      fetchedAt: 0,
      models: [
        {
          id: 'gpt-fixture',
          label: 'Fixture',
          lite: false,
          contextWindow: 272000,
          efforts: ['medium'],
        },
      ],
    },
    baseUrl: 'http://127.0.0.1:18790',
    haiku: 'claude-haiku-4-5-20251001',
  })
  publishRecovery(recovery)
  const agent = join(dir, 'agents/gpt-fixture.md')
  return { home, root, system, settings, agent, recovery, baseline, m1Lib }
}

test('Node-free full and router-only off retire the matching M2 pin while retaining immutable recovery evidence', async () => {
  for (const routerOnly of [false, true]) {
    const f = await fixture(true)
    assert.ok(f.baseline)
    const evidence = [
      f.baseline.recoveryScript,
      f.baseline.m1LayersBackup,
      join(f.root, 'recovery/m2/current.json'),
    ].map((path) => ({ path, bytes: readFileSync(path) }))
    const result = spawnSync(
      '/bin/bash',
      [join(f.root, 'bin/anyengine-off'), ...(routerOnly ? ['--router-only'] : []), '--no-restart'],
      {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: f.home },
        timeout: 30_000,
      },
    )
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(existsSync(join(f.root, 'm2-upgrade.json')), false)
    assert.deepEqual(retainedM2Libraries(f.root), [])
    const journal = JSON.parse(readFileSync(f.baseline.recoveryJournal, 'utf8'))
    assert.equal(journal.retired, true)
    assert.equal(journal.checkpoint, 'broad-off')
    assert.notEqual(journal.baseline.phase, 'rolled-back')
    for (const entry of evidence) assert.deepEqual(readFileSync(entry.path), entry.bytes)
    assert.equal(existsSync(join(f.root, 'recovery/m2/recover.sh')), true)
  }
})

test('Node-free broad conflict preserves its active M2 reference, pin, settings and functional router', async () => {
  const f = await fixture(true)
  assert.ok(f.baseline)
  const record = readFileSync(join(f.root, 'm2-upgrade.json'))
  const journal = readFileSync(f.baseline.recoveryJournal)
  const settings = readFileSync(f.settings)
  const currentLib = realpathSync(join(f.root, 'lib/current'))
  writeFileSync(f.agent, 'operator edited agent\n')
  const result = spawnSync(
    '/bin/bash',
    [join(f.root, 'bin/anyengine-off'), '--router-only', '--no-restart'],
    {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: f.home },
      timeout: 30_000,
    },
  )
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.deepEqual(readFileSync(join(f.root, 'm2-upgrade.json')), record)
  assert.deepEqual(readFileSync(f.baseline.recoveryJournal), journal)
  assert.deepEqual(readFileSync(f.settings), settings)
  assert.equal(realpathSync(join(f.root, 'lib/current')), currentLib)
  assert.equal(existsSync(join(f.home, 'shell-jobs/dev.anyengine.router')), true)
  assert.deepEqual(retainedM2Libraries(f.root), [f.m1Lib])
})
for (const route of ['node', 'bash'] as const) {
  test(`${route} router-only off restores Claude settings semantically before the router`, async () => {
    const f = await fixture()
    const value = JSON.parse(readFileSync(f.settings, 'utf8'))
    value.theme = 'light'
    value.model = 'gpt-fixture'
    value.modelPicker.options.push({ model: 'user-row', label: 'Mine' })
    writeFileSync(f.settings, JSON.stringify(value))
    if (route === 'node') {
      const result = applyOffFiles(f.system, f.root, { routerOnly: true, paths: pathsFor(f.home) })
      assert.equal(result.ok, true)
    } else {
      const result = spawnSync(
        '/bin/bash',
        [join(f.root, 'bin/anyengine-off'), '--router-only', '--files-only'],
        { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: f.home } },
      )
      assert.equal(result.status, 0, result.stderr)
    }
    const after = JSON.parse(readFileSync(f.settings, 'utf8'))
    assert.equal(after.theme, 'light')
    assert.equal(after.model, undefined)
    assert.equal(after.env?.ANTHROPIC_BASE_URL, undefined)
    assert.deepEqual(after.modelPicker.options, [{ model: 'user-row', label: 'Mine' }])
    assert.equal(existsSync(f.agent), false)
    assert.equal(readlinkSync(join(f.root, 'lib/current')), '0.1.0-986ab707750e')
  })
  test(`${route} broad off with an edited Claude agent preserves the functioning router`, async () => {
    const f = await fixture()
    const before = readFileSync(f.settings)
    writeFileSync(f.agent, 'operator edit\n')
    if (route === 'node') {
      const result = applyOffFiles(f.system, f.root, { routerOnly: false, paths: pathsFor(f.home) })
      assert.equal(result.ok, false)
      assert.ok(result.kept.includes('claude-code'))
    } else {
      const result = spawnSync('/bin/bash', [join(f.root, 'bin/anyengine-off'), '--files-only'], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: f.home },
      })
      assert.equal(result.status, 1, result.stderr)
      assert.ok(result.stderr.includes(f.agent))
    }
    assert.deepEqual(readFileSync(f.settings), before)
    assert.equal(readlinkSync(join(f.root, 'lib/current')), '0.1.0-m1test')
    assert.ok(readLayers(f.root).layers.some((layer) => layer.name === 'claude-code'))
  })
}
