import assert from 'node:assert/strict'
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { enginePaths, setConfigValue } from '../src/anyengine-config.mjs'
import { registerCommand, runControl } from '../src/control-cli.mjs'
import { LayerWriter } from '../src/control-layers.mjs'
import { writeFlipMarker } from '../src/control-marker.mjs'
import { formatStatus, gatherStatus } from '../src/control-status.mjs'
import { markDegraded, markProven, proofKey } from '../src/degraded.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(() => killChildren())
after(removeTempDirs)
const originalEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  ANYENGINE_HOME: process.env.ANYENGINE_HOME,
  ANYENGINE_DEBUG_LOG: process.env.ANYENGINE_DEBUG_LOG,
}
after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
const START = '2026-10-01T00:00:00.000Z'
const VERSION = '0.1.0-fixture'
const proc = (pid: number, ppid: number, command: string) => ({
  pid,
  ppid,
  command,
  processStart: START,
})
const cacheBytes = Buffer.from(
  '{"client_version":"0.159.0","models":[{"slug":"opus","description":"Café 🌐"}]}',
)
async function setup() {
  const home = await tempDir('control-read-')
  const root = join(home, '.anyengine')
  mkdirSync(enginePaths(root).state, { recursive: true })
  process.env.CODEX_HOME = join(home, '.codex')
  process.env.ANYENGINE_HOME = join(home, '.codex', 'anyengine')
  process.env.ANYENGINE_DEBUG_LOG = join(home, '.codex', 'anyengine', 'debug.jsonl')
  return { home, root, system: fakeSystem(home) }
}
async function command(args: string[], system: ReturnType<typeof fakeSystem>, root: string) {
  let output = ''
  const code = await runControl(args, system, root, (text) => {
    output += text
  })
  return { code, output }
}
function cacheHome(home: string) {
  const path = join(home, '.codex')
  mkdirSync(path, { recursive: true })
  return path
}
async function nativeFixture() {
  const data = await setup()
  const { root, system } = data
  const binary = join(system.app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  mkdirSync(join(binary, '..'), { recursive: true })
  writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const server = http.createServer((_req, res) => {
    res.end(JSON.stringify(health))
  })
  const health: Record<string, unknown> = {}
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  setConfigValue(root, 'router.port', String(address.port))
  const lib = join(root, 'lib', VERSION)
  mkdirSync(lib, { recursive: true })
  symlinkSync(VERSION, join(root, 'lib', 'current'))
  const key = proofKey(root, {
    lib: () => VERSION,
    appVersion: () => system.version,
    codexVersion: () => '0.159.0',
  })
  markProven(root, 'native-fanout', 'correlated fixture success', key)
  Object.assign(health, {
    ok: true,
    pid: 42,
    version: VERSION,
    startedAt: START,
    mode: 'agent',
    proofKey: key,
    fanout: { path: 'native', reason: 'proven', since: START },
    faults: { hookErrors: 0, unhandledRejections: 0 },
    upstream: { lastOkAt: START, lastError: null, lastErrorAt: null },
    inflight: { gpt: 0, claude: 0 },
  })
  writeFileSync(
    enginePaths(root).routerStatus,
    JSON.stringify({ ...health, port: address.port, writtenAt: START }),
  )
  system.jobs.set('dev.anyengine.router', { plist: 'fixture.plist', pid: 42 })
  system.procs = [proc(42, 1, `node ${lib}/dist/src/adapter.mjs router`)]
  return { ...data, health, close: () => new Promise<void>((done) => server.close(() => done())) }
}

test('registered status projects paths, current processes, last-known logs and interrupted recovery read-only', async () => {
  const { home, root, system } = await setup()
  system.procs = [
    proc(77, 800, `node ${root}/lib/${VERSION}/dist/src/adapter.mjs app-server`),
    proc(78, 77, '/private/fake/codex app-server'),
    proc(800, 1, `${system.app}/Contents/MacOS/ChatGPT`),
  ]
  const logs = join(home, '.codex', 'anyengine')
  mkdirSync(logs, { recursive: true })
  writeFileSync(
    join(logs, 'debug.jsonl'),
    [
      { ts: START, pid: 77, event: 'router.link', attached: false, fanout: 'bridge' },
      {
        ts: START,
        pid: 78,
        event: 'codex.upstream.spawn',
        binary: '/private/fake/codex',
        args: ['app-server'],
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  )
  writeFlipMarker(root, {
    id: 'f1',
    op: 'on',
    args: ['--yes'],
    pid: 999,
    processStart: START,
    phase: 'quit-app',
    startedAt: START,
    updatedAt: START,
    runner: 'detached',
    log: join(root, 'state', 'flip-f1.log'),
    state: {},
  })
  writeFileSync(join(root, 'RECOVER.txt'), 'Run /private/control/recover --resume\n')
  markDegraded(root, 'native-fanout', 'fixture failure')
  const before = readdirSync(enginePaths(root).state)
  const result = await command(['status', '--json'], system, root)
  assert.equal(result.code, 0)
  const report = JSON.parse(result.output)
  assert.equal(report.app.version, '26.928.20755')
  assert.equal(report.adapters[0].version, VERSION)
  assert.equal(report.adapters[0].codexChild, 'running')
  assert.equal(report.flip.alive, false)
  assert.ok(report.degraded.paths['native-fanout'])
  const text = formatStatus(report)
  assert.match(text, /interrupted at quit-app/)
  assert.match(text, /RECOVER.txt/)
  assert.doesNotMatch(text, /run `anyengine on`|healthy|fan-out\s+native/)
  assert.deepEqual(readdirSync(enginePaths(root).state), before)
  assert.ok(system.calls.every((call) => !/bootstrap|bootout|quitApp|openApp/.test(call)))
})

test('status can observe matching running native proof and refuses settings, app, lib and fault drift', async () => {
  const f = await nativeFixture()
  try {
    assert.equal((await gatherStatus(f.system, f.root)).router.fanout, 'native')
    assert.match(formatStatus(await gatherStatus(f.system, f.root)), /fan-out\s+native/)
    f.system.version = '26.999.0'
    assert.equal((await gatherStatus(f.system, f.root)).router.fanout, 'unknown')
    f.system.version = '26.928.20755'
    f.health.version = '0.1.0-other'
    assert.equal((await gatherStatus(f.system, f.root)).router.fanout, 'unknown')
    f.health.version = VERSION
    f.health.faults = { hookErrors: 1, unhandledRejections: 0 }
    assert.doesNotMatch(
      formatStatus(await gatherStatus(f.system, f.root)),
      /, healthy|fan-out\s+native/,
    )
    f.health.faults = { hookErrors: 0, unhandledRejections: 0 }
    setConfigValue(f.root, 'claims.graceMs', '4000')
    assert.equal((await gatherStatus(f.system, f.root)).router.fanout, 'unknown')
  } finally {
    await f.close()
  }
})

for (const file of [
  'proven.json',
  'degraded.json',
  'router-status.json',
  'layers.json',
  'known-good.json',
  'smoke.json',
  'flip.json',
]) {
  for (const form of ['malformed', 'invalid-encoding', 'dangling', 'directory', 'unsupported']) {
    test(`registered status preserves ${form} ${file} as unknown evidence`, async () => {
      const f = await nativeFixture()
      const path = join(f.root, 'state', file)
      try {
        fs.rmSync(path, { force: true })
        if (form === 'dangling') symlinkSync(join(f.root, 'absent'), path)
        else if (form === 'directory') mkdirSync(path)
        else if (form === 'unsupported') writeFileSync(path, '{"version":99,"paths":{}}')
        else if (form === 'invalid-encoding')
          writeFileSync(
            path,
            Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xff]), Buffer.from('"}')]),
          )
        else writeFileSync(path, '{broken')
        const before = statSync(f.root).mtimeMs
        const beforeBytes = form !== 'directory' && form !== 'dangling' ? readFileSync(path) : null
        const result = await command(['status', '--json'], f.system, f.root)
        assert.equal(result.code, 1)
        const report = JSON.parse(result.output)
        assert.ok(report.inspectionErrors.some((error: string) => error.includes(file)))
        assert.equal(report.router.fanout, 'unknown')
        assert.doesNotMatch(formatStatus(report), /, healthy|fan-out\s+native/)
        if (file === 'flip.json' || file === 'layers.json')
          assert.doesNotMatch(formatStatus(report), /flip\s+none/)
        assert.equal(statSync(f.root).mtimeMs, before)
        if (beforeBytes) assert.deepEqual(readFileSync(path), beforeBytes)
      } finally {
        await f.close()
      }
    })
  }
}

