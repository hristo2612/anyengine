import { subagentDepth } from './server-views.mjs'
import type { SessionStore } from './store.mjs'
import type { JsonRpcRequest, WireMessage } from './types.mjs'
import { debugLog, nowSeconds } from './util.mjs'

// Bridge sub-agents that live on the real Codex child (docs/guide/bridge.md).
//
// A gpt-* task of `spawn_subagents` is an ordinary `thread/start` on the
// child, which records it as a plain desktop thread (`source: "vscode"`, no
// parent) and never links it: the desktop listed it as a top-level thread and
// could not open it from its parent. A local child carries the linkage on its
// row and is drawn by server-views.mts#toThread; one on the child carries it
// here instead, persisted on its native_codex_threads row, and every Thread
// the child sends toward the desktop passes through `present`, so the app sees
// the same `parentThreadId` / `source.subAgent.thread_spawn` either way.
//
// Those two fields are the whole test in ChatGPT.app 26.928: a thread's parent
// is `parentThreadId`, else `source.subAgent.thread_spawn.parent_thread_id`,
// and opening a sub-agent walks that parent up to the open thread (a null
// parent refuses to open it and keeps it in the sidebar). A `thread/started`
// for a thread the app already holds refreshes `source` but not
// `parentThreadId`, so both are set.
//
// thread/list asks the child for the ones a sub-agent query adds (`listRows`),
// at most a page of them, a few reads at a time. Those rows keep only the
// cwd and provider filters: searchTerm, projectId and sectionId are not
// checked again, and a Thread has no archived flag (an archived list adds
// none).
//
// Presentation and lineage only: posture, routing and turns are untouched.

// Adapter-private field on a bridge `thread/start`: the multiplexer strips it
// before the child sees the request (codex-mux.mts#handleRequest).
export const SUBAGENT_START_PARAM = 'anyengineSubagent'

// What the spawning bridge knows before the child allocates the thread id.
export interface SubagentStart {
  parentThreadId: string
  spawnerThreadId: string | null
  agentRole: string | null
}

export interface UpstreamSubagent extends SubagentStart {
  id: string
  depth: number
  agentNickname: string
  agentPath: string
  // When it was linked (seconds); orders the rows a list adds.
  createdAt: number
}

const SPAWN_SOURCE_KINDS = new Set(['subAgent', 'subAgentThreadSpawn'])
// `thread/read`s one sub-agent list sends the child at once.
const READ_CONCURRENCY = 4

// The `agent-{12hex}` handle local sub-agents get too (server.mts).
export function nicknameFor(threadId: string): string {
  return `agent-${threadId.replace(/-/g, '').slice(0, 12)}`
}

// The request with the private field removed, and the sub-agent it describes
// when a bridge peer sent it (no other peer may link threads).
export function takeSubagentStart(
  request: JsonRpcRequest,
  fromBridge: boolean,
): { request: JsonRpcRequest; start: SubagentStart | null } {
  const params = asRecord(request.params)
  if (request.method !== 'thread/start' || !(SUBAGENT_START_PARAM in params))
    return { request, start: null }
  const { [SUBAGENT_START_PARAM]: raw, ...rest } = params
  const start = asRecord(raw)
  const parent = typeof start.parentThreadId === 'string' ? start.parentThreadId : ''
  return {
    request: { ...request, params: rest },
    start:
      fromBridge && parent
        ? {
            parentThreadId: parent,
            spawnerThreadId:
              typeof start.spawnerThreadId === 'string' ? start.spawnerThreadId : null,
            agentRole: typeof start.agentRole === 'string' ? start.agentRole : null,
          }
        : null,
  }
}

export class UpstreamSubagents {
  private readonly store: SessionStore
  private readonly records = new Map<string, UpstreamSubagent>()
  // Bridge sub-agent starts the child has not answered yet, and how to
  // announce again a thread that went out unlinked meanwhile (`announced`).
  private startsInFlight = 0
  private readonly unlinked = new Map<string, () => void>()

  constructor(store: SessionStore) {
    this.store = store
    for (const json of store.listNativeCodexSubagents()) {
      const record = parseRecord(json)
      if (record) this.records.set(record.id, record)
    }
  }

  get(threadId: string): UpstreamSubagent | null {
    return this.records.get(threadId) ?? null
  }

  forget(threadId: string): void {
    this.records.delete(threadId)
  }

  beginStart(): void {
    this.startsInFlight += 1
  }

  // The child answered a bridge sub-agent start: link the new thread (null =
  // the start failed), announcing it again if it already went out unlinked.
  endStart(threadId: string | null, start: SubagentStart): void {
    this.startsInFlight = Math.max(0, this.startsInFlight - 1)
    if (threadId) {
      this.record(threadId, start)
      this.unlinked.get(threadId)?.()
    }
    if (this.startsInFlight === 0) this.unlinked.clear()
  }

