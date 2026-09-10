# Changelog

All notable public-facing changes for anyengine are summarized here.
The project is still private in `package.json`; this file tracks release notes
for maintainers preparing the next public release and does not change package
versioning or publishing metadata.

## Unreleased

### Hardening

- **The hardening pass shipped and was deployed.** The three stacked PRs were
  reviewed by someone who did not write them, merged in order, and the build on
  `main` now drives ChatGPT.app on the maintainer's Mac. Baseline after the
  pass: 232 tests passing, 81.71 % line coverage against an 80.7 floor, a
  500-line file cap with 13 files grandfathered, worst cognitive complexity 112
  over 15 hot spots, and 86 documented `ANYENGINE_*` settings. In the app:
  Claude Sonnet and Grok 4.6 both answer `PONG`, a single thread still moves
  from Sonnet to Grok mid-conversation and carries its codeword across, and
  Plugins → Personal renders. Findings and method:
  `docs/review-hardening.md`; deploy record: `docs/STATUS.md`.
- **`ANYENGINE_SUBAGENT_COMPLETED` is documented correctly.** It was listed as
  something the adapter sets on a sub-agent process. It is not: it is read as a
  tri-state override of the client's `initialize` capability and switches the
  whole sub-agent presentation — `subAgentActivity` markers on, or none of them
  bar `interrupted` and a synthetic `closeAgent` for a failed child. The `0`
  direction now has a test.
- **`git push` no longer fails on correct code.** The pre-push hook ran the
  gates with git's own hook environment still set, so five tests that build
  throwaway git repositories inherited `GIT_DIR` and operated on the repository
  being pushed from instead of their own fixtures. The hook now unsets those
  names before running anything.

- **Dead code removed, nothing observable changed.** The `server.mts` dispatch
  switch listed `thread/settings/update` twice; the second arm and its
  `threadSettingsUpdate` method had never executed and are gone. Which arm is
  live was decided from a day of the real adapter log — 19 client calls in three
  param shapes, all answered by the metadata handler — and a test now replays
  all three shapes and pins what the live handler does with each. Also removed:
  the orphaned `scripts/smoke-subagents.mjs` (no npm script, no doc entry, no
  caller), the unimported `grokBinaryAvailable` and `enqueueWorkflowTask`
  exports, the leftover `RESERVE_MODEL_IDS` constant, the already-dead
  `readConfigReasoningEffort` helper, and 16 unused imports.
  437 lines out of `src/` and `scripts/`; `server.mts` 5133 → 5056,
  `server-helpers.mts` 1106 → 1062, `codex-mux.mts` 1207 → 1205. Running log:
  [docs/hardening-log.md](docs/hardening-log.md).
- **The `CLAUDE_CODEX_*` compatibility shim is now covered by a test.** It was
  kept alive by a single import in `adapter.mts` whose binding nothing read, so
  it looked exactly like an unused import — and no test would have caught its
  removal, because the only coverage called the migration function directly
  with an injected environment. `adapter.mts` now uses an explicit side-effect
  import, and a test spawns a real adapter with only the legacy spelling set
  and asserts it arrives under the new one.

### Quality gates

- **Two new gates, three tightened.** `scripts/check-complexity.mjs` freezes the
  worst cognitive complexity (112) and the number of hot spots (15) so neither
  can rise — Biome's warning at 30 fails nothing, which is how `server.mts`
  reached 186 unnoticed. `scripts/check-env-docs.mjs` fails when `src/**` reads
  an `ANYENGINE_*` name with no entry in the configuration guide; 37 of the 86
  settings were undocumented and are now written down. The file-size cap drops
  from 800 to 500 lines with the thirteen files above it grandfathered at their
  current length; `noUnusedVariables`, `noUnusedImports` and `noUselessElse`
  become errors; the coverage floor rises from 80 to 80.7.

- **Coverage is measured and floored.** `npm test` now runs the Node 24
  built-in coverage collector over `dist/src/**` and fails under 80 % lines.
  Today's number is 81.40 % across 47 modules. No new dependency: the runner
  that already ran the suite does the counting.
