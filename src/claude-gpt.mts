// One admitted Messages request. Tools remain in the caller's Claude harness.
import { randomUUID } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import type { AccountAdmission, BrokerLease, TokenBroker } from './broker-types.mjs'
import { type GptCatalogs, gptTarget } from './claude-catalog.mjs'
import { createGptOutput } from './claude-gpt-output.mjs'
import { type GptCatalogSnapshot, type ModelChoice, resolveGptModel } from './claude-models.mjs'
import { MAX_HEADER_BYTES, relayAgent } from './router-relay.mjs'
import { mapFailure, translationError } from './vendor/claude-code-proxy/errors.mjs'
import { sessionKey, translateRequest } from './vendor/claude-code-proxy/request.mjs'
import { createSseParser } from './vendor/claude-code-proxy/sse.mjs'
import { createStreamTranslator } from './vendor/claude-code-proxy/stream.mjs'
import type { Obj, TranslationFailure } from './vendor/claude-code-proxy/types.mjs'

interface GptInput {
  req: IncomingMessage
  res: ServerResponse
  body: Obj
  requestedModel: string
  broker: TokenBroker
  catalogs: GptCatalogs
  admission: AccountAdmission
  upstream: URL
  signal: AbortSignal
}
const localCodes = new Set([
  'invalid_request',
  'invalid_identity',
  'unsupported_model',
  'unsupported_effort',
  'unsupported_content',
  'unsupported_tool',
  'invalid_tool',
  'invalid_image',
])
const stale = () => new Error('catalog.source-changed')
const aborted = () => new Error('broker.request-aborted')

function failure(error: unknown): TranslationFailure {
  if (error instanceof Error && 'status' in error && 'code' in error) {
    const typed = error as Error & TranslationFailure
    if (typed.status === 400 && localCodes.has(typed.code))
      return {
        status: 400,
        type: 'invalid_request_error',
        code: typed.code,
        message: `Invalid GPT request (${typed.code})`,
        retryAfter: null,
      }
    return mapFailure(typed.status, { error: { code: typed.code } }, typed.retryAfter ?? undefined)
  }
  const code = error instanceof Error ? error.message : ''
  if (
    [
      'broker.login-required',
      'broker.chatgpt-required',
      'broker.invalid-token',
      'broker.token-expired',
    ].includes(code)
  )
    return mapFailure(401, {})
  if (code.startsWith('broker.') || code.startsWith('catalog.'))
    return {
      status: 503,
      type: 'api_error',
      code: 'gpt_unavailable',
      message: 'GPT is unavailable; try again',
      retryAfter: null,
    }
  return mapFailure(502, {})
}

function validSnapshot(
  input: GptInput,
  lease: BrokerLease,
  snapshot: GptCatalogSnapshot,
  generation: number,
  signal: AbortSignal,
): boolean {
  return (
    !signal.aborted &&
    input.broker.isCurrent(lease) &&
    lease.generation === generation &&
    snapshot.generation === generation &&
    snapshot.sourceId === lease.sourceId &&
    snapshot.sourceRevision === lease.sourceRevision &&
    snapshot.cacheRevision === lease.cacheRevision
  )
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  return new Promise<T>((resolve, reject) => {
    abort = () => reject(aborted())
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(resolve, reject)
  }).finally(() => signal.removeEventListener('abort', abort))
}

async function sendModel(
  input: GptInput,
  generation: number,
  signal: AbortSignal,
  rejected?: BrokerLease,
): Promise<{ lease: BrokerLease; call: ReturnType<typeof startRequest> }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lease = await abortable(input.broker.get(rejected ? { rejected } : undefined), signal)
      if (lease.generation !== generation) throw new Error('catalog.generation-changed')
      const snapshot = await input.catalogs.get(lease, signal)
      if (!validSnapshot(input, lease, snapshot, generation, signal)) throw stale()
      const model = resolveGptModel(input.requestedModel, snapshot.models)
      if (!model)
        throw Object.assign(new Error('unsupported_model'), {
          status: 400,
          code: 'unsupported_model',
        })
      const body = JSON.stringify(
        translateRequest(input.body, {
          model,
          sessionKey: sessionKey(input.req.headers, input.body),
        }),
      )
      const target = gptTarget(input.upstream, 'responses')
      // No await can split the final lease/capability check from model bytes.
      if (!validSnapshot(input, lease, snapshot, generation, signal)) throw stale()
      return { lease, call: startRequest(target, body, lease, model, signal) }
    } catch (error) {
      if (
        attempt === 0 &&
        !signal.aborted &&
        error instanceof Error &&
        ['broker.source-changed', 'catalog.source-changed'].includes(error.message)
      )
        continue
      throw error
    }
  }
  throw stale()
}

