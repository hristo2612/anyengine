import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const cli = resolve('scripts/anyengine-cli.mjs')

test('npm entry exposes help, version and setup without activating hosts', () => {
  for (const args of [[], ['--help'], ['setup', '--help']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /setup/)
  }
  const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), JSON.parse(readFileSync('package.json', 'utf8')).version)
})
