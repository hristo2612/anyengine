import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import test, { after } from 'node:test'
import {
  type ClaudeLaunchDeps,
  createClaudeLaunchCommand,
  planClaudeLaunch,
} from '../src/control-claude-launch.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

const overlay = '{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}'
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
function harness() {
  const calls: { executable: string; args: string[] }[] = []
  let environmentInherited = false
  const deps: ClaudeLaunchDeps = {
    execve(executable, args, env) {
      calls.push({ executable, args })
      environmentInherited = env === process.env
    },
  }
  return { calls, deps, environmentInherited: () => environmentInherited }
}
async function fixture(configured?: string | null) {
  const home = await tempDir('control-claude-launch-')
  const cli = configured === undefined ? join(home, "Claude Code's bin", 'claude') : configured
  if (configured === undefined && cli) {
    mkdirSync(join(cli, '..'), { recursive: true })
    writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  }
  const root = join(home, '.anyengine')
  mkdirSync(root)
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, claude: { cli } }))
  const settings = join(home, '.claude/settings.json')
  mkdirSync(join(home, '.claude'))
  writeFileSync(
    settings,
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18765', USER_OWNED: 'fixture' },
      model: 'gpt-fixture',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'fixture-hook' }] }] },
      permissions: { defaultMode: 'default', deny: ['Bash(fixture-denial)'] },
      modelPicker: [{ id: 'gpt-fixture', userOwned: true }],
    }),
  )
  const files = [join(root, 'config.json'), settings]
  for (const name of ['.claude.json', '.claude/.credentials.json']) {
    const path = join(home, name)
    writeFileSync(path, JSON.stringify({ fixture: name }))
    files.push(path)
  }
  const before = files.map((path) => readFileSync(path))
  return {
    root,
    cli,
    system: fakeSystem(home),
    unchanged() {
      for (const [i, path] of files.entries()) assert.deepEqual(readFileSync(path), before[i], path)
    },
  }
}

for (const args of [[], ['--native'], ['--native', '--'], ['--']]) {
  test(`native overlay is exact with wrapper arguments ${JSON.stringify(args)}`, () => {
    assert.deepEqual(planClaudeLaunch(args), {
      mode: 'native',
      args: ['--settings', overlay],
    })
  })
}

test('native forwarding keeps bytes, argv boundaries, settings sources and permission flags', () => {
  const args = [
    '--model',
    'sonnet',
    '--setting-sources',
    'user,project,local',
    '--permission-mode',
    'default',
    '--append-system-prompt',
    '--settings',
    '--remote-control',
    'Systems on jimmy',
    '--',
    'remote-control',
    '--settings=literal prompt',
    'spaces; $(never-execute)\nsecond line',
  ]
  const before = [...args]
  const plan = planClaudeLaunch(['--', ...args])
  assert.deepEqual(plan, { mode: 'native', args: ['--settings', overlay, ...args] })
  assert.deepEqual(args, before)
})

test('routed mode forwards custom settings and GPT selections without an overlay', () => {
  const args = ['--model', 'gpt-fixture[1m]', '--settings', './user owned.json', '-p', 'hi']
  assert.deepEqual(planClaudeLaunch(['--routed', '--', ...args]), { mode: 'routed', args })
})

for (const args of [
  ['--settings', '{}'],
  ['--settings={}'],
  ['--model', 'sonnet', '--settings', '/fixture/custom.json'],
  ['prompt', '--settings={}'],
]) {
  test(`native refuses conflicting settings ${JSON.stringify(args)}`, () => {
    assert.throws(() => planClaudeLaunch(['--', ...args]), /reserves --settings/)
  })
}

for (const args of [
  ['remote-control'],
  ['--model', 'sonnet', 'remote-control'],
  ['--routed', '--', 'remote-control'],
]) {
  test(`standalone server gives interactive guidance ${JSON.stringify(args)}`, () => {
    assert.throws(
      () => planClaudeLaunch(args),
      /standalone remote-control.*anyengine claude -- --remote-control/,
    )
  })
}

for (const args of [
  ['--model', 'gpt-fixture'],
  ['--model=gpt-fixture[1m]'],
  ['--agent', 'gpt-fixture'],
  ['--fallback-model=GPT-fixture'],
]) {
  test(`native explicit GPT selection requires routed mode ${JSON.stringify(args)}`, () => {
    assert.throws(() => planClaudeLaunch(['--', ...args]), /GPT selections require.*--routed/)
  })
}

for (const flag of ['--append-system-prompt', '--system-prompt', '--model']) {
  test(`command-like ${flag} values remain opaque`, () => {
    const args = [flag, 'remote-control']
    assert.deepEqual(planClaudeLaunch(['--', ...args])?.args, ['--settings', overlay, ...args])
  })
}

test('Remote Control session names and literal flags after Claude delimiter stay opaque', () => {
  const args = ['--remote-control', 'remote-control', '--', '--settings', '{}']
  assert.deepEqual(planClaudeLaunch(['--', ...args])?.args, ['--settings', overlay, ...args])
})

for (const args of [
  ['--native', '--routed'],
  ['--routed', '--native'],
  ['--native', '--native'],
]) {
  test(`duplicate wrapper mode is refused ${JSON.stringify(args)}`, () => {
    assert.throws(() => planClaudeLaunch(args), /choose exactly one/)
  })
}

