import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import readline from 'node:readline'
import type { JsonRpcId, JsonRpcResponse, RpcPeer, WireMessage } from './types.mjs'
import { debugLog, sleep } from './util.mjs'

// The REAL `codex app-server` child behind the native-codex multiplexer. One
// child per adapter process, JSON-RPC over the child's stdio, spawned with the
// exact argv the desktop handed the shim (leading `-c` globals + `app-server`
// + the desktop's flags) and the inherited environment, so the child sees the
// same `CODEX_APP_TOOLS_PIPE_PATH`, `mcp_servers.codex_app` override and
// ChatGPT login the desktop's private server would have.
//
// Two request-id spaces meet here:
// - downstream -> upstream: the desktop's id is replaced by `u<n>`; the table
//   remembers the peer and original id so the child's response can be sent
//   back verbatim under the desktop's id.
// - upstream -> downstream (server requests such as approvals): the child's id
//   is replaced by `s<n>`; the desktop's answer is translated back.
// Ids are never forwarded raw, so a desktop request id and a child server
// request id can collide without ambiguity.

export interface CodexUpstreamOptions {
  binary: string
  args: string[]
  env?: NodeJS.ProcessEnv
  onMessage: (message: WireMessage) => void
  onAvailabilityChange?: (available: boolean) => void
  maxRestarts?: number
}

interface PendingUpstream {
  method: string
  peer: RpcPeer | null
  downId: JsonRpcId
  resolve: ((value: unknown) => void) | null
  reject: ((error: Error) => void) | null
  timer: NodeJS.Timeout | null
}

interface PendingServerRequest {
  upId: JsonRpcId
  peer: RpcPeer
  // The desktop already answered; the entry is kept only so the child's
  // trailing `serverRequest/resolved` can still be rewritten.
  answered: boolean
}

// Upper bound on answered-but-unresolved entries kept for id rewriting.
const ANSWERED_SERVER_REQUEST_CAP = 512

export function resolveNativeCodexBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  // CLAUDE_CODEX_NATIVE_CODEX=0 switches the passthrough off entirely, even
  // when CLAUDE_CODEX_REAL_CODEX names a binary: the SSH/Remote twin runs this
  // way so it never carries the account's rate-limit state into the App.
  if ((env.CLAUDE_CODEX_NATIVE_CODEX ?? '').trim() === '0') return null
  const explicit = env.CLAUDE_CODEX_REAL_CODEX?.trim()
  if (explicit) return explicit
  // Auto-detection is off in mock mode (the test suite): a dev machine with
  // the desktop installed must not have its unit tests spawn the real binary.
  if (env.CLAUDE_CODEX_MOCK === '1') return null
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex'
  if (existsSync(bundled)) return bundled
  const real = env.CODEX_REAL?.trim()
  return real || null
}

export class CodexUpstream {
  readonly binary: string
  readonly args: string[]
  private readonly env: NodeJS.ProcessEnv
  private readonly onMessage: (message: WireMessage) => void
  private readonly onAvailabilityChange: ((available: boolean) => void) | null
  private readonly maxRestarts: number
  private child: ChildProcess | null = null
  private stopping = false
  private restarts = 0
  private restartTimer: NodeJS.Timeout | null = null
  private nextUpId = 0
  private nextServerId = 0
  private pending = new Map<string, PendingUpstream>()
  private serverRequests = new Map<string, PendingServerRequest>()
  private initializeParams: unknown = null
  private initializeResult: unknown = null
  private initializedSent = false
  private unavailable = false

