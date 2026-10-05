// These identities fence credential holders, not a development review workflow.
import { spawnSync } from 'node:child_process'
import type { ProcessIdentity } from './accounts-types.mjs'

export function processTable(): ProcessIdentity[] {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,lstart='], {
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  })
  if (result.status !== 0 || result.error) throw new Error('Account process ownership unknown')
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim())
      if (!m?.[3]) throw new Error('Account process table unreadable')
      return { pid: Number(m[1]), pgid: Number(m[2]), start: m[3] }
    })
    .filter((p) => p.pid !== result.pid)
}
export function identifyProcess(pid: number): ProcessIdentity | null {
  return processTable().find((p) => p.pid === pid) ?? null
}
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.pgid === b.pgid && a.start === b.start
}
export function processAlive(identity: ProcessIdentity): 'alive' | 'dead' | 'unknown' {
  try {
    const current = identifyProcess(identity.pid)
    if (!current) return 'dead'
    return sameProcess(current, identity) ? 'alive' : 'unknown'
  } catch {
    return 'unknown'
  }
}
export function familyAlive(identity: ProcessIdentity): 'alive' | 'dead' | 'unknown' {
  try {
    const table = processTable(),
      leader = table.find((p) => p.pid === identity.pid)
    if (leader && !sameProcess(leader, identity)) return 'unknown'
    return table.some((p) => p.pgid === identity.pgid) ? 'alive' : 'dead'
  } catch {
    return 'unknown'
  }
}
export async function stopFamily(identity: ProcessIdentity): Promise<void> {
  if (
    identity.pid !== identity.pgid ||
    identity.pgid === process.pid ||
    identity.pgid === identifyProcess(process.pid)?.pgid
  )
    throw new Error('Refusing to signal a shared account process group')
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const state = familyAlive(identity)
    if (state === 'dead') return
    if (state === 'unknown') throw new Error('Account family ownership unknown')
    try {
      process.kill(-identity.pgid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    const end = Date.now() + 5000
    while (Date.now() < end) {
      const next = familyAlive(identity)
      if (next === 'dead') return
      if (next === 'unknown') throw new Error('Account family identity changed')
      await new Promise((done) => setTimeout(done, 50))
    }
  }
  throw new Error('Account credential family did not exit')
}
