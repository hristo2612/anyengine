// The AnyEngine router (spec 5.2), Codex face. One process on a fixed
// loopback port. Everything under /backend-api/codex that is not a model
// catalog or a Claude turn is relayed to the upstream (chatgpt.com) with the
// caller's own headers, byte for byte (router-relay.mts): the body is
// buffered only to read the model and forwarded as received, encoding and
// all, and the answer streams back as it arrives, at the pace the caller
// reads it. The router holds no token of its own: it never reads codex's
// token store, never refreshes a token and never logs a credential.
import { existsSync, readFileSync } from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  type AnyEngineConfig,
  DEFAULT_CONFIG,
  enginePaths,
  loadConfig,
} from './anyengine-config.mjs'
import { PARSERS } from './anyengine-config-rules.mjs'
import { sanitizeInputForOpenAI } from './codex-input.mjs'
import { createRouterLog, keepTrimmed, launchdLogOf, type RouterLog } from './router-log.mjs'
import { ownCrashes, rootOrExit, warnAboutEnv } from './router-process.mjs'
import {
  carriesBody,
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  messageOf,
  observe,
  passthrough,
  readBody,
  readJsonBody,
  reasonOf,
  sendJson,
} from './router-relay.mjs'
import { wellFormedJson } from './safe-text.mjs'

// The relay's public part, and the launchd log's trim, where the plan and
// later tasks import them from.
export { trimInPlace } from './router-log.mjs'
export { countRejections } from './router-process.mjs'
export { decodeBody, forwardHeaders, passthrough, readJsonBody } from './router-relay.mjs'

export const CODEX_BASE_PATH = '/backend-api/codex'

export interface UpstreamHealth {
  lastOkAt: string | null
  lastError: string | null
  lastErrorAt: string | null
}

// What went wrong since the router started without taking it down: a
// router that answers /health but keeps failing shows it here.
export interface RouterFaults {
  unhandledRejections: number
  hookErrors: number
}

export interface RouterContext {
  root: string
  config: () => AnyEngineConfig
  upstream: () => string
  log: RouterLog
  inflight: { gpt: number; claude: number }
  health: UpstreamHealth
  faults: RouterFaults
  startedAt: string
}

export interface RouterHooks {
  close?: () => Promise<void>
  messages?: (ctx: RouterContext, req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  models?: (
    ctx: RouterContext,
    req: IncomingMessage,
    res: ServerResponse,
    query: string,
  ) => Promise<void>
  upgrade?: (ctx: RouterContext, req: IncomingMessage, socket: Duplex, head: Buffer) => void
  claudeHttp?: (
    ctx: RouterContext,
    req: IncomingMessage,
    res: ServerResponse,
    body: Record<string, unknown>,
  ) => Promise<boolean>
  status?: (ctx: RouterContext) => Record<string, unknown>
  observeGptBody?: (body: Record<string, unknown>) => void
  observeUpstreamError?: (status: number, text: string) => void
}

export interface RouterOptions {
  root: string
  port: number
  host?: string
  upstream?: string
  log?: RouterLog
  hooks?: RouterHooks
  // The most a request body may be (default 128 MB; 413 above it), and how
  // long a request may take to arrive, not its answer (default 300 s; 408).
  maxBodyBytes?: number
  requestTimeoutMs?: number
  faults?: RouterFaults
}

export interface RunningRouter {
  port: number
  baseUrl: string
  healthUrl: string
  context: RouterContext
  close(drainMs?: number): Promise<void>
}

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const LOOPBACK_BINDS = new Set(['127.0.0.1', '::1'])

// Who may use the router: a process on this Mac, never a web page. A page
// can reach 127.0.0.1 (fetch, a form, an image, a WebSocket), and through
// DNS rebinding under a name of its own; a browser gives itself away with an
// Origin, a Sec-Fetch-Site or Sec-Fetch-Dest header (none of which a page can
// remove) or a Host that is not a loopback name. Codex sends none of them (it
// sends `originator`, test/fixtures/codex-wire-0.159.0.json), nor does Node's
// fetch (Sec-Fetch-Mode only). Desktop's main-process gateway client sends
// none/empty/no-cors without Origin. A page's fetch cannot claim that metadata.
export function localOnly(req: IncomingMessage): string | null {
  if (!LOOPBACK_PEERS.has(req.socket.remoteAddress ?? '')) return 'not loopback'
  if (req.headers.origin !== undefined) return 'browser origin'
  const desktop =
    req.method === 'POST' &&
    /^\/v1\/messages(?:\/count_tokens)?(?:\?|$)/.test(req.url ?? '') &&
    req.headers.authorization === 'Bearer anyengine-local' &&
    req.headers.referer === undefined &&
    req.headers['sec-fetch-site'] === 'none' &&
    req.headers['sec-fetch-dest'] === 'empty' &&
    req.headers['sec-fetch-mode'] === 'no-cors'
  if (
    !desktop &&
    (req.headers['sec-fetch-site'] !== undefined || req.headers['sec-fetch-dest'] !== undefined)
  )
    return 'browser request'
  const host = String(req.headers.host ?? '')
    .toLowerCase()
    .replace(/:\d+$/, '')
  if (!LOOPBACK_HOSTS.has(host)) return 'bad host'
  return null
}

let knownVersion: string | null = null

// The installed lib's manifest version (install-lib.mjs writes it), else the
// package version marked -dev.
export function routerVersion(): string {
  if (knownVersion) return knownVersion
  const libRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  try {
    const manifest = join(libRoot, 'install-manifest.json')
    knownVersion = existsSync(manifest)
      ? String(JSON.parse(readFileSync(manifest, 'utf8')).version)
      : `${JSON.parse(readFileSync(join(libRoot, 'package.json'), 'utf8')).version}-dev`
    return knownVersion
  } catch {
    return '0.0.0-unknown'
  }
}

// A hook that throws fails its request (route's 500) and is counted.
async function counted<T>(ctx: RouterContext, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    ctx.faults.hookErrors += 1
    throw error
  }
}

