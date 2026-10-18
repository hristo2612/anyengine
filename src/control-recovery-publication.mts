// Write-ahead attribution for private recovery replacement. The strict layers
// schema stays readable by older Bash entries throughout publication.
import { randomUUID } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { validateLayers } from './control-layer-journal.mjs'
import {
  absolute,
  atomicFile,
  digest,
  object,
  statAt,
  syncDirectory,
} from './control-layer-state.mjs'
import { type LayerFile, readLayers, recoveryPaths, writeLayers } from './control-layers.mjs'
import { directDirectory, evidence } from './control-recovery-authority.mjs'
import {
  controllerIdentity,
  generationOptions,
  sameControllerIdentity,
} from './control-recovery-generation.mjs'
import {
  publicationJournal,
  publicationJournalPath,
  terminalPublicationEvidence,
} from './control-recovery-terminal.mjs'
import type { RecoveryOptions } from './control-scripts.mjs'

interface Intent {
  version: 1
  id: string
  previousControlLib: string
  controlLib: string
  journalBefore: string
  journalAfter: string
  entryBefore: string
  entryAfter: string
  entryPath: string
  entryMode: 0o700
  journalPath: string
  journalMode: 0o600
  previousController: ReturnType<typeof controllerIdentity>
  controller: ReturnType<typeof controllerIdentity>
  generation: ReturnType<typeof generationOptions>
}
const intentKeys = [
  'version',
  'id',
  'previousControlLib',
  'controlLib',
  'journalBefore',
  'journalAfter',
  'entryBefore',
  'entryAfter',
  'entryPath',
  'entryMode',
  'journalPath',
  'journalMode',
  'previousController',
  'controller',
  'generation',
]
const bytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const publicationPath = (root: string) =>
  join(recoveryPaths(root).directory, 'publication.json')

function intentAt(root: string) {
  const path = publicationPath(root)
  if (!statAt(path)) return undefined
  const frozen = evidence(path, 0o600)
  const value: unknown = JSON.parse(frozen.bytes.toString('utf8'))
  if (
    !object(value) ||
    Object.keys(value).length !== intentKeys.length ||
    Object.keys(value).some((key) => !intentKeys.includes(key)) ||
    value.version !== 1 ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id) ||
    !absolute(value.previousControlLib) ||
    !absolute(value.controlLib) ||
    value.entryPath !== recoveryPaths(root).entry ||
    value.entryMode !== 0o700 ||
    value.journalPath !== recoveryPaths(root).journal ||
    value.journalMode !== 0o600 ||
    ![value.journalBefore, value.journalAfter, value.entryBefore, value.entryAfter].every(sha)
  )
    throw new Error('invalid recovery publication intent; preserve evidence')
  const generation = generationOptions(value.generation)
  if (generation.root !== root || JSON.stringify(generation) !== JSON.stringify(value.generation))
    throw new Error('unrelated recovery publication generation; preserve evidence')
  return { value: value as unknown as Intent, frozen, path }
}
function journalAt(root: string) {
  const path = recoveryPaths(root).journal
  const frozen = evidence(path, 0o600)
  const file: unknown = JSON.parse(frozen.bytes.toString('utf8'))
  validateLayers(root, file)
  readLayers(root) // Physical layer directories/backups/POPPED remain mandatory.
  return { frozen, file }
}
function withController(file: LayerFile, controlLib: string): LayerFile {
  if (!file.recovery) throw new Error('publication requires retained recovery authority')
  return { ...file, recovery: { ...file.recovery, controlLib } }
}

