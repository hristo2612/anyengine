import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { setConfigValue } from '../src/anyengine-config.mjs'
import { updateSchedule } from '../src/control-commands.mjs'
import {
  type Compatibility,
  checkStartupCompatibility,
  publishState,
  readUpdateState,
  stateMutation,
} from '../src/startup-compat.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const load = () => import('../src/update-watch.mjs')
async function setup() {
  const root = await tempDir('update-watch-')
  const system = fakeSystem(root)
  const at = '2026-10-03T12:00:00Z'
  system.now = () => new Date(at)
  system.procs = [{ pid: process.pid, ppid: 1, processStart: at, command: 'test owner' }]
  const compatibility: Compatibility = {
    format: 1,
    lib: '/lib@v1',
    suite: 'a'.repeat(64),
    schemaHash: 'b'.repeat(64),
    codexPath: '/fake/codex',
    codexVersion: '0.159.0',
    binaryStamp: 'stamp',
    checkedAt: at,
  }
  let passes = false
  let verifies = 0
  let rollbacks = 0
  const deps = {
    selection: () => ({ path: compatibility.codexPath, identity: compatibility.binaryStamp }),
    preflipStaged: () => true,
    compatibility: async () => ({ ...compatibility }),
    settings: () => 'settings-v1',
    verify: async () => {
      verifies++
      return { ok: passes, reason: passes ? '' : 'mandatory GPT failed' }
    },
    rollback: async () => {
      rollbacks++
      return 0
    },
    recheck: () => {},
  }
  return {
    root,
    system,
    deps,
    compatibility,
    pass: () => {
      passes = true
    },
    counts: () => [verifies, rollbacks],
  }
}
test('failed update is retryable, backoff bounds storms, only full pass clears the block', async () => {
  const { watchOnce } = await load()
  const h = await setup()
  assert.equal((await watchOnce(h.system, h.root, h.deps)).verified, 'failed')
  assert.deepEqual(h.counts(), [1, 1])
  assert.equal(existsSync(join(h.root, 'state/known-good.json')), false)
  const failed = readUpdateState(h.root)
  assert.match(failed.block!.reason, /mandatory GPT/)
  assert.equal((await watchOnce(h.system, h.root, h.deps)).verified, 'pending')
  assert.deepEqual(h.counts(), [1, 1])
  h.pass()
  assert.equal((await watchOnce(h.system, h.root, h.deps, { force: true })).verified, 'passed')
  assert.equal(readUpdateState(h.root).block, null)
  assert.equal((await watchOnce(h.system, h.root, h.deps)).verified, 'unchanged')
  assert.deepEqual(h.counts(), [2, 1])
  assert.equal(h.system.notifications.filter((n) => /waiting/.test(n.message)).length, 1)
})
test('startup fixture success cannot clear a failed mandatory update', async () => {
  const { watchOnce } = await load()
  const h = await setup()
  await watchOnce(h.system, h.root, h.deps)
  const before = readFileSync(join(h.root, 'state/update-watch.json'))
  const result = await checkStartupCompatibility(h.root, {
    identity: () => ({ lib: h.compatibility.lib, suite: h.compatibility.suite }),
    selected: () => h.compatibility.codexPath,
    stamp: () => h.compatibility.binaryStamp,
    observe: () => h.compatibility,
    fixtures: () => {},
    now: h.system.now,
  })
  assert.equal(result.kind, 'fallback')
  assert.deepEqual(readFileSync(join(h.root, 'state/update-watch.json')), before)
})
test('invalid byte attempts cannot reset backoff or be overwritten', async () => {
  const { watchOnce } = await load()
  const h = await setup()
  mkdirSync(join(h.root, 'state'))
  const file = join(h.root, 'state/update-watch.json')
  const bytes = Buffer.from('{"staged":"\xff"}', 'latin1')
  writeFileSync(file, bytes)
  assert.equal((await watchOnce(h.system, h.root, h.deps)).verified, 'failed')
  assert.deepEqual(readFileSync(file), bytes)
  assert.deepEqual(h.counts(), [0, 0])
})
test('same-version lib or schema change re-verifies, publication drift preserves known-good', async () => {
  const { watchOnce } = await load()
  const h = await setup()
  h.pass()
  await watchOnce(h.system, h.root, h.deps)
  const file = join(h.root, 'state/known-good.json')
  const before = readFileSync(file)
  h.compatibility.schemaHash = 'c'.repeat(64)
  h.deps.recheck = () => {
    throw new Error('binary replaced')
  }
  assert.equal((await watchOnce(h.system, h.root, h.deps)).verified, 'failed')
  assert.deepEqual(readFileSync(file), before)
})
test('a live verifier prevents overlapping mandatory work and a failed rollback stays blocked', async () => {
  const { watchOnce } = await load()
  const h = await setup()
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  h.deps.verify = async () => {
    entered()
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return { ok: false, reason: 'mandatory failed' }
  }
  h.deps.rollback = async () => 1
  const first = watchOnce(h.system, h.root, h.deps)
  await started
  assert.equal((await watchOnce(h.system, h.root, h.deps, { force: true })).verified, 'pending')
  release()
  const result = await first
  assert.equal(result.verified, 'failed')
  assert.match(result.reason!, /rollback/)
  assert.ok(readUpdateState(h.root).block)
})
test('a newly published incumbent is checked under the stable gate for force and changed identity', async () => {
  const { watchOnce } = await load()
  for (const force of [true, false]) {
    const h = await setup()
    h.deps.preflipStaged = () => false
    const stale = [...h.system.procs]
    const owner = {
      pid: 918203,
      ppid: 1,
      processStart: 'new-owner-start',
      command: 'controlled incumbent verifier',
    }
    const record = {
      format: 1,
      staged: null,
      attempt: {
        identity: 'e'.repeat(64),
        count: 1,
        nextAt: '2026-10-03T13:00:00Z',
        owner: { pid: owner.pid, start: owner.processStart, token: 'incumbent-token' },
      },
      block: null,
    }
    let protectedReads = 0
    h.deps.selection = () => {
      stateMutation(h.root, () => publishState(join(h.root, 'state/update-watch.json'), record))
      return { path: h.compatibility.codexPath, identity: 'different-identity' }
    }
    h.system.processes = () => {
      const lock = join(h.root, 'state/startup-update.lock')
      const held = existsSync(lock) && readFileSync(lock, 'utf8').startsWith(`${process.pid} `)
      if (held) protectedReads++
      // The caller's earlier view omitted this owner; only a protected fresh read sees it.
      return held ? [...stale, owner] : stale
    }
    assert.equal((await watchOnce(h.system, h.root, h.deps, { force })).verified, 'pending')
    assert.equal(protectedReads, 1)
    assert.deepEqual(h.counts(), [0, 0])
    const incumbent = readUpdateState(h.root).attempt?.owner
    assert.ok(incumbent)
    assert.equal(incumbent.token, 'incumbent-token')
    h.system.processes = () => {
      throw new Error('unknown process table')
    }
    assert.equal((await watchOnce(h.system, h.root, h.deps, { force: true })).verified, 'failed')
    assert.deepEqual(h.counts(), [0, 0])
    assert.deepEqual(readUpdateState(h.root).attempt?.owner, incumbent)
  }
})

