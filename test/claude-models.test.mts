import assert from 'node:assert/strict'
import test from 'node:test'

const load = () => import('../src/' + 'claude-models.mjs')
const model = {
  id: 'gpt-6.1-sol',
  label: 'GPT 6.1 Sol',
  contextWindow: 272000,
  lite: true,
  efforts: ['low', 'medium', 'high'],
}
const entry = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  display_name: slug,
  visibility: 'list',
  context_window: 272000,
  use_responses_lite: false,
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
  priority: 0,
  ...extra,
})

test('model resolution requires a supplied GPT model and preserves the exact wire request', async () => {
  const { resolveGptModel } = await load()
  const models = [model]
  assert.equal(resolveGptModel('claude-opus-5-5', models), null)
  assert.equal(resolveGptModel('gpt-missing', models), null)
  assert.deepEqual(resolveGptModel('gpt-6.1-sol', models), {
    requested: 'gpt-6.1-sol',
    upstream: 'gpt-6.1-sol',
    lite: true,
    effort: null,
    efforts: ['low', 'medium', 'high'],
  })
  assert.deepEqual(resolveGptModel('gpt-6.1-sol[1m]', models), {
    requested: 'gpt-6.1-sol[1m]',
    upstream: 'gpt-6.1-sol',
    lite: true,
    effort: null,
    efforts: ['low', 'medium', 'high'],
  })
  for (const alias of ['gpt-6.1-sol-fast', 'gpt-6.1-sol-high', 'gpt-6.1-sol[priority]'])
    assert.equal(resolveGptModel(alias, models), null, alias)
})

test('model resolution rejects hostile IDs even when a matching row is supplied', async () => {
  const { resolveGptModel } = await load()
  for (const requested of [
    '',
    'gpt-',
    'GPT-fixture',
    'gpt-fixture\n',
    'gpt-fixture\r',
    'gpt-fixture\u2028',
    'gpt-fixture\u0000',
    'gpt-fixture\u007f',
    'gpt-fixture\t-high',
    ' gpt-fixture',
    'gpt-fixture: high',
    'gpt-fixture#comment',
    'gpt-fixture{key}',
    '- gpt-fixture',
    '../gpt-fixture',
    'gpt-../fixture',
    'gpt-fixture/../other',
    'gpt-fixture\\other',
    'gpt-fixture[1M]',
    'gpt-fixture[1m][1m]',
    `gpt-${'a'.repeat(125)}`,
  ])
    assert.equal(resolveGptModel(requested, [{ ...model, id: requested }]), null, requested)
})

test('the 128-character wire limit includes the optional suffix', async () => {
  const { resolveGptModel } = await load()
  const plain = `gpt-${'a'.repeat(124)}`
  const suffixed = `gpt-${'b'.repeat(120)}`
  const models = [
    { ...model, id: plain },
    { ...model, id: suffixed },
  ]
  assert.equal(resolveGptModel(plain, models)?.upstream, plain)
  assert.equal(resolveGptModel(`${suffixed}[1m]`, models)?.requested, `${suffixed}[1m]`)
  assert.equal(resolveGptModel(`${plain}[1m]`, models), null)
})

test('catalog selection preserves explicit lanes and supplied reasoning capabilities', async () => {
  const { selectGptModels } = await load()
  assert.deepEqual(
    selectGptModels({
      models: [
        entry('gpt-6.1-sol', {
          display_name: 'GPT 6.1 Sol',
          use_responses_lite: false,
          supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'none' }],
        }),
        entry('gpt-fixture', {
          display_name: 'Fixture',
          context_window: 1048576,
          use_responses_lite: true,
          supported_reasoning_levels: [{ effort: 'future-effort' }, { effort: 'low' }],
        }),
      ],
    }),
    [
      {
        id: 'gpt-6.1-sol',
        label: 'GPT 6.1 Sol',
        contextWindow: 272000,
        lite: false,
        efforts: ['medium', 'none'],
      },
      {
        id: 'gpt-fixture',
        label: 'Fixture',
        contextWindow: 1048576,
        lite: true,
        efforts: ['future-effort', 'low'],
      },
    ],
  )
  assert.deepEqual(
    selectGptModels({ models: [entry('gpt-no-reasoning', { supported_reasoning_levels: [] })] })[0]
      ?.efforts,
    [],
  )
})

test('catalog selection requires the backend models shape and listed plain GPT IDs', async () => {
  const { selectGptModels } = await load()
  for (const catalog of [{}, { models: null }, { models: {} }, { data: [entry('gpt-rpc')] }])
    assert.deepEqual(selectGptModels(catalog), [])
  assert.deepEqual(
    selectGptModels({
      models: [
        null,
        [],
        'gpt-not-a-row',
        entry('claude-opus-5-5'),
        entry('gpt-hidden', { visibility: 'hide' }),
        entry('gpt-no-visibility', { visibility: null }),
        entry('gpt-suffixed[1m]'),
        entry('gpt-path/other'),
        entry('gpt-newline\n'),
        entry('gpt-visible'),
      ],
    }).map((row: { id: string }) => row.id),
    ['gpt-visible'],
  )
})

