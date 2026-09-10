# Hardening log

A standing pass over the codebase: tests, safe cuts, simplification, and rules
that keep it clean. No product behaviour changes — a cut only lands when it
removes something already dead, and every entry names the proof.

Conventions: "lines" counts `src/` + `scripts/` production lines removed, not
test lines added. Coverage is the `npm run test:coverage` total.

| Date | PR | Topic | Lines removed | Coverage | Risk |
| --- | --- | --- | --- | --- | --- |
| 2026-09-10 | [#6](https://github.com/hristo2612/anyengine/pull/6) | Dead code and dead config | 437 | 81.46 % → 81.86 % | One near-miss, caught and fixed in the same PR |
| 2026-09-10 | [#7](https://github.com/hristo2612/anyengine/pull/7) | Split `server.mts` | 1252 off the baseline | 81.86 % → 81.76 % | Medium — pure moves, verified per commit |
| 2026-09-10 | [#8](https://github.com/hristo2612/anyengine/pull/8) | Tighter rules | — | floor 80 → 80.7 | Low — every gate verified to fail on a planted violation |
| 2026-09-10 | — | Independent review of #6–#8 before merge | — | 81.70 % | Two defects found in #8, fixed before the merge — [review](review-hardening.md) |

## 2026-09-10 — PR #6, dead code and dead config

**Cut.** `readConfigReasoningEffort` in `server-helpers.mts` (already dead on
`main`: imported by `server.mts`, called by nothing; the App's effort dropdown
is served by `configWriteResponse` and `loadPersistedConfig` instead). The
unreachable second `thread/settings/update` arm of the `server.mts`
dispatch switch and its `threadSettingsUpdate` method (67 lines), the orphaned
`scripts/smoke-subagents.mjs` (343 lines — no npm script, no entry in
`scripts/AGENTS.md`, referenced by nothing but itself, never run by CI), two
exports nothing imported (`grokBinaryAvailable`, `enqueueWorkflowTask`), the
leftover `RESERVE_MODEL_IDS` constant from the A4 reserve work, and 16 unused
imports across `src/`, `test/` and `scripts/`.

**Proof it is behaviour-neutral.** The duplicate arm was decided from live
traffic, not preference: a day of `$CODEX_HOME/anyengine/debug.jsonl` holds 19
client calls to `thread/settings/update` in three param shapes, and every one
was answered by the *first* arm (`threadMetadataUpdate`) because the second was
unreachable in the same switch. A new test replays all three shapes and asserts
what the live handler does with each, plus the absence of the
`thread/settings/updated` notification that only the deleted method could send.
The rest of the cuts are reachability facts the type checker and the suite
confirm. 229 → 230 tests, all green.

**One near-miss, worth reading.** Running Biome's `noUnusedImports` fix over
`src/` deleted `import { migratedLegacyEnvNames } from './env-compat.mjs'` from
`adapter.mts`. The binding really was unread — but the *module* was
load-bearing for its side effect: its body copies every legacy
`CLAUDE_CODEX_*` name onto `ANYENGINE_*` before anything else reads
`process.env`. Nothing failed. `tsc` was happy, all 230 tests were green, and
the one-release compatibility promise in the README, `docs/plan.md` and
`scripts/codex-shim` was silently broken, because the only test touching that
code called the function directly with an injected env.

Fixed in this PR: `adapter.mts` carries a side-effect `import
'./env-compat.mjs'` with a comment saying why it must stay one, the misleading
unread `migratedLegacyEnvNames` export is gone, and a new test
("legacy CLAUDE_CODEX_* names still reach a running adapter") spawns a real
adapter with only `CLAUDE_CODEX_MODELS` set and asserts the models reach
`model/list`. Verified the test actually bites: it fails with the import
removed and passes with it restored.

The lesson generalises — **an automated unused-import fix cannot see a
side-effect import.** `src/env-compat.mts` is the only module in `src/` with a
top-level side effect (checked), so the hazard is bounded, but the rule for
this repo is now: an import with no used binding gets a test before it gets
deleted.

**Risky?** No, after the above. The one judgement call is `smoke-subagents.mjs`: it is a working
manual diagnostic, but nothing wires it up and no gate covers it, so it was
rotting. It is one `git revert` away if it is wanted back.

**Found, deliberately not fixed.** On `thread/settings/update` the live handler
reads the string `approvalPolicy` but ignores the `sandboxPolicy` object and
the `permissions` profile the desktop sometimes sends (2 of 19 calls). Making
it read those would change what the app's settings pane does — a product
decision, not a cleanup. The behaviour is now pinned by the test instead, so it
cannot drift silently. See [review-a2.md](review-a2.md).

**Also noted.** `test/adapter.test.mts` "config/read resolves saved provider
loop selection without projecting raw keys" fails when that file is run alone
and passes in the full suite — a test-isolation flake, pre-existing, untouched
here.


## 2026-09-10 — PR #7, splitting `server.mts`

**Moved, in five reviewable commits, pure moves first.** `server.mts` went from
**5133 to 3881 lines** — 1252 off the ratchet baseline — into five modules:

| Module | Lines | What |
| --- | --- | --- |
| `server-workspace.mts` | 606 | `fs/*`, `command/exec*`, `process/*`, the thread shell command, and the cwd-scoped searches (git diff, fuzzy file search) |
| `server-config.mts` | 317 | default model, default effort, the settings-override bag, `config/read`, `model/list`, `config/value/write`, load/persist |
| `server-views.mts` | 296 | the wire mappers: thread, turn and tool-call envelopes |
| `server-plugins.mts` | 94 | marketplace and plugin-share handlers |
| `server-account.mts` | 84 | rate-limit snapshot, conversation summary, token meter |

Each was chosen by measuring what it actually needed from the class, not by
theme. The workspace block referenced exactly four fields; the view mappers
referenced one (`store`, and only to walk subagent ancestry); the plugin
handlers referenced **none** — they had never needed the server at all.

**The 186 is gone.** `runRuntimeTurn`'s `onEvent` was one 670-line closure with
fourteen `event.type` arms and a cognitive complexity of 186 — the worst number
in the codebase and the one `docs/quality.md` quotes. Seven arms are now named
steps in the same scope (`startSubagent`, `finishSubagent`, `openToolItem`,
`closeToolItem`, `renderHookItem`, `appendReasoning`, `appendAgentText`) and
`onEvent` reads as a dispatch table. **186 → 70.** They stay local functions
rather than moving to a module because they close over fifteen values of turn
state; threading those through a module boundary would be worse than the
closure, not better.

**Proof it is behaviour-neutral.** Every commit is a move: bodies are
byte-identical, only the enclosing name changed. `npm run typecheck`,
`npm run check` and the full suite ran green after each one — 231 tests
throughout, no test edited to accommodate a move. Two of the new modules were
already well covered by the existing protocol tests the moment they existed
(`server-views` 92 %, `server-config` 91 %), which is the strongest evidence
the seams landed where behaviour already was.

**Risky?** Medium, and worth naming. This is the module the live app runs.
Mitigation was per-commit verification rather than a single big-bang check, and
the split of `onEvent` — the one commit that is not a pure move — touches the
core turn pipeline. It is covered by the mux and adapter suites end to end, and
the two CLI smokes run before this reaches `dist/`.

**Target missed, honestly.** The brief asked for ≥1500 lines off the baseline;
this is 1252. The remaining big block is `reviewStart` / `threadCompactStart` /
`runCompactTurn` (~250 lines), and it is the one candidate I measured and
**declined**: it reaches into `notify`, `store`, `setThreadStatus`,
`clearActiveTurn`, `activeTurnByThread`, `activePeerByThread`, `runRuntimeTurn`
and `stopped`. Extracting it means passing eight callbacks through a seam,
which trades a big file for a worse abstraction. The 800-line cap now does the
work instead: `server.mts` cannot grow, so the next feature has to carve its
own module.


## 2026-09-10 — PR #8, rules

Five gates became seven, and three existing ones got stricter. Everything here
passes on today's tree *because* of the two PRs before it — that is the order
the work had to happen in.

**New: complexity ratchet** (`scripts/check-complexity.mjs`). Biome warns past
30, but a warning fails nothing, which is exactly how `server.mts` reached 186
without anyone stopping it. The gate freezes two numbers in
`scripts/complexity-baseline.json` — the worst function (**112**) and the count
over the threshold (**15**) — and either may fall but never rise. A fall
rewrites the baseline for the same commit, like the size ratchet; in CI it
never writes, so a stale baseline is an error.

**New: env-docs gate** (`scripts/check-env-docs.mjs`). Fails when `src/**`
reads an `ANYENGINE_*` name with no entry in `docs/guide/configuration.md`.
**37 of the 86 settings were undocumented**; all are now written down, including
a new section for the experimental `agent-http` / `agentapi` / `claude-p`
routes and one for the three names the adapter sets on its own children rather
than reading from you. The checker understands the doc's existing
`` `ANYENGINE_PTY_COLS` / `_ROWS` `` shorthand, so the house style counts as
documentation; four genuinely ambiguous multi-segment rows were spelled out
instead, which reads better anyway.

**Tighter: file-size cap 800 → 500.** 800 was never a principle, just the
length the big modules happened to have. Thirteen files are now grandfathered
at their current length and may only shrink. One of them,
`server-workspace.mts` at 606, is a file PR #7 *added* — it is the fs/process/
search block moved wholesale, and splitting it three ways is the obvious next
job rather than something to hide behind a looser cap.

**Tighter: Biome.** `noUnusedVariables`, `noUnusedImports` and `noUselessElse`
are errors, not warnings — all three are at zero after PR #6. `useAwait` was
considered and rejected: 44 violations, mostly interface conformance
(`async` methods that satisfy a promise-returning signature without awaiting),
so it would be noise rather than a finding.

**Tighter: coverage floor 80 → 80.7**, one point under today's 81.75 %.

**Every gate was verified to fail.** Not just to pass: a planted unused import
plus an undocumented `ANYENGINE_TOTALLY_NEW_KNOB` were added to
`src/run-registry.mts`, `biome check` exited 1 and the env-docs gate named the
knob; both went green again on revert. The complexity ratchet was checked the
same way by lowering its baseline to 100 and watching it name
`native-runtime.mts:497`.


## Flakes seen during this pass (pre-existing, not caused by it)

Both reproduce on unmodified code and are recorded so the next person does not
re-diagnose them as a regression.

- **`unix websocket app-server accepts initialize`** hit the 180 s
  `--test-timeout` backstop on *both* runners in one CI run of
  `harden/server-extract`, and passed on both in the rerun of the same commit.
  The identical tree passed on the branch stacked above it. It binds a unix
  socket, so it is a bind/accept race under load rather than a protocol
  failure — but "failed on both OSes at once" looks convincing enough to send
  someone hunting, hence this note.
- **The whole `node` job fails with every test passing.** Seen on
  `ubuntu-latest` for the docs-only commit that follows this pass: `232 tests,
  232 pass, 0 fail`, then `Warning: Could not report code coverage. Error
  [ERR_OPERATION_FAILED]: failed to parse coverage file
  /tmp/node-coverage-*/coverage-*.json: Expected ',' or '}' after property
  value in JSON at position 524288` and exit 1. Position 524288 is exactly
  512 KiB — a buffer boundary — so this is a **truncated** V8 coverage file,
  not a corrupt one. Cause: `--experimental-test-coverage` puts
  `NODE_V8_COVERAGE` in the environment, every adapter the suite spawns
  inherits it and writes its own coverage file, and the `after()` sweep that
  keeps a lingering child from wedging the run SIGKILLs them — a killed process
  never flushes its last write. The identical tree passed on the commit before
  and on the rerun, which is what makes it look like a mystery. The real fix is
  a SIGTERM-then-wait-then-SIGKILL teardown, or `NODE_V8_COVERAGE` scrubbed
  from the environment handed to spawned adapters; the second is smaller and
  loses nothing, since it is the parent's coverage the floor is measured on.
- **`remote shim launches daemon and proxy with Codex-compatible commands`**
  hit the same 180 s backstop on `node (macos-latest)` during the merge of
  #7 into `main`, with `ubuntu-latest` green in the same run and the identical
  tree green locally twice. It passed on a rerun of the same commit. Third
  sighting of the same family: a macOS-only wait that the backstop bounds
  rather than a protocol failure.
- **`config/read resolves saved provider loop selection without projecting raw
  keys`** fails when `dist/test/adapter.test.mjs` is run *alone* and passes in
  the full suite: a test-isolation dependency, not a timing one.

**The pattern matters more than any one of them.** Over the merges and the two
docs commits that closed this pass, `node (ubuntu-latest)` went red three times
and passed on the rerun every time, with three different symptoms — a 180 s
backstop, a truncated coverage file, and three `codex-mux` mid-thread-switch
tests reporting `timed out waiting for message` from their own internal waits.
Twice the tree was byte-identical to one that had just passed. So the suite is
not flaky in one place; it is **timing-sensitive under runner load** in several,
and the mid-thread-switch tests in particular drive a fake child through a
multi-step handover on waits that are tight for a loaded shared runner. Worth a
real fix — longer internal waits, and the `NODE_V8_COVERAGE` scrub above —
rather than a standing habit of pressing rerun.

**Fixed for the mid-thread-switch tests.** `test/codex-mux.test.mts`'s
`waitFor` (and `accountRead`) defaulted to a 10 s internal wait. That is not a
correctness bound — `--test-timeout=180000` already stops a hung test from
hanging the file — it was just short enough to lose a race with a busy runner
mid-handover. Raised to 60 s: still fails well before the backstop, no longer
fails because the runner was busy. The suite runs in 18 s locally, so the
higher ceiling costs nothing when things are healthy. The `NODE_V8_COVERAGE`
scrub above is still open.

Neither was touched here. Both are worth a real fix — the first is the kind of
race the 180 s backstop was added to bound, and an unbounded socket wait is
exactly what [review-a2.md](review-a2.md) already fixed once for
`JsonLineReader`.

## CI note for the stacked PRs

`.github/workflows/ci.yml` triggers on `pull_request` into `main` only, so
stacked PRs (#7 → #6, #8 → #7) show no checks until their base merges and
GitHub retargets them. Both were run manually with `workflow_dispatch` instead
and their `node` and `cargo` jobs are green.

`workflow_dispatch` also makes the `gitleaks` job scan **full history** rather
than the PR diff, which surfaces the four known upstream false positives
already documented in [review-a2.md](review-a2.md) — `secret123456789` used as
a literal fake token in the base commit's own tests, and the RFC 6455 sample
handshake key. On a real PR into `main` gitleaks scans the diff and passes,
which is what #6 did. No new secret was introduced by any of this work.

## 2026-09-10 — independent review before the merge

All three PRs were reviewed by someone who did not write them, then merged.
The full write-up is [review-hardening.md](review-hardening.md); the summary is
that #6 and #7 are behaviour-neutral as claimed — the move commits were checked
mechanically, statement by statement, and the `onEvent` split preserves control
flow because every extracted step is called as `await step(event)` followed by
`return` — and that #8 carried two defects, both fixed on its own branch:

1. **The unused-import error ate a module's documentation.** Biome's autofix
   removed the leftover `nicknameFor` import from `src/server-views.mts`, and
   with it the eight-line header comment sitting above it. This is the second
   instance of PR #6's own lesson: an automated import fix cannot see what is
   attached to an import. There the casualty was a side effect; here it was the
   only explanation of what the module is.
2. **The env-docs gate was satisfied by a false entry.**
   `ANYENGINE_SUBAGENT_COMPLETED` was documented as a marker the adapter sets
   on a sub-agent process. It is nothing of the kind: it is read as a tri-state
   override of the client's `initialize` capability and switches the whole
   sub-agent presentation. A wrong row is worse than a missing one, because the
   gate then stops asking. Corrected, moved into the settings table, and the
   previously untested `0` direction is now pinned by a test that was confirmed
   to fail without the branch it covers.

**A third defect, found by the review rather than in it.** The pre-push hook
from #5 ran the gates with git's own hook environment still set, so five tests
that build throwaway git repositories operated on this repository instead of
their fixtures and failed on every `git push` while passing in a shell
(`dist/test/worktree.test.mjs`: 3/3 green, 2/3 with `GIT_DIR` exported). A gate
that fails on correct code teaches people to bypass it. The hook now unsets
`GIT_DIR` and its siblings first.