// Refused at once. Node then reads what is left of the request by its own
// framing and discards it, so the caller is never reset mid-send (which could
// lose this answer); requestTimeout bounds how long that may take.
function refuse(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message: `anyengine router: ${message}` } })
}

async function handleCodex(
  ctx: RouterContext,
  hooks: RouterHooks,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  maxBodyBytes: number,
): Promise<void> {
  const subpath = url.pathname.slice(CODEX_BASE_PATH.length)
  if ((req.method === 'GET' || req.method === 'HEAD') && carriesBody(req)) {
    refuse(res, 400, 'a GET or HEAD request carries no body')
    return
  }
  const models = hooks.models
  if (req.method === 'GET' && subpath === '/models' && models) {
    await counted(ctx, () => models(ctx, req, res, url.search))
    return
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    passthrough(ctx, req, res, subpath, url.search, null, hooks)
    return
  }
  const read = await readBody(req, maxBodyBytes)
  if ('refused' in read) {
    // A caller that left mid-body is routine: info, not a failure.
    if (read.refused === 'gone') ctx.log.info('request.abandoned', { path: url.pathname })
    else {
      ctx.log.info('request.too-large', { path: url.pathname, maxBodyBytes })
      refuse(res, 413, `a request body may be at most ${maxBodyBytes} bytes`)
    }
    return
  }
  let raw = read.raw
  const body = subpath.startsWith('/responses')
    ? readJsonBody(raw, req.headers['content-encoding'])
    : null
  const claudeHttp = hooks.claudeHttp
  if (body && claudeHttp && (await counted(ctx, () => claudeHttp(ctx, req, res, body)))) return
  // A caller that left while its body was read or a hook ran: nothing goes
  // upstream for it, and no 'close' is left to count it out of the in-flight.
  if (res.destroyed) return
  if (body) {
    observe(ctx, 'observeGptBody', () => hooks.observeGptBody?.(body))
    const clean = sanitizeInputForOpenAI(body.input)
    if (clean.changed) {
      raw = Buffer.from(JSON.stringify({ ...body, input: clean.input }, wellFormedJson))
      delete req.headers['content-encoding']
      delete req.headers['content-length']
      delete req.headers['transfer-encoding']
    }
  }
  ctx.inflight.gpt += 1
  res.once('close', () => {
    ctx.inflight.gpt -= 1
  })
  passthrough(ctx, req, res, subpath, url.search, raw, hooks)
}

function parseTarget(raw: string | undefined): URL | null {
  try {
    return new URL(raw ?? '/', 'http://127.0.0.1')
  } catch {
    return null
  }
}

const underCodex = (pathname: string) =>
  pathname === CODEX_BASE_PATH || pathname.startsWith(`${CODEX_BASE_PATH}/`)

