// Optional native Desktop profile. Restore only our profile and two selected fields.
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type ClaudeModelEntry, DEFAULT_CONFIG, readConfig } from './anyengine-config.mjs'
import { PARSERS } from './anyengine-config-rules.mjs'
import type { GptModel } from './claude-models.mjs'
import type { Command } from './control-cli.mjs'
import { atomicFile, jsonAt, object } from './control-layer-state.mjs'
import { desktopClaudeModels } from './desktop-claude-catalog.mjs'
import { desktopModelId, desktopProfile } from './desktop-models.mjs'
import { withFileLock } from './file-lock.mjs'
import { fetchDesktopClaudeModels, fetchGptSettingsView, settingsView } from './router-messages.mjs'

const USAGE = 'usage: anyengine desktop picker on|refresh|off|status [--json]'
const ID = /^[a-f0-9-]{36}$/
// Count locally without inference, before switching Desktop to this router.
async function checkRoute(port: number, model: string): Promise<void> {
  const failure = () =>
    new Error(
      'Restart or update the AnyEngine router before enabling the Desktop picker; existing settings retained.',
    )
  await new Promise<void>((resolve, reject) => {
    const request = http.request(
      `http://127.0.0.1:${port}/v1/messages/count_tokens`,
      {
        method: 'POST',
        agent: false,
        signal: AbortSignal.timeout(8_000),
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer anyengine-local',
          'sec-fetch-site': 'none',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'no-cors',
        },
        maxHeaderSize: 8192,
      },
      (response) => {
        let body = ''
        response.on('error', () => reject(failure()))
        response.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8')
          if (body.length > 4096) {
            response.destroy()
            reject(failure())
          }
        })
        response.on('end', () => {
          try {
            if (response.statusCode !== 200 || !Number.isSafeInteger(JSON.parse(body).input_tokens))
              throw failure()
            resolve()
          } catch {
            reject(failure())
          }
        })
      },
    )
    request.on('error', () => reject(failure()))
    request.end(
      JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'check' }],
      }),
    )
  })
}
interface Receipt {
  version: 1 | 2 | 3 | 4
  id: string
  port: number
  models: GptModel[]
  claudeModels?: ClaudeModelEntry[]
  beforeApplied?: string | undefined
  beforeMode?: '1p' | '3p' | undefined
  metaAbsent: boolean
  modeAbsent: boolean
}
function paths(home: string, root: string) {
  const dir = join(home, 'Library/Application Support/Claude-3p')
  return {
    dir,
    meta: join(dir, 'configLibrary/_meta.json'),
    mode: join(dir, 'claude_desktop_config.json'),
    receipt: join(root, 'recovery/claude-desktop/picker.json'),
    profile: (id: string) => join(dir, 'configLibrary', `${id}.json`),
  }
}
function read(path: string): Record<string, unknown> | undefined {
  const value = jsonAt(path)
  if (value !== undefined && !object(value))
    throw new Error('Invalid Desktop picker configuration; existing settings retained.')
  return value
}
function save(path: string, value: object): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  atomicFile(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600)
}
function receiptAt(path: string): Receipt | undefined {
  const value = read(path)
  if (value === undefined) return undefined
  if (
    ![1, 2, 3, 4].includes(value.version as number) ||
    typeof value.id !== 'string' ||
    !ID.test(value.id) ||
    !Number.isInteger(value.port) ||
    Number(value.port) < 1 ||
    Number(value.port) > 65535 ||
    (value.beforeApplied !== undefined &&
      (typeof value.beforeApplied !== 'string' || !ID.test(value.beforeApplied))) ||
    (value.beforeMode !== undefined && !['1p', '3p'].includes(String(value.beforeMode))) ||
    typeof value.metaAbsent !== 'boolean' ||
    typeof value.modeAbsent !== 'boolean'
  )
    throw new Error('Invalid Desktop picker recovery receipt; existing settings retained.')
  const models = settingsView({ generation: 0, fetchedAt: 0, models: value.models }).models
  if (!models.length) throw new Error('Desktop picker recovery has no models.')
  const claudeModels =
    value.version === 3 || value.version === 4
      ? desktopClaudeModels(value.claudeModels)
      : value.version === 2
        ? (PARSERS['claude.models']?.(value.claudeModels, DEFAULT_CONFIG) as ClaudeModelEntry[])
        : undefined
  return {
    ...value,
    models: [...models],
    ...(claudeModels ? { claudeModels } : {}),
  } as unknown as Receipt
}
const profileOf = (receipt: Receipt) =>
  desktopProfile(receipt.port, receipt.models, receipt.claudeModels, receipt.version === 4)
