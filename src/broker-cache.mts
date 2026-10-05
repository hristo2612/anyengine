import { TextDecoder } from 'node:util'
import type {
  ActiveAccount,
  AuthStatus,
  BrokerLease,
  BrokerOwner,
  SourceSelection,
  TokenBroker,
} from './broker-types.mjs'

type FailureCode =
  | 'broker.closed'
  | 'broker.no-source'
  | 'broker.login-required'
  | 'broker.chatgpt-required'
  | 'broker.invalid-token'
  | 'broker.token-expired'
  | 'broker.auth-failed'
  | 'broker.source-changed'

class BrokerFailure extends Error {
  constructor(code: FailureCode) {
    super(code)
    this.name = 'BrokerFailure'
  }
}

interface Key {
  home: string
  generation: number
  sourceId: string | null
  sourceRevision: number
  cacheRevision: number
}

interface Flight {
  key: Key
  promise: Promise<BrokerLease>
  resolve(lease: BrokerLease): void
  reject(error: BrokerFailure): void
}

interface Value {
  lease: BrokerLease
  until: number
}

function fail(code: FailureCode): never {
  throw new BrokerFailure(code)
}
const REFRESH_MARGIN = 60_000
const CACHE_LIFETIME = 300_000
const MAX_TOKEN_BYTES = 32 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })

function tokenMetadata(auth: AuthStatus): { bearer: string; accountId: string; expires: number } {
  if (auth.authMethod === null) fail('broker.login-required')
  if (auth.authMethod !== 'chatgpt') fail('broker.chatgpt-required')
  const token = auth.authToken
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_BYTES) {
    fail('broker.invalid-token')
  }
  const parts = token.split('.')
  const payload = parts[1]
  if (parts.length !== 3 || !payload || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
    fail('broker.invalid-token')
  }
  try {
    const bytes = Buffer.from(payload, 'base64url')
    if (bytes.toString('base64url') !== payload) fail('broker.invalid-token')
    const claims: unknown = JSON.parse(decoder.decode(bytes))
    if (typeof claims !== 'object' || claims === null || Array.isArray(claims))
      fail('broker.invalid-token')
    const values = claims as Record<string, unknown>
    const exp = values.exp
    const account = values['https://api.openai.com/auth']
    if (
      typeof exp !== 'number' ||
      !Number.isFinite(exp * 1000) ||
      typeof account !== 'object' ||
      account === null ||
      Array.isArray(account)
    ) {
      fail('broker.invalid-token')
    }
    const accountId = (account as Record<string, unknown>).chatgpt_account_id
    if (typeof accountId !== 'string' || accountId.trim().length === 0) fail('broker.invalid-token')
    // These are unverified expiry/account metadata supplied by the real process.
    return { bearer: token, accountId, expires: exp * 1000 }
  } catch {
    fail('broker.invalid-token')
  }
}

