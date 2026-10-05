import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { takeFlipLock } from '../src/control-flip-lock.mjs'
import { markerAlive, readFlipMarker, writeFlipMarker } from '../src/control-marker.mjs'
import { realSystem } from '../src/control-system.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(killChildren)
after(removeTempDirs)
function received(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`worker ${type} deadline`))
    }, 30_000)
    const listen = (data: Record<string, unknown>) => {
      if (data.type === 'error') {
        cleanup()
        reject(new Error(String(data.error)))
      } else if (data.type === type) {
        cleanup()
        resolve(data)
      }
    }
    const exited = () => {
      cleanup()
      reject(new Error('worker exited before reply'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('message', listen)
      child.off('exit', exited)
    }
    child.on('message', listen)
    child.once('exit', exited)
  })
}
async function worker(root: string, barrier?: string) {
  const child = spawn(
    process.execPath,
    ['dist/test/helpers/flip-lock-worker.mjs', root, ...(barrier ? [barrier] : [])],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  )
  await received(child, 'ready')
  return child
}
async function take(child: ChildProcess) {
  const result = received(child, 'taken')
  child.send('take')
  return result
}
async function release(child: ChildProcess) {
  const exit = once(child, 'exit')
  child.send('release')
  await exit
}
async function until(test: () => boolean) {
  const end = Date.now() + 30_000
  while (!test()) {
    if (Date.now() >= end) throw new Error('condition deadline')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('actual processes exclude a second live owner regardless of lock age', async () => {
  const root = await tempDir('flip-lock-')
  const first = await worker(root)
  assert.equal((await take(first)).ok, true)
  const path = join(root, 'state/flip.lock')
  utimesSync(path, new Date(0), new Date(0))
  const second = await worker(root)
  assert.equal((await take(second)).ok, false)
  await release(second)
  await release(first)
  assert.equal(existsSync(path), false)
})

test('dead owner plus overlapping successor admission yields exactly one new owner', async () => {
  const root = await tempDir('flip-lock-')
  const dead = await worker(root)
  assert.equal((await take(dead)).ok, true)
  const exited = once(dead, 'exit')
  dead.kill('SIGKILL')
  await exited
  const barrier = join(root, 'barrier')
  const first = await worker(root, barrier)
  const taken = take(first)
  await until(() => existsSync(`${barrier}.ready`))
  const contenders = await Promise.all([worker(root), worker(root), worker(root)])
  const replies = contenders.map(take)
  writeFileSync(`${barrier}.go`, '')
  assert.equal((await taken).ok, true)
  assert.deepEqual(
    (await Promise.all(replies)).map((r) => r.ok),
    [false, false, false],
  )
  await Promise.all(contenders.map(release))
  await release(first)
  assert.equal(existsSync(join(root, 'state/flip.lock')), false)
})

test('matching-token release refuses a replacement inode even with the same PID/start', async () => {
  const root = await tempDir('flip-lock-')
  const system = realSystem({ ...process.env, ANYENGINE_PS: '/bin/ps' })
  const lock = takeFlipLock(root, system)
  assert.ok(lock.ok)
  const path = join(root, 'state/flip.lock')
  const old = JSON.parse(readFileSync(path, 'utf8'))
  unlinkSync(path)
  const successor = `${JSON.stringify({ ...old, token: randomUUID() })}\n`
  writeFileSync(path, successor, { mode: 0o600 })
  lock.release()
  assert.equal(readFileSync(path, 'utf8'), successor)
})

test('unknown process inspection and corrupt lock bytes retain exact evidence and refuse takeover', async () => {
  const root = await tempDir('flip-lock-')
  const system = realSystem({ ...process.env, ANYENGINE_PS: '/bin/ps' })
  const lock = takeFlipLock(root, system)
  assert.ok(lock.ok)
  const path = join(root, 'state/flip.lock')
  const before = readFileSync(path)
  assert.throws(
    () =>
      takeFlipLock(root, {
        ...system,
        processes: () => {
          throw new Error('ps unavailable')
        },
      }),
    /ps unavailable/,
  )
  assert.deepEqual(readFileSync(path), before)
  lock.release()
  const invalid = Buffer.from([123, 34, 255, 34, 125])
  writeFileSync(path, invalid)
  assert.throws(() => takeFlipLock(root, system))
  assert.deepEqual(readFileSync(path), invalid)
})

test('resumed detached marker binds the real runner ID and refuses corrupt runner identity', async () => {
  const root = await tempDir('flip-marker-')
  const system = fakeSystem(root)
  const processStart = '2026-10-01T00:00:00.000Z'
  const marker = {
    id: 'original',
    op: 'off' as const,
    args: ['--yes'],
    pid: 123,
    processStart,
    runner: 'detached' as const,
    phase: 'resume',
    startedAt: processStart,
    updatedAt: processStart,
    log: join(root, 'state/flip-new.log'),
    state: { runnerId: 'new' },
  }
  writeFlipMarker(root, marker)
  system.procs = [
    { pid: 123, ppid: 1, processStart, command: 'node /lib/adapter.mjs flip-run new off --yes' },
  ]
  const observed = system.procs[0]
  assert.ok(observed)
  assert.equal(markerAlive(marker, system), true)
  observed.command = 'node /lib/adapter.mjs flip-run original off --yes'
  assert.equal(markerAlive(marker, system), false)
  observed.command = 'node /lib/adapter.mjs flip-run new off --yes'
  observed.processStart = '2026-10-02T00:00:00.000Z'
  assert.equal(markerAlive(marker, system), false)
  assert.throws(
    () => writeFlipMarker(root, { ...marker, state: { runnerId: '../bad' } }),
    /runner identity/,
  )
  const path = join(root, 'state/flip.json')
  writeFileSync(path, JSON.stringify({ ...marker, state: { runnerId: null } }))
  assert.throws(() => readFlipMarker(root), /preserve/)
})
