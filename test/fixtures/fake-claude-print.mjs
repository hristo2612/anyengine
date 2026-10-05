#!/usr/bin/env node
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
// Ported from EthanSK/claude-in-codex (MIT) test/fixtures/fake-claude.js @ e2adced; see THIRD_PARTY_NOTICES.md.
// Changes: record argv separately; advertise the required print and closed-tool flags.
// Stand-in for the Claude Code CLI: records its argv/stdin and emits stream-json.
import fs from 'node:fs'
import readline from 'node:readline'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log(
    '--print --tools --restricted --disable-slash-commands --permission-prompts --effort --include-partial-messages --resume',
  )
  process.exit(0)
}

const log = process.env.FAKE_CLAUDE_LOG
if (process.env.FAKE_CLAUDE_ARGS_FILE)
  fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(args) + '\n')
let stdin = ''
process.stdin.on('data', (d) => (stdin += d))
process.stdin.on('end', () => {
  const resumeIdx = args.indexOf('--resume')
  const sid =
    resumeIdx >= 0 && !args.includes('--fork-session') ? args[resumeIdx + 1] : crypto.randomUUID()
  if (log) {
    const previous = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).at(-1)
      : null
    let priorGone = true
    if (previous?.pid) {
      try {
        process.kill(previous.pid, 0)
        priorGone = false
      } catch {}
    }
    fs.appendFileSync(
      log,
      JSON.stringify({ args, stdin, cwd: process.cwd(), pid: process.pid, priorGone }) + '\n',
    )
  }
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

  if (args.includes('/compact')) {
    if (args.includes('--disable-slash-commands')) {
      out({ type: 'result', is_error: true, result: 'compact not available' })
      return
    }
    // Real --verbose --output-format json returns an array, often pretty-printed.
    process.stdout.write(
      JSON.stringify(
        [
          { type: 'system', subtype: 'init', session_id: sid },
          { type: 'result', subtype: 'success', is_error: false, result: '', session_id: sid },
        ],
        null,
        2,
      ) + '\n',
    )
    return
  }
  const prompt = JSON.parse(stdin)
    .message.content.map((p) => p.text ?? '')
    .join('')
  if (prompt.startsWith('/config')) {
    const disabled = args.includes('--disable-slash-commands')
    if (!disabled && log) fs.writeFileSync(log + '.slash-effect', 'acceptEdits')
    const result = disabled ? '/config is not available in this environment' : 'updated settings'
    out({ type: 'assistant', message: { content: [{ type: 'text', text: result }] } })
    out({ type: 'result', is_error: false, result, session_id: sid })
    return
  }
  const scenario = process.env.FAKE_CLAUDE_SCENARIO || 'tools'
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake' })
  const msg1 = 'msg_1'
  out({
    type: 'stream_event',
    session_id: sid,
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { id: msg1 } },
  })
  out({
    type: 'stream_event',
    session_id: sid,
    parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
  })
  out({
    type: 'stream_event',
    session_id: sid,
    parent_tool_use_id: null,
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Considering the repo.' },
    },
  })
  out({
    type: 'stream_event',
    session_id: sid,
    parent_tool_use_id: null,
    event: { type: 'content_block_stop', index: 0 },
  })
  out({
    type: 'stream_event',
    session_id: sid,
    parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
  })
  out({
    type: 'stream_event',
    session_id: sid,
    parent_tool_use_id: null,
    event: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: "I'll check " },
    },
  })
  out({
    type: 'stream_event',
    session_id: sid,
    parent_tool_use_id: null,
    event: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'the file.' },
    },
  })
  if (scenario === 'tools') {
    out({
      type: 'stream_event',
      session_id: sid,
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'tu1', name: 'Edit' },
      },
    })
    out({
      type: 'assistant',
      session_id: sid,
      parent_tool_use_id: null,
      message: {
        id: msg1,
        content: [
          { type: 'text', text: "I'll check the file." },
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'Edit',
            input: { file_path: `${process.cwd()}/src/a.ts`, old_string: 'a', new_string: 'b\nc' },
          },
          { type: 'tool_use', id: 'tu2', name: 'WebSearch', input: { query: 'node zstd' } },
        ],
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 5,
          output_tokens: 50,
        },
      },
    })
    out({
      type: 'user',
      session_id: sid,
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'tu2', content: 'results' },
        ],
      },
    })
    const msg2 = 'msg_2'
    out({
      type: 'stream_event',
      session_id: sid,
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: msg2 } },
    })
    out({
      type: 'stream_event',
      session_id: sid,
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Done.' },
      },
    })
    out({
      type: 'assistant',
      session_id: sid,
      parent_tool_use_id: null,
      message: {
        id: msg2,
        content: [{ type: 'text', text: 'Done.' }],
        usage: {
          input_tokens: 20,
          cache_read_input_tokens: 1100,
          cache_creation_input_tokens: 0,
          output_tokens: 5,
        },
      },
    })
  }
  if (scenario === 'plan') {
    const plan = '1. Do X\n2. Do Y'
    out({
      type: 'assistant',
      session_id: sid,
      message: { id: 'plan-message', content: [{ type: 'text', text: plan }] },
    })
    out({ type: 'result', subtype: 'success', is_error: false, result: plan, session_id: sid })
    return
  }
  if (scenario.startsWith('codex-tools')) {
    callCodexTool(sid, msg1, out, scenario).catch((error) => {
      console.error(error)
      process.exit(1)
    })
    return
  }
  if (scenario === 'error') {
    out({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Usage limit reached',
      session_id: sid,
    })
    return
  }
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done.',
    session_id: sid,
    usage: { output_tokens: 55 },
    modelUsage: { 'claude-opus-5-5': { contextWindow: 1000000 } },
  })
})

