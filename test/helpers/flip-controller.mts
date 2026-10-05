import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runFlipForeground } from '../../src/control-flip-run.mjs'
import type { FlipOp } from '../../src/control-marker.mjs'
import { fakeSystem } from './fake-system.mjs'
import { scripted } from './flip-deps.mjs'
import { fakeLib, m0Home } from './m0-home.mjs'
export const ON = ['--yes', '--auto-rollback', '--lib', '0.1.0-m1test']
export async function setup(
  options: Parameters<typeof scripted>[1] = { gate: true },
  existingHome?: string,
) {
  const home = existingHome ?? (await m0Home())
  const root = join(home, '.anyengine')
  process.env.CODEX_HOME = join(home, '.codex')
  process.env.ANYENGINE_HOME = join(home, '.codex/anyengine')
  const version = '0.1.0-m1test'
  const libDir = join(root, 'lib', version)
  const plan = existingHome
    ? {
        version,
        libDir,
        node: process.execPath,
        claudeCli: join(home, 'tools with space', "claude's cli"),
        shimSource: join(libDir, 'scripts/codex-shim'),
        launcherSource: join(libDir, 'scripts/anyengine-launch'),
        stamp: '20261001T000000Z',
        app: join(home, 'Applications/ChatGPT.app'),
        bundleId: 'com.openai.codex',
      }
    : fakeLib(home)
  function manifest(version: string) {
    mkdirSync(join(root, 'lib', version), { recursive: true })
    writeFileSync(
      join(root, 'lib', version, 'install-manifest.json'),
      `${JSON.stringify({ version })}\n`,
    )
  }
  if (!existingHome) {
    manifest(plan.version)
    manifest('0.1.0-986ab707750e')
  }
  const system = fakeSystem(home)
  const { deps, events, log } = scripted(system, options)
  const snapshot = deps.currentSnapshot
  deps.currentSnapshot = () => {
    const value = snapshot()
    if (value.libDir)
      value.codeIdentity = createHash('sha256')
        .update(readFileSync(join(value.libDir, 'install-manifest.json')))
        .digest('hex')
    return value
  }
  const processes = system.processes
  system.processes = () => [
    {
      pid: process.pid,
      ppid: 1,
      command: 'node adapter.mjs on --foreground',
      processStart: '2026-10-01T00:00:00.000Z',
    },
    ...processes(),
  ]
  const out: string[] = []
  const run = (
    op: FlipOp,
    args: string[] = op === 'on' ? ON : ['--yes'],
    stop = { requested: null as NodeJS.Signals | null },
  ) => runFlipForeground(op, args, system, root, deps, (s) => out.push(s), stop)
  return { home, root, plan, system, deps, out, run, manifest, events, log }
}
