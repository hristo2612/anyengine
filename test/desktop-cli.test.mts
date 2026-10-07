import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { readConfig } from '../src/anyengine-config.mjs'
import { registerCommand, runControl } from '../src/control-cli.mjs'
import { flipCommand } from '../src/control-flip-run.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
await import('../src/control-commands.mjs')

async function fixture() {
  const home = await tempDir('anyengine-desktop-cli-')
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const run = async (args: string[]) => {
    let output = ''
    const code = await runControl(args, system, root, (text) => {
      output += text
    })
    return { code, output }
  }
  return { home, root, system, run }
}

test('ChatGPT aliases pass lifecycle flags and failures unchanged to the shared controls', async (t) => {
  const f = await fixture()
  for (const verb of ['on', 'off', 'restart'] as const) {
    const flags = ['--yes', '--foreground', '--no-follow', '--wait-quiet', '7']
    if (verb === 'on') flags.push('--lib', 'test-lib', '--auto-rollback')
    if (verb === 'off') flags.push('--router-only')
    registerCommand(verb, async (args, system, root, say) => {
      assert.deepEqual(args, flags)
      assert.equal(system, f.system)
      assert.equal(root, f.root)
      say('existing control refused')
      return 1
    })
    t.after(() => registerCommand(verb, flipCommand(verb)))
    assert.deepEqual(await f.run(['desktop', 'chatgpt', verb, ...flags]), {
      code: 1,
      output: 'existing control refused',
    })
  }
  assert.equal(existsSync(f.root), false)
  assert.deepEqual(f.system.calls, [])
})

test('ChatGPT status is the existing core report and doctor keeps argument validation', async () => {
  const f = await fixture()
  const original = await f.run(['status', '--json'])
  const named = await f.run(['desktop', 'chatgpt', 'status', '--json'])
  assert.equal(named.code, original.code)
  assert.deepEqual(JSON.parse(named.output), JSON.parse(original.output))
  assert.deepEqual(
    await f.run(['desktop', 'chatgpt', 'doctor', '--invalid']),
    await f.run(['doctor', '--invalid']),
  )
  assert.equal(existsSync(f.root), false)
})

test('named Claude tools interoperate with legacy commands without enabling other options', async () => {
  const f = await fixture()
  assert.equal((await f.run(['desktop', 'claude', 'tools', 'on'])).code, 0)
  const target = join(f.home, 'Library/Application Support/Claude/claude_desktop_config.json')
  const entry = JSON.parse(readFileSync(target, 'utf8')).mcpServers.anyengine
  assert.ok(entry.args[0].endsWith('/scripts/desktop-mcp.mjs'))
  const status = await f.run(['desktop', 'status', '--json'])
  assert.equal(status.code, 0)
  assert.equal(JSON.parse(status.output).enabled, true)
  assert.equal(readConfig(f.root).config.sessions.desktopAccounts, false)
  assert.equal(existsSync(join(f.root, 'recovery/claude-desktop/picker.json')), false)
  assert.equal((await f.run(['desktop', 'off'])).code, 0)
  assert.equal(existsSync(target), false)
  assert.deepEqual(f.system.calls, [])
})

test('named Claude sessions retain their independent setting and legacy undo', async () => {
  const f = await fixture()
  assert.equal((await f.run(['desktop', 'claude', 'sessions', 'on', '--json'])).code, 0)
  assert.equal(readConfig(f.root).config.sessions.desktopAccounts, true)
  assert.equal(readConfig(f.root).config.sessions.enabled, false)
  const status = await f.run(['desktop', 'sessions', 'status', '--json'])
  assert.equal(status.code, 0)
  assert.equal(JSON.parse(status.output).enabled, true)
  assert.equal((await f.run(['desktop', 'sessions', 'off'])).code, 0)
  assert.equal(readConfig(f.root).config.sessions.desktopAccounts, false)
  assert.equal(existsSync(join(f.home, 'Library/Application Support/Claude')), false)
  assert.deepEqual(f.system.calls, [])
})

test('named Claude picker status matches the old alias without changing app settings', async () => {
  const f = await fixture()
  assert.deepEqual(
    await f.run(['desktop', 'claude', 'picker', 'status', '--json']),
    await f.run(['desktop', 'picker', 'status', '--json']),
  )
  assert.equal(existsSync(join(f.home, 'Library')), false)
  assert.deepEqual(f.system.calls, [])
})

test('invalid app and feature combinations cannot fall through to another toggle', async () => {
  const f = await fixture()
  for (const args of [
    ['desktop'],
    ['desktop', 'chatgpt', 'picker', 'on'],
    ['desktop', 'grok', 'on'],
    ['desktop', 'claude', 'on'],
    ['desktop', 'claude', 'tools'],
    ['desktop', 'claude', 'tools', 'picker', 'on'],
    ['desktop', 'claude', 'tools', 'sessions', 'on'],
    ['desktop', 'claude', 'sessions', 'on', '--invalid'],
  ]) {
    assert.equal((await f.run(args)).code, 2, args.join(' '))
  }
  assert.equal(existsSync(f.root), false)
  assert.equal(existsSync(join(f.home, 'Library')), false)
  assert.deepEqual(f.system.calls, [])
})

test('Desktop help exposes both app names and legacy aliases without inspecting hosts', async () => {
  const f = await fixture()
  for (const flag of ['--help', '-h']) {
    const result = await f.run(['desktop', flag])
    assert.equal(result.code, 0)
    assert.match(result.output, /desktop chatgpt/)
    assert.match(result.output, /desktop claude picker/)
    assert.match(result.output, /desktop claude tools/)
    assert.match(result.output, /desktop claude sessions/)
    assert.match(result.output, /aliases:/)
  }
  assert.equal(existsSync(f.root), false)
  assert.deepEqual(f.system.calls, [])
})
