// Adapter-owned Claude turns on a private socket. Discovery and cleanup have
// deadlines; sessions, callers and buffered output have finite bounds.
import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import net, { type Socket } from 'node:net'
import {
  CLAIM_DISCOVERY_READ_MS,
  type ClaimRequest,
  claimSocketPath,
  onLines,
  writeLine,
} from './claim-protocol.mjs'
import { claimEventsFor, claimTurnContext } from './claim-turn.mjs'
import type { ClaimThread } from './claim-types.mjs'
import { postureSummary } from './posture.mjs'
import type { ClaudeRuntime } from './types.mjs'
import { debugLog, socketPathLimit } from './util.mjs'

export interface ClaimHost {
  claimThread(threadId: string): ClaimThread | null
  waitForClaimThread(threadId: string, ms: number): Promise<ClaimThread | null>
  knowsThread(threadId: string): boolean
  runtime: ClaudeRuntime
  mcpServersFor(threadId: string): unknown
}

export interface ClaimServerOptions {
  runDir: string
  graceMs: number
  idleReleaseMs: number
}

interface Session {
  sessionId: string | null
  busy: boolean
  timer: NodeJS.Timeout | null
  cancel: (() => Promise<void>) | null
}

const SESSION_CAP = 500
const CONNECTION_CAP = 256
const CLEANUP_MS = 5000
const ANSWER_BYTES = 1024 * 1024

function isClaimRequest(
  message: Record<string, unknown>,
): message is ClaimRequest & Record<string, unknown> {
  return (
    message.op === 'claim' &&
    typeof message.threadId === 'string' &&
    !!message.threadId &&
    typeof message.model === 'string' &&
    !!message.model &&
    typeof message.prompt === 'string' &&
    ['parentThreadId', 'turnId', 'cwd', 'effort'].every(
      (key) => message[key] == null || typeof message[key] === 'string',
    )
  )
}

