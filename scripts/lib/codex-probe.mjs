// What every zero-spend codex probe shares (capture-codex-wire,
// capture-codex-spawn): the codex it runs, a probe folder whose CODEX_HOME and
// HOME exist before codex first runs, and sandbox-exec around every codex
// call.
//
// The sandbox denies all outbound traffic except loopback (0.159's
// curated-plugin sync goes to github.com and to a chatgpt.com URL no
// base-URL setting moves) and every write under the real ~/.codex,
// ~/.anyengine and ~/.claude, even if the isolation of the probe home were
// lost. Without sandbox-exec a probe does not run.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

// The update gate runs the probes unattended: no single codex call may wait
// forever.
export const QUICK_MS = 30_000

// The codex a probe runs: `explicit`, else the app's bundled codex by the
// adapter's own rule (src/bundled-codex.mts; the probe builds first).
export async function probeCodex(repo, explicit) {
  if (explicit) return explicit
  const url = pathToFileURL(join(repo, 'dist', 'src', 'bundled-codex.mjs')).href
  const { resolveBundledCodex } = await import(url)
  return resolveBundledCodex().path
}

// Exits 1, naming the probe, when sandbox-exec is missing.
export function requireSandbox(name) {
  if (existsSync(SANDBOX_EXEC)) return
  console.error(
    `${name}: ${SANDBOX_EXEC} is missing; this probe runs only with outbound traffic denied`,
  )
  process.exit(1)
}

const realPath = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// The sandbox profile: loopback only, and no write under the real homes.
export function noWayOut() {
  const guarded = [
    join(homedir(), '.codex'),
    join(homedir(), '.anyengine'),
    join(homedir(), '.claude'),
    process.env.CODEX_HOME,
  ]
    .filter(Boolean)
    .map(realPath)
  return [
    '(version 1)(allow default)',
    '(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))',
    `(deny file-write* ${guarded.map((path) => `(subpath ${JSON.stringify(path)})`).join(' ')})`,
  ].join('')
}

// spawn/spawnSync arguments that run `codex ...args` inside the sandbox.
export function sandboxed(codex) {
  const profile = noWayOut()
  return (args) => [SANDBOX_EXEC, ['-p', profile, codex, ...args]]
}

// A new probe folder `<prefix>XXXXXX` in the temp directory, with the codex
// home, the fake HOME and a work folder already made (every codex call,
// `--version` included, writes under $CODEX_HOME: 0.159 makes tmp/arg0/
// there), removed when the process exits. `prefix` must not start with
// `anyengine-`: a test run on this machine counts such entries in the temp
// directory as its own strays (scripts/hermetic-strays.mjs).
export function probeDirs(prefix) {
  const probe = mkdtempSync(join(tmpdir(), prefix))
  process.on('exit', () => rmSync(probe, { recursive: true, force: true }))
  const home = join(probe, 'codex-home')
  const fakeHome = join(probe, 'home')
  const work = join(probe, 'work')
  for (const dir of [home, fakeHome, work]) mkdirSync(dir, { recursive: true })
  const env = { HOME: fakeHome, CODEX_HOME: home, PATH: '/usr/bin:/bin', RUST_LOG: 'warn' }
  return { probe, home, fakeHome, work, env }
}

// `codex --version`'s version number, or null.
export function codexVersion(run, _env) {
  const [command, args] = run(['--version'])
  if (command !== SANDBOX_EXEC || args[0] !== '-p' || typeof args[2] !== 'string') return null
  const result = isolatedCommand(args[2], ['--version'])
  return result.status === 0 ? (/^codex-cli\s+(\S+)\s*$/m.exec(result.stdout)?.[1] ?? null) : null
}

