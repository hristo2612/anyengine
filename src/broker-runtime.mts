import { realpathSync } from 'node:fs'
import { managedAccounts } from './accounts-managed.mjs'
import { createTokenBroker } from './broker-cache.mjs'
import { createBrokerOwner } from './broker-owner.mjs'
import { readBrokerSources } from './broker-source.mjs'
import { createStandaloneAuthSource } from './broker-standalone.mjs'
import type { AccountAdmission, ActiveAccount } from './broker-types.mjs'
import { codexHome } from './util.mjs'

export function createRouterBroker(input: {
  root: string
  account?: () => ActiveAccount
  launch?: Parameters<typeof createBrokerOwner>[0]['launch']
}) {
  const accounts =
    input.account || input.launch
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
  const owner = createBrokerOwner({
    root: input.root,
    account,
    launch:
      input.launch ??
      ((home) =>
        createStandaloneAuthSource({
          home,
          generation: account().generation,
          ...(accounts ? { processLifecycle: accounts.lifecycle, accounts } : {}),
        })),
  })
  const broker = createTokenBroker({ account, owner })
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
  let active = 0
  let closed = false
  let closing: Promise<void> | null = null
  let drained: (() => void) | null = null
  const admission: AccountAdmission = {
    quota: (lease, model) => {
      if (!accounts || !broker.isCurrent(lease)) return
      const source = owner.current().source
      if (!source || source.id !== lease.sourceId) return
      const pid =
        source.kind === 'standalone'
          ? null
          : readBrokerSources(input.root, account()).find((s) => s.id === source.id)?.pid
      const family = accounts.ledger
        .holders()
        .find(
          (f) =>
            f.generation === lease.generation &&
            f.account === accounts.ledger.state().active &&
            f.purpose === 'model' &&
            (source.kind === 'standalone'
              ? f.participant === accounts.participant.id
              : f.native?.pid === pid),
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
