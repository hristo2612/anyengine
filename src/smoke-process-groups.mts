// Bounded owned-family joins. Permission denial remains unknown until a fresh absence observation.
import type { PathContext } from './smoke.mjs'

type Life = { pid: number; processStart: string }

export async function joinedGroups(ctx: PathContext, groups: Map<number, Life>): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const unknown = new Set<number>()
    const live = [...groups.keys()].filter((pid) => {
      try {
        process.kill(-pid, 0)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
        unknown.add(pid)
        return true
      }
    })
    if (!live.length) {
      if (ctx.cohort.some((p) => ctx.system.processes().some((actual) => actual.pid === p.pid)))
        throw new Error('owned cohort remains alive outside its group')
      return
    }
    if (attempt === 100) {
      const procs = ctx.system.processes()
      for (const group of live) {
        if (unknown.has(group)) continue
        const owned = procs.filter((p) =>
          ctx.cohort.some((known) => known.pid === p.pid && known.processStart === p.processStart),
        )
        const member = owned.some((p) => {
          const row = ctx.system.exec('/bin/ps', ['-o', 'pgid=', '-p', String(p.pid)], {
            timeoutMs: 1000,
          })
          return row.status === 0 && Number(row.stdout.trim()) === group
        })
        if (!member) throw new Error('group membership unknown; retain run')
        try {
          process.kill(-group, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    }
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error('owned probe groups not joined; retain run')
}
