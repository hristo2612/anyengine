// The long-lived owner is a PID/start/token/inode tuple. Only admission and
// release use the existing short SQLite gate; no async work runs under it.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { directoryAt, statAt, syncDirectory } from './control-layer-state.mjs'
import type { System } from './control-system.mjs'
import { withFileLock } from './file-lock.mjs'

type Owner = { pid: number; processStart: string; token: string }
type Observed = { owner: Owner; identity: string }
const identity = (s: { dev: bigint; ino: bigint }) => `${s.dev}:${s.ino}`
export function prepareFlipState(root: string): void {
  if (!isAbsolute(root)) throw new Error('flip root must be absolute')
  const state = join(root, 'state')
  for (let cursor = state; ; cursor = dirname(cursor)) {
    directoryAt(cursor)
    if (cursor === dirname(cursor)) break
  }
  mkdirSync(state, { recursive: true, mode: 0o700 })
  syncDirectory(root)
}
export function ownProcessStart(system: System): string {
  const own = system.processes().find((p) => p.pid === process.pid)
  if (
    !own ||
    !Number.isFinite(Date.parse(own.processStart)) ||
    new Date(own.processStart).toISOString() !== own.processStart
  )
    throw new Error('cannot verify flip process start identity')
  return own.processStart
}
function observe(path: string): Observed | null {
  if (!statAt(path)) return null
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd, { bigint: true })
    if (!st.isFile() || st.size > 4096n) throw new Error('invalid flip lock file; preserve it')
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd)),
    ) as Owner
    if (
      !Number.isSafeInteger(value?.pid) ||
      value.pid <= 0 ||
      !/^[a-f0-9-]{36}$/.test(value.token) ||
      typeof value.processStart !== 'string' ||
      !Number.isFinite(Date.parse(value.processStart)) ||
      new Date(value.processStart).toISOString() !== value.processStart ||
      Object.keys(value).sort().join(',') !== 'pid,processStart,token'
    )
      throw new Error('invalid flip lock owner; preserve it')
    return { owner: value, identity: identity(st) }
  } finally {
    closeSync(fd)
  }
}
function removeObserved(path: string, observed: Observed): boolean {
  const aside = `${path}.stale-${randomUUID()}`
  linkSync(path, aside)
  try {
    const current = observe(path)
    const linked = observe(aside)
    if (
      current?.identity !== observed.identity ||
      linked?.identity !== observed.identity ||
      current.owner.token !== observed.owner.token
    )
      return false
    unlinkSync(path)
    syncDirectory(join(path, '..'))
    return true
  } finally {
    unlinkSync(aside)
  }
}
export function inspectFlipLock(root: string, system: System): number | null {
  const found = observe(join(root, 'state/flip.lock'))
  if (!found) return null
  const live = system.processes().find((p) => p.pid === found.owner.pid)
  return live?.processStart === found.owner.processStart ? found.owner.pid : null
}
export function takeFlipLock(
  root: string,
  system: System,
): { ok: true; release(): void } | { ok: false; holder: number } {
  const owner = { pid: process.pid, processStart: ownProcessStart(system), token: randomUUID() }
  const dir = join(root, 'state')
  const path = join(dir, 'flip.lock')
  // Validate existing lock/process evidence before even creating a short gate.
  inspectFlipLock(root, system)
  prepareFlipState(root)
  const gate = join(dir, 'flip-admission.lock')
  return withFileLock(gate, () => {
    const previous = observe(path)
    if (previous) {
      const live = system.processes().find((p) => p.pid === previous.owner.pid)
      if (live?.processStart === previous.owner.processStart)
        return { ok: false, holder: previous.owner.pid }
      if (!removeObserved(path, previous))
        throw new Error('flip lock changed during takeover; retry')
    }
    const fd = openSync(path, 'wx', 0o600)
    let created: string
    try {
      created = identity(fstatSync(fd, { bigint: true }))
      writeFileSync(fd, `${JSON.stringify(owner)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    syncDirectory(dir)
    let released = false
    return {
      ok: true,
      release() {
        if (released) return
        withFileLock(gate, () => {
          const current = observe(path)
          if (current?.identity === created && current.owner.token === owner.token)
            removeObserved(path, current)
        })
        released = true
      },
    }
  })
}