test('status preserves failed process/app/job queries as unknown instead of idle or absent', async () => {
  const f = await setup()
  f.system.processError = new Error('ps failed')
  f.system.runningError = new Error('pgrep failed')
  f.system.execs.set(`launchctl print gui/${process.getuid?.() ?? 0}/dev.anyengine.router`, {
    status: null,
    stdout: '',
    stderr: 'tool unavailable',
  })
  const { code, output } = await command(['status', '--json'], f.system, f.root)
  assert.equal(code, 1)
  const report = JSON.parse(output)
  assert.equal(report.app.running, 'unknown')
  assert.equal(report.router.job, 'unknown')
  assert.equal(report.processesKnown, false)
  assert.match(report.inspectionErrors.join(' '), /ps failed.*pgrep failed|pgrep failed.*ps failed/)
})

test('mode and config registered setters preserve unknown fields and explain frozen spawn metadata', async () => {
  const f = await setup()
  writeFileSync(enginePaths(f.root).config, '{"version":1,"future":{"kept":true}}')
  const mode = await command(['mode', 'codex-claude', 'model'], f.system, f.root)
  assert.equal(mode.code, 0)
  assert.match(mode.output, /grey/i)
  assert.match(mode.output, /spawn|attachment/)
  assert.match(mode.output, /restart/i)
  assert.match(mode.output, /native fan-out must be proven again/)
  assert.doesNotMatch(mode.output, /existing threads keep their engine|takes effect.*now/i)
  assert.equal(JSON.parse(readFileSync(enginePaths(f.root).config, 'utf8')).future.kept, true)
  for (const args of [
    ['mode', 'codex-claude', 'both'],
    ['mode', 'claude-gpt', 'model'],
    ['config', 'set', 'router.port', '80'],
    ['mode', 'codex-claude', 'agent', 'extra'],
    ['status', '--nonsense'],
    ['cache', 'clean', '--yes'],
  ])
    assert.equal((await command(args, f.system, f.root)).code, 2)
  assert.equal(
    (await command(['config', 'get', 'router.port'], f.system, f.root)).output.trim(),
    'error: future: unknown setting, which does nothing (anyengine config lists the known ones)\n18790',
  )
})

