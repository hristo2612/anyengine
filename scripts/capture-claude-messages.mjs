#!/usr/bin/env node
// Real Claude Code, generated fake configuration, loopback-only Messages API.
// Every official invocation is sandboxed; incomplete ownership refuses a fixture.
import assert from 'node:assert/strict'
import { fork, spawn } from 'node:child_process'
import { once } from 'node:events'
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
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  joinCaptureGroup as joinGroup,
  captureGroupMembers as members,
} from './capture-codex-auth.mjs'
import { parseClaudeMessagesArgs } from './lib/claude-capture-options.mjs'
import { requireSandbox, SANDBOX_EXEC } from './lib/codex-probe.mjs'

const file = fileURLToPath(import.meta.url)
const repo = resolve(dirname(file), '..')
const fakeKey = 'sk-ant-api03-anyengine-fake-messages-only'
const gpt = 'gpt-6.1-sol'
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const bound = 2_000_000

function cleanEnv(c, url) {
  return {
    HOME: c.home,
    CLAUDE_CONFIG_DIR: c.config,
    TMPDIR: c.temp,
    CLAUDE_CODE_TMPDIR: c.temp,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    USER: 'capture',
    LOGNAME: 'capture',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    ANTHROPIC_API_KEY: fakeKey,
    ANTHROPIC_BASE_URL: url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
  }
}

function sandboxPolicy(c, protectedHome) {
  const q = JSON.stringify
  const ancestors = []
  for (const leaf of [c.binary, c.probe])
    for (let path = dirname(leaf); path !== '/'; path = dirname(path)) ancestors.push(path)
  return [
    '(version 1)(allow default)(deny network*)',
    '(allow network* (remote ip "localhost:*"))',
    '(deny file-write*)',
    `(allow file-write* (subpath ${q(c.probe)}) (literal "/dev/null") (regex #"^/dev/ttys"))`,
    '(deny file-read*)',
    `(allow file-read* (subpath ${q(c.probe)}) (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin")`,
    ' (subpath "/Library") (subpath "/private/etc") (subpath "/dev") (literal "/"))',
    `(deny file-read* (subpath ${q(protectedHome)}) (subpath "/Library/Keychains"))`,
    // Only the resolved official executable is readable under the real home.
    `(allow file-read-metadata ${ancestors.map((path) => `(literal ${q(path)})`).join(' ')})`,
    '(allow file-read-metadata (literal "/etc") (literal "/var") (literal "/tmp") (literal "/Applications"))',
    `(allow file-read* (literal ${q(c.binary)}))`,
    '(deny mach-lookup (global-name "com.apple.securityd")',
    ' (global-name "com.apple.secd") (global-name "com.apple.SecurityServer"))',
  ].join('\n')
}

