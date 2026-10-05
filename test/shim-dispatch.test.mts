import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { killChildren, spawn, stopProcess } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(() => killChildren())
after(removeTempDirs)

const shim = resolve('scripts/codex-shim')
const sentinel = 'fixture-private-value-do-not-log'

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function fixture() {
  const home = await tempDir('d-')
  const codex = join(home, '.codex')
  const root = join(home, '.anyengine')
  await mkdir(join(codex, 'app-server-control'), { recursive: true })
  await mkdir(root)
  const boundary = join(home, 'boundary.json')
  const closed = join(home, 'closed.json')
  const adapter = join(home, 'adapter.mjs')
  const vendorScript = join(home, 'vendor.mjs')
  const vendor = join(home, 'vendor "quoted"\\binary')
  const code = `
import { writeFileSync } from 'node:fs';
import net from 'node:net';
const argv = process.argv.slice(2);
const kind = process.argv[1].endsWith('adapter.mjs') ? 'adapter' : 'vendor';
if (argv[0] === 'selfcheck') process.exit(0);
if (argv[0] === '--version') { console.log('codex-cli 0.160.0'); process.exit(0); }
writeFileSync(process.env.DISPATCH_BOUNDARY, JSON.stringify({ pid: process.pid, kind, argv }));
console.log(kind + ' boundary');
console.error(kind + ' boundary stderr');
const listen = argv.find(a => a.startsWith('unix://'));
if (kind === 'adapter' && listen) {
  const server = net.createServer();
  const stop = () => {
    clearTimeout(deadline);
    server.close(() => {
      writeFileSync(process.env.DISPATCH_CLOSED, JSON.stringify({ pid: process.pid }));
      process.exit(0);
    });
  };
  server.listen(listen.slice(7));
  const deadline = setTimeout(stop, 30000);
  process.on('SIGTERM', stop);
} else process.exit(kind === 'adapter' ? 23 : 19);
`
  await writeFile(adapter, code)
  await writeFile(vendorScript, code)
  await writeFile(
    vendor,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(vendorScript)} "$@"\n`,
    { mode: 0o755 },
  )
  const runtime = join(root, 'runtime.env')
  await writeFile(
    runtime,
    `export ANYENGINE_RUNTIME_TYPE=anyengine\nexport DISPATCH_CONFIG_VALUE=${quote(sentinel)}\n`,
  )
  const debug = join(home, 'debug.jsonl')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codex,
    ANYENGINE_ROOT: root,
    ANYENGINE_RUNTIME_ENV: runtime,
    ANYENGINE_ADAPTER: adapter,
    ANYENGINE_REAL_CODEX: vendor,
    ANYENGINE_NODE: process.execPath,
    ANYENGINE_MOCK: '1',
    ANYENGINE_COMPAT_VERSION: '0.160.0',
    ANYENGINE_DEBUG_LOG: debug,
    DISPATCH_BOUNDARY: boundary,
    DISPATCH_CLOSED: closed,
    OPENAI_API_KEY: sentinel,
  }
  return { home, codex, root, adapter, vendor, boundary, closed, debug, env }
}

async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  argv: string[],
  extra: NodeJS.ProcessEnv = {},
) {
  const child = spawn('/bin/bash', [shim, ...argv], { env: { ...f.env, ...extra } })
  const exited = once(child, 'exit')
  const completed = once(child, 'close')
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const [status, signal] = await exited
  const record = existsSync(f.boundary) ? JSON.parse(await readFile(f.boundary, 'utf8')) : null
  if (record?.kind === 'adapter' && argv.some((arg) => arg.startsWith('unix://'))) {
    await stopProcess(record.pid)
    assert.deepEqual(JSON.parse(await readFile(f.closed, 'utf8')), { pid: record.pid })
    assert.throws(() => process.kill(record.pid, 0), /ESRCH/, 'the owned Unix fake exited')
  }
  await completed
  assert.equal(signal, null, stderr)
  if (record) assert.deepEqual(record.argv, argv, 'dispatch preserves every original argument')
  return { pid: child.pid, status, stdout, stderr, record }
}

async function dispatch(f: Awaited<ReturnType<typeof fixture>>) {
  const text = existsSync(f.debug) ? await readFile(f.debug, 'utf8') : ''
  assert.equal(text.includes(sentinel), false, 'dispatch never logs config/auth/prompt values')
  const events = text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === 'shim.dispatch')
  assert.equal(events.length, 1, 'one positive shim dispatch decision')
  const event = events[0]
  assert.deepEqual(Object.keys(event).sort(), [
    'adapter',
    'command',
    'event',
    'executable',
    'mode',
    'pid',
    'route',
    'shellKind',
    'ts',
  ])
  assert.equal(event.shellKind, 'bash')
  assert.equal(Number.isFinite(Date.parse(event.ts)), true)
  return event
}

for (const mode of ['codex', 'native-codex', 'real-codex', 'native', 'real']) {
  test(`native ${mode} dispatch identifies the selected binary without changing execution`, async () => {
    const f = await fixture()
    const argv = ['-c', `private=${sentinel}`, 'app-server', '--analytics-default-enabled']
    const result = await run(f, argv, { ANYENGINE_ROUTE: mode })
    assert.equal(result.status, 19)
    assert.equal(result.record.kind, 'vendor')
    assert.equal(result.stdout, 'vendor boundary\n')
    assert.equal(result.stderr, 'vendor boundary stderr\n')
    const event = await dispatch(f)
    assert.equal(event.pid, result.pid)
    assert.equal(event.route, 'native-mode')
    assert.equal(event.command, 'app-server')
    assert.equal(event.mode, 'native')
    assert.equal(event.executable, f.vendor)
    assert.equal(event.adapter, null)
  })
}

test('stdio adapter dispatch keeps globals, output and exit status while normalizing mode', async () => {
  const f = await fixture()
  const argv = ['-c', `private=${sentinel}`, 'app-server', '--listen', 'stdio://']
  const result = await run(f, argv, { ANYENGINE_ROUTE: sentinel })
  assert.equal(result.record.kind, 'adapter')
  assert.equal(result.status, 23)
  assert.equal(result.stdout, 'adapter boundary\n')
  assert.equal(result.stderr, 'adapter boundary stderr\n')
  const event = await dispatch(f)
  assert.equal(event.pid, result.pid)
  assert.equal(event.route, 'adapter-stdio')
  assert.equal(event.command, 'app-server')
  assert.equal(event.mode, 'adapter')
  assert.equal(event.executable, process.execPath)
  assert.equal(event.adapter, f.adapter)
})

for (const helper of [
  { name: 'successful warning', stdout: '', status: 0, adapter: true },
  {
    name: 'published block',
    stdout: 'mandatory update failed: fixture block',
    status: 0,
    adapter: false,
  },
  { name: 'failed read', stdout: '', status: 1, adapter: false },
]) {
  test(`update helper ${helper.name} keeps stderr separate from routing evidence`, async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'state'))
    await writeFile(join(f.root, 'state', 'update-watch.json'), '{}')
    const warning = 'ExperimentalWarning: SQLite is an experimental feature'
    const node = join(f.home, 'node-wrapper')
    await writeFile(
      node,
      `#!/bin/sh\nif [ "$2" = --fallback-reason ]; then\n  printf '%s\\n' ${quote(warning)} >&2\n  printf '%s' ${quote(helper.stdout)}\n  exit ${helper.status}\nfi\nexec ${quote(process.execPath)} "$@"\n`,
      { mode: 0o755 },
    )
    const result = await run(f, ['-c', 'features.code_mode_host=true', 'app-server'], {
      ANYENGINE_NODE: node,
    })
    assert.equal(result.record.kind, helper.adapter ? 'adapter' : 'vendor')
    assert.equal(result.status, helper.adapter ? 23 : 19)
    assert.match(result.stderr, /ExperimentalWarning: SQLite/)
    if (helper.adapter) {
      assert.equal(existsSync(join(f.root, 'shim-fallback.json')), false)
      assert.equal((await dispatch(f)).route, 'adapter-stdio')
      assert.equal(result.stderr.includes('FALLBACK'), false)
    } else {
      const fallback = JSON.parse(await readFile(join(f.root, 'shim-fallback.json'), 'utf8'))
      assert.equal(fallback.reason.includes(warning), false)
      assert.equal(
        fallback.reason,
        helper.status === 0 ? helper.stdout : 'update evidence unavailable: ',
      )
      assert.match(result.stderr, /codex shim: FALLBACK/)
    }
  })
}

