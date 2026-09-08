# Configuration

All configuration is environment-driven (`CLAUDE_CODEX_*`). Set these in the
remote login shell (e.g. `~/.zshenv`) or in `~/.claude-codex/runtime.env`.

## Runtime backend

```bash
# Default uses the in-process Claude Agent SDK.
export CLAUDE_CODEX_RUNTIME_TYPE="agent-sdk-sidecar"
#   codex      - pass app-server through to the real Codex CLI (shim layer)
#   agent-http - HTTP/SSE bridge for Claude Code Channels / agent-http
#   agentapi   - HTTP/SSE bridge for coder/agentapi
#   claude-p   - one-shot PTY/transcript wrapper via claude-p
#   jinn-pty   - interactive `claude` TUI in a warm PTY per thread (subscription)
#   mock       - local protocol testing
```

See [Backends](/guide/backends) for what each route supports.

## Provider and agent-loop selection

Provider selection is descriptor metadata plus routing to existing runtime
backends. It does not add a new provider runtime, auth flow, subscription model,
gateway, or entitlement.

```bash
# Known provider descriptor ids.
export CLAUDE_CODEX_PROVIDER="claude-code" # or "codex"

# Known agent-loop ids.
export CLAUDE_CODEX_AGENT_LOOP="native-claude-code-sdk" # or "codex-jsonl-proxy"
```

Current mappings:

| Provider / loop | Existing runtime behavior |
| --- | --- |
| `claude-code` / `native-claude-code-sdk` | `agent-sdk-sidecar` |
| `codex` / `codex-jsonl-proxy` | `codex-proxy` |

Backward compatibility rules:

- `CLAUDE_CODEX_RUNTIME_TYPE`, `CLAUDE_CODEX_RUNTIME`, and
  `CLAUDE_CODEX_BACKEND` still override provider selection when set.
- `CLAUDE_CODEX_MOCK=1` still forces the `mock` runtime.
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
export CLAUDE_CODEX_DEFAULT_MODEL="sonnet"
export CLAUDE_CODEX_DEFAULT_EFFORT="medium"

# Codex App model picker list (comma-separated ids or JSON array of ids/objects).
export CLAUDE_CODEX_MODELS="sonnet,opus,haiku,sonnet-1m,opus-plan"

# Map Codex UI ids -> Claude SDK aliases/full names, and effort values.
export CLAUDE_CODEX_MODEL_ALIASES='{"my-long-context":"sonnet[1m]"}'
export CLAUDE_CODEX_EFFORT_ALIASES='{"xhigh":"max"}'
```

## MCP, tools & directories

```bash
# Passed to ClaudeAgentOptions (JSON object or path to a JSON file).
export CLAUDE_CODEX_MCP_SERVERS='{"github":{"type":"stdio","command":"github-mcp"}}'

