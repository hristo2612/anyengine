// Only the trusted run owner creates process observations; child JSON cannot.
import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AnyEngineConfig, CodexClaudeMode } from './anyengine-config.mjs'
import { configAt } from './control-install-on.mjs'
import { jsonAt, object } from './control-layer-state.mjs'
import { adapterArguments, type ProcessInfo, type System } from './control-system.mjs'
import { type ProofKey, sameKey, settingsHash } from './degraded.mjs'
import type { NativeReceipt } from './smoke.mjs'
import { type OAuthObservation, sameOAuth } from './smoke-claude.mjs'

export type { NativeReceipt } from './smoke.mjs'
export interface FrozenIdentity {
  codeIdentity: string
  key: ProofKey
  mode: CodexClaudeMode
}
export interface GateRequest extends FrozenIdentity {
  attempt: string
  root: string
  since: string
  startedAt: string
  models: { claude: string; gpt: string | null }
  expect: 'router' | 'adapter'
  adapters: Array<{ pid: number; processStart: string }>
}
export type ProbeRole = 'adapter' | 'trampoline'
export interface ProbeInput {
  pid: number
  role: ProbeRole
  root: string
  mode: CodexClaudeMode
  id?: string
}
export interface ProbeIdentity extends ProbeInput {
  id: string
  ppid: number
  processStart: string
  command: string
  settings: string
}
export interface ProbeObservation extends ProbeIdentity {
  after: boolean
  closed: boolean
  family: ProcessInfo[]
}
export type ProbeObserver = (
  phase: 'before' | 'after' | 'closed',
  input: ProbeInput,
) => ProbeIdentity
export interface TerminalWork {
  threadId: string
  turnId: string
  model: string
  status: string
  success: boolean
}
export interface GateTurn {
  path: 'restricted-oauth' | 'claude-pty' | 'gpt' | 'bridge'
  probeId?: string
  role?: ProbeRole
  processPid?: number
  processStart: string
  threadId?: string
  turnId?: string
  model: string
  completedAt: string
  status: string
  success: boolean
  transport?: string
  restricted?: boolean
  allowlisted?: boolean
  operatorConfig?: boolean
  effectiveMode?: CodexClaudeMode
  effectiveSettings?: string
  sessionId?: string
  responseId?: string
  exitCode?: number
  oauth?: { before: OAuthObservation; after: OAuthObservation }
  parent?: TerminalWork
  child?: TerminalWork
  bridge?: {
    parentThreadId: string
    parentTurnId: string
    threadId: string
    turnId: string
    model: string
    success: boolean
    status: string
  }
}
export interface GateResult extends FrozenIdentity {
  attempt: string
  ok: boolean
  turns: GateTurn[]
  reason?: string
}
const observedMaps = new WeakSet<object>()
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value)
const sameProcess = (a: ProcessInfo, b: ProcessInfo) =>
  a.pid === b.pid &&
  a.ppid === b.ppid &&
  a.processStart === b.processStart &&
  a.command === b.command
