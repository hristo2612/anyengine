// Bounded diagnostic operations behind the doctor command. No mutation of
// observed homes; subprocesses use System, socket requests only send ping,
// and storage traversal uses lstat exclusively (SQLite stays opaque).
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import net from 'node:net'
import { basename, dirname, join } from 'node:path'
import { parse } from 'smol-toml'
import { type AnyEngineConfig, enginePaths, routerBaseUrl } from './anyengine-config.mjs'
import { onLines, writeLine } from './claim-protocol.mjs'
import { nonGptModelLines, topLevelString } from './codex-config-toml.mjs'
import type { StatusReport } from './control-status.mjs'
import type { System } from './control-system.mjs'
import { inspectProof, sameKey, settingsHash } from './degraded.mjs'

export type Finding = { level: 'ok' | 'warn' | 'fail'; detail: string }
export interface DoctorContext {
  system: System
  root: string
  codex: string
  config: AnyEngineConfig
  status: StatusReport
  codexVersion: string | null
}
export const ok = (detail: string): Finding => ({ level: 'ok', detail })
export const warn = (detail: string): Finding => ({ level: 'warn', detail })
export function requireInspection(c: DoctorContext, names: RegExp): void {
  const errors = c.status.inspectionErrors.filter((error) => names.test(error))
  if (errors.length) throw new Error(errors.join('; '))
}
export function recovery(c: DoctorContext): string {
  return c.status.recovery
    ? `recovery ${c.status.recovery.path}: ${c.status.recovery.command}`
    : 'stable recovery entry unavailable; preserve marker, journal and backups'
}
export function routerLayer(c: DoctorContext): boolean {
  requireInspection(c, /layers\.json/)
  return c.status.layers?.includes('router') ?? false
}
export function scriptPath(c: DoctorContext, name: string): string {
  requireInspection(c, /lib\/current/)
  if (!c.status.lib.current) throw new Error('installed lib/current is absent')
  const path = join(realpathSync(join(enginePaths(c.root).lib, 'current')), 'scripts', name)
  if (!lstatSync(path).isFile()) throw new Error(`installed script is not a file: ${path}`)
  return path
}
export function scriptEnv(c: DoctorContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: c.system.home,
    CODEX_HOME: c.codex,
    ANYENGINE_ROOT: c.root,
    ANYENGINE_CHATGPT_APP: c.system.app,
    ANYENGINE_ADAPTER: join(enginePaths(c.root).lib, 'current/dist/src/adapter.mjs'),
  }
}
function supportedDoctor(c: DoctorContext): { script: string; lib: string } {
  try {
    const script = scriptPath(c, 'doctor.mjs')
    const lib = dirname(dirname(script))
    if (basename(lib) !== c.status.lib.current)
      throw new Error('lib/current changed during inspection')
    if (
      !optionalText(script)?.startsWith('#!/usr/bin/env node\n// anyengine-doctor-isolation: 1\n')
    )
      throw new Error('missing or unsupported isolation declaration')
    // Fixed v1 cohort: never import installed modules to ask whether they are safe.
    const required = [
      'scripts/doctor.mjs',
      'scripts/lib/codex-probe.mjs',
      'scripts/lib/codex-probe-runner.mjs',
      'scripts/lib-verify.mjs',
      'scripts/check-posture-schema.mjs',
      'scripts/check-rust-protocol-fixtures.mjs',
      'dist/src/adapter.mjs',
      'dist/src/posture.mjs',
      'dist/src/env-compat.mjs',
      'dist/src/runtime-config.mjs',
      'dist/src/bundled-codex.mjs',
      'test/fixtures/claude-permission-modes.json',
      'test/fixtures/posture-schema.json',
      ...[
        'initialize.request',
        'thread-start.request',
        'config-read.request',
        'turn-started.notification',
        'turn-completed.notification',
        'mcp-server-status-list.response',
        'config-read.response',
      ].map((name) => `crates/anyengine-protocol/fixtures/${name}.json`),
    ]
    for (const entry of required) {
      const path = join(lib, entry)
      if (realpathSync(path) !== path || optionalText(path) === null)
        throw new Error(`missing or indirect required file: ${entry}`)
    }
    return { script, lib }
  } catch (error) {
    throw new Error(`unsupported installed doctor: ${String(error)}`)
  }
}
export function adapterChecks(c: DoctorContext): Finding {
  requireInspection(c, /app running|app version/)
  const { script, lib } = supportedDoctor(c)
  const result = c.system.exec(process.execPath, [script, '--json', '--schemas'], {
    env: { ...scriptEnv(c), ANYENGINE_ADAPTER: join(lib, 'dist/src/adapter.mjs') },
    timeoutMs: 90_000,
  })
  if (result.status !== 0)
    throw new Error(
      `installed doctor failed (${result.status ?? 'unknown'}): ${result.stdout}${result.stderr}`,
    )
  if (realpathSync(join(enginePaths(c.root).lib, 'current')) !== lib)
    throw new Error('lib/current changed during installed doctor inspection; version is unknown')
  const report = JSON.parse(result.stdout) as {
    checks?: Array<{ name: string; ok: boolean; message?: string }>
    codex?: { path: string; version: string }
  }
  if (
    !Array.isArray(report.checks) ||
    !report.checks.length ||
    report.checks.some((check) => check.ok !== true || typeof check.name !== 'string')
  )
    throw new Error(`installed doctor returned invalid or failing checks: ${result.stdout}`)
  if (
    !report.codex ||
    report.codex.path !== c.status.app.codex ||
    !/^\d+\.\d+\.\d+\S*$/.test(report.codex.version)
  )
    throw new Error('installed doctor did not identify the selected Codex version')
  c.codexVersion = report.codex.version
  return ok(
    report.checks
      .map((check) => `${check.name}${check.message ? `: ${check.message}` : ''}`)
      .join('\n  '),
  )
}
export function fanout(c: DoctorContext): Finding {
  requireInspection(
    c,
    /proven\.json|degraded\.json|smoke\.json|known-good\.json|router-status\.json|processes|app version|lib\/current|router health/,
  )
  const proof = inspectProof(c.root)?.paths['native-fanout']
  const health = c.status.router.health
  const current = {
    lib: c.status.lib.current,
    appVersion: c.status.app.version,
    codexVersion: c.codexVersion,
    settings: settingsHash(c.config),
  }
  const history = proof
    ? `last proof ${proof.at}: ${proof.detail}; key ${JSON.stringify(proof.key)}`
    : 'no previous native proof'
  const changed = proof
    ? (['lib', 'appVersion', 'codexVersion', 'settings'] as const).filter(
        (field) => proof.key[field] !== current[field],
      )
    : []
  const explanation = `${history}${changed.length ? `; changed or unknown: ${changed.join(', ')}` : ''}; current ${JSON.stringify(current)}`
  if (c.status.configErrors.length)
    throw new Error(`configuration errors prevent native: ${c.status.configErrors.join('; ')}`)
  if (!health) {
    if (routerLayer(c)) throw new Error(`current router health unavailable; ${explanation}`)
    return warn(`no current router observed; ${explanation}`)
  }
  if (c.status.router.fanout === 'native') {
    if (
      !proof ||
      !sameKey(proof.key, current) ||
      health.mode !== c.config.modes.codexClaude ||
      c.status.adapters.some((adapter) => adapter.version !== current.lib)
    )
      throw new Error(`current versions, running libraries or mode disagree; ${explanation}`)
    return ok(
      `native proven ${proof.at}: ${proof.detail}; key ${JSON.stringify(proof.key)}; current running lib and versions agree`,
    )
  }
  if (c.status.router.fanout === 'unknown')
    throw new Error(`${c.status.router.reason}; ${explanation}`)
  return (c.config.router.multiAgentV1 ? warn : ok)(
    `bridge: ${c.status.router.reason}; ${explanation}`,
  )
}

