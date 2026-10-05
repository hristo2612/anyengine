import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LayerWriter, recoveryPaths } from '../../src/control-layers.mjs'
import {
  publicRecoveryScript,
  publishRecovery,
  type RecoveryOptions,
  shellQuote,
} from '../../src/control-scripts.mjs'
import { m0Home } from './m0-home.mjs'
export async function setup(odd = false) {
  const base = await m0Home()
  const home = odd ? join(base, "space ' and ü") : base
  if (odd) mkdirSync(home)
  const root = join(home, '.anyengine')
  const codexHome = join(home, '.codex')
  mkdirSync(codexHome, { recursive: true })
  const options: RecoveryOptions = {
    root,
    codexHome,
    app: join(home, "Odd ' App.app"),
    bundleId: 'dev.test.app',
  }
  const calls = join(home, 'calls')
  const stub = (name: string, body: string) => {
    const path = join(home, `${name}.sh`)
    writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o755 })
    return path
  }
  const env = {
    HOME: home,
    PATH: '/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR,
    ANYENGINE_PLUTIL: stub('plutil', 'echo "OddExecutable"'),
    ANYENGINE_PGREP: stub('pgrep', 'exit 1'),
    ANYENGINE_OSASCRIPT: stub('quit', `echo quit >> ${shellQuote(calls)}`),
    ANYENGINE_OPEN: stub('open', `echo open >> ${shellQuote(calls)}`),
    ANYENGINE_LAUNCHCTL: stub('launchctl', `echo "launchctl $*" >> ${shellQuote(calls)}`),
    ANYENGINE_QUIT_WAIT: '0',
  }
  options.commands = commands(env)
  options.quitWaitSeconds = 0
  publishRecovery(options)
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', 'anyengine-off'), publicRecoveryScript(root), { mode: 0o755 })
  const writer = new LayerWriter(root, null, 'router', 'test', () => publishRecovery(options))
  return { home, root, codexHome, options, writer, env, calls, stub }
}
export function run(s: Awaited<ReturnType<typeof setup>>, ...args: string[]) {
  return spawnSync('/bin/bash', [recoveryPaths(s.root).entry, ...args], {
    env: s.env,
    encoding: 'utf8',
  })
}

function commands(env: Record<string, string | undefined>) {
  return {
    launchctl: required(env.ANYENGINE_LAUNCHCTL),
    osascript: required(env.ANYENGINE_OSASCRIPT),
    open: required(env.ANYENGINE_OPEN),
    pgrep: required(env.ANYENGINE_PGREP),
    plutil: required(env.ANYENGINE_PLUTIL),
  }
}
export function configure(s: Awaited<ReturnType<typeof setup>>) {
  s.options.commands = commands(s.env)
  publishRecovery(s.options)
}

export function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined)
  return value
}
