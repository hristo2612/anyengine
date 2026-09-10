import { debugLog } from './util.mjs'

// Auto-reserve: keep the desktop's model picker usable while the account's
// Codex usage is spent, without giving up the real Codex child.
//
// What the desktop does. When the ChatGPT backend reports the account's Codex
// limit reached it enters "reserve mode": the composer is locked to the
// reserve model and the picker is filtered down to `gpt-reserve` /
// `gpt-5.6-luna`, which hides the Claude and Grok entries this adapter serves.
// The gate is not the app-server's rate-limit numbers — the renderer reads the
// usage banner from its own backend — but it only arms when the desktop's
// global auth state says "ChatGPT", and that state is derived from the LOCAL
// host's `account/read`. A host that reports a non-ChatGPT account is not
// eligible for reserve mode at all, so the full picker comes back.
//
// What this module does. While a forwarded rate-limit read says the limit is
// reached, the adapter answers the desktop's `account/read` with the same
// externally-authenticated shape the adapter serves when there is no Codex
// child at all (`ANYENGINE_NATIVE_CODEX=0`), rewrites `account/updated` to
// match, and drops the reserve markers from any rate-limit payload it
// forwards. Nothing else changes: the real child keeps running, gpt-* threads
// still reach it, and they still fail with the account's own honest usage-limit
// error. When the next read says the limit is no longer reached — OpenAI reset
// it early, a banked reset credit was used, or the window rolled — the
// transform stops with the very next answer.
//
// `ANYENGINE_AUTO_RESERVE=0` turns the whole thing off.

// The desktop never asks the app-server for `account/rateLimits/read` (0 calls
// in 8.5 h of live logs against ChatGPT.app 26.901; it reads usage from its own
// backend), so the adapter re-reads it from the child on this interval and
// caches the answer between reads.
export const RESERVE_POLL_MS = 300_000

// `ANYENGINE_NATIVE_CODEX=0` makes the adapter answer these itself; while the
// limit is reached the multiplexer answers with the same values instead of the
// child's real ChatGPT account. `amazonBedrock` is the local server's own
// choice (see `account/read` in src/server.mts): the desktop applies its
// OpenAI hidden-model allowlist to every other auth shape, which would hide the
// Claude and Grok ids from the picker.
export const RESERVE_ACCOUNT_READ = {
  account: { type: 'amazonBedrock' },
  requiresOpenaiAuth: false,
} as const
export const RESERVE_ACCOUNT_UPDATED = { authMode: 'apikey', planType: null } as const
// The desktop takes its ChatGPT identity — and the bearer it calls its own
// backend with — from the host's auth status. Handing it back the signed-out
// shape is what makes the "You're out of Codex usage" banner disappear: the
// backend usage read the banner comes from is the app's, not the app-server's,
// and it stops resolving without a token. The real child keeps its own login,
// so gpt-* turns still reach OpenAI and still fail with the account's own
// usage-limit error.
export const RESERVE_AUTH_STATUS = {
  authMethod: null,
  authToken: null,
  requiresOpenaiAuth: false,
} as const

// How long the first rate-limit read may hold the desktop's `initialize`. The
// child answers it in single-digit milliseconds; the cap only exists so a
// wedged child cannot stall the handshake. Reading before the handshake
// returns matters: the desktop derives its whole ChatGPT-auth world from the
// FIRST `account/read` it gets, and re-derives it only when `account/updated`
// says the account changed.
export const RESERVE_FIRST_READ_TIMEOUT_MS = 2_000

export function autoReserveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ANYENGINE_AUTO_RESERVE ?? '').trim() !== '0'
}

// `account/updated` for the account the adapter is now serving, so the desktop
// re-reads `account/read` at the transition instead of waiting for its own
// next poll. The child's `Account` (v2 GetAccountResponse) maps onto the
// notification's `AuthMode`.
export function accountUpdatedFor(accountRead: unknown): Record<string, unknown> | null {
  const account = asRecord(asRecord(accountRead).account)
  const planType = typeof account.planType === 'string' ? account.planType : null
  switch (account.type) {
    case 'chatgpt':
      return { authMode: 'chatgpt', planType }
    case 'apiKey':
      return { authMode: 'apikey', planType: null }
    case 'amazonBedrock':
      return { authMode: 'bedrockApiKey', planType: null }
    default:
      return null
  }
}

// True when a `GetAccountRateLimitsResponse` (the `account/rateLimits/read`
// result) or an `AccountRateLimitsUpdatedNotification` says the account is out
// of Codex usage: any `RateLimitSnapshot.rateLimitReachedType` — the
// single-bucket `rateLimits` view or a bucket in `rateLimitsByLimitId` — or the
// backend's own reserve banner, `rateLimitUpsell.banner_type === 'luna_reserve'`.
export function rateLimitReached(payload: unknown): boolean {
  const record = asRecord(payload)
  if (reachedTypeOf(record.rateLimits) != null) return true
  const byId = record.rateLimitsByLimitId
  if (byId && typeof byId === 'object')
    for (const entry of Object.values(byId as object)) if (reachedTypeOf(entry) != null) return true
  return asRecord(record.rateLimitUpsell).banner_type === 'luna_reserve'
}

// Keeps the real usage numbers and drops only the two markers the desktop
// reads as "reserve": `rateLimitReachedType` on every snapshot and the backend
// banner. Returns a copy; the input is untouched.
export function stripReserveMarkers<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value
  const clone = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  const scrub = (limits: unknown) => {
    if (limits && typeof limits === 'object') {
      const record = limits as Record<string, unknown>
      if ('rateLimitReachedType' in record) record.rateLimitReachedType = null
    }
  }
  scrub(clone.rateLimits)
  const byId = clone.rateLimitsByLimitId
  if (byId && typeof byId === 'object')
    for (const entry of Object.values(byId as object)) scrub(entry)
  if ('rateLimitUpsell' in clone) clone.rateLimitUpsell = null
  return clone as T
}

// Which side of the limit the account is on, as last seen. `set()` is the only
// way in, so every transition is logged exactly once.
export class ReserveState {
  private readonly enabled: boolean
  private reached = false

  constructor(enabled: boolean = autoReserveEnabled()) {
    this.enabled = enabled
  }

  get limited(): boolean {
    return this.enabled && this.reached
  }

  get active(): boolean {
    return this.enabled
  }

  // Returns true when this changed the state.
  set(reached: boolean, source: string): boolean {
    if (!this.enabled || reached === this.reached) return false
    this.reached = reached
    debugLog(reached ? 'reserve.entered' : 'reserve.cleared', { source })
    return true
  }

  // A full `account/rateLimits/read` answer decides in both directions.
  observeRead(payload: unknown, source = 'read'): boolean {
    return this.set(rateLimitReached(payload), source)
  }

  // An `account/rateLimits/updated` notification can carry a sparse snapshot,
  // so it may only report the limit reached — never that it cleared. Clearing
  // waits for the next full read.
  observeUpdate(payload: unknown, source = 'notification'): boolean {
    return rateLimitReached(payload) ? this.set(true, source) : false
  }
}

function reachedTypeOf(snapshot: unknown): string | null {
  const value = asRecord(snapshot).rateLimitReachedType
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
