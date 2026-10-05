#!/usr/bin/env node
// Is it safe to restart ChatGPT.app now? A restart kills in-flight turns
// (spec 5.7: check for an active turn first), so this refuses while any
// sign of one is fresh: a Codex session rollout that is not explicitly a
// `codex exec` session's, or is one an app-server holds open, or the
// adapter's debug log showing turn traffic in --quiet-seconds (default 120), or
// an adapter turn still marked inProgress that started in the last six hours
// (older rows are left over from a crash and recovered at the next start). It
// reads only: it never writes to either home.
//
// Quiet has to mean something was looked at: a Codex home that is not there, or
// an adapter home that was named (--adapter-home, or ANYENGINE_HOME) and is not
// there, is "cannot tell", not "quiet". The quiet report lists each place it
// looked and what it found, so a check pointed at the wrong home shows.
//
// A restart also installs a staged app update. ChatGPT.app updates itself
// with Sparkle 2 (2.9.1 in 26.928): an update downloads in the background and
// installs when the app quits, so the quit a flip needs installed one on
// 2026-09-30 (26.911 to 26.928) and moved the bundled codex under the
// adapter. Staged means Sparkle's cache holds the download
// (PersistentDownloads/) or the unpacked update (Installation/), or its
// installer job is loaded in the user's launchd domain, waiting for the app
// to quit. Any of them is "not quiet". The cache and the job are named after
// the app's bundle id (com.openai.codex), read from its Info.plist
// (--app, else ANYENGINE_CHATGPT_APP, else /Applications/ChatGPT.app).
//
// Only a path that does not exist counts as empty. One that cannot be read
// (a permission error on it or a parent) is "cannot tell", as is a launchctl
// answer other than loaded (0) or not loaded (113), or an lsof or ps that
// gives no usable answer about who holds an exec rollout.
//
// Exit 0: quiet. Exit 1: something is busy, an update is staged, or the check
// could not tell. Exit 2: a bad option.
//
// It asks /usr/sbin/lsof and /bin/ps (the ones on PATH where those are
// missing); ANYENGINE_LSOF names another lsof.
//
// Usage: node scripts/preflip-check.mjs [--codex-home DIR] [--adapter-home DIR]
//          [--quiet-seconds N] [--app DIR]
import { spawnSync } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'

const USAGE =
  'usage: node scripts/preflip-check.mjs [--codex-home DIR] [--adapter-home DIR] [--quiet-seconds N] [--app DIR]'

function usageError(message) {
  console.error(`preflip-check: ${message}\n${USAGE}`)
  process.exit(2)
}

