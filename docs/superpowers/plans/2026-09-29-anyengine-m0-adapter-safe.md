# AnyEngine M0: adapter safe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the existing adapter back in ChatGPT.app's live path so that it cannot be broken by a dependency cleanup, falls back loudly to the bundled codex when it cannot start, fans out Claude and GPT sub-agents on the current app build, and never gives any engine more room than the thread that started it.

**Architecture:** The adapter keeps its shape (shim, protocol layer, multiplexer, runtimes, bridge). M0 adds an installed, verified copy of the adapter under `~/.anyengine/lib/<version>/`, a shim that self-checks the adapter and otherwise execs the bundled codex with a marker, and one canonical `Posture` type (`src/posture.mts`) that every runtime consults through a single `decide` function, checked by a "never looser" property test over every enumerable parent posture and by a CI check against the generated Codex schema. Claude children under a Codex parent are bounded by the PreToolUse relay and run shell commands through the real codex child's `command/exec`. The milestone ends with a backed-up, rollback-tested live flip.

**Tech Stack:** Node.js 24 (TypeScript ESM `.mts`, erasable syntax, `node:test`, `node:sqlite`), bash 3.2 (the shim), Biome, the Codex app-server protocol (bundled codex `0.155.0-alpha.2.6` in ChatGPT.app `26.911` when Tasks 1 to 13 were written; `0.159.0` in `26.928` since Task 14a), the interactive `claude` CLI under node-pty.

**Spec:** `docs/specs/2026-09-29-anyengine-v1-design.md` (section 9, M0; details in 5.1, 5.6, 5.7, 7 and 8).

**Where to work:** a branch `m0/adapter-safe` cut from `spec/anyengine-v1` (it carries the spec and this plan), in its own worktree (superpowers:using-git-worktrees). Never modify or discard the working tree of the main checkout: its uncommitted shim fallback, lockfile and AGENTS.md changes are folded into Tasks 2 and 3 below, and the human decides what happens to that checkout after M0 lands.

**Line ranges** name the tree at `2fe94af`. When an earlier task has moved them, anchor on the quoted code.

## Global Constraints

- Node.js 24+ (`engines.node: ">=24"`); TypeScript ESM `.mts` only, erasable syntax only (no `enum`, `namespace`, parameter properties); tests import compiled `dist/` output.
- "Claude always runs through the `claude` CLI, and no component ever holds, stores or relays a Claude OAuth token." (spec 3)
- "Every live change is reversible with one command." (spec 3)
- "Minimal footprint: No heavy system prompts. Native mode injects nothing." (spec 3)
- Posture: "the child's posture must be no looser than the parent's" (spec 5.6), judged on the four axes of the research map: write set, read set, network reach, actions that run without a human or reviewer; deny < ask (human) < review (reviewer model) < allow (unattended).
- "Never scripted: the interactive codex TUI. It can accept a self-update prompt." (spec 7)
- "Hermetic suite: no reliance on the user's `~/.codex` or `~/.claude`. Tests spawn with isolated homes and kill their children in `after()`." (spec 8)
- Install location `~/.anyengine/lib/<version>/`, with the shim pointing there (spec 5.1); AnyEngine state lives under `~/.anyengine/` (spec 5.7).
- Quality gates, all green after every task: Biome (`npm run check`), `npm run typecheck`, the file-size ratchet (500-line cap; a file listed in `scripts/size-baseline.json` may shrink but never grow, and a shrink lowers its baseline for good, so every task must leave every baselined file at or below the length it found it), the complexity ratchet (worst 112, 15 functions over 30; neither may rise), the dependency guard (no new runtime dependency in M0), the env-docs gate (every `ANYENGINE_*` read in `src/` documented in `docs/guide/configuration.md`), the coverage floor (80.7% lines).
- Public repository: no personal names, no absolute personal paths in code, docs, fixtures or commits; write `$HOME` or `~`.
- Commits: conventional messages (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), no `Co-Authored-By` trailer.

## Review Focus

1. **One message names a posture twice, or names a value this build does not know** (a profile id plus sandbox fields, an unknown sandbox string, an unknown `SandboxPolicy` type): the tighter reading wins, never a looser inherited one. Pinned in Task 7 (`posture: requests, turns and lifecycle answers parse into one type`, `posture: nothing, junk or a custom profile is the tight default`).
2. **Paths that go through a symlink or are relative** (a link inside the workspace pointing out of it, `file_path: "sub/b.txt"`, macOS `/tmp` resolving to `/private/tmp`): a write is judged by where it lands. Pinned in Task 7 (the `escape` and `sub/b.txt` probes run through every property test).
3. **An upgrade while the app is running:** installing a new lib never removes the version a running adapter loaded, and a lib that fails its check never becomes `current`. Pinned in Task 3 (`an upgrade keeps the running version and the previous one`, `a lib that fails its selfcheck never becomes current`).
4. **A fallback that cannot write its logs** (unwritable or odd `HOME`): the shim still execs the bundled codex. Pinned in Task 2 (`the fallback still runs when its marker cannot be written`).
5. **Threads stored before M0** (rows carrying the old default `never` + `danger-full-access` and no posture): they keep what they recorded, and the next turn's posture from the app replaces it. Pinned in Task 9 (`posture: a row stored before M0 keeps its strings until the app sends a posture`).

## File structure

New modules (each under the 500-line cap):

| File | Responsibility |
|---|---|
| `src/posture.mts` | The canonical `Posture` type, parsing from Codex requests and lifecycle answers, legacy and stored forms, converters into Codex thread start, turn and `command/exec` shapes, the Claude permission-mode converter, `decide` / `reach` / `sandboxedOutcome` / `isUnrestricted`, the schema-coverage predicates. |
| `src/posture-claude.mts` | Claude tools as effects, the PreToolUse relay verdict, the Claude launch for a posture (permission mode, disallowed tools, workspace trust), the spawn key. |
| `src/store-rows.mts` | `threads` row to `ThreadRecord` mapping, moved out of `store.mts` (which is at its size baseline) so the posture column fits. |
| `src/bridge-exec.mts` | The bridge `exec` tool: runs a command through the real codex child's `command/exec` under the caller's posture; holds the reference to that child. |
| `src/bridge-sockets.mts` | The bridge control socket path and stale-socket reaper, moved out of `bridge-control.mts` (at its baseline) to make room for `exec`. |
| `scripts/test-hermetic.mjs` | Runs `node --test` with every home, PATH and engine setting pointed into one throwaway directory. |
| `scripts/install-lib.mjs`, `scripts/lib-verify.mjs` | Installs a verified adapter lib under `~/.anyengine/lib/<version>/`, moves `current`, prunes; verifies a lib against its manifest plus a deep selfcheck. |
| `scripts/sync-codex-compat.mjs` | Moves the codex version pin everywhere it is written, or checks that every site agrees. |
| `scripts/check-posture-schema.mjs` | CI: every posture enum value and field in the generated Codex schema, and every Claude mode in the docs fixture, is one `src/posture.mts` converts. |
| `scripts/flip-backup.mjs`, `scripts/preflip-check.mjs` | Backs up the files a live flip touches and writes a tested `ROLLBACK.sh`; refuses a restart while a turn may be in flight. |

Modified: `scripts/codex-shim`, `scripts/doctor.mjs`, `src/adapter.mts`, `src/types.mts`, `src/store.mts`, `src/server.mts`, `src/server-helpers.mts`, `src/server-views.mts`, `src/codex-mux.mts`, `src/bridge-control.mts`, `src/bridge-mcp.mts`, `src/anyengine-runtime.mts`, `src/native-runtime.mts`, `src/grok-acp.mts`, `src/claude-p-runtime.mts`, `src/codex-proxy-runtime.mts`, `src/mock-runtime.mts`, `src/util.mts`, `package.json`, `package-lock.json`, `.github/workflows/ci.yml`, docs.

Test helpers (compiled to `dist/test/helpers/`, outside the `dist/test/*.mjs` glob so they never run as suites): `test/helpers/children.mts`, `test/helpers/postures.mts`, `test/helpers/adapter-client.mts`.

## Decisions this plan takes (read before Task 7)

- **`Posture.fileSystem` is Codex's `SandboxPolicy` shape** (`read-only`, `workspace-write` with roots and tmp exclusions, `full-access`, `external`), not a list of permission-profile filesystem entries. Every posture the protocol carries today arrives in that shape; custom profile contents are not visible to the adapter, so a custom profile id resolves to the default posture. Entry lists arrive when profile details become readable.
- **`decide` over effects is the one semantics.** A Claude tool call, a Codex child posture and a runtime flag are all judged by what they let happen: a read, a write to a path, network, anything outside every sandbox, an MCP tool call. The property tests compare `reach` (the direct path, or a sandboxed command inside the sandbox's own bounds) between parent and child.
- **An ask the app cannot draw becomes a refusal.** The app only renders approval cards for `Bash`, `Edit`, `Write` and `MultiEdit`; any other tool the posture would ask about is refused with a reason, never run.
- **"Refuse to start without a sandbox" is realised as "nothing unbounded ever runs unattended":** the `exec` tool refuses to run without the real codex child, Claude's own Bash stays behind the relay (asked or refused) when there is no sandbox to move it to, and a parent that does not trust the project gets a child that refuses the workspace trust dialog. A hard refusal to start the whole child is deferred: it would take Claude away on hosts without a native codex child without making anything safer.
- **Doctor checks extend `npm run doctor`.** The `anyengine on/off/status/doctor` CLI is M1; M0 only needs to verify the installed lib before and after the flip.

---
### Task 1: Hermetic test runner and child reaping

The 2026-09-15 test run wrote about 150 hook events into the live `~/.codex/anyengine/debug.jsonl`. After this task no suite can read or write a real home, find a real engine binary on `PATH`, or leave a child running.

**Files:**
- Create: `scripts/test-hermetic.mjs`
- Create: `test/hermetic.test.mts`
- Create: `test/helpers/children.mts`
- Modify: `package.json` (`scripts.test:coverage`, new `scripts.test:hermetic`)
- Modify: `test/codex-mux.test.mts:1-8` (imports), `test/bridge.test.mts:1-9` (imports), `test/grok-runtime.test.mts:1-8` (imports)
- Modify: `test/AGENTS.md` (Running section), `docs/quality.md` (new section 7), `CHANGELOG.md` (new `### M0: adapter safe` under `## Unreleased`)

**Interfaces:**
- Consumes: nothing.
- Produces: `test/helpers/children.mts` exports `spawn` (same signature as `node:child_process` `spawn`, tracks the child), `killChildren(): void` and `waitForOutput(child: ChildProcess, pattern: RegExp, timeoutMs?: number): Promise<string>`. `scripts/test-hermetic.mjs [--coverage] [dist/test/<suite>.mjs ...]` runs the given suites (default: every `dist/test/*.mjs`) with `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `ANYENGINE_DEBUG_LOG` and `ANYENGINE_REAL_CODEX` inside one throwaway root named in `HERMETIC_TEST_ROOT`, `ANYENGINE_NATIVE_CODEX=0`, and `PATH=<root>/bin:/usr/bin:/bin:/usr/sbin:/sbin` where `<root>/bin/node` links to the running node. Every later task runs suites through it.

- [ ] **Step 1: Write the failing guard test**

Create `test/hermetic.test.mts`:

```ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, relative } from 'node:path'
import test from 'node:test'

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
    'ANYENGINE_REAL_CODEX',
  ]) {
    assert.ok(inside(process.env[name]), `${name} is outside the hermetic root: ${process.env[name]}`)
  }
  assert.ok(inside(homedir()), `os.homedir() is outside the hermetic root: ${homedir()}`)
  assert.equal(process.env.ANYENGINE_NATIVE_CODEX, '0')
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
```

- [ ] **Step 2: Run it without the runner to see it fail**

Run: `npm run build && node --test dist/test/hermetic.test.mjs`
Expected: FAIL, `✖ the suite runs inside a throwaway home` with `run the suites through \`npm test\``.

- [ ] **Step 3: Write the runner**

Create `scripts/test-hermetic.mjs`:

```js
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
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// realpath: macOS tmpdir is a symlink (/var -> /private/var) and tests compare paths.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'anyengine-hermetic-')))
const home = join(root, 'home')
const bin = join(root, 'bin')
for (const dir of [bin, join(home, '.codex'), join(home, '.claude')]) {
  mkdirSync(dir, { recursive: true })
}
symlinkSync(process.execPath, join(bin, 'node'))

// Inherited settings that would reach a real engine or a real account.
const DROPPED = /^(ANYENGINE_|CLAUDE_CODEX_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|XAI_|GROK_|GIT_)/
const env = {}
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !DROPPED.test(key)) env[key] = value
}
Object.assign(env, {
  HOME: home,
  CODEX_HOME: join(home, '.codex'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  ANYENGINE_DEBUG_LOG: join(root, 'debug.jsonl'),
  // Never the app's bundled codex: a path that does not exist, so the shim
  // and the adapter only ever run the fakes a test names explicitly.
  ANYENGINE_REAL_CODEX: join(bin, 'no-bundled-codex'),
  ANYENGINE_NATIVE_CODEX: '0',
  PATH: [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  HERMETIC_TEST_ROOT: root,
})

const nodeArgs = [
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
rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
process.exit(result.status ?? 1)
```

- [ ] **Step 4: Point `npm test` at the runner**

In `package.json`, replace the `test:coverage` script and add `test:hermetic`:

```json
    "test:coverage": "npm run build && node scripts/test-hermetic.mjs --coverage",
    "test:hermetic": "node scripts/test-hermetic.mjs",
```

- [ ] **Step 5: Run the guard through the runner**

Run: `node scripts/test-hermetic.mjs dist/test/hermetic.test.mjs`
Expected: PASS, `ℹ pass 3`, `ℹ fail 0`.

- [ ] **Step 6: Add the child-reaping helper**

Create `test/helpers/children.mts`:

```ts
import { type ChildProcess, spawn as spawnChild } from 'node:child_process'

// Every child a suite starts, so `after(killChildren)` reaps the ones a failed
// assertion left running: a live child keeps node:test's process, and the temp
// home it writes into, alive past the suite.
const children = new Set<ChildProcess>()

export const spawn: typeof spawnChild = ((...args: Parameters<typeof spawnChild>) => {
  const child = spawnChild(...args)
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}) as typeof spawnChild

export function killChildren(): void {
  for (const child of children) {
    try {
      child.kill('SIGKILL')
    } catch {}
    child.stdin?.destroy()
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
  children.clear()
}

// Resolves with everything the child has written to stdout once it matches
// `pattern`: a response can arrive after notifications, or split over chunks.
export function waitForOutput(child: ChildProcess, pattern: RegExp, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${pattern}; got: ${out.slice(-500)}`)),
      timeoutMs,
    )
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
      if (!pattern.test(out)) return
      clearTimeout(timer)
      resolve(out)
    })
  })
}
```

- [ ] **Step 7: Use it in the three suites that spawn without reaping**

In `test/codex-mux.test.mts`, replace
`import { type ChildProcess, spawn } from 'node:child_process'` with
`import type { ChildProcess } from 'node:child_process'`, replace `import test from 'node:test'` with `import test, { after } from 'node:test'`, add `import { killChildren, spawn } from './helpers/children.mjs'`, and add `after(killChildren)` directly below the imports.

In `test/bridge.test.mts`, make the same three changes (its import is `import { type ChildProcess, spawn } from 'node:child_process'`).

In `test/grok-runtime.test.mts`, delete `import { spawn } from 'node:child_process'`, replace `import test from 'node:test'` with `import test, { after } from 'node:test'`, add `import { killChildren, spawn } from './helpers/children.mjs'` and `after(killChildren)`.

(`test/adapter.test.mts` already reaps its children in `after()`; `test/worktree.test.mts` only uses `execFileSync`.)

- [ ] **Step 8: Run the whole suite through the runner**

Run: `npm test`
Expected: PASS, `ℹ fail 0`, and the coverage line `all files` at or above 80.7. A suite that passes under a bare `node --test` but fails here has found a real-home or PATH dependency: fix the test to pass the dependency explicitly (a fixture path, `process.execPath`, an explicit env value); never widen the runner's PATH or re-admit a dropped variable.

- [ ] **Step 9: Document it**

In `test/AGENTS.md`, replace the `## Running` code block with:

````markdown
```bash
npm test                         # build, then every suite through scripts/test-hermetic.mjs
npm run build                    # compile without running
node scripts/test-hermetic.mjs dist/test/adapter.test.mjs   # one suite, after a build
```

Suites never run under a bare `node --test`: `test/hermetic.test.mts` fails
unless HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, ANYENGINE_DEBUG_LOG and PATH point
into the runner's throwaway root. Suites that spawn children import `spawn`
from `test/helpers/children.mts` and call `after(killChildren)`.
````

Append to `docs/quality.md`:

```markdown
## 7. Hermetic tests

`npm test` runs every suite through `scripts/test-hermetic.mjs`: HOME,
CODEX_HOME, CLAUDE_CONFIG_DIR and ANYENGINE_DEBUG_LOG point into one
throwaway directory, inherited `ANYENGINE_*`, `CODEX_*`, `CLAUDE_*`,
`ANTHROPIC_*`, `OPENAI_*`, `GROK_*` and `GIT_*` settings are dropped, and PATH
holds only the running node and the system directories, so no real `codex`,
`claude` or `grok` can be found. `test/hermetic.test.mts` fails any run that is
not set up this way. A test run once wrote into the live debug log; this is the
gate that stops it happening again.
```

In `CHANGELOG.md`, directly under `## Unreleased`, add:

```markdown
### M0: adapter safe

- **Tests can no longer touch a real home.** `npm test` runs every suite with
  HOME, CODEX_HOME, CLAUDE_CONFIG_DIR and the debug log inside one throwaway
  directory and a PATH with no engine CLIs on it, and a guard suite fails any
  run that is not set up that way. Suites that spawn children reap them in
  `after()`.
```

- [ ] **Step 10: Gates and commit**

Run: `npm run check && npm run typecheck`
Expected: `Env-docs gate OK`, `File-size ratchet OK`, `Complexity ratchet OK: worst 112, 15 over`, no typecheck output.

```bash
git add scripts/test-hermetic.mjs test/hermetic.test.mts test/helpers/children.mts package.json \
  test/codex-mux.test.mts test/bridge.test.mts test/grok-runtime.test.mts test/AGENTS.md \
  docs/quality.md CHANGELOG.md
git commit -m "test: run every suite in a throwaway home with no engine CLIs on PATH"
```

---

### Task 2: Adapter selfcheck and a loud fallback to the bundled codex

Folds the uncommitted 2026-09-15 shim fallback (the main checkout's `scripts/codex-shim`, `scripts/doctor.mjs`, `scripts/AGENTS.md`, `test/shim.test.mts`, `test/fixtures/fake-codex-fallback.mjs`; imported on `spike/s3-health` as `2381ebf`) with the corrections the S3 spike asked for: probe the whole adapter, not just `ws`; fall back to the vendor-bundled codex (`ANYENGINE_REAL_CODEX`, else the app bundle), not to `CODEX_REAL`; and say so loudly.

**Files:**
- Modify: `src/adapter.mts:1-5` (imports), `:63-76` (main head), `:295-304` (usage); add `runSelfCheck`
- Modify: `scripts/codex-shim` (whole file below)
- Modify: `scripts/doctor.mjs:18-29` (checks)
- Modify: `scripts/AGENTS.md` (the `codex-shim` bullet)
- Create: `test/fixtures/fake-codex-fallback.mjs`
- Create: `test/shim.test.mts`
- Create: `test/doctor.test.mts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1's runner and `test/helpers/children.mts`.
- Produces: `node dist/src/adapter.mjs selfcheck [--deep]` prints `anyengine selfcheck ok` (or `anyengine selfcheck ok (deep)`) and exits 0; any unresolvable static import exits non-zero before `main()`. The shim functions `resolve_bundled_codex`, `adapter_ready`, `announce_fallback`, `fallback_to_bundled`, `unix_listen_arg` (used by Tasks 3, 6 and 12). The marker file `$HOME/.anyengine/shim-fallback.json` (one JSON object: `ts`, `pid`, `event: "shim.fallback"`, `kind`, `reason`, `codex`, `adapter`), read by `scripts/doctor.mjs` and removed by `scripts/install-lib.mjs` (Task 3).

- [ ] **Step 1: Write the fake bundled codex**

Create `test/fixtures/fake-codex-fallback.mjs`:

```js
#!/usr/bin/env node
// Stand-in for the vendor-bundled `codex` the shim execs when the adapter
// cannot start. Answers `--version` without recording anything; otherwise
// records {tag, argv} to FAKE_CODEX_ARGV_FILE, binds a unix socket when asked
// to listen on one, and stays up.
import { writeFileSync } from 'node:fs'
import net from 'node:net'

if (process.argv.includes('--version')) {
  process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? '0.0.0-fake'}\n`)
  process.exit(0)
}
if (process.env.FAKE_CODEX_ARGV_FILE) {
  writeFileSync(
    process.env.FAKE_CODEX_ARGV_FILE,
    JSON.stringify({ tag: process.env.FAKE_CODEX_TAG ?? null, argv: process.argv.slice(2) }),
  )
}
const listenIdx = process.argv.indexOf('--listen')
const listen = listenIdx >= 0 ? (process.argv[listenIdx + 1] ?? '') : ''
if (listen.startsWith('unix://')) {
  const path =
    listen === 'unix://'
      ? `${process.env.CODEX_HOME}/app-server-control/app-server-control.sock`
      : listen.slice('unix://'.length)
  net.createServer().listen(path, () => process.stderr.write(`listening on ${path}\n`))
} else {
  process.stdin.resume()
}
```

- [ ] **Step 2: Write the failing shim tests**

Create `test/shim.test.mts`:

```ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { killChildren, spawn, waitForOutput } from './helpers/children.mjs'

after(killChildren)

const shim = resolve('scripts/codex-shim')
const adapter = resolve('dist/src/adapter.mjs')
const fallback = resolve('test/fixtures/fake-codex-fallback.mjs')

// A codex binary: a shell wrapper around the fake, tagged so a test can tell
// which of two fakes the shim ran.
async function fakeCodex(dir: string, tag: string): Promise<string> {
  const path = join(dir, `codex-${tag}`)
  await writeFile(
    path,
    `#!/bin/sh\nFAKE_CODEX_TAG=${tag} exec "${process.execPath}" "${fallback}" "$@"\n`,
  )
  await chmod(path, 0o755)
  return path
}

// An adapter whose static imports cannot resolve: what a pruned
// node_modules looks like to the shim.
async function brokenAdapter(dir: string): Promise<string> {
  const path = join(dir, 'broken-adapter.mjs')
  await writeFile(path, "import 'this-package-does-not-exist'\n")
  return path
}

// Passes its selfcheck, then dies before binding anything.
async function dyingAdapter(dir: string): Promise<string> {
  const path = join(dir, 'dying-adapter.mjs')
  await writeFile(path, "if (process.argv[2] === 'selfcheck') process.exit(0)\nprocess.exit(1)\n")
  return path
}

function shimEnv(home: string, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    ANYENGINE_RUNTIME_ENV: '/dev/null',
    ANYENGINE_NODE: process.execPath,
    ANYENGINE_DEBUG_LOG: join(home, 'debug.jsonl'),
    FAKE_CODEX_ARGV_FILE: join(home, 'fake-argv.json'),
    NODE_NO_WARNINGS: '1',
    ...extra,
  }
}

async function waitForFile(path: string, timeoutMs = 4000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      await new Promise((r) => setTimeout(r, 40))
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function home(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  await mkdir(join(dir, '.codex'), { recursive: true })
  return dir
}

test('adapter selfcheck loads every static import and exits 0', () => {
  const quick = spawnSync(process.execPath, [adapter, 'selfcheck'], { encoding: 'utf8' })
  assert.equal(quick.status, 0, quick.stderr)
  assert.equal(quick.stdout.trim(), 'anyengine selfcheck ok')
  const deep = spawnSync(process.execPath, [adapter, 'selfcheck', '--deep'], { encoding: 'utf8' })
  assert.equal(deep.status, 0, deep.stderr)
  assert.equal(deep.stdout.trim(), 'anyengine selfcheck ok (deep)')
})

test('a stdio launch with a broken adapter execs the bundled codex, loudly', async () => {
  const dir = await home('anyengine-shim-stdio-')
  const stderr: string[] = []
  const proc = spawn(shim, ['-c', 'features.code_mode_host=true', 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: shimEnv(dir, {
      ANYENGINE_ADAPTER: await brokenAdapter(dir),
      ANYENGINE_REAL_CODEX: await fakeCodex(dir, 'bundled'),
      CODEX_REAL: await fakeCodex(dir, 'nvm'),
    }),
  })
  proc.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
  try {
    const recorded = JSON.parse(await waitForFile(join(dir, 'fake-argv.json')))
    assert.equal(recorded.tag, 'bundled', 'the bundled codex, never CODEX_REAL, when both exist')
    assert.deepEqual(recorded.argv, [
      '-c',
      'features.code_mode_host=true',
      'app-server',
      '--listen',
      'stdio://',
    ])
    const marker = JSON.parse(await readFile(join(dir, '.anyengine', 'shim-fallback.json'), 'utf8'))
    assert.equal(marker.event, 'shim.fallback')
    assert.equal(marker.kind, 'bundled')
    assert.match(marker.reason, /selfcheck failed/)
    const debug = await readFile(join(dir, 'debug.jsonl'), 'utf8')
    assert.match(debug, /"event":"shim\.fallback"/)
    assert.match(stderr.join(''), /codex shim: FALLBACK to the bundled codex/)
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('a unix daemon whose adapter dies before binding falls back within seconds', async () => {
  const dir = await home('anyengine-shim-unix-')
  const sock = join(tmpdir(), `ccx-fb-${Date.now().toString(36)}.sock`)
  const started = Date.now()
  const proc = spawn(shim, ['app-server', '--listen', `unix://${sock}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: shimEnv(dir, {
      ANYENGINE_ADAPTER: await dyingAdapter(dir),
      ANYENGINE_REAL_CODEX: await fakeCodex(dir, 'bundled'),
    }),
  })
  try {
    const recorded = JSON.parse(await waitForFile(join(dir, 'fake-argv.json')))
    assert.ok(Date.now() - started < 3000, 'the dead adapter is noticed, not waited out')
    assert.equal(recorded.tag, 'bundled')
    assert.deepEqual(recorded.argv, ['app-server', '--listen', `unix://${sock}`])
    const marker = JSON.parse(await readFile(join(dir, '.anyengine', 'shim-fallback.json'), 'utf8'))
    assert.match(marker.reason, /did not create/)
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
    await rm(sock, { force: true })
  }
})

test('a bundled codex that is named but gone falls to CODEX_REAL, and says it is not bundled', async () => {
  const dir = await home('anyengine-shim-gone-')
  const proc = spawn(shim, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: shimEnv(dir, {
      ANYENGINE_ADAPTER: await brokenAdapter(dir),
      ANYENGINE_REAL_CODEX: join(dir, 'no-such-codex'),
      CODEX_REAL: await fakeCodex(dir, 'nvm'),
    }),
  })
  try {
    const recorded = JSON.parse(await waitForFile(join(dir, 'fake-argv.json')))
    assert.equal(recorded.tag, 'nvm')
    const marker = JSON.parse(await readFile(join(dir, '.anyengine', 'shim-fallback.json'), 'utf8'))
    assert.equal(marker.kind, 'non-bundled CODEX_REAL')
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('the fallback still runs when its marker cannot be written', async () => {
  const dir = await home('anyengine-shim-rohome-')
  // A HOME whose .anyengine is a file: mkdir -p fails, the fallback must not.
  await writeFile(join(dir, '.anyengine'), 'not a directory\n')
  const proc = spawn(shim, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: shimEnv(dir, {
      ANYENGINE_ADAPTER: await brokenAdapter(dir),
      ANYENGINE_REAL_CODEX: await fakeCodex(dir, 'bundled'),
      ANYENGINE_DEBUG_LOG: join(dir, '.anyengine', 'debug.jsonl'),
    }),
  })
  try {
    const recorded = JSON.parse(await waitForFile(join(dir, 'fake-argv.json')))
    assert.equal(recorded.tag, 'bundled')
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('a healthy adapter is launched and nothing is marked', async () => {
  const dir = await home('anyengine-shim-ok-')
  const proc = spawn(shim, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: shimEnv(dir, {
      ANYENGINE_ADAPTER: adapter,
      ANYENGINE_MOCK: '1',
      ANYENGINE_REAL_CODEX: await fakeCodex(dir, 'bundled'),
    }),
  })
  try {
    const initialize = { clientInfo: { name: 't', version: '0' } }
    proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initialize })}\n`)
    await waitForOutput(proc, /"userAgent":"[^"]*anyengine/)
    await assert.rejects(readFile(join(dir, '.anyengine', 'shim-fallback.json')))
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})
```

Create `test/doctor.test.mts`:

```ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const doctor = resolve('scripts/doctor.mjs')

function runDoctor(home: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [doctor], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      ANYENGINE_MOCK: '1',
      ANYENGINE_RUNTIME_ENV: '/dev/null',
      ...env,
    },
  })
}

test('doctor reports a recorded shim fallback', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const clean = runDoctor(home)
    assert.equal(clean.status, 0, clean.stdout)
    mkdirSync(join(home, '.anyengine'))
    writeFileSync(
      join(home, '.anyengine', 'shim-fallback.json'),
      JSON.stringify({ ts: '2026-09-15T19:42:05Z', kind: 'bundled', reason: 'adapter cannot start' }),
    )
    const flagged = runDoctor(home)
    assert.equal(flagged.status, 1)
    assert.match(
      flagged.stdout,
      /fail - no shim fallback recorded: 2026-09-15T19:42:05Z: the shim fell back to the bundled codex \(adapter cannot start\)/,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/shim.test.mjs dist/test/doctor.test.mjs`
Expected: FAIL. `adapter selfcheck` prints the usage text and exits 1; the fallback tests time out in `waitForFile` (the committed shim execs the broken adapter); the doctor test fails on `no shim fallback recorded` (no such check).

- [ ] **Step 4: Add `selfcheck` to the adapter**

In `src/adapter.mts`, add `import { createRequire } from 'node:module'` to the imports. In `main()`, directly after `const { globals: codexGlobals, rest: args } = splitCodexGlobals(process.argv.slice(2))`, insert:

```ts
  if (args[0] === 'selfcheck') {
    await runSelfCheck(args.includes('--deep'))
    return
  }
```

Add below `splitCodexGlobals`:

```ts
// `anyengine selfcheck [--deep]`. Reaching main() at all proves every static
// import resolved (ws, every src module); this also loads node:sqlite, which
// the store requires lazily. The shim runs it before it hands the app this
// process (scripts/codex-shim). `--deep` loads what the runtimes pull in
// later, for install and doctor.
async function runSelfCheck(deep: boolean): Promise<void> {
  const require = createRequire(import.meta.url)
  require('node:sqlite')
  if (deep) {
    require('node-pty')
    await import('@xterm/headless')
    import.meta.resolve('@anthropic-ai/claude-agent-sdk')
  }
  process.stdout.write(`anyengine selfcheck ok${deep ? ' (deep)' : ''}\n`)
}
```

In `usage()`, add the line `  anyengine selfcheck [--deep]` after `  anyengine app-server proxy [--sock PATH]`.

- [ ] **Step 5: Rewrite the shim**

Replace `scripts/codex-shim` with the following. Unchanged from the committed file: the legacy-env block, `RUNTIME_ENV` sourcing, `resolve_real_codex`, `is_native_codex_mode`, the global-option split and the `--version` branch.

```bash
#!/usr/bin/env bash
# anyengine codex shim (marker: ANYENGINE_ADAPTER). ChatGPT.app 26.9xx launches
# `codex -c features.code_mode_host=true app-server --listen unix://`, so the
# subcommand is not argv[1]. Strip leading global options before deciding.
set -euo pipefail

# One-release compatibility: accept the pre-rebrand CLAUDE_CODEX_* spellings.
# Each legacy name is copied onto its ANYENGINE_* equivalent unless that is
# already set (the new name always wins). Drop this block one release after
# the rename; see src/env-compat.mts for the adapter-side twin.
anyengine_adopt_legacy_env() {
  local legacy new
  while IFS= read -r legacy; do
    [ -n "$legacy" ] || continue
    new="ANYENGINE_${legacy#CLAUDE_CODEX_}"
    eval ": \"\${$new:=\$$legacy}\"" 2>/dev/null || continue
    eval "export $new"
  done <<EOF
$(env | sed -n 's/^\(CLAUDE_CODEX_[A-Za-z0-9_]*\)=.*/\1/p')
EOF
  # `set -e` is on: pin the status so an empty list is not a failure.
  return 0
}
anyengine_adopt_legacy_env

RUNTIME_ENV="${ANYENGINE_RUNTIME_ENV:-${CLAUDE_CODEX_RUNTIME_ENV:-}}"
if [ -z "$RUNTIME_ENV" ]; then
  RUNTIME_ENV="$HOME/.anyengine/runtime.env"
  # Pre-rebrand state directory, honoured while it is the only one present.
  [ -f "$RUNTIME_ENV" ] || [ ! -f "$HOME/.claude-codex/runtime.env" ] || \
    RUNTIME_ENV="$HOME/.claude-codex/runtime.env"
fi
if [ -f "$RUNTIME_ENV" ]; then
  # shellcheck source=/dev/null
  source "$RUNTIME_ENV"
  anyengine_adopt_legacy_env
fi

ADAPTER="${ANYENGINE_ADAPTER:-/opt/anyengine/dist/src/adapter.mjs}"
NODE_BIN="${ANYENGINE_NODE:-node}"
COMPAT_VERSION="${ANYENGINE_COMPAT_VERSION:-${CODEX_SHIM_COMPAT_VERSION:-0.142.3}}"
VERSION_SUFFIX="${ANYENGINE_VERSION_SUFFIX-anyengine}"
MODE="${ANYENGINE_ROUTE:-${ANYENGINE_RUNTIME_TYPE:-agent-sdk-sidecar}}"
# The desktop's own codex. A fallback runs this, never whatever codex PATH
# finds first: a fallback onto another version is how 2026-09-15 went unseen.
BUNDLED_CODEX_DEFAULT="/Applications/ChatGPT.app/Contents/Resources/codex"

resolve_real_codex() {
  if [ -n "${CODEX_REAL:-}" ] && [ -x "$CODEX_REAL" ]; then
    printf '%s\n' "$CODEX_REAL"; return 0
  fi
  local self candidate
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    [ "$candidate" != "$self" ] || continue
    [ -x "$candidate" ] || continue
    printf '%s\n' "$candidate"; return 0
  done < <({ type -P -a codex 2>/dev/null || which -a codex 2>/dev/null; } | awk '!seen[$0]++')
  return 1
}

# ANYENGINE_REAL_CODEX names the bundled codex on a live install. When it is
# set but gone (an app update moved it), do not guess another path.
resolve_bundled_codex() {
  if [ -n "${ANYENGINE_REAL_CODEX:-}" ]; then
    [ -x "$ANYENGINE_REAL_CODEX" ] || return 1
    printf '%s\n' "$ANYENGINE_REAL_CODEX"; return 0
  fi
  [ -x "$BUNDLED_CODEX_DEFAULT" ] || return 1
  printf '%s\n' "$BUNDLED_CODEX_DEFAULT"
}

is_native_codex_mode() {
  case "$MODE" in codex|native-codex|real-codex|native|real) return 0;; esac
  return 1
}

# `selfcheck` exits 0 only once every static import of the adapter resolved:
# a pruned node_modules or a half-written install fails here, before the app
# is handed a process that dies with ERR_MODULE_NOT_FOUND and shows
# `(code=1, signal=null)`.
adapter_ready() {
  [ -f "$ADAPTER" ] || return 1
  "$NODE_BIN" "$ADAPTER" selfcheck >/dev/null 2>&1
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Loud on purpose: a line in the app's log (stderr), a `shim.fallback` event
# in the adapter's debug log, and ~/.anyengine/shim-fallback.json, which stays
# until `npm run install:lib` succeeds, so `npm run doctor` reports it after
# the app has restarted. Every write is best effort: the fallback must never
# fail because a log could not be written.
announce_fallback() {
  local why="$1" target="$2" kind="$3" line log
  echo "codex shim: FALLBACK to the ${kind} codex at ${target}: ${why}" >&2
  line="{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"pid\":$$,\"event\":\"shim.fallback\",\"kind\":\"${kind}\",\"reason\":\"$(json_escape "$why")\",\"codex\":\"$(json_escape "$target")\",\"adapter\":\"$(json_escape "$ADAPTER")\"}"
  { mkdir -p "$HOME/.anyengine" && printf '%s\n' "$line" >"$HOME/.anyengine/shim-fallback.json"; } 2>/dev/null || true
  case "${ANYENGINE_DEBUG_LOG:-}" in 0|false) return 0 ;; esac
  log="${ANYENGINE_DEBUG_LOG:-${ANYENGINE_HOME:-${CODEX_HOME:-$HOME/.codex}/anyengine}/debug.jsonl}"
  { mkdir -p "$(dirname "$log")" && printf '%s\n' "$line" >>"$log"; } 2>/dev/null || true
}

# $1 is the reason; the rest is the caller's original argv, so the bundled
# codex sees the desktop's `-c` flags exactly as the adapter would have.
fallback_to_bundled() {
  local why="$1" target kind="bundled"
  shift
  target="$(resolve_bundled_codex || true)"
  if [ -z "$target" ] && [ -n "$REAL_CODEX" ]; then
    target="$REAL_CODEX"
    kind="non-bundled CODEX_REAL"
  fi
  if [ -z "$target" ]; then
    echo "codex shim: ${why}; no bundled codex to fall back to (set ANYENGINE_REAL_CODEX)" >&2
    return 1
  fi
  announce_fallback "$why" "$target" "$kind"
  exec "$target" "$@"
}

REAL_CODEX="$(resolve_real_codex || true)"

# Split leading global options (e.g. `-c key=value`, `--config key=value`) from
# the subcommand and its args.
GLOBAL_OPTS=()
REST=("$@")
while [ "${#REST[@]}" -gt 0 ]; do
  case "${REST[0]}" in
    -c|--config|-m|--model|-p|--profile|-C|--cd)
      GLOBAL_OPTS+=("${REST[0]}" "${REST[1]:-}"); REST=("${REST[@]:2}") ;;
    -c=*|--config=*|-m=*|--model=*|--profile=*|--cd=*)
      GLOBAL_OPTS+=("${REST[0]}"); REST=("${REST[@]:1}") ;;
    *) break ;;
  esac
done
SUBCMD="${REST[0]:-}"

# The `unix://...` argument of an app-server launch, if there is one.
unix_listen_arg() {
  local a
  for a in "${REST[@]}"; do
    case "$a" in unix://*) printf '%s\n' "$a"; return 0 ;; esac
  done
  return 1
}

case "$SUBCMD" in
  --version|-V|version)
    if is_native_codex_mode && [ -n "$REAL_CODEX" ]; then exec "$REAL_CODEX" "$@"; fi
    echo "${CODEX_SHIM_VERSION:-codex-cli ${COMPAT_VERSION}${VERSION_SUFFIX:+ (${VERSION_SUFFIX})}}"
    exit 0 ;;
  app-server)
    if is_native_codex_mode; then
      if [ -n "$REAL_CODEX" ]; then exec "$REAL_CODEX" "$@"; fi
      echo "codex shim is in native Codex mode, but no real codex binary was found; set CODEX_REAL" >&2
      exit 127
    fi
    if ! adapter_ready; then
      fallback_to_bundled "adapter cannot start (selfcheck failed for ${ADAPTER})" "$@" || true
      # Nothing could be run. A unix:// bootstrap still exits 0 so the app's
      # SSH step reports the missing socket instead of a failed command.
      if unix_listen_arg >/dev/null; then exit 0; fi
      exit 1
    fi
    # Leading -c globals are passed through: the adapter records them and
    # replays the identical argv when it spawns the real app-server child
    # (native-codex passthrough, docs/guide/backends.md).
    # Daemon mode (--listen unix://) is launched by the App over SSH with nohup;
    # detach stdin so the SSH bootstrap session returns instead of timing out.
    # Real codex daemonises here and returns; the App's bootstrap subshell waits
    # for this command, so we must return too: background the adapter (stdout/
    # stderr already point at the App's log), wait for its socket, exit 0.
    if LISTEN="$(unix_listen_arg)"; then
      SOCK="${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server-control.sock"
      [ "$LISTEN" != "unix://" ] && SOCK="${LISTEN#unix://}"
      # The SSH/Remote twin serves Claude + Grok only; the desktop LOCAL host
      # (stdio) owns the native GPT passthrough.
      ANYENGINE_NATIVE_CODEX="${ANYENGINE_REMOTE_NATIVE_CODEX:-0}" \
        "$NODE_BIN" "$ADAPTER" ${GLOBAL_OPTS[@]+"${GLOBAL_OPTS[@]}"} "${REST[@]}" </dev/null &
      adapter_pid=$!
      disown 2>/dev/null || true
      for _ in $(seq 1 100); do
        [ -S "$SOCK" ] && exit 0
        kill -0 "$adapter_pid" 2>/dev/null || break
        sleep 0.1
      done
      kill "$adapter_pid" 2>/dev/null || true
      fallback_to_bundled "adapter did not create $SOCK" "$@" || exit 0
    fi
    exec "$NODE_BIN" "$ADAPTER" ${GLOBAL_OPTS[@]+"${GLOBAL_OPTS[@]}"} "${REST[@]}" ;;
esac

if [ -n "$REAL_CODEX" ]; then exec "$REAL_CODEX" "$@"; fi
echo "codex shim supports --version and app-server; set CODEX_REAL for fallback" >&2
exit 127
```

- [ ] **Step 6: Add the two doctor checks**

In `scripts/doctor.mjs`, change the fs import to `import { existsSync, readFileSync } from 'node:fs'`, add `import { homedir } from 'node:os'` and change the path import to `import { join, resolve } from 'node:path'`. Directly after the `built adapter exists` check, insert:

```js
check('adapter selfcheck (deep)', () => {
  // Loads every static import plus node-pty, @xterm/headless and the SDK: a
  // pruned node_modules fails here instead of in the app.
  const adapter = process.env.ANYENGINE_ADAPTER || resolve('dist/src/adapter.mjs')
  run(process.env.ANYENGINE_NODE || process.execPath, [adapter, 'selfcheck', '--deep'])
})

check('no shim fallback recorded', () => {
  const marker = join(homedir(), '.anyengine', 'shim-fallback.json')
  if (!existsSync(marker)) return
  const event = JSON.parse(readFileSync(marker, 'utf8'))
  throw new Error(
    `${event.ts}: the shim fell back to the ${event.kind} codex (${event.reason}); ` +
      'fix the adapter, then run npm run install:lib (which clears this marker)',
  )
})
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/shim.test.mjs dist/test/doctor.test.mjs`
Expected: PASS, `ℹ pass 7`, `ℹ fail 0`.

- [ ] **Step 8: Update the shim's description**

In `scripts/AGENTS.md`, replace the whole `codex-shim` bullet (it starts with ``- `codex-shim` `` and ends with ``bash-3.2 safe (macOS `/bin/bash`).``) with:

```markdown
- `codex-shim`: the `PATH` shim Codex App invokes. Routes `codex app-server`
  into the adapter (`ANYENGINE_ADAPTER`), passing the desktop's leading `-c`
  globals through so the adapter can replay them to the real child; forwards
  everything else to the real Codex CLI (`CODEX_REAL`). Before it hands the app
  an adapter it runs `adapter.mjs selfcheck`. When that fails (a pruned
  `node_modules`, a half-written install) or a daemon's socket never appears,
  it execs the vendor-bundled codex (`ANYENGINE_REAL_CODEX`, else the app
  bundle; `CODEX_REAL` only as a last resort, labelled as such) and says so: a
  line in the app log, a `shim.fallback` event in the debug log, and
  `~/.anyengine/shim-fallback.json`, which `npm run doctor` reports until
  `npm run install:lib` succeeds. Keep it dependency-free and bash-3.2 safe
  (macOS `/bin/bash`).
```

Add to `CHANGELOG.md` under `### M0: adapter safe`:

```markdown
- **A broken adapter no longer takes the app down, and no longer hides.** The
  shim runs `adapter.mjs selfcheck` first; if the adapter cannot load (the
  2026-09-15 outage was a pruned `node_modules`), it execs the app's own
  bundled codex and records why in the app log, the debug log and
  `~/.anyengine/shim-fallback.json`, which `npm run doctor` reports.
```

- [ ] **Step 9: Gates and commit**

Run: `npm run check && npm run typecheck && npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/adapter.mts scripts/codex-shim scripts/doctor.mjs scripts/AGENTS.md \
  test/fixtures/fake-codex-fallback.mjs test/shim.test.mts test/doctor.test.mts CHANGELOG.md
git commit -m "fix: fall back to the bundled codex, loudly, when the adapter cannot start"
```

---
### Task 3: Janitor-proof install under `~/.anyengine/lib`

The live adapter ran from a development checkout, and a cleanup job that prunes `node_modules` in idle project directories deleted its dependencies (2026-09-15, and again about three days after every reinstall). After this task the adapter runs from `~/.anyengine/lib/<version>/`, built once from a committed tree, verified by file hashes plus a deep selfcheck before `current` moves to it, and outside every project directory.

**Files:**
- Create: `scripts/lib-verify.mjs`
- Create: `scripts/install-lib.mjs`
- Create: `test/fixtures/fake-npm.mjs`
- Create: `test/install-lib.test.mts`
- Modify: `test/doctor.test.mts` (one new test)
- Modify: `scripts/doctor.mjs` (lib integrity check)
- Modify: `scripts/codex-shim:39` (default adapter path)
- Modify: `package.json` (`scripts.install:lib`), `package-lock.json` (root entry)
- Modify: `README.md` (Install), `docs/guide/deployment.md` (Install the shim), `docs/guide/configuration.md` (`ANYENGINE_ADAPTER` row), `scripts/AGENTS.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `adapter.mjs selfcheck --deep` (Task 2); the marker path `~/.anyengine/shim-fallback.json` (Task 2).
- Produces: `scripts/lib-verify.mjs` exports `MANIFEST = 'install-manifest.json'`, `writeManifest(dir: string, meta: object): void`, `verifyLib(dir: string): string[]` (problems; empty means verified) and runs as `node scripts/lib-verify.mjs <libDir>`. `node scripts/install-lib.mjs [--dest-root DIR] [--source DIR] [--version V] [--npm CMD] [--keep N] [--allow-scripts]` installs `<dest-root>/<version>/` (default dest root `~/.anyengine/lib`, default version `<package version>-<12-char commit>` from a clean tree) and points `<dest-root>/current` at it. The shim's default adapter becomes `$HOME/.anyengine/lib/current/dist/src/adapter.mjs`.

- [ ] **Step 1: Write the fake npm**

Create `test/fixtures/fake-npm.mjs`:

```js
#!/usr/bin/env node
// Stand-in for `npm ci --omit=dev` in the install-lib tests: records its argv,
// then writes a minimal ESM package for every runtime dependency of the
// package.json in the cwd. FAKE_NPM_FAIL=1 makes it fail like a broken install.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.env.FAKE_NPM_ARGV_FILE) {
  appendFileSync(process.env.FAKE_NPM_ARGV_FILE, `${JSON.stringify(process.argv.slice(2))}\n`)
}
if (process.env.FAKE_NPM_FAIL === '1') process.exit(3)
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
for (const name of Object.keys(pkg.dependencies ?? {})) {
  const dir = join('node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', type: 'module', main: 'index.js' }),
  )
  writeFileSync(join(dir, 'index.js'), 'export default {}\n')
}
```

- [ ] **Step 2: Write the failing install tests**

Create `test/install-lib.test.mts`:

```ts
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { killChildren, spawn } from './helpers/children.mjs'

