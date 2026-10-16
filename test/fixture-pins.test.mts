import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  CLAUDE_FIXTURE_VERSION,
  FIXTURE_NAMES,
  M2_FIXTURES,
  SHIPPED_FIXTURES,
} from '../src/fixture-pins.mjs'

// The suites run from the repository root (scripts/test-hermetic.mjs).
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] }

test('every pinned fixture exists and names the version it was captured from', () => {
  for (const path of SHIPPED_FIXTURES) assert.ok(existsSync(path), `${path} is missing`)
  for (const name of [FIXTURE_NAMES.claudeMessages, FIXTURE_NAMES.claudePosture]) {
    const capture = JSON.parse(readFileSync(`test/fixtures/${name}`, 'utf8'))
    assert.equal(capture.claudeVersion, CLAUDE_FIXTURE_VERSION, name)
  }
})

test('the npm package ships exactly the pinned fixtures and nothing it lists is missing', () => {
  const listed = pkg.files.filter((entry) => entry.startsWith('test/fixtures/'))
  assert.deepEqual([...listed].sort(), [...SHIPPED_FIXTURES].sort())
  // npm-shrinkwrap.json exists only while npm pack runs (prepack writes it).
  for (const entry of pkg.files.filter((entry) => entry !== 'npm-shrinkwrap.json'))
    assert.ok(existsSync(entry), `package.json files lists ${entry}, which does not exist`)
})

test('the startup helper copy of the M2 fixture list agrees with the pins', () => {
  const { REQUIRED_M2_FIXTURES } = createRequire(import.meta.url)(
    '../../scripts/lib/startup-schema.mjs',
  )
  assert.deepEqual(REQUIRED_M2_FIXTURES, M2_FIXTURES)
})