let options
try {
  options = parseArgs({
    options: {
      'codex-home': { type: 'string' },
      'adapter-home': { type: 'string' },
      'quiet-seconds': { type: 'string' },
      app: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  }).values
} catch (error) {
  usageError(error.message)
}

// A number that does not parse must not read as "no quiet period needed".
const quietSeconds = options['quiet-seconds'] ?? '120'
if (!/^\d+(\.\d+)?$/.test(quietSeconds)) {
  usageError(`--quiet-seconds needs a number of seconds, got ${JSON.stringify(quietSeconds)}`)
}
const quietMs = Number(quietSeconds) * 1000
const codexHome = options['codex-home'] ?? (process.env.CODEX_HOME || join(homedir(), '.codex'))
const namedAdapterHome = options['adapter-home'] ?? (process.env.ANYENGINE_HOME || undefined)
const adapterHome = namedAdapterHome ?? join(codexHome, 'anyengine')
const app = options.app ?? (process.env.ANYENGINE_CHATGPT_APP || '/Applications/ChatGPT.app')
const now = Date.now()

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// Absent means ENOENT and nothing else (existsSync is false for a path it
// cannot look at, too): these return null for a path that is not there and
// throw for one that cannot be read.
function statOrNull(path) {
  try {
    return statSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function listOrNull(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// A restart interrupts the app's turns only. Its codex threads write rollouts
// whose session_meta names the app (`vscode`) or a sub-agent of one; a
// `codex exec` batch job also writes rollouts here and must not hold the
// restart (2026-09-30: an exec job every few minutes kept one waiting for 50
// minutes). A rollout whose first line cannot be read is counted: not being
// able to tell is not quiet.
function recentFiles(dir, depth, sinceMs, out = []) {
  const listing = depth < 0 ? null : listOrNull(dir)
  if (!listing) return out
  for (const entry of listing) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) recentFiles(full, depth - 1, sinceMs, out)
    else {
      try {
        const mtimeMs = statSync(full).mtimeMs
        if (mtimeMs >= sinceMs) out.push({ path: full, mtimeMs })
      } catch (error) {
        // Rotated away between the listing and the stat: nothing to count.
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
  return out
}

// Only a rollout that says it is a `codex exec` session's is ignored. Not
// `cli`: the app lists CLI threads, and a turn it runs on one is appended to a
// rollout whose first line still says `cli`. Not `mcp`: codex 0.159 writes it
// for `--session-source app-server`, which an app update could start passing.
const NOT_THE_APP = new Set(['exec'])

function isAppRollout(path) {
  let first = ''
  try {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(65536)
      first = buffer
        .subarray(0, readSync(fd, buffer, 0, buffer.length, 0))
        .toString('utf8')
        .split('\n')[0]
    } finally {
      closeSync(fd)
    }
    const line = JSON.parse(first)
    return !(line?.type === 'session_meta' && NOT_THE_APP.has(line?.payload?.source))
  } catch {
    return true
  }
}

// An exec rollout still counts while an app-server holds it open: a
// `codex --remote` TUI attached to the app's adapter can resume an exec
// thread, and codex keeps a loaded thread's rollout open for writing. One
// lsof call covers every exec rollout in the window, and one ps call reads
// the holders' command lines. lsof exits 1 when a named file is open nowhere,
// and ps when none of the pids is running any more; any other status, a word
// on stderr, or no answer within PROBE_MS is "cannot tell".
const PROBE_MS = 5000

// launchd jobs and a detached flip can run with a PATH that lacks /usr/sbin,
// where macOS keeps lsof (ps is in /bin), so each is taken from where macOS
// keeps it, and from PATH only when it is not there. ANYENGINE_LSOF names
// another lsof (the tests' stand-in).
function tool(standard, override) {
  if (override) return override
  try {
    accessSync(standard, constants.X_OK)
    return standard
  } catch {
    return basename(standard)
  }
}

function probe(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PROBE_MS,
  })
  const stderr = result.stderr?.trim()
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1) || stderr) {
    const why = result.error?.message ?? result.signal ?? (stderr || `exit ${result.status}`)
    throw new Error(`${command} gave no usable answer about the exec rollouts (${why})`)
  }
  return result.stdout
}

// Each process holding one of paths, by pid, with the names lsof lists.
function holdersOf(paths) {
  const held = new Map()
  let names = null
  const lsof = tool('/usr/sbin/lsof', process.env.ANYENGINE_LSOF)
  for (const line of probe(lsof, ['-w', '-Fpn', '--', ...paths]).split('\n')) {
    if (line.startsWith('p')) {
      const pid = line.slice(1)
      if (!/^\d+$/.test(pid)) throw new Error(`lsof listed an odd pid ${JSON.stringify(pid)}`)
      names = held.get(pid) ?? new Set()
      held.set(pid, names)
    } else if (line.startsWith('n') && names) names.add(line.slice(1))
  }
  return held
}

function heldByAppServer(paths) {
  const held = paths.length > 0 ? holdersOf(paths) : new Map()
  if (held.size === 0) return []
  const commands = new Map()
  const pids = [...held.keys()].join(',')
  const listing = probe(tool('/bin/ps'), ['-ww', '-o', 'pid=,args=', '-p', pids])
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match) commands.set(match[1], match[2])
  }
  const busy = []
  for (const [pid, names] of held) {
    if (!commands.get(pid)?.includes(' app-server')) continue
    const what = names.size > 0 ? [...names].join(', ') : 'an exec rollout'
    busy.push(`${what} is held open by an app-server (pid ${pid})`)
  }
  return busy
}

// node:sqlite still prints an ExperimentalWarning on load; this script's
// output is a checklist, so drop that one line and nothing else.
function loadSqlite() {
  const emit = process.emitWarning
  process.emitWarning = (warning, ...rest) => {
    if (!String(warning).includes('SQLite')) emit.call(process, warning, ...rest)
  }
  try {
    return createRequire(import.meta.url)('node:sqlite')
  } finally {
    process.emitWarning = emit
  }
}

