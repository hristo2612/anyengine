import { readConfig } from './anyengine-config.mjs'
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
    if (pending || !enabled()) return
    pending = (async () => {
      try {
        current = new Sessions(root, env)
        const result = await current.sync(25, undefined, enabled)
        if (result.copied.length) report(`Copied ${result.copied.length} new conversations`)
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
