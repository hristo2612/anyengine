import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { Json, Obj, TranslationContext } from '../src/vendor/claude-code-proxy/types.mjs'

const loadRequest = () => import('../src/vendor/claude-code-proxy/' + 'request.mjs')
const loadTools = () => import('../src/vendor/claude-code-proxy/' + 'tools.mjs')
const loadReasoning = () => import('../src/vendor/claude-code-proxy/' + 'reasoning.mjs')
const loadUsage = () => import('../src/vendor/claude-code-proxy/' + 'usage.mjs')
const context = (lite = false): TranslationContext => ({
  model: {
    requested: 'gpt-6.1-sol',
    upstream: 'gpt-6.1-sol',
    lite,
    effort: null,
    efforts: ['low', 'medium', 'high'],
  },
  sessionKey: 'session-a/agent-one',
})
const basic = (): Obj => ({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'Hello' }] })
const badRequest = (code: string) => (error: unknown) => {
  assert.ok(error instanceof Error)
  assert.equal((error as Error & { status: number }).status, 400)
  assert.equal((error as Error & { code: string }).code, code)
  assert.equal((error as Error & { type: string }).type, 'invalid_request_error')
  return true
}

// Removing the Lite tool prefix or changing call IDs breaks the client's tool round trip.
test('Lite preserves original tool names, arguments and matching results without Read guidance', async () => {
  const { translateRequest } = await loadRequest()
  const request: Obj = {
    model: 'gpt-6.1-sol',
    stream: true,
    system: [{ type: 'text', text: 'Be brief.' }],
    messages: [
      { role: 'user', content: 'Read marker.txt' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'Read',
            input: { file_path: 'marker.txt', offset: 0, limit: 7 },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'MARKER-42' }],
      },
    ],
    tools: [
      {
        name: 'Read',
        description: 'Caller description',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', pattern: '^/' },
            offset: { type: 'integer', description: 'Caller offset' },
          },
        },
      },
    ],
  }
  const before = structuredClone(request)
  const translated = translateRequest(request, context(true))
  assert.equal(translated.store, false)
  assert.equal(translated.stream, true)
  assert.equal(translated.prompt_cache_key, 'session-a/agent-one')
  assert.equal(translated.tools, undefined)
  assert.equal(translated.instructions, undefined)
  assert.equal(translated.parallel_tool_calls, false)
  assert.deepEqual(translated.client_metadata, {
    ws_request_header_x_openai_internal_codex_responses_lite: 'true',
  })
  assert.deepEqual(translated.reasoning, { context: 'all_turns' })
  assert.deepEqual(translated.input, [
    {
      type: 'additional_tools',
      role: 'developer',
      tools: [
        {
          type: 'function',
          name: 'Read',
          description: 'Caller description',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              offset: { type: 'integer', description: 'Caller offset' },
            },
          },
          strict: false,
        },
      ],
    },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Be brief.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read marker.txt' }] },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'Read',
      arguments: '{"file_path":"marker.txt","offset":0,"limit":7}',
    },
    { type: 'function_call_output', call_id: 'call_1', output: 'MARKER-42' },
  ])
  assert.deepEqual(request, before)
})

test('normal lane retains ordered text around calls and only caller-provided instructions', async () => {
  const { translateRequest } = await loadRequest()
  const request: Obj = {
    ...basic(),
    system: [
      { type: 'text', text: 'First' },
      { type: 'text', text: 'Second' },
    ],
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Before' },
          {
            type: 'tool_use',
            id: 'c',
            name: 'mcp__demo__Read',
            input: { pattern: 'literal', offset: -2 },
          },
          { type: 'text', text: 'After' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Left' },
          { type: 'tool_result', tool_use_id: 'c', content: 'Done' },
          { type: 'text', text: 'Right' },
        ],
      },
    ],
  }
  const translated = translateRequest(request, context())
  assert.equal(translated.instructions, 'First\nSecond')
  assert.equal(translated.tools, undefined)
  assert.deepEqual(translated.input, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Before' }] },
    {
      type: 'function_call',
      call_id: 'c',
      name: 'mcp__demo__Read',
      arguments: '{"pattern":"literal","offset":-2}',
    },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'After' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Left' }] },
    { type: 'function_call_output', call_id: 'c', output: 'Done' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Right' }] },
  ])
  assert.deepEqual((translateRequest(basic(), context(true)).input as Obj[])[0], {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'Hello' }],
  })
})

