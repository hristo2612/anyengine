import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DEFAULT_CONFIG, enginePaths } from '../../src/anyengine-config.mjs'
import { applyClaudeLayer } from '../../src/control-claude-layer.mjs'
import type { OnPlan } from '../../src/control-install-on.mjs'
import { plistPath, ROUTER_LABEL, SMOKE_LABEL } from '../../src/control-launchd.mjs'
import { type Layer, LayerWriter, type RecordPhase, readLayers } from '../../src/control-layers.mjs'
import { shellQuote } from '../../src/control-scripts.mjs'
import { fakeSystem } from './fake-system.mjs'
import { strictJobs } from './flip-deps.mjs'
import { tempDir } from './tmp.mjs'

interface Baseline {
  version: 1
  rollbackDir: string
  recoveryScript: string
  recoveryJournal: string
  phase: 'prepared' | 'activating' | 'active' | 'rolling-back' | 'rolled-back' | 'conflict'
  priorLib: string
  m1LayersBackup: string
  m1LayersSha256: string
  controlChanges: Array<{ target: string; beforeLink: string | null }>
  jobs: Array<{ label: string; plist: string; loaded: boolean }>
}

async function modules() {
  const upgrade = await import('../../src/' + 'control-m2-upgrade.mjs')
  const rollback = await import('../../src/' + 'control-m2-rollback.mjs')
  return {
    prepare: upgrade.prepareM2Upgrade as (
      system: ReturnType<typeof fakeSystem>,
      root: string,
      plan: OnPlan,
    ) => Baseline,
    read: upgrade.readM2Baseline as (root: string) => Baseline | null,
    pins: upgrade.retainedM2Libraries as (root: string) => string[],
    record: upgrade.recordM2ControlChanges as (
      root: string,
      layer: Layer,
      phase: RecordPhase,
    ) => void,
    rollback: rollback.rollbackM2 as (
      system: ReturnType<typeof fakeSystem>,
      root: string,
      options: { noRestart: boolean },
    ) => Promise<{
      ok: boolean
      restoredLib: string | null
      conflicts: string[]
      m1Verified: boolean
    }>,
  }
}

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const _json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

