# Configuration

All configuration is environment-driven (`ANYENGINE_*`). Set these in the
remote login shell (e.g. `~/.zshenv`) or in `~/.anyengine/runtime.env`.

## Runtime backend

```bash
# Default uses the in-process Claude Agent SDK.
export ANYENGINE_RUNTIME_TYPE="agent-sdk-sidecar"
#   codex      - pass app-server through to the real Codex CLI (shim layer)
#   agent-http - HTTP/SSE bridge for Claude Code Channels / agent-http
#   agentapi   - HTTP/SSE bridge for coder/agentapi
#   claude-p   - one-shot PTY/transcript wrapper via claude-p
#   anyengine   - interactive `claude` TUI in a warm PTY per thread (subscription)
#   mock       - local protocol testing
```

See [Backends](/guide/backends) for what each route supports.

## Provider and agent-loop selection

Provider selection is descriptor metadata plus routing to existing runtime
backends. It does not add a new provider runtime, auth flow, subscription model,
gateway, or entitlement.

```bash
# Known provider descriptor ids.
export ANYENGINE_PROVIDER="claude-code" # or "codex"

# Known agent-loop ids.
export ANYENGINE_AGENT_LOOP="native-claude-code-sdk" # or "codex-jsonl-proxy"
```

Current mappings:

| Provider / loop | Existing runtime behavior |
| --- | --- |
| `claude-code` / `native-claude-code-sdk` | `agent-sdk-sidecar` |
| `codex` / `codex-jsonl-proxy` | `codex-proxy` |

Backward compatibility rules:

- `ANYENGINE_RUNTIME_TYPE`, `ANYENGINE_RUNTIME`, and
  `ANYENGINE_BACKEND` still override provider selection when set.
- `ANYENGINE_MOCK=1` still forces the `mock` runtime.
- Saved config can set `provider_loop_provider` and
  `provider_loop_agent_loop` through `config/value/write`.
- Raw saved selection keys are filtered out of public `config/read`; the safe
  projection appears under `config.provider_loop_config.selection`, with
  redacted validation issues when a selection is unknown or mismatched.

Selection must stay within supported credential ownership models. It does not
collect or share credentials, pool personal subscriptions, reuse browser cookies
or session tokens, configure private endpoints, or bypass provider terms.

## Models & effort

```bash
# Defaults for new threads, surfaced through config/read.
export ANYENGINE_DEFAULT_MODEL="sonnet"
export ANYENGINE_DEFAULT_EFFORT="medium"

# Codex App model picker list (comma-separated ids or JSON array of ids/objects).
export ANYENGINE_MODELS="sonnet,opus,haiku,sonnet-1m,opus-plan"

# Map Codex UI ids -> Claude SDK aliases/full names, and effort values.
export ANYENGINE_MODEL_ALIASES='{"my-long-context":"sonnet[1m]"}'
export ANYENGINE_EFFORT_ALIASES='{"xhigh":"max"}'
```

## MCP, tools & directories

```bash
# Passed to ClaudeAgentOptions (JSON object or path to a JSON file).
export ANYENGINE_MCP_SERVERS='{"github":{"type":"stdio","command":"github-mcp"}}'

# Pre-approved tools (others still route through Codex approval) + extra dirs.
export ANYENGINE_ALLOWED_TOOLS="Read,Glob,Grep"
export ANYENGINE_ADD_DIRS="/repo/shared,/repo/docs"
export ANYENGINE_ENABLE_FILE_CHECKPOINTING=1
```

## Cross-engine bridge

```bash
# The `anyengine` MCP server every engine gets (docs/guide/bridge.md) is on
# by default; 0 disables it.
export ANYENGINE_BRIDGE=1
# Pin the loopback control socket / token (default: bridge-<pid>.sock under the
# adapter home and a random per-process token). The three variables below are
# what the adapter passes to each engine's bridge process; set them by hand
# only for a hand-written MCP config that runs scripts/bridge-mcp.mjs.
# export ANYENGINE_BRIDGE_SOCKET="$HOME/.codex/anyengine/bridge.sock"
# export ANYENGINE_BRIDGE_TOKEN="..."
# export ANYENGINE_BRIDGE_THREAD="<calling thread id>"
```

## Worktree isolation

```bash
# Per-thread git worktree isolation (off by default — it creates branches).
export ANYENGINE_AUTO_WORKTREE=1
export ANYENGINE_WORKTREE_ROOT="$HOME/.anyengine/worktrees"
```

When enabled, each new Codex thread runs in a dedicated `git worktree`.

## anyengine runtime

