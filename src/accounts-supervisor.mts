// Launched in a dedicated group, blocked until the durable holder is attached.
import { type ChildProcess, spawn } from 'node:child_process'
import { processTable } from './accounts-processes.mjs'

const [binary, ...args] = process.argv.slice(2)
if (!binary || !process.send) throw new Error('Account supervisor requires its parent channel')
let child: ChildProcess | null = null,
  stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  clearTimeout(waiting)
  if (!child) {
    process.exitCode = 1
    if (process.connected) process.disconnect?.()
    return
  }
  // This process catches TERM; every descendant in its private group receives it.
  try {
    process.kill(-process.pid, 'SIGTERM')
  } catch {}
  const timer = setTimeout(() => {
    try {
      process.kill(-process.pid, 'SIGKILL')
    } catch {}
  }, 5000)
  child.once('close', () => {
    void (async () => {
      // Keep the KILL deadline until every member has exited, not just the CLI.
      while (processTable().some((p) => p.pgid === process.pid && p.pid !== process.pid))
        await new Promise((done) => setTimeout(done, 50))
      clearTimeout(timer)
      process.stdin.unpipe()
      process.stdin.destroy()
      process.exitCode = 1
      if (process.connected) process.disconnect?.()
    })().catch(() => {
      /* The retained KILL deadline still owns cleanup. */
    })
  })
}
const waiting = setTimeout(stop, 10_000)
process.once('disconnect', stop)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.once('message', (message) => {
  if (
    stopping ||
    !message ||
    typeof message !== 'object' ||
    !('run' in message) ||
    message.run !== true
  ) {
    stop()
    return
  }
  clearTimeout(waiting)
  child = spawn(binary, args, { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] })
  const current = child
  current.once('error', stop)
  current.stdin?.on('error', stop)
  if (!current.stdin) {
    stop()
    return
  }
  process.stdin.pipe(current.stdin)
  current.stdout?.pipe(process.stdout)
  current.once('spawn', () => process.send?.({ launched: true, pid: current.pid }))
  current.once('close', (code) => {
    if (stopping) return
    stopping = true
    process.stdin.unpipe()
    process.stdin.pause()
    process.exitCode = code ?? 1
    if (process.connected) process.disconnect?.()
  })
})
process.send({ ready: true })