function projection(body, c, labels) {
  const mask = (text) => {
    let value = text.replaceAll(c.work, '<PROJECT>').replaceAll(c.probe, '<PROBE>')
    value = value.replace(
      /<system-reminder>[\s\S]*?<\/system-reminder>/g,
      (part) => `<system-reminder omitted; ${Buffer.byteLength(part)} bytes>`,
    )
    value = value.replace(/\b(?:toolu|msg|req)_[A-Za-z0-9_-]+\b/g, (id) => {
      if (!labels.has(id)) labels.set(id, `id_${labels.size + 1}`)
      return labels.get(id)
    })
    value = value.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<UUID>')
    return value
  }
  const metadata = (value) => ({
    type: Array.isArray(value) ? 'array' : typeof value,
    bytes: Buffer.byteLength(JSON.stringify(value ?? null)),
  })
  const schema = (value) => {
    if (Array.isArray(value)) return value.map(schema)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value).map(([key, part]) => [
        key,
        key === 'description' ? metadata(part) : schema(part),
      ]),
    )
  }
  const content = (value) => {
    if (typeof value === 'string') return value.includes('CAPTURE_') ? mask(value) : metadata(value)
    if (!Array.isArray(value)) return metadata(value)
    return value.map((block) => {
      if (block.type === 'tool_use')
        return {
          type: block.type,
          id: mask(block.id),
          name: block.name,
          input: JSON.parse(mask(JSON.stringify(block.input))),
        }
      if (block.type === 'tool_result')
        return {
          type: block.type,
          tool_use_id: mask(block.tool_use_id),
          is_error: block.is_error ?? false,
          content:
            typeof block.content === 'string'
              ? mask(block.content)
              : block.content.map((part) =>
                  part.type === 'text'
                    ? { type: 'text', text: mask(part.text) }
                    : { type: part.type, ...metadata(part) },
                ),
        }
      if (block.type === 'text')
        return {
          type: 'text',
          text: block.text.includes('CAPTURE_') ? mask(block.text) : metadata(block.text),
          ...(block.cache_control ? { cache_control: block.cache_control } : {}),
        }
      return { type: block.type, ...metadata(block) }
    })
  }
  return {
    keys: Object.keys(body).sort(),
    model: body.model,
    stream: body.stream ?? false,
    max_tokens: body.max_tokens,
    ...(body.thinking ? { thinking: body.thinking } : {}),
    system: metadata(body.system),
    tools: (body.tools ?? []).map((tool) => ({
      name: tool.name,
      description: metadata(tool.description),
      input_schema: schema(tool.input_schema),
    })),
    messages: (body.messages ?? []).map((message) => ({
      role: message.role,
      content: content(message.content),
    })),
    metadataKeys: Object.keys(body.metadata ?? {}).sort(),
  }
}

// Postprocessing keeps captured own tool data while omitting vendor prose.
// It is also usable on a retained, joined observation without another CLI run.
export function normalizeClaudeCapture(fixture) {
  const labels = new Map()
  const mask = (value) =>
    value
      .replace(/-private-var-folders-[^/\s"'<>]+-project/g, '<PROJECT_KEY>')
      .replace(/claude-\d+(?=\/)/g, 'claude-<UID>')
      .replace(/\ba[0-9a-f]{16}\b/g, (id) => {
        if (!labels.has(id)) labels.set(id, `agent_id_${labels.size + 1}`)
        return labels.get(id)
      })
      .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<PORT>')
  const text = (value) => {
    if (typeof value !== 'string') return visit(value)
    if (value.includes('CAPTURE_')) return mask(value)
    return { type: 'string', bytes: Buffer.byteLength(JSON.stringify(value)) }
  }
  const resultBlock = (block) => {
    if (block.type !== 'text' || typeof block.text !== 'string') return visit(block)
    const agentId = /^agentId: (a[0-9a-f]{16})\b/m.exec(block.text)?.[1]
    const outputFile = /^output_file: (.+)$/m.exec(block.text)?.[1]
    return {
      ...visit({ ...block, text: undefined }),
      text: text(block.text),
      ...(agentId
        ? {
            agentLaunch: {
              agentId: mask(agentId),
              ...(outputFile ? { outputFile: mask(outputFile) } : {}),
            },
          }
        : {}),
    }
  }
  const visit = (value) => {
    if (typeof value === 'string') return mask(value)
    if (Array.isArray(value)) return value.map(visit)
    if (!value || typeof value !== 'object') return value
    if (value.type === 'tool_result')
      return {
        ...Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== 'content')
            .map(([key, part]) => [key, visit(part)]),
        ),
        content: Array.isArray(value.content)
          ? value.content.map(resultBlock)
          : text(value.content),
      }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, part]) => part !== undefined)
        .map(([key, part]) => [key, visit(part)]),
    )
  }
  return visit(fixture)
}

