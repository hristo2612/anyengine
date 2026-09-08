import { readFileSync } from 'node:fs'

// Claude Code session transcripts are cumulative JSONL files; every helper
// here scopes its read to lines stamped at or after `afterMs` so one turn is
// never confused with the session to date.

interface TranscriptLine {
  type?: string
  timestamp?: unknown
  message?: { content?: unknown; usage?: Record<string, unknown> }
}

function readLines(transcriptPath: string): TranscriptLine[] {
  let raw: string
  try {
    raw = readFileSync(transcriptPath, 'utf8')
  } catch {
    return []
  }
  const lines: TranscriptLine[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      lines.push(JSON.parse(trimmed) as TranscriptLine)
    } catch {}
  }
  return lines
}

function timestampMs(line: TranscriptLine): number | undefined {
  const raw = line.timestamp
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function inWindow(line: TranscriptLine, afterMs: number | undefined): boolean {
  if (afterMs === undefined) return true
  const ts = timestampMs(line)
  return ts !== undefined && ts >= afterMs
}

// Last assistant text block of the turn — the final message.
export function lastAssistantTextFromTranscript(
  transcriptPath: string,
  afterMs?: number,
): string | undefined {
  let last: string | undefined
  for (const line of readLines(transcriptPath)) {
    if (line.type !== 'assistant' || !inWindow(line, afterMs)) continue
    const content = line.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block) => (block as { type?: string })?.type === 'text')
      .map((block) => String((block as { text?: unknown }).text ?? ''))
      .join('')
    if (text.trim()) last = text
  }
  return last
}

export interface TranscriptUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  assistant_turns: number
}

export function sumTranscriptUsage(transcriptPath: string, afterMs?: number): TranscriptUsage {
  const usage: TranscriptUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    assistant_turns: 0,
  }
  for (const line of readLines(transcriptPath)) {
    if (line.type !== 'assistant' || !inWindow(line, afterMs)) continue
    const u = line.message?.usage
    if (!u) continue
    usage.input_tokens += Number(u.input_tokens ?? 0) || 0
    usage.output_tokens += Number(u.output_tokens ?? 0) || 0
    usage.cache_read_input_tokens += Number(u.cache_read_input_tokens ?? 0) || 0
    usage.cache_creation_input_tokens += Number(u.cache_creation_input_tokens ?? 0) || 0
    usage.assistant_turns += 1
  }
  return usage
}

// Background (async) Task sub-agents report back through a user-role message
// Claude Code injects into the main conversation:
//   <task-notification><task-id>ID</task-id>…<status>completed</status>
//   <result>…</result></task-notification>
// One message can carry several blocks.
export interface TaskNotification {
  taskId: string
  status: string
  result: string
}

const TASK_NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>/gi

export function parseTaskNotifications(text: string): TaskNotification[] {
  const out: TaskNotification[] = []
  if (!text || !/<task-notification>/i.test(text)) return out
  for (const match of text.matchAll(TASK_NOTIFICATION_RE)) {
    const block = match[1] ?? ''
    const taskId = /<task-id>\s*([^<\s]+)\s*<\/task-id>/i.exec(block)?.[1]
    if (!taskId) continue
    out.push({
      taskId,
      status: /<status>\s*([^<\s]*)\s*<\/status>/i.exec(block)?.[1] ?? '',
      result: (/<result>([\s\S]*?)<\/result>/i.exec(block)?.[1] ?? '').trim(),
    })
  }
  return out
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => (block as { type?: string })?.type === 'text')
    .map((block) => String((block as { text?: unknown }).text ?? ''))
    .join('\n')
}

// Task notifications the main agent has already consumed this turn — the CLI
// delivers them mid-turn without a UserPromptSubmit, so the transcript is the
// only witness.
export function taskNotificationsFromTranscript(
  transcriptPath: string,
  afterMs?: number,
): TaskNotification[] {
  const out: TaskNotification[] = []
  for (const line of readLines(transcriptPath)) {
    if (line.type !== 'user' || !inWindow(line, afterMs)) continue
    out.push(...parseTaskNotifications(userText(line.message?.content)))
  }
  return out
}

export function stripReasoningBlocks(text: string): string {
  return text
    .replace(/<\s*(thinking|reasoning|thought)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/^\s*<\s*(thinking|reasoning|thought)\b[^>]*>[\s\S]*$/i, '')
}

export function stripSuggestionBlocks(text: string): string {
  return text.replace(/<\s*suggestion\b[^>]*>[\s\S]*?<\s*\/\s*suggestion\s*>/gi, '')
}

export function sanitizeAssistantText(text: string): string {
  return stripSuggestionBlocks(stripReasoningBlocks(text)).trim()
}