// A row with no start time has no age to call stale, so it counts. null: there
// is no database to ask.
function inProgressTurns(path) {
  if (!statOrNull(path)) return null
  const db = new (loadSqlite().DatabaseSync)(path, { readOnly: true })
  try {
    const since = Math.floor(now / 1000) - 6 * 3600
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM turns WHERE status = 'inProgress' AND (started_at IS NULL OR started_at > ?)",
      )
      .get(since)
    return Number(row?.n ?? 0)
  } finally {
    db.close()
  }
}

// Only these read-only methods in the ordinary request/response pipeline are
// background polling. Unknown methods AND unknown events stay activity. In
// particular, a server request or runtime/bridge event cannot be exempted by
// carrying a read method. Names come from server.mts and codex-{mux,upstream}.
const BACKGROUND_METHODS = new Set([
  'configRequirements/read',
  'thread/list',
  'thread/read',
  'thread/loaded/list',
  'thread/turns/list',
  'thread/turns/items/list',
  'thread/attachment/list',
  'model/list',
  'modelProvider/capabilities/read',
  'account/read',
  'account/rateLimits/read',
  'getAuthStatus',
  'config/read',
  'mcpServerStatus/list',
  'experimentalFeature/list',
  'permissionProfile/list',
  'collaborationMode/list',
  'skills/list',
  'hooks/list',
  'plugin/list',
  'plugin/read',
  'app/list',
])
const BACKGROUND_RPC_EVENTS = new Set([
  'rpc.request',
  'rpc.response',
  'codex.mux.route',
  'codex.upstream.forward',
  'codex.upstream.response',
])
const LOG_TAIL_BYTES = 2 * 1024 * 1024

function adapterLogActivity(path, sinceMs) {
  const fd = openSync(path, 'r')
  try {
    const before = fstatSync(fd)
    if (!before.isFile()) throw new Error(`${path} is not a regular log file`)
    const offset = Math.max(0, before.size - LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(before.size - offset)
    if (readSync(fd, buffer, 0, buffer.length, offset) !== buffer.length) {
      throw new Error(`${path} log tail could not be read completely`)
    }
    // A bounded read can start halfway through a UTF-8 character or a JSON
    // record. Discard that first fragment before decoding; never copy the log.
    const start = offset > 0 ? buffer.indexOf(10) + 1 : 0
    const lines =
      offset > 0 && start === 0 ? [] : buffer.subarray(start).toString('utf8').split('\n')
    let parsed = 0
    let activity = 0
    let background = 0
    let reachesStart = false
    for (const line of lines) {
      if (!line.trim()) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        // An interrupted append may leave a broken line, but it cannot be
        // the only evidence: at least one usable record must remain below.
        continue
      }
      const ts = typeof record?.ts === 'string' ? Date.parse(record.ts) : NaN
      if (!Number.isFinite(ts) || typeof record?.event !== 'string' || !record.event) {
        throw new Error(`${path} contains a log record without a usable timestamp or event`)
      }
      parsed++
      if (ts <= sinceMs) reachesStart = true
      if (ts < sinceMs) continue
      if (BACKGROUND_RPC_EVENTS.has(record.event) && BACKGROUND_METHODS.has(record.method)) {
        background++
      } else {
        activity++
      }
    }
    if (parsed === 0) throw new Error(`${path} has no parseable log records`)
    // A prefix remains readable when its writer appends. Rotation, truncation
    // or an in-place rewrite invalidates the observed tail.
    const after = statSync(path)
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.size < before.size ||
      (before.size === after.size && before.mtimeMs !== after.mtimeMs)
    ) {
      throw new Error(`${path} changed while reading its log tail`)
    }
    return { activity, background, reachesStart }
  } finally {
    closeSync(fd)
  }
}

const ago = (file) => `${Math.round((now - file.mtimeMs) / 1000)}s ago`

// The app's bundle id, which names Sparkle's cache and its installer job, as
// plutil reads it (XML or binary, the top-level key only). No plutil, no
// answer: this only ever runs on the Mac the app is on.
function bundleIdOf(appDir) {
  const plist = join(appDir, 'Contents', 'Info.plist')
  const read = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (read.status !== 0) {
    const why = read.error?.message ?? (read.stderr.trim() || `exit ${read.status}`)
    throw new Error(`plutil cannot read CFBundleIdentifier from ${plist}: ${why}`)
  }
  const id = read.stdout.trim()
  if (!/^[A-Za-z0-9.-]+$/.test(id)) throw new Error(`no usable CFBundleIdentifier in ${plist}`)
  return id
}