test('registered mode/config refuse corrupt bytes without lock/temp/root changes', async () => {
  const f = await setup()
  const path = enginePaths(f.root).config
  const bytes = Buffer.concat([
    Buffer.from('{"claude":{"cli":"/private/'),
    Buffer.from([0xff]),
    Buffer.from('"}}'),
  ])
  writeFileSync(path, bytes)
  chmodSync(f.root, 0o755)
  const before = readdirSync(f.root)
  for (const args of [
    ['mode', 'codex-claude', 'model'],
    ['config', 'set', 'smoke.hour', '4'],
  ]) {
    assert.equal((await command(args, f.system, f.root)).code, 2)
    assert.deepEqual(readFileSync(path), bytes)
    assert.deepEqual(readdirSync(f.root), before)
    assert.equal(statSync(f.root).mode & 0o777, 0o755)
  }
  assert.equal((await command(['mode'], f.system, f.root)).code, 1)
  assert.equal((await command(['config', 'get', 'router.enabled'], f.system, f.root)).code, 1)
})

for (const state of ['running', 'unknown', 'down']) {
  test(`registered cache cleanup under ${state} app state`, async () => {
    const f = await setup()
    const codex = cacheHome(f.home)
    const prior = process.env.CODEX_HOME
    process.env.CODEX_HOME = codex
    const path = join(codex, 'models_cache.json')
    writeFileSync(path, cacheBytes)
    f.system.running = state === 'running'
    if (state === 'unknown') f.system.runningError = new Error('unknown app')
    try {
      const dry = await command(['cache', 'clean', '--dry-run'], f.system, f.root)
      assert.equal(dry.code, 0)
      assert.deepEqual(readFileSync(path), cacheBytes)
      const result = await command(['cache', 'clean'], f.system, f.root)
      assert.equal(result.code, state === 'down' ? 0 : 1)
      if (state === 'down') {
        assert.equal(existsSync(path), false)
        const dirs = readdirSync(join(f.root, 'state', 'cache-backups'))
        assert.equal(dirs.length, 1)
        const backup = join(f.root, 'state', 'cache-backups', dirs[0] ?? '', 'models_cache.json')
        assert.deepEqual(readFileSync(backup), cacheBytes)
        assert.equal(statSync(backup).mode & 0o777, 0o600)
        assert.equal((await command(['cache', 'clean'], f.system, f.root)).code, 0)
      } else {
        assert.deepEqual(readFileSync(path), cacheBytes)
        assert.equal(existsSync(join(f.root, 'state', 'cache-backups')), false)
      }
      assert.ok(!f.system.calls.includes('quitApp') && !f.system.calls.includes('openApp'))
    } finally {
      if (prior === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prior
    }
  })
}

test('registered cache conflict retains partial backup and retries with a fresh owned backup', async () => {
  const f = await setup()
  f.system.running = false
  const codex = cacheHome(f.home)
  const prior = process.env.CODEX_HOME
  process.env.CODEX_HOME = codex
  const path = join(codex, 'models_cache.json')
  writeFileSync(path, cacheBytes)
  const original = fs.fsyncSync
  let replacement = false
  fs.fsyncSync = (fd) => {
    original(fd)
    if (!replacement) {
      replacement = true
      writeFileSync(path, Buffer.from('{"models":[{"slug":"sonnet"}]}'))
    }
  }
  syncBuiltinESMExports()
  try {
    const result = await command(['cache', 'clean'], f.system, f.root)
    assert.equal(result.code, 1)
    assert.match(result.output, /backup.*retained|retained.*backup/)
    assert.equal(existsSync(path), true)
  } finally {
    fs.fsyncSync = original
    syncBuiltinESMExports()
  }
  try {
    const before = readdirSync(join(f.root, 'state', 'cache-backups'))
    assert.equal(before.length, 1)
    const backup = join(f.root, 'state', 'cache-backups', before[0] ?? '', 'models_cache.json')
    assert.deepEqual(readFileSync(backup), cacheBytes)
    assert.equal((await command(['cache', 'clean'], f.system, f.root)).code, 0)
    assert.deepEqual(readFileSync(backup), cacheBytes)
    assert.equal(readdirSync(join(f.root, 'state', 'cache-backups')).length, 2)
  } finally {
    if (prior === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prior
  }
})

test('runControl refuses invalid roots and unavailable registered commands without success placeholders', async () => {
  const f = await setup()
  const before = process.env.ANYENGINE_ROOT
  process.env.ANYENGINE_ROOT = 'relative'
  let output = ''
  try {
    assert.equal(
      await runControl(['status'], f.system, undefined, (text) => {
        output += text
      }),
      2,
    )
    assert.match(output, /absolute path/)
    assert.doesNotMatch(output, /at runControl/)
  } finally {
    if (before === undefined) delete process.env.ANYENGINE_ROOT
    else process.env.ANYENGINE_ROOT = before
  }
  assert.equal((await command(['unknown-command'], f.system, f.root)).code, 2)
  // No vendor exists in the hermetic runner; the registered launcher fails closed.
  assert.deepEqual(await command(['codex'], f.system, f.root), { code: 1, output: '' })
  const smoke = await command(['smoke'], f.system, f.root)
  assert.equal(smoke.code, 1)
  assert.match(smoke.output, /ENOENT|installed|library|lib/)
  assert.doesNotMatch(smoke.output, /not implemented|unfinished/)
  registerCommand('doctor', async (args, _system, _root, say) => {
    say(args.join('|'))
    return 1
  })
  assert.deepEqual(await command(['doctor', 'x'], f.system, f.root), { code: 1, output: 'x' })
})

async function childResult(binary: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (data) => {
    stdout += data
  })
  child.stderr?.on('data', (data) => {
    stderr += data
  })
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject)
    child.once('close', done)
  })
  return { code, stdout, stderr }
}
test('production dispatcher handles config before app-server startup without import effects', async () => {
  const f = await setup()
  const result = await childResult(
    process.execPath,
    [resolve('dist/src/adapter.mjs'), 'config', 'get', 'router.port'],
    { ...process.env, ANYENGINE_ROOT: f.root },
  )
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim(), '18790')
  assert.deepEqual(readdirSync(f.root), ['state'])
})