test('schema sanitizer traverses schema positions while preserving property names and literal data', async () => {
  const { sanitizeToolSchema } = await loadTools()
  const schema: Obj = {
    type: 'object',
    pattern: 'root',
    properties: {
      pattern: {
        type: 'string',
        pattern: 'x',
        default: { pattern: 'literal', properties: { pattern: 'still literal' } },
        examples: [{ pattern: 'example' }],
      },
      nested: {
        allOf: [{ pattern: 'nested' }],
        items: [{ pattern: 'tuple' }],
        additionalProperties: { pattern: 'additional' },
      },
    },
    $defs: { pattern: { pattern: 'definition' } },
    dependentSchemas: { dependency: { pattern: 'dependency' } },
    if: { pattern: 'if' },
    // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword
    then: { pattern: 'then' },
    else: { pattern: 'else' },
    unknown: { pattern: 'literal unknown' },
  }
  const before = structuredClone(schema)
  assert.deepEqual(sanitizeToolSchema(schema), {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        default: { pattern: 'literal', properties: { pattern: 'still literal' } },
        examples: [{ pattern: 'example' }],
      },
      nested: { allOf: [{}], items: [{}], additionalProperties: {} },
    },
    $defs: { pattern: {} },
    dependentSchemas: { dependency: {} },
    if: {},
    // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword
    then: {},
    else: {},
    unknown: { pattern: 'literal unknown' },
  })
  assert.deepEqual(schema, before)
})

test('schema cloning treats prototype keys as caller data and never mutates nested values', async () => {
  const { sanitizeToolSchema } = await loadTools()
  const schema = JSON.parse(
    '{"properties":{"__proto__":{"type":"string","pattern":"x"},"constructor":{"default":{"prototype":{"polluted":true}}}},"default":{"__proto__":{"polluted":true}}}',
  ) as Obj
  const clean = sanitizeToolSchema(schema) as Obj
  assert.equal(Object.hasOwn(clean.properties as Obj, '__proto__'), true)
  assert.deepEqual(Object.getOwnPropertyDescriptor(clean.properties, '__proto__')?.value, {
    type: 'string',
  })
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  const cleanDefault = Object.getOwnPropertyDescriptor(clean.default, '__proto__')?.value as Obj
  cleanDefault.polluted = false
  assert.equal(
    (Object.getOwnPropertyDescriptor(schema.default, '__proto__')?.value as Obj).polluted,
    true,
  )
})

test('all tool choices preserve caller parallel posture and reject a missing named tool', async () => {
  const { translateRequest } = await loadRequest()
  for (const [choice, expected] of [
    [{ type: 'auto' }, 'auto'],
    [{ type: 'any' }, 'required'],
    [{ type: 'none' }, 'none'],
    [
      { type: 'tool', name: 'mcp__demo__Lookup' },
      { type: 'function', name: 'mcp__demo__Lookup' },
    ],
  ] as [Obj, Json][]) {
    const request: Obj = {
      ...basic(),
      tools: [{ name: 'mcp__demo__Lookup', input_schema: { type: 'object' } }],
      tool_choice: { ...choice, disable_parallel_tool_use: true },
    }
    assert.deepEqual(translateRequest(request, context()).tool_choice, expected)
    assert.equal(translateRequest(request, context()).parallel_tool_calls, false)
    assert.equal(
      translateRequest(
        { ...request, tool_choice: { ...choice, disable_parallel_tool_use: false } },
        context(),
      ).parallel_tool_calls,
      true,
    )
  }
  assert.throws(
    () =>
      translateRequest({ ...basic(), tool_choice: { type: 'tool', name: 'Missing' } }, context()),
    badRequest('invalid_tool_choice'),
  )
  assert.throws(
    () => translateRequest({ ...basic(), tool_choice: { type: 'unexpected' } }, context()),
    badRequest('invalid_tool_choice'),
  )
})

test('hosted executable tools are refused while caller-executed WebSearch stays a function', async () => {
  const { translateRequest } = await loadRequest()
  for (const type of [
    'web_search_20250305',
    'web_search_20260209',
    'bash_20250124',
    'computer_20250124',
  ])
    assert.throws(
      () =>
        translateRequest(
          { ...basic(), tools: [{ type, name: 'run', input_schema: {} }] },
          context(),
        ),
      badRequest('unsupported_tool'),
    )
  const translated = translateRequest(
    {
      ...basic(),
      tools: [
        { name: 'WebSearch', description: 'Caller search', input_schema: { type: 'object' } },
      ],
    },
    context(),
  )
  assert.deepEqual(translated.tools, [
    {
      type: 'function',
      name: 'WebSearch',
      description: 'Caller search',
      parameters: { type: 'object' },
      strict: false,
    },
  ])
})

