import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type WebSocket, WebSocketServer } from 'ws'
import type { Route } from './codex-mux.mjs'
import type { JsonRpcResponse, RpcPeer, ThreadItem, WireMessage } from './types.mjs'
import {
  adapterHome,
  debugLog,
  ensureParent,
  isCodexOpenAiModel,
  newId,
  socketPathLimit,
  stableHash,
} from './util.mjs'

// Cross-engine bridge, adapter side (docs/guide/bridge.md).
//
// Every engine process the adapter runs (interactive `claude`, `grok agent`,
// the real `codex app-server` child) gets one extra MCP server, `jinn_bridge`
// (src/bridge-mcp.mts), spawned by the engine itself. That process connects
// back here over a loopback unix socket with a per-adapter token and asks for
// sessions and sub-agents on ANY model. Each request is injected into the
// protocol layer through a `BridgePeer`, exactly as if the desktop had sent
// it, so `thread/start` keeps its normal model routing (Claude/Grok locally,
// gpt-* to the native child) and every notification, approval and server
// request the spawned thread produces is teed to the desktop peer that owns
// the calling thread.
//
// Threads spawned here are ordinary threads: they show in the sidebar, can be
// resumed by the desktop, and survive the bridge connection going away.

export const BRIDGE_SERVER_NAME = 'jinn_bridge'
export const BRIDGE_ENV_SOCKET = 'CLAUDE_CODEX_BRIDGE_SOCKET'
export const BRIDGE_ENV_TOKEN = 'CLAUDE_CODEX_BRIDGE_TOKEN'
export const BRIDGE_ENV_THREAD = 'CLAUDE_CODEX_BRIDGE_THREAD'
export const BRIDGE_THREAD_HEADER = 'x-bridge-thread'
export const DEFAULT_WAIT_TIMEOUT_MS = 600_000
// Codex defaults an MCP tool call to 60 s; a spawned turn runs for minutes.
const CODEX_TOOL_TIMEOUT_SEC = 3600
const TRACKER_CAP = 500

export function bridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLAUDE_CODEX_BRIDGE ?? '').trim() !== '0'
}

export function isBridgePeer(peer: RpcPeer): boolean {
  return peer.id.startsWith('bridge:')
}

export interface BridgeThreadInfo {
  id: string
  owner: 'local' | 'upstream'
  cwd: string | null
  model: string | null
  approvalPolicy: string | null
  sandboxMode: string | null
  activeTurnId: string | null
}

export interface BridgeSubagentThreadInput {
  parentThreadId: string
  model: string
  prompt: string
  cwd: string
  name: string | null
  approvalPolicy: string | null
  sandboxMode: string | null
  peer: RpcPeer
}

export type ParentItemPhase = 'begin' | 'end' | 'endMove' | 'lifecycle'

// What the protocol layer (server.mts#bridgeHost) lends the bridge.
export interface BridgeHost {
  handle(peer: RpcPeer, message: WireMessage): Promise<void>
  closePeer(peer: RpcPeer): void
  // The desktop peer notifications for `threadId` (or its nearest non-bridge
  // ancestor) should reach; the primary desktop peer when unknown.
  appPeerFor(threadId: string | null): RpcPeer | null
  threadInfo(threadId: string): BridgeThreadInfo | null
  routeForModel(model: string): Route
  // Fallback caller for engines that cannot carry the thread id in env (the
  // codex child spawns one bridge per process): the single thread with a turn
  // in flight, if there is exactly one.
  soleActiveThread(): string | null
  createSubagentThread(input: BridgeSubagentThreadInput): {
    threadId: string
    agentNickname: string
    agentPath: string
  }
  emitParentItem(
    parentThreadId: string,
    turnId: string,
    item: ThreadItem,
    phase: ParentItemPhase,
  ): void
  supportsCompletedActivity(threadId: string): boolean
}

export interface BridgeControlOptions {
  socketPath?: string
  token?: string
  env?: NodeJS.ProcessEnv
}

export interface BridgeModel {
  id: string
  displayName: string
  provider: 'openai' | 'anthropic' | 'xai'
  isDefault: boolean
}

export interface BridgeTurnOutcome {
  threadId: string
  turnId: string | null
  status: string
  text: string
  error: string | null
}

interface TurnTracker {
  threadId: string
  turnId: string
  deltas: string
  messages: string[]
  status: string | null
  error: string | null
  done: Promise<void>
  resolve: () => void
}