```bash
export ANYENGINE_RUNTIME_TYPE="anyengine"
# Interactive claude binary (default: `claude` on PATH). A .mjs/.js path runs under node.
export ANYENGINE_CLI="claude"
# PTY geometry (defaults 120x40).
export ANYENGINE_PTY_COLS="120"
export ANYENGINE_PTY_ROWS="40"
# Wall-clock cap per turn in ms (default 3600000; 0 = none). The transcript is
# consulted before a timed-out turn is failed.
export ANYENGINE_PTY_TURN_TIMEOUT_MS="3600000"
# How long a turn stays open for background Task sub-agents to report back
# (default 600000; 0 = do not wait).
export ANYENGINE_PTY_ASYNC_SUBAGENT_TIMEOUT_MS="600000"
# Time allowed for the TUI to reach its composer after a cold spawn (default 30000).
export ANYENGINE_PTY_STARTUP_TIMEOUT_MS="30000"
# Per-token streaming through the loopback SSE tee proxy (default 1).
export ANYENGINE_PTY_STREAM_PROXY="1"
# Seconds Claude Code waits for a hook (PreToolUse blocks on the App's approval; default 3600).
export ANYENGINE_PTY_HOOK_TIMEOUT_S="3600"
# Answer Claude Code's hardcoded safety prompts from the screen (default 1).
export ANYENGINE_PTY_AUTO_APPROVE_SAFETY_PROMPTS="1"
# Keep ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the PTY env (default 0, so the
# TUI authenticates with the subscription login).
export ANYENGINE_PTY_KEEP_API_KEY="0"
# Extra CLI flags appended to every spawn (whitespace-separated or JSON array).
export ANYENGINE_PTY_ARGS=""
# Advanced: relay script, node binary for hooks, and the private state dir.
# export ANYENGINE_PTY_HOOK_RELAY="/path/to/scripts/anyengine-hook-relay.mjs"
# export ANYENGINE_PTY_NODE="/absolute/path/to/node"
# export ANYENGINE_PTY_STATE_DIR="/tmp/anyengine-pty"
```

## Reserve mode

```bash
# On by default. While the account's Codex usage is spent, the desktop hides
# the whole model picker (Claude and Grok included) and shows a blocking usage
# banner on any host that reports a ChatGPT account. The adapter reads the
# child's `account/rateLimits/read` (once at the handshake, then every five
# minutes) and, while the limit is reached, answers `account/read`,
# `getAuthStatus` and `account/updated` with the externally-authenticated shape
# it serves when there is no Codex child, and strips the reserve markers from
# the rate-limit payloads it forwards. The child keeps running and gpt-* threads
# still reach it, so they still fail with the account's own usage-limit error.
# The transform stops with the first read that says the limit lifted.
export ANYENGINE_AUTO_RESERVE=0   # turn it off
```

