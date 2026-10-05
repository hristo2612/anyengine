// Reuse smoke's owned-family observer/joiner; this record grants no proof authority.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function probeProcesses(api, system, work) {
  const groups = new Map()
  const roots = new Map()
  let timer, failure, closing
  const record = (status) =>
    writeFileSync(
      join(work, 'process-cleanup.json'),
      `${JSON.stringify({ status, cohort: ctx.cohort })}\n`,
      { mode: 0o600 },
    )
  const ctx = { system, cohort: [], run: { pending: () => record('pending') } }
  const sample = () => {
    let live
    try {
      live = system.processes()
    } catch (error) {
      failure ??= error
      return
    }
    for (const [pid, start] of roots) {
      const actual = live.find((p) => p.pid === pid)
      if (!actual) continue
      if (actual.processStart !== start) {
        failure ??= new Error('probe process identity reused')
        continue
      }
      try {
        for (const [group, life] of api.observedFamily(ctx, pid)) groups.set(group, life)
      } catch (error) {
        failure ??= error
      }
    }
  }
  return {
    pending: () => record('pending'),
    add(pid) {
      const life = system.processes().find((p) => p.pid === pid)
      if (!life) {
        failure = new Error('probe process disappeared before observation')
        throw failure
      }
      roots.set(pid, life.processStart)
      try {
        for (const [group, life] of api.observedFamily(ctx, pid)) groups.set(group, life)
      } catch (error) {
        failure ??= error
        throw error
      }
      timer ??= setInterval(sample, 100)
    },
    sample,
    close() {
      closing ??= (async () => {
        clearInterval(timer)
        await api.joinedGroups(ctx, groups)
        if (failure) {
          record('unknown')
          throw failure
        }
        record('joined')
      })()
      return closing
    },
  }
}
