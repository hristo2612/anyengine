# src/AGENTS.md

Adapter internals. All files are `.mts` ESM, compiled to `dist/*.mjs`. See the
[root AGENTS.md](../AGENTS.md) for build/test and project-wide conventions.

## Map

- `adapter.mts` — entry point / CLI mode dispatch.
- `server.mts` — Codex app-server protocol layer (the big one; prefer adding new
  surface as helpers and splitting when practical).
- `transports.mts` — stdio / WebSocket / Unix-socket daemon / `proxy`.
- `store.mts` — SQLite thread/turn persistence via `node:sqlite` (Node 24+).
- `types.mts` — shared protocol/runtime types.
- `util.mts` — shared helpers.
- `mcp.mts` — MCP stdio/HTTP tool & resource calls.
- `worktree.mts` — optional per-thread git worktree isolation.
- `codex-upstream.mts` — the REAL `codex app-server` child (spawn with the
  desktop's argv, JSON-RPC over stdio, request-id tables both ways, restart).
- `bundled-codex.mts` — which codex that child is: `ANYENGINE_REAL_CODEX`
  while it names an executable file, else ChatGPT.app's own codex in each
  layout the app has shipped (newest first), else `CODEX_REAL`; a skipped
  setting or a missing codex is reported, never silent. `scripts/codex-shim`
  carries a bash copy; `scripts/doctor.mjs` imports this module from the
  adapter it checks.
- `codex-mux.mts` — native-codex multiplexer: thread ownership (persisted in
  `store.mts`), default route = child, merged `thread/list` / `model/list` /
  `config/read`. Hooked into `server.mts#handle` via `attachNativeCodex`.
- `native-children.mts` — spawned-child lineage from completed `spawnAgent` items
  and secondary thread announcements; retained until deletion or shutdown.
  `native-claims.mts` validates read fallbacks and applies the current claim
  posture; `claim-types.mts` is the public claim interface.
- `claim-server.mts`, `claim-turn.mts`, `claim-protocol.mts` — agent-mode Claude
  children codex spawned: the adapter's private claim socket (`owns`, `claim`,
  `ping`), trusted cwd metadata, the turn context under the claim posture, and
  the bounded NDJSON protocol.
- `rpc-shape.mts` and `codex-models.mts` — shared wire shapes and model helpers.
- `anyengine-env.mts` — environment for an interactive Claude PTY.
- `config-writes.mts` — the app's model picker: a top-level `model` or
  `review_model` pick codex cannot serve (Claude, Grok) stays in
  `$ANYENGINE_HOME/app-model-pick.json` and is laid over `config/read`, except
  where a layer codex ranks above the user file set the key (a trusted
  project, a `--profile` or `-c` flag, the legacy `managed_config.toml`
  layers); only GPT picks reach the shared `config.toml`. Profile keys go to codex, which
  refuses them. Also the merged `config/read`.
- `bridge-control.mts` — cross-engine bridge, adapter side: unix-socket control
  channel + `BridgePeer` that injects `thread/start` / `turn/start` through
  `server.mts#handle` (so the mux routes by model) and tees the spawned
  thread's notifications/approvals to the desktop peer; sub-agent projection.
  `server.mts#bridgeHost` is what it borrows from the protocol layer.
- `bridge-mcp.mts` — the `anyengine` stdio MCP server every engine spawns
  (`adapter.mjs bridge-mcp`); thin client of the control channel.
- `codex-wire.mts` — what the router reads from a Codex model request (thread,
  turn and parent ids, request kind, model). What a request says about its own
  turn comes from its body before the headers: a WebSocket's headers are the
  upgrade's, stale for later frames. Pinned to
  `test/fixtures/codex-wire-<version>.json`.
