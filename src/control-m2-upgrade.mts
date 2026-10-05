import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { enginePaths } from './anyengine-config.mjs'
import { flipPaths } from './control-flip-options.mjs'
import { configAt, type OnPlan } from './control-install-on.mjs'
import { jobLoaded, plistPath, ROUTER_LABEL, SMOKE_LABEL } from './control-launchd.mjs'
import {
  atomicFile,
  digest,
  type FileChange,
  type FileState,
  keepBytes,
  regularBytes,
  sameState,
  setSettled,
  statAt,
  stateAt,
  syncDirectory,
} from './control-layer-state.mjs'
import { type Layer, type RecordPhase, readLayers } from './control-layers.mjs'
import { generateM2Rollback, m2Dispatcher } from './control-m2-recovery-script.mjs'
import {
  admitM2Baseline,
  controlTarget,
  type M2Baseline,
  type M2Journal,
  m2Paths,
  m3ClaudeTarget,
  prepareM2Directory,
  type RecoveryMilestone,
  readM2Journal,
  writeM2Journal,
} from './control-m2-recovery-state.mjs'
import { readFlipMarker } from './control-marker.mjs'
import { shellQuote } from './control-scripts.mjs'
import { readStatusClaudeCode } from './control-status-evidence.mjs'
import type { System } from './control-system.mjs'
import { settingsView } from './router-messages.mjs'

export type { M2Baseline } from './control-m2-recovery-state.mjs'

function snapshot(target: string, directory: string): FileChange {
  const state = stateAt(target)
  if (state.kind === 'file') state.bytes = keepBytes(directory, regularBytes(target))
  return {
    target,
    before: state.kind,
    backup: state.bytes,
    mode: state.mode,
    beforeSha: state.sha,
    beforeLink: state.link,
    after: state.bytes,
    afterSha: state.sha,
    afterLink: state.link,
    afterMode: state.mode,
    pending: null,
  }
}

function targets(root: string, home: string, milestone: RecoveryMilestone): string[] {
  const layers = readLayers(root).layers
  return [
    ...new Set([
      ...(milestone === 'm3'
        ? layers.flatMap((l) =>
            l.changes.map((c) => c.target).filter((t) => m3ClaudeTarget(home, t)),
          )
        : []),
      join(root, 'lib/current'),
      join(root, 'bin/anyengine'),
      join(root, 'bin/anyengine-off'),
      join(root, 'runtime.env'),
      join(home, 'bin/codex'),
      plistPath(home, ROUTER_LABEL),
      plistPath(home, SMOKE_LABEL),
      join(root, 'RECOVER.txt'),
      join(root, 'recovery/anyengine-off'),
      ...layers
        .map((layer) => join(layer.rollbackDir, 'ROLLBACK.sh'))
        .filter((path) => statAt(path)),
    ]),
  ]
}

export function readM2Baseline(
  root: string,
  milestone: RecoveryMilestone = 'm2',
): M2Baseline | null {
  return readM2Journal(root, milestone)?.baseline ?? null
}

export function retainedM2Libraries(root: string, milestone: RecoveryMilestone = 'm2'): string[] {
  const baseline = readM2Baseline(root, milestone)
  return baseline && baseline.phase !== 'rolled-back' ? [baseline.priorLib] : []
}

// Fresh v1 installs and their upgrades recover through the layer checkpoints.
// Historical M1/M2 upgrades keep their independently retained milestone baseline.
export function needsMilestoneBaseline(root: string, libDir: string): boolean {
  if (!readLayers(root).layers.some((layer) => layer.name === 'router')) return false
  const milestone = existsSync(join(libDir, 'dist/src/accounts-bootstrap.mjs')) ? 'm3' : 'm2'
  const previous = readM2Journal(root, milestone)
  if (previous && previous.baseline.phase !== 'rolled-back') return true
  return (
    milestone !== 'm3' ||
    !existsSync(join(realpathSync(join(root, 'lib/current')), 'dist/src/accounts-managed.mjs'))
  )
}

