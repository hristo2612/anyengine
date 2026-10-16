// The router owns its GPT credential source: the active account's Codex login,
// read from disk on every use (broker-file.mts). It never borrows an app or
// adapter process, so no other project's lifetime decides which bearer the
// router holds, and no bearer crosses a socket between processes.
import { realpathSync } from 'node:fs'
import { createFileAuthSource, type OfficialAuth } from './broker-file.mjs'
import type { ActiveAccount, AuthSource, BrokerOwner, SourceSelection } from './broker-types.mjs'

const fail = (code = 'no-source') => new Error(`broker.${code}`)

export function createBrokerOwner(input: {
  account: () => ActiveAccount
  official: OfficialAuth
  now?: () => number
}): BrokerOwner {
  const listeners = new Set<(selection: SourceSelection) => void>()
  let selected: AuthSource | null = null
  let revision = 0,
    closed = false,
    paused: ActiveAccount | null = null

  function account(): ActiveAccount {
    try {
      const current = input.account()
      if (!Number.isSafeInteger(current.generation) || current.generation < 0) throw fail()
      return { home: realpathSync(current.home), generation: current.generation }
    } catch {
      throw fail()
    }
  }
  const matches = (source: AuthSource, active: ActiveAccount) =>
    source.home === active.home && source.generation === active.generation
  function publish(next: AuthSource | null, force = false): void {
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
  function current(): SourceSelection {
    let active: ActiveAccount
    try {
      active = account()
    } catch {
      publish(null)
      return { revision, source: null }
    }
    if (selected && !matches(selected, active)) publish(null)
    return { revision, source: selected }
  }
  async function source(): Promise<SourceSelection & { source: AuthSource }> {
    if (closed) throw fail()
    const active = account()
    // An account switch stops sources first; nothing is handed out until it lands.
    if (paused && paused.home === active.home && paused.generation === active.generation)
      throw fail()
    paused = null
    current()
    const next =
      selected ??
      createFileAuthSource({
        ...active,
        official: input.official,
        ...(input.now ? { now: input.now } : {}),
      })
    publish(next)
    return { revision, source: next }
  }
  return {
    current,
    source,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async stopSources() {
      try {
        paused = account()
      } catch {
        paused = null
      }
      publish(null, true)
    },
    async close() {
      closed = true
      publish(null, true)
      listeners.clear()
    },
  }
}