test('launcher resolves spaces and minimal PATH, sources runtime, preserves args and bounds log inode', async () => {
  const home = await tempDir('launcher-')
  const root = join(home, 'engine root')
  const lib = join(root, 'lib', 'fixture version')
  mkdirSync(lib, { recursive: true })
  symlinkSync('fixture version', join(root, 'lib', 'current'))
  const capture = join(home, 'capture.json')
  const node = join(home, 'fake node')
  writeFileSync(
    node,
    `#!/bin/bash\nexec '${process.execPath}' '${join(home, 'capture.mjs')}' "$@"\n`,
    { mode: 0o755 },
  )
  writeFileSync(
    join(home, 'capture.mjs'),
    'import fs from "node:fs"; fs.writeFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),flag:process.env.LAUNCH_TEST}))',
  )
  writeFileSync(
    join(root, 'runtime.env'),
    `export ANYENGINE_NODE='${node}'\nexport LAUNCH_TEST='loaded'\n`,
  )
  mkdirSync(join(root, 'logs'))
  const log = join(root, 'logs', 'launch.log')
  writeFileSync(log, 'x'.repeat(250_000))
  const inode = statSync(log).ino
  const result = await childResult(
    '/bin/bash',
    [resolve('scripts/anyengine-launch'), 'config', 'get', 'a b'],
    {
      ...process.env,
      PATH: '/usr/bin:/bin',
      ANYENGINE_ROOT: root,
      ANYENGINE_LAUNCHD_LOG: log,
      CAPTURE: capture,
    },
  )
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), {
    args: [join(lib, 'dist/src/adapter.mjs'), 'config', 'get', 'a b'],
    flag: 'loaded',
  })
  assert.equal(statSync(log).ino, inode)
  assert.equal(statSync(log).size, 204800)
  assert.equal(existsSync(`${log}.tail`), false)
  const absent = await childResult('/bin/bash', [resolve('scripts/anyengine-launch'), 'status'], {
    ...process.env,
    ANYENGINE_ROOT: join(home, 'missing root'),
  })
  assert.equal(absent.code, 78)
  assert.match(absent.stderr, /no installed lib/)
})

