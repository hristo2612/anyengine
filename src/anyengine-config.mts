// AnyEngine's own settings and state (spec 5.7). ~/.anyengine/config.json
// holds what the operator chooses (router port, Claude mode in the Codex
// surface, the Claude models the router advertises); state/ holds what the
// router, the smoke and the control CLI record; run/ holds the adapters'
// claim sockets. ANYENGINE_ROOT moves all of it (tests, probes).
//
// Reading never throws: a bad value falls back to its default and is listed
// in `errors`, which `anyengine status` and `doctor` print. What that must not
// do is run native fan-out on settings the operator did not write (decision
// D18: the proof is keyed on the modes, the Claude models and their order and
// the claim settings). So a file that cannot be used, or a bad router switch,
// detaches the router, and a problem in a setting the proof is keyed on (or
// in the file's version) turns native fan-out off. Writing validates,
// changes one key, keeps the rest of the file as it is, and throws with a
// message a person can act on; a set that is refused touches nothing.
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  type Fields,
  isFields,
  PARSERS,
  type Parser,
  SET_CHECKS,
} from './anyengine-config-rules.mjs'
import { withFileLock } from './file-lock.mjs'

export type CodexClaudeMode = 'agent' | 'model'

export interface ClaudeModelEntry {
  id: string
  displayName: string
  claudeModel: string
  contextWindow: number
}

export interface AnyEngineConfig {
  version: 1
  router: { enabled: boolean; port: number; upstream: string; multiAgentV1: boolean }
  modes: { codexClaude: CodexClaudeMode }
  claude: { models: ClaudeModelEntry[]; spawnPriority: string[]; cli: string | null }
  smoke: {
    enabled: boolean
    hour: number
    minute: number
    claudeModel: string
    gptModel: string | null
  }
  claims: { idleReleaseMinutes: number; graceMs: number; unclaimedFlipThreshold: number }
}

export interface EnginePaths {
  root: string
  config: string
  state: string
  run: string
  logs: string
  router: string
  smoke: string
  bin: string
  lib: string
  layers: string
  routerStatus: string
  smokeResult: string
  knownGood: string
  driftMarker: string
  updateWatch: string
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner)
    Object.freeze(value)
  }
  return value
}

// Ids match the adapter's own Claude ids (util.mts claudeModelOptions), so
// the picker shows one entry per model and a leaked catalog entry resolves to
// the adapter's Claude.
export const DEFAULT_CONFIG: AnyEngineConfig = deepFreeze<AnyEngineConfig>({
  version: 1,
  router: {
    enabled: true,
    port: 18790,
    upstream: 'https://chatgpt.com/backend-api/codex',
    multiAgentV1: true,
  },
  modes: { codexClaude: 'agent' },
  claude: {
    models: [
      { id: 'opus', displayName: 'Claude Opus', claudeModel: 'opus', contextWindow: 200000 },
      { id: 'sonnet', displayName: 'Claude Sonnet', claudeModel: 'sonnet', contextWindow: 200000 },
      { id: 'haiku', displayName: 'Claude Haiku', claudeModel: 'haiku', contextWindow: 200000 },
    ],
    spawnPriority: ['opus', 'sonnet', 'haiku'],
    cli: null,
  },
  smoke: { enabled: true, hour: 3, minute: 30, claudeModel: 'haiku', gptModel: null },
  claims: { idleReleaseMinutes: 10, graceMs: 3000, unclaimedFlipThreshold: 3 },
})

// Where the default is the riskier choice, a setting that cannot be read
// takes this instead: the router detached, native fan-out off.
const FALLBACK: Readonly<Record<string, unknown>> = {
  'router.enabled': false,
  'router.multiAgentV1': false,
}

// Unset means ~/.anyengine. Anything but an absolute path throws: a relative
// one (or a literal ~) would name another directory for the CLI, the router
// (cwd / under launchd) and the adapter, and quietly using ~/.anyengine
// instead would point a test or a probe at the live root.
export function anyengineRoot(env: NodeJS.ProcessEnv = process.env): string {
  const named = (env.ANYENGINE_ROOT ?? '').trim()
  if (!named) return join(homedir(), '.anyengine')
  if (!isAbsolute(named))
    throw new Error(
      `ANYENGINE_ROOT must be an absolute path, not ${JSON.stringify(named)} (~ is not expanded here; write $HOME)`,
    )
  return resolve(named)
}