// The path alone: a query is the caller's and stays out of the log.
const pathOf = (raw: string | undefined) => (raw ?? '').split('?')[0]?.slice(0, 200) ?? ''

function healthOf(ctx: RouterContext, hooks: RouterHooks): Record<string, unknown> {
  let extra: Record<string, unknown> = {}
  observe(ctx, 'status', () => {
    extra = hooks.status?.(ctx) ?? {}
  })
  return {
    ok: true,
    pid: process.pid,
    version: routerVersion(),
    startedAt: ctx.startedAt,
    upstream: ctx.health,
    inflight: ctx.inflight,
    faults: ctx.faults,
    ...extra,
  }
}

function route(
  ctx: RouterContext,
  hooks: RouterHooks,
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
): void {
  const denied = localOnly(req)
  if (denied) {
    ctx.log.info('request.refused', { reason: denied, path: pathOf(req.url) })
    sendJson(res, 403, { error: { message: `anyengine router: ${denied}` } })
    return
  }
  // A request line Node accepts can still be no URL at all (`GET //[`).
  const url = parseTarget(req.url)
  if (!url) {
    sendJson(res, 400, { error: { message: 'anyengine router: bad request target' } })
    return
  }
  if (url.pathname === '/health') {
    sendJson(res, 200, healthOf(ctx, hooks))
    return
  }
  const dispatch = async () => {
    const messages = hooks.messages
    if (messages && (await counted(ctx, () => messages(ctx, req, res)))) return
    if (!underCodex(url.pathname)) {
      sendJson(res, 404, { error: { message: 'anyengine router: unknown path' } })
      return
    }
    await handleCodex(ctx, hooks, req, res, url, maxBodyBytes)
  }
  dispatch().catch((error: unknown) => {
    ctx.log.error('request.failed', { message: messageOf(error) })
    sendJson(res, 500, { error: { message: 'anyengine router: request failed' } })
  })
}

function onUpgrade(
  ctx: RouterContext,
  hooks: RouterHooks,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  // An upgraded socket has lost the server's error handler: without one, a
  // peer's reset would be an uncaught exception.
  socket.on('error', () => socket.destroy())
  const denied = localOnly(req)
  const url = parseTarget(req.url)
  const upgrade = !denied && url && underCodex(url.pathname) ? hooks.upgrade : undefined
  if (!upgrade) {
    if (denied) ctx.log.info('upgrade.refused', { reason: denied, path: pathOf(req.url) })
    const status = denied ? '403 Forbidden' : '404 Not Found'
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    return
  }
  try {
    upgrade(ctx, req, socket, head)
  } catch (error) {
    ctx.faults.hookErrors += 1
    ctx.log.error('upgrade.failed', { message: messageOf(error) })
    socket.destroy()
  }
}

// An upstream given in code (tests) passes the same check as config.json's:
// https://chatgpt.com/..., or http on 127.0.0.1, never the router's own port.
function checkedUpstream(upstream: string, port: number): string {
  const parse = PARSERS['router.upstream']
  if (!parse) throw new Error('anyengine router: no upstream rule')
  const config = { ...DEFAULT_CONFIG, router: { ...DEFAULT_CONFIG.router, port } }
  try {
    return String(parse(upstream, config))
  } catch (error) {
    throw new Error(`anyengine router upstream ${messageOf(error)}`)
  }
}

// A request (its head and body) has to arrive within the timeout, 408 after
// it; its answer, a stream as long as a turn, is not bounded by it. The
// server checks every quarter of the timeout, at most every 30 s.
const REQUEST_TIMEOUT_MS = 300_000

function serverOptions(requestTimeoutMs = REQUEST_TIMEOUT_MS): http.ServerOptions {
  const requestTimeout = Math.max(1, requestTimeoutMs)
  return {
    maxHeaderSize: MAX_HEADER_BYTES,
    requestTimeout,
    headersTimeout: Math.min(60_000, requestTimeout),
    keepAliveTimeout: 65_000,
    connectionsCheckingInterval: Math.min(30_000, Math.max(50, Math.floor(requestTimeout / 4))),
  }
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(port, host, () => {
      server.off('error', fail)
      ok()
    })
  })
}

function closeServer(server: http.Server, drainMs: number, upgrades: Set<Duplex>): Promise<void> {
  return new Promise<void>((ok) => {
    const forceClose = () => {
      server.closeAllConnections()
      // Node deliberately leaves upgraded sockets out of closeAllConnections.
      // They share the same grace period as HTTP turns, then close both relays.
      for (const socket of upgrades) socket.destroy()
    }
    const force = setTimeout(forceClose, drainMs)
    force.unref()
    server.close(() => {
      clearTimeout(force)
      ok()
    })
    if (drainMs === 0) forceClose()
  })
}

