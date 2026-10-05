import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

// Every suite runs under scripts/test-hermetic.mjs (`npm test`), which points
// HOME and every engine home into one throwaway directory. A bare
// `node --test dist/test/*.mjs` fails here first, instead of a suite quietly
// reading or writing the real ~/.codex, ~/.claude or ~/.anyengine.
const root = process.env.HERMETIC_TEST_ROOT ?? ''

function inside(path: string | undefined): boolean {
  if (!path || !root) return false
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

test('the suite runs inside a throwaway home', () => {
  assert.ok(root, 'run the suites through `npm test` or `node scripts/test-hermetic.mjs`')
  for (const name of [
    'HOME',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'ANYENGINE_DEBUG_LOG',
    'ANYENGINE_CHATGPT_APP',
  ]) {
    assert.ok(
      inside(process.env[name]),
      `${name} is outside the hermetic root: ${process.env[name]}`,
    )
  }
  assert.ok(inside(homedir()), `os.homedir() is outside the hermetic root: ${homedir()}`)
  assert.equal(process.env.ANYENGINE_NATIVE_CODEX, '0')
  // Only a test names a codex, and only for its own children.
  assert.equal(process.env.ANYENGINE_REAL_CODEX, undefined)
})

test('no real engine CLI is reachable on PATH', () => {
  for (const cli of ['codex', 'claude', 'grok']) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${cli}`], { encoding: 'utf8' })
    assert.notEqual(found.status, 0, `${cli} resolves to ${found.stdout.trim()}`)
  }
})

test('no inherited credential or engine setting leaks in', () => {
  const leaked = Object.keys(process.env).filter((key) =>
    /^(ANTHROPIC_|OPENAI_|XAI_|CLAUDE_CODEX_|CODEX_CLI_PATH|GIT_DIR)/.test(key),
  )
  assert.deepEqual(leaked, [])
})

test('temp files land inside the hermetic root', () => {
  const tmp = process.env.TMPDIR ?? ''
  assert.ok(inside(tmp), `TMPDIR is outside the hermetic root: ${tmp}`)
  assert.equal(realpathSync(tmpdir()), realpathSync(tmp))
})

// Every agent's runs share one temp directory: a run that starts while this
// one is going leaves its root there until it ends, and is not a stray.
test("an overlapping run's root is no stray; any other new entry is", async () => {
  const { findStrays, listAnyengine } = await import(
    pathToFileURL(resolve('scripts/hermetic-strays.mjs')).href
  )
  const host = await tempDir('host-tmp-')
  await mkdir(join(host, 'anyengine-old-dsdR0e'))
  const before = new Set(listAnyengine(host))
  await mkdir(join(host, 'anyengine-hermetic-Q7bLkz'))
  assert.deepEqual(findStrays(host, before), [])
  await mkdir(join(host, 'anyengine-stray-XyZ789'))
  assert.deepEqual(findStrays(host, before), ['anyengine-stray-XyZ789'])
})
