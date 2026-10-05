// Startup admission is successful fixture evidence, never installed update proof.
import { spawn } from 'node:child_process'
import { mkdirSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { enginePaths } from './anyengine-config.mjs'
import { isExecutableFile, resolveBundledCodex } from './bundled-codex.mjs'
import { executingLib } from './control-flip-options.mjs'
import {
  atomicFile,
  directoryAt,
  jsonAt,
  object,
  syncDirectory,
  text,
} from './control-layer-state.mjs'
import { inspectDegraded, inspectProof, markDegraded } from './degraded.mjs'
import { withFileLock } from './file-lock.mjs'
import { joinDetachedGroup } from './smoke-client.mjs'

const schema = createRequire(import.meta.url)('../../scripts/lib/startup-schema.mjs')
let admitted: Observation | null = null
const supervised = typeof process.send === 'function'
export const STARTUP_BUDGET_MS: number = schema.STARTUP_BUDGET_MS
export const STARTUP_WAIT_MS: number = schema.STARTUP_WAIT_MS
export interface Observation {
  codexPath: string
  codexVersion: string
  binaryStamp: string
  schemaHash: string
}
export interface Compatibility extends Observation {
  format: 1
  lib: string
  suite: string
  checkedAt: string
}
export interface UpdateState {
  format: 1
  staged: string | null
  attempt: {
    identity: string
    count: number
    nextAt: string
    owner: { pid: number; start: string; token: string } | null
  } | null
  block: { codexPath: string; reason: string; at: string } | null
}
export type StartupAdmission =
  | { kind: 'admit'; compatibility: 'matched' | 'passed'; observation: Observation }
  | { kind: 'fallback'; code: string; reason: string; codexPath: string | null }
  | { kind: 'mock' }
export interface StartupDeps {
  identity(): { lib: string; suite: string }
  selected(): string | null
  stamp(path: string): string
  observe(path: string, budget: number): Observation
  fixtures(observation: Observation): void | Promise<void>
  now(): Date
  monotonic?(): number
}
const date = (v: unknown): v is string => text(v) && Number.isFinite(Date.parse(v))
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
export function validObservation(v: unknown): v is Observation {
  return (
    object(v) &&
    text(v.codexPath) &&
    v.codexPath.startsWith('/') &&
    text(v.binaryStamp) &&
    typeof v.codexVersion === 'string' &&
    /^\d+\.\d+\.\d+\S*$/.test(v.codexVersion) &&
    sha(v.schemaHash)
  )
}
export function readCompatibility(root: string): Compatibility | null {
  const value = jsonAt(join(enginePaths(root).state, 'startup-compat.json'))
  if (value === undefined) return null
  if (
    !object(value) ||
    value.format !== 1 ||
    !validObservation(value) ||
    !text(value.lib) ||
    !sha(value.suite) ||
    !date(value.checkedAt)
  )
    throw new Error('invalid startup compatibility evidence')
  return value as unknown as Compatibility
}
export function readUpdateState(root: string): UpdateState {
  const value = jsonAt(enginePaths(root).updateWatch)
  if (value === undefined) return { format: 1, staged: null, attempt: null, block: null }
  if (!object(value) || value.format !== 1 || !(value.staged === null || text(value.staged)))
    throw new Error('invalid update attempt evidence')
  const a = value.attempt
  if (
    a !== null &&
    (!object(a) ||
      !sha(a.identity) ||
      !Number.isSafeInteger(a.count) ||
      Number(a.count) < 0 ||
      Number(a.count) > 20 ||
      !date(a.nextAt) ||
      (a.owner !== null &&
        (!object(a.owner) ||
          !Number.isSafeInteger(a.owner.pid) ||
          Number(a.owner.pid) < 1 ||
          !text(a.owner.start) ||
          !text(a.owner.token))))
  )
    throw new Error('invalid update attempt owner/backoff')
  const b = value.block
  if (
    b !== null &&
    (!object(b) ||
      !text(b.codexPath) ||
      !b.codexPath.startsWith('/') ||
      !text(b.reason) ||
      !date(b.at))
  )
    throw new Error('invalid update failure evidence')
  return value as unknown as UpdateState
}
export function stateMutation<T>(root: string, body: () => T, waitMs = 1000): T {
  directoryAt(root)
  directoryAt(enginePaths(root).state)
  mkdirSync(enginePaths(root).state, { recursive: true, mode: 0o700 })
  return withFileLock(join(enginePaths(root).state, 'startup-update.lock'), body, { waitMs })
}
export function publishState(path: string, value: unknown): void {
  atomicFile(path, Buffer.from(`${JSON.stringify(value)}\n`), 0o600)
}
function failure(
  root: string,
  code: string,
  reason: string,
  codexPath: string | null,
  persist = true,
): StartupAdmission {
  reason = reason.replace(/[\r\n\0]/g, ' ').slice(0, 1500)
  try {
    if (!persist) throw new Error('startup deadline exhausted')
    const path = join(enginePaths(root).state, 'startup-failure.json')
    readStartupFailure(root)
    stateMutation(
      root,
      () => {
        readStartupFailure(root)
        publishState(path, { format: 1, at: new Date().toISOString(), code, reason, codexPath })
      },
      0,
    )
  } catch {} // A failed diagnostic must never prevent safe vendor delegation.
  return { kind: 'fallback', code, reason, codexPath }
}
export function readFallback(root: string): Record<string, unknown> | null {
  const value = jsonAt(join(root, 'shim-fallback.json'))
  if (value === undefined) return null
  if (
    !object(value) ||
    value.event !== 'shim.fallback' ||
    !date(value.ts) ||
    !text(value.reason) ||
    (value.pid !== undefined && (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1))
  )
    throw new Error('invalid shim fallback diagnostic')
  return value
}
export function readStartupFailure(root: string): Record<string, unknown> | null {
  const value = jsonAt(join(enginePaths(root).state, 'startup-failure.json'))
  if (value === undefined) return null
  if (
    !object(value) ||
    value.format !== 1 ||
    !date(value.at) ||
    !text(value.code) ||
    !text(value.reason) ||
    !(value.codexPath === null || text(value.codexPath))
  )
    throw new Error('invalid startup failure evidence')
  return value
}
function removeFailure(root: string): void {
  if (!readStartupFailure(root)) return
  unlinkSync(join(enginePaths(root).state, 'startup-failure.json'))
  syncDirectory(enginePaths(root).state)
}
export async function checkStartupCompatibility(
  root: string,
  deps: StartupDeps,
  purpose: 'startup' | 'update' = 'startup',
): Promise<StartupAdmission> {
  const clock = deps.monotonic ?? (() => performance.now())
  const deadline = clock() + STARTUP_BUDGET_MS
  let path: string | null = null
  try {
    path = deps.selected()
    if (!path) throw new Error('no selected Codex executable')
    const observation = deps.observe(path, Math.floor(deadline - clock() - 10_000))
    if (!validObservation(observation) || observation.codexPath !== path)
      throw new Error('invalid selected schema observation')
    const identity = deps.identity()
    if (!text(identity.lib) || !sha(identity.suite))
      throw new Error('unknown library/fixture identity')
    readStartupFailure(root)
    readFallback(root)
    const before = readCompatibility(root)
    const update = readUpdateState(root)
    inspectProof(root)
    inspectDegraded(root)
    if (purpose === 'startup' && update.block?.codexPath === path)
      throw new Error(`mandatory installed update remains failed: ${update.block.reason}`)
    const matched =
      before?.lib === identity.lib &&
      before?.suite === identity.suite &&
      before?.schemaHash === observation.schemaHash
    let fixtureFailure: unknown
    try {
      if (!matched || purpose === 'update') await deps.fixtures(observation)
    } catch (error) {
      fixtureFailure = error
    }
    // Reserve the producer's entire existing 10-second lock wait. Fixture work
    // must finish within the first 20 seconds; publication uses only time left.
    if (clock() >= deadline - 10_000)
      throw new Error('startup observation/fixture deadline exceeded')
    if (before && before.schemaHash !== observation.schemaHash)
      markDegraded(
        root,
        'native-fanout',
        'selected Codex schema changed; native proof must be earned again',
      )
    if (fixtureFailure !== undefined) throw fixtureFailure
    const recheck = () => {
      if (
        clock() >= deadline ||
        deps.selected() !== path ||
        deps.stamp(path!) !== observation.binaryStamp ||
        JSON.stringify(deps.identity()) !== JSON.stringify(identity)
      )
        throw new Error('selected binary/library changed or startup deadline exceeded')
    }
    recheck()
    stateMutation(
      root,
      () => {
        const current = readCompatibility(root)
        if (purpose === 'startup' && readUpdateState(root).block?.codexPath === path)
          throw new Error('mandatory update failed during startup verification')
        recheck()
        if (JSON.stringify(current) !== JSON.stringify(before))
          if (
            current?.lib !== identity.lib ||
            current?.suite !== identity.suite ||
            current?.codexPath !== path ||
            current?.codexVersion !== observation.codexVersion ||
            current?.binaryStamp !== observation.binaryStamp ||
            current?.schemaHash !== observation.schemaHash
          )
            throw new Error('startup publication raced a different verifier; retry')
        readStartupFailure(root)
        publishState(join(enginePaths(root).state, 'startup-compat.json'), {
          format: 1,
          ...identity,
          codexPath: path,
          codexVersion: observation.codexVersion,
          binaryStamp: observation.binaryStamp,
          schemaHash: observation.schemaHash,
          checkedAt: deps.now().toISOString(),
        })
        removeFailure(root)
      },
      Math.max(0, Math.floor(deadline - clock())),
    )
    recheck()
    return { kind: 'admit', compatibility: matched ? 'matched' : 'passed', observation }
  } catch (error) {
    return failure(root, 'schema-admission', String(error), path, clock() < deadline)
  }
}
export function selectedCodex(env: NodeJS.ProcessEnv = process.env): string | null {
  const fallback = env.CODEX_REAL?.trim() ?? ''
  return resolveBundledCodex(env).path ?? (isExecutableFile(fallback) ? fallback : null)
}
export function realStartupDeps(lib = executingLib()): StartupDeps {
  return {
    identity: () => ({ lib: schema.libraryIdentity(lib), suite: schema.suiteIdentity(lib) }),
    selected: selectedCodex,
    stamp: schema.binaryIdentity,
    observe: schema.observeSchema,
    fixtures: (observation) => schema.validateFixtures(observation, lib),
    now: () => new Date(),
  }
}
export class StartupAdmissionError extends Error {
  readonly code = 'selected-binary-changed'
}
export function assertStartupBinary(binary = admitted?.codexPath ?? ''): void {
  if (!admitted) return
  try {
    if (
      binary === admitted.codexPath &&
      selectedCodex() === binary &&
      schema.binaryIdentity(binary) === admitted.binaryStamp
    )
      return
  } catch {}
  throw new StartupAdmissionError(
    'selected Codex changed after startup admission; current launch refused',
  )
}
export async function admitAdapterStartup(argv: string[], listen: string): Promise<boolean> {
  if (supervised) {
    process.once('disconnect', () => process.kill(process.pid, 'SIGTERM'))
    process.channel?.unref()
  }
  if (process.env.ANYENGINE_MOCK === '1') return true
  const root = enginePaths().root
  const result = await checkStartupCompatibility(root, realStartupDeps())
  if (result.kind === 'admit') {
    admitted = result.observation
    assertStartupBinary(admitted.codexPath)
    return true
  }
  if (result.kind === 'fallback')
    process.exitCode = await startupFallback(result, argv, listen, root)
  return false
}
// The adapter owns this rejection, since a stdio shim has already exec'd it.
// No stdin readers are installed before this child inherits the original pipe.
export async function startupFallback(
  result: Extract<StartupAdmission, { kind: 'fallback' }>,
  argv: string[],
  listen: string,
  root: string,
  prepare?: () => Promise<void>,
): Promise<number> {
  const target = selectedCodex()
  const diagnostic = {
    kind: 'anyengine-startup-failure',
    pid: process.pid,
    code: result.code,
    reason: result.reason,
    codexPath: target,
    fallback: listen.startsWith('ws')
      ? 'direct-cli-required'
      : result.code === 'selected-binary-changed'
        ? 'refused'
        : 'vendor',
  }
  process.stderr.write(`[anyengine] ${JSON.stringify(diagnostic)}\n`)
  const record = (delegation: string) => {
    try {
      readFallback(root)
      publishState(join(root, 'shim-fallback.json'), {
        ...diagnostic,
        delegation,
        ts: new Date().toISOString(),
        event: 'shim.fallback',
      })
    } catch {}
  }
  const notify = async (phase: string, pid?: number) => {
    if (!supervised) return
    if (!process.connected) throw new Error('launch supervisor channel unavailable')
    await new Promise<void>((resolve, reject) =>
      process.send?.({ kind: 'anyengine-startup-delegation', phase, pid }, (error) =>
        error ? reject(error) : resolve(),
      ),
    )
  }
  let notified = true
  try {
    await notify('pending')
  } catch {
    notified = false
  }
  record('pending')
  try {
    await prepare?.()
  } catch (error) {
    process.stderr.write(`[anyengine] startup cleanup unknown: ${String(error)}\n`)
    return result.code === 'selected-binary-changed' ? 78 : 1
  }
  if (result.code === 'selected-binary-changed') return 78
  if (!notified) return 1
  if (!target || listen.startsWith('ws')) return 78
  return new Promise((resolve) => {
    const child = spawn(target, argv, { stdio: 'inherit', detached: true })
    let timer: NodeJS.Timeout | undefined
    let signal: NodeJS.Signals | null = null
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
    const stop = (value: NodeJS.Signals) => {
      signal = value
      if (child.pid) {
        try {
          process.kill(-child.pid, value)
        } catch {}
      }
      timer ??= setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {}
        }
      }, 2000)
    }
    void notify('spawned', child.pid).catch(() => stop('SIGTERM'))
    const handlers = signals.map((value) => {
      const fn = () => stop(value)
      process.on(value, fn)
      return fn
    })
    child.once('error', (error) =>
      process.stderr.write(`[anyengine] vendor spawn: ${error.message}\n`),
    )
    child.once('close', async (code, terminalSignal) => {
      clearTimeout(timer)
      signals.forEach((value, i) => {
        const handler = handlers[i]
        if (handler) process.removeListener(value, handler)
      })
      const ended = signal ?? terminalSignal
      try {
        await joinDetachedGroup(child.pid ?? 0, true)
      } catch (error) {
        process.stderr.write(`[anyengine] vendor cleanup unknown: ${String(error)}\n`)
        resolve(1)
        return
      }
      record('complete')
      try {
        await notify('complete')
      } catch {
        resolve(1)
        return
      }
      if (ended) process.kill(process.pid, ended)
      resolve(code ?? 1)
    })
  })
}
