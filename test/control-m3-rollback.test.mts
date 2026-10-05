import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import test, { after } from 'node:test'
import { AccountLedger } from '../src/accounts-ledger.mjs'
import { prepareOverlay } from '../src/accounts-overlay.mjs'
import { rotateAccount } from '../src/accounts-rotation.mjs'
import { accountPaths, initialAccounts, initializeAccounts } from '../src/accounts-store.mjs'
import { prepareRecovery, rollback } from '../src/control-flip-recovery.mjs'
import { digest } from '../src/control-layer-state.mjs'
import { LayerWriter, readLayers } from '../src/control-layers.mjs'
import { readM2Journal, writeM2Journal } from '../src/control-m2-recovery-state.mjs'
import { rollbackM2 } from '../src/control-m2-rollback.mjs'
import {
  prepareM2Upgrade,
  readM2Baseline,
  recordM2ControlChanges,
  setM2UpgradePhase,
} from '../src/control-m2-upgrade.mjs'
import { writeFlipMarker } from '../src/control-marker.mjs'
import { publishRecovery, shellQuote } from '../src/control-scripts.mjs'
import { scripted } from './helpers/flip-deps.mjs'
import { activate, applyClaude, setup } from './helpers/milestone-recovery.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
const view = {
  generation: 1,
  fetchedAt: 4242,
  models: [
    {
      id: 'gpt-fixture',
      label: 'GPT fixture',
      contextWindow: 272000,
      lite: false,
      efforts: ['medium'],
    },
  ],
}

async function fixture() {
  const s = await setup(false)
  assert.ok(s.plan.recoveryCommands)
  const recovery = {
    root: s.root,
    app: s.system.app,
    bundleId: 'com.openai.codex',
    codexHome: join(s.home, '.codex'),
    commands: s.plan.recoveryCommands,
  }
  publishRecovery(recovery)
  s.api.prepare(s.system, s.root, s.plan)
  const agent = applyClaude(s)
  publishRecovery(recovery)
  const m2 = readFileSync(join(s.root, 'm2-upgrade.json'))
  const stamp = '2026-10-01T00:00:00.000Z'
  const proof = {
    proven: JSON.stringify({
      paths: {
        'claude-code-gpt': {
          at: stamp,
          detail: 'M2 fixture',
          key: {
            lib: '0.1.0-m1',
            appVersion: '1.0.0',
            codexVersion: '1.0.0',
            settings: '0'.repeat(64),
          },
        },
      },
    }),
    degraded: JSON.stringify({
      paths: { 'claude-code-gpt': { since: stamp, reason: 'retained fixture warning' } },
    }),
  }
  for (const name of ['proven', 'degraded'] as const)
    writeFileSync(join(s.root, 'state', `${name}.json`), proof[name], { mode: 0o600 })
  const exec = s.system.exec
  s.system.exec = (command, args, options) =>
    args.some((v) => v.endsWith('/control/claude-code/models'))
      ? { status: 0, stdout: JSON.stringify(view), stderr: '' }
      : exec(command, args, options)
  const curl = s.plan.recoveryCommands?.curl
  assert.ok(curl)
  const health = readFileSync(curl, 'utf8')
  writeFileSync(
    curl,
    `#!/bin/bash\ncase "$*" in *'/control/claude-code/models'*) printf '%s' ${shellQuote(JSON.stringify(view))}; exit 0;; esac\n${health}`,
    { mode: 0o700 },
  )
  const baseline = prepareM2Upgrade(s.system, s.root, s.plan, 'm3')
  s.api.record = (root, layer, phase) => recordM2ControlChanges(root, layer, phase, 'm3')
  activate(s)
  return { ...s, agent, m2, proof, baseline }
}

