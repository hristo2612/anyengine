#!/usr/bin/env node
// Build and stage first; the existing on command owns activation and rollback.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const usage = 'usage: anyengine setup [--yes] [--stage-only]\n'
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
export const RUNTIME_SHELL =
  'set -e; if [ -f "$1" ]; then . "$1"; fi; ' +
  'if [ -z "${ANYENGINE_RUNTIME_TYPE:-}${ANYENGINE_RUNTIME:-}${ANYENGINE_BACKEND:-}" ]; then export ANYENGINE_RUNTIME_TYPE=anyengine; fi; ' +
  'shift; exec "$@"'

export function setup(args, options = {}) {
  const say = options.say ?? console.log
  const run = options.run ?? spawnSync
  const source = options.source ?? repo
  const env = { ...process.env, ...options.env }
  const root = resolve(env.ANYENGINE_ROOT ?? join(env.HOME ?? homedir(), '.anyengine'))
  if (args.length === 1 && args[0] === '--help') {
    say(usage)
    return 0
  }
  if (args.some((arg) => !['--yes', '--stage-only'].includes(arg))) {
    say(usage)
    return 2
  }
  if (
    (options.platform ?? process.platform) !== 'darwin' ||
    Number(process.versions.node.split('.')[0]) < 24
  )
    throw new Error('setup requires macOS and Node.js 24 or newer')
  if (!['zsh', 'bash'].includes((env.SHELL ?? '').split('/').pop()))
    throw new Error('setup supports zsh or bash; set SHELL to your login shell')
  env.PATH = `${dirname(process.execPath)}:${env.PATH ?? '/usr/bin:/bin'}`
  env.ANYENGINE_ROOT = root
  env.ANYENGINE_NODE = process.execPath
  const packaged =
    existsSync(join(source, 'npm-shrinkwrap.json')) && !existsSync(join(source, 'tsconfig.json'))
  const git = (...argv) => {
    const result = run('git', ['-C', source, ...argv], { env, encoding: 'utf8' })
    if (result.error || result.status !== 0) throw new Error('setup requires a Git checkout')
    return result.stdout.trim()
  }
  if (!packaged && git('status', '--porcelain'))
    throw new Error('the checkout has uncommitted changes; commit or stash them before setup')
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const version = packaged
    ? pkg.version
    : `${pkg.version}-${git('rev-parse', '--short=12', 'HEAD')}`
  const step = (label, command, argv) => {
    say(`setup: ${label}`)
    const result = run(command, argv, { cwd: source, env, stdio: 'inherit' })
    if (result.error || result.status !== 0)
      throw new Error(
        `${label} failed; activation stopped. Preserve any recovery command printed above.`,
      )
  }
  if (!packaged) {
    step('install dependencies', 'npm', ['ci', '--no-audit', '--no-fund'])
    step('build', 'npm', ['run', 'build'])
  }
  step('stage verified library', process.execPath, [
    join(source, 'scripts/install-lib.mjs'),
    '--source',
    source,
    '--dest-root',
    join(root, 'lib'),
    '--no-activate',
  ])
  const adapter = join(root, 'lib', version, 'dist/src/adapter.mjs')
  const runtimeEnv = env.ANYENGINE_RUNTIME_ENV ?? join(root, 'runtime.env')
  const activate = [
    '-c',
    RUNTIME_SHELL,
    'anyengine-setup',
    runtimeEnv,
    process.execPath,
    adapter,
    'on',
    '--lib',
    version,
    '--auto-rollback',
  ]
  if (args.includes('--stage-only')) {
    say(
      `Staged only. To enable: ANYENGINE_ROOT=${quote(root)} /bin/bash ${activate.map(quote).join(' ')}`,
    )
    return 0
  }
  step('enable AnyEngine (includes restart and live checks)', '/bin/bash', [
    ...activate,
    ...(args.includes('--yes') ? ['--yes'] : []),
  ])
  say('Setup complete. Fresh installs expose anyengine in new terminals.')
  say(`For this terminal: export PATH=${quote(join(root, 'bin'))}:"$PATH"`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = setup(process.argv.slice(2))
  } catch (error) {
    console.error(`setup: ${error.message}`)
    process.exitCode = 1
  }
}
