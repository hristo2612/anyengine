import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { applyOnFiles } from '../src/control-install.mjs'
import { readLayers } from '../src/control-layers.mjs'
import { proveRollback } from '../src/control-proof.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { strictJobs } from './helpers/flip-deps.mjs'
import { fakeLib, m0Home, pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const owned = JSON.stringify({
  client_version: 'fixture',
  models: [{ slug: 'sonnet', description: 'Claude Sonnet, via AnyEngine' }],
})
test('a live vendor cache refresh does not invalidate independently copied rollback proofs', async () => {
  const home = await m0Home()
  const path = join(home, '.codex/models_cache.json')
  writeFileSync(path, owned)
  const refreshed = JSON.stringify({ models: [{ slug: 'gpt-fresh' }] })
  const result = proveRollback(fakeSystem(home), join(home, '.anyengine'), fakeLib(home), {
    paths: pathsFor(home),
    scratchParent: await tempDir('proof-parent-'),
    afterOn: () => writeFileSync(path, refreshed),
  })
  assert.ok(result.ok, result.lines.join('\n'))
  assert.equal(readFileSync(path, 'utf8'), refreshed)
})

for (const kind of ['owned', 'unrelated'])
  test(`${kind} cache follows each actual recovery route without losing source bytes`, async () => {
    const home = await m0Home()
    const path = join(home, '.codex/models_cache.json')
    const bytes = kind === 'owned' ? owned : JSON.stringify({ models: [{ slug: 'gpt-fixture' }] })
    writeFileSync(path, bytes, { mode: 0o640 })
    const result = proveRollback(fakeSystem(home), join(home, '.anyengine'), fakeLib(home), {
      paths: pathsFor(home),
      scratchParent: await tempDir('proof-parent-'),
    })
    assert.ok(result.ok, result.lines.join('\n'))
    assert.equal(readFileSync(path, 'utf8'), bytes)
  })

for (const mutation of ['changed-cache', 'extra-backup', 'missing-cleanup'])
  test(`owned cache proof names ${mutation} and cannot certify the changed scratch state`, async () => {
    const home = await m0Home()
    writeFileSync(join(home, '.codex/models_cache.json'), owned)
    const result = proveRollback(fakeSystem(home), join(home, '.anyengine'), fakeLib(home), {
      paths: pathsFor(home),
      scratchParent: await tempDir('proof-parent-'),
      afterOn: (scratch) => {
        if (mutation === 'changed-cache')
          writeFileSync(join(scratch, '.codex/models_cache.json'), `${owned} `)
        if (mutation === 'missing-cleanup')
          writeFileSync(join(scratch, '.anyengine/recovery/anyengine-off'), '#!/bin/bash\nexit 0\n')
        if (mutation === 'extra-backup') {
          const layer = readLayers(join(scratch, '.anyengine')).layers.find(
            (layer) => layer.name === 'router',
          )
          assert.ok(layer)
          const extra = join(layer.rollbackDir, 'cache-extra')
          mkdirSync(extra, { mode: 0o700 })
          writeFileSync(join(extra, 'models_cache.json'), owned, { mode: 0o600 })
        }
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.lines.join('\n'), /models_cache|cache backup/)
    assert.equal(readFileSync(join(home, '.codex/models_cache.json'), 'utf8'), owned)
  })

test('an existing Bash cache destination stays intact and makes that recovery truthfully refuse', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const plan = fakeLib(home)
  const system = fakeSystem(home)
  strictJobs(system)
  applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
  const layer = readLayers(root).layers.find((layer) => layer.name === 'router')
  assert.ok(layer)
  const backup = join(layer.rollbackDir, 'models_cache.json')
  writeFileSync(backup, 'older retained cache evidence', { mode: 0o600 })
  writeFileSync(join(home, '.codex/models_cache.json'), owned)
  const result = proveRollback(system, root, plan, {
    paths: pathsFor(home),
    scratchParent: await tempDir('proof-parent-'),
  })
  assert.equal(result.ok, false)
  assert.match(result.lines.join('\n'), /cache backup already exists/)
  assert.equal(readFileSync(backup, 'utf8'), 'older retained cache evidence')
})
