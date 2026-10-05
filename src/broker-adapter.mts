// Registrations belong to an initialized process, never to a mux lifetime.

import { startBrokerSource } from './broker-source.mjs'
import type { ActiveAccount, AuthStatus } from './broker-types.mjs'
import type { CodexChildEvent, CodexUpstream } from './codex-upstream.mjs'

export function registerAdapterBrokerSource(input: {
  root: string
  enabled: boolean
  account: () => ActiveAccount
  upstream: Pick<CodexUpstream, 'onChildLifecycle' | 'requestForChild'>
}): { settled(): Promise<void>; close(): Promise<void> } {
  let desired: Extract<CodexChildEvent, { type: 'ready' }> | null = null
  let active: Awaited<ReturnType<typeof startBrokerSource>> | null = null
  let pending = Promise.resolve()
  let closed = false
  let failure: Error | null = null
  const retire = () => {
    const previous = active
    active = null
    // close() removes metadata and destroys channels before its first await.
    return previous?.close() ?? Promise.resolve()
  }
  const unsubscribe = input.enabled
    ? input.upstream.onChildLifecycle((event) => {
        if (closed) return
        if (event.type === 'exit') {
          if (desired?.childId !== event.childId) return
          desired = null
          const retired = retire()
          pending = pending.then(() => retired)
        } else {
          desired = event
          const retired = retire()
          pending = pending.then(async () => {
            await retired
            if (closed || desired !== event) return
            const account = input.account()
            const valid = () => {
              const latest = input.account()
              return (
                !closed &&
                desired === event &&
                latest.home === account.home &&
                latest.generation === account.generation
              )
            }
            const source = await startBrokerSource({
              root: input.root,
              ...account,
              childId: event.childId,
              pid: event.pid,
              isCurrent: valid,
              request: async (_method, params) =>
                (await input.upstream.requestForChild(
                  event.childId,
                  'getAuthStatus',
                  { includeToken: true, refreshToken: params.refreshToken },
                  10_000,
                )) as AuthStatus,
            })
            if (!valid()) await source.close()
            else active = source
          })
        }
        pending = pending.catch(() => {
          failure = new Error('broker.source-unavailable')
        })
      })
    : () => {}
  return {
    async settled() {
      await pending
      if (failure) throw failure
    },
    async close() {
      closed = true
      desired = null
      unsubscribe()
      const retired = retire()
      await pending
      await retired
    },
  }
}
