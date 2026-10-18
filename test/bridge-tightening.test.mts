import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { BridgeControl, type BridgeHost, type BridgeThreadInfo } from '../src/bridge-control.mjs'
import { BridgeClient } from '../src/bridge-mcp.mjs'
import { inheritFromCaller } from '../src/claude-project-guard.mjs'
import { applyCodexParams, DEFAULT_POSTURE, type Posture } from '../src/posture.mjs'
import { withLocalReadRestrictions } from '../src/requirements-reads.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

type Turn = { params: Record<string, unknown>; effective: Posture }

function fullPosture(): Posture {
  return {
    ...DEFAULT_POSTURE,
    fileSystem: { kind: 'full-access' },
    network: true,
    trust: 'trusted',
  }
}

function workspacePosture(writableRoots: string[] = []): Posture {
  return {
    ...DEFAULT_POSTURE,
    fileSystem: {
      kind: 'workspace-write',
      writableRoots,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    trust: 'trusted',
  }
}

// Exercise the public socket/RPC path. The host models the native child's
// persisted posture: omitted turn fields retain its previous permissions.
async function fixture(initial: Posture, model = 'gpt-test') {
  const home = await tempDir('tight-')
  const parentCwd = join(home, 'parent')
  const outsideCwd = join(home, 'outside')
  const nestedCwd = join(parentCwd, 'nested')
  await Promise.all(
    [parentCwd, outsideCwd, nestedCwd].map((cwd) => mkdir(cwd, { recursive: true })),
  )
  const policyEnv = {
    ANYENGINE_REQUIREMENTS_FILE: join(home, 'requirements.toml'),
    ANYENGINE_MDM_REQUIREMENTS_FILE: join(home, 'absent-mdm'),
    ANYENGINE_MANAGED_CONFIG_FILE: join(home, 'absent-managed'),
    ANYENGINE_MDM_CONFIG_FILE: join(home, 'absent-mdm-config'),
  }
  await writeFile(policyEnv.ANYENGINE_REQUIREMENTS_FILE, '# fixture: no read restriction\n')
  const previousEnv = Object.fromEntries(
    Object.keys(policyEnv).map((key) => [key, process.env[key]]),
  )
  Object.assign(process.env, policyEnv)
  function restorePolicyEnv() {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const threads = new Map<string, BridgeThreadInfo>()
  const starts: Record<string, unknown>[] = []
  const turns: Turn[] = []
  const inheritances: string[] = []
  const inheritedPostures: Posture[] = []
  const parentItems: unknown[] = []
  let active = ['parent']
  let nextChild = 0
  threads.set('parent', {
    id: 'parent',
    owner: 'upstream',
    cwd: parentCwd,
    model: 'gpt-test',
    activeTurnId: 'parent-turn',
    posture: initial,
  })

  function info(id: string): BridgeThreadInfo {
    const found = threads.get(id)
    assert.ok(found, 'fixture thread exists')
    return found
  }

  function setPosture(id: string, posture: Posture): void {
    threads.set(id, { ...info(id), posture })
  }

  const host: BridgeHost = {
    handle: async (peer, message) => {
      if (!('method' in message) || !('id' in message)) return
      const params = (message.params ?? {}) as Record<string, unknown>
      let result: unknown
      if (message.method === 'model/list') {
        result = { data: [{ id: model }] }
      } else if (message.method === 'thread/start') {
        const id = `child-${++nextChild}`
        starts.push(params)
        threads.set(id, {
          id,
          owner: model === 'gpt-test' ? 'upstream' : 'local',
          cwd: String(params.cwd),
          model,
          activeTurnId: null,
          posture: applyCodexParams(DEFAULT_POSTURE, params),
        })
        result = { thread: { id }, model }
      } else if (message.method === 'turn/start') {
        const id = String(params.threadId)
        const durable = applyCodexParams(info(id).posture, params)
        setPosture(id, durable)
        turns.push({ params, effective: withLocalReadRestrictions(durable) })
        result = { turn: { id: `turn-${turns.length}` } }
      } else {
        peer.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Unexpected fixture RPC' },
        })
        return
      }
      peer.send({ jsonrpc: '2.0', id: message.id, result })
    },
    closePeer: () => {},
    appPeerFor: () => null,
    threadInfo: (id) => {
      const found = threads.get(id)
      return found ? { ...found, posture: withLocalReadRestrictions(found.posture) } : null
    },
    activeThreadIds: () => active,
    routeForModel: (id) => (id === 'gpt-test' ? 'upstream' : 'local'),
    createSubagentThread: () => {
      throw new Error('Unexpected local child')
    },
    inheritFromCaller: (id, posture) => {
      inheritances.push(id)
      inheritedPostures.push(posture)
      setPosture(id, inheritFromCaller(info(id).posture, posture))
    },
    emitParentItem: (...args) => {
      parentItems.push(args)
    },
    supportsCompletedActivity: () => false,
  }
  const env = {
    ANYENGINE_BRIDGE_SOCKET: join(home, 'b.sock'),
    ANYENGINE_BRIDGE_TOKEN: 'fixture-only',
  }
  const control = new BridgeControl(host, { env })
  const clients: BridgeClient[] = []
  function client(fixed?: string): BridgeClient {
    const made = new BridgeClient({
      ...env,
      ...(fixed === undefined ? {} : { ANYENGINE_BRIDGE_THREAD: fixed }),
    })
    clients.push(made)
    return made
  }
  const shared = client()
  try {
    await control.start()
  } catch (error) {
    restorePolicyEnv()
    throw error
  }
  return {
    parentCwd,
    outsideCwd,
    nestedCwd,
    starts,
    turns,
    inheritances,
    inheritedPostures,
    parentItems,
    threads,
    info,
    setPosture,
    client,
    shared,
    setActive(ids: string[]) {
      active = ids
    },
    async spawn(cwd = parentCwd, caller: string | null = 'parent') {
      const result = (await shared.call(
        'bridge/spawnSession',
        { model, prompt: 'fixture initial turn', cwd, wait: false },
        30_000,
        caller,
      )) as { threadId: string }
      assert.equal(typeof result.threadId, 'string')
      return result.threadId
    },
    send(id: string, caller: string | null = 'parent', sender = shared) {
      return sender.call(
        'bridge/send',
        { threadId: id, prompt: 'fixture follow-up', wait: false },
        30_000,
        caller,
      )
    },
    async setLocalReadRestriction(active: boolean) {
      await writeFile(
        policyEnv.ANYENGINE_REQUIREMENTS_FILE,
        active
          ? '[permissions.filesystem]\ndeny_read = ["/fixture-blocked/**"]\n'
          : '# fixture: read restriction cleared\n',
      )
    },
    async close() {
      try {
        for (const made of clients) made.close()
        await control.stop()
      } finally {
        restorePolicyEnv()
      }
    },
  }
}

