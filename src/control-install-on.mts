// Admission and application for initial installs and immediate last-good upgrades.
import { accessSync, constants, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AnyEngineConfig,
  DEFAULT_CONFIG,
  enginePaths,
  readConfig,
  setConfigValue,
  writeJsonAtomic,
} from './anyengine-config.mjs'
import { withoutLines } from './codex-config-toml.mjs'
import { appModelPickPath } from './config-writes.mjs'
import {
  jobLoaded,
  loadJob,
  plistPath,
  ROUTER_LABEL,
  reloadJob,
  routerPlist,
  SMOKE_LABEL,
  smokePlist,
  unloadJob,
} from './control-launchd.mjs'
import {
  digest,
  jsonAt,
  object,
  regularBytes,
  sameState,
  settledState,
  statAt,
  stateAt,
} from './control-layer-state.mjs'
import {
  adoptM0,
  type Layer,
  type LayerName,
  LayerWriter,
  type OnRecord,
  readLayers,
  writeLayers,
} from './control-layers.mjs'
import { inspectM0 } from './control-m0-adoption.mjs'
import { activeUpgrade, recordM2ControlChanges } from './control-m2-upgrade.mjs'
import { rcPath, withCliPath, withRcBlock } from './control-rc.mjs'
import {
  offScript,
  publicRecoveryScript,
  publishRecovery,
  type RecoveryOptions,
  shellQuote,
} from './control-scripts.mjs'
import type { System } from './control-system.mjs'
import { codexHome } from './util.mjs'
export interface OnPlan {
  version: string
  libDir: string
  node: string
  claudeCli: string | null
  shimSource: string
  launcherSource: string
  stamp: string
  app: string
  bundleId: string
  recoveryCommands?: RecoveryOptions['commands']
  claudeCode?: boolean
}
export interface InstallPaths {
  codexHome: string
  pickFile: string
}
export interface OnResult {
  adopted: boolean
  adoptedFrom: string | null
  refused: string | null
  wrote: string[]
  unchanged: string[]
  layers: LayerName[]
}
export const defaults = (): InstallPaths => ({
  codexHome: codexHome(),
  pickFile: appModelPickPath(),
})
export const readText = (path: string) =>
  statAt(path)
    ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(regularBytes(path))
    : ''
