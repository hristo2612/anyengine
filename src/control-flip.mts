// Detached on/off/restart phases: read-only checks and scratch proof precede
// writes. Actual installation owns jobs, so it runs only after confirmed quit.
// Immutable initial layers and immediate last-good checkpoints remain distinct.

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapBeforeInstall, returnHomeBeforeOff } from './control-accounts-bootstrap.mjs'
import {
  finishClaudeUpgrade,
  installClaudeCode,
  prepareClaudeUpgrade,
  previewClaudeCode,
} from './control-claude.mjs'
import {
  admitEvidence,
  flipPaths,
  type OffOptions,
  type OnOptions,
  outsideApp,
  type RestartOptions,
  resolvePlan,
} from './control-flip-options.mjs'
import {
  baselineOther,
  cacheClean,
  down,
  expectation,
  type FlipContext,
  freeze,
  interrupted,
  message,
  prepareRecovery,
  quiet,
  ReopenFailure,
  recoveryNotice,
  restoreDown,
  retireUpgrade,
  rollback,
  verify,
  windowRun,
} from './control-flip-recovery.mjs'
import { applyOnFiles, applySharedConfig, retireOff } from './control-install.mjs'
import { configAt } from './control-install-on.mjs'
import { digest, jsonAt, object, regularBytes } from './control-layer-state.mjs'
import { readLayers } from './control-layers.mjs'
import { inspectM0 } from './control-m0-adoption.mjs'
import { activeUpgrade, needsMilestoneBaseline, retireM2Upgrade } from './control-m2-upgrade.mjs'
import type { FlipMarker } from './control-marker.mjs'
import type { Expect, FrozenIdentity } from './control-postflight.mjs'
import { proveRollback } from './control-proof.mjs'
import { clearDegraded, markProven, type ProofKey, sameKey } from './degraded.mjs'
import { validateNativeReceipt } from './smoke-evidence.mjs'

export { takeFlipLock } from './control-flip-lock.mjs'
export {
  insideTheApp,
  type OffOptions,
  type OnOptions,
  parseOffArgs,
  parseOnArgs,
  parseRestartArgs,
  type RestartOptions,
} from './control-flip-options.mjs'
export type { FlipContext, Stop } from './control-flip-recovery.mjs'

