#!/usr/bin/env node
// File-size ratchet: files never grow.
//
// Rule:
//   - Every `src/**/*.mts` file is capped at MAX_LINES (500), unless it is
//     listed in `scripts/size-baseline.json` with the length it had when it was
//     grandfathered.
//   - A listed file may shrink but never grow past its recorded number, and
//     leaves the baseline for good once it drops under the cap.
//   - Shrinking rewrites the baseline automatically.
//
// The cap was 800 when this landed, which was simply the length the big
// modules happened to have. 500 is what a module written today should stay
// under; the ones above it are frozen where they are and can only come down.
//
// The point is not the exact cap. It is that the big modules stop absorbing new
// code: to add behaviour to an over-cap file, extract a module first.
//
// Usage: node scripts/check-size.mjs
// In CI (`CI` set) the script never writes; a stale baseline is an error, so
// the shrink lands in the same commit as the code that caused it.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_LINES = 500
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(root, 'scripts', 'size-baseline.json')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.mts')) out.push(full)
  }
  return out
}

function countLines(file) {
  const text = readFileSync(file, 'utf8')
  if (text === '') return 0
  // `wc -l` semantics: a trailing newline does not open a new line.
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const files = walk(join(root, 'src')).sort()

const errors = []
const shrunk = []
const next = {}

for (const file of files) {
  const rel = relative(root, file)
  const lines = countLines(file)
  const allowed = baseline[rel]

  if (allowed === undefined) {
    if (lines > MAX_LINES) {
      errors.push(
        `${rel}: ${lines} lines exceeds the ${MAX_LINES}-line cap. ` +
          'Extract a module instead of growing this file.',
      )
    }
    continue
  }

  if (lines > allowed) {
    errors.push(
      `${rel}: ${lines} lines, up from the ${allowed}-line baseline. ` +
        'Files listed in scripts/size-baseline.json may shrink, never grow.',
    )
    next[rel] = allowed
    continue
  }

  if (lines < allowed) {
    shrunk.push(
      lines <= MAX_LINES
        ? `${rel}: ${allowed} -> ${lines}, now under the cap and off the baseline`
        : `${rel}: ${allowed} -> ${lines}`,
    )
  }
  if (lines > MAX_LINES) next[rel] = lines
}

for (const rel of Object.keys(baseline)) {
  if (!files.some((file) => relative(root, file) === rel)) {
    shrunk.push(`${rel}: deleted, removed from the baseline`)
  }
}

const stale = JSON.stringify(next) !== JSON.stringify(baseline)

if (errors.length > 0) {
  console.error('File-size ratchet failed:\n')
  for (const error of errors) console.error(`  - ${error}`)
  console.error('')
  process.exit(1)
}

if (stale) {
  if (process.env.CI) {
    console.error('scripts/size-baseline.json is stale:\n')
    for (const line of shrunk) console.error(`  - ${line}`)
    console.error('\nRun `npm run check` locally and commit the updated baseline.')
    process.exit(1)
  }
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
  console.log('Updated scripts/size-baseline.json (commit it):\n')
  for (const line of shrunk) console.log(`  - ${line}`)
  console.log('')
}

const overCap = Object.keys(next).length
console.log(
  `File-size ratchet OK: ${files.length} files, cap ${MAX_LINES}, ${overCap} grandfathered.`,
)
