import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { enginePaths } from '../src/anyengine-config.mjs'
import { BRIDGE_LINE, BRIDGE_LINE_GPT } from '../src/bridge-instructions.mjs'
import { routedTurnModel } from '../src/codex-models.mjs'
import type { UpstreamThreadInfo } from '../src/codex-mux.mjs'
import { markDegraded, markProven, proofKey } from '../src/degraded.mjs'
import { DEFAULT_POSTURE, noLooser, postureContext } from '../src/posture.mjs'
import { adapterOwns } from '../src/router-claim-client.mjs'
import { buildRouterRuntime } from '../src/router-hooks.mjs'
import {
  appOpenaiBaseUrl,
  linkRouter,
  nativeFanout,
  routerServesClaude,
} from '../src/router-link.mjs'
import { routerVersion, startRouter } from '../src/router-server.mjs'
import { asRecord } from '../src/rpc-shape.mjs'
import { readCompatibility } from '../src/startup-compat.mjs'
import { fakeCodexAt, launchAdapter, type Wire } from './helpers/adapter-client.mjs'
import { killChildren } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'
import { body, eventually, frames, output, setup, textOf } from './helpers/trampoline-router.mjs'

const closers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await killChildren()
  await removeTempDirs()
})

async function fakeRouter(
  root: string,
  path: 'native' | 'bridge',
  extra: Record<string, unknown> = {},
  slow = 0,
) {
  const requests: string[] = []
  const server = http.createServer(async (req, res) => {
    requests.push(req.url ?? '')
    if (slow) await delay(slow)
    res.writeHead(extra.redirect ? 302 : 200, {
      'content-type': 'application/json',
      ...(extra.redirect ? { location: String(extra.redirect) } : {}),
    })
    res.end(
      JSON.stringify({
        ok: true,
        pid: process.pid,
        version: routerVersion(),
        mode: 'agent',
        proofKey: proofKey(
          root,
          existsSync(join(root, 'fake-codex.mjs')) ? { codexVersion: () => '0.153.4-fake' } : {},
        ),
        faults: { unhandledRejections: 0, hookErrors: 0 },
        fanout: { path, reason: 'test' },
        ...extra,
      }),
    )
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  closers.push(
    () =>
      new Promise<void>((ok) => {
        server.closeAllConnections()
        server.close(() => ok())
      }),
  )
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { url: `http://127.0.0.1:${address.port}/backend-api/codex`, requests }
}

function prove(root: string, child = false) {
  if (child) fakeCodexAt(root)
  markProven(
    root,
    'native-fanout',
    'fixture proof',
    proofKey(root, child ? { codexVersion: () => '0.153.4-fake' } : {}),
  )
}
function configure(root: string, config: unknown) {
  writeFileSync(enginePaths(root).config, JSON.stringify(config))
}
const envFor = (url: string) => ({ ANYENGINE_ROUTER_URL: url })

test('router link attaches healthy loopback once and selects native only under keyed proof', async () => {
  const root = await tempDir('ae-link-')
  const modes = { mode: 'agent' }
  const { url, requests } = await fakeRouter(root, 'native', modes)
  const unproven = await linkRouter(['app-server'], { root, env: envFor(url) })
  assert.equal(unproven.state.attached, true)
  assert.equal(unproven.state.fanout, 'bridge')
  assert.match(unproven.state.reason, /not proven/)
  prove(root)
  const linked = await linkRouter(['app-server'], { root, env: envFor(url) })
  assert.deepEqual(linked.configArgs, ['-c', `openai_base_url="${url}"`])
  assert.equal(nativeFanout(), true)
  assert.equal(routerServesClaude(), false)
  modes.mode = 'model'
  configure(root, { modes: { codexClaude: 'model' } })
  prove(root)
  await linkRouter(['app-server'], { root, env: envFor(url) })
  assert.equal(routerServesClaude(), true)
  const existing = await linkRouter(['-c', `openai_base_url="${url}"`, 'app-server'], {
    root,
    env: envFor(url),
  })
  assert.equal(existing.state.attached, true)
  assert.deepEqual(existing.configArgs, [])
  assert.ok(requests.every((path) => path === '/health'))
})

test('router link refuses dead, slow, redirected, malformed and faulted health', async () => {
  const root = await tempDir('ae-link-')
  const destination = await fakeRouter(root, 'native')
  for (const url of [
    'http://127.0.0.1:9/backend-api/codex',
    (await fakeRouter(root, 'native', {}, 1100)).url,
    (
      await fakeRouter(root, 'native', {
        redirect: destination.url.replace('/backend-api/codex', '/health'),
      })
    ).url,
    (await fakeRouter(root, 'native', { ok: false })).url,
    (await fakeRouter(root, 'native', { faults: { hookErrors: 1, unhandledRejections: 0 } })).url,
    (await fakeRouter(root, 'native', { faults: { hookErrors: 0, unhandledRejections: 1 } })).url,
    (await fakeRouter(root, 'native', { faults: null })).url,
    (await fakeRouter(root, 'native', { padding: 'x'.repeat(70 * 1024) })).url,
    (
      await fakeRouter(root, 'native', {
        upstream: { lastError: 'failed', lastErrorAt: '2026-01-02', lastOkAt: '2026-01-01' },
      })
    ).url,
  ]) {
    const started = Date.now()
    const linked = await linkRouter(['app-server'], { root, env: envFor(url) })
    assert.equal(linked.state.attached, false, url)
    assert.deepEqual(linked.configArgs, [])
    assert.equal(nativeFanout(), false)
    assert.ok(Date.now() - started < 2500, 'health has a bounded spawn deadline')
  }
  assert.deepEqual(destination.requests, [], 'redirect destination was never contacted')
})

test('router link validates named URLs before probing and honors disabled or broken config', async () => {
  const root = await tempDir('ae-link-')
  const { url, requests } = await fakeRouter(root, 'native')
  for (const config of [{ router: { enabled: false } }, { router: { port: 'invalid' } }]) {
    configure(root, config)
    assert.equal(
      (await linkRouter(['app-server'], { root, env: envFor(url) })).state.attached,
      false,
    )
  }
  writeFileSync(enginePaths(root).config, '{bad')
  assert.equal((await linkRouter(['app-server'], { root, env: envFor(url) })).state.attached, false)
  configure(root, {})
  for (const value of [
    'https://example.com/backend-api/codex',
    'http://localhost:80/backend-api/codex',
    `${url}?x=1`,
    `${url}#fragment`,
    url.replace('127.0.0.1', 'user@127.0.0.1'),
    url.replace('/backend-api/codex', '/elsewhere'),
  ]) {
    assert.equal(
      (await linkRouter(['app-server'], { root, env: envFor(value) })).state.attached,
      false,
      value,
    )
  }
  const invalidRoot = await linkRouter(['app-server'], {
    env: { ANYENGINE_ROOT: 'relative', ANYENGINE_ROUTER_URL: url },
  })
  assert.equal(invalidRoot.state.attached, false)
  assert.deepEqual(requests, [])
})

test('router link respects app base URL overrides in all codex config spellings', async () => {
  const root = await tempDir('ae-link-')
  const { url, requests } = await fakeRouter(root, 'native')
  for (const argv of [
    ['-c', 'openai_base_url="https://proxy.example/v1"', 'app-server'],
    ['--config', 'openai_base_url = "https://proxy.example/v1"', 'app-server'],
    ['--config=openai_base_url="https://proxy.example/v1"', 'app-server'],
    ['-copenai_base_url="https://proxy.example/v1"', 'app-server'],
    [
      '-c',
      `openai_base_url="${url}"`,
      '-c',
      'openai_base_url="https://proxy.example/v1"',
      'app-server',
    ],
  ]) {
    assert.equal(appOpenaiBaseUrl(argv), 'https://proxy.example/v1')
    const linked = await linkRouter(argv, { root, env: envFor(url) })
    assert.equal(linked.state.attached, false)
    assert.match(linked.state.reason, /its own openai_base_url/)
  }
  assert.deepEqual(requests, [])
})

test('native eligibility requires current settings and running/router/installed proof agreement', async () => {
  const root = await tempDir('ae-link-')
  const { url } = await fakeRouter(root, 'native')
  prove(root)
  configure(root, { claims: { graceMs: 17 } })
  assert.equal(
    (await linkRouter(['app-server'], { root, env: envFor(url) })).state.fanout,
    'bridge',
  )
  prove(root)
  assert.equal(
    (await linkRouter(['app-server'], { root, env: envFor(url) })).state.fanout,
    'native',
  )
  configure(root, { router: { multiAgentV1: false } })
  prove(root)
  assert.equal(
    (await linkRouter(['app-server'], { root, env: envFor(url) })).state.fanout,
    'bridge',
  )
  configure(root, {})
  mkdirSync(join(enginePaths(root).lib, 'stale-lib'), { recursive: true })
  symlinkSync('stale-lib', join(enginePaths(root).lib, 'current'))
  prove(root)
  assert.equal(
    (await linkRouter(['app-server'], { root, env: envFor(url) })).state.fanout,
    'bridge',
  )
  const privateRoot = await tempDir('ae-link-')
  prove(privateRoot)
  const foreign = await fakeRouter(privateRoot, 'native', { version: 'different-running-lib' })
  assert.equal(
    (await linkRouter(['app-server'], { root: privateRoot, env: envFor(foreign.url) })).state
      .fanout,
    'bridge',
  )
  const unreadable = {
    ...proofKey(privateRoot),
    appVersion: null,
  }
  assert.throws(
    () => markProven(privateRoot, 'native-fanout', 'unreadable versions', unreadable),
    /invalid proof/,
  )
  // Simulate retained legacy invalid evidence; the strict public producer refuses it.
  writeFileSync(
    join(enginePaths(privateRoot).state, 'proven.json'),
    JSON.stringify({
      paths: {
        'native-fanout': {
          at: new Date().toISOString(),
          detail: 'legacy invalid',
          key: unreadable,
        },
      },
    }),
  )
  assert.equal(
    (await linkRouter(['app-server'], { root: privateRoot, env: envFor(url) })).state.fanout,
    'bridge',
  )
})

test('current proof drift stops model routing without pretending the existing GPT child has a bridge', async () => {
  const root = await tempDir('ae-link-')
  configure(root, { modes: { codexClaude: 'model' } })
  prove(root)
  const { url } = await fakeRouter(root, 'native', { mode: 'model' })
  await linkRouter(['app-server'], { root, env: envFor(url) })
  assert.equal(routerServesClaude(), true)
  configure(root, { modes: { codexClaude: 'model' }, claims: { graceMs: 7 } })
  assert.equal(routerServesClaude(), false)
  assert.equal(nativeFanout(), true, 'spawn-time MCP decision remains fixed')
  prove(root)
  assert.equal(
    routerServesClaude(),
    false,
    'a new local proof cannot rewrite the selected router key snapshot',
  )
  await linkRouter(['app-server'], { root, env: envFor(url) })
  assert.equal(routerServesClaude(), true)
  mkdirSync(join(enginePaths(root).lib, 'different-lib'), { recursive: true })
  symlinkSync('different-lib', join(enginePaths(root).lib, 'current'))
  prove(root)
  assert.equal(routerServesClaude(), false)
})

test('router and native degraded markers keep their separate safe fallbacks', async () => {
  const root = await tempDir('ae-link-')
  const { url } = await fakeRouter(root, 'native')
  prove(root)
  markDegraded(root, 'native-fanout', 'no claim.done')
  const bridged = await linkRouter(['app-server'], { root, env: envFor(url) })
  assert.equal(bridged.state.attached, true)
  assert.equal(bridged.state.fanout, 'bridge')
  assert.match(bridged.state.reason, /degraded/)
  markDegraded(root, 'router', 'GPT failed')
  assert.equal((await linkRouter(['app-server'], { root, env: envFor(url) })).state.attached, false)
  const malformed = await tempDir('ae-link-')
  mkdirSync(enginePaths(malformed).state, { recursive: true })
  writeFileSync(join(enginePaths(malformed).state, 'degraded.json'), '{bad')
  assert.equal(
    (await linkRouter(['app-server'], { root: malformed, env: envFor(url) })).state.fanout,
    'bridge',
  )
})

function adapterWith(root: string, url: string, extra: NodeJS.ProcessEnv = {}) {
  const home = join(root, 'home')
  const client = launchAdapter({
    ANYENGINE_ROOT: root,
    ANYENGINE_ROUTER_URL: url,
    ANYENGINE_HOME: home,
    ANYENGINE_DEBUG_LOG: join(home, 'debug.jsonl'),
    ANYENGINE_REAL_CODEX: fakeCodexAt(root),
    ANYENGINE_MODELS: 'opus,sonnet',
    ANYENGINE_RUNTIME_TYPE: 'mock',
    FAKE_CODEX_ARGV_FILE: join(root, 'argv.json'),
    FAKE_CODEX_REQUESTS_FILE: join(root, 'requests.jsonl'),
    FAKE_CODEX_STATE_FILE: join(root, 'state.json'),
    FAKE_CODEX_NO_APPROVAL: '1',
    ANYENGINE_RUNTIME_ENV: join(home, 'missing.env'),
    ANYENGINE_NATIVE_CODEX: '',
    CLAUDE_CODEX_NATIVE_CODEX: '',
    ...extra,
  })
  closers.push(() => client.close())
  return client
}
const argvOf = (root: string): string =>
  JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8')).argv.join(' ')
const requestsOf = (root: string): Wire[] =>
  readFileSync(join(root, 'requests.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
async function initialize(client: ReturnType<typeof adapterWith>) {
  await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
}
async function turn(
  client: ReturnType<typeof adapterWith>,
  threadId: string,
  model: string | null,
  text: string,
) {
  const start = await client.request('turn/start', {
    threadId,
    model,
    input: [{ type: 'text', text }],
  })
  assert.ok(start.result, JSON.stringify(start))
  await client.waitFor(
    (m) =>
      m.method === 'turn/completed' &&
      m.params.threadId === threadId &&
      m.params.turn.id === start.result.turn.id,
  )
}

test('adapter native GPT gets no bridge server/instruction while its claim socket stays usable', async () => {
  const root = await tempDir('ae-link-')
  prove(root, true)
  const client = adapterWith(root, (await fakeRouter(root, 'native')).url)
  await initialize(client)
  const started = await client.request('thread/start', {
    model: 'gpt-6-sol',
    cwd: root,
    developerInstructions: 'Be terse.',
  })
  assert.equal(
    started.result.receivedDeveloperInstructions,
    'Be terse.',
    readFileSync(join(root, 'home/debug.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('router.link'))
      .join('\n'),
  )
  assert.match(argvOf(root), /openai_base_url=/)
  assert.doesNotMatch(argvOf(root), /mcp_servers\.anyengine/)
  const owner = await adapterOwns(
    enginePaths(root).run,
    started.result.thread.id,
    AbortSignal.timeout(30000),
  )
  assert.ok(owner, 'native child retains its owning adapter claim socket')
  assert.equal(owner.cwd, root)
})

test('adapter fallback GPT gets exactly one bridge line and bridge server for each unavailable native path', async () => {
  for (const path of ['bridge', 'native', 'down'] as const) {
    const root = await tempDir('ae-link-')
    const url =
      path === 'down' ? 'http://127.0.0.1:9/backend-api/codex' : (await fakeRouter(root, path)).url
    const client = adapterWith(root, url)
    await initialize(client)
    const started = await client.request('thread/start', {
      model: 'gpt-6-sol',
      developerInstructions: 'Be terse.',
    })
    assert.equal(
      started.result.receivedDeveloperInstructions,
      `Be terse.\n\n${BRIDGE_LINE_GPT}`,
      path,
    )
    assert.equal(argvOf(root).includes('openai_base_url='), path !== 'down')
    assert.match(argvOf(root), /mcp_servers\.anyengine/)
    const resumed = await client.request('thread/resume', {
      threadId: started.result.thread.id,
      developerInstructions: started.result.receivedDeveloperInstructions,
    })
    assert.equal(
      resumed.result.receivedDeveloperInstructions,
      started.result.receivedDeveloperInstructions,
    )
    await client.close()
  }
})

test('adapter model mode routes recognized Claude including provider metadata; title/helper and provider-only stay local', async () => {
  const root = await tempDir('ae-link-')
  configure(root, { modes: { codexClaude: 'model' } })
  prove(root, true)
  const client = adapterWith(root, (await fakeRouter(root, 'native', { mode: 'model' })).url, {
    ANYENGINE_TITLE_ROUTE: 'local',
  })
  await initialize(client)
  for (const params of [{ model: 'opus' }, { model: 'sonnet', modelProvider: 'claude-code' }]) {
    const started = await client.request('thread/start', { cwd: root, ...params })
    assert.match(started.result.thread.id, /^fake-thread-/)
    assert.equal(started.result.receivedDeveloperInstructions, null)
  }
  for (const params of [
    { modelProvider: 'claude-code' },
    { model: 'private-model', modelProvider: 'claude-code' },
    { model: 'opus', ephemeral: true },
    { model: 'sonnet', threadSource: 'title_generation' },
    { model: 'sonnet', threadSource: 'memory_consolidation' },
  ]) {
    const started = await client.request('thread/start', params)
    assert.ok(started.result, JSON.stringify(started))
    assert.doesNotMatch(started.result.thread.id, /^fake-thread-/)
  }
  assert.equal(requestsOf(root).filter((r) => r.method === 'thread/start').length, 2)
})

test('adapter local Claude history switches to native model mode and back with persisted ownership', async () => {
  const root = await tempDir('ae-link-')
  configure(root, { modes: { codexClaude: 'model' } })
  const { url } = await fakeRouter(root, 'native', { mode: 'model' })
  let client = adapterWith(root, url)
  await initialize(client)
  const started = await client.request('thread/start', {
    model: 'sonnet',
    modelProvider: 'claude-code',
    cwd: root,
  })
  const id = started.result.thread.id
  await turn(client, id, null, 'remember local history')
  await client.close()
  prove(root, true)
  client = adapterWith(root, url)
  await initialize(client)
  const switched = await client.request('thread/settings/update', { threadId: id, model: 'sonnet' })
  assert.ok(switched.result, JSON.stringify(switched))
  await turn(client, id, null, 'native continuation')
  const calls = requestsOf(root)
  assert.ok(
    calls.some(
      (r) =>
        r.method === 'thread/inject_items' &&
        JSON.stringify(r.params).includes('remember local history'),
    ),
  )
  assert.ok(calls.some((r) => r.method === 'turn/start' && r.params.model === null))
  await turn(client, id, 'opus', 'switch native Claude model')
  configure(root, { modes: { codexClaude: 'agent' } })
  const returned = await client.request('thread/settings/update', { threadId: id, model: 'sonnet' })
  assert.ok(returned.result, JSON.stringify(returned))
  await turn(client, id, null, 'carry native history')
  await turn(client, id, null, 'system prompt check')
  const localAnswer = client.messages
    .filter((m) => m.method === 'item/agentMessage/delta' && m.params.threadId === id)
    .map((m) => m.params.delta)
    .join('')
  assert.ok(
    localAnswer.includes('native continuation'),
    'native history carried back to local agent',
  )
  assert.ok(localAnswer.includes(BRIDGE_LINE), 'local agent keeps the one-line bridge')
  const read = await client.request('thread/read', { threadId: id, includeTurns: true })
  assert.ok(JSON.stringify(read.result.thread.turns).includes('remember local history'))
  assert.ok(JSON.stringify(read.result.thread.turns).includes('native continuation'))
})

test('adapter unproven model mode and native agent mode both retain local Claude routing', async () => {
  for (const mode of ['model', 'agent']) {
    const root = await tempDir('ae-link-')
    configure(root, { modes: { codexClaude: mode } })
    if (mode === 'agent') prove(root, true)
    const client = adapterWith(root, (await fakeRouter(root, 'native')).url)
    await initialize(client)
    const started = await client.request('thread/start', {
      model: 'opus',
      modelProvider: 'claude-code',
    })
    await turn(client, started.result.thread.id, 'opus', 'local turn')
    assert.equal(
      requestsOf(root).some((r) => r.method === 'thread/start' && r.params.model === 'opus'),
      false,
    )
    await client.close()
  }
})

test('native model-mode adapter ownership admits a real router trampoline turn and refuses unknown threads', async (t) => {
  const priorCodex = process.env.ANYENGINE_REAL_CODEX
  t.after(() => {
    if (priorCodex === undefined) delete process.env.ANYENGINE_REAL_CODEX
    else process.env.ANYENGINE_REAL_CODEX = priorCodex
  })
  const h = await setup(t, false)
  process.env.ANYENGINE_REAL_CODEX = fakeCodexAt(h.root)
  h.scenario('plan')
  prove(h.root, true)
  h.runtime.fanout.observeCatalog(h.backend.models)
  const client = adapterWith(h.root, h.router.baseUrl)
  await initialize(client)
  const started = await client.request('thread/start', {
    model: 'opus',
    modelProvider: 'claude-code',
    cwd: h.root,
  })
  assert.match(started.result.thread.id, /^fake-thread-/)
  const send = async (id: string) =>
    frames(
      await (
        await fetch(`${h.router.baseUrl}/responses`, {
          method: 'POST',
          headers: { 'thread-id': id },
          body: JSON.stringify(body()),
          signal: AbortSignal.timeout(30000),
        })
      ).text(),
    )
  const accepted = await send(started.result.thread.id)
  assert.equal(accepted.at(-1)?.type, 'response.completed', JSON.stringify(accepted))
  assert.match(textOf(output(accepted)), /1\. Do X/)
  const denied = await send('unowned')
  assert.equal(denied.at(-1)?.type, 'response.failed')
  assert.equal(h.calls().filter((call) => call.args?.includes('-p')).length, 1)
  await client.close()
})

test('adapter fallback handover creates GPT with the bridge line and keeps it on resume', async () => {
  const root = await tempDir('ae-link-')
  const client = adapterWith(root, 'http://127.0.0.1:9/backend-api/codex')
  await initialize(client)
  const started = await client.request('thread/start', { model: 'sonnet', cwd: root })
  const id = started.result.thread.id
  await turn(client, id, 'gpt-6-sol', 'move to GPT')
  const created = requestsOf(root).find(
    (r) => r.method === 'thread/start' && r.params.model === 'gpt-6-sol',
  )
  assert.equal(created?.params.developerInstructions, BRIDGE_LINE_GPT)
  await turn(client, id, 'sonnet', 'local again')
  await turn(client, id, 'gpt-6-sol', 'resume GPT')
  const resumed = requestsOf(root).find((r) => r.method === 'thread/resume')
  assert.equal(
    resumed?.params.developerInstructions,
    undefined,
    'known-child resume preserves configured instructions',
  )
})

test('direct GPT handover keeps the local desktop block and preserves stored instructions on warm and cold resume', async () => {
  for (const cold of [false, true]) {
    const root = await tempDir('ae-instructions-')
    const client = adapterWith(root, 'http://127.0.0.1:9/backend-api/codex', {
      ...(cold ? { FAKE_CODEX_COLD_RESUME: '1' } : {}),
    })
    await initialize(client)
    const desktop = 'Avoid SELECT *.'
    const started = await client.request('thread/start', {
      model: 'sonnet',
      cwd: root,
      developerInstructions: desktop,
    })
    const id = started.result.thread.id
    await turn(client, id, 'gpt-6-sol', 'move to GPT')
    const child = requestsOf(root).find((r) => r.method === 'thread/start')
    assert.equal(child?.params.developerInstructions, `${desktop}\n\n${BRIDGE_LINE_GPT}`)
    await turn(client, id, 'sonnet', 'return local')
    await turn(client, id, 'gpt-6-sol', 'resume configured GPT')
    const resumed = requestsOf(root).find((r) => r.method === 'thread/resume')
    assert.equal(resumed?.params.developerInstructions, undefined)
    const instructions = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).instructions
    assert.deepEqual(Object.values(instructions), [`${desktop}\n\n${BRIDGE_LINE_GPT}`])
    await client.close()
  }
})

test('adapter instruction and bridge opt-outs survive fallback routing', async () => {
  for (const extra of [{ ANYENGINE_BRIDGE_INSTRUCTIONS: '0' }, { ANYENGINE_BRIDGE: '0' }]) {
    const root = await tempDir('ae-link-')
    const client = adapterWith(root, 'http://127.0.0.1:9/backend-api/codex', extra)
    await initialize(client)
    const started = await client.request('thread/start', {
      model: 'gpt-6-sol',
      developerInstructions: 'Keep mine.',
    })
    assert.equal(started.result.receivedDeveloperInstructions, 'Keep mine.')
    if (extra.ANYENGINE_BRIDGE === '0') assert.doesNotMatch(argvOf(root), /mcp_servers\.anyengine/)
    await client.close()
  }
})

test('adapter proof drift rehomes a null-model Claude continuation while ordinary GPT stays upstream', async () => {
  const root = await tempDir('ae-link-')
  configure(root, { modes: { codexClaude: 'model' } })
  prove(root, true)
  const client = adapterWith(root, (await fakeRouter(root, 'native', { mode: 'model' })).url)
  await initialize(client)
  const claude = await client.request('thread/start', { model: 'opus', cwd: root })
  const gpt = await client.request('thread/start', { model: 'gpt-6-sol', cwd: root })
  configure(root, { modes: { codexClaude: 'model' }, claims: { graceMs: 7 } })
  await turn(client, claude.result.thread.id, null, 'system prompt check')
  const answer = client.messages
    .filter(
      (m) =>
        m.method === 'item/agentMessage/delta' && m.params.threadId === claude.result.thread.id,
    )
    .map((m) => m.params.delta)
    .join('')
  assert.match(
    answer,
    /^systemPromptAddendum=/,
    'proof drift resolves the actual Claude model before routing a null-model turn',
  )
  assert.ok(answer.includes(BRIDGE_LINE))
  await turn(client, gpt.result.thread.id, null, 'ordinary GPT')
  assert.ok(
    requestsOf(root).some(
      (r) => r.method === 'turn/start' && r.params.threadId === gpt.result.thread.id,
    ),
  )
})

test('native attachment and model routing require the health producer to report the configured Claude mode', async () => {
  const root = await tempDir('ae-link-')
  configure(root, { modes: { codexClaude: 'model' } })
  prove(root)
  const { url } = await fakeRouter(root, 'native', { mode: 'agent' })
  const linked = await linkRouter(['app-server'], { root, env: envFor(url) })
  assert.equal(linked.state.fanout, 'bridge')
  assert.equal(routerServesClaude(), false)
})

test('adapter null-model fallback reads the latest same-child picker model and fails unavailable metadata', async () => {
  for (const failRead of [false, true]) {
    const root = await tempDir('ae-link-')
    configure(root, { modes: { codexClaude: 'model' } })
    prove(root, true)
    const client = adapterWith(
      root,
      (await fakeRouter(root, 'native', { mode: 'model' })).url,
      failRead ? { FAKE_CODEX_FAIL_READ: '1' } : {},
    )
    await initialize(client)
    const start = await client.request('thread/start', {
      model: 'gpt-6-sol',
      cwd: root,
      sandbox: 'read-only',
    })
    const id = start.result.thread.id
    await client.request('thread/settings/update', { threadId: id, model: 'opus' })
    await client.request('thread/settings/update', { threadId: id, model: 'gpt-6-sol' })
    await client.request('thread/settings/update', {
      threadId: id,
      model: 'sonnet',
      sandboxPolicy: { type: 'readOnly' },
      approvalPolicy: 'never',
      collaborationMode: { mode: 'plan' },
    })
    configure(root, { modes: { codexClaude: 'agent' } })
    if (failRead) {
      const denied = await client.request('turn/start', {
        threadId: id,
        model: null,
        input: [{ type: 'text', text: 'continue' }],
      })
      assert.match(denied.error?.message, /could not determine the owned thread model/)
      assert.equal(
        requestsOf(root).some((r) => r.method === 'turn/start'),
        false,
      )
    } else {
      await turn(client, id, null, 'model effort check')
      const answer = client.messages
        .filter((m) => m.method === 'item/agentMessage/delta' && m.params.threadId === id)
        .map((m) => m.params.delta)
        .join('')
      assert.match(answer, /model=sonnet/)
      const resumed = await client.request('thread/resume', { threadId: id })
      assert.equal(
        resumed.result.sandbox.type,
        'readOnly',
        'thread/read does not loosen prior posture',
      )
      assert.equal(resumed.result.approvalPolicy, 'never', 'omitted approval keeps prior bounds')
    }
    await client.close()
  }
})

test('native proof matches an installed running library and rejects unreadable Codex versions', async () => {
  const root = await tempDir('ae-link-')
  mkdirSync(join(enginePaths(root).lib, routerVersion()), { recursive: true })
  symlinkSync(routerVersion(), join(enginePaths(root).lib, 'current'))
  const { url } = await fakeRouter(root, 'native')
  prove(root)
  assert.equal(
    (await linkRouter(['app-server'], { root, env: envFor(url) })).state.fanout,
    'native',
  )
  const unreadable = { ...proofKey(root), codexVersion: null }
  assert.throws(
    () => markProven(root, 'native-fanout', 'unreadable Codex', unreadable),
    /invalid proof/,
  )
  writeFileSync(
    join(enginePaths(root).state, 'proven.json'),
    JSON.stringify({
      paths: {
        'native-fanout': {
          at: new Date().toISOString(),
          detail: 'legacy invalid',
          key: unreadable,
        },
      },
    }),
  )
  assert.equal(
    (await linkRouter(['app-server'], { root, env: envFor(url) })).state.fanout,
    'bridge',
  )
})

test('adapter rechecks ownership and active turns after a held metadata lookup', async () => {
  for (const active of [false, true]) {
    const root = await tempDir('ae-link-')
    configure(root, { modes: { codexClaude: 'model' } })
    prove(root, true)
    const gate = join(root, 'read-release')
    const client = adapterWith(root, (await fakeRouter(root, 'native', { mode: 'model' })).url, {
      FAKE_CODEX_HOLD_FIRST_READ: gate,
      ...(active ? { FAKE_CODEX_READ_ACTIVE_TURN: '1' } : {}),
    })
    await initialize(client)
    const started = await client.request('thread/start', { model: 'opus', cwd: root })
    const id = started.result.thread.id
    configure(root, { modes: { codexClaude: 'agent' } })
    const waiting = client.request('turn/start', {
      threadId: id,
      model: null,
      input: [{ type: 'text', text: 'system prompt check' }],
    })
    await eventually(() => requestsOf(root).some((r) => r.method === 'thread/read'))
    if (!active) {
      const moved = await client.request('thread/settings/update', {
        threadId: id,
        model: 'sonnet',
      })
      assert.ok(moved.result, JSON.stringify(moved))
    }
    writeFileSync(gate, 'release')
    const answer = await waiting
    if (active) {
      assert.match(answer.error?.message, /still answering/)
      assert.equal(
        requestsOf(root).some((r) => r.method === 'turn/start'),
        false,
      )
    } else {
      assert.ok(answer.result, JSON.stringify(answer))
      await client.waitFor(
        (m) =>
          m.method === 'turn/completed' &&
          m.params.threadId === id &&
          m.params.turn.id === answer.result.turn.id,
      )
      const deltas = client.messages
        .filter((m) => m.method === 'item/agentMessage/delta' && m.params.threadId === id)
        .map((m) => m.params.delta)
        .join('')
      assert.match(deltas, /^systemPromptAddendum=/)
    }
    await client.close()
  }
})

test('selected-model metadata preserves prior bounds for absent and unknown posture fields', async () => {
  const root = await tempDir('ae-link-')
  await linkRouter(['app-server'], {
    root,
    env: envFor('http://127.0.0.1:9/backend-api/codex'),
  })
  const prior = {
    ...DEFAULT_POSTURE,
    approval: 'never' as const,
    plan: true,
    trust: 'untrusted' as const,
    readRestricted: true,
    projectBaseline: { saved: 'fingerprint' },
  }
  const diagnostics: string[] = []
  const write = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    diagnostics.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    for (const fields of [
      {},
      {
        sandbox: { type: 'futureSandbox' },
        approvalPolicy: 'futureApproval',
        approvalsReviewer: 'futureReviewer',
        collaborationMode: { mode: 'futureMode' },
      },
    ]) {
      const threads = new Map<string, UpstreamThreadInfo>([
        ['owned', { cwd: root, model: 'gpt-6-sol', posture: prior }],
      ])
      const upstream = {
        async request(method: string, params: unknown, timeoutMs?: number) {
          assert.equal(method, 'thread/read')
          assert.deepEqual(params, { threadId: 'owned' })
          assert.equal(timeoutMs, 5000)
          return { thread: { id: 'owned', cwd: root, model: 'sonnet', ...fields } }
        },
      }
      assert.equal(await routedTurnModel('', 'owned', upstream, threads), 'sonnet')
      const cached = threads.get('owned')
      assert.ok(cached)
      assert.equal(cached.model, 'sonnet')
      assert.equal(noLooser(cached.posture, prior, postureContext(root)), true)
      assert.equal(cached.posture.plan, true)
      assert.deepEqual(cached.posture.projectBaseline, prior.projectBaseline)
    }
  } finally {
    process.stderr.write = write
  }
  assert.deepEqual(diagnostics, [
    '[anyengine] unknown collaboration mode "futureMode": read as plan\n',
  ])
})

test('adapter invalidates selected-model replies before caching or rehome after ownership deletion', async () => {
  for (const readAt of [1, 2]) {
    for (const reannounce of [false, true]) {
      const root = await tempDir('ae-link-')
      configure(root, { modes: { codexClaude: 'model' } })
      prove(root, true)
      const client = adapterWith(root, (await fakeRouter(root, 'native', { mode: 'model' })).url, {
        FAKE_CODEX_READ_DELETE_THREAD: '1',
        FAKE_CODEX_READ_INVALIDATE_AT: String(readAt),
        ...(reannounce ? { FAKE_CODEX_READ_REANNOUNCE_THREAD: '1' } : {}),
      })
      await initialize(client)
      const started = await client.request('thread/start', { model: 'opus', cwd: root })
      const id = started.result.thread.id
      configure(root, { modes: { codexClaude: 'agent' } })
      const answer = await client.request('turn/start', {
        threadId: id,
        model: null,
        input: [{ type: 'text', text: 'continue after read' }],
      })
      assert.ok(answer.error, 'the old selection cannot start a turn after ownership invalidation')
      assert.equal(
        requestsOf(root).some((r) => r.method === 'turn/start'),
        false,
      )
      assert.equal(
        readFileSync(join(root, 'home/debug.jsonl'), 'utf8').includes('"event":"thread.rehomed"'),
        false,
      )
      const owner = await adapterOwns(enginePaths(root).run, id, AbortSignal.timeout(30000))
      if (reannounce)
        assert.equal(owner?.cwd ?? null, null, 'a new announcement cannot inherit late metadata')
      else assert.equal(owner, null, 'late metadata cannot revive deleted ownership')
      await client.close()
    }
  }
})

test('adapter refuses local adoption if a child turn starts during the handover transcript read', async () => {
  const root = await tempDir('ae-read-active-')
  configure(root, { modes: { codexClaude: 'model' } })
  prove(root, true)
  const client = adapterWith(root, (await fakeRouter(root, 'native', { mode: 'model' })).url, {
    FAKE_CODEX_READ_ACTIVE_AT: '2',
  })
  await initialize(client)
  const started = await client.request('thread/start', { model: 'opus', cwd: root })
  configure(root, { modes: { codexClaude: 'agent' } })
  const answer = await client.request('turn/start', {
    threadId: started.result.thread.id,
    model: null,
    input: [{ type: 'text', text: 'continue' }],
  })
  assert.ok(answer.error, 'the active child cannot be adopted while its transcript is read')
  assert.equal(
    requestsOf(root).some((r) => r.method === 'turn/start'),
    false,
  )
  assert.equal(
    readFileSync(join(root, 'home/debug.jsonl'), 'utf8').includes('"event":"thread.rehomed"'),
    false,
  )
})

const quietRouterLog = { path: 'unused', info() {}, error() {} }
test('actual router health binds native qualification to the selected router full proof key', async (t) => {
  const adapterRoot = await tempDir('ae-key-adapter-')
  const routerRoot = await tempDir('ae-key-router-')
  configure(adapterRoot, { modes: { codexClaude: 'model' } })
  configure(routerRoot, { modes: { codexClaude: 'model' }, claims: { graceMs: 17 } })
  prove(adapterRoot)
  prove(routerRoot)
  const routerKey = proofKey(routerRoot)
  const adapterKey = proofKey(adapterRoot)
  assert.notEqual(adapterKey.settings, routerKey.settings)
  const runtime = buildRouterRuntime(routerRoot, quietRouterLog)
  const router = await startRouter({
    root: routerRoot,
    port: 0,
    hooks: runtime.hooks,
    log: quietRouterLog,
  })
  t.after(() => router.close())
  const linked = await linkRouter(['app-server'], {
    root: adapterRoot,
    env: envFor(router.baseUrl),
  })
  assert.equal(linked.state.attached, true, 'ordinary healthy bridge attachment remains available')
  assert.equal(linked.state.fanout, 'bridge', 'a foreign settings proof cannot qualify the adapter')
  const health = asRecord(
    await (await fetch(router.baseUrl.replace('/backend-api/codex', '/health'))).json(),
  )
  assert.deepEqual(health.proofKey, routerKey)
  assert.deepEqual(Object.keys(asRecord(health.proofKey)).sort(), [
    'appVersion',
    'codexVersion',
    'lib',
    'settings',
  ])
})

test('native attachment rejects missing and each mismatching selected-router proof field', async () => {
  const root = await tempDir('ae-key-')
  prove(root)
  const key = proofKey(root)
  for (const selected of [
    undefined,
    { ...key, lib: 'another-lib' },
    { ...key, appVersion: 'another-app' },
    { ...key, codexVersion: 'another-codex' },
    { ...key, settings: 'another-settings' },
  ]) {
    const { url } = await fakeRouter(root, 'native', { proofKey: selected })
    const linked = await linkRouter(['app-server'], { root, env: envFor(url) })
    assert.equal(linked.state.attached, true)
    assert.equal(linked.state.fanout, 'bridge')
  }
})

test('adapter CODEX_REAL fallback requires proof for the actual selected child version', async () => {
  const root = await tempDir('ae-real-')
  prove(root)
  const client = adapterWith(
    root,
    (await fakeRouter(root, 'native', { proofKey: proofKey(root) })).url,
    {
      ANYENGINE_REAL_CODEX: '',
      ANYENGINE_MOCK: '',
      CODEX_REAL: fakeCodexAt(root),
    },
  )
  await initialize(client)
  const started = await client.request('thread/start', { model: 'gpt-6-sol' })
  assert.equal(started.result.receivedDeveloperInstructions, BRIDGE_LINE_GPT)
  assert.match(argvOf(root), /mcp_servers\.anyengine/)
})

test('actual router and adapter qualify the same CODEX_REAL child without GPT bridge attachment', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const root = await tempDir('ae-real-native-')
  configure(root, { modes: { codexClaude: 'model' } })
  const binary = fakeCodexAt(root)
  const prior = process.env.CODEX_REAL
  process.env.CODEX_REAL = binary
  t.after(() => {
    if (prior === undefined) delete process.env.CODEX_REAL
    else process.env.CODEX_REAL = prior
  })
  prove(root)
  assert.equal(proofKey(root).codexVersion, '0.153.4-fake')
  const runtime = buildRouterRuntime(root, quietRouterLog)
  const router = await startRouter({ root, port: 0, hooks: runtime.hooks, log: quietRouterLog })
  t.after(() => router.close())
  const health = asRecord(
    await (await fetch(router.baseUrl.replace('/backend-api/codex', '/health'))).json(),
  )
  assert.equal(asRecord(health.proofKey).codexVersion, '0.153.4-fake')
  assert.equal(asRecord(health.fanout).path, 'native')
  const client = adapterWith(root, router.baseUrl, {
    ANYENGINE_REAL_CODEX: '',
    ANYENGINE_MOCK: '',
    CODEX_REAL: binary,
  })
  await initialize(client)
  assert.equal(readCompatibility(root)?.codexPath, binary)
  const events = readFileSync(join(root, 'home/debug.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.ok(
    events.some((event) => event.event === 'codex.upstream.spawn' && event.binary === binary),
    'native qualification must be exercised through the admitted adapter child',
  )
  const started = await client.request('thread/start', {
    model: 'gpt-6-sol',
    developerInstructions: 'Keep the desktop block.',
  })
  assert.equal(started.result.receivedDeveloperInstructions, 'Keep the desktop block.')
  assert.doesNotMatch(argvOf(root), /mcp_servers\.anyengine/)
  const claude = await client.request('thread/start', {
    model: 'opus',
    modelProvider: 'claude-code',
  })
  assert.match(claude.result.thread.id, /^fake-/)
})