after(killChildren)

const installLib = resolve('scripts/install-lib.mjs')
const libVerify = resolve('scripts/lib-verify.mjs')
const fakeNpm = resolve('test/fixtures/fake-npm.mjs')

// A package shaped like this repo: a built adapter whose `selfcheck` imports
// its one runtime dependency, a compiled test that must not ship, and the
// permission fix-up script install-lib runs after `npm ci`.
function makeSource(root: string): string {
  const source = join(root, 'source')
  for (const dir of ['dist/src', 'dist/test', 'scripts']) {
    mkdirSync(join(source, dir), { recursive: true })
  }
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({ name: 'anyengine', version: '9.9.9', type: 'module', dependencies: { ws: '^8.0.0' } }),
  )
  writeFileSync(join(source, 'package-lock.json'), '{}\n')
  writeFileSync(join(source, 'LICENSE'), 'MIT\n')
  writeFileSync(join(source, 'dist', 'test', 'x.test.mjs'), '\n')
  writeFileSync(join(source, 'scripts', 'fix-node-pty-permissions.mjs'), '\n')
  writeFileSync(
    join(source, 'dist', 'src', 'adapter.mjs'),
    [
      "import 'ws'",
      "if (process.argv[2] === 'selfcheck') {",
      "  if (process.env.FAKE_ADAPTER_BROKEN === '1') process.exit(1)",
      "  console.log('anyengine selfcheck ok')",
      '}',
      '',
    ].join('\n'),
  )
  return source
}

function install(root: string, source: string, version: string | null, env: NodeJS.ProcessEnv = {}) {
  const args = [installLib, '--source', source, '--dest-root', join(root, 'lib'), '--npm', fakeNpm]
  if (version) args.push('--version', version)
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, HOME: join(root, 'home'), ...env },
  })
}

function versions(root: string): string[] {
  return readdirSync(join(root, 'lib'))
    .filter((name) => !name.startsWith('.'))
    .sort()
}

test('install-lib installs, verifies and points current at the new version', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    const source = makeSource(root)
    mkdirSync(join(root, 'home', '.anyengine'), { recursive: true })
    writeFileSync(join(root, 'home', '.anyengine', 'shim-fallback.json'), '{}\n')
    const result = install(root, source, 'v1', { FAKE_NPM_ARGV_FILE: join(root, 'npm-argv.jsonl') })
    assert.equal(result.status, 0, result.stderr)
    const lib = join(root, 'lib')
    assert.equal(readlinkSync(join(lib, 'current')), 'v1')
    assert.ok(existsSync(join(lib, 'v1', 'node_modules', 'ws', 'package.json')))
    assert.ok(existsSync(join(lib, 'v1', 'install-manifest.json')))
    assert.ok(!existsSync(join(lib, 'v1', 'dist', 'test')), 'only dist/src ships')
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'npm-argv.jsonl'), 'utf8')), [
      'ci',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
    ])
    assert.ok(
      !existsSync(join(root, 'home', '.anyengine', 'shim-fallback.json')),
      'a verified install clears the fallback marker',
    )
    const verify = spawnSync(process.execPath, [libVerify, join(lib, 'current')], { encoding: 'utf8' })
    assert.equal(verify.status, 0, verify.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('lib-verify names a pruned dependency and an edited file', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    assert.equal(install(root, makeSource(root), 'v1').status, 0)
    const lib = join(root, 'lib', 'v1')
    rmSync(join(lib, 'node_modules', 'ws'), { recursive: true })
    writeFileSync(join(lib, 'LICENSE'), 'changed\n')
    const verify = spawnSync(process.execPath, [libVerify, lib], { encoding: 'utf8' })
    assert.equal(verify.status, 1)
    assert.match(verify.stderr, /missing: node_modules\/ws\/package\.json/)
    assert.match(verify.stderr, /changed: LICENSE/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a lib that fails its selfcheck never becomes current', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    const source = makeSource(root)
    assert.equal(install(root, source, 'v1').status, 0)
    const broken = install(root, source, 'v2', { FAKE_ADAPTER_BROKEN: '1' })
    assert.equal(broken.status, 1)
    assert.match(broken.stderr, /selfcheck --deep failed/)
    assert.equal(readlinkSync(join(root, 'lib', 'current')), 'v1')
    assert.deepEqual(readdirSync(join(root, 'lib')).sort(), ['current', 'v1'], 'no staging left')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an upgrade keeps the running version and the previous one, and prunes the rest', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  // Stands in for the app's adapter, still running from v1 after v2..v4 land.
  let running: ReturnType<typeof spawn> | null = null
  try {
    const source = makeSource(root)
    assert.equal(install(root, source, 'v1').status, 0)
    running = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', join(root, 'lib', 'v1', 'dist', 'src', 'adapter.mjs')],
      { stdio: 'ignore' },
    )
    for (const version of ['v2', 'v3', 'v4']) assert.equal(install(root, source, version).status, 0)
    assert.equal(readlinkSync(join(root, 'lib', 'current')), 'v4')
    assert.deepEqual(versions(root), ['current', 'v1', 'v3', 'v4'])
  } finally {
    running?.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})

test('reinstalling a verified version only moves current', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    const source = makeSource(root)
    for (const version of ['v1', 'v2']) assert.equal(install(root, source, version).status, 0)
    const again = install(root, source, 'v1')
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /v1 is already installed and verified/)
    assert.equal(readlinkSync(join(root, 'lib', 'current')), 'v1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a source tree with uncommitted changes is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    const source = makeSource(root)
    const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { stdio: 'ignore' })
    git('init')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init')
    writeFileSync(join(source, 'stray.txt'), 'uncommitted\n')
    const result = install(root, source, null)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /uncommitted changes/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
```

Add to `test/doctor.test.mts`:

```ts
test('doctor refuses a live adapter that is not a verified lib', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const result = runDoctor(home, { ANYENGINE_ADAPTER: resolve('dist/src/adapter.mjs') })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /fail - live adapter runs from a verified lib: .* is not an installed lib/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/install-lib.test.mjs dist/test/doctor.test.mjs`
Expected: FAIL with `Cannot find module '.../scripts/install-lib.mjs'` (status 1 and empty stdout in every install test) and the doctor test missing its `live adapter runs from a verified lib` line.

- [ ] **Step 4: Write the verifier**

Create `scripts/lib-verify.mjs`:

```js
#!/usr/bin/env node
// Verify an installed adapter lib (scripts/install-lib.mjs): every file the
// manifest lists is present with its recorded sha256, every symlink points
// where it did, and the adapter passes `selfcheck --deep`. Used by install-lib
// before `current` moves, and by `npm run doctor`.
//
// Usage: node scripts/lib-verify.mjs <libDir>
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MANIFEST = 'install-manifest.json'

function walk(dir, root, tree) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = relative(root, full)
    if (rel === MANIFEST) continue
    if (entry.isSymbolicLink()) tree.links[rel] = readlinkSync(full)
    else if (entry.isDirectory()) walk(full, root, tree)
    else if (entry.isFile()) tree.files[rel] = sha256(full)
  }
  return tree
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function writeManifest(dir, meta) {
  const tree = walk(dir, dir, { files: {}, links: {} })
  const manifest = { ...meta, node: process.version, createdAt: new Date().toISOString(), ...tree }
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 1)}\n`)
}

export function verifyLib(dir) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'))
  } catch {
    return [`${MANIFEST} is missing or unreadable`]
  }
  const actual = walk(dir, dir, { files: {}, links: {} })
  const problems = []
  for (const [rel, hash] of Object.entries(manifest.files ?? {})) {
    if (!(rel in actual.files)) problems.push(`missing: ${rel}`)
    else if (actual.files[rel] !== hash) problems.push(`changed: ${rel}`)
  }
  for (const [rel, target] of Object.entries(manifest.links ?? {})) {
    if (actual.links[rel] !== target) problems.push(`link missing or moved: ${rel}`)
  }
  if (problems.length > 0) return problems
  const adapter = join(dir, 'dist', 'src', 'adapter.mjs')
  const check = spawnSync(process.execPath, [adapter, 'selfcheck', '--deep'], { encoding: 'utf8' })
  if (check.status !== 0) {
    const last = `${check.stderr}${check.stdout}`.trim().split('\n').at(-1) ?? ''
    problems.push(`selfcheck --deep failed: ${last}`)
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: node scripts/lib-verify.mjs <libDir>')
    process.exit(2)
  }
  const problems = verifyLib(dir)
  if (problems.length > 0) {
    console.error(`lib-verify: ${dir} does not verify:\n  ${problems.slice(0, 20).join('\n  ')}`)
    process.exit(1)
  }
  console.log(`lib-verify: ${dir} ok`)
}
```

- [ ] **Step 5: Write the installer**

Create `scripts/install-lib.mjs`:

```js
#!/usr/bin/env node
// Install the built adapter and its production dependencies under
// ~/.anyengine/lib/<version>/ and point ~/.anyengine/lib/current at it.
//
// The live adapter must not run from a project checkout: a cleanup job that
// prunes node_modules in idle projects broke the live install on 2026-09-15.
// A lib is built once from a committed tree, verified (file hashes and a deep
// selfcheck) before `current` moves, and never touched by development work.
// The shim's default adapter is ~/.anyengine/lib/current/dist/src/adapter.mjs.
//
// Usage: node scripts/install-lib.mjs [--dest-root DIR] [--source DIR]
//          [--version V] [--npm CMD] [--keep N] [--allow-scripts]
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyLib, writeManifest } from './lib-verify.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// What a lib holds: the compiled adapter, the scripts it runs (hook relay,
// shim, pty bridge, doctor), and what `npm ci` needs.
const COPY = ['dist/src', 'scripts', 'package.json', 'package-lock.json', 'LICENSE']

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function fail(message) {
  console.error(`install-lib: ${message}`)
  process.exit(1)
}

// `<package version>-<commit>`, from a clean tree only: a lib has to be
// something a commit can reproduce.
function versionFromGit(dir) {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  if (git('status', '--porcelain') !== '') {
    fail('the source tree has uncommitted changes; commit or stash them first')
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  return `${pkg.version}-${git('rev-parse', '--short=12', 'HEAD')}`
}

function sourceCommit(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

const source = resolve(option('--source', repo))
const destRoot = resolve(option('--dest-root', join(homedir(), '.anyengine', 'lib')))
const npm = option('--npm', 'npm')
const keep = Math.max(2, Number(option('--keep', '2')) || 2)
const version = option('--version', null) ?? versionFromGit(source)
if (!/^[A-Za-z0-9._-]+$/.test(version)) fail(`unusable version: ${version}`)
if (!existsSync(join(source, 'dist', 'src', 'adapter.mjs'))) {
  fail('dist/src/adapter.mjs is missing; run npm run build first')
}

function runNpmCi(cwd) {
  const args = ['ci', '--omit=dev', '--no-audit', '--no-fund']
  // Dependency install scripts stay off unless asked for; node-pty ships
  // prebuilt binaries, and the one script that matters here runs below.
  if (!process.argv.includes('--allow-scripts')) args.push('--ignore-scripts')
  const [command, prefix] = npm.endsWith('.mjs') ? [process.execPath, [npm]] : [npm, []]
  const result = spawnSync(command, [...prefix, ...args], { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${npm} ${args.join(' ')} exited ${result.status}`)
  const fixup = join(cwd, 'scripts', 'fix-node-pty-permissions.mjs')
  if (existsSync(fixup)) spawnSync(process.execPath, [fixup], { cwd, stdio: 'inherit' })
}

function stageAndInstall(target) {
  const staging = join(destRoot, `.staging-${version}-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  try {
    for (const entry of COPY) {
      if (!existsSync(join(source, entry))) continue
      mkdirSync(dirname(join(staging, entry)), { recursive: true })
      cpSync(join(source, entry), join(staging, entry), { recursive: true })
    }
    runNpmCi(staging)
    writeManifest(staging, { version, commit: sourceCommit(source) })
    const problems = verifyLib(staging)
    if (problems.length > 0) {
      throw new Error(`the staged lib does not verify:\n  ${problems.slice(0, 10).join('\n  ')}`)
    }
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    fail(error instanceof Error ? error.message : String(error))
  }
}

// Swap the link atomically: a shim starting mid-install sees the old version
// or the new one, never neither.
function pointCurrent(target) {
  const temp = join(destRoot, `.current-${process.pid}`)
  rmSync(temp, { force: true })
  symlinkSync(basename(target), temp)
  renameSync(temp, join(destRoot, 'current'))
}

// Versions a live process runs from (its argv names the version directory):
// removing one would pull the relay script and lazily loaded modules out
// from under the app's adapter.
function versionsInUse() {
  const ps = spawnSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' })
  return (ps.stdout ?? '').split('\n')
}

// Keep `current`, the newest other version (the rollback target) and any
// version a running process uses; remove the rest.
function prune() {
  const current = readlinkSync(join(destRoot, 'current'))
  const commands = versionsInUse()
  const others = readdirSync(destRoot)
    .filter((name) => !name.startsWith('.') && name !== 'current' && name !== current)
    .map((name) => ({ name, mtime: statSync(join(destRoot, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const [index, { name }] of others.entries()) {
    if (index < keep - 1) continue
    const dir = join(destRoot, name)
    if (commands.some((command) => command.includes(`${dir}/`))) continue
    rmSync(dir, { recursive: true, force: true })
  }
}

mkdirSync(destRoot, { recursive: true, mode: 0o700 })
const target = join(destRoot, version)
if (existsSync(target)) {
  const problems = verifyLib(target)
  if (problems.length > 0) {
    fail(`${target} exists but does not verify:\n  ${problems.slice(0, 10).join('\n  ')}\nremove it and re-run`)
  }
  console.log(`install-lib: ${version} is already installed and verified`)
} else {
  stageAndInstall(target)
}
pointCurrent(target)
prune()
rmSync(join(homedir(), '.anyengine', 'shim-fallback.json'), { force: true })
console.log(`install-lib: current -> ${target}`)
```

- [ ] **Step 6: Add the doctor check**

In `scripts/doctor.mjs`, change the fs import to `import { existsSync, readFileSync, realpathSync } from 'node:fs'`, the path import to `import { dirname, join, resolve } from 'node:path'`, add `import { verifyLib } from './lib-verify.mjs'`, and insert after the `no shim fallback recorded` check:

```js
check('live adapter runs from a verified lib', () => {
  // Unset: development use (`npm run doctor` in a checkout), nothing to check.
  const adapter = process.env.ANYENGINE_ADAPTER
  if (!adapter) return
  const lib = resolve(dirname(realpathSync(adapter)), '..', '..')
  if (!existsSync(join(lib, 'install-manifest.json'))) {
    throw new Error(
      `${adapter} is not an installed lib; dependency cleanup can prune a checkout's ` +
        'node_modules under it. Run npm run install:lib and point ANYENGINE_ADAPTER at ' +
        '~/.anyengine/lib/current/dist/src/adapter.mjs',
    )
  }
  const problems = verifyLib(lib)
  if (problems.length > 0) throw new Error(problems.slice(0, 5).join('; '))
})
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/install-lib.test.mjs dist/test/doctor.test.mjs`
Expected: PASS, `ℹ pass 8`, `ℹ fail 0`.

- [ ] **Step 8: Point the shim, npm and the docs at the lib**

In `scripts/codex-shim`, replace
`ADAPTER="${ANYENGINE_ADAPTER:-/opt/anyengine/dist/src/adapter.mjs}"` with:

```bash
# The installed lib (npm run install:lib), outside every project directory.
ADAPTER="${ANYENGINE_ADAPTER:-$HOME/.anyengine/lib/current/dist/src/adapter.mjs}"
```

In `package.json` `scripts`, add `"install:lib": "npm run build && node scripts/install-lib.mjs",`.

In `README.md`, replace the `## Install` code block and the sentence after it with:

````markdown
```bash
npm ci
npm run install:lib                 # build, then install to ~/.anyengine/lib/<version>
mkdir -p ~/bin
cp ~/.anyengine/lib/current/scripts/codex-shim ~/bin/codex   # the app looks for `codex`
chmod +x ~/bin/codex
export PATH="$HOME/bin:$PATH"
```

The shim runs `~/.anyengine/lib/current/dist/src/adapter.mjs` unless
`ANYENGINE_ADAPTER` names another adapter. The lib is built from a committed
tree and verified before `current` moves to it; it lives outside every project
directory, so cleanup tools that prune `node_modules` in idle checkouts cannot
break it. `npm run doctor` checks it. Then open ChatGPT.app, start a thread,
and pick Claude or Grok from the model picker.
````

In `docs/guide/deployment.md`, replace the `## Install the shim` code block (the `mkdir -p ~/bin` / `cp scripts/codex-shim ~/bin/codex` block) with:

````markdown
```bash
npm ci && npm run install:lib        # ~/.anyengine/lib/<version>, ~/.anyengine/lib/current
mkdir -p ~/bin
cp ~/.anyengine/lib/current/scripts/codex-shim ~/bin/codex && chmod +x ~/bin/codex
```

Run the adapter from the installed lib, not from a checkout: tools that prune
`node_modules` in idle projects will otherwise delete its dependencies.
````

In `docs/guide/configuration.md`, replace the `ANYENGINE_ADAPTER` reference row with:

```markdown
| `ANYENGINE_ADAPTER` | Adapter entry the shim runs (default `~/.anyengine/lib/current/dist/src/adapter.mjs`, installed by `npm run install:lib`). |
```

In `scripts/AGENTS.md`, add after the `doctor.mjs` bullet:

```markdown
- `install-lib.mjs`: installs the built adapter and its production
  dependencies under `~/.anyengine/lib/<version>/` from a clean tree, verifies
  it, moves `~/.anyengine/lib/current`, prunes old versions nothing runs from
  (`npm run install:lib`).
- `lib-verify.mjs`: checks an installed lib against its manifest (file
  hashes) and runs `selfcheck --deep`; used by install-lib and doctor.
```

Add to `CHANGELOG.md` under `### M0: adapter safe`:

```markdown
- **The live adapter runs from an installed lib.** `npm run install:lib`
  builds from a committed tree into `~/.anyengine/lib/<version>/`, verifies it
  (file hashes plus a deep selfcheck) and only then moves
  `~/.anyengine/lib/current`, which is where the shim looks by default. A
  cleanup job pruning `node_modules` in idle projects can no longer break it,
  and `npm run doctor` fails if the live adapter is a checkout.
```

- [ ] **Step 9: Bring the lockfile's root entry in line with package.json**

The committed `package-lock.json` pins `@xterm/headless` and `node-pty` exactly in its root entry while `package.json` asks for `^6.0.0` and `^1.1.0`, and it omits `hasInstallScript`. The lib install runs `npm ci` from this file.

Run: `command npm install --package-lock-only --ignore-scripts --no-audit --no-fund && git diff --stat package-lock.json`
Expected: only `package-lock.json` changes. `git diff package-lock.json` shows the root entry's `"@xterm/headless": "^6.0.0"`, `"node-pty": "^1.1.0"` and `"hasInstallScript": true`, plus `"peer": true` flags moving between packages (npm version churn). This is the same diff the main checkout carries uncommitted. If any `"version"` line changes, stop and discard the change (`git checkout package-lock.json`): the lock must not move dependencies in M0.

Run: `npm ci && npm test`
Expected: `ℹ fail 0`.

- [ ] **Step 10: Gates and commit**

Run: `npm run check && npm run typecheck`
Expected: all gates OK.

```bash
git add scripts/install-lib.mjs scripts/lib-verify.mjs scripts/doctor.mjs scripts/codex-shim \
  scripts/AGENTS.md test/fixtures/fake-npm.mjs test/install-lib.test.mts test/doctor.test.mts \
  package.json package-lock.json README.md docs/guide/deployment.md docs/guide/configuration.md \
  CHANGELOG.md
git commit -m "feat: install the adapter as a verified lib under ~/.anyengine/lib"
```

---

### Task 4: Bridge `-c` after the app's subcommand `-c`

ChatGPT.app 26.911 launches `codex -c features.code_mode_host=true app-server --analytics-default-enabled -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true`. When a subcommand `-c` exists, codex 0.154 and 0.155 ignore every root-level `-c`, so the adapter's `mcp_servers.anyengine` override (placed before `app-server`) vanished and GPT threads lost the bridge. The fix is the spike's `9235def` without its port pinning (`src/spike-ports.mts` is spike-only: it pinned loopback listeners to a port range for a headless run and does not belong in the product).

**Files:**
- Modify: `src/adapter.mts:114-121` (child argv), add `childArgv` below `splitCodexGlobals`
- Modify: `test/codex-mux.test.mts:19-39` (argv constants and assertion), `:110-147` (`launch`), new test after `:325`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: `childArgv(globals: string[], extra: string[], rest: string[]): string[]` (module-private in `src/adapter.mts`).

- [ ] **Step 1: Write the failing test**

In `test/codex-mux.test.mts`, replace `DESKTOP_ARGV` and `assertDesktopArgvReplayed` with:

```ts
// ChatGPT.app 26.911 passes its own subcommand-level `-c` after `app-server`;
// 26.901 did not.
const DESKTOP_ARGV = [
  '-c',
  'features.code_mode_host=true',
  'app-server',
  '--analytics-default-enabled',
  '-c',
  'mcp_servers.codex_app={command="/tmp/launch",enabled=true}',
]
const LEGACY_DESKTOP_ARGV = [
  '-c',
  'features.code_mode_host=true',
  'app-server',
  '--analytics-default-enabled',
]

// The adapter adds its own `-c mcp_servers.anyengine=...` (the cross-engine
// bridge, test/bridge.test.mts). codex ignores every root-level `-c` once the
// subcommand has one, so the override follows the app's subcommand `-c` flags
// when there are any and precedes `app-server` otherwise. Everything else is
// replayed verbatim.
function assertDesktopArgvReplayed(argv: string[], desktop: string[] = DESKTOP_ARGV): void {
  const index = argv.findIndex((arg) => arg.startsWith('mcp_servers.anyengine='))
  assert.ok(index > 0 && argv[index - 1] === '-c', 'bridge override is a -c flag')
  const subcommand = argv.indexOf('app-server')
  if (desktop.slice(desktop.indexOf('app-server')).includes('-c')) {
    assert.ok(index > subcommand, 'bridge override follows the app subcommand -c')
  } else {
    assert.ok(index < subcommand, 'bridge override precedes app-server')
  }
  assert.match(argv[index] ?? '', /env_vars=\["ANYENGINE_BRIDGE_SOCKET","ANYENGINE_BRIDGE_TOKEN"\]/)
  assert.deepEqual([...argv.slice(0, index - 1), ...argv.slice(index + 1)], desktop)
}
```

Give `launch` an argv parameter: change its signature to `function launch(home: string, extraEnv: NodeJS.ProcessEnv = {}, viaShim = false, argv: string[] = DESKTOP_ARGV): StdioClient` and replace both uses of `DESKTOP_ARGV` inside `launch` with `argv`.

Add after the `codex-shim passes the desktop -c globals ...` test:

```ts
test('native-codex mux: with the 26.901 argv the bridge override still precedes app-server', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-mux-legacy-'))
  const client = launch(home, {}, false, LEGACY_DESKTOP_ARGV)
  try {
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
    const recorded = JSON.parse(await readFile(join(home, 'fake-argv.json'), 'utf8'))
    assertDesktopArgvReplayed(recorded.argv, LEGACY_DESKTOP_ARGV)
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/codex-mux.test.mjs`
Expected: FAIL in `native-codex mux: argv replay ...` and `codex-shim passes the desktop -c globals ...` with `bridge override follows the app subcommand -c`; the new legacy test passes.

- [ ] **Step 3: Place the override after the subcommand's `-c` flags**

In `src/adapter.mts`, change the `args:` line of `server.attachNativeCodex({ ... })` to:

```ts
      args: childArgv(codexGlobals, bridge?.codexConfigArgs() ?? [], stripListenArgs(args)),
```

Add below `splitCodexGlobals`:

```ts
// ChatGPT.app 26.911 passes a subcommand-level `-c` after `app-server`, and
// codex then ignores every root-level `-c`: an override placed before
// `app-server` silently vanishes. Put ours after the app's own subcommand `-c`
// flags when there are any; keep the root position otherwise (26.901 argv).
function childArgv(globals: string[], extra: string[], rest: string[]): string[] {
  const subcommandHasConfig = rest.some(
    (arg) => arg === '-c' || arg === '--config' || /^(-c|--config)=/.test(arg),
  )
  return subcommandHasConfig ? [...globals, ...rest, ...extra] : [...globals, ...extra, ...rest]
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/codex-mux.test.mjs dist/test/bridge.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 5: Changelog, gates, commit**

Add to `CHANGELOG.md` under `### M0: adapter safe`:

