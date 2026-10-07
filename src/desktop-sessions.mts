// Opt-in projection of local Code metadata. Transcripts and source records stay in place.
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { readConfig } from './anyengine-config.mjs'
import { atomicFile, object, statAt } from './control-layer-state.mjs'
import { withFileLock } from './file-lock.mjs'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const LOCAL = /^local_([a-f0-9-]{36})$/i
const APPS = ['Claude', 'Claude-3p'] as const
interface Folder {
  app: (typeof APPS)[number]
  account: string
  org: string
}
interface Entry extends Folder {
  record: Record<string, unknown>
  sessionId: string
  cliSessionId: string
}
interface Receipt {
  version: 1
  copies: Entry[]
}
const receiptPath = (root: string) => join(root, 'recovery/claude-desktop/sessions.json')
const base = (home: string, app: Folder['app']) =>
  join(home, 'Library/Application Support', app, 'claude-code-sessions')
const folderPath = (home: string, f: Folder) => join(base(home, f.app), f.account, f.org)
const targetPath = (home: string, e: Entry) => join(folderPath(home, e), `${e.sessionId}.json`)

function directory(path: string): boolean {
  return statAt(path)?.isDirectory() === true
}
function children(path: string): string[] {
  return directory(path) ? readdirSync(path).filter((name) => directory(join(path, name))) : []
}
function read(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > 2_000_000)
      throw new Error('Unsupported Desktop session file')
    const bytes = readFileSync(fd)
    if (bytes.length > 2_000_000) throw new Error('Desktop session file exceeds size limit')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } finally {
    closeSync(fd)
  }
}
function validRecord(value: unknown): value is Record<string, unknown> {
  return (
    object(value) &&
    typeof value.sessionId === 'string' &&
    LOCAL.test(value.sessionId) &&
    UUID.test(value.sessionId.slice(6)) &&
    typeof value.cliSessionId === 'string' &&
    UUID.test(value.cliSessionId) &&
    typeof value.cwd === 'string' &&
    isAbsolute(value.cwd) &&
    !/[\x00-\x1f]/.test(value.cwd) &&
    typeof value.title === 'string' &&
    value.title.length <= 10000 &&
    Number.isSafeInteger(value.createdAt) &&
    Number.isSafeInteger(value.lastActivityAt) &&
    typeof value.isArchived === 'boolean'
  )
}
function folders(home: string): Folder[] {
  const out: Folder[] = []
  // Refuse symlinked ancestors as well as account/session files.
  if (!directory(join(home, 'Library')) || !directory(join(home, 'Library/Application Support')))
    return out
  for (const app of APPS) {
    if (!directory(join(home, 'Library/Application Support', app))) continue
    for (const account of children(base(home, app)).filter((x) => UUID.test(x)))
      for (const org of children(join(base(home, app), account)).filter((x) => UUID.test(x)))
        out.push({ app, account, org })
  }
  return out
}
function availableTranscripts(configDir: string): Set<string> {
  const ids = new Set<string>()
  if (!directory(configDir)) return ids
  for (const project of children(join(configDir, 'projects')))
    for (const name of readdirSync(join(configDir, 'projects', project)))
      if (
        name.endsWith('.jsonl') &&
        UUID.test(name.slice(0, -6)) &&
        statAt(join(configDir, 'projects', project, name))?.isFile()
      )
        ids.add(name.slice(0, -6))
  return ids
}
export function listDesktopSessions(home: string, configDir = join(home, '.claude')): Entry[] {
  const transcripts = availableTranscripts(configDir)
  const out: Entry[] = []
  for (const f of folders(home))
    for (const name of readdirSync(folderPath(home, f))) {
      if (!/^local_[a-f0-9-]{36}\.json$/i.test(name)) continue
      try {
        const record = read(join(folderPath(home, f), name))
        if (
          !validRecord(record) ||
          name !== `${record.sessionId}.json` ||
          !transcripts.has(record.cliSessionId as string)
        )
          continue
        // Remote/Cowork/import staging needs the native importer, not a local projection.
        if (
          record.sshConnection ||
          record.sshConnectionId ||
          record.remoteSessionId ||
          record.remoteEnvironmentId ||
          record.wslDistro ||
          record.isCowork ||
          record.stagedTranscriptPath
        )
          continue
        out.push({
          ...f,
          record,
          sessionId: record.sessionId as string,
          cliSessionId: record.cliSessionId as string,
        })
      } catch {
        /* An unreadable or unsupported native record is left alone. */
      }
    }
  return out
}
function receipt(root: string): Receipt {
  const path = receiptPath(root)
  if (!statAt(path)) return { version: 1, copies: [] }
  const value = read(path)
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.copies) ||
    value.copies.length > 100000 ||
    value.copies.some(
      (e) =>
        !object(e) ||
        !APPS.includes(e.app as Folder['app']) ||
        typeof e.account !== 'string' ||
        !UUID.test(e.account) ||
        typeof e.org !== 'string' ||
        !UUID.test(e.org) ||
        !validRecord(e.record) ||
        e.sessionId !== e.record.sessionId ||
        e.cliSessionId !== e.record.cliSessionId,
    )
  )
    throw new Error('Invalid Desktop session recovery receipt; existing sessions retained')
  return value as unknown as Receipt
}
function save(root: string, value: Receipt) {
  atomicFile(receiptPath(root), Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600)
}
function locked<T>(root: string, run: () => T): T {
  mkdirSync(dirname(receiptPath(root)), { recursive: true, mode: 0o700 })
  return withFileLock(`${receiptPath(root)}.lock`, run)
}
function minimal(source: Entry): Record<string, unknown> {
  const r = source.record
  return {
    sessionId: `local_${source.cliSessionId}`,
    cliSessionId: source.cliSessionId,
    cwd: r.cwd,
    originCwd: r.cwd,
    title: r.title,
    createdAt: r.createdAt,
    lastActivityAt: r.lastActivityAt,
    indexedAt: Date.now(),
    isArchived: r.isArchived,
  }
}
function create(home: string, entry: Entry): boolean {
  const path = targetPath(home, entry)
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    writeFileSync(fd, `${JSON.stringify(entry.record, null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return true
}
function project(
  home: string,
  root: string,
  destinations: Folder[],
  rows: Entry[],
  state: Receipt,
  sources: Map<string, Entry>,
): number {
  let created = 0
  for (const f of destinations)
    for (const source of sources.values()) {
      if (
        rows.some(
          (row) =>
            folderPath(home, row) === folderPath(home, f) &&
            row.cliSessionId === source.cliSessionId,
        )
      )
        continue
      const record = minimal(source),
        entry = {
          ...f,
          record,
          sessionId: record.sessionId as string,
          cliSessionId: source.cliSessionId,
        }
      const path = targetPath(home, entry)
      if (statAt(path) || state.copies.some((e) => targetPath(home, e) === path)) continue
      state.copies.push(entry)
      save(root, state) // Intent precedes the exclusive write; originals are never overwritten.
      if (create(home, entry)) created++
      else {
        state.copies.pop()
        save(root, state)
      }
    }
  return created
}
export function syncDesktopSessions(home: string, root: string, configDir = join(home, '.claude')) {
  return locked(root, () => {
    const config = readConfig(root)
    if (config.errors.length) throw new Error(config.errors.join('; '))
    if (!config.config.sessions.desktopAccounts)
      throw new Error('Desktop account sharing is off; run anyengine desktop sessions on')
    const destinations = folders(home),
      rows = listDesktopSessions(home, configDir),
      state = receipt(root)
    let created = 0
    // Retry recorded writes only in existing, ordinary account folders.
    for (const copy of state.copies)
      if (
        destinations.some((f) => folderPath(home, f) === folderPath(home, copy)) &&
        !statAt(targetPath(home, copy)) &&
        availableTranscripts(configDir).has(copy.cliSessionId)
      ) {
        if (create(home, copy)) created++
      }
    const sources = new Map<string, Entry>()
    for (const row of rows)
      if (
        !sources.has(row.cliSessionId) ||
        Number(row.record.lastActivityAt) >
          Number(sources.get(row.cliSessionId)?.record.lastActivityAt ?? -1)
      )
        sources.set(row.cliSessionId, row)
    created += project(home, root, destinations, rows, state, sources)
    return { created, folders: destinations.length, conversations: sources.size }
  })
}
export function removeDesktopSessionCopies(home: string, root: string) {
  return locked(root, () => {
    const state = receipt(root),
      known = new Set(folders(home).map((f) => folderPath(home, f)))
    const retained: Entry[] = []
    let removed = 0
    for (const e of state.copies) {
      if (!known.has(folderPath(home, e))) {
        retained.push(e)
        continue
      }
      const path = targetPath(home, e)
      if (!statAt(path)) continue
      try {
        if (!isDeepStrictEqual(read(path), e.record)) {
          retained.push(e)
          continue
        }
        unlinkSync(path)
        removed++
      } catch {
        retained.push(e)
      }
    }
    save(root, { version: 1, copies: retained })
    return { removed, retained: retained.length }
  })
}
export function desktopSessionStatus(
  home: string,
  root: string,
  configDir = join(home, '.claude'),
) {
  const rows = listDesktopSessions(home, configDir),
    state = receipt(root),
    config = readConfig(root)
  return {
    enabled: config.config.sessions.desktopAccounts,
    folders: folders(home).length,
    conversations: new Set(rows.map((r) => r.cliSessionId)).size,
    ownedCopies: state.copies.length,
    errors: config.errors,
  }
}
