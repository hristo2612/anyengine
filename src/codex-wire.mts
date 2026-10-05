// What the router reads from a Codex request to its model backend (the
// Responses API under /backend-api/codex). Captured from the bundled codex by
// scripts/capture-codex-wire.mjs (root threads) and
// scripts/capture-codex-spawn.mjs (spawned children);
// test/fixtures/codex-wire-<version>.json and codex-spawn-<version>.json are
// the evidence. Every reader tolerates junk and returns null rather than
// throwing: a request the router cannot place is relayed, never dropped.
//
// Headers belong to the connection, the body to the request. Over HTTP the
// two agree. Over a WebSocket, codex sends its headers once, at the upgrade,
// and every turn after that as a response.create frame on the same socket: a
// socket opened for a prewarm keeps `request_kind: prewarm` and an empty turn
// id in its headers, and one opened by a reconnect keeps the turn that opened
// it. So what a request says about its own turn comes from its body first
// (client_metadata and the copy of the turn metadata codex puts there), and
// from the headers only when the body says nothing.

export type HeaderBag = Record<string, string | string[] | undefined>

export interface TurnMetadata {
  threadId: string | null
  turnId: string | null
  sessionId: string | null
  agentName: string | null
  requestKind: string | null
  sandboxMode: string | null
  model: string | null
}

type Body = Record<string, unknown> | null

export function headerValue(headers: HeaderBag, name: string): string | null {
  const raw = headers[name.toLowerCase()]
  const value = Array.isArray(raw) ? raw[0] : raw
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return record(raw)
  try {
    return record(JSON.parse(raw))
  } catch {
    return {}
  }
}

function clientMetadata(body: Body): Record<string, unknown> {
  return record(body?.client_metadata)
}

// The copy of x-codex-turn-metadata codex puts in the body's client_metadata.
function bodyMetadata(body: Body): Record<string, unknown> {
  return parseMetadata(clientMetadata(body)['x-codex-turn-metadata'])
}

function readMetadata(meta: Record<string, unknown>): TurnMetadata {
  return {
    threadId: text(meta.thread_id),
    turnId: text(meta.turn_id),
    sessionId: text(meta.session_id),
    agentName: text(meta.agent_name),
    requestKind: text(meta.request_kind),
    sandboxMode: text(meta.sandbox_mode),
    model: text(meta.model),
  }
}

// The body's copy of the turn metadata, else the x-codex-turn-metadata header
// (a JSON string). One or the other as a whole, never a mix of the two.
export function turnMetadata(headers: HeaderBag, body: Body): TurnMetadata {
  const fromBody = bodyMetadata(body)
  if (Object.keys(fromBody).length > 0) return readMetadata(fromBody)
  return readMetadata(parseMetadata(headerValue(headers, 'x-codex-turn-metadata')))
}

// A spawned child's request names its own thread in `thread-id`,
// `x-client-request-id`, `x-codex-window-id` (`<thread>:<n>`), its turn
// metadata's thread_id and client_metadata.thread_id, but its `session-id`
// and prompt_cache_key are its root's (the parent's). Those two are last
// resorts here, never reached while a request carries `thread-id` or either
// thread_id, as every recorded one does.
export function threadIdOfRequest(headers: HeaderBag, body: Body): string | null {
  return (
    headerValue(headers, 'thread-id') ??
    turnMetadata(headers, body).threadId ??
    text(clientMetadata(body).thread_id) ??
    headerValue(headers, 'session-id') ??
    text(body?.prompt_cache_key)
  )
}

// A body that says anything about its turn is the only word on it: a prewarm
// frame's empty turn id is no turn, even on a socket whose headers name one.
export function turnIdOfRequest(headers: HeaderBag, body: Body): string | null {
  const client = clientMetadata(body)
  const fromBody = bodyMetadata(body)
  if (Object.keys(fromBody).length > 0 || 'turn_id' in client) {
    return text(fromBody.turn_id) ?? text(client.turn_id)
  }
  return turnMetadata(headers, null).turnId ?? headerValue(headers, 'turn-id')
}

// A spawned child's parent: the body's client_metadata, then the header.
// Confirmed on 0.159 (test/fixtures/codex-spawn-0.159.0.json): a child sends
// `x-codex-parent-thread-id` in both, over HTTP and on its WebSocket (the
// upgrade headers, and client_metadata of every frame, the prewarm
// included), next to `x-openai-subagent: collab_spawn` and the turn
// metadata's `parent_thread_id`; a root thread sends none of them.
export function parentThreadIdOfRequest(headers: HeaderBag, body: Body = null): string | null {
  return (
    text(clientMetadata(body)['x-codex-parent-thread-id']) ??
    headerValue(headers, 'x-codex-parent-thread-id')
  )
}

// A prewarm asks for no output: a `generate: false` frame (the one codex
// sends first on a new socket), or a request whose own metadata says so. The
// headers decide only for the WebSocket upgrade itself, which has no body.
export function isPrewarm(headers: HeaderBag, body: Body): boolean {
  if (body) return body.generate === false || text(bodyMetadata(body).request_kind) === 'prewarm'
  return turnMetadata(headers, null).requestKind === 'prewarm'
}

// The model a WebSocket upgrade is for: the routing hint, else the turn
// metadata's model. 0.159 sends the hint (`model=<slug>`) under a ChatGPT
// login (codex-spawn fixture) and none under an API key (codex-wire
// fixture).
export function modelHint(headers: HeaderBag): string | null {
  const hint = headerValue(headers, 'x-codex-routing-hint')
  const match = hint ? /(?:^|;)\s*model=([\w.[\]-]+)/.exec(hint) : null
  return match?.[1] ?? turnMetadata(headers, null).model
}

// Parent turn uses the same body-first metadata boundary as the child turn.
export function parentTurnIdOfRequest(headers: HeaderBag, body: Body = null): string | null {
  const fromBody = bodyMetadata(body)
  const meta = Object.keys(fromBody).length
    ? fromBody
    : parseMetadata(headerValue(headers, 'x-codex-turn-metadata'))
  return text(meta.parent_turn_id)
}
