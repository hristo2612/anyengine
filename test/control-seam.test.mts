import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { cleanModelsCache, inspectModelsCache } from '../src/control-cache.mjs'
import { lastEvent, tailJsonl } from '../src/control-logs.mjs'
import {
  clearFlipMarker,
  type FlipMarker,
  flipMarkerPath,
  markerAlive,
  readFlipMarker,
  writeFlipMarker,
} from '../src/control-marker.mjs'
import {
  adapterProcesses,
  ancestorCommands,
  type ExecResult,
  realSystem,
  type System,
} from '../src/control-system.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

const CLAUDE = new Set(['opus', 'sonnet', 'haiku'])
const START = '2026-10-01T00:00:00.000Z'
const cache = (models: unknown[]) =>
  JSON.stringify({ client_version: '0.159.0', etag: '"e"', fetched_at: 'now', models })
const marker = (): FlipMarker => ({
  id: 'f2',
  op: 'off',
  args: ['--router-only'],
  pid: 5,
  processStart: START,
  runner: 'detached',
  phase: 'restore-files',
  startedAt: START,
  updatedAt: START,
  log: '/private/control/flip-f2.log',
  state: { routerLayerWasNew: true },
})
const proc = (pid: number, ppid: number, command: string, processStart = START) => ({
  pid,
  ppid,
  command,
  processStart,
})

test('cache cleaning preserves clean bytes and corrupt or unsupported evidence', async () => {
  const home = await tempDir('cache-')
  const path = join(home, 'models_cache.json')
  assert.equal(inspectModelsCache(home, CLAUDE).exists, false)
  for (const bytes of [
    cache([{ slug: 'gpt-6-sol', description: 'x' }]),
    '{broken',
    'null',
    '[]',
    '{"models":null}',
    '{"models":[null]}',
    '{"models":[{}]}',
    '{"client_version":4,"models":[{"slug":"opus"}]}',
  ]) {
    writeFileSync(path, bytes)
    const result = cleanModelsCache(home, CLAUDE, null)
    assert.equal(result.removed, false)
    assert.equal(readFileSync(path, 'utf8'), bytes)
    assert.equal(result.report.exists, true)
    if (bytes !== cache([{ slug: 'gpt-6-sol', description: 'x' }]))
      assert.ok(result.report.parseError)
  }
})

test('owned cache is backed up before removal and subsequent cleanup is inert', async () => {
  const home = await tempDir('cache-')
  const backup = await tempDir('cache-backup-')
  const path = join(home, 'models_cache.json')
  const bytes = cache([
    { slug: 'gpt-6-sol' },
    { slug: 'opus' },
    { slug: 'custom', description: 'Claude Café 🌐 on your plan, via AnyEngine' },
  ])
  writeFileSync(path, bytes)
  assert.deepEqual(inspectModelsCache(home, CLAUDE).anyengine, ['opus', 'custom'])
  assert.equal(inspectModelsCache(home, CLAUDE).clientVersion, '0.159.0')
  assert.equal(cleanModelsCache(home, CLAUDE, backup).removed, true)
  assert.equal(existsSync(path), false)
  assert.equal(readFileSync(join(backup, 'models_cache.json'), 'utf8'), bytes)
  assert.deepEqual(readFileSync(join(backup, 'models_cache.json')), Buffer.from(bytes))
  assert.equal(statSync(join(backup, 'models_cache.json')).mode & 0o777, 0o600)
  assert.equal(cleanModelsCache(home, CLAUDE, backup).removed, false)
})

test('cache refuses deletion without backup or clobbering existing recovery evidence', async () => {
  const home = await tempDir('cache-')
  const backup = await tempDir('cache-backup-')
  const path = join(home, 'models_cache.json')
  const bytes = cache([{ slug: 'opus' }])
  writeFileSync(path, bytes)
  assert.throws(() => cleanModelsCache(home, CLAUDE, null), /backup/i)
  writeFileSync(join(backup, 'models_cache.json'), 'unrelated evidence')
  assert.throws(() => cleanModelsCache(home, CLAUDE, backup))
  assert.equal(readFileSync(path, 'utf8'), bytes)
  assert.equal(readFileSync(join(backup, 'models_cache.json'), 'utf8'), 'unrelated evidence')
  const blocked = join(home, 'not-a-directory')
  writeFileSync(blocked, 'block mkdir')
  assert.throws(() => cleanModelsCache(home, CLAUDE, blocked))
  assert.equal(readFileSync(path, 'utf8'), bytes)
})

