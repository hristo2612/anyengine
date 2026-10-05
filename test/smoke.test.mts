import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { DEFAULT_CONFIG, enginePaths } from '../src/anyengine-config.mjs'
import { digest } from '../src/control-layer-state.mjs'
import { realSystem } from '../src/control-system.mjs'
import { inspectDegraded, settingsHash } from '../src/degraded.mjs'
import { runSmoke, type SmokeDeps, type SmokePathName } from '../src/smoke.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

async function fixture() {
  const root = await tempDir('smoke-run-')
  const system = fakeSystem(root)
  system.procs = [
    {
      pid: process.pid,
      ppid: 1,
      command: 'controlled owner',
      processStart: '2026-09-30T00:00:00.000Z',
    },
  ]
  const lib = join(root, 'lib/fixture')
  mkdirSync(lib, { recursive: true })
  const bytes = Buffer.from('{"fixture":"controlled admission; no installed acceptance"}')
  writeFileSync(join(lib, 'install-manifest.json'), bytes)
  const config = structuredClone(DEFAULT_CONFIG)
  const snapshot = {
    root,
    libDir: lib,
    codeIdentity: digest(bytes),
    key: {
      lib: 'fixture',
      appVersion: '26.928.20755',
      codexVersion: '0.159.0',
      settings: settingsHash(config),
    },
    config,
    mode: config.modes.codexClaude,
    bundled: join(root, 'fake-codex'),
    nativeProof: null,
    degraded: [],
  }
  let launches = 0
  const deps: SmokeDeps = {
    adapter: join(lib, 'dist/src/adapter.mjs'),
    executingLib: lib,
    adapterEnv: (extra) => ({ ...extra }),
    codexHome: join(root, 'codex'),
    claudeHome: root,
    project: join(root, 'smoke/claude-project'),
    runDir: join(root, 'smoke/run-20261001T000000Z'),
    verifyLib: () => [],
    currentSnapshot: () => structuredClone(snapshot),
    runners: {
      gpt: async () => {
        launches++
        return { ok: true, ms: 1, detail: 'controlled successful terminal' }
      },
    },
  }
  return { root, system, deps, snapshot, launches: () => launches }
}
test('smoke refuses absent trusted admission before artifacts or runners', async () => {
  const { root, system, deps, launches } = await fixture()
  await assert.rejects(
    runSmoke(system, root, { ...deps, verifyLib: undefined } as unknown as SmokeDeps, {
      paths: ['gpt'],
      notify: true,
    }),
    /admission/,
  )
  assert.equal(existsSync(join(root, 'smoke')), false)
  assert.equal(launches(), 0)
})
test('smoke refuses source/previous-library code and invalid versions before launch', async () => {
  const { root, system, deps, snapshot, launches } = await fixture()
  await assert.rejects(
    runSmoke(
      system,
      root,
      { ...deps, executingLib: join(root, 'old') },
      { paths: ['gpt'], notify: false },
    ),
    /executing|selected/,
  )
  snapshot.key.codexVersion = 'unknown'
  await assert.rejects(
    runSmoke(system, root, deps, { paths: ['gpt'], notify: false }),
    /identity|version/,
  )
  assert.equal(existsSync(join(root, 'smoke')), false)
  assert.equal(launches(), 0)
})
test('smoke --out writes only its private result and removes its settled run', async () => {
  const { root, system, deps } = await fixture()
  const out = join(root, 'private-result.json')
  const result = await runSmoke(system, root, deps, { paths: ['gpt'], notify: true, out })
  assert.equal(result.paths.gpt?.ok, true)
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).key.lib, 'fixture')
  assert.equal(existsSync(enginePaths(root).smokeResult), false)
  assert.equal(existsSync(join(root, 'state/proven.json')), false)
  assert.equal(existsSync(join(root, 'state/degraded.json')), false)
  assert.equal(existsSync(deps.runDir), false)
  assert.equal(existsSync(deps.project), true)
  assert.equal(system.notifications.length, 0)
})
test('smoke rejects frozen drift after work and retains invalid existing result bytes', async () => {
  const { root, system, deps, snapshot } = await fixture()
  deps.runners!.gpt = async () => {
    snapshot.mode = 'model'
    return { ok: true, ms: 1, detail: 'drift' }
  }
  await assert.rejects(runSmoke(system, root, deps, { paths: ['gpt'], notify: false }), /drift/)
  assert.equal(existsSync(enginePaths(root).smokeResult), false)
  snapshot.mode = snapshot.config.modes.codexClaude
  mkdirSync(join(root, 'state'), { recursive: true })
  const bytes = Buffer.from('{"at":"\xff"}', 'latin1')
  writeFileSync(enginePaths(root).smokeResult, bytes)
  await assert.rejects(runSmoke(system, root, deps, { paths: ['gpt'], notify: false }), /invalid/)
  assert.deepEqual(readFileSync(enginePaths(root).smokeResult), bytes)
})

