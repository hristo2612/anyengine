import type { AccountParticipant } from './accounts-participant.mjs'
import { upstreamThreadInfoFrom } from './claude-project-guard.mjs'
import type { UpstreamThreadInfo } from './codex-models.mjs'
import type { CodexUpstream } from './codex-upstream.mjs'
import {
  applyCodexParams,
  parseStoredPosture,
  toCodexThreadStart,
  toCodexTurn,
} from './posture.mjs'
import { formatTranscript, injectItemsFor, transcriptEntriesFromTurns } from './rehome.mjs'
import { asRecord, idOf } from './rpc-shape.mjs'
import type { RpcPeer, WireMessage } from './types.mjs'

export const CONTINUITY_STARTS = new Set([
  'turn/start',
  'review/start',
  'thread/compact/start',
  'thread/realtime/start',
])

interface ThreadState {
  presentation: Record<string, string | number | null>
  superseded: string[]
  discarded: string[]
  id: string
  upstreamId: string
  generation: number
  switchGeneration: number | null
  attemptedGeneration: number | null
  rehomedGeneration: number | null
  info: UpstreamThreadInfo
  extras: Record<string, string | null>
}
interface Hooks {
  info(id: string, info: UpstreamThreadInfo): void
  alias(id: string, upstreamId: string): void
  message?(message: WireMessage): void
  connected?(peer: string): boolean
}
const EXTRA_KEYS = [
  'reasoningEffort',
  'serviceTier',
  'personality',
  'developerInstructions',
  'baseInstructions',
] as const

export function encryptedFailure(value: unknown): boolean {
  const e = asRecord(value),
    data = asRecord(e.data),
    rpc = asRecord(e.rpcError)
  return [e, data, rpc, asRecord(rpc.data)].some(
    (item) =>
      item.code === 'invalid_encrypted_content' ||
      [item.message, item.additionalDetails].some(
        (v) => typeof v === 'string' && /\binvalid_encrypted_content\b/.test(v),
      ),
  )
}

function threadPresentation(previous: ThreadState | null, result: Record<string, unknown>) {
  const presentation = { ...previous?.presentation },
    thread = asRecord(result.thread)
  for (const key of ['preview', 'createdAt', 'name']) {
    const value = thread[key]
    if (
      !Object.hasOwn(presentation, key) &&
      (typeof value === 'string' || typeof value === 'number' || value === null)
    )
      presentation[key] = value
  }
  return presentation
}

