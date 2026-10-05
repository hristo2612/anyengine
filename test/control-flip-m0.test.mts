import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { applyOffFiles, applyOnFiles, finishOff } from '../src/control-install.mjs'
import { readFlipMarker } from '../src/control-marker.mjs'
import { setup } from './helpers/flip-controller.mjs'
import { pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)

test('restart recognizes active M0 before any M1 adoption and verifies the unchanged adapter', async () => {
  const s = await setup()
  const shim = readFileSync(join(s.home, 'bin/codex'))
  s.system.onOpen = () => {
    const snapshot = s.deps.currentSnapshot()
    const ts = s.system.now().toISOString()
    s.system.procs = [
      {
        pid: 801,
        ppid: 800,
        processStart: ts,
        command: `node ${snapshot.libDir}/dist/src/adapter.mjs app-server`,
      },
      { pid: 901, ppid: 801, processStart: ts, command: `${snapshot.bundled} app-server` },
      { pid: 800, ppid: 1, processStart: ts, command: `${s.system.app}/Contents/MacOS/ChatGPT` },
    ]
    s.log.push(
      `${ts} info stdio_transport_spawned executablePath=~/bin/codex pid=801`,
      `${ts} info initialize_handshake_result outcome=success transportKind=stdio`,
    )
    s.events.push({
      ts,
      pid: 901,
      event: 'codex.upstream.spawn',
      binary: snapshot.bundled,
      args: ['app-server'],
    })
  }
  assert.equal(await s.run('restart'), 0, s.out.join(''))
  assert.deepEqual(readFileSync(join(s.home, 'bin/codex')), shim)
  assert.equal(readFlipMarker(s.root), null)
  assert.deepEqual(
    s.system.calls.filter((c) => ['quitApp', 'openApp'].includes(c)),
    ['quitApp', 'openApp'],
  )
})

test('restart verifies vanilla after both layers have been restored', async () => {
  const s = await setup()
  s.system.running = false
  applyOnFiles(s.system, s.root, s.plan, { dryRun: false, paths: pathsFor(s.home) })
  applyOffFiles(s.system, s.root, { routerOnly: false, paths: pathsFor(s.home) })
  finishOff(s.system, s.root, pathsFor(s.home))
  s.system.openApp()
  s.system.calls.length = 0
  assert.equal(await s.run('restart'), 0, s.out.join(''))
  assert.equal(readFlipMarker(s.root), null)
  assert.deepEqual(
    s.system.calls.filter((c) => ['quitApp', 'openApp'].includes(c)),
    ['quitApp', 'openApp'],
  )
})
for (const relative of ['.zshrc', 'bin/codex'])
  test(`invalid M0 ${relative} bytes refuse route inference before quit`, async () => {
    const s = await setup()
    const path = join(s.home, relative)
    const bytes = Buffer.from([255, 10])
    writeFileSync(path, bytes)
    assert.equal(await s.run('restart'), 1)
    assert.deepEqual(readFileSync(path), bytes)
    assert.deepEqual(s.system.calls, [])
  })
