import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const check = resolve('scripts/check-posture-schema.mjs')
const fakeCodex = resolve('test/fixtures/fake-codex-schema.mjs')
const schema = JSON.parse(readFileSync(resolve('test/fixtures/posture-schema.json'), 'utf8'))

function runCheck(definitions: unknown, env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'anyengine-schema-'))
  try {
    const file = join(dir, 'schema.json')
    writeFileSync(file, JSON.stringify({ definitions }))
    return spawnSync(process.execPath, [check], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_REAL: fakeCodex, FAKE_SCHEMA_FILE: file, ...env },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('every posture value of the pinned schema is mapped', () => {
  const result = runCheck(schema.definitions)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Posture schema coverage OK: 38 values and fields, all mapped/)
})

test('a new approval policy value fails the check by name', () => {
  const definitions = structuredClone(schema.definitions)
  definitions.AskForApproval.oneOf[0].enum.push('on-sunday')
  const result = runCheck(definitions)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /AskForApproval: on-sunday/)
})

test('a new approval policy value in its own documented entry fails the check by name', () => {
  const definitions = structuredClone(schema.definitions)
  definitions.AskForApproval.oneOf.push({
    description: 'A documented unit variant',
    enum: ['on-sunday'],
    type: 'string',
  })
  const result = runCheck(definitions)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /AskForApproval: on-sunday/)
})

test('a new sandbox policy field fails the check by name', () => {
  const definitions = structuredClone(schema.definitions)
  definitions.SandboxPolicy.oneOf[3].properties.readableRoots = { type: 'array' }
  const result = runCheck(definitions)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /SandboxPolicy\.workspaceWrite field: readableRoots/)
})

test('a new reviewer or collaboration mode fails the check by name', () => {
  const definitions = structuredClone(schema.definitions)
  definitions.ApprovalsReviewer.enum.push('committee')
  definitions.ModeKind.enum.push('pair')
  const result = runCheck(definitions)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ApprovalsReviewer: committee/)
  assert.match(result.stderr, /ModeKind: pair/)
})

test('schema generation isolates HOME and removes failed probe output', () => {
  const result = runCheck(schema.definitions, { FAKE_FORBIDDEN_HOME: process.env.HOME })
  assert.equal(result.status, 0, result.stderr)
  const failed = runCheck(schema.definitions, { FAKE_SCHEMA_FAIL: '1' })
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /fixture generation failed/)
})
