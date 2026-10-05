// Read-only admission and CLI parsing shared by the front and the runner.
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfig } from './anyengine-config.mjs'
import { withoutLines } from './codex-config-toml.mjs'
import { inspectModelsCache } from './control-cache.mjs'
import type { InstallPaths, OnPlan } from './control-install.mjs'
import { configAt, pickAt, readText } from './control-install-on.mjs'
import { statAt } from './control-layer-state.mjs'
import { readLayers } from './control-layers.mjs'
import { type FlipOp, readFlipMarker } from './control-marker.mjs'
import type { FlipDeps } from './control-postflight.mjs'
import { readStatusKnownGood, readStatusSmoke } from './control-status-evidence.mjs'
import { ancestorCommands, type System } from './control-system.mjs'
import { inspectDegraded, inspectProof } from './degraded.mjs'

export interface CommonOptions {
  yes: boolean
  waitQuietMinutes: number
  force: boolean
  foreground: boolean
  follow: boolean
}
export interface OnOptions extends CommonOptions {
  noRestart: boolean
  autoRollback: boolean
  lib: string | null
  dryRun: boolean
  nativeProof: string | null
}
export interface OffOptions extends CommonOptions {
  routerOnly: boolean
  noRestart: boolean
}
export interface RestartOptions extends CommonOptions {}
export const executingLib = () => resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const allowed: Record<FlipOp, string[]> = {
  on: [
    '--yes',
    '--force',
    '--foreground',
    '--no-follow',
    '--no-restart',
    '--auto-rollback',
    '--dry-run',
    '--lib',
    '--native-proof',
    '--wait-quiet',
  ],
  off: [
    '--yes',
    '--force',
    '--foreground',
    '--no-follow',
    '--no-restart',
    '--router-only',
    '--wait-quiet',
  ],
  restart: ['--yes', '--force', '--foreground', '--no-follow', '--wait-quiet'],
}
function parseValue(out: OnOptions, arg: string, value: string): string | undefined {
  if (arg === '--lib') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) || value === 'current')
      return 'invalid installed library version'
    out.lib = value
  } else if (arg === '--native-proof') out.nativeProof = resolve(value)
  else {
    if (!/^\d+$/.test(value) || Number(value) > 60) return '--wait-quiet must be 0–60 minutes'
    out.waitQuietMinutes = Number(value)
  }
}
function parse(op: FlipOp, args: string[]): (OnOptions & OffOptions) | string {
  const out: OnOptions & OffOptions = {
    yes: false,
    force: false,
    foreground: false,
    follow: true,
    waitQuietMinutes: 0,
    noRestart: false,
    autoRollback: false,
    lib: null,
    dryRun: false,
    nativeProof: null,
    routerOnly: false,
  }
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (!allowed[op].includes(arg) || seen.has(arg)) return `invalid ${op} argument: ${arg}`
    seen.add(arg)
    if (['--lib', '--native-proof', '--wait-quiet'].includes(arg)) {
      const value = args[++i]
      if (!value || value.startsWith('--') || /[\0\r\n]/.test(value))
        return `missing or invalid ${arg} value`
      const error = parseValue(out, arg, value)
      if (error) return error
    } else {
      const fields = {
        '--yes': 'yes',
        '--force': 'force',
        '--foreground': 'foreground',
        '--no-restart': 'noRestart',
        '--auto-rollback': 'autoRollback',
        '--dry-run': 'dryRun',
        '--router-only': 'routerOnly',
      } as const
      if (arg === '--no-follow') out.follow = false
      else out[fields[arg as keyof typeof fields]] = true
    }
  }
  return out
}
export const parseOnArgs = (args: string[]): OnOptions | string => parse('on', args)
export const parseOffArgs = (args: string[]): OffOptions | string => parse('off', args)
export const parseRestartArgs = (args: string[]): RestartOptions | string => parse('restart', args)
export function parseFlipArgs(op: FlipOp, args: string[]) {
  return parse(op, args)
}
export function insideTheApp(system: System, pid: number): string | null {
  return (
    ancestorCommands(system, pid).find((command) => command.startsWith(`${system.app}/`)) ?? null
  )
}
export function outsideApp(system: System): void {
  const ancestor = insideTheApp(system, process.pid)
  if (ancestor)
    throw new Error(
      `this command runs inside ChatGPT.app (${ancestor}); quitting the app would stop it. Run it from Terminal or another app.`,
    )
}
export function flipPaths(system: System): InstallPaths {
  const codexHome = process.env.CODEX_HOME || join(system.home, '.codex')
  return {
    codexHome,
    pickFile: join(
      process.env.ANYENGINE_HOME || join(codexHome, 'anyengine'),
      'app-model-pick.json',
    ),
  }
}
export function admitEvidence(system: System, root: string): void {
  readFlipMarker(root)
  readLayers(root)
  const config = configAt(root)
  const paths = flipPaths(system)
  pickAt(paths.pickFile)
  withoutLines(readText(join(paths.codexHome, 'config.toml')), [])
  inspectProof(root)
  inspectDegraded(root)
  readStatusKnownGood(root)
  readStatusSmoke(root)
  const cache = inspectModelsCache(paths.codexHome, new Set(config.claude.models.map((m) => m.id)))
  if (cache.parseError) throw new Error(`invalid models cache: ${cache.parseError}`)
}
export function resolvePlan(
  system: System,
  root: string,
  deps: FlipDeps,
  version: string | null,
): OnPlan {
  const running = executingLib()
  const selected = version ?? (dirname(running) === join(root, 'lib') ? basename(running) : null)
  if (!selected)
    throw new Error(
      'install it first: npm run install:lib -- --no-activate, then run <root>/lib/<version>/scripts/anyengine-launch on --lib <version>',
    )
  const libDir = join(root, 'lib', selected)
  const problems = deps.verifyLib(libDir)
  if (problems.length) throw new Error(problems.join('; '))
  return {
    version: selected,
    claudeCode: Boolean(statAt(join(libDir, 'dist/src/control-claude-layer.mjs'))),
    libDir,
    node: process.execPath,
    claudeCli: readConfig(root).config.claude.cli ?? discoverClaudeCli(system),
    shimSource: join(libDir, 'scripts/codex-shim'),
    launcherSource: join(libDir, 'scripts/anyengine-launch'),
    stamp: randomUUID(),
    app: system.app,
    bundleId: 'com.openai.codex',
  }
}

function discoverClaudeCli(system: System): string | null {
  const found = system.exec('/usr/bin/which', ['claude'], { timeoutMs: 2000 })
  const path = found.stdout.trim()
  return found.status === 0 && isAbsolute(path) && !/[\0\r\n]/.test(path) ? path : null
}
