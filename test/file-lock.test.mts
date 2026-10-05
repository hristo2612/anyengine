import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { after } from 'node:test'
import { withFileLock } from '../src/file-lock.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(() => killChildren())
after(removeTempDirs)

// No macOS pid is this high (pids stop at 99998), so this holder is gone.
const DEAD = '99999999\n'

async function lockIn(): Promise<{ dir: string; lock: string }> {
  const dir = await tempDir('anyengine-lock-')
  return { dir, lock: join(dir, 'x.lock') }
}

function ago(path: string, ms: number): void {
  const then = new Date(Date.now() - ms)
  utimesSync(path, then, then)
}

function onlyGate(dir: string, lock: string): void {
  assert.deepEqual(readdirSync(dir), ['x.lock.sqlite'], 'only persistent coordination remains')
  assert.equal(statSync(`${lock}.sqlite`).size, 0, 'the gate accumulates no data')
  assert.equal(statSync(`${lock}.sqlite`).mode & 0o777, 0o600)
  const db = new DatabaseSync(`${lock}.sqlite`, { timeout: 0 })
  try {
    db.exec('BEGIN IMMEDIATE; ROLLBACK')
  } finally {
    db.close()
  }
}

test('lock: the holder runs with its pid in the lock, and closes a stable bounded gate', async () => {
  const { dir, lock } = await lockIn()
  const value = withFileLock(lock, () => {
    assert.match(readFileSync(lock, 'utf8'), new RegExp(`^${process.pid} `))
    return 7
  })
  assert.equal(value, 7)
  const inode = statSync(`${lock}.sqlite`).ino
  assert.throws(
    () =>
      withFileLock(lock, () => {
        throw new Error('boom')
      }),
    /boom/,
  )
  assert.equal(
    withFileLock(lock, () => 8),
    8,
    'reacquisition after callback error',
  )
  assert.equal(statSync(`${lock}.sqlite`).ino, inode, 'release never replaces the gate inode')
  onlyGate(dir, lock)
})

test('lock: a live holder is waited for, and never taken over while young', async () => {
  const { lock } = await lockIn()
  for (const holder of [`${process.pid} other\n`, '1\n']) {
    writeFileSync(lock, holder)
    let ran = false
    assert.throws(
      () =>
        withFileLock(
          lock,
          () => {
            ran = true
          },
          { waitMs: 100 },
        ),
      /another process holds/,
    )
    assert.equal(ran, false, holder)
    assert.equal(readFileSync(lock, 'utf8'), holder)
  }
})

test('lock: a dead holder, or a lock past staleMs whatever its pid, is taken over', async () => {
  const { dir, lock } = await lockIn()
  writeFileSync(lock, DEAD)
  assert.equal(
    withFileLock(lock, () => 'dead', { waitMs: 1000 }),
    'dead',
  )
  writeFileSync(lock, '1\n')
  ago(lock, 120_000)
  assert.equal(
    withFileLock(lock, () => 'reused pid', { waitMs: 1000 }),
    'reused pid',
  )
  writeFileSync(lock, `${process.pid} stuck\n`)
  ago(lock, 2_000)
  assert.equal(
    withFileLock(lock, () => 'old', { waitMs: 1000, staleMs: 1_000 }),
    'old',
  )
  onlyGate(dir, lock)
})

// The race the review reproduced: a waiter judged the lock stale, and before
// it acted another waiter had replaced it with a fresh lock of its own.
test('lock: a takeover that finds a newer lock in its place leaves it there', async () => {
  const { dir, lock } = await lockIn()
  writeFileSync(lock, DEAD)
  const fresh = `${process.pid} newer holder\n`
  let takeovers = 0
  let ran = false
  assert.throws(
    () =>
      withFileLock(
        lock,
        () => {
          ran = true
        },
        {
          waitMs: 200,
          beforeTakeover: () => {
            takeovers += 1
            writeFileSync(join(dir, 'fresh'), fresh)
            renameSync(join(dir, 'fresh'), lock)
          },
        },
      ),
    /another process holds/,
  )
  assert.equal(takeovers, 1)
  assert.equal(ran, false, 'never inside while the newer holder is')
  assert.equal(readFileSync(lock, 'utf8'), fresh, 'the newer lock is still in place')
  assert.deepEqual(readdirSync(dir).sort(), ['x.lock', 'x.lock.sqlite'], 'no aside or journal')
})

