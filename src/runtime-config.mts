import {
  providerLoopSelectionInputFromEnv,
  resolveProviderLoopSelection,
} from './provider-loop-selection.mjs'

export type RuntimeBackendType =
  | 'mock'
  | 'agent-sdk-sidecar'
  | 'agent-http'
  | 'agentapi'
  | 'claude-p'
  // codex-proxy = `codex exec --json` per turn. Selected per-thread when the
  // user picks a gpt-* model in the App's model dropdown.
  | 'codex-proxy'
  // anyengine = the interactive `claude` TUI driven inside a long-lived PTY per
  // thread (subscription-billed), with Claude Code hooks relayed back over
  // loopback HTTP. Ported from a prior interactive engine of ours.
  | 'anyengine'
  // grok = xAI's `grok agent stdio` (Agent Client Protocol) per thread.
  // Selected per-thread when the user picks a grok-* model in the App.
  | 'grok'

export interface RuntimeConfig {
  type: RuntimeBackendType
  http: {
    baseUrl: string
    useSse: boolean
    pollIntervalMs: number
    timeoutMs: number
    sendInterruptRaw: boolean
    manageBridge: boolean
    modeCommand: string
  }
  claudeP: {
    command: string
    extraArgs: string[]
    timeoutMs: number
    skipPermissions: boolean
    resume: boolean
    stopTimeoutRetries: number
  }
  anyengine: {
    cli: string
    cols: number
    rows: number
    turnTimeoutMs: number
    asyncSubagentTimeoutMs: number
    startupTimeoutMs: number
    streamProxy: boolean
    extraArgs: string[]
    hookTimeoutSec: number
    autoApproveSafetyPrompts: boolean
    keepApiKey: boolean
    stateDir: string | null
    relayScript: string | null
    nodeBinary: string
  }
  grok: {
    binary: string | null
    extraArgs: string[]
    turnTimeoutMs: number
    startupTimeoutMs: number
    idleExitMs: number
  }
}

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const explicit = normalizeRuntimeType(
    env.ANYENGINE_RUNTIME_TYPE ?? env.ANYENGINE_RUNTIME ?? env.ANYENGINE_BACKEND,
  )
  const selection = resolveProviderLoopSelection(providerLoopSelectionInputFromEnv(env, explicit))
  const type = selection.runtimeType

  return {
    type,
    http: {
      baseUrl: normalizeBaseUrl(
        env.ANYENGINE_HTTP_BASE_URL ??
          env.ANYENGINE_AGENT_HTTP_URL ??
          env.ANYENGINE_AGENTAPI_URL ??
          'http://127.0.0.1:3284',
      ),
      useSse: envFlag(env.ANYENGINE_HTTP_USE_SSE, true),
      pollIntervalMs: numericEnv(env.ANYENGINE_HTTP_POLL_MS, 500, 100, 60_000),
      timeoutMs: numericEnv(env.ANYENGINE_HTTP_TIMEOUT_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
      sendInterruptRaw: envFlag(env.ANYENGINE_HTTP_INTERRUPT_RAW, false),
      manageBridge: envFlag(env.ANYENGINE_HTTP_MANAGE_BRIDGE, false),
      modeCommand: env.ANYENGINE_MODE_COMMAND || 'claude-codex-mode',
    },
    claudeP: {
      command: env.ANYENGINE_CLAUDE_P_COMMAND || env.CLAUDE_P || 'claude-p',
      extraArgs: stringList(env.ANYENGINE_CLAUDE_P_ARGS),
      timeoutMs: numericEnv(env.ANYENGINE_CLAUDE_P_TIMEOUT_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
      skipPermissions: envFlag(env.ANYENGINE_CLAUDE_P_SKIP_PERMISSIONS, false),
      resume: envFlag(env.ANYENGINE_CLAUDE_P_RESUME, false),
      stopTimeoutRetries: numericEnv(env.ANYENGINE_CLAUDE_P_STOP_TIMEOUT_RETRIES, 1, 0, 5),
    },
    anyengine: {
      cli: env.ANYENGINE_CLI || 'claude',
      cols: numericEnv(env.ANYENGINE_PTY_COLS, 120, 40, 500),
      rows: numericEnv(env.ANYENGINE_PTY_ROWS, 40, 10, 200),
      turnTimeoutMs: numericEnv(
        env.ANYENGINE_PTY_TURN_TIMEOUT_MS,
        60 * 60_000,
        0,
        24 * 60 * 60_000,
      ),
      asyncSubagentTimeoutMs: numericEnv(
        env.ANYENGINE_PTY_ASYNC_SUBAGENT_TIMEOUT_MS,
        10 * 60_000,
        0,
        24 * 60 * 60_000,
      ),
      startupTimeoutMs: numericEnv(
        env.ANYENGINE_PTY_STARTUP_TIMEOUT_MS,
        30_000,
        1_000,
        10 * 60_000,
      ),
      streamProxy: envFlag(env.ANYENGINE_PTY_STREAM_PROXY, true),
      extraArgs: stringList(env.ANYENGINE_PTY_ARGS),
      hookTimeoutSec: numericEnv(env.ANYENGINE_PTY_HOOK_TIMEOUT_S, 3600, 30, 24 * 60 * 60),
      autoApproveSafetyPrompts: envFlag(env.ANYENGINE_PTY_AUTO_APPROVE_SAFETY_PROMPTS, true),
      keepApiKey: envFlag(env.ANYENGINE_PTY_KEEP_API_KEY, false),
      stateDir: env.ANYENGINE_PTY_STATE_DIR || null,
      relayScript: env.ANYENGINE_PTY_HOOK_RELAY || null,
      nodeBinary: env.ANYENGINE_PTY_NODE || process.execPath,
    },
    grok: {
      binary: env.ANYENGINE_GROK_BIN || env.GROK_BIN || null,
      extraArgs: stringList(env.ANYENGINE_GROK_ARGS),
      turnTimeoutMs: numericEnv(
        env.ANYENGINE_GROK_TURN_TIMEOUT_MS,
        60 * 60_000,
        0,
        24 * 60 * 60_000,
      ),
      startupTimeoutMs: numericEnv(
        env.ANYENGINE_GROK_STARTUP_TIMEOUT_MS,
        60_000,
        1_000,
        10 * 60_000,
      ),
      idleExitMs: numericEnv(env.ANYENGINE_GROK_IDLE_MS, 10 * 60_000, 0, 24 * 60 * 60_000),
    },
  }
}

export function normalizeRuntimeType(value: string | undefined): RuntimeBackendType | null {
  const raw = (value ?? '').trim().toLowerCase()
  if (!raw) return null
  switch (raw) {
    case 'mock':
      return 'mock'
    case 'sdk':
    case 'agent-sdk':
    case 'agent-sdk-sidecar':
    case 'sidecar':
    case 'cloud-agent-sdk':
      return 'agent-sdk-sidecar'
    case 'agent-sdk-socket':
    case 'socket':
    case 'runtime-socket':
      return 'agent-sdk-sidecar'
    case 'agent-http':
    case 'channels':
    case 'channel':
    case 'http-channel':
      return 'agent-http'
    case 'agentapi':
    case 'agent-api':
      return 'agentapi'
    case 'claude-p':
    case 'claudep':
    case 'pty-transcript':
      return 'claude-p'
    case 'codex-proxy':
    case 'codex-exec':
      // Per-thread codex-proxy passthrough. Distinct from the shim-level
      // 'codex' mode (which bypasses our adapter entirely) — codex-proxy
      // keeps the adapter daemon in the loop and forwards just the turn.
      return 'codex-proxy'
    case 'anyengine':
    case 'pty':
    case 'claude-pty':
    case 'interactive':
      return 'anyengine'
    case 'grok':
    case 'grok-agent':
    case 'grok-acp':
      return 'grok'
    default:
      throw new Error(`unknown ANYENGINE_RUNTIME_TYPE: ${value}`)
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback
  const raw = value.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function numericEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function stringList(value: string | undefined): string[] {
  if (!value || !value.trim()) return []
  const raw = value.trim()
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
  } catch {}
  return raw.split(/\s+/).filter(Boolean)
}
