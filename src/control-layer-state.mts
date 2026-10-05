// Recovery records are authority, not best-effort observations. A present bad
// record or missing/corrupt owned bytes blocks mutation and preserves every pin.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  type Stats,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { enginePaths } from './anyengine-config.mjs'

export type LayerName = 'adapter' | 'router' | 'claude-code'
export interface FileState {
  kind: 'file' | 'symlink' | 'absent'
  sha: string | null
  link: string | null
  bytes: string | null
  mode: number | null
}
export interface FileChange {
  target: string
  before: FileState['kind']
  backup: string | null
  after: string | null
  mode: number | null
  beforeSha: string | null
  afterSha: string | null
  beforeLink: string | null
  afterLink: string | null
  afterMode: number | null
  pending: FileState | null
  lastGood?: FileState
}
export interface SharedConfigRecord {
  target: string
  pickFile: string
  backup: string
  removed: Array<{ key: string; value: string; index: number; text: string }>
}
export interface Layer {
  name: LayerName
  rollbackDir: string
  adoptedFrom: string | null
  createdAt: string
  changes: FileChange[]
  jobs: string[]
  cleansCache: boolean
  claudeCode?: {
    settingsTarget: string
    ownedModels: string[]
    touchedPaths: string[]
    catalog: { generation: number; fetchedAt: number }
  }
  sharedConfig?: SharedConfigRecord | null
  pending?: 'after-quit' | null
  upgrade?: {
    createdAt: string
    jobs: string[]
    cleansCache: boolean
    sharedConfig: SharedConfigRecord | null
    claudeCode?: Layer['claudeCode']
  }
}
export interface LayerFile {
  version: 1
  layers: Layer[]
  recovery?: { entry: string; controlLib: string; pinnedLibs: string[] }
}
export const POPPED = 'POPPED'
export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
export const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value)
export const absolute = (value: unknown): value is string =>
  text(value) && isAbsolute(value) && resolve(value) === value
export const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
export function ordinary(path: string): void {
  if (/\.(sqlite3?|db)(-(wal|shm|journal))?$/i.test(path))
    throw new Error('SQLite coordination files are opaque; preserve their inode and sidecars')
}
export function statAt(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
export function regularBytes(path: string, limit = Infinity): Buffer {
  ordinary(path)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size > limit)
    throw new Error(`unsupported regular recovery file: ${path}`)
  const bytes = readFileSync(path)
  if (bytes.length > limit) throw new Error(`recovery byte limit: ${path}`)
  return bytes
}
export function jsonAt(path: string): unknown {
  if (!statAt(path)) return undefined
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        regularBytes(path, 2_000_000),
      ),
    ) as unknown
  } catch (error) {
    throw new Error(`invalid recovery journal or manifest: ${path}`, { cause: error })
  }
}
export function sha256Of(path: string): string | null {
  ordinary(path)
  const stat = statAt(path)
  return stat?.isFile() ? digest(regularBytes(path)) : null
}
export function stateAt(path: string): FileState {
  ordinary(path)
  const stat = statAt(path)
  if (!stat) return { kind: 'absent', sha: null, link: null, bytes: null, mode: null }
  if (stat.isSymbolicLink())
    return { kind: 'symlink', link: readlinkSync(path), sha: null, bytes: null, mode: null }
  if (!stat.isFile()) throw new Error(`unsupported recovery target kind: ${path}`)
  return { kind: 'file', sha: sha256Of(path), link: null, bytes: null, mode: stat.mode & 0o7777 }
}
export function sameState(a: FileState, b: FileState): boolean {
  return a.kind === b.kind && a.sha === b.sha && a.link === b.link && a.mode === b.mode
}
export function beforeState(change: FileChange): FileState {
  return {
    kind: change.before,
    sha: change.beforeSha,
    link: change.beforeLink,
    bytes: change.backup,
    mode: change.mode,
  }
}
export function settledState(change: FileChange): FileState {
  return {
    kind: change.afterLink !== null ? 'symlink' : change.afterSha !== null ? 'file' : 'absent',
    sha: change.afterSha,
    link: change.afterLink,
    bytes: change.after,
    mode: change.afterMode,
  }
}
export function setSettled(change: FileChange, state: FileState): void {
  change.afterSha = state.sha
  change.afterLink = state.link
  change.after = state.bytes
  change.afterMode = state.mode
}
export function syncDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
export function atomicFile(target: string, bytes: Buffer, permissions: number): void {
  ordinary(target)
  const temp = `${target}.anyengine-${randomUUID()}`
  try {
    const fd = openSync(temp, 'wx', permissions)
    try {
      writeFileSync(fd, bytes)
      fchmodSync(fd, permissions)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, target)
    syncDirectory(dirname(target))
  } finally {
    rmSync(temp, { force: true })
  }
}
function removeTemporaryLink(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
export function swapLink(target: string, to: string): void {
  ordinary(target)
  const temp = `${target}.anyengine-${randomUUID()}`
  try {
    symlinkSync(to, temp)
    renameSync(temp, target)
    syncDirectory(dirname(target))
  } finally {
    removeTemporaryLink(temp)
  }
}
export function keepBytes(dir: string, bytes: Buffer): string {
  const name = `${digest(bytes)}.bytes`
  const path = join(dir, name)
  if (statAt(path)) {
    if (digest(regularBytes(path)) !== digest(bytes))
      throw new Error(`corrupt recovery backup: ${path}`)
  } else atomicFile(path, bytes, 0o600)
  return name
}
export function recoveryPaths(root: string): {
  directory: string
  entry: string
  journal: string
  instructions: string
  layers: string
} {
  const directory = join(enginePaths(root).root, 'recovery')
  return {
    directory,
    entry: join(directory, 'anyengine-off'),
    journal: enginePaths(root).layers,
    instructions: join(root, 'RECOVER.txt'),
    layers: join(directory, 'layers'),
  }
}
export function safeTarget(target: string, root?: string): void {
  if (!absolute(target)) throw new Error('invalid absolute layer target')
  ordinary(target)
  if (
    root &&
    (target === root ||
      target === dirname(enginePaths(root).layers) ||
      target === enginePaths(root).layers ||
      target === recoveryPaths(root).instructions ||
      target === recoveryPaths(root).directory ||
      target.startsWith(`${recoveryPaths(root).directory}/`))
  )
    throw new Error('layer target overlaps durable recovery evidence')
}
export function directoryAt(path: string): void {
  const stat = statAt(path)
  if (stat && !stat.isDirectory())
    throw new Error('recovery journal directory must be a real directory')
}
export function ownedDirectory(root: string, dir: string): void {
  directoryAt(root)
  if (
    !absolute(dir) ||
    !(
      dirname(dir) === recoveryPaths(root).layers ||
      (dirname(dir) === root && /^rollback-[a-zA-Z0-9_-]+$/.test(basename(dir)))
    )
  )
    throw new Error('invalid owned layer rollback directory')
  let cursor = dir
  while (cursor !== root) {
    const stat = statAt(cursor)
    if (stat && !stat.isDirectory())
      throw new Error('layer recovery directory must be a real directory')
    cursor = dirname(cursor)
  }
}

// Sync every newly linked directory before publishing blobs inside it.
export function prepareDirectory(root: string, dir: string): void {
  ownedDirectory(root, dir)
  const missing: string[] = []
  let cursor = dir
  while (!statAt(cursor)) {
    missing.push(cursor)
    cursor = dirname(cursor)
  }
  directoryAt(cursor)
  for (const path of missing.reverse()) {
    mkdirSync(path, { mode: 0o700 })
    syncDirectory(dirname(path))
  }
}