function fakeResponse(res, body, blocks, stop) {
  const message = {
    id: 'msg_capture_response',
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: blocks,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(message))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
  emit('message_start', {
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { ...message.usage, output_tokens: 0 },
    },
  })
  blocks.forEach((block, index) => {
    const start = block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} }
    emit('content_block_start', { index, content_block: start })
    emit('content_block_delta', {
      index,
      delta:
        block.type === 'text'
          ? { type: 'text_delta', text: block.text }
          : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
    })
    emit('content_block_stop', { index })
  })
  emit('message_delta', {
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: 5 },
  })
  emit('message_stop', {})
  res.end()
}

async function fakeApi(c) {
  const requests = [],
    labels = new Map()
  let modelRequests = 0
  const server = http.createServer(async (req, res) => {
    try {
      let raw = Buffer.alloc(0)
      for await (const bytes of req) {
        raw = Buffer.concat([raw, bytes])
        if (raw.length > bound) throw new Error('capture body limit')
      }
      const path = new URL(req.url, 'http://fake.invalid').pathname
      const row = {
        method: req.method,
        path,
        headers: Object.fromEntries(
          Object.entries(req.headers)
            .filter(
              ([name]) =>
                !['authorization', 'x-api-key', 'host', 'content-length', 'user-agent'].includes(
                  name,
                ),
            )
            .map(([name, value]) => [
              name,
              /(?:request|session|trace)[-_]?id|traceparent/i.test(name) ? '<GENERATED_ID>' : value,
            ]),
        ),
        fakeApiKey: req.headers['x-api-key'] === fakeKey,
        authorizationPresent: req.headers.authorization != null,
      }
      requests.push(row)
      if (path.endsWith('/count_tokens')) {
        row.body = projection(JSON.parse(raw), c, labels)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"input_tokens":10}')
        return
      }
      if (path === '/api/hello') {
        res.writeHead(200)
        res.end('{}')
        return
      }
      if (path === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [{ id: gpt, type: 'model', display_name: 'GPT fixture' }],
            has_more: false,
          }),
        )
        return
      }
      if (!path.startsWith('/v1/messages')) {
        res.writeHead(404)
        res.end('{}')
        return
      }
      assert.equal(row.fakeApiKey, true)
      assert.equal(row.authorizationPresent, false)
      const body = JSON.parse(raw)
      row.body = projection(body, c, labels)
      const markers = JSON.stringify(body.messages) ?? ''
      row.captureMarkers = {
        main: markers.includes('CAPTURE_MAIN'),
        parent: markers.includes('CAPTURE_PARENT'),
        child: markers.includes('CAPTURE_CHILD'),
      }
      modelRequests++
      if (modelRequests > 20) throw new Error('capture request count bound')
      if (c.kind === 'quota') {
        row.fakeReply = 'fake-quota-429'
        row.responseStatus = 429
        row.responseHeaders = { 'retry-after': '1' }
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
        res.end(
          '{"type":"error","error":{"type":"rate_limit_error","message":"CAPTURE_FAKE_QUOTA"}}',
        )
        return
      }
      const encoded = JSON.stringify(body.messages) ?? ''
      const agent = body.tools?.find((tool) => ['Agent', 'Task'].includes(tool.name))
      const isGpt = body.model === gpt
      if (c.kind.startsWith('agent-') && !isGpt && agent && !encoded.includes('tool_result')) {
        row.fakeReply = 'generated-agent-tool'
        fakeResponse(
          res,
          body,
          [
            {
              type: 'tool_use',
              id: 'toolu_capture_agent',
              name: agent.name,
              input: {
                description: 'Read fake fixture',
                subagent_type: 'gpt-fixture-agent',
                prompt: 'CAPTURE_CHILD: Read README.md and reply CAPTURE_CHILD_PONG.',
              },
            },
          ],
          'tool_use',
        )
      } else if (
        body.tools?.some((tool) => tool.name === 'Read') &&
        !encoded.includes('tool_result') &&
        (isGpt || c.kind === 'read')
      ) {
        row.fakeReply = 'read-tool'
        fakeResponse(
          res,
          body,
          [
            {
              type: 'tool_use',
              id: 'toolu_capture_read',
              name: 'Read',
              input: { file_path: join(c.work, 'README.md') },
            },
          ],
          'tool_use',
        )
      } else {
        row.fakeReply = 'terminal-text'
        fakeResponse(res, body, [{ type: 'text', text: 'CAPTURE_PONG' }], 'end_turn')
      }
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        '{"type":"error","error":{"type":"invalid_request_error","message":"CAPTURE_FAKE_REFUSAL"}}',
      )
    }
  })
  server.requestTimeout = 10_000
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, requests, url: `http://127.0.0.1:${server.address().port}` }
}

