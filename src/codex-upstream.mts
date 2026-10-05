import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import type { ManagedChild, ManagedChildLifecycle } from './accounts-family.mjs'
import { CodexServerRequests } from './codex-server-requests.mjs'
import { CodexUpstreamReserve } from './codex-upstream-reserve.mjs'
import { stopCodexChild } from './codex-upstream-stop.mjs'
import { assertStartupBinary } from './startup-compat.mjs'
import type { JsonRpcId, JsonRpcResponse, RpcPeer, WireMessage } from './types.mjs'
import { debugLog } from './util.mjs'

export { sanitizeRateLimitPayload } from './codex-upstream-reserve.mjs'

export interface CodexUpstreamOptions {
  binary: string
  args: string[]
  env?: NodeJS.ProcessEnv
  onMessage: (message: WireMessage) => void
  onAvailabilityChange?: (available: boolean) => void
  maxRestarts?: number
  processLifecycle?: ManagedChildLifecycle
  onRawMessage?: (method: string, params: unknown, observation?: unknown) => void
  beforeRequest?: (method: string) => unknown
  reserveEnabled?: boolean
  afterInitialize?: (upstream: CodexUpstream) => Promise<void>
  mapDownstreamResult?: (method: string, result: unknown) => unknown
}

export type CodexChildEvent =
  | { type: 'ready'; childId: string; pid: number }
  | { type: 'exit'; childId: string }

interface ChildIdentity {
  child: ChildProcess
  id: string
  handshaken: boolean
  ready: boolean
}

interface PendingUpstream {
  method: string
  peer: RpcPeer | null
  downId: JsonRpcId
  resolve: ((value: unknown) => void) | null
  reject: ((error: Error) => void) | null
  timer: NodeJS.Timeout | null
  observation: unknown
}

export class CodexUpstream {
  readonly binary: string
  readonly args: string[]
  private readonly env: NodeJS.ProcessEnv
  private readonly onMessage: (message: WireMessage) => void
  private readonly onAvailabilityChange: ((available: boolean) => void) | null
  private readonly maxRestarts: number
  private child: ChildProcess | null = null
  private childIdentity: ChildIdentity | null = null
  private readonly childListeners = new Set<(event: CodexChildEvent) => void>()
  private readonly closingChildren = new Map<ChildProcess, Promise<void>>()
  private stopping = false
  private restarts = 0
  private restartTimer: NodeJS.Timeout | null = null
  private nextUpId = 0
  private pending = new Map<string, PendingUpstream>()
  private readonly serverRequests = new CodexServerRequests()
  private initializeParams: unknown = null
  private initializeResult: unknown = null
  private initializedSent = false
  private unavailable = false
  private readonly reserve: CodexUpstreamReserve
  private readonly lifecycle: ManagedChildLifecycle | null
  private readonly raw: CodexUpstreamOptions['onRawMessage']
  private readonly beforeRequest: CodexUpstreamOptions['beforeRequest']
  private readonly afterInitialize: CodexUpstreamOptions['afterInitialize']
  private readonly downstream: CodexUpstreamOptions['mapDownstreamResult']
  private starting: Promise<void> | null = null

