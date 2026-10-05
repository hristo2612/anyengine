// Read-only diagnostics. Each failed inspection is a failing check, including
// unknown process/app/evidence state. Historical records never prove current
// health; recovery commands come only from retained RECOVER.txt.
import { realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readConfig } from './anyengine-config.mjs'
import { registerCommand } from './control-cli.mjs'
import {
  adapterChecks,
  appUpdate,
  claimSockets,
  conflictingSettings,
  type DoctorContext,
  type Finding,
  fanout,
  ok,
  recovery,
  requireInspection,
  routerLayer,
  sharedModels,
  storage,
  terminalRouter,
  warn,
} from './control-doctor-checks.mjs'
import { regularBytes } from './control-layer-state.mjs'
import { gatherStatus } from './control-status.mjs'
import { adapterArguments, type System } from './control-system.mjs'
import { resolveRuntimeConfig } from './runtime-config.mjs'
import { codexHome } from './util.mjs'

export interface DoctorCheck {
  name: string
  level: 'ok' | 'warn' | 'fail'
  detail: string
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function config(c: DoctorContext): Finding {
  return c.status.configErrors.length
    ? warn(c.status.configErrors.join('; '))
    : ok('valid saved settings')
}
function routerJob(c: DoctorContext): Finding {
  requireInspection(c, /router job/)
  if (routerLayer(c) && c.status.router.job !== 'loaded')
    throw new Error('router layer is on but dev.anyengine.router is not loaded')
  return ok(`dev.anyengine.router ${c.status.router.job}`)
}
function routerHealth(c: DoctorContext): Finding {
  requireInspection(c, /router health|processes/)
  const health = c.status.router.health
  if (!health) {
    if (routerLayer(c)) throw new Error('router layer is on; current health unavailable')
    return ok('router layer off; no current health claimed')
  }
  const running = c.system.processes().some((process) => {
    const invocation = adapterArguments(process.command)
    return (
      process.pid === health.pid &&
      Date.parse(String(health.startedAt)) >= Date.parse(process.processStart) &&
      invocation?.args[0] === 'router' &&
      invocation.script.endsWith(`/lib/${String(health.version)}/dist/src/adapter.mjs`)
    )
  })
  if (!running)
    throw new Error('router health has no matching current process/start/library identity')
  return ok(`current pid ${health.pid}; fault counters zero; no unresolved upstream failure`)
}
function routerVersion(c: DoctorContext): Finding {
  requireInspection(c, /lib\/current|router health/)
  const version = c.status.router.health?.version
  if (!version) return ok('no current running router version observed')
  return version !== c.status.lib.current
    ? warn(
        `router runs ${version}; lib/current ${c.status.lib.current ?? 'absent'}; refresh the router attachment after installing the current lib`,
      )
    : ok(`router and lib/current ${version}`)
}
function adapters(c: DoctorContext): Finding {
  requireInspection(c, /processes|lib\/current/)
  const old = c.status.adapters.filter(
    (adapter) => adapter.version !== c.status.lib.current || !adapter.version,
  )
  return old.length
    ? warn(
        `running adapters differ from lib/current ${c.status.lib.current}: ${old.map((adapter) => `${adapter.pid}: ${adapter.version ?? 'unknown'}`).join(', ')}; the app keeps its lib until next launch`,
      )
    : ok(`${c.status.adapters.length} adapters run the current lib`)
}
function codexChild(c: DoctorContext): Finding {
  requireInspection(c, /processes|adapter log/)
  const unavailable = c.status.adapters.filter((adapter) => adapter.codexChild !== 'running')
  if (unavailable.length)
    throw new Error(
      unavailable
        .map(
          (adapter) =>
            `adapter ${adapter.pid}: codex child ${adapter.codexChild}; inspect selected bundled executable and current spawn evidence`,
        )
        .join('; '),
    )
  return ok(`${c.status.adapters.length} adapters with current matching codex children`)
}
function routerAttached(c: DoctorContext): Finding {
  requireInspection(c, /processes|adapter log/)
  if (!routerLayer(c)) return ok('router layer off')
  const processes = c.system.processes()
  const missing = c.status.adapters.filter((adapter) => {
    const start = processes.find((process) => process.pid === adapter.pid)?.processStart
    const time = adapter.link?.checkedAt
    return (
      !start ||
      typeof time !== 'string' ||
      !Number.isFinite(Date.parse(time)) ||
      Date.parse(time) < Date.parse(start) ||
      adapter.link?.attached !== true
    )
  })
  return missing.length
    ? warn(
        missing
          .map(
            (adapter) =>
              `pid ${adapter.pid}: ${String(adapter.link?.reason ?? 'no current router.link evidence')} (last event only)`,
          )
          .join('; '),
      )
    : ok(`${c.status.adapters.length} adapters with current attached router.link evidence`)
}
function claudeMode(c: DoctorContext): Finding {
  const runtime = resolveRuntimeConfig(process.env).type
  if (c.config.modes.codexClaude === 'model')
    return warn(
      'saved model mode: the trampoline is a policy grey area; current fan-out eligibility still applies',
    )
  if (runtime !== 'anyengine')
    return warn(
      `saved agent mode, runtime ${runtime}: Claude may run through the Agent SDK rather than the interactive CLI`,
    )
  return ok('saved agent mode with interactive CLI runtime')
}
function claudeInstalled(c: DoctorContext): string {
  try {
    const lib = realpathSync(join(c.root, 'lib/current'))
    if (basename(lib) !== c.status.lib.current) throw new Error('changed lib')
    const decode = (path: string) =>
      new TextDecoder('utf-8', { fatal: true }).decode(regularBytes(join(lib, path), 128_000))
    const license = decode('vendor/claude-code-proxy/LICENSE')
    const notices = decode('THIRD_PARTY_NOTICES.md')
    if (
      !license.includes('MIT License') ||
      !license.includes('Permission is hereby granted') ||
      !notices.includes('claude-code-proxy') ||
      c.status.claudeCode.translationVersion !== '0.1.42'
    )
      throw new Error('missing attribution or pin')
    const fixture: unknown = JSON.parse(decode('test/fixtures/claude-posture-2.1.289.json'))
    if (
      !fixture ||
      typeof fixture !== 'object' ||
      !('claudeVersion' in fixture) ||
      typeof fixture.claudeVersion !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(fixture.claudeVersion)
    )
      throw new Error('invalid Claude fixture')
    return fixture.claudeVersion
  } catch {
    throw new Error(
      'Claude Code installed library, MIT files or pinned fixture are invalid or unavailable',
    )
  }
}
function claudeVersion(c: DoctorContext, expected: string): Finding | null {
  if (!c.config.claude.cli)
    return warn('Claude executable is not configured; anyengine off restores user routing')
  let result: ReturnType<System['exec']>
  try {
    result = c.system.exec(c.config.claude.cli, ['--version'], { timeoutMs: 15_000 })
  } catch {
    throw new Error('Claude version inspection failed')
  }
  const version = /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/.exec(result.stdout)?.[1]
  if (result.status !== 0 || !version)
    throw new Error('Claude version inspection is invalid or unavailable')
  return version !== expected
    ? warn(
        `Claude ${version} differs from installed fixture ${expected}; rerun isolated captures before trusting GPT`,
      )
    : null
}
function claudeCode(c: DoctorContext): Finding {
  const state = c.status.claudeCode
  if (state.enabled === false)
    return ok('Claude Code GPT layer off; transparent Claude remains independent')
  if (state.enabled === null || state.settingsInstalled === null)
    throw new Error(
      'Claude Code settings or layer inspection is invalid or unavailable; codex login; anyengine off',
    )
  const fixture = claudeInstalled(c)
  const version = claudeVersion(c, fixture)
  const warnings = [...state.warnings]
  if (version) warnings.push(version.detail)
  if (c.status.otherAdapters.length)
    warnings.push(
      'External Codex adapters may use different homes; their canonical source is not proven',
    )
  if (state.health !== 'ready')
    warnings.push('GPT readiness is unavailable; codex login; anyengine off restores user routing')
  const detail = `port ${c.config.router.port}; broker sockets ${join(c.root, 'broker/sources')}; source ${state.broker?.source ?? 'unknown'} generation ${state.broker?.generation ?? 'unknown'}; translation ${state.translationVersion}; Claude fixture ${fixture}; ${state.models.length} model suggestions`
  return warnings.length
    ? warn(`${detail}; ${warnings.join('; ')}`)
    : ok(`${detail}; user base URL, Haiku and hint settings active`)
}
function cache(c: DoctorContext): Finding {
  requireInspection(c, /models_cache\.json|layers\.json/)
  const report = c.status.cache
  if (!c.status.layers?.length && report.anyengine.length)
    throw new Error(
      `${report.anyengine.length} AnyEngine entries with no active layer; run anyengine cache clean after confirmed app exit`,
    )
  return ok(
    `${report.exists ? `${report.models} models, ${report.anyengine.length} AnyEngine entries` : 'models cache absent'}`,
  )
}
function updateHold(c: DoctorContext): Finding {
  requireInspection(c, /startup-|update-watch|known-good|shim-fallback/)
  if (c.status.update.attempts?.block)
    throw new Error(
      `update failed; vendor fallback: ${c.status.update.attempts.block.reason}; anyengine smoke --force`,
    )
  if (c.status.update.failure)
    throw new Error(`startup fallback: ${String(c.status.update.failure.reason)}`)
  const result = c.system.launchctl(['print', `gui/${process.getuid?.() ?? 0}/dev.anyengine.smoke`])
  const absent =
    result.status === 113 &&
    ((!result.stdout && !result.stderr) || /Could not find service/.test(result.stderr))
  if (result.status !== 0 && !absent)
    throw new Error(`smoke job inspection failed (${result.status ?? 'unknown'}): ${result.stderr}`)
  const detail = `no reliable hold (D8); detect-and-alert via dev.anyengine.smoke (${result.status === 0 ? 'loaded' : 'not loaded'}; scheduled smoke ${c.config.smoke.enabled ? 'enabled' : 'disabled'})`
  return routerLayer(c) && result.status !== 0 && c.config.smoke.enabled ? warn(detail) : ok(detail)
}
function flip(c: DoctorContext): Finding {
  requireInspection(c, /flip|layers\.json|RECOVER\.txt/)
  const marker = c.status.flip
  if (!marker) return ok(`none; ${recovery(c)}`)
  const detail = `${marker.op} ${marker.alive === true ? `running, pid ${marker.pid}, phase ${marker.phase}` : `interrupted at ${marker.phase}`}; log ${marker.log}; ${recovery(c)}`
  if (marker.alive === true) return warn(detail)
  throw new Error(detail)
}

const CHECKS: ReadonlyArray<readonly [string, (c: DoctorContext) => Finding | Promise<Finding>]> = [
  ['adapter checks (scripts/doctor.mjs)', adapterChecks],
  ['config.json', config],
  ['router job', routerJob],
  ['router health', routerHealth],
  ['router version', routerVersion],
  ['adapters run the current lib', adapters],
  ['codex child', codexChild],
  ['router attached', routerAttached],
  ['fan-out path', fanout],
  ['Claude mode and runtime', claudeMode],
  ['Claude Code GPT', claudeCode],
  ['claim sockets', claimSockets],
  ['models cache', cache],
  ['terminal codex and the router', terminalRouter],
  ['shared config model', sharedModels],
  ['conflicting settings', conflictingSettings],
  ['app update', appUpdate],
  ['update hold', updateHold],
  ['flip', flip],
  ['storage', storage],
]
export const DOCTOR_CHECKS: readonly string[] = Object.freeze(CHECKS.map(([name]) => name))
export async function runDoctor(
  system: System,
  root: string,
  options: { codexHome?: string } = {},
): Promise<DoctorCheck[]> {
  let context: DoctorContext
  try {
    const codex = options.codexHome ?? codexHome()
    const status = await gatherStatus(system, root, { codexHome: codex })
    context = { system, root, codex, config: readConfig(root).config, status, codexVersion: null }
  } catch (error) {
    return DOCTOR_CHECKS.map((name) => ({
      name,
      level: 'fail',
      detail: `inspection unavailable: ${message(error)}`,
    }))
  }
  const out: DoctorCheck[] = []
  for (const [name, inspect] of CHECKS) {
    try {
      out.push({ name, ...(await inspect(context)) })
    } catch (error) {
      out.push({ name, level: 'fail', detail: `${message(error)}; ${recovery(context)}` })
    }
    if (inspect === adapterChecks) {
      // The installed probe can outlive a short App transport. Observe the
      // runtime after it settles, preserving its own verdict and version.
      try {
        context.status = await gatherStatus(system, root, { codexHome: context.codex })
      } catch (error) {
        context.status.inspectionErrors.push(`processes: doctor refresh failed: ${message(error)}`)
      }
    }
  }
  return out
}
registerCommand('doctor', async (args, system, root, say) => {
  if (args.length) {
    say('usage: anyengine doctor\n')
    return 2
  }
  const checks = await runDoctor(system, root)
  for (const check of checks) say(`${check.level.padEnd(4)} - ${check.name}: ${check.detail}\n`)
  return checks.some((check) => check.level === 'fail') ? 1 : 0
})
