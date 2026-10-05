// Shared configuration and files-only/after-quit restoration; on is one façade.
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { enginePaths, writeJsonAtomic } from './anyengine-config.mjs'
import {
  insertTopLevelLine,
  nonGptModelLines,
  topLevelKeys,
  withoutLines,
} from './codex-config-toml.mjs'
import { cleanModelsCache } from './control-cache.mjs'
import { restoreClaudeLayer } from './control-claude-layer.mjs'
import {
  configAt,
  defaults,
  type InstallPaths,
  type OnPlan,
  persistRecord,
  pickAt,
  readText,
} from './control-install-on.mjs'
import { unloadJob } from './control-launchd.mjs'
import {
  atomicFile,
  beforeState,
  jsonAt,
  regularBytes,
  sameState,
  statAt,
  stateAt,
  syncDirectory,
} from './control-layer-state.mjs'
import {
  type Layer,
  type LayerFile,
  type LayerName,
  POPPED,
  type RestoreOutcome,
  readLayers,
  restoreChange,
  type SharedConfigRecord,
  writeLayers,
} from './control-layers.mjs'
import { isRcChange } from './control-scripts.mjs'
import type { System } from './control-system.mjs'

export {
  applyOnFiles,
  type InstallPaths,
  type OnPlan,
  type OnResult,
  persistRecord,
} from './control-install-on.mjs'
export interface OffResult {
  popped: LayerName[]
  kept: LayerName[]
  results: Array<{ target: string; outcome: RestoreOutcome; detail: string }>
  ok: boolean
}
export type SharedConfigOutcome = 'restored' | 'kept-newer' | 'nothing'
export interface FinishResult {
  bootedOut: string[]
  sharedConfig: Array<{ key: string; outcome: SharedConfigOutcome; detail: string }>
  cacheRemoved: boolean
}
function down(system: System): void {
  if (system.appRunning())
    throw new Error('configured app must exit before shared config or cache mutation')
}
export function applySharedConfig(
  system: System,
  root: string,
  plan: OnPlan,
  options: { dryRun: boolean; paths?: InstallPaths },
): { wrote: string[]; removed: string[] } {
  const paths = options.paths ?? defaults()
  const publish = persistRecord(root, system, plan, paths, [])
  const file = readLayers(root)
  if (file.layers.length) regularBytes(join(root, 'recovery/anyengine-off'))
  configAt(root)
  const pick = pickAt(paths.pickFile)
  const target = join(paths.codexHome, 'config.toml')
  const text = readText(target)
  const lines = nonGptModelLines(text).filter((line) => line.table === null)
  const edited = withoutLines(text, lines)
  if (!lines.length) return { wrote: [], removed: [] }
  const result = { wrote: [paths.pickFile, target], removed: lines.map((line) => line.text) }
  if (options.dryRun) return result
  down(system)
  const layer = file.layers.find((layer) => layer.name === 'router')
  if (!layer || layer.pending) throw new Error('shared config needs an active router layer')
  // Keep the initial shared baseline; later app picks are semantic preferences.
  if (layer.sharedConfig)
    throw new Error('shared config already recorded; recover before another removal')
  atomicFile(
    join(layer.rollbackDir, 'config.toml.bak'),
    Buffer.from(text),
    statAt(target)?.mode ? (statAt(target)?.mode ?? 0) & 0o7777 : 0o600,
  )
  layer.sharedConfig = {
    target,
    pickFile: paths.pickFile,
    backup: 'config.toml.bak',
    removed: lines.map(({ key, value, index, text }) => ({ key, value, index, text })),
  }
  writeLayers(root, file)
  publish(layer, 'intent')
  for (const { key, value } of lines) if (!Object.hasOwn(pick, key)) pick[key] = value
  writeJsonAtomic(paths.pickFile, pick)
  down(system)
  atomicFile(target, Buffer.from(edited), (statAt(target)?.mode ?? 0o600) & 0o7777)
  return result
}
function restoreClaudeDependency(root: string, file: LayerFile): OffResult {
  const result: OffResult = { popped: [], kept: [], results: [], ok: true }
  if (!file.layers.some((layer) => layer.name === 'claude-code')) return result
  const claude = restoreClaudeLayer(root)
  if (claude.ok) {
    result.popped.push('claude-code')
    return result
  }
  return {
    popped: [],
    kept: file.layers.map((layer) => layer.name),
    ok: false,
    results: claude.conflicts.map((target) => ({
      target,
      outcome: 'left-changed',
      detail: 'Claude dependency changed; router retained',
    })),
  }
}
function admitOffDependencies(root: string, file: LayerFile, paths: InstallPaths): void {
  if (file.layers.length) regularBytes(join(root, 'recovery/anyengine-off'))
  configAt(root)
  pickAt(paths.pickFile)
  withoutLines(readText(join(paths.codexHome, 'config.toml')), [])
  for (const layer of file.layers)
    if (layer.sharedConfig) {
      pickAt(layer.sharedConfig.pickFile)
      withoutLines(readText(layer.sharedConfig.target), [])
    }
}
export function applyOffFiles(
  _system: System,
  root: string,
  options: { routerOnly: boolean; paths?: InstallPaths; deferRetirement?: boolean },
): OffResult {
  let file = readLayers(root)
  // Admit every dependent record before the first mutation.
  const paths = options.paths ?? defaults()
  admitOffDependencies(root, file, paths)
  const result = restoreClaudeDependency(root, file)
  if (!result.ok) return result
  file = readLayers(root)
  const retained = options.deferRetirement
    ? (jsonAt(enginePaths(root).layers) as LayerFile | undefined)
    : undefined
  const selected = [...file.layers].reverse()
  for (const layer of selected) {
    if (options.routerOnly && layer.name !== 'router') {
      if (!result.popped.length) result.kept.push(layer.name)
      break
    }
    if (layer.pending) {
      result.popped.push(layer.name)
      continue
    }
    const rc = layer.changes.find(isRcChange)
    const changes = [
      ...(rc ? [rc] : []),
      ...[...layer.changes].reverse().filter((change) => change !== rc),
    ]
    let failed = false
    for (const change of changes) {
      const restored = restoreChange(change, layer.rollbackDir, true)
      result.results.push({ target: change.target, ...restored })
      if (restored.outcome === 'left-changed') {
        failed = true
        if (change === rc) break
      }
    }
    if (failed) {
      result.ok = false
      result.kept.push(layer.name)
      break
    }
    layer.pending = 'after-quit'
    publishOff(root, file, retained)
    result.popped.push(layer.name)
    if (options.routerOnly) break
  }
  return result
}
function publishOff(root: string, file: LayerFile, retained: LayerFile | undefined): void {
  const layers = retained?.layers.map(
    (row) => file.layers.find((active) => active.name === row.name) ?? row,
  )
  writeLayers(root, layers ? { ...file, layers } : file)
}
export function restoreSharedConfig(
  record: SharedConfigRecord,
  system: System,
): FinishResult['sharedConfig'] {
  down(system)
  const pick = pickAt(record.pickFile)
  const original = withoutLines(readText(record.target), [])
  let text = original
  const results: FinishResult['sharedConfig'] = []
  for (const line of record.removed) {
    if (topLevelKeys(text).includes(line.key))
      results.push({
        key: line.key,
        outcome: 'kept-newer',
        detail: `current top-level ${line.key} retained`,
      })
    else {
      const value = typeof pick[line.key] === 'string' ? (pick[line.key] as string) : line.value
      const placeholder = `${line.key} = "${randomUUID()}"`
      const inserted = insertTopLevelLine(text, line.index, placeholder)
      const insertion = value === line.value ? line.text : `${line.key} = ${JSON.stringify(value)}`
      text = withoutLines(inserted.replace(placeholder, insertion), [])
      results.push({
        key: line.key,
        outcome: 'restored',
        detail: 'restored current app preference',
      })
    }
  }
  withoutLines(text, []) // Full supported TOML validation precedes mutation.
  down(system)
  if (text !== original) {
    mkdirSync(dirname(record.target), { recursive: true })
    atomicFile(record.target, Buffer.from(text), (statAt(record.target)?.mode ?? 0o600) & 0o7777)
  }
  // Retain unknown pick preferences; only migrated keys belong to this operation.
  down(system)
  for (const line of record.removed) delete pick[line.key]
  if (Object.keys(pick).length) writeJsonAtomic(record.pickFile, pick)
  else if (statAt(record.pickFile)) {
    rmSync(record.pickFile)
    syncDirectory(dirname(record.pickFile))
  }
  return results
}
function terminalPublic(root: string, layers: Layer[]): void {
  const target = join(root, 'bin/anyengine-off')
  const initial = layers
    .flatMap((layer) => layer.changes)
    .find((change) => change.target === target)
  if (!initial && stateAt(target).kind === 'absent') return
  if (!initial || !sameState(stateAt(target), beforeState(initial)))
    throw new Error('public recovery changed; original baseline and journal retained')
}
function verifyPending(layer: Layer, layers: Layer[]): void {
  for (const change of layer.changes) {
    const owner = layers.find(
      (row) => row.pending && row.changes.some((item) => item.target === change.target),
    )
    if (owner !== layer) continue // The oldest selected baseline wins overlapping targets.
    const result = restoreChange(change, layer.rollbackDir, true)
    if (result.outcome === 'left-changed')
      throw new Error(`pending target changed; recovery retained: ${change.target}`)
  }
}
export function finishOff(
  system: System,
  root: string,
  paths: InstallPaths = defaults(),
  options: { deferRetirement?: boolean } = {},
): FinishResult {
  const file = readLayers(root)
  const result: FinishResult = { bootedOut: [], sharedConfig: [], cacheRemoved: false }
  const raw = jsonAt(enginePaths(root).layers) as LayerFile | undefined
  if (!raw) return result
  regularBytes(join(root, 'recovery/anyengine-off'))
  configAt(root)
  pickAt(paths.pickFile)
  for (const layer of file.layers)
    if (layer.sharedConfig) {
      pickAt(layer.sharedConfig.pickFile)
      withoutLines(readText(layer.sharedConfig.target), [])
    }
  down(system)
  if (!file.layers.length) {
    terminalPublic(root, raw.layers)
    if (!options.deferRetirement) writeLayers(root, { version: 1, layers: [] })
    return result
  }
  for (const layer of [...file.layers].reverse()) {
    if (!layer.pending) continue
    verifyPending(layer, file.layers)
    for (const label of layer.jobs) {
      unloadJob(system, label)
      result.bootedOut.push(label)
    }
    if (layer.sharedConfig)
      result.sharedConfig.push(...restoreSharedConfig(layer.sharedConfig, system))
    if (layer.cleansCache) {
      down(system)
      const cleaned = cleanModelsCache(
        paths.codexHome,
        new Set(configAt(root).claude.models.map((model) => model.id)),
        join(layer.rollbackDir, `cache-${randomUUID()}`),
      )
      if (cleaned.report.parseError)
        throw new Error(`invalid models cache; recovery retained: ${cleaned.report.parseError}`)
      result.cacheRemoved ||= cleaned.removed
    }
    if (options.deferRetirement) {
      // Retain the original strict journal and every pin through reopen and
      // postflight. POPPED is published only after verified after-quit work;
      // there is never a journal-deletion/republication crash window.
      if (file.layers.length === 1) terminalPublic(root, raw.layers)
      atomicFile(join(layer.rollbackDir, POPPED), Buffer.alloc(0), 0o600)
      file.layers = file.layers.filter((row) => row.name !== layer.name)
      continue
    }
    file.layers = file.layers.filter((row) => row.name !== layer.name)
    if (!file.layers.length) {
      terminalPublic(root, raw.layers)
      delete file.recovery
    }
    writeLayers(root, file)
  }
  return result
}

// Metadata-only retirement after the caller verifies terminal postflight.
// Strict readLayers validates physical POPPED markers and retained backups;
// dependencies may now be in use, so never replay after-quit work here.
export function retireOff(root: string): void {
  const file = readLayers(root)
  const raw = jsonAt(enginePaths(root).layers) as LayerFile | undefined
  if (!raw || raw.layers.length === file.layers.length) return
  if (!file.layers.length) {
    terminalPublic(root, raw.layers)
    delete file.recovery
  }
  writeLayers(root, file)
}
