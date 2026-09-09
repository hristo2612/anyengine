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
- `codex-mux.mts` — native-codex multiplexer: thread ownership (persisted in
  `store.mts`), default route = child, merged `thread/list` / `model/list` /
  `config/read`. Hooked into `server.mts#handle` via `attachNativeCodex`.
- `bridge-control.mts` — cross-engine bridge, adapter side: unix-socket control
  channel + `BridgePeer` that injects `thread/start` / `turn/start` through
  `server.mts#handle` (so the mux routes by model) and tees the spawned
  thread's notifications/approvals to the desktop peer; sub-agent projection.
  `server.mts#bridgeHost` is what it borrows from the protocol layer.
- `bridge-mcp.mts` — the `anyengine` stdio MCP server every engine spawns
  (`adapter.mjs bridge-mcp`); thin client of the control channel.

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
