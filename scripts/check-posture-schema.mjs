#!/usr/bin/env node
// Posture schema coverage (spec 5.6). Every value the generated Codex
// app-server schema allows for the approval policy and its granular flags,
// the sandbox mode, the sandbox policy (variants and their fields), the
// approvals reviewer, external network access and the collaboration mode
// must be one src/posture.mts converts, and so must every Claude permission
// mode in test/fixtures/claude-permission-modes.json. A value nobody maps
// falls through to a default, which is how the looseness bugs of spec 5.6
// started.
//
// Needs a build (it imports dist/src/posture.mjs) and a real codex binary:
//   CODEX_REAL=/path/to/codex npm run check:posture-schema
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { isolatedCommand } from './lib/codex-probe.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  throw new Error(`posture schema check failed: ${message}`)
}

export async function validatePosture(defs, fixtureRoot = root) {
  const posturePath = join(fixtureRoot, 'dist', 'src', 'posture.mjs')
  const { POSTURE_SCHEMA_COVERAGE: covers } = await import(pathToFileURL(posturePath).href).catch(
    () => fail(`${posturePath} is missing; run npm run build first`),
  )

  function enumOf(definition, name) {
    if (!Array.isArray(definition?.enum)) fail(`${name} is no longer a string enum in the schema`)
    return definition.enum
  }

  const uncovered = []
  let counted = 0
  function expect(label, values, covered) {
    counted += values.length
    for (const value of values) if (!covered(value)) uncovered.push(`${label}: ${value}`)
  }

  const ask = defs.AskForApproval?.oneOf ?? fail('AskForApproval is missing')
  // schemars emits a documented unit variant as its own oneOf entry, so read
  // every string-enum entry, not just the first.
  const askStrings = ask.flatMap((variant) => (Array.isArray(variant.enum) ? variant.enum : []))
  if (askStrings.length === 0) fail('AskForApproval has no string enum variant in the schema')
  expect('AskForApproval', askStrings, covers.approvalPolicy)
  const granular = ask.find((variant) => variant.properties?.granular)?.properties.granular
  if (!granular?.properties) fail('the granular AskForApproval variant is missing')
  expect('granular approval flag', Object.keys(granular.properties), covers.granularFlag)
  expect('SandboxMode', enumOf(defs.SandboxMode, 'SandboxMode'), covers.sandboxMode)
  for (const variant of defs.SandboxPolicy?.oneOf ?? fail('SandboxPolicy is missing')) {
    const type = variant.properties?.type?.enum?.[0] ?? '(untyped variant)'
    expect('SandboxPolicy type', [type], covers.sandboxPolicyType)
    expect(`SandboxPolicy.${type} field`, Object.keys(variant.properties ?? {}), (field) =>
      covers.sandboxPolicyField(type, field),
    )
  }
  expect('ApprovalsReviewer', enumOf(defs.ApprovalsReviewer, 'ApprovalsReviewer'), covers.reviewer)
  expect('NetworkAccess', enumOf(defs.NetworkAccess, 'NetworkAccess'), covers.networkAccess)
  expect('ModeKind', enumOf(defs.ModeKind, 'ModeKind'), covers.modeKind)
  const fixture = join(fixtureRoot, 'test', 'fixtures', 'claude-permission-modes.json')
  const claude = JSON.parse(readFileSync(fixture, 'utf8'))
  expect('Claude permission mode', Object.keys(claude.modes), covers.claudePermissionMode)

  if (uncovered.length > 0) {
    fail(
      `src/posture.mts does not map:\n  ${uncovered.join('\n  ')}\n` +
        'Map each one (the tightest reading when in doubt) and extend test/posture.test.mts.',
    )
  }
  return counted
}
async function main() {
  // All official commands share the sandbox, total deadline and joined family.
  function generate(codex) {
    const result = isolatedCommand(
      codex,
      ({ work }) => ['app-server', 'generate-json-schema', '--experimental', '--out', work],
      {
        env: process.env,
        read: ({ work }, answer) =>
          answer.status === 0
            ? JSON.parse(
                readFileSync(join(work, 'codex_app_server_protocol.v2.schemas.json'), 'utf8'),
              ).definitions
            : null,
      },
    )
    if (result.status !== 0)
      fail(`schema generation exited ${result.status}: ${result.stderr.trim()}`)
    return result.value
  }

  const codex = process.env.CODEX_REAL?.trim()
  if (!codex) fail('set CODEX_REAL to a real codex binary')
  const count = await validatePosture(generate(codex))
  console.log(`Posture schema coverage OK: ${count} values and fields, all mapped.`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
