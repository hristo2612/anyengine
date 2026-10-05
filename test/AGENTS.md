# test/AGENTS.md

Tests run with the built-in `node:test` runner against compiled output. See the
[root AGENTS.md](../AGENTS.md) for project-wide conventions.

## Layout

- `*.test.mts` — sources compiled to `dist/test/*.mjs`.
- `fixtures/` — shared test fixtures (`fake-codex-app-server.mjs` is the stdio
  stand-in for the real `codex app-server` used by `codex-mux.test.mts`).
  `codex-wire-<version>.json` is written by `scripts/capture-codex-wire.mjs`
  and `codex-spawn-<version>.json` by `scripts/capture-codex-spawn.mjs`, each
  committed exactly as written: Biome skips them (`biome.json`), so a rerun
  against the same codex is byte-identical to the committed file.
  `codex-spawn-0.155-spike.json` is the spike's link shape, kept as the
  fallback reference. The spawn recordings list notifications in canonical
  order, not arrival order: what codex guarantees is the 0.159 fixture's
  `orderInvariant`. Test the race it allows (a child's own notifications,
  turn/started included, before its link) with the fake codex's
  `FAKE_CODEX_SPAWN_CHILD` and `FAKE_CODEX_SPAWN_ORDER=child-first`.
- `helpers/fake-backend.mts` — a loopback stand-in for
  `chatgpt.com/backend-api/codex` (models, SSE `/responses`, a WebSocket) that
  records what it received, raw; `respond` overrides every request but
  `GET /models`. The router suites relay through it.

## Running

```bash
npm test                         # build, then every suite through scripts/test-hermetic.mjs
npm run build                    # compile without running
node scripts/test-hermetic.mjs dist/test/adapter.test.mjs   # one suite, after a build
```

Suites never run under a bare `node --test`: `test/hermetic.test.mts` fails
unless HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, ANYENGINE_DEBUG_LOG and PATH point
into the runner's throwaway root. Suites that spawn children import `spawn`
from `test/helpers/children.mts` and call `after(() => killChildren())`, which
waits for every child to exit: a child still writing its coverage file when the
run reads them fails `npm test`. A daemon the shim disowns is stopped by pid
with `stopProcess`, never left to idle out.
The runner also points TMPDIR into that root and fails a run that leaves
anything there, or that adds `anyengine-*` entries to the real temp directory:
make temp directories with `tempDir()` from `test/helpers/tmp.mts` and register
`after(removeTempDirs)` (after `killChildren` where the suite spawns children).

## Conventions

- Tests import from `dist/` (compiled `.mjs`), so **always build first** —
  `npm test` does this for you; editing a `.mts` and re-running raw
  `node --test` without a rebuild tests stale output.
- Use `ANYENGINE_MOCK=1` to exercise protocol behavior without Claude
  credentials. `npm test` also sets `ANYENGINE_NATIVE_CODEX=0`, and points
  `ANYENGINE_CHATGPT_APP` at an app bundle that does not exist, so no suite
  spawns a real `codex` binary found on the machine; only an explicit
  `ANYENGINE_REAL_CODEX` (the fake child) or a fake bundle a test builds
  attaches the multiplexer. Credentialed end-to-end checks live in `scripts/acceptance-*`,
  not here.
- Add new suites as `<area>.test.mts`; the `npm test` glob picks them up.
- Time nothing a loaded machine can stretch. macOS checks a new executable on
  its first exec, which took up to 3 s for a script written a moment before:
  run a fake as `node <fake>` where the code under test takes a command, or
  exec it once before the timed part (`warmUp` in `test/shim.test.mts`).
  Wait for the file, line or event with a generous give-up (30 s), and keep a
  speed bound only where speed is the behaviour, with room to spare (under
  8 s against the shim's 10 s give-up).
