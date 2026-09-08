import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  CompactionStreamGate,
  MAIN_AGENT_SENTINEL,
  SsePtyProxy,
  type SseStreamInfo,
  type StreamDelta,
  sseEventToDeltas,
} from '../src/jinn-pty-proxy.mjs'
import {
  asyncLaunch,
  buildInteractiveArgs,
  isNativeClaudeCommand,
  JinnPtyRuntime,
  type JinnPtyRuntimeOptions,
  shapeToolResult,
  streamIsCurrent,
} from '../src/jinn-pty-runtime.mjs'
import {
  chooseApproval,
  composerReady,
  keystrokesToSelect,
  parsePermissionPrompt,
  parseStartupPrompt,
} from '../src/jinn-pty-screen.mjs'
import {
  lastAssistantTextFromTranscript,
  parseTaskNotifications,
  sanitizeAssistantText,
  taskNotificationsFromTranscript,
} from '../src/jinn-pty-transcript.mjs'
import { resolveRuntimeConfig } from '../src/runtime-config.mjs'
import type { PermissionDecision, RuntimeEvent, RuntimeTurnContext } from '../src/types.mjs'

const FAKE_CLAUDE = resolve('test/fixtures/fake-claude.mjs')
const RELAY = resolve('scripts/jinn-pty-hook-relay.mjs')

function turnContext(overrides: Partial<RuntimeTurnContext> = {}): RuntimeTurnContext {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    prompt: 'hello',
    cwd: process.cwd(),
    runtimeType: 'jinn-pty',
    model: null,
    effort: null,
    claudeSessionId: null,
    forkSession: false,
    mcpServers: null,
    allowedTools: null,
    addDirs: [],
    enableFileCheckpointing: false,
    outputFormat: null,
    approvalPolicy: null,
    sandboxMode: null,
    systemPromptAddendum: null,
    planMode: false,
    imageInputs: [],
    ...overrides,
  }
}

interface Harness {
  runtime: JinnPtyRuntime
  dir: string
  argsFile: string
  events: RuntimeEvent[]
  permissionRequests: Array<Extract<RuntimeEvent, { type: 'permission_request' }>>
  decision: PermissionDecision
  run(context: RuntimeTurnContext): Promise<void>
  close(): Promise<void>
}

