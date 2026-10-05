import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import { fakeLib, m0Home } from './helpers/m0-home.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const pause = () => new Promise((done) => setTimeout(done, 25))
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 320; attempt += 1) {
    if (check()) return
    await pause()
  }
  throw new Error('owned proof caller cleanup deadline exceeded')
}
const terminated = (pid: number) => {
  const result = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 1000,
  })
  return (
    (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) ||
    (result.status === 0 && /^Z/.test(result.stdout.trim()))
  )
}

function killOwned(pid: number): void {
  if (terminated(pid)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
function readFamily(file: string): number[] | null {
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  if (!/^[1-9]\d* [1-9]\d* [1-9]\d*\n$/.test(text)) return null
  const pids = text.trim().split(' ').map(Number)
  return pids.every((pid) => Number.isSafeInteger(pid) && pid > 1) && new Set(pids).size === 3
    ? pids
    : null
}
test('proof family readiness requires a complete valid three-PID publication', async () => {
  const parent = await tempDir('proof-readiness-')
  const file = join(parent, 'family.pid')
  for (const text of [
    '',
    '101',
    '101 102',
    '101 102 103',
    '101 102 103 104\n',
    '0 102 103\n',
    '1 102 103\n',
    '101 101 103\n',
    '9007199254740992 102 103\n',
    '101 other 103\n',
  ]) {
    writeFileSync(file, text)
    assert.equal(
      readFamily(file),
      null,
      `incomplete/invalid controlled publication: ${JSON.stringify(text)}`,
    )
  }
  writeFileSync(file, '101 102 103\n')
  assert.deepEqual(readFamily(file), [101, 102, 103])
})
test('killing the proof caller joins its owned sandbox family and removes only the identified route home', async () => {
  const home = await m0Home()
  const plan = fakeLib(home)
  const parent = await tempDir('proof-parent-')
  const module = (path: string) => pathToFileURL(resolve('dist', path)).href
  const code = `
    import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
    import { proveRollback } from ${JSON.stringify(module('src/control-proof.mjs'))};
    import { fakeSystem } from ${JSON.stringify(module('test/helpers/fake-system.mjs'))};
    const home = ${JSON.stringify(home)};
    proveRollback(fakeSystem(home), join(home, '.anyengine'), ${JSON.stringify(plan)}, {
      paths: { codexHome: join(home, '.codex'), pickFile: join(home, '.codex/anyengine/app-model-pick.json') },
      scratchParent: ${JSON.stringify(parent)}, afterOn: scratch => writeFileSync(join(scratch, '.anyengine/recovery/anyengine-off'),
        '#!/bin/bash\\n/bin/sleep 60 &\\necho "$PPID $$ $!" > "$HOME/.proof-tools/family.pid"\\nwait\\n')
    });
  `
  const caller = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' })
  const exited = once(caller, 'exit')
  let directory = ''
  let family: number[] = []
  try {
    await until(() => {
      const name = readdirSync(parent)[0]
      if (!name) return false
      directory = join(parent, name)
      const owned = readFamily(join(directory, '0/.proof-tools/family.pid'))
      if (!owned) return false
      family = owned
      return true
    })
    const identity = lstatSync(directory)
    assert.equal(family.length, 3)
    assert.ok(family.every((pid) => Number.isSafeInteger(pid) && pid > 1))
    caller.kill('SIGKILL')
    await exited
    await until(() => family.every(terminated) && !existsSync(join(directory, '0')))
    assert.equal(
      lstatSync(directory).ino,
      identity.ino,
      'outer proof directory remains owned and retained',
    )
    assert.deepEqual(readdirSync(directory), [])
    rmSync(directory, { recursive: true })
    assert.deepEqual(readdirSync(parent), [])
  } finally {
    caller.kill('SIGKILL')
    await exited
    family.forEach(killOwned)
    await until(() => family.every(terminated))
  }
})
