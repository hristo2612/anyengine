// The router daemon's own process: what happens on a crash or an unawaited
// rejection, and what the environment it starts in is warned about. Used by
// router-server.mts's runRouterDaemon.
import { anyengineRoot } from './anyengine-config.mjs'
import { type RouterLog, scrubForLog } from './router-log.mjs'
import { messageOf } from './router-relay.mjs'
import type { RouterFaults } from './router-server.mjs'

// A rejection nobody awaited: logged and counted in /health's faults; the
// router keeps serving.
export function countRejections(log: RouterLog, faults: RouterFaults): (reason: unknown) => void {
  return (reason) => {
    faults.unhandledRejections += 1
    log.error('router.unhandledRejection', { message: messageOf(reason) })
  }
}

// The router owns its process: a crash is logged to router.jsonl and exits
// non-zero, so launchd (KeepAlive) starts a fresh one. The adapter's own
// handlers (which write to the adapter's debug log) are not the router's.
export function ownCrashes(log: RouterLog, faults: RouterFaults): void {
  process.removeAllListeners('uncaughtException')
  process.removeAllListeners('unhandledRejection')
  process.on('uncaughtException', (error: unknown) => {
    const message = messageOf(error)
    log.error('router.crash', { message, stack: (error as Error | null)?.stack ?? null })
    process.stderr.write(`[anyengine router] fatal: ${String(scrubForLog(message))}\n`)
    process.exit(1)
  })
  process.on('unhandledRejection', countRejections(log, faults))
}

const PROXY_ENV = ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']

// The relay's own agents ignore these, but each says something on this Mac
// is set up to read or divert TLS traffic: said where the operator looks
// (router.jsonl, and launchd's log for the loud one). Names only, never a
// value (a proxy URL can carry a password).
export function warnAboutEnv(env: NodeJS.ProcessEnv, log: RouterLog): void {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    log.error('router.tls-verification-off', {
      note: 'NODE_TLS_REJECT_UNAUTHORIZED=0: the relay still verifies the upstream; remove it',
    })
    process.stderr.write(
      '[anyengine router] WARNING: NODE_TLS_REJECT_UNAUTHORIZED=0 is set: TLS checks are off for this process except the relay. Remove it from the environment.\n',
    )
  }
  if ((env.NODE_EXTRA_CA_CERTS ?? '').trim())
    log.error('router.extra-ca-trusted', {
      note: 'NODE_EXTRA_CA_CERTS adds authorities the relay trusts for the upstream',
    })
  const names = PROXY_ENV.flatMap((name) => [name, name.toLowerCase()]).filter((name) =>
    (env[name] ?? '').trim(),
  )
  if (names.length > 0) log.info('router.proxy-env-ignored', { names })
}

// A root the router cannot use (ANYENGINE_ROOT relative, or a literal ~) is
// one line on stderr, which launchd keeps, and exit 78 (EX_CONFIG, as the
// launcher's): no stack, and never a fallback to another directory.
export function rootOrExit(env: NodeJS.ProcessEnv): string {
  try {
    return anyengineRoot(env)
  } catch (error) {
    process.stderr.write(`anyengine router: ${messageOf(error)}\n`)
    process.exit(78)
  }
}
