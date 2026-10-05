// Tasks21–29 import the complete modules that register doctor, flips, smoke
// and codex here. Registration must not execute a command or a Mac action.
import './control-doctor.mjs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readConfig } from './anyengine-config.mjs'
import { runCodexRemote } from './codex-remote.mjs'
import { accountsCommand, limitsCommand } from './control-accounts.mjs'
import { type UpdateCapture, verifyClaudeCodeUpdate } from './control-claude-update.mjs'
import { registerCommand } from './control-cli.mjs'
import { executingLib } from './control-flip-options.mjs'
import { flipCommand } from './control-flip-run.mjs'
import { jsonAt, statAt } from './control-layer-state.mjs'
import { rollbackM2 } from './control-m2-rollback.mjs'
import { activeUpgrade } from './control-m2-upgrade.mjs'
import { gateResult, realFlipDeps, validateSnapshot } from './control-postflight-evidence.mjs'
import { shellQuote } from './control-scripts.mjs'
import { sessionsCommand } from './control-sessions.mjs'
import { readStatusLib, readStatusSmoke } from './control-status-evidence.mjs'
import type { System } from './control-system.mjs'
import { sameKey, settingsHash } from './degraded.mjs'
import { realSmokeDeps, runSmoke, SMOKE_PATHS, type SmokePathName } from './smoke.mjs'
import { joinDetachedGroup } from './smoke-client.mjs'
import { createProbeObserver, type GateRequest } from './smoke-evidence.mjs'
import {
  type Compatibility,
  checkStartupCompatibility,
  readCompatibility,
  realStartupDeps,
} from './startup-compat.mjs'
import { type WatchDeps, watchOnce } from './update-watch.mjs'

for (const op of ['on', 'off', 'restart'] as const) registerCommand(op, flipCommand(op))
registerCommand('accounts', accountsCommand)
registerCommand('limits', limitsCommand)
registerCommand('sessions', sessionsCommand)
registerCommand('rollback', async (args, system, root, say) => {
  if (
    !['m2', 'm3'].includes(args[0] ?? '') ||
    args.length > 2 ||
    (args.length === 2 && args[1] !== '--no-restart')
  ) {
    say('usage: anyengine rollback m2|m3 [--no-restart]\n')
    return 2
  }
  const milestone = args[0] === 'm3' ? 'm3' : 'm2'
  if (milestone === 'm2' && activeUpgrade(root) === 'm3') {
    const crossed = await rollbackM2(system, root, { noRestart: args[1] === '--no-restart' }, 'm3')
    if (!crossed.ok) {
      say(`${crossed.conflicts.join('; ')}\n`)
      return 1
    }
  }
  const result = await rollbackM2(
    system,
    root,
    { noRestart: args[1] === '--no-restart' },
    milestone,
  )
  say(
    result.ok
      ? milestone === 'm3'
        ? 'M3 rolled back; prior M2 verified\n'
        : 'M2 rolled back; prior M1 verified\n'
      : `${result.conflicts.join('; ')}\n`,
  )
  say(`Resume/repeat: /bin/bash ${shellQuote(join(root, 'recovery', milestone, 'recover.sh'))}\n`)
  return result.ok ? 0 : 1
})
registerCommand('codex', (args) =>
  runCodexRemote(args, {
    adapterPath: join(executingLib(), 'dist/src/adapter.mjs'),
    codex: null,
    env: process.env,
  }),
)
function smokeOptions(args: string[]) {
  let paths = SMOKE_PATHS
  let notify = false
  let scheduled = false
  let force = false
  let lib: string | undefined
  let out: string | undefined
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (seen.has(arg)) throw new Error('duplicate smoke option')
    seen.add(arg)
    if (arg === '--notify') notify = true
    else if (arg === '--scheduled') scheduled = true
    else if (arg === '--force' || arg === '--retry') force = true
    else if (['--paths', '--lib', '--out'].includes(arg)) {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`missing ${arg} value`)
      if (arg === '--paths') paths = value.split(',') as SmokePathName[]
      else if (arg === '--lib') lib = value
      else out = value
    } else throw new Error(`unsupported smoke option: ${arg}`)
  }
  return { paths, notify, scheduled, force, lib, out }
}
registerCommand('smoke', async (args, system, root, say) => {
  const { paths, notify, scheduled, force, lib, out } = smokeOptions(args)
  if ((scheduled || force) && (lib || out || paths !== SMOKE_PATHS))
    throw new Error('scheduled/update verification cannot use --lib, --out or --paths')
  if (scheduled || force) {
    if (process.env.ANYENGINE_MOCK === '1') throw new Error('mock cannot verify installed updates')
    const decision = await updateSchedule(system, root, say, realWatchDeps(system, root, say), {
      force,
      scheduled,
    })
    if (decision !== 'smoke') return decision
  }
  const capabilities = realFlipDeps(system, root, executingLib())
  const result = await runSmoke(system, root, realSmokeDeps(root, capabilities, lib), {
    paths,
    notify,
    ...(lib ? { lib } : {}),
    ...(out ? { out } : {}),
  })
  for (const [path, entry] of Object.entries(result.paths))
    say(
      `${path}: ${entry.ok === null ? 'not applicable' : entry.ok ? 'ok' : 'FAILED'}: ${entry.detail}\n`,
    )
  return Object.values(result.paths).some((entry) => entry.ok === false) ? 1 : 0
})