for (const recovered of [true, false])
  test(`failed M3 restart hands off to M2 recovery without generic Off: recovered=${recovered}`, async () => {
    const s = await fixture()
    setM2UpgradePhase(s.root, 'active', 'm3')
    const layers = readFileSync(join(s.root, 'state/layers.json'))
    const current = realpathSync(join(s.root, 'lib/current'))
    const { deps } = scripted(s.system)
    deps.preflip = () => {
      throw new Error('Generic Off must not run across active M3')
    }
    const markers: unknown[] = []
    let handoffs = 0
    const exec = s.system.exec
    s.system.exec = (command, args, options) => {
      if (command !== '/bin/bash') return exec(command, args, options)
      assert.deepEqual(args, [join(s.root, 'recovery/m3/recover.sh')])
      const journal = readM2Journal(s.root, 'm3')
      assert.ok(journal)
      assert.equal(journal.transactionId, 'm3-restart-fixture')
      if (recovered) {
        journal.baseline.phase = 'rolled-back'
        writeM2Journal(s.root, journal, true, 'm3')
      }
      return { status: recovered ? 0 : 1, stdout: '', stderr: '' }
    }
    const result = await rollback(
      {
        system: s.system,
        root: s.root,
        deps,
        say: () => {},
        stop: { requested: null },
        marker: (phase, state) => {
          markers.push({ phase, state })
          const at = s.system.now().toISOString()
          writeFlipMarker(s.root, {
            id: 'm3-restart-fixture',
            op: 'restart',
            args: ['--yes'],
            pid: process.pid,
            processStart: at,
            runner: 'foreground',
            phase,
            startedAt: at,
            updatedAt: at,
            log: join(s.root, 'state/flip-m3-restart-fixture.log'),
            state: state ?? {},
          })
        },
        recoverM3: async (noRestart) => {
          assert.equal(noRestart, false)
          handoffs++
          return (await rollbackM2(s.system, s.root, { noRestart }, 'm3')).ok
        },
      },
      { force: false, waitQuietMinutes: 0 },
    )
    assert.equal(result, recovered)
    assert.equal(handoffs, 1)
    assert.deepEqual(markers, [
      {
        phase: 'rollback',
        state: {
          failureTarget: 'm3',
          m3BaselineId: basename(s.baseline.rollbackDir),
          recoveryCommand: join(s.root, 'recovery/m3/recover.sh'),
        },
      },
    ])
    assert.deepEqual(readFileSync(join(s.root, 'state/layers.json')), layers)
    assert.equal(realpathSync(join(s.root, 'lib/current')), current)
    assert.deepEqual(readFileSync(join(s.root, 'm2-upgrade.json')), s.m2)
  })

test('M3 Node-free rollback restores M2, unloaded jobs, and preserves Claude and M2 recovery authority', async () => {
  const s = await fixture()
  const settings = readFileSync(s.settings),
    agent = readFileSync(s.agent)
  const result = await rollbackM2(s.system, s.root, { noRestart: true }, 'm3')
  assert.equal(result.ok, true, result.conflicts.join('; '))
  assert.equal(realpathSync(join(s.root, 'lib/current')), s.m1Lib)
  assert.deepEqual(readFileSync(s.settings), settings)
  assert.deepEqual(readFileSync(s.agent), agent)
  assert.deepEqual(readFileSync(join(s.root, 'm2-upgrade.json')), s.m2)
  for (const name of ['proven', 'degraded'] as const)
    assert.equal(readFileSync(join(s.root, 'state', `${name}.json`), 'utf8'), s.proof[name])
  assert.equal(readM2Baseline(s.root, 'm3')?.phase, 'rolled-back')
  assert.equal(s.system.jobs.has('dev.anyengine.smoke'), false)
  assert.equal((await rollbackM2(s.system, s.root, { noRestart: true }, 'm3')).ok, true)
})

test('M3 preflights edited Claude files before changing the selected library or current routing', async () => {
  const s = await fixture()
  writeFileSync(s.agent, 'USER EDIT\n')
  const before = readFileSync(s.settings)
  const result = await rollbackM2(s.system, s.root, { noRestart: true }, 'm3')
  assert.equal(result.ok, false)
  assert.equal(realpathSync(join(s.root, 'lib/current')), s.m2Lib)
  assert.deepEqual(readFileSync(s.settings), before)
  assert.deepEqual(readFileSync(join(s.root, 'm2-upgrade.json')), s.m2)
})

