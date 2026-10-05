import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { buildGptAgent, gptAgentFilename, validateClaudeTarget } from './claude-agents.mjs'
import type { GptSettingsView } from './claude-models.mjs'
import {
  buildClaudeSettings,
  ownedClaudeModels,
  parseClaudeSettings,
  restoreClaudeSettings,
} from './claude-settings.mjs'
import {
  atomicFile,
  beforeState,
  digest,
  type FileChange,
  type FileState,
  keepBytes,
  regularBytes,
  sameState,
  settledState,
  stateAt,
} from './control-layer-state.mjs'
import {
  type Layer,
  type LayerFile,
  type LayerWriter,
  readLayers,
  restoreChange,
  writeLayers,
} from './control-layers.mjs'
import type { Obj } from './vendor/claude-code-proxy/types.mjs'

const touchedPaths = [
  'env.ANTHROPIC_BASE_URL',
  'env.ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'env.CLAUDE_CODE_GATEWAY_HINT_HEADERS',
  'modelPicker.options',
]
const decoded = (bytes: Buffer) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
function currentText(target: string): string | null {
  const state = stateAt(target)
  if (state.kind === 'absent') return null
  if (state.kind !== 'file') throw new Error(`Claude target must be a regular file: ${target}`)
  return decoded(regularBytes(target, 2_000_000))
}
function recordedSettings(layer: Layer, change: FileChange, side: 'before' | 'after'): Obj {
  const blob = side === 'before' ? change.backup : change.after
  return blob
    ? parseClaudeSettings(decoded(regularBytes(join(layer.rollbackDir, blob), 2_000_000)))
    : {}
}

export function applyClaudeLayer(input: {
  root: string
  home: string
  writer: LayerWriter
  catalog: GptSettingsView
  baseUrl: string
  haiku: string
  checkpoint?: boolean
}): void {
  const { writer, catalog } = input
  if (
    writer.layer.name !== 'claude-code' ||
    !Number.isSafeInteger(catalog.generation) ||
    catalog.generation < 0 ||
    !Number.isSafeInteger(catalog.fetchedAt) ||
    catalog.fetchedAt < 0 ||
    catalog.models.length > 10
  )
    throw new Error('invalid Claude layer catalog or owner')
  const dir = join(input.home, '.claude')
  const target = validateClaudeTarget(dir, join(dir, 'settings.json'))
  const observed = stateAt(target)
  const before = parseClaudeSettings(currentText(target) ?? '{}')
  const after = buildClaudeSettings(before, {
    baseUrl: input.baseUrl,
    haiku: input.haiku,
    models: catalog.models,
  })
  const prior = writer.layer.claudeCode
  if (prior && prior.settingsTarget !== target)
    throw new Error('Claude layer config directory changed')
  const initial = writer.layer.changes.find((change) => change.target === target)
  if (prior && initial) {
    const original = recordedSettings(writer.layer, initial, 'before')
    const installed = recordedSettings(writer.layer, initial, 'after')
    const probe = restoreClaudeSettings(before, original, installed, prior.ownedModels)
    if (probe.conflicts.length)
      throw new Error(`owned Claude settings changed: ${probe.conflicts.join(', ')}`)
    const picker = after.modelPicker as Obj
    const models = new Map(catalog.models.map((model) => [model.id, model]))
    picker.options = (picker.options as Obj[]).map((row) => {
      const model = models.get(String(row.model))
      return model && prior.ownedModels.includes(model.id)
        ? { model: model.id, label: model.label, description: 'via AnyEngine' }
        : row
    })
  }
  const ownedModels = [
    ...new Set([...(prior?.ownedModels ?? []), ...ownedClaudeModels(before, after)]),
  ]
  if (ownedModels.length > 10) throw new Error('Claude owned model limit exceeded')
  const agents = catalog.models.map((model) => {
    const path = validateClaudeTarget(dir, join(dir, 'agents', gptAgentFilename(model)))
    const state = stateAt(path)
    const known = writer.layer.changes.find((change) => change.target === path)
    const own = known?.after
      ? decoded(regularBytes(join(writer.layer.rollbackDir, known.after)))
      : null
    const result = buildGptAgent(currentText(path), model, own)
    return { path, state, result }
  })
  // All inputs and collisions are inspected before the first user-file mutation.
  if (input.checkpoint) writer.beginUpgrade(target)
  writer.layer.claudeCode = {
    settingsTarget: target,
    ownedModels,
    touchedPaths: [...touchedPaths],
    catalog: { generation: catalog.generation, fetchedAt: catalog.fetchedAt },
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!sameState(stateAt(target), observed))
    throw new Error('Claude settings changed before replacement')
  writer.writeFile(target, `${JSON.stringify(after, null, 2)}\n`, observed.mode ?? 0o600)
  for (const agent of agents) {
    if (agent.result.outcome === 'collision' || agent.result.value === null) continue
    if (!sameState(stateAt(agent.path), agent.state))
      throw new Error('Claude agent changed before replacement')
    mkdirSync(dirname(agent.path), { recursive: true, mode: 0o700 })
    writer.writeFile(agent.path, agent.result.value, agent.state.mode ?? 0o600)
  }
}

