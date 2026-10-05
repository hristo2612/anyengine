import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { LayerWriter, readLayers } from '../src/control-layers.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const load = () => import('../src/' + 'control-claude-layer.mjs')
const catalog = {
  generation: 0,
  fetchedAt: 4242,
  models: [
    {
      id: 'gpt-fixture',
      label: 'GPT fixture',
      contextWindow: 272000,
      lite: false,
      efforts: ['medium'],
    },
  ],
}
async function fixture() {
  const api = await load()
  const home = await tempDir('cl-')
  const root = join(home, 'engine')
  mkdirSync(root, { mode: 0o700 })
  const dir = join(home, '.claude')
  mkdirSync(dir, { mode: 0o700 })
  const settings = join(dir, 'settings.json')
  const agent = join(dir, 'agents/gpt-fixture.md')
  const input = {
    root,
    home,
    catalog,
    baseUrl: 'http://127.0.0.1:18790',
    haiku: 'claude-haiku-4-5-20251001',
  }
  const writer = () =>
    new LayerWriter(
      root,
      readLayers(root).layers.find((row) => row.name === 'claude-code') ?? null,
      'claude-code',
      'fixture',
    )
  return { api, root, home, dir, settings, agent, input, writer }
}

test('Claude layer publishes semantic ownership before mutation and preserves settings mode/auth/posture', async () => {
  const f = await fixture()
  const before = {
    env: { ANTHROPIC_AUTH_TOKEN: 'FAKE_KEEP', MY_ENV: 'keep' },
    permissions: { deny: ['Read(private)'] },
  }
  writeFileSync(f.settings, JSON.stringify(before), { mode: 0o640 })
  let sawIntent = false
  const writer = new LayerWriter(f.root, null, 'claude-code', 'fixture', (layer, phase) => {
    if (phase !== 'intent') return
    const published = readLayers(f.root).layers.find((row) => row.name === 'claude-code')
    assert.ok(published?.claudeCode)
    assert.equal(published.claudeCode.settingsTarget, f.settings)
    assert.deepEqual(published.claudeCode.ownedModels, ['gpt-fixture'])
    if (layer.changes.at(-1)?.target === f.settings) {
      assert.deepEqual(JSON.parse(readFileSync(f.settings, 'utf8')), before)
      sawIntent = true
    }
  })
  f.api.applyClaudeLayer({ ...f.input, writer })
  assert.equal(sawIntent, true)
  const after = JSON.parse(readFileSync(f.settings, 'utf8'))
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, 'FAKE_KEEP')
  assert.equal(after.env.MY_ENV, 'keep')
  assert.deepEqual(after.permissions, before.permissions)
  assert.equal(statSync(f.settings).mode & 0o777, 0o640)
  assert.ok(readFileSync(f.agent, 'utf8').endsWith('---\n'))
  assert.equal(readLayers(f.root).layers[0]?.claudeCode?.catalog.generation, 0)
})

test('unchanged Claude layer restores exact original bytes and absent generated agents', async () => {
  const f = await fixture()
  const original = ' { "theme" : "dark", "env" : { "KEEP" : "yes" } }\n'
  writeFileSync(f.settings, original, { mode: 0o640 })
  f.api.applyClaudeLayer({ ...f.input, writer: f.writer() })
  const result = f.api.restoreClaudeLayer(f.root)
  assert.equal(result.ok, true)
  assert.equal(result.routingRetained, false)
  assert.deepEqual(result.conflicts, [])
  assert.equal(readFileSync(f.settings, 'utf8'), original)
  assert.equal(statSync(f.settings).mode & 0o777, 0o640)
  assert.equal(existsSync(f.agent), false)
  assert.equal(
    readLayers(f.root).layers.some((row) => row.name === 'claude-code'),
    false,
  )
  assert.equal(f.api.restoreClaudeLayer(f.root).ok, true)
})

test('semantic off preserves unrelated edits and removes only owned rows and defaults', async () => {
  const f = await fixture()
  f.api.applyClaudeLayer({ ...f.input, writer: f.writer() })
  const current = JSON.parse(readFileSync(f.settings, 'utf8'))
  current.theme = 'light'
  current.env.KEEP_NEW = 'yes'
  current.model = 'gpt-fixture'
  current.modelPicker.options.push({ model: 'claude-custom', label: 'Mine' })
  writeFileSync(f.settings, JSON.stringify(current))
  const result = f.api.restoreClaudeLayer(f.root)
  assert.equal(result.ok, true)
  const value = JSON.parse(readFileSync(f.settings, 'utf8'))
  assert.equal(value.theme, 'light')
  assert.deepEqual(value.env, { KEEP_NEW: 'yes' })
  assert.deepEqual(value.modelPicker.options, [{ model: 'claude-custom', label: 'Mine' }])
  assert.equal(value.model, undefined)
})

test('edited owned routing values retain the functional layer and report a conflict', async () => {
  const f = await fixture()
  f.api.applyClaudeLayer({ ...f.input, writer: f.writer() })
  const current = JSON.parse(readFileSync(f.settings, 'utf8'))
  current.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:18790/'
  current.modelPicker.options[0].label = 'My edited GPT'
  writeFileSync(f.settings, JSON.stringify(current))
  writeFileSync(f.agent, 'operator edited agent\n')
  const result = f.api.restoreClaudeLayer(f.root)
  assert.equal(result.ok, false)
  assert.equal(result.routingRetained, true)
  assert.ok(result.conflicts.length > 0)
  assert.equal(
    JSON.parse(readFileSync(f.settings, 'utf8')).env.ANTHROPIC_BASE_URL,
    current.env.ANTHROPIC_BASE_URL,
  )
  assert.equal(readFileSync(f.agent, 'utf8'), 'operator edited agent\n')
  assert.ok(readLayers(f.root).layers.some((row) => row.name === 'claude-code'))
})