async function bounded(action: () => Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_ok, fail) => {
        timer = setTimeout(() => fail(new Error('claim cleanup timed out')), CLEANUP_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class ClaimServer {
  readonly socketPath: string
  private readonly host: ClaimHost
  private readonly options: ClaimServerOptions
  private readonly sessions = new Map<string, Session>()
  private readonly sockets = new Set<Socket>()
  private readonly releases = new Map<string, Promise<void>>()
  private readonly runs = new Set<Promise<void>>()
  private server: net.Server | null = null
  private stopping = false
  private stoppingPromise: Promise<void> | null = null
  private socketInode: number | null = null

  constructor(host: ClaimHost, options: ClaimServerOptions) {
    this.host = host
    this.options = options
    this.socketPath = claimSocketPath(options.runDir)
  }

  async start(): Promise<string> {
    if (this.server) return this.socketPath
    if (this.stopping) throw new Error('claim server is stopped')
    const bytes = Buffer.byteLength(this.socketPath)
    if (bytes > socketPathLimit())
      throw new Error(
        `claim socket path is ${bytes} bytes, over the ${socketPathLimit()}-byte limit: ${this.socketPath}`,
      )
    mkdirSync(this.options.runDir, { recursive: true, mode: 0o700 })
    const dir = lstatSync(this.options.runDir)
    if (!dir.isDirectory() || (process.getuid && dir.uid !== process.getuid()))
      throw new Error('claim run directory must be an owned directory')
    chmodSync(this.options.runDir, 0o700)
    try {
      lstatSync(this.socketPath)
      throw new Error('claim socket path already exists')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const server = net.createServer((socket) => this.accept(socket))
    this.server = server
    try {
      await new Promise<void>((ok, fail) => {
        server.once('error', fail)
        server.listen(this.socketPath, () => {
          server.off('error', fail)
          ok()
        })
      })
      this.socketInode = lstatSync(this.socketPath).ino
      chmodSync(this.socketPath, 0o600)
      server.on('error', () => {
        void this.stop()
      })
      debugLog('claim.listen', { socketPath: this.socketPath })
      return this.socketPath
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  stop(): Promise<void> {
    if (this.stoppingPromise) return this.stoppingPromise
    this.stopping = true
    this.stoppingPromise = this.close()
    return this.stoppingPromise
  }

  private async close(): Promise<void> {
    const server = this.server
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    const closing = server ? new Promise<void>((ok) => server.close(() => ok())) : Promise.resolve()
    const sessions = [...this.sessions]
    await Promise.all(
      sessions.map(async ([, session]) => {
        if (session.timer) clearTimeout(session.timer)
        await session.cancel?.()
      }),
    )
    // interrupt may race runtime startup; release alone ignores busy PTYs.
    // Wait for runTurn's finally before releasing, with a shutdown deadline.
    try {
      await bounded(() => Promise.allSettled([...this.runs]))
    } catch {
      debugLog('claim.cleanupFailed', { operation: 'settle' })
    }
    const cleanup = sessions.map(([id]) => this.cleanup(id))
    this.sessions.clear()
    await Promise.all([
      closing,
      ...cleanup,
      ...[...this.releases.values()].map((p) => p.catch(() => {})),
    ])
    this.removeSocket()
  }

  private removeSocket(): void {
    if (this.socketInode === null) return
    try {
      if (lstatSync(this.socketPath).ino === this.socketInode) rmSync(this.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        debugLog('claim.cleanupFailed', { operation: 'unlink' })
    }
    this.socketInode = null
  }

  private accept(socket: Socket): void {
    socket.on('error', () => {})
    if (this.stopping || this.sockets.size >= CONNECTION_CAP) {
      socket.end(
        `${JSON.stringify({ type: 'error', message: 'claim server is unavailable' })}\n`,
        () => socket.destroy(),
      )
      return
    }
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    socket.setTimeout(30_000, () => socket.destroy())
    let requested = false
    onLines(socket, (message) => {
      if (requested || this.stopping) return
      requested = true
      socket.setTimeout(0)
      void this.handle(socket, message)
        .catch((error: unknown) => this.fail(socket, error))
        .finally(() => socket.end(() => socket.destroy()))
    })
  }

  private fail(socket: Socket, error: unknown): void {
    try {
      writeLine(socket, {
        type: 'error',
        message: error instanceof Error ? error.message.slice(0, 1000) : 'claim failed',
      })
    } catch {
      socket.destroy()
    }
  }

  private async handle(socket: Socket, message: Record<string, unknown>): Promise<void> {
    if (message.op === 'ping') {
      writeLine(socket, { type: 'pong', pid: process.pid, threads: this.sessions.size })
    } else if (
      message.op === 'owns' &&
      typeof message.threadId === 'string' &&
      (message.as == null || message.as === 'parent' || message.as === 'child')
    ) {
      const found =
        message.as === 'parent'
          ? this.host.knowsThread(message.threadId)
          : (await this.discover(socket, message.threadId)) !== null
      if (socket.destroyed || this.stopping) return
      const thread = found ? this.host.claimThread(message.threadId) : null
      const owned = found && (message.as === 'parent' || thread !== null)
      writeLine(
        socket,
        owned
          ? { type: 'owns', owned: true, cwd: thread?.parentCwd ?? thread?.cwd ?? null }
          : { type: 'owns', owned: false },
      )
    } else if (isClaimRequest(message)) {
      await this.claim(socket, message)
    } else {
      throw new Error('not a claim request')
    }
  }

  private async discover(socket: Socket, id: string): Promise<ClaimThread | null> {
    let cancel!: () => void
    let timer: NodeJS.Timeout | undefined
    const cancelled = new Promise<null>((ok) => {
      cancel = () => ok(null)
      timer = setTimeout(cancel, this.options.graceMs + CLAIM_DISCOVERY_READ_MS)
      socket.once('close', cancel)
    })
    try {
      return await Promise.race([this.host.waitForClaimThread(id, this.options.graceMs), cancelled])
    } finally {
      clearTimeout(timer)
      socket.off('close', cancel)
    }
  }

  private session(id: string): Session {
    let session = this.sessions.get(id)
    if (session) return session
    if (this.releases.size >= SESSION_CAP) throw new Error('too many pending claimed releases')
    if (this.sessions.size >= SESSION_CAP) {
      const oldest = [...this.sessions].find(([, value]) => !value.busy)
      if (!oldest) throw new Error('too many claimed sessions')
      if (oldest[1].timer) clearTimeout(oldest[1].timer)
      this.sessions.delete(oldest[0])
      void this.cleanup(oldest[0])
    }
    session = { sessionId: null, busy: false, timer: null, cancel: null }
    this.sessions.set(id, session)
    return session
  }

  private release(id: string): Promise<void> {
    const existing = this.releases.get(id)
    if (existing) return existing
    const releasing = bounded(async () => {
      await this.host.runtime.release?.(id)
    }).then(() => {
      if (this.releases.get(id) === releasing) this.releases.delete(id)
    })
    this.releases.set(id, releasing)
    // Failed cleanup remains a barrier: a later claim cannot race an old PTY.
    void releasing.catch(() =>
      debugLog('claim.cleanupFailed', { threadId: id, operation: 'release' }),
    )
    return releasing
  }

  private async cleanup(id: string): Promise<void> {
    try {
      await this.release(id)
    } catch {
      /* Logged by release; keep the barrier. */
    }
  }

  private armRelease(id: string, session: Session): void {
    if (this.stopping || this.sessions.get(id) !== session) return
    session.timer = setTimeout(() => {
      session.timer = null
      if (!session.busy) void this.cleanup(id)
    }, this.options.idleReleaseMs)
    session.timer.unref()
  }

  private async claim(socket: Socket, request: ClaimRequest): Promise<void> {
    const found = await this.discover(socket, request.threadId)
    if (socket.destroyed || this.stopping) return
    if (!found) {
      writeLine(socket, { type: 'unknown' })
      return
    }
    const session = this.session(found.threadId)
    if (session.busy) throw new Error('a turn is already running on this thread')
    session.busy = true
    if (session.timer) clearTimeout(session.timer)
    session.timer = null
    try {
      await this.releases.get(found.threadId)
      if (socket.destroyed || this.stopping) return
      // Refresh effective posture after any await; a deletion cannot revive a claim.
      const thread = this.host.claimThread(found.threadId)
      if (!thread) {
        writeLine(socket, { type: 'unknown' })
        return
      }
      const context = claimTurnContext({
        thread,
        request,
        sessionId: session.sessionId,
        mcpServers: this.host.mcpServersFor(thread.threadId),
      })
      const running = this.run(socket, thread, session, context, request.model)
      this.runs.add(running)
      try {
        await running
      } finally {
        this.runs.delete(running)
      }
    } finally {
      session.busy = false
      session.cancel = null
      this.armRelease(found.threadId, session)
    }
  }

  private async run(
    socket: Socket,
    thread: ClaimThread,
    session: Session,
    context: ReturnType<typeof claimTurnContext>,
    model: string,
  ): Promise<void> {
    let text = ''
    let success = false
    let failed = false
    let cancelled = false
    let cancellation: Promise<void> | null = null
    session.cancel = () => {
      cancelled = true
      cancellation ??= bounded(() => this.host.runtime.interrupt(thread.threadId)).catch(() => {
        debugLog('claim.cleanupFailed', { threadId: thread.threadId, operation: 'interrupt' })
      })
      return cancellation
    }
    const onClose = () => {
      void session.cancel?.()
    }
    const abort = (error: unknown) => {
      failed = true
      this.fail(socket, error)
      void session.cancel?.()
      socket.end(() => socket.destroy())
    }
    socket.once('close', onClose)
    try {
      writeLine(socket, {
        type: 'accepted',
        posture: postureSummary(context.posture ?? thread.posture),
        cwd: context.cwd,
      })
      await this.host.runtime.runTurn(context, {
        onEvent: async (event) => {
          if (cancelled || socket.destroyed || this.stopping) throw new Error('claim cancelled')
          try {
            if (event.type === 'session') {
              session.sessionId = event.claudeSessionId
              debugLog('claim.session', {
                threadId: thread.threadId,
                turnId: context.turnId,
                sessionId: session.sessionId,
              })
            }
            if (event.type === 'text_delta') text += event.delta
            if (event.type === 'error') failed = true
            if (event.type === 'completed') {
              success = event.success
              if (event.claudeSessionId) session.sessionId = event.claudeSessionId
              if (!text && event.result) text = event.result
            }
            if (Buffer.byteLength(text) > ANSWER_BYTES)
              throw new Error('claimed answer exceeds the 1 MiB limit')
            for (const out of claimEventsFor(event, context.cwd)) writeLine(socket, out)
          } catch (error) {
            // Some runtimes swallow consumer errors. Close and interrupt here,
            // without relying on propagation out of that runtime's callback.
            abort(error)
          }
        },
        onPermissionRequest: async () => {
          try {
            writeLine(socket, {
              type: 'progress',
              text: 'Permission refused: claimed children have no approval card.',
            })
          } catch (error) {
            abort(error)
          }
          return { decision: 'decline' }
        },
        onUserInputRequest: async (event) => ({
          answers: Object.fromEntries(event.questions.map((q) => [q.id, { answers: [] }])),
        }),
      })
      if (!cancelled && !this.stopping) {
        debugLog('claim.done', {
          threadId: thread.threadId,
          parentThreadId: thread.parentThreadId,
          turnId: context.turnId,
          model,
          sessionId: session.sessionId,
          owner: this.socketPath,
          success: success && !failed,
        })
        writeLine(socket, { type: 'done', success: success && !failed, text })
      }
    } catch (error) {
      failed = true
      throw error
    } finally {
      socket.off('close', onClose)
      await cancellation
      if (cancelled || failed || this.stopping) await this.cleanup(thread.threadId)
    }
  }
}
