// GET /models (spec 5.2). The upstream catalog with the caller's own headers,
// plus one Claude entry per configured model, cloned from the highest-ranked
// listed upstream entry. On the native path every Claude entry ranks just after
// the default upstream model (so it falls inside the spawn tool's top-5 list:
// without that, "spawn one on Haiku" silently spawned GPT in the spike), the
// other entries move down by as many places, and v2 entries are marked v1.
// On the bridge path the upstream catalog goes back untouched (decision D6).
//
// Answers are cached per (upstream, query, account id), never per bearer, so
// an upstream outage serves the same client's last good list and a client
// with no cached list gets 503, never a partial catalog (claude-in-codex
// LEARNINGS, 2026-09-27). The cache file keeps at most 16 lists.
//
// Entry shape follows EthanSK/claude-in-codex (MIT)
// src/catalog.js @ e2adced; see THIRD_PARTY_NOTICES.md.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AnyEngineConfig, ClaudeModelEntry } from './anyengine-config.mjs'
import { writeJsonAtomic } from './anyengine-config.mjs'
import { headerValue } from './codex-wire.mjs'
import { fetchCatalog } from './router-catalog-fetch.mjs'
import type { FanoutMonitor, FanoutPath } from './router-fanout.mjs'
import type { RouterHooks } from './router-server.mjs'

export type CatalogEntry = Record<string, unknown> & { slug: string }

export const ANYENGINE_MARKER = 'via AnyEngine'

// The best-ranked listed upstream entry of the last catalog served. Claude
// housekeeping calls (titles and summaries) use it instead of starting Claude.
let lastDefaultGpt: string | null = null

export function defaultGptSlug(): string | null {
  return lastDefaultGpt
}

const EFFORT_LEVELS = [
  { effort: 'low', description: 'Fastest; light thinking' },
  { effort: 'medium', description: 'Balanced speed and depth' },
  { effort: 'high', description: 'Deeper thinking for harder tasks' },
  { effort: 'xhigh', description: 'Extra-deep thinking' },
  { effort: 'max', description: 'Maximum thinking budget' },
]

// Kept: `available_access_programs` and the other access fields, so the app
// filters a Claude entry exactly as it filters the GPT entry it was cloned
// from (availability_nux, a GPT notice, is set to null below).
const DROPPED_FIELDS = ['default_service_tier', 'auto_compact_token_limit', 'guardian']

export function isAnyEngineEntry(entry: unknown, claudeIds?: ReadonlySet<string>): boolean {
  if (!entry || typeof entry !== 'object') return false
  const record = entry as Record<string, unknown>
  if (typeof record.description === 'string' && record.description.includes(ANYENGINE_MARKER))
    return true
  return typeof record.slug === 'string' && claudeIds?.has(record.slug) === true
}

// A future upstream default need not be named gpt-*. Keep its exact access
// restrictions and rank when using it as the Claude template.
export function isCatalogTemplate(entry: unknown, config: AnyEngineConfig): entry is CatalogEntry {
  if (!entry || typeof entry !== 'object') return false
  const model = entry as CatalogEntry
  const ids = new Set(config.claude.models.map((m) => m.id))
  return (
    typeof model.slug === 'string' && model.visibility === 'list' && !isAnyEngineEntry(model, ids)
  )
}

export function orderedClaudeModels(config: AnyEngineConfig): ClaudeModelEntry[] {
  const byId = new Map(config.claude.models.map((m) => [m.id, m]))
  const first = config.claude.spawnPriority.flatMap((id) => byId.get(id) ?? [])
  return [
    ...first,
    ...config.claude.models.filter((m) => !config.claude.spawnPriority.includes(m.id)),
  ]
}

function priorityOf(entry: CatalogEntry): number {
  return typeof entry.priority === 'number' ? entry.priority : 0
}

function claudeEntry(
  template: CatalogEntry,
  model: ClaudeModelEntry,
  priority: number,
): CatalogEntry {
  const entry = structuredClone(template) as Record<string, unknown>
  for (const field of DROPPED_FIELDS) delete entry[field]
  Object.assign(entry, {
    slug: model.id,
    display_name: model.displayName,
    description: `${model.displayName}, on your Claude plan, ${ANYENGINE_MARKER}`,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: EFFORT_LEVELS,
    visibility: 'list',
    // supported_in_api stays as the template has it (a GPT entry of this very
    // catalog): forcing true could list a Claude entry where the GPT one is not.
    priority,
    upgrade: null,
    availability_nux: null,
    additional_speed_tiers: [],
    service_tiers: [],
    context_window: model.contextWindow,
    max_context_window: model.contextWindow,
    input_modalities: ['text', 'image'],
    supports_reasoning_effort_updates: false,
    use_responses_lite: false,
    multi_agent_version: 'v1',
  })
  return entry as CatalogEntry
}

