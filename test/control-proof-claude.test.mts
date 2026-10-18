import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { applyClaudeLayer } from '../src/control-claude-layer.mjs'
import { applyOnFiles } from '../src/control-install.mjs'
import { digest, stateAt } from '../src/control-layer-state.mjs'
import { LayerWriter, readLayers } from '../src/control-layers.mjs'
import { proveRollback } from '../src/control-proof.mjs'
import { claudeArtifacts, claudeBaseline } from '../src/control-proof-claude.mjs'
import { createScratch, type Saved, sourceSnapshot } from '../src/control-proof-snapshot.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { strictJobs } from './helpers/flip-deps.mjs'
import { fakeLib, m0Home, pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

async function fixture() {
  const home = await m0Home(),
    root = join(home, '.anyengine')
  const system = fakeSystem(home),
    plan = fakeLib(home)
  strictJobs(system)
  applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
  mkdirSync(join(home, '.claude'))
  const settings = join(home, '.claude/settings.json')
  writeFileSync(settings, JSON.stringify({ theme: 'dark', env: { CUSTOM: 'synthetic-private' } }), {
    mode: 0o640,
  })
  applyClaudeLayer({
    home,
    root,
    writer: new LayerWriter(root, null, 'claude-code', 'semantic-proof'),
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
  const value = JSON.parse(readFileSync(settings, 'utf8'))
  value.theme = 'light'
  value.env.CUSTOM = 'synthetic-operator-edit'
  value.model = 'gpt-fixture'
  value.modelPicker.options.push({ model: 'user-row', label: 'Mine' })
  writeFileSync(settings, JSON.stringify(value))
  return { home, root, system, plan, settings }
}

test('confined Bash full/router-only and Node off prove semantic Claude recovery with operator edits', async () => {
  const f = await fixture()
  const paths = pathsFor(f.home)
  const preserved = [
    f.settings,
    join(f.root, 'state/layers.json'),
    join(f.root, 'runtime.env'),
  ].map((path) => ({ path, bytes: readFileSync(path) }))
  const proof = proveRollback(f.system, f.root, f.plan, {
    paths,
    scratchParent: await tempDir('semantic-proof-parent-'),
  })
  assert.ok(proof.ok, proof.lines.join('\n'))
  for (const route of ['bash anyengine-off:', 'node off:', 'bash anyengine-off --router-only:'])
    assert.ok(
      proof.lines.some((line) => line.includes(`${route} ok`)),
      route,
    )
  for (const original of preserved) assert.deepEqual(readFileSync(original.path), original.bytes)
})

test('semantic proof admits only one exact private output blob and rejects hash/mode/path or extra artifacts', async () => {
  const f = await fixture()
  const source = sourceSnapshot(f.system, f.root, f.plan, pathsFor(f.home))
  const scratch = createScratch(source, join(await tempDir('semantic-artifact-'), 'home'))
  const prior = readLayers(scratch.root).layers
  const layer = prior.find((entry) => entry.name === 'claude-code')
  assert.ok(layer?.claudeCode)
  const target = layer.claudeCode.settingsTarget
  const expected = new Map<string, Saved>()
  claudeBaseline(scratch, expected)
  const wanted = expected.get(target)?.state
  assert.ok(wanted)
  // The expected restore preserves unrelated env/theme/row edits and removes
  // the owned default. Compute these synthetic oracle bytes independently.
  const current = JSON.parse(readFileSync(target, 'utf8'))
  delete current.model
  delete current.env.ANTHROPIC_BASE_URL
  delete current.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  delete current.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS
  current.modelPicker.options = [{ model: 'user-row', label: 'Mine' }]
  const bytes = Buffer.from(`${JSON.stringify(current, null, 2)}\n`)
  assert.equal(wanted.sha, digest(bytes))
  const before = new Map([[target, JSON.stringify(stateAt(target))]])
  const path = join(layer.rollbackDir, 'claude-off-00000000-0000-0000-0000-000000000001.blob')
  const after = new Map([[path, 'file']])
  writeFileSync(path, bytes, { mode: 0o600 })
  assert.deepEqual(claudeArtifacts(prior, expected, before, after), {
    allowed: new Set([path]),
    differences: [],
  })
  chmodSync(path, 0o644)
  assert.equal(claudeArtifacts(prior, expected, before, after).allowed.size, 0)
  chmodSync(path, 0o600)
  writeFileSync(path, 'unowned bytes')
  assert.equal(claudeArtifacts(prior, expected, before, after).allowed.size, 0)
  writeFileSync(path, bytes)
  const extra = join(layer.rollbackDir, 'extra.blob')
  writeFileSync(extra, bytes, { mode: 0o600 })
  const wrongPath = claudeArtifacts(prior, expected, before, new Map([[extra, 'file']]))
  assert.equal(wrongPath.allowed.size, 0)
  const second = join(layer.rollbackDir, `${wanted.sha}.bytes`)
  writeFileSync(second, bytes, { mode: 0o600 })
  assert.ok(
    claudeArtifacts(
      prior,
      expected,
      before,
      new Map([
        [path, 'file'],
        [second, 'file'],
      ]),
    ).differences.length > 0,
  )
})
