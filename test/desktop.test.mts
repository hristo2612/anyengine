import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { after, type TestContext, test } from 'node:test'
import { setConfigValue } from '../src/anyengine-config.mjs'
import { desktopCommand, desktopStatus } from '../src/control-desktop.mjs'
import { DesktopClient, runDesktopMcp } from '../src/desktop-mcp.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const configPath = (home: string) =>
  join(home, 'Library/Application Support/Claude/claude_desktop_config.json')
const write = (path: string, value: object) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
async function fixture() {
  const home = await tempDir('anyengine-desktop-')
  return { home, root: join(home, '.anyengine'), path: configPath(home), system: fakeSystem(home) }
}

test('Desktop on is optional, idempotent and removes only its connector after unrelated edits', async () => {
  const f = await fixture()
  const original = {
    preferences: { theme: 'dark' },
    mcpServers: { other: { command: '/bin/true' } },
  }
  write(f.path, original)
  assert.equal(desktopStatus(f.home, f.root).enabled, false)
  assert.equal(await desktopCommand(['on'], f.system, f.root, () => {}), 0)
  const enabled = read(f.path)
  assert.deepEqual(enabled.mcpServers.other, original.mcpServers.other)
  assert.deepEqual(enabled.mcpServers.anyengine.env, { ANYENGINE_ROOT: f.root })
  assert.ok(enabled.mcpServers.anyengine.args[0].endsWith('/scripts/desktop-mcp.mjs'))
  assert.equal(await desktopCommand(['on'], f.system, f.root, () => {}), 0)
  enabled.preferences.theme = 'light'
  enabled.mcpServers.later = { command: '/bin/false' }
  write(f.path, enabled)
  assert.equal(await desktopCommand(['off'], f.system, f.root, () => {}), 0)
  assert.deepEqual(read(f.path), {
    preferences: { theme: 'light' },
    mcpServers: { other: original.mcpServers.other, later: { command: '/bin/false' } },
  })
  assert.equal(desktopStatus(f.home, f.root).enabled, false)
  assert.deepEqual(f.system.calls, [])
})

test('Desktop off restores absence and retains newly added settings', async () => {
  const f = await fixture()
  await desktopCommand(['on'], f.system, f.root, () => {})
  await desktopCommand(['off'], f.system, f.root, () => {})
  assert.equal(existsSync(f.path), false)
  await desktopCommand(['on'], f.system, f.root, () => {})
  write(f.path, { ...read(f.path), preferences: { keep: true } })
  await desktopCommand(['off'], f.system, f.root, () => {})
  assert.deepEqual(read(f.path), { preferences: { keep: true } })
})

test('Desktop refuses foreign, edited or invalid settings without overwriting them', async () => {
  const f = await fixture()
  const foreign = { mcpServers: { anyengine: { command: '/bin/true' } } }
  write(f.path, foreign)
  await assert.rejects(
    desktopCommand(['on'], f.system, f.root, () => {}),
    /unowned/,
  )
  assert.deepEqual(read(f.path), foreign)
  await assert.rejects(
    desktopCommand(['off'], f.system, f.root, () => {}),
    /unowned/,
  )
  assert.deepEqual(read(f.path), foreign)
  write(f.path, {})
  await desktopCommand(['on'], f.system, f.root, () => {})
  const edited = read(f.path)
  edited.mcpServers.anyengine.command = '/bin/false'
  write(f.path, edited)
  await assert.rejects(
    desktopCommand(['off'], f.system, f.root, () => {}),
    /edited/,
  )
  assert.deepEqual(read(f.path), edited)
  assert.equal(desktopStatus(f.home, f.root).conflict, true)
  writeFileSync(f.path, '{invalid')
  await assert.rejects(desktopCommand(['off'], f.system, f.root, () => {}))
  assert.equal(readFileSync(f.path, 'utf8'), '{invalid')
})

test('Desktop resumes an interrupted enable and rejects invalid command arguments', async () => {
  const f = await fixture()
  write(f.path, { preferences: { keep: true } })
  await desktopCommand(['on'], f.system, f.root, () => {})
  const receipt = read(join(f.root, 'recovery/claude-desktop/connector.json'))
  write(f.path, { preferences: { keep: true } })
  await desktopCommand(['on'], f.system, f.root, () => {})
  assert.deepEqual(read(f.path).mcpServers.anyengine, receipt.entry)
  for (const args of [
    ['on', '--json'],
    ['off', 'extra'],
    ['status', '--json', 'extra'],
  ])
    assert.equal(await desktopCommand(args, f.system, f.root, () => {}), 2)
  let text = ''
  await desktopCommand(['status', '--json'], f.system, f.root, (s) => {
    text += s
  })
  assert.equal(JSON.parse(text).enabled, true)
})

test('Desktop points at lib/current when the installed connector is available', async () => {
  const f = await fixture()
  const script = join(f.root, 'lib/current/scripts/desktop-mcp.mjs')
  mkdirSync(dirname(script), { recursive: true })
  writeFileSync(script, '')
  await desktopCommand(['on'], f.system, f.root, () => {})
  assert.equal(read(f.path).mcpServers.anyengine.args[0], script)
})

