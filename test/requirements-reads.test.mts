import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { inheritFromCaller } from '../src/claude-project-guard.mjs'
import { AppModelPick, ConfigWrites } from '../src/config-writes.mjs'
import {
  applyCodexParams,
  childStart,
  contextPosture,
  DEFAULT_POSTURE,
  postureFields,
  threadPosture,
} from '../src/posture.mjs'
import { toClaudeLaunch } from '../src/posture-claude.mjs'
import {
  localReadRestricted,
  observeRequirementSources,
  preferenceResult,
} from '../src/requirements-reads.mjs'
import { SessionStore } from '../src/store.mjs'
import { rowWithPosture } from '../src/store-rows.mjs'
import type { ThreadRecord } from '../src/types.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

test('local requirement sources restrict every thread and refresh without a wire field', async () => {
  const root = await tempDir('requirements-reads-')
  const file = join(root, 'requirements.toml')
  const mdm = join(root, 'mdm-base64')
  const saved = { ...process.env }
  process.env.ANYENGINE_REQUIREMENTS_FILE = file
  process.env.ANYENGINE_MDM_REQUIREMENTS_FILE = mdm
  try {
    const posture = () =>
      threadPosture({
        posture: applyCodexParams(DEFAULT_POSTURE, { permissions: ':workspace' }),
        approvalPolicy: null,
        sandboxMode: null,
      })
    assert.ok(!posture().readRestricted, 'absent sources do not impose a policy')
    writeFileSync(file, 'allowed_approval_policies = ["never"]\n')
    assert.ok(!posture().readRestricted)
    for (const toml of [
      '[permissions.filesystem]\ndeny_read = ["/private/**"]',
      'permissions.filesystem.deny_read = ["/private/**"]',
      '["permissions"."filesystem"]\n"deny_read" = []',
      'permissions = { filesystem = { deny_read = ["/private/**"] } }',
      'permissions.filesystem.deny_read = [',
    ]) {
      writeFileSync(file, toml)
      assert.equal(posture().readRestricted, true, toml)
      assert.equal(threadPosture(null).readRestricted, true)
      assert.equal(
        threadPosture({ posture: DEFAULT_POSTURE, approvalPolicy: null, sandboxMode: null })
          .readRestricted,
        true,
      )
      assert.equal(
        contextPosture({
          posture: DEFAULT_POSTURE,
          approvalPolicy: null,
          sandboxMode: null,
          planMode: false,
        }).readRestricted,
        true,
      )
      assert.ok(
        toClaudeLaunch(DEFAULT_POSTURE, { sandboxExec: true }).disallowedTools.includes('Read'),
      )
    }
    writeFileSync(file, '# no filesystem restriction\n')
    assert.ok(!posture().readRestricted)
    writeFileSync(
      mdm,
      Buffer.from('[permissions.filesystem]\ndeny_read = ["/secret"]\n').toString('base64'),
    )
    assert.equal(posture().readRestricted, true, 'MDM decoded requirement')
    writeFileSync(mdm, Buffer.from('allowed_sandbox_modes = ["read-only"]').toString('base64'))
    assert.ok(!posture().readRestricted)
    for (const value of ['not base64!', Buffer.from('invalid = [').toString('base64')]) {
      writeFileSync(mdm, value)
      assert.equal(posture().readRestricted, true, 'invalid MDM fails closed')
    }
    writeFileSync(mdm, '')
    const unreadable = join(root, 'directory')
    mkdirSync(unreadable)
    process.env.ANYENGINE_REQUIREMENTS_FILE = unreadable
    assert.equal(posture().readRestricted, true, 'unreadable local source fails closed')
    process.env.ANYENGINE_REQUIREMENTS_FILE = file
    process.env.ANYENGINE_MDM_REQUIREMENTS_FILE = unreadable
    assert.equal(posture().readRestricted, true, 'unreadable MDM source fails closed')
  } finally {
    process.env = saved
  }
})

test('MDM query absence is distinguished from failures and decoded before TOML parsing', async () => {
  const root = await tempDir('requirements-mdm-')
  const env = {
    ANYENGINE_REQUIREMENTS_FILE: join(root, 'absent'),
    ANYENGINE_MANAGED_CONFIG_FILE: join(root, 'absent-legacy'),
    ANYENGINE_MDM_CONFIG_FILE: join(root, 'absent-mdm-config'),
  }
  assert.equal(
    localReadRestricted(env, () => null),
    false,
  )
  assert.equal(
    localReadRestricted(env, () =>
      Buffer.from('[permissions.filesystem]\ndeny_read=["/secret"]').toString('base64'),
    ),
    true,
  )
  assert.equal(
    localReadRestricted(env, () => {
      throw new Error('unreadable')
    }),
    true,
  )
  assert.equal(
    preferenceResult({
      status: 1,
      stdout: '',
      stderr:
        'The domain/default pair of (com.openai.codex, requirements_toml_base64) does not exist',
    }),
    null,
  )
  assert.equal(preferenceResult({ status: 0, stdout: ' YQ==\n', stderr: '' }), 'YQ==')
  for (const result of [
    { status: 1, stdout: '', stderr: 'permission denied' },
    { status: null, stdout: '', stderr: '', error: new Error('timeout') },
    {
      status: 2,
      stdout: '',
      stderr:
        'The domain/default pair of (com.openai.codex, requirements_toml_base64) does not exist',
    },
  ])
    assert.throws(() => preferenceResult(result))
})

