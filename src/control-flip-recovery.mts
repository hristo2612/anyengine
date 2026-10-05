// One lifecycle boundary for forward flips and recovery. The layer APIs own
// restoration; this controller owns app-down, restart and terminal verification.
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { returnHomeBeforeOff } from './control-accounts-bootstrap.mjs'
import { cleanModelsCache, inspectModelsCache } from './control-cache.mjs'
import type { Say } from './control-cli.mjs'
import { executingLib, flipPaths } from './control-flip-options.mjs'
import { applyOffFiles, finishOff, restoreSharedConfig, retireOff } from './control-install.mjs'
import { configAt } from './control-install-on.mjs'
import { loadJob, plistPath, unloadJob } from './control-launchd.mjs'
import { regularBytes } from './control-layer-state.mjs'
import type { Layer } from './control-layers.mjs'
import {
  LayerWriter,
  m0Active,
  readLayers,
  recoveryPaths,
  restoreChange,
  writeLayers,
} from './control-layers.mjs'
import {
  activeUpgrade,
  readM2Baseline,
  refreshM2LayersHash,
  retireM2Upgrade,
} from './control-m2-upgrade.mjs'
import {
  classifyCodexProcesses,
  type Expect,
  type FlipDeps,
  type FrozenIdentity,
  postflight,
} from './control-postflight.mjs'
import { validateSnapshot } from './control-postflight-evidence.mjs'
import { offScript, publishRecovery, shellQuote } from './control-scripts.mjs'
import { processOwnership, type System } from './control-system.mjs'

