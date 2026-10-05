import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { setConfigValue } from '../src/anyengine-config.mjs'
import { installClaudeCode } from '../src/control-claude.mjs'
import { restoreDown, retireUpgrade } from '../src/control-flip-recovery.mjs'
import { applyOnFiles } from '../src/control-install.mjs'
import { readLayers } from '../src/control-layers.mjs'
import { needsMilestoneBaseline } from '../src/control-m2-upgrade.mjs'
import { setup } from './helpers/flip-controller.mjs'
import { fakeLib, pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)

test('fresh Claude face supports last-good update recovery, full off, and failed initial activation rollback', async () => {
  const s = await setup()
  for (const name of readdirSync(s.root))
    if (name.startsWith('rollback-')) rmSync(join(s.root, name), { recursive: true })
  unlinkSync(join(s.root, 'lib/current'))
  rmSync(join(s.home, 'bin/codex'))
  const original = 'export KEEP=yes\n'
  writeFileSync(join(s.home, '.zshrc'), original)
  mkdirSync(join(s.plan.libDir, 'dist/src'), { recursive: true })
  writeFileSync(join(s.plan.libDir, 'dist/src/control-claude-layer.mjs'), '// fixture marker\n')
  let models = [
    {
      id: 'gpt-fixture',
      label: 'GPT fixture',
      contextWindow: 272000,
      lite: false,
      efforts: ['medium'],
    },
  ]
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        generation: 0,
        fetchedAt: Date.now(),
        models,
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    setConfigValue(s.root, 'router.port', String(address.port))
    s.deps.debugEvents = () =>
      s.events.map((event) =>
        JSON.parse(
          JSON.stringify(event).replaceAll('127.0.0.1:18790', `127.0.0.1:${address.port}`),
        ),
      )
    assert.equal(await s.run('on'), 0, s.out.join(''))
    assert.deepEqual(
      readLayers(s.root).layers.map((layer) => layer.name),
      ['adapter', 'router', 'claude-code'],
    )
    assert.equal(existsSync(join(s.root, 'm2-upgrade.json')), false)
    assert.equal(existsSync(join(s.root, 'm3-upgrade.json')), false)
    assert.ok(existsSync(join(s.home, '.claude/agents/gpt-fixture.md')))
    const settings = join(s.home, '.claude/settings.json')
    const edited = JSON.parse(readFileSync(settings, 'utf8'))
    edited.model = 'claude-opus-4-7'
    edited.permissions = { allow: ['Read'] }
    writeFileSync(settings, `${JSON.stringify(edited, null, 2)}\n`)
    const beforeSettings = readFileSync(settings)
    const beforeRc = readFileSync(join(s.home, '.zshrc'))
    const beforeSemantic = readLayers(s.root).layers.find(
      (layer) => layer.name === 'claude-code',
    )?.claudeCode
    s.system.running = false
    const next = fakeLib(s.home, '0.1.0-next')
    assert.equal(
      applyOnFiles(s.system, s.root, next, { dryRun: false, paths: pathsFor(s.home) }).refused,
      null,
    )
    assert.ok(models[0])
    models = [{ ...models[0], id: 'gpt-next', label: 'GPT next' }]
    const ctx = {
      system: s.system,
      root: s.root,
      deps: s.deps,
      say: (text: string) => s.out.push(text),
      stop: { requested: null },
      marker: () => {},
    }
    await installClaudeCode(ctx, next)
    assert.ok(existsSync(join(s.home, '.claude/agents/gpt-next.md')))
    restoreDown(ctx, 'last-good')
    retireUpgrade(ctx, true)
    assert.deepEqual(readFileSync(settings), beforeSettings)
    assert.deepEqual(readFileSync(join(s.home, '.zshrc')), beforeRc)
    assert.deepEqual(
      readLayers(s.root).layers.find((layer) => layer.name === 'claude-code')?.claudeCode,
      beforeSemantic,
    )
    assert.equal(existsSync(join(s.home, '.claude/agents/gpt-next.md')), false)
    s.system.running = true
    assert.equal(await s.run('off'), 0, s.out.join(''))
    assert.equal(readFileSync(join(s.home, '.zshrc'), 'utf8'), original)
    assert.equal(readLayers(s.root).layers.length, 0)
    assert.equal(JSON.parse(readFileSync(settings, 'utf8')).model, edited.model)
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).permissions, edited.permissions)
    models = []
    assert.equal(await s.run('on'), 1, s.out.join(''))
    assert.equal(readFileSync(join(s.home, '.zshrc'), 'utf8'), original)
    assert.equal(readLayers(s.root).layers.length, 0)
    assert.equal(s.system.jobs.size, 0)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test('v1 installed directly upgrades with layer recovery; older M2 still requires milestone recovery', async () => {
  const s = await setup()
  const selected = join(s.root, 'lib/v1')
  mkdirSync(join(selected, 'dist/src'), { recursive: true })
  writeFileSync(join(selected, 'dist/src/accounts-bootstrap.mjs'), '// marker\n')
  assert.equal(needsMilestoneBaseline(s.root, selected), false)
  assert.equal(await s.run('on'), 0, s.out.join(''))
  assert.equal(needsMilestoneBaseline(s.root, selected), true)
  mkdirSync(join(s.plan.libDir, 'dist/src'), { recursive: true })
  writeFileSync(join(s.plan.libDir, 'dist/src/accounts-managed.mjs'), '// marker\n')
  assert.equal(needsMilestoneBaseline(s.root, selected), false)
  writeFileSync(join(s.root, 'm3-upgrade.json'), 'invalid\n')
  assert.throws(
    () => needsMilestoneBaseline(s.root, selected),
    /M2|M3|JSON|baseline|record|recovery|Unexpected/,
  )
})
