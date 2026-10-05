// Which way mixed fan-out goes (spec 5.2 fallback): native Codex spawn_agent
// with Claude children needs the v1 multi-agent tools, whose task text is
// plain; the v2 tools deliver it as OpenAI ciphertext a Claude child cannot
// read. Native unless the operator turned v1 marking off, the smoke marked
// native fan-out degraded, or the evidence says v1 is gone: the upstream
// catalog has an unsupported multi_agent_version, codex used the v2 collaboration
// tools on a model this router served as v1, the upstream rejected a request
// over it, or several spawned children of owned parents in a row found no
// adapter to claim them. Native also needs a proof for this lib, app, codex and
// settings (decision D18); without one the path is bridge. Evidence is sticky
// until the configuration changes, a newer proof arrives, or the router
// restarts: flapping would change the catalog under a running fan-out. For ten
// minutes after a start or a configuration change, v2 evidence is ignored: an
// adapter spawned earlier may still hold a catalog without the v1 marking.
import { readFileSync } from 'node:fs'
import { type AnyEngineConfig, enginePaths, writeJsonAtomic } from './anyengine-config.mjs'
import { isProven, proofKey, readDegraded, readProof } from './degraded.mjs'
import { isCatalogTemplate } from './router-catalog.mjs'
import { routerVersion } from './router-server.mjs'

export type FanoutPath = 'native' | 'bridge'
const V2_GRACE_MS = 10 * 60_000

export interface FanoutState {
  path: FanoutPath
  reason: string
  since: string
}

export interface RouterStatusFile {
  pid: number
  version: string
  port: number
  startedAt: string
  mode: string
  fanout: FanoutState
  writtenAt: string
}

type Tool = Record<string, unknown>

function toolsOf(body: Record<string, unknown>): Tool[] {
  const out: Tool[] = []
  if (Array.isArray(body.tools)) out.push(...(body.tools as Tool[]))
  if (Array.isArray(body.input)) {
    for (const item of body.input as Tool[]) {
      if (item?.type === 'additional_tools' && Array.isArray(item.tools))
        out.push(...(item.tools as Tool[]))
    }
  }
  return out
}

function walk(
  tools: Tool[],
  visit: (tool: Tool, namespace: string | null) => boolean,
  ns: string | null = null,
): boolean {
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      if (walk(tool.tools as Tool[], visit, String(tool.name ?? ''))) return true
    } else if (visit(tool, ns)) return true
  }
  return false
}

export function usesV2Collaboration(body: Record<string, unknown>): boolean {
  return walk(toolsOf(body), (tool, ns) => {
    const name = String(tool.name ?? '')
    const collaboration = ns === 'collaboration' || name.startsWith('collaboration.')
    return collaboration && JSON.stringify(tool.parameters ?? {}).includes('"encrypted":true')
  })
}

export function usesV1MultiAgent(body: Record<string, unknown>): boolean {
  return walk(toolsOf(body), (tool) =>
    String(tool.description ?? '').includes('multi_agent_v1__spawn_agent'),
  )
}

export class FanoutMonitor {
  private readonly config: () => AnyEngineConfig
  private readonly root: string | null
  private readonly onChange: ((state: FanoutState) => void) | null
  private readonly startedAt = new Date().toISOString()
  private evidence: FanoutState | null = null
  private served = new Set<string>()
  private unclaimedInARow = 0
  private readonly clock: () => number
  private windowFrom: number
  private windowConfig: string
  private proofAt = ''
  private lastPath: FanoutPath = 'native'
  private noTemplate = false

  constructor(
    config: () => AnyEngineConfig,
    root: string | null,
    onChange?: (state: FanoutState) => void,
    clock: () => number = Date.now,
  ) {
    this.config = config
    this.root = root
    this.onChange = onChange ?? null
    this.clock = clock
    this.windowFrom = clock()
    this.windowConfig = this.configKey()
  }

  // Evidence holds for the configuration it was seen under: a change to the
  // router or Claude settings (a v1 toggle, new models) starts clean.
  private configKey(): string {
    const cfg = this.config()
    return JSON.stringify([cfg.router, cfg.claude, cfg.modes, cfg.claims])
  }

  get state(): FanoutState {
    const state = this.readState()
    if (this.lastPath === 'bridge' && state.path === 'native') this.windowFrom = this.clock()
    this.lastPath = state.path
    return state
  }

