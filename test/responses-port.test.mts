import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { WebSocket } from 'ws'
import {
  classifyUserText,
  isAgentTurn,
  isRouterItem,
  makeMarker,
  parseCodexRequest,
  sanitizeInputForOpenAI,
} from '../src/codex-input.mjs'
import {
  type ResponseSink,
  ResponsesStream,
  usageObject,
  WebSocketSink,
} from '../src/responses-stream.mjs'
import { describeToolUse, progressLine } from '../src/tool-display.mjs'

function sink(): ResponseSink & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = []
  return {
    events,
    writableEnded: false,
    destroyed: false,
    write(chunk: string) {
      const data = chunk.split('\n').find((line) => line.startsWith('data: '))
      if (data) events.push(JSON.parse(data.slice(6)))
      return true
    },
    end() {
      ;(this as { writableEnded: boolean }).writableEnded = true
    },
    on: () => undefined,
  }
}

const user = (text: string) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
})

test('responses: text streams as a message that is done before the response completes', () => {
  const out = sink()
  const stream = new ResponsesStream(out, { model: 'opus' })
  stream.begin()
  stream.textDelta('PO')
  stream.textDelta('NG')
  stream.complete(usageObject())
  const types = out.events.map((e) => e.type)
  assert.deepEqual(types.slice(0, 2), ['response.created', 'response.in_progress'])
  const done = out.events.find((e) => e.type === 'response.output_item.done') as {
    item: { content: Array<{ text: string }> }
  }
  assert.equal(done.item.content[0]?.text, 'PONG')
  assert.equal(types.at(-1), 'response.completed')
  assert.ok(types.indexOf('response.output_item.done') < types.indexOf('response.completed'))
  assert.match(String((out.events[0] as { response: { id: string } }).response.id), /^resp_ae_/)
})

test('responses: a failure is a non-retryable response.failed, and nothing is written after the end', () => {
  const out = sink()
  const stream = new ResponsesStream(out, { model: 'opus' })
  stream.begin()
  stream.fail('no adapter owns this thread')
  stream.textDelta('late')
  const last = out.events.at(-1) as {
    type: string
    response: { error: { code: string; message: string } }
  }
  assert.equal(last.type, 'response.failed')
  assert.equal(last.response.error.code, 'invalid_prompt')
  assert.ok(stream.closed)
})

// A stand-in for a `ws` socket: its state, what was sent, and its close event.
function fakeSocket(readyState: number) {
  const sent: string[] = []
  const socket = Object.assign(new EventEmitter(), {
    readyState,
    send: (data: string) => {
      sent.push(data)
    },
  })
  return { socket, sent, ws: socket as unknown as WebSocket }
}

test('responses: over a WebSocket each event is one JSON frame, and nothing is sent once the socket is not open', () => {
  const open = fakeSocket(WebSocket.OPEN)
  const completed: Array<Record<string, unknown>> = []
  const stream = new ResponsesStream(
    new WebSocketSink(open.ws, (response) => completed.push(response)),
    { model: 'opus' },
  )
  stream.begin()
  stream.textDelta('PONG')
  stream.complete(usageObject())
  const types = open.sent.map((frame) => (JSON.parse(frame) as { type: string }).type)
  assert.equal(types[0], 'response.created')
  assert.equal(types.at(-1), 'response.completed')
  assert.equal(completed.length, 1)
  assert.equal(completed[0]?.id, stream.id)

  const shut = fakeSocket(WebSocket.CLOSED)
  const late = new WebSocketSink(shut.ws)
  assert.equal(late.write('event: x\ndata: {"type":"x"}\n\n'), false)
  assert.deepEqual(shut.sent, [])

  const dropped = fakeSocket(WebSocket.OPEN)
  const sink = new WebSocketSink(dropped.ws)
  let closes = 0
  sink.on('close', () => {
    closes += 1
  })
  const cut = new ResponsesStream(sink, { model: 'opus' })
  cut.begin()
  dropped.socket.emit('close')
  cut.textDelta('late')
  assert.equal(sink.destroyed, true)
  assert.equal(closes, 1)
  assert.equal(dropped.sent.length, 2)
})

