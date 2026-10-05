// MIT port of raine v0.1.42 request.rs schema/tool helpers; see vendored provenance.
import { types } from 'node:util'
import type { Json, Obj } from './types.mjs'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u
const schemaMaps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
])
const schemaLists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'])
const schemaSingles = new Set([
  'additionalProperties',
  'additionalItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
])

export function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), {
    status: 400,
    type: 'invalid_request_error',
    code,
    retryAfter: null,
  })
}

export function object(value: Json | undefined): Obj | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function dataDescriptors(value: Obj | Json[]): Record<string, PropertyDescriptor> {
  if (types.isProxy(value)) fail('invalid_request', 'Request must contain only JSON data')
  const array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value)
  if (
    (array && prototype !== Array.prototype) ||
    (!array && prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length
  )
    fail('invalid_request', 'Request must contain only JSON data')
  if ((array && value.length > 100_000) || Object.keys(value).length > 100_000)
    fail('invalid_request', 'Request exceeds translation bounds')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')))
    fail('invalid_request', 'Request must contain only JSON data')
  if (
    array &&
    Object.keys(descriptors).some((key) => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))
  )
    fail('invalid_request', 'Request must contain only JSON data')
  return descriptors
}

// Reject accessors and non-JSON prototypes before inspecting values. Entry construction
// preserves __proto__/constructor as data; no caller keys pass through a setter.
export function cloneJson(value: Json): Json {
  let bytes = 0,
    nodes = 0
  const active = new Set<object>()
  const charge = (amount: number) => {
    bytes += amount
    if (bytes > MAX_BYTES) fail('invalid_request', 'Request exceeds translation bounds')
  }
  const string = (part: string) => {
    if (part.length > MAX_BYTES) fail('invalid_request', 'Request exceeds translation bounds')
    charge(Buffer.byteLength(JSON.stringify(part)))
  }
  const clone = (part: Json, depth: number): Json => {
    if (++nodes > 100_000 || depth > 64)
      fail('invalid_request', 'Request exceeds translation bounds')
    if (typeof part === 'string') {
      string(part)
      return part
    }
    if (part === null || typeof part === 'boolean') {
      charge(5)
      return part
    }
    if (typeof part === 'number' && Number.isFinite(part)) {
      charge(String(part).length)
      return part
    }
    if (!part || typeof part !== 'object' || active.has(part))
      fail('invalid_request', 'Request must contain only JSON data')
    const array = Array.isArray(part),
      descriptors = dataDescriptors(part)
    active.add(part)
    charge(2)
    let result: Json
    if (array) {
      result = Array.from({ length: part.length }, (_, index) => {
        const descriptor = descriptors[String(index)]
        if (!descriptor) fail('invalid_request', 'Request must contain only JSON data')
        charge(1)
        return clone(descriptor.value as Json, depth + 1)
      })
    } else
      result = Object.fromEntries(
        Object.entries(descriptors)
          .filter(([, descriptor]) => descriptor.enumerable)
          .map(([key, descriptor]) => {
            string(key)
            charge(2)
            return [key, clone(descriptor.value as Json, depth + 1)]
          }),
      )
    active.delete(part)
    return result
  }
  return clone(value, 0)
}

function transformSchema(schema: Json, strict: boolean): Json {
  if (Array.isArray(schema)) return schema.map((part) => transformSchema(part, strict))
  const source = object(schema)
  if (!source) return schema
  const entries = Object.entries(source)
    .filter(([key]) => strict || key !== 'pattern')
    .map(([key, value]): [string, Json] => {
      if (schemaMaps.has(key) && object(value))
        return [
          key,
          Object.fromEntries(
            Object.entries(value as Obj).map(([name, part]) => [
              name,
              transformSchema(part, strict),
            ]),
          ),
        ]
      if (schemaLists.has(key) && Array.isArray(value))
        return [key, value.map((part) => transformSchema(part, strict))]
      if (schemaSingles.has(key) || key === 'items') return [key, transformSchema(value, strict)]
      return [key, value]
    })
  const result = Object.fromEntries(entries)
  if (strict && object(source.properties)) result.required = Object.keys(source.properties as Obj)
  return result
}