test('status does not call a recycled or unrelated child running from stale spawn evidence', async () => {
  const f = await setup()
  f.system.procs = [
    proc(77, 800, `node ${f.root}/lib/${VERSION}/dist/src/adapter.mjs app-server`),
    { ...proc(78, 77, '/private/other-worker'), processStart: '2026-10-01T00:01:00.000Z' },
    proc(800, 1, `${f.system.app}/Contents/MacOS/ChatGPT`),
  ]
  mkdirSync(process.env.ANYENGINE_HOME ?? '', { recursive: true })
  writeFileSync(
    process.env.ANYENGINE_DEBUG_LOG ?? '',
    JSON.stringify({
      ts: START,
      pid: 78,
      event: 'codex.upstream.spawn',
      binary: '/private/fake/codex',
      args: ['app-server'],
    }),
  )
  const report = JSON.parse((await command(['status', '--json'], f.system, f.root)).output)
  assert.equal(report.adapters[0].codexChild, 'unknown')
})

test('launcher retains a symlink log target instead of truncating unrelated evidence', async () => {
  const f = await setup()
  const lib = join(f.root, 'lib', VERSION)
  mkdirSync(lib, { recursive: true })
  symlinkSync(VERSION, join(f.root, 'lib', 'current'))
  const logs = join(f.root, 'logs')
  mkdirSync(logs)
  const target = join(f.home, 'opaque.sqlite')
  const bytes = Buffer.from('x'.repeat(250_000))
  writeFileSync(target, bytes)
  const log = join(logs, 'router.launchd.log')
  symlinkSync(target, log)
  const result = await childResult('/bin/bash', [resolve('scripts/anyengine-launch'), 'unused'], {
    ...process.env,
    ANYENGINE_ROOT: f.root,
    ANYENGINE_NODE: '/usr/bin/true',
    ANYENGINE_LAUNCHD_LOG: log,
  })
  assert.equal(result.code, 0)
  assert.ok(readFileSync(target).equals(bytes), 'symlink target bytes remain exact')
})

