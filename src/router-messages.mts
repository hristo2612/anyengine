// Claude retains its wire payload. Only an explicit GPT model crosses into
// the broker-authenticated Messages translator.
import { isUtf8 } from 'node:buffer'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AccountAdmission, TokenBroker } from './broker-types.mjs'
import { type GptCatalogs, readGptSettingsView } from './claude-catalog.mjs'
import { serveGpt } from './claude-gpt.mjs'
import { type GptModel, type GptSettingsView, resolveGptModel } from './claude-models.mjs'
import { DESKTOP_MODEL_PREFIX, desktopGptModel } from './desktop-models.mjs'
import {
  carriesBody,
  decodeBody,
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  passthrough,
  readBody,
  readJsonBody,
  relayAgent,
  sendJson,
} from './router-relay.mjs'
import { CODEX_BASE_PATH, localOnly, type RouterContext } from './router-server.mjs'
import type { Obj } from './vendor/claude-code-proxy/types.mjs'

export type MessagesHook = (
  ctx: RouterContext,
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>

interface MessagesDependencies {
  broker: TokenBroker
  admission: AccountAdmission
  catalogs: GptCatalogs
  anthropicOrigin?: string
  gptOrigin?: string
}

const MAX_DECODED_BYTES = 256 * 1024 * 1024
const CONTROL_MODELS = '/control/claude-code/models'

// An explicit loopback override is a test input, never environment state.
function originOverride(value: string | undefined, production: string): string {
  if (value === undefined) return production
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('messages.invalid-test-origin')
  return url.origin
}

function targetOf(raw: string | undefined): { path: string; query: string } | null {
  if (!raw?.startsWith('/') || raw.startsWith('//') || raw.includes('#')) return null
  try {
    // URL also treats a backslash as a slash. Require the parsed origin to
    // remain local before handing the original path/query to the relay.
    if (new URL(raw, 'http://127.0.0.1').origin !== 'http://127.0.0.1') return null
    const split = raw.indexOf('?')
    return split < 0
      ? { path: raw, query: '' }
      : { path: raw.slice(0, split), query: raw.slice(split) }
  } catch {
    return null
  }
}

function error(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, {
    type: 'error',
    error: {
      type: status === 400 || status === 413 ? 'invalid_request_error' : 'api_error',
      code,
      message,
    },
  })
}

function callerSignal(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const close = () => {
    if (!res.writableFinished) abort()
  }
  req.once('aborted', abort)
  res.once('close', close)
  if (req.aborted || res.destroyed) abort()
  return {
    signal: controller.signal,
    detach() {
      req.off('aborted', abort)
      res.off('close', close)
    },
  }
}

function inflight(ctx: RouterContext, res: ServerResponse, lane: 'claude' | 'gpt'): void {
  ctx.inflight[lane]++
  res.once('close', () => ctx.inflight[lane]--)
}

// Content blocks, system text and tool schemas are counted locally. Images
// have a fixed conservative allowance; their base64/URL is never tokenized.
function estimatedTokens(body: Obj): number {
  let bytes = 0
  let images = 0
  const add = (value: unknown) => {
    if (typeof value === 'string') bytes += Buffer.byteLength(value, 'utf8')
  }
  const json = (value: unknown) => {
    if (value !== undefined) add(JSON.stringify(value))
  }
  const contents: unknown[] = [body.system]
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message && typeof message === 'object' && !Array.isArray(message))
        contents.push(message.content)
    }
  }
  while (contents.length) {
    const value = contents.pop()
    if (typeof value === 'string') add(value)
    else if (Array.isArray(value)) {
      for (const block of value) contents.push(block)
    } else if (value && typeof value === 'object') {
      const block = value as Record<string, unknown>
      switch (block.type) {
        case 'image':
          images++
          break
        case 'text':
          add(block.text)
          break
        case 'tool_result':
          contents.push(block.content)
          break
        case 'tool_use':
          add(block.name)
          json(block.input)
          break
        case 'thinking':
          add(block.thinking)
          break
        default:
          json(block)
      }
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool && typeof tool === 'object' && !Array.isArray(tool)) {
        add(tool.name)
        add(tool.description)
        json(tool.input_schema)
      }
    }
  }
  return Math.max(1, Math.ceil(bytes / 3) + images * 1024)
}

