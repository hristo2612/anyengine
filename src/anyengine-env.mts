// Preserve the launch's shell policy when extracting the PTY environment.
// Bounded children get a closed environment; full-access Bash keeps ordinary
// variables. Vendor routing and runtime injection controls stay filtered.
import { PTY_SCREEN_ENV } from './anyengine-screen.mjs'
import { claudeEnvironment } from './claude-environment.mjs'
import type { ShellMode } from './posture-claude.mjs'
export function ptyEnv(
  input: {
    hookUrl: string
    hookToken: string
    proxyPort: number | null
    shell?: ShellMode
    // Legacy option, ignored: credentials never come from the adapter environment.
    keepApiKey: boolean
  },
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = claudeEnvironment(input.shell, source)
  Object.assign(env, PTY_SCREEN_ENV)
  // Suppress the summary picker so --resume full-resumes.
  env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = '999999999'
  env.ANYENGINE_PTY_HOOK_URL = input.hookUrl
  env.ANYENGINE_PTY_HOOK_TOKEN = input.hookToken
  if (input.proxyPort !== null) {
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${input.proxyPort}`
    // The proxy forwards unchanged, so this still is a first-party session;
    // the CLI decides that by host string, and a loopback host would drop
    // the model's context ceiling to the 200K fallback.
    env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
  }
  return env
}
