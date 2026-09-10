#!/usr/bin/env node
// A stand-in for the REAL `codex app-server` speaking JSON-RPC over stdio.
// Used by test/codex-mux.test.mts to prove the native-codex multiplexer
// without spending ChatGPT quota. It records its argv/env to
// FAKE_CODEX_ARGV_FILE, answers initialize / thread/start / thread/resume /
// turn/start (with a couple of notifications and ONE server request that must
// be answered before the turn completes) / thread/list (two pages) /
// model/list / config/read, and echoes anything else back as a `fake` result
// so default-route tests can see the request reached the child.
import { writeFileSync } from 'node:fs'
import readline from 'node:readline'

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

let nextThread = 0
let nextTurn = 0
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
  ephemeral: false,
  modelProvider: 'openai',
  createdAt: now(),
  updatedAt: now(),
  recencyAt: now(),
  status: { type: 'idle' },
  path: null,
  cwd: process.cwd(),
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

async function handleRequest(message) {
  const { id, method } = message
  const params = message.params ?? {}
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
    case 'thread/start': {
      const threadId = `fake-thread-${++nextThread}`
      const record = thread(threadId)
      notify('thread/started', { thread: record })
      return respond(id, {
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
    }
    case 'thread/resume':
      return respond(id, {
        thread: thread(params.threadId, { preview: 'resumed by fake' }),
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
      const turnId = `fake-turn-${++nextTurn}`
      respond(id, { turn: { id: turnId, items: [], status: 'inProgress', error: null } })
      notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress' } })
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
      notify('item/agentMessage/delta', {
        threadId,
        turnId,
        itemId: `${turnId}-msg`,
        delta: 'PONG',
      })
      notify('turn/completed', {
        threadId,
        turn: { id: turnId, items: [], status: 'completed', error: null },
      })
      return
    }
    case 'thread/list': {
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
          thread('fake-older', { updatedAt: 100, createdAt: 100 }),
        ],
        nextCursor: 'fake-page-2',
        backwardsCursor: null,
      })
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
    case 'config/read':
      return respond(id, {
        config: {
          model: 'gpt-5.6-sol',
          model_provider: 'openai',
          model_providers: { openai: { name: 'OpenAI' } },
        },
        origins: { model: { name: 'fake' } },
        layers: null,
      })
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
