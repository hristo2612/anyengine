import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { type CodexClaudeMode, enginePaths } from './anyengine-config.mjs'
import { admitEvidence } from './control-flip-options.mjs'
import type { OnPlan } from './control-install-on.mjs'
import { configAt } from './control-install-on.mjs'
import { validateChange } from './control-layer-journal.mjs'
import {
  absolute,
  atomicFile,
  digest,
  type FileChange,
  jsonAt,
  object,
  regularBytes,
  statAt,
  syncDirectory,
} from './control-layer-state.mjs'
import { realFlipDeps } from './control-postflight-evidence.mjs'
import type { System } from './control-system.mjs'

export interface M2Baseline {
  version: 1
  rollbackDir: string
  recoveryScript: string
  recoveryJournal: string
  phase: 'prepared' | 'activating' | 'active' | 'rolling-back' | 'rolled-back' | 'conflict'
  priorLib: string
  m1LayersBackup: string
  m1LayersSha256: string
  controlChanges: FileChange[]
  jobs: Array<{ label: string; plist: string; loaded: boolean }>
}

export interface M2Journal {
  version: 1
  baselineId: string
  baseline: M2Baseline
  transactionId: string | null
  sharedMarkerDetached: boolean
  expectedLayersSha256: string
  manifestSha256: string
  home: string
  canonical?: string
  app: string
  bundleId: string
  port: number
  m1Mode: CodexClaudeMode
  commands: NonNullable<OnPlan['recoveryCommands']>
  checkpoint: string | null
  conflicts: string[]
  linkModes: Record<string, number>
  retired?: boolean
}

export type RecoveryMilestone = 'm2' | 'm3'

// M3 reuses this private schema; m1Layers* denotes the immediately prior layer snapshot.
export const m2Paths = (root: string, milestone: RecoveryMilestone = 'm2') => {
  const directory = join(root, 'recovery', milestone)
  return {
    directory,
    entry: join(directory, 'recover.sh'),
    pointer: join(directory, 'current.json'),
    instructions: join(directory, 'RECOVER.txt'),
    record: join(root, `${milestone}-upgrade.json`),
  }
}

const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)