  constructor(options: CodexUpstreamOptions) {
    this.binary = options.binary
    this.args = options.args
    this.env = options.env ?? process.env
    this.onMessage = options.onMessage
    this.onAvailabilityChange = options.onAvailabilityChange ?? null
    this.maxRestarts = options.maxRestarts ?? 3
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  get available(): boolean {
    return !this.unavailable && !this.stopping
  }

  get running(): boolean {
    return this.child != null && this.child.exitCode == null
  }

  get cachedInitializeResult(): unknown {
    return this.initializeResult
  }

  start(): void {
    if (this.child || this.stopping || this.unavailable) return
    const [command, prefixArgs] = spawnCommandFor(this.binary)
    const args = [...prefixArgs, ...this.args]
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        env: this.env,
        stdio: ['pipe', 'pipe', 'inherit'],
      })
    } catch (error) {
      this.markUnavailable(error instanceof Error ? error.message : String(error))
      return
    }
    this.child = child
    debugLog('codex.upstream.spawn', { pid: child.pid ?? null, binary: this.binary, args })
    child.once('error', (error) => {
      debugLog('codex.upstream.spawnError', { message: error.message })
      if (this.child === child) this.child = null
      this.markUnavailable(error.message)
      this.failPending(`codex upstream failed to start: ${error.message}`)
    })
    const rl = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let message: WireMessage
      try {
        message = JSON.parse(trimmed) as WireMessage
      } catch {
        debugLog('codex.upstream.badLine', { line: trimmed.slice(0, 200) })
        return
      }
      this.handleChildMessage(message)
    })
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') debugLog('codex.upstream.stdinError', { message: error.message })
    })
    child.once('exit', (code, signal) => {
      debugLog('codex.upstream.exit', { pid: child.pid ?? null, code, signal })
      if (this.child === child) this.child = null
      this.failPending('codex upstream exited')
      if (this.stopping) return
      this.scheduleRestart()
    })
  }

  // Replays the cached desktop `initialize` (and `initialized`) after a
  // respawn so the child accepts thread traffic again without the desktop
  // noticing. Only the first initialize per child reaches the wire; later
  // peers get the cached result.
  async initialize(params: unknown): Promise<unknown> {
    this.initializeParams = params
    const result = await this.request('initialize', params, 30_000)
    this.initializeResult = result
    return result
  }

  markInitialized(): void {
    if (this.initializedSent) return
    this.initializedSent = true
    this.notify('initialized', {})
  }

  request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.running) {
        reject(new Error('codex upstream unavailable'))
        return
      }
      const upId = this.allocateUpId()
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(upId)
              reject(new Error(`codex upstream timed out: ${method}`))
            }, timeoutMs)
          : null
      timer?.unref()
      this.pending.set(upId, { method, peer: null, downId: null, resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id: upId, method, params })
    })
  }

  // Forward a desktop request verbatim; the child's response is written back
  // to `peer` under the desktop's own id.
  forwardRequest(peer: RpcPeer, downId: JsonRpcId, method: string, params: unknown): void {
    if (!this.running) {
      peer.send({
        jsonrpc: '2.0',
        id: downId,
        error: { code: -32000, message: 'codex upstream unavailable' },
      })
      return
    }
    const upId = this.allocateUpId()
    this.pending.set(upId, { method, peer, downId, resolve: null, reject: null, timer: null })
    debugLog('codex.upstream.forward', { method, downId, upId, peerId: peer.id })
    this.write({ jsonrpc: '2.0', id: upId, method, params })
  }

  notify(method: string, params: unknown): void {
    if (!this.running) return
    this.write({ jsonrpc: '2.0', method, params })
  }

  // The desktop answered one of the child's server requests (approval,
  // user input, token refresh). Translate the id back and hand it over.
  forwardClientResponse(response: JsonRpcResponse): boolean {
    const key = String(response.id)
    const entry = this.serverRequests.get(key)
    if (!entry || entry.answered) return false
    entry.answered = true
    this.pruneAnsweredServerRequests()
    debugLog('codex.upstream.serverRequestAnswered', { downId: response.id, upId: entry.upId })
    const translated: JsonRpcResponse = { jsonrpc: '2.0', id: entry.upId }
    if (response.error) translated.error = response.error
    else translated.result = response.result ?? null
    this.write(translated)
    return true
  }

  // `serverRequest/resolved` carries the child's id; the desktop only knows
  // the rewritten one. Also drops the table entry (the request is done).
  translateResolvedRequestId(upId: JsonRpcId): JsonRpcId | null {
    for (const [downId, entry] of this.serverRequests.entries()) {
      if (String(entry.upId) === String(upId)) {
        this.serverRequests.delete(downId)
        return downId
      }
    }
    return null
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    this.child = null
    this.failPending('adapter shutting down')
    if (!child || child.exitCode != null || child.pid == null) return
    const pid = child.pid
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      child.stdin?.end()
    } catch {}
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
    const result = await Promise.race([
      exited.then(() => 'exited'),
      sleep(5_000).then(() => 'timeout'),
    ])
    if (result === 'timeout') {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    debugLog('codex.upstream.stopped', { pid, result })
  }

  private handleChildMessage(message: WireMessage): void {
    if ('method' in message && message.method) {
      // Notification or server request from the child. The mux picks the
      // peer; for server requests it calls rewriteServerRequestId() so the
      // desktop never sees the child's raw id.
      this.onMessage(message)
      return
    }
    if ('id' in message) {
      const response = message as JsonRpcResponse
      const entry = this.pending.get(String(response.id))
      if (!entry) {
        debugLog('codex.upstream.orphanResponse', { id: response.id })
        return
      }
      this.pending.delete(String(response.id))
      if (entry.timer) clearTimeout(entry.timer)
      if (entry.peer) {
        const forwarded: JsonRpcResponse = { jsonrpc: '2.0', id: entry.downId }
        if (response.error) forwarded.error = response.error
        else forwarded.result = response.result ?? null
        debugLog('codex.upstream.response', {
          method: entry.method,
          downId: entry.downId,
          upId: response.id,
          ok: !response.error,
        })
        entry.peer.send(forwarded)
        return
      }
      if (response.error) entry.reject?.(new Error(response.error.message))
      else entry.resolve?.(response.result)
    }
  }

  // Called by the mux once it knows which peer should see a server request.
  // Allocates the downstream-facing id and records the mapping.
  rewriteServerRequestId(upId: JsonRpcId, peer: RpcPeer): string {
    const downId = `s${++this.nextServerId}`
    this.serverRequests.set(downId, { upId, peer, answered: false })
    return downId
  }

  private pruneAnsweredServerRequests(): void {
    let answered = 0
    for (const entry of this.serverRequests.values()) if (entry.answered) answered += 1
    if (answered <= ANSWERED_SERVER_REQUEST_CAP) return
    for (const [downId, entry] of this.serverRequests.entries()) {
      if (!entry.answered) continue
      this.serverRequests.delete(downId)
      answered -= 1
      if (answered <= ANSWERED_SERVER_REQUEST_CAP / 2) break
    }
  }

  private allocateUpId(): string {
    return `u${++this.nextUpId}`
  }

  private write(message: WireMessage): void {
    const stdin = this.child?.stdin
    if (!stdin?.writable) return
    try {
      stdin.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      debugLog('codex.upstream.writeError', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private failPending(message: string): void {
    for (const [upId, entry] of this.pending.entries()) {
      this.pending.delete(upId)
      if (entry.timer) clearTimeout(entry.timer)
      if (entry.peer) {
        entry.peer.send({
          jsonrpc: '2.0',
          id: entry.downId,
          error: { code: -32000, message },
        })
      } else {
        entry.reject?.(new Error(message))
      }
    }
    this.serverRequests.clear()
  }

  private scheduleRestart(): void {
    if (this.restarts >= this.maxRestarts) {
      this.markUnavailable(`codex upstream exited ${this.restarts + 1} times`)
      return
    }
    const delayMs = 1_000 * 2 ** this.restarts
    this.restarts += 1
    debugLog('codex.upstream.restartScheduled', { attempt: this.restarts, delayMs })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      this.initializedSent = false
      this.start()
      if (this.initializeParams != null) {
        void this.request('initialize', this.initializeParams, 30_000)
          .then((result) => {
            this.initializeResult = result
            this.markInitialized()
            debugLog('codex.upstream.reinitialized', { attempt: this.restarts })
          })
          .catch((error) => {
            debugLog('codex.upstream.reinitializeFailed', {
              message: error instanceof Error ? error.message : String(error),
            })
          })
      }
    }, delayMs)
    this.restartTimer.unref()
  }

  private markUnavailable(reason: string): void {
    if (this.unavailable) return
    this.unavailable = true
    debugLog('codex.upstream.unavailable', { reason })
    process.stderr.write(`[claude-codex-adapter] codex upstream unavailable: ${reason}\n`)
    this.onAvailabilityChange?.(false)
  }
}

// Tests point CLAUDE_CODEX_REAL_CODEX at a node script; a real install points
// at the bundled Mach-O binary. Both spawn the same way from here on.
function spawnCommandFor(binary: string): [string, string[]] {
  if (/\.(mjs|cjs|js)$/.test(binary)) return [process.execPath, [binary]]
  return [binary, []]
}
