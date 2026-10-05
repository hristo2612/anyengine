import { AccountMetadata } from './accounts-metadata.mjs'
import { accountPaths } from './accounts-store.mjs'
import { anyengineRoot } from './anyengine-config.mjs'
import { asRecord } from './rpc-shape.mjs'
import type { RuntimeHandlers } from './types.mjs'
import { codexHome, debugLog } from './util.mjs'

const TYPES = new Set([
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
])
const STATUSES = new Set(['allowed', 'allowed_warning', 'rejected'])
const NUMBERS = ['resetsAt', 'utilization', 'overageResetsAt', 'surpassedThreshold'] as const
const BOOLS = [
  'isUsingOverage',
  'overageInUse',
  'canUserPurchaseCredits',
  'hasChargeableSavedPaymentMethod',
] as const
export interface ClaudeReading {
  value: Record<string, string | number | boolean>
  fieldTimes: Record<string, number>
  observedAt: number
}
export function decodeClaudeLimit(
  event: unknown,
): { type: string; value: ClaudeReading['value'] } | null {
  const e = asRecord(event)
  if (e.type !== 'rate_limit_event') return null
  const info = asRecord(e.rate_limit_info)
  if (typeof info.status !== 'string' || !STATUSES.has(info.status)) return null
  if (
    info.rateLimitType != null &&
    (typeof info.rateLimitType !== 'string' || !TYPES.has(info.rateLimitType))
  )
    return null
  const value: ClaudeReading['value'] = { status: info.status }
  for (const key of NUMBERS) {
    const v = info[key]
    if (v == null) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
    value[key] = v
  }
  if (typeof value.utilization === 'number') value.usedPercent = value.utilization * 100
  for (const key of BOOLS) {
    const v = info[key]
    if (v == null) continue
    if (typeof v !== 'boolean') return null
    value[key] = v
  }
  if (info.overageStatus != null) {
    if (typeof info.overageStatus !== 'string' || !STATUSES.has(info.overageStatus)) return null
    value.overageStatus = info.overageStatus
  }
  for (const key of ['overageDisabledReason', 'errorCode']) {
    const v = info[key]
    if (v == null) continue
    if (typeof v !== 'string' || !/^[a-z_]{1,80}$/.test(v)) return null
    value[key] = v
  }
  return { type: typeof info.rateLimitType === 'string' ? info.rateLimitType : 'unknown', value }
}
export function observeClaudeLimit(
  metadata: AccountMetadata,
  event: unknown,
  at = Date.now(),
): boolean {
  const reading = decodeClaudeLimit(event)
  if (!reading || !Number.isSafeInteger(at)) return false
  metadata.db.exec(
    'CREATE TABLE IF NOT EXISTS claude_limits(type TEXT PRIMARY KEY,body TEXT NOT NULL)',
  )
  metadata.tx(() => {
    const row = metadata.db.prepare('SELECT body FROM claude_limits WHERE type=?').get(reading.type)
    const previous: ClaudeReading = row
      ? JSON.parse(String(row.body))
      : { value: {}, fieldTimes: {}, observedAt: 0 }
    for (const [key, v] of Object.entries(reading.value)) {
      if (at < (previous.fieldTimes[key] ?? 0)) continue
      previous.value[key] = v
      previous.fieldTimes[key] = at
    }
    previous.observedAt = Math.max(previous.observedAt, at)
    metadata.db
      .prepare(
        'INSERT INTO claude_limits VALUES (?,?) ON CONFLICT(type) DO UPDATE SET body=excluded.body',
      )
      .run(reading.type, JSON.stringify(previous))
  })
  return true
}
export function claudeReadings(metadata: AccountMetadata): Record<string, ClaudeReading> {
  if (
    !metadata.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='claude_limits' AND type='table'")
      .get()
  )
    return {}
  return Object.fromEntries(
    metadata.db
      .prepare('SELECT type,body FROM claude_limits')
      .all()
      .map((row) => [String(row.type), JSON.parse(String(row.body)) as ClaudeReading]),
  )
}
export function captureClaudeLimit(event: unknown): void {
  if (!decodeClaudeLimit(event)) return
  let metadata: AccountMetadata | null = null
  try {
    metadata = new AccountMetadata(accountPaths(anyengineRoot(), codexHome()))
    observeClaudeLimit(metadata, event)
  } catch {
    debugLog('limits.claudeObservationRejected', {})
  } finally {
    metadata?.close()
  }
}
export async function reportClaudeLimit(
  message: Record<string, unknown>,
  handlers: RuntimeHandlers,
): Promise<void> {
  captureClaudeLimit(message)
  await handlers.onEvent({
    type: 'notice',
    level: 'warning',
    message: String(message.message ?? 'rate limit'),
  })
}
export function formatClaudeLimits(
  readings: Record<string, ClaudeReading>,
  now = Date.now(),
): string {
  const rows = Object.entries(readings)
  if (!rows.length) return 'Claude | not observed'
  return rows
    .map(([type, r]) => {
      const used = typeof r.value.usedPercent === 'number' ? `${r.value.usedPercent}%` : '—'
      const reset =
        typeof r.value.resetsAt === 'number'
          ? `; resets ${new Date(r.value.resetsAt * 1000).toISOString()}`
          : ''
      const overage = r.value.overageStatus ? `; overage ${r.value.overageStatus}` : ''
      return `Claude ${type} | ${r.value.status} | ${used}${reset}${overage} | ${Math.floor(Math.max(0, now - r.observedAt) / 1000)}s`
    })
    .join('\n')
}