test('lock: a holder whose lock was taken over leaves the new holder its lock', async () => {
  const { lock } = await lockIn()
  const successor = `${process.pid} successor\n`
  withFileLock(lock, () => {
    writeFileSync(join(lock, '..', 'next'), successor)
    renameSync(join(lock, '..', 'next'), lock)
  })
  assert.equal(readFileSync(lock, 'utf8'), successor)
})

test('lock: one waiter at a time takes a stale lock over, and a dead one does not block', async () => {
  const { dir, lock } = await lockIn()
  writeFileSync(lock, DEAD)
  writeFileSync(`${lock}.takeover`, `${process.pid} taking over\n`)
  assert.throws(() => withFileLock(lock, () => 'ran', { waitMs: 100 }), /another process holds/)
  assert.equal(readFileSync(lock, 'utf8'), DEAD, 'left to the waiter taking it over')
  writeFileSync(`${lock}.takeover`, DEAD)
  assert.equal(
    withFileLock(lock, () => 'ran', { waitMs: 1000 }),
    'ran',
  )
  onlyGate(dir, lock)
})

// These barriers hold real synchronous recovery/body work in another process.
// Breaking an aged marker must never admit a second updated caller while it
// is there, even when both legacy markers started with dead holders.
const HELD_LOCK = `
import { existsSync, writeFileSync } from 'node:fs'
const [module, lock, phase, ready, go] = process.argv.slice(1)
const { withFileLock } = await import(module)
const pause = new Int32Array(new SharedArrayBuffer(4))
function hold() {
  writeFileSync(ready, '')
  const deadline = performance.now() + 30000
  while (!existsSync(go)) {
    if (performance.now() >= deadline) throw new Error('barrier was not released')
    Atomics.wait(pause, 0, 0, 5)
  }
}
withFileLock(lock, () => {
  if (phase === 'nested body') {
    let refused = false
    try { withFileLock(lock, () => { throw new Error('nested body entered') }, { waitMs: 0 }) }
    catch (error) { if (!/another process holds/.test(error.message)) throw error; refused = true }
    if (!refused) throw new Error('nested gate should fail closed')
  }
  if (phase !== 'recovery') hold()
}, {
  waitMs: 10000, staleMs: 1,
  beforeTakeover: () => { if (phase === 'recovery') hold() }
})
`

const CONTENDER = `
const [module, lock] = process.argv.slice(1)
const { withFileLock } = await import(module)
let entered = false
const started = performance.now()
try {
  withFileLock(lock, () => { entered = true }, { waitMs: 150, staleMs: 1 })
  process.stdout.write(JSON.stringify({ entered }) + '\\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ entered, error: error.message, elapsed: performance.now() - started }) + '\\n')
}
`