  record(threadId: string, start: SubagentStart): UpstreamSubagent {
    const agentNickname = nicknameFor(threadId)
    const record: UpstreamSubagent = {
      id: threadId,
      ...start,
      depth: this.depthOf(start.parentThreadId) + 1,
      agentNickname,
      agentPath: `/root/${agentNickname}`,
      createdAt: nowSeconds(),
    }
    this.records.set(threadId, record)
    this.store.setNativeCodexSubagent(threadId, JSON.stringify(record))
    debugLog('subagent.upstream.linked', {
      threadId,
      parentThreadId: record.parentThreadId,
      depth: record.depth,
    })
    return record
  }

  // The child's `thread/started` has gone to the desktop; nothing waits for
  // a link. Codex 0.159 answers a `thread/start` before announcing it, so a
  // bridge sub-agent is linked by then and went out presented. In the other
  // order it went out plain: noted here while a sub-agent start is
  // unanswered, it is announced again, linked, when `endStart` links it (the
  // app takes `source` from a later thread/started and finds the parent in it).
  announced(
    threadId: string | null,
    message: WireMessage,
    deliver: (message: WireMessage) => void,
  ): void {
    if (this.startsInFlight === 0 || !threadId || this.records.has(threadId)) return
    this.unlinked.set(threadId, () => deliver(this.present(message)))
  }

  // Every Thread a child message carries toward the desktop: `params.thread`
  // (thread/started), `result.thread` (start, resume, fork, read, ...) and the
  // rows of `result.data` (thread/list) or their `.thread` (thread/search).
  present<T>(message: T): T {
    if (this.records.size === 0) return message
    const record = asRecord(message)
    for (const key of ['params', 'result'] as const) {
      if (record[key] === undefined) continue
      const presented = this.presentIn(record[key])
      return (presented === record[key] ? message : { ...record, [key]: presented }) as T
    }
    return message
  }

  presentThread(thread: unknown): unknown {
    const record = asRecord(thread)
    const linked = typeof record.id === 'string' ? this.records.get(record.id) : undefined
    // Never re-link a thread the child already shows as a sub-agent.
    if (!linked || 'subAgent' in asRecord(record.source)) return thread
    return {
      ...record,
      parentThreadId: linked.parentThreadId,
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: linked.parentThreadId,
            depth: linked.depth,
            agent_path: linked.agentPath,
            agent_nickname: linked.agentNickname,
            agent_role: linked.agentRole,
          },
        },
      },
      threadSource: 'subagent',
      agentNickname: linked.agentNickname,
      agentRole: linked.agentRole,
    }
  }

  // `thread/list` rows from the child, placed the way store.mts#listThreads
  // places local sub-agents: out of plain lists, and on the first page of a
  // sub-agent query (parentThreadId, ancestorThreadId or a spawn source kind)
  // added, read from the child, because the child's own list never has them.
  // At most `limit` are added (the store's default and cap), in the list's
  // direction by link time, READ_CONCURRENCY reads at a time; the filters
  // they skip are in the header.
  async listRows(
    params: Record<string, unknown>,
    rows: unknown[],
    firstPage: boolean,
    read: (threadId: string) => Promise<unknown>,
  ): Promise<unknown[]> {
    if (this.records.size === 0) return rows
    const query = listQuery(params)
    const kept = rows.filter((row) => query.subagents || !this.records.has(idOf(row) ?? ''))
    if (!query.subagents || !query.kindsMatch || !firstPage || params.archived === true)
      return kept.map((row) => this.presentThread(row))
    const listed = new Set(kept.map((row) => idOf(row)))
    const direction = params.sortDirection === 'asc' ? 1 : -1
    // Link order breaks a tie in the same second, in the list's direction.
    const linked = [...this.records.values()]
    const wanted = (direction < 0 ? linked.reverse() : linked)
      .filter((record) => !listed.has(record.id) && this.matches(record, query))
      .sort((a, b) => (a.createdAt - b.createdAt) * direction)
      .slice(0, pageLimit(params.limit))
    const answers = await readEach(wanted, (record) => read(record.id))
    const added = answers.flatMap((answer) => {
      const thread = asRecord(asRecord(answer).thread)
      return idOf(thread) && rowMatches(thread, params) ? [thread] : []
    })
    return [...kept, ...added].map((row) => this.presentThread(row))
  }

  private matches(record: UpstreamSubagent, query: ListQuery): boolean {
    if (query.parent) return record.parentThreadId === query.parent
    if (!query.ancestor) return true
    const seen = new Set<string>([record.id])
    for (
      let at: string | null = record.parentThreadId;
      at && !seen.has(at);
      at = this.parentOf(at)
    ) {
      if (at === query.ancestor) return true
      seen.add(at)
    }
    return false
  }

  // One step up the sub-agent ancestry, across both engines.
  private parentOf(threadId: string): string | null {
    const upstream = this.records.get(threadId)
    if (upstream) return upstream.parentThreadId
    const local = this.store.getThread(threadId)
    return local?.threadSource === 'subagent' ? local.forkedFromId : null
  }

  private depthOf(threadId: string): number {
    const upstream = this.records.get(threadId)
    if (upstream) return upstream.depth
    const local = this.store.getThread(threadId)
    return local ? subagentDepth(this.store, local) : 0
  }

  private presentIn(value: unknown): unknown {
    const record = asRecord(value)
    let out = record
    if (record.thread !== undefined) {
      const thread = this.presentThread(record.thread)
      if (thread !== record.thread) out = { ...out, thread }
    }
    if (Array.isArray(record.data)) {
      const rows = record.data
      const data = rows.map((row) => this.presentRow(row))
      if (data.some((row, index) => row !== rows[index])) out = { ...out, data }
    }
    return out === record ? value : out
  }

  // A thread/list row is a Thread; a thread/search row wraps one.
  private presentRow(row: unknown): unknown {
    const inner = asRecord(row).thread
    if (inner === undefined) return this.presentThread(row)
    const thread = this.presentThread(inner)
    return thread === inner ? row : { ...asRecord(row), thread }
  }
}