export function enginePaths(root: string = anyengineRoot()): EnginePaths {
  const state = join(root, 'state')
  return {
    root,
    config: join(root, 'config.json'),
    state,
    run: join(root, 'run'),
    logs: join(root, 'logs'),
    router: join(root, 'router'),
    smoke: join(root, 'smoke'),
    bin: join(root, 'bin'),
    lib: join(root, 'lib'),
    layers: join(state, 'layers.json'),
    routerStatus: join(state, 'router-status.json'),
    smokeResult: join(state, 'smoke.json'),
    knownGood: join(state, 'known-good.json'),
    driftMarker: join(state, 'drift-failed'),
    updateWatch: join(state, 'update-watch.json'),
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const CONFIG_KEYS: readonly string[] = Object.keys(PARSERS)
// The models first, so the settings that name models are checked against them.
const ORDERED = ['claude.models', ...CONFIG_KEYS.filter((key) => key !== 'claude.models')]
const SECTIONS = new Set(CONFIG_KEYS.map((key) => key.slice(0, key.indexOf('.'))))
const UNKNOWN = 'unknown setting, which does nothing (anyengine config lists the known ones)'
// Problems after which native fan-out would run on settings other than
// those written: one in a setting its proof is keyed on, and any name
// AnyEngine does not know outside smoke (a typo, such as multiagentV1, may
// be the very setting the operator meant to change).
const SHAPES_PROOF =
  /^(version|modes|claude|claims)$|^(modes|claims)\.|^claude\.(models|spawnPriority)$/
const turnsNativeOff = (problem: Problem) =>
  SHAPES_PROOF.test(problem.key) || (problem.unknown === true && !problem.key.startsWith('smoke.'))

// Own properties only: `toString` or `router.constructor` is no setting.
export function getConfigValue(config: AnyEngineConfig, key: string): unknown {
  let at: unknown = config
  for (const part of key.split('.')) {
    if (!at || typeof at !== 'object' || !Object.hasOwn(at, part))
      throw new Error(`unknown setting ${key}`)
    at = (at as Record<string, unknown>)[part]
  }
  return at
}

function assign(config: AnyEngineConfig, key: string, value: unknown): void {
  const [section, field] = key.split('.') as [keyof AnyEngineConfig, string]
  const target = config[section] as unknown as Record<string, unknown>
  target[field] = value
}

function fallBack(config: AnyEngineConfig, key: string): void {
  if (Object.hasOwn(FALLBACK, key)) assign(config, key, FALLBACK[key])
}

// A problem in the file. `unknown` marks a name this version does not know:
// listed, since a typo does nothing, and kept by set (a newer lib may have
// written it).
interface Problem {
  key: string
  message: string
  unknown?: boolean
}
const describe = (problem: Problem) => `${problem.key}: ${problem.message}`

// Section by section, field by field: one bad value costs only itself.
function merge(raw: Fields, problems: Problem[]): AnyEngineConfig {
  const config = structuredClone(DEFAULT_CONFIG)
  for (const key of ORDERED) {
    const [section, field] = key.split('.') as [string, string]
    const block = raw[section]
    if (block === undefined) continue
    if (!isFields(block)) {
      fallBack(config, key)
      continue
    }
    if (!Object.hasOwn(block, field)) continue
    try {
      assign(config, key, PARSERS[key]?.(block[field], config))
    } catch (error) {
      problems.push({ key, message: messageOf(error) })
      fallBack(config, key)
    }
  }
  fitToModels(config, raw, problems)
  problems.push(...shapeProblems(raw))
  if (problems.some(turnsNativeOff)) config.router.multiAgentV1 = false
  return config
}

// The settings that name Claude models follow the models configured: the
// valid part of the spawn order, and a configured model for the smoke.
function fitToModels(config: AnyEngineConfig, raw: Fields, problems: Problem[]): void {
  const known = new Set(config.claude.models.map((m) => m.id))
  const named = isFields(raw.claude) ? raw.claude.spawnPriority : undefined
  const order: unknown[] = Array.isArray(named) ? named : config.claude.spawnPriority
  config.claude.spawnPriority = [...new Set(order)].filter(
    (id): id is string => typeof id === 'string' && known.has(id),
  )
  const smoke = config.smoke.claudeModel
  if (known.has(smoke)) return
  config.smoke.claudeModel = config.claude.models[0]?.id ?? smoke
  if (!problems.some((problem) => problem.key === 'smoke.claudeModel'))
    problems.push({
      key: 'smoke.claudeModel',
      message: `${smoke} is not a configured Claude model; the smoke runs on ${config.smoke.claudeModel}`,
    })
}

function shapeProblems(raw: Fields): Problem[] {
  const problems: Problem[] = []
  for (const [section, block] of Object.entries(raw)) {
    if (section === 'version') {
      if (block !== 1) problems.push({ key: section, message: 'needs 1' })
    } else if (!SECTIONS.has(section)) {
      problems.push({ key: section, message: UNKNOWN, unknown: true })
    } else if (!isFields(block)) {
      problems.push({ key: section, message: 'needs a JSON object' })
    } else {
      for (const field of Object.keys(block)) {
        const key = `${section}.${field}`
        if (!Object.hasOwn(PARSERS, key)) problems.push({ key, message: UNKNOWN, unknown: true })
      }
    }
  }
  return problems
}

interface FileState {
  fileError: string | null
  raw: Fields
  config: AnyEngineConfig
  problems: Problem[]
}

function evaluate(raw: Fields): FileState {
  const problems: Problem[] = []
  return { fileError: null, raw, config: merge(raw, problems), problems }
}

function unusable(fileError: string): FileState {
  const config = structuredClone(DEFAULT_CONFIG)
  for (const key of Object.keys(FALLBACK)) fallBack(config, key)
  return { fileError, raw: {}, config, problems: [] }
}

function inspectFile(path: string): FileState {
  let text: string
  let present = false
  try {
    const stat = lstatSync(path)
    present = true
    if (stat.isDirectory()) return unusable('config.json could not be read (EISDIR)')
    if (!stat.isFile() || stat.size > 2_000_000)
      return unusable('config.json needs a regular file within the 2000000-byte limit')
    const bytes = readFileSync(path)
    if (bytes.length > 2_000_000) return unusable('config.json exceeds the byte limit')
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      return unusable('config.json is not valid UTF-8 (original bytes preserved)')
    }
  } catch (error) {
    // Only confirmed absence means defaults; a dangling link stays invalid.
    const code = (error as NodeJS.ErrnoException).code
    if (!present && code === 'ENOENT') return evaluate({})
    return unusable(`config.json could not be read (${code ?? messageOf(error)})`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return unusable('config.json is not valid JSON')
  }
  return isFields(raw) ? evaluate(raw) : unusable('config.json does not hold a JSON object')
}

export function readConfig(root: string = anyengineRoot()): {
  config: AnyEngineConfig
  errors: string[]
} {
  const state = inspectFile(enginePaths(root).config)
  const errors = state.fileError ? [state.fileError] : state.problems.map(describe)
  return { config: state.config, errors }
}

const cache = new Map<string, { stamp: string; config: AnyEngineConfig }>()

// Which file is there now: a replace (a new inode), a write in place (size,
// mtime, ctime) and a removal each change it.
function stampOf(path: string): string {
  try {
    const stat = statSync(path)
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  } catch (error) {
    return `absent:${(error as NodeJS.ErrnoException).code}`
  }
}

// For hot paths (every routed request): re-read only when the file changed.
// Every caller shares the result, so it is frozen.
export function loadConfig(root: string = anyengineRoot()): AnyEngineConfig {
  const stamp = stampOf(enginePaths(root).config)
  const hit = cache.get(root)
  if (hit?.stamp === stamp) return hit.config
  const config = deepFreeze(readConfig(root).config)
  cache.set(root, { stamp, config })
  return config
}

// Whole or not at all: a temp file, synced, renamed over the target. A step
// that fails (a full disk) leaves no temp file behind.
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  rmSync(temp, { force: true })
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

// The root holds the settings and the claim sockets, which are the
// operator's alone. An older install may have made it 0755: a set tightens it.
function privateRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  if ((statSync(root).mode & 0o077) !== 0) chmodSync(root, 0o700)
}

// A set on top of an error would save a fallback as if the operator chose it.
function refuseOnErrors(current: FileState, key: string): void {
  if (current.fileError)
    throw new Error(`${current.fileError}; fix or remove it first (nothing was written)`)
  const others = current.problems.filter((problem) => !problem.unknown && problem.key !== key)
  if (others.length > 0)
    throw new Error(
      `config.json has errors to fix first (nothing was written): ${others.map(describe).join('; ')}`,
    )
}

// Dropping a Claude model drops it from the spawn order. The smoke's model
// has to move first, so the nightly smoke never runs on a model that is gone.
function keepModels(claude: Fields, current: AnyEngineConfig, kept: Set<string>): void {
  if (!kept.has(current.smoke.claudeModel))
    throw new Error(
      `the nightly smoke runs on ${current.smoke.claudeModel}, which this list drops; set smoke.claudeModel to a model you keep first`,
    )
  if (Array.isArray(claude.spawnPriority))
    claude.spawnPriority = claude.spawnPriority.filter((id) => kept.has(id))
}

// The file as it is, with one field replaced: names this version does not
// know stay, and no default is written for a key the operator never set.
function withValue(current: FileState, key: string, value: unknown): Fields {
  const next = structuredClone(current.raw)
  if (!Object.hasOwn(next, 'version')) next.version = 1
  const [section, field] = key.split('.') as [string, string]
  const block = isFields(next[section]) ? next[section] : {}
  block[field] = value
  next[section] = block
  if (key === 'claude.models') {
    const kept = new Set((value as ClaudeModelEntry[]).map((m) => m.id))
    keepModels(block, current.config, kept)
  }
  return next
}

// The file with one key changed, checked whole; throws when the set is refused.
function planSet(path: string, key: string, parse: Parser, raw: string): FileState {
  const current = inspectFile(path)
  refuseOnErrors(current, key)
  const value = parse(raw, current.config)
  SET_CHECKS[key]?.(value)
  const next = evaluate(withValue(current, key, value))
  const caused = next.problems.filter((problem) => !problem.unknown)
  if (caused.length > 0)
    throw new Error(
      `${key} ${JSON.stringify(value)} would make ${caused.map(describe).join('; ')} (nothing was written)`,
    )
  if (Buffer.byteLength(`${JSON.stringify(next.raw, null, 2)}\n`) > 2_000_000)
    throw new Error(
      'config.json published bytes would exceed the 2000000-byte limit (nothing was written)',
    )
  return next
}

// Planned once before the root is touched, so a refused set changes nothing,
// and again under config.json.lock, so no set loses another's change.
export function setConfigValue(root: string, key: string, raw: string): AnyEngineConfig {
  const parse = Object.hasOwn(PARSERS, key) ? PARSERS[key] : undefined
  if (!parse) throw new Error(`unknown setting ${key}; known: ${CONFIG_KEYS.join(', ')}`)
  const path = enginePaths(root).config
  planSet(path, key, parse, raw)
  privateRoot(root)
  const next = withFileLock(`${path}.lock`, () => {
    const planned = planSet(path, key, parse, raw)
    writeJsonAtomic(path, planned.raw)
    return planned
  })
  cache.delete(root)
  return next.config
}

export function routerBaseUrl(config: AnyEngineConfig): string {
  return `http://127.0.0.1:${config.router.port}/backend-api/codex`
}

export function routerHealthUrl(config: AnyEngineConfig): string {
  return `http://127.0.0.1:${config.router.port}/health`
}
