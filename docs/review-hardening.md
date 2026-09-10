# Review — the hardening stack (#6, #7, #8)

Independent review of the three stacked hardening PRs, by someone who did not
write them. Read on 2026-09-10, before any of them was merged.

The question each PR had to answer is the same: **does anything behave
differently?** A cut, a move and a rule are all supposed to be invisible from
the outside, so the review looked for behaviour hiding inside them — bodies
edited during an extraction, defaults changed, error paths dropped, event names
renamed, environment reads lost.

Method, beyond reading the diffs: every "move" commit was checked mechanically.
Removed and added lines were normalised (whitespace collapsed, `this.`
stripped) and compared as multisets, so any statement that entered or left the
codebase during a move shows up as a residue instead of hiding in 1200 lines of
diff. The residues are quoted below where they mattered.

## PR #6 — dead code and dead config

**Verdict: correct, merge.** Everything it removes is provably unreachable.

- The headline cut is sound. Both `thread/settings/update` arms are in the same
  `switch`, so the second one could never run; the first-match rule makes the
  deletion a no-op by construction, independent of the traffic argument the PR
  makes. The traffic evidence is still the right way to have chosen *which* arm
  to keep.
- Every other cut was re-checked against `main` rather than taken on trust.
  `readConfigReasoningEffort`, `grokBinaryAvailable`, `enqueueWorkflowTask` and
  `RESERVE_MODEL_IDS` each have exactly one definition and no caller;
  the removed imports in `server.mts` each had exactly one occurrence, the
  import line itself. `chmodSync`, `dirname` and `statSync` are unused in the
  two `.mjs` scripts they were dropped from.
- The `env-compat.mjs` near-miss is handled the right way round: the module is
  now a side-effect import with a comment saying why, and the new test spawns a
  real adapter with only `CLAUDE_CODEX_MODELS` set. That is the only form of
  the test that would have caught the original bug.

*Concern (fixed here, cosmetic):* the CHANGELOG entry carried a duplicated,
half-rewritten sentence — one line claimed "16 unused imports" twice and lost
the `readConfigReasoningEffort` mention in between. Rewritten.
`docs/hardening-log.md` also headed its section "PR #1" for what is PR #6.

## PR #7 — five modules out of `server.mts`

**Verdict: a faithful move, merge.** This is the PR with the most room for a
hidden behaviour change, and it does not contain one.

- Each of the five extraction commits was checked with the residue method. The
  leftovers are exactly the wrapper and signature lines the move needs — old
  `private fsReadFile(...)` out, new `async fsReadFile(...)` in, plus the
  delegating one-liner in `server.mts`. No statement changed.
- The two functions that touch state outside the process were read line by
  line rather than trusted to the residue: `ServerConfig.load` / `persist` are
  byte-equivalent to `loadPersistedConfig` / `persistConfig`, including the
  `0o600` mode, the repair-on-normalise path and the swallowed `catch {}`; and
  `TokenUsageTracker.record` keeps the `totalTokens === 0` early exit in the
  same position, so an empty turn still cannot blank the App's meter.
- The one non-move commit, splitting the 670-line `onEvent`, is the one that
  could have gone wrong quietly, because a `return` that used to exit the whole
  handler now only exits an extracted step. It does not: **every call site is
  `await step(event)` immediately followed by `return`**, and the list of
  `event.type` arms is identical to `main`'s. The arm order is unchanged too,
  which matters — a sub-agent `tool_use` must be claimed by the sub-agent arm
  before the generic `tool_use` arm sees it.
- One harmless ordering change worth naming: `threadShellCommand` now looks the
  thread up *after* the empty-command guard instead of before. `getThread` is a
  read, so nothing observable moves.

*Nothing reserve-, rehome- or MCP-related is touched.* `src/reserve.mts`,
`src/rehome.mts`, `src/codex-upstream.mts`, `src/mcp.mts` and
`src/codex-plugins.mts` are byte-identical to `main` across the whole stack;
`threadMetadataUpdate` and `rehomeThread` are byte-identical across PR #7; and
the single `withCodexPluginMcpServers` call site is unchanged. The only edit to
`codex-mux.mts` in the whole stack is PR #6 deleting the unreferenced
`RESERVE_MODEL_IDS` constant.

## PR #8 — two new gates, three tightened

**Verdict: sound, merge — after the two fixes below.** The gates were each
verified to fail as well as pass, which is the part that usually gets skipped.

