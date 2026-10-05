// Incremental counterpart of pinned anthropic/sse.rs. Unlike the reference,
// decoding is fatal, EOF cannot finish a partial frame, and SSE field rules
// keep the last event field and remove exactly one optional data-field space.
import { translationError } from './errors.mjs'

export interface SseFrame {
  event: string | null
  data: string
}
export interface SseParser {
  push(chunk: Uint8Array): SseFrame[]
  end(): SseFrame[]
}
const MAX_FRAME = 8 * 1024 * 1024

export function createSseParser(): SseParser {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = '',
    event: string | null = null,
    data: string[] = [],
    frameBytes = 0,
    ended = false
  let failed: Error | null = null

  function line(value: string, frames: SseFrame[]): void {
    if (!value) {
      if (data.length) frames.push({ event, data: data.join('\n') })
      event = null
      data = []
      frameBytes = 0
      return
    }
    if (value.startsWith(':')) return
    const colon = value.indexOf(':')
    const key = colon < 0 ? value : value.slice(0, colon)
    let content = colon < 0 ? '' : value.slice(colon + 1)
    if (content.startsWith(' ')) content = content.slice(1)
    if (key === 'event') event = content || null
    else if (key === 'data') data.push(content)
  }

  function consume(final: boolean): SseFrame[] {
    const frames: SseFrame[] = []
    const separators = /\r\n|\r|\n/g
    let consumed = 0
    for (
      let separator = separators.exec(pending);
      separator;
      separator = separators.exec(pending)
    ) {
      if (!final && separator[0] === '\r' && separator.index === pending.length - 1) break
      const value = pending.slice(consumed, separator.index)
      frameBytes += Buffer.byteLength(value) + separator[0].length
      if (frameBytes > MAX_FRAME) throw translationError('sse_frame_too_large')
      consumed = separators.lastIndex
      line(value, frames)
    }
    pending = pending.slice(consumed)
    if (frameBytes + Buffer.byteLength(pending) > MAX_FRAME)
      throw translationError('sse_frame_too_large')
    return frames
  }

  function decode(chunk: Uint8Array | undefined, final: boolean): SseFrame[] {
    if (failed) throw failed
    if (ended) {
      if (chunk?.length) throw translationError('invalid_stream')
      return []
    }
    try {
      pending += decoder.decode(chunk, { stream: !final })
      const frames = consume(final)
      if (final) {
        if (pending || frameBytes) throw translationError('incomplete_stream')
        ended = true
      }
      return frames
    } catch (error) {
      failed =
        error instanceof Error && 'status' in error ? error : translationError('invalid_stream')
      throw failed
    }
  }
  return { push: (chunk) => decode(chunk, false), end: () => decode(undefined, true) }
}
