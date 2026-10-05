// Installed smoke orchestration. Publication follows frozen admission and joined cleanup.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AnyEngineConfig,
  type CodexClaudeMode,
  enginePaths,
  writeJsonAtomic,
} from './anyengine-config.mjs'
import { digest, jsonAt, regularBytes, statAt, syncDirectory } from './control-layer-state.mjs'
import type { FlipDeps, PostflightSnapshot } from './control-postflight.mjs'
import type { System } from './control-system.mjs'
import {
  clearDegraded,
  inspectDegraded,
  inspectProof,
  markDegraded,
  markProven,
  sameKey,
  settingsHash,
} from './degraded.mjs'
import { createRouterLog, scrubForLog } from './router-log.mjs'
import { pruneOwnSessions, runRestrictedProbe } from './smoke-claude.mjs'
import {
  createProbeObserver,
  type FrozenIdentity,
  type GateRequest,
  type GateResult,
  type GateTurn,
  type ProbeObserver,
  type TerminalWork,
  validateNativeReceipt,
} from './smoke-evidence.mjs'
import { PATH_RUNNERS } from './smoke-paths.mjs'
import { createSmokeRun, type SmokeRun, sweepSmokeRuns } from './smoke-probes.mjs'

export type SmokePathName =
  | 'router'
  | 'gpt'
  | 'claude-agent'
  | 'native-fanout'
  | 'bridge'
  | 'claude-model'
  | 'claude-code-gpt'