function optionalText(path: string): string | null {
  let present = false
  try {
    const stat = lstatSync(path)
    present = true
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error('unsupported file or byte limit')
    const bytes = readFileSync(path)
    if (bytes.length > 2_000_000) throw new Error('byte limit')
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (error) {
    if (!present && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`cannot inspect ${path}: ${String(error)}`)
  }
}
function sharedToml(c: DoctorContext): string {
  const text = optionalText(join(c.codex, 'config.toml')) ?? ''
  parse(text)
  return text
}
export function sharedModels(c: DoctorContext): Finding {
  const lines = nonGptModelLines(sharedToml(c))
  const path = join(process.env.ANYENGINE_HOME || join(c.codex, 'anyengine'), 'app-model-pick.json')
  const raw = optionalText(path)
  let pick = 'absent'
  if (raw !== null) {
    const value: unknown = JSON.parse(raw)
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.entries(value).some(
        ([key, entry]) => !['model', 'review_model'].includes(key) || typeof entry !== 'string',
      )
    )
      throw new Error(`invalid app pick ${path}`)
    pick = JSON.stringify(value)
  }
  const detail = lines
    .map(
      (line) =>
        `${line.key} = "${line.value}" (line ${line.index + 1}): a terminal codex with no -m asks OpenAI for ${line.value}; ${line.table ? 'profile line is yours to edit' : 'a complete anyengine on removes this top-level assignment and retains the app pick'}`,
    )
    .join('; ')
  return (lines.length ? warn : ok)(
    `${detail || 'shared model assignments are GPT or absent'}; app pick ${path}: ${pick}`,
  )
}
export function terminalRouter(c: DoctorContext): Finding {
  requireInspection(c, /^accounts:/)
  const account = c.status.accounts
  if (account?.conflicts.length) throw new Error(account.conflicts.join('; '))
  if (account && account.phase !== 'open')
    throw new Error('Account admission frozen; run anyengine accounts recover')
  if (account && account.active !== account.home && account.possibleCanonicalPids.length)
    return warn(
      `Managed account ${account.label} is active; unmanaged Codex processes ${account.possibleCanonicalPids.join(', ')} may still use canonical Home. Restart those surfaces through AnyEngine to share the active account.`,
    )
  const base = topLevelString(sharedToml(c), 'openai_base_url')
  const isRouter = base && base.replace(/\/+$/, '') === routerBaseUrl(c.config)
  return isRouter
    ? warn(
        `shared openai_base_url is the router (${base}); terminal Claude turns have no owning adapter`,
      )
    : ok(
        'terminal codex normally ignores the router catalog: models-cache identity includes resolved base URL and client version; live differential acceptance remains a separate gate',
      )
}
export function conflictingSettings(c: DoctorContext): Finding {
  const result = c.system.exec(
    '/bin/zsh',
    ['-ilc', 'print -r -- ${CODEX_APP_SERVER_OPENAI_BASE_URL-}'],
    { env: { ...scriptEnv(c), CODEX_SHELL: '1' }, timeoutMs: 5000 },
  )
  if (result.status !== 0) throw new Error(`login-shell inspection failed: ${result.stderr}`)
  const base = result.stdout.trim()
  return base && base.replace(/\/+$/, '') !== routerBaseUrl(c.config)
    ? warn(
        `login shell sets CODEX_APP_SERVER_OPENAI_BASE_URL=${base}; adapter will not attach this router`,
      )
    : ok(base ? 'login shell names this router' : 'no login-shell router override')
}
export function appUpdate(c: DoctorContext): Finding {
  requireInspection(c, /app running|app version/)
  const result = c.system.exec(
    process.execPath,
    [
      scriptPath(c, 'preflip-check.mjs'),
      '--quiet-seconds',
      '0',
      '--app',
      c.system.app,
      '--codex-home',
      c.codex,
    ],
    { env: scriptEnv(c), timeoutMs: 30_000 },
  )
  const detail = `${result.stdout}${result.stderr}`.trim()
  if (result.status === 0) return ok(detail || 'no staged update reported')
  if (
    result.status === 1 &&
    /an app update is staged and would install on restart/.test(detail) &&
    !/cannot tell/.test(detail)
  )
    return warn(
      'an app update is staged; it installs at the next quit; AnyEngine must verify it afterwards',
    )
  throw new Error(`app-update inspection failed (${result.status ?? 'unknown'}): ${detail}`)
}

