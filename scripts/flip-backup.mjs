#!/usr/bin/env node
// Back up every file a live flip touches and write a ROLLBACK.sh beside the
// copies (the pattern of docs/evidence/a3-flip.md). One command restores the
// files and, without --copy-only, quits and reopens ChatGPT.app. Run it
// before the flip, then run `ROLLBACK.sh --copy-only` once and diff: the
// rollback is exercised on the real files before anything changes.
//
// Usage: node scripts/flip-backup.mjs [--home DIR] [--target PATH ...]
//   default targets: ~/.zshrc, ~/bin/codex, ~/.anyengine/runtime.env
//
// ROLLBACK.sh restores each file with `cp -p` from its copy. A target that did
// not exist when this ran is removed again with a plain `rm -f` of that one
// path (a directory there is reported, never removed). It never removes
// recursively and touches nothing but the paths named here. A target that is
// a symbolic link is refused up front: a rollback could not put the link back.
// ROLLBACK.sh takes no argument or exactly `--copy-only`; anything else exits 2
// before it touches a file, so a typo cannot quit the app.
import { chmodSync, copyFileSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

function fail(message) {
  console.error(`flip-backup: ${message}`)
  process.exit(1)
}

// Strict: a mistyped flag or a missing value must not fall back to the real
// home directory.
let options
try {
  options = parseArgs({
    options: { home: { type: 'string' }, target: { type: 'string', multiple: true } },
    strict: true,
    allowPositionals: false,
  }).values
} catch (error) {
  fail(`${error.message}\nusage: node scripts/flip-backup.mjs [--home DIR] [--target PATH ...]`)
}

const home = resolve(options.home ?? homedir())
// Absolute, so ROLLBACK.sh restores the same path from whatever directory it runs in.
const targets = (
  options.target?.length
    ? options.target
    : [join(home, '.zshrc'), join(home, 'bin', 'codex'), join(home, '.anyengine', 'runtime.env')]
).map((target) => resolve(target))

function sq(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// The restart half, as in docs/evidence/a3-flip.md: quit the app, wait, name
// and then terminate by pid any app-server adapter the quit left orphaned,
// reopen the app.
const RESTART = [
  'echo "[rollback] quitting ChatGPT.app"',
  'osascript -e \'quit app "ChatGPT"\' || true',
  'for _ in $(seq 1 30); do pgrep -x ChatGPT >/dev/null || break; sleep 1; done',
  '# Still running: `open -a` would only focus the old instance, not relaunch it.',
  'if pgrep -x ChatGPT >/dev/null; then',
  '  echo "[rollback] ChatGPT.app is still running 30s after the quit request; the files are restored, the app was not reopened" >&2',
  '  exit 1',
  'fi',
  "orphans() { ps -eo pid=,ppid=,command= | awk '$2 == 1 && /adapter\\.mjs/ && / app-server/ && !/bridge-mcp/ { print $1 }'; }",
  'for _ in $(seq 1 20); do [ -z "$(orphans)" ] && break; sleep 1; done',
  'for p in $(orphans); do',
  '  echo "[rollback] terminating orphaned adapter pid $p:"',
  '  ps -o pid=,command= -p "$p" | cut -c1-160',
  '  kill "$p" 2>/dev/null || true',
  'done',
  'sleep 2',
  'echo "[rollback] reopening ChatGPT.app"',
  'open -a /Applications/ChatGPT.app',
  'echo "[rollback] done"',
]

function scriptFor(entries) {
  return [
    '#!/usr/bin/env bash',
    '# Written by scripts/flip-backup.mjs: restores every file the flip touched.',
    '#   ./ROLLBACK.sh              restore the files, then restart ChatGPT.app',
    '#   ./ROLLBACK.sh --copy-only  restore the files only',
    'set -euo pipefail',
    '# Anything else is a typo, and a typo must not quit the app: refuse before any restore.',
    'case "$#:${1:-}" in',
    '  0:) ;;',
    '  1:--copy-only) ;;',
    '  *) echo "usage: ROLLBACK.sh [--copy-only]" >&2; exit 2 ;;',
    'esac',
    'BK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"',
    'FAILED=0',
    '',
    '# restore COPY TARGET: put the pre-flip file back, mode and all. A directory',
    '# at TARGET is never written into; a symlink is replaced, never written through.',
    'restore() {',
    '  if [ ! -f "$BK/$1" ]; then',
    '    printf "[rollback] FAILED to restore %s: the copy %s is missing\\n" "$2" "$1" >&2',
    '    FAILED=1',
    '  elif [ -d "$2" ] && [ ! -L "$2" ]; then',
    '    printf "[rollback] FAILED to restore %s: it is now a directory\\n" "$2" >&2',
    '    FAILED=1',
    '  elif [ -L "$2" ] && ! rm -f -- "$2"; then',
    '    printf "[rollback] FAILED to restore %s: could not replace the symlink\\n" "$2" >&2',
    '    FAILED=1',
    '  elif cp -p "$BK/$1" "$2"; then',
    '    printf "[rollback] restored %s\\n" "$2"',
    '  else',
    '    printf "[rollback] FAILED to restore %s\\n" "$2" >&2',
    '    FAILED=1',
    '  fi',
    '}',
    '',
    '# remove TARGET: it did not exist before the flip, so drop the one file the',
    '# flip made. `rm -f` on a directory fails, which is reported, never forced.',
    'remove() {',
    '  if [ ! -e "$1" ] && [ ! -L "$1" ]; then',
    '    printf "[rollback] %s is already absent\\n" "$1"',
    '  elif rm -f -- "$1"; then',
    '    printf "[rollback] removed %s (the flip created it)\\n" "$1"',
    '  else',
    '    printf "[rollback] FAILED to remove %s\\n" "$1" >&2',
    '    FAILED=1',
    '  fi',
    '}',
    '',
    ...entries.map(({ target, backup }) =>
      backup ? `restore ${sq(backup)} ${sq(target)}` : `remove ${sq(target)}`,
    ),
    '',
    'if [ "$FAILED" != 0 ]; then',
    '  echo "[rollback] some files were not restored; the app was not restarted" >&2',
    '  exit 1',
    'fi',
    'if [ "${1:-}" = "--copy-only" ]; then',
    '  echo "[rollback] --copy-only: the app was not restarted"',
    '  exit 0',
    'fi',
    ...RESTART,
    '',
  ].join('\n')
}

// null: the target does not exist yet. Otherwise its mode. A symlink or a
// directory is refused, so that nothing is half backed up.
function inspect(target) {
  let info
  try {
    info = lstatSync(target)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (info.isSymbolicLink()) {
    throw new Error(
      `${target} is a symbolic link: ROLLBACK.sh cannot put a link back, so it is not backed up. ` +
        'Name the file it points to with --target, or move the link aside first.',
    )
  }
  if (!info.isFile()) throw new Error(`${target} is not a regular file`)
  return info.mode & 0o777
}

try {
  const modes = targets.map(inspect)
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  const dir = join(home, '.anyengine', `rollback-${stamp}`)
  mkdirSync(join(home, '.anyengine'), { recursive: true, mode: 0o700 })
  // Not recursive: two runs in the same second must not share a directory and
  // overwrite the first run's copies.
  mkdirSync(dir, { mode: 0o700 })

  const entries = targets.map((target, index) => {
    const mode = modes[index]
    if (mode === null) return { target, backup: null, mode: null }
    const backup = `${String(index).padStart(2, '0')}-${basename(target)}.bak`
    copyFileSync(target, join(dir, backup))
    chmodSync(join(dir, backup), mode)
    return { target, backup, mode: `0${mode.toString(8)}` }
  })

  writeFileSync(
    join(dir, 'manifest.json'),
    `${JSON.stringify({ createdAt: new Date().toISOString(), entries }, null, 2)}\n`,
  )
  // Written last: a directory with a ROLLBACK.sh holds a complete backup.
  const rollback = join(dir, 'ROLLBACK.sh')
  writeFileSync(rollback, scriptFor(entries))
  chmodSync(rollback, 0o755)
  console.log(dir)
} catch (error) {
  fail(error.message)
}
