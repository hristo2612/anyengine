// Conversions between the canonical posture (src/posture.mts) and each
// engine's vocabulary: Codex requests and lifecycle answers, stored and legacy
// thread rows, Codex child starts and command/exec, Claude permission modes.
// Only types come from posture.mts, which re-exports everything here.
import type {
  ApprovalPolicy,
  FileSystemPosture,
  GranularApproval,
  Posture,
  Reviewer,
  Trust,
} from './posture.mjs'
import { threadPosture } from './posture-context.mjs'
import { hasReadRestriction, profileIdOf } from './posture-reads.mjs'
import { durablePosture } from './requirements-reads.mjs'

export { contextPosture, legacyPosture, threadPosture } from './posture-context.mjs'

import type { ThreadRecord } from './types.mjs'
import { debugLog } from './util.mjs'

type WorkspaceWrite = Extract<FileSystemPosture, { kind: 'workspace-write' }>

export const GRANULAR_FLAGS = [
  'sandbox_approval',
  'rules',
  'mcp_elicitations',
  'skill_approval',
  'request_permissions',
] as const

// What a thread that names nothing gets: Codex's own default, read-only and
// asking before anything leaves it. Never full access (spec 5.6, fix 1).
export const DEFAULT_POSTURE: Posture = {
  fileSystem: { kind: 'read-only' },
  network: false,
  approval: 'on-request',
  reviewer: 'user',
  plan: false,
  trust: 'unknown',
}

// ---- from Codex -------------------------------------------------------------

export function parseApprovalPolicy(value: unknown): ApprovalPolicy | null {
  if (typeof value === 'string') return parseApprovalString(value.trim())
  const granular = asRecord(value).granular
  if (!isRecord(granular)) return null
  // A flag the client left out reads as false: refuse rather than ask.
  const flags = {} as GranularApproval
  for (const flag of GRANULAR_FLAGS) flags[flag] = granular[flag] === true
  return { granular: flags }
}

function parseApprovalString(value: string): ApprovalPolicy | null {
  switch (value) {
    case 'untrusted':
    case 'unless-trusted':
      return 'untrusted'
    // `on-failure` survives only as a serde alias of `on-request`; it no
    // longer means "accept edits" (spec 5.6, fix 6).
    case 'on-request':
    case 'on-failure':
      return 'on-request'
    case 'never':
      return 'never'
    default:
      return null
  }
}

export function parseReviewer(value: unknown): Reviewer | null {
  if (value === 'user') return 'user'
  // `guardian_subagent` is the spelling Codex still accepts for auto_review.
  if (value === 'auto_review' || value === 'guardian_subagent') return 'auto_review'
  return null
}

export function parseSandboxMode(value: unknown): FileSystemPosture | null {
  if (value === 'read-only') return { kind: 'read-only' }
  if (value === 'workspace-write') return workspaceWrite([], false, false)
  if (value === 'danger-full-access') return { kind: 'full-access' }
  return null
}

interface SandboxPart {
  fileSystem: FileSystemPosture
  network: boolean
}

export function parseSandboxPolicy(value: unknown): SandboxPart | null {
  const policy = asRecord(value)
  switch (policy.type) {
    case 'dangerFullAccess':
      return { fileSystem: { kind: 'full-access' }, network: true }
    case 'readOnly':
      return { fileSystem: { kind: 'read-only' }, network: policy.networkAccess === true }
    case 'externalSandbox':
      return { fileSystem: { kind: 'external' }, network: policy.networkAccess === 'enabled' }
    case 'workspaceWrite':
      return {
        fileSystem: workspaceWrite(
          stringList(policy.writableRoots),
          policy.excludeTmpdirEnvVar === true,
          policy.excludeSlashTmp === true,
        ),
        network: policy.networkAccess === true,
      }
    default:
      return null
  }
}

// Every SandboxPolicy field this module reads, by variant. The schema check
// (scripts/check-posture-schema.mjs) fails when Codex adds one.
export const SANDBOX_POLICY_FIELDS: Record<string, readonly string[]> = {
  dangerFullAccess: ['type'],
  readOnly: ['type', 'networkAccess'],
  externalSandbox: ['type', 'networkAccess'],
  workspaceWrite: [
    'type',
    'writableRoots',
    'networkAccess',
    'excludeTmpdirEnvVar',
    'excludeSlashTmp',
  ],
}

// A sandbox value this module cannot read is taken as the tightest sandbox;
// the schema check keeps that path for app builds newer than the pin.
const UNKNOWN_SANDBOX: SandboxPart = { fileSystem: { kind: 'read-only' }, network: false }

const PROFILE_APPROVAL: Record<string, ApprovalPolicy> = {
  ':read-only': 'on-request',
  ':workspace': 'on-request',
  ':danger-full-access': 'never',
}