test('standard control socket dispatch identifies vendor without changing its arguments', async () => {
  const f = await fixture()
  const argv = [
    'app-server',
    '--listen',
    `unix://${join(f.codex, 'app-server-control/app-server-control.sock')}`,
  ]
  const result = await run(f, argv)
  assert.equal(result.record.kind, 'vendor')
  assert.equal(result.status, 19)
  assert.equal(result.stdout, 'vendor boundary\n')
  assert.match(result.stderr, /control socket needs a native codex child/)
  assert.match(result.stderr, /vendor boundary stderr\n$/)
  const event = await dispatch(f)
  assert.equal(event.pid, result.pid)
  assert.equal(event.route, 'control-socket')
  assert.equal(event.mode, 'adapter')
  assert.equal(event.executable, f.vendor)
  assert.equal(event.adapter, null)
})

for (const standard of [false, true]) {
  test(`Unix adapter dispatch${standard ? ' with native remote opt-in' : ''} keeps its owned launch closed`, async () => {
    const f = await fixture()
    const socket = standard
      ? join(f.codex, 'app-server-control/app-server-control.sock')
      : join(f.home, 'relay.sock')
    const argv = ['-c', `private=${sentinel}`, 'app-server', '--listen', `unix://${socket}`]
    const result = await run(f, argv, { ANYENGINE_REMOTE_NATIVE_CODEX: standard ? '1' : '0' })
    assert.equal(result.record.kind, 'adapter')
    assert.equal(result.status, 0)
    assert.equal(result.stdout, 'adapter boundary\n')
    assert.equal(result.stderr, 'adapter boundary stderr\n')
    const event = await dispatch(f)
    assert.equal(event.pid, result.pid)
    assert.equal(event.route, 'adapter-unix')
    assert.equal(event.command, 'app-server')
    assert.equal(event.executable, process.execPath)
    assert.equal(event.adapter, f.adapter)
  })
}