test('tool-result errors and image parts keep their original order and call identity', async () => {
  const { translateRequest } = await loadRequest()
  const request: Obj = {
    ...basic(),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'c',
            is_error: true,
            content: [
              { type: 'text', text: 'before' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } },
              { type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' } },
              { type: 'text', text: 'after' },
            ],
          },
        ],
      },
    ],
  }
  assert.deepEqual(translateRequest(request, context()).input, [
    {
      type: 'function_call_output',
      call_id: 'c',
      output: [
        { type: 'input_text', text: '[tool execution error]' },
        { type: 'input_text', text: 'before' },
        { type: 'input_image', image_url: 'data:image/png;base64,YQ==' },
        { type: 'input_image', image_url: 'https://example.invalid/image.png' },
        { type: 'input_text', text: 'after' },
      ],
    },
  ])
})

test('image validation rejects malformed encoding, media types, schemes and oversized data', async () => {
  const { translateRequest } = await loadRequest()
  for (const source of [
    { type: 'base64', media_type: 'image/svg+xml', data: 'YQ==' },
    { type: 'base64', media_type: 'image/png', data: '%%%=' },
    { type: 'base64', media_type: 'image/png', data: 'YR==' },
    { type: 'base64', media_type: 'image/png', data: '' },
    {
      type: 'base64',
      media_type: 'image/png',
      data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'),
    },
    { type: 'url', url: 'file:///private/image.png' },
    { type: 'url', url: 'https://example.invalid/\nimage' },
  ])
    assert.throws(
      () =>
        translateRequest(
          { ...basic(), messages: [{ role: 'user', content: [{ type: 'image', source }] }] },
          context(),
        ),
      badRequest('invalid_image'),
    )
  assert.deepEqual(
    translateRequest(
      {
        ...basic(),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ' } },
            ],
          },
        ],
      },
      context(),
    ).input,
    [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,YQ==' }],
      },
    ],
  )
})

test('unsupported or misplaced blocks fail rather than disappear from history', async () => {
  const { translateRequest } = await loadRequest()
  for (const content of [
    [{ type: 'document', source: {} }],
    [{ type: 'tool_use', id: 'c', name: 'Run', input: {} }],
  ])
    assert.throws(
      () => translateRequest({ ...basic(), messages: [{ role: 'user', content }] }, context()),
      badRequest('unsupported_content'),
    )
  assert.throws(
    () =>
      translateRequest(
        {
          ...basic(),
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'image', source: { type: 'url', url: 'https://example.invalid/x' } },
              ],
            },
          ],
        },
        context(),
      ),
    badRequest('unsupported_content'),
  )
  assert.throws(
    () => translateRequest({ ...basic(), system: [{ type: 'image' }] }, context()),
    badRequest('unsupported_content'),
  )
})

test('explicit reasoning effort uses supported catalog levels and adaptive thinking leaves defaults', async () => {
  const { translateRequest } = await loadRequest()
  const ctx = context()
  ctx.model.efforts = ['high', 'low', 'medium']
  assert.deepEqual(
    translateRequest({ ...basic(), output_config: { effort: 'max' } }, ctx).reasoning,
    { effort: 'high', summary: 'auto' },
  )
  assert.deepEqual(
    translateRequest({ ...basic(), output_config: { effort: 'low' } }, ctx).include,
    ['reasoning.encrypted_content'],
  )
  assert.equal(
    translateRequest({ ...basic(), thinking: { type: 'adaptive' } }, ctx).reasoning,
    undefined,
  )
  assert.throws(
    () => translateRequest({ ...basic(), output_config: { effort: 'xhigh' } }, ctx),
    badRequest('unsupported_effort'),
  )
  const none = context(true)
  none.model.efforts = ['none']
  assert.deepEqual(
    translateRequest({ ...basic(), output_config: { effort: 'none' } }, none).reasoning,
    { effort: 'none', context: 'all_turns' },
  )
  assert.equal(
    translateRequest({ ...basic(), output_config: { effort: 'none' } }, none).include,
    undefined,
  )
})

