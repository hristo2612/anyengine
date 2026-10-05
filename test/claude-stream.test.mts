import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type {
  Obj,
  StreamEvent,
  TranslationFailure,
} from '../src/vendor/claude-code-proxy/types.mjs'

interface Translator {
  push(event: Obj): StreamEvent[]
  end(): StreamEvent[]
  readonly finished: boolean
}
interface Frame {
  event: string | null
  data: string
}
interface Parser {
  push(chunk: Uint8Array): Frame[]
  end(): Frame[]
}
async function api() {
  const [stream, errors, sse] = await Promise.all([
    import(new URL('../src/vendor/claude-code-proxy/stream.mjs', import.meta.url).href),
    import(new URL('../src/vendor/claude-code-proxy/errors.mjs', import.meta.url).href),
    import(new URL('../src/vendor/claude-code-proxy/sse.mjs', import.meta.url).href),
  ])
  return {
    createStreamTranslator: stream.createStreamTranslator as (
      model: string,
      id: string,
    ) => Translator,
    mapFailure: errors.mapFailure as (
      status: number,
      body: Obj,
      retryAfter?: string,
    ) => TranslationFailure,
    createSseParser: sse.createSseParser as () => Parser,
  }
}
const terminal = (extra: Obj = {}): Obj => ({
  type: 'response.completed',
  response: {
    status: 'completed',
    usage: { input_tokens: 100, output_tokens: 9, input_tokens_details: { cached_tokens: 20 } },
    ...extra,
  },
})
function text(stream: Translator, delta = 'hello', index = 0): StreamEvent[] {
  return stream.push({
    type: 'response.output_text.delta',
    output_index: index,
    item_id: 'message_1',
    delta,
  })
}
function failure(code: string, status = 502) {
  return (error: unknown) => {
    assert.ok(error instanceof Error)
    const value = error as Error & TranslationFailure
    assert.equal(value.code, code)
    assert.equal(value.status, status)
    return true
  }
}

test('requested alias is echoed and terminal usage replaces initial placeholders', async () => {
  const { createStreamTranslator } = await api()
  const stream = createStreamTranslator('gpt-6.1-sol[1m]', 'msg_test')
  const start = stream.push({ type: 'response.created', response: { id: 'response_1' } })
  assert.equal((start[0]?.data.message as Obj).model, 'gpt-6.1-sol[1m]')
  assert.deepEqual((start[0]?.data.message as Obj).usage, { input_tokens: 0, output_tokens: 0 })
  text(stream)
  const end = stream.push(terminal())
  const last = end.find((event) => event.event === 'message_delta')
  assert.deepEqual(last?.data.usage, {
    input_tokens: 80,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 20,
    output_tokens: 9,
  })
  assert.deepEqual(last?.data.delta, { stop_reason: 'end_turn', stop_sequence: null })
  assert.equal(end.filter((event) => event.event === 'message_stop').length, 1)
  assert.equal(stream.finished, true)
  assert.deepEqual(stream.end(), [])
  assert.deepEqual(stream.push(terminal()), [])
})

const fixture = JSON.parse(
  readFileSync(
    new URL('../../test/fixtures/raine-translation-v0.1.42.json', import.meta.url),
    'utf8',
  ),
) as {
  cases: Array<{ id: string; backend: { events?: Obj[] }; output: { body: string } }>
}
for (const id of [
  'text-stream',
  'tool-call',
  'tool-result',
  'image',
  'cached-usage',
  'reasoning-replay',
]) {
  test(`pinned ${id} keeps substantive content, block order and final usage`, async () => {
    const { createStreamTranslator, createSseParser } = await api()
    const sample = fixture.cases.find((row) => row.id === id)
    assert.ok(sample?.backend.events)
    const stream = createStreamTranslator('gpt-5.5', 'msg_fixture')
    const got = sample.backend.events.flatMap((event) => stream.push(event))
    stream.end()
    const parser = createSseParser()
    const expected = [...parser.push(Buffer.from(sample.output.body)), ...parser.end()].map(
      (frame) => ({ event: frame.event, data: JSON.parse(frame.data) }),
    )
    // Explicit delta: no estimated startup usage and no transport heartbeat
    // duplication. Compare the pinned semantic output and authoritative totals.
    const substantive = (events: StreamEvent[]) =>
      events.filter((event) => !['message_start', 'ping'].includes(event.event))
    assert.deepEqual(substantive(got), substantive(expected as StreamEvent[]))
  })
}

