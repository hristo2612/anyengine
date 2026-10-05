import { asRecord } from './rpc-shape.mjs'

export interface WindowReading {
  usedPercent: number
  windowDurationMins?: number | null
  resetsAt?: number | null
}
export interface BucketReading {
  limitId?: string | null
  limitName?: string | null
  normalModelSlug?: string | null
  primary?: WindowReading | null
  secondary?: WindowReading | null
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string | null } | null
  individualLimit?: {
    limit: string
    used: string
    remainingPercent: number
    resetsAt: number
  } | null
  spendControlReached?: boolean | null
  planType?: string | null
  rateLimitReachedType?: string | null
}
export interface OpenAIRead {
  rateLimits: BucketReading
  rateLimitsByLimitId?: Record<string, BucketReading> | null
  ordinaryUsageAllowed?: boolean | null
  accountId?: string | null
  rateLimitResetCredits?: ResetCredits | null
}
export interface ResetCredit {
  id: string
  resetType: 'codexRateLimits' | 'unknown'
  status: 'available' | 'redeeming' | 'redeemed' | 'unknown'
  grantedAt: number
  expiresAt?: number | null
  title?: string | null
  description?: string | null
}
export interface ResetCredits {
  availableCount: number
  credits?: ResetCredit[] | null
}
export interface Observed<T> {
  value: T
  at: number
  sequence: number
  source: 'read' | 'update'
}
export interface DenialEvidence {
  quotaAt: number | null
  spendAt: number | null
  quotaSequence: number
  spendSequence: number
}
export interface LimitState {
  account: string
  buckets: Record<string, Observed<BucketReading>>
  ordinary: Observed<boolean> | null
  resetCredits: Observed<ResetCredits> | null
  denials: Record<string, DenialEvidence>
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  error: 'needs-login' | 'unavailable' | null
  fieldTimes: Record<string, number>
  fieldSequences: Record<string, number>
}
export interface LimitSample {
  sequence: number
  startedAt: number
}
const STRINGS = [
  'limitId',
  'limitName',
  'normalModelSlug',
  'planType',
  'rateLimitReachedType',
] as const
const LEAVES = [
  ...STRINGS,
  'spendControlReached',
  'primary.usedPercent',
  'primary.windowDurationMins',
  'primary.resetsAt',
  'secondary.usedPercent',
  'secondary.windowDurationMins',
  'secondary.resetsAt',
  'credits.hasCredits',
  'credits.unlimited',
  'credits.balance',
  'individualLimit.limit',
  'individualLimit.used',
  'individualLimit.remainingPercent',
  'individualLimit.resetsAt',
]
function field(value: unknown, type: 'string' | 'number' | 'boolean'): boolean {
  return (
    value == null ||
    (typeof value === type &&
      (type === 'number'
        ? Number.isSafeInteger(value)
        : type !== 'string' || String(value).length <= 320))
  )
}
function window(value: unknown): WindowReading | null {
  if (value == null) return null
  const r = asRecord(value)
  if (!Number.isSafeInteger(r.usedPercent)) throw new Error('Invalid limit percentage')
  const out: WindowReading = { usedPercent: Number(r.usedPercent) }
  for (const key of ['windowDurationMins', 'resetsAt'] as const) {
    if (!field(r[key], 'number')) throw new Error('Invalid limit window')
    if (key in r) out[key] = r[key] as number | null
  }
  return out
}
function spendLimit(value: unknown): BucketReading['individualLimit'] {
  if (value == null) return null
  const c = asRecord(value)
  if (
    typeof c.limit !== 'string' ||
    typeof c.used !== 'string' ||
    c.limit.length > 320 ||
    c.used.length > 320 ||
    !Number.isSafeInteger(c.remainingPercent) ||
    !Number.isSafeInteger(c.resetsAt)
  )
    throw new Error('Invalid spend limit')
  return {
    limit: c.limit,
    used: c.used,
    remainingPercent: Number(c.remainingPercent),
    resetsAt: Number(c.resetsAt),
  }
}
function resetCredits(value: unknown): ResetCredits {
  const c = asRecord(value)
  if (!Number.isSafeInteger(c.availableCount) || Number(c.availableCount) < 0)
    throw new Error('Invalid reset credits')
  const out: ResetCredits = { availableCount: Number(c.availableCount) }
  if (!('credits' in c)) return out
  if (c.credits === null) return { ...out, credits: null }
  if (!Array.isArray(c.credits) || c.credits.length > 256) throw new Error('Invalid reset credits')
  out.credits = c.credits.map((v) => {
    const r = asRecord(v)
    if (
      typeof r.id !== 'string' ||
      r.id.length > 320 ||
      !['codexRateLimits', 'unknown'].includes(String(r.resetType)) ||
      !['available', 'redeeming', 'redeemed', 'unknown'].includes(String(r.status)) ||
      !Number.isSafeInteger(r.grantedAt)
    )
      throw new Error('Invalid reset credit')
    const credit: ResetCredit = {
      id: r.id,
      resetType: r.resetType as ResetCredit['resetType'],
      status: r.status as ResetCredit['status'],
      grantedAt: Number(r.grantedAt),
    }
    for (const key of ['expiresAt', 'title', 'description'] as const) {
      if (!field(r[key], key === 'expiresAt' ? 'number' : 'string'))
        throw new Error('Invalid reset credit detail')
      if (key in r) Object.assign(credit, { [key]: r[key] })
    }
    return credit
  })
  return out
}
export function decodeBucket(value: unknown): BucketReading {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid rate-limit bucket')
  const r = asRecord(value),
    out: BucketReading = {}
  for (const key of STRINGS) {
    if (!field(r[key], 'string')) throw new Error('Invalid bucket metadata')
    if (key in r) out[key] = r[key] as string | null
  }
  if (!field(r.spendControlReached, 'boolean')) throw new Error('Invalid spend-control state')
  if ('spendControlReached' in r) out.spendControlReached = r.spendControlReached as boolean | null
  for (const key of ['primary', 'secondary'] as const) if (key in r) out[key] = window(r[key])
  if ('credits' in r) {
    const c = asRecord(r.credits)
    if (r.credits == null) out.credits = null
    else {
      if (
        typeof c.hasCredits !== 'boolean' ||
        typeof c.unlimited !== 'boolean' ||
        !field(c.balance, 'string')
      )
        throw new Error('Invalid credit metadata')
      out.credits = {
        hasCredits: c.hasCredits,
        unlimited: c.unlimited,
        ...('balance' in c ? { balance: c.balance as string | null } : {}),
      }
    }
  }
  if ('individualLimit' in r) {
    out.individualLimit = spendLimit(r.individualLimit) ?? null
  }
  return out
}
export function decodeOpenAIRead(value: unknown): OpenAIRead {
  const r = asRecord(value),
    out: OpenAIRead = { rateLimits: decodeBucket(r.rateLimits) }
  if (!field(r.ordinaryUsageAllowed, 'boolean') || !field(r.accountId, 'string'))
    throw new Error('Invalid account limits')
  if ('ordinaryUsageAllowed' in r)
    out.ordinaryUsageAllowed = r.ordinaryUsageAllowed as boolean | null
  if ('accountId' in r) out.accountId = r.accountId as string | null
  if (r.rateLimitsByLimitId != null) {
    if (
      Array.isArray(r.rateLimitsByLimitId) ||
      typeof r.rateLimitsByLimitId !== 'object' ||
      Object.keys(r.rateLimitsByLimitId).length > 64
    )
      throw new Error('Invalid limit bucket map')
    out.rateLimitsByLimitId = Object.fromEntries(
      Object.entries(r.rateLimitsByLimitId).map(([id, b]) => {
        if (!id || id.length > 120 || ['__proto__', 'constructor', 'prototype'].includes(id))
          throw new Error('Invalid bucket ID')
        const bucket = decodeBucket(b)
        if (bucket.limitId != null && bucket.limitId !== id)
          throw new Error('Mismatched limit bucket ID')
        return [id, bucket]
      }),
    )
  }
  if (r.rateLimitResetCredits != null) {
    out.rateLimitResetCredits = resetCredits(r.rateLimitResetCredits)
  }
  return out
}
export function emptyLimits(account: string): LimitState {
  return {
    account,
    buckets: {},
    ordinary: null,
    resetCredits: null,
    denials: {},
    lastAttemptAt: null,
    lastSuccessAt: null,
    error: null,
    fieldTimes: {},
    fieldSequences: {},
  }
}
export function blocked(s: LimitState, scope: string): boolean {
  const d = s.denials[scope]
  return !!d && (d.quotaAt !== null || d.spendAt !== null)
}
// A reset is a scheduling/display hint, never evidence of recovered permission.
export function exhaustedUntil(s: LimitState): number | null {
  const hints: number[] = []
  for (const [id, b] of Object.entries(s.buckets)) {
    if (!blocked(s, id === 'codex' ? 'global' : `bucket:${id}`)) continue
    for (const w of [b.value.primary, b.value.secondary])
      if (w && w.usedPercent >= 100 && Number.isSafeInteger(w.resetsAt) && Number(w.resetsAt) >= 0)
        hints.push(Number(w.resetsAt) * 1000)
    const spend = b.value.individualLimit
    if (
      spend &&
      spend.remainingPercent <= 0 &&
      Number.isSafeInteger(spend.resetsAt) &&
      spend.resetsAt >= 0
    )
      hints.push(spend.resetsAt * 1000)
  }
  return hints.length ? Math.max(...hints) : null
}
function leaf(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, key) => asRecord(v)[key], value)
}
function mergeBucket(
  s: LimitState,
  id: string,
  b: BucketReading,
  sample: LimitSample,
  full: boolean,
): void {
  const old = s.buckets[id],
    value = structuredClone(old?.value ?? {}) as Record<string, unknown>
  let changed = false
  for (const path of LEAVES) {
    const next = leaf(b, path),
      key = `${id}:${path}`
    if ((!full && next == null) || sample.sequence < (s.fieldSequences[key] ?? -1)) continue
    const parts = path.split('.'),
      first = parts[0] ?? '',
      second = parts[1]
    if (second) {
      value[first] = { ...asRecord(value[first]), [second]: next ?? null }
    } else value[first] = next ?? null
    s.fieldTimes[key] = sample.startedAt
    s.fieldSequences[key] = sample.sequence
    changed = true
  }
  if (changed)
    s.buckets[id] = {
      value: value as BucketReading,
      at: Math.max(old?.at ?? 0, sample.startedAt),
      sequence: Math.max(old?.sequence ?? 0, sample.sequence),
      source: full ? 'read' : 'update',
    }
}
function deny(
  s: LimitState,
  scope: string,
  kind: 'quota' | 'spend',
  blockedNow: boolean,
  sample: LimitSample,
): void {
  const d = s.denials[scope] ?? {
    quotaAt: null,
    spendAt: null,
    quotaSequence: -1,
    spendSequence: -1,
  }
  const sequenceKey = kind === 'quota' ? 'quotaSequence' : 'spendSequence'
  if (sample.sequence < d[sequenceKey]) return
  d[sequenceKey] = sample.sequence
  d[kind === 'quota' ? 'quotaAt' : 'spendAt'] = blockedNow ? sample.startedAt : null
  s.denials[scope] = d
}
function quota(b: BucketReading): boolean {
  return b.rateLimitReachedType === 'rate_limit_reached'
}
function spend(b: BucketReading): boolean {
  return (
    b.spendControlReached === true ||
    (typeof b.rateLimitReachedType === 'string' &&
      /^(workspace_owner|workspace_member)_(credits_depleted|usage_limit_reached)$/.test(
        b.rateLimitReachedType,
      ))
  )
}
export function observeOpenAI(
  s: LimitState,
  read: OpenAIRead,
  sample: LimitSample,
  full: boolean,
): LimitState {
  const next = structuredClone(s),
    single = read.rateLimits.limitId ?? 'codex'
  if (!single || single.length > 120 || ['__proto__', 'constructor', 'prototype'].includes(single))
    throw new Error('Invalid bucket ID')
  const buckets = { [single]: read.rateLimits, ...read.rateLimitsByLimitId }
  for (const [id, b] of Object.entries(buckets)) {
    mergeBucket(next, id, b, sample, full)
    const scope = id === 'codex' ? 'global' : `bucket:${id}`
    if (quota(b)) deny(next, scope, 'quota', true, sample)
    if (spend(b)) deny(next, scope, 'spend', true, sample)
    else if (
      full &&
      b.spendControlReached === false &&
      (id !== 'codex' || read.ordinaryUsageAllowed === true)
    )
      deny(next, scope, 'spend', false, sample)
  }
  if (full && typeof read.ordinaryUsageAllowed === 'boolean') {
    if (sample.sequence >= (next.ordinary?.sequence ?? -1))
      next.ordinary = {
        value: read.ordinaryUsageAllowed,
        at: sample.startedAt,
        sequence: sample.sequence,
        source: 'read',
      }
    if (!read.ordinaryUsageAllowed || quota(buckets.codex ?? {}))
      deny(next, 'global', 'quota', true, sample)
    else deny(next, 'global', 'quota', false, sample)
  }
  if (full && read.rateLimitResetCredits && sample.sequence >= (next.resetCredits?.sequence ?? -1))
    next.resetCredits = {
      value: structuredClone(read.rateLimitResetCredits),
      at: sample.startedAt,
      sequence: sample.sequence,
      source: 'read',
    }
  next.lastSuccessAt = Math.max(next.lastSuccessAt ?? 0, sample.startedAt)
  next.error = null
  return next
}
export function observeQuotaFailure(s: LimitState, scope: string, sample: LimitSample): LimitState {
  const next = structuredClone(s)
  deny(next, scope, 'quota', true, sample)
  return next
}