function startRequest(
  target: URL,
  body: string,
  lease: BrokerLease,
  model: ModelChoice,
  signal: AbortSignal,
) {
  let resolve!: (response: IncomingMessage) => void
  let reject!: (error: Error) => void
  const response = new Promise<IncomingMessage>((yes, no) => {
    resolve = yes
    reject = no
  })
  const headers: Record<string, string> = {
    authorization: `Bearer ${lease.bearer}`,
    'chatgpt-account-id': lease.accountId,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'user-agent': 'anyengine',
    'openai-beta': 'responses=experimental',
    originator: model.lite ? 'codex_cli_rs' : 'anyengine',
  }
  if (model.lite) headers['x-openai-internal-codex-responses-lite'] = 'true'
  const transport = target.protocol === 'https:' ? https : http
  const request = transport.request(target, {
    method: 'POST',
    headers,
    agent: relayAgent(target),
    signal,
    maxHeaderSize: MAX_HEADER_BYTES,
  })
  const closed = new Promise<void>((done) => request.once('close', done))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    request.destroy()
  }, 30_000)
  request.once('response', (incoming) => {
    clearTimeout(timer)
    resolve(incoming)
  })
  request.once('error', () => {
    clearTimeout(timer)
    reject(
      timedOut
        ? Object.assign(new Error('upstream_timeout'), mapFailure(504, {}))
        : signal.aborted
          ? aborted()
          : translationError('invalid_stream'),
    )
  })
  request.end(body)
  return {
    response,
    closed,
    destroy: () => {
      clearTimeout(timer)
      request.destroy()
    },
  }
}

async function errorBody(response: IncomingMessage): Promise<Obj> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const raw of response) {
      const chunk = Buffer.from(raw)
      size += chunk.length
      if (size > 128 * 1024) {
        response.destroy()
        return {}
      }
      chunks.push(chunk)
    }
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    )
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {}
  } catch {
    return {}
  }
}

async function consume(
  response: IncomingMessage,
  output: ReturnType<typeof createGptOutput>,
  requestedModel: string,
): Promise<void> {
  if (response.statusCode !== 200) {
    const body = await errorBody(response)
    const mapped = mapFailure(
      response.statusCode ?? 502,
      body,
      typeof response.headers['retry-after'] === 'string'
        ? response.headers['retry-after']
        : undefined,
    )
    throw Object.assign(new Error(mapped.message), mapped)
  }
  const parser = createSseParser()
  const translator = createStreamTranslator(
    requestedModel,
    `msg_${randomUUID().replaceAll('-', '')}`,
  )
  const frames = async (values: ReturnType<typeof parser.push>) => {
    for (const frame of values) {
      if (frame.data === '[DONE]') {
        if (!translator.finished) throw translationError('incomplete_stream')
        continue
      }
      let value: unknown
      try {
        value = JSON.parse(frame.data)
      } catch {
        throw translationError('invalid_stream')
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw translationError('invalid_stream')
      for (const event of translator.push(value as Obj)) await output.accept(event)
    }
  }
  for await (const raw of response) await frames(parser.push(Buffer.from(raw)))
  await frames(parser.end())
  for (const event of translator.end()) await output.accept(event)
  await output.finish()
}

export async function serveGpt(input: GptInput): Promise<void> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const disconnect = () => {
    if (!input.res.writableFinished) abort()
  }
  input.signal.addEventListener('abort', abort, { once: true })
  input.req.once('aborted', abort)
  input.res.once('close', disconnect)
  if (input.signal.aborted || input.res.destroyed) abort()
  let admitted: Awaited<ReturnType<AccountAdmission['begin']>> | null = null
  let output = createGptOutput({
    res: input.res,
    streaming: input.body.stream === true,
    signal: controller.signal,
  })
  try {
    admitted = await input.admission.begin(controller.signal)
    let rejected: BrokerLease | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const { lease, call } = await sendModel(
        input,
        admitted.generation,
        controller.signal,
        rejected,
      )
      let retry = false
      try {
        await consume(await call.response, output, input.requestedModel)
      } catch (error) {
        const mapped = failure(error)
        if (mapped.code === 'usage_limit_reached' && input.broker.isCurrent(lease))
          input.admission.quota?.(lease, input.requestedModel)
        if (
          attempt === 0 &&
          mapped.status === 401 &&
          !output.semantic &&
          !controller.signal.aborted
        ) {
          rejected = lease
          retry = true
        } else throw error
      } finally {
        call.destroy()
        await call.closed
      }
      if (!retry) return
      output.dispose()
      output = createGptOutput({
        res: input.res,
        streaming: input.body.stream === true,
        signal: controller.signal,
      })
    }
  } catch (error) {
    if (!controller.signal.aborted && !input.res.destroyed) await output.error(failure(error))
  } finally {
    output.dispose()
    input.signal.removeEventListener('abort', abort)
    input.req.removeListener('aborted', abort)
    input.res.removeListener('close', disconnect)
    if (admitted) await admitted.release()
  }
}