export function prepareM2Upgrade(
  system: System,
  root: string,
  plan: OnPlan,
  milestone: RecoveryMilestone = 'm2',
): M2Baseline {
  const previous = readM2Journal(root, milestone)
  if (previous && previous.baseline.phase !== 'rolled-back') return previous.baseline
  const priorLib = realpathSync(join(root, 'lib/current'))
  const m1Mode = admitM2Baseline(system, root, plan, priorLib)
  if (priorLib === plan.libDir) throw new Error('M2 cannot be its own M1 baseline')
  if (milestone === 'm3') {
    if (existsSync(join(priorLib, 'dist/src/accounts-managed.mjs')))
      throw new Error('Restore and verify the accepted M2 library before preparing M3 recovery')
    const face = readStatusClaudeCode({
      root,
      home: system.home,
      layers: readLayers(root).layers.map((l) => l.name),
      current: priorLib.split('/').at(-1) ?? null,
      port: configAt(root).router.port,
      health: null,
    })
    if (!face.enabled || !face.settingsInstalled)
      throw new Error('Verified M2 Claude face required before M3 baseline')
    const result = system.exec(
      plan.recoveryCommands?.curl ?? '/usr/bin/curl',
      [
        '--silent',
        '--show-error',
        '--fail',
        '--max-time',
        '10',
        '--noproxy',
        '*',
        `http://127.0.0.1:${configAt(root).router.port}/control/claude-code/models`,
      ],
      { timeoutMs: 12000 },
    )
    if (
      result.status !== 0 ||
      result.stderr.trim() ||
      Buffer.byteLength(result.stdout) > 128000 ||
      !settingsView(JSON.parse(result.stdout)).models.length
    )
      throw new Error('Current M2 Claude catalog required before M3 baseline')
  }
  const baselineId = randomUUID()
  const paths = m2Paths(root, milestone)
  const rollbackDir = join(paths.directory, baselineId)
  prepareM2Directory(root, rollbackDir, milestone)
  const layers = regularBytes(enginePaths(root).layers, 2_000_000)
  const m1LayersBackup = join(rollbackDir, 'm1-layers.json')
  atomicFile(m1LayersBackup, layers, 0o600)
  const baseline: M2Baseline = {
    version: 1,
    rollbackDir,
    recoveryScript: join(rollbackDir, 'recover.sh'),
    recoveryJournal: join(rollbackDir, 'journal.json'),
    phase: 'prepared',
    priorLib,
    m1LayersBackup,
    m1LayersSha256: digest(layers),
    controlChanges: targets(root, system.home, milestone).map((target) =>
      snapshot(target, rollbackDir),
    ),
    jobs: [ROUTER_LABEL, SMOKE_LABEL].map((label) => ({
      label,
      plist: plistPath(system.home, label),
      loaded: jobLoaded(system, label),
    })),
  }
  const journal: M2Journal = {
    version: 1,
    baselineId,
    baseline,
    transactionId: null,
    sharedMarkerDetached: false,
    expectedLayersSha256: digest(layers),
    manifestSha256: digest(regularBytes(join(priorLib, 'install-manifest.json'), 2_000_000)),
    home: system.home,
    ...(milestone === 'm3' ? { canonical: flipPaths(system).codexHome } : {}),
    app: plan.app,
    bundleId: plan.bundleId,
    port: configAt(root).router.port,
    m1Mode,
    commands: {
      launchctl: '/bin/launchctl',
      osascript: '/usr/bin/osascript',
      open: '/usr/bin/open',
      pgrep: '/usr/bin/pgrep',
      plutil: '/usr/bin/plutil',
      curl: '/usr/bin/curl',
      ...plan.recoveryCommands,
    },
    checkpoint: null,
    conflicts: [],
    linkModes: Object.fromEntries(
      baseline.controlChanges
        .filter((change) => change.before === 'symlink')
        .map((change) => [change.target, (statAt(change.target)?.mode ?? 0) & 0o7777]),
    ),
  }
  writeM2Journal(root, journal, false, milestone)
  const script = generateM2Rollback(baseline, {
    root,
    app: plan.app,
    bundleId: plan.bundleId,
    milestone,
  })
  atomicFile(baseline.recoveryScript, Buffer.from(script), 0o700)
  atomicFile(
    paths.pointer,
    Buffer.from(
      `${JSON.stringify({
        script: baseline.recoveryScript,
        journal: baseline.recoveryJournal,
        baselineId,
        scriptSha256: digest(Buffer.from(script)),
      })}\n`,
    ),
    0o600,
  )
  atomicFile(paths.entry, Buffer.from(m2Dispatcher(root, milestone)), 0o700)
  atomicFile(
    paths.instructions,
    Buffer.from(
      `M2 rollback to verified M1 baseline ${baselineId}\n/bin/bash ${shellQuote(paths.entry)}\nPrivate journal: ${baseline.recoveryJournal}\nAfter interruption use this surviving absolute command.\n`,
    ),
    0o600,
  )
  writeM2Journal(root, journal, true, milestone)
  return baseline
}

function copiedState(state: FileState, source: string, destination: string): FileState {
  const result = { ...state }
  if (state.bytes) result.bytes = keepBytes(destination, regularBytes(join(source, state.bytes)))
  return result
}

function bindMarker(root: string, journal: M2Journal, milestone: RecoveryMilestone): void {
  const marker = readFlipMarker(root)
  if (
    marker?.state[`${milestone}BaselineId`] === journal.baselineId &&
    marker.state.failureTarget === milestone
  ) {
    if (
      journal.transactionId &&
      journal.transactionId !== marker.id &&
      journal.baseline.phase !== 'active'
    )
      throw new Error('M2 recovery belongs to another flip transaction')
    if (!journal.sharedMarkerDetached) journal.transactionId = marker.id
  }
}

