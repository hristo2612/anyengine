import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { buildInteractiveArgs } from '../src/anyengine-runtime.mjs'
import { registerSandboxUpstream } from '../src/bridge-exec.mjs'
import { ClaudePTranscriptRuntime } from '../src/claude-p-runtime.mjs'
import { projectBaseline } from '../src/claude-project-guard.mjs'
import {
  CodexProxyRuntime,
  codexExecArgs,
  execRefusal,
  execSandboxArgs,
} from '../src/codex-proxy-runtime.mjs'
import { grokAgentSpec, grokToolCallInfo } from '../src/grok-acp.mjs'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import {
  applyCodexParams,
  DEFAULT_POSTURE,
  decide,
  isUnrestricted,
  type Posture,
} from '../src/posture.mjs'
import {
  claudeLaunchFor,
  decideClaudeTool,
  headlessIsolation,
  relayDecision,
  SHELL_OFF_NO_SANDBOX,
  SHELL_OFF_PLAN,
  SHELL_OFF_UNTRUSTED,
  SHELL_THROUGH_EXEC,
  UNTRUSTED_PROJECT_NOTICE,
} from '../src/posture-claude.mjs'
import type { RuntimeEvent, RuntimeHandlers, RuntimeTurnContext } from '../src/types.mjs'
import { everyPosture, postureTree } from './helpers/postures.mjs'

const tree = postureTree()
after(() => rmSync(tree.base, { recursive: true, force: true }))

function context(
  posture: Posture | null,
  overrides: Partial<RuntimeTurnContext> = {},
): RuntimeTurnContext {
  return {
    threadId: 'thread',
    turnId: 'turn',
    prompt: 'hello',
    cwd: tree.ctx.cwd,
    runtimeType: null,
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
    ...(posture ? { posture } : {}),
    systemPromptAddendum: null,
    planMode: false,
    imageInputs: [],
    ...overrides,
  }
}

const WS_NEVER = applyCodexParams(DEFAULT_POSTURE, {
  permissions: ':workspace',
  approvalPolicy: 'never',
})
const FULL = applyCodexParams(DEFAULT_POSTURE, { permissions: ':danger-full-access' })

function claudeP(): { args: (c: RuntimeTurnContext) => string[] } {
  const runtime = new ClaudePTranscriptRuntime({
    command: 'claude-p',
    extraArgs: [],
    timeoutMs: 60_000,
    skipPermissions: false,
    resume: false,
  })
  const argsForContext = Reflect.get(runtime, 'argsForContext') as (
    c: RuntimeTurnContext,
    inputFile: string,
  ) => string[]
  return { args: (c) => argsForContext.call(runtime, c, '/tmp/in') }
}

function sdkOptions(c: RuntimeTurnContext): Record<string, any> {
  const runtime = new NativeClaudeRuntime()
  const buildOptions = Reflect.get(runtime, 'buildOptions') as (...args: unknown[]) => any
  return buildOptions.call(runtime, {}, c, new AbortController())
}

function recorder(): { events: RuntimeEvent[]; handlers: RuntimeHandlers } {
  const events: RuntimeEvent[] = []
  const onEvent = (event: RuntimeEvent) => {
    events.push(event)
  }
  return {
    events,
    handlers: { onEvent, onPermissionRequest: async () => ({ decision: 'accept' }) },
  }
}

// A `codex` that records its cwd and argv, and exits 0.
function fakeCodex(): { record: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'anyengine-fake-codex-'))
  const record = join(dir, 'record.json')
  const bin = join(dir, 'codex.mjs')
  const line = `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }))`
  writeFileSync(
    bin,
    ['#!/usr/bin/env node', "import { writeFileSync } from 'node:fs'", line].join('\n'),
  )
  chmodSync(bin, 0o755)
  const previous = process.env.CODEX_REAL
  process.env.CODEX_REAL = bin
  const restore = () => {
    if (previous === undefined) delete process.env.CODEX_REAL
    else process.env.CODEX_REAL = previous
    rmSync(dir, { recursive: true, force: true })
  }
  return { record, restore }
}