async function harness(
  overrides: Partial<JinnPtyRuntimeOptions> = {},
  env: Record<string, string> = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-codex-jinn-pty-'))
  const argsFile = join(dir, 'args.jsonl')
  const previous = new Map<string, string | undefined>()
  const applied: Record<string, string> = {
    FAKE_CLAUDE_ARGS_FILE: argsFile,
    FAKE_CLAUDE_TRANSCRIPT_DIR: dir,
    ...env,
  }
  for (const [key, value] of Object.entries(applied)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  const runtime = new JinnPtyRuntime({
    cli: FAKE_CLAUDE,
    cols: 100,
    rows: 30,
    turnTimeoutMs: 20_000,
    asyncSubagentTimeoutMs: 60_000,
    startupTimeoutMs: 10_000,
    streamProxy: false,
    extraArgs: [],
    hookTimeoutSec: 60,
    autoApproveSafetyPrompts: true,
    keepApiKey: true,
    stateDir: join(dir, 'state'),
    relayScript: RELAY,
    nodeBinary: process.execPath,
    ...overrides,
  })
  const h: Harness = {
    runtime,
    dir,
    argsFile,
    events: [],
    permissionRequests: [],
    decision: { decision: 'accept' },
    async run(context) {
      await runtime.runTurn(context, {
        onEvent: (event) => {
          h.events.push(event)
        },
        onPermissionRequest: async (event) => {
          h.permissionRequests.push(event)
          return h.decision
        },
      })
    },
    async close() {
      await runtime.stop()
      const errors = await readFile(`${argsFile}.err`, 'utf8').catch(() => '')
      if (errors) process.stderr.write(`fake-claude errors:\n${errors}`)
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(dir, { recursive: true, force: true })
    },
  }
  return h
}

function text(events: RuntimeEvent[]): string {
  return events
    .filter(
      (event): event is Extract<RuntimeEvent, { type: 'text_delta' }> =>
        event.type === 'text_delta',
    )
    .map((event) => event.delta)
    .join('')
}

function completed(events: RuntimeEvent[]): Extract<RuntimeEvent, { type: 'completed' }> {
  const found = events.find(
    (event): event is Extract<RuntimeEvent, { type: 'completed' }> => event.type === 'completed',
  )
  assert.ok(found, 'expected a completed event')
  return found
}

test('runtime config resolves jinn-pty and its aliases', () => {
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_RUNTIME_TYPE: 'jinn-pty' }).type, 'jinn-pty')
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_RUNTIME_TYPE: 'pty' }).type, 'jinn-pty')
  assert.equal(resolveRuntimeConfig({ CLAUDE_CODEX_RUNTIME_TYPE: 'claude-pty' }).type, 'jinn-pty')
  const config = resolveRuntimeConfig({
    CLAUDE_CODEX_RUNTIME_TYPE: 'jinn-pty',
    CLAUDE_CODEX_CLI: '/opt/bin/claude',
    CLAUDE_CODEX_PTY_COLS: '150',
    CLAUDE_CODEX_PTY_ROWS: '50',
    CLAUDE_CODEX_PTY_TURN_TIMEOUT_MS: '1234',
    CLAUDE_CODEX_PTY_STREAM_PROXY: '0',
  })
  assert.equal(config.jinnPty.cli, '/opt/bin/claude')
  assert.equal(config.jinnPty.cols, 150)
  assert.equal(config.jinnPty.rows, 50)
  assert.equal(config.jinnPty.turnTimeoutMs, 1234)
  assert.equal(config.jinnPty.streamProxy, false)
  assert.equal(resolveRuntimeConfig({}).jinnPty.streamProxy, true)
})

test('buildInteractiveArgs mirrors the turn context onto the claude CLI', () => {
  const args = buildInteractiveArgs({
    context: turnContext({
      claudeSessionId: 'sess-1',
      model: 'opus',
      effort: 'high',
      planMode: true,
      systemPromptAddendum: 'Be terse.',
      addDirs: ['/extra'],
      allowedTools: ['Read'],
    }),
    settingsPath: '/tmp/s.json',
    mcpPath: '/tmp/mcp.json',
    extraArgs: ['--verbose'],
  })
  assert.deepEqual(args.slice(0, 2), ['--resume', 'sess-1'])
  assert.ok(!args.includes('--fork-session'))
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), [
    '--model',
    'opus',
  ])
  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), [
    '--effort',
    'high',
  ])
  assert.deepEqual(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2), [
    '--settings',
    '/tmp/s.json',
  ])
  assert.equal(
    args[args.indexOf('--append-system-prompt') + 1],
    `Be terse.\n\n${MAIN_AGENT_SENTINEL}`,
  )
  assert.deepEqual(
    args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'plan'],
  )
  assert.deepEqual(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2), [
    '--mcp-config',
    '/tmp/mcp.json',
  ])
  assert.ok(args.includes('--disallowedTools'))
  assert.equal(args.at(-1), '--verbose')

  const fresh = buildInteractiveArgs({
    context: turnContext({ claudeSessionId: 'sess-2', forkSession: true }),
    settingsPath: '/tmp/s.json',
    mcpPath: null,
    extraArgs: [],
  })
  assert.ok(fresh.includes('--fork-session'))
  assert.ok(!fresh.includes('--model'))
  assert.ok(!fresh.includes('--permission-mode'))
  assert.equal(fresh[fresh.indexOf('--append-system-prompt') + 1], MAIN_AGENT_SENTINEL)
})

