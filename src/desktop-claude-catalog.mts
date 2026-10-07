import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type ModelInfo, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { type ClaudeModelEntry, DEFAULT_CONFIG } from './anyengine-config.mjs'
import { claudeEnvironment } from './claude-environment.mjs'

export const DESKTOP_CLAUDE_MODELS = '/control/claude-desktop/models'
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export interface DesktopClaudeModel extends ClaudeModelEntry {
  description: string
  resolvedModel: string
  efforts: string[]
  adaptiveThinking: boolean
  fastMode: boolean
  autoMode: boolean
}
const ID = /^[A-Za-z0-9][\w.:[\]-]{0,127}$/
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 1024 && !CONTROL.test(v)

export function desktopClaudeModels(value: unknown): DesktopClaudeModel[] {
  if (!Array.isArray(value) || !value.length || value.length > 256)
    throw new Error('Claude model catalog is unavailable; existing picker retained.')
  const models = value.map((row) => {
    if (
      !record(row) ||
      !text(row.id) ||
      !ID.test(row.id) ||
      row.id.startsWith('gpt-') ||
      !text(row.claudeModel) ||
      !ID.test(row.claudeModel) ||
      !text(row.resolvedModel) ||
      !ID.test(row.resolvedModel) ||
      !text(row.displayName) ||
      !row.displayName.trim() ||
      !text(row.description) ||
      !Number.isSafeInteger(row.contextWindow) ||
      Number(row.contextWindow) < 8000 ||
      Number(row.contextWindow) > 2_000_000 ||
      !Array.isArray(row.efforts) ||
      !row.efforts.every((level) => CLAUDE_EFFORTS.includes(level)) ||
      typeof row.adaptiveThinking !== 'boolean' ||
      typeof row.fastMode !== 'boolean' ||
      typeof row.autoMode !== 'boolean'
    )
      throw new Error('Invalid Claude model catalog; existing picker retained.')
    return {
      id: row.id,
      claudeModel: row.claudeModel,
      resolvedModel: row.resolvedModel,
      displayName: row.displayName,
      description: row.description,
      contextWindow: Number(row.contextWindow),
      efforts: [...row.efforts] as string[],
      adaptiveThinking: row.adaptiveThinking,
      fastMode: row.fastMode,
      autoMode: row.autoMode,
    }
  })
  if (new Set(models.map((model) => model.id)).size !== models.length)
    throw new Error('Ambiguous Claude model catalog; existing picker retained.')
  return models
}

export function claudeCatalogModels(models: ModelInfo[]): DesktopClaudeModel[] {
  return desktopClaudeModels(
    models.map((model) => ({
      id: model.value,
      claudeModel: model.value,
      resolvedModel: model.resolvedModel ?? model.value,
      displayName: model.displayName,
      description: model.description,
      // SDK discovery does not report a context window. This is only our local
      // estimate; it does not authorize a Desktop [1m] option.
      contextWindow: 200000,
      efforts: model.supportsEffort ? (model.supportedEffortLevels ?? []) : [],
      adaptiveThinking: model.supportsAdaptiveThinking === true,
      fastMode: model.supportsFastMode === true,
      autoMode: model.supportsAutoMode === true,
    })),
  )
}

export function configuredDesktopModels(
  discovered: DesktopClaudeModel[],
  configured: ClaudeModelEntry[],
): DesktopClaudeModel[] {
  const result = new Map(discovered.map((model) => [model.id, model]))
  for (const entry of configured) {
    if (
      isDeepStrictEqual(
        entry,
        DEFAULT_CONFIG.claude.models.find((m) => m.id === entry.id),
      )
    )
      continue
    const native = discovered.find(
      (model) =>
        model.claudeModel === entry.claudeModel || model.resolvedModel === entry.claudeModel,
    )
    result.set(entry.id, {
      ...native,
      ...entry,
      resolvedModel: native?.resolvedModel ?? entry.claudeModel,
      description: native?.description ?? '',
      efforts: native?.efforts ?? ['low', 'medium', 'high'],
      adaptiveThinking: native?.adaptiveThinking ?? false,
      fastMode: native?.fastMode ?? false,
      autoMode: native?.autoMode ?? false,
    })
  }
  return desktopClaudeModels([...result.values()])
}

// Initialize the official client but never submit a user turn. Authentication,
// available models and provider selection remain owned by Claude Code.
export async function discoverClaudeModels(input: {
  root: string
  cli: string | null
  signal: AbortSignal
  query?: typeof query
}): Promise<DesktopClaudeModel[]> {
  const cwd = join(input.root, 'router/desktop-claude')
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  let release!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          await hold
          return { done: true, value: undefined }
        },
      }
    },
  }
  const abort = new AbortController()
  const cancel = () => abort.abort()
  input.signal.addEventListener('abort', cancel, { once: true })
  if (input.signal.aborted) cancel()
  const timer = setTimeout(cancel, 20_000)
  let client: ReturnType<typeof query> | undefined
  try {
    if (abort.signal.aborted) throw new Error('Claude catalog discovery cancelled')
    client = (input.query ?? query)({
      prompt,
      options: {
        cwd,
        env: claudeEnvironment(),
        abortController: abort,
        ...(input.cli ? { pathToClaudeCodeExecutable: input.cli } : {}),
        persistSession: false,
        settingSources: [],
        tools: [],
        permissionMode: 'dontAsk',
        settings: { disableAllHooks: true },
        extraArgs: { restricted: null, 'disable-slash-commands': null, 'strict-mcp-config': null },
      },
    })
    const models = await client.supportedModels()
    if (abort.signal.aborted) throw new Error('Claude catalog discovery cancelled')
    return claudeCatalogModels(models)
  } finally {
    clearTimeout(timer)
    input.signal.removeEventListener('abort', cancel)
    release()
    client?.close()
  }
}
