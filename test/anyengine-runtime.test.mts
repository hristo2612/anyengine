import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { createRuntime } from '../src/runtime-factory.mjs'
import { preparationGate, preparationHarness } from './helpers/pty-preparation.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

import { asToolResultHook, defaultStateDir } from '../src/anyengine-hooks.mjs'
import {
  CompactionStreamGate,
  MAIN_AGENT_SENTINEL,
  SsePtyProxy,
  type SseStreamInfo,
  type StreamDelta,
  sseEventToDeltas,
} from '../src/anyengine-proxy.mjs'
import {
  AnyengineRuntime,
  type AnyengineRuntimeOptions,
  asyncLaunch,
  buildInteractiveArgs,
  isNativeClaudeCommand,
  shapeToolResult,
  streamIsCurrent,
} from '../src/anyengine-runtime.mjs'
import {
  chooseApproval,
  composerReady,
  keystrokesToSelect,
  parsePermissionPrompt,
  parseStartupPrompt,
} from '../src/anyengine-screen.mjs'
import {
  lastAssistantTextFromTranscript,
  parseTaskNotifications,
  sanitizeAssistantText,
  taskNotificationsFromTranscript,
} from '../src/anyengine-transcript.mjs'
import { registerSandboxUpstream } from '../src/bridge-exec.mjs'
import { projectBaseline } from '../src/claude-project-guard.mjs'
import { DEFAULT_POSTURE, type Posture } from '../src/posture.mjs'
import {
  claudeLaunchFor,
  claudeSpawnKey,
  PROJECT_CONFIG_NOTICE,
  relayDecision,
  SHELL_OFF_NO_SANDBOX,
} from '../src/posture-claude.mjs'
import { resolveRuntimeConfig } from '../src/runtime-config.mjs'
import type { PermissionDecision, RuntimeEvent, RuntimeTurnContext } from '../src/types.mjs'

const FAKE_CLAUDE = resolve('test/fixtures/fake-claude.mjs')
const RELAY = resolve('scripts/anyengine-hook-relay.mjs')

function turnContext(overrides: Partial<RuntimeTurnContext> = {}): RuntimeTurnContext {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    prompt: 'hello',
    cwd: process.cwd(),
    runtimeType: 'anyengine',
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
  runtime: AnyengineRuntime
  dir: string
  argsFile: string
  events: RuntimeEvent[]
  permissionRequests: Array<Extract<RuntimeEvent, { type: 'permission_request' }>>
  decision: PermissionDecision
  run(context: RuntimeTurnContext): Promise<void>
  close(): Promise<void>
}

