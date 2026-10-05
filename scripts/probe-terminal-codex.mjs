#!/usr/bin/env node
// Zero-spend catalog/cache differential. Private bootstrap is never native proof.
import { spawn } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'
import { isolatedCommand, probeCodex, sandboxed } from './lib/codex-probe.mjs'
import { writeFakeChatgptAuth } from './lib/fake-chatgpt-auth.mjs'
import { probeProcesses } from './lib/probe-processes.mjs'

const GPT = 'gpt-6.1-sol'
const CLAUDE = ['opus', 'sonnet', 'haiku']
const hasClaude = (ids) => ids.some((id) => CLAUDE.includes(id))
function json(bytes) {
  if (bytes.length > 2_000_000) throw new Error('terminal probe input exceeds bound')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}
function regular(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size > 2_000_000)
    throw new Error('terminal probe input must be a bounded regular file')
  const bytes = readFileSync(path)
  if (bytes.length > 2_000_000) throw new Error('terminal probe input exceeds bound')
  return bytes
}
export function verifyExec(result, models, expected) {
  if (
    result.status !== 0 ||
    result.completed !== true ||
    models.length !== 1 ||
    models[0] !== result.model ||
    (expected ? result.model !== expected : !result.model?.startsWith('gpt-'))
  )
    throw new Error('terminal execution/status/wire model mismatch')
  return result.model
}
export function versionPair(selected, old) {
  const version = (result) => {
    const match = /^codex-cli\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?)\s*$/m.exec(result.stdout ?? '')
    if (result.status !== 0 || !match)
      throw new Error('terminal probe isolated Codex version unavailable')
    return match[1]
  }
  const versions = { selected: version(selected), old: old ? version(old) : null }
  if (versions.old === versions.selected)
    throw new Error('terminal probe old Codex reports the selected version; P2d refused')
  return versions
}
export async function differential(driver, options) {
  const lines = []
  const line = async (name, work) => {
    try {
      lines.push({ name, status: 'ok', detail: await work() })
    } catch (error) {
      lines.push({ name, status: 'FAIL', detail: error.message })
    }
  }
  await line('write', async () => {
    const ids = await driver.list('write')
    if (!CLAUDE.every((model) => ids.includes(model)))
      throw new Error('router-written catalog lacks Claude entries')
    const cache = json(driver.cache)
    if (!CLAUDE.every((model) => (cache.models ?? []).some((m) => m.slug === model)))
      throw new Error('router-written cache lacks Claude entries')
    return {
      versions: driver.versions,
      client_version: cache.client_version,
      identity: driver.identity(cache),
    }
  })
  const selected = options.cache ?? driver.cache
  const exercised = selected ? hasClaude((json(selected).models ?? []).map((m) => m.slug)) : false
  await line('P2c', async () => {
    for (const label of ['default', 'B'])
      if (hasClaude(await driver.list(label, selected)))
        throw new Error('terminal catalog exposes cached Claude')
    if (!driver.modelsFetched())
      throw new Error('alternate backend did not receive a models request')
    return 'default and alternate URL ignore the router cache'
  })
  if (options.oldCodex)
    await line('P2d', async () => {
      if (hasClaude(await driver.list('old', selected)))
        throw new Error('old terminal catalog exposes cached Claude')
      return 'other client version ignores the router cache'
    })
  else lines.push({ name: 'P2d', status: 'skipped', detail: 'no --old-codex supplied' })
  await line('P3a', async () => {
    for (const label of ['P3a-router', 'P3a-B']) {
      const result = await driver.exec(label, selected)
      verifyExec(result, result.models, GPT)
    }
    return `explicit model preserved: ${GPT}`
  })
  await line('P4a', async () => {
    const cached = await driver.exec('P4a-cache', selected)
    const clean = await driver.exec('P4a-clean', null)
    const first = verifyExec(cached, cached.models)
    const second = verifyExec(clean, clean.models)
    if (first !== second) throw new Error('terminal default changes with copied cache')
    return `same GPT default with/without cache: ${first}`
  })
  await line('M7', async () => {
    const result = await driver.exec('M7', driver.cache)
    return verifyExec(result, result.models, GPT)
  })
  if (!exercised)
    for (const name of ['P2c', 'P2d', 'P4a']) {
      const row = lines.find((r) => r.name === name)
      if (row.status === 'ok') {
        row.status = 'not exercised'
        row.detail = 'the copied cache has no AnyEngine entry'
      }
    }
  return {
    exitCode: lines.some((r) => r.status === 'FAIL')
      ? 1
      : lines.some((r) => r.status !== 'ok')
        ? 2
        : 0,
    lines,
  }
}

