import { type BridgeCatalogModel, providerFor } from './bridge-instructions.mjs'
import { upstreamThreadInfoFrom } from './claude-project-guard.mjs'
import type { Route } from './codex-mux.mjs'
import type { CodexUpstream } from './codex-upstream.mjs'
import { applyCodexParams, claimPosture, type Posture, postureContext } from './posture.mjs'
import { routerServesClaude } from './router-link.mjs'
import { asRecord } from './rpc-shape.mjs'
import { claudeModelOptions, isCodexOpenAiModel } from './util.mjs'

export const MERGED_METHODS = new Set([
  'thread/list',
  'thread/loaded/list',
  'model/list',
  'config/read',
])
export const LOCAL_GLOBAL_METHODS = new Set(['mock/experimentalMethod'])
export const POSTURE_METHODS = new Set(['turn/start', 'thread/resume', 'thread/settings/update'])
export const INSTRUCTION_LIFECYCLE_METHODS = new Set([
  'thread/start',
  'thread/resume',
  'thread/fork',
])
export const MODEL_CHANGE_METHODS = new Set(['thread/settings/update', 'thread/metadata/update'])

// Child lifecycle metadata supplies cwd, model and policy for its own children.
export interface UpstreamThreadInfo {
  cwd: string | null
  model: string | null
  posture: Posture
}

export function isClaudeModelId(model: string): boolean {
  const id = model.trim().toLowerCase()
  if (!id) return false
  if (/^(claude|opus|sonnet|haiku|fable)/.test(id)) return true
  return claudeModelOptions().some((option) => option.id.toLowerCase() === id)
}

// Owner of a NEW thread by model id alone (no provider / title-thread
// exceptions): the rule `thread/start` applies, shared with the bridge so it
// can tell which creation path a spawned child takes.
export function routeForModel(model: string): Route {
  const id = model.trim()
  if (!id) return 'local'
  if (isCodexOpenAiModel(id)) return 'upstream'
  if (isClaudeModelId(id)) return routerServesClaude() ? 'upstream' : 'local'
  // grok-* threads are served by the local grok runtime (src/grok-runtime.mts).
  if (/^grok/i.test(id)) return 'local'
  return 'upstream'
}

export function upstreamModelsFrom(result: Record<string, unknown> | null): BridgeCatalogModel[] {
  const data = Array.isArray(result?.data) ? result.data : []
  return data
    .map((entry) => asRecord(entry))
    .filter((entry) => typeof entry.id === 'string' && entry.hidden !== true)
    .map((entry) => ({
      id: String(entry.id),
      displayName: typeof entry.displayName === 'string' ? entry.displayName : String(entry.id),
      provider: providerFor(String(entry.id)),
      isDefault: entry.isDefault === true,
    }))
}

// Deletion invalidates a read even if the same upstream id is announced again.
export class ModelReadOwnership {
  private readonly generations = new Map<string, number>()
  invalidate(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
  }
  capture(id: string, owned: () => boolean): () => boolean {
    const generation = this.generations.get(id) ?? 0
    return () => owned() && generation === (this.generations.get(id) ?? 0)
  }
}

// A null-model continuation must leave Claude's child when native proof lapses.
// The child's current selection wins over lifecycle metadata and global defaults.
export async function routedTurnModel(
  requested: string,
  upstreamId: string | null,
  upstream: Pick<CodexUpstream, 'request'>,
  threads: Map<string, UpstreamThreadInfo>,
  stillOwned: () => boolean = () => true,
): Promise<string | null> {
  if (requested || !upstreamId || routerServesClaude()) return requested
  try {
    const result = asRecord(await upstream.request('thread/read', { threadId: upstreamId }, 5000))
    if (!stillOwned()) return null
    const thread = asRecord(result.thread)
    if (thread.id !== upstreamId) return null
    const model = thread.model
    if (typeof model !== 'string' || !model.trim()) return null
    const prior = threads.get(upstreamId)
    const metadata = { ...result, ...thread, model }
    const info = upstreamThreadInfoFrom(metadata, prior?.posture)
    const cwd = info.cwd ?? prior?.cwd ?? null
    const answered = applyCodexParams(prior?.posture ?? info.posture, metadata)
    const posture = prior
      ? claimPosture(answered, prior.posture, postureContext(cwd ?? process.cwd()))
      : answered
    threads.set(upstreamId, { ...info, cwd, posture })
    return isClaudeModelId(model) ? model : ''
  } catch {
    return null
  }
}

export function routeThreadStart(params: Record<string, unknown>): Route {
  const model = typeof params.model === 'string' ? params.model : ''
  const provider = typeof params.modelProvider === 'string' ? params.modelProvider : ''
  const isTitleOrHelper =
    params.ephemeral === true ||
    params.threadSource === 'title_generation' ||
    params.threadSource === 'memory_consolidation'
  if (
    isTitleOrHelper &&
    (process.env.ANYENGINE_TITLE_ROUTE ?? '').trim().toLowerCase() === 'local'
  ) {
    // Free title shortcut: the local runtime answers structured summary
    // turns without spending ChatGPT quota, regardless of the model id.
    return 'local'
  }
  if (provider === 'claude-code' && !isClaudeModelId(model)) return 'local'
  return routeForModel(model)
}
