#!/usr/bin/env node
// Runs the node:test suites with every home the adapter could touch pointed
// into one throwaway directory, so a test run can never read or write the
// real ~/.codex, ~/.claude or ~/.anyengine, and never find a real `codex`,
// `claude` or `grok` on PATH (docs/quality.md, "Hermetic tests").
//
// Usage: node scripts/test-hermetic.mjs [--coverage] [dist/test/<suite>.mjs ...]
//   default suites: every dist/test/*.mjs (run `npm run build` first)
//
// ANYENGINE_HOME is deliberately NOT set: tests give each adapter its own
// CODEX_HOME, and one shared ANYENGINE_HOME makes them share a state.sqlite.
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reapStaleSockets } from '../dist/src/bridge-sockets.mjs'
import { findStrays, listAnyengine } from './hermetic-strays.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const coverage = args.includes('--coverage')
const named = args.filter((arg) => arg !== '--coverage')
const suites =
  named.length > 0
    ? named
    : readdirSync(join(repo, 'dist', 'test'))
        .filter((name) => name.endsWith('.mjs'))
        .sort()
        .map((name) => join('dist', 'test', name))

// The real temp directory, and what already sat there: an `anyengine-*` entry
// a suite writes there instead of into TMPDIR (a path it resolved before
// TMPDIR moved, an inherited variable) shows up as a new one. A hard-coded
// /tmp is seen only when the temp directory is /tmp.
const hostTmp = tmpdir()
const hostBefore = new Set(listAnyengine(hostTmp))

// Suites bind unix sockets in TMPDIR, some a directory below it, and a socket
// path must fit sockaddr_un (104 bytes on macOS, NUL included). macOS's own
// per-user temp directory (/private/var/folders/…/T, 56 bytes) leaves too
// little room once TMPDIR sits inside the root, so a temp directory that long
// gives way to /tmp for the root; strays are still looked for in hostTmp.
const SOCKET_ROOM = 40
const ROOT_AND_TMP = '/anyengine-hermetic-XXXXXX/tmp'.length
const base = realpathSync(hostTmp).length + ROOT_AND_TMP + SOCKET_ROOM < 104 ? hostTmp : '/tmp'
// realpath: macOS tmpdir is a symlink (/var -> /private/var) and tests compare paths.
const root = realpathSync(mkdtempSync(join(base, 'anyengine-hermetic-')))
// Every suite's temp files land here, so the run can check what is left.
const tmp = join(root, 'tmp')
mkdirSync(tmp)
const home = join(root, 'home')
const bin = join(root, 'bin')
for (const dir of [bin, join(home, '.codex'), join(home, '.claude')]) {
  mkdirSync(dir, { recursive: true })
}
// A missing control config enables the default loopback router. Keep ordinary
// fake adapters detached even when a real router is running on this machine;
// router suites explicitly provide their own root and loopback backend.
mkdirSync(join(home, '.anyengine'))
writeFileSync(
  join(home, '.anyengine', 'config.json'),
  JSON.stringify({ version: 1, router: { enabled: false } }),
  { mode: 0o600 },
)
symlinkSync(process.execPath, join(bin, 'node'))
const refuse = join(bin, 'refuse')
writeFileSync(refuse, '#!/bin/sh\necho "refused in tests: $0 $*" >&2\nexit 1\n', { mode: 0o755 })

const QUIET = '--disable-warning=ExperimentalWarning'

// Inherited settings that would reach a real engine or a real account.
const DROPPED = /^(ANYENGINE_|CLAUDE_CODEX_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|XAI_|GROK_|GIT_)/
const env = {}
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !DROPPED.test(key)) env[key] = value
}
Object.assign(env, {
  HOME: home,
  // Fixture homes model a zsh Mac; other-shell cases override this explicitly.
  SHELL: '/bin/zsh',
  CODEX_HOME: join(home, '.codex'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  ANYENGINE_DEBUG_LOG: join(root, 'debug.jsonl'),
  // Never the app's bundled codex: an app bundle that does not exist, so the
  // shim and the adapter only ever run the fakes a test names explicitly
  // (ANYENGINE_REAL_CODEX, or a fake bundle a test builds and names here).
  ANYENGINE_CHATGPT_APP: join(root, 'no-ChatGPT.app'),
  ANYENGINE_NATIVE_CODEX: '0',
  ANYENGINE_LAUNCHCTL: refuse,
  ANYENGINE_OSASCRIPT: refuse,
  ANYENGINE_OPEN: refuse,
  ANYENGINE_PGREP: refuse,
  ANYENGINE_PS: refuse,
  ANYENGINE_PLUTIL: refuse,
  PATH: [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  ANYENGINE_REQUIREMENTS_FILE: join(root, 'no-requirements.toml'),
  ANYENGINE_MDM_REQUIREMENTS_FILE: join(root, 'no-mdm-requirements'),
  ANYENGINE_MANAGED_CONFIG_FILE: join(root, 'no-managed-config.toml'),
  ANYENGINE_MDM_CONFIG_FILE: join(root, 'no-mdm-config'),
  HERMETIC_TEST_ROOT: root,
  TMPDIR: tmp,
  TMP: tmp,
  TEMP: tmp,
  // node:sqlite warns on every load. The flag below quiets the suites; this
  // quiets the adapters and fixtures they spawn with an inherited stderr.
  NODE_OPTIONS: [env.NODE_OPTIONS, QUIET].filter(Boolean).join(' '),
})

const nodeArgs = [
  QUIET,
  '--test',
  '--test-timeout=180000',
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
]
if (coverage) {
  nodeArgs.push(
    '--experimental-test-coverage',
    '--test-coverage-include=dist/src/**',
    '--test-coverage-lines=80.7',
  )
}

const result = spawnSync(process.execPath, [...nodeArgs, ...suites], {
  cwd: repo,
  env,
  stdio: 'inherit',
})
// Node's own coverage scratch is removed by Node; anything else a suite made
// in TMPDIR and did not remove is a leak (1,091 dirs piled up before this).
const IGNORED = /^node-coverage-/
// An adapter stopped by SIGKILL cannot unlink its bridge socket, which falls
// back to TMPDIR; the next adapter to start removes it (src/bridge-sockets.mts).
// Sweep once more after the last suite, as that adapter would: a socket whose
// adapter is still running stays, and fails the run.
reapStaleSockets(join(tmp, 'next.sock'))
const leftovers = readdirSync(tmp).filter((name) => !IGNORED.test(name))
const strays = findStrays(hostTmp, hostBefore)
rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
let status = result.status ?? 1
if (leftovers.length > 0) {
  console.error(
    `test-hermetic: suites left ${leftovers.length} entr${leftovers.length === 1 ? 'y' : 'ies'} in TMPDIR (remove them in after()):\n  ${leftovers.sort().join('\n  ')}`,
  )
  status = status || 1
}
if (strays.length > 0) {
  console.error(
    `test-hermetic: suites wrote outside TMPDIR, into ${hostTmp}:\n  ${strays.sort().join('\n  ')}`,
  )
  status = status || 1
}
process.exit(status)
