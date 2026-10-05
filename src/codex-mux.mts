import { AccountReplay } from './accounts-replay.mjs'
import { AccountThreadRetry } from './accounts-thread-retry.mjs'
import type { AccountWork } from './accounts-work.mjs'
import { isBridgePeer } from './bridge-control.mjs'
import {
  type BridgeCatalogModel,
  bridgeInstructionParams,
  bridgeInstructionRequest,
} from './bridge-instructions.mjs'
import type { ClaimThread } from './claim-types.mjs'
import { upstreamThreadInfoFrom } from './claude-project-guard.mjs'
import { mergeLoadedThreads, readThreadSides } from './codex-history.mjs'
import {
  INSTRUCTION_LIFECYCLE_METHODS,
  LOCAL_GLOBAL_METHODS,
  MERGED_METHODS,
  MODEL_CHANGE_METHODS,
  ModelReadOwnership,
  POSTURE_METHODS,
  routedTurnModel,
  routeThreadStart,
  type UpstreamThreadInfo,
  upstreamModelsFrom,
} from './codex-models.mjs'
import type { CodexUpstream } from './codex-upstream.mjs'
import { CONFIG_WRITE_METHODS, ConfigWrites } from './config-writes.mjs'
import { NativeClaims } from './native-claims.mjs'
import {
  applyCodexParams,
  DEFAULT_POSTURE,
  type Posture,
  toCodexThreadStart,
  turnWithPosture,
} from './posture.mjs'
import {
  dedupeRehomedRows,
  type Engine,
  engineForModel,
  engineForModelRouted,
  formatTranscript,
  injectItemsFor,
  localTurnsAfter,
  type RehomeAdoption,
  rehomeCwd,
  rewriteThreadIds,
  transcriptEntriesFromTurns,
} from './rehome.mjs'
import { ReserveModelsProbe } from './reserve.mjs'
import { asRecord, idOf, threadIdOf } from './rpc-shape.mjs'
import type { SessionStore } from './store.mjs'
import { rowWithPosture } from './store-rows.mjs'
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  RpcPeer,
  ThreadEngineRecord,
  WireMessage,
} from './types.mjs'
import { type SubagentStart, takeSubagentStart, UpstreamSubagents } from './upstream-subagents.mjs'
import { codexExecRouteEnabled, debugLog, isCodexOpenAiModel } from './util.mjs'

export type { UpstreamThreadInfo } from './codex-models.mjs'
export { isClaudeModelId, routeForModel } from './codex-models.mjs'
export type { RehomeAdoption } from './rehome.mjs'

// Multiplexes the local layer and Codex child. Claude is local in agent mode
// and native in proven model mode; persisted ownership wins for existing threads.
// Globals default upstream; shared lists merge both engines. CodexUpstream
// rewrites request ids; this module picks peers and aliases thread ids.

export interface MuxLocalServer {
  dispatch(peer: RpcPeer, method: string, params: unknown): Promise<unknown>
  // Claude is local; legacy codex-exec rows are hidden behind the native list.
  // Null means unknown locally.
  localThreadOwner(threadId: string): 'claude' | 'codex-exec' | null
  // Local row model decides Claude / Grok ownership; null means no row.
  localThreadModel(threadId: string): string | null
  localThreadPosture(threadId: string): Posture
  // A mid-thread engine switch waits for an active local turn.
  hasActiveTurn(threadId: string): boolean
  // Adopt locally, creating a row for a thread born on the child.
  adoptThread(peer: RpcPeer, input: RehomeAdoption): void
}

export interface NativeCodexMuxOptions {
  store: SessionStore
  upstream: CodexUpstream
  local: MuxLocalServer
  // Every rewritten child notification; the bridge tracks upstream turns here.
  onNotification?: (message: { method: string; params: unknown }) => void
  // Optional line for child lifecycle instructions (docs/guide/bridge.md).
  // Direct known-child handover resumes preserve stored instructions; null = off.
  bridgeLine?: () => string | null
  brokerSource?: { close(): Promise<void> }
  accountWork?: AccountWork
  desktopIdentity?: (method: string, params: unknown) => Promise<unknown>
}

export type Route = 'local' | 'upstream'

