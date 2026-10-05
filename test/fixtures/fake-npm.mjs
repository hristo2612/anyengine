#!/usr/bin/env node
// Stand-in for `npm ci --omit=dev` in the install-lib tests: records its argv,
// then writes a minimal ESM package for every runtime dependency of the
// package.json in the cwd. FAKE_NPM_FAIL=1 makes it fail like a broken install.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.env.FAKE_NPM_ARGV_FILE) {
  appendFileSync(process.env.FAKE_NPM_ARGV_FILE, `${JSON.stringify(process.argv.slice(2))}\n`)
}
if (process.env.FAKE_NPM_FAIL === '1') process.exit(3)
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
for (const name of Object.keys(pkg.dependencies ?? {})) {
  const dir = join('node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', type: 'module', main: 'index.js' }),
  )
  writeFileSync(join(dir, 'index.js'), 'export default {}\n')
}
