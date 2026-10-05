// Structured observations and exact cleanup metadata; never native-proof publication.
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { receiptFields } from '../../dist/src/smoke-evidence.mjs'

export const FANOUT_PROMPT =
  'Start 7 sub-agents: 3 with model "opus" and 4 with your default model. Each one reads README.md in this folder and replies with one sentence about it. Wait for all 7, then return exactly 7 numbered lines, each naming the model and quoting the agent\'s sentence. Do not use a table or additional bullet lists.'
const one = (rows, label) => {
  if (rows.length !== 1) throw new Error(`acceptance expected one ${label}`)
  return rows[0]
}
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512
const success = (work) =>
  work.status === 'completed' &&
  work.error == null &&
  typeof work.text === 'string' &&
  work.text.trim().length > 0

export function verifyUpstreamTurn({ events, owner, threadId, turnId }) {
  const observed = events.filter((e) => e.pid === owner.pid)
  const route = one(
    observed.filter(
      (e) => e.event === 'codex.mux.route' && e.method === 'turn/start' && e.threadId === threadId,
    ),
    'GPT upstream route',
  )
  const forward = one(
    observed.filter(
      (e) =>
        e.event === 'codex.upstream.forward' && e.method === 'turn/start' && e.downId === route.id,
    ),
    'GPT upstream request',
  )
  const response = one(
    observed.filter(
      (e) =>
        e.event === 'codex.upstream.response' &&
        e.method === 'turn/start' &&
        e.downId === route.id &&
        e.upId === forward.upId,
    ),
    'GPT upstream response',
  )
  if (
    route.route !== 'upstream' ||
    response.ok !== true ||
    observed.some(
      (e) => e.event === 'runtime.turn.select' && e.threadId === threadId && e.turnId === turnId,
    )
  )
    throw new Error('acceptance GPT upstream execution absent')
}

function assignAnswers(children, entries) {
  const assigned = new Map()
  const visit = (child, seen) => {
    for (let index = 0; index < entries.length; index++) {
      if (
        seen.has(index) ||
        !entries[index].includes(child.text.trim()) ||
        !entries[index].includes(child.model)
      )
        continue
      seen.add(index)
      if (!assigned.has(index) || visit(assigned.get(index), seen)) {
        assigned.set(index, child)
        return true
      }
    }
    return false
  }
  for (const child of children)
    if (!visit(child, new Set()))
      throw new Error('acceptance missing distinct returned child sentence/model entry')
}

