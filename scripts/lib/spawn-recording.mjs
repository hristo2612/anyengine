// How capture-codex-spawn.mjs turns what one app-server pass saw (its
// notifications, and the requests the fake model backend received) into the
// fixture: ids as labels, and only what does not depend on scheduling.
//
// A pass is { parent, events: [{ at, method, params }], requests: [{ kind,
// at, path, headers, body, frames? }], reads: { [threadId]: thread/read
// answer } }.

export const record = (value) => (value && typeof value === 'object' ? value : {})
export const parseJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
const metadataOf = (raw) => record(typeof raw === 'string' ? parseJson(raw) : raw)
const sortedKeys = (value) => Object.keys(record(value)).sort()

export const threadOfEvent = (event) => event.params?.threadId ?? event.params?.thread?.id ?? null
export const isCollabItem = (item) => item?.type === 'collabAgentToolCall'
export const isSpawnItem = (item) => isCollabItem(item) && item?.tool === 'spawnAgent'

// The spawn item/completed that names `child`, if any.
export const linkEvent = (pass, child) =>
  pass.events.find(
    (e) =>
      e.method === 'item/completed' &&
      isSpawnItem(e.params?.item) &&
      e.params.item.receiverThreadIds?.includes(child),
  )

// The children in the order their spawn items completed.
export const spawnedChildren = (pass) =>
  pass.events
    .filter((e) => e.method === 'item/completed' && isSpawnItem(e.params?.item))
    .flatMap((e) => e.params.item.receiverThreadIds ?? [])

export const childRequestsOf = (pass, child) =>
  pass.requests.filter((r) => r.headers?.['thread-id'] === child)

// Whether the link reached the client before the child's first request (of
// any kind: an upgrade, a POST) reached the model backend.
export function linkBeforeFirstRequest(pass, child) {
  const link = linkEvent(pass, child)
  const first = childRequestsOf(pass, child)[0]
  return Boolean(link && first && link.at < first.at)
}

// Ids become labels: the parent PARENT; its children as `childLabel(i)`
// names them, in spawn order; a thread's turns TURN_<thread> (then _2, _3);
// a collab item <TOOL>_<n> (SPAWN_1, SENDINPUT_1, ...); a spawned agent's
// random nickname NICKNAME (exact matches only: it is a plain word); an
// empty id `empty`.
export function labelsFor(pass, childLabel) {
  const names = new Map()
  const nicknames = new Set()
  const turnsOf = new Map()
  const counts = new Map()
  const add = (id, label) => {
    if (typeof id === 'string' && id && !names.has(id)) names.set(id, label)
  }
  const label = (value) => {
    if (typeof value !== 'string') return value ?? null
    if (value === '') return 'empty'
    if (nicknames.has(value)) return 'NICKNAME'
    let text = value
    for (const [id, name] of names) text = text.split(id).join(name)
    return text
  }
  const deep = (value) => {
    if (Array.isArray(value)) return value.map(deep)
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)]))
    return label(value)
  }
  add(pass.parent, 'PARENT')
  const children = spawnedChildren(pass)
  children.forEach((id, i) => {
    add(id, childLabel(i))
  })
  // A thread the backend saw that no spawn item named, so a check can say so.
  for (const r of pass.requests) {
    const id = r.headers?.['thread-id']
    if (id && id !== pass.parent) add(id, `UNLINKED_${id.slice(-4)}`)
  }
  for (const e of pass.events) {
    const item = e.params?.item
    if (e.method === 'item/started' && isCollabItem(item) && !names.has(item.id)) {
      const tool = String(item.tool).toUpperCase()
      const n = (counts.get(tool) ?? 0) + 1
      counts.set(tool, n)
      add(item.id, tool === 'SPAWNAGENT' ? `SPAWN_${n}` : `${tool}_${n}`)
    }
    if (e.method === 'turn/started') {
      const id = e.params?.turn?.id
      const owner = label(threadOfEvent(e))
      if (typeof id === 'string' && id && !names.has(id)) {
        const n = (turnsOf.get(owner) ?? 0) + 1
        turnsOf.set(owner, n)
        names.set(id, n === 1 ? `TURN_${owner}` : `TURN_${owner}_${n}`)
      }
    }
  }
  for (const read of Object.values(pass.reads ?? {})) {
    const name = read?.result?.thread?.agentNickname
    if (typeof name === 'string' && name) nicknames.add(name)
  }
  return { label, deep, children }
}