```markdown
- **GPT threads get the bridge again on ChatGPT.app 26.911.** The app now
  passes its own `-c` after `app-server`, which makes codex ignore every
  `-c` before it, including the adapter's `mcp_servers.anyengine`. The
  override now follows the app's subcommand flags when there are any.
```

Run: `npm run check && npm run typecheck`
Expected: all gates OK.

```bash
git add src/adapter.mts test/codex-mux.test.mts CHANGELOG.md
git commit -m "fix: place the bridge -c after the app's subcommand -c flags"
```

---

### Task 5: `thread/list` with an empty provider filter lists every provider

The schema says of `modelProviders`: "When present but empty, includes all providers". `[].every(...)` is vacuously true, so the adapter asked neither side and returned 0 rows where the bundled codex returns 5. `src/codex-mux.mts` is at its size baseline: the fix keeps the line count.

**Files:**
- Modify: `src/codex-mux.mts:562-567` (`mergeThreadList` head)
- Modify: `test/codex-mux.test.mts` (the `merged lists` test)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes / Produces: nothing new.

- [ ] **Step 1: Write the failing assertion**

In `test/codex-mux.test.mts`, in `native-codex mux: merged lists, Claude threads stay local, ownership survives restart`, directly after the `openaiOnly` assertion, add:

```ts
    // An empty filter means every provider (app-server schema), not none:
    // this is the app's own first `thread/list` call.
    const everyProvider = await client.request('thread/list', { limit: 50, modelProviders: [] })
    assert.deepEqual(
      everyProvider.result.data.map((t: Wire) => t.id),
      ['fake-newest', claudeThreadId, 'fake-older'],
    )
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/codex-mux.test.mjs`
Expected: FAIL, `actual: []` against the three ids.

- [ ] **Step 3: Treat an empty filter as no filter**

In `src/codex-mux.mts`, replace the two comment lines above `mergeThreadList` and its first three code lines:

```ts
  // Page 1 (no cursor) = child page 1 with the Claude threads merged in by
  // sort key; later pages are child-only. Cursor semantics stay the child's.
  private async mergeThreadList(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const providers = Array.isArray(params.modelProviders)
      ? params.modelProviders.filter((value): value is string => typeof value === 'string')
      : null
```

with:

```ts
  // Page 1 (no cursor) = child page 1 + Claude threads by sort key; later pages are child-only.
  // An empty `modelProviders` means every provider (schema), not none.
  private async mergeThreadList(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const raw = Array.isArray(params.modelProviders) ? params.modelProviders : []
    const listed = raw.filter((value): value is string => typeof value === 'string')
    const providers = listed.length > 0 ? listed : null
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/codex-mux.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 5: Changelog, gates, commit**

Add to `CHANGELOG.md` under `### M0: adapter safe`:

```markdown
- **The app's thread list is no longer empty.** `thread/list` with
  `modelProviders: []` now lists every provider, as the schema says, instead
  of none.
```

Run: `npm run check && npm run typecheck`
Expected: `File-size ratchet OK` (`src/codex-mux.mts` unchanged at 1205 lines), all gates OK.

```bash
git add src/codex-mux.mts test/codex-mux.test.mts CHANGELOG.md
git commit -m "fix: an empty thread/list provider filter lists every provider"
```

---
### Task 6: Compat pin at the bundled codex, and a way to keep it there

The adapter advertises `0.142.3` (code default) or `0.153.4` (the live `runtime.env`); ChatGPT.app 26.911 bundles `0.155.0-alpha.2.6`, which is published on npm. The shim now asks the bundled codex for its version at every launch (always current after an app update), the pinned fallback and the CI schema generator move to `0.155.0-alpha.2.6`, and one script moves every written pin at once.

**Files:**
- Modify: `src/util.mts:126-140` (the default and its comment)
- Modify: `scripts/codex-shim` (`COMPAT_VERSION` block and the two branches that use it)
- Modify: `test/fixtures/fake-codex-app-server.mjs:18-19` (answer `--version`)
- Create: `scripts/sync-codex-compat.mjs`
- Create: `test/compat-version.test.mts`
- Modify: `test/doctor.test.mts` (pin check, deterministic bundled codex)
- Modify: `scripts/doctor.mjs` (pin check)
- Modify: `.github/workflows/ci.yml:34` (pinned codex)
- Modify: `docs/guide/configuration.md` (`ANYENGINE_COMPAT_VERSION` row), `docs/reference/capability-matrix.md:74-92`, `docs/reference/release-readiness.md:49`, `crates/anyengine-protocol/README.md:20-21`, `scripts/AGENTS.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `resolve_bundled_codex` (Task 2).
- Produces: shim function `compat_version` (prints the version to advertise); the shim exports `ANYENGINE_COMPAT_VERSION` to the adapter. `node scripts/sync-codex-compat.mjs [--version X] [--root DIR]` rewrites every pin; `--check [--root DIR]` prints `<file> <version>` per site and exits 1 when they disagree. Literal pin: `0.155.0-alpha.2.6`.

- [ ] **Step 1: Write the failing tests**

Create `test/compat-version.test.mts`:

```ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { killChildren, spawn, waitForOutput } from './helpers/children.mjs'

after(killChildren)

const shim = resolve('scripts/codex-shim')
const sync = resolve('scripts/sync-codex-compat.mjs')
const PINNED = '0.155.0-alpha.2.6'
const SITES = [
  'src/util.mts',
  'scripts/codex-shim',
  '.github/workflows/ci.yml',
  'docs/guide/configuration.md',
  'docs/reference/capability-matrix.md',
  'docs/reference/release-readiness.md',
  'crates/anyengine-protocol/README.md',
]

function bundled(dir: string, version: string): string {
  const path = join(dir, 'codex')
  writeFileSync(path, `#!/bin/sh\necho "codex-cli ${version}"\n`)
  chmodSync(path, 0o755)
  return path
}

function shimVersion(env: NodeJS.ProcessEnv): string {
  const result = spawnSync(shim, ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, ANYENGINE_RUNTIME_ENV: '/dev/null', ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('every written pin names the same codex version', () => {
  const result = spawnSync(process.execPath, [sync, '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const lines = result.stdout.trim().split('\n')
  assert.deepEqual(
    lines.map((line) => line.split(' ')[0]),
    SITES,
  )
  for (const line of lines) assert.ok(line.endsWith(` ${PINNED}`), line)
})

test('sync moves every pin at once', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-compat-'))
  try {
    for (const site of SITES) {
      mkdirSync(dirname(join(root, site)), { recursive: true })
      cpSync(resolve(site), join(root, site))
    }
    const moved = spawnSync(process.execPath, [sync, '--root', root, '--version', '9.9.9'], {
      encoding: 'utf8',
    })
    assert.equal(moved.status, 0, moved.stderr)
    const check = spawnSync(process.execPath, [sync, '--check', '--root', root], { encoding: 'utf8' })
    assert.equal(check.status, 0, check.stdout)
    for (const line of check.stdout.trim().split('\n')) assert.ok(line.endsWith(' 9.9.9'), line)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the shim advertises the bundled codex version, then an explicit override, then the pin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyengine-compat-shim-'))
  try {
    const codex = bundled(dir, '9.8.7')
    assert.equal(shimVersion({ ANYENGINE_REAL_CODEX: codex }), 'codex-cli 9.8.7 (anyengine)')
    assert.equal(
      shimVersion({ ANYENGINE_REAL_CODEX: codex, ANYENGINE_COMPAT_VERSION: '1.2.3' }),
      'codex-cli 1.2.3 (anyengine)',
    )
    assert.equal(
      shimVersion({ ANYENGINE_REAL_CODEX: join(dir, 'gone') }),
      `codex-cli ${PINNED} (anyengine)`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the adapter launched by the shim reports the same version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyengine-compat-ua-'))
  const proc = spawn(shim, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      CODEX_HOME: dir,
      ANYENGINE_RUNTIME_ENV: '/dev/null',
      ANYENGINE_MOCK: '1',
      ANYENGINE_NODE: process.execPath,
      ANYENGINE_ADAPTER: resolve('dist/src/adapter.mjs'),
      ANYENGINE_REAL_CODEX: bundled(dir, '9.8.7'),
    },
  })
  try {
    const initialize = { clientInfo: { name: 't', version: '0' } }
    proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initialize })}\n`)
    await waitForOutput(proc, /"userAgent":"t\/9\.8\.7 /)
  } finally {
    proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
```

In `test/doctor.test.mts`, make the bundled codex deterministic for every doctor run and add a pin test. Add `chmodSync` to the fs import, then replace `runDoctor` with:

```ts
const PINNED = '0.155.0-alpha.2.6'

// A bundled codex that reports `version`, so no doctor run depends on which
// ChatGPT.app build the machine has.
function fakeBundled(home: string, version: string): string {
  const path = join(home, 'bundled-codex')
  writeFileSync(path, `#!/bin/sh\necho "codex-cli ${version}"\n`)
  chmodSync(path, 0o755)
  return path
}

function runDoctor(home: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [doctor], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      ANYENGINE_MOCK: '1',
      ANYENGINE_RUNTIME_ENV: '/dev/null',
      ANYENGINE_REAL_CODEX: fakeBundled(home, PINNED),
      ...env,
    },
  })
}
```

and add:

```ts
test('doctor flags a pin that no longer matches the bundled codex', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const result = runDoctor(home, { ANYENGINE_REAL_CODEX: fakeBundled(home, '0.199.0') })
    assert.equal(result.status, 1)
    assert.match(
      result.stdout,
      /fail - compat pin matches the bundled codex: bundled codex is 0\.199\.0, the repo pins 0\.155\.0-alpha\.2\.6/,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/compat-version.test.mjs dist/test/doctor.test.mjs`
Expected: FAIL: `Cannot find module .../sync-codex-compat.mjs`; the shim prints `codex-cli 0.142.3 (anyengine)`; the doctor test has no pin line.

- [ ] **Step 3: Move the code default**

In `src/util.mts`, replace the comment block above `DEFAULT_CODEX_COMPAT_VERSION` and the constant with (same line count):

```ts
// Codex app-server protocol version the adapter advertises (codex --version /
// initialize userAgent) when nothing better is known. The shim passes the
// bundled codex's own version in ANYENGINE_COMPAT_VERSION at every launch, so
// this is only the fallback: keep it at the version ChatGPT.app bundles, and
// move every written pin together with scripts/sync-codex-compat.mjs.
// Override per host with ANYENGINE_COMPAT_VERSION.
const DEFAULT_CODEX_COMPAT_VERSION = '0.155.0-alpha.2.6'
```

- [ ] **Step 4: Derive the version in the shim**

In `scripts/codex-shim`, replace
`COMPAT_VERSION="${ANYENGINE_COMPAT_VERSION:-${CODEX_SHIM_COMPAT_VERSION:-0.142.3}}"` with:

```bash
# Moved together with src/util.mts and CI by scripts/sync-codex-compat.mjs.
DEFAULT_COMPAT_VERSION="0.155.0-alpha.2.6"
```

After `resolve_bundled_codex()`, add:

```bash
# The version to advertise: an explicit ANYENGINE_COMPAT_VERSION, else what
# the bundled codex says it is (current after every app update), else the pin.
compat_version() {
  local explicit="${ANYENGINE_COMPAT_VERSION:-${CODEX_SHIM_COMPAT_VERSION:-}}" bin out
  if [ -n "$explicit" ]; then printf '%s\n' "$explicit"; return 0; fi
  if bin="$(resolve_bundled_codex)" && out="$("$bin" --version 2>/dev/null)"; then
    out="${out#codex-cli }"
    out="${out%% *}"
    if [ -n "$out" ]; then printf '%s\n' "$out"; return 0; fi
  fi
  printf '%s\n' "$DEFAULT_COMPAT_VERSION"
}
```

In the `--version` branch, replace the `echo` line with:

```bash
    echo "${CODEX_SHIM_VERSION:-codex-cli $(compat_version)${VERSION_SUFFIX:+ (${VERSION_SUFFIX})}}"
```

In the `app-server` branch, directly after the `adapter_ready` block, add:

```bash
    # The adapter reports the same version the app's own codex would.
    ANYENGINE_COMPAT_VERSION="$(compat_version)"
    export ANYENGINE_COMPAT_VERSION
```

Add `--version` handling at the top of `test/fixtures/fake-codex-app-server.mjs`, directly after its imports:

```js
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.153.4-fake\n')
  process.exit(0)
}
```

- [ ] **Step 5: Write the sync script**

Create `scripts/sync-codex-compat.mjs`:

```js
#!/usr/bin/env node
// The codex version this repo is pinned to is written down in several places:
// the adapter's and the shim's fallback compat version, the codex CI generates
// schemas with, and the docs. After an app update, move them all at once:
//
//   node scripts/sync-codex-compat.mjs               # the bundled codex's --version
//   node scripts/sync-codex-compat.mjs --version 0.156.0
//   node scripts/sync-codex-compat.mjs --check       # one line per site; exit 1 on disagreement
//
// test/compat-version.test.mts runs --check, so a partial bump fails CI.
// `npm run doctor` fails while the bundled codex and the pin differ.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITES = [
  ['src/util.mts', /(const DEFAULT_CODEX_COMPAT_VERSION = ')([^']+)(')/],
  ['scripts/codex-shim', /(DEFAULT_COMPAT_VERSION=")([^"]+)(")/],
  ['.github/workflows/ci.yml', /(npm install --global @openai\/codex@)(\S+)( )/],
  ['docs/guide/configuration.md', /(the bundled codex's own version, else `)([^`]+)(`)/],
  ['docs/reference/capability-matrix.md', /(pinned to `)([^`]+)(`)/],
  ['docs/reference/release-readiness.md', /(`@openai\/codex@)([^`]+)(`)/],
  ['crates/anyengine-protocol/README.md', /(`@openai\/codex@)([^`]+)(`)/],
]

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const root = resolve(option('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'))

function pins() {
  return SITES.map(([file, pattern]) => {
    const match = pattern.exec(readFileSync(join(root, file), 'utf8'))
    return [file, match ? match[2] : null]
  })
}

function bundledVersion() {
  const bin =
    process.env.ANYENGINE_REAL_CODEX || '/Applications/ChatGPT.app/Contents/Resources/codex'
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  const version = /codex-cli (\S+)/.exec(result.stdout ?? '')?.[1]
  if (!version) {
    console.error(`sync-codex-compat: ${bin} --version gave no version; pass --version`)
    process.exit(1)
  }
  return version
}

if (process.argv.includes('--check')) {
  const found = pins()
  for (const [file, version] of found) console.log(`${file} ${version ?? 'MISSING'}`)
  const versions = new Set(found.map(([, version]) => version))
  process.exit(versions.size === 1 && !versions.has(null) ? 0 : 1)
}

const version = option('--version') ?? bundledVersion()
for (const [file, pattern] of SITES) {
  const path = join(root, file)
  const text = readFileSync(path, 'utf8')
  if (!pattern.test(text)) {
    console.error(`sync-codex-compat: no pin found in ${file}`)
    process.exit(1)
  }
  writeFileSync(path, text.replace(pattern, (_, head, _old, tail) => `${head}${version}${tail}`))
  console.log(`${file} -> ${version}`)
}
```

- [ ] **Step 6: Write the pins in CI and the docs**

In `.github/workflows/ci.yml`, change the codex install line to
`      - run: npm install --global @openai/codex@0.155.0-alpha.2.6 --no-audit --no-fund`.

In `docs/guide/configuration.md`, replace the `ANYENGINE_COMPAT_VERSION` reference row with:

```markdown
| `ANYENGINE_COMPAT_VERSION` | Codex app-server version advertised. Default: the bundled codex's own version, else `0.155.0-alpha.2.6`. The shim sets it for the adapter at every launch. |
```

In `docs/reference/capability-matrix.md`, replace the whole `## Protocol version` section text (both paragraphs, up to the next heading) with:

```markdown
## Protocol version

The adapter advertises the version of the codex it stands in for (via
`codex --version` and the `initialize` userAgent): the shim asks the app's
bundled codex for its version at every launch and passes it on, so an app
update needs no change here. When the bundled codex cannot be asked, the
adapter reports the version this release is pinned to `0.155.0-alpha.2.6`
(ChatGPT.app 26.911); override with `ANYENGINE_COMPAT_VERSION`. Move every
written pin with `node scripts/sync-codex-compat.mjs`; `npm run doctor` fails
while the bundled codex and the pin differ. Unimplemented optional methods
return a JSON-RPC error, which Codex App treats as "unsupported". Regenerate
the reference schema under `generated/` with `npm run generate:schema` (needs
a matching `codex` on PATH).

Because the adapter reports the same version as a real `codex`, it appends a
distinguishing suffix: `codex --version` prints
`codex-cli <version> (anyengine)` and the `initialize` userAgent carries
`anyengine` in its originator field. The version number stays first so the
App's semver probe still parses it. Set `ANYENGINE_VERSION_SUFFIX=""` to behave
exactly like upstream codex.
```

In `docs/reference/release-readiness.md` and `crates/anyengine-protocol/README.md`, change `` `@openai/codex@0.142.3` `` to `` `@openai/codex@0.155.0-alpha.2.6` ``.

In `scripts/AGENTS.md`, add after the `lib-verify.mjs` bullet:

```markdown
- `sync-codex-compat.mjs`: moves the codex version pin (adapter, shim, CI,
  docs) to the bundled codex's version, or `--check`s that every site agrees.
```

- [ ] **Step 7: Add the doctor pin check**

In `scripts/doctor.mjs`, add after the `shim version probe` check:

```js
check('compat pin matches the bundled codex', () => {
  const bundled =
    process.env.ANYENGINE_REAL_CODEX || '/Applications/ChatGPT.app/Contents/Resources/codex'
  if (!existsSync(bundled)) return
  const version = /codex-cli (\S+)/.exec(run(bundled, ['--version']).stdout)?.[1]
  const shim = readFileSync(resolve('scripts/codex-shim'), 'utf8')
  const pinned = /DEFAULT_COMPAT_VERSION="([^"]+)"/.exec(shim)?.[1]
  if (version && version !== pinned) {
    throw new Error(
      `bundled codex is ${version}, the repo pins ${pinned}; ` +
        'run node scripts/sync-codex-compat.mjs and commit the result',
    )
  }
})
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/compat-version.test.mjs dist/test/doctor.test.mjs dist/test/shim.test.mjs dist/test/codex-mux.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 9: Changelog, gates, commit**

Add to `CHANGELOG.md` under `### M0: adapter safe`:

```markdown
- **The advertised codex version follows the app.** The shim asks the bundled
  codex for its version at every launch; the fallback pin, the CI schema
  generator and the docs move to `0.155.0-alpha.2.6` (ChatGPT.app 26.911), and
  `node scripts/sync-codex-compat.mjs` moves them together next time.
```

Run: `npm run check && npm run typecheck && npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/util.mts scripts/codex-shim scripts/sync-codex-compat.mjs scripts/doctor.mjs \
  scripts/AGENTS.md test/compat-version.test.mts test/doctor.test.mts \
  test/fixtures/fake-codex-app-server.mjs .github/workflows/ci.yml docs/guide/configuration.md \
  docs/reference/capability-matrix.md docs/reference/release-readiness.md \
  crates/anyengine-protocol/README.md CHANGELOG.md
git commit -m "feat: advertise the bundled codex version and pin 0.155.0-alpha.2.6"
```

---
### Task 7: Posture core: one type, converters, one `decide`, never-looser property tests

Nothing is wired into the runtimes yet: this task adds the type and the semantics, and proves on every enumerable parent posture that each converter hands a child no more than the parent has. Tasks 9 to 11 wire it in.

**Files:**
- Create: `src/posture.mts`
- Create: `src/posture-claude.mts`
- Modify: `src/types.mts:92-102` (ThreadRecord), `:299-334` (RuntimeTurnContext), imports
- Create: `test/fixtures/claude-permission-modes.json`
- Create: `test/helpers/postures.mts`
- Create: `test/posture.test.mts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `COMMAND_TOOLS`, `FILE_CHANGE_TOOLS` from `src/server-helpers.mts` (test only).
- Produces, `src/posture.mts`:
  - types `GranularFlag`, `GranularApproval`, `ApprovalPolicy = 'untrusted' | 'on-request' | 'never' | { granular: GranularApproval }`, `Reviewer = 'user' | 'auto_review'`, `Trust = 'trusted' | 'untrusted' | 'unknown'`, `FileSystemPosture`, `Posture { fileSystem; network: boolean; approval; reviewer; plan: boolean; trust }`, `Outcome = 'deny' | 'ask' | 'review' | 'allow'`, `Effect`, `PostureContext { cwd; tmpdir; slashTmp }`;
  - `GRANULAR_FLAGS`, `DEFAULT_POSTURE`, `SANDBOX_POLICY_FIELDS`, `POSTURE_SCHEMA_COVERAGE`;
  - `outcomeRank(o: Outcome): number`, `postureContext(cwd: string): PostureContext`;
  - `parseApprovalPolicy(v: unknown): ApprovalPolicy | null`, `parseReviewer(v: unknown): Reviewer | null`, `parseSandboxMode(v: unknown): FileSystemPosture | null`, `parseSandboxPolicy(v: unknown): { fileSystem; network } | null`;
  - `applyCodexParams(base: Posture, params: Record<string, unknown>): Posture` (requests and lifecycle answers);
  - `legacyPosture(approvalPolicy?: string | null, sandboxMode?: string | null): Posture`, `threadPosture(thread: Pick<ThreadRecord, 'posture' | 'approvalPolicy' | 'sandboxMode'> | null): Posture`, `contextPosture(context: Pick<RuntimeTurnContext, 'posture' | 'approvalPolicy' | 'sandboxMode' | 'planMode'>): Posture`, `postureFields(p: Posture): { approvalPolicy: string; sandboxMode: string; posture: Posture }`, `parseStoredPosture(text: string | null): Posture | null`;
  - `toCodexSandboxPolicy(p): Record<string, unknown>`, `toCodexThreadStart(p): Record<string, unknown>` (`approvalPolicy`, `approvalsReviewer`, `sandbox`), `toCodexTurn(p): Record<string, unknown>` (`approvalPolicy`, `approvalsReviewer`, `sandboxPolicy`), `toCodexExecSandboxPolicy(p, cwd: string): Record<string, unknown>`;
  - `fromClaudePermissionMode(mode: string, options?: { strict?: boolean }): Posture | null`;
  - `decide(p, e: Effect, ctx): Outcome`, `sandboxedOutcome(p): Outcome`, `reach(p, e, ctx): Outcome`, `isUnrestricted(p): boolean`, `writableRoots(p, ctx): string[] | 'all'`, `realPath(path: string): string`, `postureSummary(p): string`.
- Produces, `src/posture-claude.mts`: `BRIDGE_EXEC_TOOL = 'mcp__anyengine__exec'`, `APPROVAL_CARD_TOOLS: Set<string>`, types `ClaudeToolEffect = Effect | 'sandboxed' | 'inert'`, `ClaudeVerdict = 'allow' | 'ask' | 'deny'`, `ClaudeLaunch { permissionMode: 'plan' | null; disallowedTools: string[]; relayPosture: Posture; trustWorkspace: boolean }`; `claudeToolEffect(toolName: string, input: Record<string, unknown>): ClaudeToolEffect`, `decideClaudeTool(p: Posture, toolName: string, input: Record<string, unknown>, where: string | PostureContext): ClaudeVerdict`, `toClaudeLaunch(p: Posture, options: { sandboxExec: boolean }): ClaudeLaunch`, `usesSandboxExec(p: Posture, sandboxExec: boolean): boolean`.
- Produces, `src/types.mts`: `ThreadRecord.posture?: Posture | null`, `RuntimeTurnContext.posture?: Posture`.
- Produces, `test/helpers/postures.mts`: `PostureTree { base; ctx; extra; outside }`, `postureTree(): PostureTree`, `ClaudeColumn`, `Probe { label; effect; claude: ClaudeColumn | null }`, `probes(tree): Probe[]`, `everyPosture(tree): Generator<Posture>`, `POSTURE_COUNT = 3080`.

- [ ] **Step 1: Add the Claude docs fixture**

Create `test/fixtures/claude-permission-modes.json`. It is the reference table for a Claude parent (Claude Code 2.1.284 permission modes). Every mode must convert, and a Codex child built from a mode may never do more than the row says. Update it when the docs add a mode.

```json
{
  "source": "Claude Code permission modes (code.claude.com/docs/en/permission-modes, Claude Code 2.1.284, read 2026-09-28)",
  "columns": {
    "read": "Read, Glob, Grep anywhere",
    "writeInCwd": "Edit or Write inside the working directory",
    "writeOutside": "Edit or Write anywhere else, temp directories included",
    "net": "WebFetch or a shell command that reaches the network",
    "unbounded": "Bash"
  },
  "modes": {
    "default": { "read": "allow", "writeInCwd": "ask", "writeOutside": "ask", "net": "ask", "unbounded": "ask" },
    "acceptEdits": { "read": "allow", "writeInCwd": "allow", "writeOutside": "ask", "net": "ask", "unbounded": "ask" },
    "plan": { "read": "allow", "writeInCwd": "deny", "writeOutside": "deny", "net": "deny", "unbounded": "deny" },
    "auto": { "read": "allow", "writeInCwd": "allow", "writeOutside": "review", "net": "review", "unbounded": "review" },
    "dontAsk": { "read": "allow", "writeInCwd": "deny", "writeOutside": "deny", "net": "deny", "unbounded": "deny" },
    "bypassPermissions": { "read": "allow", "writeInCwd": "allow", "writeOutside": "allow", "net": "allow", "unbounded": "allow" }
  }
}
```

- [ ] **Step 2: Add the posture fields to the shared types**

In `src/types.mts`, add `import type { Posture } from './posture.mjs'` below the existing imports (it is type-only, so the import cycle is erased). In `ThreadRecord`, directly after `permissionProfileId?: string | null`, add:

```ts
  // The canonical posture (src/posture.mts); `approvalPolicy` and
  // `sandboxMode` above are its legacy projection. Absent or null on rows
  // written before it was stored: read it through threadPosture().
  posture?: Posture | null
```

In `RuntimeTurnContext`, directly after `sandboxMode: string | null`, add:

```ts
  // The thread's posture for this turn. Runtimes read it through
  // contextPosture() (src/posture.mts), which falls back to the two strings
  // above and adds `planMode`.
  posture?: Posture
```

- [ ] **Step 3: Write the shared test helpers**

Create `test/helpers/postures.mts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ApprovalPolicy,
  type Effect,
  type FileSystemPosture,
  GRANULAR_FLAGS,
  type GranularApproval,
  type Posture,
  type PostureContext,
} from '../../src/posture.mjs'

// A fixed tree, so every probe means the same thing on every host: the real
// /tmp and $TMPDIR only ever appear through `ctx`, never as probe paths.
export interface PostureTree {
  base: string
  ctx: PostureContext
  extra: string
  outside: string
}

export function postureTree(): PostureTree {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'anyengine-posture-')))
  const ctx = {
    cwd: join(base, 'work'),
    tmpdir: join(base, 'tmpdir'),
    slashTmp: join(base, 'slashtmp'),
  }
  const extra = join(base, 'extra')
  const outside = join(base, 'outside')
  for (const dir of [ctx.cwd, ctx.tmpdir, ctx.slashTmp, extra, outside, join(ctx.cwd, '.git')]) {
    mkdirSync(dir, { recursive: true })
  }
  // A link inside the workspace that points out of it (spec 5.5 G1).
  symlinkSync(outside, join(ctx.cwd, 'escape'))
  return { base, ctx, extra, outside }
}

// The row of test/fixtures/claude-permission-modes.json an effect is judged
// by when the parent is a Claude permission mode.
export type ClaudeColumn = 'read' | 'writeInCwd' | 'writeOutside' | 'net' | 'unbounded'

export interface Probe {
  label: string
  effect: Effect
  claude: ClaudeColumn | null
}

export function probes(tree: PostureTree): Probe[] {
  const { ctx, extra, outside } = tree
  const write = (path: string, claude: ClaudeColumn): Probe => ({
    label: `write ${path}`,
    effect: { kind: 'write', path },
    claude,
  })
  return [
    { label: 'read', effect: { kind: 'read' }, claude: 'read' },
    write(join(ctx.cwd, 'a.txt'), 'writeInCwd'),
    write('sub/b.txt', 'writeInCwd'),
    write(join(ctx.cwd, '.git', 'config'), 'writeInCwd'),
    write(join(ctx.cwd, 'escape', 'c.txt'), 'writeOutside'),
    write(join(extra, 'd.txt'), 'writeOutside'),
    write(join(ctx.slashTmp, 'e.txt'), 'writeOutside'),
    write(join(ctx.tmpdir, 'f.txt'), 'writeOutside'),
    write(join(outside, 'g.txt'), 'writeOutside'),
    { label: 'net', effect: { kind: 'net' }, claude: 'net' },
    { label: 'unbounded', effect: { kind: 'unbounded' }, claude: 'unbounded' },
    { label: 'mcp', effect: { kind: 'mcp' }, claude: null },
  ]
}

function fileSystems(extra: string): FileSystemPosture[] {
  const list: FileSystemPosture[] = [
    { kind: 'read-only' },
    { kind: 'full-access' },
    { kind: 'external' },
  ]
  for (const writableRoots of [[], [extra]]) {
    for (const excludeTmpdirEnvVar of [false, true]) {
      for (const excludeSlashTmp of [false, true]) {
        list.push({ kind: 'workspace-write', writableRoots, excludeTmpdirEnvVar, excludeSlashTmp })
      }
    }
  }
  return list
}

function approvals(): ApprovalPolicy[] {
  const list: ApprovalPolicy[] = ['untrusted', 'on-request', 'never']
  for (let bits = 0; bits < 2 ** GRANULAR_FLAGS.length; bits += 1) {
    const granular = Object.fromEntries(
      GRANULAR_FLAGS.map((flag, index) => [flag, (bits & (1 << index)) !== 0]),
    ) as GranularApproval
    list.push({ granular })
  }
  return list
}

// Every parent posture the property tests walk: 11 file systems x network on
// and off x 35 approval policies x 2 reviewers x plan on and off.
export function* everyPosture(tree: PostureTree): Generator<Posture> {
  for (const fileSystem of fileSystems(tree.extra)) {
    for (const network of [false, true]) {
      for (const approval of approvals()) {
        for (const reviewer of ['user', 'auto_review'] as const) {
          for (const plan of [false, true]) {
            yield { fileSystem, network, approval, reviewer, plan, trust: 'unknown' }
          }
        }
      }
    }
  }
}

export const POSTURE_COUNT = 11 * 2 * 35 * 2 * 2
```

- [ ] **Step 4: Write the failing tests**

Create `test/posture.test.mts`:

```ts
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import {
  APPROVAL_CARD_TOOLS,
  type ClaudeToolEffect,
  claudeToolEffect,
  decideClaudeTool,
  toClaudeLaunch,
} from '../src/posture-claude.mjs'
import {
  applyCodexParams,
  DEFAULT_POSTURE,
  fromClaudePermissionMode,
  isUnrestricted,
  legacyPosture,
  type Outcome,
  outcomeRank,
  type Posture,
  POSTURE_SCHEMA_COVERAGE,
  parseStoredPosture,
  reach,
  sandboxedOutcome,
  toCodexExecSandboxPolicy,
  toCodexThreadStart,
  toCodexTurn,
} from '../src/posture.mjs'
import { COMMAND_TOOLS, FILE_CHANGE_TOOLS } from '../src/server-helpers.mjs'
import {
  type ClaudeColumn,
  everyPosture,
  POSTURE_COUNT,
  postureTree,
  probes,
} from './helpers/postures.mjs'

const tree = postureTree()
const { ctx } = tree
const PROBES = probes(tree)
after(() => rmSync(tree.base, { recursive: true, force: true }))

const claudeModes = JSON.parse(
  readFileSync(resolve('test/fixtures/claude-permission-modes.json'), 'utf8'),
) as { modes: Record<string, Record<ClaudeColumn, Outcome>> }

function looser(child: Outcome, parent: Outcome): boolean {
  return outcomeRank(child) > outcomeRank(parent)
}

// What a Codex child is started with for a parent: thread/start, then the
// first turn/start carrying the full sandbox policy.
function codexChild(parent: Posture): Posture {
  return applyCodexParams(DEFAULT_POSTURE, { ...toCodexThreadStart(parent), ...toCodexTurn(parent) })
}

const WS = {
  kind: 'workspace-write' as const,
  writableRoots: [] as string[],
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
}

test('posture: requests, turns and lifecycle answers parse into one type', () => {
  // The app's local host sends a profile id and nothing else (26.911).
  const workspace = applyCodexParams(DEFAULT_POSTURE, { permissions: ':workspace', sandbox: null })
  assert.deepEqual(workspace.fileSystem, WS)
  assert.equal(workspace.approval, 'on-request')
  assert.equal(workspace.network, false)

  // turn/start keeps roots, network and the tmp exclusions (spec 5.6, fix 3).
  const turn = applyCodexParams(workspace, {
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: ['/data'],
      networkAccess: true,
      excludeSlashTmp: true,
    },
  })
  assert.deepEqual(turn.fileSystem, { ...WS, writableRoots: ['/data'], excludeSlashTmp: true })
  assert.equal(turn.network, true)
  // A turn that names nothing keeps the thread's posture.
  assert.deepEqual(applyCodexParams(turn, { input: [] }), turn)

  // A granular policy survives as flags (fix 2); a flag left out reads false.
  const granular = applyCodexParams(DEFAULT_POSTURE, {
    approvalPolicy: { granular: { sandbox_approval: false, rules: true, mcp_elicitations: true } },
  })
  assert.deepEqual(granular.approval, {
    granular: {
      sandbox_approval: false,
      rules: true,
      mcp_elicitations: true,
      skill_approval: false,
      request_permissions: false,
    },
  })

  // externalSandbox stays external; it used to become workspace-write.
  const external = applyCodexParams(DEFAULT_POSTURE, {
    sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' },
  })
  assert.equal(external.fileSystem.kind, 'external')
  assert.equal(external.network, true)

  // Aliases: on-failure is on-request (fix 6), guardian_subagent is auto_review.
  assert.equal(applyCodexParams(DEFAULT_POSTURE, { approvalPolicy: 'on-failure' }).approval, 'on-request')
  assert.equal(
    applyCodexParams(DEFAULT_POSTURE, { approvalsReviewer: 'guardian_subagent' }).reviewer,
    'auto_review',
  )
  assert.equal(
    applyCodexParams(DEFAULT_POSTURE, { collaborationMode: { mode: 'plan', settings: {} } }).plan,
    true,
  )

  // The real child's thread/start answer carries the effective SandboxPolicy.
  const answer = applyCodexParams(DEFAULT_POSTURE, {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: { type: 'workspaceWrite', writableRoots: ['/w'], networkAccess: true },
    activePermissionProfile: { id: ':workspace', extends: null },
  })
  assert.deepEqual(answer.fileSystem, { ...WS, writableRoots: ['/w'] })
  assert.equal(answer.network, true)
  assert.equal(answer.reviewer, 'auto_review')

  // A named profile wins over sandbox fields in the same request: Codex
  // refuses the combination, and the looser field never wins.
  const both = applyCodexParams(DEFAULT_POSTURE, {
    permissions: ':workspace',
    sandboxPolicy: { type: 'dangerFullAccess' },
  })
  assert.equal(both.fileSystem.kind, 'workspace-write')
})

test('posture: nothing, junk or a custom profile is the tight default, never full access', () => {
  assert.deepEqual(applyCodexParams(DEFAULT_POSTURE, {}), DEFAULT_POSTURE)
  assert.equal(DEFAULT_POSTURE.fileSystem.kind, 'read-only')
  assert.equal(DEFAULT_POSTURE.approval, 'on-request')
  // A custom profile's contents are invisible here (fix 7).
  const custom = applyCodexParams(DEFAULT_POSTURE, { permissions: 'team-profile' })
  assert.equal(custom.fileSystem.kind, 'read-only')
  assert.equal(custom.approval, 'on-request')
  // A value this build cannot read tightens; it never keeps a looser base.
  const full = applyCodexParams(DEFAULT_POSTURE, { permissions: ':danger-full-access' })
  assert.equal(isUnrestricted(full), true)
  assert.equal(applyCodexParams(full, { sandbox: 'future-mode' }).fileSystem.kind, 'read-only')
  assert.equal(
    applyCodexParams(full, { sandboxPolicy: { type: 'futureSandbox' } }).fileSystem.kind,
    'read-only',
  )
  // Rows stored before M0 convert as recorded.
  assert.equal(isUnrestricted(legacyPosture('never', 'danger-full-access')), true)
  assert.deepEqual(legacyPosture(null, null), DEFAULT_POSTURE)
})

test('posture: `never` means no prompts, not no bounds', () => {
  const never: Posture = {
    ...DEFAULT_POSTURE,
    fileSystem: { ...WS, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    approval: 'never',
  }
  assert.equal(reach(never, { kind: 'write', path: join(ctx.cwd, 'a.txt') }, ctx), 'allow')
  assert.equal(reach(never, { kind: 'write', path: join(tree.outside, 'a.txt') }, ctx), 'deny')
  assert.equal(reach(never, { kind: 'unbounded' }, ctx), 'deny')
  assert.equal(reach(never, { kind: 'net' }, ctx), 'deny')
  const readOnly = { ...never, fileSystem: { kind: 'read-only' } } as Posture
  assert.equal(reach(readOnly, { kind: 'write', path: join(ctx.cwd, 'a.txt') }, ctx), 'deny')
  assert.equal(isUnrestricted(never), false)
})

test('never looser: Codex parent to Codex child, over every posture', () => {
  let count = 0
  for (const parent of everyPosture(tree)) {
    const child = codexChild(parent)
    for (const probe of PROBES) {
      const got = reach(child, probe.effect, ctx)
      const bound = reach(parent, probe.effect, ctx)
      assert.ok(!looser(got, bound), `${JSON.stringify(parent)} ${probe.label}: ${got} > ${bound}`)
    }
    count += 1
  }
  assert.equal(count, POSTURE_COUNT)
})

const CLAUDE_TOOLS: Array<{ tool: string; input: Record<string, unknown>; effect: ClaudeToolEffect }> = [
  { tool: 'Read', input: { file_path: join(tree.outside, 'x') }, effect: { kind: 'read' } },
  {
    tool: 'Write',
    input: { file_path: join(ctx.cwd, 'a.txt') },
    effect: { kind: 'write', path: join(ctx.cwd, 'a.txt') },
  },
  { tool: 'Write', input: { file_path: 'rel/b.txt' }, effect: { kind: 'write', path: 'rel/b.txt' } },
  {
    tool: 'Edit',
    input: { file_path: join(ctx.cwd, '.git', 'config') },
    effect: { kind: 'write', path: join(ctx.cwd, '.git', 'config') },
  },
  {
    tool: 'MultiEdit',
    input: { file_path: join(ctx.cwd, 'escape', 'c.txt') },
    effect: { kind: 'write', path: join(ctx.cwd, 'escape', 'c.txt') },
  },
  {
    tool: 'NotebookEdit',
    input: { notebook_path: join(tree.extra, 'n.ipynb') },
    effect: { kind: 'write', path: join(tree.extra, 'n.ipynb') },
  },
  {
    tool: 'Write',
    input: { file_path: join(tree.outside, 'g.txt') },
    effect: { kind: 'write', path: join(tree.outside, 'g.txt') },
  },
  { tool: 'Write', input: {}, effect: { kind: 'unbounded' } },
  { tool: 'Bash', input: { command: 'ls' }, effect: { kind: 'unbounded' } },
  { tool: 'Monitor', input: {}, effect: { kind: 'unbounded' } },
  { tool: 'WebFetch', input: { url: 'https://example.com' }, effect: { kind: 'net' } },
  { tool: 'mcp__github__create_issue', input: {}, effect: { kind: 'mcp' } },
  { tool: 'mcp__anyengine__exec', input: { command: 'ls' }, effect: 'sandboxed' },
  { tool: 'mcp__anyengine__spawn_subagents', input: {}, effect: 'inert' },
  { tool: 'Task', input: {}, effect: 'inert' },
  { tool: 'WebSearch', input: {}, effect: 'inert' },
  { tool: 'SomeFutureTool', input: {}, effect: { kind: 'unbounded' } },
]

test('posture: Claude tools map to the effects they have', () => {
  for (const { tool, input, effect } of CLAUDE_TOOLS) {
    assert.deepEqual(claudeToolEffect(tool, input), effect, tool)
  }
})

test('never looser: Codex parent to Claude child (launch and relay), over every posture', () => {
  for (const parent of everyPosture(tree)) {
    for (const sandboxExec of [false, true]) {
      const launch = toClaudeLaunch(parent, { sandboxExec })
      assert.equal(launch.relayPosture, parent)
      assert.equal(launch.permissionMode, parent.plan ? 'plan' : null)
      for (const { tool, input, effect } of CLAUDE_TOOLS) {
        const got: Outcome = launch.disallowedTools.includes(tool)
          ? 'deny'
          : decideClaudeTool(launch.relayPosture, tool, input, ctx)
        const bound: Outcome =
          effect === 'inert'
            ? 'allow'
            : effect === 'sandboxed'
              ? sandboxedOutcome(parent)
              : reach(parent, effect, ctx)
        assert.ok(!looser(got, bound), `${JSON.stringify(parent)} ${tool}: ${got} > ${bound}`)
      }
    }
  }
})

test('never looser: Claude parent mode to Codex child', () => {
  for (const [mode, table] of Object.entries(claudeModes.modes)) {
    for (const strict of [false, true]) {
      const parent = fromClaudePermissionMode(mode, { strict })
      assert.ok(parent, mode)
      const child = codexChild(parent)
      for (const probe of PROBES) {
        // A Codex child runs its MCP tools without asking while Claude asks in
        // most modes, and Codex has no thread-level switch for that: recorded
        // for M2's Claude host, left out here.
        if (probe.claude === null) continue
        const got = reach(child, probe.effect, ctx)
        const bound = table[probe.claude]
        assert.ok(!looser(got, bound), `${mode}${strict ? ' strict' : ''} ${probe.label}: ${got} > ${bound}`)
      }
    }
  }
})

test('never looser: only an unrestricted posture may drop a runtime\'s own approvals', () => {
  let unrestricted = 0
  for (const posture of everyPosture(tree)) {
    if (!isUnrestricted(posture)) continue
    unrestricted += 1
    for (const probe of PROBES) assert.equal(reach(posture, probe.effect, ctx), 'allow', probe.label)
  }
  assert.ok(unrestricted > 0)
})

test('posture: shell moves to exec only where a sandbox bounds it', () => {
  const ws = applyCodexParams(DEFAULT_POSTURE, { permissions: ':workspace' })
  const full = applyCodexParams(DEFAULT_POSTURE, { permissions: ':danger-full-access' })
  assert.deepEqual(toClaudeLaunch(ws, { sandboxExec: true }).disallowedTools, ['Bash', 'Monitor'])
  assert.deepEqual(toClaudeLaunch(ws, { sandboxExec: false }).disallowedTools, [])
  assert.deepEqual(toClaudeLaunch(full, { sandboxExec: true }).disallowedTools, [])
  assert.deepEqual(
    toClaudeLaunch({ ...ws, approval: 'untrusted' }, { sandboxExec: true }).disallowedTools,
    [],
  )
  assert.deepEqual(toClaudeLaunch({ ...ws, plan: true }, { sandboxExec: true }).disallowedTools, [])
})

test('posture: the relay asks only about tools the app draws a card for', () => {
  assert.deepEqual([...APPROVAL_CARD_TOOLS].sort(), [...COMMAND_TOOLS, ...FILE_CHANGE_TOOLS].sort())
  const ws = applyCodexParams(DEFAULT_POSTURE, { permissions: ':workspace' })
  assert.equal(decideClaudeTool(ws, 'Bash', { command: 'ls' }, ctx), 'ask')
  assert.equal(decideClaudeTool(ws, 'WebFetch', { url: 'https://example.com' }, ctx), 'deny')
  assert.equal(decideClaudeTool(ws, 'Write', { file_path: 'x.txt' }, ctx), 'allow')
  assert.equal(decideClaudeTool(ws, 'mcp__github__search', {}, ctx), 'allow')
})

test('posture: every Claude permission mode in the docs fixture converts', () => {
  for (const mode of Object.keys(claudeModes.modes)) {
    assert.ok(fromClaudePermissionMode(mode), mode)
    assert.equal(POSTURE_SCHEMA_COVERAGE.claudePermissionMode(mode), true, mode)
  }
  assert.equal(fromClaudePermissionMode('auto')?.reviewer, 'auto_review')
  assert.equal(fromClaudePermissionMode('auto', { strict: true })?.reviewer, 'user')
  assert.equal(fromClaudePermissionMode('no-such-mode'), null)
})

test('posture: a parent that does not trust the project gets a child that does not either', () => {
  const untrusted = applyCodexParams(DEFAULT_POSTURE, { approvalPolicy: 'untrusted' })
  assert.equal(untrusted.trust, 'untrusted')
  assert.equal(toClaudeLaunch(untrusted, { sandboxExec: false }).trustWorkspace, false)
  assert.equal(toClaudeLaunch(DEFAULT_POSTURE, { sandboxExec: false }).trustWorkspace, true)
  // Sticky: a later approval change does not re-trust the project.
  assert.equal(applyCodexParams(untrusted, { approvalPolicy: 'on-request' }).trust, 'untrusted')
})

test('posture: stored JSON round-trips and junk reads as null', () => {
  const stored = applyCodexParams(DEFAULT_POSTURE, {
    approvalPolicy: { granular: { sandbox_approval: true, rules: false, mcp_elicitations: true } },
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/data'], networkAccess: true },
  })
  assert.deepEqual(parseStoredPosture(JSON.stringify(stored)), stored)
  assert.equal(parseStoredPosture('{"fileSystem":{"kind":"root"}}'), null)
  assert.equal(parseStoredPosture('not json'), null)
  assert.equal(parseStoredPosture(null), null)
})

test('posture: command/exec gets the thread cwd as an explicit root', () => {
  const ws = applyCodexParams(DEFAULT_POSTURE, {
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/data'] },
  })
  assert.deepEqual(toCodexExecSandboxPolicy(ws, '/work'), {
    type: 'workspaceWrite',
    writableRoots: ['/work', '/data'],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  })
  const external = applyCodexParams(DEFAULT_POSTURE, { sandboxPolicy: { type: 'externalSandbox' } })
  assert.equal(toCodexExecSandboxPolicy(external, '/work').type, 'workspaceWrite')
  assert.deepEqual(toCodexExecSandboxPolicy({ ...ws, plan: true }, '/work'), {
    type: 'readOnly',
    networkAccess: false,
  })
})
```

- [ ] **Step 5: Run it to see it fail**

Run: `npm run build`
Expected: FAIL at compile time: `Cannot find module '../src/posture.mjs'` (TS2307) for `test/posture.test.mts`, `test/helpers/postures.mts` and `src/types.mts`.

- [ ] **Step 6: Write `src/posture.mts`**

```ts
// The canonical posture (spec 5.6): what a thread may do, in Codex's model.
// Each engine's vocabulary is converted into this one type and every tool call
// is judged against it, so "never looser than the parent" is one function
// (`decide`) and one property test (test/posture.test.mts), not a rule per
// runtime.
//
// An effect is a read, a write to a path, network, anything that runs
// outside every sandbox, or an MCP tool call. Outcomes rank
// deny < ask < review < allow: a human is tighter than a reviewer model, which
// is tighter than running unattended.
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { RuntimeTurnContext, ThreadRecord } from './types.mjs'

export const GRANULAR_FLAGS = [
  'sandbox_approval',
  'rules',
  'mcp_elicitations',
  'skill_approval',
  'request_permissions',
] as const
export type GranularFlag = (typeof GRANULAR_FLAGS)[number]
export type GranularApproval = Record<GranularFlag, boolean>
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never' | { granular: GranularApproval }
export type Reviewer = 'user' | 'auto_review'
export type Trust = 'trusted' | 'untrusted' | 'unknown'

type WorkspaceWrite = {
  kind: 'workspace-write'
  // Beyond the thread's cwd, which workspace-write always includes.
  writableRoots: string[]
  excludeTmpdirEnvVar: boolean
  excludeSlashTmp: boolean
}
export type FileSystemPosture =
  | { kind: 'read-only' }
  | WorkspaceWrite
  | { kind: 'full-access' }
  | { kind: 'external' }

export interface Posture {
  fileSystem: FileSystemPosture
  network: boolean
  approval: ApprovalPolicy
  reviewer: Reviewer
  plan: boolean
  trust: Trust
}

export type Outcome = 'deny' | 'ask' | 'review' | 'allow'

export type Effect =
  | { kind: 'read' }
  | { kind: 'write'; path: string }
  | { kind: 'net' }
  | { kind: 'unbounded' }
  | { kind: 'mcp' }

// Where the relative parts of a posture resolve: the thread's cwd and the
// two temp roots workspace-write adds unless told not to.
export interface PostureContext {
  cwd: string
  tmpdir: string
  slashTmp: string
}

// What a thread that names nothing gets: Codex's own default, read-only and
// asking before anything leaves it. Never full access (spec 5.6, fix 1).
export const DEFAULT_POSTURE: Posture = {
  fileSystem: { kind: 'read-only' },
  network: false,
  approval: 'on-request',
  reviewer: 'user',
  plan: false,
  trust: 'unknown',
}

const RANK: Record<Outcome, number> = { deny: 0, ask: 1, review: 2, allow: 3 }

export function outcomeRank(outcome: Outcome): number {
  return RANK[outcome]
}

export function postureContext(cwd: string): PostureContext {
  return { cwd, tmpdir: tmpdir(), slashTmp: '/tmp' }
}

// ---- from Codex -------------------------------------------------------------

export function parseApprovalPolicy(value: unknown): ApprovalPolicy | null {
  if (typeof value === 'string') return parseApprovalString(value.trim())
  const granular = asRecord(value).granular
  if (!isRecord(granular)) return null
  // A flag the client left out reads as false: refuse rather than ask.
  const flags = {} as GranularApproval
  for (const flag of GRANULAR_FLAGS) flags[flag] = granular[flag] === true
  return { granular: flags }
}

function parseApprovalString(value: string): ApprovalPolicy | null {
  switch (value) {
    case 'untrusted':
    case 'unless-trusted':
      return 'untrusted'
    // `on-failure` survives only as a serde alias of `on-request`; it no
    // longer means "accept edits" (spec 5.6, fix 6).
    case 'on-request':
    case 'on-failure':
      return 'on-request'
    case 'never':
      return 'never'
    default:
      return null
  }
}

export function parseReviewer(value: unknown): Reviewer | null {
  if (value === 'user') return 'user'
  // `guardian_subagent` is the spelling Codex still accepts for auto_review.
  if (value === 'auto_review' || value === 'guardian_subagent') return 'auto_review'
  return null
}

export function parseSandboxMode(value: unknown): FileSystemPosture | null {
  if (value === 'read-only') return { kind: 'read-only' }
  if (value === 'workspace-write') return workspaceWrite([], false, false)
  if (value === 'danger-full-access') return { kind: 'full-access' }
  return null
}

interface SandboxPart {
  fileSystem: FileSystemPosture
  network: boolean
}

export function parseSandboxPolicy(value: unknown): SandboxPart | null {
  const policy = asRecord(value)
  switch (policy.type) {
    case 'dangerFullAccess':
      return { fileSystem: { kind: 'full-access' }, network: true }
    case 'readOnly':
      return { fileSystem: { kind: 'read-only' }, network: policy.networkAccess === true }
    case 'externalSandbox':
      return { fileSystem: { kind: 'external' }, network: policy.networkAccess === 'enabled' }
    case 'workspaceWrite':
      return {
        fileSystem: workspaceWrite(
          stringList(policy.writableRoots),
          policy.excludeTmpdirEnvVar === true,
          policy.excludeSlashTmp === true,
        ),
        network: policy.networkAccess === true,
      }
    default:
      return null
  }
}

// Every SandboxPolicy field this module reads, by variant. The schema check
// (scripts/check-posture-schema.mjs) fails when Codex adds one.
export const SANDBOX_POLICY_FIELDS: Record<string, readonly string[]> = {
  dangerFullAccess: ['type'],
  readOnly: ['type', 'networkAccess'],
  externalSandbox: ['type', 'networkAccess'],
  workspaceWrite: [
    'type',
    'writableRoots',
    'networkAccess',
    'excludeTmpdirEnvVar',
    'excludeSlashTmp',
  ],
}

// A sandbox value this module cannot read is taken as the tightest sandbox;
// the schema check keeps that path for app builds newer than the pin.
const UNKNOWN_SANDBOX: SandboxPart = { fileSystem: { kind: 'read-only' }, network: false }

const PROFILE_APPROVAL: Record<string, ApprovalPolicy> = {
  ':read-only': 'on-request',
  ':workspace': 'on-request',
  ':danger-full-access': 'never',
}

// A built-in permission profile's sandbox. A custom profile's contents are
// not visible to the adapter, so it gets the default sandbox, never a broader
// one (spec 5.6, fix 7).
function profileSandbox(id: string): SandboxPart {
  if (id === ':workspace') return { fileSystem: workspaceWrite([], false, false), network: false }
  if (id === ':danger-full-access') return { fileSystem: { kind: 'full-access' }, network: true }
  return UNKNOWN_SANDBOX
}

function profileIdOf(params: Record<string, unknown>): string | null {
  if (typeof params.permissions !== 'string') return null
  const id = params.permissions.trim()
  return id.length > 0 && id.length <= 128 ? id : null
}

// thread/start and thread/resume send the SandboxMode string; turn/start and
// thread/settings/update send the SandboxPolicy struct; the real child's
// lifecycle answers carry the struct under `sandbox`.
function sandboxOf(params: Record<string, unknown>): SandboxPart | null {
  if (params.sandboxPolicy != null) {
    return parseSandboxPolicy(params.sandboxPolicy) ?? UNKNOWN_SANDBOX
  }
  const sandbox = params.sandbox
  if (sandbox == null) return null
  if (typeof sandbox !== 'string') return parseSandboxPolicy(sandbox) ?? UNKNOWN_SANDBOX
  const fileSystem = parseSandboxMode(sandbox)
  if (!fileSystem) return UNKNOWN_SANDBOX
  return { fileSystem, network: fileSystem.kind === 'full-access' }
}

function planOf(params: Record<string, unknown>): boolean | null {
  const mode = asRecord(params.collaborationMode).mode
  if (mode === 'plan') return true
  if (mode === 'default') return false
  return null
}

// Applies the posture fields of a request (thread/start, thread/resume,
// thread/fork, thread/settings/update, turn/start) or of the real child's
// lifecycle answer onto `base`. What the message does not name keeps its
// base value, so a turn that says nothing inherits its thread's posture. A
// named profile wins over sandbox fields: Codex refuses the combination.
export function applyCodexParams(base: Posture, params: Record<string, unknown>): Posture {
  const profile = profileIdOf(params)
  const sandbox = profile ? profileSandbox(profile) : sandboxOf(params)
  const named = parseApprovalPolicy(params.approvalPolicy)
  const approval = named ?? (profile ? (PROFILE_APPROVAL[profile] ?? 'on-request') : null)
  return {
    ...base,
    ...(sandbox ?? {}),
    approval: approval ?? base.approval,
    reviewer: parseReviewer(params.approvalsReviewer) ?? base.reviewer,
    plan: planOf(params) ?? base.plan,
    // Codex applies `untrusted` to projects it does not trust (spec 5.5 G8).
    trust: approval === 'untrusted' ? 'untrusted' : base.trust,
  }
}

// ---- stored and legacy forms --------------------------------------------------

// Rows written before the posture was stored carry only the two legacy
// strings; they convert as recorded.
export function legacyPosture(
  approvalPolicy?: string | null,
  sandboxMode?: string | null,
): Posture {
  const fileSystem = parseSandboxMode(sandboxMode) ?? DEFAULT_POSTURE.fileSystem
  return {
    ...DEFAULT_POSTURE,
    fileSystem,
    network: fileSystem.kind === 'full-access',
    approval: parseApprovalPolicy(approvalPolicy) ?? DEFAULT_POSTURE.approval,
  }
}

export function threadPosture(
  thread: Pick<ThreadRecord, 'posture' | 'approvalPolicy' | 'sandboxMode'> | null,
): Posture {
  if (!thread) return DEFAULT_POSTURE
  return thread.posture ?? legacyPosture(thread.approvalPolicy, thread.sandboxMode)
}

// The posture a runtime enforces for one turn: the thread's, plus the turn's
// own `planMode` flag.
export function contextPosture(
  context: Pick<RuntimeTurnContext, 'posture' | 'approvalPolicy' | 'sandboxMode' | 'planMode'>,
): Posture {
  const posture = context.posture ?? legacyPosture(context.approvalPolicy, context.sandboxMode)
  return context.planMode && !posture.plan ? { ...posture, plan: true } : posture
}

// A posture as a ThreadRecord stores it: the canonical value, plus the two
// legacy strings older readers (and the app's profile badge) still use.
export function postureFields(posture: Posture): {
  approvalPolicy: string
  sandboxMode: string
  posture: Posture
} {
  return {
    approvalPolicy: typeof posture.approval === 'string' ? posture.approval : 'on-request',
    sandboxMode: sandboxModeOf(posture.fileSystem),
    posture,
  }
}

const FILE_SYSTEM_KINDS = ['read-only', 'workspace-write', 'full-access', 'external']

export function parseStoredPosture(text: string | null): Posture | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Posture
    const known = FILE_SYSTEM_KINDS.includes(String(value?.fileSystem?.kind))
    return known && parseApprovalPolicy(value.approval) !== null ? value : null
  } catch {
    return null
  }
}

