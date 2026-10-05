// Codex 0.159 does not expose requirement-source filesystem denies on the
// app-server wire. Read local sources; unseen cloud requirements remain unknown.
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, statSync } from 'node:fs'
import { parse } from 'smol-toml'
import type { Posture } from './posture.mjs'

const MAX_SOURCE_BYTES = 1024 * 1024
const MDM_REFRESH_MS = 5000

type PreferenceKey = 'requirements_toml_base64' | 'config_toml_base64'
type PreferenceReader = (key: PreferenceKey) => string | null

// Local restrictions are a live overlay, not a thread preference. The symbol
// survives posture spreads but is removed together with the overlay at every
// persistence/request-application boundary. Wire restrictions remain sticky.
const LOCAL_READ_OVERLAY = Symbol('local read restriction')
type LocalPosture = Posture & { [LOCAL_READ_OVERLAY]?: boolean }

export function durablePosture(posture: Posture): Posture {
  const local = posture as LocalPosture
  if (!Object.hasOwn(local, LOCAL_READ_OVERLAY)) return posture
  const { [LOCAL_READ_OVERLAY]: wireRestricted, readRestricted: _local, ...rest } = local
  return wireRestricted ? { ...rest, readRestricted: true } : rest
}

export function withLocalReadRestrictions(posture: Posture): LocalPosture {
  const durable = durablePosture(posture)
  return localReadRestricted()
    ? { ...durable, readRestricted: true, [LOCAL_READ_OVERLAY]: !!durable.readRestricted }
    : durable
}

// Files are cheap to refresh at every posture resolution, including existing
// threads and warm launches. MDM's subprocess is cached for at most five seconds.
export function localReadRestricted(
  env: NodeJS.ProcessEnv = process.env,
  readPreference: PreferenceReader = managedPreference,
): boolean {
  try {
    if (observedManagedRequirements) return true
    const legacy = readSource(env.ANYENGINE_MANAGED_CONFIG_FILE ?? '/etc/codex/managed_config.toml')
    const legacyMdm =
      env.ANYENGINE_MDM_CONFIG_FILE === undefined
        ? readPreference('config_toml_base64')
        : readSource(env.ANYENGINE_MDM_CONFIG_FILE)
    if (legacy !== null || legacyMdm !== null) return true
    const file = readSource(env.ANYENGINE_REQUIREMENTS_FILE ?? '/etc/codex/requirements.toml')
    const encoded =
      env.ANYENGINE_MDM_REQUIREMENTS_FILE === undefined
        ? readPreference('requirements_toml_base64')
        : readSource(env.ANYENGINE_MDM_REQUIREMENTS_FILE)
    return tomlRestrictsReads(file) || tomlRestrictsReads(decodePreference(encoded))
  } catch {
    // Missing sources are normal; unreadable, oversized, malformed and failed
    // preference queries are not proof that the parent permits reads.
    return true
  }
}

function readSource(path: string): string | null {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES)
      throw new Error('invalid requirements source')
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A dangling source symlink is unreadable, not an absent policy.
    try {
      lstatSync(path)
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw missing
    }
    throw error
  }
}

function tomlRestrictsReads(source: string | null): boolean {
  if (source === null) return false
  const parsed = parse(source)
  const permissions = parsed.permissions
  if (permissions === undefined) return false
  if (!isTable(permissions)) return true
  const filesystem = permissions.filesystem
  if (filesystem === undefined) return false
  return !isTable(filesystem) || Object.hasOwn(filesystem, 'deny_read')
}

function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decodePreference(source: string | null): string | null {
  if (source === null) return null
  const compact = source.replace(/\s/g, '')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new Error('invalid requirements base64')
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(compact, 'base64'))
}

const managedCaches = new Map<
  PreferenceKey,
  { expires: number; value: string | null; failed: boolean }
>()
function managedPreference(key: PreferenceKey): string | null {
  let managedCache = managedCaches.get(key)
  if (process.platform !== 'darwin') return null
  if (!managedCache || Date.now() >= managedCache.expires) {
    try {
      managedCache = {
        expires: Date.now() + MDM_REFRESH_MS,
        value: readManagedPreference(key),
        failed: false,
      }
    } catch {
      managedCache = { expires: Date.now() + MDM_REFRESH_MS, value: null, failed: true }
    }
  }
  managedCaches.set(key, managedCache)
  if (managedCache.failed) throw new Error('cannot read managed requirements')
  return managedCache.value
}

// Kept separately so tests cover the real defaults error contract without
// querying or modifying the operator's preference domain.
export function preferenceResult(
  result: {
    status: number | null
    stdout: string
    stderr: string
    error?: Error
  },
  key: PreferenceKey = 'requirements_toml_base64',
): string | null {
  if (result.error) throw result.error
  if (result.status === 0) return result.stdout.trim()
  if (
    result.status === 1 &&
    result.stderr.includes(`The domain/default pair of (com.openai.codex, ${key}) does not exist`)
  )
    return null
  throw new Error('cannot read managed requirements')
}

function readManagedPreference(key: PreferenceKey): string | null {
  return preferenceResult(
    spawnSync('/usr/bin/defaults', ['read', 'com.openai.codex', key], {
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: MAX_SOURCE_BYTES,
    }),
    key,
  )
}

// A config/read can disclose managed/cloud layer provenance without its
// requirements contents. That is enough to fail closed, never to infer access.
let observedManagedRequirements = false
const MANAGED_SOURCES = new Set([
  'enterpriseManaged',
  'compositeEnterpriseManaged',
  'cloudConfigFragment',
  'legacyManagedConfigTomlFromFile',
  'legacyManagedConfigTomlFromMdm',
])
export function observeRequirementSources(value: Record<string, unknown>): void {
  const present = containsManagedSource(value.layers) || containsManagedSource(value.origins)
  if (Array.isArray(value.layers)) observedManagedRequirements = present
  else if (present) observedManagedRequirements = true
}

function containsManagedSource(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsManagedSource)
  if (!isTable(value)) return false
  if (typeof value.type === 'string' && MANAGED_SOURCES.has(value.type)) return true
  return Object.values(value).some(containsManagedSource)
}
