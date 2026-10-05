# AnyEngine v1 execution progress

The approved v1 design is `docs/specs/2026-09-29-anyengine-v1-design.md`.
Execution order is M1, M2, then M3. The operator authorizes necessary decisions,
local commits on `main`, reversible live changes and automatic rollback. M2 and
M3 use one owner, bounded parallel legwork when useful and one independent
milestone review; no employees are used.

## Current checkpoint — 2026-10-05

M1, M2 and M3 are locally accepted. Product commit `ad0bdf7` is installed with
native routing, Home active, automatic rotation and replay off. M2's accepted
baseline remains `97f3745`. The native and bridge seven-child tests both returned
exact matching results with three actual Opus children. Account rotation retained
app context, simultaneous desktop/translator work drained safely, M3-only Bash
recovery preserved M2, and full Off from C restored Home and cleaned the cache.
M1 → M2 → M3 reinstall passed all live activation checks.

[M3 acceptance](m3-accounts-limits.md) records the live results and proportionate
source checks. The full 2,101-test run passed before the final narrow fixes;
subsequent affected suites and static/build checks passed. M2 and M3's independent
milestone reviews are complete. Historical M1 TUI and legacy M0 observations
remain explicit in [M1 acceptance](m1-acceptance.md).

The working method is now one owner and one milestone review. The removed
Superpowers execution loops, decision rulings and source sealing are discontinued.
Automatic rollback remains part of the product. Focused tests and live behavior
drive fixes; earlier historical checks below are retained as history.

## M1 implementation history

The existing reviewed adapter hardening and router foundation were integrated
onto `main` at `44f1acd`. This includes Tasks 1–8, 9, 10, 12 and 16, plus the
subsequent adapter, environment, composer, idle-check and compatibility fixes.

Fresh verification on the exact integration:

- `npm run check`: passed.
- `npm run typecheck`: passed.
- `npm test`: 664 passed, zero failed, 86.45% line coverage.
- Hermetic tests used isolated homes and fake engines, with no live model calls.

Task 13 is integrated on `main` at `6e8b526`. Independent re-review accepted all
five fixes: transitive sticky posture, workspace trust, deletion cancellation,
hardened PTY environment and restricted reads. Check/typecheck passed and the
exact integrated tree passed 701 tests with zero failures and 86.69% line coverage.

Task 11 is integrated at `7e7bf4a`: GPT WebSocket relay, Claude routing,
prewarm/replay handling and in-flight cleanup. Independent spec/quality review
passed with no findings. The final tree passed 737 tests, zero failures,
86.95% line coverage and check/typecheck. An isolated shutdown regression also
proved and fixed upgraded sockets surviving HTTP server shutdown.

Task 14 is integrated at `82aa9ea`: adapter ownership claims, trusted workspace
metadata and bounded claim shutdown. Independent re-review accepted the
preparation-cancellation fix with zero open findings. Check/typecheck passed;
the exact source tree passed 770 tests with zero failures and 87.19% line coverage.

Task 15 is integrated at `df09d3d`: selected-owner claim client, trusted workspace
metadata and agent-mode Responses streaming. Independent spec/quality review
approved it with no blocking findings. Static gates and 94 focused tests passed;
the final full run passed 800 tests with 87.36% line coverage.

The first full run observed a lost concurrent config update in unchanged locking
code. Independent static diagnosis found a stale-coordinator removal interleaving
that can admit concurrent writers; the exact failed-run schedule remains unproven.
Task 15b repairs shared config exclusion and is integrated at `d2d6fdd` after
independent review with no blocking findings. A stable SQLite transaction now
covers recovery, the synchronous callback and release. Deterministic process
barriers proved exclusion failure before the change and also caught a database
descriptor mistake that was corrected before final checks. Static gates and 33
focused tests passed; the single final full run passed 807 tests with 87.34% line
coverage. Persistent coordination files and their handles must be preserved as
documented.

Task 17 is integrated at `f38c09a`: owned model-mode tool handoff keeps one Claude
child across response segments, binds continuation to its thread and selected
adapter, and joins cleanup on replacement or shutdown. Independent review closed
the stale-result, delayed-admission and parser-failure findings. Static gates and
74 focused tests passed; the exact source passed 845 tests with zero failures and
87.75% line coverage. Real-model and installed-app acceptance remain pending.

