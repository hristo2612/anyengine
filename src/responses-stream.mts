// Ported from EthanSK/claude-in-codex (MIT) src/responsesStream.js @ e2adced, with changes; see THIRD_PARTY_NOTICES.md.
// Changes: TypeScript, `ae` id prefixes, a ResponseSink for `res`, codexToolCall takes the call itself, a `closed` getter, no lone surrogate on the wire, and WebSocketSink (src/server.js WebSocketResponse).
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { wellFormedJson } from './safe-text.mjs'

// Where a ResponsesStream writes: an http.ServerResponse, or a WebSocketSink.
export interface ResponseSink {
  writeHead?(status: number, headers: Record<string, string>): unknown
  write(chunk: string): boolean
  end(): void
  readonly writableEnded: boolean
  readonly destroyed: boolean
  on(event: 'close', listener: () => void): unknown
  off?(event: 'close', listener: () => void): unknown
}

type Item = Record<string, unknown> & { id: string }

interface OpenItem {
  kind: 'message' | 'reasoning'
  item: Item
  text: string
}

export interface WebSearchHandle {
  item: Item
  outputIndex: number
}

export interface CodexToolCall {
  callId: string
  name: string
  namespace?: string
  custom: boolean
  args: Record<string, unknown>
}

export function rid(prefix: string): string {
  return `${prefix}${randomBytes(12).toString('hex')}`
}

// Writes an OpenAI Responses API event stream in the shape Codex parses
// (codex-rs/codex-api/src/sse/responses.rs).
export class ResponsesStream {
  readonly sink: ResponseSink
  readonly model: string
  readonly id: string
  readonly output: Record<string, unknown>[]
  private seq: number
  private outputIndex: number
  private open: OpenItem | null
  private ended: boolean
  private readonly createdAt: number

  constructor(sink: ResponseSink, options: { model: string }) {
    this.sink = sink
    this.model = options.model
    this.id = rid('resp_ae_')
    this.seq = 0
    this.outputIndex = 0
    this.output = []
    this.open = null // { kind: 'message'|'reasoning', item, text }
    this.ended = false
    this.createdAt = Math.floor(Date.now() / 1000)
  }

  get closed(): boolean {
    return this.ended
  }

  begin(): void {
    this.sink.writeHead?.(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    this.send('response.created', { response: this.responseObject('in_progress') })
    this.send('response.in_progress', { response: this.responseObject('in_progress') })
  }

  private responseObject(status: string, extra: Record<string, unknown> = {}) {
    return {
      id: this.id,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output: status === 'in_progress' ? [] : this.output,
      ...extra,
    }
  }

  private send(type: string, payload: Record<string, unknown>): void {
    if (this.ended || this.sink.writableEnded || this.sink.destroyed) return
    // Well formed: Codex drops an event with a lone surrogate and retries the stream.
    const data = JSON.stringify({ type, sequence_number: this.seq++, ...payload }, wellFormedJson)
    this.sink.write(`event: ${type}\ndata: ${data}\n\n`)
  }

  keepAlive(): void {
    this.send('response.in_progress', { response: this.responseObject('in_progress') })
  }

  // ---- assistant text ------------------------------------------------------
  textDelta(delta: string): void {
    if (!delta) return
    let open = this.open
    if (open?.kind !== 'message') {
      this.closeOpen('commentary')
      const item = {
        id: rid('msg_ae_'),
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      }
      open = this.open = { kind: 'message', item, text: '' }
      this.send('response.output_item.added', { output_index: this.outputIndex, item })
      this.send('response.content_part.added', {
        item_id: item.id,
        output_index: this.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      })
    }
    open.text += delta
    this.send('response.output_text.delta', {
      item_id: open.item.id,
      output_index: this.outputIndex,
      content_index: 0,
      delta,
    })
  }

  hasOpenMessage(): boolean {
    return this.open?.kind === 'message'
  }

  // ---- reasoning (thinking + tool activity) ---------------------------------
  reasoningDelta(delta: string, options: { marker?: string } = {}): void {
    if (!delta) return
    let open = this.open
    if (open?.kind !== 'reasoning') {
      this.closeOpen('commentary')
      const item = {
        id: rid('rs_ae_'),
        type: 'reasoning',
        summary: [],
        encrypted_content: options.marker ?? null,
      }
      open = this.open = { kind: 'reasoning', item, text: '' }
      this.send('response.output_item.added', { output_index: this.outputIndex, item })
      this.send('response.reasoning_summary_part.added', {
        item_id: item.id,
        output_index: this.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      })
    }
    open.text += delta
    this.send('response.reasoning_summary_text.delta', {
      item_id: open.item.id,
      output_index: this.outputIndex,
      summary_index: 0,
      delta,
    })
  }

  // A complete one-shot reasoning item (used for tool activity lines).
  reasoning(text: string, options?: { marker?: string }): void {
    this.closeOpen('commentary')
    this.reasoningDelta(text, options)
    this.closeOpen('commentary')
  }

  // Invisible item carrying the session marker so the next request can be matched.
  marker(marker: string): void {
    this.closeOpen('commentary')
    const item = { id: rid('rs_ae_'), type: 'reasoning', summary: [], encrypted_content: marker }
    this.send('response.output_item.added', { output_index: this.outputIndex, item })
    this.send('response.output_item.done', { output_index: this.outputIndex, item })
    this.output.push(item)
    this.outputIndex++
  }

  // ---- native web search cards --------------------------------------------
  webSearchStart(action: Record<string, unknown>): WebSearchHandle {
    this.closeOpen('commentary')
    const item = { id: rid('ws_ae_'), type: 'web_search_call', status: 'in_progress', action }
    this.send('response.output_item.added', { output_index: this.outputIndex, item })
    const handle = { item, outputIndex: this.outputIndex }
    this.outputIndex++
    return handle
  }

  webSearchDone(handle: WebSearchHandle): void {
    const item = { ...handle.item, status: 'completed' }
    this.send('response.output_item.done', { output_index: handle.outputIndex, item })
    this.output.push(item)
  }

  // A call for Codex to run with its own tool executor (see src/trampoline-tools.mts).
  codexToolCall(call: CodexToolCall): void {
    this.closeOpen('commentary')
    const item = call.custom
      ? {
          id: rid('ctc_ae_'),
          type: 'custom_tool_call',
          status: 'completed',
          call_id: call.callId,
          name: call.name,
          input: String(call.args.input ?? ''),
          ...(call.namespace ? { namespace: call.namespace } : {}),
        }
      : {
          id: rid('fc_ae_'),
          type: 'function_call',
          call_id: call.callId,
          name: call.name,
          ...(call.namespace ? { namespace: call.namespace } : {}),
          arguments: JSON.stringify(call.args, wellFormedJson),
        }
    this.send('response.output_item.added', { output_index: this.outputIndex, item })
    this.send('response.output_item.done', { output_index: this.outputIndex, item })
    this.output.push(item)
    this.outputIndex++
  }

  compaction(encryptedContent: string): void {
    this.closeOpen('commentary')
    const item = { id: rid('cmp_ae_'), type: 'compaction', encrypted_content: encryptedContent }
    this.send('response.output_item.added', { output_index: this.outputIndex, item })
    this.send('response.output_item.done', { output_index: this.outputIndex, item })
    this.output.push(item)
    this.outputIndex++
  }

  // ---- closing ---------------------------------------------------------------
  closeOpen(phase: string): void {
    const o = this.open
    if (!o) return
    this.open = null
    if (o.kind === 'message') {
      const content = [{ type: 'output_text', text: o.text, annotations: [] }]
      this.send('response.output_text.done', {
        item_id: o.item.id,
        output_index: this.outputIndex,
        content_index: 0,
        text: o.text,
      })
      this.send('response.content_part.done', {
        item_id: o.item.id,
        output_index: this.outputIndex,
        content_index: 0,
        part: content[0],
      })
      const item = { ...o.item, status: 'completed', content, phase }
      this.send('response.output_item.done', { output_index: this.outputIndex, item })
      this.output.push(item)
    } else {
      this.send('response.reasoning_summary_text.done', {
        item_id: o.item.id,
        output_index: this.outputIndex,
        summary_index: 0,
        text: o.text,
      })
      this.send('response.reasoning_summary_part.done', {
        item_id: o.item.id,
        output_index: this.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: o.text },
      })
      const item = { ...o.item, summary: [{ type: 'summary_text', text: o.text }] }
      this.send('response.output_item.done', { output_index: this.outputIndex, item })
      this.output.push(item)
    }
    this.outputIndex++
  }

