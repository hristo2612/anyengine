// How a stored thread, turn or tool call is rendered for the Codex App.
//
// These are the wire mappers: they take what the store holds and return the
// exact shapes the app-server protocol promises. Nothing here talks to a
// runtime, a peer or a child process, so a change to a payload can be read and
// tested on its own instead of inside the protocol class they used to live in.
// The two that walk the subagent ancestry take the store as their first
// argument; the rest are pure.
import { nicknameFor } from './bridge-control.mjs'
import {
  COMMAND_TOOLS,
  FILE_CHANGE_TOOLS,
  fileChangeFromTool,
  normalizeSessionSource,
  normalizeThreadSource,
  nullIfEmpty,
  sandboxEnvelope,
  threadPermissionProfileId,
} from './server-helpers.mjs'
import type { SessionStore } from './store.mjs'
import type { RuntimeEvent, ThreadItem, ThreadRecord, TurnRecord } from './types.mjs'
import { codexCliVersion, newId } from './util.mjs'

/** How many of a turn's items `thread/read` and `turns/list` send back. */
export type TurnItemsView = 'full' | 'summary' | 'notLoaded'

export function toolUseToItem(
  event: Extract<RuntimeEvent, { type: 'tool_use' }>,
  cwd: string,
): ThreadItem {
  const id = newId()
  if (COMMAND_TOOLS.has(event.toolName)) {
    return {
      type: 'commandExecution',
      id,
      command: String(event.input.command ?? ''),
      cwd: String(event.input.cwd ?? cwd),
      // Use the SDK's tool_use_id as a stable handle. Without a non-null
      // processId the Codex App was treating these as "Background terminal"
      // entries (no attached process) and hiding their output; with a
      // synthetic id they render as inline command items like a normal
      // foreground bash invocation.
      processId: `claude:${event.toolUseId}`,
      source: 'agent',
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    }
  }
  if (FILE_CHANGE_TOOLS.has(event.toolName)) {
    return {
      type: 'fileChange',
      id,
      changes: fileChangeFromTool(event.toolName, event.input),
      status: 'inProgress',
    }
  }
  if (event.toolName === 'WebSearch') {
    // Codex App has a dedicated `webSearch` ThreadItem with a structured
    // action — emit it instead of a generic mcpToolCall so the App can show
    // the search badge (and follow-up open-page links) natively. The action
    // is finalized when the tool_result arrives (see tool_result handler).
    // The 'search' variant's `query` / `queries` are required (Option fields
    // with no serde default), so always populate both even on the initial
    // inProgress emit.
    const q = String(event.input.query ?? '')
    return {
      type: 'webSearch',
      id,
      query: q,
      action: { type: 'search', query: q || null, queries: null },
    }
  }
  let displayTool = event.toolName
  if (event.toolName === 'Read') {
    const raw = String(event.input.file_path || event.input.path || '')
    if (raw) {
      let displayPath = raw
      try {
        if (cwd && raw.startsWith(cwd)) {
          displayPath = raw.slice(cwd.length).replace(/^\/+/, '')
        } else {
          const parts = raw.split(/\//).filter(Boolean)
          displayPath = parts.length > 2 ? parts.slice(-2).join('/') : raw
        }
      } catch {}
      displayTool = `Read ${displayPath || raw}`
    }
  } else if (event.toolName === 'Grep') {
    const pat = String(event.input.pattern ?? '')
    const rawPath = event.input.path ? String(event.input.path) : ''
    let pathStr = ''
    if (rawPath) {
      const parts = rawPath.split(/\//).filter(Boolean)
      pathStr = ` (${parts.length > 2 ? parts.slice(-2).join('/') : rawPath})`
    }
    if (pat) displayTool = `Grep ${pat}${pathStr}`
  } else if (event.toolName === 'Glob') {
    const pat = String(event.input.pattern ?? '')
    if (pat) displayTool = `Glob ${pat}`
  }

  return {
    type: 'mcpToolCall',
    id,
    server: 'claude-code',
    tool: displayTool,
    status: 'inProgress',
    arguments: event.input,
    result: null,
    error: null,
    durationMs: null,
  }
}

export function threadEnvelope(
  store: SessionStore,
  thread: ThreadRecord,
  turns: TurnRecord[] = [],
): unknown {
  const activePermissionProfileId = threadPermissionProfileId(
    thread.permissionProfileId,
    thread.approvalPolicy,
    thread.sandboxMode,
  )
  return {
    thread: toThread(store, thread, turns),
    model: thread.model,
    modelProvider: thread.modelProvider,
    serviceTier: null,
    cwd: thread.cwd,
    runtimeWorkspaceRoots: [thread.cwd],
    instructionSources: [],
    approvalPolicy: thread.approvalPolicy ?? 'never',
    approvalsReviewer: 'user',
    sandbox: sandboxEnvelope(thread.sandboxMode, thread.cwd),
    permissionProfile: null,
    activePermissionProfile: activePermissionProfileId
      ? { id: activePermissionProfileId, extends: null }
      : null,
    // Some newer clients read the compact id while older clients use the
    // structured activePermissionProfile field. Return both; unknown extra
    // fields are ignored by the legacy app-server schema.
    permissions: activePermissionProfileId,
    reasoningEffort: thread.reasoningEffort,
    multiAgentMode: 'explicitRequestOnly',
  }
}

export function toThread(
  store: SessionStore,
  thread: ThreadRecord,
  turns: TurnRecord[] = [],
): unknown {
  const agentNickname = nullIfEmpty(thread.agentNickname)
  const agentRole = nullIfEmpty(thread.agentRole)
  const parentThreadId = thread.threadSource === 'subagent' ? thread.forkedFromId : null
  const source = parentThreadId
    ? {
        subAgent: {
          thread_spawn: {
            parent_thread_id: parentThreadId,
            depth: subagentDepth(store, thread),
            agent_path: null,
            agent_nickname: agentNickname,
            agent_role: agentRole,
          },
        },
      }
    : normalizeSessionSource(thread.source)
  const profileId =
    thread.sandboxMode === 'danger-full-access'
      ? ':danger-full-access'
      : thread.sandboxMode === 'read-only'
        ? ':read-only'
        : ':workspace'

  return {
    id: thread.id,
    isPinned: false,
    sessionId: thread.sessionId,
    forkedFromId: thread.forkedFromId,
    parentThreadId,
    preview: thread.preview,
    ephemeral: thread.ephemeral,
    modelProvider: thread.modelProvider,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.updatedAt,
    status: thread.status,
    path: null,
    cwd: thread.cwd,
    cliVersion: codexCliVersion(),
    canAcceptDirectInput: true,
    activePermissionProfile: profileId,
    // Defense-in-depth: even if older rows hold an invalid `source` or
    // `threadSource` (legacy `app_server`, empty string from a buggy write
    // path), coerce on the way out so the App's strict deserializer never
    // sees a value outside the wire enum.
    source,
    threadSource: normalizeThreadSource(thread.threadSource),
    agentNickname,
    agentRole,
    gitInfo: null,
    name: thread.name,
    turns: turns.map((turn) => toTurn(turn)),
  }
}

export function subagentDepth(store: SessionStore, thread: ThreadRecord): number {
  let depth = thread.threadSource === 'subagent' ? 1 : 0
  let ancestorId = thread.forkedFromId
  const seen = new Set([thread.id])
  while (ancestorId && !seen.has(ancestorId)) {
    seen.add(ancestorId)
    const ancestor = store.getThread(ancestorId)
    if (!ancestor || ancestor.threadSource !== 'subagent') break
    depth += 1
    ancestorId = ancestor.forkedFromId
  }
  return depth
}

// Full turn payload for history reads (thread/read, turns/list) — carries the
// loaded items. The Codex v2 `Turn` schema has no api/cost metadata fields, so
// the adapter's internal metrics are not serialized onto the wire.
export function toTurn(turn: TurnRecord): unknown {
  return {
    id: turn.id,
    items: turn.items,
    itemsView: 'full',
    status: turn.status,
    error: turn.error,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
  }
}

export function toTurnView(turn: TurnRecord, itemsView: TurnItemsView): unknown {
  if (itemsView === 'full') return toTurn(turn)
  if (itemsView === 'notLoaded') return toLifecycleTurn(turn)
  const firstUser = turn.items.find((item) => item.type === 'userMessage')
  const lastAgent = turn.items.findLast((item) => item.type === 'agentMessage')
  const items: ThreadItem[] = []
  if (firstUser) items.push(firstUser)
  if (lastAgent && lastAgent.id !== firstUser?.id) items.push(lastAgent)
  return {
    id: turn.id,
    items,
    itemsView: 'summary',
    status: turn.status,
    error: turn.error,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
  }
}

// Lightweight payload for turn/start, turn/started, and terminal paths that
// intentionally do not carry an assistant summary. The item stream drives
// the timeline; completed subagent turns use toCompletedTurn below.
export function toLifecycleTurn(turn: TurnRecord, items: ThreadItem[] = []): unknown {
  return {
    id: turn.id,
    items,
    itemsView: 'notLoaded',
    status: turn.status,
    error: turn.error,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
  }
}

// Codex includes the final assistant message in successful turn/completed
// notifications. Subagent pages depend on that summary because they can be
// opened with a metadata-only thread/read and may not replay prior deltas.
export function toCompletedTurn(turn: TurnRecord): unknown {
  const lastAgent =
    turn.status === 'completed' && turn.error == null
      ? turn.items.findLast((item) => item.type === 'agentMessage' && item.text.trim().length > 0)
      : undefined
  return {
    id: turn.id,
    items: lastAgent ? [lastAgent] : [],
    itemsView: lastAgent ? 'summary' : 'notLoaded',
    status: turn.status,
    error: turn.error,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
  }
}
