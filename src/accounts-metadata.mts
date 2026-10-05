import { chmodSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  durableJson,
  entry,
  metadataJson,
  privateDirectory,
  privateFile,
} from './accounts-files.mjs'
import { validateAccounts } from './accounts-store.mjs'
import type { AccountPaths, AccountRegistry } from './accounts-types.mjs'

export interface MetadataDocument<T> {
  revision: number
  value: T
}
type Name = 'registry' | 'limits'
type Row = { revision: number; body: string }
export class AccountMetadata {
  readonly db: DatabaseSync
  readonly paths: AccountPaths
  private transaction = false
  constructor(paths: AccountPaths, options: { readOnly?: boolean } = {}) {
    this.paths = paths
    privateDirectory(paths.root, !options.readOnly)
    for (const path of [
      paths.ledger,
      `${paths.ledger}-wal`,
      `${paths.ledger}-shm`,
      paths.registry,
      paths.limits,
    ])
      privateFile(path)
    if (options.readOnly && !entry(paths.ledger))
      throw new Error('Account metadata not initialized')
    this.db = new DatabaseSync(paths.ledger, { readOnly: options.readOnly, timeout: 5000 })
    if (!options.readOnly) {
      chmodSync(paths.ledger, 0o600)
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS metadata(name TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projection(name TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);`)
    }
  }
  tx<T>(fn: () => T): T {
    if (this.transaction) throw new Error('Nested account metadata transaction')
    this.db.exec('BEGIN IMMEDIATE')
    this.transaction = true
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.transaction = false
    }
  }
  read<T>(name: Name): MetadataDocument<T> {
    const row = this.db.prepare('SELECT revision,body FROM metadata WHERE name=?').get(name) as
      | Row
      | undefined
    if (!row) throw new Error(`Account metadata missing: ${name}`)
    return { revision: row.revision, value: JSON.parse(row.body) as T }
  }
  initialize(name: Name, value: unknown): void {
    this.tx(() => {
      if (this.db.prepare('SELECT 1 FROM metadata WHERE name=?').get(name)) return
      const path = name === 'registry' ? this.paths.registry : this.paths.limits
      const imported = metadataJson(path)
      const initial = imported ?? value
      if (name === 'registry') validateAccounts(initial)
      const body = JSON.stringify(initial)
      this.db.prepare('INSERT INTO metadata VALUES (?,1,?)').run(name, body)
      if (imported !== undefined)
        this.db.prepare('INSERT INTO projection VALUES (?,1,?)').run(name, body)
    })
  }
  mutate<T>(name: Name, change: (value: T) => T): MetadataDocument<T> {
    if (!this.transaction) throw new Error('Account mutation requires transaction')
    const current = this.read<T>(name)
    const value = change(current.value)
    if (name === 'registry') validateAccounts(value)
    this.db
      .prepare('UPDATE metadata SET revision=?,body=? WHERE name=? AND revision=?')
      .run(current.revision + 1, JSON.stringify(value), name, current.revision)
    return { revision: current.revision + 1, value }
  }
  editRegistry(
    change: (value: AccountRegistry) => AccountRegistry,
  ): MetadataDocument<AccountRegistry> {
    return this.tx(() => {
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gate'").get()) {
        const row = this.db.prepare('SELECT body FROM gate WHERE id=1').get()
        if (row && !['open', 'draining'].includes(JSON.parse(String(row.body)).phase))
          throw new Error('Account metadata sealed for transition')
      }
      return this.mutate<AccountRegistry>('registry', (before) => {
        const after = change(structuredClone(before))
        if (after.active !== before.active || after.generation !== before.generation)
          throw new Error('Active account changes require the transition gate')
        return after
      })
    })
  }
  project(): void {
    // Serialize the snapshot and replacement with writers; never project stale rows.
    this.tx(() => {
      for (const name of ['registry', 'limits'] as const) {
        const row = this.read<unknown>(name)
        const path = name === 'registry' ? this.paths.registry : this.paths.limits
        const previous = this.db
          .prepare('SELECT revision,body FROM projection WHERE name=?')
          .get(name) as Row | undefined
        const existing = metadataJson(path)
        if (
          existing !== undefined &&
          JSON.stringify(existing) !== previous?.body &&
          JSON.stringify(existing) !== JSON.stringify(row.value)
        )
          throw new Error(`Account projection edited outside the CLI; preserved: ${name}`)
        durableJson(path, row.value)
        this.db
          .prepare(
            'INSERT INTO projection VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,body=excluded.body',
          )
          .run(name, row.revision, JSON.stringify(row.value))
      }
    })
  }
  metadataBackup(): {
    registry: MetadataDocument<AccountRegistry>
    limits: MetadataDocument<unknown>
  } {
    return this.tx(() => ({ registry: this.read('registry'), limits: this.read('limits') }))
  }
  close(): void {
    this.db.close()
  }
}