  constructor(options: CodexUpstreamOptions) {
    this.binary = options.binary
    this.args = options.args
    this.env = options.env ?? process.env
    this.onMessage = options.onMessage
    this.onAvailabilityChange = options.onAvailabilityChange ?? null
    this.maxRestarts = options.maxRestarts ?? 3
    this.lifecycle = options.processLifecycle ?? null
    this.raw = options.onRawMessage
    this.beforeRequest = options.beforeRequest
    this.afterInitialize = options.afterInitialize
    this.downstream = options.mapDownstreamResult
    this.reserve = new CodexUpstreamReserve(
      {
        request: (method, params, timeoutMs) => this.request(method, params, timeoutMs),
        running: () => this.running,
        stopping: () => this.stopping,
        onMessage: this.onMessage,
      },
      options.reserveEnabled,
    )
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

  onChildLifecycle(listener: (event: CodexChildEvent) => void): () => void {
    this.childListeners.add(listener)
    return () => {
      this.childListeners.delete(listener)
    }
  }

  async requestForChild(
    childId: string,
    method: string,
    params: unknown,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    this.requireChild(childId)
    const result = await this.request(method, params, timeoutMs)
    this.requireChild(childId)
    return result
  }

  start(): void {
    if (this.child || this.starting || this.stopping || this.unavailable) return
    assertStartupBinary(this.binary)
    const [command, prefixArgs] = spawnCommandFor(this.binary)
    const args = [...prefixArgs, ...this.args]
    if (this.lifecycle) {
      this.starting = this.lifecycle
        .spawn(command, args, this.env)
        .then(async (child) => {
          if (this.stopping) await this.lifecycle?.stop(child)
          else this.attachChild(child)
        })
        .catch((error: Error) => this.markUnavailable(error.message))
        .finally(() => {
          this.starting = null
        })
      return
    }
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
    this.attachChild(child)
  }
  private attachChild(child: ChildProcess): void {
    this.child = child
    this.childIdentity = { child, id: randomUUID(), handshaken: false, ready: false }
    this.initializedSent = false
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    this.closingChildren.set(child, closed)
    void closed.then(() => {
      this.closingChildren.delete(child)
    })
    debugLog('codex.upstream.spawn', {
      pid: (child as ManagedChild).nativePid ?? child.pid ?? null,
      supervisor: (child as ManagedChild).nativePid ? child.pid : null,
      binary: this.binary,
      args: this.args,
    })
    child.once('error', (error) => {
      if (this.child !== child) return
      debugLog('codex.upstream.spawnError', { message: error.message })
      this.child = null
      this.exitChild(child)
      this.markUnavailable(error.message)
      this.failPending(`codex upstream failed to start: ${error.message}`)
    })
    const rl = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream })
    rl.on('line', (line) => {
      if (this.child !== child) return
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
      if (this.child !== child) return
      this.child = null
      this.exitChild(child)
      this.failPending('codex upstream exited')
      if (this.stopping) return
      this.scheduleRestart()
    })
  }

  // Replays the cached desktop handshake after a respawn.
  async initialize(params: unknown, timeoutMs = 30_000): Promise<unknown> {
    this.initializeParams = params
    if (this.starting) await this.starting
    const identity = this.childIdentity
    const result = await this.request('initialize', params, timeoutMs)
    if (!identity || identity !== this.childIdentity)
      throw new Error('codex upstream child changed during initialize')
    identity.handshaken = true
    this.initializeResult = result
    await this.afterInitialize?.(this)
    await this.reserve.start()
    if (identity !== this.childIdentity)
      throw new Error('codex upstream child changed during initialize')
    return result
  }

  get reserveLimited(): boolean {
    return this.reserve.limited
  }

  markInitialized(): void {
    const identity = this.childIdentity
    if (this.initializedSent || !identity?.handshaken || !this.running || !identity.child.pid)
      return
    if (!this.write({ jsonrpc: '2.0', method: 'initialized', params: {} })) return
    this.initializedSent = true
    identity.ready = true
    this.emitChild({ type: 'ready', childId: identity.id, pid: identity.child.pid })
  }

  request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (this.starting) return this.starting.then(() => this.request(method, params, timeoutMs))
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
      const observation = this.beforeRequest?.(method)
      this.pending.set(upId, {
        method,
        peer: null,
        downId: null,
        resolve,
        reject,
        timer,
        observation,
      })
      this.write({ jsonrpc: '2.0', id: upId, method, params })
    })
  }

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
    const observation = this.beforeRequest?.(method)
    this.pending.set(upId, {
      method,
      peer,
      downId,
      resolve: null,
      reject: null,
      timer: null,
      observation,
    })
    debugLog('codex.upstream.forward', { method, downId, upId, peerId: peer.id })
    this.write({ jsonrpc: '2.0', id: upId, method, params })
  }

  notify(method: string, params: unknown): void {
    if (!this.running) return
    this.write({ jsonrpc: '2.0', method, params })
  }

  forwardClientResponse(response: JsonRpcResponse): boolean {
    return this.serverRequests.answer(response, (translated) => {
      this.write(translated)
    })
  }

  translateResolvedRequestId(upId: JsonRpcId): JsonRpcId | null {
    return this.serverRequests.resolved(upId)
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.starting) await this.starting
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.reserve.stop()
    const child = this.child
    if (child) this.exitChild(child)
    this.child = null
    this.failPending('adapter shutting down')
    if (child) await stopCodexChild(child, this.closingChildren.get(child), this.lifecycle)
    await this.lifecycle?.stopAll?.()
    await Promise.all(this.closingChildren.values())
  }

  async restartForAccounts(): Promise<void> {
    if (!this.stopping) throw new Error('Account restart requires a stopped child')
    this.stopping = false
    this.unavailable = false
    this.restarts = 0
    this.start()
    if (this.initializeParams != null) {
      await this.initialize(this.initializeParams)
      this.markInitialized()
    }
  }

  private handleChildMessage(message: WireMessage): void {
    if ('method' in message && message.method) {
      if ('params' in message) this.raw?.(message.method, message.params)
      const outgoing = this.reserve.notification(message)
      this.onMessage(
        this.downstream && 'params' in outgoing
          ? { ...outgoing, params: this.downstream(message.method, outgoing.params) }
          : outgoing,
      )
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
      if (!response.error) this.raw?.(entry.method, response.result, entry.observation)
      if (entry.peer) {
        const forwarded: JsonRpcResponse = { jsonrpc: '2.0', id: entry.downId }
        if (response.error) forwarded.error = response.error
        else {
          const result = this.reserve.transformResult(entry.method, response.result ?? null)
          forwarded.result = this.downstream?.(entry.method, result) ?? result
        }
        debugLog('codex.upstream.response', {
          method: entry.method,
          downId: entry.downId,
          upId: response.id,
          ok: !response.error,
        })
        entry.peer.send(forwarded)
        return
      }
      if (response.error)
        entry.reject?.(
          Object.assign(new Error(response.error.message), { rpcError: response.error }),
        )
      else entry.resolve?.(response.result)
    }
  }

  rewriteServerRequestId(upId: JsonRpcId, peer: RpcPeer): string {
    return this.serverRequests.rewrite(upId, peer)
  }
  private allocateUpId(): string {
    return `u${++this.nextUpId}`
  }

  private write(message: WireMessage): boolean {
    const stdin = this.child?.stdin
    if (!stdin?.writable) return false
    try {
      stdin.write(`${JSON.stringify(message)}\n`)
      return true
    } catch (error) {
      debugLog('codex.upstream.writeError', {
        message: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  private requireChild(childId: string): void {
    if (
      !this.childIdentity?.ready ||
      this.childIdentity.id !== childId ||
      !this.running ||
      this.child?.signalCode != null
    )
      throw new Error('codex upstream child is no longer ready')
  }

  private exitChild(child: ChildProcess): void {
    if (this.childIdentity?.child !== child) return
    const childId = this.childIdentity.id
    this.childIdentity = null
    this.emitChild({ type: 'exit', childId })
  }

  private emitChild(event: CodexChildEvent): void {
    for (const listener of this.childListeners) {
      try {
        listener(event)
      } catch {
        debugLog('codex.upstream.lifecycleListenerFailed', { type: event.type })
      }
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
      this.start()
      if (this.initializeParams != null) {
        void this.initialize(this.initializeParams)
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
    process.stderr.write(`[anyengine] codex upstream unavailable: ${reason}\n`)
    this.onAvailabilityChange?.(false)
  }
}

// Tests point ANYENGINE_REAL_CODEX at a node script; a real install points
// at the bundled Mach-O binary. Both spawn the same way from here on.
function spawnCommandFor(binary: string): [string, string[]] {
  if (/\.(mjs|cjs|js)$/.test(binary)) return [process.execPath, [binary]]
  return [binary, []]
}
