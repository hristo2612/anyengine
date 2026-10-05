// The initial baseline never changes. Each write durably publishes both the
// settled generation and a pending intent, then recovery scripts, then target
// bytes. Settlement is another publication; errors retain recoverable evidence.
import { mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  atomicFile,
  digest,
  type FileChange,
  type FileState,
  keepBytes,
  type Layer,
  type LayerName,
  prepareDirectory,
  recoveryPaths,
  regularBytes,
  safeTarget,
  sameState,
  setSettled,
  settledState,
  stateAt,
  swapLink,
  syncDirectory,
} from './control-layer-state.mjs'

export type { RestoreOutcome } from './control-layer-restore.mjs'
export { restoreChange } from './control-layer-restore.mjs'
export type {
  FileChange,
  FileState,
  Layer,
  LayerFile,
  LayerName,
  SharedConfigRecord,
} from './control-layer-state.mjs'

import { readLayers, validateLayers, writeLayers } from './control-layer-journal.mjs'

export { readLayers, writeLayers } from './control-layer-journal.mjs'
export { POPPED, recoveryPaths, sha256Of } from './control-layer-state.mjs'
export type { Adoption } from './control-m0-adoption.mjs'
export { adoptM0, m0Active } from './control-m0-adoption.mjs'

export type RecordPhase = 'intent' | 'settled' | 'job' | 'checkpoint'
// Task23/24 publish Node-free scripts and RECOVER.txt synchronously here.
// The durable journal already contains this snapshot. A throw prevents the
// target mutation; no async callback or outer synchronous file-lock is allowed.
export type OnRecord = (layer: Layer, phase: RecordPhase) => void

export class LayerWriter {
  readonly layer: Layer
  private readonly root: string
  private readonly onRecord: OnRecord
  private failed = false

  constructor(
    root: string,
    existing: Layer | null,
    name: LayerName,
    stamp: string,
    onRecord: OnRecord = () => {},
  ) {
    readLayers(root) // Refuse broken authority before creating any artifacts.
    if (!/^[a-zA-Z0-9_-]+$/.test(stamp)) throw new Error('invalid rollback stamp')
    this.root = root
    this.onRecord = onRecord
    this.layer = existing
      ? structuredClone(existing)
      : {
          name,
          rollbackDir: join(recoveryPaths(root).layers, `${stamp}-${name}`),
          adoptedFrom: null,
          createdAt: new Date().toISOString(),
          changes: [],
          jobs: [],
          cleansCache: name === 'router',
        }
    if (this.layer.name !== name) throw new Error('layer name mismatch')
    validateLayers(root, { version: 1, layers: [this.layer] })
    prepareDirectory(root, this.layer.rollbackDir)
  }

  private ready(): void {
    if (
      this.failed ||
      this.layer.pending === 'after-quit' ||
      this.layer.changes.some((change) => change.pending !== null)
    )
      throw new Error('incomplete layer publication requires recovery before another mutation')
    readLayers(this.root)
  }

  private publish(phase: RecordPhase): void {
    try {
      const file = readLayers(this.root)
      const index = file.layers.findIndex((layer) => layer.name === this.layer.name)
      if (index >= 0 && file.layers[index]?.rollbackDir !== this.layer.rollbackDir)
        throw new Error('another layer baseline must be recovered first')
      if (index >= 0) file.layers[index] = this.layer
      else file.layers.push(this.layer)
      writeLayers(this.root, file)
      const result: unknown = this.onRecord(structuredClone(this.layer), phase)
      if (result && typeof (result as Promise<unknown>).then === 'function')
        throw new Error('layer publication callback must be synchronous')
    } catch (error) {
      this.failed = true
      throw error
    }
  }

  track(target: string): FileChange {
    safeTarget(target, this.root)
    const known = this.layer.changes.find((change) => change.target === target)
    if (known) return known
    this.ready()
    const before = stateAt(target)
    if (before.kind === 'file')
      before.bytes = keepBytes(this.layer.rollbackDir, regularBytes(target))
    const change: FileChange = {
      target,
      before: before.kind,
      backup: before.bytes,
      mode: before.mode,
      beforeSha: before.sha,
      beforeLink: before.link,
      after: before.bytes,
      afterSha: before.sha,
      afterLink: before.link,
      afterMode: before.mode,
      pending: null,
    }
    if (this.layer.upgrade) change.lastGood = { ...before }
    this.layer.changes.push(change)
    return change
  }

  private intent(target: string, state: FileState): void {
    const change = this.track(target)
    change.pending = state
    this.publish('intent')
    mkdirSync(dirname(target), { recursive: true })
  }

