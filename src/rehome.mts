import { isGrokModel } from './grok-acp.mjs'
import { isCodexOpenAiModel, textFromInput } from './util.mjs'

// Mid-thread engine switching ("re-homing").
//
// The desktop keeps ONE thread while the user moves its model picker between
// engines. Routing is decided per TURN from `turn/start.model`; when the
// resolved engine differs from the one that currently owns the thread, the
// thread is handed over to the new engine with a compact transcript of the
// conversation so far, so the answer stays continuous.
//
// This module is the pure half: which engine a model id belongs to, how a
// transcript is distilled out of thread items (local `TurnRecord`s and the
// upstream child's `thread/read` turns share the item shape), and how it is
// trimmed and framed. The wiring lives in src/codex-mux.mts (anything that
// crosses the upstream boundary) and src/server.mts (Claude <-> Grok, which
// never leaves the local layer).

export type Engine = 'claude' | 'grok' | 'gpt'

export const REHOME_HEADER = 'Conversation so far, continued from another model:'
export const REHOME_TRIM_NOTE = '[earlier turns trimmed]'

// Default cap for the whole transcript block, overridable with
// ANYENGINE_REHOME_MAX_CHARS. Past it the first user message and the tail are
// kept (see `formatTranscript`).
export const REHOME_DEFAULT_MAX_CHARS = 12_000
// Share of the cap spent on the tail when trimming.
const REHOME_TAIL_RATIO = 2 / 3

export interface TranscriptEntry {
  role: 'user' | 'assistant'
  text: string
}

// The engine that owns a turn on this model. Anything that is not an OpenAI
// Codex id and not grok-* is served by the Claude runtime, which is also what
// `routeForModel` assumes for unknown local ids.
export function engineForModel(model: string | null | undefined): Engine {
  const id = (model ?? '').trim()
  if (!id) return 'claude'
  if (isCodexOpenAiModel(id)) return 'gpt'
  if (isGrokModel(id)) return 'grok'
  return 'claude'
}

export function rehomeMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt((env.ANYENGINE_REHOME_MAX_CHARS ?? '').trim(), 10)
  if (!Number.isFinite(raw) || raw <= 0) return REHOME_DEFAULT_MAX_CHARS
  return raw
}

// Turns from either side: local `TurnRecord`s or the `Turn` objects inside an
// upstream `thread/read` answer. Both carry `items` with the same
// `userMessage` / `agentMessage` shape, so one extractor serves both.
export function transcriptEntriesFromTurns(turns: unknown): TranscriptEntry[] {
  if (!Array.isArray(turns)) return []
  const entries: TranscriptEntry[] = []
  for (const turn of turns) {
    const items = (turn as { items?: unknown })?.items
    if (!Array.isArray(items)) continue
    for (const raw of items) {
      const entry = transcriptEntryFromItem(raw)
      if (entry) entries.push(entry)
    }
  }
  return entries
}

// Tool calls, reasoning, plans, diffs and image views are deliberately
// dropped: the next engine needs what was said, not how it was produced.
function transcriptEntryFromItem(item: unknown): TranscriptEntry | null {
  if (!item || typeof item !== 'object') return null
  const record = item as { type?: unknown; text?: unknown; content?: unknown }
  if (record.type === 'userMessage') {
    const text = textFromInput(record.content).trim()
    return text ? { role: 'user', text } : null
  }
  if (record.type === 'agentMessage') {
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    return text ? { role: 'assistant', text } : null
  }
  return null
}

// The block handed to the next engine. Null when there is nothing to carry
// over (a thread whose first turn is the switch itself).
export function formatTranscript(
  entries: TranscriptEntry[],
  maxChars = rehomeMaxChars(),
): string | null {
  if (entries.length === 0) return null
  const lines = entries.map((entry) => `${entry.role}: ${entry.text}`)
  const body = lines.join('\n\n')
  if (body.length <= maxChars) return `${REHOME_HEADER}\n\n${body}`
  // Over the cap: keep the first user message (it usually carries the task)
  // and the most recent exchanges, with a note about the gap in between.
  const firstUser = lines.find((line) => line.startsWith('user: ')) ?? lines[0] ?? ''
  const head = firstUser.slice(0, Math.max(0, maxChars - Math.floor(maxChars * REHOME_TAIL_RATIO)))
  const tail = body.slice(-Math.floor(maxChars * REHOME_TAIL_RATIO))
  return [REHOME_HEADER, '', head, '', REHOME_TRIM_NOTE, '', tail].join('\n')
}

// One raw Responses API item for `thread/inject_items`, so the upstream child
// sees the carried-over conversation as model-visible history instead of a
// giant user turn in the transcript. The adapter falls back to prefixing the
// first turn's input when the child refuses the injection.
export function injectItemsFor(transcript: string): unknown[] {
  return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: transcript }] }]
}
