import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import { AdapterClient, type Wire } from './helpers/adapter-client.mjs'
import { killChildren, spawn } from './helpers/children.mjs'

const adapter = resolve('dist/src/adapter.mjs')

after(() => killChildren())

// A stdio adapter that, once its crash guard is installed, throws `throwSource`
// from a timer: an exception nothing in the adapter catches, which is what the
// guard exists for. Waiting for the guard keeps the test about the guard, not
// about whether a slow module load lost a race with the timer.
async function startThrowing(
  throwSource: string,
): Promise<{ proc: ChildProcess; stderr: () => string; log: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'anyengine-crash-guard-'))
  await mkdir(join(dir, '.codex'), { recursive: true })
  const thrower = join(dir, 'thrower.mjs')
  await writeFile(
    thrower,
    `const wait = setInterval(() => {
  if (process.listenerCount('uncaughtException') === 0) return
  clearInterval(wait)
  setTimeout(() => {
    ${throwSource}
  }, 300)
}, 20)
`,
  )
  const log = join(dir, 'debug.jsonl')
  const proc = spawn(
    process.execPath,
    ['--import', pathToFileURL(thrower).href, adapter, 'app-server', '--listen', 'stdio://'],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME: join(dir, '.codex'),
        ANYENGINE_MOCK: '1',
        ANYENGINE_DEBUG_LOG: log,
        NODE_NO_WARNINGS: '1',
      },
    },
  )
  let stderr = ''
  proc.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  return { proc, stderr: () => stderr, log, dir }
}

// Reap the adapter before its home goes: one that is still running would
// recreate the debug log the test is removing.
async function cleanup(dir: string): Promise<void> {
  await killChildren()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
}

async function debugEvents(log: string): Promise<Wire[]> {
  try {
    const text = await readFile(log, 'utf8')
    return text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Wire)
  } catch {
    return []
  }
}

async function waitForEvent(log: string, event: string, timeoutMs = 5_000): Promise<Wire> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = (await debugEvents(log)).find((entry) => entry.event === event)
    if (found) return found
    await new Promise((resolveWait) => setTimeout(resolveWait, 40))
  }
  throw new Error(`no ${event} in ${log} within ${timeoutMs}ms`)
}

// The exit code, or null when the process is still running after `ms`.
async function exitCodeWithin(proc: ChildProcess, ms: number): Promise<number | null | 'timeout'> {
  if (proc.exitCode !== null) return proc.exitCode
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout('timeout'), ms)
  })
  const exited = once(proc, 'exit').then(([code]) => code as number | null)
  return Promise.race([exited, timeout]).finally(() => clearTimeout(timer))
}

test('an unexpected uncaught exception logs, prints a fatal line and exits 1 instead of looping', async () => {
  const { proc, stderr, log, dir } = await startThrowing("throw new Error('boom from a timer')")
  try {
    const code = await exitCodeWithin(proc, 5_000)
    assert.equal(
      code,
      1,
      `expected exit code 1 within 5s, got ${code}; the guard re-throws into itself and never exits (stderr: ${stderr()})`,
    )
    assert.match(stderr(), /\[anyengine\] fatal: .*boom from a timer/s)
    const logged = await waitForEvent(log, 'adapter.uncaughtException')
    assert.equal(logged.swallowed, false)
    assert.match(String(logged.message), /boom from a timer/)
  } finally {
    await cleanup(dir)
  }
})

for (const code of ['EPIPE', 'ECONNRESET', 'EBADF']) {
  test(`an uncaught ${code} is logged and swallowed, and the adapter keeps serving`, async () => {
    const { proc, stderr, log, dir } = await startThrowing(
      `throw Object.assign(new Error('write ${code}'), { code: '${code}' })`,
    )
    const client = new AdapterClient(proc)
    try {
      const logged = await waitForEvent(log, 'adapter.uncaughtException')
      assert.equal(logged.code, code)
      assert.equal(logged.swallowed, true)
      // Give a crash the time to land before asserting there was none.
      assert.equal(await exitCodeWithin(proc, 700), 'timeout', `adapter exited after ${code}`)
      const init = await client.request('initialize', {
        clientInfo: { name: 'test', title: 'Test', version: '0' },
        capabilities: null,
      })
      assert.ok(init.result, `initialize after ${code} got no result`)
      assert.doesNotMatch(stderr(), /fatal/)
    } finally {
      await cleanup(dir)
    }
  })
}
