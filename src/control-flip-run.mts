// Public front plus the durable detached owner. Logs describe progress; the
// start/token/inode lock and validated marker remain recovery authority.
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { anyengineRoot } from './anyengine-config.mjs'
import type { Command, Say } from './control-cli.mjs'
import { type FlipContext, resumeFlip, runOff, runOn, runRestart } from './control-flip.mjs'
import {
  inspectFlipLock,
  ownProcessStart,
  prepareFlipState,
  takeFlipLock,
} from './control-flip-lock.mjs'
import { admitEvidence, executingLib, outsideApp, parseFlipArgs } from './control-flip-options.mjs'
import { message, recoveryNotice, type Stop } from './control-flip-recovery.mjs'
import { jsonAt, regularBytes, statAt } from './control-layer-state.mjs'
import { rollbackM2 } from './control-m2-rollback.mjs'
import {
  clearFlipMarker,
  type FlipMarker,
  type FlipOp,
  markerAlive,
  readFlipMarker,
  writeFlipMarker,
} from './control-marker.mjs'
import { type FlipDeps, realFlipDeps } from './control-postflight.mjs'
import { realSystem, type System } from './control-system.mjs'

const validId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)
const logPath = (root: string, id: string) => join(root, 'state', `flip-${id}.log`)
async function confirm(yes: boolean, dryRun: boolean): Promise<void> {
  if (yes || dryRun) return
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('restart needs --yes outside a terminal')
  const input = createInterface({ input: process.stdin, output: process.stdout })
  try {
    if (!/^y(es)?$/i.test((await input.question('Restart ChatGPT.app? [y/N] ')).trim()))
      throw new Error('restart declined')
  } finally {
    input.close()
  }
}
function signals(stop: Stop, detached: boolean): () => void {
  const term = () => {
    stop.requested ??= 'SIGTERM'
  }
  const int = () => {
    stop.requested ??= 'SIGINT'
  }
  const hup = () => {}
  process.on('SIGTERM', term)
  process.on('SIGINT', int)
  if (detached) process.on('SIGHUP', hup)
  return () => {
    process.off('SIGTERM', term)
    process.off('SIGINT', int)
    if (detached) process.off('SIGHUP', hup)
  }
}
function validateRecoveryState(state: Record<string, unknown>): void {
  for (const key of ['routerLayerWasNew', 'routerOnly', 'quitDone', 'mutationsStarted'])
    if (Object.hasOwn(state, key) && typeof state[key] !== 'boolean')
      throw new Error(`invalid recovery state: ${key}`)
}
function validateOrigin(op: FlipOp, args: string[], phase: string): void {
  const phases = [
    'preflight',
    'prepare',
    'prove',
    'quit',
    'between',
    'files',
    'open',
    'postflight',
    'awaiting-postflight',
    'off-files',
    'restart',
    'rollback',
    'complete',
  ]
  if (!phases.includes(phase) || typeof parseFlipArgs(op, args) === 'string')
    throw new Error('invalid interrupted phase or arguments')
}
function origin(marker: FlipMarker): FlipMarker {
  validateRecoveryState(marker.state)
  if (!Object.hasOwn(marker.state, 'interrupted')) {
    validateOrigin(marker.op, marker.args, marker.phase)
    return marker
  }
  const value = marker.state.interrupted
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid interrupted flip state')
  const row = value as Record<string, unknown>
  if (
    !['on', 'off', 'restart'].includes(String(row.op)) ||
    !Array.isArray(row.args) ||
    !row.args.every((a) => typeof a === 'string' && a.length > 0 && !/[\0\r\n]/.test(a)) ||
    typeof row.phase !== 'string' ||
    !/^[a-z][a-z-]{0,63}$/.test(row.phase) ||
    !row.state ||
    typeof row.state !== 'object' ||
    Array.isArray(row.state)
  )
    throw new Error('invalid interrupted flip state')
  const state = row.state as Record<string, unknown>
  validateRecoveryState(state)
  if (Object.hasOwn(state, 'interrupted')) throw new Error('nested interrupted flip state')
  validateOrigin(row.op as FlipOp, row.args as string[], row.phase)
  return { ...marker, op: row.op as FlipOp, args: row.args as string[], phase: row.phase, state }
}
function admitRunner(system: System, root: string, nativeProof: string | null): FlipMarker | null {
  outsideApp(system)
  admitEvidence(system, root)
  if (nativeProof) jsonAt(nativeProof)
  const previous = readFlipMarker(root)
  if (previous) origin(previous)
  const holder = inspectFlipLock(root, system)
  if (holder) throw new Error(`another flip holds the lock (pid ${holder})`)
  if (previous && markerAlive(previous, system))
    throw new Error(`another flip is running (pid ${previous.pid}, log ${previous.log})`)
  return previous
}
function finishSharedMarker(root: string, handedOff: boolean): void {
  if (!handedOff) clearFlipMarker(root)
}
function milestoneMarkerState(original: FlipMarker | null): Record<string, unknown> {
  if (!original || !['m2', 'm3'].includes(String(original.state.failureTarget))) return {}
  const key = original.state.failureTarget === 'm3' ? 'm3BaselineId' : 'm2BaselineId'
  return {
    failureTarget: original.state.failureTarget,
    [key]: original.state[key],
    recoveryCommand: original.state.recoveryCommand,
  }
}
async function runOwned(
  op: FlipOp,
  args: string[],
  system: System,
  root: string,
  deps: FlipDeps,
  say: Say,
  stop: Stop,
  detachedId?: string,
): Promise<number> {
  const options = parseFlipArgs(op, args)
  if (typeof options === 'string') {
    say(`${options}\n`)
    return 2
  }
  let release: (() => void) | undefined
  let handedOff = false
  let terminal = false
  let ctx: FlipContext | undefined
  try {
    const previous = admitRunner(system, root, options.nativeProof)
    // Dry-run never creates/chmods a root, log, marker, lock or coordination DB.
    if (options.dryRun) {
      if (previous) throw new Error('interrupted flip requires recovery before dry-run')
      return runOn({ system, root, deps, say, stop, marker: () => {} }, options)
    }
    await confirm(options.yes, false)
    const lock = takeFlipLock(root, system)
    if (!lock.ok) throw new Error(`another flip holds the lock (pid ${lock.holder})`)
    release = lock.release
    const old = readFlipMarker(root)
    if (old && markerAlive(old, system))
      throw new Error(`another flip is running (pid ${old.pid}, log ${old.log})`)
    const original = old ? origin(old) : null
    const id = old?.id ?? detachedId ?? randomUUID()
    const now = system.now().toISOString()
    const marker: FlipMarker = {
      id,
      op,
      args,
      pid: process.pid,
      processStart: ownProcessStart(system),
      runner: detachedId ? 'detached' : 'foreground',
      phase: original ? 'resume' : 'preflight',
      startedAt: old?.startedAt ?? now,
      updatedAt: now,
      log: logPath(root, detachedId ?? id),
      state: {
        ...milestoneMarkerState(original),
        ...(detachedId ? { runnerId: detachedId } : {}),
        ...(original
          ? {
              interrupted: {
                op: original.op,
                args: original.args,
                phase: original.phase,
                state: original.state,
              },
            }
          : {}),
      },
    }
    ctx = {
      system,
      root,
      deps,
      say,
      stop,
      async recoverM3(noRestart) {
        handedOff = true
        release?.()
        release = undefined
        const result = await rollbackM2(system, root, { noRestart }, 'm3')
        for (const conflict of result.conflicts) say(`${conflict}\n`)
        terminal = result.ok
        return result.ok
      },
      async recoverM2(noRestart) {
        handedOff = true
        release?.()
        release = undefined
        const result = await rollbackM2(system, root, { noRestart })
        for (const conflict of result.conflicts) say(`${conflict}\n`)
        terminal = result.ok
        return result.ok
      },
      marker(phase, state = {}) {
        if (handedOff) return
        marker.phase = phase
        Object.assign(marker.state, state)
        marker.updatedAt = system.now().toISOString()
        writeFlipMarker(root, marker)
        terminal = phase === 'complete'
      },
    }
    ctx.marker(marker.phase)
    const code = original
      ? await resumeFlip(ctx, original, options)
      : op === 'on'
        ? await runOn(ctx, options)
        : op === 'off'
          ? await runOff(ctx, options)
          : await runRestart(ctx, options)
    if (terminal) {
      finishSharedMarker(root, handedOff)
      if (original)
        say(
          `resumed an interrupted ${original.op} (it stopped at ${original.phase}); run the command again if you still want it\n`,
        )
    } else recoveryNotice(ctx)
    return code
  } catch (error) {
    say(`flip failed: ${message(error)}\n`)
    if (ctx) recoveryNotice(ctx)
    return 1
  } finally {
    release?.()
  }
}
export async function runFlipForeground(
  op: FlipOp,
  args: string[],
  system: System,
  root: string,
  deps: FlipDeps,
  say: Say,
  stop: Stop = { requested: null },
): Promise<number> {
  return runOwned(op, args, system, root, deps, say, stop)
}
function pruneLogs(root: string, keep: string): void {
  const state = join(root, 'state')
  const active = readFlipMarker(root)?.log
  const logs = readdirSync(state)
    .filter((name) => /^flip-[a-zA-Z0-9_-]+\.log$/.test(name))
    .map((name) => ({ path: join(state, name), stat: statAt(join(state, name)) }))
    .filter((row) => row.stat?.isFile())
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
  for (const row of logs.slice(10))
    if (row.path !== active && row.path !== keep) unlinkSync(row.path)
}
export async function flipRunMain(argv: string[]): Promise<number> {
  const [id, verb, ...args] = argv
  if (!id || !validId(id) || !['on', 'off', 'restart'].includes(verb ?? '')) return 2
  const op = verb as FlipOp
  const options = parseFlipArgs(op, args)
  if (typeof options === 'string' || options.dryRun) return 2
  const stop: Stop = { requested: null }
  const dispose = signals(stop, true)
  let size = 0
  const say = (text: string) => {
    if (size > 2_000_000) return
    const line = `${new Date().toISOString()} ${text}`
    size += Buffer.byteLength(line)
    process.stdout.write(line)
  }
  let code = 1
  try {
    const root = anyengineRoot()
    const system = realSystem()
    outsideApp(system)
    admitEvidence(system, root)
    if (statAt(join(root, 'state'))) pruneLogs(root, logPath(root, id))
    code = await runOwned(
      op,
      args,
      system,
      root,
      realFlipDeps(system, root, executingLib()),
      say,
      stop,
      id,
    )
  } catch (error) {
    say(`flip failed: ${message(error)}\n`)
  } finally {
    dispose()
  }
  process.stdout.write(`flip ${id} exit ${code}\n`)
  return code
}
async function follow(
  system: System,
  root: string,
  id: string,
  pid: number,
  start: string | null,
  say: Say,
): Promise<number> {
  const path = logPath(root, id)
  let offset = 0
  for (;;) {
    const log = new TextDecoder('utf-8', { fatal: true }).decode(regularBytes(path, 2_100_000))
    if (log.length < offset) throw new Error('progress log was replaced or truncated')
    say(log.slice(offset))
    offset = log.length
    const match = new RegExp(`(?:^|\\n)flip ${id} exit ([012])\\n$`).exec(log)
    if (match) return Number(match[1])
    const runner = system.processes().find((p) => p.pid === pid)
    if (!runner || (start !== null && runner.processStart !== start)) {
      say(
        `the flip runner stopped without finishing; use retained RECOVER.txt or run the installed control again to resume\n`,
      )
      return 1
    }
    start ??= runner.processStart
    await system.sleep(1000)
  }
}
export function flipCommand(op: FlipOp): Command {
  return async (args, system, root, say) => {
    const options = parseFlipArgs(op, args)
    if (typeof options === 'string') {
      say(`${options}\n`)
      return 2
    }
    outsideApp(system)
    admitEvidence(system, root)
    if (options.foreground || options.dryRun) {
      const stop: Stop = { requested: null }
      const dispose = signals(stop, false)
      try {
        return await runFlipForeground(
          op,
          args,
          system,
          root,
          realFlipDeps(system, root, executingLib()),
          say,
          stop,
        )
      } finally {
        dispose()
      }
    }
    await confirm(options.yes, false)
    const holder = inspectFlipLock(root, system)
    if (holder) throw new Error(`another flip holds the lock (pid ${holder})`)
    const id = randomUUID()
    prepareFlipState(root)
    const log = logPath(root, id)
    const fd = openSync(log, 'wx', 0o600)
    closeSync(fd)
    const childArgs = options.yes ? args : [...args, '--yes']
    const pid = system.spawnDetached(
      [
        process.execPath,
        fileURLToPath(new URL('./adapter.mjs', import.meta.url)),
        'flip-run',
        id,
        op,
        ...childArgs,
      ],
      log,
    )
    const start = system.processes().find((p) => p.pid === pid)?.processStart ?? null
    say(`flip ${id} started (pid ${pid}); progress: ${log}; anyengine status shows it\n`)
    return options.follow ? follow(system, root, id, pid, start, say) : 0
  }
}
