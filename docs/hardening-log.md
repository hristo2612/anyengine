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

## 2026-09-10 — PR #1, dead code and dead config

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