Task 18 is integrated at `e8be17d`: health-gated router attachment, exact selected
router/child proof agreement, and mode-aware Claude routing. Independent scoped
re-review closed all three ownership/proof findings and accepted direct-handover
instruction preservation with the documented older-rollout limit. Static gates
passed; focused checks passed 65 and 76 tests, and the final source passed 875
full-suite tests with zero failures and 87.89% line coverage. The integrated
implementation matches the tested source exactly; the main-only documentation
amendments remain preserved. Installed and GUI acceptance remain pending.

Task 19 is integrated at `699993d`: configured-app controls, validated flip
markers, bounded log reads and backed-up owned-cache cleanup. Independent
re-review closed publication-size and corrupt-byte findings with no open defects.
Static gates passed; focused checks passed 33 tests, and the final source passed
900 full-suite tests with zero failures and 88.03% line coverage. The accepted
source is unchanged by integration. Cache consumers must confirm app exit, and
Task26 still supplies process-start/token/inode lock authority.

Task 20 is integrated at `bf2ab49`: registered status, mode, config and cache
commands, plus the stable launcher. Independent scoped re-review closed the
symlinked logs-directory finding with no open defects. Config reads and setters
now preserve invalid bytes and refuse unreadable oversized publication. Static
gates passed; 114 focused checks and the final 963-test full suite passed with
88.21% line coverage. The actual Mac status check returned successfully, reported
all areas, and preserved metadata for 19,599 AnyEngine/LaunchAgent entries. A
first check also correctly diagnosed this session's unsupported temporary cache;
the desktop-home check had no inspection errors. Integration leaves the tested
source unchanged.

Task 21 is integrated at `1204a19`: all 19 doctor checks, validated lexical TOML
edits, strict proof/degraded evidence and coordinated producer mutations, plus
packaged isolated version/schema probes. Independent scoped re-review closed
the normal-caller scratch-ownership and legacy-doctor execution findings with
zero open defects. Static/type/diff gates passed; focused checks passed 76 and
35 tests, and the exact source passed 1,025 full-suite tests with 88.46% line
coverage and no reported leftovers. Integration leaves that source unchanged.
The actual read-only Mac doctor reported all 19 checks and preserved metadata
for 19,599 AnyEngine/LaunchAgent entries. Its two failing checks correctly
refused the older unsupported installed helper and reported an older adapter's
unknown child; this is diagnostic acceptance, not installed health. Installed,
native and GUI acceptance remain pending.


Task 22 is integrated at `d004fef`: strict layer journals, immutable original
backups, settled and pending changes, immediate last-good upgrade checkpoints,
and evidence-based M0 adoption. Independent scoped re-review closed both
missing-recovery-directory and invalid-marker refusal findings with zero open
defects. Static gates, 153 affected tests and the three unchanged independent
reproductions passed; the final suite passed 1,102 tests with 88.74% line coverage.
Twenty actual SIGKILL cases exercised journal and target interruption points.
Their recovery snapshots are JSON evidence; generated Bash recovery is Task23,
which starts next. Integration leaves the accepted source unchanged. Installed,
native and GUI acceptance remain pending.

A bounded state audit additionally confirmed corrupt-byte config/proof mutation
and unsafe degraded clearing in existing shared helpers. Binding F16 assigns
config correction to Task20 and cohesive proof/degraded correction to Task21;
these are required before live acceptance and later smoke/update publication.

The earlier source-only checkpoint and installed `0d9e4ca` baseline above are
historical. The current checkpoint and acceptance record supersede them;
initial and immediate last-good recovery evidence is retained.

## M2 accepted; M3 starting

M2's Claude Code face and OpenAI token broker are implemented and live accepted.
M3 adds sequential account rotation and account limits. Its first check is the
installed Codex overlay fixture, with fake credentials and no model turns.

The M2 eight-task and M3 eleven-task plans independently passed review and are
committed on main at `dc16a72`. A real Codex app-server with an isolated fake login
and loopback refresh endpoint returned and refreshed the fake bearer itself.
That real bearer gate subsequently passed in M2. The planning overlay probe is
historical; M3 must validate the current installed binary before live installation.

## Preservation

Before updating `main`, all pre-existing modified and untracked files were saved
in a separate local backup and a named Git stash. The existing implementation
and lockfile changes were already preserved or superseded by M0/M1. The three
unique `docs/drafts/` files were restored without replacing newer source code.

## Decisions

- Verified task commits land on `main` as work progresses; task branches provide
  isolation for implementation and review. A mistaken integration is reversible
  with Git.
- Preserve previous acceptance evidence and task reviews. Rerun integration
  checks when combining changes, and fix concrete review findings.
