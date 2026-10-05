import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
import type { Duplex } from 'node:stream'
import WebSocket from 'ws'
import { type ProcessInfo, realSystem } from './control-system.mjs'
import { joinDetachedGroup } from './smoke-client.mjs'
import { STARTUP_WAIT_MS, selectedCodex } from './startup-compat.mjs'

const require = createRequire(import.meta.url)
const { isolatedCommand } = require('../../scripts/lib/codex-probe.mjs')
const { binaryIdentity } = require('../../scripts/lib/startup-schema.mjs')
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
type Exit = { code: number | null; signal: NodeJS.Signals | null }
const aborted = () => new Error('remote launch aborted')
class OwnedProcess {
  readonly child: ChildProcess
  readonly done: Promise<Exit>
  vendorExit: number | undefined
  private readonly system: ReturnType<typeof realSystem>
  private readonly cohort = new Map<number, ProcessInfo>()
  private readonly groups = new Set<number>()
  private readonly poll: NodeJS.Timeout
  private failure: unknown
  private stopped: Promise<void> | undefined
  private ended = false
  constructor(child: ChildProcess, detached: boolean, env: NodeJS.ProcessEnv) {
    this.child = child
    const system = realSystem(env)
    this.system = realSystem(env, (command, args, options) =>
      system.exec(command, args, { ...options, timeoutMs: 1000 }),
    )
    if (detached && child.pid) this.groups.add(child.pid)
    this.done = new Promise((done) => {
      child.once('error', () => {}) // close is also emitted on spawn failure.
      child.once('close', (code, signal) => {
        this.ended = true
        done({ code, signal })
      })
    })
    this.poll = setInterval(() => this.observe(), 250)
    this.observe()
  }
  private observe(): void {
    if (!this.child.pid) return
    try {
      const procs = this.system.processes()
      const family = procs.filter(
        (p) =>
          (!this.ended && p.pid === this.child.pid && !this.cohort.has(p.pid)) ||
          this.cohort.get(p.pid)?.processStart === p.processStart,
      )
      for (let i = 0; i < family.length; i++) {
        for (const p of procs.filter((p) => p.ppid === family[i]!.pid))
          if (!family.some((known) => known.pid === p.pid)) family.push(p)
        if (family.length > 128) throw new Error('remote process family exceeds bound')
      }
      for (const p of family) this.cohort.set(p.pid, p)
      if (family.length) {
        const result = this.system.exec('/bin/ps', [
          '-o',
          'pid=,pgid=',
          '-p',
          family.map((p) => p.pid).join(','),
        ])
        if (
          result.status !== 0 &&
          this.system
            .processes()
            .some((p) => family.some((f) => p.pid === f.pid && p.processStart === f.processStart))
        )
          throw new Error('remote group observation unavailable')
        for (const row of result.stdout.trim().split('\n')) {
          const group = Number(row.trim().split(/\s+/)[1])
          if (family.some((p) => p.pid === group)) this.groups.add(group)
        }
      }
    } catch (error) {
      this.failure = error
    }
  }
  admitGroup(pid: number): void {
    const p = this.system.processes().find((p) => p.pid === pid && p.ppid === this.child.pid)
    const group = this.system.exec('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {
      timeoutMs: 1000,
    })
    if (!p || !p.processStart || group.status !== 0 || Number(group.stdout.trim()) !== pid)
      throw new Error('remote CLI group ownership unavailable')
    this.cohort.set(pid, p)
    this.groups.add(pid)
  }
  signal(value: NodeJS.Signals): void {
    this.observe()
    if (!this.groups.size && !this.ended) this.child.kill(value)
    for (const group of this.groups) {
      try {
        process.kill(-group, value)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.failure = error
      }
    }
    try {
      for (const p of this.system.processes()) {
        if (p.pid === this.child.pid || this.cohort.get(p.pid)?.processStart !== p.processStart)
          continue
        try {
          process.kill(p.pid, value)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    } catch (error) {
      this.failure = error
    }
  }
  close(): Promise<void> {
    return (this.stopped ??= this.stop())
  }
  private async stop(): Promise<void> {
    clearInterval(this.poll)
    this.signal('SIGTERM')
    let killError: unknown
    const timer = setTimeout(() => {
      try {
        this.signal('SIGKILL')
        if (!this.ended) this.child.kill('SIGKILL')
      } catch (error) {
        killError = error
      }
    }, 2000)
    try {
      await this.done
      for (const group of this.groups) await joinDetachedGroup(group, true)
      this.signal('SIGKILL')
      for (let i = 0; i < 250; i++) {
        const live = this.system
          .processes()
          .some((p) => this.cohort.get(p.pid)?.processStart === p.processStart)
        if (!live) {
          if (killError || this.failure)
            throw new Error('remote family observation/cleanup unknown')
          return
        }
        await new Promise((done) => setTimeout(done, 20))
      }
      throw new Error('remote owned family remains alive')
    } finally {
      clearTimeout(timer)
    }
  }
}
// Same-session job control; fd4 gates exec. Stopped Bash jobs end without replay.
const guardian = `exec 2>/dev/null
set -m
( IFS= read -r permission <&4
  [[ "$permission" = go ]] || exit 125
  exec 3>&- 4<&- 5>&-
  exec "$@"
) <&0 >&1 2>&5 &
vendor=$!
printf 'child %s\\n' "$vendor" >&3
if [[ -t 0 ]]; then fg %1 >/dev/null 2>/dev/null; else wait "$vendor"; fi
code=$?
if kill -0 "$vendor" 2>/dev/null; then exit 1; fi
printf 'exit %s\\n' "$code" >&3
exit "$code"
`
export async function startRemoteCli(
  codex: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  recheck: () => void,
  signal: AbortSignal,
): Promise<OwnedProcess> {
  const system = realSystem(env)
  const child = spawn(
    '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-p',
      ...(process.stdin.isTTY ? ['-i'] : []),
      '-m',
      '-c',
      guardian,
      'anyengine-codex',
      codex,
      ...args,
    ],
    {
      env,
      stdio: ['inherit', 'inherit', process.stdin.isTTY ? 0 : 'ignore', 'pipe', 'pipe', 2],
    },
  )
  const owned = new OwnedProcess(child, false, env)
  const notice = child.stdio[3] as Duplex
  const gate = child.stdio[4] as Duplex
  gate.on('error', () => {})
  let timer: NodeJS.Timeout | undefined
  let abort = () => {}
  let receive = (_bytes: Buffer) => {}
  try {
    await new Promise<void>((done, fail) => {
      let buffer = ''
      abort = () => fail(aborted())
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => fail(new Error('remote CLI ownership timed out')), 3000)
      receive = (bytes) => {
        buffer += bytes.toString('utf8')
        if (buffer.length > 64) return fail(new Error('remote CLI ownership invalid'))
        if (!buffer.includes('\n')) return
        try {
          const match = /^child ([1-9]\d*)\n$/.exec(buffer)
          if (!match) throw new Error('remote CLI ownership invalid')
          const pid = Number(match[1])
          owned.admitGroup(pid)
          recheck()
          if (signal.aborted) throw aborted()
          let result = ''
          const terminal = (bytes: Buffer) => {
            result += bytes.toString('utf8')
            const match = /^exit (0|[1-9]\d{0,2})\n$/.exec(result)
            if (match && Number(match[1]) <= 255) {
              try {
                const absent = system.exec('/bin/ps', ['-o', 'pid=', '-p', String(pid)], {
                  timeoutMs: 1000,
                })
                if (absent.status === 1 && !absent.stdout.trim() && !absent.stderr.trim())
                  owned.vendorExit = Number(match[1])
              } catch {}
            } else if (result.length > 16 || result.includes('\n'))
              notice.removeListener('data', terminal)
          }
          notice.on('data', terminal)
          void owned.done.then(() => notice.removeListener('data', terminal))
          gate.end('go\n')
          done()
        } catch (error) {
          fail(error)
        }
      }
      notice.on('data', receive)
      void owned.done.then(() => fail(new Error('remote CLI closed before admission')))
      if (signal.aborted) abort()
    })
    return owned
  } catch (error) {
    gate.end()
    await owned.close()
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    notice.removeListener('data', receive)
    notice.resume()
  }
}
export interface RemoteLaunch {
  url: string
  token: string
  adapter: ChildProcess
  closed: Promise<Exit>
  close(): Promise<void>
}
class RemoteStartupFailure extends Error {
  readonly code: string
  readonly codexPath: string | null
  constructor(code: string, codexPath: string | null) {
    super(`private adapter startup refused (${code}); direct CLI required`)
    this.code = code
    this.codexPath = codexPath
  }
}
export function codexRemoteArgs(url: string, userArgs: string[]): string[] {
  const options = userArgs.slice(0, userArgs.includes('--') ? userArgs.indexOf('--') : undefined)
  if (options.some((arg) => /^--remote(?:=|$)|^--remote-auth-token-env(?:=|$)/.test(arg)))
    throw new Error('remote URL and bearer options are reserved by anyengine codex')
  return ['--remote', url, '--remote-auth-token-env', 'ANYENGINE_REMOTE_TOKEN', ...userArgs]
}
async function connected(
  url: string,
  token: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
    handshakeTimeout: Math.max(1, Math.min(2000, timeoutMs)),
  })
  const abort = () => ws.terminate()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await new Promise<void>((done, fail) => {
      ws.once('open', done)
      ws.once('error', () => fail(new Error('private adapter authentication/connect failed')))
      ws.once('close', () => fail(new Error('private adapter connection closed')))
      if (signal?.aborted) abort()
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    const closed = new Promise<void>((done) => {
      if (ws.readyState === WebSocket.CLOSED) done()
      else ws.once('close', () => done())
    })
    ws.terminate()
    await closed
  }
}
export async function startRemoteAdapter(
  adapterPath: string,
  env: NodeJS.ProcessEnv,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RemoteLaunch> {
  const deadline = Date.now() + Math.min(options.timeoutMs ?? STARTUP_WAIT_MS, STARTUP_WAIT_MS)
  realSystem(env)
  if (options.signal?.aborted) throw aborted()
  const token = randomBytes(32).toString('hex')
  const adapter = spawn(
    process.execPath,
    [adapterPath, 'app-server', '--listen', 'ws://127.0.0.1:0'],
    {
      env: { ...env, ANYENGINE_WS_TOKEN: token },
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    },
  )
  const owned = new OwnedProcess(adapter, true, env)
  let buffer = ''
  let diagnostic: { code: string; codexPath: string | null } | undefined
  let timer: NodeJS.Timeout | undefined
  let receive = (_chunk: Buffer) => {}
  let abort = () => {}
  try {
    const url = await new Promise<string>((done, fail) => {
      abort = () => fail(aborted())
      options.signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(
        () => fail(new Error('private adapter startup timed out')),
        Math.max(1, deadline - Date.now()),
      )
      receive = (chunk) => {
        buffer += chunk.toString('utf8')
        if (buffer.length > 16_384) {
          buffer = ''
          fail(new Error('private adapter startup stderr exceeds bound'))
          return
        }
        for (;;) {
          const end = buffer.indexOf('\n')
          if (end < 0) return
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          const ready = /^\[anyengine\] listening on (ws:\/\/127\.0\.0\.1:([1-9]\d{0,4}))$/.exec(
            line,
          )
          if (ready && Number(ready[2]) <= 65535) done(ready[1]!)
          if (!line.startsWith('[anyengine] {')) continue
          try {
            const value = JSON.parse(line.slice('[anyengine] '.length))
            if (
              value.kind === 'anyengine-startup-failure' &&
              value.pid === adapter.pid &&
              value.fallback === 'direct-cli-required' &&
              ['schema-admission', 'selected-binary-changed'].includes(value.code) &&
              (value.codexPath === null || typeof value.codexPath === 'string')
            )
              diagnostic = { code: value.code, codexPath: value.codexPath }
          } catch {}
        }
      }
      adapter.stderr!.on('data', receive)
      void owned.done.then(({ code }) =>
        fail(
          code === 78 && diagnostic
            ? new RemoteStartupFailure(diagnostic.code, diagnostic.codexPath)
            : new Error('private adapter closed before startup completed'),
        ),
      )
      if (options.signal?.aborted) abort()
    })
    await connected(url, token, deadline - Date.now(), options.signal)
    if (Date.now() >= deadline || options.signal?.aborted) throw aborted()
    return { url, token, adapter, closed: owned.done, close: () => owned.close() }
  } catch (error) {
    await owned.close()
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    adapter.stderr?.removeListener('data', receive)
    adapter.stderr?.resume() // Runtime output is drained, never retained or copied into errors.
  }
}
function capability(codex: string, env: NodeJS.ProcessEnv): string {
  const stamp = binaryIdentity(codex)
  const version = isolatedCommand(codex, ['--version'], { timeoutMs: 2000, env })
  const help = isolatedCommand(codex, ['--help'], { timeoutMs: 5000, env })
  if (
    version.status !== 0 ||
    !/^codex-cli\s+\d+\.\d+\.\d+\S*\s*$/m.test(version.stdout) ||
    help.status !== 0 ||
    !/(?:^|\s)--remote-auth-token-env(?:[\s=]|$)/m.test(help.stdout) ||
    !/(?:^|\s)--remote(?:[\s=]|$)/m.test(help.stdout)
  )
    throw new Error(
      'Codex remote bearer support unavailable; vendor CLI drift, private host refused',
    )
  if (binaryIdentity(codex) !== stamp) throw new Error('selected Codex changed during help probe')
  return stamp
}
export async function runCodexRemote(
  args: string[],
  options: { adapterPath: string; codex: string | null; env: NodeJS.ProcessEnv },
): Promise<number> {
  const env = { ...options.env, ...(options.codex ? { ANYENGINE_REAL_CODEX: options.codex } : {}) }
  const abort = new AbortController()
  let signal: NodeJS.Signals | null = null
  let launch: RemoteLaunch | undefined
  let cli: OwnedProcess | undefined
  let exitCode = 1
  const handlers = signals.map((value) => () => {
    signal ??= value
    cli?.signal(value)
    abort.abort()
  })
  signals.forEach((value, i) => {
    process.on(value, handlers[i]!)
  })
  try {
    codexRemoteArgs('ws://127.0.0.1:1', args)
    const codex = selectedCodex(env)
    if (!codex) throw new Error('selected vendor Codex executable unavailable')
    const stamp = capability(codex, env)
    const recheck = () => {
      if (selectedCodex(env) !== codex || binaryIdentity(codex) !== stamp)
        throw new Error('selected Codex identity changed; launch refused')
      if (abort.signal.aborted) throw aborted()
    }
    recheck()
    try {
      launch = await startRemoteAdapter(options.adapterPath, env, { signal: abort.signal })
    } catch (error) {
      if (
        !(error instanceof RemoteStartupFailure) ||
        error.code === 'selected-binary-changed' ||
        error.codexPath !== codex
      )
        throw error
      recheck()
      process.stderr.write(
        'anyengine codex: adapter schema admission failed; running the selected vendor CLI directly\n',
      )
    }
    recheck()
    cli = await startRemoteCli(
      codex,
      launch ? codexRemoteArgs(launch.url, args) : args,
      launch ? { ...env, ANYENGINE_REMOTE_TOKEN: launch.token } : env,
      recheck,
      abort.signal,
    )
    const stopped = new Promise<Exit>((done) => {
      const stop = () => done({ code: 1, signal })
      abort.signal.addEventListener('abort', stop, { once: true })
      void cli!.done.finally(() => abort.signal.removeEventListener('abort', stop))
      if (abort.signal.aborted) stop()
    })
    const result = await Promise.race([
      cli.done,
      stopped,
      ...(launch ? [launch.closed.then(() => ({ code: 1, signal: null }))] : []),
    ])
    exitCode = result.signal ? 128 + constants.signals[result.signal] : (result.code ?? 1)
    if (!signal && cli.vendorExit !== result.code) {
      process.stderr.write(
        'anyengine codex: CLI host ended without a confirmed vendor exit; suspend/resume is unsupported\n',
      )
      exitCode = 1
    }
  } catch (error) {
    process.stderr.write(
      `anyengine codex: ${error instanceof Error ? error.message : 'launch failed'}\n`,
    )
    exitCode = signal ? 128 + constants.signals[signal] : 1
  } finally {
    try {
      const results = await Promise.allSettled([cli?.close(), launch?.close()])
      if (results.some((result) => result.status === 'rejected')) {
        process.stderr.write('anyengine codex: owned cleanup incomplete\n')
        exitCode = 1
      }
    } finally {
      signals.forEach((value, i) => {
        process.removeListener(value, handlers[i]!)
      })
    }
  }
  return exitCode
}
