import { realpathSync } from 'node:fs'
import { managedAccounts } from './accounts-managed.mjs'
import { createTokenBroker } from './broker-cache.mjs'
import type { OfficialAuth } from './broker-file.mjs'
import { createBrokerOwner } from './broker-owner.mjs'
import { createStandaloneAuthSource } from './broker-standalone.mjs'
import type { AccountAdmission, ActiveAccount } from './broker-types.mjs'
import { codexHome } from './util.mjs'

export function createRouterBroker(input: {
  root: string
  account?: () => ActiveAccount
  official?: OfficialAuth
  log?: (event: string, fields: Record<string, unknown>) => void
}) {
  const accounts =
    input.account || input.official
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
  const launch = (home: string, generation: number) =>
    createStandaloneAuthSource({
      home,
      generation,
      ...(accounts ? { processLifecycle: accounts.lifecycle, accounts } : {}),
    })
  const official: OfficialAuth = input.official ?? {
    async status(home, generation, refreshToken) {
      const client = await launch(home, generation)
      try {
        return await client.request('getAuthStatus', { includeToken: true, refreshToken })
      } finally {
        await client.close()
      }
    },
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
  const quotas = new Set<string>()
  function recordQuota(
    lease: Parameters<NonNullable<AccountAdmission['quota']>>[0],
    model: string,
  ) {
    if (!accounts || quotas.has(model)) return
    const source = owner.current().source
    if (!source || source.id !== lease.sourceId) return
    quotas.add(model)
    void (async () => {
      const client = await launch(source.home, lease.generation)
      try {
        const family = accounts.ledger
          .holders()
          .find(
            (f) =>
              f.generation === lease.generation &&
              f.account === accounts.ledger.state().active &&
              f.purpose === 'model' &&
              f.participant === accounts.participant.id,
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
      } finally {
        await client.close()
      }
    })()
      .catch(() => {})
      .finally(() => quotas.delete(model))
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
