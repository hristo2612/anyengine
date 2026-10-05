#!/usr/bin/env node
// Fake interactive `claude` CLI for the anyengine runtime tests.
//
// Mimics just enough of the real TUI: reads the `--settings` hooks file, fires
// the configured hook commands with payloads shaped like Claude Code's (stdin
// JSON, stdout reply), accepts prompts via bracketed paste + CR, renders a
// composer line and — on demand — the workspace-trust dialog and a safety
// prompt, and appends assistant messages to a transcript JSONL.
//
// Environment knobs (all optional):
//   FAKE_CLAUDE_ARGS_FILE          append argv as JSON per spawn
//   FAKE_CLAUDE_TRANSCRIPT_DIR     where <session>.jsonl is written
//   FAKE_CLAUDE_TRUST_PROMPT=1     show the trust dialog before the composer
//   FAKE_CLAUDE_OMIT_LAST_MESSAGE=1 omit last_assistant_message from Stop
//   FAKE_CLAUDE_TUI=fullscreen     draw like `"tui": "fullscreen"` on the
//                                  alternate screen: header at the top, the
//                                  composer pinned to the bottom rows under
//                                  the effort line (the adapter's PTY turns
//                                  the alternate screen off, and the real CLI
//                                  then draws the default layout)
//   FAKE_CLAUDE_DEFAULT_MODE       the mode user settings select when no
//                                  --permission-mode is given
//   FAKE_CLAUDE_PROMPT_SUGGESTION=1 an empty composer shows the faint
//                                  `Try "…"` placeholder, the cursor drawn
//                                  inverse on its first letter
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
if (flag('--fixture-env')) Object.assign(process.env, JSON.parse(flag('--fixture-env')))
if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, `${JSON.stringify(args)}\n`)
}
const settings = JSON.parse(fs.readFileSync(flag('--settings'), 'utf8'))
// FAKE_CLAUDE_STALE_RESUME=1: behave like the real CLI when the resumed
// conversation no longer exists (prints the error and exits 1).
if (process.env.FAKE_CLAUDE_STALE_RESUME === '1' && flag('--resume')) {
  process.stdout.write(`No conversation found with session ID: ${flag('--resume')}\n`)
  process.exit(1)
}
const sessionId = flag('--resume') ?? randomUUID()
const transcriptDir = process.env.FAKE_CLAUDE_TRANSCRIPT_DIR ?? os.tmpdir()
const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`)

const write = (text) => process.stdout.write(text)
const composerRule = '─'.repeat(70)
const fullscreen = process.env.FAKE_CLAUDE_TUI === 'fullscreen'
const header = ' ▐▛███▛█   Fake Claude Code'
// As captured from 2.1.287 (test/fixtures/claude-composer-tui-2.1.287.json).
const placeholder = '\x1b[7mT\x1b[27m\x1b[2mry "refactor <filepath>"\x1b[22m'
function composer(prompt = '') {
  const mode = flag('--permission-mode') ?? process.env.FAKE_CLAUDE_DEFAULT_MODE
  const footer =
    mode === 'plan'
      ? '⏸ plan mode on (shift+tab to cycle)'
      : mode === 'acceptEdits'
        ? '⏵⏵ accept edits on (shift+tab to cycle)'
        : mode === 'auto'
          ? '⏵⏵ auto mode on (shift+tab to cycle)'
          : '⏸ manual mode on'
  const lines = prompt.split('\n')
  const collapsed = lines.length > 4 || prompt.length > 400
  const body = collapsed
    ? `[Pasted text #1 +${Math.max(1, lines.length - 1)} lines]`
    : lines.join('\r\n  ')
  const hint =
    !prompt && !['plan', 'acceptEdits', 'auto'].includes(mode) ? ' · ? for shortcuts' : ''
  const status = collapsed
    ? 'paste again to expand'
    : `${footer}${hint}${prompt ? '' : ' · ← for agents'}`
  const input = prompt || process.env.FAKE_CLAUDE_PROMPT_SUGGESTION !== '1' ? body : placeholder
  const frame = `${composerRule}\r\n❯ ${input}\r\n${composerRule}\r\n  ${status}`
  if (!fullscreen) {
    write(`\r\n${frame}\r\n`)
    return
  }
  // The whole screen is redrawn; no newline after the footer, which would
  // scroll the alternate screen.
  const height = 4 + (collapsed ? 1 : lines.length)
  const top = Math.max(2, (process.stdout.rows || 30) - height + 1)
  write(`\x1b[2J\x1b[H${header}\x1b[${top};1H${' '.repeat(50)}◐ medium · /effort\r\n${frame}`)
}

