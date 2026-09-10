#!/usr/bin/env node
// Dependency guard: a new runtime dependency has to be a deliberate step.
//
// `scripts/deps-baseline.json` mirrors the `dependencies` block of
// package.json. They must match exactly. Adding, removing or re-ranging a
// runtime dependency therefore takes a second, visible edit —
// `node scripts/check-deps.mjs --update` — that lands in the same commit and
// shows up in review next to the one-line justification CONTRIBUTING asks for.
//
// devDependencies are not guarded: they never reach a user's machine.
//
// Usage: node scripts/check-deps.mjs [--update]

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(root, 'scripts', 'deps-baseline.json')

const sort = (deps) =>
  Object.fromEntries(Object.entries(deps ?? {}).sort(([a], [b]) => a.localeCompare(b)))

const current = sort(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies)

if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`)
  console.log('Updated scripts/deps-baseline.json. Commit it with a one-line justification.')
  process.exit(0)
}

const baseline = sort(JSON.parse(readFileSync(baselinePath, 'utf8')))
const names = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()
const drift = []

for (const name of names) {
  const was = baseline[name]
  const now = current[name]
  if (was === now) continue
  if (was === undefined) drift.push(`added   ${name}@${now}`)
  else if (now === undefined) drift.push(`removed ${name}@${was}`)
  else drift.push(`changed ${name}: ${was} -> ${now}`)
}

if (drift.length > 0) {
  console.error('Runtime dependencies changed without updating scripts/deps-baseline.json:\n')
  for (const line of drift) console.error(`  - ${line}`)
  console.error(
    '\nEvery runtime dependency ships to users. If this one is worth it, run\n' +
      '  node scripts/check-deps.mjs --update\n' +
      'and commit the baseline with a one-line justification in the commit message.',
  )
  process.exit(1)
}

console.log(`Dependency guard OK: ${names.length} runtime dependencies, unchanged.`)
