// Credential operations use lstat/readlink/rename only. Never open auth bytes.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  type Stats,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export function entry(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
function directory(path: string, create: boolean, forbidden: number): void {
  for (let parent = path; ; parent = dirname(parent)) {
    if (entry(parent)?.isSymbolicLink()) throw new Error(`Linked account directory: ${parent}`)
    if (dirname(parent) === parent) break
  }
  const before = entry(path)
  if (!before && create) mkdirSync(path, { recursive: true, mode: 0o700 })
  const s = lstatSync(path)
  if (!s.isDirectory() || s.uid !== process.getuid?.() || s.mode & forbidden)
    throw new Error(`Unsafe account directory: ${path}`)
}
export function privateDirectory(path: string, create = true): void {
  directory(path, create, 0o077)
}
// The vendor owns canonical home permissions; forbid other writers, not readers.
export function canonicalDirectory(path: string): void {
  directory(path, false, 0o022)
}
export function privateFile(path: string): void {
  const s = entry(path)
  if (s && (!s.isFile() || s.uid !== process.getuid?.() || s.nlink !== 1 || s.mode & 0o077))
    throw new Error(`Unsafe account file: ${path}`)
}
export function syncDir(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
export function durableJson(path: string, value: unknown): void {
  privateDirectory(dirname(path))
  privateFile(path)
  const tmp = `${path}.tmp-${randomUUID()}`
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
    syncDir(dirname(path))
  } finally {
    if (entry(tmp)) unlinkSync(tmp)
  }
}
export function metadataJson(path: string): unknown {
  privateFile(path)
  const s = entry(path)
  if (!s) return undefined
  if (s.size > 4 * 1024 * 1024) throw new Error('Account metadata exceeds size limit')
  return JSON.parse(readFileSync(path, 'utf8'))
}
export type AuthOp =
  | { kind: 'move'; from: string; to: string; dev: number; ino: number }
  | { kind: 'link' | 'unlink'; path: string; target: string }

export function applyAuthOp(op: AuthOp): void {
  for (const path of op.kind === 'move' ? [op.from, op.to] : [op.path])
    privateDirectory(dirname(path))
  if (op.kind === 'move') {
    privateFile(op.from)
    privateFile(op.to)
    const from = entry(op.from),
      to = entry(op.to)
    const matches = (s: Stats | null) => !!s && s.isFile() && s.dev === op.dev && s.ino === op.ino
    if (!from && matches(to)) return
    if (!matches(from) || to) throw new Error('Credential inventory conflict; admission closed')
    privateDirectory(dirname(op.from))
    privateDirectory(dirname(op.to))
    if (lstatSync(dirname(op.to)).dev !== op.dev)
      throw new Error('Credential moves require one filesystem')
    renameSync(op.from, op.to)
    syncDir(dirname(op.from))
    syncDir(dirname(op.to))
    return
  }
  const current = entry(op.path)
  const correct = current?.isSymbolicLink() && readlinkSync(op.path) === op.target
  if (op.kind === 'link') {
    if (correct) return
    if (current) throw new Error('Auth link destination occupied')
    symlinkSync(op.target, op.path)
  } else {
    if (!current) return
    if (!correct) throw new Error('Refusing to unlink unexpected auth entry')
    unlinkSync(op.path)
  }
  syncDir(dirname(op.path))
}
export function inverseAuthOp(op: AuthOp): AuthOp {
  return op.kind === 'move'
    ? { ...op, from: op.to, to: op.from }
    : { ...op, kind: op.kind === 'link' ? 'unlink' : 'link' }
}
