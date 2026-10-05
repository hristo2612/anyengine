import { readlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CredentialStamp,
  credentialInventory,
  planAuthMoves,
  verifyCredentialLayout,
} from './accounts-credentials.mjs'
import {
  type AuthOp,
  applyAuthOp,
  durableJson,
  entry,
  inverseAuthOp,
  metadataJson,
  syncDir,
} from './accounts-files.mjs'
import { verifySealedInventory } from './accounts-inventory.mjs'
import type { AccountLedger } from './accounts-ledger.mjs'
import { accountHome } from './accounts-store.mjs'
import type { AccountPaths, AccountRegistry, OwnerToken } from './accounts-types.mjs'

export interface SwitchJournal {
  version: 1
  owner: OwnerToken
  from: string
  to: string
  generation: number
  registryRevision: number
  phase: 'forward' | 'rollback' | 'committed'
  operations: AuthOp[]
  next: number
  reverseNext: number | null
  inventory: CredentialStamp[]
}
export function sealTransition(ledger: AccountLedger, owner: OwnerToken): SwitchJournal {
  return ledger.metadata.tx(() => {
    const s = ledger.requireOwner(owner),
      doc = ledger.metadata.read<AccountRegistry>('registry')
    if (s.phase !== 'stopped' || !s.intent || ledger.workCount() || ledger.holders().length)
      throw new Error('Account drain and credential-family exit required')
    if (
      s.intent.reason !== 'manual' &&
      s.intent.reason !== 'off' &&
      s.intent.reason !== 'bootstrap' &&
      !doc.value.rotation.enabled
    )
      throw new Error('Automatic rotation disabled during drain')
    const journal: SwitchJournal = {
      version: 1,
      owner,
      from: s.active,
      to: s.intent.to,
      generation: s.generation,
      registryRevision: doc.revision,
      phase: 'forward',
      operations: planAuthMoves(ledger.metadata.paths, doc.value, s.intent.to),
      next: 0,
      reverseNext: null,
      inventory: credentialInventory(ledger.metadata.paths, doc.value),
    }
    ledger.save({
      ...s,
      phase: 'sealed',
      sealed: { inventory: journal.inventory, operations: journal.operations },
    })
    return journal
  })
}
function validateOp(p: AccountPaths, j: SwitchJournal, op: AuthOp): void {
  const overlay = join(p.overlay, 'auth.json'),
    home = join(p.canonical, 'auth.json')
  if (op.kind === 'link' || op.kind === 'unlink') {
    if (op.path !== overlay || op.target !== home)
      throw new Error('Invalid credential link authority')
  } else if (op.kind === 'move') {
    const outgoing = op.from === overlay && op.to === join(accountHome(p, j.from), 'auth.json')
    const incoming = op.to === overlay && op.from === join(accountHome(p, j.to), 'auth.json')
    if (
      (!outgoing && !incoming) ||
      !Number.isSafeInteger(op.dev) ||
      !Number.isSafeInteger(op.ino) ||
      op.ino <= 0
    )
      throw new Error('Invalid credential move authority')
  } else throw new Error('Unknown credential operation')
}
export function readSwitchJournal(ledger: AccountLedger, owner: OwnerToken): SwitchJournal | null {
  const p = ledger.metadata.paths,
    value = metadataJson(p.journal)
  if (value === undefined) return null
  const j = value as SwitchJournal,
    s = ledger.requireOwner(owner)
  if (
    j.version !== 1 ||
    j.owner?.transaction !== owner.transaction ||
    !s.intent ||
    j.from !== s.intent.from ||
    j.to !== s.intent.to ||
    (j.generation !== s.generation && j.generation + 1 !== s.generation) ||
    !['forward', 'rollback', 'committed'].includes(j.phase) ||
    !Array.isArray(j.operations) ||
    j.operations.length > 2 ||
    !Number.isSafeInteger(j.next) ||
    j.next < 0 ||
    j.next > j.operations.length ||
    (j.reverseNext !== null &&
      (!Number.isSafeInteger(j.reverseNext) ||
        j.reverseNext < -1 ||
        j.reverseNext >= j.operations.length))
  )
    throw new Error('Account switch journal does not match its gate')
  for (const op of j.operations) validateOp(p, j, op)
  return j
}
function write(ledger: AccountLedger, owner: OwnerToken, j: SwitchJournal): void {
  ledger.requireOwner(owner)
  durableJson(ledger.metadata.paths.journal, { ...j, owner })
}
export function beginJournal(ledger: AccountLedger, owner: OwnerToken, j: SwitchJournal): void {
  if (entry(ledger.metadata.paths.journal)) throw new Error('Existing account recovery journal')
  write(ledger, owner, j)
  ledger.phase(owner, 'sealed', 'journal')
}
export function applyJournal(
  ledger: AccountLedger,
  owner: OwnerToken,
  j: SwitchJournal,
  checkpoint: (name: string) => void = () => {},
): void {
  if (j.phase !== 'forward' || ledger.requireOwner(owner).phase !== 'journal')
    throw new Error('Account forward transition refused')
  while (j.next < j.operations.length) {
    write(ledger, owner, j)
    const op = j.operations[j.next]
    if (!op) throw new Error('Missing credential operation')
    applyAuthOp(op)
    checkpoint(`renamed-${j.next}`)
    j.next++
    write(ledger, owner, j)
    checkpoint(`recorded-${j.next}`)
  }
}
export function publishTransition(
  ledger: AccountLedger,
  owner: OwnerToken,
  j: SwitchJournal,
): void {
  if (j.next !== j.operations.length) throw new Error('Account moves incomplete')
  verifySealedInventory(ledger.metadata.paths, ledger.registry(), j, [j.operations.length])
  verifyCredentialLayout(ledger.metadata.paths, { ...ledger.registry(), active: j.to })
  ledger.publish(owner, j.registryRevision)
  ledger.metadata.project()
  j.phase = 'committed'
  write(ledger, owner, j)
}
function undo(op: AuthOp): void {
  if (op.kind === 'move') {
    const before = entry(op.from),
      after = entry(op.to)
    if (before?.isFile() && before.dev === op.dev && before.ino === op.ino && !after) return
  } else {
    const current = entry(op.path)
    const correct = current?.isSymbolicLink() && readlinkSync(op.path) === op.target
    if (op.kind === 'link' && !current) return
    if (op.kind === 'unlink' && correct) return
  }
  applyAuthOp(inverseAuthOp(op))
}
export function finishTransition(
  ledger: AccountLedger,
  owner: OwnerToken,
  checkpoint: (name: string) => void = () => {},
): void {
  const p = ledger.metadata.paths
  const state = ledger.requireOwner(owner)
  if (state.sealed)
    verifySealedInventory(p, ledger.registry(), state.sealed, [
      state.phase === 'cleanup-commit' ? state.sealed.operations.length : 0,
    ])
  verifyCredentialLayout(p, ledger.registry())
  checkpoint('cleanup-verified')
  if (entry(p.journal)) {
    unlinkSync(p.journal)
    syncDir(p.root)
  }
  checkpoint('cleanup-unlinked')
  ledger.open(owner, () => verifyCredentialLayout(p, ledger.registry()))
  checkpoint('cleanup-open')
}
export function recoverAccounts(
  ledger: AccountLedger,
  replacement: OwnerToken,
  checkpoint: (name: string) => void = () => {},
): void {
  const s = ledger.state(),
    p = ledger.metadata.paths
  if (s.phase === 'open') {
    if (entry(p.journal)) throw new Error('Unowned account recovery journal')
    verifyCredentialLayout(p, ledger.registry())
    return
  }
  if (!s.owner) throw new Error('Account transition owner unknown')
  if (s.owner.transaction !== replacement.transaction || s.owner.claim !== replacement.claim)
    ledger.adopt(replacement, s.owner)
  ledger.requireOwner(replacement)
  if (ledger.workCount() || ledger.holders().length)
    throw new Error('Account recovery must join credential families first')
  const j = readSwitchJournal(ledger, replacement)
  if (!j) {
    if (
      ![
        'draining',
        'stopped',
        'bootstrap',
        'sealed',
        'cleanup-commit',
        'cleanup-rollback',
      ].includes(ledger.state().phase)
    )
      throw new Error('Account move journal missing; admission remains closed')
    if (
      ['sealed', 'cleanup-commit', 'cleanup-rollback'].includes(ledger.state().phase) &&
      !ledger.state().sealed
    )
      throw new Error('Sealed account inventory missing; admission remains closed')
    finishTransition(ledger, replacement, checkpoint)
    return
  }
  const r = ledger.registry()
  verifySealedInventory(
    p,
    r,
    j,
    j.phase === 'rollback' && j.reverseNext !== null
      ? [Math.max(0, j.reverseNext), Math.max(0, j.reverseNext + 1)]
      : [j.next, Math.min(j.next + 1, j.operations.length)],
  )
  if (r.active === j.to && r.generation === j.generation + 1) {
    verifyCredentialLayout(p, r)
    ledger.metadata.project()
    finishTransition(ledger, replacement, checkpoint)
    return
  }
  if (r.active !== j.from || r.generation !== j.generation)
    throw new Error('Account generation changed during recovery')
  if (j.reverseNext === null) j.reverseNext = Math.min(j.next, j.operations.length - 1)
  j.phase = 'rollback'
  write(ledger, replacement, j)
  const current = ledger.requireOwner(replacement)
  if (current.phase !== 'rolling-back') ledger.phase(replacement, current.phase, 'rolling-back')
  while (j.reverseNext >= 0) {
    write(ledger, replacement, j)
    const op = j.operations[j.reverseNext]
    if (!op) throw new Error('Missing inverse credential operation')
    undo(op)
    checkpoint(`reversed-${j.reverseNext}`)
    j.reverseNext--
    write(ledger, replacement, j)
    checkpoint(`reverse-recorded-${j.reverseNext}`)
  }
  verifyCredentialLayout(p, r)
  ledger.phase(replacement, 'rolling-back', 'cleanup-rollback')
  finishTransition(ledger, replacement, checkpoint)
}
