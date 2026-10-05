import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DEFAULT_CONFIG } from '../src/anyengine-config.mjs'
import { digest } from '../src/control-layer-state.mjs'
import { realSystem } from '../src/control-system.mjs'
import { settingsHash } from '../src/degraded.mjs'
import { runSmoke, type SmokeDeps } from '../src/smoke.mjs'
import { joinDetachedGroup } from '../src/smoke-client.mjs'
import { createSmokeRun, sweepSmokeRuns, withAdapter } from '../src/smoke-probes.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

async function fixture() {
  const root = await tempDir('smoke-owner-')
  const system = fakeSystem(root)
  system.procs = [
    {
      pid: process.pid,
      ppid: 1,
      command: 'controlled owner',
      processStart: '2026-09-30T00:00:00.000Z',
    },
  ]
  const runDir = join(root, 'smoke/run-20260930T000000Z')
  const run = createSmokeRun(system, root, runDir, 'attempt')
  utimesSync(runDir, new Date(0), new Date(0))
  return { root, system, runDir, run }
}
test('smoke crash cleanup removes only settled exact old runs with complete absent cohort', async () => {
  const { root, system, runDir, run } = await fixture()
  run.pending([{ pid: 918201, processStart: '2026-09-30T01:00:00.000Z' }])
  assert.equal(JSON.parse(readFileSync(join(runDir, 'owner.json'), 'utf8')).pending, true)
  run.joined()
  system.procs = []
  utimesSync(runDir, new Date(0), new Date(0))
  assert.deepEqual(sweepSmokeRuns(system, root).removed, [runDir])
  assert.equal(existsSync(runDir), false)
})
test('smoke crash cleanup retains launch uncertainty after parent death and unknown descendants', async () => {
  const { root, system, runDir, run } = await fixture()
  run.pending([]) // durable before spawn; a crash may occur before PID publication
  system.procs = []
  utimesSync(runDir, new Date(0), new Date(0))
  assert.deepEqual(sweepSmokeRuns(system, root).removed, [])
  assert.equal(existsSync(runDir), true)
})
test('smoke crash cleanup retains a reparented grandchild, live owner and reused identities', async () => {
  const { root, system, runDir, run } = await fixture()
  const child = { pid: 918202, processStart: '2026-09-30T01:00:00.000Z' }
  run.pending([child])
  run.joined()
  utimesSync(runDir, new Date(0), new Date(0))
  for (const procs of [
    system.procs,
    [{ ...child, ppid: 1, command: 'orphan' }],
    [{ ...child, processStart: '2026-09-30T02:00:00.000Z', ppid: 1, command: 'reused' }],
  ]) {
    system.procs = procs
    assert.deepEqual(sweepSmokeRuns(system, root).removed, [])
  }
  system.processError = new Error('unknown process state')
  assert.deepEqual(sweepSmokeRuns(system, root).removed, [])
  assert.equal(existsSync(runDir), true)
})
test('smoke run records refuse occupied/symlink paths and retain malformed fatal bytes', async () => {
  const { root, system, runDir, run } = await fixture()
  assert.throws(() => createSmokeRun(system, root, runDir, 'new-attempt'), /exist|occupied/)
  const file = join(runDir, 'owner.json')
  writeFileSync(file, Buffer.from('{"attempt":"\xff"}', 'latin1'))
  system.procs = []
  utimesSync(runDir, new Date(0), new Date(0))
  assert.deepEqual(sweepSmokeRuns(system, root).removed, [])
  assert.throws(() => run.joined(), /record|owner|UTF|encoded/)
  const foreign = join(root, 'foreign')
  mkdirSync(foreign)
  symlinkSync(foreign, join(root, 'smoke/run-20260929T000000Z'))
  assert.deepEqual(sweepSmokeRuns(system, root).removed, [])
  assert.equal(existsSync(foreign), true)
})

