// The router's own GPT credential source: the active account's Codex login on
// disk, read fresh on every use. Nothing here refreshes or writes a token. A
// refresh is the official client's job (one short-lived app-server per
// refresh), so the single-use refresh token only ever moves inside Codex.
//
// Why: a long-lived process reads auth.json once. When another Codex process
// replaced the login (2026-10-10), the borrowed process kept handing out the
// old bearer and every GPT call failed with HTTP 401 for three days.
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AuthSource, AuthStatus } from './broker-types.mjs'

const MAX_LOGIN_BYTES = 64 * 1024
// Same margin the token cache uses before it asks for a refresh.
const REFRESH_MARGIN = 60_000
// A bearer refused again soon after an official refresh is a dead login: it is
// handed back without another launch, so a retrying client cannot spend the
// shared single-use refresh token over and over. A new login on disk ends it.
export const REFRESH_COOLDOWN = 5 * 60_000
// A refresh that failed outright (no answer) may have been transient: wait less.
export const FAILED_REFRESH_COOLDOWN = 60_000
// Codex may be rewriting auth.json; a torn read is retried once after this.
const TORN_READ_DELAY = 50
const decoder = new TextDecoder('utf-8', { fatal: true })
const fail = (code = 'source-unavailable') => new Error(`broker.${code}`)

export interface OfficialAuth {
  // getAuthStatus on a short-lived official app-server for this home.
  status(home: string, generation: number, refreshToken: boolean): Promise<AuthStatus>
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

// The login Codex wrote for this home. null means there is no usable file
// login (absent, stored in the keyring, or a mode this reader does not know),
// and the official client answers for the home instead. Field names are the
// ones `codex login` writes: auth_mode, OPENAI_API_KEY, tokens.access_token.
export function readCodexLogin(home: string): AuthStatus | null {
  let target: string
  try {
    // A managed overlay links auth.json to the canonical home's file.
    target = realpathSync(join(home, 'auth.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw fail('unsafe-login')
  }
  let bytes: Buffer
  try {
    const stat = statSync(target)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > MAX_LOGIN_BYTES)
      throw new Error('unsafe')
    bytes = readFileSync(target)
  } catch {
    throw fail('unsafe-login')
  }
  let login: Record<string, unknown> | null
  try {
    login = record(JSON.parse(decoder.decode(bytes)))
  } catch {
    throw fail('invalid-login')
  }
  if (!login) throw fail('invalid-login')
  const tokens = record(login.tokens)
  const mode = login.auth_mode
  if (
    mode === 'apikey' ||
    (mode === undefined && !tokens && typeof login.OPENAI_API_KEY === 'string')
  )
    return { authMethod: 'apikey', authToken: null, requiresOpenaiAuth: true }
  if (mode !== undefined && mode !== 'chatgpt') return null
  const token = tokens?.access_token
  if (typeof token !== 'string' || !token) return null
  return { authMethod: 'chatgpt', authToken: token, requiresOpenaiAuth: true }
}

// Unverified expiry claim, only to decide whether a refresh is still needed.
function expiresAt(token: string): number | null {
  try {
    const claims = record(
      JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()),
    )
    const exp = claims?.exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
  } catch {
    return null
  }
}

export function createFileAuthSource(input: {
  home: string
  generation: number
  official: OfficialAuth
  now?: () => number
}): AuthSource {
  const home = realpathSync(input.home)
  const now = input.now ?? Date.now
  // The bearer this source last handed out; a forced refresh compares against it.
  let served: string | null = null
  let refreshing: Promise<AuthStatus> | null = null
  let last: { at: number; token: string | null; status: AuthStatus | null } | null = null
  const remember = (status: AuthStatus): AuthStatus => {
    if (status.authToken) served = status.authToken
    return status
  }
  // The served bearer came from an official refresh moments ago (or that refresh failed).
  const cooling = () =>
    last !== null &&
    now() - last.at < (last.status ? REFRESH_COOLDOWN : FAILED_REFRESH_COOLDOWN) &&
    last.token === served
  function officialRefresh(): Promise<AuthStatus> {
    if (!refreshing) {
      const flight = input.official.status(home, input.generation, true).then(
        (status) => {
          // An answer without a bearer still cools down the bearer that was refused.
          last = { at: now(), token: status.authToken ?? served, status }
          return status
        },
        (error: unknown) => {
          last = { at: now(), token: served, status: null }
          throw error
        },
      )
      refreshing = flight
      void flight
        .finally(() => {
          if (refreshing === flight) refreshing = null
        })
        .catch(() => {})
    }
    return refreshing
  }
  async function readDisk(): Promise<AuthStatus | null> {
    try {
      return readCodexLogin(home)
    } catch (error) {
      if ((error as Error).message !== 'broker.invalid-login') throw error
      await new Promise((done) => setTimeout(done, TORN_READ_DELAY))
      return readCodexLogin(home)
    }
  }
  function cooled(disk: AuthStatus | null): AuthStatus {
    if (!last?.status) throw fail()
    return remember(disk ?? last.status)
  }
  return {
    id: `file-${randomUUID()}`,
    home,
    generation: input.generation,
    kind: 'file',
    async request(method, params) {
      if (
        method !== 'getAuthStatus' ||
        params.includeToken !== true ||
        typeof params.refreshToken !== 'boolean'
      )
        throw fail()
      const disk = await readDisk()
      if (!disk) {
        // Keyring or no login: only the official client can answer.
        if (!params.refreshToken)
          return remember(await input.official.status(home, input.generation, false))
        return cooling() ? cooled(null) : remember(await officialRefresh())
      }
      if (!params.refreshToken || disk.authMethod !== 'chatgpt' || !disk.authToken)
        return remember(disk)
      // A forced refresh follows a rejected or expiring bearer. Another Codex
      // process may already have written a replacement; use it if so.
      const expires = expiresAt(disk.authToken)
      if (disk.authToken !== served && expires !== null && expires > now() + REFRESH_MARGIN)
        return remember(disk)
      return cooling() ? cooled(disk) : remember(await officialRefresh())
    },
  }
}
