// Operator entry: retain Claude's normal environment, settings sources and TTY.
// Adapter child sandboxing is deliberately not used for an interactive session.
import { delimiter, resolve } from 'node:path'
import { readConfig } from './anyengine-config.mjs'
import { isExecutableFile } from './bundled-codex.mjs'
import type { Command } from './control-cli.mjs'

export const CLAUDE_LAUNCH_USAGE = `usage: anyengine claude [--native | --routed] [-- CLAUDE_ARGS...]
  Native is the default for this command; bare claude is unchanged.
  --native  Use Anthropic directly for this session.
  --routed  Retain the installed Claude/GPT routing.
  Interactive Remote Control: anyengine claude -- --remote-control
  Native mode reserves --settings; other Claude settings sources remain enabled.
`
const OFFICIAL_SETTINGS = '{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}'

// Inspect reserved flags and the first command. Known option values stay opaque,
// including command-like strings. Other Claude flags are forwarded unchanged.
const VALUE_FLAGS = new Set([
  '--add-dir',
  '--agent',
  '--agents',
  '--allowedTools',
  '--allowed-tools',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--betas',
  '--debug-file',
  '--disallowedTools',
  '--disallowed-tools',
  '--effort',
  '--fallback-model',
  '--from-pr',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--max-turns',
  '--mcp-config',
  '--model',
  '--output-format',
  '--permission-mode',
  '--permission-prompt-tool',
  '--plugin-dir',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--system-prompt',
  '--system-prompt-file',
  '--tools',
])

const OPTIONAL_VALUE_FLAGS = new Set([
  '--debug',
  '-d',
  '--remote-control',
  '--rc',
  '--resume',
  '-r',
  '--worktree',
  '-w',
])

export interface ClaudeLaunchPlan {
  mode: 'native' | 'routed'
  args: string[]
}
export function planClaudeLaunch(argv: readonly string[]): ClaudeLaunchPlan | null {
  let mode: ClaudeLaunchPlan['mode'] = 'native'
  let selected = false
  let offset = 0
  for (; offset < argv.length; offset++) {
    const arg = argv[offset]
    if (arg === '--') {
      offset++
      break
    }
    if (arg === '--native' || arg === '--routed') {
      if (selected) throw new Error('choose exactly one of --native or --routed')
      selected = true
      mode = arg === '--native' ? 'native' : 'routed'
    } else if ((arg === '--help' || arg === '-h') && offset === argv.length - 1) {
      return null
    } else break
  }
  const args = argv.slice(offset)
  validateClaudeArguments(args, mode)
  return {
    mode,
    args: mode === 'native' ? ['--settings', OFFICIAL_SETTINGS, ...args] : args,
  }
}

function validateClaudeArguments(args: readonly string[], mode: ClaudeLaunchPlan['mode']): void {
  let positional = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) break
    if (arg === '--') break
    const equals = arg.indexOf('=')
    const flag = equals < 0 ? arg : arg.slice(0, equals)
    const value = equals < 0 ? args[i + 1] : arg.slice(equals + 1)
    if (!arg.startsWith('-') && !positional) {
      positional = true
      if (arg === 'remote-control')
        throw new Error(
          'standalone remote-control is not supported here; start interactive Claude with anyengine claude -- --remote-control',
        )
    }
    if (mode === 'native') {
      if (flag === '--settings')
        throw new Error(
          'native Claude reserves --settings for its official endpoint overlay; use --routed for custom --settings',
        )
      if (['--model', '--agent', '--fallback-model'].includes(flag) && /^gpt-/i.test(value ?? ''))
        throw new Error('GPT selections require anyengine claude --routed -- CLAUDE_ARGS')
    }
    if (
      equals < 0 &&
      (VALUE_FLAGS.has(flag) ||
        (OPTIONAL_VALUE_FLAGS.has(flag) && value !== undefined && !value.startsWith('-')))
    )
      i++
  }
}

export interface ClaudeLaunchDeps {
  execve: ((executable: string, argv: string[], env: NodeJS.ProcessEnv) => void) | undefined
}

function executable(configured: string | null): string {
  // execve does not search PATH. Keep its normal order, including empty/relative
  // entries, and use the existing regular-file/executable-access admission.
  const candidates = configured
    ? [configured]
    : (process.env.PATH ?? '/usr/bin:/bin').split(delimiter).map((dir) => resolve(dir, 'claude'))
  const selected = candidates.find(isExecutableFile)
  if (!selected) throw new Error('Claude executable unavailable')
  return selected
}

export function createClaudeLaunchCommand(
  deps: ClaudeLaunchDeps = { execve: process.execve?.bind(process) },
): Command {
  return async (args, _system, root, say) => {
    let plan: ClaudeLaunchPlan | null
    try {
      plan = planClaudeLaunch(args)
    } catch (error) {
      say(`claude: ${(error as Error).message}\n`)
      return 2
    }
    if (!plan) {
      say(CLAUDE_LAUNCH_USAGE)
      return 0
    }
    const { config, errors } = readConfig(root)
    if (errors.length) {
      say('claude: invalid AnyEngine configuration; inspect anyengine config\n')
      return 1
    }
    if (!deps.execve) {
      say('claude: direct launch requires process.execve on Node.js 24+ (macOS or Linux)\n')
      return 1
    }
    try {
      const file = executable(config.claude.cli)
      // Replace this process: no child or signal broker can duplicate terminal
      // signals. Keep cwd, the exact environment, standard descriptors and argv.
      deps.execve(file, [file, ...plan.args], process.env)
      return 0 // Injected unit executors return; successful OS execve never does.
    } catch {
      // Lookup/exec errors can include argv. Never print prompts or environment.
      say('claude: could not start the configured executable; check claude.cli and PATH\n')
      return 1
    }
  }
}

export const claudeLaunchCommand = createClaudeLaunchCommand()
