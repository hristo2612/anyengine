// Ported from EthanSK/claude-in-codex (MIT) src/claudeRunner.js @ e2adced, with changes; see THIRD_PARTY_NOTICES.md.
// Changes: typed event context, split dispatch for complexity, Codex-only MCP display suppression.
import { type ResponsesStream, usageObject, type WebSearchHandle } from './responses-stream.mjs'
import { describeToolError, describeToolUse } from './tool-display.mjs'

type Event = Record<string, any>
interface Tool {
  name: string
  description?: string
  web?: WebSearchHandle | null
}
export interface TrampolineEvents {
  sid: string | null
  cwd: string
  streamedMessageIds: Set<string>
  thinkingOpen: boolean
  tools: Map<string, Tool>
  planMode: boolean
  lastUsage: Event | null
  result: Event | null
}
export function eventContext(sid: string | null, cwd: string, planMode = false): TrampolineEvents {
  return {
    sid,
    cwd,
    streamedMessageIds: new Set(),
    thinkingOpen: false,
    tools: new Map(),
    planMode,
    lastUsage: null,
    result: null,
  }
}
export function usageSoFar(ctx: TrampolineEvents): Record<string, unknown> {
  const u = ctx.lastUsage ?? {}
  return usageObject({
    input:
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0),
    cached: u.cache_read_input_tokens || 0,
    output: ctx.result?.usage?.output_tokens ?? u.output_tokens ?? 0,
  })
}
export function finishWebSearches(ctx: TrampolineEvents, stream: ResponsesStream): void {
  for (const entry of ctx.tools.values()) {
    if (entry.web) {
      stream.webSearchDone(entry.web)
      entry.web = null
    }
  }
}
function partial(ev: Event, ctx: TrampolineEvents, stream: ResponsesStream): void {
  const e = ev.event ?? {}
  if (e.type === 'message_start') {
    if (e.message?.id) ctx.streamedMessageIds.add(e.message.id)
  } else if (e.type === 'content_block_start') {
    const b = e.content_block ?? {}
    if (b.type === 'thinking') ctx.thinkingOpen = true
    else if (b.type === 'tool_use' || b.type === 'server_tool_use') stream.closeOpen('commentary')
  } else if (e.type === 'content_block_delta') {
    const d = e.delta ?? {}
    if (d.type === 'text_delta' && !ctx.planMode) stream.textDelta(d.text)
    else if (d.type === 'thinking_delta') stream.reasoningDelta(d.thinking)
  } else if (e.type === 'content_block_stop' && ctx.thinkingOpen) {
    ctx.thinkingOpen = false
    stream.closeOpen('commentary')
  }
}
function toolUse(block: Event, ctx: TrampolineEvents, stream: ResponsesStream): void {
  if (ctx.tools.has(block.id)) return
  const entry: Tool = { name: block.name, description: block.input?.description }
  ctx.tools.set(block.id, entry)
  if (entry.name.startsWith('mcp__codex__')) return
  const shown = describeToolUse(block, ctx.cwd)
  if (!shown) return
  if (shown.kind === 'web') entry.web = stream.webSearchStart(shown.action)
  else if (shown.kind === 'plan') return
  else stream.reasoning(shown.text)
}
function assistant(ev: Event, ctx: TrampolineEvents, stream: ResponsesStream): void {
  const msg = ev.message ?? {}
  if (msg.usage) ctx.lastUsage = msg.usage
  const streamed = msg.id && ctx.streamedMessageIds.has(msg.id)
  for (const block of msg.content ?? []) {
    if (block.type === 'text' && !streamed && !ctx.planMode) stream.textDelta(block.text)
    else if (block.type === 'thinking' && !streamed && block.thinking)
      stream.reasoning(block.thinking)
    else if (block.type === 'tool_use' || block.type === 'server_tool_use')
      toolUse(block, ctx, stream)
  }
}
function toolResults(ev: Event, ctx: TrampolineEvents, stream: ResponsesStream): void {
  for (const block of ev.message?.content ?? []) {
    if (block.type !== 'tool_result') continue
    const entry = ctx.tools.get(block.tool_use_id)
    if (!entry) continue
    if (entry.web) {
      stream.webSearchDone(entry.web)
      entry.web = null
    }
    if (block.is_error && entry.name !== 'ExitPlanMode' && !entry.name.startsWith('mcp__codex__')) {
      stream.reasoning(describeToolError(entry.name, block.content, entry.description))
    }
  }
}
export function handleEvent(ev: Event, ctx: TrampolineEvents, stream: ResponsesStream): void {
  if (ev.parent_tool_use_id) return
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init' && ev.session_id) ctx.sid = ev.session_id
      if (ev.subtype === 'compact_boundary') stream.reasoning('**Compacted context**')
      return
    case 'stream_event':
      partial(ev, ctx, stream)
      return
    case 'assistant':
      assistant(ev, ctx, stream)
      return
    case 'user':
      toolResults(ev, ctx, stream)
      return
    case 'result':
      ctx.result = ev
      if (ev.session_id) ctx.sid = ev.session_id
      finishWebSearches(ctx, stream)
  }
}
