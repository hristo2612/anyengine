import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { AppModelPick, ConfigWrites, splitModelEdits, staysLocal } from '../src/config-writes.mjs'
import type { WireMessage } from '../src/types.mjs'
import { AdapterClient, type Wire } from './helpers/adapter-client.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(async () => {
  await killChildren()
  await removeTempDirs()
})

const adapter = resolve('dist/src/adapter.mjs')
const fakeCodex = resolve('test/fixtures/fake-codex-app-server.mjs')
const edit = (keyPath: string, value: unknown) => ({ keyPath, value, mergeStrategy: 'replace' })

test('config writes: a model codex cannot serve stays local, anything else goes to codex', () => {
  for (const id of [
    'sonnet',
    'opus',
    'haiku',
    'fable',
    'claude-opus-4-7',
    'grok-4',
    'grok-code-fast-1',
    'some-future-claude',
  ]) {
    assert.equal(staysLocal(edit('model', id)), true, id)
    assert.equal(staysLocal(edit('review_model', id)), true, id)
    // codex 0.159 refuses every profiles.* write; the refusal reaches the app.
    assert.equal(staysLocal(edit('profiles.work.model', id)), false, id)
  }
  for (const id of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'o3', 'codex-mini-latest']) {
    assert.equal(staysLocal(edit('model', id)), false, id)
  }
  assert.equal(staysLocal(edit('model', '')), false)
  assert.equal(staysLocal(edit('model', null)), false)
  assert.equal(staysLocal(edit('model_reasoning_effort', 'sonnet')), false, 'only model keys')
  assert.equal(staysLocal(edit('model_provider', 'claude-code')), false)
  assert.equal(staysLocal(edit('mcp_servers.x.model', 'sonnet')), false, 'top level only')
  assert.equal(staysLocal(edit('profiles.__proto__.model', 'sonnet')), false)
  assert.equal(staysLocal(edit('__proto__', 'sonnet')), false)
})

test('config writes: a batch is split, and a GPT pick clears the local one', () => {
  const batch = splitModelEdits('config/batchWrite', {
    edits: [edit('model', 'sonnet'), edit('model_reasoning_effort', 'high')],
    expectedVersion: 'v1',
  })
  assert.deepEqual(batch.picks, { model: 'sonnet' })
  assert.deepEqual(batch.forward, {
    edits: [edit('model_reasoning_effort', 'high')],
    expectedVersion: 'v1',
  })

  const onlyClaude = splitModelEdits('config/value/write', edit('model', 'opus'))
  assert.equal(onlyClaude.forward, null)
  assert.deepEqual(onlyClaude.picks, { model: 'opus' })

  const gpt = splitModelEdits('config/value/write', edit('model', 'gpt-6.1-sol'))
  assert.deepEqual(gpt.forward, edit('model', 'gpt-6.1-sol'))
  assert.deepEqual(gpt.picks, { model: null })

  const cleared = splitModelEdits('config/batchWrite', { edits: [edit('model', null)] })
  assert.deepEqual(cleared.picks, { model: null })
  assert.deepEqual(cleared.forward, { edits: [edit('model', null)] })

  const unrelated = splitModelEdits('config/batchWrite', {
    edits: [edit('approval_policy', 'never')],
  })
  assert.deepEqual(unrelated.picks, {})
  assert.deepEqual(unrelated.forward, { edits: [edit('approval_policy', 'never')] })

  // The app's picker under a profile: codex refuses the whole batch itself.
  const profile = {
    edits: [
      edit('profiles.work.model', 'sonnet'),
      edit('profiles.work.model_reasoning_effort', 'high'),
    ],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  }
  assert.deepEqual(splitModelEdits('config/batchWrite', profile), { forward: profile, picks: {} })
  const polluting = edit('profiles.__proto__.model', 'sonnet')
  assert.deepEqual(splitModelEdits('config/value/write', polluting), {
    forward: polluting,
    picks: {},
  })
})

