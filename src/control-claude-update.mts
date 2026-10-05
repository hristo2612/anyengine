// Fake captures establish protocol compatibility; the live Read smoke owns health.
import { join } from 'node:path'
import { jsonAt, object } from './control-layer-state.mjs'
import { markDegraded } from './degraded.mjs'

export type UpdateCapture = (script: string, args: readonly string[]) => Promise<unknown>
const reason = 'Claude Code GPT update capture is incompatible'
const authFixture = 'codex-auth-0.160.0.json'
const messagesFixture = 'claude-messages-2.1.289.json'
const fail = (): never => {
  throw new Error(reason)
}
const row = (value: unknown): Record<string, unknown> => (object(value) ? value : fail())
const list = (value: unknown): unknown[] =>
  Array.isArray(value) && value.length <= 256 ? value : fail()
const string = (value: unknown): string =>
  typeof value === 'string' && value.length > 0 && value.length <= 8192 ? value : fail()

function canonical(value: unknown): string {
  const visit = (part: unknown): unknown => {
    if (Array.isArray(part)) return part.map(visit)
    if (object(part))
      return Object.fromEntries(
        Object.keys(part)
          .sort()
          .map((key) => [key, visit(part[key])]),
      )
    return part
  }
  return JSON.stringify(visit(value))
}

function authContract(value: unknown): unknown {
  const capture = row(value)
  string(capture.codexVersion)
  if (canonical(capture.protocol) !== '["initialize","initialized","getAuthStatus"]') fail()
  const homes = list(capture.homes)
  if (homes.length !== 3) fail()
  for (const home of homes) {
    const own = row(home)
    if (list(own.calls).length !== 3) fail()
    const cleanup = row(own.cleanup)
    if (cleanup.directChildJoined !== true || cleanup.processGroupJoined !== true) fail()
  }
  // This recorder contains only deterministic fake credential booleans/counts.
  return capture
}

function schemaShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(schemaShape)
  if (!object(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => key !== 'bytes')
      .map((key) => [key, schemaShape(value[key])]),
  )
}

function valueShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(valueShape)
  if (value === null) return 'null'
  if (!object(value)) return typeof value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, valueShape(value[key])]),
  )
}

function contentShape(value: unknown): unknown {
  if (!Array.isArray(value))
    return object(value) && typeof value.type === 'string' ? { type: value.type } : typeof value
  return value.map((block) => {
    const item = row(block)
    const type = string(item.type)
    return {
      type,
      keys: Object.keys(item).sort(),
      ...(type === 'tool_use' ? { name: string(item.name), input: valueShape(item.input) } : {}),
      ...(type === 'tool_result'
        ? { is_error: item.is_error, content: contentShape(item.content) }
        : {}),
      ...(item.cache_control ? { cache_control: schemaShape(item.cache_control) } : {}),
    }
  })
}

function requestContract(value: unknown): unknown {
  const request = row(value)
  const headers = row(request.headers)
  const body = row(request.body)
  if (request.method !== 'POST' || !string(request.path).startsWith('/v1/messages')) fail()
  if (typeof body.stream !== 'boolean' || !Number.isSafeInteger(body.max_tokens)) fail()
  const hint = (key: string) => typeof headers[key] === 'string' && headers[key] !== ''
  return {
    method: request.method,
    path: request.path,
    headers: Object.fromEntries(
      ['content-type', 'anthropic-version', 'anthropic-beta', 'x-app'].map((key) => [
        key,
        headers[key] ?? null,
      ]),
    ),
    sessionHint: hint('x-claude-code-session-id'),
    agentHint: hint('x-claude-code-agent-id'),
    keys: list(body.keys).map(string).sort(),
    metadataKeys: list(body.metadataKeys).map(string).sort(),
    model: string(body.model),
    stream: body.stream,
    maxTokensType: typeof body.max_tokens,
    thinking: schemaShape(body.thinking ?? null),
    system: object(body.system) ? body.system.type : typeof body.system,
    tools: list(body.tools).map((tool) => {
      const item = row(tool)
      return { name: string(item.name), input_schema: schemaShape(item.input_schema) }
    }),
    messages: list(body.messages).map((message) => {
      const item = row(message)
      return { role: string(item.role), content: contentShape(item.content) }
    }),
  }
}

function messagesContract(value: unknown): unknown {
  const capture = row(value)
  const isolation = row(capture.isolation)
  for (const key of [
    'fakeCredentials',
    'loopbackOnly',
    'realHomeReadWriteDenied',
    'keychainFilesAndMachDenied',
  ])
    if (isolation[key] !== true) fail()
  if (isolation.cleanup !== 'all owned groups joined') fail()
  const observed = row(capture.observed)
  for (const key of ['primaryGpt', 'readRoundTrip', 'generatedGptAgent'])
    if (observed[key] !== true) fail()
  const scenarios = row(capture.scenarios)
  const requests = (name: string) => {
    const scenario = row(scenarios[name])
    if (scenario.exitCode !== 0 || scenario.deadline !== false) fail()
    return list(scenario.requests)
  }
  const main = requests('read')
  const child = requests('agent-default')
  const gpt = (value: unknown) =>
    object(value) &&
    object(value.body) &&
    typeof value.body.model === 'string' &&
    value.body.model.startsWith('gpt-')
  const result = (value: unknown) => {
    if (!gpt(value)) return false
    return list(row(row(value).body).messages).some(
      (message) =>
        Array.isArray(row(message).content) &&
        (row(message).content as unknown[]).some(
          (block) => object(block) && block.type === 'tool_result',
        ),
    )
  }
  return {
    claudeVersion: string(capture.claudeVersion),
    flags: row(row(capture.help).flags),
    main: requestContract(main.find(gpt)),
    mainToolResult: requestContract(main.find(result)),
    child: requestContract(child.find(gpt)),
    childToolResult: requestContract(child.find(result)),
  }
}

export async function verifyClaudeCodeUpdate(
  root: string,
  lib: string,
  selected: { codex: string; claude: string },
  capture: UpdateCapture,
): Promise<{ ok: boolean; reason: string }> {
  try {
    const expectedAuth = authContract(jsonAt(join(lib, 'test/fixtures', authFixture)))
    const expectedMessages = messagesContract(jsonAt(join(lib, 'test/fixtures', messagesFixture)))
    const auth = await capture('capture-codex-auth.mjs', ['--codex', selected.codex])
    if (canonical(authContract(auth)) !== canonical(expectedAuth)) fail()
    const messages = await capture('capture-claude-messages.mjs', ['--claude', selected.claude])
    if (canonical(messagesContract(messages)) !== canonical(expectedMessages)) fail()
    return { ok: true, reason: '' }
  } catch {
    // A capture failure must not enter the existing broad M1 rollback path.
    try {
      markDegraded(root, 'claude-code-gpt', reason)
    } catch {
      /* Retain invalid existing evidence. */
    }
    return { ok: false, reason }
  }
}