// ---- into Codex ---------------------------------------------------------------

function sandboxModeOf(fileSystem: FileSystemPosture): string {
  if (fileSystem.kind === 'read-only') return 'read-only'
  if (fileSystem.kind === 'full-access') return 'danger-full-access'
  return 'workspace-write'
}

// A Codex child has no thread-level plan switch, so a plan posture goes over
// as read-only with no escalation: approximate, and tighter.
function codexApproval(posture: Posture): ApprovalPolicy {
  return posture.plan ? 'never' : posture.approval
}

// SandboxPolicy for a thread (turn/start, thread envelopes): workspace-write's
// cwd is implicit, as in Codex.
export function toCodexSandboxPolicy(posture: Posture): Record<string, unknown> {
  const fs = posture.fileSystem
  if (posture.plan) return { type: 'readOnly', networkAccess: false }
  switch (fs.kind) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: posture.network }
    case 'full-access':
      return { type: 'dangerFullAccess' }
    case 'external':
      return { type: 'externalSandbox', networkAccess: posture.network ? 'enabled' : 'restricted' }
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        writableRoots: fs.writableRoots,
        networkAccess: posture.network,
        excludeTmpdirEnvVar: fs.excludeTmpdirEnvVar,
        excludeSlashTmp: fs.excludeSlashTmp,
      }
  }
}

// thread/start takes only the SandboxMode string; roots and network follow on
// the first turn (`toCodexTurn`).
export function toCodexThreadStart(posture: Posture): Record<string, unknown> {
  return {
    approvalPolicy: codexApproval(posture),
    approvalsReviewer: posture.reviewer,
    sandbox: posture.plan ? 'read-only' : sandboxModeOf(posture.fileSystem),
  }
}

export function toCodexTurn(posture: Posture): Record<string, unknown> {
  return {
    approvalPolicy: codexApproval(posture),
    approvalsReviewer: posture.reviewer,
    sandboxPolicy: toCodexSandboxPolicy(posture),
  }
}

// command/exec runs outside any thread: the thread's cwd goes in as an
// explicit root, and an external sandbox (which the child cannot apply to one
// command) becomes workspace-write on that cwd, which is tighter.
export function toCodexExecSandboxPolicy(posture: Posture, cwd: string): Record<string, unknown> {
  const fs = posture.fileSystem
  if (posture.plan || fs.kind === 'read-only' || fs.kind === 'full-access') {
    return toCodexSandboxPolicy(posture)
  }
  const ws = fs.kind === 'workspace-write' ? fs : workspaceWrite([], false, false)
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd, ...ws.writableRoots],
    networkAccess: posture.network,
    excludeTmpdirEnvVar: ws.excludeTmpdirEnvVar,
    excludeSlashTmp: ws.excludeSlashTmp,
  }
}

// ---- from Claude --------------------------------------------------------------

// A Claude parent's permission mode (the hook payload's `permission_mode`) as
// the posture for a Codex child (spec 5.4). acceptEdits and auto edit only the
// working directory: Claude asks for anything outside it, temp dirs included.
// `auto` pairs Claude's classifier with Codex's auto_review, which is
// approximate; `strict` maps it to manual approval instead (spec 5.6).
export function fromClaudePermissionMode(
  mode: string,
  options: { strict?: boolean } = {},
): Posture | null {
  const cwdOnly = workspaceWrite([], true, true)
  switch (mode) {
    case 'default':
    case 'manual':
      return DEFAULT_POSTURE
    case 'acceptEdits':
      return { ...DEFAULT_POSTURE, fileSystem: cwdOnly }
    case 'auto':
      return {
        ...DEFAULT_POSTURE,
        fileSystem: cwdOnly,
        reviewer: options.strict ? 'user' : 'auto_review',
      }
    case 'plan':
      return { ...DEFAULT_POSTURE, approval: 'never', plan: true }
    case 'dontAsk':
      return { ...DEFAULT_POSTURE, approval: 'never' }
    case 'bypassPermissions':
      return {
        ...DEFAULT_POSTURE,
        fileSystem: { kind: 'full-access' },
        network: true,
        approval: 'never',
      }
    default:
      return null
  }
}

// ---- decisions ----------------------------------------------------------------

// The canonical semantics: what `posture` does with an effect reached
// directly (a file tool, a fetch, an escalated command).
export function decide(posture: Posture, effect: Effect, ctx: PostureContext): Outcome {
  // Plan mode reads and calls MCP tools (the Codex parent's own bridge call
  // is one) and does nothing else.
  if (posture.plan) return effect.kind === 'read' || effect.kind === 'mcp' ? 'allow' : 'deny'
  switch (effect.kind) {
    // Codex runs MCP tools without asking (`default_tools_approval_mode`).
    case 'read':
    case 'mcp':
      return 'allow'
    case 'write':
      return canWrite(posture, effect.path, ctx) ? unattended(posture) : escalate(posture)
    case 'net':
      return hasNetwork(posture) ? unattended(posture) : escalate(posture)
    case 'unbounded':
      return posture.fileSystem.kind === 'full-access' ? unattended(posture) : escalate(posture)
  }
}

// A command confined to the posture's own sandbox runs unattended, unless the
// approval policy asks before every command or the thread is planning.
export function sandboxedOutcome(posture: Posture): Outcome {
  return posture.plan ? 'deny' : unattended(posture)
}

// Everything that can reach `effect`: the direct path (`decide`), or a
// sandboxed command when the effect lies inside the sandbox's own bounds.
// This is what "never looser" compares (test/posture.test.mts).
export function reach(posture: Posture, effect: Effect, ctx: PostureContext): Outcome {
  const direct = decide(posture, effect, ctx)
  if (!withinSandbox(posture, effect, ctx)) return direct
  const sandboxed = sandboxedOutcome(posture)
  return RANK[sandboxed] > RANK[direct] ? sandboxed : direct
}

function withinSandbox(posture: Posture, effect: Effect, ctx: PostureContext): boolean {
  switch (effect.kind) {
    case 'read':
      return true
    case 'write':
      return canWrite(posture, effect.path, ctx)
    case 'net':
      return hasNetwork(posture)
    case 'unbounded':
      return posture.fileSystem.kind === 'full-access'
    case 'mcp':
      return false
  }
}

// Full access with nothing that asks: the only posture under which a runtime
// may drop its own approvals (grok --always-approve, claude -p
// --dangerously-skip-permissions, codex exec's bypass flag).
export function isUnrestricted(posture: Posture): boolean {
  return (
    posture.fileSystem.kind === 'full-access' && !posture.plan && posture.approval !== 'untrusted'
  )
}

function unattended(posture: Posture): Outcome {
  return posture.approval === 'untrusted' ? 'ask' : 'allow'
}

// Leaving the sandbox needs approval: refused under `never`, or under a
// granular policy without `sandbox_approval` (spec 5.6, fix 4: `never` means
// no prompts, not no bounds), otherwise asked of the posture's reviewer.
function escalate(posture: Posture): Outcome {
  const policy = posture.approval
  if (policy === 'never') return 'deny'
  if (typeof policy === 'object' && !policy.granular.sandbox_approval) return 'deny'
  return posture.reviewer === 'auto_review' ? 'review' : 'ask'
}

function hasNetwork(posture: Posture): boolean {
  return posture.network || posture.fileSystem.kind === 'full-access'
}

// ---- paths --------------------------------------------------------------------

// Codex keeps these read-only inside every writable root.
const PROTECTED_NAMES = ['.git', '.codex']

export function writableRoots(posture: Posture, ctx: PostureContext): string[] | 'all' {
  const fs = posture.fileSystem
  if (fs.kind === 'full-access') return 'all'
  if (fs.kind === 'read-only') return []
  if (fs.kind === 'external') return [ctx.cwd]
  const roots = [ctx.cwd, ...fs.writableRoots]
  if (!fs.excludeSlashTmp) roots.push(ctx.slashTmp)
  if (!fs.excludeTmpdirEnvVar) roots.push(ctx.tmpdir)
  return roots
}