function metadata(path: string): Record<string, unknown> & { entries: Record<string, unknown>[] } {
  const value = read(path) ?? { entries: [] }
  if (
    !Array.isArray(value.entries) ||
    !value.entries.every(
      (entry) => object(entry) && typeof entry.id === 'string' && ID.test(entry.id),
    ) ||
    (value.appliedId !== undefined &&
      (typeof value.appliedId !== 'string' || !ID.test(value.appliedId)))
  )
    throw new Error('Invalid Desktop profile library; existing settings retained.')
  return value as Record<string, unknown> & { entries: Record<string, unknown>[] }
}
const entryOf = (receipt: Receipt) => ({ id: receipt.id, name: 'AnyEngine' })
function owned(p: ReturnType<typeof paths>, receipt: Receipt): void {
  const profile = read(p.profile(receipt.id))
  const meta = metadata(p.meta)
  const entry = meta.entries.filter((row) => row.id === receipt.id)
  const mode = read(p.mode)?.deploymentMode
  if (
    (profile !== undefined && !isDeepStrictEqual(profile, profileOf(receipt))) ||
    entry.length > 1 ||
    (entry.length === 1 && !isDeepStrictEqual(entry[0], entryOf(receipt))) ||
    (meta.appliedId !== undefined &&
      meta.appliedId !== receipt.id &&
      meta.appliedId !== receipt.beforeApplied) ||
    (mode !== undefined && mode !== '3p' && mode !== '1p')
  )
    throw new Error('Desktop picker profile or selection was edited; existing settings retained.')
}
function restore(p: ReturnType<typeof paths>, receipt: Receipt): void {
  owned(p, receipt)
  const mode = read(p.mode) ?? {}
  if (mode.deploymentMode !== '1p') {
    if (receipt.beforeMode === undefined) delete mode.deploymentMode
    else mode.deploymentMode = receipt.beforeMode
  }
  if (receipt.modeAbsent && !Object.keys(mode).length) rmSync(p.mode, { force: true })
  else save(p.mode, mode)
  const meta = metadata(p.meta)
  if (meta.appliedId === receipt.id) {
    if (receipt.beforeApplied === undefined) delete meta.appliedId
    else meta.appliedId = receipt.beforeApplied
  }
  meta.entries = meta.entries.filter((row) => row.id !== receipt.id)
  if (
    receipt.metaAbsent &&
    !meta.entries.length &&
    Object.keys(meta).every((key) => key === 'entries')
  )
    rmSync(p.meta, { force: true })
  else save(p.meta, meta)
  rmSync(p.profile(receipt.id), { force: true })
  rmSync(p.receipt, { force: true })
}
export function desktopPickerStatus(home: string, root: string) {
  const p = paths(home, root)
  const receipt = receiptAt(p.receipt)
  if (!receipt) return { enabled: false, conflict: false, models: [] as string[] }
  try {
    owned(p, receipt)
  } catch {
    return { enabled: false, conflict: true, models: [] as string[] }
  }
  return {
    enabled:
      read(p.mode)?.deploymentMode === '3p' &&
      metadata(p.meta).appliedId === receipt.id &&
      metadata(p.meta).entries.some((entry) => isDeepStrictEqual(entry, entryOf(receipt))) &&
      isDeepStrictEqual(read(p.profile(receipt.id)), profileOf(receipt)),
    conflict: false,
    models: [
      ...(receipt.claudeModels ?? []).map((model) => model.id),
      ...receipt.models.map((model) => model.id),
    ],
  }
}
function prepareReceipt(
  p: ReturnType<typeof paths>,
  port: number,
  models: GptModel[],
  claudeModels: ClaudeModelEntry[],
): Receipt {
  const meta = metadata(p.meta)
  const mode = read(p.mode) ?? {}
  if (meta.hybridPointer !== undefined)
    throw new Error('A managed Desktop profile is active; existing settings retained.')
  if (mode.deploymentMode !== undefined && !['1p', '3p'].includes(String(mode.deploymentMode)))
    throw new Error('Invalid Desktop mode; existing settings retained.')
  const receipt: Receipt = {
    version: 4,
    id: randomUUID(),
    port,
    models,
    claudeModels,
    beforeApplied: meta.appliedId as string | undefined,
    beforeMode: mode.deploymentMode as Receipt['beforeMode'],
    metaAbsent: read(p.meta) === undefined,
    modeAbsent: read(p.mode) === undefined,
  }
  save(p.receipt, receipt)
  return receipt
}
function applyProfile(p: ReturnType<typeof paths>, receipt: Receipt): void {
  const meta = metadata(p.meta)
  save(p.profile(receipt.id), profileOf(receipt))
  meta.entries = [...meta.entries.filter((row) => row.id !== receipt.id), entryOf(receipt)]
  meta.appliedId = receipt.id
  save(p.meta, meta)
  save(p.mode, { ...read(p.mode), deploymentMode: '3p' })
}
export const desktopPickerCommand: Command = async (args, system, root, say) => {
  const [verb, flag] = args
  if (
    !['on', 'refresh', 'off', 'status'].includes(verb ?? '') ||
    args.length > 2 ||
    (flag !== undefined && (verb !== 'status' || flag !== '--json'))
  ) {
    say(`${USAGE}\n`)
    return 2
  }
  if (verb === 'status') {
    const status = desktopPickerStatus(system.home, root)
    say(
      flag
        ? `${JSON.stringify(status)}\n`
        : `Claude Desktop Claude + GPT picker: ${status.enabled ? 'on' : status.conflict ? 'conflict (settings retained)' : 'off'}\n`,
    )
    return status.conflict ? 1 : 0
  }
  const p = paths(system.home, root)
  const { config, errors } = readConfig(root)
  const enabling = verb === 'on' || verb === 'refresh'
  if (verb === 'refresh' && !desktopPickerStatus(system.home, root).enabled)
    throw new Error('Enable the Desktop picker before refreshing its models.')
  if (enabling && (errors.length || !config.router.enabled))
    throw new Error('Enable the AnyEngine router before the Desktop picker.')
  const models = enabling
    ? [
        ...(
          await fetchGptSettingsView(
            `http://127.0.0.1:${config.router.port}`,
            AbortSignal.timeout(15_000),
          )
        ).models,
      ]
    : []
  const claudeModels = enabling
    ? await fetchDesktopClaudeModels(
        `http://127.0.0.1:${config.router.port}`,
        AbortSignal.timeout(25_000),
      )
    : []
  if (enabling) {
    const first = models[0]
    if (!first) throw new Error('No GPT models are available; existing Desktop mode retained.')
    await checkRoute(config.router.port, desktopModelId(first.id))
    for (const model of claudeModels) await checkRoute(config.router.port, model.resolvedModel)
  }
  mkdirSync(dirname(p.receipt), { recursive: true, mode: 0o700 })
  withFileLock(`${p.receipt}.lock`, () => {
    let receipt = receiptAt(p.receipt)
    if (receipt) owned(p, receipt)
    const sameCatalog =
      receipt?.version === 4 &&
      receipt.port === config.router.port &&
      isDeepStrictEqual(receipt.models, models) &&
      isDeepStrictEqual(receipt.claudeModels, claudeModels)
    if (verb === 'off' && !receipt) {
      say('Claude Desktop native GPT picker is already off.\n')
      return
    }
    if (enabling && sameCatalog && desktopPickerStatus(system.home, root).enabled && receipt) {
      say('Claude Desktop Claude + GPT picker is already on.\n')
      return
    }
    const wasRunning = system.appRunning()
    if (wasRunning && !system.quitApp())
      throw new Error('Quit Claude Desktop before changing its picker; settings retained.')
    try {
      if (verb === 'off' && receipt) restore(p, receipt)
      else {
        if (receipt && !sameCatalog) {
          restore(p, receipt)
          receipt = undefined
        }
        receipt ??= prepareReceipt(p, config.router.port, models, claudeModels)
        applyProfile(p, receipt)
      }
      if (wasRunning) system.openApp()
    } catch (error) {
      if (enabling && receipt) restore(p, receipt)
      if (wasRunning) system.openApp()
      throw error
    }
    say(
      `Claude Desktop Claude + GPT picker ${verb}. ${enabling ? 'Select Claude (Claude Code subscription) or GPT (Codex subscription) in the app’s model menu. Gateway history is local; picker off restores Claude cloud mode.' : 'Previous Desktop mode restored.'}\n`,
    )
  })
  return 0
}