function runHook(command, payload) {
  return new Promise((resolve) => {
    // A hook still running when this process exits gets the terminal's
    // SIGHUP, which can cut its V8 coverage file short and fail the coverage
    // run; the relay is not in the report, so it writes none.
    const child = spawn('/bin/sh', ['-c', command], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.on('close', () => resolve(out))
    child.stdin.end(JSON.stringify(payload))
  })
}

async function fire(event, extra = {}) {
  const payload = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: process.cwd(),
    hook_event_name: event,
    ...extra,
  }
  let out = ''
  for (const matcher of settings.hooks?.[event] ?? []) {
    for (const hook of matcher.hooks ?? []) out += await runHook(hook.command, payload)
  }
  return out
}

function permissionDecision(hookOutput) {
  try {
    const parsed = JSON.parse(hookOutput)
    return parsed.hookSpecificOutput ?? {}
  } catch {
    return {}
  }
}

async function reply(text) {
  fs.appendFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        content: [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })}\n`,
  )
  write(`\r\n⏺ ${text}\r\n`)
  const extra = process.env.FAKE_CLAUDE_OMIT_LAST_MESSAGE ? {} : { last_assistant_message: text }
  await fire('Stop', { stop_hook_active: false, ...extra })
  composer()
}

// Dialog state: options + cursor position, resolved by Enter.
let dialog = null
function showDialog(lines, options, cursor, onSelect) {
  dialog = { options, cursor, onSelect }
  const render = () => {
    write(`\r\n${lines.join('\r\n')}\r\n`)
    for (const [index, option] of options.entries()) {
      write(`${index === dialog.cursor ? '❯' : ' '} ${option}\r\n`)
    }
  }
  render()
  dialog.render = render
}

// Background Task sub-agents as Claude Code 2.1.x runs them: PostToolUse
// answers `async_launched` at once, SubagentStop fires when each agent stops,
// and the result reaches the main agent as an injected <task-notification>
// prompt (UserPromptSubmit) when it is idle, or silently mid-turn (only the
// transcript shows it). Variants, chosen by words in the prompt:
//   ASYNC          idle-time injection, one notification per agent
//   ASYNC_INLINE   both results consumed mid-turn before the first Stop
//   ASYNC_LOST     agent B never stops (exercises the runtime's timeout)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function taskNotification(agent) {
  return [
    '<task-notification>',
    `<task-id>${agent.agentId}</task-id>`,
    `<tool-use-id>${agent.toolUseId}</tool-use-id>`,
    `<output-file>${agent.outputFile}</output-file>`,
    '<status>completed</status>',
    `<summary>Agent "${agent.description}" finished</summary>`,
    `<result>${agent.word}</result>`,
    '</task-notification>',
  ].join('\n')
}

async function launchAsyncAgent(word) {
  const agent = {
    word,
    agentId: `a${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    toolUseId: `toolu_${randomUUID().slice(0, 8)}`,
    description: `Reply ${word}`,
    outputFile: path.join(transcriptDir, `${word}.output`),
  }
  const input = { description: agent.description, prompt: `Reply with exactly: ${word}` }
  await fire('PreToolUse', { tool_name: 'Agent', tool_input: input, tool_use_id: agent.toolUseId })
  write(`\r\n⏺ Agent(${agent.description})\r\n  ⎿  Running in the background\r\n`)
  await fire('PostToolUse', {
    tool_name: 'Agent',
    tool_input: input,
    tool_use_id: agent.toolUseId,
    tool_response: {
      isAsync: true,
      status: 'async_launched',
      agentId: agent.agentId,
      description: agent.description,
      resolvedModel: 'fake',
      prompt: input.prompt,
      outputFile: agent.outputFile,
      canReadOutputFile: true,
    },
  })
  await fire('SubagentStart', { agent_id: agent.agentId, agent_type: 'general-purpose' })
  return agent
}

async function stopAsyncAgent(agent) {
  await fire('SubagentStop', {
    agent_id: agent.agentId,
    agent_type: 'general-purpose',
    agent_transcript_path: path.join(transcriptDir, `agent-${agent.agentId}.jsonl`),
    last_assistant_message: agent.word,
    stop_hook_active: false,
  })
}

