// Discover a recovery baseline from validated receipts and active guarded rc /
// shim evidence. Equivalent receipts are one baseline; conflicting baselines
// are refused. Operator receipts are read only and never selected by date alone.
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readLayers, validateLayers } from './control-layer-journal.mjs'
import {
  digest,
  type FileChange,
  jsonAt,
  keepBytes,
  type Layer,
  object,
  ownedDirectory,
  prepareDirectory,
  recoveryPaths,
  regularBytes,
  sha256Of,
  statAt,
  stateAt,
  text,
} from './control-layer-state.mjs'
import { findCodexCliBlock, withRcBlock } from './control-rc.mjs'
export type Adoption = { layer: Layer } | { refused: string } | null
type AdoptionPreview = { adoptedFrom: string } | { refused: string } | null
interface Entry {
  target: string
  backup: string
  mode: number
  bytes: Buffer
}
interface Candidate {
  dir: string
  entries: Entry[]
  fingerprint: string
}
function entryFor(entries: Entry[], target: string): Entry {
  const entry = entries.find((row) => row.target === target)
  if (!entry) throw new Error('incomplete M0 receipt')
  return entry
}
function readText(path: string): string {
  if (!statAt(path)) return ''
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(regularBytes(path))
}
export function m0Active(
  home: string,
  shimBackupSha: string | null,
): { rc: boolean; shim: boolean } {
  return {
    rc: findCodexCliBlock(readText(join(home, '.zshrc'))).state === 'active',
    shim:
      readText(join(home, 'bin/codex')).includes('(marker: ANYENGINE_ADAPTER)') &&
      shimBackupSha !== null &&
      sha256Of(join(home, 'bin/codex')) !== shimBackupSha,
  }
}
function modeOf(value: unknown): number {
  const mode =
    typeof value === 'string' && /^0?[0-7]{3,4}$/.test(value) ? Number.parseInt(value, 8) : value
  if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o7777)
    throw new Error('invalid M0 backup mode')
  return mode
}
function entriesAt(dir: string, targets: string[]): Entry[] | null {
  const manifest = jsonAt(join(dir, 'manifest.json'))
  if (manifest === undefined) return null
  if (!object(manifest) || !Array.isArray(manifest.entries) || !manifest.entries.every(object))
    throw new Error('invalid M0 manifest entries')
  const actual = manifest.entries.map((entry) => entry.target).sort()
  if (JSON.stringify(actual) !== JSON.stringify(targets)) return null
  const entries: Entry[] = []
  for (const entry of manifest.entries) {
    if (
      !text(entry.backup) ||
      basename(entry.backup) !== entry.backup ||
      ['.', '..'].includes(entry.backup)
    )
      throw new Error('invalid M0 backup path')
    const mode = modeOf(entry.mode)
    const path = join(dir, entry.backup)
    if (!statAt(path)) return null // An incomplete historical receipt proves nothing.
    entries.push({
      target: entry.target as string,
      backup: entry.backup,
      mode,
      bytes: regularBytes(path),
    })
  }
  return entries.sort((a, b) => a.target.localeCompare(b.target))
}
function candidates(root: string, home: string): Candidate[] {
  const targets = [
    join(home, '.zshrc'),
    join(home, 'bin/codex'),
    join(home, '.anyengine/runtime.env'),
  ].sort()
  if (!statAt(root)) return []
  const result: Candidate[] = []
  for (const name of readdirSync(root)
    .filter((name) => /^rollback-\d{8}T\d{6}Z$/.test(name))
    .sort()) {
    const dir = join(root, name)
    ownedDirectory(root, dir)
    const entries = entriesAt(dir, targets)
    if (!entries) continue
    const rc = entryFor(entries, join(home, '.zshrc'))
    const beforeRc = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rc.bytes)
    if (findCodexCliBlock(beforeRc).state === 'active') continue // Not an initial off-to-on receipt.
    const fingerprint = JSON.stringify(
      entries.map((entry) => [entry.target, digest(entry.bytes), entry.mode]),
    )
    result.push({ dir, entries, fingerprint })
  }
  return result
}
function currentSnapshots(home: string, candidate: Candidate) {
  // Read every current target before creating artifacts. No symlink/dangling
  // target can turn missing bytes into an apparently complete ladder.
  return candidate.entries.map((entry) => ({
    entry,
    now:
      entry.target === join(home, '.zshrc')
        ? Buffer.from(
            withRcBlock(
              new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.bytes),
            ).text,
          )
        : regularBytes(entry.target),
    mode: stateAt(entry.target).mode,
  }))
}
function adoptedLayer(root: string, home: string, candidate: Candidate, stamp: string): Layer {
  if (!/^[a-zA-Z0-9_-]+$/.test(stamp)) throw new Error('invalid rollback stamp')
  const dir = join(recoveryPaths(root).layers, `${stamp}-adapter`)
  ownedDirectory(root, dir)
  const snapshots = currentSnapshots(home, candidate)
  prepareDirectory(root, dir)
  const changes = snapshots.map(
    ({ entry, now, mode }): FileChange => ({
      target: entry.target,
      before: 'file',
      backup: keepBytes(dir, entry.bytes),
      mode: entry.mode,
      beforeSha: digest(entry.bytes),
      beforeLink: null,
      after: keepBytes(dir, now),
      afterSha: digest(now),
      afterLink: null,
      afterMode: mode,
      pending: null,
    }),
  )
  const layer: Layer = {
    name: 'adapter',
    rollbackDir: dir,
    adoptedFrom: candidate.dir,
    createdAt: new Date().toISOString(),
    changes,
    jobs: [],
    cleansCache: false,
  }
  validateLayers(root, { version: 1, layers: [layer] })
  return layer
}
function selectM0(root: string, home: string): Candidate | { refused: string } | null {
  readLayers(root)
  const receipts = candidates(root, home)
  const candidate = receipts[0]
  if (!candidate) return null
  const active = receipts.map((candidate) => ({
    candidate,
    active: m0Active(home, digest(entryFor(candidate.entries, join(home, 'bin/codex')).bytes)),
  }))
  if (active.every((row) => !row.active.rc && !row.active.shim)) return null
  if (active.some((row) => !row.active.rc || !row.active.shim))
    return {
      refused: 'M0 is half on or conflicting with a receipt; finish or undo it by hand first',
    }
  if (new Set(receipts.map((row) => row.fingerprint)).size !== 1)
    return { refused: 'ambiguous M0 receipts contain conflicting recovery baselines' }
  return candidate
}
function invalidEvidence(error: unknown): { refused: string } {
  return {
    refused: `invalid M0 recovery evidence; preserve receipts: ${error instanceof Error ? error.message : String(error)}`,
  }
}
export function inspectM0(root: string, home: string): AdoptionPreview {
  try {
    const candidate = selectM0(root, home)
    if (!candidate || 'refused' in candidate) return candidate
    currentSnapshots(home, candidate) // Validate current bytes without creating a layer or backup.
    return { adoptedFrom: candidate.dir }
  } catch (error) {
    return invalidEvidence(error)
  }
}
export function adoptM0(root: string, home: string, stamp: string): Adoption {
  try {
    const candidate = selectM0(root, home)
    return candidate && !('refused' in candidate)
      ? { layer: adoptedLayer(root, home, candidate, stamp) }
      : candidate
  } catch (error) {
    return invalidEvidence(error)
  }
}