test('strict JSON output normalizes schema objects without rewriting literal defaults', async () => {
  const { translateRequest } = await loadRequest()
  const schema: Obj = {
    type: 'object',
    properties: {
      a: { type: 'string' },
      b: {
        type: 'object',
        properties: { x: { type: 'number' } },
        default: { properties: { literal: 1 } },
      },
    },
    required: ['a'],
  }
  const request = {
    ...basic(),
    output_config: { format: { type: 'json_schema', schema } },
    safeguards: { arbitrary: true },
    context_management: { edits: [] },
    betas: ['caller-beta'],
  }
  const translated = translateRequest(request, context())
  assert.deepEqual(translated.text, {
    verbosity: 'low',
    format: {
      type: 'json_schema',
      name: 'response',
      schema: {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: {
            type: 'object',
            properties: { x: { type: 'number' } },
            required: ['x'],
            default: { properties: { literal: 1 } },
          },
        },
        required: ['a', 'b'],
      },
      strict: true,
    },
  })
  assert.equal(translated.safeguards, undefined)
  assert.equal(translated.context_management, undefined)
  assert.equal(translated.betas, undefined)
  assert.deepEqual(schema.required, ['a'])
})

test('request cloning rejects accessors, cycles, non-JSON values and excessive nesting or bytes', async () => {
  const { translateRequest } = await loadRequest()
  let invoked = false
  const accessor = Object.defineProperty(basic(), 'extra', {
    enumerable: true,
    get() {
      invoked = true
      return 'bad'
    },
  })
  assert.throws(() => translateRequest(accessor, context()), badRequest('invalid_request'))
  assert.equal(invoked, false)
  const cyclic = basic()
  cyclic.extra = cyclic
  assert.throws(() => translateRequest(cyclic, context()), badRequest('invalid_request'))
  assert.throws(
    () => translateRequest({ ...basic(), extra: new Date() as unknown as Json }, context()),
    badRequest('invalid_request'),
  )
  let nested: Json = 'end'
  for (let i = 0; i < 70; i++) nested = { nested }
  assert.throws(
    () => translateRequest({ ...basic(), nested }, context()),
    badRequest('invalid_request'),
  )
  assert.throws(
    () => translateRequest({ ...basic(), extra: 'x'.repeat(32 * 1024 * 1024 + 1) }, context()),
    badRequest('invalid_request'),
  )
})

test('reasoning signatures use exact unpadded base64url IDs and opaque ciphertext', async () => {
  const { encodeReasoning, decodeReasoning } = await loadReasoning()
  assert.equal(encodeReasoning('rs_1', 'opaque:fixture'), 'ccp:codex:v1:cnNfMQ:opaque:fixture')
  assert.deepEqual(decodeReasoning('ccp:codex:v1:cnNfMQ:opaque:fixture'), {
    id: 'rs_1',
    encrypted_content: 'opaque:fixture',
  })
  for (const signature of [
    'anthropic-signature',
    'ccp:codex:v1:cnNfMQ',
    'ccp:codex:v1:cnNfMQ:',
    'ccp:codex:v1:!!!!:opaque',
    'ccp:codex:v1:cnNfMQ==:opaque',
    'ccp:codex:v1:YR:opaque',
    'ccp:codex:v1:_w:opaque',
  ])
    assert.equal(decodeReasoning(signature), null, signature)
})

test('reasoning byte limits reject oversized UTF-8 IDs and ciphertext before replay', async () => {
  const { encodeReasoning, decodeReasoning } = await loadReasoning()
  assert.ok(encodeReasoning('é'.repeat(2048), 'x'))
  assert.equal(encodeReasoning('é'.repeat(2049), 'x'), null)
  assert.equal(encodeReasoning('id', 'é'.repeat(4 * 1024 * 1024 + 1)), null)
  assert.equal(encodeReasoning('', 'x'), null)
  assert.equal(encodeReasoning('id', ''), null)
  assert.equal(decodeReasoning(`ccp:codex:v1:${'A'.repeat(6000)}:x`), null)
  assert.equal(decodeReasoning(`ccp:codex:v1:aWQ:${'x'.repeat(8 * 1024 * 1024 + 1)}`), null)
})

test('resumed history replays only validated owned reasoning without modifying foreign signatures', async () => {
  const { translateRequest } = await loadRequest()
  const request: Obj = {
    ...basic(),
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Before' },
          { type: 'thinking', thinking: 'hidden', signature: 'ccp:codex:v1:cnNfMQ:opaque-fixture' },
          { type: 'thinking', thinking: 'foreign', signature: 'anthropic-signature' },
          { type: 'thinking', thinking: 'missing' },
          { type: 'text', text: 'After' },
        ],
      },
    ],
  }
  const before = structuredClone(request)
  assert.deepEqual(translateRequest(request, context()).input, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Before' }] },
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-fixture' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'After' }] },
  ])
  assert.deepEqual(request, before)
})

