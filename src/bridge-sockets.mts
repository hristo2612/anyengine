// Where the bridge's control socket lives, and the sweep for sockets left by
// adapters that died without unlinking theirs. Moved out of bridge-control.mts
// so that file stays under its size baseline.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adapterHome, socketPathLimit, stableHash } from './util.mjs'

export function defaultBridgeSocketPath(): string {
  const preferred = join(adapterHome(), `bridge-${process.pid}.sock`)
  if (preferred.length <= socketPathLimit()) return preferred
  return join(tmpdir(), `ccxb-${stableHash(preferred).slice(0, 12)}-${process.pid}.sock`)
}

// Sockets left by adapters that died without unlinking (pid encoded in the
// name; `kill -0` decides).
export function reapStaleSockets(socketPath: string): void {
  const dir = join(socketPath, '..')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return
  }
  for (const entry of readdirSync(dir)) {
    const match = /^(?:bridge|ccxb-[0-9a-f]+)-(\d+)\.sock$/.exec(entry)
    if (!match) continue
    const pid = Number(match[1])
    if (pid === process.pid) continue
    try {
      process.kill(pid, 0)
    } catch {
      try {
        rmSync(join(dir, entry), { force: true })
      } catch {}
    }
  }
}