export function messagesHook(deps: MessagesDependencies): MessagesHook {
  const anthropic = originOverride(deps.anthropicOrigin, 'https://api.anthropic.com')
  const gptUpstream = new URL(
    CODEX_BASE_PATH,
    originOverride(deps.gptOrigin, 'https://chatgpt.com'),
  )
  async function controlModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      error(res, 405, 'method_not_allowed', 'Use GET for the model settings view')
      return
    }
    const caller = callerSignal(req, res)
    try {
      const view = await readGptSettingsView({ ...deps, signal: caller.signal })
      if (!caller.signal.aborted)
        sendJson(res, 200, {
          generation: view.generation,
          fetchedAt: view.fetchedAt,
          models: view.models,
        })
    } catch {
      if (!caller.signal.aborted)
        error(res, 503, 'gpt_unavailable', 'GPT model settings are unavailable; try again')
    } finally {
      caller.detach()
    }
  }
  async function gptMessages(
    ctx: RouterContext,
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    body: Obj,
    requested: string,
  ): Promise<void> {
    const caller = callerSignal(req, res)
    inflight(ctx, res, 'gpt')
    try {
      if (path === '/v1/messages/count_tokens') {
        const view = await readGptSettingsView({ ...deps, signal: caller.signal })
        if (caller.signal.aborted) return
        if (!resolveGptModel(requested, view.models)) {
          error(res, 400, 'unsupported_model', 'The requested GPT model is unavailable')
          return
        }
        const inputTokens = estimatedTokens(body)
        ctx.log.info('messages.count_tokens', { estimated: true, inputTokens })
        sendJson(res, 200, { input_tokens: inputTokens })
      } else if (path === '/v1/messages') {
        await serveGpt({
          req,
          res,
          body,
          requestedModel: requested,
          broker: deps.broker,
          catalogs: deps.catalogs,
          admission: deps.admission,
          upstream: gptUpstream,
          signal: caller.signal,
        })
      } else error(res, 400, 'unsupported_endpoint', 'GPT requires the Messages endpoint')
    } catch {
      if (!caller.signal.aborted)
        error(res, 503, 'gpt_unavailable', 'GPT is unavailable; try again')
    } finally {
      caller.detach()
    }
  }
  async function claudeBody(
    ctx: RouterContext,
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    query: string,
  ): Promise<void> {
    const read = await readBody(req, MAX_BODY_BYTES)
    if ('refused' in read) {
      if (read.refused === 'too-large')
        error(res, 413, 'request_too_large', 'Request body exceeds the local size limit')
      return
    }
    if (res.destroyed) return
    let parsed: Record<string, unknown> | null = null
    try {
      const decoded = decodeBody(read.raw, req.headers['content-encoding'], MAX_DECODED_BYTES)
      if (isUtf8(decoded)) parsed = readJsonBody(decoded, undefined)
    } catch (cause) {
      // Malformed/unknown encodings remain Anthropic's input. Expansion beyond
      // the bounded local decode is refused rather than forwarded as a bomb.
      if ((cause as NodeJS.ErrnoException | null)?.code === 'ERR_BUFFER_TOO_LARGE') {
        error(res, 413, 'request_too_large', 'Decoded request exceeds the local size limit')
        return
      }
    }
    const requested = typeof parsed?.model === 'string' ? parsed.model : ''
    const desktop = requested.startsWith(DESKTOP_MODEL_PREFIX)
    const model = desktop ? desktopGptModel(requested) : requested
    if (desktop && !model) {
      error(res, 400, 'unsupported_model', 'Invalid AnyEngine Desktop model')
      return
    }
    if (!model?.startsWith('gpt-')) {
      inflight(ctx, res, 'claude')
      passthrough({ ...ctx, upstream: () => anthropic }, req, res, path, query, read.raw)
      return
    }
    await gptMessages(ctx, req, res, path, { ...parsed, model } as Obj, model)
  }
  return async (ctx, req, res) => {
    const target = targetOf(req.url)
    if (!target) {
      error(res, 400, 'invalid_request_target', 'Invalid request target')
      return true
    }
    const { path, query } = target
    if (
      path === '/health' ||
      path === CODEX_BASE_PATH ||
      path.startsWith(`${CODEX_BASE_PATH}/`) ||
      ((path === '/control' || path.startsWith('/control/')) && path !== CONTROL_MODELS)
    )
      return false
    if (localOnly(req)) {
      error(res, 403, 'local_request_required', 'A local non-browser request is required')
      return true
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && carriesBody(req)) {
      error(res, 400, 'unexpected_body', 'A GET or HEAD request carries no body')
      return true
    }
    if (path === CONTROL_MODELS) await controlModels(req, res)
    else if (req.method === 'GET' || req.method === 'HEAD') {
      inflight(ctx, res, 'claude')
      passthrough({ ...ctx, upstream: () => anthropic }, req, res, path, query, null)
    } else await claudeBody(ctx, req, res, path, query)
    return true
  }
}

