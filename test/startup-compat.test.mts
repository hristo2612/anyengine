import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { markProven, readDegraded, readProof } from '../src/degraded.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(killChildren)
after(removeTempDirs)
const load = () => import('../src/startup-compat.mjs')
const hash = 'a'.repeat(64)
const other = 'b'.repeat(64)
async function setup() {
  const root = await tempDir('startup-compat-')
  let observations = 0
  let fixtures = 0
  const observation = {
    codexPath: '/fake/codex',
    codexVersion: '0.159.0',
    binaryStamp: 'fake:1',
    schemaHash: hash,
  }
  const deps = {
    identity: () => ({ lib: '/fake/lib@v1', suite: hash }),
    observe: () => {
      observations++
      return { ...observation }
    },
    fixtures: () => {
      fixtures++
    },
    selected: () => observation.codexPath,
    stamp: () => observation.binaryStamp,
    now: () => new Date('2026-10-03T12:00:00Z'),
  }
  return { root, deps, observation, counts: () => [observations, fixtures] }
}

test('startup observes every start but only reuses fixtures for the same lib/suite/hash', async () => {
  const { checkStartupCompatibility } = await load()
  const h = await setup()
  assert.equal((await checkStartupCompatibility(h.root, h.deps)).kind, 'admit')
  assert.equal((await checkStartupCompatibility(h.root, h.deps)).kind, 'admit')
  assert.deepEqual(h.counts(), [2, 1])
  h.deps.identity = () => ({ lib: '/fake/lib@v2', suite: hash })
  assert.equal((await checkStartupCompatibility(h.root, h.deps)).kind, 'admit')
  assert.deepEqual(h.counts(), [3, 2])
})

test('concurrent startup verifiers can publish the same observed library and schema', async () => {
  const { checkStartupCompatibility, publishState } = await load()
  const h = await setup()
  h.deps.fixtures = () => {
    mkdirSync(join(h.root, 'state'), { recursive: true })
    publishState(join(h.root, 'state/startup-compat.json'), {
      format: 1,
      ...h.deps.identity(),
      ...h.observation,
      checkedAt: h.deps.now().toISOString(),
    })
  }
  const same = await checkStartupCompatibility(h.root, h.deps)
  assert.equal(same.kind, 'admit', JSON.stringify(same))
  h.deps.identity = () => ({ lib: '/fake/lib@v2', suite: hash })
  h.deps.fixtures = () => {
    publishState(join(h.root, 'state/startup-compat.json'), {
      format: 1,
      lib: '/fake/foreign-lib',
      suite: hash,
      ...h.observation,
      checkedAt: h.deps.now().toISOString(),
    })
  }
  assert.equal((await checkStartupCompatibility(h.root, h.deps)).kind, 'fallback')
})

test('same-version schema drift removes native proof before admission', async () => {
  const { checkStartupCompatibility } = await load()
  const h = await setup()
  await checkStartupCompatibility(h.root, h.deps)
  markProven(h.root, 'native-fanout', 'prior authentic proof', {
    lib: 'v1',
    appVersion: '26.930.1',
    codexVersion: '0.159.0',
    settings: 'a1',
  })
  h.observation.schemaHash = other
  h.deps.fixtures = () => {}
  assert.equal((await checkStartupCompatibility(h.root, h.deps)).kind, 'admit')
  assert.equal(readProof(h.root, 'native-fanout'), null)
  assert.ok(readDegraded(h.root).paths['native-fanout'])
})

test('failed fixture preserves successful cache and a same-version retry can pass', async () => {
  const { checkStartupCompatibility } = await load()
  const h = await setup()
  await checkStartupCompatibility(h.root, h.deps)
  const file = join(h.root, 'state/startup-compat.json')
  const before = readFileSync(file)
  h.observation.schemaHash = other
  h.deps.fixtures = () => {
    throw new Error('unmapped enum')
  }
  assert.equal((await checkStartupCompatibility(h.root, h.deps)).kind, 'fallback')
  assert.deepEqual(readFileSync(file), before)
  h.deps.fixtures = () => {}
  assert.equal((await checkStartupCompatibility(h.root, h.deps)).kind, 'admit')
})

test('invalid UTF-8 successful state is retained and cannot admit or be overwritten', async () => {
  const { checkStartupCompatibility } = await load()
  const h = await setup()
  mkdirSync(join(h.root, 'state'))
  const file = join(h.root, 'state/startup-compat.json')
  const corrupt = Buffer.from('{"lib":"\xff"}', 'latin1')
  writeFileSync(file, corrupt)
  const result = await checkStartupCompatibility(h.root, h.deps)
  assert.equal(result.kind, 'fallback')
  assert.deepEqual(readFileSync(file), corrupt)
})