export interface Stop {
  requested: NodeJS.Signals | null
}
export interface FlipContext {
  system: System
  root: string
  deps: FlipDeps
  say: Say
  stop: Stop
  marker: (phase: string, state?: Record<string, unknown>) => void
  recoverM3?: (noRestart: boolean) => Promise<boolean>
  recoverM2?: (noRestart: boolean) => Promise<boolean>
}
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
export function interrupted(ctx: FlipContext): void {
  if (ctx.stop.requested) throw new Error(`flip interrupted by ${ctx.stop.requested}`)
}
export function down(ctx: FlipContext): void {
  if (ctx.system.appRunning())
    throw new Error('configured app must exit before changing dependencies')
}
export async function quiet(
  ctx: FlipContext,
  minutes: number,
  recovery: boolean,
  force = false,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (!recovery) interrupted(ctx)
    const check = ctx.deps.preflip(30)
    if (check.staged) {
      if (!recovery) throw new Error(`staged update: ${check.text}`)
      ctx.say(`staged update expected on the way back: ${check.text}\n`)
    }
    if (
      force ||
      check.quiet ||
      (recovery &&
        check.staged &&
        check.text.includes('preflip-check: not quiet: an app update is staged') &&
        !/preflip-check: (not quiet; wait|cannot tell)/.test(check.text))
    )
      return
    if (attempt >= minutes * 12)
      throw new Error(
        `app is not quiet: ${check.text}; resume waits for a quiet app; run again or use --force`,
      )
    await ctx.system.sleep(5000)
  }
}
export function recoveryNotice(ctx: FlipContext): void {
  const m2 = readM2Baseline(ctx.root)
  if (m2 && m2.phase !== 'rolled-back') {
    ctx.say(
      `M2 recovery retained: /bin/bash ${shellQuote(join(ctx.root, 'recovery/m2/recover.sh'))}; instructions: ${join(ctx.root, 'recovery/m2/RECOVER.txt')}\n`,
    )
    return
  }
  ctx.say(
    `Recovery retained: /bin/bash ${shellQuote(recoveryPaths(ctx.root).entry)}; instructions: ${recoveryPaths(ctx.root).instructions}\n`,
  )
}
export function prepareRecovery(ctx: FlipContext, selected?: string): void {
  const { root, system } = ctx
  const file = readLayers(root)
  if (file.recovery && !selected) {
    const expected = offScript(file.layers, {
      root,
      app: system.app,
      bundleId: 'com.openai.codex',
      codexHome: flipPaths(system).codexHome,
    })
    if (!regularBytes(file.recovery.entry).equals(Buffer.from(expected)))
      throw new Error('private recovery entry changed; preserve existing authority')
    recoveryNotice(ctx)
    return
  }
  const pins = new Set(file.recovery?.pinnedLibs ?? [])
  const controlLib = file.recovery?.controlLib ?? executingLib()
  pins.add(controlLib)
  if (selected) pins.add(selected)
  const snapshot = ctx.deps.currentSnapshot()
  if (snapshot.libDir) pins.add(snapshot.libDir)
  file.recovery = { entry: recoveryPaths(root).entry, controlLib, pinnedLibs: [...pins] }
  // Publish the private Node-free entry before this flip can downgrade a public CLI.
  publishRecovery({
    root,
    app: system.app,
    bundleId: 'com.openai.codex',
    codexHome: flipPaths(system).codexHome,
  })
  writeLayers(root, file)
  const milestone = activeUpgrade(root)
  const baseline = readM2Baseline(root, milestone)
  if (baseline && baseline.phase !== 'rolled-back') refreshM2LayersHash(root, milestone)
  recoveryNotice(ctx)
}
export function freeze(ctx: FlipContext, expect: Expect): FrozenIdentity | undefined {
  if (expect === 'vanilla') return undefined
  const snapshot = structuredClone(ctx.deps.currentSnapshot())
  validateSnapshot(snapshot)
  const errors = ctx.deps.verifyLib(snapshot.libDir ?? '')
  if (errors.length) throw new Error(errors.join('; '))
  return { codeIdentity: snapshot.codeIdentity ?? '', key: snapshot.key, mode: snapshot.mode }
}
export const baselineOther = (ctx: FlipContext) => {
  const procs = ctx.system.processes()
  return classifyCodexProcesses(procs, ctx.system.app, processOwnership(ctx.system, procs))
    .filter((p) => p.kind === 'other')
    .map((p) => p.path)
}
export function expectation(ctx: FlipContext): Expect {
  const layers = readLayers(ctx.root).layers
  if (layers.some((l) => l.name === 'router')) return 'router'
  // Only a postflight expectation: active M0 rc is never recovery authority.
  return layers.length || m0Active(ctx.system.home, null).rc ? 'adapter' : 'vanilla'
}
export function cacheClean(ctx: FlipContext, layer: Layer | undefined): void {
  if (!layer?.cleansCache) return
  down(ctx)
  const result = cleanModelsCache(
    flipPaths(ctx.system).codexHome,
    new Set(configAt(ctx.root).claude.models.map((m) => m.id)),
    join(layer.rollbackDir, `cache-${randomUUID()}`),
  )
  if (result.report.parseError) throw new Error(`cache retained: ${result.report.parseError}`)
}
export class ReopenFailure extends Error {}
export async function windowRun(
  ctx: FlipContext,
  noRestart: boolean,
  action: () => void | Promise<void>,
): Promise<Date> {
  if (noRestart) {
    down(ctx)
    await action()
    return ctx.system.now()
  }
  let quit = false
  let failure: unknown
  try {
    ctx.marker('quit', { quitDone: false })
    if (!ctx.system.quitApp(30_000))
      throw new Error('configured app quit failed; dependencies retained')
    quit = true
    down(ctx)
    ctx.marker('between', { quitDone: true })
    await action()
  } catch (error) {
    failure = error
  } finally {
    if (quit) {
      try {
        ctx.marker('open', { quitDone: true })
      } catch (error) {
        failure = new Error(
          `${failure ? `${message(failure)}; ` : ''}open marker: ${message(error)}`,
        )
      }
      try {
        ctx.system.openApp()
      } catch (error) {
        failure = new ReopenFailure(
          `${failure ? `${message(failure)}; ` : ''}reopen failed: ${message(error)}`,
        )
      }
    }
  }
  if (failure) throw failure
  return ctx.system.now()
}
export async function verify(
  ctx: FlipContext,
  expect: Expect,
  since: Date,
  before: string,
  frozen: FrozenIdentity | undefined,
  other: string[],
  recovery: boolean,
): Promise<boolean> {
  ctx.marker('postflight', { expect })
  const checks = await postflight(ctx.system, ctx.deps, {
    expect,
    since,
    appVersionBefore: before,
    versionChangeExpected: recovery,
    libVersion: frozen?.key.lib ?? null,
    routerUrl:
      expect === 'router'
        ? `http://127.0.0.1:${configAt(ctx.root).router.port}/backend-api/codex`
        : null,
    baselineOther: other,
    ...(frozen ? { frozen } : {}),
  })
  for (const check of checks)
    ctx.say(`${check.ok ? 'ok  ' : 'FAIL'} - ${check.name}: ${check.detail}\n`)
  if (expect !== 'router') {
    for (let attempt = 0; ; attempt += 1) {
      const cache = inspectModelsCache(
        flipPaths(ctx.system).codexHome,
        new Set(configAt(ctx.root).claude.models.map((m) => m.id)),
      )
      if (!cache.parseError && !cache.anyengine.length) break
      if (cache.parseError || attempt >= 15) {
        ctx.say('FAIL - models cache: still owned or unreadable\n')
        return false
      }
      await ctx.system.sleep(2000)
    }
  }
  return checks.every((c) => c.ok)
}
function lastGoodDown(ctx: FlipContext, layer: Layer): void {
  if (!layer.upgrade) throw new Error('last-good checkpoint missing')
  down(ctx)
  for (const item of [...readLayers(ctx.root).layers].reverse().filter((row) => row.upgrade))
    for (const change of [...item.changes].reverse()) {
      const result = restoreChange(change, item.rollbackDir, true, 'last-good')
      if (result.outcome === 'left-changed') throw new Error(`${change.target}: ${result.detail}`)
    }
  for (const label of layer.jobs) {
    down(ctx)
    const change = layer.changes.find((c) => c.target === plistPath(ctx.system.home, label))
    if (!change?.lastGood) throw new Error(`unknown prior activity for ${label}`)
    if (change.lastGood.kind === 'absent') unloadJob(ctx.system, label)
    else loadJob(ctx.system, label, change.target)
  }
  // Shared migration during an upgrade is uncommon, but must be reversed when
  // the immediate baseline did not own it. Existing pick preferences survive.
  if (layer.sharedConfig && !layer.upgrade.sharedConfig)
    restoreSharedConfig(layer.sharedConfig, ctx.system)
  cacheClean(ctx, layer)
}
export function restoreDown(ctx: FlipContext, route: 'last-good' | 'router' | 'all'): void {
  down(ctx)
  recoveryNotice(ctx)
  if (route === 'last-good') {
    const layer = readLayers(ctx.root).layers.find((l) => l.name === 'router')
    if (!layer) throw new Error('missing router last-good authority')
    lastGoodDown(ctx, layer)
  } else {
    const result = applyOffFiles(ctx.system, ctx.root, {
      routerOnly: route === 'router',
      deferRetirement: true,
      paths: flipPaths(ctx.system),
    })
    for (const row of result.results) ctx.say(`${row.outcome}: ${row.target}: ${row.detail}\n`)
    if (!result.ok) throw new Error('file restoration incomplete; recovery retained')
    finishOff(ctx.system, ctx.root, flipPaths(ctx.system), { deferRetirement: true })
  }
}
export function retireUpgrade(ctx: FlipContext, recovered: boolean): void {
  for (const layer of readLayers(ctx.root).layers.filter((row) => row.upgrade))
    new LayerWriter(ctx.root, layer, layer.name, randomUUID(), () =>
      publishRecovery({
        root: ctx.root,
        app: ctx.system.app,
        bundleId: 'com.openai.codex',
        codexHome: flipPaths(ctx.system).codexHome,
      }),
    ).finishUpgrade(recovered ? 'recovered' : 'committed')
}
export async function rollback(
  ctx: FlipContext,
  options: { force: boolean; waitQuietMinutes: number },
  all = false,
): Promise<boolean> {
  if (
    !all &&
    activeUpgrade(ctx.root) === 'm3' &&
    readLayers(ctx.root).layers.some((layer) => layer.name === 'router')
  ) {
    const baseline = readM2Baseline(ctx.root, 'm3')
    if (!baseline) throw new Error('M3 recovery baseline unavailable')
    ctx.marker('rollback', {
      failureTarget: 'm3',
      m3BaselineId: basename(baseline.rollbackDir),
      recoveryCommand: join(ctx.root, 'recovery/m3/recover.sh'),
    })
    if (!ctx.recoverM3)
      throw new Error('M3 recovery handoff unavailable; use retained absolute command')
    return ctx.recoverM3(false)
  }
  const before = ctx.system.appVersion()
  if (!before) throw new Error('configured app version unknown')
  const other = baselineOther(ctx)
  const upgrade = readLayers(ctx.root).layers.some((l) => l.upgrade)
  const routes: Array<'last-good' | 'router' | 'all'> = all
    ? ['all']
    : [...(upgrade ? ['last-good' as const] : []), 'router', 'all']
  for (const route of routes) {
    await quiet(ctx, options.waitQuietMinutes, true, options.force)
    let frozen: FrozenIdentity | undefined
    let expected: Expect = 'vanilla'
    const since = ctx.system.now()
    ctx.marker('rollback', { route })
    await windowRun(ctx, false, async () => {
      await returnHomeBeforeOff(ctx)
      restoreDown(ctx, route)
      expected = route === 'last-good' ? 'router' : expectation(ctx)
      frozen = freeze(ctx, expected)
    })
    if (await verify(ctx, expected, since, before, frozen, other, true)) {
      if (route === 'last-good') retireUpgrade(ctx, true)
      retireOff(ctx.root)
      if (!readLayers(ctx.root).layers.some((layer) => layer.name === 'router')) {
        retireM2Upgrade(ctx.root)
        retireM2Upgrade(ctx.root, 'm3')
      }
      ctx.marker('complete')
      return true
    }
    // Only failed health escalates. A restore/inspection failure retains its
    // authority for retry instead of tearing down a partly recovered baseline.
  }
  return false
}