test('wrapper help never reads config or executes; Claude help is forwarded after --', async () => {
  const h = harness()
  let output = ''
  const command = createClaudeLaunchCommand(h.deps)
  assert.equal(
    await command(['--help'], fakeSystem('/fixture'), '/missing', (s) => (output += s)),
    0,
  )
  assert.match(output, /bare claude is unchanged/)
  assert.equal(h.calls.length, 0)
  assert.deepEqual(planClaudeLaunch(['--', '--help'])?.args, ['--settings', overlay, '--help'])
})

test('registered dispatch exposes native help without launching Claude', async () => {
  const { CONTROL_COMMANDS, runControl } = await import('../src/control-cli.mjs')
  const f = await fixture()
  let output = ''
  assert.ok(CONTROL_COMMANDS.has('claude'))
  assert.equal(await runControl(['claude', '--help'], f.system, f.root, (s) => (output += s)), 0)
  assert.match(output, /--native \| --routed/)
  assert.match(output, /--remote-control/)
  f.unchanged()
})

test('exec replaces the configured executable with exact argv/env and preserves cwd/settings', async () => {
  const f = await fixture()
  const h = harness()
  const envBefore = JSON.stringify(process.env)
  const cwdBefore = process.cwd()
  const listeners = signals.map((signal) => process.listenerCount(signal))
  const args = ['--remote-control', 'Systems', '--', 'spaces; $(never-execute)\nsecond line']
  assert.equal(
    await createClaudeLaunchCommand(h.deps)(['--', ...args], f.system, f.root, () => {}),
    0,
  )
  assert.deepEqual(h.calls, [{ executable: f.cli, args: [f.cli, '--settings', overlay, ...args] }])
  // Assert only booleans, never environment objects that failure output could expose.
  assert.ok(h.environmentInherited(), 'exec must receive the current environment object')
  assert.ok(JSON.stringify(process.env) === envBefore, 'environment changed')
  assert.equal(process.cwd(), cwdBefore)
  for (const [index, signal] of signals.entries())
    assert.equal(process.listenerCount(signal), listeners[index], 'no signal broker is installed')
  f.unchanged()
})

test('routed exec resolves PATH in order, skipping directories/nonexecutables, and retains GPT args', async () => {
  const f = await fixture(null)
  const h = harness()
  const directory = join(f.system.home, 'path bins/directory')
  const denied = join(f.system.home, 'path bins/not executable')
  const selected = join(f.system.home, 'path bins/executable')
  const dirs = [directory, denied, selected]
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
  mkdirSync(join(directory, 'claude'))
  writeFileSync(join(denied, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o600 })
  const cli = join(selected, 'claude')
  writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const previousPath = process.env.PATH
  process.env.PATH = dirs.join(delimiter)
  try {
    const args = [
      '--model',
      'gpt-fixture',
      '--settings',
      './user owned.json',
      '-p',
      'a quoted prompt',
    ]
    assert.equal(
      await createClaudeLaunchCommand(h.deps)(
        ['--routed', '--', ...args],
        f.system,
        f.root,
        () => {},
      ),
      0,
    )
    assert.deepEqual(h.calls, [{ executable: cli, args: [cli, ...args] }])
    assert.ok(h.environmentInherited())
    f.unchanged()
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
})

for (const kind of ['missing', 'not executable', 'directory'] as const) {
  test(`configured ${kind} executable refuses replacement without falling back to PATH`, async () => {
    const f = await fixture()
    assert.ok(f.cli)
    if (kind === 'not executable') chmodSync(f.cli, 0o600)
    else {
      unlinkSync(f.cli)
      if (kind === 'directory') mkdirSync(f.cli)
    }
    const h = harness()
    let output = ''
    assert.equal(
      await createClaudeLaunchCommand(h.deps)([], f.system, f.root, (s) => (output += s)),
      1,
    )
    assert.equal(h.calls.length, 0)
    assert.equal(
      output,
      'claude: could not start the configured executable; check claude.cli and PATH\n',
    )
    f.unchanged()
  })
}

test('execve failure returns a fixed diagnostic without echoing sensitive argv/errors', async () => {
  const f = await fixture()
  const h = harness()
  h.deps.execve = () => {
    throw new Error('fixture-private-error')
  }
  let output = ''
  const listeners = signals.map((signal) => process.listenerCount(signal))
  assert.equal(
    await createClaudeLaunchCommand(h.deps)(
      ['--', '-p', 'fixture-private-prompt'],
      f.system,
      f.root,
      (s) => (output += s),
    ),
    1,
  )
  assert.equal(
    output,
    'claude: could not start the configured executable; check claude.cli and PATH\n',
  )
  for (const [index, signal] of signals.entries())
    assert.equal(process.listenerCount(signal), listeners[index])
  f.unchanged()
})

test('unavailable process replacement refuses with bounded platform guidance and no fallback', async () => {
  const f = await fixture()
  let output = ''
  assert.equal(
    await createClaudeLaunchCommand({ execve: undefined })(
      [],
      f.system,
      f.root,
      (s) => (output += s),
    ),
    1,
  )
  assert.equal(
    output,
    'claude: direct launch requires process.execve on Node.js 24+ (macOS or Linux)\n',
  )
  f.unchanged()
})

test('invalid saved config and rejected arguments cannot execute', async () => {
  const f = await fixture()
  const h = harness()
  const command = createClaudeLaunchCommand(h.deps)
  assert.equal(await command(['--settings={}'], f.system, f.root, () => {}), 2)
  writeFileSync(join(f.root, 'config.json'), '{broken')
  assert.equal(await command([], f.system, f.root, () => {}), 1)
  assert.equal(h.calls.length, 0)
})