  writeFile(target: string, content: string | Buffer, mode: number): boolean {
    safeTarget(target, this.root)
    this.ready()
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('invalid file mode')
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const observed = stateAt(target)
    const wanted: FileState = { kind: 'file', sha: digest(bytes), link: null, mode, bytes: null }
    if (sameState(stateAt(target), wanted)) return false
    this.track(target)
    wanted.bytes = keepBytes(this.layer.rollbackDir, bytes)
    this.intent(target, wanted)
    try {
      if (!sameState(stateAt(target), observed))
        throw new Error('layer target changed before replacement; pending intent retained')
      atomicFile(target, bytes, mode)
      this.settle(target)
    } catch (error) {
      this.failed = true
      throw error
    }
    return true
  }

  writeSymlink(target: string, to: string): boolean {
    safeTarget(target, this.root)
    this.ready()
    if (!to || /[\0\r\n]/.test(to)) throw new Error('invalid symlink destination')
    const wanted: FileState = { kind: 'symlink', sha: null, link: to, mode: null, bytes: null }
    if (sameState(stateAt(target), wanted)) return false
    this.intent(target, wanted)
    try {
      swapLink(target, to)
      this.settle(target)
    } catch (error) {
      this.failed = true
      throw error
    }
    return true
  }

  removeFile(target: string): boolean {
    safeTarget(target, this.root)
    this.ready()
    if (stateAt(target).kind === 'absent') return false
    this.intent(target, { kind: 'absent', sha: null, link: null, mode: null, bytes: null })
    try {
      unlinkSync(target)
      syncDirectory(dirname(target))
      this.settle(target)
    } catch (error) {
      this.failed = true
      throw error
    }
    return true
  }

  settle(target: string): void {
    const change = this.layer.changes.find((row) => row.target === target)
    if (!change?.pending || !sameState(stateAt(target), change.pending))
      throw new Error('cannot settle an unverified layer target')
    setSettled(change, change.pending)
    change.pending = null
    this.publish('settled')
  }

  addJob(label: string): void {
    this.ready()
    if (!/^[a-zA-Z0-9._-]+$/.test(label)) throw new Error('invalid launchd job label')
    if (this.layer.jobs.includes(label)) return
    this.layer.jobs.push(label)
    this.publish('job')
  }

  // Call once before an existing router upgrade; keep until verified postflight
  // or terminal last-good recovery. New targets acquire their own lastGood in
  // track(). Full off always uses the immutable initial baseline instead.
  beginUpgrade(currentSettings?: string): void {
    this.ready()
    if (this.layer.upgrade) throw new Error('unfinished last-good upgrade requires recovery')
    if (
      currentSettings &&
      (this.layer.name !== 'claude-code' ||
        currentSettings !== this.layer.claudeCode?.settingsTarget)
    )
      throw new Error('current settings checkpoint requires semantic Claude ownership')
    for (const change of this.layer.changes) {
      if (
        change.target !== currentSettings &&
        !sameState(stateAt(change.target), settledState(change))
      )
        throw new Error('last-good upgrade target changed since settlement')
    }
    for (const change of this.layer.changes) {
      const state =
        change.target === currentSettings ? stateAt(change.target) : settledState(change)
      if (change.target === currentSettings && state.kind === 'file')
        state.bytes = keepBytes(this.layer.rollbackDir, regularBytes(change.target))
      change.lastGood = state
    }
    this.layer.upgrade = {
      createdAt: new Date().toISOString(),
      jobs: [...this.layer.jobs],
      cleansCache: this.layer.cleansCache,
      sharedConfig: structuredClone(this.layer.sharedConfig ?? null),
      ...(this.layer.claudeCode ? { claudeCode: structuredClone(this.layer.claudeCode) } : {}),
    }
    this.publish('checkpoint')
  }

  // Caller owns postflight/terminal verification (Task26). This method only
  // retires the upgrade checkpoint; immutable initial backups are retained.
  finishUpgrade(outcome: 'committed' | 'recovered' = 'committed'): void {
    if (outcome === 'committed') this.ready()
    else readLayers(this.root)
    if (!this.layer.upgrade) return
    for (const change of this.layer.changes) {
      const expected = outcome === 'recovered' ? change.lastGood : settledState(change)
      if (!expected || !sameState(stateAt(change.target), expected))
        throw new Error('cannot retire unverified last-good recovery')
    }
    if (outcome === 'recovered') {
      for (const change of this.layer.changes) {
        if (!change.lastGood) throw new Error('missing last-good recovery baseline')
        setSettled(change, change.lastGood)
        change.pending = null
      }
      this.layer.jobs = [...this.layer.upgrade.jobs]
      this.layer.cleansCache = this.layer.upgrade.cleansCache
      this.layer.sharedConfig = structuredClone(this.layer.upgrade.sharedConfig)
      if (this.layer.upgrade.claudeCode)
        this.layer.claudeCode = structuredClone(this.layer.upgrade.claudeCode)
    }
    delete this.layer.upgrade
    for (const change of this.layer.changes) delete change.lastGood
    this.publish('checkpoint')
  }
}
