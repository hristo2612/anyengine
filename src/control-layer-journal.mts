// Strict versioned recovery authority. Read failure blocks writes and pruning;
// all referenced initial, settled, pending and last-good bytes must be intact.
import { rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { enginePaths, writeJsonAtomic } from './anyengine-config.mjs'
import {
  absolute,
  beforeState,
  digest,
  directoryAt,
  type FileChange,
  type FileState,
  jsonAt,
  type Layer,
  type LayerFile,
  object,
  ordinary,
  ownedDirectory,
  POPPED,
  recoveryPaths,
  regularBytes,
  safeTarget,
  settledState,
  statAt,
  syncDirectory,
  text,
} from './control-layer-state.mjs'

const mode = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0o7777
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const timestamp = (value: unknown) => text(value) && Number.isFinite(Date.parse(value))
const leaf = (value: unknown): value is string =>
  text(value) && value !== '.' && value !== '..' && basename(value) === value
function onlyKeys(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).every((key) => names.includes(key))
}
function validState(value: unknown): value is FileState {
  if (!object(value) || !onlyKeys(value, ['kind', 'sha', 'link', 'bytes', 'mode'])) return false
  if (value.kind === 'file')
    return sha(value.sha) && leaf(value.bytes) && mode(value.mode) && value.link === null
  if (value.kind === 'symlink')
    return text(value.link) && value.sha === null && value.bytes === null && value.mode === null
  return (
    value.kind === 'absent' &&
    value.sha === null &&
    value.link === null &&
    value.bytes === null &&
    value.mode === null
  )
}
function verifyState(state: FileState, dir: string): void {
  if (!validState(state)) throw new Error('invalid layer file state')
  if (state.bytes && digest(regularBytes(join(dir, state.bytes))) !== state.sha)
    throw new Error(`layer backup evidence hash mismatch: ${join(dir, state.bytes)}`)
}
export function validateChange(change: FileChange, dir: string, root?: string): void {
  if (
    !object(change) ||
    !onlyKeys(change, [
      'target',
      'before',
      'backup',
      'after',
      'mode',
      'beforeSha',
      'afterSha',
      'beforeLink',
      'afterLink',
      'afterMode',
      'pending',
      'lastGood',
    ])
  )
    throw new Error('invalid or unsupported layer change')
  requireDirectory(dir)
  safeTarget(change.target, root)
  if (!Object.hasOwn(change, 'pending'))
    throw new Error('unsupported layer change without pending state')
  verifyState(beforeState(change), dir)
  verifyState(settledState(change), dir)
  if (change.pending !== null) verifyState(change.pending, dir)
  if (change.lastGood !== undefined) verifyState(change.lastGood, dir)
}
function validShared(value: unknown, dir: string): boolean {
  if (value === undefined || value === null) return true
  if (
    !object(value) ||
    !onlyKeys(value, ['target', 'pickFile', 'backup', 'removed']) ||
    !absolute(value.target) ||
    !absolute(value.pickFile) ||
    !leaf(value.backup) ||
    !Array.isArray(value.removed)
  )
    return false
  ordinary(value.target)
  ordinary(value.pickFile)
  regularBytes(join(dir, value.backup))
  return value.removed.every(
    (row) =>
      object(row) &&
      onlyKeys(row, ['key', 'value', 'index', 'text']) &&
      ['model', 'review_model'].includes(String(row.key)) &&
      typeof row.value === 'string' &&
      typeof row.text === 'string' &&
      Number.isSafeInteger(row.index) &&
      Number(row.index) >= 0,
  )
}
function validateLayer(value: unknown, root: string): asserts value is Layer {
  if (
    !object(value) ||
    !onlyKeys(value, [
      'name',
      'rollbackDir',
      'adoptedFrom',
      'createdAt',
      'changes',
      'jobs',
      'cleansCache',
      'sharedConfig',
      'pending',
      'upgrade',
      'claudeCode',
    ]) ||
    !['adapter', 'router', 'claude-code'].includes(String(value.name)) ||
    !absolute(value.rollbackDir) ||
    !timestamp(value.createdAt) ||
    !Array.isArray(value.changes) ||
    !Array.isArray(value.jobs) ||
    !value.jobs.every(text) ||
    typeof value.cleansCache !== 'boolean'
  )
    throw new Error('invalid layer structure')
  ownedDirectory(root, value.rollbackDir)
  if (
    !(value.adoptedFrom === null || absolute(value.adoptedFrom)) ||
    ![undefined, null, 'after-quit'].includes(value.pending as undefined)
  )
    throw new Error('invalid layer origin or pending phase')
  if (!validShared(value.sharedConfig, value.rollbackDir))
    throw new Error('invalid layer shared config')
  validateClaudeRecord(value)
  const targets = new Set<string>()
  for (const change of value.changes as FileChange[]) {
    validateChange(change, value.rollbackDir, root)
    if (targets.has(change.target)) throw new Error('duplicate layer target')
    targets.add(change.target)
  }
  if (value.upgrade !== undefined) {
    const upgrade = value.upgrade
    if (
      !object(upgrade) ||
      !onlyKeys(upgrade, ['createdAt', 'jobs', 'cleansCache', 'sharedConfig', 'claudeCode']) ||
      !timestamp(upgrade.createdAt) ||
      !Array.isArray(upgrade.jobs) ||
      !upgrade.jobs.every(text) ||
      typeof upgrade.cleansCache !== 'boolean' ||
      !validShared(upgrade.sharedConfig, value.rollbackDir) ||
      value.changes.some((change) => !change.lastGood)
    )
      throw new Error('invalid layer last-good upgrade')
    validateClaudeRecord({ name: value.name, claudeCode: upgrade.claudeCode })
  } else if (value.changes.some((change) => change.lastGood !== undefined))
    throw new Error('last-good state without upgrade')
}