// Acts as Claude Code's MCP client: lists the bridge's Codex tools, calls one and waits for Codex's result.
async function callCodexTool(sid, messageId, out, scenario) {
  const server = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.codex
  const mcp = spawn(server.command, server.args, {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const replies = new Map()
  readline.createInterface({ input: mcp.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    replies.get(message.id)?.(message)
  })
  let nextId = 0
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId
      replies.set(id, resolve)
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fake-claude', version: '1' },
  })
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  const { result } = await rpc('tools/list', {})
  if (log)
    fs.appendFileSync(
      `${log}.codex-tools`,
      `${JSON.stringify({ tools: result.tools, descriptionLimit: process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, toolTimeout: process.env.MCP_TOOL_TIMEOUT })}\n`,
    )
  const name = process.env.FAKE_CODEX_TOOL || 'codex_app__list_threads'
  const names = name === 'all' ? result.tools.map((tool) => tool.name) : [name]
  const inputs = names.map((name) =>
    result.tools.find((tool) => tool.name === name)?.inputSchema?.required?.includes('input')
      ? { input: 'text(1)' }
      : { limit: 5 },
  )
  out({
    type: 'assistant',
    session_id: sid,
    parent_tool_use_id: null,
    message: {
      id: messageId,
      content: [
        { type: 'text', text: "I'll check the file." },
        ...(scenario === 'codex-tools-unseen'
          ? []
          : names.map((name, i) => ({
              type: 'tool_use',
              id: `tu_codex_${i}`,
              name: `mcp__codex__${name}`,
              input: inputs[i],
            }))),
      ],
    },
  })
  const pendingOutputs = Promise.all(
    names.map((name, i) =>
      rpc('tools/call', {
        name,
        arguments: inputs[i],
        _meta: { 'claudecode/toolUseId': `tu_codex_${i}` },
      }),
    ),
  )
  if (['codex-tools-held', 'codex-tools-overflow'].includes(scenario)) {
    setTimeout(() => {
      out({
        type: 'assistant',
        message: {
          id: 'held-event',
          content: [
            {
              type: 'text',
              text:
                scenario === 'codex-tools-overflow'
                  ? 'x'.repeat(4 * 1024 * 1024)
                  : 'Held commentary.',
            },
          ],
        },
      })
      if (log) fs.writeFileSync(`${log}.events-held`, 'held')
    }, 250)
  }
  const repliesReceived = await pendingOutputs
  const called = { result: { content: repliesReceived.flatMap((reply) => reply.result.content) } }
  if (JSON.stringify(called).includes('HOLD_AFTER_RESULT')) {
    if (log) fs.writeFileSync(`${log}.result-held`, 'held')
    await new Promise(() => {})
  }
  out({
    type: 'user',
    session_id: sid,
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tu_codex', content: called.result.content }],
    },
  })
  const text = `Codex said: ${called.result.content.map((part) => part.text ?? `[${part.type} ${part.mimeType}]`).join(' | ')}`
  out({
    type: 'stream_event',
    session_id: sid,
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { id: 'msg_codex_2' } },
  })
  out({
    type: 'stream_event',
    session_id: sid,
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  })
  out({
    type: 'assistant',
    session_id: sid,
    parent_tool_use_id: null,
    message: { id: 'msg_codex_2', content: [{ type: 'text', text }] },
  })
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: sid,
    usage: { output_tokens: 7 },
  })
  mcp.kill()
}
