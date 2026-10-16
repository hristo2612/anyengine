// Strict, bounded observations for status's named inputs only. These reads
// never publish, clear, repair or certify state; SQLite remains opaque.
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import http from 'node:http'
import { basename, join } from 'node:path'
import { enginePaths } from './anyengine-config.mjs'
import { parseClaudeSettings } from './claude-settings.mjs'
import { readLayers } from './control-layer-journal.mjs'
import {
  type DegradedFile,
  inspectDegraded,
  inspectProof,
  type ProofKey,
  sameKey,
} from './degraded.mjs'
import type { RouterStatusFile } from './router-fanout.mjs'
import { readKnownGood } from './update-watch.mjs'

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value)
const time = (value: unknown) => text(value) && Number.isFinite(Date.parse(value))
const paths = new Set([
  'router',
  'gpt',
  'claude-agent',
  'claude-model',
  'native-fanout',
  'bridge',
  'claude-code-gpt',
])
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
// Only these named status inputs are read; coordination SQLite is opaque.
function bytesAt(path: string, limit = 2_000_000): Buffer | null {
  let present = false
  try {
    const stat = lstatSync(path)
    present = true
    if (!stat.isFile() || stat.size > limit) throw new Error('unsupported file or byte limit')
    const bytes = readFileSync(path)
    if (bytes.length > limit) throw new Error('byte limit')
    return bytes
  } catch (error) {
    if (!present && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`cannot read ${path}: ${errorText(error)}`)
  }
}
function decode(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}
function jsonAt(
  path: string,
  valid: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const bytes = bytesAt(path)
  if (bytes === null) return null
  const value: unknown = JSON.parse(decode(bytes))
  if (!object(value) || !valid(value)) throw new Error(`invalid or unsupported ${path}`)
  return value
}
function pathEntries(
  value: Record<string, unknown>,
  valid: (entry: Record<string, unknown>) => boolean,
): boolean {
  return (
    object(value.paths) &&
    Object.entries(value.paths).every(
      ([key, entry]) => paths.has(key) && object(entry) && valid(entry),
    )
  )
}
const validKey = (value: unknown): value is ProofKey =>
  object(value) && sameKey(value as unknown as ProofKey, value as unknown as ProofKey)
function validStatus(value: Record<string, unknown>): boolean {
  return (
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    text(value.version) &&
    Number.isInteger(value.port) &&
    Number(value.port) >= 1024 &&
    Number(value.port) <= 65535 &&
    time(value.startedAt) &&
    time(value.writtenAt) &&
    ['agent', 'model'].includes(String(value.mode)) &&
    object(value.fanout) &&
    ['native', 'bridge'].includes(String(value.fanout.path)) &&
    text(value.fanout.reason) &&
    time(value.fanout.since)
  )
}
const validKnownGood = (value: Record<string, unknown>) =>
  (value.version === undefined || value.version === 1) &&
  text(value.appVersion) &&
  text(value.codexVersion) &&
  text(value.codexPath) &&
  time(value.verifiedAt)
const validSmoke = (value: Record<string, unknown>) =>
  (value.version === undefined || value.version === 1) &&
  time(value.at) &&
  validKey(value.key) &&
  pathEntries(
    value,
    (entry) =>
      (typeof entry.ok === 'boolean' || entry.ok === null) &&
      typeof entry.ms === 'number' &&
      Number.isFinite(entry.ms) &&
      typeof entry.detail === 'string',
  )
