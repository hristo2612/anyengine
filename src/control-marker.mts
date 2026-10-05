// A flip in progress. Task26 writes this before the first change and clears
// it only after terminal verification. Invalid evidence remains recoverable.
// Task26 must capture processStart from System.processes(), and separately
// enforce its async lock's start/token/inode ownership; markerAlive is an
// observation, never authority to unlink a lock or prune recovery evidence.
import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { enginePaths, writeJsonAtomic } from './anyengine-config.mjs'
import { adapterArguments, type System } from './control-system.mjs'

export type FlipOp = 'on' | 'off' | 'restart'
export interface FlipMarker {
  id: string
  op: FlipOp
  args: string[]
  pid: number
  processStart: string
  runner: 'detached' | 'foreground'
  phase: string
  startedAt: string
  updatedAt: string
  log: string
  state: Record<string, unknown>
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const timestamp = (value: unknown) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value)

function validate(value: unknown): asserts value is FlipMarker {
  if (!object(value)) throw new Error('invalid flip marker object')
  const fields = new Set([
    'id',
    'op',
    'args',
    'pid',
    'processStart',
    'runner',
    'phase',
    'startedAt',
    'updatedAt',
    'log',
    'state',
  ])
  if (Object.keys(value).some((key) => !fields.has(key)))
    throw new Error('unsupported flip marker fields')
  const valid =
    text(value.id) &&
    /^[a-zA-Z0-9._-]{1,128}$/.test(value.id) &&
    typeof value.op === 'string' &&
    ['on', 'off', 'restart'].includes(value.op) &&
    Array.isArray(value.args) &&
    value.args.every(text) &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    timestamp(value.processStart) &&
    typeof value.runner === 'string' &&
    ['detached', 'foreground'].includes(value.runner) &&
    text(value.phase) &&
    timestamp(value.startedAt) &&
    timestamp(value.updatedAt) &&
    text(value.log) &&
    isAbsolute(value.log) &&
    object(value.state)
  if (!valid)
    throw new Error('invalid or unsupported flip marker fields; preserve recovery evidence')
  if (
    object(value.state) &&
    Object.hasOwn(value.state, 'runnerId') &&
    (typeof value.state.runnerId !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.state.runnerId))
  )
    throw new Error('invalid detached runner identity')
  const serialized = JSON.stringify(
    value,
    (_key, field: unknown) => {
      if (
        field === undefined ||
        typeof field === 'function' ||
        typeof field === 'symbol' ||
        typeof field === 'bigint' ||
        (typeof field === 'number' && !Number.isFinite(field))
      )
        throw new Error('invalid flip marker state: requires JSON values')
      return field
    },
    2,
  )
  // Match writeJsonAtomic's pretty JSON and trailing newline before publication.
  if (Buffer.byteLength(`${serialized}\n`) > 2_000_000)
    throw new Error('flip marker exceeds the recoverable size limit')
}

export function flipMarkerPath(root: string): string {
  return join(enginePaths(root).state, 'flip.json')
}

export function readFlipMarker(root: string): FlipMarker | null {
  const path = flipMarkerPath(root)
  let present = false
  try {
    const stat = lstatSync(path)
    present = true
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error('unsupported marker file')
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)),
    )
    validate(value)
    return value
  } catch (error) {
    if (!present && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`cannot read flip marker ${path}; preserve recovery evidence`, { cause: error })
  }
}

export function writeFlipMarker(root: string, marker: FlipMarker): void {
  validate(marker)
  const current = readFlipMarker(root)
  if (current && current.id !== marker.id)
    throw new Error('another flip marker requires recovery first')
  writeJsonAtomic(flipMarkerPath(root), marker)
}

export function clearFlipMarker(root: string): void {
  if (readFlipMarker(root)) unlinkSync(flipMarkerPath(root))
}

export function markerAlive(marker: FlipMarker, system: System): boolean {
  validate(marker)
  const process = system.processes().find((candidate) => candidate.pid === marker.pid)
  if (!process || process.processStart !== marker.processStart) return false
  const invocation = adapterArguments(process.command)
  if (!invocation) return false
  const actual = invocation.args
  if (marker.runner === 'foreground') {
    if (actual.filter((arg) => arg === '--foreground').length !== 1) return false
    const args = actual.filter((arg) => arg !== '--foreground')
    const expected = [marker.op, ...marker.args.filter((arg) => arg !== '--foreground')]
    if (args.length === expected.length && args.every((arg, index) => arg === expected[index]))
      return true
    // ps flattens argv without quoting spaces. Compare the complete expected
    // command at real argument boundaries; the async lock remains authority.
    for (let index = 1; index <= expected.length; index += 1) {
      const withFlag = [...expected.slice(0, index), '--foreground', ...expected.slice(index)]
      if (invocation.rawArgs === withFlag.join(' ')) return true
    }
    return false
  }
  const expected = [
    'flip-run',
    String(marker.state.runnerId ?? marker.id),
    marker.op,
    ...marker.args,
  ]
  return (
    invocation.rawArgs === expected.join(' ') ||
    (actual.length === expected.length && actual.every((arg, index) => arg === expected[index]))
  )
}
