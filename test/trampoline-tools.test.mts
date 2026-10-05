// Ported from EthanSK/claude-in-codex (MIT) test/bridge.test.js @ e2adced; see THIRD_PARTY_NOTICES.md.
// Changes: daemon-owned hooks, ownership gate and lifecycle/identity regressions.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { setConfigValue } from '../src/anyengine-config.mjs'
import { classifyUserText } from '../src/codex-input.mjs'
import { UNCLAIMED_MESSAGE } from '../src/router-claude.mjs'
import { killChildren } from './helpers/children.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'
import {
  body,
  eventually,
  output,
  setup,
  textOf,
  tools,
  user,
  wsTurn,
} from './helpers/trampoline-router.mjs'

after(killChildren)
after(removeTempDirs)
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!

test('Claude calls Codex tools that Codex runs, and the same Claude process continues with the result', async (t) => {
  const h = await setup(t)
  const first = await h.send()
  const items = output(first)
  const call = items.find((item: any) => item.type === 'function_call')
  assert.ok(call, JSON.stringify(first))
  assert.deepEqual(
    [call.name, call.namespace, JSON.parse(call.arguments)],
    ['list_threads', 'codex_app', { limit: 5 }],
  )
  assert.match(call.id, /^fc_ae_/)
  assert.ok(items.some((item: any) => item.encrypted_content?.startsWith('ae:v1:')))
  assert.equal(first.at(-1).response.end_turn, false)
  const commentary = items.find((item: any) => item.type === 'message')
  assert.deepEqual(
    [commentary.content[0].text, commentary.phase],
    ["I'll check the file.", 'commentary'],
  )
  assert.ok(
    !items.some(
      (item: any) => item.type === 'reasoning' && JSON.stringify(item).includes('mcp__codex'),
    ),
  )
  const args = h.calls()[0].args
  assert.deepEqual(Object.keys(JSON.parse(value(args, '--mcp-config')).mcpServers), ['codex'])
  assert.equal(value(args, '--allowedTools'), 'mcp__codex')
  assert.match(value(args, '--append-system-prompt'), /mcp__codex__request_user_input/)
  const listed = h.listed()[0]
  assert.deepEqual(
    listed.tools.map((tool: any) => tool.name),
    ['request_user_input', 'codex_app__list_threads', 'cua_repl__js', 'exec'],
  )
  assert.deepEqual(listed.tools.at(-1).inputSchema.required, ['input'])
  assert.match(listed.tools.at(-1).description, /start: \/\.\+\//)
  assert.ok(Number(listed.descriptionLimit) >= 5000)
  const second = await h.send(
    body([
      ...items,
      {
        type: 'function_call_output',
        call_id: call.call_id,
        output: [
          { type: 'input_text', text: '3 tasks' },
          { type: 'input_image', image_url: 'data:image/png;base64,iVBOR' },
        ],
      },
      user('also pin it'),
    ]),
  )
  assert.equal(second.at(-1)?.type, 'response.completed', JSON.stringify(second))
  assert.equal(
    textOf(output(second)),
    'Codex said: 3 tasks | [image image/png] | The user sent this message while the tool was running:\n\nalso pin it',
  )
  assert.equal(output(second).find((item: any) => item.type === 'message').phase, 'final_answer')
  assert.equal(second.at(-1).response.end_turn, true)
  assert.equal(h.calls().length, 1)
  await eventually(() => h.sockets().length === 0)
})

test('WebSocket follow-ups carrying only Codex tool results continue the waiting Claude turn', async (t) => {
  const h = await setup(t)
  h.scenario('codex-tools', 'exec')
  const ws = await h.socket()
  const first = await wsTurn(ws, body(undefined, { client_metadata: { thread_id: 'a' } }))
  const call = output(first).find((item: any) => item.type === 'custom_tool_call')
  assert.ok(call, JSON.stringify(first))
  assert.deepEqual([call.name, call.input], ['exec', 'text(1)'])
  assert.match(call.id, /^ctc_ae_/)
  const second = await wsTurn(
    ws,
    body([{ type: 'custom_tool_call_output', call_id: call.call_id, output: '1' }], {
      previous_response_id: first.at(-1).response.id,
      client_metadata: { thread_id: 'a' },
    }),
  )
  assert.equal(textOf(output(second)), 'Codex said: 1')
  assert.equal(second.at(-1).response.end_turn, true)
  assert.equal(h.calls().length, 1)
})

test('a new message without the tool results stops the waiting Claude turn before resuming its session', async (t) => {
  const h = await setup(t)
  const first = output(await h.send())
  const marker = first.find((item: any) => item.encrypted_content?.startsWith('ae:v1:'))
  assert.ok(marker)
  h.scenario('tools')
  await h.send(body([...first, user('never mind')]))
  const calls = h.calls()
  assert.equal(calls.length, 2)
  assert.equal(value(calls[1].args, '--resume'), marker.encrypted_content.split(':')[2])
  assert.match(
    JSON.parse(calls[1].stdin).message.content[0].text,
    /\[list_threads call\][\s\S]*never mind/,
  )
  assert.ok(calls[1].priorGone)
})

test('Claude asks through the desktop question card, and the answer reaches it during a later tool result', async (t) => {
  const h = await setup(t)
  h.scenario('codex-tools', 'request_user_input_async')
  const desktopTools = [{ type: 'function', name: 'request_user_input_async' }, ...tools]
  const first = output(await h.send(body(undefined, { tools: desktopTools })))
  const call = first.find((item: any) => item.type === 'function_call')
  assert.ok(call)
  assert.equal(call.name, 'request_user_input_async')
  assert.match(
    value(h.calls()[0].args, '--append-system-prompt'),
    /<send_user_message_question_reply>/,
  )
  const reply =
    '<send_user_message_question_reply>\n[{"answer":"Blue"}]\n</send_user_message_question_reply>'
  const browser =
    '<in-app-browser-context source="ambient-ui-state">One tab.</in-app-browser-context>\n\n## My request:\nmake it darker'
  const final = textOf(
    output(
      await h.send(
        body(
          [
            ...first,
            { type: 'function_call_output', call_id: call.call_id, output: '{"accepted":true}' },
            user(reply),
            user(browser),
          ],
          { tools: desktopTools },
        ),
      ),
    ),
  )
  assert.match(final, /Codex said: \{"accepted":true\}/)
  assert.equal(final.split(reply).length, 2)
  assert.equal(final.split(browser).length, 2)
})

test("a question-card answer starting a new turn is the user's prompt, not background context", async (t) => {
  const h = await setup(t)
  h.scenario('tools')
  const reply =
    '<send_user_message_question_reply>\n[{"answer":"Blue"}]\n</send_user_message_question_reply>'
  assert.equal(classifyUserText(reply), 'prompt')
  assert.equal(
    classifyUserText('<environment_context><cwd>/x</cwd></environment_context>'),
    'environment',
  )
  await h.send(body([user(reply)]))
  assert.match(h.calls()[0].stdin, /Blue/)
})

test('GPT requests keep bridge-made Codex tool calls, without their bridge ids', async (t) => {
  const h = await setup(t)
  const items = [
    {
      type: 'function_call',
      id: 'fc_ae_1',
      call_id: 'call_1',
      name: 'list_threads',
      namespace: 'codex_app',
      arguments: '{}',
    },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    { type: 'custom_tool_call', id: 'ctc_ae_1', call_id: 'call_2', name: 'exec', input: 'text(1)' },
  ]
  await h.send(body(items, { model: 'gpt-6-sol' }))
  const received = JSON.parse(h.backend.requests.at(-1)!.raw.toString()).input
  assert.deepEqual(
    received,
    items.map(({ id: _id, ...rest }) => rest),
  )
})

test('model switch GPT -> Claude carries GPT output as context on one WebSocket', async (t) => {
  const h = await setup(t)
  h.scenario('tools')
  const ws = await h.socket()
  const history = [
    user('GPT question'),
    { type: 'function_call', call_id: 'gpt-call', name: 'inspect', arguments: '{}' },
    { type: 'function_call_output', call_id: 'gpt-call', output: 'found' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'GPT answer' }] },
  ]
  await wsTurn(ws, body(history, { model: 'gpt-6-sol' }))
  await wsTurn(
    ws,
    body([...history, user('Claude followup')], { client_metadata: { thread_id: 'a' } }),
  )
  const prompt = h.calls()[0].stdin
  for (const text of ['GPT question', 'inspect', 'found', 'GPT answer', 'Claude followup'])
    assert.ok(prompt.includes(text), text)
})

test('model mode: mode agent sends the same request to the claim socket, not to claude', async (t) => {
  const h = await setup(t)
  setConfigValue(h.root, 'modes.codexClaude', 'agent')
  assert.equal(textOf(output(await h.send())), 'agent answer')
  assert.equal(h.contexts.length, 1)
  assert.equal(h.calls().length, 0)
})

test('model mode: a thread no adapter owns never starts claude', async (t) => {
  for (const claims of [true, false]) {
    const h = await setup(t, claims)
    const events = await h.send(body(), 'unknown')
    assert.equal(events.at(-1).type, 'response.failed', JSON.stringify(events))
    assert.ok(JSON.stringify(events).includes(UNCLAIMED_MESSAGE))
    assert.equal(h.calls().length, 0)
  }
})
