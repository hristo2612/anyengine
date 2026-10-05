import assert from 'node:assert/strict'
import { once } from 'node:events'
import { statSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test, { after } from 'node:test'
import {
  CodexToolServer,
  codexOutputToMcp,
  codexToolCatalog,
  isCodexToolName,
  type PendingCodexCall,
} from '../src/trampoline-tools.mjs'
import { killChildren } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'
import { body, output, setup, textOf } from './helpers/trampoline-router.mjs'

after(killChildren)
after(removeTempDirs)

test('colliding aliases retain original function and custom identities through real MCP handoff', async (t) => {
  const h = await setup(t)
  h.scenario('codex-tools', 'all')
  const long = 'prefix'.repeat(15)
  const offered = [
    { type: 'function', name: 'foo.bar' },
    { type: 'custom', name: 'foo_bar' },
    { type: 'function', name: `${long}A` },
    { type: 'function', name: `${long}B` },
    { type: 'namespace', name: 'mcp__ns.x', tools: [{ type: 'custom', name: 'custom' }] },
    { type: 'namespace', name: 'ns_x', tools: [{ type: 'custom', name: 'custom' }] },
  ]
  const first = output(await h.send(body(undefined, { tools: offered })))
  const calls = first.filter((item: any) =>
    ['function_call', 'custom_tool_call'].includes(item.type),
  )
  assert.deepEqual(
    calls.map((call: any) => [call.name, call.namespace ?? null, call.type]),
    [
      ['foo.bar', null, 'function_call'],
      ['foo_bar', null, 'custom_tool_call'],
      [`${long}A`, null, 'function_call'],
      [`${long}B`, null, 'function_call'],
      ['custom', 'mcp__ns.x', 'custom_tool_call'],
      ['custom', 'ns_x', 'custom_tool_call'],
    ],
  )
  const names = h.listed()[0].tools.map((tool: any) => tool.name)
  assert.equal(new Set(names).size, 6)
  assert.ok(names.every((name: string) => `mcp__codex__${name}`.length <= 64))
  assert.deepEqual([...codexToolCatalog(offered).keys()], names)
  const final = await h.send(
    body(
      calls.map((call: any, i: number) => ({
        type: call.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output',
        call_id: call.call_id,
        output: `answer${i}`,
      })),
    ),
  )
  assert.equal(
    textOf(output(final)),
    'Codex said: answer0 | answer1 | answer2 | answer3 | answer4 | answer5',
  )
})

test('partial result batches retire absent calls explicitly and late outputs stay inert', async (t) => {
  const h = await setup(t)
  h.scenario('codex-tools', 'all')
  const first = output(
    await h.send(
      body(undefined, {
        tools: [
          { type: 'function', name: 'one' },
          { type: 'function', name: 'two' },
        ],
      }),
    ),
  )
  const calls = first.filter((item: any) => item.type === 'function_call')
  assert.equal(calls.length, 2)
  const final = await h.send(
    body([{ type: 'function_call_output', call_id: calls[0].call_id, output: 'one' }]),
  )
  assert.equal(
    textOf(output(final)),
    'Codex said: one | Codex returned no result for this tool call.',
  )
  assert.equal(
    (
      await h.send(
        body([{ type: 'function_call_output', call_id: calls[1].call_id, output: 'late' }]),
      )
    ).at(-1).type,
    'response.failed',
  )
  assert.equal(h.calls().length, 1)
})

test('MCP socket dispatches protocol methods, converts results, bounds pending calls and closes connected clients', async (t) => {
  const root = await tempDir('ae-tt-')
  const calls: PendingCodexCall[] = []
  const server = new CodexToolServer(
    codexToolCatalog([{ type: 'function', name: 'work' }]),
    (call) => calls.push(call),
    root,
  )
  const path = await server.listen()
  t.after(() => server.close())
  assert.match(path, /router\/tools\/t-[a-f0-9]{8}\.sock$/)
  assert.equal(statSync(join(root, 'router/tools')).mode & 0o777, 0o700)
  const socket = net.connect(path)
  await once(socket, 'connect')
  const pending = new Map<number, (value: any) => void>()
  const lines = createInterface({ input: socket })
  lines.on('line', (line) => {
    const value = JSON.parse(line)
    pending.get(value.id)?.(value)
  })
  t.after(() => {
    lines.close()
    socket.destroy()
  })
  let id = 0
  const rpc = (method: string, params = {}) =>
    new Promise<any>((resolve) => {
      const key = ++id
      pending.set(key, resolve)
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: key, method, params })}\n`)
    })
  assert.equal((await rpc('initialize')).result.protocolVersion, '2025-06-18')
  assert.equal(
    (await rpc('initialize', { protocolVersion: 'future' })).result.protocolVersion,
    'future',
  )
  assert.equal((await rpc('tools/list')).result.tools[0].name, 'work')
  assert.deepEqual((await rpc('ping')).result, {})
  assert.equal((await rpc('unknown')).error.code, -32601)
  assert.equal((await rpc('tools/call', { name: 'missing' })).result.isError, true)
  const reply = rpc('tools/call', {
    name: 'work',
    arguments: { value: 7 },
    _meta: { 'claudecode/toolUseId': 'tool1' },
  })
  while (!calls.length) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls[0]!.toolUseId, 'tool1')
  calls[0]!.resolve([
    { type: 'input_text', text: 'ok' },
    { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
  ])
  assert.deepEqual((await reply).result.content, [
    { type: 'text', text: 'ok' },
    { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
  ])
  for (let n = 0; n < 256; n++) void rpc('tools/call', { name: 'work' })
  assert.equal((await rpc('tools/call', { name: 'work' })).result.isError, true)
  const closed = once(socket, 'close')
  server.close()
  server.close()
  await closed
  await assert.rejects(server.listen(), /closed/)
})

test('tool socket rejects long roots clearly; catalog tolerates malformed shapes and output conversion is explicit', async () => {
  const root = await tempDir('ae-tt-')
  const server = new CodexToolServer(new Map(), () => {}, join(root, 'x'.repeat(110)))
  await assert.rejects(server.listen(), /socket path.*limit/)
  server.close()
  assert.equal(
    codexToolCatalog([null, { type: 'namespace', tools: {} }, { type: 'web_search' }]).size,
    0,
  )
  assert.equal(isCodexToolName('mcp__codex__exec'), true)
  assert.equal(isCodexToolName(null), false)
  assert.deepEqual(codexOutputToMcp({ content: 'result' }), [{ type: 'text', text: 'result' }])
  assert.deepEqual(codexOutputToMcp([{ image_url: 'https://example.test/img' }]), [
    { type: 'text', text: 'https://example.test/img' },
  ])
  assert.deepEqual(codexOutputToMcp(undefined), [
    { type: 'text', text: '(The tool returned no output.)' },
  ])
})