export interface NativeReceipt extends FrozenIdentity {
  version: 1
  kind: 'anyengine-native-fanout'
  attempt: string
  startedAt: string
  completedAt: string
  effectiveSettings: string
  parent: TerminalWork & { pong: boolean }
  child: TerminalWork & { pong: boolean }
  owner: {
    pid: number
    processStart: string
    root: string
    mode: CodexClaudeMode
    settings: string
    after: boolean
    closed: boolean
  }
  spawn: Record<string, any>
  completion: Record<string, any>
  claim?: Record<string, any>
  cleanup: { threads: boolean; sessions: boolean; processes: boolean }
}
export interface PathResult {
  ok: boolean | null
  ms: number
  detail: string
  turn?: GateTurn
  native?: NativeReceipt
  routed?: { success: boolean; attached: boolean }
  direct?: { success: boolean; attached: boolean }
}
export interface SmokeResult extends FrozenIdentity {
  at: string
  attempt: string
  appVersion: string | null
  codexVersion: string | null
  lib: string | null
  models: { claude: string; gpt: string | null }
  paths: Partial<Record<SmokePathName, PathResult>>
  cleanup?: { sessionsRemoved: string[]; sessionsMissing: string[] }
  swept?: { removed: string[]; retained: string[] }
}
export interface SmokeDeps {
  adapter: string
  executingLib: string
  adapterEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  codexHome: string
  project: string
  runDir: string
  claudeHome: string
  verifyLib: FlipDeps['verifyLib']
  currentSnapshot: FlipDeps['currentSnapshot']
  runners?: Partial<Record<SmokePathName, (ctx: PathContext) => Promise<PathResult>>>
}
export interface PathContext {
  system: System
  root: string
  deps: SmokeDeps
  config: AnyEngineConfig
  snapshot: PostflightSnapshot
  request: GateRequest
  observe: ProbeObserver
  verify(): FrozenIdentity
  run: SmokeRun
  sessions: Set<string>
  cohort: Array<{ pid: number; processStart: string }>
  uncertain: boolean
  sequence: number
}
export const SMOKE_PATHS: SmokePathName[] = [
  'router',
  'gpt',
  'claude-agent',
  'native-fanout',
  'bridge',
  'claude-model',
  'claude-code-gpt',
]
export function realSmokeDeps(
  root: string,
  capabilities: Pick<FlipDeps, 'verifyLib' | 'currentSnapshot'>,
  lib?: string,
): SmokeDeps {
  const selected = lib ? join(root, 'lib', lib) : realpathSync(join(root, 'lib/current'))
  return {
    adapter: join(selected, 'dist/src/adapter.mjs'),
    executingLib: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    adapterEnv: (extra) => ({ ...process.env, ...extra }),
    codexHome: process.env.CODEX_HOME || join(process.env.HOME || '', '.codex'),
    claudeHome: process.env.HOME || '',
    project: join(root, 'smoke/claude-project'),
    runDir: join(
      root,
      'smoke',
      `run-${new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z')}`,
    ),
    ...capabilities,
  }
}
export function admission(
  root: string,
  deps: SmokeDeps,
  lib?: string,
): { snapshot: PostflightSnapshot; verify(): FrozenIdentity } {
  if (typeof deps.verifyLib !== 'function' || typeof deps.currentSnapshot !== 'function')
    throw new Error('trusted installed admission capabilities are required')
  const initial = structuredClone(deps.currentSnapshot())
  const selected = lib ? join(root, 'lib', lib) : initial.libDir
  if (
    !selected ||
    deps.executingLib !== selected ||
    deps.adapter !== join(selected, 'dist/src/adapter.mjs')
  )
    throw new Error('executing smoke code must be the selected installed library')
  if (
    initial.root !== root ||
    !initial.libDir ||
    !sameKey(initial.key, initial.key) ||
    !initial.key.lib ||
    !/^\d+(?:\.\d+)+\S*$/.test(String(initial.key.appVersion)) ||
    !/^\d+\.\d+\.\d+\S*$/.test(String(initial.key.codexVersion)) ||
    !/^[a-f0-9]{64}$/.test(initial.codeIdentity ?? '') ||
    !initial.bundled ||
    initial.mode !== initial.config.modes.codexClaude ||
    initial.key.settings !== settingsHash(initial.config)
  )
    throw new Error('frozen current identity/version/config unavailable')
  const checkLibrary = (path: string) => {
    const problems = deps.verifyLib(path)
    if (problems.length) throw new Error(`installed admission: ${problems.join('; ')}`)
  }
  checkLibrary(initial.libDir)
  if (selected !== initial.libDir) checkLibrary(selected)
  const codeIdentity = digest(regularBytes(join(selected, 'install-manifest.json'), 2_000_000))
  const frozen = {
    codeIdentity,
    key: { ...initial.key, lib: lib ?? initial.key.lib },
    mode: initial.mode,
  }
  const verify = () => {
    const current = deps.currentSnapshot()
    if (
      current.root !== initial.root ||
      current.libDir !== initial.libDir ||
      current.bundled !== initial.bundled ||
      current.mode !== initial.mode ||
      current.codeIdentity !== initial.codeIdentity ||
      !sameKey(current.key, initial.key) ||
      JSON.stringify(current.config) !== JSON.stringify(initial.config)
    )
      throw new Error('frozen installed code/key/mode/config drifted')
    checkLibrary(selected)
    if (selected !== initial.libDir) checkLibrary(initial.libDir!)
    if (digest(regularBytes(join(selected, 'install-manifest.json'), 2_000_000)) !== codeIdentity)
      throw new Error('selected manifest drifted')
    return structuredClone(frozen)
  }
  verify()
  return { snapshot: initial, verify }
}
export function judge(
  root: string,
  result: SmokeResult,
): { degraded: SmokePathName[]; cleared: SmokePathName[]; routerAtFault: boolean } {
  inspectProof(root)
  inspectDegraded(root)
  const native = result.paths['native-fanout']
  if (native?.ok === true)
    validateNativeReceipt(
      native.native,
      result,
      result.models.claude,
      result.models.gpt,
      new Date(),
    )
  const gpt = result.paths.gpt
  const routerAtFault =
    gpt?.ok === false &&
    gpt.routed?.attached === true &&
    gpt.routed.success === false &&
    gpt.direct?.attached === false &&
    gpt.direct.success === true
  const degraded: SmokePathName[] = []
  const cleared: SmokePathName[] = []
  for (const path of SMOKE_PATHS) {
    const entry = result.paths[path]
    if (!entry || entry.ok === null || (routerAtFault && (path === 'router' || path === 'gpt')))
      continue
    if (entry.ok) {
      if (path === 'native-fanout') markProven(root, path, entry.detail, result.key)
      clearDegraded(root, path)
      cleared.push(path)
    } else {
      markDegraded(root, path, entry.detail)
      degraded.push(path)
    }
  }
  if (routerAtFault) {
    markDegraded(root, 'router', gpt!.detail)
    clearDegraded(root, 'gpt')
    degraded.push('router')
    cleared.push('gpt')
  }
  return { degraded, cleared, routerAtFault }
}
async function runPath(path: SmokePathName, ctx: PathContext): Promise<PathResult> {
  if (path === 'claude-code-gpt' && !ctx.config.smoke.enabled)
    return { ok: null, ms: 0, detail: 'Claude Code GPT smoke disabled' }
  return (ctx.deps.runners?.[path] ?? PATH_RUNNERS[path])(ctx)
}

