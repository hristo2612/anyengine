import type { ShellMode } from './posture-claude.mjs'

// Bounded children keep Task 2c's closed process/relay environment.
const PROCESS_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TMPDIR',
  'TERM',
  'CLAUDE_CONFIG_DIR',
])

// Extra routing/auth and runtime controls, including unprefixed 2.1.287 knobs.
// Ordinary cloud credentials stay available to Bash; Claude's provider switches
// and provider-specific credentials/endpoints do not. See the Task 2d report.
const STEERING_KEYS = new Set([
  'CLAUDECODE',
  'AWS_BEARER_TOKEN_BEDROCK',
  'USE_LOCAL_OAUTH',
  'USE_STAGING_OAUTH',
  'LOCAL_BRIDGE',
  'SESSION_INGRESS_URL',
  'VOICE_STREAM_BASE_URL',
  'MCP_CLIENT_SECRET',
  'MCP_OAUTH_CLIENT_METADATA_URL',
  'MCP_OAUTH_CALLBACK_PORT',
  'MCP_PROXY_URL',
  'SDK_NATIVE_BIN',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_PATH',
  'NODE_USE_ENV_PROXY',
  'NODE_USE_SYSTEM_CA',
  'BUN_OPTIONS',
  'BUN_CONFIG_FILE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
])
const STEERING_PREFIX =
  /^(ANTHROPIC_|_*CLAUDE_|OPENAI_|CCR_|AGENT_PROXY_|SELF_HOSTED_RUNNER_|VERTEX_REGION_CLAUDE_|AWS_ENDPOINT_URL_BEDROCK|NODE_TLS_|LD_|DYLD_|OTEL_|BETA_TRACING_)/
const PROXY_KEY =
  /^(?:(?:HTTP|HTTPS|ALL|NO|GRPC)_PROXY|NO_GRPC_PROXY|GLOBAL_AGENT_(?:HTTP|HTTPS|NO)_PROXY|NPM_CONFIG_(?:(?:HTTP|HTTPS)_)?PROXY)$/i

// Strict by default: trampoline turns, probes and compaction never opt in.
// Full-access Bash has the operator's rights and needs their normal environment.
export function claudeEnvironment(
  mode: ShellMode = 'none',
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    const allowed =
      PROCESS_KEYS.has(key) || /^LC_[A-Z_]+$/.test(key) || key.startsWith('ANYENGINE_')
    const denied = STEERING_KEYS.has(key) || STEERING_PREFIX.test(key) || PROXY_KEY.test(key)
    if (
      value !== undefined &&
      (mode === 'bash' ? key === 'CLAUDE_CONFIG_DIR' || !denied : allowed)
    ) {
      env[key] = value
    }
  }
  return env
}
