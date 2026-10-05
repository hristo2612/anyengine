// The project Claude config a Claude child loads at launch (hooks, statusLine,
// MCP servers) runs outside every sandbox. A sandboxed writer in the session
// (the relay, bridge `exec`, a GPT parent's shell, a nested writable root)
// could write it and then have the bridge start a Claude that loads it. So
// the app records a fingerprint of that config when it starts a thread, a
// bridge child takes its caller's and never records its own, and a Claude
// launch whose fingerprint no longer matches loads the user's settings alone
// (claudeLaunchFor, src/posture-claude.mts).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, sep } from 'node:path'
import { isBridgePeer } from './bridge-control.mjs'
import type { NativeCodexMux, UpstreamThreadInfo } from './codex-mux.mjs'
import {
  applyCodexParams,
  DEFAULT_POSTURE,
  type Posture,
  type ProjectBaseline,
  postureFields,
  realPath,
  threadPosture,
} from './posture.mjs'
import { durablePosture } from './requirements-reads.mjs'
import type { SessionStore } from './store.mjs'
import type { RpcPeer, ThreadRecord } from './types.mjs'

const ABSENT = 'absent'
const UNREADABLE = 'unreadable'

// What Claude Code 2.1.284 started in `cwd` loads as project config:
// `.claude/settings.json` there, `.claude/settings.local.json` there, at the
// enclosing git root and, in a linked worktree, at the main checkout (the CLI
// keeps it at that canonical root unless it is the home directory), and
// `.mcp.json` there and in every directory above. Keyed by the path the OS
// resolves, each a sha256, `absent` or `unreadable`; a worktree's `.git` file
// that cannot be followed is itself `unreadable`.
export function projectBaseline(cwd: string): ProjectBaseline {
  let real: string
  try {
    real = realPath(cwd)
  } catch {
    return { [cwd]: UNREADABLE }
  }
  const files = [
    join(real, '.claude', 'settings.json'),
    join(real, '.claude', 'settings.local.json'),
  ]
  const marks: ProjectBaseline = {}
  for (const root of localSettingsRoots(real, marks)) {
    if (root !== real) files.push(join(root, '.claude', 'settings.local.json'))
  }
  for (let dir = real; dir !== parse(dir).root; dir = dirname(dir))
    files.push(join(dir, '.mcp.json'))
  return { ...Object.fromEntries(files.map((file) => [file, digest(file)])), ...marks }
}

// A thread without a baseline never matches.
export function projectConfigChanged(posture: Posture, cwd: string): boolean {
  const recorded = posture.projectBaseline
  if (!recorded) return true
  const current = projectBaseline(cwd)
  const keys = Object.keys(current)
  return (
    keys.length !== Object.keys(recorded).length || keys.some((k) => recorded[k] !== current[k])
  )
}

// thread/start from the app, or thread/resume of a thread without one. A
// bridge peer never records: its children take their caller's.
export function appBaseline(peer: RpcPeer, posture: Posture, cwd: string): Posture {
  if (isBridgePeer(peer) || posture.projectBaseline) return posture
  return { ...posture, projectBaseline: projectBaseline(cwd) }
}

export function baselinedRow<T extends ThreadRecord & { posture: Posture }>(
  peer: RpcPeer,
  row: T,
): T {
  return { ...row, posture: appBaseline(peer, row.posture, row.cwd) }
}

// What no Codex request or answer carries comes from the caller (or, for a
// GPT thread, from what the adapter held before the answer): the trust, where
// `untrusted` is sticky, and the baseline, the child's own never kept.
export function inheritFromCaller(child: Posture, caller: Posture): Posture {
  child = durablePosture(child)
  caller = durablePosture(caller)
  const { projectBaseline: _own, ...rest } = child
  if (caller.readRestricted) rest.readRestricted = true
  const trust = child.trust === 'untrusted' ? 'untrusted' : caller.trust
  const baseline = caller.projectBaseline
  return baseline ? { ...rest, trust, projectBaseline: baseline } : { ...rest, trust }
}

// server.mts#bridgeHost: on the row of a Claude or Grok child, beside the
// lifecycle answer of a GPT one.
export function inheritIntoThread(
  store: SessionStore,
  mux: NativeCodexMux | null,
  threadId: string,
  caller: Posture,
): void {
  const row = store.getThread(threadId)
  if (!row) mux?.updateUpstreamPosture(threadId, (posture) => inheritFromCaller(posture, caller))
  else
    store.upsertThread({ ...row, ...postureFields(inheritFromCaller(threadPosture(row), caller)) })
}

// thread/start | thread/resume | thread/fork result -> what the bridge knows of
// a child-owned thread. The answer's `sandbox` is its effective SandboxPolicy;
// trust and the baseline carry over from `prior` (the thread resumed or
// forked), and an app-started thread without a baseline records one.
export function upstreamThreadInfoFrom(
  result: Record<string, unknown>,
  prior?: Posture,
  peer?: RpcPeer,
): UpstreamThreadInfo {
  const cwd = typeof result.cwd === 'string' ? result.cwd : null
  const answered = applyCodexParams(DEFAULT_POSTURE, result)
  const posture = prior ? inheritFromCaller(answered, prior) : answered
  return {
    cwd,
    model: typeof result.model === 'string' ? result.model : null,
    posture: peer && cwd ? appBaseline(peer, posture, cwd) : posture,
  }
}

// The git root, and for a linked worktree the main checkout: its `.git` file
// names a gitdir whose `commondir` is the main `.git`. Neither when it is the
// home directory, as the CLI does.
function localSettingsRoots(dir: string, marks: ProjectBaseline): string[] {
  const root = gitRoot(dir)
  if (root === null) return []
  const main = mainCheckout(root)
  if (main === null) marks[join(root, '.git')] = UNREADABLE
  return main === null || main === root || main === realHome() ? [root] : [root, main]
}

// `root` when `.git` is a directory; else the checkout its gitdir's
// `commondir` leads to (the common dir itself when that is not a `.git`, as
// for a bare repository); null when the file cannot be followed.
function mainCheckout(root: string): string | null {
  const dotGit = join(root, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return root
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]
    if (!gitdir) return null
    const at = resolved(root, gitdir)
    const common = resolved(at, readFileSync(join(at, 'commondir'), 'utf8').trim())
    return basename(common) === '.git' ? dirname(common) : common
  } catch {
    return null
  }
}

// As posture.mts joins a relative path: as written, then resolved by the OS.
function resolved(base: string, path: string): string {
  return realPath(isAbsolute(path) ? path : `${base}${sep}${path}`)
}

function gitRoot(dir: string): string | null {
  for (let at = dir; at !== parse(at).root; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return at === realHome() ? null : at
  }
  return null
}

function realHome(): string {
  try {
    return realpathSync.native(homedir())
  } catch {
    return homedir()
  }
}

function digest(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? ABSENT : UNREADABLE
  }
}
