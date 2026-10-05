import type { AccountParticipant } from './accounts-participant.mjs'
import type { ObservationPermit, ObservationSample } from './limits-store.mjs'
import { asRecord } from './rpc-shape.mjs'
import { debugLog } from './util.mjs'

export class AccountObservations {
  private readonly runtime: AccountParticipant
  private readonly pid: () => number | null
  private permit: ObservationPermit | null = null
  constructor(runtime: AccountParticipant, pid: () => number | null) {
    this.runtime = runtime
    this.pid = pid
    runtime.setQuotaRecorder((scope) => {
      try {
        return runtime.limits.accept({
          sample: this.sample(),
          kind: 'openai-quota-error',
          payload: { scope },
        })
      } catch {
        return false
      }
    })
  }
  private sample(): ObservationSample {
    const f = this.runtime.ledger.holders().find((f) => f.native?.pid === this.pid())
    if (!f) throw new Error('Account observation family unavailable')
    if (this.permit?.familyId !== f.id) this.permit = this.runtime.limits.issue(f.id, f.id, 1)
    return this.runtime.limits.sample(this.permit)
  }
  before(method: string): ObservationSample | undefined {
    if (method !== 'account/rateLimits/read' && method !== 'model/list') return undefined
    try {
      return this.sample()
    } catch {
      return undefined
    }
  }
  observe(method: string, payload: unknown, observation?: unknown): void {
    this.runtime.policy.observe(method, payload)
    if (!['account/rateLimits/read', 'account/rateLimits/updated', 'model/list'].includes(method))
      return
    try {
      const sample = method.endsWith('/updated')
        ? this.sample()
        : (observation as ObservationSample | undefined)
      if (!sample) return
      const accountId = asRecord(payload).accountId
      this.runtime.limits.accept({
        sample,
        kind:
          method === 'model/list'
            ? 'openai-catalog'
            : method.endsWith('/read')
              ? 'openai-read'
              : 'openai-update',
        payload,
        ...(typeof accountId === 'string'
          ? { identity: { vendorAccountId: accountId, email: null, planType: null } }
          : {}),
      })
      this.runtime.ledger.metadata.project()
      this.runtime.policy.wake()
    } catch {
      debugLog('limits.observationRejected', { method })
    }
  }
  close(): void {
    if (this.permit) this.runtime.limits.revoke(this.permit.familyId)
    this.permit = null
  }
}