// A built-in permission profile's sandbox. A custom profile's contents are
// not visible to the adapter, so it gets the default sandbox, never a broader
// one (spec 5.6, fix 7).
function profileSandbox(id: string): SandboxPart {
  if (id === ':workspace') return { fileSystem: workspaceWrite([], false, false), network: false }
  if (id === ':danger-full-access') return { fileSystem: { kind: 'full-access' }, network: true }
  return UNKNOWN_SANDBOX
}

// Absent keeps what came before; present but unreadable asks before every
// command (`untrusted`), since no reading this build knows may be looser.
function approvalOf(value: unknown): ApprovalPolicy | null {
  return value == null ? null : (parseApprovalPolicy(value) ?? 'untrusted')
}

// thread/start and thread/resume send the SandboxMode string; turn/start and
// thread/settings/update send the SandboxPolicy struct; the real child's
// lifecycle answers carry the struct under `sandbox`. A named profile is one
// more reading. Codex refuses a message that names the sandbox twice; here the
// readings meet, so no one of them can loosen another.
function sandboxOf(params: Record<string, unknown>, profile: string | null): SandboxPart | null {
  const readings = [
    profile ? profileSandbox(profile) : null,
    params.sandboxPolicy == null
      ? null
      : (parseSandboxPolicy(params.sandboxPolicy) ?? UNKNOWN_SANDBOX),
    sandboxFieldOf(params.sandbox),
  ].filter((reading): reading is SandboxPart => reading !== null)
  return readings.length === 0 ? null : readings.reduce(tighterSandbox)
}

function sandboxFieldOf(sandbox: unknown): SandboxPart | null {
  if (sandbox == null) return null
  if (typeof sandbox !== 'string') return parseSandboxPolicy(sandbox) ?? UNKNOWN_SANDBOX
  const fileSystem = parseSandboxMode(sandbox)
  return fileSystem ? { fileSystem, network: fileSystem.kind === 'full-access' } : UNKNOWN_SANDBOX
}

// What two sandbox readings both allow.
function tighterSandbox(a: SandboxPart, b: SandboxPart): SandboxPart {
  return {
    fileSystem: tighterFileSystem(a.fileSystem, b.fileSystem),
    network: a.network && b.network,
  }
}

function tighterFileSystem(a: FileSystemPosture, b: FileSystemPosture): FileSystemPosture {
  if (a.kind === 'full-access') return b
  if (b.kind === 'full-access') return a
  if (a.kind === 'read-only' || b.kind === 'read-only') return { kind: 'read-only' }
  if (a.kind === 'external' && b.kind === 'external') return a
  // An external sandbox's posture reaches the cwd alone (`writableRoots`).
  const cwdOnly = workspaceWrite([], true, true)
  const x = a.kind === 'workspace-write' ? a : cwdOnly
  const y = b.kind === 'workspace-write' ? b : cwdOnly
  return workspaceWrite(
    x.writableRoots.filter((root) => y.writableRoots.includes(root)),
    x.excludeTmpdirEnvVar || y.excludeTmpdirEnvVar,
    x.excludeSlashTmp || y.excludeSlashTmp,
  )
}

// ModeKind is plan | default, but the app updates between CI's schema gate runs:
// a mode this build cannot read is plan, the tightest, said once per value.
const unreadModes = new Set<string>()
function planOf(params: Record<string, unknown>): boolean | null {
  if (params.collaborationMode == null) return null
  const mode = asRecord(params.collaborationMode).mode
  if (mode === 'plan' || mode === 'default') return mode === 'plan'
  const seen = JSON.stringify(mode ?? null)
  if (!unreadModes.has(seen)) {
    unreadModes.add(seen)
    debugLog('posture.unknownCollaborationMode', { mode: seen })
    process.stderr.write(`[anyengine] unknown collaboration mode ${seen}: read as plan\n`)
  }
  return true
}

// Applies the posture fields of a request (thread/start, thread/resume,
// thread/fork, thread/settings/update, turn/start) or of the real child's
// lifecycle answer onto `base`. What the message does not name keeps its
// base value, so a turn that says nothing inherits its thread's posture. A
// sandbox, profile, reviewer or approval this build cannot read takes the
// tight reading: read-only, the user, `untrusted` (which also marks the
// project untrusted, for good). An explicit approval, readable or not, beats
// the profile's default one.
export function applyCodexParams(base: Posture, params: Record<string, unknown>): Posture {
  base = durablePosture(base)
  const profile = profileIdOf(params)
  const sandbox = sandboxOf(params, profile)
  const named = approvalOf(params.approvalPolicy)
  const approval = named ?? (profile ? (PROFILE_APPROVAL[profile] ?? 'on-request') : null)
  const reviewer = params.approvalsReviewer
  return {
    ...base,
    ...(sandbox ?? {}),
    ...(base.readRestricted || hasReadRestriction(params) ? { readRestricted: true } : {}),
    approval: approval ?? base.approval,
    reviewer: reviewer == null ? base.reviewer : (parseReviewer(reviewer) ?? 'user'),
    plan: planOf(params) ?? base.plan,
    // Codex applies `untrusted` to projects it does not trust (spec 5.5 G8).
    trust: approval === 'untrusted' ? 'untrusted' : base.trust,
  }
}

