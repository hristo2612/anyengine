import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { enginePaths, setConfigValue } from '../../src/anyengine-config.mjs'
import { type ClaimHost, ClaimServer } from '../../src/claim-server.mjs'
import type { ClaimThread } from '../../src/claim-types.mjs'
import { DEFAULT_POSTURE } from '../../src/posture.mjs'
import { buildRouterRuntime } from '../../src/router-hooks.mjs'
import { createRouterLog } from '../../src/router-log.mjs'
import { startRouter } from '../../src/router-server.mjs'
import type { RuntimeTurnContext } from '../../src/types.mjs'
import { spawn } from './children.mjs'
import { startFakeBackend } from './fake-backend.mjs'
import { tempDir } from './tmp.mjs'

export const user = (text: string) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
})
export const tools = [
  { type: 'function', name: 'request_user_input', parameters: { type: 'object' } },
  {
    type: 'namespace',
    name: 'codex_app',
    tools: [
      {
        type: 'function',
        name: 'list_threads',
        description: 'List tasks',
        parameters: { type: 'object', properties: { limit: { type: 'number' } } },
      },
    ],
  },
  { type: 'namespace', name: 'mcp__cua_repl', tools: [{ type: 'function', name: 'js' }] },
  {
    type: 'custom',
    name: 'exec',
    description: 'x'.repeat(5000),
    format: { syntax: 'lark', definition: 'start: /.+/' },
  },
]
export const body = (input: unknown[] = [user('list my tasks')], extra = {}) => ({
  model: 'opus',
  input,
  tools,
  ...extra,
})
export function frames(sse: string): any[] {
  return sse
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
}
export const output = (events: any[]) => events.at(-1)?.response?.output ?? []
export const textOf = (items: any[]) =>
  items
    .filter((item) => item.type === 'message')
    .map((item) => item.content[0].text)
    .join('\n')
export function jsonLines(file: string): any[] {
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
}
export async function eventually(check: () => boolean): Promise<void> {
  const until = Date.now() + 30000
  while (!check()) {
    if (Date.now() > until) throw new Error('condition timed out')
    await delay(20)
  }
}
export async function setup(t: TestContext, claim = true) {
  const root = await tempDir('ae-tt-')
  const logFile = join(root, 'calls.jsonl')
  const settings = join(root, 'fixture.json')
  const scenario = (name: string, tool = 'codex_app__list_threads') =>
    writeFileSync(settings, JSON.stringify({ name, tool }))
  scenario('codex-tools')
  const cli = join(root, 'fake.mjs')
  writeFileSync(
    cli,
    `#!${process.execPath}
import fs from 'node:fs';
const config = JSON.parse(fs.readFileSync(${JSON.stringify(settings)}, 'utf8'));
process.env.FAKE_CLAUDE_LOG = ${JSON.stringify(logFile)};
process.env.FAKE_CLAUDE_SCENARIO = config.name;
process.env.FAKE_CODEX_TOOL = config.tool;
await import(${JSON.stringify(new URL(`file://${resolve('test/fixtures/fake-claude-print.mjs')}`).href)});
`,
    { mode: 0o755 },
  )
  const warm = spawn(cli, ['--help'], { stdio: 'ignore' })
  assert.equal((await once(warm, 'close'))[0], 0)
  setConfigValue(root, 'modes.codexClaude', 'model')
  setConfigValue(root, 'claude.cli', cli)
  const contexts: RuntimeTurnContext[] = []
  const threads = new Map<string, ClaimThread>(
    ['a', 'b'].map((threadId) => [
      threadId,
      {
        threadId,
        parentThreadId: 'parent',
        parentCwd: null,
        cwd: root,
        model: 'opus',
        posture: DEFAULT_POSTURE,
      },
    ]),
  )
  const claimHost: ClaimHost = {
    claimThread: (id) => threads.get(id) ?? null,
    waitForClaimThread: async (id) => threads.get(id) ?? null,
    knowsThread: (id) => threads.has(id),
    mcpServersFor: () => null,
    runtime: {
      async runTurn(context, handlers) {
        contexts.push(context)
        await handlers.onEvent({ type: 'completed', success: true, result: 'agent answer' })
      },
      async interrupt() {},
      async steer() {},
      async stop() {},
    },
  }
  let claims = new ClaimServer(claimHost, {
    runDir: enginePaths(root).run,
    graceMs: 0,
    idleReleaseMs: 60000,
  })
  const restartClaims = async () => {
    await claims.stop()
    claims = new ClaimServer(claimHost, {
      runDir: enginePaths(root).run,
      graceMs: 0,
      idleReleaseMs: 60000,
    })
    await claims.start()
  }
  if (claim) await claims.start()
  const backend = await startFakeBackend()
  const log = createRouterLog(join(root, 'router.log'))
  const runtime = buildRouterRuntime(root, log)
  const router = await startRouter({
    root,
    port: 0,
    upstream: backend.url,
    hooks: runtime.hooks,
    log,
  })
  t.after(async () => {
    await router.close(0)
    await claims.stop()
    await backend.close()
  })
  const send = async (input = body(), thread = 'a') =>
    frames(
      await (
        await fetch(`${router.baseUrl}/responses`, {
          method: 'POST',
          headers: { 'thread-id': thread },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(30000),
        })
      ).text(),
    )
  const socket = async () => {
    const ws = new WebSocket(`${router.baseUrl.replace('http:', 'ws:')}/responses`, {
      headers: {
        'x-codex-turn-metadata': JSON.stringify({ turn_id: 'stale', request_kind: 'prewarm' }),
      },
    })
    await once(ws, 'open')
    t.after(() => ws.terminate())
    return ws
  }
  return {
    root,
    cli,
    scenario,
    router,
    runtime,
    backend,
    threads,
    contexts,
    claimHost,
    claims,
    restartClaims,
    send,
    socket,
    calls: () => jsonLines(logFile),
    listed: () => jsonLines(`${logFile}.codex-tools`),
    sockets: () => {
      try {
        return readdirSync(join(root, 'router/tools'))
      } catch {
        return []
      }
    },
  }
}
export async function wsTurn(ws: WebSocket, input: Record<string, unknown>): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const events: any[] = []
    const closed = () => {
      clearTimeout(timer)
      ws.off('message', receive)
      reject(new Error('WS closed'))
    }
    ws.once('close', closed)
    const timer = setTimeout(() => {
      ws.off('message', receive)
      ws.off('close', closed)
      reject(new Error('WS turn timed out'))
    }, 30000)
    const receive = (data: WebSocket.RawData) => {
      const event = JSON.parse(data.toString())
      events.push(event)
      if (['response.completed', 'response.failed', 'error'].includes(event.type)) {
        clearTimeout(timer)
        ws.off('message', receive)
        ws.off('close', closed)
        resolve(events)
      }
    }
    ws.on('message', receive)
    ws.send(JSON.stringify({ type: 'response.create', ...input }))
  })
}
