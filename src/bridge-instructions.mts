// Standing instructions and model aliases for the cross-engine bridge
// (docs/guide/bridge.md). One helper feeds all three engines: the Claude
// runtimes get it through the per-turn systemPromptAddendum
// (`--append-system-prompt`), Grok through the same addendum prefixed on the
// first prompt of a session (grok-acp#grokPromptText), and the native Codex
// child through `developerInstructions` on the forwarded thread/start
// (codex-mux). `CLAUDE_CODEX_BRIDGE_INSTRUCTIONS=0` turns the injection off.

import { isCodexOpenAiModel } from './util.mjs'

export type BridgeProvider = 'openai' | 'anthropic' | 'xai'

export interface BridgeCatalogModel {
  id: string
  displayName: string
  provider: BridgeProvider
  isDefault?: boolean
}

export const BRIDGE_INSTRUCTIONS_HEADING = '# Other engines available'
const MAX_IDS_PER_PROVIDER = 6

const PROVIDER_LABEL: Record<BridgeProvider, string> = {
  anthropic: 'Claude',
  xai: 'Grok',
  openai: 'GPT',
}
const PROVIDER_ORDER: BridgeProvider[] = ['anthropic', 'xai', 'openai']

// Words that name a whole engine rather than one model.
const FAMILY_WORDS: Record<string, BridgeProvider> = {
  claude: 'anthropic',
  anthropic: 'anthropic',
  grok: 'xai',
  xai: 'xai',
  gpt: 'openai',
  openai: 'openai',
  codex: 'openai',
  chatgpt: 'openai',
}
const NOISE_WORDS = new Set([
  'a',
  'an',
  'the',
  'model',
  'models',
  'engine',
  'agent',
  'agents',
  'with',
  'on',
  'via',
  'ai',
  'llm',
])

// Human-readable alias table, shared by the tool descriptions and the docs.
export const MODEL_ALIAS_TABLE =
  'Aliases (case-insensitive): "claude", "claude opus", "opus 5", "claude sonnet", "sonnet", "haiku", "fable", "grok", "grok 4.6", "grok 4.5", "gpt", "gpt 5.6", "codex", or any exact id / display name from list_models. Engine-only names ("claude", "grok", "gpt") pick that engine\'s default model.'

export function bridgeInstructionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLAUDE_CODEX_BRIDGE_INSTRUCTIONS ?? '').trim() !== '0'
}

export function providerFor(model: string): BridgeProvider {
  if (isCodexOpenAiModel(model)) return 'openai'
  if (/^grok/i.test(model)) return 'xai'
  return 'anthropic'
}

// The addendum every engine receives. Generated from the live catalog so the
// model sees real ids next to the names people use.
export function bridgeInstructions(catalog: BridgeCatalogModel[]): string {
  const lines = [
    BRIDGE_INSTRUCTIONS_HEADING,
    'You run inside the Codex desktop through the claude-codex adapter. The `anyengine` MCP tools start sessions and parallel sub-agents on the other engines from this thread:',
  ]
  for (const provider of PROVIDER_ORDER) {
    const entries = catalog.filter((model) => model.provider === provider)
    const label = PROVIDER_LABEL[provider]
    if (entries.length === 0) {
      if (provider === 'openai')
        lines.push(`- ${label}: not attached right now (native Codex child down); say so if asked.`)
      continue
    }
    const shown = entries
      .slice(0, MAX_IDS_PER_PROVIDER)
      .map((model) => `${model.displayName} (\`${model.id}\`)`)
    const more = entries.length - shown.length
    lines.push(
      `- ${label}: ${shown.join(', ')}${more > 0 ? `, and ${more} more (list_models)` : ''}`,
    )
  }
  lines.push(
    'When the user names one of these engines or models, or says spawn, delegate, hand off, ask X, or run in parallel, do it right away with anyengine: no confirmation, and do not mention tool names in your reply. Informal names work as `model` ("claude opus", "grok", "gpt"); the bridge maps them to catalog ids. Use spawn_subagents for several tasks or anything parallel (one task per agent, model per task) and spawn_session for a standalone conversation; send_to_session continues one. Relay each reply verbatim, labelled with its model, then answer the user.',
  )
  return lines.join('\n')
}

// Appends the addendum to an existing system-prompt / developer-instructions
// text; idempotent so a resend (thread/resume, per-turn overrides) never
// stacks two copies.
export function appendBridgeInstructions(
  existing: string | null | undefined,
  catalog: BridgeCatalogModel[],
): string {
  const base = (existing ?? '').trim()
  if (base.includes(BRIDGE_INSTRUCTIONS_HEADING)) return base
  const addendum = bridgeInstructions(catalog)
  return base ? `${base}\n\n${addendum}` : addendum
}

// ---- alias resolution ----------------------------------------------------

export class UnknownModelError extends Error {
  constructor(requested: string, catalog: BridgeCatalogModel[]) {
    super(
      `unknown model "${requested}"; available: ${catalog
        .map((m) => `${m.id} (${m.displayName})`)
        .join(', ')}`,
    )
    this.name = 'UnknownModelError'
  }
}

function tokensOf(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9.]+/g, ' ')
    .split(' ')
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
}

const isNumeric = (token: string): boolean => /\d/.test(token)

// "claude opus 5" -> opus, "grok" -> the first/default grok, "gpt 5.6" -> the
// default gpt-5.6-*, exact ids and display names first. Words must all match
// a token of the id or display name; numbers rank candidates (exact beats
// prefix beats absent) so "grok 4.5" is not lost to the default.
export function resolveModelAlias(requested: string, catalog: BridgeCatalogModel[]): string {
  const wanted = requested.trim()
  if (!wanted) throw new Error('model is required')
  const lower = wanted.toLowerCase()
  const exact = catalog.find((m) => m.id.toLowerCase() === lower)
  if (exact) return exact.id
  const byName = catalog.find((m) => m.displayName.toLowerCase() === lower)
  if (byName) return byName.id

  let provider: BridgeProvider | null = null
  const words: string[] = []
  const numbers: string[] = []
  for (const token of tokensOf(wanted)) {
    const family = FAMILY_WORDS[token]
    if (family) {
      provider = provider ?? family
      continue
    }
    if (NOISE_WORDS.has(token)) continue
    if (isNumeric(token)) numbers.push(token)
    else words.push(token)
  }
  const pool = provider ? catalog.filter((m) => m.provider === provider) : catalog
  if (pool.length === 0) throw new UnknownModelError(wanted, catalog)
  if (words.length === 0 && numbers.length === 0 && !provider)
    throw new UnknownModelError(wanted, catalog)

  const ranked = pool
    .map((model, index) => {
      const tokens = new Set([...tokensOf(model.id), ...tokensOf(model.displayName)])
      if (!words.every((word) => tokens.has(word))) return null
      let numberScore = 0
      for (const number of numbers) {
        if (tokens.has(number)) numberScore += 2
        else if ([...tokens].some((token) => isNumeric(token) && token.startsWith(number)))
          numberScore += 1
      }
      return { model, index, numberScore, extra: tokens.size }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort(
      (a, b) =>
        b.numberScore - a.numberScore ||
        Number(b.model.isDefault === true) - Number(a.model.isDefault === true) ||
        a.extra - b.extra ||
        a.index - b.index,
    )
  const best = ranked[0]
  if (!best) throw new UnknownModelError(wanted, catalog)
  return best.model.id
}
