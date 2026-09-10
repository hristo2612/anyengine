# Review A2 — independent review before publication

Reviewer: fresh session, no part in building the rebrand. Date: 2026-09-10.
Scope: licensing and provenance, the scrub, the compatibility shim, and the two
problems blocking CI.

## Verdicts

| # | Check | Verdict |
| --- | --- | --- |
| 1 | LICENSE | **Pass** — MIT text intact, both copyright lines present (the fork owner and fuergaosi233). |
| 2 | Base commit vs upstream | **Pass — identical.** The base commit's tree is `62772be…`, byte-identical to the tree of `30dd109412cc8a29e8e3c2605caf728b6844aa32` in `fuergaosi233/claude-codex`, the sha named in that commit's message. `git diff` between them is empty. |
| 3 | Personal / machine identifiers | **Pass.** The tracked tree matches only justified hits: the CHANGELOG and `docs/plan.md` naming the old `jinn-pty` route value (which upgraders must edit), and the LICENSE copyright line. Full history (`git log -p --all`) contains no machine home path; the only `/users/…` strings are the fictional `/users/tester` fixture. |
| 4 | `gitleaks detect --log-opts=--all` | **Pass with named false positives.** 4 findings, all in the upstream base commit's own tests: `secret123456789` used three times as a literal fake token (`test/run-registry.test.mts`, `test/adapter.test.mts`) and the RFC 6455 sample handshake key `dGhlIHNhbXBsZSBub25jZQ==`. No real credential. |
| 5 | Compatibility shim | **Pass, verified by running it.** |

## Compatibility shim (`src/env-compat.mts`, `scripts/codex-shim`, `scripts/anyengine-mode`)

The rule holds in both twins: each `CLAUDE_CODEX_X` is copied onto
`ANYENGINE_X` only when the new name is unset, and the legacy variable is never
removed. Exercised with a fake adapter: with `CLAUDE_CODEX_FOO=legacy`,
`CLAUDE_CODEX_BAR=legacybar` and `ANYENGINE_BAR=new` in the environment, the
adapter saw `ANYENGINE_FOO=legacy`, `ANYENGINE_BAR=new` and both legacy names
still set.

Argument handling was exercised against the desktop app's real argv shape,
`codex -c features.code_mode_host=true app-server …`:

- the leading `-c` global is split off, `app-server` is matched behind it, and
  the same globals are replayed verbatim to the adapter;
- `--version` still answers behind leading globals;
- the `unix://` daemon path backgrounds the adapter, polls for the socket and
  returns as soon as it appears (measured: 947 ms with a fake adapter that
  binds after 700 ms), so the App's SSH bootstrap does not hang.

One rough edge, fixed here: when the adapter dies on launch the shim polled for
10 s and still exited 0 with no output, which reads exactly like a healthy
start. It now prints a one-line diagnosis to stderr before exiting 0 (the exit
code has to stay 0 or the App treats the bootstrap as failed).

Shell difference worth knowing: the shell twin uses `${NEW:=$LEGACY}`, which
treats an explicitly empty `ANYENGINE_X=""` as unset and lets the legacy value
win, while the TypeScript twin keys off `undefined` and keeps the empty value.
No shipped setting is meaningfully empty, so this is noted, not changed.

`scripts/anyengine-mode` had gone stale: `normalize_mode` knew none of the
routes the adapter actually ships (`anyengine`, its `pty` / `claude-pty` /
`interactive` aliases, or `grok`), so the helper could not select the route the
product is named after. Those are added.

## The `npm test` hang

**What it was.** `test/adapter.test.mts`, `approval requests round-trip through
Codex server requests`, started its thread with a bare `thread/start` — no
`approvalPolicy`, no `sandbox`. `server.mts` defaults those to
`approvalPolicy: 'never'` and `sandboxMode: 'danger-full-access'`, and under
that policy the mock runtime deliberately skips the permission round-trip and
runs the command. So `item/commandExecution/requestApproval` was never sent, the
test's loop ran out of messages after `turn/completed`, and `reader.next()` —
an unbounded promise with no timeout — never settled. The runner waited
forever and the 22 tests after it never ran. Both the `?? 'never'` default and
the test are in the upstream base commit, so this is inherited, not a rebrand
regression.

