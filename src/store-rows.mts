// Stored rows as records (`threads`, `turns`, `thread_engines`), and a
// request's posture applied to a thread row. Kept out of store.mts so the
// store stays under its size baseline as columns are added.
import {
  applyCodexParams,
  DEFAULT_POSTURE,
  type Posture,
  parseStoredPosture,
  postureFields,
  threadPosture,
} from './posture.mjs'
import { durablePosture } from './requirements-reads.mjs'
import { hasLegacyPermissionParams, permissionProfileIdFromParams } from './server-helpers.mjs'
import type { ThreadEngineRecord, ThreadRecord, TurnRecord, TurnStatus } from './types.mjs'

export function threadFromRow(row: any): ThreadRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    forkedFromId: row.forked_from_id == null ? null : String(row.forked_from_id),
    preview: String(row.preview ?? ''),
    name: row.name == null ? null : String(row.name),
    archived: Number(row.archived) === 1,
    cwd: String(row.cwd),
    model: String(row.model),
    reasoningEffort: row.reasoning_effort == null ? null : String(row.reasoning_effort),
    modelProvider: String(row.model_provider),
    claudeSessionId: row.claude_session_id == null ? null : String(row.claude_session_id),
    source: String(row.source),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    status: JSON.parse(String(row.status_json)),
    approvalPolicy: row.approval_policy == null ? null : String(row.approval_policy),
    sandboxMode: row.sandbox_mode == null ? null : String(row.sandbox_mode),
    permissionProfileId:
      row.permission_profile_id == null ? null : String(row.permission_profile_id),
    ephemeral: Number(row.ephemeral ?? 0) === 1,
    threadSource: row.thread_source == null ? null : String(row.thread_source),
    agentRole: row.agent_role == null ? null : String(row.agent_role),
    agentNickname: row.agent_nickname == null ? null : String(row.agent_nickname),
    baseInstructions: row.base_instructions == null ? null : String(row.base_instructions),
    developerInstructions:
      row.developer_instructions == null ? null : String(row.developer_instructions),
    personality: row.personality == null ? null : String(row.personality),
    runtimeBackend: row.runtime_backend === 'codex' ? 'codex' : 'claude',
    codexSessionId: row.codex_session_id == null ? null : String(row.codex_session_id),
    rehomePrefix: row.rehome_prefix == null ? null : String(row.rehome_prefix),
    ...storedPosture(row.posture_json),
  }
}

// A row stored before M0 has no posture and keeps its two legacy strings,
// which threadPosture() reads. A posture that is stored but cannot be read is
// the tight default, strings included: never the strings, whose projection
// can be looser than what was stored (a granular policy reads as on-request,
// an external or temp-excluding sandbox as workspace-write).
function storedPosture(json: unknown): Partial<ThreadRecord> {
  if (json == null) return { posture: null }
  return postureFields(parseStoredPosture(String(json)) ?? DEFAULT_POSTURE)
}

type PosturedRow = ThreadRecord & { posture: Posture }

// A thread row with a request's posture fields applied (src/posture.mts): the
// posture, its legacy strings, and the profile id the request names. A
// legacy posture field without a profile clears the id; nothing keeps it.
export function rowWithPosture(row: ThreadRecord, params: Record<string, unknown>): PosturedRow
export function rowWithPosture(
  row: ThreadRecord | null,
  params: Record<string, unknown>,
): PosturedRow | null
export function rowWithPosture(
  row: ThreadRecord | null,
  params: Record<string, unknown>,
): PosturedRow | null {
  if (!row) return null
  const named = permissionProfileIdFromParams(params)
  return {
    ...row,
    ...postureFields(applyCodexParams(threadPosture(row), params)),
    permissionProfileId:
      named || hasLegacyPermissionParams(params) ? named : (row.permissionProfileId ?? null),
  }
}

export function turnFromRow(row: any): TurnRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    status: String(row.status) as TurnStatus,
    startedAt: row.started_at == null ? null : Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    items: JSON.parse(String(row.items_json)),
    diff: String(row.diff ?? ''),
    error: row.error_json == null ? null : JSON.parse(String(row.error_json)),
  }
}

export function threadEngineFromRow(row: any): ThreadEngineRecord {
  return {
    id: String(row.id),
    engine: row.engine === 'gpt' ? 'gpt' : row.engine === 'grok' ? 'grok' : 'claude',
    upstreamThreadId: row.upstream_thread_id == null ? null : String(row.upstream_thread_id),
    pendingPrefix: row.pending_prefix == null ? null : String(row.pending_prefix),
    carriedTurnId: row.carried_turn_id == null ? null : String(row.carried_turn_id),
  }
}

// Guard direct store callers as well as the usual postureFields boundary.
export function postureJson(posture: Posture | null | undefined): string | null {
  return posture ? JSON.stringify(durablePosture(posture)) : null
}
