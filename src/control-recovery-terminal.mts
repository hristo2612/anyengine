// A publication owns a durable copy of its exact pre-replacement journal.
// Older Bash entries can unlink the live journal; absence alone never retires
// their intent. Re-admit the same terminal evidence as ordinary layer retirement.
import { dirname, join } from 'node:path'
import { validateLayers } from './control-layer-journal.mjs'
import { beforeState, digest, sameState, statAt, stateAt } from './control-layer-state.mjs'
import { type LayerFile, POPPED, recoveryPaths } from './control-layers.mjs'
import { directDirectory, evidence } from './control-recovery-authority.mjs'

export const publicationJournalPath = (root: string, id: string) =>
  join(recoveryPaths(root).directory, 'publications', `${id}.layers.json`)

export function publicationJournal(root: string, id: string, sha: string) {
  const path = publicationJournalPath(root, id)
  const frozen = evidence(path, 0o600)
  if (digest(frozen.bytes) !== sha)
    throw new Error('recovery publication journal snapshot changed; preserve evidence')
  const file: unknown = JSON.parse(frozen.bytes.toString('utf8'))
  validateLayers(root, file)
  return { path, frozen, file }
}
export function terminalPublicationEvidence(root: string, file: LayerFile): string {
  validateLayers(root, file) // Backups remain authority after the live journal is gone.
  if (statAt(recoveryPaths(root).journal))
    throw new Error('missing terminal publication authority; preserve evidence')
  const markers = file.layers.map((layer) => {
    directDirectory(dirname(layer.rollbackDir))
    directDirectory(layer.rollbackDir)
    const marker = evidence(join(layer.rollbackDir, POPPED), 0o600)
    if (marker.bytes.length)
      throw new Error('invalid terminal publication marker; preserve evidence')
    return marker.identity
  })
  const target = join(root, 'bin/anyengine-off')
  directDirectory(dirname(target))
  const initial = file.layers.flatMap((layer) => layer.changes).find((c) => c.target === target)
  const observed = stateAt(target)
  if (initial ? !sameState(observed, beforeState(initial)) : observed.kind !== 'absent')
    throw new Error('terminal publication public baseline changed; preserve evidence')
  // Full Bash Off retires the M2 reference before deleting layers.json.
  // An absent layer journal cannot stand in for that independent retirement.
  if (statAt(join(root, 'm2-upgrade.json')))
    throw new Error('terminal publication retains milestone authority; preserve evidence')
  return JSON.stringify({ markers, public: observed })
}
