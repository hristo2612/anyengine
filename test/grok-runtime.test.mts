import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  buildGrokAgentArgs,
  grokAgentSpec,
  grokPermissionOutcome,
  grokSessionIdFrom,
  grokToolName,
  grokUpdateToEvents,
  grokUsageFromPromptResult,
  isGrokModel,
} from '../src/grok-acp.mjs'
import {
  grokModelDisplayName,
  grokModelOptions,
  parseGrokModelsOutput,
} from '../src/grok-models.mjs'
import { GrokRuntime } from '../src/grok-runtime.mjs'
import type { PermissionDecision, RuntimeEvent, RuntimeTurnContext } from '../src/types.mjs'

const fakeGrok = resolve('test/fixtures/fake-grok.mjs')
const adapter = resolve('dist/src/adapter.mjs')

function turnContext(overrides: Partial<RuntimeTurnContext> = {}): RuntimeTurnContext {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    prompt: 'Reply with exactly the word PONG',
    cwd: process.cwd(),
    runtimeType: 'grok',
    model: 'grok-4.6',
    effort: null,
    claudeSessionId: null,
    forkSession: false,
    mcpServers: null,
    allowedTools: null,
    addDirs: [],
    enableFileCheckpointing: false,
    outputFormat: null,
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    systemPromptAddendum: null,
    planMode: false,
    imageInputs: [],
    ...overrides,
  }
}

interface Harness {
  runtime: GrokRuntime
  events: RuntimeEvent[]
  permissions: Array<Extract<RuntimeEvent, { type: 'permission_request' }>>
  decision: PermissionDecision
  argsFile: string
  eventsFile: string
  home: string
  run(context: RuntimeTurnContext): Promise<void>
  fakeEvents(): Promise<any[]>
  argv(): Promise<string[][]>
  cleanup(): Promise<void>
}

