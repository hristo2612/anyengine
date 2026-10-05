import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { applyOnFiles } from '../src/control-install.mjs'
import { readLayers } from '../src/control-layers.mjs'
import { readFlipMarker, writeFlipMarker } from '../src/control-marker.mjs'
import { ON, setup } from './helpers/flip-controller.mjs'
import { pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
const restarts = (s: Awaited<ReturnType<typeof setup>>) =>
  s.system.calls.filter((c) => ['quitApp', 'openApp'].includes(c))
async function installed() {
  const s = await setup()
  s.system.running = false
  applyOnFiles(s.system, s.root, s.plan, { dryRun: false, paths: pathsFor(s.home) })
  s.system.openApp()
  s.system.calls.length = 0
  return s
}
for (const options of [
  { attached: false, gate: true },
  { versionOnOpen: { 1: '26.930.10000' }, gate: true },
])
  test(`failed router postflight recovers adapter: ${JSON.stringify(options)}`, async () => {
    const s = await setup(options)
    assert.equal(await s.run('on'), 1, s.out.join(''))
    assert.deepEqual(
      readLayers(s.root).layers.map((l) => l.name),
      ['adapter'],
    )
    assert.equal(readFlipMarker(s.root), null, s.out.join(''))
    assert.deepEqual(restarts(s), ['quitApp', 'openApp', 'quitApp', 'openApp'])
  })
test('restart checks the same installed state and cleans owned cache only while down', async () => {
  const s = await installed()
  const cache = join(s.home, '.codex/models_cache.json')
  writeFileSync(
    cache,
    JSON.stringify({ models: [{ slug: 'opus', description: 'Claude via AnyEngine' }] }),
  )
  const opened = s.system.onOpen
  s.system.onOpen = () => {
    assert.equal(existsSync(cache), false)
    opened?.()
  }
  assert.equal(await s.run('restart'), 0, s.out.join(''))
  assert.deepEqual(restarts(s), ['quitApp', 'openApp'])
  assert.equal(readFlipMarker(s.root), null)
  assert.deepEqual(
    readLayers(s.root).layers.map((l) => l.name),
    ['adapter', 'router'],
  )
})
test('positive-down no-restart Off restores dependencies without reopening', async () => {
  const s = await installed()
  s.system.running = false
  assert.equal(await s.run('off', ['--yes', '--no-restart']), 0, s.out.join(''))
  assert.deepEqual(restarts(s), [])
  assert.equal(readFlipMarker(s.root), null)
  assert.equal(s.system.running, false)
  assert.equal(existsSync(join(s.root, 'state/layers.json')), false)
})
test('failed reopen is reported once and retains recovery for retry', async () => {
  const s = await installed()
  s.system.openError = new Error('synthetic reopen refused')
  assert.equal(await s.run('off'), 1)
  assert.deepEqual(restarts(s), ['quitApp', 'openApp'])
  assert.match(s.out.join(''), /reopen failed.*synthetic reopen refused/)
  assert.ok(readFlipMarker(s.root))
  assert.ok(existsSync(join(s.root, 'state/layers.json')))
  s.system.openError = null
  assert.equal(await s.run('off'), 1, s.out.join(''))
  assert.equal(readFlipMarker(s.root), null)
})
test('changed retained recovery script refuses before quit and preserves exact bytes', async () => {
  const s = await installed()
  const path = join(s.root, 'recovery/anyengine-off')
  writeFileSync(path, '#!/bin/bash\nexit 0\n')
  const before = readFileSync(path)
  assert.equal(await s.run('off'), 1)
  assert.deepEqual(restarts(s), [])
  assert.deepEqual(readFileSync(path), before)
  assert.match(s.out.join(''), /recovery entry changed/)
})
test('malformed original resume state refuses before replacing journal or creating ownership', async () => {
  const s = await setup()
  const ts = '2026-10-01T00:00:00.000Z'
  writeFlipMarker(s.root, {
    id: 'old',
    op: 'off',
    args: ['--yes'],
    pid: 999999,
    processStart: ts,
    runner: 'foreground',
    phase: 'resume',
    startedAt: ts,
    updatedAt: ts,
    log: join(s.root, 'state/flip-old.log'),
    state: {
      interrupted: { op: 'on', args: ON, phase: 'postflight', state: { mutationsStarted: 'no' } },
    },
  })
  const path = join(s.root, 'state/flip.json')
  const before = readFileSync(path)
  assert.equal(await s.run('on'), 1)
  assert.deepEqual(readFileSync(path), before)
  assert.equal(existsSync(join(s.root, 'state/flip.lock')), false)
  assert.deepEqual(restarts(s), [])
})
for (const reopenFails of [false, true])
  test(`confirmed quit then unknown inspection still reopens; reopen failure=${reopenFails}`, async () => {
    const s = await installed()
    const journal = readFileSync(join(s.root, 'state/layers.json'))
    const jobs = [...s.system.jobs]
    const quit = s.system.quitApp
    s.system.quitApp = () => {
      const ok = quit()
      assert.equal(ok, true)
      s.system.runningError = new Error('inspection unavailable after confirmed quit')
      return ok
    }
    if (reopenFails) s.system.openError = new Error('synthetic reopen refused')
    assert.equal(await s.run('restart'), 1)
    assert.deepEqual(restarts(s), ['quitApp', 'openApp'])
    assert.equal(s.system.running, !reopenFails)
    assert.deepEqual([...s.system.jobs], jobs)
    assert.deepEqual(readFileSync(join(s.root, 'state/layers.json')), journal)
    assert.ok(readFlipMarker(s.root))
    assert.match(s.out.join(''), /inspection unavailable after confirmed quit/)
    if (reopenFails) assert.match(s.out.join(''), /reopen failed.*synthetic reopen refused/)
  })
for (const quitUnknown of [false, true])
  test(`unconfirmed quit never reopens or changes dependencies; unknown=${quitUnknown}`, async () => {
    const s = await installed()
    const journal = readFileSync(join(s.root, 'state/layers.json'))
    const jobs = [...s.system.jobs]
    if (quitUnknown) s.system.quitError = new Error('quit status unknown')
    else s.system.quitResult = false
    assert.equal(await s.run('restart'), 1)
    assert.deepEqual(restarts(s), ['quitApp'])
    assert.equal(s.system.running, true)
    assert.deepEqual([...s.system.jobs], jobs)
    assert.deepEqual(readFileSync(join(s.root, 'state/layers.json')), journal)
    assert.ok(readFlipMarker(s.root))
  })
for (const op of ['restart', 'off'] as const)
  for (const recoveryReopenFails of [false, true])
    test(`${op} signal during postflight recovers before retirement; recovery reopen failure=${recoveryReopenFails}`, async () => {
      const s = await installed()
      const stop = { requested: null as NodeJS.Signals | null }
      const doctor = s.deps.doctor
      const journalPath = join(s.root, 'state/layers.json')
      const initial = JSON.parse(readFileSync(journalPath, 'utf8'))
      s.deps.doctor = async () => {
        const result = await doctor()
        stop.requested = 'SIGTERM'
        if (recoveryReopenFails) s.system.openError = new Error('recovery reopen refused')
        return result
      }
      const args = op === 'off' ? ['--yes', '--router-only'] : ['--yes']
      assert.equal(await s.run(op, args, stop), 1, s.out.join(''))
      assert.equal(stop.requested, 'SIGTERM')
      assert.deepEqual(restarts(s), ['quitApp', 'openApp', 'quitApp', 'openApp'])
      assert.equal(s.system.running, !recoveryReopenFails)
      assert.deepEqual(
        readLayers(s.root).layers.map((l) => l.name),
        ['adapter'],
      )
      const retained = JSON.parse(readFileSync(journalPath, 'utf8'))
      if (recoveryReopenFails) {
        assert.ok(readFlipMarker(s.root))
        assert.match(s.out.join(''), /reopen failed.*recovery reopen refused/)
        assert.deepEqual(
          retained.layers.map((l: { name: string }) => l.name),
          ['adapter', 'router'],
        )
        assert.deepEqual(retained.recovery, initial.recovery)
        s.system.openError = null
        s.deps.doctor = doctor
        assert.equal(await s.run(op, args), 1, s.out.join(''))
        assert.equal(readFlipMarker(s.root), null)
      } else {
        assert.equal(readFlipMarker(s.root), null)
        assert.deepEqual(
          retained.layers.map((l: { name: string }) => l.name),
          ['adapter'],
        )
      }
    })