interface PendingHostRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const SANDBOX_DEFAULT = 'workspace-write'
const APPROVAL_DEFAULT = 'on-request'

export class BridgeControl {
  readonly socketPath: string
  readonly token: string
  private readonly host: BridgeHost
  private readonly env: NodeJS.ProcessEnv
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private readonly connections = new Set<BridgeConnection>()
  private readonly trackers = new Map<string, TurnTracker>()
  private readonly latestTurnByThread = new Map<string, string>()

  constructor(host: BridgeHost, options: BridgeControlOptions = {}) {
    this.host = host
    this.env = options.env ?? process.env
    this.socketPath =
      options.socketPath ?? (this.env[BRIDGE_ENV_SOCKET]?.trim() || defaultBridgeSocketPath())
    this.token =
      options.token ?? (this.env[BRIDGE_ENV_TOKEN]?.trim() || randomBytes(24).toString('hex'))
  }

  // ---- engine wiring -------------------------------------------------

  // Env the bridge process needs; `threadId` is the calling thread when the
  // engine runs one process per thread (claude, grok).
  bridgeEnv(threadId: string | null): Record<string, string> {
    const env: Record<string, string> = {
      [BRIDGE_ENV_SOCKET]: this.socketPath,
      [BRIDGE_ENV_TOKEN]: this.token,
    }
    if (threadId) env[BRIDGE_ENV_THREAD] = threadId
    return env
  }

  // Claude Agent SDK / `claude --mcp-config` record entry.
  mcpServerSpec(threadId: string | null): Record<string, unknown> {
    return {
      type: 'stdio',
      command: process.execPath,
      args: [adapterEntry(), 'bridge-mcp'],
      env: this.bridgeEnv(threadId),
    }
  }

  // The App-provided servers (CLAUDE_CODEX_MCP_SERVERS: record, {mcpServers}
  // wrapper or a file path) plus `jinn_bridge` for this thread.
  mergeMcpServers(threadId: string | null, base: unknown): Record<string, unknown> {
    const servers = { ...mcpServerRecord(base) }
    servers[BRIDGE_SERVER_NAME] = this.mcpServerSpec(threadId)
    return servers
  }

  // `-c` overrides for the real `codex app-server` child. The token travels in
  // the child's environment (`env_vars` forwards it to the MCP process), never
  // in argv.
  codexConfigArgs(): string[] {
    const toml = [
      `command=${tomlString(process.execPath)}`,
      `args=[${tomlString(adapterEntry())},${tomlString('bridge-mcp')}]`,
      `env_vars=[${tomlString(BRIDGE_ENV_SOCKET)},${tomlString(BRIDGE_ENV_TOKEN)}]`,
      `tool_timeout_sec=${CODEX_TOOL_TIMEOUT_SEC}`,
      'enabled=true',
    ].join(',')
    return ['-c', `mcp_servers.${BRIDGE_SERVER_NAME}={${toml}}`]
  }

  codexChildEnv(): Record<string, string> {
    return this.bridgeEnv(null)
  }

  // ---- lifecycle -----------------------------------------------------