// Durable context is metadata; thread history stays in the shared official home.
export class AccountContinuity {
  private readonly runtime: AccountParticipant
  private readonly upstream: CodexUpstream
  private readonly hooks: Hooks
  private readonly loaded = new Set<string>()
  private creating = false
  private announcements: WireMessage[] = []
  private freshTail: Promise<unknown> = Promise.resolve()
  constructor(runtime: AccountParticipant, upstream: CodexUpstream, hooks: Hooks) {
    this.runtime = runtime
    this.upstream = upstream
    this.hooks = hooks
    runtime.ledger.metadata.db.exec(
      'CREATE TABLE IF NOT EXISTS account_thread(id TEXT PRIMARY KEY,body TEXT NOT NULL);',
    )
    for (const row of runtime.ledger.metadata.db.prepare('SELECT id FROM account_thread').all()) {
      const s = this.read(String(row.id))
      if (s && s.upstreamId !== s.id) hooks.alias(s.id, s.upstreamId)
    }
    upstream.onChildLifecycle((event) => {
      if (event.type === 'exit') this.loaded.clear()
    })
  }
  private read(id: string): ThreadState | null {
    const row = this.runtime.ledger.metadata.db
      .prepare('SELECT body FROM account_thread WHERE id=?')
      .get(id)
    if (!row) return null
    const s = JSON.parse(String(row.body)) as ThreadState
    const posture = parseStoredPosture(JSON.stringify(s.info?.posture))
    if (
      s.id !== id ||
      typeof s.upstreamId !== 'string' ||
      !s.upstreamId ||
      !Number.isSafeInteger(s.generation) ||
      s.generation < 0 ||
      typeof s.info?.model !== 'string' ||
      !s.info.model ||
      typeof s.info.cwd !== 'string' ||
      !s.info.cwd ||
      ![s.switchGeneration, s.attemptedGeneration, s.rehomedGeneration].every(
        (g) => g === null || (Number.isSafeInteger(g) && g >= 0),
      ) ||
      !s.presentation ||
      Object.entries(s.presentation).some(
        ([k, v]) =>
          !['preview', 'createdAt', 'name'].includes(k) ||
          (k === 'createdAt'
            ? typeof v !== 'number' || !Number.isFinite(v)
            : v !== null && typeof v !== 'string'),
      ) ||
      !Array.isArray(s.superseded) ||
      !Array.isArray(s.discarded) ||
      [...s.superseded, ...s.discarded].some((v) => typeof v !== 'string' || !v) ||
      !s.extras ||
      typeof s.extras !== 'object' ||
      Array.isArray(s.extras) ||
      Object.entries(s.extras).some(
        ([k, v]) =>
          !EXTRA_KEYS.includes(k as (typeof EXTRA_KEYS)[number]) ||
          (v !== null && typeof v !== 'string'),
      ) ||
      !posture
    )
      throw new Error('Stored account thread context is invalid')
    s.info.posture = posture
    return s
  }
  private write(s: ThreadState): void {
    this.runtime.ledger.metadata.db
      .prepare(
        'INSERT INTO account_thread VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(s.id, JSON.stringify(s))
  }
  record(
    id: string,
    upstreamId: string,
    info: UpstreamThreadInfo,
    params: Record<string, unknown>,
    result: Record<string, unknown> = {},
    loaded = true,
  ): void {
    if (!info.model || !info.cwd) return
    this.runtime.ledger.metadata.tx(() => {
      const previous = this.read(id),
        generation = this.runtime.participant.generation,
        extras = { ...previous?.extras }
      for (const key of EXTRA_KEYS) {
        const v = Object.hasOwn(params, key) ? params[key] : result[key]
        if (typeof v === 'string' || v === null) extras[key] = v
      }
      if (typeof params.effort === 'string' || params.effort === null)
        extras.reasoningEffort = params.effort
      const presentation = threadPresentation(previous, result)
      this.write({
        presentation,
        superseded: previous?.superseded ?? [],
        discarded: previous?.discarded ?? [],
        id,
        upstreamId,
        generation: loaded ? generation : (previous?.generation ?? generation),
        switchGeneration:
          loaded && previous && previous.generation !== generation
            ? generation
            : (previous?.switchGeneration ?? null),
        attemptedGeneration: previous?.attemptedGeneration ?? null,
        rehomedGeneration: previous?.rehomedGeneration ?? null,
        info: { ...info, model: typeof params.model === 'string' ? params.model : info.model },
        extras,
      })
    })
    if (loaded) this.loaded.add(upstreamId)
  }
  async prepare(
    peer: RpcPeer,
    id: string,
    upstreamId: string,
    params: Record<string, unknown>,
    attempt = true,
  ): Promise<{ params: Record<string, unknown>; firstAfterSwitch: boolean }> {
    let s = this.read(id)
    const generation = this.runtime.participant.generation
    if (s && s.upstreamId !== upstreamId) {
      this.hooks.alias(id, s.upstreamId)
      upstreamId = s.upstreamId
    }
    if (!s || s.generation !== generation || !this.loaded.has(upstreamId)) {
      try {
        await this.resume(peer, id, upstreamId, s)
      } catch (error) {
        if (!s || s.generation === generation || !encryptedFailure(error)) throw error
        const fresh = await this.rehome(id, params)
        params = fresh
        upstreamId = String(fresh.threadId)
      }
      s = this.read(id)
    }
    if (!s) throw new Error('Account thread context unavailable')
    const info = {
      ...s.info,
      model: typeof params.model === 'string' ? params.model : s.info.model,
      posture: applyCodexParams(s.info.posture, params),
    }
    this.record(id, upstreamId, info, params, {}, false)
    const firstAfterSwitch =
      attempt &&
      s.rehomedGeneration !== generation &&
      s.switchGeneration === generation &&
      s.attemptedGeneration !== generation
    if (firstAfterSwitch)
      this.runtime.ledger.metadata.tx(() => {
        const current = this.read(id)
        if (!current) throw new Error('Account thread disappeared')
        this.write({ ...current, attemptedGeneration: generation })
      })
    return {
      firstAfterSwitch,
      params: {
        model: info.model,
        cwd: info.cwd,
        ...toCodexTurn(info.posture),
        ...(s.extras.reasoningEffort ? { effort: s.extras.reasoningEffort } : {}),
        ...(Object.hasOwn(s.extras, 'serviceTier') ? { serviceTier: s.extras.serviceTier } : {}),
        ...params,
        threadId: upstreamId,
      },
    }
  }
  private async resume(
    peer: RpcPeer,
    id: string,
    upstreamId: string,
    s: ThreadState | null,
  ): Promise<void> {
    const resumed = asRecord(
      await this.upstream.request(
        'thread/resume',
        {
          threadId: upstreamId,
          ...(s
            ? {
                model: s.info.model,
                cwd: s.info.cwd,
                ...toCodexThreadStart(s.info.posture),
                ...(s.extras.reasoningEffort ? { reasoningEffort: s.extras.reasoningEffort } : {}),
                ...(s.extras.serviceTier ? { serviceTier: s.extras.serviceTier } : {}),
              }
            : {}),
          // Instructions are deliberately omitted: a cold resume replaces them.
        },
        30_000,
      ),
    )
    const actualId = idOf(asRecord(resumed.thread))
    if (actualId !== upstreamId) throw new Error('Account resume returned a different thread')
    const answered = upstreamThreadInfoFrom(resumed, s?.info.posture, peer)
    const info = s?.info ?? answered
    if (!answered.model || !answered.cwd) throw new Error('Account resume metadata unavailable')
    this.record(id, upstreamId, info, s?.extras ?? {}, resumed)
    this.hooks.info(upstreamId, info)
  }
  filter(message: WireMessage): WireMessage | null {
    if (this.creating && 'method' in message && message.method === 'thread/started') {
      if (this.announcements.length >= 64)
        throw new Error('Too many thread announcements during rehome')
      this.announcements.push(message)
      return null
    }
    return message
  }
  current(id: string): string | null {
    return this.read(id)?.upstreamId ?? null
  }
  presentRows(rows: unknown[]): unknown[] {
    const states = this.runtime.ledger.metadata.db
      .prepare('SELECT id FROM account_thread')
      .all()
      .map((row) => this.read(String(row.id)))
      .filter((s) => s !== null)
    const hidden = new Set(states.flatMap((s) => s.superseded))
    const current = new Map(states.map((s) => [s.upstreamId, s]))
    return rows
      .filter((entry) => !hidden.has(idOf(asRecord(entry)) ?? ''))
      .map((entry) => {
        const state = current.get(idOf(asRecord(entry)) ?? '')
        return state ? { ...asRecord(entry), ...state.presentation } : entry
      })
  }
  presentIds(ids: unknown[]): string[] {
    const rows = this.presentRows(ids.filter((id) => typeof id === 'string').map((id) => ({ id })))
    return rows.map((row) => {
      const id = idOf(asRecord(row)) ?? ''
      const state = this.runtime.ledger.metadata.db
        .prepare("SELECT id FROM account_thread WHERE json_extract(body,'$.upstreamId')=?")
        .get(id)
      return state ? String(state.id) : id
    })
  }
  async readView(id: string, params: Record<string, unknown>): Promise<unknown | null> {
    const s = this.read(id)
    if (!s?.superseded.length) return null
    const threads = await Promise.all(
      [...s.superseded, s.upstreamId].map(async (threadId) =>
        asRecord(
          asRecord(await this.upstream.request('thread/read', { ...params, threadId }, 30_000))
            .thread,
        ),
      ),
    )
    const turns = threads
      .flatMap((t) => (Array.isArray(t.turns) ? t.turns : []))
      .filter((t) => !s.discarded.includes(idOf(asRecord(t)) ?? ''))
    const first = threads[0] ?? {}
    const current = threads.at(-1) ?? {}
    return { thread: { ...current, id, preview: first.preview, createdAt: first.createdAt, turns } }
  }
  rehome(
    id: string,
    params: Record<string, unknown>,
    failedTurn: string | null = null,
  ): Promise<Record<string, unknown>> {
    const operation = this.freshTail.then(() => this.fresh(id, params, failedTurn))
    this.freshTail = operation.catch(() => {})
    return operation
  }
  private async fresh(
    id: string,
    params: Record<string, unknown>,
    failedTurn: string | null,
  ): Promise<Record<string, unknown>> {
    const generation = this.runtime.participant.generation
    const s = this.runtime.ledger.metadata.tx(() => {
      const state = this.read(id)
      if (
        !state ||
        state.rehomedGeneration === generation ||
        (state.generation === generation && state.switchGeneration !== generation)
      )
        throw new Error('Account thread fallback already used or unavailable')
      // Publish once before any new thread/input: a crash must not grant another retry.
      state.info = {
        ...state.info,
        model: typeof params.model === 'string' ? params.model : state.info.model,
        cwd: typeof params.cwd === 'string' ? params.cwd : state.info.cwd,
        posture: applyCodexParams(state.info.posture, params),
      }
      state.rehomedGeneration = generation
      if (failedTurn) state.discarded.push(failedTurn)
      this.write(state)
      return state
    })
    if (!Array.isArray(params.input))
      throw new Error('Account fallback requires intact input items')
    const read = asRecord(
      (await this.readView(id, { includeTurns: true })) ??
        (await this.upstream.request(
          'thread/read',
          { threadId: s.upstreamId, includeTurns: true },
          30_000,
        )),
    )
    const turns = asRecord(read.thread).turns
    const history = Array.isArray(turns)
      ? turns.filter((t) => idOf(asRecord(t)) !== failedTurn)
      : []
    const transcript = formatTranscript(transcriptEntriesFromTurns(history), 12_000)
    this.creating = true
    try {
      const started = asRecord(
        await this.upstream.request(
          'thread/start',
          {
            model: s.info.model,
            cwd: s.info.cwd,
            ...toCodexThreadStart(s.info.posture),
            ...s.extras,
          },
          30_000,
        ),
      )
      const upstreamId = idOf(asRecord(started.thread))
      if (!upstreamId || upstreamId === s.upstreamId)
        throw new Error('Account fallback did not create a fresh thread')
      this.runtime.ledger.metadata.tx(() => {
        this.write({
          ...s,
          upstreamId,
          generation,
          switchGeneration: generation,
          attemptedGeneration: generation,
          superseded: [...s.superseded, s.upstreamId],
        })
      })
      this.loaded.add(upstreamId)
      this.hooks.alias(id, upstreamId)
      this.hooks.info(upstreamId, s.info)
      let input = params.input
      if (transcript) {
        try {
          await this.upstream.request(
            'thread/inject_items',
            { threadId: upstreamId, items: injectItemsFor(transcript) },
            30_000,
          )
        } catch {
          input = [{ type: 'text', text: transcript }, ...input]
        }
      }
      return { ...params, threadId: upstreamId, input }
    } finally {
      this.creating = false
      for (const message of this.announcements.splice(0)) this.hooks.message?.(message)
    }
  }
}
