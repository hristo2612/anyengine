import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSandboxUpstream, runBridgeExec } from '../src/bridge-exec.mjs'
import { assertChildCanEnforceReads } from '../src/bridge-input.mjs'
import { inheritFromCaller } from '../src/claude-project-guard.mjs'
import {
  applyCodexParams,
  DEFAULT_POSTURE,
  decide,
  isUnrestricted,
  parseStoredPosture,
  reach,
  sandboxedOutcome,
} from '../src/posture.mjs'
import { decideClaudeTool, shellMode, toClaudeLaunch } from '../src/posture-claude.mjs'

const ctx = { cwd: '/work', tmpdir: '/tmp', slashTmp: '/tmp' }
const restrictions = [
  { permissions: 'team-profile' },
  { permissionProfile: 'team-profile' },
  { permissionProfile: { id: 'team-profile' } },
  { activePermissionProfile: { id: 'team-profile' } },
  { permissions: { filesystem: { deny_read: ['/private/**'] } } },
  { 'permissions.filesystem.deny_read': ['/private/**'] },
  { permissionProfile: { fileSystem: [{ path: '/private/**', access: 'deny' }] } },
]

test('custom profiles and deny-read requirements prohibit every Claude read and shell path', () => {
  for (const params of restrictions) {
    const parent = applyCodexParams(DEFAULT_POSTURE, params)
    assert.equal(decide(parent, { kind: 'read' }, ctx), 'deny', JSON.stringify(params))
    for (const posture of [
      parent,
      { ...parent, plan: true },
      { ...parent, fileSystem: { kind: 'full-access' as const } },
      applyCodexParams(parent, { permissions: ':danger-full-access' }),
      parseStoredPosture(JSON.stringify(parent))!,
      inheritFromCaller(DEFAULT_POSTURE, parent),
    ]) {
      assert.ok(posture)
      assert.equal(reach(posture, { kind: 'read' }, ctx), 'deny')
      assert.equal(sandboxedOutcome(posture), 'deny')
      assert.equal(isUnrestricted(posture), false)
      for (const sandboxExec of [false, true]) {
        assert.equal(shellMode(posture, sandboxExec), 'none')
        const launch = toClaudeLaunch(posture, { sandboxExec })
        for (const tool of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'Bash', 'Monitor']) {
          assert.ok(launch.disallowedTools.includes(tool), tool)
          assert.equal(decideClaudeTool(posture, tool, {}, ctx), 'deny', tool)
        }
        assert.equal(decideClaudeTool(posture, 'mcp__anyengine__exec', {}, ctx), 'deny')
      }
    }
  }
})

test('built-in profiles retain reads', () => {
  for (const permissions of [':read-only', ':workspace', ':danger-full-access']) {
    const posture = applyCodexParams(DEFAULT_POSTURE, { permissions })
    assert.equal(decide(posture, { kind: 'read' }, ctx), 'allow')
    assert.ok(!toClaudeLaunch(posture, { sandboxExec: true }).disallowedTools.includes('Read'))
  }
})

test('read-restricted delegation rejects every unsupported engine, including locally routed Grok', () => {
  const posture = applyCodexParams(DEFAULT_POSTURE, { permissions: 'private-paths' })
  const local = { routeForModel: () => 'local' as const }
  assert.doesNotThrow(() => assertChildCanEnforceReads(local, posture, 'opus'))
  assert.throws(() => assertChildCanEnforceReads(local, posture, 'grok-4.6'), /restricts reads/)
  assert.throws(() => assertChildCanEnforceReads(local, posture, 'gpt-5.6-sol'), /restricts reads/)
  assert.throws(
    () => assertChildCanEnforceReads({ routeForModel: () => 'upstream' }, posture, 'unknown'),
    /restricts reads/,
  )
})

test('read-restricted bridge exec refuses before any command reaches the upstream sandbox', async () => {
  const posture = applyCodexParams(DEFAULT_POSTURE, { permissions: 'private-paths' })
  let calls = 0
  registerSandboxUpstream({
    running: true,
    request: async () => {
      calls += 1
      return {}
    },
  })
  try {
    await assert.rejects(
      runBridgeExec(
        {
          id: 'restricted',
          owner: 'local',
          cwd: '/work',
          model: 'opus',
          posture,
          activeTurnId: null,
        },
        { command: 'cat /private/file' },
      ),
    )
    assert.equal(calls, 0)
  } finally {
    registerSandboxUpstream(null)
  }
})
