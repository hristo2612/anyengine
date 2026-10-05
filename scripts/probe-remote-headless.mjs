#!/usr/bin/env node
// The installed CLI host's actual WS protocol, without driving the interactive TUI.
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { verifyUpstreamTurn } from './lib/acceptance-evidence.mjs'
import { scratchNextTo } from './lib/claude-scratch.mjs'

const PONG = 'Reply with exactly the word PONG.'
const one = (rows, label) => {
  if (rows.length !== 1) throw new Error(`expected one correlated ${label}`)
  return rows[0]
}
export async function remoteGptWork(ctx, model) {
  const threadId = await ctx.start(model, true)
  const before = ctx.events().length
  const turn = await ctx.client.turn(threadId, PONG)
  if (
    turn.threadId !== threadId ||
    !ctx.api.successfulPong(turn) ||
    !(await ctx.terminal(threadId, turn.turnId, model)).success
  )
    throw new Error('GPT PONG failed')
  verifyUpstreamTurn({
    events: ctx.events().slice(before),
    owner: ctx.owner(),
    threadId,
    turnId: turn.turnId,
  })
  return turn
}
export class RemoteClient {
  pending = new Map()
  threadStarts = new Map()
  subscribers = new Set()
  sequence = 0
  failure = null
  closing = null
  constructor(ws) {
    this.ws = ws
    ws.on('message', (bytes) => {
      try {
        const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (!message || typeof message !== 'object' || Array.isArray(message))
          throw new Error('invalid remote message')
        this.observeThreadStart(message)
        const pending = this.pending.get(message.id)
        if (pending) {
          this.pending.delete(message.id)
          if (message.error) pending.reject(new Error('remote request failed'))
          else pending.resolve(message.result)
        } else if (message.id != null && message.method) {
          ws.send(
            JSON.stringify({
              id: message.id,
              error: { code: -32601, message: 'probe does not approve requests' },
            }),
          )
        } else for (const listener of this.subscribers) listener(message)
      } catch {
        this.fail(new Error('invalid remote protocol message'))
      }
    })
    ws.on('error', () => this.fail(new Error('remote connection failed')))
    ws.on('close', () => this.fail(new Error('remote connection closed')))
  }
  static async connect(url, token, signal) {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
      handshakeTimeout: 5000,
      maxPayload: 4 * 1024 * 1024,
    })
    const client = new RemoteClient(ws)
    const abort = () => {
      client.fail(new Error('remote probe aborted'))
      ws.terminate()
    }
    signal?.addEventListener('abort', abort, { once: true })
    client.detach = () => signal?.removeEventListener('abort', abort)
    try {
      await new Promise((done, fail) => {
        ws.once('open', done)
        ws.once('error', () => fail(new Error('remote authentication/connect failed')))
        ws.once('close', () => fail(new Error('remote connection closed before readiness')))
        if (signal?.aborted) abort()
      })
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  }
  fail(error) {
    this.failure ??= error
    for (const item of this.pending.values()) item.reject(this.failure)
    this.pending.clear()
    for (const listener of this.subscribers) listener({ closed: this.failure })
    this.subscribers.clear()
  }
  onNotification(listener) {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }
  async startThread(params, local = false, timeoutMs = 30_000) {
    if (
      this.threadStarts.size === 16 ||
      typeof params.model !== 'string' ||
      params.model.length > 256 ||
      typeof params.cwd !== 'string' ||
      params.cwd.length > 4096 ||
      typeof params.ephemeral !== 'boolean'
    )
      throw new Error('remote thread start metadata invalid or bound exceeded')
    const start = {
      model: params.model,
      cwd: params.cwd,
      ephemeral: params.ephemeral,
      local,
      status: 'pending',
      threadId: null,
      kind: null,
      announcements: new Set(),
    }
    return this.request('thread/start', params, timeoutMs, start)
  }
  observeThreadStart(message) {
    const start = this.threadStarts.get(message.id)
    if (start && !message.method) {
      const thread = message.result?.thread
      if (message.error || typeof thread?.id !== 'string' || !thread.id || thread.id.length > 512) {
        start.status = 'unknown-reply'
      } else if (start.threadId && start.threadId !== thread.id) {
        start.status = 'conflicting-reply'
      } else {
        start.threadId = thread.id
        start.kind = start.local ? 'local' : thread.ephemeral === true ? 'ephemeral' : 'persistent'
        if (!['unknown-reply', 'conflicting-reply'].includes(start.status)) start.status = 'replied'
      }
    }
    if (message.method !== 'thread/started') return
    const thread = message.params?.thread
    for (const pending of this.threadStarts.values()) {
      if (pending.status !== 'pending' || thread?.cwd !== pending.cwd) continue
      // Announcements lack request IDs: retain candidates, never grant deletion authority.
      if (typeof thread.id !== 'string' || !thread.id || thread.id.length > 512) continue
      if (pending.announcements.size === 64 && !pending.announcements.has(thread.id))
        throw new Error('remote thread announcement bound exceeded')
      pending.announcements.add(thread.id)
    }
  }
  collectThreadStarts(threads) {
    for (const start of this.threadStarts.values())
      if (start.threadId) threads.set(start.threadId, start.kind)
  }
  verifyThreadCleanup(work, threads, released) {
    this.collectThreadStarts(threads)
    const starts = [...this.threadStarts].map(([requestId, start]) => ({
      requestId,
      ...start,
      announcements: [...start.announcements],
    }))
    if (
      this.ws.readyState !== WebSocket.CLOSED ||
      starts.some((start) => start.status !== 'replied' || !released.has(start.threadId)) ||
      [...threads.keys()].some((id) => !released.has(id))
    ) {
      writeFileSync(
        join(work, 'thread-cleanup.json'),
        `${JSON.stringify({
          status: 'unknown',
          starts,
          owned: [...threads],
          released: [...released],
        })}\n`,
        { flag: 'wx', mode: 0o600 },
      )
      throw new Error('remote thread creation cleanup unknown')
    }
  }
  request(method, params, timeoutMs = 30_000, start) {
    if (this.failure || this.closing)
      return Promise.reject(this.failure ?? new Error('remote client closed'))
    const id = ++this.sequence
    if (start) this.threadStarts.set(id, start)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`remote request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          this.pending.get(id)?.reject(new Error('remote write failed'))
          this.pending.delete(id)
        }
      })
    })
  }
  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'anyengine-remote-probe', version: '1' },
      capabilities: { experimentalApi: true },
    })
    if (typeof result.userAgent !== 'string' || !result.userAgent)
      throw new Error('remote initialize has no user agent')
    this.ws.send(JSON.stringify({ method: 'initialized', params: {} }))
  }
  async turn(threadId, text, timeoutMs = 120_000) {
    const messages = []
    let failure
    let wake = () => {}
    let timer
    const deadline = Date.now() + timeoutMs
    const unsubscribe = this.onNotification((message) => {
      if (message.closed) failure = message.closed
      else if (messages.length === 4096) failure = new Error('remote notification bound exceeded')
      else messages.push(message)
      wake()
    })
    try {
      const result = await this.request(
        'turn/start',
        { threadId, input: [{ type: 'text', text }], effort: 'low' },
        timeoutMs,
      )
      const turnId = result.turn?.id
      if (typeof turnId !== 'string' || !turnId) throw new Error('remote turn identity missing')
      const terminal = () =>
        messages.find(
          (m) =>
            m.method === 'turn/completed' &&
            m.params?.threadId === threadId &&
            m.params?.turn?.id === turnId,
        )
      await new Promise((done, fail) => {
        wake = () => {
          if (failure) fail(failure)
          else if (terminal()) done()
        }
        timer = setTimeout(
          () => fail(new Error('remote turn timed out')),
          Math.max(1, deadline - Date.now()),
        )
        wake()
      })
      const items = messages
        .filter(
          (m) =>
            m.method === 'item/completed' &&
            m.params?.threadId === threadId &&
            m.params?.turnId === turnId,
        )
        .map((m) => m.params.item)
      return {
        threadId,
        turnId,
        status: terminal().params.turn.status,
        error: terminal().params.turn.error,
        items,
        text: items
          .filter((i) => i?.type === 'agentMessage' && typeof i.text === 'string')
          .map((i) => i.text)
          .join('\n'),
        completedAt: new Date().toISOString(),
      }
    } finally {
      clearTimeout(timer)
      unsubscribe()
    }
  }
  async terminal(threadId, turnId, model, cwd, persisted, parent, successfulPong) {
    const { thread } = await this.request('thread/read', { threadId, includeTurns: true })
    if (
      thread?.id !== threadId ||
      (Object.hasOwn(thread, 'model') && thread.model !== model) ||
      thread.cwd !== cwd ||
      (persisted && thread.ephemeral !== false) ||
      (parent &&
        thread.parentThreadId !== parent &&
        thread.source?.subAgent?.thread_spawn?.parent_thread_id !== parent &&
        thread.source?.subagent?.thread_spawn?.parent_thread_id !== parent) ||
      !Array.isArray(thread.turns)
    )
      throw new Error('remote terminal thread/model/cwd/parent mismatch')
    const turn = one(
      thread.turns.filter((t) => t.id === turnId),
      'terminal turn',
    )
    const items = turn.items ?? []
    const pong = successfulPong({
      ...turn,
      items,
      text: items
        .filter((i) => i.type === 'agentMessage')
        .map((i) => i.text)
        .join('\n'),
    })
    return { threadId, turnId, model, status: turn.status, success: pong, pong }
  }
  async releaseThread(threadId, persisted) {
    const value = await this.request('thread/unsubscribe', { threadId })
    if (!['unsubscribed', 'notSubscribed', 'notLoaded'].includes(value.status))
      throw new Error('remote unsubscribe not acknowledged')
    if (!persisted) return
    let timer
    let unsubscribe = () => {}
    const deleted = new Promise((done, fail) => {
      unsubscribe = this.onNotification((m) => {
        if (m.closed) fail(m.closed)
        else if (m.method === 'thread/deleted' && m.params?.threadId === threadId) done()
      })
      timer = setTimeout(() => fail(new Error('remote deletion not observed')), 30_000)
    })
    try {
      await Promise.all([
        deleted,
        this.request('thread/delete', { threadId }).then((result) => {
          if (
            !result ||
            typeof result !== 'object' ||
            Array.isArray(result) ||
            Object.keys(result).length
          )
            throw new Error('remote delete not acknowledged')
        }),
      ])
    } finally {
      clearTimeout(timer)
      unsubscribe()
    }
  }
  close() {
    this.closing ??= new Promise((done) => {
      this.fail(new Error('remote probe closed'))
      this.detach?.()
      if (this.ws.readyState === WebSocket.CLOSED) done()
      else {
        this.ws.once('close', done)
        this.ws.terminate()
      }
    })
    return this.closing
  }
}

export function probeOptions(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const name = args[i]
    if (!['--project', '--mode'].includes(name) || options[name] || !args[i + 1])
      throw new Error('usage: probe-remote-headless.mjs [--mode agent|model] [--project DIR]')
    options[name] = args[++i]
  }
  if (options['--mode'] && !['agent', 'model'].includes(options['--mode']))
    throw new Error('invalid requested mode')
  if (
    options['--project'] &&
    (!isAbsolute(options['--project']) || resolve(options['--project']) !== options['--project'])
  )
    throw new Error('project must be an absolute canonical directory')
  return options
}
async function installed(root) {
  const lib = realpathSync(join(root, 'lib/current'))
  if (resolve(dirname(fileURLToPath(import.meta.url)), '..') !== lib)
    throw new Error(
      'run the probe from the installed lib/current; checkout builds cannot certify this host',
    )
  const load = (name) => import(pathToFileURL(join(lib, 'dist/src', `${name}.mjs`)).href)
  const modules = await Promise.all(
    [
      'smoke',
      'control-system',
      'control-postflight-evidence',
      'smoke-client',
      'smoke-probes',
      'smoke-evidence',
      'smoke-claude',
      'codex-remote',
      'degraded',
      'control-status-evidence',
      'control-layer-state',
      'router-link',
    ].map(load),
  )
  const api = Object.assign({}, ...modules)
  const system = api.realSystem()
  const deps = api.realSmokeDeps(root, api.realFlipDeps(system, root, lib))
  const gate = api.admission(root, deps)
  return { lib, api, system, deps, ...gate }
}
export function requireFixedProject(project) {
  if (
    [tmpdir(), '/tmp']
      .map((path) => realpathSync(path))
      .some((p) => project === p || project.startsWith(`${p}/`))
  )
    throw new Error('Claude project must be fixed outside the temporary directory')
}

export async function runRemoteProbe(args = process.argv.slice(2)) {
  const options = probeOptions(args)
  const root = resolve(process.env.ANYENGINE_ROOT || join(homedir(), '.anyengine'))
  const { api, lib, system, deps, snapshot, verify } = await installed(root)
  const frozen = verify()
  if (options['--mode'] && options['--mode'] !== frozen.mode)
    throw new Error(
      'requested mode differs from frozen configured mode; preferences were not changed',
    )
  const project = options['--project'] || deps.project
  requireFixedProject(project)
  mkdirSync(project, { recursive: true })
  if (!lstatSync(project).isDirectory() || realpathSync(project) !== project)
    throw new Error('Claude project must be a direct canonical directory')
  const work = scratchNextTo(project, '.anyengine-remote-', 'remote protocol probe')
  const debug = join(work, 'debug.jsonl')
  const routerLog = join(root, 'logs/router.jsonl')
  writeFileSync(debug, '', { flag: 'wx', mode: 0o600 })
  const logPins = new Map()
  const begin = new Date().toISOString()
  const threads = new Map()
  const released = new Set()
  const sessions = new Set()
  const controller = new AbortController()
  let launch,
    client,
    receipt,
    identity,
    workError,
    complete = false
  let unsubscribe = () => {}
  const abort = () => {
    controller.abort()
    void client?.close()
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, abort)
  const readLog = (path) => {
    const stat = api.statAt(path)
    const prior = logPins.get(path)
    if (!stat) {
      if (prior || path === debug) throw new Error('remote session log missing')
      return []
    }
    const bytes = api.regularBytes(path, 8_000_000)
    if (
      prior &&
      (stat.dev !== prior.dev ||
        stat.ino !== prior.ino ||
        !bytes.subarray(0, prior.bytes.length).equals(prior.bytes))
    )
      throw new Error('remote session log rotated or lost earlier evidence')
    logPins.set(path, { dev: stat.dev, ino: stat.ino, bytes })
    return api.strictEvents(path)
  }
  const events = () => readLog(debug)
  const routerEvents = () => readLog(routerLog).filter((e) => Date.parse(e.ts) >= Date.parse(begin))
  const check = (name, ok) => {
    if (!ok) throw new Error(`${name} failed`)
    process.stdout.write(`ok ${name}\n`)
  }
  const owner = () => {
    const actual = one(
      system.processes().filter((p) => p.pid === launch.adapter.pid),
      'owned adapter',
    )
    if (
      actual.ppid !== process.pid ||
      !actual.command.includes(join(lib, 'dist/src/adapter.mjs')) ||
      (identity && actual.processStart !== identity.processStart)
    )
      throw new Error('remote adapter process identity drifted')
    return actual
  }
  const collect = () => {
    client?.collectThreadStarts(threads)
    const own = events()
    for (const e of own) {
      if (e.event === 'bridge.spawnSubagent' && threads.has(e.parentThreadId))
        threads.set(e.childThreadId, 'persistent')
      if (
        ['anyengine.session', 'claim.session', 'trampoline.session'].includes(e.event) &&
        (!threads.has(e.threadId) || typeof e.sessionId !== 'string')
      )
        throw new Error('remote session ownership unavailable')
    }
    for (const e of [...own, ...routerEvents()]) {
      if (
        ['anyengine.session', 'claim.session', 'trampoline.session'].includes(e.event) &&
        threads.has(e.threadId)
      )
        sessions.add(e.sessionId)
    }
  }
  const terminal = (id, turn, model, parent) =>
    client.terminal(
      id,
      turn,
      model,
      project,
      threads.get(id) === 'persistent',
      parent,
      api.successfulPong,
    )
  const start = async (model, persisted, local = false) => {
    const value = await client.startThread(
      {
        model,
        ephemeral: !persisted,
        sandbox: model.startsWith('gpt-') ? 'read-only' : 'workspace-write',
        approvalPolicy: model.startsWith('gpt-') ? 'never' : 'on-request',
        cwd: project,
      },
      local,
    )
    const id = value.thread?.id
    if (typeof id !== 'string' || !id) throw new Error('remote thread identity missing')
    threads.set(id, local ? 'local' : value.thread.ephemeral === true ? 'ephemeral' : 'persistent')
    if (value.model !== model || (!local && value.thread.ephemeral !== !persisted))
      throw new Error('remote selected model/persistence mismatch')
    return id
  }
  try {
    events()
    routerEvents()
    launch = await api.startRemoteAdapter(
      deps.adapter,
      deps.adapterEnv({
        CODEX_HOME: deps.codexHome,
        ANYENGINE_HOME: join(work, 'adapter'),
        ANYENGINE_DEBUG_LOG: debug,
        ANYENGINE_PTY_STATE_DIR: join(work, 'pty'),
        ANYENGINE_REAL_CODEX: snapshot.bundled,
      }),
      { signal: controller.signal },
    )
    client = await RemoteClient.connect(launch.url, launch.token, controller.signal)
    unsubscribe = client.onNotification((message) => {
      const item = message.params?.item
      if (
        threads.has(message.params?.threadId) &&
        item?.type === 'collabAgentToolCall' &&
        item.tool === 'spawnAgent' &&
        Array.isArray(item.receiverThreadIds)
      )
        for (const id of item.receiverThreadIds) {
          if (typeof id !== 'string' || !id) throw new Error('invalid spawned identity')
          threads.set(id, 'persistent')
        }
    })
    await client.initialize()
    identity = owner()
    check('initialize', true)
    const { data } = await client.request('model/list', {})
    const claude = snapshot.config.smoke.claudeModel
    check('model/list lists Claude', Array.isArray(data) && data.some((m) => m.model === claude))
    const gpts = data.filter(
      (m) => typeof m.model === 'string' && m.model.startsWith('gpt-') && m.hidden !== true,
    )
    const gpt = (
      snapshot.config.smoke.gptModel
        ? gpts.find((m) => m.model === snapshot.config.smoke.gptModel)
        : gpts.at(-1)
    )?.model
    if (!gpt) throw new Error('GPT smoke model unavailable')
    const link = one(
      events().filter((e) => e.event === 'router.link' && e.pid === identity.pid),
      'router link',
    )
    const spawn = one(
      events().filter((e) => e.event === 'codex.upstream.spawn'),
      'vendor launch',
    )
    const vendor = one(
      system.processes().filter((p) => p.pid === spawn.pid && p.ppid === identity.pid),
      'owned vendor',
    )
    const base = Array.isArray(spawn.args) ? api.appOpenaiBaseUrl(spawn.args) : null
    if (
      spawn.binary !== snapshot.bundled ||
      !vendor.command.includes(snapshot.bundled) ||
      (link.attached === true
        ? !base || base !== link.url || !vendor.command.includes(base)
        : link.attached !== false || base !== null || /openai_base_url\s*=/.test(vendor.command))
    )
      throw new Error('remote vendor identity/router attachment mismatch')
    const native = link.attached === true && link.fanout === 'native'
    if (native) {
      const health = await api.readStatusHealth(
        `${link.url.replace(/\/backend-api\/codex\/?$/, '')}/health`,
      )
      if (
        health.fanout.path !== 'native' ||
        health.version !== frozen.key.lib ||
        !api.sameKey(health.proofKey, frozen.key) ||
        health.mode !== frozen.mode ||
        !api.isProven(root, 'native-fanout', frozen.key)
      )
        throw new Error('actual native eligibility unavailable')
    }
    await remoteGptWork({ api, start, client, terminal, owner, events }, gpt)
    check('GPT PONG', true)
    const local = !(native && frozen.mode === 'model')
    const claudeId = await start(claude, true, local)
    const claudeTurn = await client.turn(claudeId, PONG)
    if (local) api.requirePtySession({ identity, events }, claudeId, claudeTurn.turnId, claude)
    check(
      'Claude PONG',
      api.successfulPong(claudeTurn) &&
        (await terminal(claudeId, claudeTurn.turnId, claude)).success,
    )
    if (native) {
      const parentId = await start(gpt, true)
      const work = await client.turn(
        parentId,
        `Use spawn_agent to start exactly one sub-agent with model "${claude}" whose task is: ${PONG} Wait for it, then reply with its answer only.`,
        300_000,
      )
      const spawn = one(
        work.items.filter((i) => i.type === 'collabAgentToolCall' && i.tool === 'spawnAgent'),
        'native spawn',
      )
      const childId = one(spawn.receiverThreadIds ?? [], 'native receiver')
      if (!threads.has(childId)) throw new Error('native receiver was not observed')
      const completion = one(
        routerEvents().filter(
          (e) =>
            e.event === (frozen.mode === 'agent' ? 'claim.done' : 'trampoline.done') &&
            e.threadId === childId &&
            e.parentThreadId === parentId &&
            e.parentTurnId === work.turnId,
        ),
        'native terminal',
      )
      const claim =
        frozen.mode === 'agent'
          ? one(
              events().filter(
                (e) =>
                  e.event === 'claim.done' &&
                  e.pid === identity.pid &&
                  e.threadId === childId &&
                  e.turnId === completion.turnId,
              ),
              'adapter claim',
            )
          : undefined
      if (claim) api.requirePtySession({ identity, events }, childId, completion.turnId, claude)
      receipt = {
        version: 1,
        kind: 'anyengine-native-fanout',
        ...frozen,
        attempt: randomUUID(),
        startedAt: begin,
        completedAt: new Date().toISOString(),
        effectiveSettings: frozen.key.settings,
        parent: await terminal(parentId, work.turnId, gpt),
        child: await terminal(childId, completion.turnId, claude, parentId),
        owner: {
          pid: identity.pid,
          processStart: identity.processStart,
          root,
          mode: frozen.mode,
          settings: frozen.key.settings,
          after: false,
          closed: false,
        },
        spawn: api.receiptFields(spawn),
        completion: api.receiptFields(completion),
        ...(claim ? { claim: api.receiptFields(claim) } : {}),
        cleanup: { threads: false, sessions: false, processes: false },
      }
      if (!api.successfulPong(work)) throw new Error('native parent did not complete successfully')
    }
    owner()
    verify()
    if (receipt) receipt.owner.after = true
    complete = true
  } catch (error) {
    workError = error
  }
  const settle = async () => {
    let cleanupError
    try {
      collect()
      if (client)
        for (const [id, kind] of [...threads].reverse()) {
          await client.releaseThread(id, kind === 'persistent')
          released.add(id)
        }
    } catch (error) {
      cleanupError = error
    }
    unsubscribe()
    try {
      const settled = await Promise.allSettled([client?.close(), launch?.close()])
      client?.verifyThreadCleanup(work, threads, released)
      if (settled.some((r) => r.status === 'rejected'))
        throw new Error('remote process cleanup incomplete')
      if (cleanupError) throw cleanupError
      collect()
      if ([...threads.keys()].some((id) => !released.has(id)))
        throw new Error('remote owned threads not released')
      const pruned = api.pruneOwnSessions(deps.claudeHome, project, [...sessions])
      if (pruned.missing.length) throw new Error('remote owned Claude session cleanup unknown')
      verify()
      if (receipt) {
        receipt.owner.closed = true
        receipt.cleanup = { threads: true, sessions: true, processes: true }
        api.validateNativeReceipt(
          receipt,
          frozen,
          snapshot.config.smoke.claudeModel,
          snapshot.config.smoke.gptModel,
          new Date(),
        )
      }
      rmSync(work, { recursive: true })
    } catch (error) {
      process.stderr.write(`remote probe evidence retained at ${work}\n`)
      throw error
    } finally {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, abort)
    }
  }
  await settle()
  if (workError) throw workError
  if (!complete) throw new Error('remote checks incomplete')
  if (receipt) check('native spawn claimed', true)
  return 0
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runRemoteProbe()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`FAIL remote protocol probe: ${error.message}\n`)
      process.exitCode = 1
    })
}
