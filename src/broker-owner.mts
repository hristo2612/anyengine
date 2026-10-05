// The router borrows adapter channels or owns one zero-turn official child.
import { chmodSync, lstatSync, realpathSync, watch } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brokerSourceDir, connectBrokerSource, readBrokerSources } from './broker-source.mjs'
import type { ActiveAccount, AuthSource, BrokerOwner, SourceSelection } from './broker-types.mjs'

type Connection = AuthSource & {
  close(): Promise<void>
  onClose?(listener: () => void): () => void
}
const fail = (code = 'no-source') => new Error(`broker.${code}`)

export function createBrokerOwner(input: {
  root: string
  account: () => ActiveAccount
  launch: (home: string) => Promise<Connection>
}): BrokerOwner {
  const dir = brokerSourceDir(input.root, true)
  const clients = new Map<string, Connection>()
  const listeners = new Set<(selection: SourceSelection) => void>()
  let selected: Connection | null = null,
    standalone: Connection | null = null
  let revision = 0,
    epoch = 0,
    closed = false,
    paused: ActiveAccount | null = null
  let lock: DatabaseSync | null = null
  let standaloneClosing: Promise<void> | null = null
  let unsubscribeStandalone: (() => void) | null = null
  let cleanupFailed = false
  let selecting: Promise<SourceSelection & { source: AuthSource }> | null = null
  let stopping: Promise<void> | null = null,
    closing: Promise<void> | null = null
  const pendingClose = new Set<Promise<void>>()

  function account(): ActiveAccount {
    try {
      const current = input.account()
      if (!Number.isSafeInteger(current.generation) || current.generation < 0) throw fail()
      return { home: realpathSync(current.home), generation: current.generation }
    } catch {
      throw fail()
    }
  }
  function matches(source: AuthSource, current: ActiveAccount): boolean {
    return source.home === current.home && source.generation === current.generation
  }
  function publish(next: Connection | null, force = false): void {
    if (!force && selected === next) return
    selected = next
    revision++
    for (const listener of listeners) {
      try {
        listener({ revision, source: selected })
      } catch {
        /* One observer cannot block invalidation. */
      }
    }
  }
  function closeClient(client: Connection): void {
    const pending = client.close().catch(() => {
      throw fail('source-unavailable')
    })
    pendingClose.add(pending)
    void pending.catch(() => {}).finally(() => pendingClose.delete(pending))
  }
  function releaseLock(): void {
    const owned = lock
    lock = null
    if (owned) {
      try {
        owned.exec('ROLLBACK')
      } finally {
        owned.close()
      }
    }
  }
  function acquireLock(): void {
    const path = join(dir, '..', 'owner-lock.sqlite')
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid?.())
        throw fail('unsafe-directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const gate = new DatabaseSync(path, { timeout: 0 })
    try {
      chmodSync(path, 0o600)
      gate.exec('BEGIN IMMEDIATE')
      lock = gate
    } catch {
      gate.close()
      throw fail('owner-busy')
    }
  }
  function stopStandalone(): Promise<void> {
    if (standaloneClosing) return standaloneClosing
    const owned = standalone
    if (!owned) return Promise.resolve()
    if (selected === owned) publish(null)
    unsubscribeStandalone?.()
    unsubscribeStandalone = null
    const operation = (async () => {
      try {
        await owned.close()
      } catch {
        cleanupFailed = true
        throw fail('source-unavailable')
      }
      standalone = null
      cleanupFailed = false
      releaseLock()
    })()
    standaloneClosing = operation
    void operation
      .finally(() => {
        if (standaloneClosing === operation) standaloneClosing = null
      })
      .catch(() => {})
    return operation
  }
  function best(current: ActiveAccount): Connection | null {
    for (const metadata of readBrokerSources(input.root, current)) {
      const client = clients.get(metadata.id)
      if (client && matches(client, current)) return client
    }
    return null
  }
  function current(): SourceSelection {
    let active: ActiveAccount
    try {
      active = account()
    } catch {
      publish(null)
      return { revision, source: null }
    }
    const registrations = new Set(readBrokerSources(input.root, active).map((source) => source.id))
    for (const [id, client] of clients) {
      if (!registrations.has(id) || !matches(client, active)) {
        clients.delete(id)
        closeClient(client)
      }
    }
    if (
      selected &&
      (!matches(selected, active) || (selected.kind !== 'standalone' && !clients.has(selected.id)))
    ) {
      publish(best(active))
    }
    return { revision, source: selected }
  }
  async function connectCandidates(active: ActiveAccount, started: number): Promise<void> {
    // Keep ready alternatives connected so loss of A can publish B synchronously.
    await Promise.all(
      readBrokerSources(input.root, active).map(async (metadata) => {
        if (clients.has(metadata.id)) return
        let connection: Connection | null = null
        try {
          connection = await connectBrokerSource(metadata, () => {
            const previous = clients.get(metadata.id)
            if (previous) clients.delete(metadata.id)
            if (selected?.id === metadata.id) publish(best(account()))
          })
          if (
            closed ||
            started !== epoch ||
            !matches(connection, account()) ||
            !readBrokerSources(input.root, active).some((row) => row.id === metadata.id)
          ) {
            await connection.close()
            return
          }
          clients.set(metadata.id, connection)
        } catch {
          await connection?.close()
        }
      }),
    )
  }
  function unchanged(active: ActiveAccount, started: number): boolean {
    const latest = account()
    return (
      !closed &&
      started === epoch &&
      active.home === latest.home &&
      active.generation === latest.generation
    )
  }
  async function ensureStandalone(active: ActiveAccount, started: number): Promise<void> {
    if (standaloneClosing) await standaloneClosing
    if (cleanupFailed) throw fail('source-unavailable')
    if (standalone && !matches(standalone, active)) await stopStandalone()
    if (standalone) return
    await Promise.all([...pendingClose])
    if (!unchanged(active, started)) throw fail('source-changed')
    acquireLock()
    try {
      const launched = await input.launch(active.home)
      // Ownership includes a late launch until its actual close has succeeded.
      standalone = launched
      if (!matches(launched, active) || !unchanged(active, started)) {
        await stopStandalone()
        throw fail('source-changed')
      }
      unsubscribeStandalone =
        launched.onClose?.(() => {
          if (selected === launched) publish(null)
          void stopStandalone().catch(() => {})
        }) ?? null
      if (standaloneClosing) await standaloneClosing
      if (!standalone || cleanupFailed) throw fail('source-unavailable')
    } catch (error) {
      if (!standalone) releaseLock()
      if (error instanceof Error && error.message === 'broker.source-changed') throw error
      throw fail('source-unavailable')
    }
  }
  async function select(): Promise<SourceSelection & { source: AuthSource }> {
    const active = account(),
      started = epoch
    if (
      closed ||
      (paused && paused.home === active.home && paused.generation === active.generation)
    )
      throw fail()
    paused = null
    current()
    await connectCandidates(active, started)
    if (closed || started !== epoch) throw fail()
    if (active.home !== account().home || active.generation !== account().generation)
      throw fail('source-changed')
    const adapter = best(active)
    if (adapter) {
      await stopStandalone()
      if (closed || started !== epoch || !clients.has(adapter.id)) throw fail('source-changed')
      publish(adapter)
    } else {
      await ensureStandalone(active, started)
      publish(standalone)
    }
    if (!selected) throw fail()
    return { revision, source: selected }
  }
  function source(): Promise<SourceSelection & { source: AuthSource }> {
    if (closed) return Promise.reject(fail())
    if (stopping) return stopping.then(() => source())
    if (selecting) return selecting
    const flight = select()
    selecting = flight
    void flight
      .finally(() => {
        if (selecting === flight) selecting = null
      })
      .catch(() => {})
    return flight
  }
  const watcher = watch(dir, () => {
    if (!closed && !paused && (selected || selecting)) void source().catch(() => {})
  })
  watcher.on('error', () => {
    publish(null, true)
  })

  function stopSources(): Promise<void> {
    if (stopping) return stopping
    try {
      paused = account()
    } catch {
      paused = null
    }
    epoch++
    publish(null, true)
    const flight = selecting
    const operation = (async () => {
      let failedJoin = false
      await flight?.catch(() => {
        failedJoin = cleanupFailed
      })
      if (failedJoin) throw fail('source-unavailable')
      const borrowed = [...clients.values()]
      clients.clear()
      await Promise.all([...borrowed.map((client) => client.close()), ...pendingClose])
      await stopStandalone()
    })()
    stopping = operation
    void operation
      .finally(() => {
        if (stopping === operation) stopping = null
      })
      .catch(() => {})
    return operation
  }
  return {
    current,
    source,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stopSources,
    close() {
      if (closing) return closing
      closed = true
      watcher.close()
      closing = stopSources().finally(() => listeners.clear())
      return closing
    },
  }
}