function validateClaudeRecord(layer: Record<string, unknown>): void {
  const value = layer.claudeCode
  if (value === undefined) return
  if (
    layer.name !== 'claude-code' ||
    !object(value) ||
    !onlyKeys(value, ['settingsTarget', 'ownedModels', 'touchedPaths', 'catalog']) ||
    !absolute(value.settingsTarget) ||
    !Array.isArray(value.ownedModels) ||
    value.ownedModels.length > 10 ||
    new Set(value.ownedModels).size !== value.ownedModels.length ||
    !value.ownedModels.every(
      (id) =>
        typeof id === 'string' &&
        id.length <= 128 &&
        /^gpt-[a-z0-9][a-z0-9.-]*$/.exec(id)?.[0] === id,
    ) ||
    !Array.isArray(value.touchedPaths) ||
    value.touchedPaths.length !== 4 ||
    new Set(value.touchedPaths).size !== 4 ||
    !value.touchedPaths.every((path) =>
      [
        'env.ANTHROPIC_BASE_URL',
        'env.ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'env.CLAUDE_CODE_GATEWAY_HINT_HEADERS',
        'modelPicker.options',
      ].includes(String(path)),
    ) ||
    !object(value.catalog) ||
    !onlyKeys(value.catalog, ['generation', 'fetchedAt']) ||
    !Number.isSafeInteger(value.catalog.generation) ||
    Number(value.catalog.generation) < 0 ||
    !Number.isSafeInteger(value.catalog.fetchedAt) ||
    Number(value.catalog.fetchedAt) < 0
  )
    throw new Error('invalid Claude layer semantic record')
  ordinary(value.settingsTarget)
}
export function validateLayers(root: string, value: unknown): asserts value is LayerFile {
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.layers) ||
    Object.keys(value).some((key) => !['version', 'layers', 'recovery'].includes(key))
  )
    throw new Error('invalid or unsupported layers journal')
  const names = new Set<string>()
  for (const layer of value.layers) {
    validateLayer(layer, root)
    if (names.has(layer.name)) throw new Error('duplicate recovery layer')
    names.add(layer.name)
  }
  if (value.recovery !== undefined) {
    const record = value.recovery
    if (
      !object(record) ||
      !onlyKeys(record, ['entry', 'controlLib', 'pinnedLibs']) ||
      record.entry !== recoveryPaths(root).entry ||
      !absolute(record.controlLib) ||
      !Array.isArray(record.pinnedLibs) ||
      !record.pinnedLibs.every(absolute) ||
      !record.pinnedLibs.includes(record.controlLib)
    )
      throw new Error('invalid durable recovery pins')
  }
  if (Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`) > 2_000_000)
    throw new Error('layers journal exceeds recovery limit')
}
function requireDirectory(dir: string): void {
  if (!statAt(dir)?.isDirectory())
    throw new Error('missing or invalid layer recovery directory; preserve journal and pins')
}
function popped(layer: Layer): boolean {
  const stat = statAt(join(layer.rollbackDir, POPPED))
  if (stat && (!stat.isFile() || stat.size !== 0)) throw new Error('invalid layer POPPED evidence')
  return stat !== undefined
}
function requireEvidence(file: LayerFile): void {
  for (const layer of file.layers) {
    requireDirectory(layer.rollbackDir)
    popped(layer)
  }
}
function readAll(root: string): LayerFile {
  if (!absolute(root)) throw new Error('invalid absolute recovery root')
  directoryAt(root)
  directoryAt(enginePaths(root).state)
  const value = jsonAt(enginePaths(root).layers)
  if (value === undefined) return { version: 1, layers: [] }
  validateLayers(root, value)
  requireEvidence(value)
  return value
}
export function readLayers(root: string): LayerFile {
  const file = readAll(root)
  return {
    ...file,
    layers: file.layers.filter((layer) => !popped(layer)),
  }
}
export function writeLayers(root: string, file: LayerFile): void {
  readAll(root) // Invalid existing evidence cannot authorize replacement or deletion.
  validateLayers(root, file)
  requireEvidence(file)
  if (file.layers.length === 0 && !file.recovery) {
    if (statAt(enginePaths(root).layers)) {
      rmSync(enginePaths(root).layers)
      syncDirectory(enginePaths(root).state)
    }
  } else {
    writeJsonAtomic(enginePaths(root).layers, file)
    syncDirectory(enginePaths(root).state)
    syncDirectory(root)
  }
}
