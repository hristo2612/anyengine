import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test, { after, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AnyengineRuntime } from '../src/anyengine-runtime.mjs'
import type { TurnLifecycles } from '../src/anyengine-turn-lifecycle.mjs'
import { registerSandboxUpstream } from '../src/bridge-exec.mjs'
import { claudeEnvironment } from '../src/claude-environment.mjs'
import { ClaudePTranscriptRuntime } from '../src/claude-p-runtime.mjs'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import { DEFAULT_POSTURE } from '../src/posture.mjs'
import type { RuntimeTurnContext } from '../src/types.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

const ordinary = [
  'SSH_AUTH_SOCK',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
  'EDITOR',
  'NVM_DIR',
  'PYENV_ROOT',
  'VIRTUAL_ENV',
  'XDG_CONFIG_HOME',
  'UNRELATED_SECRET',
]
const steering = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_BASE_URL',
  'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_LOCAL_OAUTH_API_BASE',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_ENV_FILE',
  'CLAUDECODE',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK',
  'USE_LOCAL_OAUTH',
  'USE_STAGING_OAUTH',
  'LOCAL_BRIDGE',
  'VOICE_STREAM_BASE_URL',
  'AGENT_PROXY_URL',
  'AGENT_PROXY_AUTH_TOKEN',
  'SESSION_INGRESS_URL',
  'CCR_OAUTH_TOKEN_FILE',
  'CCR_AGENT_PROXY_ENABLED',
  'SELF_HOSTED_RUNNER_HOST_CONFIG_DIR',
  'SELF_HOSTED_RUNNER_PROXY_AUTHORIZATION_COMMAND',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'npm_config_proxy',
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'NODE_USE_SYSTEM_CA',
  'NODE_PATH',
  'BUN_OPTIONS',
  'BUN_CONFIG_FILE',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'BETA_TRACING_ENDPOINT',
  'MCP_CLIENT_SECRET',
  'MCP_OAUTH_CLIENT_METADATA_URL',
  'MCP_PROXY_URL',
  'SDK_NATIVE_BIN',
]
const base: RuntimeTurnContext = {
  threadId: 'env',
  turnId: 'turn',
  prompt: 'hello',
  cwd: process.cwd(),
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
  systemPromptAddendum: null,
  planMode: false,
  imageInputs: [],
}
const cases: [string, Partial<RuntimeTurnContext>, boolean][] = [
  ['full access', { sandboxMode: 'danger-full-access' }, true],
  ['workspace', { sandboxMode: 'workspace-write', mcpServers: { anyengine: {} } }, false],
  ['shell off', { sandboxMode: 'read-only' }, false],
  ['full access planning', { sandboxMode: 'danger-full-access', planMode: true }, false],
  [
    'read restricted',
    {
      posture: { ...DEFAULT_POSTURE, fileSystem: { kind: 'full-access' }, readRestricted: true },
    },
    false,
  ],
]

function seed(t: TestContext) {
  registerSandboxUpstream({ running: true, request: async () => ({}) })
  t.after(() => registerSandboxUpstream(null))
  for (const name of [...ordinary, ...steering]) {
    const previous = process.env[name]
    process.env[name] = 'fixture'
    t.after(() => {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    })
  }
}

function checkNames(names: string[], full: boolean) {
  if (!full) {
    const processKeys = new Set([
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'SHELL',
      'LANG',
      'TMPDIR',
      'TERM',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN',
      'CLAUDE_CODE_RESUME_TOKEN_THRESHOLD',
      'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION',
      // Added by node-pty / macOS after spawn, not inherited by our filter.
      'PWD',
      '__CF_USER_TEXT_ENCODING',
    ])
    // Node child_process explicitly propagates coverage even with an env allowlist.
    if (process.env.NODE_V8_COVERAGE) processKeys.add('NODE_V8_COVERAGE')
    for (const name of names) {
      assert.ok(
        processKeys.has(name) || /^LC_[A-Z_]+$/.test(name) || name.startsWith('ANYENGINE_'),
        name,
      )
    }
  }
  for (const name of ordinary) assert.equal(names.includes(name), full, name)
  for (const name of steering) assert.ok(!names.includes(name), name)
  for (const name of ['HOME', 'PATH', 'CLAUDE_CONFIG_DIR', 'TMPDIR']) {
    assert.ok(names.includes(name), name)
  }
}

async function waitForNames(path: string): Promise<string[]> {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      await delay(25)
    }
  }
  throw new Error('environment name probe did not finish')
}

