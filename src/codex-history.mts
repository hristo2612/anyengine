import type { MuxLocalServer } from './codex-mux.mjs'
import type { CodexUpstream } from './codex-upstream.mjs'
import { type Engine, startedAtOf } from './rehome.mjs'
import { asRecord } from './rpc-shape.mjs'
import type { RpcPeer } from './types.mjs'
import { debugLog } from './util.mjs'

export async function readThreadSides(
  local: MuxLocalServer,
  upstream: CodexUpstream,
  peer: RpcPeer,
  threadId: string,
  upstreamThreadId: string | null,
  engine: Engine,
) {
  const [localSettled, upstreamSettled] = await Promise.allSettled([
    local.localThreadOwner(threadId) != null
      ? local.dispatch(peer, 'thread/read', { threadId, includeTurns: true })
      : Promise.resolve(null),
    upstreamThreadId
      ? upstream.request('thread/read', { threadId: upstreamThreadId, includeTurns: true }, 30_000)
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
  const localTurns = Array.isArray(localThread?.turns) ? localThread.turns : [],
    upstreamTurns = Array.isArray(upstreamThread?.turns) ? upstreamThread.turns : [],
    upstreamFirst = engine !== 'gpt'
  const turns = [
    ...localTurns.map((turn) => ({ turn, rank: upstreamFirst ? 1 : 0 })),
    ...upstreamTurns.map((turn) => ({ turn, rank: upstreamFirst ? 0 : 1 })),
  ]
    .sort((a, b) => startedAtOf(a.turn) - startedAtOf(b.turn) || a.rank - b.rank)
    .map((entry) => entry.turn)
  return { localThread, upstreamThread, localTurns, upstreamTurns, turns }
}

export async function mergeLoadedThreads(
  local: MuxLocalServer,
  upstream: CodexUpstream,
  peer: RpcPeer,
  params: Record<string, unknown>,
  present: (ids: unknown[]) => string[],
): Promise<unknown> {
  const [native, owned] = await Promise.allSettled([
    upstream.request('thread/loaded/list', params),
    local.dispatch(peer, 'thread/loaded/list', params),
  ])
  const a = native.status === 'fulfilled' ? asRecord(native.value) : null
  const b = owned.status === 'fulfilled' ? asRecord(owned.value) : null
  const ids = [
    ...(Array.isArray(a?.data) ? a.data : []),
    ...(Array.isArray(b?.data) ? b.data : []),
  ].filter((id): id is string => typeof id === 'string')
  return { ...(a ?? b ?? {}), data: [...new Set(present(ids))] }
}
