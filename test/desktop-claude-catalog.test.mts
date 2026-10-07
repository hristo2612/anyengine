import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import type { ModelInfo, Query, query } from '@anthropic-ai/claude-agent-sdk'
import { DEFAULT_CONFIG } from '../src/anyengine-config.mjs'
import {
  claudeCatalogModels,
  configuredDesktopModels,
  discoverClaudeModels,
} from '../src/desktop-claude-catalog.mjs'
import { DesktopClaudeRuntime } from '../src/desktop-claude-runtime.mjs'
import { desktopProfile } from '../src/desktop-models.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const rows: ModelInfo[] = [
  {
    value: 'fable',
    resolvedModel: 'claude-fable-5-1',
    displayName: 'Fable 5.1',
    description: 'Current Fable',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
  },
  { value: 'claude-fable-5', displayName: 'Fable 5', description: 'Previous Fable' },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5',
    displayName: 'Haiku 4.5',
    description: 'Quick',
  },
]
const catalog = () => claudeCatalogModels(rows)

test('official catalog retains all choices, native labels and per-model effort capabilities', () => {
  const models = catalog()
  assert.deepEqual(
    models.map((model) => model.id),
    ['fable', 'claude-fable-5', 'haiku'],
  )
  const profile = desktopProfile(18790, [], models)
  const first = profile.inferenceModels[0]
  const last = profile.inferenceModels[2]
  assert.ok(first && last && 'anthropicFamilyTier' in first)
  assert.equal(first.maxEffort, 'max')
  assert.equal(first.anthropicFamilyTier, 'fable')
  assert.equal(Object.hasOwn(last, 'maxEffort'), false)
  assert.equal(Object.hasOwn(first, 'supports1m'), false)
  const merged = configuredDesktopModels(models, [
    { id: 'my-fable', displayName: 'My Fable', claudeModel: 'fable', contextWindow: 200000 },
  ])
  const custom = merged.at(-1)
  assert.ok(custom && models[0])
  assert.equal(custom.claudeModel, 'fable')
  assert.deepEqual(custom.efforts, models[0].efforts)
  const duplicate = rows[0]
  assert.ok(duplicate)
  assert.throws(() => claudeCatalogModels([...rows, duplicate]), /Ambiguous/)
})

test('model discovery submits no inference, closes its official client, and refreshes cached choices', async () => {
  const root = await tempDir('desktop-catalog-')
  let starts = 0
  let closes = 0
  let captured: Parameters<typeof query>[0] | undefined
  const fake = ((input: Parameters<typeof query>[0]) => {
    starts++
    captured = input
    return {
      supportedModels: async () => rows.map((row) => ({ ...row, supportedEffortLevels: [] })),
      close: () => {
        closes++
      },
    } as unknown as Query
  }) as typeof query
  const signal = new AbortController().signal
  const models = await discoverClaudeModels({ root, cli: null, signal, query: fake })
  assert.equal(models.length, 3)
  assert.equal(closes, 1)
  assert.ok(captured && captured.options)
  assert.equal(typeof captured.prompt, 'object')
  assert.deepEqual(
    await (captured.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next(),
    { done: true, value: undefined },
  )
  assert.deepEqual(captured.options.tools, [])
  assert.equal(captured.options.persistSession, false)
  assert.ok(captured.options.settings && typeof captured.options.settings === 'object')
  assert.equal(captured.options.settings.disableAllHooks, true)
  const runtime = new DesktopClaudeRuntime(fake)
  try {
    const input = { root, cli: null, signal, configured: DEFAULT_CONFIG.claude.models }
    await runtime.models(input)
    await runtime.models(input)
    assert.equal(starts, 2)
    await runtime.models({ ...input, refresh: true })
    assert.equal(starts, 3)
    assert.equal(closes, 3)
  } finally {
    await runtime.close()
  }
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    discoverClaudeModels({ root, cli: null, signal: cancelled.signal, query: fake }),
    /cancelled/,
  )
  assert.equal(starts, 3)
})