- **Files never grow.** `scripts/check-size.mjs` caps `src/**/*.mts` at 800
  lines. The six modules already over the cap — `server.mts` (5133),
  `native-runtime.mts` (1462), `anyengine-runtime.mts` (1414), `codex-mux.mts`
  (1207), `server-helpers.mts` (1106), `bridge-control.mts` (927) — are frozen
  at those lengths in `scripts/size-baseline.json` and may only shrink; a
  shrink rewrites the baseline for the same commit, and in CI a stale baseline
  is an error. Nothing was split in this change: the point is that the big
  modules stop absorbing new code.
- **Complexity is visible.** Biome's `complexity` group is on at recommended
  with `noExcessiveCognitiveComplexity` as a warning at 30 (default 15). Twenty
  warnings today, the worst a cognitive complexity of 186 in `server.mts`.
  Warnings do not fail the build.
- **Runtime dependencies take a deliberate step.** `scripts/check-deps.mjs`
  fails when `dependencies` differs from `scripts/deps-baseline.json`; adding
  one means `node scripts/check-deps.mjs --update` plus a one-line
  justification in the commit.
- **One pre-push hook, no husky.** `scripts/setup-hooks.sh` sets
  `core.hooksPath` to `scripts/hooks`; `pre-push` runs typecheck, check, tests
  with coverage and `gitleaks protect --staged` in roughly 50 s.
- **CI** runs the coverage, size and dependency checks and adds
  `gitleaks/gitleaks-action@v2`, keeping the existing 15-minute job timeouts.
- **Docs.** New [`docs/quality.md`](docs/quality.md) one-pager, a rewritten
  `CONTRIBUTING.md` aimed at humans and agents, both linked from the README.


### Switch engines mid-thread

- **The model picker now works in the middle of a conversation, in every
  direction.** A thread used to be bound to one engine at `thread/start`:
  moving a GPT thread to Sonnet came back as the real Codex child's *"the
  'sonnet' model is not supported when using Codex with a ChatGPT account"*,
  and the reverse could not work at all. Routing now follows the **model**
  wherever the app announces it — `thread/settings/update` /
  `thread/metadata/update`, which is what this desktop sends when the picker
  moves, or an explicit `turn/start.model`. When the resolved engine differs
  from the one that owns the thread, the thread is handed over first and the
  turn runs on the new engine. The desktop keeps the one thread it has always
  had, and draws its own "Model changed from X to Y" divider between the turns.
