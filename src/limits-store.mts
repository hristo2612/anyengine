import { randomUUID } from 'node:crypto'
import type { AccountLedger } from './accounts-ledger.mjs'
import { processAlive } from './accounts-processes.mjs'
import type { AccountRegistry, Family } from './accounts-types.mjs'
import {
  decodeOpenAIRead,
  emptyLimits,
  type LimitState,
  type OpenAIRead,
  observeOpenAI,
  observeQuotaFailure,
} from './limits-openai.mjs'

export interface ObservationPermit {
  id: string
  account: string
  epoch: number
  sourceId: string
  sourceRevision: number
  familyId: string
  purpose: 'active' | 'probe' | 'maintenance'
}
export interface ObservationSample {
  permit: ObservationPermit
  sequence: number
  startedAt: number
}
export interface ObservationEnvelope {
  sample: ObservationSample
  kind: 'openai-read' | 'openai-update' | 'openai-quota-error' | 'openai-catalog'
  payload: unknown
  identity?: { vendorAccountId: string | null; email: string | null; planType: string | null }
}
export class LimitsStore {
  readonly ledger: AccountLedger
  constructor(ledger: AccountLedger) {
    this.ledger = ledger
    ledger.metadata.db.exec(`CREATE TABLE IF NOT EXISTS observation_authority(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observation_sequence(account TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS observation_sample(account TEXT,sequence INTEGER,permit TEXT,at INTEGER,PRIMARY KEY(account,sequence));
      CREATE TABLE IF NOT EXISTS model_scope(account TEXT,model TEXT,bucket TEXT,PRIMARY KEY(account,model,bucket));
      CREATE TABLE IF NOT EXISTS catalog_model(model TEXT PRIMARY KEY,ordinary INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS catalog_alias(alias TEXT PRIMARY KEY,model TEXT NOT NULL);`)
  }
  issue(familyId: string, sourceId: string, sourceRevision: number): ObservationPermit {
    return this.ledger.metadata.tx(() => {
      const s = this.ledger.state(),
        f = this.ledger.holders().find((f) => f.id === familyId)
      if (
        !f?.native ||
        processAlive(f.native) !== 'alive' ||
        f.generation !== s.generation ||
        !['open', 'draining', 'bootstrap'].includes(s.phase)
      )
        throw new Error('Limit source is not admitted')
      const p: ObservationPermit = {
        id: randomUUID(),
        account: f.account,
        epoch: f.generation,
        familyId,
        sourceId,
        sourceRevision,
        purpose:
          f.purpose === 'probe' ? 'probe' : f.purpose === 'bootstrap' ? 'maintenance' : 'active',
      }
      this.ledger.metadata.db
        .prepare('INSERT INTO observation_authority VALUES (?,?)')
        .run(p.id, JSON.stringify(p))
      return p
    })
  }
  private valid(p: ObservationPermit): Family | null {
    const db = this.ledger.metadata.db,
      row = db.prepare('SELECT body FROM observation_authority WHERE id=?').get(p.id)
    const state = this.ledger.state()
    if (
      !row ||
      JSON.stringify(p) !== String(row.body) ||
      p.epoch !== state.generation ||
      ['sealed', 'journal', 'rolling-back', 'cleanup-commit', 'cleanup-rollback'].includes(
        state.phase,
      )
    )
      return null
    const f = this.ledger.holders().find((f) => f.id === p.familyId)
    return f?.native &&
      processAlive(f.native) === 'alive' &&
      f.account === p.account &&
      f.generation === p.epoch
      ? f
      : null
  }
  sample(permit: ObservationPermit, startedAt = Date.now()): ObservationSample {
    return this.ledger.metadata.tx(() => {
      if (!this.valid(permit) || !Number.isSafeInteger(startedAt))
        throw new Error('Limit observation authority revoked')
      const db = this.ledger.metadata.db
      const sequence =
        Number(
          db.prepare('SELECT value FROM observation_sequence WHERE account=?').get(permit.account)
            ?.value ?? 0,
        ) + 1
      db.prepare(
        'INSERT INTO observation_sequence VALUES (?,?) ON CONFLICT(account) DO UPDATE SET value=excluded.value',
      ).run(permit.account, sequence)
      db.prepare('INSERT INTO observation_sample VALUES (?,?,?,?)').run(
        permit.account,
        sequence,
        permit.id,
        startedAt,
      )
      return { permit, sequence, startedAt }
    })
  }
  revoke(familyId: string): void {
    this.ledger.metadata.tx(() => {
      const db = this.ledger.metadata.db
      for (const row of db.prepare('SELECT id,body FROM observation_authority').all()) {
        if ((JSON.parse(String(row.body)) as ObservationPermit).familyId !== familyId) continue
        db.prepare('DELETE FROM observation_sample WHERE permit=?').run(String(row.id))
        db.prepare('DELETE FROM observation_authority WHERE id=?').run(String(row.id))
      }
    })
  }
  accept(e: ObservationEnvelope): boolean {
    const read =
      e.kind === 'openai-quota-error' || e.kind === 'openai-catalog'
        ? null
        : decodeOpenAIRead(e.payload)
    return this.ledger.metadata.tx(() => {
      const { permit: p, sequence, startedAt } = e.sample,
        db = this.ledger.metadata.db
      const sample = db
        .prepare('SELECT permit,at FROM observation_sample WHERE account=? AND sequence=?')
        .get(p.account, sequence)
      if (!this.valid(p) || sample?.permit !== p.id || sample.at !== startedAt) return false
      db.prepare('DELETE FROM observation_sample WHERE account=? AND sequence=?').run(
        p.account,
        sequence,
      )
      if (e.kind === 'openai-catalog') {
        this.catalog(e.payload)
        return true
      }
      if (e.identity && !this.identity(p.account, e.identity)) return false
      this.ledger.metadata.mutate<Record<string, LimitState>>('limits', (all) => {
        const previous = all[p.account] ?? emptyLimits(p.account)
        const value = read
          ? observeOpenAI(previous, read, e.sample, e.kind === 'openai-read')
          : observeQuotaFailure(previous, this.quotaScope(e.payload), e.sample)
        return { ...all, [p.account]: value }
      })
      if (read) this.scopes(p.account, read)
      return true
    })
  }
  private quotaScope(payload: unknown): string {
    const scope = (payload as { scope?: unknown })?.scope
    if (
      typeof scope !== 'string' ||
      !(scope === 'global' || /^bucket:[^\0\r\n]{1,120}$/.test(scope))
    )
      throw new Error('Unverified quota scope')
    return scope
  }
  private identity(
    account: string,
    identity: NonNullable<ObservationEnvelope['identity']>,
  ): boolean {
    for (const v of Object.values(identity))
      if (v !== null && (typeof v !== 'string' || v.length > 320))
        throw new Error('Invalid official account identity')
    let accepted = true
    this.ledger.metadata.mutate<AccountRegistry>('registry', (r) => {
      const a = r.accounts.find((a) => a.id === account)
      if (!a) throw new Error('Unknown observed account')
      const mismatch =
        identity.vendorAccountId !== null &&
        ((a.vendorAccountId !== null && a.vendorAccountId !== identity.vendorAccountId) ||
          r.accounts.some(
            (other) => other.id !== account && other.vendorAccountId === identity.vendorAccountId,
          ))
      if (mismatch) {
        a.login = 'needs-login'
        accepted = false
        return r
      }
      for (const key of ['vendorAccountId', 'email', 'planType'] as const)
        if (identity[key] !== null) a[key] = identity[key]
      a.login = 'ready'
      return r
    })
    return accepted
  }
  private scopes(account: string, read: OpenAIRead): void {
    const buckets = {
      [read.rateLimits.limitId ?? 'codex']: read.rateLimits,
      ...read.rateLimitsByLimitId,
    }
    for (const [id, b] of Object.entries(buckets))
      if (b.normalModelSlug)
        this.ledger.metadata.db
          .prepare('INSERT OR IGNORE INTO model_scope VALUES (?,?,?)')
          .run(account, b.normalModelSlug, id)
  }
  modelScopes(account: string): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const row of this.ledger.metadata.db
      .prepare('SELECT model,bucket FROM model_scope WHERE account=?')
      .all(account))
      (out[String(row.model)] ??= []).push(String(row.bucket))
    for (const row of this.ledger.metadata.db
      .prepare('SELECT model,ordinary FROM catalog_model')
      .all()) {
      const model = String(row.model)
      if (!out[model] && row.ordinary === 1) out[model] = ['codex']
    }
    for (const row of this.ledger.metadata.db
      .prepare('SELECT alias,model FROM catalog_alias')
      .all())
      if (out[String(row.model)])
        out[String(row.alias)] = [
          ...new Set([...(out[String(row.alias)] ?? []), ...(out[String(row.model)] ?? [])]),
        ]
    return out
  }
  private catalog(payload: unknown): void {
    const data = (payload as { data?: unknown })?.data
    if (!Array.isArray(data) || data.length > 512) throw new Error('Invalid official catalog')
    for (const row of data) {
      const model = row?.model,
        id = row?.id
      if (
        typeof model !== 'string' ||
        typeof id !== 'string' ||
        model.length > 120 ||
        id.length > 120
      )
        continue
      if (!model.startsWith('gpt-')) continue
      const ordinary = row.modelSpecialty == null ? 1 : 0
      for (const alias of new Set([model, id])) {
        this.ledger.metadata.db
          .prepare(
            'INSERT INTO catalog_alias VALUES (?,?) ON CONFLICT(alias) DO UPDATE SET model=excluded.model',
          )
          .run(alias, model)
        this.ledger.metadata.db
          .prepare(
            'INSERT INTO catalog_model VALUES (?,?) ON CONFLICT(model) DO UPDATE SET ordinary=excluded.ordinary',
          )
          .run(alias, ordinary)
        for (const scope of this.ledger.metadata.db
          .prepare('SELECT account,bucket FROM model_scope WHERE model=?')
          .all(model))
          this.ledger.metadata.db
            .prepare('INSERT OR IGNORE INTO model_scope VALUES (?,?,?)')
            .run(String(scope.account), alias, String(scope.bucket))
      }
    }
  }
  readings(): Record<string, LimitState> {
    return this.ledger.metadata.read<Record<string, LimitState>>('limits').value
  }
  failure(
    account: string,
    epoch: number,
    status: 'needs-login' | 'unavailable',
    at: number,
    sample: ObservationSample | null = null,
  ): void {
    this.ledger.metadata.tx(() => {
      const s = this.ledger.state()
      if (s.generation !== epoch || !['open', 'draining'].includes(s.phase)) return
      if (sample ? !this.valid(sample.permit) : status !== 'unavailable' || s.active === account)
        return
      this.ledger.metadata.mutate<Record<string, LimitState>>('limits', (all) => ({
        ...all,
        [account]: { ...(all[account] ?? emptyLimits(account)), lastAttemptAt: at, error: status },
      }))
      if (status === 'needs-login')
        this.ledger.metadata.mutate<AccountRegistry>('registry', (r) => {
          const a = r.accounts.find((a) => a.id === account)
          if (a) a.login = 'needs-login'
          return r
        })
    })
  }
}
