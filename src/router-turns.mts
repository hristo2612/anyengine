// The shared interface for Claude agent and model turns. Housekeeping calls
// made as Claude go to the last catalog's default GPT. HTTP has no socket
// context for previous_response_id, so those calls ask Codex to replay.
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import type { AnyEngineConfig } from './anyengine-config.mjs'
import { isAgentTurn, sanitizeInputForOpenAI } from './codex-input.mjs'
import { type ResponseSink, ResponsesStream, usageObject } from './responses-stream.mjs'
import { defaultGptSlug } from './router-catalog.mjs'
import type { AdapterOwner } from './router-claim-client.mjs'
import { passthrough, type RouterContext, type RouterHooks } from './router-server.mjs'
import { wellFormedJson } from './safe-text.mjs'

export interface ClaudeTurnRequest {
  body: Record<string, unknown>
  headers: IncomingHttpHeaders
  sink: ResponseSink
  signal: AbortSignal
  // Set by the ownership gate from a refreshed adapter record, never payload cwd.
  owner?: AdapterOwner
  observeAgentClaim?: (claimed: boolean) => Promise<void>
}

export interface ClaudeTurns {
  readonly mode: 'agent' | 'model'
  run(ctx: RouterContext, request: ClaudeTurnRequest): Promise<void>
}

export function isClaudeModel(config: AnyEngineConfig, model: unknown): boolean {
  return typeof model === 'string' && config.claude.models.some((m) => m.id === model)
}

export function housekeepingBody(body: Record<string, unknown>): Record<string, unknown> | null {
  const model = defaultGptSlug()
  if (!model) return null
  const effort = (body.reasoning as { effort?: unknown } | undefined)?.effort
  const reasoning =
    typeof effort === 'string' && !['low', 'medium', 'high'].includes(effort)
      ? { ...(body.reasoning as object), effort: 'medium' }
      : body.reasoning
  return { ...body, model, ...(reasoning ? { reasoning } : {}) }
}

// A non-retryable Responses failure, so an unavailable turn is never rerun.
export function unavailable(sink: ResponseSink, model: string, message: string): void {
  const stream = new ResponsesStream(sink, { model })
  stream.begin()
  stream.fail(message)
}

function httpError(res: ServerResponse, code: string, message: string): void {
  res.writeHead(400, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({ error: { type: 'invalid_request_error', code, message } }, wellFormedJson),
  )
}

async function runHttpTurn(
  ctx: RouterContext,
  handler: ClaudeTurns,
  request: Omit<ClaudeTurnRequest, 'signal'>,
  res: ServerResponse,
): Promise<void> {
  const abort = new AbortController()
  let active = true
  const finish = () => {
    if (!active) return
    active = false
    ctx.inflight.claude -= 1
    res.off('finish', finish)
    res.off('close', closed)
  }
  const closed = () => {
    if (!res.writableFinished) abort.abort()
    finish()
  }
  res.once('finish', finish)
  res.once('close', closed)
  ctx.inflight.claude += 1
  try {
    await handler.run(ctx, { ...request, signal: abort.signal })
  } finally {
    finish()
  }
}

export function claudeHttpHook(
  turns: (ctx: RouterContext) => ClaudeTurns | null,
): NonNullable<RouterHooks['claudeHttp']> {
  return async (ctx, req, res, body) => {
    if (!isClaudeModel(ctx.config(), body.model)) return false
    if (res.destroyed) return true
    if (body.generate === false) {
      const stream = new ResponsesStream(res, { model: String(body.model) })
      stream.begin()
      stream.complete(usageObject())
      return true
    }
    if (typeof body.previous_response_id === 'string') {
      httpError(
        res,
        'previous_response_not_found',
        `Previous response with id '${body.previous_response_id}' not found.`,
      )
      return true
    }
    if (!isAgentTurn(body)) {
      const rewritten = housekeepingBody(body)
      if (!rewritten) {
        httpError(
          res,
          'anyengine_no_gpt_model',
          'no GPT model known yet for a housekeeping request',
        )
        return true
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const subpath = url.pathname.replace(/^\/backend-api\/codex/, '')
      const clean = sanitizeInputForOpenAI(rewritten.input)
      const raw = Buffer.from(JSON.stringify({ ...rewritten, input: clean.input }))
      delete req.headers['content-encoding']
      ctx.inflight.gpt += 1
      res.once('close', () => {
        ctx.inflight.gpt -= 1
      })
      passthrough(ctx, req, res, subpath, url.search, raw)
      return true
    }
    const handler = turns(ctx)
    if (!handler) {
      httpError(
        res,
        'anyengine_claude_unavailable',
        'Claude turns are not available in this router',
      )
      return true
    }
    await runHttpTurn(ctx, handler, { body, headers: req.headers, sink: res }, res)
    return true
  }
}
