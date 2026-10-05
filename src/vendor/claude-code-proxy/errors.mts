// MIT adaptation of pinned anthropic/error.rs and codex/events.rs. Public
// messages are fixed here; backend bodies, credentials and unknown codes stay private.
import type { Json, Obj, TranslationFailure } from './types.mjs'

const localMessages: Record<string, string> = {
  incomplete_stream: 'Upstream response was incomplete (incomplete_stream)',
  invalid_stream: 'Upstream response was malformed (invalid_stream)',
  missing_usage: 'Upstream terminal usage was missing or invalid (missing_usage)',
  empty_response: 'Upstream response contained no output (empty_response)',
  tool_arguments_too_large: 'Upstream tool arguments exceeded the limit (tool_arguments_too_large)',
  sse_frame_too_large: 'Upstream event exceeded the frame limit (sse_frame_too_large)',
  unsupported_output: 'Upstream response contained unsupported output (unsupported_output)',
}
const invalidCodes = new Set([
  'invalid_request',
  'invalid_prompt',
  'unsupported_tool',
  'unsupported_model',
  'cyber_policy',
  'bio_policy',
])
const quotaCodes = new Set([
  'usage_limit_reached',
  'rate_limit_exceeded',
  'insufficient_quota',
  'rate_limit_error',
])
const overloadCodes = new Set(['server_is_overloaded', 'slow_down', 'overloaded_error'])

function object(value: Json | undefined): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function retry(value: string | undefined): string | null {
  if (!value || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) return null
  const text = value.trim()
  if (/^\d{1,10}$/.test(text)) return text
  const date = new Date(text)
  return Number.isFinite(date.getTime()) && date.toUTCString() === text ? text : null
}

export function mapFailure(status: number, body: Obj, retryAfter?: string): TranslationFailure {
  const error = object(body.error ?? object(body.response).error)
  const code =
    typeof error.code === 'string' ? error.code : typeof error.type === 'string' ? error.type : ''
  const text = typeof error.message === 'string' ? error.message.slice(0, 512).toLowerCase() : ''
  let result: Omit<TranslationFailure, 'retryAfter'>
  if (
    code === 'context_length_exceeded' ||
    status === 413 ||
    text.includes('context window') ||
    text.includes('context length exceeded')
  )
    result = {
      status: 400,
      type: 'invalid_request_error',
      code: 'context_length_exceeded',
      message: 'prompt is too long: context length exceeded',
    }
  else if (status === 429 || quotaCodes.has(code))
    result = {
      status: 429,
      type: 'rate_limit_error',
      code: quotaCodes.has(code) ? code : 'rate_limit_exceeded',
      message: 'GPT rate limit exceeded',
    }
  else if (status === 401 || code === 'authentication_error')
    result = {
      status: 401,
      type: 'authentication_error',
      code: 'authentication_required',
      message: 'Run codex login',
    }
  else if (status === 403 || code === 'usage_not_included' || code === 'permission_error')
    result = {
      status: 403,
      type: 'permission_error',
      code: 'permission_denied',
      message: 'GPT request is not permitted',
    }
  else if (status === 529 || overloadCodes.has(code))
    result = {
      status: 529,
      type: 'overloaded_error',
      code: 'overloaded',
      message: 'GPT backend is overloaded',
    }
  else if (status === 504 || status === 408)
    result = {
      status: 504,
      type: 'api_error',
      code: 'upstream_timeout',
      message: 'GPT backend response timed out',
    }
  else if (status === 400 || invalidCodes.has(code))
    result = {
      status: 400,
      type: 'invalid_request_error',
      code: invalidCodes.has(code) ? code : 'invalid_request',
      message: 'Invalid GPT request',
    }
  else if (Object.hasOwn(localMessages, code))
    result = {
      status: 502,
      type: 'api_error',
      code,
      message: localMessages[code] ?? 'GPT backend failed',
    }
  else
    result = {
      status: 502,
      type: 'api_error',
      code: 'upstream_error',
      message: 'GPT backend failed',
    }
  return {
    ...result,
    retryAfter: result.status === 429 || result.status === 529 ? retry(retryAfter) : null,
  }
}

export function translationError(code: string): Error & TranslationFailure {
  const failure = mapFailure(502, { error: { code } })
  return Object.assign(new Error(failure.message), failure)
}