test('recovery preparation records its library pin before a possible bootstrap failure', async () => {
  const s = await fixture()
  prepareRecovery(
    {
      system: s.system,
      root: s.root,
      deps: { currentSnapshot: () => ({ libDir: s.m2Lib }) } as never,
      say() {},
      stop: { requested: null },
      marker() {},
    },
    s.m2Lib,
  )
  assert.equal(
    readM2Journal(s.root, 'm3')?.expectedLayersSha256,
    digest(readFileSync(join(s.root, 'state/layers.json'))),
  )
})

test('M3 restores only its settings delta and preserves unrelated user edits', async () => {
  const s = await fixture()
  const prior = JSON.parse(readFileSync(s.settings, 'utf8'))
  const layer = readLayers(s.root).layers.find((l) => l.name === 'claude-code')
  assert.ok(layer)
  const writer = new LayerWriter(s.root, layer, 'claude-code', 'm3-update', (l, phase) =>
    recordM2ControlChanges(s.root, l, phase, 'm3'),
  )
  const after = structuredClone(prior)
  after.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-updated'
  after.modelPicker.options[0].label = 'Updated GPT'
  writer.writeFile(s.settings, JSON.stringify(after), 0o600)
  after.userPreference = 'preserve'
  writeFileSync(s.settings, JSON.stringify(after))
  const result = await rollbackM2(s.system, s.root, { noRestart: true }, 'm3')
  assert.equal(result.ok, true, result.conflicts.join('; '))
  assert.deepEqual(JSON.parse(readFileSync(s.settings, 'utf8')), {
    ...prior,
    userPreference: 'preserve',
  })
  assert.equal((await rollbackM2(s.system, s.root, { noRestart: true }, 'm3')).ok, true)
})

test('M3 restores Home with move-only credentials and leaves canonical auth inode untouched', async () => {
  const s = await fixture(),
    canonical = join(s.home, 'canonical')
  chmodSync(s.root, 0o700)
  mkdirSync(canonical, { mode: 0o700 })
  writeFileSync(join(canonical, 'auth.json'), 'FAKE_HOME', { mode: 0o600 })
  const paths = accountPaths(s.root, canonical),
    registry = initialAccounts(paths)
  mkdirSync(join(s.root, 'accounts/openai/b'), { recursive: true, mode: 0o700 })
  const auth = join(s.root, 'accounts/openai/b/auth.json')
  writeFileSync(auth, 'FAKE_B', { mode: 0o600 })
  const inode = statSync(auth).ino,
    homeInode = statSync(join(canonical, 'auth.json')).ino
  registry.accounts.push({
    id: 'b',
    label: 'B',
    kind: 'managed',
    vendorAccountId: null,
    email: null,
    planType: null,
    login: 'ready',
  })
  initializeAccounts(paths, registry)
  prepareOverlay(paths)
  const ledger = new AccountLedger(paths)
  try {
    await rotateAccount(ledger, 'b', 'manual')
  } finally {
    ledger.close()
  }
  // Bind the fixture canonical home in both private journal and public reference.
  const journal = JSON.parse(readFileSync(s.baseline.recoveryJournal, 'utf8'))
  journal.canonical = canonical
  writeFileSync(s.baseline.recoveryJournal, JSON.stringify(journal), { mode: 0o600 })
  const result = await rollbackM2(s.system, s.root, { noRestart: true }, 'm3')
  assert.equal(result.ok, true, result.conflicts.join('; '))
  const after = new AccountLedger(paths)
  try {
    assert.equal(after.registry().active, 'home')
    assert.equal(after.registry().rotation.enabled, false)
    assert.equal(after.state().phase, 'open')
  } finally {
    after.close()
  }
  assert.equal(statSync(auth).ino, inode)
  assert.equal(statSync(join(canonical, 'auth.json')).ino, homeInode)
})
