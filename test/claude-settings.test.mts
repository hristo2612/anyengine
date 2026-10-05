import assert from 'node:assert/strict'
import test from 'node:test'
import type { GptModel } from '../src/claude-models.mjs'
import type { Obj } from '../src/vendor/claude-code-proxy/types.mjs'

interface SettingsApi {
  buildClaudeSettings(
    before: Obj,
    input: { baseUrl: string; haiku: string; models: readonly GptModel[] },
  ): Obj
  restoreClaudeSettings(
    current: Obj,
    before: Obj,
    after: Obj,
    ownedModels: readonly string[],
  ): { value: Obj; conflicts: string[] }
  ownedClaudeModels(before: Obj, after: Obj): string[]
  parseClaudeSettings(text: string): Obj
}
const api = async (): Promise<SettingsApi> =>
  import(new URL('../src/claude-settings.mjs', import.meta.url).href)
const model: GptModel = {
  id: 'gpt-6.1-sol',
  label: 'GPT 6.1 Sol',
  contextWindow: 100_000,
  lite: false,
  efforts: ['medium'],
}
const input = {
  baseUrl: 'http://127.0.0.1:18790',
  haiku: 'claude-haiku-4-5-20251001',
  models: [model],
}
const env = (value: Obj): Obj => value.env as Obj
const picker = (value: Obj): Obj => value.modelPicker as Obj
const rows = (value: Obj): Obj[] => picker(value).options as Obj[]

