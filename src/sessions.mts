import { listClaudeSessions, readClaudeSession } from './sessions-claude.mjs'
import { CodexSessions } from './sessions-codex.mjs'
import { copySession, readCopies, type SessionCopy } from './sessions-copies.mjs'
import {
  parseSessionKey,
  type SessionHarness,
  type SessionSnapshot,
  type SessionSummary,
} from './sessions-types.mjs'

export class Sessions {
  private readonly root: string
  private readonly codex: CodexSessions
  constructor(root: string, env: NodeJS.ProcessEnv = process.env) {
    this.root = root
    this.codex = new CodexSessions(env)
  }

  async list(cwd?: string): Promise<SessionSummary[]> {
    const [claude, codex] = await Promise.all([listClaudeSessions(), this.codex.list()])
    const copied = new Set(readCopies(this.root).map((c) => c.target))
    return [...claude, ...codex]
      .map((s) => ({ ...s, copied: s.copied || copied.has(s.key) }))
      .filter((s) => !cwd || s.cwd === cwd)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
  }

  async read(session: SessionSummary): Promise<SessionSnapshot> {
    return session.harness === 'claude' ? readClaudeSession(session) : this.codex.read(session)
  }

  async find(key: string): Promise<SessionSummary> {
    parseSessionKey(key)
    const session = (await this.list()).find((s) => s.key === key)
    if (!session) throw new Error('Conversation not found; run anyengine sessions list')
    return session
  }

  async search(query: string, limit: number, cwd?: string): Promise<SessionSummary[]> {
    const needle = query.toLocaleLowerCase()
    const found: SessionSummary[] = []
    for (const session of await this.list(cwd)) {
      const titleMatches = session.title.toLocaleLowerCase().includes(needle)
      if (
        titleMatches ||
        (await this.read(session)).messages.some((m) => m.text.toLocaleLowerCase().includes(needle))
      )
        found.push(session)
      if (found.length >= limit) break
    }
    return found
  }

  async open(key: string, target: SessionHarness, fresh = false): Promise<SessionCopy> {
    const session = await this.find(key)
    return copySession(this.root, await this.read(session), target, this.codex, fresh)
  }

  async sync(
    limit = 100,
    cwd?: string,
    shouldContinue = () => true,
  ): Promise<{ copied: SessionCopy[]; skipped: number }> {
    const copies = readCopies(this.root)
    const already = new Set(copies.map((c) => c.source))
    const sessions = (await this.list(cwd)).filter((s) => !s.copied)
    const copied: SessionCopy[] = []
    let skipped = 0
    for (const session of sessions) {
      if (!shouldContinue()) break
      // Import new conversations, never overwrite a branch someone is continuing.
      if (already.has(session.key) || Date.now() - session.updatedAt < 5000) {
        skipped++
        continue
      }
      if (copied.length >= limit) break
      const snapshot = await this.read(session)
      if (!snapshot.messages.length) {
        skipped++
        continue
      }
      copied.push(
        await copySession(
          this.root,
          snapshot,
          session.harness === 'claude' ? 'codex' : 'claude',
          this.codex,
        ),
      )
    }
    return { copied, skipped }
  }

  close(): Promise<void> {
    return this.codex.close()
  }
}
