# Quality gates

Five small gates, all of them scripts you can read. The worry they answer:
generated code drifts into an over-engineered mess long before anyone notices.
Each gate freezes one axis of that drift at today's value.

Run them the way CI does:

```bash
npm run typecheck
npm run check      # biome + size ratchet + dependency guard
npm test           # build + node --test + coverage floor
```

`scripts/setup-hooks.sh` wires the same set into a `pre-push` hook (plus
`gitleaks protect --staged`). No husky, no lint-staged — one `core.hooksPath`
setting.

## 1. Coverage floor

`npm test` is `npm run test:coverage`: the Node 24 built-in runner with
`--experimental-test-coverage`, scoped to `dist/src/**`, and
`--test-coverage-lines=80`. No extra dependency, and the same runner that
already runs the suite.

Line coverage on 2026-09-10 was **81.40 %** over 47 modules, so the floor sits
one point under it. Below 80 the run exits non-zero and CI is red. Raise the
floor when the real number rises; do not lower it.

The thinnest modules today are `codex-proxy-runtime.mjs` (8.78 %, only reached
through a live Codex child), `transports.mjs` (50.50 %) and
`native-runtime.mjs` (57.94 %).

## 2. File-size ratchet

`scripts/check-size.mjs`. Every `src/**/*.mts` file is capped at **800 lines**.
The six modules already over the cap are frozen at their current length in
`scripts/size-baseline.json`:

| Module | Lines |
| --- | --- |
| `src/server.mts` | 5133 |
| `src/native-runtime.mts` | 1462 |
| `src/anyengine-runtime.mts` | 1414 |
| `src/codex-mux.mts` | 1207 |
| `src/server-helpers.mts` | 1106 |
| `src/bridge-control.mts` | 927 |

They may shrink, never grow. A shrink rewrites the baseline automatically and
the smaller number is committed with the change; drop under 800 and the file
leaves the baseline for good. In CI the script never writes — a stale baseline
fails, so the update lands in the commit that caused it.

The point is not the number 800. It is that the big modules stop absorbing new
code: to add behaviour to `src/server.mts`, extract a module first.

## 3. Complexity warnings

Biome's `complexity` group is on at recommended, with
`noExcessiveCognitiveComplexity` as a **warning** at a threshold of **30**
(Biome's default is 15). Warnings do not fail `npm run check`; they surface hot
spots so review can push back.

There are **20** today, the worst being a cognitive complexity of 186 in
`src/server.mts`. That number is the drift, quantified — treat a rise in the
count as a review comment.

## 4. Dependency guard

`scripts/check-deps.mjs` compares the `dependencies` block of `package.json`
against `scripts/deps-baseline.json` and fails on any difference. Adding a
runtime dependency therefore takes a deliberate second step:

```bash
node scripts/check-deps.mjs --update
```

Commit the baseline with a one-line justification. `devDependencies` are not
guarded — they never reach a user's machine.

## 5. Secrets

`gitleaks protect --staged` runs in the pre-push hook (install it with
`brew install gitleaks`), and `gitleaks/gitleaks-action@v2` scans full history
on every CI run.

## What these gates do not do

They do not check that the adapter actually works. Protocol and runtime changes
still need a real-app run: the `npm run smoke:*` scripts against the real CLIs,
and screenshots plus a mechanism/rollback note in `docs/evidence/` for anything
the desktop app can see. See [CONTRIBUTING.md](../CONTRIBUTING.md).