const entry = () => ({
  slug: GPT,
  display_name: GPT,
  description: 'Loopback GPT fixture',
  default_reasoning_level: 'low',
  supported_reasoning_levels: [{ effort: 'low', description: 'low' }],
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  priority: 1,
  availability_nux: null,
  upgrade: null,
  base_instructions: '',
  supports_reasoning_summaries: true,
  support_verbosity: false,
  default_verbosity: null,
  apply_patch_tool_type: 'freeform',
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_parallel_tool_calls: true,
  experimental_supported_tools: [],
  context_window: 272000,
  multi_agent_version: 'v2',
  tool_mode: 'code_mode_only',
  use_responses_lite: true,
})
export async function terminalBackend(discovery = false) {
  const requests = []
  let sequence = 0
  const server = http.createServer((req, res) => {
    const chunks = []
    let size = 0
    req.on('data', (bytes) => {
      size += bytes.length
      if (size > 2_000_000) req.destroy()
      else chunks.push(bytes)
    })
    req.on('end', () => {
      try {
        const path = new URL(req.url, 'http://fixture.invalid').pathname
        if (requests.length >= 256) throw new Error('terminal fixture request bound')
        requests.push({ method: req.method, path })
        if (discovery && path === '/backend-api/wham/accounts/check') {
          const id = 'acct-anyengine-probe'
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              accounts: [
                {
                  id,
                  plan_type: 'pro',
                  workspace_backend_origin: 'https://workspace.invalid',
                  account_routing_override: 'NO_CONSTRAINT',
                  name: null,
                  profile_picture_url: null,
                  structure: 'personal',
                },
              ],
              account_ordering: [id],
              default_account_id: id,
            }),
          )
        } else if (!discovery && path === '/backend-api/codex/models') {
          res.writeHead(200, { 'content-type': 'application/json', etag: '"terminal-gpt-fixture"' })
          res.end(JSON.stringify({ models: [entry()] }))
        } else if (!discovery && req.method === 'POST' && path === '/backend-api/codex/responses') {
          let raw = Buffer.concat(chunks)
          if (req.headers['content-encoding'] === 'zstd')
            raw = zstdDecompressSync(raw, { maxOutputLength: 2_000_000 })
          const body = json(raw)
          requests.at(-1).model = body.model
          const responseId = `resp_terminal_${++sequence}`
          const item = {
            id: `msg_terminal_${sequence}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'PONG', annotations: [] }],
          }
          const response = {
            id: responseId,
            object: 'response',
            status: 'completed',
            model: body.model,
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          let seq = 0
          for (const [type, value] of [
            ['response.created', { response: { ...response, status: 'in_progress', output: [] } }],
            ['response.output_item.done', { output_index: 0, item }],
            ['response.completed', { response }],
          ])
            res.write(
              `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...value })}\n\n`,
            )
          res.end()
        } else {
          res.writeHead(404)
          res.end()
        }
      } catch {
        res.writeHead(400)
        res.end()
      }
    })
  })
  server.on('upgrade', (_req, socket) =>
    socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n'),
  )
  await new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', done)
  })
  return {
    url: `http://127.0.0.1:${server.address().port}/backend-api/${discovery ? '' : 'codex'}`,
    requests,
    close: async () => {
      const closed = new Promise((done) => server.close(done))
      server.closeAllConnections()
      await closed
    },
  }
}