test('smoke output refuses a path occupied during the run without replacing its bytes', async () => {
  const { root, system, deps } = await fixture()
  const out = join(root, 'occupied.json')
  deps.runners!.gpt = async () => {
    writeFileSync(out, 'retain')
    return { ok: true, ms: 1, detail: 'controlled' }
  }
  await assert.rejects(
    runSmoke(system, root, deps, { paths: ['gpt'], notify: false, out }),
    /EEXIST/,
  )
  assert.equal(readFileSync(out, 'utf8'), 'retain')
})

test('Claude Code smoke failure marks only its path and notifies once until a recovery pass', async () => {
  const { root, system, deps } = await fixture()
  const path = 'claude-code-gpt' as SmokePathName
  deps.runners = { [path]: async () => ({ ok: false, ms: 1, detail: 'controlled GPT failure' }) }
  await runSmoke(system, root, deps, { paths: [path], notify: true })
  assert.deepEqual(Object.keys(inspectDegraded(root)!.paths), [path])
  assert.equal(system.notifications.length, 1)
  await runSmoke(system, root, deps, { paths: [path], notify: true })
  assert.equal(system.notifications.length, 1)
  deps.runners = { [path]: async () => ({ ok: true, ms: 1, detail: 'controlled GPT recovery' }) }
  await runSmoke(system, root, deps, { paths: [path], notify: true })
  assert.deepEqual(inspectDegraded(root)?.paths, {})
  deps.runners = { [path]: async () => ({ ok: false, ms: 1, detail: 'controlled later failure' }) }
  await runSmoke(system, root, deps, { paths: [path], notify: true })
  assert.equal(system.notifications.length, 2)
})

test('disabled smoke never dispatches the Claude Code path even through an injected runner', async () => {
  const { root, system, deps, snapshot } = await fixture()
  snapshot.config.smoke.enabled = false
  snapshot.key.settings = settingsHash(snapshot.config)
  const path = 'claude-code-gpt' as SmokePathName
  let launches = 0
  deps.runners = {
    [path]: async () => {
      launches++
      return { ok: true, ms: 1, detail: 'unexpected work' }
    },
  }
  const result = await runSmoke(system, root, deps, { paths: [path], notify: true })
  assert.equal(result.paths[path]?.ok, null)
  assert.equal(launches, 0)
  assert.equal(system.notifications.length, 0)
})
// Actual compiled adapter/client/process cleanup, controlled bundled process only.
// Admission capability and manifest here are synthetic, not installed acceptance.
for (const path of ['gpt', 'claude-agent'] as const)
  test(`smoke actual adapter ${path} settles owned work and rejects mock PTY evidence`, async () => {
    const { root, system, deps, snapshot } = await fixture()
    const actual = realSystem({ ...process.env, ANYENGINE_PS: '/bin/ps' })
    system.processes = actual.processes
    system.exec = actual.exec
    system.now = () => new Date()
    snapshot.bundled = resolve('test/fixtures/fake-codex-app-server.mjs')
    snapshot.config.router.enabled = false
    deps.runners = {}
    mkdirSync(join(deps.executingLib, 'dist/src'), { recursive: true })
    const startup = join(root, 'startup.stderr')
    writeFileSync(
      deps.adapter,
      `import { appendFileSync } from 'node:fs'
const write = process.stderr.write.bind(process.stderr)
let remaining = 16_384
process.stderr.write = (...args) => {
  const bytes = Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(String(args[0]))
  if (remaining > 0) {
    const bounded = bytes.subarray(0, remaining)
    appendFileSync(${JSON.stringify(startup)}, bounded, { mode: 0o600 })
    remaining -= bounded.length
  }
  return write(...args)
}
try {
  await import(${JSON.stringify(pathToFileURL(resolve('dist/src/adapter.mjs')).href)})
} catch (error) {
  process.stderr.write(String(error?.stack ?? error))
  throw error
}
`,
    )
    const requests = join(root, 'requests.jsonl')
    deps.adapterEnv = (extra) => ({
      ...process.env,
      ...extra,
      ANYENGINE_MOCK: '1',
      ANYENGINE_NATIVE_CODEX: '1',
      FAKE_CODEX_NO_APPROVAL: '1',
      FAKE_CODEX_REPLY: 'PONG',
      FAKE_CODEX_REQUESTS_FILE: requests,
    })
    const out = join(root, 'result.json')
    let result: Awaited<ReturnType<typeof runSmoke>>
    try {
      result = await runSmoke(system, root, deps, { paths: [path], notify: false, out })
    } catch (cause) {
      const stderr = existsSync(startup) ? readFileSync(startup, 'utf8') : '(no startup stderr)'
      throw new Error(`owned fake adapter startup: ${stderr}`, { cause })
    }
    if (path === 'claude-agent') {
      assert.equal(result.paths[path]?.ok, false)
      assert.equal(existsSync(deps.runDir), false)
    } else {
      assert.equal(result.paths.gpt?.ok, true, JSON.stringify(result.paths))
      const lines = readFileSync(requests, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.ok(lines.some((line) => line.method === 'thread/unsubscribe'))
      assert.equal(existsSync(deps.runDir), false)
    }
    assert.equal(
      system.processes().some((p) => p.command.includes(deps.adapter)),
      false,
    )
  })