function beforeVersion(ctx: FlipContext): string {
  const value = ctx.system.appVersion()
  if (!value || !/^\d+(?:\.\d+)+\S*$/.test(value)) throw new Error('configured app version unknown')
  if (!ctx.deps.bundledCodex()) throw new Error('bundled Codex unavailable')
  return value
}
function bridge(ctx: FlipContext, file: string | null): void {
  if (file) {
    const value = jsonAt(file) // Invalid bytes remain an error, never fallback evidence.
    let accepted: FrozenIdentity | undefined
    try {
      const frozen = freeze(ctx, 'router')!
      const config = configAt(ctx.root)
      if (
        !object(value) ||
        !object(value.paths) ||
        !object(value.paths['native-fanout']) ||
        value.paths['native-fanout'].ok !== true ||
        !sameKey(value.key as ProofKey, frozen.key) ||
        value.codeIdentity !== frozen.codeIdentity ||
        value.mode !== frozen.mode ||
        !config.router.multiAgentV1
      )
        throw new Error('unsupported or mismatched native pre-proof')
      const receipt = validateNativeReceipt(
        value.paths['native-fanout'].native,
        frozen,
        config.smoke.claudeModel,
        config.smoke.gptModel,
        ctx.system.now(),
      )
      if (value.attempt !== receipt.attempt || value.at !== receipt.startedAt)
        throw new Error('native receipt attempt/time envelope mismatch')
      accepted = frozen
    } catch (error) {
      ctx.say(`native pre-proof rejected: ${message(error)}; starting bridge\n`)
    }
    if (accepted) {
      markProven(ctx.root, 'native-fanout', 'accepted correlated native pre-proof', accepted.key)
      clearDegraded(ctx.root, 'native-fanout')
      ctx.say('native pre-proof accepted for the frozen code/key/configured mode\n')
      return
    }
  }
  try {
    if (configAt(ctx.root).router.multiAgentV1) {
      ctx.say('native fan-out unproven; starting bridge until this build is proven\n')
    }
  } catch (error) {
    ctx.say(`native disabled by invalid settings; original config retained: ${message(error)}\n`)
    throw error
  }
}
function proof(ctx: FlipContext, plan: ReturnType<typeof resolvePlan>): void {
  const result = proveRollback(ctx.system, ctx.root, plan, {
    paths: flipPaths(ctx.system),
    scratchParent: tmpdir(),
  })
  for (const line of result.lines) ctx.say(`${line}\n`)
  if (!result.ok) throw new Error('scratch rollback proof failed')
}
async function recoverM2On(ctx: FlipContext, noRestart: boolean): Promise<void> {
  const recover = activeUpgrade(ctx.root) === 'm3' ? ctx.recoverM3 : ctx.recoverM2
  if (!recover)
    throw new Error('Milestone recovery handoff unavailable; use retained absolute command')
  await recover(noRestart)
}
function finishOn(ctx: FlipContext, recovered: boolean, m2: boolean): void {
  retireUpgrade(ctx, recovered)
  retireOff(ctx.root)
  if (m2) finishClaudeUpgrade(ctx.root)
  ctx.marker('complete')
}
function previewOn(
  ctx: FlipContext,
  plan: ReturnType<typeof resolvePlan>,
  planned: ReturnType<typeof applyOnFiles>,
): void {
  const shared = applySharedConfig(ctx.system, ctx.root, plan, {
    dryRun: true,
    paths: flipPaths(ctx.system),
  })
  if (planned.adoptedFrom) ctx.say(`would adopt M0 from ${planned.adoptedFrom}\n`)
  for (const path of new Set([...planned.wrote, ...shared.wrote])) ctx.say(`would write ${path}\n`)
  if (plan.claudeCode) previewClaudeCode(ctx)
  ctx.say('dry-run: source files, metadata, logs, marker and locks unchanged\n')
}
export async function runOn(ctx: FlipContext, options: OnOptions): Promise<number> {
  let m2 = false
  let changed = false
  let failedQuit = false
  let recovered = false
  let recoveryAttempted = false
  let fresh = false
  try {
    outsideApp(ctx.system)
    admitEvidence(ctx.system, ctx.root)
    if (options.nativeProof) jsonAt(options.nativeProof) // Fatal UTF8 before artifacts/mutation.
    const plan = resolvePlan(ctx.system, ctx.root, ctx.deps, options.lib)
    m2 = plan.claudeCode === true && needsMilestoneBaseline(ctx.root, plan.libDir)
    fresh = !readLayers(ctx.root).layers.length && !inspectM0(ctx.root, ctx.system.home)
    const before = beforeVersion(ctx)
    const other = baselineOther(ctx)
    if (options.noRestart && !options.dryRun) down(ctx)
    await quiet(ctx, options.waitQuietMinutes, false)
    const planned = applyOnFiles(ctx.system, ctx.root, plan, {
      dryRun: true,
      paths: flipPaths(ctx.system),
    })
    if (planned.refused) throw new Error(planned.refused)
    proof(ctx, plan)
    if (options.dryRun) {
      previewOn(ctx, plan, planned)
      return 0
    }
    const code = digest(regularBytes(join(plan.libDir, 'install-manifest.json')))
    const routerWasNew = !readLayers(ctx.root).layers.some((l) => l.name === 'router')
    ctx.marker('prepare', {
      routerLayerWasNew: routerWasNew,
      appVersionBefore: before,
      mutationsStarted: false,
    })
    if (m2) {
      prepareClaudeUpgrade(ctx, plan)
      changed = true
    }
    prepareRecovery(ctx, plan.libDir)
    await quiet(ctx, options.waitQuietMinutes, false)
    interrupted(ctx)
    let frozen: FrozenIdentity | undefined
    let expected: Expect = 'router'
    const since = ctx.system.now()
    failedQuit = true
    await windowRun(ctx, options.noRestart, async () => {
      failedQuit = false
      try {
        interrupted(ctx)
        await bootstrapBeforeInstall(ctx, plan)
        ctx.marker('files', { mutationsStarted: true })
        changed = true
        const applied = applyOnFiles(ctx.system, ctx.root, plan, {
          dryRun: false,
          paths: flipPaths(ctx.system),
        })
        if (applied.refused) throw new Error(applied.refused)
        bridge(ctx, options.nativeProof)
        interrupted(ctx)
        applySharedConfig(ctx.system, ctx.root, plan, {
          dryRun: false,
          paths: flipPaths(ctx.system),
        })
        cacheClean(
          ctx,
          readLayers(ctx.root).layers.find((l) => l.name === 'router'),
        )
        frozen = freeze(ctx, 'router')
        if (frozen?.key.lib !== plan.version || frozen.codeIdentity !== code)
          throw new Error('selected library changed since preflight')
        const health = await ctx.deps.routerHealth(20_000)
        if (health?.ok !== true || health.version !== plan.version)
          throw new Error('router did not become healthy on the selected library')
        if (plan.claudeCode) await installClaudeCode(ctx, plan)
        interrupted(ctx)
      } catch (error) {
        ctx.say(`on failed: ${message(error)}\n`)
        if (m2) throw error
        // A signal after quit restores before reopening, even without autoRollback.
        if (!changed || (!options.autoRollback && !ctx.stop.requested)) throw error
        recoveryAttempted = true
        const upgrade = readLayers(ctx.root).layers.some((l) => l.upgrade)
        restoreDown(ctx, upgrade ? 'last-good' : fresh ? 'all' : 'router')
        expected = upgrade ? 'router' : expectation(ctx)
        frozen = freeze(ctx, expected)
        recovered = true
      }
    })
    if (options.noRestart) {
      ctx.marker('awaiting-postflight')
      ctx.say('files applied while app is down; deployment postflight pending, recovery retained\n')
      return 1
    }
    const healthy = await verify(ctx, expected, since, before, frozen, other, recovered)
    if (healthy && (recovered || !ctx.stop.requested)) {
      finishOn(ctx, recovered, m2)
      return recovered ? 1 : 0
    }
    if (m2) {
      await recoverM2On(ctx, options.noRestart)
    } else if (options.autoRollback || ctx.stop.requested) await rollback(ctx, options, fresh)
    return 1
  } catch (error) {
    ctx.say(`on failed: ${message(error)}\n`)
    if (m2 && changed) {
      await recoverM2On(ctx, options.noRestart)
      return 1
    }
    if (
      !(error instanceof ReopenFailure) &&
      !recoveryAttempted &&
      changed &&
      !failedQuit &&
      !recovered &&
      !options.noRestart &&
      (options.autoRollback || ctx.stop.requested)
    ) {
      try {
        await rollback(ctx, options, fresh)
      } catch (recoveryError) {
        ctx.say(`rollback failed: ${message(recoveryError)}\n`)
      }
    }
    return 1
  }
}
export async function runOff(ctx: FlipContext, options: OffOptions): Promise<number> {
  try {
    const before = beforeVersion(ctx)
    const other = baselineOther(ctx)
    if (options.noRestart) down(ctx)
    await quiet(ctx, options.waitQuietMinutes, true, options.force)
    interrupted(ctx)
    prepareRecovery(ctx)
    ctx.marker('off-files', { routerOnly: options.routerOnly, appVersionBefore: before })
    // The marker records intent; the owning installer journals ordered restores after quit.
    await quiet(ctx, options.waitQuietMinutes, true, options.force)
    interrupted(ctx)
    let frozen: FrozenIdentity | undefined
    let expected: Expect = 'vanilla'
    const since = ctx.system.now()
    await windowRun(ctx, options.noRestart, async () => {
      await returnHomeBeforeOff(ctx)
      restoreDown(ctx, options.routerOnly ? 'router' : 'all')
      expected = expectation(ctx)
      if (!options.noRestart) frozen = freeze(ctx, expected)
    })
    const healthy =
      options.noRestart || (await verify(ctx, expected, since, before, frozen, other, true))
    if (ctx.stop.requested) {
      if (!options.noRestart) await rollback(ctx, options, !options.routerOnly)
      return 1
    }
    if (healthy) {
      retireOff(ctx.root)
      if (!readLayers(ctx.root).layers.some((layer) => layer.name === 'router')) {
        retireM2Upgrade(ctx.root)
        retireM2Upgrade(ctx.root, 'm3')
      }
      ctx.marker('complete')
      return 0
    }
    return 1
  } catch (error) {
    ctx.say(`off failed: ${message(error)}\n`)
    return 1
  }
}
export async function runRestart(ctx: FlipContext, options: RestartOptions): Promise<number> {
  try {
    const before = beforeVersion(ctx)
    const expected = expectation(ctx)
    const other = baselineOther(ctx)
    const frozen = freeze(ctx, expected)
    await quiet(ctx, options.waitQuietMinutes, false)
    prepareRecovery(ctx)
    await quiet(ctx, options.waitQuietMinutes, false)
    interrupted(ctx)
    ctx.marker('restart', { appVersionBefore: before })
    const since = ctx.system.now()
    await windowRun(ctx, false, () => {
      interrupted(ctx)
      cacheClean(
        ctx,
        readLayers(ctx.root).layers.find((l) => l.name === 'router'),
      )
    })
    const healthy =
      !ctx.stop.requested && (await verify(ctx, expected, since, before, frozen, other, false))
    if (healthy && !ctx.stop.requested) {
      ctx.marker('complete')
      return 0
    }
    await rollback(ctx, options)
    return 1
  } catch (error) {
    ctx.say(`restart failed: ${message(error)}\n`)
    return 1
  }
}
export async function resumeFlip(
  ctx: FlipContext,
  marker: FlipMarker,
  options: { force: boolean; waitQuietMinutes: number },
): Promise<number> {
  try {
    admitEvidence(ctx.system, ctx.root)
    recoveryNotice(ctx)
    if (marker.state.failureTarget === 'm3') {
      if (!ctx.recoverM3)
        throw new Error('M3 recovery handoff unavailable; use retained absolute command')
      await ctx.recoverM3(false)
      return 1
    }
    if (marker.state.failureTarget === 'm2') {
      if (!ctx.recoverM2)
        throw new Error('M2 recovery handoff unavailable; use retained absolute command')
      await ctx.recoverM2(false)
      return 1
    }
    if (marker.op === 'off') {
      await runOff(ctx, {
        ...options,
        yes: true,
        foreground: true,
        follow: true,
        routerOnly: marker.state.routerOnly === true || marker.args.includes('--router-only'),
        noRestart: false,
      })
    } else if (
      marker.op === 'on' &&
      (marker.state.mutationsStarted === false ||
        ['preflight', 'prepare', 'prove', 'quit'].includes(marker.phase)) &&
      marker.state.mutationsStarted !== true &&
      !readLayers(ctx.root).layers.some(
        (l) => l.pending || l.upgrade || l.changes.some((c) => c.pending),
      )
    ) {
      // Nothing installed yet: re-entry must not tear down a working M1 baseline.
      await quiet(ctx, options.waitQuietMinutes, true, options.force)
      if (!ctx.system.appRunning()) ctx.system.openApp()
      if (!ctx.system.appRunning()) throw new Error('app did not reopen during resume')
      ctx.marker('complete')
    } else if (marker.op === 'restart') {
      const before = beforeVersion(ctx)
      const expected = expectation(ctx)
      const frozen = freeze(ctx, expected)
      const other = baselineOther(ctx)
      await quiet(ctx, options.waitQuietMinutes, true, options.force)
      const since = ctx.system.now()
      await windowRun(ctx, false, () =>
        cacheClean(
          ctx,
          readLayers(ctx.root).layers.find((l) => l.name === 'router'),
        ),
      )
      if (await verify(ctx, expected, since, before, frozen, other, true)) ctx.marker('complete')
      else await rollback(ctx, options)
    } else await rollback(ctx, options)
  } catch (error) {
    ctx.say(`resume failed: ${message(error)}\n`)
  }
  return 1
}
