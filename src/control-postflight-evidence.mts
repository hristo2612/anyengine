// Fresh observations, bounded IO and terminal-result validation for postflight.
import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { basename, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { routerHealthUrl } from './anyengine-config.mjs'
import { resolveBundledCodex } from './bundled-codex.mjs'
import { claimSocketPath, onLines, writeLine } from './claim-protocol.mjs'
import { configAt } from './control-install-on.mjs'
import { digest, object, regularBytes, statAt } from './control-layer-state.mjs'
import { tailJsonl } from './control-logs.mjs'
import type {
  CheckResult,
  CodexProcess,
  FlipDeps,
  PostflightSnapshot,
} from './control-postflight.mjs'
import { readStatusKnownGood, readStatusLib, readStatusSmoke } from './control-status-evidence.mjs'
import {
  adapterArguments,
  adapterMode,
  type ProcessInfo,
  type ProcessOwnership,
  type System,
} from './control-system.mjs'
import { inspectDegraded, inspectProof, type ProofKey, sameKey, settingsHash } from './degraded.mjs'
import { codexBinaryVersionCached } from './proof-versions.mjs'

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
export async function checked(
  name: string,
  fn: () => string | Promise<string>,
): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: await fn() }
  } catch (error) {
    return { name, ok: false, detail: message(error) }
  }
}
function words(command: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return tokens.map((token) => (/^['"]/.test(token) ? token.slice(1, -1) : token))
}
export function classifyCodexProcesses(
  procs: ProcessInfo[],
  app: string,
  ownership: ReadonlyMap<number, ProcessOwnership>,
): CodexProcess[] {
  return procs.flatMap(({ command, pid }) => {
    const args = words(command)
    const first = args[0] ?? ''
    const second = args[1] ?? ''
    const invocation = adapterArguments(command)
    const adapter =
      invocation && adapterMode(invocation.args) === 'app-server' ? invocation.script : ''
    const path =
      basename(first) === 'codex'
        ? first
        : basename(first) === 'node' && basename(second) === 'codex'
          ? second
          : adapter
    if (!path) return []
    const remote =
      path.includes('/.nvm/versions/node/') &&
      / app-server (?:proxy|--listen unix:\/\/\S*)$/.test(command)
    return [
      {
        command,
        path,
        kind:
          ownership.get(pid) === 'app' && (path.startsWith(`${app}/`) || !!adapter)
            ? ('app' as const)
            : remote
              ? ('ssh-remote' as const)
              : ('other' as const),
      },
    ]
  })
}
export function hasForeignShimEvent(
  events: Array<Record<string, unknown>>,
  procs: ProcessInfo[],
  independent: ReadonlySet<number>,
): boolean {
  return events.some(
    (event) =>
      event.event === 'shim.nonBundledCodex' &&
      !procs.some(
        (process) =>
          independent.has(process.pid) &&
          event.pid === process.pid &&
          Date.parse(String(event.ts)) >= Date.parse(process.processStart),
      ),
  )
}
export function healthy(value: Record<string, unknown>, snapshot: PostflightSnapshot): void {
  const inflight = value.inflight
  if (
    value.ok !== true ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) < 1 ||
    value.version !== snapshot.key.lib ||
    value.mode !== snapshot.mode ||
    !object(value.faults) ||
    value.faults.hookErrors !== 0 ||
    value.faults.unhandledRejections !== 0 ||
    !object(value.upstream) ||
    !object(inflight) ||
    !['gpt', 'claude'].every(
      (key) => Number.isSafeInteger(inflight[key]) && Number(inflight[key]) >= 0,
    ) ||
    !object(value.fanout) ||
    !['native', 'bridge'].includes(String(value.fanout.path)) ||
    typeof value.fanout.reason !== 'string' ||
    !Number.isFinite(Date.parse(String(value.fanout.since))) ||
    !Number.isFinite(Date.parse(String(value.startedAt))) ||
    !sameKey(value.proofKey as ProofKey, snapshot.key)
  )
    throw new Error('router health identity/mode/key/fault contract mismatch')
  if (
    value.upstream.lastError &&
    (!value.upstream.lastOkAt ||
      String(value.upstream.lastErrorAt) >= String(value.upstream.lastOkAt))
  )
    throw new Error('router upstream has an unresolved failure')
  if (!snapshot.config.router.enabled || snapshot.degraded.length)
    throw new Error(`router disabled or degraded: ${snapshot.degraded.join(', ')}`)
  if (
    value.fanout.path === 'native' &&
    (!snapshot.config.router.multiAgentV1 ||
      !snapshot.nativeProof ||
      !sameKey(snapshot.nativeProof, snapshot.key))
  )
    throw new Error('native fan-out has no matching four-field proof')
}
function health(url: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((done, reject) => {
    const request = http.get(url, { agent: false }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 128_000) request.destroy(new Error('health byte limit'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        clearTimeout(timer)
        try {
          if (response.statusCode !== 200)
            throw new Error(`router health HTTP ${response.statusCode}`)
          const value: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
          )
          if (!object(value)) throw new Error('invalid router health JSON')
          done(value)
        } catch (error) {
          reject(error)
        }
      })
    })
    const timer = setTimeout(() => request.destroy(new Error('router health timeout')), timeoutMs)
    request.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (error.code === 'ECONNREFUSED') done(null)
      else reject(error)
    })
  })
}
function ping(path: string, pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(path)
    let result = false
    let finished = false
    let unsubscribe = () => {}
    const finish = (ok: boolean) => {
      if (finished) return
      finished = true
      result = ok
      clearTimeout(timer)
      unsubscribe()
      socket.destroy()
    }
    const timer = setTimeout(() => finish(false), 1000)
    unsubscribe = onLines(
      socket,
      (value) =>
        finish(
          value.type === 'pong' &&
            value.pid === pid &&
            Number.isSafeInteger(value.threads) &&
            Number(value.threads) >= 0,
        ),
      () => finish(false),
    )
    socket.once('connect', () => writeLine(socket, { op: 'ping' }))
    socket.once('error', () => finish(false))
    socket.once('close', () => {
      finish(false)
      resolve(result)
    })
  })
}
function logs(home: string, since: Date): string[] {
  const root = join(home, 'Library/Logs/com.openai.codex')
  const pending = [root]
  const found: Array<{ path: string; mtime: number }> = []
  let inspected = 0
  while (pending.length) {
    const dir = pending.pop()
    if (!dir) break
    if (!statAt(dir)) continue
    for (const name of readdirSync(dir)) {
      if (++inspected > 20_000) throw new Error('app log directory bound exceeded')
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isDirectory() && /^\d{2,4}$/.test(name)) pending.push(path)
      else if (stat.isFile() && name.endsWith('.log')) found.push({ path, mtime: stat.mtimeMs })
    }
  }
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 2)
    .flatMap(({ path }) =>
      new TextDecoder('utf-8', { fatal: true })
        .decode(regularBytes(path, 16_000_000))
        .split('\n')
        .filter((line) => Date.parse(line.split(/\s/, 1)[0] ?? '') >= since.getTime()),
    )
}
function installedManifest(dir: string): {
  identity: string
  files: Record<string, string>
  links: Record<string, string>
} {
  const bytes = regularBytes(join(dir, 'install-manifest.json'), 2_000_000)
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (
    !object(value) ||
    value.version !== basename(dir) ||
    !object(value.files) ||
    !object(value.links) ||
    !Object.hasOwn(value.files, 'dist/src/adapter.mjs') ||
    !Object.hasOwn(value.files, 'scripts/lib-verify.mjs') ||
    Object.values(value.files).some(
      (hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash),
    ) ||
    Object.values(value.links).some((link) => typeof link !== 'string' || !link)
  )
    throw new Error('invalid installed manifest identity')
  const names = [...Object.keys(value.files), ...Object.keys(value.links)]
  if (
    new Set(names).size !== names.length ||
    names.some(
      (name) =>
        /[\0\r\n]/.test(name) ||
        name === 'install-manifest.json' ||
        name.split('/').some((part) => !part || part === '.' || part === '..'),
    )
  )
    throw new Error('invalid installed manifest path')
  return {
    identity: digest(bytes),
    files: value.files as Record<string, string>,
    links: value.links as Record<string, string>,
  }
}
function manifestTree(
  dir: string,
  root: string,
  files: Record<string, string>,
  links: Record<string, string>,
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const name = relative(root, path)
    if (name === 'install-manifest.json') continue
    if (entry.isDirectory()) manifestTree(path, root, files, links)
    else if (entry.isSymbolicLink()) {
      if (!Object.hasOwn(links, name) || readlinkSync(path) !== links[name])
        throw new Error(`link missing or moved: ${name}`)
      if (!realpathSync(path).startsWith(`${root}/`))
        throw new Error(`installed link escapes library: ${name}`)
      delete links[name]
    } else if (entry.isFile()) {
      if (!Object.hasOwn(files, name) || digest(regularBytes(path)) !== files[name])
        throw new Error(`changed or unmanifested: ${name}`)
      delete files[name]
    } else throw new Error(`unsupported installed entry: ${name}`)
  }
}
function admitLibrary(dir: string): string[] {
  try {
    if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir)
      throw new Error('installed library must be a direct directory')
    const manifest = installedManifest(dir)
    manifestTree(dir, dir, manifest.files, manifest.links)
    const missing = [...Object.keys(manifest.files), ...Object.keys(manifest.links)]
    if (missing.length) throw new Error(`missing installed entry: ${missing.join(', ')}`)
    if (installedManifest(dir).identity !== manifest.identity)
      throw new Error('installed manifest changed during admission')
    return []
  } catch (error) {
    return [`installed byte admission failed: ${message(error)}`]
  }
}
function snapshot(system: System, root: string): PostflightSnapshot {
  const config = configAt(root)
  const lib = readStatusLib(root)
  const libDir = lib ? realpathSync(join(root, 'lib/current')) : null
  const bundled = resolveBundledCodex({ ...process.env, ANYENGINE_CHATGPT_APP: system.app }).path
  readStatusKnownGood(root)
  readStatusSmoke(root)
  const nativeProof = inspectProof(root)?.paths['native-fanout']?.key ?? null
  const degraded = Object.keys(inspectDegraded(root)?.paths ?? {})
  return {
    root,
    libDir,
    bundled,
    config,
    mode: config.modes.codexClaude,
    nativeProof,
    degraded,
    codeIdentity: libDir ? installedManifest(libDir).identity : null,
    key: {
      lib,
      appVersion: system.appVersion(),
      codexVersion: bundled ? codexBinaryVersionCached(bundled) : null,
      settings: settingsHash(config),
    },
  }
}
export function realFlipDeps(system: System, root: string, libDir: string): FlipDeps {
  const codex = process.env.CODEX_HOME || join(system.home, '.codex')
  const env = {
    ...process.env,
    HOME: system.home,
    CODEX_HOME: codex,
    ANYENGINE_ROOT: root,
    ANYENGINE_CHATGPT_APP: system.app,
    ANYENGINE_ADAPTER: join(libDir, 'dist/src/adapter.mjs'),
  }
  const deps: FlipDeps = {
    preflip: (quietSeconds) => {
      const result = system.exec(
        process.execPath,
        [
          join(libDir, 'scripts/preflip-check.mjs'),
          '--quiet-seconds',
          String(quietSeconds),
          '--app',
          system.app,
          '--codex-home',
          codex,
        ],
        { timeoutMs: 30_000, env },
      )
      return {
        quiet: result.status === 0,
        staged: /an app update is staged/.test(result.stderr),
        text: `${result.stdout}${result.stderr}`,
      }
    },
    verifyLib: (dir) => {
      const problems = admitLibrary(dir)
      if (problems.length) return problems
      const result = system.exec(process.execPath, [join(dir, 'scripts/lib-verify.mjs'), dir], {
        timeoutMs: 30_000,
        env,
      })
      return result.status === 0
        ? []
        : [
            `installed lib verification failed (${result.status ?? 'unknown'}): ${result.stdout}${result.stderr}`,
          ]
    },
    doctor: async () => {
      const { runDoctor } = await import('./control-doctor.mjs')
      const checks = await runDoctor(system, root, { codexHome: codex })
      return {
        ok: checks.every((check) => check.level !== 'fail'),
        text: checks.map((check) => `${check.name}: ${check.level} ${check.detail}`).join('\n'),
      }
    },
    smoke: async (paths) => {
      const module = await installedSmoke()
      const result = await module.runSmoke(system, root, module.realSmokeDeps(root, deps), {
        paths: paths as import('./smoke.mjs').SmokePathName[],
        notify: false,
      })
      return {
        ok: paths.every((path) =>
          [true, null].includes(
            result.paths[path as import('./smoke.mjs').SmokePathName]?.ok as boolean | null,
          ),
        ),
        text: Object.entries(result.paths)
          .map(([path, entry]) => `${path}: ${entry.detail}`)
          .join('\n'),
      }
    },
    mandatoryGate: async (request, observe) => {
      const module = await installedSmoke()
      return module.runMandatoryGate(
        system,
        root,
        module.realSmokeDeps(root, deps),
        request,
        observe,
      )
    },
    routerHealth: (timeout) => health(routerHealthUrl(configAt(root)), timeout),
    claimPing: (pid) => ping(claimSocketPath(join(root, 'run'), pid), pid),
    bundledCodex: () => resolveBundledCodex({ ...env, ANYENGINE_CHATGPT_APP: system.app }).path,
    appLog: (since) => logs(system.home, since),
    debugEvents: (since) =>
      tailJsonl(join(process.env.ANYENGINE_HOME || join(codex, 'anyengine'), 'debug.jsonl')).filter(
        (event) => Date.parse(String(event.ts)) >= since.getTime(),
      ),
    currentSnapshot: () => snapshot(system, root),
  }
  async function installedSmoke(): Promise<typeof import('./smoke.mjs')> {
    const current = deps.currentSnapshot()
    validateSnapshot(current)
    const problems = deps.verifyLib(current.libDir!)
    if (problems.length) throw new Error(problems.join('; '))
    return import(pathToFileURL(join(current.libDir!, 'dist/src/smoke.mjs')).href)
  }
  return deps
}
export function validateSnapshot(value: PostflightSnapshot): void {
  if (
    !value?.root ||
    !value.bundled ||
    !value.libDir ||
    !value.codeIdentity ||
    !/^[a-f0-9]{64}$/.test(value.codeIdentity) ||
    !sameKey(value.key, value.key) ||
    !value.key.lib ||
    ['absent', 'unknown'].includes(String(value.key.appVersion)) ||
    !/^\d+\.\d+\.\d+\S*$/.test(String(value.key.codexVersion)) ||
    !['agent', 'model'].includes(value.mode) ||
    value.mode !== value.config.modes.codexClaude ||
    value.key.settings !== settingsHash(value.config)
  )
    throw new Error('current installed identity/version/settings unavailable or invalid')
  if (
    basename(value.libDir) !== value.key.lib ||
    value.libDir !== join(value.root, 'lib', value.key.lib)
  )
    throw new Error('lib/current does not resolve to the expected installed path')
}
export { gateResult } from './smoke-evidence.mjs'