// Idle-time delivery: the CLI submits the notification as a prompt.
async function injectNotification(agent, answer) {
  if (interrupted) return
  const prompt = taskNotification(agent)
  fs.appendFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } })}\n`,
  )
  await fire('UserPromptSubmit', { prompt, prompt_id: randomUUID() })
  await reply(answer)
}

async function asyncSubagents(prompt) {
  const a = await launchAsyncAgent('ALPHA')
  const b = await launchAsyncAgent('BRAVO')
  if (prompt.includes('ASYNC_INLINE')) {
    await stopAsyncAgent(a)
    await stopAsyncAgent(b)
    fs.appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: `${taskNotification(a)}\n${taskNotification(b)}` }],
        },
      })}\n`,
    )
    await reply('A=ALPHA B=BRAVO')
    return
  }
  await reply('Both agents are running in the background.')
  await sleep(300)
  await stopAsyncAgent(a)
  await sleep(300)
  await injectNotification(a, 'Got ALPHA, waiting for BRAVO')
  if (prompt.includes('ASYNC_LOST')) return
  await sleep(300)
  await stopAsyncAgent(b)
  await sleep(300)
  await injectNotification(b, 'A=ALPHA B=BRAVO')
}

// One tool call through the PreToolUse relay: replies `done` when the relay
// allows it, `denied: <reason>` when it does not. The tool itself never runs.
async function toolCall(toolName, input, done) {
  const toolUseId = `toolu_${randomUUID().slice(0, 8)}`
  const decision = permissionDecision(
    await fire('PreToolUse', { tool_name: toolName, tool_input: input, tool_use_id: toolUseId }),
  )
  if (decision.permissionDecision !== 'allow') {
    await reply(`denied: ${decision.permissionDecisionReason ?? 'no reason'}`)
    return
  }
  await fire('PostToolUse', {
    tool_name: toolName,
    tool_input: input,
    tool_use_id: toolUseId,
    tool_response: { ok: true },
  })
  await reply(done)
}

async function submit(prompt) {
  const promptId = randomUUID()
  await fire('UserPromptSubmit', { prompt, prompt_id: promptId })
  if (prompt.includes('ASYNC')) {
    await asyncSubagents(prompt)
    return
  }
  const echo = /echo (\S+)/.exec(prompt)
  if (prompt.includes('SAFETY')) {
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`
    const input = { command: 'rm -rf "$X/$y"', description: 'dangerous' }
    await fire('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: toolUseId })
    showDialog(
      [
        'Dangerous rm operation on possibly-empty variable path: "$X/$y"',
        '',
        'Do you want to proceed?',
      ],
      ['1. Yes', '2. No'],
      0,
      async (position) => {
        if (position === 0) {
          await fire('PostToolUse', {
            tool_name: 'Bash',
            tool_input: input,
            tool_use_id: toolUseId,
            tool_response: { stdout: '', stderr: '', interrupted: false },
          })
          await reply('safety approved')
        } else {
          await reply('safety rejected')
        }
      },
    )
    await fire('Notification', {
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    })
    return
  }
  const writeMatch = /WRITE (\S+)/.exec(prompt)
  if (writeMatch) {
    await toolCall('Write', { file_path: writeMatch[1], content: 'x' }, `wrote: ${writeMatch[1]}`)
    return
  }
  // A tool call that fails: Claude Code 2.1.285 reports it through
  // PostToolUseFailure, never PostToolUse. EXECTWICE reports one call twice
  // (its result, then a late failure), which must complete it only once.
  const execFail = /EXEC(FAIL|TWICE) (.+)$/.exec(prompt)
  if (execFail) {
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`
    const call = { tool_name: 'mcp__anyengine__exec', tool_input: { command: execFail[2] } }
    const decision = permissionDecision(
      await fire('PreToolUse', { ...call, tool_use_id: toolUseId }),
    )
    if (decision.permissionDecision !== 'allow') {
      await reply(`denied: ${decision.permissionDecisionReason ?? 'no reason'}`)
      return
    }
    const twice = execFail[1] === 'TWICE'
    const result = { tool_response: { content: 'exit 0: ok' } }
    if (twice) await fire('PostToolUse', { ...call, tool_use_id: toolUseId, ...result })
    const failure = { error: 'exit 1: boom', is_interrupt: false, duration_ms: 5 }
    await fire('PostToolUseFailure', { ...call, tool_use_id: toolUseId, ...failure })
    await reply(twice ? 'exec: twice' : 'exec: failed')
    return
  }
  const execMatch = /EXEC (.+)$/.exec(prompt)
  if (execMatch) {
    await toolCall('mcp__anyengine__exec', { command: execMatch[1] }, 'exec: allowed')
    return
  }
  if (echo) {
    const toolUseId = `toolu_${randomUUID().slice(0, 8)}`
    const input = { command: `echo ${echo[1]}`, description: 'echo' }
    const decision = permissionDecision(
      await fire('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: toolUseId }),
    )
    if (decision.permissionDecision === 'allow') {
      write(`\r\n⏺ Bash(echo ${echo[1]})\r\n  ⎿  ${echo[1]}\r\n`)
      await fire('PostToolUse', {
        tool_name: 'Bash',
        tool_input: input,
        tool_use_id: toolUseId,
        tool_response: { stdout: echo[1], stderr: '', interrupted: false },
      })
      await reply(`ran: ${echo[1]}`)
    } else {
      await reply(`denied: ${decision.permissionDecisionReason ?? 'no reason'}`)
    }
    return
  }
  if (prompt.includes('FAIL')) {
    await fire('StopFailure', { error: 'rate_limit', error_details: 'fake limit' })
    composer()
    return
  }
  if (prompt.includes('SLOW')) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    if (interrupted) return
  }
  await reply(`PONG:${prompt}`)
}

