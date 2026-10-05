// Effective postures for persisted threads and runtime contexts, including local
// Codex requirements that never arrive on the app-server wire.

import type { Posture } from './posture.mjs'
import { DEFAULT_POSTURE, parseApprovalPolicy, parseSandboxMode } from './posture-convert.mjs'
import { withLocalReadRestrictions } from './requirements-reads.mjs'
import type { RuntimeTurnContext, ThreadRecord } from './types.mjs'

// Rows written before the posture was stored carry only the two legacy
// strings; they convert as recorded.
export function legacyPosture(
  approvalPolicy?: string | null,
  sandboxMode?: string | null,
): Posture {
  const fileSystem = parseSandboxMode(sandboxMode) ?? DEFAULT_POSTURE.fileSystem
  return {
    ...DEFAULT_POSTURE,
    fileSystem,
    network: fileSystem.kind === 'full-access',
    approval:
      approvalPolicy == null
        ? DEFAULT_POSTURE.approval
        : (parseApprovalPolicy(approvalPolicy) ?? 'untrusted'),
  }
}

export function threadPosture(
  thread: Pick<ThreadRecord, 'posture' | 'approvalPolicy' | 'sandboxMode'> | null,
): Posture {
  return withLocalReadRestrictions(
    thread?.posture ?? legacyPosture(thread?.approvalPolicy, thread?.sandboxMode),
  )
}

// The posture a runtime enforces for one turn: the thread's, plus the turn's
// own `planMode` flag.
export function contextPosture(
  context: Pick<RuntimeTurnContext, 'posture' | 'approvalPolicy' | 'sandboxMode' | 'planMode'>,
): Posture {
  const posture = withLocalReadRestrictions(
    context.posture ?? legacyPosture(context.approvalPolicy, context.sandboxMode),
  )
  return context.planMode && !posture.plan ? { ...posture, plan: true } : posture
}