// One notification, labelled: method, thread, turn, and for a collab item
// its type, id, tool, status, sender, receivers, model, effort and prompt.
// (agentsStates is left out: a spawned child's state at the link races its
// first turn.)
export function noteOf(e, labels) {
  const note = { method: e.method, threadId: labels.label(threadOfEvent(e)) }
  const turn = e.params?.turnId ?? e.params?.turn?.id
  if (turn) note.turnId = labels.label(turn)
  const item = e.params?.item
  if (item) {
    note.item = {
      type: item.type,
      id: labels.label(item.id),
      tool: item.tool,
      status: item.status,
      senderThreadId: labels.label(item.senderThreadId),
      receiverThreadIds: (item.receiverThreadIds ?? []).map(labels.label),
      model: item.model ?? null,
      reasoningEffort: item.reasoningEffort ?? null,
      prompt: item.prompt ?? null,
    }
  }
  if (e.method === 'thread/started') {
    note.parentThreadId = labels.label(e.params?.thread?.parentThreadId ?? null)
  }
  return note
}

// A child's own announcements: any thread/started for it, and its first
// turn/started.
function childNotes(pass, child, labels) {
  const started = pass.events.find(
    (e) => e.method === 'thread/started' && threadOfEvent(e) === child,
  )
  const turn = pass.events.find((e) => e.method === 'turn/started' && threadOfEvent(e) === child)
  return [started, turn].filter(Boolean).map((e) => noteOf(e, labels))
}

// The link notifications in canonical order, not in the order they arrived:
// the parent's own (its turn/started and its spawn items) as observed, which
// is their causal order, and after each spawn item/completed the
// announcements of the children it names. A child's own notifications race
// that item (on persisted threads its turn/started came up to ~10 ms before
// it), so where they arrived is not recorded.
export function canonicalNotifications(pass, labels, from = 0) {
  const notes = []
  for (const e of pass.events.slice(from)) {
    if (threadOfEvent(e) !== pass.parent) continue
    const own = e.method === 'turn/started' || isSpawnItem(e.params?.item)
    if (!own) continue
    notes.push(noteOf(e, labels))
    if (e.method === 'item/completed' && isSpawnItem(e.params.item)) {
      for (const child of e.params.item.receiverThreadIds ?? [])
        notes.push(...childNotes(pass, child, labels))
    }
  }
  return notes
}

// One child's link, in canonical order: its spawn item's start and
// completion, then its own announcements.
export function childLink(pass, child, labels) {
  const done = linkEvent(pass, child)
  const spawnId = done?.params?.item?.id
  const items = pass.events.filter(
    (e) => isSpawnItem(e.params?.item) && e.params.item.id === spawnId,
  )
  return [...items.map((e) => noteOf(e, labels)), ...childNotes(pass, child, labels)]
}

// What thread/read says about a child: whose it is and where it came from.
export function threadRead(pass, child, labels) {
  const thread = pass.reads?.[child]?.result?.thread
  if (!thread) return null
  return labels.deep({
    parentThreadId: thread.parentThreadId ?? null,
    model: thread.model ?? null,
    ephemeral: thread.ephemeral ?? null,
    agentNickname: thread.agentNickname ?? null,
    source: thread.source ?? null,
  })
}

// The tools of a request, namespaces flattened: [name, tool] pairs.
export function toolsOf(body) {
  const lite = (Array.isArray(body?.input) ? body.input : []).find(
    (item) => item?.type === 'additional_tools',
  )
  const flat = (tools) =>
    (Array.isArray(tools) ? tools : []).flatMap((tool) =>
      tool?.type === 'namespace' ? flat(tool.tools) : [[tool?.name ?? tool?.type, tool]],
    )
  return flat(lite?.tools ?? body?.tools)
}

const pick = (source, keys, labels) =>
  Object.fromEntries(
    keys.filter((k) => k in record(source)).map((k) => [k, labels.label(source[k])]),
  )
const METADATA_KEYS = [
  'thread_id',
  'session_id',
  'turn_id',
  'agent_name',
  'request_kind',
  'parent_thread_id',
  'parent_turn_id',
  'root_turn_id',
  'subagent_kind',
  'thread_source',
  'model',
]
const CLIENT_KEYS = [
  'thread_id',
  'session_id',
  'turn_id',
  'parent_turn_id',
  'root_turn_id',
  'x-codex-parent-thread-id',
  'x-openai-subagent',
]

