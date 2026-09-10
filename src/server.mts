import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  type BridgeControl,
  type BridgeHost,
  type BridgeSubagentThreadInput,
  type BridgeThreadInfo,
  isBridgePeer,
  nicknameFor,
  type ParentItemPhase,
} from './bridge-control.mjs'
import {
  appendBridgeInstructions,
  type BridgeCatalogModel,
  bridgeInstructionsEnabled,
  providerFor,
} from './bridge-instructions.mjs'
import { listClaudeHooks, listClaudeSkills } from './claude-capabilities.mjs'
import {
  type MuxLocalServer,
  NativeCodexMux,
  type RehomeAdoption,
  routeForModel,
} from './codex-mux.mjs'
import {
  codexPluginMarketplaces,
  findCodexPlugin,
  listCodexPlugins,
  pluginDetail,
  readPluginSkill,
  withCodexPluginMcpServers,
} from './codex-plugins.mjs'
import { CodexUpstream } from './codex-upstream.mjs'
import { isGrokModel } from './grok-acp.mjs'
import { grokModelOptions } from './grok-models.mjs'
import { callMcpTool, listMcpServerStatuses, readMcpConfig, readMcpResource } from './mcp.mjs'
import { projectProviderLoopConfig } from './provider-loop-config.mjs'
import {
  hasProviderLoopSelectionInput,
  isProviderLoopSelectionConfigKey,
  type ProviderLoopSelectionInput,
  providerLoopSelectionInputFromConfig,
  providerLoopSelectionInputFromEnv,
  resolveProviderLoopSelection,
} from './provider-loop-selection.mjs'
import { engineForModel, formatTranscript, transcriptEntriesFromTurns } from './rehome.mjs'
import { recordRunEvent } from './run-registry.mjs'
import { normalizeRuntimeType } from './runtime-config.mjs'
import { ServerConfig } from './server-config.mjs'
import {
  approvalKindForTool,
  asRecord,
  buildSystemPromptAddendum,
  compactSummary,
  configEdits,
  configLayerMetadata,
  defaultSelectableModelId,
  emptyTokenBreakdown,
  fallbackStructuredText,
  gitDiff,
  hasLegacyPermissionParams,
  isSubagentToolName,
  listFiles,
  modelFromParams,
  normalizeApprovalPolicy,
  normalizeDecision,
  normalizePersonality,
  normalizeReasoningEffortEnum,
  normalizeSandboxMode,
  normalizeSelectableModelId,
  normalizeSessionSource,
  normalizeThreadSource,
  normalizeUserInputAnswers,
  nullIfEmpty,
  numberOr,
  parseExitCodeFromResult,
  parseSubagentTrailer,
  parseWebSearchAction,
  permissionProfileIdFromParams,
  permissionProfileList,
  permissionProfilePolicy,
  reasoningEffortFromParams,
  reviewLabel,
  reviewPrompt,
  sandboxFromTurnParams,
  stringListFromEnv,
  stringOr,
  summarizeInjectedItem,
  summarizeRpcParams,
  todoWriteToPlanSteps,
  tokenBreakdownFromClaudeUsage,
  toolResultText,
  userInputAnswersAsContent,
  wrapMcpToolError,
  wrapMcpToolResult,
} from './server-helpers.mjs'
import {
  type TurnItemsView,
  threadEnvelope,
  toCompletedTurn,
  toLifecycleTurn,
  toolUseToItem,
  toThread,
  toTurnView,
} from './server-views.mjs'
import { WorkspaceOps } from './server-workspace.mjs'
import type { SessionStore } from './store.mjs'
import type {
  ClaudeRuntime,
  ImageInput,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  PermissionDecision,
  RpcPeer,
  RuntimeEvent,
  ThreadItem,
  ThreadRecord,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  TurnRecord,
  UserInput,
  UserInputAnswers,
  UserInputQuestion,
  WireMessage,
} from './types.mjs'
import {
  adapterHome,
  claudeModelOptions,
  claudeOutputFormat,
  codexCliVersion,
  codexExecRouteEnabled,
  codexHome,
  codexProxyModelOptions,
  codexUserAgent,
  debugLog,
  defaultAllowedTools,
  ensureParent,
  extractImageInputs,
  isCodexOpenAiModel,
  newId,
  normalizeCodexReasoningEffort,
  nowMillis,
  nowSeconds,
  platformFamily,
  platformOs,
  resolveClaudeEffort,
  resolveClaudeModel,
  textFromInput,
} from './util.mjs'
import { parseWorkflowCommand } from './workflow-command.mjs'
import { maybeCreateThreadWorktree } from './worktree.mjs'

const execFileAsync = promisify(execFile)

// A missing Claude Task result must not keep Codex cc in its working state
// forever. This is deliberately a long, configurable watchdog for the whole
// subagent phase; it is not the short journal-drain grace period used when a
// terminal notification has already arrived.
const DEFAULT_SUBAGENT_WATCHDOG_MS = 30 * 60 * 1000
const MIN_SUBAGENT_WATCHDOG_MS = 100

function isWorkflowToolName(value: string): boolean {
  const name = value.trim().toLowerCase()
  return name === 'workflow' || name === 'workflows'
}

function subagentWatchdogTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ANYENGINE_SUBAGENT_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_SUBAGENT_WATCHDOG_MS
  const parsed = Number(raw)
  // Zero is the documented opt-out. Invalid and negative values must fall
  // back to the bounded default rather than silently reintroducing an
  // unbounded loading state.
  if (!Number.isFinite(parsed)) return DEFAULT_SUBAGENT_WATCHDOG_MS
  if (parsed === 0) return 0
  if (parsed < 0) return DEFAULT_SUBAGENT_WATCHDOG_MS
  return Math.max(MIN_SUBAGENT_WATCHDOG_MS, Math.floor(parsed))
}

interface SubagentContext {
  childThreadId: string
  childTurnId: string
  waitItemId: string
  agentPath: string
  prompt: string
  subType: string | null
}

interface ActiveSubagentState {
  thread: ThreadRecord
  turn: TurnRecord
  contexts: Map<string, SubagentContext>
  active: Set<string>
}

interface PeerFeatures {
  // Codex cc 26.818.61809 only accepts started/interacted/interrupted in the
  // subAgentActivity schema. Newer clients may opt into the completed kind
  // explicitly during initialize; keep the legacy wire shape otherwise.
  supportsCompletedSubagentActivity: boolean
}

function turnItemsView(value: unknown): TurnItemsView {
  if (value === 'full' || value === 'summary' || value === 'notLoaded') return value
  return 'summary'
}

export class CodexClaudeAppServer {
  private pendingServerRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private activePeerByThread = new Map<string, RpcPeer>()
  private peerFeatures = new WeakMap<RpcPeer, PeerFeatures>()
  private activeTurnByThread = new Map<string, string>()
  private subagentStateByTurn = new Map<string, ActiveSubagentState>()
  private fuzzySessions = new Map<string, { roots: string[] }>()
  private commandSessionAllow = new Map<string, Set<string>>()
  private goals = new Map<string, Record<string, unknown>>()
  private elicitationCounts = new Map<string, number>()
  private tokenUsageByThread = new Map<string, TokenUsageBreakdown>()
  // The adapter's own settings and the payloads that project them; see
  // src/server-config.mts.
  private readonly config = new ServerConfig()
  private idleCheckHandler: (() => void) | null = null
  // `fs/*`, `command/exec*`, `process/*` and the thread shell command live in
  // src/server-workspace.mts; it owns the child processes and watchers they
  // create and only needs a way back to the peer.
  private readonly workspace = new WorkspaceOps((peer, notification) =>
    this.notify(peer, notification),
  )
  private stopped = false
  // Native-codex multiplexer (docs/guide/backends.md). Null when no real
  // codex binary is configured or ANYENGINE_GPT_ROUTE=exec.
  private mux: NativeCodexMux | null = null
  // Cross-engine bridge (docs/guide/bridge.md); null when ANYENGINE_BRIDGE=0.
  private bridge: BridgeControl | null = null
  // The desktop peer that most recently initialized: where bridge-spawned
  // top-level threads (no ancestor) send their notifications.
  private lastAppPeer: RpcPeer | null = null
  private readonly store: SessionStore
  private readonly runtime: ClaudeRuntime

  constructor(store: SessionStore, runtime: ClaudeRuntime) {
    this.store = store
    this.runtime = runtime
    this.config.load()
  }

  async handle(peer: RpcPeer, message: WireMessage): Promise<void> {
    if ('method' in message && message.method) {
      debugLog('rpc.request', {
        peerId: peer.id,
        id: 'id' in message ? message.id : null,
        method: message.method,
        params: summarizeRpcParams(message.method, message.params),
      })
      if (message.method === 'initialize' && !isBridgePeer(peer)) this.lastAppPeer = peer
      if (this.mux && (await this.mux.handle(peer, message))) return
      if ('id' in message) {
        await this.handleRequest(peer, message as JsonRpcRequest)
      } else {
        await this.handleNotification(peer, message)
      }
      return
    }
    if ('id' in message) {
      debugLog('rpc.responseFromClient', {
        peerId: peer.id,
        id: message.id,
        hasError: Boolean((message as JsonRpcResponse).error),
      })
      if (this.mux && (await this.mux.handle(peer, message))) return
      this.resolveServerRequest(message as JsonRpcResponse)
    }
  }

  closePeer(peer: RpcPeer): void {
    debugLog('peer.close', { peerId: peer.id })
    this.mux?.closePeer(peer)
    if (this.lastAppPeer?.id === peer.id) this.lastAppPeer = null
    for (const [threadId, activePeer] of this.activePeerByThread.entries()) {
      if (activePeer.id === peer.id) this.activePeerByThread.delete(threadId)
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    // Child turns are created directly from Task/Workflow events and are not
    // registered in activeTurnByThread. Finalize them before aborting the
    // runtime or closing SQLite, otherwise stdio EOF can leave child turns
    // persisted as inProgress until a later restart recovery pass.
    this.finalizeActiveSubagentsForShutdown('server stopped')
    this.completeActiveTurns('interrupted', { message: 'server stopped' })
    await this.mux?.stop()
    await this.runtime.stop()
    this.store.close()
  }

  // Put a REAL `codex app-server` child in front of the local layer. `args`
  // is the desktop's argv (leading `-c` globals, `app-server`, its flags)
  // replayed verbatim; `eager` spawns now (stdio mode, one desktop per
  // process) instead of on the first `initialize`.
  attachNativeCodex(options: {
    binary: string
    args: string[]
    eager: boolean
    env?: Record<string, string>
  }): NativeCodexMux {
    const local: MuxLocalServer = {
      dispatch: (peer, method, params) => this.dispatch(peer, method, params),
      localThreadOwner: (threadId) => {
        const thread = this.store.getThread(threadId)
        if (!thread) return null
        return thread.runtimeBackend === 'codex' ? 'codex-exec' : 'claude'
      },
      localThreadModel: (threadId) => this.store.getThread(threadId)?.model ?? null,
      hasActiveTurn: (threadId) => this.activeTurnByThread.has(threadId),
      adoptThread: (peer, input) => this.adoptRehomedThread(peer, input),
    }
    let mux: NativeCodexMux | null = null
    const upstream = new CodexUpstream({
      binary: options.binary,
      args: options.args,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      onMessage: (message) => mux?.onUpstreamMessage(message),
    })
    mux = new NativeCodexMux({
      store: this.store,
      upstream,
      local,
      onNotification: (message) => this.bridge?.onNotification(message),
      bridgeCatalog: () => this.bridgeCatalogForInstructions(),
    })
    this.mux = mux
    debugLog('codex.mux.attach', {
      binary: options.binary,
      args: options.args,
      eager: options.eager,
    })
    if (options.eager) upstream.start()
    return mux
  }

  // A thread handed back to a local engine by the multiplexer (src/rehome.mts).
  // The row may not exist at all — a thread born on the real Codex child is
  // only an id here — so it is created on the spot with the child's cwd and
  // policy. The runtime session is reset either way: neither engine can resume
  // the other's session, so the carried transcript is what continues the
  // conversation, applied to the first turn's prompt.
  private adoptRehomedThread(peer: RpcPeer, input: RehomeAdoption): void {
    const now = nowSeconds()
    const existing = this.store.getThread(input.threadId)
    const thread: ThreadRecord = existing
      ? {
          ...existing,
          model: input.model,
          cwd: input.cwd ?? existing.cwd,
          updatedAt: now,
          status: { type: 'idle' },
          runtimeBackend: 'claude',
          claudeSessionId: null,
          codexSessionId: null,
          rehomePrefix: input.transcript,
        }
      : {
          id: input.threadId,
          sessionId: input.threadId,
          forkedFromId: null,
          preview: input.preview ?? '',
          name: null,
          archived: false,
          cwd: input.cwd ?? process.cwd(),
          model: input.model,
          reasoningEffort: null,
          modelProvider: 'claude-code',
          claudeSessionId: null,
          source: 'appServer',
          createdAt: input.createdAt ?? now,
          updatedAt: now,
          status: { type: 'idle' },
          approvalPolicy: input.approvalPolicy ?? 'never',
          sandboxMode: input.sandboxMode ?? 'danger-full-access',
          permissionProfileId: null,
          ephemeral: false,
          threadSource: 'user',
          agentRole: null,
          agentNickname: null,
          baseInstructions: null,
          developerInstructions: null,
          personality: null,
          runtimeBackend: 'claude',
          codexSessionId: null,
          rehomePrefix: input.transcript,
        }
    this.store.upsertThread(thread)
    this.activePeerByThread.set(thread.id, peer)
  }

  // Claude <-> Grok mid-thread switch. Both engines are served by the local
  // layer, so the multiplexer leaves this one here (and it works with no
  // native Codex child attached at all). gpt-* never reaches this path.
  private rehomeLocalThread(thread: ThreadRecord, model: string): void {
    const from = engineForModel(thread.model)
    const to = engineForModel(model)
    if (from === to || from === 'gpt' || to === 'gpt') return
    const transcript = formatTranscript(transcriptEntriesFromTurns(this.store.listTurns(thread.id)))
    thread.claudeSessionId = null
    thread.rehomePrefix = transcript
    debugLog('thread.rehomed', {
      threadId: thread.id,
      from,
      to,
      carriedChars: transcript?.length ?? 0,
    })
    recordRunEvent('thread.rehomed', { threadId: thread.id, from, to })
  }

  // The carried transcript rides on the prompt of the first turn after a
  // switch and is consumed there. Never on a summary/title turn: those run on
  // their own model and must not inherit a conversation.
  private applyRehomePrefix(thread: ThreadRecord, prompt: string, isSummary: boolean): string {
    const prefix = thread.rehomePrefix
    if (!prefix || isSummary) return prompt
    thread.rehomePrefix = null
    this.store.updateRehomePrefix(thread.id, null)
    return prompt ? `${prefix}\n\n${prompt}` : prefix
  }

  hasActiveTurns(): boolean {
    return this.activeTurnByThread.size > 0
  }

  setBridge(bridge: BridgeControl | null): void {
    this.bridge = bridge
  }

  // Everything a thread can spawn through the bridge: the local Claude / Grok
  // (and legacy codex-exec) entries plus the native child's catalog as last
  // listed. Null when the bridge or its standing instructions are off.
  bridgeCatalogForInstructions(): BridgeCatalogModel[] | null {
    if (!this.bridge || !bridgeInstructionsEnabled()) return null
    const seen = new Set<string>()
    const catalog: BridgeCatalogModel[] = []
    const upstream = this.mux?.active ? (this.mux.upstreamModels() ?? []) : []
    for (const option of [...this.localModelOptions(), ...upstream]) {
      if (seen.has(option.id)) continue
      seen.add(option.id)
      catalog.push({
        id: option.id,
        displayName: option.displayName,
        provider: providerFor(option.id),
        isDefault: option.isDefault === true,
      })
    }
    return catalog
  }

  private localModelOptions(): Array<{ id: string; displayName: string; isDefault?: boolean }> {
    const options = [...claudeModelOptions(), ...codexProxyModelOptions(), ...grokModelOptions()]
    const defaultModel = this.config.model
    return options.map((option) => ({
      id: option.id,
      displayName: option.displayName,
      isDefault: option.id === defaultModel || option.isDefault === true,
    }))
  }

  // What the cross-engine bridge (src/bridge-control.mts) borrows from the
  // protocol layer. Requests come back in through `handle` under a bridge
  // peer, so routing and persistence stay the desktop's code paths.
  bridgeHost(): BridgeHost {
    return {
      handle: (peer, message) => this.handle(peer, message),
      closePeer: (peer) => this.closePeer(peer),
      appPeerFor: (threadId) => this.appPeerFor(threadId),
      threadInfo: (threadId) => this.bridgeThreadInfo(threadId),
      routeForModel: (model) => (this.mux?.active ? routeForModel(model) : 'local'),
      soleActiveThread: () => {
        const ids = new Set<string>(this.activeTurnByThread.keys())
        for (const id of this.mux?.activeUpstreamThreadIds() ?? []) ids.add(id)
        return ids.size === 1 ? ([...ids][0] ?? null) : null
      },
      createSubagentThread: (input) => this.createBridgeSubagentThread(input),
      emitParentItem: (parentThreadId, turnId, item, phase) =>
        this.emitBridgeParentItem(parentThreadId, turnId, item, phase),
      supportsCompletedActivity: (threadId) => {
        const peer = this.appPeerFor(threadId)
        return peer ? this.supportsCompletedSubagentActivity(peer) : false
      },
    }
  }

  // Nearest desktop peer up the thread's ancestry (bridge peers are skipped:
  // they only relay), else the primary desktop peer.
  private appPeerFor(threadId: string | null): RpcPeer | null {
    const seen = new Set<string>()
    let current = threadId
    while (current && !seen.has(current)) {
      seen.add(current)
      const peer = this.activePeerByThread.get(current)
      if (peer && !isBridgePeer(peer)) return peer
      current = this.store.getThread(current)?.forkedFromId ?? null
    }
    const primary = this.mux?.primaryAppPeer ?? null
    if (primary && !isBridgePeer(primary)) return primary
    return this.lastAppPeer
  }

  private bridgeThreadInfo(threadId: string): BridgeThreadInfo | null {
    const local = this.store.getThread(threadId)
    if (local) {
      return {
        id: threadId,
        owner: 'local',
        cwd: local.cwd,
        model: local.model,
        approvalPolicy: local.approvalPolicy,
        sandboxMode: local.sandboxMode,
        activeTurnId: this.activeTurnByThread.get(threadId) ?? null,
      }
    }
    const upstream = this.mux?.upstreamThreadInfo(threadId)
    if (!upstream) return null
    return {
      id: threadId,
      owner: 'upstream',
      ...upstream,
      activeTurnId: this.mux?.activeUpstreamTurnId(threadId) ?? null,
    }
  }

  // A bridge sub-agent thread mirrors what the Task tool path creates: a
  // child linked to its parent (parentThreadId, agentRole/agentNickname) that
  // the desktop shows under the parent. Its turn is a real turn started by
  // the bridge through `turn/start`.
  private createBridgeSubagentThread(input: BridgeSubagentThreadInput): {
    threadId: string
    agentNickname: string
    agentPath: string
  } {
    const parent = this.store.getThread(input.parentThreadId)
    const now = nowSeconds()
    const id = newId()
    const agentNickname = nicknameFor(id)
    const thread: ThreadRecord = {
      id,
      sessionId: parent?.sessionId ?? id,
      forkedFromId: input.parentThreadId,
      preview: input.prompt.slice(0, 200),
      name: input.name,
      archived: false,
      cwd: input.cwd,
      model: input.model,
      reasoningEffort: parent?.reasoningEffort ?? this.config.reasoningEffort,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      source: normalizeSessionSource(parent?.source ?? 'appServer'),
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
      approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy) ?? 'never',
      sandboxMode: normalizeSandboxMode(input.sandboxMode) ?? 'danger-full-access',
      permissionProfileId: null,
      ephemeral: true,
      threadSource: 'subagent',
      agentRole: input.name ?? 'bridge',
      agentNickname,
      baseInstructions: parent?.baseInstructions ?? null,
      developerInstructions: parent?.developerInstructions ?? null,
      personality: parent?.personality ?? null,
      runtimeBackend: 'claude',
      codexSessionId: null,
    }
    this.store.upsertThread(thread)
    this.activePeerByThread.set(id, input.peer)
    recordRunEvent('subagent.spawned', {
      parentThreadId: input.parentThreadId,
      parentTurnId: null,
      childThreadId: id,
      model: input.model,
      agentRole: thread.agentRole,
      agentNickname,
      via: 'bridge',
    })
    this.notify(input.peer, {
      method: 'thread/started',
      params: { thread: this.toThread(thread, []) },
    })
    return { threadId: id, agentNickname, agentPath: `/root/${agentNickname}` }
  }

