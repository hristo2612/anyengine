// Private launch lifetimes and crash cleanup. Cleanup metadata grants no proof authority.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { type CodexClaudeMode, writeJsonAtomic } from './anyengine-config.mjs'
import { object, regularBytes, statAt, syncDirectory } from './control-layer-state.mjs'
import type { System } from './control-system.mjs'
import { markProven } from './degraded.mjs'
import { buildRouterRuntime } from './router-hooks.mjs'
import { type RunningRouter, startRouter } from './router-server.mjs'
import type { PathContext, PathResult } from './smoke.mjs'
import { AppServerClient, routerCleanupLog } from './smoke-client.mjs'
import type { ProbeIdentity } from './smoke-evidence.mjs'
import { joinedGroups } from './smoke-process-groups.mjs'
import { verifyProbeStarts } from './smoke-starts.mjs'

export { joinedGroups } from './smoke-process-groups.mjs'

type Life = { pid: number; processStart: string }
type CleanupOwner = Life & { version: 1; attempt: string; pending: boolean; cohort: Life[] }
const inode = (value: { dev: number; ino: number }) => `${value.dev}:${value.ino}`
const runName = /^run-\d{8}T\d{6}Z$/
function life(value: unknown): value is Life & Record<string, unknown> {
  return (
    object(value) &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    typeof value.processStart === 'string' &&
    Number.isFinite(Date.parse(value.processStart)) &&
    new Date(value.processStart).toISOString() === value.processStart
  )
}
function privateDirectory(dir: string): void {
  const stat = lstatSync(dir)
  if (
    !stat.isDirectory() ||
    realpathSync(dir) !== dir ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('invalid private smoke directory')
}
function ownerAt(path: string): { value: CleanupOwner; identity: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (
      !st.isFile() ||
      st.size > 64_000 ||
      (st.mode & 0o777) !== 0o600 ||
      (process.getuid && st.uid !== process.getuid())
    )
      throw new Error('invalid cleanup owner record')
    const bytes = readFileSync(fd)
    if (bytes.length > 64_000) throw new Error('cleanup owner byte limit')
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    )
    if (
      !life(value) ||
      !object(value) ||
      value.version !== 1 ||
      typeof value.attempt !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(value.attempt) ||
      typeof value.pending !== 'boolean' ||
      Object.keys(value).sort().join(',') !== 'attempt,cohort,pending,pid,processStart,version' ||
      !Array.isArray(value.cohort) ||
      value.cohort.length > 128 ||
      !value.cohort.every((p) => life(p) && Object.keys(p).sort().join(',') === 'pid,processStart')
    )
      throw new Error('invalid cleanup owner schema')
    return { value: value as CleanupOwner, identity: inode(st) }
  } finally {
    closeSync(fd)
  }
}
function publishOwner(path: string, value: CleanupOwner, previous?: string): string {
  const tmp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    ownerAt(tmp)
    if (previous) {
      if (ownerAt(path).identity !== previous) throw new Error('cleanup owner record changed')
      renameSync(tmp, path)
    } else linkSync(tmp, path) // Occupied paths are never replaced on initial publication.
    syncDirectory(dirname(path))
    return ownerAt(path).identity
  } finally {
    if (statAt(tmp)) unlinkSync(tmp)
  }
}
export interface SmokeRun {
  pending(cohort: Life[]): void
  joined(): void
  remove(): void
}
export function createSmokeRun(
  system: System,
  root: string,
  runDir: string,
  attempt: string,
): SmokeRun {
  const owner = system.processes().find((p) => p.pid === process.pid)
  if (
    !life(owner) ||
    resolve(root) !== root ||
    dirname(runDir) !== join(root, 'smoke') ||
    !runName.test(basename(runDir))
  )
    throw new Error('invalid smoke run/owner identity')
  mkdirSync(join(root, 'smoke'), { recursive: true, mode: 0o700 })
  privateDirectory(join(root, 'smoke'))
  mkdirSync(runDir, { mode: 0o700 })
  const directory = inode(lstatSync(runDir))
  const file = join(runDir, 'owner.json')
  let value: CleanupOwner = {
    version: 1,
    attempt,
    pid: owner.pid,
    processStart: owner.processStart,
    pending: false,
    cohort: [],
  }
  let identity = publishOwner(file, value)
  const admit = () => {
    privateDirectory(runDir)
    if (inode(lstatSync(runDir)) !== directory || ownerAt(file).identity !== identity)
      throw new Error('smoke run/owner record changed')
  }
  const update = (next: CleanupOwner) => {
    admit()
    identity = publishOwner(file, next, identity)
    value = next
  }
  return {
    pending(cohort) {
      update({ ...value, pending: true, cohort: structuredClone(cohort) })
    },
    joined() {
      update({ ...value, pending: false })
    },
    remove() {
      admit()
      if (value.pending) throw new Error('smoke family lifetime pending; retain run')
      const procs = system.processes()
      if (value.cohort.some((p) => procs.some((live) => live.pid === p.pid)))
        throw new Error('smoke cohort live/reused; retain run')
      rmSync(runDir, { recursive: true })
      syncDirectory(dirname(runDir))
    },
  }
}
export function sweepSmokeRuns(
  system: System,
  root: string,
): { removed: string[]; retained: string[] } {
  const result = { removed: [] as string[], retained: [] as string[] }
  const parent = join(root, 'smoke')
  if (!statAt(parent)) return result
  privateDirectory(parent)
  for (const name of readdirSync(parent)) {
    if (!runName.test(name)) continue
    const dir = join(parent, name)
    try {
      privateDirectory(dir)
      const directory = lstatSync(dir)
      if (system.now().getTime() - directory.mtimeMs <= 3_600_000) continue
      const file = join(dir, 'owner.json')
      const record = ownerAt(file)
      if (record.value.pending) throw new Error('launch/family lifetime pending')
      const procs = system.processes()
      if (
        [record.value, ...record.value.cohort].some((p) => procs.some((live) => live.pid === p.pid))
      )
        throw new Error('owned process live/reused')
      if (inode(lstatSync(dir)) !== inode(directory) || ownerAt(file).identity !== record.identity)
        throw new Error('run identity changed')
      rmSync(dir, { recursive: true })
      syncDirectory(parent)
      result.removed.push(dir)
    } catch {
      result.retained.push(dir)
    }
  }
  return result
}