test('never looser: a runtime drops its own approvals only for an unrestricted posture', () => {
  const p = claudeP()
  // grok labels its fetch read_only; it is never answered locally, and the
  // server's verdict for it is the posture's own for network.
  const fetch = grokToolCallInfo({
    title: 'web_fetch',
    rawInput: { url: 'https://example.com' },
    _meta: { 'x.ai/tool': { name: 'web_fetch', read_only: true } },
  })
  assert.deepEqual([fetch.toolName, fetch.readOnly], ['WebFetch', false])
  for (const posture of everyPosture(tree)) {
    const ctx = context(posture)
    const unrestricted = isUnrestricted(posture)
    assert.equal(grokAgentSpec(ctx).alwaysApprove, unrestricted, 'grok --always-approve')
    const net = decide(posture, { kind: 'net' }, tree.ctx) === 'allow' ? 'allow' : 'deny'
    assert.equal(decideClaudeTool(posture, 'WebFetch', fetch.input, tree.ctx), net, 'grok fetch')
    const args = p.args(ctx)
    assert.equal(args.includes('--dangerously-skip-permissions'), unrestricted, 'claude -p')
    // No baseline and trust unknown: only an unrestricted posture loads project config.
    assert.equal(args.includes('--strict-mcp-config'), !unrestricted, 'claude -p isolation')
    // Pinned, so no settings defaultMode applies; what would ask is refused.
    const mode = posture.plan ? 'plan' : unrestricted ? 'bypassPermissions' : 'dontAsk'
    assert.equal(args[args.indexOf('--permission-mode') + 1], mode, 'claude -p mode')
    const bypass = execSandboxArgs(posture, false).includes(
      '--dangerously-bypass-approvals-and-sandbox',
    )
    assert.equal(bypass, unrestricted, 'codex exec')
    const refused = execRefusal(posture) !== null
    assert.equal(refused, posture.plan || posture.approval === 'untrusted', 'codex exec refuses')
  }
})