export class NativeCodexMux {
  readonly accountWork: AccountWork | undefined
  private readonly store: SessionStore
  private readonly upstream: CodexUpstream
  private readonly local: MuxLocalServer
  private readonly onNotification: NativeCodexMuxOptions['onNotification'] | null
  private readonly bridgeLine: NativeCodexMuxOptions['bridgeLine'] | null
  private readonly brokerSource: NativeCodexMuxOptions['brokerSource']
  private readonly desktopIdentity: NativeCodexMuxOptions['desktopIdentity']
  private readonly continuity: AccountThreadRetry | null
  private readonly replay: AccountReplay | null
  // Last child model/list catalog supplies the bridge's gpt-* alias table.
  private upstreamModelCache: BridgeCatalogModel[] = []
  private readonly peers = new Map<string, RpcPeer>()
  private readonly peerByThread = new Map<string, RpcPeer>()
  private readonly activeUpstreamTurns = new Map<string, string>()
  private readonly upstreamThreads = new Map<string, UpstreamThreadInfo>()
  private readonly modelReads = new ModelReadOwnership()
  private primaryPeer: RpcPeer | null = null
  private stopped = false
  private readonly upstreamIdByApp = new Map<string, string>()
  private readonly appIdByUpstream = new Map<string, string>()
  private readonly subagents: UpstreamSubagents
  // The app's model picker: picks codex cannot serve stay out of config.toml.
  private readonly reserveModels: ReserveModelsProbe
  private readonly claims: NativeClaims
  private readonly configWrites: ConfigWrites

  constructor(options: NativeCodexMuxOptions) {
    this.accountWork = options.accountWork
    this.store = options.store
    this.upstream = options.upstream
    this.local = options.local
    this.onNotification = options.onNotification ?? null
    this.bridgeLine = options.bridgeLine ?? null
    this.brokerSource = options.brokerSource
    this.desktopIdentity = options.desktopIdentity
    this.continuity = options.accountWork
      ? new AccountThreadRetry(options.accountWork.runtime, this.upstream, {
          info: (id, info) => this.upstreamThreads.set(id, info),
          message: (message) => this.onUpstreamMessage(message),
          connected: (peer) => this.peers.has(peer),
          alias: (id, upstreamThreadId) => {
            this.store.setNativeCodexThread(upstreamThreadId)
            this.rememberEngine({ id, engine: 'gpt', upstreamThreadId, pendingPrefix: null })
          },
        })
      : null
    this.replay = options.accountWork
      ? new AccountReplay(options.accountWork, (peer, request) => this.handle(peer, request))
      : null
    this.subagents = new UpstreamSubagents(this.store)
    this.configWrites = new ConfigWrites(this.upstream)
    this.claims = new NativeClaims(
      this.upstream,
      this.upstreamThreads,
      (child, parent) => this.recordUpstreamThread(child, this.peerForThread(parent)),
      (id) => this.knowsThread(id),
    )
    this.reserveModels = new ReserveModelsProbe(() =>
      this.upstream.request('account/rateLimits/read', {}),
    )
    for (const record of this.store.listThreadEngines()) this.rememberAlias(record)
  }

  claimThread(threadId: string): ClaimThread | null {
    return this.claims.get(threadId)
  }
  waitForClaimThread(threadId: string, ms: number): Promise<ClaimThread | null> {
    return this.claims.waitFor(threadId, ms)
  }
  knowsThread(threadId: string): boolean {
    return this.upstreamThreads.has(threadId) || this.store.isNativeCodexThread(threadId)
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
    const info = this.upstreamThreads.get(threadId)
    if (info || !this.store.isNativeCodexThread(threadId)) return info ?? null
    return { cwd: null, model: null, posture: DEFAULT_POSTURE }
  }

