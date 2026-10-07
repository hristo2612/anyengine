import http from 'node:http'
import { decodeBody, MAX_HEADER_BYTES, relayAgent } from './router-relay.mjs'
import { CODEX_BASE_PATH } from './router-server.mjs'

const MAX_VIEW_BYTES = 1024 * 1024
const viewFailure = (signal?: AbortSignal) =>
  new Error(signal?.aborted ? 'claude-code.request-aborted' : 'claude-code.models-unavailable')

export async function fetchModelSettings<T>(
  baseUrl: string,
  signal: AbortSignal,
  path: string,
  parse: (value: unknown) => T,
): Promise<T> {
  if (signal.aborted) throw viewFailure(signal)
  let target: URL
  try {
    const base = new URL(baseUrl)
    if (
      base.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(base.hostname) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      (base.pathname !== '/' && base.pathname.replace(/\/$/, '') !== CODEX_BASE_PATH)
    )
      throw viewFailure()
    target = new URL(path, base.origin)
  } catch {
    throw viewFailure()
  }
  return new Promise<T>((resolve, reject) => {
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (view?: T) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (view && !signal.aborted) resolve(view)
      else reject(viewFailure(signal))
    }
    const request = http.request(
      target,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        agent: relayAgent(target),
        maxHeaderSize: MAX_HEADER_BYTES,
        signal,
      },
      (response) => {
        response.once('error', () => finish())
        response.once('aborted', () => finish())
        if (
          response.statusCode !== 200 ||
          Number(response.headers['content-length'] ?? 0) > MAX_VIEW_BYTES
        ) {
          response.destroy()
          finish()
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_VIEW_BYTES) {
            chunks.length = 0
            response.destroy()
            finish()
          } else if (!finished) chunks.push(chunk)
        })
        response.once('end', () => {
          if (finished) return
          try {
            const bytes = decodeBody(
              Buffer.concat(chunks),
              response.headers['content-encoding'],
              MAX_VIEW_BYTES,
            )
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            finish(parse(JSON.parse(text)))
          } catch {
            finish()
          }
        })
      },
    )
    timer = setTimeout(() => request.destroy(viewFailure()), 8_000)
    request.once('error', () => finish())
    request.end()
  })
}