export async function execProbe(
  command,
  args,
  env,
  joinGroup,
  timeoutMs = 30_000,
  lifetime,
  signal,
) {
  lifetime?.pending()
  const child = spawn(command, args, {
    env,
    cwd: env.HOME,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = new Promise((done) => child.once('close', (status) => done(status)))
  const chunks = []
  let size = 0,
    failure
  const collect = (bytes) => {
    size += bytes.length
    if (size > 2_000_000) {
      failure = new Error('terminal exec output bound')
      child.kill('SIGTERM')
    } else chunks.push(bytes)
  }
  child.stdout.on('data', collect)
  child.stderr.resume()
  child.once('error', (error) => {
    failure = error
  })
  const timeout = setTimeout(() => {
    failure = new Error('terminal exec deadline')
    child.kill('SIGTERM')
  }, timeoutMs)
  const kill = setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') failure = error
    }
  }, timeoutMs + 2000)
  const abort = () => {
    failure = new Error('terminal exec interrupted')
    child.kill('SIGTERM')
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    if (signal?.aborted) abort()
    if (child.pid) lifetime?.add(child.pid)
    const status = await closed
    if (failure) throw failure
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    const rows = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    return {
      status,
      completed:
        rows.filter((r) => r.type === 'turn.completed').length === 1 &&
        !rows.some((r) => ['turn.failed', 'error'].includes(r.type)),
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    try {
      child.kill('SIGTERM')
      await joinGroup(child.pid, true)
    } finally {
      await closed
      clearTimeout(timeout)
      clearTimeout(kill)
    }
  }
}

