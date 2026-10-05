import type { ChildProcess } from 'node:child_process'
import type { ManagedChildLifecycle } from './accounts-family.mjs'
import { debugLog } from './util.mjs'
export async function stopCodexChild(
  child: ChildProcess,
  closed: Promise<void> | undefined,
  lifecycle: ManagedChildLifecycle | null,
): Promise<void> {
  if (!closed) throw new Error('codex upstream child closure is untracked')
  if (lifecycle) {
    await lifecycle.stop(child)
    return
  }
  if (child.exitCode != null || child.signalCode != null || child.pid == null) return
  const pid = child.pid
  let timer: NodeJS.Timeout | undefined
  try {
    child.stdin?.end()
  } catch {}
  try {
    process.kill(pid, 'SIGTERM')
  } catch {}
  const result = await Promise.race([
    closed.then(() => 'closed'),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 5000)
    }),
  ]).finally(() => clearTimeout(timer))
  if (result === 'timeout') {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  debugLog('codex.upstream.stopped', { pid, result })
}
