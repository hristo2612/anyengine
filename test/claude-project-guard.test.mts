import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  inheritFromCaller,
  projectBaseline,
  projectConfigChanged,
  upstreamThreadInfoFrom,
} from '../src/claude-project-guard.mjs'
import { DEFAULT_POSTURE } from '../src/posture.mjs'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

test('project baseline: the files the CLI loads, by resolved path, hashed or marked', async () => {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'ae-guard-')))
  try {
    const repo = join(base, 'repo')
    const cwd = join(repo, 'app')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    mkdirSync(join(repo, '.claude'))
    writeFileSync(join(cwd, '.claude', 'settings.json'), 'A')
    writeFileSync(join(repo, '.claude', 'settings.local.json'), 'L')
    writeFileSync(join(base, '.mcp.json'), 'M')
    mkdirSync(join(cwd, '.mcp.json')) // a directory: unreadable, not absent
    symlinkSync(cwd, join(base, 'alias'))

    const baseline = projectBaseline(join(base, 'alias'))
    assert.equal(baseline[join(cwd, '.claude', 'settings.json')], sha('A'))
    assert.equal(baseline[join(cwd, '.claude', 'settings.local.json')], 'absent')
    // The local settings the CLI keeps at the git root, and `.mcp.json` above.
    assert.equal(baseline[join(repo, '.claude', 'settings.local.json')], sha('L'))
    assert.equal(baseline[join(cwd, '.mcp.json')], 'unreadable')
    assert.equal(baseline[join(repo, '.mcp.json')], 'absent')
    assert.equal(baseline[join(base, '.mcp.json')], sha('M'))
    assert.ok(baseline[join(dirname(base), '.mcp.json')], 'up to the filesystem root')

    const posture = { ...DEFAULT_POSTURE, projectBaseline: baseline }
    assert.equal(projectConfigChanged(posture, cwd), false, 'a link to the cwd is the cwd')
    writeFileSync(join(base, '.mcp.json'), 'M2')
    assert.equal(projectConfigChanged(posture, cwd), true, 'an ancestor .mcp.json counts')
    writeFileSync(join(base, '.mcp.json'), 'M')
    assert.equal(projectConfigChanged(posture, cwd), false, 'the original bytes match again')
    assert.equal(projectConfigChanged(DEFAULT_POSTURE, cwd), true, 'no baseline never matches')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// In a linked worktree the CLI keeps `.claude/settings.local.json` at the main
// checkout (the worktree's `.git` file -> gitdir -> commondir).
test('project baseline: a linked worktree covers the main checkout', async () => {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'ae-guard-wt-')))
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
      cwd,
      stdio: 'ignore',
    })
  try {
    const main = join(base, 'main')
    const worktree = join(base, 'wt')
    mkdirSync(join(main, '.claude'), { recursive: true })
    git(main, 'init', '-q')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(main, 'worktree', 'add', '-q', '--detach', worktree)
    const local = join(main, '.claude', 'settings.local.json')
    writeFileSync(local, 'L1')

    const baseline = projectBaseline(worktree)
    assert.equal(baseline[local], sha('L1'), 'the main checkout is fingerprinted')
    assert.equal(baseline[join(worktree, '.claude', 'settings.local.json')], 'absent')
    const posture = { ...DEFAULT_POSTURE, projectBaseline: baseline }
    writeFileSync(local, '{"hooks":{}}')
    assert.equal(projectConfigChanged(posture, worktree), true, 'a change there mismatches')
    writeFileSync(local, 'L1')
    assert.equal(projectConfigChanged(posture, worktree), false)

    // A `.git` file that cannot be followed is marked, so rewriting it mismatches.
    const dotGit = join(worktree, '.git')
    const original = readFileSync(dotGit, 'utf8')
    writeFileSync(dotGit, 'not a gitdir line\n')
    assert.equal(projectBaseline(worktree)[dotGit], 'unreadable')
    assert.equal(projectConfigChanged(posture, worktree), true)
    writeFileSync(dotGit, original)
    assert.equal(projectConfigChanged(posture, worktree), false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("project baseline: a child takes its caller's, and a GPT thread keeps its own", () => {
  const caller = { ...DEFAULT_POSTURE, trust: 'untrusted' as const, projectBaseline: { a: 'x' } }
  const own = { ...DEFAULT_POSTURE, projectBaseline: { a: 'fresh' } }
  assert.deepEqual(inheritFromCaller(own, caller), caller, "never the child's own")
  assert.deepEqual(inheritFromCaller(own, DEFAULT_POSTURE), DEFAULT_POSTURE, 'none stays none')

  const peer = { id: 'desktop', send: () => {}, close: () => {} }
  const bridge = { ...peer, id: 'bridge:1' }
  const answer = { cwd: tmpdir(), approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } }
  const started = upstreamThreadInfoFrom(answer, undefined, peer).posture
  assert.ok(started.projectBaseline, 'an app-started GPT thread records one')
  assert.equal(upstreamThreadInfoFrom(answer, undefined, bridge).posture.projectBaseline, undefined)
  const resumed = upstreamThreadInfoFrom(answer, caller, peer).posture
  assert.deepEqual(resumed.projectBaseline, { a: 'x' }, 'a resume keeps the one it had')
  assert.equal(resumed.trust, 'untrusted')
})

// codex 0.159.0 puts the effective collaborationMode on the thread/resume
// answer (0.155 put it on no lifecycle answer). A GPT thread resumed in plan
// mode now reads as plan from its answer, so a Claude child it spawns plans
// too; before, it read as default until a turn named the mode. The mode is
// the only posture change between the two schemas (no enum value or sandbox
// field was added), and both of its values are covered by the schema gate.
test('posture: a 0.159 thread/resume answer carries its plan mode to the child', () => {
  const answer = {
    cwd: tmpdir(),
    approvalPolicy: 'on-request',
    sandbox: { type: 'readOnly' },
    collaborationMode: { mode: 'plan', settings: { model: 'gpt-5.6-sol' } },
  }
  assert.equal(upstreamThreadInfoFrom(answer, DEFAULT_POSTURE).posture.plan, true)
  const byDefault = { ...answer, collaborationMode: { mode: 'default', settings: {} } }
  assert.equal(upstreamThreadInfoFrom(byDefault, DEFAULT_POSTURE).posture.plan, false)
  // An older server's answer leaves the field out: nothing changes.
  const { collaborationMode: _mode, ...older } = answer
  assert.equal(upstreamThreadInfoFrom(older, DEFAULT_POSTURE).posture.plan, false)
  // The rest of the answer reads exactly as before.
  const resumed = upstreamThreadInfoFrom(answer, DEFAULT_POSTURE).posture
  assert.deepEqual(resumed.fileSystem, { kind: 'read-only' })
  assert.equal(resumed.approval, 'on-request')
})
