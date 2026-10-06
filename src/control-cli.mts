// One registry for control commands. Importing it performs no Mac actions or
// filesystem writes. Later tasks register their complete command handlers.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  anyengineRoot,
  CONFIG_KEYS,
  enginePaths,
  getConfigValue,
  readConfig,
  setConfigValue,
} from './anyengine-config.mjs'
import { cleanModelsCache, inspectModelsCache } from './control-cache.mjs'
import { formatStatus, gatherStatus } from './control-status.mjs'
import { realSystem, type System } from './control-system.mjs'
import { codexHome } from './util.mjs'

export type Say = (text: string) => void
export type Command = (args: string[], system: System, root: string, say: Say) => Promise<number>
export const CONTROL_COMMANDS: ReadonlySet<string> = new Set([
  'on',
  'off',
  'restart',
  'rollback',
  'status',
  'doctor',
  'mode',
  'config',
  'cache',
  'smoke',
  'codex',
  'accounts',
  'limits',
  'sessions',
  'desktop',
])
const USAGE = `usage: anyengine <command>
  status [--json]
  mode [codex-claude agent|model]
  config [get KEY | set KEY VALUE]
  cache clean [--dry-run]
  rollback m2 [--no-restart]
  accounts add|list|use|rotate|recover
  limits [--json] [--refresh]
  sessions on|off|status|list|search|show|open|sync
  desktop on|off|status
  on | off | restart | doctor | smoke | codex (require their registered implementation)
`
const SETTINGS_NOTE =
  'The child router/proof key and bridge MCP metadata are fixed at spawn. Settings/proof drift stops native Claude eligibility until a new attachment; restart the adapter to refresh its router and bridge MCP metadata.\n'
const PROOF_NOTE =
  'native fan-out must be proven again: anyengine smoke --paths native-fanout (when smoke is available).\n'
