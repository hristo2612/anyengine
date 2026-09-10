#!/usr/bin/env node
// Complexity ratchet: the worst function never gets worse, and the count of
// hot spots never grows.
//
// Biome already warns past a cognitive complexity of 30, but a warning does
// not fail anything, so the number drifts up unnoticed — which is how
// `server.mts` reached 186. This gate freezes two numbers in
// `scripts/complexity-baseline.json`:
//
//   - `worst`: the highest cognitive complexity in `src/**`.
//   - `count`: how many functions are over Biome's warning threshold.
//
// Either may fall, never rise. A fall rewrites the baseline automatically and
// the smaller numbers are committed with the change, exactly like
// `check-size.mjs`. In CI (`CI` set) the script never writes, so a stale
// baseline fails and the update has to land in the commit that earned it.
//
// Usage: node scripts/check-complexity.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(root, 'scripts', 'complexity-baseline.json')

// Biome exits non-zero when it reports diagnostics; the JSON is still on
// stdout, so read it out of the error rather than treating it as a failure.
function biomeDiagnostics() {
  const args = [
    'biome',
    'lint',
    '--max-diagnostics=1000',
    '--reporter=json',
    '--only=complexity/noExcessiveCognitiveComplexity',
    'src',
  ]
  try {
    return JSON.parse(execFileSync('npx', args, { cwd: root, encoding: 'utf8' })).diagnostics
  } catch (error) {
    if (typeof error.stdout !== 'string' || error.stdout === '') throw error
    return JSON.parse(error.stdout).diagnostics
  }
}

const diagnostics = biomeDiagnostics()
const scored = diagnostics
  .map((diagnostic) => ({
    complexity: Number(/Excessive complexity of (\d+)/.exec(diagnostic.message)?.[1] ?? 0),
    where: `${diagnostic.location.path}:${diagnostic.location.start.line}`,
  }))
  .sort((a, b) => b.complexity - a.complexity)

const next = { worst: scored[0]?.complexity ?? 0, count: scored.length }
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))

const errors = []
if (next.worst > baseline.worst) {
  errors.push(
    `worst cognitive complexity is ${next.worst} (${scored[0].where}), up from ${baseline.worst}. ` +
      'Split the function into named steps instead of growing it.',
  )
}
if (next.count > baseline.count) {
  errors.push(
    `${next.count} functions are over the warning threshold, up from ${baseline.count}. ` +
      'Every new hot spot is a review comment.',
  )
}

if (errors.length > 0) {
  console.error('Complexity ratchet failed:\n')
  for (const error of errors) console.error(`  - ${error}`)
  console.error('\nWorst offenders:')
  for (const entry of scored.slice(0, 5)) {
    console.error(`  ${String(entry.complexity).padStart(4)}  ${entry.where}`)
  }
  console.error('')
  process.exit(1)
}

if (next.worst !== baseline.worst || next.count !== baseline.count) {
  if (process.env.CI) {
    console.error(
      `scripts/complexity-baseline.json is stale: worst ${baseline.worst} -> ${next.worst}, ` +
        `count ${baseline.count} -> ${next.count}.\n\n` +
        'Run `npm run check` locally and commit the updated baseline.',
    )
    process.exit(1)
  }
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
  console.log(
    `Updated scripts/complexity-baseline.json (commit it): worst ${baseline.worst} -> ${next.worst}, ` +
      `count ${baseline.count} -> ${next.count}.`,
  )
}

console.log(
  `Complexity ratchet OK: worst ${next.worst}, ${next.count} over Biome's warning threshold.`,
)