  // Parent-side collab items for a bridge sub-agent. Persisted when the
  // parent's turn lives in our store (a local parent); a child-owned (gpt-*)
  // parent only gets the live notifications.
  private emitBridgeParentItem(
    parentThreadId: string,
    turnId: string,
    item: ThreadItem,
    phase: ParentItemPhase,
  ): void {
    const turn = this.store.getTurn(turnId)
    const persist = turn != null && turn.threadId === parentThreadId
    const peer = this.appPeerFor(parentThreadId)
    const params = { threadId: parentThreadId, turnId, item }
    if (phase === 'begin' && persist) this.store.appendItem(turnId, item)
    if (phase === 'end' && persist) this.store.updateItem(turnId, item.id, () => item)
    if (phase === 'endMove' && persist)
      this.store.updateItemAndMoveToEnd(turnId, item.id, () => item)
    if (!peer) return
    if (phase === 'lifecycle') {
      this.emitItemLifecycle(peer, parentThreadId, turnId, item)
      return
    }
    if (phase === 'begin') {
      this.notify(peer, { method: 'item/started', params: { ...params, startedAtMs: nowMillis() } })
      return
    }
    this.notify(peer, {
      method: 'item/completed',
      params: { ...params, completedAtMs: nowMillis() },
    })
  }

  setIdleCheckHandler(handler: () => void): void {
    this.idleCheckHandler = handler
  }

  private async handleNotification(_peer: RpcPeer, _message: WireMessage): Promise<void> {
    // Currently only `initialized` is expected from clients.
  }