  private readState(): FanoutState {
    this.refreshEvidence()
    if (this.noTemplate)
      return {
        path: 'bridge',
        reason: 'no listed upstream catalog template',
        since: this.startedAt,
      }
    const cfg = this.config()
    if (!cfg.router.multiAgentV1) {
      return { path: 'bridge', reason: 'router.multiAgentV1 is false', since: this.startedAt }
    }
    const degraded = this.root ? readDegraded(this.root).paths['native-fanout'] : undefined
    if (degraded)
      return {
        path: 'bridge',
        reason: `the smoke marked native fan-out degraded: ${degraded.reason}`,
        since: degraded.since,
      }
    const key = this.root ? proofKey(this.root, { config: this.config }) : null
    if (
      this.root &&
      key &&
      ((key.lib !== null && key.lib !== routerVersion()) ||
        !isProven(this.root, 'native-fanout', key))
    ) {
      return {
        path: 'bridge',
        reason: 'native fan-out is not proven for this lib, app, codex and settings',
        since: this.startedAt,
      }
    }
    return this.evidence ?? { path: 'native', reason: 'catalog marked v1', since: this.startedAt }
  }

  // Evidence ends with the configuration it was seen under, or when a proof
  // newer than it arrives (the smoke passed again since).
  private refreshEvidence(): void {
    const key = this.configKey()
    const proof = this.root ? readProof(this.root, 'native-fanout') : null
    const newerProof = proof !== null && proof.at > this.proofAt
    const changed = key !== this.windowConfig
    if (changed || newerProof) {
      this.evidence = null
      this.unclaimedInARow = 0
    }
    if (changed) {
      this.windowConfig = key
      this.windowFrom = this.clock()
    }
    if (newerProof) this.proofAt = proof.at
  }

  private inV2Grace(): boolean {
    this.refreshEvidence()
    return this.clock() - this.windowFrom < V2_GRACE_MS
  }

  private flip(reason: string): void {
    if (this.state.path === 'bridge') return
    this.evidence = { path: 'bridge', reason, since: new Date().toISOString() }
    this.lastPath = 'bridge'
    this.onChange?.(this.evidence)
  }

  noteServed(v1Slugs: string[]): void {
    this.served = new Set(v1Slugs)
  }

  observeCatalog(models: unknown[]): void {
    this.noTemplate = !models.some((model) => isCatalogTemplate(model, this.config()))
    const unsupported = models.some((model) => {
      if (!model || typeof model !== 'object') return false
      const version = (model as Record<string, unknown>).multi_agent_version
      // Codex defaults null/absent to v1. v2 is rewritten by the catalog;
      // only an explicit unknown version is evidence of incompatible wire.
      return version != null && version !== 'v1' && version !== 'v2'
    })
    if (unsupported) this.flip('the upstream catalog has an unsupported multi_agent_version')
  }

  // Only a model this router served as v1 is evidence (M5): its v2 tools
  // mean codex ignored the rewrite.
  observeGptBody(body: Record<string, unknown>): void {
    if (typeof body.model !== 'string' || !this.served.has(body.model)) return
    if (this.state.path !== 'native' || this.inV2Grace()) return
    if (usesV2Collaboration(body))
      this.flip('codex used the v2 collaboration tools although the catalog said v1')
  }

  observeUpstreamError(status: number, text: string): void {
    if (status === 400 && /multi_agent|collaboration/i.test(text))
      this.flip('the upstream rejected multi-agent collaboration (HTTP 400)')
  }

  observeClaim(claimed: boolean): void {
    if (this.state.path !== 'native') return
    this.unclaimedInARow = claimed ? 0 : this.unclaimedInARow + 1
    const threshold = this.config().claims.unclaimedFlipThreshold
    if (this.unclaimedInARow >= threshold)
      this.flip(`${this.unclaimedInARow} Claude turns in a row that no adapter claimed`)
  }
}

export function writeRouterStatus(root: string, status: RouterStatusFile): void {
  try {
    writeJsonAtomic(enginePaths(root).routerStatus, status)
  } catch {}
}

export function readRouterStatus(root: string): RouterStatusFile | null {
  try {
    return JSON.parse(readFileSync(enginePaths(root).routerStatus, 'utf8')) as RouterStatusFile
  } catch {
    return null
  }
}