*Concern 1 (fixed here).* Making `noUnusedImports` an error had a side effect
the PR did not notice. Biome's autofix removed a genuinely unused
`nicknameFor` import from `src/server-views.mts` — correctly; the symbol is
still used in `server.mts` and was only ever a copy-paste leftover from the
extraction — but it took the module's eight-line header comment with it,
because the comment sat directly above the import. `server-views.mts` was the
only one of the five new modules left with no explanation of what it is. The
comment is restored.

This is the same failure mode PR #6 wrote up as its lesson: **an automated
import fix cannot see what is attached to an import.** There it was a
side-effect; here it was documentation. Worth keeping in the log as the second
instance rather than a one-off.

*Concern 2 (fixed here, with a test).* The env-docs gate is only as good as
the entries that satisfy it, and one of the 37 new rows is wrong.
`ANYENGINE_SUBAGENT_COMPLETED` was filed under "Set by the adapter, not by you"
and described as "a marker the adapter sets on a sub-agent process once its
result has been consumed". The adapter never sets it. It is read, in two
places, as a tri-state override of the client's `initialize` capability, and it
switches the whole sub-agent presentation: with it on, a child gets
`subAgentActivity` `started` / `completed` markers; with it off, none of them
bar `interrupted`, and a failed or orphaned child is closed with a synthetic
`closeAgent` instead. A gate satisfied by a false entry is worse than one
failing on a missing entry, because it retires the question. The row is
corrected and moved into the settings table.

The `0` direction had no test — only `1` was exercised, by the lifecycle test
and two smokes — so the documented behaviour is now pinned by
`test/adapter.test.mts` ("ANYENGINE_SUBAGENT_COMPLETED=0 forces the legacy
sub-agent presentation…"). Confirmed to bite: deleting the `'0'` branch from
`supportsCompletedSubagentActivity` fails it, restoring it passes.

*Cosmetic (fixed here).* The 800 → 500 rewrite of `scripts/check-size.mjs` left
its old rule bullets stranded below the new prose paragraph, so the header
listed the shrink rule twice. Reflowed.

*Noted, not blocking.* `check-env-docs.mjs` expands the doc's `` `_ROWS` ``
shorthand against the previous full name on the line, and also adds a bare
`ANYENGINE` + suffix spelling. That second form can mark a name documented that
nobody wrote down. It is a small loosening of a gate that is otherwise strict,
and no current name relies on it.

## Found while reviewing: the pre-push hook poisons its own gates

Not from this stack — the hook landed in #5 — but it surfaced while pushing
this review, and it is the same class of bug the stack exists to catch.

`git` exports its repository pointers (`GIT_DIR`, `GIT_INDEX_FILE`,
`GIT_WORK_TREE`, …) into every hook process. `scripts/hooks/pre-push` ran the
suite with them still set, so any test that builds a throwaway git repository
in a temp directory inherited them and operated on *this* repository instead of
its own fixture. Five tests fail that way under `git push` and pass in a normal
shell:

```
file change approval emits patch and git diff updates
gitDiffToRemote includes untracked files for Codex diff review
optional auto worktree binds new threads to isolated git worktrees
auto worktree creates and then reuses an existing per-thread worktree
bridge: spawn_subagents fans out under the calling thread across engines
```

Reproduced directly: `dist/test/worktree.test.mjs` is 3/3 green, and 2/3 with
`GIT_DIR` exported. A gate that fails on correct code is worse than no gate,
because the next person reads five red tests as their own regression and
reaches for `--no-verify`. The hook now unsets those names before running
anything.

The leak is not only noisy, it writes. Reproducing it here — one suite run
with `GIT_DIR` exported — left a fixture's `init` commit message in this
repository's `COMMIT_EDITMSG`, and the next `git commit` picked it up as a
stray commit authored by the fixture's `Test <test@example.com>`. A test that
can commit into the repository it is being pushed from is worth the six-line
fix.

## What was verified, and what that does not cover

Gates and suite on `harden/rules` with a throwaway `CODEX_HOME`: typecheck
clean; `npm run check` green (52 files, cap 500, 13 grandfathered; complexity
worst 112 over 15 hot spots; 4 runtime dependencies; 86 documented settings);
231 tests passing at 81.70 % lines against the new 80.7 floor; and the three
smokes — `smoke:anyengine`, `smoke:grok`, `smoke:bridge` — green against the
real `claude` and `grok` CLIs.

None of that proves the desktop still works, which is why the stack was also
driven through ChatGPT.app after deployment. See `docs/STATUS.md` for the
deploy record and the screenshots.