async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-grok-test-'))
  const argsFile = join(home, 'args.jsonl')
  const eventsFile = join(home, 'events.jsonl')
  const previous: Record<string, string | undefined> = {}
  const applied = {
    FAKE_GROK_ARGS_FILE: argsFile,
    FAKE_GROK_EVENTS_FILE: eventsFile,
    ANYENGINE_DEBUG_LOG: join(home, 'debug.jsonl'),
    ...env,
  }
  for (const [key, value] of Object.entries(applied)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  const runtime = new GrokRuntime({
    binary: fakeGrok,
    extraArgs: [],
    turnTimeoutMs: 20_000,
    startupTimeoutMs: 10_000,
    idleExitMs: 0,
  })
  const h: Harness = {
    runtime,
    events: [],
    permissions: [],
    decision: { decision: 'accept' },
    argsFile,
    eventsFile,
    home,
    async run(context) {
      await runtime.runTurn(context, {
        onEvent: (event) => {
          h.events.push(event)
        },
        onPermissionRequest: async (event) => {
          h.permissions.push(event)
          return h.decision
        },
      })
    },
    async fakeEvents() {
      const raw = await readFile(eventsFile, 'utf8').catch(() => '')
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
    async argv() {
      const raw = await readFile(argsFile, 'utf8').catch(() => '')
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
    async cleanup() {
      await runtime.stop()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
    },
  }
  return h
}

test('grok helpers: model detection, session ids, argv, display names', () => {
  assert.equal(isGrokModel('grok-4.6'), true)
  assert.equal(isGrokModel('grok-code-fast-1'), true)
  assert.equal(isGrokModel('GROK-4.5'), true)
  assert.equal(isGrokModel('gpt-5.4-mini'), false)
  assert.equal(isGrokModel('sonnet'), false)
  assert.equal(isGrokModel(null), false)

  assert.equal(grokSessionIdFrom('grok:abc-123'), 'abc-123')
  assert.equal(grokSessionIdFrom('claude-p:abc'), null)
  assert.equal(grokSessionIdFrom('plain-uuid'), null)

  const spec = grokAgentSpec(
    turnContext({ model: 'grok-4.5', effort: 'high', sandboxMode: 'danger-full-access' }),
  )
  assert.deepEqual(buildGrokAgentArgs(spec, ['--debug']), [
    'agent',
    '--no-leader',
    '-m',
    'grok-4.5',
    '--reasoning-effort',
    'high',
    '--always-approve',
    '--debug',
    'stdio',
  ])
  assert.deepEqual(buildGrokAgentArgs(grokAgentSpec(turnContext({ model: 'sonnet' }))), [
    'agent',
    '--no-leader',
    'stdio',
  ])

  assert.equal(grokModelDisplayName('grok-4.6'), 'Grok 4.6')
  assert.equal(grokModelDisplayName('grok-code-fast-1'), 'Grok Code Fast 1')
  assert.deepEqual(
    parseGrokModelsOutput(
      'Default model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n',
    ),
    ['grok-4.6', 'grok-4.5'],
  )
  assert.deepEqual(
    grokModelOptions({ ANYENGINE_GROK_MODELS: 'grok-4.6, grok-4.5' }).map((m) => m.displayName),
    ['Grok 4.6', 'Grok 4.5'],
  )
  assert.deepEqual(
    grokModelOptions({
      ANYENGINE_GROK_MODELS: '["grok-4.6",{"id":"grok-4.5","displayName":"Grok Fast"}]',
    }).map((m) => [m.id, m.displayName]),
    [
      ['grok-4.6', 'Grok 4.6'],
      ['grok-4.5', 'Grok Fast'],
    ],
  )
  assert.deepEqual(grokModelOptions({ ANYENGINE_MOCK: '1', PATH: '' }), [])
  assert.deepEqual(
    grokModelOptions({ ANYENGINE_GROK_MODELS: 'grok-4.6', ANYENGINE_DISABLE_GROK: '1' }),
    [],
  )
})

test('grok helpers: tool names, permission outcomes, update mapping, usage', () => {
  assert.equal(grokToolName({ title: 'run_terminal_command' }), 'Bash')
  assert.equal(grokToolName({ title: 'write', _meta: { 'x.ai/tool': { name: 'write' } } }), 'Write')
  assert.equal(grokToolName({ rawInput: { variant: 'Bash' }, title: 'Execute `ls`' }), 'Bash')
  assert.equal(grokToolName({ title: 'read', _meta: { 'x.ai/tool': { name: 'read' } } }), 'Read')
  assert.equal(grokToolName({ title: 'mystery_tool' }), 'mystery_tool')

  const options = [
    { optionId: 'always-allow', kind: 'allow_always' },
    { optionId: 'allow-once', kind: 'allow_once' },
    { optionId: 'reject-once', kind: 'reject_once' },
    { optionId: 'reject-always', kind: 'reject_always' },
  ]
  assert.deepEqual(grokPermissionOutcome('accept', options), {
    outcome: 'selected',
    optionId: 'allow-once',
  })
  assert.deepEqual(grokPermissionOutcome('acceptForSession', options), {
    outcome: 'selected',
    optionId: 'always-allow',
  })
  assert.deepEqual(grokPermissionOutcome('decline', options), {
    outcome: 'selected',
    optionId: 'reject-once',
  })
  assert.deepEqual(grokPermissionOutcome('cancel', options), { outcome: 'cancelled' })

  const seen = new Map<string, string>()
  assert.deepEqual(
    grokUpdateToEvents(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PO' } },
      seen,
    ),
    [{ type: 'text_delta', delta: 'PO' }],
  )
  assert.deepEqual(
    grokUpdateToEvents(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } },
      seen,
    ),
    [{ type: 'reasoning_delta', delta: 'hm' }],
  )
  assert.deepEqual(
    grokUpdateToEvents(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'run_terminal_command',
        rawInput: { command: 'cat note.txt', description: 'read it' },
      },
      seen,
    ),
    [
      {
        type: 'tool_use',
        toolUseId: 'call-1',
        toolName: 'Bash',
        input: { command: 'cat note.txt', description: 'read it' },
      },
    ],
  )
  assert.deepEqual(
    grokUpdateToEvents(
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' },
      seen,
    ),
    [],
  )
  assert.deepEqual(
    grokUpdateToEvents(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'alpha\n' } }],
        rawOutput: { type: 'Bash', output_for_prompt: 'exit: 0\nalpha\n', exit_code: 0 },
      },
      seen,
    ),
    [{ type: 'tool_result', toolUseId: 'call-1', content: 'exit: 0\nalpha\n', isError: false }],
  )
  // A write tool reported straight through tool_call_update (pre-approved) still opens an item.
  assert.deepEqual(
    grokUpdateToEvents(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-2',
        status: 'completed',
        kind: 'edit',
        title: 'Write `/tmp/x`',
        rawInput: { file_path: '/tmp/x', content: 'hello' },
        _meta: { 'x.ai/tool': { name: 'write', read_only: false } },
        content: [{ type: 'diff', path: '/tmp/x', oldText: '', newText: 'hello' }],
      },
      seen,
    ),
    [
      {
        type: 'tool_use',
        toolUseId: 'call-2',
        toolName: 'Write',
        input: { file_path: '/tmp/x', content: 'hello' },
      },
      { type: 'tool_result', toolUseId: 'call-2', content: 'Updated /tmp/x', isError: false },
    ],
  )

  assert.deepEqual(
    grokUsageFromPromptResult({
      stopReason: 'end_turn',
      _meta: {
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cachedReadTokens: 4,
          reasoningTokens: 1,
          modelCalls: 2,
          apiDurationMs: 99,
        },
      },
    }),
    {
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 1,
      },
      metrics: { apiDurationMs: 99, numTurns: 2 },
    },
  )
  assert.deepEqual(grokUsageFromPromptResult({ stopReason: 'end_turn' }), {
    usage: null,
    metrics: null,
  })
})

