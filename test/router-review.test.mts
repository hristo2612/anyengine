import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { DEFAULT_CONFIG, enginePaths } from '../src/anyengine-config.mjs'
import {
  clearDegraded,
  isProven,
  markDegraded,
  markProven,
  proofKey,
  sameKey,
} from '../src/degraded.mjs'
import { type CatalogEntry, mergeCatalog } from '../src/router-catalog.mjs'
import { FanoutMonitor } from '../src/router-fanout.mjs'
import { routerVersion } from '../src/router-server.mjs'
import { gptEntry } from './helpers/fake-backend.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

const v2 = {
  model: 'gpt-a',
  tools: [{ name: 'collaboration.spawn_agent', parameters: { encrypted: true } }],
}

test('review 1: installed lib switch cannot prove the older running router', async () => {
  const root = await tempDir('router-review-')
  const lib = enginePaths(root).lib
  mkdirSync(join(lib, routerVersion()), { recursive: true })
  mkdirSync(join(lib, 'other-lib'))
  symlinkSync(routerVersion(), join(lib, 'current'))
  markProven(root, 'native-fanout', 'pass', proofKey(root))
  const monitor = new FanoutMonitor(() => DEFAULT_CONFIG, root)
  assert.equal(monitor.state.path, 'native')
  unlinkSync(join(lib, 'current'))
  symlinkSync('other-lib', join(lib, 'current'))
  markProven(root, 'native-fanout', 'pass on new lib', proofKey(root))
  assert.equal(monitor.state.path, 'bridge')
  unlinkSync(join(lib, 'current'))
  markProven(root, 'native-fanout', 'private probe', proofKey(root))
  assert.equal(monitor.state.path, 'native', 'no installed link is valid for a private router')
})

test('review 3: unreadable versions never match, while absent versions and a throwaway lib do', async () => {
  const root = await tempDir('router-review-')
  const known = proofKey(root)
  assert.equal(known.lib, null)
  assert.equal(sameKey(known, known), true)
  for (const field of ['appVersion', 'codexVersion'] as const) {
    const unreadable = { ...known, [field]: null }
    assert.equal(sameKey(unreadable, unreadable), false)
    assert.throws(
      () => markProven(root, 'native-fanout', 'probe failed', unreadable),
      /invalid proof/,
    )
    assert.equal(isProven(root, 'native-fanout', unreadable), false)
  }
})

test('review 5: a re-proof restarts v2 grace even when the next request is the first state read', async () => {
  const root = await tempDir('router-review-')
  let now = 0
  const monitor = new FanoutMonitor(
    () => DEFAULT_CONFIG,
    root,
    undefined,
    () => now,
  )
  const key = proofKey(root)
  markProven(root, 'native-fanout', 'first pass', key)
  assert.equal(monitor.state.path, 'native')
  monitor.noteServed(['gpt-a'])
  now += 11 * 60_000
  monitor.observeGptBody(v2)
  assert.equal(monitor.state.path, 'bridge')
  now += 11 * 60_000
  markProven(root, 'native-fanout', 'new pass', key)
  monitor.observeGptBody(v2)
  assert.equal(monitor.state.path, 'native')
  now += 10 * 60_000
  monitor.observeGptBody(v2)
  assert.equal(monitor.state.path, 'bridge', 'the renewed grace ends')
})

test('review 5: clearing degraded with a proof present restarts v2 grace', async () => {
  const root = await tempDir('router-review-')
  let now = 0
  const monitor = new FanoutMonitor(
    () => DEFAULT_CONFIG,
    root,
    undefined,
    () => now,
  )
  const key = proofKey(root)
  markDegraded(root, 'native-fanout', 'failure')
  markProven(root, 'native-fanout', 'pass', key)
  assert.equal(monitor.state.path, 'bridge')
  now += 11 * 60_000
  clearDegraded(root, 'native-fanout')
  monitor.noteServed(['gpt-a'])
  monitor.observeGptBody(v2)
  assert.equal(monitor.state.path, 'native')
})

test('review 6: existing unreadable degraded marker blocks even a valid proof', async () => {
  const root = await tempDir('router-review-')
  const key = proofKey(root)
  markProven(root, 'native-fanout', 'pass', key)
  for (const text of ['{', 'null', '{"paths":null}', '{"paths":{"native-fanout":{}}}']) {
    writeFileSync(join(enginePaths(root).state, 'degraded.json'), text)
    assert.equal(isProven(root, 'native-fanout', key), false)
    assert.equal(new FanoutMonitor(() => DEFAULT_CONFIG, root).state.path, 'bridge')
  }
})

test('review M14: a degraded marker wins even when a proof coexists', async () => {
  const root = await tempDir('router-review-')
  const key = proofKey(root)
  markDegraded(root, 'native-fanout', 'failure')
  markProven(root, 'native-fanout', 'pass awaiting marker clear', key)
  assert.equal(isProven(root, 'native-fanout', key), false)
  assert.equal(new FanoutMonitor(() => DEFAULT_CONFIG, root).state.path, 'bridge')
})

test('review 7: the upstream default is preserved regardless of its name', () => {
  for (const list of [[gptEntry('o-next', 1), gptEntry('gpt-a', 2)], [gptEntry('o-only', 1)]]) {
    const merged = mergeCatalog(list as CatalogEntry[], DEFAULT_CONFIG, 'native')
    const ranked = merged
      .filter((m) => m.visibility === 'list')
      .sort((a, b) => Number(a.priority) - Number(b.priority))
    assert.equal(ranked[0]?.slug, list[0]?.slug)
    assert.deepEqual(
      ranked.slice(1, 4).map((m) => m.slug),
      ['opus', 'sonnet', 'haiku'],
    )
  }
})

test('review 7: no listed non-AnyEngine template reports bridge', () => {
  for (const models of [
    [],
    [gptEntry('gpt-hidden', 1, { visibility: 'hide' })],
    [gptEntry('opus', 1)],
  ]) {
    const monitor = new FanoutMonitor(() => DEFAULT_CONFIG, null)
    monitor.observeCatalog(models)
    assert.equal(monitor.state.path, 'bridge')
  }
})
