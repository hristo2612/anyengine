import {
  appendBridgeInstructions,
  type BridgeCatalogModel,
  providerFor,
} from './bridge-instructions.mjs'
import type { CodexUpstream } from './codex-upstream.mjs'
import {
  type Engine,
  engineForModel,
  formatTranscript,
  injectItemsFor,
  transcriptEntriesFromTurns,
} from './rehome.mjs'
import type { SessionStore } from './store.mjs'
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  RpcPeer,
  ThreadEngineRecord,
  WireMessage,
} from './types.mjs'
import { claudeModelOptions, codexExecRouteEnabled, debugLog, isCodexOpenAiModel } from './util.mjs'

// Native-codex multiplexer. Sits in front of the local protocol layer
// (server.mts) and a REAL `codex app-server` child (codex-upstream.mts), and
// decides per message which side owns it:
//
// - Claude threads (model claude-*/opus/sonnet/haiku/fable or any id in
//   ANYENGINE_MODELS) stay on the local runtime exactly as before.
// - gpt-* and every other model, plus every thread the child created itself
//   (subagents, `codex_app create_thread`, CLI resumes), belong to the child.
//   Ownership is learned from the child's `thread/started` / list results and
//   persisted in the store so it survives an adapter restart.
// - Global methods default to the child so desktop-only calls
//   (`getAuthStatus`, `process/spawn`, `fs/*`, `plugin/*`, ...) stay native.
// - A few global lists are merged: the child's answer plus the Claude half.
//
// Ids are rewritten in both directions by the upstream; this module only
// picks the peer and rewrites `serverRequest/resolved`.

export interface MuxLocalServer {
  dispatch(peer: RpcPeer, method: string, params: unknown): Promise<unknown>
  // 'claude' = a thread the local runtime owns; 'codex-exec' = a legacy
  // `codex exec` proxy row (hidden from merged lists because the real
  // server lists the same conversation natively); null = unknown locally.
  localThreadOwner(threadId: string): 'claude' | 'codex-exec' | null
  // The model on the local thread row, or null when there is no row. Decides
  // which local engine (Claude / Grok) currently owns the thread.
  localThreadModel(threadId: string): string | null
  // True while the local layer is running a turn on this thread; a mid-thread
  // engine switch waits for it rather than cutting it off.
  hasActiveTurn(threadId: string): boolean
  // Hand a thread back to a local engine, creating the row when the thread was
  // born on the real Codex child (src/rehome.mts).
  adoptThread(peer: RpcPeer, input: RehomeAdoption): void
}

// What the local layer needs to take over a thread mid-conversation.
export interface RehomeAdoption {
  threadId: string
  model: string
  cwd: string | null
  // Compact conversation so far, prefixed to the first turn's prompt.
  transcript: string | null
  preview?: string
  createdAt?: number | null
  approvalPolicy?: string | null
  sandboxMode?: string | null
}

export interface NativeCodexMuxOptions {
  store: SessionStore
  upstream: CodexUpstream
  local: MuxLocalServer
  // Sees every notification the child emits (after id rewriting), whichever
  // peer it is delivered to. The bridge (bridge-control.mts) tracks upstream
  // turns from here.
  onNotification?: (message: { method: string; params: unknown }) => void
  // Catalog for the cross-engine standing instructions appended to
  // `developerInstructions` on every thread/start|resume|fork the child
  // owns (docs/guide/bridge.md); null = injection off.
  bridgeCatalog?: () => BridgeCatalogModel[] | null
}

export type Route = 'local' | 'upstream'

// What the bridge learns about a child-owned thread from the child's own
// `thread/start` / `thread/resume` answers: enough to inherit cwd and policy
// when that thread spawns children of its own.
export interface UpstreamThreadInfo {
  cwd: string | null
  model: string | null
  approvalPolicy: string | null
  sandboxMode: string | null
}

const MERGED_METHODS = new Set(['thread/list', 'thread/loaded/list', 'model/list', 'config/read'])
const LOCAL_GLOBAL_METHODS = new Set(['mock/experimentalMethod'])
const RATE_LIMIT_CACHE_MS = 30_000
const THREAD_ID_KEYS = ['threadId', 'thread_id'] as const
// Lifecycle requests whose params carry developerInstructions (v2 schema:
// ThreadStartParams / ThreadResumeParams / ThreadForkParams; turn/start does
// not).
const INSTRUCTION_LIFECYCLE_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork'])
// How the desktop announces a model change on an existing thread. Verified
// live on ChatGPT.app 26.901: moving the picker sends `thread/settings/update`
// with the new model and the following `turn/start` carries `model: null`, so
// the switch has to be caught here as well as on the turn.
const MODEL_CHANGE_METHODS = new Set(['thread/settings/update', 'thread/metadata/update'])

export function isClaudeModelId(model: string): boolean {
  const id = model.trim().toLowerCase()
  if (!id) return false
  if (/^(claude|opus|sonnet|haiku|fable)/.test(id)) return true
  return claudeModelOptions().some((option) => option.id.toLowerCase() === id)
}

// Owner of a NEW thread by model id alone (no provider / title-thread
// exceptions): the rule `thread/start` applies, shared with the bridge so it
// can tell which creation path a spawned child takes.
export function routeForModel(model: string): Route {
  const id = model.trim()
  if (!id) return 'local'
  if (isCodexOpenAiModel(id)) return 'upstream'
  if (isClaudeModelId(id)) return 'local'
  // grok-* threads are served by the local grok runtime (src/grok-runtime.mts).
  if (/^grok/i.test(id)) return 'local'
  return 'upstream'
}