// What a directory holds, Finder's bookkeeping aside; null when it is absent.
function entries(dir) {
  return listOrNull(dir)
    ?.map((entry) => entry.name)
    .filter((name) => name !== '.DS_Store')
}

// Is Sparkle's installer job loaded in the user's launchd domain? `launchctl
// print` exits 0 for a loaded job and 113 for none; anything else, a missing
// launchctl included, is no answer.
function updaterJobLoaded(target) {
  const result = spawnSync('launchctl', ['print', target], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status === 0) return true
  if (result.status === 113) return false
  throw new Error(
    `launchctl print ${target} gave ${result.error?.message ?? `exit ${result.status}`}`,
  )
}

// Evidence of an update that the next quit would install, and what was looked at.
function stagedUpdate() {
  const id = bundleIdOf(app)
  const sparkle = join(homedir(), 'Library', 'Caches', id, 'org.sparkle-project.Sparkle')
  const job = `gui/${process.getuid()}/${id}-sparkle-updater`
  const found = []
  const cache = entries(sparkle)
  for (const name of ['Installation', 'PersistentDownloads']) {
    const held = cache ? entries(join(sparkle, name)) : null
    if (held?.length) found.push(`${join(sparkle, name)} holds ${held.join(', ')}`)
  }
  if (updaterJobLoaded(job)) found.push(`launchd job ${job} is loaded`)
  const seen = [`${sparkle}: ${cache ? 'no staged update' : 'absent'}`, `${job}: not loaded`]
  return { found, seen }
}

try {
  if (!isDirectory(codexHome)) {
    throw new Error(`the Codex home ${JSON.stringify(codexHome)} is not a directory`)
  }
  if (namedAdapterHome !== undefined && !isDirectory(namedAdapterHome)) {
    throw new Error(`the adapter home ${JSON.stringify(namedAdapterHome)} is not a directory`)
  }
  const sessions = join(codexHome, 'sessions')
  const logPath = join(adapterHome, 'debug.jsonl')
  const statePath = join(adapterHome, 'state.sqlite')
  const appRollouts = []
  const execRollouts = []
  for (const file of recentFiles(sessions, 4, now - quietMs)) {
    if (isAppRollout(file.path)) appRollouts.push(file)
    else execRollouts.push(file)
  }
  const debugLog = adapterLogActivity(logPath, now - quietMs)
  const turns = inProgressTurns(statePath)

  const busy = appRollouts.map((file) => `${file.path} was written ${ago(file)}`)
  busy.push(...heldByAppServer(execRollouts.map((file) => file.path)))
  const logReport = `${logPath}: ${debugLog.activity} turn-activity events in the window, ${debugLog.background} background events ignored`
  if (debugLog.activity > 0) busy.push(logReport)
  else console.log(`  ${logReport}`)
  if (!debugLog.reachesStart) {
    busy.push(`${logPath}: tail does not reach the start of the quiet window`)
  }
  if (turns > 0)
    busy.push(`${turns} adapter turn${turns === 1 ? ' is' : 's are'} still in progress`)

  if (busy.length > 0) {
    console.error(`preflip-check: not quiet; wait, then run again:\n  ${busy.join('\n  ')}`)
  }
  const staged = stagedUpdate()
  if (staged.found.length > 0) {
    console.error(
      `preflip-check: not quiet: an app update is staged and would install on restart:\n  ${staged.found.join('\n  ')}\n` +
        'Let it install with nothing flipped (quit and reopen ChatGPT.app), then run the gates ' +
        'against the codex it brings before flipping.',
    )
  }
  if (busy.length > 0 || staged.found.length > 0) process.exit(1)
  console.log(`preflip-check: quiet (no Codex or adapter activity in the last ${quietMs / 1000}s)`)
  console.log(
    `  ${sessions}: ${appRollouts.length} app rollouts in the window, ${execRollouts.length} recent rollouts ignored (not the app's)`,
  )
  console.log(`  ${statePath}: ${turns === null ? 'absent' : `${turns} turns in progress`}`)
  for (const line of staged.seen) console.log(`  ${line}`)
} catch (error) {
  // Not being able to look is not the same as nothing being there.
  console.error(
    `preflip-check: cannot tell whether a turn is in flight or an update is staged (${error.message})`,
  )
  process.exit(1)
}