export function sanitizeToolSchema(schema: Json): Json {
  return transformSchema(cloneJson(schema), false)
}

export function normalizeStrictJsonSchema(schema: Json): Json {
  return transformSchema(cloneJson(schema), true)
}

export function translateTools(value: Json | undefined): Obj[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('invalid_request', 'Tools must be an array')
  const names = new Set<string>()
  return value.map((part) => {
    const tool = object(part)
    if (!tool) fail('invalid_request', 'Invalid tool definition')
    if (tool.type !== undefined && !['function', 'custom'].includes(String(tool.type)))
      fail('unsupported_tool', 'Hosted executable tools are unsupported')
    if (
      typeof tool.name !== 'string' ||
      !tool.name ||
      CONTROL.test(tool.name) ||
      names.has(tool.name)
    )
      fail('invalid_request', 'Invalid tool definition')
    names.add(tool.name)
    if (tool.description !== undefined && typeof tool.description !== 'string')
      fail('invalid_request', 'Invalid tool description')
    const parameters = tool.input_schema ?? {}
    if (!object(parameters) && typeof parameters !== 'boolean')
      fail('invalid_request', 'Invalid tool schema')
    return {
      type: 'function',
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: sanitizeToolSchema(parameters),
      strict: false,
    }
  })
}

export function translateToolChoice(
  value: Json | undefined,
  tools: Obj[],
): { choice: Json | undefined; parallel: boolean } {
  if (value === undefined) return { choice: undefined, parallel: true }
  const choice = object(value),
    type = typeof value === 'string' ? value : choice?.type
  const disable = choice?.disable_parallel_tool_use
  if (disable !== undefined && typeof disable !== 'boolean')
    fail('invalid_tool_choice', 'Invalid parallel tool choice')
  const parallel = disable !== true
  if (type === 'auto' || type === 'none') return { choice: type, parallel }
  if (type === 'any' || type === 'required') return { choice: 'required', parallel }
  if (
    type === 'tool' &&
    typeof choice?.name === 'string' &&
    tools.some((tool) => tool.name === choice.name)
  )
    return { choice: { type: 'function', name: choice.name }, parallel }
  return fail('invalid_tool_choice', 'Tool choice must name a registered caller tool')
}

export function imageUrl(value: Json | undefined): string {
  const source = object(value)
  if (source?.type === 'url' && typeof source.url === 'string') {
    if (Buffer.byteLength(source.url) > 8192 || CONTROL.test(source.url))
      fail('invalid_image', 'Invalid image URL')
    try {
      if (['http:', 'https:'].includes(new URL(source.url).protocol)) return source.url
    } catch {
      /* Invalid URLs are rejected without fetching them. */
    }
    return fail('invalid_image', 'Invalid image URL')
  }
  if (
    source?.type !== 'base64' ||
    typeof source.data !== 'string' ||
    typeof source.media_type !== 'string' ||
    !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(source.media_type)
  )
    return fail('invalid_image', 'Invalid image source')
  const data = source.data.replace(/[\t\n\r\f\v ]/g, '')
  if (
    !data ||
    data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data) ||
    data.length % 4 === 1 ||
    (data.includes('=') && data.length % 4 !== 0)
  )
    return fail('invalid_image', 'Invalid image encoding or size')
  const bytes = Buffer.from(data, 'base64'),
    canonical = bytes.toString('base64')
  if (
    bytes.length > MAX_IMAGE_BYTES ||
    canonical.replace(/=+$/, '') !== data.replace(/=+$/, '') ||
    (data.includes('=') && canonical !== data)
  )
    return fail('invalid_image', 'Invalid image encoding or size')
  return `data:${source.media_type};base64,${canonical}`
}