test('shapeToolResult flattens Bash responses and passes content arrays through', () => {
  assert.deepEqual(shapeToolResult('Bash', { stdout: 'hi', stderr: '', interrupted: false }), {
    content: 'hi',
    isError: false,
  })
  assert.deepEqual(shapeToolResult('Bash', { stdout: '', stderr: 'boom', interrupted: true }), {
    content: 'boom',
    isError: true,
  })
  assert.deepEqual(shapeToolResult('Read', { content: [{ type: 'text', text: 'x' }] }), {
    content: [{ type: 'text', text: 'x' }],
    isError: false,
  })
  assert.deepEqual(shapeToolResult('Edit', 'ok'), { content: 'ok', isError: false })
  assert.ok(isNativeClaudeCommand('/compact now'))
  assert.ok(!isNativeClaudeCommand('compact this'))
})

test('screen parsers recognise safety prompts and the workspace trust dialog', () => {
  const safety = [
    ' Dangerous rm operation on possibly-empty variable path: "$W4/$d"',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend',
  ]
  const prompt = parsePermissionPrompt(safety)
  assert.ok(prompt)
  assert.equal(prompt.selectedPosition, 0)
  assert.equal(prompt.reason, 'Dangerous rm operation on possibly-empty variable path: "$W4/$d"')
  assert.equal(chooseApproval(prompt)?.label, 'Yes')
  assert.deepEqual(keystrokesToSelect(0, 1), ['\x1b[B', '\r'])
  assert.deepEqual(keystrokesToSelect(1, 0), ['\x1b[A', '\r'])
  assert.equal(parsePermissionPrompt(['❯ ', '  ? for shortcuts']), null)
  const ambiguous = parsePermissionPrompt([
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and always',
    '   3. No',
  ])
  assert.ok(ambiguous)
  assert.equal(chooseApproval(ambiguous)?.label, 'Yes')

  // Verbatim from claude 2.1.263 (cursor defaults to "No, exit").
  const trust = [
    ' Accessing workspace:',
    ' /tmp/project',
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code)',
    " project, or work from your team). If not, take a moment to review what's in this folder first.",
    " Claude Code'll be able to read, edit, and execute files here.",
    ' Security guide',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    ' Enter to confirm · Esc to cancel',
  ]
  const answer = parseStartupPrompt(trust)
  assert.ok(answer)
  assert.equal(answer.label, 'Yes, I trust this folder')
  assert.deepEqual(answer.keystrokes, ['\x1b[B', '\r'])
  assert.equal(
    composerReady(['▐▛███▛█   Claude Code v2.1.263', '❯ ', '  ⏸ manual mode on · ? for shortcuts']),
    true,
  )
  assert.equal(parseStartupPrompt(['❯ ', '  ? for shortcuts']), null)
})

test('transcript helpers pick the last assistant text of the turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-codex-transcript-'))
  const file = join(dir, 't.jsonl')
  const line = (ts: string, text: string) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: { content: [{ type: 'text', text }] },
    })
  await writeFile(
    file,
    `${line('2026-01-01T00:00:00Z', 'old')}\n${line('2026-01-02T00:00:00Z', 'new')}\n{"type":"user"}\n`,
  )
  assert.equal(lastAssistantTextFromTranscript(file), 'new')
  assert.equal(lastAssistantTextFromTranscript(file, Date.parse('2026-01-03T00:00:00Z')), undefined)
  assert.equal(sanitizeAssistantText('<thinking>x</thinking> hi <suggestion>y</suggestion>'), 'hi')
  await rm(dir, { recursive: true, force: true })
})

