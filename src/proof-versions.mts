// Version probes never borrow a live Codex home, even for --version. On
// macOS, deny non-loopback network and every write outside this probe home.
import { execFileSync } from 'node:child_process'
import { lstatSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  bundledCodexCandidates,
  DEFAULT_CHATGPT_APP,
  isExecutableFile,
  resolveBundledCodex,
} from './bundled-codex.mjs'

// null means unreadable; this sentinel means a path was confirmed absent.
// Unknown versions must never match a proof. Private roots may be absent.
const ABSENT = 'absent'
const TTL = 30_000
const cached = new Map<string, { at: number; value: string | null }>()

function stampOf(path: string): string | null {
  try {
    const stat = statSync(path)
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  } catch {
    try {
      lstatSync(path)
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return ABSENT
    }
    return null
  }
}

function remember(path: string, read: () => string | null): string | null {
  const stamp = stampOf(path)
  if (stamp === null || stamp === ABSENT) return null
  const key = `${path}:${stamp}`
  const hit = cached.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.value
  let value: string | null = null
  try {
    value = read()
  } catch {}
  if (stampOf(path) !== stamp) return null // Replaced during the read/probe.
  if (cached.size >= 4) cached.clear()
  cached.set(key, { at: Date.now(), value })
  return value
}

export function appVersionCached(): string | null {
  const app = process.env.ANYENGINE_CHATGPT_APP || DEFAULT_CHATGPT_APP
  if (stampOf(app) === ABSENT) return ABSENT
  const plist = join(app, 'Contents/Info.plist')
  return remember(
    plist,
    () =>
      execFileSync(
        '/usr/bin/plutil',
        ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist],
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim() || null,
  )
}

export function codexVersionCached(): string | null {
  const fallback = process.env.CODEX_REAL?.trim() || ''
  const binary = resolveBundledCodex().path ?? (isExecutableFile(fallback) ? fallback : null)
  if (!binary) {
    const candidates = [
      process.env.ANYENGINE_REAL_CODEX,
      ...bundledCodexCandidates(),
      fallback,
    ].filter((path): path is string => !!path)
    return candidates.every((path) => stampOf(path) === ABSENT) ? ABSENT : null
  }
  return codexBinaryVersionCached(binary)
}

// The adapter passes its resolved executable; a missing selected child is unreadable.
export function codexBinaryVersionCached(binary: string): string | null {
  return remember(binary, () => probeVersion(binary))
}

function probeVersion(binary: string): string | null {
  if (process.platform !== 'darwin') return null
  const { isolatedCommand } = createRequire(import.meta.url)('../../scripts/lib/codex-probe.mjs')
  const result = isolatedCommand(binary, ['--version'], { timeoutMs: 2000 })
  return result.status === 0
    ? (result.stdout.match(/^codex-cli\s+(\d+\.\d+\.\d+[^\s]*)\s*$/m)?.[1] ?? null)
    : null
}