export async function setup(smokeLoaded = true, mode: 'agent' | 'model' = 'agent') {
  const api = await modules()
  const home = await tempDir('anyengine-m2-')
  const root = join(home, '.anyengine')
  mkdirSync(join(root, 'lib'), { recursive: true })
  mkdirSync(join(root, 'bin'))
  mkdirSync(join(home, 'bin'))
  mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true })
  mkdirSync(join(home, '.claude/agents'), { recursive: true })
  const system = fakeSystem(home)
  strictJobs(system)
  system.running = false
  const libraries = ['0.1.0-m0', '0.1.0-m1', '0.1.0-m2'].map((version) => {
    const lib = join(root, 'lib', version)
    const files = {
      'dist/src/adapter.mjs': 'throw new Error("M1 fixture rejects unknown M2 commands")\n',
      'scripts/lib-verify.mjs': 'process.exit(0)\n',
      'scripts/codex-shim': '#!/bin/bash\n# baseline shim\n',
      'scripts/anyengine-launch': '#!/bin/bash\nexit 64\n',
    }
    for (const [name, bytes] of Object.entries(files)) {
      mkdirSync(dirname(join(lib, name)), { recursive: true })
      writeFileSync(join(lib, name), bytes, { mode: 0o755 })
    }
    writeFileSync(
      join(lib, 'install-manifest.json'),
      JSON.stringify({
        version,
        files: Object.fromEntries(
          Object.entries(files).map(([name, bytes]) => [name, hash(bytes)]),
        ),
        links: {},
      }),
    )
    return lib
  })
  const [m0Lib, m1Lib, m2Lib] = libraries as [string, string, string]
  const config = structuredClone(DEFAULT_CONFIG)
  config.modes.codexClaude = mode
  writeFileSync(join(root, 'config.json'), JSON.stringify(config))
  symlinkSync(m0Lib, join(root, 'lib/current'))
  const control = [
    join(root, 'bin/anyengine'),
    join(root, 'bin/anyengine-off'),
    join(root, 'runtime.env'),
    join(home, 'bin/codex'),
    plistPath(home, ROUTER_LABEL),
    plistPath(home, SMOKE_LABEL),
  ]
  for (const target of control) writeFileSync(target, `M0 ${basename(target)}\n`, { mode: 0o700 })
  const writer = new LayerWriter(root, null, 'router', 'm1-baseline')
  writer.writeSymlink(join(root, 'lib/current'), m1Lib)
  for (const target of control) writer.writeFile(target, `M1 ${basename(target)}\n`, 0o700)
  for (const label of [ROUTER_LABEL, SMOKE_LABEL]) {
    if (label === ROUTER_LABEL || smokeLoaded)
      system.jobs.set(label, { plist: plistPath(home, label), pid: 41001 })
  }
  system.procs = [
    {
      pid: 41001,
      ppid: 1,
      command: `node ${m1Lib}/dist/src/adapter.mjs router`,
      processStart: '2026-10-01T00:00:00.000Z',
    },
    {
      pid: process.pid,
      ppid: 1,
      command: `node ${m2Lib}/dist/src/adapter.mjs on`,
      processStart: '2026-10-01T00:00:00.000Z',
    },
  ]
  let healthFailure = false
  const health = () => ({
    ok: !healthFailure,
    version: basename(realpathSync(join(root, 'lib/current'))),
    pid: 41001,
    startedAt: '2026-10-01T00:00:00.000Z',
    mode,
    faults: { hookErrors: 0, unhandledRejections: 0 },
    upstream: {},
    inflight: { gpt: 0, claude: 0 },
    fanout: { path: 'bridge', reason: 'fixture', since: '2026-10-01T00:00:00.000Z' },
  })
  const originalExec = system.exec
  system.exec = (command, args, options) => {
    if (command === '/usr/bin/curl' || command.endsWith('/curl.sh')) {
      system.calls.push(`curl ${args.join(' ')}`)
      return { status: 0, stdout: JSON.stringify(health()), stderr: '' }
    }
    if (command === '/bin/bash') {
      const result = spawnSync(command, args, {
        env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR },
        encoding: 'utf8',
        timeout: options?.timeoutMs ?? 30_000,
      })
      for (const label of [ROUTER_LABEL, SMOKE_LABEL]) {
        if (existsSync(join(jobs, label)))
          system.jobs.set(label, { plist: plistPath(home, label), pid: 41001 })
        else system.jobs.delete(label)
      }
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    }
    return originalExec(command, args, options)
  }
  const calls = join(home, 'shell-calls')
  const jobs = join(home, 'jobs')
  mkdirSync(jobs)
  for (const label of system.jobs.keys()) writeFileSync(join(jobs, label), '')
  const stub = (name: string, body: string) => {
    const path = join(home, `${name}.sh`)
    writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o700 })
    return path
  }
  const launchctl = stub(
    'launchctl',
    `echo "$*" >> ${shellQuote(calls)}
label="\${2##*/}"
case "$1" in
 print) if [ "$2" = "gui/$(/usr/bin/id -u)" ]; then echo domain; exit 0; fi
 if [ -f ${shellQuote(jobs)}/"$label" ]; then echo 'pid = 41001'; exit 0; fi
 printf 'Bad request.\\nCould not find service "%s" in domain for user gui: %s\\n' "$label" "$(/usr/bin/id -u)" >&2; exit 113;;
 bootout) /bin/rm -f ${shellQuote(jobs)}/"$label";;
 bootstrap) label="\${3##*/}"; /usr/bin/touch ${shellQuote(jobs)}/"\${label%.plist}";;
 kickstart) :;;
esac`,
  )
  const curl = stub(
    'curl',
    `version=$(/usr/bin/basename "$(/usr/bin/readlink ${shellQuote(join(root, 'lib/current'))})")
printf '{"ok":true,"version":"%s","pid":41001,"mode":"${mode}","faults":{"hookErrors":0,"unhandledRejections":0}}' "$version"`,
  )
  const plan: OnPlan = {
    version: basename(m2Lib),
    libDir: m2Lib,
    node: process.execPath,
    claudeCli: null,
    shimSource: join(m2Lib, 'scripts/codex-shim'),
    launcherSource: join(m2Lib, 'scripts/anyengine-launch'),
    stamp: 'm2-first',
    app: system.app,
    bundleId: 'dev.fixture',
    recoveryCommands: {
      launchctl,
      curl,
      pgrep: stub('pgrep', 'exit 1'),
      plutil: stub('plutil', 'echo ChatGPT'),
      osascript: stub('quit', 'exit 0'),
      open: stub('open', `echo open >> ${shellQuote(calls)}`),
    } as OnPlan['recoveryCommands'],
  }
  const beforeLayers = readFileSync(enginePaths(root).layers)
  const before = snapshot(control.concat(join(root, 'lib/current')))
  const cache = join(root, 'router/models_cache.json')
  mkdirSync(dirname(cache), { recursive: true })
  writeFileSync(cache, 'M1 CACHE MUST SURVIVE')
  const settings = join(home, '.claude/settings.json')
  writeFileSync(settings, '{"theme":"dark"}\n', { mode: 0o600 })
  return {
    api,
    root,
    home,
    system,
    plan,
    m0Lib,
    m1Lib,
    m2Lib,
    control,
    before,
    beforeLayers,
    cache,
    settings,
    calls,
    jobs,
    setUnhealthy() {
      healthFailure = true
    },
    env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR },
  }
}

