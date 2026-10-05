import { basename, dirname, join } from 'node:path'
import { adapterArguments, type ProcessInfo } from './control-system.mjs'

// A managed official child has exactly one additional, installed supervisor hop.
export function managedCodexChild(
  child: ProcessInfo,
  adapter: Pick<ProcessInfo, 'pid' | 'command'>,
  processes: ProcessInfo[],
): boolean {
  if (child.ppid === adapter.pid) return true
  const parent = processes.find((p) => p.pid === child.ppid)
  const invocation = adapterArguments(adapter.command)
  if (!parent || parent.ppid !== adapter.pid || !invocation) return false
  const command =
    /^(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:"([^"]+)"|'([^']+)'|(.+?accounts-supervisor\.mjs))(?=\s|$)/.exec(
      parent.command,
    )
  const node = command?.[1] ?? command?.[2] ?? command?.[3]
  const script = command?.[4] ?? command?.[5] ?? command?.[6]
  return (
    !!node &&
    basename(node) === 'node' &&
    script === join(dirname(invocation.script), 'accounts-supervisor.mjs') &&
    parent.processGroup === parent.pid &&
    child.processGroup === parent.pid &&
    Date.parse(parent.processStart) <= Date.parse(child.processStart)
  )
}