test('disabled periodic smoke still verifies explicit scheduled updates and force retries without weakening failures', async () => {
  const h = await setup()
  setConfigValue(h.root, 'smoke.enabled', 'false')
  const out: string[] = []
  const say = (value: string) => {
    out.push(value)
  }
  assert.equal(
    await updateSchedule(h.system, h.root, say, h.deps, { force: false, scheduled: true }),
    1,
  )
  h.pass()
  assert.equal(
    await updateSchedule(h.system, h.root, say, h.deps, { force: true, scheduled: true }),
    0,
  )
  assert.deepEqual(h.counts(), [2, 1])
  assert.match(out.join(''), /scheduled smoke disabled/)
})
test('invalid UTF-8 smoke blocks scheduler mutations; valid replacement character stays data', async () => {
  const h = await setup()
  mkdirSync(join(h.root, 'state'))
  const file = join(h.root, 'state/smoke.json')
  const raw = Buffer.from('{"reason":"\xff"}', 'latin1')
  writeFileSync(file, raw)
  await assert.rejects(
    updateSchedule(h.system, h.root, () => {}, h.deps, { force: true, scheduled: true }),
  )
  assert.deepEqual(readFileSync(file), raw)
  assert.deepEqual(h.counts(), [0, 0])
  h.deps.verify = async () => ({ ok: false, reason: 'valid \ufffd diagnostic' })
  const { watchOnce } = await load()
  assert.equal((await watchOnce(h.system, h.root, h.deps)).verified, 'failed')
  assert.match(readUpdateState(h.root).block!.reason, /\ufffd/)
})
test('fixture rejection in the full update lane remains bounded and cannot strand an active owner after rollback throws', async () => {
  const h = await setup()
  h.deps.compatibility = async () => {
    throw new Error('fixture mismatch')
  }
  h.deps.rollback = async () => {
    throw new Error('busy app')
  }
  const { watchOnce } = await load()
  assert.equal((await watchOnce(h.system, h.root, h.deps)).verified, 'failed')
  assert.equal(readUpdateState(h.root).attempt?.owner, null)
  assert.ok(readUpdateState(h.root).block)
  assert.equal((await watchOnce(h.system, h.root, h.deps)).verified, 'pending')
})