function captureArgs(c, mode) {
  return c.kind === 'version'
    ? ['--version']
    : c.kind === 'help'
      ? ['--help']
      : [
          '--permission-mode',
          mode,
          '--model',
          c.kind.startsWith('agent-') ? 'sonnet' : gpt,
          ...(c.kind === 'picker' ? [] : ['--disable-slash-commands']),
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          ...(c.kind.startsWith('agent-')
            ? [
                '--agents',
                JSON.stringify({
                  'gpt-fixture-agent': {
                    description: 'Read the fake README fixture',
                    prompt: 'CAPTURE_AGENT: Read README.md and reply CAPTURE_CHILD_PONG.',
                    model: gpt,
                    tools: ['Read'],
                  },
                }),
              ]
            : []),
          ...(c.kind === 'picker'
            ? []
            : [
                '--print',
                '--output-format',
                'json',
                c.kind.startsWith('agent-')
                  ? 'CAPTURE_PARENT: Use gpt-fixture-agent to read README.md.'
                  : 'CAPTURE_MAIN: Read README.md, then reply CAPTURE_PONG.',
              ]),
        ]
}

async function worker(c) {
  const abort = new AbortController(),
    groups = new Map([[process.pid, new Map()]])
  let child,
    closed,
    api,
    sampler,
    sampling = false,
    observationError,
    output = '',
    stderr = '',
    screen
  const stop = () => abort.abort()
  process.once('disconnect', stop)
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const timer = setTimeout(stop, 30_000)
  const sample = async () => {
    if (sampling) return
    sampling = true
    try {
      for (const [group, cohort] of groups)
        for (const p of await members(group)) {
          if (cohort.has(p.pid) && cohort.get(p.pid) !== p.start)
            throw new Error('capture identity changed')
          cohort.set(p.pid, p.start)
        }
    } catch (error) {
      observationError ??= error
      stop()
    } finally {
      sampling = false
    }
  }
  const receipt = (status) =>
    writeFileSync(
      join(c.probe, 'cleanup.json'),
      JSON.stringify({
        status,
        groups: [...groups].map(([group, cohort]) => ({ group, cohort: [...cohort] })),
      }),
      { mode: 0o600 },
    )
  const joinGroups = async () => {
    for (const [group, cohort] of groups)
      await joinGroup(group, cohort, group === process.pid ? process.pid : 0)
  }
  let result
  const cleanup = async () => {
    clearInterval(sampler)
    while (sampling) await delay(10)
    try {
      await sample()
      if (observationError) throw observationError
      if (child) {
        if (c.kind === 'picker') child.kill('SIGKILL')
        else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await joinGroups()
        const actual = await Promise.race([
          closed,
          delay(3000).then(() => {
            throw new Error('capture child join failed')
          }),
        ])
        if (result && !['version', 'help', 'picker'].includes(c.kind)) {
          result.exitCode = actual.code
          result.exitSignal = actual.signal ?? null
        }
      }
      await sample()
      if (observationError) throw observationError
      await joinGroups()
      receipt('joined')
    } finally {
      clearTimeout(timer)
      screen?.dispose()
      api?.server.closeAllConnections()
      if (api) await new Promise((done) => api.server.close(done))
    }
  }
  try {
    await sample()
    receipt('pending')
    sampler = setInterval(sample, 100)
    api = await fakeApi(c)
    const env = cleanEnv(c, api.url)
    const mode = c.kind.startsWith('agent-') ? c.kind.slice(6) : 'default'
    const cfg = {
      hasCompletedOnboarding: true,
      lastOnboardingVersion: c.version ?? '0.0.0',
      theme: 'dark',
      customApiKeyResponses: { approved: [fakeKey.slice(-20)], rejected: [] },
      projects: { [c.work]: { hasTrustDialogAccepted: true } },
    }
    for (const path of [join(c.home, '.claude.json'), join(c.config, '.claude.json')])
      writeFileSync(path, JSON.stringify(cfg), { mode: 0o600 })
    writeFileSync(
      join(c.config, 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        permissions: { defaultMode: mode },
        skipDangerousModePermissionPrompt: true,
      }),
      { mode: 0o600 },
    )
    writeFileSync(join(c.work, 'README.md'), 'CAPTURE_FIXTURE: a small fake repository.\n', {
      mode: 0o600,
    })
    const args = captureArgs(c, mode)
    if (abort.signal.aborted) throw new Error('capture abandoned before official launch')
    if (c.kind === 'picker') {
      const pty = createRequire(import.meta.url)('node-pty')
      const { PtyScreen } = await import('../dist/src/anyengine-screen.mjs')
      screen = new PtyScreen(120, 40)
      child = pty.spawn(SANDBOX_EXEC, ['-p', c.policy, c.binary, ...args], {
        cwd: c.work,
        env,
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
      })
      groups.set(child.pid, new Map())
      child.onData((data) => screen.write(data))
      closed = new Promise((done) => child.onExit(done))
      const until = async (pattern) => {
        const deadline = Date.now() + 12_000
        while (!abort.signal.aborted && Date.now() < deadline) {
          if ((await screen.viewport()).some((line) => pattern.test(line))) return true
          await delay(100)
        }
        return false
      }
      const ready = await until(/❯|for shortcuts/)
      let picker = false
      if (ready) {
        child.write('/model\r')
        picker = await until(/Select model|Choose.*model|Default.*recommended|Custom model/)
      }
      result = {
        ready,
        pickerObserved: picker,
        gptLabelObserved: (await screen.viewport()).some((line) => line.includes(gpt)),
      }
    } else {
      child = spawn(SANDBOX_EXEC, ['-p', c.policy, c.binary, ...args], {
        cwd: c.work,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.on('error', stop)
      closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })))
      child.stderr.on('data', (bytes) => {
        stderr += bytes.toString('utf8')
        if (stderr.length > bound) stop()
      })
      child.stdout.on('data', (bytes) => {
        output += bytes.toString('utf8')
        if (output.length > bound) stop()
      })
      const ended = await Promise.race([
        closed,
        once(abort.signal, 'abort').then(() => ({ code: null, deadline: true })),
      ])
      if (c.kind === 'version') {
        const version = /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/m.exec(output)?.[1]
        assert.equal(ended.code, 0)
        assert.ok(version)
        result = { version }
      } else if (c.kind === 'help') {
        assert.equal(ended.code, 0)
        result = {
          flags: Object.fromEntries(
            [
              '--agents',
              '--permission-mode',
              '--model',
              '--print',
              '--max-turns',
              '--strict-mcp-config',
            ].map((flag) => [flag, output.includes(flag)]),
          ),
        }
      } else
        result = {
          exitCode: ended.code,
          deadline: ended.deadline === true,
          terminalPong: output.includes('CAPTURE_PONG'),
          permissionDenied:
            /permission_denials/.test(output) && !/"permission_denials"\s*:\s*\[\s*\]/.test(output),
          diagnostic: {
            unknownOption: /unknown option|unrecognized option/i.test(stderr),
            accessDenied: /EPERM|EACCES|operation not permitted|permission denied/i.test(stderr),
            modelRejected: /invalid model|model.+not available|unsupported model/i.test(stderr),
            stderrBytes: Buffer.byteLength(stderr),
            startupSummary: stderr
              .replaceAll(fakeKey, '<FAKE_KEY>')
              .replaceAll(c.binary, '<CLAUDE_BINARY>')
              .replaceAll(c.probe, '<PROBE>')
              .replace(/\/Users\/[^\s'"]+/g, '<REAL_HOME_PATH>')
              .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<PORT>')
              .replace(/\x1b\[[0-9;]*m/g, '')
              .trim()
              .slice(0, 512),
          },
        }
    }
    result.requests = api.requests
  } finally {
    await cleanup()
  }
  writeFileSync(join(c.probe, 'observation.json'), JSON.stringify(result), { mode: 0o600 })
  return result
}