async function harness(
  overrides: Partial<AnyengineRuntimeOptions> = {},
  env: Record<string, string> = {},
): Promise<Harness> {
  const dir = await tempDir('anyengine-pty-')
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
  const runtime = new AnyengineRuntime({
    cli: FAKE_CLAUDE,
    cols: 100,
    rows: 30,
    turnTimeoutMs: 20_000,
    asyncSubagentTimeoutMs: 60_000,
    startupTimeoutMs: 10_000,
    streamProxy: false,
    extraArgs: ['--fixture-env', JSON.stringify(applied)],
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

test('runtime config resolves anyengine and its aliases', () => {
  assert.equal(resolveRuntimeConfig({ ANYENGINE_RUNTIME_TYPE: 'anyengine' }).type, 'anyengine')
  assert.equal(resolveRuntimeConfig({ ANYENGINE_RUNTIME_TYPE: 'pty' }).type, 'anyengine')
  assert.equal(resolveRuntimeConfig({ ANYENGINE_RUNTIME_TYPE: 'claude-pty' }).type, 'anyengine')
  const config = resolveRuntimeConfig({
    ANYENGINE_RUNTIME_TYPE: 'anyengine',
    ANYENGINE_CLI: '/opt/bin/claude',
    ANYENGINE_PTY_COLS: '150',
    ANYENGINE_PTY_ROWS: '50',
    ANYENGINE_PTY_TURN_TIMEOUT_MS: '1234',
    ANYENGINE_PTY_STREAM_PROXY: '0',
  })
  assert.equal(config.anyengine.cli, '/opt/bin/claude')
  assert.equal(config.anyengine.cols, 150)
  assert.equal(config.anyengine.rows, 50)
  assert.equal(config.anyengine.turnTimeoutMs, 1234)
  assert.equal(config.anyengine.streamProxy, false)
  assert.equal(resolveRuntimeConfig({}).anyengine.streamProxy, true)
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
  // ExitPlanMode is a dialog no hook answers, so a plan mode Claude entered
  // on its own could never be left: EnterPlanMode is off at every launch.
  // A read-only thread with no codex child to sandbox a command has no shell.
  const disallowed = fresh.slice(
    fresh.indexOf('--disallowedTools') + 1,
    fresh.indexOf('--append-system-prompt'),
  )
  assert.deepEqual(disallowed, [
    'AskUserQuestion',
    'ExitPlanMode',
    'EnterPlanMode',
    'Bash',
    'Monitor',
  ])
})

test('asToolResultHook: a failed call reads as an error result, for Bash and any other tool', () => {
  const failed = asToolResultHook({
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    error: 'exit 1: boom',
  })
  assert.equal(failed.hook_event_name, 'PostToolUse')
  const error = { content: 'exit 1: boom', isError: true }
  assert.deepEqual(shapeToolResult('Bash', failed.tool_response), error)
  assert.deepEqual(shapeToolResult('mcp__anyengine__exec', failed.tool_response), error)
  const ok = { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'x' }
  assert.equal(asToolResultHook(ok), ok)
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
    composerReady([
      '▐▛███▛█   Claude Code v2.1.263',
      '─'.repeat(70),
      '❯ ',
      '─'.repeat(70),
      '  ⏸ manual mode on · ? for shortcuts',
    ]),
    true,
  )
  assert.equal(parseStartupPrompt(['❯ ', '  ? for shortcuts']), null)
})

test('transcript helpers pick the last assistant text of the turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anyengine-transcript-'))
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

test('anyengine runtime: turn, warm-PTY permission round-trip, deny and full access', async () => {
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

    // Second turn reuses the warm PTY: a write outside the thread's bounds
    // needs the App's approval.
    h.events = []
    const outside = join(h.dir, 'out.txt')
    await h.run(turnContext({ turnId: 'turn-2', prompt: `WRITE ${outside}` }))
    assert.equal(h.permissionRequests.length, 1)
    assert.equal(h.permissionRequests[0]?.toolName, 'Write')
    assert.equal(h.permissionRequests[0]?.input.file_path, outside)
    const toolUse = h.events.find((event) => event.type === 'tool_use')
    assert.ok(toolUse && toolUse.type === 'tool_use')
    assert.equal(toolUse.toolName, 'Write')
    const toolResult = h.events.find((event) => event.type === 'tool_result')
    assert.ok(toolResult && toolResult.type === 'tool_result')
    assert.equal(toolResult.toolUseId, toolUse.toolUseId)
    assert.equal(toolResult.content, '{"ok":true}')
    assert.equal(text(h.events), `wrote: ${outside}`)
    const spawns = (await readFile(h.argsFile, 'utf8')).trim().split('\n')
    assert.equal(spawns.length, 1, 'warm PTY reused, no respawn')
    const args = JSON.parse(spawns[0] ?? '[]') as string[]
    assert.ok(!args.includes('--resume'))
    assert.ok(args.includes('--settings'))
    assert.equal(args[args.indexOf('--append-system-prompt') + 1], MAIN_AGENT_SENTINEL)
    // No codex child sandboxes a command here, so the session has no Bash.
    const disallowed = args.slice(
      args.indexOf('--disallowedTools') + 1,
      args.indexOf('--append-system-prompt'),
    )
    assert.ok(disallowed.includes('Bash'))

    // Declined approval reaches Claude as a deny with a reason.
    h.events = []
    h.permissionRequests = []
    h.decision = { decision: 'decline' }
    await h.run(turnContext({ turnId: 'turn-3', prompt: `WRITE ${join(h.dir, 'nope.txt')}` }))
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

test('anyengine runtime: resume args, transcript fallback and model change respawn', async () => {
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

test('anyengine runtime: trust dialog is answered before the first prompt', async () => {
  const h = await harness({}, { FAKE_CLAUDE_TRUST_PROMPT: '1' })
  try {
    await h.run(turnContext({ prompt: 'trusted?' }))
    assert.equal(text(h.events), 'PONG:trusted?')
  } finally {
    await h.close()
  }
})

// Workspace-write on the cwd alone (temp dirs excluded), asking by default.
const CWD_ONLY: Posture = {
  ...DEFAULT_POSTURE,
  fileSystem: {
    kind: 'workspace-write',
    writableRoots: [],
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  },
}

test('anyengine runtime: under never + workspace-write the bounds decide and nothing asks', async () => {
  const h = await harness()
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'anyengine-ws-')))
  const posture: Posture = { ...CWD_ONLY, approval: 'never' }
  const turn = (turnId: string, prompt: string) =>
    h.run(turnContext({ turnId, cwd, posture, prompt }))
  try {
    await turn('turn-1', `WRITE ${join(cwd, 'inside.txt')}`)
    assert.equal(text(h.events), `wrote: ${join(cwd, 'inside.txt')}`)
    h.events = []
    await turn('turn-2', `WRITE ${join(dirname(cwd), 'outside.txt')}`)
    assert.match(
      text(h.events),
      /^denied: blocked by this thread's sandbox \(workspace-write, network off, never\)/,
    )
    h.events = []
    await turn('turn-3', `WRITE ${join(cwd, '.git', 'config')}`)
    assert.match(text(h.events), /^denied: blocked/)
    h.events = []
    // No codex child sandboxes a command here, so the shell is off.
    await turn('turn-4', 'Run echo hi')
    assert.match(text(h.events), /^denied: /)
    assert.ok(text(h.events).includes(SHELL_OFF_NO_SANDBOX))
    assert.equal(h.permissionRequests.length, 0, 'never asks the app')
  } finally {
    await h.close()
    await rm(cwd, { recursive: true, force: true })
  }
})

// Claude's own configuration runs outside every sandbox once a Claude child
// starts in that directory (project hooks, statusLine, MCP servers), so the
// relay never lets a write reach it; talking to the user and the session's
// own task list touch nothing and run under any posture.
test('relay: Claude config is never written unattended, conversation-only tools run', async () => {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'anyengine-ws-')))
  const never: Posture = { ...CWD_ONLY, approval: 'never' }
  const verdict = (posture: Posture, tool: string, input: Record<string, unknown>) =>
    relayDecision(turnContext({ cwd, posture }), tool, input).verdict
  try {
    const config = [
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.mcp.json',
      '.CLAUDE/settings.json',
      '.Mcp.Json',
    ]
    for (const path of config) {
      const input = { file_path: join(cwd, path), content: '{}' }
      assert.equal(verdict(never, 'Write', input), 'deny', `never: ${path}`)
      assert.equal(verdict(CWD_ONLY, 'Edit', input), 'ask', `on-request: ${path}`)
    }
    // The relay's own per-spawn hooks and MCP config (~/.anyengine/pty).
    for (const path of ['.anyengine/pty/1/settings-x.json', '.AnyEngine/lib/current']) {
      assert.equal(verdict(never, 'Write', { file_path: join(cwd, path) }), 'deny', path)
    }
    assert.equal(verdict(never, 'Write', { file_path: join(cwd, 'notes.md') }), 'allow')
    for (const tool of ['ScheduleWakeup', 'TaskCreate', 'TaskUpdate', 'EnterPlanMode']) {
      assert.equal(verdict(never, tool, { prompt: 'check back' }), 'allow', tool)
    }
    assert.equal(verdict(never, 'TaskStop', { task_id: 'x' }), 'deny', 'a process is not inert')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

// Each spawn's --settings (the relay hooks) and --mcp-config load whatever
// --setting-sources says, so they live outside every default writable root
// ($TMPDIR is one) in a directory only the user can enter.
test('anyengine runtime: the relay state dir is ~/.anyengine/pty/<pid>, 0700, removed at stop', async () => {
  const home = process.env.HOME
  process.env.HOME = '/home/tester'
  try {
    const dir = defaultStateDir()
    assert.equal(dir, join('/home/tester', '.anyengine', 'pty', String(process.pid)))
    assert.ok(!dir.startsWith(tmpdir()), 'not under $TMPDIR')
  } finally {
    process.env.HOME = home
  }
  // Created for real under the suite's own HOME.
  const stateDir = defaultStateDir()
  assert.equal(stateDir, join(homedir(), '.anyengine', 'pty', String(process.pid)))
  const h = await harness({ stateDir })
  try {
    await h.run(turnContext({ prompt: 'hi' }))
    assert.equal(statSync(stateDir).mode & 0o777, 0o700)
  } finally {
    await h.close()
  }
  assert.equal(existsSync(stateDir), false, 'the per-pid dir goes with the runtime')
})

// Workspace trust is answered at startup, so a warm PTY cannot carry a thread
// that has since stopped trusting the project.
test('spawn key: a change of trust respawns the PTY', () => {
  const trusted = turnContext({ posture: CWD_ONLY })
  const untrusted = turnContext({ posture: { ...CWD_ONLY, trust: 'untrusted' } })
  assert.equal(claudeSpawnKey(trusted), claudeSpawnKey(turnContext({ posture: CWD_ONLY })))
  assert.notEqual(claudeSpawnKey(trusted), claudeSpawnKey(untrusted))
})

// Project Claude config written during the session (by any sandboxed writer)
// must not reach a fresh Claude: the launch compares it with the thread's
// baseline and, on a mismatch, loads the user's settings alone.
test('anyengine runtime: changed project config isolates the next launch, the original matches', async () => {
  const h = await harness()
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'anyengine-ws-')))
  const settings = join(cwd, '.claude', 'settings.json')
  await mkdir(dirname(settings))
  await writeFile(settings, '{}')
  const mcpServers = { other: { type: 'stdio', command: process.execPath, args: [] } }
  const posture: Posture = { ...CWD_ONLY, projectBaseline: projectBaseline(cwd) }
  const context = (turnId: string) => turnContext({ turnId, cwd, posture, mcpServers })
  const spawns = async () =>
    (await readFile(h.argsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
  const notices = () =>
    h.events.filter((e) => e.type === 'notice' && e.message.includes(PROJECT_CONFIG_NOTICE))
  try {
    const matching = claudeSpawnKey(context('turn-1'))
    await h.run(context('turn-1'))
    let args = (await spawns()).at(-1) ?? []
    assert.ok(!args.includes('--setting-sources'), 'unchanged config launches normally')
    assert.equal(notices().length, 0)

    await writeFile(settings, '{"hooks":{"SessionStart":[]}}')
    assert.notEqual(claudeSpawnKey(context('turn-2')), matching, 'a mismatch changes the key')
    await h.run(context('turn-2'))
    assert.equal((await spawns()).length, 2, 'the warm PTY does not outlive the change')
    args = (await spawns()).at(-1) ?? []
    const at = args.indexOf('--setting-sources')
    assert.deepEqual(args.slice(at, at + 3), ['--setting-sources', 'user', '--strict-mcp-config'])
    assert.ok(args.includes('--settings') && args.includes('--mcp-config'), 'relay and MCP kept')
    assert.equal(notices().length, 1, 'one visible line in the thread')

    await writeFile(settings, '{}')
    h.events = []
    await h.run(context('turn-3'))
    assert.equal((await spawns()).length, 3)
    assert.ok(!(await spawns()).at(-1)?.includes('--setting-sources'), 'original bytes match')
    assert.equal(notices().length, 0)
  } finally {
    await h.close()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('project config: no baseline fails closed; unrestricted and trusted is exempt', async () => {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'anyengine-ws-')))
  const launch = (posture: Posture) => claudeLaunchFor(turnContext({ cwd, posture }))
  const full: Posture = { ...DEFAULT_POSTURE, fileSystem: { kind: 'full-access' }, network: true }
  try {
    assert.equal(launch(CWD_ONLY).settingSources, 'user', 'no baseline is a mismatch')
    assert.equal(launch(CWD_ONLY).notice, `${PROJECT_CONFIG_NOTICE} ${SHELL_OFF_NO_SANDBOX}`)
    assert.equal(launch(full).settingSources, null, 'unrestricted and trusted')
    assert.equal(launch({ ...full, trust: 'untrusted' }).settingSources, 'user')
    const baselined = { ...CWD_ONLY, projectBaseline: projectBaseline(cwd) }
    assert.equal(launch(baselined).settingSources, null)
    assert.equal(launch({ ...baselined, trust: 'untrusted' }).settingSources, null)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('anyengine runtime: in-bounds writes run, out-of-bounds writes ask the app', async () => {
  const h = await harness()
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'anyengine-ws-')))
  try {
    await h.run(turnContext({ cwd, posture: CWD_ONLY, prompt: `WRITE ${join(cwd, 'a.txt')}` }))
    assert.equal(h.permissionRequests.length, 0)
    h.events = []
    const outside = join(dirname(cwd), 'b.txt')
    await h.run(
      turnContext({ turnId: 'turn-2', cwd, posture: CWD_ONLY, prompt: `WRITE ${outside}` }),
    )
    assert.equal(h.permissionRequests.length, 1)
    assert.equal(h.permissionRequests[0]?.toolName, 'Write')
    assert.equal(text(h.events), `wrote: ${outside}`)
  } finally {
    await h.close()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('anyengine runtime: a parent that does not trust the project gets no trusted child', async () => {
  const h = await harness({}, { FAKE_CLAUDE_TRUST_PROMPT: '1' })
  try {
    await assert.rejects(
      h.run(turnContext({ posture: { ...DEFAULT_POSTURE, trust: 'untrusted' }, prompt: 'hi' })),
      /does not trust this project/,
    )
    // The PTY parked on the dialog is let go, so the next turn is refused the
    // same way instead of typing into the dialog.
    await assert.rejects(
      h.run(
        turnContext({
          turnId: 'turn-2',
          posture: { ...DEFAULT_POSTURE, trust: 'untrusted' },
          prompt: 'again',
        }),
      ),
      /does not trust this project/,
    )
  } finally {
    await h.close()
  }
})

test('anyengine runtime: with a sandbox, shell goes through exec and Bash is off', async () => {
  registerSandboxUpstream({ running: true, request: async () => ({}) })
  const h = await harness()
  const mcpServers = { anyengine: { type: 'stdio', command: process.execPath, args: [] } }
  try {
    await h.run(turnContext({ posture: CWD_ONLY, mcpServers, prompt: 'EXEC ls' }))
    assert.equal(text(h.events), 'exec: allowed')
    assert.equal(h.permissionRequests.length, 0, 'a sandboxed command needs no card')
    let spawns = (await readFile(h.argsFile, 'utf8')).trim().split('\n')
    const args = JSON.parse(spawns[0] ?? '[]') as string[]
    assert.deepEqual(
      args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--append-system-prompt')),
      ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'Bash', 'Monitor'],
    )
    // Full access has nothing to bound, so Bash comes back; the tool list binds
    // at spawn, so the PTY is respawned.
    h.events = []
    const full: Posture = { ...CWD_ONLY, fileSystem: { kind: 'full-access' }, network: true }
    await h.run(turnContext({ turnId: 'turn-2', posture: full, mcpServers, prompt: 'Run echo hi' }))
    assert.equal(text(h.events), 'ran: hi')
    spawns = (await readFile(h.argsFile, 'utf8')).trim().split('\n')
    assert.equal(spawns.length, 2, 'the launch changed, so the PTY was respawned')
  } finally {
    registerSandboxUpstream(null)
    await h.close()
  }
})

// A failed call (exec's error, a failing command) arrives as
// PostToolUseFailure; its item completes with the error instead of staying
// in progress.
test('anyengine runtime: a failed tool call completes its item with the error', async () => {
  const h = await harness()
  try {
    await h.run(turnContext({ posture: CWD_ONLY, prompt: 'EXECFAIL ls' }))
    assert.equal(text(h.events), 'exec: failed')
    const toolUse = h.events.find((event) => event.type === 'tool_use')
    assert.ok(toolUse && toolUse.type === 'tool_use')
    assert.equal(toolUse.toolName, 'mcp__anyengine__exec')
    const toolResult = h.events.find((event) => event.type === 'tool_result')
    assert.ok(toolResult && toolResult.type === 'tool_result', 'the call completed')
    assert.equal(toolResult.toolUseId, toolUse.toolUseId)
    assert.equal(toolResult.isError, true)
    assert.equal(toolResult.content, 'exit 1: boom')
  } finally {
    await h.close()
  }
})

// A call completes once: a second report for it (here a late failure after
// its result) must not complete its item again.
test('anyengine runtime: a tool call that is reported twice completes once', async () => {
  const h = await harness()
  try {
    await h.run(turnContext({ posture: CWD_ONLY, prompt: 'EXECTWICE ls' }))
    assert.equal(text(h.events), 'exec: twice')
    const results = h.events.filter((event) => event.type === 'tool_result')
    assert.equal(results.length, 1, 'one result for one call')
    const [result] = results
    assert.ok(result && result.type === 'tool_result')
    assert.equal(result.isError, false)
    assert.equal(result.content, 'exit 0: ok')
  } finally {
    await h.close()
  }
})

test('anyengine runtime: safety prompt falls back to keystrokes consistent with the approval', async () => {
  const h = await harness()
  // Bash is asked about only where it is on at all: full access, here with
  // an approval mode that asks before every command.
  const asks: Posture = {
    ...DEFAULT_POSTURE,
    fileSystem: { kind: 'full-access' },
    network: true,
    approval: 'untrusted',
  }
  try {
    await h.run(turnContext({ posture: asks, prompt: 'do the SAFETY thing' }))
    assert.equal(h.permissionRequests.length, 1)
    assert.equal(text(h.events), 'safety approved')
    h.events = []
    h.decision = { decision: 'decline' }
    await h.run(
      turnContext({ turnId: 'turn-2', posture: asks, prompt: 'do the SAFETY thing again' }),
    )
    assert.equal(text(h.events), 'safety rejected')
    // A bounded thread with no codex child has no shell: the relay refused
    // the call, so its safety prompt is rejected without a card.
    h.events = []
    h.permissionRequests = []
    h.decision = { decision: 'accept' }
    await h.run(turnContext({ turnId: 'turn-3', prompt: 'do the SAFETY thing once more' }))
    assert.equal(h.permissionRequests.length, 0)
    assert.equal(text(h.events), 'safety rejected')
  } finally {
    await h.close()
  }
})

test('anyengine runtime: StopFailure fails the turn, interrupt settles it, stop kills the PTY', async () => {
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

test('anyengine runtime: a stale --resume id falls back to a fresh session', async () => {
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
  const dir = await mkdtemp(join(tmpdir(), 'anyengine-notify-'))
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

test('anyengine runtime: async sub-agents keep the turn open until their results are answered', async () => {
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

test('anyengine runtime: async results consumed mid-turn complete on the first Stop', async () => {
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

// The window has to hold agent A's report: two 300 ms sleeps in the fake plus
// a node start-up per hook relay, which a loaded machine stretches past a
// second. 1500 ms failed that way (a suite run at twice its usual length);
// 5000 ms leaves the margin and still times B out.
test('anyengine runtime: a sub-agent that never stops times out with a placeholder result', async () => {
  const h = await harness({ asyncSubagentTimeoutMs: 5000 })
  try {
    await h.run(turnContext({ prompt: 'ASYNC_LOST fan out', sandboxMode: 'danger-full-access' }))
    const results = toolResults(h.events)
    assert.equal(results.length, 2)
    assert.match(String(results[0]?.content), /^ALPHA/)
    assert.equal(results[0]?.isError, false)
    assert.match(String(results[1]?.content), /did not report back within 5000ms/)
    assert.equal(results[1]?.isError, true)
    const done = completed(h.events)
    assert.equal(done.success, true)
    assert.equal(done.result, 'Got ALPHA, waiting for BRAVO')
  } finally {
    await h.close()
  }
})

test('runtime release reaches the backend after its completed turn', async () => {
  const runtime = createRuntime()
  const released: string[] = []
  Object.defineProperty(MockRuntime.prototype, 'release', {
    configurable: true,
    value: async (id: string) => {
      released.push(id)
    },
  })
  try {
    await runtime.runTurn(turnContext({ runtimeType: 'mock', prompt: 'hello' }), {
      onEvent: () => {},
      onPermissionRequest: async () => ({ decision: 'decline' }),
    })
    assert.ok(runtime.release)
    await runtime.release('thread-1')
    assert.deepEqual(released, ['thread-1'])
  } finally {
    await runtime.stop()
    Reflect.deleteProperty(MockRuntime.prototype, 'release')
  }
})

test('anyengine release leaves an active turn alone, kills an idle PTY and resumes cold', async () => {
  const h = await harness()
  try {
    await h.run(turnContext())
    const first = h.runtime.livePids()[0]!
    const session = h.events.find((e) => e.type === 'session')
    assert.ok(session?.type === 'session')
    h.events = []
    const running = h.run(
      turnContext({ turnId: 'slow', prompt: 'be SLOW', claudeSessionId: session.claudeSessionId }),
    )
    for (
      const until = Date.now() + 30_000;
      !h.events.some((e) => e.type === 'session') && Date.now() < until;
    ) {
      await new Promise((ok) => setTimeout(ok, 10))
    }
    assert.ok(h.events.some((e) => e.type === 'session'))
    await h.runtime.release('thread-1')
    assert.deepEqual(h.runtime.livePids(), [first])
    await h.runtime.interrupt('thread-1')
    await running
    await h.runtime.release('thread-1')
    assert.deepEqual(h.runtime.livePids(), [])
    for (const until = Date.now() + 30_000; Date.now() < until; ) {
      try {
        process.kill(first, 0)
      } catch {
        break
      }
      await new Promise((ok) => setTimeout(ok, 20))
    }
    assert.throws(() => process.kill(first, 0))
    await h.run(turnContext({ turnId: 'cold', claudeSessionId: session.claudeSessionId }))
    assert.notEqual(h.runtime.livePids()[0], first)
    const lines = (await readFile(h.argsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.ok(JSON.stringify(lines.at(-1)).includes(session.claudeSessionId))
  } finally {
    await h.close()
  }
})

for (const phase of ['hooks', 'proxy'] as const) {
  test(`anyengine cancellation: interrupt during ${phase} preparation prevents a late PTY without SessionStart`, async (t) => {
    const h = await preparationHarness(t, phase)
    const running = h.runtime
      .runTurn(turnContext({ cwd: h.dir }), {
        onEvent: () => {},
        onPermissionRequest: async () => ({ decision: 'decline' }),
      })
      .catch(() => {})
    try {
      await h.entered.promise
      await h.runtime.interrupt('thread-1')
      h.resume.resolve()
      await Promise.race([running, h.spawned.promise])
      assert.equal(h.starts, 0, 'interrupt was lost before active-turn registration')
      assert.equal(h.runtime.hasLivePtys(), false)
      if (phase === 'proxy') assert.equal(h.listening, false)
    } finally {
      h.resume.resolve()
      await h.runtime.stop()
      await running
    }
    assert.equal(h.alive, 0)
    assert.ok(!h.writes.some((s) => s.includes('\x1b[200~') || s === '\r'))
  })
}

test('anyengine cancellation: stop joins pending preparation and leaves no late hooks or PTY', async (t) => {
  const h = await preparationHarness(t, 'hooks')
  const running = h.runtime
    .runTurn(turnContext({ cwd: h.dir }), {
      onEvent: () => {},
      onPermissionRequest: async () => ({ decision: 'decline' }),
    })
    .catch(() => {})
  await h.entered.promise
  let stopped = false
  const stopping = h.runtime.stop().then(() => {
    stopped = true
  })
  try {
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(stopped, false, 'stop returned while hook preparation could resume')
  } finally {
    h.resume.resolve()
    await Promise.race([running, h.spawned.promise])
    await h.runtime.stop()
    await stopping
    await running
  }
  assert.equal(h.starts, 0)
  assert.equal(h.alive, 0)
  assert.equal(h.listening, false)
})

test('anyengine cancellation: interruption during the launch notice cannot register or submit a turn', async (t) => {
  const h = await preparationHarness(t)
  const entered = preparationGate()
  const resume = preparationGate()
  const context = turnContext({
    cwd: h.dir,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
  })
  assert.ok(claudeLaunchFor(context).notice, 'fixture must exercise the launch-notice checkpoint')
  const running = h.runtime
    .runTurn(context, {
      onEvent: async (event) => {
        if (event.type === 'notice') {
          entered.resolve()
          await resume.promise
        }
      },
      onPermissionRequest: async () => ({ decision: 'decline' }),
    })
    .catch(() => {})
  try {
    await entered.promise
    await h.runtime.interrupt('thread-1')
    resume.resolve()
    await Promise.race([running, h.wrote.promise])
    assert.ok(
      !h.writes.some((s) => s.includes('\x1b[200~')),
      'cancelled preparation pasted a prompt',
    )
    assert.equal(h.alive, 0, 'cancelled cold preparation left its PTY alive')
  } finally {
    resume.resolve()
    await h.runtime.stop()
    await running
  }
})
