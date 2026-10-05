// The model-mode child cannot act outside Codex's own tool executor. A closed
// builtin list excludes even future tools; deny rules add a second guard.
import { execFile } from 'node:child_process'
import { claudeEnvironment } from './claude-environment.mjs'
import { DEFAULT_POSTURE } from './posture.mjs'
import { toClaudeLaunch } from './posture-claude.mjs'

export const CODEX_TOOLS_SERVER = 'codex'
export const TRAMPOLINE_BUILTINS: readonly string[] = Object.freeze(['ToolSearch'])
export const TRAMPOLINE_DENIED: readonly string[] = Object.freeze([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'ExitPlanMode',
  'Bash',
  'BashOutput',
  'KillShell',
  'KillBash',
  'Monitor',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'Task',
  'Agent',
  'TaskStop',
  'AskUserQuestion',
  'CronCreate',
  'CronDelete',
  'ScheduleWakeup',
  'SendMessage',
  'SendUserMessage',
  'PushNotification',
  'RemoteTrigger',
  'LSP',
  'Workflow',
  'EnterWorktree',
  'ExitWorktree',
  'Artifact',
  'Skill',
  'SlashCommand',
])
export interface ClaudeCapabilities {
  ok: boolean
  partial: boolean
  effort: boolean
  permissionPrompts: boolean
  tools: boolean
  restricted: boolean
  disableSlashCommands: boolean
}
const probes = new Map<string, ClaudeCapabilities>()

// A new vendor/environment variable is absent by default. Only basic process
// context is inherited; the two tool limits below are owned by this adapter.
export function trampolineEnv(descriptionLength = 2048): NodeJS.ProcessEnv {
  const env = claudeEnvironment()
  env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = String(Math.max(2048, descriptionLength))
  env.MCP_TOOL_TIMEOUT = String(24 * 60 * 60 * 1000)
  return env
}

// Only successful probes are cached: a timeout must not disable model mode
// until the router restarts. Bound the cache for callers rotating paths.
export function claudeCapabilities(claudePath: string): Promise<ClaudeCapabilities> {
  const known = probes.get(claudePath)
  if (known) return Promise.resolve({ ...known })
  return new Promise((resolve) => {
    execFile(
      claudePath,
      ['--help'],
      { env: trampolineEnv(), timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const help = `${stdout}${stderr}`
        if (error || !help.includes('--print')) {
          resolve({
            ok: false,
            partial: false,
            effort: false,
            permissionPrompts: false,
            tools: false,
            restricted: false,
            disableSlashCommands: false,
          })
          return
        }
        const caps = {
          ok: true,
          partial: help.includes('--include-partial-messages'),
          effort: help.includes('--effort'),
          permissionPrompts: help.includes('--permission-prompts'),
          tools: /--tools\b/.test(help),
          restricted: /--restricted\b/.test(help),
          disableSlashCommands: /--disable-slash-commands\b/.test(help),
        }
        if (probes.size >= 64) probes.delete(probes.keys().next().value ?? '')
        probes.set(claudePath, { ...caps })
        resolve(caps)
      },
    )
  })
}

export interface TrampolineLaunchInput {
  claudeModel: string
  effort: string | null
  planMode: boolean
  resume: string | null
  fork: boolean
  mcpConfig: { mcpServers: Record<string, unknown> }
  systemPrompt: string
  codexToolsOffered: boolean
  liveWebSearch?: boolean
  caps: ClaudeCapabilities
}
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

export function trampolineArgs(input: TrampolineLaunchInput): string[] {
  if (!input.caps.ok || !input.caps.tools)
    throw new Error('model mode needs a claude CLI with --tools')
  if (!input.caps.restricted) throw new Error('model mode needs --restricted')
  if (!input.caps.disableSlashCommands) throw new Error('model mode needs --disable-slash-commands')
  // Serialize once, then validate what will actually be passed (including
  // any toJSON transform). Config is built by us, never copied from a request.
  const config = JSON.stringify(input.planMode ? { mcpServers: {} } : input.mcpConfig)
  const decoded = JSON.parse(config)
  if (
    !decoded.mcpServers ||
    Object.keys(decoded).some((k) => k !== 'mcpServers') ||
    Object.keys(decoded.mcpServers).some((k) => k !== CODEX_TOOLS_SERVER)
  ) {
    throw new Error('model mode accepts only the codex MCP server')
  }
  // Apply the shared launch rules at the strictest posture, then tighten
  // further for model mode. No parent capability can relax this launch.
  const shared = toClaudeLaunch(
    { ...DEFAULT_POSTURE, plan: input.planMode },
    { sandboxExec: false, projectConfigChanged: true },
  )
  const denied = [...new Set([...TRAMPOLINE_DENIED, ...shared.disallowedTools])]
  const args = [
    '-p',
    '--restricted',
    '--disable-slash-commands',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    input.claudeModel,
    '--permission-mode',
    shared.permissionMode ?? 'default',
    '--tools',
    input.planMode
      ? ''
      : [...TRAMPOLINE_BUILTINS, ...(input.liveWebSearch === true ? ['WebSearch'] : [])].join(','),
    '--disallowedTools',
    denied.join(','),
    '--strict-mcp-config',
    '--mcp-config',
    config,
    '--setting-sources',
    'user',
    '--settings',
    JSON.stringify({ disableAllHooks: true, disableSkillShellExecution: true }),
    '--append-system-prompt',
    input.systemPrompt,
  ]
  if (input.codexToolsOffered && !input.planMode)
    args.push('--allowedTools', `mcp__${CODEX_TOOLS_SERVER}`)
  if (input.caps.partial) args.push('--include-partial-messages')
  if (input.caps.permissionPrompts) args.push('--permission-prompts', 'none')
  const effort = (input.effort ?? '').toLowerCase()
  if (input.caps.effort && EFFORTS.has(effort)) args.push('--effort', effort)
  if (input.resume) args.push('--resume', input.resume)
  if (input.fork) args.push('--fork-session')
  return args
}
