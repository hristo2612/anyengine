# Changelog

All notable public-facing changes for anyengine are summarized here.
The project is still private in `package.json`; this file tracks release notes
for maintainers preparing the next public release and does not change package
versioning or publishing metadata.

## Unreleased

### Switch engines mid-thread

- **The model picker now works in the middle of a conversation, in every
  direction.** A thread used to be bound to one engine at `thread/start`:
  moving a GPT thread to Sonnet came back as the real Codex child's *"the
  'sonnet' model is not supported when using Codex with a ChatGPT account"*,
  and the reverse could not work at all. Routing is decided per **turn** from
  `turn/start.model`; when the resolved engine differs from the one that owns
  the thread, the thread is handed over first and the turn runs on the new
  engine. The desktop keeps the one thread it has always had.
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
