import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { GptModel } from './claude-models.mjs'

const SLUG = /^gpt-[a-z0-9][a-z0-9.-]*$/
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u
export function validateGptAgentModel(model: GptModel): void {
  if (
    !model ||
    typeof model.id !== 'string' ||
    model.id.length > 128 ||
    SLUG.exec(model.id)?.[0] !== model.id ||
    typeof model.label !== 'string' ||
    !model.label.trim() ||
    CONTROL.test(model.label)
  )
    throw new Error('invalid GPT agent model metadata')
}
export function gptAgentFilename(model: GptModel): string {
  validateGptAgentModel(model)
  return `${model.id}.md`
}
export function renderGptAgent(model: GptModel): string {
  validateGptAgentModel(model)
  const description = JSON.stringify(
    `Use ${model.label} through AnyEngine when this model is requested.`,
  )
  return `---\nname: ${model.id}\ndescription: ${description}\nmodel: ${model.id}\n---\n`
}
export function buildGptAgent(
  current: string | null,
  model: GptModel,
  ownedAfter: string | null = null,
): { value: string | null; outcome: 'create' | 'update' | 'unchanged' | 'collision' } {
  const wanted = renderGptAgent(model)
  if (current === null) return { value: wanted, outcome: 'create' }
  // Matching bytes alone never grant ownership over an existing user file.
  if (ownedAfter === null || current !== ownedAfter) return { value: current, outcome: 'collision' }
  return { value: wanted, outcome: wanted === current ? 'unchanged' : 'update' }
}
export function reconcileGptAgent(
  current: string | null,
  before: string | null,
  after: string,
): { value: string | null; outcome: 'restored' | 'already' | 'left-changed' } {
  if (current === before) return { value: current, outcome: 'already' }
  if (current === after) return { value: before, outcome: 'restored' }
  return { value: current, outcome: 'left-changed' }
}

function stat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('cannot validate Claude settings target')
  }
}
function physical(path: string): string {
  let ancestor = path
  const missing: string[] = []
  while (!stat(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('cannot validate Claude settings target')
    missing.unshift(relative(parent, ancestor))
    ancestor = parent
  }
  try {
    return join(realpathSync(ancestor), ...missing)
  } catch {
    throw new Error('cannot validate Claude settings target')
  }
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
// Metadata-only preflight. The control owner must recheck under its write lock
// and preserve modes/ownership in its existing write-ahead transaction.
export function validateClaudeTarget(configDir: string, target: string): string {
  if (
    !isAbsolute(configDir) ||
    !isAbsolute(target) ||
    CONTROL.test(configDir) ||
    CONTROL.test(target) ||
    resolve(configDir) !== configDir ||
    resolve(target) !== target ||
    target === configDir ||
    !inside(configDir, target)
  )
    throw new Error('Claude settings target escapes its config directory')
  const root = physical(configDir)
  const resolvedTarget = physical(target)
  if (!inside(root, resolvedTarget))
    throw new Error('Claude settings target escapes its config directory')
  const existing = stat(target)
  if (existing) {
    const resolvedStat = stat(resolvedTarget)
    if (!resolvedStat?.isFile()) throw new Error('Claude settings target is not a regular file')
  }
  const parent = physical(dirname(target))
  const parentStat = stat(parent)
  if (parentStat && !parentStat.isDirectory())
    throw new Error('Claude settings target parent is not a directory')
  return target
}
