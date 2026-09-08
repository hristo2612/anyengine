// Pure helpers for the grok runtime: the `grok agent stdio` wire (Agent Client
// Protocol JSON-RPC over stdio) reshaped into our RuntimeEvent surface, plus the
// argv / session-id / permission-option plumbing. Kept free of process state so
// the mapping is unit-testable without spawning anything.
//
// Wire shapes (verified against grok 1.0.x, `grok agent -m <model> stdio`):
//   -> initialize {protocolVersion:1, clientCapabilities}
//   -> session/new {cwd, mcpServers:[]}         <- {sessionId, models}
//   -> session/load {sessionId, cwd, mcpServers} <- {} after replaying history
//   -> session/prompt {sessionId, prompt:[{type:'text',text}]}
//   <- session/update {sessionId, update:{sessionUpdate: agent_message_chunk |
//        agent_thought_chunk | tool_call | tool_call_update | plan | ...}}
//   <- session/request_permission (id) {toolCall, options:[{optionId, kind}]}
//        -> {outcome:{outcome:'selected', optionId}}
//   <- prompt result {stopReason:'end_turn'|'cancelled'|..., _meta:{usage}}
//   -> session/cancel {sessionId} (notification)

import type { PermissionDecision, RuntimeEvent, RuntimeTurnContext } from './types.mjs'

export const GROK_SESSION_PREFIX = 'grok:'

export interface GrokAgentSpec {
  model: string | null
  effort: string | null
  alwaysApprove: boolean
}

export interface GrokPermissionOption {
  optionId: string
  kind: string
  name?: string
}

// Claude tool names the adapter treats as read-only: grok never needs the App's
// approval for these, mirroring jinn-pty / claude-p.
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'])

// grok tool identifiers (tool_call.title / _meta['x.ai/tool'].name / rawInput.variant)
// onto the Claude tool names server.mts already knows how to render as native
// Codex items (Bash -> commandExecution, Write/Edit -> fileChange, ...).
const TOOL_NAME_MAP: Record<string, string> = {
  run_terminal_command: 'Bash',
  bash: 'Bash',
  shell: 'Bash',
  terminal: 'Bash',
  write: 'Write',
  write_file: 'Write',
  create_file: 'Write',
  edit: 'Edit',
  edit_file: 'Edit',
  str_replace: 'Edit',
  str_replace_editor: 'Edit',
  multi_edit: 'MultiEdit',
  read: 'Read',
  read_file: 'Read',
  view: 'Read',
  view_file: 'Read',
  grep: 'Grep',
  search: 'Grep',
  glob: 'Glob',
  find: 'Glob',
  list_files: 'Glob',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  fetch: 'WebFetch',
  todo_write: 'TodoWrite',
}

export function isGrokModel(model: string | null | undefined): boolean {
  return /^grok([-_.]|$)/i.test((model ?? '').trim())
}

export function grokSessionIdFrom(value: string | null | undefined): string | null {
  if (!value || !value.startsWith(GROK_SESSION_PREFIX)) return null
  const id = value.slice(GROK_SESSION_PREFIX.length).trim()
  return id.length > 0 ? id : null
}

export function grokSessionIdFor(sessionId: string): string {
  return `${GROK_SESSION_PREFIX}${sessionId}`
}

export function grokAgentSpec(context: RuntimeTurnContext): GrokAgentSpec {
  return {
    model: context.model && isGrokModel(context.model) ? context.model : null,
    effort: normalizeGrokEffort(context.effort),
    alwaysApprove:
      context.approvalPolicy === 'never' || context.sandboxMode === 'danger-full-access',
  }
}

export function normalizeGrokEffort(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim().toLowerCase()
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max')
    return raw
  if (raw === 'minimal') return 'low'
  return null
}

