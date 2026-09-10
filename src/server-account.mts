// Account-shaped answers: the rate-limit snapshot, the conversation summary
// the desktop asks for when it lists sessions, and the per-thread token meter.
//
// The tracker only accumulates and returns what to send; the protocol layer
// still owns the notification, so nothing here needs a peer.

import {
  emptyTokenBreakdown,
  normalizeSessionSource,
  stringOr,
  tokenBreakdownFromClaudeUsage,
} from './server-helpers.mjs'
import type { SessionStore } from './store.mjs'
import type { ThreadTokenUsage, TokenUsageBreakdown } from './types.mjs'
import { codexCliVersion } from './util.mjs'

// The adapter has no real rate-limit data: the Anthropic SDK exposes no
// headers for it. This is the empty-but-well-shaped snapshot the App needs at
// handshake so its usage meter renders instead of erroring.
export function accountRateLimitsPayload(): unknown {
  const rateLimits = {
    limitId: 'claude-code',
    limitName: 'Claude Code',
    primary: null,
    secondary: null,
    credits: null,
    planType: null,
    rateLimitReachedType: null,
  }
  return { rateLimits, rateLimitsByLimitId: { 'claude-code': rateLimits } }
}

export function conversationSummary(store: SessionStore, params: Record<string, unknown>): unknown {
  const threadId = stringOr(params.conversationId, '')
  const thread = store.getThread(threadId) ?? store.listThreads({ limit: 1 }).at(0)
  const now = new Date().toISOString()
  return {
    summary: {
      conversationId: thread?.id ?? threadId,
      path: '',
      preview: thread?.preview ?? '',
      timestamp: now,
      updatedAt: now,
      modelProvider: thread?.modelProvider ?? 'claude-code',
      cwd: thread?.cwd ?? process.cwd(),
      cliVersion: codexCliVersion(),
      source: normalizeSessionSource(thread?.source),
      gitInfo: null,
    },
  }
}

/** Running Claude Agent SDK token usage, per thread. */
export class TokenUsageTracker {
  private readonly byThread = new Map<string, TokenUsageBreakdown>()

  forget(threadId: string): void {
    this.byThread.delete(threadId)
  }

  // Returns what `thread/tokenUsage/updated` should carry, or null when this
  // event reported nothing — an empty turn must not blank the App's meter.
  //
  // Deliberately does NOT also produce an `account/rateLimits/updated`. That
  // used to fire here "to keep the UI in sync" and backfired: Codex App treats
  // every such notification as a fresh rate-limit signal and pops a transient
  // warning banner, so the user saw one on every assistant turn — carrying no
  // real data, since the SDK exposes no rate-limit headers. The initial
  // snapshot still fires once post-handshake in `initialize`.
  record(threadId: string, usage: Record<string, unknown>): ThreadTokenUsage | null {
    const last = tokenBreakdownFromClaudeUsage(usage)
    if (last.totalTokens === 0) return null
    const prior = this.byThread.get(threadId) ?? emptyTokenBreakdown()
    const total: TokenUsageBreakdown = {
      totalTokens: prior.totalTokens + last.totalTokens,
      inputTokens: prior.inputTokens + last.inputTokens,
      cachedInputTokens: prior.cachedInputTokens + last.cachedInputTokens,
      outputTokens: prior.outputTokens + last.outputTokens,
      reasoningOutputTokens: prior.reasoningOutputTokens + last.reasoningOutputTokens,
    }
    this.byThread.set(threadId, total)
    return { total, last, modelContextWindow: null }
  }
}