test('sse deltas and the compaction gate drop summaries and strip suggestions', () => {
  assert.deepEqual(
    sseEventToDeltas({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }),
    [{ type: 'text', content: 'hi' }],
  )
  assert.deepEqual(
    sseEventToDeltas({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'hm' },
    }),
    [{ type: 'thinking', content: 'hm' }],
  )
  const gate = new CompactionStreamGate()
  const t = (content: string): StreamDelta => ({ type: 'text', content })
  assert.deepEqual(gate.accept([t('<ana')]), [])
  assert.deepEqual(gate.accept([t('lysis>summary')]), [])
  assert.deepEqual(gate.end(), [])
  assert.deepEqual(gate.accept([t('<suggestion>next</suggestion>real')]), [t('real')])
  assert.deepEqual(gate.accept([t(' more')]), [t(' more')])
  gate.reset()
  assert.deepEqual(gate.accept([t('<')]), [], 'a possible opener prefix is held')
  assert.deepEqual(gate.accept([t('b>')]), [t('<'), t('b>')])
  gate.reset()
  assert.deepEqual(gate.accept([t('Hel')]), [t('Hel')], 'plain text passes immediately')
})

test('sse proxy forwards requests untouched and tees only sentinel streams', async () => {
  const seenHeaders: http.IncomingHttpHeaders[] = []
  const upstream = http.createServer((req, res) => {
    seenHeaders.push(req.headers)
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
      )
      res.write(
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"PO"}}\n\n',
      )
      setTimeout(() => {
        res.write(
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"NG"}}\n\n',
        )
        res.end('data: {"type":"message_stop"}\n\n')
      }, 20)
    })
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const upstreamPort = (upstream.address() as { port: number }).port
  const events: string[] = []
  const streams: SseStreamInfo[] = []
  let tagCalls = 0
  const proxy = new SsePtyProxy(
    't',
    (event, stream) => {
      events.push(String(event.type))
      streams.push(stream)
    },
    {
      upstream: { hostname: '127.0.0.1', port: upstreamPort, protocol: 'http:' },
      tagStream: () => {
        tagCalls += 1
        return { turnId: 'turn-1', acceptedAt: 5 }
      },
    },
  )
  const port = await proxy.start()
  const post = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-token',
        'anthropic-beta': 'x',
        'accept-encoding': 'gzip',
      },
      body: JSON.stringify(body),
    })
    return response.text()
  }
  const before = Date.now()
  const raw = await post({
    tools: [{ name: 'Bash' }],
    system: [{ type: 'text', text: `base ${MAIN_AGENT_SENTINEL}` }],
  })
  assert.match(raw, /"text":"PO"/)
  assert.match(raw, /message_stop/)
  assert.deepEqual(events, [
    'message_start',
    'content_block_delta',
    'content_block_delta',
    'message_stop',
  ])
  // Every event of one request carries the same start-time/tag snapshot,
  // taken once when the request reached the proxy.
  assert.equal(tagCalls, 1)
  assert.equal(new Set(streams).size, 1)
  assert.ok(streams[0] && streams[0].startedAt >= before && streams[0].startedAt <= Date.now())
  assert.deepEqual(streams[0]?.tag, { turnId: 'turn-1', acceptedAt: 5 })
  assert.equal(seenHeaders[0]?.authorization, 'Bearer test-token')
  assert.equal(seenHeaders[0]?.['anthropic-beta'], 'x')
  assert.equal(seenHeaders[0]?.['accept-encoding'], undefined)
  assert.equal(seenHeaders[0]?.host, '127.0.0.1')

  events.length = 0
  await post({ tools: [{ name: 'Bash' }], system: 'subagent prompt' })
  assert.deepEqual(events, [], 'non-sentinel requests are not teed')
  await post({ system: MAIN_AGENT_SENTINEL })
  assert.deepEqual(events, [], 'tool-less requests are not teed')
  assert.equal(tagCalls, 1, "untee'd requests are not tagged")
  proxy.stop()
  upstream.close()
})

