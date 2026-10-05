import { resolveBundledCodex } from './bundled-codex.mjs'
import { CodexUpstream } from './codex-upstream.mjs'
import { transcriptEntriesFromTurns } from './rehome.mjs'
import { asRecord } from './rpc-shape.mjs'
import {
  COPY_PREFIX,
  type SessionSnapshot,
  type SessionSummary,
  sessionKey,
} from './sessions-types.mjs'

// Only vendor RPCs touch Codex's index; AnyEngine never writes its SQLite database.
export class CodexSessions {
  private readonly upstream: CodexUpstream
  private readonly completions = new Map<string, Record<string, unknown>>()
  private ready: Promise<void> | null = null

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const binary = resolveBundledCodex(env).path
    if (!binary) throw new Error('Codex not found; install ChatGPT or set ANYENGINE_REAL_CODEX')
    this.upstream = new CodexUpstream({
      binary,
      args: ['app-server'],
      env,
      maxRestarts: 0,
      reserveEnabled: false,
      onMessage: (message) => {
        if ('method' in message && message.method === 'externalAgentConfig/import/completed') {
          const params = asRecord(message.params)
          if (typeof params.importId === 'string') this.completions.set(params.importId, params)
        }
      },
    })
  }

  private start(): Promise<void> {
    return (this.ready ??= (async () => {
      this.upstream.start()
      await this.upstream.initialize({
        clientInfo: { name: 'anyengine_sessions', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      })
    })())
  }

  async list(): Promise<SessionSummary[]> {
    const [active, archived] = await Promise.all([this.listThreads(false), this.listThreads(true)])
    return [...active, ...archived]
  }

  private async listThreads(archived: boolean): Promise<SessionSummary[]> {
    await this.start()
    const sessions: SessionSummary[] = []
    let cursor: string | null = null
    do {
      const response = asRecord(
        await this.upstream.request('thread/list', {
          limit: 100,
          cursor,
          modelProviders: [],
          sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
          useStateDbOnly: false,
          sortKey: 'updated_at',
          archived,
        }),
      )
      for (const raw of Array.isArray(response.data) ? response.data : []) {
        const row = asRecord(raw)
        if (typeof row.id !== 'string') continue
        const title = String(row.name || row.preview || 'Untitled conversation')
        sessions.push({
          key: sessionKey('codex', row.id),
          harness: 'codex',
          id: row.id,
          title,
          cwd: String(row.cwd ?? ''),
          updatedAt: Number(row.updatedAt ?? row.createdAt ?? 0) * 1000,
          copied: title.startsWith(COPY_PREFIX),
          archived,
        })
      }
      cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null
    } while (cursor && sessions.length < 10000)
    return sessions
  }

  async read(session: SessionSummary): Promise<SessionSnapshot> {
    await this.start()
    const response = asRecord(
      await this.upstream.request('thread/read', { threadId: session.id, includeTurns: false }),
    )
    const thread = asRecord(response.thread)
    if (thread.id !== session.id) throw new Error('Codex conversation no longer exists')
    let turns: unknown
    if (thread.historyMode === 'paginated') turns = await this.readTurns(session.id)
    else {
      const full = asRecord(
        await this.upstream.request('thread/read', {
          threadId: session.id,
          includeTurns: true,
        }),
      )
      turns = asRecord(full.thread).turns
    }
    return { ...session, messages: transcriptEntriesFromTurns(turns) }
  }

  private async readTurns(threadId: string): Promise<unknown[]> {
    const turns: unknown[] = []
    let cursor: string | null = null
    do {
      const page = asRecord(
        await this.upstream.request('thread/turns/list', {
          threadId,
          cursor,
          limit: 100,
          sortDirection: 'asc',
          itemsView: 'full',
        }),
      )
      if (Array.isArray(page.data)) turns.push(...page.data)
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null
    } while (cursor)
    return turns
  }

  async import(path: string, cwd: string, title: string): Promise<string> {
    await this.start()
    const response = asRecord(
      await this.upstream.request('externalAgentConfig/import', {
        migrationSource: 'claudeCode',
        source: 'anyengine',
        migrationItems: [
          {
            itemType: 'SESSIONS',
            cwd,
            description: title,
            details: { sessions: [{ path, cwd, title }] },
          },
        ],
      }),
    )
    const importId = String(response.importId ?? '')
    const deadline = Date.now() + 30000
    while (!this.completions.has(importId)) {
      if (!this.upstream.running) throw new Error('Codex exited during session import')
      if (Date.now() >= deadline) throw new Error('Codex session import timed out; try again')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const completed = this.completions.get(importId)!
    this.completions.delete(importId)
    const results = Array.isArray(completed.itemTypeResults) ? completed.itemTypeResults : []
    const sessions = asRecord(results.find((r) => asRecord(r).itemType === 'SESSIONS'))
    const failures = Array.isArray(sessions.failures) ? sessions.failures : []
    if (failures.length)
      throw new Error(`Codex import failed: ${String(asRecord(failures[0]).message)}`)
    const successes = Array.isArray(sessions.successes) ? sessions.successes : []
    const id = asRecord(successes[0]).target
    if (typeof id !== 'string') throw new Error('Codex did not return an imported conversation')
    sessionKey('codex', id)
    await this.upstream.request('thread/name/set', { threadId: id, name: title })
    return id
  }

  close(): Promise<void> {
    return this.upstream.stop()
  }
}
