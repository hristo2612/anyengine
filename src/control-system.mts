// Every control action on the Mac passes through this seam. Absolute tool
// paths avoid launchd's minimal PATH; hermetic tests replace all six tools.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

export interface ExecResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface ProcessInfo {
  pid: number
  ppid: number
  processGroup?: number // Real process censuses capture this with identity, before a child can exit.
  command: string
  processStart: string // UTC ISO timestamp, from ps lstart (second precision)
}

export interface System {
  readonly home: string
  readonly app: string
  now(): Date
  exec(
    command: string,
    args: string[],
    options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string },
  ): ExecResult
  appVersion(): string | null
  appExecutable(): string // Exact CFBundleExecutable path; inspection failures throw.
  appRunning(): boolean // false is confirmed down; unknown state throws
  quitApp(timeoutMs?: number): boolean
  openApp(): void
  launchctl(args: string[]): ExecResult
  processes(): ProcessInfo[] // failure is unknown, never an empty list
  notify(title: string, message: string): void
  sleep(ms: number): Promise<void>
  spawnDetached(argv: string[], log: string): number
}

const run: System['exec'] = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 8 * 1024 * 1024,
    ...(options.env ? { env: options.env } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr || (result.error ? String(result.error) : ''),
  }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const quote = (value: string) =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function succeeded(result: ExecResult, action: string): void {
  if (result.status !== 0)
    throw new Error(`${action} failed (status ${result.status ?? 'unknown'}): ${result.stderr}`)
}

function processRows(result: ExecResult): ProcessInfo[] {
  succeeded(result, 'process listing (ps)')
  const out: ProcessInfo[] = []
  const pids = new Set<number>()
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
        line,
      )
    if (!match) throw new Error('cannot parse process listing (ps)')
    const pid = Number(match[1])
    const ppid = Number(match[2])
    const processGroup = Number(match[3])
    const start = Date.parse(`${match[4]} UTC`)
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(ppid) ||
      !Number.isSafeInteger(processGroup) ||
      processGroup < 1 ||
      pids.has(pid) ||
      !Number.isFinite(start)
    )
      throw new Error('invalid process identity in ps listing')
    const canonical = new Date(start)
      .toUTCString()
      .replace(
        /^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/,
        (_all, day: string, date: string, month: string, year: string, time: string) =>
          `${day} ${month} ${Number(date)} ${time} ${year}`,
      )
    if (canonical !== match[4]?.replace(/\s+/g, ' '))
      throw new Error('invalid process start date in ps listing')
    pids.add(pid)
    out.push({
      pid,
      ppid,
      processGroup,
      processStart: new Date(start).toISOString(),
      command: match[5] ?? '',
    })
  }
  if (out.length === 0) throw new Error('empty process listing (ps): app state is unknown')
  return out
}

