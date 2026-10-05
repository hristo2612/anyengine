import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { readLayers } from '../src/control-layers.mjs'
import { readFlipMarker } from '../src/control-marker.mjs'
import { realSystem } from '../src/control-system.mjs'
import { killChildren, spawn, stopProcess } from './helpers/children.mjs'
import { setup } from './helpers/flip-controller.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(killChildren)
after(removeTempDirs)
function reply(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('worker reply deadline'))
    }, 60_000)
    const data = (row: Record<string, unknown>) => {
      cleanup()
      resolve(row)
    }
    const exited = () => {
      cleanup()
      reject(new Error('worker exited before reply'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('message', data)
      child.off('exit', exited)
    }
    child.once('message', data)
    child.once('exit', exited)
  })
}
function worker(home: string, pause = true) {
  return spawn(
    process.execPath,
    ['dist/test/helpers/flip-resume-worker.mjs', home, pause ? 'pause' : 'finish'],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  )
}
async function kill(child: ChildProcess) {
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

test('SIGKILL during On and again during resume retains original authority until a third owner recovers', async () => {
  const s = await setup()
  const first = worker(s.home)
  const paused = await reply(first)
  assert.equal(paused.type, 'paused', JSON.stringify(paused))
  const original = readFlipMarker(s.root)
  assert.ok(original)
  assert.equal(original.phase, 'postflight')
  await kill(first)
  const second = worker(s.home)
  const resumed = await reply(second)
  assert.equal(resumed.type, 'paused', JSON.stringify(resumed))
  const middle = readFlipMarker(s.root)
  assert.ok(middle)
  assert.equal(middle.id, original.id)
  assert.equal(middle.pid, second.pid)
  assert.deepEqual(middle.state.interrupted, {
    op: original.op,
    args: original.args,
    phase: original.phase,
    state: original.state,
  })
  await kill(second)
  const third = worker(s.home, false)
  const exited = once(third, 'exit')
  const finished = await reply(third)
  await exited
  assert.equal(finished.type, 'done')
  assert.equal(finished.code, 1, String(finished.output))
  assert.equal(readFlipMarker(s.root), null, String(finished.output))
  assert.deepEqual(
    readLayers(s.root).layers.map((l) => l.name),
    ['adapter'],
  )
  assert.equal(existsSync(join(s.root, 'state/flip.lock')), false)
})

test('real detached spawn survives SIGHUP with finite owned child cleanup', async () => {
  const s = await setup()
  const log = join(s.home, 'detached.log')
  writeFileSync(log, '', { mode: 0o600 })
  const system = realSystem({ ...process.env, ANYENGINE_PS: '/bin/ps' })
  const script =
    "process.on('SIGHUP',()=>process.stdout.write('survived\\n')); process.stdout.write('ready\\n'); setTimeout(()=>process.exit(0),30000)"
  const pid = system.spawnDetached([process.execPath, '-e', script], log)
  try {
    const until = async (pattern: RegExp) => {
      const end = Date.now() + 15_000
      while (!pattern.test(readFileSync(log, 'utf8'))) {
        if (Date.now() > end) throw new Error('detached deadline')
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    await until(/ready/)
    const own = system.processes().find((p) => p.pid === pid)
    assert.ok(own?.processStart)
    process.kill(pid, 'SIGHUP')
    await until(/survived/)
    assert.equal(system.processes().find((p) => p.pid === pid)?.processStart, own.processStart)
  } finally {
    await stopProcess(pid)
  }
  assert.equal(
    system.processes().some((p) => p.pid === pid),
    false,
  )
})

test('actual detached runner survives its exited caller and SIGHUP, then records the refused operation', async () => {
  const s = await setup()
  const log = join(s.home, 'actual-detached.log')
  const ps = join(s.home, 'controlled-ps')
  const ready = join(s.home, 'ps-ready')
  const go = join(s.home, 'ps-go')
  writeFileSync(log, '', { mode: 0o600 })
  writeFileSync(
    ps,
    '#!/bin/sh\n: > "$FLIP_READY"\nwhile [ ! -f "$FLIP_GO" ]; do /bin/sleep 0.02; done\nexec /bin/ps "$@"\n',
    { mode: 0o700 },
  )
  const caller = spawn(
    process.execPath,
    ['dist/test/helpers/flip-detach-worker.mjs', log, 'actual'],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        HOME: s.home,
        ANYENGINE_ROOT: s.root,
        ANYENGINE_PS: ps,
        FLIP_READY: ready,
        FLIP_GO: go,
      },
    },
  )
  const exited = once(caller, 'exit')
  const row = await reply(caller)
  await exited
  const pid = Number(row.pid)
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  const observer = realSystem({ ...process.env, ANYENGINE_PS: '/bin/ps' })
  const until = async (condition: () => boolean) => {
    const end = Date.now() + 15_000
    while (!condition()) {
      if (Date.now() > end) throw new Error('actual runner deadline')
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  try {
    await until(() => existsSync(ready))
    const identity = observer.processes().find((p) => p.pid === pid)
    assert.ok(identity?.processStart)
    assert.notEqual(identity.ppid, caller.pid)
    process.kill(pid, 'SIGHUP')
    writeFileSync(go, '')
    await until(() => /flip actual exit 1\n$/.test(readFileSync(log, 'utf8')))
    assert.match(readFileSync(log, 'utf8'), /configured app version unknown/)
    await until(() => !observer.processes().some((p) => p.pid === pid))
  } finally {
    writeFileSync(go, '')
    await stopProcess(pid)
  }
})
