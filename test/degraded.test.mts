import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { DEFAULT_CONFIG, enginePaths } from '../src/anyengine-config.mjs'
import {
  clearDegraded,
  clearProof,
  isProven,
  markDegraded,
  markProven,
  proofKey,
  readDegraded,
  readProof,
  sameKey,
  settingsHash,
} from '../src/degraded.mjs'
import { FanoutMonitor } from '../src/router-fanout.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

test('proof: each shaping setting and version invalidates it, unrelated settings do not', async () => {
  const root = await tempDir('proof-')
  const key = proofKey(root, {
    lib: () => 'lib-a',
    appVersion: () => 'app-a',
    codexVersion: () => 'codex-a',
  })
  markProven(root, 'native-fanout', 'passed', key)
  assert.equal(isProven(root, 'native-fanout', key), true)
  for (const field of ['lib', 'appVersion', 'codexVersion', 'settings'] as const) {
    assert.equal(isProven(root, 'native-fanout', { ...key, [field]: 'changed' }), false)
  }
  for (const change of [
    (c: typeof DEFAULT_CONFIG) => {
      c.router.multiAgentV1 = false
    },
    (c: typeof DEFAULT_CONFIG) => {
      c.modes.codexClaude = 'model'
    },
    (c: typeof DEFAULT_CONFIG) => {
      c.claude.models[0]!.contextWindow += 1
    },
    (c: typeof DEFAULT_CONFIG) => {
      c.claude.spawnPriority.reverse()
    },
    (c: typeof DEFAULT_CONFIG) => {
      c.claims.graceMs += 1
    },
  ]) {
    const cfg = structuredClone(DEFAULT_CONFIG)
    change(cfg)
    assert.notEqual(settingsHash(cfg), key.settings)
  }
  const other = structuredClone(DEFAULT_CONFIG)
  other.router.port += 1
  other.claude.cli = '/unused'
  other.smoke.enabled = false
  assert.equal(settingsHash(other), key.settings)
  markDegraded(root, 'native-fanout', 'failure')
  assert.equal(readProof(root, 'native-fanout'), null)
  assert.equal(isProven(root, 'native-fanout', key), false)
  const since = readDegraded(root).paths['native-fanout']?.since
  markDegraded(root, 'native-fanout', 'failed again')
  assert.equal(readDegraded(root).paths['native-fanout']?.since, since)
  clearDegraded(root, 'native-fanout')
  assert.equal(isProven(root, 'native-fanout', key), false)
  markProven(root, 'native-fanout', 'pass', key)
  clearProof(root, 'native-fanout')
  assert.equal(isProven(root, 'native-fanout', key), false)
  assert.equal(sameKey(key, { ...key }), true)
})

test('proof: malformed state never grants native or throws', async () => {
  const root = await tempDir('proof-')
  mkdirSync(enginePaths(root).state, { recursive: true })
  for (const raw of [
    'null',
    '{',
    '{"paths":null}',
    '{"paths":[]}',
    '{"paths":{"native-fanout":{}}}',
  ]) {
    writeFileSync(join(enginePaths(root).state, 'proven.json'), raw)
    writeFileSync(join(enginePaths(root).state, 'degraded.json'), raw)
    assert.equal(isProven(root, 'native-fanout', proofKey(root)), false)
    assert.equal(new FanoutMonitor(() => DEFAULT_CONFIG, root).state.path, 'bridge')
  }
})

test('proof: monitor checks its current config and bad or unknown file settings stay on bridge', async () => {
  const root = await tempDir('proof-')
  let cfg = structuredClone(DEFAULT_CONFIG)
  markProven(root, 'native-fanout', 'pass', proofKey(root))
  const monitor = new FanoutMonitor(() => cfg, root)
  assert.equal(monitor.state.path, 'native')
  cfg = { ...cfg, modes: { codexClaude: 'model' } }
  assert.equal(monitor.state.path, 'bridge')
  for (const raw of [
    '{',
    '{"version":2}',
    '{"modes":{"typo":true}}',
    '{"claims":{"graceMs":"bad"}}',
  ]) {
    writeFileSync(enginePaths(root).config, raw)
    assert.notEqual(proofKey(root).settings, settingsHash(DEFAULT_CONFIG))
  }
})

test('proof: restoring an older proof does not erase a native failure', async () => {
  const root = await tempDir('proof-')
  const key = proofKey(root)
  markProven(root, 'native-fanout', 'pass', key)
  const proof = readProof(root, 'native-fanout')!
  const monitor = new FanoutMonitor(() => DEFAULT_CONFIG, root)
  assert.equal(monitor.state.path, 'native')
  for (let i = 0; i < 3; i += 1) monitor.observeClaim(false)
  assert.equal(monitor.state.path, 'bridge')
  writeFileSync(
    join(enginePaths(root).state, 'proven.json'),
    JSON.stringify({ paths: { 'native-fanout': { ...proof, at: '2000-01-01T00:00:00.000Z' } } }),
  )
  assert.equal(monitor.state.path, 'bridge')
})