export function recordM2ControlChanges(
  root: string,
  layer: Layer,
  phase: RecordPhase,
  milestone: RecoveryMilestone = 'm2',
): void {
  const journal = readM2Journal(root, milestone)
  if (!journal || journal.baseline.phase === 'rolled-back') return
  if (journal.sharedMarkerDetached)
    throw new Error('M2 shared control recording ended at recovery handoff')
  bindMarker(root, journal, milestone)
  for (const change of layer.changes) {
    if (
      !controlTarget(root, journal.home, change.target, journal.baseline) &&
      !(milestone === 'm3' && m3ClaudeTarget(journal.home, change.target))
    )
      continue
    let recorded = journal.baseline.controlChanges.find((item) => item.target === change.target)
    if (!recorded) {
      recorded = snapshot(change.target, journal.baseline.rollbackDir)
      journal.baseline.controlChanges.push(recorded)
    }
    if (phase === 'intent' && change.pending)
      recorded.pending = copiedState(
        change.pending,
        layer.rollbackDir,
        journal.baseline.rollbackDir,
      )
    else if (phase === 'settled') {
      const state = stateAt(change.target)
      if (state.kind === 'file')
        state.bytes = keepBytes(journal.baseline.rollbackDir, regularBytes(change.target))
      setSettled(recorded, state)
      recorded.pending = null
    }
  }
  if (phase === 'checkpoint') {
    for (const change of journal.baseline.controlChanges) {
      if (change.pending) continue
      const state = stateAt(change.target)
      if (state.kind === 'file')
        state.bytes = keepBytes(journal.baseline.rollbackDir, regularBytes(change.target))
      setSettled(change, state)
    }
  }
  journal.expectedLayersSha256 = digest(regularBytes(enginePaths(root).layers, 2_000_000))
  journal.baseline.phase = 'activating'
  writeM2Journal(root, journal, true, milestone)
}

export function recordM2RecoveryIntent(
  root: string,
  target: string,
  bytes: Buffer,
  mode: number,
  milestone: RecoveryMilestone = 'm2',
): (() => void) | undefined {
  const journal = readM2Journal(root, milestone)
  if (!journal || journal.baseline.phase === 'rolled-back') return
  if (journal.sharedMarkerDetached) throw new Error('M2 recovery publication after handoff')
  const claude = readLayers(root).layers.find((layer) => layer.name === 'claude-code')
  if (
    claude &&
    target === join(claude.rollbackDir, 'ROLLBACK.sh') &&
    !journal.baseline.controlChanges.some((change) => change.target === target)
  )
    return
  if (!controlTarget(root, journal.home, target, journal.baseline))
    throw new Error('M2 recovery intent outside recorded control targets')
  const change = journal.baseline.controlChanges.find((item) => item.target === target)
  if (!change) throw new Error('M2 recovery intent lacks an immediate M1 snapshot')
  change.pending = {
    kind: 'file',
    sha: digest(bytes),
    link: null,
    bytes: keepBytes(journal.baseline.rollbackDir, bytes),
    mode,
  }
  writeM2Journal(root, journal, true, milestone)
  const expected = change.pending
  return () => {
    const latest = readM2Journal(root, milestone)
    const recorded = latest?.baseline.controlChanges.find((item) => item.target === target)
    if (
      !latest ||
      latest.baselineId !== journal.baselineId ||
      latest.sharedMarkerDetached ||
      !recorded?.pending ||
      !sameState(recorded.pending, expected) ||
      !sameState(stateAt(target), expected)
    )
      throw new Error('M2 recovery publication changed before settlement')
    setSettled(recorded, expected)
    recorded.pending = null
    latest.expectedLayersSha256 = digest(regularBytes(enginePaths(root).layers, 2_000_000))
    writeM2Journal(root, latest, true, milestone)
  }
}

export function setM2UpgradePhase(
  root: string,
  phase: M2Baseline['phase'],
  milestone: RecoveryMilestone = 'm2',
): void {
  const journal = readM2Journal(root, milestone)
  if (!journal) throw new Error('M2 baseline is missing')
  journal.baseline.phase = phase
  writeM2Journal(root, journal, true, milestone)
}

export function refreshM2LayersHash(root: string, milestone: RecoveryMilestone = 'm2'): void {
  const journal = readM2Journal(root, milestone)
  if (!journal) throw new Error('M2 baseline is missing')
  journal.expectedLayersSha256 = digest(regularBytes(enginePaths(root).layers, 2_000_000))
  writeM2Journal(root, journal, true, milestone)
}

// Called only after the owning broad removal verifies that routing is gone.
// Keep the immutable evidence, but prevent a later on from reusing this pin.
export function retireM2Upgrade(root: string, milestone: RecoveryMilestone = 'm2'): void {
  const journal = readM2Journal(root, milestone)
  if (!journal) return
  journal.retired = true
  journal.checkpoint = 'broad-off'
  writeM2Journal(root, journal, false, milestone)
  unlinkSync(m2Paths(root, milestone).record)
  syncDirectory(root)
}

export function activeUpgrade(root: string): RecoveryMilestone {
  const m3 = readM2Journal(root, 'm3')
  return m3 && m3.baseline.phase !== 'rolled-back' ? 'm3' : 'm2'
}
