import type { AccountParticipant } from './accounts-participant.mjs'
import { officialAccountIdentity, readParkedHome } from './accounts-probe.mjs'
import type { CodexUpstream } from './codex-upstream.mjs'

export class HomeDesktopIdentity {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly runtime: AccountParticipant
  private readonly env: NodeJS.ProcessEnv
  constructor(runtime: AccountParticipant, env: NodeJS.ProcessEnv) {
    this.runtime = runtime
    this.env = env
  }
  async request(method: string, params: unknown): Promise<unknown> {
    if (
      [
        'account/logout',
        'account/login/start',
        'account/login/cancel',
        'loginChatGpt',
        'loginApiKey',
        'logout',
      ].includes(method) &&
      this.runtime.ledger.registry().active !== this.runtime.ledger.registry().home
    )
      throw new Error('Return to the Home account before changing the desktop login')
    if (method !== 'account/read' && method !== 'getAuthStatus') return undefined
    const read = this.tail
      .catch(() => {})
      .then(() => {
        const r = this.runtime.ledger.registry()
        if (r.active === r.home) return undefined
        return readParkedHome({ ledger: this.runtime.ledger, env: this.env }, method, params)
      })
    // Serialize Home metadata readers; no Home model work runs while it is parked.
    this.tail = read.then(
      () => {},
      () => {},
    )
    return read
  }
}
export async function captureHomeIdentity(
  upstream: CodexUpstream,
  runtime: AccountParticipant,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const r = runtime.ledger.registry()
  const identity = officialAccountIdentity(
    r.active === r.home
      ? await upstream.request('account/read', { refreshToken: false }, 10_000)
      : await readParkedHome({ ledger: runtime.ledger, env }, 'account/read', {
          refreshToken: false,
        }),
  )
  runtime.ledger.metadata.editRegistry((current) => {
    const home = current.accounts.find((a) => a.id === current.home)
    if (!home) throw new Error('Home account missing')
    if (!identity) home.login = 'needs-login'
    else {
      home.email = identity.email
      home.planType = identity.planType
      home.login = 'ready'
    }
    return current
  })
  runtime.ledger.metadata.project()
}
