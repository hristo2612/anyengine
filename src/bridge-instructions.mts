// One-line standing instructions and model aliases for the cross-engine bridge
// (docs/guide/bridge.md). One helper feeds all three engines: the Claude
// runtimes get it through the per-turn systemPromptAddendum
// (`--append-system-prompt`), Grok through the same addendum prefixed on the
// first prompt of a session (grok-acp#grokPromptText), and the native Codex
// child through `developerInstructions` on the forwarded thread/start
// (codex-mux). `ANYENGINE_BRIDGE_INSTRUCTIONS=0` turns the injection off.

import { grokModelOptions } from './grok-models.mjs'
import { asRecord } from './rpc-shape.mjs'
import type { JsonRpcRequest } from './types.mjs'
import { claudeModelOptions, codexProxyModelOptions, isCodexOpenAiModel } from './util.mjs'

export type BridgeProvider = 'openai' | 'anthropic' | 'xai'

export interface BridgeCatalogModel {
  id: string
  displayName: string
  provider: BridgeProvider
  isDefault?: boolean
}

// One standing line for claimed children and the bridge fallback (spec 3).
export const BRIDGE_LINE =
  'For sub-agents or sessions on another engine (Claude, GPT), use the anyengine tools spawn_subagents (parallel, one task and model per agent) or spawn_session.'
export const BRIDGE_LINE_GPT =
  "For Claude sub-agents use the anyengine spawn_subagents tool (one task and model per agent); Codex's own spawn_agent cannot start Claude in this session."
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
  return (env.ANYENGINE_BRIDGE_INSTRUCTIONS ?? '').trim() !== '0'
}

export function providerFor(model: string): BridgeProvider {
  if (isCodexOpenAiModel(model)) return 'openai'
  if (/^grok/i.test(model)) return 'xai'
  return 'anthropic'
}

export function bridgeInstructions(_catalog: BridgeCatalogModel[]): string {
  return BRIDGE_LINE
}

// Idempotent across resumes and per-turn overrides.
export function appendBridgeInstructions(
  existing: string | null | undefined,
  _catalog: BridgeCatalogModel[],
  line: string = BRIDGE_LINE,
): string {
  const base = (existing ?? '').trim()
  if (base.includes(line)) return base
  return base ? `${base}\n\n${line}` : line
}

export function bridgeInstructionParams(params: unknown, line: string | null): unknown {
  if (!line) return params
  const record = asRecord(params)
  const existing =
    typeof record.developerInstructions === 'string' ? record.developerInstructions : null
  return { ...record, developerInstructions: appendBridgeInstructions(existing, [], line) }
}

export function localModelOptions(defaultModel: string) {
  return [...claudeModelOptions(), ...codexProxyModelOptions(), ...grokModelOptions()].map(
    (option) => ({
      id: option.id,
      displayName: option.displayName,
      isDefault: option.id === defaultModel || option.isDefault === true,
    }),
  )
}

export function bridgeInstructionRequest(
  request: JsonRpcRequest,
  line: string | null,
): JsonRpcRequest {
  return { ...request, params: bridgeInstructionParams(request.params, line) }
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
