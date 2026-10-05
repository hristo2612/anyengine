// MIT port of raine v0.1.42 request.rs; no Read repair, auth, I/O or tool execution.
import { createHash, randomUUID } from 'node:crypto'
import { decodeReasoning } from './reasoning.mjs'
import {
  cloneJson,
  fail,
  imageUrl,
  normalizeStrictJsonSchema,
  object,
  translateToolChoice,
  translateTools,
} from './tools.mjs'
import type { Json, Obj, TranslationContext } from './types.mjs'

const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function text(value: Json | undefined): string {
  if (typeof value !== 'string') fail('unsupported_content', 'Content text must be a string')
  return value
}

function blocks(value: Json | undefined): Obj[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) fail('unsupported_content', 'Message content must be text or blocks')
  return value.map((block) => object(block) ?? fail('unsupported_content', 'Invalid content block'))
}

function toolResult(block: Obj): Obj {
  const parts = blocks(block.content === undefined ? '' : block.content).map((part): Obj => {
    if (part.type === 'text') return { type: 'input_text', text: text(part.text) }
    if (part.type === 'image') return { type: 'input_image', image_url: imageUrl(part.source) }
    return fail('unsupported_content', 'Unsupported tool result content')
  })
  if (block.is_error !== undefined && typeof block.is_error !== 'boolean')
    fail('unsupported_content', 'Invalid tool result error flag')
  if (block.is_error) parts.unshift({ type: 'input_text', text: '[tool execution error]' })
  if (typeof block.tool_use_id !== 'string' || !block.tool_use_id)
    fail('unsupported_content', 'Tool result requires a call ID')
  return {
    type: 'function_call_output',
    call_id: block.tool_use_id,
    output: parts.some((part) => part.type === 'input_image')
      ? parts
      : parts.map((part) => part.text).join('\n'),
  }
}

function toolCall(block: Obj): Obj {
  if (
    typeof block.id !== 'string' ||
    !block.id ||
    typeof block.name !== 'string' ||
    !block.name ||
    !object(block.input)
  )
    fail('unsupported_content', 'Invalid tool call')
  return {
    type: 'function_call',
    call_id: block.id,
    name: block.name,
    arguments: JSON.stringify(block.input),
  }
}

function historyBlock(block: Obj, role: string): Obj | null {
  if (block.type === 'text')
    return { type: role === 'assistant' ? 'output_text' : 'input_text', text: text(block.text) }
  if (role === 'user' && block.type === 'image')
    return { type: 'input_image', image_url: imageUrl(block.source) }
  if (role === 'user' && block.type === 'tool_result') return toolResult(block)
  if (role === 'assistant' && block.type === 'tool_use') return toolCall(block)
  if (role === 'assistant' && block.type === 'thinking') {
    const replay = typeof block.signature === 'string' ? decodeReasoning(block.signature) : null
    return replay ? { type: 'reasoning', ...replay, summary: [] } : null
  }
  return fail('unsupported_content', 'Unsupported content block or role')
}

function inputHistory(value: Json | undefined): Obj[] {
  if (!Array.isArray(value)) fail('invalid_request', 'Messages must be an array')
  const result: Obj[] = []
  for (const entry of value) {
    const message = object(entry)
    if (!message || !['user', 'assistant', 'system'].includes(String(message.role)))
      fail('invalid_request', 'Invalid message role')
    const role = message.role === 'system' ? 'developer' : String(message.role)
    let parts: Obj[] = []
    const flush = () => {
      if (parts.length) {
        result.push({ type: 'message', role, content: parts })
        parts = []
      }
    }
    for (const block of blocks(message.content)) {
      const item = historyBlock(block, role)
      if (!item) continue
      if (['input_text', 'output_text', 'input_image'].includes(String(item.type))) parts.push(item)
      else {
        flush()
        result.push(item)
      }
    }
    flush()
  }
  return result
}

