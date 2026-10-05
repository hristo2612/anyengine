// Codex prewarms one /responses socket per thread. Route every frame by its
// body, since its upgrade metadata becomes stale when the thread switches
// model. GPT upgrades retain upstream rate limits; other upgrades are tunnels.
import type { IncomingMessage } from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import tls from 'node:tls'
import WebSocket, { WebSocketServer } from 'ws'
import { isAgentTurn, sanitizeInputForOpenAI } from './codex-input.mjs'
import { modelHint } from './codex-wire.mjs'
import { ResponsesStream, usageObject, WebSocketSink } from './responses-stream.mjs'
import type { FanoutMonitor } from './router-fanout.mjs'
import {
  forwardHeaders,
  forwardRawHeaders,
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  messageOf,
  reasonOf,
  relayAgent,
  upstreamTarget,
} from './router-relay.mjs'
import { CODEX_BASE_PATH, type RouterContext, type RouterHooks } from './router-server.mjs'
import { type ClaudeTurns, housekeepingBody, isClaudeModel } from './router-turns.mjs'
import { wellFormedJson } from './safe-text.mjs'

interface Deps {
  fanout: FanoutMonitor
  turns: (ctx: RouterContext) => ClaudeTurns | null
}

const TERMINAL = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error'])

function upstreamHeaders(req: IncomingMessage): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(forwardHeaders(req.headers))) {
    if (value !== undefined && !/^sec-websocket-/i.test(key)) out[key] = value as string | string[]
  }
  return out
}

function connectUpstream(ctx: RouterContext, req: IncomingMessage, search: string): WebSocket {
  const target = upstreamTarget(ctx.upstream(), '/responses', search)
  if (!target) throw new Error('refused upstream WebSocket target')
  const options = {
    headers: upstreamHeaders(req),
    agent: relayAgent(target),
    rejectUnauthorized: true,
    perMessageDeflate: true,
    handshakeTimeout: 15_000,
    maxPayload: MAX_BODY_BYTES,
    maxHeaderSize: MAX_HEADER_BYTES,
  }
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(target, options)
}

function reject(socket: Duplex, status: string, raw: string[] = []): void {
  if (socket.destroyed) return
  const kept = forwardRawHeaders(raw)
  const headers: string[] = []
  for (let i = 0; i + 1 < kept.length; i += 2) {
    if (!/^(content-length|sec-websocket-.*)$/i.test(kept[i] ?? ''))
      headers.push(`${kept[i]}: ${kept[i + 1]}`)
  }
  socket.end(
    `HTTP/1.1 ${status}\r\n${headers.map((h) => `${h}\r\n`).join('')}Connection: close\r\nContent-Length: 0\r\n\r\n`,
  )
}

function sendError(client: WebSocket, code: string, message: string): void {
  if (client.readyState !== WebSocket.OPEN) return
  client.send(
    JSON.stringify(
      { type: 'error', status: 400, error: { type: 'invalid_request_error', code, message } },
      wellFormedJson,
    ),
  )
}

function noteFailure(ctx: RouterContext, error: unknown): void {
  ctx.health.lastError = `ws: ${reasonOf(error)}`
  ctx.health.lastErrorAt = new Date().toISOString()
  ctx.log.error('ws.upstream', { message: messageOf(error) })
}

function parseFrame(data: WebSocket.RawData): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data.toString())
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

class Session {
  private readonly ctx: RouterContext
  private readonly deps: Deps
  private readonly req: IncomingMessage
  private readonly client: WebSocket
  private upstream: WebSocket | null
  private readonly queued: Array<{ data: WebSocket.RawData | string; isBinary: boolean }> = []
  private last: { id: string; input: unknown[] } | null = null
  private gptInFlight = 0
  private readonly activeClaude = new Set<() => void>()

  constructor(
    ctx: RouterContext,
    deps: Deps,
    req: IncomingMessage,
    client: WebSocket,
    upstream: WebSocket | null,
  ) {
    this.ctx = ctx
    this.deps = deps
    this.req = req
    this.client = client
    this.upstream = upstream
    if (upstream) this.pipeUpstream(upstream)
    client.on('message', (data, binary) => this.frameSafely(() => this.onFrame(data, binary)))
    client.on('error', () => client.terminate())
    client.on('close', () => {
      this.upstream?.terminate()
      this.releaseGpt()
      for (const finish of this.activeClaude) finish()
      this.last = null
    })
  }

  private frameSafely(run: () => void): void {
    try {
      run()
    } catch (error) {
      this.ctx.faults.hookErrors += 1
      this.ctx.log.error('ws.frame', { message: messageOf(error) })
      sendError(this.client, 'anyengine_frame_failed', 'The router could not handle this frame')
    }
  }

  private releaseGpt(): void {
    this.ctx.inflight.gpt -= this.gptInFlight
    this.gptInFlight = 0
    this.queued.length = 0
  }

