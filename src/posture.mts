// The canonical posture (spec 5.6): what a thread may do, in Codex's model.
// Each engine's vocabulary is converted into this one type and every tool call
// is judged against it, so "never looser than the parent" is one function
// (`decide`) and one property test (test/posture.test.mts), not a rule per
// runtime.
//
// An effect is a read, a write to a path, network, anything that runs
// outside every sandbox, or an MCP tool call. Outcomes rank
// deny < ask < review < allow: a human is tighter than a reviewer model, which
// is tighter than running unattended.
//
// The conversions in and out of this type (Codex requests and answers, stored
// rows, Codex child starts, Claude permission modes) live in
// src/posture-convert.mts, which imports only types from here; this module
// re-exports them, so every consumer imports the posture from one place.
import { readlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DEFAULT_POSTURE, type GRANULAR_FLAGS } from './posture-convert.mjs'
import { withLocalReadRestrictions } from './requirements-reads.mjs'

export {
  applyCodexParams,
  contextPosture,
  DEFAULT_POSTURE,
  fromClaudePermissionMode,
  GRANULAR_FLAGS,
  legacyPosture,
  POSTURE_SCHEMA_COVERAGE,
  parseApprovalPolicy,
  parseReviewer,
  parseSandboxMode,
  parseSandboxPolicy,
  parseStoredPosture,
  postureFields,
  SANDBOX_POLICY_FIELDS,
  threadPosture,
  toCodexExecSandboxPolicy,
  toCodexSandboxPolicy,
  toCodexThreadStart,
  toCodexTurn,
  turnWithPosture,
} from './posture-convert.mjs'

export type GranularFlag = (typeof GRANULAR_FLAGS)[number]
export type GranularApproval = Record<GranularFlag, boolean>
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never' | { granular: GranularApproval }
export type Reviewer = 'user' | 'auto_review'
export type Trust = 'trusted' | 'untrusted' | 'unknown'

type WorkspaceWrite = {
  kind: 'workspace-write'
  // Beyond the thread's cwd, which workspace-write always includes.
  writableRoots: string[]
  excludeTmpdirEnvVar: boolean
  excludeSlashTmp: boolean
}
export type FileSystemPosture =
  | { kind: 'read-only' }
  | WorkspaceWrite
  | { kind: 'full-access' }
  | { kind: 'external' }

// Project Claude config as the app found it when it started the thread
// (src/claude-project-guard.mts): path to sha256, `absent` or `unreadable`.
export type ProjectBaseline = Record<string, string>

export interface Posture {
  // Fail closed until per-path read restrictions can be enforced. Sticky.
  readRestricted?: boolean
  fileSystem: FileSystemPosture
  network: boolean
  approval: ApprovalPolicy
  reviewer: Reviewer
  plan: boolean
  trust: Trust
  // Absent until the app starts the thread; a Claude launch without it, or
  // whose project config no longer matches it, loads the user's settings alone.
  projectBaseline?: ProjectBaseline
}

export type Outcome = 'deny' | 'ask' | 'review' | 'allow'

export type Effect =
  | { kind: 'read' }
  | { kind: 'write'; path: string }
  | { kind: 'net' }
  | { kind: 'unbounded' }
  | { kind: 'mcp' }

// Where the relative parts of a posture resolve: the thread's cwd and the
// two temp roots workspace-write adds unless told not to.
export interface PostureContext {
  cwd: string
  tmpdir: string
  slashTmp: string
}

const RANK: Record<Outcome, number> = { deny: 0, ask: 1, review: 2, allow: 3 }

export function outcomeRank(outcome: Outcome): number {
  return RANK[outcome]
}

export function postureContext(cwd: string): PostureContext {
  return { cwd, tmpdir: tmpdir(), slashTmp: '/tmp' }
}

// ---- decisions ----------------------------------------------------------------

// The canonical semantics: what `posture` does with an effect reached
// directly (a file tool, a fetch, an escalated command).
export function decide(posture: Posture, effect: Effect, ctx: PostureContext): Outcome {
  return directOutcome(posture, effect, !posture.plan && withinSandbox(posture, effect, ctx))
}