export function mergeCatalog(
  upstream: CatalogEntry[],
  config: AnyEngineConfig,
  fanout: FanoutPath,
): CatalogEntry[] {
  if (fanout === 'bridge') return upstream
  const claudeIds = new Set(config.claude.models.map((m) => m.id))
  const gpt = upstream.filter((entry) => !isAnyEngineEntry(entry, claudeIds))
  const first =
    [...gpt]
      .filter((e) => isCatalogTemplate(e, config))
      .sort((a, b) => priorityOf(a) - priorityOf(b))[0] ?? null
  if (!first) return upstream
  const claude = orderedClaudeModels(config)
  const base = priorityOf(first)
  const shifted = gpt.map((entry) =>
    entry === first
      ? entry
      : { ...entry, priority: Math.max(priorityOf(entry), base + 1) + claude.length },
  )
  const added = claude.map((model, index) => claudeEntry(first, model, base + 1 + index))
  return [...shifted, ...added].map((entry) =>
    entry.multi_agent_version === 'v2' ? { ...entry, multi_agent_version: 'v1' } : entry,
  )
}

export function catalogKey(upstream: string, query: string, accountId: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify([upstream, query, accountId]))
    .digest('hex')
}

export function catalogEtag(
  upstreamEtag: string | null,
  config: AnyEngineConfig,
  fanout: FanoutPath,
): string {
  const extra = JSON.stringify([upstreamEtag, config.claude, config.router.multiAgentV1, fanout])
  return `"ae-${createHash('sha1').update(extra).digest('hex').slice(0, 16)}"`
}

export class CatalogCache {
  private readonly file: string
  private readonly max: number
  private entries: Record<string, { at: number; models: CatalogEntry[] }>

  constructor(file: string, max = 16) {
    this.file = file
    this.max = Math.max(1, Math.min(16, Math.floor(max) || 16))
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      this.entries = Object.fromEntries(
        Object.entries(parsed)
          .filter(
            (pair): pair is [string, { at: number; models: CatalogEntry[] }] =>
              /^[a-f0-9]{64}$/.test(pair[0]) && validCacheEntry(pair[1]),
          )
          .slice(-this.max),
      )
    } catch {
      this.entries = {}
    }
  }

  get(key: string): CatalogEntry[] | null {
    return this.entries[key]?.models ?? null
  }

  set(key: string, models: CatalogEntry[]): void {
    delete this.entries[key]
    this.entries[key] = { at: Date.now(), models: structuredClone(models) }
    const keys = Object.keys(this.entries).reverse()
    for (const stale of keys.slice(this.max)) delete this.entries[stale]
    try {
      writeJsonAtomic(this.file, this.entries)
    } catch {}
  }
}

export function modelsHook(
  cache: CatalogCache,
  fanout: FanoutMonitor,
): NonNullable<RouterHooks['models']> {
  return async (ctx, req, res, query) => {
    const key = catalogKey(ctx.upstream(), query, headerValue(req.headers, 'chatgpt-account-id'))
    const fetched = await fetchCatalog(ctx, req, res, query)
    if (res.destroyed) return
    if (fetched) cache.set(key, fetched.models)
    const models = fetched?.models ?? cache.get(key)
    if (!models) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: 'Model catalog unavailable; no cached catalog for this client.',
            type: 'server_error',
          },
        }),
      )
      return
    }
    fanout.observeCatalog(models)
    const config = ctx.config()
    lastDefaultGpt =
      models
        .filter((model) => isCatalogTemplate(model, config))
        .sort((a, b) => priorityOf(a) - priorityOf(b))[0]?.slug ?? lastDefaultGpt
    const path = fanout.state.path
    const contentKey = createHash('sha256').update(JSON.stringify(models)).digest('hex')
    const etag = catalogEtag(`${fetched?.etag ?? ''}:${contentKey}`, config, path)
    const merged = mergeCatalog(models, config, path)
    fanout.noteServed(
      merged
        .filter(
          (m) =>
            path === 'native' &&
            (m.multi_agent_version === 'v1' || m.multi_agent_version == null) &&
            !isAnyEngineEntry(m),
        )
        .map((m) => m.slug),
    )
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag })
      res.end()
      return
    }
    ctx.log.info('models.served', {
      fanout: path,
      total: merged.length,
      claude: merged.filter((m) => isAnyEngineEntry(m)).length,
      fromCache: !fetched,
    })
    res.writeHead(200, { 'content-type': 'application/json', etag })
    res.end(JSON.stringify({ models: merged }))
  }
}

function validCacheEntry(value: unknown): value is { at: number; models: CatalogEntry[] } {
  if (!value || typeof value !== 'object') return false
  const entry = value as { at?: unknown; models?: unknown }
  return (
    typeof entry.at === 'number' &&
    Array.isArray(entry.models) &&
    entry.models.every((m) => m && typeof m === 'object' && typeof m.slug === 'string')
  )
}
