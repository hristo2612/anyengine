# Plan

Three packets take the fork from a private branch to a public, live `anyengine`.

## A1 — build (done)

Rebuild the history in a clean repo: one squashed base commit crediting
[claude-codex](https://github.com/fuergaosi233/claude-codex) at the merge-base,
our commits replayed on top, then the rebrand series (naming, `ANYENGINE_*`
environment variables with a legacy shim, README, LICENSE, scrub). Verified
with `npm ci && npm run build && npm test`.

## A2 — review, publish, CI

Independent review of the rebrand diff and the scrub, then create the public
repository and push `main`. Restore `homepage` / `repository` / `bugs` in
`package.json` and the docs-site `socialLinks` / `editLink` once the URL exists.
Get the CI workflow green; it also runs `npm run check`, which currently reports
two pre-existing duplicate-`case` lint errors inherited from upstream.

## A3 — live flip, with rollback

Install the rebranded build alongside the current one, point the `codex` shim
at it, and confirm one Claude thread, one Grok thread and one GPT passthrough
thread in the desktop app. Rollback is a single path change back to the previous
adapter; the legacy `CLAUDE_CODEX_*` names keep working throughout, so the old
runtime.env needs no edit to roll back.
