import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk'
import { asRecord } from './rpc-shape.mjs'
import {
  COPY_PREFIX,
  type SessionSnapshot,
  type SessionSummary,
  type SessionText,
  sessionKey,
} from './sessions-types.mjs'

export async function listClaudeSessions(): Promise<SessionSummary[]> {
  const sessions = await listSessions({ limit: 10000, includeProgrammatic: true })
  return sessions.map((s) => ({
    key: sessionKey('claude', s.sessionId),
    harness: 'claude',
    id: s.sessionId,
    title: s.summary || 'Untitled conversation',
    cwd: s.cwd ?? '',
    updatedAt: s.lastModified,
    copied: s.summary.startsWith(COPY_PREFIX),
  }))
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = asRecord(block)
      if (b.type === 'text' && typeof b.text === 'string') return b.text
      // Native tool IDs and instructions cannot be replayed in the other host.
      if (b.type === 'tool_use') return `[Tool: ${String(b.name ?? 'unknown')}]`
      if (b.type === 'tool_result') return `[Tool result]\n${contentText(b.content)}`
      if (b.type === 'image') return '[Image omitted from text copy]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export async function readClaudeSession(session: SessionSummary): Promise<SessionSnapshot> {
  const rows = await getSessionMessages(session.id, session.cwd ? { dir: session.cwd } : {})
  const messages: SessionText[] = []
  for (const row of rows) {
    if (row.type !== 'user' && row.type !== 'assistant') continue
    const text = contentText(asRecord(row.message).content)
    if (text.trim()) messages.push({ role: row.type, text })
  }
  return { ...session, messages }
}

// Claude Code 2.1.289 / SDK 0.3.201 project-key algorithm, including long paths.
export function claudeProjectKey(cwd: string): string {
  try {
    cwd = realpathSync(cwd)
  } catch {
    /* Missing historical workspaces retain their path. */
  }
  if (process.platform === 'darwin') cwd = cwd.normalize('NFC')
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (slug.length <= 200) return slug
  let hash = 0
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0
  return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

export function claudeCopyBody(session: SessionSnapshot, id: string, title: string): string {
  let parentUuid: string | null = null
  const lines = session.messages.map((message, i) => {
    const uuid = randomUUID()
    const line = JSON.stringify({
      type: message.role,
      uuid,
      parentUuid,
      sessionId: id,
      cwd: session.cwd,
      timestamp: new Date(session.updatedAt + i).toISOString(),
      isSidechain: false,
      entrypoint: 'cli',
      userType: 'external',
      message: { role: message.role, content: [{ type: 'text', text: message.text }] },
      anyengineImport: { sourceHarness: session.harness, sourceSessionId: session.id },
    })
    parentUuid = uuid
    return line
  })
  lines.push(JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }))
  return `${lines.join('\n')}\n`
}

export function writeClaudeCopy(session: SessionSnapshot, id: string, title: string): string {
  if (!isAbsolute(session.cwd)) throw new Error('Conversation has no absolute project directory')
  const root = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const dir = join(root, 'projects', claudeProjectKey(session.cwd))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${id}.jsonl`)
  // A fresh, exclusive file: an original or a continued copy is never rewritten.
  writeFileSync(path, claudeCopyBody(session, id, title), { flag: 'wx', mode: 0o600 })
  return path
}