test('config writes: the pick file is private, round-trips, and disappears when empty', async () => {
  const dir = await tempDir('ae-cfg-')
  const pick = new AppModelPick(join(dir, 'app-model-pick.json'))
  assert.deepEqual(pick.read(), {})
  pick.apply({ model: 'sonnet', review_model: 'opus' })
  assert.equal(statSync(join(dir, 'app-model-pick.json')).mode & 0o777, 0o600)
  assert.deepEqual(new AppModelPick(join(dir, 'app-model-pick.json')).read(), {
    model: 'sonnet',
    review_model: 'opus',
  })
  const overlaid = pick.overlay({ model: 'gpt-6.1-sol', review_model: 'gpt-6-astra', x: 1 })
  assert.deepEqual(overlaid, { model: 'sonnet', review_model: 'opus', x: 1 })
  pick.apply({ 'profiles.work.model': 'opus', sandbox_mode: 'danger-full-access' })
  assert.deepEqual(pick.read(), { model: 'sonnet', review_model: 'opus' }, 'model keys only')
  pick.apply({ model: null, review_model: null })
  assert.equal(existsSync(join(dir, 'app-model-pick.json')), false)
  assert.deepEqual(pick.overlay({ model: 'gpt-6.1-sol' }), { model: 'gpt-6.1-sol' })
})

// Only model keys are ever laid over what the app reads: the app decides
// permission overrides from config/read, so a hand-edited `sandbox_mode` in
// the pick file must not reach it.
test('config writes: a key in the pick file other than a model key is ignored', async () => {
  const dir = await tempDir('ae-cfg-')
  const path = join(dir, 'app-model-pick.json')
  writeFileSync(
    path,
    JSON.stringify({
      model: 'sonnet',
      sandbox_mode: 'danger-full-access',
      approval_policy: 'never',
      'profiles.work.model': 'opus',
      model_provider: 'claude-code',
    }),
  )
  const pick = new AppModelPick(path)
  assert.deepEqual(pick.read(), { model: 'sonnet' })
  assert.deepEqual(
    pick.overlay({
      model: 'gpt-6.1-sol',
      sandbox_mode: 'workspace-write',
      approval_policy: 'on-request',
    }),
    { model: 'sonnet', sandbox_mode: 'workspace-write', approval_policy: 'on-request' },
  )
})

// A pick file that names a prototype (by hand, or from an older build that
// kept profile keys) must never reach Object.prototype, in the file or on the
// way through the overlay.
test('config writes: no pick reaches Object.prototype through the overlay', async () => {
  const dir = await tempDir('ae-cfg-')
  const path = join(dir, 'app-model-pick.json')
  const hostile = {
    model: 'sonnet',
    'profiles.__proto__.model': 'sonnet',
    '__proto__.model': 'sonnet',
    'constructor.prototype.model': 'sonnet',
    'profiles.constructor.prototype.review_model': 'opus',
  }
  const probe = (): unknown[] => [
    ({} as Record<string, unknown>).model,
    ({} as Record<string, unknown>).review_model,
    Object.hasOwn(Object.prototype, 'model'),
  ]
  const clean = [undefined, undefined, false]
  try {
    writeFileSync(path, JSON.stringify(hostile))
    const pick = new AppModelPick(path)
    assert.deepEqual(pick.read(), { model: 'sonnet' })
    assert.deepEqual(pick.overlay({ model: 'gpt-6.1-sol', profiles: {} }), {
      model: 'sonnet',
      profiles: {},
    })
    assert.deepEqual(probe(), clean, 'the file is read safely')

    // The overlay's own guard, for a reader that lets such keys through.
    class Unfiltered extends AppModelPick {
      override read(): Record<string, string> {
        return hostile
      }
    }
    const out = new Unfiltered(path).overlay({ model: 'gpt-6.1-sol', profiles: {} })
    assert.deepEqual(out, { model: 'sonnet', profiles: {} })
    assert.deepEqual(probe(), clean, 'the overlay refuses a prototype segment')

    const writes = new ConfigWrites(
      {
        request: async () => {
          throw new Error('not asked')
        },
      },
      new AppModelPick(join(dir, 'fresh.json')),
    )
    const plan = await writes.plan('config/value/write', edit('profiles.__proto__.model', 'sonnet'))
    assert.ok('forward' in plan, 'codex answers a profile write itself')
    assert.equal(existsSync(join(dir, 'fresh.json')), false)
    assert.deepEqual(probe(), clean)
  } finally {
    for (const key of ['model', 'review_model']) {
      if (Object.hasOwn(Object.prototype, key))
        delete (Object.prototype as Record<string, unknown>)[key]
    }
  }
})

