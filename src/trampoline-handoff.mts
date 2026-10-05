// Ported from EthanSK/claude-in-codex (MIT) src/claudeRunner.js @ e2adced; see THIRD_PARTY_NOTICES.md.
// The response segment can end while the child, session lock and MCP calls live on.
import { lstatSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeMarker } from './codex-input.mjs'
import { type ResponsesStream, rid } from './responses-stream.mjs'
import { adapterOwnsAt } from './router-claim-client.mjs'
import { eventContext, finishWebSearches, handleEvent, usageSoFar } from './trampoline-events.mjs'
import type { TrampolineTurn } from './trampoline-runner.mjs'
import {
  type CodexResults,
  CodexToolServer,
  codexToolCatalog,
  forgetCodexCalls,
  type PendingCodexCall,
  trackCodexTurn,
  type WaitingTurn,
  waitForCodexResults,
} from './trampoline-tools.mjs'

function stamp(path: string | null): string | null {
  try {
    const s = lstatSync(path ?? '')
    return s.isSocket() ? `${s.dev}:${s.ino}:${s.birthtimeMs}` : null
  } catch {
    return null
  }
}
export class TrampolineHandoff implements WaitingTurn {
  readonly threadId: string | null
  readonly engineRoot: string
  readonly ownerPath: string | null
  readonly ctx: ReturnType<typeof eventContext>
  readonly catalog: ReturnType<typeof codexToolCatalog>
  readonly done: Promise<void>
  stream: ResponsesStream | null = null
  private readonly turn: TrampolineTurn
  private readonly abort: AbortController
  private readonly ownerStamp: string | null
  private readonly untrack: () => void
  private drained!: () => void
  private detach = () => {}
  private server: CodexToolServer | null = null
  private ended = false
  private held: Array<Record<string, any>> = []
  private heldBytes = 0
  private queued: Array<PendingCodexCall & { queuedAt: number }> = []
  private waiting: PendingCodexCall[] = []
  private batch: NodeJS.Timeout | undefined
  private expiry: NodeJS.Timeout | undefined
  private ownerCheck: NodeJS.Timeout | undefined
  private keepAlive: NodeJS.Timeout | undefined

