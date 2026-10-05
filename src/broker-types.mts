export type { Json, Obj } from './vendor/claude-code-proxy/types.mjs'

export interface ActiveAccount {
  home: string
  generation: number
}

export interface AccountAdmission {
  quota?(lease: BrokerLease, model: string): void
  begin(signal?: AbortSignal): Promise<{ generation: number; release(): Promise<void> }>
}

export interface AuthStatus {
  authMethod: string | null
  authToken: string | null
  requiresOpenaiAuth: boolean
}

export interface AuthSource {
  id: string
  generation: number
  home: string
  kind?: 'adapter' | 'standalone'
  request(
    method: 'getAuthStatus',
    params: { includeToken: true; refreshToken: boolean },
  ): Promise<AuthStatus>
}

export interface SourceSelection {
  revision: number
  source: AuthSource | null
}

export interface BrokerOwner {
  current(): SourceSelection
  source(): Promise<SourceSelection & { source: AuthSource }>
  onChange(listener: (selection: SourceSelection) => void): () => void
  stopSources(): Promise<void>
  close(): Promise<void>
}

export interface BrokerLease {
  bearer: string
  accountId: string
  generation: number
  sourceId: string
  sourceRevision: number
  cacheRevision: number
}

export interface TokenBroker {
  get(options?: { rejected?: BrokerLease }): Promise<BrokerLease>
  invalidate(generation: number): void
  isCurrent(lease: BrokerLease): boolean
  close(): Promise<void>
  status(): {
    ready: boolean
    source: 'adapter' | 'standalone' | 'none'
    generation: number
    reason: string | null
  }
}