test('grok runtime: fresh turn maps the agent stream and relays the App approval', async () => {
  const h = await harness()
  try {
    await h.run(
      turnContext({ prompt: 'Use a tool to run echo hi, then reply PONG', effort: 'high' }),
    )
    const types = h.events.map((event) => event.type)
    assert.deepEqual(types.slice(0, 1), ['session'])
    assert.equal((h.events[0] as any).claudeSessionId, 'grok:fake-grok-session-1')
    assert.ok(types.includes('reasoning_delta'))
    assert.ok(types.includes('tool_use'))
    assert.ok(types.includes('tool_result'))
    assert.ok(types.includes('usage'))
    assert.ok(types.includes('metrics'))
    const text = h.events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: 'text_delta' }> =>
          event.type === 'text_delta',
      )
      .map((event) => event.delta)
      .join('')
    assert.equal(text, 'PONG')
    const toolUse = h.events.find((event) => event.type === 'tool_use') as any
    assert.equal(toolUse.toolName, 'Bash')
    assert.equal(toolUse.input.command, 'echo hi')
    const toolResult = h.events.find((event) => event.type === 'tool_result') as any
    assert.equal(toolResult.toolUseId, toolUse.toolUseId)
    assert.match(String(toolResult.content), /hi/)
    // tool_use must reach the server before the approval is asked for it.
    assert.ok(types.indexOf('tool_use') < types.indexOf('tool_result'))
    assert.equal(h.permissions.length, 1)
    assert.equal(h.permissions[0]?.toolName, 'Bash')
    assert.equal(h.permissions[0]?.toolUseId, toolUse.toolUseId)
    const completed = h.events.at(-1) as any
    assert.equal(completed.type, 'completed')
    assert.equal(completed.success, true)
    assert.equal(completed.claudeSessionId, 'grok:fake-grok-session-1')
    const fake = await h.fakeEvents()
    const permission = fake.find((entry) => entry.kind === 'permission_response')
    assert.equal(permission.response.result.outcome.optionId, 'allow-once')
    const argv = await h.argv()
    assert.deepEqual(argv[0], [
      'agent',
      '--no-leader',
      '-m',
      'grok-4.6',
      '--reasoning-effort',
      'high',
      'stdio',
    ])
    const sessionNew = fake.find((entry) => entry.method === 'session/new')
    assert.equal(sessionNew.params.cwd, process.cwd())
  } finally {
    await h.cleanup()
  }
})

test('grok runtime: declined approval is relayed as reject_once', async () => {
  const h = await harness()
  try {
    h.decision = { decision: 'decline' }
    await h.run(turnContext({ prompt: 'Use a tool then reply' }))
    const fake = await h.fakeEvents()
    const permission = fake.find((entry) => entry.kind === 'permission_response')
    assert.equal(permission.response.result.outcome.optionId, 'reject-once')
    const toolResult = h.events.find((event) => event.type === 'tool_result') as any
    assert.equal(toolResult.isError, true)
    const text = h.events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: 'text_delta' }> =>
          event.type === 'text_delta',
      )
      .map((event) => event.delta)
      .join('')
    assert.equal(text, 'DECLINED')
  } finally {
    await h.cleanup()
  }
})

