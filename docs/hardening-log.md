# Hardening log

A standing pass over the codebase: tests, safe cuts, simplification, and rules
that keep it clean. No product behaviour changes — a cut only lands when it
removes something already dead, and every entry names the proof.

Conventions: "lines" counts `src/` + `scripts/` production lines removed, not
test lines added. Coverage is the `npm run test:coverage` total.

| Date | PR | Topic | Lines removed | Coverage | Risk |
| --- | --- | --- | --- | --- | --- |
| 2026-09-10 | #1 | Dead code and dead config | 424 | 81.46 % → 81.70 % | Low |

## 2026-09-10 — PR #1, dead code and dead config

**Cut.** The unreachable second `thread/settings/update` arm of the `server.mts`
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

**Risky?** No. The one judgement call is `smoke-subagents.mjs`: it is a working
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