const MAX_VIEW_BYTES = 1024 * 1024
const CONTROLS = /[\p{Cc}\p{Zl}\p{Zp}]/u
const EFFORT = /^[a-z][a-z0-9_-]{0,63}$/

function viewFailure(signal?: AbortSignal): Error {
  return new Error(
    signal?.aborted ? 'claude-code.request-aborted' : 'claude-code.models-unavailable',
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function viewModel(row: unknown): GptModel {
  if (
    !record(row) ||
    typeof row.id !== 'string' ||
    typeof row.label !== 'string' ||
    !row.label.trim() ||
    row.label.length > 1024 ||
    CONTROLS.test(row.label) ||
    typeof row.contextWindow !== 'number' ||
    !Number.isSafeInteger(row.contextWindow) ||
    row.contextWindow < 1 ||
    typeof row.lite !== 'boolean' ||
    !Array.isArray(row.efforts) ||
    row.efforts.length > 64 ||
    !row.efforts.every((effort: unknown) => typeof effort === 'string' && EFFORT.test(effort))
  )
    throw viewFailure()
  const model: GptModel = {
    id: row.id,
    label: row.label,
    contextWindow: row.contextWindow,
    lite: row.lite,
    efforts: [...(row.efforts as string[])],
  }
  if (!resolveGptModel(model.id, [model])) throw viewFailure()
  return model
}

// Project each field rather than letting extra response keys enter settings.
export function settingsView(value: unknown): GptSettingsView {
  if (
    !record(value) ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    typeof value.fetchedAt !== 'number' ||
    !Number.isSafeInteger(value.fetchedAt) ||
    value.fetchedAt < 0 ||
    !Array.isArray(value.models) ||
    value.models.length > 10
  )
    throw viewFailure()
  const models = value.models.map(viewModel)
  if (new Set(models.map((model) => model.id)).size !== models.length) throw viewFailure()
  return { generation: value.generation, fetchedAt: value.fetchedAt, models }
}

export async function fetchGptSettingsView(
  baseUrl: string,
  signal: AbortSignal,
): Promise<GptSettingsView> {
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
    target = new URL(CONTROL_MODELS, base.origin)
  } catch {
    throw viewFailure()
  }
  return new Promise<GptSettingsView>((resolve, reject) => {
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (view?: GptSettingsView) => {
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
            finish(settingsView(JSON.parse(text)))
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
