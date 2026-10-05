#!/usr/bin/env node
// A stand-in for the REAL `codex app-server` speaking JSON-RPC over stdio.
// Used by test/codex-mux.test.mts to prove the native-codex multiplexer
// without spending ChatGPT quota. It records its argv/env to
// FAKE_CODEX_ARGV_FILE, answers initialize / thread/start / thread/resume /
// turn/start (with a couple of notifications and ONE server request that must
// be answered before the turn completes) / thread/list (two pages) /
// model/list / config/read, and echoes anything else back as a `fake` result
// so default-route tests can see the request reached the child.
//
// For the mid-thread engine switch (src/rehome.mts) it also keeps a per-thread
// turn history that `thread/read` returns, accepts `thread/inject_items`, and
// mirrors both into FAKE_CODEX_STATE_FILE so a test can see exactly what the
// adapter carried over. Three env switches shape the awkward paths:
// FAKE_CODEX_NO_APPROVAL=1 (turns complete without the approval round-trip),
// FAKE_CODEX_NO_INJECT=1 (the child refuses injection, exercising the
// prefix fallback) and FAKE_CODEX_FAIL_START=1 (thread/start always fails).
// FAKE_CODEX_REQUESTS_FILE, when set, gets one JSON line per request received.
//
// For bridge sub-agents (src/upstream-subagents.mts): FAKE_CODEX_STARTED_LAST=1
// answers `thread/start` before announcing `thread/started`, the order codex
// 0.159 uses (the default is the other one), and FAKE_CODEX_LIST_STARTED=1
// puts the threads started here on the first `thread/list` page, as plain
// threads. A list by parent or ancestor is empty: like the real child, the
// fake never links a thread it was only asked to start.
// FAKE_CODEX_SLOW_FIRST_START=<ms> leaves the first thread/start unanswered
// that long, so a test can do other things while one is in flight.
//
// For the app's model picker (src/config-writes.mts): config/value/write and
// config/batchWrite change a config state that config/read answers from, kept
// in FAKE_CODEX_CONFIG (a JSON object of keyPath -> value) when that is set.
// Its version is a hash of the state, and a write whose expectedVersion is
// not the current one fails the way codex 0.159 does (configVersionConflict).
//
// For children codex spawns itself (spawn_agent): FAKE_CODEX_SPAWN_CHILD=<model>
// makes every turn/start spawn one child, announced the way codex 0.159 does
// (test/fixtures/codex-spawn-0.159.0.json): the parent's collabAgentToolCall
// spawnAgent item/started without receivers, its item/completed naming the
// child in receiverThreadIds (the link), and the child's own
// thread/status/changed and turn/started; no thread/started for the child
// unless FAKE_CODEX_CHILD_THREAD_STARTED=1 (the second source). The child's
// turn completes before the parent's. `inherit` spawns without a model:
// item/started says model "" and item/completed the parent's model.
// FAKE_CODEX_SPAWN_ORDER picks where the child's own notifications fall:
// `link-first` (the default) after the link, as on ephemeral threads, and
// `child-first` before it, turn/started included, as on persisted threads in
// about one spawn in eight (up to ~10 ms early); either way the link precedes
// the child's first model request. thread/read of a spawned child names its
// parent (parentThreadId, source.subAgent.thread_spawn.parent_thread_id).
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.153.4-fake\n')
  process.exit(0)
}

// Production-start tests still cross the real isolated schema admission. Emit
// the existing posture fixture and the method surface the shipped validators
// check, before any app-server state or request recording.
if (process.argv.includes('generate-json-schema') || process.argv.includes('generate-ts')) {
  const out = process.argv[process.argv.indexOf('--out') + 1]
  if (!out || !process.argv.includes('--out')) throw new Error('missing schema output directory')
  mkdirSync(out, { recursive: true })
  if (process.argv.includes('generate-json-schema'))
    writeFileSync(
      join(out, 'codex_app_server_protocol.v2.schemas.json'),
      readFileSync(new URL('./posture-schema.json', import.meta.url)),
    )
  else {
    for (const [name, methods] of [
      ['ClientRequest', ['initialize', 'thread/start', 'config/read', 'mcpServerStatus/list']],
      ['ServerNotification', ['turn/started', 'turn/completed']],
    ])
      writeFileSync(
        join(out, `${name}.ts`),
        `export type ${name} = ${methods.map((method) => `{ "method": "${method}" }`).join(' | ')}\n`,
      )
  }
  process.exit(0)
}