  async start(): Promise<void> {
    if (this.server) return
    ensureParent(this.socketPath)
    reapStaleSockets(this.socketPath)
    if (existsSync(this.socketPath)) rmSync(this.socketPath, { force: true })
    const server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      if (!this.authorized(req.headers.authorization)) {
        debugLog('bridge.unauthorized', {})
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const header = req.headers[BRIDGE_THREAD_HEADER]
      const callerThreadId = typeof header === 'string' && header.length > 0 ? header : null
      wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, callerThreadId))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.once('listening', resolve)
      server.listen(this.socketPath)
    })
    this.server = server
    this.wss = wss
    debugLog('bridge.listen', { socketPath: this.socketPath })
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) connection.close()
    this.connections.clear()
    const server = this.server
    const wss = this.wss
    this.server = null
    this.wss = null
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()))
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (existsSync(this.socketPath)) rmSync(this.socketPath, { force: true })
  }

  // Every notification the protocol layer or the child emits, whichever peer
  // it went to. Turn text and completion are tracked here so a wait survives
  // the desktop resuming (re-binding) the spawned thread mid-turn.
  onNotification(message: { method: string; params: unknown }): void {
    const params = asRecord(message.params)
    const threadId = typeof params.threadId === 'string' ? params.threadId : null
    switch (message.method) {
      case 'turn/started': {
        const turnId = idOf(asRecord(params.turn))
        if (threadId && turnId) this.tracker(threadId, turnId)
        return
      }
      case 'item/agentMessage/delta': {
        const turnId = typeof params.turnId === 'string' ? params.turnId : null
        if (threadId && turnId && typeof params.delta === 'string')
          this.tracker(threadId, turnId).deltas += params.delta
        return
      }
      case 'item/completed': {
        const turnId = typeof params.turnId === 'string' ? params.turnId : null
        const item = asRecord(params.item)
        if (threadId && turnId && item.type === 'agentMessage' && typeof item.text === 'string')
          this.tracker(threadId, turnId).messages.push(item.text)
        return
      }
      case 'error': {
        const turnId = typeof params.turnId === 'string' ? params.turnId : null
        const message = asRecord(params.error).message
        if (threadId && turnId && typeof message === 'string')
          this.tracker(threadId, turnId).error = message
        return
      }
      case 'turn/completed': {
        const turn = asRecord(params.turn)
        const turnId = idOf(turn)
        if (!threadId || !turnId) return
        const tracker = this.tracker(threadId, turnId)
        tracker.status = typeof turn.status === 'string' ? turn.status : 'completed'
        const error = asRecord(turn.error).message
        if (typeof error === 'string' && !tracker.error) tracker.error = error
        tracker.resolve()
        return
      }
      default:
        return
    }
  }

  // ---- internals -----------------------------------------------------

  private authorized(header: string | undefined): boolean {
    const presented = (header ?? '').replace(/^Bearer\s+/i, '').trim()
    const expected = Buffer.from(this.token)
    const actual = Buffer.from(presented)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  private accept(ws: WebSocket, callerThreadId: string | null): void {
    const connection = new BridgeConnection(this, this.host, ws, callerThreadId)
    this.connections.add(connection)
    ws.once('close', () => {
      this.connections.delete(connection)
      connection.dispose()
    })
    debugLog('bridge.connect', { callerThreadId, connections: this.connections.size })
  }

  tracker(threadId: string, turnId: string): TurnTracker {
    const existing = this.trackers.get(turnId)
    if (existing) return existing
    let resolve: () => void = () => {}
    const done = new Promise<void>((r) => {
      resolve = r
    })
    const tracker: TurnTracker = {
      threadId,
      turnId,
      deltas: '',
      messages: [],
      status: null,
      error: null,
      done,
      resolve,
    }
    this.trackers.set(turnId, tracker)
    this.latestTurnByThread.set(threadId, turnId)
    if (this.trackers.size > TRACKER_CAP) {
      for (const [id, entry] of this.trackers) {
        if (entry.status == null) continue
        this.trackers.delete(id)
        if (this.trackers.size <= TRACKER_CAP / 2) break
      }
    }
    return tracker
  }

  latestTurnId(threadId: string): string | null {
    return this.latestTurnByThread.get(threadId) ?? null
  }

  async waitTurn(tracker: TurnTracker, timeoutMs: number): Promise<BridgeTurnOutcome> {
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(1, timeoutMs))
      timer.unref()
    })
    const result = await Promise.race([tracker.done.then(() => 'done' as const), timeout])
    if (timer) clearTimeout(timer)
    return {
      threadId: tracker.threadId,
      turnId: tracker.turnId,
      status: result === 'timeout' ? 'timeout' : (tracker.status ?? 'completed'),
      text: trackerText(tracker),
      error: tracker.error,
    }
  }
}

// One connected bridge process (= one engine process). Owns a BridgePeer the
// protocol layer sees as the requester of everything this connection spawns.
class BridgeConnection {
  private readonly control: BridgeControl
  private readonly host: BridgeHost
  private readonly ws: WebSocket
  private callerThreadId: string | null
  private readonly peer: RpcPeer
  private readonly pendingHost = new Map<string, PendingHostRequest>()
  private nextId = 0
  private models: BridgeModel[] | null = null

