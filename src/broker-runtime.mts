import { realpathSync } from 'node:fs'
import { managedAccounts } from './accounts-managed.mjs'
import { createTokenBroker } from './broker-cache.mjs'
import type { OfficialAuth } from './broker-file.mjs'
import { createBrokerOwner } from './broker-owner.mjs'
import { createStandaloneAuthSource } from './broker-standalone.mjs'
import type { AccountAdmission, ActiveAccount, AuthSource, BrokerLease } from './broker-types.mjs'
import { codexHome } from './util.mjs'

type Launched = AuthSource & { close(): Promise<void>; pid?(): number | null }
// Limit observations from the translator: one official launch per model and
// account generation per window, however often a client retries.
const QUOTA_WINDOW = 10 * 60_000

export function createRouterBroker(input: {
  root: string
  account?: () => ActiveAccount
  official?: OfficialAuth
  // Test seam for the short-lived official app-server.
  launch?: (home: string, generation: number) => Promise<Launched>
  log?: (event: string, fields: Record<string, unknown>) => void
}) {
  const accounts =
    input.account || input.official || input.launch
      ? null
      : managedAccounts({ ...process.env, ANYENGINE_ROOT: input.root }, 'broker')
  const account =
    input.account ??
    (accounts ? () => accounts.account() : null) ??
    (() => {
      let home = codexHome()
      try {
        home = realpathSync(home)
      } catch {
        // The M1 router also runs before a user has created a Codex home.
      }
      return { home, generation: 1 }
    })
  // One short-lived official app-server per call, owned like any account child.
  const launch =
    input.launch ??
    ((home: string, generation: number) =>
      createStandaloneAuthSource({
        home,
        generation,
        ...(accounts ? { processLifecycle: accounts.lifecycle, accounts } : {}),
      }))
  // Official children run one at a time: a child refreshes a stale login on its
  // own at start, so two at once could spend the same single-use refresh token.
  let queue: Promise<unknown> = Promise.resolve()
  function exclusive<T>(run: (client: Launched) => Promise<T>, home: string, generation: number) {
    const turn = queue.then(async () => {
      const client = await launch(home, generation)
      try {
        return await run(client)
      } finally {
        await client.close()
      }
    })
    queue = turn.catch(() => {})
    return turn
  }
  const official: OfficialAuth = input.official ?? {
    status: (home, generation, refreshToken) =>
      exclusive(
        (client) => client.request('getAuthStatus', { includeToken: true, refreshToken }),
        home,
        generation,
      ),
  }
  const owner = createBrokerOwner({ account, official })
  const broker = createTokenBroker({ account, owner, ...(input.log ? { log: input.log } : {}) })
  accounts?.setHooks({
    stop: async () => {
      broker.invalidate(account().generation)
      await owner.stopSources()
      await accounts.lifecycle.stopAll?.()
    },
    restart: async () => {
      broker.invalidate(account().generation)
    },
  })
  // The translator holds no Codex process of its own, and a limit observation
  // needs a live official family to vouch for it: start one for the record.
  const quotas = new Map<string, number>()
  function recordQuota(lease: BrokerLease, model: string) {
    const key = `${lease.generation}:${model}`
    const seen = quotas.get(key)
    if (!accounts || (seen !== undefined && Date.now() - seen < QUOTA_WINDOW)) return
    const source = owner.current().source
    if (!source || source.id !== lease.sourceId) return
    quotas.set(key, Date.now())
    void exclusive(
      async (client) => {
        const pid = client.pid?.()
        const family = accounts.ledger
          .holders()
          .find(
            (f) =>
              f.native?.pid === pid &&
              f.generation === lease.generation &&
              f.account === accounts.ledger.state().active &&
              f.purpose === 'model',
          )
        if (!family) return
        accounts.policy.translationQuota(model, lease.generation, (scope) => {
          try {
            const permit = accounts.limits.issue(family.id, lease.sourceId, lease.sourceRevision)
            return accounts.limits.accept({
              sample: accounts.limits.sample(permit),
              kind: 'openai-quota-error',
              payload: { scope },
            })
          } catch {
            return false
          }
        })
      },
      source.home,
      lease.generation,
    ).catch(() => {})
  }
  let active = 0
  let closed = false
  let closing: Promise<void> | null = null
  let drained: (() => void) | null = null
  const admission: AccountAdmission = {
    quota: (lease, model) => {
      if (broker.isCurrent(lease)) recordQuota(lease, model)
    },
    async begin(signal) {
      if (closed) throw new Error('broker.no-source')
      if (signal?.aborted) throw new Error('broker.request-aborted')
      const generation = account().generation
      const managed = accounts?.begin()
      active++
      let released = false
      return {
        generation,
        async release() {
          if (released) return
          released = true
          active--
          await managed?.release()
          if (closed && active === 0) drained?.()
        },
      }
    },
  }
  return {
    broker,
    owner,
    account,
    admission,
    official,
    activeRequests: () => active,
    close() {
      closed = true
      closing ??= (
        active === 0
          ? Promise.resolve()
          : new Promise<void>((done) => {
              drained = done
            })
      ).then(async () => {
        await broker.close()
        await accounts?.close()
      })
      return closing
    },
  }
}