function latestTurn(turns: Turn[]): Turn {
  const turn = turns.at(-1)
  assert.ok(turn, 'a public turn/start was emitted')
  return turn
}

function assertPolicy(turn: Turn, approval: string, sandbox: Record<string, unknown>): void {
  assert.equal(turn.params.approvalPolicy, approval)
  assert.equal(turn.params.approvalsReviewer, 'user')
  assert.deepEqual(turn.params.sandboxPolicy, sandbox)
}

for (const [label, initial] of [
  ['full access', fullPosture],
  ['workspace write', workspacePosture],
] as const) {
  for (const tightening of [
    'read-only',
    'plan',
    'untrusted approval',
    'untrusted trust',
  ] as const) {
    test(`public follow-up tightens ${label} child to ${tightening}`, async () => {
      const f = await fixture(initial())
      try {
        const child = await f.spawn()
        assert.equal(f.turns.length, 1)
        const original = latestTurn(f.turns)
        assert.equal(original.effective.fileSystem.kind, initial().fileSystem.kind)
        assert.equal(original.params.approvalPolicy, 'on-request')

        const sourcePolicy = { 'fixture-parent-policy': 'fixture-source-baseline' }
        const parent: Posture = { ...initial(), projectBaseline: sourcePolicy }
        if (tightening === 'read-only') {
          parent.fileSystem = { kind: 'read-only' }
          parent.network = false
        } else if (tightening === 'plan') {
          parent.plan = true
        } else if (tightening === 'untrusted approval') {
          parent.approval = 'untrusted'
        } else {
          parent.trust = 'untrusted'
        }
        f.setPosture('parent', parent)
        await f.send(child)
        assert.equal(f.turns.length, 2)
        const turn = latestTurn(f.turns)
        if (tightening === 'read-only' || tightening === 'plan') {
          assertPolicy(turn, tightening === 'plan' ? 'never' : 'on-request', {
            type: 'readOnly',
            networkAccess: false,
          })
          assert.equal(turn.effective.fileSystem.kind, 'read-only')
          assert.equal(turn.effective.network, false)
        } else {
          const sandbox =
            label === 'full access'
              ? { type: 'dangerFullAccess' }
              : {
                  type: 'workspaceWrite',
                  writableRoots: [],
                  networkAccess: false,
                  excludeTmpdirEnvVar: true,
                  excludeSlashTmp: true,
                }
          assertPolicy(
            turn,
            tightening === 'untrusted approval' ? 'untrusted' : 'on-request',
            sandbox,
          )
          const effectiveTrust = tightening === 'untrusted approval' ? 'untrusted' : parent.trust
          // Native approval conversion conservatively marks untrusted approval
          // as untrusted trust; inheritance must preserve the distinct input.
          assert.equal(turn.effective.trust, effectiveTrust)
        }
        assert.equal(
          f.inheritedPostures.at(-1)?.trust,
          parent.trust,
          'inheritance preserves caller trust independently of its approval policy',
        )
        assert.deepEqual(turn.effective.projectBaseline, sourcePolicy)
        assert.deepEqual(f.info('parent').posture, parent, 'the caller is never mutated')
      } finally {
        await f.close()
      }
    })
  }
}

