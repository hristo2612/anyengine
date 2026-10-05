import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { setConfigValue } from '../src/anyengine-config.mjs'
import { configAt } from '../src/control-install-on.mjs'
import { digest } from '../src/control-layer-state.mjs'
import {
  inspectProof,
  isProven,
  markDegraded,
  readDegraded,
  settingsHash,
} from '../src/degraded.mjs'
import { judge, type SmokeResult } from '../src/smoke.mjs'
import { ON, setup } from './helpers/flip-controller.mjs'
import { nativeReceipt } from './helpers/smoke-receipt.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
async function fixture(mode: 'agent' | 'model') {
  const s = await setup()
  setConfigValue(s.root, 'modes.codexClaude', mode)
  setConfigValue(s.root, 'router.multiAgentV1', 'true')
  const config = configAt(s.root)
  const key = {
    ...s.deps.currentSnapshot().key,
    lib: s.plan.version,
    settings: settingsHash(config),
  }
  const frozen = {
    key,
    mode,
    codeIdentity: digest(readFileSync(join(s.plan.libDir, 'install-manifest.json'))),
  }
  const receipt = nativeReceipt(
    frozen,
    join(s.root, 'smoke/run-20261001T000000Z/native'),
    config.smoke.claudeModel,
  )
  const result: SmokeResult = {
    ...frozen,
    attempt: receipt.attempt,
    at: receipt.startedAt,
    appVersion: key.appVersion,
    codexVersion: key.codexVersion,
    lib: key.lib,
    models: { claude: config.smoke.claudeModel, gpt: null },
    paths: {
      'native-fanout': { ok: true, ms: 1, detail: 'controlled completed receipt', native: receipt },
    },
  }
  return { ...s, config, result, receipt }
}
for (const mode of ['agent', 'model'] as const) {
  test(`native ${mode} receipt consumer preserves actual mode and enables only the exact accepted key`, async () => {
    const s = await fixture(mode)
    const file = join(s.root, 'proof.json')
    markDegraded(s.root, 'native-fanout', 'previous controlled failure')
    writeFileSync(file, JSON.stringify(s.result))
    assert.equal(await s.run('on', [...ON, '--native-proof', file]), 0, s.out.join(''))
    assert.match(s.out.join(''), /native pre-proof accepted/)
    assert.equal(configAt(s.root).modes.codexClaude, mode)
    assert.equal(configAt(s.root).router.multiAgentV1, true)
    assert.equal(!!readDegraded(s.root).paths['native-fanout'], false)
    assert.match(JSON.stringify(inspectProof(s.root)), /native-fanout/)
  })
}
for (const defect of ['mode', 'key', 'code', 'attempt', 'failed-child', 'spawn-only', 'cleanup']) {
  test(`native pre-proof ${defect} cannot publish native authority`, async () => {
    const s = await fixture('agent')
    if (defect === 'mode') s.receipt.mode = 'model'
    if (defect === 'key') s.receipt.key = { ...s.receipt.key, settings: 'f'.repeat(64) }
    if (defect === 'code') s.result.codeIdentity = 'f'.repeat(64)
    if (defect === 'attempt') s.result.attempt = 'different'
    if (defect === 'failed-child') s.receipt.child.success = false
    if (defect === 'spawn-only') s.receipt.spawn.status = 'inProgress'
    if (defect === 'cleanup') s.receipt.cleanup.sessions = false
    const file = join(s.root, 'proof.json')
    writeFileSync(file, JSON.stringify(s.result))
    assert.equal(await s.run('on', [...ON, '--native-proof', file]), 0, s.out.join(''))
    assert.match(s.out.join(''), /native pre-proof rejected/)
    assert.equal(configAt(s.root).router.multiAgentV1, true)
    assert.equal(isProven(s.root, 'native-fanout', s.result.key), false)
    assert.doesNotMatch(JSON.stringify(inspectProof(s.root)), /controlled-attempt/)
  })
}
test('judge uses successful detached direct terminal work, never PONG-bearing diagnostic text', async () => {
  const s = await fixture('agent')
  s.result.paths = { gpt: { ok: false, ms: 1, detail: 'via router: failed; direct: failed PONG' } }
  assert.equal(judge(s.root, s.result).routerAtFault, false)
  assert.equal(!!readDegraded(s.root).paths.gpt, true)
  s.result.paths.gpt!.routed = { success: false, attached: true }
  s.result.paths.gpt!.direct = { success: true, attached: false }
  assert.equal(judge(s.root, s.result).routerAtFault, true)
  assert.equal(!!readDegraded(s.root).paths.gpt, false)
  assert.equal(!!readDegraded(s.root).paths.router, true)
})
