import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { readConfig, setConfigValue } from './anyengine-config.mjs'
import { resolveBundledCodex } from './bundled-codex.mjs'
import type { Command, Say } from './control-cli.mjs'
import { Sessions } from './sessions.mjs'
import { parseSessionKey, type SessionHarness, type SessionSummary } from './sessions-types.mjs'

const USAGE = `usage: anyengine sessions
  on | off | status
  list [--cwd PATH] [--limit N] [--json]
  search TEXT [--cwd PATH] [--limit N] [--json]
  show claude:UUID|codex:UUID [--json]
  open claude:UUID|codex:UUID --in claude|codex|chatgpt [--fresh] [--model MODEL] [--launch] [--json]
  sync [on|off] [--cwd PATH] [--limit N] [--json]
`
interface Options {
  positional: string[]
  json: boolean
  launch: boolean
  fresh: boolean
  cwd?: string
  model?: string
  target?: 'claude' | 'codex' | 'chatgpt'
  limit: number
}
function valueOption(o: Options, arg: string, value: string): void {
  if (arg === '--cwd') o.cwd = value
  if (arg === '--model') o.model = value
  if (arg === '--limit') {
    o.limit = Number(value)
    if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > 10000)
      throw new Error('--limit must be between 1 and 10000')
  }
  if (arg === '--in') {
    if (value !== 'claude' && value !== 'codex' && value !== 'chatgpt') throw new Error(USAGE)
    o.target = value
  }
}
const BOOLEAN_FLAGS: Record<string, 'json' | 'launch' | 'fresh'> = {
  '--json': 'json',
  '--launch': 'launch',
  '--fresh': 'fresh',
}
function options(args: string[], allowed: string[]): Options {
  const o: Options = { positional: [], json: false, launch: false, fresh: false, limit: 100 }
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith('--')) {
      o.positional.push(arg)
      continue
    }
    if (!allowed.includes(arg) || seen.has(arg)) throw new Error(USAGE)
    seen.add(arg)
    const flag = BOOLEAN_FLAGS[arg]
    if (flag) {
      o[flag] = true
      continue
    }
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
    valueOption(o, arg, value)
  }
  if (o.json && o.launch) throw new Error('--json cannot be combined with --launch')
  return o
}
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
function validate(verb: string, args: string[], o: Options): void {
  if (!['on', 'off', 'status', 'list', 'search', 'show', 'open', 'sync'].includes(verb))
    throw new Error(USAGE)
  if (o.cwd && !isAbsolute(o.cwd)) throw new Error('--cwd needs an absolute directory')
  if (verb === 'on' || verb === 'off') {
    if (args.length !== 1) throw new Error(USAGE)
  } else if (verb === 'sync') {
    if (o.positional.length && (o.cwd || args.includes('--limit')))
      throw new Error('--cwd and --limit apply to one-time sync, not automatic sync on/off')
    if (
      o.positional.length > 1 ||
      (o.positional.length && !['on', 'off'].includes(o.positional[0]!))
    )
      throw new Error(USAGE)
  } else {
    const count = ['search', 'show', 'open'].includes(verb) ? 1 : 0
    if (o.positional.length !== count) throw new Error(USAGE)
    if (verb === 'search' && !o.positional[0]!.trim()) throw new Error('Search needs nonempty text')
    if (verb === 'show' || verb === 'open') parseSessionKey(o.positional[0]!)
    if (verb === 'open' && !o.target) throw new Error(USAGE)
    if (verb === 'open' && o.target === 'chatgpt' && o.model)
      throw new Error('Choose the model in ChatGPT after opening')
  }
}
function printRows(rows: SessionSummary[], json: boolean, say: Say): void {
  if (json) {
    say(`${JSON.stringify(rows, null, 2)}\n`)
    return
  }
  for (const s of rows)
    say(
      `${s.key}  ${s.copied ? '[copy] ' : ''}${s.archived ? '[archived] ' : ''}${s.title.replace(/[\x00-\x1f\x7f]/g, ' ')}\n  ${s.cwd}\n`,
    )
  if (!rows.length) say('No conversations found.\n')
}
async function launch(command: string, args: string[], cwd: string): Promise<number> {
  const child = spawn(command, args, { cwd, stdio: 'inherit' })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
}

