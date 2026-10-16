import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { foldInlineTools } from '../src/claude-inline-tools.mjs'
import { translateRequest } from '../src/vendor/claude-code-proxy/request.mjs'
import type { Obj, TranslationContext } from '../src/vendor/claude-code-proxy/types.mjs'

// Real Claude Code 2.1.301 requests with claude.ai connectors (structure only).
const capture = JSON.parse(
  readFileSync('test/fixtures/claude-code-inline-tools-2.1.301.json', 'utf8'),
) as { requests: Obj[] }
const [first, afterSearch] = capture.requests as [Obj, Obj]
const context = (lite = false): TranslationContext => ({
  model: {
    requested: 'gpt-5.6-luna',
    upstream: 'gpt-5.6-luna',
    lite,
    effort: null,
    efforts: ['low', 'medium', 'high'],
  },
  sessionKey: 'inline-tools',
})
const builtIn = [
  'Agent',
  'Bash',
  'Edit',
  'ListAgents',
  'Read',
  'ReportFindings',
  'ScheduleWakeup',
  'Skill',
  'ToolSearch',
  'Workflow',
  'Write',
]
const connectors = ['mcp__connector__tool_1', 'mcp__connector__tool_2', 'mcp__connector__tool_3']
const names = (tools: unknown) => (tools as Obj[]).map((tool) => tool.name)
const blockTypes = (request: Obj) =>
  (request.messages as Obj[]).flatMap((message) =>
    Array.isArray(message.content) ? (message.content as Obj[]).map((block) => block.type) : [],
  )

test('the captured first turn failed exactly as on the mini before the fold', () => {
  assert.throws(
    () => translateRequest(first, context()),
    (error: Error & { code?: string }) => error.code === 'unsupported_content',
  )
})

test('connector tools added by a system message become GPT tools; deferred ones stay off', () => {
  for (const lite of [false, true]) {
    const folded = foldInlineTools(first)
    assert.deepEqual(names(folded.tools), [...builtIn, ...connectors])
    assert.equal(blockTypes(folded).includes('tool_addition'), false)
    // The system message keeps its text for the model.
    const system = (folded.messages as Obj[]).find((message) => message.role === 'system')
    assert.deepEqual(
      (system?.content as Obj[]).map((block) => block.type),
      ['text'],
    )
    const translated = translateRequest(folded, context(lite))
    const tools = lite
      ? ((translated.input as Obj[]).find((item) => item.type === 'additional_tools')?.tools ?? [])
      : translated.tools
    assert.deepEqual(names(tools), [...builtIn, ...connectors])
    assert.ok(
      (translated.input as Obj[]).some(
        (item) => item.type === 'message' && item.role === 'developer',
      ),
    )
  }
})

test('folding never mutates its input', () => {
  for (const request of capture.requests) {
    const before = structuredClone(request)
    foldInlineTools(request)
    assert.deepEqual(request, before)
  }
})

test('a ToolSearch result turns on the deferred tools it names and says so to the model', () => {
  assert.throws(() => translateRequest(afterSearch, context()))
  const folded = foldInlineTools(afterSearch)
  const loaded = ['CronCreate', 'Monitor', 'RemoteTrigger', 'WebFetch', 'WebSearch']
  assert.deepEqual(new Set(names(folded.tools)), new Set([...builtIn, ...connectors, ...loaded]))
  assert.equal(names(folded.tools).includes('DeferredToolPlaceholder'), false)
  assert.ok((folded.tools as Obj[]).every((tool) => tool.defer_loading === undefined))
  const translated = translateRequest(folded, context())
  const output = (translated.input as Obj[]).find((item) => item.type === 'function_call_output')
  assert.equal(output?.output, loaded.map((name) => `[tool loaded: ${name}]`).join('\n'))
})