**Fix.** The test now asks for `approvalPolicy: 'on-request'` +
`sandbox: 'workspace-write'`, which is the configuration where an approval is
meant to reach the client. Two guards were added so this class of mistake fails
instead of hanging:

- `JsonLineReader.next()` is bounded (30 s default, `ANYENGINE_TEST_READER_TIMEOUT_MS`)
  and rejects with the number of messages seen; it also rejects every pending
  waiter when the adapter process exits.
- a regression test pins the default that made the old expectation wrong:
  a bare `thread/start` returns `approvalPolicy: 'never'` and
  `sandbox.type: 'dangerFullAccess'`.
- `npm test` also passes `--test-timeout=180000` as a backstop, so no future
  wedge can hold CI open indefinitely.

**Three failures the hang had been hiding**, all in the tail of the file that
had never executed:

1. `file change approval emits patch and git diff updates` — same root cause,
   fixed the same way.
2. `generic Claude tools complete as Codex mcpToolCall items` — asserted
   `tool === 'Read'`, but the adapter (upstream code) puts an App-facing display
   label there, `Read README.md`. Stale expectation, corrected.
3. `interrupt during final git diff cannot overwrite an interrupted turn` — a
   real defect, not a test bug: when a runtime turn rejects *after*
   `server.stop()` has closed SQLite, the `.catch` handler still called
   `store.getTurn` / `store.completeTurn`, throwing `ERR_INVALID_STATE` as an
   unhandled rejection and killing the process. Both `runRuntimeTurn(...).catch`
   handlers in `server.mts` now return early when `this.stopped` is set.

Result: `npm test` exits 0 in a single run — **197 tests, 197 pass, 0 fail,
0 skipped**, about 40 s.

## The two duplicate-`case` lint errors

Both are in the upstream base commit.

- `permissionProfile/list` was listed twice. The two arms return the same three
  profiles for a call with no cursor or limit; the unreachable one
  (`permissionProfileList` in `server-helpers.mts`) additionally honours
  `cursor` / `limit`. The inline copy is removed and the helper kept — no
  behaviour change for any call the App makes, and a test now pins the
  pagination so the two cannot silently diverge again.
- `thread/settings/update` was listed twice: once grouped with
  `thread/metadata/update`, once on its own. **Resolved 2026-09-10** — see
  "Resolution" below.

`npm run check` now exits 0 (44 warnings and 28 infos remain, all pre-existing
and non-blocking).

## Also fixed while here

`docs/.vitepress/config.mts` referenced an undefined `repo` constant — the
rebrand scrub removed the URL but not its use — so `npm run docs:build` and
`npm run docs:dev` both crashed. The constant is restored with the real URL,
and the GitHub social link with it. A second docs break surfaced behind it:
in `docs/guide/bridge.md` an inline code span wrapped so that a line began with
`<token>`, which VitePress compiles as an unclosed HTML tag. Reflowed;
`npm run docs:build` is green.

## Resolution — `thread/settings/update` (2026-09-10)

Decided from traffic rather than from taste. A day of the live adapter log
(`$CODEX_HOME/anyengine/debug.jsonl`, ChatGPT.app 26.901) contains 19 client
calls to this method in three param shapes:

| Shape | Count |
| --- | --- |
| `{threadId, model, effort, multiAgentMode}` | 17 |
| `{threadId, approvalPolicy, approvalsReviewer, sandboxPolicy}` | 1 |
| `{threadId, approvalPolicy, approvalsReviewer, permissions}` | 1 |

All 19 were answered by `threadMetadataUpdate`, the first arm. The second arm
and its `threadSettingsUpdate` method are deleted: they had never executed, so
nothing observable changed, and the `TODO` plus the scoped `biome-ignore` go
with them. The dominant shape is the model picker, which is how mid-thread
engine switching is announced (A5) — the arm that carries it is the one that
had to stay.

Two consequences are now pinned by a test rather than left implicit
(`test/adapter.test.mts`, "thread/settings/update is the metadata handler for
every shape the app sends"): on this method the adapter reads the string
`approvalPolicy` but **not** the `sandboxPolicy` object or the `permissions`
profile, and it emits no `thread/settings/updated` notification. That is the
shipped behaviour, unchanged; whether the settings pane should get more than
that is a product question, and the test will fail loudly if someone answers it
by accident.

## Open items for whoever picks this up

1. `docs:build` is not in CI. It is green now, and it broke without anyone
   noticing, so it is worth a job.