// `grok agent [-m model] [--reasoning-effort e] [--always-approve] stdio`.
// The model/effort flags belong to the `agent` subcommand, not `stdio`.
export function buildGrokAgentArgs(spec: GrokAgentSpec, extraArgs: string[] = []): string[] {
  const args = ['agent', '--no-leader']
  if (spec.model) args.push('-m', spec.model)
  if (spec.effort) args.push('--reasoning-effort', spec.effort)
  if (spec.alwaysApprove) args.push('--always-approve')
  args.push(...extraArgs)
  args.push('stdio')
  return args
}

export function grokToolName(update: Record<string, unknown>): string {
  const meta = asRecord(asRecord(update._meta)['x.ai/tool'])
  const rawInput = asRecord(update.rawInput)
  const candidates = [meta.name, rawInput.variant, update.title, update.kind]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    const key = candidate.trim()
    const mapped = TOOL_NAME_MAP[key.toLowerCase()]
    if (mapped) return mapped
    if (/^[A-Z][A-Za-z0-9]*$/.test(key) && key !== 'Other') return key
  }
  return typeof update.title === 'string' && update.title ? update.title : 'grok_tool'
}

export function grokToolIsReadOnly(update: Record<string, unknown>, toolName: string): boolean {
  const meta = asRecord(asRecord(update._meta)['x.ai/tool'])
  if (meta.read_only === true) return true
  return READ_ONLY_TOOLS.has(toolName)
}

// The App's decision -> the grok option to select. `acceptForSession` prefers
// grok's own "don't ask again" option; declines always pick the one-shot reject
// so a later identical call can still be approved.
export function grokPermissionOutcome(
  decision: PermissionDecision['decision'],
  options: GrokPermissionOption[],
): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  const byKind = (kind: string) => options.find((option) => option.kind === kind)?.optionId
  if (decision === 'accept' || decision === 'acceptForSession') {
    const optionId =
      (decision === 'acceptForSession' ? byKind('allow_always') : undefined) ??
      byKind('allow_once') ??
      byKind('allow_always')
    if (optionId) return { outcome: 'selected', optionId }
    return { outcome: 'cancelled' }
  }
  if (decision === 'decline') {
    const optionId = byKind('reject_once') ?? byKind('reject_always')
    if (optionId) return { outcome: 'selected', optionId }
  }
  return { outcome: 'cancelled' }
}

export interface GrokToolCallInfo {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  readOnly: boolean
}

export function grokToolCallInfo(update: Record<string, unknown>): GrokToolCallInfo {
  const toolName = grokToolName(update)
  const rawInput = asRecord(update.rawInput)
  const input: Record<string, unknown> = { ...rawInput }
  // grok reports its shell call under `command`; that is also what
  // server.mts reads for commandExecution items. `variant` is grok-internal.
  delete input.variant
  return {
    toolUseId: stringOr(update.toolCallId) ?? stringOr(update.tool_call_id) ?? `grok-${Date.now()}`,
    toolName,
    input,
    readOnly: grokToolIsReadOnly(update, toolName),
  }
}

// One `session/update` notification -> zero or more RuntimeEvents. Tool
// results are only produced for terminal statuses (completed / failed); grok
// also streams `in_progress` updates with partial output which the App has no
// item for. Returns null for updates that carry nothing for the UI.
export function grokUpdateToEvents(
  update: Record<string, unknown>,
  seenToolNames: Map<string, string>,
): RuntimeEvent[] {
  const kind = String(update.sessionUpdate ?? '')
  switch (kind) {
    case 'agent_message_chunk': {
      const text = contentText(update.content)
      return text ? [{ type: 'text_delta', delta: text }] : []
    }
    case 'agent_thought_chunk': {
      const text = contentText(update.content)
      return text ? [{ type: 'reasoning_delta', delta: text }] : []
    }
    case 'tool_call': {
      const info = grokToolCallInfo(update)
      seenToolNames.set(info.toolUseId, info.toolName)
      return [
        { type: 'tool_use', toolUseId: info.toolUseId, toolName: info.toolName, input: info.input },
      ]
    }
    case 'tool_call_update': {
      const status = String(update.status ?? '').toLowerCase()
      const toolUseId = stringOr(update.toolCallId) ?? stringOr(update.tool_call_id)
      if (!toolUseId) return []
      if (!seenToolNames.has(toolUseId)) {
        // grok may open a call straight in `tool_call_update` (no `tool_call`
        // first) when the call was pre-approved; surface it once.
        const info = grokToolCallInfo(update)
        seenToolNames.set(toolUseId, info.toolName)
        const opened: RuntimeEvent[] = [
          { type: 'tool_use', toolUseId, toolName: info.toolName, input: info.input },
        ]
        return status === 'completed' || status === 'failed'
          ? [...opened, toolResultEvent(update, toolUseId, status)]
          : opened
      }
      if (status !== 'completed' && status !== 'failed') return []
      return [toolResultEvent(update, toolUseId, status)]
    }
    case 'plan': {
      const text = planText(update)
      return text ? [{ type: 'notice', level: 'info', message: text }] : []
    }
    default:
      return []
  }
}