test('transient local failure recovers through stored rows, forks and inherited children', async () => {
  const root = await tempDir('requirements-recovery-')
  const file = join(root, 'requirements.toml')
  const saved = { ...process.env }
  const store = new SessionStore(join(root, 'state.sqlite'))
  process.env.ANYENGINE_REQUIREMENTS_FILE = file
  process.env.ANYENGINE_MDM_REQUIREMENTS_FILE = join(root, 'absent-mdm')
  try {
    const full = applyCodexParams(DEFAULT_POSTURE, { permissions: ':danger-full-access' })
    const row: ThreadRecord = {
      id: 'parent',
      sessionId: 'parent',
      forkedFromId: null,
      preview: '',
      name: null,
      archived: false,
      cwd: root,
      model: 'sonnet',
      reasoningEffort: null,
      modelProvider: 'claude-code',
      claudeSessionId: null,
      source: 'appServer',
      createdAt: 0,
      updatedAt: 0,
      status: { type: 'idle' },
      runtimeBackend: 'claude',
      codexSessionId: null,
      ephemeral: false,
      threadSource: 'user',
      agentRole: null,
      agentNickname: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      ...postureFields(full),
    }
    writeFileSync(file, 'invalid = [')
    assert.equal(threadPosture(row).readRestricted, true)
    const start = childStart({ posture: threadPosture(row), cwd: root }, root)
    const cases = [
      applyCodexParams(full, {}),
      rowWithPosture(row, {}).posture,
      postureFields({ ...threadPosture(row), plan: true }).posture,
      inheritFromCaller(full, threadPosture(row)),
      inheritFromCaller(start.posture, threadPosture(row)),
      threadPosture(row),
    ]
    for (const [i, posture] of cases.entries()) {
      if (i < 5) assert.ok(!posture.readRestricted, `boundary ${i} returned a local overlay`)
      store.upsertThread({ ...row, id: String(i), posture })
      assert.equal(threadPosture(store.getThread(String(i))).readRestricted, true)
    }
    const wire = applyCodexParams(threadPosture(row), { permissions: 'restricted-wire-profile' })
    store.upsertThread({ ...row, id: 'wire', posture: wire })
    writeFileSync(file, '# recovered')
    for (const [i] of cases.entries()) {
      const recovered = threadPosture(store.getThread(String(i)))
      assert.ok(!recovered.readRestricted, `boundary ${i} persisted transient local policy`)
      assert.ok(!toClaudeLaunch(recovered, { sandboxExec: true }).disallowedTools.includes('Read'))
    }
    assert.equal(threadPosture(store.getThread('wire')).readRestricted, true)
  } finally {
    store.close()
    process.env = saved
  }
})

test('legacy managed file and MDM sources fail closed when present and recover when absent', async () => {
  const root = await tempDir('requirements-legacy-')
  const legacy = join(root, 'managed_config.toml')
  const mdm = join(root, 'config-base64')
  const env = {
    ANYENGINE_REQUIREMENTS_FILE: join(root, 'absent'),
    ANYENGINE_MDM_REQUIREMENTS_FILE: join(root, 'absent-mdm'),
    ANYENGINE_MANAGED_CONFIG_FILE: legacy,
    ANYENGINE_MDM_CONFIG_FILE: mdm,
  }
  assert.equal(localReadRestricted(env), false)
  writeFileSync(legacy, '# present even without recognized fields')
  assert.equal(localReadRestricted(env), true)
  env.ANYENGINE_MANAGED_CONFIG_FILE = join(root, 'absent-legacy')
  assert.equal(localReadRestricted(env), false)
  writeFileSync(mdm, Buffer.from('sandbox_mode="read-only"').toString('base64'))
  assert.equal(localReadRestricted(env), true)
})

test('config layer provenance restricts enterprise and legacy sources until a complete clean snapshot', async () => {
  const root = await tempDir('requirements-layers-')
  const writes = new ConfigWrites(
    { request: async () => ({}) },
    new AppModelPick(join(root, 'pick.json')),
  )
  try {
    for (const type of [
      'enterpriseManaged',
      'compositeEnterpriseManaged',
      'cloudConfigFragment',
      'legacyManagedConfigTomlFromFile',
      'legacyManagedConfigTomlFromMdm',
    ]) {
      await writes.mergeRead(
        Promise.resolve({ origins: { model: { name: { type } } } }),
        Promise.resolve({}),
      )
      assert.equal(threadPosture(null).readRestricted, true, type)
      await writes.mergeRead(Promise.resolve({ origins: {} }), Promise.resolve({}))
      assert.equal(
        threadPosture(null).readRestricted,
        true,
        'partial snapshot cannot clear a known source',
      )
      await writes.mergeRead(
        Promise.resolve({ layers: [{ name: { type: 'user' } }] }),
        Promise.resolve({}),
      )
      assert.ok(!threadPosture(null).readRestricted, 'complete snapshot refreshes detected sources')
    }
  } finally {
    observeRequirementSources({ layers: [] })
  }
})
