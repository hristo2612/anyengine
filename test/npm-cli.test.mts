import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { shellQuote } from '../src/control-scripts.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

const cli = resolve('scripts/anyengine-cli.mjs')

test('npm entry exposes help, version and setup without activating hosts', () => {
  for (const args of [[], ['--help'], ['setup', '--help']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /setup/)
    if (args[0] !== 'setup') {
      assert.match(result.stdout, /desktop chatgpt/)
      assert.match(result.stdout, /desktop claude/)
    }
  }
  const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), JSON.parse(readFileSync('package.json', 'utf8')).version)
})

async function entryFixture() {
  const home = await tempDir('npm-claude-entry-')
  const root = join(home, '.anyengine')
  mkdirSync(join(root, 'bin'), { recursive: true })
  const mock = join(home, 'mock-cli.mjs')
  writeFileSync(
    mock,
    [
      'process.stdout.write(JSON.stringify({',
      '  pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(),',
      '  marker: process.env.FIXTURE_MARKER',
      '}))',
      'process.exitCode = 7',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(root, 'bin/anyengine'),
    `#!/bin/bash\nexec ${shellQuote(process.execPath)} ${shellQuote(mock)} "$@"\n`,
    { mode: 0o700 },
  )
  const env = {
    HOME: home,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: process.env.TMPDIR,
    ANYENGINE_ROOT: root,
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    ANYENGINE_HOME: join(home, '.codex/anyengine'),
    ANYENGINE_DEBUG_LOG: join(home, 'debug.jsonl'),
    ANYENGINE_MOCK: '1',
    ANYENGINE_NATIVE_CODEX: '0',
    FIXTURE_MARKER: 'private fixture',
  }
  return { home, root, env }
}

test('public Claude entry retains its PID/argv/cwd/env while other controls retain spawn semantics', {
  skip: !process.execve,
}, async () => {
  const f = await entryFixture()
  for (const subcommand of ['claude', 'status']) {
    const args = [subcommand, '--', 'spaces; $(never-execute)\nsecond line']
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      cwd: f.home,
      env: f.env,
      timeout: 30_000,
    })
    assert.equal(result.status, 7, 'private launcher exit status must be preserved')
    const observed = JSON.parse(result.stdout) as {
      pid: number
      args: string[]
      cwd: string
      marker: string
    }
    if (subcommand === 'claude') assert.equal(observed.pid, result.pid, 'public entry must exec')
    else assert.notEqual(observed.pid, result.pid, 'other controls retain their child process')
    assert.deepEqual(observed.args, args)
    assert.equal(observed.cwd, realpathSync(f.home))
    assert.equal(observed.marker, 'private fixture')
  }
})

test('public Claude entry refuses absent execve while other controls remain available', async () => {
  const f = await entryFixture()
  const preload = 'data:text/javascript,process.execve=undefined'
  const run = (subcommand: string) =>
    spawnSync(process.execPath, ['--import', preload, cli, subcommand], {
      encoding: 'utf8',
      cwd: f.home,
      env: f.env,
      timeout: 30_000,
    })
  const refused = run('claude')
  assert.equal(refused.status, 1)
  assert.equal(refused.stdout, '')
  assert.equal(
    refused.stderr,
    'anyengine: Claude launch requires process.execve on Node.js 24+ (macOS or Linux)\n',
  )
  const other = run('status')
  assert.equal(other.status, 7)
  assert.deepEqual(JSON.parse(other.stdout).args, ['status'])
})

test('invalid interpreter OS failure is isolated and may abort Node instead of reaching catch', {
  skip: !process.execve,
}, async () => {
  const f = await entryFixture()
  const invalid = join(f.home, 'invalid-cli')
  const interpreter = join(f.home, 'missing-interpreter')
  assert.ok(!existsSync(interpreter))
  writeFileSync(invalid, `#!${interpreter}\n`, { mode: 0o700 })
  const config = join(f.root, 'config.json')
  const before = Buffer.from(JSON.stringify({ version: 1, claude: { cli: invalid } }))
  writeFileSync(config, before)
  const result = spawnSync(
    '/bin/bash',
    [
      '-c',
      'ulimit -c 0; exec "$@"',
      'invalid-interpreter-fixture',
      process.execPath,
      resolve('test/fixtures/claude-launch-invalid-interpreter.mjs'),
      f.root,
    ],
    { encoding: 'utf8', cwd: f.home, env: f.env, timeout: 30_000 },
  )
  assert.ok(!result.error, 'isolated fixture must terminate without timeout or spawn error')
  assert.ok(
    result.status === 1 || result.signal === 'SIGABRT',
    'OS exec refusal must terminate: JavaScript catch on newer Node or abort on older Node 24',
  )
  // Deliberately do not promise fixed stderr for a Node/OS abort.
  assert.deepEqual(readFileSync(config), before)
})