// ---- stored and legacy forms --------------------------------------------------

// A posture as a ThreadRecord stores it: the canonical value, plus the two
// legacy strings older readers (and the app's profile badge) still use.
export function postureFields(posture: Posture): {
  approvalPolicy: string
  sandboxMode: string
  posture: Posture
} {
  posture = durablePosture(posture)
  return {
    approvalPolicy: typeof posture.approval === 'string' ? posture.approval : 'on-request',
    sandboxMode: sandboxModeOf(posture.fileSystem),
    posture,
  }
}

// Read field by field: anything missing or malformed makes the whole value
// junk (null), which a row reads as the default (src/store-rows.mts).
export function parseStoredPosture(text: string | null): Posture | null {
  let value: Record<string, unknown>
  try {
    value = asRecord(JSON.parse(text ?? ''))
  } catch {
    return null
  }
  const { network, plan, trust } = value
  const fileSystem = storedFileSystem(value.fileSystem)
  const approval = parseApprovalPolicy(value.approval)
  const reviewer = parseReviewer(value.reviewer)
  if (!fileSystem || !approval || !reviewer || !isTrust(trust)) return null
  if (typeof network !== 'boolean' || typeof plan !== 'boolean') return null
  const posture: Posture = {
    fileSystem,
    network,
    approval,
    reviewer,
    plan,
    trust,
    ...(value.readRestricted != null && value.readRestricted !== false
      ? { readRestricted: true }
      : {}),
  }
  // A baseline that is not all strings reads as none: every launch mismatches.
  const baseline = asRecord(value.projectBaseline)
  const digests = Object.values(baseline)
  if (digests.length === 0 || digests.some((d) => typeof d !== 'string')) return posture
  return { ...posture, projectBaseline: baseline as Record<string, string> }
}

function storedFileSystem(value: unknown): FileSystemPosture | null {
  const fs = asRecord(value)
  if (fs.kind === 'read-only' || fs.kind === 'full-access' || fs.kind === 'external') {
    return { kind: fs.kind }
  }
  const { writableRoots, excludeTmpdirEnvVar: tmp, excludeSlashTmp: slash } = fs
  if (fs.kind !== 'workspace-write' || !Array.isArray(writableRoots)) return null
  if (typeof tmp !== 'boolean' || typeof slash !== 'boolean') return null
  return workspaceWrite(stringList(writableRoots), tmp, slash)
}

function isTrust(value: unknown): value is Trust {
  return value === 'trusted' || value === 'untrusted' || value === 'unknown'
}

// ---- into Codex ---------------------------------------------------------------

function sandboxModeOf(fileSystem: FileSystemPosture): string {
  if (fileSystem.kind === 'read-only') return 'read-only'
  if (fileSystem.kind === 'full-access') return 'danger-full-access'
  return 'workspace-write'
}

// A Codex child has no thread-level plan switch, so a plan posture goes over
// as read-only with no escalation: approximate, and tighter.
function codexApproval(posture: Posture): ApprovalPolicy {
  return posture.plan ? 'never' : posture.approval
}

// SandboxPolicy for a thread (turn/start, thread envelopes): workspace-write's
// cwd is implicit, as in Codex.
export function toCodexSandboxPolicy(posture: Posture): Record<string, unknown> {
  const fs = posture.fileSystem
  if (posture.plan) return { type: 'readOnly', networkAccess: false }
  switch (fs.kind) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: posture.network }
    case 'full-access':
      return { type: 'dangerFullAccess' }
    case 'external':
      return { type: 'externalSandbox', networkAccess: posture.network ? 'enabled' : 'restricted' }
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        writableRoots: fs.writableRoots,
        networkAccess: posture.network,
        excludeTmpdirEnvVar: fs.excludeTmpdirEnvVar,
        excludeSlashTmp: fs.excludeSlashTmp,
      }
  }
}

// thread/start takes only the SandboxMode string; roots and network follow on
// the first turn (`toCodexTurn`).
export function toCodexThreadStart(posture: Posture): Record<string, unknown> {
  return {
    approvalPolicy: codexApproval(posture),
    approvalsReviewer: posture.reviewer,
    sandbox: posture.plan ? 'read-only' : sandboxModeOf(posture.fileSystem),
  }
}

