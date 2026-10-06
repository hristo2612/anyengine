#!/usr/bin/env node
// npm/npx entry. Installing alone never edits host settings or restarts the app.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const root = resolve(
  process.env.ANYENGINE_ROOT ?? join(process.env.HOME ?? homedir(), '.anyengine'),
)
const help = `Usage: anyengine <command>
  setup [--yes] [--stage-only]   Install and enable AnyEngine on macOS
  status | doctor              Inspect the installed runtime
  on | off | restart | rollback
  config | mode | cache | smoke | codex
  accounts | limits | sessions | desktop
  --version                    Show the npm package version

Install or update: npx anyengine-cli@latest setup
`

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('anyengine requires Node.js 24 or newer')
  process.exitCode = 1
} else if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  console.log(help)
} else if (args.length === 1 && ['--version', 'version'].includes(args[0])) {
  console.log(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version)
} else if (args[0] === 'setup') {
  const { setup } = await import('./setup.mjs')
  try {
    process.exitCode = setup(args.slice(1))
  } catch (error) {
    console.error(`setup: ${error.message}`)
    process.exitCode = 1
  }
} else {
  // Existing controls use their active, pinned library and its runtime settings.
  const launcher = join(root, 'bin/anyengine')
  const installed = existsSync(launcher)
  const { RUNTIME_SHELL } = await import('./setup.mjs')
  const argv = installed
    ? [launcher, ...args]
    : [
        '-c',
        RUNTIME_SHELL,
        'anyengine',
        process.env.ANYENGINE_RUNTIME_ENV ?? join(root, 'runtime.env'),
        process.execPath,
        join(source, 'dist/src/adapter.mjs'),
        ...args,
      ]
  const result = spawnSync('/bin/bash', argv, { stdio: 'inherit' })
  if (result.error) console.error(`anyengine: ${result.error.message}`)
  process.exitCode = result.status ?? 1
}
