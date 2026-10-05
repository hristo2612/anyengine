// Read-only control observation. Present invalid evidence stays unknown, never
// an empty recovery baseline or permission to mutate. Native is router-observed;
// status does not probe an engine or certify an unobserved adapter child.
import { basename, join, resolve } from 'node:path'
import { managedCodexChild } from './accounts-child-ownership.mjs'
import { type CodexClaudeMode, readConfig, routerHealthUrl } from './anyengine-config.mjs'
import { resolveBundledCodex } from './bundled-codex.mjs'
import {
  type AccountStatus,
  formatAccountStatus,
  readAccountStatus,
} from './control-account-status.mjs'
import { type CacheReport, inspectModelsCache } from './control-cache.mjs'
import { lastEvent, tailJsonl } from './control-logs.mjs'
import { type FlipMarker, markerAlive, readFlipMarker } from './control-marker.mjs'
import {
  type ClaudeCodeStatus,
  readStatusClaudeCode,
  readStatusDegraded,
  readStatusHealth,
  readStatusKnownGood,
  readStatusLayers,
  readStatusLib,
  readStatusProof,
  readStatusRecovery,
  readStatusRouter,
  readStatusSmoke,
} from './control-status-evidence.mjs'
import {
  adapterArguments,
  adapterProcesses,
  processOwnership,
  type System,
} from './control-system.mjs'
import { type DegradedFile, type ProofKey, sameKey, settingsHash } from './degraded.mjs'
import type { RouterStatusFile } from './router-fanout.mjs'
import {
  type Compatibility,
  readCompatibility,
  readFallback,
  readStartupFailure,
  readUpdateState,
  type UpdateState,
} from './startup-compat.mjs'
import { type KnownGood, readKnownGood } from './update-watch.mjs'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const validKey = (value: unknown): value is ProofKey =>
  sameKey(value as ProofKey, value as ProofKey)