for (const argv of [
  ['--new-desktop-global', sentinel, 'app-server', '--analytics-default-enabled'],
  ['-c', 'app-server'],
]) {
  test(`unrecognized app-server-intended dispatch reports ${argv[0]} without changing routing`, async () => {
    const f = await fixture()
    const result = await run(f, argv)
    assert.equal(result.record.kind, 'vendor')
    assert.equal(result.status, 19)
    assert.equal(result.stdout, 'vendor boundary\n')
    assert.equal(result.stderr, 'vendor boundary stderr\n')
    const event = await dispatch(f)
    assert.equal(event.pid, result.pid)
    assert.equal(event.route, 'other-command')
    assert.equal(event.command, argv[0] === '-c' ? 'empty' : 'other')
    assert.equal(event.mode, 'adapter')
    assert.equal(event.executable, f.vendor)
    assert.equal(event.adapter, null)
  })
}

for (const destination of ['0', 'false', 'unwritable']) {
  test(`disabled or unwritable dispatch log ${destination} leaves adapter execution unchanged`, async () => {
    const f = await fixture()
    const result = await run(f, ['app-server'], {
      ANYENGINE_DEBUG_LOG: destination === 'unwritable' ? f.home : destination,
    })
    assert.equal(result.record.kind, 'adapter')
    assert.equal(result.status, 23)
    assert.equal(result.stdout, 'adapter boundary\n')
    assert.equal(result.stderr, 'adapter boundary stderr\n')
    assert.equal(existsSync(f.debug), false)
  })
}

for (const argv of [
  ['--version', 'app-server'],
  ['exec', sentinel],
  ['exec', 'app-server'],
  ['--new-desktop-global', sentinel, 'exec'],
  [],
]) {
  test(`${argv[0] ?? 'empty command'} with ${argv[1] === 'app-server' ? 'literal app-server' : 'private input'} remains inert for dispatch metadata`, async () => {
    const f = await fixture()
    const result = await run(f, argv)
    assert.equal(result.status, argv[0] === '--version' ? 0 : 19)
    assert.equal(
      result.stdout,
      argv[0] === '--version' ? 'codex-cli 0.160.0 (anyengine)\n' : 'vendor boundary\n',
    )
    assert.equal(existsSync(f.debug), false)
  })
}

test('native version probe remains inert even with literal app-server in its arguments', async () => {
  const f = await fixture()
  const result = await run(f, ['--version', 'app-server'], { ANYENGINE_ROUTE: 'codex' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'codex-cli 0.160.0\n')
  assert.equal(result.record, null)
  assert.equal(existsSync(f.debug), false)
})