test('launcher retains foreign logs reached through a symlink logs directory', async () => {
  const home = await tempDir('launcher-parent-')
  const root = join(home, 'engine root')
  const lib = join(root, 'lib', VERSION)
  mkdirSync(lib, { recursive: true })
  symlinkSync(VERSION, join(root, 'lib', 'current'))
  const foreign = join(home, 'foreign logs')
  mkdirSync(foreign)
  symlinkSync(foreign, join(root, 'logs'))
  const target = join(foreign, 'router.launchd.log')
  const bytes = Buffer.from('x'.repeat(250_000))
  writeFileSync(target, bytes)
  const inode = statSync(target).ino
  const result = await childResult('/bin/bash', [resolve('scripts/anyengine-launch'), 'unused'], {
    ...process.env,
    PATH: '/usr/bin:/bin',
    ANYENGINE_ROOT: root,
    ANYENGINE_NODE: '/usr/bin/true',
    ANYENGINE_LAUNCHD_LOG: join(root, 'logs', 'router.launchd.log'),
  })
  assert.equal(result.code, 0, result.stderr)
  assert.ok(readFileSync(target).equals(bytes), 'foreign log bytes remain exact')
  assert.equal(statSync(target).ino, inode)
  assert.ok(fs.lstatSync(join(root, 'logs')).isSymbolicLink())
  assert.deepEqual(readdirSync(foreign), ['router.launchd.log'])
})

test('cache backup limit preserves all prior partial evidence without deleting current cache', async () => {
  const f = await setup()
  f.system.running = false
  const codex = cacheHome(f.home)
  const path = join(codex, 'models_cache.json')
  writeFileSync(path, cacheBytes)
  const parent = join(f.root, 'state', 'cache-backups')
  mkdirSync(parent)
  for (let i = 0; i < 32; i += 1) {
    const dir = join(parent, `partial-${i}`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'models_cache.json'), 'prior evidence')
  }
  const result = await command(['cache', 'clean'], f.system, f.root)
  assert.equal(result.code, 1)
  assert.match(result.output, /limit|32/)
  assert.deepEqual(readFileSync(path), cacheBytes)
  assert.equal(readdirSync(parent).length, 32)
})

