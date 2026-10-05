import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from 'smol-toml'
import {
  duplicateTopLevelKeys,
  insertTopLevelLine,
  modelLines,
  nonGptModelLines,
  topLevelKeys,
  topLevelString,
  withoutLines,
} from '../src/codex-config-toml.mjs'

const source =
  '# notes\r\n"model" = "sonnet" # retained comment belongs to assignment\r\nreview_model = \'gpt-6-astra\'\r\nnote = """\r\nmodel = "inert"\r\n[profiles.fake]\r\n"""\r\n[profiles."work.with.dot"]\r\n\'model\' = "opus"\r\n[[projects]]\r\nmodel = "not-model"\r\n'

test('TOML scans actual quoted assignments, multiline strings, profile tables and arrays of tables', () => {
  assert.deepEqual(
    modelLines(source).map(({ index, table, key, value }) => [index, table, key, value]),
    [
      [1, null, 'model', 'sonnet'],
      [2, null, 'review_model', 'gpt-6-astra'],
      [8, 'profiles.work.with.dot', 'model', 'opus'],
    ],
  )
  assert.deepEqual(topLevelKeys(source), ['model', 'review_model', 'note'])
  assert.deepEqual(
    nonGptModelLines(source).map((line) => line.value),
    ['sonnet', 'opus'],
  )
  const removed = withoutLines(
    source,
    nonGptModelLines(source).filter((line) => line.table === null),
  )
  assert.equal(
    removed,
    source.replace('"model" = "sonnet" # retained comment belongs to assignment\r\n', ''),
  )
  assert.deepEqual(
    parse(
      insertTopLevelLine(removed, 1, '"model" = "sonnet" # retained comment belongs to assignment'),
    ),
    parse(source),
  )
  assert.equal(
    insertTopLevelLine(removed, 1, '"model" = "sonnet" # retained comment belongs to assignment'),
    source,
  )
})

test('TOML multiline literal/basic values and escaped quotes cannot forge assignments or tables', () => {
  const text = `note = '''\nmodel = "inert"\n[[projects]]\n'''\nmodel = "sonnet"\nother = "escaped \\" quote"\nreview_model = """haiku"""\n[profiles.fast.extra]\nmodel = "ignored"\n`
  assert.deepEqual(
    nonGptModelLines(text).map((line) => line.value),
    ['sonnet', 'haiku'],
  )
  assert.deepEqual(topLevelKeys(text), ['note', 'model', 'other', 'review_model'])
  assert.equal(
    withoutLines(text, modelLines(text)),
    text.replace('model = "sonnet"\n', '').replace('review_model = """haiku"""\n', ''),
  )
  assert.equal(
    topLevelString(
      '"openai_base_url" = "http://127.0.0.1:18790/backend-api/codex"\n',
      'openai_base_url',
    ),
    'http://127.0.0.1:18790/backend-api/codex',
  )
  assert.equal(topLevelString('[other]\nopenai_base_url="x"\n', 'openai_base_url'), null)
})

test('TOML invalid, duplicate, unsupported or stale removal refuses rather than editing other bytes', () => {
  const duplicate = '"model"="sonnet"\nmodel="opus"\n'
  assert.deepEqual(duplicateTopLevelKeys(duplicate), ['model'])
  for (const text of [duplicate, 'model = "unterminated', 'model = 1\n']) {
    assert.throws(() =>
      withoutLines(text, [
        { index: 0, table: null, key: 'model', value: 'sonnet', text: 'model = "sonnet"' },
      ]),
    )
  }
  const text = 'model="sonnet"\n# keep\n'
  const stale = modelLines('model="opus"\n')
  assert.throws(() => withoutLines(text, stale), /stale|unsupported/i)
  assert.throws(() => insertTopLevelLine(text, 1, 'model="opus"'), /TOML|key|defined/i)
  assert.throws(() => insertTopLevelLine(text, 1, '[hijacked]'), /assignment|unsupported/i)
  assert.throws(
    () => insertTopLevelLine(text, 1, 'review_model="opus"\nx=1'),
    /assignment|unsupported/i,
  )
})

test('TOML insertion stays before either table form and never splits multiline values', () => {
  assert.equal(
    insertTopLevelLine('[[projects]]\nx=1\n', 20, 'model="opus"'),
    'model="opus"\n[[projects]]\nx=1\n',
  )
  assert.equal(
    insertTopLevelLine('note="""\na\n"""\n[t]\n', 1, 'model="opus"'),
    'note="""\na\n"""\nmodel="opus"\n[t]\n',
  )
  assert.equal(
    insertTopLevelLine('# no newline', 20, 'model="opus"'),
    '# no newline\nmodel="opus"\n',
  )
})

test('TOML array ancestors do not create a direct profile model assignment', () => {
  const text = '[[profiles]]\n[profiles.work]\nmodel="sonnet"\n'
  assert.deepEqual(modelLines(text), [])
  assert.equal(withoutLines(text, []), text)
})