test('settings on uses the approved picker schema and only three routing env leaves', async () => {
  const { buildClaudeSettings } = await api()
  const before: Obj = {
    theme: 'dark',
    permissions: { defaultMode: 'plan', deny: ['Read(secret.txt)'] },
    hooks: { Stop: [] },
    env: { MY_ENV: 'keep', ANTHROPIC_API_KEY: 'FAKE_KEY' },
    modelPicker: {
      replaceBuiltInOptions: false,
      unknown: 'keep',
      options: [{ model: 'custom-claude', label: 'Mine', custom: true }],
    },
  }
  const snapshot = structuredClone(before)
  const after = buildClaudeSettings(before, input)
  assert.deepEqual(before, snapshot)
  assert.deepEqual(after.permissions, before.permissions)
  assert.deepEqual(after.hooks, before.hooks)
  assert.equal(JSON.stringify(after.permissions), JSON.stringify(before.permissions))
  assert.deepEqual(env(after), {
    MY_ENV: 'keep',
    ANTHROPIC_API_KEY: 'FAKE_KEY',
    ANTHROPIC_BASE_URL: input.baseUrl,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: input.haiku,
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
  })
  assert.deepEqual(rows(after), [
    rows(before)[0],
    { model: model.id, label: model.label, description: 'via AnyEngine' },
  ])
  assert.equal(picker(after).replaceBuiltInOptions, false)
  assert.equal(picker(after).unknown, 'keep')
  assert.equal(after.model, undefined)
  assert.equal(env(after).ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(env(after).CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined)
  assert.equal(JSON.stringify(after).includes('behavesAs'), false)
})

test('settings on never changes existing auth, model defaults or dangerous permission settings', async () => {
  const { buildClaudeSettings } = await api()
  const before: Obj = {
    model: 'claude-opus-4-6',
    env: { ANTHROPIC_AUTH_TOKEN: 'FAKE_TOKEN', ANTHROPIC_MODEL: 'claude-sonnet-4-6' },
    permissions: { defaultMode: 'dontAsk' },
    skipDangerousModePermissionPrompt: true,
  }
  const after = buildClaudeSettings(before, input)
  assert.equal(after.model, before.model)
  assert.equal(env(after).ANTHROPIC_MODEL, 'claude-sonnet-4-6')
  assert.equal(env(after).ANTHROPIC_AUTH_TOKEN, 'FAKE_TOKEN')
  assert.deepEqual(after.permissions, before.permissions)
  assert.equal(after.skipDangerousModePermissionPrompt, true)
})

test('repeated on is idempotent and de-duplicates exact IDs without owning user collisions', async () => {
  const { buildClaudeSettings, ownedClaudeModels } = await api()
  const before: Obj = {
    modelPicker: {
      replaceBuiltInOptions: true,
      options: [{ model: model.id, label: 'My GPT', description: 'Mine' }],
    },
  }
  const second = { ...model, id: 'gpt-other', label: 'GPT Other' }
  const after = buildClaudeSettings(before, { ...input, models: [model, second, second] })
  assert.deepEqual(rows(after), [
    rows(before)[0],
    { model: second.id, label: second.label, description: 'via AnyEngine' },
  ])
  assert.equal(picker(after).replaceBuiltInOptions, true)
  assert.deepEqual(ownedClaudeModels(before, after), [second.id])
  assert.deepEqual(buildClaudeSettings(after, { ...input, models: [model, second] }), after)
})

test('semantic off restores replaced env leaves and removes only owned rows after unrelated edits', async () => {
  const { buildClaudeSettings, restoreClaudeSettings, ownedClaudeModels } = await api()
  const before: Obj = {
    env: { ANTHROPIC_BASE_URL: 'https://prior.example', MY_ENV: 'original' },
    modelPicker: { options: [{ model: 'custom', label: 'Mine' }] },
    permissions: { deny: ['Read(secret.txt)'] },
  }
  const after = buildClaudeSettings(before, input)
  const current = structuredClone(after)
  current.theme = 'light'
  env(current).MY_ENV = 'edited'
  rows(current).push({ model: 'user-added', label: 'Added' })
  const snapshot = structuredClone(current)
  const result = restoreClaudeSettings(current, before, after, ownedClaudeModels(before, after))
  assert.deepEqual(current, snapshot)
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(env(result.value), {
    ANTHROPIC_BASE_URL: 'https://prior.example',
    MY_ENV: 'edited',
  })
  assert.deepEqual(rows(result.value), [rows(before)[0], { model: 'user-added', label: 'Added' }])
  assert.equal(result.value.theme, 'light')
  assert.deepEqual(result.value.permissions, before.permissions)
})

test('semantic off preserves edited routing env values and reports their exact paths', async () => {
  const { buildClaudeSettings, restoreClaudeSettings } = await api()
  const before: Obj = {}
  const after = buildClaudeSettings(before, input)
  const current = structuredClone(after)
  env(current).ANTHROPIC_BASE_URL = 'http://127.0.0.1:19999'
  env(current).ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-custom'
  delete env(current).CLAUDE_CODE_GATEWAY_HINT_HEADERS
  const result = restoreClaudeSettings(current, before, after, [model.id])
  assert.deepEqual(env(result.value), {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:19999',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-custom',
  })
  assert.deepEqual(result.conflicts, [
    'env.ANTHROPIC_BASE_URL',
    'env.ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ])
})

test('semantic off removes absent-before empty containers but preserves pre-existing container fields', async () => {
  const { buildClaudeSettings, restoreClaudeSettings } = await api()
  const after = buildClaudeSettings({}, input)
  assert.deepEqual(restoreClaudeSettings(after, {}, after, [model.id]), {
    value: {},
    conflicts: [],
  })
  const before: Obj = { env: {}, modelPicker: { options: [], replaceBuiltInOptions: false } }
  const installed = buildClaudeSettings(before, input)
  assert.deepEqual(restoreClaudeSettings(installed, before, installed, [model.id]), {
    value: before,
    conflicts: [],
  })
})

test('semantic off compares owned picker rows structurally, preserving edits and same-ID additions', async () => {
  const { buildClaudeSettings, restoreClaudeSettings } = await api()
  const before: Obj = {}
  const after = buildClaudeSettings(before, input)
  const current = structuredClone(after)
  rows(current)[0] = { description: 'via AnyEngine', label: model.label, model: model.id }
  rows(current).push({ model: model.id, label: 'My second row', custom: true })
  const result = restoreClaudeSettings(current, before, after, [model.id])
  assert.deepEqual(rows(result.value), [{ model: model.id, label: 'My second row', custom: true }])
  assert.deepEqual(result.conflicts, [])
  const edited = structuredClone(after)
  const first = rows(edited)[0]
  assert.ok(first)
  first.label = 'My edited GPT'
  const kept = restoreClaudeSettings(edited, before, after, [model.id])
  assert.deepEqual(rows(kept.value), rows(edited))
  assert.deepEqual(kept.conflicts, [`modelPicker.options:${model.id}`])
})

test('semantic off cannot adopt or remove a pre-existing exact model collision', async () => {
  const { buildClaudeSettings, restoreClaudeSettings } = await api()
  const before: Obj = {
    modelPicker: {
      options: [{ model: model.id, label: model.label, description: 'via AnyEngine' }],
    },
  }
  const after = buildClaudeSettings(before, input)
  const result = restoreClaudeSettings(after, before, after, [model.id])
  assert.deepEqual(result.value, before)
  assert.deepEqual(result.conflicts, [])
})

test('off clears an owned persisted GPT default while restoring its prior Claude default', async () => {
  const { buildClaudeSettings, restoreClaudeSettings } = await api()
  for (const before of [{}, { model: 'claude-opus-4-6' }] as Obj[]) {
    const after = buildClaudeSettings(before, input)
    const current = { ...after, model: model.id }
    const result = restoreClaudeSettings(current, before, after, [model.id])
    assert.deepEqual(result.value, before)
    assert.deepEqual(result.conflicts, [])
  }
})

test('off keeps a newly selected Claude or unowned GPT default', async () => {
  const { buildClaudeSettings, restoreClaudeSettings } = await api()
  const after = buildClaudeSettings({}, input)
  for (const selected of ['claude-sonnet-4-6', 'gpt-user-owned']) {
    assert.deepEqual(
      restoreClaudeSettings({ ...after, model: selected }, {}, after, [model.id]).value,
      { model: selected },
    )
  }
})

test('off never clears unowned ANTHROPIC_MODEL but can restore an explicitly owned one', async () => {
  const { buildClaudeSettings, restoreClaudeSettings } = await api()
  const before: Obj = { env: { ANTHROPIC_MODEL: model.id } }
  const after = buildClaudeSettings(before, input)
  assert.deepEqual(restoreClaudeSettings(after, before, after, [model.id]).value, before)
  const prior: Obj = { env: { ANTHROPIC_MODEL: 'claude-opus-4-6' } }
  const installed = buildClaudeSettings(prior, input)
  env(installed).ANTHROPIC_MODEL = model.id
  assert.deepEqual(restoreClaudeSettings(installed, prior, installed, [model.id]).value, prior)
  const edited = structuredClone(installed)
  env(edited).ANTHROPIC_MODEL = 'claude-sonnet-4-6'
  assert.equal(
    env(restoreClaudeSettings(edited, prior, installed, [model.id]).value).ANTHROPIC_MODEL,
    'claude-sonnet-4-6',
  )
})

test('an already reverted value is preserved and repeat off is a semantic no-op', async () => {
  const { buildClaudeSettings, restoreClaudeSettings } = await api()
  const before: Obj = {
    env: { ANTHROPIC_BASE_URL: 'https://prior.example' },
    modelPicker: { options: [] },
  }
  const after = buildClaudeSettings(before, input)
  const once = restoreClaudeSettings(after, before, after, [model.id])
  assert.deepEqual(restoreClaudeSettings(once.value, before, after, [model.id]), once)
})

test('settings parsing and transforms reject malformed touched shapes without leaking their content', async () => {
  const { parseClaudeSettings, buildClaudeSettings, restoreClaudeSettings } = await api()
  for (const text of [
    '{FAKE_SECRET',
    '[]',
    'null',
    '{"env": []}',
    '{"env": "FAKE_SECRET"}',
    '{"modelPicker": {"options": {}}}',
    '{"modelPicker": {"options": ["FAKE_SECRET"]}}',
  ]) {
    assert.throws(
      () => parseClaudeSettings(text),
      (error: unknown) => error instanceof Error && !error.message.includes('FAKE_SECRET'),
    )
  }
  assert.deepEqual(parseClaudeSettings('{"unknown":{"x":1},"env":{}}'), {
    unknown: { x: 1 },
    env: {},
  })
  assert.throws(() => buildClaudeSettings({ env: [] }, input))
  const after = buildClaudeSettings({}, input)
  assert.throws(() =>
    restoreClaudeSettings({ modelPicker: { options: null } }, {}, after, [model.id]),
  )
})

test('settings reject remote or malformed routing inputs and unsafe catalog strings atomically', async () => {
  const { buildClaudeSettings } = await api()
  for (const baseUrl of [
    'https://127.0.0.1:18790',
    'http://localhost:18790',
    'http://127.0.0.1:18790/v1',
    'http://user:pass@127.0.0.1:18790',
    'http://127.0.0.1:18790/?x=1',
    'http://127.0.0.1:0',
  ])
    assert.throws(() => buildClaudeSettings({}, { ...input, baseUrl }))
  for (const id of [
    '../escape',
    'gpt-x/escape',
    'gpt-x\\escape',
    'gpt-x\n---',
    'gpt-x[1m]',
    'claude-opus',
    `gpt-${'x'.repeat(128)}`,
  ])
    assert.throws(() => buildClaudeSettings({}, { ...input, models: [{ ...model, id }] }))
  for (const label of ['', '  ', 'GPT\npermissionMode: bypassPermissions', 'GPT\u2028injection'])
    assert.throws(() => buildClaudeSettings({}, { ...input, models: [{ ...model, label }] }))
  for (const haiku of ['gpt-not-haiku', 'claude-haiku-custom\n'])
    assert.throws(() => buildClaudeSettings({}, { ...input, haiku }))
})
