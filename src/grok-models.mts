// Grok model catalog + binary discovery for the Codex App model picker.
// Picking any of these ids flips the thread's turns to the `grok` runtime
// (see grok-runtime.mts); the ids are the ones `grok models` prints.

import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isGrokModel } from './grok-acp.mjs'

export interface GrokModelOption {
  id: string
  sdkModel: string | null
  displayName: string
  description: string
  isDefault?: boolean
}

const FALLBACK_GROK_MODELS = ['grok-4.6', 'grok-4.5']
const GROK_DESCRIPTION = 'xAI Grok Build CLI (forwarded via `grok agent stdio`).'
const CATALOG_TTL_MS = 5 * 60_000

let cachedDiscovered: { expiresAt: number; ids: string[] } | null = null

export function resolveGrokBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ANYENGINE_GROK_BIN ?? env.GROK_BIN
  if (explicit && explicit.trim()) return explicit.trim()
  const candidates = [
    ...(env.PATH ?? '')
      .split(':')
      .filter(Boolean)
      .map((dir) => join(dir, 'grok')),
    join(homedir(), '.local/bin/grok'),
    '/opt/homebrew/bin/grok',
    '/usr/local/bin/grok',
  ]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

// 'grok-4.6' -> 'Grok 4.6', 'grok-code-fast-1' -> 'Grok Code Fast 1'.
export function grokModelDisplayName(id: string): string {
  const rest = id.replace(/^grok[-_]?/i, '')
  if (!rest) return 'Grok'
  const words = rest
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  return `Grok ${words.join(' ')}`
}

export function parseGrokModelsOutput(output: string): string[] {
  const ids: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const id = /^\s*[*-]\s+(\S+)/.exec(line)?.[1]
    if (id && isGrokModel(id) && !ids.includes(id)) ids.push(id)
  }
  return ids
}

// Suppressed in mock mode (protocol tests assume a Claude-only picker) and
// when no grok binary is resolvable, unless ANYENGINE_GROK_MODELS names the
// models explicitly. Set ANYENGINE_DISABLE_GROK=1 to hide them entirely.
export function grokModelOptions(env: NodeJS.ProcessEnv = process.env): GrokModelOption[] {
  if (env.ANYENGINE_DISABLE_GROK === '1') return []
  const configured = env.ANYENGINE_GROK_MODELS?.trim()
  if (configured) return parseConfiguredModels(configured)
  if (env.ANYENGINE_MOCK === '1') return []
  const binary = resolveGrokBinary(env)
  if (!binary) return []
  return discoverGrokModels(binary).map((id) => grokModelOption(id))
}

function parseConfiguredModels(configured: string): GrokModelOption[] {
  try {
    const parsed = JSON.parse(configured)
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => {
          if (typeof entry === 'string') return grokModelOption(entry)
          if (entry && typeof entry === 'object') {
            const record = entry as Record<string, unknown>
            const id = typeof record.id === 'string' ? record.id : String(record.model ?? '')
            if (!id) return null
            return {
              id,
              sdkModel: id,
              displayName:
                typeof record.displayName === 'string'
                  ? record.displayName
                  : grokModelDisplayName(id),
              description:
                typeof record.description === 'string' ? record.description : GROK_DESCRIPTION,
              isDefault: record.isDefault === true,
            }
          }
          return null
        })
        .filter((entry): entry is GrokModelOption => entry !== null)
    }
  } catch {}
  return configured
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((id) => grokModelOption(id))
}

function discoverGrokModels(binary: string): string[] {
  const now = Date.now()
  if (cachedDiscovered && cachedDiscovered.expiresAt > now) return cachedDiscovered.ids
  let ids: string[] = []
  try {
    const output = execFileSync(binary, ['models'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, OTEL_SDK_DISABLED: 'true' },
    })
    ids = parseGrokModelsOutput(output)
  } catch {}
  if (ids.length === 0) ids = FALLBACK_GROK_MODELS
  cachedDiscovered = { expiresAt: now + CATALOG_TTL_MS, ids }
  return ids
}

function grokModelOption(id: string): GrokModelOption {
  return {
    id,
    sdkModel: id,
    displayName: grokModelDisplayName(id),
    description: GROK_DESCRIPTION,
    isDefault: false,
  }
}
