import type { Json, Obj } from './vendor/claude-code-proxy/types.mjs'

export interface GptModel {
  id: string
  label: string
  contextWindow: number
  lite: boolean
  efforts: string[]
}

export interface GptCatalogSnapshot {
  generation: number
  sourceId: string
  sourceRevision: number
  cacheRevision: number
  fetchedAt: number
  models: readonly GptModel[]
}

export interface GptSettingsView {
  generation: number
  fetchedAt: number
  models: readonly GptModel[]
}

export interface ModelChoice {
  requested: string
  upstream: string
  lite: boolean
  effort: string | null
  efforts: readonly string[]
}

const MODEL_REQUEST = /^gpt-[a-z0-9][a-z0-9.-]*(?:\[1m\])?$/
const EFFORT = /^[a-z][a-z0-9_-]*$/
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u

function validRequest(value: string): boolean {
  return value.length <= 128 && MODEL_REQUEST.exec(value)?.[0] === value
}

function object(value: Json): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function catalogModel(value: Json): { model: GptModel; priority: number } | null {
  if (
    !object(value) ||
    typeof value.slug !== 'string' ||
    !validRequest(value.slug) ||
    value.slug.endsWith('[1m]') ||
    value.visibility !== 'list' ||
    typeof value.display_name !== 'string' ||
    !value.display_name.trim() ||
    CONTROL.test(value.display_name) ||
    typeof value.context_window !== 'number' ||
    !Number.isSafeInteger(value.context_window) ||
    value.context_window <= 0 ||
    typeof value.priority !== 'number' ||
    !Number.isFinite(value.priority) ||
    typeof value.use_responses_lite !== 'boolean' ||
    !Array.isArray(value.supported_reasoning_levels)
  )
    return null

  const efforts: string[] = []
  for (const level of value.supported_reasoning_levels) {
    if (
      !object(level) ||
      typeof level.effort !== 'string' ||
      EFFORT.exec(level.effort)?.[0] !== level.effort
    )
      return null
    efforts.push(level.effort)
  }
  return {
    model: {
      id: value.slug,
      label: value.display_name,
      contextWindow: value.context_window,
      lite: value.use_responses_lite,
      efforts,
    },
    priority: value.priority,
  }
}

export function selectGptModels(catalog: Obj): GptModel[] {
  if (!Array.isArray(catalog.models)) return []
  const candidates = catalog.models.flatMap((row) => {
    const candidate = catalogModel(row)
    return candidate ? [candidate] : []
  })
  const counts = new Map<string, number>()
  for (const { model } of candidates) counts.set(model.id, (counts.get(model.id) ?? 0) + 1)
  // Neither ambiguous rows nor absent lane evidence authorize a model choice.
  return candidates
    .filter(({ model }) => counts.get(model.id) === 1)
    .sort((left, right) => left.priority - right.priority)
    .slice(0, 10)
    .map(({ model }) => model)
}

export function resolveGptModel(
  requested: string,
  models: readonly GptModel[],
): ModelChoice | null {
  if (!validRequest(requested)) return null
  const id = requested.replace(/\[1m\]$/, '')
  const model = models.find((row) => row.id === id)
  return model
    ? { requested, upstream: id, lite: model.lite, effort: null, efforts: model.efforts }
    : null
}
