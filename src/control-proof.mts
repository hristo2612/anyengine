// Exercise the real file installers and both recovery implementations on fresh,
// independent homes. Runtime/auth data is never an input to this proof.
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enginePaths } from './anyengine-config.mjs'
import { insertTopLevelLine, topLevelKeys } from './codex-config-toml.mjs'
import { inspectModelsCache } from './control-cache.mjs'
import {
  applyOffFiles,
  applyOnFiles,
  applySharedConfig,
  finishOff,
  type InstallPaths,
  type OnPlan,
} from './control-install.mjs'
import { configAt, pickAt, readText } from './control-install-on.mjs'
import { jobLoaded, loadJob, plistPath, unloadJob } from './control-launchd.mjs'
import {
  beforeState,
  digest,
  type FileState,
  jsonAt,
  type Layer,
  type LayerFile,
  sameState,
  settledState,
  statAt,
  stateAt,
} from './control-layer-state.mjs'
import { LayerWriter, readLayers, recoveryPaths, restoreChange } from './control-layers.mjs'
import {
  createScratch,
  type Saved,
  type Scratch,
  type SourceSnapshot,
  safeParents,
  saved,
  sourceSnapshot,
} from './control-proof-snapshot.mjs'
import type { System } from './control-system.mjs'

export interface ProofResult {
  ok: boolean
  lines: string[]
}
const ABSENT: FileState = { kind: 'absent', sha: null, bytes: null, link: null, mode: null }
const routes = [
  'bash anyengine-off',
  'node off',
  'bash anyengine-off --router-only',
  'bash anyengine-off --last-good',
  'node off --last-good',
] as const
const opaque = (path: string) => /\.(sqlite3?|db)(-(wal|shm|journal))?$/i.test(path)
type Tree = Map<string, string>
const routerLayer = (layer: Layer) => layer.name === 'router' || layer.name === 'claude-code'
function inventory(home: string): Tree {
  const tree: Tree = new Map()
  const pending = [home]
  while (pending.length) {
    const path = pending.pop()
    if (!path) break
    const stat = lstatSync(path)
    if (tree.size > 20_000) throw new Error('scratch inventory exceeds 20000 entries')
    if (stat.isDirectory()) {
      tree.set(path, `directory ${stat.mode & 0o7777}`)
      for (const name of readdirSync(path)) pending.push(join(path, name))
      continue
    }
    if (opaque(path)) tree.set(path, `opaque ${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}`)
    else tree.set(path, JSON.stringify(stateAt(path)))
  }
  return tree
}
function stateDiff(
  path: string,
  expected: FileState,
  actual: FileState,
  home: string,
): string | null {
  return sameState(expected, actual)
    ? null
    : `${relative(home, path)}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`
}
function baseline(s: Scratch, routerOnly: boolean): Map<string, Saved> {
  const expected = new Map(s.targets)
  if (routerOnly)
    for (const layer of readLayers(s.root).layers)
      if (layer.name === 'adapter')
        for (const change of layer.changes)
          expected.set(change.target, { state: settledState(change) })
  // The oldest selected initial state wins a target shared by both layers.
  for (const layer of [...readLayers(s.root).layers].reverse()) {
    if (routerOnly && !routerLayer(layer)) continue
    for (const change of layer.changes) expected.set(change.target, { state: beforeState(change) })
  }
  return expected
}
function sharedBaseline(s: Scratch, expected: Map<string, Saved>): void {
  for (const layer of readLayers(s.root).layers) {
    const record = layer.sharedConfig
    if (!record) continue
    let text = readText(record.target)
    const pick = pickAt(record.pickFile)
    for (const line of record.removed) {
      if (!topLevelKeys(text).includes(line.key)) {
        const value = typeof pick[line.key] === 'string' ? pick[line.key] : line.value
        text = insertTopLevelLine(
          text,
          line.index,
          value === line.value ? line.text : `${line.key} = ${JSON.stringify(value)}`,
        )
      }
      delete pick[line.key]
    }
    const before = stateAt(record.target)
    expected.set(record.target, { state: { ...before, sha: digest(Buffer.from(text)) } })
    const bytes = Buffer.from(`${JSON.stringify(pick, null, 2)}\n`)
    expected.set(record.pickFile, {
      state: Object.keys(pick).length
        ? { ...stateAt(record.pickFile), sha: digest(bytes) }
        : ABSENT,
    })
  }
}
function install(s: Scratch, plan = s.plan): void {
  const result = applyOnFiles(s.system, s.root, plan, { dryRun: false, paths: s.paths })
  if (result.refused) throw new Error(result.refused)
  for (const path of [...result.wrote, ...result.unchanged])
    if (!s.targets.has(path)) s.targets.set(path, { state: ABSENT })
  const shared = applySharedConfig(s.system, s.root, plan, { dryRun: false, paths: s.paths })
  for (const path of shared.wrote) if (!s.targets.has(path)) s.targets.set(path, { state: ABSENT })
}
function upgrade(s: Scratch): Map<string, Saved> {
  const before = new Map([...s.targets.keys()].map((path) => [path, saved(path)]))
  const plan = {
    ...s.plan,
    version: `${s.plan.version}-proof-upgrade`,
    libDir: `${s.plan.libDir}-proof-upgrade`,
    stamp: `${s.plan.stamp}-upgrade`,
  }
  mkdirSync(plan.libDir, { recursive: true })
  const result = applyOnFiles(s.system, s.root, plan, { dryRun: false, paths: s.paths })
  if (result.refused) throw new Error(result.refused)
  for (const path of [...result.wrote, ...result.unchanged])
    if (!before.has(path)) before.set(path, { state: ABSENT })
  return before
}
function recoverLastGood(s: Scratch): void {
  const layer = readLayers(s.root).layers.find((layer) => layer.name === 'router')
  if (!layer?.upgrade) throw new Error('missing last-good checkpoint')
  for (const change of [...layer.changes].reverse()) {
    const result = restoreChange(change, layer.rollbackDir, true, 'last-good')
    if (result.outcome === 'left-changed') throw new Error(`${change.target}: ${result.detail}`)
  }
  for (const label of layer.jobs) {
    const change = layer.changes.find((change) => change.target === plistPath(s.home, label))
    if (!change?.lastGood) throw new Error(`missing last-good job/plist state: ${label}`)
    if (change.lastGood.kind === 'absent') unloadJob(s.system, label)
    else loadJob(s.system, label, change.target)
  }
  // This file-only simulation has made no shared-config/cache/app changes during
  // the upgrade. Verify their frozen bytes before retiring the checkpoint below.
}
class UnsafeCleanup extends Error {}
function ownedDirectory(path: string, expected: { dev: number; ino: number }): void {
  const actual = lstatSync(path)
  if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino)
    throw new UnsafeCleanup('scratch directory identity changed; retain evidence')
}
function reapFamily(pid: number): void {
  if (!(pid > 0)) return
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(-pid, attempt === 0 ? 'SIGKILL' : 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw new UnsafeCleanup(String(error))
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  throw new UnsafeCleanup(`scratch family ${pid} not reaped; retain its home`)
}
function bash(s: Scratch, args: string[]): string {
  const entry = recoveryPaths(s.root).entry
  const identity = lstatSync(s.home)
  const runner = fileURLToPath(new URL('../../scripts/lib/codex-probe-runner.mjs', import.meta.url))
  const options = {
    encoding: 'utf8' as const,
    cwd: s.home,
    timeout: 59_000,
    killSignal: 'SIGKILL' as const,
    detached: true,
    env: {
      HOME: s.home,
      CODEX_HOME: s.paths.codexHome,
      PATH: '/usr/bin:/bin',
      TMPDIR: s.home,
      PROBE_HOME: s.home,
      PROBE_IDENTITY: `${identity.dev}:${identity.ino}`,
      PROBE_DEADLINE: String(Date.now() + 60_000),
      PROBE_POLICY: `(version 1)(allow default)(deny network*)(deny file-write*)
        (allow file-write* (subpath ${JSON.stringify(s.home)}))(allow file-write* (literal "/dev/null"))`,
    },
    maxBuffer: 2_000_000,
  }
  const result = spawnSync(
    process.execPath,
    [runner, '/bin/bash', entry, ...args, '--no-restart'],
    options,
  )
  reapFamily(result.pid)
  const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0)
    throw new Error(
      `Bash status ${result.status ?? 'unknown'} ${String(result.error ?? '')}: ${detail}`,
    )
  return detail
}
function restoredJobs(s: Scratch, prior: Layer[], lastGood: boolean, routerOnly: boolean): void {
  for (const layer of prior) {
    if (routerOnly && !routerLayer(layer)) continue
    for (const label of layer.jobs) {
      const change = layer.changes.find((c) => c.target === plistPath(s.home, label))
      const expected = lastGood ? change?.lastGood : null
      if (lastGood && !expected) throw new Error(`unknown last-good plist activity: ${label}`)
      if (jobLoaded(s.system, label) !== Boolean(expected && expected.kind !== 'absent'))
        throw new Error(`job activity differs: ${label}`)
    }
  }
}
interface CacheExpected {
  path: string
  state: FileState
  directory: string | null
  bash: boolean
}
function cacheExpected(s: Scratch, prior: Layer[], route: string): CacheExpected {
  const report = inspectModelsCache(
    s.paths.codexHome,
    new Set(configAt(s.root).claude.models.map((model) => model.id)),
  )
  if (report.parseError) throw new Error(report.parseError)
  const layer = [...prior]
    .reverse()
    .find((layer) => layer.cleansCache && (!route.includes('--') || layer.name === 'router'))
  return {
    path: report.path,
    state: stateAt(report.path),
    bash: route.startsWith('bash'),
    directory:
      report.anyengine.length && layer && route !== 'node off --last-good'
        ? layer.rollbackDir
        : null,
  }
}
function cacheBackup(cache: CacheExpected, before: Tree, after: Tree, home: string) {
  const allowed = new Set<string>()
  const differences: string[] = []
  if (!cache.directory) return { allowed, differences }
  const directory = cache.directory
  const candidates = [...after.keys()].filter(
    (path) =>
      !before.has(path) && path.startsWith(`${directory}/`) && path.endsWith('/models_cache.json'),
  )
  if (candidates.length !== 1)
    differences.push('models_cache.json: expected exactly one fresh private cache backup')
  for (const path of candidates) {
    const parent = dirname(path)
    const named = cache.bash
      ? path === join(directory, 'models_cache.json')
      : /^cache-[a-f0-9-]{36}$/.test(relative(directory, parent)) && !before.has(parent)
    const diff = stateDiff(path, { ...cache.state, mode: 0o600 }, stateAt(path), home)
    if (!named || (lstatSync(parent).mode & 0o7777) !== 0o700 || diff)
      differences.push(
        diff ?? `${relative(home, path)}: wrong cache backup destination/parent mode`,
      )
    allowed.add(path)
    if (!cache.bash) allowed.add(parent)
  }
  return { allowed, differences }
}
function retained(
  s: Scratch,
  before: Tree,
  expected: Map<string, Saved>,
  prior: Layer[],
  lastGood: boolean,
  routerOnly: boolean,
  cache: CacheExpected,
): string[] {
  const after = inventory(s.home)
  const { allowed, differences } = cacheBackup(cache, before, after, s.home)
  const journal = enginePaths(s.root).layers
  const markers = new Set(
    prior
      .filter((l) => !lastGood && (!routerOnly || routerLayer(l)))
      .map((l) => join(l.rollbackDir, 'POPPED')),
  )
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (
      expected.has(path) ||
      allowed.has(path) ||
      path === journal ||
      path.startsWith(join(s.home, '.proof-tools/jobs/')) ||
      path === join(s.home, '.proof-tools/calls')
    )
      continue
    if (markers.has(path)) {
      const stat = statAt(path)
      if (stat && (!stat.isFile() || stat.size !== 0))
        differences.push(`${relative(s.home, path)}: invalid physical POPPED marker`)
      continue
    }
    if (before.get(path) !== after.get(path))
      differences.push(
        `${relative(s.home, path)}: retained artifact differs (${before.get(path) ?? 'absent'} != ${after.get(path) ?? 'absent'})`,
      )
  }
  readLayers(s.root) // Validates raw physical markers/backups even when logically popped.
  const raw = jsonAt(journal) as LayerFile | undefined
  if (lastGood) {
    const current = readLayers(s.root).layers.find((l) => l.name === 'router')
    if (!current) differences.push('layers.json: lost last-good router authority')
  } else {
    const active = readLayers(s.root).layers.map((l) => l.name)
    const wanted = routerOnly ? prior.filter((l) => !routerLayer(l)).map((l) => l.name) : []
    if (JSON.stringify(active) !== JSON.stringify(wanted))
      differences.push(`layers.json: expected ${wanted}, observed ${active}`)
    if (!routerOnly && raw)
      differences.push('layers.json: full terminal recovery did not retire journal')
  }
  return differences
}
function completeLastGood(s: Scratch, before: Layer[]): void {
  const current = readLayers(s.root).layers.find((l) => l.name === 'router')
  const original = before.find((l) => l.name === 'router')
  if (!current || !original?.upgrade) throw new Error('last-good router missing')
  if (current.upgrade)
    new LayerWriter(s.root, current, 'router', s.plan.stamp).finishUpgrade('recovered')
  const final = readLayers(s.root).layers.find((l) => l.name === 'router')
  if (!final || final.upgrade || final.changes.some((c) => c.pending || c.lastGood))
    throw new Error('last-good checkpoint was not verified and retired')
  for (const old of original.changes) {
    const change = final.changes.find((c) => c.target === old.target)
    if (!change || !sameState(beforeState(change), beforeState(old)))
      throw new Error(`initial baseline lost: ${old.target}`)
  }
}
function recover(s: Scratch, route: string, lastGood: boolean, routerOnly: boolean): string {
  let action = ''
  try {
    if (route.startsWith('bash'))
      action = bash(s, lastGood ? ['--last-good'] : routerOnly ? ['--router-only'] : [])
    else if (lastGood) recoverLastGood(s)
    else {
      const off = applyOffFiles(s.system, s.root, { routerOnly: false, paths: s.paths })
      if (!off.ok)
        throw new Error(
          off.results
            .filter((r) => r.outcome === 'left-changed')
            .map((r) => `${r.target}: ${r.detail}`)
            .join('; '),
        )
      finishOff(s.system, s.root, s.paths)
    }
  } catch (error) {
    if (error instanceof UnsafeCleanup) throw error
    action = `FAILED: ${String(error)}`
  }
  return action
}
function onePass(
  source: SourceSnapshot,
  home: string,
  route: (typeof routes)[number],
  afterOn?: (scratchHome: string) => void,
): string[] {
  const s = createScratch(source, home)
  const identity = lstatSync(home)
  const lastGood = route.includes('--last-good')
  const routerOnly = route.includes('--router-only')
  const initialShared = new Map(
    [
      join(s.paths.codexHome, 'config.toml'),
      s.paths.pickFile,
      join(s.paths.codexHome, 'models_cache.json'),
    ].map((path) => [path, saved(path)]),
  )
  install(s)
  let expected = baseline(s, routerOnly)
  for (const [path, value] of initialShared) expected.set(path, value)
  if (lastGood) {
    const layer = readLayers(s.root).layers.find((l) => l.name === 'router')
    // An existing M1 installation already acquired its immediate checkpoint in on.
    if (layer?.upgrade) {
      expected = new Map(s.targets)
      for (const change of layer.changes) {
        if (!change.lastGood) throw new Error('missing last-good state')
        expected.set(change.target, { state: change.lastGood })
      }
      for (const [path, value] of initialShared) expected.set(path, value)
    } else expected = upgrade(s)
  }
  if (!lastGood) sharedBaseline(s, expected)
  const prior = structuredClone(readLayers(s.root).layers)
  const cache = cacheExpected(s, prior, route)
  if (cache.directory) expected.set(cache.path, { state: ABSENT })
  const before = inventory(s.home)
  afterOn?.(s.home)
  ownedDirectory(home, identity)
  for (const path of [...expected.keys(), recoveryPaths(s.root).entry]) safeParents(path)
  const action = recover(s, route, lastGood, routerOnly)
  ownedDirectory(home, identity)
  const differences = [...expected].flatMap(([path, value]) => {
    try {
      safeParents(path)
      const diff = stateDiff(path, value.state, stateAt(path), s.home)
      return diff ? [diff] : []
    } catch (error) {
      return [`${relative(s.home, path)}: ${String(error)}`]
    }
  })
  differences.push(...retained(s, before, expected, prior, lastGood, routerOnly, cache))
  if (action.startsWith('FAILED')) differences.unshift(action)
  if (!differences.length) {
    restoredJobs(s, prior, lastGood, routerOnly)
    if (lastGood) completeLastGood(s, prior)
    return [
      `proof ${route}: ok (${expected.size} mutable targets; retained preferences, private entry, RECOVER.txt, backups and validated journal; jobs verified; owned Bash family reaped)`,
    ]
  }
  const raw = jsonAt(enginePaths(s.root).layers)
  return [
    `proof ${route}: FAILED`,
    ...differences,
    `proof retained failure authority: ${raw ? JSON.stringify(raw) : 'terminal journal absent'}`,
  ]
}
export function proveRollback(
  system: System,
  root: string,
  plan: OnPlan,
  options: { paths: InstallPaths; scratchParent: string; afterOn?: (scratchHome: string) => void },
): ProofResult {
  const lines: string[] = []
  let directory: string | null = null
  let source: SourceSnapshot | null = null
  try {
    source = sourceSnapshot(system, root, plan, options.paths)
    const parent = resolve(options.scratchParent)
    if (
      parent !== options.scratchParent ||
      parent === system.home ||
      parent.startsWith(`${system.home}/`) ||
      parent === root ||
      parent.startsWith(`${root}/`)
    )
      throw new Error('scratch parent must be absolute and outside the observed home/root')
    safeParents(join(parent, 'proof'))
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    directory = mkdtempSync(join(parent, 'rollback-proof-'))
    const identity = lstatSync(directory)
    lines.push(
      `proof: ${source.targets.size} mutable targets copied independently to ${directory}; config.toml included`,
    )
    for (const [index, route] of routes.entries()) {
      try {
        lines.push(...onePass(source, join(directory, String(index)), route, options.afterOn))
      } catch (error) {
        if (error instanceof UnsafeCleanup) throw error
        lines.push(`proof ${route}: FAILED: ${String(error)}`)
      }
    }
    ownedDirectory(directory, identity)
    rmSync(directory, { recursive: true })
    directory = null
    lines.push('proof: scratch removed')
  } catch (error) {
    lines.push(`proof: FAILED: ${String(error)}`)
  }
  if (directory) lines.push(`proof: scratch retained at ${directory}`)
  if (source)
    for (const [path, value] of source.files) {
      try {
        safeParents(path)
        // Vendor cache refresh is concurrent; installation rereads it after app exit.
        if (path === join(source.paths.codexHome, 'models_cache.json')) continue
        const diff = stateDiff(path, value.state, stateAt(path), source.home)
        if (diff) lines.push(`proof: FAILED source changed: ${diff}`)
      } catch (error) {
        lines.push(`proof: FAILED source observation: ${path}: ${String(error)}`)
      }
    }
  return { ok: !lines.some((line) => line.includes('FAILED')), lines }
}