test('proof: a genuinely newer pass resets partial claim evidence', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const root = await tempDir('proof-')
  const key = proofKey(root)
  markProven(root, 'native-fanout', 'pass', key)
  const monitor = new FanoutMonitor(() => DEFAULT_CONFIG, root)
  monitor.observeClaim(false)
  monitor.observeClaim(false)
  markProven(root, 'native-fanout', 'pass again', key)
  monitor.observeClaim(false)
  assert.equal(monitor.state.path, 'native')
})

const fixtureKey = { lib: 'lib', appVersion: 'app', codexVersion: 'codex', settings: 'settings' }
const proofFixture = JSON.stringify({
  paths: {
    'native-fanout': {
      at: '2026-10-02T20:00:00.000Z',
      detail: 'passed',
      key: fixtureKey,
    },
  },
})
const degradedFixture = JSON.stringify({
  paths: {
    'native-fanout': {
      since: '2026-10-02T20:00:00.000Z',
      reason: 'failed',
    },
  },
})
const mutations = [
  (root: string) => markProven(root, 'gpt', 'new pass', fixtureKey),
  (root: string) => clearProof(root, 'native-fanout'),
  (root: string) => clearDegraded(root, 'native-fanout'),
  (root: string) => markDegraded(root, 'gpt', 'new failure'),
]

test('proof reads reject corrupt UTF-8 before native eligibility, with exact retained bytes', async () => {
  const root = await tempDir('proof-bytes-')
  mkdirSync(enginePaths(root).state)
  const path = join(enginePaths(root).state, 'proven.json')
  const bytes = Buffer.from(proofFixture.replace('passed', 'invalid X'))
  bytes[bytes.indexOf('invalid X') + 8] = 0xff
  writeFileSync(path, bytes)
  assert.equal(readProof(root, 'native-fanout'), null)
  assert.equal(isProven(root, 'native-fanout', fixtureKey), false)
  assert.ok(readFileSync(path).equals(bytes))
})

for (const [index, mutate] of mutations.entries()) {
  test(`evidence mutator ${index}: refuses either invalid baseline before artifacts and preserves bytes`, async () => {
    for (const name of ['proven.json', 'degraded.json']) {
      const valid = name === 'proven.json' ? proofFixture : degradedFixture
      const corrupt = Buffer.from(valid)
      corrupt[corrupt.indexOf(name === 'proven.json' ? 'passed' : 'failed')] = 0xff
      for (const bytes of [
        corrupt,
        Buffer.from('{'),
        Buffer.from('{"version":2,"paths":{}}'),
        Buffer.from('{"paths":{"foreign":{}}}'),
      ]) {
        const root = await tempDir('proof-mutation-')
        const state = enginePaths(root).state
        mkdirSync(state)
        writeFileSync(join(state, 'proven.json'), proofFixture)
        writeFileSync(join(state, 'degraded.json'), degradedFixture)
        writeFileSync(join(state, name), bytes)
        const before = readdirSync(state)
        assert.throws(() => mutate(root), /evidence|proven|degraded|invalid|unsupported|UTF/i)
        assert.ok(readFileSync(join(state, name)).equals(bytes))
        assert.deepEqual(readdirSync(state), before, 'no lock, SQLite or temp created on refusal')
        assert.equal(
          readFileSync(
            join(state, name === 'proven.json' ? 'degraded.json' : 'proven.json'),
            'utf8',
          ),
          name === 'proven.json' ? degradedFixture : proofFixture,
        )
      }
    }
  })
}

test('all public mutations reject dangling and directory evidence without altering it', async () => {
  for (const mutate of mutations)
    for (const name of ['proven.json', 'degraded.json']) {
      for (const shape of ['directory', 'dangling']) {
        const root = await tempDir('proof-shape-')
        mkdirSync(enginePaths(root).state)
        const path = join(enginePaths(root).state, name)
        if (shape === 'directory') mkdirSync(path)
        else symlinkSync(join(root, 'missing'), path)
        assert.throws(() => mutate(root), /evidence|proven|degraded|unsupported/i)
        assert.deepEqual(readdirSync(enginePaths(root).state), [name])
      }
    }
})

test('invalid publication arguments refuse before creating state; legitimate U+FFFD remains valid', async () => {
  const root = await tempDir('proof-input-')
  for (const action of [
    () => markProven(root, 'gpt', 'pass', { ...fixtureKey, codexVersion: null }),
    () => markDegraded(root, 'foreign' as 'gpt', 'failure'),
    () => clearProof(root, 'foreign' as 'gpt'),
    () => clearDegraded(root, 'foreign' as 'gpt'),
  ])
    assert.throws(action, /invalid|unsupported/i)
  assert.equal(existsSync(enginePaths(root).state), false)
  markProven(root, 'native-fanout', 'valid \uFFFD', fixtureKey)
  assert.equal(readProof(root, 'native-fanout')?.detail, 'valid \uFFFD')
  markDegraded(root, 'native-fanout', 'valid \uFFFD')
  assert.equal(readDegraded(root).paths['native-fanout']?.reason, 'valid \uFFFD')
  clearDegraded(root, 'native-fanout')
  markProven(root, 'native-fanout', 'new correlated pass', fixtureKey)
  assert.equal(isProven(root, 'native-fanout', fixtureKey), true)
})