if (process.env.FAKE_CODEX_ARGV_FILE) {
  writeFileSync(
    process.env.FAKE_CODEX_ARGV_FILE,
    JSON.stringify({
      argv: process.argv.slice(2),
      env: {
        CODEX_APP_TOOLS_PIPE_PATH: process.env.CODEX_APP_TOOLS_PIPE_PATH ?? null,
        FAKE_CODEX_MARKER: process.env.FAKE_CODEX_MARKER ?? null,
      },
    }),
  )
}

let nextRead = 0
let nextThread = 0
let nextTurn = 0
// threadId -> the model it was started with.
const threadModels = new Map()
const ephemeralThreads = new Set()
const deletedThreads = new Set()
const threadCwds = new Map()
const threadInstructions = new Map()
// childId -> { parent, model } for the children FAKE_CODEX_SPAWN_CHILD spawned.
const spawnedChildren = new Map()
// Threads started here, newest last, for FAKE_CODEX_LIST_STARTED.
const started = []
// threadId -> turns in the shape `thread/read` returns them.
const threadTurns = new Map()
// threadId -> raw Responses items handed over by thread/inject_items.
const injectedItems = new Map()
// threadId -> the `input` array of every turn/start, newest last.
const turnInputs = new Map()

function writeState() {
  if (!process.env.FAKE_CODEX_STATE_FILE) return
  writeFileSync(
    process.env.FAKE_CODEX_STATE_FILE,
    JSON.stringify({
      injected: Object.fromEntries(injectedItems),
      turnInputs: Object.fromEntries(turnInputs),
      turns: Object.fromEntries(threadTurns),
      instructions: Object.fromEntries(threadInstructions),
    }),
  )
}
let nextServerRequestId = 1
const pendingServerRequests = new Map()
let initialized = false

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })
const respond = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

const now = () => Math.floor(Date.now() / 1000)
const thread = (id, extra = {}) => ({
  id,
  isPinned: false,
  sessionId: id,
  forkedFromId: null,
  parentThreadId: null,
  preview: `fake ${id}`,
  ephemeral: ephemeralThreads.has(id),
  modelProvider: 'openai',
  createdAt: now(),
  updatedAt: now(),
  recencyAt: now(),
  status: { type: 'idle' },
  path: null,
  cwd: threadCwds.get(id) ?? process.cwd(),
  cliVersion: '0.153.4',
  canAcceptDirectInput: true,
  activePermissionProfile: ':workspace',
  source: 'appServer',
  threadSource: 'user',
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [],
  ...extra,
})

