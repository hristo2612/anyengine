import { rmSync } from 'node:fs'
import type { IPty } from 'node-pty'
import type { HookPayload } from './anyengine-hooks.mjs'
import type { CompactionStreamGate, SsePtyProxy } from './anyengine-proxy.mjs'
import type { PtyScreen } from './anyengine-screen.mjs'
import type { RuntimeHandlers, RuntimeTurnContext } from './types.mjs'

export interface PtySession {
  threadId: string
  proc: IPty
  screen: PtyScreen
  // Last raw bytes from the PTY (ANSI stripped at read time): the screen
  // emulator can be empty when the CLI dies within milliseconds of spawning.
  rawTail: string
  proxy: SsePtyProxy | null
  cwd: string
  spawnKey: string
  claudeSessionId: string | null
  settingsPath: string
  mcpPath: string | null
  exited: boolean
  disposed: boolean
  sessionStarted: boolean
  lastOutputAt: number
}

export interface PendingTool {
  toolName: string
  input: Record<string, unknown>
  decision: 'allow' | 'deny' | null
}

// A Task/Agent call the CLI answered with `async_launched`: the tool_result
// is withheld until the sub-agent stops (SubagentStop hook) or the wait times
// out, and the turn stays open until the main agent has consumed the result.
export interface AsyncSubagent {
  agentId: string
  toolUseId: string
  description: string
  finished: boolean
  delivered: boolean
}

// What the SSE proxy records at request start; compared against the turn on
// every event so only streams that began inside the accepted prompt pass.
export interface StreamTag {
  turnId: string
  acceptedAt: number | null
}

export interface ActiveTurn {
  context: RuntimeTurnContext
  handlers: RuntimeHandlers
  session: PtySession
  startedAt: number
  settled: boolean
  resolve: () => void
  reject: (error: Error) => void
  gate: CompactionStreamGate
  // Text streamed to the App that it will actually show.
  streamedChars: number
  promptSubmitted: boolean
  // Set by UserPromptSubmit (the CLI accepted the prompt), cleared by a Stop
  // the turn survives; SSE streams that started outside such a window are
  // not this turn's text.
  promptAcceptedAt: number | null
  pendingTools: Map<string, PendingTool>
  lastToolUseId: string | null
  cancelSubmit: (() => void) | null
  stopFailure: HookPayload | null
  graceTimer: NodeJS.Timeout | null
  timeoutTimer: NodeJS.Timeout | null
  nativeTimer: NodeJS.Timeout | null
  approvingPrompt: boolean
  asyncAgents: Map<string, AsyncSubagent>
  // The Stop that was held back because sub-agents were still outstanding.
  heldStop: HookPayload | null
  asyncTimer: NodeJS.Timeout | null
  notifyTimer: NodeJS.Timeout | null
  // The next streamed text follows a held Stop: separate it from the text
  // already delivered.
  continuation: boolean
}

// A turn exists before its first resource-initialization await, even though
// there is no ActiveTurn or PTY yet. Keep that cancellation latch through a
// stale-resume retry and every input checkpoint.
export class TurnCancellation extends Error {
  readonly reason: Error | null

  constructor(reason: Error | null) {
    super(reason?.message ?? 'anyengine turn interrupted')
    this.reason = reason
  }
}

export class TurnPreparation {
  private cancellation: TurnCancellation | null = null
  private readonly resources = new Set<() => void>()
  private complete: (() => void) | null = null
  private readonly pending: Set<Promise<void>>

  constructor(pending: Set<Promise<void>>) {
    this.pending = pending
    this.prepare()
  }

  check(): void {
    if (this.cancellation) throw this.cancellation
  }

  prepare(): void {
    this.check()
    if (this.complete) return
    const done = new Promise<void>((resolve) => {
      this.complete = resolve
    })
    this.pending.add(done)
    void done.then(() => this.pending.delete(done))
  }

  own(dispose: () => void): void {
    this.check()
    this.resources.add(dispose)
  }

  cancel(reason: Error | null): void {
    this.cancellation ??= new TurnCancellation(reason)
    this.dispose()
  }

  // Once registered, the active turn/session owns these resources. Its
  // interruption keeps the warm PTY; release/stop still reap it normally.
  commit(): void {
    this.resources.clear()
    this.complete?.()
    this.complete = null
  }

  finish(): void {
    this.dispose()
    this.commit()
  }

  private dispose(): void {
    for (const dispose of this.resources) dispose()
  }
}

export function removePtyFiles(files: Array<string | null>): void {
  for (const file of files) {
    if (!file) continue
    try {
      rmSync(file, { force: true })
    } catch {}
  }
}

export class TurnLifecycles {
  private readonly running = new Map<string, TurnPreparation>()
  private readonly pending = new Set<Promise<void>>()
  private stopped = false

  begin(threadId: string): TurnPreparation {
    if (this.stopped) throw new Error('anyengine runtime is stopped')
    if (this.running.has(threadId)) {
      throw new Error('anyengine runtime: a turn is already running for this thread')
    }
    const turn = new TurnPreparation(this.pending)
    this.running.set(threadId, turn)
    return turn
  }

  interrupt(threadId: string): void {
    this.running.get(threadId)?.cancel(null)
  }

  finish(threadId: string, turn: TurnPreparation): void {
    turn.finish()
    if (this.running.get(threadId) === turn) this.running.delete(threadId)
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const turn of this.running.values()) turn.cancel(new Error('anyengine runtime stopped'))
    await Promise.all([...this.pending])
  }
}
