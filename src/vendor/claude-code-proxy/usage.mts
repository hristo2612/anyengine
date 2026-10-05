// MIT port of raine v0.1.42 reducer.rs map_codex_usage_to_anthropic.
import type { Json, Obj } from './types.mjs'

function count(value: Json | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function mapUsage(usage: Obj): Obj {
  const details = usage.input_tokens_details
  const cached = count(
    details !== null && typeof details === 'object' && !Array.isArray(details)
      ? details.cached_tokens
      : undefined,
  )
  return {
    input_tokens: Math.max(0, count(usage.input_tokens) - cached),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: count(usage.output_tokens),
  }
}
