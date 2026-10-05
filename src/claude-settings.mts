import { isDeepStrictEqual } from 'node:util'
import { validateGptAgentModel } from './claude-agents.mjs'
import type { GptModel } from './claude-models.mjs'
import type { Json, Obj } from './vendor/claude-code-proxy/types.mjs'

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_GATEWAY_HINT_HEADERS',
] as const
function object(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function validateSettings(value: unknown): asserts value is Obj {
  if (!object(value)) throw new Error('invalid Claude settings JSON object')
  if (Object.hasOwn(value, 'env') && !object(value.env))
    throw new Error('invalid Claude settings env object')
  if (Object.hasOwn(value, 'modelPicker')) {
    const picker = value.modelPicker
    if (!object(picker)) throw new Error('invalid Claude settings modelPicker object')
    if (
      Object.hasOwn(picker, 'options') &&
      (!Array.isArray(picker.options) ||
        picker.options.some((row) => !object(row) || typeof row.model !== 'string' || !row.model))
    )
      throw new Error('invalid Claude settings modelPicker options')
  }
}
export function parseClaudeSettings(text: string): Obj {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('invalid Claude settings JSON')
  }
  validateSettings(parsed)
  return parsed
}
function env(value: Obj): Obj {
  return object(value.env) ? value.env : {}
}
function picker(value: Obj): Obj {
  return object(value.modelPicker) ? value.modelPicker : {}
}
function rows(value: Obj): Obj[] {
  const options = picker(value).options
  return Array.isArray(options) ? (options as Obj[]) : []
}
function sameLeaf(left: Obj, right: Obj, key: string): boolean {
  return (
    Object.hasOwn(left, key) === Object.hasOwn(right, key) &&
    isDeepStrictEqual(left[key], right[key])
  )
}
function restoreLeaf(current: Obj, before: Obj, key: string): void {
  if (Object.hasOwn(before, key)) current[key] = structuredClone(before[key] as Json)
  else delete current[key]
}
function validateInput(input: {
  baseUrl: string
  haiku: string
  models: readonly GptModel[]
}): void {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(input.baseUrl)
  if (!match || Number(match[1]) > 65535)
    throw new Error('Claude routing requires a loopback HTTP origin')
  if (
    typeof input.haiku !== 'string' ||
    /^claude-haiku-[a-z0-9][a-z0-9.-]*$/.exec(input.haiku)?.[0] !== input.haiku
  )
    throw new Error('invalid Claude Haiku model')
  if (!Array.isArray(input.models)) throw new Error('invalid GPT model metadata list')
  for (const model of input.models) validateGptAgentModel(model)
}
export function buildClaudeSettings(
  before: Obj,
  input: { baseUrl: string; haiku: string; models: readonly GptModel[] },
): Obj {
  validateSettings(before)
  validateInput(input)
  const value = structuredClone(before)
  value.env = {
    ...env(value),
    ANTHROPIC_BASE_URL: input.baseUrl,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: input.haiku,
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
  }
  const options = [...rows(value)]
  const seen = new Set(options.map((row) => row.model))
  for (const model of input.models) {
    if (seen.has(model.id)) continue
    options.push({ model: model.id, label: model.label, description: 'via AnyEngine' })
    seen.add(model.id)
  }
  value.modelPicker = { ...picker(value), options }
  return value
}
export function ownedClaudeModels(before: Obj, after: Obj): string[] {
  validateSettings(before)
  validateSettings(after)
  const prior = new Set(rows(before).map((row) => row.model))
  return [
    ...new Set(
      rows(after).flatMap((row) =>
        typeof row.model === 'string' && !prior.has(row.model) ? [row.model] : [],
      ),
    ),
  ]
}

function restoreEnv(current: Obj, before: Obj, after: Obj, conflicts: string[]): void {
  const valueEnv = env(current),
    beforeEnv = env(before),
    afterEnv = env(after)
  for (const key of ENV_KEYS) {
    if (sameLeaf(beforeEnv, afterEnv, key)) continue
    if (sameLeaf(valueEnv, afterEnv, key)) restoreLeaf(valueEnv, beforeEnv, key)
    else if (!sameLeaf(valueEnv, beforeEnv, key)) conflicts.push(`env.${key}`)
  }
  if (Object.keys(valueEnv).length) current.env = valueEnv
  else if (!Object.hasOwn(before, 'env')) delete current.env
}
function restoreRows(
  current: Obj,
  before: Obj,
  after: Obj,
  owned: readonly string[],
  conflicts: string[],
): void {
  const options = [...rows(current)]
  for (const id of owned) {
    const installed = rows(after).find((row) => row.model === id)
    if (!installed || rows(before).some((row) => row.model === id)) continue
    const index = options.findIndex((row) => row.model === id && isDeepStrictEqual(row, installed))
    if (index >= 0) options.splice(index, 1)
    else if (options.some((row) => row.model === id)) conflicts.push(`modelPicker.options:${id}`)
  }
  const valuePicker = picker(current)
  if (options.length || Object.hasOwn(picker(before), 'options')) valuePicker.options = options
  else delete valuePicker.options
  if (Object.keys(valuePicker).length) current.modelPicker = valuePicker
  else if (!Object.hasOwn(before, 'modelPicker')) delete current.modelPicker
}
function restoreDefaults(current: Obj, before: Obj, after: Obj, owned: readonly string[]): void {
  if (typeof current.model === 'string' && owned.includes(current.model))
    restoreLeaf(current, before, 'model')
  const afterEnv = env(after),
    beforeEnv = env(before),
    valueEnv = env(current)
  // The standard on transform does not own ANTHROPIC_MODEL. An explicitly
  // recorded changed GPT default may be undone, but outside exports are never read.
  if (
    !sameLeaf(beforeEnv, afterEnv, 'ANTHROPIC_MODEL') &&
    typeof afterEnv.ANTHROPIC_MODEL === 'string' &&
    owned.includes(afterEnv.ANTHROPIC_MODEL) &&
    typeof valueEnv.ANTHROPIC_MODEL === 'string' &&
    owned.includes(valueEnv.ANTHROPIC_MODEL)
  ) {
    restoreLeaf(valueEnv, beforeEnv, 'ANTHROPIC_MODEL')
    if (Object.keys(valueEnv).length) current.env = valueEnv
    else if (!Object.hasOwn(before, 'env')) delete current.env
  }
}
export function restoreClaudeSettings(
  current: Obj,
  before: Obj,
  after: Obj,
  ownedModels: readonly string[],
): { value: Obj; conflicts: string[] } {
  for (const settings of [current, before, after]) validateSettings(settings)
  const recorded = ownedClaudeModels(before, after)
  const owned = [...new Set(ownedModels)].filter((id) => recorded.includes(id))
  const value = structuredClone(current),
    conflicts: string[] = []
  restoreEnv(value, before, after, conflicts)
  restoreRows(value, before, after, owned, conflicts)
  restoreDefaults(value, before, after, owned)
  return { value, conflicts }
}