test('public follow-up never loosens an independently tightened child', async () => {
  const f = await fixture(fullPosture())
  try {
    const child = await f.spawn()
    f.setPosture(child, {
      ...DEFAULT_POSTURE,
      approval: 'never',
      trust: 'untrusted',
    })
    await f.send(child)
    const turn = latestTurn(f.turns)
    assert.equal(f.turns.length, 2)
    assertPolicy(turn, 'never', { type: 'readOnly', networkAccess: false })
    assert.equal(turn.effective.trust, 'untrusted')
    assert.equal(turn.effective.fileSystem.kind, 'read-only')
    assert.equal(turn.effective.network, false)
  } finally {
    await f.close()
  }
})

for (const scenario of ['full outside', 'workspace outside', 'full nested'] as const) {
  test(`public follow-up refuses an implicit child cwd grant: ${scenario}`, async () => {
    const f = await fixture(fullPosture())
    try {
      const cwd = scenario === 'full nested' ? f.nestedCwd : f.outsideCwd
      if (scenario === 'workspace outside') f.setPosture('parent', workspacePosture([cwd]))
      const child = await f.spawn(cwd)
      f.setPosture('parent', workspacePosture())
      const before = structuredClone(f.info(child))
      const inheritanceCount = f.inheritances.length
      await assert.rejects(f.send(child), /cwd.*calling thread.*root/i)
      assert.equal(f.turns.length, 1, 'refusal emits no follow-up turn')
      assert.equal(f.inheritances.length, inheritanceCount, 'refusal mutates no inherited posture')
      assert.deepEqual(f.info(child), before)
    } finally {
      await f.close()
    }
  })
}

test('public follow-up permits a different child cwd still named as an explicit caller root', async () => {
  const f = await fixture(fullPosture())
  try {
    const child = await f.spawn(f.outsideCwd)
    f.setPosture('parent', workspacePosture([f.outsideCwd]))
    await f.send(child)
    assert.equal(f.turns.length, 2)
    assertPolicy(latestTurn(f.turns), 'on-request', {
      type: 'workspaceWrite',
      writableRoots: [f.outsideCwd],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    })
  } finally {
    await f.close()
  }
})

test('public follow-up still refuses read restrictions that a native GPT child cannot enforce', async () => {
  const f = await fixture(fullPosture())
  try {
    const child = await f.spawn()
    f.setPosture('parent', { ...fullPosture(), readRestricted: true })
    const before = structuredClone(f.info(child))
    const inheritanceCount = f.inheritances.length
    await assert.rejects(f.send(child), /only Claude children can enforce/i)
    assert.equal(f.turns.length, 1)
    assert.equal(f.inheritances.length, inheritanceCount)
    assert.deepEqual(f.info(child), before)
  } finally {
    await f.close()
  }
})

for (const restriction of ['plan', 'untrusted approval', 'untrusted trust'] as const) {
  test(`public anonymous spawn refuses ambiguous active callers: ${restriction}`, async () => {
    const posture = fullPosture()
    if (restriction === 'plan') posture.plan = true
    else if (restriction === 'untrusted approval') posture.approval = 'untrusted'
    else posture.trust = 'untrusted'
    const f = await fixture(posture)
    try {
      f.threads.set('other', { ...f.info('parent'), id: 'other', posture: DEFAULT_POSTURE })
      f.setActive(['parent', 'other'])
      for (const method of ['bridge/spawnSession', 'bridge/spawnSubagents']) {
        await assert.rejects(
          f.shared.call(
            method,
            {
              model: 'gpt-test',
              prompt: 'fixture ambiguous request',
              parentThreadId: 'parent',
              tasks: [{ model: 'gpt-test', prompt: 'fixture task' }],
              wait: false,
            },
            30_000,
          ),
          /calling thread unknown|caller.*metadata/i,
        )
      }
      assert.equal(f.starts.length, 0)
      assert.equal(f.turns.length, 0)
      assert.equal(f.inheritances.length, 0)
      assert.equal(f.parentItems.length, 0)
      assert.equal(f.threads.size, 2)
    } finally {
      await f.close()
    }
  })
}

