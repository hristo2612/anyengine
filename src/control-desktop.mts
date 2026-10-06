// Opt-in Desktop configuration, with recovery limited to our one MCP entry.
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Command } from './control-cli.mjs'
import { executingLib } from './control-flip-options.mjs'
import { atomicFile, jsonAt, object, statAt } from './control-layer-state.mjs'
import { realSystem } from './control-system.mjs'
import { withFileLock } from './file-lock.mjs'

const USAGE = 'usage: anyengine desktop on|off|status [--json]'
interface Receipt {
  version: 1
  target: string
  fileAbsent: boolean
  serversAbsent: boolean
  entry: Record<string, unknown>
}
function config(path: string): Record<string, unknown> {
  const value = jsonAt(path)
  if (value === undefined) return {}
  if (!object(value) || (value.mcpServers !== undefined && !object(value.mcpServers)))
    throw new Error('Claude Desktop config is invalid; existing settings retained.')
  return value
}
function servers(value: Record<string, unknown>): Record<string, unknown> {
  return object(value.mcpServers) ? value.mcpServers : {}
}
function readReceipt(path: string, target: string): Receipt | undefined {
  const value = jsonAt(path)
  if (value === undefined) return undefined
  if (
    !object(value) ||
    value.version !== 1 ||
    value.target !== target ||
    typeof value.fileAbsent !== 'boolean' ||
    typeof value.serversAbsent !== 'boolean' ||
    !object(value.entry)
  )
    throw new Error('Invalid Desktop recovery receipt; existing settings retained.')
  return value as unknown as Receipt
}
function save(path: string, value: object): void {
  atomicFile(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600)
}
export function desktopStatus(home: string, root: string) {
  const target = join(home, 'Library/Application Support/Claude/claude_desktop_config.json')
  const receipt = readReceipt(join(root, 'recovery/claude-desktop/connector.json'), target)
  const entry = servers(config(target)).anyengine
  return {
    enabled: !!receipt && isDeepStrictEqual(entry, receipt.entry),
    conflict: entry !== undefined && (!receipt || !isDeepStrictEqual(entry, receipt.entry)),
    integration:
      'GPT consultation through MCP; native selection is optional with desktop picker on',
  }
}
function disable(target: string, receiptPath: string, receipt: Receipt | undefined): void {
  const value = config(target)
  const current = servers(value).anyengine
  if (!receipt) {
    if (current !== undefined)
      throw new Error('An existing anyengine MCP server is unowned; retained.')
    return
  }
  if (current !== undefined && !isDeepStrictEqual(current, receipt.entry))
    throw new Error(
      'Desktop anyengine entry was edited; retained. Restore that entry before desktop off.',
    )
  if (current !== undefined) {
    delete servers(value).anyengine
    if (receipt.serversAbsent && !Object.keys(servers(value)).length) delete value.mcpServers
    if (receipt.fileAbsent && !Object.keys(value).length) rmSync(target)
    else save(target, value)
  }
  rmSync(receiptPath, { force: true })
}
function enable(target: string, receiptPath: string, root: string): void {
  const value = config(target)
  const receipt = readReceipt(receiptPath, target)
  const current = servers(value).anyengine
  if (receipt) {
    if (isDeepStrictEqual(current, receipt.entry)) return
    if (current !== undefined) throw new Error('Desktop anyengine entry was edited; retained.')
    // Interrupted enable, or a manually removed entry: replay the saved intent.
    value.mcpServers = { ...servers(value), anyengine: receipt.entry }
    save(target, value)
    return
  }
  if (current !== undefined)
    throw new Error('An existing anyengine MCP server is unowned; retained.')
  const installed = join(root, 'lib/current/scripts/desktop-mcp.mjs')
  const script = existsSync(installed) ? installed : join(executingLib(), 'scripts/desktop-mcp.mjs')
  if (!existsSync(script)) throw new Error('Desktop connector is missing; update AnyEngine first.')
  const next: Receipt = {
    version: 1,
    target,
    fileAbsent: !existsSync(target),
    serversAbsent: value.mcpServers === undefined,
    entry: { command: process.execPath, args: [script], env: { ANYENGINE_ROOT: root } },
  }
  save(receiptPath, next)
  value.mcpServers = { ...servers(value), anyengine: next.entry }
  try {
    save(target, value)
  } catch (error) {
    // Restore an owned partial write. The retained receipt makes off retryable.
    disable(target, receiptPath, next)
    throw error
  }
}
export const desktopCommand: Command = async (args, system, root, say) => {
  if (args[0] === 'picker') {
    const { desktopPickerCommand } = await import('./control-desktop-picker.mjs')
    const desktop = realSystem(
      { ...process.env, HOME: system.home, ANYENGINE_CHATGPT_APP: '/Applications/Claude.app' },
      system.exec,
    )
    return desktopPickerCommand(args.slice(1), desktop, root, say)
  }
  const [verb, flag] = args
  if (
    !['on', 'off', 'status'].includes(verb ?? '') ||
    args.length > 2 ||
    (flag !== undefined && (verb !== 'status' || flag !== '--json'))
  ) {
    say(`${USAGE}\n`)
    return 2
  }
  if (verb === 'status') {
    const status = desktopStatus(system.home, root)
    say(
      flag
        ? `${JSON.stringify(status)}\n`
        : `Claude Desktop connector: ${status.enabled ? 'on' : status.conflict ? 'conflict (existing entry retained)' : 'off'}\n${status.integration}\n`,
    )
    return status.conflict ? 1 : 0
  }
  const target = join(system.home, 'Library/Application Support/Claude/claude_desktop_config.json')
  const receiptPath = join(root, 'recovery/claude-desktop/connector.json')
  for (const path of [dirname(target), dirname(receiptPath)]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    if (!statAt(path)?.isDirectory())
      throw new Error('Desktop configuration directory is unsupported.')
  }
  withFileLock(`${receiptPath}.lock`, () => {
    if (verb === 'on') enable(target, receiptPath, root)
    else disable(target, receiptPath, readReceipt(receiptPath, target))
  })
  say(`Claude Desktop connector ${verb}. Quit and reopen Claude to apply.\n`)
  return 0
}
