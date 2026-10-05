import { generateM2Rollback } from './control-m2-recovery-script.mjs'
import {
  type M2Baseline,
  m2Paths,
  type RecoveryMilestone,
  readM2Journal,
  writeM2Journal,
} from './control-m2-recovery-state.mjs'
import { readFlipMarker } from './control-marker.mjs'
import type { System } from './control-system.mjs'

export interface M2RollbackResult {
  ok: boolean
  restoredLib: string | null
  conflicts: string[]
  m1Verified: boolean
}

const failure = (conflicts: string[]): M2RollbackResult => ({
  ok: false,
  restoredLib: null,
  conflicts,
  m1Verified: false,
})

export function m2RollbackScript(
  baseline: M2Baseline,
  options: { root: string; app: string; bundleId: string },
): string {
  return generateM2Rollback(baseline, options)
}

// Node and the surviving absolute command use the same admission, semantic
// restore and terminal verification engine. The wrapper never restores files.
export async function rollbackM2(
  system: System,
  root: string,
  options: { noRestart: boolean },
  milestone: RecoveryMilestone = 'm2',
): Promise<M2RollbackResult> {
  try {
    const journal = readM2Journal(root, milestone)
    if (!journal) return failure(['M2 baseline is missing; preserve recovery evidence'])
    if (options.noRestart && system.appRunning())
      return failure(['app is running; exit it before M2 rollback with no restart'])
    const marker = readFlipMarker(root)
    if (
      journal.baseline.phase === 'active' &&
      !journal.sharedMarkerDetached &&
      marker?.state.failureTarget === milestone &&
      marker.state[`${milestone}BaselineId`] === journal.baselineId
    ) {
      journal.transactionId = marker.id
      writeM2Journal(root, journal, false, milestone)
    }
    const result = system.exec(
      '/bin/bash',
      [m2Paths(root, milestone).entry, ...(options.noRestart ? ['--no-restart'] : [])],
      { timeoutMs: 120_000 },
    )
    const after = readM2Journal(root, milestone)
    if (
      result.status === 0 &&
      after?.baseline.phase === 'rolled-back' &&
      after.baselineId === journal.baselineId
    )
      return { ok: true, restoredLib: journal.baseline.priorLib, conflicts: [], m1Verified: true }
    return failure(
      after?.conflicts.length
        ? [...after.conflicts, ...(result.stderr.trim() ? [result.stderr.trim().slice(-4096)] : [])]
        : [
            `${milestone.toUpperCase()} rollback did not verify its prior milestone; recover with /bin/bash ${m2Paths(root, milestone).entry}${result.stderr.trim() ? `; ${result.stderr.trim().slice(-4096)}` : ''}`,
          ],
    )
  } catch {
    return failure([`M2 rollback inspection failed; preserve ${m2Paths(root, milestone).entry}`])
  }
}