export interface StatusReport {
  accounts?: AccountStatus | null
  claudeCode: ClaudeCodeStatus
  lib: { current: string | null }
  layers: string[] | null
  app: {
    path: string
    version: string | null
    codex: string | null
    knownGood: string | null
    running: 'running' | 'down' | 'unknown'
  }
  update: {
    compatibility: Compatibility | null
    knownGood: KnownGood | null
    attempts: UpdateState | null
    failure: Record<string, unknown> | null
    fallback: Record<string, unknown> | null
  }
  adapters: Array<{
    pid: number
    version: string | null
    link: Record<string, unknown> | null
    codexChild: 'running' | 'unavailable' | 'unknown'
  }>
  otherAdapters: Array<{ pid: number; version: string | null }>
  processesKnown: boolean
  router: {
    job: 'loaded' | 'not loaded' | 'unknown'
    health: Record<string, unknown> | null
    lastStatus: RouterStatusFile | null
    fanout: 'native' | 'bridge' | 'unknown'
    reason: string
  }
  mode: CodexClaudeMode
  modeNote: string | null
  degraded: DegradedFile | null
  smoke: Record<string, unknown> | null
  cache: CacheReport
  flip: (FlipMarker & { alive: boolean | null }) | null
  recovery: { path: string; command: string } | null
  configErrors: string[]
  inspectionErrors: string[]
}
export async function gatherStatus(
  system: System,
  root: string,
  options: { codexHome?: string } = {},
): Promise<StatusReport> {
  const inspectionErrors: string[] = []
  const inspect = <T,>(label: string, read: () => T, fallback: T): T => {
    try {
      return read()
    } catch (error) {
      inspectionErrors.push(`${label}: ${errorText(error)}`)
      return fallback
    }
  }
  const { config, errors: configErrors } = readConfig(root)
  const current = inspect('lib/current', () => readStatusLib(root), null)
  const layers = inspect('layers.json', () => readStatusLayers(root), null)
  const knownGood = inspect('known-good.json', () => readStatusKnownGood(root), null)
  const update = {
    compatibility: inspect('startup-compat.json', () => readCompatibility(root), null),
    knownGood: inspect('known-good.json schema evidence', () => readKnownGood(root), null),
    attempts: inspect('update-watch.json', () => readUpdateState(root), null),
    failure: inspect('startup-failure.json', () => readStartupFailure(root), null),
    fallback: inspect('shim-fallback.json', () => readFallback(root), null),
  }
  const smoke = inspect('smoke.json', () => readStatusSmoke(root), null)
  const proof = inspect('proven.json', () => readStatusProof(root), null)
  const degraded = inspect('degraded.json', () => readStatusDegraded(root), null)
  const lastStatus = inspect('router-status.json', () => readStatusRouter(root), null)
  const recovery = inspect('RECOVER.txt', () => readStatusRecovery(root), null)
  const marker = inspect('flip.json', () => readFlipMarker(root), null)
  const alive = marker
    ? inspect<boolean | null>('flip liveness', () => markerAlive(marker, system), null)
    : null
  const job = inspect(
    'router job',
    () => {
      const result = system.launchctl([
        'print',
        `gui/${process.getuid?.() ?? 0}/dev.anyengine.router`,
      ])
      if (result.status === 0) return 'loaded' as const
      if (result.status === 113 && !result.stdout && !result.stderr) return 'not loaded' as const
      if (result.status === 113 && /Could not find service/.test(result.stderr))
        return 'not loaded' as const
      throw new Error(
        `launchctl inspection failed (${result.status ?? 'unknown'}): ${result.stderr}`,
      )
    },
    'unknown' as const,
  )
  let health: Record<string, unknown> | null = null
  if (config.router.enabled && configErrors.length === 0 && job === 'loaded') {
    try {
      health = await readStatusHealth(routerHealthUrl(config))
    } catch (error) {
      inspectionErrors.push(`router health: ${errorText(error)}`)
    }
  }
  // Keep the process/event cohort on the same side of asynchronous health I/O.
  const processes = inspect('processes', () => system.processes(), null)
  const appVersion = inspect('app version', () => system.appVersion(), null)
  if (appVersion === null) inspectionErrors.push('app version: unavailable')
  const running = inspect(
    'app running',
    () => (system.appRunning() ? ('running' as const) : ('down' as const)),
    'unknown' as const,
  )
  const codexDir = resolve(
    options.codexHome || process.env.CODEX_HOME || join(system.home, '.codex'),
  )
  const log =
    process.env.ANYENGINE_DEBUG_LOG ||
    join(process.env.ANYENGINE_HOME || join(codexDir, 'anyengine'), 'debug.jsonl')
  const events = inspect('adapter log', () => tailJsonl(log), [])
  const ownership = processes
    ? inspect('processes ownership', () => processOwnership(system, processes), null)
    : null
  const found = processes ? adapterProcesses({ ...system, processes: () => processes }) : []
  const otherAdapters = found
    .filter((adapter) => ownership?.get(adapter.pid) === 'other')
    .map(({ pid, version }) => ({ pid, version }))
  const unknown = found.filter(
    (adapter) => ownership?.get(adapter.pid) !== 'app' && ownership?.get(adapter.pid) !== 'other',
  )
  if (unknown.length)
    inspectionErrors.push(
      `processes ownership: unknown adapter ancestry: ${unknown.map((adapter) => adapter.pid).join(', ')}`,
    )
  const adapters = processes
    ? found
        .filter((adapter) => ownership?.get(adapter.pid) !== 'other')
        .map((adapter) => {
          const children = processes.filter(
            (child) =>
              managedCodexChild(child, adapter, processes) && ownership?.get(child.pid) === 'app',
          )
          const related = events.filter(
            (event) =>
              typeof event.ts === 'string' &&
              Date.parse(event.ts) >=
                Date.parse(
                  processes.find((process) => process.pid === adapter.pid)?.processStart ?? '',
                ) &&
              (event.pid === adapter.pid || children.some((child) => child.pid === event.pid)),
          )
          const upstream = lastEvent(
            related,
            /^codex\.upstream\.(spawn|spawnError|unavailable|missing|exit)$/,
          )
          const child = children.find(
            (child) =>
              child.pid === upstream?.pid &&
              upstream?.event === 'codex.upstream.spawn' &&
              typeof upstream.binary === 'string' &&
              child.command.startsWith(`${upstream.binary} `) &&
              Date.parse(String(upstream.ts)) >= Date.parse(child.processStart),
          )
          const codexChild = child
            ? ('running' as const)
            : /spawnError|unavailable|missing|exit/.test(String(upstream?.event))
              ? ('unavailable' as const)
              : ('unknown' as const)
          return {
            pid: adapter.pid,
            version: adapter.version,
            link: lastEvent(events, /^router\.link$/, adapter.pid),
            codexChild,
          }
        })
    : []
  const codex = resolveBundledCodex({ ...process.env, ANYENGINE_CHATGPT_APP: system.app }).path
  const fanout = observeFanout(
    health,
    current,
    appVersion,
    config,
    proof,
    degraded,
    processes,
    inspectionErrors,
    configErrors,
  )
  if (!codex && fanout.path === 'native') {
    fanout.path = 'unknown'
    fanout.reason = 'selected codex path unavailable; router-observed version is insufficient'
  }
  const cache = inspectModelsCache(codexDir, new Set(config.claude.models.map((model) => model.id)))
  if (cache.parseError) inspectionErrors.push(`models_cache.json: ${cache.parseError}`)
  if (inspectionErrors.length || configErrors.length) {
    fanout.path = 'unknown'
    fanout.reason = 'inspection or configuration errors; see diagnostics'
  }
  return {
    accounts: inspect('accounts', () => readAccountStatus(root, codexDir, system), null),
    claudeCode: readStatusClaudeCode({
      root,
      home: system.home,
      layers,
      current,
      port: config.router.port,
      health,
    }),
    lib: { current },
    layers,
    app: {
      path: system.app,
      version: appVersion,
      codex,
      knownGood,
      running,
    },
    update,
    adapters,
    otherAdapters,
    processesKnown: processes !== null,
    router: { job, health, lastStatus, fanout: fanout.path, reason: fanout.reason },
    mode: config.modes.codexClaude,
    modeNote:
      config.modes.codexClaude === 'model' && fanout.path === 'bridge'
        ? 'model mode is inactive: the fan-out path is bridge, Claude runs in agent mode'
        : null,
    degraded,
    smoke,
    cache,
    flip: marker ? { ...marker, alive } : null,
    recovery,
    configErrors,
    inspectionErrors,
  }
}
function observeFanout(
  health: Record<string, unknown> | null,
  current: string | null,
  appVersion: string | null,
  config: ReturnType<typeof readConfig>['config'],
  proof: Record<string, unknown> | null,
  degraded: DegradedFile | null,
  processes: ReturnType<System['processes']> | null,
  errors: string[],
  configErrors: string[],
): { path: 'native' | 'bridge' | 'unknown'; reason: string } {
  if (!health || errors.length || configErrors.length)
    return { path: 'unknown', reason: 'current router path unavailable' }
  const state = health.fanout as { path: 'native' | 'bridge'; reason: string }
  if (state.path === 'bridge') return state
  const key = health.proofKey
  const entries = proof?.paths as Record<string, { key: ProofKey }> | undefined
  const running = processes?.some((process) => {
    const invocation = adapterArguments(process.command)
    return (
      process.pid === health.pid &&
      Date.parse(String(health.startedAt)) >= Date.parse(process.processStart) &&
      invocation?.args[0] === 'router' &&
      invocation.script.endsWith(`/lib/${String(health.version)}/dist/src/adapter.mjs`)
    )
  })
  if (
    !config.router.multiAgentV1 ||
    !validKey(key) ||
    !entries?.['native-fanout'] ||
    !degraded ||
    degraded.paths['native-fanout'] ||
    !running ||
    !current ||
    current !== health.version ||
    key.lib !== current ||
    key.appVersion !== appVersion ||
    key.settings !== settingsHash(config) ||
    !sameKey(entries['native-fanout'].key, key)
  )
    return {
      path: 'unknown',
      reason:
        'router reports native, but current running lib, versions, settings and proof do not match',
    }
  return {
    path: 'native',
    reason: 'router-observed versions and running/current lib match the native proof',
  }
}
export function formatStatus(report: StatusReport): string {
  const show = (value: unknown) => value ?? 'unknown'
  const line = (area: string, value: string) => `${area.padEnd(12)}${value}\n`
  let out = line(
    'anyengine',
    `lib/current ${show(report.lib.current)}, layers: ${report.layers === null ? 'unknown' : report.layers.join(', ') || 'none'}`,
  )
  out += formatAccountStatus(report.accounts)
  const recoveryError = report.inspectionErrors.some((error) => /flip|layers|RECOVER/.test(error))
  const flip = report.flip
  out += line(
    'flip',
    flip
      ? `${flip.op} ${flip.alive === true ? `in progress (phase ${flip.phase}), pid ${flip.pid}` : flip.alive === false ? `interrupted at ${flip.phase}` : `liveness unknown (phase ${flip.phase})`}, log ${flip.log}; ${report.recovery ? `recovery: ${report.recovery.path}` : 'stable recovery entry unavailable; preserve marker and backups'}`
      : recoveryError
        ? 'unknown; preserve recovery evidence'
        : 'none',
  )
  if (report.recovery)
    out += line('recovery', `${report.recovery.path}: ${report.recovery.command}`)
  out += line(
    'app',
    `${basename(report.app.path)} ${show(report.app.version)} (${report.app.running}), codex ${show(report.app.codex)}, last known-good ${show(report.app.knownGood)}`,
  )
  out += formatUpdate(report.update)
  if (!report.processesKnown) out += line('adapter', 'unknown (process inspection failed)')
  else if (!report.adapters.length) out += line('adapter', 'none observed')
  for (const adapter of report.adapters)
    out += line(
      'adapter',
      `pid ${adapter.pid} running lib ${show(adapter.version)}, codex child ${adapter.codexChild}, last router link ${adapter.link ? JSON.stringify(adapter.link) : 'not observed'}`,
    )
  out += report.otherAdapters
    .map((adapter) =>
      line(
        'other adapter',
        `pid ${adapter.pid} running lib ${show(adapter.version)}; independent client`,
      ),
    )
    .join('')
  const healthy =
    report.router.health &&
    !report.inspectionErrors.length &&
    !report.configErrors.length &&
    report.router.fanout !== 'unknown'
  out += line(
    'router',
    `dev.anyengine.router ${report.router.job}, ${healthy ? 'healthy observation' : 'health unknown'}, running lib ${show(report.router.health?.version)}`,
  )
  if (report.router.lastStatus)
    out += line(
      'router last',
      `${report.router.lastStatus.writtenAt}: lib ${report.router.lastStatus.version}, ${report.router.lastStatus.fanout.path} (${report.router.lastStatus.fanout.reason})`,
    )
  out += line(
    'mode',
    `codex-claude: ${report.mode} (saved settings)${report.modeNote ? `; ${report.modeNote}` : ''}`,
  )
  out += line('fan-out', `${report.router.fanout} (${report.router.reason})`)
  out += line('Claude GPT', formatClaudeCode(report.claudeCode))
  out += line(
    'smoke',
    report.smoke
      ? `${report.smoke.at}: ${JSON.stringify(report.smoke.paths)} (last result)`
      : 'not observed',
  )
  out += line(
    'degraded',
    report.degraded === null
      ? 'unknown'
      : Object.entries(report.degraded.paths)
          .map(([path, entry]) => `${path}: ${entry?.reason}`)
          .join('; ') || 'none recorded',
  )
  out += line(
    'cache',
    `${report.cache.path}: ${report.cache.parseError ? `unknown (${report.cache.parseError})` : report.cache.exists ? `client ${show(report.cache.clientVersion)}, ${report.cache.models} models, ${report.cache.anyengine.length} AnyEngine entries` : 'absent'}`,
  )
  for (const error of [...report.configErrors, ...report.inspectionErrors])
    out += line('error', error)
  return out.replaceAll(`${resolve(process.env.HOME || '')}/`, '~/')
}

