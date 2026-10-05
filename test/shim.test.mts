import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { killChildren, spawn, stopProcess, waitForOutput } from './helpers/children.mjs'

after(() => killChildren())

const shim = resolve('scripts/codex-shim')
const adapter = resolve('dist/src/adapter.mjs')
const fallback = resolve('test/fixtures/fake-codex-fallback.mjs')

// A codex binary: a shell wrapper around the fake, tagged so a test can tell
// which of two fakes the shim ran.
async function fakeCodex(dir: string, tag: string): Promise<string> {
  const path = join(dir, `codex-${tag}`)
  await writeFakeCodex(path, tag)
  return path
}

// Writes the tagged wrapper and warms it up (`--version` records nothing).
async function writeFakeCodex(path: string, tag: string): Promise<void> {
  await writeFile(
    path,
    `#!/bin/sh\nFAKE_CODEX_TAG=${tag} exec "${process.execPath}" "${fallback}" "$@"\n`,
  )
  await chmod(path, 0o755)
  warmUp(path)
}

// Runs a new executable once with `--version` and no stdin. macOS checks a new
// executable on its first exec, which took up to 3 s here on a loaded
// machine; that check is not what a test times.
function warmUp(path: string): void {
  const warm = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  assert.equal(warm.status, 0, `${path} --version: ${warm.stderr}`)
}

// An adapter whose static imports cannot resolve: what a pruned
// node_modules looks like to the shim.
async function brokenAdapter(dir: string): Promise<string> {
  const path = join(dir, 'broken-adapter.mjs')
  await writeFile(path, "import 'this-package-does-not-exist'\n")
  return path
}

// Passes its selfcheck, then dies before binding anything.
async function dyingAdapter(dir: string): Promise<string> {
  const path = join(dir, 'dying-adapter.mjs')
  await writeFile(path, "if (process.argv[2] === 'selfcheck') process.exit(0)\nprocess.exit(1)\n")
  return path
}

function shimEnv(home: string, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    ANYENGINE_RUNTIME_ENV: '/dev/null',
    ANYENGINE_NODE: process.execPath,
    ANYENGINE_DEBUG_LOG: join(home, 'debug.jsonl'),
    FAKE_CODEX_ARGV_FILE: join(home, 'fake-argv.json'),
    NODE_NO_WARNINGS: '1',
    ...extra,
  }
}

