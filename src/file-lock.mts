// A stable SQLite transaction serializes this short synchronous callback,
// including all legacy PID/token marker recovery and release. Its database
// is never unlinked: an owner and waiter must use the same inode. No data is
// written to it, so it stays bounded and needs no schema or journal writes.
// Process exit releases the SQLite gate; staleMs cannot steal a live gate.
//
// Legacy markers remain visible to observers. Old binaries do not take the
// gate, so drain them before upgrading. Their dead/aged markers can still be
// recovered, but arbitrary concurrent legacy writers are outside this proof.
// An async body is released as soon as it returns its promise; long async
// work (the flip lock) needs its own protocol.
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export interface FileLockOptions {
  // How long to wait for a live holder before giving up (default 10 s).
  waitMs?: number
  // Age past which a legacy marker is stale whatever its pid (default 60 s).
  staleMs?: number
  // For tests: runs after a lock was judged stale, before it is removed.
  beforeTakeover?: () => void
}

const PAUSE = new Int32Array(new SharedArrayBuffer(4))

export function withFileLock<T>(lock: string, run: () => T, options: FileLockOptions = {}): T {
  const token = `${process.pid} ${randomUUID()}\n`
  // A monotonic clock: a wall-clock step back would stretch the wait. A
  // lock's age (its mtime) can only come from the wall clock.
  const giveUp = performance.now() + (options.waitMs ?? 10_000)
  const gate = `${lock}.sqlite`
  const db = new DatabaseSync(gate, { timeout: 0 })
  try {
    // SQLite alone opens/closes the database: closing any ordinary descriptor
    // for it could cancel this process's POSIX locks on another connection.
    chmodSync(gate, 0o600)
    beginGate(db, lock, giveUp)
    try {
      acquireMarker(lock, token, options, giveUp)
      try {
        return run()
      } finally {
        release(lock, token)
      }
    } finally {
      // There are no database writes to commit, even after a successful body.
      db.exec('ROLLBACK')
    }
  } finally {
    db.close()
  }
}

function beginGate(db: DatabaseSync, lock: string, giveUp: number): void {
  for (;;) {
    try {
      db.exec('BEGIN IMMEDIATE')
      return
    } catch (error) {
      // Only SQLITE_BUSY is contention; corruption/I/O/other errors fail closed.
      const code = (error as { errcode?: number }).errcode
      if (code === undefined || (code & 0xff) !== 5) throw error
      pauseUntilRetry(lock, giveUp)
    }
  }
}

function acquireMarker(
  lock: string,
  token: string,
  options: FileLockOptions,
  giveUp: number,
): void {
  while (!tryLock(lock, token)) {
    if (!takeOverIfStale(lock, token, options)) pauseUntilRetry(lock, giveUp)
    else if (performance.now() >= giveUp) throw contention(lock)
  }
}

function contention(lock: string): Error {
  return new Error(
    `another process holds ${lock}; try again after anyengine commands finish; preserve ${lock}.sqlite and its journals`,
  )
}

function pauseUntilRetry(lock: string, giveUp: number): void {
  const left = giveUp - performance.now()
  if (left <= 0) throw contention(lock)
  Atomics.wait(PAUSE, 0, 0, Math.min(20, left))
  if (performance.now() >= giveUp) throw contention(lock)
}

function tryLock(lock: string, token: string): boolean {
  let fd: number
  try {
    fd = openSync(lock, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    writeFileSync(fd, token)
    return true
  } catch (error) {
    // Just created and still empty: no waiter can have judged it stale.
    rmSync(lock, { force: true })
    throw error
  } finally {
    closeSync(fd)
  }
}

// Which file this is: its inode, and its birth time in case an inode number
// is ever reused.
function identity(stat: { ino: bigint; birthtimeNs: bigint }): string {
  return `${stat.ino}:${stat.birthtimeNs}`
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: a live process of another user.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

// The identity of the lock when it is stale, else null. One open file for
// both the age and the pid, so they describe the same lock.
function staleIdentity(lock: string, staleMs: number): string | null {
  let fd: number
  try {
    fd = openSync(lock, 'r')
  } catch {
    return null
  }
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (Date.now() - Number(stat.mtimeMs) > staleMs) return identity(stat)
    const pid = Number.parseInt(readFileSync(fd, 'utf8'), 10)
    return pid > 0 && !alive(pid) ? identity(stat) : null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

// The SQLite gate serializes cooperating callers across this check/unlink.
// The linked identity also detects a legacy replacement before the link;
// it cannot protect against an uncoordinated replacement after the check.
function removeIfStill(path: string, judged: string): boolean {
  const aside = `${path}.stale-${randomUUID()}`
  try {
    linkSync(path, aside)
  } catch {
    return false // already removed
  }
  try {
    if (identity(statSync(aside, { bigint: true })) !== judged) return false
    rmSync(path, { force: true })
    return true
  } finally {
    rmSync(aside, { force: true })
  }
}

function takeOverIfStale(lock: string, token: string, options: FileLockOptions): boolean {
  const staleMs = options.staleMs ?? 60_000
  if (staleIdentity(lock, staleMs) === null) return false
  const breaker = `${lock}.takeover`
  if (!tryLock(breaker, token)) {
    // Held for microseconds; one whose holder died mid-takeover is cleared.
    const judged = staleIdentity(breaker, staleMs)
    if (judged !== null) removeIfStill(breaker, judged)
    return false
  }
  try {
    const judged = staleIdentity(lock, staleMs)
    if (judged === null) return false
    options.beforeTakeover?.()
    return removeIfStill(lock, judged)
  } finally {
    release(breaker, token)
  }
}

function release(lock: string, token: string): void {
  try {
    if (readFileSync(lock, 'utf8') !== token) return
  } catch {
    return
  }
  rmSync(lock, { force: true })
}
