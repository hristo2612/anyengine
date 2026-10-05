// Paths the nightly smoke found broken (spec 7: "A failure raises a macOS
// notification and marks the path degraded"). The adapter reads the router's
// mark before it attaches the router; `anyengine status` shows them all; a
// passing smoke clears its own path.
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  type AnyEngineConfig,
  enginePaths,
  loadConfig,
  writeJsonAtomic,
} from './anyengine-config.mjs'
import { withFileLock } from './file-lock.mjs'
import { appVersionCached, codexVersionCached } from './proof-versions.mjs'

export type SmokePath =
  | 'claude-code-gpt'
  | 'router'
  | 'gpt'
  | 'claude-agent'
  | 'claude-model'
  | 'native-fanout'
  | 'bridge'

export interface DegradedFile {
  paths: Partial<Record<SmokePath, { since: string; reason: string }>>
}

function file(root: string): string {
  return `${enginePaths(root).state}/degraded.json`
}

export function readDegraded(root: string): DegradedFile {
  try {
    return inspectDegraded(root) ?? { paths: {} }
  } catch (error) {
    // This is an observation sentinel, never a mutation baseline.
    return { paths: { 'native-fanout': { since: 'unknown', reason: String(error) } } }
  }
}

export function markDegraded(root: string, path: SmokePath, reason: string): void {
  if (typeof reason !== 'string') throw new Error('invalid degraded reason')
  mutateEvidence(root, path, (proof, degraded) => {
    const since = degraded.paths[path]?.since ?? new Date().toISOString()
    const { [path]: _cleared, ...rest } = proof.paths
    return {
      proof: { ...proof, paths: rest },
      degraded: {
        ...degraded,
        paths: { ...degraded.paths, [path]: { since, reason } },
      },
    }
  })
}

export function clearDegraded(root: string, path: SmokePath): void {
  mutateEvidence(root, path, (_proof, degraded) => {
    if (!degraded.paths[path]) return {}
    const { [path]: _cleared, ...rest } = degraded.paths
    return { degraded: { ...degraded, paths: rest } }
  })
}
// The native fan-out proof: a passing native-fanout check (the smoke, Task 27;
// or the switch-on's pre-proof of the staged lib, Task 30) holds only for the
// exact lib, ChatGPT.app version, bundled codex version and settings (the
// ones that shape native fan-out, settingsHash) it ran under. Any of them
// changing needs a new proof; the router serves the bridge path until then.
// App/Codex null means unreadable and never matches; "absent" means confirmed
// absence. A null lib means a private root with no installed current link.
export interface ProofKey {
  lib: string | null
  appVersion: string | null
  codexVersion: string | null
  settings: string
}
export interface ProofReads {
  lib?(): string | null
  appVersion?(): string | null
  codexVersion?(): string | null
  config?(): AnyEngineConfig
}
interface ProofEntry {
  at: string
  detail: string
  key: ProofKey
}
interface ProofFile {
  paths: Partial<Record<SmokePath, ProofEntry>>
}

const proofFile = (root: string) => `${enginePaths(root).state}/proven.json`

// Only what shapes native fan-out: whether v1 is marked, the modes, which
// Claude models are offered and in what order, and the claim settings. Not
// the port, not the claude CLI path (`on` fills that in), so a pre-proof run
// before `on` and the running router agree (Task 30).
export function settingsHash(config: AnyEngineConfig): string {
  const shaping = [
    config.router.multiAgentV1,
    config.modes,
    config.claude.models,
    config.claude.spawnPriority,
    config.claims,
  ]
  return createHash('sha256').update(JSON.stringify(shaping)).digest('hex').slice(0, 16)
}

export function proofKey(root: string, reads: ProofReads = {}): ProofKey {
  return {
    lib: reads.lib ? reads.lib() : currentLib(root),
    appVersion: reads.appVersion ? reads.appVersion() : appVersionCached(),
    codexVersion: reads.codexVersion ? reads.codexVersion() : codexVersionCached(),
    settings: settingsHash(reads.config ? reads.config() : loadConfig(root)),
  }
}

export function sameKey(a: ProofKey, b: ProofKey): boolean {
  return (
    validKey(a) &&
    validKey(b) &&
    a.lib === b.lib &&
    a.appVersion === b.appVersion &&
    a.codexVersion === b.codexVersion &&
    a.settings === b.settings
  )
}

export function markProven(root: string, path: SmokePath, detail: string, key: ProofKey): void {
  if (!validKey(key) || typeof detail !== 'string') throw new Error('invalid proof publication')
  mutateEvidence(root, path, (proof) => {
    const previous = Date.parse(proof.paths[path]?.at ?? '')
    const at = new Date(
      Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0),
    ).toISOString()
    return { proof: { ...proof, paths: { ...proof.paths, [path]: { at, detail, key } } } }
  })
}