test('jinn-pty runtime: turn, warm-PTY permission round-trip, deny and full access', async () => {
  const h = await harness()
  try {
    await h.run(turnContext({ prompt: 'Reply with exactly the word PONG' }))
    assert.equal(text(h.events), 'PONG:Reply with exactly the word PONG')
    const first = completed(h.events)
    assert.equal(first.success, true)
    assert.equal(first.result, 'PONG:Reply with exactly the word PONG')
    assert.ok(first.claudeSessionId)
    const session = h.events.find((event) => event.type === 'session')
    assert.ok(session && session.type === 'session')
    assert.equal(session.claudeSessionId, first.claudeSessionId)
    assert.ok(h.events.some((event) => event.type === 'usage'))
    assert.equal(h.permissionRequests.length, 0)
    assert.ok(h.runtime.hasLivePtys())

    // Second turn reuses the warm PTY: Bash needs the App's approval.
    h.events = []
    await h.run(turnContext({ turnId: 'turn-2', prompt: 'Run echo hi' }))
    assert.equal(h.permissionRequests.length, 1)
    assert.equal(h.permissionRequests[0]?.toolName, 'Bash')
    assert.equal(h.permissionRequests[0]?.input.command, 'echo hi')
    const toolUse = h.events.find((event) => event.type === 'tool_use')
    assert.ok(toolUse && toolUse.type === 'tool_use')
    assert.equal(toolUse.toolName, 'Bash')
    const toolResult = h.events.find((event) => event.type === 'tool_result')
    assert.ok(toolResult && toolResult.type === 'tool_result')
    assert.equal(toolResult.toolUseId, toolUse.toolUseId)
    assert.equal(toolResult.content, 'hi')
    assert.equal(text(h.events), 'ran: hi')
    const spawns = (await readFile(h.argsFile, 'utf8')).trim().split('\n')
    assert.equal(spawns.length, 1, 'warm PTY reused, no respawn')
    const args = JSON.parse(spawns[0] ?? '[]') as string[]
    assert.ok(!args.includes('--resume'))
    assert.ok(args.includes('--settings'))
    assert.equal(args[args.indexOf('--append-system-prompt') + 1], MAIN_AGENT_SENTINEL)

    // Declined approval reaches Claude as a deny with a reason.
    h.events = []
    h.permissionRequests = []
    h.decision = { decision: 'decline' }
    await h.run(turnContext({ turnId: 'turn-3', prompt: 'Run echo nope' }))
    assert.equal(h.permissionRequests.length, 1)
    assert.equal(text(h.events), 'denied: denied by user')
    assert.ok(!h.events.some((event) => event.type === 'tool_result'))

    // Full access skips the App round-trip entirely.
    h.events = []
    h.permissionRequests = []
    await h.run(
      turnContext({ turnId: 'turn-4', prompt: 'Run echo free', sandboxMode: 'danger-full-access' }),
    )
    assert.equal(h.permissionRequests.length, 0)
    assert.equal(text(h.events), 'ran: free')
  } finally {
    await h.close()
  }
})

test('jinn-pty runtime: resume args, transcript fallback and model change respawn', async () => {
  const h = await harness({}, { FAKE_CLAUDE_OMIT_LAST_MESSAGE: '1' })
  try {
    await h.run(turnContext({ claudeSessionId: 'sess-resume-1', model: 'haiku', prompt: 'hi' }))
    const done = completed(h.events)
    assert.equal(done.claudeSessionId, 'sess-resume-1')
    assert.equal(done.result, 'PONG:hi', 'final text recovered from the transcript')
    assert.equal(text(h.events), 'PONG:hi')
    let spawns = (await readFile(h.argsFile, 'utf8')).trim().split('\n')
    const args = JSON.parse(spawns[0] ?? '[]') as string[]
    assert.deepEqual(args.slice(0, 2), ['--resume', 'sess-resume-1'])
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), [
      '--model',
      'haiku',
    ])

    h.events = []
    await h.run(
      turnContext({
        turnId: 'turn-2',
        claudeSessionId: 'sess-resume-1',
        model: 'opus',
        prompt: 'again',
      }),
    )
    assert.equal(text(h.events), 'PONG:again')
    spawns = (await readFile(h.argsFile, 'utf8')).trim().split('\n')
    assert.equal(spawns.length, 2, 'model change forces a cold respawn')
    const respawn = JSON.parse(spawns[1] ?? '[]') as string[]
    assert.deepEqual(respawn.slice(0, 2), ['--resume', 'sess-resume-1'])
    assert.equal(respawn[respawn.indexOf('--model') + 1], 'opus')
  } finally {
    await h.close()
  }
})