  constructor(turn: TrampolineTurn, abort: AbortController) {
    this.turn = turn
    this.abort = abort
    this.threadId = turn.parsed.threadId
    this.engineRoot = turn.engineRoot
    this.ownerPath = turn.owner?.socketPath ?? null
    this.ownerStamp = stamp(this.ownerPath)
    this.ctx = eventContext(turn.parsed.resume?.sid ?? null, '', turn.parsed.planMode)
    this.catalog = codexToolCatalog(turn.parsed.planMode ? [] : turn.codexTools)
    this.done = new Promise((resolve) => {
      this.drained = resolve
    })
    this.untrack = trackCodexTurn(this)
    this.attach(turn.stream)
    this.keepAlive = setInterval(() => {
      try {
        this.stream?.keepAlive()
      } catch {
        void this.cancel()
      }
    }, 15000)
    this.keepAlive.unref()
  }
  async mcpConfig(): Promise<{ mcpServers: Record<string, unknown> }> {
    if (!this.catalog.size) return { mcpServers: {} }
    this.server = new CodexToolServer(
      this.catalog,
      (call) => {
        if (this.ended || this.abort.signal.aborted) return
        this.queued.push({ ...call, queuedAt: Date.now() })
        this.schedule()
      },
      this.engineRoot,
    )
    const socketPath = await this.server.listen()
    return {
      mcpServers: {
        codex: {
          command: process.execPath,
          args: [fileURLToPath(new URL('./trampoline-mcp.mjs', import.meta.url))],
          env: { ANYENGINE_TRAMPOLINE_SOCKET: socketPath },
        },
      },
    }
  }
  get descriptionLength(): number {
    return Math.max(
      2048,
      ...[...this.catalog.values()].map((entry) => entry.mcpTool.description.length),
    )
  }
  private attach(stream: ResponsesStream): void {
    this.detach()
    this.stream = stream
    const closed = () => {
      if (!stream.closed) void this.cancel()
    }
    stream.sink.on('close', closed)
    this.detach = () => stream.sink.off?.('close', closed)
    if (stream.sink.destroyed || stream.sink.writableEnded) void this.cancel()
  }
  handle(event: Record<string, any>, byteLength = 0): void {
    if (this.ended || this.abort.signal.aborted) return
    if (!this.stream) {
      this.heldBytes += byteLength
      if (this.heldBytes > 4 * 1024 * 1024 || this.held.length >= 4096) {
        void this.cancel()
        return
      }
      this.held.push(event)
      return
    }
    try {
      handleEvent(event, this.ctx, this.stream)
    } catch {
      this.turn.log.error('trampoline.event-invalid')
    }
  }
  private schedule(): void {
    if (
      this.ended ||
      this.abort.signal.aborted ||
      !this.stream ||
      this.batch ||
      !this.queued.length
    )
      return
    this.batch = setTimeout(() => {
      this.batch = undefined
      try {
        this.handoff()
      } catch {
        void this.cancel()
      }
    }, 100)
    this.batch.unref()
  }
  private handoff(): void {
    const stream = this.stream
    if (!stream || this.ended || this.abort.signal.aborted || !this.queued.length) return
    const unseen = this.queued.some((call) => call.toolUseId && !this.ctx.tools.has(call.toolUseId))
    if (unseen && Date.now() - this.queued[0]!.queuedAt < 1000) {
      this.schedule()
      return
    }
    this.waiting = this.queued.splice(0)
    finishWebSearches(this.ctx, stream)
    stream.closeOpen('commentary')
    if (this.ctx.sid) {
      const turnId = rid('t')
      this.turn.state.recordTurn(this.ctx.sid, turnId, this.threadId)
      stream.marker(makeMarker(this.ctx.sid, turnId))
    }
    for (const call of this.waiting)
      stream.codexToolCall({
        callId: call.callId,
        name: call.entry.name,
        ...(call.entry.namespace ? { namespace: call.entry.namespace } : {}),
        custom: call.entry.custom,
        args: call.args,
      })
    waitForCodexResults(this.waiting, this)
    this.detach()
    this.stream = null
    stream.complete(usageSoFar(this.ctx), { endTurn: false })
    this.expiry = setTimeout(
      () => {
        void this.cancel()
      },
      30 * 60 * 1000,
    )
    this.expiry.unref()
    this.scheduleOwnerCheck()
  }
  private scheduleOwnerCheck(): void {
    if (!this.ownerPath || !this.threadId || this.ended || this.abort.signal.aborted || this.stream)
      return
    this.ownerCheck = setTimeout(() => {
      void this.checkOwner()
    }, 1000)
    this.ownerCheck.unref()
  }
  private async checkOwner(): Promise<void> {
    if (!this.ownerPath || !this.threadId || this.ended || this.abort.signal.aborted) return
    const owner = await adapterOwnsAt(
      this.ownerPath,
      this.threadId,
      this.abort.signal,
      this.turn.ownerTimeoutMs,
    )
    if (this.ended || this.abort.signal.aborted) return
    if (!owner || !this.ownerCurrent()) await this.cancel()
    else this.scheduleOwnerCheck()
  }
  ownerCurrent(): boolean {
    return (
      !this.ownerPath || (this.ownerStamp !== null && stamp(this.ownerPath) === this.ownerStamp)
    )
  }
  resume(stream: ResponsesStream, found: CodexResults): boolean {
    if (
      this.ended ||
      this.abort.signal.aborted ||
      this.stream ||
      !this.waiting.length ||
      !this.ownerCurrent()
    )
      return false
    clearTimeout(this.expiry)
    clearTimeout(this.ownerCheck)
    forgetCodexCalls(this)
    const calls = this.waiting.splice(0)
    this.attach(stream)
    if (this.abort.signal.aborted) return false
    for (const [index, call] of calls.entries()) {
      call.resolve(
        found.results.has(call.callId)
          ? found.results.get(call.callId)
          : 'Codex returned no result for this tool call.',
        index === calls.length - 1 ? found.userText : undefined,
      )
    }
    this.heldBytes = 0
    for (const event of this.held.splice(0)) this.handle(event)
    this.schedule()
    return true
  }
  async cancel(): Promise<void> {
    this.abort.abort()
    await this.done
  }
  async finish(): Promise<void> {
    if (this.ended) return this.done
    this.ended = true
    clearTimeout(this.batch)
    clearTimeout(this.expiry)
    clearTimeout(this.ownerCheck)
    clearInterval(this.keepAlive)
    this.detach()
    this.untrack()
    this.server?.close()
    await this.server?.whenClosed()
    this.held = []
    this.queued = []
    this.waiting = []
    const stream = this.stream
    this.stream = null
    try {
      if (stream && !stream.closed) stream.fail('Claude model turn stopped.')
    } finally {
      this.drained()
    }
  }
}
