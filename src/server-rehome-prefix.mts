import { rehomePrompt } from './model-prompt.mjs'
import type { SessionStore } from './store.mjs'
import type { ThreadRecord } from './types.mjs'

// Consume carried history on the first non-summary turn after a switch.
export function applyRehomePrefix(
  store: Pick<SessionStore, 'updateRehomePrefix'>,
  thread: ThreadRecord,
  prompt: string,
  isSummary: boolean,
): string {
  const prefix = thread.rehomePrefix
  if (!prefix || isSummary) return prompt
  thread.rehomePrefix = null
  store.updateRehomePrefix(thread.id, null)
  return rehomePrompt(prefix, prompt)
}