async function backend(t: TestContext, handle: http.RequestListener) {
  const root = await tempDir('anyengine-desktop-router-')
  const server = http.createServer(handle)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  )
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  setConfigValue(root, 'router.port', String(address.port))
  return root
}

test('Desktop GPT calls use only the local router, exact model, provided context and no credentials', async (t) => {
  const received: Array<{ path: string; headers: http.IncomingHttpHeaders; body: any }> = []
  const root = await backend(t, async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    received.push({ path: req.url!, headers: req.headers, body: body ? JSON.parse(body) : null })
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify(
        req.url?.startsWith('/control')
          ? { models: [{ id: 'gpt-6-luna', label: 'GPT', contextWindow: 1000 }] }
          : { content: [{ type: 'text', text: 'answer' }], stop_reason: 'max_tokens' },
      ),
    )
  })
  const client = new DesktopClient(root)
  assert.deepEqual(await client.call('list_models', {}, AbortSignal.timeout(30_000)), {
    models: [{ id: 'gpt-6-luna', label: 'GPT', contextWindow: 1000 }],
  })
  assert.deepEqual(
    await client.call(
      'ask_gpt',
      { model: 'gpt-6-luna', prompt: 'Question', context: 'Relevant context' },
      AbortSignal.timeout(30_000),
    ),
    { model: 'gpt-6-luna', text: 'answer', usage: undefined, truncated: true },
  )
  assert.equal(received[1]?.body.model, 'gpt-6-luna')
  assert.equal(received[1]?.body.stream, false)
  assert.deepEqual(received[1]?.body.messages, [
    { role: 'user', content: 'Context:\nRelevant context\n\nQuestion:\nQuestion' },
  ])
  assert.equal(received[1]?.body.tools, undefined)
  assert.equal(received[1]?.headers.authorization, undefined)
  assert.equal(received[1]?.headers['x-api-key'], undefined)
  assert.equal(received[1]?.headers.cookie, undefined)
  for (const args of [
    { model: 'claude-opus', prompt: 'x' },
    { model: 'gpt-6-luna', prompt: '' },
    { model: 'gpt-6-luna', prompt: 'x', context: 42 },
    { model: 'gpt-6-luna', prompt: 'x', url: 'https://example.com' },
  ])
    await assert.rejects(client.call('ask_gpt', args, AbortSignal.timeout(30_000)))
  assert.equal(received.length, 2)
})

function protocol(root: string, t: TestContext) {
  const input = new PassThrough()
  const output = new PassThrough()
  t.after(() => {
    input.end()
    output.destroy()
  })
  const waiters = new Map<number, (message: any) => void>()
  output.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const message = JSON.parse(line)
      waiters.get(message.id)?.(message)
      waiters.delete(message.id)
    }
  })
  runDesktopMcp(root, input, output)
  const send = (message: object) =>
    input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const request = (id: number, method: string, params = {}) => {
    const result = new Promise<any>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP response missing')), 30_000)
      waiters.set(id, (message) => {
        clearTimeout(timer)
        done(message)
      })
    })
    send({ id, method, params })
    return result
  }
  return { input, request, send }
}

test('Desktop MCP handshake, catalog, tool error and cancellation complete without leaking upstream errors', async (t) => {
  let started!: () => void
  const ready = new Promise<void>((done) => {
    started = done
  })
  const root = await backend(t, (req, res) => {
    if (req.url === '/v1/messages') {
      started()
      return
    }
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'private upstream diagnostic' }))
  })
  const p = protocol(root, t)
  const init = await p.request(1, 'initialize', { protocolVersion: '2025-06-18' })
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.deepEqual(init.result.capabilities, { tools: {} })
  const tools = await p.request(2, 'tools/list')
  assert.deepEqual(
    tools.result.tools.map((tool: any) => tool.name),
    ['list_models', 'ask_gpt'],
  )
  assert.equal((await p.request(3, 'resources/list')).error.code, -32601)
  const failed = await p.request(4, 'tools/call', { name: 'list_models', arguments: {} })
  assert.equal(failed.result.isError, true)
  assert.ok(!JSON.stringify(failed).includes('private upstream diagnostic'))
  const asking = p.request(5, 'tools/call', {
    name: 'ask_gpt',
    arguments: { model: 'gpt-6-luna', prompt: 'test' },
  })
  await ready
  p.send({ method: 'notifications/cancelled', params: { requestId: 5 } })
  assert.equal((await asking).result.isError, true)
})

test('Desktop bounds malformed or oversized upstream replies and oversized stdin', async (t) => {
  let large = false
  const root = await backend(t, (_req, res) =>
    res.end(large ? 'x'.repeat(1024 * 1024 + 1) : 'invalid private payload'),
  )
  const client = new DesktopClient(root)
  await assert.rejects(
    client.call('list_models', {}, AbortSignal.timeout(30_000)),
    /invalid response/,
  )
  large = true
  await assert.rejects(client.call('list_models', {}, AbortSignal.timeout(30_000)), /1 MiB limit/)
  const p = protocol(root, t)
  p.input.write('x'.repeat(1024 * 1024 + 1))
  assert.equal(p.input.destroyed, true)
})