  private closeUpstream(error?: unknown): void {
    this.releaseGpt()
    if (error) noteFailure(this.ctx, error)
    if (this.client.readyState === WebSocket.OPEN)
      this.client.close(error ? 1011 : 1000, error ? 'Upstream WebSocket failed' : '')
  }

  private pipeUpstream(upstream: WebSocket): void {
    upstream.on('message', (data, binary) =>
      this.frameSafely(() => {
        if (!binary) this.noteUpstreamFrame(data)
        if (this.client.readyState === WebSocket.OPEN) this.client.send(data, { binary })
      }),
    )
    upstream.on('close', () => this.closeUpstream())
    upstream.on('error', (error) => this.closeUpstream(error))
  }

  private noteUpstreamFrame(data: WebSocket.RawData): void {
    const frame = parseFrame(data)
    if (!frame || !TERMINAL.has(String(frame.type))) return
    if (this.gptInFlight > 0) {
      this.gptInFlight -= 1
      this.ctx.inflight.gpt -= 1
    }
    if (frame.type === 'error' && frame.status === 400)
      this.deps.fanout.observeUpstreamError(400, data.toString().slice(0, 4096))
    else this.ctx.health.lastOkAt = new Date().toISOString()
  }

  private openUpstream(): WebSocket {
    const search = new URL(this.req.url ?? '/', 'http://127.0.0.1').search
    const upstream = connectUpstream(this.ctx, this.req, search)
    this.upstream = upstream
    this.pipeUpstream(upstream)
    upstream.on('open', () =>
      this.frameSafely(() => {
        if (this.client.readyState !== WebSocket.OPEN) {
          upstream.terminate()
          return
        }
        for (const q of this.queued.splice(0)) upstream.send(q.data, { binary: q.isBinary })
      }),
    )
    upstream.on('unexpected-response', (_request, response) => {
      response.resume()
      this.closeUpstream(new Error(`upstream answered ${response.statusCode}`))
      upstream.terminate()
    })
    return upstream
  }

  private forwardGpt(data: WebSocket.RawData | string, isBinary: boolean, count = true): void {
    const upstream = this.upstream ?? this.openUpstream()
    if (upstream.readyState !== WebSocket.OPEN && upstream.readyState !== WebSocket.CONNECTING)
      throw new Error('upstream WebSocket is closed')
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
    else this.queued.push({ data, isBinary })
    if (count) {
      this.gptInFlight += 1
      this.ctx.inflight.gpt += 1
    }
  }

  private onFrame(data: WebSocket.RawData, isBinary: boolean): void {
    let body = isBinary ? null : parseFrame(data)
    if (!body) {
      this.forwardGpt(data, isBinary, false)
      return
    }
    let rewritten = false
    if (
      typeof body.previous_response_id === 'string' &&
      body.previous_response_id.startsWith('resp_ae_')
    ) {
      if (this.last?.id !== body.previous_response_id) {
        sendError(
          this.client,
          'previous_response_not_found',
          `Previous response with id '${body.previous_response_id}' not found.`,
        )
        return
      }
      const { previous_response_id: _drop, ...rest } = body
      body = {
        ...rest,
        input: [...this.last.input, ...(Array.isArray(body.input) ? body.input : [])],
      }
      rewritten = true
    }
    if (isClaudeModel(this.ctx.config(), body.model)) {
      this.onClaudeFrame(body)
      return
    }
    this.deps.fanout.observeGptBody(body)
    const clean = sanitizeInputForOpenAI(body.input)
    const count = body.type === 'response.create'
    this.forwardGpt(
      clean.changed || rewritten
        ? JSON.stringify({ ...body, input: clean.input }, wellFormedJson)
        : data,
      isBinary,
      count,
    )
  }

  private onClaudeFrame(body: Record<string, unknown>): void {
    const model = String(body.model)
    const remember = (response: Record<string, unknown>) => {
      const output = Array.isArray(response.output) ? response.output : []
      this.last = {
        id: String(response.id),
        input: [...(Array.isArray(body.input) ? body.input : []), ...output],
      }
    }
    if (body.generate === false) {
      const stream = new ResponsesStream(new WebSocketSink(this.client, remember), { model })
      stream.begin()
      stream.complete(usageObject())
      return
    }
    if (!isAgentTurn(body)) {
      const rewritten = housekeepingBody(body)
      if (!rewritten) {
        sendError(this.client, 'anyengine_no_gpt_model', 'no GPT model known yet')
        return
      }
      this.deps.fanout.observeGptBody(rewritten)
      const clean = sanitizeInputForOpenAI(rewritten.input)
      this.forwardGpt(JSON.stringify({ ...rewritten, input: clean.input }, wellFormedJson), false)
      return
    }
    const handler = this.deps.turns(this.ctx)
    if (!handler) {
      sendError(
        this.client,
        'anyengine_claude_unavailable',
        'Claude turns are not available in this router',
      )
      return
    }
    this.runClaude(handler, body, new WebSocketSink(this.client, remember))
  }