export function owned(path: string, kind: 'file' | 'directory', mode?: number): void {
  const stat = lstatSync(path)
  if (
    (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (mode !== undefined && (stat.mode & 0o777) !== mode)
  )
    throw new Error(`unowned or unsafe M2 recovery ${kind}: ${path}`)
}

export function prepareM2Directory(
  root: string,
  directory: string,
  milestone: RecoveryMilestone = 'm2',
): void {
  if (
    !absolute(root) ||
    !(
      directory === m2Paths(root, milestone).directory ||
      directory.startsWith(`${m2Paths(root, milestone).directory}/`)
    )
  )
    throw new Error('invalid M2 recovery directory')
  owned(root, 'directory')
  const missing: string[] = []
  for (let cursor = directory; cursor !== root; cursor = dirname(cursor)) {
    if (statAt(cursor)) owned(cursor, 'directory')
    else missing.unshift(cursor)
  }
  for (const path of missing) {
    mkdirSync(path, { mode: 0o700 })
    syncDirectory(dirname(path))
  }
  owned(directory, 'directory', 0o700)
}

export function controlTarget(
  root: string,
  home: string,
  target: string,
  baseline?: M2Baseline,
): boolean {
  if (
    !absolute(target) ||
    ['m2', 'm3'].some(
      (name) =>
        target === join(root, 'recovery', name) ||
        target.startsWith(`${join(root, 'recovery', name)}/`),
    )
  )
    return false
  return (
    target === join(root, 'lib/current') ||
    target === join(root, 'runtime.env') ||
    dirname(target) === join(root, 'bin') ||
    target === join(home, 'bin/codex') ||
    target === join(root, 'RECOVER.txt') ||
    target === join(root, 'recovery/anyengine-off') ||
    (dirname(target) === join(home, 'Library/LaunchAgents') &&
      /^dev\.anyengine\.(router|smoke)\.plist$/.test(basename(target))) ||
    (baseline?.controlChanges.some((change) => change.target === target) ?? false)
  )
}

export function validateM2Baseline(
  root: string,
  value: unknown,
  home: string,
  milestone: RecoveryMilestone = 'm2',
): asserts value is M2Baseline {
  if (
    !object(value) ||
    value.version !== 1 ||
    !absolute(value.rollbackDir) ||
    dirname(value.rollbackDir) !== m2Paths(root, milestone).directory ||
    !id(basename(value.rollbackDir)) ||
    value.recoveryScript !== join(value.rollbackDir, 'recover.sh') ||
    value.recoveryJournal !== join(value.rollbackDir, 'journal.json') ||
    value.m1LayersBackup !== join(value.rollbackDir, 'm1-layers.json') ||
    !sha(value.m1LayersSha256) ||
    !absolute(value.priorLib) ||
    dirname(value.priorLib) !== join(root, 'lib') ||
    !['prepared', 'activating', 'active', 'rolling-back', 'rolled-back', 'conflict'].includes(
      String(value.phase),
    ) ||
    !Array.isArray(value.controlChanges) ||
    value.controlChanges.length > 128 ||
    !Array.isArray(value.jobs) ||
    value.jobs.length !== 2
  )
    throw new Error('invalid M2 baseline record; retain recovery and library pins')
  owned(value.rollbackDir, 'directory', 0o700)
  owned(value.m1LayersBackup, 'file', 0o600)
  if (digest(regularBytes(value.m1LayersBackup, 2_000_000)) !== value.m1LayersSha256)
    throw new Error('M2 baseline M1 layers hash mismatch')
  const layers = jsonAt(value.m1LayersBackup)
  if (!object(layers) || !Array.isArray(layers.layers)) throw new Error('invalid M1 layer copy')
  const rollbackScripts = layers.layers.flatMap((layer) =>
    object(layer) && absolute(layer.rollbackDir) ? [join(layer.rollbackDir, 'ROLLBACK.sh')] : [],
  )
  const targets = new Set<string>()
  for (const change of value.controlChanges as FileChange[]) {
    if (
      !controlTarget(root, home, change.target) &&
      !rollbackScripts.includes(change.target) &&
      !(milestone === 'm3' && m3ClaudeTarget(home, change.target))
    )
      throw new Error('M2 control target is outside the install')
    if (targets.has(change.target)) throw new Error('duplicate M2 control target')
    targets.add(change.target)
    validateChange(change, value.rollbackDir)
  }
  for (const job of value.jobs) {
    if (
      !object(job) ||
      !['dev.anyengine.router', 'dev.anyengine.smoke'].includes(String(job.label)) ||
      job.plist !== join(home, 'Library/LaunchAgents', `${job.label}.plist`) ||
      typeof job.loaded !== 'boolean'
    )
      throw new Error('invalid M2 baseline job')
  }
}

export function writeM2Journal(
  root: string,
  journal: M2Journal,
  advertise = true,
  milestone: RecoveryMilestone = 'm2',
): void {
  validateM2Baseline(root, journal.baseline, journal.home, milestone)
  validateLinkModes(journal.baseline, journal.linkModes)
  if (!['agent', 'model'].includes(journal.m1Mode)) throw new Error('invalid M1 baseline mode')
  atomicFile(journal.baseline.recoveryJournal, Buffer.from(`${JSON.stringify(journal)}\n`), 0o600)
  if (advertise)
    atomicFile(
      m2Paths(root, milestone).record,
      Buffer.from(`${JSON.stringify(journal.baseline)}\n`),
      0o600,
    )
}

function validateLinkModes(baseline: M2Baseline, value: unknown): void {
  if (!object(value)) throw new Error('invalid M2 link modes')
  const links = baseline.controlChanges.filter((change) => change.before === 'symlink')
  if (
    Object.keys(value).length !== links.length ||
    !links.every(
      (change) =>
        Number.isInteger(value[change.target]) &&
        Number(value[change.target]) >= 0 &&
        Number(value[change.target]) <= 0o7777,
    )
  )
    throw new Error('invalid M2 baseline link modes')
}

export function readM2Journal(root: string, milestone: RecoveryMilestone = 'm2'): M2Journal | null {
  const paths = m2Paths(root, milestone)
  if (!statAt(paths.record)) return null
  owned(root, 'directory')
  owned(paths.directory, 'directory', 0o700)
  owned(paths.record, 'file', 0o600)
  const record = jsonAt(paths.record)
  if (!object(record) || !absolute(record.recoveryJournal))
    throw new Error('invalid M2 baseline reference')
  const dir = dirname(record.recoveryJournal)
  if (
    dirname(dir) !== paths.directory ||
    !id(basename(dir)) ||
    record.recoveryJournal !== join(dir, 'journal.json')
  )
    throw new Error('escaped M2 baseline reference')
  owned(dir, 'directory', 0o700)
  owned(record.recoveryJournal, 'file', 0o600)
  const journal = jsonAt(record.recoveryJournal)
  if (
    !object(journal) ||
    journal.version !== 1 ||
    journal.baselineId !== basename(dir) ||
    !absolute(journal.home) ||
    (milestone === 'm3' && !absolute(journal.canonical)) ||
    !absolute(journal.app) ||
    typeof journal.bundleId !== 'string' ||
    !sha(journal.expectedLayersSha256) ||
    !sha(journal.manifestSha256) ||
    !Number.isInteger(journal.port) ||
    Number(journal.port) < 1 ||
    Number(journal.port) > 65535 ||
    !['agent', 'model'].includes(String(journal.m1Mode)) ||
    typeof journal.sharedMarkerDetached !== 'boolean' ||
    !(journal.transactionId === null || typeof journal.transactionId === 'string') ||
    !object(journal.commands) ||
    Object.values(journal.commands).some((command) => !absolute(command)) ||
    !Array.isArray(journal.conflicts) ||
    !journal.conflicts.every((conflict) => typeof conflict === 'string')
  )
    throw new Error('invalid private M2 recovery journal')
  validateM2Baseline(root, journal.baseline, journal.home, milestone)
  validateLinkModes(journal.baseline, journal.linkModes)
  if (
    record.rollbackDir !== journal.baseline.rollbackDir ||
    record.priorLib !== journal.baseline.priorLib
  )
    throw new Error('M2 baseline reference changed')
  owned(paths.pointer, 'file', 0o600)
  const pointer = jsonAt(paths.pointer)
  if (
    !object(pointer) ||
    pointer.script !== journal.baseline.recoveryScript ||
    pointer.journal !== journal.baseline.recoveryJournal ||
    pointer.baselineId !== journal.baselineId ||
    !sha(pointer.scriptSha256)
  )
    throw new Error('invalid M2 recovery pointer')
  owned(pointer.script as string, 'file', 0o700)
  if (digest(regularBytes(pointer.script as string, 2_000_000)) !== pointer.scriptSha256)
    throw new Error('M2 recovery script hash mismatch')
  return journal as unknown as M2Journal
}

export function verifyM1(
  system: System,
  root: string,
  lib: string,
  commands: M2Journal['commands'] = {},
): CodexClaudeMode {
  if (
    dirname(lib) !== join(root, 'lib') ||
    realpathSync(join(root, 'lib/current')) !== lib ||
    realpathSync(lib) !== resolve(lib)
  )
    throw new Error('installed M1 library layout mismatch')
  const problems = realFlipDeps(system, root, lib).verifyLib(lib)
  if (problems.length) throw new Error(problems.join('; '))
  const config = configAt(root)
  const url = `http://127.0.0.1:${config.router.port}/health`
  const result = system.exec(
    commands.curl ?? '/usr/bin/curl',
    ['--silent', '--show-error', '--fail', '--max-time', '2', '--noproxy', '*', url],
    { timeoutMs: 3000 },
  )
  if (result.status !== 0 || result.stderr.trim() || Buffer.byteLength(result.stdout) > 128_000)
    throw new Error('current M1 router health unavailable')
  const health: unknown = JSON.parse(result.stdout)
  if (
    !object(health) ||
    health.ok !== true ||
    health.version !== basename(lib) ||
    !Number.isSafeInteger(health.pid) ||
    Number(health.pid) < 1 ||
    !object(health.faults) ||
    health.faults.hookErrors !== 0 ||
    health.faults.unhandledRejections !== 0 ||
    health.mode !== config.modes.codexClaude
  )
    throw new Error('current M1 router health/version/pid/fault mismatch')
  const process = system.processes().find((candidate) => candidate.pid === health.pid)
  if (!process?.command.includes(`${lib}/dist/src/adapter.mjs router`))
    throw new Error('M1 router health has no matching installed process')
  return config.modes.codexClaude
}

export function admitM2Baseline(
  system: System,
  root: string,
  plan: OnPlan,
  lib: string,
): CodexClaudeMode {
  admitEvidence(system, root)
  const mode = verifyM1(system, root, lib, plan.recoveryCommands)
  regularBytes(enginePaths(root).layers, 2_000_000)
  return mode
}

export function m3ClaudeTarget(home: string, target: string): boolean {
  return (
    target === join(home, '.claude/settings.json') ||
    (dirname(target) === join(home, '.claude/agents') &&
      /^gpt-[a-zA-Z0-9._-]+\.md$/.test(basename(target)))
  )
}