function canWrite(posture: Posture, path: string, ctx: PostureContext): boolean {
  const roots = writableRoots(posture, ctx)
  if (roots === 'all') return true
  const target = realPath(resolve(ctx.cwd, path))
  return roots.some((root) => {
    const base = realPath(resolve(root))
    if (!isInside(base, target)) return false
    return !PROTECTED_NAMES.some((name) => isInside(join(base, name), target))
  })
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

// Resolves symlinks in the part of `path` that exists, so a link inside a
// writable root cannot aim a write outside it (spec 5.5 G1). A link made after
// the check is not caught here; the OS sandbox behind `exec` covers the shell.
export function realPath(path: string): string {
  const missing: string[] = []
  let head = path
  for (;;) {
    try {
      return join(realpathSync(head), ...missing)
    } catch {
      const parent = dirname(head)
      if (parent === head) return path
      missing.unshift(basename(head))
      head = parent
    }
  }
}

export function postureSummary(posture: Posture): string {
  const approval = typeof posture.approval === 'string' ? posture.approval : 'granular'
  const plan = posture.plan ? 'plan, ' : ''
  return `${plan}${posture.fileSystem.kind}, network ${posture.network ? 'on' : 'off'}, ${approval}`
}

// One predicate per schema enum scripts/check-posture-schema.mjs walks.
export const POSTURE_SCHEMA_COVERAGE = {
  approvalPolicy: (value: string) => parseApprovalPolicy(value) !== null,
  granularFlag: (flag: string) => (GRANULAR_FLAGS as readonly string[]).includes(flag),
  sandboxMode: (value: string) => parseSandboxMode(value) !== null,
  sandboxPolicyType: (type: string) => parseSandboxPolicy({ type }) !== null,
  sandboxPolicyField: (type: string, field: string) =>
    SANDBOX_POLICY_FIELDS[type]?.includes(field) === true,
  reviewer: (value: string) => parseReviewer(value) !== null,
  networkAccess: (value: string) => value === 'restricted' || value === 'enabled',
  modeKind: (value: string) => value === 'plan' || value === 'default',
  claudePermissionMode: (mode: string) => fromClaudePermissionMode(mode) !== null,
}

// ---- helpers ------------------------------------------------------------------

function workspaceWrite(
  writableRoots: string[],
  excludeTmpdirEnvVar: boolean,
  excludeSlashTmp: boolean,
): WorkspaceWrite {
  return { kind: 'workspace-write', writableRoots, excludeTmpdirEnvVar, excludeSlashTmp }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}
```

- [ ] **Step 7: Write `src/posture-claude.mts`**

```ts
// Claude Code as the child of a Codex parent (spec 5.6, enforcement): the
// effect each Claude tool has, the PreToolUse relay's verdict for one call,
// and the launch flags for a posture. Every verdict comes from `decide`
// (src/posture.mts); nothing here has its own idea of what is allowed.
import {
  decide,
  type Effect,
  type Posture,
  type PostureContext,
  postureContext,
  sandboxedOutcome,
} from './posture.mjs'

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash', 'Monitor'])
// No effect outside the conversation. Task/Agent sub-agents run under the
// same hooks, so each of their own calls comes back through the relay;
// WebSearch is a hosted search on both sides, bounded by neither sandbox
// (spec 5.5 G6).
const INERT_TOOLS = new Set([
  'Task',
  'Agent',
  'TodoWrite',
  'WebSearch',
  'ToolSearch',
  'Skill',
  'SlashCommand',
  'ExitPlanMode',
  'AskUserQuestion',
])
const MCP_RESOURCE_TOOLS = new Set(['ListMcpResourcesTool', 'ReadMcpResourceTool'])
export const BRIDGE_EXEC_TOOL = 'mcp__anyengine__exec'
const BRIDGE_TOOL_PREFIX = 'mcp__anyengine__'

// The tools server.mts#requestApproval can draw an approval card for
// (COMMAND_TOOLS and FILE_CHANGE_TOOLS in server-helpers.mts). The app has no
// card for an mcpToolCall item, so asking about any other tool would leave the
// turn waiting on nothing: those are refused instead.
export const APPROVAL_CARD_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit'])

export type ClaudeToolEffect = Effect | 'sandboxed' | 'inert'
export type ClaudeVerdict = 'allow' | 'ask' | 'deny'

export function claudeToolEffect(
  toolName: string,
  input: Record<string, unknown>,
): ClaudeToolEffect {
  if (READ_TOOLS.has(toolName)) return { kind: 'read' }
  if (WRITE_TOOLS.has(toolName)) {
    const path = toolPath(input)
    return path ? { kind: 'write', path } : { kind: 'unbounded' }
  }
  if (SHELL_TOOLS.has(toolName)) return { kind: 'unbounded' }
  if (toolName === 'WebFetch') return { kind: 'net' }
  if (INERT_TOOLS.has(toolName)) return 'inert'
  if (toolName === BRIDGE_EXEC_TOOL) return 'sandboxed'
  // The other bridge tools start threads that inherit this posture.
  if (toolName.startsWith(BRIDGE_TOOL_PREFIX)) return 'inert'
  if (toolName.startsWith('mcp__') || MCP_RESOURCE_TOOLS.has(toolName)) return { kind: 'mcp' }
  // A tool this build does not know runs outside every sandbox until shown otherwise.
  return { kind: 'unbounded' }
}

export function decideClaudeTool(
  posture: Posture,
  toolName: string,
  input: Record<string, unknown>,
  where: string | PostureContext,
): ClaudeVerdict {
  const effect = claudeToolEffect(toolName, input)
  if (effect === 'inert') return 'allow'
  const ctx = typeof where === 'string' ? postureContext(where) : where
  const outcome = effect === 'sandboxed' ? sandboxedOutcome(posture) : decide(posture, effect, ctx)
  if (outcome === 'allow' || outcome === 'deny') return outcome
  // The relay has no reviewer of its own, so `review` is asked of the human
  // (tighter), and only where the app can draw the card.
  return APPROVAL_CARD_TOOLS.has(toolName) ? 'ask' : 'deny'
}

export interface ClaudeLaunch {
  // `plan`, or null to leave the CLI's own mode alone: the relay decides every
  // tool call either way, and a PreToolUse deny beats any allow rule.
  permissionMode: 'plan' | null
  disallowedTools: string[]
  relayPosture: Posture
  // A parent that does not trust the project gets a child that does not
  // either: the workspace trust dialog is refused, not answered (spec 5.5 G8).
  trustWorkspace: boolean
}

export function toClaudeLaunch(posture: Posture, options: { sandboxExec: boolean }): ClaudeLaunch {
  return {
    permissionMode: posture.plan ? 'plan' : null,
    disallowedTools: usesSandboxExec(posture, options.sandboxExec) ? ['Bash', 'Monitor'] : [],
    relayPosture: posture,
    trustWorkspace: posture.trust !== 'untrusted',
  }
}

// Shell goes through the parent's sandbox (the bridge `exec` tool) wherever
// that sandbox exists and bounds something: not under full access (nothing to
// bound), not in plan mode (no shell at all), not under `untrusted` (every
// command is asked about, and only Bash gets an approval card).
export function usesSandboxExec(posture: Posture, sandboxExec: boolean): boolean {
  return (
    sandboxExec &&
    posture.fileSystem.kind !== 'full-access' &&
    !posture.plan &&
    posture.approval !== 'untrusted'
  )
}

function toolPath(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/posture.test.mjs`
Expected: PASS, `ℹ pass 13`, `ℹ fail 0` (the four property tests walk 3080 postures each; the suite finishes in a few seconds).

- [ ] **Step 9: Changelog, gates, commit**

Add to `CHANGELOG.md` under `### M0: adapter safe`:

```markdown
- **One posture type, one decision function.** `src/posture.mts` holds the
  canonical posture in Codex's model (sandbox with roots and network, approval
  policy with granular flags and reviewer, plan, trust), converts in and out
  of Codex requests, Codex child starts, Claude permission modes and Claude
  launches, and decides every effect. A property test walks all 3080
  enumerable parent postures and fails if any converter gives a child more
  than its parent.
```

Run: `npm run check && npm run typecheck`
Expected: `File-size ratchet OK` (the new files are under 500 lines and not baselined), `Complexity ratchet OK: worst 112, 15 over` (every new function is under 30), all gates OK.

```bash
git add src/posture.mts src/posture-claude.mts src/types.mts test/helpers/postures.mts \
  test/posture.test.mts test/fixtures/claude-permission-modes.json CHANGELOG.md
git commit -m "feat: add the canonical posture type with never-looser property tests"
```

---
### Task 8: CI fails on a posture value the map does not cover

Spec 5.6: "CI fails when a new enum value appears in the generated Codex schema or the Claude docs fixture that the map does not cover." The check generates the JSON schema with the pinned codex (Task 6) and asks `POSTURE_SCHEMA_COVERAGE` (Task 7) about every value and every `SandboxPolicy` field.

**Files:**
- Create: `scripts/check-posture-schema.mjs`
- Create: `test/fixtures/fake-codex-schema.mjs`, `test/fixtures/posture-schema.json`
- Create: `test/posture-schema.test.mts`
- Modify: `package.json` (`scripts.check:posture-schema`), `.github/workflows/ci.yml` (step after `npm run build`)
- Modify: `docs/quality.md` (new section 8), `CHANGELOG.md`

**Interfaces:**
- Consumes: `POSTURE_SCHEMA_COVERAGE` from `dist/src/posture.mjs` (Task 7), `test/fixtures/claude-permission-modes.json` (Task 7).
- Produces: `CODEX_REAL=<codex> node scripts/check-posture-schema.mjs` exits 0 with `Posture schema coverage OK: <n> values and fields, all mapped`, or 1 listing each unmapped `<label>: <value>`.

- [ ] **Step 1: Write the schema fixture and the fake generator**

Create `test/fixtures/posture-schema.json` (the posture definitions of `codex app-server generate-json-schema --experimental` at `0.155.0-alpha.2.6`, trimmed to what the check reads):

```json
{
  "definitions": {
    "AskForApproval": {
      "oneOf": [
        { "enum": ["untrusted", "on-request", "never"], "type": "string" },
        {
          "type": "object",
          "required": ["granular"],
          "properties": {
            "granular": {
              "type": "object",
              "properties": {
                "mcp_elicitations": { "type": "boolean" },
                "request_permissions": { "type": "boolean" },
                "rules": { "type": "boolean" },
                "sandbox_approval": { "type": "boolean" },
                "skill_approval": { "type": "boolean" }
              }
            }
          }
        }
      ]
    },
    "SandboxMode": { "enum": ["read-only", "workspace-write", "danger-full-access"], "type": "string" },
    "SandboxPolicy": {
      "oneOf": [
        { "properties": { "type": { "enum": ["dangerFullAccess"] } } },
        { "properties": { "networkAccess": { "type": "boolean" }, "type": { "enum": ["readOnly"] } } },
        {
          "properties": {
            "networkAccess": { "$ref": "#/definitions/NetworkAccess" },
            "type": { "enum": ["externalSandbox"] }
          }
        },
        {
          "properties": {
            "excludeSlashTmp": { "type": "boolean" },
            "excludeTmpdirEnvVar": { "type": "boolean" },
            "networkAccess": { "type": "boolean" },
            "type": { "enum": ["workspaceWrite"] },
            "writableRoots": { "type": "array" }
          }
        }
      ]
    },
    "ApprovalsReviewer": { "enum": ["user", "auto_review", "guardian_subagent"], "type": "string" },
    "NetworkAccess": { "enum": ["restricted", "enabled"], "type": "string" },
    "ModeKind": { "enum": ["plan", "default"], "type": "string" }
  }
}
```

Create `test/fixtures/fake-codex-schema.mjs`:

```js
#!/usr/bin/env node
// Stand-in for `codex app-server generate-json-schema --experimental --out DIR`
// in the posture schema check's tests: writes FAKE_SCHEMA_FILE as the v2 bundle.
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[process.argv.indexOf('--out') + 1]
copyFileSync(process.env.FAKE_SCHEMA_FILE, join(out, 'codex_app_server_protocol.v2.schemas.json'))
```

- [ ] **Step 2: Write the failing test**

Create `test/posture-schema.test.mts`:

```ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const check = resolve('scripts/check-posture-schema.mjs')
const fakeCodex = resolve('test/fixtures/fake-codex-schema.mjs')
const schema = JSON.parse(readFileSync(resolve('test/fixtures/posture-schema.json'), 'utf8'))

function runCheck(definitions: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'anyengine-schema-'))
  try {
    const file = join(dir, 'schema.json')
    writeFileSync(file, JSON.stringify({ definitions }))
    return spawnSync(process.execPath, [check], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_REAL: fakeCodex, FAKE_SCHEMA_FILE: file },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('every posture value of the pinned schema is mapped', () => {
  const result = runCheck(schema.definitions)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Posture schema coverage OK: 38 values and fields, all mapped/)
})

test('a new approval policy value fails the check by name', () => {
  const definitions = structuredClone(schema.definitions)
  definitions.AskForApproval.oneOf[0].enum.push('on-sunday')
  const result = runCheck(definitions)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /AskForApproval: on-sunday/)
})

test('a new sandbox policy field fails the check by name', () => {
  const definitions = structuredClone(schema.definitions)
  definitions.SandboxPolicy.oneOf[3].properties.readableRoots = { type: 'array' }
  const result = runCheck(definitions)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /SandboxPolicy\.workspaceWrite field: readableRoots/)
})

test('a new reviewer or collaboration mode fails the check by name', () => {
  const definitions = structuredClone(schema.definitions)
  definitions.ApprovalsReviewer.enum.push('committee')
  definitions.ModeKind.enum.push('pair')
  const result = runCheck(definitions)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ApprovalsReviewer: committee/)
  assert.match(result.stderr, /ModeKind: pair/)
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/posture-schema.test.mjs`
Expected: FAIL, every test, `Cannot find module .../scripts/check-posture-schema.mjs`.

- [ ] **Step 4: Write the check**

Create `scripts/check-posture-schema.mjs`:

```js
#!/usr/bin/env node
// Posture schema coverage (spec 5.6). Every value the generated Codex
// app-server schema allows for the approval policy and its granular flags,
// the sandbox mode, the sandbox policy (variants and their fields), the
// approvals reviewer, external network access and the collaboration mode
// must be one src/posture.mts converts, and so must every Claude permission
// mode in test/fixtures/claude-permission-modes.json. A value nobody maps
// falls through to a default, which is how the looseness bugs of spec 5.6
// started.
//
// Needs a build (it imports dist/src/posture.mjs) and a real codex binary:
//   CODEX_REAL=/path/to/codex npm run check:posture-schema
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`posture schema check failed: ${message}`)
  process.exit(1)
}

const posturePath = join(root, 'dist', 'src', 'posture.mjs')
const { POSTURE_SCHEMA_COVERAGE: covers } = await import(pathToFileURL(posturePath).href).catch(
  () => fail(`${posturePath} is missing; run npm run build first`),
)

// An isolated CODEX_HOME: generating a schema needs no login and must not
// touch the user's.
function generate(codex) {
  const out = mkdtempSync(join(tmpdir(), 'anyengine-posture-schema-'))
  const home = mkdtempSync(join(tmpdir(), 'anyengine-posture-home-'))
  try {
    const [command, prefix] = codex.endsWith('.mjs') ? [process.execPath, [codex]] : [codex, []]
    const args = [...prefix, 'app-server', 'generate-json-schema', '--experimental', '--out', out]
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: home },
    })
    if (result.status !== 0) {
      fail(`schema generation exited ${result.status}: ${(result.stderr ?? '').trim()}`)
    }
    const bundle = join(out, 'codex_app_server_protocol.v2.schemas.json')
    return JSON.parse(readFileSync(bundle, 'utf8')).definitions
  } finally {
    rmSync(out, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
}

function enumOf(definition, name) {
  if (!Array.isArray(definition?.enum)) fail(`${name} is no longer a string enum in the schema`)
  return definition.enum
}

const codex = process.env.CODEX_REAL?.trim()
if (!codex) fail('set CODEX_REAL to a real codex binary (CI uses the pinned npm codex)')
const defs = generate(codex)
const uncovered = []
let counted = 0
function expect(label, values, covered) {
  counted += values.length
  for (const value of values) if (!covered(value)) uncovered.push(`${label}: ${value}`)
}

const ask = defs.AskForApproval?.oneOf ?? fail('AskForApproval is missing')
const askStrings = ask.find((variant) => Array.isArray(variant.enum))
expect('AskForApproval', enumOf(askStrings, 'AskForApproval'), covers.approvalPolicy)
const granular = ask.find((variant) => variant.properties?.granular)?.properties.granular
if (!granular?.properties) fail('the granular AskForApproval variant is missing')
expect('granular approval flag', Object.keys(granular.properties), covers.granularFlag)
expect('SandboxMode', enumOf(defs.SandboxMode, 'SandboxMode'), covers.sandboxMode)
for (const variant of defs.SandboxPolicy?.oneOf ?? fail('SandboxPolicy is missing')) {
  const type = variant.properties?.type?.enum?.[0] ?? '(untyped variant)'
  expect('SandboxPolicy type', [type], covers.sandboxPolicyType)
  expect(`SandboxPolicy.${type} field`, Object.keys(variant.properties ?? {}), (field) =>
    covers.sandboxPolicyField(type, field),
  )
}
expect('ApprovalsReviewer', enumOf(defs.ApprovalsReviewer, 'ApprovalsReviewer'), covers.reviewer)
expect('NetworkAccess', enumOf(defs.NetworkAccess, 'NetworkAccess'), covers.networkAccess)
expect('ModeKind', enumOf(defs.ModeKind, 'ModeKind'), covers.modeKind)
const fixture = join(root, 'test', 'fixtures', 'claude-permission-modes.json')
const claude = JSON.parse(readFileSync(fixture, 'utf8'))
expect('Claude permission mode', Object.keys(claude.modes), covers.claudePermissionMode)

if (uncovered.length > 0) {
  fail(
    `src/posture.mts does not map:\n  ${uncovered.join('\n  ')}\n` +
      'Map each one (the tightest reading when in doubt) and extend test/posture.test.mts.',
  )
}
console.log(`Posture schema coverage OK: ${counted} values and fields, all mapped.`)
```

In `package.json` `scripts`, add `"check:posture-schema": "node scripts/check-posture-schema.mjs",`.

- [ ] **Step 5: Run the test to see it pass**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/posture-schema.test.mjs`
Expected: PASS, `ℹ pass 4`, `ℹ fail 0`.

- [ ] **Step 6: Run it against a real codex**

Run: `npm run build && CODEX_REAL=/Applications/ChatGPT.app/Contents/Resources/codex npm run check:posture-schema`
Expected: `Posture schema coverage OK: 38 values and fields, all mapped.` (On a machine without ChatGPT.app, use `npm install --global @openai/codex@0.155.0-alpha.2.6` and `CODEX_REAL="$(command -v codex)"`.)

- [ ] **Step 7: Run it in CI**

In `.github/workflows/ci.yml`, directly after `      - run: npm run build       # tsc -> dist/`, add:

```yaml
      # Every posture value of the pinned codex's schema is one src/posture.mts
      # maps (spec 5.6); a new enum value or SandboxPolicy field fails here.
      - run: CODEX_REAL="$(command -v codex)" npm run check:posture-schema
```

Append to `docs/quality.md`:

```markdown
## 8. Posture schema coverage

`npm run check:posture-schema` (CI, after the build) generates the app-server
JSON schema with the pinned codex and fails when an approval policy, granular
approval flag, sandbox mode, sandbox policy variant or field, reviewer,
external network mode or collaboration mode is one `src/posture.mts` does not
map, or when `test/fixtures/claude-permission-modes.json` lists a Claude mode
it does not convert. Bumping the pin (`scripts/sync-codex-compat.mjs`) runs
this against the new schema on the next CI run.
```

Add to `CHANGELOG.md` under `### M0: adapter safe`:

```markdown
- **A new posture value from Codex fails CI instead of falling through.** CI
  generates the pinned codex's schema and checks that every approval,
  sandbox, reviewer, network and collaboration-mode value, and every sandbox
  policy field, is one the posture map converts.
```

- [ ] **Step 8: Gates and commit**

Run: `npm run check && npm run typecheck`
Expected: all gates OK.

```bash
git add scripts/check-posture-schema.mjs test/fixtures/fake-codex-schema.mjs \
  test/fixtures/posture-schema.json test/posture-schema.test.mts package.json \
  .github/workflows/ci.yml docs/quality.md CHANGELOG.md
git commit -m "ci: fail when the Codex schema carries a posture value the map does not cover"
```

---

### Task 9: The posture is parsed, stored and inherited (fixes 1, 2, 3, 7)

Every place that builds or updates a thread's approval policy and sandbox now goes through `applyCodexParams` and stores the full posture. This removes the `never` + `danger-full-access` default (fix 1) from thread start, rehome adoption and bridge sub-agents, keeps granular policies (fix 2) and roots and network (fix 3), and stops custom profiles falling to full access (fix 7). Bridge children and GPT-to-Claude switches inherit the parent's full posture; `thread/settings/update` applies posture changes it used to ignore (a tightening the adapter ignored was a loosening).

The baselined files shrink here, so read the size notes: `src/server.mts`, `src/store.mts`, `src/codex-mux.mts`, `src/bridge-control.mts` and `src/server-helpers.mts` each end this task shorter than they started.

**Files:**
- Create: `src/store-rows.mts`
- Modify: `src/store.mts:1-12` (imports), `:115` (column), `:219-285` (upsert), `:287-291` and `:396` (row mapping calls), delete `:716-747` (`rowToThread`)
- Modify: `src/server.mts:44-84` (imports), `:300-312` (mux local server), `:336-386` (`adoptRehomedThread`), `:501-522` (`bridgeThreadInfo`), `:528-566` (`createBridgeSubagentThread`), `:1013-1073` (`threadStart`), `:1104-1144` (`threadResume`), `:1166-1200` (`threadFork`), `:1507-1530` (`threadMetadataUpdate`), `:1836-1875` (`turnStart`), `:2175-2193` and `:2941-2942` (`runRuntimeTurn`), `:2581-2582` (sub-agent child)
- Modify: `src/server-helpers.mts` (delete `normalizeApprovalPolicy`, `normalizeSandboxMode`, `PermissionProfilePolicy`, `permissionProfilePolicy`, `sandboxFromTurnParams`, `sandboxEnvelope`)
- Modify: `src/server-views.mts:10-19` (imports), `:118-150` (`threadEnvelope`)
- Modify: `src/codex-mux.mts:44-69` (local server interface, `RehomeAdoption`), `:90-95` (`UpstreamThreadInfo`), `:177-188`, `:293-340` (`handleRequest`), `:866-915` (`rehomeToUpstream`), `:956-966` (adoption), `:1183-1205` (`upstreamThreadInfoFrom`)
- Modify: `src/bridge-control.mts:1-11` (imports), `:49-68` (types), `:136-137` (defaults), `:508-530` (`spawnSession`), `:548-560` (`runTurn`), `:615-660` (`spawnSubagent`), `:721` (child turn)
- Create: `test/helpers/adapter-client.mts`, `test/posture-wiring.test.mts`
- Modify: `test/adapter.test.mts:286-380` (settings/update shapes), `:4203-4212`, `:4277-4302` (default posture), `:4372-4373`, `:4711-4713` (comments)
- Modify: `test/codex-mux.test.mts` (GPT to Claude switch), `test/bridge.test.mts:97-120` (`launchAdapter`), `:364-460` (fan-out), `test/fixtures/fake-codex-app-server.mjs` (request log)
- Modify: `docs/guide/bridge.md:84-85`, `docs/reference/capability-matrix.md:42`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `applyCodexParams`, `DEFAULT_POSTURE`, `threadPosture`, `postureFields`, `parseStoredPosture`, `toCodexThreadStart`, `toCodexTurn`, `toCodexSandboxPolicy`, type `Posture` (Task 7).
- Produces: `threadFromRow(row: any): ThreadRecord` (`src/store-rows.mts`); the `threads.posture_json` column; `BridgeThreadInfo.posture: Posture` and `BridgeSubagentThreadInput.posture: Posture` (replacing their `approvalPolicy` / `sandboxMode`); `UpstreamThreadInfo { cwd; model; posture: Posture }`; `RehomeAdoption.posture?: Posture | null` (replacing `approvalPolicy?` / `sandboxMode?`); `MuxLocalServer.localThreadPosture(threadId: string): Posture`; `BridgeConnection.runTurn(threadId, prompt, wait, timeoutMs, overrides?: Record<string, unknown>)`. Test helper `launchAdapter(env: NodeJS.ProcessEnv): AdapterClient` with `request(method, params): Promise<Wire>`, `waitFor(match, timeoutMs?)`, `close()`.

- [ ] **Step 1: Write the adapter client helper**

Create `test/helpers/adapter-client.mts`:

```ts
import type { ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import readline from 'node:readline'
import { spawn } from './children.mjs'

export type Wire = Record<string, any>

const adapter = resolve('dist/src/adapter.mjs')

// One stdio adapter and the JSON-RPC traffic it sends, for suites that need
// requests, responses and a wait for a notification.
export class AdapterClient {
  readonly child: ChildProcess
  readonly messages: Wire[] = []
  private waiters: Array<{ match: (m: Wire) => boolean; done: (m: Wire) => void }> = []
  private nextId = 1

  constructor(child: ChildProcess) {
    this.child = child
    const lines = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream })
    lines.on('line', (line) => {
      if (!line.trim()) return
      const message = JSON.parse(line) as Wire
      this.messages.push(message)
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.match(message)) return true
        waiter.done(message)
        return false
      })
    })
  }

  waitFor(match: (m: Wire) => boolean, timeoutMs = 30_000): Promise<Wire> {
    const seen = this.messages.find(match)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeoutMs)
      this.waiters.push({
        match,
        done: (message) => {
          clearTimeout(timer)
          resolvePromise(message)
        },
      })
    })
  }

  request(method: string, params: unknown): Promise<Wire> {
    const id = this.nextId++
    const response = this.waitFor((m) => m.id === id && !('method' in m))
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return response
  }

  async close(): Promise<void> {
    if (this.child.exitCode != null) return
    const exited = new Promise((resolveExit) => this.child.once('exit', resolveExit))
    this.child.stdin?.end()
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))])
    if (this.child.exitCode == null) this.child.kill('SIGKILL')
  }
}

export function launchAdapter(env: NodeJS.ProcessEnv): AdapterClient {
  return new AdapterClient(
    spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ANYENGINE_MOCK: '1', NODE_NO_WARNINGS: '1', ...env },
    }),
  )
}
```

- [ ] **Step 2: Write the failing wiring tests**

Create `test/posture-wiring.test.mts`:

```ts
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { applyCodexParams, DEFAULT_POSTURE } from '../src/posture.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ThreadRecord } from '../src/types.mjs'
import { launchAdapter, type Wire } from './helpers/adapter-client.mjs'
import { killChildren } from './helpers/children.mjs'

after(killChildren)

function text(prompt: string): Wire {
  return { type: 'text', text: prompt, text_elements: [] }
}

function legacyThread(id: string, cwd: string): ThreadRecord {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    preview: '',
    name: null,
    archived: false,
    cwd,
    model: 'sonnet',
    reasoningEffort: null,
    modelProvider: 'claude-code',
    runtimeBackend: 'claude',
    claudeSessionId: null,
    codexSessionId: null,
    source: 'appServer',
    createdAt: 0,
    updatedAt: 0,
    status: { type: 'idle' },
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    ephemeral: false,
    threadSource: 'user',
    agentRole: null,
    agentNickname: null,
    baseInstructions: null,
    developerInstructions: null,
    personality: null,
  }
}

test('store: the posture column round-trips and rows without one read as null', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-store-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  try {
    const posture = applyCodexParams(DEFAULT_POSTURE, {
      approvalPolicy: { granular: { sandbox_approval: false, rules: true, mcp_elicitations: true } },
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/data'], networkAccess: true },
    })
    store.upsertThread({ ...legacyThread('with', home), posture })
    store.upsertThread(legacyThread('without', home))
    assert.deepEqual(store.getThread('with')?.posture, posture)
    assert.equal(store.getThread('without')?.posture, null)
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('posture: granular approval, writable roots and network survive a restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-wiring-'))
  let client = launchAdapter({ CODEX_HOME: home })
  let threadId = ''
  try {
    const start = await client.request('thread/start', {
      cwd: home,
      model: 'sonnet',
      approvalPolicy: { granular: { sandbox_approval: false, rules: true, mcp_elicitations: true } },
    })
    threadId = start.result.thread.id
    const turn = await client.request('turn/start', {
      threadId,
      input: [text('hi')],
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/data'], networkAccess: true },
    })
    await client.waitFor(
      (m) => m.method === 'turn/completed' && m.params?.turn?.id === turn.result.turn.id,
    )
  } finally {
    await client.close()
  }
  client = launchAdapter({ CODEX_HOME: home })
  try {
    const resumed = await client.request('thread/resume', { threadId })
    assert.deepEqual(resumed.result.approvalPolicy, {
      granular: {
        sandbox_approval: false,
        rules: true,
        mcp_elicitations: true,
        skill_approval: false,
        request_permissions: false,
      },
    })
    assert.deepEqual(resumed.result.sandbox, {
      type: 'workspaceWrite',
      writableRoots: [home, '/data'],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    })
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('posture: a custom profile resolves to read-only, never full access', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-wiring-'))
  const client = launchAdapter({ CODEX_HOME: home })
  try {
    const start = await client.request('thread/start', { cwd: home, permissions: 'team-profile' })
    assert.equal(start.result.approvalPolicy, 'on-request')
    assert.equal(start.result.sandbox.type, 'readOnly')
    assert.deepEqual(start.result.activePermissionProfile, { id: 'team-profile', extends: null })
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('posture: a row stored before M0 keeps its strings until the app sends a posture', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-wiring-'))
  const adapterHome = join(home, 'adapter')
  mkdirSync(adapterHome, { recursive: true })
  const store = new SessionStore(join(adapterHome, 'state.sqlite'))
  store.upsertThread(legacyThread('legacy-thread', home))
  store.close()
  const client = launchAdapter({ CODEX_HOME: home, ANYENGINE_HOME: adapterHome })
  try {
    const resumed = await client.request('thread/resume', { threadId: 'legacy-thread' })
    assert.equal(resumed.result.approvalPolicy, 'never')
    assert.equal(resumed.result.sandbox.type, 'dangerFullAccess')
    const turn = await client.request('turn/start', {
      threadId: 'legacy-thread',
      input: [text('policy check')],
      permissions: ':workspace',
    })
    const delta = await client.waitFor(
      (m) => m.method === 'item/agentMessage/delta' && m.params?.turnId === turn.result.turn.id,
    )
    assert.equal(delta.params.delta, 'approvalPolicy=on-request sandboxMode=workspace-write')
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})
```

In `test/adapter.test.mts`:

Replace the test `thread/start without permission params defaults to never + danger-full-access` (its name, the comment above it and its two assertions) with:

```ts
// A bare thread/start gets Codex's own default, read-only asking before
// anything leaves it, never full access (spec 5.6, fix 1). The approval
// round-trip tests name their posture explicitly.
test('thread/start without permission params defaults to on-request + read-only', async () => {
```

and, inside it, the assertions:

```ts
    assert.equal(start.result.approvalPolicy, 'on-request')
    assert.equal(start.result.sandbox.type, 'readOnly')
```

In `thread/settings/update is the metadata handler for every shape the app sends`, replace the shape 2 comment and assertion with:

```ts
    // Shape 2: the approvals control. The `sandboxPolicy` struct is applied
    // with the approval policy (src/posture.mts); ignoring it once kept a
    // stale, possibly looser posture.
```

```ts
    assert.equal(approvals.result.approvalPolicy, 'on-request')
    assert.equal(approvals.result.sandbox.type, 'workspaceWrite')
```

and the shape 3 comment and assertions with:

```ts
    // Shape 3: the permission-profile variant. `permissions` is applied here
    // too, so the thread takes the profile's sandbox.
```

```ts
    assert.equal(profiled.result.approvalPolicy, 'never')
    assert.equal(profiled.result.sandbox.type, 'dangerFullAccess')
    assert.equal(profiled.result.permissionProfile, null)
```

Replace the stale comments that name the old default: in `approval requests round-trip through Codex server requests` replace the three comment lines above the `thread/start` with `// Ask for an approving policy explicitly: a bare thread/start is read-only.`; in `an MCP tool call runs without asking the app for a file-change approval` replace the two comment lines with `// An approving policy, so a missing card would be visible.`; in the file-change approval test replace the two comment lines with `// An approving policy; the posture decides which calls reach the app.`

In `test/fixtures/fake-codex-app-server.mjs`, add `appendFileSync` to its `node:fs` import and, as the first statement of `handleRequest`, add:

```js
  if (process.env.FAKE_CODEX_REQUESTS_FILE) {
    appendFileSync(process.env.FAKE_CODEX_REQUESTS_FILE, `${JSON.stringify({ method, params })}\n`)
  }
```

In `test/codex-mux.test.mts`, in `mid-thread switch: a GPT thread answers on Claude and goes back to GPT`, directly after the `remember the codeword BANANA` assertion, add:

```ts
    // The Claude side took the child's posture (its thread/start answer:
    // on-request, workspace-write), not the old full-access default.
    const onClaude = await client.request('thread/resume', { threadId })
    assert.equal(onClaude.result.approvalPolicy, 'on-request')
    assert.equal(onClaude.result.sandbox.type, 'workspaceWrite')
```

In `test/bridge.test.mts`, give `launchAdapter` an env parameter: change its signature to `function launchAdapter(home: string, extraEnv: NodeJS.ProcessEnv = {}): LineClient` and add `...extraEnv,` as the last entry of its `env` object. In `bridge: spawn_subagents fans out under the calling thread across engines`, change `const desktop = launchAdapter(home)` to `const desktop = launchAdapter(home, { FAKE_CODEX_REQUESTS_FILE: join(home, 'requests.jsonl') })`, add `readFile` to the `node:fs/promises` import if it is not there, and directly after the `assert.match(results[2].text, /CHARLIE/)` line add:

```ts
    // The GPT child starts under the parent's posture, roots and network
    // included (on the first turn), not the child's config defaults.
    const requests = (await readFile(join(home, 'requests.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Wire)
    const childStart = requests.find(
      (r) => r.method === 'thread/start' && r.params?.model === 'gpt-5.6-sol',
    )
    assert.equal(childStart?.params.approvalPolicy, 'on-request')
    assert.equal(childStart?.params.approvalsReviewer, 'user')
    assert.equal(childStart?.params.sandbox, 'workspace-write')
    const childTurn = requests.find(
      (r) => r.method === 'turn/start' && r.params?.threadId === results[1].threadId,
    )
    assert.deepEqual(childTurn?.params.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    })
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/posture-wiring.test.mjs dist/test/adapter.test.mjs dist/test/codex-mux.test.mjs dist/test/bridge.test.mjs`
Expected: FAIL: the store test (`posture` undefined), the restart test (`approvalPolicy: 'never'`), the custom-profile test (`dangerFullAccess`), the default test (`never`), the two settings/update shapes, the GPT to Claude switch (`never`), the bridge child start (`sandboxPolicy` undefined). The legacy-row test already passes: it pins behaviour this task must keep.

- [ ] **Step 4: Store the posture (and make room in `store.mts`)**

Create `src/store-rows.mts`. Its body is `SessionStore.rowToThread` (`src/store.mts:716-747`) moved verbatim, plus the `posture` line:

```ts
// `threads` row -> ThreadRecord, kept out of store.mts so the store stays
// under its size baseline as columns are added.
import { parseStoredPosture } from './posture.mjs'
import type { ThreadRecord } from './types.mjs'

export function threadFromRow(row: any): ThreadRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    forkedFromId: row.forked_from_id == null ? null : String(row.forked_from_id),
    preview: String(row.preview ?? ''),
    name: row.name == null ? null : String(row.name),
    archived: Number(row.archived) === 1,
    cwd: String(row.cwd),
    model: String(row.model),
    reasoningEffort: row.reasoning_effort == null ? null : String(row.reasoning_effort),
    modelProvider: String(row.model_provider),
    claudeSessionId: row.claude_session_id == null ? null : String(row.claude_session_id),
    source: String(row.source),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    status: JSON.parse(String(row.status_json)),
    approvalPolicy: row.approval_policy == null ? null : String(row.approval_policy),
    sandboxMode: row.sandbox_mode == null ? null : String(row.sandbox_mode),
    permissionProfileId:
      row.permission_profile_id == null ? null : String(row.permission_profile_id),
    ephemeral: Number(row.ephemeral ?? 0) === 1,
    threadSource: row.thread_source == null ? null : String(row.thread_source),
    agentRole: row.agent_role == null ? null : String(row.agent_role),
    agentNickname: row.agent_nickname == null ? null : String(row.agent_nickname),
    baseInstructions: row.base_instructions == null ? null : String(row.base_instructions),
    developerInstructions:
      row.developer_instructions == null ? null : String(row.developer_instructions),
    personality: row.personality == null ? null : String(row.personality),
    runtimeBackend: row.runtime_backend === 'codex' ? 'codex' : 'claude',
    codexSessionId: row.codex_session_id == null ? null : String(row.codex_session_id),
    rehomePrefix: row.rehome_prefix == null ? null : String(row.rehome_prefix),
    posture: parseStoredPosture(row.posture_json == null ? null : String(row.posture_json)),
  }
}
```

In `src/store.mts`:
- add `import { threadFromRow } from './store-rows.mjs'` to the imports;
- after `this.ensureColumn('threads', 'rehome_prefix', 'TEXT')`, add `this.ensureColumn('threads', 'posture_json', 'TEXT')`;
- in `upsertThread`, change the column list's last line from `rehome_prefix` to `rehome_prefix, posture_json`, append `, ?` to the `VALUES (...)` list (29 placeholders), change `rehome_prefix=excluded.rehome_prefix` to `rehome_prefix=excluded.rehome_prefix,` followed by a new line `posture_json=excluded.posture_json`, and after the argument `thread.rehomePrefix ?? null,` add `thread.posture ? JSON.stringify(thread.posture) : null,`;
- replace both `this.rowToThread(row)` calls with `threadFromRow(row)`;
- delete the `private rowToThread(row: any): ThreadRecord { ... }` method.

- [ ] **Step 5: Use the posture in `server.mts`**

Imports: in the `./server-helpers.mjs` import list, delete `normalizeApprovalPolicy,`, `normalizeSandboxMode,`, `permissionProfilePolicy,` and `sandboxFromTurnParams,` (keep `hasLegacyPermissionParams` and `permissionProfileIdFromParams`). Add:

```ts
import { applyCodexParams, DEFAULT_POSTURE, postureFields, threadPosture } from './posture.mjs'
```

In `attachNativeCodex`'s `local: MuxLocalServer = { ... }`, after the `localThreadModel` entry, add:

```ts
      localThreadPosture: (threadId) => threadPosture(this.store.getThread(threadId)),
```

In `adoptRehomedThread`, in the branch that builds a new thread, replace

```ts
          approvalPolicy: input.approvalPolicy ?? 'never',
          sandboxMode: input.sandboxMode ?? 'danger-full-access',
```

with

```ts
          ...postureFields(input.posture ?? DEFAULT_POSTURE),
```

In `bridgeThreadInfo`, replace

```ts
        approvalPolicy: local.approvalPolicy,
        sandboxMode: local.sandboxMode,
```

with

```ts
        posture: threadPosture(local),
```

In `createBridgeSubagentThread`, replace

```ts
      approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy) ?? 'never',
      sandboxMode: normalizeSandboxMode(input.sandboxMode) ?? 'danger-full-access',
```

with

```ts
      ...postureFields(input.posture),
```

In `threadStart`, delete `const permissionProfile = permissionProfilePolicy(permissionProfileId)` and replace

```ts
      approvalPolicy:
        permissionProfile?.approvalPolicy ??
        normalizeApprovalPolicy(params.approvalPolicy) ??
        'never',
      sandboxMode:
        permissionProfile?.sandboxMode ??
        normalizeSandboxMode(params.sandbox) ??
        'danger-full-access',
      permissionProfileId: permissionProfile?.id ?? null,
```

with

```ts
      ...postureFields(applyCodexParams(DEFAULT_POSTURE, params)),
      permissionProfileId,
```

In `threadResume`, delete `const permissionProfile = permissionProfilePolicy(permissionProfileId)` and replace the `if (permissionProfileId) { ... } else { ... }` block (from `if (permissionProfileId) {` through its closing `}` after the `thread.sandboxMode = normalizeSandboxMode(params.sandbox)` line) with:

```ts
    Object.assign(thread, postureFields(applyCodexParams(threadPosture(thread), params)))
    if (permissionProfileId || hasLegacyPermissionParams(params))
      thread.permissionProfileId = permissionProfileId
```

In `threadFork`, replace the `approvalPolicy:` and `sandboxMode:` entries (the ten lines from `approvalPolicy:` to `: parent.sandboxMode),`) with:

```ts
      ...postureFields(applyCodexParams(threadPosture(parent), params)),
```

In `threadMetadataUpdate`, replace

```ts
    if (typeof params.approvalPolicy === 'string')
      thread.approvalPolicy = normalizeApprovalPolicy(params.approvalPolicy)
    if (typeof params.sandbox === 'string')
      thread.sandboxMode = normalizeSandboxMode(params.sandbox)
```

with

```ts
    Object.assign(thread, postureFields(applyCodexParams(threadPosture(thread), params)))
```

In `turnStart`, delete `const permissionProfile = permissionProfilePolicy(permissionProfileId)` and replace the `if (permissionProfileId) { ... } else { ... }` block (through the `if (requestedSandbox) thread.sandboxMode = requestedSandbox` line and its closing `}`) with:

```ts
    Object.assign(thread, postureFields(applyCodexParams(threadPosture(thread), params)))
    if (permissionProfileId || hasLegacyPermissionParams(params))
      thread.permissionProfileId = permissionProfileId
```

In `runRuntimeTurn`, replace the block from the comment `// Allow per-turn override of policy (Codex App may attach updated values` through `permissionProfile?.sandboxMode ?? sandboxFromTurnParams(params) ?? thread.sandboxMode` with:

```ts
    // turnStart already applied this turn's posture fields to the thread
    // (src/posture.mts), so the thread's posture is this turn's.
    const posture = threadPosture(thread)
```

and, in the `this.runtime.runTurn({ ... })` context, replace

```ts
        approvalPolicy,
        sandboxMode,
```

with

```ts
        approvalPolicy: thread.approvalPolicy,
        sandboxMode: thread.sandboxMode,
        posture,
```

In `startSubagent` (the Task-tool child), replace

```ts
        approvalPolicy: thread.approvalPolicy,
        sandboxMode: thread.sandboxMode,
```

with

```ts
        ...postureFields(threadPosture(thread)),
```

- [ ] **Step 6: Delete the helpers nothing calls any more**

In `src/server-helpers.mts`, delete `normalizeApprovalPolicy`, `normalizeSandboxMode`, the `PermissionProfilePolicy` interface, `permissionProfilePolicy`, `sandboxFromTurnParams` (with its three comment lines) and `sandboxEnvelope` (with its three comment lines). Keep `normalizePermissionProfileId`, `permissionProfileIdFromParams`, `hasLegacyPermissionParams`, `threadPermissionProfileId` and `permissionProfileList`.

- [ ] **Step 7: Report the posture in the thread envelope**

In `src/server-views.mts`, delete `sandboxEnvelope,` from the `./server-helpers.mjs` import and add:

```ts
import { type Posture, threadPosture, toCodexTurn } from './posture.mjs'
```

In `threadEnvelope`, add `const codex = toCodexTurn(envelopePosture(threadPosture(thread)))` as its first line, and replace

```ts
    approvalPolicy: thread.approvalPolicy ?? 'never',
    approvalsReviewer: 'user',
    sandbox: sandboxEnvelope(thread.sandboxMode, thread.cwd),
```

with

```ts
    approvalPolicy: codex.approvalPolicy,
    approvalsReviewer: codex.approvalsReviewer,
    sandbox: envelopeSandbox(codex.sandboxPolicy as Record<string, unknown>, thread.cwd),
```

Add below `threadEnvelope`:

```ts
// The envelope shows the permission picker's state; plan is a collaboration
// mode, not a permission, so it is left out here.
function envelopePosture(posture: Posture): Posture {
  return posture.plan ? { ...posture, plan: false } : posture
}

// The app draws its permission badge from this. Workspace-write lists the
// thread's cwd among its roots, as the adapter always has.
function envelopeSandbox(sandbox: Record<string, unknown>, cwd: string): Record<string, unknown> {
  if (sandbox.type !== 'workspaceWrite') return sandbox
  const roots = Array.isArray(sandbox.writableRoots) ? (sandbox.writableRoots as string[]) : []
  return { ...sandbox, writableRoots: [cwd, ...roots] }
}
```

- [ ] **Step 8: Carry the posture through the multiplexer**

In `src/codex-mux.mts`:
- add `import { applyCodexParams, DEFAULT_POSTURE, type Posture, toCodexThreadStart } from './posture.mjs'`;
- in `MuxLocalServer`, after `localThreadModel(threadId: string): string | null`, add `localThreadPosture(threadId: string): Posture`;
- in `RehomeAdoption`, replace `approvalPolicy?: string | null` and `sandboxMode?: string | null` with `posture?: Posture | null`;
- in `UpstreamThreadInfo`, replace `approvalPolicy: string | null` and `sandboxMode: string | null` with `posture: Posture`;
- after `const LOCAL_GLOBAL_METHODS = ...`, add `const POSTURE_METHODS = new Set(['turn/start', 'thread/settings/update'])`;
- replace the `return ( ... )` of `upstreamThreadInfo` (the eight lines ending in `sandboxMode: null, } )`) with:

```ts
    return (
      this.upstreamThreads.get(threadId) ?? { cwd: null, model: null, posture: DEFAULT_POSTURE }
    )
```

- in `handleRequest`, after `if (threadId) this.peerByThread.set(threadId, peer)`, add
  `if (threadId && POSTURE_METHODS.has(method)) this.notePosture(threadId, params)`;
- add the method after `handleRequest`:

```ts
  // turn/start and thread/settings/update set the posture of the turns that
  // follow: bridge children of this thread inherit the current one.
  private notePosture(threadId: string, params: Record<string, unknown>): void {
    const info = this.upstreamThreadInfo(threadId)
    if (info) {
      this.upstreamThreads.set(threadId, { ...info, posture: applyCodexParams(info.posture, params) })
    }
  }
```

- in `rehomeToUpstream`'s `thread/start` params, after `model,`, add `...toCodexThreadStart(this.local.localThreadPosture(threadId)),`;
- in `rehomeToLocal`'s `this.local.adoptThread(peer, { ... })`, after `createdAt: ...`, add
  `posture: this.upstreamThreads.get(knownUpstreamId ?? threadId)?.posture ?? null,`;
- replace `upstreamThreadInfoFrom` with:

```ts
function upstreamThreadInfoFrom(result: Record<string, unknown>): UpstreamThreadInfo {
  return {
    cwd: typeof result.cwd === 'string' ? result.cwd : null,
    model: typeof result.model === 'string' ? result.model : null,
    // The answer's `sandbox` is the child's effective SandboxPolicy.
    posture: applyCodexParams(DEFAULT_POSTURE, result),
  }
}
```

- [ ] **Step 9: Hand bridge children the caller's posture**

In `src/bridge-control.mts`:
- add `import { DEFAULT_POSTURE, type Posture, toCodexThreadStart, toCodexTurn } from './posture.mjs'`;
- in `BridgeThreadInfo` and in `BridgeSubagentThreadInput`, replace `approvalPolicy: string | null` and `sandboxMode: string | null` with `posture: Posture`;
- delete `const SANDBOX_DEFAULT = 'workspace-write'`, `const APPROVAL_DEFAULT = 'on-request'` and the blank line after them;
- in `spawnSession`, after `const caller = this.caller()`, add `const posture = caller?.posture ?? DEFAULT_POSTURE`; in its `thread/start` params replace the `approvalPolicy:` and `sandbox:` lines with `...toCodexThreadStart(posture),`; replace
  `const outcome = await this.runTurn(threadId, prompt, args.wait !== false, timeoutArg(args))` with

```ts
    // The first turn carries what thread/start cannot: roots and network.
    const [wait, overrides] = [args.wait !== false, toCodexTurn(posture)]
    const outcome = await this.runTurn(threadId, prompt, wait, timeoutArg(args), overrides)
```

- in `runTurn`, add a fifth parameter `overrides: Record<string, unknown> = {},` after `timeoutMs: number,` and add `...overrides,` as the first entry of its `turn/start` params;
- in `spawnSubagent`, replace

```ts
    const approvalPolicy = parent?.approvalPolicy ?? APPROVAL_DEFAULT
    const sandboxMode = parent?.sandboxMode ?? SANDBOX_DEFAULT
```

  with `const posture = parent?.posture ?? DEFAULT_POSTURE`; in the `createSubagentThread({ ... })` argument replace `approvalPolicy,` and `sandboxMode,` with `posture,`; in the child-owned `thread/start` params replace `approvalPolicy,` and `sandbox: sandboxMode,` with `...toCodexThreadStart(posture),`; and change
  `const outcome = await this.runTurn(childThreadId, prompt, true, timeoutMs)` to
  `const outcome = await this.runTurn(childThreadId, prompt, true, timeoutMs, toCodexTurn(posture))`.

- [ ] **Step 10: Run the tests to see them pass**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/posture-wiring.test.mjs dist/test/adapter.test.mjs dist/test/codex-mux.test.mjs dist/test/bridge.test.mjs dist/test/posture.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 11: Size and complexity**

Run: `npx biome check --write src test && node scripts/check-size.mjs && node scripts/check-complexity.mjs`
Expected: `Updated scripts/size-baseline.json (commit it)` listing `src/server.mts`, `src/store.mts`, `src/codex-mux.mts`, `src/bridge-control.mts` and `src/server-helpers.mts` with smaller numbers, then `File-size ratchet OK`; `Complexity ratchet OK` (it may also report `Updated scripts/complexity-baseline.json` if a hot spot shrank below 30; commit that too). A ratchet failure here means a replacement above added lines: re-read the snippet, do not raise a baseline.

- [ ] **Step 12: Docs, changelog, gates, commit**

In `docs/guide/bridge.md`, replace the bullet that says the child inherits the caller's `cwd`, `approvalPolicy` and sandbox with:

```markdown
- the child inherits the caller's `cwd` and full posture (`src/posture.mts`:
  sandbox with its roots and network, approval policy including granular
  flags, reviewer); a GPT child gets it on `thread/start` and its first
  `turn/start`. When the caller is unknown the child gets the default:
  read-only, asking before anything leaves it.
```

In `docs/reference/capability-matrix.md`, replace the `Approval policy / sandbox` row with:

```markdown
| Approval policy / sandbox | Supported | The app's posture (profile, sandbox policy with roots and network, approval policy with granular flags, reviewer) is parsed into one type (`src/posture.mts`), stored on the thread and inherited by every child. A thread that names none is read-only and asks; a custom profile is read-only. |
```

Add to `CHANGELOG.md` under `### M0: adapter safe`:

```markdown
- **A missing or unknown posture is no longer full access.** Thread start,
  a GPT-to-Claude switch and bridge sub-agents used to default to `never` +
  `danger-full-access`; custom permission profiles fell through to the same.
  The default is now read-only, asking before anything leaves it; a custom
  profile is read-only. Granular approval policies, writable roots and
  network access are stored with the thread instead of being dropped, bridge
  children get the caller's full posture, and `thread/settings/update`
  applies the posture fields it used to ignore.
```

Run: `npm run check && npm run typecheck && npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/store-rows.mts src/store.mts src/server.mts src/server-helpers.mts src/server-views.mts \
  src/codex-mux.mts src/bridge-control.mts scripts/size-baseline.json scripts/complexity-baseline.json \
  test/helpers/adapter-client.mts test/posture-wiring.test.mts test/adapter.test.mts \
  test/codex-mux.test.mts test/bridge.test.mts test/fixtures/fake-codex-app-server.mjs \
  docs/guide/bridge.md docs/reference/capability-matrix.md CHANGELOG.md
git commit -m "fix: parse, store and inherit the full posture; never default to full access"
```

---
### Task 10: Claude children enforce the parent's posture (relay, sandboxed exec, approvals, trust)

Spec 5.6, "Enforcement for a Claude child under a Codex parent": Claude's Bash is disabled and shell commands run through the real child's `command/exec` with the parent's sandbox policy (E1); Write/Edit path checks happen in the PreToolUse relay (E2); without a sandbox nothing unbounded runs unattended. This task also fixes `never` in the PTY relay (fix 4: `needsApproval` returned false for `never`, so every tool ran unbounded) and makes `requestApproval` decide by posture for every runtime before any card is drawn.

**Files:**
- Create: `src/bridge-exec.mts`
- Create: `src/bridge-sockets.mts` (moved out of `src/bridge-control.mts:839-866`)
- Modify: `src/posture-claude.mts` (launch for a context, spawn key, relay decision, trust refusal)
- Modify: `src/anyengine-runtime.mts:1-48` (imports), `:81-90` (delete `READ_ONLY_TOOLS`), `:111-128` (`PtySession`), `:258-266` (respawn), `:445-460` (session init), `:567-580` (`awaitReady`), `:736-781` (`onPreToolUse`, delete `needsApproval`), `:1252-1272` (`buildInteractiveArgs`)
- Modify: `src/server.mts:1-120` (imports), `:312-320` (`attachNativeCodex`), `:3520-3552` (`requestApproval`)
- Modify: `src/bridge-control.mts:1-11` (imports), `:436-456` (control dispatch), delete `:839-866`
- Modify: `src/bridge-mcp.mts:28-124` (tools), `:128-135` (`BridgeClient.threadId`), `:284-286` (`tools/list`), `:334-360` (`renderResult`)
- Modify: `test/fixtures/fake-claude.mjs` (`WRITE` and `EXEC` prompts), `test/fixtures/fake-codex-app-server.mjs` (`command/exec`)
- Modify: `test/anyengine-runtime.test.mts`, `test/bridge.test.mts`, `test/adapter.test.mts:4700-4765` (file-change test)
- Modify: `docs/guide/backends.md:116-121`, `docs/guide/bridge.md`, `docs/reference/capability-matrix.md:43-44`, `docs/guide/configuration.md` (`ANYENGINE_ALLOWED_TOOLS` row), `CHANGELOG.md`

**Interfaces:**
- Consumes: `contextPosture`, `postureSummary`, `sandboxedOutcome`, `threadPosture`, `toCodexExecSandboxPolicy` (Task 7); `toClaudeLaunch`, `decideClaudeTool`, `ClaudeLaunch`, `ClaudeVerdict` (Task 7); `BridgeThreadInfo.posture` (Task 9).
- Produces, `src/bridge-exec.mts`: `EXEC_DEFAULT_TIMEOUT_MS = 120_000`; `type SandboxUpstream = Pick<CodexUpstream, 'running' | 'request'>`; `registerSandboxUpstream(next: SandboxUpstream | null): void`; `sandboxExecAvailable(): boolean`; `interface BridgeExecResult { exitCode: number; stdout: string; stderr: string }`; `runBridgeExec(caller: BridgeThreadInfo | null, args: Record<string, unknown>): Promise<BridgeExecResult>`.
- Produces, `src/bridge-sockets.mts`: `defaultBridgeSocketPath(): string`, `reapStaleSockets(socketPath: string): void` (moved verbatim).
- Produces, `src/posture-claude.mts`: `claudeLaunchFor(context: RuntimeTurnContext): ClaudeLaunch`, `claudeSpawnKey(context: RuntimeTurnContext): string`, `relayDecision(context, toolName, input): { verdict: ClaudeVerdict; reason: string }`, `trustRefusal(context, dialogLabel: string): Error | null`.
- Produces, bridge MCP: tool `exec` (`{ command: string; timeoutMs?: number }`, control method `bridge/exec`), listed only for a bridge process that carries a thread id; `toolsFor(threadId: string | null)`.

- [ ] **Step 1: Teach the fakes the new calls**

In `test/fixtures/fake-claude.mjs`, add this helper above `async function submit(prompt)`:

```js
// One tool call through the PreToolUse relay: replies `done` when the relay
// allows it, `denied: <reason>` when it does not. The tool itself never runs.
async function toolCall(toolName, input, done) {
  const toolUseId = `toolu_${randomUUID().slice(0, 8)}`
  const decision = permissionDecision(
    await fire('PreToolUse', { tool_name: toolName, tool_input: input, tool_use_id: toolUseId }),
  )
  if (decision.permissionDecision !== 'allow') {
    await reply(`denied: ${decision.permissionDecisionReason ?? 'no reason'}`)
    return
  }
  await fire('PostToolUse', {
    tool_name: toolName,
    tool_input: input,
    tool_use_id: toolUseId,
    tool_response: { ok: true },
  })
  await reply(done)
}
```

and in `submit`, directly before `if (echo) {`, add:

```js
  const writeMatch = /WRITE (\S+)/.exec(prompt)
  if (writeMatch) {
    await toolCall('Write', { file_path: writeMatch[1], content: 'x' }, `wrote: ${writeMatch[1]}`)
    return
  }
  const execMatch = /EXEC (.+)$/.exec(prompt)
  if (execMatch) {
    await toolCall('mcp__anyengine__exec', { command: execMatch[1] }, 'exec: allowed')
    return
  }
```

In `test/fixtures/fake-codex-app-server.mjs`, add a case to `handleRequest`'s switch:

```js
    case 'command/exec':
      return respond(id, {
        exitCode: 0,
        stdout: `sandboxed: ${Array.isArray(params.command) ? params.command.at(-1) : ''}\n`,
        stderr: '',
      })
```

- [ ] **Step 2: Write the failing runtime tests**

In `test/anyengine-runtime.test.mts`, add `realpathSync` via `import { realpathSync } from 'node:fs'`, add `dirname` to the `node:path` import, and add:

```ts
import { registerSandboxUpstream } from '../src/bridge-exec.mjs'
import { DEFAULT_POSTURE, type Posture } from '../src/posture.mjs'
```

Then add the tests:

```ts
// Workspace-write on the cwd alone (temp dirs excluded), asking by default.
const CWD_ONLY: Posture = {
  ...DEFAULT_POSTURE,
  fileSystem: {
    kind: 'workspace-write',
    writableRoots: [],
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  },
}

test('anyengine runtime: under never + workspace-write the bounds decide and nothing asks', async () => {
  const h = await harness()
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'anyengine-ws-')))
  const posture: Posture = { ...CWD_ONLY, approval: 'never' }
  const turn = (turnId: string, prompt: string) => h.run(turnContext({ turnId, cwd, posture, prompt }))
  try {
    await turn('turn-1', `WRITE ${join(cwd, 'inside.txt')}`)
    assert.equal(text(h.events), `wrote: ${join(cwd, 'inside.txt')}`)
    h.events = []
    await turn('turn-2', `WRITE ${join(dirname(cwd), 'outside.txt')}`)
    assert.match(
      text(h.events),
      /^denied: blocked by this thread's sandbox \(workspace-write, network off, never\)/,
    )
    h.events = []
    await turn('turn-3', `WRITE ${join(cwd, '.git', 'config')}`)
    assert.match(text(h.events), /^denied: blocked/)
    h.events = []
    await turn('turn-4', 'Run echo hi')
    assert.match(text(h.events), /^denied: blocked/)
    assert.equal(h.permissionRequests.length, 0, 'never asks the app')
  } finally {
    await h.close()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('anyengine runtime: in-bounds writes run, out-of-bounds writes ask the app', async () => {
  const h = await harness()
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'anyengine-ws-')))
  try {
    await h.run(turnContext({ cwd, posture: CWD_ONLY, prompt: `WRITE ${join(cwd, 'a.txt')}` }))
    assert.equal(h.permissionRequests.length, 0)
    h.events = []
    const outside = join(dirname(cwd), 'b.txt')
    await h.run(turnContext({ turnId: 'turn-2', cwd, posture: CWD_ONLY, prompt: `WRITE ${outside}` }))
    assert.equal(h.permissionRequests.length, 1)
    assert.equal(h.permissionRequests[0]?.toolName, 'Write')
    assert.equal(text(h.events), `wrote: ${outside}`)
  } finally {
    await h.close()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('anyengine runtime: a parent that does not trust the project gets no trusted child', async () => {
  const h = await harness({}, { FAKE_CLAUDE_TRUST_PROMPT: '1' })
  try {
    await assert.rejects(
      h.run(turnContext({ posture: { ...DEFAULT_POSTURE, trust: 'untrusted' }, prompt: 'hi' })),
      /does not trust this project/,
    )
  } finally {
    await h.close()
  }
})

test('anyengine runtime: with a sandbox, shell goes through exec and Bash is off', async () => {
  registerSandboxUpstream({ running: true, request: async () => ({}) })
  const h = await harness()
  const mcpServers = { anyengine: { type: 'stdio', command: process.execPath, args: [] } }
  try {
    await h.run(turnContext({ posture: CWD_ONLY, mcpServers, prompt: 'EXEC ls' }))
    assert.equal(text(h.events), 'exec: allowed')
    assert.equal(h.permissionRequests.length, 0, 'a sandboxed command needs no card')
    let spawns = (await readFile(h.argsFile, 'utf8')).trim().split('\n')
    const args = JSON.parse(spawns[0] ?? '[]') as string[]
    assert.deepEqual(
      args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--append-system-prompt')),
      ['AskUserQuestion', 'ExitPlanMode', 'Bash', 'Monitor'],
    )
    // Full access has nothing to bound, so Bash comes back; the tool list binds
    // at spawn, so the PTY is respawned.
    h.events = []
    const full: Posture = { ...CWD_ONLY, fileSystem: { kind: 'full-access' }, network: true }
    await h.run(turnContext({ turnId: 'turn-2', posture: full, mcpServers, prompt: 'Run echo hi' }))
    assert.equal(text(h.events), 'ran: hi')
    spawns = (await readFile(h.argsFile, 'utf8')).trim().split('\n')
    assert.equal(spawns.length, 2, 'the launch changed, so the PTY was respawned')
  } finally {
    registerSandboxUpstream(null)
    await h.close()
  }
})
```

- [ ] **Step 3: Write the failing bridge and approval tests**

In `test/bridge.test.mts`, add:

```ts
test('bridge: exec runs through the child\'s command/exec under the caller\'s sandbox', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-exec-'))
  const requests = join(home, 'requests.jsonl')
  const desktop = launchAdapter(home, { FAKE_CODEX_REQUESTS_FILE: requests })
  const bridges: LineClient[] = []
  try {
    await initializeDesktop(desktop)
    const parent = await desktop.request('thread/start', {
      cwd: home,
      model: 'opus',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    })
    const bridge = launchBridge(home, parent.result.thread.id)
    bridges.push(bridge)
    await initializeBridge(bridge)
    const tools = await bridge.request('tools/list', {})
    assert.ok(
      tools.result.tools.some((t: Wire) => t.name === 'exec'),
      'a bridge that knows its thread offers exec',
    )
    const ran = await callTool(bridge, 'exec', { command: 'echo hi' })
    assert.equal(ran.isError, false, ran.content?.[0]?.text)
    assert.match(ran.content[0].text, /^exit 0\nsandboxed: echo hi/)
    const exec = (await readFile(requests, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Wire)
      .find((r) => r.method === 'command/exec')
    assert.deepEqual(exec?.params.command, ['/bin/bash', '-lc', 'echo hi'])
    assert.equal(exec?.params.cwd, home)
    assert.deepEqual(exec?.params.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [home],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    })

    // An untrusted thread asks before every command, which exec cannot do.
    const untrusted = await desktop.request('thread/start', {
      cwd: home,
      model: 'opus',
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    })
    const asking = launchBridge(home, untrusted.result.thread.id)
    bridges.push(asking)
    await initializeBridge(asking)
    const refused = await callTool(asking, 'exec', { command: 'echo hi' })
    assert.equal(refused.isError, true)
    assert.match(refused.content[0].text, /asks before every command/)
  } finally {
    for (const bridge of bridges) await bridge.close()
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('bridge: exec refuses to run anything without a sandbox', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ccx-bridge-nosandbox-'))
  const desktop = launchAdapter(home, { ANYENGINE_REAL_CODEX: '' })
  let bridge: LineClient | null = null
  try {
    await desktop.request('initialize', { clientInfo: { name: 'test', version: '0' } }, '__init__')
    const parent = await desktop.request('thread/start', { cwd: home, model: 'opus' })
    bridge = launchBridge(home, parent.result.thread.id)
    await initializeBridge(bridge)
    const refused = await callTool(bridge, 'exec', { command: 'echo hi' })
    assert.equal(refused.isError, true)
    assert.match(refused.content[0].text, /no sandbox is available/)
  } finally {
    await bridge?.close()
    await desktop.close()
    await rm(home, { recursive: true, force: true })
  }
})
```

(If `readFile` is not yet imported from `node:fs/promises` in `test/bridge.test.mts`, add it; Task 9 did.)

In `test/adapter.test.mts`, in the file-change approval test (the one sending `please edit file`), change the `thread/start` params' `sandbox: 'workspace-write'` to `sandbox: 'read-only'` and its comment to `// A read-only thread: the write leaves its bounds, so the app is asked.` Then add after that test:

```ts
test('a write inside the workspace runs without an approval card', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-test-'))
  const repo = join(home, 'repo')
  execFileSync('mkdir', ['-p', repo])
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  await writeFile(join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'],
    { cwd: repo, stdio: 'ignore' },
  )
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, ANYENGINE_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: repo, approvalPolicy: 'on-request', sandbox: 'workspace-write' },
      }),
    )
    const start = await reader.nextResponse(1)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId: start.result.thread.id,
          input: [{ type: 'text', text: 'please edit file', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)
    let sawCard = false
    let diff = ''
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/fileChange/requestApproval') sawCard = true
      if (message.method === 'turn/diff/updated') diff = message.params.diff
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawCard, false, 'the workspace is writable, so no card')
    assert.match(diff, /changed by mock runtime/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})
```

- [ ] **Step 4: Run them to see them fail**

Run: `npm run build`
Expected: FAIL at compile time: `Cannot find module '../src/bridge-exec.mjs'`.

- [ ] **Step 5: Move the socket helpers out of `bridge-control.mts`**

Create `src/bridge-sockets.mts` with `defaultBridgeSocketPath` and `reapStaleSockets` moved verbatim from `src/bridge-control.mts` (the two functions and the two comment lines above `reapStaleSockets`), under this header and these imports:

```ts
// Where the bridge's control socket lives, and the sweep for sockets left by
// adapters that died without unlinking theirs. Moved out of bridge-control.mts
// so that file stays under its size baseline.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adapterHome, socketPathLimit, stableHash } from './util.mjs'
```

Both functions are `export function`. In `src/bridge-control.mts`, delete the two functions and add:

```ts
import { runBridgeExec } from './bridge-exec.mjs'
import { defaultBridgeSocketPath, reapStaleSockets } from './bridge-sockets.mjs'
```

Then run `npx biome check --write src/bridge-control.mts src/bridge-sockets.mts`; it drops the imports `bridge-control.mts` no longer uses (`mkdirSync`, `readdirSync`, `tmpdir`, and any of `adapterHome`, `socketPathLimit`, `stableHash` it no longer reads).

- [ ] **Step 6: Write `src/bridge-exec.mts`**

```ts
// `exec`, the bridge tool a Claude child runs shell commands through (spec
// 5.6, E1). Claude's own Bash is switched off at launch
// (src/posture-claude.mts) and each command runs in the real codex child via
// app-server `command/exec`, under the sandbox of the calling thread's
// posture: Codex's own sandbox, not a reimplementation.
import type { BridgeThreadInfo } from './bridge-control.mjs'
import type { CodexUpstream } from './codex-upstream.mjs'
import { sandboxedOutcome, toCodexExecSandboxPolicy } from './posture.mjs'

export const EXEC_DEFAULT_TIMEOUT_MS = 120_000

// The real codex child (server.mts#attachNativeCodex). None, or not running,
// means no sandbox: `exec` refuses and Claude keeps a relay-gated Bash.
export type SandboxUpstream = Pick<CodexUpstream, 'running' | 'request'>
let upstream: SandboxUpstream | null = null

export function registerSandboxUpstream(next: SandboxUpstream | null): void {
  upstream = next
}

export function sandboxExecAvailable(): boolean {
  return upstream?.running === true
}

export interface BridgeExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export async function runBridgeExec(
  caller: BridgeThreadInfo | null,
  args: Record<string, unknown>,
): Promise<BridgeExecResult> {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) throw new Error('command is required')
  if (!caller || caller.owner !== 'local') {
    throw new Error('exec runs commands for Claude and Grok threads; GPT threads have their own shell')
  }
  const child = upstream
  if (!child?.running) {
    throw new Error('no sandbox is available (no native codex child is running), so exec runs nothing')
  }
  const outcome = sandboxedOutcome(caller.posture)
  if (outcome === 'deny') throw new Error('the thread is in plan mode, which runs no commands')
  if (outcome !== 'allow') {
    throw new Error(
      "this thread's approval policy asks before every command, which exec cannot do; use Bash",
    )
  }
  // The thread's cwd is the sandbox root. A command that needs another
  // directory `cd`s there; it cannot move the root.
  const cwd = caller.cwd ?? process.cwd()
  const timeout = Number(args.timeoutMs)
  const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : EXEC_DEFAULT_TIMEOUT_MS
  const params = {
    command: ['/bin/bash', '-lc', command],
    cwd,
    sandboxPolicy: toCodexExecSandboxPolicy(caller.posture, cwd),
    timeoutMs,
  }
  const result = asRecord(await child.request('command/exec', params, timeoutMs + 10_000))
  return {
    exitCode: Number(result.exitCode ?? -1),
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
```

In `src/bridge-control.mts`'s control dispatch (`handleControlRequest`), add before `default:`:

```ts
        case 'bridge/exec':
          result = await runBridgeExec(this.caller(), args)
          break
```

- [ ] **Step 7: Offer `exec` in the bridge MCP server**

In `src/bridge-mcp.mts`, append to `BRIDGE_TOOLS` (after `wait_session`):

```ts
  {
    name: 'exec',
    description:
      "Run a shell command inside this thread's sandbox (its writable directories and network setting, as the app set them) and return the exit code, stdout and stderr. Commands start in the thread's working directory; `cd` first to run elsewhere.",
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'The command line, run with bash -lc.' },
        timeoutMs: {
          type: 'integer',
          description: 'Kill the command after this many milliseconds (default 120000).',
        },
      },
      additionalProperties: false,
    },
  },
```

Add `exec: 'bridge/exec',` to `TOOL_TO_METHOD`. In `BridgeClient`, change `private readonly threadId: string | null` to `readonly threadId: string | null`. Replace `result = { tools: BRIDGE_TOOLS }` with `result = { tools: toolsFor(client.threadId) }` and add:

```ts
// `exec` belongs to threads the adapter runs (Claude, Grok): their bridge
// process carries the thread id. A GPT thread's bridge carries none and keeps
// its own sandboxed shell, so it never sees the tool.
export function toolsFor(threadId: string | null) {
  return threadId ? BRIDGE_TOOLS : BRIDGE_TOOLS.filter((tool) => tool.name !== 'exec')
}
```

In `renderResult`, add before `default:`:

```ts
    case 'exec': {
      const lines = [`exit ${result.exitCode ?? '?'}`, String(result.stdout ?? '')]
      if (result.stderr) lines.push(`[stderr]\n${result.stderr}`)
      return lines.join('\n').trimEnd()
    }
```

- [ ] **Step 8: Add the relay pieces to `src/posture-claude.mts`**

Extend its `./posture.mjs` import with `contextPosture` and `postureSummary`, and add:

```ts
import { sandboxExecAvailable } from './bridge-exec.mjs'
import type { RuntimeTurnContext } from './types.mjs'
```

Append:

```ts
// The bridge's MCP server name (BRIDGE_SERVER_NAME in bridge-control.mts):
// where the `exec` tool lives. Without it Bash stays on.
const BRIDGE_SERVER = 'anyengine'

// The launch for one turn: the thread's posture, and whether a sandbox can
// take the shell (the real codex child is running and this engine has the
// bridge).
export function claudeLaunchFor(context: RuntimeTurnContext): ClaudeLaunch {
  const sandboxExec = hasBridgeServer(context.mcpServers) && sandboxExecAvailable()
  return toClaudeLaunch(contextPosture(context), { sandboxExec })
}

// What binds at spawn (`--model`, `--permission-mode`, `--disallowedTools`):
// a change means a cold respawn that resumes the same Claude session.
export function claudeSpawnKey(context: RuntimeTurnContext): string {
  const launch = claudeLaunchFor(context)
  return JSON.stringify([context.model ?? null, launch.permissionMode, launch.disallowedTools])
}

// The PreToolUse relay's answer for one call (spec 5.3, E2). An operator's
// ANYENGINE_ALLOWED_TOOLS pre-approves a tool the posture would ask about; it
// never turns a refusal into a run.
export function relayDecision(
  context: RuntimeTurnContext,
  toolName: string,
  input: Record<string, unknown>,
): { verdict: ClaudeVerdict; reason: string } {
  const posture = contextPosture(context)
  let verdict = decideClaudeTool(posture, toolName, input, context.cwd)
  if (verdict === 'ask' && context.allowedTools?.includes(toolName)) verdict = 'allow'
  if (verdict === 'deny') {
    return { verdict, reason: `blocked by this thread's sandbox (${postureSummary(posture)})` }
  }
  return { verdict, reason: verdict === 'allow' ? 'auto-approved by anyengine' : 'asks the app' }
}