test('present unreadable or dangling cache is reported and preserved', async () => {
  const home = await tempDir('cache-')
  const path = join(home, 'models_cache.json')
  mkdirSync(path)
  assert.equal(inspectModelsCache(home, CLAUDE).exists, true)
  assert.ok(cleanModelsCache(home, CLAUDE, null).report.parseError)
  const other = await tempDir('cache-')
  symlinkSync(join(other, 'absent'), join(other, 'models_cache.json'))
  assert.equal(inspectModelsCache(other, CLAUDE).exists, true)
  assert.ok(cleanModelsCache(other, CLAUDE, null).report.parseError)
})

test('valid marker round-trips privately, updates and clears only valid state', async () => {
  const root = await tempDir('marker-')
  assert.equal(readFlipMarker(root), null)
  clearFlipMarker(root)
  const value = marker()
  writeFlipMarker(root, value)
  assert.deepEqual(readFlipMarker(root), value)
  assert.equal(statSync(flipMarkerPath(root)).mode & 0o777, 0o600)
  value.phase = 'postflight'
  writeFlipMarker(root, value)
  assert.equal(readFlipMarker(root)?.phase, 'postflight')
  clearFlipMarker(root)
  assert.equal(readFlipMarker(root), null)
})

test('marker size limits use published pretty bytes and preserve a readable near-limit journal', async () => {
  const root = await tempDir('marker-size-')
  const path = flipMarkerPath(root)
  const nearLimit = { ...marker(), state: { payload: 'λ'.repeat(995_000) } }
  writeFlipMarker(root, nearLimit)
  assert.ok(statSync(path).size > 1_990_000 && statSync(path).size <= 2_000_000)
  assert.deepEqual(readFlipMarker(root), nearLimit)
  const before = readFileSync(path)
  const tooLarge = { ...marker(), state: { pending: Array(250_000).fill(0) } }
  assert.ok(Buffer.byteLength(JSON.stringify(tooLarge)) < 2_000_000)
  assert.throws(() => writeFlipMarker(root, tooLarge), /size|limit/i)
  assert.deepEqual(readFileSync(path), before)
  assert.deepEqual(readFlipMarker(root), nearLimit)
})

test('invalid UTF-8 cache content preserves raw evidence and refuses removal', async () => {
  const home = await tempDir('cache-encoding-')
  const backup = await tempDir('cache-encoding-backup-')
  const path = join(home, 'models_cache.json')
  const bytes = Buffer.concat([
    Buffer.from('{"client_version":"0.159.0","models":[{"slug":"opus","description":"'),
    Buffer.from([0xff]),
    Buffer.from('"}]}'),
  ])
  writeFileSync(path, bytes)
  const inspection = inspectModelsCache(home, CLAUDE)
  const result = cleanModelsCache(home, CLAUDE, backup)
  assert.ok(inspection.exists && inspection.parseError)
  assert.ok(result.report.exists && result.report.parseError)
  assert.equal(result.removed, false)
  assert.deepEqual(readFileSync(path), bytes)
  assert.equal(existsSync(join(backup, 'models_cache.json')), false)
})

for (const operation of ['read', 'write', 'clear'] as const) {
  test(`invalid UTF-8 marker content refuses ${operation} and preserves raw evidence`, async () => {
    const root = await tempDir('marker-encoding-')
    writeFlipMarker(root, marker())
    const path = flipMarkerPath(root)
    const bytes = Buffer.from(JSON.stringify({ ...marker(), state: { payload: 'X' } }))
    const needle = bytes.indexOf(Buffer.from('"payload":"X"'))
    assert.ok(needle >= 0)
    bytes[needle + Buffer.byteLength('"payload":"')] = 0xff
    assert.doesNotThrow(() => JSON.parse(bytes.toString('utf8')))
    writeFileSync(path, bytes)
    const mutate = {
      read: () => readFlipMarker(root),
      write: () => writeFlipMarker(root, marker()),
      clear: () => clearFlipMarker(root),
    }
    assert.throws(mutate[operation], /marker/i)
    assert.deepEqual(readFileSync(path), bytes)
  })
}