function familyOf(procs: ProcessInfo[], owner: ProcessInfo): ProcessInfo[] {
  const family = [owner]
  for (let i = 0; i < family.length; i++) {
    for (const child of procs.filter((p) => p.ppid === family[i]?.pid))
      if (!family.some((p) => p.pid === child.pid)) family.push(child)
    if (family.length > 128) throw new Error('probe family exceeds bound')
  }
  return structuredClone(family)
}
function runConfig(
  input: ProbeInput,
  request: GateRequest,
  config: AnyEngineConfig,
  procs: ProcessInfo[],
): string {
  const run = dirname(input.root)
  if (
    dirname(run) !== join(request.root, 'smoke') ||
    !/^run-\d{8}T\d{6}Z$/.test(basename(run)) ||
    !/^(agent|native|model|restricted|direct)$/.test(basename(input.root))
  )
    throw new Error('probe root is not a run-owned directory')
  for (const dir of [run, input.root, join(input.root, 'lib')]) {
    const stat = lstatSync(dir)
    if (
      !stat.isDirectory() ||
      realpathSync(dir) !== dir ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('probe root directory identity invalid')
  }
  const owner = jsonAt(join(run, 'owner.json'))
  if (
    !object(owner) ||
    owner.attempt !== request.attempt ||
    owner.pid !== process.pid ||
    !procs.some((p) => p.pid === owner.pid && p.processStart === owner.processStart)
  )
    throw new Error('probe run owner identity mismatch')
  if (realpathSync(join(input.root, 'lib/current')) !== join(request.root, 'lib', request.key.lib!))
    throw new Error('probe current library identity drifted')
  jsonAt(join(input.root, 'config.json')) // Fatal bytes precede the tolerant config reader.
  const actual = configAt(input.root)
  const expected = structuredClone(config)
  expected.modes.codexClaude = input.mode
  if (basename(input.root) === 'native' && config.router.multiAgentV1)
    expected.router.enabled = true
  if (
    !['agent', request.mode].includes(input.mode) ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  )
    throw new Error('probe config/mode drifted')
  return settingsHash(actual)
}
function installedOwner(p: ProcessInfo, input: ProbeInput, request: GateRequest): void {
  const lib = join(request.root, 'lib', request.key.lib!)
  const helper = adapterArguments(
    p.command.replace(join(lib, 'dist/src/smoke-claude.mjs'), join(lib, 'dist/src/adapter.mjs')),
  )
  if (
    input.role === 'trampoline' &&
    p.ppid === process.pid &&
    p.command.includes(join(lib, 'dist/src/smoke-claude.mjs')) &&
    helper?.script === join(lib, 'dist/src/adapter.mjs') &&
    helper.args.length === 3 &&
    helper.args[0] === request.attempt &&
    helper.args[1] === input.root &&
    helper.args[2] === join(request.root, 'smoke/claude-project') &&
    Date.parse(p.processStart) >= Math.floor(Date.parse(request.startedAt) / 1000) * 1000
  )
    return
  const args = adapterArguments(p.command)
  if (!args || args.script !== join(lib, 'dist/src/adapter.mjs'))
    throw new Error('probe installed code identity mismatch')
  if (input.role === 'adapter') {
    if (
      p.ppid !== process.pid ||
      args.args[0] !== 'app-server' ||
      Date.parse(p.processStart) < Math.floor(Date.parse(request.startedAt) / 1000) * 1000
    )
      throw new Error('probe adapter parent/start identity mismatch')
  } else if (
    p.pid !== process.pid ||
    !['smoke', 'on', 'off', 'restart', 'codex', 'flip-run'].includes(args.args[0] ?? '')
  )
    throw new Error('probe trampoline owner identity mismatch')
}
function closeObservation(known: ProbeObservation, procs: ProcessInfo[]): ProbeIdentity {
  if (!known.after) throw new Error('probe has no after-work observation')
  const owned = known.family.filter((p) => known.role !== 'trampoline' || p.pid !== process.pid)
  if (
    owned.some((p) =>
      procs.some((live) => live.pid === p.pid && live.processStart === p.processStart),
    )
  )
    throw new Error('probe cleanup has a still-alive owned process')
  known.closed = true
  return structuredClone(known)
}
export function createProbeObserver(
  system: System,
  request: GateRequest,
  config: AnyEngineConfig,
  verify: () => FrozenIdentity,
): { observe: ProbeObserver; observations: ReadonlyMap<string, ProbeObservation> } {
  const frozen = structuredClone(request)
  const observations = new Map<string, ProbeObservation>()
  observedMaps.add(observations)
  const observe: ProbeObserver = (phase, input) => {
    const current = verify()
    if (
      !sameKey(current.key, frozen.key) ||
      current.codeIdentity !== frozen.codeIdentity ||
      current.mode !== frozen.mode
    )
      throw new Error('probe frozen code/key/mode drifted')
    const procs = system.processes()
    const known = input.id ? observations.get(input.id) : undefined
    if (phase !== 'before' && (!known || known.closed))
      throw new Error('unknown or closed probe observation')
    if (
      known &&
      (known.pid !== input.pid ||
        known.role !== input.role ||
        known.root !== input.root ||
        known.mode !== input.mode)
    )
      throw new Error('probe observation identity drifted')
    if (phase === 'closed') return closeObservation(known!, procs)
    const p = procs.find((p) => p.pid === input.pid)
    if (!p || !Number.isFinite(Date.parse(p.processStart)))
      throw new Error('probe process identity unavailable')
    installedOwner(p, input, frozen)
    const settings = runConfig(input, frozen, config, procs)
    if (known) {
      if (!sameProcess(known, p) || known.settings !== settings || known.after)
        throw new Error('probe process/config changed or observation repeated')
      known.after = true
      known.family = [
        ...known.family,
        ...familyOf(procs, p).filter(
          (child) => !known.family.some((old) => sameProcess(old, child)),
        ),
      ]
      return structuredClone(known)
    }
    if (
      phase !== 'before' ||
      input.id ||
      observations.size >= 16 ||
      [...observations.values()].some((old) => old.pid === input.pid && !old.closed)
    )
      throw new Error('invalid or repeated probe admission')
    const identity = {
      ...input,
      ...p,
      settings,
      id: randomUUID(),
      after: false,
      closed: false,
      family: familyOf(procs, p),
    }
    observations.set(identity.id, identity)
    return structuredClone(identity)
  }
  return { observe, observations }
}
function terminal(value: TerminalWork | undefined, model: string | null): value is TerminalWork {
  return (
    !!value &&
    nonempty(value.threadId) &&
    nonempty(value.turnId) &&
    nonempty(value.model) &&
    (!model || value.model === model) &&
    value.status === 'completed' &&
    value.success === true
  )
}
function validTurn(turn: GateTurn, request: GateRequest, observation: ProbeObservation): boolean {
  if (
    turn.processPid !== observation.pid ||
    turn.processStart !== observation.processStart ||
    turn.role !== observation.role ||
    !observation.after ||
    !observation.closed ||
    turn.status !== 'completed' ||
    turn.success !== true ||
    turn.effectiveMode !== observation.mode ||
    turn.effectiveSettings !== observation.settings ||
    !Number.isFinite(Date.parse(turn.completedAt)) ||
    Date.parse(turn.completedAt) < Date.parse(request.startedAt)
  )
    return false
  if (turn.path === 'restricted-oauth') {
    const oauth = turn.oauth
    return (
      turn.role === 'trampoline' &&
      turn.threadId === undefined &&
      turn.turnId === undefined &&
      turn.model === request.models.claude &&
      nonempty(turn.sessionId) &&
      nonempty(turn.responseId) &&
      turn.exitCode === 0 &&
      turn.restricted === true &&
      turn.allowlisted === true &&
      !!oauth &&
      sameOAuth(oauth.before, oauth.after) &&
      oauth.before.method === 'claude.ai' &&
      /^[a-f0-9]{64}$/.test(oauth.before.identity)
    )
  }
  if (turn.role !== 'adapter' || !nonempty(turn.threadId) || !nonempty(turn.turnId)) return false
  if (turn.path === 'gpt')
    return (
      turn.model.startsWith('gpt-') &&
      (!request.models.gpt || turn.model === request.models.gpt) &&
      turn.transport === request.expect
    )
  if (
    turn.model !== request.models.claude ||
    turn.effectiveMode !== 'agent' ||
    turn.operatorConfig !== true
  )
    return false
  if (turn.path === 'claude-pty') return true
  const { parent, child, bridge } = turn
  return (
    terminal(parent, request.models.claude) &&
    terminal(child, request.models.gpt) &&
    child.model.startsWith('gpt-') &&
    parent.threadId === turn.threadId &&
    parent.turnId === turn.turnId &&
    parent.threadId !== child.threadId &&
    !!bridge &&
    bridge.parentThreadId === parent.threadId &&
    bridge.parentTurnId === parent.turnId &&
    bridge.threadId === child.threadId &&
    bridge.turnId === child.turnId &&
    bridge.model === child.model &&
    bridge.status === 'completed' &&
    bridge.success === true &&
    !Object.hasOwn(turn, 'claimSuccess') &&
    !Object.hasOwn(turn, 'owner')
  )
}
export function gateResult(
  result: GateResult,
  request: GateRequest,
  now: Date,
  observations: ReadonlyMap<string, ProbeObservation>,
): string {
  if (!observedMaps.has(observations))
    throw new Error('mandatory gate has no independent observations')
  if (
    result?.ok !== true ||
    result.attempt !== request.attempt ||
    result.codeIdentity !== request.codeIdentity ||
    !sameKey(result.key, request.key) ||
    result.mode !== request.mode ||
    !Array.isArray(result.turns)
  )
    throw new Error(
      `mandatory gate failed or identity/attempt drifted${result?.reason ? `: ${result.reason}` : ''}`,
    )
  const required =
    request.expect === 'router'
      ? ['restricted-oauth', 'claude-pty', 'gpt', 'bridge']
      : ['restricted-oauth', 'claude-pty', 'gpt']
  if (result.turns.length !== required.length)
    throw new Error('mandatory gate missing or extra terminal work')
  const ids = new Set<string>()
  for (const path of required) {
    const turns = result.turns.filter((turn) => turn.path === path)
    const turn = turns[0]
    const observation = turn?.probeId ? observations.get(turn.probeId) : undefined
    if (
      turns.length !== 1 ||
      !turn ||
      !observation ||
      !validTurn(turn, request, observation) ||
      Date.parse(turn.completedAt) > now.getTime()
    )
      throw new Error(
        `mandatory ${path}: no independently observed correlated successful terminal work`,
      )
    const id =
      turn.path === 'restricted-oauth'
        ? `${turn.sessionId}:${turn.responseId}`
        : `${turn.threadId}:${turn.turnId}`
    if (ids.has(id)) throw new Error('duplicate terminal work')
    ids.add(id)
  }
  return 'mandatory installed restricted OAuth, real-config Claude PTY and GPT terminal work correlated to this attempt'
}
export function validateNativeReceipt(
  value: unknown,
  expected: FrozenIdentity,
  claude: string,
  gpt: string | null,
  now: Date,
): NativeReceipt {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.kind !== 'anyengine-native-fanout' ||
    !sameKey(value.key as ProofKey, expected.key) ||
    value.codeIdentity !== expected.codeIdentity ||
    value.mode !== expected.mode ||
    value.effectiveSettings !== expected.key.settings ||
    !nonempty(value.attempt) ||
    !expected.key.lib ||
    !/^\d+(?:\.\d+)+\S*$/.test(String(expected.key.appVersion)) ||
    !/^\d+\.\d+\.\d+\S*$/.test(String(expected.key.codexVersion)) ||
    !['owner', 'parent', 'child', 'spawn', 'completion', 'cleanup'].every((key) =>
      object(value[key]),
    )
  )
    throw new Error('unsupported native receipt or frozen identity mismatch')
  const receipt = value as unknown as NativeReceipt
  const { owner, parent, child, spawn, completion, claim, cleanup } = receipt
  const begin = Date.parse(receipt.startedAt)
  const end = Date.parse(receipt.completedAt)
  const timely = (time: unknown) =>
    typeof time === 'string' && Date.parse(time) >= begin && Date.parse(time) <= end
  if (
    !Number.isFinite(begin) ||
    !Number.isFinite(end) ||
    end < begin ||
    end > now.getTime() ||
    !terminal(parent, gpt) ||
    !parent.model.startsWith('gpt-') ||
    parent.pong !== true ||
    !terminal(child, claude) ||
    child.pong !== true ||
    parent.threadId === child.threadId ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1 ||
    !Number.isFinite(Date.parse(owner.processStart)) ||
    owner.mode !== expected.mode ||
    owner.settings !== expected.key.settings ||
    owner.after !== true ||
    owner.closed !== true ||
    !nonempty(owner.root) ||
    cleanup.threads !== true ||
    cleanup.sessions !== true ||
    cleanup.processes !== true ||
    !nonempty(spawn.id) ||
    spawn.tool !== 'spawnAgent' ||
    spawn.status !== 'completed' ||
    spawn.model !== claude ||
    spawn.senderThreadId !== parent.threadId ||
    !Array.isArray(spawn.receiverThreadIds) ||
    spawn.receiverThreadIds.length !== 1 ||
    spawn.receiverThreadIds[0] !== child.threadId
  )
    throw new Error('native receipt has no completed correlated parent/child or joined cleanup')
  if (
    completion.event !== (expected.mode === 'agent' ? 'claim.done' : 'trampoline.done') ||
    completion.threadId !== child.threadId ||
    completion.turnId !== child.turnId ||
    completion.model !== claude ||
    completion.parentThreadId !== parent.threadId ||
    completion.parentTurnId !== parent.turnId ||
    completion.owner !== join(owner.root, 'run', `claim-${owner.pid}.sock`) ||
    completion.success !== true ||
    !timely(completion.ts)
  )
    throw new Error('native terminal source/selected-owner correlation mismatch')
  if (expected.mode === 'agent') {
    if (
      !claim ||
      claim.event !== 'claim.done' ||
      claim.pid !== owner.pid ||
      !timely(claim.ts) ||
      ['threadId', 'turnId', 'model', 'parentThreadId', 'owner', 'success'].some(
        (key) => claim[key] !== completion[key],
      )
    )
      throw new Error('native receipt has no successful actual adapter claim')
  } else if (completion.code !== 0 || !nonempty(completion.sessionId) || claim !== undefined)
    throw new Error('native receipt has no successful actual trampoline exit')
  return receipt
}
export function receiptFields(event: Record<string, any>): Record<string, any> {
  const allowed =
    'event ts pid id tool status model senderThreadId receiverThreadIds threadId turnId parentThreadId parentTurnId owner success code sessionId'.split(
      ' ',
    )
  return Object.fromEntries(
    allowed.filter((key) => Object.hasOwn(event, key)).map((key) => [key, event[key]]),
  )
}
