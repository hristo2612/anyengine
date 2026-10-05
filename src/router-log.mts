// The router's own log: one JSON object per line, rotated at a size bound
// (default 5 MB, three old files), with anything that could be a credential
// replaced before it is written. The router relays bearers; it never logs
// them (spec 5.2, spec 8 "header relay (tokens never logged)").
import {
  appendFileSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { enginePaths } from './anyengine-config.mjs'

export interface RouterLog {
  readonly path: string
  info(event: string, data?: Record<string, unknown>): void
  error(event: string, data?: Record<string, unknown>): void
}

// A value under one of these names is never written, whatever it holds.
const SECRET_KEY =
  /auth|cookie|token|secret|passw|api.?key|account.?id|bearer|credential|jwt|session.?key|signature|private.?key/i

// Credentials as they appear inside text: an auth scheme and its token, a JWT
// (or any base64url JSON, `eyJ` being `{"`), a vendor API key, a cookie line,
// and `name=value` / `"name":"value"` pairs whose name says secret.
const SECRET_TEXT: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]+/gi, '$1$2[redacted]'],
  [/eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/g, '[redacted]'],
  [/\b(?:sk|rk|pk|sess)[-_][A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\b((?:set-)?cookie)(\s*[:=]\s*)[^\n]+/gi, '$1$2[redacted]'],
  [
    /\b((?:access|refresh|id|session)[_.-]?token|token|api[_-]?key|client[_-]?secret|secret|password|authorization|account[_-]?id)(["']?\s*[:=]\s*["']?)[^\s"'&;,]+/gi,
    '$1$2[redacted]',
  ],
]

// Strings are cut to this length, after they are scrubbed: a token cut in
// half would no longer match the patterns above.
const MAX_STRING = 2000
const SCAN_WINDOW = MAX_STRING + 16_384

function scrubText(value: string): string {
  let text = value.length > SCAN_WINDOW ? value.slice(0, SCAN_WINDOW) : value
  for (const [pattern, replacement] of SECRET_TEXT) text = text.replace(pattern, replacement)
  return text.length > MAX_STRING || value.length > SCAN_WINDOW
    ? `${text.slice(0, MAX_STRING)}...[truncated]`
    : text
}

export function scrubForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (typeof value === 'string') return scrubText(value)
  if (!value || typeof value !== 'object') return value
  // A body or a buffer is never written, only its size.
  if (ArrayBuffer.isView(value)) return `[${value.byteLength} bytes]`
  if (value instanceof Error) {
    const code = (value as NodeJS.ErrnoException).code
    return scrubForLog({ name: value.name, message: value.message, code }, depth)
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubForLog(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : scrubForLog(entry, depth + 1)
  }
  return out
}

function rotate(path: string, maxBytes: number, keep: number): void {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return
  }
  if (size < maxBytes) return
  rmSync(`${path}.${keep}`, { force: true })
  for (let index = keep - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${path}.${index}`, `${path}.${index + 1}`)
    } catch {}
  }
  renameSync(path, `${path}.1`)
}

// One line of at most MAX_LINE bytes: a file never passes its bound by more.
const MAX_LINE = 16 * 1024

function lineOf(level: string, event: string, data: Record<string, unknown>): string {
  const head = { ts: new Date().toISOString(), pid: process.pid, level, event }
  const line: Record<string, unknown> = { ...head }
  for (const [key, value] of Object.entries(scrubForLog(data) as Record<string, unknown>)) {
    if (!Object.hasOwn(head, key)) line[key] = value
  }
  const text = JSON.stringify(line)
  return `${text.length > MAX_LINE ? JSON.stringify({ ...head, truncated: true }) : text}\n`
}

export function createRouterLog(
  path: string,
  options: { maxBytes?: number; keep?: number } = {},
): RouterLog {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024
  const keep = Math.max(1, options.keep ?? 3)
  const write = (level: string, event: string, data: Record<string, unknown>) => {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      rotate(path, maxBytes, keep)
      appendFileSync(path, lineOf(level, event, data), { mode: 0o600 })
    } catch {}
  }
  return {
    path,
    info: (event, data = {}) => write('info', event, data),
    error: (event, data = {}) => write('error', event, data),
  }
}

function readTail(path: string, size: number, max: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const tail = Buffer.alloc(max)
    return tail.subarray(0, readSync(fd, tail, 0, max, size - max))
  } finally {
    closeSync(fd)
  }
}

// Keep the last `max` bytes of a file that another process holds open for
// appending (launchd's log): rewritten in place, so it stays the same inode.
// A symlink or anything but a plain file is left alone.
export function trimInPlace(path: string, max: number): void {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size <= max) return
    const tail = readTail(path, stat.size, max)
    truncateSync(path, 0)
    appendFileSync(path, tail)
  } catch {}
}

// Trims `path` now and every `everyMs` while the process runs.
export function keepTrimmed(path: string, max: number, everyMs: number): () => void {
  trimInPlace(path, max)
  const timer = setInterval(() => trimInPlace(path, max), everyMs)
  timer.unref()
  return () => clearInterval(timer)
}

// The launchd log the daemon keeps trimmed: ANYENGINE_LAUNCHD_LOG, only when
// it names a file directly in <root>/logs. Trimming rewrites a file, so a
// mistaken value must never reach any other file.
export function launchdLogOf(env: NodeJS.ProcessEnv, root: string): string | null {
  const named = (env.ANYENGINE_LAUNCHD_LOG ?? '').trim()
  if (!isAbsolute(named)) return null
  const inLogs = relative(enginePaths(root).logs, resolve(named))
  if (!inLogs || inLogs.startsWith('..') || isAbsolute(inLogs) || inLogs.includes('/')) return null
  return resolve(named)
}