function reasoning(request: Obj, ctx: TranslationContext): { value: Obj | null; include: boolean } {
  const config = object(request.output_config)
  const requested = config?.effort ?? ctx.model.effort
  let effort = requested
  if (effort === 'max') {
    effort = efforts.filter((level) => ctx.model.efforts.includes(level)).at(-1) ?? null
    if (effort === null) fail('unsupported_effort', 'No supported reasoning effort')
  }
  if (effort !== null && (typeof effort !== 'string' || !ctx.model.efforts.includes(effort)))
    fail('unsupported_effort', 'Reasoning effort is unsupported by this model')
  const enabled = effort !== null && effort !== 'none'
  const value: Obj = {
    ...(effort !== null ? { effort } : {}),
    ...(enabled ? { summary: 'auto' } : {}),
    ...(ctx.model.lite ? { context: 'all_turns' } : {}),
  }
  return { value: effort !== null || ctx.model.lite ? value : null, include: enabled }
}

function outputText(request: Obj): Obj {
  const result: Obj = { verbosity: 'low' }
  const format = object(object(request.output_config)?.format)
  if (!format) return result
  if (format.type === 'json_schema') {
    if (format.schema === undefined) fail('invalid_request', 'JSON output requires a schema')
    result.format = {
      type: 'json_schema',
      name: 'response',
      schema: normalizeStrictJsonSchema(format.schema),
      strict: true,
    }
  } else if (format.type === 'json_object') result.format = { type: 'json_object' }
  else if (format.type === 'text') result.format = { type: 'text' }
  else fail('invalid_request', 'Unsupported output format')
  return result
}

export function translateRequest(request: Obj, ctx: TranslationContext): Obj {
  const source = object(cloneJson(request))
  if (!source) fail('invalid_request', 'Request must be an object')
  const tools = translateTools(source.tools),
    toolChoice = translateToolChoice(source.tool_choice, tools)
  const input = inputHistory(source.messages)
  const instructions =
    source.system === undefined
      ? undefined
      : blocks(source.system)
          .map((part) => {
            if (part.type !== 'text') fail('unsupported_content', 'System content must be text')
            return text(part.text)
          })
          .join('\n')
  const result: Obj = {
    model: ctx.model.upstream,
    input,
    store: false,
    stream: true,
    parallel_tool_calls: ctx.model.lite ? false : toolChoice.parallel,
    text: outputText(source),
    prompt_cache_key: ctx.sessionKey,
  }
  if (toolChoice.choice !== undefined) result.tool_choice = toolChoice.choice
  if (ctx.model.lite) {
    result.client_metadata = { ws_request_header_x_openai_internal_codex_responses_lite: 'true' }
    const prefix: Obj[] = []
    if (tools.length) prefix.push({ type: 'additional_tools', role: 'developer', tools })
    if (instructions)
      prefix.push({
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: instructions }],
      })
    result.input = [...prefix, ...input]
  } else {
    if (instructions !== undefined) result.instructions = instructions
    if (tools.length) result.tools = tools
  }
  const selected = reasoning(source, ctx)
  if (selected.value) result.reasoning = selected.value
  if (selected.include) result.include = ['reasoning.encrypted_content']
  return result
}

function identity(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const keys = Object.keys(headers).filter((key) => key.toLowerCase() === name)
  if (!keys.length) return null
  if (keys.length !== 1) fail('invalid_identity', 'Ambiguous identity header')
  const descriptor = Object.getOwnPropertyDescriptor(headers, keys[0] as string)
  if (!descriptor || !Object.hasOwn(descriptor, 'value'))
    fail('invalid_identity', 'Invalid identity header')
  let value = descriptor.value as string | string[] | undefined
  if (Array.isArray(value)) {
    if (value.length !== 1) fail('invalid_identity', 'Ambiguous identity header')
    value = value[0]
  }
  if (value === undefined) return null
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 256 || CONTROL.test(value))
    fail('invalid_identity', 'Invalid identity header')
  return value
}

export function sessionKey(
  headers: Record<string, string | string[] | undefined>,
  _request: Obj,
): string {
  // The captured client proves these headers, but no stable metadata ID value.
  const session = identity(headers, 'x-claude-code-session-id')
  const agent = identity(headers, 'x-claude-code-agent-id')
  return session
    ? createHash('sha256')
        .update(`claude-code\0${session}\0${agent ?? ''}`)
        .digest('hex')
    : randomUUID()
}
