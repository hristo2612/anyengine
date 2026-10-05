// Restore only evidenced generations. I/O and missing backup failures throw;
// operator changes remain an explicit nonterminal result, never a popped layer.
import { unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { validateChange } from './control-layer-journal.mjs'
import {
  atomicFile,
  beforeState,
  type FileChange,
  type FileState,
  regularBytes,
  sameState,
  settledState,
  stateAt,
  swapLink,
  syncDirectory,
} from './control-layer-state.mjs'
import { revertHunk } from './control-rc.mjs'
export type RestoreOutcome = 'restored' | 'already' | 'reverted-hunk' | 'left-changed'
type Result = { outcome: RestoreOutcome; detail: string }

function restoreState(target: string, state: FileState, dir: string): void {
  if (state.kind === 'file' && state.bytes && state.mode !== null)
    atomicFile(target, regularBytes(join(dir, state.bytes)), state.mode)
  else if (state.kind === 'symlink' && state.link) swapLink(target, state.link)
  else {
    unlinkSync(target)
    syncDirectory(dirname(target))
  }
}
function textAt(path: string): string | null {
  const bytes = regularBytes(path)
  if (bytes.length >= 1_000_000 || bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}
function hunkRestore(
  change: FileChange,
  dir: string,
  baseline: FileState,
  states: FileState[],
  current: FileState,
): Result | null {
  if (
    current.kind !== 'file' ||
    current.mode === null ||
    baseline.kind !== 'file' ||
    !baseline.bytes
  )
    return null
  const text = textAt(change.target)
  const before = textAt(join(dir, baseline.bytes))
  if (text === null || before === null) return null
  const variants = states.filter(
    (state) =>
      state.kind === 'file' &&
      state.bytes &&
      state.sha !== baseline.sha &&
      state.mode === current.mode,
  )
  const reverted = new Set<string>()
  let already = false
  for (const state of variants) {
    if (!state.bytes) continue
    const after = textAt(join(dir, state.bytes))
    if (after === null) continue
    const result = revertHunk(text, before, after)
    if (result !== null) reverted.add(result)
    else if (revertHunk(text, after, before) !== null) already = true
  }
  if (reverted.size === 1 && !already) {
    const result = [...reverted][0]
    if (result === undefined) return null
    atomicFile(change.target, Buffer.from(result), current.mode)
    return { outcome: 'reverted-hunk', detail: "changed since; only AnyEngine's hunk was reverted" }
  }
  if (reverted.size === 0 && already)
    return { outcome: 'already', detail: "AnyEngine's hunk is already reverted" }
  return null
}
export function restoreChange(
  change: FileChange,
  rollbackDir: string,
  allowHunk: boolean,
  baseline: 'initial' | 'last-good' = 'initial',
): Result {
  validateChange(change, rollbackDir)
  const before = baseline === 'last-good' ? change.lastGood : beforeState(change)
  if (!before) throw new Error('missing last-good recovery baseline')
  const current = stateAt(change.target)
  if (sameState(current, before)) return { outcome: 'already', detail: 'already as before' }
  const states = [settledState(change), ...(change.pending ? [change.pending] : [])]
  if (states.some((state) => sameState(current, state))) {
    restoreState(change.target, before, rollbackDir)
    return { outcome: 'restored', detail: 'restored recorded baseline' }
  }
  if (allowHunk) {
    const result = hunkRestore(change, rollbackDir, before, states, current)
    if (result) return result
  }
  return {
    outcome: 'left-changed',
    detail: `changed since AnyEngine wrote it; recovery evidence: ${rollbackDir}`,
  }
}