// The detached wire capture owns its complete process group. Unknown cleanup
// retains its directory and makes installed verification fail.
async function captureUpdate(
  root: string,
  lib: string,
  script: string,
  args: readonly string[],
): Promise<unknown> {
  if (
    !['capture-codex-wire.mjs', 'capture-codex-auth.mjs', 'capture-claude-messages.mjs'].includes(
      script,
    )
  )
    throw new Error('unsupported update capture')
  mkdirSync(join(root, 'smoke'), { recursive: true, mode: 0o700 })
  if (readdirSync(join(root, 'smoke')).filter((name) => name.startsWith('wire-')).length >= 32)
    throw new Error('wire capture evidence limit; inspect retained cleanup before retry')
  const work = mkdtempSync(join(root, 'smoke/wire-'))
  const out = join(work, 'capture.json')
  const child = spawn(process.execPath, [join(lib, 'scripts', script), ...args, '--out', out], {
    detached: true,
    stdio: 'ignore',
  })
  let expired = false
  const stop = () => {
    expired = true
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
  }
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) process.on(signal, stop)
  const timer = setTimeout(stop, 150_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    await joinDetachedGroup(child.pid ?? 0, true)
    try {
      if (code !== 0 || expired) throw new Error('update capture failed or timed out')
      const value = jsonAt(out)
      if (value === undefined) throw new Error('update capture result missing')
      return value
    } finally {
      rmSync(work, { recursive: true })
    }
  } finally {
    clearTimeout(timer)
    for (const signal of signals) process.removeListener(signal, stop)
  }
}
export function realWatchDeps(
  system: System,
  root: string,
  say: (text: string) => void,
): WatchDeps {
  const lib = executingLib()
  const startup = realStartupDeps(lib)
  const capabilities = realFlipDeps(system, root, lib)
  let candidate: Compatibility | null = null
  let identity: ReturnType<typeof startup.identity> | null = null
  const settings = () => {
    const value = readConfig(root)
    if (value.errors.length) throw new Error(value.errors.join('; '))
    return settingsHash(value.config)
  }
  const recheck = () => {
    if (
      !candidate ||
      !identity ||
      startup.selected() !== candidate.codexPath ||
      startup.stamp(candidate.codexPath) !== candidate.binaryStamp ||
      JSON.stringify(startup.identity()) !== JSON.stringify(identity) ||
      readStatusLib(root) !== basename(lib)
    )
      throw new Error('selected Codex/library changed during update verification')
  }
  return {
    selection: () => {
      const path = startup.selected()
      if (!path) throw new Error('bundled Codex missing')
      return {
        path,
        identity: JSON.stringify({ stamp: startup.stamp(path), ...startup.identity() }),
      }
    },
    preflipStaged: () => capabilities.preflip(0).staged,
    compatibility: async () => {
      if (capabilities.bundledCodex() !== startup.selected())
        throw new Error('bundled Codex missing or selected path is foreign')
      const problems = capabilities.verifyLib(lib)
      if (problems.length) throw new Error(problems.join('; '))
      const snapshot = capabilities.currentSnapshot()
      validateSnapshot(snapshot)
      if (snapshot.libDir !== lib) throw new Error('executing library is not installed current')
      const result = await checkStartupCompatibility(root, startup, 'update')
      if (result.kind !== 'admit')
        throw new Error(result.kind === 'fallback' ? result.reason : 'mock update refused')
      candidate = readCompatibility(root)
      identity = startup.identity()
      if (!candidate) throw new Error('startup compatibility publication unavailable')
      return candidate
    },
    settings,
    recheck,
    verify: async () => {
      if (!candidate) throw new Error('update compatibility missing')
      recheck()
      await captureUpdate(root, lib, 'capture-codex-wire.mjs', ['--codex', candidate.codexPath])
      const snapshot = capabilities.currentSnapshot()
      validateSnapshot(snapshot)
      if (statAt(join(lib, 'dist/src/control-claude-layer.mjs'))) {
        const capture: UpdateCapture = (script, args) => captureUpdate(root, lib, script, args)
        const gpt = await verifyClaudeCodeUpdate(
          root,
          lib,
          { codex: candidate.codexPath, claude: snapshot.config.claude.cli ?? '' },
          capture,
        )
        if (!gpt.ok) say(`${gpt.reason}; transparent Claude and M1 checks continue\n`)
      }
      if (snapshot.key.codexVersion !== candidate.codexVersion)
        throw new Error('fresh selected Codex version differs from installed proof key')
      if (!snapshot.codeIdentity || !capabilities.mandatoryGate)
        throw new Error('mandatory installed update gate unavailable')
      const verify = () => {
        recheck()
        const fresh = capabilities.currentSnapshot()
        validateSnapshot(fresh)
        if (
          fresh.codeIdentity !== snapshot.codeIdentity ||
          !sameKey(fresh.key, snapshot.key) ||
          fresh.mode !== snapshot.mode ||
          fresh.bundled !== candidate!.codexPath
        )
          throw new Error('mandatory update frozen identity drifted')
        return { codeIdentity: fresh.codeIdentity!, key: fresh.key, mode: fresh.mode }
      }
      verify()
      const at = system.now().toISOString()
      const request: GateRequest = {
        ...verify(),
        attempt: randomUUID(),
        root,
        since: at,
        startedAt: at,
        models: { claude: snapshot.config.smoke.claudeModel, gpt: snapshot.config.smoke.gptModel },
        expect: snapshot.config.router.enabled ? 'router' : 'adapter',
        adapters: [],
      }
      const probes = createProbeObserver(system, request, snapshot.config, verify)
      gateResult(
        await capabilities.mandatoryGate(structuredClone(request), probes.observe),
        request,
        system.now(),
        probes.observations,
      )
      verify()
      const paths: SmokePathName[] = ['router']
      if (snapshot.config.router.multiAgentV1) paths.push('native-fanout')
      const result = await runSmoke(system, root, realSmokeDeps(root, capabilities), {
        paths,
        notify: false,
      })
      verify()
      if (result.paths.router?.ok === false)
        throw new Error(`router: ${result.paths.router.detail}`)
      return {
        ok: true,
        reason:
          result.paths['native-fanout']?.ok === false
            ? 'native fan-out degraded; bridge retained'
            : '',
      }
    },
    rollback: () =>
      flipCommand('off')(['--yes', '--router-only', '--wait-quiet', '1'], system, root, say),
  }
}

