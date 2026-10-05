// A real app-server supplies auth; this module never acquires credentials itself.
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { ManagedChildLifecycle } from './accounts-family.mjs'
import { AccountObservations } from './accounts-observations.mjs'
import type { AccountParticipant } from './accounts-participant.mjs'
import type { AuthSource, AuthStatus } from './broker-types.mjs'
import { resolveBundledCodex } from './bundled-codex.mjs'
import { CodexUpstream } from './codex-upstream.mjs'

export function standaloneEnvironment(home: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { CODEX_HOME: realpathSync(home) }
  for (const name of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL']) {
    if (env[name]) clean[name] = env[name]
  }
  clean.PATH ??= '/usr/bin:/bin'
  clean.RUST_LOG = 'error'
  return clean
}

export async function createStandaloneAuthSource(input: {
  home: string
  generation: number
  binary?: string
  env?: NodeJS.ProcessEnv
  processLifecycle?: ManagedChildLifecycle
  accounts?: AccountParticipant
}): Promise<AuthSource & { close(): Promise<void>; onClose(listener: () => void): () => void }> {
  const home = realpathSync(input.home),
    env = input.env ?? process.env
  const binary = input.binary ?? resolveBundledCodex(env).path
  if (!binary) throw new Error('broker.no-source')
  const listeners = new Set<() => void>()
  let childId: string | null = null,
    ended = false,
    closing: Promise<void> | null = null
  const observations: AccountObservations | null = input.accounts
    ? new AccountObservations(input.accounts, () => upstream.pid)
    : null
  const upstream: CodexUpstream = new CodexUpstream({
    binary,
    args: [
      '-c',
      'mcp_servers={}',
      '-c',
      'openai_base_url="https://chatgpt.com/backend-api/codex"',
      'app-server',
      '--listen',
      'stdio://',
    ],
    env: standaloneEnvironment(home, env),
    maxRestarts: 0,
    reserveEnabled: false,
    ...(input.processLifecycle ? { processLifecycle: input.processLifecycle } : {}),
    ...(observations
      ? {
          beforeRequest: (method: string) => observations.before(method),
          onRawMessage: (method: string, payload: unknown, sample?: unknown) =>
            observations.observe(method, payload, sample),
        }
      : {}),
    onMessage: () => {},
  })
  const unsubscribe = upstream.onChildLifecycle((event) => {
    if (event.type === 'ready') childId = event.childId
    else {
      observations?.close()
      childId = null
      ended = true
      for (const listener of listeners) listener()
    }
  })
  const close = () => {
    if (closing) return closing
    closing = upstream.stop().finally(() => {
      unsubscribe()
      listeners.clear()
    })
    return closing
  }
  try {
    upstream.start()
    await upstream.initialize({
      clientInfo: { name: 'anyengine-broker', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    })
    upstream.markInitialized()
    if (!childId || ended) throw new Error('broker.source-unavailable')
    if (observations) {
      // Metadata RPCs only, once per official source lifetime.
      await upstream.request('model/list', { includeHidden: false }, 10000).catch(() => {})
      await upstream.request('account/rateLimits/read', {}, 10000).catch(() => {})
    }
  } catch {
    await close()
    throw new Error('broker.source-unavailable')
  }
  return {
    id: `standalone-${randomUUID()}`,
    home,
    generation: input.generation,
    kind: 'standalone',
    close,
    onClose(listener) {
      listeners.add(listener)
      if (ended) listener()
      return () => listeners.delete(listener)
    },
    async request(method, params) {
      if (
        !childId ||
        ended ||
        method !== 'getAuthStatus' ||
        params.includeToken !== true ||
        typeof params.refreshToken !== 'boolean'
      )
        throw new Error('broker.source-unavailable')
      try {
        const result = await upstream.requestForChild(
          childId,
          'getAuthStatus',
          { includeToken: true, refreshToken: params.refreshToken },
          10_000,
        )
        if (!result || typeof result !== 'object') throw new Error('invalid status')
        const status = result as AuthStatus
        if (
          (status.authMethod !== null && typeof status.authMethod !== 'string') ||
          (status.authToken !== null && typeof status.authToken !== 'string') ||
          typeof status.requiresOpenaiAuth !== 'boolean'
        )
          throw new Error('invalid status')
        return {
          authMethod: status.authMethod,
          authToken: status.authToken,
          requiresOpenaiAuth: status.requiresOpenaiAuth,
        }
      } catch {
        throw new Error('broker.source-unavailable')
      }
    },
  }
}
