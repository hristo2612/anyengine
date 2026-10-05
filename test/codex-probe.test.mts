import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const { isolatedCommand } = createRequire(import.meta.url)(resolve('scripts/lib/codex-probe.mjs'))

test('isolated probe runs an npm-style Codex launcher with the pinned Node and no caller PATH', {
  skip: process.platform !== 'darwin',
}, async () => {
  const root = await tempDir('probe-node-launcher-')
  const launcher = join(root, 'codex')
  writeFileSync(
    launcher,
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({node:process.execPath, args:process.argv.slice(2), token:process.env.OPENAI_API_KEY ?? null}))\n',
  )
  chmodSync(launcher, 0o700)
  const result = isolatedCommand(launcher, ['app-server', 'generate-ts'], {
    env: { PATH: '/not-the-caller-path', OPENAI_API_KEY: 'must-not-be-inherited' },
  })
  assert.equal(result.status, 0, result.stderr)
  const seen = JSON.parse(result.stdout)
  assert.equal(seen.node, process.execPath)
  assert.deepEqual(seen.args, ['app-server', 'generate-ts'])
  assert.equal(seen.token, null)
})

test('isolated official-command primitive refuses outside writes and inherits no credentials or homes', {
  skip: process.platform !== 'darwin',
}, async () => {
  const root = await tempDir('probe-boundary-')
  const fake = join(root, 'fake.mjs')
  const outside = join(root, 'outside')
  writeFileSync(outside, 'retained')
  writeFileSync(
    fake,
    `import { writeFileSync, existsSync } from 'node:fs';
    let refused = false; try { writeFileSync(${JSON.stringify(outside)}, 'escaped') } catch { refused = true }
    console.log(JSON.stringify({refused, home: process.env.HOME, codex: process.env.CODEX_HOME,
      exists: existsSync(process.env.CODEX_HOME), token: process.env.OPENAI_API_KEY ?? null, args: process.argv.slice(2)}));`,
  )
  const result = isolatedCommand(fake, ['--help'], { timeoutMs: 2000 })
  assert.equal(result.status, 0, result.stderr)
  const seen = JSON.parse(result.stdout)
  assert.equal(seen.refused, true)
  assert.equal(seen.token, null)
  assert.equal(seen.exists, true)
  assert.notEqual(seen.home, process.env.HOME)
  assert.notEqual(seen.codex, process.env.CODEX_HOME)
  assert.deepEqual(seen.args, ['--help'])
  assert.equal(readFileSync(outside, 'utf8'), 'retained')
  assert.equal(existsSync(seen.home), false, 'owned home removed only after family cleanup')
  assert.deepEqual(readdirSync(root).sort(), ['fake.mjs', 'outside'])
})

for (const behavior of ['hang', 'supervisor-failure', 'successful-parent']) {
  test(`isolated probe reaps hanging grandchild after ${behavior} before returning`, {
    skip: process.platform !== 'darwin',
  }, async () => {
    const root = await tempDir('probe-family-')
    const fake = join(root, 'fake.mjs')
    writeFileSync(
      fake,
      `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {stdio:'ignore'});
      writeFileSync('owned-pid', String(child.pid)); console.log('OWNED '+child.pid);
      ${behavior === 'hang' ? 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)' : behavior === 'supervisor-failure' ? 'process.kill(process.ppid,"SIGKILL");setInterval(()=>{},1000)' : 'process.exit(0)'};`,
    )
    const start = performance.now()
    const result = isolatedCommand(fake, ['--version'], {
      timeoutMs: 2000,
      read: ({ work, probe }: { work: string; probe: string }) => ({
        pid: Number(readFileSync(join(work, 'owned-pid'), 'utf8')),
        probe,
      }),
    })
    assert.ok(
      performance.now() - start < 2600,
      'two-second probe budget with test scheduling margin',
    )
    assert.equal(result.status === 0, behavior === 'successful-parent', result.stderr)
    assert.equal(
      existsSync(result.value.probe),
      false,
      'owned home must be removed after terminal group observation',
    )
    const pid = result.value.pid
    assert.ok(pid > 0, result.stdout + result.stderr)
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    if (alive) {
      const state = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8',
      })
      if (state.status === 1 && !state.stdout.trim() && !state.stderr.trim()) return
      assert.equal(state.status, 0, state.stderr)
      assert.match(state.stdout.trim(), /^Z/, 'only an already killed OS-reaping zombie may remain')
    }
  })
}
