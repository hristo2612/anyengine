#!/usr/bin/env node
// The codex version this repo is pinned to is written down in several places:
// the adapter's and the shim's fallback compat version, the codex CI generates
// schemas with, and the docs. After an app update, move them all at once:
//
//   node scripts/sync-codex-compat.mjs               # the bundled codex's --version
//                                                    # (after npm run build: it finds that
//                                                    # codex with src/bundled-codex.mts)
//   node scripts/sync-codex-compat.mjs --version 0.156.0
//   node scripts/sync-codex-compat.mjs --check       # one line per site; exit 1 on disagreement
//
// test/compat-version.test.mts runs --check, so a partial bump fails CI.
// `npm run doctor` fails while the bundled codex and the pin differ.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isolatedCommand } from './lib/codex-probe.mjs'

const SITES = [
  ['src/util.mts', /(const DEFAULT_CODEX_COMPAT_VERSION = ')([^']+)(')/],
  ['test/compat-version.test.mts', /(const PINNED = ')([^']+)(')/],
  ['test/doctor.test.mts', /(const PINNED = ')([^']+)(')/],
  ['scripts/codex-shim', /(DEFAULT_COMPAT_VERSION=")([^"]+)(")/],
  ['.github/workflows/ci.yml', /(npm install --global @openai\/codex@)(\S+)( )/],
  ['docs/guide/configuration.md', /(the bundled codex's own version, else `)([^`]+)(`)/],
  ['docs/reference/capability-matrix.md', /(pinned to `)([^`]+)(`)/],
  ['docs/reference/release-readiness.md', /(`@openai\/codex@)([^`]+)(`)/],
  ['crates/anyengine-protocol/README.md', /(`@openai\/codex@)([^`]+)(`)/],
]

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(option('--root') ?? repo)

function pins() {
  return SITES.map(([file, pattern]) => {
    const match = pattern.exec(readFileSync(join(root, file), 'utf8'))
    return [file, match ? match[2] : null]
  })
}

function fail(message) {
  console.error(`sync-codex-compat: ${message}`)
  process.exit(1)
}

// The codex the shim and the adapter would run, by their own rule.
async function bundledVersion() {
  const rule = join(repo, 'dist', 'src', 'bundled-codex.mjs')
  const { resolveBundledCodex } = await import(pathToFileURL(rule).href).catch(() =>
    fail(`${rule} is missing; run npm run build first, or pass --version`),
  )
  const { path: bin, stale } = resolveBundledCodex(process.env)
  if (stale)
    console.error(`sync-codex-compat: skipping ANYENGINE_REAL_CODEX=${stale} (not executable)`)
  if (!bin) fail('no bundled codex in any ChatGPT.app layout; pass --version')
  const result = isolatedCommand(bin, ['--version'])
  const version = result.status === 0 ? /^codex-cli\s+(\S+)\s*$/m.exec(result.stdout)?.[1] : null
  if (!version) fail(`${bin} --version gave no version; pass --version`)
  console.log(`bundled codex ${bin}: ${version}`)
  return version
}

if (process.argv.includes('--check')) {
  const found = pins()
  for (const [file, version] of found) console.log(`${file} ${version ?? 'MISSING'}`)
  const versions = new Set(found.map(([, version]) => version))
  process.exit(versions.size === 1 && !versions.has(null) ? 0 : 1)
}

const version = option('--version') ?? (await bundledVersion())
for (const [file, pattern] of SITES) {
  const path = join(root, file)
  const text = readFileSync(path, 'utf8')
  if (!pattern.test(text)) fail(`no pin found in ${file}`)
  writeFileSync(
    path,
    text.replace(pattern, (_, head, _old, tail) => `${head}${version}${tail}`),
  )
  console.log(`${file} -> ${version}`)
}