test('grok runtime: full access spawns --always-approve and never asks the App', async () => {
  const h = await harness()
  try {
    await h.run(
      turnContext({
        prompt: 'Use a tool then reply PONG',
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
      }),
    )
    assert.equal(h.permissions.length, 0)
    const argv = await h.argv()
    assert.ok(argv[0]?.includes('--always-approve'))
    assert.equal(
      h.events.some((event) => event.type === 'tool_use'),
      true,
    )
    const completed = h.events.at(-1) as any
    assert.equal(completed.success, true)
  } finally {
    await h.cleanup()
  }
})

test('grok runtime: resume loads the stored grok session and ignores the replay', async () => {
  const h = await harness()
  try {
    await h.run(
      turnContext({
        claudeSessionId: 'grok:previous-session-9',
        systemPromptAddendum: 'Always be terse.',
        cwd: h.home,
      }),
    )
    const fake = await h.fakeEvents()
    const load = fake.find((entry) => entry.method === 'session/load')
    assert.ok(load, 'session/load sent')
    assert.equal(load.params.sessionId, 'previous-session-9')
    assert.equal(load.params.cwd, h.home)
    assert.equal(
      fake.some((entry) => entry.method === 'session/new'),
      false,
    )
    assert.equal((h.events[0] as any).claudeSessionId, 'grok:previous-session-9')
    const text = h.events
      .filter(
        (event): event is Extract<RuntimeEvent, { type: 'text_delta' }> =>
          event.type === 'text_delta',
      )
      .map((event) => event.delta)
      .join('')
    assert.equal(text, 'PONG', 'replayed history must not be re-rendered')
    // The addendum only rides a FRESH session's first prompt; a resumed
    // session already carries it.
    const prompt = fake.find((entry) => entry.method === 'session/prompt')
    assert.equal(prompt.params.prompt[0].text, 'Reply with exactly the word PONG')

    // Second turn on the same thread reuses the warm process + session.
    h.events.length = 0
    await h.run(
      turnContext({ claudeSessionId: 'grok:previous-session-9', cwd: h.home, turnId: 'turn-2' }),
    )
    const argv = await h.argv()
    assert.equal(argv.length, 1, 'one grok process per thread')
    assert.equal((h.events.at(-1) as any).success, true)
  } finally {
    await h.cleanup()
  }
})

test('grok runtime: fresh session prepends the system prompt addendum once', async () => {
  const h = await harness()
  try {
    await h.run(turnContext({ systemPromptAddendum: 'Always be terse.' }))
    const fake = await h.fakeEvents()
    const prompt = fake.find((entry) => entry.method === 'session/prompt')
    assert.equal(
      prompt.params.prompt[0].text,
      'Always be terse.\n\n---\n\nReply with exactly the word PONG',
    )
  } finally {
    await h.cleanup()
  }
})

test('grok runtime: interrupt cancels the in-flight prompt', async () => {
  const h = await harness({ FAKE_GROK_SLOW_MS: '1500' })
  try {
    const turn = h.run(turnContext())
    await new Promise((resolve) => setTimeout(resolve, 400))
    await h.runtime.interrupt('thread-1')
    await turn
    const fake = await h.fakeEvents()
    assert.ok(fake.some((entry) => entry.method === 'session/cancel'))
    const completed = h.events.at(-1) as any
    assert.equal(completed.type, 'completed')
    assert.equal(completed.success, true)
    assert.equal(
      h.events.some((event) => event.type === 'text_delta'),
      false,
      'cancelled turn produced no answer text',
    )
  } finally {
    await h.cleanup()
  }
})