test('codex input: the task is the prompt; environment, AGENTS.md and injected context are not', () => {
  const parsed = parseCodexRequest({
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '`sandbox_mode` is `workspace-write`' }],
      },
      user('<environment_context>\n  <cwd>/work/repo</cwd>\n</environment_context>'),
      user('# AGENTS.md instructions for /work/repo\n\nBe brief.'),
      user('Review src/a.ts and reply in one sentence.'),
    ],
  })
  assert.equal(parsed.cwd, '/work/repo')
  assert.equal(parsed.sandboxMode, 'workspace-write')
  assert.equal(parsed.promptText, 'Review src/a.ts and reply in one sentence.')
  assert.equal(parsed.agentsMd.length, 1)
  assert.equal(
    classifyUserText('<environment_context><cwd>x</cwd></environment_context>'),
    'environment',
  )
})

test('codex input: a marker resumes only its own latest turn', () => {
  const marker = makeMarker('sess-1', 'turn-1')
  const body = {
    input: [
      user('first'),
      { type: 'reasoning', id: 'rs_ae_1', summary: [], encrypted_content: marker },
      user('second'),
    ],
  }
  assert.equal(parseCodexRequest(body, () => true).resume?.sid, 'sess-1')
  assert.equal(parseCodexRequest(body, () => true).promptText, 'second')
  assert.equal(parseCodexRequest(body, () => false).resume, null)
})

test('codex input: router items never reach OpenAI; a Claude reply keeps its content without its id', () => {
  const input = [
    user('hi'),
    {
      type: 'message',
      id: 'msg_ae_1',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'PONG' }],
    },
    { type: 'reasoning', id: 'rs_ae_2', summary: [], encrypted_content: makeMarker('s', 't') },
    { type: 'message', id: 'msg_real', role: 'assistant', content: [] },
  ]
  const { input: clean, changed } = sanitizeInputForOpenAI(input)
  assert.equal(changed, true)
  const list = clean as Array<Record<string, unknown>>
  assert.equal(list.length, 3)
  assert.ok(!list.some((item) => isRouterItem(item)))
  assert.equal(list[1]?.id, undefined)
  assert.equal(sanitizeInputForOpenAI([user('x')]).changed, false)
})

test('codex input: agent turns are told apart from housekeeping calls', () => {
  assert.equal(isAgentTurn({ input: [{ type: 'additional_tools', tools: [] }] }), true)
  assert.equal(
    isAgentTurn({ input: [user('<environment_context><cwd>/x</cwd></environment_context>')] }),
    true,
  )
  assert.equal(isAgentTurn({ input: [user('Summarize this title')] }), false)
})

// The router's Claude entries set `use_responses_lite: false`, so a Claude
// turn arrives in the classic shape: tools at the top level, no
// `additional_tools` item, and over the WebSocket one `response.create` frame
// per turn, after a prewarm frame with empty input.
test('codex input: the classic shape a Claude entry gets is an agent turn, and its prewarm has no prompt', () => {
  const tools = [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }]
  const frame = {
    type: 'response.create',
    model: 'opus',
    instructions: 'You are Codex.',
    tools,
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '`sandbox_mode` is `read-only`' }],
      },
      user('<environment_context>\n  <cwd>/work/repo</cwd>\n</environment_context>'),
      user('Reply with PONG'),
    ],
  }
  assert.equal(isAgentTurn(frame), true)
  const parsed = parseCodexRequest(frame)
  assert.equal(parsed.cwd, '/work/repo')
  assert.equal(parsed.sandboxMode, 'read-only')
  assert.equal(parsed.promptText, 'Reply with PONG')
  assert.equal(parsed.context, '')
  const prewarm = parseCodexRequest({ ...frame, generate: false, input: [] })
  assert.equal(prewarm.promptText, '')
  assert.equal(prewarm.context, '')
  assert.equal(prewarm.cwd, null)
  // A continuation that carries only a tool result is an agent turn by its tools alone.
  const result = { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
  assert.equal(isAgentTurn({ ...frame, input: [result] }), true)
  assert.equal(isAgentTurn({ ...frame, tools: [], input: [result] }), false)
  assert.equal(
    isAgentTurn({ model: 'opus', tools: [], input: [user('Summarize this title')] }),
    false,
  )
})

test('tool display: one short progress line per tool call', () => {
  assert.match(progressLine('Bash', { command: 'npm test -- --grep x' }, '/w'), /^Ran `npm test/)
  assert.equal(progressLine('Read', { file_path: '/w/src/a.ts' }, '/w'), 'Read `src/a.ts`')
  assert.ok(progressLine('Bash', { command: 'x'.repeat(500) }, null).length <= 160)
  assert.equal(
    describeToolUse({ name: 'Read', input: { file_path: '/w/a' } }, '/w')?.kind,
    'reasoning',
  )
})
