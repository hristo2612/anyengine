import type { ServerResponse } from 'node:http'
import { translationError } from './vendor/claude-code-proxy/errors.mjs'
import type {
  Json,
  Obj,
  StreamEvent,
  TranslationFailure,
} from './vendor/claude-code-proxy/types.mjs'

export interface GptOutput {
  accept(event: StreamEvent): Promise<void>
  finish(): Promise<void>
  error(failure: TranslationFailure): Promise<void>
  dispose(): void
  readonly semantic: boolean
}

interface Block {
  content: Obj
  json: string
}

const MAX_AGGREGATE = 32 * 1024 * 1024

function object(value: Json | undefined): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw translationError('invalid_stream')
  return value
}

function text(value: Json | undefined): string {
  if (typeof value !== 'string') throw translationError('invalid_stream')
  return value
}

function retryAfter(value: string | null): string | null {
  if (!value || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) return null
  const result = value.trim()
  if (/^\d{1,10}$/.test(result)) return result
  const date = new Date(result)
  return Number.isFinite(date.getTime()) && date.toUTCString() === result ? result : null
}

function aborted(): Error {
  return Object.assign(new Error('GPT output was closed'), { name: 'AbortError' })
}

export function createGptOutput(input: {
  res: ServerResponse
  streaming: boolean
  signal: AbortSignal
}): GptOutput {
  const { res, streaming, signal } = input
  const blocks = new Map<number, Block>()
  let message: Obj | null = null
  let start: StreamEvent | null = null
  let semantic = false
  let terminal = false
  let stop: StreamEvent | null = null
  let flushed = false
  let closed = false
  let disposed = false
  let aggregate = 0
  let pingPending = false
  let ping: ReturnType<typeof setInterval> | undefined
  let cancelWrite: ((error: Error) => void) | null = null
  let queue = Promise.resolve()

  function cleanup(): void {
    if (ping !== undefined) clearInterval(ping)
    ping = undefined
    signal.removeEventListener('abort', onAbort)
    res.removeListener('close', onAbort)
    res.removeListener('error', onAbort)
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    cleanup()
    cancelWrite?.(aborted())
  }

  function onAbort(): void {
    dispose()
  }

  function available(): void {
    if (disposed || signal.aborted || res.destroyed || res.writableEnded) throw aborted()
  }

  function serial(action: () => Promise<void>): Promise<void> {
    const result = queue.then(action)
    queue = result.catch(() => {})
    return result
  }

  function activate(): void {
    available()
    signal.addEventListener('abort', onAbort, { once: true })
    res.once('close', onAbort)
    res.once('error', onAbort)
  }

  function drained(): Promise<void> {
    return new Promise((resolve, reject) => {
      function settle(error?: Error): void {
        res.removeListener('drain', onDrain)
        cancelWrite = null
        if (error) reject(error)
        else resolve()
      }
      function onDrain(): void {
        settle()
      }
      cancelWrite = settle
      res.once('drain', onDrain)
      try {
        available()
      } catch {
        settle(aborted())
      }
    })
  }

  async function write(value: string): Promise<void> {
    available()
    if (!res.write(value)) await drained()
    available()
  }

  async function frame(value: StreamEvent): Promise<void> {
    await write(`event: ${value.event}\ndata: ${JSON.stringify(value.data)}\n\n`)
  }

  async function flush(): Promise<void> {
    if (flushed) return
    if (!start) throw translationError('invalid_stream')
    activate()
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    flushed = true
    await frame(start)
    start = null
    ping = setInterval(() => {
      if (closed || disposed || stop || pingPending || cancelWrite || res.writableNeedDrain) return
      pingPending = true
      void serial(async () => {
        if (!closed && !disposed && !stop && !cancelWrite && !res.writableNeedDrain)
          await frame({ event: 'ping', data: { type: 'ping' } })
      })
        .catch(() => dispose())
        .finally(() => {
          pingPending = false
        })
    }, 15_000)
    ping.unref()
  }

  function charge(data: Obj): Obj {
    let encoded: string
    try {
      encoded = JSON.stringify(data)
    } catch {
      throw translationError('invalid_stream')
    }
    if (!streaming) {
      aggregate += Buffer.byteLength(encoded)
      if (aggregate > MAX_AGGREGATE)
        throw Object.assign(new Error('GPT output exceeded the limit (response_too_large)'), {
          status: 502,
          type: 'api_error',
          code: 'response_too_large',
          retryAfter: null,
        })
    }
    return JSON.parse(encoded) as Obj
  }

  function begin(data: Obj): void {
    message = object(data.message)
    start = { event: 'message_start', data }
  }

  function index(data: Obj): number {
    const value = data.index
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw translationError('invalid_stream')
    return value
  }

  function beginBlock(data: Obj): void {
    const key = index(data)
    const content = object(data.content_block)
    blocks.set(key, { content, json: '' })
  }

  function openBlock(data: Obj): Block {
    const block = blocks.get(index(data))
    if (!block) throw translationError('invalid_stream')
    return block
  }

  function blockDelta(data: Obj): void {
    const block = openBlock(data)
    const value = object(data.delta)
    const content = block.content
    const fields: Record<string, readonly [string, string, string]> = {
      text_delta: ['text', 'text', 'text'],
      thinking_delta: ['thinking', 'thinking', 'thinking'],
      signature_delta: ['thinking', 'signature', 'signature'],
      input_json_delta: ['tool_use', 'partial_json', ''],
    }
    const field = typeof value.type === 'string' ? fields[value.type] : undefined
    if (!field || content.type !== field[0]) throw translationError('invalid_stream')
    const part = text(value[field[1]])
    if (value.type === 'input_json_delta') block.json += part
    else content[field[2]] = text(content[field[2]]) + part
  }

  function stopBlock(data: Obj): void {
    const block = openBlock(data)
    if (block.content.type === 'tool_use' && block.json) {
      try {
        block.content.input = object(JSON.parse(block.json) as Json)
      } catch {
        throw translationError('invalid_stream')
      }
      block.json = ''
    }
  }

  function messageDelta(data: Obj): void {
    if (!message) throw translationError('invalid_stream')
    if (!streaming) {
      const delta = object(data.delta)
      message.stop_reason = delta.stop_reason ?? null
      message.stop_sequence = delta.stop_sequence ?? null
      message.usage = object(data.usage)
    }
    terminal = true
  }

  function aggregateEvent(value: StreamEvent): boolean {
    switch (value.event) {
      case 'message_start':
        begin(value.data)
        return false
      case 'ping':
        return flushed
      case 'content_block_start':
        semantic = true
        if (!streaming) beginBlock(value.data)
        break
      case 'content_block_delta':
        semantic = true
        if (!streaming) blockDelta(value.data)
        break
      case 'content_block_stop':
        if (!streaming) stopBlock(value.data)
        break
      case 'message_delta':
        messageDelta(value.data)
        break
      case 'message_stop':
        stop = value
        return false
      default:
        break
    }
    return true
  }

  async function end(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      function finished(): void {
        res.removeListener('finish', finished)
        cancelWrite = null
        resolve()
      }
      cancelWrite = (error) => {
        res.removeListener('finish', finished)
        cancelWrite = null
        reject(error)
      }
      res.once('finish', finished)
      res.end()
    })
    closed = true
    cleanup()
    blocks.clear()
    message = null
    start = null
    stop = null
  }

  return {
    get semantic() {
      return semantic
    },
    dispose,
    accept(value) {
      return serial(async () => {
        available()
        if (closed) throw aborted()
        const safe = streaming ? value : { event: value.event, data: charge(value.data) }
        if (aggregateEvent(safe) && streaming) {
          await flush()
          await frame(safe)
        }
      })
    },
    finish() {
      return serial(async () => {
        if (closed) return
        available()
        if (!stop || !terminal || !message) throw translationError('incomplete_stream')
        if (!streaming) {
          message.content = [...blocks].sort(([a], [b]) => a - b).map(([, block]) => block.content)
          activate()
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          await write(JSON.stringify(message))
        } else {
          await flush()
          await frame(stop)
        }
        await end()
      })
    },
    error(failure) {
      return serial(async () => {
        if (closed) return
        available()
        if (ping !== undefined) clearInterval(ping)
        ping = undefined
        const data: Obj = {
          type: 'error',
          error: { type: failure.type, code: failure.code, message: failure.message },
        }
        if (res.headersSent) await frame({ event: 'error', data })
        else {
          activate()
          res.statusCode = failure.status
          res.setHeader('content-type', 'application/json')
          const retry = retryAfter(failure.retryAfter)
          if (retry && (failure.status === 429 || failure.status === 529))
            res.setHeader('retry-after', retry)
          await write(JSON.stringify(data))
        }
        await end()
      })
    },
  }
}
