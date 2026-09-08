#!/usr/bin/env node
// Fake interactive `claude` CLI for the jinn-pty runtime tests.
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
const composer = () => write('\r\n❯ \r\n  ? for shortcuts\r\n')

function runHook(command, payload) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: process.env,
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

async function submit(prompt) {
  const promptId = randomUUID()
  await fire('UserPromptSubmit', { prompt, prompt_id: promptId })
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
function onInput(chunk) {
  buffer += chunk
  for (;;) {
    const paste = /\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(buffer)
    if (paste) {
      pendingPrompt = paste[1]
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

process.on('SIGTERM', () => process.exit(0))
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
      write('\x1b[2J\x1b[H ▐▛███▛█   Fake Claude Code\r\n')
      composer()
    },
  )
} else {
  write('\r\n ▐▛███▛█   Fake Claude Code\r\n')
  composer()
}
