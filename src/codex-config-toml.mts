// A lexical assignment map, not a replacement TOML parser. smol-toml validates
// every mutation; spans retain comments, CRLF and unrelated bytes verbatim.
import { parse } from 'smol-toml'
import { isCodexOpenAiModel } from './util.mjs'

export interface ModelLine {
  index: number
  table: string | null
  key: 'model' | 'review_model'
  value: string
  text: string
}
interface Span {
  start: number
  end: number
  index: number
  text: string
}
interface Assignment extends Span {
  table: string[] | null
  key: string[]
  value: unknown
  array: boolean
}

function stringEnd(text: string, start: number): number {
  const quote = text[start] ?? ''
  const triple = text.slice(start, start + 3) === quote.repeat(3)
  const width = triple ? 3 : 1
  let pos = start + width
  while (pos < text.length) {
    if (quote === '"' && text[pos] === '\\') {
      pos += 2
      continue
    }
    if (text.slice(pos, pos + width) === quote.repeat(width)) {
      pos += width
      if (triple) for (let extra = 0; extra < 2 && text[pos] === quote; extra += 1) pos += 1
      return pos
    }
    pos += 1
  }
  throw new Error('unsupported TOML: unterminated string')
}

function spans(text: string): Span[] {
  const out: Span[] = []
  let start = 0
  let index = 0
  let line = 0
  let depth = 0
  for (let pos = 0; pos < text.length; pos += 1) {
    const char = text[pos]
    if (char === '"' || char === "'") {
      const end = stringEnd(text, pos)
      line += (text.slice(pos, end).match(/\n/g) ?? []).length
      pos = end - 1
    } else if (char === '#') {
      const end = text.indexOf('\n', pos)
      pos = (end < 0 ? text.length : end) - 1
    } else if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
    else if (char === '\n') {
      line += 1
      if (depth !== 0) continue
      out.push({ start, end: pos + 1, index, text: text.slice(start, pos).replace(/\r$/, '') })
      start = pos + 1
      index = line
    }
  }
  if (start < text.length) out.push({ start, end: text.length, index, text: text.slice(start) })
  return out
}

function keyParts(raw: string): string[] {
  const parts: string[] = []
  let pos = 0
  while (pos < raw.length) {
    while (/\s/.test(raw[pos] ?? '') && pos < raw.length) pos += 1
    let end: number
    if (raw[pos] === '"' || raw[pos] === "'") {
      end = stringEnd(raw, pos)
      const value = parse(`key=${raw.slice(pos, end)}`).key
      if (typeof value !== 'string') throw new Error('unsupported TOML key')
      parts.push(value)
    } else {
      const token = /^[\w-]+/.exec(raw.slice(pos))?.[0]
      if (!token) throw new Error('unsupported TOML key')
      parts.push(token)
      end = pos + token.length
    }
    pos = end
    while (pos < raw.length && /\s/.test(raw[pos] ?? '')) pos += 1
    if (pos === raw.length) break
    if (raw[pos++] !== '.') throw new Error('unsupported TOML key')
  }
  return parts
}

function assignmentEqual(text: string): number {
  for (let pos = 0; pos < text.length; pos += 1) {
    if (text[pos] === '"' || text[pos] === "'") pos = stringEnd(text, pos) - 1
    else if (text[pos] === '=') return pos
    else if (text[pos] === '#') break
  }
  return -1
}

function scan(text: string): { assignments: Assignment[]; statements: Span[]; firstTable: number } {
  const statements = spans(text)
  const assignments: Assignment[] = []
  let table: string[] | null = null
  let array = false
  const arrays: string[][] = []
  let firstTable = text.length
  for (const span of statements) {
    const trimmed = span.text.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('[')) {
      const header = /^(\[\[?)([\s\S]*?)(\]\]?)\s*(?:#.*)?$/.exec(trimmed)
      if (!header || header[1]?.length !== header[3]?.length)
        throw new Error('unsupported TOML table')
      table = keyParts((header[2] ?? '').trim())
      if (header[1] === '[[') arrays.push(table)
      const current = table
      array = arrays.some((parent) => parent.every((part, index) => current[index] === part))
      firstTable = Math.min(firstTable, span.start)
      continue
    }
    const equal = assignmentEqual(span.text)
    if (equal < 0) throw new Error('unsupported TOML assignment')
    const key = keyParts(span.text.slice(0, equal).trim())
    const value = parse(`value=${span.text.slice(equal + 1)}`).value
    assignments.push({ ...span, table, array, key, value })
  }
  return { assignments, statements, firstTable }
}

function asModel(span: Assignment): ModelLine | null {
  if (span.array || span.key.length !== 1 || !['model', 'review_model'].includes(span.key[0] ?? ''))
    return null
  if (span.table !== null && (span.table.length !== 2 || span.table[0] !== 'profiles')) return null
  if (typeof span.value !== 'string')
    throw new Error('unsupported TOML model value: expected string')
  return {
    index: span.index,
    table: span.table?.join('.') ?? null,
    key: span.key[0] as ModelLine['key'],
    value: span.value,
    text: span.text,
  }
}
export function modelLines(text: string): ModelLine[] {
  return scan(text).assignments.flatMap((span) => {
    const line = asModel(span)
    return line ? [line] : []
  })
}
export function nonGptModelLines(text: string): ModelLine[] {
  return modelLines(text).filter(
    (line) => line.value.trim() !== '' && !isCodexOpenAiModel(line.value.trim()),
  )
}
export function withoutLines(text: string, lines: readonly ModelLine[]): string {
  parse(text)
  const actual = scan(text).assignments
  const removals = lines.map((line) => {
    const span = actual.find((candidate) => candidate.index === line.index)
    const found = span && asModel(span)
    if (
      !span ||
      !found ||
      found.text !== line.text ||
      found.key !== line.key ||
      found.table !== line.table ||
      found.value !== line.value
    )
      throw new Error('stale or unsupported TOML removal')
    return span
  })
  let edited = text
  for (const span of [...new Set(removals)].sort((a, b) => b.start - a.start))
    edited = edited.slice(0, span.start) + edited.slice(span.end)
  parse(edited)
  return edited
}
export function topLevelKeys(text: string): string[] {
  return scan(text)
    .assignments.filter((span) => span.table === null && span.key.length === 1)
    .map((span) => span.key[0] ?? '')
}
export function duplicateTopLevelKeys(text: string): string[] {
  const keys = topLevelKeys(text)
  return [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))]
}
export function topLevelString(text: string, key: string): string | null {
  const value = scan(text).assignments.find(
    (span) => span.table === null && span.key.length === 1 && span.key[0] === key,
  )?.value
  return typeof value === 'string' ? value : null
}
export function insertTopLevelLine(text: string, index: number, line: string): string {
  parse(text)
  if (!Number.isSafeInteger(index) || /[\r\n]/.test(line))
    throw new Error('unsupported TOML insertion')
  const insert = scan(line)
  if (
    insert.assignments.length !== 1 ||
    insert.assignments[0]?.table !== null ||
    insert.assignments[0]?.key.length !== 1
  )
    throw new Error('expected one top-level TOML assignment')
  const { statements, firstTable } = scan(text)
  const offset = Math.min(
    firstTable,
    statements.find((span) => span.index >= Math.max(0, index))?.start ?? text.length,
  )
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const before = text.slice(0, offset)
  const edited =
    before + (before && !before.endsWith('\n') ? newline : '') + line + newline + text.slice(offset)
  parse(edited)
  return edited
}