test('tool blocks preserve names/IDs, item-only correlation, exact argument fragments and one close', async () => {
  const { createStreamTranslator } = await api()
  const stream = createStreamTranslator('gpt-test', 'msg_tool')
  const added: Obj = {
    type: 'response.output_item.added',
    output_index: 7,
    item: { type: 'function_call', id: 'item_a', call_id: 'call_a', name: 'Read', arguments: '' },
  }
  const start = stream.push(added)
  assert.deepEqual(
    start.find((event) => event.event === 'content_block_start')?.data.content_block,
    { type: 'tool_use', id: 'call_a', name: 'Read', input: {} },
  )
  assert.deepEqual(stream.push(added), [])
  const parts = ['{"file_path":', '"marker.txt","offset":0}']
  for (const delta of parts) {
    const chunk = stream.push({
      type: 'response.function_call_arguments.delta',
      item_id: 'item_a',
      delta,
    })
    assert.deepEqual(chunk.at(-1)?.data.delta, { type: 'input_json_delta', partial_json: delta })
  }
  const done: Obj = {
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      id: 'item_a',
      call_id: 'call_a',
      name: 'Read',
      arguments: parts.join(''),
    },
  }
  const close = stream.push(done)
  assert.equal(close.filter((event) => event.event === 'content_block_stop').length, 1)
  assert.deepEqual(stream.push(done), [])
  const end = stream.push(terminal())
  assert.equal(
    (end.find((event) => event.event === 'message_delta')?.data.delta as Obj).stop_reason,
    'tool_use',
  )
  assert.equal(end.filter((event) => event.event === 'content_block_stop').length, 0)
})

test('done-only tool arguments are emitted and validated before block stop', async () => {
  const { createStreamTranslator } = await api()
  const stream = createStreamTranslator('gpt-test', 'msg_tool')
  stream.push({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', id: 'i', call_id: 'c', name: 'Lookup', arguments: '' },
  })
  const got = stream.push({
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'function_call',
      id: 'i',
      call_id: 'c',
      name: 'Lookup',
      arguments: '{"q":"fixture"}',
    },
  })
  assert.deepEqual(
    got.map((event) => event.event),
    ['content_block_delta', 'content_block_stop'],
  )
  assert.deepEqual(got[0]?.data.delta, {
    type: 'input_json_delta',
    partial_json: '{"q":"fixture"}',
  })
})

test('reasoning retains added encryption when done omits it, emits signature before stop', async () => {
  const { createStreamTranslator } = await api()
  const stream = createStreamTranslator('gpt-test', 'msg_reasoning')
  stream.push({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-fixture' },
  })
  const thinking = stream.push({
    type: 'response.reasoning_summary_text.delta',
    item_id: 'rs_1',
    delta: 'plan',
  })
  assert.deepEqual(thinking.at(-1)?.data.delta, { type: 'thinking_delta', thinking: 'plan' })
  const got = stream.push({
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'reasoning', id: 'rs_1' },
  })
  assert.deepEqual(
    got.map((event) => event.event),
    ['content_block_delta', 'content_block_stop'],
  )
  assert.deepEqual(got[0]?.data.delta, {
    type: 'signature_delta',
    signature: 'ccp:codex:v1:cnNfMQ:opaque-fixture',
  })
  assert.deepEqual(
    stream.push({
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_1' },
    }),
    [],
  )
  text(stream, 'answer', 1)
  stream.push(terminal())
})

test('signature-only reasoning preserves replay and never closes unsigned thinking', async () => {
  const { createStreamTranslator } = await api()
  const signed = createStreamTranslator('gpt-test', 'msg_signed')
  const got = signed.push({
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-fixture' },
  })
  assert.deepEqual(
    got.filter((event) => event.event.startsWith('content_block')).map((event) => event.event),
    ['content_block_start', 'content_block_delta', 'content_block_stop'],
  )
  const unsigned = createStreamTranslator('gpt-test', 'msg_unsigned')
  unsigned.push({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'plan' })
  assert.throws(
    () =>
      unsigned.push({
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1' },
      }),
    failure('invalid_stream'),
  )
})

