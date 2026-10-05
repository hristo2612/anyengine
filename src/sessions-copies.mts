import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { durableJson, metadataJson, privateDirectory, privateFile } from './accounts-files.mjs'
import { writeClaudeCopy } from './sessions-claude.mjs'
import type { CodexSessions } from './sessions-codex.mjs'
import {
  COPY_PREFIX,
  parseSessionKey,
  type SessionHarness,
  type SessionSnapshot,
  sessionKey,
} from './sessions-types.mjs'

export interface SessionCopy {
  source: string
  revision: string
  target: string
  title: string
  createdAt: number
}
export function copiesDirectory(root: string): string {
  return join(root, 'sessions')
}
export function readCopies(root: string): SessionCopy[] {
  const value = metadataJson(join(copiesDirectory(root), 'copies.json'))
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Invalid session-copy registry; preserve copies.json')
  for (const row of value) {
    if (
      !row ||
      typeof row.source !== 'string' ||
      typeof row.target !== 'string' ||
      typeof row.revision !== 'string' ||
      typeof row.title !== 'string' ||
      !Number.isFinite(row.createdAt)
    )
      throw new Error('Invalid session-copy registry')
    parseSessionKey(row.source)
    parseSessionKey(row.target)
  }
  return value as SessionCopy[]
}

export async function withCopies<T>(root: string, work: () => Promise<T>): Promise<T> {
  const dir = copiesDirectory(root)
  privateDirectory(dir)
  const gate = join(dir, 'copy-lock.sqlite')
  privateFile(gate)
  const db = new DatabaseSync(gate, { timeout: 0 })
  try {
    chmodSync(gate, 0o600)
    db.exec('BEGIN IMMEDIATE')
    return await work()
  } finally {
    db.close()
  }
}

// The digest is a conversation revision for copy reuse, not deployment proof.
function revision(session: SessionSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify([session.title, session.messages]))
    .digest('hex')
}

export async function copySession(
  root: string,
  session: SessionSnapshot,
  target: SessionHarness,
  codex: CodexSessions,
  fresh = false,
): Promise<SessionCopy> {
  if (target === session.harness) throw new Error('Choose the other conversation host')
  if (!session.messages.length) throw new Error('Conversation contains no transferable text')
  return withCopies(root, async () => {
    const copies = readCopies(root)
    const stamp = revision(session)
    const previous = copies.findLast(
      (c) =>
        c.source === session.key &&
        c.revision === stamp &&
        parseSessionKey(c.target).harness === target,
    )
    if (previous && !fresh) {
      // Confirm it still exists: a deleted copy should not strand the source.
      if (target === 'codex') {
        const rows = await codex.list()
        if (rows.some((s) => s.key === previous.target)) return previous
      } else {
        const { listClaudeSessions } = await import('./sessions-claude.mjs')
        if ((await listClaudeSessions()).some((s) => s.key === previous.target)) return previous
      }
    }
    const title = `${COPY_PREFIX}${session.harness === 'claude' ? 'Claude' : 'Codex'}] ${session.title}`
    const id = randomUUID()
    let targetId: string
    if (target === 'claude') {
      writeClaudeCopy(session, id, title)
      targetId = id
    } else {
      // The vendor admits imports only from Claude's native projects directory.
      // A fresh text copy prevents its incremental importer updating a branch.
      const path = writeClaudeCopy(session, id, title)
      const body = readFileSync(path, 'utf8')
      try {
        targetId = await codex.import(path, session.cwd, title)
      } finally {
        if (readFileSync(path, 'utf8') === body) unlinkSync(path)
      }
    }
    const copy: SessionCopy = {
      source: session.key,
      revision: stamp,
      target: sessionKey(target, targetId),
      title,
      createdAt: Date.now(),
    }
    copies.push(copy)
    durableJson(join(copiesDirectory(root), 'copies.json'), copies)
    return copy
  })
}
