import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { flipCommand, flipRunMain } from '../src/control-flip-run.mjs'
import { applyOffFiles, applyOnFiles, finishOff, retireOff } from '../src/control-install.mjs'
import { readLayers } from '../src/control-layers.mjs'
import { readFlipMarker } from '../src/control-marker.mjs'
import { setup } from './helpers/flip-controller.mjs'
import { pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)

for (const routerOnly of [true, false])
  test(`deferred ${routerOnly ? 'router-only' : 'full'} retirement retains strict journal/pins until metadata-only completion`, async () => {
    const s = await setup()
    s.system.running = false
    applyOnFiles(s.system, s.root, s.plan, { dryRun: false, paths: pathsFor(s.home) })
    applyOffFiles(s.system, s.root, { routerOnly, paths: pathsFor(s.home) })
    const path = join(s.root, 'state/layers.json')
    const before = JSON.parse(readFileSync(path, 'utf8'))
    finishOff(s.system, s.root, pathsFor(s.home), { deferRetirement: true })
    const retained = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(retained, before)
    assert.deepEqual(
      readLayers(s.root).layers.map((l) => l.name),
      routerOnly ? ['adapter'] : [],
    )
    for (const layer of before.layers.filter(
      (l: { name: string }) => !routerOnly || l.name === 'router',
    ))
      assert.equal(readFileSync(join(layer.rollbackDir, 'POPPED')).length, 0)
    s.system.running = true
    const calls = [...s.system.calls]
    retireOff(s.root)
    assert.deepEqual(
      s.system.calls,
      calls,
      'no second quit or dependent mutation during retirement',
    )
    assert.equal(existsSync(path), routerOnly)
    if (routerOnly)
      assert.deepEqual(
        JSON.parse(readFileSync(path, 'utf8')).layers.map((l: { name: string }) => l.name),
        ['adapter'],
      )
  })

test('malformed POPPED refuses retirement and preserves the exact journal and pins', async () => {
  const s = await setup()
  s.system.running = false
  applyOnFiles(s.system, s.root, s.plan, { dryRun: false, paths: pathsFor(s.home) })
  applyOffFiles(s.system, s.root, { routerOnly: false, paths: pathsFor(s.home) })
  const path = join(s.root, 'state/layers.json')
  const before = readFileSync(path)
  const layer = readLayers(s.root).layers[0]
  assert.ok(layer)
  finishOff(s.system, s.root, pathsFor(s.home), { deferRetirement: true })
  writeFileSync(join(layer.rollbackDir, 'POPPED'), 'invalid')
  assert.throws(() => retireOff(s.root), /POPPED/)
  assert.deepEqual(readFileSync(path), before)
})

test('failed full Off postflight retains popped journal and marker, then a retry verifies and retires them', async () => {
  const s = await setup()
  assert.equal(await s.run('on'), 0, s.out.join(''))
  const opened = s.system.onOpen
  s.system.onOpen = () => {
    opened?.()
    s.system.running = false
  }
  assert.equal(await s.run('off'), 1)
  assert.ok(readFlipMarker(s.root))
  assert.ok(existsSync(join(s.root, 'state/layers.json')))
  assert.equal(readLayers(s.root).layers.length, 0, s.out.join(''))
  const retained = readFileSync(join(s.root, 'state/layers.json'))
  assert.equal(await s.run('off'), 1)
  assert.deepEqual(
    readFileSync(join(s.root, 'state/layers.json')),
    retained,
    'a second failed postflight retains exact raw rows and pins',
  )
  s.system.onOpen = opened
  assert.equal(await s.run('off'), 1, s.out.join(''))
  assert.equal(readFlipMarker(s.root), null)
  assert.equal(existsSync(join(s.root, 'state/layers.json')), false)
})

test('front reads completed detached log before declaring its exited PID dead', async () => {
  const s = await setup()
  const calls: string[][] = []
  s.system.spawnDetached = (argv, log) => {
    calls.push(argv)
    const id = argv[argv.indexOf('flip-run') + 1]
    writeFileSync(log, `flip started\nflip ${id} exit 0\n`)
    return 999999
  }
  const out: string[] = []
  assert.equal(await flipCommand('off')(['--yes'], s.system, s.root, (t) => out.push(t)), 0)
  assert.equal(calls.length, 1)
  assert.match(out.join(''), /flip started/)
})

test('internal runner rejects traversal IDs and dry-run before any root or log publication', async () => {
  assert.equal(await flipRunMain(['../../bad', 'off', '--yes']), 2)
  assert.equal(await flipRunMain(['valid', 'on', '--yes', '--dry-run']), 2)
})

test('deferred router-only then full escalation preserves completed raw rows and pins until retirement', async () => {
  const s = await setup()
  s.system.running = false
  applyOnFiles(s.system, s.root, s.plan, { dryRun: false, paths: pathsFor(s.home) })
  const path = join(s.root, 'state/layers.json')
  const initial = JSON.parse(readFileSync(path, 'utf8'))
  applyOffFiles(s.system, s.root, {
    routerOnly: true,
    deferRetirement: true,
    paths: pathsFor(s.home),
  })
  finishOff(s.system, s.root, pathsFor(s.home), { deferRetirement: true })
  const calls = [...s.system.calls]
  applyOffFiles(s.system, s.root, {
    routerOnly: false,
    deferRetirement: true,
    paths: pathsFor(s.home),
  })
  const pending = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(
    pending.layers.map((l: { name: string }) => l.name),
    ['adapter', 'router'],
  )
  assert.deepEqual(pending.recovery, initial.recovery)
  assert.deepEqual(s.system.calls, calls, 'completed router dependencies are never replayed')
  finishOff(s.system, s.root, pathsFor(s.home), { deferRetirement: true })
  const done = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(
    done.layers.map((l: { name: string }) => l.name),
    ['adapter', 'router'],
  )
  assert.deepEqual(done.recovery, initial.recovery)
  retireOff(s.root)
  assert.equal(existsSync(path), false)
})