export class NativeCodexMux {
  private readonly store: SessionStore
  private readonly upstream: CodexUpstream
  private readonly local: MuxLocalServer
  private readonly onNotification: NativeCodexMuxOptions['onNotification'] | null
  private readonly bridgeCatalog: NativeCodexMuxOptions['bridgeCatalog'] | null
  // The child's model catalog as last seen (model/list); feeds the bridge
  // instructions and the bridge's alias table for gpt-* ids.
  private upstreamModelCache: BridgeCatalogModel[] = []
  private readonly peers = new Map<string, RpcPeer>()
  private readonly peerByThread = new Map<string, RpcPeer>()
  // Child-owned threads with a turn in flight (turn/started .. turn/completed)
  // and what their lifecycle answers revealed; both in-memory only.
  private readonly activeUpstreamTurns = new Map<string, string>()
  private readonly upstreamThreads = new Map<string, UpstreamThreadInfo>()
  private primaryPeer: RpcPeer | null = null
  private stopped = false
  // Thread-id aliases created by a mid-thread switch to GPT: the desktop keeps
  // the id it has always known, the child answers under its own. Only threads
  // whose two ids differ appear here (a thread born upstream keeps one id).
  private readonly upstreamIdByApp = new Map<string, string>()
  private readonly appIdByUpstream = new Map<string, string>()

  constructor(options: NativeCodexMuxOptions) {
    this.store = options.store
    this.upstream = options.upstream
    this.local = options.local
    this.onNotification = options.onNotification ?? null
    this.bridgeCatalog = options.bridgeCatalog ?? null
    for (const record of this.store.listThreadEngines()) this.rememberAlias(record)
  }

  upstreamModels(): BridgeCatalogModel[] {
    return this.upstreamModelCache
  }

  get active(): boolean {
    return this.upstream.available
  }

  // The desktop peer that last initialized (never a bridge peer: the bridge
  // does not send `initialize`).
  get primaryAppPeer(): RpcPeer | null {
    return this.primaryPeer
  }

  upstreamThreadInfo(threadId: string): UpstreamThreadInfo | null {
    if (!this.store.isNativeCodexThread(threadId) && !this.upstreamThreads.has(threadId))
      return null
    return (
      this.upstreamThreads.get(threadId) ?? {
        cwd: null,
        model: null,
        approvalPolicy: null,
        sandboxMode: null,
      }
    )
  }

  activeUpstreamTurnId(threadId: string): string | null {
    return this.activeUpstreamTurns.get(threadId) ?? null
  }

  activeUpstreamThreadIds(): string[] {
    return [...this.activeUpstreamTurns.keys()]
  }

  // Returns true when the message was consumed here (forwarded or merged);
  // false hands it to the local protocol layer untouched.
  async handle(peer: RpcPeer, message: WireMessage): Promise<boolean> {
    if (this.stopped) return false
    this.peers.set(peer.id, peer)
    if ('method' in message && message.method) {
      if ('id' in message) return this.handleRequest(peer, message as JsonRpcRequest)
      return this.handleNotification(peer, message.method, message.params)
    }
    if ('id' in message) return this.upstream.forwardClientResponse(message as JsonRpcResponse)
    return false
  }

  closePeer(peer: RpcPeer): void {
    this.peers.delete(peer.id)
    for (const [threadId, owner] of this.peerByThread.entries()) {
      if (owner.id === peer.id) this.peerByThread.delete(threadId)
    }
    if (this.primaryPeer?.id === peer.id)
      this.primaryPeer = this.peers.values().next().value ?? null
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.upstream.stop()
  }

  // Messages from the child: server requests get a rewritten id and go to
  // the thread's peer; notifications are forwarded verbatim (ownership is
  // learned on the way through).
  onUpstreamMessage(incoming: WireMessage): void {
    if (this.stopped) return
    if (!('method' in incoming) || !incoming.method) return
    const message = this.toAppThreadIds(incoming)
    const params = asRecord(message.params)
    const threadId = threadIdOf(params)
    if ('id' in message && message.id != null) {
      const peer = this.peerForThread(threadId)
      if (!peer) {
        debugLog('codex.mux.serverRequestDropped', { method: message.method, threadId })
        return
      }
      const downId = this.upstream.rewriteServerRequestId(message.id, peer)
      debugLog('codex.mux.serverRequest', {
        method: message.method,
        threadId,
        upId: message.id,
        downId,
        peerId: peer.id,
      })
      peer.send({ jsonrpc: '2.0', id: downId, method: message.method, params: message.params })
      return
    }
    let outgoing = message.params
    switch (message.method) {
      case 'thread/started': {
        const id = idOf(asRecord(params.thread))
        if (id) this.recordUpstreamThread(id, this.primaryPeer)
        break
      }
      case 'thread/deleted':
        if (threadId) {
          this.store.deleteNativeCodexThread(threadId)
          this.peerByThread.delete(threadId)
        }
        break
      case 'serverRequest/resolved': {
        const downId = this.upstream.translateResolvedRequestId(
          params.requestId as JsonRpcRequest['id'],
        )
        if (downId != null) outgoing = { ...params, requestId: downId }
        break
      }
      case 'turn/started': {
        const turnId = idOf(asRecord(params.turn))
        if (threadId && turnId) this.activeUpstreamTurns.set(threadId, turnId)
        break
      }
      case 'turn/completed':
        if (threadId) this.activeUpstreamTurns.delete(threadId)
        break
      default:
        break
    }
    this.onNotification?.({ method: message.method, params: outgoing })
    const target = this.peerForThread(threadId)
    if (threadId && target) {
      target.send({ jsonrpc: '2.0', method: message.method, params: outgoing })
      return
    }
    for (const peer of this.peers.values()) {
      peer.send({ jsonrpc: '2.0', method: message.method, params: outgoing })
    }
  }