test('EOF remains failure after text or a completely closed tool without authoritative terminal', async () => {
  const { createStreamTranslator } = await api()
  for (const tool of [false, true]) {
    const stream = createStreamTranslator('gpt-test', 'msg_eof')
    if (tool)
      stream.push({
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: 'i', call_id: 'c', name: 'Lookup', arguments: '{}' },
      })
    else text(stream)
    assert.throws(() => stream.end(), failure('incomplete_stream'))
    assert.equal(stream.finished, false)
  }
})

test('standard max_output_tokens incomplete is the sole accepted incomplete terminal', async () => {
  const { createStreamTranslator } = await api()
  const stream = createStreamTranslator('gpt-test', 'msg_max')
  text(stream)
  const event = terminal({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
  })
  event.type = 'response.incomplete'
  const got = stream.push(event)
  assert.equal(
    (got.find((value) => value.event === 'message_delta')?.data.delta as Obj).stop_reason,
    'max_tokens',
  )
  assert.equal(stream.finished, true)
})

for (const [label, event, code] of [
  ['missing usage', terminal({ usage: null }), 'missing_usage'],
  ['negative usage', terminal({ usage: { input_tokens: 10, output_tokens: -1 } }), 'missing_usage'],
  ['empty completion', terminal(), 'empty_response'],
  [
    'content filter',
    {
      ...terminal({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
      type: 'response.incomplete',
    },
    'incomplete_stream',
  ],
  [
    'contradictory max terminal',
    {
      ...terminal({ status: 'completed', incomplete_details: { reason: 'max_output_tokens' } }),
      type: 'response.incomplete',
    },
    'incomplete_stream',
  ],
  [
    'completed with incomplete details',
    terminal({ incomplete_details: { reason: 'max_output_tokens' } }),
    'incomplete_stream',
  ],
] as Array<[string, Obj, string]>) {
  test(`terminal rejects ${label}`, async () => {
    const { createStreamTranslator } = await api()
    const stream = createStreamTranslator('gpt-test', 'msg_bad')
    if (label !== 'empty completion') text(stream)
    assert.throws(() => stream.push(event), failure(code))
    assert.equal(stream.finished, false)
  })
}

test('malformed arguments, identity conflicts and oversized UTF8 args are stable stream failures', async () => {
  const { createStreamTranslator } = await api()
  const bad = createStreamTranslator('gpt-test', 'msg_bad')
  bad.push({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', id: 'i', call_id: 'c', name: 'Read', arguments: '' },
  })
  bad.push({
    type: 'response.function_call_arguments.delta',
    output_index: 0,
    delta: '{"FAKE-SECRET":',
  })
  assert.throws(
    () =>
      bad.push({
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: 'i', call_id: 'c', name: 'Read' },
      }),
    (error) =>
      failure('invalid_stream')(error) && !(error as Error).message.includes('FAKE-SECRET'),
  )
  const mismatch = createStreamTranslator('gpt-test', 'msg_mismatch')
  mismatch.push({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', id: 'i', call_id: 'c', name: 'Read' },
  })
  assert.throws(
    () =>
      mismatch.push({
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: 'i', call_id: 'other', name: 'Read', arguments: '{}' },
      }),
    failure('invalid_stream'),
  )
  const huge = createStreamTranslator('gpt-test', 'msg_huge')
  huge.push({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', id: 'i', call_id: 'c', name: 'Lookup' },
  })
  assert.throws(
    () =>
      huge.push({
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '😀'.repeat((5 * 1024 * 1024) / 4 + 1),
      }),
    failure('tool_arguments_too_large'),
  )
})

test('terminal nested quota failure preserves 429 and cannot finish successfully', async () => {
  const { createStreamTranslator } = await api()
  const stream = createStreamTranslator('gpt-test', 'msg_error')
  text(stream)
  assert.throws(
    () => stream.push(terminal({ error: { code: 'usage_limit_reached', message: 'FAKE-SECRET' } })),
    failure('usage_limit_reached', 429),
  )
  assert.equal(stream.finished, false)
})