async function open(sessions: Sessions, root: string, o: Options, say: Say): Promise<number> {
  if (o.positional.length !== 1 || !o.target) throw new Error(USAGE)
  const target: SessionHarness = o.target === 'claude' ? 'claude' : 'codex'
  const copy = await sessions.open(o.positional[0]!, target, o.fresh)
  const id = parseSessionKey(copy.target).id
  const cwd = (await sessions.find(o.positional[0]!)).cwd
  const command =
    target === 'claude'
      ? readConfig(root).config.claude.cli || 'claude'
      : resolveBundledCodex().path!
  const args = target === 'claude' ? ['--resume', id, '--fork-session'] : ['resume', id]
  if (o.model) args.push('--model', o.model)
  if (o.json) {
    say(`${JSON.stringify({ ...copy, cwd, command, args }, null, 2)}\n`)
    return 0
  }
  say(`${copy.title}\n${copy.target}\n`)
  if (o.target === 'chatgpt') {
    say('Ready in ChatGPT’s Codex workspace history. Open the conversation by its title.\n')
    if (o.launch) return launch('/usr/bin/open', ['-a', 'ChatGPT'], cwd)
  } else {
    say(`cd ${shellQuote(cwd)} && ${[command, ...args].map(shellQuote).join(' ')}\n`)
    if (o.launch) return launch(command, args, cwd)
  }
  return 0
}

function switchOptions(verb: string, root: string, o: Options, say: Say): boolean {
  if (verb === 'status') {
    const settings = readConfig(root).config.sessions
    say(
      o.json
        ? `${JSON.stringify(settings)}\n`
        : `Unified browsing: ${settings.enabled ? 'on' : 'off'}\nAutomatic sync: ${settings.sync ? 'on' : 'off'}\n`,
    )
  } else if (verb === 'on' || verb === 'off') {
    if (verb === 'off') setConfigValue(root, 'sessions.sync', 'false')
    setConfigValue(root, 'sessions.enabled', String(verb === 'on'))
    say(`Session browsing ${verb}. Existing copies and original conversations are retained.\n`)
  } else if (verb === 'sync' && o.positional.length) {
    const enabled = o.positional[0] === 'on'
    if (enabled) setConfigValue(root, 'sessions.enabled', 'true')
    setConfigValue(root, 'sessions.sync', String(enabled))
    say(
      o.json
        ? `${JSON.stringify(readConfig(root).config.sessions)}\n`
        : `Automatic sync ${enabled ? 'on' : 'off'}. ${enabled ? 'New conversations are copied while AnyEngine is running.' : 'No more automatic copies; existing branches are retained.'}\n`,
    )
  } else return false
  return true
}

async function execute(
  sessions: Sessions,
  verb: string,
  root: string,
  o: Options,
  say: Say,
): Promise<number> {
  switch (verb) {
    case 'open':
      return open(sessions, root, o, say)
    case 'show': {
      const snapshot = await sessions.read(await sessions.find(o.positional[0]!))
      say(
        o.json
          ? `${JSON.stringify(snapshot, null, 2)}\n`
          : snapshot.messages.map((m) => `${m.role}: ${m.text}\n`).join('\n'),
      )
      break
    }
    case 'sync': {
      const result = await sessions.sync(o.limit, o.cwd)
      say(
        o.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `Copied ${result.copied.length} new conversations; ${result.skipped} already copied, empty or still active.\n`,
      )
      break
    }
    case 'search':
      printRows(await sessions.search(o.positional[0]!, o.limit, o.cwd), o.json, say)
      break
    case 'list':
      printRows((await sessions.list(o.cwd)).slice(0, o.limit), o.json, say)
      break
  }
  return 0
}

export const sessionsCommand: Command = async (args, _system, root, say) => {
  const verb = args[0] ?? 'status'
  const allowed =
    verb === 'open'
      ? ['--in', '--fresh', '--model', '--launch', '--json']
      : verb === 'show' || verb === 'status'
        ? ['--json']
        : ['--cwd', '--limit', '--json']
  let o: Options
  try {
    o = options(args.slice(1), allowed)
    validate(verb, args, o)
  } catch (error) {
    say(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const read = readConfig(root)
  if (read.errors.length) throw new Error(read.errors.join('; '))
  if (switchOptions(verb, root, o, say)) return 0
  if (!read.config.sessions.enabled) {
    say('Session features are off. Enable with: anyengine sessions on\n')
    return 2
  }
  const sessions = new Sessions(root)
  try {
    return await execute(sessions, verb, root, o, say)
  } finally {
    await sessions.close()
  }
}