test('malformed and unsupported markers refuse read, overwrite and clear, preserving bytes', async () => {
  const root = await tempDir('marker-')
  const path = flipMarkerPath(root)
  mkdirSync(join(root, 'state'))
  for (const bytes of [
    '{broken',
    'null',
    '[]',
    JSON.stringify({ ...marker(), op: 'upgrade' }),
    JSON.stringify({ ...marker(), args: [1] }),
    JSON.stringify({ ...marker(), args: [''] }),
    JSON.stringify({ ...marker(), pid: -1 }),
    JSON.stringify({ ...marker(), runner: 'other' }),
    JSON.stringify({ ...marker(), phase: '' }),
    JSON.stringify({ ...marker(), startedAt: 'yesterday' }),
    JSON.stringify({ ...marker(), processStart: null }),
    JSON.stringify({ ...marker(), state: [] }),
    JSON.stringify({ ...marker(), log: '' }),
    JSON.stringify({ ...marker(), version: 2 }),
  ]) {
    writeFileSync(path, bytes)
    assert.throws(() => readFlipMarker(root), /marker/i)
    assert.throws(() => writeFlipMarker(root, marker()), /marker/i)
    assert.throws(() => clearFlipMarker(root), /marker/i)
    assert.equal(readFileSync(path, 'utf8'), bytes)
  }
})

test('dangling and non-file markers remain explicit errors', async () => {
  for (const kind of ['directory', 'symlink']) {
    const root = await tempDir('marker-')
    const path = flipMarkerPath(root)
    mkdirSync(join(root, 'state'))
    if (kind === 'directory') mkdirSync(path)
    else symlinkSync(join(root, 'absent'), path)
    assert.throws(() => readFlipMarker(root), /marker/i)
    assert.throws(() => writeFlipMarker(root, marker()), /marker/i)
    assert.throws(() => clearFlipMarker(root), /marker/i)
  }
})

test('new invalid marker and a different flip cannot replace valid recovery state', async () => {
  const root = await tempDir('marker-')
  writeFlipMarker(root, marker())
  const bytes = readFileSync(flipMarkerPath(root), 'utf8')
  assert.throws(() => writeFlipMarker(root, { ...marker(), id: 'different' }))
  assert.throws(() => writeFlipMarker(root, { ...marker(), pid: 0 }))
  assert.throws(() => writeFlipMarker(root, { ...marker(), state: { omitted: undefined } }))
  assert.throws(() =>
    writeFlipMarker(root, { ...marker(), state: { payload: 'x'.repeat(2_000_001) } }),
  )
  assert.throws(() =>
    writeFlipMarker(root, { ...marker(), state: new Date() as unknown as Record<string, unknown> }),
  )
  assert.equal(readFileSync(flipMarkerPath(root), 'utf8'), bytes)
})

test('marker liveness matches exact detached identity and foreground operation', () => {
  const system = fakeSystem('/private/test')
  for (const command of [
    'node /x/dist/src/adapter.mjs flip-run f2 off --router-only',
    'node "/path with space/adapter.mjs" flip-run f2 off --router-only',
    'node /path with space/adapter.mjs flip-run f2 off --router-only',
  ]) {
    system.procs = [proc(5, 1, command)]
    assert.equal(markerAlive(marker(), system), true)
  }
  for (const command of [
    'node /x/adapter.mjs flip-run other off --router-only',
    'node /x/adapter.mjs flip-run f2 on --router-only',
    'node /x/adapter.mjs flip-run f2 off --force',
    'node /x/adapter.mjs app-server --description flip-run',
    'node /x/not-adapter.mjs flip-run f2 off --router-only',
    'echo node /x/adapter.mjs flip-run f2 off --router-only',
    'node -e code /x/adapter.mjs flip-run f2 off --router-only',
  ]) {
    system.procs = [proc(5, 1, command)]
    assert.equal(markerAlive(marker(), system), false, command)
  }
  system.procs = [proc(5, 1, 'node /x/adapter.mjs off --router-only --foreground')]
  assert.equal(markerAlive({ ...marker(), runner: 'foreground' }, system), true)
  system.procs = [proc(5, 1, 'node /x/adapter.mjs on --router-only --foreground')]
  assert.equal(markerAlive({ ...marker(), runner: 'foreground' }, system), false)
  system.procs = [proc(5, 1, 'node /x/adapter.mjs off --foreground --router-only')]
  assert.equal(markerAlive({ ...marker(), runner: 'foreground' }, system), true)
  system.procs = [proc(5, 1, 'node /x/adapter.mjs flip-run f2 off --project /path with space')]
  assert.equal(markerAlive({ ...marker(), args: ['--project', '/path with space'] }, system), true)
  system.procs = [
    proc(5, 1, 'node /x/adapter.mjs flip-run f2 off --router-only', '2026-10-02T00:00:00.000Z'),
  ]
  assert.equal(markerAlive(marker(), system), false, 'a reused pid is not this flip')
  system.procs = []
  assert.equal(markerAlive(marker(), system), false)
  system.processError = new Error('cannot inspect processes')
  assert.throws(() => markerAlive(marker(), system), /cannot inspect/)
})