- `router-server.mts` — the AnyEngine router (Codex face): loopback guard,
  `/health`, byte-exact GPT passthrough, the `adapter.mjs router` daemon;
  hooks for the catalog, WebSockets and Claude turns are registered in
  `router-hooks.mts`. `router-log.mts` is its bounded, credential-scrubbing
  log. Relay with `passthrough` (it streams under backpressure and ties the
  caller's and the upstream's ends together); never `pipe` an upstream answer.
  `router-relay.mts` holds the relay; its `RELAY_AGENTS` / `relayAgent` are
  the only way to reach the upstream with a caller's bearer (never the global
  agents or global `fetch`, which follow a proxy named in the environment).
  `router-process.mts` is the daemon's crash, rejection and environment
  handling.

- `control-cli.mts`, `control-commands.mts` — one lazy control registry and its
  complete command registrations; importing them performs no Mac actions.
- `control-status.mts` — read-only aggregation/formatting; current, running and
  last-known data remain separate. `control-status-evidence.mts` strictly reads
  only named status inputs. Invalid evidence stays unknown and blocks healthy
  or native claims; recovery instructions come from retained `RECOVER.txt`.
- `control-doctor.mts`, `control-doctor-checks.mts` — the ordered diagnostic
  command and bounded inspections. Current health needs current identities;
  failed reads preserve unknown state and retained recovery instructions.
- `codex-config-toml.mts` — lexical assignment spans and byte-preserving edits;
  smol-toml validates before/after. Quoted keys and multiline values are data.
- `degraded.mts` — strict proof/degraded inspection and all public mutations.
  Mutators own the single short proof-degraded gate, validate before artifacts
  and reread under it. Later smoke/update callers must not wrap the same lock.
- `proof-versions.mts` — identity-stamped version cache; its synchronous probe
  uses the packaged scripts/lib/codex-probe primitive with a total 2 s deadline.
- `control-system.mts` — all control actions on the Mac, with injected subprocess
  execution for tests; process records include the captured UTC start time.
- `control-marker.mts` — validated flip journal read/write/liveness. Task26 must
  capture `processStart` and enforce its own start/token/inode lock ownership.
- `control-cache.mts` — shared models-cache inspection and exclusive backed-up
  removal; corrupt evidence stays, and removal requires a recovery directory.
- `control-rc.mts` — one guarded login-shell block and conservative hunk reversal.
- `control-install.mts` — the public on/off file API and validated shared-model
  migration. Off retains pending layers until confirmed app exit and successful
  jobs/config/cache cleanup; direct shared restore takes a required System.
- `control-install-on.mts` — one admission/planning/application path for M0
  adoption and initial/last-good installs; private recovery precedes target writes.
  Journal the public recovery forwarder through the adapter LayerWriter.
  Reconcile owned smoke enable/disable transitions after confirmed app exit,
  preserving original and immediate last-good states even at the same version.
  Optional `OnPlan.recoveryCommands` supplies only validated generation-time
  tool paths, before any artifact; production callers retain system defaults.
- `control-postflight.mts`, `control-postflight-evidence.mts` — ten ordered
  current checks and bounded observations. Require the caller's pre-restart
  frozen manifest identity/key/mode and reverify before/after mandatory work.
  Installed mandatory work uses an independent run-local probe observer outside
  the cloneable request. It remains required when scheduled smoke is disabled.
  Snapshots are observations; app-adapter postflight checks remain separate.
- `smoke.mts`, `smoke-paths.mts` — admitted installed smoke and mandatory work,
  frozen native receipts and public proof/degraded publication after cleanup.
- `smoke-client.mts`, `smoke-claude.mts` — bounded stdio/HTTP receipt handling,
  owned process groups, exact session pruning and the private restricted helper.
- `smoke-evidence.mts`, `smoke-probes.mts` — independent before/after process
  admission, strict terminal correlation and private probe lifetimes. Cleanup
  metadata is not proof authority. Private local and actual ephemeral threads
  unsubscribe; persisted Codex IDs require exact acknowledged/observed deletion.
- `control-proof.mts`, `control-proof-snapshot.mts` — independent scratch
  installs and real Bash/Node initial/router-only/last-good recovery. Relocate
  every reference before execution; preserve exact initial and immediate
  last-good baselines, retained recovery/preferences and opaque SQLite storage.
  Source homes are read-only; scratch app/job tools cannot reach production.