test('public anonymous spawn preserves zero-active DEFAULT compatibility', async () => {
  const f = await fixture({ ...fullPosture(), plan: true, trust: 'untrusted' })
  try {
    f.setActive([])
    await f.spawn(f.outsideCwd, null)
    assert.equal(f.starts.length, 1)
    assertPolicy(latestTurn(f.turns), 'on-request', { type: 'readOnly', networkAccess: false })
    assert.equal(latestTurn(f.turns).effective.trust, 'unknown')
  } finally {
    await f.close()
  }
})

test('public anonymous spawn preserves sole-active caller permissions', async () => {
  const f = await fixture({ ...fullPosture(), plan: true, trust: 'untrusted' })
  try {
    await f.spawn(f.parentCwd, null)
    assert.equal(f.starts.length, 1)
    assertPolicy(latestTurn(f.turns), 'never', { type: 'readOnly', networkAccess: false })
    assert.equal(latestTurn(f.turns).effective.trust, 'untrusted')
  } finally {
    await f.close()
  }
})

test('public bridge refuses invalid supplied and fixed identities without starting work', async () => {
  const f = await fixture(fullPosture())
  try {
    const args = { model: 'gpt-test', prompt: 'fixture invalid caller', wait: false }
    for (const caller of ['missing', '', 42]) {
      await assert.rejects(
        f.shared.call('bridge/spawnSession', args, 30_000, caller as string),
        /invalid.*caller|unknown.*caller/i,
      )
    }
    const unknownFixed = f.client('missing')
    for (const active of [['parent'], []]) {
      f.setActive(active)
      await assert.rejects(
        unknownFixed.call('bridge/spawnSession', args, 30_000),
        /unknown.*caller/i,
      )
    }
    f.threads.set('other', { ...f.info('parent'), id: 'other' })
    await assert.rejects(
      f.client('parent').call('bridge/spawnSession', args, 30_000, 'other'),
      /does not match/i,
    )
    assert.equal(f.starts.length, 0)
    assert.equal(f.turns.length, 0)
    assert.equal(f.inheritances.length, 0)
  } finally {
    await f.close()
  }
})

test('public fixed-identity follow-up tightens correctly while other callers are active', async () => {
  const f = await fixture(fullPosture())
  try {
    const child = await f.spawn()
    f.setPosture('parent', { ...DEFAULT_POSTURE, approval: 'never', trust: 'untrusted' })
    f.threads.set('other', { ...f.info('parent'), id: 'other', posture: fullPosture() })
    f.setActive(['parent', 'other'])
    await f.send(child, null, f.client('parent'))
    assert.equal(f.turns.length, 2)
    assertPolicy(latestTurn(f.turns), 'never', { type: 'readOnly', networkAccess: false })
    assert.equal(latestTurn(f.turns).effective.trust, 'untrusted')
  } finally {
    await f.close()
  }
})

// A transient deny_read makes every write look denied. It must not select a
// looser durable filesystem and then disappear at the inheritance boundary.
test('public GPT follow-up refuses a live local deny_read before inheritance or turn admission', async () => {
  const f = await fixture(fullPosture())
  try {
    const child = await f.spawn()
    const before = structuredClone(f.info(child))
    const inheritanceCount = f.inheritances.length
    await f.setLocalReadRestriction(true)
    await assert.rejects(f.send(child), /only Claude children can enforce/i)
    assert.equal(f.turns.length, 1, 'no follow-up turn reaches the native child')
    assert.equal(
      f.inheritances.length,
      inheritanceCount,
      'no inheritance mutation precedes refusal',
    )
    assert.deepEqual(f.info(child), before)
  } finally {
    await f.close()
  }
})

test('public Claude follow-up retains live deny_read and the tighter durable filesystem after clearing', async () => {
  const f = await fixture(fullPosture(), 'claude-fixture')
  try {
    const child = await f.spawn()
    f.setPosture(child, workspacePosture())
    await f.setLocalReadRestriction(true)
    await f.send(child)
    assert.equal(f.turns.length, 2)
    const active = latestTurn(f.turns)
    assert.equal(active.effective.readRestricted, true, 'the local Claude turn keeps the live deny')
    assert.equal(
      f.inheritedPostures.at(-1)?.readRestricted,
      true,
      'admission retains the live deny',
    )
    assertPolicy(active, 'on-request', {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    })

    await f.setLocalReadRestriction(false)
    await f.send(child)
    assert.equal(f.turns.length, 3)
    const cleared = latestTurn(f.turns)
    assert.ok(
      !cleared.effective.readRestricted,
      'the transient read denial clears without persisting',
    )
    assert.equal(f.info(child).posture.fileSystem.kind, 'workspace-write')
    assert.equal(f.info(child).posture.network, false)
    assertPolicy(cleared, 'on-request', {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    })
  } finally {
    await f.close()
  }
})