test('tool_removal turns a tool off; an addition by reference turns a deferred one on', () => {
  const request: Obj = {
    model: 'gpt-5.6-luna',
    tools: [
      { name: 'Read', input_schema: { type: 'object' } },
      { name: 'Late', defer_loading: true, input_schema: { type: 'object' } },
      { name: 'Gone', input_schema: { type: 'object' } },
    ],
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'system',
        content: [
          { type: 'tool_removal', tool: { type: 'tool_reference', name: 'Gone' } },
          { type: 'tool_addition', tool: { type: 'tool_reference', name: 'Late' } },
          { type: 'tool_addition', tool: { type: 'tool_reference', name: 'Unknown' } },
        ],
      },
    ],
  }
  const folded = foldInlineTools(request)
  assert.deepEqual(names(folded.tools), ['Read', 'Late'])
  // A system message that only changed tools is dropped.
  assert.deepEqual(
    (folded.messages as Obj[]).map((message) => message.role),
    ['user'],
  )
  assert.doesNotThrow(() => translateRequest(folded, context()))
})

test('a request without inline tools is passed through untouched', () => {
  const plain: Obj = {
    model: 'gpt-5.6-luna',
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  assert.equal(foldInlineTools(plain), plain)
  const duplicate: Obj = {
    ...plain,
    tools: [
      { name: 'Read', input_schema: { type: 'object' } },
      { name: 'Read', defer_loading: true, input_schema: { type: 'object' } },
    ],
  }
  // Malformed tool lists stay for the translator to refuse.
  assert.equal(foldInlineTools(duplicate), duplicate)
})

const def = (name: string, description = name): Obj => ({
  name,
  description,
  input_schema: { type: 'object' },
})
const add = (tool: Obj): Obj => ({
  type: 'tool_addition',
  tool: { type: 'tool_definition', definition: tool },
})
const remove = (name: string): Obj => ({
  type: 'tool_removal',
  tool: { type: 'tool_reference', name },
})

test('later messages override earlier ones; ToolSearch can turn a removed tool back on', () => {
  const folded = foldInlineTools({
    model: 'gpt-5.6-luna',
    tools: [def('Read')],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [add(def('Late'))] },
      { role: 'system', content: [remove('Late'), { type: 'text', text: 'note after' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'ToolSearch', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'c1',
            content: [
              { type: 'tool_reference', tool_name: 'Late' },
              { type: 'tool_reference', tool_name: 'Nowhere' },
            ],
          },
        ],
      },
    ],
  })
  assert.deepEqual(names(folded.tools), ['Read', 'Late'])
  const messages = folded.messages as Obj[]
  // A system message keeps its other content, in order.
  assert.deepEqual(messages[1]?.content, [{ type: 'text', text: 'note after' }])
  const result = ((messages.at(-1)?.content as Obj[])[0] as Obj).content
  assert.deepEqual(result, [
    { type: 'text', text: '[tool loaded: Late]' },
    { type: 'text', text: '[tool unavailable: Nowhere]' },
  ])
  assert.doesNotThrow(() => translateRequest(folded, context()))
})

test('a redefinition replaces the tool but keeps its first position', () => {
  const folded = foldInlineTools({
    model: 'gpt-5.6-luna',
    tools: [def('Read'), def('Grep')],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [add(def('Read', 'Read v2'))] },
    ],
  })
  assert.deepEqual(names(folded.tools), ['Read', 'Grep'])
  assert.equal((folded.tools as Obj[])[0]?.description, 'Read v2')
})

test('deferred tools alone are dropped; string system content is left as it is', () => {
  const folded = foldInlineTools({
    model: 'gpt-5.6-luna',
    tools: [def('Read'), { ...def('DeferredToolPlaceholder'), defer_loading: true }],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'plain system note' },
    ],
  })
  assert.deepEqual(names(folded.tools), ['Read'])
  assert.equal((folded.messages as Obj[])[1]?.content, 'plain system note')
  assert.doesNotThrow(() => translateRequest(folded, context()))
})