// codex 0.159 ranks its layers (ConfigLayerSource::precedence()) and says
// which layer set each key in `origins`. A pick stands in for a line in the
// user config.toml, so it shows only where that file would win: over MDM,
// enterprise and system defaults, not under a trusted project, a --profile or
// -c flag, or a legacy managed_config.toml layer.
test('config writes: a key a layer above the user file set keeps codex’s answer', async () => {
  const dir = await tempDir('ae-cfg-')
  const pick = new AppModelPick(join(dir, 'pick.json'))
  pick.apply({ model: 'sonnet' })
  const writes = new ConfigWrites({ request: async () => ({}) }, pick)
  const from = (name: Record<string, unknown>) => ({ name, version: 'sha256:0' })
  const modelFrom = async (origin: unknown) => {
    const origins = origin === undefined ? {} : { model: origin }
    const read = (await writes.mergeRead(
      Promise.resolve({ config: { model: 'gpt-5.5' }, origins, layers: null }),
      Promise.resolve({ config: {}, origins: {} }),
    )) as Wire
    assert.deepEqual(read.origins, origins, 'origins are codex’s own')
    return read.config.model
  }
  const higher = [
    { type: 'project', dotCodexFolder: '/repo/.codex' },
    { type: 'sessionFlags' },
    { type: 'user', file: '/h/.codex/profiles/work.toml', profile: 'work' },
    { type: 'legacyManagedConfigTomlFromFile', file: '/etc/codex/managed_config.toml' },
    { type: 'legacyManagedConfigTomlFromMdm' },
  ]
  for (const name of higher) assert.equal(await modelFrom(from(name)), 'gpt-5.5', String(name.type))
  const lower = [
    { type: 'user', file: '/h/.codex/config.toml', profile: null },
    { type: 'enterpriseManaged', id: 'x', name: 'x' },
    { type: 'system', file: '/etc/codex/config.toml' },
    { type: 'mdm', domain: 'com.openai.codex', key: 'config' },
    { type: 'packagedDefaults', file: '/app/defaults.toml' },
  ]
  for (const name of lower) assert.equal(await modelFrom(from(name)), 'sonnet', String(name.type))
  assert.equal(await modelFrom(undefined), 'sonnet', 'no layer set it')
  assert.equal(
    await modelFrom(from({ type: 'someLaterLayer' })),
    'gpt-5.5',
    'a layer this codex did not have keeps codex’s answer',
  )
})

test('config writes: a write with nothing left for codex is answered with the file’s current version', async () => {
  const dir = await tempDir('ae-cfg-')
  const calls: Array<[string, unknown]> = []
  const child = {
    request: async (method: string, params: unknown) => {
      calls.push([method, params])
      return {
        config: {},
        origins: {},
        layers: [
          {
            name: { type: 'system', file: '/etc/codex/config.toml' },
            version: 'sys',
            config: {},
            disabledReason: null,
          },
          {
            name: { type: 'user', file: '/h/.codex/config.toml', profile: null },
            version: 'user-v7',
            config: {},
            disabledReason: null,
          },
        ],
      }
    },
  }
  const writes = new ConfigWrites(child, new AppModelPick(join(dir, 'pick.json')))
  const plan = await writes.plan('config/value/write', edit('model', 'sonnet'))
  assert.deepEqual(plan, {
    answer: {
      status: 'ok',
      version: 'user-v7',
      filePath: '/h/.codex/config.toml',
      overriddenMetadata: null,
    },
  })
  assert.deepEqual(calls, [['config/read', { includeLayers: true }]])
  assert.deepEqual(new AppModelPick(join(dir, 'pick.json')).read(), { model: 'sonnet' })

  const failing = new ConfigWrites(
    {
      request: async () => {
        throw new Error('child gone')
      },
    },
    new AppModelPick(join(dir, 'pick2.json')),
  )
  const failed = await failing.plan('config/value/write', edit('model', 'opus'))
  assert.ok('error' in failed)
  assert.deepEqual(
    new AppModelPick(join(dir, 'pick2.json')).read(),
    {},
    'no pick stored when the answer failed',
  )
})

