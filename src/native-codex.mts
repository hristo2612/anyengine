// Build the actual child and its process-scoped services before eager startup.
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { captureHomeIdentity, HomeDesktopIdentity } from './accounts-identity.mjs'
import { managedAccounts } from './accounts-managed.mjs'
import { AccountObservations } from './accounts-observations.mjs'
import { AccountWork } from './accounts-work.mjs'
import { anyengineRoot } from './anyengine-config.mjs'
import { registerSandboxUpstream } from './bridge-exec.mjs'
import { registerAdapterBrokerSource } from './broker-adapter.mjs'
import type { MuxLocalServer } from './codex-mux.mjs'
import { NativeCodexMux, type NativeCodexMuxOptions } from './codex-mux.mjs'
import { CodexUpstream, type CodexUpstreamOptions } from './codex-upstream.mjs'
import { threadPosture } from './posture.mjs'
import type { SessionStore } from './store.mjs'

export function localCodexSurface(
  store: SessionStore,
  callbacks: Pick<MuxLocalServer, 'dispatch' | 'hasActiveTurn' | 'adoptThread'>,
): MuxLocalServer {
  return {
    ...callbacks,
    localThreadOwner: (id) => {
      const thread = store.getThread(id)
      return thread ? (thread.runtimeBackend === 'codex' ? 'codex-exec' : 'claude') : null
    },
    localThreadModel: (id) => store.getThread(id)?.model ?? null,
    localThreadPosture: (id) => threadPosture(store.getThread(id)),
  }
}

export function createNativeCodexMux(
  input: Omit<NativeCodexMuxOptions, 'upstream' | 'brokerSource'> & {
    child: Omit<CodexUpstreamOptions, 'onMessage'>
    eager: boolean
  },
): NativeCodexMux {
  let mux: NativeCodexMux | null = null
  const env = input.child.env ?? process.env
  const accounts = managedAccounts(env, 'adapter')
  const accountWork = accounts ? new AccountWork(accounts) : undefined
  const identity = accounts ? new HomeDesktopIdentity(accounts, env) : null
  const observations: AccountObservations | null = accounts
    ? new AccountObservations(accounts, () => upstream.pid)
    : null
  const upstream: CodexUpstream = new CodexUpstream({
    ...input.child,
    ...(accounts
      ? {
          env: { ...env, CODEX_HOME: accounts.ledger.metadata.paths.overlay },
          processLifecycle: accounts.lifecycle,
          afterInitialize: (child) => captureHomeIdentity(child, accounts, env),
        }
      : {}),
    ...(observations
      ? {
          beforeRequest: (method) => observations.before(method),
          onRawMessage: (method, payload, sample) => observations.observe(method, payload, sample),
        }
      : {}),
    onMessage: (message) => {
      if (
        accounts &&
        'method' in message &&
        message.method === 'account/updated' &&
        accounts.ledger.registry().active !== accounts.ledger.registry().home &&
        !upstream.reserveLimited
      )
        return
      mux?.onUpstreamMessage(message)
    },
  })
  registerSandboxUpstream(upstream)
  if (observations)
    upstream.onChildLifecycle((event) => {
      if (event.type === 'exit') observations.close()
    })
  const brokerSource = registerAdapterBrokerSource({
    root: anyengineRoot(env),
    enabled: env.ANYENGINE_MOCK !== '1',
    account: accounts
      ? () => accounts.account()
      : () => ({
          home: realpathSync(env.CODEX_HOME || join(env.HOME || homedir(), '.codex')),
          generation: 1,
        }),
    upstream,
  })
  mux = new NativeCodexMux({
    ...input,
    upstream,
    brokerSource,
    ...(accountWork ? { accountWork } : {}),
    ...(identity
      ? {
          desktopIdentity: (method, params) =>
            upstream.reserveLimited && (method === 'account/read' || method === 'getAuthStatus')
              ? Promise.resolve(undefined)
              : identity.request(method, params),
        }
      : {}),
  })
  accounts?.setHooks({
    stop: async () => {
      if (mux?.activeUpstreamThreadIds().length)
        throw new Error('Native account turns still running')
      await upstream.stop()
    },
    restart: async () => {
      await upstream.restartForAccounts()
      mux?.afterAccountRestart()
    },
  })
  if (input.eager) upstream.start()
  return mux
}
