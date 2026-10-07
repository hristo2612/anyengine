import { join } from 'node:path'
import { setConfigValue } from './anyengine-config.mjs'
import type { Command } from './control-cli.mjs'
import {
  desktopSessionStatus,
  listDesktopSessions,
  removeDesktopSessionCopies,
  syncDesktopSessions,
} from './desktop-sessions.mjs'

const USAGE =
  'usage: anyengine desktop claude sessions on|off|status|list|sync [--json] (alias: desktop sessions)'
export const desktopSessionsCommand: Command = async (args, system, root, say) => {
  const [verb, flag] = args
  if (
    !['on', 'off', 'status', 'list', 'sync'].includes(verb ?? '') ||
    args.length > 2 ||
    (flag !== undefined && flag !== '--json')
  ) {
    say(`${USAGE}\n`)
    return 2
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(system.home, '.claude')
  let result: unknown
  if (verb === 'on') {
    setConfigValue(root, 'sessions.desktopAccounts', 'true')
    result = { enabled: true, ...syncDesktopSessions(system.home, root, configDir) }
  } else if (verb === 'off') {
    setConfigValue(root, 'sessions.desktopAccounts', 'false')
    result = { enabled: false, ...removeDesktopSessionCopies(system.home, root) }
  } else if (verb === 'sync') result = syncDesktopSessions(system.home, root, configDir)
  else if (verb === 'list')
    result = listDesktopSessions(system.home, configDir).map((e) => ({
      app: e.app,
      account: e.account,
      org: e.org,
      sessionId: e.sessionId,
      cliSessionId: e.cliSessionId,
      title: e.record.title,
      cwd: e.record.cwd,
      archived: e.record.isArchived,
    }))
  else result = desktopSessionStatus(system.home, root, configDir)
  say(`${JSON.stringify(result, null, flag ? 2 : undefined)}\n`)
  if (!flag && ['on', 'off', 'sync'].includes(verb ?? ''))
    say(
      'Quit and reopen Claude to reload its session list. Originals and transcripts are preserved; changed copies remain on off.\n',
    )
  return 0
}
