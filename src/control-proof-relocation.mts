// Relocate source references and publisher pins before isolated proof recovery.
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicFile, digest, statAt } from './control-layer-state.mjs'
import { readLayers, recoveryPaths, writeLayers } from './control-layers.mjs'
import type { Scratch, SourceSnapshot } from './control-proof-snapshot.mjs'
import { offScript, publishRecovery, type RecoveryOptions } from './control-scripts.mjs'

export function relocated(source: SourceSnapshot, home: string) {
  const pairs = new Map<string, string>([
    [source.home, home],
    [source.root, join(home, '.anyengine')],
    [source.paths.codexHome, join(home, '.codex')],
    [source.plan.app, join(home, 'Applications/Proof.app')],
    [source.plan.node, join(home, '.proof-tools/node')],
  ])
  if (source.plan.claudeCli) pairs.set(source.plan.claudeCli, join(home, '.proof-tools/claude'))
  if (!source.paths.pickFile.startsWith(`${source.paths.codexHome}/`))
    pairs.set(source.paths.pickFile, join(home, '.proof-pick/app-model-pick.json'))
  for (const path of [
    source.plan.libDir,
    resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    ...(source.journal.recovery?.pinnedLibs ?? []),
  ])
    if (![...pairs.keys()].some((p) => path === p || path.startsWith(`${p}/`)))
      pairs.set(path, join(home, '.proof-references', digest(Buffer.from(path)).slice(0, 16)))
  const map = (path: string): string => {
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new Error(`invalid relocation path: ${path}`)
    const match = [...pairs]
      .sort(([a], [b]) => b.length - a.length)
      .find(([from]) => path === from || path.startsWith(`${from}/`))
    if (!match) throw new Error(`unowned absolute target cannot be relocated: ${path}`)
    return `${match[1]}${path.slice(match[0].length)}`
  }
  const transform = (bytes: Buffer): Buffer => {
    // File data remains opaque unless it is valid text containing a relocated reference.
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      return bytes
    }
    for (const [from, to] of [...pairs].sort(([a], [b]) => b.length - a.length))
      text = text.replaceAll(from, to)
    return Buffer.from(text)
  }
  return { map, transform }
}
// Source publishers run in this process. Relocate their attribution before
// scratch recovery executes, just as every copied source pin is relocated.
export function relocateRecoveryPins(scratch: Scratch): void {
  const file = readLayers(scratch.root)
  const recovery = file.recovery
  if (!recovery) return
  const move = (path: string) => (path.startsWith(`${scratch.home}/`) ? path : scratch.map(path))
  const controlLib = move(recovery.controlLib)
  const pinnedLibs = [...new Set(recovery.pinnedLibs.map(move))]
  if (
    controlLib === recovery.controlLib &&
    pinnedLibs.every((pin, index) => pin === recovery.pinnedLibs[index])
  )
    return
  file.recovery = { ...recovery, controlLib, pinnedLibs }
  writeLayers(scratch.root, file)
}

// These controllers generate scratch bytes in this process. Before a scratch
// publication, attribute its regenerated entry to that actual generator; after
// publication relocate the pins again before any recovery implementation runs.
export function prepareScratchPublisher(scratch: Scratch): void {
  const file = readLayers(scratch.root)
  if (!file.recovery) return
  const controlLib = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  file.recovery = {
    ...file.recovery,
    controlLib,
    pinnedLibs: [...new Set([...file.recovery.pinnedLibs, controlLib])],
  }
  writeLayers(scratch.root, file)
}

// The constructor deliberately regenerates recovery instead of copying source
// executable bytes. Seed that missing scratch entry before the normal publisher
// requires retained physical evidence; scratch is not exposed until it returns.
export function publishScratchRecovery(scratch: Scratch, options: RecoveryOptions): void {
  const paths = recoveryPaths(scratch.root)
  const file = readLayers(scratch.root)
  if (file.recovery && !statAt(paths.entry)) {
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 })
    atomicFile(paths.entry, Buffer.from(offScript(file.layers, options)), 0o700)
  }
  prepareScratchPublisher(scratch)
  publishRecovery(options)
  relocateRecoveryPins(scratch)
}
