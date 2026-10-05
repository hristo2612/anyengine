// The shared cache is removed only for AnyEngine entries, after an exclusive
// private backup. Missing/clean caches are inert; corrupt evidence is retained.
// This is JSON cache work. Coordination SQLite files and sidecars stay opaque.
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { isAnyEngineEntry } from './router-catalog.mjs'

export interface CacheReport {
  path: string
  exists: boolean
  clientVersion: string | null
  models: number
  anyengine: string[]
  parseError: string | null
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const stamp = (path: string) => {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.size > 16_000_000n) throw new Error('unsupported models cache file')
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}

function readCache(codexHome: string, claudeIds: ReadonlySet<string>) {
  const path = join(codexHome, 'models_cache.json')
  const report: CacheReport = {
    path,
    exists: true,
    clientVersion: null,
    models: 0,
    anyengine: [],
    parseError: null,
  }
  let bytes: Buffer = Buffer.alloc(0)
  let identity = ''
  try {
    try {
      lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        report.exists = false
        return { report, bytes, identity }
      }
      throw error
    }
    identity = stamp(path)
    bytes = readFileSync(path)
    if (stamp(path) !== identity) throw new Error('models cache changed while inspected')
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    )
    if (
      !object(value) ||
      !Array.isArray(value.models) ||
      (value.client_version !== undefined && typeof value.client_version !== 'string') ||
      !value.models.every(
        (model) => object(model) && typeof model.slug === 'string' && model.slug.length > 0,
      )
    )
      throw new Error('invalid models cache structure')
    report.clientVersion = typeof value.client_version === 'string' ? value.client_version : null
    report.models = value.models.length
    report.anyengine = value.models
      .filter((model) => isAnyEngineEntry(model, claudeIds))
      .map((model) => model.slug)
  } catch (error) {
    report.parseError = error instanceof Error ? error.message : String(error)
  }
  return { report, bytes, identity }
}

export function inspectModelsCache(codexHome: string, claudeIds: ReadonlySet<string>): CacheReport {
  return readCache(codexHome, claudeIds).report
}

// Null means no authorized backup destination; an owned cache then refuses
// deletion. Tasks20/24 must pass their recovery directory before removing it.
export function cleanModelsCache(
  codexHome: string,
  claudeIds: ReadonlySet<string>,
  backupDir: string | null,
): { removed: boolean; report: CacheReport } {
  const { report, bytes, identity } = readCache(codexHome, claudeIds)
  if (!report.exists || report.parseError || report.anyengine.length === 0)
    return { removed: false, report }
  if (!backupDir) throw new Error('models cache removal requires a recovery backup directory')
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const fd = openSync(join(backupDir, 'models_cache.json'), 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (stamp(report.path) !== identity)
    throw new Error('models cache changed before removal; backup retained')
  unlinkSync(report.path)
  return { removed: true, report }
}