export function probeRoot(ctx: PathContext, name: string, mode: CodexClaudeMode): string {
  const root = join(ctx.deps.runDir, name)
  if (statAt(root)) throw new Error('probe root occupied')
  mkdirSync(join(root, 'lib'), { recursive: true, mode: 0o700 })
  symlinkSync(join(ctx.root, 'lib', ctx.request.key.lib!), join(root, 'lib/current'))
  const config = structuredClone(ctx.config)
  config.modes.codexClaude = mode
  if (name === 'native' && ctx.config.router.multiAgentV1) config.router.enabled = true
  writeJsonAtomic(join(root, 'config.json'), config)
  return root
}
export function strictEvents(path: string): Array<Record<string, any>> {
  if (!statAt(path)) return []
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    regularBytes(path, 8_000_000),
  )
  if (text && !text.endsWith('\n')) throw new Error('incomplete smoke event log')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line)
      if (
        !object(value) ||
        typeof value.event !== 'string' ||
        !Number.isFinite(Date.parse(String(value.ts)))
      )
        throw new Error('invalid smoke event')
      return value
    })
}
export interface AdapterProbe {
  client: AppServerClient
  identity: ProbeIdentity
  root: string
  threads: Map<string, 'local' | 'ephemeral' | 'persistent'>
  events(): Array<Record<string, any>>
  routerEvents(): Array<Record<string, any>>
}
export function observedFamily(ctx: PathContext, pid: number): Map<number, Life> {
  const procs = ctx.system.processes()
  const family = procs.filter((p) => p.pid === pid)
  if (family.length !== 1) throw new Error('owned probe process disappeared')
  for (let i = 0; i < family.length; i++) {
    for (const p of procs.filter((p) => p.ppid === family[i]?.pid))
      if (!family.some((known) => known.pid === p.pid)) family.push(p)
    if (family.length > 128) throw new Error('owned process family exceeds bound')
  }
  const groups = new Map<number, Life>()
  for (const p of family) {
    const result =
      p.processGroup === undefined &&
      ctx.system.exec('/bin/ps', ['-o', 'pgid=', '-p', String(p.pid)], { timeoutMs: 1000 })
    const group = result ? Number(result.stdout.trim()) : p.processGroup
    if (
      (result && result.status !== 0) ||
      typeof group !== 'number' ||
      !Number.isSafeInteger(group) ||
      group < 1 ||
      !family.some((member) => member.pid === group)
    )
      throw new Error('owned process group identity unknown')
    groups.set(group, family.find((member) => member.pid === group)!)
    if (!ctx.cohort.some((known) => known.pid === p.pid && known.processStart === p.processStart))
      ctx.cohort.push({ pid: p.pid, processStart: p.processStart })
  }
  ctx.run.pending(ctx.cohort)
  return groups
}
function collectSessions(
  ctx: PathContext,
  threads: AdapterProbe['threads'],
  events: Array<Record<string, any>>,
  discover = true,
): void {
  for (const event of events)
    if (event.event === 'bridge.spawnSubagent' && threads.has(event.parentThreadId)) {
      if (!discover && !threads.has(event.childThreadId))
        throw new Error('late owned thread was not released; retain run')
      threads.set(event.childThreadId, 'persistent')
    }
  for (const event of events)
    if (['anyengine.session', 'claim.session', 'trampoline.session'].includes(event.event)) {
      if (!threads.has(event.threadId) || typeof event.sessionId !== 'string')
        throw new Error('session ownership/identity unavailable')
      ctx.sessions.add(event.sessionId)
    }
}
export async function withAdapter(
  ctx: PathContext,
  name: 'agent' | 'native' | 'direct',
  mode: CodexClaudeMode,
  fn: (probe: AdapterProbe) => Promise<PathResult>,
): Promise<PathResult> {
  ctx.verify()
  const root = statAt(join(ctx.deps.runDir, name))
    ? join(ctx.deps.runDir, name)
    : probeRoot(ctx, name, mode)
  const debug = join(root, `debug-${++ctx.sequence}.jsonl`)
  const routerLog = join(root, `router-${ctx.sequence}.jsonl`)
  const logs = [debug, routerLog]
  for (const file of logs) writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
  let router: RunningRouter | undefined
  let routerLife: ReturnType<typeof routerCleanupLog> | undefined
  let client: AppServerClient | undefined
  let identity: ProbeIdentity | undefined
  let result: PathResult | undefined
  let workError: unknown
  const threads: AdapterProbe['threads'] = new Map()
  const released: AdapterProbe['threads'] = new Map()
  const deleted = new Set<string>()
  const groups = new Map<number, Life>()
  let settled = false
  let unsubscribe = () => {}
  const cleanup = async () => {
    let failure: unknown
    let before: ReturnType<typeof strictEvents>[] = []
    try {
      if (client) for (const [pid, p] of observedFamily(ctx, client.pid)) groups.set(pid, p)
      before = logs.map(strictEvents)
      collectSessions(ctx, threads, before.flat())
      if (client) {
        for (const [threadId, kind] of [...threads].reverse()) {
          if (deleted.has(threadId)) continue
          await client.releaseThread(threadId, kind === 'persistent')
          released.set(threadId, kind)
        }
      }
    } catch (error) {
      failure = error
    }
    unsubscribe()
    try {
      const closed = await Promise.allSettled([router?.close(), client?.close()])
      const failed = closed.find((item) => item.status === 'rejected')
      await joinedGroups(ctx, groups)
      routerLife?.joined()
      if (failed?.status === 'rejected') throw failed.reason
      if (failure) throw failure
      if (logs.some((file) => !statAt(file) || statAt(`${file}.1`)))
        throw new Error('final session log missing or rotated; retain run')
      const after = logs.map(strictEvents)
      after.forEach((rows, i) => {
        if (JSON.stringify(rows.slice(0, before[i]!.length)) !== JSON.stringify(before[i]))
          throw new Error('final session log lost earlier evidence; retain run')
      })
      collectSessions(ctx, threads, after.flat(), false)
      verifyProbeStarts(client, released, deleted)
      threads.forEach((kind, id) => {
        if (!deleted.has(id) && released.get(id) !== kind)
          throw new Error('owned thread release incomplete; retain run')
      })
      if (!settled || !identity) throw new Error('probe did not settle its complete lifetime')
      ctx.observe('closed', identity)
      if (result?.native) {
        result.native.owner.after = true
        result.native.owner.closed = true
        result.native.cleanup.threads = true
        result.native.cleanup.processes = true
      }
    } catch (error) {
      ctx.uncertain = true
      throw error
    }
  }
  ctx.run.pending(ctx.cohort)
  try {
    if (name === 'native') {
      // Private bootstrap only. Public proof requires the real correlated receipt.
      markProven(root, 'native-fanout', 'private smoke bootstrap, not acceptance', ctx.request.key)
      routerLife = routerCleanupLog(ctx, routerLog, () => strictEvents(routerLog))
      const log = routerLife.log
      router = await startRouter({ root, port: 0, log, hooks: buildRouterRuntime(root, log).hooks })
    }
    client = AppServerClient.launch(
      process.execPath,
      [ctx.deps.adapter, 'app-server', '-c', 'mcp_servers={}', '-c', 'notify=[]'],
      ctx.deps.adapterEnv({
        CODEX_HOME: ctx.deps.codexHome,
        ANYENGINE_HOME: join(root, 'adapter'),
        ANYENGINE_ROOT: root,
        ANYENGINE_DEBUG_LOG: debug,
        ANYENGINE_REAL_CODEX: ctx.snapshot.bundled!,
        ANYENGINE_CHATGPT_APP: ctx.system.app,
        ANYENGINE_PTY_STATE_DIR: join(root, 'pty'),
        ANYENGINE_CLI: ctx.config.claude.cli || undefined,
        ANYENGINE_ROUTER_URL:
          name === 'direct' ? 'http://127.0.0.1:9/backend-api/codex' : router?.baseUrl,
      }),
    )
    unsubscribe = client.onNotification((message) => {
      const item = message.params?.item
      if (message.method === 'thread/deleted' && threads.has(message.params?.threadId))
        deleted.add(message.params.threadId)
      if (
        ['item/started', 'item/completed'].includes(message.method) &&
        threads.has(message.params?.threadId) &&
        item?.type === 'collabAgentToolCall' &&
        item.tool === 'spawnAgent' &&
        Array.isArray(item.receiverThreadIds)
      )
        for (const id of item.receiverThreadIds)
          if (typeof id === 'string' && id) threads.set(id, 'persistent')
    })
    await client.initialize()
    for (const [pid, p] of observedFamily(ctx, client.pid)) groups.set(pid, p)
    identity = ctx.observe('before', { pid: client.pid, role: 'adapter', root, mode })
    const probe: AdapterProbe = {
      client,
      identity,
      root,
      threads,
      events: () => strictEvents(debug),
      routerEvents: () => strictEvents(routerLog),
    }
    try {
      result = await fn(probe)
    } catch (error) {
      workError = error
    }
    identity = ctx.observe('after', identity)
    for (const [pid, p] of observedFamily(ctx, client.pid)) groups.set(pid, p)
    settled = true
  } finally {
    await cleanup()
  }
  if (workError) throw workError
  return result!
}

export function requirePtySession(
  probe: AdapterProbe,
  threadId: string,
  turnId: string,
  model: string,
): void {
  const events = probe
    .events()
    .filter((e) => e.pid === probe.identity.pid && e.threadId === threadId)
  const selected = events.filter((e) => e.event === 'runtime.turn.select' && e.turnId === turnId)
  const session = events.filter((e) => e.event === 'anyengine.session')
  if (
    selected.length !== 1 ||
    selected[0]!.selectedType !== 'anyengine' ||
    selected[0]!.model !== model ||
    session.length !== 1 ||
    !/^[0-9a-f-]{36}$/i.test(session[0]!.sessionId)
  )
    throw new Error('successful work did not use the actual interactive Claude PTY')
}
