import {
  accountUpdatedFor,
  RESERVE_ACCOUNT_READ,
  RESERVE_ACCOUNT_UPDATED,
  RESERVE_AUTH_STATUS,
  RESERVE_FIRST_READ_TIMEOUT_MS,
  RESERVE_POLL_MS,
  ReserveState,
  stripReserveMarkers,
} from './reserve.mjs'
import type { WireMessage } from './types.mjs'
import { debugLog } from './util.mjs'

// Legacy opt-in strips reserve markers even before the account is limited.
export function sanitizeRateLimitPayload<T>(value: T): T {
  if ((process.env.ANYENGINE_HIDE_RATE_LIMIT_UPSELL ?? '').trim() !== '1') return value
  return stripReserveMarkers(value)
}

interface ReserveClient {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>
  running(): boolean
  stopping(): boolean
  onMessage(message: WireMessage): void
}

// Desktop-facing reserve state remains separate from the real child's RPCs.
export class CodexUpstreamReserve {
  private readonly client: ReserveClient
  private readonly state: ReserveState
  private timer: NodeJS.Timeout | null = null

  constructor(client: ReserveClient, enabled?: boolean) {
    this.client = client
    this.state = new ReserveState(enabled)
  }

  get limited(): boolean {
    return this.state.limited
  }

  async start(): Promise<void> {
    if (!this.state.active || this.timer || this.client.stopping()) return
    this.timer = setInterval(() => {
      void this.readRateLimits(10_000)
    }, RESERVE_POLL_MS)
    this.timer.unref()
    // The desktop drops notifications until its initialize result arrives.
    await this.readRateLimits(RESERVE_FIRST_READ_TIMEOUT_MS, false)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  notification(message: WireMessage): WireMessage {
    if ('method' in message && /rateLimits/i.test(message.method) && 'params' in message) {
      if (this.state.observeUpdate(message.params)) void this.announceAccount()
      return { ...message, params: this.maskRateLimits(message.params) }
    }
    if (this.limited && 'method' in message && message.method === 'account/updated')
      return { ...message, params: RESERVE_ACCOUNT_UPDATED }
    return message
  }

  transformResult(method: string, result: unknown): unknown {
    if (/rateLimits/i.test(method)) {
      this.state.observeRead(result, method)
      return this.maskRateLimits(result)
    }
    if (!this.limited) return result
    if (method === 'account/read') return RESERVE_ACCOUNT_READ
    if (method === 'getAuthStatus') return RESERVE_AUTH_STATUS
    return result
  }

  private maskRateLimits<T>(value: T): T {
    return this.limited ? stripReserveMarkers(value) : sanitizeRateLimitPayload(value)
  }

  private async readRateLimits(timeoutMs: number, announce = true): Promise<void> {
    if (!this.client.running() || this.client.stopping()) return
    try {
      const result = await this.client.request('account/rateLimits/read', {}, timeoutMs)
      if (this.state.observeRead(result, 'poll') && announce) await this.announceAccount()
    } catch (error) {
      debugLog('reserve.readFailed', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async announceAccount(): Promise<void> {
    if (this.limited) {
      this.client.onMessage({
        jsonrpc: '2.0',
        method: 'account/updated',
        params: RESERVE_ACCOUNT_UPDATED,
      })
      return
    }
    try {
      const params = accountUpdatedFor(await this.client.request('account/read', {}, 10_000))
      if (params) this.client.onMessage({ jsonrpc: '2.0', method: 'account/updated', params })
    } catch (error) {
      debugLog('reserve.announceFailed', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