function ping(path: string, pid: number): Promise<void> {
  return new Promise((done, reject) => {
    const socket = net.createConnection(path)
    let settled = false
    let unsubscribe = () => {}
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      socket.destroy()
      if (error) reject(error)
      else done()
    }
    const timer = setTimeout(
      () => finish(new Error(`claim socket did not answer within 1000 ms: ${path}`)),
      1000,
    )
    unsubscribe = onLines(
      socket,
      (value) => {
        if (
          value.type !== 'pong' ||
          value.pid !== pid ||
          !Number.isSafeInteger(value.threads) ||
          Number(value.threads) < 0
        )
          finish(new Error(`invalid claim pong identity: ${path}`))
        else finish()
      },
      () => finish(new Error(`invalid claim frame: ${path}`)),
    )
    socket.once('connect', () => writeLine(socket, { op: 'ping' }))
    socket.once('error', (error) => finish(error))
    socket.once('close', () => {
      if (!settled) finish(new Error(`claim socket closed without pong: ${path}`))
    })
  })
}
export async function claimSockets(c: DoctorContext): Promise<Finding> {
  requireInspection(c, /processes/)
  const missing: number[] = []
  for (const adapter of c.status.adapters) {
    const path = join(enginePaths(c.root).run, `claim-${adapter.pid}.sock`)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat) {
      missing.push(adapter.pid)
      continue
    }
    if (!stat.isSocket()) throw new Error(`claim path is not a socket: ${path}`)
    await ping(realpathSync(path), adapter.pid)
  }
  return missing.length
    ? warn(`adapters without claim sockets: ${missing.join(', ')}`)
    : ok(`${c.status.adapters.length} current adapter sockets answered ping`)
}