export function inspectRecoveryPublication(root: string) {
  const active = intentAt(root)
  if (!active) return undefined
  for (const dir of [root, dirname(recoveryPaths(root).journal), recoveryPaths(root).directory])
    directDirectory(dir)
  const { value, frozen, path } = active
  const controllersUnchanged = () => {
    if (
      !sameControllerIdentity(value.previousController, value.previousControlLib) ||
      !sameControllerIdentity(value.controller, value.controlLib)
    )
      throw new Error('recovery publication controller changed; preserve evidence')
  }
  controllersUnchanged()
  const backup = publicationJournal(root, value.id, value.journalBefore)
  const terminal = !statAt(recoveryPaths(root).journal)
  const journal = terminal ? backup : { ...journalAt(root), path: recoveryPaths(root).journal }
  const terminalEvidence = terminal ? terminalPublicationEvidence(root, backup.file) : undefined
  const entry = evidence(recoveryPaths(root).entry, 0o700)
  const before = withController(journal.file, value.previousControlLib)
  const after = withController(journal.file, value.controlLib)
  if (
    !journal.file.recovery?.pinnedLibs.includes(value.controlLib) ||
    !journal.file.recovery.pinnedLibs.includes(value.previousControlLib) ||
    digest(bytes(before)) !== value.journalBefore ||
    digest(bytes(after)) !== value.journalAfter ||
    ![value.journalBefore, value.journalAfter].includes(digest(journal.frozen.bytes))
  )
    throw new Error('unrelated recovery publication journal; preserve evidence')
  const entrySha = digest(entry.bytes)
  const controlLib = entrySha === value.entryAfter ? value.controlLib : value.previousControlLib
  if (
    ![value.entryBefore, value.entryAfter].includes(entrySha) ||
    (digest(journal.frozen.bytes) !== value.journalBefore && entrySha !== value.entryAfter)
  )
    throw new Error('recovery publication entry changed; preserve evidence')
  const history = join(recoveryPaths(root).directory, 'publications')
  directDirectory(history)
  const receipt = join(history, `${digest(frozen.bytes)}.json`)
  const priorReceipt = statAt(receipt) ? evidence(receipt, 0o600) : undefined
  if (
    priorReceipt &&
    (!priorReceipt.bytes.equals(frozen.bytes) || lstatSync(receipt).ino !== lstatSync(path).ino)
  )
    throw new Error('recovery publication receipt conflict; preserve evidence')
  const unchanged = () => {
    controllersUnchanged()
    for (const dir of [
      root,
      dirname(recoveryPaths(root).journal),
      recoveryPaths(root).directory,
      history,
    ])
      directDirectory(dir)
    if (
      (priorReceipt
        ? evidence(receipt, 0o600).identity !== priorReceipt.identity
        : statAt(receipt) !== undefined) ||
      evidence(path, 0o600).identity !== frozen.identity ||
      evidence(backup.path, 0o600).identity !== backup.frozen.identity ||
      (terminal
        ? terminalPublicationEvidence(root, backup.file) !== terminalEvidence
        : evidence(journal.path, 0o600).identity !== journal.frozen.identity) ||
      evidence(recoveryPaths(root).entry, 0o700).identity !== entry.identity
    )
      throw new Error('recovery publication changed; preserve evidence')
  }
  return {
    controlLib,
    terminal,
    journalPath: journal.path,
    file: journal.file,
    generation: value.generation,
    unchanged,
    settle(checkpoint: () => void = () => {}) {
      unchanged()
      const settled = withController(journal.file, controlLib)
      if (!terminal && digest(bytes(settled)) !== digest(journal.frozen.bytes))
        writeLayers(root, settled)
      checkpoint()
      // Retain the entire intent as an immutable receipt before retiring its
      // active name. A crash after link but before unlink is safe to retry.
      if (statAt(receipt)) {
        if (!evidence(receipt, 0o600).bytes.equals(frozen.bytes))
          throw new Error('recovery publication receipt conflict; preserve evidence')
      } else linkSync(path, receipt)
      syncDirectory(history)
      if (
        !evidence(path, 0o600).bytes.equals(frozen.bytes) ||
        lstatSync(path).ino !== lstatSync(receipt).ino ||
        !evidence(recoveryPaths(root).entry, 0o700).bytes.equals(entry.bytes) ||
        (terminal
          ? terminalPublicationEvidence(root, backup.file) !== terminalEvidence
          : !evidence(journal.path, 0o600).bytes.equals(bytes(settled))) ||
        evidence(backup.path, 0o600).identity !== backup.frozen.identity
      )
        throw new Error('recovery settlement changed; preserve evidence')
      unlinkSync(path)
      syncDirectory(recoveryPaths(root).directory)
    },
  }
}

export function assertNoRecoveryPublication(root: string): void {
  if (statAt(publicationPath(root)))
    throw new Error('unfinished recovery publication; run Off before another publication')
}

// Must finish before the first entry rename. Pin the incoming controller while
// retaining the old controller attribution, then fsync an intent for both states.
export function beginRecoveryPublication(
  root: string,
  controlLib: string,
  script: Buffer,
  options: RecoveryOptions,
): boolean {
  assertNoRecoveryPublication(root)
  const file = readLayers(root)
  if (!file.recovery) return false
  for (const dir of [root, dirname(recoveryPaths(root).journal), recoveryPaths(root).directory])
    directDirectory(dir)
  const entry = evidence(recoveryPaths(root).entry, 0o700)
  if (file.recovery.controlLib === controlLib && entry.bytes.equals(script)) return false
  const previousController = controllerIdentity(file.recovery.controlLib)
  const controller = controllerIdentity(controlLib)
  const generation = generationOptions(options)
  if (generation.root !== root) throw new Error('publication generation root mismatch')
  if (!file.recovery.pinnedLibs.includes(controlLib)) {
    file.recovery.pinnedLibs.push(controlLib)
    writeLayers(root, file)
  }
  const journal = journalAt(root)
  // Re-serialization must describe the exact pinned journal; never bind an
  // intent to normalized or filtered authority that was not actually installed.
  if (!journal.frozen.bytes.equals(bytes(journal.file)))
    throw new Error('noncanonical publication journal; preserve evidence')
  const history = join(recoveryPaths(root).directory, 'publications')
  if (!statAt(history)) {
    mkdirSync(history, { mode: 0o700 })
    syncDirectory(recoveryPaths(root).directory)
  }
  directDirectory(history)
  const previousControlLib = journal.file.recovery?.controlLib
  if (!previousControlLib) throw new Error('missing publication controller; preserve evidence')
  const value: Intent = {
    version: 1,
    id: randomUUID(),
    previousControlLib,
    controlLib,
    journalBefore: digest(journal.frozen.bytes),
    journalAfter: digest(bytes(withController(journal.file, controlLib))),
    entryBefore: digest(entry.bytes),
    entryAfter: digest(script),
    entryPath: recoveryPaths(root).entry,
    entryMode: 0o700,
    journalPath: recoveryPaths(root).journal,
    journalMode: 0o600,
    previousController,
    controller,
    generation,
  }
  // Persist the bound journal first. Even a pre-replacement older Bash can
  // complete full Off without knowing this sidecar or changing its schema.
  atomicFile(publicationJournalPath(root, value.id), journal.frozen.bytes, 0o600)
  atomicFile(publicationPath(root), bytes(value), 0o600)
  return true
}