async function untilFile(path: string): Promise<void> {
  const deadline = performance.now() + 30_000
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`no barrier: ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

for (const phase of ['recovery', 'body', 'nested body']) {
  test(`lock: live ${phase} cannot be stolen through aged legacy markers`, async () => {
    const { dir, lock } = await lockIn()
    writeFileSync(lock, DEAD)
    writeFileSync(`${lock}.takeover`, DEAD)
    const module = new URL('../src/file-lock.mjs', import.meta.url).href
    const ready = join(dir, 'ready')
    const go = join(dir, 'go')
    const holder = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      HELD_LOCK,
      module,
      lock,
      phase,
      ready,
      go,
    ])
    const exited = once(holder, 'exit')
    try {
      await untilFile(ready)
      const marker = phase === 'recovery' ? `${lock}.takeover` : lock
      const token = readFileSync(marker, 'utf8')
      ago(marker, 2_000)
      const attempts = Array.from({ length: 3 }, async () => {
        const child = spawn(
          process.execPath,
          ['--input-type=module', '-e', CONTENDER, module, lock],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        let output = ''
        child.stdout?.on('data', (chunk) => {
          output += String(chunk)
        })
        const [code] = await once(child, 'exit')
        assert.equal(code, 0)
        const result = JSON.parse(output)
        assert.equal(result.entered, false, 'contender entered a held critical section')
        assert.match(result.error, /another process holds/)
        assert.ok(result.elapsed >= 150 && result.elapsed < 5000, 'bounded live contention')
      })
      await Promise.all(attempts)
      assert.equal(readFileSync(marker, 'utf8'), token, 'the live owner marker survives')
    } finally {
      writeFileSync(go, '')
      assert.equal((await exited)[0], 0)
    }
    assert.equal(
      withFileLock(lock, () => 'again'),
      'again',
    )
  })
}

test('lock: setup and SQLite errors fail closed without changing legacy markers', async () => {
  const { dir, lock } = await lockIn()
  const gate = `${lock}.sqlite`
  writeFileSync(lock, DEAD)
  let entered = false
  const body = () => {
    entered = true
  }
  mkdirSync(gate)
  assert.throws(() => withFileLock(lock, body), /unable to open database file/)
  assert.equal(entered, false)
  assert.equal(readFileSync(lock, 'utf8'), DEAD)
  rmSync(gate, { recursive: true }) // offline fixture repair, no SQLite handles exist
  const corrupt = 'this is not a SQLite database'.repeat(100)
  writeFileSync(gate, corrupt, { mode: 0o600 })
  assert.throws(() => withFileLock(lock, body), /not a database/)
  assert.equal(entered, false)
  assert.equal(readFileSync(lock, 'utf8'), DEAD)
  assert.equal(readFileSync(gate, 'utf8'), corrupt, 'failed gate is preserved for repair')
  writeFileSync(gate, '') // offline fixture repair; retain the persistent inode
  assert.equal(
    withFileLock(lock, () => 'repaired'),
    'repaired',
  )
  onlyGate(dir, lock)
})

test('lock: a recovery error closes its gate and preserves the main marker', async () => {
  const { dir, lock } = await lockIn()
  writeFileSync(lock, DEAD)
  let entered = false
  assert.throws(
    () =>
      withFileLock(
        lock,
        () => {
          entered = true
        },
        {
          beforeTakeover: () => {
            throw new Error('recovery failed')
          },
        },
      ),
    /recovery failed/,
  )
  assert.equal(entered, false)
  assert.equal(readFileSync(lock, 'utf8'), DEAD)
  assert.deepEqual(readdirSync(dir).sort(), ['x.lock', 'x.lock.sqlite'])
  assert.equal(
    withFileLock(lock, () => 'recovered'),
    'recovered',
  )
  onlyGate(dir, lock)
})

test('lock: legacy recovery shares the acquisition deadline', async () => {
  const { dir, lock } = await lockIn()
  writeFileSync(lock, DEAD)
  let entered = false
  assert.throws(
    () =>
      withFileLock(
        lock,
        () => {
          entered = true
        },
        {
          waitMs: 50,
          beforeTakeover: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75),
        },
      ),
    /another process holds/,
  )
  assert.equal(entered, false)
  assert.equal(
    withFileLock(lock, () => 'again'),
    'again',
  )
  onlyGate(dir, lock)
})

test('lock: process death frees the stable gate and seeded dead markers recover', async () => {
  const { dir, lock } = await lockIn()
  writeFileSync(lock, DEAD)
  writeFileSync(`${lock}.takeover`, DEAD)
  const module = new URL('../src/file-lock.mjs', import.meta.url).href
  const ready = join(dir, 'ready')
  const holder = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    HELD_LOCK,
    module,
    lock,
    'body',
    ready,
    join(dir, 'never'),
  ])
  const exited = once(holder, 'exit')
  await untilFile(ready)
  const gate = statSync(`${lock}.sqlite`)
  const token = readFileSync(lock, 'utf8')
  holder.kill('SIGKILL')
  assert.deepEqual(await exited, [null, 'SIGKILL'])
  assert.equal(readFileSync(lock, 'utf8'), token, 'crash leaves the legacy owner marker')
  writeFileSync(`${lock}.takeover`, DEAD)
  assert.equal(
    withFileLock(lock, () => 'after crash', { waitMs: 1000 }),
    'after crash',
  )
  assert.equal(statSync(`${lock}.sqlite`).ino, gate.ino)
  rmSync(ready)
  onlyGate(dir, lock)
})
