#!/usr/bin/env node
// Environment-variable documentation gate: every ANYENGINE_* name the adapter
// reads has an entry in docs/guide/configuration.md.
//
// Undocumented settings are how a codebase grows knobs nobody can find. This
// only looks at `src/**` — the adapter proper. Names read solely by the smoke
// and acceptance scripts under `scripts/` are test fixtures, not configuration,
// and are deliberately out of scope.
//
// Usage: node scripts/check-env-docs.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const docsPath = join(root, 'docs', 'guide', 'configuration.md')

// Names that exist only as a prefix or a doc example, never as a real setting.
const NOT_SETTINGS = new Set(['ANYENGINE_X'])

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.mts')) out.push(full)
  }
  return out
}

const readsByName = new Map()
for (const file of walk(join(root, 'src'))) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/\bANYENGINE_[A-Z0-9_]+/g)) {
    const name = match[0]
    if (NOT_SETTINGS.has(name)) continue
    const line = text.slice(0, match.index).split('\n').length
    if (!readsByName.has(name)) readsByName.set(name, `${relative(root, file)}:${line}`)
  }
}

// The docs group related settings on one row with a suffix shorthand, e.g.
// "`ANYENGINE_PTY_COLS` / `_ROWS`". Expand each `_SUFFIX` against the last full
// name seen on that line, so the house style counts as documentation.
const docs = readFileSync(docsPath, 'utf8')
const documented = new Set()
for (const line of docs.split('\n')) {
  let prefix = null
  for (const [token] of line.matchAll(/`(ANYENGINE_[A-Z0-9_]+|_[A-Z0-9_]+)`/g)) {
    const name = token.slice(1, -1)
    if (name.startsWith('ANYENGINE_')) {
      documented.add(name)
      prefix = name
    } else if (prefix) {
      // `_ROWS` after `ANYENGINE_PTY_COLS` means ANYENGINE_PTY_ROWS: replace the
      // last underscore-separated segment of the prefix.
      documented.add(prefix.slice(0, prefix.lastIndexOf('_')) + name)
      documented.add(`ANYENGINE${name}`)
    }
  }
}

const missing = [...readsByName.entries()]
  .filter(([name]) => !documented.has(name))
  .sort(([a], [b]) => a.localeCompare(b))

if (missing.length > 0) {
  console.error(
    `${missing.length} environment variable${missing.length === 1 ? '' : 's'} read by src/ ` +
      'with no entry in docs/guide/configuration.md:\n',
  )
  for (const [name, where] of missing) console.error(`  - ${name}  (${where})`)
  console.error('\nDocument it, or stop reading it.')
  process.exit(1)
}

console.log(`Env-docs gate OK: ${readsByName.size} ANYENGINE_* settings, all documented.`)
