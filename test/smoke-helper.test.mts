import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { DEFAULT_CONFIG, writeJsonAtomic } from '../src/anyengine-config.mjs'
import { realSystem } from '../src/control-system.mjs'
import { settingsHash } from '../src/degraded.mjs'
import type { PathContext } from '../src/smoke.mjs'
import { runRestrictedProbe } from '../src/smoke-claude.mjs'
import { joinDetachedGroup } from '../src/smoke-client.mjs'
import { createSmokeRun } from '../src/smoke-probes.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(killChildren)
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

for (const fault of ['reported', 'unknown-stage', 'extra-field', 'wrong-attempt']) {
  test(`restricted helper failure ${fault} is terminal and never echoes arbitrary diagnostics`, async () => {
    const { ctx, phases } = await fixture('fast')
    const message = {
      attempt: fault === 'wrong-attempt' ? 'other-attempt' : ctx.request.attempt,
      phase: 'failure',
      stage: fault === 'unknown-stage' ? 'fixture-private-value' : 'oauth-before',
      ...(fault === 'extra-field' ? { error: 'fixture-private-value' } : {}),
    }
    writeFileSync(
      join(ctx.root, 'lib/controlled/dist/src/smoke-claude.mjs'),
      `process.send({ attempt: process.argv[2], phase: 'before' })
process.once('message', () => process.send(${JSON.stringify(message)}, () => process.disconnect()))
`,
    )
    const expected =
      fault === 'reported'
        ? 'restricted helper failed at oauth-before'
        : 'invalid restricted helper failure'
    await assert.rejects(runRestrictedProbe(ctx, 5000), (error: Error) => {
      assert.equal(error.message, expected)
      assert.ok(!error.message.includes('fixture-private-value'))
      return true
    })
    assert.deepEqual(phases, ['before'])
    assert.equal(ctx.uncertain, true)
    assert.equal(ctx.sessions.size, 0)
  })
}

test('a failure after a valid result and acknowledgment cannot certify success', async () => {
  const { ctx, phases } = await fixture('fast')
  const script = join(ctx.root, 'lib/controlled/dist/src/smoke-claude.mjs')
  const original = readFileSync(script, 'utf8')
  assert.ok(original.includes('    process.disconnect()'))
  writeFileSync(
    script,
    original.replace(
      '    process.disconnect()',
      `    process.send({ attempt, phase: 'failure', stage: 'after-ack' }, () => process.disconnect())`,
    ),
  )
  await assert.rejects(runRestrictedProbe(ctx, 5000), {
    message: 'restricted helper failed at after-ack',
  })
  assert.deepEqual(phases, ['before', 'after'])
  assert.equal(ctx.uncertain, true)
  assert.equal(ctx.sessions.size, 0)
})

for (const stage of ['before-ack', 'oauth-before', 'oauth-after'] as const) {
  test(`actual helper reports only fixed ${stage} stage and exits unsuccessfully`, async () => {
    const root = await tempDir('smoke-failure-')
    const auth = join(root, 'auth')
    const project = join(root, 'project')
    mkdirSync(auth)
    mkdirSync(project)
    const cli = join(root, 'controlled-claude')
    const calls = join(root, 'calls.jsonl')
    writeFileSync(
      cli,
      `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
if (args.includes('--version')) console.log('2.1.301 (Claude Code)')
else if (args[0] === 'auth') {
 const count = readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').map(JSON.parse).filter(a => a[0] === 'auth').length
 const loggedIn = ${JSON.stringify(stage)} === 'oauth-after' && count === 1
 console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', configDirectory: process.env.CLAUDE_CONFIG_DIR, privateValue: 'fixture-private-value' }))
 console.error('fixture-private-stderr')
 process.exitCode = loggedIn ? 0 : 1
} else if (args.includes('--help')) console.log('--print --tools --restricted --disable-slash-commands --permission-prompts --effort --include-partial-messages')
else {
 process.stdin.resume()
 process.stdin.on('end', () => {
  for (const event of [
   { type: 'system', subtype: 'init', session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
   { type: 'assistant', message: { content: [{ type: 'text', text: 'PONG' }] } },
   { type: 'result', subtype: 'success', is_error: false, result: 'PONG', session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  ]) console.log(JSON.stringify(event))
 })
}
`,
    )
    chmodSync(cli, 0o700)
    const config = structuredClone(DEFAULT_CONFIG)
    config.claude.cli = cli
    writeJsonAtomic(join(root, 'config.json'), config)
    const child = spawn(
      process.execPath,
      [new URL('../src/smoke-claude.mjs', import.meta.url).pathname, 'attempt', root, project],
      {
        env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: auth },
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    )
    const pid = child.pid
    assert.ok(pid)
    assert.ok(child.stderr)
    const messages: unknown[] = []
    let stderr = ''
    child.stderr.on('data', (bytes) => {
      stderr += String(bytes)
    })
    child.on('message', (message: any) => {
      messages.push(message)
      if (message.phase === 'before')
        child.send({ attempt: 'attempt', phase: 'before', ok: stage !== 'before-ack' })
    })
    const closed = once(child, 'close')
    const timeout = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
    }, 15_000)
    try {
      const [code, signal] = await closed
      assert.equal(signal, null)
      assert.equal(code, 1)
      assert.deepEqual(messages, [
        { attempt: 'attempt', phase: 'before' },
        { attempt: 'attempt', phase: 'failure', stage },
      ])
      assert.equal(stderr, '')
      assert.ok(!JSON.stringify(messages).includes('fixture-private'))
      if (stage === 'before-ack') assert.equal(existsSync(calls), false)
      else {
        const rows = readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        assert.equal(
          rows.filter((args) => args[0] === 'auth').length,
          stage === 'oauth-after' ? 2 : 1,
        )
      }
    } finally {
      clearTimeout(timeout)
      await joinDetachedGroup(pid, true)
    }
  })
}
