import {
  applyJournal,
  beginJournal,
  finishTransition,
  publishTransition,
  recoverAccounts,
  sealTransition,
} from '../../dist/src/accounts-journal.mjs'
import { AccountLedger } from '../../dist/src/accounts-ledger.mjs'
import { identifyProcess } from '../../dist/src/accounts-processes.mjs'
import { accountPaths } from '../../dist/src/accounts-store.mjs'

const [root, canonical, stop, to] = process.argv.slice(2)
const ledger = new AccountLedger(accountPaths(root, canonical))
const owner = { transaction: 'fixture-switch', claim: 1, process: identifyProcess(process.pid) }
const checkpoint = (name) => {
  if (name !== stop) return
  process.send({ checkpoint: name })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}
const at = async (name) => {
  if (name !== stop) return
  process.send({ checkpoint: name })
  await new Promise((resolve) => process.once('message', resolve))
}
if (to === 'recover') {
  recoverAccounts(ledger, { ...owner, claim: ledger.state().owner?.claim + 1 }, checkpoint)
  ledger.close()
  process.disconnect()
} else {
  ledger.freeze(owner, to, 'manual')
  await at('freeze')
  ledger.phase(owner, 'draining', 'stopped')
  await at('stopped')
  const j = sealTransition(ledger, owner)
  await at('sealed')
  beginJournal(ledger, owner, j)
  await at('journal')
  // Synchronous operations pause in a real process, so SIGKILL interrupts their caller.
  applyJournal(ledger, owner, j, checkpoint)
  publishTransition(ledger, owner, j)
  await at('published')
  finishTransition(ledger, owner, checkpoint)
  await at('finished')
  ledger.close()
  process.disconnect()
}
