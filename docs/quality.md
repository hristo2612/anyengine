# Quality gates

Seven small gates, all of them scripts you can read. The worry they answer:
generated code drifts into an over-engineered mess long before anyone notices.
Each gate freezes one axis of that drift at today's value.

Run them the way CI does:

```bash
npm run typecheck
npm run check      # biome + size ratchet + dependency guard
npm test           # build + node --test + coverage floor
```

The full Node suite runs on macOS, including the sandboxed Codex schema probes,
launchd installation and BSD shell recovery checks. Portable Rust protocol tests
run on both macOS and Linux. The Node job has a 30-minute budget for hosted Macs.

`scripts/setup-hooks.sh` wires the same set into a `pre-push` hook (plus
`gitleaks protect --staged`). No husky, no lint-staged — one `core.hooksPath`
setting.

## 1. Coverage floor

`npm test` is `npm run test:coverage`: the Node 24 built-in runner with
`--experimental-test-coverage`, scoped to `dist/src/**`, and
`--test-coverage-lines=80`. No extra dependency, and the same runner that
already runs the suite.

Line coverage on 2026-09-10 was **81.75 %** over 52 modules, so the floor sits
one point under it at **80.7**. Below it the run exits non-zero and CI is red.
Raise the floor when the real number rises; do not lower it.

The thinnest modules today are `codex-proxy-runtime.mjs` (8.78 %, only reached
through a live Codex child), `transports.mjs` (50.50 %) and
`native-runtime.mjs` (57.94 %).

## 2. File-size ratchet

`scripts/check-size.mjs`. Every `src/**/*.mts` file is capped at **800 lines**.
The six modules already over the cap are frozen at their current length in
`scripts/size-baseline.json`:

| Module | Lines |
| --- | --- |
| `src/server.mts` | 5133 |
| `src/native-runtime.mts` | 1462 |
| `src/anyengine-runtime.mts` | 1414 |
| `src/codex-mux.mts` | 1207 |
| `src/server-helpers.mts` | 1106 |
| `src/bridge-control.mts` | 927 |

They may shrink, never grow. A shrink rewrites the baseline automatically and
the smaller number is committed with the change; drop under 800 and the file
leaves the baseline for good. In CI the script never writes — a stale baseline
fails, so the update lands in the commit that caused it.

The point is not the number 800. It is that the big modules stop absorbing new
code: to add behaviour to `src/server.mts`, extract a module first.

## 3. Complexity warnings