  // What no Codex message carries: the trust and project baseline a child the
  // bridge starts takes from its caller (src/claude-project-guard.mts).
  updateUpstreamPosture(threadId: string, update: (posture: Posture) => Posture): void {
    const info = this.upstreamThreads.get(threadId)
    if (info) this.upstreamThreads.set(threadId, { ...info, posture: update(info.posture) })
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
      if ('id' in message) {
        this.replay?.user(peer, message as JsonRpcRequest)
        return this.handleRequest(peer, message as JsonRpcRequest)
      }
      return this.handleNotification(peer, message.method, message.params)
    }
    if ('id' in message) return this.upstream.forwardClientResponse(message as JsonRpcResponse)
    return false
  }

  closePeer(peer: RpcPeer): void {
    this.replay?.disconnect(peer.id)
    this.peers.delete(peer.id)
    for (const [threadId, owner] of this.peerByThread.entries()) {
      if (owner.id === peer.id) this.peerByThread.delete(threadId)
    }
    if (this.primaryPeer?.id === peer.id)
      this.primaryPeer = this.peers.values().next().value ?? null
  }

  afterAccountRestart(): void {
    this.replay?.afterRestart()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.brokerSource?.close()
    await this.claims.stop()
    await this.upstream.stop()
  }

  // Messages from the child: server requests get a rewritten id and go to
  // the thread's peer; notifications are forwarded verbatim (ownership is
  // learned on the way through).
  onUpstreamMessage(incoming: WireMessage): void {
    if (this.stopped) return
    if (!('method' in incoming) || !incoming.method) return
    const accepted = this.continuity ? this.continuity.filter(incoming) : incoming
    if (!accepted || !('method' in accepted) || !accepted.method) return
    const message = this.subagents.present(this.toAppThreadIds(accepted))
    this.accountWork?.observe(message)
    this.replay?.observe(message)
    const params = asRecord(message.params)
    const threadId = threadIdOf(params)
    if ('id' in message && message.id != null) {
      const peer = this.peerForThread(threadId)
      if (!peer) {
        debugLog('codex.mux.serverRequestDropped', { method: message.method, threadId })
        return
      }
      const downId = this.upstream.rewriteServerRequestId((message as JsonRpcRequest).id, peer)
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
      case 'item/completed':
        this.claims.observeItem(asRecord(params.item))
        break
      case 'thread/started': {
        const id = idOf(asRecord(params.thread))
        if (id) this.recordUpstreamThread(id, this.primaryPeer)
        this.claims.observeThread(asRecord(params.thread))
        const deliver = (again: WireMessage) => {
          for (const peer of this.peers.values()) peer.send(again)
        }
        this.subagents.announced(id, message, deliver)
        break
      }
      case 'thread/deleted':
        if (threadId) {
          const upstreamId = this.upstreamIdByApp.get(threadId) ?? threadId
          this.modelReads.invalidate(upstreamId)
          this.upstreamThreads.delete(upstreamId)
          this.store.deleteNativeCodexThread(upstreamId)
          this.subagents.forget(upstreamId)
          this.claims.forget(upstreamId)
          this.activeUpstreamTurns.delete(threadId)
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

  private async handleRequest(peer: RpcPeer, incoming: JsonRpcRequest): Promise<boolean> {
    const { request, start } = takeSubagentStart(incoming, isBridgePeer(peer))
    const method = request.method
    const params = asRecord(request.params)
    if (method === 'initialize') {
      await this.handleInitialize(peer, request)
      return true
    }
    if (this.desktopIdentity) {
      const result = await this.desktopIdentity(method, params)
      if (result !== undefined) {
        peer.send({ jsonrpc: '2.0', id: request.id, result })
        return true
      }
    }
    if (!this.upstream.available) {
      // An unavailable child sends unknown work local, retaining owned threads.
      const threadId = threadIdOf(params)
      if (threadId && this.store.isNativeCodexThread(threadId)) {
        this.failRequest(peer, request.id, 'codex upstream unavailable')
        return true
      }
      return false
    }
    if (MERGED_METHODS.has(method)) {
      await this.handleMerged(peer, request, params)
      return true
    }
    // A model change may hand the thread over before routing it below.
    if (
      (method === 'turn/start' || MODEL_CHANGE_METHODS.has(method)) &&
      (await this.prepareEngineSwitch(peer, request, params))
    )
      return true
    if (await this.continuity?.read(peer, request)) return true
    if (method === 'thread/read' && (await this.mergeRehomedThreadRead(peer, request, params)))
      return true
    if (CONFIG_WRITE_METHODS.has(method)) {
      const plan = await this.configWrites.plan(method, params)
      if ('forward' in plan)
        this.upstream.forwardRequest(plan.peer(peer), request.id, method, plan.forward)
      else if ('error' in plan) this.failRequest(peer, request.id, plan.error)
      else peer.send({ jsonrpc: '2.0', id: request.id, result: plan.answer })
      return true
    }
    const route = this.routeRequest(method, params)
    debugLog('codex.mux.route', { method, id: request.id, route, threadId: threadIdOf(params) })
    if (route === 'local') return false
    const threadId = threadIdOf(params)
    if (threadId) this.peerByThread.set(threadId, peer)
    if (threadId && POSTURE_METHODS.has(method)) this.notePosture(threadId, params)
    const outgoing = this.forUpstream(request, threadId)
    if (await this.continuity?.forward(outgoing.peer(peer), outgoing.request, threadId)) return true
    if (INSTRUCTION_LIFECYCLE_METHODS.has(method)) {
      this.forwardThreadLifecycle(
        outgoing.peer(peer),
        bridgeInstructionRequest(outgoing.request, this.bridgeLine?.() ?? null),
        start,
      )
      return true
    }
    this.upstream.forwardRequest(outgoing.peer(peer), request.id, method, outgoing.request.params)
    return true
  }

  // These requests set the posture of the turns that follow, whichever engine
  // runs them. A thread that has been local keeps it on its row, which bridge
  // children and a switch back read; the child's info (by the child's id)
  // moves with it, so neither can hold a looser posture than the other.
  private notePosture(threadId: string, params: Record<string, unknown>): void {
    const row = rowWithPosture(this.store.getThread(threadId), params)
    if (row) this.store.upsertThread(row)
    const upstreamId = this.upstreamIdByApp.get(threadId) ?? threadId
    const info = this.upstreamThreadInfo(upstreamId)
    const posture = row?.posture ?? (info && applyCodexParams(info.posture, params))
    if (info && posture) {
      this.upstreamThreads.set(upstreamId, { ...info, posture })
      this.continuity?.context.record(threadId, upstreamId, { ...info, posture }, params, {}, false)
    }
  }

  // Restore the app id and present subagents on the answer.
  private forUpstream(
    request: JsonRpcRequest,
    appThreadId: string | null,
  ): { request: JsonRpcRequest; peer: (peer: RpcPeer) => RpcPeer } {
    let params = request.params
    if (request.method === 'turn/start' && appThreadId) {
      const moved = this.store.getThreadEngine(appThreadId)
      if (moved) params = turnWithPosture(asRecord(params), this.store.getThread(appThreadId))
      const pending = moved?.pendingPrefix
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
    // No alias: '' makes both rewrites a no-op.
    const [upId, appId] = appThreadId && upstreamId ? [upstreamId, appThreadId] : ['', '']
    return {
      request: { ...request, params: rewriteThreadIds(params, appId, upId) },
      peer: (peer) => ({
        id: peer.id,
        send: (message) =>
          peer.send(this.subagents.present(rewriteThreadIds(message, upId, appId))),
        close: () => peer.close(),
      }),
    }
  }

  private routeRequest(method: string, params: Record<string, unknown>): Route {
    if (LOCAL_GLOBAL_METHODS.has(method)) return 'local'
    if (method === 'thread/start') return routeThreadStart(params)
    const threadId = threadIdOf(params)
    if (threadId) return this.ownerOf(threadId)
    return 'upstream'
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

  // Own both handshakes: some desktop clients omit their initialized notification.
  private async handleInitialize(peer: RpcPeer, request: JsonRpcRequest): Promise<void> {
    if (this.upstream.available) this.upstream.start()
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
      try {
        upstreamResult =
          this.upstream.cachedInitializeResult ?? (await this.upstream.initialize(request.params))
        if (upstreamResult != null) this.upstream.markInitialized()
      } catch (error) {
        debugLog('codex.mux.initializeUpstreamFailed', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (localError && upstreamResult == null) {
      this.failRequest(peer, request.id, localError.message)
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

  private rememberUpstreamModels(result: Record<string, unknown> | null): void {
    const models = upstreamModelsFrom(result)
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

  private forwardThreadLifecycle(
    peer: RpcPeer,
    request: JsonRpcRequest,
    start: SubagentStart | null = null,
  ): void {
    // Forward verbatim, but learn the resulting thread id from the response
    // (the child allocates ids; `thread/fork` yields a new one), and link a
    // bridge sub-agent to its parent before anything else about it goes out.
    if (start) this.subagents.beginStart()
    const capture: RpcPeer = {
      id: peer.id,
      send: (message) => {
        const response = message as JsonRpcResponse
        const result = asRecord(response.result)
        const id = idOf(asRecord(result.thread))
        if (id) {
          this.recordUpstreamThread(id, peer)
          // Resumed: this thread; forked: its source; started: none.
          const prior = this.upstreamThreads.get(threadIdOf(asRecord(request.params)) ?? id)
          const info = upstreamThreadInfoFrom(result, prior?.posture, peer)
          this.upstreamThreads.set(id, info)
          this.continuity?.context.record(
            this.appIdByUpstream.get(id) ?? id,
            id,
            info,
            asRecord(request.params),
            result,
          )
          this.claims.observeThread(asRecord(result.thread))
        }
        if (start) this.subagents.endStart(id, start)
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
          respond(
            await this.configWrites.mergeRead(
              this.upstream.request('config/read', params),
              this.local.dispatch(peer, 'config/read', params),
            ),
          )
          return
        default:
          fail(new Error(`unmerged method: ${method}`))
      }
    } catch (error) {
      fail(error)
    }
  }

  // An empty `modelProviders` means every provider (schema), not none. The
  // bridge's sub-agents on the child are placed like local ones (listRows).
  private async mergeThreadList(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const raw = Array.isArray(params.modelProviders) ? params.modelProviders : []
    const listed = raw.filter((value): value is string => typeof value === 'string')
    const providers = listed.length > 0 ? listed : null
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
    const visible = this.continuity?.context.presentRows(rawUpstreamData) ?? rawUpstreamData
    const upstreamData = visible.map((entry) => {
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
    const upstreamRows = await this.subagents.listRows(params, upstreamData, !hasCursor, (id) =>
      this.upstream.request('thread/read', { threadId: id, includeTurns: false }),
    )
    const data = dedupeRehomedRows(upstreamRows, localData, (id) => this.currentEngine(id)).sort(
      (a, b) => {
        const av = Number(asRecord(a)[sortKey] ?? 0)
        const bv = Number(asRecord(b)[sortKey] ?? 0)
        if (av !== bv) return (av - bv) * direction
        return String(asRecord(a).id).localeCompare(String(asRecord(b).id)) * direction
      },
    )
    return { ...upstreamResult, data }
  }

  private async mergeLoadedList(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    return mergeLoadedThreads(
      this.local,
      this.upstream,
      peer,
      params,
      (ids) =>
        this.continuity?.context.presentIds(ids) ??
        ids.filter((id): id is string => typeof id === 'string'),
    )
  }

  // Child catalog first (real ChatGPT models, defaults, tiers), Claude
  // entries appended on the last page with isDefault unset so the child's
  // default stays the desktop's default.
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
    if (await this.reserveModels.hidden()) {
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

  // Persisted ownership wins over current routing settings.
  private currentEngine(threadId: string): Engine {
    const rehomed = this.store.getThreadEngine(threadId)
    if (rehomed) return rehomed.engine
    if (this.store.isNativeCodexThread(threadId)) return 'gpt'
    const model = this.local.localThreadModel(threadId)
    if (model != null) return engineForModel(model)
    // Unknown ids belong to the child (CLI resumes, subagents, codex_app).
    return 'gpt'
  }

  // Resolve the selected model before routing, retaining the actual current owner.
  private async prepareEngineSwitch(
    peer: RpcPeer,
    request: JsonRpcRequest,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    const threadId = threadIdOf(params)
    // A summary / title turn carries the desktop's own default model and must
    // never move the thread it is summarizing.
    if (!threadId || params.outputSchema != null) return false
    const requested = typeof params.model === 'string' ? params.model.trim() : ''
    const before = this.currentEngine(threadId)
    const upstreamId = this.upstreamIdByApp.get(threadId) ?? threadId
    const readOwned =
      request.method === 'turn/start' && before === 'gpt' && this.knowsThread(upstreamId)
    const stillOwned = this.modelReads.capture(
      upstreamId,
      () =>
        !this.stopped &&
        this.currentEngine(threadId) === before &&
        (this.upstreamIdByApp.get(threadId) ?? threadId) === upstreamId &&
        this.knowsThread(upstreamId),
    )
    const model = await routedTurnModel(
      requested,
      readOwned ? upstreamId : null,
      this.upstream,
      this.upstreamThreads,
      stillOwned,
    )
    const from = this.currentEngine(threadId)
    if (!requested && from !== before) return false
    if (!requested && readOwned && !stillOwned()) {
      this.failRequest(
        peer,
        request.id,
        'thread ownership changed while reading the selected model',
      )
      return true
    }
    if (model === null) {
      this.failRequest(
        peer,
        request.id,
        'could not determine the owned thread model; retry or select a model',
      )
      return true
    }
    if (!model) return false
    const to = engineForModelRouted(model)
    if (from === to) return false
    if (this.activeUpstreamTurns.has(threadId) || this.local.hasActiveTurn(threadId)) {
      if (request.method !== 'turn/start') {
        // Pin the active owner so the picker change survives until the turn ends.
        // Let the settings update through untouched.
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
      await this.rehomeThread(
        peer,
        threadId,
        from,
        to,
        model,
        params,
        !requested && readOwned ? stillOwned : undefined,
      )
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
    selectedOwner?: () => boolean,
  ): Promise<void> {
    const state = this.store.getThreadEngine(threadId)
    const knownUpstreamId =
      state?.upstreamThreadId ?? (this.store.isNativeCodexThread(threadId) ? threadId : null)
    if (from !== 'gpt' && to !== 'gpt') {
      // Claude <-> Grok rehomes in server.mts; persist its ownership for restart.
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
      await this.rehomeToLocal(
        peer,
        threadId,
        knownUpstreamId,
        to,
        model,
        turnParams,
        selectedOwner,
      )
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
    // Carry only local turns absent from the child's existing history.
    const carried = this.store.getThreadEngine(threadId)?.carriedTurnId ?? null
    const fresh = localTurnsAfter(sides.localTurns, carried)
    const carriedTurnId = idOf(asRecord(sides.localTurns.at(-1))) ?? carried
    const transcript = formatTranscript(transcriptEntriesFromTurns(fresh))
    const posture = toCodexThreadStart(this.local.localThreadPosture(threadId))
    let upstreamId: string | null = null
    if (knownUpstreamId) {
      try {
        // Omit instructions: cold resume would replace the child's stored block.
        const resumed = asRecord(
          await this.upstream.request(
            'thread/resume',
            { threadId: knownUpstreamId, ...(cwd ? { cwd } : {}), ...posture },
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
          bridgeInstructionParams(
            {
              model,
              ...posture,
              ...(cwd ? { cwd } : {}),
              developerInstructions:
                typeof turnParams.developerInstructions === 'string'
                  ? turnParams.developerInstructions
                  : (this.store.getThread(threadId)?.developerInstructions ?? undefined),
            },
            this.bridgeLine?.() ?? null,
          ),
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

  private async rehomeToLocal(
    peer: RpcPeer,
    threadId: string,
    knownUpstreamId: string | null,
    to: Engine,
    model: string,
    turnParams: Record<string, unknown>,
    selectedOwner?: () => boolean,
  ): Promise<void> {
    const sides = await this.readBothSides(peer, threadId, knownUpstreamId)
    if (
      selectedOwner &&
      (!selectedOwner() ||
        this.activeUpstreamTurns.has(threadId) ||
        this.local.hasActiveTurn(threadId))
    )
      throw new Error('thread ownership or active turn changed during handover')
    const upstreamThread = sides.upstreamThread
    this.local.adoptThread(peer, {
      threadId,
      model,
      cwd: rehomeCwd(turnParams, sides.localThread, upstreamThread),
      transcript: formatTranscript(transcriptEntriesFromTurns(sides.turns)),
      preview: typeof upstreamThread?.preview === 'string' ? upstreamThread.preview : '',
      createdAt: typeof upstreamThread?.createdAt === 'number' ? upstreamThread.createdAt : null,
      posture: this.upstreamThreads.get(knownUpstreamId ?? threadId)?.posture ?? null,
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

  private readBothSides(peer: RpcPeer, id: string, nativeId: string | null) {
    return readThreadSides(this.local, this.upstream, peer, id, nativeId, this.currentEngine(id))
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