  private async handleRequest(peer: RpcPeer, request: JsonRpcRequest): Promise<boolean> {
    const method = request.method
    const params = asRecord(request.params)
    if (method === 'initialize') {
      await this.handleInitialize(peer, request)
      return true
    }
    if (!this.upstream.available) {
      // Degraded: the child never started (no binary, crash loop). Everything
      // falls back to the local layer, except threads the child owns.
      const threadId = threadIdOf(params)
      if (threadId && this.store.isNativeCodexThread(threadId)) {
        peer.send({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32000, message: 'codex upstream unavailable' },
        })
        return true
      }
      return false
    }
    if (MERGED_METHODS.has(method)) {
      await this.handleMerged(peer, request, params)
      return true
    }
    // Routing follows the model, not the thread's creation path: either of
    // these may hand the thread to another engine before it is routed below.
    if (
      (method === 'turn/start' || MODEL_CHANGE_METHODS.has(method)) &&
      (await this.prepareEngineSwitch(peer, request, params))
    )
      return true
    if (method === 'thread/read' && (await this.mergeRehomedThreadRead(peer, request, params)))
      return true
    const route = this.routeRequest(method, params)
    debugLog('codex.mux.route', { method, id: request.id, route, threadId: threadIdOf(params) })
    if (route === 'local') return false
    const threadId = threadIdOf(params)
    if (threadId) this.peerByThread.set(threadId, peer)
    const outgoing = this.forUpstream(request, threadId)
    if (INSTRUCTION_LIFECYCLE_METHODS.has(method)) {
      this.forwardThreadLifecycle(
        outgoing.peer(peer),
        this.withBridgeInstructions(outgoing.request),
      )
      return true
    }
    this.upstream.forwardRequest(outgoing.peer(peer), request.id, method, outgoing.request.params)
    return true
  }

  // Everything a request needs on its way to the child: the carried transcript
  // that could not be injected rides on the first turn's input, and an aliased
  // thread id is swapped for the child's own (and swapped back on the answer).
  private forUpstream(
    request: JsonRpcRequest,
    appThreadId: string | null,
  ): { request: JsonRpcRequest; peer: (peer: RpcPeer) => RpcPeer } {
    let params = request.params
    if (request.method === 'turn/start' && appThreadId) {
      const pending = this.store.getThreadEngine(appThreadId)?.pendingPrefix
      if (pending) {
        const record = asRecord(params)
        params = {
          ...record,
          input: [
            { type: 'text', text: pending },
            ...(Array.isArray(record.input) ? record.input : []),
          ],
        }
        this.store.clearThreadEnginePrefix(appThreadId)
        debugLog('thread.rehome.prefixApplied', { threadId: appThreadId })
      }
    }
    const upstreamId = appThreadId ? this.upstreamIdByApp.get(appThreadId) : undefined
    if (!appThreadId || !upstreamId) {
      return { request: { ...request, params }, peer: (peer) => peer }
    }
    return {
      request: { ...request, params: rewriteThreadIds(params, appThreadId, upstreamId) },
      peer: (peer) => ({
        id: peer.id,
        send: (message) => peer.send(rewriteThreadIds(message, upstreamId, appThreadId)),
        close: () => peer.close(),
      }),
    }
  }

  private routeRequest(method: string, params: Record<string, unknown>): Route {
    if (LOCAL_GLOBAL_METHODS.has(method)) return 'local'
    if (method === 'thread/start') return this.routeThreadStart(params)
    const threadId = threadIdOf(params)
    if (threadId) return this.ownerOf(threadId)
    return 'upstream'
  }

  private routeThreadStart(params: Record<string, unknown>): Route {
    const model = typeof params.model === 'string' ? params.model : ''
    const provider = typeof params.modelProvider === 'string' ? params.modelProvider : ''
    const isTitleOrHelper =
      params.ephemeral === true ||
      params.threadSource === 'title_generation' ||
      params.threadSource === 'memory_consolidation'
    if (
      isTitleOrHelper &&
      (process.env.ANYENGINE_TITLE_ROUTE ?? '').trim().toLowerCase() === 'local'
    ) {
      // Free title shortcut: the local runtime answers structured summary
      // turns without spending ChatGPT quota, regardless of the model id.
      return 'local'
    }
    if (provider === 'claude-code') return 'local'
    return routeForModel(model)
  }

  private ownerOf(threadId: string): Route {
    // A thread that has been re-homed is owned by whatever the last switch
    // decided, whichever side created it (src/rehome.mts).
    const rehomed = this.store.getThreadEngine(threadId)
    if (rehomed) return rehomed.engine === 'gpt' ? 'upstream' : 'local'
    if (this.store.isNativeCodexThread(threadId)) return 'upstream'
    const local = this.local.localThreadOwner(threadId)
    if (local === 'claude') return 'local'
    if (local === 'codex-exec') return codexExecRouteEnabled() ? 'local' : 'upstream'
    // Unknown ids belong to the child: it can create threads outside the
    // desktop (CLI, subagents, codex_app tools) and the desktop may resume
    // rollouts this adapter never saw.
    return 'upstream'
  }

  // `initialize` goes to both sides: the local layer records peer
  // capabilities, the child needs it exactly once per connection. The child's
  // answer (userAgent, codexHome, platform) wins so the desktop sees the real
  // server version.
  private async handleInitialize(peer: RpcPeer, request: JsonRpcRequest): Promise<void> {
    this.primaryPeer = peer
    let localResult: unknown = null
    let localError: Error | null = null
    try {
      localResult = await this.local.dispatch(peer, 'initialize', request.params ?? {})
    } catch (error) {
      localError = error instanceof Error ? error : new Error(String(error))
    }
    let upstreamResult: unknown = null
    if (this.upstream.available) {
      this.upstream.start()
      try {
        upstreamResult =
          this.upstream.cachedInitializeResult ?? (await this.upstream.initialize(request.params))
      } catch (error) {
        debugLog('codex.mux.initializeUpstreamFailed', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (localError && upstreamResult == null) {
      peer.send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: localError.message },
      })
      return
    }
    if (upstreamResult != null && this.upstreamModelCache.length === 0)
      void this.refreshUpstreamModels()
    const merged = { ...asRecord(localResult), ...asRecord(upstreamResult) }
    debugLog('codex.mux.initialize', {
      peerId: peer.id,
      upstream: upstreamResult != null,
      userAgent: merged.userAgent ?? null,
    })
    peer.send({ jsonrpc: '2.0', id: request.id, result: merged })
  }

  // The native child has no per-turn system prompt hook; its thread
  // lifecycle params carry `developerInstructions`, so the standing
  // cross-engine instructions ride there (appended after the desktop's own).
  private withBridgeInstructions(request: JsonRpcRequest): JsonRpcRequest {
    const catalog = this.bridgeCatalog?.() ?? null
    if (!catalog) return request
    const params = asRecord(request.params)
    const existing =
      typeof params.developerInstructions === 'string' ? params.developerInstructions : null
    return {
      ...request,
      params: { ...params, developerInstructions: appendBridgeInstructions(existing, catalog) },
    }
  }

  private rememberUpstreamModels(result: Record<string, unknown> | null): void {
    const data = Array.isArray(result?.data) ? result.data : []
    const models = data
      .map((entry) => asRecord(entry))
      .filter((entry) => typeof entry.id === 'string' && entry.hidden !== true)
      .map((entry) => ({
        id: String(entry.id),
        displayName: typeof entry.displayName === 'string' ? entry.displayName : String(entry.id),
        provider: providerFor(String(entry.id)),
        isDefault: entry.isDefault === true,
      }))
    if (models.length > 0) this.upstreamModelCache = models
  }

  private async refreshUpstreamModels(): Promise<void> {
    try {
      this.rememberUpstreamModels(asRecord(await this.upstream.request('model/list', {})))
    } catch (error) {
      debugLog('codex.mux.modelListRefreshFailed', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private forwardThreadLifecycle(peer: RpcPeer, request: JsonRpcRequest): void {
    // Forward verbatim, but learn the resulting thread id from the response
    // (the child allocates ids; `thread/fork` yields a new one).
    const capture: RpcPeer = {
      id: peer.id,
      send: (message) => {
        const response = message as JsonRpcResponse
        const result = asRecord(response.result)
        const id = idOf(asRecord(result.thread))
        if (id) {
          this.recordUpstreamThread(id, peer)
          this.upstreamThreads.set(id, upstreamThreadInfoFrom(result))
        }
        peer.send(message)
      },
      close: () => peer.close(),
    }
    this.upstream.forwardRequest(capture, request.id, request.method, request.params)
  }

  private async handleMerged(
    peer: RpcPeer,
    request: JsonRpcRequest,
    params: Record<string, unknown>,
  ): Promise<void> {
    const method = request.method
    const respond = (result: unknown) =>
      peer.send({ jsonrpc: '2.0', id: request.id, result: result ?? null })
    const fail = (error: unknown) =>
      peer.send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      })
    try {
      switch (method) {
        case 'thread/list':
          respond(await this.mergeThreadList(peer, params))
          return
        case 'thread/loaded/list':
          respond(await this.mergeLoadedList(peer, params))
          return
        case 'model/list':
          respond(await this.mergeModelList(peer, params))
          return
        case 'config/read':
          respond(await this.mergeConfigRead(peer, params))
          return
        default:
          fail(new Error(`unmerged method: ${method}`))
      }
    } catch (error) {
      fail(error)
    }
  }

  // Page 1 (no cursor) = child page 1 with the Claude threads merged in by
  // sort key; later pages are child-only. Cursor semantics stay the child's.
  private async mergeThreadList(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const providers = Array.isArray(params.modelProviders)
      ? params.modelProviders.filter((value): value is string => typeof value === 'string')
      : null
    const wantsClaude = providers == null || providers.includes('claude-code')
    const wantsUpstream = providers == null || !providers.every((p) => p === 'claude-code')
    const hasCursor = typeof params.cursor === 'string' && params.cursor.length > 0
    const upstreamParams =
      providers == null
        ? params
        : { ...params, modelProviders: providers.filter((p) => p !== 'claude-code') }
    const [upstreamSettled, localSettled] = await Promise.allSettled([
      wantsUpstream ? this.upstream.request('thread/list', upstreamParams) : Promise.resolve(null),
      wantsClaude && !hasCursor
        ? this.local.dispatch(peer, 'thread/list', params)
        : Promise.resolve(null),
    ])
    const upstreamResult =
      upstreamSettled.status === 'fulfilled' ? asRecord(upstreamSettled.value) : null
    if (upstreamSettled.status === 'rejected') {
      debugLog('codex.mux.threadListUpstreamFailed', { message: String(upstreamSettled.reason) })
    }
    const localResult = localSettled.status === 'fulfilled' ? asRecord(localSettled.value) : null
    const rawUpstreamData = Array.isArray(upstreamResult?.data) ? upstreamResult.data : []
    const upstreamData = rawUpstreamData.map((entry) => {
      const id = idOf(asRecord(entry))
      if (id) this.store.setNativeCodexThread(id)
      const appId = id ? this.appIdByUpstream.get(id) : undefined
      // A thread the desktop knows under its original id is listed under that
      // id, not the child's, so a re-homed thread stays ONE row.
      return id && appId ? rewriteThreadIds(entry, id, appId) : entry
    })
    const localData = (Array.isArray(localResult?.data) ? localResult.data : []).filter((entry) => {
      const id = idOf(asRecord(entry))
      return id != null && this.local.localThreadOwner(id) === 'claude'
    })
    if (!upstreamResult) {
      return { ...(localResult ?? { data: [] }), data: localData, nextCursor: null }
    }
    const sortKey = params.sortKey === 'created_at' ? 'createdAt' : 'updatedAt'
    const direction = params.sortDirection === 'asc' ? 1 : -1
    const data = this.dedupeRehomedRows(upstreamData, localData).sort((a, b) => {
      const av = Number(asRecord(a)[sortKey] ?? 0)
      const bv = Number(asRecord(b)[sortKey] ?? 0)
      if (av !== bv) return (av - bv) * direction
      return String(asRecord(a).id).localeCompare(String(asRecord(b).id)) * direction
    })
    return { ...upstreamResult, data }
  }

  // A re-homed thread has a row on both sides. Keep the one from the engine
  // that owns it now, so the desktop still sees exactly one thread.
  private dedupeRehomedRows(upstreamData: unknown[], localData: unknown[]): unknown[] {
    const tagged = [
      ...upstreamData.map((entry) => ({ entry, upstream: true })),
      ...localData.map((entry) => ({ entry, upstream: false })),
    ]
    const counts = new Map<string, number>()
    for (const row of tagged) {
      const id = idOf(asRecord(row.entry))
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return tagged
      .filter((row) => {
        const id = idOf(asRecord(row.entry))
        if (!id || (counts.get(id) ?? 0) < 2) return true
        return row.upstream === (this.currentEngine(id) === 'gpt')
      })
      .map((row) => row.entry)
  }

  private async mergeLoadedList(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const [upstreamSettled, localSettled] = await Promise.allSettled([
      this.upstream.request('thread/loaded/list', params),
      this.local.dispatch(peer, 'thread/loaded/list', params),
    ])
    const upstreamResult =
      upstreamSettled.status === 'fulfilled' ? asRecord(upstreamSettled.value) : null
    const localResult = localSettled.status === 'fulfilled' ? asRecord(localSettled.value) : null
    const ids = new Set<string>()
    for (const entry of Array.isArray(upstreamResult?.data) ? upstreamResult.data : []) {
      if (typeof entry === 'string') ids.add(entry)
    }
    for (const entry of Array.isArray(localResult?.data) ? localResult.data : []) {
      if (typeof entry === 'string') ids.add(entry)
    }
    return { ...(upstreamResult ?? localResult ?? {}), data: [...ids] }
  }

  // Child catalog first (real ChatGPT models, defaults, tiers), Claude
  // entries appended on the last page with isDefault unset so the child's
  // default stays the desktop's default.
  private rateLimitReachedCache: { at: number; reached: boolean } | null = null

  private async shouldHideReserveModels(): Promise<boolean> {
    if ((process.env.ANYENGINE_HIDE_RATE_LIMIT_UPSELL ?? '').trim() !== '1') return false
    const now = Date.now()
    if (this.rateLimitReachedCache && now - this.rateLimitReachedCache.at < RATE_LIMIT_CACHE_MS)
      return this.rateLimitReachedCache.reached
    let reached = false
    try {
      const result = asRecord(await this.upstream.request('account/rateLimits/read', {}))
      const limits = asRecord(result.rateLimits)
      reached =
        limits.rateLimitReachedType != null || asRecord(result.rateLimitUpsell).banner_type != null
    } catch (error) {
      debugLog('codex.mux.rateLimitProbeFailed', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
    this.rateLimitReachedCache = { at: now, reached }
    debugLog('codex.mux.reserveModels', { hidden: reached })
    return reached
  }

  private async mergeModelList(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const [upstreamSettled, localSettled] = await Promise.allSettled([
      this.upstream.request('model/list', params),
      this.local.dispatch(peer, 'model/list', params),
    ])
    const upstreamResult =
      upstreamSettled.status === 'fulfilled' ? asRecord(upstreamSettled.value) : null
    const localResult = localSettled.status === 'fulfilled' ? asRecord(localSettled.value) : null
    const claudeEntries = (Array.isArray(localResult?.data) ? localResult.data : [])
      .map((entry) => asRecord(entry))
      .filter((entry) => typeof entry.id === 'string' && !isCodexOpenAiModel(entry.id))
    if (!upstreamResult) return { data: claudeEntries, nextCursor: null }
    this.rememberUpstreamModels(upstreamResult)
    let upstreamData = Array.isArray(upstreamResult.data) ? upstreamResult.data : []
    if (await this.shouldHideReserveModels()) {
      // The desktop enters "reserve mode" (composer locked to the reserve
      // model, picker replaced by an Add Credits wall, every other model
      // hidden, Claude/Grok included) as soon as the list contains the reserve
      // model while the account's limit is reached.
      // Hiding only the reserve entry is not enough: with any OpenAI model
      // left in the list the desktop still filters the picker down to the
      // reserve set (now empty). While the limit is reached every OpenAI model
      // is unusable anyway, so hide them all; they return automatically once
      // the limit resets (30 s cache).
      upstreamData = []
    }
    if (upstreamResult.nextCursor != null) return { ...upstreamResult, data: upstreamData }
    const upstreamIds = new Set(upstreamData.map((entry) => String(asRecord(entry).id)))
    const upstreamHasDefault = upstreamData.some((entry) => asRecord(entry).isDefault === true)
    const appended = claudeEntries
      .filter((entry) => !upstreamIds.has(String(entry.id)))
      .map((entry) => ({ ...entry, isDefault: upstreamHasDefault ? false : entry.isDefault }))
    return { ...upstreamResult, data: [...upstreamData, ...appended] }
  }

  // Child config verbatim; only the `claude-code` provider entry is added so
  // the desktop keeps a home for the Claude models in its picker.
  private async mergeConfigRead(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const [upstreamSettled, localSettled] = await Promise.allSettled([
      this.upstream.request('config/read', params),
      this.local.dispatch(peer, 'config/read', params),
    ])
    const localResult = localSettled.status === 'fulfilled' ? asRecord(localSettled.value) : null
    if (upstreamSettled.status !== 'fulfilled') return localResult ?? {}
    const upstreamResult = asRecord(upstreamSettled.value)
    const localProviders = asRecord(asRecord(localResult?.config).model_providers)
    const claudeProvider = localProviders['claude-code']
    if (!claudeProvider) return upstreamResult
    const config = asRecord(upstreamResult.config)
    const origins = asRecord(upstreamResult.origins)
    const localOrigins = asRecord(localResult?.origins)
    return {
      ...upstreamResult,
      config: {
        ...config,
        model_providers: { ...asRecord(config.model_providers), 'claude-code': claudeProvider },
      },
      origins: {
        ...origins,
        ...(localOrigins['model_providers.claude-code']
          ? { 'model_providers.claude-code': localOrigins['model_providers.claude-code'] }
          : {}),
      },
    }
  }

  private handleNotification(peer: RpcPeer, method: string, params: unknown): boolean {
    if (method === 'initialized') {
      if (this.upstream.available) this.upstream.markInitialized()
      return false
    }
    const threadId = threadIdOf(asRecord(params))
    if (threadId && this.upstream.available && this.ownerOf(threadId) === 'upstream') {
      this.peerByThread.set(threadId, peer)
      const upstreamId = this.upstreamIdByApp.get(threadId)
      this.upstream.notify(
        method,
        upstreamId ? rewriteThreadIds(params, threadId, upstreamId) : params,
      )
      return true
    }
    return false
  }

  // ---------------------------------------------------------------------
  // Mid-thread engine switching (src/rehome.mts, docs/evidence/a5-*.md)
  // ---------------------------------------------------------------------

  // Which engine owns this thread right now. A re-home record wins; otherwise
  // the thread is whatever its creation path made it.
  private currentEngine(threadId: string): Engine {
    const rehomed = this.store.getThreadEngine(threadId)
    if (rehomed) return rehomed.engine
    if (this.store.isNativeCodexThread(threadId)) return 'gpt'
    const model = this.local.localThreadModel(threadId)
    if (model != null) return engineForModel(model)
    // Unknown ids belong to the child (CLI resumes, subagents, codex_app).
    return 'gpt'
  }

  // Called before a `turn/start` or a model change is routed. Returns true when
  // the request was already answered here (a refusal); false lets it continue,
  // by which point ownership matches the model.
  private async prepareEngineSwitch(
    peer: RpcPeer,
    request: JsonRpcRequest,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    const threadId = threadIdOf(params)
    // A summary / title turn carries the desktop's own default model and must
    // never move the thread it is summarizing.
    if (!threadId || params.outputSchema != null) return false
    // Only an explicitly named model moves a thread. This desktop's
    // `turn/start` carries `model: null` and means "whatever the thread is set
    // to", which is by definition the engine that already owns it; the switch
    // it made arrived earlier, on `thread/settings/update`.
    const model = typeof params.model === 'string' ? params.model.trim() : ''
    if (!model) return false
    const to = engineForModel(model)
    const from = this.currentEngine(threadId)
    if (from === to) return false
    if (this.activeUpstreamTurns.has(threadId) || this.local.hasActiveTurn(threadId)) {
      if (request.method !== 'turn/start') {
        // A picker change while the thread is answering: pin what owns it now
        // so the switch is still noticed once the turn is done, and let the
        // settings update through untouched.
        this.rememberEngine({
          id: threadId,
          engine: from,
          upstreamThreadId: this.store.getThreadEngine(threadId)?.upstreamThreadId ?? null,
          pendingPrefix: null,
          carriedTurnId: this.store.getThreadEngine(threadId)?.carriedTurnId ?? null,
        })
        return false
      }
      this.failRequest(
        peer,
        request.id,
        `this thread is still answering; wait for the current turn to finish before switching to ${model}`,
      )
      return true
    }
    try {
      await this.rehomeThread(peer, threadId, from, to, model, params)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      debugLog('thread.rehomeFailed', { threadId, from, to, message })
      this.failRequest(peer, request.id, `could not switch this thread to ${model}: ${message}`)
      return true
    }
    return false
  }

  private async rehomeThread(
    peer: RpcPeer,
    threadId: string,
    from: Engine,
    to: Engine,
    model: string,
    turnParams: Record<string, unknown>,
  ): Promise<void> {
    const state = this.store.getThreadEngine(threadId)
    const knownUpstreamId =
      state?.upstreamThreadId ?? (this.store.isNativeCodexThread(threadId) ? threadId : null)
    if (from !== 'gpt' && to !== 'gpt') {
      // Claude <-> Grok never leaves the local layer: it does the session reset,
      // the transcript and the `thread.rehomed` line itself (server.mts), so
      // only the ownership record moves here — and it has to, or a restart
      // would forget the choice.
      this.rememberEngine({
        id: threadId,
        engine: to,
        upstreamThreadId: knownUpstreamId,
        pendingPrefix: null,
        carriedTurnId: state?.carriedTurnId ?? null,
      })
      return
    }
    if (to === 'gpt') {
      await this.rehomeToUpstream(peer, threadId, knownUpstreamId, model, turnParams)
    } else {
      await this.rehomeToLocal(peer, threadId, knownUpstreamId, to, model, turnParams)
    }
    debugLog('thread.rehomed', { threadId, from, to })
  }

  // Local engine -> the real Codex child. Resumes the child thread this app
  // thread already had, else starts a new one and aliases it.
  private async rehomeToUpstream(
    peer: RpcPeer,
    threadId: string,
    knownUpstreamId: string | null,
    model: string,
    turnParams: Record<string, unknown>,
  ): Promise<void> {
    const sides = await this.readBothSides(peer, threadId, knownUpstreamId)
    const cwd = rehomeCwd(turnParams, sides.localThread, sides.upstreamThread)
    // Only the local turns the child has not been given yet: it keeps its own
    // history, so re-carrying it would duplicate the conversation.
    const carried = this.store.getThreadEngine(threadId)?.carriedTurnId ?? null
    const fresh = localTurnsAfter(sides.localTurns, carried)
    const carriedTurnId = idOf(asRecord(sides.localTurns.at(-1))) ?? carried
    const transcript = formatTranscript(transcriptEntriesFromTurns(fresh))
    let upstreamId: string | null = null
    if (knownUpstreamId) {
      try {
        const resumed = asRecord(
          await this.upstream.request(
            'thread/resume',
            { threadId: knownUpstreamId, ...(cwd ? { cwd } : {}) },
            30_000,
          ),
        )
        upstreamId = idOf(asRecord(resumed.thread)) ?? knownUpstreamId
      } catch (error) {
        debugLog('thread.rehome.resumeFailed', {
          threadId,
          upstreamThreadId: knownUpstreamId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (!upstreamId) {
      const started = asRecord(
        await this.upstream.request(
          'thread/start',
          {
            model,
            ...(cwd ? { cwd } : {}),
            ...(typeof turnParams.developerInstructions === 'string'
              ? { developerInstructions: turnParams.developerInstructions }
              : {}),
          },
          30_000,
        ),
      )
      upstreamId = idOf(asRecord(started.thread))
      if (!upstreamId) throw new Error('the Codex child did not return a thread id')
      this.upstreamThreads.set(upstreamId, upstreamThreadInfoFrom(started))
    }
    let pendingPrefix: string | null = null
    if (transcript) {
      try {
        await this.upstream.request(
          'thread/inject_items',
          { threadId: upstreamId, items: injectItemsFor(transcript) },
          30_000,
        )
      } catch (error) {
        // The child refused the injection (older protocol, unknown item
        // shape). Fall back to prefixing the first turn's input.
        debugLog('thread.rehome.injectFailed', {
          threadId,
          message: error instanceof Error ? error.message : String(error),
        })
        pendingPrefix = transcript
      }
    }
    this.store.setNativeCodexThread(upstreamId)
    this.rememberEngine({
      id: threadId,
      engine: 'gpt',
      upstreamThreadId: upstreamId,
      pendingPrefix,
      carriedTurnId,
    })
  }

  // The real Codex child -> a local engine. The local session is always reset,
  // so the whole merged conversation is carried over.
  private async rehomeToLocal(
    peer: RpcPeer,
    threadId: string,
    knownUpstreamId: string | null,
    to: Engine,
    model: string,
    turnParams: Record<string, unknown>,
  ): Promise<void> {
    const sides = await this.readBothSides(peer, threadId, knownUpstreamId)
    const upstreamThread = sides.upstreamThread
    this.local.adoptThread(peer, {
      threadId,
      model,
      cwd: rehomeCwd(turnParams, sides.localThread, upstreamThread),
      transcript: formatTranscript(transcriptEntriesFromTurns(sides.turns)),
      preview: typeof upstreamThread?.preview === 'string' ? upstreamThread.preview : '',
      createdAt: typeof upstreamThread?.createdAt === 'number' ? upstreamThread.createdAt : null,
    })
    this.rememberEngine({
      id: threadId,
      engine: to,
      // Kept so a later switch back reuses the same child thread and
      // `thread/read` can still merge both halves of the history.
      upstreamThreadId: knownUpstreamId,
      pendingPrefix: null,
      carriedTurnId: this.store.getThreadEngine(threadId)?.carriedTurnId ?? null,
    })
  }

  // Both halves of a re-homed thread's history, in one chronological list.
  private async readBothSides(
    peer: RpcPeer,
    threadId: string,
    upstreamThreadId: string | null,
  ): Promise<{
    localThread: Record<string, unknown> | null
    upstreamThread: Record<string, unknown> | null
    localTurns: unknown[]
    upstreamTurns: unknown[]
    turns: unknown[]
  }> {
    const wantsLocal = this.local.localThreadOwner(threadId) != null
    const [localSettled, upstreamSettled] = await Promise.allSettled([
      wantsLocal
        ? this.local.dispatch(peer, 'thread/read', { threadId, includeTurns: true })
        : Promise.resolve(null),
      upstreamThreadId
        ? this.upstream.request(
            'thread/read',
            { threadId: upstreamThreadId, includeTurns: true },
            30_000,
          )
        : Promise.resolve(null),
    ])
    if (localSettled.status === 'rejected')
      debugLog('thread.rehome.localReadFailed', { threadId, message: String(localSettled.reason) })
    if (upstreamSettled.status === 'rejected')
      debugLog('thread.rehome.upstreamReadFailed', {
        threadId,
        message: String(upstreamSettled.reason),
      })
    const localThread =
      localSettled.status === 'fulfilled' && localSettled.value != null
        ? asRecord(asRecord(localSettled.value).thread)
        : null
    const upstreamThread =
      upstreamSettled.status === 'fulfilled' && upstreamSettled.value != null
        ? asRecord(asRecord(upstreamSettled.value).thread)
        : null
    const localTurns = Array.isArray(localThread?.turns) ? localThread.turns : []
    const upstreamTurns = Array.isArray(upstreamThread?.turns) ? upstreamThread.turns : []
    // Turns from the two engines are interleaved by start time. Timestamps are
    // whole seconds on the local side, so two turns can tie; the engine that
    // owns the thread right now is the one that ran last, so on a tie the
    // other side goes first.
    const upstreamFirst = this.currentEngine(threadId) !== 'gpt'
    const turns = [
      ...localTurns.map((turn) => ({ turn, rank: upstreamFirst ? 1 : 0 })),
      ...upstreamTurns.map((turn) => ({ turn, rank: upstreamFirst ? 0 : 1 })),
    ]
      .sort((a, b) => startedAtOf(a.turn) - startedAtOf(b.turn) || a.rank - b.rank)
      .map((entry) => entry.turn)
    return { localThread, upstreamThread, localTurns, upstreamTurns, turns }
  }

  // `thread/read` on a thread that has lived on both sides answers with ONE
  // thread carrying both halves of the item history, in order.
  private async mergeRehomedThreadRead(
    peer: RpcPeer,
    request: JsonRpcRequest,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    const threadId = threadIdOf(params)
    if (!threadId || params.includeTurns === false) return false
    const state = this.store.getThreadEngine(threadId)
    if (!state?.upstreamThreadId) return false
    if (this.local.localThreadOwner(threadId) == null) return false
    try {
      const sides = await this.readBothSides(peer, threadId, state.upstreamThreadId)
      const base =
        state.engine === 'gpt'
          ? (sides.upstreamThread ?? sides.localThread)
          : (sides.localThread ?? sides.upstreamThread)
      if (!base) return false
      peer.send({
        jsonrpc: '2.0',
        id: request.id,
        result: { thread: { ...base, id: threadId, turns: sides.turns } },
      })
      return true
    } catch (error) {
      debugLog('thread.rehome.mergedReadFailed', {
        threadId,
        message: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  private rememberEngine(record: ThreadEngineRecord): void {
    this.store.setThreadEngine(record)
    this.rememberAlias(record)
  }

  private rememberAlias(record: ThreadEngineRecord): void {
    const upstreamId = record.upstreamThreadId
    if (!upstreamId || upstreamId === record.id) return
    this.upstreamIdByApp.set(record.id, upstreamId)
    this.appIdByUpstream.set(upstreamId, record.id)
  }

  // Child -> desktop: an aliased thread id becomes the one the app knows.
  private toAppThreadIds<T extends WireMessage>(message: T): T {
    if (this.appIdByUpstream.size === 0) return message
    const params = asRecord((message as { params?: unknown }).params)
    const upstreamId = threadIdOf(params) ?? idOf(asRecord(params.thread))
    if (!upstreamId) return message
    const appId = this.appIdByUpstream.get(upstreamId)
    return appId ? rewriteThreadIds(message, upstreamId, appId) : message
  }

  private failRequest(peer: RpcPeer, id: JsonRpcRequest['id'], message: string): void {
    peer.send({ jsonrpc: '2.0', id, error: { code: -32000, message } })
  }

  private recordUpstreamThread(threadId: string, peer: RpcPeer | null): void {
    this.store.setNativeCodexThread(threadId)
    if (peer) this.peerByThread.set(threadId, peer)
  }

  private peerForThread(threadId: string | null): RpcPeer | null {
    if (threadId) {
      const owner = this.peerByThread.get(threadId)
      if (owner) return owner
    }
    return this.primaryPeer ?? this.peers.values().next().value ?? null
  }
}

// Swap one thread id for another anywhere in a JSON-RPC message. Thread ids
// are opaque and unique, so an exact string match is the whole rule; it covers
// `threadId`, `thread.id`, `parentThreadId`, `receiverThreadIds` and any field
// a future protocol version adds without this module having to know them.
function rewriteThreadIds<T>(value: T, from: string, to: string): T {
  if (!from || from === to) return value
  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') return input === from ? to : input
    if (Array.isArray(input)) return input.map(walk)
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(input as Record<string, unknown>))
        out[key] = walk(entry)
      return out
    }
    return input
  }
  return walk(value) as T
}

// Local turns record seconds, the child's may record milliseconds. Normalize
// to seconds so the two histories can be ordered against each other; anything
// past the year 5138 in seconds is read as a millisecond timestamp.
const MILLISECOND_EPOCH_FLOOR = 100_000_000_000

function startedAtOf(turn: unknown): number {
  const value = asRecord(turn).startedAt
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return value >= MILLISECOND_EPOCH_FLOOR ? Math.floor(value / 1000) : value
}

// The local turns that follow the last one already handed to the child. An
// unknown watermark (a turn since deleted) carries everything, which repeats
// context rather than losing it.
function localTurnsAfter(turns: unknown[], carriedTurnId: string | null): unknown[] {
  if (!carriedTurnId) return turns
  const index = turns.findIndex((turn) => idOf(asRecord(turn)) === carriedTurnId)
  return index < 0 ? turns : turns.slice(index + 1)
}

// cwd for a re-homed thread: the turn's own, then whichever side last knew one.
function rehomeCwd(
  turnParams: Record<string, unknown>,
  localThread: Record<string, unknown> | null,
  upstreamThread: Record<string, unknown> | null,
): string | null {
  for (const candidate of [turnParams.cwd, localThread?.cwd, upstreamThread?.cwd]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// Thread-scoped params carry `threadId` (v2) or `thread_id` (legacy v1).
function threadIdOf(params: Record<string, unknown>): string | null {
  for (const key of THREAD_ID_KEYS) {
    const value = params[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

// A `Thread` object (thread/started, thread/list rows, thread/start result).
function idOf(thread: Record<string, unknown>): string | null {
  return typeof thread.id === 'string' && thread.id.length > 0 ? thread.id : null
}

// thread/start | thread/resume result -> the bits a spawned child inherits.
// The child's `sandbox` is the v2 envelope ({type:'workspaceWrite'}); older
// answers carry the plain string.
function upstreamThreadInfoFrom(result: Record<string, unknown>): UpstreamThreadInfo {
  const sandbox = result.sandbox
  const sandboxType =
    typeof sandbox === 'string'
      ? sandbox
      : typeof asRecord(sandbox).type === 'string'
        ? String(asRecord(sandbox).type)
        : null
  const sandboxMode =
    sandboxType == null
      ? null
      : ({
          workspaceWrite: 'workspace-write',
          readOnly: 'read-only',
          dangerFullAccess: 'danger-full-access',
        }[sandboxType] ?? sandboxType)
  return {
    cwd: typeof result.cwd === 'string' ? result.cwd : null,
    model: typeof result.model === 'string' ? result.model : null,
    approvalPolicy: typeof result.approvalPolicy === 'string' ? result.approvalPolicy : null,
    sandboxMode,
  }
}
