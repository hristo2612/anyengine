import http from 'node:http'
import https from 'node:https'
import { StringDecoder } from 'node:string_decoder'
import { debugLog } from './util.mjs'

// Kill an upstream connection that goes silent this long (no bytes).
const UPSTREAM_IDLE_TIMEOUT_MS = 60 * 60 * 1000
const MAX_UPSTREAM_ATTEMPTS = 3

export interface SseDataEvent {
  type?: string
  [key: string]: unknown
}

// Marker appended to the MAIN agent's system prompt. The proxy tees only
// requests whose `system` carries it: Task sub-agents get Claude Code's own
// system prompt (no marker) and auxiliary calls (title generation, quota
// checks) carry no tools, so neither leaks into the App transcript. HTML
// comment so the model ignores it.
export const MAIN_AGENT_SENTINEL = '<!-- claude-codex-main-agent:7f2a -->'

type UpstreamRequestFn = (
  options: https.RequestOptions,
  callback: (res: http.IncomingMessage) => void,
) => http.ClientRequest

// Identity of the upstream request an SSE event came from. `startedAt` is
// when the CLI's request reached the proxy and `tag` is whatever `tagStream`
// returned at that instant, so the consumer can tell a stream that began
// inside the current turn from one that began before it (Claude Code's
// post-Stop follow-up-suggestion request carries the sentinel too).
export interface SseStreamInfo {
  startedAt: number
  tag: unknown
}

export type SseEventHandler = (event: SseDataEvent, stream: SseStreamInfo) => void

export interface SsePtyProxyOptions {
  requestFn?: UpstreamRequestFn
  upstream?: { hostname: string; port: number; protocol?: 'http:' | 'https:' }
  onActivity?: (activeStreams: number) => void
  // Called once per teed request, at request start.
  tagStream?: () => unknown
}

interface Inflight {
  current: http.ClientRequest | undefined
  clientGone: boolean
}

// Per-PTY forward proxy. The genuine `claude` CLI is pointed at it through
// ANTHROPIC_BASE_URL; every request is forwarded UNCHANGED to api.anthropic.com
// (same method / path / headers / body — the subscription OAuth header
// included, never inspected or logged) and the response streams back byte for
// byte. The only mutation is dropping the client's `accept-encoding` so the SSE
// body arrives as plaintext we can parse. When the upstream response is
// text/event-stream and the request carries the main-agent sentinel, each
// parsed `data:` event is teed to `onEvent`.
export class SsePtyProxy {
  private readonly server: http.Server
  private readonly requestFn: UpstreamRequestFn
  private readonly upstreamHost: string
  private readonly upstreamPort: number
  private readonly agent: http.Agent
  private readonly onEvent: SseEventHandler
  private readonly onActivity: ((activeStreams: number) => void) | undefined
  private readonly tagStream: (() => unknown) | undefined
  private readonly label: string
  port = 0
  activeStreams = 0

  constructor(label: string, onEvent: SseEventHandler, options: SsePtyProxyOptions = {}) {
    this.label = label
    this.onEvent = onEvent
    this.onActivity = options.onActivity
    this.tagStream = options.tagStream
    this.requestFn =
      options.requestFn ?? (options.upstream?.protocol === 'http:' ? http.request : https.request)
    this.upstreamHost = options.upstream?.hostname ?? 'api.anthropic.com'
    this.upstreamPort = options.upstream?.port ?? 443
    const AgentCtor = options.upstream?.protocol === 'http:' ? http.Agent : https.Agent
    this.agent = new AgentCtor({ keepAlive: true, maxSockets: 8 })
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.on('clientError', (_err, socket) => {
      try {
        socket.destroy()
      } catch {}
    })
  }