test('adapter routes a grok-* thread to the grok runtime and lists Grok models', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-grok-adapter-'))
  const argsFile = join(home, 'args.jsonl')
  const eventsFile = join(home, 'events.jsonl')
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      ANYENGINE_HOME: join(home, 'adapter-home'),
      ANYENGINE_DEBUG_LOG: join(home, 'debug.jsonl'),
      // Configured default is the mock runtime; the grok-* model must still
      // select the grok runtime per thread (mirrors gpt-* -> codex-proxy).
      ANYENGINE_RUNTIME_TYPE: 'mock',
      ANYENGINE_MOCK: '',
      ANYENGINE_DISABLE_CODEX_PROXY: '1',
      ANYENGINE_MODELS: 'sonnet',
      ANYENGINE_GROK_BIN: fakeGrok,
      ANYENGINE_GROK_MODELS: 'grok-4.6,grok-4.5',
      FAKE_GROK_ARGS_FILE: argsFile,
      FAKE_GROK_EVENTS_FILE: eventsFile,
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  const write = (message: Record<string, unknown>) =>
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  try {
    write({ id: 1, method: 'model/list', params: {} })
    const models = await reader.nextResponse(1)
    const grok = models.result.data.filter((entry: any) => entry.id.startsWith('grok'))
    assert.deepEqual(
      grok.map((entry: any) => [entry.id, entry.displayName]),
      [
        ['grok-4.6', 'Grok 4.6'],
        ['grok-4.5', 'Grok 4.5'],
      ],
    )

    write({ id: 2, method: 'config/read', params: {} })
    const config = await reader.nextResponse(2)
    assert.equal(config.result.config.model_providers.grok.name, 'Grok (xAI · forwarded)')

    write({
      id: 3,
      method: 'thread/start',
      params: {
        cwd: home,
        model: 'grok-4.5',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      },
    })
    const start = await reader.nextResponse(3)
    assert.equal(start.result.model, 'grok-4.5')
    const threadId = start.result.thread.id

    write({
      id: 4,
      method: 'turn/start',
      params: {
        threadId,
        input: [
          { type: 'text', text: 'Use a tool to run echo hi, then reply PONG', text_elements: [] },
        ],
      },
    })
    const turnStart = await reader.nextResponse(4)
    assert.equal(turnStart.result.turn.status, 'inProgress')

    let text = ''
    const commands: string[] = []
    let approvals = 0
    let turn: any = null
    for (let i = 0; i < 500 && !turn; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/agentMessage/delta') text += message.params.delta
      if (message.method === 'item/started' && message.params.item?.type === 'commandExecution')
        commands.push(message.params.item.command)
      if (message.method === 'item/commandExecution/requestApproval') {
        approvals += 1
        write({ id: message.id, result: { decision: 'accept' } })
      }
      if (message.method === 'turn/completed') turn = message.params.turn
    }
    assert.ok(turn, 'turn completed')
    assert.equal(turn.status, 'completed')
    assert.equal(text, 'PONG')
    assert.deepEqual(commands, ['echo hi'])
    assert.equal(approvals, 1, 'Bash approval round-tripped through the App protocol')
    const argv = (await readFile(argsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    // The server applies its default reasoning effort, so only pin the shape.
    assert.equal(argv[0]?.[0], 'agent')
    assert.equal(argv[0]?.at(-1), 'stdio')
    assert.equal(argv[0]?.[argv[0].indexOf('-m') + 1], 'grok-4.5')

    // The cross-engine standing instructions reach grok as the first-prompt
    // prefix of the fresh session (docs/guide/bridge.md), listing the
    // catalog this adapter serves (sonnet + both grok ids).
    const grokEvents = (await readFile(eventsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const firstPrompt = grokEvents.find((entry) => entry.method === 'session/prompt')
    const promptText = firstPrompt.params.prompt.map((block: any) => block.text ?? '').join('')
    assert.match(promptText, /^# Other engines available\n/)
    assert.match(promptText, /Claude Sonnet \(`sonnet`\)/)
    assert.match(promptText, /Grok 4\.6 \(`grok-4\.6`\), Grok 4\.5 \(`grok-4\.5`\)/)
    assert.match(promptText, /---\n\nUse a tool to run echo hi, then reply PONG$/)

    // The grok session id is persisted on the thread as grok:<id>.
    write({ id: 5, method: 'thread/read', params: { threadId, includeTurns: false } })
    const read = await reader.nextResponse(5)
    assert.equal(read.result.thread.id, threadId)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

class JsonLineReader {
  private buffer = ''
  private queue: any[] = []
  private waiters: Array<(value: any) => void> = []

  constructor(proc: ReturnType<typeof spawn>) {
    if (!proc.stdout) throw new Error('test process has no stdout')
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.push(chunk))
  }

  next(): Promise<any> {
    const existing = this.queue.shift()
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  async nextResponse(id: number): Promise<any> {
    for (;;) {
      const msg = await this.next()
      if (msg.id === id && msg.method == null) return msg
    }
  }

  private push(chunk: string): void {
    this.buffer += chunk
    let idx: number = this.buffer.indexOf('\n')
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line) {
        const message = JSON.parse(line)
        const waiter = this.waiters.shift()
        if (waiter) waiter(message)
        else this.queue.push(message)
      }
      idx = this.buffer.indexOf('\n')
    }
  }
}
