import { randomUUID } from 'node:crypto'
import { accountControl } from './accounts-control.mjs'
import { verifyCredentialLayout } from './accounts-credentials.mjs'
import {
  applyJournal,
  beginJournal,
  finishTransition,
  publishTransition,
  recoverAccounts,
  sealTransition,
} from './accounts-journal.mjs'
import type { AccountLedger } from './accounts-ledger.mjs'
import {
  familyAlive,
  identifyProcess,
  processAlive,
  sameProcess,
  stopFamily,
} from './accounts-processes.mjs'
import type { OwnerToken, Participant, SwitchReason } from './accounts-types.mjs'
import { debugLog } from './util.mjs'

export function accountOwner(): OwnerToken {
  const identity = identifyProcess(process.pid)
  if (!identity) throw new Error('Account switch owner identity unknown')
  return { transaction: randomUUID(), claim: 1, process: identity }
}
export async function retireExitedParticipants(ledger: AccountLedger): Promise<void> {
  for (const p of ledger.participants()) {
    const state = processAlive(p.process)
    if (state === 'unknown') throw new Error('Account participant ownership unknown')
    if (state !== 'dead') continue
    for (const f of ledger.holders().filter((f) => f.participant === p.id)) {
      if (!f.native) {
        if (!sameProcess(f.supervisor, p.process))
          throw new Error('Unsettled credential launcher changed')
        // The run grant follows durable native attachment; this dead launcher never granted one.
        ledger.cancelUnlaunchedFamily(f.id, p.id)
        continue
      }
      if (familyAlive(f.native) !== 'dead') await stopFamily(f.native)
      ledger.releaseFamily(f.id)
    }
    ledger.retireDeadParticipant(p.id)
  }
  for (const f of ledger.holders().filter((f) => f.purpose === 'bootstrap')) {
    if (
      f.participant !== ledger.state().owner?.transaction ||
      processAlive(f.supervisor) !== 'dead'
    )
      continue
    if (!f.native) ledger.cancelUnlaunchedFamily(f.id, f.participant)
    else {
      await stopFamily(f.native)
      ledger.releaseFamily(f.id)
    }
  }
}
async function restart(participants: Participant[], generation: number): Promise<void> {
  for (const p of participants) {
    if (processAlive(p.process) === 'dead') continue
    await accountControl(p, { command: 'restart', generation })
  }
}
export async function rotateAccount(
  ledger: AccountLedger,
  to: string,
  reason: SwitchReason,
  signal: AbortSignal = AbortSignal.timeout(120_000),
  guard: () => boolean = () => true,
): Promise<void> {
  const initial = ledger.state()
  if (initial.active === to && initial.phase === 'open') return
  const owner = accountOwner()
  ledger.freeze(owner, to, reason, guard)
  let participants: Participant[] = [],
    stopped = false
  try {
    while (true) {
      signal.throwIfAborted()
      ledger.requireOwner(owner)
      await retireExitedParticipants(ledger)
      if (!ledger.workCount()) break
      await new Promise((done) => setTimeout(done, 50))
    }
    participants = ledger.participants()
    for (const p of participants) {
      signal.throwIfAborted()
      ledger.requireOwner(owner)
      await accountControl(p, { command: 'stop', owner, generation: initial.generation })
    }
    stopped = true
    await retireExitedParticipants(ledger)
    if (ledger.workCount() || ledger.holders().length)
      throw new Error('Account work or families remain')
    ledger.phase(owner, 'draining', 'stopped')
    for (const p of ledger.participants())
      await accountControl(p, { command: 'reconcile', owner, generation: initial.generation })
    if (!guard()) throw new Error('Account rotation decision is stale')
    const journal = sealTransition(ledger, owner)
    beginJournal(ledger, owner, journal)
    applyJournal(ledger, owner, journal)
    publishTransition(ledger, owner, journal)
    finishTransition(ledger, owner)
    await restart(participants, ledger.state().generation)
    debugLog('account.rotated', {
      from: initial.active,
      to,
      generation: ledger.state().generation,
      reason,
    })
  } catch (error) {
    if (ledger.state().phase === 'draining' && !stopped) {
      ledger.cancelDrain(owner, () =>
        verifyCredentialLayout(ledger.metadata.paths, ledger.registry()),
      )
      await restart(
        participants.filter((p) => !ledger.holders().some((f) => f.participant === p.id)),
        initial.generation,
      )
    } else if (!ledger.workCount() && !ledger.holders().length && ledger.state().phase !== 'open') {
      recoverAccounts(ledger, owner)
      await restart(participants, ledger.state().generation)
    }
    throw error
  }
}

export async function recoverManagedAccounts(ledger: AccountLedger): Promise<void> {
  const s = ledger.state()
  if (s.phase === 'open') {
    recoverAccounts(ledger, accountOwner())
    return
  }
  if (!s.owner) throw new Error('Account recovery owner unknown')
  const owner = { ...accountOwner(), transaction: s.owner.transaction, claim: s.owner.claim + 1 }
  ledger.adopt(owner, s.owner)
  await retireExitedParticipants(ledger)
  if (ledger.workCount()) throw new Error('Managed work still active; recovery remains frozen')
  const participants = ledger.participants()
  for (const p of participants)
    await accountControl(p, { command: 'stop', owner, generation: s.generation })
  recoverAccounts(ledger, owner)
  await restart(participants, ledger.state().generation)
}
