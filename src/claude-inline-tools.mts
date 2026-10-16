// Claude Code's inline tools, folded into the one flat tool list the Responses
// API takes. Claude Code 2.1.30x can change the tool set mid-conversation:
//   - a role "system" message carries `tool_addition` blocks (a full
//     `tool_definition`, or a `tool_reference` that turns on a top-level tool
//     marked `defer_loading`) and `tool_removal` blocks (a `tool_reference`);
//   - top-level tools marked `defer_loading` stay off until added;
//   - ToolSearch results carry `tool_reference` blocks inside a tool_result.
// claude.ai connectors arrive this way, so without this every GPT request from
// a Claude Code with connectors failed as unsupported_content. The fold keeps
// the tools that are on at the end of the conversation, in first-seen order,
// and leaves every other block for the translator to judge. A request with
// neither inline blocks nor deferred tools is returned as it came.
import type { Json, Obj } from './vendor/claude-code-proxy/types.mjs'

function record(value: Json | undefined): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null
}

// The name a tool_addition or tool_removal block refers to, if well formed.
function referenced(tool: Obj | null): string | null {
  if (tool?.type === 'tool_reference' && typeof tool.name === 'string') return tool.name
  const definition = record(tool?.definition)
  if (tool?.type === 'tool_definition' && typeof definition?.name === 'string')
    return definition.name
  return null
}

function withoutDeferral(tool: Obj): Obj {
  const { defer_loading: _deferred, cache_control: _cache, ...rest } = tool
  return rest
}

interface ToolState {
  defined: Map<string, Obj>
  on: Set<string>
  folded: boolean
}

// One system message: apply its tool changes, keep whatever else it says.
function systemContent(content: Json[], state: ToolState): Json[] {
  const kept: Json[] = []
  for (const entry of content) {
    const block = record(entry)
    const tool = record(block?.tool)
    const name = referenced(tool)
    if (!block || !name || (block.type !== 'tool_addition' && block.type !== 'tool_removal')) {
      kept.push(entry)
      continue
    }
    state.folded = true
    if (block.type === 'tool_removal') state.on.delete(name)
    else {
      const definition = record(tool?.definition)
      if (definition) state.defined.set(name, withoutDeferral(definition))
      if (state.defined.has(name)) state.on.add(name)
    }
  }
  return kept
}

// A ToolSearch result names the tools it loaded; the model sees which ones,
// and is told when a named tool has no definition it could call.
function loaded(entry: Json, state: ToolState): Json {
  const part = record(entry)
  if (part?.type !== 'tool_reference' || typeof part.tool_name !== 'string') return entry
  state.folded = true
  if (!state.defined.has(part.tool_name))
    return { type: 'text', text: `[tool unavailable: ${part.tool_name}]` }
  state.on.add(part.tool_name)
  return { type: 'text', text: `[tool loaded: ${part.tool_name}]` }
}

function userContent(content: Json[], state: ToolState): Json[] {
  return content.map((entry) => {
    const block = record(entry)
    if (block?.type === 'tool_result' && Array.isArray(block.content))
      return { ...block, content: block.content.map((part) => loaded(part, state)) }
    return loaded(entry, state)
  })
}

export function foldInlineTools(body: Obj): Obj {
  const state: ToolState = { defined: new Map(), on: new Set(), folded: false }
  const tools = Array.isArray(body.tools) ? body.tools : null
  for (const entry of tools ?? []) {
    const tool = record(entry)
    if (!tool || typeof tool.name !== 'string' || state.defined.has(tool.name)) return body
    state.defined.set(tool.name, withoutDeferral(tool))
    if (tool.defer_loading !== true) state.on.add(tool.name)
  }
  if (!Array.isArray(body.messages)) return body
  const deferred = tools?.some((entry) => record(entry)?.defer_loading === true) ?? false
  const messages: Json[] = []
  for (const entry of body.messages) {
    const message = record(entry)
    if (!message || !Array.isArray(message.content)) {
      messages.push(entry)
      continue
    }
    const content =
      message.role === 'system'
        ? systemContent(message.content, state)
        : message.role === 'user'
          ? userContent(message.content, state)
          : message.content
    // A system message that only changed tools has nothing left to say.
    if (message.role === 'system' && content.length === 0) continue
    messages.push({ ...message, content })
  }
  if (!deferred && !state.folded) return body
  const active = [...state.defined.entries()]
    .filter(([name]) => state.on.has(name))
    .map(([, tool]) => tool)
  const { tools: _previous, ...rest } = body
  return { ...rest, messages, ...(active.length || tools ? { tools: active } : {}) }
}
