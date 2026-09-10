// Codex plugins, read straight off disk.
//
// The desktop app asks the app-server for the plugin catalog (`plugin/list`,
// `plugin/installed`, `plugin/read`, `plugin/skill/read`). The real Codex
// answers from `CODEX_HOME/config.toml` plus the materialised packages under
// `CODEX_HOME/plugins/cache/<marketplace>/<name>/<version>/`. anyengine used to
// answer "no marketplaces", and the app's Plugins pane treated the paired
// `plugin/installed` failure as "still loading" and re-polled every two
// seconds — the "Loading plugins…" spinner never settled.
//
// This module is deliberately a reader: it never writes config.toml and never
// installs anything. `enabled` blocks are matched with a line parser rather
// than a TOML dependency, because the only shape Codex ever writes is
//
//     [plugins."<name>@<marketplace>"]
//     enabled = true
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { codexHome } from './util.mjs'

export interface CodexPluginRef {
  name: string
  marketplace: string
}

export interface CodexPlugin extends CodexPluginRef {
  /** Newest materialised version directory name, or null when none exists. */
  version: string | null
  /** Absolute path of that version directory, or null. */
  dir: string | null
  enabled: boolean
  /** `interface` block of `.codex-plugin/plugin.json`, when present. */
  display: Record<string, unknown> | null
  description: string | null
  /** `mcpServers` of the package's `.mcp.json`, verbatim. */
  mcpServers: Record<string, unknown>
  /** Skill directory names under `<dir>/skills`. */
  skills: string[]
}

const PLUGIN_SECTION = /^\s*\[plugins\."([^"@]+)@([^"]+)"\]\s*$/
const ENABLED_LINE = /^\s*enabled\s*=\s*(true|false)\s*$/
const OTHER_SECTION = /^\s*\[/

/**
 * Plugin refs whose `enabled` is true in `<codexHome>/config.toml`. A section
 * with no `enabled` key, or `enabled = false`, is not returned: Codex only
 * loads a plugin that says true.
 */
export function enabledPluginRefs(home = codexHome()): CodexPluginRef[] {
  let body: string
  try {
    body = readFileSync(join(home, 'config.toml'), 'utf8')
  } catch {
    return []
  }
  const refs: CodexPluginRef[] = []
  let current: CodexPluginRef | null = null
  for (const line of body.split(/\r?\n/)) {
    const section = PLUGIN_SECTION.exec(line)
    if (section) {
      current = { name: section[1] ?? '', marketplace: section[2] ?? '' }
      continue
    }
    if (!current) continue
    const enabled = ENABLED_LINE.exec(line)
    if (enabled) {
      if (enabled[1] === 'true') refs.push(current)
      current = null
      continue
    }
    // Any other section header ends this block without an `enabled = true`.
    if (OTHER_SECTION.test(line)) current = null
  }
  return refs
}

// Version directories are `0.0.1+codex.20260910T002427Z`, `1.0.1000926` or an
// opaque hash. Compare the numeric runs so 1.0.10 sorts above 1.0.9, and fall
// back to a plain string compare for anything unnumbered. Newest first.
function compareVersions(a: string, b: string): number {
  const partsA = a
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number)
  const partsB = b
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number)
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
    const left = partsA[i] ?? -1
    const right = partsB[i] ?? -1
    if (left !== right) return right - left
  }
  return b.localeCompare(a)
}