// Injection replaces only subprocess execution, retaining real arguments and
// failure producers for isolated tests.
export function realSystem(
  env: NodeJS.ProcessEnv = process.env,
  execute: System['exec'] = run,
): System {
  const app = env.ANYENGINE_CHATGPT_APP || '/Applications/ChatGPT.app'
  if (!isAbsolute(app) || /[\0\r\n]/.test(app))
    throw new Error('configured app bundle must be an absolute path')
  const launchctl = env.ANYENGINE_LAUNCHCTL || '/bin/launchctl'
  const osascript = env.ANYENGINE_OSASCRIPT || '/usr/bin/osascript'
  const open = env.ANYENGINE_OPEN || '/usr/bin/open'
  const pgrep = env.ANYENGINE_PGREP || '/usr/bin/pgrep'
  const ps = env.ANYENGINE_PS || '/bin/ps'
  const plutil = env.ANYENGINE_PLUTIL || '/usr/bin/plutil'
  const exec: System['exec'] = (command, args, options = {}) =>
    execute(command, args, { ...options, env: options.env ?? env })
  const plist = (key: string) =>
    exec(plutil, ['-extract', key, 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')])
  const appExecutable = () => {
    const info = plist('CFBundleExecutable')
    succeeded(info, 'read configured app executable (plutil)')
    const executable = info.stdout.trim()
    if (!executable || executable === '.' || executable === '..' || /[/\r\n\0]/.test(executable))
      throw new Error('invalid configured app executable')
    return join(app, 'Contents', 'MacOS', executable)
  }
  const appRunning = () => {
    const pattern = `^${escapeRegex(appExecutable())}([[:space:]]|$)`
    const result = exec(pgrep, ['-f', pattern])
    if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return false
    succeeded(result, 'app running query (pgrep)')
    const pids = result.stdout.trim().split('\n')
    if (
      !pids.every(
        (pid) => /^\d+$/.test(pid) && Number.isSafeInteger(Number(pid)) && Number(pid) > 0,
      )
    )
      throw new Error('cannot parse app running query (pgrep)')
    return true
  }
  return {
    home: env.HOME || homedir(),
    app,
    now: () => new Date(),
    exec,
    appVersion: () => {
      const result = plist('CFBundleShortVersionString')
      return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null
    },
    appRunning,
    appExecutable,
    quitApp: (timeoutMs = 30_000) => {
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('invalid quit timeout')
      if (!appRunning()) return true
      succeeded(
        exec(osascript, ['-e', `tell application ${quote(app)} to quit`]),
        'quit app (osascript)',
      )
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (!appRunning()) return true
        sleepSync(Math.min(500, Math.max(0, deadline - Date.now())))
      }
      return !appRunning()
    },
    openApp: () => succeeded(exec(open, ['-a', app]), 'open app'),
    launchctl: (args) => exec(launchctl, args),
    processes: () =>
      processRows(
        exec(ps, ['-axww', '-o', 'pid=,ppid=,pgid=,lstart=,command='], {
          env: { ...env, LC_ALL: 'C', TZ: 'UTC' },
        }),
      ),
    notify: (title, message) =>
      succeeded(
        exec(osascript, [
          '-e',
          `display notification ${quote(message.slice(0, 200))} with title ${quote(title.slice(0, 200))}`,
        ]),
        'notification (osascript)',
      ),
    spawnDetached(argv, log) {
      const command = argv[0]
      if (!command) throw new Error('missing detached command')
      const fd = openSync(log, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('unsafe detached log')
        const child = spawn(command, argv.slice(1), {
          detached: true,
          stdio: ['ignore', fd, fd],
          env,
        })
        child.on('error', () => {}) // Missing PID below is a synchronous failure, never an unhandled event.
        if (!child.pid) throw new Error('detached spawn failed')
        child.unref()
        return child.pid
      } finally {
        closeSync(fd)
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

// ps exposes a command string, not argv. Accept ordinary node invocations and
// quoted paths; reject incomplete quotes rather than guessing a flip's argv.
export function adapterArguments(
  command: string,
): { script: string; args: string[]; rawArgs: string } | null {
  const invocation =
    /^(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:"([^"]+)"|'([^']+)'|(.+?adapter\.mjs))(?=\s|$)(?:\s+(.*))?$/.exec(
      command,
    )
  if (!invocation) return null
  const node = invocation[1] ?? invocation[2] ?? invocation[3]
  const script = invocation[4] ?? invocation[5] ?? invocation[6]
  if (
    !node ||
    !script ||
    basename(node) !== 'node' ||
    basename(script) !== 'adapter.mjs' ||
    !(isAbsolute(script) || script === 'adapter.mjs' || /^\.\.?\//.test(script))
  )
    return null
  const words: string[] = []
  let word = ''
  let quoted = ''
  let escaped = false
  for (const char of invocation[7] ?? '') {
    if (escaped) {
      word += char
      escaped = false
    } else if (char === '\\' && quoted !== "'") escaped = true
    else if (quoted) {
      if (char === quoted) quoted = ''
      else word += char
    } else if (char === '"' || char === "'") quoted = char
    else if (/\s/.test(char)) {
      if (word) words.push(word)
      word = ''
    } else word += char
  }
  if (quoted || escaped) return null
  if (word) words.push(word)
  return { script, args: words, rawArgs: invocation[7] ?? '' }
}

export function adapterMode(args: string[]): string | undefined {
  let index = 0
  while (index < args.length) {
    const arg = args[index] ?? ''
    if (/^(-c|--config|-m|--model|-p|--profile|-C|--cd)$/.test(arg)) index += 2
    else if (/^(-c|--config|-m|--model|--profile|--cd)=/.test(arg)) index += 1
    else return arg
  }
  return undefined
}

// The shim resolves lib/current, so the running argv pins the loaded version.
export function adapterProcesses(
  system: System,
): Array<{ pid: number; version: string | null; command: string }> {
  return system.processes().flatMap(({ pid, command }) => {
    const invocation = adapterArguments(command)
    if (!invocation || adapterMode(invocation.args) !== 'app-server') return []
    const version =
      /\.anyengine\/lib\/([^/]+)\/dist\/src\/adapter\.mjs$/.exec(invocation.script)?.[1] ?? null
    return [{ pid, version, command }]
  })
}

export function ancestorCommands(system: System, pid: number): string[] {
  const byPid = new Map(system.processes().map((process) => [process.pid, process]))
  const out: string[] = []
  const visited = new Set([pid])
  let current = byPid.get(pid)?.ppid ?? 0
  for (let hops = 0; current > 1 && hops < 64 && !visited.has(current); hops += 1) {
    const parent = byPid.get(current)
    if (!parent) break
    visited.add(current)
    out.push(parent.command)
    current = parent.ppid
  }
  return out
}

export type ProcessOwnership = 'app' | 'other' | 'unknown'
const launches = (command: string, executable: string) =>
  [executable, `"${executable}"`, `'${executable}'`].some(
    (path) => command === path || command.startsWith(`${path} `),
  )
function independentRoot(record: ProcessInfo, app: string): boolean {
  if ([`${app}/`, `"${app}/`, `'${app}/`].some((prefix) => record.command.startsWith(prefix)))
    return false
  const first = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(record.command)
  const executable = first?.[1] ?? first?.[2] ?? first?.[3] ?? ''
  if (executable.startsWith(`${app}/`) || /^(?:ba|z|fi|da|k)?sh$/.test(basename(executable)))
    return false
  const adapter = adapterArguments(record.command)
  if (adapter) return adapterMode(adapter.args) !== 'app-server'
  return isAbsolute(executable) || /^node\s+\//.test(record.command)
}
function ancestryOwnership(
  record: ProcessInfo,
  byPid: Map<number, ProcessInfo>,
  executable: string,
  app: string,
): ProcessOwnership {
  const seen = new Set<number>()
  let current = record
  let owned = false
  for (let hops = 0; hops < 64; hops += 1) {
    if (seen.has(current.pid)) return 'unknown'
    seen.add(current.pid)
    owned ||= launches(current.command, executable)
    if (current.ppid === 1)
      return owned ? 'app' : independentRoot(current, app) ? 'other' : 'unknown'
    const parent = byPid.get(current.ppid)
    if (!parent || Date.parse(parent.processStart) > Date.parse(current.processStart))
      return 'unknown'
    current = parent
  }
  return 'unknown'
}
// Library paths and launch times do not establish who launched an adapter.
// Orphans and incomplete/reused ancestry remain blocking observations.
export function processOwnership(
  system: System,
  procs: ProcessInfo[],
): Map<number, ProcessOwnership> {
  const executable = system.appExecutable()
  const byPid = new Map<number, ProcessInfo>()
  for (const record of procs) {
    if (
      !Number.isSafeInteger(record.pid) ||
      record.pid < 1 ||
      !Number.isSafeInteger(record.ppid) ||
      record.ppid < 0 ||
      (record.ppid === 0 && record.pid !== 1) ||
      !Number.isFinite(Date.parse(record.processStart)) ||
      byPid.has(record.pid)
    )
      throw new Error('invalid or duplicate process identity in ownership census')
    byPid.set(record.pid, record)
  }
  return new Map(
    procs.map((record) => [record.pid, ancestryOwnership(record, byPid, executable, system.app)]),
  )
}
export function independentAdapterFamily(
  procs: ProcessInfo[],
  pids: number[],
  ownership: ReadonlyMap<number, ProcessOwnership>,
): Set<number> {
  const family = new Set(pids)
  let changed = true
  while (changed) {
    changed = false
    for (const record of procs)
      if (
        ownership.get(record.pid) === 'other' &&
        family.has(record.ppid) &&
        !family.has(record.pid)
      ) {
        family.add(record.pid)
        changed = true
      }
  }
  return family
}
