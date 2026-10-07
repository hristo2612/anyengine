// One bounded observation of the selected official binary. JSON artifacts alone
// define the hash: every generated JSON file, sorted relative paths and object
// keys; arrays and every protocol field remain intact. TS is a separate method
// fixture input, not part of this JSON hash. No development dependencies needed.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isolatedCommand } from './codex-probe.mjs'

export const STARTUP_BUDGET_MS = 30_000
export const STARTUP_WAIT_MS = 35_000
const bundle = 'codex_app_server_protocol.v2.schemas.json'
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
const hash = (value) => createHash('sha256').update(value).digest('hex')
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  return value
}
export function canonicalSchemaHash(artifacts) {
  if (!artifacts[bundle]?.definitions) throw new Error('missing generated JSON schema bundle')
  return hash(JSON.stringify(canonical(artifacts)))
}
function bytes(path) {
  const st = lstatSync(path)
  if (!st.isFile() || st.size > 32_000_000) throw new Error(`invalid required artifact: ${path}`)
  return readFileSync(path)
}
function files(dir, extension, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const st = lstatSync(path)
    if (st.isSymbolicLink()) throw new Error('linked schema artifact refused')
    if (st.isDirectory()) files(path, extension, base, out)
    else if (name.endsWith(extension)) {
      if (!st.isFile() || out.length >= 4096) throw new Error('unsupported schema artifact')
      out.push(relative(base, path))
    }
  }
  return out
}
export function binaryIdentity(path) {
  const real = realpathSync(path)
  const st = statSync(real, { bigint: true })
  if (!st.isFile()) throw new Error('selected Codex is not a file')
  return `${real}:${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
}
export const REQUIRED_FIXTURES = [
  'test/fixtures/posture-schema.json',
  'test/fixtures/claude-permission-modes.json',
  ...[
    'initialize.request',
    'thread-start.request',
    'config-read.request',
    'turn-started.notification',
    'turn-completed.notification',
    'mcp-server-status-list.response',
    'config-read.response',
  ].map((name) => `crates/anyengine-protocol/fixtures/${name}.json`),
]
export const REQUIRED_HELPERS = [
  'scripts/check-posture-schema.mjs',
  'scripts/check-rust-protocol-fixtures.mjs',
  'scripts/lib/startup-schema.mjs',
  'scripts/lib/codex-probe.mjs',
  'scripts/lib/codex-probe-runner.mjs',
  'dist/src/posture.mjs',
]
export const REQUIRED_M2_FIXTURES = [
  'test/fixtures/codex-auth-0.162.0-alpha.2.json',
  'test/fixtures/claude-messages-2.1.292.json',
  'test/fixtures/claude-posture-2.1.289.json',
  'test/fixtures/raine-translation-v0.1.42.json',
]
function m2Fixtures(lib) {
  try {
    bytes(join(lib, 'dist/src/control-claude-layer.mjs'))
    return REQUIRED_M2_FIXTURES
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}
export function suiteIdentity(lib) {
  return hash(
    JSON.stringify(
      [...REQUIRED_HELPERS, ...REQUIRED_FIXTURES, ...m2Fixtures(lib)]
        .sort()
        .map((name) => [name, hash(bytes(join(lib, name)))]),
    ),
  )
}
export function libraryIdentity(lib) {
  const code = join(lib, 'dist/src')
  return `${realpathSync(lib)}@${hash(
    JSON.stringify(files(code, '.mjs').map((name) => [name, hash(bytes(join(code, name)))])),
  )}`
}
// Tests inject a runner with the same isolated-command contract. There is no
// production environment switch that permits an unsandboxed official command.
export function observeSchema(binary, budget = STARTUP_BUDGET_MS, run = isolatedCommand) {
  const deadline = performance.now() + Math.min(budget, STARTUP_BUDGET_MS)
  const stamp = binaryIdentity(binary)
  const call = (args, read, limit = STARTUP_BUDGET_MS) => {
    const remaining = Math.floor(deadline - performance.now())
    if (remaining < 500) throw new Error('startup schema deadline exceeded')
    const result = run(binary, args, {
      timeoutMs: Math.min(limit, remaining),
      ...(read ? { read } : {}),
    })
    if (result.status !== 0 || performance.now() >= deadline)
      throw new Error(`isolated schema probe failed: ${result.stderr || result.status}`)
    return result
  }
  const version = call(['--version'], undefined, 2000).stdout.match(
    /^codex-cli\s+(\d+\.\d+\.\d+\S*)\s*$/m,
  )?.[1]
  if (!version) throw new Error('selected Codex version unavailable')
  const json = call(
    ({ work }) => ['app-server', 'generate-json-schema', '--experimental', '--out', work],
    ({ work }, answer) =>
      answer.status === 0
        ? Object.fromEntries(
            files(work, '.json').map((name) => [name, JSON.parse(decode(bytes(join(work, name))))]),
          )
        : null,
  ).value
  const schemaHash = canonicalSchemaHash(json ?? {})
  const types = call(
    ({ work }) => ['app-server', 'generate-ts', '--experimental', '--out', work],
    ({ work }, answer) =>
      answer.status === 0
        ? Object.fromEntries(
            ['ClientRequest.ts', 'ServerNotification.ts'].map((name) => [
              name,
              decode(bytes(join(work, name))),
            ]),
          )
        : null,
  ).value
  if (!types || binaryIdentity(binary) !== stamp)
    throw new Error('selected Codex changed during schema observation')
  return { codexPath: binary, codexVersion: version, binaryStamp: stamp, schemaHash, json, types }
}
export async function validateFixtures(observation, lib) {
  suiteIdentity(lib) // Missing packaged files are failures, never skipped tests.
  const posture = await import(pathToFileURL(join(lib, 'scripts/check-posture-schema.mjs')).href)
  const protocol = await import(
    pathToFileURL(join(lib, 'scripts/check-rust-protocol-fixtures.mjs')).href
  )
  await posture.validatePosture(observation.json[bundle].definitions, lib)
  protocol.validateProtocol(observation.types, lib)
}

// Own one Unix launch and its output channel. IPC is inherited only by the
// adapter, never its vendor child; public diagnostics remain best effort.
async function launch(resultPath, encodedAdapter, argv) {
  process.title = 'anyengine startup supervisor'
  const adapter = decode(Buffer.from(encodedAdapter, 'base64'))
  const { joinDetachedGroup } = await import('../../dist/src/smoke-client.mjs')
  const { atomicFile, jsonAt } = await import('../../dist/src/control-layer-state.mjs')
  // Exclusive pending publication precedes the child and any vendor delegation.
  writeFileSync(
    resultPath,
    JSON.stringify({ version: 1, launcher: process.pid, phase: 'pending' }),
    { flag: 'wx', mode: 0o600 },
  )
  const child = spawn(process.execPath, [adapter, ...argv], {
    detached: true,
    stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
  })
  let delegated = false
  let vendor = 0
  let refused = false
  let uncertain = false
  let line = []
  let overflow = false
  const inspectLine = (complete) => {
    try {
      const text = decode(Buffer.from(line))
      const prefix = '[anyengine] {'
      if (!text.startsWith(prefix) && (complete || !prefix.startsWith(text))) return
      if (!complete || overflow) {
        uncertain = true
        return
      }
      const value = JSON.parse(text.slice(12))
      if (
        value?.kind === 'anyengine-startup-failure' &&
        value.pid === child.pid &&
        value.code === 'selected-binary-changed' &&
        value.fallback === 'refused' &&
        typeof value.reason === 'string' &&
        value.reason.length <= 1500
      )
        refused = true
      else uncertain = true
    } catch {
      uncertain = true
    }
  }
  child.stderr.on('data', (bytes) => {
    if (!process.stderr.write(bytes)) {
      child.stderr.pause()
      process.stderr.once('drain', () => child.stderr.resume())
    }
    for (const byte of bytes) {
      if (byte !== 10) {
        if (line.length < 4096) line.push(byte)
        else overflow = true
        continue
      }
      inspectLine(true)
      line = []
      overflow = false
    }
  })
  let interrupted = false
  let timer
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  const stop = (signal) => {
    interrupted = true
    if (child.pid) {
      try {
        process.kill(-child.pid, signal)
      } catch {}
    }
    timer ??= setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }
    }, 4000)
  }
  const handlers = signals.map((signal) => {
    const fn = () => stop(signal)
    process.on(signal, fn)
    return fn
  })
  child.on('message', (message) => {
    if (message?.kind !== 'anyengine-startup-delegation') return
    if (message.phase === 'pending') delegated = true
    if (
      delegated &&
      message.phase === 'spawned' &&
      Number.isSafeInteger(message.pid) &&
      message.pid > 0
    )
      vendor = message.pid
  })
  let cleanup = 'complete'
  let status = null
  let signal = null
  try {
    ;[status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (...args) => resolve(args))
    })
    if (line.length || overflow) inspectLine(false)
    await joinDetachedGroup(child.pid ?? 0, true)
    if (vendor) await joinDetachedGroup(vendor, true)
    if ((delegated || refused || uncertain) && !vendor) cleanup = 'unknown'
  } catch {
    cleanup = 'unknown'
  } finally {
    clearTimeout(timer)
    signals.forEach((value, i) => {
      process.removeListener(value, handlers[i])
    })
  }
  try {
    const pending = jsonAt(resultPath)
    if (pending?.version !== 1 || pending.launcher !== process.pid || pending.phase !== 'pending')
      throw new Error('launch pending ownership changed')
    atomicFile(
      resultPath,
      Buffer.from(
        JSON.stringify({
          version: 1,
          phase: 'complete',
          launcher: process.pid,
          adapter: child.pid,
          delegated,
          cleanup,
          status,
          signal,
          interrupted,
        }),
      ),
      0o600,
    )
  } catch {
    cleanup = 'unknown'
  }
  process.exitCode = cleanup === 'complete' ? (status ?? 1) : 1
}

// Read-only shell bridge. No caller can use it to publish compatibility.
async function cli() {
  try {
    const [op, arg, extra] = process.argv.slice(2)
    if (op === '--launch') {
      await launch(arg, extra, process.argv.slice(5))
    } else if (op === '--launch-result') {
      const { jsonAt, object } = await import('../../dist/src/control-layer-state.mjs')
      const value = jsonAt(arg)
      if (
        !object(value) ||
        value.version !== 1 ||
        value.launcher !== Number(extra) ||
        value.phase !== 'complete' ||
        value.cleanup !== 'complete' ||
        !Number.isSafeInteger(value.adapter) ||
        value.adapter < 1 ||
        !(
          (Number.isSafeInteger(value.status) &&
            value.status >= 0 &&
            value.status <= 255 &&
            value.signal === null) ||
          (value.status === null && /^SIG[A-Z0-9]+$/.test(String(value.signal)))
        ) ||
        typeof value.interrupted !== 'boolean' ||
        typeof value.delegated !== 'boolean'
      )
        process.exitCode = 2
      else process.exitCode = value.delegated ? 0 : 1
    } else if (op === '--version') {
      const result = isolatedCommand(arg, ['--version'], { timeoutMs: 2000 })
      if (result.status !== 0) throw new Error('isolated version unavailable')
      process.stdout.write(result.stdout)
    } else if (op === '--fallback-reason') {
      const { readUpdateState } = await import('../../dist/src/startup-compat.mjs')
      const block = readUpdateState(arg).block
      if (block?.codexPath === extra)
        process.stdout.write(`mandatory update failed: ${block.reason}`)
    } else if (op === '--record-fallback') {
      const { readFallback, publishState } = await import('../../dist/src/startup-compat.mjs')
      readFallback(arg)
      publishState(join(arg, 'shim-fallback.json'), JSON.parse(extra))
    } else throw new Error('unsupported startup helper command')
  } catch (error) {
    console.error(String(error))
    process.exitCode = process.argv[2] === '--launch-result' ? 2 : 1
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) void cli()
