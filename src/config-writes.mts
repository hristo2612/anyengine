// The app's model picker writes `model` with config/batchWrite or
// config/value/write. Forwarded as they are, codex puts whatever the app picked
// into the user's config.toml, which every terminal `codex` reads too; a
// terminal codex with no -m then asks OpenAI for `sonnet`. A pick codex cannot
// serve itself stays here instead (app-model-pick.json) and is laid over
// config/read, so the app still shows it; a GPT pick goes to codex and clears
// ours. The switch-on seeds this file from the line it removes (Task 24).
//
// codex 0.159 versions the user config.toml by a hash of its contents and
// refuses a write whose expectedVersion is stale (configVersionConflict). A
// pick kept here writes nothing, so it is answered with the file's current
// version, and whatever else the write carried goes to codex with the app's
// expectedVersion untouched. codex applies a batch all or nothing, so a pick
// split off a forwarded write is kept (or cleared) only once codex accepts
// the rest. The pick is shown only where the user config.toml would win: a
// key a trusted project, a --profile or -c flag, or a legacy
// managed_config.toml layer set keeps codex's answer.

import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { jsonAt, object } from './control-layer-state.mjs'
import { observeRequirementSources } from './requirements-reads.mjs'
import type { RpcPeer, WireMessage } from './types.mjs'
import { adapterHome, debugLog, ensureParent, isCodexOpenAiModel } from './util.mjs'

export const CONFIG_WRITE_METHODS: ReadonlySet<string> = new Set([
  'config/value/write',
  'config/batchWrite',
])

