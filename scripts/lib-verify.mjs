#!/usr/bin/env node
// Verify an installed adapter lib (scripts/install-lib.mjs): every file the
// manifest lists is present with its recorded sha256, every symlink points
// where it did, and the adapter passes `selfcheck --deep`. Used by install-lib
// before `current` moves, and by `npm run doctor`.
//
// Usage: node scripts/lib-verify.mjs <libDir>
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MANIFEST = 'install-manifest.json'

function walk(dir, root, tree) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = relative(root, full)
    if (rel === MANIFEST) continue
    if (entry.isSymbolicLink()) tree.links[rel] = readlinkSync(full)
    else if (entry.isDirectory()) walk(full, root, tree)
    else if (entry.isFile()) tree.files[rel] = sha256(full)
  }
  return tree
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function writeManifest(dir, meta) {
  const tree = walk(dir, dir, { files: {}, links: {} })
  const manifest = { ...meta, node: process.version, createdAt: new Date().toISOString(), ...tree }
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 1)}\n`)
}

export function verifyLib(dir) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'))
  } catch {
    return [`${MANIFEST} is missing or unreadable`]
  }
  const actual = walk(dir, dir, { files: {}, links: {} })
  const problems = []
  for (const [rel, hash] of Object.entries(manifest.files ?? {})) {
    if (!(rel in actual.files)) problems.push(`missing: ${rel}`)
    else if (actual.files[rel] !== hash) problems.push(`changed: ${rel}`)
  }
  for (const [rel, target] of Object.entries(manifest.links ?? {})) {
    if (actual.links[rel] !== target) problems.push(`link missing or moved: ${rel}`)
  }
  if (problems.length > 0) return problems
  const adapter = join(dir, 'dist', 'src', 'adapter.mjs')
  const check = spawnSync(process.execPath, [adapter, 'selfcheck', '--deep'], { encoding: 'utf8' })
  if (check.status !== 0) {
    const last = `${check.stderr}${check.stdout}`.trim().split('\n').at(-1) ?? ''
    problems.push(`selfcheck --deep failed: ${last}`)
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: node scripts/lib-verify.mjs <libDir>')
    process.exit(2)
  }
  const problems = verifyLib(dir)
  if (problems.length > 0) {
    console.error(`lib-verify: ${dir} does not verify:\n  ${problems.slice(0, 20).join('\n  ')}`)
    process.exit(1)
  }
  console.log(`lib-verify: ${dir} ok`)
}