export class AcceptanceThreads {
  starts = []
  owned = new Map()
  released = new Set()
  closed = false
  failure = null
  constructor(client) {
    this.client = client
    this.detach = client.onNotification((message) => {
      if (message.closed) this.closed = true
      const item = message.params?.item
      if (
        ['item/started', 'item/completed'].includes(message.method) &&
        this.owned.has(message.params?.threadId) &&
        item?.type === 'collabAgentToolCall' &&
        item.tool === 'spawnAgent' &&
        item.senderThreadId === message.params.threadId &&
        Array.isArray(item.receiverThreadIds)
      )
        for (const child of item.receiverThreadIds) {
          if (!id(child) || this.owned.size >= 32)
            this.failure = 'invalid/too many child identities'
          else this.owned.set(child, 'persistent')
        }
    })
  }
  start(params, local = false, timeoutMs = 30_000) {
    if (
      this.starts.length >= 16 ||
      !id(params.model) ||
      typeof params.cwd !== 'string' ||
      params.cwd.length > 4096 ||
      typeof params.ephemeral !== 'boolean'
    )
      throw new Error('acceptance invalid start metadata')
    const start = {
      model: params.model,
      cwd: params.cwd,
      local,
      ephemeral: params.ephemeral,
      status: 'pending',
      threadId: null,
      replyIds: [],
    }
    this.starts.push(start)
    return this.client.request('thread/start', params, timeoutMs, (message) => {
      const thread = message.result?.thread
      const reply =
        !Object.hasOwn(message, 'method') &&
        !Object.hasOwn(message, 'error') &&
        message.result &&
        typeof message.result === 'object' &&
        !Array.isArray(message.result)
      if (id(thread?.id) && !start.replyIds.includes(thread.id)) {
        if (start.replyIds.length >= 16) {
          this.failure = 'start reply identity bound'
          return
        }
        start.replyIds.push(thread.id)
      }
      if (reply && id(thread?.id) && !start.threadId) {
        start.threadId = thread.id
        this.owned.set(thread.id, local ? 'local' : params.ephemeral ? 'ephemeral' : 'persistent')
      }
      if (
        !reply ||
        !id(thread?.id) ||
        thread.cwd !== start.cwd ||
        (!local && thread.ephemeral !== params.ephemeral) ||
        message.result?.model !== start.model ||
        (start.threadId && start.threadId !== thread.id)
      ) {
        start.status = 'unknown-reply'
        return
      }
      start.threadId = thread.id
      if (start.status === 'pending') start.status = 'replied'
      this.owned.set(
        thread.id,
        local ? 'local' : thread.ephemeral === true ? 'ephemeral' : 'persistent',
      )
    })
  }
  async release() {
    for (const [threadId, kind] of [...this.owned].reverse()) {
      if (this.released.has(threadId)) continue
      await this.client.releaseThread(threadId, kind === 'persistent')
      this.released.add(threadId)
    }
  }
  verify(work) {
    if (
      !this.closed ||
      this.failure ||
      this.starts.some((s) => s.status !== 'replied' || !this.released.has(s.threadId)) ||
      [...this.owned.keys()].some((thread) => !this.released.has(thread))
    ) {
      writeFileSync(
        join(work, 'thread-cleanup.json'),
        `${JSON.stringify({ status: 'unknown', starts: this.starts, owned: [...this.owned], released: [...this.released], failure: this.failure })}\n`,
        { flag: 'wx', mode: 0o600 },
      )
      throw new Error('acceptance thread cleanup unknown; retain scratch')
    }
  }
}

