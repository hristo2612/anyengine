import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { DEFAULT_CONFIG } from '../src/anyengine-config.mjs'
import { realSystem } from '../src/control-system.mjs'
import { settingsHash } from '../src/degraded.mjs'
import type { PathContext } from '../src/smoke.mjs'
import { runRestrictedProbe } from '../src/smoke-claude.mjs'
import { createSmokeRun } from '../src/smoke-probes.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
async function fixture(mode: string) {
  const root = await tempDir('smoke-ipc-')
  const config = structuredClone(DEFAULT_CONFIG)
  const system = fakeSystem(root)
  system.now = () => new Date()
  system.processes = realSystem({ ...process.env, ANYENGINE_PS: '/bin/ps' }).processes
  const lib = join(root, 'lib/controlled')
  mkdirSync(join(lib, 'dist/src'), { recursive: true })
  copyFileSync(resolve('test/fixtures/smoke-helper.mjs'), join(lib, 'dist/src/smoke-claude.mjs'))
  const runDir = join(root, 'smoke/run-20261001T000000Z')
  const frozen = {
    key: {
      lib: 'controlled',
      appVersion: '26.928.20755',
      codexVersion: '0.159.0',
      settings: settingsHash(config),
    },
    mode: config.modes.codexClaude,
    codeIdentity: 'a'.repeat(64),
  }
  const phases: string[] = []
  const ctx: PathContext = {
    root,
    config,
    system,
    deps: {
      adapter: '',
      executingLib: lib,
      adapterEnv: (extra) => ({ ...process.env, ...extra, FAKE_SMOKE_HELPER_MODE: mode }),
      codexHome: root,
      claudeHome: root,
      project: join(root, 'smoke/claude-project'),
      runDir,
      verifyLib: () => [],
      currentSnapshot: () => ctx.snapshot,
    },
    snapshot: {
      ...frozen,
      root,
      libDir: lib,
      config,
      bundled: '/controlled/codex',
      nativeProof: null,
      degraded: [],
    },
    request: {
      ...frozen,
      attempt: 'controlled-attempt',
      root,
      since: system.now().toISOString(),
      startedAt: system.now().toISOString(),
      models: { claude: 'haiku', gpt: null },
      expect: 'router',
      adapters: [],
    },
    verify: () => frozen,
    run: createSmokeRun(system, root, runDir, 'controlled-attempt'),
    sessions: new Set(),
    cohort: [],
    uncertain: false,
    sequence: 0,
    observe: (phase, input) => {
      phases.push(phase)
      const actual = system.processes().find((p) => p.pid === input.pid)
      if (phase === 'closed') assert.equal(actual, undefined)
      else {
        assert.equal(actual?.ppid, process.pid)
        assert.ok(actual?.command.includes(join(lib, 'dist/src/smoke-claude.mjs')))
      }
      return {
        ...input,
        id: 'controlled-observation',
        ppid: process.pid,
        processStart: actual?.processStart ?? '2026-10-01T00:00:00.000Z',
        command: actual?.command ?? '',
        settings: frozen.key.settings,
      }
    },
  }
  return { ctx, phases }
}
test('restricted helper waits for independent before/after acknowledgments and joined exit', async () => {
  const { ctx, phases } = await fixture('fast')
  const result = await runRestrictedProbe(ctx, 5000)
  assert.deepEqual(phases, ['before', 'after', 'closed'])
  assert.equal(result.role, 'trampoline')
  assert.equal(result.threadId, undefined)
  assert.equal(ctx.uncertain, false)
  assert.equal(ctx.sessions.size, 1)
})
for (const mode of ['wrong-attempt', 'replay', 'oversized', 'disconnect', 'exit']) {
  test(`restricted helper rejects ${mode} and retains cleanup uncertainty`, async () => {
    const { ctx, phases } = await fixture(mode)
    await assert.rejects(runRestrictedProbe(ctx, 5000), /phase|failed|disconnect|acknowledg/)
    assert.equal(ctx.uncertain, true)
    assert.ok(!phases.includes('closed'))
  })
}
test('restricted timeout joins a resistant descendant and cannot certify success', async () => {
  const { ctx } = await fixture('timeout')
  await assert.rejects(runRestrictedProbe(ctx, 500), /timeout|join/)
  const { pid } = JSON.parse(readFileSync(join(ctx.deps.runDir, 'restricted/family.json'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.equal(ctx.uncertain, true)
})