export async function startRouter(options: RouterOptions): Promise<RunningRouter> {
  const hooks = options.hooks ?? {}
  const host = options.host ?? '127.0.0.1'
  if (!LOOPBACK_BINDS.has(host))
    throw new Error(
      `anyengine router binds a loopback address only (127.0.0.1 or ::1), not ${host}`,
    )
  const fixed =
    options.upstream === undefined ? null : checkedUpstream(options.upstream, options.port)
  const context: RouterContext = {
    root: options.root,
    config: () => loadConfig(options.root),
    upstream: () => fixed ?? loadConfig(options.root).router.upstream,
    log: options.log ?? createRouterLog(join(enginePaths(options.root).logs, 'router.jsonl')),
    inflight: { gpt: 0, claude: 0 },
    health: { lastOkAt: null, lastError: null, lastErrorAt: null },
    faults: options.faults ?? { unhandledRejections: 0, hookErrors: 0 },
    startedAt: new Date().toISOString(),
  }
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES
  const server = http.createServer(serverOptions(options.requestTimeoutMs), (req, res) => {
    try {
      route(context, hooks, req, res, maxBodyBytes)
    } catch (error) {
      context.log.error('request.failed', { message: messageOf(error) })
      sendJson(res, 500, { error: { message: 'anyengine router: request failed' } })
    }
  })
  const upgrades = new Set<Duplex>()
  server.on('upgrade', (req, socket, head) => {
    upgrades.add(socket)
    socket.once('close', () => upgrades.delete(socket))
    onUpgrade(context, hooks, req, socket, head)
  })
  await listen(server, options.port, host)
  server.on('error', (error) => context.log.error('server.error', { message: messageOf(error) }))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  const origin = `http://${host === '::1' ? '[::1]' : host}:${port}`
  let closing: Promise<void> | undefined
  return {
    port,
    baseUrl: `${origin}${CODEX_BASE_PATH}`,
    healthUrl: `${origin}/health`,
    context,
    close: (drainMs = 10_000) => {
      closing ??= Promise.all([closeServer(server, drainMs, upgrades), hooks.close?.()]).then(
        () => {},
      )
      return closing
    },
  }
}

// launchd appends the router's stdout and stderr to that log for as long as
// it runs: kept under 200 KB, checked every minute (the launcher trims it at
// each start too), so a noisy router cannot fill the disk between restarts.
const LAUNCHD_LOG_MAX = 204_800
const LAUNCHD_LOG_EVERY_MS = 60_000
const DRAIN_MS = 10_000

// `adapter.mjs router`: the launchd daemon. SIGTERM drains for up to 10 s.
export async function runRouterDaemon(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const root = rootOrExit(env)
  const log = createRouterLog(join(enginePaths(root).logs, 'router.jsonl'))
  const faults: RouterFaults = { unhandledRejections: 0, hookErrors: 0 }
  ownCrashes(log, faults)
  warnAboutEnv(env, log)
  const launchdLog = launchdLogOf(env, root)
  if (launchdLog) keepTrimmed(launchdLog, LAUNCHD_LOG_MAX, LAUNCHD_LOG_EVERY_MS)
  else if ((env.ANYENGINE_LAUNCHD_LOG ?? '').trim())
    log.error('router.launchd-log', { reason: 'not a file in <root>/logs, left alone' })
  const { buildRouterHooks } = await import('./router-hooks.mjs')
  let router: RunningRouter
  try {
    router = await startRouter({
      root,
      port: loadConfig(root).router.port,
      log,
      hooks: buildRouterHooks(root, log),
      faults,
    })
  } catch (error) {
    log.error('router.start-failed', { reason: reasonOf(error) })
    throw error
  }
  log.info('router.start', { port: router.port, version: routerVersion() })
  const { startSessionSync } = await import('./sessions-sync.mjs')
  const sessions = startSessionSync(root, env, (message) => log.info('sessions.sync', { message }))
  const stop = (signal: string) => {
    log.info('router.stop', { signal, inflight: { ...router.context.inflight } })
    void Promise.all([sessions.close(), router.close(DRAIN_MS)]).then(() => process.exit(0))
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
}
