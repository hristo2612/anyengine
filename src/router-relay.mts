// The router's HTTP relay: a request goes to the upstream with the caller's
// own headers and body, byte for byte, and the answer comes back the same
// way, streamed at the pace the caller reads it. A caller that leaves closes
// the upstream request; an upstream that fails ends the caller's stream.
// Used by router-server.mts, which re-exports the public part.
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http'
import https from 'node:https'
import { pipeline } from 'node:stream'
import zlib from 'node:zlib'
import { scrubForLog } from './router-log.mjs'
import type { RouterContext, RouterHooks } from './router-server.mjs'

// Headers that belong to one connection, not to the request (RFC 9110
// 7.6.1): Node writes its own for each hop. `host` is the router's; the
// upstream URL sets the real one. `expect`: the router has taken the body.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'expect',
])

// The header names a Connection header lists: hop-by-hop as well.
function connectionNamed(values: readonly unknown[]): Set<string> {
  return new Set(
    values
      .flatMap((value) => String(value ?? '').split(','))
      .map((token) => token.trim().toLowerCase()),
  )
}

// Everything else goes through as sent, the caller's credentials included,
// minus any header its Connection header names as hop-by-hop.
export function forwardHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = connectionNamed([headers.connection].flat())
  const out: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase()
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name)) continue
    out[key] = value
  }
  return out
}

// The same rule over rawHeaders ([name, value, name, value, ...]): an
// answer's headers go back with their duplicates, order and case, each
// Set-Cookie on its own line.
export function forwardRawHeaders(raw: readonly string[]): string[] {
  const pairs: Array<[string, string]> = []
  for (let index = 0; index + 1 < raw.length; index += 2) {
    pairs.push([raw[index] ?? '', raw[index + 1] ?? ''])
  }
  const named = connectionNamed(
    pairs.filter(([name]) => name.toLowerCase() === 'connection').map(([, value]) => value),
  )
  return pairs
    .filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase()) && !named.has(name.toLowerCase()))
    .flat()
}

// The relay's own connection pools, never the global agents: those follow
// the process environment, and NODE_USE_ENV_PROXY with HTTP(S)_PROXY would
// send every bearer through that proxy. TLS is verified whatever
// NODE_TLS_REJECT_UNAUTHORIZED says. Idle sockets close after 5 s, as the
// global agents' do; a socket in use is never timed out by it.
export const RELAY_AGENTS: { readonly http: http.Agent; readonly https: https.Agent } = {
  http: new http.Agent({ keepAlive: true, timeout: 5_000 }),
  https: new https.Agent({ keepAlive: true, timeout: 5_000, rejectUnauthorized: true }),
}

export function relayAgent(target: URL): http.Agent {
  return target.protocol === 'https:' ? RELAY_AGENTS.https : RELAY_AGENTS.http
}

// The most a request body may be: a Codex turn with its history and images
// fits well under it; the router holds a body whole while it reads the model.
export const MAX_BODY_BYTES = 128 * 1024 * 1024

export type BodyRead = { raw: Buffer } | { refused: 'too-large' | 'gone' }

// A request's body, whole: one declared or arriving past `max` is refused
// without being held, and a caller that leaves mid-body is 'gone'.
export function readBody(req: IncomingMessage, max: number): Promise<BodyRead> {
  if (Number(req.headers['content-length'] ?? 0) > max)
    return Promise.resolve({ refused: 'too-large' })
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (result: BodyRead) => {
      if (done) return
      done = true
      req.off('data', onData)
      resolve(result)
    }
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size <= max) {
        chunks.push(chunk)
        return
      }
      chunks.length = 0
      req.resume()
      finish({ refused: 'too-large' })
    }
    req.on('data', onData)
    req.on('end', () => finish({ raw: Buffer.concat(chunks) }))
    req.on('error', () => finish({ refused: 'gone' }))
    req.on('close', () => finish({ refused: 'gone' }))
  })
}

// Whether a request says it has a body. A GET or HEAD must not: none is
// defined for them (RFC 9110 9.3.1), and with Transfer-Encoding dropped as
// hop-by-hop its bytes would go unframed onto a pooled upstream socket.
export function carriesBody(req: IncomingMessage): boolean {
  return (
    req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0
  )
}

// A body is opened only to read it (the model), never re-encoded: this bound
// keeps a compressed body from inflating past what the router will hold.
const MAX_DECODED_BYTES = 256 * 1024 * 1024

export function decodeBody(
  raw: Buffer,
  encoding: string | undefined,
  maxBytes = MAX_DECODED_BYTES,
): Buffer {
  const enc = (encoding ?? '').toLowerCase().trim()
  const limit = { maxOutputLength: maxBytes }
  if (!enc || enc === 'identity') return raw
  if (enc === 'zstd') return zlib.zstdDecompressSync(raw, limit)
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(raw, limit)
  if (enc === 'br') return zlib.brotliDecompressSync(raw, limit)
  if (enc === 'deflate') return zlib.inflateSync(raw, limit)
  throw new Error(`unsupported content-encoding ${enc}`)
}

