import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import type { ServerResponse } from 'node:http'
import test from 'node:test'
import type {
  Obj,
  StreamEvent,
  TranslationFailure,
} from '../src/vendor/claude-code-proxy/types.mjs'

interface Output {
  accept(event: StreamEvent): Promise<void>
  finish(): Promise<void>
  error(failure: TranslationFailure): Promise<void>
  dispose(): void
  readonly semantic: boolean
}

async function factory() {
  const module = await import('../src/' + 'claude-gpt-output.mjs')
  return module.createGptOutput as (input: {
    res: ServerResponse
    streaming: boolean
    signal: AbortSignal
  }) => Output
}

class Response extends EventEmitter {
  statusCode = 200
  headersSent = false
  destroyed = false
  writableEnded = false
  writableFinished = false
  blocked = false
  endCalls = 0
  chunks: string[] = []
  headers = new Map<string, string | number | readonly string[]>()

  setHeader(name: string, value: string | number | readonly string[]) {
    assert.equal(this.headersSent, false, 'headers must precede entity bytes')
    this.headers.set(name.toLowerCase(), value)
    return this
  }

  write(chunk: string | Uint8Array) {
    assert.equal(this.writableEnded || this.destroyed, false, 'no write after closure')
    this.headersSent = true
    this.chunks.push(String(chunk))
    return !this.blocked
  }

  end(chunk?: string | Uint8Array) {
    if (chunk !== undefined) this.write(chunk)
    this.headersSent = true
    this.writableEnded = true
    this.writableFinished = true
    this.endCalls++
    this.emit('finish')
    return this
  }

  close() {
    this.destroyed = true
    this.emit('close')
  }

  get body() {
    return this.chunks.join('')
  }
}

async function setup(streaming = true) {
  const res = new Response()
  const controller = new AbortController()
  const output = (await factory())({
    res: res as unknown as ServerResponse,
    streaming,
    signal: controller.signal,
  })
  return { res, controller, output }
}

function event(name: string, data: Obj = {}): StreamEvent {
  return { event: name, data: { type: name, ...data } }
}

function start(id = 'msg_output'): StreamEvent {
  return event('message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'gpt-6.1-sol[1m]',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
}

function block(index = 0, content: Obj = { type: 'text', text: '' }): StreamEvent {
  return event('content_block_start', { index, content_block: content })
}

function delta(index: number, value: Obj): StreamEvent {
  return event('content_block_delta', { index, delta: value })
}

function terminal(stopReason = 'end_turn'): StreamEvent[] {
  return [
    event('message_delta', {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: 80,
        output_tokens: 9,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 0,
      },
    }),
    event('message_stop'),
  ]
}

async function accept(output: Output, events: StreamEvent[]) {
  for (const value of events) await output.accept(value)
}

async function completeText(output: Output, text = 'hello') {
  await accept(output, [
    start(),
    block(),
    delta(0, { type: 'text_delta', text }),
    event('content_block_stop', { index: 0 }),
    ...terminal(),
  ])
  await output.finish()
}

function failure(status = 429, retryAfter: string | null = '15'): TranslationFailure {
  return {
    status,
    type: status === 401 ? 'authentication_error' : 'rate_limit_error',
    code: status === 401 ? 'authentication_required' : 'usage_limit_reached',
    message: status === 401 ? 'Run codex login' : 'GPT rate limit exceeded',
    retryAfter,
  }
}

function frames(res: Response): StreamEvent[] {
  return res.body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split('\n')
      assert.equal(lines.length, 2)
      assert.match(lines[0] ?? '', /^event: /)
      assert.match(lines[1] ?? '', /^data: /)
      return {
        event: lines[0]?.slice(7) ?? '',
        data: JSON.parse(lines[1]?.slice(6) ?? '') as Obj,
      }
    })
}