test('jinn-pty runtime: trust dialog is answered before the first prompt', async () => {
  const h = await harness({}, { FAKE_CLAUDE_TRUST_PROMPT: '1' })
  try {
    await h.run(turnContext({ prompt: 'trusted?' }))
    assert.equal(text(h.events), 'PONG:trusted?')
  } finally {
    await h.close()
  }
})

test('jinn-pty runtime: safety prompt falls back to keystrokes consistent with the approval', async () => {
  const h = await harness()
  try {
    await h.run(turnContext({ prompt: 'do the SAFETY thing' }))
    assert.equal(h.permissionRequests.length, 1)
    assert.equal(text(h.events), 'safety approved')
    h.events = []
    h.decision = { decision: 'decline' }
    await h.run(turnContext({ turnId: 'turn-2', prompt: 'do the SAFETY thing again' }))
    assert.equal(text(h.events), 'safety rejected')
  } finally {
    await h.close()
  }
})

test('jinn-pty runtime: StopFailure fails the turn, interrupt settles it, stop kills the PTY', async () => {
  const h = await harness()
  try {
    await assert.rejects(h.run(turnContext({ prompt: 'please FAIL' })), /rate_limit/)
    const failed = completed(h.events)
    assert.equal(failed.success, false)
    assert.match(String(failed.result), /rate_limit/)

    h.events = []
    const slow = h.run(turnContext({ turnId: 'turn-2', prompt: 'be SLOW' }))
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await h.runtime.interrupt('thread-1')
    await slow
    assert.ok(!h.events.some((event) => event.type === 'completed'))

    const pids = h.runtime.livePids()
    assert.equal(pids.length, 1)
    await h.runtime.stop()
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.throws(() => process.kill(pids[0] ?? 0, 0), 'PTY process is gone after stop()')
    assert.equal(h.runtime.hasLivePtys(), false)
  } finally {
    await h.close()
  }
})

test('jinn-pty runtime: a stale --resume id falls back to a fresh session', async () => {
  const h = await harness({}, { FAKE_CLAUDE_STALE_RESUME: '1' })
  try {
    await h.run(turnContext({ claudeSessionId: 'sess-gone', model: 'sonnet', prompt: 'hi' }))
    const completions = h.events.filter((e) => e.type === 'completed') as Array<
      Extract<RuntimeEvent, { type: 'completed' }>
    >
    const done = completions.at(-1)!
    assert.equal(done.success, true, 'the fresh-session attempt completed')
    assert.notEqual(done.claudeSessionId, 'sess-gone', 'a new session id replaces the stale one')
    assert.ok(
      h.events.some((e) => e.type === 'notice' && /could not be resumed/.test((e as any).message)),
      'warning notice emitted',
    )
    const spawns = (await readFile(h.argsFile, 'utf8')).trim().split('\n')
    assert.equal(spawns.length, 2, 'spawned twice: resume attempt, then fresh')
    assert.ok(!JSON.parse(spawns[1] ?? '[]').includes('--resume'), 'second spawn has no --resume')
  } finally {
    await h.close()
  }
})