function routesHere(current: Obj, installed: Obj): boolean {
  const env = (value: Obj) =>
    value.env && typeof value.env === 'object' && !Array.isArray(value.env) ? value.env : {}
  try {
    return (
      new URL(String(env(current).ANTHROPIC_BASE_URL)).origin ===
      new URL(String(env(installed).ANTHROPIC_BASE_URL)).origin
    )
  } catch {
    return false
  }
}
interface SettingsRestore {
  change: FileChange
  observed: FileState
  bytes: Buffer | null
  exact: boolean
  conflicts: string[]
  routingRetained: boolean
}
function settingsRestore(layer: Layer): SettingsRestore {
  const descriptor = layer.claudeCode
  const change = layer.changes.find((row) => row.target === descriptor?.settingsTarget)
  if (!descriptor || !change) throw new Error('missing Claude layer semantic authority')
  const observed = stateAt(change.target)
  const before = recordedSettings(layer, change, 'before')
  const after = recordedSettings(layer, change, 'after')
  const pristine = isDeepStrictEqual(
    restoreClaudeSettings(after, before, after, descriptor.ownedModels).value,
    before,
  )
  if (
    sameState(observed, beforeState(change)) ||
    (pristine && sameState(observed, settledState(change)))
  )
    return { change, observed, bytes: null, exact: true, conflicts: [], routingRetained: false }
  try {
    const current = parseClaudeSettings(currentText(change.target) ?? '{}')
    const restored = restoreClaudeSettings(current, before, after, descriptor.ownedModels)
    const bytes = isDeepStrictEqual(restored.value, current)
      ? null
      : Buffer.from(`${JSON.stringify(restored.value, null, 2)}\n`)
    return {
      change,
      observed,
      bytes,
      exact: false,
      conflicts: restored.conflicts,
      routingRetained: routesHere(current, after),
    }
  } catch {
    return {
      change,
      observed,
      bytes: null,
      exact: false,
      conflicts: [change.target],
      routingRetained: true,
    }
  }
}

function restoreSemantic(root: string, file: LayerFile, layer: Layer, plan: SettingsRestore): void {
  if (!plan.bytes) return
  const wanted: FileState = {
    kind: 'file',
    sha: digest(plan.bytes),
    link: null,
    bytes: keepBytes(layer.rollbackDir, plan.bytes),
    mode: plan.observed.mode ?? 0o600,
  }
  // Retain the installed after-state: a resumed semantic off still needs that ownership.
  plan.change.pending = wanted
  writeLayers(root, file)
  if (!sameState(stateAt(plan.change.target), plan.observed))
    throw new Error('Claude settings changed during restoration; pending recovery retained')
  atomicFile(plan.change.target, plan.bytes, wanted.mode ?? 0o600)
  plan.change.pending = null
  writeLayers(root, file)
}

export function restoreClaudeLayer(root: string): {
  ok: boolean
  conflicts: string[]
  routingRetained: boolean
} {
  const file = readLayers(root)
  const layer = file.layers.find((row) => row.name === 'claude-code')
  if (!layer) return { ok: true, conflicts: [], routingRetained: false }
  const settings = settingsRestore(layer)
  const agents = layer.changes
    .filter((row) => row !== settings.change)
    .map((change) => {
      const observed = stateAt(change.target)
      const safe =
        sameState(observed, beforeState(change)) ||
        sameState(observed, settledState(change)) ||
        (change.pending !== null && sameState(observed, change.pending))
      return { change, observed, safe }
    })
  const conflicts = [
    ...settings.conflicts,
    ...agents.filter((row) => !row.safe).map((row) => row.change.target),
  ]
  if (conflicts.length) return { ok: false, conflicts, routingRetained: settings.routingRetained }
  for (const agent of agents) {
    if (!sameState(stateAt(agent.change.target), agent.observed))
      throw new Error('Claude agent changed during restoration')
  }
  if (!sameState(stateAt(settings.change.target), settings.observed))
    throw new Error('Claude settings changed during restoration')
  if (settings.exact) {
    const result = restoreChange(settings.change, layer.rollbackDir, false)
    if (result.outcome === 'left-changed') throw new Error('Claude settings restoration changed')
  } else restoreSemantic(root, file, layer, settings)
  for (const agent of agents) {
    const result = restoreChange(agent.change, layer.rollbackDir, false)
    if (result.outcome === 'left-changed') throw new Error('Claude agent restoration changed')
  }
  // Pending semantic generations stay discoverable until every dependent file is restored.
  file.layers = file.layers.filter((row) => row !== layer)
  writeLayers(root, file)
  return { ok: true, conflicts: [], routingRetained: false }
}