Superseded by the above, kept working for one release:
`ANYENGINE_HIDE_RATE_LIMIT_UPSELL=1` strips the same markers unconditionally
*and* empties the OpenAI half of the model list, and `ANYENGINE_NATIVE_CODEX=0`
removes the child altogether. Neither follows the limit back down. See
[the A4 evidence](https://github.com/hristo2612/anyengine/blob/main/docs/evidence/a4-auto-reserve.md).

## Mid-thread engine switching

```bash
# Routing follows the model on each turn. When it names another engine the
# thread is handed over, carrying a compact transcript of the conversation so
# far. This caps that block; past it the first user message and the most recent
# exchanges are kept, with a one-line note about the gap (default 12000).
export ANYENGINE_REHOME_MAX_CHARS="12000"
```

Ownership (the engine, and the real Codex thread id behind it) is stored in the
adapter's `state.sqlite`, so a switch survives a restart. See
[the A5 evidence](https://github.com/hristo2612/anyengine/blob/main/docs/evidence/a5-mid-thread-switch.md).

## Daemon

```bash
# Idle shutdown grace period in ms (default 15000; 0 = never exit).
# The anyengine runtime defaults this to 0 so its warm PTYs survive between turns.
export ANYENGINE_IDLE_EXIT_MS="15000"

# Pin a node binary for the shim (e.g. when default node is < 24).
export ANYENGINE_NODE="/absolute/path/to/node"
```

## Reference table

| Setting | Purpose |
| --- | --- |
| `ANYENGINE_ADAPTER` | Path to `dist/src/adapter.mjs` (used by the shim). |
| `ANYENGINE_NODE` | Node binary the shim launches. |
| `ANYENGINE_COMPAT_VERSION` | Codex app-server version advertised (default `0.142.3`). |
| `ANYENGINE_VERSION_SUFFIX` | Tag after the version to distinguish the adapter from real codex (default `anyengine`; set `""` to behave exactly like upstream codex). |
| `CODEX_REAL` | Real Codex CLI for non-app-server commands / `codex` passthrough. |
| `ANYENGINE_REAL_CODEX` | Real `codex` binary spawned as the native-codex child (default: the bundled desktop binary, then `CODEX_REAL`). |
| `ANYENGINE_NATIVE_CODEX` | `0` disables auto-detecting the real binary (explicit `ANYENGINE_REAL_CODEX` still applies). Superseded as a reserve-mode workaround. |
| `ANYENGINE_AUTO_RESERVE` | `0` disables the automatic reserve-mode handling (default on). |
| `ANYENGINE_HIDE_RATE_LIMIT_UPSELL` | Legacy: strip the reserve markers unconditionally and hide the OpenAI models. Superseded by `ANYENGINE_AUTO_RESERVE`. |
| `ANYENGINE_REHOME_MAX_CHARS` | Cap on the transcript carried to another engine mid-thread (default 12000). |
| `ANYENGINE_GPT_ROUTE` | `native` (default, real app-server child) or `exec` (legacy `codex exec` proxy) for gpt-* threads. |
| `ANYENGINE_TITLE_ROUTE` | `real` (default) or `local` for the desktop's hidden title/summary threads under the multiplexer. |
| `ANYENGINE_RUNTIME_TYPE` | Active backend route. |
| `ANYENGINE_PROVIDER` | Provider descriptor id (`claude-code` or `codex`) mapped only to existing runtime behavior. |
| `ANYENGINE_AGENT_LOOP` | Agent-loop id (`native-claude-code-sdk` or `codex-jsonl-proxy`) mapped only to existing runtime behavior. |
| `provider_loop_provider` | Saved config key for provider descriptor selection via `config/value/write`. |
| `provider_loop_agent_loop` | Saved config key for agent-loop selection via `config/value/write`. |
| `ANYENGINE_DEFAULT_MODEL` / `_EFFORT` | Defaults for new threads. |
| `ANYENGINE_MODELS` | Codex App model picker list. |
| `ANYENGINE_GROK_MODELS` | Grok entries for the picker (comma list or JSON array); default is `grok models` output when a grok binary is found. |
| `ANYENGINE_GROK_BIN` | xAI `grok` binary for the `grok` runtime (default: `PATH`, then `~/.local/bin/grok`). |
| `ANYENGINE_GROK_ARGS` / `_IDLE_MS` / `_TURN_TIMEOUT_MS` / `_STARTUP_TIMEOUT_MS` | Extra `grok agent` flags, idle process reap, per-turn and startup timeouts. |
| `ANYENGINE_DISABLE_GROK` | `1` hides the Grok models. |
| `ANYENGINE_MODEL_ALIASES` / `_EFFORT_ALIASES` | Id remapping. |
| `ANYENGINE_MCP_SERVERS` | MCP server config (JSON or file path). |
| `ANYENGINE_BRIDGE` | `0` disables the cross-engine `anyengine` MCP server (default on). |
| `ANYENGINE_BRIDGE_SOCKET` / `_TOKEN` | Pin the bridge control socket / token (default: per-process). |
| `ANYENGINE_BRIDGE_THREAD` | Calling thread id handed to a bridge process (set by the adapter per engine process). |
| `ANYENGINE_ALLOWED_TOOLS` | Pre-approved tools. |
| `ANYENGINE_ADD_DIRS` | Extra directories exposed to Claude. |
| `ANYENGINE_ENABLE_FILE_CHECKPOINTING` | Enable SDK file checkpointing. |
| `ANYENGINE_AUTO_WORKTREE` / `_WORKTREE_ROOT` | Per-thread worktree isolation. |
| `ANYENGINE_IDLE_EXIT_MS` | Daemon idle shutdown (anyengine defaults to 0). |
| `ANYENGINE_CLI` | Interactive `claude` binary for `anyengine`. |
| `ANYENGINE_PTY_COLS` / `_ROWS` | PTY geometry for `anyengine`. |
| `ANYENGINE_PTY_TURN_TIMEOUT_MS` | Per-turn wall-clock cap for `anyengine`. |
| `ANYENGINE_PTY_ASYNC_SUBAGENT_TIMEOUT_MS` | How long a `anyengine` turn waits for background Task sub-agents to report back (default 600000; 0 disables). |
| `ANYENGINE_PTY_STARTUP_TIMEOUT_MS` | Cold-spawn readiness wait for `anyengine`. |
| `ANYENGINE_PTY_STREAM_PROXY` | SSE tee proxy for per-token streaming (`1`/`0`). |
| `ANYENGINE_PTY_HOOK_TIMEOUT_S` | Hook command timeout Claude Code applies. |
| `ANYENGINE_PTY_AUTO_APPROVE_SAFETY_PROMPTS` | Answer hardcoded TUI safety prompts from the screen. |
| `ANYENGINE_PTY_KEEP_API_KEY` | Keep API-key env vars in the PTY (default stripped). |
| `ANYENGINE_PTY_ARGS` | Extra `claude` flags for every `anyengine` spawn. |
| `ANYENGINE_PTY_HOOK_RELAY` / `_NODE` / `_STATE_DIR` | Advanced `anyengine` overrides. |
| `ANYENGINE_MOCK` | Run the protocol without Claude credentials. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Claude auth / custom endpoint configuration. Keep real values out of git. |