# Pre-approved tools (others still route through Codex approval) + extra dirs.
export CLAUDE_CODEX_ALLOWED_TOOLS="Read,Glob,Grep"
export CLAUDE_CODEX_ADD_DIRS="/repo/shared,/repo/docs"
export CLAUDE_CODEX_ENABLE_FILE_CHECKPOINTING=1
```

## Cross-engine bridge

```bash
# The `jinn_bridge` MCP server every engine gets (docs/guide/bridge.md) is on
# by default; 0 disables it.
export CLAUDE_CODEX_BRIDGE=1
# Pin the loopback control socket / token (default: bridge-<pid>.sock under the
# adapter home and a random per-process token). The three variables below are
# what the adapter passes to each engine's bridge process; set them by hand
# only for a hand-written MCP config that runs scripts/bridge-mcp.mjs.
# export CLAUDE_CODEX_BRIDGE_SOCKET="$HOME/.codex/claude-codex-adapter/bridge.sock"
# export CLAUDE_CODEX_BRIDGE_TOKEN="..."
# export CLAUDE_CODEX_BRIDGE_THREAD="<calling thread id>"
```

## Worktree isolation

```bash
# Per-thread git worktree isolation (off by default — it creates branches).
export CLAUDE_CODEX_AUTO_WORKTREE=1
export CLAUDE_CODEX_WORKTREE_ROOT="$HOME/.claude-codex/worktrees"
```

When enabled, each new Codex thread runs in a dedicated `git worktree`.

## jinn-pty runtime

```bash
export CLAUDE_CODEX_RUNTIME_TYPE="jinn-pty"
# Interactive claude binary (default: `claude` on PATH). A .mjs/.js path runs under node.
export CLAUDE_CODEX_CLI="claude"
# PTY geometry (defaults 120x40).
export CLAUDE_CODEX_PTY_COLS="120"
export CLAUDE_CODEX_PTY_ROWS="40"
# Wall-clock cap per turn in ms (default 3600000; 0 = none). The transcript is
# consulted before a timed-out turn is failed.
export CLAUDE_CODEX_PTY_TURN_TIMEOUT_MS="3600000"
# How long a turn stays open for background Task sub-agents to report back
# (default 600000; 0 = do not wait).
export CLAUDE_CODEX_PTY_ASYNC_SUBAGENT_TIMEOUT_MS="600000"
# Time allowed for the TUI to reach its composer after a cold spawn (default 30000).
export CLAUDE_CODEX_PTY_STARTUP_TIMEOUT_MS="30000"
# Per-token streaming through the loopback SSE tee proxy (default 1).
export CLAUDE_CODEX_PTY_STREAM_PROXY="1"
# Seconds Claude Code waits for a hook (PreToolUse blocks on the App's approval; default 3600).
export CLAUDE_CODEX_PTY_HOOK_TIMEOUT_S="3600"
# Answer Claude Code's hardcoded safety prompts from the screen (default 1).
export CLAUDE_CODEX_PTY_AUTO_APPROVE_SAFETY_PROMPTS="1"
# Keep ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the PTY env (default 0, so the
# TUI authenticates with the subscription login).
export CLAUDE_CODEX_PTY_KEEP_API_KEY="0"
# Extra CLI flags appended to every spawn (whitespace-separated or JSON array).
export CLAUDE_CODEX_PTY_ARGS=""
# Advanced: relay script, node binary for hooks, and the private state dir.
# export CLAUDE_CODEX_PTY_HOOK_RELAY="/path/to/scripts/jinn-pty-hook-relay.mjs"
# export CLAUDE_CODEX_PTY_NODE="/absolute/path/to/node"
# export CLAUDE_CODEX_PTY_STATE_DIR="/tmp/claude-codex-pty"
```

## Daemon

```bash
# Idle shutdown grace period in ms (default 15000; 0 = never exit).
# The jinn-pty runtime defaults this to 0 so its warm PTYs survive between turns.
export CLAUDE_CODEX_IDLE_EXIT_MS="15000"

