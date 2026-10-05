import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const { setup, RUNTIME_SHELL } = createRequire(import.meta.url)('../../scripts/setup.mjs') as {
  setup: (args: string[], options: Record<string, unknown>) => number
  RUNTIME_SHELL: string
}

async function fixture(failure = '', dirty = false) {
  const source = await tempDir('ae-setup-')
  writeFileSync(join(source, 'package.json'), '{"version":"0.1.0"}\n')
  const home = join(source, 'home')
  mkdirSync(home)
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  const messages: string[] = []
  const options = {
    source,
    platform: 'darwin',
    env: { HOME: home, SHELL: '/bin/zsh', ANYENGINE_ROOT: join(home, 'engine') },
    say: (message: string) => messages.push(message),
    run: (command: string, args: string[], settings: { env: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: settings.env })
      return {
        status: args.includes(failure) ? 1 : 0,
        stdout:
          command === 'git'
            ? args.includes('--porcelain')
              ? dirty
                ? ' M README.md'
                : ''
              : '123456abcdef'
            : '',
      }
    },
  }
  return { source, home, calls, options, messages }
}

test('setup stages before enabling and passes restart consent only when requested', async () => {
  for (const yes of [false, true]) {
    const f = await fixture()
    assert.equal(setup(yes ? ['--yes'] : [], f.options), 0)
    const steps = f.calls.filter((call) => call.command !== 'git')
    assert.deepEqual(
      steps.slice(0, 2).map((call) => call.args),
      [
        ['ci', '--no-audit', '--no-fund'],
        ['run', 'build'],
      ],
    )
    assert.ok(steps[2]?.args.includes('--no-activate'))
    const on = steps[3]
    assert.ok(on)
    assert.equal(on.command, '/bin/bash')
    assert.equal(on.args[3], join(f.home, 'engine/runtime.env'))
    assert.equal(on.args[5], join(f.home, 'engine/lib/0.1.0-123456abcdef/dist/src/adapter.mjs'))
    assert.deepEqual(on.args.slice(6), [
      'on',
      '--lib',
      '0.1.0-123456abcdef',
      '--auto-rollback',
      ...(yes ? ['--yes'] : []),
    ])
    assert.equal(on.env.ANYENGINE_ROOT, join(f.home, 'engine'))
    assert.equal(on.env.ANYENGINE_NODE, process.execPath)
  }
})

test('activation sources legacy runtime aliases before defaults and refuses failed settings', async () => {
  const f = await fixture()
  const file = join(f.home, 'runtime.env')
  const env = { ...process.env }
  for (const name of ['ANYENGINE_RUNTIME_TYPE', 'ANYENGINE_RUNTIME', 'ANYENGINE_BACKEND'])
    delete env[name]
  const probe =
    'console.log(process.env.ANYENGINE_RUNTIME_TYPE ?? process.env.ANYENGINE_RUNTIME ?? process.env.ANYENGINE_BACKEND)'
  const run = () =>
    spawnSync('/bin/bash', ['-c', RUNTIME_SHELL, 'setup', file, process.execPath, '-e', probe], {
      env,
      encoding: 'utf8',
    })
  for (const name of ['ANYENGINE_RUNTIME', 'ANYENGINE_BACKEND']) {
    writeFileSync(file, `export ${name}=agent-http\n`)
    const result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'agent-http')
  }
  writeFileSync(file, '')
  assert.equal(run().stdout.trim(), 'anyengine')
  for (const contents of ['false\n', 'export ANYENGINE_RUNTIME_TYPE="\n']) {
    writeFileSync(file, contents)
    const result = run()
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '', 'failed settings must not reach the adapter')
  }
})

test('npm distribution stages prebuilt code without Git, rebuilding or changing source', async () => {
  const f = await fixture()
  writeFileSync(join(f.source, 'npm-shrinkwrap.json'), '{"lockfileVersion":3}\n')
  assert.equal(setup(['--yes'], f.options), 0)
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls[0]?.args.includes('--no-activate'))
  assert.ok(f.calls.every((call) => call.command !== 'git' && call.command !== 'npm'))
  const on = f.calls[1]
  assert.ok(on)
  assert.equal(on.args[5], join(f.home, 'engine/lib/0.1.0/dist/src/adapter.mjs'))
  assert.ok(on.args.includes('--auto-rollback'))
  assert.ok(on.args.includes('--yes'))
})

test('dirty checkout and failed stages never reach activation', async () => {
  const dirty = await fixture('', true)
  assert.throws(() => setup([], dirty.options), /uncommitted/)
  assert.equal(dirty.calls.length, 1)
  for (const failure of ['ci', 'build', '--no-activate', 'on']) {
    const f = await fixture(failure)
    assert.throws(() => setup(['--yes'], f.options), /failed/)
    if (failure !== 'on') assert.ok(f.calls.every((call) => !call.args.includes('on')))
  }
})

test('stage-only installs no routing and help/invalid arguments make no subprocess calls', async () => {
  const f = await fixture()
  assert.equal(setup(['--stage-only'], f.options), 0)
  assert.ok(f.calls.every((call) => !call.args.includes('on')))
  assert.ok(f.messages.some((line) => line.includes(`ANYENGINE_ROOT='${join(f.home, 'engine')}'`)))
  for (const [args, code] of [
    [['--help'], 0],
    [['--force'], 2],
  ] as const) {
    const g = await fixture()
    assert.equal(setup([...args], g.options), code)
    assert.equal(g.calls.length, 0)
  }
})