test("stream gate: only requests that started inside the accepted prompt are this turn's", () => {
  const stream = (startedAt: number, tag: unknown): SseStreamInfo => ({ startedAt, tag })
  const t1 = { turnId: 'turn-1', acceptedAt: 1000 }
  assert.equal(streamIsCurrent(stream(1001, t1), 'turn-1', 1000), true)
  assert.equal(streamIsCurrent(stream(1000, t1), 'turn-1', 1000), true, 'same tick passes')
  // The post-Stop follow-up-suggestion request: started before the next
  // prompt was accepted, tagged with a null / older acceptance.
  assert.equal(
    streamIsCurrent(stream(999, { turnId: 'turn-1', acceptedAt: null }), 'turn-1', 1000),
    false,
  )
  assert.equal(
    streamIsCurrent(stream(1500, { turnId: 'turn-1', acceptedAt: 900 }), 'turn-1', 1000),
    false,
  )
  assert.equal(streamIsCurrent(stream(999, t1), 'turn-1', 1000), false, 'started before acceptance')
  // No turn was active when the request started.
  assert.equal(streamIsCurrent(stream(1001, null), 'turn-1', 1000), false)
  assert.equal(streamIsCurrent(stream(1001, undefined), 'turn-1', 1000), false)
  // A different turn, or the turn's acceptance has since been reset by a held Stop.
  assert.equal(streamIsCurrent(stream(1001, t1), 'turn-2', 1000), false)
  assert.equal(streamIsCurrent(stream(1001, t1), 'turn-1', null), false)
  assert.equal(streamIsCurrent(stream(1001, t1), 'turn-1', 2000), false)

  assert.deepEqual(
    asyncLaunch('Agent', {
      isAsync: true,
      status: 'async_launched',
      agentId: 'a1',
      description: 'd',
    }),
    { agentId: 'a1', description: 'd' },
  )
  assert.deepEqual(asyncLaunch('Task', { status: 'async_launched', agentId: 'a2' }), {
    agentId: 'a2',
    description: '',
  })
  assert.equal(asyncLaunch('Agent', { status: 'completed', content: 'x' }), null)
  assert.equal(asyncLaunch('Bash', { isAsync: true, agentId: 'a3' }), null)
  assert.equal(asyncLaunch('Agent', { isAsync: true }), null, 'no agent id, nothing to track')
})

test('task notifications are parsed from prompts and transcripts', async () => {
  const block = (id: string, result: string, status = 'completed') =>
    `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n<result>${result}</result>\n</task-notification>`
  assert.deepEqual(parseTaskNotifications('plain prompt'), [])
  assert.deepEqual(
    parseTaskNotifications(`${block('a1', 'ALPHA')}\n${block('b2', 'oops', 'failed')}`),
    [
      { taskId: 'a1', status: 'completed', result: 'ALPHA' },
      { taskId: 'b2', status: 'failed', result: 'oops' },
    ],
  )
  assert.deepEqual(
    parseTaskNotifications('<task-notification><status>completed</status></task-notification>'),
    [],
  )
  const dir = await mkdtemp(join(tmpdir(), 'claude-codex-notify-'))
  const file = join(dir, 't.jsonl')
  const line = (type: string, ts: string, content: unknown) =>
    JSON.stringify({ type, timestamp: ts, message: { role: type, content } })
  await writeFile(
    file,
    [
      line('user', '2026-01-01T00:00:00Z', block('old', 'x')),
      line('assistant', '2026-01-02T00:00:00Z', [{ type: 'text', text: block('fake', 'y') }]),
      line('user', '2026-01-02T00:00:01Z', [{ type: 'text', text: block('a1', 'ALPHA') }]),
      line('user', '2026-01-02T00:00:02Z', 'just a prompt'),
    ].join('\n'),
  )
  assert.deepEqual(
    taskNotificationsFromTranscript(file, Date.parse('2026-01-02T00:00:00Z')).map((n) => n.taskId),
    ['a1'],
  )
  assert.deepEqual(
    taskNotificationsFromTranscript(file).map((n) => n.taskId),
    ['old', 'a1'],
  )
  await rm(dir, { recursive: true, force: true })
})