function serverRequest(method, params) {
  const id = nextServerRequestId++
  return new Promise((resolve) => {
    pendingServerRequests.set(String(id), resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
}

// `thread/start`: a new thread, announced before the answer unless
// FAKE_CODEX_STARTED_LAST puts it after, as codex 0.159 does.
async function startThread(id, params) {
  if (process.env.FAKE_CODEX_FAIL_START === '1')
    return fail(id, -32000, 'fake child refuses to start a thread')
  const threadId = `fake-thread-${++nextThread}`
  if (params.ephemeral === true) ephemeralThreads.add(threadId)
  const slow = Number(process.env.FAKE_CODEX_SLOW_FIRST_START ?? 0)
  if (slow > 0 && nextThread === 1) await new Promise((resolve) => setTimeout(resolve, slow))
  threadCwds.set(threadId, params.cwd ?? process.cwd())
  const record = thread(threadId)
  started.push(record)
  threadModels.set(threadId, params.model ?? 'gpt-5.6-sol')
  threadInstructions.set(threadId, params.developerInstructions ?? null)
  writeState()
  const last = process.env.FAKE_CODEX_STARTED_LAST === '1'
  if (!last) notify('thread/started', { thread: record })
  respond(id, {
    thread: record,
    model: params.model ?? 'gpt-5.6-sol',
    modelProvider: 'openai',
    cwd: params.cwd ?? process.cwd(),
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite' },
    reasoningEffort: 'medium',
    serviceTier: null,
    instructionSources: [],
    // Not part of the real answer: lets tests see what the adapter sent.
    receivedDeveloperInstructions: params.developerInstructions ?? null,
    receivedBaseInstructions: params.baseInstructions ?? null,
  })
  if (last) notify('thread/started', { thread: record })
}

let memoryConfig = {}
function configState() {
  const path = process.env.FAKE_CODEX_CONFIG
  if (!path) return memoryConfig
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}
function saveConfig(state) {
  const path = process.env.FAKE_CODEX_CONFIG
  if (path) writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
  else memoryConfig = state
}
const configVersion = (state) =>
  `fake-${createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 12)}`
const userConfigFile = () => join(process.env.CODEX_HOME ?? '/nonexistent', 'config.toml')

function writeConfig(id, method, params) {
  const edits =
    method === 'config/value/write'
      ? [{ keyPath: params.keyPath, value: params.value }]
      : Array.isArray(params.edits)
        ? params.edits
        : []
  const state = configState()
  if (params.expectedVersion != null && params.expectedVersion !== configVersion(state)) {
    // codex 0.159's answer to a stale expectedVersion, verbatim.
    return send({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32600,
        data: { config_write_error_code: 'configVersionConflict' },
        message: 'Configuration was modified since last read. Fetch latest version and retry.',
      },
    })
  }
  for (const edit of edits) {
    if (edit.value === null) delete state[edit.keyPath]
    else state[edit.keyPath] = edit.value
  }
  saveConfig(state)
  return respond(id, {
    status: 'ok',
    version: configVersion(state),
    filePath: userConfigFile(),
    overriddenMetadata: null,
  })
}

function readConfig(id, params) {
  const state = configState()
  const user = { type: 'user', file: userConfigFile(), profile: null }
  // ConfigLayerMetadata as codex 0.159 reports it: the default model comes
  // from a system layer, every key written here from the user layer.
  const system = { name: { type: 'system', file: '/etc/codex/config.toml' }, version: 'fake-sys' }
  const fromUser = { name: user, version: configVersion(state) }
  return respond(id, {
    config: {
      model: 'gpt-5.6-sol',
      model_provider: 'openai',
      model_providers: { openai: { name: 'OpenAI' } },
      ...state,
    },
    origins: {
      model: system,
      ...Object.fromEntries(Object.keys(state).map((key) => [key, fromUser])),
    },
    layers: params.includeLayers
      ? [{ name: user, version: configVersion(state), config: state, disabledReason: null }]
      : null,
  })
}

// One spawned child, announced in the recorded shape; returns its id so the
// turn can complete it.
function announceSpawn(threadId, turnId) {
  const requested = process.env.FAKE_CODEX_SPAWN_CHILD
  const inherit = requested === 'inherit'
  const model = inherit ? (threadModels.get(threadId) ?? 'gpt-5.6-sol') : requested
  const childId = `fake-child-${turnId}`
  spawnedChildren.set(childId, { parent: threadId, model })
  const item = (status, receivers, itemModel) => ({
    type: 'collabAgentToolCall',
    id: `${turnId}-spawn`,
    tool: 'spawnAgent',
    status,
    senderThreadId: threadId,
    receiverThreadIds: receivers,
    prompt: 'Reply with exactly the word PONG',
    model: itemModel,
    reasoningEffort: 'low',
    agentsStates:
      receivers.length > 0 ? { [childId]: { status: 'pendingInit', message: null } } : {},
  })
  const link = () =>
    notify('item/completed', { threadId, turnId, item: item('completed', [childId], model) })
  const childOwn = () => {
    if (process.env.FAKE_CODEX_CHILD_THREAD_STARTED === '1') {
      const source = { subAgent: { thread_spawn: { parent_thread_id: threadId, depth: 1 } } }
      notify('thread/started', {
        thread: thread(childId, { parentThreadId: threadId, model, source }),
      })
    }
    notify('thread/status/changed', {
      threadId: childId,
      status: { type: 'active', activeFlags: [] },
    })
    notify('turn/started', {
      threadId: childId,
      turn: { id: `${turnId}-child`, items: [], status: 'inProgress' },
    })
  }
  notify('item/started', { threadId, turnId, item: item('inProgress', [], inherit ? '' : model) })
  notify('thread/status/changed', { threadId: childId, status: { type: 'idle' } })
  if (process.env.FAKE_CODEX_SPAWN_ORDER === 'child-first') {
    childOwn()
    link()
  } else {
    link()
    childOwn()
  }
  return childId
}

// FAKE_CODEX_SPAWN_CHILD: the child a turn spawns, or null.
const maybeSpawn = (threadId, turnId) =>
  process.env.FAKE_CODEX_SPAWN_CHILD ? announceSpawn(threadId, turnId) : null

// The spawned child's turn completes before its parent's.
function finishSpawn(child, turnId) {
  if (!child) return
  notify('thread/status/changed', { threadId: child, status: { type: 'idle' } })
  notify('turn/completed', {
    threadId: child,
    turn: { id: `${turnId}-child`, items: [], status: 'completed', error: null },
  })
}

// A spawned child names its parent in thread/read as codex 0.159's does.
function lineageOf(threadId) {
  const prefix = 'fake-missed-child-of-'
  const spawned = threadId.startsWith(prefix)
    ? { parent: threadId.slice(prefix.length), model: 'opus' }
    : spawnedChildren.get(threadId)
  if (!spawned) return {}
  const thread_spawn = {
    parent_thread_id: spawned.parent,
    depth: 1,
    agent_path: null,
    agent_nickname: 'Fake',
    agent_role: null,
  }
  return {
    parentThreadId: spawned.parent,
    model: spawned.model,
    agentNickname: 'Fake',
    source: { subAgent: { thread_spawn } },
  }
}

async function handleRequest(message) {
  const { id, method } = message
  const params = message.params ?? {}
  if (process.env.FAKE_CODEX_REQUESTS_FILE) {
    appendFileSync(process.env.FAKE_CODEX_REQUESTS_FILE, `${JSON.stringify({ method, params })}\n`)
  }
  switch (method) {
    case 'initialize':
      if (initialized) return fail(id, -32600, 'Already initialized')
      initialized = true
      return respond(id, {
        userAgent: 'codex_app_server/0.153.4 (fake)',
        codexHome: '/tmp/fake-codex-home',
        platformFamily: 'unix',
        platformOs: 'macos',
      })
    case 'thread/start':
      return startThread(id, params)
    case 'thread/resume':
      if (process.env.FAKE_CODEX_FAIL_RESUME === '1')
        return fail(id, -32000, 'fake child cannot resume that thread')
      // Pinned Codex: warm resume ignores overrides; cold resume replaces them.
      if (
        process.env.FAKE_CODEX_COLD_RESUME === '1' &&
        typeof params.developerInstructions === 'string'
      )
        threadInstructions.set(params.threadId, params.developerInstructions)
      writeState()
      return respond(id, {
        thread: thread(params.threadId, {
          ...lineageOf(params.threadId),
          preview: 'resumed by fake',
          turns: threadTurns.get(params.threadId) ?? [],
        }),
        model: 'gpt-5.6-sol',
        modelProvider: 'openai',
        cwd: process.cwd(),
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite' },
        reasoningEffort: 'medium',
        serviceTier: null,
        instructionSources: [],
        receivedDeveloperInstructions: params.developerInstructions ?? null,
      })
    case 'turn/start': {
      const threadId = params.threadId
      const reply = process.env.FAKE_CODEX_REPLY ?? 'PONG'
      if (typeof params.model === 'string' && params.model) threadModels.set(threadId, params.model)
      const turnId = `fake-turn-${++nextTurn}`
      const inputs = turnInputs.get(threadId) ?? []
      inputs.push(params.input ?? [])
      turnInputs.set(threadId, inputs)
      respond(id, { turn: { id: turnId, items: [], status: 'inProgress', error: null } })
      notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress' } })
      const child = maybeSpawn(threadId, turnId)
      if (process.env.FAKE_CODEX_NO_APPROVAL !== '1') {
        const itemId = `${turnId}-cmd`
        notify('item/started', {
          threadId,
          turnId,
          item: { type: 'commandExecution', id: itemId, command: 'ls', status: 'inProgress' },
        })
        // The approval round-trip. The child's id space starts at 1 on purpose:
        // the test client also sends its own request with id 1, so a raw
        // (unrewritten) forward would collide.
        const decision = await serverRequest('item/commandExecution/requestApproval', {
          threadId,
          turnId,
          itemId,
          command: 'ls',
          cwd: process.cwd(),
          reason: null,
        })
        notify('serverRequest/resolved', { threadId, requestId: nextServerRequestId - 1 })
        notify('item/completed', {
          threadId,
          turnId,
          item: {
            type: 'commandExecution',
            id: itemId,
            command: 'ls',
            status: decision?.decision === 'accept' ? 'completed' : 'declined',
            approvalDecision: decision,
          },
        })
      }
      notify('item/agentMessage/delta', {
        threadId,
        turnId,
        itemId: `${turnId}-msg`,
        delta: reply,
      })
      // Remembered as history so a later `thread/read` (and with it a switch
      // back to another engine) sees what was said here.
      const history = threadTurns.get(threadId) ?? []
      history.push({
        id: turnId,
        status: 'completed',
        startedAt: now(),
        completedAt: now(),
        durationMs: 1,
        error: null,
        items: [
          { type: 'userMessage', id: `${turnId}-user`, content: params.input ?? [] },
          { type: 'agentMessage', id: `${turnId}-msg`, text: reply, phase: null },
        ],
      })
      threadTurns.set(threadId, history)
      writeState()
      finishSpawn(child, turnId)
      notify('item/completed', {
        threadId,
        turnId,
        item: { type: 'agentMessage', id: `${turnId}-msg`, text: reply, phase: null },
      })
      notify('turn/completed', {
        threadId,
        turn: { id: turnId, items: [], status: 'completed', error: null },
      })
      return
    }
    case 'thread/list': {
      if (params.parentThreadId || params.ancestorThreadId)
        return respond(id, { data: [], nextCursor: null, backwardsCursor: null })
      if (params.cursor === 'fake-page-2') {
        return respond(id, {
          data: [thread('fake-old', { updatedAt: 10, createdAt: 10 })],
          nextCursor: null,
          backwardsCursor: null,
        })
      }
      return respond(id, {
        data: [
          thread('fake-newest', { updatedAt: 9_000_000_000, createdAt: 9_000_000_000 }),
          ...(process.env.FAKE_CODEX_LIST_STARTED === '1' ? started : []),
          thread('fake-older', { updatedAt: 100, createdAt: 100 }),
        ],
        nextCursor: 'fake-page-2',
        backwardsCursor: null,
      })
    }
    case 'thread/unsubscribe':
      notify('thread/closed', { threadId: params.threadId })
      return respond(id, { status: 'unsubscribed' })
    case 'thread/delete':
      if (ephemeralThreads.has(params.threadId))
        return fail(id, -32600, 'thread is not persisted and cannot be deleted')
      if (process.env.FAKE_CODEX_FAIL_DELETE === '1')
        return fail(id, -32600, 'controlled deletion refusal')
      deletedThreads.add(params.threadId)
      respond(id, {})
      notify('thread/deleted', { threadId: params.threadId })
      return
    case 'thread/read': {
      const target = params.threadId
      if (deletedThreads.has(target)) return fail(id, -32600, 'thread not found')
      if (++nextRead === 1 && process.env.FAKE_CODEX_HOLD_FIRST_READ) {
        while (!existsSync(process.env.FAKE_CODEX_HOLD_FIRST_READ))
          await new Promise((ready) => setTimeout(ready, 10))
        if (process.env.FAKE_CODEX_READ_ACTIVE_TURN === '1')
          notify('turn/started', {
            threadId: target,
            turn: { id: 'held-turn', items: [], status: 'inProgress' },
          })
      }
      if (process.env.FAKE_CODEX_FAIL_READ === '1')
        return fail(id, -32000, 'fake metadata unavailable')
      if (
        process.env.FAKE_CODEX_READ_DELETE_THREAD === '1' &&
        nextRead === Number(process.env.FAKE_CODEX_READ_INVALIDATE_AT ?? 1)
      ) {
        notify('thread/deleted', { threadId: target })
        if (process.env.FAKE_CODEX_READ_REANNOUNCE_THREAD === '1')
          notify('thread/started', { thread: thread(target) })
      }
      if (nextRead === Number(process.env.FAKE_CODEX_READ_ACTIVE_AT))
        notify('turn/started', {
          threadId: target,
          turn: { id: 'read-active', items: [], status: 'inProgress' },
        })
      const lineage = lineageOf(target)
      return respond(id, {
        // `fake: true` marks the answer as the child's, for the routing tests.
        fake: true,
        thread: thread(target, {
          ...lineage,
          model: threadModels.get(target) ?? lineage.model ?? 'gpt-5.6-sol',
          cwd: threadCwds.get(target) ?? threadCwds.get(lineage.parentThreadId) ?? process.cwd(),
          turns: params.includeTurns ? (threadTurns.get(target) ?? []) : [],
        }),
      })
    }
    case 'thread/inject_items': {
      if (process.env.FAKE_CODEX_NO_INJECT === '1')
        return fail(id, -32601, 'thread/inject_items is not supported')
      const existing = injectedItems.get(params.threadId) ?? []
      existing.push(...(params.items ?? []))
      injectedItems.set(params.threadId, existing)
      writeState()
      return respond(id, {})
    }
    case 'thread/loaded/list':
      return respond(id, { data: ['fake-loaded'], nextCursor: null })
    case 'model/list':
      return respond(id, {
        data: [
          {
            id: 'gpt-5.6-sol',
            model: 'gpt-5.6-sol',
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: 'GPT-5.6 Sol',
            description: 'fake',
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text'],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            isDefault: true,
          },
        ],
        nextCursor: null,
      })
    // The real child reports the signed-in ChatGPT account and its usage.
    // FAKE_CODEX_RATE_LIMIT=reached puts it over the Codex limit, the state
    // the desktop reads as "reserve" (test/reserve.test.mts, src/reserve.mts).
    case 'account/read':
      return respond(id, {
        account: { type: 'chatgpt', email: 'fake@example.com', planType: 'pro' },
        requiresOpenaiAuth: true,
      })
    case 'getAuthStatus':
      if (!process.env.CODEX_HOME?.endsWith('/canonical'))
        return respond(id, { fake: true, method, params })
      return respond(id, {
        authMethod: 'chatgpt',
        authToken: params.includeToken === true ? 'FAKE_HOME_BEARER' : null,
        requiresOpenaiAuth: true,
      })
    case 'account/rateLimits/read': {
      const reached = process.env.FAKE_CODEX_RATE_LIMIT === 'reached'
      const rateLimits = {
        limitId: 'codex',
        limitName: 'Codex',
        primary: {
          usedPercent: reached ? 100 : 12,
          resetsAt: now() + 3600,
          windowDurationMins: 300,
        },
        secondary: null,
        credits: null,
        planType: 'pro',
        rateLimitReachedType: reached ? 'rate_limit_reached' : null,
      }
      return respond(id, {
        rateLimits,
        rateLimitsByLimitId: { codex: rateLimits },
        rateLimitUpsell: reached ? { banner_type: 'luna_reserve', ctas: [] } : null,
        accountId: 'fake-account',
      })
    }
    case 'command/exec':
      return respond(id, {
        exitCode: 0,
        stdout: `sandboxed: ${Array.isArray(params.command) ? params.command.at(-1) : ''}\n`,
        stderr: '',
      })
    case 'config/value/write':
    case 'config/batchWrite':
      return writeConfig(id, method, params)
    case 'config/read':
      return readConfig(id, params)
    case 'thread/settings/update':
    case 'thread/metadata/update':
      if (typeof params.model === 'string' && params.model)
        threadModels.set(params.threadId, params.model)
      if (typeof params.cwd === 'string' && params.cwd) threadCwds.set(params.threadId, params.cwd)
      return respond(id, { fake: true, method, params })
    default:
      return respond(id, { fake: true, method, params })
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  const message = JSON.parse(trimmed)
  if (message.method) {
    if (message.id === undefined) return // client notification (initialized)
    void handleRequest(message)
    return
  }
  const resolve = pendingServerRequests.get(String(message.id))
  if (resolve) {
    pendingServerRequests.delete(String(message.id))
    resolve(message.result ?? null)
  }
})
rl.on('close', () => process.exit(0))
// The adapter closes stdin and sends SIGTERM together. Unhandled, a SIGTERM
// that lands while this process is already exiting cuts its V8 coverage file
// short, and one truncated file fails the whole coverage run.
process.on('SIGTERM', () => process.exit(0))
