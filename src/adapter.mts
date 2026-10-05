#!/usr/bin/env node
import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { enginePaths, loadConfig } from './anyengine-config.mjs'
import { BridgeControl, bridgeEnabled } from './bridge-control.mjs'
import { runBridgeMcp } from './bridge-mcp.mjs'
import {
  reportNativeCodex,
  resolveNativeCodex,
  resolveNativeCodexBinary,
} from './bundled-codex.mjs'
import { ClaimServer } from './claim-server.mjs'
import type { NativeCodexMux } from './codex-mux.mjs'
import { CONTROL_COMMANDS } from './control-cli.mjs'
// Side-effect import, and it has to stay one: the module body copies every
// legacy CLAUDE_CODEX_* name onto its ANYENGINE_* equivalent, and that has to
// happen before any module below reads process.env. Nothing here uses a
// binding from it, so an import organiser will offer to delete it — do not.
// See src/env-compat.mts and test/adapter.test.mts ("legacy CLAUDE_CODEX_*").
import './env-compat.mjs'
import { readMcpConfig } from './mcp.mjs'
import { localReadRestricted } from './requirements-reads.mjs'
import { linkRouter, nativeFanout } from './router-link.mjs'
import { resolveRuntimeConfig } from './runtime-config.mjs'
import { createRuntime } from './runtime-factory.mjs'
import { CodexClaudeAppServer } from './server.mjs'
import {
  admitAdapterStartup,
  assertStartupBinary,
  StartupAdmissionError,
  startupFallback,
} from './startup-compat.mjs'
import { SessionStore } from './store.mjs'
import {
  type MessageHandler,
  normalizeListenUrl,
  parseProxySockArg,
  type RunningTransport,
  runProxy,
  startStdioTransport,
  startWebSocketTransport,
} from './transports.mjs'
import type { ClaudeRuntime, RpcPeer } from './types.mjs'
import { codexHome, debugLog, defaultSocketPath, ensureParent } from './util.mjs'

let refuseStartup: ((error: StartupAdmissionError) => Promise<never>) | null = null

// Keep ordinary peer disconnects alive; typed admission refusal goes to its owner.
process.on('uncaughtException', (error: unknown) => {
  if (error instanceof StartupAdmissionError && refuseStartup) {
    void refuseStartup(error)
    return
  }
  const err = error as NodeJS.ErrnoException
  const code = err?.code ?? null
  const isExpected = code === 'EPIPE' || code === 'ECONNRESET' || code === 'EBADF'
  debugLog('adapter.uncaughtException', {
    code,
    message: err?.message ?? String(error),
    stack: err?.stack ?? null,
    swallowed: isExpected,
  })
  // Unexpected errors exit once; rethrowing here would recursively hit this guard.
  if (!isExpected) {
    process.stderr.write(`[anyengine] fatal: ${err?.stack ?? err?.message ?? String(error)}\n`)
    process.exit(1)
  }
})
process.on('unhandledRejection', (reason: unknown) => {
  if (reason instanceof StartupAdmissionError && refuseStartup) {
    void refuseStartup(reason)
    return
  }
  const err = reason as NodeJS.ErrnoException
  debugLog('adapter.unhandledRejection', {
    code: err?.code ?? null,
    message: err?.message ?? String(reason),
    stack: err?.stack ?? null,
  })
  // Ordinary rejections remain logged without interrupting other peers.
})

