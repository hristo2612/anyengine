# Contributing

For humans and for agents. Read this before your first commit; the full
toolchain guide is [docs/contributing.md](docs/contributing.md) and the gates
are described in [docs/quality.md](docs/quality.md).

## Once per clone

```bash
npm install
scripts/setup-hooks.sh      # points core.hooksPath at scripts/hooks
brew install gitleaks       # the pre-push hook requires it
```

## Every change

```bash
npm run typecheck           # tsc --noEmit
npm run check               # biome + file-size ratchet + dependency guard
npm test                    # build + node --test, with the coverage floor
```

`git push` runs all three plus `gitleaks protect --staged` (about 50 s).

## The rules

- **KISS.** The simplest thing that works and can be read six months later.
  Delete before you add. Do not build a framework for one caller.
- **Files never grow past their baseline.** `src/**/*.mts` is capped at 800
  lines; the modules already over it are frozen at today's length in
  `scripts/size-baseline.json`. **To add behaviour to `src/server.mts`, extract
  a module first** — move a cohesive slice into a new `src/*.mts` file with its
  own test, then add your code there. Shrinking a file rewrites the baseline
  automatically; commit that change with your code.
- **No new runtime dependency without a one-line justification** in the commit
  message saying what it does and why writing it here would be worse. Adding one
  also means running `node scripts/check-deps.mjs --update` and committing
  `scripts/deps-baseline.json` in the same commit. devDependencies are free.
- **Tests live beside the behaviour they cover.** `test/<module>.test.mts`,
  `node:test`, asserting real observable output. New behaviour ships with a
  test in the same commit; coverage may not drop below the floor.
- **Complexity is visible, not blocking.** Biome warns past a cognitive
  complexity of 30. Warnings do not fail the build; growing the count is still
  a review comment.
- **Verify in the real app.** Protocol or runtime changes are not done because
  the suite is green. Run the relevant `npm run smoke:*` script against the real
  CLI, and for anything the desktop app can see, drive ChatGPT.app and put the
  screenshots and a short mechanism/rollback note in `docs/evidence/`. Cite that
  file from `docs/STATUS.md`.
- **No personal paths, no machine names, no secrets.** Nothing under a home
  directory, no OAuth or session files, no `.env`, no acceptance transcripts.
  Use `~` or an environment variable in docs and examples.
- **No `Co-Authored-By:` trailers.** Write what changed and why it is safe.
- **One topic per pull request** with a test plan in the description. Keep
  runtime work, docs and dependency bumps apart.

## Layout

- `src/adapter.mts` — CLI and app-server entry point.
- `src/server.mts` — the Codex app-server protocol surface.
- `src/*-runtime.mts` — selectable engines, wired through `runtime-factory.mts`.
- `scripts/` — the shim, the smokes, and the quality gates.
- `test/` — `node:test` suites against the compiled `dist/` output.
- `docs/` — the VitePress site, plus `docs/evidence/` for real-app runs.
