// Real runtime lifecycle with only its PTY and slow resource initialization
// replaced. No SessionStart event: cancellation must not depend on that hook.
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type { TestContext } from 'node:test'
import type { IPty } from 'node-pty'
import { PtyHookServer } from '../../src/anyengine-hooks.mjs'
import { SsePtyProxy } from '../../src/anyengine-proxy.mjs'
import { AnyengineRuntime } from '../../src/anyengine-runtime.mjs'
import { PtyScreen } from '../../src/anyengine-screen.mjs'
import { tempDir } from './tmp.mjs'

export function preparationGate() {
  let resolve!: () => void
  const promise = new Promise<void>((ok) => {
    resolve = ok
  })
  return { promise, resolve }
}

export async function preparationHarness(t: TestContext, phase?: 'hooks' | 'proxy') {
  const dir = await tempDir('ae-prep-')
  const entered = preparationGate()
  const resume = preparationGate()
  const spawned = preparationGate()
  const wrote = preparationGate()
  let server: Server | undefined
  let starts = 0
  let alive = 0
  const writes: string[] = []
  const rows =
    (
      JSON.parse(readFileSync(resolve('test/fixtures/claude-composer-2.1.287.json'), 'utf8')) as {
        screens: Record<string, string[]>
      }
    ).screens['manual-idle'] ?? []
  t.mock.method(PtyScreen.prototype, 'rows', async () => ({ lines: rows, typed: rows }))
  t.mock.method(PtyScreen.prototype, 'viewport', async () => rows)
  const pty = createRequire(import.meta.url)('node-pty') as typeof import('node-pty')
  t.mock.method(pty, 'spawn', () => {
    starts += 1
    alive += 1
    spawned.resolve()
    let exit: ((event: { exitCode: number }) => void) | undefined
    let exited = false
    return {
      pid: 999_999_999,
      cols: 100,
      rows: 30,
      process: 'fake-pty',
      handleFlowControl: false,
      write: (data: string) => {
        writes.push(data)
        if (data.includes('\x1b[200~')) wrote.resolve()
      },
      kill: () => {
        if (!exited) {
          exited = true
          alive -= 1
          exit?.({ exitCode: 0 })
        }
      },
      onData: () => ({ dispose() {} }),
      onExit: (callback: (event: { exitCode: number }) => void) => {
        exit = callback
        return { dispose() {} }
      },
      resize() {},
      clear() {},
      pause() {},
      resume() {},
    } as IPty
  })
  if (phase === 'hooks') {
    const start = PtyHookServer.prototype.start
    t.mock.method(PtyHookServer.prototype, 'start', async function (this: PtyHookServer) {
      const port = await start.call(this)
      server = Reflect.get(this, 'server') as Server
      entered.resolve()
      await resume.promise
      return port
    })
  } else if (phase === 'proxy') {
    const start = SsePtyProxy.prototype.start
    t.mock.method(SsePtyProxy.prototype, 'start', async function (this: SsePtyProxy) {
      const port = await start.call(this)
      server = Reflect.get(this, 'server') as Server
      entered.resolve()
      await resume.promise
      return port
    })
  }
  const runtime = new AnyengineRuntime({
    cli: resolve('test/fixtures/fake-claude.mjs'),
    cols: 100,
    rows: 30,
    turnTimeoutMs: 0,
    asyncSubagentTimeoutMs: 0,
    startupTimeoutMs: 30_000,
    streamProxy: phase === 'proxy',
    extraArgs: [],
    hookTimeoutSec: 60,
    autoApproveSafetyPrompts: false,
    keepApiKey: false,
    stateDir: join(dir, 'state'),
    relayScript: resolve('scripts/anyengine-hook-relay.mjs'),
    nodeBinary: process.execPath,
  })
  return {
    runtime,
    dir,
    entered,
    resume,
    spawned,
    wrote,
    writes,
    get starts() {
      return starts
    },
    get alive() {
      return alive
    },
    get listening() {
      return server?.listening ?? false
    },
  }
}