test('foreground Desktop lifecycle aliases keep their active recovery marker', () => {
  const system = fakeSystem('/private/test')
  for (const { op, args, quoted, raw } of [
    {
      op: 'on',
      args: ['--native-proof', '/path with space'],
      quoted: '--native-proof "/path with space"',
      raw: '--native-proof /path with space',
    },
    { op: 'off', args: ['--router-only'], quoted: '--router-only', raw: '--router-only' },
    { op: 'restart', args: ['--wait-quiet', '1'], quoted: '--wait-quiet 1', raw: '--wait-quiet 1' },
  ] as const) {
    const active = {
      ...marker(),
      op,
      runner: 'foreground' as const,
      args: [...args, '--foreground'],
    }
    for (const command of [
      `node /x/adapter.mjs desktop chatgpt ${op} ${quoted} --foreground`,
      `node /x/adapter.mjs desktop chatgpt ${op} --foreground ${raw}`,
    ]) {
      system.procs = [proc(5, 1, command)]
      assert.equal(markerAlive(active, system), true, command)
    }
    for (const command of [
      `node /x/adapter.mjs desktop claude tools ${op} ${raw} --foreground`,
      `node /x/adapter.mjs desktop chatgpt ${op} --force --foreground`,
      `node /x/adapter.mjs desktop chatgpt ${op} ${raw} --foreground --foreground`,
      `node /x/adapter.mjs desktop chatgpt status ${raw} --foreground`,
    ]) {
      system.procs = [proc(5, 1, command)]
      assert.equal(markerAlive(active, system), false, command)
    }
    system.procs = [
      proc(
        5,
        1,
        `node /x/adapter.mjs desktop chatgpt ${op} ${raw} --foreground`,
        '2026-10-02T00:00:00.000Z',
      ),
    ]
    assert.equal(markerAlive(active, system), false, 'a reused pid is not this Desktop flip')
  }
})

test('process ancestry is nearest-first and stops at cycles; adapters exclude other modes', () => {
  const system = fakeSystem('/private/test')
  system.procs = [
    proc(100, 1, '/Applications/Test.app/Contents/MacOS/Test'),
    proc(200, 100, 'codex app-server'),
    proc(300, 200, 'node /x/adapter.mjs on'),
    proc(400, 1, 'node /home/.anyengine/lib/v1/dist/src/adapter.mjs app-server'),
    proc(500, 1, 'node /x/adapter.mjs bridge-mcp app-server'),
    proc(600, 1, 'node /x/adapter.mjs router'),
    proc(700, 1, 'node /x/adapter.mjs flip-run f2 off --log app-server'),
    proc(800, 1, 'node /x/adapter.mjs -c model=opus app-server'),
  ]
  assert.deepEqual(ancestorCommands(system, 300), [
    'codex app-server',
    '/Applications/Test.app/Contents/MacOS/Test',
  ])
  assert.deepEqual(ancestorCommands(system, 100), [])
  assert.deepEqual(adapterProcesses(system), [
    { pid: 400, version: 'v1', command: system.procs[3]?.command },
    { pid: 800, version: null, command: system.procs[7]?.command },
  ])
  system.procs = [proc(1, 2, 'one'), proc(2, 3, 'two'), proc(3, 2, 'three')]
  assert.deepEqual(ancestorCommands(system, 1), ['two', 'three'])
})

test('foreground identity and adapter inspection retain real paths and leading Codex globals', () => {
  const system = fakeSystem('/private/test')
  system.procs = [
    proc(5, 1, 'node /path with space/adapter.mjs off --project /project with space --foreground'),
  ]
  assert.equal(
    markerAlive(
      { ...marker(), runner: 'foreground', args: ['--project', '/project with space'] },
      system,
    ),
    true,
  )
  system.procs = [proc(6, 1, 'node /x/adapter.mjs -m gpt-6-sol -C /project --config=x app-server')]
  assert.deepEqual(adapterProcesses(system), [
    { pid: 6, version: null, command: system.procs[0]?.command },
  ])
})