test('binary replacement before publication refuses admission', async () => {
  const { checkStartupCompatibility } = await load()
  const h = await setup()
  h.deps.fixtures = () => {
    h.observation.binaryStamp = 'fake:2'
  }
  assert.equal((await checkStartupCompatibility(h.root, h.deps)).kind, 'fallback')
})

test('canonical schema hashing preserves definitions and array order, ignores object/file order', () => {
  const { canonicalSchemaHash } = createRequire(import.meta.url)(
    '../../scripts/lib/startup-schema.mjs',
  )
  const a = {
    'b.json': { z: 1, a: ['a', 'b'] },
    'codex_app_server_protocol.v2.schemas.json': { definitions: {} },
  }
  const b = {
    'codex_app_server_protocol.v2.schemas.json': { definitions: {} },
    'b.json': { a: ['a', 'b'], z: 1 },
  }
  assert.equal(canonicalSchemaHash(a), canonicalSchemaHash(b))
  b['b.json'].a.reverse()
  assert.notEqual(canonicalSchemaHash(a), canonicalSchemaHash(b))
  assert.throws(() => canonicalSchemaHash({ 'b.json': {} }), /missing/)
})

async function rejectedLaunch(listen: string, shim = false) {
  const root = await tempDir('startup-launch-')
  const binary = join(root, 'fake-codex.mjs')
  writeFileSync(
    binary,
    `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('codex-cli 0.159.0'); process.exit(0) }\nif (process.argv.some(a => a.startsWith('generate-'))) process.exit(0)\nlet input=''; process.stdin.on('data', c => input+=c); process.stdin.on('end', () => { console.log(JSON.stringify({args:process.argv.slice(2),input})); process.exitCode=23 })\n`,
  )
  chmodSync(binary, 0o755)
  if (listen === 'unix') listen = `unix://${join(root, 's')}`
  const args = ['-c', 'literal=$unexpanded', 'app-server', '--listen', listen]
  const child = spawn(
    shim ? resolve('scripts/codex-shim') : process.execPath,
    shim ? args : [resolve('dist/src/adapter.mjs'), ...args],
    {
      env: {
        ...process.env,
        ANYENGINE_MOCK: '0',
        ANYENGINE_REAL_CODEX: binary,
        ANYENGINE_NODE: process.execPath,
        ANYENGINE_ADAPTER: resolve('dist/src/adapter.mjs'),
        ANYENGINE_RUNTIME_ENV: '/dev/null',
        ANYENGINE_ROOT: root,
        ANYENGINE_HOME: join(root, 'adapter-state'),
        ANYENGINE_NATIVE_CODEX: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  let out = ''
  let err = ''
  child.stdout!.on('data', (c) => {
    out += c
  })
  child.stderr!.on('data', (c) => {
    err += c
  })
  const closed = once(child, 'close')
  const timer = setTimeout(() => child.kill('SIGTERM'), 35_000)
  child.stdin!.end('original unread stdin\n')
  const [code] = await closed.finally(() => clearTimeout(timer))
  return { root, args, code, out, err }
}
test('direct stdio rejection delegates original argv and untouched stdin with vendor exit status', async () => {
  const result = await rejectedLaunch('stdio://')
  assert.equal(result.code, 23, result.err)
  assert.deepEqual(JSON.parse(result.out), { args: result.args, input: 'original unread stdin\n' })
  assert.match(result.err, /anyengine-startup-failure/)
  assert.equal(existsSync(join(result.root, 'adapter-state')), false)
})
test('direct WS rejection fails closed before operational state or unauthenticated replacement', async () => {
  const result = await rejectedLaunch('ws://127.0.0.1:0')
  assert.equal(result.code, 78, result.err)
  assert.equal(result.out, '')
  assert.match(result.err, /direct-cli-required/)
  assert.equal(existsSync(join(result.root, 'adapter-state')), false)
})

test('Unix shim joins one delegated vendor launch and returns its actual exit without pid/socket artifacts', async () => {
  const result = await rejectedLaunch('unix', true)
  assert.equal(result.code, 23, result.err)
  const rows = result.out
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(rows, [{ args: result.args, input: '' }])
  assert.equal(existsSync(join(result.root, 's')), false)
  assert.equal(existsSync(join(result.root, 's.pid')), false)
  assert.equal(existsSync(join(result.root, 'adapter-state')), false)
  assert.equal(
    JSON.parse(readFileSync(join(result.root, 'shim-fallback.json'), 'utf8')).delegation,
    'complete',
  )
})

test('startup allocates 20 s observation/fixtures and refuses publication after the total deadline', async () => {
  const { checkStartupCompatibility, STARTUP_WAIT_MS } = await load()
  const h = await setup()
  let elapsed = 0
  let allowed = 0
  const deps = {
    ...h.deps,
    monotonic: () => elapsed,
    observe: (_path: string, budget: number) => {
      allowed = budget
      elapsed = 19_999
      return h.observation
    },
    fixtures: () => {
      elapsed = 30_001
    },
  }
  const result = await checkStartupCompatibility(h.root, deps)
  assert.equal(allowed, 20_000)
  assert.equal(STARTUP_WAIT_MS, 35_000)
  assert.equal(result.kind, 'fallback')
  assert.equal(existsSync(join(h.root, 'state/startup-compat.json')), false)
  assert.equal(existsSync(join(h.root, 'state/startup-failure.json')), false)
})

test('private launch publication must precede any child; stale, missing, foreign and malformed results refuse retry', async () => {
  const root = await tempDir('startup-diagnostic-')
  const helper = resolve('scripts/lib/startup-schema.mjs')
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8' })
  const adapter = join(root, 'fake-adapter.mjs')
  const encoded = Buffer.from(adapter).toString('base64')
  const touched = join(root, 'launched')
  writeFileSync(
    adapter,
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(touched)},'yes');process.exitCode=23`,
  )
  const path = join(root, 'result.json')
  const bad = Buffer.from('{"reason":"\xff"}', 'latin1')
  writeFileSync(path, bad)
  assert.equal(run('--launch', path, encoded).status, 1)
  assert.equal(existsSync(touched), false, 'existing result must not admit an unrecorded child')
  assert.deepEqual(readFileSync(path), bad)
  assert.equal(run('--launch-result', path, String(process.pid)).status, 2)
  assert.equal(run('--launch', join(root, 'absent/result.json'), encoded).status, 1)
  assert.equal(existsSync(touched), false, 'publication I/O failure must precede launch')
  const good = join(root, 'fresh.json')
  assert.equal(run('--launch', good, encoded).status, 23)
  const result = JSON.parse(readFileSync(good, 'utf8'))
  assert.equal(result.cleanup, 'complete')
  assert.equal(
    run('--launch-result', good, String(result.launcher)).status,
    1,
    'known no delegation may use shim fallback',
  )
  assert.equal(run('--launch-result', good, String(result.launcher + 1)).status, 2)
  for (const field of ['adapter', 'status', 'signal', 'interrupted']) {
    const partial = { ...result }
    delete partial[field]
    writeFileSync(good, JSON.stringify(partial))
    assert.equal(run('--launch-result', good, String(result.launcher)).status, 2)
  }
  writeFileSync(good, JSON.stringify({ version: 1, launcher: result.launcher, phase: 'pending' }))
  assert.equal(run('--launch-result', good, String(result.launcher)).status, 2)
  const diagnostic = join(root, 'shim-fallback.json')
  writeFileSync(diagnostic, bad)
  assert.equal(
    run(
      '--record-fallback',
      root,
      JSON.stringify({
        event: 'shim.fallback',
        reason: 'valid \ufffd',
        ts: new Date().toISOString(),
      }),
    ).status,
    1,
  )
  assert.deepEqual(readFileSync(diagnostic), bad)
})

test('a delegation pending without vendor ownership retains unknown cleanup', async () => {
  const root = await tempDir('startup-pending-')
  const helper = resolve('scripts/lib/startup-schema.mjs')
  const adapter = join(root, 'pending-adapter.mjs')
  const resultPath = join(root, 'result.json')
  writeFileSync(
    adapter,
    `process.send({kind:'anyengine-startup-delegation',phase:'pending'},()=>process.exit(23))`,
  )
  const result = spawnSync(
    process.execPath,
    [helper, '--launch', resultPath, Buffer.from(adapter).toString('base64')],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 1)
  const record = JSON.parse(readFileSync(resultPath, 'utf8'))
  assert.equal(record.delegated, true)
  assert.equal(record.cleanup, 'unknown')
  assert.equal(record.status, 23, 'actual child status remains diagnostic evidence')
  assert.equal(
    spawnSync(process.execPath, [helper, '--launch-result', resultPath, String(record.launcher)])
      .status,
    2,
  )
})

test('schema observer hashes every generated JSON artifact, uses the short version budget and runs shipped validators without regenerating', async () => {
  const { observeSchema, validateFixtures } = createRequire(import.meta.url)(
    '../../scripts/lib/startup-schema.mjs',
  )
  const root = await tempDir('schema-observation-')
  const binary = join(root, 'codex')
  writeFileSync(binary, 'fake binary identity')
  let sequence = 0
  let changed = false
  const budgets: number[] = []
  const run = (
    _binary: string,
    command: string[] | ((dirs: { work: string }) => string[]),
    options: {
      timeoutMs: number
      read?: (dirs: { work: string }, answer: { status: number }) => unknown
    },
  ) => {
    budgets.push(options.timeoutMs)
    const work = join(root, `work-${sequence++}`)
    mkdirSync(work)
    const args = typeof command === 'function' ? command({ work }) : command
    if (args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.159.0\n', stderr: '' }
    if (args.includes('generate-json-schema')) {
      writeFileSync(
        join(work, 'codex_app_server_protocol.v2.schemas.json'),
        readFileSync(resolve('test/fixtures/posture-schema.json')),
      )
      writeFileSync(join(work, 'extra.json'), JSON.stringify({ unseen: changed ? 2 : 1 }))
    } else {
      writeFileSync(
        join(work, 'ClientRequest.ts'),
        ['initialize', 'thread/start', 'config/read', 'mcpServerStatus/list']
          .map((method) => `"method": "${method}"`)
          .join('\n'),
      )
      writeFileSync(
        join(work, 'ServerNotification.ts'),
        ['turn/started', 'turn/completed'].map((method) => `"method": "${method}"`).join('\n'),
      )
    }
    return { status: 0, stdout: '', stderr: '', value: options.read?.({ work }, { status: 0 }) }
  }
  const first = observeSchema(binary, 20_000, run)
  await validateFixtures(first, resolve('.'))
  assert.equal(sequence, 3, 'validators consume the observed artifacts')
  assert.ok(budgets[0]! <= 2000)
  assert.ok(budgets.every((value) => value <= 20_000))
  changed = true
  const second = observeSchema(binary, 20_000, run)
  assert.notEqual(
    first.schemaHash,
    second.schemaHash,
    'extra generated artifact is part of the hash',
  )
  await assert.rejects(
    validateFixtures(
      { ...second, types: { 'ClientRequest.ts': '', 'ServerNotification.ts': '' } },
      resolve('.'),
    ),
    /missing/,
  )
  assert.throws(
    () => observeSchema(binary, 20_000, () => ({ status: 1, stdout: '', stderr: 'timeout' })),
    /timeout/,
  )
})

test('M2 suite identity includes immutable capture fixtures while an M1 source remains compatible', async () => {
  const { REQUIRED_HELPERS, REQUIRED_FIXTURES, REQUIRED_M2_FIXTURES, suiteIdentity } =
    createRequire(import.meta.url)('../../scripts/lib/startup-schema.mjs')
  assert.deepEqual(REQUIRED_M2_FIXTURES, [
    'test/fixtures/codex-auth-0.160.0.json',
    'test/fixtures/claude-messages-2.1.289.json',
    'test/fixtures/claude-posture-2.1.289.json',
    'test/fixtures/raine-translation-v0.1.42.json',
  ])
  const lib = await tempDir('m2-suite-')
  for (const name of [...REQUIRED_HELPERS, ...REQUIRED_FIXTURES]) {
    mkdirSync(join(lib, name, '..'), { recursive: true })
    cpSync(resolve(name), join(lib, name))
  }
  const m1 = suiteIdentity(lib)
  for (const name of REQUIRED_M2_FIXTURES) {
    mkdirSync(join(lib, name, '..'), { recursive: true })
    cpSync(resolve(name), join(lib, name))
  }
  assert.equal(suiteIdentity(lib), m1, 'M2 files alone do not turn a legacy M1 source into M2')
  writeFileSync(join(lib, 'dist/src/control-claude-layer.mjs'), '')
  const m2 = suiteIdentity(lib)
  assert.notEqual(m2, m1)
  for (const name of REQUIRED_M2_FIXTURES) {
    const bytes = readFileSync(join(lib, name))
    writeFileSync(join(lib, name), Buffer.concat([bytes, Buffer.from('\n')]))
    assert.notEqual(suiteIdentity(lib), m2, `same-version fixture edits invalidate ${name}`)
    writeFileSync(join(lib, name), bytes)
    rmSync(join(lib, name))
    assert.throws(() => suiteIdentity(lib), /ENOENT|required artifact/)
    writeFileSync(join(lib, name), bytes)
  }
  assert.equal(suiteIdentity(lib), m2)
})