// `decide`, given whether the effect lies inside the sandbox's own bounds.
function directOutcome(posture: Posture, effect: Effect, inside: boolean): Outcome {
  if (posture.readRestricted && effect.kind !== 'mcp') return 'deny'
  // Plan mode reads and calls MCP tools (the Codex parent's own bridge call
  // is one) and does nothing else.
  if (posture.plan) return effect.kind === 'read' || effect.kind === 'mcp' ? 'allow' : 'deny'
  // Codex runs MCP tools without asking (`default_tools_approval_mode`). A
  // write, network or anything unbounded runs unattended inside the sandbox
  // and leaves it only by escalating.
  if (effect.kind === 'read' || effect.kind === 'mcp') return 'allow'
  return inside ? unattended(posture) : escalate(posture)
}

// A command confined to the posture's own sandbox runs unattended, unless the
// approval policy asks before every command or the thread is planning.
export function sandboxedOutcome(posture: Posture): Outcome {
  return posture.plan || posture.readRestricted ? 'deny' : unattended(posture)
}

// Everything that can reach `effect`: the direct path (`decide`), or a
// sandboxed command when the effect lies inside the sandbox's own bounds.
// This is what "never looser" compares (test/posture.test.mts).
export function reach(posture: Posture, effect: Effect, ctx: PostureContext): Outcome {
  const inside = withinSandbox(posture, effect, ctx)
  const direct = directOutcome(posture, effect, inside)
  if (!inside) return direct
  const sandboxed = sandboxedOutcome(posture)
  return RANK[sandboxed] > RANK[direct] ? sandboxed : direct
}

function withinSandbox(posture: Posture, effect: Effect, ctx: PostureContext): boolean {
  switch (effect.kind) {
    case 'read':
      return true
    case 'write':
      return canWrite(posture, effect.path, ctx)
    case 'net':
      return hasNetwork(posture)
    case 'unbounded':
      return posture.fileSystem.kind === 'full-access'
    case 'mcp':
      return false
  }
}

// Full access with nothing that asks: the only posture under which a runtime
// may drop its own approvals (grok --always-approve, claude -p
// --dangerously-skip-permissions, codex exec's bypass flag).
export function isUnrestricted(posture: Posture): boolean {
  return (
    !posture.readRestricted &&
    posture.fileSystem.kind === 'full-access' &&
    !posture.plan &&
    posture.approval !== 'untrusted'
  )
}

function unattended(posture: Posture): Outcome {
  return posture.approval === 'untrusted' ? 'ask' : 'allow'
}

// Leaving the sandbox needs approval: refused under `never`, or under a
// granular policy without `sandbox_approval` (spec 5.6, fix 4: `never` means
// no prompts, not no bounds), otherwise asked of the posture's reviewer.
function escalate(posture: Posture): Outcome {
  const policy = posture.approval
  if (policy === 'never') return 'deny'
  if (typeof policy === 'object' && !policy.granular.sandbox_approval) return 'deny'
  return posture.reviewer === 'auto_review' ? 'review' : 'ask'
}

function hasNetwork(posture: Posture): boolean {
  return posture.network || posture.fileSystem.kind === 'full-access'
}

// ---- paths --------------------------------------------------------------------

// Read-only inside every writable root: Codex's own two; Claude Code's
// configuration, whose hooks, statusLine and MCP servers a Claude child
// started there would run outside every sandbox; and `.anyengine`, which
// holds the relay's own per-spawn hooks and MCP config (~/.anyengine/pty).
// Codex's sandbox does not hold the last three back from a shell. Compared
// case-folded: macOS volumes are case-insensitive, so `.GIT` is `.git` there.
const PROTECTED_NAMES = ['.git', '.codex', '.claude', '.mcp.json', '.anyengine']