- **The conversation comes with it.** The handover carries a compact
  transcript of the thread so far — the user and assistant messages, in order,
  without tool calls or reasoning. To Claude or Grok it seeds a fresh runtime
  session as the prompt prefix of the first turn (the stored user message is
  untouched, so the app's transcript does not change). To GPT it is handed to
  the child through `thread/inject_items`, and prefixed onto the first turn's
  input when the child refuses the injection. Past
  `ANYENGINE_REHOME_MAX_CHARS` (12000) the block keeps the first user message
  and the most recent exchanges, and says so in one line.
- **One thread, one history.** Ownership — the engine plus the child thread id
  behind it — is persisted, so a switch survives an adapter restart.
  `thread/read` on a thread that has lived on both sides answers with both
  halves of the item history in order, and `thread/list` shows it once, under
  the id the desktop has always known.
- **Guards.** A switch while a turn is running is refused with a readable
  message instead of cutting the turn off; a turn whose model already matches
  the owner is untouched (no behaviour change for the common path); a handover
  that fails leaves the thread with its previous owner and errors the turn.
  Each handover logs one `thread.rehomed {from,to}` line.

### Reserve mode handles itself

- **The desktop's model picker survives a spent Codex quota, without giving up
  the real Codex child.** While the account is out of Codex usage the desktop
  hides the whole picker — Claude and Grok included — and shows a blocking
  usage banner, because it takes its own ChatGPT identity from the local host's
  `account/read` and `getAuthStatus`. The adapter now reads
  `account/rateLimits/read` from the child (once before the handshake returns,
  then every five minutes; the desktop never asks for it) and, while the limit
  is reached, answers those two calls with the same externally-authenticated
  shape it serves when there is no child at all, rewrites `account/updated` to
  match, and drops the `rateLimitReachedType` / `rateLimitUpsell` markers from
  the rate-limit payloads it forwards. The real usage numbers, the model list
  and the child are untouched: gpt-* threads still reach the child and still
  fail with the account's own usage-limit error. The moment a read says the
  limit lifted, the rewriting stops and the desktop is told to re-read the
  account. Each transition logs one `reserve.entered` / `reserve.cleared` line.
  `ANYENGINE_AUTO_RESERVE=0` turns it off.
- **`ANYENGINE_HIDE_RATE_LIMIT_UPSELL` and `ANYENGINE_NATIVE_CODEX=0` are
  superseded** as a reserve-mode workaround. Both still work for one release —
  the first still strips the markers unconditionally and empties the OpenAI
  half of the model list, the second still removes the child — but neither is
  needed now, and neither follows the limit back down.

### MCP tools, skills and plugins inside the desktop app

- **Tool calls no longer deadlock a Claude thread.** Every tool that was not
  `Bash`, `Edit`, `Write` or `MultiEdit` was answered with
  `item/fileChange/requestApproval` while the item it named was an
  `mcpToolCall`. The Codex app-server protocol has no approval request for that
  item type, the desktop app drew no card, and the turn waited forever — which
  is what every `mcp__*` call, `ToolSearch` and `Skill` did. The approval now
  follows the item anyengine actually emitted: a command approval for `Bash`, a
  file-change approval for `Edit` / `Write` / `MultiEdit`, and everything else
  runs immediately, the way Codex runs MCP tools under its own tools approval
  mode. The `mcpToolCall` item and its result still reach the app.
- **The Plugins pane loads.** `plugin/installed` and
  `externalAgentConfig/import/readHistories` were unimplemented, and the pane
  re-polled the pair every two seconds behind "Loading plugins…" forever.
  `plugin/list`, `plugin/installed`, `plugin/read` and `plugin/skill/read` now
  answer from `CODEX_HOME` on disk — the `[plugins."<name>@<marketplace>"]`
  blocks of `config.toml` resolved to their newest package under
  `plugins/cache/`. Nothing is written.
- **A plugin's MCP servers reach every engine.** The stdio servers declared by
  plugins from the user's own marketplaces are merged into the record handed to
  Claude (`--mcp-config`) and to Grok (ACP `mcpServers`), with their `env`
  carried through. The bundled `openai-*` marketplaces are excluded: their
  servers are the desktop app's own runtime and belong to the real Codex child.
  `ANYENGINE_CODEX_PLUGIN_MCP=0` turns the merge off.

### Rebrand: claude-codex / jinn-pty -> anyengine

- The project is now **anyengine**. The package, the binary, the Rust protocol
  crate, the state directory (`~/.anyengine`), the adapter home
  (`~/.codex/anyengine`), the host helper (`scripts/anyengine-mode`) and the
  cross-engine MCP server all carry the new name. The interactive-PTY runtime
  formerly called `jinn-pty` is now the `anyengine` route; its earlier route
  values (`jinn-pty`, `jinn`) are gone, while `pty`, `claude-pty` and
  `interactive` still resolve to it.
- Every environment variable moved from `CLAUDE_CODEX_*` to `ANYENGINE_*`. For
  one release the old spelling is still accepted: each `CLAUDE_CODEX_X` is
  copied onto `ANYENGINE_X` unless the new name is already set, so the new name
  always wins and nothing is removed from the environment. The shim also falls
  back to `~/.claude-codex/runtime.env` while `~/.anyengine/runtime.env` does
  not exist. Both compatibility paths are removed one release later.
- Upgrading an existing install: the value of `ANYENGINE_RUNTIME_TYPE` (or
  `ANYENGINE_ROUTE`) must be changed from `jinn-pty` to `anyengine`; the name
  compatibility shim does not translate route *values*.
- anyengine remains a fork of
  [claude-codex](https://github.com/fuergaosi233/claude-codex) by fuergaosi233
  (MIT); see the Credits section of the README.

### App-server and protocol compatibility

- Updated the adapter to advertise Codex app-server protocol v2 compatibility at
  the current pinned Codex CLI compatibility version, while keeping a
  `anyengine` suffix so hosts can distinguish the adapter from upstream
  Codex.
- Expanded Codex App Remote coverage across thread lifecycle, turn envelopes,
  item streaming, approvals, MCP status, fuzzy file search sessions, Claude
  skills/hooks, and `thread/turns/list` item views.
- Added protocol fixture coverage for `config/read`, including the sanitized
  `config.provider_loop_config` shape, so the Rust fixture drift gate covers
  provider-loop config projection behavior.
- Kept compatibility-only account, plugin, marketplace, realtime, and other
  OpenAI-specific surfaces inert or schema-shaped where Claude Code has no
  equivalent.

### Provider and multi-agent boundaries

- Added the provider and multi-agent loop boundaries RFC to separate runtime
  backends, provider metadata, agent-loop fidelity, credential ownership, and
  subscription/entitlement boundaries.
- Added static provider/agent-loop descriptors with validation for allowed and
  unsupported credential source labels.
- Added sanitized provider-loop projection helpers and exposed the read-only
  `config.provider_loop_config` field through `config/read`.
- Added explicit provider/agent-loop selection for known descriptor ids and loop
  ids. Selection maps only to existing runtime backends, preserves legacy
  runtime environment overrides and `ANYENGINE_MOCK=1` precedence, filters
  raw saved selection keys from public `config/read`, and exposes sanitized
  selection metadata through `config.provider_loop_config.selection`.
- Added tests proving built-in descriptors validate cleanly, unsupported
  credential labels are not projected as allowed, and secret-like descriptor
  text is redacted from public projection results.

### Rust-first protocol groundwork

- Added the Rust-first runtime boundaries RFC, keeping the TypeScript
  app-server adapter as the shipping runtime path while defining incremental
  Rust protocol, transport, store, and launcher boundaries.
- Added an experimental Rust workspace scaffold and protocol crate with
  representative Codex app-server JSON fixtures.
- Added Rust parse/reserialize tests for the covered fixtures.
- Added a pinned fixture drift check against the configured Codex CLI version
  and made it part of CI alongside `cargo test --workspace`.
- Extended fixture coverage to include config projection data without claiming a
  Rust production runtime, transport, store, or provider execution path.

### Release readiness and compliance docs

- Added open-source compliance documentation and release-readiness reference
  material for maintainers and reviewers.
- Clarified the README and documentation homepage around the TypeScript
  production path, Rust-first experimental boundaries, provider/agent-loop
  descriptor and selection boundaries, supported credential ownership models,
  unsupported subscription/session/private endpoint/bypass behavior, and release
  verification expectations.
- Documented provider selection configuration for `ANYENGINE_PROVIDER`,
  `ANYENGINE_AGENT_LOOP`, saved provider-loop config keys, precedence rules,
  and sanitized `config.provider_loop_config.selection` projection.
- Documented the current shippable baseline: TypeScript remains the production
  path; Rust pieces are opt-in protocol boundary work; provider/loop descriptors
  are read-only metadata, not runtime dispatch.
- Documented supported credential ownership models: local user-provided API
  keys, official cloud-provider credential chains, organization-managed
  gateways, and local CLI auth for same-host user-directed execution.
- Documented unsupported credential models, including personal subscription
  sharing, browser cookie/session-token reuse, private provider endpoints,
  bypass guidance, and credential redistribution.

### Validation and release gates

- Default CI runs Biome checks, TypeScript typechecking, the Node test suite,
  Rust workspace tests, and the pinned Rust protocol fixture drift gate.
- Documentation changes should run `npm run docs:build`.
- Credentialed smoke and acceptance checks remain opt-in and must use
  credentials already owned by the local user or organization on the host.

### Still experimental or not yet included

- No Rust production runtime, transport, store, provider execution path, or
  default-on Rust launcher is included.
- No executable new provider loop is included beyond the existing runtime
  backends.
- No broad runtime dispatch rewrite is included.
- No new credential collection model is included.
- No support is included for personal subscription sharing, credential pooling,
  browser cookie/session-token reuse, private provider endpoints, or provider
  bypass behavior.

### Publication and CI (A2)

- Fixed the `npm test` hang inherited from upstream: one adapter test waited
  forever for an approval that a `never` policy never sends. The test now asks
  for the approving policy, the test JSON reader is bounded and rejects instead
  of hanging, and `npm test` carries a `--test-timeout` backstop. Three
  failures the hang had been hiding are fixed with it, including an unhandled
  rejection that crashed the process when a turn settled after `stop()` had
  closed the store.
- Removed the unreachable duplicate `permissionProfile/list` switch arm in
  favour of the paginating helper, with a test covering `cursor` / `limit`.
  The duplicate `thread/settings/update` arm is deliberately left in place and
  documented; see `docs/review-a2.md`.
- Restored the repository URL across `package.json`, the documentation site and
  the README badge, and fixed two breaks in `npm run docs:build`.
- CI runs Biome, typecheck, build, the Node suite and `cargo test --workspace`
  on macOS and Linux at Node 24.
