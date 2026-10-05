import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { bootstrapAccounts, officialCodexVersion } from './accounts-bootstrap.mjs'
import { AccountLedger } from './accounts-ledger.mjs'
import { recoverManagedAccounts, rotateAccount } from './accounts-rotation.mjs'
import { accountPaths, initializeAccounts } from './accounts-store.mjs'
import { standaloneEnvironment } from './broker-standalone.mjs'
import { flipPaths } from './control-flip-options.mjs'
import type { FlipContext } from './control-flip-recovery.mjs'
import type { OnPlan } from './control-install.mjs'

export async function bootstrapBeforeInstall(ctx: FlipContext, plan: OnPlan): Promise<void> {
  if (!existsSync(join(plan.libDir, 'dist', 'src', 'accounts-bootstrap.mjs'))) return
  const binary = ctx.deps.bundledCodex()
  if (!binary) throw new Error('Official Codex unavailable for canonical state bootstrap')
  const paths = accountPaths(ctx.root, flipPaths(ctx.system).codexHome)
  initializeAccounts(paths)
  const ledger = new AccountLedger(paths)
  try {
    if (ledger.state().phase !== 'open') await recoverManagedAccounts(ledger)
    const env = standaloneEnvironment(paths.canonical, process.env)
    ctx.say('Preparing shared Codex state without a model turn…\n')
    await bootstrapAccounts(ledger, { binary, version: officialCodexVersion(binary, env), env })
  } finally {
    ledger.close()
  }
}

export async function returnHomeBeforeOff(ctx: FlipContext): Promise<void> {
  const paths = accountPaths(ctx.root, flipPaths(ctx.system).codexHome)
  if (!existsSync(paths.ledger)) return
  const ledger = new AccountLedger(paths)
  try {
    if (ledger.state().phase !== 'open') await recoverManagedAccounts(ledger)
    ledger.metadata.editRegistry((r) => ({
      ...r,
      rotation: { ...r.rotation, enabled: false },
      replay: 'none',
    }))
    ledger.metadata.project()
    if (ledger.registry().active !== ledger.registry().home)
      await rotateAccount(ledger, ledger.registry().home, 'off')
  } finally {
    ledger.close()
  }
}