  start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        const address = this.server.address()
        this.port = typeof address === 'object' && address ? address.port : 0
        resolve(this.port)
      })
    })
  }

  stop(): void {
    try {
      this.server.close()
      this.server.closeAllConnections?.()
    } catch {}
    this.agent.destroy()
  }

  private streamStarted(): () => void {
    this.activeStreams += 1
    this.onActivity?.(this.activeStreams)
    let done = false
    return () => {
      if (done) return
      done = true
      this.activeStreams = Math.max(0, this.activeStreams - 1)
      this.onActivity?.(this.activeStreams)
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = []
    const inflight: Inflight = { current: undefined, clientGone: false }
    let finish: (() => void) | undefined
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('error', () => {
      try {
        res.destroy()
      } catch {}
    })
    // `res` close before we finished = the CLI hung up mid-turn; abort upstream.
    res.on('close', () => {
      if (!res.writableFinished) {
        inflight.clientGone = true
        try {
          inflight.current?.destroy()
        } catch {}
        inflight.current = undefined
        finish?.()
      }
    })
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const tee = this.shouldTee(req.url, body)
        ? { startedAt: Date.now(), tag: this.tagStream?.() }
        : null
      const headers: Record<string, unknown> = { ...req.headers, host: this.upstreamHost }
      delete headers['accept-encoding']
      finish = this.streamStarted()
      this.sendUpstream(req, res, body, tee, headers, inflight, 0, finish)
    })
  }

  private sendUpstream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
    tee: SseStreamInfo | null,
    headers: Record<string, unknown>,
    inflight: Inflight,
    attempt: number,
    finish: () => void,
  ): void {
    const upstream = this.requestFn(
      {
        hostname: this.upstreamHost,
        port: this.upstreamPort,
        path: req.url,
        method: req.method,
        headers: headers as http.OutgoingHttpHeaders,
        agent: attempt === 0 ? this.agent : false,
      },
      (uRes) => {
        res.writeHead(uRes.statusCode || 502, uRes.headers)
        const isSse = String(uRes.headers['content-type'] || '').includes('text/event-stream')
        const decoder = isSse && tee ? new StringDecoder('utf8') : undefined
        let sseBuf = ''
        uRes.on('data', (chunk: Buffer) => {
          try {
            if (!res.write(chunk)) {
              uRes.pause()
              res.once('drain', () => uRes.resume())
            }
          } catch {}
          if (decoder && tee) sseBuf = this.parseSse(sseBuf + decoder.write(chunk), tee)
        })
        uRes.on('end', () => {
          if (decoder && tee) sseBuf = this.parseSse(sseBuf + decoder.end(), tee)
          inflight.current = undefined
          finish()
          try {
            res.end()
          } catch {}
        })
        uRes.on('error', (err) => {
          debugLog('anyengine.proxy.responseError', { label: this.label, error: err.message })
          inflight.current = undefined
          finish()
          try {
            res.destroy(err)
          } catch {}
        })
      },
    )
    inflight.current = upstream
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      if (inflight.current !== upstream) return
      inflight.current = undefined
      if (
        attempt + 1 < MAX_UPSTREAM_ATTEMPTS &&
        !res.headersSent &&
        isRetriableUpstreamError(err)
      ) {
        debugLog('anyengine.proxy.retry', { label: this.label, attempt: attempt + 2, code: err.code })
        setTimeout(
          () => {
            if (inflight.clientGone) return
            this.sendUpstream(req, res, body, tee, headers, inflight, attempt + 1, finish)
          },
          250 * (attempt + 1),
        )
        return
      }
      debugLog('anyengine.proxy.upstreamError', { label: this.label, error: err.message })
      finish()
      try {
        if (!res.headersSent) {
          res.writeHead(502)
          res.end()
        } else {
          res.destroy(err)
        }
      } catch {}
    })
    upstream.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
      try {
        upstream.destroy(new Error('upstream idle timeout'))
      } catch {}
    })
    if (body.length) upstream.write(body)
    upstream.end()
  }

  // Tee only tool-bearing /v1/messages requests whose system prompt carries
  // the main-agent sentinel.
  private shouldTee(url: string | undefined, body: Buffer): boolean {
    if ((url ?? '').split('?')[0] !== '/v1/messages') return false
    let json: { tools?: unknown; system?: unknown }
    try {
      json = JSON.parse(body.toString('utf8')) as { tools?: unknown; system?: unknown }
    } catch {
      return false
    }
    if (!Array.isArray(json.tools) || json.tools.length === 0) return false
    return systemHasSentinel(json.system)
  }

  private parseSse(input: string, stream: SseStreamInfo): string {
    let buf = input
    let idx = indexOfFrameEnd(buf)
    while (idx !== -1) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + (buf.startsWith('\r\n\r\n', idx) ? 4 : 2))
      let data = ''
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('data:')) data += line.slice(5).trimStart()
      }
      if (data && data !== '[DONE]') {
        try {
          this.onEvent(JSON.parse(data) as SseDataEvent, stream)
        } catch {}
      }
      idx = indexOfFrameEnd(buf)
    }
    return buf
  }
}

function isRetriableUpstreamError(err: NodeJS.ErrnoException): boolean {
  return ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err.code ?? '')
}

function systemHasSentinel(system: unknown): boolean {
  if (typeof system === 'string') return system.includes(MAIN_AGENT_SENTINEL)
  if (Array.isArray(system)) {
    return system.some(
      (block) =>
        typeof (block as { text?: unknown })?.text === 'string' &&
        (block as { text: string }).text.includes(MAIN_AGENT_SENTINEL),
    )
  }
  return false
}

function indexOfFrameEnd(buf: string): number {
  const a = buf.indexOf('\n\n')
  const b = buf.indexOf('\r\n\r\n')
  if (a === -1) return b
  if (b === -1) return a
  return Math.min(a, b)
}

// ---------------------------------------------------------------------------
// SSE event → runtime deltas, with the compaction gate.

export type StreamDelta =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; toolName: string; toolId: string }
  | { type: 'usage'; usage: Record<string, unknown> }

