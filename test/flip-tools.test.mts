import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { after } from 'node:test'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const flipBackup = resolve('scripts/flip-backup.mjs')
const preflip = resolve('scripts/preflip-check.mjs')

after(() => killChildren())
after(removeTempDirs)

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

// The restart half of ROLLBACK.sh quits and reopens ChatGPT.app. Every run of
// ROLLBACK.sh here puts stand-ins for the commands that half calls (osascript,
// open, pgrep, ps, sleep) in front of PATH, logs each call, and first proves the
// stand-ins are what resolves: nothing below can reach the real app, and
// `calls` says whether the restart half was reached. Only the tests of the
// restart half itself ever let it run, and only against these stand-ins.
// `pgrep` stands for "ChatGPT is still running" when asked to.
const RESTART_COMMANDS = ['osascript', 'open', 'pgrep', 'ps', 'sleep']

function runRollback(root: string, dir: string, args: string[], chatgptRunning = false) {
  const stubs = join(root, 'stubs')
  const calls = join(root, 'stub-calls')
  mkdirSync(stubs, { recursive: true })
  rmSync(calls, { force: true })
  for (const name of RESTART_COMMANDS) {
    const status = name === 'pgrep' && !chatgptRunning ? 1 : 0
    writeFileSync(
      join(stubs, name),
      `#!/bin/sh\necho "\${0##*/} $*" >> '${calls}'\nexit ${status}\n`,
    )
    chmodSync(join(stubs, name), 0o755)
  }
  const env = { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ''}` }
  const resolved = spawnSync(
    'sh',
    ['-c', `for c in ${RESTART_COMMANDS.join(' ')}; do command -v "$c"; done`],
    { encoding: 'utf8', env },
  ).stdout
  assert.deepEqual(
    resolved.trim().split('\n'),
    RESTART_COMMANDS.map((name) => join(stubs, name)),
    'every restart command resolves to a stand-in',
  )
  const result = spawnSync(join(dir, 'ROLLBACK.sh'), args, {
    encoding: 'utf8',
    cwd: root, // not the directory of any target
    env,
  })
  return { ...result, calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '' }
}

// No test may reach the restart half through --copy-only.
function copyOnlyRollback(root: string, dir: string) {
  const result = runRollback(root, dir, ['--copy-only'])
  if (result.calls) assert.fail(`--copy-only reached the restart half: ${result.calls}`)
  return result
}

function backup(home: string, args: string[] = [], cwd?: string) {
  const made = spawnSync(process.execPath, [flipBackup, '--home', home, ...args], {
    encoding: 'utf8',
    ...(cwd ? { cwd } : {}),
  })
  assert.equal(made.status, 0, made.stderr)
  return made.stdout.trim()
}

function scratch(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-flip-'))
  const home = join(root, 'home')
  mkdirSync(home)
  return { root, home }
}

test('flip-backup writes a ROLLBACK.sh whose --copy-only restores every file exactly', () => {
  const { root, home } = scratch()
  try {
    mkdirSync(join(home, 'bin'))
    writeFileSync(join(home, '.zshrc'), 'export A=1\n')
    chmodSync(join(home, '.zshrc'), 0o644)
    writeFileSync(join(home, 'bin', 'codex'), '#!/bin/sh\necho old\n')
    chmodSync(join(home, 'bin', 'codex'), 0o755)
    const dir = backup(home)
    assert.match(dir, /\.anyengine\/rollback-\d{8}T\d{6}Z$/)
    assert.equal(mode(join(dir, 'ROLLBACK.sh')) & 0o100, 0o100, 'ROLLBACK.sh is executable')
    assert.ok(existsSync(join(dir, 'manifest.json')))
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.bak')),
      ['00-.zshrc.bak', '01-codex.bak'],
      'one numbered copy per existing target; runtime.env did not exist',
    )
    assert.equal(mode(join(dir, '01-codex.bak')), 0o755, 'a copy keeps the target mode')

    // The flip: every target changes, and runtime.env appears.
    writeFileSync(join(home, '.zshrc'), 'export A=2\n')
    writeFileSync(join(home, 'bin', 'codex'), '#!/bin/sh\necho new\n')
    chmodSync(join(home, 'bin', 'codex'), 0o700)
    mkdirSync(join(home, '.anyengine'), { recursive: true })
    writeFileSync(join(home, '.anyengine', 'runtime.env'), 'export ANYENGINE_X=1\n')

    const rolled = copyOnlyRollback(root, dir)
    assert.equal(rolled.status, 0, rolled.stderr)
    assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), 'export A=1\n')
    assert.equal(mode(join(home, '.zshrc')), 0o644)
    assert.equal(readFileSync(join(home, 'bin', 'codex'), 'utf8'), '#!/bin/sh\necho old\n')
    assert.equal(mode(join(home, 'bin', 'codex')), 0o755)
    assert.ok(
      !existsSync(join(home, '.anyengine', 'runtime.env')),
      'a file the flip created is removed',
    )
    assert.match(rolled.stdout, /--copy-only: the app was not restarted/)

    // Restoring what is already restored is harmless: the rollback can be
    // exercised before the flip and run again after it.
    const again = copyOnlyRollback(root, dir)
    assert.equal(again.status, 0, again.stderr)
    assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), 'export A=1\n')
    assert.match(again.stdout, /runtime\.env is already absent/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('flip-backup pins relative and oddly named targets to absolute, quoted paths', () => {
  const { root, home } = scratch()
  try {
    // Spaces, quotes, a dollar sign and command substitutions in the names:
    // none of it may be expanded by the shell that reads ROLLBACK.sh, whose
    // working directory is the scratch root.
    const present = `it's "$HOME" $(touch INJECTED).rc`
    const absent = 'made by the flip `touch INJECTED`.env'
    writeFileSync(join(home, present), 'before\n')
    const dir = backup(home, ['--target', present, '--target', absent], home)
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.entries.length, 2)
    for (const entry of manifest.entries) {
      assert.ok(isAbsolute(entry.target), `${entry.target} is absolute`)
    }
    assert.equal(manifest.entries[1].backup, null, 'a target that did not exist has no copy')

    writeFileSync(join(home, present), 'after\n')
    writeFileSync(join(home, absent), 'created by the flip\n')
    const rolled = copyOnlyRollback(root, dir)
    assert.equal(rolled.status, 0, rolled.stderr)
    assert.equal(readFileSync(join(home, present), 'utf8'), 'before\n')
    assert.ok(!existsSync(join(home, absent)))
    assert.ok(!existsSync(join(root, 'INJECTED')), 'a path was executed instead of quoted')
    assert.ok(!existsSync(join(home, 'INJECTED')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ROLLBACK.sh reports a file it could not restore and leaves everything else alone', () => {
  const { root, home } = scratch()
  try {
    writeFileSync(join(home, 'a.rc'), 'a before\n')
    writeFileSync(join(home, 'b.rc'), 'b before\n')
    const missing = join(home, 'created-later')
    const dir = backup(home, [
      '--target',
      join(home, 'a.rc'),
      '--target',
      join(home, 'b.rc'),
      '--target',
      missing,
    ])
    writeFileSync(join(home, 'a.rc'), 'a after\n')
    writeFileSync(join(home, 'b.rc'), 'b after\n')
    rmSync(join(dir, '00-a.rc.bak')) // this copy is gone: a.rc cannot be restored
    // The flip made the path a directory: removing it would need rm -r, which
    // ROLLBACK.sh never runs.
    mkdirSync(missing)
    writeFileSync(join(missing, 'keep.txt'), "not the rollback's to delete\n")

    const rolled = copyOnlyRollback(root, dir)
    assert.equal(rolled.status, 1, 'a partial restore is a failure, not a silent success')
    assert.match(rolled.stderr, /FAILED to restore .*a\.rc/)
    assert.match(rolled.stderr, /FAILED to remove .*created-later/)
    assert.doesNotMatch(rolled.stdout, /--copy-only: the app was not restarted/)
    assert.equal(
      readFileSync(join(home, 'b.rc'), 'utf8'),
      'b before\n',
      'the rest is still restored',
    )
    assert.equal(readFileSync(join(home, 'a.rc'), 'utf8'), 'a after\n')
    assert.equal(readFileSync(join(missing, 'keep.txt'), 'utf8'), "not the rollback's to delete\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ROLLBACK.sh refuses any argument but --copy-only before it touches a file', () => {
  const { root, home } = scratch()
  try {
    writeFileSync(join(home, 'a.rc'), 'before\n')
    const dir = backup(home, ['--target', join(home, 'a.rc')])
    writeFileSync(join(home, 'a.rc'), 'after\n')
    for (const args of [
      ['--copy_only'],
      ['--copyonly'],
      ['-n'],
      ['--help'],
      [''],
      ['--copy-only', 'x'],
    ]) {
      const refused = runRollback(root, dir, args)
      const shown = JSON.stringify(args)
      assert.equal(refused.status, 2, shown)
      assert.match(refused.stderr, /usage: ROLLBACK\.sh \[--copy-only\]/, shown)
      assert.equal(refused.calls, '', `${shown} reached the restart half`)
      assert.equal(readFileSync(join(home, 'a.rc'), 'utf8'), 'after\n', `${shown} restored a file`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ROLLBACK.sh does not write into a directory or through a symlink that replaced a target', () => {
  const { root, home } = scratch()
  try {
    const asDir = join(home, 'dir.rc')
    const asFileLink = join(home, 'file-link.rc')
    const asDirLink = join(home, 'dir-link.rc')
    for (const path of [asDir, asFileLink, asDirLink]) writeFileSync(path, 'before\n')
    const dir = backup(home, ['--target', asDir, '--target', asFileLink, '--target', asDirLink])

    // The flip replaces the first with a directory and the others with links.
    const victim = join(root, 'victim')
    const linked = join(root, 'linked-dir')
    writeFileSync(victim, 'victim\n')
    mkdirSync(linked)
    for (const path of [asDir, asFileLink, asDirLink]) rmSync(path)
    mkdirSync(asDir)
    writeFileSync(join(asDir, 'inside'), 'x\n')
    symlinkSync(victim, asFileLink)
    symlinkSync(linked, asDirLink)

    const rolled = copyOnlyRollback(root, dir)
    assert.equal(rolled.status, 1, 'a target that is now a directory is a failure')
    assert.match(rolled.stderr, /FAILED to restore .*dir\.rc: it is now a directory/)
    assert.deepEqual(readdirSync(asDir), ['inside'], 'nothing was written into the directory')
    assert.equal(readFileSync(victim, 'utf8'), 'victim\n', 'the link target was not overwritten')
    assert.deepEqual(readdirSync(linked), [], 'nothing was written into the linked directory')
    for (const path of [asFileLink, asDirLink]) {
      assert.ok(!lstatSync(path).isSymbolicLink(), `${path} is a file again, not a link`)
      assert.equal(readFileSync(path, 'utf8'), 'before\n')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('flip-backup refuses a symlink or a directory as a target, and writes nothing', () => {
  const { root, home } = scratch()
  try {
    writeFileSync(join(home, 'real'), 'x\n')
    symlinkSync(join(home, 'real'), join(home, 'link.rc'))
    symlinkSync(join(home, 'gone'), join(home, 'dangling.rc'))
    mkdirSync(join(home, 'dir.rc'))
    const cases = [
      ['link.rc', /is a symbolic link/],
      ['dangling.rc', /is a symbolic link/],
      ['dir.rc', /is not a regular file/],
    ] as const
    for (const [name, message] of cases) {
      const made = spawnSync(
        process.execPath,
        [flipBackup, '--home', home, '--target', join(home, name)],
        {
          encoding: 'utf8',
        },
      )
      assert.equal(made.status, 1, name)
      assert.match(made.stderr, message, name)
      assert.ok(!existsSync(join(home, '.anyengine')), `${name}: no rollback directory was made`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ROLLBACK.sh exits 1 instead of reopening the app when the quit is not confirmed', () => {
  const { root, home } = scratch()
  try {
    writeFileSync(join(home, 'a.rc'), 'before\n')
    const dir = backup(home, ['--target', join(home, 'a.rc')])
    writeFileSync(join(home, 'a.rc'), 'after\n')

    // Every command here is a stand-in (see runRollback); pgrep keeps matching.
    const stuck = runRollback(root, dir, [], true)
    assert.equal(stuck.status, 1)
    assert.match(stuck.stderr, /ChatGPT\.app is still running .* the app was not reopened/)
    assert.match(stuck.calls, /^osascript -e quit app "ChatGPT"$/m, 'it did ask the app to quit')
    assert.doesNotMatch(stuck.calls, /^open /m, 'it must not reopen an app that never quit')
    assert.doesNotMatch(stuck.stdout, /done/)
    assert.equal(readFileSync(join(home, 'a.rc'), 'utf8'), 'before\n', 'the files were restored')

    // The same script, with the app gone after the quit, reopens it.
    const clean = runRollback(root, dir, [], false)
    assert.equal(clean.status, 0, clean.stderr)
    assert.match(clean.calls, /^open -a \/Applications\/ChatGPT\.app$/m)
    assert.match(clean.stdout, /\[rollback\] done/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ROLLBACK.sh never removes recursively and only restarts the app after the copy step', () => {
  const { root, home } = scratch()
  try {
    writeFileSync(join(home, 'a.rc'), 'a\n')
    const dir = backup(home, ['--target', join(home, 'a.rc')])
    const script = readFileSync(join(dir, 'ROLLBACK.sh'), 'utf8')
    const parsed = spawnSync('bash', ['-n', join(dir, 'ROLLBACK.sh')], { encoding: 'utf8' })
    assert.equal(parsed.status, 0, parsed.stderr)
    assert.doesNotMatch(script, /\brm\s+-\w*[rR]/, 'no recursive removal')
    assert.match(script, /\bcp -p /)
    const copyOnlyExit = script.indexOf('--copy-only: the app was not restarted')
    assert.ok(copyOnlyExit > 0)
    for (const restart of ['osascript', 'open -a', 'kill ']) {
      assert.ok(
        script.indexOf(restart) > copyOnlyExit,
        `${restart} comes after the --copy-only exit`,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// preflip-check asks launchd whether Sparkle's installer job is loaded. Every
// run here gets a stand-in `launchctl` in front of PATH that answers with
// `status` (113: no such job) and logs its arguments, so a real update staged
// on the machine running the suite can never decide a test. The stand-ins
// live in their own directory: a test's homes may be relative or empty.
const launchctlRoot = mkdtempSync(join(tmpdir(), 'anyengine-launchctl-'))
after(() => rmSync(launchctlRoot, { recursive: true, force: true }))

function launchctlPath(status = 113): string {
  const stubs = join(launchctlRoot, `launchctl-${status}`)
  mkdirSync(stubs, { recursive: true })
  writeFileSync(
    join(stubs, 'launchctl'),
    `#!/bin/sh\necho "$*" >> '${join(stubs, 'calls')}'\nexit ${status}\n`,
  )
  chmodSync(join(stubs, 'launchctl'), 0o755)
  // preflip-check reads the bundle id with plutil, which only macOS has. On
  // the Linux CI runner a stand-in reads the XML plists fakeApp writes.
  if (process.platform !== 'darwin') {
    writeFileSync(
      join(stubs, 'plutil'),
      [
        '#!/bin/sh',
        'for plist; do :; done',
        'id=$(sed -n \'/<key>CFBundleIdentifier<\\/key>/{n;s/.*<string>\\(.*\\)<\\/string>.*/\\1/p;}\' "$plist") || exit 1',
        '[ -n "$id" ] || { echo "No value at that key path" >&2; exit 1; }',
        'printf \'%s\\n\' "$id"',
        '',
      ].join('\n'),
    )
    chmodSync(join(stubs, 'plutil'), 0o755)
  }
  return `${stubs}:${process.env.PATH ?? ''}`
}

// An app bundle with just the Info.plist preflip-check reads its bundle id
// from; Sparkle's cache and installer job are named after that id.
function fakeApp(id: string): string {
  const app = join(launchctlRoot, `${id.replace(/[^A-Za-z0-9.-]/g, '_')}.app`)
  mkdirSync(join(app, 'Contents'), { recursive: true })
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n' +
      `\t<key>CFBundleIdentifier</key>\n\t<string>${id}</string>\n</dict>\n</plist>\n`,
  )
  return app
}

// preflip-check asks lsof who holds the exec rollouts in its window. Every
// quietCheck names a stand-in with ANYENGINE_LSOF (the check prefers
// /usr/sbin/lsof to PATH) that answers like lsof for a file no process holds
// (exit 1, nothing printed) unless a test says otherwise, and logs its
// arguments to lsofCalls. It is run once here: the check gives lsof 5 s, and
// macOS can take seconds over a script's first exec.
type FakeLsof = { stdout?: string; stderr?: string; status?: number }
const lsofBin = join(launchctlRoot, 'lsof-bin')
const lsofCalls = join(launchctlRoot, 'lsof-calls')
mkdirSync(lsofBin)
writeFileSync(
  join(lsofBin, 'lsof'),
  [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${lsofCalls}'`,
    '[ -z "$FAKE_LSOF_STDERR" ] || printf \'%s\\n\' "$FAKE_LSOF_STDERR" >&2',
    '[ -z "$FAKE_LSOF_STDOUT" ] || printf \'%s\\n\' "$FAKE_LSOF_STDOUT"',
    'exit "${FAKE_LSOF_STATUS:-1}"',
    '',
  ].join('\n'),
)
chmodSync(join(lsofBin, 'lsof'), 0o755)
assert.equal(spawnSync(join(lsofBin, 'lsof'), { env: { FAKE_LSOF_STATUS: '0' } }).status, 0)
rmSync(lsofCalls, { force: true })

function quietCheck(
  codexHome: string,
  adapterHome: string,
  seconds = '120',
  extra: {
    app?: string
    home?: string
    launchctl?: number
    lsof?: FakeLsof
    preload?: string
  } = {},
) {
  return spawnSync(
    process.execPath,
    [
      ...(extra.preload ? ['--import', extra.preload] : []),
      preflip,
      '--codex-home',
      codexHome,
      '--adapter-home',
      adapterHome,
      '--quiet-seconds',
      seconds,
      '--app',
      extra.app ?? fakeApp('com.example.quiet'),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: launchctlPath(extra.launchctl),
        ...(extra.home ? { HOME: extra.home } : {}),
        ANYENGINE_LSOF: join(lsofBin, 'lsof'),
        FAKE_LSOF_STDOUT: extra.lsof?.stdout ?? '',
        FAKE_LSOF_STDERR: extra.lsof?.stderr ?? '',
        FAKE_LSOF_STATUS: String(extra.lsof?.status ?? 1),
      },
    },
  )
}

test('preflip-check refuses while a rollout was written or the adapter logged turn activity', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-preflip-'))
  try {
    const codexHome = join(root, 'codex')
    const adapterHome = join(root, 'adapter')
    const day = join(codexHome, 'sessions', '2026', '09', '29')
    mkdirSync(day, { recursive: true })
    mkdirSync(adapterHome, { recursive: true })
    writeQuietLog(adapterHome)
    const rollout = join(day, 'rollout-a.jsonl')
    const log = join(adapterHome, 'debug.jsonl')
    writeFileSync(rollout, '{}\n')
    const old = new Date(Date.now() - 600_000)
    utimesSync(log, old, old)

    const busy = quietCheck(codexHome, adapterHome)
    assert.equal(busy.status, 1)
    assert.match(busy.stderr, /rollout-a\.jsonl was written \d+s ago/)

    utimesSync(rollout, old, old)
    const quiet = quietCheck(codexHome, adapterHome)
    assert.equal(quiet.status, 0, quiet.stderr)
    assert.match(quiet.stdout, /preflip-check: quiet/)
    assert.match(
      quiet.stdout,
      /sessions: 0 app rollouts in the window, 0 recent rollouts ignored \(not the app's\)/,
      'the report names what it found',
    )
    assert.match(
      quiet.stdout,
      /debug\.jsonl: 0 turn-activity events in the window, 0 background events ignored/,
    )
    assert.match(quiet.stdout, /state\.sqlite: absent/)

    writeLog(adapterHome, [logEvent('rpc.request', 'turn/start')])
    const logBusy = quietCheck(codexHome, adapterHome)
    assert.equal(logBusy.status, 1)
    assert.match(logBusy.stderr, /debug\.jsonl: 1 turn-activity events/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preflip-check refuses while an adapter turn is still in progress', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-preflip-'))
  try {
    const adapterHome = join(root, 'adapter')
    mkdirSync(adapterHome, { recursive: true })
    writeQuietLog(adapterHome)
    mkdirSync(join(root, 'codex'))
    const db = new DatabaseSync(join(adapterHome, 'state.sqlite'))
    db.exec('CREATE TABLE turns (id TEXT, thread_id TEXT, status TEXT, started_at INTEGER)')
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO turns VALUES (?, ?, ?, ?)').run(
      'stale',
      't',
      'inProgress',
      now - 86_400,
    )
    db.close()
    assert.equal(quietCheck(join(root, 'codex'), adapterHome).status, 0, 'a day-old row is stale')

    const live = new DatabaseSync(join(adapterHome, 'state.sqlite'))
    live.prepare('INSERT INTO turns VALUES (?, ?, ?, ?)').run('live', 't', 'inProgress', now - 30)
    live.close()
    const busy = quietCheck(join(root, 'codex'), adapterHome)
    assert.equal(busy.status, 1)
    assert.match(busy.stderr, /1 adapter turn is still in progress/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preflip-check treats a turn of unknown age as in progress, and a finished one as done', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-preflip-'))
  try {
    const adapterHome = join(root, 'adapter')
    mkdirSync(adapterHome, { recursive: true })
    writeQuietLog(adapterHome)
    mkdirSync(join(root, 'codex'))
    const db = new DatabaseSync(join(adapterHome, 'state.sqlite'))
    db.exec('CREATE TABLE turns (id TEXT, thread_id TEXT, status TEXT, started_at INTEGER)')
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO turns VALUES (?, ?, ?, ?)').run('done', 't', 'completed', now - 5)
    db.close()
    assert.equal(quietCheck(join(root, 'codex'), adapterHome).status, 0, 'a fresh finished turn')

    const unknown = new DatabaseSync(join(adapterHome, 'state.sqlite'))
    unknown.prepare('INSERT INTO turns VALUES (?, ?, ?, ?)').run('odd', 't', 'inProgress', null)
    unknown.close()
    const busy = quietCheck(join(root, 'codex'), adapterHome)
    assert.equal(busy.status, 1)
    assert.match(busy.stderr, /1 adapter turn is still in progress/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preflip-check does not say quiet when it cannot tell', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-preflip-'))
  try {
    const codexHome = join(root, 'codex')
    const adapterHome = join(root, 'adapter')
    mkdirSync(codexHome)
    mkdirSync(adapterHome)
    writeQuietLog(adapterHome)
    const db = new DatabaseSync(join(adapterHome, 'state.sqlite'))
    db.exec('CREATE TABLE unrelated (id TEXT)') // no turns table
    db.close()
    const unreadable = quietCheck(codexHome, adapterHome)
    assert.equal(unreadable.status, 1)
    assert.match(unreadable.stderr, /cannot tell/)
    assert.doesNotMatch(unreadable.stdout, /quiet/)

    for (const bad of ['soon', '-5', '']) {
      const refused = quietCheck(codexHome, join(root, 'nothing'), bad)
      assert.equal(refused.status, 2, `--quiet-seconds ${JSON.stringify(bad)} is a usage error`)
      assert.match(refused.stderr, /--quiet-seconds/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preflip-check does not say quiet about a home it could not find', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-preflip-'))
  try {
    const codexHome = join(root, 'codex')
    const adapterHome = join(root, 'adapter')
    mkdirSync(codexHome)
    mkdirSync(adapterHome)
    writeQuietLog(adapterHome)

    // A mistyped or empty home is not "no activity".
    const missing = [
      [join(root, 'cdoex'), adapterHome, /Codex home .*cdoex/],
      ['', adapterHome, /Codex home/],
      [codexHome, join(root, 'adpater'), /adapter home .*adpater/],
      [codexHome, '', /adapter home/],
    ] as const
    for (const [codex, adapter, message] of missing) {
      const refused = quietCheck(codex, adapter)
      const shown = `${JSON.stringify(codex)} ${JSON.stringify(adapter)}`
      assert.equal(refused.status, 1, shown)
      assert.match(refused.stderr, /cannot tell/, shown)
      assert.match(refused.stderr, message, shown)
      assert.doesNotMatch(refused.stdout, /quiet/, shown)
    }

    // Existing homes with an old readable log are quiet; absent state is reported.
    const empty = quietCheck(codexHome, adapterHome)
    assert.equal(empty.status, 0, empty.stderr)
    assert.ok(
      empty.stdout.includes(
        `${join(codexHome, 'sessions')}: 0 app rollouts in the window, 0 recent rollouts ignored (not the app's)`,
      ),
      empty.stdout,
    )
    assert.ok(
      empty.stdout.includes(`${join(adapterHome, 'debug.jsonl')}: 0 turn-activity events`),
      empty.stdout,
    )
    assert.ok(empty.stdout.includes(`${join(adapterHome, 'state.sqlite')}: absent`), empty.stdout)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preflip-check with no options finds the homes from the environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-preflip-'))
  try {
    const codexHome = join(root, 'codex')
    mkdirSync(join(codexHome, 'anyengine'), { recursive: true })
    writeQuietLog(join(codexHome, 'anyengine'))
    const run = (extra: Record<string, string>) =>
      spawnSync(process.execPath, [preflip], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
          CODEX_HOME: codexHome,
          ANYENGINE_HOME: '',
          ANYENGINE_CHATGPT_APP: fakeApp('com.example.env'),
          PATH: launchctlPath(),
          ...extra,
        },
      })

    const defaults = run({})
    assert.equal(defaults.status, 0, defaults.stderr)
    assert.ok(
      defaults.stdout.includes(join(codexHome, 'anyengine', 'debug.jsonl')),
      defaults.stdout,
    )

    // Sparkle's cache is looked for under HOME, named after the bundle id of
    // the app ANYENGINE_CHATGPT_APP names; that there is none is said.
    assert.ok(
      defaults.stdout.includes(
        `${join(root, 'Library', 'Caches', 'com.example.env', 'org.sparkle-project.Sparkle')}: absent`,
      ),
      defaults.stdout,
    )
    assert.match(defaults.stdout, /gui\/\d+\/com\.example\.env-sparkle-updater: not loaded/)

    const stale = run({ ANYENGINE_HOME: join(root, 'not-there') })
    assert.equal(stale.status, 1, 'an ANYENGINE_HOME that is not there is not "no activity"')
    assert.match(stale.stderr, /cannot tell/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 2026-09-30: the quit for a flip installed a staged app update (26.911 to
// 26.928), which moved the bundled codex under the adapter. A staged update
// is what Sparkle 2 leaves while it waits for the quit: the download, the
// unpacked update, or its installer job loaded in launchd.
test('preflip-check refuses while an app update is staged', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-preflip-'))
  try {
    const codexHome = join(root, 'codex')
    const adapterHome = join(root, 'adapter')
    mkdirSync(codexHome, { recursive: true })
    mkdirSync(adapterHome, { recursive: true })
    writeQuietLog(adapterHome)
    const app = fakeApp('com.example.staged')
    const sparkle = join(
      root,
      'Library',
      'Caches',
      'com.example.staged',
      'org.sparkle-project.Sparkle',
    )
    const check = (launchctl = 113) =>
      quietCheck(codexHome, adapterHome, '120', { app, home: root, launchctl })
    const refused = /preflip-check: not quiet: an app update is staged and would install on restart/
    const job = /gui\/\d+\/com\.example\.staged-sparkle-updater/

    // No Sparkle cache yet: quiet, and the report says it is absent.
    const absent = check()
    assert.equal(absent.status, 0, absent.stderr)
    assert.ok(absent.stdout.includes(`${sparkle}: absent`), absent.stdout)

    // Sparkle's own empty directories, and a Finder file, are not an update.
    for (const dir of ['Installation', 'PersistentDownloads', 'Launcher']) {
      mkdirSync(join(sparkle, dir), { recursive: true })
    }
    writeFileSync(join(sparkle, 'Installation', '.DS_Store'), '')
    const quiet = check()
    assert.equal(quiet.status, 0, quiet.stderr)
    assert.ok(quiet.stdout.includes(`${sparkle}: no staged update`), quiet.stdout)
    // launchd is asked about the job in the user's own domain, by bundle id.
    assert.match(
      readFileSync(join(launchctlRoot, 'launchctl-113', 'calls'), 'utf8'),
      new RegExp(`^print ${job.source}$`, 'm'),
    )

    // The unpacked update, as Sparkle 2.9 lays it out while it waits.
    const unpacked = join(sparkle, 'Installation', 'U6FgBSyWa')
    mkdirSync(join(unpacked, '0xKRvTLll', 'ChatGPT.app'), { recursive: true })
    writeFileSync(join(unpacked, 'ChatGPT.zip'), '')
    const installing = check()
    assert.equal(installing.status, 1)
    assert.match(installing.stderr, refused)
    assert.ok(installing.stderr.includes(`${join(sparkle, 'Installation')} holds U6FgBSyWa`))
    assert.match(installing.stderr, /quit and reopen ChatGPT\.app/)
    rmSync(unpacked, { recursive: true })

    // A finished download not yet unpacked.
    mkdirSync(join(sparkle, 'PersistentDownloads', 'x1'))
    const downloaded = check()
    assert.equal(downloaded.status, 1)
    assert.ok(downloaded.stderr.includes(`${join(sparkle, 'PersistentDownloads')} holds x1`))
    rmSync(join(sparkle, 'PersistentDownloads', 'x1'), { recursive: true })

    // The installer job, waiting in launchd for the app to quit.
    const waiting = check(0)
    assert.equal(waiting.status, 1)
    assert.match(waiting.stderr, refused)
    assert.match(waiting.stderr, new RegExp(`launchd job ${job.source} is loaded`))

    // A launchctl answer that is neither yes nor no is not "no update".
    const odd = check(5)
    assert.equal(odd.status, 1)
    assert.match(odd.stderr, new RegExp(`cannot tell .*launchctl print ${job.source} gave exit 5`))

    // A busy home and a staged update are both reported.
    mkdirSync(join(sparkle, 'PersistentDownloads', 'x2'))
    writeLog(adapterHome, [logEvent('rpc.request', 'turn/start')])
    const both = check()
    assert.equal(both.status, 1)
    assert.match(both.stderr, /debug\.jsonl: 1 turn-activity events/)
    assert.match(both.stderr, refused)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Only a path that does not exist is empty. A Sparkle cache or a Codex home
// that cannot be read is "cannot tell": the reviewer's staged update under a
// mode-000 cache used to read "no staged update", exit 0.
test('preflip-check does not call an unreadable cache or home quiet', {
  skip: process.getuid?.() === 0 && 'root reads through mode 000',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-preflip-'))
  const locked: string[] = []
  const lock = (dir: string) => {
    chmodSync(dir, 0o000)
    locked.push(dir)
  }
  const unlock = () => {
    for (const dir of locked.splice(0)) chmodSync(dir, 0o755)
  }
  try {
    const codexHome = join(root, 'codex')
    const adapterHome = join(root, 'adapter')
    mkdirSync(join(codexHome, 'sessions'), { recursive: true })
    mkdirSync(adapterHome, { recursive: true })
    writeQuietLog(adapterHome)
    const app = fakeApp('com.example.locked')
    const caches = join(root, 'Library', 'Caches', 'com.example.locked')
    const sparkle = join(caches, 'org.sparkle-project.Sparkle')
    mkdirSync(join(sparkle, 'Installation', 'U6FgBSyWa'), { recursive: true })
    const check = () => quietCheck(codexHome, adapterHome, '120', { app, home: root })
    const cannotTell = /cannot tell whether a turn is in flight or an update is staged .*EACCES/

    for (const dir of [sparkle, join(sparkle, 'Installation'), caches]) {
      lock(dir)
      const result = check()
      unlock()
      assert.equal(result.status, 1, `${dir}: ${result.stdout}`)
      assert.match(result.stderr, cannotTell, dir)
      assert.doesNotMatch(result.stdout, /quiet/, dir)
    }

    // The same for the turn side: an unreadable sessions directory, or a
    // Codex home that cannot be searched, is not "no rollouts".
    rmSync(join(sparkle, 'Installation', 'U6FgBSyWa'), { recursive: true })
    for (const dir of [join(codexHome, 'sessions'), codexHome]) {
      lock(dir)
      const result = check()
      unlock()
      assert.equal(result.status, 1, `${dir}: ${result.stdout}`)
      assert.match(result.stderr, /cannot tell .*EACCES/, dir)
    }
    assert.equal(check().status, 0, 'readable again, and quiet')
  } finally {
    unlock()
    rmSync(root, { recursive: true, force: true })
  }
})

// The bundle id comes from the app: no readable Info.plist, no answer.
test("preflip-check cannot tell without the app's bundle id", () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-preflip-'))
  try {
    const codexHome = join(root, 'codex')
    mkdirSync(codexHome, { recursive: true })
    writeQuietLog(codexHome)
    const missing = quietCheck(codexHome, codexHome, '120', { app: join(root, 'No.app') })
    assert.equal(missing.status, 1)
    assert.match(
      missing.stderr,
      /cannot tell .*plutil cannot read CFBundleIdentifier from .*No\.app\/Contents\/Info\.plist/,
    )
    const odd = fakeApp('../escape')
    const refused = quietCheck(codexHome, codexHome, '120', { app: odd })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /cannot tell .*no usable CFBundleIdentifier/)
    if (process.platform === 'darwin') {
      // A binary Info.plist is read with plutil.
      const binary = fakeApp('com.example.binary')
      const plist = join(binary, 'Contents', 'Info.plist')
      assert.equal(spawnSync('plutil', ['-convert', 'binary1', plist]).status, 0)
      const read = quietCheck(codexHome, codexHome, '120', { app: binary, home: root })
      assert.equal(read.status, 0, read.stderr)
      assert.match(read.stdout, /com\.example\.binary-sparkle-updater: not loaded/)
      // The app's own key, not the first one spelled that way: a nested dict
      // that comes first does not name the cache.
      const nested = fakeApp('com.example.top')
      writeFileSync(
        join(nested, 'Contents', 'Info.plist'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n' +
          '\t<key>A</key>\n\t<dict>\n\t\t<key>CFBundleIdentifier</key>\n' +
          '\t\t<string>com.example.nested</string>\n\t</dict>\n' +
          '\t<key>CFBundleIdentifier</key>\n\t<string>com.example.top</string>\n</dict>\n</plist>\n',
      )
      const top = quietCheck(codexHome, codexHome, '120', { app: nested, home: root })
      assert.equal(top.status, 0, top.stderr)
      assert.match(top.stdout, /gui\/\d+\/com\.example\.top-sparkle-updater: not loaded/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A rollout's first line, as codex writes it: `session_meta` naming the source.
const meta = (source: unknown) =>
  `${JSON.stringify({ type: 'session_meta', payload: { id: 'x', source } })}\n`

// 2026-09-30: a batch job's `codex exec` rollouts kept an app restart waiting
// about 50 minutes while the app was idle. Only a rollout that says it is a
// `codex exec` session's is ignored; anything else counts, `cli` and `mcp`
// included: the app appends its turns to a CLI thread it opens, which keeps
// `source: "cli"`, and codex 0.159 writes `mcp` for an app-server session source.
test('preflip-check ignores codex exec rollouts, but not the app’s, a sub-agent’s, a CLI’s or an MCP one’s', async () => {
  const root = await tempDir('anyengine-preflip-')
  const codexHome = join(root, 'codex')
  const adapterHome = join(root, 'adapter')
  const day = join(codexHome, 'sessions', '2026', '09', '30')
  mkdirSync(day, { recursive: true })
  mkdirSync(adapterHome, { recursive: true })
  writeQuietLog(adapterHome)
  writeFileSync(join(day, 'rollout-exec-a.jsonl'), meta('exec'))
  writeFileSync(join(day, 'rollout-exec-b.jsonl'), meta('exec'))
  const quiet = quietCheck(codexHome, adapterHome)
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.match(
    quiet.stdout,
    /0 app rollouts in the window, 2 recent rollouts ignored \(not the app's\)/,
  )

  // Exit 1 also means "cannot tell": each of these must be named as busy.
  const busyWith = (name: string, content: string, why: string) => {
    const path = join(day, name)
    writeFileSync(path, content)
    const busy = quietCheck(codexHome, adapterHome)
    assert.equal(busy.status, 1, why)
    assert.ok(busy.stderr.includes(`${path} was written `), `${why}: ${busy.stderr}`)
    assert.doesNotMatch(busy.stderr, /cannot tell/, why)
    rmSync(path)
  }
  busyWith(
    'rollout-sub.jsonl',
    meta({ subagent: { thread_spawn: { parent_thread_id: 'p' } } }),
    'a sub-agent counts as busy',
  )
  busyWith('rollout-app.jsonl', meta('vscode'), "the app's own rollout counts as busy")
  busyWith('rollout-cli.jsonl', meta('cli'), 'a CLI thread the app may have opened counts as busy')
  busyWith('rollout-mcp.jsonl', meta('mcp'), 'an MCP or app-server session source counts as busy')
  busyWith('rollout-junk.jsonl', 'not json\n', 'unreadable counts as busy')
  busyWith('rollout-bare.jsonl', '{}\n', 'no session_meta counts as busy')
  busyWith('rollout-odd.jsonl', meta('something-new'), 'an unknown source counts as busy')
  busyWith('rollout-none.jsonl', meta(undefined), 'no source counts as busy')
  busyWith(
    'rollout-turn.jsonl',
    `${JSON.stringify({ type: 'turn_context', payload: { source: 'exec' } })}\n`,
    'a first line that is not session_meta counts as busy',
  )
  if (process.getuid?.() !== 0) {
    const locked = join(day, 'rollout-locked.jsonl')
    writeFileSync(locked, meta('exec'))
    chmodSync(locked, 0o000)
    const busy = quietCheck(codexHome, adapterHome)
    chmodSync(locked, 0o644)
    assert.equal(busy.status, 1, 'a rollout that cannot be opened counts as busy')
    assert.ok(busy.stderr.includes(`${locked} was written `), busy.stderr)
  }
})

// The app's turn is not always the newest rollout, nor in today's folder: a
// thread started yesterday is appended to in its own day folder.
test('preflip-check classifies every rollout in the window, in every day folder', async () => {
  const root = await tempDir('anyengine-preflip-')
  const codexHome = join(root, 'codex')
  const adapterHome = join(root, 'adapter')
  const month = join(codexHome, 'sessions', '2026', '09')
  mkdirSync(join(month, '29'), { recursive: true })
  mkdirSync(join(month, '30'), { recursive: true })
  mkdirSync(adapterHome)
  writeQuietLog(adapterHome)
  const exec = join(month, '30', 'rollout-exec.jsonl')

  const app = join(month, '30', 'rollout-app.jsonl')
  writeFileSync(app, meta('vscode'))
  const earlier = new Date(Date.now() - 30_000)
  utimesSync(app, earlier, earlier)
  writeFileSync(exec, meta('exec'))
  const notNewest = quietCheck(codexHome, adapterHome)
  assert.equal(notNewest.status, 1, 'an app rollout older than a fresh exec one is busy')
  assert.ok(notNewest.stderr.includes(`${app} was written `), notNewest.stderr)
  assert.doesNotMatch(notNewest.stderr, /rollout-exec\.jsonl/)
  rmSync(app)

  const yesterday = join(month, '29', 'rollout-app.jsonl')
  writeFileSync(yesterday, meta('vscode'))
  writeFileSync(exec, meta('exec'))
  const olderFolder = quietCheck(codexHome, adapterHome)
  assert.equal(olderFolder.status, 1, "an app rollout in yesterday's folder is busy")
  assert.ok(olderFolder.stderr.includes(`${yesterday} was written `), olderFolder.stderr)
})

// A `codex --remote` TUI attached to the app's adapter can resume an exec
// thread, and codex keeps a loaded thread's rollout open for writing: an exec
// rollout an app-server holds is the app's. Holders are real processes, so
// the real ps reads their command lines; lsof is the stand-in.
test('preflip-check counts an exec rollout an app-server holds open', async () => {
  const root = await tempDir('anyengine-preflip-')
  const codexHome = join(root, 'codex')
  const adapterHome = join(root, 'adapter')
  const day = join(codexHome, 'sessions', '2026', '09', '30')
  mkdirSync(day, { recursive: true })
  mkdirSync(adapterHome)
  writeQuietLog(adapterHome)
  const old = join(day, 'rollout-old-exec.jsonl')
  writeFileSync(old, meta('exec'))
  const earlier = new Date(Date.now() - 600_000)
  utimesSync(old, earlier, earlier)
  const execA = join(day, 'rollout-exec-a.jsonl')
  const execB = join(day, 'rollout-exec-b.jsonl')
  writeFileSync(execA, meta('exec'))
  writeFileSync(execB, meta('exec'))
  const idle = ['-e', 'setInterval(() => {}, 1000)']
  const appServer = spawn(process.execPath, [...idle, 'app-server', '--listen', 'stdio://'], {
    stdio: 'ignore',
  })
  const batch = spawn(process.execPath, [...idle, 'exec', '--json'], { stdio: 'ignore' })
  const gone = spawnSync(process.execPath, ['-e', '']).pid
  const heldBy = (pid: number | undefined) => ({ stdout: `p${pid}\nf12\nn${execB}`, status: 1 })

  // Held by no one: one lsof call, naming only the exec rollouts in the window.
  rmSync(lsofCalls, { force: true })
  const quiet = quietCheck(codexHome, adapterHome)
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.match(quiet.stdout, /0 app rollouts in the window, 2 recent rollouts ignored/)
  const calls = readFileSync(lsofCalls, 'utf8').trim().split('\n')
  assert.equal(calls.length, 1, calls.join('\n'))
  const call = calls[0] ?? ''
  assert.ok(call.startsWith('-w -Fpn -- '), call)
  assert.deepEqual(call.split(' ').slice(3).sort(), [execA, execB].sort())

  const held = quietCheck(codexHome, adapterHome, '120', { lsof: heldBy(appServer.pid) })
  assert.equal(held.status, 1, 'held open by an app-server')
  assert.ok(
    held.stderr.includes(`${execB} is held open by an app-server (pid ${appServer.pid})`),
    held.stderr,
  )
  assert.doesNotMatch(held.stderr, /cannot tell/)

  for (const [pid, who] of [
    [batch.pid, 'the batch job itself'],
    [gone, 'a process that has exited'],
  ] as const) {
    const other = quietCheck(codexHome, adapterHome, '120', { lsof: heldBy(pid) })
    assert.equal(other.status, 0, `held by ${who}: ${other.stderr}`)
  }

  for (const [lsof, why] of [
    [{ stderr: 'lsof: status error on a rollout', status: 1 }, 'an lsof that complains'],
    [{ status: 2 }, 'an lsof that exits 2'],
    [{ stdout: 'pabc\nnx', status: 0 }, 'an lsof that lists an odd pid'],
  ] as const) {
    const refused = quietCheck(codexHome, adapterHome, '120', { lsof })
    assert.equal(refused.status, 1, why)
    assert.match(refused.stderr, /cannot tell.*lsof/, `${why}: ${refused.stderr}`)
    assert.doesNotMatch(refused.stdout, /quiet/, why)
  }
})

// lsof lists every holder: the exec job that wrote the rollout often comes
// first, and an app-server that resumed the thread after it still counts.
test('preflip-check counts an app-server listed after another holder', async () => {
  const root = await tempDir('anyengine-preflip-')
  const codexHome = join(root, 'codex')
  const adapterHome = join(root, 'adapter')
  const day = join(codexHome, 'sessions', '2026', '09', '30')
  mkdirSync(day, { recursive: true })
  mkdirSync(adapterHome)
  writeQuietLog(adapterHome)
  const rollout = join(day, 'rollout-exec.jsonl')
  writeFileSync(rollout, meta('exec'))
  const idle = ['-e', 'setInterval(() => {}, 1000)']
  const batch = spawn(process.execPath, [...idle, 'exec', '--json'], { stdio: 'ignore' })
  const appServer = spawn(process.execPath, [...idle, 'app-server', '--listen', 'stdio://'], {
    stdio: 'ignore',
  })
  const stdout = [`p${batch.pid}`, 'f12', `n${rollout}`, `p${appServer.pid}`, 'f9', `n${rollout}`]
  const busy = quietCheck(codexHome, adapterHome, '120', {
    lsof: { stdout: stdout.join('\n'), status: 0 },
  })
  assert.equal(busy.status, 1, busy.stderr)
  assert.ok(
    busy.stderr.includes(`${rollout} is held open by an app-server (pid ${appServer.pid})`),
    busy.stderr,
  )
  assert.ok(!busy.stderr.includes(`pid ${batch.pid})`), busy.stderr)
})

// launchd jobs and a detached flip can run with a PATH that lacks /usr/sbin,
// where macOS keeps lsof: an exec rollout in the window must not turn every
// check there into "cannot tell". ANYENGINE_LSOF still names the stand-in;
// with no override, the real lsof answers for a rollout nothing else holds.
// The real launchctl and plutil answer for an app id no update is staged under.
test('preflip-check finds lsof and ps under a minimal PATH', {
  skip:
    process.platform !== 'darwin' && 'lsof, ps, launchctl and plutil are where macOS keeps them',
}, async () => {
  const root = await tempDir('anyengine-preflip-')
  const codexHome = join(root, 'codex')
  const adapterHome = join(root, 'adapter')
  const day = join(codexHome, 'sessions', '2026', '09', '30')
  mkdirSync(day, { recursive: true })
  mkdirSync(adapterHome)
  writeQuietLog(adapterHome)
  const rollout = join(day, 'rollout-exec.jsonl')
  writeFileSync(rollout, meta('exec'))
  const appServer = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', 'app-server', '--listen', 'stdio://'],
    { stdio: 'ignore' },
  )
  const app = fakeApp('com.example.minimal-path')
  const check = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [preflip, '--codex-home', codexHome, '--adapter-home', adapterHome, '--app', app],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: '/usr/bin:/bin',
          ANYENGINE_LSOF: '',
          FAKE_LSOF_STDOUT: '',
          FAKE_LSOF_STDERR: '',
          FAKE_LSOF_STATUS: '1',
          ...env,
        },
      },
    )
  const fake = join(lsofBin, 'lsof')

  rmSync(lsofCalls, { force: true })
  const quiet = check({ ANYENGINE_LSOF: fake })
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.ok(readFileSync(lsofCalls, 'utf8').includes(rollout), 'the stand-in was asked')

  const held = check({
    ANYENGINE_LSOF: fake,
    FAKE_LSOF_STDOUT: `p${appServer.pid}\nf9\nn${rollout}`,
    FAKE_LSOF_STATUS: '0',
  })
  assert.equal(held.status, 1, held.stderr)
  assert.ok(
    held.stderr.includes(`${rollout} is held open by an app-server (pid ${appServer.pid})`),
    held.stderr,
  )

  // No override: /usr/sbin/lsof, which this PATH does not reach.
  const real = check({})
  assert.equal(real.status, 0, real.stderr)
  assert.match(real.stdout, /0 app rollouts in the window, 1 recent rollouts ignored/)
})

function logEvent(event: string, method?: string, ageMs = 0): Record<string, unknown> {
  return {
    ts: new Date(Date.now() - ageMs).toISOString(),
    pid: 42,
    event,
    ...(method ? { method } : {}),
  }
}

function writeLog(adapterHome: string, events: Record<string, unknown>[]) {
  writeFileSync(
    join(adapterHome, 'debug.jsonl'),
    [logEvent('rpc.request', 'turn/start', 600_000), ...events]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n',
  )
}

function writeQuietLog(adapterHome: string) {
  writeLog(adapterHome, [])
}

async function logHomes() {
  const root = await tempDir('anyengine-preflip-log-')
  const codexHome = join(root, 'codex')
  const adapterHome = join(root, 'adapter')
  mkdirSync(codexHome)
  mkdirSync(adapterHome)
  return { codexHome, adapterHome, log: join(adapterHome, 'debug.jsonl') }
}

test('preflip-check accepts a concurrent log append and rejects truncation or replacement', async () => {
  const { codexHome, adapterHome, log } = await logHomes()
  const preload = join(adapterHome, 'log-race.mjs')
  for (const action of ['append', 'truncate', 'replace']) {
    writeQuietLog(adapterHome)
    writeFileSync(
      preload,
      `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const path=${JSON.stringify(log)}, open=fs.openSync, read=fs.readSync;
let observed, changed=false;
fs.openSync=function(p,...args){const fd=open.call(this,p,...args);if(p===path)observed=fd;return fd};
fs.readSync=function(fd,...args){const n=read.call(this,fd,...args);if(fd===observed&&!changed){changed=true;
${
  action === 'append'
    ? `fs.appendFileSync(path,${JSON.stringify(`${JSON.stringify(logEvent('rpc.request', 'config/read'))}\n`)});`
    : action === 'truncate'
      ? 'fs.truncateSync(path,0);'
      : "fs.renameSync(path,path+'.old');fs.writeFileSync(path,'replacement');"
}
}return n};syncBuiltinESMExports();`,
    )
    const result = quietCheck(codexHome, adapterHome, '120', { preload })
    assert.equal(result.status, action === 'append' ? 0 : 1, result.stdout + result.stderr)
    if (action !== 'append') assert.match(result.stderr, /changed while reading its log tail/)
  }
})

test('preflip-check ignores only known polling methods in known RPC records', async () => {
  const { codexHome, adapterHome } = await logHomes()
  const methods = [
    'configRequirements/read',
    'thread/list',
    'thread/read',
    'thread/loaded/list',
    'thread/turns/list',
    'thread/turns/items/list',
    'thread/attachment/list',
    'model/list',
    'modelProvider/capabilities/read',
    'account/read',
    'account/rateLimits/read',
    'getAuthStatus',
    'config/read',
    'mcpServerStatus/list',
    'experimentalFeature/list',
    'permissionProfile/list',
    'collaborationMode/list',
    'skills/list',
    'hooks/list',
    'plugin/list',
    'plugin/read',
    'app/list',
  ]
  const events = [
    'rpc.request',
    'rpc.response',
    'codex.mux.route',
    'codex.upstream.forward',
    'codex.upstream.response',
  ]
  const records = methods.flatMap((method) => events.map((event) => logEvent(event, method)))
  writeLog(adapterHome, records)
  const result = quietCheck(codexHome, adapterHome)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /preflip-check: quiet/)
  assert.ok(
    result.stdout.includes(
      `0 turn-activity events in the window, ${records.length} background events ignored`,
    ),
    result.stdout,
  )
})

test('preflip-check counts each turn, item, approval, bridge and runtime event', async () => {
  const { codexHome, adapterHome, log } = await logHomes()
  const events = [
    ...[
      'turn/start',
      'turn/started',
      'turn/completed',
      'turn/interrupt',
      'turn/steer',
      'item/started',
      'item/completed',
      'item/agentMessage/delta',
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'future/write',
      'future/read',
      'account/future',
      'account/login/start',
    ].map((method) => logEvent('rpc.request', method)),
    logEvent('rpc.notify', 'item/reasoning/textDelta'),
    logEvent('codex.upstream.forward', 'turn/start'),
    logEvent('codex.upstream.response', 'turn/start'),
    ...[
      'rpc.serverRequest',
      'codex.mux.serverRequest',
      'codex.mux.serverRequestDropped',
      'bridge.spawnSession',
      'bridge.spawnSubagent',
      'bridge.claim',
      'anyengine.spawn',
      'anyengine.turn.completed',
      'anyengine.turn.failed',
      'runtime.turn.select',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'UserPromptSubmit',
      'rpc.responseFromClient',
      'future.event',
    ].map((event) => logEvent(event)),
    // An active or unknown event cannot hide behind a background method field.
    logEvent('rpc.serverRequest', 'thread/read'),
    logEvent('runtime.turn.select', 'thread/read'),
    logEvent('future.event', 'thread/read'),
  ]
  for (const event of events) {
    writeLog(adapterHome, [logEvent('rpc.request', 'thread/list'), event])
    // Content, not mtime, decides: even an old mtime cannot hide a turn.
    const old = new Date(Date.now() - 600_000)
    utimesSync(log, old, old)
    const result = quietCheck(codexHome, adapterHome)
    assert.equal(result.status, 1, JSON.stringify(event))
    assert.match(result.stderr, /not quiet/)
    assert.match(result.stderr, /1 turn-activity events in the window, 1 background events ignored/)
  }
})

test('preflip-check cannot tell from a missing, unreadable, empty or corrupt adapter log', async () => {
  const { codexHome, adapterHome, log } = await logHomes()
  const cannotTell = () => {
    const result = quietCheck(codexHome, adapterHome)
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /cannot tell/)
    assert.doesNotMatch(result.stdout, /preflip-check: quiet/)
  }
  cannotTell() // missing
  mkdirSync(log) // directory cannot be read as a log
  cannotTell()
  rmSync(log, { recursive: true })
  for (const content of [
    '',
    'broken\n{partial',
    '{}\nnull\n[]\n',
    JSON.stringify({ ts: 'bad date', event: 'rpc.request', method: 'turn/start' }),
  ]) {
    writeFileSync(log, content)
    cannotTell()
  }
  writeQuietLog(adapterHome)
  if (process.getuid?.() !== 0) {
    chmodSync(log, 0o000)
    try {
      cannotTell()
    } finally {
      chmodSync(log, 0o600)
    }
  }
  // Valid JSON with an unusable timestamp cannot silently hide a turn.
  writeLog(adapterHome, [{ ts: 'bad date', event: 'rpc.request', method: 'turn/start' }])
  cannotTell()
})

test('preflip-check tolerates a broken line only alongside usable log records', async () => {
  const { codexHome, adapterHome, log } = await logHomes()
  writeLog(adapterHome, [logEvent('rpc.request', 'thread/list')])
  writeFileSync(log, `broken\n${readFileSync(log, 'utf8')}{partial`)
  const result = quietCheck(codexHome, adapterHome)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /0 turn-activity events in the window, 1 background events ignored/)
})

test('preflip-check refuses when the bounded log tail does not reach the window start', async () => {
  const { codexHome, adapterHome, log } = await logHomes()
  const poll = logEvent('rpc.request', 'configRequirements/read')
  // Even the complete current log can be too young after rotation.
  writeFileSync(log, JSON.stringify(poll) + '\n')
  const young = quietCheck(codexHome, adapterHome)
  assert.equal(young.status, 1, young.stdout)
  assert.match(young.stderr, /tail does not reach the start of the quiet window/)
  const line = JSON.stringify({ ...poll, padding: 'x'.repeat(1000) }) + '\n'
  writeLog(adapterHome, [])
  writeFileSync(log, readFileSync(log, 'utf8') + line.repeat(2200))
  const truncated = quietCheck(codexHome, adapterHome)
  assert.equal(truncated.status, 1, truncated.stdout)
  assert.match(truncated.stderr, /tail does not reach the start of the quiet window/)
  assert.match(
    truncated.stdout,
    /0 turn-activity events in the window, \d+ background events ignored/,
  )
  // A bounded tail may be quiet when it still contains the entire window.
  const oldLine =
    JSON.stringify({
      ...poll,
      ts: new Date(Date.now() - 600_000).toISOString(),
      padding: 'x'.repeat(1000),
    }) + '\n'
  writeFileSync(log, oldLine.repeat(2200) + line)
  const covered = quietCheck(codexHome, adapterHome)
  assert.equal(covered.status, 0, covered.stderr)
  assert.match(covered.stdout, /0 turn-activity events in the window, 1 background events ignored/)
})

// This catches replacing the background allowlist with an activity allowlist:
// newly introduced methods must block a restart, even when spelled like reads.
test('preflip-check treats unknown methods as activity, not background', async () => {
  const { codexHome, adapterHome } = await logHomes()
  writeLog(adapterHome, [
    logEvent('rpc.request', 'newProtocol/read'),
    logEvent('codex.mux.route', 'account/newMethod'),
    logEvent('codex.upstream.response', 'newProtocol/list'),
  ])
  const result = quietCheck(codexHome, adapterHome)
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /3 turn-activity events in the window, 0 background events ignored/)
})