test('proof-relevant registered config mutation invalidates the exact prior proof', async () => {
  const f = await setup()
  const reads = {
    lib: () => null,
    appVersion: () => f.system.version,
    codexVersion: () => '0.159.0',
  }
  const before = proofKey(f.root, reads)
  markProven(f.root, 'native-fanout', 'fixture success', before)
  const result = await command(['config', 'set', 'router.multiAgentV1', 'false'], f.system, f.root)
  assert.equal(result.code, 0)
  assert.match(result.output, /native fan-out must be proven again/)
  assert.equal(
    JSON.parse(readFileSync(enginePaths(f.root).config, 'utf8')).router.multiAgentV1,
    false,
  )
  assert.notEqual(proofKey(f.root, reads).settings, before.settings)
})

for (const file of ['proven.json', 'degraded.json', 'router-status.json']) {
  test(`status rejects invalid bytes inside otherwise valid ${file} and accepts encoded U+FFFD`, async () => {
    const f = await nativeFixture()
    const path = join(f.root, 'state', file)
    try {
      if (file === 'degraded.json')
        writeFileSync(path, JSON.stringify({ paths: { gpt: { since: START, reason: 'X' } } }))
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (file === 'proven.json') value.paths['native-fanout'].detail = 'X'
      if (file === 'router-status.json') value.fanout.reason = 'X'
      const bytes = Buffer.from(JSON.stringify(value))
      const index = bytes.indexOf(Buffer.from('"X"'))
      assert.ok(index >= 0)
      bytes[index + 1] = 0xff
      assert.doesNotThrow(() => JSON.parse(bytes.toString('utf8')))
      writeFileSync(path, bytes)
      const result = await command(['status', '--json'], f.system, f.root)
      assert.equal(result.code, 1)
      assert.equal(JSON.parse(result.output).router.fanout, 'unknown')
      assert.deepEqual(readFileSync(path), bytes)
      writeFileSync(path, bytes.toString('utf8'))
      const valid = await command(['status', '--json'], f.system, f.root)
      assert.equal(valid.code, 0)
      assert.equal(JSON.parse(valid.output).router.fanout, 'native')
    } finally {
      await f.close()
    }
  })
}

test('status distinguishes invalid recovery change records from a valid historical layer', async () => {
  const f = await setup()
  const writer = new LayerWriter(f.root, null, 'router', 'synthetic')
  writer.writeFile(join(f.home, 'config.toml'), 'after\n', 0o644)
  const layer = writer.layer
  writeFileSync(enginePaths(f.root).layers, JSON.stringify({ version: 1, layers: [layer] }))
  const valid = JSON.parse((await command(['status', '--json'], f.system, f.root)).output)
  assert.deepEqual(valid.layers, ['router'])
  for (const change of [
    { ...layer.changes[0], after: 9 },
    {
      ...layer.changes[0],
      pending: { kind: 'file', sha: 'invalid', bytes: null, link: null, mode: 420 },
    },
  ]) {
    const raw = JSON.stringify({ version: 1, layers: [{ ...layer, changes: [change] }] })
    writeFileSync(enginePaths(f.root).layers, raw)
    const result = await command(['status', '--json'], f.system, f.root)
    assert.equal(result.code, 1)
    assert.equal(JSON.parse(result.output).layers, null)
    assert.equal(readFileSync(enginePaths(f.root).layers, 'utf8'), raw)
  }
})

test('status does not verify native when the selected codex path is missing', async () => {
  const f = await nativeFixture()
  fs.rmSync(join(f.system.app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'))
  try {
    const result = await command(['status', '--json'], f.system, f.root)
    const report = JSON.parse(result.output)
    assert.equal(report.app.codex, null)
    assert.equal(report.router.fanout, 'unknown')
    assert.doesNotMatch(formatStatus(report), /, healthy|fan-out\s+native/)
  } finally {
    await f.close()
  }
})