async function supervised(c) {
  const child = fork(file, ['--worker'], {
    cwd: c.work,
    env: { ...cleanEnv(c, 'http://127.0.0.1:1'), CAPTURE_MESSAGES_CONFIG: JSON.stringify(c) },
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  child.stderr.resume()
  let answer
  child.on('message', (value) => {
    answer = value
  })
  const closed = once(child, 'close')
  const admitted = (await members(child.pid)).find((p) => p.pid === child.pid)
  let hardTimer
  const abort = () => {
    if (child.connected) child.disconnect()
  }
  process.once('SIGTERM', abort)
  process.once('SIGINT', abort)
  const timer = setTimeout(() => {
    abort()
    hardTimer = setTimeout(async () => {
      try {
        const current = (await members(child.pid)).find((p) => p.pid === child.pid)
        if (current && current.start === admitted?.start) process.kill(-child.pid, 'SIGKILL')
      } catch {} // Unknown family identity retains evidence and refuses publication.
    }, 4000)
  }, 45_000)
  try {
    const [code, signal] = await closed
    if (code !== 0 || signal || !answer?.ok)
      throw new Error(
        `sandboxed Messages ${c.kind} capture failed (${answer?.failure ?? 'worker-exit'}; exit=${code}; signal=${signal ?? 'none'})`,
      )
    if ((await members(child.pid)).some((p) => !p.zombie))
      throw new Error('capture family not joined')
    const receipt = JSON.parse(readFileSync(join(c.probe, 'cleanup.json'), 'utf8'))
    assert.equal(receipt.status, 'joined')
    for (const group of receipt.groups)
      if ((await members(group.group)).some((p) => !p.zombie))
        throw new Error('capture PTY family not joined')
    return answer.value
  } finally {
    clearTimeout(timer)
    clearTimeout(hardTimer)
    process.removeListener('SIGTERM', abort)
    process.removeListener('SIGINT', abort)
  }
}

export async function captureClaudeMessages(args = process.argv.slice(2)) {
  const options = parseClaudeMessagesArgs(args)
  requireSandbox('capture-claude-messages')
  const binary = realpathSync(options.binary),
    protectedHome = realpathSync(homedir())
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-messages-capture-')))
  const identity = lstatSync(root)
  let joined = false
  try {
    const run = async (kind, version) => {
      const probe = join(root, kind),
        home = join(probe, 'home'),
        work = join(probe, 'project')
      const config = join(home, '.claude'),
        temp = join(probe, 'tmp')
      for (const path of [home, work, config, temp])
        mkdirSync(path, { recursive: true, mode: 0o700 })
      const c = { kind, version, probe, home, work, config, temp, binary }
      const value = await supervised({ ...c, policy: sandboxPolicy(c, protectedHome) })
      writeFileSync(join(probe, 'observation.json'), JSON.stringify(value), { mode: 0o600 })
      return value
    }
    const { version } = await run('version')
    const help = await run('help', version)
    const scenarios = {}
    for (const kind of [
      'read',
      'agent-default',
      'agent-plan',
      'agent-dontAsk',
      'quota',
      'picker',
    ]) {
      scenarios[kind] = await run(kind, version)
      console.log(`captured ${kind}; owned processes joined`)
    }
    const requests = Object.values(scenarios).flatMap((scenario) => scenario.requests)
    const observed = {
      primaryGpt: scenarios.read.requests.some(
        (r) => r.body?.model === gpt && r.captureMarkers?.main,
      ),
      readRoundTrip: scenarios.read.requests.some(
        (r) =>
          r.body?.model === gpt &&
          r.body.messages.some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some(
                (block) =>
                  block.type === 'tool_result' &&
                  JSON.stringify(block.content).includes('CAPTURE_FIXTURE'),
              ),
          ),
      ),
      generatedGptAgent: Object.entries(scenarios).some(
        ([kind, s]) =>
          kind.startsWith('agent-') &&
          s.requests.some((r) => r.body?.model === gpt && r.captureMarkers?.child),
      ),
      headHello: requests.some((r) => r.method === 'HEAD' && r.path === '/api/hello'),
      streaming: requests.some((r) => r.body?.stream === true),
      nonStreaming: requests.some(
        (r) => r.path.startsWith('/v1/messages') && r.body?.stream === false,
      ),
      countTokens: requests.some((r) => r.path.endsWith('/count_tokens')),
      picker: scenarios.picker.pickerObserved,
    }
    const opens = Object.entries(observed)
      .filter(([, value]) => !value)
      .map(([contract]) => ({
        contract,
        status: 'not-observed',
        reason:
          'The bounded real CLI scenarios did not exercise this contract; no shape was synthesized.',
      }))
    opens.push({
      contract: 'childPermissionEnforcement',
      status: 'not-proven',
      reason:
        'Read-only fake child tools capture inherited behavior, but do not prove write or command enforcement.',
    })
    opens.push({
      contract: 'titleQuotaAuxiliaryShapes',
      status: 'not-classified',
      reason:
        'The quota scenario supplies a fake 429. No title-generation or quota-helper shape is inferred from primary model traffic.',
    })
    assert.ok(observed.primaryGpt, 'primary GPT Messages request was not observed')
    assert.ok(observed.readRoundTrip, 'GPT Read tool-result round trip was not observed')
    assert.ok(observed.generatedGptAgent, 'generated GPT child Messages request was not observed')
    const fixture = normalizeClaudeCapture({
      claudeVersion: version,
      isolation: {
        fakeCredentials: true,
        loopbackOnly: true,
        realHomeReadWriteDenied: true,
        keychainFilesAndMachDenied: true,
        cleanup: 'all owned groups joined',
      },
      help,
      observed,
      opens,
      scenarios,
    })
    writeFileSync(
      options.out ?? join(repo, 'test/fixtures', `claude-messages-${version}.json`),
      `${JSON.stringify(fixture, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    )
    joined = true
    console.log(
      `CAPTURE Claude ${version}: ${opens.length} explicit Open contracts; no live model calls`,
    )
    return fixture
  } finally {
    const current = lstatSync(root)
    if (joined && current.dev === identity.dev && current.ino === identity.ino)
      rmSync(root, { recursive: true, force: true })
    else console.error('capture retained private fake-home evidence after failure')
  }
}

const direct = process.argv[1] && resolve(process.argv[1]) === file
if (direct && process.argv[2] === '--worker') {
  try {
    const value = await worker(JSON.parse(process.env.CAPTURE_MESSAGES_CONFIG))
    await new Promise((done, fail) =>
      process.send({ ok: true, value }, (error) => (error ? fail(error) : done())),
    )
    process.disconnect()
  } catch (error) {
    process.send?.({ ok: false, failure: error.code ?? error.name })
    process.exitCode = 1
    if (process.connected) process.disconnect()
  }
} else if (direct) {
  try {
    await captureClaudeMessages()
  } catch (error) {
    console.error(`FAIL fake Claude Messages capture: ${error.message}`)
    process.exitCode = 1
  }
}