  private async handleRequest(peer: RpcPeer, request: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.dispatch(peer, request.method, request.params ?? {})
      debugLog('rpc.response', {
        peerId: peer.id,
        id: request.id,
        method: request.method,
        ok: true,
      })
      this.sendResponse(peer, request.id, result)
    } catch (error) {
      debugLog('rpc.response', {
        peerId: peer.id,
        id: request.id,
        method: request.method,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
      })
      this.sendResponse(peer, request.id, undefined, {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async dispatch(peer: RpcPeer, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const initParams = asRecord(params)
        const clientInfo = asRecord(initParams.clientInfo)
        const capabilities = asRecord(initParams.capabilities)
        const declaredActivityKinds = Array.isArray(capabilities.subAgentActivityKinds)
          ? capabilities.subAgentActivityKinds
          : []
        this.peerFeatures.set(peer, {
          supportsCompletedSubagentActivity:
            capabilities.subAgentActivityCompleted === true ||
            declaredActivityKinds.includes('completed') ||
            process.env.ANYENGINE_SUBAGENT_COMPLETED === '1',
        })
        // Push the account snapshot + MCP server statuses right after handshake
        // so the App's sidebar avatar and MCP panel populate without waiting
        // for the next polling cycle. Without these the avatar stays "signed
        // out" and the MCP list never reflects current boot state.
        // With a real codex child attached, the child emits the real
        // account/updated and MCP startup statuses; ours would be wrong.
        if (this.mux?.active) {
          return {
            userAgent: codexUserAgent(
              stringOr(clientInfo.name, 'codex-app'),
              stringOr(clientInfo.version, 'unknown'),
            ),
            codexHome: codexHome(),
            platformFamily: platformFamily(),
            platformOs: platformOs(),
          }
        }
        queueMicrotask(() => {
          this.notify(peer, {
            method: 'account/updated',
            params: { authMode: 'apikey', planType: null },
          })
          for (const status of readMcpConfig().startupStatuses) {
            this.notify(peer, {
              method: 'mcpServer/startupStatus/updated',
              params: { name: status.name, status: status.status, error: status.error ?? null },
            })
          }
        })
        return {
          userAgent: codexUserAgent(
            stringOr(clientInfo.name, 'codex-app'),
            stringOr(clientInfo.version, 'unknown'),
          ),
          codexHome: codexHome(),
          platformFamily: platformFamily(),
          platformOs: platformOs(),
        }
      }
      case 'thread/start':
        return this.threadStart(peer, asRecord(params))
      case 'thread/resume':
        return this.threadResume(peer, asRecord(params))
      case 'thread/fork':
        return this.threadFork(peer, asRecord(params))
      case 'thread/list':
        return this.threadList(asRecord(params))
      case 'thread/read':
        return this.threadRead(asRecord(params))
      case 'thread/turns/list':
        return this.threadTurnsList(asRecord(params))
      case 'thread/turns/items/list':
        return this.threadTurnItemsList(asRecord(params))
      case 'thread/name/set':
        return this.threadNameSet(asRecord(params))
      case 'thread/archive':
        return this.threadArchive(asRecord(params), true)
      case 'thread/unsubscribe':
        return this.threadUnsubscribe(peer, asRecord(params))
      case 'thread/increment_elicitation':
        return this.threadAdjustElicitation(asRecord(params), 1)
      case 'thread/decrement_elicitation':
        return this.threadAdjustElicitation(asRecord(params), -1)
      case 'thread/goal/set':
        return this.threadGoalSet(asRecord(params))
      case 'thread/goal/get':
        return this.threadGoalGet(asRecord(params))
      case 'thread/goal/clear':
        return this.threadGoalClear(asRecord(params))
      // ChatGPT.app 26.901 sends `thread/settings/update` for two different
      // things: the picker's model + effort (17 of 19 calls in a day's live
      // log) and, rarely, an approval-policy change. Both land here. A second,
      // permission-profile handler used to sit further down the same switch
      // and therefore never ran; it is gone. See docs/review-a2.md.
      case 'thread/metadata/update':
      case 'thread/settings/update':
        return this.threadMetadataUpdate(asRecord(params))
      // Intentional no-ops: Claude Code has no equivalent concept, so the
      // adapter acknowledges the call without side effects rather than failing
      // the RPC (which would break the Codex App connection).
      case 'thread/memoryMode/set':
      case 'memory/reset':
        return {}
      case 'thread/unarchive':
        return this.threadArchive(asRecord(params), false)
      case 'thread/compact/start':
        return this.threadCompactStart(peer, asRecord(params))
      case 'thread/shellCommand':
        return this.threadShellCommand(peer, asRecord(params))
      case 'thread/approveGuardianDeniedAction': {
        // Codex App's "Guardian" is an OpenAI-side pre-tool safety classifier
        // that can deny a tool call before it reaches the runtime. Claude
        // Code has no equivalent — every denial in our pipeline already
        // routes through the canUseTool round-trip, which the user resolves
        // directly via the standard approval modal. There is no separate
        // guardian-denied action to retry. We log the event (for parity
        // debugging) and ack with the schema-correct {} response.
        const evt = asRecord(params).event
        debugLog('thread.approveGuardianDeniedAction', {
          threadId: stringOr(asRecord(params).threadId, ''),
          eventType:
            evt && typeof evt === 'object' ? ((evt as Record<string, unknown>).type ?? null) : null,
        })
        return {}
      }
      case 'thread/backgroundTerminals/clean':
        return this.threadBackgroundTerminalsClean(asRecord(params))
      case 'thread/rollback':
        return this.threadRollback(asRecord(params))
      case 'thread/loaded/list':
        return this.threadLoadedList(asRecord(params))
      case 'thread/inject_items':
        return this.threadInjectItems(peer, asRecord(params))
      case 'turn/start':
        return this.turnStart(peer, asRecord(params))
      case 'turn/steer':
        return this.turnSteer(peer, asRecord(params))
      case 'turn/interrupt':
        return this.turnInterrupt(peer, asRecord(params))
      // Realtime voice is unsupported: Claude Code has no realtime audio
      // channel. These ack so the App's capability probe does not error; a
      // real session would need a separate audio backend.
      case 'thread/realtime/start':
      case 'thread/realtime/appendAudio':
      case 'thread/realtime/appendText':
      case 'thread/realtime/stop':
        return {}
      case 'thread/realtime/listVoices':
        return { voices: { v1: [], v2: [], defaultV1: null, defaultV2: null } }
      case 'review/start':
        return this.reviewStart(peer, asRecord(params))
      case 'config/read':
        return this.config.readPayload()
      case 'configRequirements/read':
        return { requirements: null }
      case 'model/list':
        return this.config.modelListPayload()
      case 'modelProvider/capabilities/read':
        return {
          namespaceTools: true,
          imageGeneration: false,
          // Claude Code SDK ships a WebSearch tool. Default to advertising it
          // so Codex App shows the search affordance; ANYENGINE_WEBSEARCH=0
          // turns it off for environments where the tool is rate-limited.
          webSearch: process.env.ANYENGINE_WEBSEARCH !== '0',
        }
      // `permissionProfile/list` was listed twice; the second arm was
      // unreachable. The helper returns the same three profiles for a call
      // with no cursor/limit and additionally honours pagination, so it is
      // kept and the inline copy dropped (docs/review-a2.md).
      case 'permissionProfile/list':
        return permissionProfileList(asRecord(params))
      case 'experimentalFeature/list':
        return { data: [], nextCursor: null }
      case 'experimentalFeature/enablement/set':
        return { enablement: asRecord(asRecord(params).enablement) }
      case 'collaborationMode/list':
        return method === 'collaborationMode/list' ? { data: [] } : {}
      case 'mock/experimentalMethod':
        return {
          echoed: typeof asRecord(params).value === 'string' ? asRecord(params).value : null,
        }
      case 'skills/list':
        return { data: listClaudeSkills(asRecord(params)) }
      case 'hooks/list':
        return { data: listClaudeHooks(asRecord(params)) }
      case 'marketplace/add':
        return this.marketplaceAdd(asRecord(params))
      case 'marketplace/remove':
        return this.marketplaceRemove(asRecord(params))
      case 'marketplace/upgrade':
        return this.marketplaceUpgrade(asRecord(params))
      // The Plugins pane pairs `plugin/list` with `plugin/installed`, and while
      // either one fails it treats the pane as still loading and re-polls every
      // two seconds — the "Loading plugins…" spinner never settles. Both read
      // CODEX_HOME off disk (src/codex-plugins.mts) and answer in a millisecond.
      case 'plugin/list':
        return {
          marketplaces: codexPluginMarketplaces(listCodexPlugins()),
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        }
      case 'plugin/installed':
        return {
          marketplaces: codexPluginMarketplaces(listCodexPlugins()),
          marketplaceLoadErrors: [],
        }
      case 'plugin/read':
        return this.pluginRead(asRecord(params))
      case 'plugin/skill/read': {
        const p = asRecord(params)
        const plugin = findCodexPlugin(
          listCodexPlugins(),
          stringOr(p.remotePluginId, ''),
          stringOr(p.remoteMarketplaceName, '') || null,
        )
        return { contents: plugin ? readPluginSkill(plugin, stringOr(p.skillName, '')) : null }
      }
      // ExternalAgentConfigImportHistoriesReadResponse. The app polls this
      // beside the plugin catalog; an error here kept the same pane spinning.
      case 'externalAgentConfig/import/readHistories':
        return { data: [], connectors: [] }
      case 'plugin/share/save':
        return this.pluginShareSave(asRecord(params))
      case 'plugin/share/updateTargets':
        return this.pluginShareUpdateTargets(asRecord(params))
      case 'plugin/share/delete':
      case 'plugin/uninstall':
        return {}
      case 'plugin/install':
        return { authPolicy: 'ON_USE', appsNeedingAuth: [] }
      case 'skills/config/write':
        return { effectiveEnabled: asRecord(params).enabled === true }
      case 'plugin/share/list':
        return { data: [] }
      // Stub the three RPC methods Codex App may call but our dispatcher
      // previously threw "method not implemented" on. Stubs return the
      // schema-correct empty shape so the App's call sites don't surface an
      // RPC error toast.
      // Codex App 26.9xx sidebar sections (ThreadSection* in the v2 schema).
      // We persist none, so list is empty and mutations are accepted no-ops.
      case 'threadSection/list':
        return { data: [], nextCursor: null }
      case 'threadSection/create':
      case 'threadSection/update': {
        const p = asRecord(params)
        return {
          section: {
            id: typeof p.sectionId === 'string' ? p.sectionId : randomUUID(),
            name: typeof p.name === 'string' ? p.name : '',
            appearance: null,
          },
        }
      }
      case 'threadSection/delete':
      case 'threadSection/move':
        return {}
      case 'plugin/share/checkout':
        // PluginShareCheckoutResponse — App polls after a share/save; nothing to checkout.
        return {}
      case 'environment/add':
        // EnvironmentAddResponse — adds a workspace environment; we have no concept of one.
        return {}
      case 'attestation/generate':
        // AttestationGenerateResponse — returns a signed blob; clients with
        // requestAttestation:true expect a string. Empty string is permissive.
        return { attestation: '' }
      case 'app/list':
        return { data: [], nextCursor: null }
      case 'mcpServer/oauth/login':
        return {
          authorizationUrl: `https://localhost.invalid/anyengine/mcp-oauth/${encodeURIComponent(stringOr(asRecord(params).name, 'server'))}`,
        }
      case 'config/mcpServer/reload':
        return {}
      case 'mcpServerStatus/list':
        return listMcpServerStatuses().then((data) => ({ data, nextCursor: null }))
      case 'mcpServer/resource/read':
        return readMcpResource(
          stringOr(asRecord(params).server, ''),
          stringOr(asRecord(params).uri, ''),
        )
      case 'mcpServer/tool/call':
        return callMcpTool(
          stringOr(asRecord(params).server, ''),
          stringOr(asRecord(params).tool, ''),
          asRecord(params).arguments ?? {},
        )
      case 'windowsSandbox/setupStart':
        return { started: false }
      case 'windowsSandbox/readiness':
        return { status: 'notConfigured' }
      case 'account/login/start':
        return { type: 'apiKey' }
      case 'account/login/cancel':
        return { status: 'notFound' }
      case 'account/logout':
        return {}
      case 'account/sendAddCreditsNudgeEmail':
        return { status: 'cooldown_active' }
      case 'feedback/upload':
        return { threadId: stringOr(asRecord(params).threadId, '') }
      case 'account/read':
        // The App applies its OpenAI hidden-model allowlist unless auth is
        // Bedrock-shaped. Claude Code is externally authenticated, so use that
        // local auth shape to keep Claude aliases visible in the model picker.
        return { account: { type: 'amazonBedrock' }, requiresOpenaiAuth: false }
      case 'account/rateLimits/read':
        return this.accountRateLimits()
      case 'fs/readFile':
        return this.workspace.fsReadFile(asRecord(params))
      case 'fs/readDirectory':
        return this.workspace.fsReadDirectory(asRecord(params))
      case 'fs/getMetadata':
        return this.workspace.fsGetMetadata(asRecord(params))
      case 'fs/writeFile':
        return this.workspace.fsWriteFile(asRecord(params))
      case 'fs/createDirectory':
        return this.workspace.fsCreateDirectory(asRecord(params))
      case 'fs/remove':
        return this.workspace.fsRemove(asRecord(params))
      case 'fs/copy':
        return this.workspace.fsCopy(asRecord(params))
      case 'fs/watch':
        return this.workspace.fsWatch(peer, asRecord(params))
      case 'fs/unwatch':
        return this.workspace.fsUnwatch(asRecord(params))
      case 'command/exec':
        return this.workspace.commandExec(peer, asRecord(params))
      case 'command/exec/write':
        return this.workspace.commandExecWrite(asRecord(params))
      case 'command/exec/terminate':
        return this.workspace.commandExecTerminate(asRecord(params))
      case 'command/exec/resize':
        return {}
      case 'process/spawn':
        return this.workspace.processSpawn(peer, asRecord(params))
      case 'process/writeStdin':
        return this.workspace.processWriteStdin(asRecord(params))
      case 'process/kill':
        return this.workspace.processKill(asRecord(params))
      case 'process/resizePty':
        return this.workspace.processResizePty(asRecord(params))
      case 'externalAgentConfig/detect':
        return { items: [] }
      case 'externalAgentConfig/import':
        return {}
      case 'config/value/write':
      case 'config/batchWrite':
        return this.config.writeResponse(asRecord(params))
      case 'getConversationSummary':
        return this.getConversationSummary(asRecord(params))
      case 'gitDiffToRemote':
        return this.gitDiffToRemote(asRecord(params))
      case 'getAuthStatus':
        return { authMethod: null, authToken: null, requiresOpenaiAuth: false }
      case 'fuzzyFileSearch':
        return this.fuzzyFileSearch(asRecord(params))
      case 'fuzzyFileSearch/sessionStart':
        return this.fuzzySessionStart(asRecord(params))
      case 'fuzzyFileSearch/sessionUpdate':
        return this.fuzzySessionUpdate(peer, asRecord(params))
      case 'fuzzyFileSearch/sessionStop':
        return this.fuzzySessionStop(peer, asRecord(params))
      default:
        throw new Error(`method not implemented: ${method}`)
    }
  }

  private threadStart(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const id = newId()
    const now = nowSeconds()
    const requestedCwd = stringOr(params.cwd, process.cwd())
    const cwd = maybeCreateThreadWorktree(id, requestedCwd).cwd
    const model = modelFromParams(params, this.config.model)
    const reasoningEffort = reasoningEffortFromParams(params, this.config.reasoningEffort)
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
    const selectedProviderLoop = resolveProviderLoopSelection(
      this.config.providerLoopSelectionInput(),
    )
    const isTitleOrHelper =
      params.ephemeral === true ||
      params.threadSource === 'title_generation' ||
      params.threadSource === 'memory_consolidation'
    // Pick the runtime backend from the chosen model. gpt-* normally never
    // reaches here: the native-codex multiplexer forwards it to the real
    // child. Reaching here means no child is attached (no binary) and the
    // legacy `codex exec` proxy is not opted in (ANYENGINE_GPT_ROUTE=exec),
    // so refuse instead of handing a gpt id to the Claude CLI. The desktop's
    // hidden title/summary threads are the exception (ANYENGINE_TITLE_ROUTE
    // =local): they stay on the Claude backend, whose summary path maps gpt-*
    // to the summary model.
    const codexBackendRequested =
      selectedProviderLoop.runtimeType === 'codex-proxy' || isCodexOpenAiModel(model)
    const execRoute = codexExecRouteEnabled() || process.env.ANYENGINE_MOCK === '1'
    const gptWithoutRoute = isCodexOpenAiModel(model) && !execRoute
    if (gptWithoutRoute && !isTitleOrHelper) {
      throw new Error(
        `no native codex upstream for model ${model}; set ANYENGINE_REAL_CODEX or ANYENGINE_GPT_ROUTE=exec`,
      )
    }
    const thread: ThreadRecord = {
      id,
      sessionId: id,
      forkedFromId: null,
      preview: '',
      name: null,
      archived: false,
      cwd,
      model,
      reasoningEffort,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      // v2 SessionSource is camelCase; the old `app_server` falls through to
      // `unknown` on the App side, hiding the source in the thread sidebar.
      source: 'appServer',
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
      approvalPolicy:
        permissionProfile?.approvalPolicy ??
        normalizeApprovalPolicy(params.approvalPolicy) ??
        'never',
      sandboxMode:
        permissionProfile?.sandboxMode ??
        normalizeSandboxMode(params.sandbox) ??
        'danger-full-access',
      permissionProfileId: permissionProfile?.id ?? null,
      ephemeral: isTitleOrHelper,
      threadSource: normalizeThreadSource(params.threadSource),
      agentRole: nullIfEmpty(typeof params.agentRole === 'string' ? params.agentRole : null),
      agentNickname: nullIfEmpty(
        typeof params.agentNickname === 'string' ? params.agentNickname : null,
      ),
      baseInstructions: nullIfEmpty(
        typeof params.baseInstructions === 'string' ? params.baseInstructions : null,
      ),
      developerInstructions: nullIfEmpty(
        typeof params.developerInstructions === 'string' ? params.developerInstructions : null,
      ),
      personality: normalizePersonality(params.personality),
      runtimeBackend: codexBackendRequested && !gptWithoutRoute ? 'codex' : 'claude',
      codexSessionId: null,
    }
    this.store.upsertThread(thread)
    recordRunEvent('thread.started', {
      threadId: thread.id,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
    })
    this.activePeerByThread.set(id, peer)
    this.notify(peer, { method: 'thread/started', params: { thread: this.toThread(thread, []) } })
    return this.threadEnvelope(thread)
  }

  private threadResume(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error('unknown thread: ' + threadId)
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    const rawModel = modelFromParams(params, null)
    const model = rawModel ? normalizeSelectableModelId(rawModel, thread.model) : null
    const reasoningEffort = reasoningEffortFromParams(params, null)
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
    if (model) {
      // runtimeBackend is pinned at thread/start. Refuse cross-backend
      // model changes on resume — the conversation history wouldn't carry
      // over between Claude SDK and `codex exec`. App's model picker can
      // still rebind same-backend models (e.g. sonnet → opus).
      const newBackend = isCodexOpenAiModel(model) ? 'codex' : 'claude'
      if (newBackend === thread.runtimeBackend) {
        thread.model = model
      } else {
        debugLog('thread.resume.modelBackendMismatch', {
          threadId,
          oldModel: thread.model,
          newModel: model,
          oldBackend: thread.runtimeBackend,
          newBackend,
        })
      }
    }
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    if (permissionProfileId) {
      thread.permissionProfileId = permissionProfileId
      if (permissionProfile?.approvalPolicy)
        thread.approvalPolicy = permissionProfile.approvalPolicy
      if (permissionProfile?.sandboxMode) thread.sandboxMode = permissionProfile.sandboxMode
    } else {
      if (hasLegacyPermissionParams(params)) thread.permissionProfileId = null
      if (typeof params.approvalPolicy === 'string')
        thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
      if (typeof params.sandbox === 'string')
        thread.sandboxMode = normalizeSandboxMode(params.sandbox)
    }
    if (typeof params.threadSource === 'string')
      thread.threadSource = normalizeThreadSource(params.threadSource)
    if (typeof params.baseInstructions === 'string')
      thread.baseInstructions = nullIfEmpty(params.baseInstructions)
    if (typeof params.developerInstructions === 'string')
      thread.developerInstructions = nullIfEmpty(params.developerInstructions)
    if (typeof params.personality === 'string')
      thread.personality = normalizePersonality(params.personality)
    this.store.upsertThread(thread)
    recordRunEvent('thread.resumed', {
      threadId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
    })
    this.activePeerByThread.set(threadId, peer)
    this.bindPeerToDescendants(peer, threadId)
    return this.threadEnvelope(
      thread,
      params.excludeTurns === true ? [] : this.store.listTurns(thread.id),
    )
  }

  private threadFork(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const parentId = stringOr(params.threadId, '')
    const parent = this.store.getThread(parentId)
    if (!parent) throw new Error(`unknown thread: ${parentId}`)
    const now = nowSeconds()
    const id = newId()
    const requestedCwd = stringOr(params.cwd, parent.cwd)
    const cwd = maybeCreateThreadWorktree(id, requestedCwd).cwd
    const thread: ThreadRecord = {
      ...parent,
      id,
      sessionId: parent.sessionId,
      forkedFromId: parent.id,
      archived: false,
      cwd,
      model: modelFromParams(params, parent.model),
      reasoningEffort: reasoningEffortFromParams(params, parent.reasoningEffort),
      claudeSessionId: parent.claudeSessionId,
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
      approvalPolicy:
        permissionProfilePolicy(permissionProfileIdFromParams(params))?.approvalPolicy ??
        (typeof params.approvalPolicy === 'string'
          ? normalizeApprovalPolicy(params.approvalPolicy)
          : parent.approvalPolicy),
      sandboxMode:
        permissionProfilePolicy(permissionProfileIdFromParams(params))?.sandboxMode ??
        (typeof params.sandbox === 'string'
          ? normalizeSandboxMode(params.sandbox)
          : parent.sandboxMode),
      permissionProfileId:
        permissionProfileIdFromParams(params) ??
        (hasLegacyPermissionParams(params) ? null : (parent.permissionProfileId ?? null)),
      ephemeral: parent.ephemeral,
      threadSource:
        typeof params.threadSource === 'string'
          ? normalizeThreadSource(params.threadSource)
          : normalizeThreadSource(parent.threadSource),
      agentRole: nullIfEmpty(
        typeof params.agentRole === 'string' ? params.agentRole : parent.agentRole,
      ),
      agentNickname: nullIfEmpty(
        typeof params.agentNickname === 'string' ? params.agentNickname : parent.agentNickname,
      ),
      baseInstructions: nullIfEmpty(
        typeof params.baseInstructions === 'string'
          ? params.baseInstructions
          : parent.baseInstructions,
      ),
      developerInstructions: nullIfEmpty(
        typeof params.developerInstructions === 'string'
          ? params.developerInstructions
          : parent.developerInstructions,
      ),
      personality:
        typeof params.personality === 'string'
          ? normalizePersonality(params.personality)
          : parent.personality,
      // Fork: model may flip backend (forking from claude-thread with a
      // gpt-* model = new codex-backed thread); otherwise inherit parent.
      runtimeBackend: isCodexOpenAiModel(modelFromParams(params, parent.model))
        ? 'codex'
        : 'claude',
      codexSessionId: null,
    }
    this.store.upsertThread(thread)
    recordRunEvent('thread.forked', {
      threadId: thread.id,
      parentThreadId: parent.id,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      threadSource: thread.threadSource,
      ephemeral: thread.ephemeral,
    })
    this.activePeerByThread.set(id, peer)
    this.notify(peer, { method: 'thread/started', params: { thread: this.toThread(thread, []) } })
    return this.threadEnvelope(
      thread,
      params.excludeTurns === true ? [] : this.store.listTurns(parent.id),
    )
  }

  private threadList(params: Record<string, unknown>): unknown {
    const sourceKinds = Array.isArray(params.sourceKinds)
      ? params.sourceKinds.filter((value): value is string => typeof value === 'string')
      : []
    const parentThreadId =
      typeof params.parentThreadId === 'string' && params.parentThreadId.length > 0
        ? params.parentThreadId
        : null
    const ancestorThreadId =
      typeof params.ancestorThreadId === 'string' && params.ancestorThreadId.length > 0
        ? params.ancestorThreadId
        : null
    const sortKey =
      params.sortKey === 'updated_at' || params.sortKey === 'recency_at'
        ? params.sortKey
        : 'created_at'
    const sortDirection = params.sortDirection === 'asc' ? 'asc' : 'desc'
    const threads = this.store.listThreads({
      archived: (params.archived as boolean | null | undefined) ?? null,
      limit: numberOr(params.limit, 50),
      cursor: typeof params.cursor === 'string' ? params.cursor : null,
      cwd:
        typeof params.cwd === 'string' || Array.isArray(params.cwd)
          ? (params.cwd as string | string[])
          : null,
      includeEphemeral: params.includeEphemeral === true,
      parentThreadId,
      ancestorThreadId,
      sourceKinds,
      sortKey,
      sortDirection,
    })
    const last = threads.at(-1)
    return {
      data: threads.map((thread) => this.toThread(thread, [])),
      nextCursor:
        last && threads.length >= numberOr(params.limit, 50)
          ? String(sortKey === 'created_at' ? last.createdAt : last.updatedAt)
          : null,
      backwardsCursor: threads[0]
        ? String(sortKey === 'created_at' ? threads[0].createdAt : threads[0].updatedAt)
        : null,
    }
  }

  private threadRead(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error('unknown thread: ' + threadId)
    // Codex cc hydrates the Subagent panel with includeTurns:false. A
    // parent-linked child with no renderable turns is treated by that client
    // as still loading, and it does not reliably follow up with turns/list.
    // Keep metadata-only reads for ordinary threads, but return the small
    // child transcript so Prompt/Response and the terminal state can render.
    const includeTurns = params.includeTurns !== false || thread.threadSource === 'subagent'
    const turns = includeTurns ? this.store.listTurns(threadId) : []
    return { thread: this.toThread(thread, turns) }
  }

  private threadTurnsList(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const itemsView = turnItemsView(params.itemsView)
    return {
      data: this.store.listTurns(threadId).map((turn) => this.toTurnView(turn, itemsView)),
      nextCursor: null,
      backwardsCursor: null,
    }
  }

  private threadTurnItemsList(params: Record<string, unknown>): unknown {
    const turnId = stringOr(params.turnId, '')
    const turn = this.store.getTurn(turnId)
    return {
      data: turn?.items ?? [],
      nextCursor: null,
      backwardsCursor: null,
    }
  }

  private threadNameSet(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const name = params.name == null ? null : String(params.name)
    this.store.updateThreadName(threadId, name)
    this.notifyThread(threadId, {
      method: 'thread/name/updated',
      params: { threadId, threadName: name ?? undefined },
    })
    return {}
  }

  private threadArchive(params: Record<string, unknown>, archived: boolean): unknown {
    const threadId = stringOr(params.threadId, '')
    this.store.setArchived(threadId, archived)
    this.notifyThread(threadId, {
      method: archived ? 'thread/archived' : 'thread/unarchived',
      params: { threadId },
    })
    if (!archived) {
      const thread = this.store.getThread(threadId)
      if (!thread) throw new Error(`unknown thread: ${threadId}`)
      return { thread: this.toThread(thread, this.store.listTurns(threadId)) }
    }
    this.clearThreadState(threadId)
    return {}
  }

  // Drops per-thread in-memory state (session-scoped command approvals, token
  // usage tallies, goals, elicitation counts) so an archived thread does not
  // leak entries for the lifetime of the process.
  private clearThreadState(threadId: string): void {
    this.commandSessionAllow.delete(threadId)
    this.tokenUsageByThread.delete(threadId)
    this.goals.delete(threadId)
    this.elicitationCounts.delete(threadId)
  }

  private threadUnsubscribe(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const active = this.activePeerByThread.get(threadId)
    if (!active) return { status: 'notSubscribed' }
    if (active.id !== peer.id) return { status: 'notSubscribed' }
    this.activePeerByThread.delete(threadId)
    this.notify(peer, { method: 'thread/closed', params: { threadId } })
    return { status: 'unsubscribed' }
  }

  private threadLoadedList(params: Record<string, unknown>): unknown {
    const loaded = Array.from(this.activePeerByThread.keys())
    const limit = numberOr(params.limit, loaded.length || 50)
    return {
      data: loaded.slice(0, limit),
      nextCursor: loaded.length > limit ? String(limit) : null,
    }
  }

  // Codex App calls thread/inject_items to push hidden context into a thread's
  // model history — typically file-attachment ingestion, "pin this output as
  // future context", or App-side memory consolidation. Items are raw Responses
  // API entries (free-form JSON). Without an implementation the App's
  // ingestion just disappears, breaking any feature that relies on it.
  //
  // Approach: synthesize an injected turn carrying a single agentMessage that
  // recaps the items as a human-readable block. That turn becomes part of the
  // thread's transcript so the next runRuntimeTurn picks it up as prior
  // conversation context, AND it's visible in thread/read so the user can
  // confirm what was added. We pick agentMessage (instead of a custom type)
  // for App-compatibility — every Codex App build renders it without needing
  // a new ThreadItem variant.
  private threadInjectItems(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    const items = Array.isArray(params.items) ? params.items : []
    if (items.length === 0) return {}

    const now = nowSeconds()
    const turnId = newId()
    const itemId = newId()
    // Compact summary of injected items — try to extract human-readable text
    // (Responses items often have `content` arrays with text segments).
    const summary = items
      .map((raw) => summarizeInjectedItem(raw))
      .filter(Boolean)
      .join('\n\n')
    const text =
      summary.length > 0
        ? summary
        : `[adapter] ${items.length} item(s) injected via thread/inject_items`
    const agentItem: ThreadItem = {
      type: 'agentMessage',
      id: itemId,
      text,
      phase: null,
      memoryCitation: null,
    }
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'completed',
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      items: [agentItem],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    thread.updatedAt = now
    this.store.upsertThread(thread)
    // Defer notifications past the inject_items response. Firing them
    // synchronously enqueues them in front of the response on the wire,
    // which trips clients that do "await response, then read notifications"
    // (they end up draining the notifications while waiting for the
    // response, then loop forever looking for already-discarded events).
    queueMicrotask(() => {
      this.notify(peer, {
        method: 'turn/started',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
      this.notify(peer, {
        method: 'item/completed',
        params: { threadId, turnId, item: agentItem, completedAtMs: nowMillis() },
      })
      this.notify(peer, {
        method: 'turn/completed',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
    })
    debugLog('thread.inject_items', { threadId, count: items.length })
    return {}
  }

  private threadGoalSet(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const existing = this.goals.get(threadId)
    const now = nowSeconds()
    const goal = {
      threadId,
      objective: stringOr(params.objective, String(existing?.objective ?? '')),
      status: typeof params.status === 'string' ? params.status : (existing?.status ?? 'active'),
      tokenBudget:
        typeof params.tokenBudget === 'number'
          ? params.tokenBudget
          : (existing?.tokenBudget ?? null),
      tokensUsed: existing?.tokensUsed ?? 0,
      timeUsedSeconds: existing?.timeUsedSeconds ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.goals.set(threadId, goal)
    this.notifyThread(threadId, { method: 'thread/goal/updated', params: { threadId, goal } })
    return { goal }
  }

  private threadGoalGet(params: Record<string, unknown>): unknown {
    return { goal: this.goals.get(stringOr(params.threadId, '')) ?? null }
  }

  private threadGoalClear(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const cleared = this.goals.delete(threadId)
    if (cleared)
      this.notifyThread(threadId, { method: 'thread/goal/cleared', params: { threadId } })
    return { cleared }
  }

  private threadAdjustElicitation(params: Record<string, unknown>, delta: number): unknown {
    const threadId = stringOr(params.threadId, '')
    const next = Math.max(0, (this.elicitationCounts.get(threadId) ?? 0) + delta)
    this.elicitationCounts.set(threadId, next)
    return { count: next, paused: next > 0 }
  }

  private threadMetadataUpdate(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)

    // Support dynamic model, reasoning effort, approval policy and sandbox updates
    const rawModel = modelFromParams(params, null)
    const model = rawModel ? normalizeSelectableModelId(rawModel, thread.model) : null
    const reasoningEffort = reasoningEffortFromParams(params, null)
    if (model) {
      // This is how the desktop announces a model change on an existing thread
      // (the following `turn/start` carries `model: null`). Moving between
      // Claude and Grok hands the conversation over here (src/rehome.mts).
      this.rehomeLocalThread(thread, model)
      const newBackend = isCodexOpenAiModel(model) ? 'codex' : 'claude'
      thread.runtimeBackend = newBackend
      thread.model = model
    }
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    if (typeof params.approvalPolicy === 'string')
      thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
    if (typeof params.sandbox === 'string')
      thread.sandboxMode = normalizeSandboxMode(params.sandbox)
    if (typeof params.baseInstructions === 'string')
      thread.baseInstructions = nullIfEmpty(params.baseInstructions)
    if (typeof params.developerInstructions === 'string')
      thread.developerInstructions = nullIfEmpty(params.developerInstructions)
    if (typeof params.personality === 'string')
      thread.personality = normalizePersonality(params.personality)

    thread.updatedAt = nowSeconds()
    this.store.upsertThread(thread)

    return this.threadEnvelope(thread, this.store.listTurns(threadId))
  }

  private threadRollback(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    // Honor the protocol's `numTurns: u32, must be >= 1` — drop that many
    // turns from the end of the thread. Without this, App's rewind UI sends
    // the request and we silently return the unchanged thread, leaving the
    // user staring at the timeline they were trying to redo.
    const numTurns =
      typeof params.numTurns === 'number' && params.numTurns >= 1 ? Math.floor(params.numTurns) : 0
    if (numTurns > 0) {
      const dropped = this.store.deleteRecentTurns(threadId, numTurns)
      debugLog('thread.rollback', { threadId, requested: numTurns, dropped })
    }
    return { thread: this.toThread(thread, this.store.listTurns(threadId)) }
  }

  private threadShellCommand(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const command = stringOr(params.command, '')
    if (!command) return {}
    const cwd = this.store.getThread(threadId)?.cwd ?? process.cwd()
    return this.workspace.shellCommand(peer, { threadId, command, cwd })
  }

  private threadBackgroundTerminalsClean(params: Record<string, unknown>): unknown {
    return this.workspace.backgroundTerminalsClean(stringOr(params.threadId, ''))
  }

  private reviewStart(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    this.activePeerByThread.set(threadId, peer)
    const turnId = newId()
    const review = reviewLabel(params.target)
    const prompt = reviewPrompt(params.target)
    const userItem: ThreadItem = {
      type: 'userMessage',
      id: turnId,
      content: [{ type: 'text', text: review, text_elements: [] }],
    }
    const entered: ThreadItem = { type: 'enteredReviewMode', id: newId(), review }
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: [userItem, entered],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    recordRunEvent('turn.started', {
      threadId,
      turnId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      purpose: params.outputSchema == null ? 'normal' : 'summary',
    })
    this.activeTurnByThread.set(threadId, turnId)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    // The review/start RESPONSE carries the synthesized userMessage item (the
    // real app-server's build_review_turn does the same, with itemsView
    // notLoaded); the turn/started NOTIFICATION stays empty like every other
    // lifecycle turn.
    const responseTurn = this.toLifecycleTurn(turn, [userItem])
    setImmediate(() => {
      this.notify(peer, {
        method: 'turn/started',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
      this.notify(peer, {
        method: 'item/started',
        params: { threadId, turnId, item: entered, startedAtMs: nowMillis() },
      })
      void this.runRuntimeTurn(peer, thread, turn, prompt, {
        model: thread.model,
        effort: thread.reasoningEffort,
      }).catch((error) => {
        // A turn that rejects after `stop()` has closed SQLite has nothing left
        // to record or notify; touching the store here throws ERR_INVALID_STATE
        // as an unhandled rejection and takes the process down.
        if (this.stopped) return
        const completed =
          this.store.completeTurn(turnId, 'failed', { message: error.message }) ?? turn
        recordRunEvent('turn.failed', {
          threadId,
          turnId,
          runtimeBackend: thread.runtimeBackend,
          error: { message: error.message },
        })
        this.notify(peer, {
          method: 'error',
          params: { threadId, turnId, willRetry: false, error: { message: error.message } },
        })
        this.notify(peer, {
          method: 'turn/completed',
          params: { threadId, turn: this.toLifecycleTurn(completed) },
        })
        this.clearActiveTurn(threadId)
        this.setThreadStatus(peer, threadId, { type: 'idle' })
      })
    })
    return { turn: responseTurn, reviewThreadId: threadId }
  }

  private threadCompactStart(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    const turnId = newId()
    const compactItem: ThreadItem = { type: 'contextCompaction', id: newId() }
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: [compactItem],
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    recordRunEvent('turn.started', {
      threadId,
      turnId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      purpose: params.outputSchema == null ? 'normal' : 'summary',
    })
    this.activeTurnByThread.set(threadId, turnId)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    setImmediate(() => {
      this.notify(peer, {
        method: 'turn/started',
        params: { threadId, turn: this.toLifecycleTurn(turn) },
      })
      this.notify(peer, {
        method: 'item/started',
        params: { threadId, turnId, item: compactItem, startedAtMs: nowMillis() },
      })
      const agentItem: ThreadItem = {
        type: 'agentMessage',
        id: newId(),
        text: '',
        phase: null,
        memoryCitation: null,
      }
      this.store.appendItem(turnId, agentItem)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId, turnId, item: agentItem, startedAtMs: nowMillis() },
      })

      // Drive an actual Claude (summary model) turn to compact the thread
      // instead of just stringifying the last 12 snippets locally — the
      // local fallback still kicks in if the runtime errors.
      void this.runCompactTurn(peer, thread, turnId, agentItem.id, compactItem)
        .catch((error) => {
          debugLog('thread.compact.fallback', { threadId, error: error?.message ?? String(error) })
          const fallback = compactSummary(thread, this.store.listTurns(threadId))
          this.store.updateItem(turnId, agentItem.id, (item) =>
            item.type === 'agentMessage' ? { ...item, text: fallback } : item,
          )
          this.notify(peer, {
            method: 'item/agentMessage/delta',
            params: { threadId, turnId, itemId: agentItem.id, delta: fallback },
          })
        })
        .finally(() => {
          this.notify(peer, {
            method: 'item/completed',
            params: { threadId, turnId, item: compactItem, completedAtMs: nowMillis() },
          })
          const finalAgent =
            this.store.getTurn(turnId)?.items.find((i) => i.id === agentItem.id) ?? agentItem
          this.notify(peer, {
            method: 'item/completed',
            params: { threadId, turnId, item: finalAgent, completedAtMs: nowMillis() },
          })
          const completed = this.store.completeTurn(turnId, 'completed') ?? turn
          this.clearActiveTurn(threadId)
          this.setThreadStatus(peer, threadId, { type: 'idle' })
          this.notify(peer, {
            method: 'turn/completed',
            params: { threadId, turn: this.toLifecycleTurn(completed) },
          })
          this.notify(peer, { method: 'thread/compacted', params: { threadId } })
        })
    })
    return {}
  }

  // Calls into the runtime with a structured "give me a 1-paragraph summary"
  // prompt against the summary model alias (haiku). Streams the text into the
  // placeholder agent message via item/agentMessage/delta. Errors propagate
  // so the threadCompactStart fallback can substitute the local snippet.
  private async runCompactTurn(
    peer: RpcPeer,
    thread: ThreadRecord,
    turnId: string,
    agentItemId: string,
    compactItem: ThreadItem,
  ): Promise<void> {
    const turns = this.store.listTurns(thread.id)
    const promptBody = compactSummary(thread, turns)
    const compactPrompt = [
      'You are summarizing a Codex / Claude Code conversation so the user can keep context after compaction.',
      'Produce ONE concise paragraph (≤ 6 sentences) covering goals, decisions, files touched, and outstanding work.',
      'Skip greetings; do not invent details that are not in the snippets below.',
      '',
      promptBody,
    ].join('\n')

    let collected = ''
    await this.runtime.runTurn(
      {
        threadId: thread.id,
        turnId,
        purpose: 'compact',
        prompt: compactPrompt,
        cwd: thread.cwd,
        runtimeType: null,
        model: resolveClaudeModel(thread.model, 'summary'),
        effort: resolveClaudeEffort(thread.reasoningEffort ?? null),
        claudeSessionId: null,
        forkSession: false,
        mcpServers: null,
        allowedTools: ['Read', 'Glob', 'Grep'],
        addDirs: [],
        enableFileCheckpointing: false,
        outputFormat: null,
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        systemPromptAddendum: null,
        planMode: false,
        imageInputs: [],
      },
      {
        onEvent: async (event) => {
          if (event.type === 'text_delta' && event.delta) {
            collected += event.delta
            this.store.updateItem(turnId, agentItemId, (item) =>
              item.type === 'agentMessage' ? { ...item, text: item.text + event.delta } : item,
            )
            this.notify(peer, {
              method: 'item/agentMessage/delta',
              params: { threadId: thread.id, turnId, itemId: agentItemId, delta: event.delta },
            })
          }
          if (event.type === 'error') throw new Error(event.message)
          if (event.type === 'completed' && !event.success) {
            throw new Error(event.result ?? 'compaction turn failed')
          }
        },
        // Compaction never asks for approvals — it's read-only summarisation.
        onPermissionRequest: async () => ({ decision: 'accept' }),
        // Compaction shouldn't ever invoke AskUserQuestion; if it does, return
        // an empty answer so the model proceeds with its summary.
        onUserInputRequest: async (event) => ({
          answers: Object.fromEntries(event.questions.map((q) => [q.id, { answers: [] }])),
        }),
      },
    )

    // If Claude produced nothing usable, surface the local fallback so the
    // caller's catch path runs and the user still gets a summary.
    if (!collected.trim()) {
      void compactItem
      throw new Error('compaction returned no content')
    }
  }

  private async turnStart(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const thread = this.store.getThread(threadId)
    if (!thread) throw new Error(`unknown thread: ${threadId}`)
    this.activePeerByThread.set(threadId, peer)

    const turnId = newId()
    const input = Array.isArray(params.input) ? (params.input as UserInput[]) : []
    // extractImageInputs splits user input into the text prompt and any image
    // attachments (localImage / image URL / data:). Sidecar repacks the
    // images into a Claude SDK multimodal user message; here we also append
    // an `imageView` ThreadItem per image so the App's transcript shows them
    // inline next to the user message instead of losing them.
    const { textPrompt, images } = extractImageInputs(input)
    const prompt = textPrompt || textFromInput(input)
    const workflowCommand = parseWorkflowCommand(prompt)
    if (typeof params.cwd === 'string' && params.cwd.length > 0) thread.cwd = params.cwd
    const model = modelFromParams(params, thread.model)
    const reasoningEffort = reasoningEffortFromParams(params, thread.reasoningEffort)
    const permissionProfileId = permissionProfileIdFromParams(params)
    const permissionProfile = permissionProfilePolicy(permissionProfileId)
    // Routing is per turn, not per thread: a model from another engine hands
    // the thread over before the turn runs (src/rehome.mts).
    if (model && params.outputSchema == null) this.rehomeLocalThread(thread, model)
    if (model) thread.model = model
    if (reasoningEffort) thread.reasoningEffort = reasoningEffort
    if (permissionProfileId) {
      thread.permissionProfileId = permissionProfileId
      if (permissionProfile?.approvalPolicy)
        thread.approvalPolicy = permissionProfile.approvalPolicy
      if (permissionProfile?.sandboxMode) thread.sandboxMode = permissionProfile.sandboxMode
    } else {
      if (hasLegacyPermissionParams(params)) thread.permissionProfileId = null
      if (typeof params.approvalPolicy === 'string')
        thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
      const requestedSandbox = sandboxFromTurnParams(params)
      if (requestedSandbox) thread.sandboxMode = requestedSandbox
    }
    this.store.upsertThread(thread)
    if (!thread.preview && prompt) {
      thread.preview = prompt.slice(0, 200)
      thread.updatedAt = nowSeconds()
      this.store.upsertThread(thread)
    }
    // What actually reaches the engine: the user's text, prefixed once with a
    // transcript when this is the first turn after an engine switch. The
    // stored `userMessage` item keeps the user's own input, so the App's
    // transcript is unchanged.
    const runtimePrompt = this.applyRehomePrefix(thread, prompt, params.outputSchema != null)
    const initialItems: ThreadItem[] = [{ type: 'userMessage', id: newId(), content: input }]
    const imageItems: ThreadItem[] = []
    for (const img of images) {
      // Codex v2 imageView.path is AbsolutePathBuf — Rust's custom Deserialize
      // rejects anything that isn't an absolute filesystem path (URLs, data:
      // URIs, relative paths). For non-local images we'd otherwise crash the
      // App on persist/reload. Only emit imageView for kind:'base64' inputs
      // that came from a real local file path (the displayPath in that case
      // is the original absolute path captured by extractImageInputs).
      if (img.kind === 'base64' && img.displayPath.startsWith('/')) {
        imageItems.push({ type: 'imageView', id: newId(), path: img.displayPath })
      }
    }
    // imageView items are retained on the turn for history (thread/read) and, in
    // contrast to the userMessage, surfaced live through the item/* event stream
    // so the App's transcript shows the uploaded image inline during the turn.
    initialItems.push(...imageItems)
    // Note: we used to short-circuit Codex App's title-generation turn with a
    // local regex-derived title to avoid prompt leakage into the parent thread.
    // That leakage no longer happens (title turns run on their own ephemeral
    // thread, filtered from listings), so the short-circuit was just forcing a
    // hardcoded "处理X" string instead of the real model output. Now every turn
    // — including the structured title turn on Claude Haiku — runs end-to-end.
    const turn: TurnRecord = {
      id: turnId,
      threadId,
      status: 'inProgress',
      startedAt: nowSeconds(),
      completedAt: null,
      durationMs: null,
      items: initialItems,
      diff: '',
      error: null,
    }
    this.store.upsertTurn(turn)
    recordRunEvent('turn.started', {
      threadId,
      turnId,
      cwd: thread.cwd,
      model: thread.model,
      runtimeBackend: thread.runtimeBackend,
      purpose: params.outputSchema == null ? 'normal' : 'summary',
    })
    this.activeTurnByThread.set(threadId, turnId)
    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    const publicTurn = this.toLifecycleTurn(turn)

    setImmediate(() => {
      this.notify(peer, { method: 'turn/started', params: { threadId, turn: publicTurn } })
      for (const item of imageItems) {
        this.notify(peer, {
          method: 'item/started',
          params: { threadId, turnId, item, startedAtMs: nowMillis() },
        })
        this.notify(peer, {
          method: 'item/completed',
          params: { threadId, turnId, item, completedAtMs: nowMillis() },
        })
      }
      if (params.outputSchema == null && workflowCommand?.type === 'list') {
        this.completeWorkflowListTurn(peer, thread, turn)
        return
      }
      // Carry parsed images through the params bag so runRuntimeTurn can hand
      // them to the runtime context without re-parsing user input.
      void this.runRuntimeTurn(peer, thread, turn, runtimePrompt, {
        ...params,
        _imageInputs: images,
      }).catch((error) => {
        // See the review-turn twin above: after `stop()` the store is closed and
        // this handler would crash the process with an unhandled rejection.
        if (this.stopped) return
        const current = this.store.getTurn(turnId)
        if (current && current.status !== 'inProgress') return
        const completed =
          this.store.completeTurn(turnId, 'failed', { message: error.message }) ?? turn
        this.notify(peer, {
          method: 'error',
          params: { threadId, turnId, willRetry: false, error: { message: error.message } },
        })
        this.notify(peer, {
          method: 'turn/completed',
          params: { threadId, turn: this.toLifecycleTurn(completed) },
        })
        this.clearActiveTurn(threadId)
        this.setThreadStatus(peer, threadId, { type: 'idle' })
      })
    })
    return { turn: publicTurn }
  }

  private completeWorkflowListTurn(peer: RpcPeer, thread: ThreadRecord, turn: TurnRecord): void {
    const itemId = newId()
    const emptyItem: ThreadItem = {
      type: 'agentMessage',
      id: itemId,
      text: '',
      phase: null,
      memoryCitation: null,
    }
    this.store.appendItem(turn.id, emptyItem)
    this.notify(peer, {
      method: 'item/started',
      params: { threadId: thread.id, turnId: turn.id, item: emptyItem, startedAtMs: nowMillis() },
    })

    const text = this.workflowListText(thread.id, turn.id)
    const completedItem: ThreadItem = { ...emptyItem, text }
    this.store.updateItem(turn.id, itemId, () => completedItem)
    this.notify(peer, {
      method: 'item/agentMessage/delta',
      params: { threadId: thread.id, turnId: turn.id, itemId, delta: text },
    })
    this.notify(peer, {
      method: 'item/completed',
      params: {
        threadId: thread.id,
        turnId: turn.id,
        item: completedItem,
        completedAtMs: nowMillis(),
      },
    })

    const completed = this.store.completeTurn(turn.id, 'completed') ?? turn
    recordRunEvent('turn.completed', {
      threadId: thread.id,
      turnId: turn.id,
      runtimeBackend: thread.runtimeBackend,
      durationMs: completed.durationMs,
      command: 'workflows.list',
    })
    this.clearActiveTurn(thread.id)
    this.setThreadStatus(peer, thread.id, { type: 'idle' })
    this.notify(peer, {
      method: 'turn/completed',
      params: { threadId: thread.id, turn: this.toLifecycleTurn(completed) },
    })
  }

  private workflowListText(threadId: string, currentTurnId: string): string {
    const runs = this.store
      .listTurns(threadId)
      .filter((turn) => turn.id !== currentTurnId)
      .map((turn) => {
        const userItem = turn.items.find((item) => item.type === 'userMessage')
        const prompt = userItem?.type === 'userMessage' ? textFromInput(userItem.content) : ''
        const command = parseWorkflowCommand(prompt)
        if (command?.type !== 'run') return null
        const childIds = new Set<string>()
        for (const item of turn.items) {
          if (item.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent') continue
          for (const childId of item.receiverThreadIds) childIds.add(childId)
        }
        const agents = Array.from(childIds).map((childId) => {
          const child = this.store.getThread(childId)
          const latestTurn = this.store.listTurns(childId).at(-1)
          return {
            nickname: child?.agentNickname ?? childId.slice(0, 12),
            role: child?.agentRole ?? 'subagent',
            status: latestTurn?.status ?? child?.status.type ?? 'unknown',
          }
        })
        return { turn, prompt: command.prompt, agents }
      })
      .filter((run): run is NonNullable<typeof run> => run !== null)
      .reverse()
      .slice(0, 20)

    if (runs.length === 0) {
      return [
        'No workflow runs in this task.',
        '',
        'Start one with `/workflows <task>`. The adapter runs it through Claude ultracode and exposes its agents as reviewable Codex subagent tasks.',
      ].join('\n')
    }

    const lines = ['Workflow runs in this task:']
    for (const run of runs) {
      const task = run.prompt.replace(/\s+/g, ' ').slice(0, 120)
      lines.push(
        `- ${run.turn.id.slice(0, 12)} · ${run.turn.status} · ${run.agents.length} agent(s) · ${task}`,
      )
      if (run.agents.length > 0) {
        lines.push(
          `  Agents: ${run.agents
            .map((agent) => `${agent.nickname} (${agent.role}, ${agent.status})`)
            .join(', ')}`,
        )
      }
    }
    lines.push('', 'Open the Agent items in the workflow turn to review each child task.')
    return lines.join('\n')
  }

  private async runRuntimeTurn(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    prompt: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const itemIds = new Map<string, string>()
    let agentItemId: string | null = null
    let reasoningItemId: string | null = null
    const commandOutputSeen = new Set<string>()
    // MultiAgent V2 uses subAgentActivity for display/liveness and the
    // spawnAgent/wait tool calls for the structured timeline. A naturally
    // completed child is not closed again: wait/completed must remain the last
    // parent state so Codex App retains the terminal snapshot.
    const subagentContexts = new Map<string, SubagentContext>()
    const activeSubagents = new Set<string>()
    // A Workflow launch can be pending before it has produced a journal
    // agent (or after its last projected agent has completed). Keep the
    // watchdog armed for that whole async operation, not only while a child
    // tool_use is present.
    let workflowInFlight = false
    const workflowLaunchToolUseIds = new Set<string>()
    // Track per-item start time so commandExecution / mcpToolCall items can
    // report a real durationMs in turn/completed (otherwise the App's status
    // bar shows "—" for every command).
    const itemStartedAtMs = new Map<string, number>()
    // Mutable holder rather than `let collectedMetrics`: TS's control-flow
    // analysis doesn't see writes from inside the onEvent callback, so a bare
    // `let` would still be inferred as `null` outside the closure.
    const collectedMetrics: {
      apiDurationMs: number | null
      numTurns: number | null
      costUsd: number | null
      set: boolean
    } = {
      apiDurationMs: null,
      numTurns: null,
      costUsd: null,
      set: false,
    }
    const forkSession =
      thread.forkedFromId != null &&
      thread.claudeSessionId != null &&
      this.store.listTurns(thread.id).length <= 1
    // Plan mode: Claude SDK runs with permissionMode='plan' — it produces
    // planning text but does not execute tools. We surface the planning
    // output as Codex's native `plan` ThreadItem (instead of agentMessage)
    // and stream deltas via item/plan/delta + turn/plan/updated so the
    // App's Plan-mode UI lights up properly. Detection:
    //   * turn/start.planMode === true (App's explicit request)
    //   * thread.approvalPolicy / sandbox flags don't suppress it
    // The current planMode flag for this turn was computed above as
    // `params.planMode === true`; reproduce here so the helpers can check it.
    const planMode = params.planMode === true
    let planItemId: string | null = null
    const ensurePlanItem = (): string => {
      if (planItemId) return planItemId
      planItemId = newId()
      const item: ThreadItem = { type: 'plan', id: planItemId, text: '' }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
      return planItemId
    }
    const ensureAgentItem = (): string => {
      if (agentItemId) return agentItemId
      agentItemId = newId()
      const item: ThreadItem = {
        type: 'agentMessage',
        id: agentItemId,
        text: '',
        phase: null,
        memoryCitation: null,
      }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
      return agentItemId
    }
    const ensureReasoningItem = (): string => {
      if (reasoningItemId) return reasoningItemId
      reasoningItemId = newId()
      const item: ThreadItem = {
        type: 'reasoning',
        id: reasoningItemId,
        summary: [''],
        content: [''],
      }
      this.store.appendItem(turn.id, item)
      this.notify(peer, {
        method: 'item/started',
        params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
      })
      return reasoningItemId
    }

    // Allow per-turn override of policy (Codex App may attach updated values
    // when the user toggles Full access mid-conversation), then fall back to
    // the thread-level setting captured at start/resume. turn/start ships a
    // sandboxPolicy struct (e.g. {type:"dangerFullAccess"}); thread/start uses
    // the simpler sandbox string. Both are honoured.
    const permissionProfile = permissionProfilePolicy(permissionProfileIdFromParams(params))
    const approvalPolicy =
      permissionProfile?.approvalPolicy ??
      (typeof params.approvalPolicy === 'string'
        ? normalizeApprovalPolicy(params.approvalPolicy)
        : null) ??
      thread.approvalPolicy
    const sandboxMode =
      permissionProfile?.sandboxMode ?? sandboxFromTurnParams(params) ?? thread.sandboxMode
    // Per-turn instruction overrides: Codex App may resend its instruction
    // panel state when the user toggles personality mid-thread. Falls back to
    // whatever was captured at thread/start.
    const baseInstructions =
      (typeof params.baseInstructions === 'string' ? params.baseInstructions : null) ??
      thread.baseInstructions
    const developerInstructions =
      (typeof params.developerInstructions === 'string' ? params.developerInstructions : null) ??
      thread.developerInstructions
    const personality =
      (typeof params.personality === 'string' ? normalizePersonality(params.personality) : null) ??
      thread.personality
    // If this is a forked side-conversation (sidechat) that has different
    // developerInstructions from its parent, appending them to systemPromptAddendum
    // would mutate the system prompt prefix and invalidate the prefix KV cache
    // for all inherited history (80k+ tokens).
    // Instead, preserve the parent's system prompt addendum to guarantee 100% cache hits,
    // and prepend side-conversation instructions directly into the turn's user prompt.
    let systemPromptAddendum: string | null = null
    let effectivePrompt = prompt
    if (thread.forkedFromId != null && developerInstructions) {
      const parentThread = this.store.getThread(thread.forkedFromId)
      const parentDev = parentThread?.developerInstructions ?? null
      if (developerInstructions !== parentDev) {
        systemPromptAddendum = buildSystemPromptAddendum({
          baseInstructions: parentThread?.baseInstructions ?? baseInstructions,
          developerInstructions: parentDev,
          personality: parentThread?.personality ?? personality,
        })
        effectivePrompt = `<side-conversation-instructions>\n${developerInstructions}\n</side-conversation-instructions>\n\n${prompt}`
      } else {
        systemPromptAddendum = buildSystemPromptAddendum({
          baseInstructions,
          developerInstructions,
          personality,
        })
      }
    } else {
      systemPromptAddendum = buildSystemPromptAddendum({
        baseInstructions,
        developerInstructions,
        personality,
      })
    }
    const turnPurpose = params.outputSchema == null ? 'normal' : 'summary'
    // Standing cross-engine instructions (docs/guide/bridge.md): Claude gets
    // them via --append-system-prompt, Grok as the first-prompt prefix.
    const bridgeCatalog = turnPurpose === 'summary' ? null : this.bridgeCatalogForInstructions()
    if (bridgeCatalog)
      systemPromptAddendum = appendBridgeInstructions(systemPromptAddendum, bridgeCatalog)

    const rawTurnModel = stringOr(params.model, thread.model)
    const isCodexThread = thread.runtimeBackend === 'codex' && process.env.ANYENGINE_MOCK !== '1'
    const resolvedModel = isCodexThread
      ? rawTurnModel
      : resolveClaudeModel(rawTurnModel, params.outputSchema == null ? 'normal' : 'summary')
    const resolvedEffort = resolveClaudeEffort(
      typeof params.effort === 'string'
        ? params.effort
        : (thread.reasoningEffort ?? process.env.ANYENGINE_EFFORT ?? null),
    )
    // Log the effective Claude SDK model+effort per turn so when a user
    // reports "switching model didn't work" we can diff App's payload against
    // what actually reached the SDK in one grep.
    debugLog('turn.runtime.applied', {
      threadId: thread.id,
      turnId: turn.id,
      paramsModel: params.model ?? null,
      paramsEffort: params.effort ?? null,
      threadModel: thread.model,
      threadEffort: thread.reasoningEffort,
      envDefaultModel: process.env.ANYENGINE_DEFAULT_MODEL ?? null,
      envDefaultEffort:
        process.env.ANYENGINE_DEFAULT_EFFORT ?? process.env.ANYENGINE_EFFORT ?? null,
      resolvedModel,
      resolvedEffort,
    })
    // For codex-backed threads, force the per-turn runtimeType to 'codex-proxy'
    // so the SelectableRuntime dispatches to CodexProxyRuntime instead of
    // the default Claude SDK runtime. Also route the codex session id (stored
    // separately from Claude's) through the existing claudeSessionId slot —
    // CodexProxyRuntime consumes it as the resume id. In mock mode the
    // mock runtime handles everything regardless of model id — bypass the
    // codex-proxy override so unit tests stay deterministic.
    this.subagentStateByTurn.set(turn.id, {
      thread,
      turn,
      contexts: subagentContexts,
      active: activeSubagents,
    })
    let acceptRuntimeEvents = true
    let watchdogTimer: NodeJS.Timeout | null = null
    let resolveWatchdog: (() => void) | null = null
    const watchdogTimeoutMs = subagentWatchdogTimeoutMs()
    const watchdogPromise =
      watchdogTimeoutMs > 0
        ? new Promise<void>((resolve) => {
            resolveWatchdog = resolve
          })
        : null
    const disarmWatchdog = (): void => {
      if (watchdogTimer) clearTimeout(watchdogTimer)
      watchdogTimer = null
    }
    const armWatchdog = (): void => {
      if (
        !watchdogPromise ||
        watchdogTimer ||
        !acceptRuntimeEvents ||
        (activeSubagents.size === 0 && !workflowInFlight)
      )
        return
      watchdogTimer = setTimeout(() => {
        watchdogTimer = null
        // Flip this before resolving the race so an already-buffered SDK event
        // cannot create a fresh child after the watchdog has decided to fail.
        acceptRuntimeEvents = false
        resolveWatchdog?.()
      }, watchdogTimeoutMs)
      watchdogTimer.unref()
    }
    const turnIsActive = (): boolean =>
      acceptRuntimeEvents &&
      this.store.getTurn(turn.id)?.status === 'inProgress' &&
      this.activeTurnByThread.get(thread.id) === turn.id
    const runtimeTurn = this.runtime.runTurn(
      {
        threadId: thread.id,
        turnId: turn.id,
        purpose: turnPurpose,
        prompt: effectivePrompt,
        cwd: stringOr(params.cwd, thread.cwd),
        runtimeType: isCodexThread ? 'codex-proxy' : grokRuntimeTypeFor(resolvedModel),
        model: resolvedModel,
        effort: resolvedEffort,
        claudeSessionId: isCodexThread ? thread.codexSessionId : thread.claudeSessionId,
        forkSession,
        // Every engine also gets the cross-engine bridge server for this
        // thread (docs/guide/bridge.md); summary turns never spawn engines.
        // Plus the stdio servers contributed by the user's enabled Codex
        // plugins, so a plugin installed once reaches every engine
        // (ANYENGINE_CODEX_PLUGIN_MCP=0 turns that off).
        mcpServers: withCodexPluginMcpServers(
          this.bridge && turnPurpose !== 'summary'
            ? this.bridge.mergeMcpServers(thread.id, readMcpConfig().sdkValue)
            : readMcpConfig().sdkValue,
        ),
        allowedTools: defaultAllowedTools(),
        addDirs: stringListFromEnv('ANYENGINE_ADD_DIRS', []),
        enableFileCheckpointing: process.env.ANYENGINE_ENABLE_FILE_CHECKPOINTING === '1',
        outputFormat: claudeOutputFormat(params.outputSchema),
        approvalPolicy,
        sandboxMode,
        systemPromptAddendum,
        planMode: params.planMode === true,
        imageInputs: Array.isArray(params._imageInputs)
          ? (params._imageInputs as ImageInput[])
          : [],
      },
      {
        onEvent: async (event) => {
          // Interrupts, watchdog expiry, and a peer reconnect can leave a few
          // SDK messages queued after the server has terminalized the turn.
          // They are stale and must never resurrect a child or an inProgress
          // item in the Codex App.
          if (!turnIsActive()) return
          if (event.type === 'session') {
            this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
            return
          }
          if (activeSubagents.size > 0) {
            if (event.type === 'text_delta' || event.type === 'reasoning_delta') return
            if (event.type === 'tool_use' && !isSubagentToolName(event.toolName)) return
            if (event.type === 'tool_output_delta' && !itemIds.has(event.toolUseId)) return
            if (
              event.type === 'tool_result' &&
              !activeSubagents.has(event.toolUseId) &&
              !itemIds.has(event.toolUseId)
            )
              return
          }
          if (event.type === 'tool_use' && isSubagentToolName(event.toolName)) {
            // Spawn the ephemeral child, then mirror MultiAgent V2: a
            // subAgentActivity started item plus spawnAgent/wait tool state.
            //
            // Concept alignment: Claude's `subagent_type` (e.g. "general-
            // purpose") is the same idea as Codex's `agentRole`; we also
            // generate an `agentNickname` matching the `agent-{12hex}` shape
            // Claude itself uses internally so the App's subagent UI shows a
            // distinct, repeatable handle. The collabAgentToolCall.model
            // field carries the actual SDK model the subagent runs on, NOT
            // the subagent_type — that distinction was wrong before.
            const promptText = String(event.input.prompt ?? event.input.description ?? '')
            const subType =
              typeof event.input.subagent_type === 'string' ? event.input.subagent_type : null
            const subagentModel =
              typeof event.input.model === 'string' ? event.input.model : thread.model
            const childThreadId = newId()
            const agentNickname = `agent-${childThreadId.replace(/-/g, '').slice(0, 12)}`
            const agentPath = `/root/${agentNickname}`
            const agentRole = subType ?? 'general-purpose'
            const childStartedAt = nowSeconds()
            const childThread: ThreadRecord = {
              id: childThreadId,
              sessionId: thread.sessionId,
              forkedFromId: thread.id,
              preview: promptText.slice(0, 200),
              name: null,
              archived: false,
              cwd: thread.cwd,
              model: subagentModel,
              reasoningEffort: thread.reasoningEffort,
              modelProvider: thread.modelProvider,
              claudeSessionId: null,
              source: normalizeSessionSource(thread.source),
              createdAt: childStartedAt,
              updatedAt: childStartedAt,
              status: { type: 'active', activeFlags: [] },
              approvalPolicy: thread.approvalPolicy,
              sandboxMode: thread.sandboxMode,
              ephemeral: true,
              threadSource: 'subagent',
              agentRole,
              agentNickname,
              // Subagent inherits parent's instruction surface so the same
              // project/developer guidance applies to the child run.
              baseInstructions: thread.baseInstructions,
              developerInstructions: thread.developerInstructions,
              personality: thread.personality,
              // Subagents always run via Claude — the Task tool is a Claude SDK
              // construct. A codex-backed thread that spawns a subagent would
              // never reach this code path (subagent detection is Claude-side).
              runtimeBackend: 'claude',
              codexSessionId: null,
            }
            this.store.upsertThread(childThread)
            // Child notifications must follow the current parent peer. This
            // matters after unix-daemon reconnects, when the old peer is gone
            // before the child publishes its response.
            this.activePeerByThread.set(childThreadId, peer)
            const childTurn: TurnRecord = {
              id: newId(),
              threadId: childThreadId,
              status: 'inProgress',
              startedAt: childStartedAt,
              completedAt: null,
              durationMs: null,
              items: [
                {
                  type: 'userMessage',
                  id: newId(),
                  content: [{ type: 'text', text: promptText, text_elements: [] }],
                },
              ],
              diff: '',
              error: null,
            }
            this.store.upsertTurn(childTurn)
            this.notify(peer, {
              method: 'thread/started',
              params: { thread: this.toThread(childThread, []) },
            })
            this.notify(peer, {
              method: 'turn/started',
              params: {
                threadId: childThreadId,
                turn: this.toLifecycleTurn(childTurn),
              },
            })
            // The bundled Codex cc client creates a child conversation from
            // thread/started with an empty turn and treats the history as
            // loaded while the child is live. Replay the persisted prompt as
            // a normal item lifecycle so the child page has its Prompt even
            // when it is opened before the first response token arrives.
            const childPrompt = childTurn.items.find((item) => item.type === 'userMessage')
            if (childPrompt) this.emitItemLifecycle(peer, childThreadId, childTurn.id, childPrompt)
            recordRunEvent('subagent.spawned', {
              parentThreadId: thread.id,
              parentTurnId: turn.id,
              childThreadId,
              model: subagentModel,
              agentRole,
              agentNickname,
            })

            // Stage 1 — spawnAgent (begin + end emitted together; the agent is
            // already created so there's no real latency here).
            const spawnId = newId()
            // Codex v2 collabAgentToolCall.reasoningEffort is `ReasoningEffort | null`
            // (strict enum: none|minimal|low|medium|high|xhigh). Same Oops trap as
            // threadSource — an empty string from a sloppy resume crashes the App.
            // Normalize here once and reuse for every stage of the lifecycle.
            const collabEffort = normalizeReasoningEffortEnum(thread.reasoningEffort)
            const spawnBegin: ThreadItem = {
              type: 'collabAgentToolCall',
              id: spawnId,
              tool: 'spawnAgent',
              status: 'inProgress',
              senderThreadId: thread.id,
              receiverThreadIds: [],
              prompt: promptText || null,
              model: subagentModel,
              reasoningEffort: collabEffort,
              agentsStates: {},
            }
            this.store.appendItem(turn.id, spawnBegin)
            this.notify(peer, {
              method: 'item/started',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: spawnBegin,
                startedAtMs: nowMillis(),
              },
            })
            const spawnEnd: ThreadItem = {
              type: 'collabAgentToolCall',
              id: spawnId,
              tool: 'spawnAgent',
              status: 'completed',
              senderThreadId: thread.id,
              receiverThreadIds: [childThreadId],
              prompt: promptText || null,
              model: subagentModel,
              reasoningEffort: collabEffort,
              agentsStates: { [childThreadId]: { status: 'running', message: null } },
            }
            this.store.updateItem(turn.id, spawnId, () => spawnEnd)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: spawnEnd,
                completedAtMs: nowMillis(),
              },
            })
            const waitId = newId()
            const subagentContext: SubagentContext = {
              childThreadId,
              childTurnId: childTurn.id,
              waitItemId: waitId,
              agentPath,
              prompt: promptText,
              subType,
            }
            this.emitSubagentActivity(peer, thread.id, turn.id, subagentContext, 'started')

            // Wait begins after the activity item; this is the long phase that
            // gives Codex App its "agent is working" indicator while the
            // subagent runs. It closes when the Task tool_result arrives.
            const waitBegin: ThreadItem = {
              type: 'collabAgentToolCall',
              id: waitId,
              tool: 'wait',
              status: 'inProgress',
              senderThreadId: thread.id,
              receiverThreadIds: [childThreadId],
              prompt: null,
              model: null,
              reasoningEffort: null,
              agentsStates: {},
            }
            this.store.appendItem(turn.id, waitBegin)
            this.notify(peer, {
              method: 'item/started',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: waitBegin,
                startedAtMs: nowMillis(),
              },
            })

            itemIds.set(event.toolUseId, waitId)
            subagentContexts.set(event.toolUseId, subagentContext)
            activeSubagents.add(event.toolUseId)
            armWatchdog()
            return
          }
          if (event.type === 'tool_result' && activeSubagents.has(event.toolUseId)) {
            const ctx = subagentContexts.get(event.toolUseId)
            if (!ctx) return
            const rawResultText = toolResultText(event.content)
            const collabStatus: 'completed' | 'failed' = event.isError ? 'failed' : 'completed'
            const agentStatus: 'completed' | 'errored' = event.isError ? 'errored' : 'completed'

            // claude-agent-sdk's Task tool appends a metadata trailer to the
            // result content: an `agentId: <hex>` line + a `<usage>...</usage>`
            // block. Codex App doesn't render those — they just leak as raw
            // text. Strip them from the visible body and route the metadata
            // into the proper protocol fields (agentNickname / tokenUsage /
            // metrics) so the subagent timeline carries the same identity +
            // usage the SDK reports.
            const parsed = parseSubagentTrailer(rawResultText)
            const resultText = parsed.cleanText

            const childTurn = this.completeSubagentChildTurn(
              peer,
              ctx,
              resultText,
              event.isError ? 'failed' : 'completed',
              event.isError ? { message: 'subagent failed' } : null,
              parsed.usage?.durationMs ?? null,
            )
            recordRunEvent('subagent.completed', {
              parentThreadId: thread.id,
              parentTurnId: turn.id,
              childThreadId: ctx.childThreadId,
              childTurnId: childTurn.id,
              status: childTurn.status,
              agentRole: ctx.subType ?? 'general-purpose',
            })
            const childThread = this.store.getThread(ctx.childThreadId)
            if (childThread) {
              childThread.updatedAt = nowSeconds()
              // Replace our synthetic `agent-{hex}` nickname with the SDK-
              // assigned id so SendMessage / SubAgent navigation in the App
              // uses the same handle the SDK reports.
              if (parsed.agentId) childThread.agentNickname = parsed.agentId
              this.store.upsertThread(childThread)
            }

            // The child completion activity arrives before wait/completed in
            // native V2. The installed Codex cc schema predates the
            // `completed` activity kind, so only send it when the client
            // explicitly advertises support; the wait terminal snapshot is
            // sufficient for legacy reducers.
            if (event.isError || this.supportsCompletedSubagentActivity(peer)) {
              this.emitSubagentActivity(
                peer,
                thread.id,
                turn.id,
                ctx,
                event.isError ? 'interrupted' : 'completed',
              )
            }

            // Push the subagent's token usage as a Codex-native
            // thread/tokenUsage/updated notification on the CHILD thread
            // (App's status bar reads from this) and roll the totals into
            // the parent thread so subagent costs aren't invisible.
            if (parsed.usage && parsed.usage.totalTokens) {
              const breakdown: TokenUsageBreakdown = {
                totalTokens: parsed.usage.totalTokens,
                inputTokens: 0,
                cachedInputTokens: 0,
                outputTokens: parsed.usage.totalTokens,
                reasoningOutputTokens: 0,
              }
              const childUsage: ThreadTokenUsage = {
                total: breakdown,
                last: breakdown,
                modelContextWindow: null,
              }
              this.notify(peer, {
                method: 'thread/tokenUsage/updated',
                params: {
                  threadId: ctx.childThreadId,
                  turnId: childTurn.id,
                  tokenUsage: childUsage,
                },
              })
              this.recordTokenUsage(peer, thread.id, turn.id, {
                input_tokens: 0,
                output_tokens: parsed.usage.totalTokens,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              })
            }

            // Stage 2 close — wait (end). Re-emits the same waitItemId.
            const waitEnd: ThreadItem = {
              type: 'collabAgentToolCall',
              id: ctx.waitItemId,
              tool: 'wait',
              status: collabStatus,
              senderThreadId: thread.id,
              receiverThreadIds: [ctx.childThreadId],
              prompt: null,
              model: null,
              reasoningEffort: null,
              agentsStates: { [ctx.childThreadId]: { status: agentStatus, message: null } },
            }
            this.store.updateItemAndMoveToEnd(turn.id, ctx.waitItemId, () => waitEnd)
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: waitEnd,
                completedAtMs: nowMillis(),
              },
            })

            // Codex cc 26.x does not advertise the terminal
            // subAgentActivity kind. For a successful child, wait/completed
            // is already the terminal display state; appending closeAgent
            // makes the bundled client hide the finished child. Keep the
            // legacy closeAgent cleanup only for failed results.
            if (!this.supportsCompletedSubagentActivity(peer) && event.isError) {
              const closeId = newId()
              const closeBegin: ThreadItem = {
                type: 'collabAgentToolCall',
                id: closeId,
                tool: 'closeAgent',
                status: 'inProgress',
                senderThreadId: thread.id,
                receiverThreadIds: [ctx.childThreadId],
                prompt: null,
                model: null,
                reasoningEffort: null,
                agentsStates: {},
              }
              this.store.appendItem(turn.id, closeBegin)
              this.notify(peer, {
                method: 'item/started',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  item: closeBegin,
                  startedAtMs: nowMillis(),
                },
              })
              const closeEnd: ThreadItem = {
                ...closeBegin,
                status: collabStatus,
                agentsStates: { [ctx.childThreadId]: { status: agentStatus, message: null } },
              }
              this.store.updateItem(turn.id, closeId, () => closeEnd)
              this.notify(peer, {
                method: 'item/completed',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  item: closeEnd,
                  completedAtMs: nowMillis(),
                },
              })
            }
            // Keep the context discoverable until the child turn and wait
            // item have both been persisted. If one of those operations throws,
            // the outer settlement path can still finalize the child as failed.
            activeSubagents.delete(event.toolUseId)
            subagentContexts.delete(event.toolUseId)
            if (activeSubagents.size === 0 && !workflowInFlight) disarmWatchdog()
            return
          }
          if (event.type === 'text_delta') {
            // In plan mode, text is the plan body — route to a Plan item +
            // item/plan/delta + (later) turn/plan/updated so the App's
            // Plan-mode UI lights up natively. Outside plan mode it's a
            // normal agentMessage delta.
            if (planMode) {
              const itemId = ensurePlanItem()
              this.store.updateItem(turn.id, itemId, (item) => {
                if (item.type === 'plan') return { ...item, text: item.text + event.delta }
                return item
              })
              this.notify(peer, {
                method: 'item/plan/delta',
                params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.delta },
              })
              return
            }
            const itemId = ensureAgentItem()
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'agentMessage') return { ...item, text: item.text + event.delta }
              return item
            })
            this.notify(peer, {
              method: 'item/agentMessage/delta',
              params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.delta },
            })
            return
          }
          if (event.type === 'reasoning_delta') {
            if (event.delta.length === 0) return
            const itemId = ensureReasoningItem()
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'reasoning') {
                return {
                  ...item,
                  summary: [(item.summary[0] ?? '') + event.delta],
                  content: [(item.content[0] ?? '') + event.delta],
                }
              }
              return item
            })
            this.notify(peer, {
              method: 'item/reasoning/summaryTextDelta',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                itemId,
                delta: event.delta,
                summaryIndex: 0,
              },
            })
            this.notify(peer, {
              method: 'item/reasoning/textDelta',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                itemId,
                delta: event.delta,
                contentIndex: 0,
              },
            })
            return
          }
          if (event.type === 'tool_use') {
            if (isWorkflowToolName(event.toolName)) {
              workflowLaunchToolUseIds.add(event.toolUseId)
              workflowInFlight = true
              armWatchdog()
            }
            // Defense in depth against duplicate tool_use events for the same
            // tool_use_id. Claude SDK has been known to emit a block_start
            // event with an empty input AND a complete copy in the final
            // AssistantMessage — sidecar suppresses the empty start, but if
            // anything slips through we'd otherwise create a husk
            // commandExecution item that never closes (the second emit
            // overwrites itemIds[] so the husk never sees its tool_result).
            if (itemIds.has(event.toolUseId)) return
            // Claude's TodoWrite is the equivalent of Codex's `update_plan`
            // todo/checklist tool, which the real app-server maps to a
            // turn/plan/updated notification (structured steps) rather than a
            // timeline item. Mirror that: emit the structured plan and suppress
            // the generic tool item so the App's plan/checklist UI drives off
            // the spec'd notification.
            if (event.toolName === 'TodoWrite') {
              const plan = todoWriteToPlanSteps(event.input)
              if (plan) {
                this.notify(peer, {
                  method: 'turn/plan/updated',
                  params: { threadId: thread.id, turnId: turn.id, explanation: null, plan },
                })
              }
              itemIds.set(event.toolUseId, '')
              return
            }
            const item = this.toolUseToItem(event, thread.cwd)
            itemIds.set(event.toolUseId, item.id)
            itemStartedAtMs.set(item.id, nowMillis())
            this.store.appendItem(turn.id, item)
            this.notify(peer, {
              method: 'item/started',
              params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
            })
            if (item.type === 'fileChange') {
              this.notify(peer, {
                method: 'item/fileChange/patchUpdated',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  itemId: item.id,
                  changes: item.changes,
                },
              })
            }
            return
          }
          if (event.type === 'tool_output_delta') {
            const itemId = itemIds.get(event.toolUseId)
            if (!itemId) return
            commandOutputSeen.add(itemId)
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'commandExecution') {
                return { ...item, aggregatedOutput: `${item.aggregatedOutput ?? ''}${event.delta}` }
              }
              return item
            })
            this.notify(peer, {
              method: 'item/commandExecution/outputDelta',
              params: { threadId: thread.id, turnId: turn.id, itemId, delta: event.delta },
            })
            return
          }
          if (event.type === 'tool_result') {
            if (workflowLaunchToolUseIds.delete(event.toolUseId)) {
              workflowInFlight = workflowLaunchToolUseIds.size > 0
              if (activeSubagents.size === 0 && !workflowInFlight) disarmWatchdog()
            }
            const itemId = itemIds.get(event.toolUseId)
            if (!itemId) return
            const resultText = toolResultText(event.content)
            const durationMs = (() => {
              const started = itemStartedAtMs.get(itemId)
              return started == null ? null : Math.max(0, nowMillis() - started)
            })()
            const parsedExitCode = parseExitCodeFromResult(event.content) ?? (event.isError ? 1 : 0)
            const updated = this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'commandExecution') {
                return {
                  ...item,
                  status: event.isError ? 'failed' : 'completed',
                  aggregatedOutput: item.aggregatedOutput ?? resultText,
                  exitCode: parsedExitCode,
                  durationMs,
                }
              }
              if (item.type === 'fileChange')
                return { ...item, status: event.isError ? 'failed' : 'completed' }
              if (item.type === 'mcpToolCall') {
                // Protocol-correct shape: McpToolCallResult = {content[], structuredContent, _meta};
                // McpToolCallError = {message}. We previously shipped raw event.content for both
                // which crashed App's ts-rs deserializer for any tool that returned anything richer
                // than a primitive. Always wrap into the strict shape.
                return {
                  ...item,
                  status: event.isError ? 'failed' : 'completed',
                  result: event.isError ? null : wrapMcpToolResult(event.content),
                  error: event.isError ? wrapMcpToolError(event.content) : null,
                  durationMs,
                }
              }
              if (item.type === 'webSearch') {
                return { ...item, action: parseWebSearchAction(item.query, resultText) }
              }
              return item
            })
            const item = updated?.items.find((candidate) => candidate.id === itemId)
            if (item?.type === 'commandExecution' && resultText && !commandOutputSeen.has(itemId)) {
              this.notify(peer, {
                method: 'item/commandExecution/outputDelta',
                params: { threadId: thread.id, turnId: turn.id, itemId, delta: resultText },
              })
            }
            if (item)
              this.notify(peer, {
                method: 'item/completed',
                params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
              })
            const diff = await gitDiff(thread.cwd)
            if (this.store.getTurn(turn.id)?.status !== 'inProgress') return
            if (diff) {
              this.store.updateTurnDiff(turn.id, diff)
              this.notify(peer, {
                method: 'turn/diff/updated',
                params: { threadId: thread.id, turnId: turn.id, diff },
              })
            }
            return
          }
          if (event.type === 'notice') {
            const itemId = ensureAgentItem()
            const prefix =
              event.level === 'warning'
                ? '[Claude warning] '
                : event.level === 'error'
                  ? '[Claude error] '
                  : '[Claude event] '
            const delta = prefix + event.message + '\n'
            this.store.updateItem(turn.id, itemId, (item) => {
              if (item.type === 'agentMessage') return { ...item, text: item.text + delta }
              return item
            })
            this.notify(peer, {
              method: 'item/agentMessage/delta',
              params: { threadId: thread.id, turnId: turn.id, itemId, delta },
            })
            return
          }
          if (event.type === 'usage') {
            this.recordTokenUsage(peer, thread.id, turn.id, event.usage)
            return
          }
          if (event.type === 'hook') {
            // Render the hook event as a Codex hookPrompt item alongside the
            // (still-emitted) notice line, so the user sees structured hook
            // activity in the timeline instead of just a one-liner warning.
            // All fragments of the same hook run share one hookRunId so App
            // groups them under a single execution; the format matches
            // Codex's own hookprompt items (one synthetic run id per emit).
            const hookRunId = newId()
            const fragments: Array<{ text: string; hookRunId: string }> = [
              { text: `Hook · ${event.hookName}`, hookRunId },
            ]
            if (event.status) fragments.push({ text: `status: ${event.status}`, hookRunId })
            if (event.decision) fragments.push({ text: `decision: ${event.decision}`, hookRunId })
            if (event.message) fragments.push({ text: event.message, hookRunId })
            const hookItem: ThreadItem = { type: 'hookPrompt', id: newId(), fragments }
            this.store.appendItem(turn.id, hookItem)
            this.notify(peer, {
              method: 'item/started',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: hookItem,
                startedAtMs: nowMillis(),
              },
            })
            this.notify(peer, {
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId: turn.id,
                item: hookItem,
                completedAtMs: nowMillis(),
              },
            })
            return
          }
          if (event.type === 'metrics') {
            // Track metrics on the runRuntimeTurn closure rather than in the
            // SQLite turns row (which doesn't have these columns). They get
            // merged into the final TurnRecord shipped via turn/completed.
            collectedMetrics.apiDurationMs = event.apiDurationMs
            collectedMetrics.numTurns = event.numTurns
            collectedMetrics.costUsd = event.costUsd
            collectedMetrics.set = true
            return
          }
          if (event.type === 'completed') {
            if (event.claudeSessionId) {
              // Codex-backed threads route the SAME claudeSessionId slot into
              // codex_session_id (used as `codex exec resume <id>` on the
              // next turn). Claude threads keep the original wiring.
              if (isCodexThread) {
                this.store.updateCodexSessionId(thread.id, event.claudeSessionId)
              } else {
                this.store.updateClaudeSessionId(thread.id, event.claudeSessionId)
              }
            }
            if (!event.success) throw new Error(event.result ?? 'Claude turn failed')
          }
          if (event.type === 'error') {
            throw new Error(event.message)
          }
        },
        onPermissionRequest: async (event) => {
          if (!turnIsActive()) return { decision: 'cancel' }
          let itemId = itemIds.get(event.toolUseId)
          if (!itemId) {
            const item = this.toolUseToItem(
              {
                type: 'tool_use',
                toolUseId: event.toolUseId,
                toolName: event.toolName,
                input: event.input,
              },
              thread.cwd,
            )
            itemId = item.id
            itemIds.set(event.toolUseId, item.id)
            this.store.appendItem(turn.id, item)
            this.notify(peer, {
              method: 'item/started',
              params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: nowMillis() },
            })
            if (item.type === 'fileChange') {
              this.notify(peer, {
                method: 'item/fileChange/patchUpdated',
                params: {
                  threadId: thread.id,
                  turnId: turn.id,
                  itemId: item.id,
                  changes: item.changes,
                },
              })
            }
          }
          const decision = await this.requestApproval(peer, thread.id, turn.id, itemId, event)
          if (!turnIsActive()) return { decision: 'cancel' }
          if (decision.decision === 'acceptForSession') {
            const command = String(event.input.command ?? '')
            if (command) {
              const set = this.commandSessionAllow.get(thread.id) ?? new Set<string>()
              set.add(command)
              this.commandSessionAllow.set(thread.id, set)
            }
          }
          return decision
        },
        onUserInputRequest: async (event) => {
          if (!turnIsActive()) return { answers: {} }
          // Render AskUserQuestion as Codex's native dynamicToolCall item +
          // item/tool/requestUserInput reverse RPC. The App pops its
          // structured choice card; we wait for the answers, finalise the
          // item, then return the structured answer back to the runtime
          // (which forwards it to the model via the canUseTool deny path).
          const item: ThreadItem = {
            type: 'dynamicToolCall',
            id: newId(),
            namespace: 'claude',
            tool: 'AskUserQuestion',
            arguments: { questions: event.questions },
            status: 'inProgress',
            contentItems: null,
            success: null,
            durationMs: null,
          }
          this.store.appendItem(turn.id, item)
          const startedAt = nowMillis()
          this.notify(peer, {
            method: 'item/started',
            params: { threadId: thread.id, turnId: turn.id, item, startedAtMs: startedAt },
          })
          this.setThreadStatus(peer, thread.id, {
            type: 'active',
            activeFlags: ['waitingOnUserInput'],
          })
          const answers = await this.requestUserInput(
            peer,
            thread.id,
            turn.id,
            item.id,
            event.questions,
          )
          if (!turnIsActive()) return { answers: {} }
          const contentItems = userInputAnswersAsContent(event.questions, answers)
          const completedItem: ThreadItem = {
            ...item,
            status: 'completed',
            success: true,
            contentItems,
            durationMs: Math.max(0, nowMillis() - startedAt),
          }
          this.store.updateItem(turn.id, item.id, () => completedItem)
          this.notify(peer, {
            method: 'item/completed',
            params: {
              threadId: thread.id,
              turnId: turn.id,
              item: completedItem,
              completedAtMs: nowMillis(),
            },
          })
          this.setThreadStatus(peer, thread.id, { type: 'active', activeFlags: [] })
          return answers
        },
      },
    )
    const runtimeOutcome = runtimeTurn.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({
        kind: 'rejected' as const,
        error: error instanceof Error ? error : new Error(String(error)),
      }),
    )
    const outcome = watchdogPromise
      ? await Promise.race([
          runtimeOutcome,
          watchdogPromise.then(() => ({ kind: 'timeout' as const })),
        ])
      : await runtimeOutcome
    disarmWatchdog()
    acceptRuntimeEvents = false
    if (outcome.kind === 'timeout') {
      const timeoutSeconds = Math.ceil(watchdogTimeoutMs / 1000)
      const timeoutUnit = timeoutSeconds === 1 ? 'second' : 'seconds'
      const message = `Subagent did not publish a terminal result within ${timeoutSeconds} ${timeoutUnit}.`
      if (this.store.getTurn(turn.id)?.status === 'inProgress') {
        this.finalizeOrphanedSubagents(
          peer,
          thread,
          turn,
          subagentContexts,
          activeSubagents,
          message,
        )
        this.subagentStateByTurn.delete(turn.id)
        // Do not await the SDK interrupt here: some SDK versions wait for the
        // same result that has just timed out. The server catch path will
        // terminalize the parent turn immediately and late events are guarded.
        void this.runtime.interrupt(thread.id).catch(() => {})
      }
      throw new Error(message)
    }
    if (outcome.kind === 'rejected') {
      if (this.store.getTurn(turn.id)?.status === 'inProgress') {
        this.finalizeOrphanedSubagents(peer, thread, turn, subagentContexts, activeSubagents)
      }
      this.subagentStateByTurn.delete(turn.id)
      throw outcome.error
    }
    if (this.store.getTurn(turn.id)?.status === 'inProgress') {
      this.finalizeOrphanedSubagents(peer, thread, turn, subagentContexts, activeSubagents)
    }
    this.subagentStateByTurn.delete(turn.id)
    const currentTurn = this.store.getTurn(turn.id)
    if (currentTurn && currentTurn.status !== 'inProgress') return

    const finalDiff = await gitDiff(thread.cwd)
    if (this.store.getTurn(turn.id)?.status !== 'inProgress') return
    if (finalDiff) {
      this.store.updateTurnDiff(turn.id, finalDiff)
      this.notify(peer, {
        method: 'turn/diff/updated',
        params: { threadId: thread.id, turnId: turn.id, diff: finalDiff },
      })
    }
    if (params.outputSchema != null && agentItemId == null) {
      const text = fallbackStructuredText(params.outputSchema, prompt)
      const itemId = ensureAgentItem()
      this.store.updateItem(turn.id, itemId, (item) => {
        if (item.type === 'agentMessage') return { ...item, text }
        return item
      })
      this.notify(peer, {
        method: 'item/agentMessage/delta',
        params: { threadId: thread.id, turnId: turn.id, itemId, delta: text },
      })
    }
    const latestTurn = this.store.getTurn(turn.id)
    for (const completedItemId of [reasoningItemId, agentItemId, planItemId]) {
      const item = latestTurn?.items.find((candidate) => candidate.id === completedItemId)
      if (item)
        this.notify(peer, {
          method: 'item/completed',
          params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: nowMillis() },
        })
    }
    const completed: TurnRecord = this.store.completeTurn(turn.id, 'completed') ?? turn
    recordRunEvent('turn.completed', {
      threadId: thread.id,
      turnId: turn.id,
      runtimeBackend: thread.runtimeBackend,
      durationMs: completed.durationMs,
      apiDurationMs: collectedMetrics.apiDurationMs,
      numTurns: collectedMetrics.numTurns,
      costUsd: collectedMetrics.costUsd,
    })
    if (collectedMetrics.set) {
      completed.apiDurationMs = collectedMetrics.apiDurationMs
      completed.numTurns = collectedMetrics.numTurns
      completed.costUsd = collectedMetrics.costUsd
    }
    this.clearActiveTurn(thread.id)
    this.setThreadStatus(peer, thread.id, { type: 'idle' })
    // Plan-mode text streams through the `plan` ThreadItem + item/plan/delta
    // events; turn/plan/updated is reserved for the update_plan/TodoWrite
    // checklist tool (see the tool_use handler), matching the real app-server
    // which keeps those two surfaces separate.
    this.notify(peer, {
      method: 'turn/completed',
      params: { threadId: thread.id, turn: this.toLifecycleTurn(completed) },
    })
  }

  private completeSubagentChildTurn(
    peer: RpcPeer,
    context: SubagentContext,
    resultText: string,
    status: 'completed' | 'failed',
    error: unknown | null,
    durationMs: number | null = null,
  ): TurnRecord {
    let childTurn = this.store.getTurn(context.childTurnId)
    if (!childTurn) {
      childTurn = {
        id: context.childTurnId,
        threadId: context.childThreadId,
        status: 'inProgress',
        startedAt: nowSeconds(),
        completedAt: null,
        durationMs: null,
        items: [
          {
            type: 'userMessage',
            id: newId(),
            content: [{ type: 'text', text: context.prompt, text_elements: [] }],
          },
        ],
        diff: '',
        error: null,
      }
      this.store.upsertTurn(childTurn)
    }

    const agentItemId = newId()
    const startedItem: ThreadItem = {
      type: 'agentMessage',
      id: agentItemId,
      text: '',
      phase: null,
      memoryCitation: null,
    }
    this.store.appendItem(childTurn.id, startedItem)
    this.notify(peer, {
      method: 'item/started',
      params: {
        threadId: context.childThreadId,
        turnId: childTurn.id,
        item: startedItem,
        startedAtMs: nowMillis(),
      },
    })

    const completedItem: ThreadItem = { ...startedItem, text: resultText }
    this.store.updateItem(childTurn.id, agentItemId, () => completedItem)
    if (resultText) {
      this.notify(peer, {
        method: 'item/agentMessage/delta',
        params: {
          threadId: context.childThreadId,
          turnId: childTurn.id,
          itemId: agentItemId,
          delta: resultText,
        },
      })
    }
    this.notify(peer, {
      method: 'item/completed',
      params: {
        threadId: context.childThreadId,
        turnId: childTurn.id,
        item: completedItem,
        completedAtMs: nowMillis(),
      },
    })

    const completed = this.store.completeTurn(childTurn.id, status, error) ?? childTurn
    if (durationMs != null) {
      completed.durationMs = durationMs
      this.store.upsertTurn(completed)
    }
    this.setThreadStatus(peer, context.childThreadId, { type: 'idle' })
    this.notify(peer, {
      method: 'turn/completed',
      params: {
        threadId: context.childThreadId,
        turn: this.toCompletedTurn(completed),
      },
    })
    return completed
  }

  private emitSubagentActivity(
    peer: RpcPeer,
    parentThreadId: string,
    parentTurnId: string,
    context: SubagentContext,
    kind: 'started' | 'interacted' | 'interrupted' | 'completed',
  ): void {
    // Codex cc 26.x treats a persisted started activity marker as liveness,
    // but does not advertise a compatible terminal activity kind. The
    // canonical spawnAgent/wait lifecycle remains available for discovery and
    // review, so omit this optional marker for legacy peers.
    if (!this.supportsCompletedSubagentActivity(peer) && kind !== 'interrupted') return
    const item: ThreadItem = {
      type: 'subAgentActivity',
      id: newId(),
      kind,
      agentThreadId: context.childThreadId,
      agentPath: context.agentPath,
    }
    // Keep the persisted history capability-neutral. The durable wait and
    // child-turn state covers live and completed runs; persisting either
    // started or completed activity would make a mixed-version reconnect
    // decode a kind the peer may not support. Interrupted remains the one
    // legacy-safe terminal marker for abandoned children.
    if (kind === 'interrupted') this.store.appendItem(parentTurnId, item)
    this.emitItemLifecycle(peer, parentThreadId, parentTurnId, item)
  }

  private emitItemLifecycle(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    item: ThreadItem,
  ): void {
    const startedAtMs = nowMillis()
    this.notify(peer, {
      method: 'item/started',
      params: {
        threadId,
        turnId,
        item,
        startedAtMs,
      },
    })
    this.notify(peer, {
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item,
        completedAtMs: nowMillis(),
      },
    })
  }

  private supportsCompletedSubagentActivity(peer: RpcPeer): boolean {
    if (process.env.ANYENGINE_SUBAGENT_COMPLETED === '1') return true
    if (process.env.ANYENGINE_SUBAGENT_COMPLETED === '0') return false
    return this.peerFeatures.get(peer)?.supportsCompletedSubagentActivity === true
  }

  private finalizeOrphanedSubagents(
    peer: RpcPeer,
    thread: ThreadRecord,
    turn: TurnRecord,
    contexts: Map<string, SubagentContext>,
    active: Set<string>,
    failureMessage = 'Subagent ended without a terminal task result.',
  ): void {
    for (const toolUseId of Array.from(active)) {
      const context = contexts.get(toolUseId)
      active.delete(toolUseId)
      contexts.delete(toolUseId)
      if (!context) continue

      const message = failureMessage
      const childTurn = this.completeSubagentChildTurn(peer, context, message, 'failed', {
        message,
      })
      recordRunEvent('subagent.completed', {
        parentThreadId: thread.id,
        parentTurnId: turn.id,
        childThreadId: context.childThreadId,
        childTurnId: childTurn.id,
        status: 'failed',
        agentRole: context.subType ?? 'general-purpose',
      })

      this.emitSubagentActivity(peer, thread.id, turn.id, context, 'interrupted')

      const waitEnd: ThreadItem = {
        type: 'collabAgentToolCall',
        id: context.waitItemId,
        tool: 'wait',
        status: 'failed',
        senderThreadId: thread.id,
        receiverThreadIds: [context.childThreadId],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: { [context.childThreadId]: { status: 'errored', message } },
      }
      this.store.updateItemAndMoveToEnd(turn.id, context.waitItemId, () => waitEnd)
      this.notify(peer, {
        method: 'item/completed',
        params: {
          threadId: thread.id,
          turnId: turn.id,
          item: waitEnd,
          completedAtMs: nowMillis(),
        },
      })
      if (!this.supportsCompletedSubagentActivity(peer)) {
        const closeId = newId()
        const closeBegin: ThreadItem = {
          type: 'collabAgentToolCall',
          id: closeId,
          tool: 'closeAgent',
          status: 'inProgress',
          senderThreadId: thread.id,
          receiverThreadIds: [context.childThreadId],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        }
        this.store.appendItem(turn.id, closeBegin)
        this.notify(peer, {
          method: 'item/started',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            item: closeBegin,
            startedAtMs: nowMillis(),
          },
        })
        const closeEnd: ThreadItem = {
          ...closeBegin,
          status: 'failed',
          agentsStates: { [context.childThreadId]: { status: 'errored', message } },
        }
        this.store.updateItem(turn.id, closeId, () => closeEnd)
        this.notify(peer, {
          method: 'item/completed',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            item: closeEnd,
            completedAtMs: nowMillis(),
          },
        })
      }
    }
  }

  private async requestApproval(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    itemId: string,
    event: Extract<RuntimeEvent, { type: 'permission_request' }>,
  ): Promise<PermissionDecision> {
    // Defensive: if Codex App selected approvalPolicy=never (or "Full access"
    // sandbox), auto-accept without bouncing the request to the user. The
    // sidecar already drops can_use_tool in those modes, but in case some
    // future SDK path still emits permission_request, this prevents the
    // adapter from sitting on "Awaiting approval" forever.
    const thread = this.store.getThread(threadId)
    if (
      thread &&
      (thread.approvalPolicy === 'never' || thread.sandboxMode === 'danger-full-access')
    ) {
      return { decision: 'accept' }
    }
    const command = String(event.input.command ?? '')
    if (command && this.commandSessionAllow.get(threadId)?.has(command)) {
      return { decision: 'accept' }
    }

    // The App renders exactly two approval cards, and each one attaches to the
    // item type it names: `item/commandExecution/requestApproval` to a
    // commandExecution item, `item/fileChange/requestApproval` to a fileChange
    // item. The protocol has no approval request for an mcpToolCall — Codex
    // runs MCP tools without asking (config `default_tools_approval_mode`,
    // `auto` for local servers). Asking for a fileChange approval on an
    // mcpToolCall item left the App with nothing to draw and the turn spun
    // forever, which is what every `mcp__*`, ToolSearch and Skill call did.
    const approvalKind = approvalKindForTool(event.toolName)
    if (approvalKind === 'none') {
      debugLog('approval.autoAccepted', { threadId, itemId, toolName: event.toolName })
      return { decision: 'accept' }
    }

    this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: ['waitingOnApproval'] })
    const requestId = newId()
    const isCommand = approvalKind === 'command'
    const method = isCommand
      ? 'item/commandExecution/requestApproval'
      : 'item/fileChange/requestApproval'
    const params = isCommand
      ? {
          threadId,
          turnId,
          itemId,
          startedAtMs: nowMillis(),
          approvalId: requestId,
          reason: null,
          command,
          cwd: String(event.input.cwd ?? ''),
          commandActions: [],
          additionalPermissions: null,
          proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
          availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        }
      : {
          threadId,
          turnId,
          itemId,
          startedAtMs: nowMillis(),
          reason: null,
          grantRoot: null,
        }

    let response: unknown
    try {
      response = await this.sendServerRequest(peer, method, requestId, params)
    } finally {
      this.notify(peer, { method: 'serverRequest/resolved', params: { threadId, requestId } })
      this.setThreadStatus(peer, threadId, { type: 'active', activeFlags: [] })
    }
    const decision = normalizeDecision(response)
    return { decision }
  }

  private async requestUserInput(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    itemId: string,
    questions: UserInputQuestion[],
  ): Promise<UserInputAnswers> {
    const requestId = newId()
    // Always guarantee an "Other" affordance so the App's free-text fallback
    // is available, even when the upstream caller (Claude tool input, mock
    // runtime, etc.) didn't model it explicitly.
    const normalized = questions.map((q) => {
      const options = q.options ?? []
      const hasOther = options.some((o) => o.label === 'Other')
      return hasOther
        ? q
        : {
            ...q,
            options: [...options, { label: 'Other', description: 'Provide a free-form answer' }],
          }
    })
    const params = { threadId, turnId, itemId, questions: normalized }
    let response: unknown
    try {
      response = await this.sendServerRequest(peer, 'item/tool/requestUserInput', requestId, params)
    } finally {
      this.notify(peer, { method: 'serverRequest/resolved', params: { threadId, requestId } })
    }
    return normalizeUserInputAnswers(response, normalized)
  }

  private async turnInterrupt(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const requestedTurnId = stringOr(params.turnId, '')
    this.activePeerByThread.set(threadId, peer)
    const activeTurnId = this.activeTurnByThread.get(threadId)
    const turnId = activeTurnId || requestedTurnId
    if (turnId) {
      const turn = this.store.getTurn(turnId)
      if (turn?.status === 'inProgress') {
        const subagents = this.subagentStateByTurn.get(turnId)
        if (subagents) {
          this.finalizeOrphanedSubagents(
            peer,
            subagents.thread,
            subagents.turn,
            subagents.contexts,
            subagents.active,
          )
          this.subagentStateByTurn.delete(turnId)
        }
        const completed =
          this.store.completeTurn(turnId, 'interrupted', { message: 'interrupted' }) ?? turn
        this.notify(peer, {
          method: 'turn/completed',
          params: { threadId, turn: this.toLifecycleTurn(completed) },
        })
      }
    }
    this.clearActiveTurn(threadId)
    this.setThreadStatus(peer, threadId, { type: 'idle' })
    // Persist the terminal state before asking the SDK to abort. A few SDK
    // versions deliver one or two buffered tool events during interrupt; the
    // runRuntimeTurn guard now rejects them because the turn is no longer
    // active, so they cannot create an orphan child after this point.
    const interrupting = this.runtime.interrupt(threadId)
    await interrupting
    return {}
  }

  private async turnSteer(_peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const threadId = stringOr(params.threadId, '')
    const expectedTurnId = stringOr(params.expectedTurnId, '')
    const activeTurnId = this.activeTurnByThread.get(threadId)
    if (!activeTurnId) throw new Error(`thread has no active turn: ${threadId}`)
    if (expectedTurnId && expectedTurnId !== activeTurnId) {
      throw new Error(`active turn mismatch: expected ${expectedTurnId}, got ${activeTurnId}`)
    }
    const input = Array.isArray(params.input) ? (params.input as UserInput[]) : []
    const prompt = textFromInput(input)
    // The steered message is retained on the turn for history (thread/read), but
    // — like a normal turn's user message — it is NOT surfaced as a userMessage
    // item/started+item/completed event. The real app-server's turn_steer just
    // feeds the input into the core (steer_input) and EventMsg::UserMessage is
    // unhandled in the live stream, so no userMessage item event is emitted.
    const item: ThreadItem = { type: 'userMessage', id: newId(), content: input }
    this.store.appendItem(activeTurnId, item)
    await this.runtime.steer(threadId, prompt)
    return { turnId: activeTurnId }
  }

  private accountRateLimits(): unknown {
    const rateLimits = {
      limitId: 'claude-code',
      limitName: 'Claude Code',
      primary: null,
      secondary: null,
      credits: null,
      planType: null,
      rateLimitReachedType: null,
    }
    return { rateLimits, rateLimitsByLimitId: { 'claude-code': rateLimits } }
  }

  // Accumulates Claude Agent SDK token usage per thread and pushes a
  // `thread/tokenUsage/updated` notification so the Codex App can render real
  // consumption instead of leaving the meter blank.
  private recordTokenUsage(
    peer: RpcPeer,
    threadId: string,
    turnId: string,
    usage: Record<string, unknown>,
  ): void {
    const last = tokenBreakdownFromClaudeUsage(usage)
    if (last.totalTokens === 0) return
    const prior = this.tokenUsageByThread.get(threadId) ?? emptyTokenBreakdown()
    const total: TokenUsageBreakdown = {
      totalTokens: prior.totalTokens + last.totalTokens,
      inputTokens: prior.inputTokens + last.inputTokens,
      cachedInputTokens: prior.cachedInputTokens + last.cachedInputTokens,
      outputTokens: prior.outputTokens + last.outputTokens,
      reasoningOutputTokens: prior.reasoningOutputTokens + last.reasoningOutputTokens,
    }
    this.tokenUsageByThread.set(threadId, total)
    const tokenUsage: ThreadTokenUsage = { total, last, modelContextWindow: null }
    this.notify(peer, {
      method: 'thread/tokenUsage/updated',
      params: { threadId, turnId, tokenUsage },
    })
    // NOTE: previously we also pushed `account/rateLimits/updated` here on
    // every token-usage event "to keep the UI in sync". That backfired —
    // Codex App treats every such notification as a fresh rate-limit signal
    // and surfaces it as a transient warning banner, so the user saw a
    // rate-limit pop on every assistant turn. Since we don't actually have
    // real rate-limit data from the Anthropic SDK (no headers exposed), the
    // notification was empty noise. The initial snapshot still fires once
    // post-handshake in `initialize` so the UI populates on first connect.
  }

  private marketplaceAdd(params: Record<string, unknown>): unknown {
    const source = stringOr(params.source, 'local')
    const marketplaceName = stringOr(
      params.refName,
      source.split('/').filter(Boolean).at(-1) ?? 'marketplace',
    )
    return {
      marketplaceName,
      installedRoot: `${codexHome()}/marketplaces/${marketplaceName}`,
      alreadyAdded: true,
    }
  }

  private marketplaceRemove(params: Record<string, unknown>): unknown {
    const marketplaceName = stringOr(params.marketplaceName, 'marketplace')
    return { marketplaceName, installedRoot: null }
  }

  private marketplaceUpgrade(params: Record<string, unknown>): unknown {
    const marketplaceName =
      typeof params.marketplaceName === 'string' ? params.marketplaceName : null
    return {
      selectedMarketplaces: marketplaceName ? [marketplaceName] : [],
      upgradedRoots: [],
      errors: [],
    }
  }

  private pluginShareSave(params: Record<string, unknown>): unknown {
    const remotePluginId = stringOr(params.remotePluginId, `local-${newId()}`)
    return {
      remotePluginId,
      shareUrl: `https://localhost.invalid/anyengine/plugin-share/${encodeURIComponent(remotePluginId)}`,
    }
  }

  private pluginShareUpdateTargets(params: Record<string, unknown>): unknown {
    const shareTargets = Array.isArray(params.shareTargets) ? params.shareTargets : []
    return {
      principals: shareTargets.map((target) => {
        const rec = asRecord(target)
        return {
          principalType: stringOr(rec.principalType, 'user'),
          principalId: stringOr(rec.principalId, ''),
          name: stringOr(rec.principalId, 'unknown'),
        }
      }),
      discoverability: params.discoverability === 'UNLISTED' ? 'UNLISTED' : 'PRIVATE',
    }
  }

  private pluginRead(params: Record<string, unknown>): unknown {
    const name = stringOr(params.pluginName, 'unknown')
    const known = findCodexPlugin(
      listCodexPlugins(),
      name,
      stringOr(params.remoteMarketplaceName, '') || null,
    )
    if (known) return { plugin: pluginDetail(known) }
    return {
      plugin: {
        marketplaceName: stringOr(params.remoteMarketplaceName, 'local'),
        marketplacePath: params.marketplacePath ?? null,
        summary: {
          id: name,
          name,
          shareContext: null,
          source: { type: 'remote' },
          installed: false,
          enabled: false,
          installPolicy: 'NOT_AVAILABLE',
          authPolicy: 'ON_USE',
          availability: 'AVAILABLE',
          interface: null,
          keywords: [],
        },
        description: null,
        skills: [],
        hooks: [],
        apps: [],
        appTemplates: [],
        mcpServers: [],
      },
    }
  }

  private getConversationSummary(params: Record<string, unknown>): unknown {
    const threadId = stringOr(params.conversationId, '')
    const thread = this.store.getThread(threadId) ?? this.store.listThreads({ limit: 1 }).at(0)
    const now = new Date().toISOString()
    return {
      summary: {
        conversationId: thread?.id ?? threadId,
        path: '',
        preview: thread?.preview ?? '',
        timestamp: now,
        updatedAt: now,
        modelProvider: thread?.modelProvider ?? 'claude-code',
        cwd: thread?.cwd ?? process.cwd(),
        cliVersion: codexCliVersion(),
        source: normalizeSessionSource(thread?.source),
        gitInfo: null,
      },
    }
  }

  private async gitDiffToRemote(params: Record<string, unknown>): Promise<unknown> {
    const cwd = stringOr(params.cwd, process.cwd())
    const diff = await gitDiff(cwd)
    let sha = ''
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, timeout: 10_000 })
      sha = stdout.trim()
    } catch {}
    return { sha, diff }
  }

  private async fuzzyFileSearch(params: Record<string, unknown>): Promise<unknown> {
    const query = stringOr(params.query, '')
    const roots = Array.isArray(params.roots) ? params.roots.map(String) : [process.cwd()]
    return { files: await this.fuzzySearchCore(query, roots) }
  }

  private async fuzzySearchCore(
    rawQuery: string,
    roots: string[],
  ): Promise<Array<Record<string, unknown>>> {
    const query = rawQuery.toLowerCase()
    const files: Array<Record<string, unknown>> = []
    for (const root of roots) {
      const paths = await listFiles(root)
      for (const path of paths) {
        const fileName = path.split('/').at(-1) ?? path
        const haystack = path.toLowerCase()
        if (query && !haystack.includes(query)) continue
        files.push({
          root,
          path,
          match_type: 'file',
          file_name: fileName,
          score: query ? Math.max(1, 100 - haystack.indexOf(query)) : 1,
          indices: null,
        })
        if (files.length >= 100) break
      }
      if (files.length >= 100) break
    }
    return files
  }

  private fuzzySessionStart(params: Record<string, unknown>): unknown {
    const sessionId = stringOr(params.sessionId, '')
    const roots = Array.isArray(params.roots) ? params.roots.map(String) : [process.cwd()]
    if (sessionId) this.fuzzySessions.set(sessionId, { roots })
    return {}
  }

  private async fuzzySessionUpdate(
    peer: RpcPeer,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const sessionId = stringOr(params.sessionId, '')
    const query = stringOr(params.query, '')
    const session = this.fuzzySessions.get(sessionId)
    const roots = session?.roots ?? [process.cwd()]
    const files = await this.fuzzySearchCore(query, roots)
    if (session && this.fuzzySessions.get(sessionId) === session) {
      this.notify(peer, {
        method: 'fuzzyFileSearch/sessionUpdated',
        params: { sessionId, query, files },
      })
    }
    return {}
  }

  private fuzzySessionStop(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const sessionId = stringOr(params.sessionId, '')
    this.fuzzySessions.delete(sessionId)
    if (sessionId) {
      this.notify(peer, {
        method: 'fuzzyFileSearch/sessionCompleted',
        params: { sessionId },
      })
    }
    return {}
  }

  private toolUseToItem(
    event: Extract<RuntimeEvent, { type: 'tool_use' }>,
    cwd: string,
  ): ThreadItem {
    return toolUseToItem(event, cwd)
  }

  private threadEnvelope(thread: ThreadRecord, turns: TurnRecord[] = []): unknown {
    return threadEnvelope(this.store, thread, turns)
  }

  private toThread(thread: ThreadRecord, turns: TurnRecord[] = []): unknown {
    return toThread(this.store, thread, turns)
  }

  private toTurnView(turn: TurnRecord, itemsView: TurnItemsView): unknown {
    return toTurnView(turn, itemsView)
  }

  private toLifecycleTurn(turn: TurnRecord, items: ThreadItem[] = []): unknown {
    return toLifecycleTurn(turn, items)
  }

  private toCompletedTurn(turn: TurnRecord): unknown {
    return toCompletedTurn(turn)
  }

  private sendResponse(
    peer: RpcPeer,
    id: JsonRpcId,
    result?: unknown,
    error?: { code: number; message: string; data?: unknown },
  ): void {
    const response: JsonRpcResponse = { jsonrpc: '2.0', id }
    if (error) response.error = error
    else response.result = result ?? null
    peer.send(response)
  }

  private notify(peer: RpcPeer, notification: { method: string; params: unknown }): void {
    // Shutdown intentionally suppresses wire notifications: the peer may
    // already have closed, while persistence still needs to settle child and
    // parent state without throwing on a broken pipe.
    if (this.stopped) return
    this.bridge?.onNotification(notification)
    const target = this.peerForParams(peer, notification.params)
    debugLog('rpc.notify', {
      peerId: target.id,
      originalPeerId: target.id === peer.id ? null : peer.id,
      method: notification.method,
      params: summarizeRpcParams(notification.method, notification.params),
    })
    target.send({ jsonrpc: '2.0', method: notification.method, params: notification.params })
  }

  private notifyThread(threadId: string, notification: { method: string; params: unknown }): void {
    const peer = this.activePeerByThread.get(threadId)
    if (peer) this.notify(peer, notification)
  }

  private setThreadStatus(
    peer: RpcPeer | null,
    threadId: string,
    status: ThreadRecord['status'],
  ): void {
    this.store.updateThreadStatus(threadId, status)
    const target = peer ?? this.activePeerByThread.get(threadId)
    if (target)
      this.notify(target, { method: 'thread/status/changed', params: { threadId, status } })
  }

  private sendServerRequest(
    peer: RpcPeer,
    method: string,
    id: string,
    params: unknown,
  ): Promise<unknown> {
    const target = this.peerForParams(peer, params)
    const key = `${target.id}:${id}`
    return new Promise((resolve, reject) => {
      debugLog('rpc.serverRequest', {
        peerId: target.id,
        originalPeerId: target.id === peer.id ? null : peer.id,
        id,
        method,
        params: summarizeRpcParams(method, params),
      })
      this.pendingServerRequests.set(key, { resolve, reject })
      target.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private resolveServerRequest(response: JsonRpcResponse): void {
    for (const [key, pending] of this.pendingServerRequests.entries()) {
      if (key.endsWith(`:${String(response.id)}`)) {
        this.pendingServerRequests.delete(key)
        if (response.error) pending.reject(new Error(response.error.message))
        else pending.resolve(response.result)
        return
      }
    }
  }

  private completeActiveTurns(status: 'interrupted' | 'failed', error: unknown): void {
    for (const [threadId, turnId] of this.activeTurnByThread.entries()) {
      const turn = this.store.getTurn(turnId)
      if (turn?.status === 'inProgress') {
        this.store.completeTurn(turnId, status, error)
      }
      this.store.updateThreadStatus(threadId, { type: 'idle' })
    }
    this.activeTurnByThread.clear()
  }

  private finalizeActiveSubagentsForShutdown(message: string): void {
    for (const [turnId, state] of this.subagentStateByTurn.entries()) {
      const turn = this.store.getTurn(turnId)
      if (!turn || turn.status !== 'inProgress') {
        this.subagentStateByTurn.delete(turnId)
        continue
      }
      const peer = this.activePeerByThread.get(state.thread.id) ?? {
        id: 'shutdown',
        send: () => {},
        close: () => {},
      }
      this.finalizeOrphanedSubagents(
        peer,
        state.thread,
        turn,
        state.contexts,
        state.active,
        message,
      )
      this.subagentStateByTurn.delete(turnId)
    }
  }

  private clearActiveTurn(threadId: string): void {
    const existed = this.activeTurnByThread.delete(threadId)
    if (existed && this.activeTurnByThread.size === 0) this.idleCheckHandler?.()
  }

  private peerForParams(peer: RpcPeer, params: unknown): RpcPeer {
    const threadId = stringOr(asRecord(params).threadId, '')
    if (!threadId) return peer
    const direct = this.activePeerByThread.get(threadId)
    if (direct) return direct
    const seen = new Set<string>()
    let current = this.store.getThread(threadId)
    while (current?.forkedFromId && !seen.has(current.forkedFromId)) {
      seen.add(current.forkedFromId)
      const ancestorPeer = this.activePeerByThread.get(current.forkedFromId)
      if (ancestorPeer) {
        this.activePeerByThread.set(threadId, ancestorPeer)
        return ancestorPeer
      }
      current = this.store.getThread(current.forkedFromId)
    }
    return peer
  }

  private bindPeerToDescendants(peer: RpcPeer, rootThreadId: string): void {
    const queue = [rootThreadId]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const parentId = queue.shift()
      if (!parentId || seen.has(parentId)) continue
      seen.add(parentId)
      for (const child of this.store.listThreads({
        includeEphemeral: true,
        parentThreadId: parentId,
        sortKey: 'created_at',
        sortDirection: 'asc',
      })) {
        this.activePeerByThread.set(child.id, peer)
        queue.push(child.id)
      }
    }
  }
}

// Per-thread rule: a grok-* model selects the grok runtime regardless of the
// configured default backend (mirrors how gpt-* selects codex-proxy). Mock
// mode keeps every model on the mock runtime so protocol tests stay
// deterministic.
function grokRuntimeTypeFor(model: string | null): 'grok' | null {
  if (process.env.ANYENGINE_MOCK === '1') return null
  return isGrokModel(model) ? 'grok' : null
}