interface ListQuery {
  parent: string | null
  ancestor: string | null
  // A query the local layer answers with sub-agents (store.mts#listThreads).
  subagents: boolean
  // Its source kinds admit a thread-spawn sub-agent (none = no filter).
  kindsMatch: boolean
}

function listQuery(params: Record<string, unknown>): ListQuery {
  const kinds = Array.isArray(params.sourceKinds)
    ? params.sourceKinds.filter((kind): kind is string => typeof kind === 'string')
    : []
  const spawnKind = kinds.some((kind) => SPAWN_SOURCE_KINDS.has(kind))
  const parent = nonEmpty(params.parentThreadId)
  const ancestor = nonEmpty(params.ancestorThreadId)
  return {
    parent,
    ancestor,
    subagents: parent != null || ancestor != null || spawnKind || params.includeEphemeral === true,
    kindsMatch: kinds.length === 0 || spawnKind,
  }
}

// The filters the child applied to its own rows, applied to the added ones.
function rowMatches(thread: Record<string, unknown>, params: Record<string, unknown>): boolean {
  const cwds = typeof params.cwd === 'string' ? [params.cwd] : params.cwd
  if (Array.isArray(cwds) && cwds.length > 0 && !cwds.includes(thread.cwd)) return false
  const providers = Array.isArray(params.modelProviders) ? params.modelProviders : []
  return providers.length === 0 || providers.includes(thread.modelProvider)
}

function parseRecord(json: string): UpstreamSubagent | null {
  try {
    const record = asRecord(JSON.parse(json))
    if (typeof record.id !== 'string' || typeof record.parentThreadId !== 'string') return null
    const nickname =
      typeof record.agentNickname === 'string' ? record.agentNickname : nicknameFor(record.id)
    return {
      id: record.id,
      parentThreadId: record.parentThreadId,
      spawnerThreadId: typeof record.spawnerThreadId === 'string' ? record.spawnerThreadId : null,
      agentRole: typeof record.agentRole === 'string' ? record.agentRole : null,
      depth: typeof record.depth === 'number' && record.depth > 0 ? record.depth : 1,
      agentNickname: nickname,
      agentPath: typeof record.agentPath === 'string' ? record.agentPath : `/root/${nickname}`,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    }
  } catch {
    return null
  }
}

// The page size store.mts#listThreads uses: 50 unless given, 1..200.
function pageLimit(limit: unknown): number {
  const value = typeof limit === 'number' && Number.isFinite(limit) ? limit : 50
  return Math.max(1, Math.min(Math.floor(value), 200))
}

// Each item's answer (null where it failed), READ_CONCURRENCY at a time.
async function readEach<T>(items: T[], read: (item: T) => Promise<unknown>): Promise<unknown[]> {
  const answers: unknown[] = items.map(() => null)
  let next = 0
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      try {
        answers[index] = await read(items[index] as T)
      } catch {
        answers[index] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker))
  return answers
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function idOf(value: unknown): string | null {
  const id = asRecord(value).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
