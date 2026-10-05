// Read bounded JSONL tails, oldest first. Never open SQLite coordination data:
// an ordinary descriptor close can release the owning process's POSIX locks.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs'

function jsonlPath(path: string): void {
  if (/\.(sqlite3?|db)(-(wal|shm|journal))?$/.test(path))
    throw new Error('SQLite coordination files are opaque; use stat or SQLite-aware access')
}

export function tailJsonl(path: string, maxBytes = 2_000_000): Array<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 2_000_000)
    throw new Error('log tail bytes must be between 0 and 2000000')
  jsonlPath(path)
  if (maxBytes === 0) return []
  let fd: number
  try {
    const resolved = realpathSync(path)
    jsonlPath(resolved)
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('log tail requires a regular file')
    const start = Math.max(0, stat.size - maxBytes)
    const offset = start > 0 ? start - 1 : 0
    const buffer = Buffer.alloc(stat.size - offset)
    const count = readSync(fd, buffer, 0, buffer.length, offset)
    const lines = buffer
      .subarray(start > 0 ? 1 : 0, count)
      .toString('utf8')
      .split('\n')
    if (start > 0 && buffer[0] !== 10) lines.shift()
    return lines.flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line)
        return value !== null && typeof value === 'object' && !Array.isArray(value)
          ? [value as Record<string, unknown>]
          : []
      } catch {
        return []
      }
    })
  } finally {
    closeSync(fd)
  }
}

export function lastEvent(
  events: Array<Record<string, unknown>>,
  names: RegExp,
  pid?: number,
): Record<string, unknown> | null {
  const match = new RegExp(names.source, names.flags)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    match.lastIndex = 0
    if (event && match.test(String(event.event ?? '')) && (pid === undefined || event.pid === pid))
      return event
  }
  return null
}
