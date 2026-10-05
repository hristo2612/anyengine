import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { isGitWorkTree } from '../src/server-helpers.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const originalPath = process.env.PATH

after(async () => {
  process.env.PATH = originalPath
  await removeTempDirs()
})

interface FakeGit {
  cwd: string
  bin: string
  calls: () => Promise<number>
  install: (answer: string) => Promise<void>
}

// A git on PATH whose `rev-parse --is-inside-work-tree` runs `answer` with
// `$n`, the number of this call. `--version` answers without counting.
async function fakeGit(): Promise<FakeGit> {
  const dir = await tempDir('anyengine-git-probe-')
  const bin = join(dir, 'bin')
  const cwd = join(dir, 'work')
  const log = join(dir, 'calls')
  await mkdir(bin)
  await mkdir(cwd)
  process.env.PATH = `${bin}:${originalPath}`
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).length
  const install = async (answer: string) => {
    const git = join(bin, 'git')
    await writeFile(
      git,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "git version 0-fake"; exit 0; fi',
        `printf x >> "${log}"`,
        `n=$(wc -c < "${log}" | tr -d ' ')`,
        answer,
        '',
      ].join('\n'),
    )
    await chmod(git, 0o755)
    // Run it once: macOS checks a new executable on its first exec, which
    // took seconds on a loaded machine, and the probe gives git 3 s.
    assert.equal(spawnSync(git, ['--version']).status, 0)
  }
  return { cwd, bin, calls, install }
}

test('a git that timed out is asked again, and its answer is then kept', async () => {
  const git = await fakeGit()
  // The first probe outlives the 3 s timeout; the second answers.
  await git.install('if [ "$n" = 1 ]; then exec sleep 30; fi\necho true')
  assert.equal(await isGitWorkTree(git.cwd), false, 'a timed-out probe is no work tree, this turn')
  assert.equal(await isGitWorkTree(git.cwd), true, 'the next turn asks git again')
  assert.equal(await isGitWorkTree(git.cwd), true)
  assert.equal(await git.calls(), 2, 'the answer is kept once git gave one')
})

test('a git that failed to start or died on a signal is asked again', async () => {
  const git = await fakeGit()
  process.env.PATH = git.bin // no git at all: the spawn fails
  assert.equal(await isGitWorkTree(git.cwd), false)
  process.env.PATH = `${git.bin}:${originalPath}`
  await git.install('if [ "$n" = 1 ]; then kill -9 $$; fi\necho true')
  assert.equal(await isGitWorkTree(git.cwd), false, 'killed: no answer')
  assert.equal(await isGitWorkTree(git.cwd), true)
  assert.equal(await git.calls(), 2)
})

test('git saying "not a git repository" is kept, and not asked again', async () => {
  const git = await fakeGit()
  await git.install(
    'echo "fatal: not a git repository (or any of the parent directories): .git" >&2\nexit 128',
  )
  assert.equal(await isGitWorkTree(git.cwd), false)
  assert.equal(await isGitWorkTree(git.cwd), false)
  assert.equal(await git.calls(), 1, 'a definitive answer is cached')
})

// A git in another language refuses in its own words: the exit code, not the
// message, says that git answered.
test('git refusing in another language is kept as well', async () => {
  const git = await fakeGit()
  await git.install(
    'echo "fatal: Kein Git-Repository (oder irgendeines der Elternverzeichnisse): .git" >&2\nexit 128',
  )
  assert.equal(await isGitWorkTree(git.cwd), false)
  assert.equal(await isGitWorkTree(git.cwd), false)
  assert.equal(await git.calls(), 1, 'an exit code is an answer, in any language')
})
