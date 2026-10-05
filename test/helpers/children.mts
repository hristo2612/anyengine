import { type ChildProcess, spawn as spawnChild } from 'node:child_process'
import { once } from 'node:events'

// Every child a suite starts, so `after(() => killChildren())` reaps the ones
// a failed assertion left running: a live child keeps node:test's process, and
// the temp home it writes into, alive past the suite.
const children = new Set<ChildProcess>()

// How long a child gets to exit after a signal. A child writes its V8 coverage
// file as it exits; one still writing when the coverage run reads the files
// fails the whole run ("Could not report code coverage").
const EXIT_WAIT_MS = 5_000

export const spawn: typeof spawnChild = ((...args: Parameters<typeof spawnChild>) => {
  const child = spawnChild(...args)
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}) as typeof spawnChild

// Stops every child still running and waits for each to exit. One the test
// already signalled is left to finish its shutdown; the rest get SIGTERM, so
// an adapter stops its own children first, and SIGKILL if that is not enough.
export async function killChildren(): Promise<void> {
  const running = [...children]
  children.clear()
  await Promise.all(running.map((child) => reap(child)))
}

async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit').then(() => true)
    if (!child.killed) child.kill('SIGTERM')
    if (!(await within(exited, EXIT_WAIT_MS))) {
      child.kill('SIGKILL')
      await within(exited, EXIT_WAIT_MS)
    }
  }
  child.stdin?.destroy()
  child.stdout?.destroy()
  child.stderr?.destroy()
}

// A process this suite did not spawn directly (the shim disowns its unix
// daemon): SIGTERM, wait until the pid is gone, SIGKILL if it has to.
export async function stopProcess(pid: number): Promise<void> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!signalled(pid, signal)) return
    const deadline = Date.now() + EXIT_WAIT_MS
    while (Date.now() < deadline) {
      if (!signalled(pid, 0)) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

function signalled(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

function within(promise: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Resolves with everything the child has written to stdout once it matches
// `pattern`: a response can arrive after notifications, or split over chunks.
export function waitForOutput(
  child: ChildProcess,
  pattern: RegExp,
  timeoutMs = 20_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${pattern}; got: ${out.slice(-500)}`)),
      timeoutMs,
    )
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
      if (!pattern.test(out)) return
      clearTimeout(timer)
      resolve(out)
    })
  })
}
