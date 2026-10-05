import assert from 'node:assert/strict'
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { DEFAULT_CONFIG } from '../src/anyengine-config.mjs'
import { settingsHash } from '../src/degraded.mjs'
import {
  createProbeObserver,
  type GateRequest,
  gateResult,
  validateNativeReceipt,
} from '../src/smoke-evidence.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
async function fixture() {
  const root = await tempDir('ae-sm-ob-')
  const system = fakeSystem(root)
  const config = structuredClone(DEFAULT_CONFIG)
  const key = {
    lib: 'fixture',
    appVersion: '26.1.1',
    codexVersion: '0.159.0',
    settings: settingsHash(config),
  }
  const request: GateRequest = {
    key,
    codeIdentity: 'a'.repeat(64),
    mode: 'agent',
    attempt: 'fixture-attempt',
    root,
    since: system.now().toISOString(),
    startedAt: system.now().toISOString(),
    models: { claude: 'haiku', gpt: 'gpt-fixture' },
    expect: 'router',
    adapters: [],
  }
  const lib = join(root, 'lib/fixture')
  const run = join(root, 'smoke/run-20261001T000000Z')
  const privateRoot = join(run, 'agent')
  mkdirSync(lib, { recursive: true })
  mkdirSync(join(privateRoot, 'lib'), { recursive: true })
  writeFileSync(join(privateRoot, 'config.json'), JSON.stringify(config))
  symlinkSync(lib, join(privateRoot, 'lib/current'))
  const owner = {
    pid: process.pid,
    ppid: 1,
    processStart: '2026-01-01T00:00:00.000Z',
    command: `node ${lib}/dist/src/adapter.mjs on`,
  }
  const adapter = {
    pid: 990001,
    ppid: process.pid,
    processStart: system.now().toISOString(),
    command: `node ${lib}/dist/src/adapter.mjs app-server`,
  }
  system.procs = [owner, adapter]
  writeFileSync(
    join(run, 'owner.json'),
    JSON.stringify({ attempt: request.attempt, pid: owner.pid, processStart: owner.processStart }),
  )
  const state = createProbeObserver(system, request, config, () => ({
    codeIdentity: request.codeIdentity,
    key,
    mode: 'agent',
  }))
  const input = {
    pid: adapter.pid,
    role: 'adapter' as const,
    root: privateRoot,
    mode: 'agent' as const,
  }
  return { root, system, config, request, state, input, adapter, owner }
}
test('probe IDs come from independent before/after observation and require joined cleanup', async () => {
  const f = await fixture()
  const before = f.state.observe('before', f.input)
  assert.notEqual(before.id, '')
  const again = { ...f.input, id: before.id }
  f.state.observe('after', again)
  assert.throws(() => f.state.observe('closed', again), /alive|cleanup/)
  f.system.procs = [f.owner]
  f.state.observe('closed', again)
  assert.equal(f.state.observations.get(before.id)?.closed, true)
})
for (const drift of ['pid', 'parent', 'start', 'code', 'config', 'mode', 'current', 'owner'])
  test(`probe observer rejects ${drift} drift without admitting a result-declared identity`, async () => {
    const f = await fixture()
    const before = f.state.observe('before', f.input)
    const input = { ...f.input, id: before.id }
    if (drift === 'pid') input.pid += 1
    if (drift === 'parent') f.adapter.ppid = 987654
    if (drift === 'start') f.adapter.processStart = '2020-01-01T00:00:00Z'
    if (drift === 'code') f.adapter.command = f.adapter.command.replace('/fixture/', '/foreign/')
    if (drift === 'config')
      writeFileSync(
        join(f.input.root, 'config.json'),
        JSON.stringify({ ...f.config, claims: { ...f.config.claims, graceMs: 1 } }),
      )
    if (drift === 'mode')
      writeFileSync(
        join(f.input.root, 'config.json'),
        JSON.stringify({ ...f.config, modes: { codexClaude: 'model' } }),
      )
    if (drift === 'current') f.request.key.lib = 'changed'
    if (drift === 'owner')
      writeFileSync(
        join(f.input.root, '../owner.json'),
        JSON.stringify({
          attempt: 'foreign',
          pid: process.pid,
          processStart: f.owner.processStart,
        }),
      )
    assert.throws(() => f.state.observe('after', input))
  })