// Headers whose value names a thread (or a window of one), as labels. The
// turn metadata is recorded field by field instead: it also carries ids no
// label covers (installation, context window).
function idHeaders(headers, labels) {
  return Object.fromEntries(
    Object.keys(headers)
      .sort()
      .filter((k) => k !== 'x-codex-turn-metadata' && typeof headers[k] === 'string')
      .filter((k) => labels.label(headers[k]) !== headers[k])
      .map((k) => [k, labels.label(headers[k])]),
  )
}

export function headersShape(headers, labels) {
  const meta = metadataOf(headers['x-codex-turn-metadata'])
  return {
    headerNames: sortedKeys(headers),
    threadIdHeader: labels.label(headers['thread-id'] ?? null),
    sessionIdHeader: labels.label(headers['session-id'] ?? null),
    parentThreadIdHeader: labels.label(headers['x-codex-parent-thread-id'] ?? null),
    subagentHeader: headers['x-openai-subagent'] ?? null,
    routingHintHeader: headers['x-codex-routing-hint'] ?? null,
    idHeaders: idHeaders(headers, labels),
    turnMetadataKeys: sortedKeys(meta),
    turnMetadata: pick(meta, METADATA_KEYS, labels),
  }
}

// The user messages of a request, labelled; the environment context (paths,
// date, time zone) as its tag alone.
function userTexts(body, labels) {
  return (Array.isArray(body?.input) ? body.input : [])
    .filter((i) => i?.type === 'message' && i?.role === 'user')
    .flatMap((i) => (Array.isArray(i.content) ? i.content : []))
    .map((c) => (typeof c?.text === 'string' ? c.text : null))
    .map((text) =>
      text?.startsWith('<environment_context>') ? '<environment_context>' : labels.label(text),
    )
}

const inputTypes = (body) =>
  (Array.isArray(body?.input) ? body.input : []).map(
    (i) => `${i?.type}${i?.role ? `:${i.role}` : ''}`,
  )

export function bodyShape(body, labels) {
  if (!body || typeof body !== 'object') return null
  const client = record(body.client_metadata)
  const meta = metadataOf(client['x-codex-turn-metadata'])
  return {
    keys: sortedKeys(body),
    model: body.model ?? null,
    generate: typeof body.generate === 'boolean' ? body.generate : null,
    promptCacheKey: labels.label(body.prompt_cache_key ?? null),
    clientMetadataKeys: sortedKeys(client),
    clientMetadata: pick(client, CLIENT_KEYS, labels),
    turnMetadata: pick(meta, METADATA_KEYS, labels),
    inputTypes: inputTypes(body),
    toolNames: toolsOf(body).map(([name, tool]) => `${tool?.type}:${name}`),
    lastUserText: userTexts(body, labels).at(-1) ?? null,
  }
}

// A child's POST, in brief: what a spawn shape changes about it.
export function briefRequest(r, labels) {
  const meta = metadataOf(r.headers['x-codex-turn-metadata'])
  const client = record(r.body?.client_metadata)
  return {
    model: r.body?.model ?? null,
    reasoningEffort: r.body?.reasoning?.effort ?? null,
    turn: labels.label(meta.turn_id ?? null),
    subagentHeader: r.headers['x-openai-subagent'] ?? null,
    parentThreadIdHeader: labels.label(r.headers['x-codex-parent-thread-id'] ?? null),
    routingHintHeader: r.headers['x-codex-routing-hint'] ?? null,
    clientMetadataParent: labels.label(client['x-codex-parent-thread-id'] ?? null),
    inputTypes: inputTypes(r.body),
    userTexts: userTexts(r.body, labels),
  }
}

export const isResponsesPost = (r) =>
  r.kind === 'http' && r.method === 'POST' && r.path === '/backend-api/codex/responses'

// The http child's upgrade (426) and its POST, in full.
export function httpChildRequest(pass, child, labels) {
  const mine = childRequestsOf(pass, child)
  const upgrade = mine.find((r) => r.kind === 'upgrade')
  const post = mine.find(isResponsesPost)
  if (!post) return null
  return {
    transport: 'http',
    websocketFirst: Boolean(upgrade),
    ...headersShape(post.headers, labels),
    contentEncoding: post.headers['content-encoding'] ?? null,
    body: bodyShape(post.body, labels),
  }
}

// A websocket child's socket: its upgrade headers and every frame on it.
export function socketOf(pass, child, labels) {
  const socket = childRequestsOf(pass, child).find((r) => r.kind === 'upgrade')
  if (!socket) return null
  return {
    child: labels.label(child),
    ...headersShape(socket.headers, labels),
    frames: socket.frames.map((f) => ({
      type: f.body?.type ?? null,
      ...bodyShape(f.body, labels),
    })),
  }
}