test('codex exec: a missing sandbox gets no bypass flag, and resume keeps the sandbox', () => {
  const bare = codexExecArgs(context(null))
  assert.ok(!bare.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.deepEqual(bare.slice(bare.indexOf('-s'), bare.indexOf('-s') + 2), ['-s', 'read-only'])
  const resumed = codexExecArgs(context(WS_NEVER, { claudeSessionId: 'sess-1' }))
  assert.deepEqual(resumed.slice(0, 3), ['exec', 'resume', 'sess-1'])
  assert.ok(resumed.includes('sandbox_mode="workspace-write"'))
  assert.ok(resumed.includes('sandbox_workspace_write.network_access=false'))
  assert.ok(!resumed.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.ok(codexExecArgs(context(FULL)).includes('--dangerously-bypass-approvals-and-sandbox'))
  // An empty session id is a fresh session on every check.
  const empty = codexExecArgs(context(WS_NEVER, { claudeSessionId: '' }))
  assert.deepEqual(empty.slice(0, 2), ['exec', '--json'])
  assert.ok(empty.includes('-s') && empty.includes('-C'))
})

test('codex exec: a thread that asks before every command, or plans, is not run', async () => {
  const fake = fakeCodex()
  try {
    const untrusted = applyCodexParams(WS_NEVER, { approvalPolicy: 'untrusted' })
    for (const posture of [untrusted, { ...WS_NEVER, plan: true }]) {
      const { events, handlers } = recorder()
      await assert.rejects(
        new CodexProxyRuntime().runTurn(context(posture), handlers),
        /the turn was not started/,
      )
      assert.deepEqual(
        events.map((e) => [e.type, e.type === 'completed' ? e.success : null]),
        [
          ['error', null],
          ['completed', false],
        ],
      )
    }
    assert.equal(existsSync(fake.record), false, 'codex never started')
  } finally {
    fake.restore()
  }
})

test("codex exec: a resumed turn runs in the thread's cwd, not the adapter's", async () => {
  const fake = fakeCodex()
  try {
    const resumed = context(WS_NEVER, { claudeSessionId: 'sess-1' })
    await new CodexProxyRuntime().runTurn(resumed, recorder().handlers)
    const seen = JSON.parse(readFileSync(fake.record, 'utf8'))
    assert.deepEqual(seen.argv.slice(0, 3), ['exec', 'resume', 'sess-1'])
    assert.ok(!seen.argv.includes('-C'), 'exec resume takes no -C')
    assert.equal(seen.cwd, tree.ctx.cwd)
    assert.notEqual(seen.cwd, process.cwd())
  } finally {
    fake.restore()
  }
})

test('codex exec: every workspace-write setting comes from the posture, never from config.toml', () => {
  const settings = (posture: Posture) =>
    execSandboxArgs(posture, false).filter((arg) => arg.startsWith('sandbox_workspace_write.'))
  const bounded = applyCodexParams(DEFAULT_POSTURE, {
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [tree.extra], excludeSlashTmp: true },
  })
  assert.deepEqual(settings(bounded), [
    'sandbox_workspace_write.network_access=false',
    `sandbox_workspace_write.writable_roots=${JSON.stringify([tree.extra])}`,
    'sandbox_workspace_write.exclude_tmpdir_env_var=false',
    'sandbox_workspace_write.exclude_slash_tmp=true',
  ])
  // An external sandbox writes to its cwd alone (toCodexExecSandboxPolicy).
  const external = applyCodexParams(DEFAULT_POSTURE, { sandboxPolicy: { type: 'externalSandbox' } })
  assert.deepEqual(settings(external), [
    'sandbox_workspace_write.network_access=false',
    'sandbox_workspace_write.writable_roots=[]',
    'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    'sandbox_workspace_write.exclude_slash_tmp=true',
  ])
})

test('claude -p: a read-only posture allows no network tool', () => {
  const args = claudeP().args(context(DEFAULT_POSTURE))
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Glob,Grep,WebSearch,TodoWrite,Task')
})

test('SDK runtime: on-failure is on-request, and never refuses out-of-bounds calls unasked', async () => {
  const runtime = new NativeClaudeRuntime()
  const buildOptions = Reflect.get(runtime, 'buildOptions') as (
    ...args: unknown[]
  ) => Record<string, any>
  const onFailure = context(null, { approvalPolicy: 'on-failure', sandboxMode: 'workspace-write' })
  assert.equal(
    buildOptions.call(runtime, {}, onFailure, new AbortController()).permissionMode,
    'default',
  )
  const asked: unknown[] = []
  const turns = Reflect.get(runtime, 'turns') as Map<string, unknown>
  turns.set('turn', {
    handlers: {
      onPermissionRequest: async (event: unknown) => {
        asked.push(event)
        return { decision: 'accept' }
      },
    },
  })
  try {
    const signal = new AbortController().signal
    const bounded = buildOptions.call(runtime, {}, context(WS_NEVER), new AbortController())
    const shell = await bounded.canUseTool('Bash', { command: 'ls' }, { toolUseID: 't1', signal })
    assert.equal(shell.behavior, 'deny')
    assert.ok(shell.message.includes(SHELL_OFF_NO_SANDBOX), shell.message)
    const inside = { file_path: join(tree.ctx.cwd, 'a.txt') }
    assert.deepEqual(await bounded.canUseTool('Write', inside, { toolUseID: 't2', signal }), {
      behavior: 'allow',
      updatedInput: inside,
    })
    assert.equal(asked.length, 0, 'neither call reached the app')
    const full = buildOptions.call(runtime, {}, context(FULL), new AbortController())
    assert.deepEqual(
      await full.canUseTool('Bash', { command: 'ls' }, { toolUseID: 't3', signal }),
      {
        behavior: 'allow',
      },
    )
  } finally {
    turns.delete('turn')
  }
})

test('claude -p and the SDK runtime leave project config out exactly when the PTY would', () => {
  const runtime = new NativeClaudeRuntime()
  const buildOptions = Reflect.get(runtime, 'buildOptions') as (
    ...args: unknown[]
  ) => Record<string, any>
  const sdk = (c: RuntimeTurnContext) => buildOptions.call(runtime, {}, c, new AbortController())
  const cliFlags = (c: RuntimeTurnContext) => {
    const args = claudeP().args(c)
    const at = args.indexOf('--setting-sources')
    return at === -1 ? null : args.slice(at, at + 3)
  }
  // No baseline (the app never started the thread) never matches, so a
  // bounded posture launches with the user's settings alone.
  const isolated = context(WS_NEVER)
  assert.deepEqual(cliFlags(isolated), ['--setting-sources', 'user', '--strict-mcp-config'])
  assert.deepEqual(sdk(isolated).settingSources, ['user'])
  assert.equal(sdk(isolated).strictMcpConfig, true)
  // A baseline that still matches, and an unrestricted posture, keep the
  // CLI's own sources.
  const matching = { ...WS_NEVER, projectBaseline: projectBaseline(tree.ctx.cwd) }
  for (const posture of [matching, FULL]) {
    assert.equal(headlessIsolation(context(posture)), null)
    assert.equal(cliFlags(context(posture)), null)
    assert.equal(sdk(context(posture)).settingSources, undefined)
    assert.equal(sdk(context(posture)).strictMcpConfig, undefined)
  }
  // Neither has a workspace trust dialog to refuse, so an untrusted project's
  // config stays out even when it matches, and the thread is told why.
  for (const posture of [
    { ...matching, trust: 'untrusted' as const },
    { ...FULL, projectBaseline: matching.projectBaseline, trust: 'untrusted' as const },
  ]) {
    const untrusted = context(posture)
    assert.equal(headlessIsolation(untrusted), UNTRUSTED_PROJECT_NOTICE)
    assert.deepEqual(cliFlags(untrusted), ['--setting-sources', 'user', '--strict-mcp-config'])
    assert.deepEqual(sdk(untrusted).settingSources, ['user'])
    assert.equal(sdk(untrusted).strictMcpConfig, true)
  }
})

test('an allow rule or a pre-approved tool never runs a call the posture refuses', async () => {
  const allowedTools = ['Bash', 'Bash(git *)', 'Read', 'mcp__x__y']
  const bounded = context(WS_NEVER, { allowedTools })
  // SDK: allowedTools and the settings' allow rules are resolved before
  // canUseTool; the PreToolUse hook runs first, and its deny wins.
  const opts = sdkOptions(bounded)
  assert.deepEqual(opts.allowedTools, allowedTools)
  const [hook] = opts.hooks.PreToolUse[0].hooks
  const signal = new AbortController().signal
  const bash = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git st' },
  }
  const shell = await hook(bash, 't1', { signal })
  assert.equal(shell.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(shell.hookSpecificOutput.permissionDecision, 'deny')
  // No codex child here, so no sandbox takes the shell: the thread's notice says why.
  assert.ok(shell.hookSpecificOutput.permissionDecisionReason.includes(SHELL_OFF_NO_SANDBOX))
  const inside = { tool_name: 'Write', tool_input: { file_path: join(tree.ctx.cwd, 'a.txt') } }
  assert.deepEqual(await hook(inside, 't2', { signal }), {}, 'in bounds: the CLI decides')
  // An explicit operator override may loosen the posture (configuration.md).
  process.env.ANYENGINE_PERMISSION_MODE = 'acceptEdits'
  try {
    assert.equal(sdkOptions(bounded).hooks, undefined)
  } finally {
    delete process.env.ANYENGINE_PERMISSION_MODE
  }
  // claude -p takes no hook: the refused pre-approvals are dropped, and what
  // the posture refuses in every call is denied, which beats an allow rule.
  const args = claudeP().args(bounded)
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,mcp__x__y')
  assert.deepEqual(args[args.indexOf('--disallowedTools') + 1]?.split(','), [
    'Bash',
    'BashOutput',
    'KillShell',
    'Monitor',
    'WebFetch',
  ])
  // Under on-request, pre-approving what the posture asks about is the
  // documented ANYENGINE_ALLOWED_TOOLS contract: it runs without the card.
  // Bash is not such a tool here: no sandbox bounds it, so it is refused.
  const onRequest = applyCodexParams(WS_NEVER, { approvalPolicy: 'on-request' })
  const asks = claudeP().args(context(onRequest, { allowedTools: ['Write'] }))
  assert.equal(asks[asks.indexOf('--allowedTools') + 1], 'Write')
  const refused = asks[asks.indexOf('--disallowedTools') + 1]?.split(',') ?? []
  assert.ok(!refused.includes('Write'))
  assert.ok(refused.includes('Bash'))
})

test('SDK runtime: a call the posture asks about is asked, whatever an allow rule says', async () => {
  // workspace-write + on-request, and a `Write(*)` allow rule in the
  // settings: the hook's ask beats the rule, the CLI hands the call to
  // canUseTool, and that reaches the app's approval path.
  const onRequest = applyCodexParams(WS_NEVER, { approvalPolicy: 'on-request' })
  const runtime = new NativeClaudeRuntime()
  const buildOptions = Reflect.get(runtime, 'buildOptions') as (...args: unknown[]) => any
  const opts = buildOptions.call(runtime, {}, context(onRequest), new AbortController())
  const [hook] = opts.hooks.PreToolUse[0].hooks
  const signal = new AbortController().signal
  // Outside every writable root (the cwd, TMPDIR, /tmp), wherever the suite
  // runs: tree.outside lies in TMPDIR, which workspace-write can write.
  const outside = { file_path: '/anyengine-outside/x.txt', content: 'x' }
  const write = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: outside }
  assert.deepEqual(await hook(write, 't1', { signal }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'asks the app',
    },
  })
  const asked: Array<{ toolName: string }> = []
  const turns = Reflect.get(runtime, 'turns') as Map<string, unknown>
  turns.set('turn', {
    handlers: {
      onPermissionRequest: async (event: { toolName: string }) => {
        asked.push(event)
        return { decision: 'decline' }
      },
    },
  })
  try {
    const decided = await opts.canUseTool('Write', write.tool_input, { toolUseID: 't1', signal })
    assert.deepEqual(decided, { behavior: 'deny', message: 'denied by user' })
    assert.deepEqual(
      asked.map((event) => event.toolName),
      ['Write'],
      'the card was drawn',
    )
  } finally {
    turns.delete('turn')
  }
  // ANYENGINE_ALLOWED_TOOLS is the operator's pre-approval: the hook stands aside.
  const allowed = sdkOptions(context(onRequest, { allowedTools: ['Write'] }))
  assert.deepEqual(await allowed.hooks.PreToolUse[0].hooks[0](write, 't2', { signal }), {})
})