Biome's `complexity` group is on at recommended, with
`noExcessiveCognitiveComplexity` as a **warning** at a threshold of **30**
(Biome's default is 15). Warnings do not fail `npm run check`; they surface hot
spots so review can push back.

There are **15** today, the worst being a cognitive complexity of 112 in
`src/native-runtime.mts`. `server.mts`'s 186 is gone: `runRuntimeTurn`'s event
handler was split into named steps and now sits at 70.

Because a warning fails nothing, the numbers used to drift — which is how 186
happened. `scripts/check-complexity.mjs` now freezes both of them in
`scripts/complexity-baseline.json`: the worst function may never get worse, and
the count of hot spots may never grow. Either may fall, and a fall rewrites the
baseline for the same commit, exactly like the size ratchet.

## 4. Dependency guard

`scripts/check-deps.mjs` compares the `dependencies` block of `package.json`
against `scripts/deps-baseline.json` and fails on any difference. Adding a
runtime dependency therefore takes a deliberate second step:

```bash
node scripts/check-deps.mjs --update
```

Commit the baseline with a one-line justification. `devDependencies` are not
guarded — they never reach a user's machine.

## 5. Environment-variable docs

`scripts/check-env-docs.mjs` fails when `src/**` reads an `ANYENGINE_*` name
that has no entry in [configuration](guide/configuration.md). Undocumented
settings are how a codebase grows knobs nobody can find; there are **86** today
and all of them are written down. Names read only by the smoke and acceptance
scripts are fixtures, not configuration, and are out of scope.

## 6. Secrets

`gitleaks protect --staged` runs in the pre-push hook (install it with
`brew install gitleaks`), and `gitleaks/gitleaks-action@v2` scans full history
on every CI run.
CI pins Gitleaks 8.30.1, which supports the repository's global `[[allowlists]]`
format; older scanner versions can flag the RFC 6455 example WebSocket key.

## 7. Hermetic tests

`npm test` runs every suite through `scripts/test-hermetic.mjs`: HOME,
CODEX_HOME, CLAUDE_CONFIG_DIR and ANYENGINE_DEBUG_LOG point into one
throwaway directory, inherited `ANYENGINE_*`, `CODEX_*`, `CLAUDE_*`,
`ANTHROPIC_*`, `OPENAI_*`, `GROK_*` and `GIT_*` settings are dropped, and PATH
holds only the running node and the system directories, so no real `codex`,
`claude` or `grok` can be found. SHELL defaults to `/bin/zsh` for the fixture
homes; other-shell cases override it explicitly. `test/hermetic.test.mts` fails
any run that is not set up this way. A test run once wrote into the live debug
log; this is the gate that stops it happening again.

The runner also points TMPDIR into the throwaway directory and fails a run
that leaves anything there, or that adds `anyengine-*` entries to the real temp
directory: make temp directories with `tempDir()` from `test/helpers/tmp.mts`
and register `after(removeTempDirs)` (after `killChildren` where the suite
spawns children). When the temp directory is too long for the unix sockets
suites bind inside TMPDIR (macOS's per-user one is), the root goes under
`/tmp`; strays are still looked for in the real temp directory. Before it
looks, the runner sweeps the bridge sockets of adapters that are no longer
running, as the next adapter to start would. Runs may overlap: another run's
`anyengine-hermetic-*` root is not a stray. Other tools that write
`anyengine-*` entries into the same temp directory while a run is going
(`npm run check:posture-schema`, the smokes, an adapter's claude-p runtime on
the default TMPDIR) can still fail it; run them apart, or rerun.

## 8. Posture schema coverage

`npm run check:posture-schema` (CI, after the build) generates the app-server
JSON schema with the pinned codex and fails when an approval policy, granular
approval flag, sandbox mode, sandbox policy variant or field, reviewer,
external network mode or collaboration mode is one `src/posture.mts` does not
map, or when `test/fixtures/claude-permission-modes.json` lists a Claude mode
it does not convert. Bumping the pin (`scripts/sync-codex-compat.mjs`) runs
this against the new schema on the next CI run.

## Synchronous config coordination

`withFileLock` holds a built-in `node:sqlite` `BEGIN IMMEDIATE` transaction
across legacy marker recovery, the short synchronous callback and marker
release. Acquisition shares one monotonic `waitMs` deadline (10 seconds by
default); database errors fail closed. A live transaction is never stolen
because its marker exceeds `staleMs`. Exit or crash releases SQLite's lock;
the next caller recovers dead main and takeover markers. PID/token and
identity checks remain for legacy observers and replacements.

`config.json.lock.sqlite` intentionally persists at the same inode. The gate
stores no rows or schema and stays zero bytes; normal rollback and close leave
no journal. Tests check its bounded size, stable inode and reacquisition while
rejecting leftover main/takeover markers, asides, temporary writes and journals.
Invalid config sets are validated before coordination setup and create no gate.
The coordination database is opaque storage, and SQLite owns all its handles.
Ordinary reads, copies or hashes that open and close it in an owning process
can cancel POSIX locks held by that process's SQLite connections. Callers must
exclude it from such file operations while their transactions are active.

All published M1 builds use this gate. Initial activation must drain work from
older builds, which only use PID markers and cannot participate in SQLite
coordination. Active legacy markers are respected until their existing stale
policy permits recovery; concurrent old binaries are outside the exclusion
guarantee. Node-free recovery, backups and layer restoration must preserve the
database and any journal/WAL sidecars, excluding them from mutation while an
owner or waiter might exist. Never unlink, rename, truncate or restore them in
that state. Let the next Node caller recover SQLite; no separate `sqlite3`
executable is required. Offline cleanup requires every
participant to have stopped. This helper remains synchronous; async flip work
uses its separate protocol.

## What these gates do not do

They do not check that the adapter actually works. Protocol and runtime changes
still need a real-app run: the `npm run smoke:*` scripts against the real CLIs,
and screenshots plus a mechanism/rollback note in `docs/evidence/` for anything
the desktop app can see. See [CONTRIBUTING.md](../CONTRIBUTING.md).
