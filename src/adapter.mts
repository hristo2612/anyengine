#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { BridgeControl, bridgeEnabled } from './bridge-control.mjs'
import { runBridgeMcp } from './bridge-mcp.mjs'
import { resolveNativeCodexBinary } from './codex-upstream.mjs'
// Side-effect import, and it has to stay one: the module body copies every
// legacy CLAUDE_CODEX_* name onto its ANYENGINE_* equivalent, and that has to
// happen before any module below reads process.env. Nothing here uses a
// binding from it, so an import organiser will offer to delete it — do not.
// See src/env-compat.mts and test/adapter.test.mts ("legacy CLAUDE_CODEX_*").
import './env-compat.mjs'
import { resolveRuntimeConfig } from './runtime-config.mjs'
import { createRuntime } from './runtime-factory.mjs'
import { CodexClaudeAppServer } from './server.mjs'
import { SessionStore } from './store.mjs'
import {
  normalizeListenUrl,
  parseProxySockArg,
  runProxy,
  startStdioTransport,
  startWebSocketTransport,
} from './transports.mjs'
import type { RpcPeer } from './types.mjs'
import { codexExecRouteEnabled, debugLog, defaultSocketPath, ensureParent } from './util.mjs'

// Install global crash guards FIRST, before anything else can fail. Without
// these, a single uncaught rejection or a synchronous EPIPE from a write to a
// half-closed peer (Codex App's SSH stream blipping mid-stream) silently kills
// the daemon — observed as pid churn (one daemon process per few minutes)
// with no error trace in debug.jsonl. Logging here puts the cause on disk
// AND keeps the daemon alive so the App's reconnect is a no-op.
process.on('uncaughtException', (error: unknown) => {
  const err = error as NodeJS.ErrnoException
  const code = err?.code ?? null
  const isExpected = code === 'EPIPE' || code === 'ECONNRESET' || code === 'EBADF'
  debugLog('adapter.uncaughtException', {
    code,
    message: err?.message ?? String(error),
    stack: err?.stack ?? null,
    swallowed: isExpected,
  })
  // EPIPE/ECONNRESET from peer disconnects are routine; swallow them so the
  // daemon keeps serving other peers. Anything else: re-throw on next tick to
  // preserve normal error semantics (and we already logged it).
  if (!isExpected) {
    setImmediate(() => {
      throw error
    })
  }
})
process.on('unhandledRejection', (reason: unknown) => {
  const err = reason as NodeJS.ErrnoException
  debugLog('adapter.unhandledRejection', {
    code: err?.code ?? null,
    message: err?.message ?? String(reason),
    stack: err?.stack ?? null,
  })
  // Node ≥ 15 defaults to crashing on unhandled rejection. Keep the daemon
  // up; we have logging now, so silent death is no longer a risk.
})

