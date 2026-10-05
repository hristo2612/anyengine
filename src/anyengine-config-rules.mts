// What each AnyEngine setting accepts (anyengine-config.mts reads and
// writes the file). A parser takes the value as the file or the command line
// gives it and returns it normalised, or throws a message a person can act
// on; `config` is the settings read so far, models first. SET_CHECKS run
// only when the operator sets a value, never on a read.
import { accessSync, constants, statSync } from 'node:fs'
import type { AnyEngineConfig, ClaudeModelEntry } from './anyengine-config.mjs'
import { isCodexOpenAiModel } from './util.mjs'

export type Parser = (value: unknown, config: AnyEngineConfig) => unknown
export type Fields = Record<string, unknown>

export const isFields = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const bool: Parser = (value) => {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw new Error('needs true or false')
}
function wholeNumber(value: unknown, min: number, max: number): number {
  // A blank string is not 0: Number('') would quietly make it one.
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)
    throw new Error(`needs a whole number from ${min} to ${max}`)
  return n
}
const intIn =
  (min: number, max: number): Parser =>
  (value) =>
    wholeNumber(value, min, max)
// GPT requests carry the operator's bearer, so they go to chatgpt.com and
// nowhere else; http is for a test backend on 127.0.0.1, never on the
// router's own port (a loop). No credentials, query or fragment: the router
// appends each request's path and query to this URL.
const upstreamUrl: Parser = (value, config) => {
  const text = String(value)
  const url = new URL(text)
  if (url.username || url.password || /[?#]/.test(text))
    throw new Error('needs a URL without credentials, query or fragment')
  const chatgpt = url.protocol === 'https:' && url.hostname === 'chatgpt.com' && url.port === ''
  const port = Number(url.port || 80)
  const test =
    url.protocol === 'http:' && url.hostname === '127.0.0.1' && port !== config.router.port
  if (!chatgpt && !test)
    throw new Error(
      `needs https://chatgpt.com/... on the default port (or, for tests, http://127.0.0.1 on a port other than ${config.router.port})`,
    )
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}
const mode: Parser = (value) => {
  if (value === 'agent' || value === 'model') return value
  throw new Error('needs agent or model')
}
// One entry per id: the catalog and the picker list each id once.
function listedOnce(ids: string[]): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${id} is listed more than once`)
    seen.add(id)
  }
}
// A Claude entry under a GPT id would send that GPT model's turns to Claude.
function modelEntry(entry: unknown): ClaudeModelEntry {
  const e = isFields(entry) ? entry : {}
  if (typeof e.id !== 'string' || !/^[a-z][\w.-]*$/.test(e.id))
    throw new Error('every model needs an id')
  if (isCodexOpenAiModel(e.id.toLowerCase()))
    throw new Error(`${e.id} is a GPT model id, not a Claude one`)
  const displayName = e.displayName ?? e.id
  if (typeof displayName !== 'string' || displayName.trim() === '')
    throw new Error(`${e.id} needs a non-empty displayName`)
  const claudeModel = e.claudeModel ?? e.id
  if (typeof claudeModel !== 'string' || !/^[A-Za-z0-9][\w.:[\]-]*$/.test(claudeModel))
    throw new Error(`${e.id} needs a claudeModel such as opus or claude-opus-4-5`)
  let contextWindow: number
  try {
    contextWindow = wholeNumber(e.contextWindow ?? 200000, 8000, 2_000_000)
  } catch (error) {
    throw new Error(`${e.id}: contextWindow ${(error as Error).message}`)
  }
  return { id: e.id, displayName, claudeModel, contextWindow }
}
const models: Parser = (value) => {
  const list = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(list) || list.length === 0) throw new Error('needs a non-empty JSON array')
  const entries = list.map(modelEntry)
  listedOnce(entries.map((entry) => entry.id))
  return entries
}
const modelIdList: Parser = (value, config) => {
  const list = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(list)) throw new Error('needs a JSON array of model ids')
  const known = new Set(config.claude.models.map((m) => m.id))
  for (const id of list) {
    if (typeof id !== 'string' || !known.has(id))
      throw new Error(`${id} is not a configured Claude model`)
  }
  listedOnce(list)
  return list
}
const modelId: Parser = (value, config) => {
  if (typeof value === 'string' && config.claude.models.some((m) => m.id === value)) return value
  throw new Error(`${String(value)} is not a configured Claude model`)
}
const gptModelOrNull: Parser = (value, config) => {
  if (value === null || value === 'null' || value === '') return null
  if (typeof value !== 'string' || !/^[\w.[\]-]+$/.test(value))
    throw new Error('needs a model id or null')
  if (/^claude/i.test(value) || config.claude.models.some((m) => m.id === value))
    throw new Error(`${value} is a Claude model; this is the GPT model the smoke runs`)
  return value
}
const hasControlCharacter = (text: string) =>
  [...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
const pathOrNull: Parser = (value) => {
  if (value === null || value === 'null' || value === '') return null
  if (typeof value !== 'string' || !value.startsWith('/'))
    throw new Error('needs an absolute path or null')
  if (hasControlCharacter(value)) throw new Error('needs a path without control characters')
  return value
}
// Checked when the operator sets it, not on every read: the file can move
// (an update) without the setting turning invalid.
function executableFile(value: unknown): void {
  if (typeof value !== 'string') return
  try {
    if (statSync(value).isFile()) {
      accessSync(value, constants.X_OK)
      return
    }
  } catch {}
  throw new Error(`${value} is not an executable file`)
}

export const PARSERS: Readonly<Record<string, Parser>> = {
  'router.enabled': bool,
  'router.port': intIn(1024, 65535),
  'router.upstream': upstreamUrl,
  'router.multiAgentV1': bool,
  'modes.codexClaude': mode,
  'claude.models': models,
  'claude.spawnPriority': modelIdList,
  'claude.cli': pathOrNull,
  'smoke.enabled': bool,
  'smoke.hour': intIn(0, 23),
  'smoke.minute': intIn(0, 59),
  'smoke.claudeModel': modelId,
  'smoke.gptModel': gptModelOrNull,
  'claims.idleReleaseMinutes': intIn(1, 1440),
  'claims.graceMs': intIn(0, 30000),
  'claims.unclaimedFlipThreshold': intIn(1, 100),
}
export const SET_CHECKS: Readonly<Record<string, (value: unknown) => void>> = {
  'claude.cli': executableFile,
}
