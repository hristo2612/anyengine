import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { entry } from './accounts-files.mjs'
import type { AccountParticipant } from './accounts-participant.mjs'
import { probeParked } from './accounts-probe.mjs'
import { rotateAccount } from './accounts-rotation.mjs'
import { accountHome } from './accounts-store.mjs'
import type { Account, AccountRegistry } from './accounts-types.mjs'
import { blocked, exhaustedUntil, type LimitState } from './limits-openai.mjs'
import { asRecord, threadIdOf } from './rpc-shape.mjs'
import { debugLog } from './util.mjs'

const FRESH_MS = 600_000
type Reason = 'usage-limit' | 'threshold'
interface Pending {
  generation: number
  model: string | null
  reason: Reason
  retryAt?: number
}
export interface Candidate {
  account: Account
  limits: LimitState | null
  credentialPresent: boolean
  scopeMap: Record<string, readonly string[]>
}
function fresh(at: number | undefined, now: number): boolean {
  return at !== undefined && Number.isSafeInteger(at) && at <= now && now - at <= FRESH_MS
}
export function eligibleForModel(
  l: LimitState,
  model: string | null,
  scopeMap: Record<string, readonly string[]>,
  now: number,
): boolean {
  if (blocked(l, 'global') || l.error || l.ordinary?.value !== true || !fresh(l.ordinary.at, now))
    return false
  const scopes = model === null ? ['codex'] : scopeMap[model]
  return !!scopes?.length && !scopes.some((id) => id !== 'codex' && blocked(l, `bucket:${id}`))
}
export function chooseAccount(
  active: string,
  candidates: Candidate[],
  now: number,
  model: string | null,
): string | null {
  for (const c of candidates)
    if (
      c.account.id !== active &&
      c.account.login === 'ready' &&
      c.credentialPresent &&
      c.limits &&
      eligibleForModel(c.limits, model, c.scopeMap, now)
    )
      return c.account.id
  return null
}
export function quotaFailure(params: unknown): boolean {
  const p = asRecord(params),
    turn = asRecord(p.turn)
  if (p.willRetry === true) return false
  return (
    asRecord(p.error).codexErrorInfo === 'usageLimitExceeded' ||
    (turn.status === 'failed' && asRecord(turn.error).codexErrorInfo === 'usageLimitExceeded')
  )
}
export function thresholdReached(
  l: LimitState,
  model: string | null,
  scopes: Record<string, readonly string[]>,
  threshold: number,
  now: number,
): boolean {
  const ids = model === null ? ['codex'] : scopes[model]
  if (!ids?.length) return false
  if (l.ordinary?.value === false && fresh(l.ordinary.at, now)) return true
  return ids.some((id) =>
    ['primary', 'secondary'].some((key) => {
      const w = l.buckets[id]?.value[key as 'primary' | 'secondary']
      return (
        !!w &&
        w.usedPercent >= 0 &&
        w.usedPercent <= 100 &&
        w.usedPercent >= threshold &&
        fresh(l.fieldTimes[`${id}:${key}.usedPercent`], now)
      )
    }),
  )
}