async function main(): Promise<void> {
  // Preserve the desktop's leading globals and app-server argv for its child.
  const { globals: codexGlobals, rest: args } = splitCodexGlobals(process.argv.slice(2))
  if (args[0] === 'selfcheck') {
    await runSelfCheck(args.includes('--deep'))
    return
  }
  // The `anyengine` MCP server an engine spawns (docs/guide/bridge.md).
  if (args[0] === 'bridge-mcp') {
    await runBridgeMcp()
    return
  }
  // The AnyEngine router daemon (docs/guide/router.md), run by launchd.
  if (args[0] === 'router') {
    localReadRestricted()
    const { runRouterDaemon } = await import('./router-server.mjs')
    await runRouterDaemon()
    return
  }
  if (args[0] === 'flip-run') {
    const { flipRunMain } = await import('./control-flip-run.mjs')
    process.exitCode = await flipRunMain(args.slice(1))
    return
  }
  if (args[0] && CONTROL_COMMANDS.has(args[0])) {
    const { runControl } = await import('./control-cli.mjs')
    process.exitCode = await runControl(args)
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
  if (isUnixDaemon && ownsControlSocketWithoutNativeCodex(listen)) {
    process.stderr.write(CONTROL_SOCKET_REFUSAL)
    process.exit(78)
  }
  let stopping: Promise<void> | null = null
  let shuttingDown = false
  let stopPreparation = async () => {}
  let refusal: Promise<never> | null = null
  refuseStartup = (error) => {
    shuttingDown = true
    return (refusal ??= startupFallback(
      { kind: 'fallback', code: error.code, reason: error.message, codexPath: null },
      process.argv.slice(2),
      listen,
      enginePaths().root,
      () => stopPreparation(),
    ).then((status) => process.exit(status)))
  }
  await ensureSingleUnixDaemon(listen, true)
  if (!(await admitAdapterStartup(process.argv.slice(2), listen))) return

  localReadRestricted()
  const store = new SessionStore()
  // Every process start recovers turns left in progress by a crashed predecessor.
  const recovered = store.recoverStaleInProgressTurns()
  if (recovered > 0) {
    process.stderr.write(`[anyengine] recovered ${recovered} stale in-progress turn(s)\n`)
  }
  const runtime = createRuntime()
  const server = new CodexClaudeAppServer(store, runtime)
  // Every engine's MCP server points to this adapter's loopback bridge.
  const bridge = bridgeEnabled() ? new BridgeControl(server.bridgeHost()) : null
  server.setBridge(bridge)
  let claims: ClaimServer | null = null
  let transport: RunningTransport | null = null
  stopPreparation = () =>
    (stopping ??= (async () => {
      await claims?.stop()
      await server.stop()
      await bridge?.stop()
      await transport?.close()
    })())
  const nativeCodex = resolveNativeCodex()
  reportNativeCodex(nativeCodex)
  const mux = await attachCodexChild(server, nativeCodex.path, bridge, codexGlobals, args, listen)
  let bridgeStarted = false
  if (bridge) {
    try {
      await bridge.start()
      bridgeStarted = true
    } catch (error) {
      process.stderr.write(
        `[anyengine] bridge disabled: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      server.setBridge(null)
    }
  }
  claims = mux && bridge && bridgeStarted ? await startClaims(mux, runtime, bridge) : null
  if (isUnixDaemon) await ensureSingleUnixDaemon(listen)
  assertStartupBinary()
  const shutdown = async (reason: string) => {
    if (shuttingDown) return
    shuttingDown = true
    debugLog('adapter.shutdown', { reason, pid: process.pid })
    await stopPreparation()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGHUP', () => void shutdown('SIGHUP'))
  debugLog('adapter.start', { pid: process.pid, listen, isUnixDaemon })

  const onMessage: MessageHandler = async (peer, message) => {
    if (shuttingDown) return
    try {
      await server.handle(peer, message)
    } catch (error) {
      if (!(error instanceof StartupAdmissionError) || !refuseStartup) throw error
      await refuseStartup(error)
    }
  }
  const normalized = normalizeListenUrl(listen)
  const isStdio = normalized === 'stdio://'

  // Unix peers exit on idle; interactive anyengine runtimes keep warm PTYs by default.
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
      // EOF owns shutdown: settle runtime/subagent state before another process starts.
      void shutdown('stdioClose')
      return
    }
    armIdleExit()
  }

  if (normalized === 'stdio://') {
    transport = startStdioTransport(onMessage, onClose)
    return
  }
  transport = await startWebSocketTransport(normalized, onMessage, onClose, onConnect)
}

// Return leading Codex global options verbatim, before the app-server subcommand.
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

// ChatGPT.app 26.911 passes a subcommand-level `-c` after `app-server`, and
// codex then ignores every root-level `-c`: an override placed before
// `app-server` silently vanishes. Put ours after the app's own subcommand `-c`
// flags when there are any; keep the root position otherwise (26.901 argv).
function childArgv(globals: string[], extra: string[], rest: string[]): string[] {
  const subcommandHasConfig = rest.some(
    (arg) => arg === '-c' || arg === '--config' || /^(-c|--config)=/.test(arg),
  )
  return subcommandHasConfig ? [...globals, ...rest, ...extra] : [...globals, ...extra, ...rest]
}

// `anyengine selfcheck [--deep]`. Reaching main() at all proves every static
// import resolved (ws, every src module); this also loads node:sqlite, which
// the store requires lazily. The shim runs it before it hands the app this
// process (scripts/codex-shim). `--deep` loads what the runtimes pull in
// later, for install and doctor. It exits once the line is out: a handle a
// loaded module left open must not hold up every app launch.
async function runSelfCheck(deep: boolean): Promise<void> {
  const require = createRequire(import.meta.url)
  require('node:sqlite')
  if (deep) {
    require('node-pty')
    await import('@xterm/headless')
    import.meta.resolve('@anthropic-ai/claude-agent-sdk')
  }
  process.stdout.write(`anyengine selfcheck ok${deep ? ' (deep)' : ''}\n`, () => process.exit(0))
}

// The native child speaks stdio; drop the adapter's --listen flags.
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

const CONTROL_SOCKET_REFUSAL =
  '[anyengine] refusing the app-server control socket: plain `codex` TUIs attach to it, and ' +
  'without a native codex child their GPT turns would run through the `codex exec` fallback. ' +
  'Give this daemon a codex child (the shim does with ANYENGINE_REMOTE_NATIVE_CODEX=1) or ' +
  'listen on another socket.\n'

// Plain Codex TUIs use the control socket, whose owner requires a native child.
function ownsControlSocketWithoutNativeCodex(listen: string): boolean {
  const socketPath = listen === 'unix://' ? defaultSocketPath() : listen.slice('unix://'.length)
  const control = join(codexHome(), 'app-server-control', 'app-server-control.sock')
  if (resolve(socketPath) !== resolve(control)) return false
  return resolveNativeCodexBinary() === null
}

async function ensureSingleUnixDaemon(listen: string, inspect = false): Promise<string> {
  if (!listen.startsWith('unix://')) return ''
  const socketPath = listen === 'unix://' ? defaultSocketPath() : listen.slice('unix://'.length)
  const pidFile = `${socketPath}.pid`
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'))
    if (Number.isFinite(pid) && processIsAlive(pid)) {
      process.stderr.write(`[anyengine] app-server already running at ${socketPath} (pid ${pid})\n`)
      process.exit(0)
    }
  }
  // A real codex daemon writes no pidfile: whatever answers owns the socket,
  // as upstream codex decides. Only a socket nothing listens on is removed;
  // anything else is left for the bind to report.
  const state = await probeSocket(socketPath)
  if (state === 'live') {
    process.stderr.write(`[anyengine] app-server already running at ${socketPath}\n`)
    process.exit(0)
  }
  if (inspect) return ''
  ensureParent(socketPath)
  try {
    if (state === 'stale') unlinkSync(socketPath)
  } catch {}
  assertStartupBinary()
  writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })
  process.once('exit', () => {
    try {
      if (readFileSync(pidFile, 'utf8') === `${process.pid}\n`) unlinkSync(pidFile)
    } catch {}
  })
  try {
    chmodSync(dirname(socketPath), 0o700)
  } catch {}
  return pidFile
}

function probeSocket(path: string): Promise<'live' | 'stale' | 'absent' | 'unknown'> {
  let isSocket: boolean
  try {
    isSocket = lstatSync(path).isSocket()
  } catch {
    return Promise.resolve('absent')
  }
  return new Promise((resolve) => {
    const socket = net.createConnection(path)
    const settle = (state: 'live' | 'stale' | 'unknown') => {
      clearTimeout(timer)
      socket.destroy()
      resolve(state)
    }
    const timer = setTimeout(() => settle('unknown'), 2000)
    socket.once('connect', () => settle('live'))
    socket.once('error', (error: NodeJS.ErrnoException) =>
      settle(isSocket && error.code === 'ECONNREFUSED' ? 'stale' : 'unknown'),
    )
  })
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
  anyengine selfcheck [--deep]
  anyengine router
`
  ;(code === 0 ? process.stdout : process.stderr).write(text)
  process.exit(code)
}

async function attachCodexChild(
  server: CodexClaudeAppServer,
  binary: string | null,
  bridge: BridgeControl | null,
  globals: string[],
  args: string[],
  listen: string,
): Promise<NativeCodexMux | null> {
  if (!binary) return null
  const link = await linkRouter([...globals, ...args], { codexBinary: binary })
  assertStartupBinary(binary)
  const childBridge = nativeFanout() ? null : bridge
  return server.attachNativeCodex({
    binary,
    args: childArgv(
      globals,
      [...(childBridge?.codexConfigArgs() ?? []), ...link.configArgs],
      stripListenArgs(args),
    ),
    bridgeOnChild: childBridge !== null,
    eager: normalizeListenUrl(listen) === 'stdio://',
    ...(childBridge ? { env: childBridge.codexChildEnv() } : {}),
  })
}

async function startClaims(
  mux: NativeCodexMux,
  runtime: ClaudeRuntime,
  bridge: BridgeControl,
): Promise<ClaimServer | null> {
  try {
    const config = loadConfig()
    const claims = new ClaimServer(
      {
        claimThread: (id) => mux.claimThread(id),
        waitForClaimThread: (id, ms) => mux.waitForClaimThread(id, ms),
        knowsThread: (id) => mux.knowsThread(id),
        runtime,
        mcpServersFor: (id) => bridge.mergeMcpServers(id, readMcpConfig().sdkValue),
      },
      {
        runDir: enginePaths().run,
        graceMs: config.claims.graceMs,
        idleReleaseMs: config.claims.idleReleaseMinutes * 60_000,
      },
    )
    await claims.start()
    return claims
  } catch (error) {
    process.stderr.write(
      `[anyengine] claim socket disabled: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return null
  }
}

main().catch(async (error) => {
  if (error instanceof StartupAdmissionError && refuseStartup) return refuseStartup(error)
  process.stderr.write(
    `[anyengine] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
