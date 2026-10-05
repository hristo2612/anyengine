// Shared vocabulary for the optional, local-only conversation browser.
export type SessionHarness = 'claude' | 'codex'
export interface SessionSummary {
  key: string
  harness: SessionHarness
  id: string
  title: string
  cwd: string
  updatedAt: number
  copied: boolean
  archived?: boolean
}
export interface SessionText {
  role: 'user' | 'assistant'
  text: string
}
export interface SessionSnapshot extends SessionSummary {
  messages: SessionText[]
}
export const COPY_PREFIX = '[AnyEngine from '
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function sessionKey(harness: SessionHarness, id: string): string {
  if (!SESSION_ID.test(id)) throw new Error('Invalid conversation ID')
  return `${harness}:${id}`
}
export function parseSessionKey(key: string): { harness: SessionHarness; id: string } {
  const [harness, id, extra] = key.split(':')
  if (!id || extra || (harness !== 'claude' && harness !== 'codex'))
    throw new Error('Use the claude:UUID or codex:UUID shown by sessions list')
  sessionKey(harness, id)
  return { harness, id }
}