export async function runTerminalProbe(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      lib: { type: 'string' },
      codex: { type: 'string' },
      'old-codex': { type: 'string' },
      'config-from': { type: 'string' },
      'cache-from': { type: 'string' },
    },
  })
  if (!values.lib)
    throw new Error(
      'usage: probe-terminal-codex.mjs --lib LIB [--codex PATH] [--old-codex PATH] [--config-from FILE] [--cache-from FILE]',
    )
  const lib = realpathSync(resolve(values.lib))
  const load = (name) => import(pathToFileURL(join(lib, 'dist/src', `${name}.mjs`)).href)
  const [clientApi, routerApi, hooksApi, proofApi, configApi, logApi, processApi, systemApi] =
    await Promise.all(
      [
        'smoke-client',
        'router-server',
        'router-hooks',
        'degraded',
        'anyengine-config',
        'router-log',
        'smoke-probes',
        'control-system',
      ].map(load),
    )
  const codex = await probeCodex(lib, values.codex)
  if (!codex) throw new Error('terminal probe selected Codex unavailable')
  const versions = versionPair(
    isolatedCommand(codex, ['--version']),
    values['old-codex'] ? isolatedCommand(values['old-codex'], ['--version']) : null,
  )
  const configBytes = values['config-from'] ? regular(values['config-from']) : null
  const copiedCache = values['cache-from'] ? regular(values['cache-from']) : null
  if (copiedCache) json(copiedCache)
  const probe = realpathSync(mkdtempSync(join(tmpdir(), 'term-')))
  const stamp = lstatSync(probe)
  const root = join(probe, 'root'),
    home = join(probe, 'codex'),
    fakeHome = join(probe, 'home'),
    temp = join(probe, 'tmp')
  for (const directory of [root, home, fakeHome, temp]) mkdirSync(directory, { mode: 0o700 })
  const env = {
    HOME: fakeHome,
    CODEX_HOME: home,
    TMPDIR: temp,
    CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'),
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    RUST_LOG: 'warn',
  }
  mkdirSync(env.CLAUDE_CONFIG_DIR)
  writeFakeChatgptAuth(home)
  const processes = probeProcesses(processApi, systemApi.realSystem(), probe)
  const controller = new AbortController()
  let a,
    b,
    discovery,
    router,
    current,
    joined = false,
    result
  const stop = () => {
    controller.abort()
    void current?.close().catch(() => {})
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop)
  try {
    a = await terminalBackend()
    b = await terminalBackend()
    discovery = await terminalBackend(true)
    const config = structuredClone(configApi.DEFAULT_CONFIG)
    config.router.upstream = a.url
    config.router.multiAgentV1 = true
    configApi.writeJsonAtomic(join(root, 'config.json'), config)
    // Explicit fake-only bootstrap, confined to this unique root and fake login.
    proofApi.markProven(
      root,
      'native-fanout',
      'non-authoritative zero-spend differential bootstrap',
      proofApi.proofKey(root),
    )
    const log = logApi.createRouterLog(join(root, 'router.jsonl'))
    router = await routerApi.startRouter({
      root,
      port: 0,
      log,
      hooks: hooksApi.buildRouterRuntime(root, log).hooks,
    })
    const cacheFile = join(home, 'models_cache.json')
    const clean = () => {
      for (const name of ['models_cache.json', 'config.toml'])
        rmSync(join(home, name), { force: true })
    }
    const globals = (base) => [
      '-c',
      'mcp_servers={}',
      '-c',
      'notify=[]',
      '-c',
      'cli_auth_credentials_store="file"',
      '-c',
      `chatgpt_base_url=${JSON.stringify(discovery.url)}`,
      ...(base ? ['-c', `openai_base_url=${JSON.stringify(base)}`] : []),
    ]
    const driver = {
      cache: null,
      versions,
      identity: (cache) =>
        logApi.scrubForLog(
          Object.fromEntries(
            Object.entries(cache).filter(([key]) => /identity|url|version/.test(key)),
          ),
        ),
      async list(label, cache) {
        clean()
        if (cache) writeFileSync(cacheFile, cache, { mode: 0o600 })
        const binary = label === 'old' ? values['old-codex'] : codex
        const base = label === 'write' ? router.baseUrl : label === 'B' ? b.url : null
        const [command, argv] = sandboxed(binary)([...globals(base), 'app-server'])
        if (controller.signal.aborted) throw new Error('terminal probe interrupted')
        processes.pending()
        current = clientApi.AppServerClient.launch(command, argv, env)
        try {
          processes.add(current.pid)
          await current.initialize()
          const models = await current.request('model/list', { includeHidden: true, limit: 100 })
          if (label === 'write') driver.cache = regular(cacheFile)
          return (models.data ?? []).map((model) => model.model ?? model.id)
        } finally {
          await current.close()
          current = null
        }
      },
      modelsFetched: () => b.requests.some((r) => r.path.endsWith('/models')),
      async exec(label, cache) {
        clean()
        if (cache) writeFileSync(cacheFile, cache, { mode: 0o600 })
        if (label.startsWith('P4a') && configBytes)
          writeFileSync(join(home, 'config.toml'), configBytes, { mode: 0o600 })
        const backend = label.endsWith('router') || label === 'M7' ? a : b
        const base = backend === a ? router.baseUrl : b.url
        const before = backend.requests.length
        const [command, argv] = sandboxed(codex)([
          ...globals(base),
          'exec',
          '--json',
          '--skip-git-repo-check',
          ...(label.startsWith('P3a') ? ['-m', GPT] : []),
          'Reply PONG',
        ])
        const done = await execProbe(
          command,
          argv,
          env,
          clientApi.joinDetachedGroup,
          30_000,
          processes,
          controller.signal,
        )
        const models = backend.requests
          .slice(before)
          .filter((r) => r.model && r.method === 'POST')
          .map((r) => r.model)
        return { ...done, model: models[0], models }
      },
    }
    result = await differential(driver, { cache: copiedCache, oldCodex: values['old-codex'] })
  } finally {
    processes.sample()
    const outcomes = await Promise.allSettled([
      current?.close(),
      router?.close(),
      a?.close(),
      b?.close(),
      discovery?.close(),
    ])
    try {
      await processes.close()
    } catch (error) {
      outcomes.push({ status: 'rejected', reason: error })
    }
    joined = outcomes.every((r) => r.status === 'fulfilled')
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop)
    const now = lstatSync(probe)
    joined &&= now.isDirectory() && now.dev === stamp.dev && now.ino === stamp.ino
    if (joined) rmSync(probe, { recursive: true })
    else console.error(`terminal cleanup unknown; retained ${probe}`)
  }
  if (!joined) throw new Error(`terminal cleanup unknown; retained ${probe}`)
  return result
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  runTerminalProbe()
    .then((result) => {
      for (const row of result.lines)
        console.log(`${row.name}: ${row.status} ${JSON.stringify(row.detail)}`)
      process.exitCode = result.exitCode
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