test('a forged observation map cannot certify even a nominally successful result', async () => {
  const f = await fixture()
  assert.throws(
    () => gateResult({ ...f.request, ok: true, turns: [] }, f.request, f.system.now(), new Map()),
    /observ/,
  )
})
test('a source or earlier-library process cannot impersonate the installed trampoline owner', async () => {
  const f = await fixture()
  f.owner.command = 'node /checkout/dist/src/adapter.mjs on'
  assert.throws(
    () => f.state.observe('before', { ...f.input, role: 'trampoline', pid: process.pid }),
    /installed|identity/,
  )
})

async function successfulFixture() {
  const f = await fixture()
  const adapter = f.state.observe('before', f.input)
  f.state.observe('after', { ...f.input, id: adapter.id })
  f.system.procs = [f.owner]
  f.state.observe('closed', { ...f.input, id: adapter.id })
  const own = { ...f.input, pid: process.pid, role: 'trampoline' as const }
  const trampoline = f.state.observe('before', own)
  f.state.observe('after', { ...own, id: trampoline.id })
  f.state.observe('closed', { ...own, id: trampoline.id })
  const base = {
    processPid: adapter.pid,
    probeId: adapter.id,
    role: 'adapter' as const,
    processStart: adapter.processStart,
    effectiveMode: adapter.mode,
    effectiveSettings: adapter.settings,
    completedAt: f.request.startedAt,
    status: 'completed',
    success: true,
    operatorConfig: true,
  }
  const parent = {
    threadId: 'bridge-parent',
    turnId: 'parent-turn',
    model: 'haiku',
    status: 'completed',
    success: true,
  }
  const child = {
    threadId: 'bridge-child',
    turnId: 'child-turn',
    model: 'gpt-fixture',
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
  const turns: import('../src/smoke-evidence.mjs').GateTurn[] = [
    { ...base, path: 'claude-pty', threadId: 'pty', turnId: 'pty-turn', model: 'haiku' },
    {
      ...base,
      path: 'gpt',
      threadId: 'gpt',
      turnId: 'gpt-turn',
      model: 'gpt-fixture',
      transport: 'router',
    },
    {
      ...base,
      ...parent,
      path: 'bridge',
      parent,
      child,
      bridge: { ...child, parentThreadId: parent.threadId, parentTurnId: parent.turnId },
    },
    {
      ...base,
      path: 'restricted-oauth',
      role: 'trampoline',
      processPid: trampoline.pid,
      probeId: trampoline.id,
      processStart: trampoline.processStart,
      model: 'haiku',
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      responseId: 'actual-response',
      exitCode: 0,
      restricted: true,
      allowlisted: true,
      oauth: { before: auth, after: { ...auth } },
    },
  ]
  return { ...f, result: { ...f.request, ok: true, turns } }
}
test('mandatory result admits independently observed terminal work and the truthful Claude-parent/GPT-child bridge', async () => {
  const f = await successfulFixture()
  assert.match(gateResult(f.result, f.request, f.system.now(), f.state.observations), /correlated/)
})
for (const bad of [
  'parent-failed',
  'child-failed',
  'child-turn',
  'child-model',
  'bridge-attempt',
  'claim-fiction',
  'unknown-probe',
  'oauth-drift',
  'standalone-codex-fiction',
])
  test(`mandatory result refuses ${bad}`, async () => {
    const f = await successfulFixture()
    const bridge = f.result.turns.find((turn) => turn.path === 'bridge')!
    const restricted = f.result.turns.find((turn) => turn.path === 'restricted-oauth')!
    if (bad === 'parent-failed') bridge.parent!.success = false
    if (bad === 'child-failed') bridge.child!.status = 'failed'
    if (bad === 'child-turn') bridge.child!.turnId = 'unrelated'
    if (bad === 'child-model') bridge.child!.model = 'haiku'
    if (bad === 'bridge-attempt') bridge.bridge!.status = 'inProgress'
    if (bad === 'claim-fiction') Object.assign(bridge, { claimSuccess: true })
    if (bad === 'unknown-probe') bridge.probeId = 'self-declared'
    if (bad === 'oauth-drift') restricted.oauth!.after.home = '/other'
    if (bad === 'standalone-codex-fiction') restricted.threadId = 'invented'
    assert.throws(() => gateResult(f.result, f.request, f.system.now(), f.state.observations))
  })

function nativeReceipt(f: Awaited<ReturnType<typeof fixture>>) {
  const parent = {
    threadId: 'native-parent',
    turnId: 'parent-turn',
    model: 'gpt-fixture',
    status: 'completed',
    success: true,
    pong: true,
  }
  const child = {
    threadId: 'native-child',
    turnId: 'child-turn',
    model: 'haiku',
    status: 'completed',
    success: true,
    pong: true,
  }
  const completion = {
    event: 'claim.done',
    ts: f.request.startedAt,
    threadId: child.threadId,
    turnId: child.turnId,
    model: child.model,
    parentThreadId: parent.threadId,
    parentTurnId: parent.turnId,
    owner: join(f.input.root, 'run/claim-990001.sock'),
    success: true,
  }
  return {
    version: 1,
    kind: 'anyengine-native-fanout',
    ...f.request,
    startedAt: f.request.startedAt,
    completedAt: f.request.startedAt,
    effectiveSettings: f.request.key.settings,
    parent,
    child,
    owner: {
      pid: 990001,
      processStart: f.request.startedAt,
      root: f.input.root,
      mode: f.request.mode,
      settings: f.request.key.settings,
      after: true,
      closed: true,
    },
    spawn: {
      id: 'completed-spawn',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: parent.threadId,
      receiverThreadIds: [child.threadId],
      model: child.model,
    },
    completion,
    claim: { ...completion, pid: 990001 },
    cleanup: { threads: true, sessions: true, processes: true },
  }
}
test('native receipt binds actual mode/key, completed exact-model fanout and selected terminal owner', async () => {
  const f = await fixture()
  const receipt = nativeReceipt(f)
  assert.equal(
    validateNativeReceipt(receipt, f.request, 'haiku', 'gpt-fixture', f.system.now()).child.turnId,
    'child-turn',
  )
})
for (const bad of [
  'bootstrap',
  'mode',
  'key',
  'owner',
  'child',
  'parent',
  'spawn-only',
  'model',
  'cleanup',
  'source',
])
  test(`native receipt refuses ${bad} evidence`, async () => {
    const f = await fixture()
    const receipt: any = nativeReceipt(f)
    if (bad === 'bootstrap') receipt.kind = 'bootstrap'
    if (bad === 'mode') receipt.mode = 'model'
    if (bad === 'key') receipt.key = { ...receipt.key, codexVersion: null }
    if (bad === 'owner') receipt.completion.owner = '/foreign/claim.sock'
    if (bad === 'child') receipt.child.turnId = 'unrelated'
    if (bad === 'parent') receipt.parent.status = 'failed'
    if (bad === 'spawn-only') receipt.spawn.status = 'inProgress'
    if (bad === 'model') receipt.spawn.model = 'opus'
    if (bad === 'cleanup') receipt.cleanup.processes = false
    if (bad === 'source') receipt.completion.event = 'trampoline.done'
    assert.throws(() =>
      validateNativeReceipt(receipt, f.request, 'haiku', 'gpt-fixture', f.system.now()),
    )
  })

for (const extra of ['none', 'claims', 'mode', 'fanout', 'wrong-root'])
  test(`disabled live router permits only exact native private enablement: ${extra}`, async () => {
    const f = await fixture()
    f.config.router.enabled = false
    f.config.router.multiAgentV1 = true
    f.request.key.settings = settingsHash(f.config)
    const root = join(f.input.root, '../native')
    renameSync(f.input.root, root)
    const input = { ...f.input, root }
    const privateConfig = structuredClone(f.config)
    privateConfig.router.enabled = true
    if (extra === 'claims') privateConfig.claims.graceMs += 1
    if (extra === 'mode') privateConfig.modes.codexClaude = 'model'
    if (extra === 'fanout') privateConfig.router.multiAgentV1 = false
    if (extra === 'wrong-root') {
      renameSync(root, f.input.root)
      input.root = f.input.root
    }
    writeFileSync(join(input.root, 'config.json'), JSON.stringify(privateConfig))
    const state = createProbeObserver(f.system, f.request, f.config, () => f.request)
    if (extra === 'none') {
      const before = state.observe('before', input)
      state.observe('after', before)
      f.system.procs = [f.owner]
      state.observe('closed', before)
      assert.equal(before.settings, f.request.key.settings)
      assert.equal(f.config.router.enabled, false)
    } else assert.throws(() => state.observe('before', input), /config|mode/)
  })