let interrupted = false
let buffer = ''
let pendingPrompt = null
let lateOfferShown = false
function lateOffer() {
  const offer = process.env.FAKE_CLAUDE_LATE_OFFER
  if (!offer || lateOfferShown) return
  lateOfferShown = true
  const known = offer === 'auto'
  showDialog(
    [known ? 'Make auto mode your default permission mode?' : 'Enable an unknown new feature?'],
    known
      ? ['Yes, set auto mode as my default permission mode', 'No, keep manual mode']
      : ['Enable', 'Cancel'],
    0,
    (position) => {
      fs.appendFileSync(process.env.FAKE_CLAUDE_SELECTION_FILE, String(position))
      write('\x1b[2J\x1b[H')
      composer()
    },
  )
}
function onInput(chunk) {
  buffer += chunk
  for (;;) {
    const paste = /\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(buffer)
    if (paste) {
      pendingPrompt = paste[1]
      composer(pendingPrompt)
      lateOffer()
      buffer = buffer.slice(0, paste.index) + buffer.slice(paste.index + paste[0].length)
      continue
    }
    if (buffer.startsWith('\x1b[B') || buffer.startsWith('\x1b[A')) {
      const down = buffer.startsWith('\x1b[B')
      buffer = buffer.slice(3)
      if (dialog) {
        dialog.cursor = Math.max(
          0,
          Math.min(dialog.options.length - 1, dialog.cursor + (down ? 1 : -1)),
        )
        dialog.render()
      }
      continue
    }
    if (buffer.startsWith('\r') || buffer.startsWith('\n')) {
      buffer = buffer.slice(1)
      if (dialog) {
        const current = dialog
        dialog = null
        void current.onSelect(current.cursor)
      } else if (pendingPrompt !== null) {
        const prompt = pendingPrompt
        pendingPrompt = null
        interrupted = false
        write(`\r\n❯ ${prompt}\r\n`)
        void submit(prompt)
      }
      continue
    }
    if (buffer.startsWith('\x1b') && !buffer.startsWith('\x1b[')) {
      buffer = buffer.slice(1)
      interrupted = true
      write('\r\n  Interrupted · What should Claude do instead?\r\n')
      composer()
      continue
    }
    if (buffer.startsWith('\x1b[') && buffer.length < 4) return // partial sequence
    if (buffer.length > 0 && !buffer.startsWith('\x1b')) {
      buffer = buffer.slice(1)
      continue
    }
    return
  }
}

// Handled, a SIGTERM or the terminal's SIGHUP that lands while this process is
// already exiting cannot cut its coverage file short.
process.on('SIGTERM', () => process.exit(0))
process.on('SIGHUP', () => process.exit(0))
for (const signal of ['uncaughtException', 'unhandledRejection']) {
  process.on(signal, (error) => {
    if (process.env.FAKE_CLAUDE_ARGS_FILE) {
      fs.appendFileSync(`${process.env.FAKE_CLAUDE_ARGS_FILE}.err`, `${error?.stack ?? error}\n`)
    }
    process.exit(1)
  })
}
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', onInput)

if (fullscreen) write('\x1b[?1049h')
await fire('SessionStart', {
  source: flag('--resume') ? 'resume' : 'startup',
  model: flag('--model') ?? 'fake',
})
if (process.env.FAKE_CLAUDE_TRUST_PROMPT) {
  showDialog(
    [
      ' Accessing workspace:',
      ` ${process.cwd()}`,
      ' Quick safety check: Is this a project you created or one you trust?',
    ],
    ['No, exit', 'Yes, I trust this folder'],
    0,
    async (position) => {
      if (position === 0) process.exit(1)
      // The real TUI redraws from a clean screen once the dialog is answered.
      write(`\x1b[2J\x1b[H${header}\r\n`)
      composer()
    },
  )
} else {
  write(`\r\n${header}\r\n`)
  composer()
}