for (const [status, backendCode, wantStatus, wantType, wantCode] of [
  [400, 'context_length_exceeded', 400, 'invalid_request_error', 'context_length_exceeded'],
  [413, 'unknown', 400, 'invalid_request_error', 'context_length_exceeded'],
  [429, 'usage_limit_reached', 429, 'rate_limit_error', 'usage_limit_reached'],
  [401, 'unknown', 401, 'authentication_error', 'authentication_required'],
  [403, 'unknown', 403, 'permission_error', 'permission_denied'],
  [503, 'server_is_overloaded', 529, 'overloaded_error', 'overloaded'],
  [504, 'unknown', 504, 'api_error', 'upstream_timeout'],
  [400, 'unsupported_tool', 400, 'invalid_request_error', 'unsupported_tool'],
  [500, 'FAKE-SECRET', 502, 'api_error', 'upstream_error'],
] as Array<[number, string, number, string, string]>) {
  test(`safe backend failure ${status}/${wantCode}`, async () => {
    const { mapFailure } = await api()
    const body = {
      error: {
        code: backendCode,
        message: status === 413 ? 'context window exceeded FAKE-SECRET' : 'FAKE-SECRET',
      },
    }
    const got = mapFailure(status, body, '15')
    assert.equal(got.status, wantStatus)
    assert.equal(got.type, wantType)
    assert.equal(got.code, wantCode)
    if (wantCode === 'context_length_exceeded')
      assert.equal(got.message, 'prompt is too long: context length exceeded')
    if (wantStatus === 401) assert.equal(got.message, 'Run codex login')
    assert.equal(JSON.stringify(got).includes('FAKE-SECRET'), false)
    assert.equal(got.retryAfter, wantStatus === 429 || wantStatus === 529 ? '15' : null)
  })
}

test('Retry-After accepts only bounded valid delta-seconds or an HTTP date', async () => {
  const { mapFailure } = await api()
  const date = 'Sun, 06 Nov 1994 08:49:37 GMT'
  assert.equal(mapFailure(429, {}, date).retryAfter, date)
  for (const invalid of [
    '15\r\nAuthorization: FAKE-SECRET',
    '-1',
    '1.5',
    'x'.repeat(200),
    'FAKE-SECRET',
  ])
    assert.equal(mapFailure(429, {}, invalid).retryAfter, null)
})

test('SSE supports every byte split through UTF8, CRLF, comments and multi-line data', async () => {
  const { createSseParser } = await api()
  const bytes = Buffer.from(
    ': comment\r\nevent: first\r\ndata:  hé😀\r\ndata: second\r\n\r\ndata: tail\n\n',
  )
  const expected = [
    { event: 'first', data: ' hé😀\nsecond' },
    { event: null, data: 'tail' },
  ]
  for (let split = 0; split <= bytes.length; split++) {
    const parser = createSseParser()
    assert.deepEqual(
      [
        ...parser.push(bytes.subarray(0, split)),
        ...parser.push(bytes.subarray(split)),
        ...parser.end(),
      ],
      expected,
    )
  }
})

test('SSE waits for a frame separator and rejects incomplete framing or invalid UTF8', async () => {
  const { createSseParser } = await api()
  const parser = createSseParser()
  assert.deepEqual(parser.push(Buffer.from('data: {}\n')), [])
  assert.throws(() => parser.end(), failure('incomplete_stream'))
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xf0, 0x9f])]) {
    const invalid = createSseParser()
    assert.throws(() => {
      invalid.push(bytes)
      invalid.end()
    }, failure('invalid_stream'))
  }
})

test('SSE uses last event field, preserves data spacing, and bounds each frame in bytes', async () => {
  const { createSseParser } = await api()
  const parser = createSseParser()
  assert.deepEqual(parser.push(Buffer.from('event: old\ndata: one\nevent: new\ndata:  two\n\n')), [
    { event: 'new', data: 'one\n two' },
  ])
  const huge = createSseParser()
  assert.throws(
    () => huge.push(Buffer.from(`data: ${'😀'.repeat((8 * 1024 * 1024) / 4 + 1)}`)),
    failure('sse_frame_too_large'),
  )
  const many = createSseParser()
  const frame = `data: ${'x'.repeat(4 * 1024 * 1024)}\n\n`
  assert.equal(many.push(Buffer.from(frame.repeat(2))).length, 2)
})
