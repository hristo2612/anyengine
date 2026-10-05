import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { credentialInventory } from './accounts-credentials.mjs'
import { entry, metadataJson, privateDirectory, syncDir } from './accounts-files.mjs'
import { AccountMetadata } from './accounts-metadata.mjs'
import { fileStamp, verifyOverlay } from './accounts-overlay.mjs'
import { accountPaths, validateAccounts } from './accounts-store.mjs'
import { readM2Baseline } from './control-m2-upgrade.mjs'
import { shellQuote } from './control-scripts.mjs'

export function accountSnapshot(root: string, canonical: string) {
  const paths = accountPaths(root, canonical)
  const metadata = new AccountMetadata(paths, { readOnly: true })
  try {
    metadata.db.exec('BEGIN')
    const registry = metadata.read('registry')
    const value = validateAccounts(registry.value)
    const row = metadata.db.prepare('SELECT body FROM gate WHERE id=1').get()
    if (!row) throw new Error('Account gate missing')
    const gate = JSON.parse(String(row.body))
    const baseline = readM2Baseline(root, 'm3')
    const references = [
      'runtime.env',
      'state/layers.json',
      'm2-upgrade.json',
      'm3-upgrade.json',
    ].map((name) => {
      const path = join(root, name),
        stat = entry(path)
      return {
        path,
        mode: stat ? stat.mode & 0o777 : null,
        link: stat?.isSymbolicLink() ? readlinkSync(path) : null,
      }
    })
    return {
      version: 1,
      at: new Date().toISOString(),
      registry,
      limits: metadata.read('limits'),
      gate,
      journal: metadataJson(paths.journal) ?? null,
      credentials: credentialInventory(paths, value),
      overlay: Object.fromEntries(
        readdirSync(paths.canonical)
          .filter((name) => name !== 'auth.json')
          .map((name) => [name, fileStamp(join(paths.canonical, name))]),
      ),
      overlayConflicts: verifyOverlay(paths, value),
      references,
      m2BaselineId: baseline ? basename(baseline.rollbackDir) : null,
      recoveryCommand: baseline ? `/bin/bash ${shellQuote(baseline.recoveryScript)}` : null,
    }
  } finally {
    metadata.db.exec('ROLLBACK')
    metadata.close()
  }
}

export function backupAccountMetadata(root: string, canonical: string) {
  const snapshot = accountSnapshot(root, canonical)
  if (!snapshot.recoveryCommand)
    throw new Error('Prepare M3 recovery before creating its metadata backup')
  const id = randomUUID(),
    directory = join(root, 'recovery/account-metadata'),
    path = join(directory, `${id}.json`)
  privateDirectory(directory)
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify({ id, ...snapshot }, null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDir(directory)
  return { id, path, recoveryCommand: snapshot.recoveryCommand }
}