export function createTokenBroker(input: {
  account: () => ActiveAccount
  owner: BrokerOwner
  now?: () => number
}): TokenBroker {
  const now = input.now ?? Date.now
  let cacheRevision = 0
  let value: Value | null = null
  let inflight: Flight | null = null
  let closed = false
  let reason: FailureCode | null = null
  let closePromise: Promise<void> | null = null

  function drop(code: FailureCode) {
    cacheRevision++
    value = null
    reason = code
    const stale = inflight
    inflight = null
    stale?.reject(new BrokerFailure(code))
  }
  const unsubscribe = input.owner.onChange(() => drop('broker.source-changed'))

  function key(): Key {
    const account = input.account()
    const selection = input.owner.current()
    return {
      home: account.home,
      generation: account.generation,
      sourceId: selection.source?.id ?? null,
      sourceRevision: selection.revision,
      cacheRevision,
    }
  }

  function matches(captured: Key): boolean {
    if (closed) return false
    const current = key()
    const source = input.owner.current().source
    return (
      captured.home === current.home &&
      captured.generation === current.generation &&
      captured.sourceId === current.sourceId &&
      captured.sourceRevision === current.sourceRevision &&
      captured.cacheRevision === current.cacheRevision &&
      (source === null ||
        (source.home === current.home && source.generation === current.generation))
    )
  }

  function guard(captured: Key) {
    if (closed) fail('broker.closed')
    if (!matches(captured)) fail('broker.source-changed')
  }

  function leaseCurrent(lease: BrokerLease): boolean {
    if (closed) return false
    const selection = input.owner.current()
    const source = selection.source
    const account = input.account()
    return (
      source !== null &&
      source.home === account.home &&
      source.generation === account.generation &&
      lease.generation === account.generation &&
      lease.sourceId === source.id &&
      lease.sourceRevision === selection.revision &&
      lease.cacheRevision === cacheRevision
    )
  }

  async function acquire(captured: Key, force: boolean): Promise<BrokerLease> {
    let selected: SourceSelection & { source: NonNullable<SourceSelection['source']> }
    try {
      selected = await input.owner.source()
    } catch {
      guard(captured)
      fail('broker.no-source')
    }
    guard(captured)
    const { source, revision } = selected
    if (
      source.home !== captured.home ||
      source.generation !== captured.generation ||
      source.id !== captured.sourceId ||
      revision !== captured.sourceRevision
    )
      fail('broker.source-changed')

    async function request(refreshToken: boolean) {
      let auth: AuthStatus
      try {
        auth = await source.request('getAuthStatus', { includeToken: true, refreshToken })
      } catch {
        guard(captured)
        fail('broker.auth-failed')
      }
      guard(captured)
      return tokenMetadata(auth)
    }
    let token = await request(force)
    guard(captured)
    if (!force && token.expires <= now() + REFRESH_MARGIN) {
      token = await request(true)
      guard(captured)
    }
    if (token.expires <= now() + REFRESH_MARGIN) fail('broker.token-expired')
    guard(captured)
    const lease: BrokerLease = Object.freeze({
      bearer: token.bearer,
      accountId: token.accountId,
      generation: captured.generation,
      sourceId: source.id,
      sourceRevision: revision,
      cacheRevision: captured.cacheRevision,
    })
    value = { lease, until: Math.min(token.expires - REFRESH_MARGIN, now() + CACHE_LIFETIME) }
    reason = null
    return lease
  }

  function flight(captured: Key, force: boolean): Promise<BrokerLease> {
    if (inflight && matches(inflight.key)) return inflight.promise
    let resolve!: Flight['resolve']
    let reject!: Flight['reject']
    const promise = new Promise<BrokerLease>((yes, no) => {
      resolve = yes
      reject = no
    })
    const current: Flight = { key: captured, promise, resolve, reject }
    inflight = current
    void acquire(captured, force)
      .then(current.resolve, (error: unknown) => {
        const safe =
          error instanceof BrokerFailure ? error : new BrokerFailure('broker.auth-failed')
        if (inflight === current && matches(captured)) reason = safe.message as FailureCode
        current.reject(safe)
      })
      .finally(() => {
        // A detached A RPC may finish after B is pending or cached.
        if (inflight === current) inflight = null
      })
    return promise
  }

  function prepare(rejected: BrokerLease | undefined): boolean {
    if (value && rejected && leaseCurrent(rejected) && rejected.bearer === value.lease.bearer) {
      drop('broker.source-changed')
      return true
    }
    if (value && (!leaseCurrent(value.lease) || now() >= value.until)) drop('broker.source-changed')
    return false
  }

  return {
    async get(options = {}) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (closed) fail('broker.closed')
          const force = prepare(options.rejected)
          if (value) return value.lease
          const lease = await flight(key(), force)
          if (!leaseCurrent(lease)) fail('broker.source-changed')
          return lease
        } catch (error) {
          if (
            error instanceof BrokerFailure &&
            error.message === 'broker.source-changed' &&
            attempt === 0
          )
            continue
          throw error instanceof BrokerFailure ? error : new BrokerFailure('broker.auth-failed')
        }
      }
      return fail('broker.source-changed')
    },
    invalidate(_generation) {
      drop(closed ? 'broker.closed' : 'broker.source-changed')
    },
    isCurrent: leaseCurrent,
    close() {
      if (!closePromise) {
        closed = true
        drop('broker.closed')
        unsubscribe()
        closePromise = Promise.resolve()
          .then(() => input.owner.close())
          .catch(() => fail('broker.auth-failed'))
      }
      return closePromise
    },
    status() {
      const account = input.account()
      const selection = closed ? null : input.owner.current().source
      const source =
        selection?.home === account.home && selection.generation === account.generation
          ? selection
          : null
      return {
        ready: value !== null && leaseCurrent(value.lease) && now() < value.until,
        source: source === null ? 'none' : (source.kind ?? 'adapter'),
        generation: account.generation,
        reason,
      }
    },
  }
}