// The workspace trust dialog of a project the parent does not trust is
// refused, and the turn fails with this error, rather than answered.
export function trustRefusal(context: RuntimeTurnContext, dialogLabel: string): Error | null {
  if (!/trust this folder/i.test(dialogLabel)) return null
  if (claudeLaunchFor(context).trustWorkspace) return null
  return new Error(
    'the parent thread does not trust this project, so Claude is not started with the workspace trusted',
  )
}

function hasBridgeServer(mcpServers: unknown): boolean {
  if (!mcpServers || typeof mcpServers !== 'object') return false
  const record = mcpServers as Record<string, unknown>
  const servers = record.mcpServers && typeof record.mcpServers === 'object' ? record.mcpServers : record
  return BRIDGE_SERVER in (servers as object)
}
```

- [ ] **Step 9: Enforce in the PTY runtime**

In `src/anyengine-runtime.mts`:
- add `import { claudeLaunchFor, claudeSpawnKey, relayDecision, trustRefusal } from './posture-claude.mjs'`;
- delete the `READ_ONLY_TOOLS` set;
- in `interface PtySession`, after `model: string | null`, add `spawnKey: string`;
- in `runTurnOnce`, replace the respawn condition and its comment with:

```ts
    if (session && (session.exited || session.spawnKey !== claudeSpawnKey(context))) {
      // `--model`, `--permission-mode` and `--disallowedTools` bind at spawn; a
      // change means a cold respawn that resumes the same Claude session.
```

- in `spawn`, in the `const session: PtySession = { ... }` literal, after `model: context.model ?? null,`, add `spawnKey: claudeSpawnKey(context),`;
- in `awaitReady`, directly after `const dialog = parseStartupPrompt(viewport)`, add:

```ts
      const refusal = dialog ? trustRefusal(turn.context, dialog.label) : null
      if (refusal) {
        this.settle(turn, refusal)
        return
      }
```

- in `onPreToolUse`, replace

```ts
    if (!this.needsApproval(turn.context, toolName)) {
      pending.decision = 'allow'
      return permissionOutput('allow', 'auto-approved by anyengine')
    }
```

  with

```ts
    const relay = relayDecision(turn.context, toolName, input)
    if (relay.verdict !== 'ask') {
      pending.decision = relay.verdict
      return permissionOutput(relay.verdict, relay.reason)
    }
```

- delete the `private needsApproval(...)` method;
- in `buildInteractiveArgs`, replace

```ts
  // AskUserQuestion / ExitPlanMode render TUI dialogs no hook can answer.
  args.push('--disallowedTools', 'AskUserQuestion', 'ExitPlanMode')
```

  with

```ts
  // AskUserQuestion / ExitPlanMode render TUI dialogs no hook can answer; Bash
  // goes when the parent's sandbox takes the shell (src/posture-claude.mts).
  const launch = claudeLaunchFor(context)
  args.push('--disallowedTools', 'AskUserQuestion', 'ExitPlanMode', ...launch.disallowedTools)
```

  and `if (context.planMode) args.push('--permission-mode', 'plan')` with
  `if (launch.permissionMode) args.push('--permission-mode', launch.permissionMode)`.

- [ ] **Step 10: Decide by posture before any card, and register the sandbox**

In `src/server.mts`, add:

```ts
import { registerSandboxUpstream } from './bridge-exec.mjs'
import { decideClaudeTool } from './posture-claude.mjs'
```

In `attachNativeCodex`, directly after the `const upstream = new CodexUpstream({ ... })` statement, add `registerSandboxUpstream(upstream)`.

In `requestApproval`, replace the `// Defensive: if Codex App selected approvalPolicy=never ...` comment and the `const thread = ...` / `if (thread && (...never... || ...danger-full-access...)) { return { decision: 'accept' } }` block with:

```ts
    // The thread's posture answers first: in-bounds calls are accepted and
    // refusals declined without a card; only what it would ask about reaches the app.
    const thread = this.store.getThread(threadId)
    const verdict = thread
      ? decideClaudeTool(threadPosture(thread), event.toolName, event.input, thread.cwd)
      : 'deny'
    if (verdict !== 'ask') return { decision: verdict === 'allow' ? 'accept' : 'decline' }
```

Further down, replace the comment block that begins `// The App renders exactly two approval cards` together with the `if (approvalKind === 'none') { ... }` block after `const approvalKind = approvalKindForTool(event.toolName)` with the single comment line (above `const approvalKind = ...`):

```ts
    // Only Bash, Edit, Write and MultiEdit get here (APPROVAL_CARD_TOOLS): each has a card.
```

- [ ] **Step 11: Run the tests to see them pass**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/anyengine-runtime.test.mjs dist/test/bridge.test.mjs dist/test/adapter.test.mjs dist/test/posture.test.mjs dist/test/grok-runtime.test.mjs`
Expected: PASS, `ℹ fail 0`. The unchanged `anyengine runtime: turn, warm-PTY permission round-trip, deny and full access` still sees one card for `Run echo hi` (a bare context is read-only asking, and Bash leaves it) and none under full access.

- [ ] **Step 12: Size and complexity**

Run: `npx biome check --write src test && node scripts/check-size.mjs && node scripts/check-complexity.mjs`
Expected: `Updated scripts/size-baseline.json` with `src/server.mts`, `src/anyengine-runtime.mts` and `src/bridge-control.mts` lower, then `File-size ratchet OK`; `Complexity ratchet OK`.

- [ ] **Step 13: Docs, changelog, gates, commit**

In `docs/guide/backends.md`, in the anyengine runtime's `3. **Hooks.**` item, replace the sentence that starts ``PreToolUse` becomes the App's native`` and ends ``(`approvalPolicy=never` or `sandbox=danger-full-access`).`` with:

```markdown
   `PreToolUse` enforces the thread's posture (`src/posture-claude.mts`):
   a call inside the thread's bounds runs, a call the posture refuses is
   denied with the reason, and only what the posture would ask about becomes
   the App's native command / file-change approval. With a native codex child
   running, Claude's `Bash` is switched off and shell commands go through the
   bridge `exec` tool, which runs them in that child's sandbox
   (`command/exec`). A project the parent does not trust is not trusted
   here either: the workspace trust dialog is refused.
```

In `docs/reference/capability-matrix.md`, replace the `Bash approval` and `File edit approval` rows with:

```markdown
| Shell | Supported | With a native codex child: Bash off, commands through the bridge `exec` tool in the child's sandbox. Without one: Bash, asked or refused by posture, never run unattended outside full access. |
| File edit approval | Supported | Writes inside the thread's writable roots run; writes outside them ask (Edit/Write/MultiEdit cards with diffs) or are refused under `never`. |
```

In `docs/guide/bridge.md`, add after the tool list:

```markdown
`exec` (Claude and Grok threads only) runs one shell command in the real
codex child's sandbox with the calling thread's posture, through app-server
`command/exec`, and returns the exit code, stdout and stderr. It refuses when
no native codex child is running, in plan mode, and under `untrusted` (which
asks before every command; Bash keeps its approval card there).
```

In `docs/guide/configuration.md`, replace the `ANYENGINE_ALLOWED_TOOLS` reference row with:

```markdown
| `ANYENGINE_ALLOWED_TOOLS` | Pre-approved tools: one the thread's posture would ask about runs without the card; one the posture refuses stays refused. |
```

Add to `CHANGELOG.md` under `### M0: adapter safe`:

```markdown
- **Claude under a Codex parent stays inside the parent's sandbox.** The
  PreToolUse relay decides every call from the thread's posture: writes
  inside the writable roots run, writes outside them (symlinks resolved) ask
  or, under `never`, are refused; `never` no longer means "run everything".
  With a native codex child running, Claude's Bash is switched off and shell
  commands run through the new bridge `exec` tool in that child's own
  sandbox. The server decides by posture before drawing any approval card,
  for every runtime.
```

Run: `npm run check && npm run typecheck && npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/bridge-exec.mts src/bridge-sockets.mts src/posture-claude.mts src/anyengine-runtime.mts \
  src/server.mts src/bridge-control.mts src/bridge-mcp.mts scripts/size-baseline.json \
  scripts/complexity-baseline.json test/fixtures/fake-claude.mjs \
  test/fixtures/fake-codex-app-server.mjs test/anyengine-runtime.test.mts test/bridge.test.mts \
  test/adapter.test.mts docs/guide/backends.md docs/guide/bridge.md \
  docs/reference/capability-matrix.md docs/guide/configuration.md CHANGELOG.md
git commit -m "feat: enforce the parent posture on Claude children and run their shell in its sandbox"
```

---
### Task 11: The other runtimes never loosen `never` (fixes 4, 5, 6)

The same looseness lived in every runtime that is not the PTY: Grok's `--always-approve`, `claude -p`'s `--dangerously-skip-permissions` and the SDK runtime's auto-allowing `canUseTool` all switched on for `never` (fix 4); the `codex exec` fallback added `--dangerously-bypass-approvals-and-sandbox` for an unknown sandbox and on every `exec resume` (fix 5); the SDK mapped `on-failure` to `acceptEdits` (fix 6); the mock runtime mirrored the same `never` shortcut. After this task a runtime drops its own approvals only when `isUnrestricted(posture)`, and everything else is decided by posture (directly, or by `requestApproval` from Task 10).

**Files:**
- Modify: `src/grok-acp.mts:83-90` (`grokAgentSpec`)
- Modify: `src/claude-p-runtime.mts:16` (`READ_ONLY_TOOLS`), `:106-114` (skip flag), `:304-309` (`allowedToolsForContext`)
- Modify: `src/native-runtime.mts:296-326` (`buildOptions`), `:386-390` (`makeCanUseTool`), `:1208-1223` (`derivePermissionMode`)
- Modify: `src/codex-proxy-runtime.mts:14-18` (imports), `:60-95` (argv), add `codexExecArgs` and `execSandboxArgs`
- Modify: `src/mock-runtime.mts:24-28` (auto-approve)
- Create: `test/posture-runtimes.test.mts`
- Modify: `test/posture-wiring.test.mts` (one test)
- Modify: `docs/guide/backends.md:289-293` (grok approvals), `docs/guide/configuration.md` (`ANYENGINE_PERMISSION_MODE`, `ANYENGINE_CLAUDE_P_SKIP_PERMISSIONS` rows), `CHANGELOG.md`

**Interfaces:**
- Consumes: `contextPosture`, `isUnrestricted`, type `Posture` (Task 7); `relayDecision` (Task 10); `test/helpers/postures.mts` (Task 7); `launchAdapter` (Task 9).
- Produces: `codexExecArgs(context: RuntimeTurnContext): string[]` and `execSandboxArgs(posture: Posture, resume: boolean): string[]` exported from `src/codex-proxy-runtime.mts`.

- [ ] **Step 1: Write the failing tests**

Create `test/posture-runtimes.test.mts`:

```ts
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { ClaudePTranscriptRuntime } from '../src/claude-p-runtime.mjs'
import { codexExecArgs, execSandboxArgs } from '../src/codex-proxy-runtime.mjs'
import { grokAgentSpec } from '../src/grok-acp.mjs'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import { applyCodexParams, DEFAULT_POSTURE, isUnrestricted, type Posture } from '../src/posture.mjs'
import type { RuntimeTurnContext } from '../src/types.mjs'
import { everyPosture, postureTree } from './helpers/postures.mjs'

const tree = postureTree()
after(() => rmSync(tree.base, { recursive: true, force: true }))

function context(posture: Posture | null, overrides: Partial<RuntimeTurnContext> = {}): RuntimeTurnContext {
  return {
    threadId: 'thread',
    turnId: 'turn',
    prompt: 'hello',
    cwd: tree.ctx.cwd,
    runtimeType: null,
    model: null,
    effort: null,
    claudeSessionId: null,
    forkSession: false,
    mcpServers: null,
    allowedTools: null,
    addDirs: [],
    enableFileCheckpointing: false,
    outputFormat: null,
    approvalPolicy: null,
    sandboxMode: null,
    ...(posture ? { posture } : {}),
    systemPromptAddendum: null,
    planMode: false,
    imageInputs: [],
    ...overrides,
  }
}

const WS_NEVER = applyCodexParams(DEFAULT_POSTURE, { permissions: ':workspace', approvalPolicy: 'never' })
const FULL = applyCodexParams(DEFAULT_POSTURE, { permissions: ':danger-full-access' })

function claudeP(): { args: (c: RuntimeTurnContext) => string[] } {
  const runtime = new ClaudePTranscriptRuntime({
    command: 'claude-p',
    extraArgs: [],
    timeoutMs: 60_000,
    skipPermissions: false,
    resume: false,
  })
  const argsForContext = Reflect.get(runtime, 'argsForContext') as (
    c: RuntimeTurnContext,
    inputFile: string,
  ) => string[]
  return { args: (c) => argsForContext.call(runtime, c, '/tmp/in') }
}

test('never looser: a runtime drops its own approvals only for an unrestricted posture', () => {
  const p = claudeP()
  for (const posture of everyPosture(tree)) {
    const ctx = context(posture)
    const unrestricted = isUnrestricted(posture)
    assert.equal(grokAgentSpec(ctx).alwaysApprove, unrestricted, 'grok --always-approve')
    assert.equal(p.args(ctx).includes('--dangerously-skip-permissions'), unrestricted, 'claude -p')
    const bypass = execSandboxArgs(posture, false).includes('--dangerously-bypass-approvals-and-sandbox')
    assert.equal(bypass, unrestricted, 'codex exec')
  }
})

test('codex exec: a missing sandbox gets no bypass flag, and resume keeps the sandbox', () => {
  const bare = codexExecArgs(context(null))
  assert.ok(!bare.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.deepEqual(bare.slice(bare.indexOf('-s'), bare.indexOf('-s') + 2), ['-s', 'read-only'])
  const resumed = codexExecArgs(context(WS_NEVER, { claudeSessionId: 'sess-1' }))
  assert.deepEqual(resumed.slice(0, 3), ['exec', 'resume', 'sess-1'])
  assert.ok(resumed.includes('sandbox_mode="workspace-write"'))
  assert.ok(resumed.includes('sandbox_workspace_write.network_access=false'))
  assert.ok(!resumed.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.ok(codexExecArgs(context(FULL)).includes('--dangerously-bypass-approvals-and-sandbox'))
})

test('claude -p: a read-only posture allows no network tool', () => {
  const args = claudeP().args(context(DEFAULT_POSTURE))
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Glob,Grep,WebSearch,TodoWrite,Task')
})

test('SDK runtime: on-failure is on-request, and never refuses out-of-bounds calls unasked', async () => {
  const runtime = new NativeClaudeRuntime()
  const buildOptions = Reflect.get(runtime, 'buildOptions') as (
    ...args: unknown[]
  ) => Record<string, any>
  const onFailure = context(null, { approvalPolicy: 'on-failure', sandboxMode: 'workspace-write' })
  assert.equal(buildOptions.call(runtime, {}, onFailure, new AbortController()).permissionMode, 'default')
  const asked: unknown[] = []
  const turns = Reflect.get(runtime, 'turns') as Map<string, unknown>
  turns.set('turn', {
    handlers: {
      onPermissionRequest: async (event: unknown) => {
        asked.push(event)
        return { decision: 'accept' }
      },
    },
  })
  try {
    const signal = new AbortController().signal
    const bounded = buildOptions.call(runtime, {}, context(WS_NEVER), new AbortController())
    assert.deepEqual(await bounded.canUseTool('Bash', { command: 'ls' }, { toolUseID: 't1', signal }), {
      behavior: 'deny',
      message: "blocked by this thread's sandbox (workspace-write, network off, never)",
    })
    const inside = { file_path: join(tree.ctx.cwd, 'a.txt') }
    assert.deepEqual(await bounded.canUseTool('Write', inside, { toolUseID: 't2', signal }), {
      behavior: 'allow',
      updatedInput: inside,
    })
    assert.equal(asked.length, 0, 'neither call reached the app')
    const full = buildOptions.call(runtime, {}, context(FULL), new AbortController())
    assert.deepEqual(await full.canUseTool('Bash', { command: 'ls' }, { toolUseID: 't3', signal }), {
      behavior: 'allow',
    })
  } finally {
    turns.delete('turn')
  }
})
```

Add to `test/posture-wiring.test.mts`:

```ts
test('posture: under never + workspace-write a command outside the sandbox is declined, unasked', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-wiring-'))
  const client = launchAdapter({ CODEX_HOME: home })
  try {
    const start = await client.request('thread/start', {
      cwd: home,
      model: 'sonnet',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    })
    const turn = await client.request('turn/start', {
      threadId: start.result.thread.id,
      input: [text('please run approval bash')],
    })
    await client.waitFor(
      (m) => m.method === 'turn/completed' && m.params?.turn?.id === turn.result.turn.id,
    )
    const methods = client.messages.map((m) => m.method)
    assert.ok(!methods.includes('item/commandExecution/requestApproval'), 'no card under never')
    const ran = client.messages.some(
      (m) =>
        m.method === 'item/commandExecution/outputDelta' && /mock approval/.test(m.params?.delta),
    )
    assert.equal(ran, false, 'the command did not run')
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run build`
Expected: FAIL at compile time: `Module '"../src/codex-proxy-runtime.mjs"' has no exported member 'codexExecArgs'` (and `execSandboxArgs`).

- [ ] **Step 3: Grok**

In `src/grok-acp.mts`, add `import { contextPosture, isUnrestricted } from './posture.mjs'` and replace

```ts
    alwaysApprove:
      context.approvalPolicy === 'never' || context.sandboxMode === 'danger-full-access',
```

with

```ts
    // Only an unrestricted posture drops grok's own asks (spec 5.6, fix 4).
    alwaysApprove: isUnrestricted(contextPosture(context)),
```

- [ ] **Step 4: `claude -p`**

In `src/claude-p-runtime.mts`, add `import { contextPosture, isUnrestricted } from './posture.mjs'`; remove `'WebFetch', ` from `READ_ONLY_TOOLS` (a fetch is network, which a read-only posture does not grant); replace the `if ( this.options.skipPermissions || context.approvalPolicy === 'never' || context.sandboxMode === 'danger-full-access' ) { ... }` block with:

```ts
    // Only an unrestricted posture drops Claude's own prompts (spec 5.6, fix 4);
    // ANYENGINE_CLAUDE_P_SKIP_PERMISSIONS is the operator's explicit opt-in.
    if (this.options.skipPermissions || isUnrestricted(contextPosture(context))) {
      args.push('--dangerously-skip-permissions')
    }
```

and in `allowedToolsForContext`, replace `if (context.sandboxMode === 'read-only') return READ_ONLY_TOOLS.join(',')` with:

```ts
  const posture = contextPosture(context)
  if (posture.plan || posture.fileSystem.kind === 'read-only') return READ_ONLY_TOOLS.join(',')
```

- [ ] **Step 5: The SDK runtime**

In `src/native-runtime.mts`, add:

```ts
import { relayDecision } from './posture-claude.mjs'
import { contextPosture, isUnrestricted } from './posture.mjs'
```

In `buildOptions`, change `const mode = derivePermissionMode(context.approvalPolicy, context.sandboxMode, context.planMode)` to `const mode = derivePermissionMode(contextPosture(context).plan)`, and replace

```ts
      const appFullAccess =
        permissionModeOverride === null &&
        (context.approvalPolicy === 'never' || context.sandboxMode === 'danger-full-access')
      const autoAllow = appFullAccess || mode === 'dontAsk'
      opts.canUseTool = this.makeCanUseTool(context, autoAllow)
```

with

```ts
      const unrestricted = permissionModeOverride === null && isUnrestricted(contextPosture(context))
      opts.canUseTool = this.makeCanUseTool(context, unrestricted || mode === 'dontAsk')
```

In `makeCanUseTool`, directly after `if (autoAllow) return { behavior: 'allow' }`, add:

```ts
      // The posture decides first (the PTY relay's rule, src/posture-claude.mts);
      // only what it would ask about reaches the app.
      const relay = relayDecision(context, toolName, input)
      if (relay.verdict === 'allow') return { behavior: 'allow', updatedInput: input }
      if (relay.verdict === 'deny') return { behavior: 'deny', message: relay.reason }
```

Replace `derivePermissionMode` and its three comment lines with:

```ts
// The SDK's permissionMode: `plan` in plan mode, else `default`, where every
// non-read tool reaches canUseTool and the posture decides it. `on-failure` is
// on-request, never acceptEdits (spec 5.6, fix 6). An env override still wins.
function derivePermissionMode(
  planMode: boolean,
): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto' {
  return configuredPermissionMode() ?? (planMode ? 'plan' : 'default')
}
```

- [ ] **Step 6: The `codex exec` fallback**

In `src/codex-proxy-runtime.mts`, add `import { contextPosture, isUnrestricted, type Posture } from './posture.mjs'`. In `runTurn`, replace the argv comment block and the argv construction (from `// \`codex exec --json\` emits one JSONL event per line. Flags:` through `args.push(context.prompt)`) with:

```ts
      const resumeId = context.claudeSessionId
      const args = codexExecArgs(context)
```

and add at the end of the file:

```ts
// `codex exec --json` argv for one turn: --skip-git-repo-check runs anywhere,
// -m is the model the user picked, -C and --add-dir anchor a fresh session,
// `resume <id>` continues one, and the thread's sandbox comes from
// execSandboxArgs. `codex exec` never prompts, so a posture that would ask
// becomes one that refuses (tighter).
export function codexExecArgs(context: RuntimeTurnContext): string[] {
  const resumeId = context.claudeSessionId
  const args = resumeId
    ? ['exec', 'resume', resumeId, '--json', '--skip-git-repo-check']
    : ['exec', '--json', '--skip-git-repo-check']
  args.push(...execSandboxArgs(contextPosture(context), resumeId !== null))
  if (context.model) args.push('-m', context.model)
  if (!resumeId && context.cwd) args.push('-C', context.cwd)
  if (!resumeId) {
    for (const dir of context.addDirs) args.push('--add-dir', dir)
  }
  args.push(context.prompt)
  return args
}

// Never looser than the thread (spec 5.6, fix 5): the bypass flag only for an
// unrestricted posture, never for an unknown one. `exec resume` takes no `-s`,
// so there the sandbox rides in as config overrides.
export function execSandboxArgs(posture: Posture, resume: boolean): string[] {
  if (isUnrestricted(posture)) return ['--dangerously-bypass-approvals-and-sandbox']
  const fs = posture.fileSystem
  const mode = posture.plan || fs.kind === 'read-only' ? 'read-only' : 'workspace-write'
  const args = resume ? ['-c', `sandbox_mode="${mode}"`] : ['-s', mode]
  if (mode === 'workspace-write') {
    args.push('-c', `sandbox_workspace_write.network_access=${posture.network}`)
    if (fs.kind === 'workspace-write' && fs.writableRoots.length > 0) {
      args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(fs.writableRoots)}`)
    }
  }
  return args
}
```

- [ ] **Step 7: The mock runtime**

In `src/mock-runtime.mts`, add `import { contextPosture, isUnrestricted } from './posture.mjs'` and replace

```ts
      // Mirror the real sidecar: when the Codex App pinned approvalPolicy=never
      // or Full access, skip the permission round-trip and run the tool.
      const autoApprove =
        context.approvalPolicy === 'never' || context.sandboxMode === 'danger-full-access'