export function writableRoots(posture: Posture, ctx: PostureContext): string[] | 'all' {
  const fs = posture.fileSystem
  if (fs.kind === 'full-access') return 'all'
  if (fs.kind === 'read-only') return []
  if (fs.kind === 'external') return [ctx.cwd]
  const roots = [ctx.cwd, ...fs.writableRoots]
  if (!fs.excludeSlashTmp) roots.push(ctx.slashTmp)
  if (!fs.excludeTmpdirEnvVar) roots.push(ctx.tmpdir)
  return roots
}

// Where a child the calling thread spawns starts, and under what: the caller's
// posture (the default when the caller is unknown), in the requested cwd
// resolved against the caller's. A workspace-write or external child writes
// to its own cwd, so it gets one of the caller's own roots (its cwd or an
// explicit writable root), matched by real path and handed over as the caller
// holds it. The caller could later swap a subdirectory, or a link, for a link
// to anywhere; a swap of one of its own roots would widen the caller too, so
// the child is never the looser one. A read-only or full-access child does
// not write through its cwd.
export function childStart(
  caller: { posture: Posture; cwd: string | null } | null,
  requested: unknown,
): { posture: Posture; cwd: string } {
  const posture = withLocalReadRestrictions(caller?.posture ?? DEFAULT_POSTURE)
  const base = caller?.cwd ?? process.cwd()
  const cwd = typeof requested === 'string' && requested ? resolve(base, requested) : base
  const fs = posture.fileSystem
  if (fs.kind !== 'workspace-write' && fs.kind !== 'external') return { posture, cwd }
  const target = landing(cwd)
  const roots = [caller?.cwd, ...(fs.kind === 'workspace-write' ? fs.writableRoots : [])]
  const root = roots.find((r) => r && isAbsolute(r) && target !== null && landing(r) === target)
  if (!root) throw new Error(`cwd ${cwd} is not the calling thread's cwd or one of its roots`)
  return { posture, cwd: root }
}

