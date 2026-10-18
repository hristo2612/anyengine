// Scratch-only forward installation, with publisher attribution relocated
// again before any recovery implementation can execute.
import { mkdirSync } from 'node:fs'
import { applyOnFiles, applySharedConfig } from './control-install.mjs'
import type { FileState } from './control-layer-state.mjs'
import { prepareScratchPublisher, relocateRecoveryPins } from './control-proof-relocation.mjs'
import { type Saved, type Scratch, saved } from './control-proof-snapshot.mjs'

const ABSENT: FileState = { kind: 'absent', sha: null, bytes: null, link: null, mode: null }
export function install(s: Scratch, plan = s.plan): void {
  prepareScratchPublisher(s)
  const result = applyOnFiles(s.system, s.root, plan, { dryRun: false, paths: s.paths })
  if (result.refused) throw new Error(result.refused)
  for (const path of [...result.wrote, ...result.unchanged])
    if (!s.targets.has(path)) s.targets.set(path, { state: ABSENT })
  const shared = applySharedConfig(s.system, s.root, plan, { dryRun: false, paths: s.paths })
  for (const path of shared.wrote) if (!s.targets.has(path)) s.targets.set(path, { state: ABSENT })
  relocateRecoveryPins(s)
}
export function upgrade(s: Scratch): Map<string, Saved> {
  const before = new Map([...s.targets.keys()].map((path) => [path, saved(path)]))
  const plan = {
    ...s.plan,
    version: `${s.plan.version}-proof-upgrade`,
    libDir: `${s.plan.libDir}-proof-upgrade`,
    stamp: `${s.plan.stamp}-upgrade`,
  }
  mkdirSync(plan.libDir, { recursive: true })
  prepareScratchPublisher(s)
  const result = applyOnFiles(s.system, s.root, plan, { dryRun: false, paths: s.paths })
  if (result.refused) throw new Error(result.refused)
  for (const path of [...result.wrote, ...result.unchanged])
    if (!before.has(path)) before.set(path, { state: ABSENT })
  relocateRecoveryPins(s)
  return before
}
