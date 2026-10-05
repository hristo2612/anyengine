// The router and the GPT child's bridge attachment are selected before spawn.
// Routing Claude through that child also requires a current native proof;
// changing settings never reinterprets persisted local thread ownership.
import http from 'node:http'
import {
  anyengineRoot,
  type CodexClaudeMode,
  loadConfig,
  readConfig,
  routerBaseUrl,
} from './anyengine-config.mjs'
import { BRIDGE_LINE_GPT } from './bridge-instructions.mjs'
import { isProven, type ProofKey, proofKey, readDegraded, sameKey } from './degraded.mjs'
import { codexBinaryVersionCached, codexVersionCached } from './proof-versions.mjs'
import type { FanoutPath } from './router-fanout.mjs'
import { routerVersion } from './router-server.mjs'
import { debugLog } from './util.mjs'

export interface RouterLinkState {
  attached: boolean
  url: string | null
  fanout: FanoutPath
  reason: string
  checkedAt: string
}
interface RouterHealth {
  version: string
  mode: CodexClaudeMode
  fanout: { path: FanoutPath; reason: string }
  proofKey: ProofKey | null
}
let state: RouterLinkState = {
  attached: false,
  url: null,
  fanout: 'bridge',
  reason: 'not linked',
  checkedAt: '',
}
let root: string | null = null
let routerLib: string | null = null
let routerMode: CodexClaudeMode | null = null
let routerKey: ProofKey | null = null
let codexBinary: string | null = null

export function currentRouterLink(): RouterLinkState {
  return { ...state }
}
// Fixed for the child's life: an existing child cannot acquire an MCP server.
export function nativeFanout(): boolean {
  return state.attached && state.fanout === 'native'
}
export function routerServesClaude(): boolean {
  return (
    nativeFanout() &&
    root !== null &&
    loadConfig(root).modes.codexClaude === 'model' &&
    nativeProofReason() === null
  )
}
export function gptBridgeLine(bridgeAttached: boolean): string | null {
  return bridgeAttached && !nativeFanout() ? BRIDGE_LINE_GPT : null
}

// Codex applies the last assignment, including its attached short form.
export function appOpenaiBaseUrl(argv: string[]): string | null {
  let found: string | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    const value =
      arg === '-c' || arg === '--config'
        ? (argv[++i] ?? '')
        : (/^(?:--config=|-c=?)(.*)$/.exec(arg)?.[1] ?? '')
    const match = /^openai_base_url\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))\s*$/.exec(value)
    if (match) found = match[1] ?? match[2] ?? match[3] ?? ''
  }
  return found
}

function loopbackUrl(text: string): string | null {
  try {
    const url = new URL(text)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      /[?#]/.test(text) ||
      url.pathname !== '/backend-api/codex'
    )
      return null
    return `${url.origin}${url.pathname}`
  } catch {
    return null
  }
}

function readHealth(body: string): RouterHealth | null {
  try {
    const value = JSON.parse(body)
    if (
      value?.ok !== true ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.version !== 'string' ||
      !value.version ||
      !['agent', 'model'].includes(value.mode) ||
      value.faults?.hookErrors !== 0 ||
      value.faults?.unhandledRejections !== 0 ||
      !['native', 'bridge'].includes(value.fanout?.path)
    )
      return null
    const upstream = value.upstream
    if (upstream?.lastError && (!upstream.lastOkAt || upstream.lastErrorAt >= upstream.lastOkAt))
      return null
    return {
      version: value.version,
      mode: value.mode,
      proofKey: sameKey(value.proofKey, value.proofKey)
        ? {
            lib: value.proofKey.lib,
            appVersion: value.proofKey.appVersion,
            codexVersion: value.proofKey.codexVersion,
            settings: value.proofKey.settings,
          }
        : null,
      fanout: {
        path: value.fanout.path,
        reason: typeof value.fanout.reason === 'string' ? value.fanout.reason : '',
      },
    }
  } catch {
    return null
  }
}

async function health(url: string, timeoutMs: number): Promise<RouterHealth | null> {
  return new Promise((done) => {
    // A dedicated connection avoids proxy settings; redirects are never followed.
    const request = http.get(
      url.replace(/\/backend-api\/codex$/, '/health'),
      {
        agent: false,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        if (response.statusCode !== 200) {
          request.destroy()
          done(null)
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 64 * 1024) request.destroy()
          else chunks.push(chunk)
        })
        response.once('end', () => done(readHealth(Buffer.concat(chunks).toString('utf8'))))
        response.once('error', () => done(null))
      },
    )
    request.once('error', () => done(null))
  })
}