export function sseEventToDeltas(event: SseDataEvent): StreamDelta[] {
  switch (event.type) {
    case 'message_start': {
      const usage = (event as { message?: { usage?: Record<string, unknown> } }).message?.usage
      return usage && typeof usage === 'object' ? [{ type: 'usage', usage }] : []
    }
    case 'content_block_start': {
      const block = (event as { content_block?: { type?: string; name?: string; id?: string } })
        .content_block
      if (block?.type === 'tool_use') {
        return [
          {
            type: 'tool_use',
            toolName: String(block.name ?? 'tool'),
            toolId: String(block.id ?? ''),
          },
        ]
      }
      return []
    }
    case 'content_block_delta': {
      const delta = (event as { delta?: { type?: string; text?: string; thinking?: string } }).delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
        return [{ type: 'text', content: delta.text }]
      }
      if (
        delta?.type === 'thinking_delta' &&
        typeof delta.thinking === 'string' &&
        delta.thinking.length > 0
      ) {
        return [{ type: 'thinking', content: delta.thinking }]
      }
      return []
    }
    case 'message_delta': {
      const usage = (event as { usage?: Record<string, unknown> }).usage
      return usage && typeof usage === 'object' ? [{ type: 'usage', usage }] : []
    }
    default:
      return []
  }
}

// Claude Code runs auto-compaction (and `/compact`) as an ordinary API call
// through the same proxy with the same sentinel, so its summarizer output would
// otherwise stream into the App as one enormous `<analysis>…</analysis>` bubble.
// The reliable marker is that this is the one assistant message that OPENS with
// `<analysis>`: hold each message's first characters until that is decided and
// drop the whole message when it matches. A leading `<suggestion>` block is
// stripped instead (it is usually fused to the front of a genuine reply).
const COMPACTION_OPENER = '<analysis>'
const SUGGESTION_TAG = '<suggestion'
const SUGGESTION_OPEN_RE = /^<\s*suggestion\b[^>]*>/i
const SUGGESTION_CLOSE_RE = /<\s*\/\s*suggestion\s*>/i

function couldBeOpener(s: string): boolean {
  if (!s) return true
  if (COMPACTION_OPENER.startsWith(s)) return true
  const lower = s.toLowerCase()
  if (SUGGESTION_TAG.startsWith(lower)) return true
  if (lower.startsWith(SUGGESTION_TAG) && !lower.includes('>')) return true
  return false
}

export class CompactionStreamGate {
  private held: StreamDelta[] = []
  private opening = ''
  private verdict: 'undecided' | 'pass' | 'drop' | 'stripping' = 'undecided'
  private stripBuf = ''

  reset(): void {
    this.held = []
    this.opening = ''
    this.stripBuf = ''
    this.verdict = 'undecided'
  }

  accept(deltas: StreamDelta[]): StreamDelta[] {
    const out: StreamDelta[] = []
    for (const delta of deltas) {
      if (this.verdict === 'drop') continue
      if (this.verdict === 'pass') {
        out.push(delta)
        continue
      }
      if (this.verdict === 'stripping') {
        if (delta.type !== 'text') continue
        this.stripBuf += delta.content
        out.push(...this.consumeStripping())
        continue
      }
      // usage is the FIRST delta of every message; deciding on it would latch
      // `pass` before any text arrives. Forward it and keep deciding.
      if (delta.type === 'usage' || delta.type === 'thinking') {
        out.push(delta)
        continue
      }
      if (delta.type !== 'text') {
        this.verdict = 'pass'
        out.push(...this.flush(), delta)
        continue
      }
      this.opening += delta.content
      this.held.push(delta)
      const trimmed = this.opening.trimStart()
      if (trimmed.startsWith(COMPACTION_OPENER)) {
        this.verdict = 'drop'
        this.held = []
        continue
      }
      const open = SUGGESTION_OPEN_RE.exec(trimmed)
      if (open) {
        this.held = []
        this.verdict = 'stripping'
        this.stripBuf = trimmed.slice(open[0].length)
        out.push(...this.consumeStripping())
        continue
      }
      if (couldBeOpener(trimmed)) continue
      this.verdict = 'pass'
      out.push(...this.flush())
    }
    return out
  }

  // Message finished — release anything still held. An unterminated
  // `<suggestion>` block releases nothing: fail closed.
  end(): StreamDelta[] {
    const out = this.verdict === 'drop' || this.verdict === 'stripping' ? [] : this.flush()
    this.reset()
    return out
  }

  private consumeStripping(): StreamDelta[] {
    const close = SUGGESTION_CLOSE_RE.exec(this.stripBuf)
    if (!close) return []
    const rest = this.stripBuf.slice(close.index + close[0].length)
    this.stripBuf = ''
    this.verdict = 'pass'
    return rest ? [{ type: 'text', content: rest }] : []
  }

  private flush(): StreamDelta[] {
    const held = this.held
    this.held = []
    return held
  }
}
