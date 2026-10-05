// Ported from EthanSK/claude-in-codex (MIT) src/state.js @ e2adced, with changes; see THIRD_PARTY_NOTICES.md.
// Changes: typed, synchronous atomic writes, bounded sessions/windows, no catalog cache.
import { readFileSync } from 'node:fs'
import { writeJsonAtomic } from './anyengine-config.mjs'

interface Session {
  lastTurnId: string
  threadId: string | null
}
export class TrampolineState {
  private readonly file: string
  private readonly maxSessions: number
  private readonly sessions = new Map<string, Session>()
  private readonly windows = new Map<string, number>()

  constructor(file: string, maxSessions = 500) {
    this.file = file
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1)
      throw new Error('maxSessions must be positive')
    this.maxSessions = maxSessions
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      for (const [sid, session] of Object.entries(data.sessions ?? {}) as Array<
        [string, Session]
      >) {
        if (session && typeof session.lastTurnId === 'string') {
          this.sessions.set(sid, {
            lastTurnId: session.lastTurnId,
            threadId: typeof session.threadId === 'string' ? session.threadId : null,
          })
        }
      }
      for (const [model, size] of Object.entries(data.contextWindows ?? {})) {
        if (typeof size === 'number' && Number.isSafeInteger(size) && size > 0)
          this.windows.set(model, size)
      }
      this.prune()
    } catch {
      /* first run or broken state: no trusted resume marker */
    }
  }
  isLatestTurn(sid: string, turnId: string): boolean {
    return this.sessions.get(sid)?.lastTurnId === turnId
  }
  ownerThread(sid: string): string | null {
    return this.sessions.get(sid)?.threadId ?? null
  }
  recordTurn(sid: string, turnId: string, threadId: string | null): void {
    const owner = threadId || this.ownerThread(sid)
    this.sessions.delete(sid)
    this.sessions.set(sid, { lastTurnId: turnId, threadId: owner })
    this.save()
  }
  setContextWindow(model: string, size: number): void {
    if (!Number.isSafeInteger(size) || size < 1 || this.windows.get(model) === size) return
    this.windows.delete(model)
    this.windows.set(model, size)
    this.save()
  }
  contextWindow(model: string): number | null {
    return this.windows.get(model) ?? null
  }
  private prune(): void {
    while (this.sessions.size > this.maxSessions)
      this.sessions.delete(this.sessions.keys().next().value ?? '')
    while (this.windows.size > this.maxSessions)
      this.windows.delete(this.windows.keys().next().value ?? '')
  }
  private save(): void {
    this.prune()
    writeJsonAtomic(this.file, {
      sessions: Object.fromEntries(this.sessions),
      contextWindows: Object.fromEntries(this.windows),
    })
  }
}