function toolResults(
  events: RuntimeEvent[],
): Array<Extract<RuntimeEvent, { type: 'tool_result' }>> {
  return events.filter(
    (event): event is Extract<RuntimeEvent, { type: 'tool_result' }> =>
      event.type === 'tool_result',
  )
}

test('jinn-pty runtime: async sub-agents keep the turn open until their results are answered', async () => {
  const h = await harness()
  try {
    const startedAt = Date.now()
    await h.run(turnContext({ prompt: 'ASYNC fan out', sandboxMode: 'danger-full-access' }))
    const durationMs = Date.now() - startedAt
    const toolUses = h.events.filter((event) => event.type === 'tool_use')
    assert.equal(toolUses.length, 2)
    assert.ok(toolUses.every((event) => event.type === 'tool_use' && event.toolName === 'Agent'))
    const results = toolResults(h.events)
    assert.equal(results.length, 2, 'one tool_result per sub-agent, none for async_launched')
    assert.ok(results.every((event) => !String(event.content).includes('async_launched')))
    assert.match(String(results[0]?.content), /^ALPHA\n\nagentId: a[0-9a-f]{16}$/)
    assert.match(String(results[1]?.content), /^BRAVO\n\nagentId: a[0-9a-f]{16}$/)
    assert.ok(results.every((event) => !event.isError))
    assert.equal(
      results[0]?.toolUseId,
      toolUses[0] && toolUses[0].type === 'tool_use' ? toolUses[0].toolUseId : null,
      'the result closes the launching tool call',
    )
    const completions = h.events.filter((event) => event.type === 'completed')
    assert.equal(completions.length, 1, 'the intermediate Stops did not complete the turn')
    const done = completed(h.events)
    assert.equal(done.success, true)
    assert.equal(done.result, 'A=ALPHA B=BRAVO')
    assert.equal(text(h.events), 'A=ALPHA B=BRAVO')
    const lastResult = results[1]
    assert.ok(lastResult && h.events.indexOf(lastResult) < h.events.indexOf(done))
    assert.ok(durationMs < 8000, `completed as soon as the last answer arrived (${durationMs}ms)`)

    // The warm PTY takes an ordinary turn afterwards.
    h.events = []
    await h.run(turnContext({ turnId: 'turn-2', prompt: 'Reply with exactly the word PONG2' }))
    assert.equal(completed(h.events).result, 'PONG:Reply with exactly the word PONG2')
    assert.equal(toolResults(h.events).length, 0)
  } finally {
    await h.close()
  }
})

test('jinn-pty runtime: async results consumed mid-turn complete on the first Stop', async () => {
  const h = await harness()
  try {
    const startedAt = Date.now()
    await h.run(turnContext({ prompt: 'ASYNC_INLINE fan out', sandboxMode: 'danger-full-access' }))
    const durationMs = Date.now() - startedAt
    assert.equal(completed(h.events).result, 'A=ALPHA B=BRAVO')
    assert.equal(toolResults(h.events).length, 2)
    assert.ok(durationMs < 4000, `no notification grace was waited (${durationMs}ms)`)
  } finally {
    await h.close()
  }
})

test('jinn-pty runtime: a sub-agent that never stops times out with a placeholder result', async () => {
  const h = await harness({ asyncSubagentTimeoutMs: 1500 })
  try {
    await h.run(turnContext({ prompt: 'ASYNC_LOST fan out', sandboxMode: 'danger-full-access' }))
    const results = toolResults(h.events)
    assert.equal(results.length, 2)
    assert.match(String(results[0]?.content), /^ALPHA/)
    assert.equal(results[0]?.isError, false)
    assert.match(String(results[1]?.content), /did not report back within 1500ms/)
    assert.equal(results[1]?.isError, true)
    const done = completed(h.events)
    assert.equal(done.success, true)
    assert.equal(done.result, 'Got ALPHA, waiting for BRAVO')
  } finally {
    await h.close()
  }
})