function routerDegradedReason(): string | null {
  if (!root) return 'invalid router root'
  const paths = readDegraded(root).paths
  const marker =
    paths.router ??
    (paths['native-fanout']?.since === 'unknown' ? paths['native-fanout'] : undefined)
  return marker ? `the smoke marked the router degraded: ${marker.reason}` : null
}

function nativeProofReason(): string | null {
  if (!root) return 'invalid router root'
  const { config, errors } = readConfig(root)
  if (errors.length) return 'invalid router configuration'
  if (!config.router.enabled || !config.router.multiAgentV1)
    return 'native router settings disabled'
  if (routerMode !== config.modes.codexClaude)
    return 'router Claude mode differs from adapter settings'
  const routerDegraded = routerDegradedReason()
  if (routerDegraded) return routerDegraded
  const degraded = readDegraded(root).paths['native-fanout']
  if (degraded) return `the smoke marked native fan-out degraded: ${degraded.reason}`
  const key = proofKey(root, {
    config: () => config,
    codexVersion: () =>
      codexBinary ? codexBinaryVersionCached(codexBinary) : codexVersionCached(),
  })
  const running = routerVersion()
  if (
    routerLib !== running ||
    running === '0.0.0-unknown' ||
    (key.lib !== null && key.lib !== running) ||
    !routerKey ||
    !sameKey(key, routerKey) ||
    !isProven(root, 'native-fanout', key)
  )
    return 'native fan-out is not proven for this running lib, app, codex and settings'
  return null
}

export async function linkRouter(
  argv: string[],
  options: {
    root?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    codexBinary?: string
  } = {},
): Promise<{ state: RouterLinkState; configArgs: string[] }> {
  const checkedAt = new Date().toISOString()
  let url: string | null = null
  const out = (
    attached: boolean,
    fanout: FanoutPath,
    reason: string,
    configArgs: string[] = [],
  ) => {
    state = { attached, url: attached ? url : null, fanout, reason, checkedAt }
    debugLog('router.link', { ...state })
    return { state: currentRouterLink(), configArgs }
  }
  root = null
  routerLib = null
  routerMode = null
  routerKey = null
  codexBinary = options.codexBinary ?? null
  try {
    const env = options.env ?? process.env
    root = options.root ?? anyengineRoot(env)
    const { config, errors } = readConfig(root)
    if (errors.length) return out(false, 'bridge', 'invalid router configuration')
    if (!config.router.enabled) return out(false, 'bridge', 'router.enabled is false')
    url = loopbackUrl((env.ANYENGINE_ROUTER_URL ?? '').trim() || routerBaseUrl(config))
    if (!url) return out(false, 'bridge', 'router URL must be a loopback Codex base URL')
    const fromApp = appOpenaiBaseUrl(argv)
    if (fromApp !== null && loopbackUrl(fromApp) !== url)
      return out(false, 'bridge', 'the app passes its own openai_base_url')
    const degraded = routerDegradedReason()
    if (degraded) return out(false, 'bridge', degraded)
    const timeoutMs = Math.min(500, options.timeoutMs ?? 500)
    const answer = await health(url, timeoutMs)
    if (!answer)
      return out(false, 'bridge', `the router did not answer healthy within ${timeoutMs} ms`)
    const current = readConfig(root)
    if (current.errors.length) return out(false, 'bridge', 'invalid router configuration')
    if (!current.config.router.enabled) return out(false, 'bridge', 'router.enabled is false')
    const afterHealth = routerDegradedReason()
    if (afterHealth) return out(false, 'bridge', afterHealth)
    routerLib = answer.version
    routerMode = answer.mode
    routerKey = answer.proofKey
    const reason = answer.fanout.path === 'native' ? nativeProofReason() : answer.fanout.reason
    const fanout = answer.fanout.path === 'native' && reason === null ? 'native' : 'bridge'
    return out(
      true,
      fanout,
      reason ?? answer.fanout.reason,
      fromApp !== null ? [] : ['-c', `openai_base_url="${url}"`],
    )
  } catch {
    return out(false, 'bridge', 'router configuration or health is unavailable')
  }
}