function newestVersionDir(pluginRoot: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(pluginRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return null
  }
  if (entries.length === 0) return null
  return entries.sort(compareVersions)[0] ?? null
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function skillNames(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** Every enabled plugin, resolved to its newest materialised package. */
export function listCodexPlugins(home = codexHome()): CodexPlugin[] {
  const cacheRoot = join(home, 'plugins', 'cache')
  return enabledPluginRefs(home).map((ref) => {
    const pluginRoot = join(cacheRoot, ref.marketplace, ref.name)
    const version = newestVersionDir(pluginRoot)
    const dir = version ? join(pluginRoot, version) : null
    const manifest = dir ? readJson(join(dir, '.codex-plugin', 'plugin.json')) : null
    const mcpFile = dir ? readJson(join(dir, '.mcp.json')) : null
    const servers = mcpFile?.mcpServers
    const display = manifest?.interface
    return {
      ...ref,
      version: (typeof manifest?.version === 'string' ? manifest.version : version) ?? null,
      dir,
      enabled: true,
      display:
        display && typeof display === 'object' && !Array.isArray(display)
          ? (display as Record<string, unknown>)
          : null,
      description: typeof manifest?.description === 'string' ? manifest.description : null,
      mcpServers:
        servers && typeof servers === 'object' && !Array.isArray(servers)
          ? (servers as Record<string, unknown>)
          : {},
      skills: dir ? skillNames(dir) : [],
    }
  })
}

/**
 * `PluginMarketplaceEntry[]` for `plugin/list` / `plugin/installed`: one entry
 * per marketplace, each `PluginSummary` carrying only the fields the schema
 * requires plus the display block the pane renders.
 */
export function codexPluginMarketplaces(plugins: CodexPlugin[]): Array<Record<string, unknown>> {
  const byMarketplace = new Map<string, Array<Record<string, unknown>>>()
  for (const plugin of plugins) {
    const summaries = byMarketplace.get(plugin.marketplace) ?? []
    summaries.push(pluginSummary(plugin))
    byMarketplace.set(plugin.marketplace, summaries)
  }
  return [...byMarketplace.entries()].map(([name, summaries]) => ({
    name,
    interface: null,
    // A local marketplace has a file path; ours is the package cache, and the
    // pane only uses it to round-trip `plugin/read`.
    path: null,
    plugins: summaries,
  }))
}

export function pluginSummary(plugin: CodexPlugin): Record<string, unknown> {
  return {
    id: `${plugin.name}@${plugin.marketplace}`,
    name: plugin.name,
    enabled: plugin.enabled,
    installed: plugin.dir !== null,
    installPolicy: 'AVAILABLE',
    authPolicy: 'ON_USE',
    availability: 'AVAILABLE',
    source: plugin.dir
      ? { type: 'local', path: plugin.dir }
      : { type: 'local', path: join(codexHome(), 'plugins', 'cache') },
    version: plugin.version,
    localVersion: plugin.version,
    keywords: [],
    interface: plugin.display,
    shareContext: null,
  }
}

/** `PluginDetail` for `plugin/read`. */
export function pluginDetail(plugin: CodexPlugin): Record<string, unknown> {
  return {
    marketplaceName: plugin.marketplace,
    marketplacePath: null,
    summary: pluginSummary(plugin),
    description: plugin.description,
    skills: plugin.skills.map((name) => ({
      name,
      description: '',
      enabled: true,
      path: plugin.dir ? join(plugin.dir, 'skills', name) : null,
      shortDescription: null,
      interface: null,
    })),
    hooks: [],
    apps: [],
    appTemplates: [],
    scheduledTasks: [],
    shareUrl: null,
    mcpServers: Object.keys(plugin.mcpServers),
  }
}

export function findCodexPlugin(
  plugins: CodexPlugin[],
  name: string,
  marketplace: string | null = null,
): CodexPlugin | null {
  const bare = name.includes('@') ? name.slice(0, name.indexOf('@')) : name
  const suffix = name.includes('@') ? name.slice(name.indexOf('@') + 1) : marketplace
  return (
    plugins.find((p) => p.name === bare && (!suffix || p.marketplace === suffix)) ??
    plugins.find((p) => p.name === bare) ??
    null
  )
}

/** Contents of `<plugin>/skills/<skill>/SKILL.md`, or null. */
export function readPluginSkill(plugin: CodexPlugin, skillName: string): string | null {
  if (!plugin.dir) return null
  const path = join(plugin.dir, 'skills', skillName, 'SKILL.md')
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// The bundled `openai-*` marketplaces ship the desktop app's own runtime tools
// (a relative `./bin/...` launcher, ChatGPT.app's private node, an HTTP server
// behind a Codex-only token indirection). Those belong to the real Codex child,
// not to a `claude` or `grok` process, so only plugins from the user's own
// marketplaces are forwarded.
function forwardableMarketplace(marketplace: string): boolean {
  return !marketplace.startsWith('openai-')
}

// Codex accepts several transports; the engines anyengine drives take stdio
// servers only, and the command has to be a real absolute path because the
// child's cwd is the thread's, not the plugin's.
function forwardableServer(spec: Record<string, unknown>): boolean {
  if (typeof spec.type === 'string' && spec.type !== 'stdio') return false
  if (typeof spec.url === 'string') return false
  const command = spec.command
  if (typeof command !== 'string' || !command) return false
  if (!isAbsolute(command)) return false
  try {
    return statSync(command).isFile()
  } catch {
    return false
  }
}

/**
 * stdio MCP servers contributed by the user's enabled plugins, in the shape the
 * Claude CLI's `--mcp-config` and grok's ACP `mcpServers` both consume. `env` is
 * carried through verbatim — jinn's server only finds the right home because
 * `JINN_HOME` arrives that way.
 */
export function codexPluginMcpServers(plugins: CodexPlugin[]): Record<string, unknown> {
  const servers: Record<string, unknown> = {}
  for (const plugin of plugins) {
    if (!forwardableMarketplace(plugin.marketplace)) continue
    for (const [name, raw] of Object.entries(plugin.mcpServers)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const spec = raw as Record<string, unknown>
      if (!forwardableServer(spec)) continue
      if (name in servers) continue
      const env =
        spec.env && typeof spec.env === 'object' && !Array.isArray(spec.env)
          ? Object.fromEntries(
              Object.entries(spec.env as Record<string, unknown>)
                .filter(([, value]) => typeof value === 'string')
                .map(([key, value]) => [key, String(value)]),
            )
          : undefined
      servers[name] = {
        type: 'stdio',
        command: spec.command,
        args: Array.isArray(spec.args) ? spec.args.map(String) : [],
        ...(env ? { env } : {}),
      }
    }
  }
  return servers
}

export function codexPluginMcpEnabled(): boolean {
  return process.env.ANYENGINE_CODEX_PLUGIN_MCP !== '0'
}

/**
 * Merge plugin servers under the servers already in play. Anything the app or
 * the bridge contributed wins a name collision, so `anyengine` can never be
 * shadowed by a plugin that happens to pick the same name.
 */
export function withCodexPluginMcpServers(base: unknown, home = codexHome()): unknown {
  if (!codexPluginMcpEnabled()) return base
  let plugins: Record<string, unknown>
  try {
    plugins = codexPluginMcpServers(listCodexPlugins(home))
  } catch {
    return base
  }
  if (Object.keys(plugins).length === 0) return base
  // `ANYENGINE_MCP_SERVERS` may still be a path to a JSON file at this point.
  let value = base
  if (typeof value === 'string') {
    try {
      value = JSON.parse(readFileSync(value, 'utf8'))
    } catch {
      value = null
    }
  }
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  // A `{ mcpServers: {...} }` wrapper stays wrapped; a bare record stays bare.
  if (record.mcpServers && typeof record.mcpServers === 'object') {
    return {
      ...record,
      mcpServers: { ...plugins, ...(record.mcpServers as Record<string, unknown>) },
    }
  }
  return { ...plugins, ...record }
}