export function acceptanceFiles(project) {
  const contents = [
    ['README.md', 'A tiny repository for the AnyEngine acceptance run.\n'],
    ['main.txt', "print('hello')\n"],
  ]
  const owned = []
  const remove = () => {
    let failure
    for (const file of owned) {
      try {
        const now = lstatSync(file.path)
        if (
          !now.isFile() ||
          now.dev !== file.stat.dev ||
          now.ino !== file.stat.ino ||
          !readFileSync(file.path).equals(file.bytes)
        )
          throw new Error('acceptance fixture changed; preserve file')
        unlinkSync(file.path)
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) throw failure
  }
  for (const [name] of contents) {
    try {
      lstatSync(join(project, name))
      throw new Error('acceptance fixture name already exists')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  try {
    for (const [name, text] of contents) {
      const path = join(project, name)
      writeFileSync(path, text, { flag: 'wx', mode: 0o600 })
      owned.push({ path, stat: lstatSync(path), bytes: Buffer.from(text) })
    }
    return remove
  } catch (error) {
    remove()
    throw error
  }
}

function nativeChild(f, child, spawns, correlated) {
  const spawn = one(
    spawns.filter(
      (i) => i.receiverThreadIds?.length === 1 && i.receiverThreadIds[0] === child.threadId,
    ),
    'native child spawn',
  )
  if (
    spawn.status !== 'completed' ||
    spawn.senderThreadId !== f.parent.threadId ||
    (spawn.model !== child.model && !(spawn.model == null && child.model === f.model))
  )
    throw new Error('acceptance native spawn identity mismatch')
  const receipts = { spawn: receiptFields(spawn) }
  if (child.model === 'opus') {
    const done = one(
      f.routerEvents.filter(
        (e) =>
          e.event === (f.mode === 'agent' ? 'claim.done' : 'trampoline.done') &&
          correlated(e) &&
          e.parentTurnId === f.parent.turnId,
      ),
      'router child terminal',
    )
    if (
      done.owner !== f.owner.socketPath ||
      (f.mode === 'model' && (done.code !== 0 || !id(done.sessionId)))
    )
      throw new Error('acceptance selected owner/model terminal mismatch')
    receipts.completion = receiptFields(done)
    if (f.mode === 'agent') {
      const claim = one(
        f.events.filter((e) => e.event === 'claim.done' && e.pid === f.owner.pid && correlated(e)),
        'owned adapter claim',
      )
      if (claim.owner !== done.owner || !id(claim.sessionId))
        throw new Error('acceptance actual adapter owner/session mismatch')
      receipts.claim = receiptFields(claim)
    }
  }
  return receipts
}
function bridgeChild(f, child, correlated) {
  const spawn = one(
    f.events.filter(
      (e) =>
        e.event === 'bridge.spawnSubagent' &&
        e.pid === f.owner.pid &&
        e.childThreadId === child.threadId &&
        e.parentThreadId === f.parent.threadId &&
        e.parentTurnId === f.parent.turnId &&
        e.model === child.model,
    ),
    'bridge spawn',
  )
  if (!spawn) throw new Error('acceptance bridge spawn absent')
  const done = one(
    f.events.filter(
      (e) =>
        e.event === 'bridge.subagent.done' &&
        e.pid === f.owner.pid &&
        correlated(e) &&
        e.parentTurnId === f.parent.turnId &&
        e.status === 'completed',
    ),
    'bridge terminal',
  )
  if (f.routerEvents.some((e) => e.event === 'claim.done' && e.threadId === child.threadId))
    throw new Error('acceptance bridge child used native claim')
  return {
    spawn: { ...receiptFields(spawn), childThreadId: spawn.childThreadId },
    completion: receiptFields(done),
  }
}

export function verifyFanout(f) {
  if (!['agent', 'model'].includes(f.mode))
    throw new Error('acceptance configured mode unavailable')
  if (
    !['native', 'bridge'].includes(f.path) ||
    !success(f.parent) ||
    f.children.length !== 7 ||
    new Set(f.children.map((c) => c.threadId)).size !== 7
  )
    throw new Error('acceptance parent/child count or terminal failure')
  const attempts = f.parent.items.filter(
    (i) => i.type === 'collabAgentToolCall' && i.tool === 'spawnAgent',
  )
  if (
    f.path === 'native' &&
    attempts.some(
      (i) =>
        i.status !== 'completed' &&
        (i.status !== 'failed' ||
          i.senderThreadId !== f.parent.threadId ||
          !Array.isArray(i.receiverThreadIds) ||
          i.receiverThreadIds.length !== 0),
    )
  )
    throw new Error('acceptance native spawn attempt has unverified children or status')
  const spawns = attempts.filter((i) => i.status === 'completed')
  if (f.path === 'native' && spawns.length !== 7)
    throw new Error('acceptance native spawn count mismatch')
  if (
    f.children.filter((c) => c.model === 'opus').length !== 3 ||
    f.children.filter((c) => c.model === f.model).length !== 4
  )
    throw new Error('acceptance child model distribution mismatch')
  const entries = f.parent.text.split('\n').filter((line) => /^\s*(?:\d+[.)]|[-*])\s+/.test(line))
  if (entries.length !== 7) throw new Error('acceptance parent must return seven entries')
  const receipts = []
  for (const child of f.children) {
    if (
      !success(child) ||
      child.parentThreadId !== f.parent.threadId ||
      child.cwd !== f.project ||
      child.ephemeral !== (child.kind === 'local')
    )
      throw new Error('acceptance child terminal/lineage mismatch')
    const correlated = (e) =>
      e.threadId === child.threadId &&
      e.parentThreadId === f.parent.threadId &&
      e.turnId === child.turnId &&
      e.model === child.model &&
      e.success === true
    receipts.push(
      f.path === 'native'
        ? nativeChild(f, child, spawns, correlated)
        : bridgeChild(f, child, correlated),
    )
  }
  assignAnswers(f.children, entries)
  return {
    path: f.path,
    mode: f.mode,
    parent: f.parent.threadId,
    turn: f.parent.turnId,
    owner: { pid: f.owner.pid, processStart: f.owner.processStart, socketPath: f.owner.socketPath },
    receipts,
    children: f.children.map(({ threadId, turnId, model, status, text }) => ({
      threadId,
      turnId,
      model,
      status,
      text,
    })),
  }
}