// codex applies a batch all or nothing, so the pick split off a forwarded
// batch is kept only when codex accepted the rest of it.
test('config writes: a pick split off a forwarded write is kept only when codex takes the rest', async () => {
  const dir = await tempDir('ae-cfg-')
  const path = join(dir, 'pick.json')
  const writes = new ConfigWrites(
    {
      request: async () => {
        throw new Error('a forwarded write never asks for a version')
      },
    },
    new AppModelPick(path),
  )
  const seen: WireMessage[] = []
  const app = { id: 'app', send: (message: WireMessage) => seen.push(message), close: () => {} }

  const rejected = await writes.plan('config/batchWrite', {
    edits: [edit('model', 'sonnet'), edit('model_reasoning_effort', 'high')],
    expectedVersion: 'stale',
  })
  assert.ok('forward' in rejected)
  assert.deepEqual(rejected.forward, {
    edits: [edit('model_reasoning_effort', 'high')],
    expectedVersion: 'stale',
  })
  assert.equal(existsSync(path), false, 'nothing is kept before codex answers')
  const conflict = { jsonrpc: '2.0' as const, id: 3, error: { code: -32600, message: 'conflict' } }
  rejected.peer(app).send(conflict)
  assert.deepEqual(seen, [conflict], 'the child’s answer reaches the app unchanged')
  assert.equal(existsSync(path), false, 'a rejected batch keeps no pick')

  const accepted = await writes.plan('config/batchWrite', {
    edits: [edit('model', 'sonnet'), edit('model_reasoning_effort', 'high')],
  })
  assert.ok('forward' in accepted)
  accepted.peer(app).send({ jsonrpc: '2.0', id: 4, result: { status: 'ok', version: 'v2' } })
  assert.deepEqual(new AppModelPick(path).read(), { model: 'sonnet' })

  const gpt = await writes.plan('config/value/write', edit('model', 'gpt-6.1-sol'))
  assert.ok('forward' in gpt)
  gpt.peer(app).send({ jsonrpc: '2.0', id: 5, error: { code: -32000, message: 'disk full' } })
  assert.deepEqual(
    new AppModelPick(path).read(),
    { model: 'sonnet' },
    'a failed GPT pick clears nothing',
  )
  gpt.peer(app).send({ jsonrpc: '2.0', id: 5, result: { status: 'ok', version: 'v3' } })
  assert.equal(existsSync(path), false, 'an accepted GPT pick clears the local one')
})

test('config writes: codex’s answer reaches the app even when the pick cannot be saved', async () => {
  const dir = await tempDir('ae-cfg-')
  writeFileSync(join(dir, 'not-a-dir'), '')
  const writes = new ConfigWrites(
    { request: async () => ({}) },
    new AppModelPick(join(dir, 'not-a-dir', 'pick.json')),
  )
  const plan = await writes.plan('config/batchWrite', {
    edits: [edit('model', 'sonnet'), edit('model_reasoning_effort', 'high')],
  })
  assert.ok('forward' in plan)
  const seen: WireMessage[] = []
  const ok = { jsonrpc: '2.0' as const, id: 9, result: { status: 'ok', version: 'v2' } }
  plan.peer({ id: 'app', send: (message) => seen.push(message), close: () => {} }).send(ok)
  assert.deepEqual(seen, [ok])
})

function launchMux(home: string): AdapterClient {
  return new AdapterClient(
    spawn(
      process.execPath,
      [adapter, '-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'],
      {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...process.env,
          ANYENGINE_MOCK: '1',
          ANYENGINE_HOME: join(home, 'adapter'),
          CODEX_HOME: join(home, 'codex'),
          ANYENGINE_REAL_CODEX: fakeCodex,
          ANYENGINE_MODELS: 'opus,sonnet',
          ANYENGINE_DEFAULT_MODEL: 'opus',
          ANYENGINE_RUNTIME_TYPE: 'mock',
          ANYENGINE_RUNTIME_ENV: join(home, 'missing.env'),
          ANYENGINE_NATIVE_CODEX: '',
          CLAUDE_CODEX_NATIVE_CODEX: '',
          ANYENGINE_GPT_ROUTE: '',
          FAKE_CODEX_CONFIG: join(home, 'codex-config.json'),
          NODE_NO_WARNINGS: '1',
        },
      },
    ),
  )
}