export function readStatusHealth(url: string): Promise<Record<string, unknown>> {
  return new Promise((done, reject) => {
    const request = http.get(url, { agent: false }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 128_000) request.destroy(new Error('router health exceeds byte limit'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        clearTimeout(timer)
        try {
          if (response.statusCode !== 200)
            throw new Error(`router health HTTP ${response.statusCode}`)
          const value: unknown = JSON.parse(decode(Buffer.concat(chunks)))
          if (
            !object(value) ||
            value.ok !== true ||
            !Number.isSafeInteger(value.pid) ||
            Number(value.pid) <= 0 ||
            !text(value.version) ||
            !time(value.startedAt) ||
            !object(value.fanout) ||
            !['native', 'bridge'].includes(String(value.fanout.path)) ||
            !text(value.fanout.reason) ||
            !['agent', 'model'].includes(String(value.mode)) ||
            !object(value.faults) ||
            value.faults.hookErrors !== 0 ||
            value.faults.unhandledRejections !== 0 ||
            !object(value.upstream) ||
            !object(value.inflight)
          )
            throw new Error('router health invalid or reports faults')
          if (
            value.upstream.lastError &&
            (!value.upstream.lastOkAt ||
              String(value.upstream.lastErrorAt) >= String(value.upstream.lastOkAt))
          )
            throw new Error(unresolvedUpstream(value.upstream))
          if (value.gpt !== undefined) value.gpt = projectBroker(value.gpt)
          done(value)
        } catch (error) {
          reject(error)
        }
      })
    })
    const timer = setTimeout(
      () => request.destroy(new Error('router health unavailable within 1000 ms')),
      1000,
    )
    request.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

// The Codex face forwards the app's own bearer, so its 401 names the app's login.
function unresolvedUpstream(upstream: Record<string, unknown>): string {
  if (upstream.lastError !== 'models: HTTP_401')
    return 'router upstream reports an unresolved failure'
  const at = Date.parse(String(upstream.lastErrorAt))
  const when = Number.isFinite(at) ? ` at ${new Date(at).toISOString()}` : ''
  return `router upstream: OpenAI refused the Codex app's own login with HTTP 401 on /models${when}; the router forwards that login unchanged, so restart the app (or the other Codex front end) that holds it, or run codex login`
}

export function readStatusLayers(root: string): string[] {
  return readLayers(root).layers.map((layer) => layer.name)
}
export function readStatusKnownGood(root: string): string | null {
  const file = jsonAt(enginePaths(root).knownGood, validKnownGood)
  if (file?.format !== undefined) readKnownGood(root)
  return typeof file?.appVersion === 'string' ? file.appVersion : null
}
export function readStatusSmoke(root: string): Record<string, unknown> | null {
  return jsonAt(enginePaths(root).smokeResult, validSmoke)
}
export function readStatusProof(root: string): Record<string, unknown> | null {
  return inspectProof(root) as unknown as Record<string, unknown> | null
}
export function readStatusDegraded(root: string): DegradedFile {
  return inspectDegraded(root) ?? { paths: {} }
}
export function readStatusRouter(root: string): RouterStatusFile | null {
  return jsonAt(enginePaths(root).routerStatus, validStatus) as unknown as RouterStatusFile | null
}
export function readStatusRecovery(root: string): { path: string; command: string } | null {
  const path = join(root, 'RECOVER.txt')
  const bytes = bytesAt(path, 64_000)
  if (bytes === null) return null
  const command = decode(bytes).trim()
  if (!command || command.includes('\0')) throw new Error('invalid recovery instruction')
  return { path, command }
}
export function readStatusLib(root: string): string | null {
  const path = join(enginePaths(root).lib, 'current')
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const resolved = realpathSync(path)
  if (!lstatSync(resolved).isDirectory())
    throw new Error('lib/current does not resolve to a directory')
  return basename(resolved)
}

interface BrokerView {
  ready: boolean
  source: 'adapter' | 'standalone' | 'file' | 'none'
  generation: number
  reason: string | null
  // Last HTTP 401 OpenAI gave the broker's bearer; open until a later 200.
  rejection: { at: string; endpoint: 'models' | 'responses'; open: boolean } | null
}
export interface ClaudeCodeStatus {
  enabled: boolean | null
  settingsInstalled: boolean | null
  models: string[]
  broker: BrokerView | null
  translationVersion: string | null
  health: 'off' | 'ready' | 'degraded' | 'unknown'
  warnings: string[]
}
function projectBroker(value: unknown): BrokerView | null {
  if (
    !object(value) ||
    typeof value.ready !== 'boolean' ||
    !['adapter', 'standalone', 'file', 'none'].includes(String(value.source)) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 0
  )
    return null
  const reason =
    value.reason === null
      ? null
      : typeof value.reason === 'string' && /^broker\.[a-z-]{1,48}$/.test(value.reason)
        ? value.reason
        : 'broker.unavailable'
  return {
    ready: value.ready,
    source: value.source as BrokerView['source'],
    generation: Number(value.generation),
    reason,
    rejection: projectRejection(value.rejection),
  }
}
function projectRejection(value: unknown): BrokerView['rejection'] {
  if (
    !object(value) ||
    typeof value.at !== 'string' ||
    !Number.isFinite(Date.parse(value.at)) ||
    !['models', 'responses'].includes(String(value.endpoint)) ||
    typeof value.open !== 'boolean'
  )
    return null
  return {
    at: new Date(Date.parse(value.at)).toISOString(),
    endpoint: value.endpoint as 'models' | 'responses',
    open: value.open,
  }
}
const LOGIN_REASONS: Record<string, string> = {
  'broker.login-required': 'the active Codex home has no ChatGPT login',
  'broker.chatgpt-required': 'the active Codex login is an API key, not ChatGPT',
  'broker.token-expired': 'the Codex login expired and the official refresh did not renew it',
  'broker.invalid-token': 'the Codex login holds a token the router cannot read',
}
// One plain sentence naming why GPT inside Claude Code is failing, or null.
export function brokerProblem(broker: BrokerView | null): string | null {
  if (!broker) return null
  if (broker.rejection?.open)
    return `OpenAI refused the GPT login with HTTP 401 on /${broker.rejection.endpoint} at ${broker.rejection.at} and no GPT call has succeeded since; the router re-reads the Codex login and refreshes it at most once every 5 minutes, so run codex login for the active account`
  const login = broker.reason ? LOGIN_REASONS[broker.reason] : undefined
  return login ? `${login}; run codex login for the active account` : null
}

function userClaudeSettings(
  home: string,
  origin: string,
  ownedModels: readonly string[],
): { installed: boolean; warnings: string[] } {
  const path = join(home, '.claude/settings.json')
  const bytes = bytesAt(path)
  if (bytes === null) return { installed: false, warnings: ['Claude user settings are absent'] }
  const settings = parseClaudeSettings(decode(bytes))
  const env = object(settings.env) ? settings.env : {}
  const picker = object(settings.modelPicker) ? settings.modelPicker : {}
  const rows = Array.isArray(picker.options) ? picker.options : []
  const ownedRows = ownedModels.every(
    (id) => rows.filter((row) => object(row) && row.model === id).length === 1,
  )
  const installed =
    ownedRows &&
    env.ANTHROPIC_BASE_URL === origin &&
    env.CLAUDE_CODE_GATEWAY_HINT_HEADERS === '1' &&
    typeof env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'string' &&
    /^claude-haiku-[a-z0-9.-]+$/.test(env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
  const warnings: string[] = []
  if (!installed)
    warnings.push(
      'Claude routing/base URL, Haiku/hint or owned picker settings differ from the installed router',
    )
  // Presence is sufficient; credential values and helper commands are never inspected.
  if (
    Object.hasOwn(settings, 'apiKeyHelper') ||
    ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY_HELPER'].some((key) =>
      Object.hasOwn(env, key),
    )
  )
    warnings.push('Credential/helper configuration exists; subscription passthrough is not proven')
  return { installed, warnings }
}
function precedence(home: string, root: string): boolean {
  return [
    join(home, '.claude/managed-settings.json'),
    join(home, '.claude/settings.local.json'),
    join(root, 'smoke/claude-project/.claude/settings.json'),
    join(root, 'smoke/claude-project/.claude/settings.local.json'),
  ].some((path) => {
    try {
      lstatSync(path)
      return true
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code !== 'ENOENT'
    }
  })
}
function translationVersion(root: string, current: string | null): string | null {
  if (!current) return null
  const bytes = bytesAt(join(root, 'lib', current, 'vendor/claude-code-proxy/UPSTREAM.md'), 128_000)
  const source = bytes ? decode(bytes) : ''
  return source.includes('v0.1.42') && source.includes('1e30e301a48c01a797308e2d24f6c66515363cbf')
    ? '0.1.42'
    : null
}
function catalogIds(
  root: string,
  generation: number | undefined,
): { models: string[]; stale: boolean } {
  const value = jsonAt(
    join(root, 'router/claude-gpt-catalog.json'),
    (row) =>
      Number.isSafeInteger(row.generation) &&
      Number(row.generation) > 0 &&
      Number.isSafeInteger(row.fetchedAt) &&
      Array.isArray(row.models) &&
      row.models.length <= 10,
  )
  if (!value) return { models: [], stale: false }
  if (value.generation !== generation) return { models: [], stale: true }
  const rows = value.models as unknown[]
  if (
    !rows.every(
      (row) =>
        object(row) &&
        typeof row.id === 'string' &&
        row.id.length <= 128 &&
        /^gpt-[a-z0-9][a-z0-9.-]*$/.test(row.id),
    )
  )
    throw new Error('invalid diagnostic models')
  const models = rows.map((row) => (row as { id: string }).id)
  if (new Set(models).size !== models.length) throw new Error('ambiguous diagnostic models')
  return { models, stale: false }
}

// This diagnostic projection is never routing authority or a settings dump.
export function readStatusClaudeCode(input: {
  root: string
  home: string
  layers: string[] | null
  current: string | null
  port: number
  health: Record<string, unknown> | null
}): ClaudeCodeStatus {
  const enabled = input.layers === null ? null : input.layers.includes('claude-code')
  const state: ClaudeCodeStatus = {
    enabled,
    settingsInstalled: null,
    models: [],
    broker: projectBroker(input.health?.gpt),
    translationVersion: null,
    health: enabled === false ? 'off' : 'unknown',
    warnings: [],
  }
  try {
    const owned =
      readLayers(input.root).layers.find((layer) => layer.name === 'claude-code')?.claudeCode
        ?.ownedModels ?? []
    const settings = userClaudeSettings(input.home, `http://127.0.0.1:${input.port}`, owned)
    state.settingsInstalled = settings.installed
    if (enabled) state.warnings.push(...settings.warnings)
    if (precedence(input.home, input.root))
      state.warnings.push('Higher precedence managed/project settings may shadow user routing')
    state.translationVersion = translationVersion(input.root, input.current)
    const problem = brokerProblem(state.broker)
    if (enabled && problem) state.warnings.push(problem)
    const catalog = catalogIds(input.root, state.broker?.generation)
    state.models = catalog.models
    if (catalog.stale) state.warnings.push('Diagnostic models belong to another account generation')
    if (enabled)
      state.health =
        !state.translationVersion || !state.broker
          ? 'unknown'
          : settings.installed && state.broker.ready && state.models.length > 0 && !problem
            ? 'ready'
            : 'degraded'
  } catch {
    state.health = enabled === false ? 'off' : 'unknown'
    state.warnings.push('Claude settings or model evidence are invalid or unavailable')
  }
  return state
}