test('unowned existing agent/model collisions never become layer targets', async () => {
  const f = await fixture()
  mkdirSync(join(f.dir, 'agents'))
  writeFileSync(f.agent, 'user agent')
  writeFileSync(
    f.settings,
    JSON.stringify({ modelPicker: { options: [{ model: 'gpt-fixture', label: 'Mine' }] } }),
  )
  f.api.applyClaudeLayer({ ...f.input, writer: f.writer() })
  const layer = readLayers(f.root).layers.find((row) => row.name === 'claude-code')
  assert.deepEqual(layer?.claudeCode?.ownedModels, [])
  assert.equal(
    layer?.changes.some((row) => row.target === f.agent),
    false,
  )
  assert.equal(f.api.restoreClaudeLayer(f.root).ok, true)
  assert.equal(readFileSync(f.agent, 'utf8'), 'user agent')
  assert.equal(JSON.parse(readFileSync(f.settings, 'utf8')).modelPicker.options[0].label, 'Mine')
})

test('repeat on keeps the initial backup and metadata ownership', async () => {
  const f = await fixture()
  writeFileSync(f.settings, '{ "theme": "dark" }\n')
  f.api.applyClaudeLayer({ ...f.input, writer: f.writer() })
  const first = readLayers(f.root).layers[0]
  f.api.applyClaudeLayer({ ...f.input, writer: f.writer() })
  const second = readLayers(f.root).layers[0]
  assert.equal(second?.rollbackDir, first?.rollbackDir)
  assert.equal(second?.changes[0]?.backup, first?.changes[0]?.backup)
  assert.deepEqual(second?.claudeCode?.ownedModels, ['gpt-fixture'])
  assert.equal(second?.changes.length, first?.changes.length)
  assert.equal(f.api.restoreClaudeLayer(f.root).ok, true)
  assert.equal(readFileSync(f.settings, 'utf8'), '{ "theme": "dark" }\n')
})

test('repeat on updates unchanged owned labels and refuses edited owned settings', async () => {
  const f = await fixture()
  writeFileSync(f.settings, '{}\n')
  f.api.applyClaudeLayer({ ...f.input, writer: f.writer() })
  const next = { ...catalog, models: [{ ...catalog.models[0]!, label: 'Updated label' }] }
  f.api.applyClaudeLayer({ ...f.input, catalog: next, writer: f.writer() })
  const updated = JSON.parse(readFileSync(f.settings, 'utf8'))
  assert.equal(updated.modelPicker.options[0].label, 'Updated label')
  updated.modelPicker.options[0].label = 'My edited label'
  const edited = JSON.stringify(updated)
  writeFileSync(f.settings, edited)
  assert.throws(
    () => f.api.applyClaudeLayer({ ...f.input, catalog: next, writer: f.writer() }),
    /owned Claude settings changed/,
  )
  assert.equal(readFileSync(f.settings, 'utf8'), edited)
})

test('repeat on leaves newly added user picker rows unowned', async () => {
  const f = await fixture()
  writeFileSync(f.settings, '{}\n')
  f.api.applyClaudeLayer({ ...f.input, writer: f.writer() })
  const edited = JSON.parse(readFileSync(f.settings, 'utf8'))
  edited.modelPicker.options.push({ model: 'gpt-user', label: 'My row' })
  writeFileSync(f.settings, JSON.stringify(edited))
  f.api.applyClaudeLayer({ ...f.input, writer: f.writer() })
  assert.deepEqual(readLayers(f.root).layers[0]?.claudeCode?.ownedModels, ['gpt-fixture'])
  assert.equal(f.api.restoreClaudeLayer(f.root).ok, true)
  assert.deepEqual(JSON.parse(readFileSync(f.settings, 'utf8')).modelPicker.options, [
    { model: 'gpt-user', label: 'My row' },
  ])
})

test('malformed settings and escaped agent paths fail before any user target changes', async () => {
  for (const invalidJson of [true, false]) {
    const f = await fixture()
    const before = invalidJson ? '{ malformed' : '{"theme":"dark"}'
    writeFileSync(f.settings, before)
    if (!invalidJson) {
      const outside = join(f.home, 'outside')
      mkdirSync(outside)
      symlinkSync(outside, join(f.dir, 'agents'))
    }
    assert.throws(() => f.api.applyClaudeLayer({ ...f.input, writer: f.writer() }))
    assert.equal(readFileSync(f.settings, 'utf8'), before)
    assert.equal(readLayers(f.root).layers.length, 0)
  }
})

test('a concurrent settings edit during journal publication is refused and recoverable', async () => {
  const f = await fixture()
  writeFileSync(f.settings, '{}')
  const writer = new LayerWriter(f.root, null, 'claude-code', 'fixture', (layer, phase) => {
    if (phase === 'intent' && layer.changes.at(-1)?.target === f.settings)
      writeFileSync(f.settings, '{"operator":"concurrent"}')
  })
  assert.throws(() => f.api.applyClaudeLayer({ ...f.input, writer }))
  assert.equal(readFileSync(f.settings, 'utf8'), '{"operator":"concurrent"}')
  assert.ok(readLayers(f.root).layers[0]?.changes[0]?.pending)
  assert.equal(existsSync(f.agent), false)
})