test('posture: no codex child + workspace-write: no Bash in any runtime, the thread says why, and a shell write outside the workspace is refused, never asked', async () => {
  const ws = applyCodexParams(DEFAULT_POSTURE, {
    permissions: ':workspace',
    approvalPolicy: 'on-request',
  })
  const bridged = context(ws, { mcpServers: { anyengine: { command: 'node', args: [] } } })
  const shellEscape = { command: 'echo probe > ~/anyengine-probe.txt' }
  // The interactive PTY runtime: Bash is not in the session at all.
  const pty = buildInteractiveArgs({
    context: bridged,
    settingsPath: join(tree.base, 's.json'),
    mcpPath: null,
    extraArgs: [],
  })
  assert.ok(pty.slice(pty.indexOf('--disallowedTools')).includes('Bash'))
  assert.ok((claudeLaunchFor(bridged).notice ?? '').includes(SHELL_OFF_NO_SANDBOX))
  // The relay every runtime shares refuses it outright: no approval card.
  assert.equal(relayDecision(bridged, 'Bash', shellEscape).verdict, 'deny')
  // claude -p: refused by flag.
  const args = claudeP().args(bridged)
  assert.ok((args[args.indexOf('--disallowedTools') + 1] ?? '').split(',').includes('Bash'))
  // The SDK runtime: its PreToolUse hook denies, which beats any allow rule.
  const hook = sdkOptions(bridged).hooks.PreToolUse[0].hooks[0]
  const answer = await hook(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: shellEscape },
    'tool-1',
    { signal: new AbortController().signal },
  )
  assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny')
  // It also leaves Bash out of the session, which holds when an operator's
  // ANYENGINE_PERMISSION_MODE override drops the hooks.
  assert.deepEqual(sdkOptions(bridged).disallowedTools, ['Bash', 'Monitor'])
  process.env.ANYENGINE_PERMISSION_MODE = 'acceptEdits'
  try {
    assert.equal(sdkOptions(bridged).hooks, undefined)
    assert.deepEqual(sdkOptions(bridged).disallowedTools, ['Bash', 'Monitor'])
  } finally {
    delete process.env.ANYENGINE_PERMISSION_MODE
  }
  assert.deepEqual(
    sdkOptions(context(FULL, { mcpServers: bridged.mcpServers })).disallowedTools,
    [],
  )
  // Full access keeps Bash: nothing is bounded there.
  assert.notEqual(
    relayDecision(context(FULL, { mcpServers: bridged.mcpServers }), 'Bash', shellEscape).verdict,
    'deny',
  )
})

