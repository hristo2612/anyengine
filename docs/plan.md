# Plan

Three packets take the fork from a private branch to a public, live `anyengine`.

## A1 — build (done)

Rebuild the history in a clean repo: one squashed base commit crediting
[claude-codex](https://github.com/fuergaosi233/claude-codex) at the merge-base,
our commits replayed on top, then the rebrand series (naming, `ANYENGINE_*`
environment variables with a legacy shim, README, LICENSE, scrub). Verified
with `npm ci && npm run build && npm test`.

## A2 — review, publish, CI (done)

Independent review of the rebrand diff and the scrub — provenance, licence,
scrub, secret scan and the compatibility shim all pass; findings and their
verdicts are in [review-a2.md](review-a2.md). `package.json` carries
`homepage` / `repository` / `bugs`, the docs site has its `repo` constant and
GitHub link back, the README has a CI badge, and CI runs Biome, typecheck,
build, the Node suite and `cargo test --workspace` on macOS and Linux at
Node 24. Both blockers are cleared: `npm test` terminates in one run (197
tests, 197 pass) and `npm run check` is clean. The repository is public at
<https://github.com/hristo2612/anyengine>.

## A3 — live flip, with rollback (done)

Install the rebranded build alongside the current one and point the `codex`
shim at it, on this Mac. Done 2026-09-10; what actually changed, the timings,
the rollback command and the two environment limits found on the way are in
[evidence/a3-flip.md](evidence/a3-flip.md).

1. Back up first: copy the installed `codex` shim and the current
   `runtime.env` somewhere outside the repo. These two files are the whole
   rollback.
2. Edit `runtime.env`: the route value of `ANYENGINE_RUNTIME_TYPE` (or
   `ANYENGINE_ROUTE`) moves from `jinn-pty` to `anyengine`. The compatibility
   shim renames *variables*, not their values, so this edit is required —
   `jinn-pty` is now rejected.
3. Copy the new `scripts/codex-shim` over the installed `codex`, keep it
   executable, and point `ANYENGINE_ADAPTER` at this checkout's
   `dist/src/adapter.mjs`.
4. Restart ChatGPT.app so it re-launches the app-server.
5. Verify: a PONG turn on Claude and one on Grok, then three smokes —
   `smoke:anyengine`, `smoke:grok`, and `smoke:native-codex` / `smoke:bridge`,
   which need the host's own runtime.env and the bundled Codex child.
6. Rollback: restore the backed-up shim and `runtime.env`, restart the app.
   The legacy `CLAUDE_CODEX_*` names keep working throughout, so the restored
   runtime.env needs no edit.

The legacy env-name shim and the `~/.claude-codex/runtime.env` fallback are
removed one release after the flip.