export function toCodexTurn(posture: Posture): Record<string, unknown> {
  return {
    approvalPolicy: codexApproval(posture),
    approvalsReviewer: posture.reviewer,
    sandboxPolicy: toCodexSandboxPolicy(posture),
  }
}

// A turn/start for the Codex child with the posture fields it leaves out
// taken from the thread's row: thread/start and thread/resume carry only the
// mode string, so roots and network cross here. What the turn names wins; a
// profile names approval and sandbox, and Codex refuses a sandbox named twice.
export function turnWithPosture(
  params: Record<string, unknown>,
  row: ThreadRecord | null,
): Record<string, unknown> {
  if (!row) return params
  const codex = toCodexTurn(applyCodexParams(threadPosture(row), params))
  const named = params.permissions == null ? [] : ['approvalPolicy', 'sandboxPolicy']
  if (params.sandbox != null) named.push('sandboxPolicy')
  const gaps = Object.entries(codex).filter(([key]) => params[key] == null && !named.includes(key))
  return { ...params, ...Object.fromEntries(gaps) }
}

// command/exec runs outside any thread: the thread's cwd goes in as an
// explicit root, and an external sandbox (which the child cannot apply to one
// command) becomes workspace-write on that cwd alone, the only place its
// posture lets a write reach (`writableRoots`).
export function toCodexExecSandboxPolicy(posture: Posture, cwd: string): Record<string, unknown> {
  const fs = posture.fileSystem
  if (posture.plan || fs.kind === 'read-only' || fs.kind === 'full-access') {
    return toCodexSandboxPolicy(posture)
  }
  const ws = fs.kind === 'workspace-write' ? fs : workspaceWrite([], true, true)
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd, ...ws.writableRoots],
    networkAccess: posture.network,
    excludeTmpdirEnvVar: ws.excludeTmpdirEnvVar,
    excludeSlashTmp: ws.excludeSlashTmp,
  }
}

// ---- from Claude --------------------------------------------------------------

// A Claude parent's permission mode (the hook payload's `permission_mode`) as
// the posture for a Codex child (spec 5.4). acceptEdits and auto edit only the
// working directory: Claude asks for anything outside it, temp dirs included.
// `auto` pairs Claude's classifier with Codex's auto_review, which is
// approximate; `strict` maps it to manual approval instead (spec 5.6).
export function fromClaudePermissionMode(
  mode: string,
  options: { strict?: boolean } = {},
): Posture | null {
  const cwdOnly = workspaceWrite([], true, true)
  switch (mode) {
    case 'default':
    case 'manual':
      return DEFAULT_POSTURE
    case 'acceptEdits':
      return { ...DEFAULT_POSTURE, fileSystem: cwdOnly }
    case 'auto':
      return {
        ...DEFAULT_POSTURE,
        fileSystem: cwdOnly,
        reviewer: options.strict ? 'user' : 'auto_review',
      }
    case 'plan':
      return { ...DEFAULT_POSTURE, approval: 'never', plan: true }
    case 'dontAsk':
      return { ...DEFAULT_POSTURE, approval: 'never' }
    case 'bypassPermissions':
      return {
        ...DEFAULT_POSTURE,
        fileSystem: { kind: 'full-access' },
        network: true,
        approval: 'never',
      }
    default:
      return null
  }
}

// One predicate per schema enum scripts/check-posture-schema.mjs walks.
export const POSTURE_SCHEMA_COVERAGE = {
  approvalPolicy: (value: string) => parseApprovalPolicy(value) !== null,
  granularFlag: (flag: string) => (GRANULAR_FLAGS as readonly string[]).includes(flag),
  sandboxMode: (value: string) => parseSandboxMode(value) !== null,
  sandboxPolicyType: (type: string) => parseSandboxPolicy({ type }) !== null,
  sandboxPolicyField: (type: string, field: string) =>
    SANDBOX_POLICY_FIELDS[type]?.includes(field) === true,
  reviewer: (value: string) => parseReviewer(value) !== null,
  networkAccess: (value: string) => value === 'restricted' || value === 'enabled',
  modeKind: (value: string) => value === 'plan' || value === 'default',
  claudePermissionMode: (mode: string) => fromClaudePermissionMode(mode) !== null,
}

function workspaceWrite(
  writableRoots: string[],
  excludeTmpdirEnvVar: boolean,
  excludeSlashTmp: boolean,
): WorkspaceWrite {
  return { kind: 'workspace-write', writableRoots, excludeTmpdirEnvVar, excludeSlashTmp }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}
