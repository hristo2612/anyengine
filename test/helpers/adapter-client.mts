import { type ChildProcess, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import readline from 'node:readline'
import { spawn } from './children.mjs'

export type Wire = Record<string, any>

const adapter = resolve('dist/src/adapter.mjs')

// A pinned executable plus its schema fixture works with the isolated probe's
// allowlisted PATH as well as the adapter's app-server child.
export function fakeCodexAt(root: string): string {
  const binary = join(root, 'fake-codex.mjs')
  if (!existsSync(binary)) {
    writeFileSync(
      binary,
      readFileSync(resolve('test/fixtures/fake-codex-app-server.mjs'), 'utf8').replace(
        '#!/usr/bin/env node',
        `#!${process.execPath}`,
      ),
      { mode: 0o755 },
    )
    copyFileSync(resolve('test/fixtures/posture-schema.json'), join(root, 'posture-schema.json'))
    if (execFileSync(binary, ['--version'], { encoding: 'utf8' }) !== 'codex-cli 0.153.4-fake\n')
      throw new Error('fake Codex version unavailable')
  }
  return binary
}

// One stdio adapter and the JSON-RPC traffic it sends, for suites that need
// requests, responses and a wait for a notification.
export class AdapterClient {
  readonly child: ChildProcess
  readonly messages: Wire[] = []
  private waiters: Array<{ match: (m: Wire) => boolean; done: (m: Wire) => void }> = []
  private nextId = 1

  constructor(child: ChildProcess) {
    this.child = child
    const lines = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream })
    lines.on('line', (line) => {
      if (!line.trim()) return
      const message = JSON.parse(line) as Wire
      this.messages.push(message)
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.match(message)) return true
        waiter.done(message)
        return false
      })
    })
  }

  waitFor(match: (m: Wire) => boolean, timeoutMs = 30_000): Promise<Wire> {
    const seen = this.messages.find(match)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for a message')),
        timeoutMs,
      )
      this.waiters.push({
        match,
        done: (message) => {
          clearTimeout(timer)
          resolvePromise(message)
        },
      })
    })
  }

  request(method: string, params: unknown): Promise<Wire> {
    const id = this.nextId++
    const response = this.waitFor((m) => m.id === id && !('method' in m))
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return response
  }

  async close(): Promise<void> {
    if (this.child.exitCode != null) return
    const exited = new Promise((resolveExit) => this.child.once('exit', resolveExit))
    this.child.stdin?.end()
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))])
    if (this.child.exitCode == null) this.child.kill('SIGKILL')
  }
}

export function launchAdapter(env: NodeJS.ProcessEnv): AdapterClient {
  return new AdapterClient(
    spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ANYENGINE_MOCK: '1', NODE_NO_WARNINGS: '1', ...env },
    }),
  )
}