test('usage maps authoritative cached tokens with saturating subtraction and no reasoning double count', async () => {
  const { mapUsage } = await loadUsage()
  assert.deepEqual(
    mapUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 75 },
      output_tokens: 8,
      output_tokens_details: { reasoning_tokens: 3 },
    }),
    {
      input_tokens: 25,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 75,
      output_tokens: 8,
    },
  )
  assert.deepEqual(
    mapUsage({ input_tokens: 5, input_tokens_details: { cached_tokens: 9 }, output_tokens: 2 }),
    {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 9,
      output_tokens: 2,
    },
  )
  assert.deepEqual(mapUsage({}), {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  })
})

test('captured session and agent headers produce separate stable cache identities', async () => {
  const { sessionKey } = await loadRequest()
  const headers = { 'x-claude-code-session-id': 'session-a', 'x-claude-code-agent-id': 'agent-one' }
  const expected = createHash('sha256').update('claude-code\0session-a\0agent-one').digest('hex')
  assert.equal(sessionKey(headers, basic()), expected)
  assert.equal(sessionKey(headers, { ...basic(), messages: [] }), expected)
  assert.notEqual(
    sessionKey({ ...headers, 'x-claude-code-agent-id': 'agent-two' }, basic()),
    expected,
  )
  assert.notEqual(
    sessionKey(
      { 'x-claude-code-session-id': 'session-b', 'x-claude-code-agent-id': 'agent-one' },
      basic(),
    ),
    expected,
  )
  assert.equal(
    sessionKey(
      { 'X-Claude-Code-Session-Id': ['session-a'], 'X-Claude-Code-Agent-Id': 'agent-one' },
      basic(),
    ),
    expected,
  )
})

test('unproven metadata identity stays fresh and malformed identity headers are rejected', async () => {
  const { sessionKey } = await loadRequest()
  const request = { ...basic(), metadata: { session_id: 'unproven' } }
  assert.notEqual(sessionKey({}, request), sessionKey({}, request))
  for (const value of ['x\n', '\u0000', '\u2028', 'é'.repeat(129), ['a', 'b']])
    assert.throws(
      () => sessionKey({ 'x-claude-code-session-id': value }, basic()),
      badRequest('invalid_identity'),
    )
  assert.throws(
    () => sessionKey({ 'x-claude-code-session-id': 'a', 'X-Claude-Code-Session-Id': 'b' }, basic()),
    badRequest('invalid_identity'),
  )
})

test('pinned real-proxy request fixtures match apart from explicit Read and cache-key deltas', async () => {
  const { translateRequest } = await loadRequest()
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../test/fixtures/raine-translation-v0.1.42.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: { id: string; input: Obj; upstream: { requests: { json: Obj }[] } }[] }
  for (const sample of fixture.cases) {
    const expected = structuredClone(sample.upstream.requests[0]?.json)
    assert.ok(expected)
    expected.prompt_cache_key = 'fixture-cache'
    if (sample.id === 'read-rewrite')
      expected.tools = [
        {
          type: 'function',
          name: 'Read',
          description: 'Original read description',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              offset: { type: 'integer', description: 'original offset' },
              limit: { type: 'integer', description: 'original limit' },
            },
          },
          strict: false,
        },
      ]
    const ctx = context()
    ctx.model.requested = 'gpt-5.5'
    ctx.model.upstream = 'gpt-5.5'
    ctx.sessionKey = 'fixture-cache'
    assert.deepEqual(translateRequest(sample.input, ctx), expected, sample.id)
  }
})

test('omitted tool-result content preserves an empty matching output without accepting malformed null', async () => {
  const { translateRequest } = await loadRequest()
  const request: Obj = {
    ...basic(),
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'empty-call' }] }],
  }
  assert.deepEqual(translateRequest(request, context()).input, [
    { type: 'function_call_output', call_id: 'empty-call', output: '' },
  ])
  assert.deepEqual(
    translateRequest(
      {
        ...request,
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'empty-error', is_error: true }],
          },
        ],
      },
      context(),
    ).input,
    [{ type: 'function_call_output', call_id: 'empty-error', output: '[tool execution error]\n' }],
  )
  assert.throws(
    () =>
      translateRequest(
        {
          ...request,
          messages: [
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'empty-call', content: null }],
            },
          ],
        },
        context(),
      ),
    badRequest('unsupported_content'),
  )
})
