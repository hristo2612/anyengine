// Verified prior-version authority and isolated fake Mac actions for recovery tests.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { FlipContext } from '../../src/control-flip-recovery.mjs'
import { applyOnFiles } from '../../src/control-install.mjs'
import { digest } from '../../src/control-layer-state.mjs'
import { readLayers, recoveryPaths, writeLayers } from '../../src/control-layers.mjs'
import { realFlipDeps } from '../../src/control-postflight.mjs'
import type { RecoveryOptions } from '../../src/control-scripts.mjs'
import { setup } from './flip-controller.mjs'
import { pathsFor } from './m0-home.mjs'

const prefix = '#!/bin/bash\n# retained 0.1.1 recovery fixture\n# '
const suffix = '\nexit 1\n'
export function recordedScript(layers: unknown, options: RecoveryOptions): string {
  return prefix + JSON.stringify({ layers, options }) + suffix
}
// Include identities as well as bytes: refusal must not replace authority with
// equivalent new files, and must not rewrite journals or regenerate recovery.
export function tree(root: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  function walk(path: string) {
    const stat = lstatSync(path)
    const name = relative(root, path)
    if (stat.isDirectory()) {
      result[name] = { mode: stat.mode, uid: stat.uid, ino: stat.ino }
      for (const child of readdirSync(path).sort()) walk(join(path, child))
    } else {
      result[name] = {
        mode: stat.mode,
        uid: stat.uid,
        ino: stat.ino,
        bytes: stat.isSymbolicLink() ? readlinkSync(path) : digest(readFileSync(path)),
      }
    }
  }
  walk(root)
  return result
}
export async function retained() {
  const s = await setup()
  s.system.running = false
  applyOnFiles(s.system, s.root, s.plan, { dryRun: false, paths: pathsFor(s.home) })
  s.system.openApp()
  s.system.calls.length = 0
  const lib = join(s.root, 'lib/0.1.1')
  const files: Record<string, string> = {
    'dist/src/adapter.mjs': '// inert old adapter; never launched\n',
    'scripts/lib-verify.mjs': '// tree verification is owned by the admitting controller\n',
    'dist/src/control-scripts.mjs': "export { offScript } from './recovery-template.mjs'\n",
    'dist/src/recovery-template.mjs': `export function offScript(layers, options) {
  return ${JSON.stringify(prefix)} + JSON.stringify({ layers, options }) + ${JSON.stringify(suffix)}
}\n`,
  }
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(lib, name)), { recursive: true })
    writeFileSync(join(lib, name), bytes)
  }
  writeFileSync(
    join(lib, 'install-manifest.json'),
    JSON.stringify({
      version: '0.1.1',
      files: Object.fromEntries(
        Object.entries(files).map(([name, bytes]) => [name, digest(Buffer.from(bytes))]),
      ),
      links: {},
    }),
  )
  const paths = recoveryPaths(s.root)
  const journal = readLayers(s.root)
  journal.recovery = { entry: paths.entry, controlLib: lib, pinnedLibs: [lib, s.plan.libDir] }
  writeLayers(s.root, journal)
  const options: RecoveryOptions = {
    root: s.root,
    app: s.system.app,
    bundleId: 'com.openai.codex',
    codexHome: join(s.home, '.codex'),
  }
  writeFileSync(paths.entry, recordedScript(journal.layers, options))
  writeFileSync(join(s.root, 'state/flip.json'), '{"retained":"marker fixture"}\n', { mode: 0o600 })
  const executions: string[][] = []
  s.system.exec = (command, args, options) => {
    assert.equal(command, process.execPath)
    executions.push(args)
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: options?.timeoutMs ?? 5000,
      env: options?.env ?? { HOME: s.home, PATH: '/usr/bin:/bin' },
      ...(options?.input !== undefined ? { input: options.input } : {}),
    })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  const verifier = realFlipDeps(s.system, s.root, s.plan.libDir).verifyLib
  s.deps.verifyLib = verifier
  const phases: string[] = []
  const ctx: FlipContext = {
    ...s,
    say: (message) => s.out.push(message),
    stop: { requested: null },
    marker: (phase) => phases.push(phase),
  }
  return { ...s, paths, lib, options, ctx, phases, executions }
}
export type Retained = Awaited<ReturnType<typeof retained>>
export const generations = (s: Retained) =>
  s.executions.filter((args) => args[0] === '--input-type=module')
