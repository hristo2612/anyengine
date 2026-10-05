import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const { setup } = createRequire(import.meta.url)('../../scripts/setup.mjs') as {
  setup: (args: string[], options: Record<string, unknown>) => number
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
    assert.equal(on.args[0], join(f.home, 'engine/lib/0.1.0-123456abcdef/dist/src/adapter.mjs'))
    assert.deepEqual(on.args.slice(1), [
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
