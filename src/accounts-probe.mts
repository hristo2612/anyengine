import { randomUUID } from 'node:crypto'
import { createAccountFamily } from './accounts-family.mjs'
import type { AccountLedger } from './accounts-ledger.mjs'
import { identifyProcess } from './accounts-processes.mjs'
import { accountHome } from './accounts-store.mjs'
import { standaloneEnvironment } from './broker-standalone.mjs'
import { resolveBundledCodex } from './bundled-codex.mjs'
import { CodexUpstream } from './codex-upstream.mjs'
import { decodeOpenAIRead, exhaustedUntil } from './limits-openai.mjs'
import type { LimitsStore, ObservationSample } from './limits-store.mjs'
import { asRecord } from './rpc-shape.mjs'

interface ParkedInput {
  ledger: AccountLedger
  account: string
  binary?: string
  env?: NodeJS.ProcessEnv
}
// A short official metadata-only child owns its credential slot until it is joined.
async function withParkedAccount<T>(
  input: ParkedInput,
  read: (upstream: CodexUpstream, familyId: string) => Promise<T>,
): Promise<T> {
  const { ledger, account } = input,
    registry = ledger.registry(),
    state = ledger.state()
  if (state.active === account) throw new Error('Active account readings are passive')
  if (!registry.accounts.some((a) => a.id === account)) throw new Error('Unknown parked account')
  const identity = identifyProcess(process.pid)
  if (!identity) throw new Error('Probe ownership unknown')
  const participant = {
    id: randomUUID(),
    kind: 'probe' as const,
    process: identity,
    socket: '',
    generation: state.generation,
  }
  let registered = false,
    work: ReturnType<AccountLedger['begin']> | null = null,
    lifecycle: ReturnType<typeof createAccountFamily> | null = null,
    upstream: CodexUpstream | null = null,
    timer: NodeJS.Timeout | undefined
  try {
    ledger.register(participant)
    registered = true
    work = ledger.begin(participant.id, state.generation)
    lifecycle = createAccountFamily(ledger, participant, { account, purpose: 'probe' })
    const home =
      account === registry.home
        ? ledger.metadata.paths.canonical
        : accountHome(ledger.metadata.paths, account)
    const env = input.env ?? process.env,
      binary = input.binary ?? resolveBundledCodex(env).path
    if (!binary) throw new Error('Official Codex unavailable')
    const child = (upstream = new CodexUpstream({
      binary,
      args: ['-c', 'mcp_servers={}', 'app-server', '--listen', 'stdio://'],
      env: standaloneEnvironment(home, env),
      reserveEnabled: false,
      maxRestarts: 0,
      processLifecycle: lifecycle,
      onMessage: () => {},
    }))
    return await Promise.race([
      (async () => {
        child.start()
        await child.initialize(
          { clientInfo: { name: 'anyengine-account-metadata', version: '0.1.0' } },
          20_000,
        )
        child.markInitialized()
        const f = ledger.holders(account).find((f) => f.participant === participant.id)
        if (!f) throw new Error('Probe family missing')
        return read(child, f.id)
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Probe timed out')), 20_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
    await upstream?.stop()
    await lifecycle?.stopAll()
    await work?.release()
    if (registered) ledger.retireParticipant(participant.id, participant.process)
  }
}

export async function readParkedHome(
  input: Omit<ParkedInput, 'account'>,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method !== 'account/read' && method !== 'getAuthStatus')
    throw new Error('Not a Home identity method')
  const p = asRecord(params),
    home = input.ledger.registry().home
  return withParkedAccount({ ...input, account: home }, async (child) => {
    const result = await child.request(
      method,
      method === 'account/read'
        ? { refreshToken: p.refreshToken === true }
        : { includeToken: p.includeToken === true, refreshToken: p.refreshToken === true },
      10_000,
    )
    if (method === 'account/read') {
      const identity = officialAccountIdentity(result)
      return {
        account: identity ? { type: 'chatgpt', ...identity } : null,
        requiresOpenaiAuth: true,
      }
    }
    const status = asRecord(result)
    if (
      (status.authMethod !== null && typeof status.authMethod !== 'string') ||
      (status.authToken !== null && typeof status.authToken !== 'string') ||
      typeof status.requiresOpenaiAuth !== 'boolean'
    )
      throw new Error('Official Home authentication unavailable')
    // The bearer is returned directly to the desktop and never written to metadata.
    return {
      authMethod: status.authMethod,
      authToken: p.includeToken === true ? status.authToken : null,
      requiresOpenaiAuth: status.requiresOpenaiAuth,
    }
  })
}

export function officialAccountIdentity(value: unknown) {
  const r = asRecord(value),
    a = asRecord(r.account)
  if (r.account === null) return null
  if (
    a.type !== 'chatgpt' ||
    (a.email !== null && typeof a.email !== 'string') ||
    typeof a.planType !== 'string'
  )
    throw new Error('Official ChatGPT account metadata unavailable')
  return { email: a.email as string | null, planType: a.planType }
}
export async function probeParked(input: {
  ledger: AccountLedger
  limits: LimitsStore
  account: string
  binary?: string
  env?: NodeJS.ProcessEnv
}): Promise<'read' | 'throttled' | 'unavailable' | 'needs-login'> {
  const { ledger, limits, account } = input,
    registry = ledger.registry(),
    state = ledger.state()
  if (state.active === account) throw new Error('Active account readings are passive')
  if (!registry.accounts.some((a) => a.id === account)) throw new Error('Unknown parked account')
  const attemptedAt = Date.now()
  const previous = limits.readings()[account],
    reset = previous ? exhaustedUntil(previous) : null
  if (reset !== null && attemptedAt < reset + 1000) return 'throttled'
  if (!ledger.reserveProbe(account, attemptedAt)) return 'throttled'
  let sample: ObservationSample | null = null,
    familyId: string | null = null
  try {
    return await withParkedAccount(input, async (upstream, id) => {
      familyId = id
      sample = limits.sample(limits.issue(id, id, 1), attemptedAt)
      try {
        const identity = officialAccountIdentity(
          await upstream.request('account/read', { refreshToken: true }, 10_000),
        )
        if (!identity) throw new Error('needs-login')
        const payload = decodeOpenAIRead(
          await upstream.request('account/rateLimits/read', {}, 10_000),
        )
        const accepted = limits.accept({
          sample,
          kind: 'openai-read',
          payload,
          identity: { ...identity, vendorAccountId: payload.accountId ?? null },
        })
        if (!accepted) throw new Error('Probe identity quarantined or authority revoked')
        return 'read' as const
      } catch (error) {
        const status = (error as Error).message === 'needs-login' ? 'needs-login' : 'unavailable'
        limits.failure(account, state.generation, status, attemptedAt, sample)
        return status
      } finally {
        limits.revoke(id)
      }
    })
  } catch (error) {
    const status = (error as Error).message === 'needs-login' ? 'needs-login' : 'unavailable'
    if (sample) limits.failure(account, state.generation, status, attemptedAt, sample)
    else limits.failure(account, state.generation, 'unavailable', attemptedAt)
    return status
  } finally {
    if (familyId) limits.revoke(familyId)
    ledger.metadata.project()
  }
}
