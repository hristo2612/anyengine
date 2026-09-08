#!/usr/bin/env node
// Fake `grok` CLI for the grok runtime tests. Speaks just enough of grok's
// agent protocol (`grok agent ... stdio` = Agent Client Protocol JSON-RPC over
// stdio) to prove the adapter's event mapping, resume args and approval
// round-trip without a real xAI login:
//
//   initialize            -> capabilities
//   session/new           -> {sessionId}
//   session/load          -> replays one message chunk (must be ignored), {}
//   session/prompt        -> thought chunk, text chunks, and when the prompt
//                            mentions "tool": tool_call + request_permission
//                            (skipped with --always-approve) + tool_call_update
//   session/cancel        -> answers the pending prompt with stopReason=cancelled
//   `grok models`         -> the catalog listing
//
// Environment knobs:
//   FAKE_GROK_ARGS_FILE      append argv as JSON per spawn
//   FAKE_GROK_EVENTS_FILE    append one JSON line per client request/notification
//   FAKE_GROK_SESSION_ID     session id returned by session/new
//   FAKE_GROK_REPLY          answer text (default "PONG")
//   FAKE_GROK_SLOW_MS        delay before the prompt answers (for cancel tests)
import fs from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
if (process.env.FAKE_GROK_ARGS_FILE) {
  fs.appendFileSync(process.env.FAKE_GROK_ARGS_FILE, `${JSON.stringify(args)}\n`)
}
const record = (entry) => {
  if (process.env.FAKE_GROK_EVENTS_FILE) {
    fs.appendFileSync(process.env.FAKE_GROK_EVENTS_FILE, `${JSON.stringify(entry)}\n`)
  }
}

if (args[0] === 'models') {
  process.stdout.write(
    'You are logged in.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n',
  )
  process.exit(0)
}
if (args[0] !== 'agent' || args[args.length - 1] !== 'stdio') {
  process.stderr.write(`fake-grok: unsupported argv ${JSON.stringify(args)}\n`)
  process.exit(2)
}

const alwaysApprove = args.includes('--always-approve')
const model = args.includes('-m') ? args[args.indexOf('-m') + 1] : 'grok-4.6'
const sessionId = process.env.FAKE_GROK_SESSION_ID ?? 'fake-grok-session-1'
const reply = process.env.FAKE_GROK_REPLY ?? 'PONG'
const slowMs = Number(process.env.FAKE_GROK_SLOW_MS ?? 0)

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const update = (sid, body) =>
  send({ method: 'session/update', params: { sessionId: sid, update: body } })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let nextRequestId = 100
const pendingClientResponses = new Map()
let activePrompt = null
let currentSession = null

function askClient(method, params) {
  const id = nextRequestId++
  send({ id, method, params })
  return new Promise((resolve) => pendingClientResponses.set(id, resolve))
}

async function runPrompt(id, params) {
  const sid = params.sessionId
  const text = params.prompt.map((block) => block.text ?? '').join('')
  activePrompt = { id, cancelled: false }
  update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
  update(sid, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking about it' },
  })
  if (slowMs > 0) await sleep(slowMs)
  if (activePrompt?.cancelled) return finishPrompt(id, 'cancelled')
  if (/tool/i.test(text)) {
    const toolCallId = 'call-fake-1'
    update(sid, {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'run_terminal_command',
      rawInput: { command: 'echo hi', description: 'say hi' },
      _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute', read_only: false } },
    })
    if (!alwaysApprove) {
      const response = await askClient('session/request_permission', {
        sessionId: sid,
        toolCall: {
          toolCallId,
          kind: 'execute',
          title: 'Execute `echo hi`',
          rawInput: { variant: 'Bash', command: 'echo hi', description: 'say hi' },
          _meta: {
            'x.ai/tool': { name: 'run_terminal_command', kind: 'execute', read_only: false },
          },
        },
        options: [
          { optionId: 'always-allow', name: 'Yes, and do not ask again', kind: 'allow_always' },
          { optionId: 'allow-once', name: 'Yes, proceed', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'No', kind: 'reject_once' },
          { optionId: 'reject-always', name: 'No, never', kind: 'reject_always' },
        ],
      })
      record({ kind: 'permission_response', response })
      const optionId = response?.result?.outcome?.optionId ?? null
      if (optionId === null || optionId.startsWith('reject')) {
        update(sid, {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: 'rejected by user' } }],
        })
        update(sid, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'DECLINED' },
        })
        return finishPrompt(id, 'end_turn')
      }
    }
    update(sid, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: '' } }],
    })
    update(sid, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'hi\n' } }],
      rawOutput: {
        type: 'Bash',
        output_for_prompt: 'exit: 0\nhi\n',
        exit_code: 0,
        command: 'echo hi',
      },
    })
  }
  for (const piece of [reply.slice(0, 2), reply.slice(2)]) {
    if (piece)
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } })
  }
  finishPrompt(id, 'end_turn')
}

function finishPrompt(id, stopReason) {
  activePrompt = null
  send({
    id,
    result: {
      stopReason,
      _meta: {
        sessionId: currentSession,
        modelId: model,
        usage: {
          inputTokens: 120,
          outputTokens: 7,
          cachedReadTokens: 64,
          reasoningTokens: 3,
          modelCalls: 1,
          apiDurationMs: 42,
        },
      },
    },
  })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.method == null && message.id != null) {
    const resolve = pendingClientResponses.get(message.id)
    if (resolve) {
      pendingClientResponses.delete(message.id)
      resolve(message)
    }
    return
  }
  record({
    kind: 'request',
    method: message.method,
    params: message.params,
    id: message.id ?? null,
  })
  switch (message.method) {
    case 'initialize':
      send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
        },
      })
      break
    case 'session/new':
      currentSession = sessionId
      send({
        id: message.id,
        result: {
          sessionId,
          models: { currentModelId: model, availableModels: [{ modelId: model, name: 'Fake' }] },
        },
      })
      break
    case 'session/load':
      currentSession = message.params.sessionId
      // History replay: must be ignored by the client.
      update(currentSession, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'REPLAYED-HISTORY' },
      })
      send({ id: message.id, result: {} })
      break
    case 'session/prompt':
      void runPrompt(message.id, message.params)
      break
    case 'session/cancel':
      if (activePrompt) activePrompt.cancelled = true
      break
    default:
      if (message.id != null) {
        send({ id: message.id, error: { code: -32601, message: `unknown ${message.method}` } })
      }
  }
})
rl.on('close', () => process.exit(0))
