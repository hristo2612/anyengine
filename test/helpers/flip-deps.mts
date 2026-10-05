// Explicitly synthetic Mac/evidence producer for control tests; never live proof.
import { mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG, readConfig } from '../../src/anyengine-config.mjs'
import { readLayers } from '../../src/control-layers.mjs'
import type {
  FlipDeps,
  GateRequest,
  GateResult,
  GateTurn,
  PostflightSnapshot,
  ProbeObserver,
} from '../../src/control-postflight.mjs'
import { settingsHash } from '../../src/degraded.mjs'
import type { FakeSystem } from './fake-system.mjs'

export const ROUTER = 'http://127.0.0.1:18790/backend-api/codex'
export const CODE = 'a'.repeat(64)
export function strictJobs(system: FakeSystem): void {
  const previous = system.launchctl
  system.launchctl = (args) => {
    const result = previous(args)
    if (args[0] === 'print' && args[1] === `gui/${process.getuid?.() ?? 0}`)
      return { status: 0, stdout: 'domain', stderr: '' }
    if (args[0] === 'print' && result.status === 113 && !result.stderr)
      return {
        ...result,
        stderr: `Bad request.\nCould not find service "${args[1]?.split('/').at(-1)}" in domain for user gui: ${process.getuid?.() ?? 0}\n`,
      }
    return result
  }
}
export function successfulGate(
  request: GateRequest,
  observe: ProbeObserver,
  system: FakeSystem,
): GateResult {
  const config = readConfig(request.root).config ?? structuredClone(DEFAULT_CONFIG)
  const actual = structuredClone(config)
  actual.modes.codexClaude = 'agent'
  const run = join(request.root, 'smoke/run-20261001T000000Z')
  const root = join(run, 'agent')
  mkdirSync(join(root, 'lib'), { recursive: true })
  const lib = join(request.root, 'lib', request.key.lib!)
  symlinkSync(lib, join(root, 'lib/current'))
  writeFileSync(join(root, 'config.json'), JSON.stringify(actual))
  const original = system.procs
  const processes = system.processes
  const owner = {
    pid: process.pid,
    ppid: 1,
    processStart: '2000-01-01T00:00:00.000Z',
    command: `node ${lib}/dist/src/adapter.mjs on`,
  }
  const processRecord = {
    pid: 990001,
    ppid: process.pid,
    processStart: request.startedAt,
    command: `node ${lib}/dist/src/adapter.mjs app-server`,
  }
  writeFileSync(
    join(run, 'owner.json'),
    JSON.stringify({ attempt: request.attempt, pid: owner.pid, processStart: owner.processStart }),
  )
  system.procs = [...original.filter((p) => p.pid !== process.pid), owner, processRecord]
  system.processes = () => system.procs
  const input = { pid: processRecord.pid, role: 'adapter' as const, root, mode: 'agent' as const }
  try {
    const adapter = observe('before', input)
    observe('after', { ...input, id: adapter.id })
    system.procs = [...original.filter((p) => p.pid !== process.pid), owner]
    observe('closed', { ...input, id: adapter.id })
    const helper = {
      ...processRecord,
      pid: 990002,
      command: `node ${lib}/dist/src/smoke-claude.mjs ${request.attempt} ${root} ${join(request.root, 'smoke/claude-project')}`,
    }
    system.procs.push(helper)
    const own = { ...input, pid: helper.pid, role: 'trampoline' as const }
    const trampoline = observe('before', own)
    observe('after', { ...own, id: trampoline.id })
    system.procs = system.procs.filter((p) => p.pid !== helper.pid)
    observe('closed', { ...own, id: trampoline.id })
    const base = {
      processPid: adapter.pid,
      probeId: adapter.id,
      role: 'adapter' as const,
      processStart: adapter.processStart,
      effectiveMode: adapter.mode,
      effectiveSettings: adapter.settings,
      completedAt: request.startedAt,
      status: 'completed',
      success: true,
      operatorConfig: true,
    }
    const parent = {
      threadId: 'bridge-parent',
      turnId: 'parent-turn',
      model: request.models.claude,
      status: 'completed',
      success: true,
    }
    const child = {
      threadId: 'bridge-child',
      turnId: 'child-turn',
      model: request.models.gpt ?? 'gpt-fixture',
      status: 'completed',
      success: true,
    }
    const auth = {
      loggedIn: true as const,
      method: 'claude.ai' as const,
      home: '/controlled/claude',
      executable: '/controlled/claude-cli',
      identity: 'b'.repeat(64),
      version: '2.1.288 (Claude Code)',
    }
    const turns: GateTurn[] = [
      {
        ...base,
        path: 'claude-pty',
        threadId: 'pty',
        turnId: 'pty-turn',
        model: request.models.claude,
      },
      {
        ...base,
        path: 'gpt',
        threadId: 'gpt',
        turnId: 'gpt-turn',
        model: child.model,
        transport: request.expect,
      },
      {
        ...base,
        path: 'restricted-oauth',
        role: 'trampoline',
        processPid: trampoline.pid,
        probeId: trampoline.id,
        processStart: trampoline.processStart,
        model: request.models.claude,
        sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        responseId: 'actual-response',
        exitCode: 0,
        restricted: true,
        allowlisted: true,
        oauth: { before: auth, after: { ...auth } },
      },
    ]
    if (request.expect === 'router')
      turns.push({
        ...base,
        ...parent,
        path: 'bridge',
        parent,
        child,
        bridge: { ...child, parentThreadId: parent.threadId, parentTurnId: parent.turnId },
      })
    return { ...request, ok: true, turns }
  } finally {
    system.procs = original
    system.processes = processes
    rmSync(run, { recursive: true })
  }
}
export function scripted(
  system: FakeSystem,
  options: { attached?: boolean; versionOnOpen?: Record<number, string>; gate?: boolean } = {},
) {
  strictJobs(system)
  const events: Array<Record<string, unknown>> = []
  const log: string[] = []
  let opens = 0
  let bundled = join(system.app, 'Contents/Resources/codex')
  const root = join(system.home, '.anyengine')
  const currentSnapshot = (): PostflightSnapshot => {
    let lib: string | null = null
    try {
      lib = readlinkSync(join(root, 'lib/current'))
    } catch {}
    const config = readConfig(root).config ?? structuredClone(DEFAULT_CONFIG)
    const key = {
      lib,
      appVersion: system.version,
      codexVersion: '0.159.0',
      settings: settingsHash(config),
    }
    return {
      root,
      libDir: lib ? join(root, 'lib', lib) : null,
      bundled,
      codeIdentity: lib ? CODE : null,
      key,
      mode: config.modes.codexClaude,
      config,
      nativeProof: null,
      degraded: [],
    }
  }
  const deps: FlipDeps = {
    preflip: () => ({ quiet: true, staged: false, text: 'synthetic quiet' }),
    verifyLib: () => [],
    doctor: async () => ({ ok: true, text: 'synthetic installed checks' }),
    smoke: null,
    mandatoryGate: options.gate
      ? async (request, observe) => successfulGate(request, observe, system)
      : null,
    currentSnapshot,
    routerHealth: async () =>
      system.jobs.has('dev.anyengine.router')
        ? {
            ok: true,
            pid: 4242,
            version: currentSnapshot().key.lib,
            startedAt: system.procs.find((p) => p.pid === 4242)?.processStart,
            mode: currentSnapshot().mode,
            fanout: { path: 'bridge', reason: 'unproven', since: system.now().toISOString() },
            proofKey: currentSnapshot().key,
            faults: { hookErrors: 0, unhandledRejections: 0 },
            upstream: { lastOkAt: null, lastError: null, lastErrorAt: null },
            inflight: { gpt: 0, claude: 0 },
          }
        : null,
    claimPing: async () => true,
    bundledCodex: () => bundled,
    appLog: () => log,
    debugEvents: () => events,
  }
  const previous = system.onOpen
  system.onOpen = () => {
    previous?.()
    opens += 1
    const version = options.versionOnOpen?.[opens]
    if (version) {
      system.version = version
      bundled = join(system.app, 'Contents/NewBundle/codex')
    }
    const layers = readLayers(root).layers.map((l) => l.name)
    const ts = system.now().toISOString()
    const pid = 12829 + opens
    const appPid = 800
    if (!layers.length) {
      system.procs = [
        { pid: 900, ppid: appPid, command: `${bundled} app-server`, processStart: ts },
      ]
      log.push(`${ts} info stdio_transport_spawned executablePath=${bundled} pid=900`)
    } else {
      const lib = currentSnapshot().libDir
      const router = layers.includes('router')
      const args = ['app-server', ...(router ? ['-c', `openai_base_url="${ROUTER}"`] : [])]
      system.procs = [
        {
          pid,
          ppid: appPid,
          command: `node ${lib}/dist/src/adapter.mjs app-server`,
          processStart: ts,
        },
        { pid: pid + 100, ppid: pid, command: `${bundled} ${args.join(' ')}`, processStart: ts },
        ...(router
          ? [
              {
                pid: 4242,
                ppid: 1,
                command: `node ${lib}/dist/src/adapter.mjs router`,
                processStart: ts,
              },
            ]
          : []),
      ]
      log.push(`${ts} info stdio_transport_spawned executablePath=~/bin/codex pid=${pid}`)
      events.push({ ts, pid: pid + 100, event: 'codex.upstream.spawn', binary: bundled, args })
      if (router)
        events.push({
          ts,
          pid,
          event: 'router.link',
          attached: options.attached ?? true,
          url: ROUTER,
          fanout: 'bridge',
          checkedAt: ts,
        })
    }
    system.procs.push({
      pid: appPid,
      ppid: 1,
      command: `${join(system.app, 'Contents/MacOS/ChatGPT')} --fixture`,
      processStart: ts,
    })
    log.push(`${ts} info initialize_handshake_result outcome=success transportKind=stdio`)
  }
  return { deps, events, log }
}