const shapesProof = /^(router\.multiAgentV1|modes\.|claude\.models|claude\.spawnPriority|claims\.)/
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const usage = (say: Say, text: string) => {
  say(`${text}\n`)
  return 2
}
function configErrors(root: string, say: Say) {
  const read = readConfig(root)
  for (const error of read.errors) say(`error: ${error}\n`)
  return read
}
function set(root: string, key: string, value: string, say: Say): number {
  try {
    const config = setConfigValue(root, key, value)
    say(`${key} = ${JSON.stringify(getConfigValue(config, key))}\n`)
    if (shapesProof.test(key)) say(PROOF_NOTE)
    say(SETTINGS_NOTE)
    return 0
  } catch (error) {
    say(`${message(error)}\n`)
    return (error as NodeJS.ErrnoException).code ? 1 : 2
  }
}
const status: Command = async (args, system, root, say) => {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json'))
    return usage(say, 'usage: anyengine status [--json]')
  const report = await gatherStatus(system, root)
  say(args[0] === '--json' ? `${JSON.stringify(report, null, 2)}\n` : formatStatus(report))
  return report.configErrors.length || report.inspectionErrors.length ? 1 : 0
}
const mode: Command = async (args, _system, root, say) => {
  if (args.length === 0) {
    const { config, errors } = configErrors(root, say)
    say(`codex-claude: ${config.modes.codexClaude} (saved settings)\n`)
    return errors.length ? 1 : 0
  }
  if (
    args.length !== 2 ||
    args[0] !== 'codex-claude' ||
    !['agent', 'model'].includes(args[1] ?? '')
  )
    return usage(say, 'usage: anyengine mode codex-claude agent|model; M1 has codex-claude only')
  const code = set(root, 'modes.codexClaude', args[1] ?? '', say)
  if (code === 0 && args[1] === 'model')
    say(
      'Model mode uses claude -p on eligible native routes (a policy grey area; agent mode is the default). Bridge routes use agent mode.\n',
    )
  return code
}
const config: Command = async (args, _system, root, say) => {
  const [verb, key, value] = args
  if (args.length === 0) {
    const { config, errors } = configErrors(root, say)
    say(`${JSON.stringify(config, null, 2)}\n`)
    return errors.length ? 1 : 0
  }
  if (verb === 'get' && args.length === 2 && key) {
    try {
      const { config, errors } = configErrors(root, say)
      say(`${JSON.stringify(getConfigValue(config, key))}\n`)
      return errors.length ? 1 : 0
    } catch (error) {
      return usage(say, message(error))
    }
  }
  if (verb === 'set' && args.length === 3 && key && value !== undefined)
    return set(root, key, value, say)
  return usage(
    say,
    `usage: anyengine config [get KEY | set KEY VALUE]; keys: ${CONFIG_KEYS.join(', ')}`,
  )
}
function privateBackup(root: string): string {
  const parent = join(enginePaths(root).state, 'cache-backups')
  // Refuse links and unowned ancestors before creating a recovery destination.
  for (const path of [root, enginePaths(root).state, parent]) {
    try {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
        throw new Error(`unowned or unsupported recovery directory: ${path}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  try {
    if (readdirSync(parent).length >= 32)
      throw new Error(
        'cache recovery backup limit (32); retain or archive prior evidence before cleanup',
      )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  chmodSync(parent, 0o700)
  return mkdtempSync(join(parent, 'clean-'))
}
const cache: Command = async (args, system, root, say) => {
  if (args[0] !== 'clean' || args.length > 2 || (args.length === 2 && args[1] !== '--dry-run'))
    return usage(say, 'usage: anyengine cache clean [--dry-run]')
  const { config, errors } = configErrors(root, say)
  if (errors.length) return 1
  const ids = new Set(config.claude.models.map((model) => model.id))
  const home = codexHome()
  const report = inspectModelsCache(home, ids)
  if (args[1] === '--dry-run') {
    say(
      `${report.path}: ${report.anyengine.length} AnyEngine entries${report.parseError ? ` (unreadable: ${report.parseError})` : ''}; dry-run, unchanged\n`,
    )
    return report.parseError ? 1 : 0
  }
  try {
    if (system.appRunning()) {
      say('cache cleanup refused: app is running; quit it and confirm exit first\n')
      return 1
    }
  } catch (error) {
    say(`cache cleanup refused: app state unknown (${message(error)})\n`)
    return 1
  }
  if (report.parseError) {
    say(`cache retained: ${report.parseError}\n`)
    return 1
  }
  if (!report.exists || !report.anyengine.length) {
    say(`left ${report.path} alone (${report.exists ? 'no AnyEngine entries' : 'absent'})\n`)
    return 0
  }
  let backup: string | null = null
  try {
    backup = privateBackup(root)
    const result = cleanModelsCache(home, ids, backup)
    say(
      result.removed
        ? `removed ${report.path}; backup ${backup}/models_cache.json; codex rebuilds it on its next fetch\n`
        : `left ${report.path} alone; backup destination ${backup}\n`,
    )
    if (result.report.parseError) {
      say(`cache retained: ${result.report.parseError}\n`)
      return 1
    }
    return 0
  } catch (error) {
    say(
      `cache cleanup failed: ${message(error)}${backup ? `; recovery backup retained at ${backup}` : ''}\n`,
    )
    return 1
  }
}
const COMMANDS: Record<string, Command> = { status, mode, config, cache }
export function registerCommand(name: string, command: Command): void {
  if (!CONTROL_COMMANDS.has(name)) throw new Error(`unknown control command ${name}`)
  COMMANDS[name] = command
}
export async function runControl(
  argv: string[],
  system?: System,
  root?: string,
  say: Say = (text) => process.stdout.write(text),
): Promise<number> {
  let resolvedRoot: string
  let resolvedSystem: System
  try {
    resolvedRoot = root ?? anyengineRoot()
    resolvedSystem = system ?? realSystem()
  } catch (error) {
    say(`${message(error)}\n`)
    return 2
  }
  await import('./control-commands.mjs')
  const [name, ...args] = argv
  const command = name ? COMMANDS[name] : undefined
  if (!command) {
    if (name && CONTROL_COMMANDS.has(name))
      say(`${name}: command is not implemented in this build\n`)
    else say(USAGE)
    return 2
  }
  try {
    return await command(args, resolvedSystem, resolvedRoot, say)
  } catch (error) {
    say(`${message(error)}\n`)
    return 1
  }
}
