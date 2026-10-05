// Ported from EthanSK/claude-in-codex (MIT) src/codexInput.js @ e2adced, with changes; see THIRD_PARTY_NOTICES.md.
// Changes: TypeScript, `ae` prefixes (isBridgeItem is isRouterItem), parseCodexRequest and renderContextItem split (complexity gate), linear tag scans and surrogate-safe cuts (hostile input), claudePromptText, and isAgentTurn (src/server.js).

// Turns a Codex Responses request into what Claude Code needs:
// the new user prompt, context from other models, cwd, permissions, AGENTS.md, and
// where the last routed turn ended.
import { between, lastBetween, sliceEnd, sliceStart } from './safe-text.mjs'

export const MARKER_PREFIX = 'ae:v1:'
export const ROUTER_ID_PREFIXES: readonly string[] = [
  'msg_ae_',
  'rs_ae_',
  'ws_ae_',
  'cmp_ae_',
  'fc_ae_',
  'ctc_ae_',
  'resp_ae_',
]
// Router items that carry real conversation content (unlike markers and web search cards).
const ROUTER_CONTENT_TYPES = new Set(['message', 'function_call', 'custom_tool_call'])
// A crafted non-string `type` is never one (String() of it could throw).
const isContentType = (type: unknown) => typeof type === 'string' && ROUTER_CONTENT_TYPES.has(type)

const MAX_CONTEXT_CHARS = 60000
const MAX_TOOL_OUTPUT_CHARS = 2000

type Item = Record<string, unknown>

export type ClaudeImageBlock = {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string }
}

type Marker = { sid: string; turnId: string; index: number }

export interface ParsedCodexRequest {
  cwd: string | null
  sandboxMode: string | null
  planMode: boolean
  agentsMd: string[]
  marker: Marker | null
  resume: Marker | null
  hasCompactionTrigger: boolean
  skills: string | null
  codexMemory: string | null
  context: string
  promptText: string
  images: ClaudeImageBlock[]
}

function asItem(value: unknown): Item | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : null
}

function partsOf(item: Item | null): Item[] {
  if (!Array.isArray(item?.content)) return []
  return (item.content as unknown[]).map(asItem).filter((part): part is Item => part !== null)
}

export function makeMarker(sid: string, turnId: string): string {
  return `${MARKER_PREFIX}${sid}:${turnId}`
}

export function parseMarker(value: unknown): { sid: string; turnId: string } | null {
  if (typeof value !== 'string' || !value.startsWith(MARKER_PREFIX)) return null
  const [sid, turnId] = value.slice(MARKER_PREFIX.length).split(':')
  if (!sid || !turnId) return null
  return { sid, turnId }
}

export function isRouterItem(item: unknown): boolean {
  const it = asItem(item)
  if (!it) return false
  const id = it.id
  if (typeof id === 'string' && ROUTER_ID_PREFIXES.some((p) => id.startsWith(p))) return true
  return typeof it.encrypted_content === 'string' && it.encrypted_content.startsWith(MARKER_PREFIX)
}

function textOf(item: Item): string {
  if (!Array.isArray(item.content)) return typeof item.content === 'string' ? item.content : ''
  return partsOf(item)
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n')
}

const CONTEXT_TAG = /^\s*<([a-z][a-z0-9_]*)[\s>]/i

// Mirrors Codex's own "contextual user fragment" idea: injected context, not typed by the user.
export function classifyUserText(
  text: string,
): 'prompt' | 'context' | 'environment' | 'agents_md' | 'aborted' {
  const t = text.trimStart()
  if (t.startsWith('# AGENTS.md instructions')) return 'agents_md'
  const name = t.match(CONTEXT_TAG)?.[1]
  if (!name) return 'prompt'
  const tag = name.toLowerCase()
  if (!text.includes(`</${name}>`)) return 'prompt'
  if (tag === 'environment_context') return 'environment'
  if (tag === 'user_instructions') return 'agents_md'
  if (tag === 'turn_aborted') return 'aborted'
  if (tag === 'image') return 'prompt'
  if (tag === 'send_user_message_question_reply') return 'prompt' // The user's answer to a Codex question card is their own words, not injected context.
  return 'context'
}