  // endTurn=false tells Codex to run this response's tool calls and send their results back.
  complete(usage: Record<string, unknown>, options: { endTurn?: boolean } = {}): void {
    const { endTurn = true } = options
    this.closeOpen('final_answer')
    this.send('response.completed', {
      response: this.responseObject('completed', { usage, end_turn: endTurn }),
    })
    this.end()
  }

  // Non-retryable failure (Codex retries server errors, which would re-run Claude).
  fail(message: string): void {
    this.closeOpen('commentary')
    this.send('response.failed', {
      response: this.responseObject('failed', { error: { code: 'invalid_prompt', message } }),
    })
    this.end()
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    if (!this.sink.writableEnded) this.sink.end()
  }
}

export function usageObject(
  counts: { input?: number; cached?: number; output?: number } = {},
): Record<string, unknown> {
  const { input = 0, cached = 0, output = 0 } = counts
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  }
}

// ResponsesStream writes complete SSE events. This adapter sends the same event
// JSON over a WebSocket for Claude turns, including model switches on an open socket.
// Writes are dropped once the socket is not OPEN.
export class WebSocketSink extends EventEmitter implements ResponseSink {
  readonly socket: WebSocket
  readonly onCompleted: ((response: Record<string, unknown>) => void) | undefined
  writableEnded: boolean
  writableFinished: boolean
  destroyed: boolean
  private readonly onSocketClose: () => void

  constructor(socket: WebSocket, onCompleted?: (response: Record<string, unknown>) => void) {
    super()
    this.socket = socket
    this.onCompleted = onCompleted
    this.writableEnded = false
    this.writableFinished = false
    this.destroyed = false
    this.onSocketClose = () => {
      this.destroyed = true
      this.emit('close')
    }
    socket.on('close', this.onSocketClose)
  }

  write(chunk: string): boolean {
    if (this.destroyed || this.writableEnded || this.socket.readyState !== WebSocket.OPEN) {
      return false
    }
    const data = String(chunk)
      .split('\n')
      .find((line) => line.startsWith('data: '))
    if (data) {
      const json = data.slice(6)
      const event = JSON.parse(json) as { type?: unknown; response?: Record<string, unknown> }
      // Save context before the client can send its next delta.
      if (event.type === 'response.completed' && event.response) this.onCompleted?.(event.response)
      this.socket.send(json)
    }
    return true
  }

  end(): void {
    if (this.writableEnded) return
    this.writableEnded = true
    this.writableFinished = true
    this.socket.off('close', this.onSocketClose)
    this.emit('close')
  }
}