export function snapshot(paths: string[]) {
  return paths.sort().map((path) => {
    const stat = lstatSync(path)
    return {
      path,
      mode: stat.mode & 0o7777,
      sha256: stat.isSymbolicLink() ? null : hash(readFileSync(path)),
      linkTarget: stat.isSymbolicLink() ? readlinkSync(path) : null,
    }
  })
}

export function activate(s: Awaited<ReturnType<typeof setup>>) {
  const layer = readLayers(s.root).layers.find((entry) => entry.name === 'router') ?? null
  const writer = new LayerWriter(s.root, layer, 'router', 'm2-write', (value, phase) =>
    s.api.record(s.root, value, phase),
  )
  writer.writeSymlink(join(s.root, 'lib/current'), s.m2Lib)
  for (const target of s.control) writer.writeFile(target, `M2 ${basename(target)}\n`, 0o700)
  const router = s.system.procs[0]
  assert.ok(router)
  s.system.procs[0] = {
    ...router,
    command: `node ${s.m2Lib}/dist/src/adapter.mjs router`,
  }
  return writer
}

export function applyClaude(s: Awaited<ReturnType<typeof setup>>) {
  const writer = new LayerWriter(
    s.root,
    readLayers(s.root).layers.find((layer) => layer.name === 'claude-code') ?? null,
    'claude-code',
    'm2-claude',
    (layer, phase) => s.api.record(s.root, layer, phase),
  )
  applyClaudeLayer({
    root: s.root,
    home: s.home,
    writer,
    baseUrl: 'http://127.0.0.1:18790',
    haiku: 'claude-haiku-4-5-20251001',
    catalog: {
      generation: 1,
      fetchedAt: 4242,
      models: [
        {
          id: 'gpt-fixture',
          label: 'GPT fixture',
          contextWindow: 272000,
          lite: false,
          efforts: ['medium'],
        },
      ],
    },
  })
  return join(s.home, '.claude/agents/gpt-fixture.md')
}
