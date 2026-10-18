// Independent expected semantic off state and narrowly admitted fresh evidence.
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseClaudeSettings, restoreClaudeSettings } from './claude-settings.mjs'
import {
  beforeState,
  digest,
  type Layer,
  regularBytes,
  sameState,
  settledState,
  stateAt,
} from './control-layer-state.mjs'
import { readLayers } from './control-layers.mjs'
import type { Saved, Scratch } from './control-proof-snapshot.mjs'

const parse = (path: string) =>
  parseClaudeSettings(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      regularBytes(path, 2_000_000),
    ),
  )

export function claudeBaseline(s: Scratch, expected: Map<string, Saved>): void {
  for (const layer of readLayers(s.root).layers) {
    const descriptor = layer.claudeCode
    if (!descriptor) continue
    const change = layer.changes.find((row) => row.target === descriptor.settingsTarget)
    if (!change?.after) throw new Error('missing Claude settings evidence')
    const before = change.backup ? parse(join(layer.rollbackDir, change.backup)) : {}
    const installed = parse(join(layer.rollbackDir, change.after))
    const observed = stateAt(change.target)
    const current = observed.kind === 'absent' ? {} : parse(change.target)
    const pristine = isDeepStrictEqual(
      restoreClaudeSettings(installed, before, installed, descriptor.ownedModels).value,
      before,
    )
    if (
      sameState(observed, beforeState(change)) ||
      (pristine && sameState(observed, settledState(change)))
    )
      continue
    const restored = restoreClaudeSettings(current, before, installed, descriptor.ownedModels)
    if (restored.conflicts.length) throw new Error('Claude settings restore conflict')
    const bytes = Buffer.from(`${JSON.stringify(restored.value, null, 2)}\n`)
    expected.set(change.target, {
      state: isDeepStrictEqual(current, restored.value)
        ? observed
        : {
            kind: 'file',
            sha: digest(bytes),
            bytes: null,
            link: null,
            mode: observed.mode ?? 0o600,
          },
    })
  }
}

export function claudeArtifacts(
  prior: Layer[],
  expected: Map<string, Saved>,
  before: Map<string, string>,
  after: Map<string, string>,
): { allowed: Set<string>; differences: string[] } {
  const allowed = new Set<string>(),
    differences: string[] = []
  for (const layer of prior) {
    const target = layer.claudeCode?.settingsTarget
    const wanted = target ? expected.get(target)?.state : null
    if (!target || !wanted || wanted.kind !== 'file') continue
    const change = layer.changes.find((row) => row.target === target)
    const observedBefore = JSON.parse(before.get(target) ?? 'null')
    if (!change?.after || !observedBefore) continue
    const original = change.backup ? parse(join(layer.rollbackDir, change.backup)) : {}
    const installed = parse(join(layer.rollbackDir, change.after))
    const pristine = isDeepStrictEqual(
      restoreClaudeSettings(installed, original, installed, layer.claudeCode?.ownedModels ?? [])
        .value,
      original,
    )
    if (
      sameState(observedBefore, beforeState(change)) ||
      (pristine && sameState(observedBefore, settledState(change))) ||
      sameState(observedBefore, wanted)
    )
      continue
    const candidates = [...after.keys()].filter(
      (path) =>
        !before.has(path) &&
        dirname(path) === layer.rollbackDir &&
        (/^[a-f0-9]{64}\.bytes$/.test(basename(path)) ||
          /^claude-off-[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\.blob$/.test(basename(path))),
    )
    if (candidates.length > 1) differences.push('Claude off: multiple fresh semantic backups')
    for (const path of candidates) {
      const observed = stateAt(path)
      if (
        observed.kind !== 'file' ||
        observed.mode !== 0o600 ||
        observed.sha !== wanted.sha ||
        (basename(path).endsWith('.bytes') && basename(path) !== `${wanted.sha}.bytes`)
      )
        differences.push('Claude off: invalid fresh semantic backup')
      else allowed.add(path)
    }
  }
  return { allowed, differences }
}
