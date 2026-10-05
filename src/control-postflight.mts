import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { managedCodexChild } from './accounts-child-ownership.mjs'
import type { AnyEngineConfig, CodexClaudeMode } from './anyengine-config.mjs'
import { jobLoaded, ROUTER_LABEL } from './control-launchd.mjs'
import { statAt } from './control-layer-state.mjs'
import { lastEvent } from './control-logs.mjs'
import {
  checked,
  classifyCodexProcesses,
  gateResult,
  hasForeignShimEvent,
  healthy,
  message,
  validateSnapshot,
} from './control-postflight-evidence.mjs'
import {
  adapterArguments,
  adapterProcesses,
  independentAdapterFamily,
  type ProcessInfo,
  processOwnership,
  type System,
} from './control-system.mjs'
import { type ProofKey, sameKey } from './degraded.mjs'
import { appOpenaiBaseUrl } from './router-link.mjs'
import {
  createProbeObserver,
  type FrozenIdentity,
  type GateRequest,
  type GateResult,
  type ProbeObserver,
} from './smoke-evidence.mjs'

export { realFlipDeps } from './control-postflight-evidence.mjs'
export type {
  FrozenIdentity,
  GateRequest,
  GateResult,
  GateTurn,
  ProbeObserver,
} from './smoke-evidence.mjs'
export { classifyCodexProcesses }
export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}
export type Expect = 'router' | 'adapter' | 'vanilla'
export interface CodexProcess {
  kind: 'app' | 'ssh-remote' | 'other'
  path: string
  command: string
}
export interface PostflightSnapshot {
  root: string
  libDir: string | null
  bundled: string | null
  codeIdentity: string | null
  key: ProofKey
  mode: CodexClaudeMode
  config: AnyEngineConfig
  nativeProof: ProofKey | null
  degraded: string[]
}
export interface FlipDeps {
  preflip(quietSeconds: number): { quiet: boolean; staged: boolean; text: string }
  verifyLib(libDir: string): string[]
  doctor(): Promise<{ ok: boolean; text: string }>
  smoke: ((paths: string[]) => Promise<{ ok: boolean; text: string }>) | null
  mandatoryGate: ((request: GateRequest, observe: ProbeObserver) => Promise<GateResult>) | null
  currentSnapshot(): PostflightSnapshot
  routerHealth(timeoutMs: number): Promise<Record<string, unknown> | null>
  claimPing(pid: number): Promise<boolean>
  bundledCodex(): string | null
  appLog(since: Date): string[]
  debugEvents(since: Date): Array<Record<string, unknown>>
}
export interface PostflightInput {
  expect: Expect
  since: Date
  appVersionBefore: string
  versionChangeExpected: boolean
  libVersion: string | null
  routerUrl: string | null
  baselineOther: string[]
  frozen?: FrozenIdentity
}
interface Observed {
  snapshot: PostflightSnapshot | null
  snapshotError: string | null
  procs: ProcessInfo[]
  processError: string | null
  events: Array<Record<string, unknown>>
  logs: string[]
  logError: string | null
  adapters: ProcessInfo[]
  appProcs: ProcessInfo[]
  otherFamily: Set<number>
  ownership: ReturnType<typeof processOwnership>
  bundled: string | null
}
function observe(system: System, deps: FlipDeps, input: PostflightInput): Observed {
  const out: Observed = {
    snapshot: null,
    snapshotError: null,
    procs: [],
    processError: null,
    events: [],
    logs: [],
    logError: null,
    adapters: [],
    appProcs: [],
    otherFamily: new Set(),
    ownership: new Map(),
    bundled: null,
  }
  try {
    out.snapshot = structuredClone(deps.currentSnapshot())
  } catch (error) {
    out.snapshotError = message(error)
  }
  try {
    out.procs = system.processes()
    const ownership = processOwnership(system, out.procs)
    out.ownership = ownership
    const found = adapterProcesses({ ...system, processes: () => out.procs })
    const unknown = found.filter((adapter) => ownership.get(adapter.pid) === 'unknown')
    if (unknown.length)
      throw new Error(`unknown adapter ownership: ${unknown.map((p) => p.pid).join(', ')}`)
    out.appProcs = out.procs.filter((p) => ownership.get(p.pid) === 'app')
    out.adapters = out.appProcs.filter((process) =>
      found.some((adapter) => adapter.pid === process.pid),
    )
    out.otherFamily = independentAdapterFamily(
      out.procs,
      found.filter((adapter) => ownership.get(adapter.pid) === 'other').map((p) => p.pid),
      ownership,
    )
  } catch (error) {
    out.processError = message(error)
  }
  try {
    out.bundled = deps.bundledCodex()
    out.logs = deps
      .appLog(input.since)
      .filter((line) => Date.parse(line.split(/\s/, 1)[0] ?? '') >= input.since.getTime())
    out.events = deps
      .debugEvents(input.since)
      .filter((event) => Date.parse(String(event.ts)) >= input.since.getTime())
  } catch (error) {
    out.logError = message(error)
  }
  return out
}
function requireValue<T>(value: T | null | undefined, text: string): T {
  if (value === null || value === undefined) throw new Error(text)
  return value
}
function noError(error: string | null): void {
  if (error) throw new Error(error)
}
function currentAdapters(o: Observed, input: PostflightInput): ProcessInfo[] {
  noError(o.processError)
  return o.adapters.filter(
    (p) => Date.parse(p.processStart) >= Math.floor(input.since.getTime() / 1000) * 1000,
  )
}
function checkIdentity(o: Observed, deps: FlipDeps, input: PostflightInput): PostflightSnapshot {
  noError(o.snapshotError)
  const snapshot = requireValue(o.snapshot, 'current snapshot unavailable')
  validateSnapshot(snapshot)
  const frozen = requireValue(input.frozen, 'expected identity not frozen before restart')
  if (
    !sameKey(frozen.key, frozen.key) ||
    !/^[a-f0-9]{64}$/.test(frozen.codeIdentity) ||
    frozen.mode !== snapshot.mode ||
    frozen.codeIdentity !== snapshot.codeIdentity ||
    frozen.key.lib !== input.libVersion ||
    snapshot.key.lib !== input.libVersion ||
    frozen.key.settings !== snapshot.key.settings
  )
    throw new Error('installed code/lib/current, mode or frozen settings drifted')
  if (!input.versionChangeExpected && !sameKey(frozen.key, snapshot.key))
    throw new Error('app or bundled Codex version drifted')
  if (snapshot.bundled !== o.bundled)
    throw new Error('selected bundled Codex changed while inspected')
  const problems = deps.verifyLib(requireValue(snapshot.libDir, 'installed library missing'))
  if (problems.length) throw new Error(problems.join('; '))
  return snapshot
}
function appVersion(system: System, input: PostflightInput): string {
  const version = system.appVersion()
  if (!version || !/^\d+(?:\.\d+)+\S*$/.test(version))
    throw new Error('configured app version unknown')
  if (!system.appRunning()) throw new Error('configured app is not running after relaunch')
  if (version === input.appVersionBefore) return `configured app ${version}`
  if (!input.versionChangeExpected) throw new Error(`the app came back as ${version}`)
  return `came back as ${version}, expected on the way back; re-verified by the checks below`
}
function handshake(o: Observed, input: PostflightInput, home: string): string {
  noError(o.logError)
  noError(o.processError)
  const bundled = requireValue(o.bundled, 'bundled Codex unavailable after relaunch')
  const paths = input.expect === 'vanilla' ? [bundled] : ['~/bin/codex', join(home, 'bin/codex')]
  const started = o.logs.findIndex(
    (line) =>
      line.includes('stdio_transport_spawned') &&
      paths.some((path) => line.includes(`executablePath=${path} `)) &&
      (input.expect === 'vanilla'
        ? o.appProcs.some(
            (p) => p.command.startsWith(bundled) && new RegExp(`pid=${p.pid}(?:\\s|$)`).test(line),
          )
        : currentAdapters(o, input).some((p) => new RegExp(`pid=${p.pid}(?:\\s|$)`).test(line))),
  )
  if (
    started < 0 ||
    !o.logs
      .slice(started)
      .some(
        (line) =>
          /initialize_handshake_result.*outcome=success(?:\s|$)/.test(line) &&
          /transportKind=stdio(?:\s|$)/.test(line),
      )
  )
    throw new Error('no current spawned transport followed by a successful handshake')
  return `current ${input.expect === 'vanilla' ? bundled : '~/bin/codex'} transport and successful initialize handshake`
}
function adapterCheck(o: Observed, deps: FlipDeps, input: PostflightInput): string {
  noError(o.processError)
  if (input.expect === 'vanilla') {
    if (o.adapters.length) throw new Error(`${o.adapters.length} adapter processes remain`)
    return 'no adapter process observed'
  }
  const snapshot = checkIdentity(o, deps, input)
  const adapters = currentAdapters(o, input)
  if (
    !adapters.length ||
    adapters.some(
      (p) =>
        adapterArguments(p.command)?.script !== join(snapshot.libDir ?? '', 'dist/src/adapter.mjs'),
    )
  )
    throw new Error('restarted adapter absent or running another library')
  if (statAt(join(snapshot.root, 'shim-fallback.json')))
    throw new Error('shim-fallback.json present')
  return `${adapters.map((p) => `${p.pid}@${p.processStart}`).join(', ')} runs verified ${snapshot.key.lib}`
}
function upstream(o: Observed, input: PostflightInput): Array<Record<string, unknown>> {
  noError(o.logError)
  noError(o.processError)
  return o.events.filter(
    (event) =>
      /^codex\.upstream\.(spawn|spawnError|unavailable|staleRealCodex|missing)$/.test(
        String(event.event),
      ) &&
      currentAdapters(o, input).some(
        (p) =>
          Date.parse(String(event.ts)) >= Date.parse(p.processStart) &&
          (event.event !== 'codex.upstream.spawn'
            ? event.pid === p.pid
            : o.procs.some(
                (child) =>
                  child.pid === event.pid &&
                  managedCodexChild(child, p, o.procs) &&
                  Date.parse(child.processStart) >= Date.parse(p.processStart) &&
                  Date.parse(String(event.ts)) >= Date.parse(child.processStart),
              )),
      ),
  )
}
function child(o: Observed, input: PostflightInput): string {
  noError(o.processError)
  noError(o.logError)
  if (input.expect === 'vanilla') {
    if (
      !o.bundled ||
      !o.appProcs.some(
        (p) =>
          p.command.startsWith(`${o.bundled} `) &&
          Date.parse(p.processStart) >= input.since.getTime(),
      )
    )
      throw new Error('fresh bundled app-server process unavailable')
    return `current vanilla child ${o.bundled}`
  }
  const events = upstream(o, input)
  if (
    !events.length ||
    events.some((e) => e.event !== 'codex.upstream.spawn' || e.binary !== o.bundled)
  )
    throw new Error('GPT child has missing/error/stale/non-bundled current spawn evidence')
  for (const adapter of currentAdapters(o, input)) {
    if (
      !o.procs.some(
        (p) =>
          managedCodexChild(p, adapter, o.procs) &&
          p.command.startsWith(`${o.bundled} `) &&
          Date.parse(p.processStart) >= Date.parse(adapter.processStart) &&
          events.some((e) => e.event === 'codex.upstream.spawn' && e.pid === p.pid),
      )
    )
      throw new Error(`no live bundled child of adapter ${adapter.pid}`)
  }
  return `current bundled child ${o.bundled}; actual successful work still requires mandatory gate`
}
function attachment(o: Observed, input: PostflightInput): string {
  noError(o.logError)
  noError(o.processError)
  const spawns = upstream(o, input).filter((e) => e.event === 'codex.upstream.spawn')
  const urls = spawns.map((e) =>
    Array.isArray(e.args) && e.args.every((arg) => typeof arg === 'string')
      ? appOpenaiBaseUrl(e.args as string[])
      : 'invalid argv',
  )
  if (input.expect !== 'router') {
    if (urls.some(Boolean) || o.appProcs.some((p) => p.command.includes('openai_base_url')))
      throw new Error('unexpected router URL on non-router child')
    return 'no child carries openai_base_url'
  }
  if (!input.routerUrl || !urls.length || urls.some((url) => url !== input.routerUrl))
    throw new Error('GPT child router URL mismatch')
  for (const adapter of currentAdapters(o, input)) {
    const link = lastEvent(
      o.events.filter((e) => Date.parse(String(e.ts)) >= Date.parse(adapter.processStart)),
      /^router\.link$/,
      adapter.pid,
    )
    if (
      link?.attached !== true ||
      link.url !== input.routerUrl ||
      !['native', 'bridge'].includes(String(link.fanout))
    )
      throw new Error(`adapter ${adapter.pid} has no current attached router link`)
  }
  return `current adapters attached to ${input.routerUrl}`
}
function foreign(o: Observed, system: System, input: PostflightInput): string {
  noError(o.processError)
  noError(o.logError)
  const added = classifyCodexProcesses(
    o.procs.filter((p) => !o.otherFamily.has(p.pid)),
    system.app,
    o.ownership,
  ).filter((p) => p.kind === 'other' && !input.baselineOther.includes(p.path))
  if (added.length || hasForeignShimEvent(o.events, o.procs, o.otherFamily))
    throw new Error(`new foreign Codex or shim fallback: ${added.map((p) => p.path).join(', ')}`)
  return 'no new foreign Codex executable or non-bundled fallback event'
}
async function routerHealth(
  o: Observed,
  system: System,
  deps: FlipDeps,
  input: PostflightInput,
): Promise<string> {
  noError(o.processError)
  const health = await deps.routerHealth(2000)
  if (input.expect !== 'router') {
    if (health || jobLoaded(system, ROUTER_LABEL))
      throw new Error('router still answers or its job remains loaded')
    return 'router connection refused and job positively absent'
  }
  const snapshot = checkIdentity(o, deps, input)
  const value = requireValue(health, 'router health unavailable')
  healthy(value, snapshot)
  if (!jobLoaded(system, ROUTER_LABEL)) throw new Error('router job absent')
  if (
    !o.procs.some(
      (p) =>
        p.pid === value.pid &&
        Date.parse(String(value.startedAt)) >= Date.parse(p.processStart) &&
        adapterArguments(p.command)?.script ===
          join(snapshot.libDir ?? '', 'dist/src/adapter.mjs') &&
        adapterArguments(p.command)?.args[0] === 'router',
    )
  )
    throw new Error('router health has no current matching process/library/start identity')
  const fanout = (value.fanout as Record<string, unknown>).path
  if (
    currentAdapters(o, input).some(
      (p) => lastEvent(o.events, /^router\.link$/, p.pid)?.fanout !== fanout,
    )
  )
    throw new Error('router and adapter fan-out paths disagree')
  return `pid ${value.pid}; verified ${value.version}; mode ${value.mode}; fan-out ${fanout}; zero faults`
}
export async function postflight(
  system: System,
  deps: FlipDeps,
  input: PostflightInput,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = []
  checks.push(await checked('app version', () => appVersion(system, input)))
  let observed = observe(system, deps, input)
  let hand = await checked('handshake', () => handshake(observed, input, system.home))
  let gpt = await checked('GPT child', () => child(observed, input))
  for (let attempt = 0; attempt < 30 && (!hand.ok || !gpt.ok); attempt += 1) {
    try {
      await system.sleep(2000)
      observed = observe(system, deps, input)
    } catch (error) {
      hand = { name: 'handshake', ok: false, detail: message(error) }
      break
    }
    hand = await checked('handshake', () => handshake(observed, input, system.home))
    gpt = await checked('GPT child', () => child(observed, input))
  }
  checks.push(
    hand,
    await checked('adapter process', () => adapterCheck(observed, deps, input)),
    gpt,
    await checked('router attached', () => attachment(observed, input)),
    await checked('foreign codex', () => foreign(observed, system, input)),
    await checked('router health', () => routerHealth(observed, system, deps, input)),
  )
  checks.push(
    await checked('claim socket', async () => {
      if (input.expect !== 'router') return 'not required for this expectation'
      const adapters = currentAdapters(observed, input)
      if (!adapters.length) throw new Error('no restarted adapter to ping')
      for (const adapter of adapters) {
        if (await deps.claimPing(adapter.pid)) continue
        if (system.processes().some((process) => process.pid === adapter.pid))
          throw new Error(`claim socket ${adapter.pid} did not answer with its identity`)
        observed.adapters = observed.adapters.filter((process) => process.pid !== adapter.pid)
      }
      if (!currentAdapters(observed, input).length)
        throw new Error('no restarted adapter remains after claim checks')
      return `${currentAdapters(observed, input).length} current adapter claim sockets answered`
    }),
  )
  checks.push(
    await checked('doctor', async () => {
      if (input.expect === 'vanilla') return 'not required for vanilla'
      checkIdentity(observed, deps, input)
      const result = await deps.doctor()
      if (!result.ok) throw new Error(result.text)
      return result.text
    }),
  )
  checks.push(
    await checked('smoke', async () => {
      if (input.expect === 'vanilla')
        return 'not required for vanilla; app and bundled child checked'
      const gate = requireValue(
        deps.mandatoryGate,
        'not wired: Task27 mandatory installed deployment gate (scheduled smoke cannot waive it)',
      )
      if (checks.some((check) => !check.ok))
        throw new Error('mandatory gate not run: postflight prerequisites failed')
      const snapshot = checkIdentity(observed, deps, input)
      const request: GateRequest = {
        attempt: randomUUID(),
        root: snapshot.root,
        since: input.since.toISOString(),
        startedAt: system.now().toISOString(),
        models: { claude: snapshot.config.smoke.claudeModel, gpt: snapshot.config.smoke.gptModel },
        expect: input.expect,
        codeIdentity: requireValue(snapshot.codeIdentity, 'code identity missing'),
        key: { ...snapshot.key },
        mode: snapshot.mode,
        adapters: currentAdapters(observed, input).map(({ pid, processStart }) => ({
          pid,
          processStart,
        })),
      }
      const probes = createProbeObserver(system, request, snapshot.config, () => {
        const fresh = checkIdentity(observe(system, deps, input), deps, input)
        return { codeIdentity: fresh.codeIdentity ?? '', key: fresh.key, mode: fresh.mode }
      })
      const detail = gateResult(
        await gate(structuredClone(request), probes.observe),
        request,
        system.now(),
        probes.observations,
      )
      const after = observe(system, deps, input)
      const current = checkIdentity(after, deps, input)
      if (
        !sameKey(current.key, request.key) ||
        current.codeIdentity !== request.codeIdentity ||
        current.bundled !== snapshot.bundled ||
        JSON.stringify(
          currentAdapters(after, input).map(({ pid, processStart }) => ({ pid, processStart })),
        ) !== JSON.stringify(request.adapters)
      )
        throw new Error('identity, process family or frozen settings changed during mandatory gate')
      child(after, input)
      attachment(after, input)
      foreign(after, system, input)
      await routerHealth(after, system, deps, input)
      return detail
    }),
  )
  return checks
}