function toolResultEvent(
  update: Record<string, unknown>,
  toolUseId: string,
  status: string,
): RuntimeEvent {
  const rawOutput = asRecord(update.rawOutput)
  const text =
    stringOr(rawOutput.output_for_prompt) ??
    toolContentText(update.content) ??
    stringOr(rawOutput.output) ??
    null
  const exitCode = typeof rawOutput.exit_code === 'number' ? rawOutput.exit_code : null
  return {
    type: 'tool_result',
    toolUseId,
    content: text,
    isError: status === 'failed' || (exitCode != null && exitCode !== 0),
  }
}

export function grokUsageFromPromptResult(result: Record<string, unknown>): {
  usage: Record<string, unknown> | null
  metrics: { apiDurationMs: number | null; numTurns: number | null } | null
} {
  const meta = asRecord(result._meta)
  const usage = asRecord(meta.usage)
  const pick = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = usage[key] ?? meta[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
    return null
  }
  const input = pick('inputTokens', 'input_tokens')
  const output = pick('outputTokens', 'output_tokens')
  if (input == null && output == null) return { usage: null, metrics: null }
  return {
    usage: {
      input_tokens: input ?? 0,
      cache_read_input_tokens: pick('cachedReadTokens', 'cache_read_input_tokens') ?? 0,
      cache_creation_input_tokens: pick('cacheCreationTokens', 'cache_creation_input_tokens') ?? 0,
      output_tokens: output ?? 0,
      reasoning_output_tokens: pick('reasoningTokens', 'reasoning_tokens') ?? 0,
    },
    metrics: {
      apiDurationMs: pick('apiDurationMs'),
      numTurns: pick('modelCalls'),
    },
  }
}

// grok has no per-session system prompt flag on `grok agent`, so the App's
// instructions ride the first prompt of a fresh session (same technique Jinn
// uses for its headless grok engine).
export function grokPromptText(context: RuntimeTurnContext, freshSession: boolean): string {
  const addendum = context.systemPromptAddendum?.trim()
  if (freshSession && addendum) return `${addendum}\n\n---\n\n${context.prompt}`
  return context.prompt
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  if (typeof record.text === 'string') return record.text
  return ''
}

// tool_call_update.content is a list of {type:'content', content:{type:'text',text}}
// or {type:'diff', path, oldText, newText} blocks.
function toolContentText(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const parts: string[] = []
  for (const entry of value) {
    const block = asRecord(entry)
    if (block.type === 'content') {
      const text = contentText(block.content)
      if (text) parts.push(text)
    } else if (block.type === 'diff') {
      const path = stringOr(block.path) ?? ''
      parts.push(`Updated ${path}`.trim())
    }
  }
  const joined = parts.join('').trim()
  return joined.length > 0 ? joined : null
}

function planText(update: Record<string, unknown>): string | null {
  const entries = Array.isArray(update.entries) ? update.entries : []
  const lines = entries
    .map((entry) => asRecord(entry))
    .map((entry) => stringOr(entry.content) ?? stringOr(entry.title))
    .filter((text): text is string => Boolean(text))
  return lines.length > 0 ? `Plan:\n- ${lines.join('\n- ')}` : null
}

export function stringOr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
