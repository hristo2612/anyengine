// MIT port of pinned live_stream.rs/reducer.rs. See vendored provenance.
// Strict terminals, bounded unmodified tool arguments and signed reasoning
// replace the reference's estimated usage, EOF completion and Read repair.
import { mapFailure, translationError } from './errors.mjs'
import { encodeReasoning } from './reasoning.mjs'
import type { Json, Obj, StreamEvent } from './types.mjs'
import { mapUsage } from './usage.mjs'

type Kind = 'text' | 'tool' | 'thinking'
interface Block {
  kind: Kind
  index: number
  itemId: string
  started: boolean
  closed: boolean
  contentSeen: boolean
  callId: string
  name: string
  args: string
  argBytes: number
  encrypted: string
}
export interface StreamTranslator {
  push(event: Obj): StreamEvent[]
  end(): StreamEvent[]
  readonly finished: boolean
}
const MAX_ARGS = 5 * 1024 * 1024
function object(value: Json | undefined): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
function validCount(value: Json | undefined): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function createStreamTranslator(
  requestedModel: string,
  messageId: string,
): StreamTranslator {
  const blocks = new Map<number, Block>(),
    byId = new Map<string, number>()
  let nextIndex = 0,
    started = false,
    finished = false,
    semantic = false,
    sawTool = false
  let failed: Error | null = null
  const emit = (out: StreamEvent[], event: string, data: Obj) =>
    out.push({ event, data: { type: event, ...data } })

  function messageStart(out: StreamEvent[]): void {
    if (started) return
    started = true
    emit(out, 'message_start', {
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  function indexFor(event: Obj, item: Obj = {}): number {
    const index = event.output_index
    if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0) return index
    const id = typeof event.item_id === 'string' ? event.item_id : item.id
    if (typeof id === 'string') {
      const found = byId.get(id)
      if (found != null) return found
    }
    throw translationError('invalid_stream')
  }

  function blockFor(event: Obj, kind: Kind, item: Obj = {}): Block {
    const index = indexFor(event, item)
    let block = blocks.get(index)
    if (block && block.kind !== kind) throw translationError('invalid_stream')
    if (!block) {
      block = {
        kind,
        index: -1,
        itemId: '',
        started: false,
        closed: false,
        contentSeen: false,
        callId: '',
        name: '',
        args: '',
        argBytes: 0,
        encrypted: '',
      }
      blocks.set(index, block)
    }
    const id = typeof item.id === 'string' ? item.id : event.item_id
    if (typeof id === 'string' && id) {
      if ((byId.has(id) && byId.get(id) !== index) || (block.itemId && block.itemId !== id))
        throw translationError('invalid_stream')
      byId.set(id, index)
      block.itemId = id
    }
    return block
  }

  function startBlock(block: Block, out: StreamEvent[]): void {
    if (block.started) return
    messageStart(out)
    block.started = true
    block.index = nextIndex++
    const content: Obj =
      block.kind === 'tool'
        ? { type: 'tool_use', id: block.callId, name: block.name, input: {} }
        : block.kind === 'thinking'
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '' }
    emit(out, 'content_block_start', { index: block.index, content_block: content })
  }

  function delta(block: Block, value: string, out: StreamEvent[]): void {
    if (block.closed) throw translationError('invalid_stream')
    if (!value) return
    startBlock(block, out)
    block.contentSeen = true
    if (value.trim()) semantic = true
    emit(out, 'content_block_delta', {
      index: block.index,
      delta:
        block.kind === 'thinking'
          ? { type: 'thinking_delta', thinking: value }
          : { type: 'text_delta', text: value },
    })
  }

  function toolMetadata(block: Block, item: Obj): void {
    for (const [key, current] of [
      ['call_id', block.callId],
      ['name', block.name],
    ] as const) {
      const value = item[key]
      if (value != null && (typeof value !== 'string' || !value || (current && current !== value)))
        throw translationError('invalid_stream')
    }
    if (typeof item.call_id === 'string') block.callId = item.call_id
    if (typeof item.name === 'string') block.name = item.name
    if (!block.callId || !block.name) throw translationError('invalid_stream')
  }

  function argumentsDelta(block: Block, value: string, out: StreamEvent[]): void {
    if (block.closed) throw translationError('invalid_stream')
    if (!value) return
    const size = Buffer.byteLength(value)
    if (block.argBytes + size > MAX_ARGS) throw translationError('tool_arguments_too_large')
    block.argBytes += size
    block.args += value
    startBlock(block, out)
    emit(out, 'content_block_delta', {
      index: block.index,
      delta: { type: 'input_json_delta', partial_json: value },
    })
  }

  function finalArguments(block: Block, value: Json | undefined, out: StreamEvent[]): void {
    if (value == null) return
    if (typeof value !== 'string') throw translationError('invalid_stream')
    if (block.args && value && value !== block.args) throw translationError('invalid_stream')
    if (!block.args) argumentsDelta(block, value, out)
  }

  function closeBlock(block: Block, out: StreamEvent[]): void {
    if (block.closed) return
    if (block.kind === 'tool') {
      try {
        const args: unknown = JSON.parse(block.args)
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error()
      } catch {
        throw translationError('invalid_stream')
      }
      sawTool = true
      semantic = true
    }
    startBlock(block, out)
    if (block.kind === 'thinking') {
      const signature = encodeReasoning(block.itemId, block.encrypted)
      if (!signature) throw translationError('invalid_stream')
      emit(out, 'content_block_delta', {
        index: block.index,
        delta: { type: 'signature_delta', signature },
      })
      semantic = true
    }
    emit(out, 'content_block_stop', { index: block.index })
    block.closed = true
    block.args = ''
    block.encrypted = ''
  }

  function finalText(block: Block, item: Obj, out: StreamEvent[]): void {
    if (block.contentSeen) return
    if (!Array.isArray(item.content)) return
    for (const value of item.content) {
      const part = object(value)
      if (part.type !== 'output_text' || typeof part.text !== 'string')
        throw translationError('unsupported_output')
      delta(block, part.text, out)
    }
  }

  function itemEvent(event: Obj, done: boolean, out: StreamEvent[]): void {
    const item = object(event.item)
    const kind =
      item.type === 'message'
        ? 'text'
        : item.type === 'function_call'
          ? 'tool'
          : item.type === 'reasoning'
            ? 'thinking'
            : null
    if (!kind) throw translationError('unsupported_output')
    const block = blockFor(event, kind, item)
    if (kind === 'tool') toolMetadata(block, item)
    if (block.closed) return
    if (kind === 'thinking') {
      if (typeof item.encrypted_content === 'string' && item.encrypted_content)
        block.encrypted = item.encrypted_content
    } else {
      startBlock(block, out)
      if (kind === 'tool') finalArguments(block, item.arguments, out)
      else if (done) finalText(block, item, out)
    }
    if (done) closeBlock(block, out)
  }

  function contentEvent(event: Obj, thinking: boolean, out: StreamEvent[]): void {
    if (typeof event.delta !== 'string') throw translationError('invalid_stream')
    delta(blockFor(event, thinking ? 'thinking' : 'text'), event.delta, out)
  }

  function toolEvent(event: Obj, done: boolean, out: StreamEvent[]): void {
    const block = blocks.get(indexFor(event))
    if (block?.kind !== 'tool') throw translationError('invalid_stream')
    if (done) finalArguments(block, event.arguments, out)
    else {
      if (typeof event.delta !== 'string') throw translationError('invalid_stream')
      argumentsDelta(block, event.delta, out)
    }
  }

  function checkFailure(event: Obj): boolean {
    const response = object(event.response),
      error = event.error ?? response.error
    if (
      error != null ||
      response.status === 'failed' ||
      ['response.failed', 'response.error', 'error'].includes(String(event.type))
    ) {
      const detail = object(error)
      const status =
        typeof detail.status === 'number'
          ? detail.status
          : typeof event.status === 'number'
            ? event.status
            : 502
      const retry = detail.retry_after ?? detail.retry_after_seconds
      const failure = mapFailure(
        status,
        event,
        typeof retry === 'string' || typeof retry === 'number' ? String(retry) : undefined,
      )
      throw Object.assign(new Error(failure.message), failure)
    }
    const incomplete =
      event.type === 'response.incomplete' ||
      response.status === 'incomplete' ||
      response.incomplete_details != null
    const allowed =
      event.type === 'response.incomplete' &&
      (response.status === undefined || response.status === 'incomplete') &&
      object(response.incomplete_details).reason === 'max_output_tokens'
    if (incomplete && !allowed) throw translationError('incomplete_stream')
    return allowed
  }

  function usageFor(response: Obj): Obj {
    const usage = object(response.usage)
    if (!validCount(usage.input_tokens) || !validCount(usage.output_tokens))
      throw translationError('missing_usage')
    const details = object(usage.input_tokens_details)
    if (details.cached_tokens !== undefined && !validCount(details.cached_tokens))
      throw translationError('missing_usage')
    return mapUsage(usage)
  }

  function finish(event: Obj, maxTokens: boolean, out: StreamEvent[]): void {
    const response = object(event.response)
    if (!maxTokens && response.status != null && response.status !== 'completed')
      throw translationError('invalid_stream')
    const usage = usageFor(response)
    if (response.output != null) {
      if (!Array.isArray(response.output)) throw translationError('invalid_stream')
      response.output.forEach((value, index) => {
        const item = object(value)
        const outputIndex = typeof item.id === 'string' ? (byId.get(item.id) ?? index) : index
        itemEvent({ item, output_index: outputIndex }, true, out)
      })
    }
    for (const block of blocks.values()) closeBlock(block, out)
    if (!semantic) throw translationError('empty_response')
    messageStart(out)
    emit(out, 'message_delta', {
      delta: {
        stop_reason: maxTokens ? 'max_tokens' : sawTool ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage,
    })
    emit(out, 'message_stop', {})
    finished = true
  }

  function dispatch(event: Obj, out: StreamEvent[]): void {
    const maxTokens = checkFailure(event)
    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
        messageStart(out)
        break
      case 'keepalive':
      case 'codex.rate_limits':
        messageStart(out)
        emit(out, 'ping', {})
        break
      case 'response.output_item.added':
        itemEvent(event, false, out)
        break
      case 'response.output_item.done':
        itemEvent(event, true, out)
        break
      case 'response.reasoning_summary_text.delta':
        contentEvent(event, true, out)
        break
      case 'response.output_text.delta':
        contentEvent(event, false, out)
        break
      case 'response.function_call_arguments.delta':
        toolEvent(event, false, out)
        break
      case 'response.function_call_arguments.done':
        toolEvent(event, true, out)
        break
      case 'response.reasoning_summary_part.added': {
        const block = blocks.get(indexFor(event))
        if (block?.kind === 'thinking' && block.contentSeen) delta(block, '\n\n', out)
        break
      }
      case 'response.completed':
      case 'response.done':
      case 'response.incomplete':
        finish(event, maxTokens, out)
        break
    }
  }

  return {
    get finished() {
      return finished
    },
    push(event) {
      if (failed) throw failed
      if (finished) return []
      const out: StreamEvent[] = []
      try {
        dispatch(event, out)
      } catch (error) {
        failed =
          error instanceof Error && 'status' in error ? error : translationError('invalid_stream')
        throw failed
      }
      return out
    },
    end() {
      if (failed) throw failed
      if (!finished) {
        failed = translationError('incomplete_stream')
        throw failed
      }
      return []
    },
  }
}