test('JSONL tail is bounded, ordered, object-only and skips partial first lines', async () => {
  const root = await tempDir('logs-')
  const path = join(root, 'events.jsonl')
  assert.deepEqual(tailJsonl(path), [])
  writeFileSync(path, '{"event":"old"}\ntrash\nnull\n[]\n7\n{"event":"new"}\n')
  assert.deepEqual(tailJsonl(path), [{ event: 'old' }, { event: 'new' }])
  assert.deepEqual(tailJsonl(path, 17), [{ event: 'new' }])
  assert.throws(() => tailJsonl(path, -1), /bytes/i)
  assert.throws(() => tailJsonl(path, Number.POSITIVE_INFINITY), /bytes/i)
  const db = join(root, 'config.json.lock.sqlite')
  writeFileSync(db, 'opaque coordination data')
  assert.throws(() => tailJsonl(db), /SQLite|coordination/i)
  assert.throws(() => tailJsonl(`${db}-wal`), /SQLite|coordination/i)
  const alias = join(root, 'database.jsonl')
  symlinkSync(db, alias)
  assert.throws(() => tailJsonl(alias), /SQLite|coordination/i)
  assert.equal(readFileSync(db, 'utf8'), 'opaque coordination data')
})

test('lastEvent handles global and sticky regexes repeatedly without stale matching state', () => {
  const events = [
    { event: 'ready', pid: 1 },
    { event: 'other', pid: 2 },
    { event: 'ready', pid: 2 },
  ]
  for (const names of [/ready/g, /ready/y]) {
    names.lastIndex = 99
    assert.deepEqual(lastEvent(events, names), { event: 'ready', pid: 2 })
    assert.deepEqual(lastEvent(events, names), { event: 'ready', pid: 2 })
    assert.deepEqual(lastEvent(events, names, 1), { event: 'ready', pid: 1 })
    assert.equal(names.lastIndex, 99)
  }
  assert.equal(lastEvent(events, /absent/), null)
})

function injectedSystem(results: ExecResult[]) {
  const calls: Array<{ command: string; args: string[]; options?: Parameters<System['exec']>[2] }> =
    []
  const execute: System['exec'] = (command, args, options) => {
    calls.push({ command, args, ...(options ? { options } : {}) })
    const result = results.shift()
    assert.ok(result, `unexpected call: ${command}`)
    return result
  }
  const app = '/private/Applications/Custom "Test".app'
  return {
    system: realSystem({ HOME: '/private/test', ANYENGINE_CHATGPT_APP: app }, execute),
    calls,
    app,
  }
}
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' })
const failed = (status: number | null = 2): ExecResult => ({
  status,
  stdout: '',
  stderr: 'failed tool',
})

test('real system targets the configured bundle for plist, running, quit and open', () => {
  const { system, calls, app } = injectedSystem([
    ok('Custom Test\n'),
    ok('42\n'),
    ok('Custom Test\n'),
    ok('42\n'),
    ok(),
    ok('Custom Test\n'),
    { status: 1, stdout: '', stderr: '' },
    ok(),
  ])
  assert.equal(system.home, '/private/test')
  assert.equal(system.appRunning(), true)
  assert.equal(system.quitApp(0), true)
  system.openApp()
  assert.equal(calls[0]?.command, '/usr/bin/plutil')
  assert.equal(calls[0]?.args.at(-1), join(app, 'Contents', 'Info.plist'))
  assert.deepEqual(calls[1]?.args, [
    '-f',
    '^/private/Applications/Custom "Test"\\.app/Contents/MacOS/Custom Test([[:space:]]|$)',
  ])
  assert.deepEqual(calls[4]?.args, [
    '-e',
    'tell application "/private/Applications/Custom \\"Test\\".app" to quit',
  ])
  assert.deepEqual(calls[7]?.args, ['-a', app])
})

test('real app running is false only on confirmed no-match and otherwise reports unknown', () => {
  const down = injectedSystem([ok('Executable'), { status: 1, stdout: '', stderr: '' }]).system
  assert.equal(down.appRunning(), false)
  for (const result of [
    failed(),
    failed(null),
    ok('nonsense'),
    { status: 1, stdout: '', stderr: 'bad query' },
  ]) {
    assert.throws(
      () => injectedSystem([ok('Executable'), result]).system.appRunning(),
      /running|pgrep/i,
    )
  }
  assert.throws(() => injectedSystem([failed()]).system.appRunning(), /executable|plutil/i)
  assert.throws(() => injectedSystem([ok('../wrong')]).system.appRunning(), /executable/i)
  assert.throws(() => realSystem({ ANYENGINE_CHATGPT_APP: 'relative.app' }), /absolute|bundle/i)
})