function canWrite(posture: Posture, path: string, ctx: PostureContext): boolean {
  const roots = writableRoots(posture, ctx)
  if (roots === 'all') return true
  // Joined as written: the OS, not string rules, decides where a `..` lands.
  const target = landing(isAbsolute(path) ? path : `${ctx.cwd}${sep}${path}`)
  if (target === null) return false
  return roots.some((root) => {
    // Codex takes only absolute roots; a relative one bounds nothing here.
    const base = isAbsolute(root) ? landing(root) : null
    if (base === null || !isInside(base, target)) return false
    const first = relative(base, target).split(sep)[0]?.toLowerCase() ?? ''
    return !PROTECTED_NAMES.includes(first)
  })
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const MAX_LINKS = 40

// Where a write to `path` lands, resolved the way the OS resolves it, so a
// link inside a writable root cannot aim a write outside it (spec 5.5 G1): a
// link is followed first and a `..` after it applies where it landed, and a
// dangling link leads to where the write would create its target. No `..` is
// dropped as a string before the OS has resolved the links in front of it.
// Null when the OS could not resolve it either (a link loop, or more than
// MAX_LINKS links): no root contains it. A link made after the check is not
// caught here; the OS sandbox behind `exec` covers the shell.
function landing(path: string, links = 0): string | null {
  const rest: string[] = []
  let head = path
  for (;;) {
    let real: string
    try {
      real = realpathSync.native(head)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') return null
      const parent = dirname(head)
      if (parent === head) return null
      rest.unshift(basename(head))
      head = parent
      continue
    }
    return walk(real, rest, links)
  }
}

// Walks the names the OS could not resolve (the first one is missing, or a
// dangling link) down from `real`, which has no link in it, so each `..`
// steps out of a real directory. A name that does not exist yet is taken as
// written; a link hands its raw target, with the rest still raw behind it,
// back to the OS.
function walk(real: string, names: string[], links: number): string | null {
  let at = real
  for (const [index, name] of names.entries()) {
    if (name === '..') {
      at = dirname(at)
      continue
    }
    if (name === '' || name === '.') continue
    const target = readLink(join(at, name))
    if (target === null) {
      at = join(at, name)
      continue
    }
    if (links >= MAX_LINKS) return null
    const from = isAbsolute(target) ? target : `${at}${sep}${target}`
    return landing([from, ...names.slice(index + 1)].join(sep), links + 1)
  }
  return at
}

function readLink(path: string): string | null {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

// Where a write to `path` lands (see `landing`). Throws ELOOP, as fs does,
// when the OS could not resolve it either, so an unresolvable path never
// reaches a caller as a string it could hand to fs.
export function realPath(path: string): string {
  const real = landing(path)
  if (real !== null) return real
  const error: NodeJS.ErrnoException = new Error(`ELOOP: cannot resolve ${path}`)
  error.code = 'ELOOP'
  throw error
}

export function postureSummary(posture: Posture): string {
  const approval = typeof posture.approval === 'string' ? posture.approval : 'granular'
  const plan = posture.plan ? 'plan, ' : ''
  return `${plan}${posture.fileSystem.kind}, network ${posture.network ? 'on' : 'off'}, ${approval}`
}

// Unknown lineage gets plan mode with reads restricted: only MCP calls
// remain reachable. Every canonical effect and workspace trust is at its
// tightest, including Codex read restrictions.
export const STRICTEST_POSTURE: Posture = {
  fileSystem: { kind: 'read-only' },
  network: false,
  approval: 'untrusted',
  reviewer: 'user',
  plan: true,
  trust: 'untrusted',
  readRestricted: true,
}

// Write permissions change only at a writable root or one of its protected
// subtrees. Compare every boundary from BOTH postures, in real-path space;
// sampling only cwd/tmp misses extra roots and overlapping protected paths.
function writeBoundaries(a: Posture, b: Posture, ctx: PostureContext): string[] {
  const paths = new Set<string>(['/'])
  for (const posture of [a, b]) {
    const roots = writableRoots(posture, ctx)
    if (roots === 'all') continue
    for (const root of roots) {
      const base = isAbsolute(root) ? landing(root) : null
      if (base === null) continue
      paths.add(base)
      for (const name of PROTECTED_NAMES) paths.add(join(base, name))
    }
  }
  return [...paths]
}

// Is `a` no looser than `b` on every effect (and on a sandboxed command)?
export function noLooser(a: Posture, b: Posture, ctx: PostureContext): boolean {
  // Unknown and trusted workspaces both allow accepting Claude's trust dialog.
  if (a.trust !== 'untrusted' && b.trust === 'untrusted') return false
  if (outcomeRank(sandboxedOutcome(a)) > outcomeRank(sandboxedOutcome(b))) return false
  for (const kind of ['read', 'mcp', 'net', 'unbounded'] as const) {
    if (outcomeRank(reach(a, { kind }, ctx)) > outcomeRank(reach(b, { kind }, ctx))) return false
  }
  // These postures deny every write; read and trust were compared above.
  if (a.plan || a.readRestricted) return true
  // Cheap proof when all possible inside/outside combinations are safe.
  const outcomes = (p: Posture) =>
    p.fileSystem.kind === 'full-access'
      ? [unattended(p)]
      : p.fileSystem.kind === 'read-only'
        ? [escalate(p)]
        : [unattended(p), escalate(p)]
  if (outcomes(a).every((x) => outcomes(b).every((y) => outcomeRank(x) <= outcomeRank(y))))
    return true
  return writeBoundaries(a, b, ctx).every((path) => {
    const effect: Effect = { kind: 'write', path }
    return outcomeRank(reach(a, effect, ctx)) <= outcomeRank(reach(b, effect, ctx))
  })
}

// A claimed child runs under the tighter of what it was spawned with and what
// its parent has now: a parent that tightened since tightens the child, one
// that loosened does not loosen it. When neither is no looser than the other,
// or the parent is unknown, the child gets the strictest posture.
export function claimPosture(
  child: Posture | null,
  parent: Posture | null,
  ctx: PostureContext,
): Posture {
  if (!parent || !child) return STRICTEST_POSTURE
  if (noLooser(parent, child, ctx)) return parent
  if (noLooser(child, parent, ctx)) return child
  return STRICTEST_POSTURE
}