export function readJsonBody(
  raw: Buffer,
  encoding: string | undefined,
): Record<string, unknown> | null {
  if (raw.length === 0) return null
  try {
    const parsed = JSON.parse(decodeBody(raw, encoding).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

// An error's code when it has one (ECONNREFUSED, ENOTFOUND, a TLS code),
// else its message, scrubbed: this text reaches /health, the log and the caller.
export function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string' && code) return code
  return String(scrubForLog(messageOf(error))).slice(0, 200)
}

function noteUpstreamError(ctx: RouterContext, message: string): void {
  ctx.health.lastError = String(scrubForLog(message))
  ctx.health.lastErrorAt = new Date().toISOString()
}

// An observer that throws is logged and counted in /health's faults; it
// never fails the request it watches.
export function observe(ctx: RouterContext, hook: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    ctx.faults.hookErrors += 1
    ctx.log.error('hook.failed', { hook, message: messageOf(error) })
  }
}

// Codex's request headers (turn metadata, a JWT) and chatgpt.com's answers
// (cookies, rate-limit headers) can pass Node's 16 KB default.
export const MAX_HEADER_BYTES = 64 * 1024
// How much of an upstream error body the observer is given.
const ERROR_HEAD_BYTES = 64 * 1024

// The one place a request's upstream URL is made: the configured upstream,
// then the request's own path and query. It stays on that upstream's origin
// whatever the path holds (a path with no leading slash would move the host).
export function upstreamTarget(upstream: string, subpath: string, query: string): URL | null {
  if (subpath !== '' && !subpath.startsWith('/')) return null
  try {
    const target = new URL(`${upstream}${subpath}${query}`)
    return target.origin === new URL(upstream).origin ? target : null
  } catch {
    return null
  }
}

// An error answer, decoded when it came whole, for hooks.observeUpstreamError.
function watchError(
  ctx: RouterContext,
  answer: IncomingMessage,
  status: number,
  observer: (status: number, text: string) => void,
): void {
  const chunks: Buffer[] = []
  let size = 0
  let cut = false
  answer.on('data', (chunk: Buffer) => {
    if (size >= ERROR_HEAD_BYTES) cut = true
    else {
      chunks.push(chunk)
      size += chunk.length
    }
  })
  answer.on('end', () => {
    const raw = Buffer.concat(chunks)
    let text = ''
    try {
      text = (cut ? raw : decodeBody(raw, answer.headers['content-encoding'])).toString('utf8')
    } catch {}
    observe(ctx, 'observeUpstreamError', () => observer(status, text.slice(0, 4096)))
  })
}

interface Relay {
  clientGone: boolean
  answered: boolean
}

function relayAnswer(
  ctx: RouterContext,
  res: ServerResponse,
  answer: IncomingMessage,
  subpath: string,
  hooks: RouterHooks,
  relay: Relay,
): void {
  relay.answered = true
  // Piping into a response whose caller is gone throws: close the answer.
  if (res.destroyed) {
    answer.destroy()
    return
  }
  const status = answer.statusCode ?? 502
  if (status < 500) ctx.health.lastOkAt = new Date().toISOString()
  else noteUpstreamError(ctx, `upstream ${subpath} answered ${status}`)
  const observer = hooks.observeUpstreamError
  if (status >= 400 && observer) watchError(ctx, answer, status, observer)
  answer.on('close', () => {
    if (!answer.complete && !relay.clientGone)
      noteUpstreamError(ctx, `upstream ${subpath} ended mid-answer`)
  })
  try {
    res.writeHead(status, forwardRawHeaders(answer.rawHeaders))
  } catch (error) {
    ctx.log.error('upstream.bad-answer', { subpath, reason: reasonOf(error) })
    answer.destroy()
    res.destroy()
    return
  }
  // At the caller's pace, and either side ending early ends the other: a
  // caller that leaves closes the upstream request, an upstream that dies
  // ends the caller's stream (never a hang).
  try {
    pipeline(answer, res, () => {})
  } catch (error) {
    ctx.log.error('upstream.relay-failed', { subpath, reason: reasonOf(error) })
    answer.destroy()
    res.destroy()
  }
}

function failUpstream(ctx: RouterContext, res: ServerResponse, subpath: string, error: unknown) {
  const reason = reasonOf(error)
  noteUpstreamError(ctx, `${subpath}: ${reason}`)
  ctx.log.error('upstream.error', { subpath, reason })
  sendJson(res, 502, { error: { message: `anyengine router could not reach upstream: ${reason}` } })
}

// Relay one request to the upstream and its answer back, unchanged. `body`
// is the raw request body; null sends none (a GET or HEAD; the caller has
// refused one that carries a body, see carriesBody).
export function passthrough(
  ctx: RouterContext,
  req: IncomingMessage,
  res: ServerResponse,
  subpath: string,
  query: string,
  body: Buffer | null,
  hooks: RouterHooks = {},
): void {
  if (res.destroyed) return
  const target = upstreamTarget(ctx.upstream(), subpath, query)
  if (!target) {
    ctx.log.error('upstream.refused', { subpath: subpath.slice(0, 200) })
    sendJson(res, 400, { error: { message: 'anyengine router: that path cannot be relayed' } })
    return
  }
  const headers = forwardHeaders(req.headers)
  if (body) headers['content-length'] = String(body.length)
  const relay: Relay = { clientGone: false, answered: false }
  let upstream: http.ClientRequest
  try {
    const transport = target.protocol === 'https:' ? https : http
    const options = {
      method: req.method ?? 'GET',
      headers,
      agent: relayAgent(target),
      maxHeaderSize: MAX_HEADER_BYTES,
    }
    upstream = transport.request(target, options, (answer) =>
      relayAnswer(ctx, res, answer, subpath, hooks, relay),
    )
  } catch (error) {
    failUpstream(ctx, res, subpath, error)
    return
  }
  res.on('close', () => {
    if (res.writableFinished) return
    relay.clientGone = true
    upstream.destroy()
  })
  upstream.on('error', (error) => {
    // A caller that left is no upstream error; once answered, the answer's
    // own end reports a failure (relayAnswer).
    if (relay.clientGone || relay.answered) return
    failUpstream(ctx, res, subpath, error)
  })
  if (body) upstream.end(body)
  else {
    req.resume()
    upstream.end()
  }
}
