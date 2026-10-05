import { join, resolve } from 'node:path'
import { entry, privateFile } from './accounts-files.mjs'
import { AccountMetadata } from './accounts-metadata.mjs'
import type { Account, AccountPaths, AccountRegistry } from './accounts-types.mjs'

export const ACCOUNT_ID = /^[a-z][a-z0-9-]{0,47}$/
function keys(value: object, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Unknown account metadata key')
}
function validateAccount(a: Account): void {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('Invalid account')
  keys(a, ['id', 'label', 'kind', 'vendorAccountId', 'email', 'planType', 'login'])
  if (
    typeof a.id !== 'string' ||
    !ACCOUNT_ID.test(a.id) ||
    typeof a.label !== 'string' ||
    a.label.length > 120 ||
    /[\0\r\n]/.test(a.label)
  )
    throw new Error('Invalid account label or id')
  if (!['home', 'managed'].includes(a.kind) || !['ready', 'needs-login'].includes(a.login))
    throw new Error('Invalid account state')
  for (const field of ['vendorAccountId', 'email', 'planType'] as const)
    if (a[field] !== null && (typeof a[field] !== 'string' || a[field].length > 320))
      throw new Error('Invalid account identity metadata')
}
export function validateAccounts(value: unknown): AccountRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid account registry')
  const r = value as AccountRegistry
  keys(r, ['version', 'active', 'home', 'generation', 'rotation', 'replay', 'accounts'])
  if (r.version !== 1 || !Number.isSafeInteger(r.generation) || r.generation < 0)
    throw new Error('Unsupported account registry')
  if (!Array.isArray(r.accounts) || r.accounts.length === 0 || r.accounts.length > 32)
    throw new Error('Invalid account list')
  const ids = new Set<string>(),
    vendorIds = new Set<string>()
  for (const a of r.accounts) {
    validateAccount(a)
    if (ids.has(a.id)) throw new Error('Duplicate account id')
    if (a.vendorAccountId && vendorIds.has(a.vendorAccountId))
      throw new Error('Duplicate vendor account')
    if (a.vendorAccountId) vendorIds.add(a.vendorAccountId)
    ids.add(a.id)
  }
  if (
    !ids.has(r.home) ||
    !ids.has(r.active) ||
    r.accounts.filter((a) => a.kind === 'home').length !== 1 ||
    r.accounts.find((a) => a.id === r.home)?.kind !== 'home'
  )
    throw new Error('Invalid active or home account')
  if (!r.rotation || typeof r.rotation !== 'object' || Array.isArray(r.rotation))
    throw new Error('Invalid rotation policy')
  keys(r.rotation, ['enabled', 'threshold', 'cooldownMs'])
  if (
    typeof r.rotation.enabled !== 'boolean' ||
    !Number.isFinite(r.rotation.threshold) ||
    r.rotation.threshold < 1 ||
    r.rotation.threshold > 100 ||
    !Number.isSafeInteger(r.rotation.cooldownMs) ||
    r.rotation.cooldownMs < 0 ||
    !['none', 'continue-prompt'].includes(r.replay)
  )
    throw new Error('Invalid rotation policy')
  return structuredClone(r)
}
export function accountPaths(root: string, canonical: string): AccountPaths {
  root = resolve(root)
  return {
    root,
    canonical: resolve(canonical),
    overlay: join(root, 'codex-home'),
    registry: join(root, 'accounts.json'),
    ledger: join(root, 'accounts-state.sqlite'),
    journal: join(root, 'account-switch.json'),
    limits: join(root, 'limits.json'),
  }
}
export function accountHome(p: AccountPaths, id: string): string {
  if (!ACCOUNT_ID.test(id)) throw new Error('Invalid account id')
  return join(p.root, 'accounts', 'openai', id)
}
export function initialAccounts(p: AccountPaths): AccountRegistry {
  privateFile(join(p.canonical, 'auth.json'))
  return {
    version: 1,
    active: 'home',
    home: 'home',
    generation: 0,
    rotation: { enabled: false, threshold: 100, cooldownMs: 300_000 },
    replay: 'none',
    accounts: [
      {
        id: 'home',
        label: 'Home',
        kind: 'home',
        vendorAccountId: null,
        email: null,
        planType: null,
        login: entry(join(p.canonical, 'auth.json')) ? 'ready' : 'needs-login',
      },
    ],
  }
}
export function loadAccounts(p: AccountPaths): AccountRegistry {
  const metadata = new AccountMetadata(p)
  try {
    const value = validateAccounts(metadata.read<AccountRegistry>('registry').value)
    metadata.project()
    return value
  } finally {
    metadata.close()
  }
}
export function initializeAccounts(p: AccountPaths, r = initialAccounts(p)): void {
  const metadata = new AccountMetadata(p)
  try {
    metadata.initialize('registry', validateAccounts(r))
    metadata.initialize('limits', {})
    metadata.project()
  } finally {
    metadata.close()
  }
}