// A bounded official help/version/schema command. The synchronous boundary is
// needed by router health's version cache; the supervisor awaits its direct
// child. The caller owns its detached process group and unconditionally kills
// and joins remaining descendants before inspecting output or removing homes.
export function isolatedCommand(binary, args, options = {}) {
  const timeout = options.timeoutMs ?? QUICK_MS
  if (!Number.isFinite(timeout) || timeout < 500 || timeout > QUICK_MS)
    throw new Error('isolated probe deadline must be between 500 and 30000 ms')
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC))
    throw new Error('isolated probe requires the macOS sandbox')
  const deadline = performance.now() + timeout
  const probe = realpathSync(mkdtempSync(join(tmpdir(), 'codex-isolated-')))
  const identity = lstatSync(probe)
  const home = join(probe, 'home')
  const codex = join(probe, 'codex')
  const work = join(probe, 'work')
  const temp = join(probe, 'tmp')
  const bin = join(probe, 'bin')
  let cleaned = true
  let homeOwned = true
  let answer
  try {
    for (const dir of [home, codex, work, temp, bin]) mkdirSync(dir)
    // npm's Codex launcher uses /usr/bin/env node; expose only this running Node.
    symlinkSync(process.execPath, join(bin, 'node'))
    const env = {
      ...Object.fromEntries(
        Object.entries(options.env ?? {}).filter(([key]) => key.startsWith('FAKE_')),
      ),
      HOME: home,
      CODEX_HOME: codex,
      TMPDIR: temp,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      PATH: `${bin}:/usr/bin:/bin`,
      LANG: 'en_US.UTF-8',
      RUST_LOG: 'warn',
      PROBE_HOME: probe,
      PROBE_IDENTITY: `${identity.dev}:${identity.ino}`,
      PROBE_DEADLINE: String(Date.now() + Math.max(0, deadline - performance.now())),
      PROBE_POLICY: `(version 1)(allow default)(deny network*)
        (allow network* (remote ip "localhost:*"))
        (deny file-write*)(allow file-write* (subpath ${JSON.stringify(probe)}))
        (allow file-write* (literal "/dev/null"))`,
    }
    mkdirSync(env.CLAUDE_CONFIG_DIR)
    writeFileSync(
      join(codex, 'config.toml'),
      'model_provider="probe"\n[model_providers.probe]\nname="refusing probe"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nexperimental_bearer_token="probe-not-a-secret"\n',
    )
    const commandArgs = typeof args === 'function' ? args({ probe, home, codex, work }) : args
    const [command, prefix] = binary.endsWith('.mjs') ? [process.execPath, [binary]] : [binary, []]
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./codex-probe-runner.mjs', import.meta.url)),
        command,
        ...prefix,
        ...commandArgs,
      ],
      {
        cwd: work,
        env,
        encoding: 'utf8',
        detached: true,
        maxBuffer: 8 * 1024 * 1024,
        // Reserve part of the TOTAL deadline for unconditional family cleanup.
        timeout: Math.max(1, Math.floor(deadline - performance.now() - 350)),
        killSignal: 'SIGKILL',
      },
    )
    cleaned = reapProbeGroup(result.pid, deadline)
    if (!cleaned)
      console.error(
        `isolated probe cleanup failed: pid ${result.pid}; retain ${probe}; binary ${binary}`,
      )
    const failed = result.error || !cleaned || performance.now() >= deadline
    answer = {
      status: failed ? null : result.status,
      stdout: result.stdout ?? '',
      stderr: `${result.stderr ?? ''}${result.error ? String(result.error) : ''}${result.signal ? ` supervisor terminated: ${result.signal}` : ''}${!cleaned ? ' probe family cleanup failed' : ''}`,
    }
    homeOwned = ownsProbeHome(probe, identity, answer)
    if (options.read && homeOwned) answer.value = options.read({ probe, home, codex, work }, answer)
    return answer
  } finally {
    // A failed join is explicit and retains the owned home for diagnosis.
    if (cleaned && homeOwned && ownsProbeHome(probe, identity, answer))
      rmSync(probe, { recursive: true, force: true })
    if (answer && performance.now() >= deadline) {
      answer.status = null
      answer.stderr += ' total probe deadline exceeded'
    }
  }
}

function ownsProbeHome(probe, identity, answer) {
  try {
    const current = lstatSync(probe)
    if (current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino)
      return true
  } catch {} // Missing or unreadable is not positive ownership.
  if (answer) {
    answer.status = null
    delete answer.value
    answer.stderr += ` probe home ownership unknown; retain ${probe}`
  }
  return false
}

function reapProbeGroup(pid, deadline) {
  if (!pid) return true // spawn failed before creating a supervisor
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if (error.code === 'ESRCH') return true
    if (error.code !== 'EPERM') return false
  }
  while (performance.now() < deadline) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return true
      if (error.code !== 'EPERM') return false
    }
    // The OS can retain a killed orphan as a zombie briefly. It cannot execute
    // or write; macOS can return EPERM for that terminal group. Only this
    // scoped observation (never EPERM alone) establishes absence or zombies.
    const state = spawnSync('/bin/ps', ['-o', 'stat=', '-g', String(pid)], {
      encoding: 'utf8',
      timeout: Math.max(1, Math.floor(deadline - performance.now())),
    })
    if (state.status === 1 && !state.stdout.trim() && !state.stderr.trim()) return true
    if (
      state.status === 0 &&
      state.stdout
        .trim()
        .split('\n')
        .every((line) => /^\s*Z/.test(line))
    )
      return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
  return false
}