```

with

```ts
      // Like the real runtimes: only an unrestricted posture skips the round
      // trip; anything else goes to the server, which decides by posture.
      const autoApprove = isUnrestricted(contextPosture(context))
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/posture-runtimes.test.mjs dist/test/posture-wiring.test.mjs dist/test/grok-runtime.test.mjs dist/test/runtime-config.test.mjs dist/test/adapter.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 9: Size and complexity**

Run: `npx biome check --write src test && node scripts/check-size.mjs && node scripts/check-complexity.mjs`
Expected: `src/native-runtime.mts` lower in `scripts/size-baseline.json`, `File-size ratchet OK`, `Complexity ratchet OK`.

- [ ] **Step 10: Docs, changelog, gates, commit**

In `docs/guide/backends.md`, replace the grok `3. **Approvals.**` item's first sentence (``With `approvalPolicy=never` or `sandbox=danger-full-access` the process runs with `--always-approve`.``) with:

```markdown
3. **Approvals.** Only an unrestricted posture (full access, nothing that
   asks, not planning) runs grok with `--always-approve`; `never` alone does
   not.
```

and change its next clause (`Otherwise grok's ... forwarded to the App for everything else;`) to say that requests the thread's posture refuses are rejected without a card and only what the posture would ask about reaches the App.

In `docs/guide/configuration.md`, replace the `ANYENGINE_PERMISSION_MODE` row and the `ANYENGINE_CLAUDE_P_SKIP_PERMISSIONS` row with:

```markdown
| `ANYENGINE_PERMISSION_MODE` | Overrides the Claude Code permission mode for the `agent-sdk-sidecar` runtime. An explicit operator override: it can loosen what the thread's posture allows. |
```

```markdown
| `ANYENGINE_CLAUDE_P_SKIP_PERMISSIONS` | Pass `--dangerously-skip-permissions` regardless of the thread's posture (an explicit operator opt-in; without it only an unrestricted posture passes the flag). |
```

Add to `CHANGELOG.md` under `### M0: adapter safe`:

```markdown
- **`never` no longer switches off every runtime's approvals.** Grok's
  `--always-approve`, `claude -p`'s `--dangerously-skip-permissions`, the SDK
  runtime's auto-allow and the `codex exec` fallback's bypass flag now apply
  only to an unrestricted posture (full access, nothing that asks). The
  fallback no longer bypasses the sandbox for an unknown sandbox or on
  `exec resume`, and `on-failure` maps to on-request, not accept-edits.
```

Run: `npm run check && npm run typecheck && npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/grok-acp.mts src/claude-p-runtime.mts src/native-runtime.mts src/codex-proxy-runtime.mts \
  src/mock-runtime.mts scripts/size-baseline.json scripts/complexity-baseline.json \
  test/posture-runtimes.test.mts test/posture-wiring.test.mts docs/guide/backends.md \
  docs/guide/configuration.md CHANGELOG.md
git commit -m "fix: only an unrestricted posture drops a runtime's own approvals"
```

---
### Task 12: A daemon without a native codex child never owns the control socket

A plain `codex` TUI auto-attaches to `$CODEX_HOME/app-server-control/app-server-control.sock` when something listens there (codex-rs `maybe_probe_default_daemon_socket`, 50 ms probe). The SSH/Remote twin runs the adapter as that daemon with `ANYENGINE_REMOTE_NATIVE_CODEX` unset, meaning no codex child, so every attaching TUI's GPT turns would run through the `codex exec` fallback. After this task the adapter refuses that socket without a codex child, and the shim hands it to the bundled codex unless `ANYENGINE_REMOTE_NATIVE_CODEX=1`.

**Files:**
- Modify: `src/adapter.mts:1-25` (imports), `:89-96` (`main`), add `ownsControlSocketWithoutNativeCodex` and `CONTROL_SOCKET_REFUSAL`
- Modify: `scripts/codex-shim` (daemon branch)
- Modify: `test/shim.test.mts` (four tests)
- Modify: `scripts/acceptance-local-remote.mjs:37-44`, `scripts/acceptance-gui-ssh-localhost.mjs:236-251`
- Modify: `docs/guide/configuration.md` (Daemon section, reference row), `scripts/AGENTS.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `resolve_bundled_codex` (Task 2), `resolveNativeCodexBinary` and `codexExecRouteEnabled` (existing).
- Produces: adapter exit status `78` with `[anyengine] refusing the app-server control socket: ...` on stderr; shim stderr line `codex shim: the control socket needs a native codex child; ...`.

- [ ] **Step 1: Write the failing tests**

Add to `test/shim.test.mts` (add `import { once } from 'node:events'` and `import { existsSync, readFileSync } from 'node:fs'` to its imports):

```ts
const fakeAppServer = resolve('test/fixtures/fake-codex-app-server.mjs')

// A home short enough that its control socket fits sockaddr_un (104 bytes
// on macOS): the guard only applies to that exact path.
async function shortHome(): Promise<string> {
  const dir = await mkdtemp('/tmp/ae-twin-')
  await mkdir(join(dir, 'app-server-control'), { recursive: true })
  return dir
}

function controlSocket(home: string): string {
  return join(home, 'app-server-control', 'app-server-control.sock')
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('twin: a daemon without a native codex child refuses the control socket', async () => {
  const home = await shortHome()
  try {
    const result = spawnSync(process.execPath, [adapter, 'app-server', '--listen', 'unix://'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, CODEX_HOME: home, ANYENGINE_MOCK: '1', NODE_NO_WARNINGS: '1' },
    })
    assert.equal(result.status, 78, result.stderr)
    assert.match(result.stderr, /refusing the app-server control socket/)
    assert.ok(!existsSync(controlSocket(home)))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('twin: a daemon with a native codex child may own the control socket', async () => {
  const home = await shortHome()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: home,
    ANYENGINE_MOCK: '1',
    NODE_NO_WARNINGS: '1',
    ANYENGINE_REAL_CODEX: fakeAppServer,
  }
  delete env.ANYENGINE_NATIVE_CODEX
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'unix://'], {
    stdio: 'ignore',
    env,
  })
  try {
    await waitForPath(controlSocket(home))
  } finally {
    proc.kill('SIGKILL')
    await rm(home, { recursive: true, force: true })
  }
})

test('twin: the shim hands the control socket to the bundled codex, with no fallback marker', async () => {
  const home = await shortHome()
  const stderr: string[] = []
  const proc = spawn(shim, ['app-server', '--listen', 'unix://'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: shimEnv(home, {
      CODEX_HOME: home,
      ANYENGINE_ADAPTER: adapter,
      ANYENGINE_MOCK: '1',
      ANYENGINE_REAL_CODEX: await fakeCodex(home, 'bundled'),
    }),
  })
  proc.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
  try {
    const recorded = JSON.parse(await waitForFile(join(home, 'fake-argv.json')))
    assert.equal(recorded.tag, 'bundled')
    assert.deepEqual(recorded.argv, ['app-server', '--listen', 'unix://'])
    assert.match(stderr.join(''), /the control socket needs a native codex child/)
    await assert.rejects(readFile(join(home, '.anyengine', 'shim-fallback.json')))
  } finally {
    proc.kill('SIGKILL')
    await rm(home, { recursive: true, force: true })
  }
})

