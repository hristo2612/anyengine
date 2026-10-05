export interface Account {
  id: string
  label: string
  kind: 'home' | 'managed'
  vendorAccountId: string | null
  email: string | null
  planType: string | null
  login: 'ready' | 'needs-login'
}
export interface AccountRegistry {
  version: 1
  active: string
  home: string
  generation: number
  rotation: { enabled: boolean; threshold: number; cooldownMs: number }
  replay: 'none' | 'continue-prompt'
  accounts: Account[]
}
export interface AccountPaths {
  root: string
  canonical: string
  overlay: string
  registry: string
  ledger: string
  journal: string
  limits: string
}
export interface ProcessIdentity {
  pid: number
  pgid: number
  start: string
}
export type SwitchReason = 'manual' | 'usage-limit' | 'threshold' | 'off'
export interface OwnerToken {
  transaction: string
  claim: number
  process: ProcessIdentity
}
export interface Participant {
  id: string
  kind: 'adapter' | 'broker' | 'probe' | 'maintenance' | 'login'
  process: ProcessIdentity
  socket: string
  generation: number
}
export type FamilyPurpose = 'model' | 'probe' | 'login' | 'bootstrap'
export interface FamilyIntent {
  id: string
  participant: string
  account: string
  purpose: FamilyPurpose
  generation: number
  supervisor: ProcessIdentity
}
export interface Family extends FamilyIntent {
  native: ProcessIdentity | null
}
export interface WorkLease {
  id: string
  generation: number
  release(): Promise<void>
}