function formatClaudeCode(state: ClaudeCodeStatus): string {
  const settings =
    state.settingsInstalled === null ? 'unknown' : state.settingsInstalled ? 'active' : 'inactive'
  return `${state.health}; settings ${settings}; broker ${state.broker?.source ?? 'unknown'} generation ${state.broker?.generation ?? 'unknown'}; translation ${state.translationVersion ?? 'unknown'}; ${state.models.length} model suggestions`
}

function formatUpdate(update: StatusReport['update']): string {
  const line = (area: string, value: string) => `${area.padEnd(12)}${value}\n`
  let out = ''
  out += line(
    'startup',
    update.failure
      ? `vendor fallback: ${String(update.failure.reason)}`
      : update.compatibility
        ? `last fixture pass ${update.compatibility.checkedAt}, schema ${update.compatibility.schemaHash}; every new start rechecks`
        : 'compatibility not observed',
  )
  out += line(
    'update',
    update.attempts?.block
      ? `FAILED: ${update.attempts.block.reason}; retry: anyengine smoke --force`
      : update.knownGood
        ? `last full verification ${update.knownGood.verifiedAt}, schema ${update.knownGood.schemaHash}`
        : 'full schema/library verification not observed',
  )
  if (update.fallback)
    out += line('last fallback', `${String(update.fallback.ts)}: ${String(update.fallback.reason)}`)
  if (update.attempts?.attempt)
    out += line(
      'update retry',
      `attempt ${update.attempts.attempt.count}, ${update.attempts.attempt.owner ? 'verifier owned/pending' : `next ${update.attempts.attempt.nextAt}`}`,
    )
  return out
}
