import { homedir } from 'node:os'
import { join } from 'node:path'
import { readConfig } from './anyengine-config.mjs'
import { syncDesktopSessions } from './desktop-sessions.mjs'
import { Sessions } from './sessions.mjs'

// Piggyback on an existing AnyEngine process. No extra service or login.
// Configuration is reread, so on/off takes effect without restarting a host.
export function startSessionSync(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  report: (message: string) => void = () => {},
): { close(): Promise<void> } {
  let closed = false
  let current: Sessions | null = null
  let pending: Promise<void> | null = null
  const enabled = () => {
    const read = readConfig(root)
    return (
      !closed &&
      env.ANYENGINE_MOCK !== '1' &&
      !read.errors.length &&
      read.config.sessions.enabled &&
      read.config.sessions.sync
    )
  }
  const tick = () => {
    const read = readConfig(root)
    if (pending || closed || env.ANYENGINE_MOCK === '1' || read.errors.length) return
    const desktopEnabled = read.config.sessions.desktopAccounts
    if (!desktopEnabled && !enabled()) return
    pending = (async () => {
      try {
        if (desktopEnabled) {
          const home = env.HOME || homedir()
          const result = syncDesktopSessions(
            home,
            root,
            env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
          )
          if (result.created)
            report(`Shared ${result.created} Desktop session entries; reopen Claude to reload`)
        }
        if (enabled()) {
          current = new Sessions(root, env)
          const result = await current.sync(25, undefined, enabled)
          if (result.copied.length) report(`Copied ${result.copied.length} new conversations`)
        }
      } catch (error) {
        report(`Session sync paused: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        await current?.close()
        current = null
        pending = null
      }
    })()
  }
  const initial = setTimeout(tick, 1000).unref()
  const timer = setInterval(tick, 60000).unref()
  return {
    async close() {
      closed = true
      clearTimeout(initial)
      clearInterval(timer)
      await current?.close()
      await pending
    },
  }
}