// A generous give-up: the shim's chain starts several node processes, which
// take seconds on a loaded machine. A test that must prove speed asserts it.
async function waitForFile(path: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      await new Promise((r) => setTimeout(r, 40))
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function home(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  await mkdir(join(dir, '.codex'), { recursive: true })
  return dir
}

test('adapter selfcheck loads every static import and exits 0', () => {
  const quick = spawnSync(process.execPath, [adapter, 'selfcheck'], { encoding: 'utf8' })
  assert.equal(quick.status, 0, quick.stderr)
  assert.equal(quick.stdout.trim(), 'anyengine selfcheck ok')
  const deep = spawnSync(process.execPath, [adapter, 'selfcheck', '--deep'], { encoding: 'utf8' })
  assert.equal(deep.status, 0, deep.stderr)
  assert.equal(deep.stdout.trim(), 'anyengine selfcheck ok (deep)')
})
test('every adapter failure refuses WebSocket listen forms before any vendor listener', async () => {
  for (const missing of [true, false]) {
    const dir = await home('anyengine-shim-ws-failure-')
    try {
      const broken = missing ? join(dir, 'missing-adapter.mjs') : await brokenAdapter(dir)
      const vendor = await fakeCodex(dir, 'ws-refusal')
      for (const listen of [
        ['--listen', 'ws://127.0.0.1:9876'],
        ['--listen=ws://127.0.0.1:9876'],
        ['--listen', 'wss://127.0.0.1:9876'],
      ]) {
        const recording = join(dir, 'fake-argv.json')
        const result = spawnSync(shim, ['app-server', ...listen], {
          env: shimEnv(dir, {
            ANYENGINE_ADAPTER: broken,
            ANYENGINE_REAL_CODEX: vendor,
            ANYENGINE_WS_BEARER_TOKEN: 'fixture-token',
          }),
          encoding: 'utf8',
          timeout: 15_000,
        })
        assert.equal(result.status, 78, result.stderr)
        assert.match(result.stderr, /direct-cli-required/)
        assert.equal(existsSync(recording), false)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

// The shim runs selfcheck before every app launch: it must end once it has
// answered, whatever handle a loaded module left open.
test('selfcheck exits after its line even with a live handle', () => {
  const keepAlive = 'data:text/javascript,setInterval(() => {}, 1000)'
  const result = spawnSync(process.execPath, ['--import', keepAlive, adapter, 'selfcheck'], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(result.signal, null, 'selfcheck hung')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'anyengine selfcheck ok')
})

// The app keeps the shim's stdin open; the probes the shim runs before the
// launch (the adapter's selfcheck, the bundled codex's --version) get none of
// it, so one that reads stdin sees EOF instead of hanging every launch.
test('the launch probes read no stdin', async () => {
  const dir = await home('anyengine-shim-stdin-')
  const probeAdapter = join(dir, 'stdin-adapter.mjs')
  await writeFile(
    probeAdapter,
    [
      "if (process.argv[2] === 'selfcheck') {",
      '  process.stdin.resume()',
      "  process.stdin.on('end', () => process.exit(0))",
      '} else {',
      '  console.log(`adapter ran ${process.env.ANYENGINE_COMPAT_VERSION}`)',
      '}',
      '',
    ].join('\n'),
  )
  const bundled = join(dir, 'stdin-codex')
  await writeFile(bundled, '#!/bin/sh\nwhile read -r _; do :; done\necho "codex-cli 9.9.9"\n')
  await chmod(bundled, 0o755)
  warmUp(bundled) // its stdin is /dev/null here: it prints at once
  const proc = spawn(shim, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: shimEnv(dir, {
      ANYENGINE_ADAPTER: probeAdapter,
      ANYENGINE_REAL_CODEX: bundled,
      ANYENGINE_MOCK: '0',
    }),
  })
  try {
    // stdin stays open, as the app's pipe does. A probe that read it would
    // hang past the give-up; the chain starts several processes, which take
    // seconds on a loaded machine.
    assert.match(await waitForOutput(proc, /adapter ran/, 30_000), /adapter ran 9\.9\.9/)
  } finally {
    // The stand-in exits on its own once it has printed; a SIGKILL then could
    // land while it writes its coverage file.
    if ((await exitCode(proc)) === 'still running') proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('a stdio launch with a broken adapter execs the bundled codex, loudly', async () => {
  const dir = await home('anyengine-shim-stdio-')
  const stderr: string[] = []
  const proc = spawn(
    shim,
    ['-c', 'features.code_mode_host=true', 'app-server', '--listen', 'stdio://'],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: shimEnv(dir, {
        ANYENGINE_ADAPTER: await brokenAdapter(dir),
        ANYENGINE_REAL_CODEX: await fakeCodex(dir, 'bundled'),
        CODEX_REAL: await fakeCodex(dir, 'nvm'),
      }),
    },
  )
  proc.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
  try {
    const recorded = JSON.parse(await waitForFile(join(dir, 'fake-argv.json')))
    assert.equal(recorded.tag, 'bundled', 'the bundled codex, never CODEX_REAL, when both exist')
    assert.deepEqual(recorded.argv, [
      '-c',
      'features.code_mode_host=true',
      'app-server',
      '--listen',
      'stdio://',
    ])
    const marker = JSON.parse(await readFile(join(dir, '.anyengine', 'shim-fallback.json'), 'utf8'))
    assert.equal(marker.event, 'shim.fallback')
    assert.equal(marker.kind, 'bundled')
    assert.match(marker.reason, /selfcheck failed/)
    const debug = await readFile(join(dir, 'debug.jsonl'), 'utf8')
    assert.match(debug, /"event":"shim\.fallback"/)
    assert.match(stderr.join(''), /codex shim: FALLBACK to the bundled codex/)
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('a unix daemon whose adapter dies before binding falls back within seconds', async () => {
  const dir = await home('anyengine-shim-unix-')
  const sock = join(tmpdir(), `ccx-fb-${Date.now().toString(36)}.sock`)
  // Built, and the fake codex run once, before the clock starts.
  const env = shimEnv(dir, {
    ANYENGINE_ADAPTER: await dyingAdapter(dir),
    ANYENGINE_REAL_CODEX: await fakeCodex(dir, 'bundled'),
  })
  const started = Date.now()
  const proc = spawn(shim, ['app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env,
  })
  try {
    // Four node start-ups (selfcheck, --version, the adapter, the fallback)
    // take seconds on a loaded machine. The shim gives up on the socket after
    // 10 s; under 8 s still proves the dead adapter was noticed, not waited out.
    const recorded = JSON.parse(await waitForFile(join(dir, 'fake-argv.json'), 12_000))
    assert.ok(Date.now() - started < 8000, 'the dead adapter is noticed, not waited out')
    assert.equal(recorded.tag, 'bundled')
    assert.deepEqual(recorded.argv, ['app-server', '--listen', `unix://${sock}`])
    const marker = JSON.parse(await readFile(join(dir, '.anyengine', 'shim-fallback.json'), 'utf8'))
    assert.match(marker.reason, /did not create/)
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
    await rm(sock, { force: true })
  }
})

test('a bundled codex that is named but gone falls to CODEX_REAL, and says it is not bundled', async () => {
  const dir = await home('anyengine-shim-gone-')
  const proc = spawn(shim, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: shimEnv(dir, {
      ANYENGINE_ADAPTER: await brokenAdapter(dir),
      ANYENGINE_REAL_CODEX: join(dir, 'no-such-codex'),
      CODEX_REAL: await fakeCodex(dir, 'nvm'),
    }),
  })
  try {
    const recorded = JSON.parse(await waitForFile(join(dir, 'fake-argv.json')))
    assert.equal(recorded.tag, 'nvm')
    const marker = JSON.parse(await readFile(join(dir, '.anyengine', 'shim-fallback.json'), 'utf8'))
    assert.equal(marker.kind, 'non-bundled CODEX_REAL')
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

// 2026-09-30: an app update moved the bundled codex that runtime.env named.
// The shim skips the stale name for the app's own codex, and says so.
test('a named codex that an app update moved falls to the app layout, loudly', async () => {
  const dir = await home('anyengine-shim-moved-')
  const app = join(dir, 'ChatGPT.app')
  const layout = join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS')
  await mkdir(layout, { recursive: true })
  await writeFakeCodex(join(layout, 'codex'), 'app')
  const moved = join(app, 'Contents/Resources/codex')
  const stderr: string[] = []
  const proc = spawn(shim, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: shimEnv(dir, {
      ANYENGINE_ADAPTER: await brokenAdapter(dir),
      ANYENGINE_REAL_CODEX: moved,
      ANYENGINE_CHATGPT_APP: app,
      CODEX_REAL: await fakeCodex(dir, 'nvm'),
    }),
  })
  proc.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
  try {
    const recorded = JSON.parse(await waitForFile(join(dir, 'fake-argv.json')))
    assert.equal(recorded.tag, 'app', "the app's own codex, not CODEX_REAL")
    const marker = JSON.parse(await readFile(join(dir, '.anyengine', 'shim-fallback.json'), 'utf8'))
    assert.equal(marker.kind, 'bundled')
    assert.equal(marker.codex, join(layout, 'codex'))
    assert.match(
      stderr.join(''),
      new RegExp(
        `ANYENGINE_REAL_CODEX=${moved} is not an executable file.*running ${layout}/codex instead`,
      ),
    )
    const debug = await readFile(join(dir, 'debug.jsonl'), 'utf8')
    assert.match(
      debug,
      /"event":"shim\.staleRealCodex","configured":"[^"]*Contents\/Resources\/codex"/,
    )
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

// A fake ChatGPT.app whose 26.928-layout codex is the tagged fake.
async function fakeApp(dir: string, tag: string): Promise<string> {
  const app = join(dir, 'ChatGPT.app')
  const macos = join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS')
  await mkdir(macos, { recursive: true })
  await writeFakeCodex(join(macos, 'codex'), tag)
  return app
}

// A PATH with a `codex` ahead of the rest, as an npm-global codex is on the
// app's PATH (0.154.0 there on 2026-09-30, while the app shipped 0.159.0).
async function pathWithCodex(dir: string, tag: string): Promise<string> {
  const bin = join(dir, 'path-bin')
  await mkdir(bin, { recursive: true })
  await writeFakeCodex(join(bin, 'codex'), tag)
  return `${bin}:${process.env.PATH ?? ''}`
}

// After the flip the app hands `$CODEX_CLI_PATH`, the shim, to whatever it
// spawns. Every command but --version and app-server runs the app's codex.
test("any other command runs the app's codex, never the one first on PATH", async () => {
  const dir = await home('anyengine-shim-pass-')
  try {
    const run = (args: string[], extra: NodeJS.ProcessEnv) =>
      spawnSync(shim, args, {
        encoding: 'utf8',
        env: shimEnv(dir, { ANYENGINE_REAL_CODEX: '', ...extra }),
      })
    const recorded = async () => JSON.parse(await readFile(join(dir, 'fake-argv.json'), 'utf8'))
    const PATH = await pathWithCodex(dir, 'nvm')
    const app = await fakeApp(dir, 'app')

    const passed = run(['exec', '--json', 'hi'], { PATH, ANYENGINE_CHATGPT_APP: app })
    assert.equal(passed.status, 0, passed.stderr)
    assert.deepEqual(await recorded(), { tag: 'app', argv: ['exec', '--json', 'hi'] })
    assert.doesNotMatch(passed.stderr, /did not ship/)

    // The shim's native mode runs the app's codex for app-server too.
    const native = run(['app-server', '--listen', 'stdio://'], {
      PATH,
      ANYENGINE_CHATGPT_APP: app,
      ANYENGINE_ROUTE: 'codex',
    })
    assert.equal(native.status, 0, native.stderr)
    assert.equal((await recorded()).tag, 'app')

    // No app codex: the PATH codex runs, and says it is not the app's.
    const none = run(['exec', 'hi'], { PATH, ANYENGINE_CHATGPT_APP: join(dir, 'no-app') })
    assert.equal(none.status, 0, none.stderr)
    assert.equal((await recorded()).tag, 'nvm')
    assert.match(
      none.stderr,
      /codex shim: no codex in .*no-app; running .*path-bin\/codex, which the app did not ship/,
    )
    const debug = await readFile(join(dir, 'debug.jsonl'), 'utf8')
    assert.match(
      debug,
      /"event":"shim\.nonBundledCodex","codex":"[^"]*path-bin\/codex","subcommand":"exec"/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the fallback still runs when its marker cannot be written', async () => {
  const dir = await home('anyengine-shim-rohome-')
  // A HOME whose .anyengine is a file: mkdir -p fails, the fallback must not.
  await writeFile(join(dir, '.anyengine'), 'not a directory\n')
  const proc = spawn(shim, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: shimEnv(dir, {
      ANYENGINE_ADAPTER: await brokenAdapter(dir),
      ANYENGINE_REAL_CODEX: await fakeCodex(dir, 'bundled'),
      ANYENGINE_DEBUG_LOG: join(dir, '.anyengine', 'debug.jsonl'),
    }),
  })
  try {
    const recorded = JSON.parse(await waitForFile(join(dir, 'fake-argv.json')))
    assert.equal(recorded.tag, 'bundled')
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('a current link that points at a removed version still reaches the fallback', async () => {
  const dir = await home('anyengine-shim-dangling-')
  const lib = join(dir, '.anyengine', 'lib')
  await mkdir(lib, { recursive: true })
  await symlink('v-gone', join(lib, 'current'))
  const proc = spawn(shim, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // The shim's own default adapter: nothing sets ANYENGINE_ADAPTER.
    env: shimEnv(dir, { ANYENGINE_REAL_CODEX: await fakeCodex(dir, 'bundled') }),
  })
  try {
    const recorded = JSON.parse(await waitForFile(join(dir, 'fake-argv.json')))
    assert.equal(recorded.tag, 'bundled')
    const marker = JSON.parse(await readFile(join(dir, '.anyengine', 'shim-fallback.json'), 'utf8'))
    assert.match(marker.reason, /selfcheck failed for .*lib\/current\/dist\/src\/adapter\.mjs/)
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('a healthy adapter is launched and nothing is marked', async () => {
  const dir = await home('anyengine-shim-ok-')
  const proc = spawn(shim, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: shimEnv(dir, {
      ANYENGINE_ADAPTER: adapter,
      ANYENGINE_MOCK: '1',
      ANYENGINE_REAL_CODEX: await fakeCodex(dir, 'bundled'),
    }),
  })
  try {
    const initialize = { clientInfo: { name: 't', version: '0' } }
    proc.stdin?.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initialize })}\n`,
    )
    await waitForOutput(proc, /"userAgent":"[^"]*anyengine/)
    await assert.rejects(readFile(join(dir, '.anyengine', 'shim-fallback.json')))
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

// Regression: a second bootstrap racing the first must not mistake the real
// adapter's deliberate "already running" exit (ensureSingleUnixDaemon,
// src/adapter.mts) for a dead one. The pidfile names a live process that is
// not the one this shim just spawned, so the shim keeps waiting for that
// process's socket instead of falling back onto a daemon that is healthy.
test('a live daemon already owns the socket: the shim waits, and marks nothing', async () => {
  const dir = await home('anyengine-shim-owner-')
  const sock = join(tmpdir(), `ccx-owner-${Date.now().toString(36)}.sock`)
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  await writeFile(`${sock}.pid`, `${owner.pid}\n`)
  const stderr: string[] = []
  // Its own process group: the shim, the adapter it backgrounds and its
  // `sleep`s all go with one kill, so none keeps the stderr pipe (and the
  // suite) open after the test.
  const proc = spawn(shim, ['app-server', '--listen', `unix://${sock}`], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: shimEnv(dir, {
      // Intentional SIGKILL retains its private launch record under this owned home.
      TMPDIR: dir,
      // The real adapter: only it runs ensureSingleUnixDaemon's "already
      // running" check that this test exercises.
      ANYENGINE_ADAPTER: adapter,
      ANYENGINE_MOCK: '1',
      ANYENGINE_REAL_CODEX: await fakeCodex(dir, 'bundled'),
    }),
  })
  proc.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
  try {
    // The shim's own adapter saw the live pidfile and deferred to its owner.
    const deferred = new RegExp(`app-server already running at .*\\(pid ${owner.pid}\\)`)
    const deadline = Date.now() + 15_000
    while (!deferred.test(stderr.join(''))) {
      assert.ok(Date.now() < deadline, `no "already running" line: ${stderr.join('')}`)
      await new Promise((r) => setTimeout(r, 25))
    }
    // The shim polls every 0.1 s; the old regression fell back on the next
    // poll after that exit. Several polls later, still no fallback.
    await new Promise((r) => setTimeout(r, 600))
    await assert.rejects(readFile(join(dir, 'fake-argv.json')))
    await assert.rejects(readFile(join(dir, '.anyengine', 'shim-fallback.json')))
    assert.equal(proc.exitCode, null, 'the shim is still waiting on the owner')
  } finally {
    // Only with a pid: process.kill(-0) would signal this suite's own group.
    try {
      if (proc.pid) process.kill(-proc.pid, 'SIGKILL')
    } catch {}
    // Should the pidfile ever name another process (the adapter taking the
    // socket over), stop that exact pid; never the owner by accident.
    const named = Number((await readFile(`${sock}.pid`, 'utf8').catch(() => '')).trim())
    if (named > 0 && named !== owner.pid) await stopProcess(named)
    owner.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
    await rm(`${sock}.pid`, { force: true })
    await rm(sock, { force: true })
  }
})

// Regression: when neither the bundled codex nor CODEX_REAL resolves, the
// shim used to say so on stderr only. This is exactly the "user loses Codex
// entirely" case the shim exists to surface, so it must still leave a
// durable record.
test('nothing can run: still records a marker (kind "none"), stdio fails and unix exits clean', async () => {
  const dirStdio = await home('anyengine-shim-none-stdio-')
  try {
    const stdio = spawnSync(shim, ['app-server', '--listen', 'stdio://'], {
      encoding: 'utf8',
      env: shimEnv(dirStdio, {
        ANYENGINE_ADAPTER: await brokenAdapter(dirStdio),
        ANYENGINE_REAL_CODEX: join(dirStdio, 'no-such-codex'),
      }),
    })
    assert.equal(stdio.status, 1)
    const marker = JSON.parse(
      await readFile(join(dirStdio, '.anyengine', 'shim-fallback.json'), 'utf8'),
    )
    assert.equal(marker.kind, 'none')
    assert.equal(marker.codex, '')
    assert.match(marker.reason, /no bundled codex to fall back to/)
  } finally {
    await rm(dirStdio, { recursive: true, force: true })
  }

  const dirUnix = await home('anyengine-shim-none-unix-')
  const sock = join(tmpdir(), `ccx-none-${Date.now().toString(36)}.sock`)
  try {
    const unix = spawnSync(shim, ['app-server', '--listen', `unix://${sock}`], {
      encoding: 'utf8',
      env: shimEnv(dirUnix, {
        ANYENGINE_ADAPTER: await brokenAdapter(dirUnix),
        ANYENGINE_REAL_CODEX: join(dirUnix, 'no-such-codex'),
      }),
    })
    assert.equal(unix.status, 0, 'the App SSH bootstrap must still see a clean exit')
    const marker = JSON.parse(
      await readFile(join(dirUnix, '.anyengine', 'shim-fallback.json'), 'utf8'),
    )
    assert.equal(marker.kind, 'none')
    assert.equal(marker.codex, '')
  } finally {
    await rm(dirUnix, { recursive: true, force: true })
    await rm(sock, { force: true })
  }
})

const fakeAppServer = resolve('test/fixtures/fake-codex-app-server.mjs')

// A home short enough that its control socket fits sockaddr_un (104 bytes
// on macOS): the guard only applies to that exact path.
async function shortHome(): Promise<string> {
  const dir = await mkdtemp('/tmp/ae-twin-')
  await mkdir(join(dir, 'app-server-control'), { recursive: true })
  return dir
}

function controlSocket(home: string): string {
  return join(home, 'app-server-control', 'app-server-control.sock')
}

// The adapter daemon outlives the shim (it is disowned); stop it by pid and
// wait until it is gone, so it does not exit (and write its coverage file)
// after the suite.
async function stopDaemon(home: string): Promise<void> {
  const pidFile = `${controlSocket(home)}.pid`
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8'))
  if (pid > 0) await stopProcess(pid)
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('twin: a daemon without a native codex child refuses the control socket', async () => {
  const home = await shortHome()
  try {
    const result = spawnSync(process.execPath, [adapter, 'app-server', '--listen', 'unix://'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, CODEX_HOME: home, ANYENGINE_MOCK: '1', NODE_NO_WARNINGS: '1' },
    })
    assert.equal(result.status, 78, result.stderr)
    assert.match(result.stderr, /refusing the app-server control socket/)
    assert.ok(!existsSync(controlSocket(home)))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('twin: a daemon with a native codex child may own the control socket', async () => {
  const home = await shortHome()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: home,
    ANYENGINE_MOCK: '1',
    NODE_NO_WARNINGS: '1',
    ANYENGINE_REAL_CODEX: fakeAppServer,
  }
  delete env.ANYENGINE_NATIVE_CODEX
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'unix://'], {
    stdio: 'ignore',
    env,
  })
  try {
    await waitForPath(controlSocket(home))
  } finally {
    proc.kill('SIGKILL')
    await rm(home, { recursive: true, force: true })
  }
})

function nativeTwinEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: home,
    ANYENGINE_MOCK: '1',
    NODE_NO_WARNINGS: '1',
    ANYENGINE_REAL_CODEX: fakeAppServer,
  }
  delete env.ANYENGINE_NATIVE_CODEX
  return env
}

async function exitCode(proc: ReturnType<typeof spawn>, timeoutMs = 10_000): Promise<unknown> {
  if (proc.exitCode !== null) return proc.exitCode
  const timer = new Promise((r) => setTimeout(() => r('still running'), timeoutMs).unref())
  return Promise.race([once(proc, 'exit').then(([code]) => code), timer])
}

function ask(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let reply = ''
    const socket = net.createConnection(socketPath)
    socket.on('data', (chunk) => {
      reply += String(chunk)
    })
    socket.once('end', () => resolve(reply))
    socket.once('error', reject)
  })
}

// Retries until something accepts on `socketPath`, or gives up.
async function connects(socketPath: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolveConnect) => {
      const probe = net.createConnection(socketPath)
      probe.once('connect', () => resolveConnect(true))
      probe.once('error', () => resolveConnect(false))
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

// A real codex daemon on the control socket writes no pidfile. The adapter
// asks the socket before it touches it: something answers, so it defers, as
// codex does, and the owner keeps serving. Only a socket nothing listens on is
// removed, and a path that is not a socket is never deleted.
test('twin: a live control socket is left to its owner; only a dead socket is replaced', async () => {
  const home = await shortHome()
  const sock = controlSocket(home)
  const launch = (stdio: 'ignore' | 'pipe' = 'ignore') =>
    spawn(process.execPath, [adapter, 'app-server', '--listen', 'unix://'], {
      stdio: ['ignore', 'ignore', stdio],
      env: nativeTwinEnv(home),
    })
  // The adapter's probe hangs up at once, so the owner's reply can meet EPIPE.
  const owner = net.createServer((socket) => socket.on('error', () => {}).end('owner\n'))
  await new Promise<void>((resolveListen) => owner.listen(sock, resolveListen))
  try {
    const deferring = launch('pipe')
    const stderr: string[] = []
    deferring.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
    assert.equal(await exitCode(deferring), 0, stderr.join(''))
    assert.match(stderr.join(''), /already running at .*app-server-control\.sock/)
    assert.equal(await ask(sock), 'owner\n', "the owner's socket still answers")
    assert.ok(!existsSync(`${sock}.pid`), 'no pidfile claims the socket')
    await new Promise((resolveClose) => owner.close(resolveClose))

    // A socket whose owner died without removing it is stale: replaced.
    const dead = spawn(
      process.execPath,
      [
        '-e',
        `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.kill(process.pid, 'SIGKILL'))`,
      ],
      { stdio: 'ignore' },
    )
    await once(dead, 'exit')
    assert.ok(existsSync(sock), 'a killed listener leaves its socket file behind')
    const replacing = launch()
    const connected = await connects(sock)
    replacing.kill('SIGKILL')
    await once(replacing, 'exit')
    assert.ok(connected, 'the adapter listens on the replaced socket')

    // Not a socket at all: left in place, and the adapter fails to bind.
    await rm(sock, { force: true })
    await rm(`${sock}.pid`, { force: true })
    await writeFile(sock, 'not a socket\n')
    assert.equal(await exitCode(launch()), 1)
    assert.equal(await readFile(sock, 'utf8'), 'not a socket\n')
  } finally {
    owner.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('twin: the shim hands the control socket to the bundled codex, with no fallback marker', async () => {
  const home = await shortHome()
  const stderr: string[] = []
  const proc = spawn(shim, ['app-server', '--listen', 'unix://'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: shimEnv(home, {
      CODEX_HOME: home,
      ANYENGINE_ADAPTER: adapter,
      ANYENGINE_MOCK: '1',
      ANYENGINE_REAL_CODEX: await fakeCodex(home, 'bundled'),
    }),
  })
  proc.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
  try {
    const recorded = JSON.parse(await waitForFile(join(home, 'fake-argv.json')))
    assert.equal(recorded.tag, 'bundled')
    assert.deepEqual(recorded.argv, ['app-server', '--listen', 'unix://'])
    assert.match(stderr.join(''), /the control socket needs a native codex child/)
    await assert.rejects(readFile(join(home, '.anyengine', 'shim-fallback.json')))
  } finally {
    proc.kill('SIGKILL')
    await stopDaemon(home)
    await rm(home, { recursive: true, force: true })
  }
})

test('twin: with ANYENGINE_REMOTE_NATIVE_CODEX=1 the adapter owns the control socket', async () => {
  const home = await shortHome()
  const proc = spawn(shim, ['app-server', '--listen', 'unix://'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: shimEnv(home, {
      CODEX_HOME: home,
      ANYENGINE_ADAPTER: adapter,
      ANYENGINE_MOCK: '1',
      ANYENGINE_REMOTE_NATIVE_CODEX: '1',
      ANYENGINE_REAL_CODEX: fakeAppServer,
    }),
  })
  try {
    const [code] = (await once(proc, 'exit')) as [number | null]
    assert.equal(code, 0)
    assert.ok(existsSync(controlSocket(home)))
    await assert.rejects(readFile(join(home, '.anyengine', 'shim-fallback.json')))
  } finally {
    await stopDaemon(home)
    await rm(home, { recursive: true, force: true })
  }
})

// The adapter's refusal (exit 78) is a dead adapter to the shim's wait loop,
// not the "already running" exit 0 of ensureSingleUnixDaemon: it does not wait
// out the 10 s, and the control socket is still never left to a childless
// adapter.
test('twin: an adapter that refuses the control socket is fallen back from, promptly', async () => {
  const home = await shortHome()
  // Built, and the fake codex run once, before the clock starts.
  const env = shimEnv(home, {
    CODEX_HOME: home,
    ANYENGINE_ADAPTER: adapter,
    ANYENGINE_MOCK: '1',
    ANYENGINE_REMOTE_NATIVE_CODEX: '1',
    // The exec route means no codex child, whatever the twin asked for.
    ANYENGINE_GPT_ROUTE: 'exec',
    ANYENGINE_REAL_CODEX: await fakeCodex(home, 'bundled'),
  })
  const started = Date.now()
  const stderr: string[] = []
  const proc = spawn(shim, ['app-server', '--listen', 'unix://'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env,
  })
  proc.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
  try {
    const recorded = JSON.parse(await waitForFile(join(home, 'fake-argv.json')))
    // The shim gives up on the socket after 10 s: under 8 s still proves the
    // refusal was noticed, not waited out, with room for a loaded machine.
    assert.ok(Date.now() - started < 8000, 'the refusal is noticed, not waited out')
    assert.equal(recorded.tag, 'bundled')
    assert.match(stderr.join(''), /refusing the app-server control socket/)
    const marker = JSON.parse(
      await readFile(join(home, '.anyengine', 'shim-fallback.json'), 'utf8'),
    )
    assert.match(marker.reason, /did not create/)
    // Refused before any pidfile: a live daemon's would have been left alone.
    assert.ok(!existsSync(`${controlSocket(home)}.pid`))
  } finally {
    proc.kill('SIGKILL')
    await stopDaemon(home)
    await rm(home, { recursive: true, force: true })
  }
})

test('twin: with no codex to hand the control socket to, the shim exits clean and marks it', async () => {
  const home = await shortHome()
  try {
    const result = spawnSync(shim, ['app-server', '--listen', 'unix://'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: shimEnv(home, {
        CODEX_HOME: home,
        ANYENGINE_ADAPTER: adapter,
        ANYENGINE_MOCK: '1',
        ANYENGINE_REAL_CODEX: join(home, 'no-such-codex'),
      }),
    })
    assert.equal(result.status, 0, 'the App SSH bootstrap must still see a clean exit')
    assert.match(result.stderr, /refusing the app-server control socket/)
    const marker = JSON.parse(
      await readFile(join(home, '.anyengine', 'shim-fallback.json'), 'utf8'),
    )
    assert.equal(marker.kind, 'none')
    assert.ok(!existsSync(controlSocket(home)))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