export function pickAt(path: string): Record<string, unknown> {
  const value = jsonAt(path)
  if (value === undefined) return {}
  if (
    !object(value) ||
    ['model', 'review_model'].some(
      (key) => value[key] !== undefined && typeof value[key] !== 'string',
    )
  )
    throw new Error('invalid app model pick evidence')
  return value
}
export function configAt(root: string) {
  const result = readConfig(root)
  const errors = result.errors.filter(
    (error) => !error.includes('unknown setting, which does nothing'),
  )
  if (errors.length) throw new Error(`invalid config.json: ${errors.join('; ')}`)
  return result.config
}
function assertOwned(layers: Layer[]): void {
  const latest = new Map<string, { layer: Layer; change: Layer['changes'][number] }>()
  for (const layer of layers.filter((layer) => layer.name !== 'claude-code'))
    for (const change of layer.changes) latest.set(change.target, { layer, change })
  for (const { change } of latest.values())
    if (!sameState(stateAt(change.target), settledState(change)))
      throw new Error('owned install target changed; recover before on')
}
type PlannedFile = [string, string | Buffer, number]
function planFiles(
  system: System,
  root: string,
  plan: OnPlan,
  config: AnyEngineConfig,
  adapter: Layer | undefined,
) {
  const rc = rcPath(system.home, process.env.SHELL)
  const shim = join(system.home, 'bin/codex')
  const shimBytes = regularBytes(plan.shimSource)
  const launcherBytes = regularBytes(plan.launcherSource)
  const rcBefore = rc ? readText(rc) : ''
  const block = withRcBlock(rcBefore)
  if (!adapter)
    block.text = withCliPath(
      block.text,
      root === join(system.home, '.anyengine') ? undefined : join(root, 'bin'),
    )
  block.changed = block.text !== rcBefore
  const runtime = runtimeText(root, plan)
  // adoptM0(null) proves no receipt, not an off baseline. Refuse active unowned bytes.
  const marked = readText(shim).includes('(marker: ANYENGINE_ADAPTER)')
  const input = {
    root,
    launcher: join(root, 'bin/anyengine'),
    node: plan.node,
    pathDirs: [
      ...new Set([dirname(plan.node), ...(plan.claudeCli ? [dirname(plan.claudeCli)] : [])]),
    ],
  }
  const jobs = [
    {
      label: ROUTER_LABEL,
      text: routerPlist({ ...input, log: join(root, 'logs/router.launchd.log') }),
    },
  ]
  if (config.smoke.enabled)
    jobs.push({
      label: SMOKE_LABEL,
      text: smokePlist({
        ...input,
        log: join(root, 'logs/smoke.launchd.log'),
        hour: config.smoke.hour,
        minute: config.smoke.minute,
        watchPaths: [
          join(plan.app, 'Contents/Info.plist'),
          join(system.home, 'Library/Caches', plan.bundleId, 'org.sparkle-project.Sparkle'),
        ],
      }),
    })
  // Queries happen before artifacts; unknown job state cannot authorize a replacement.
  const loaded = new Map(jobs.map(({ label }) => [label, jobLoaded(system, label)]))
  const files: Array<[string, string | Buffer, number]> = [
    ...(rc && !adapter
      ? [
          [rc, block.text, statAt(rc)?.mode ? (statAt(rc)?.mode ?? 0) & 0o7777 : 0o644] as [
            string,
            string,
            number,
          ],
          [join(root, 'runtime.env'), runtime, 0o600] as [string, string, number],
        ]
      : []),
    [join(root, 'bin/anyengine-off'), publicRecoveryScript(root), 0o755],
    [shim, shimBytes, 0o755],
    [input.launcher, launcherBytes, 0o755],
    ...jobs.map(
      ({ label, text }) => [plistPath(system.home, label), text, 0o644] as [string, string, number],
    ),
  ]
  return { adapter, rc, block, marked, files, jobs, loaded }
}
function describeFiles(
  root: string,
  plan: OnPlan,
  files: PlannedFile[],
  result: OnResult,
  removing: string | null,
  rc: string | null,
  adoption: { adoptedFrom: string } | { layer: Layer } | null,
): OnResult {
  result.adoptedFrom = adoption && 'adoptedFrom' in adoption ? adoption.adoptedFrom : null
  const preserved = result.adoptedFrom && rc ? [rc, join(root, 'runtime.env')] : []
  result.unchanged.push(...preserved)
  if (removing) result.wrote.push(removing)
  for (const [target, bytes, mode] of files.filter(([target]) => !preserved.includes(target))) {
    const same = sameState(stateAt(target), {
      kind: 'file',
      sha: digest(Buffer.from(bytes)),
      link: null,
      bytes: null,
      mode,
    })
    ;(same ? result.unchanged : result.wrote).push(target)
  }
  if (stateAt(join(root, 'lib/current')).link !== plan.version)
    result.wrote.push(join(root, 'lib/current'))
  return result
}
function writeFiles(writer: LayerWriter, files: PlannedFile[], result: OnResult): void {
  for (const [target, bytes, mode] of files) {
    const changed = writer.writeFile(target, bytes, mode)
    ;(changed ? result.wrote : result.unchanged).push(target)
  }
}
function smokeRemoval(system: System, router: Layer | undefined, enabled: boolean): string | null {
  if (enabled || !router) return null
  const target = plistPath(system.home, SMOKE_LABEL)
  const change = router.changes.find((row) => row.target === target)
  const owned = router.jobs.includes(SMOKE_LABEL)
  if (owned !== Boolean(change)) throw new Error('unknown smoke job/plist ownership')
  if (!owned || !change) return null
  const loaded = jobLoaded(system, SMOKE_LABEL)
  return loaded || settledState(change).kind !== 'absent' ? target : null
}
function smokeTransition(
  existing: Layer | undefined,
  smokeTarget: string,
  removing: string | null,
  smokeEnabled: boolean,
): boolean {
  if (!existing) return false
  const smoke = existing.changes.find((row) => row.target === smokeTarget)
  const enabling = smokeEnabled && (!smoke || settledState(smoke).kind === 'absent')
  return Boolean(removing || enabling)
}
function checkpoint(
  writer: LayerWriter,
  existing: Layer | undefined,
  changedLib: boolean,
  changedSmoke: boolean,
): void {
  if (existing && (changedLib || (!existing.upgrade && changedSmoke))) writer.beginUpgrade()
}
function disableSmoke(
  system: System,
  writer: LayerWriter,
  target: string | null,
  result: OnResult,
): void {
  if (!target) return
  unloadJob(system, SMOKE_LABEL)
  smokeDown(system)
  if (writer.removeFile(target)) result.wrote.push(target)
}
function smokeDown(system: System): void {
  if (system.appRunning()) throw new Error('configured app must exit before disabling smoke')
}
function ensurePreferences(root: string, plan: OnPlan, config: AnyEngineConfig): void {
  if (!statAt(enginePaths(root).config)) {
    const fresh = structuredClone(DEFAULT_CONFIG)
    fresh.claude.cli = plan.claudeCli
    writeJsonAtomic(enginePaths(root).config, fresh)
  } else if (config.claude.cli === null && plan.claudeCli)
    setConfigValue(root, 'claude.cli', plan.claudeCli)
}
function applyJobs(
  system: System,
  root: string,
  writer: LayerWriter,
  jobs: Array<{ label: string }>,
  loaded: Map<string, boolean>,
  changedLib: boolean,
  result: OnResult,
): void {
  mkdirSync(join(root, 'logs'), { recursive: true, mode: 0o700 })
  for (const { label } of jobs) {
    writer.track(plistPath(system.home, label))
    writer.addJob(label)
    if (result.wrote.includes(plistPath(system.home, label)) || !loaded.get(label))
      loadJob(system, label, plistPath(system.home, label))
    else if (label === ROUTER_LABEL && changedLib) reloadJob(system, label)
  }
}
export function persistRecord(
  root: string,
  _system: System,
  plan: Pick<OnPlan, 'app' | 'bundleId' | 'recoveryCommands'>,
  paths: InstallPaths,
  _before: Layer[],
): OnRecord {
  const recovery = {
    root,
    app: plan.app,
    bundleId: plan.bundleId,
    codexHome: paths.codexHome,
    ...(plan.recoveryCommands ? { commands: plan.recoveryCommands } : {}),
  }
  offScript([], recovery) // Admission only; constructing a publisher writes no artifacts.
  return (layer, phase) => {
    recordM2ControlChanges(root, layer, phase, activeUpgrade(root))
    publishRecovery(recovery)
    recordM2ControlChanges(root, layer, 'checkpoint', activeUpgrade(root))
  }
}
function recordPublic(root: string, writer: LayerWriter, publish: OnRecord): void {
  const target = join(root, 'bin/anyengine-off')
  if (writer.layer.changes.some((change) => change.target === target)) return
  writer.track(target) // Even identical bytes have a real original file/link baseline.
  const file = readLayers(root)
  file.layers = file.layers.filter((layer) => layer.name !== 'adapter')
  file.layers.unshift(writer.layer)
  writeLayers(root, file)
  publish(writer.layer, 'settled')
}
function pinned(root: string, plan: OnPlan): void {
  const file = readLayers(root)
  const controlLib =
    file.recovery?.controlLib ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const pins = new Set(file.recovery?.pinnedLibs ?? [controlLib])
  pins.add(plan.libDir)
  for (const layer of file.layers)
    for (const change of layer.changes) {
      if (change.target !== join(root, 'lib/current')) continue
      for (const link of [
        change.beforeLink,
        change.afterLink,
        change.pending?.link,
        change.lastGood?.link,
      ])
        if (link) pins.add(resolve(root, 'lib', link))
    }
  const current = stateAt(join(root, 'lib/current'))
  if (current.link) pins.add(resolve(root, 'lib', current.link))
  file.recovery = { entry: join(root, 'recovery/anyengine-off'), controlLib, pinnedLibs: [...pins] }
  writeLayers(root, file)
}
function runtimeText(root: string, plan: OnPlan): string {
  const path = join(root, 'runtime.env')
  if (!statAt(path))
    return `export ANYENGINE_RUNTIME_TYPE="anyengine"\nexport ANYENGINE_NODE=${shellQuote(plan.node)}\n`
  const text = readText(path)
  const lines = text.match(/^export ANYENGINE_ADAPTER=.*$/gm) ?? []
  if (lines.length > 1) throw new Error('ambiguous runtime.env adapter exports')
  const wanted = 'export ANYENGINE_ADAPTER="$HOME/.anyengine/lib/current/dist/src/adapter.mjs"'
  return lines.length ? text.replace(/^export ANYENGINE_ADAPTER=.*$/m, wanted) : text
}
function admitOn(
  root: string,
  plan: OnPlan,
  paths: InstallPaths,
  layers: Layer[],
): AnyEngineConfig {
  if (layers.some((layer) => layer.pending || layer.changes.some((change) => change.pending)))
    throw new Error('finish the last off or recovery first: anyengine off')
  if (
    ['.', '..'].includes(plan.version) ||
    !/^[A-Za-z0-9._-]+$/.test(plan.version) ||
    resolve(root, 'lib', plan.version) !== plan.libDir
  )
    throw new Error('invalid versioned library plan')
  const config = configAt(root)
  pickAt(paths.pickFile)
  if (plan.claudeCli) {
    if (!statSync(plan.claudeCli).isFile())
      throw new Error('claude.cli must name an executable file')
    accessSync(plan.claudeCli, constants.X_OK)
  }
  withoutLines(readText(join(paths.codexHome, 'config.toml')), [])
  assertOwned(layers)
  const raw = jsonAt(enginePaths(root).layers)
  if (object(raw) && Array.isArray(raw.layers) && raw.layers.length !== layers.length)
    throw new Error('finish the last off first: retained POPPED recovery')
  return config
}
function initialAdoption(
  root: string,
  home: string,
  stamp: string,
  dryRun: boolean,
  adapter: Layer | undefined,
) {
  if (adapter) return null
  return dryRun ? inspectM0(root, home) : adoptM0(root, home, stamp)
}
export function applyOnFiles(
  system: System,
  root: string,
  plan: OnPlan,
  options: { dryRun: boolean; paths?: InstallPaths },
): OnResult {
  const paths = options.paths ?? defaults()
  const recovery = {
    root,
    app: plan.app,
    bundleId: plan.bundleId,
    codexHome: paths.codexHome,
    ...(plan.recoveryCommands ? { commands: plan.recoveryCommands } : {}),
  }
  offScript([], recovery) // Validate immutable tools before any target or recovery artifact.
  const file = readLayers(root)
  const result: OnResult = {
    adopted: false,
    adoptedFrom: null,
    refused: null,
    wrote: [],
    unchanged: [],
    layers: file.layers.map((layer) => layer.name),
  }
  const config = admitOn(root, plan, paths, file.layers)
  const existing = file.layers.find((layer) => layer.name === 'router')
  const removing = smokeRemoval(system, existing, config.smoke.enabled)
  const changedSmoke = smokeTransition(
    existing,
    plistPath(system.home, SMOKE_LABEL),
    removing,
    config.smoke.enabled,
  )
  const prepared = planFiles(
    system,
    root,
    plan,
    config,
    file.layers.find((layer) => layer.name === 'adapter'),
  )
  const { adapter, rc, block, marked, files, jobs, loaded } = prepared
  if (!rc && !adapter) {
    result.refused = 'unsupported login shell; choose bash or zsh'
    return result
  }
  if (!options.dryRun && changedSmoke) smokeDown(system)
  const adoption = initialAdoption(root, system.home, plan.stamp, options.dryRun, adapter)
  if (adoption && 'refused' in adoption) {
    result.refused = adoption.refused
    return result
  }
  if (!adapter && !adoption && marked && block.state === 'active') {
    result.refused = 'active M0 has no complete recovery receipt baseline'
    return result
  }
  if (options.dryRun) return describeFiles(root, plan, files, result, removing, rc, adoption)
  publishRecovery(recovery)
  if (adoption && 'layer' in adoption) {
    file.layers.push(adoption.layer)
    writeLayers(root, file)
    result.adopted = true
    result.adoptedFrom = adoption.layer.adoptedFrom
  }
  pinned(root, plan)
  const publish = persistRecord(root, system, plan, paths, [])
  publishRecovery(recovery)
  const first = new LayerWriter(
    root,
    adapter ?? (adoption && 'layer' in adoption ? adoption.layer : null),
    'adapter',
    plan.stamp,
    publish,
  )
  if (!adapter && !result.adopted) {
    const targets = [rc, join(root, 'runtime.env'), join(system.home, 'bin/codex')]
    writeFiles(
      first,
      files.filter(([target]) => targets.includes(target)),
      result,
    )
  }
  const publicPath = join(root, 'bin/anyengine-off')
  recordPublic(root, first, publish)
  if (first.writeFile(publicPath, publicRecoveryScript(root), 0o755)) result.wrote.push(publicPath)
  const writer = new LayerWriter(root, existing ?? null, 'router', plan.stamp, publish)
  const changedLib = stateAt(join(root, 'lib/current')).link !== plan.version
  checkpoint(writer, existing, changedLib, changedSmoke)
  disableSmoke(system, writer, removing, result)
  if (writer.writeSymlink(join(root, 'lib/current'), plan.version))
    result.wrote.push(join(root, 'lib/current'))
  writeFiles(
    writer,
    files.filter(
      ([target]) => target !== rc && target !== join(root, 'runtime.env') && target !== publicPath,
    ),
    result,
  )
  ensurePreferences(root, plan, config)
  applyJobs(system, root, writer, jobs, loaded, changedLib, result)
  pinned(root, plan)
  result.layers = readLayers(root).layers.map((layer) => layer.name)
  return result
}