  constructor(
    control: BridgeControl,
    host: BridgeHost,
    ws: WebSocket,
    callerThreadId: string | null,
  ) {
    this.control = control
    this.host = host
    this.ws = ws
    this.callerThreadId = callerThreadId
    this.peer = {
      id: `bridge:${newId()}`,
      send: (message) => this.onPeerMessage(message),
      close: () => {},
    }
    ws.on('message', (data) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
      } catch {
        return
      }
      if (typeof message.method !== 'string') return
      void this.handleControlRequest(
        message.id as JsonRpcResponse['id'],
        message.method,
        message.params,
      )
    })
  }

  close(): void {
    try {
      this.ws.close()
    } catch {}
  }

  dispose(): void {
    // Threads this peer owned fall back to the desktop peer (server.closePeer
    // drops the bindings; the ancestor walk finds the desktop again).
    this.host.closePeer(this.peer)
    for (const pending of this.pendingHost.values()) pending.reject(new Error('bridge closed'))
    this.pendingHost.clear()
  }

  // ---- control RPC (from the bridge MCP process) ------------------------

  private async handleControlRequest(
    id: JsonRpcResponse['id'],
    method: string,
    params: unknown,
  ): Promise<void> {
    const args = asRecord(params)
    try {
      let result: unknown
      switch (method) {
        case 'bridge/models':
          result = { models: await this.listModels(true) }
          break
        case 'bridge/spawnSession':
          result = await this.spawnSession(args)
          break
        case 'bridge/spawnSubagents':
          result = await this.spawnSubagents(args)
          break
        case 'bridge/send':
          result = await this.sendToSession(args)
          break
        case 'bridge/wait':
          result = await this.waitSession(args)
          break
        default:
          throw new Error(`unknown bridge method: ${method}`)
      }
      this.reply({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      debugLog('bridge.requestFailed', { method, message })
      this.reply({ jsonrpc: '2.0', id, error: { code: -32000, message } })
    }
  }

  private reply(message: JsonRpcResponse): void {
    if (this.ws.readyState !== this.ws.OPEN) return
    try {
      this.ws.send(JSON.stringify(message))
    } catch {}
  }

  // ---- tools -----------------------------------------------------------

  private async listModels(refresh = false): Promise<BridgeModel[]> {
    if (this.models && !refresh) return this.models
    const result = asRecord(await this.rpc('model/list', {}))
    const data = Array.isArray(result.data) ? result.data : []
    this.models = data
      .map((entry) => asRecord(entry))
      .filter((entry) => typeof entry.id === 'string' && entry.hidden !== true)
      .map((entry) => ({
        id: String(entry.id),
        displayName: typeof entry.displayName === 'string' ? entry.displayName : String(entry.id),
        provider: providerFor(String(entry.id)),
        isDefault: entry.isDefault === true,
      }))
    return this.models
  }

  private async resolveModel(requested: unknown): Promise<string> {
    const wanted = typeof requested === 'string' ? requested.trim() : ''
    if (!wanted) throw new Error('model is required')
    const models = await this.listModels()
    const lower = wanted.toLowerCase()
    const exact = models.find((m) => m.id.toLowerCase() === lower)
    if (exact) return exact.id
    const byName = models.find((m) => m.displayName.toLowerCase() === lower)
    if (byName) return byName.id
    const loose = lower.replace(/[\s_.-]+/g, '')
    const fuzzy = models.filter((m) => {
      const id = m.id.toLowerCase().replace(/[\s_.-]+/g, '')
      const name = m.displayName.toLowerCase().replace(/[\s_.-]+/g, '')
      return id === loose || name === loose || name.endsWith(loose) || id.startsWith(loose)
    })
    if (fuzzy.length === 1) return fuzzy[0]?.id ?? wanted
    // Unknown ids still route (the mux sends unknown ids to the child), so
    // only refuse when nothing in the catalog is close at all.
    if (fuzzy.length === 0 && models.length > 0) {
      throw new Error(
        `unknown model "${wanted}"; available: ${models.map((m) => `${m.id} (${m.displayName})`).join(', ')}`,
      )
    }
    throw new Error(`ambiguous model "${wanted}": ${fuzzy.map((m) => m.id).join(', ')}`)
  }

  private caller(): BridgeThreadInfo | null {
    if (!this.callerThreadId) {
      const sole = this.host.soleActiveThread()
      if (sole) this.callerThreadId = sole
    }
    return this.callerThreadId ? this.host.threadInfo(this.callerThreadId) : null
  }

  private async spawnSession(args: Record<string, unknown>): Promise<unknown> {
    const model = await this.resolveModel(args.model)
    const prompt = stringArg(args.prompt, 'prompt')
    const caller = this.caller()
    const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : (caller?.cwd ?? process.cwd())
    const started = asRecord(
      await this.rpc('thread/start', {
        cwd,
        model,
        approvalPolicy: caller?.approvalPolicy ?? APPROVAL_DEFAULT,
        sandbox: caller?.sandboxMode ?? SANDBOX_DEFAULT,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      }),
    )
    const threadId = idOf(asRecord(started.thread))
    if (!threadId) throw new Error('thread/start returned no thread id')
    debugLog('bridge.spawnSession', { callerThreadId: this.callerThreadId, threadId, model, cwd })
    if (typeof args.title === 'string' && args.title.trim()) {
      await this.rpc('thread/name/set', { threadId, name: args.title.trim() }).catch(() => null)
    }
    const outcome = await this.runTurn(threadId, prompt, args.wait !== false, timeoutArg(args))
    return { ...outcome, model, cwd }
  }

  private async sendToSession(args: Record<string, unknown>): Promise<unknown> {
    const threadId = stringArg(args.threadId, 'threadId')
    const prompt = stringArg(args.prompt, 'prompt')
    if (!this.host.threadInfo(threadId)) throw new Error(`unknown thread: ${threadId}`)
    return this.runTurn(threadId, prompt, args.wait !== false, timeoutArg(args))
  }

  private async waitSession(args: Record<string, unknown>): Promise<unknown> {
    const threadId = stringArg(args.threadId, 'threadId')
    const info = this.host.threadInfo(threadId)
    if (!info) throw new Error(`unknown thread: ${threadId}`)
    const turnId = info.activeTurnId ?? this.control.latestTurnId(threadId)
    if (!turnId) return { threadId, turnId: null, status: 'idle', text: '', error: null }
    return this.control.waitTurn(this.control.tracker(threadId, turnId), timeoutArg(args))
  }

  private async runTurn(
    threadId: string,
    prompt: string,
    wait: boolean,
    timeoutMs: number,
  ): Promise<BridgeTurnOutcome> {
    const started = asRecord(
      await this.rpc('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      }),
    )
    const turnId = idOf(asRecord(started.turn))
    if (!turnId) throw new Error('turn/start returned no turn id')
    const tracker = this.control.tracker(threadId, turnId)
    if (!wait) return { threadId, turnId, status: 'inProgress', text: '', error: null }
    return this.control.waitTurn(tracker, timeoutMs)
  }

  private async spawnSubagents(args: Record<string, unknown>): Promise<unknown> {
    const tasks = Array.isArray(args.tasks) ? args.tasks.map((task) => asRecord(task)) : []
    if (tasks.length === 0) throw new Error('tasks must be a non-empty array')
    const explicitParent = typeof args.parentThreadId === 'string' ? args.parentThreadId : null
    if (explicitParent) this.callerThreadId = explicitParent
    const parent = this.caller()
    const parentThreadId = this.callerThreadId
    if (!parentThreadId) {
      throw new Error(
        'calling thread unknown: pass parentThreadId (the bridge could not infer which thread is running)',
      )
    }
    const parentTurnId = parent?.activeTurnId ?? null
    const timeoutMs = timeoutArg(args)
    const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : (parent?.cwd ?? process.cwd())
    const used = new Set<string>()
    const results = await Promise.all(
      tasks.map((task, index) =>
        this.runSubagent(
          parentThreadId,
          parent,
          parentTurnId,
          task,
          index,
          cwd,
          timeoutMs,
          used,
        ).catch(
          (error): SubagentResult => ({
            name: typeof task.name === 'string' ? task.name : `task-${index + 1}`,
            threadId: null,
            model: typeof task.model === 'string' ? task.model : null,
            status: 'failed',
            text: '',
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      ),
    )
    return { parentThreadId, parentTurnId, results }
  }

  private async runSubagent(
    parentThreadId: string,
    parent: BridgeThreadInfo | null,
    parentTurnId: string | null,
    task: Record<string, unknown>,
    index: number,
    cwd: string,
    timeoutMs: number,
    usedNames: Set<string>,
  ): Promise<SubagentResult> {
    const model = await this.resolveModel(task.model)
    const prompt = stringArg(task.prompt, `tasks[${index}].prompt`)
    const requestedName =
      typeof task.name === 'string' && task.name.trim() ? task.name.trim() : null
    const name = uniqueName(requestedName ?? `task-${index + 1}`, usedNames)
    const approvalPolicy = parent?.approvalPolicy ?? APPROVAL_DEFAULT
    const sandboxMode = parent?.sandboxMode ?? SANDBOX_DEFAULT
    let childThreadId: string
    let agentNickname: string
    let agentPath: string
    if (this.host.routeForModel(model) === 'local') {
      // Local child: created with the parent linkage the desktop's sub-agent
      // view reads (parentThreadId, agentRole/agentNickname), like a Task.
      ;({
        threadId: childThreadId,
        agentNickname,
        agentPath,
      } = this.host.createSubagentThread({
        parentThreadId,
        model,
        prompt,
        cwd,
        name: requestedName,
        approvalPolicy,
        sandboxMode,
        peer: this.peer,
      }))
    } else {
      // Child-owned (gpt-*) thread: the real app-server allocates it; the
      // parent-side collab items below carry the linkage.
      const started = asRecord(
        await this.rpc('thread/start', {
          cwd,
          model,
          approvalPolicy,
          sandbox: sandboxMode,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        }),
      )
      const id = idOf(asRecord(started.thread))
      if (!id) throw new Error('thread/start returned no thread id')
      childThreadId = id
      agentNickname = nicknameFor(id)
      agentPath = `/root/${agentNickname}`
      if (requestedName)
        await this.rpc('thread/name/set', { threadId: id, name: requestedName }).catch(() => null)
    }
    debugLog('bridge.spawnSubagent', { parentThreadId, parentTurnId, childThreadId, model, name })

    const supportsCompleted = this.host.supportsCompletedActivity(parentThreadId)
    const spawnId = newId()
    const waitId = newId()
    const activity = (kind: 'started' | 'completed' | 'interrupted'): ThreadItem => ({
      type: 'subAgentActivity',
      id: newId(),
      kind,
      agentThreadId: childThreadId,
      agentPath,
    })
    if (parentTurnId) {
      const spawnBegin: ThreadItem = {
        type: 'collabAgentToolCall',
        id: spawnId,
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: parentThreadId,
        receiverThreadIds: [],
        prompt,
        model,
        reasoningEffort: null,
        agentsStates: {},
      }
      this.host.emitParentItem(parentThreadId, parentTurnId, spawnBegin, 'begin')
      this.host.emitParentItem(
        parentThreadId,
        parentTurnId,
        {
          ...spawnBegin,
          status: 'completed',
          receiverThreadIds: [childThreadId],
          agentsStates: { [childThreadId]: { status: 'running', message: null } },
        },
        'end',
      )
      if (supportsCompleted)
        this.host.emitParentItem(parentThreadId, parentTurnId, activity('started'), 'lifecycle')
      const waitBegin: ThreadItem = {
        type: 'collabAgentToolCall',
        id: waitId,
        tool: 'wait',
        status: 'inProgress',
        senderThreadId: parentThreadId,
        receiverThreadIds: [childThreadId],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      }
      this.host.emitParentItem(parentThreadId, parentTurnId, waitBegin, 'begin')
    }

    const outcome = await this.runTurn(childThreadId, prompt, true, timeoutMs)
    const failed = outcome.status !== 'completed'
    if (parentTurnId) {
      if (failed || supportsCompleted) {
        this.host.emitParentItem(
          parentThreadId,
          parentTurnId,
          activity(failed ? 'interrupted' : 'completed'),
          'lifecycle',
        )
      }
      const waitEnd: ThreadItem = {
        type: 'collabAgentToolCall',
        id: waitId,
        tool: 'wait',
        status: failed ? 'failed' : 'completed',
        senderThreadId: parentThreadId,
        receiverThreadIds: [childThreadId],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {
          [childThreadId]: {
            status: failed ? 'errored' : 'completed',
            message: failed ? (outcome.error ?? outcome.status) : null,
          },
        },
      }
      this.host.emitParentItem(parentThreadId, parentTurnId, waitEnd, 'endMove')
    }
    return {
      name,
      threadId: childThreadId,
      model,
      status: outcome.status,
      text: outcome.text,
      error: outcome.error,
    }
  }

  // ---- the BridgePeer: requests into the protocol layer, tee out --------

  private rpc(method: string, params: unknown): Promise<unknown> {
    const id = `b${++this.nextId}`
    return new Promise((resolve, reject) => {
      this.pendingHost.set(id, { resolve, reject })
      void this.host.handle(this.peer, { jsonrpc: '2.0', id, method, params }).catch((error) => {
        this.pendingHost.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  private onPeerMessage(message: WireMessage): void {
    if (!('method' in message) || !message.method) {
      // Response to one of our own requests.
      const response = message as JsonRpcResponse
      const pending = this.pendingHost.get(String(response.id))
      if (!pending) return
      this.pendingHost.delete(String(response.id))
      if (response.error) pending.reject(new Error(response.error.message))
      else pending.resolve(response.result)
      return
    }
    const params = asRecord(message.params)
    const threadId =
      typeof params.threadId === 'string'
        ? params.threadId
        : typeof params.thread_id === 'string'
          ? params.thread_id
          : idOf(asRecord(params.thread))
    if ('id' in message && message.id != null) {
      // Server request (approval, user input) for a thread we requested: it
      // must be answered by a person, so it goes to the desktop. The answer
      // comes back by id through the normal client-response path.
      const app = this.host.appPeerFor(threadId ?? this.callerThreadId)
      if (app) {
        app.send(message)
        return
      }
      debugLog('bridge.serverRequestUnanswerable', { method: message.method, threadId })
      void this.host.handle(this.peer, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'no desktop peer connected to answer the request' },
      })
      return
    }
    // Notification. Thread-scoped ones were addressed to this peer alone
    // (it owns the thread), so the desktop only sees them through us.
    // Thread-less ones are broadcast by the multiplexer to every peer, the
    // desktop included; the one exception is the local `thread/started`
    // the protocol layer sends only to the requester.
    if (threadId == null) return
    const isThreadStarted = message.method === 'thread/started'
    if (isThreadStarted && typeof params.threadId !== 'string') {
      if (this.host.threadInfo(threadId)?.owner !== 'local') return
    }
    this.host.appPeerFor(threadId)?.send(message)
  }
}

interface SubagentResult {
  name: string
  threadId: string | null
  model: string | null
  status: string
  text: string
  error: string | null
}

// ---- helpers ------------------------------------------------------------

export function providerFor(model: string): BridgeModel['provider'] {
  if (isCodexOpenAiModel(model)) return 'openai'
  if (/^grok/i.test(model)) return 'xai'
  return 'anthropic'
}

export function nicknameFor(threadId: string): string {
  return `agent-${threadId.replace(/-/g, '').slice(0, 12)}`
}

export function defaultBridgeSocketPath(): string {
  const preferred = join(adapterHome(), `bridge-${process.pid}.sock`)
  if (preferred.length <= socketPathLimit()) return preferred
  return join(tmpdir(), `ccxb-${stableHash(preferred).slice(0, 12)}-${process.pid}.sock`)
}

// Sockets left by adapters that died without unlinking (pid encoded in the
// name; `kill -0` decides).
function reapStaleSockets(socketPath: string): void {
  const dir = join(socketPath, '..')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return
  }
  for (const entry of readdirSync(dir)) {
    const match = /^(?:bridge|ccxb-[0-9a-f]+)-(\d+)\.sock$/.exec(entry)
    if (!match) continue
    const pid = Number(match[1])
    if (pid === process.pid) continue
    try {
      process.kill(pid, 0)
    } catch {
      try {
        rmSync(join(dir, entry), { force: true })
      } catch {}
    }
  }
}

function adapterEntry(): string {
  return fileURLToPath(new URL('./adapter.mjs', import.meta.url))
}

// JSON string literals are valid TOML basic strings for paths and names.
function tomlString(value: string): string {
  return JSON.stringify(value)
}

export function mcpServerRecord(base: unknown): Record<string, unknown> {
  let value = base
  if (typeof value === 'string') {
    try {
      value = JSON.parse(readFileSync(value, 'utf8'))
    } catch {
      return {}
    }
  }
  const record = asRecord(value)
  if (
    record.mcpServers &&
    typeof record.mcpServers === 'object' &&
    !Array.isArray(record.mcpServers)
  )
    return asRecord(record.mcpServers)
  return record
}

function trackerText(tracker: TurnTracker): string {
  if (tracker.messages.length > 0) return tracker.messages.join('\n\n')
  return tracker.deltas
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name
  let n = 2
  while (used.has(candidate)) candidate = `${name}-${n++}`
  used.add(candidate)
  return candidate
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function timeoutArg(args: Record<string, unknown>): number {
  const value = Number(args.timeoutMs)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_WAIT_TIMEOUT_MS
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function idOf(record: Record<string, unknown>): string | null {
  return typeof record.id === 'string' && record.id.length > 0 ? record.id : null
}