export function readProof(root: string, path: SmokePath): ProofEntry | null {
  try {
    return inspectProof(root)?.paths[path] ?? null
  } catch {
    return null
  }
}

export function isProven(root: string, path: SmokePath, key: ProofKey): boolean {
  const proof = readProof(root, path)
  return proof !== null && !readDegraded(root).paths[path] && sameKey(proof.key, key)
}

export function clearProof(root: string, path: SmokePath): void {
  mutateEvidence(root, path, (proof) => {
    if (!proof.paths[path]) return {}
    const { [path]: _cleared, ...rest } = proof.paths
    return { proof: { ...proof, paths: rest } }
  })
}

const PATHS = new Set([
  'claude-code-gpt',
  'router',
  'gpt',
  'claude-agent',
  'claude-model',
  'native-fanout',
  'bridge',
])
const LIMIT = 2_000_000
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const fields = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).every((key) => names.includes(key))
const timestamp = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))

function validateEvidence(value: unknown, kind: 'proof' | 'degraded'): void {
  if (
    !object(value) ||
    !fields(value, ['version', 'paths']) ||
    (value.version !== undefined && value.version !== 1) ||
    !object(value.paths)
  )
    throw new Error(`invalid or unsupported ${kind} evidence`)
  for (const [path, entry] of Object.entries(value.paths)) {
    if (!PATHS.has(path) || !object(entry)) throw new Error(`unsupported ${kind} path`)
    const valid =
      kind === 'proof'
        ? fields(entry, ['at', 'detail', 'key']) &&
          timestamp(entry.at) &&
          typeof entry.detail === 'string' &&
          validKey(entry.key as ProofKey)
        : fields(entry, ['since', 'reason']) &&
          timestamp(entry.since) &&
          typeof entry.reason === 'string'
    if (!valid) throw new Error(`invalid ${kind} entry: ${path}`)
  }
  if (Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`) > LIMIT)
    throw new Error(`${kind} evidence exceeds publication byte limit`)
}

function readEvidence(path: string, kind: 'proof' | 'degraded'): unknown {
  let present = false
  try {
    const stat = lstatSync(path)
    present = true
    if (!stat.isFile() || stat.size > LIMIT) throw new Error('unsupported file or byte limit')
    const bytes = readFileSync(path)
    if (bytes.length > LIMIT) throw new Error('byte limit')
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    )
    validateEvidence(value, kind)
    return value
  } catch (error) {
    if (!present && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`cannot read ${path}; preserve ${kind} evidence: ${String(error)}`)
  }
}

// Strict inspection for doctor/status. Missing is null; every invalid record
// throws. Routing readers above convert failure only to a conservative result.
export function inspectProof(root: string): ProofFile | null {
  return readEvidence(proofFile(root), 'proof') as ProofFile | null
}
export function inspectDegraded(root: string): DegradedFile | null {
  return readEvidence(file(root), 'degraded') as DegradedFile | null
}

type EvidencePlan = { proof?: ProofFile; degraded?: DegradedFile }
function mutateEvidence(
  root: string,
  path: SmokePath,
  transform: (proof: ProofFile, degraded: DegradedFile) => EvidencePlan,
): void {
  if (!PATHS.has(path)) throw new Error('unsupported evidence path')
  const plan = () => {
    const proof = inspectProof(root) ?? { paths: {} }
    const degraded = inspectDegraded(root) ?? { paths: {} }
    const result = transform(proof, degraded)
    if (result.proof) validateEvidence(result.proof, 'proof')
    if (result.degraded) validateEvidence(result.degraded, 'degraded')
    return result
  }
  plan() // Validate both inputs and the publication before any filesystem artifacts.
  const state = enginePaths(root).state
  mkdirSync(state, { recursive: true, mode: 0o700 })
  // All public mutations own this same short gate. Callers must not wrap it.
  // SQLite and its sidecars are persistent opaque coordination storage.
  withFileLock(join(state, 'proof-degraded.lock'), () => {
    const result = plan() // A waiter cannot publish from its pre-lock snapshot.
    // Failure clears proof first: a partial publication cannot retain success.
    if (result.proof) writeJsonAtomic(proofFile(root), result.proof)
    if (result.degraded) writeJsonAtomic(file(root), result.degraded)
  })
}

function currentLib(root: string): string | null {
  try {
    return basename(realpathSync(join(enginePaths(root).lib, 'current')))
  } catch {
    try {
      lstatSync(join(enginePaths(root).lib, 'current'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    }
    return '' // Present but unreadable: never a matching proof key.
  }
}

function validKey(key: ProofKey): boolean {
  return (
    object(key) &&
    fields(key, ['lib', 'appVersion', 'codexVersion', 'settings']) &&
    (key.lib === null || (typeof key.lib === 'string' && key.lib.length > 0)) &&
    [key.appVersion, key.codexVersion].every((v) => typeof v === 'string' && v.length > 0) &&
    typeof key.settings === 'string' &&
    key.settings.length > 0
  )
}