  private runClaude(
    handler: ClaudeTurns,
    body: Record<string, unknown>,
    sink: WebSocketSink,
  ): void {
    const abort = new AbortController()
    let active = true
    const finish = () => {
      if (!active) return
      active = false
      sink.off('close', finish)
      if (sink.destroyed || this.client.readyState !== WebSocket.OPEN) abort.abort()
      sink.end()
      this.activeClaude.delete(finish)
      this.ctx.inflight.claude -= 1
    }
    this.activeClaude.add(finish)
    sink.on('close', finish)
    this.ctx.inflight.claude += 1
    void Promise.resolve()
      .then(() =>
        handler.run(this.ctx, { body, headers: this.req.headers, sink, signal: abort.signal }),
      )
      .catch((error: unknown) => {
        this.ctx.faults.hookErrors += 1
        this.ctx.log.error('claude.ws', { message: messageOf(error) })
        if (this.client.readyState === WebSocket.OPEN) this.client.close(1011, 'Claude turn failed')
      })
      .finally(finish)
  }
}

function acceptLocally(
  ctx: RouterContext,
  deps: Deps,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  upstream: WebSocket | null = null,
  answer: IncomingMessage | null = null,
): void {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: true,
    maxPayload: MAX_BODY_BYTES,
  })
  wss.on('headers', (headers) => {
    const raw = forwardRawHeaders(answer?.rawHeaders ?? [])
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (!/^(content-length|sec-websocket-.*)$/i.test(raw[i] ?? ''))
        headers.push(`${raw[i]}: ${raw[i + 1]}`)
    }
  })
  wss.handleUpgrade(req, socket, head, (client) => {
    new Session(ctx, deps, req, client, upstream)
    socket.resume()
  })
}

function acceptAfterUpstream(
  ctx: RouterContext,
  deps: Deps,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  search: string,
): void {
  socket.pause()
  const upstream = connectUpstream(ctx, req, search)
  let answer: IncomingMessage | null = null
  let accepted = false
  upstream.on('upgrade', (response) => {
    answer = response
  })
  upstream.on('open', () => {
    if (socket.destroyed) {
      upstream.terminate()
      return
    }
    try {
      acceptLocally(ctx, deps, req, socket, head, upstream, answer)
      accepted = true
    } catch (error) {
      ctx.faults.hookErrors += 1
      ctx.log.error('ws.upgrade', { message: messageOf(error) })
      socket.destroy()
      upstream.terminate()
    }
  })
  upstream.on('unexpected-response', (_request, response) => {
    accepted = true
    noteFailure(ctx, new Error(`upstream answered ${response.statusCode}`))
    response.resume()
    reject(
      socket,
      `${response.statusCode} ${response.statusMessage ?? ''}`.trim(),
      response.rawHeaders,
    )
    upstream.terminate()
  })
  upstream.on('error', (error) => {
    if (accepted || socket.destroyed) return
    accepted = true
    noteFailure(ctx, error)
    reject(socket, '502 Bad Gateway')
  })
  socket.on('close', () => upstream.terminate())
}

// Other upgrade paths keep their handshake and subsequent bytes untouched.
function tunnel(ctx: RouterContext, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const target = upstreamTarget(
    ctx.upstream(),
    url.pathname.slice(CODEX_BASE_PATH.length),
    url.search,
  )
  if (!target) {
    reject(socket, '400 Bad Request')
    return
  }
  const secure = target.protocol === 'https:'
  const port = Number(target.port || (secure ? 443 : 80))
  const upstream = secure
    ? tls.connect({
        host: target.hostname,
        port,
        servername: net.isIP(target.hostname) ? '' : target.hostname,
        rejectUnauthorized: true,
      })
    : net.connect({ host: target.hostname, port })
  upstream.once(secure ? 'secureConnect' : 'connect', () => {
    const lines = [`${req.method ?? 'GET'} ${target.pathname}${target.search} HTTP/1.1`]
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i] ?? ''
      lines.push(`${name}: ${/^host$/i.test(name) ? target.host : req.rawHeaders[i + 1]}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', (error) => {
    noteFailure(ctx, error)
    reject(socket, '502 Bad Gateway')
  })
  upstream.on('close', () => {
    if (!socket.writableEnded) socket.end()
  })
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
}

export function wsUpgradeHook(deps: Deps): NonNullable<RouterHooks['upgrade']> {
  return (ctx, req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(`${CODEX_BASE_PATH}/`)) {
      reject(socket, '404 Not Found')
      return
    }
    if (url.pathname !== `${CODEX_BASE_PATH}/responses`) {
      tunnel(ctx, req, socket, head)
      return
    }
    const hint = modelHint(req.headers)
    if (hint && !isClaudeModel(ctx.config(), hint)) {
      acceptAfterUpstream(ctx, deps, req, socket, head, url.search)
      return
    }
    acceptLocally(ctx, deps, req, socket, head)
  }
}
