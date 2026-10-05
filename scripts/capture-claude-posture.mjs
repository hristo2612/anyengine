#!/usr/bin/env node
// Zero-spend real CLI posture/menu observations. Only generated homes and markers.
import assert from 'node:assert/strict'
import { fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderGptAgent } from '../dist/src/claude-agents.mjs'
import { buildClaudeSettings } from '../dist/src/claude-settings.mjs'
import {
  joinCaptureGroup as joinGroup,
  captureGroupMembers as members,
} from './capture-codex-auth.mjs'
import { requireSandbox, SANDBOX_EXEC } from './lib/codex-probe.mjs'

const file = fileURLToPath(import.meta.url),
  repo = resolve(dirname(file), '..')
const fakeKey = 'sk-ant-api03-anyengine-fake-posture-only',
  limit = 2_000_000
const model = {
  id: 'gpt-6.1-sol',
  label: 'GPT Posture Fixture',
  contextWindow: 100_000,
  lite: false,
  efforts: ['medium'],
}
const ids = {
  read: 'toolu_posture_read',
  outsideRead: 'toolu_posture_outside_read',
  write: 'toolu_posture_write',
  command: 'toolu_posture_command',
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
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
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
  }
}
function policy(c, protectedHome) {
  const q = JSON.stringify,
    ancestors = new Set(['/etc', '/var', '/tmp', '/Applications'])
  for (const leaf of [c.binary, c.probe])
    for (let path = dirname(leaf); ; path = dirname(path)) {
      ancestors.add(path)
      if (dirname(path) === path) break
    }
  return [
    '(version 1)(allow default)(deny network*)',
    '(allow network* (remote ip "localhost:*"))',
    '(deny file-write*)',
    `(allow file-write* (subpath ${q(c.probe)}) (literal "/dev/null") (regex #"^/dev/ttys"))`,
    '(deny file-read*)',
    `(allow file-read* (subpath ${q(c.probe)}) (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library") (subpath "/private/etc") (subpath "/dev") (literal "/"))`,
    `(deny file-read* (subpath ${q(protectedHome)}) (subpath "/Library/Keychains"))`,
    `(allow file-read-metadata ${[...ancestors].map((path) => `(literal ${q(path)})`).join(' ')})`,
    `(allow file-read* (literal ${q(c.binary)}))`,
    '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.secd") (global-name "com.apple.SecurityServer"))',
  ].join('\n')
}
function respond(res, body, content) {
  const stop = content.some((part) => part.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const message = {
    id: 'msg_posture_response',
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
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
  content.forEach((part, index) => {
    emit('content_block_start', {
      index,
      content_block: part.type === 'text' ? { type: 'text', text: '' } : { ...part, input: {} },
    })
    emit('content_block_delta', {
      index,
      delta:
        part.type === 'text'
          ? { type: 'text_delta', text: part.text }
          : { type: 'input_json_delta', partial_json: JSON.stringify(part.input) },
    })
    emit('content_block_stop', { index })
  })
  emit('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: message.usage })
  emit('message_stop', {})
  res.end()
}
function observeChild(body, observations) {
  observations.childModelObserved = true
  for (const [kind, name] of [
    ['outsideRead', 'Read'],
    ['write', 'Write'],
    ['command', 'Bash'],
  ])
    observations.advertised[kind] ||= (body.tools ?? []).some((tool) => tool.name === name)
  for (const message of body.messages ?? [])
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type !== 'tool_result' || !Object.values(ids).includes(block.tool_use_id)) continue
      observations.results[block.tool_use_id] = {
        error: block.is_error === true,
        marker: (JSON.stringify(block.content) ?? '').includes('POSTURE_READ_OK'),
      }
    }
}
async function backend(c) {
  const observations = { childModelObserved: false, results: {}, advertised: {}, requests: 0 }
  let parentIssued = false
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname
      if (path === '/api/hello') {
        res.writeHead(200)
        res.end('{}')
        return
      }
      if (path === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [{ id: model.id, type: 'model', display_name: model.label }],
            has_more: false,
          }),
        )
        return
      }
      let raw = '',
        bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > limit) throw new Error()
        raw += chunk.toString('utf8')
      }
      if (path.endsWith('/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"input_tokens":10}')
        return
      }
      if (
        !path.startsWith('/v1/messages') ||
        req.headers['x-api-key'] !== fakeKey ||
        req.headers.authorization
      )
        throw new Error()
      const body = JSON.parse(raw)
      if (++observations.requests > 16) throw new Error()
      const tools = body.tools ?? [],
        isChild = body.model === model.id
      if (isChild) observeChild(body, observations)
      const call = (id, name, input) => ({ type: 'tool_use', id, name, input })
      const agent = tools.find((tool) => ['Agent', 'Task'].includes(tool.name))
      if (c.kind !== 'picker' && !isChild && agent && !parentIssued) {
        parentIssued = true
        respond(res, body, [
          call('toolu_posture_agent', agent.name, {
            description: 'Check fake fixture boundaries',
            subagent_type: model.id,
            prompt: 'Read README.md, then follow the fake endpoint checks and reply POSTURE_PONG.',
          }),
        ])
      } else if (isChild && !observations.results[ids.read]) {
        respond(res, body, [call(ids.read, 'Read', { file_path: join(c.work, 'README.md') })])
      } else if (isChild && !observations.results[ids.write]) {
        respond(res, body, [
          call(ids.outsideRead, 'Read', { file_path: c.secret }),
          call(ids.write, 'Write', { file_path: c.writeMarker, content: 'POSTURE_WRITE_EFFECT\n' }),
          call(ids.command, 'Bash', {
            command: `printf POSTURE_COMMAND_EFFECT > ${quote(c.commandMarker)}`,
            description: 'Write an isolated outside-project marker',
          }),
        ])
      } else respond(res, body, [{ type: 'text', text: 'POSTURE_PONG' }])
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        '{"type":"error","error":{"type":"invalid_request_error","message":"Fake posture refusal"}}',
      )
    }
  })
  server.requestTimeout = 10_000
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, observations, url: `http://127.0.0.1:${server.address().port}` }
}
function prepare(c, url) {
  const onboarding = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: c.version ?? '2.1.289',
    theme: 'dark',
    customApiKeyResponses: { approved: [fakeKey.slice(-20)], rejected: [] },
    projects: { [c.work]: { hasTrustDialogAccepted: true } },
  }
  for (const path of [join(c.home, '.claude.json'), join(c.config, '.claude.json')])
    writeFileSync(path, JSON.stringify(onboarding), { mode: 0o600 })
  const hook = join(c.probe, 'observer.js')
  writeFileSync(
    hook,
    `ObjC.import('Foundation');function run(argv){const data=$.NSData.dataWithContentsOfFile(argv[0]);if(data.length>131072)throw Error('observer bound');const raw=ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding));const x=JSON.parse(raw);const modes=['default','plan','dontAsk','acceptEdits','auto','bypassPermissions','manual'];const row={event:x.hook_event_name,mode:modes.indexOf(x.permission_mode)>=0?x.permission_mode:null,child:typeof x.agent_id==='string',agentTypeMatches:x.agent_type===${JSON.stringify(model.id)},tool:['Agent','Task','Read','Write','Bash'].indexOf(x.tool_name)>=0?x.tool_name:null,id:typeof x.tool_use_id==='string'&&x.tool_use_id.indexOf('toolu_posture_')===0?x.tool_use_id:null};const text=$.NSString.alloc.initWithUTF8String(JSON.stringify(row)+String.fromCharCode(10));if(!text.writeToFileAtomicallyEncodingError(argv[0]+'.receipt.json',true,$.NSUTF8StringEncoding,null))throw Error('observer write');return '{}';}`,
    { mode: 0o600 },
  )
  const command = `input=$(/usr/bin/mktemp ${quote(join(c.probe, 'hook-input-XXXXXX'))}); /bin/cat > "$input"; /usr/bin/osascript -l JavaScript ${quote(hook)} "$input"; status=$?; /bin/rm -f "$input"; exit "$status"`
  const settings = buildClaudeSettings(
    {
      permissions: {
        defaultMode: c.kind === 'picker' ? 'default' : c.kind,
        deny: [`Read(${join(c.probe, 'outside')}/**)`],
      },
      hooks: Object.fromEntries(
        ['PreToolUse', 'PermissionDenied', 'SubagentStart'].map((event) => [
          event,
          [{ hooks: [{ type: 'command', command }] }],
        ]),
      ),
    },
    { baseUrl: url, haiku: 'claude-haiku-4-5-20251001', models: [model] },
  )
  writeFileSync(join(c.config, 'settings.json'), JSON.stringify(settings), { mode: 0o600 })
  mkdirSync(join(c.config, 'agents'), { recursive: true, mode: 0o700 })
  writeFileSync(join(c.config, 'agents', `${model.id}.md`), renderGptAgent(model), { mode: 0o600 })
  writeFileSync(join(c.work, 'README.md'), 'POSTURE_READ_OK\n', { mode: 0o600 })
  writeFileSync(c.secret, 'POSTURE_OUTSIDE_READ_FIXTURE\n', { mode: 0o600 })
}
function summary(c, observations, output) {
  const hooks = readdirSync(c.probe)
    .filter((name) => name.startsWith('hook-input-') && name.endsWith('.receipt.json'))
    .map((name) => JSON.parse(readFileSync(join(c.probe, name), 'utf8')))
  const denied = new Set(
    hooks.filter((row) => row.event === 'PermissionDenied').map((row) => row.id),
  )
  try {
    const result = JSON.parse(output)
    for (const item of result.permission_denials ?? [])
      if (Object.values(ids).includes(item.tool_use_id)) denied.add(item.tool_use_id)
  } catch {} // No valid native result means no synthetic permission receipt.
  const nativeLog = join(c.probe, 'native-debug.log')
  const nativeDenied = existsSync(nativeLog)
    ? new Set(
        [
          ...readFileSync(nativeLog, 'utf8').matchAll(
            /\b(Read|Write|Bash) tool permission denied\b/g,
          ),
        ].map((match) => match[1]),
      )
    : new Set()
  const tool = (kind, markerUnchanged) => {
    const errorResult = observations.results[ids[kind]]?.error === true
    const name = { outsideRead: 'Read', write: 'Write', command: 'Bash' }[kind]
    const ownHook = hooks.some(
      (row) => row.event === 'PreToolUse' && row.child && row.id === ids[kind] && row.tool === name,
    )
    const source = denied.has(ids[kind])
      ? 'permission-denied-hook'
      : errorResult && ownHook && nativeDenied.has(name)
        ? 'native-debug+owned-hook+error-result'
        : null
    return {
      source,
      advertised: observations.advertised[kind] === true,
      errorResult,
      permissionDenied: source !== null,
      markerUnchanged,
    }
  }
  return {
    parentPermissionMode:
      hooks.find(
        (row) => row.event === 'PreToolUse' && !row.child && ['Agent', 'Task'].includes(row.tool),
      )?.mode ?? null,
    agentPermissionDenied: hooks.some(
      (row) => row.event === 'PermissionDenied' && !row.child && row.id === 'toolu_posture_agent',
    ),
    agentDenialSource: hooks.some(
      (row) => row.event === 'PermissionDenied' && !row.child && row.id === 'toolu_posture_agent',
    )
      ? 'permission-denied-hook'
      : null,
    childPermissionMode:
      hooks.find((row) => row.event === 'PreToolUse' && row.child && row.id === ids.read)?.mode ??
      null,
    agentLoaded: hooks.some((row) => row.event === 'SubagentStart' && row.agentTypeMatches),
    childModelObserved: observations.childModelObserved,
    readRoundTrip:
      observations.results[ids.read]?.error === false &&
      observations.results[ids.read]?.marker === true,
    outsideRead: tool(
      'outsideRead',
      readFileSync(c.secret, 'utf8') === 'POSTURE_OUTSIDE_READ_FIXTURE\n',
    ),
    write: tool('write', !existsSync(c.writeMarker)),
    command: tool('command', !existsSync(c.commandMarker)),
    requests: observations.requests,
  }
}
async function worker(c) {
  const abort = new AbortController(),
    groups = new Map([[process.pid, new Map()]])
  let child,
    closed,
    api,
    screen,
    sampler,
    sampling = false,
    observationError,
    output = '',
    stderr = '',
    result
  const stop = () => abort.abort()
  process.once('disconnect', stop)
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const timer = setTimeout(stop, c.kind === 'version' ? 10_000 : 30_000)
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
  const joinGroups = async () => {
    for (const [group, cohort] of groups)
      await joinGroup(group, cohort, group === process.pid ? process.pid : 0)
  }
  const cleanup = async () => {
    clearInterval(sampler)
    while (sampling) await delay(10)
    try {
      await sample()
      if (child) {
        if (c.kind === 'picker' || (child.exitCode === null && child.signalCode === null))
          child.kill('SIGKILL')
        await joinGroups()
        const actual = await Promise.race([
          closed,
          delay(3000).then(() => {
            throw new Error('capture child join failed')
          }),
        ])
        if (result && !['version', 'picker'].includes(c.kind)) {
          result.exitCode = actual.code
          result.exitSignal = actual.signal ?? null
        }
        if (result && c.kind === 'picker') {
          result.exitCode = actual.exitCode ?? actual.code ?? null
          result.exitSignal = actual.signal ?? null
          result.deadline = abort.signal.aborted
          result.stoppedByCapture = actual.signal === 9
        }
      }
      await sample()
      if (observationError) throw observationError
      await joinGroups()
      writeFileSync(
        join(c.probe, 'cleanup.json'),
        JSON.stringify({
          status: 'joined',
          groups: [...groups].map(([group, cohort]) => ({ group, cohort: [...cohort] })),
        }),
        { mode: 0o600 },
      )
    } finally {
      clearTimeout(timer)
      screen?.dispose()
      api?.server.closeAllConnections()
      if (api) await new Promise((done) => api.server.close(done))
    }
  }
  try {
    await sample()
    sampler = setInterval(sample, 100)
    api = await backend(c)
    prepare(c, api.url)
    const args =
      c.kind === 'version'
        ? ['--version']
        : [
            '--permission-mode',
            c.kind === 'picker' ? 'default' : c.kind,
            '--model',
            'sonnet',
            '--strict-mcp-config',
            '--mcp-config',
            '{"mcpServers":{}}',
            '--setting-sources',
            'user',
            '--debug-file',
            join(c.probe, 'native-debug.log'),
            ...(c.kind === 'picker'
              ? []
              : [
                  '--no-session-persistence',
                  '--disable-slash-commands',
                  '--print',
                  '--output-format',
                  'json',
                  `Use the ${model.id} agent to check the fake README fixture once.`,
                ]),
          ]
    if (c.kind === 'picker') {
      const { PtyScreen } = await import('../dist/src/anyengine-screen.mjs')
      screen = new PtyScreen(120, 45)
      child = createRequire(import.meta.url)('node-pty').spawn(
        SANDBOX_EXEC,
        ['-p', c.policy, c.binary, ...args],
        { cwd: c.work, env: cleanEnv(c, api.url), name: 'xterm-256color', cols: 120, rows: 45 },
      )
      groups.set(child.pid, new Map())
      child.onData((data) => screen.write(data))
      closed = new Promise((done) => child.onExit(done))
      const until = async (predicate, ms) => {
        const end = Date.now() + ms
        while (!abort.signal.aborted && Date.now() < end) {
          const lines = await screen.viewport()
          if (predicate(lines)) return lines
          await delay(100)
        }
        return await screen.viewport()
      }
      const ready = await until(
        (lines) => lines.some((line) => /❯|for shortcuts/.test(line)),
        10_000,
      )
      if (ready.some((line) => /❯|for shortcuts/.test(line))) child.write('/model\r')
      const lines = await until(
        (lines) =>
          lines.some((line) => /Select (?:a )?model|Choose (?:a )?model/i.test(line)) &&
          lines.some((line) => line.includes(model.label)),
        12_000,
      )
      const menuObserved = lines.some((line) =>
          /Select (?:a )?model|Choose (?:a )?model/i.test(line),
        ),
        gptRowObserved = menuObserved && lines.some((line) => line.includes(model.label)),
        builtInRowsObserved = menuObserved && lines.some((line) => /Opus|Sonnet|Haiku/.test(line))
      result = {
        menuObserved,
        gptRowObserved,
        builtInRowsObserved,
        composerOnly: !menuObserved && lines.some((line) => line.includes(model.id)),
        status: menuObserved && gptRowObserved && builtInRowsObserved ? 'proven' : 'open',
        labels: lines
          .filter((line) =>
            /Select (?:a )?model|Choose (?:a )?model|Opus|Sonnet|Haiku|GPT Posture Fixture|no-session-persistence/.test(
              line,
            ),
          )
          .map((line) => line.trim().slice(0, 180)),
      }
    } else {
      child = spawn(SANDBOX_EXEC, ['-p', c.policy, c.binary, ...args], {
        cwd: c.work,
        env: cleanEnv(c, api.url),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.on('error', stop)
      closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })))
      child.stdout.on('data', (b) => {
        output += b.toString('utf8')
        if (Buffer.byteLength(output) > limit) stop()
      })
      child.stderr.on('data', (b) => {
        stderr += b.toString('utf8')
        if (Buffer.byteLength(stderr) > limit) stop()
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
      } else
        result = {
          ...summary(c, api.observations, output),
          exitCode: ended.code,
          deadline: ended.deadline === true,
          diagnostic: {
            unknownOption: /unknown option|unrecognized option/i.test(stderr),
            accessDenied: /EPERM|EACCES|operation not permitted/i.test(stderr),
            stderrBytes: Buffer.byteLength(stderr),
            startupSummary: stderr
              .replaceAll(fakeKey, '<FAKE_KEY>')
              .replaceAll(c.probe, '<PROBE>')
              .replaceAll(c.binary, '<CLAUDE_BINARY>')
              .replaceAll(c.node, '<NODE_BINARY>')
              .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<PORT>')
              .replace(/\/Users\/[^\s'"]+/g, '<REAL_HOME_PATH>')
              .trim()
              .slice(0, 1024),
          },
        }
    }
  } finally {
    await cleanup()
  }
  result.cleanup = 'joined'
  writeFileSync(join(c.probe, 'observation.json'), JSON.stringify(result), { mode: 0o600 })
  return result
}
async function supervised(c) {
  const child = fork(file, ['--worker'], {
    cwd: c.work,
    env: { ...cleanEnv(c, 'http://127.0.0.1:1'), CAPTURE_POSTURE_CONFIG: JSON.stringify(c) },
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  child.stderr.resume()
  let answer, hardTimer
  child.on('message', (value) => {
    answer = value
  })
  const closed = once(child, 'close'),
    admitted = (await members(child.pid)).find((p) => p.pid === child.pid)
  const stop = () => {
    if (child.connected) child.disconnect()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const timer = setTimeout(() => {
    stop()
    hardTimer = setTimeout(async () => {
      try {
        const current = (await members(child.pid)).find((p) => p.pid === child.pid)
        if (current && current.start === admitted?.start) process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, 4000)
  }, 40_000)
  try {
    const [code, signal] = await closed
    if (code !== 0 || signal || !answer?.ok)
      throw new Error(
        `isolated posture ${c.kind} capture failed (${answer?.failure ?? 'worker-exit'})`,
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
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
}
export async function captureClaudePosture(args = process.argv.slice(2)) {
  assert.equal(
    args[0],
    '--claude',
    'usage: capture-claude-posture.mjs --claude PATH [--out FRESH_FILE]',
  )
  assert.ok(
    args.length === 2 ||
      (args.length === 4 && args[2] === '--out') ||
      (args.length === 6 &&
        args[2] === '--out' &&
        args[4] === '--case' &&
        ['default', 'plan', 'dontAsk', 'picker'].includes(args[5])),
  )
  requireSandbox('capture-claude-posture')
  const binary = realpathSync(args[1]),
    node = realpathSync(process.execPath),
    protectedHome = realpathSync(homedir())
  const root = realpathSync(mkdtempSync('/private/tmp/ccp-')),
    identity = lstatSync(root)
  let published = false
  try {
    const run = async (kind, version) => {
      const probe = join(root, kind),
        home = join(probe, 'h'),
        config = join(home, '.claude'),
        work = join(probe, 'w'),
        temp = join(probe, 't'),
        outside = join(probe, 'outside')
      for (const path of [home, config, work, temp, outside])
        mkdirSync(path, { recursive: true, mode: 0o700 })
      const c = {
        kind,
        version,
        probe,
        home,
        config,
        work,
        temp,
        binary,
        node,
        secret: join(outside, 'secret.txt'),
        writeMarker: join(outside, 'write.txt'),
        commandMarker: join(outside, 'command.txt'),
      }
      const value = await supervised({ ...c, policy: policy(c, protectedHome) })
      console.log(`captured posture ${kind}; owned processes joined`)
      return value
    }
    const { version } = await run('version')
    assert.equal(version, '2.1.289', 'posture test fixture must match actual CLI version')
    const modes = {}
    const selected = args[5]
    for (const mode of ['default', 'plan', 'dontAsk'])
      if (!selected || mode === selected) modes[mode] = await run(mode, version)
    const picker = !selected || selected === 'picker' ? await run('picker', version) : null,
      opens = []
    for (const [mode, row] of Object.entries(modes)) {
      if (
        !row.agentLoaded ||
        !row.childModelObserved ||
        !row.readRoundTrip ||
        row.parentPermissionMode !== mode ||
        row.childPermissionMode !== mode
      )
        opens.push({
          contract: `agentInheritance:${mode}`,
          reason: 'The actual blank-body agent/mode/positive-Read receipts were incomplete.',
        })
      for (const tool of ['outsideRead', 'write', 'command'])
        if (
          !['advertised', 'errorResult', 'permissionDenied', 'markerUnchanged'].every(
            (key) => row[tool][key] === true,
          )
        )
          opens.push({
            contract: `permission:${mode}:${tool}`,
            reason:
              'The actual advertised tool, native denial, error-result and unchanged-marker receipts did not all pass.',
          })
      if (row.deadline || row.exitCode !== 0)
        opens.push({
          contract: `terminal:${mode}`,
          reason: 'The actual CLI did not complete successfully within the bounded capture.',
        })
    }
    if (picker && picker.status !== 'proven')
      opens.push({
        contract: 'pickerMenu',
        reason:
          'A bounded actual picker menu with both GPT custom and built-in rows was not observed; composer text is not proof.',
      })
    const fixture = {
      claudeVersion: version,
      isolation: {
        fakeCredentials: true,
        loopbackOnly: true,
        realHomeReadWriteDenied: true,
        keychainFilesAndMachDenied: true,
        cleanup: 'all owned groups joined',
      },
      agentTemplate: {
        fields: ['name', 'description', 'model'],
        bodyBlank: true,
        source: 'generated-agent-file',
      },
      modes,
      unexercisedModes: ['acceptEdits', 'auto', 'bypassPermissions', 'manual'],
      picker,
      opens,
    }
    writeFileSync(
      args[3] ? resolve(args[3]) : join(repo, 'test/fixtures', `claude-posture-${version}.json`),
      `${JSON.stringify(fixture, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    )
    published = opens.length === 0
    console.log(
      `CAPTURE Claude ${version}: ${opens.length} explicit Open posture/menu contracts; no live model calls`,
    )
    return fixture
  } finally {
    const current = lstatSync(root)
    if (published && current.dev === identity.dev && current.ino === identity.ino)
      rmSync(root, { recursive: true, force: true })
    else console.error(`capture retained private fake evidence: ${root}`)
  }
}
const direct = process.argv[1] && resolve(process.argv[1]) === file
if (direct && process.argv[2] === '--worker') {
  try {
    const value = await worker(JSON.parse(process.env.CAPTURE_POSTURE_CONFIG))
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
    await captureClaudePosture()
  } catch (error) {
    console.error(`FAIL fake Claude posture capture: ${error.message}`)
    process.exitCode = 1
  }
}