# Pin a node binary for the shim (e.g. when default node is < 24).
export CLAUDE_CODEX_NODE="/absolute/path/to/node"
```

## Reference table

| Setting | Purpose |
| --- | --- |
| `CLAUDE_CODEX_ADAPTER` | Path to `dist/src/adapter.mjs` (used by the shim). |
| `CLAUDE_CODEX_NODE` | Node binary the shim launches. |
| `CLAUDE_CODEX_COMPAT_VERSION` | Codex app-server version advertised (default `0.142.3`). |
| `CLAUDE_CODEX_VERSION_SUFFIX` | Tag after the version to distinguish the adapter from real codex (default `claude-codex`; set `""` to behave exactly like upstream codex). |
| `CODEX_REAL` | Real Codex CLI for non-app-server commands / `codex` passthrough. |
| `CLAUDE_CODEX_REAL_CODEX` | Real `codex` binary spawned as the native-codex child (default: the bundled desktop binary, then `CODEX_REAL`). |
| `CLAUDE_CODEX_NATIVE_CODEX` | `0` disables auto-detecting the real binary (explicit `CLAUDE_CODEX_REAL_CODEX` still applies). |
| `CLAUDE_CODEX_GPT_ROUTE` | `native` (default, real app-server child) or `exec` (legacy `codex exec` proxy) for gpt-* threads. |
| `CLAUDE_CODEX_TITLE_ROUTE` | `real` (default) or `local` for the desktop's hidden title/summary threads under the multiplexer. |
| `CLAUDE_CODEX_RUNTIME_TYPE` | Active backend route. |
| `CLAUDE_CODEX_PROVIDER` | Provider descriptor id (`claude-code` or `codex`) mapped only to existing runtime behavior. |
| `CLAUDE_CODEX_AGENT_LOOP` | Agent-loop id (`native-claude-code-sdk` or `codex-jsonl-proxy`) mapped only to existing runtime behavior. |
| `provider_loop_provider` | Saved config key for provider descriptor selection via `config/value/write`. |
| `provider_loop_agent_loop` | Saved config key for agent-loop selection via `config/value/write`. |
| `CLAUDE_CODEX_DEFAULT_MODEL` / `_EFFORT` | Defaults for new threads. |
| `CLAUDE_CODEX_MODELS` | Codex App model picker list. |
| `CLAUDE_CODEX_GROK_MODELS` | Grok entries for the picker (comma list or JSON array); default is `grok models` output when a grok binary is found. |
| `CLAUDE_CODEX_GROK_BIN` | xAI `grok` binary for the `grok` runtime (default: `PATH`, then `~/.local/bin/grok`). |
| `CLAUDE_CODEX_GROK_ARGS` / `_IDLE_MS` / `_TURN_TIMEOUT_MS` / `_STARTUP_TIMEOUT_MS` | Extra `grok agent` flags, idle process reap, per-turn and startup timeouts. |
| `CLAUDE_CODEX_DISABLE_GROK` | `1` hides the Grok models. |
| `CLAUDE_CODEX_MODEL_ALIASES` / `_EFFORT_ALIASES` | Id remapping. |
| `CLAUDE_CODEX_MCP_SERVERS` | MCP server config (JSON or file path). |
| `CLAUDE_CODEX_BRIDGE` | `0` disables the cross-engine `jinn_bridge` MCP server (default on). |
| `CLAUDE_CODEX_BRIDGE_SOCKET` / `_TOKEN` | Pin the bridge control socket / token (default: per-process). |
| `CLAUDE_CODEX_BRIDGE_THREAD` | Calling thread id handed to a bridge process (set by the adapter per engine process). |
| `CLAUDE_CODEX_ALLOWED_TOOLS` | Pre-approved tools. |
| `CLAUDE_CODEX_ADD_DIRS` | Extra directories exposed to Claude. |
| `CLAUDE_CODEX_ENABLE_FILE_CHECKPOINTING` | Enable SDK file checkpointing. |
| `CLAUDE_CODEX_AUTO_WORKTREE` / `_WORKTREE_ROOT` | Per-thread worktree isolation. |
| `CLAUDE_CODEX_IDLE_EXIT_MS` | Daemon idle shutdown (jinn-pty defaults to 0). |
| `CLAUDE_CODEX_CLI` | Interactive `claude` binary for `jinn-pty`. |
| `CLAUDE_CODEX_PTY_COLS` / `_ROWS` | PTY geometry for `jinn-pty`. |
| `CLAUDE_CODEX_PTY_TURN_TIMEOUT_MS` | Per-turn wall-clock cap for `jinn-pty`. |
| `CLAUDE_CODEX_PTY_ASYNC_SUBAGENT_TIMEOUT_MS` | How long a `jinn-pty` turn waits for background Task sub-agents to report back (default 600000; 0 disables). |
| `CLAUDE_CODEX_PTY_STARTUP_TIMEOUT_MS` | Cold-spawn readiness wait for `jinn-pty`. |
| `CLAUDE_CODEX_PTY_STREAM_PROXY` | SSE tee proxy for per-token streaming (`1`/`0`). |
| `CLAUDE_CODEX_PTY_HOOK_TIMEOUT_S` | Hook command timeout Claude Code applies. |
| `CLAUDE_CODEX_PTY_AUTO_APPROVE_SAFETY_PROMPTS` | Answer hardcoded TUI safety prompts from the screen. |
| `CLAUDE_CODEX_PTY_KEEP_API_KEY` | Keep API-key env vars in the PTY (default stripped). |
| `CLAUDE_CODEX_PTY_ARGS` | Extra `claude` flags for every `jinn-pty` spawn. |
| `CLAUDE_CODEX_PTY_HOOK_RELAY` / `_NODE` / `_STATE_DIR` | Advanced `jinn-pty` overrides. |
| `CLAUDE_CODEX_MOCK` | Run the protocol without Claude credentials. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Claude auth / custom endpoint configuration. Keep real values out of git. |