async function main(): Promise<void> {
  // The desktop spawns `codex -c key=value ... app-server <flags>`; the shim
  // passes those leading globals through untouched so the real child can be
  // started with the identical argv.
  const { globals: codexGlobals, rest: args } = splitCodexGlobals(process.argv.slice(2))
  // The `anyengine` MCP server an engine spawns (docs/guide/bridge.md).
  if (args[0] === 'bridge-mcp') {
    await runBridgeMcp()
    return
  }
  if (args[0] !== 'app-server') {
    usage(1)
    return
  }

  const proxyIndex = args.indexOf('proxy')
  if (proxyIndex >= 0) {
    await runProxy(parseProxySockArg(args.slice(proxyIndex + 1)))
    return
  }

  if (args.includes('--help') || args.includes('-h')) {
    usage(0)
    return
  }

  const listen = getArg(args, '--listen') ?? 'stdio://'
  if (listen === 'off') return
  const isUnixDaemon = listen.startsWith('unix://')
  let pidFile: string | null = null
  if (isUnixDaemon) {
    pidFile = ensureSingleUnixDaemon(listen)
  }

  const store = new SessionStore()
  // Codex cc normally launches the app-server over stdio, so a crashed or
  // force-quit adapter leaves its last turn persisted as `inProgress`. The
  // next stdio process is the recovery boundary just like the unix daemon;
  // only recovering unix transports leaves the App's subagent view stuck on
  // "loading" forever after a restart.
  const recovered = store.recoverStaleInProgressTurns()
  if (recovered > 0) {
    process.stderr.write(`[anyengine] recovered ${recovered} stale in-progress turn(s)\n`)
  }
  const runtime = createRuntime()
  const server = new CodexClaudeAppServer(store, runtime)
  // Cross-engine bridge: one loopback control socket per adapter; every
  // engine gets the `anyengine` MCP server pointing at it.
  const bridge = bridgeEnabled() ? new BridgeControl(server.bridgeHost()) : null
  server.setBridge(bridge)
  const nativeCodexBinary = codexExecRouteEnabled() ? null : resolveNativeCodexBinary()
  if (nativeCodexBinary) {
    server.attachNativeCodex({
      binary: nativeCodexBinary,
      args: [...codexGlobals, ...(bridge?.codexConfigArgs() ?? []), ...stripListenArgs(args)],
      eager: normalizeListenUrl(listen) === 'stdio://',
      ...(bridge ? { env: bridge.codexChildEnv() } : {}),
    })
  }
  if (bridge) {
    try {
      await bridge.start()
    } catch (error) {
      process.stderr.write(
        `[anyengine] bridge disabled: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      server.setBridge(null)
    }
  }
  let shuttingDown = false
  const shutdown = async (reason: string) => {
    if (shuttingDown) return
    shuttingDown = true
    debugLog('adapter.shutdown', { reason, pid: process.pid })
    await server.stop()
    await bridge?.stop()
    if (pidFile) {
      try {
        unlinkSync(pidFile)
      } catch {}
    }
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGHUP', () => void shutdown('SIGHUP'))
  debugLog('adapter.start', { pid: process.pid, listen, isUnixDaemon })

  const onMessage = server.handle.bind(server)
  const normalized = normalizeListenUrl(listen)
  const isStdio = normalized === 'stdio://'

  // When the Codex client (app-server proxy) disconnects, a `unix://` daemon
  // would otherwise linger forever and keep its Claude runtime sidecar alive.
  // Exit once the last peer is gone so the runtime socket closes and the
  // sidecar is reclaimed. Codex App re-probes and restarts the daemon on
  // reconnect. Set ANYENGINE_IDLE_EXIT_MS=0 to keep the legacy persistent
  // behavior.
  // The anyengine runtime keeps one warm interactive `claude` PTY per thread;
  // exiting on idle would kill them and force a `--resume` cold start on the
  // next turn, so that runtime defaults to never idling out.
  const defaultIdleExitMs = resolveRuntimeConfig().type === 'anyengine' ? 0 : 15000
  const idleExitMs = Number(process.env.ANYENGINE_IDLE_EXIT_MS ?? defaultIdleExitMs)
  const idleExitEnabled = isUnixDaemon && Number.isFinite(idleExitMs) && idleExitMs > 0
  let activePeers = 0
  let everConnected = false
  let idleTimer: NodeJS.Timeout | null = null
  const cancelIdleExit = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }
  const armIdleExit = () => {
    if (
      !idleExitEnabled ||
      activePeers > 0 ||
      !everConnected ||
      idleTimer ||
      server.hasActiveTurns()
    )
      return
    idleTimer = setTimeout(() => {
      debugLog('adapter.idleExit', { idleExitMs, pid: process.pid })
      process.stderr.write(`[anyengine] no active peers for ${idleExitMs}ms, shutting down\n`)
      void shutdown('idleExit')
    }, idleExitMs)
    idleTimer.unref()
  }
  server.setIdleCheckHandler(armIdleExit)
  const onConnect = (_peer: RpcPeer) => {
    everConnected = true
    activePeers += 1
    cancelIdleExit()
  }
  const onClose = (peer: RpcPeer) => {
    activePeers = Math.max(0, activePeers - 1)
    server.closePeer(peer)
    if (isStdio) {
      // A stdio peer is the process lifetime. If Codex closes its pipe during
      // reconnect, stop the runtime and terminalize all child turns before the
      // process exits; otherwise the old in-memory subagent can remain active
      // while the replacement adapter is already serving the same database.
      void shutdown('stdioClose')
      return
    }
    armIdleExit()
  }

  if (normalized === 'stdio://') {
    startStdioTransport(onMessage, onClose)
    return
  }
  await startWebSocketTransport(normalized, onMessage, onClose, onConnect)
}

// Leading Codex global options (`-c key=value`, `--config`, `-m`, `-p`, `-C`)
// that precede the `app-server` subcommand. Returned verbatim, in order.
function splitCodexGlobals(argv: string[]): { globals: string[]; rest: string[] } {
  const globals: string[] = []
  let index = 0
  while (index < argv.length) {
    const arg = argv[index] ?? ''
    if (/^(-c|--config|-m|--model|-p|--profile|-C|--cd)$/.test(arg)) {
      globals.push(arg, argv[index + 1] ?? '')
      index += 2
      continue
    }
    if (/^(-c|--config|-m|--model|--profile|--cd)=/.test(arg)) {
      globals.push(arg)
      index += 1
      continue
    }
    break
  }
  return { globals, rest: argv.slice(index) }
}

// The child always speaks plain stdio; drop any `--listen` the shim/daemon
// mode added for the adapter itself.
function stripListenArgs(args: string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '--listen') {
      index += 1
      continue
    }
    if (arg.startsWith('--listen=')) continue
    result.push(arg)
  }
  return result
}

function getArg(args: string[], name: string): string | null {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1] ?? null
  const prefix = `${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : null
}

function ensureSingleUnixDaemon(listen: string): string {
  const socketPath = listen === 'unix://' ? defaultSocketPath() : listen.slice('unix://'.length)
  const pidFile = `${socketPath}.pid`
  ensureParent(socketPath)
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'))
    if (Number.isFinite(pid) && processIsAlive(pid)) {
      process.stderr.write(`[anyengine] app-server already running at ${socketPath} (pid ${pid})\n`)
      process.exit(0)
    }
  }
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath)
  } catch {}
  writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })
  try {
    chmodSync(dirname(socketPath), 0o700)
  } catch {}
  return pidFile
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function usage(code: number): never {
  const text = `Usage:
  anyengine app-server --listen stdio://
  anyengine app-server --listen unix://
  anyengine app-server --listen ws://127.0.0.1:8788
  anyengine app-server proxy [--sock PATH]
`
  ;(code === 0 ? process.stdout : process.stderr).write(text)
  process.exit(code)
}

main().catch((error) => {
  process.stderr.write(
    `[anyengine] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