- `control-launchd.mts` — quoted XML jobs and positive launchctl inspection;
  failures retain evidence, and unloading requires confirmed app exit.
- `control-layers.mts` — write-ahead layer writer; initial backups are immutable,
  settled and pending states coexist until publication completes. `beginUpgrade`
  checkpoints the immediate last-good state; terminal verification precedes retirement.
  `removeFile` publishes an absent intent before nonrecursive unlink and settles
  only verified durable absence; failure retains evidence and poisons the writer.
- `control-layer-journal.mts`, `control-layer-state.mts` — strict journal authority,
  owned recovery bytes and durable IO; SQLite coordination files stay opaque.
  Invalid records block publication and pruning. Recovery lives outside `bin`/`lib`.
- `control-m0-adoption.mts`, `control-layer-restore.mts` — receipt-based M0 adoption
  and guarded initial/last-good restoration; conflicting evidence refuses mutation.
- `control-scripts.mts` — standalone Bash recovery and synchronous private
  publication for LayerWriter callbacks. Publish private recovery before the
  first writer; install `publicRecoveryScript` through the owning layer.
- `control-recovery-{shell,lifecycle,evidence,text}.mts` — embedded system Bash
  and JXA for restoration, confirmed app exit, strict live journals and
  conservative text handling. Recovery reads live pending/settled evidence;
  immutable tool options provide hermetic fixtures without ambient overrides.
- `control-logs.mts` — bounded JSONL tail and event lookup; SQLite coordination
  files and sidecars remain opaque.

## Runtime backends

Claude backends sit behind the `ClaudeRuntime` interface and are constructed in
`runtime-factory.mts` from `runtime-config.mts`:

- `native-runtime.mts` — default, in-process Claude Agent SDK.
- `http-agent-runtime.mts` — `agent-http` / `agentapi` HTTP/SSE bridges.
- `claude-p-runtime.mts` — one-shot `claude-p` transcript wrapper.
- `anyengine-runtime.mts` — interactive `claude` TUI in a warm node-pty per
  thread (subscription-billed); helpers in `anyengine-hooks.mts` (loopback hook
  server + `--settings` writer), `anyengine-proxy.mts` (SSE tee proxy +
  compaction gate), `anyengine-screen.mts` (headless xterm + dialog parsers),
  `anyengine-transcript.mts`. Hook relay: `scripts/anyengine-hook-relay.mjs`.
- `codex-proxy-runtime.mts` — legacy `codex exec` proxy, opt-in via
  `ANYENGINE_GPT_ROUTE=exec` (gpt-* threads default to the multiplexer).
- `codex-proxy-runtime.mts` — native Codex passthrough (`codex exec`).
- `grok-runtime.mts` — xAI Grok Build CLI over its agent protocol (`grok agent
  stdio`), one warm process per thread; selected per thread for `grok-*` models.
  Helpers: `grok-acp.mts` (wire → RuntimeEvent mapping, argv, permissions) and
  `grok-models.mts` (picker catalog + binary discovery).
- `mock-runtime.mts` — credential-free protocol testing (`ANYENGINE_MOCK=1`).

**Adding a backend:** create `<name>-runtime.mts` implementing `ClaudeRuntime`,
register it in `runtime-factory.mts`, and add any env knobs to
`runtime-config.mts`. The PostToolUse hook nudges if runtime code lands
elsewhere.

## Conventions

- Keep the protocol layer (`server.mts`) decoupled from any specific backend —
  it only talks to `ClaudeRuntime`.
- Compatibility-only Codex UI methods should return stable empty/inert
  responses rather than throwing (see the capability matrix in `docs/`).
- **Erasable syntax only**: no `enum`, `namespace`, or constructor parameter
  properties (`constructor(private x: T)`). Declare the field, then assign in the
  body. `tsc` (with `erasableSyntaxOnly`) and the PostToolUse hook both flag
  violations.