for (const [label, overrides, full] of cases) {
  test(`PTY child environment: ${label}`, async (t) => {
    const dir = await tempDir('claude-env-')
    const output = join(dir, 'names.json')
    const probe = join(dir, 'probe.mjs')
    await writeFile(
      probe,
      `
      import { writeFileSync } from 'node:fs'
      writeFileSync(${JSON.stringify(output)}, JSON.stringify(Object.keys(process.env)))
      setInterval(() => {}, 1000)
    `,
    )
    const runtime = new AnyengineRuntime({
      cli: probe,
      extraArgs: [],
      cols: 80,
      rows: 24,
      turnTimeoutMs: 30000,
      asyncSubagentTimeoutMs: 30000,
      startupTimeoutMs: 30000,
      streamProxy: false,
      hookTimeoutSec: 30,
      autoApproveSafetyPrompts: false,
      keepApiKey: true,
      stateDir: join(dir, 'state'),
      relayScript: resolve('scripts/anyengine-hook-relay.mjs'),
      nodeBinary: process.execPath,
    })
    seed(t)
    const context = { ...base, ...overrides }
    const lifecycle = Reflect.get(runtime, 'lifecycle') as TurnLifecycles
    const preparation = lifecycle.begin(context.threadId)
    const session = await Reflect.get(runtime, 'spawn').call(runtime, context, preparation)
    preparation.commit()
    const exited = new Promise<void>((done) => session.proc.onExit(() => done()))
    try {
      checkNames(await waitForNames(output), full)
    } finally {
      session.proc.kill('SIGTERM')
      await exited
      lifecycle.finish(context.threadId, preparation)
      await runtime.stop()
    }
  })

  test(`SDK and claude-p environment: ${label}`, async (t) => {
    const dir = await tempDir('claude-env-')
    const probe = join(dir, 'probe.mjs')
    await writeFile(
      probe,
      'console.log(JSON.stringify({result: JSON.stringify(Object.keys(process.env))}))',
    )
    seed(t)
    const context = { ...base, ...overrides }
    const sdk = new NativeClaudeRuntime()
    const options = Reflect.get(sdk, 'buildOptions').call(sdk, {}, context, new AbortController())
    checkNames(Object.keys(options.env), full)
    const runtime = new ClaudePTranscriptRuntime({
      command: process.execPath,
      extraArgs: [probe],
      timeoutMs: 30000,
      skipPermissions: false,
      resume: false,
    })
    let text = ''
    try {
      await runtime.runTurn(context, {
        onEvent: (event) => {
          if (event.type === 'text_delta') text += event.delta
        },
        onPermissionRequest: async () => ({ decision: 'decline' }),
      })
      checkNames(JSON.parse(text), full)
    } finally {
      await runtime.stop()
    }
  })
}

test('strict modes retain exactly the Task 2c allowlist; full access preserves values without mutating the source', () => {
  const allowed = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_MESSAGES',
    'TMPDIR',
    'TERM',
    'CLAUDE_CONFIG_DIR',
    'ANYENGINE_BRIDGE_TOKEN',
  ]
  const source = Object.fromEntries(
    [
      ...allowed,
      ...ordinary,
      ...steering,
      'LC_123',
      'ANTHROPIC_FUTURE_CONTROL',
      'CLAUDE_CODE_FUTURE_CONTROL',
      '__CLAUDE_CC_KEEP_TEST',
      'NODE_TLS_FUTURE_CONTROL',
      'VERTEX_REGION_CLAUDE_FABLE_5',
      'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
      'grpc_proxy',
      'no_grpc_proxy',
      'GLOBAL_AGENT_HTTPS_PROXY',
      'NPM_CONFIG_HTTPS_PROXY',
    ].map((name) => [name, 'fixture']),
  )
  const before = JSON.stringify(source)
  for (const mode of ['exec', 'none', undefined] as const) {
    assert.deepEqual(Object.keys(claudeEnvironment(mode, source)).sort(), [...allowed].sort())
  }
  const full = claudeEnvironment('bash', source)
  checkNames(Object.keys(full), true)
  assert.deepEqual(Object.keys(full).sort(), [...allowed, ...ordinary, 'LC_123'].sort())
  for (const name of [...allowed, ...ordinary]) assert.ok(full[name] === source[name], name)
  assert.ok(JSON.stringify(source) === before, 'source is unchanged')
  assert.ok(!('MISSING' in claudeEnvironment('bash', { MISSING: undefined })))
})