async function started(home: string): Promise<AdapterClient> {
  const client = launchMux(home)
  await client.request('initialize', {
    clientInfo: { name: 'codex_desktop', title: 'Codex Desktop', version: '26.928' },
  })
  client.child.stdin?.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`,
  )
  return client
}

const sharedConfig = (home: string): Wire =>
  existsSync(join(home, 'codex-config.json'))
    ? JSON.parse(readFileSync(join(home, 'codex-config.json'), 'utf8'))
    : {}

test('native mux: the app’s Claude pick never reaches the shared config, and survives a restart', async () => {
  const home = await tempDir('ae-cfgmux-')
  let client = await started(home)
  try {
    const batch = await client.request('config/batchWrite', {
      edits: [edit('model', 'sonnet'), edit('model_reasoning_effort', 'high')],
    })
    assert.equal(batch.result.status, 'ok')
    assert.deepEqual(
      sharedConfig(home),
      { model_reasoning_effort: 'high' },
      'only the effort reached codex',
    )
    assert.equal((await client.request('config/read', {})).result.config.model, 'sonnet')

    const layers = await client.request('config/read', { includeLayers: true })
    const single = await client.request('config/value/write', edit('model', 'opus'))
    assert.equal(
      single.result.version,
      layers.result.layers[0].version,
      'nothing was written, same version',
    )
    assert.equal(sharedConfig(home).model, undefined)
    await client.close()

    client = await started(home)
    assert.equal(
      (await client.request('config/read', {})).result.config.model,
      'opus',
      'the pick survives a restart',
    )
    assert.equal(
      sharedConfig(home).model,
      undefined,
      'a terminal codex with no -m still gets its GPT default',
    )

    await client.request('config/value/write', edit('model', 'gpt-6.1-sol'))
    assert.equal(sharedConfig(home).model, 'gpt-6.1-sol')
    assert.equal((await client.request('config/read', {})).result.config.model, 'gpt-6.1-sol')
    assert.equal(
      existsSync(join(home, 'adapter', 'app-model-pick.json')),
      false,
      'a GPT pick clears the local one',
    )
  } finally {
    await client.close()
  }
})

// codex 0.159 versions the user config.toml by a hash of its contents and
// refuses a write whose expectedVersion is stale (configVersionConflict). A
// Claude pick answered here writes nothing, so the version it answers with is
// the one the app's next write must carry, and the child still refuses a
// stale one.
test('native mux: write, write, read: a locally kept pick leaves the version the next write expects', async () => {
  const home = await tempDir('ae-cfgcycle-')
  const client = await started(home)
  const userVersion = async () =>
    (await client.request('config/read', { includeLayers: true })).result.layers[0].version
  try {
    const v0 = await userVersion()
    const claude = await client.request('config/value/write', {
      ...edit('model', 'sonnet'),
      expectedVersion: v0,
    })
    assert.equal(claude.result.version, v0, 'a local pick answers with the unchanged version')

    const effort = await client.request('config/batchWrite', {
      edits: [edit('model_reasoning_effort', 'high')],
      expectedVersion: claude.result.version,
    })
    assert.equal(effort.error, undefined, 'the next write is not a conflict')
    const v1 = effort.result.version
    assert.notEqual(v1, v0)
    assert.equal(await userVersion(), v1)

    const opus = await client.request('config/batchWrite', {
      edits: [edit('model', 'opus')],
      expectedVersion: v1,
    })
    assert.equal(opus.result.version, v1)

    const read = await client.request('config/read', {})
    assert.equal(read.result.config.model, 'opus')
    assert.equal(read.result.config.model_reasoning_effort, 'high')

    const stale = await client.request('config/batchWrite', {
      edits: [edit('model', 'gpt-6.1-sol'), edit('model_reasoning_effort', 'low')],
      expectedVersion: v0,
    })
    assert.equal(stale.error?.data?.config_write_error_code, 'configVersionConflict')
    assert.equal(
      (await client.request('config/read', {})).result.config.model,
      'opus',
      'a rejected GPT pick leaves the local pick in place',
    )
    assert.deepEqual(sharedConfig(home), { model_reasoning_effort: 'high' })

    const gpt = await client.request('config/batchWrite', {
      edits: [edit('model', 'gpt-6.1-sol')],
      expectedVersion: v1,
    })
    assert.equal(gpt.result.status, 'ok')
    assert.equal((await client.request('config/read', {})).result.config.model, 'gpt-6.1-sol')
    assert.equal(existsSync(join(home, 'adapter', 'app-model-pick.json')), false)
  } finally {
    await client.close()
  }
})
