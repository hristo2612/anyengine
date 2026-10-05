// Exact start replies grant ownership; announcements never retire pending work.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicFile, object } from './control-layer-state.mjs'
import type { PathContext } from './smoke.mjs'
import type { AppServerClient } from './smoke-client.mjs'
import type { AdapterProbe } from './smoke-probes.mjs'

interface Start {
  model: string
  cwd: string
  local: boolean
  ephemeral: boolean
  status: 'pending' | 'replied' | 'unknown'
  threadId: string | null
  requestId: number | null
  replyIds: string[]
}
interface Ledger {
  path: string
  closed: boolean
  failure: boolean
  starts: Start[]
  cleanup?: { status: 'unknown' | 'joined'; releasedReplyIds: string[][] }
}
const ledgers = new WeakMap<AppServerClient, Ledger>()
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512
const bytes = (ledger: Ledger) => Buffer.from(`${JSON.stringify(ledger)}\n`)
function ledgerFor(probe: AdapterProbe, ctx: PathContext): Ledger {
  const known = ledgers.get(probe.client)
  if (known) return known
  const ledger: Ledger = {
    path: join(probe.root, `thread-starts-${ctx.sequence}.json`),
    closed: false,
    failure: false,
    starts: [],
  }
  writeFileSync(ledger.path, bytes(ledger), { flag: 'wx', mode: 0o600 })
  probe.client.onNotification((message) => {
    if (message.closed) ledger.closed = true
  })
  ledgers.set(probe.client, ledger)
  return ledger
}
function observeStart(
  probe: AdapterProbe,
  ledger: Ledger,
  start: Start,
  message: Record<string, any>,
): void {
  start.requestId = message.id
  const thread = message.result?.thread
  const reply =
    !Object.hasOwn(message, 'method') &&
    !Object.hasOwn(message, 'error') &&
    object(message.result) &&
    object(thread)
  if (id(thread?.id) && !start.replyIds.includes(thread.id)) {
    if (start.replyIds.length >= 16) ledger.failure = true
    else start.replyIds.push(thread.id)
  }
  if (reply && id(thread.id) && !start.threadId) {
    start.threadId = thread.id
    probe.threads.set(
      thread.id,
      start.local ? 'local' : thread.ephemeral === true ? 'ephemeral' : 'persistent',
    )
  }
  const valid =
    reply &&
    id(thread.id) &&
    thread.id === start.threadId &&
    thread.cwd === start.cwd &&
    message.result.model === start.model &&
    (start.local || thread.ephemeral === start.ephemeral)
  if (!valid) start.status = 'unknown'
  else if (start.status === 'pending') start.status = 'replied'
  atomicFile(ledger.path, bytes(ledger), 0o600)
}
export async function startProbeThread(
  probe: AdapterProbe,
  ctx: PathContext,
  model: string,
  claude = false,
  persisted = claude,
): Promise<string> {
  const ledger = ledgerFor(probe, ctx)
  if (ledger.starts.length >= 16 || !id(model) || ctx.deps.project.length > 4096)
    throw new Error('smoke pending start bound/metadata invalid')
  const start: Start = {
    model,
    cwd: ctx.deps.project,
    local: claude,
    ephemeral: !persisted,
    status: 'pending',
    threadId: null,
    requestId: null,
    replyIds: [],
  }
  ledger.starts.push(start)
  atomicFile(ledger.path, bytes(ledger), 0o600) // Durable pending operation BEFORE request writes.
  const value = await probe.client.request(
    'thread/start',
    {
      model,
      ephemeral: !persisted,
      sandbox: claude ? 'workspace-write' : 'read-only',
      approvalPolicy: claude ? 'on-request' : 'never',
      cwd: ctx.deps.project,
    },
    30_000,
    (message) => observeStart(probe, ledger, start, message),
  )
  if (
    start.status !== 'replied' ||
    !start.threadId ||
    value.model !== model ||
    value.thread?.id !== start.threadId
  ) {
    start.status = 'unknown'
    atomicFile(ledger.path, bytes(ledger), 0o600)
    throw new Error('smoke thread start identity/model/persistence attribution unknown')
  }
  return start.threadId
}
export function verifyProbeStarts(
  client: AppServerClient | undefined,
  released: AdapterProbe['threads'],
  deleted: Set<string>,
): void {
  const ledger = client && ledgers.get(client)
  if (!ledger) return
  const releasedId = (threadId: string) => released.has(threadId) || deleted.has(threadId)
  const unknown =
    !ledger.closed ||
    ledger.failure ||
    ledger.starts.some(
      (start) =>
        start.status !== 'replied' ||
        !start.threadId ||
        !releasedId(start.threadId) ||
        start.replyIds.some((threadId) => !releasedId(threadId)),
    )
  ledger.cleanup = {
    status: unknown ? 'unknown' : 'joined',
    releasedReplyIds: ledger.starts.map((start) => start.replyIds.filter(releasedId)),
  }
  atomicFile(ledger.path, bytes(ledger), 0o600)
  if (unknown) throw new Error('pending/exact thread start cleanup unknown; retain smoke run')
}
