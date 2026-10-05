// Successful installed verification and bounded attempts have separate authority.
import { createHash, randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { enginePaths } from './anyengine-config.mjs'
import {
  atomicFile,
  jsonAt,
  object,
  regularBytes,
  statAt,
  syncDirectory,
  text,
} from './control-layer-state.mjs'
import type { System } from './control-system.mjs'
import {
  type Compatibility,
  publishState,
  readUpdateState,
  stateMutation,
  type UpdateState,
  validObservation,
} from './startup-compat.mjs'

export interface KnownGood extends Compatibility {
  appVersion: string
  settings: string
  identity: string
  verifiedAt: string
}
export interface WatchOutcome {
  staged: 'none' | 'notified' | 'seen'
  verified: 'unchanged' | 'passed' | 'failed' | 'pending'
  reason: string | null
}
export interface WatchDeps {
  selection(): { path: string; identity: string }
  preflipStaged(): boolean
  compatibility(): Promise<Compatibility>
  settings(): string
  recheck(): void
  verify(): Promise<{ ok: boolean; reason: string }>
  rollback(): Promise<number>
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const date = (v: unknown) => text(v) && Number.isFinite(Date.parse(v))
export function readKnownGood(root: string): KnownGood | null {
  const value = jsonAt(enginePaths(root).knownGood)
  if (value === undefined) return null
  if (
    !object(value) ||
    !text(value.appVersion) ||
    !text(value.codexVersion) ||
    !text(value.codexPath) ||
    !date(value.verifiedAt)
  )
    throw new Error('invalid known-good evidence')
  // A valid old version-only record is historical, never compatible/update verified.
  if (value.format === undefined && value.schemaHash === undefined) return null
  if (
    value.format !== 1 ||
    !validObservation(value) ||
    !text(value.lib) ||
    !text(value.settings) ||
    !/^[a-f0-9]{64}$/.test(String(value.suite)) ||
    !/^[a-f0-9]{64}$/.test(String(value.identity)) ||
    !date(value.checkedAt)
  )
    throw new Error('invalid known-good schema/library evidence')
  return value as unknown as KnownGood
}
function driftBytes(root: string): Buffer | null {
  const path = enginePaths(root).driftMarker
  if (!statAt(path)) return null
  const bytes = regularBytes(path, 8192)
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!/^[^\r\n\0]+\n[^\r\n\0]+\n?$/.test(value)) throw new Error('invalid drift fallback summary')
  return bytes
}
export function writeDriftMarker(root: string, appVersion: string, reason: string): void {
  if (!text(appVersion) || !text(reason)) throw new Error('invalid drift diagnostic')
  driftBytes(root)
  // Summary only. startup-update state is the authoritative selected-binary block.
  const path = enginePaths(root).driftMarker
  const value = `${appVersion}\n${reason.slice(0, 1500)}\n`
  // publishState writes JSON; this file intentionally preserves the shell format.
  atomicFile(path, Buffer.from(value), 0o600)
}
export function clearDriftMarker(root: string): void {
  if (driftBytes(root) === null) return
  unlinkSync(enginePaths(root).driftMarker)
  syncDirectory(enginePaths(root).state)
}
function validateInputs(root: string): void {
  readUpdateState(root)
  readKnownGood(root)
  driftBytes(root)
}
function publishWatch(root: string, state: UpdateState): void {
  publishState(enginePaths(root).updateWatch, state)
}
function claim(system: System, root: string, identity: string, force: boolean): string | null {
  return stateMutation(root, () => {
    validateInputs(root)
    const state = readUpdateState(root)
    const previous = state.attempt
    const processes = system.processes()
    const process = processes.find((p) => p.pid === globalThis.process.pid)
    if (!process) throw new Error('current verifier process identity unavailable')
    if (
      previous?.owner &&
      processes.some(
        (p) => p.pid === previous.owner!.pid && p.processStart === previous.owner!.start,
      )
    )
      return null
    if (
      !force &&
      previous?.identity === identity &&
      Date.parse(previous.nextAt) > system.now().getTime()
    )
      return null
    const token = randomUUID()
    const count = previous?.identity === identity ? Math.min(20, previous.count + 1) : 1
    state.attempt = {
      identity,
      count,
      nextAt: new Date(
        system.now().getTime() + Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(9, count - 1)),
      ).toISOString(),
      owner: { pid: process.pid, start: process.processStart, token },
    }
    publishWatch(root, state)
    return token
  })
}
function owned(root: string, token: string): UpdateState {
  validateInputs(root)
  const state = readUpdateState(root)
  if (state.attempt?.owner?.token !== token) throw new Error('update verifier ownership changed')
  return state
}
function stagedNotice(
  system: System,
  root: string,
  staged: boolean,
  version: string,
): WatchOutcome['staged'] {
  if (!staged) return 'none'
  const outcome = stateMutation(root, () => {
    validateInputs(root)
    const state = readUpdateState(root)
    if (state.staged === version) return 'seen'
    state.staged = version
    publishWatch(root, state)
    return 'notified' as const
  })
  if (outcome === 'notified')
    system.notify(
      'AnyEngine update',
      `ChatGPT.app ${version} has an update waiting; it installs when the app quits. AnyEngine will verify the new version then.`,
    )
  return outcome
}
export async function watchOnce(
  system: System,
  root: string,
  deps: WatchDeps,
  options: { force?: boolean } = {},
): Promise<WatchOutcome> {
  const out: WatchOutcome = { staged: 'none', verified: 'failed', reason: null }
  let token: string | null = null
  let verified = false
  let candidate: Compatibility | null = null
  let version: string | null = null
  let selected: string | null = null
  try {
    validateInputs(root)
    version = system.appVersion()
    if (!version || !/^\d+(?:\.\d+)+\S*$/.test(version)) throw new Error('app version unavailable')
    out.staged = stagedNotice(system, root, deps.preflipStaged(), version)
    const selection = deps.selection()
    selected = selection.path
    if (!selected.startsWith('/') || !text(selection.identity))
      throw new Error('selected update identity unavailable')
    token = claim(
      system,
      root,
      hash({ version, selection, settings: deps.settings() }),
      options.force ?? false,
    )
    if (!token)
      return {
        ...out,
        verified: 'pending',
        reason: 'verification is busy or retry backoff is active',
      }
    verified = true
    candidate = await deps.compatibility()
    const settings = deps.settings()
    if (!validObservation(candidate) || !text(settings))
      throw new Error('invalid update compatibility/settings')
    const { checkedAt: _at, ...stable } = candidate
    const identity = hash({ ...stable, appVersion: version, settings })
    if (
      !options.force &&
      readKnownGood(root)?.identity === identity &&
      !readUpdateState(root).block
    ) {
      deps.recheck()
      stateMutation(root, () => {
        const state = owned(root, token!)
        state.attempt = null
        publishWatch(root, state)
      })
      token = null
      return { ...out, verified: 'unchanged' }
    }
    const result = await deps.verify()
    if (!result.ok) throw new Error(result.reason || 'mandatory installed verification failed')
    deps.recheck()
    if (system.appVersion() !== version || deps.settings() !== settings)
      throw new Error('update identity changed during verification')
    stateMutation(root, () => {
      const state = owned(root, token!)
      deps.recheck()
      if (deps.settings() !== settings)
        throw new Error('settings changed before update publication')
      publishState(enginePaths(root).knownGood, {
        ...candidate,
        appVersion: version,
        settings,
        identity,
        verifiedAt: system.now().toISOString(),
      })
      clearDriftMarker(root)
      state.block = null
      state.attempt = null
      publishWatch(root, state)
    })
    token = null
    return { ...out, verified: 'passed' }
  } catch (error) {
    let reason = String(error)
      .replace(/[\r\n\0]/g, ' ')
      .slice(0, 1500)
    if (token && selected && version) {
      try {
        stateMutation(root, () => {
          const state = owned(root, token!)
          state.block = { codexPath: selected!, reason, at: system.now().toISOString() }
          publishWatch(root, state)
          writeDriftMarker(root, version!, reason)
        })
        try {
          if (verified && (await deps.rollback()) !== 0)
            reason += '; rollback failed or pending; recovery retained'
        } catch (error) {
          reason += `; rollback failed or pending: ${String(error)}`
        }
        stateMutation(root, () => {
          const state = owned(root, token!)
          state.attempt!.owner = null
          publishWatch(root, state)
        })
        system.notify(
          'AnyEngine update failed',
          `${reason}; vendor fallback remains active. Run anyengine status.`,
        )
      } catch (failure) {
        reason += `; failure evidence/recovery: ${String(failure)}`
      }
    }
    return { ...out, reason }
  }
}