function clean(res: Response, controller: AbortController) {
  assert.equal(res.listenerCount('drain'), 0)
  assert.equal(res.listenerCount('close'), 0)
  assert.equal(res.listenerCount('error'), 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
}

test('message_start and upstream ping stay buffered and can be discarded before an auth retry', async () => {
  const { res, controller, output } = await setup()
  await output.accept(start('msg_discarded'))
  await output.accept(event('ping'))
  assert.equal(output.semantic, false)
  assert.equal(res.headersSent, false)
  assert.equal(res.body, '')
  output.dispose()
  clean(res, controller)
  const retry = (await factory())({
    res: res as unknown as ServerResponse,
    streaming: true,
    signal: controller.signal,
  })
  await completeText(retry, 'retry output')
  assert.equal(res.body.includes('msg_discarded'), false)
  assert.equal(frames(res).filter((value) => value.event === 'message_start').length, 1)
  clean(res, controller)
})

test('streaming emits exact Anthropic framing with requested alias, escaped text and final usage', async () => {
  const { res, controller, output } = await setup()
  await completeText(output, 'héllo\n世界')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  const values = frames(res)
  assert.deepEqual(
    values.map((value) => value.event),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  )
  assert.equal((values[0]?.data.message as Obj).model, 'gpt-6.1-sol[1m]')
  assert.equal((values[2]?.data.delta as Obj).text, 'héllo\n世界')
  assert.deepEqual(values[4]?.data.usage, terminal()[0]?.data.usage)
  assert.equal(output.semantic, true)
  assert.equal(res.endCalls, 1)
  await output.finish()
  assert.equal(res.endCalls, 1)
  clean(res, controller)
})

test('content_block_start immediately makes both streaming and nonstreaming output semantic', async () => {
  for (const streaming of [true, false]) {
    const { res, controller, output } = await setup(streaming)
    await output.accept(start())
    await output.accept(block(0, { type: 'tool_use', id: 'call_empty', name: 'Read', input: {} }))
    assert.equal(output.semantic, true)
    assert.equal(res.headersSent, streaming)
    controller.abort()
    clean(res, controller)
  }
})

test('nonstreaming aggregates text, untouched tool JSON, thinking and signature into one message', async () => {
  const { res, controller, output } = await setup(false)
  const signature = 'ccp:codex:v1:cnNfMQ:ciphertext:tail'
  await accept(output, [
    start(),
    block(0, { type: 'thinking', thinking: '', signature: '' }),
    delta(0, { type: 'thinking_delta', thinking: 'reason' }),
    delta(0, { type: 'signature_delta', signature }),
    event('content_block_stop', { index: 0 }),
    block(1),
    delta(1, { type: 'text_delta', text: 'first ' }),
    delta(1, { type: 'text_delta', text: 'second' }),
    event('content_block_stop', { index: 1 }),
    block(2, { type: 'tool_use', id: 'call_read', name: 'mcp__files__Read', input: {} }),
    delta(2, { type: 'input_json_delta', partial_json: '{"file_path":"./note",' }),
    delta(2, {
      type: 'input_json_delta',
      partial_json: '"offset":-4,"__proto__":{"polluted":true}}',
    }),
    event('content_block_stop', { index: 2 }),
    ...terminal('tool_use'),
  ])
  assert.equal(res.headersSent, false)
  await output.finish()
  const message = JSON.parse(res.body) as Obj
  assert.deepEqual(message, {
    id: 'msg_output',
    type: 'message',
    role: 'assistant',
    model: 'gpt-6.1-sol[1m]',
    content: [
      { type: 'thinking', thinking: 'reason', signature },
      { type: 'text', text: 'first second' },
      {
        type: 'tool_use',
        id: 'call_read',
        name: 'mcp__files__Read',
        input: JSON.parse('{"file_path":"./note","offset":-4,"__proto__":{"polluted":true}}'),
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: terminal()[0]?.data.usage,
  })
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.equal(res.headers.get('content-type'), 'application/json')
  assert.equal(res.endCalls, 1)
  clean(res, controller)
})

test('nonstreaming never publishes partial success after a failed stream', async () => {
  const { res, controller, output } = await setup(false)
  await accept(output, [start(), block(), delta(0, { type: 'text_delta', text: 'partial secret' })])
  await output.error(failure())
  assert.equal(res.statusCode, 429)
  assert.equal(res.body.includes('partial secret'), false)
  assert.equal(res.body.includes('PRIVATE-FAKE-BEARER'), false)
  assert.deepEqual(JSON.parse(res.body), {
    type: 'error',
    error: {
      type: 'rate_limit_error',
      code: 'usage_limit_reached',
      message: 'GPT rate limit exceeded',
    },
  })
  assert.equal(res.headers.get('retry-after'), '15')
  clean(res, controller)
})

test('presemantic authentication failure is JSON and discards buffered message_start', async () => {
  const { res, controller, output } = await setup()
  await output.accept(start())
  await output.error(failure(401))
  assert.equal(res.statusCode, 401)
  assert.equal(res.body.includes('msg_output'), false)
  assert.deepEqual(JSON.parse(res.body), {
    type: 'error',
    error: {
      type: 'authentication_error',
      code: 'authentication_required',
      message: 'Run codex login',
    },
  })
  assert.equal(res.headers.has('retry-after'), false)
  clean(res, controller)
})

test('after streaming headers an error emits once, closes, and never emits message_stop', async () => {
  const { res, controller, output } = await setup()
  await accept(output, [start(), block(), delta(0, { type: 'text_delta', text: 'partial' })])
  await output.error(failure())
  await output.error(failure())
  await output.finish()
  const values = frames(res)
  assert.equal(values.filter((value) => value.event === 'error').length, 1)
  assert.equal(
    values.some((value) => value.event === 'message_stop'),
    false,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers.has('retry-after'), false)
  assert.equal(res.body.includes('PRIVATE-FAKE-BEARER'), false)
  assert.equal(res.endCalls, 1)
  clean(res, controller)
})

test('unsafe Retry-After never becomes a response header', async () => {
  for (const retryAfter of ['15\r\nx-secret: marker', '-1', 'x'.repeat(129)]) {
    const { res, controller, output } = await setup()
    await output.error(failure(429, retryAfter))
    assert.equal(res.headers.has('retry-after'), false)
    assert.equal(res.body.includes('PRIVATE-FAKE-BEARER'), false)
    clean(res, controller)
  }
})

test('safe local 400 failure codes and fixed messages are preserved', async () => {
  const { res, controller, output } = await setup()
  await output.error({
    status: 400,
    type: 'invalid_request_error',
    code: 'unsupported_effort',
    message: 'Unsupported GPT reasoning effort',
    retryAfter: null,
  })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(JSON.parse(res.body), {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      code: 'unsupported_effort',
      message: 'Unsupported GPT reasoning effort',
    },
  })
  clean(res, controller)
})

test('finish requires message_stop before publishing success', async () => {
  for (const streaming of [true, false]) {
    const { res, controller, output } = await setup(streaming)
    await accept(output, [start(), block(), delta(0, { type: 'text_delta', text: 'partial' })])
    await assert.rejects(output.finish(), /incomplete_stream/)
    assert.equal(res.writableEnded, false)
    assert.equal(res.body.includes('message_stop'), false)
    controller.abort()
    clean(res, controller)
  }
})

test('nonstream aggregation requires a final message delta before publishing a message', async () => {
  const { res, controller, output } = await setup(false)
  await accept(output, [
    start(),
    block(),
    delta(0, { type: 'text_delta', text: 'partial' }),
    event('content_block_stop', { index: 0 }),
    event('message_stop'),
  ])
  await assert.rejects(output.finish(), /incomplete_stream/)
  assert.equal(res.headersSent, false)
  output.dispose()
  clean(res, controller)
})

test('malformed nonstream tool JSON cannot be assembled into a success message', async () => {
  for (const content of ['{"bad":', '[]']) {
    const { res, controller, output } = await setup(false)
    await accept(output, [
      start(),
      block(0, { type: 'tool_use', id: 'call_1', name: 'Read', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: content }),
    ])
    await assert.rejects(output.accept(event('content_block_stop', { index: 0 })), /invalid_stream/)
    assert.equal(res.headersSent, false)
    controller.abort()
    clean(res, controller)
  }
})

test('streaming holds message_stop until finish and discards it on a later parser failure', async () => {
  const { res, controller, output } = await setup()
  await accept(output, [
    start(),
    block(),
    delta(0, { type: 'text_delta', text: 'content' }),
    event('content_block_stop', { index: 0 }),
    ...terminal(),
  ])
  assert.equal(
    frames(res).some((value) => value.event === 'message_stop'),
    false,
  )
  await output.error({
    status: 502,
    type: 'api_error',
    code: 'invalid_stream',
    message: 'Upstream response was malformed (invalid_stream)',
    retryAfter: null,
  })
  assert.equal(
    frames(res).some((value) => value.event === 'message_stop'),
    false,
  )
  assert.equal(frames(res).at(-1)?.event, 'error')
  clean(res, controller)
})

test('nonstreaming aggregate is bounded at 32 MiB without flushing partial output', async () => {
  const { res, controller, output } = await setup(false)
  await accept(output, [start(), block()])
  await assert.rejects(
    output.accept(delta(0, { type: 'text_delta', text: 'x'.repeat(32 * 1024 * 1024) })),
    /too_large/,
  )
  assert.equal(res.headersSent, false)
  controller.abort()
  clean(res, controller)
})

test('streaming waits for drain before flushing the next frame and removes listeners afterward', async () => {
  const { res, controller, output } = await setup()
  await output.accept(start())
  res.blocked = true
  let settled = false
  const pending = output.accept(block()).then(() => {
    settled = true
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(res.chunks.length, 1)
  res.blocked = false
  res.emit('drain')
  await pending
  assert.equal(res.chunks.length, 2)
  assert.equal(res.listenerCount('drain'), 0)
  controller.abort()
  clean(res, controller)
})

test('abort or client close settles blocked writes and removes all output listeners', async () => {
  for (const cause of ['abort', 'close', 'error']) {
    const { res, controller, output } = await setup()
    await output.accept(start())
    res.blocked = true
    const pending = output.accept(block())
    await Promise.resolve()
    await Promise.resolve()
    if (cause === 'abort') controller.abort()
    else if (cause === 'close') res.close()
    else res.emit('error', new Error('fake socket failure'))
    await assert.rejects(pending)
    assert.equal(res.endCalls, 0)
    clean(res, controller)
  }
})

test('an already aborted caller writes no headers or body', async () => {
  const { res, controller, output } = await setup()
  controller.abort()
  await assert.rejects(output.accept(start()), { name: 'AbortError' })
  await assert.rejects(output.error(failure()), { name: 'AbortError' })
  assert.equal(res.headersSent, false)
  clean(res, controller)
})

test('dispose settles a blocked write and clears the attempt without ending the response', async () => {
  const { res, controller, output } = await setup()
  await output.accept(start())
  res.blocked = true
  const pending = output.accept(block())
  await Promise.resolve()
  await Promise.resolve()
  output.dispose()
  output.dispose()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(res.endCalls, 0)
  clean(res, controller)
})

test('15-second pings start after first flush and stop on success, error or client abort', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  for (const ending of ['finish', 'error', 'abort']) {
    const { res, controller, output } = await setup()
    await output.accept(start())
    t.mock.timers.tick(30_000)
    await Promise.resolve()
    assert.equal(res.body, '')
    await output.accept(block())
    t.mock.timers.tick(14_999)
    await Promise.resolve()
    assert.equal(
      frames(res).some((value) => value.event === 'ping'),
      false,
    )
    t.mock.timers.tick(1)
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(frames(res).filter((value) => value.event === 'ping').length, 1)
    if (ending === 'finish') {
      await accept(output, [
        delta(0, { type: 'text_delta', text: 'done' }),
        event('content_block_stop', { index: 0 }),
        ...terminal(),
      ])
      await output.finish()
    } else if (ending === 'error') await output.error(failure())
    else controller.abort()
    const body = res.body
    t.mock.timers.tick(60_000)
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(res.body, body)
    clean(res, controller)
  }
})
