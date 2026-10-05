// Labeled synthetic successful native work. Never installed/native acceptance.
import { join } from 'node:path'
import type { FrozenIdentity, NativeReceipt } from '../../src/smoke-evidence.mjs'
export function nativeReceipt(
  frozen: FrozenIdentity,
  root: string,
  claude = 'haiku',
): NativeReceipt {
  const at = '2026-10-01T00:00:00.000Z'
  const parent = {
    threadId: 'fixture-parent',
    turnId: 'parent-turn',
    model: 'gpt-fixture',
    status: 'completed',
    success: true,
    pong: true,
  }
  const child = {
    threadId: 'fixture-child',
    turnId: 'child-turn',
    model: claude,
    status: 'completed',
    success: true,
    pong: true,
  }
  const completion = {
    event: frozen.mode === 'agent' ? 'claim.done' : 'trampoline.done',
    ts: at,
    threadId: child.threadId,
    turnId: child.turnId,
    model: child.model,
    parentThreadId: parent.threadId,
    parentTurnId: parent.turnId,
    owner: join(root, 'run/claim-990001.sock'),
    success: true,
    ...(frozen.mode === 'model'
      ? { code: 0, sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
      : {}),
  }
  return {
    ...frozen,
    version: 1,
    kind: 'anyengine-native-fanout',
    attempt: 'controlled-attempt',
    startedAt: at,
    completedAt: at,
    effectiveSettings: frozen.key.settings,
    parent,
    child,
    owner: {
      pid: 990001,
      processStart: at,
      root,
      mode: frozen.mode,
      settings: frozen.key.settings,
      after: true,
      closed: true,
    },
    spawn: {
      id: 'completed-spawn',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: parent.threadId,
      receiverThreadIds: [child.threadId],
      model: child.model,
    },
    completion,
    ...(frozen.mode === 'agent' ? { claim: { ...completion, pid: 990001 } } : {}),
    cleanup: { threads: true, sessions: true, processes: true },
  }
}