export function lastMatch(text: string, re: RegExp): RegExpExecArray | null {
  let found: RegExpExecArray | null = null
  for (const m of text.matchAll(re)) found = m
  return found
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// The first <environment ...> tag marked primary="true" names the cwd.
function primaryCwd(span: string): string | undefined {
  let at = span.indexOf('<environment')
  while (at !== -1) {
    const end = span.indexOf('>', at)
    if (end === -1) return undefined
    if (span.slice(at, end).includes('primary="true"')) return between(span, '<cwd>', '</cwd>', end)
    at = span.indexOf('<environment', end)
  }
  return undefined
}

// The cwd, read by linear scans from the <environment_context> block alone (a
// real one is under 1 KB; at most 16 KB is read). The regex these replace,
// /<environment[^>]*primary="true"[^>]*>[\s\S]*?<cwd>([\s\S]*?)<\/cwd>/ then
// /<cwd>([\s\S]*?)<\/cwd>/, backtracked cubically on hostile input.
export function parseEnvironment(text: string): string | null {
  const start = Math.max(0, text.indexOf('<environment_context'))
  let span = text.slice(start, start + 16 * 1024)
  const close = span.indexOf('</environment_context>')
  if (close !== -1) span = span.slice(0, close)
  const cwd = primaryCwd(span) ?? between(span, '<cwd>', '</cwd>')
  return cwd ? unescapeXml(cwd.trim()) : null
}

function truncate(s: string, n: number): string {
  if (!s) return ''
  return s.length > n ? `${sliceStart(s, n)}\n… [truncated ${s.length - n} chars]` : s
}

function summarizeToolCall(item: Item): string {
  const name = item.name || item.type
  let args = item.arguments ?? item.input ?? item.action ?? ''
  if (typeof args !== 'string') args = JSON.stringify(args)
  return `[${String(name)} call] ${truncate(String(args), 600)}`
}

function outputText(item: Item): string {
  const out = item.output
  if (typeof out === 'string') return out
  if (Array.isArray(out)) return out.map((c) => asItem(c)?.text || '').join('\n')
  if (out && typeof out === 'object') {
    const content = (out as Item).content
    return String(content ?? JSON.stringify(out))
  }
  return ''
}

function imageBlock(c: Item): ClaudeImageBlock | null {
  const url = c.image_url
  if (typeof url !== 'string') return null
  const m = url.match(/^data:([^;,]+);base64,(.*)$/s)
  if (m?.[1] && m[2] !== undefined) {
    return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
  }
  if (/^https?:\/\//.test(url)) return { type: 'image', source: { type: 'url', url } }
  return null
}

function renderUserContext(item: Item): string | null {
  const parts: string[] = []
  for (const c of partsOf(item)) {
    if (c.type === 'input_text' && typeof c.text === 'string') {
      const kind = classifyUserText(c.text)
      if (kind === 'prompt') parts.push(`User:\n${c.text}`)
      else if (kind === 'aborted') parts.push('(The user interrupted that turn.)')
      else if (kind === 'context') parts.push(c.text.trim())
    } else if (c.type === 'input_image') {
      parts.push('User: [attached an image]')
    }
  }
  return parts.length ? parts.join('\n') : null
}

// Renders one non-prompt item as a context line; null = skip.
function renderContextItem(item: Item): string | null {
  if (item.type === 'message') {
    if (item.role === 'assistant') {
      const t = textOf(item).trim()
      return t ? `Assistant (earlier in this Codex thread):\n${t}` : null
    }
    if (item.role === 'user') return renderUserContext(item)
    return null
  }
  switch (item.type) {
    case 'function_call':
    case 'custom_tool_call':
    case 'local_shell_call':
    case 'tool_search_call':
      return summarizeToolCall(item)
    case 'function_call_output':
    case 'custom_tool_call_output':
      return `[tool output] ${truncate(outputText(item), MAX_TOOL_OUTPUT_CHARS)}`
    case 'web_search_call':
      return `[web search] ${JSON.stringify(item.action || {})}`
    case 'compaction':
    case 'context_compaction':
      return '(Earlier parts of this Codex thread were compacted by another model.)'
    default:
      return null
  }
}

function isPromptMessage(value: unknown): boolean {
  const item = asItem(value)
  if (item?.type !== 'message' || item.role !== 'user' || isRouterItem(item)) return false
  return partsOf(item).some(
    (c) =>
      c.type === 'input_image' ||
      (c.type === 'input_text' &&
        typeof c.text === 'string' &&
        classifyUserText(c.text) === 'prompt'),
  )
}

interface ItemScan {
  cwd: string | null
  sandboxMode: string | null
  planMode: boolean
  agentsMd: string[]
  marker: Marker | null
  hasCompactionTrigger: boolean
  skills: string | null
  codexMemory: string | null
}

const MEMORY_END = '========= MEMORY_SUMMARY ENDS ========='

function scanUserText(scan: ItemScan, text: string): void {
  const kind = classifyUserText(text)
  if (kind === 'environment') scan.cwd = parseEnvironment(text) || scan.cwd
  if (kind === 'agents_md') {
    if (text.includes('previously provided AGENTS.md instructions no longer apply')) {
      scan.agentsMd = []
    } else scan.agentsMd.push(text.trim())
  }
}

function scanDeveloperText(scan: ItemScan, text: string): void {
  // Codex's skill catalog (names, descriptions, SKILL.md paths): hand it to Claude too.
  const sk = between(text, '<skills_instructions>', '</skills_instructions>')
  if (sk !== undefined) scan.skills = `<skills_instructions>${sk}</skills_instructions>`
  const memoryStart = text.indexOf('## Memory\n')
  const memoryEnd = text.indexOf(MEMORY_END, memoryStart)
  if (memoryStart !== -1 && memoryEnd !== -1) {
    scan.codexMemory = text.slice(memoryStart, memoryEnd + MEMORY_END.length)
  }
  const sm = lastMatch(text, /`sandbox_mode` is `([a-z-]+)`/g)
  if (sm?.[1]) scan.sandboxMode = sm[1]
  const collab = lastBetween(text, '<collaboration_mode>', '</collaboration_mode>')
  if (collab !== undefined) scan.planMode = /#\s*Plan Mode|mode is plan/i.test(collab)
}

// Step 1: what every item says about the thread (cwd, sandbox mode, plan mode,
// AGENTS.md, the last marker, skills, memory).
function scanItems(input: unknown[]): ItemScan {
  const scan: ItemScan = {
    cwd: null,
    sandboxMode: null,
    planMode: false,
    agentsMd: [],
    marker: null,
    hasCompactionTrigger: false,
    skills: null,
    codexMemory: null,
  }
  input.forEach((value, index) => {
    const item = asItem(value)
    if (item?.type === 'compaction_trigger') scan.hasCompactionTrigger = true
    const m = parseMarker(item?.encrypted_content)
    if (m) scan.marker = { ...m, index }
    if (item?.type !== 'message') return
    const role = item.role
    for (const c of partsOf(item)) {
      if (typeof c.text !== 'string') continue
      const text = c.text
      if (role === 'user') scanUserText(scan, text)
      if (role === 'developer' || role === 'system') scanDeveloperText(scan, text)
      if (role === 'user' && text.includes('<environment_context>')) {
        scan.cwd = parseEnvironment(text) || scan.cwd
      }
    }
  })
  return scan
}

// Step 2: the prompt is the trailing run of user prompt messages; everything
// earlier is context.
function promptStartOf(items: unknown[]): number {
  let promptStart = items.length
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (isPromptMessage(it)) {
      promptStart = i
      continue
    }
    const item = asItem(it)
    if (item?.type === 'message' && item.role !== 'assistant' && !isRouterItem(item)) continue // context fragments between prompts
    if (item?.type === 'reasoning' || item?.type === 'compaction_trigger') continue
    break
  }
  return promptStart
}

// Step 3: the prompt's texts and images; context fragments inside it go to
// contextLines.
function collectPrompt(
  items: unknown[],
  contextLines: string[],
): { promptTexts: string[]; images: ClaudeImageBlock[] } {
  const promptTexts: string[] = []
  const images: ClaudeImageBlock[] = []
  for (const it of items) {
    const item = asItem(it)
    if (item?.type !== 'message' || item.role !== 'user') continue
    for (const c of partsOf(item)) {
      if (c.type === 'input_text' && typeof c.text === 'string') {
        const kind = classifyUserText(c.text)
        if (kind === 'prompt') promptTexts.push(c.text)
        else if (kind === 'context') contextLines.push(c.text.trim())
        else if (kind === 'aborted') contextLines.push('(The user interrupted the previous turn.)')
      } else if (c.type === 'input_image') {
        const block = imageBlock(c)
        if (block) images.push(block)
      }
    }
  }
  return { promptTexts, images }
}

/**
 * @param body Responses API request body from Codex
 * @param isLatestTurn whether a marker's turn is its session's latest
 */
export function parseCodexRequest(
  body: Record<string, unknown>,
  isLatestTurn: (sid: string, turnId: string) => boolean = () => false,
): ParsedCodexRequest {
  const input = Array.isArray(body.input) ? (body.input as unknown[]) : []
  const scan = scanItems(input)

  // Keep only the latest AGENTS.md block per source (Codex re-sends on change).
  const agentsMd = dedupeAgents(scan.agentsMd)

  const marker = scan.marker
  const resume = marker && isLatestTurn(marker.sid, marker.turnId) ? marker : null
  const newItems = resume ? input.slice(resume.index + 1) : input
  const promptStart = promptStartOf(newItems)

  const contextLines: string[] = []
  for (const it of newItems.slice(0, promptStart)) {
    const item = asItem(it)
    if (!item) continue
    if (isRouterItem(item) && !isContentType(item.type)) continue // A fresh session still needs earlier Claude replies and Codex tool calls; only router control items are omitted.
    const line = renderContextItem(item)
    if (line) contextLines.push(line)
  }

  const { promptTexts, images } = collectPrompt(newItems.slice(promptStart), contextLines)

  let context = contextLines.join('\n\n')
  if (context.length > MAX_CONTEXT_CHARS) context = `…\n${sliceEnd(context, MAX_CONTEXT_CHARS)}`

  return {
    cwd: scan.cwd,
    sandboxMode: scan.sandboxMode,
    planMode: scan.planMode,
    agentsMd,
    marker,
    resume,
    hasCompactionTrigger: scan.hasCompactionTrigger,
    skills: scan.skills,
    codexMemory: scan.codexMemory,
    context,
    promptText: promptTexts.join('\n\n'),
    images,
  }
}

// Codex sends the full AGENTS.md block once and a full replacement when it changes,
// so the newest block is the one in force.
function dedupeAgents(blocks: string[]): string[] {
  const newest = blocks.at(-1)
  if (newest === undefined) return []
  const latest = newest.replace(
    /These AGENTS\.md instructions replace all previously provided AGENTS\.md instructions\.\s*/,
    '',
  )
  return [latest]
}

// The text Claude is given for this turn: the prompt, after any context it has
// not seen. The claim path sends only this; buildClaudeUserMessage adds images.
export function claudePromptText(
  parsed: ParsedCodexRequest,
  options: { newSession: boolean },
): string {
  let text = parsed.promptText
  if (parsed.context) {
    const intro = options.newSession
      ? 'Conversation so far in this Codex thread (before you joined, or from a point you have not seen):'
      : 'What happened in this Codex thread since your last turn (another model or Codex itself):'
    text = `<codex_context>\n${intro}\n\n${parsed.context}\n</codex_context>\n\n${text || '(continue)'}`
  }
  if (!text && !parsed.images.length) text = '(continue)'
  return text
}

export function buildClaudeUserMessage(
  parsed: ParsedCodexRequest,
  options: { newSession: boolean },
): Record<string, unknown> {
  const text = claudePromptText(parsed, options)
  const content: Array<Record<string, unknown>> = []
  if (text) content.push({ type: 'text', text })
  content.push(...parsed.images)
  return { type: 'user', message: { role: 'user', content } }
}

// For GPT-bound requests: remove router-only items OpenAI can't accept.
export function sanitizeInputForOpenAI(input: unknown): { input: unknown; changed: boolean } {
  if (!Array.isArray(input)) return { input, changed: false }
  let changed = false
  const out: unknown[] = []
  for (const value of input as unknown[]) {
    const item = asItem(value)
    if (!item || !isRouterItem(item)) {
      out.push(value)
      continue
    }
    changed = true
    if (isContentType(item.type)) {
      // Keep Claude's replies and Codex tool calls (their outputs refer to them); only the router-made id is dropped.
      const { id: _id, ...rest } = item
      out.push(rest)
    } else if (item.type === 'compaction') {
      out.push({
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '<external_context>Earlier turns in this thread were handled by Claude and then compacted; their details are not available here.</external_context>',
          },
        ],
      })
    }
    // reasoning / web_search_call markers are dropped
  }
  return { input: out, changed }
}

// A real Codex agent turn (vs. a housekeeping call like title generation).
// Tools arrive either in `tools` or, in Codex's "responses-lite" shape, as an
// `additional_tools` input item; agent turns also always carry <environment_context>.
// The router's Claude entries are not responses-lite, so their turns carry
// `tools`. A WebSocket prewarm (`generate: false`, empty input) may carry them
// too: the caller answers it before asking this.
export function isAgentTurn(body: Record<string, unknown>): boolean {
  if (Array.isArray(body.tools) && body.tools.length > 0) return true
  const input = Array.isArray(body.input) ? (body.input as unknown[]) : []
  return input.some((value) => {
    const i = asItem(value)
    return (
      i?.type === 'additional_tools' ||
      i?.type === 'compaction_trigger' ||
      (i?.type === 'message' &&
        partsOf(i).some(
          (c) => typeof c.text === 'string' && c.text.includes('<environment_context>'),
        ))
    )
  })
}