// Participants share durable triggers and the existing global switch gate.
export class AccountRotationPolicy {
  private readonly runtime: AccountParticipant
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private closed = false
  private readonly abort = new AbortController()
  private readonly models = new Map<string, string>()
  private readonly activeThreads = new Set<string>()
  private lastModel: string | null = null
  private readonly deferredQuotas = new Map<string, { generation: number; turns: Set<string> }>()
  constructor(runtime: AccountParticipant) {
    this.runtime = runtime
    runtime.ledger.metadata.db.exec(
      'CREATE TABLE IF NOT EXISTS rotation_request(id TEXT PRIMARY KEY,generation INTEGER NOT NULL,body TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0);',
    )
  }
  configure(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!this.closed && this.runtime.ledger.registry().rotation.enabled) {
      this.timer = setInterval(() => this.kick(), 1000)
      this.timer.unref()
      this.kick()
    }
  }
  wake(): void {
    this.kick()
  }
  observe(method: string, params: unknown): void {
    const p = asRecord(params),
      thread = threadIdOf(p) ?? asRecord(p.thread).id,
      model = p.model ?? asRecord(p.thread).model
    if (typeof thread === 'string' && typeof model === 'string') this.models.set(thread, model)
    this.observeChildren(method, p, thread)
    if (typeof thread === 'string' && method === 'turn/started') {
      this.activeThreads.add(thread)
      this.lastModel = this.models.get(thread) ?? this.lastModel
    }
    if (typeof thread === 'string' && method === 'turn/completed') this.activeThreads.delete(thread)
    if (!['error', 'turn/completed'].includes(method) || !quotaFailure(p)) return
    const turn = p.turnId ?? asRecord(p.turn).id
    if (typeof thread !== 'string' || typeof turn !== 'string') return
    this.applyQuota(thread, turn)
  }
  private applyQuota(thread: string, turn: string): void {
    const r = this.runtime.ledger.registry(),
      selectedModel = this.models.get(thread)
    if (!selectedModel) {
      let pending = this.deferredQuotas.get(thread)
      if (!pending || pending.generation !== r.generation) {
        pending = { generation: r.generation, turns: new Set() }
        this.deferredQuotas.set(thread, pending)
      }
      pending.turns.add(turn)
      return
    }
    const scopes = this.runtime.limits.modelScopes(r.active)[selectedModel],
      scope = scopes?.length === 1 && scopes[0] !== 'codex' ? `bucket:${scopes[0]}` : 'global'
    if (!this.runtime.recordQuota(scope)) return
    if (!r.rotation.enabled) return
    this.enqueue(`${r.generation}:${thread}:${turn}`, {
      generation: r.generation,
      model: selectedModel,
      reason: 'usage-limit',
    })
    this.kick()
  }
  private observeChildren(method: string, p: ReturnType<typeof asRecord>, thread: unknown): void {
    const item = asRecord(p.item)
    if (
      method === 'item/completed' &&
      item.type === 'collabAgentToolCall' &&
      item.tool === 'spawnAgent' &&
      Array.isArray(item.receiverThreadIds)
    ) {
      const childModel =
        typeof item.model === 'string'
          ? item.model
          : typeof thread === 'string'
            ? this.models.get(thread)
            : undefined
      if (childModel)
        for (const id of item.receiverThreadIds) {
          if (typeof id !== 'string') continue
          this.models.set(id, childModel)
          const pending = this.deferredQuotas.get(id)
          this.deferredQuotas.delete(id)
          if (pending?.generation === this.runtime.ledger.state().generation)
            for (const turn of pending.turns) this.applyQuota(id, turn)
        }
    }
  }
  translationQuota(model: string, generation: number, record: (scope: string) => boolean): void {
    const r = this.runtime.ledger.registry()
    if (r.generation !== generation) return
    const scopes = this.runtime.limits.modelScopes(r.active)[model]
    const scope = scopes?.length === 1 && scopes[0] !== 'codex' ? `bucket:${scopes[0]}` : 'global'
    if (!record(scope) || !r.rotation.enabled) return
    this.enqueue(`${generation}:translator:${randomUUID()}`, {
      generation,
      model,
      reason: 'usage-limit',
    })
    this.kick()
  }
  private enqueue(id: string, p: Pending): void {
    this.runtime.ledger.metadata.db
      .prepare('INSERT OR IGNORE INTO rotation_request(id,generation,body) VALUES (?,?,?)')
      .run(id, p.generation, JSON.stringify(p))
  }
  private kick(): void {
    if (!this.runtime.ledger.registry().rotation.enabled) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      return
    }
    if (this.closed || this.running) return
    const pending = this.run().catch(() => debugLog('account.rotationDeferred', {}))
    this.running = pending
    void pending.finally(() => {
      this.running = null
    })
  }
  private candidate(id: string): Candidate {
    const { ledger, limits } = this.runtime,
      r = ledger.registry(),
      account = r.accounts.find((a) => a.id === id)
    if (!account) throw new Error('Rotation candidate disappeared')
    return {
      account,
      limits: limits.readings()[id] ?? null,
      scopeMap: limits.modelScopes(id),
      credentialPresent: !!entry(
        join(
          id === r.home ? ledger.metadata.paths.canonical : accountHome(ledger.metadata.paths, id),
          'auth.json',
        ),
      ),
    }
  }
  private async run(): Promise<void> {
    const { ledger, limits } = this.runtime,
      r = ledger.registry(),
      s = ledger.state(),
      now = Date.now()
    if (
      s.phase !== 'open' ||
      !r.rotation.enabled ||
      entry(join(ledger.metadata.paths.root, 'state/flip.lock'))
    )
      return
    const latest = Number(
      ledger.metadata.db.prepare('SELECT max(at) AS at FROM rotation_event').get()?.at ?? 0,
    )
    if (latest > now || now - latest < r.rotation.cooldownMs) return
    const l = limits.readings()[r.active]
    const applicable = new Set([...this.activeThreads].map((id) => this.models.get(id) ?? null))
    if (!applicable.size) applicable.add(this.lastModel)
    const triggered = l
      ? [...applicable].filter((model) =>
          thresholdReached(l, model, limits.modelScopes(r.active), r.rotation.threshold, now),
        )
      : []
    for (const model of triggered) {
      if (!l) continue
      const sequence = Math.max(
        l.denials.global?.quotaSequence ?? 0,
        l.denials.global?.spendSequence ?? 0,
        l.fieldSequences['codex:primary.usedPercent'] ?? 0,
        l.fieldSequences['codex:secondary.usedPercent'] ?? 0,
        ...Object.values(l.fieldSequences),
      )
      this.enqueue(`${s.generation}:limits:${model ?? 'codex'}:${sequence}`, {
        generation: s.generation,
        model,
        reason: 'threshold',
      })
    }
    const row = ledger.metadata.db
      .prepare(
        'SELECT id,body FROM rotation_request WHERE generation=? AND done=0 ORDER BY rowid LIMIT 1',
      )
      .get(s.generation)
    if (!row) return
    const request = JSON.parse(String(row.body)) as Pending
    if (request.retryAt && request.retryAt > now) return
    const target = await this.selectTarget(r, request)
    if (!target) {
      this.noCapacity(r, request, String(row.id), now)
      return
    }
    const guard = () => {
      const current = ledger.registry(),
        candidate = this.candidate(target),
        active = limits.readings()[current.active],
        scopes = request.model ? limits.modelScopes(current.active)[request.model] : ['codex'],
        stillNeeded =
          !!active &&
          (request.reason === 'threshold'
            ? thresholdReached(
                active,
                request.model,
                limits.modelScopes(current.active),
                current.rotation.threshold,
                Date.now(),
              )
            : blocked(active, 'global') || !!scopes?.some((id) => blocked(active, `bucket:${id}`)))
      return (
        !entry(join(ledger.metadata.paths.root, 'state/flip.lock')) &&
        stillNeeded &&
        current.generation === request.generation &&
        current.rotation.enabled &&
        !!candidate.limits &&
        candidate.account.login === 'ready' &&
        candidate.credentialPresent &&
        eligibleForModel(candidate.limits, request.model, candidate.scopeMap, Date.now()) &&
        !thresholdReached(
          candidate.limits,
          request.model,
          candidate.scopeMap,
          current.rotation.threshold,
          Date.now(),
        )
      )
    }
    await rotateAccount(ledger, target, request.reason, this.abort.signal, guard)
    ledger.metadata.db
      .prepare('UPDATE rotation_request SET done=1 WHERE generation<=?')
      .run(request.generation)
  }
  private async selectTarget(r: AccountRegistry, request: Pending): Promise<string | null> {
    const { ledger, limits } = this.runtime
    for (const a of r.accounts) {
      if (a.id === r.active || a.login !== 'ready') continue
      const c = this.candidate(a.id)
      if (!c.credentialPresent) continue
      if (!c.limits?.ordinary || !fresh(c.limits.ordinary.at, Date.now()))
        await probeParked({ ledger, limits, account: a.id })
      this.abort.signal.throwIfAborted()
      if (ledger.state().generation !== request.generation || !ledger.registry().rotation.enabled)
        return null
      const current = this.candidate(a.id)
      if (
        chooseAccount(r.active, [current], Date.now(), request.model) &&
        current.limits &&
        !thresholdReached(
          current.limits,
          request.model,
          current.scopeMap,
          r.rotation.threshold,
          Date.now(),
        )
      ) {
        return a.id
      }
    }
    return null
  }
  private noCapacity(r: AccountRegistry, request: Pending, id: string, now: number): void {
    const { ledger, limits } = this.runtime
    const resets = r.accounts
      .filter((a) => a.id !== r.active)
      .map((a) => {
        const reading = limits.readings()[a.id],
          reset = reading ? exhaustedUntil(reading) : null
        return reset === null ? 0 : Math.max(reset + 1000, ledger.probeAttempt(a.id) + FRESH_MS)
      })
      .filter((at) => at > now)
    if (resets.length) {
      ledger.metadata.db
        .prepare('UPDATE rotation_request SET body=? WHERE id=?')
        .run(JSON.stringify({ ...request, retryAt: Math.min(...resets) }), id)
      return
    }
    ledger.metadata.db.prepare('UPDATE rotation_request SET done=1 WHERE id=?').run(id)
    debugLog('account.noEligibleAccount', { generation: request.generation })
  }
  async close(): Promise<void> {
    this.closed = true
    this.abort.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.running
  }
}