export async function runSmoke(
  system: System,
  root: string,
  deps: SmokeDeps,
  options: { paths: SmokePathName[]; notify: boolean; lib?: string; out?: string },
  gate?: {
    request: GateRequest
    observe: ProbeObserver
    restricted(ctx: PathContext): Promise<GateTurn>
  },
): Promise<SmokeResult & { restricted?: GateTurn }> {
  validateOptions(options)
  const { snapshot, verify } = admission(root, deps, options.lib)
  const frozen = verify()
  const config = snapshot.config
  if (!config.claude.models.some((model) => model.id === config.smoke.claudeModel))
    throw new Error('invalid smoke Claude model')
  const attempt = gate?.request.attempt ?? randomUUID()
  const at = system.now().toISOString()
  const request: GateRequest = gate?.request ?? {
    ...frozen,
    attempt,
    root,
    since: at,
    startedAt: at,
    models: { claude: config.smoke.claudeModel, gpt: config.smoke.gptModel },
    expect: config.router.enabled ? 'router' : 'adapter',
    adapters: [],
  }
  if (
    !sameKey(request.key, frozen.key) ||
    request.codeIdentity !== frozen.codeIdentity ||
    request.mode !== frozen.mode ||
    request.root !== root
  )
    throw new Error('mandatory requested frozen identity drifted')
  jsonAt(enginePaths(root).smokeResult)
  inspectProof(root)
  inspectDegraded(root)
  if (options.out && (resolve(options.out) !== options.out || statAt(options.out)))
    throw new Error('smoke output must be a fresh absolute path')
  if (deps.project !== join(root, 'smoke/claude-project'))
    throw new Error('smoke must use its fixed project')
  const swept = sweepSmokeRuns(system, root)
  const run = createSmokeRun(system, root, deps.runDir, attempt)
  mkdirSync(deps.project, { recursive: true, mode: 0o700 })
  if (realpathSync(deps.project) !== deps.project)
    throw new Error('smoke project must be canonical')
  const observer = gate?.observe ?? createProbeObserver(system, request, config, verify).observe
  const ctx: PathContext = {
    system,
    root,
    deps,
    config,
    snapshot,
    request,
    observe: observer,
    verify,
    run,
    sessions: new Set(),
    cohort: [],
    uncertain: false,
    sequence: 0,
  }
  const result: SmokeResult & { restricted?: GateTurn } = {
    ...frozen,
    at,
    attempt,
    appVersion: frozen.key.appVersion,
    codexVersion: frozen.key.codexVersion,
    lib: frozen.key.lib,
    models: request.models,
    paths: {},
    swept,
  }
  try {
    for (const path of SMOKE_PATHS.filter((path) => options.paths.includes(path))) {
      const started = Date.now()
      try {
        result.paths[path] = await runPath(path, ctx)
      } catch (error) {
        result.paths[path] = {
          ok: false,
          ms: Date.now() - started,
          detail: String(scrubForLog(String(error))),
        }
      }
    }
    if (gate) result.restricted = await gate.restricted(ctx)
  } finally {
    if (!ctx.uncertain) {
      const sessions = pruneOwnSessions(
        deps.claudeHome,
        deps.project,
        [...ctx.sessions],
        process.env.CLAUDE_CONFIG_DIR || join(deps.claudeHome, '.claude'),
      )
      result.cleanup = { sessionsRemoved: sessions.removed, sessionsMissing: sessions.missing }
      run.joined()
      run.remove()
    }
  }
  if (ctx.uncertain)
    throw new Error(
      `smoke family cleanup uncertain; retained ${deps.runDir}; ${Object.entries(result.paths)
        .filter(([, entry]) => entry.ok === false)
        .map(([path, entry]) => `${path}: ${entry.detail}`)
        .join('; ')}`,
    )
  verify()
  const native = result.paths['native-fanout']
  if (native?.ok === true) {
    native.native!.cleanup.sessions = true
    validateNativeReceipt(
      native.native,
      frozen,
      request.models.claude,
      request.models.gpt,
      system.now(),
    )
  }
  if (gate) return result
  if (options.out) publishFresh(options.out, result)
  else {
    const priorClaudeCodeFailure = inspectDegraded(root)?.paths['claude-code-gpt']
    judge(root, result)
    writeJsonAtomic(enginePaths(root).smokeResult, result)
    createRouterLog(join(root, 'logs/smoke.jsonl'), { maxBytes: 1_000_000, keep: 3 }).info(
      'smoke',
      { ...result },
    )
    const failed = Object.entries(result.paths)
      .filter(
        ([path, entry]) =>
          entry.ok === false && (path !== 'claude-code-gpt' || !priorClaudeCodeFailure),
      )
      .map(([path]) => path)
    if (options.notify && failed.length)
      system.notify(
        'AnyEngine smoke',
        `${failed.join(', ')} failed. Run anyengine status. GPT affected? anyengine off`,
      )
  }
  return result
}
export async function runMandatoryGate(
  system: System,
  root: string,
  deps: SmokeDeps,
  request: GateRequest,
  observe: ProbeObserver,
): Promise<GateResult> {
  const paths: SmokePathName[] =
    request.expect === 'router' ? ['gpt', 'claude-agent', 'bridge'] : ['gpt', 'claude-agent']
  const result = await runSmoke(
    system,
    root,
    deps,
    { paths, notify: false },
    { request, observe, restricted: runRestrictedProbe },
  )
  const turns = paths.flatMap((path) => result.paths[path]?.turn ?? [])
  if (result.restricted) turns.push(result.restricted)
  return {
    attempt: request.attempt,
    codeIdentity: result.codeIdentity,
    key: result.key,
    mode: result.mode,
    ok:
      paths.every((path) => result.paths[path]?.ok === true) && result.restricted?.success === true,
    ...(!paths.every((path) => result.paths[path]?.ok === true)
      ? {
          reason: paths
            .filter((path) => result.paths[path]?.ok !== true)
            .map((path) => `${path}: ${result.paths[path]?.detail ?? 'no result'}`)
            .join('; '),
        }
      : {}),
    turns,
  }
}

function publishFresh(path: string, value: SmokeResult): void {
  const tmp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    linkSync(tmp, path)
    syncDirectory(dirname(path))
  } finally {
    unlinkSync(tmp)
  }
}

function validateOptions(options: { paths: SmokePathName[]; lib?: string }): void {
  if (
    !options.paths.length ||
    new Set(options.paths).size !== options.paths.length ||
    options.paths.some((path) => !SMOKE_PATHS.includes(path))
  )
    throw new Error('invalid smoke paths')
  if (options.lib && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(options.lib))
    throw new Error('invalid smoke library')
}