test('twin: with ANYENGINE_REMOTE_NATIVE_CODEX=1 the adapter owns the control socket', async () => {
  const home = await shortHome()
  const proc = spawn(shim, ['app-server', '--listen', 'unix://'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: shimEnv(home, {
      CODEX_HOME: home,
      ANYENGINE_ADAPTER: adapter,
      ANYENGINE_MOCK: '1',
      ANYENGINE_REMOTE_NATIVE_CODEX: '1',
      ANYENGINE_REAL_CODEX: fakeAppServer,
    }),
  })
  try {
    const [code] = (await once(proc, 'exit')) as [number | null]
    assert.equal(code, 0)
    assert.ok(existsSync(controlSocket(home)))
    await assert.rejects(readFile(join(home, '.anyengine', 'shim-fallback.json')))
  } finally {
    // The adapter daemon outlives the shim (it is disowned); stop it by pid.
    const pidFile = `${controlSocket(home)}.pid`
    if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
    await rm(home, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/shim.test.mjs`
Expected: FAIL: the first test times out after 20 s with `status: null` (the adapter binds the socket and stays up); the third sees the shim's fallback line and a marker instead of the control-socket line.

- [ ] **Step 3: Guard the socket in the adapter**

In `src/adapter.mts`, change `import { dirname } from 'node:path'` to `import { dirname, join, resolve } from 'node:path'` and add `codexHome` to the `./util.mjs` import. In `main()`, directly after `const isUnixDaemon = listen.startsWith('unix://')`, add:

```ts
  if (isUnixDaemon && ownsControlSocketWithoutNativeCodex(listen)) {
    process.stderr.write(CONTROL_SOCKET_REFUSAL)
    process.exit(78)
  }
```

Add above `ensureSingleUnixDaemon`:

```ts
const CONTROL_SOCKET_REFUSAL =
  '[anyengine] refusing the app-server control socket: plain `codex` TUIs attach to it, and ' +
  'without a native codex child their GPT turns would run through the `codex exec` fallback. ' +
  'Give this daemon a codex child (the shim does with ANYENGINE_REMOTE_NATIVE_CODEX=1) or ' +
  'listen on another socket.\n'

// A plain `codex` TUI attaches to whatever listens on
// $CODEX_HOME/app-server-control/app-server-control.sock, so only a daemon
// with a native codex child may own that path.
function ownsControlSocketWithoutNativeCodex(listen: string): boolean {
  const socketPath = listen === 'unix://' ? defaultSocketPath() : listen.slice('unix://'.length)
  const control = join(codexHome(), 'app-server-control', 'app-server-control.sock')
  if (resolve(socketPath) !== resolve(control)) return false
  return codexExecRouteEnabled() || resolveNativeCodexBinary() === null
}
```

- [ ] **Step 4: Route the socket in the shim**

In `scripts/codex-shim`, in the daemon branch, directly after `[ "$LISTEN" != "unix://" ] && SOCK="${LISTEN#unix://}"`, add:

```bash
      CONTROL_SOCK="${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server-control.sock"
      if [ "$SOCK" = "$CONTROL_SOCK" ] && [ "${ANYENGINE_REMOTE_NATIVE_CODEX:-0}" != "1" ]; then
        # Plain `codex` TUIs attach to this socket, so only a daemon with a
        # native codex child may own it (src/adapter.mts refuses otherwise);
        # the bundled codex serves it. A configuration, not a failure: no marker.
        TWIN_CODEX="$(resolve_bundled_codex || true)"
        [ -n "$TWIN_CODEX" ] || TWIN_CODEX="$REAL_CODEX"
        if [ -n "$TWIN_CODEX" ]; then
          echo "codex shim: the control socket needs a native codex child; serving it with $TWIN_CODEX (ANYENGINE_REMOTE_NATIVE_CODEX=1 keeps the adapter)" >&2
          exec "$TWIN_CODEX" "$@"
        fi
      fi
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/shim.test.mjs dist/test/adapter.test.mjs`
Expected: PASS, `ℹ fail 0` (the existing `remote shim launches daemon and proxy` test uses its own short socket path, not the control socket).

- [ ] **Step 6: Keep the acceptance scripts on the adapter**

In `scripts/acceptance-local-remote.mjs`, add `ANYENGINE_REMOTE_NATIVE_CODEX: '1',` to the `env` object (after `ANYENGINE_ADAPTER: adapter,`).

In `scripts/acceptance-gui-ssh-localhost.mjs`, add near the top `const BUNDLED_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex'`, and in `remoteEnv` add after the `ANYENGINE_NODE` export:

```js
    // The control socket takes a daemon with a native codex child
    // (src/adapter.mts); the app's bundled codex is that child here.
    'export ANYENGINE_REMOTE_NATIVE_CODEX=1',
    `export ANYENGINE_REAL_CODEX=${shQuote(BUNDLED_CODEX)}`,
```

- [ ] **Step 7: Docs, changelog, gates, commit**

In `docs/guide/configuration.md`, add to the `## Daemon` code block:

```bash
# SSH/Remote twin only (read by the shim): give the daemon a native codex child.
# Plain `codex` TUIs attach to the app-server control socket, so a daemon
# without one never owns it; the shim serves that socket with the bundled codex.
export ANYENGINE_REMOTE_NATIVE_CODEX="1"
```

and to the reference table:

```markdown
| `ANYENGINE_REMOTE_NATIVE_CODEX` | Shim only: `1` gives the SSH/Remote twin daemon a native codex child. Without it the app-server control socket goes to the bundled codex, never to an adapter without a child. |
```

In `scripts/AGENTS.md`, append to the `codex-shim` bullet: `A daemon launch on the app-server control socket goes to the bundled codex unless ANYENGINE_REMOTE_NATIVE_CODEX=1: plain codex TUIs attach there.`

Add to `CHANGELOG.md` under `### M0: adapter safe`:

```markdown
- **Plain `codex` TUIs no longer land on a childless adapter.** A daemon
  without a native codex child refuses the app-server control socket that
  TUIs auto-attach to, and the shim serves that socket with the bundled codex
  unless `ANYENGINE_REMOTE_NATIVE_CODEX=1` gives the twin a child.
```

Run: `npm run check && npm run typecheck && npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/adapter.mts scripts/codex-shim test/shim.test.mts scripts/acceptance-local-remote.mjs \
  scripts/acceptance-gui-ssh-localhost.mjs docs/guide/configuration.md scripts/AGENTS.md CHANGELOG.md
git commit -m "fix: keep a daemon without a native codex child off the app-server control socket"
```

---

### Task 13: Flip tooling: a tested rollback and a quiet-period check

The live flip (Task 14) follows the pattern of `docs/evidence/a3-flip.md`: back up every file it touches, write a `ROLLBACK.sh` beside the copies, exercise `ROLLBACK.sh --copy-only` on the real files before changing anything, and restart the app only when no turn is in flight. This task makes both tools repository code with hermetic tests; neither ever runs the restart half in a test.

**Files:**
- Create: `scripts/flip-backup.mjs`
- Create: `scripts/preflip-check.mjs`
- Create: `test/flip-tools.test.mts`
- Modify: `docs/guide/deployment.md` (new section), `scripts/AGENTS.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `node scripts/flip-backup.mjs [--home DIR] [--target PATH ...]` prints the new directory `<home>/.anyengine/rollback-<UTC stamp>/` holding `manifest.json`, one `NN-<name>.bak` per existing target (mode preserved) and an executable `ROLLBACK.sh [--copy-only]`; default targets `~/.zshrc`, `~/bin/codex`, `~/.anyengine/runtime.env`. `node scripts/preflip-check.mjs [--codex-home DIR] [--adapter-home DIR] [--quiet-seconds N]` exits 0 with `preflip-check: quiet ...` or 1 listing what is busy.

- [ ] **Step 1: Write the failing tests**

Create `test/flip-tools.test.mts`:

```ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const flipBackup = resolve('scripts/flip-backup.mjs')
const preflip = resolve('scripts/preflip-check.mjs')
const require = createRequire(import.meta.url)

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

test('flip-backup writes a ROLLBACK.sh whose --copy-only restores every file exactly', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-flip-'))
  try {
    mkdirSync(join(home, 'bin'))
    writeFileSync(join(home, '.zshrc'), 'export A=1\n')
    chmodSync(join(home, '.zshrc'), 0o644)
    writeFileSync(join(home, 'bin', 'codex'), '#!/bin/sh\necho old\n')
    chmodSync(join(home, 'bin', 'codex'), 0o755)
    const made = spawnSync(process.execPath, [flipBackup, '--home', home], { encoding: 'utf8' })
    assert.equal(made.status, 0, made.stderr)
    const dir = made.stdout.trim()
    assert.match(dir, /\.anyengine\/rollback-\d{8}T\d{6}Z$/)
    assert.equal(mode(join(dir, 'ROLLBACK.sh')) & 0o100, 0o100, 'ROLLBACK.sh is executable')

    // The flip: every target changes, and runtime.env appears.
    writeFileSync(join(home, '.zshrc'), 'export A=2\n')
    writeFileSync(join(home, 'bin', 'codex'), '#!/bin/sh\necho new\n')
    chmodSync(join(home, 'bin', 'codex'), 0o700)
    mkdirSync(join(home, '.anyengine'), { recursive: true })
    writeFileSync(join(home, '.anyengine', 'runtime.env'), 'export ANYENGINE_X=1\n')

    // Only ever --copy-only here: without it the script quits and reopens the app.
    const rolled = spawnSync(join(dir, 'ROLLBACK.sh'), ['--copy-only'], { encoding: 'utf8' })
    assert.equal(rolled.status, 0, rolled.stderr)
    assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), 'export A=1\n')
    assert.equal(mode(join(home, '.zshrc')), 0o644)
    assert.equal(readFileSync(join(home, 'bin', 'codex'), 'utf8'), '#!/bin/sh\necho old\n')
    assert.equal(mode(join(home, 'bin', 'codex')), 0o755)
    assert.ok(!existsSync(join(home, '.anyengine', 'runtime.env')), 'a file the flip created is removed')
    assert.match(rolled.stdout, /--copy-only: the app was not restarted/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

function quietCheck(codexHome: string, adapterHome: string) {
  return spawnSync(
    process.execPath,
    [preflip, '--codex-home', codexHome, '--adapter-home', adapterHome, '--quiet-seconds', '120'],
    { encoding: 'utf8' },
  )
}

test('preflip-check refuses while a rollout or the adapter log was just written', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-preflip-'))
  try {
    const codexHome = join(root, 'codex')
    const adapterHome = join(root, 'adapter')
    const day = join(codexHome, 'sessions', '2026', '09', '29')
    mkdirSync(day, { recursive: true })
    mkdirSync(adapterHome, { recursive: true })
    const rollout = join(day, 'rollout-a.jsonl')
    const log = join(adapterHome, 'debug.jsonl')
    writeFileSync(rollout, '{}\n')
    writeFileSync(log, '{}\n')
    const old = new Date(Date.now() - 600_000)
    utimesSync(log, old, old)

    const busy = quietCheck(codexHome, adapterHome)
    assert.equal(busy.status, 1)
    assert.match(busy.stderr, /rollout-a\.jsonl was written \d+s ago/)

    utimesSync(rollout, old, old)
    const quiet = quietCheck(codexHome, adapterHome)
    assert.equal(quiet.status, 0, quiet.stderr)
    assert.match(quiet.stdout, /preflip-check: quiet/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preflip-check refuses while an adapter turn is still in progress', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-preflip-'))
  try {
    const adapterHome = join(root, 'adapter')
    mkdirSync(adapterHome, { recursive: true })
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void
        prepare(sql: string): { run(...values: unknown[]): void }
        close(): void
      }
    }
    const db = new DatabaseSync(join(adapterHome, 'state.sqlite'))
    db.exec('CREATE TABLE turns (id TEXT, thread_id TEXT, status TEXT, started_at INTEGER)')
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO turns VALUES (?, ?, ?, ?)').run('stale', 't', 'inProgress', now - 86_400)
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/flip-tools.test.mjs`
Expected: FAIL, `Cannot find module .../scripts/flip-backup.mjs` and `.../preflip-check.mjs`.

- [ ] **Step 3: Write the backup and rollback generator**

Create `scripts/flip-backup.mjs`:

```js
#!/usr/bin/env node
// Back up every file a live flip touches and write a ROLLBACK.sh beside the
// copies (the pattern of docs/evidence/a3-flip.md). One command restores the
// files and, without --copy-only, quits and reopens ChatGPT.app. Run it
// before the flip, then run `ROLLBACK.sh --copy-only` once and diff: the
// rollback is exercised on the real files before anything changes.
//
// Usage: node scripts/flip-backup.mjs [--home DIR] [--target PATH ...]
//   default targets: ~/.zshrc, ~/bin/codex, ~/.anyengine/runtime.env
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const argv = process.argv.slice(2)
const values = (name) => argv.flatMap((arg, i) => (arg === name && argv[i + 1] ? [argv[i + 1]] : []))
const home = values('--home')[0] ?? homedir()
const named = values('--target')
const targets =
  named.length > 0
    ? named
    : [join(home, '.zshrc'), join(home, 'bin', 'codex'), join(home, '.anyengine', 'runtime.env')]

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const dir = join(home, '.anyengine', `rollback-${stamp}`)
mkdirSync(dir, { recursive: true, mode: 0o700 })

const entries = targets.map((target, index) => {
  if (!existsSync(target)) return { target, backup: null, mode: null }
  const backup = `${String(index).padStart(2, '0')}-${basename(target)}.bak`
  const mode = statSync(target).mode & 0o777
  copyFileSync(target, join(dir, backup))
  chmodSync(join(dir, backup), mode)
  return { target, backup, mode }
})

function sq(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function restoreLine({ target, backup, mode }) {
  if (!backup) {
    return `rm -f ${sq(target)} && echo "[rollback] removed ${target} (the flip created it)"`
  }
  return `install -m ${mode.toString(8)} "$BK/${backup}" ${sq(target)} && echo "[rollback] restored ${target}"`
}

// The restart half, as in docs/evidence/a3-flip.md: quit the app, wait, name
// and then terminate by pid any app-server adapter the quit left orphaned,
// reopen the app.
const RESTART = [
  'echo "[rollback] quitting ChatGPT.app"',
  "osascript -e 'quit app \"ChatGPT\"' || true",
  'for _ in $(seq 1 30); do pgrep -x ChatGPT >/dev/null || break; sleep 1; done',
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

const script = [
  '#!/usr/bin/env bash',
  '# Written by scripts/flip-backup.mjs: restores every file the flip touched.',
  '#   ./ROLLBACK.sh              restore the files, then restart ChatGPT.app',
  '#   ./ROLLBACK.sh --copy-only  restore the files only',
  'set -euo pipefail',
  'BK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"',
  ...entries.map(restoreLine),
  'if [ "${1:-}" = "--copy-only" ]; then',
  '  echo "[rollback] --copy-only: the app was not restarted"',
  '  exit 0',
  'fi',
  ...RESTART,
  '',
].join('\n')

writeFileSync(
  join(dir, 'manifest.json'),
  `${JSON.stringify({ createdAt: new Date().toISOString(), entries }, null, 2)}\n`,
)
writeFileSync(join(dir, 'ROLLBACK.sh'), script, { mode: 0o755 })
console.log(dir)
```

- [ ] **Step 4: Write the quiet-period check**

Create `scripts/preflip-check.mjs`:

```js
#!/usr/bin/env node
// Is it safe to restart ChatGPT.app now? A restart kills in-flight turns
// (spec 5.7: check for an active turn first), so this refuses while any
// sign of one is fresh: a Codex session rollout or the adapter's debug log
// written in the last --quiet-seconds (default 120), or an adapter turn
// still marked inProgress that started in the last six hours (older rows are
// left over from a crash and recovered at the next start).
//
// Usage: node scripts/preflip-check.mjs [--codex-home DIR] [--adapter-home DIR] [--quiet-seconds N]
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const codexHome = option('--codex-home', process.env.CODEX_HOME || join(homedir(), '.codex'))
const adapterHome = option('--adapter-home', process.env.ANYENGINE_HOME || join(codexHome, 'anyengine'))
const quietMs = Number(option('--quiet-seconds', '120')) * 1000
const now = Date.now()

function newestFile(dir, depth) {
  if (depth < 0 || !existsSync(dir)) return null
  let newest = null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const found = entry.isDirectory()
      ? newestFile(full, depth - 1)
      : { path: full, mtimeMs: statSync(full).mtimeMs }
    if (found && (!newest || found.mtimeMs > newest.mtimeMs)) newest = found
  }
  return newest
}

function inProgressTurns(path) {
  if (!existsSync(path)) return 0
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const since = Math.floor(now / 1000) - 6 * 3600
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM turns WHERE status = 'inProgress' AND started_at > ?")
      .get(since)
    return Number(row?.n ?? 0)
  } finally {
    db.close()
  }
}

function fileInfo(path) {
  return existsSync(path) ? { path, mtimeMs: statSync(path).mtimeMs } : null
}

const busy = []
const debugLog = fileInfo(join(adapterHome, 'debug.jsonl'))
for (const file of [newestFile(join(codexHome, 'sessions'), 4), debugLog]) {
  if (file && now - file.mtimeMs < quietMs) {
    busy.push(`${file.path} was written ${Math.round((now - file.mtimeMs) / 1000)}s ago`)
  }
}
const turns = inProgressTurns(join(adapterHome, 'state.sqlite'))
if (turns > 0) busy.push(`${turns} adapter turn${turns === 1 ? ' is' : 's are'} still in progress`)

if (busy.length > 0) {
  console.error(`preflip-check: not quiet; wait, then run again:\n  ${busy.join('\n  ')}`)
  process.exit(1)
}
console.log(`preflip-check: quiet (no Codex or adapter activity in the last ${quietMs / 1000}s)`)
```

(The adapter logs every request to `debug.jsonl`, so its mtime is the adapter's activity clock; `state.sqlite` is not used as one because it is also written when nothing is in flight.)

- [ ] **Step 5: Run the tests to see them pass**

Run: `npm run build && node scripts/test-hermetic.mjs dist/test/flip-tools.test.mjs`
Expected: PASS, `ℹ pass 3`, `ℹ fail 0`.

- [ ] **Step 6: Docs, changelog, gates, commit**

In `docs/guide/deployment.md`, add at the end:

````markdown
## Flipping a live install, with a rollback

```bash
node scripts/flip-backup.mjs            # prints ~/.anyengine/rollback-<stamp>/
~/.anyengine/rollback-<stamp>/ROLLBACK.sh --copy-only   # exercise the rollback first
diff ~/.zshrc ~/.anyengine/rollback-<stamp>/00-.zshrc.bak
node scripts/preflip-check.mjs          # refuses while a turn may be in flight
```

`flip-backup` copies `~/.zshrc`, `~/bin/codex` and `~/.anyengine/runtime.env`
(modes kept) and writes `ROLLBACK.sh`, which restores them (removing any the
flip created) and, without `--copy-only`, quits and reopens ChatGPT.app. Never
drive the interactive `codex` TUI from a script: it can accept a self-update
prompt.
````

In `scripts/AGENTS.md`, add:

```markdown
- `flip-backup.mjs`: backs up the files a live flip touches and writes a
  `ROLLBACK.sh` (`--copy-only` restores files without restarting the app).
- `preflip-check.mjs`: exits 1 while a Codex rollout, the adapter log or an
  in-progress adapter turn shows recent activity; run it before an app restart.
```

Add to `CHANGELOG.md` under `### M0: adapter safe`:

```markdown
- **A live flip has a tested rollback.** `scripts/flip-backup.mjs` backs up
  the shell rc, the shim and `runtime.env` and writes a `ROLLBACK.sh` that can
  be exercised with `--copy-only` before anything changes;
  `scripts/preflip-check.mjs` refuses an app restart while a turn may be in
  flight.
```

Run: `npm run check && npm run typecheck && npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add scripts/flip-backup.mjs scripts/preflip-check.mjs test/flip-tools.test.mts \
  docs/guide/deployment.md scripts/AGENTS.md CHANGELOG.md
git commit -m "feat: add the flip backup with a tested ROLLBACK.sh and a pre-flip quiet check"
```

---
### Task 14a (done): Follow ChatGPT.app 26.928

Attempt 1 of Task 14 (2026-09-30) was rolled back: the quit for the flip installed an app update Sparkle had staged the evening before (26.911 to 26.928), 26.928 moved the bundled codex from `Contents/Resources/codex` to `Contents/Resources/codex-cli/`, the staged `runtime.env.m0` still named the old path, and the adapter ran with no GPT child (`spawn ... ENOENT`), silently. Record: `docs/evidence/m0-flip.md`. Task 14a made the build correct for 26.928 before the retry:

- `src/bundled-codex.mts` is the one rule for which codex runs: `ANYENGINE_REAL_CODEX` while it names an executable file, else the app's own codex in each layout it has shipped (`codex-cli/CodexCLI.app/Contents/MacOS/codex`, the Mach-O the app spawns; `codex-cli/bin/codex`, the wrapper that execs it; `Contents/Resources/codex` for 26.911), else `CODEX_REAL` for the child. A named codex that is gone is skipped, with a line in the app log and a debug event. The shim carries a bash copy; a parity test runs both over every layout.
- `npm run doctor` fails (`bundled codex resolves`) while `ANYENGINE_REAL_CODEX` names a codex that is gone, or a codex child is expected and none resolves.
- The shim runs the app's own codex for every command it passes through, not only for app-server; any other codex (`CODEX_REAL`, the first on PATH) runs only when the app's is missing, loudly (`shim.nonBundledCodex`).
- The pin is `0.159.0` (ChatGPT.app 26.928); the posture schema gate passes unchanged against it. A collaboration mode a later app sends and this build does not know reads as plan, the tightest.
- `scripts/preflip-check.mjs` refuses while an app update is staged, names Sparkle's cache and job from the app's bundle id, and says "cannot tell" about anything it cannot read.
- Task 14 keeps the flip's state in `.anyengine/flip/` (git-ignored), not in shell variables, and Step 11 checks that no codex the app did not ship runs because of the flip.

### Task 14: Live flip with rollback, and acceptance in the app

The last task changes the live machine. Steps 1 to 6 are preparation that nothing live reads yet. **Step 7 stops and asks the human.** Nothing after it runs without an explicit yes. Never start the interactive `codex` TUI in this task (it can accept a self-update prompt): every probe below uses `--version` or `app-server` over stdio.

Attempt 1 was rolled back (Task 14a). This is the retry: the steps below expect ChatGPT.app 26.928.20755 with codex 0.159.0, and Steps 2, 10 and 11 stop if the app changes under the flip.

**Files:**
- Modify: `docs/evidence/m0-flip.md` (Task 14a recorded attempt 1 there)
- Modify: `CHANGELOG.md`
- Live, outside the repository (only after approval in Step 7): `~/.anyengine/runtime.env`, `~/bin/codex`, `~/.zshrc`, a ChatGPT.app restart. Created without approval (nothing reads them until the flip): `~/.anyengine/lib/<version>/`, `~/.anyengine/lib/current`, `~/.anyengine/runtime.env.m0`.

**Interfaces:**
- Consumes: `npm run install:lib`, `scripts/lib-verify.mjs` (Task 3); `npm run doctor` (Tasks 2, 3, 6, 14a); `scripts/sync-codex-compat.mjs --check` (Task 6); `npm run check:posture-schema` (Task 8); `scripts/flip-backup.mjs`, `scripts/preflip-check.mjs` (Tasks 13, 14a); the bundled-codex rule `src/bundled-codex.mts` (Task 14a).
- Produces: the live adapter running from `~/.anyengine/lib/current`, and `docs/evidence/m0-flip.md`.

- [ ] **Step 1: Start from the reviewed tip**

The M0 branch has passed its whole-branch review. In the M0 worktree:

Run: `git status --porcelain && git log --oneline -1`
Expected: no output from `git status`; the tip is the last reviewed commit.

- [ ] **Step 2: Run every gate against the installed app's codex**

Every command below runs from the M0 worktree's root. Shell variables do not survive from one step to the next (an agent runs each command in a fresh shell), so what later steps compare against goes into files under `.anyengine/flip/`, which git ignores, and each step reads it back.

First make sure no app update is waiting to install on the next quit (Sparkle downloads in the background; attempt 1's quit installed one):

Run: `node scripts/preflip-check.mjs`
Expected: `preflip-check: quiet (...)`, including the lines `~/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle: no staged update` (or `: absent`) and `gui/<uid>/com.openai.codex-sparkle-updater: not loaded`. If it says `an app update is staged and would install on restart`, let it install now, with nothing flipped (quit and reopen ChatGPT.app), then restart this task from Step 1. If it reports activity, wait and run it again; if it says `cannot tell`, fix what it names first.

Record the app, its codex and the classifier Steps 10 and 11 use for running codex processes:

```bash
mkdir -p .anyengine/flip
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/ChatGPT.app/Contents/Info.plist > .anyengine/flip/app-version
echo /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex > .anyengine/flip/codex-bin
cat > .anyengine/flip/codex-procs.awk <<'EOF'
# Every running codex, one line each: where it comes from, the executable
# (the path the process runs), then its whole command.
#   app         ChatGPT.app's own codex
#   ssh-remote  nvm's codex serving the SSH host: `app-server proxy`, or the
#               `app-server --listen unix://` daemon (the Remote/SSH setup,
#               which this flip does not change)
#   other       anything else
{
  n = split($1, a, "/"); m = split($2, b, "/")
  if (a[n] == "codex") path = $1
  else if (a[n] == "node" && b[m] == "codex") path = $2
  else next
  if (index(path, "/Applications/ChatGPT.app/") == 1) kind = "app"
  else if (path ~ /\/\.nvm\/versions\/node\// && ($0 ~ / app-server proxy$/ || $0 ~ / app-server --listen unix:\/\/$/)) kind = "ssh-remote"
  else kind = "other"
  print kind, path, $0
}
EOF
cat .anyengine/flip/app-version; "$(cat .anyengine/flip/codex-bin)" --version
```

Expected: `26.928.20755`, then `codex-cli 0.159.0`. `codex-bin` is the first layout of `src/bundled-codex.mts`, the Mach-O the app itself spawns; doctor (Step 5) prints the one the rule picks, and the two must agree. If either line differs, the app has updated since: stop here, run `node scripts/sync-codex-compat.mjs` and `CODEX_REAL=<its codex> npm run check:posture-schema`, map any new posture value (Task 8), land that with a green CI, and restart this task from Step 1.

Run: `npm ci && npm run check && npm run typecheck && npm test && node scripts/sync-codex-compat.mjs --check && CODEX_REAL="$(cat .anyengine/flip/codex-bin)" npm run check:posture-schema && CODEX_REAL="$(cat .anyengine/flip/codex-bin)" npm run check:rust-protocol-fixtures`
Expected: every gate OK, `ℹ fail 0`, seven pin lines ending in `0.159.0`, `Posture schema coverage OK: 38 values and fields, all mapped.`, `Rust protocol fixtures match generated Codex app-server methods using /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`.

- [ ] **Step 3: Install the lib**

Run: `npm run install:lib && node scripts/lib-verify.mjs "$HOME/.anyengine/lib/current"`
Expected: `install-lib: current -> <HOME>/.anyengine/lib/0.1.0-<12-char commit>` and `lib-verify: ... ok`. Nothing points at the lib yet; undoing this step is `rm -rf ~/.anyengine/lib`.

If the machine runs a cleanup job that prunes dependency folders, confirm its scan roots do not include `~/.anyengine` (they must only cover project directories).

- [ ] **Step 4: Stage the new `runtime.env` beside the live one**

Run:

```bash
sed -e 's|^export ANYENGINE_ADAPTER=.*|export ANYENGINE_ADAPTER="$HOME/.anyengine/lib/current/dist/src/adapter.mjs"|' \
    -e '/^export ANYENGINE_COMPAT_VERSION=/d' \
    -e '/^export ANYENGINE_REAL_CODEX=/d' \
    -e '/^export CODEX_REAL=/d' \
    "$HOME/.anyengine/runtime.env" > "$HOME/.anyengine/runtime.env.m0"
diff "$HOME/.anyengine/runtime.env" "$HOME/.anyengine/runtime.env.m0"
```

This overwrites the `runtime.env.m0` left by attempt 1. Expected: the `ANYENGINE_ADAPTER` line now names `$HOME/.anyengine/lib/current/dist/src/adapter.mjs`, and the explicit `ANYENGINE_COMPAT_VERSION`, `ANYENGINE_REAL_CODEX` and `CODEX_REAL` lines are gone (whichever of them the live file has; attempt 2's had all three, an npm-global codex in `CODEX_REAL`). The shim asks the bundled codex for its version, and the shim and the adapter find that codex in whichever layout the installed app ships: a pinned `ANYENGINE_REAL_CODEX` is what broke attempt 1. Then:

Run: `grep -n 'ANYENGINE_REAL_CODEX\|ANYENGINE_NATIVE_CODEX\|CODEX_REAL' "$HOME/.anyengine/runtime.env.m0" || echo no-codex-pins`
Expected: `no-codex-pins` (comment lines that mention a name are fine; no `export` of any of them).

- [ ] **Step 5: Doctor against the staged configuration**

Run: `(set -a; . "$HOME/.anyengine/runtime.env.m0"; set +a; npm run doctor)`
Expected: every line `ok`, including `adapter selfcheck (deep)`, `no shim fallback recorded`, `live adapter runs from a verified lib`, `shim version probe`, `bundled codex resolves: /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` (the same path as `.anyengine/flip/codex-bin`) and `compat pin matches the bundled codex`. Doctor reads the environment it is given, so it must run with the staged file sourced as here. Against attempt 1's `runtime.env.m0` this step now fails with `fail - bundled codex resolves: ANYENGINE_REAL_CODEX=/Applications/ChatGPT.app/Contents/Resources/codex is not an executable file ...`.

- [ ] **Step 6: Probe the installed shim headless, with the app's own argv and an isolated home**

This starts the installed shim exactly as ChatGPT.app 26.928 does, over stdio, with a throwaway `CODEX_HOME`, and asks the adapter's real codex child which MCP servers it registered: the bridge must be there (Task 4). It is also the check attempt 1 lacked: the adapter's debug log must show its codex child spawned from the 26.928 layout.

The shim sources `runtime.env.m0` after the probe sets its throwaway homes, so a home named there would send the probe into the live ones. First:

Run: `grep -nE '^[[:space:]]*(export[[:space:]]+)?(CODEX_HOME|ANYENGINE_HOME|ANYENGINE_DEBUG_LOG)=' "$HOME/.anyengine/runtime.env.m0" || echo no-home-overrides`
Expected: `no-home-overrides`. Any line printed instead: stop, and take it out of `runtime.env.m0` (Step 4) before probing.

Run (one block, one shell):

```bash
export PROBE_HOME="$(mktemp -d)"
node --input-type=module - <<'EOF'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
const home = process.env.PROBE_HOME
const shim = `${process.env.HOME}/.anyengine/lib/current/scripts/codex-shim`
const argv = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled',
  '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true',
  '-c', 'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true']
const child = spawn(shim, argv, {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, CODEX_HOME: home, ANYENGINE_HOME: `${home}/anyengine`,
    ANYENGINE_DEBUG_LOG: `${home}/debug.jsonl`,
    ANYENGINE_RUNTIME_ENV: `${process.env.HOME}/.anyengine/runtime.env.m0` },
})
const pending = new Map()
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line)
  pending.get(message.id)?.(message)
})
const request = (id, method, params) => new Promise((resolve) => {
  pending.set(id, resolve)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
const timer = setTimeout(() => { console.error('probe: timed out'); child.kill('SIGKILL'); process.exit(1) }, 60_000)
const init = await request(1, 'initialize', { clientInfo: { name: 'm0-probe', version: '0' } })
console.log(`probe: userAgent ${init.result?.userAgent}`)
const servers = await request(2, 'mcpServerStatus/list', {})
const names = (servers.result?.data ?? []).map((entry) => entry.name)
console.log(`probe: mcp servers ${JSON.stringify(names)}`)
clearTimeout(timer)
child.kill('SIGTERM')
process.exit(names.includes('anyengine') ? 0 : 1)
EOF
echo "probe exit $?"
LOG="$PROBE_HOME/debug.jsonl"
SPAWNS="$(grep -c '"event":"codex.upstream.spawn"' "$LOG")"
FROM_APP="$(grep -c '"event":"codex.upstream.spawn","binary":"/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"' "$LOG")"
if [ "${SPAWNS:-0}" -ge 1 ] && [ "$FROM_APP" = "$SPAWNS" ] &&
  ! grep -qE '"event":"codex\.upstream\.(spawnError|unavailable|staleRealCodex|missing)"' "$LOG"; then
  echo "upstream-ok ($SPAWNS spawn from the app layout)"
else
  echo "upstream-BAD: spawns=${SPAWNS:-0} from-app=${FROM_APP:-0}"
  grep -E '"event":"codex\.upstream\.' "$LOG" | cut -c1-200
fi
rm -rf "$PROBE_HOME"
```

Expected: `probe: userAgent` naming `0.159.0`, `probe: mcp servers` including `"anyengine"`, `probe exit 0`, then `upstream-ok (<n> spawn from the app layout)`: at least one `codex.upstream.spawn`, every one with `"binary"` `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`, and no `spawnError`, `unavailable`, `staleRealCodex` or `missing` (no spawn line at all is a failure, not a pass). `~/.anyengine/shim-fallback.json` does not exist afterwards (`test ! -e ~/.anyengine/shim-fallback.json && echo no-fallback` prints `no-fallback`).

- [ ] **Step 7: STOP. Ask the human before anything live changes**

Post this, filled in, and wait for an explicit yes:

> Ready to retry the flip of ChatGPT.app's local host (26.928.20755, codex 0.159.0) onto the installed adapter. Gates, doctor and the headless probe are green, the probe's adapter spawned its codex child from the 26.928 layout, and no app update is staged. With your go-ahead I will:
> 1. back up `~/.zshrc`, `~/bin/codex` and `~/.anyengine/runtime.env` with `scripts/flip-backup.mjs` and exercise `ROLLBACK.sh --copy-only` on them first;
> 2. replace `~/.anyengine/runtime.env` with the staged `runtime.env.m0` (the three-line diff from Step 4);
> 3. replace `~/bin/codex` with `~/.anyengine/lib/current/scripts/codex-shim`;
> 4. in `~/.zshrc`, uncomment the three lines of the `CODEX_SHELL`-guarded `CODEX_CLI_PATH` block (the SSH block stays commented);
> 5. run the quiet check (turns and staged updates), then quit and reopen ChatGPT.app;
> 6. check the app came back as the same version, and that the adapter's GPT child is running from the 26.928 layout, before any acceptance prompt.
>
> Rollback at any point: `~/.anyengine/rollback-<stamp>/ROLLBACK.sh` (restores the three files and restarts the app). Go ahead?

Do not continue on silence or on anything but a yes to this exact list.

- [ ] **Step 8: Back up, and prove the rollback on the real files**

Run: `node scripts/flip-backup.mjs | tee .anyengine/flip/rollback-dir && test -x "$(cat .anyengine/flip/rollback-dir)/ROLLBACK.sh" && echo recorded`
Expected: one line, `<HOME>/.anyengine/rollback-<stamp>`, then `recorded`. That directory is the rollback from here on; every later step reads it back from `.anyengine/flip/rollback-dir`.

Run: `RB="$(cat .anyengine/flip/rollback-dir)" && "$RB/ROLLBACK.sh" --copy-only && diff "$RB/00-.zshrc.bak" ~/.zshrc && diff "$RB/01-codex.bak" ~/bin/codex && diff "$RB/02-runtime.env.bak" ~/.anyengine/runtime.env && echo rollback-ok`
Expected: three `[rollback] restored ...` lines, `[rollback] --copy-only: the app was not restarted`, `rollback-ok`.

- [ ] **Step 9: Apply the approved changes**

Run:

```bash
install -m 644 "$HOME/.anyengine/runtime.env.m0" "$HOME/.anyengine/runtime.env"
install -m 755 "$HOME/.anyengine/lib/current/scripts/codex-shim" "$HOME/bin/codex"
```

Edit `~/.zshrc`: in the commented block that sets `CODEX_CLI_PATH` for `CODEX_SHELL`, change

```
# if [[ -n "$CODEX_SHELL" ]]; then
#   export CODEX_CLI_PATH="$HOME/bin/codex"
# fi
```

to

```
if [[ -n "$CODEX_SHELL" ]]; then
  export CODEX_CLI_PATH="$HOME/bin/codex"
fi
```

and nothing else.

Run: `CODEX_SHELL=1 zsh -lic 'print -r -- $CODEX_CLI_PATH' && diff ~/bin/codex ~/.anyengine/lib/current/scripts/codex-shim && echo shim-ok`
Expected: the expanded `~/bin/codex` path, then `shim-ok`.

- [ ] **Step 10: Restart only when quiet**

Run: `node scripts/preflip-check.mjs`
Expected: `preflip-check: quiet (...)`, with `no staged update` (or `absent`) for Sparkle and the updater job `not loaded`. If it reports activity, wait and run it again; never restart over a running turn. If it says `an app update is staged and would install on restart`, do not quit the app: run `"$(cat .anyengine/flip/rollback-dir)/ROLLBACK.sh" --copy-only` (the files go back, the app is not restarted), let the update install with nothing flipped, and restart this task from Step 1. If it says `cannot tell`, stop and fix what it names.

Run: `test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/ChatGPT.app/Contents/Info.plist)" = "$(cat .anyengine/flip/app-version)" && echo same-app`
Expected: `same-app` (the version Step 2 recorded, `26.928.20755`).

Record which codex executables from outside the app already run before the flip (another service's, say); Step 11 tells them apart from anything the flip starts. Only the distinct executable paths are kept: such a service may run one copy or two, or change its flags, and neither is the flip's doing.

Run: `ps -axww -o command= | awk -f .anyengine/flip/codex-procs.awk | awk '$1 == "other" { print $2 }' | sort -u > .anyengine/flip/codex-other-before; cat .anyengine/flip/codex-other-before; echo baseline-recorded`
Expected: zero or more executable paths, then `baseline-recorded`.

Run:

```bash
date -u +%Y-%m-%dT%H:%M:%S.000Z > .anyengine/flip/relaunched-at
osascript -e 'quit app "ChatGPT"'
for _ in $(seq 1 30); do pgrep -x ChatGPT >/dev/null || break; sleep 1; done
open -a /Applications/ChatGPT.app
```

- [ ] **Step 11: Verify the app version, the handshake, the process and the GPT child**

First, the app that came back is the one every check ran against (a quit installs a staged update; attempt 1 relaunched as another version):

Run: `test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/ChatGPT.app/Contents/Info.plist)" = "$(cat .anyengine/flip/app-version)" && "$(cat .anyengine/flip/codex-bin)" --version && echo same-app`
Expected: `codex-cli 0.159.0`, then `same-app`. If the version changed or the codex is gone, stop: nothing after this step has been checked against that app. Report it and ask the human to approve the full rollback, `"$(cat .anyengine/flip/rollback-dir)/ROLLBACK.sh"`; after it, restart this task from Step 1 against the new app.

Run: `LOG="$(ls -t ~/Library/Logs/com.openai.codex/*/*/*/*.log | head -1)" && grep -E 'initialize_handshake_result|executablePath' "$LOG" | tail -4`
Expected: `outcome=success` for the local host, with `executablePath` naming `~/bin/codex`.

Run: `ps -axww -o pid=,command= | grep '[.]anyengine/lib/' | grep ' app-server' | head -3 && test ! -e ~/.anyengine/shim-fallback.json && echo no-fallback`
Expected: one adapter process whose command runs `.anyengine/lib/<version>/dist/src/adapter.mjs ... app-server ...`, then `no-fallback`.

The adapter's GPT child, which attempt 1 never had (it logged `codex.upstream.spawnError ... ENOENT` here and the app said "Sign in to ChatGPT to start a durable thread"). Only events since the relaunch count:

Run:

```bash
node -e '
const [log, since] = process.argv.slice(1)
const app = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
const events = require("node:fs").readFileSync(log, "utf8").split("\n").flatMap((line) => {
  try { return [JSON.parse(line)] } catch { return [] }
}).filter((e) => e.ts >= since && /^codex\.upstream\.(spawn|spawnError|unavailable|staleRealCodex|missing)$/.test(e.event))
for (const e of events) console.log(e.ts, e.event, e.binary ?? e.reason ?? e.message ?? "")
const spawns = events.filter((e) => e.event === "codex.upstream.spawn")
const ok = spawns.length > 0 && spawns.length === events.length && spawns.every((e) => e.binary === app)
console.log(ok ? "gpt-child-ok" : "gpt-child-BAD")
process.exit(ok ? 0 : 1)
' ~/.codex/anyengine/debug.jsonl "$(cat .anyengine/flip/relaunched-at)"
```

Expected: one or more `codex.upstream.spawn /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` lines, none of the other four events, then `gpt-child-ok`. No spawn line at all is `gpt-child-BAD`.

No codex the app did not ship may be running because of the flip. The app hands `~/bin/codex` (the shim) to what it spawns, and the shim runs the app's own codex for every command; it falls back to another codex only loudly (`shim.nonBundledCodex` in the debug log). The SSH host is a separate setup this flip does not change: nvm's codex there runs `app-server proxy` and an `app-server --listen unix://` daemon, which the classifier names `ssh-remote`.

Run:

```bash
ps -axww -o command= | awk -f .anyengine/flip/codex-procs.awk > .anyengine/flip/codex-after
cut -c1-160 .anyengine/flip/codex-after
awk '$1 == "other" { print $2 }' .anyengine/flip/codex-after | sort -u | comm -13 .anyengine/flip/codex-other-before - > .anyengine/flip/codex-other-new
if [ -s .anyengine/flip/codex-other-new ]; then echo FOREIGN-CODEX; cat .anyengine/flip/codex-other-new; else echo no-foreign-codex; fi
grep -c '"event":"shim.nonBundledCodex"' ~/.codex/anyengine/debug.jsonl
```

Expected: `app ...` lines (the adapter's child among them), `ssh-remote ...` lines only for nvm's `app-server proxy` and `app-server --listen unix://`, `other ...` lines only for executables recorded in Step 10 (how many copies, and their flags, may differ), then `no-foreign-codex`, then `0`. `FOREIGN-CODEX` lists each codex executable from outside the app that was not running before the flip; it, or a non-zero count, means something ran a codex the app did not ship: stop and report the lines.

Run: `(set -a; . "$HOME/.anyengine/runtime.env"; set +a; npm run doctor)`
Expected: every line `ok`, as in Step 5.

If any of these fails: stop, report what failed with the log lines, and ask the human for approval to run `"$(cat .anyengine/flip/rollback-dir)/ROLLBACK.sh"`.

- [ ] **Step 12: Acceptance in the app**

Ask the human to run these in ChatGPT.app, in a new thread of a local project, and to report each reply (a screenshot each is welcome):

1. Model **Claude Sonnet**: `Reply with exactly the word PONG` → `PONG`.
2. The default **GPT** model: `Reply with exactly the word PONG` → `PONG`.
3. In a GPT thread: `Use the anyengine tools to spawn 2 sub-agents: 1 on claude sonnet and 1 on gpt. Each replies with exactly the word PONG. Report both answers.` → both children appear as sub-agents and both answer `PONG`.

Verify from the adapter's debug log:

Run: `grep -E '"event":"(bridge\.spawnSubagent|shim\.fallback)"' ~/.codex/anyengine/debug.jsonl | tail -4`
Expected: two `bridge.spawnSubagent` events from the last minutes, one with `"model":"sonnet"` and one with a `gpt-*` model; no `shim.fallback`.

If any of the three fails: stop, report what failed with the log lines, and ask the human for approval to run `"$(cat .anyengine/flip/rollback-dir)/ROLLBACK.sh"` (full: it restores the files and restarts the app). Record the outcome either way.

- [ ] **Step 13: Record the evidence**

Replace the `## Attempt 2` placeholder in `docs/evidence/m0-flip.md` (Task 14a recorded attempt 1 above it) in the style of `docs/evidence/a3-flip.md`, with no personal names or absolute personal paths (write `~`):

```markdown
## Attempt 2

Date: <UTC date and time range>. ChatGPT.app 26.928.20755 (bundled codex
0.159.0 at `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`).
Build: `<commit>`, installed as `~/.anyengine/lib/0.1.0-<commit>` and verified
by `scripts/lib-verify.mjs`.

### What changed

| File | Before | After |
| --- | --- | --- |
| `~/.anyengine/runtime.env` | `ANYENGINE_ADAPTER` named a development checkout; `ANYENGINE_COMPAT_VERSION` pinned an old version; `ANYENGINE_REAL_CODEX` named the 26.911 codex path | `ANYENGINE_ADAPTER` names `~/.anyengine/lib/current/dist/src/adapter.mjs`; the version and the codex come from the app's own layout |
| `~/bin/codex` | the uncommitted 2026-09-15 shim | `scripts/codex-shim` from the installed lib, byte-identical |
| `~/.zshrc` | `CODEX_SHELL`-guarded `CODEX_CLI_PATH` block commented out | the block active; the SSH block still commented |

### Backup and rollback

`~/.anyengine/rollback-<stamp>/` holds the three files and `ROLLBACK.sh`.
`ROLLBACK.sh --copy-only` was run on the unchanged files before the flip and
`diff` found them identical. Rollback: `~/.anyengine/rollback-<stamp>/ROLLBACK.sh`.

### Checks before the flip

<preflip-check (no staged update), gates, doctor (bundled codex line), the headless probe's userAgent, MCP server list and codex.upstream.spawn binary>

### Verification in the app

<app version before and after the relaunch; handshake line; the adapter's codex.upstream.spawn line; the three prompts and their answers; the two bridge.spawnSubagent events>

### Open items

<anything that failed, was deferred or looked wrong>
```

Add to `CHANGELOG.md` under `### M0: adapter safe`:

```markdown
- **Live again.** ChatGPT.app's local host runs the installed, verified
  adapter; Claude, GPT and a mixed Claude + GPT bridge fan-out each answered
  in the app. Record and rollback: `docs/evidence/m0-flip.md`.
```

Run: `rm "$HOME/.anyengine/runtime.env.m0"` (it now equals the live file). Keep `.anyengine/flip/` until the evidence above is written from it, then remove it.

```bash
git add docs/evidence/m0-flip.md CHANGELOG.md
git commit -m "docs: record the M0 live flip, its checks and its rollback"
```

---

## Spec coverage (section 9, M0)

| M0 item | Task |
|---|---|
| Janitor-proof install under `~/.anyengine/lib/<version>/`, shim pointing there, installed-lib integrity in doctor | 3 |
| Committed shim fallback to the vendor-bundled codex, logged loudly | 2 |
| Bridge `-c` after `app-server` when the app passes subcommand `-c` | 4 |
| `thread/list`: empty provider filter means no filter | 5 |
| Compat pin at the bundled codex, and a way to keep it current | 6 |
| Canonical `Posture` type and converters (Codex thread/turn params in, Claude permission mode in, Claude launch out, Codex thread start out) | 7 |
| The seven looseness fixes | 9 (1, 2, 3, 7), 10 (4 in the PTY relay and `requestApproval`), 11 (4 in grok, `claude -p`, SDK, mock; 5; 6) |
| Claude-child enforcement: shell through the real child's `command/exec` with the parent's sandbox, PreToolUse path checks, nothing unbounded without a sandbox | 10 |
| "Never looser" property test over every enumerable parent posture | 7 (Codex to Codex, Codex to Claude, Claude to Codex, unrestricted-only bypass), 11 (every runtime flag) |
| CI fails on an uncovered enum value in the generated Codex schema or the Claude docs fixture | 8 |
| Twin socket guard | 12 |
| Hermetic suite: isolated homes, no real `~/.codex` or `~/.claude`, children killed in `after()` | 1 |
| Live flip with a tested `ROLLBACK.sh`, a pre-flip active-turn check, acceptance in the app | 13, 14 |