// The real cleanup owner and child lifetime run here; admission/model work is synthetic.
for (const timing of [
  'unsubscribe',
  'shutdown',
  'unowned',
  'malformed',
  'missing',
  'truncated',
  'invalid-session',
  'late-child',
  'late-notified-child',
] as const)
  test(`final session cleanup after owned shutdown: ${timing}`, async () => {
    assert.ok(process.env.HERMETIC_TEST_ROOT)
    const root = await tempDir('smoke-late-session-')
    const lib = join(root, 'lib/fixture')
    const project = join(root, 'smoke/claude-project')
    const runDir = join(root, 'smoke/run-20261003T170000Z')
    const sessionId = '11111111-2222-4333-8444-555555555555'
    const folder = join(
      process.env.CLAUDE_CONFIG_DIR!,
      'projects',
      project.replace(/[^a-zA-Z0-9]/g, '-'),
    )
    const leaf = join(folder, `${sessionId}.jsonl`)
    const childState = join(root, 'controlled-persisted-child.json')
    const unrelatedState = join(root, 'unrelated-persisted-child.json')
    const requests = join(root, 'requests.jsonl')
    writeFileSync(unrelatedState, 'unrelated persisted state stays intact\n')
    const unrelated = join(folder, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')
    mkdirSync(join(lib, 'dist/src'), { recursive: true })
    mkdirSync(folder, { recursive: true })
    writeFileSync(unrelated, 'unrelated session stays intact\n')
    const manifest = Buffer.from(
      '{"fixture":"controlled late-session cleanup, no installed acceptance"}',
    )
    writeFileSync(join(lib, 'install-manifest.json'), manifest)
    const adapter = join(lib, 'dist/src/adapter.mjs')
    writeFileSync(
      adapter,
      `
import { createInterface } from 'node:readline'
import { appendFileSync, unlinkSync, writeFileSync } from 'node:fs'
const input = createInterface({ input: process.stdin })
const timing = ${JSON.stringify(timing)}
const log = event => appendFileSync(process.env.ANYENGINE_DEBUG_LOG, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...event }) + '\\n')
log({ event: 'adapter.start' })
let emitted = false
function emit() {
  if (emitted) return
  emitted = true
  writeFileSync(${JSON.stringify(leaf)}, 'controlled exact session leaf\\n')
  if (timing === 'late-notified-child') {
    writeFileSync(${JSON.stringify(childState)}, '{"id":"late-child"}')
    log({ event: 'bridge.spawnSubagent', parentThreadId: 'owned-thread', parentTurnId: 'parent-turn', childThreadId: 'late-child', model: 'gpt-5.4', name: null })
    process.stdout.write(JSON.stringify({ method: 'item/completed', params: { threadId: 'owned-thread', turnId: 'parent-turn', item: { type: 'collabAgentToolCall', id: 'spawn-child', tool: 'spawnAgent', status: 'completed', senderThreadId: 'owned-thread', receiverThreadIds: ['late-child'], prompt: 'PONG', model: 'gpt-5.4', reasoningEffort: null, agentsStates: { 'late-child': { status: 'running', message: null } } } } }) + '\\n')
  }
  if (timing === 'late-child') log({ event: 'bridge.spawnSubagent', parentThreadId: 'owned-thread', childThreadId: 'late-child' })
  log({ event: 'anyengine.session', threadId: timing === 'unowned' ? 'foreign-thread' : timing === 'late-child' ? 'late-child' : 'owned-thread', sessionId: timing === 'invalid-session' ? null : ${JSON.stringify(sessionId)} })
  if (timing === 'malformed') appendFileSync(process.env.ANYENGINE_DEBUG_LOG, '{incomplete')
  if (timing === 'missing') unlinkSync(process.env.ANYENGINE_DEBUG_LOG)
  if (timing === 'truncated') writeFileSync(process.env.ANYENGINE_DEBUG_LOG, '')
}
input.on('line', line => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ method: m.method, params: m.params }) + '\\n')
  let result = {}
  if (m.method === 'thread/unsubscribe') {
    if (m.params.threadId !== 'owned-thread') throw new Error('unexpected owned thread')
    if (timing !== 'shutdown') emit()
    result = { status: 'unsubscribed' }
  }
  process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n')
})
const stop = () => { if (timing === 'shutdown') emit(); process.exit(0) }
input.on('close', stop)
process.on('SIGTERM', stop)
`,
    )
    const config = structuredClone(DEFAULT_CONFIG)
    const snapshot = {
      root,
      libDir: lib,
      codeIdentity: digest(manifest),
      key: {
        lib: 'fixture',
        appVersion: '26.928.20755',
        codexVersion: '0.159.0',
        settings: settingsHash(config),
      },
      config,
      mode: config.modes.codexClaude,
      bundled: adapter,
      nativeProof: null,
      degraded: [],
    }
    const system = realSystem({ ...process.env, ANYENGINE_PS: '/bin/ps' })
    let childPid: number | undefined
    const deps: SmokeDeps = {
      adapter,
      executingLib: lib,
      codexHome: join(root, 'codex'),
      claudeHome: process.env.HOME!,
      project,
      runDir,
      adapterEnv: (extra) => ({ ...process.env, ...extra }),
      verifyLib: () => [],
      currentSnapshot: () => structuredClone(snapshot),
      runners: {
        'claude-agent': async (ctx) => {
          ctx.observe = (_phase, value) => ({
            id: 'controlled-probe',
            ppid: process.pid,
            processStart: '2026-10-03T17:00:00.000Z',
            command: 'controlled admission',
            settings: settingsHash(config),
            ...value,
          })
          return withAdapter(ctx, 'agent', 'agent', async (probe) => {
            childPid = probe.client.pid
            probe.threads.set('owned-thread', 'local')
            return {
              ok: false,
              ms: 0,
              detail: 'controlled failed work still requires exact cleanup',
            }
          })
        },
      },
    }
    const out = join(root, 'result.json')
    try {
      const run = runSmoke(system, root, deps, { paths: ['claude-agent'], notify: false, out })
      if (timing === 'unsubscribe' || timing === 'shutdown') {
        const result = await run
        assert.equal(result.paths['claude-agent']?.ok, false)
        assert.deepEqual(result.cleanup?.sessionsRemoved, [sessionId])
        assert.equal(existsSync(leaf), false)
        assert.equal(existsSync(runDir), false)
      } else {
        await assert.rejects(run, /cleanup uncertain/)
        assert.equal(existsSync(leaf), true)
        assert.equal(existsSync(runDir), true)
        assert.equal(JSON.parse(readFileSync(join(runDir, 'owner.json'), 'utf8')).pending, true)
        assert.equal(existsSync(out), false)
      }
      assert.equal(readFileSync(unrelated, 'utf8'), 'unrelated session stays intact\n')
      assert.equal(readFileSync(unrelatedState, 'utf8'), 'unrelated persisted state stays intact\n')
      if (timing === 'late-notified-child') {
        assert.equal(readFileSync(childState, 'utf8'), '{"id":"late-child"}')
        const calls = readFileSync(requests, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        assert.equal(
          calls.some((call) => call.params?.threadId === 'late-child'),
          false,
        )
      }
      assert.ok(childPid)
      assert.throws(() => process.kill(childPid!, 0), { code: 'ESRCH' })
    } finally {
      if (childPid) await joinDetachedGroup(childPid, true)
      rmSync(folder, { recursive: true, force: true })
    }
  })