test('real quit, open and notifications propagate refusal and timeout state', () => {
  assert.throws(
    () => injectedSystem([ok('Executable'), ok('42'), failed()]).system.quitApp(0),
    /quit|osascript/i,
  )
  const running = injectedSystem([
    ok('Executable'),
    ok('42'),
    ok(),
    ok('Executable'),
    ok('42'),
  ]).system
  assert.equal(running.quitApp(0), false)
  assert.throws(() => injectedSystem([failed()]).system.openApp(), /open/i)
  assert.throws(
    () => injectedSystem([failed(null)]).system.notify('title', 'message'),
    /notification|osascript/i,
  )
  const { system, calls } = injectedSystem([ok()])
  system.notify('Title "quoted"', 'Message\\line\nnext')
  assert.deepEqual(calls[0]?.args, [
    '-e',
    'display notification "Message\\\\line\\nnext" with title "Title \\"quoted\\""',
  ])
})

test('real process producer validates status, full parse, duplicates and start/group identity', () => {
  const row = ' 42 1 42 Thu Oct  1 00:00:00 2026 node /x/adapter.mjs app-server\n'
  const { system, calls } = injectedSystem([ok(row)])
  assert.deepEqual(system.processes(), [
    { ...proc(42, 1, 'node /x/adapter.mjs app-server'), processGroup: 42 },
  ])
  assert.deepEqual(calls[0]?.args, ['-axww', '-o', 'pid=,ppid=,pgid=,lstart=,command='])
  assert.equal(calls[0]?.options?.env?.TZ, 'UTC')
  for (const result of [
    failed(),
    failed(null),
    ok('bad row'),
    ok(row + row),
    ok(''),
    ok('42 1 42 Thu Feb 30 00:00:00 2026 node adapter.mjs'),
    ok(row.replace('42 1 42', '42 1 0')),
    ok(row.replace('42 1 42', '42 1 -1')),
    ok(row.replace('42 1 42', '42 1 unknown')),
    ok(row.replace('42 1 42', '42 1 9007199254740992')),
    ok(row.replace('42 1 42', '42 1')),
  ]) {
    assert.throws(() => injectedSystem([result]).system.processes(), /process|ps/i)
  }
})

test('real execution keeps spawn errors visible and supports stdin', () => {
  const system = realSystem()
  const absent = system.exec('/private/no-such-control-command', [])
  assert.equal(absent.status, null)
  assert.match(absent.stderr, /ENOENT/)
  assert.deepEqual(system.exec('/bin/cat', [], { input: 'input bytes' }), ok('input bytes'))
})

test('hermetic runner refuses every real system tool including process and plist reads', () => {
  const system = realSystem()
  for (const name of ['LAUNCHCTL', 'OSASCRIPT', 'OPEN', 'PGREP', 'PS', 'PLUTIL']) {
    const command = process.env[`ANYENGINE_${name}`]
    assert.ok(command, name)
    assert.ok(command.startsWith(`${process.env.HERMETIC_TEST_ROOT}/bin/`), name)
    assert.equal(system.exec(command, []).status, 1)
  }
  assert.equal(system.launchctl(['print', 'gui/0/test']).status, 1)
  assert.equal(system.appVersion(), null)
  for (const operation of [
    () => system.appRunning(),
    () => system.quitApp(0),
    () => system.openApp(),
    () => system.processes(),
    () => system.notify('test', 'refuse'),
  ]) {
    assert.throws(operation, /refused in tests/)
  }
})

test('fake system carries failure state without publishing successful app or job changes', () => {
  const system = fakeSystem('/private/test')
  system.openError = new Error('open failed')
  system.running = false
  assert.throws(() => system.openApp(), /open failed/)
  assert.equal(system.running, false)
  system.quitResult = false
  system.running = true
  assert.equal(system.quitApp(), false)
  assert.equal(system.running, true)
  system.runningError = new Error('running unknown')
  assert.throws(() => system.appRunning(), /running unknown/)
  system.execs.set('launchctl bootstrap gui/0 job.plist', failed())
  assert.equal(system.launchctl(['bootstrap', 'gui/0', 'job.plist']).status, 2)
  assert.equal(system.jobs.size, 0)
})
