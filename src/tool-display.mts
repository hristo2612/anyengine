// Ported from EthanSK/claude-in-codex (MIT) src/toolDisplay.js @ e2adced, with changes; see THIRD_PARTY_NOTICES.md.
// Changes: TypeScript, cuts that never split a surrogate pair, and progressLine (new).
import { sep } from 'node:path'
import { sliceStart } from './safe-text.mjs'

export type ToolDisplay =
  | { kind: 'reasoning'; text: string }
  | { kind: 'web'; action: Record<string, unknown> }
  | { kind: 'plan'; plan: unknown }
  | null

type Input = Record<string, unknown>

function rel(file: unknown, cwd: string | null): string {
  if (!file) return ''
  const path = String(file)
  if (cwd && path.startsWith(cwd + sep)) return path.slice(cwd.length + 1)
  return path
}

function lines(s: unknown): number {
  if (!s) return 0
  return String(s).split('\n').length
}

function short(value: unknown, n = 160): string {
  const s = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > n ? `${sliceStart(s, n - 1)}…` : s
}

function fence(code: string, lang = ''): string {
  const tick = code.includes('```') ? '````' : '```'
  return `${tick}${lang}\n${code}\n${tick}`
}

// Returns { kind: 'reasoning', text } | { kind: 'web', action } | { kind: 'plan', plan } | null
export function describeToolUse(
  block: { name?: string; input?: Record<string, unknown> },
  cwd: string | null,
): ToolDisplay {
  const name = block.name || 'tool'
  const input = block.input || {}
  switch (name) {
    case 'Bash': {
      const cmd = String(input.command || '')
      const head = input.description
        ? `**Running:** ${short(input.description, 100)}`
        : '**Running command**'
      return {
        kind: 'reasoning',
        text: `${head}\n\n${fence(cmd.length > 1500 ? `${sliceStart(cmd, 1500)}\n…` : cmd, 'sh')}`,
      }
    }
    case 'BashOutput':
    case 'KillShell':
    case 'KillBash':
      return {
        kind: 'reasoning',
        text: `**${name === 'BashOutput' ? 'Checking background command' : 'Stopping background command'}**`,
      }
    case 'Read':
      return { kind: 'reasoning', text: `**Reading** \`${rel(input.file_path, cwd)}\`` }
    case 'Edit': {
      const removed = lines(input.old_string)
      const added = lines(input.new_string)
      return {
        kind: 'reasoning',
        text: `**Editing** \`${rel(input.file_path, cwd)}\` (+${added} −${removed})`,
      }
    }
    case 'MultiEdit': {
      const edits: Input[] = Array.isArray(input.edits) ? input.edits : []
      const added = edits.reduce((n, e) => n + lines(e.new_string), 0)
      const removed = edits.reduce((n, e) => n + lines(e.old_string), 0)
      return {
        kind: 'reasoning',
        text: `**Editing** \`${rel(input.file_path, cwd)}\` (${edits.length} edits, +${added} −${removed})`,
      }
    }
    case 'Write':
      return {
        kind: 'reasoning',
        text: `**Writing** \`${rel(input.file_path, cwd)}\` (${lines(input.content)} lines)`,
      }
    case 'NotebookEdit':
      return {
        kind: 'reasoning',
        text: `**Editing notebook** \`${rel(input.notebook_path, cwd)}\``,
      }
    case 'Grep':
      return {
        kind: 'reasoning',
        text: `**Searching** for \`${short(input.pattern, 80)}\`${input.path ? ` in \`${rel(input.path, cwd)}\`` : ''}`,
      }
    case 'Glob':
      return { kind: 'reasoning', text: `**Finding files** \`${short(input.pattern, 80)}\`` }
    case 'LS':
      return { kind: 'reasoning', text: `**Listing** \`${rel(input.path, cwd) || '.'}\`` }
    case 'WebSearch':
      return { kind: 'web', action: { type: 'search', query: String(input.query || '') } }
    case 'WebFetch':
      return { kind: 'web', action: { type: 'open_page', url: String(input.url || '') } }
    case 'TodoWrite': {
      const todos: Input[] = Array.isArray(input.todos) ? input.todos : []
      const list = todos
        .map((t) => {
          const box = t.status === 'completed' ? '[x]' : '[ ]'
          const now = t.status === 'in_progress' ? ' ← in progress' : ''
          return `- ${box} ${t.content}${now}`
        })
        .join('\n')
      return { kind: 'reasoning', text: `**Updated plan**\n\n${list}` }
    }
    case 'Task':
    case 'Agent':
      return {
        kind: 'reasoning',
        text: `**Delegating to ${input.subagent_type ? `\`${input.subagent_type}\` ` : ''}subagent:** ${short(input.description || input.prompt, 140)}`,
      }
    case 'ExitPlanMode':
      return { kind: 'plan', plan: String(input.plan || '') }
    case 'Skill':
      return { kind: 'reasoning', text: `**Using skill** \`${input.skill || input.name || ''}\`` }
    case 'AskUserQuestion':
      return null
    default: {
      if (name.startsWith('mcp__')) {
        const [, server, ...tool] = name.split('__')
        return {
          kind: 'reasoning',
          text: `**${server} · ${tool.join('__')}** ${short(JSON.stringify(input), 140)}`,
        }
      }
      return { kind: 'reasoning', text: `**${name}** ${short(JSON.stringify(input), 140)}` }
    }
  }
}

export function describeToolError(name: string, content: unknown, description?: string): string {
  let text = content
  if (Array.isArray(content)) {
    text = content
      .map((c) => (c && typeof c === 'object' ? (c as Input).text : '') || '')
      .join('\n')
  }
  text = String(text ?? '').trim()
  const nonEmpty = String(text)
    .split('\n')
    .filter((l) => l.trim())
  // Claude Code reports a non-zero shell exit as "Exit code N" followed by the command's output.
  // That first line alone ("Bash failed: Exit code 1") says nothing, so name the command the same
  // way the Running line did and show the output's last line, which is usually the actual error
  // (e.g. "could not create image from display").
  const exit = name === 'Bash' && nonEmpty[0]?.match(/^Exit code (\d+)$/)
  if (exit) {
    const head = description ? `**Failed:** ${short(description, 100)}` : '**Command failed**'
    const last =
      nonEmpty.length > 1 ? `\n\n${fence(short(nonEmpty[nonEmpty.length - 1], 220))}` : ''
    return `${head} (exit ${exit[1]})${last}`
  }
  const first = nonEmpty[0] || 'failed'
  return `**${name || 'Tool'} failed:** ${short(first, 220)}`
}

// One line for a claimed turn's progress (the reasoning summary Codex shows
// under a sub-agent): what ran, without output, at most 160 characters.
export function progressLine(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string | null,
): string {
  const rel = (file: unknown) => {
    const path = typeof file === 'string' ? file : ''
    return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
  }
  const one = (text: string) => {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > 150 ? `${sliceStart(flat, 149)}…` : flat
  }
  switch (toolName) {
    case 'Bash':
    case 'mcp__anyengine__exec':
      return one(`Ran \`${String(input.command ?? input.cmd ?? '')}\``)
    case 'Read':
      return one(`Read \`${rel(input.file_path)}\``)
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return one(`Edited \`${rel(input.file_path)}\``)
    case 'Grep':
    case 'Glob':
      return one(`Searched for \`${String(input.pattern ?? '')}\``)
    default:
      return one(`Used ${toolName}`)
  }
}