test('missing or malformed lane evidence never guesses a model lane', async () => {
  const { selectGptModels } = await load()
  const missing: Record<string, unknown> = entry('gpt-missing-lane')
  delete missing.use_responses_lite
  for (const row of [
    missing,
    entry('gpt-string-lane', { use_responses_lite: 'false' }),
    entry('gpt-null-lane', { use_responses_lite: null }),
  ])
    assert.deepEqual(selectGptModels({ models: [row] }), [])
})

test('malformed catalog metadata cannot become a selectable model', async () => {
  const { selectGptModels } = await load()
  const invalid = [
    { slug: 3 },
    { display_name: '' },
    { display_name: '   ' },
    { display_name: 'Fixture\nother' },
    { display_name: 3 },
    { context_window: '272000' },
    { context_window: 0 },
    { context_window: -1 },
    { context_window: 1.5 },
    { context_window: Infinity },
    { context_window: Number.MAX_SAFE_INTEGER + 1 },
    { priority: '1' },
    { priority: NaN },
    { priority: Infinity },
    { supported_reasoning_levels: null },
    { supported_reasoning_levels: {} },
    { supported_reasoning_levels: ['high'] },
    { supported_reasoning_levels: [{ effort: 'low' }, null] },
    { supported_reasoning_levels: [{ effort: 3 }] },
    { supported_reasoning_levels: [{ effort: '' }] },
    { supported_reasoning_levels: [{ effort: 'high\n' }] },
  ]
  for (const extra of invalid)
    assert.deepEqual(
      selectGptModels({ models: [entry('gpt-invalid', extra)] }),
      [],
      JSON.stringify(extra),
    )
  for (const key of ['display_name', 'context_window', 'priority', 'supported_reasoning_levels']) {
    const row: Record<string, unknown> = entry('gpt-missing-field')
    delete row[key]
    assert.deepEqual(selectGptModels({ models: [row] }), [], key)
  }
})

test('catalog priority is numeric ascending and ties preserve source order', async () => {
  const { selectGptModels } = await load()
  assert.deepEqual(
    selectGptModels({
      models: [
        entry('gpt-high', { priority: 10 }),
        entry('gpt-equal-a', { priority: 2 }),
        entry('gpt-low', { priority: -1 }),
        entry('gpt-equal-b', { priority: 2 }),
      ],
    }).map((row: { id: string }) => row.id),
    ['gpt-low', 'gpt-equal-a', 'gpt-equal-b', 'gpt-high'],
  )
})

test('duplicate visible model IDs are omitted instead of choosing ambiguous capabilities', async () => {
  const { selectGptModels } = await load()
  assert.deepEqual(
    selectGptModels({
      models: [
        entry('gpt-duplicate', { priority: -2 }),
        entry('gpt-kept'),
        entry('gpt-duplicate', { priority: 2, use_responses_lite: true }),
        entry('gpt-kept', { visibility: 'hide' }),
      ],
    }).map((row: { id: string }) => row.id),
    ['gpt-kept'],
  )
  assert.deepEqual(selectGptModels({ models: [entry('gpt-same'), entry('gpt-same')] }), [])
})

test('the ten-model limit applies after eligibility and ascending priority', async () => {
  const { selectGptModels } = await load()
  assert.deepEqual(
    selectGptModels({
      models: [
        entry('claude-filtered', { priority: -10 }),
        entry('gpt-hidden', { priority: -9, visibility: 'hide' }),
        ...Array.from({ length: 12 }, (_, i) => entry(`gpt-${i}`, { priority: 12 - i })),
      ],
    }).map((row: { id: string }) => row.id),
    ['gpt-11', 'gpt-10', 'gpt-9', 'gpt-8', 'gpt-7', 'gpt-6', 'gpt-5', 'gpt-4', 'gpt-3', 'gpt-2'],
  )
})

test('selection and resolution leave the supplied catalog and model arrays unchanged', async () => {
  const { selectGptModels, resolveGptModel } = await load()
  const catalog = {
    models: [entry('gpt-later', { priority: 2 }), entry('gpt-first', { priority: 1 })],
  }
  const before = structuredClone(catalog)
  const selected = selectGptModels(catalog)
  assert.deepEqual(catalog, before)
  selected[0].efforts.push('changed')
  assert.deepEqual(catalog, before)
  const models = Object.freeze([Object.freeze({ ...model, efforts: Object.freeze(model.efforts) })])
  assert.deepEqual(resolveGptModel(model.id, models)?.efforts, ['low', 'medium', 'high'])
  assert.equal(models[0]?.id, 'gpt-6.1-sol')
})