// Tests exercise the same scheduler admission with injected watcher work.
export async function updateSchedule(
  system: System,
  root: string,
  say: (text: string) => void,
  deps: WatchDeps,
  options: { force: boolean; scheduled: boolean },
): Promise<'smoke' | 0 | 1> {
  // Validate saved smoke bytes before the watcher can mutate other authority.
  const last = readStatusSmoke(root)
  const { config, errors } = readConfig(root)
  if (errors.length) throw new Error(errors.join('; '))
  const watched = await watchOnce(system, root, deps, { force: options.force })
  say(`update: ${watched.verified}${watched.reason ? `: ${watched.reason}` : ''}\n`)
  if (watched.verified === 'failed' || watched.verified === 'pending') return 1
  if (options.scheduled && !config.smoke.enabled) {
    say('scheduled smoke disabled; mandatory update verification remains separate\n')
    return 0
  }
  const full = last?.paths && SMOKE_PATHS.every((path) => Object.hasOwn(last.paths as object, path))
  const age = system.now().getTime() - Date.parse(String(last?.at))
  if (
    options.scheduled &&
    watched.verified !== 'passed' &&
    full &&
    age >= 0 &&
    age < 20 * 60 * 60_000
  )
    return 0
  return options.force && !options.scheduled ? 0 : 'smoke'
}