function sizeOf(path: string, skip: (name: string) => boolean = () => false): number {
  let size = 0
  let count = 0
  const pending = [path]
  while (pending.length) {
    const next = pending.pop()
    if (next === undefined) break
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(next)
    } catch (error) {
      if (next === path && (error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    if (++count > 200_000) throw new Error(`storage inspection exceeds 200000 entries: ${path}`)
    size += stat.size
    if (stat.isDirectory())
      for (const name of readdirSync(next)) {
        if (next === path && skip(name)) continue
        pending.push(join(next, name))
      }
  }
  return size
}
export function storage(c: DoctorContext): Finding {
  requireInspection(c, /layers\.json|known-good\.json|flip\.json|RECOVER\.txt/)
  const adapterHome = process.env.ANYENGINE_HOME || join(c.codex, 'anyengine')
  let logs = 0
  try {
    for (const name of readdirSync(adapterHome))
      if (/^debug\.jsonl(?:\..+)?$/.test(name)) logs += sizeOf(join(adapterHome, name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const project = join(c.root, 'smoke/claude-project').replace(/[^a-zA-Z0-9]/g, '-')
  const entries: Array<[string, number, number]> = [
    [
      'root excluding lib and rollbacks',
      sizeOf(c.root, (name) => name === 'lib' || name.startsWith('rollback-')),
      500,
    ],
    ['state', sizeOf(enginePaths(c.root).state), 20],
    ['adapter debug logs', logs, 250],
    ['launchd logs', sizeOf(join(c.root, 'logs')), 50],
    ['Claude smoke project', sizeOf(join(c.system.home, '.claude/projects', project)), 50],
  ]
  const detail = entries
    .map(([name, size, limit]) => `${name}: ${(size / 1024 / 1024).toFixed(2)} MB (limit ${limit})`)
    .join('; ')
  return (entries.some(([, size, limit]) => size > limit * 1024 * 1024) ? warn : ok)(
    `${detail}; recovery pins ${c.status.layers?.join(', ') || 'none recorded'}`,
  )
}
