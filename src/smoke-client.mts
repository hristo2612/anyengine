import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

import { createRouterLog, type RouterLog } from './router-log.mjs'
import type { PathContext } from './smoke.mjs'
import type { TerminalWork } from './smoke-evidence.mjs'

type Message = Record<string, any>
export interface SmokeTurn {
  threadId: string
  turnId: string
  status: string
  error: unknown
  text: string
  items: Message[]
  completedAt: string
}
export function successfulTurn(turn: SmokeTurn): boolean {
  return (
    turn.status === 'completed' &&
    turn.error == null &&
    turn.items.some(
      (item) =>
        item.type === 'agentMessage' && typeof item.text === 'string' && item.text.length > 0,
    )
  )
}
export function successfulPong(turn: SmokeTurn): boolean {
  return successfulTurn(turn) && /\bPONG\b/.test(turn.text)
}
export async function joinDetachedGroup(pid: number, kill = false): Promise<void> {
  if (!(pid > 0)) return
  for (let attempt = 0; ; attempt++) {
    try {
      process.kill(-pid, kill && attempt === 0 ? 'SIGKILL' : 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
    if (attempt >= 250) throw new Error('smoke owned process group remains alive')
    await new Promise((done) => setTimeout(done, 20))
  }
}

/** A single owned stdio process. Subscribers are armed before requests are written. */
export class AppServerClient {
  readonly child: ChildProcessWithoutNullStreams
  readonly pid: number
  private buffer = Buffer.alloc(0)
  private readonly pending = new Map<
    number,
    { resolve: (message: Message) => void; reject: (error: Error) => void }
  >()
  private readonly subscribers = new Set<(message: Message) => void>()
  private readonly replyObservers = new Map<number, (message: Message) => void>()
  private readonly closed: Promise<void>
  private sequence = 0
  private failure: Error | null = null
  private closing: Promise<void> | null = null

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child
    this.pid = child.pid ?? 0
    child.stdout.on('data', (bytes: Buffer) => this.input(bytes))
    child.stderr.resume()
    child.stdin.on('error', (error) => this.fail(error))
    child.on('error', (error) => this.fail(error))
    this.closed = new Promise((resolve) =>
      child.once('close', () => {
        this.fail(new Error('smoke app-server closed'))
        resolve()
      }),
    )
  }

  static launch(command: string, args: string[], env: NodeJS.ProcessEnv): AppServerClient {
    return new AppServerClient(spawn(command, args, { env, stdio: 'pipe', detached: true }))
  }

  private fail(error: Error): void {
    this.failure ??= error
    for (const request of this.pending.values()) request.reject(this.failure)
    this.pending.clear()
    this.replyObservers.clear()
    for (const listener of this.subscribers) listener({ closed: this.failure })
    this.subscribers.clear()
  }

  private input(bytes: Buffer): void {
    if (this.failure) return
    this.buffer = Buffer.concat([this.buffer, bytes])
    try {
      for (;;) {
        const end = this.buffer.indexOf(10)
        if ((end < 0 ? this.buffer.length : end) > 4 * 1024 * 1024)
          throw new Error('smoke message exceeds limit')
        if (end < 0) break
        const line = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, end))
        this.buffer = this.buffer.subarray(end + 1)
        this.receive(line)
        if (this.failure) break
      }
    } catch (error) {
      this.buffer = Buffer.alloc(0)
      this.fail(error as Error)
    }
  }

  private receive(line: string): void {
    try {
      if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error('smoke message exceeds limit')
      const message = JSON.parse(line) as Message
      if (!message || typeof message !== 'object' || Array.isArray(message))
        throw new Error('invalid smoke message')
      if (!message.method) this.replyObservers.get(message.id)?.(message)
      const request = this.pending.get(message.id)
      if (request) {
        this.pending.delete(message.id)
        if (message.error)
          request.reject(new Error(String(message.error.message ?? 'app-server error')))
        else request.resolve(message.result)
      } else if (message.method && message.id != null) {
        // Smoke prompts require no privileged approvals. Refuse an unexpected request.
        this.child.stdin.write(
          `${JSON.stringify({ id: message.id, error: { code: -32601, message: 'smoke does not approve requests' } })}\n`,
        )
      } else {
        for (const listener of this.subscribers) listener(message)
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('invalid smoke message'))
    }
  }

  request(
    method: string,
    params: unknown,
    timeoutMs = 30_000,
    observeReply?: (message: Message) => void,
  ): Promise<Message> {
    if (this.failure || this.closing)
      return Promise.reject(this.failure ?? new Error('smoke client closed'))
    if (observeReply && this.replyObservers.size >= 16)
      return Promise.reject(new Error('smoke reply observer bound exceeded'))
    const id = ++this.sequence
    // Waiter timeout does not settle a thread creation; keep exact replies until closure.
    if (observeReply) this.replyObservers.set(id, observeReply)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`smoke request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) {
          this.pending.get(id)?.reject(error)
          this.pending.delete(id)
        }
      })
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'anyengine-smoke', version: '1' },
      capabilities: { experimentalApi: true },
    })
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
  }

  onNotification(listener: (message: Message) => void): () => void {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  waitFor(match: (message: Message) => boolean, timeoutMs = 30_000): Promise<Message> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const done = (error: Error | null, message?: Message) => {
        clearTimeout(timer)
        this.subscribers.delete(listener)
        if (error) reject(error)
        else resolve(message!)
      }
      const listener = (message: Message) => {
        if (message.closed) done(message.closed)
        else if (match(message)) done(null, message)
      }
      const timer = setTimeout(() => done(new Error('smoke notification timed out')), timeoutMs)
      this.subscribers.add(listener)
    })
  }

  async turn(
    threadId: string,
    text: string,
    timeoutMs = 120_000,
    model?: string,
  ): Promise<SmokeTurn> {
    const messages: Message[] = []
    let turnId = ''
    const deadline = Date.now() + timeoutMs
    let wake: (() => void) | null = null
    let overflow = false
    const listener = (message: Message) => {
      if (messages.length >= 4096) overflow = true
      else messages.push(message)
      wake?.()
    }
    this.subscribers.add(listener)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const started = await this.request(
        'turn/start',
        {
          threadId,
          input: [{ type: 'text', text }],
          effort: 'low',
          ...(model ? { model } : {}),
        },
        timeoutMs,
      )
      if (typeof started.turn?.id !== 'string' || !started.turn.id)
        throw new Error('smoke turn has no identity')
      turnId = started.turn.id
      const terminal = () =>
        messages.find(
          (message) =>
            message.method === 'turn/completed' &&
            message.params?.threadId === threadId &&
            message.params?.turn?.id === turnId,
        )
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (overflow) reject(new Error('smoke turn exceeds notification limit'))
          else if (this.failure) reject(this.failure)
          else if (terminal()) resolve()
        }
        timer = setTimeout(
          () => reject(new Error('smoke turn timed out')),
          Math.max(1, deadline - Date.now()),
        )
        wake = check
        check()
      })
      const finished = terminal()!.params.turn
      const items = messages
        .filter(
          (message) =>
            message.method === 'item/completed' &&
            message.params?.threadId === threadId &&
            message.params?.turnId === turnId,
        )
        .map((message) => message.params.item)
      return {
        threadId,
        turnId,
        status: finished.status,
        error: finished.error,
        text: items
          .filter((item) => item?.type === 'agentMessage' && typeof item.text === 'string')
          .map((item) => item.text)
          .join('\n'),
        items,
        completedAt: new Date().toISOString(),
      }
    } finally {
      clearTimeout(timer)
      this.subscribers.delete(listener)
    }
  }

  async terminal(
    threadId: string,
    turnId: string,
    model: string,
    cwd: string,
    parent?: string,
    persisted = false,
  ): Promise<TerminalWork & { pong: boolean }> {
    const value = await this.request('thread/read', { threadId, includeTurns: true })
    const thread = value.thread
    // Local reads omit model; callers bind selection through start/spawn/runtime evidence.
    if (
      thread?.id !== threadId ||
      (Object.hasOwn(thread, 'model') && thread.model !== model) ||
      thread.cwd !== cwd ||
      (persisted && thread.ephemeral !== false) ||
      (parent &&
        thread.parentThreadId !== parent &&
        thread.source?.subAgent?.thread_spawn?.parent_thread_id !== parent &&
        thread.source?.subagent?.thread_spawn?.parent_thread_id !== parent) ||
      !Array.isArray(thread.turns)
    )
      throw new Error('terminal thread/model/cwd/parent identity mismatch')
    const matches = thread.turns.filter((turn: any) => turn.id === turnId)
    if (matches.length !== 1) throw new Error('expected one correlated terminal turn')
    const turn = matches[0]
    const work: SmokeTurn = {
      threadId,
      turnId,
      status: turn.status,
      error: turn.error,
      text: Array.isArray(turn.items)
        ? turn.items
            .filter((item: any) => item.type === 'agentMessage')
            .map((item: any) => item.text)
            .join('\n')
        : '',
      items: turn.items ?? [],
      completedAt: new Date().toISOString(),
    }
    return {
      threadId,
      turnId,
      model,
      status: work.status,
      success: successfulPong(work),
      pong: successfulPong(work),
    }
  }

  async releaseThread(threadId: string, persisted: boolean): Promise<void> {
    const released = await this.request('thread/unsubscribe', { threadId })
    if (!['unsubscribed', 'notSubscribed', 'notLoaded'].includes(released.status))
      throw new Error('thread unsubscribe not acknowledged')
    if (!persisted) return
    const gone = this.waitFor(
      (message) => message.method === 'thread/deleted' && message.params?.threadId === threadId,
    )
    const acknowledged = this.request('thread/delete', { threadId }).then((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length)
        throw new Error('thread delete acknowledgment is not an empty object')
    })
    await Promise.all([acknowledged, gone])
  }

  close(): Promise<void> {
    this.closing ??= this.stop()
    return this.closing
  }

  private async stop(): Promise<void> {
    this.fail(new Error('smoke client closed'))
    this.child.stdin.end()
    const signal = (value: NodeJS.Signals) => {
      if (!this.pid) return
      try {
        process.kill(-this.pid, value)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    this.child.kill('SIGTERM')
    let killError: unknown
    let groupUnknown = false
    const timer = setTimeout(() => {
      try {
        if (!groupUnknown) signal('SIGKILL')
      } catch (error) {
        killError = error
      }
    }, 2000)
    try {
      await this.closed
      // Direct-child close is not family close: grandchildren can outlive it.
      for (let attempt = 0; this.pid; attempt++) {
        if (killError) throw killError
        try {
          process.kill(-this.pid, 0)
          groupUnknown = false
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') break
          if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
          groupUnknown = true
        }
        if (attempt >= 250) throw new Error('smoke owned process group remains alive')
        await new Promise((done) => setTimeout(done, 20))
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

export async function responseText(response: Response, limit: number): Promise<string> {
  if (!response.ok || !response.body) throw new Error('smoke HTTP response unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('smoke HTTP response exceeds limit')
      chunks.push(value)
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

export function successfulResponse(response: Record<string, any> | undefined): boolean {
  if (response?.status !== 'completed' || response.error != null || !Array.isArray(response.output))
    return false
  const text = response.output
    .filter((item: any) => item.type === 'message' && item.status === 'completed')
    .flatMap((item: any) => (Array.isArray(item.content) ? item.content : []))
    .filter((part: any) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('\n')
  return /\bPONG\b/.test(text)
}

/** Trusted launch callbacks record cleanup only; they never admit a proof identity. */
export function routerCleanupLog(
  ctx: PathContext,
  path: string,
  events: () => Message[],
): { log: RouterLog; joined(): void } {
  const base = createRouterLog(path)
  const expected: Array<Record<string, unknown>> = []
  const prefix = 'trampoline.group.'
  const records = () => events().filter((e) => e.event.startsWith(prefix))
  const check = () => {
    const actual = records()
    if (
      actual.length !== expected.length ||
      expected.some((e, i) => Object.entries(e).some(([key, value]) => actual[i]?.[key] !== value))
    )
      throw new Error('router family cleanup log missing or changed')
    return actual
  }
  const log: RouterLog = {
    ...base,
    info(event, fields = {}) {
      if (!event.startsWith(prefix)) return base.info(event, fields)
      try {
        ctx.run.pending(ctx.cohort)
        if (expected.length >= 64) throw new Error('router family cleanup limit')
        expected.push({ event, ...fields, attempt: ctx.request.attempt })
        base.info(event, { ...fields, attempt: ctx.request.attempt })
        check()
      } catch (error) {
        ctx.uncertain = true
        throw error
      }
    },
  }
  return {
    log,
    joined() {
      try {
        const actual = check()
        const launches = actual.filter((e) => e.event === `${prefix}launch`)
        if (
          actual.length !== launches.length * 2 ||
          launches.some((start) => {
            const ended = actual.filter(
              (e) => e.event === `${prefix}settled` && e.launchId === start.launchId,
            )
            return (
              typeof start.launchId !== 'string' ||
              !start.launchId ||
              launches.filter((e) => e.launchId === start.launchId).length !== 1 ||
              ended.length !== 1 ||
              ended[0]!.joined !== true ||
              !Number.isSafeInteger(ended[0]!.groupPid) ||
              ended[0]!.groupPid < 0 ||
              ended[0]!.threadId !== start.threadId ||
              ended[0]!.turnId !== start.turnId
            )
          })
        )
          throw new Error('router family cleanup is unknown or not joined')
      } catch (error) {
        ctx.uncertain = true
        throw error
      }
    },
  }
}
