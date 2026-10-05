import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { applyClaudeLayer } from '../src/control-claude-layer.mjs'
import { applyOnFiles } from '../src/control-install.mjs'
import { LayerWriter, readLayers } from '../src/control-layers.mjs'
import { proveRollback } from '../src/control-proof.mjs'
import { createScratch, sourceSnapshot } from '../src/control-proof-snapshot.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { strictJobs } from './helpers/flip-deps.mjs'
import { fakeLib, m0Home, pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

test('scratch retains previous partial Node cache backups as exact opaque recovery evidence', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const plan = fakeLib(home)
  const system = fakeSystem(home)
  strictJobs(system)
  applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
  const layer = readLayers(root).layers.find((layer) => layer.name === 'router')
  assert.ok(layer)
  const directory = join(layer.rollbackDir, 'cache-prior-partial')
  mkdirSync(directory, { mode: 0o700 })
  const path = join(directory, 'models_cache.json')
  const bytes = Buffer.from([0xff, 0x7b])
  writeFileSync(path, bytes, { mode: 0o600 })
  const source = sourceSnapshot(system, root, plan, pathsFor(home))
  assert.deepEqual(source.files.get(path)?.bytes, bytes)
  const scratch = createScratch(source, join(await tempDir('snapshot-'), 'home'))
  assert.deepEqual(readFileSync(scratch.map(path)), bytes)
  assert.deepEqual(readFileSync(path), bytes)
})

test('scratch relocates every Claude descriptor path before semantic recovery', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const plan = fakeLib(home)
  const system = fakeSystem(home)
  strictJobs(system)
  applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
  applyClaudeLayer({
    root,
    home,
    writer: new LayerWriter(root, null, 'claude-code', 'proof-claude'),
    catalog: {
      generation: 1,
      fetchedAt: 0,
      models: [
        {
          id: 'gpt-fixture',
          label: 'Fixture',
          lite: false,
          contextWindow: 272000,
          efforts: ['medium'],
        },
      ],
    },
    baseUrl: 'http://127.0.0.1:18790',
    haiku: 'claude-haiku-4-5-20251001',
  })
  const settings = join(home, '.claude/settings.json')
  const before = readFileSync(settings)
  const source = sourceSnapshot(system, root, plan, pathsFor(home))
  const scratch = createScratch(source, join(await tempDir('cp-'), 'home'))
  const descriptor = readLayers(scratch.root).layers.find(
    (layer) => layer.name === 'claude-code',
  )?.claudeCode
  assert.ok(descriptor)
  assert.equal(descriptor.settingsTarget, scratch.map(settings))
  assert.deepEqual(
    descriptor.touchedPaths,
    readLayers(root).layers.find((layer) => layer.name === 'claude-code')?.claudeCode?.touchedPaths,
  )
  assert.deepEqual(readFileSync(settings), before)
  const proof = proveRollback(system, root, plan, {
    paths: pathsFor(home),
    scratchParent: await tempDir('cp-'),
  })
  assert.ok(proof.ok, proof.lines.join('\n'))
  assert.deepEqual(readFileSync(settings), before)
})
