import assert from 'node:assert/strict'
import http from 'node:http'
import { after, test } from 'node:test'
import type { Query, query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  DesktopClaudeRuntime,
  desktopEvent,
  desktopPrompt,
} from '../src/desktop-claude-runtime.mjs'
import { desktopTools } from '../src/desktop-tools-mcp.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const tool = {
  name: 'Read',
  description: 'Read a file in Desktop',
  input_schema: {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
  },
}
const body = {
  model: 'anyengine/claude-subscription/haiku',
  stream: false,
  messages: [
    { role: 'user', content: 'Remember cobalt-721' },
    { role: 'system', content: 'Desktop context' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_read',
          name: 'Read',
          input: { file_path: '/workspace/test.txt' },
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'cobalt-721' }],
    },
  ],
  tools: [tool],
}

test('Desktop conversation retains system turns, previous engine answers and native tool results', () => {
  const prompt = desktopPrompt(body)
  assert.ok(prompt.includes(JSON.stringify(body.messages)))
  assert.throws(
    () => desktopPrompt({ messages: [{ role: 'unexpected', content: 'x' }] }),
    /Invalid/,
  )
  assert.throws(() => desktopPrompt({ messages: [] }), /Invalid/)
  const image = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'private-image-bytes' },
  }
  const attachments: any[] = []
  const imagePrompt = desktopPrompt({ messages: [{ role: 'user', content: [image] }] }, attachments)
  assert.deepEqual(attachments, [image])
  assert.equal(imagePrompt.includes('private-image-bytes'), false)
  assert.ok(imagePrompt.includes('[Attached image 1]'))

  const original = {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'tool_use',
      id: 'call_read',
      name: 'mcp__desktop__Read',
      input: {},
    },
  }
  const event = desktopEvent(original, 'haiku', new Set(['Read']))
  assert.deepEqual(event.content_block, { ...original.content_block, name: 'Read' })
  assert.equal(original.content_block.name, 'mcp__desktop__Read')
  for (const name of ['Read', 'mcp__other__Read', 'mcp__desktop__Write'])
    assert.throws(
      () =>
        desktopEvent(
          { ...original, content_block: { ...original.content_block, name } },
          'haiku',
          new Set(['Read']),
        ),
      /unknown/,
    )
})

test('Claude tool catalog requires its private bearer and never executes Desktop tools', async () => {
  const server = await desktopTools([tool])
  try {
    const rpc = async (method: string, headers = server.config.headers) => {
      const response = await fetch(server.config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            protocolVersion: '2025-03-26',
            name: 'Read',
            arguments: { file_path: '/private/file' },
          },
        }),
      })
      return {
        status: response.status,
        body: response.status === 200 ? ((await response.json()) as any) : undefined,
      }
    }
    assert.equal((await rpc('tools/list', { Authorization: 'Bearer wrong' })).status, 403)
    assert.equal(
      (
        await rpc('tools/list', {
          ...server.config.headers,
          Origin: 'https://example.com',
        } as typeof server.config.headers)
      ).status,
      403,
    )
    assert.equal((await rpc('initialize')).body.result.protocolVersion, '2025-03-26')
    assert.deepEqual((await rpc('tools/list')).body.result.tools, [
      { name: tool.name, description: tool.description, inputSchema: tool.input_schema },
    ])
    assert.equal((await rpc('tools/call')).body.result.isError, true)
    assert.equal((await rpc('unexpected')).body.error.code, -32601)
  } finally {
    await server.close()
  }
  await assert.rejects(desktopTools([tool, tool]), /Invalid/)
})

async function runtimeFixture(events: Record<string, unknown>[], requestBody = body) {
  const root = await tempDir('desktop-claude-')
  let options: Parameters<typeof query>[0] | undefined
  let closed = 0
  const fakeQuery = (input: Parameters<typeof query>[0]) => {
    options = input
    const result = (async function* () {
      for (const event of events)
        yield { type: 'stream_event', parent_tool_use_id: null, event } as unknown as SDKMessage
    })()
    return Object.assign(result, {
      close: () => {
        closed++
      },
    }) as Query
  }
  const runtime = new DesktopClaudeRuntime(fakeQuery)
  const server = http.createServer(async (_req, res) => {
    await runtime.run({
      root,
      body: requestBody,
      model: {
        id: 'haiku',
        displayName: 'Claude Haiku',
        claudeModel: 'haiku',
        contextWindow: 200000,
      },
      cli: null,
      res,
      signal: new AbortController().signal,
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}`)
    return {
      status: response.status,
      answer: (await response.json()) as any,
      options: options?.options,
      closed,
    }
  } finally {
    await runtime.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
const start = {
  type: 'message_start',
  message: {
    id: 'msg_test',
    role: 'assistant',
    type: 'message',
    content: [],
    model: 'claude-haiku',
    usage: { input_tokens: 10, output_tokens: 0 },
  },
}
const end = (stop: string) => [
  {
    type: 'message_delta',
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { input_tokens: 10, output_tokens: 4 },
  },
  { type: 'message_stop' },
]

test('Claude subscription response hands native tool calls back to Desktop with builtins and user hooks off', async () => {
  const f = await runtimeFixture([
    start,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_read', name: 'mcp__desktop__Read', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"file_path":"/workspace/test.txt"}' },
    },
    { type: 'content_block_stop', index: 0 },
    ...end('tool_use'),
  ])
  assert.equal(f.status, 200)
  assert.deepEqual(f.answer.content, [
    {
      type: 'tool_use',
      id: 'call_read',
      name: 'Read',
      input: { file_path: '/workspace/test.txt' },
    },
  ])
  assert.equal(f.answer.model, body.model)
  assert.equal(f.answer.stop_reason, 'tool_use')
  assert.deepEqual(f.options?.tools, [])
  assert.deepEqual(f.options?.settingSources, [])
  assert.equal(f.options?.persistSession, false)
  assert.equal(
    f.options?.settings &&
      typeof f.options.settings === 'object' &&
      f.options.settings.disableAllHooks,
    true,
  )
  assert.ok(f.options?.extraArgs?.restricted === null)
  assert.equal(f.options?.env?.ANTHROPIC_BASE_URL, undefined)
  assert.equal(f.options?.env?.ANTHROPIC_API_KEY, undefined)
  assert.equal(f.closed, 1)
})

test('incomplete Claude streams report failure rather than a successful empty turn', async () => {
  const f = await runtimeFixture([start])
  assert.equal(f.status, 503)
  assert.equal(f.answer.error.code, 'claude_unavailable')
  assert.equal(f.closed, 1)
})

test('Claude receives Desktop effort and thinking controls rather than CLI defaults', async () => {
  const events = [
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    { type: 'content_block_stop', index: 0 },
    ...end('end_turn'),
  ]
  for (const [thinking, expected] of [
    [{ type: 'adaptive' }, { type: 'adaptive' }],
    [{ type: 'disabled' }, { type: 'disabled' }],
    [
      { type: 'enabled', budget_tokens: 2048 },
      { type: 'enabled', budgetTokens: 2048 },
    ],
  ]) {
    const f = await runtimeFixture(events, {
      ...body,
      output_config: { effort: 'high' },
      thinking,
    } as typeof body)
    assert.equal(f.status, 200)
    assert.equal(f.options?.effort, 'high')
    assert.deepEqual(f.options?.thinking, expected)
  }
  const invalid = await runtimeFixture(events, {
    ...body,
    output_config: { effort: 'unsupported' },
  } as typeof body)
  assert.equal(invalid.status, 503)
  assert.equal(invalid.options, undefined)
})
