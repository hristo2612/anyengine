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

## B5b — MCP tools and plugins in the app (done)

A `jinn init` on a daily-driver Mac registered everywhere, but nothing that
needed a tool could finish inside a ChatGPT.app thread. Two defects, both in
this repository:

1. The approval request was chosen by tool name, not by the item anyengine had
   just emitted, so every non-`Bash` / non-file tool asked for a file-change
   approval on an `mcpToolCall` item. There is no such card in the protocol.
2. `plugin/installed` and `externalAgentConfig/import/readHistories` were
   unimplemented, so the Plugins pane never left its loading state.

Both fixed, plus the plugin catalog now feeds the user's own stdio MCP servers
to every engine. Mechanism, in-app evidence and rollback:
[evidence/b5b-mcp-approvals.md](evidence/b5b-mcp-approvals.md).

Still open, and deliberately not done here:

- **Plugin skills are not enumerated.** `skills/list` still reads only
  `~/.claude/skills` and `<cwd>/.claude/skills`
  (`src/claude-capabilities.mts`). A teammate installed as a Codex plugin shows
  up in the app only because `jinn init` also writes the Claude Code skill. The
  fix is to extend `listClaudeSkills` with each enabled plugin's `skills/`
  directory under a `plugin` scope and read the display name from
  `agents/openai.yaml`.
- **The remote plugin catalog** (Plugins → Public) is fetched by the desktop
  from its own backend; a local app-server cannot fill it.
- **`plugin/install` / `plugin/uninstall` are still no-ops.** Installing from
  inside the app does not change `config.toml`; use the `codex` CLI.
