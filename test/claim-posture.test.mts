import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import test, { after } from 'node:test'
import { claimPosture, DEFAULT_POSTURE, noLooser, type Posture, reach } from '../src/posture.mjs'
import { toClaudeLaunch } from '../src/posture-claude.mjs'
import { postureTree } from './helpers/postures.mjs'

const tree = postureTree()
const { ctx } = tree
after(() => rmSync(tree.base, { recursive: true, force: true }))

test('claim posture: tightening trust cannot restore workspace trust through tighter file permissions', () => {
  const child: Posture = {
    ...DEFAULT_POSTURE,
    fileSystem: { kind: 'read-only' },
    approval: 'never',
    trust: 'trusted',
  }
  const parent: Posture = {
    ...DEFAULT_POSTURE,
    approval: 'never',
    trust: 'untrusted',
    fileSystem: {
      kind: 'workspace-write',
      writableRoots: [],
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  }
  assert.equal(noLooser(child, parent, ctx), false, 'trusted workspace is looser than untrusted')
  assert.equal(noLooser(parent, child, ctx), false, 'writable workspace is looser than read-only')
  const got = claimPosture(child, parent, ctx)
  assert.equal(got.trust, 'untrusted')
  assert.equal(toClaudeLaunch(got, { sandboxExec: true }).trustWorkspace, false)
})

test('claim posture: plan mode cannot loosen restricted reads and unknown claims cannot read', () => {
  const restricted: Posture = { ...DEFAULT_POSTURE, readRestricted: true }
  const planning: Posture = { ...DEFAULT_POSTURE, plan: true }
  assert.equal(noLooser(planning, restricted, ctx), false)
  assert.equal(reach(claimPosture(restricted, planning, ctx), { kind: 'read' }, ctx), 'deny')
  assert.equal(reach(claimPosture(null, null, ctx), { kind: 'read' }, ctx), 'deny')
})

test('claim posture: unknown and incomparable fallbacks deny restricted reads', () => {
  assert.equal(reach(claimPosture(null, null, ctx), { kind: 'read' }, ctx), 'deny')
})