test('relay: a refused shell gives the shell rule as its reason, whatever else the thread says', () => {
  const ws = applyCodexParams(DEFAULT_POSTURE, {
    permissions: ':workspace',
    approvalPolicy: 'on-request',
  })
  const bridged = { mcpServers: { anyengine: { command: 'node', args: [] } } }
  const reason = (posture: Posture) =>
    relayDecision(context(posture, bridged), 'Bash', { command: 'ls' }).reason
  // No baseline, so the project settings are isolated too and the thread's
  // notice leads with that; the refusal names the shell rule alone.
  assert.equal(reason(ws), SHELL_OFF_NO_SANDBOX)
  assert.equal(reason({ ...ws, plan: true }), SHELL_OFF_PLAN)
  assert.equal(reason(applyCodexParams(ws, { approvalPolicy: 'untrusted' })), SHELL_OFF_UNTRUSTED)
  registerSandboxUpstream({ running: true, request: async () => ({}) })
  try {
    assert.equal(reason(ws), SHELL_THROUGH_EXEC)
    assert.equal(reason({ ...ws, plan: true }), SHELL_OFF_PLAN)
  } finally {
    registerSandboxUpstream(null)
  }
})

test('read-restricted parent disables read tools at every Claude runtime launch', () => {
  const restricted = applyCodexParams(FULL, { permissions: 'private-paths' })
  const c = context(restricted)
  const interactive = buildInteractiveArgs({
    context: c,
    settingsPath: '/settings',
    mcpPath: null,
    extraArgs: [],
  })
  const args = claudeP().args(c)
  const refused = args[args.indexOf('--disallowedTools') + 1]?.split(',') ?? []
  for (const tool of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'Bash', 'Monitor']) {
    assert.ok(interactive.includes(tool), `PTY ${tool}`)
    assert.ok(sdkOptions(c).disallowedTools.includes(tool), `SDK ${tool}`)
    assert.ok(refused.includes(tool), `claude-p ${tool}`)
  }
  assert.ok(!args.includes('--dangerously-skip-permissions'))
})