// `model` or `review_model` at the top level, the only keys the pick file
// holds. codex 0.159 refuses every `profiles.*` write (legacy profile tables
// can no longer be written), so a profile's model goes to codex as sent and
// its refusal reaches the app.
const MODEL_KEY = /^(?:model|review_model)$/
// ConfigLayerSource::precedence() in
// codex-rs/app-server-protocol/src/protocol/v2/config.rs at rust-v0.159.0: a
// layer with a higher rank overrides a lower one. MDM and enterprise config are
// defaults the user config.toml overrides; the legacy managed_config.toml
// layers override everything.
const LAYER_RANK: Readonly<Record<string, number>> = {
  packagedDefaults: -10,
  mdm: 0,
  system: 10,
  enterpriseManaged: 15,
  user: 20, // 21 for a --profile layer
  project: 25,
  sessionFlags: 30,
  legacyManagedConfigTomlFromFile: 40,
  legacyManagedConfigTomlFromMdm: 50,
}
const USER_RANK = LAYER_RANK.user as number
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function appModelPickPath(): string {
  return join(adapterHome(), 'app-model-pick.json')
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export function staysLocal(edit: { keyPath: string; value: unknown }): boolean {
  if (!MODEL_KEY.test(edit.keyPath) || typeof edit.value !== 'string') return false
  const id = edit.value.trim()
  return id.length > 0 && !isCodexOpenAiModel(id)
}

export interface SplitWrite {
  // Params for the child, or null when nothing is left for it.
  forward: Record<string, unknown> | null
  // keyPath -> the adapter's pick; null clears it.
  picks: Record<string, string | null>
}

export function splitModelEdits(method: string, params: Record<string, unknown>): SplitWrite {
  const single = method === 'config/value/write'
  const edits = single ? [params] : Array.isArray(params.edits) ? params.edits.map(record) : []
  const picks: Record<string, string | null> = {}
  const kept: Record<string, unknown>[] = []
  for (const edit of edits) {
    const keyPath = String(edit.keyPath ?? '')
    if (staysLocal({ keyPath, value: edit.value })) {
      picks[keyPath] = String(edit.value).trim()
      continue
    }
    if (MODEL_KEY.test(keyPath)) picks[keyPath] = null
    kept.push(edit)
  }
  if (kept.length === 0 && Object.keys(picks).length > 0) return { forward: null, picks }
  // Nothing split off: the write goes to codex exactly as the app sent it.
  if (single || kept.length === edits.length) return { forward: params, picks }
  return { forward: { ...params, edits: kept }, picks }
}

export class AppModelPick {
  // Fields are declared and assigned in the constructor body: the build is
  // erasable-syntax only (tsconfig erasableSyntaxOnly, src/AGENTS.md), so no
  // parameter properties.
  readonly path: string

  constructor(path: string = appModelPickPath()) {
    this.path = path
  }

  // Model keys only: anything else in the file (a hand edit, an older
  // version's profile key) is never laid over what the app reads.
  read(): Record<string, string> {
    const parsed = jsonAt(this.path)
    if (parsed === undefined) return {}
    if (
      !object(parsed) ||
      ['model', 'review_model'].some(
        (key) => Object.hasOwn(parsed, key) && typeof parsed[key] !== 'string',
      )
    )
      throw new Error('invalid app model pick evidence')
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          MODEL_KEY.test(entry[0]) && typeof entry[1] === 'string',
      ),
    )
  }

  apply(picks: Record<string, string | null>): void {
    if (Object.keys(picks).length === 0) return
    const next: Record<string, string> = { ...this.read() }
    for (const [keyPath, id] of Object.entries(picks)) {
      if (!MODEL_KEY.test(keyPath)) continue
      if (id === null) delete next[keyPath]
      else next[keyPath] = id
    }
    if (Object.keys(next).length === 0) {
      rmSync(this.path, { force: true })
      return
    }
    ensureParent(this.path)
    const temp = `${this.path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.path)
  }

  // `origins` is config/read's own: a pick is laid over only where the key
  // came from the user config.toml, a layer below it, or nowhere.
  overlay(
    config: Record<string, unknown>,
    origins: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const picks = Object.entries(this.read()).filter(([keyPath]) =>
      userLayerWins(Object.hasOwn(origins, keyPath) ? origins[keyPath] : undefined),
    )
    if (picks.length === 0) return config
    const out = structuredClone(config)
    for (const [keyPath, id] of picks) setPath(out, keyPath.split('.'), id)
    return out
  }
}

// `origin` is the ConfigLayerMetadata of the layer that set a key, or
// undefined when none did. The pick stands in for a line in the user
// config.toml, so it shows over that file's own line (the same rank) and
// anything below it; a layer type this table does not know keeps codex's answer.
function userLayerWins(origin: unknown): boolean {
  if (origin == null) return true
  const name = record(record(origin).name)
  const type = String(name.type)
  if (!Object.hasOwn(LAYER_RANK, type)) return false
  const rank = type === 'user' && (name.profile ?? null) !== null ? USER_RANK + 1 : LAYER_RANK[type]
  return (rank as number) <= USER_RANK
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))

// Never walks into a prototype: an unsafe segment refuses the whole path, and
// only an own plain object is descended into.
function setPath(target: Record<string, unknown>, path: string[], value: string): void {
  if (path.length === 0 || path.some((key) => UNSAFE_KEYS.has(key))) return
  let node = target
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(node, key) || !isPlainObject(node[key])) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[path.at(-1) as string] = value
}

export interface ConfigChild {
  request(method: string, params: unknown): Promise<unknown>
}

export type WritePlan =
  // Forward `forward` through `peer(app)`: the child's own answer reaches the
  // app unchanged, and the split-off picks are kept only when it is a success.
  | { forward: Record<string, unknown>; peer: (peer: RpcPeer) => RpcPeer }
  | { answer: unknown }
  | { error: string }

export class ConfigWrites {
  private readonly child: ConfigChild
  private readonly pick: AppModelPick

  constructor(child: ConfigChild, pick: AppModelPick = new AppModelPick()) {
    this.child = child
    this.pick = pick
  }

  async plan(method: string, params: Record<string, unknown>): Promise<WritePlan> {
    const split = splitModelEdits(method, params)
    if (split.forward) {
      const picks = split.picks
      return {
        forward: split.forward,
        peer: (peer) => ({
          id: peer.id,
          send: (message: WireMessage) => {
            // codex has written the rest already; its answer goes out whatever
            // happens to our file.
            try {
              if (accepted(message)) this.keep(picks)
            } catch (error) {
              debugLog('config.modelPickFailed', { message: String(error) })
            }
            peer.send(message)
          },
          close: () => peer.close(),
        }),
      }
    }
    // Nothing is left for codex, so nothing is written: answer with the file's
    // current version, so the app's next expectedVersion still matches.
    try {
      const answer = await this.unchangedAnswer(params)
      this.keep(split.picks)
      return { answer }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { error: `anyengine: the model pick was not saved (${reason})` }
    }
  }

  private keep(picks: Record<string, string | null>): void {
    if (Object.keys(picks).length === 0) return
    this.pick.apply(picks)
    debugLog('config.modelPick', { picks })
  }

  // The user config.toml's layer (or the one the write names), as codex
  // reports it. codex's own answer to a write carries the same fields.
  private async unchangedAnswer(params: Record<string, unknown>): Promise<unknown> {
    const read = record(await this.child.request('config/read', { includeLayers: true }))
    const layers = Array.isArray(read.layers) ? read.layers.map(record) : []
    const wanted = typeof params.filePath === 'string' ? params.filePath : null
    const layer = layers.find((entry) => {
      const name = record(entry.name)
      return wanted ? name.file === wanted : name.type === 'user' && (name.profile ?? null) === null
    })
    if (!layer || typeof layer.version !== 'string')
      throw new Error('no version for the config file')
    return {
      status: 'ok',
      version: layer.version,
      filePath: record(layer.name).file,
      overriddenMetadata: null,
    }
  }

  // Moved from codex-mux.mts (mergeConfigRead), plus the overlay: the child's
  // config verbatim, the `claude-code` provider added so the desktop keeps a
  // home for the Claude models in its picker, the app's local pick laid over.
  async mergeRead(upstream: Promise<unknown>, local: Promise<unknown>): Promise<unknown> {
    const [upstreamSettled, localSettled] = await Promise.allSettled([upstream, local])
    const localResult = localSettled.status === 'fulfilled' ? record(localSettled.value) : null
    const localOrigins = record(localResult?.origins)
    if (upstreamSettled.status !== 'fulfilled') {
      if (!localResult) return {}
      return { ...localResult, config: this.pick.overlay(record(localResult.config), localOrigins) }
    }
    const upstreamResult = record(upstreamSettled.value)
    observeRequirementSources(upstreamResult)
    const config = record(upstreamResult.config)
    const origins = record(upstreamResult.origins)
    const claudeProvider = record(record(localResult?.config).model_providers)['claude-code']
    if (!claudeProvider) return { ...upstreamResult, config: this.pick.overlay(config, origins) }
    return {
      ...upstreamResult,
      config: this.pick.overlay(
        {
          ...config,
          model_providers: { ...record(config.model_providers), 'claude-code': claudeProvider },
        },
        origins,
      ),
      origins: {
        ...origins,
        ...(localOrigins['model_providers.claude-code']
          ? { 'model_providers.claude-code': localOrigins['model_providers.claude-code'] }
          : {}),
      },
    }
  }
}

// A JSON-RPC success: a result and no error.
function accepted(message: WireMessage): boolean {
  const response = record(message)
  return 'result' in response && response.error == null
}
