# Configuration

Normal setup stores control preferences in `~/.anyengine/config.json`. Inspect
and change them through the CLI:

```bash
anyengine config
anyengine config get router.port
anyengine mode
```

Account controls and limits are described in [Control commands](control.md).
The installed setup selects the interactive Claude CLI runtime. The environment
settings below are advanced adapter/backend overrides; set them in the intended
host's environment or `~/.anyengine/runtime.env`. Existing overrides can take
precedence over managed settings, and doctor reports conflicts.

## Runtime backend

```bash
# Explicitly select the in-process Claude Agent SDK instead of the installed CLI runtime.
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
# Deprecated and ignored: Claude children authenticate through their own config.
# Provider credentials and routing controls are never inherited from the adapter.
export ANYENGINE_PTY_KEEP_API_KEY="0"
# Extra CLI flags appended to every spawn (whitespace-separated or JSON array).
export ANYENGINE_PTY_ARGS=""
# Advanced: relay script, node binary for hooks, and the private state dir.
# export ANYENGINE_PTY_HOOK_RELAY="/path/to/scripts/anyengine-hook-relay.mjs"
# export ANYENGINE_PTY_NODE="/absolute/path/to/node"
# export ANYENGINE_PTY_STATE_DIR="$HOME/.anyengine/pty"  # default ~/.anyengine/pty/<pid>; keep it out of writable roots
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

# SSH/Remote twin only (read by the shim): give the daemon a native codex child.
# Plain `codex` TUIs attach to the app-server control socket, so a daemon
# without one never owns it; the shim serves that socket with the bundled codex.
# With this set the adapter takes the control socket itself: never set it on a
# host where a codex daemon already serves that socket (a Mac running the app).
export ANYENGINE_REMOTE_NATIVE_CODEX="1"
```

## AnyEngine settings (config.json)

`~/.anyengine/config.json` holds the settings `anyengine config get|set`
and `anyengine mode` change. A missing file means the defaults. A bad value
falls back to its default, and `anyengine status` lists it with any name
AnyEngine does not know (a typo does nothing).

Native fan-out runs only on settings you wrote, since its proof is keyed on
them. A file that cannot be read or parsed, or a bad `router.enabled` or
`router.multiAgentV1`, detaches the router. These turn native fan-out off
and take the bridge path: a problem in a setting the proof is keyed on
(anything under `modes` or `claims`, `claude.models`, `claude.spawnPriority`,
one of those sections not being an object, or a `version` other than 1),
and any name AnyEngine does not know outside `smoke`, since a typo such as
`router.multiagentV1` may be the setting you meant to change.

`anyengine config set` changes one key and leaves the rest of the file as it
is, names it does not know included. While another key has an error it
refuses, names the error and writes nothing; a refused set does not create
or change the directory either. Two sets at once wait for each other through
the persistent `config.json.lock.sqlite` gate. A live updated caller is never
taken over because of age. After acquiring that gate, a set recovers legacy
`config.json.lock` markers whose process is gone or whose age exceeds a minute.
Preserve the gate and its sidecars while callers may exist. A set also makes
the directory private (mode 0700) if it was not.

| Key | Default | Meaning |
|---|---|---|
| `router.enabled` | `true` | Attach the router to the adapter's codex child. |
| `router.port` | `18790` | Loopback port of the router. |
| `router.upstream` | `https://chatgpt.com/backend-api/codex` | Where GPT traffic goes: `https://chatgpt.com/...` on the default port only (for tests, `http://127.0.0.1` on a port other than `router.port`), without credentials, query or fragment. |
| `router.multiAgentV1` | `true` | Mark the catalog v1 so native `spawn_agent` can start Claude children; `false` uses the bridge. |
| `modes.codexClaude` | `agent` | Claude in the Codex surface: `agent` (Claude Code PTY) or `model` (`claude -p` trampoline). |
| `claude.models` | opus, sonnet, haiku | Claude entries the router adds to the catalog: a JSON array of `{id, displayName, claudeModel, contextWindow}`. An id may not be a GPT id; `displayName` and `claudeModel` default to the id. A model you drop leaves `claude.spawnPriority`; move `smoke.claudeModel` off it first. |
| `claude.spawnPriority` | `["opus","sonnet","haiku"]` | Order in which they rank just after the default GPT model. |
| `claude.cli` | `null` | Absolute path of `claude` for the router, an executable file when you set it; `null` resolves it at `anyengine on`. |
| `smoke.enabled`, `smoke.hour`, `smoke.minute`, `smoke.claudeModel` | `true`, 3, 30, `haiku` | Nightly live smoke. A `smoke.claudeModel` that is not among `claude.models` is reported, and the smoke runs on the first configured model. |
| `smoke.gptModel` | `null` | GPT model for the smoke's PONG turns (never a Claude id); `null` takes the lowest-ranked listed GPT model. |
| `claims.idleReleaseMinutes`, `claims.graceMs` | 10, 3000 | Claimed Claude children: when an idle one's PTY is released, how long a claim waits for its thread. |
| `claims.unclaimedFlipThreshold` | 3 | Consecutive Claude children, spawned by a thread an adapter owns, that no adapter claimed, before the router moves to the bridge path. An aborted request, or a turn with no owning adapter anywhere, fails without counting. |

## Reference table

| Setting | Purpose |
| --- | --- |
| `ANYENGINE_ADAPTER` | Adapter entry the shim runs (default `~/.anyengine/lib/current/dist/src/adapter.mjs`, installed by `npm run install:lib`). |
| `ANYENGINE_RUNTIME_ENV` | Override the control launcher's runtime.env path (default `$ANYENGINE_ROOT/runtime.env`). |
| `ANYENGINE_NODE` | Node binary the shim launches. |
| `ANYENGINE_COMPAT_VERSION` | Codex app-server version advertised. Default: the bundled codex's own version, else `0.160.0`. The shim sets it for the adapter at every launch. Set it yourself only to override: `npm run doctor` fails while it differs from the bundled codex. |
| `ANYENGINE_VERSION_SUFFIX` | Tag after the version to distinguish the adapter from real codex (default `anyengine`; set `""` to behave exactly like upstream codex). |
| `CODEX_REAL` | A codex the app did not ship, used only when ChatGPT.app's own codex is not found: by the shim for its non-app-server commands (else the first other `codex` on PATH), and as the native-codex child when it names an executable file. Each use is reported (`shim.nonBundledCodex`, `npm run doctor`). |
| `ANYENGINE_REAL_CODEX` | Real `codex` binary spawned as the native-codex child and run by the shim's fallback. Leave it unset on a Mac with ChatGPT.app: the default is the app's own codex in whichever layout the installed app ships (26.928+: `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`, then `codex-cli/bin/codex`; 26.911 and earlier: `Contents/Resources/codex`), then `CODEX_REAL` for the child only. A value that is not an executable file (an app update moved it) is skipped for that default, with a line in the app log and a debug event, and `npm run doctor` fails until it is removed. |
| `ANYENGINE_ROUTER_URL` | Loopback router base URL checked and attached instead of the configured port (probes, tests); disabled or invalid settings still detach it. |
| `ANYENGINE_CHATGPT_APP` | The ChatGPT.app bundle whose codex is "the bundled codex" (default `/Applications/ChatGPT.app`); control commands also read its version, detect its executable, quit and open this absolute bundle path. |
| `ANYENGINE_LAUNCHCTL` / `ANYENGINE_OSASCRIPT` / `ANYENGINE_OPEN` | Set by tests; replace the tools that change the Mac. Control commands otherwise use `/bin/launchctl`, `/usr/bin/osascript` and `/usr/bin/open`. |
| `ANYENGINE_PGREP` / `ANYENGINE_PS` / `ANYENGINE_PLUTIL` | Set by tests; replace process and app-plist readers. Control commands otherwise use `/usr/bin/pgrep`, `/bin/ps` and `/usr/bin/plutil`; reader failures remain unknown rather than confirmed app exit. |
| `ANYENGINE_NATIVE_CODEX` | `0` turns the native-codex child off, even when `ANYENGINE_REAL_CODEX` names a binary (the SSH/Remote twin runs this way). Superseded as a reserve-mode workaround. |
| `ANYENGINE_REMOTE_NATIVE_CODEX` | Shim only: `1` gives the SSH/Remote twin daemon a native codex child. Without it the app-server control socket goes to the bundled codex, never to an adapter without a child. With it the adapter takes that socket, so never set it on a host with a live codex daemon. |
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
| `ANYENGINE_ALLOWED_TOOLS` | Pre-approved tools: one the thread's posture would ask about runs without the card; one the posture refuses stays refused. |
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
| `ANYENGINE_PTY_KEEP_API_KEY` | Deprecated compatibility setting; ignored. Inherited Claude/provider auth overrides are always stripped. |
| `ANYENGINE_PTY_ARGS` | Extra `claude` flags for every `anyengine` spawn. |
| `ANYENGINE_PTY_HOOK_RELAY` / `ANYENGINE_PTY_NODE` / `ANYENGINE_PTY_STATE_DIR` | Advanced `anyengine` overrides: hook relay script, node binary, state directory. |
| `ANYENGINE_MOCK` | Run the protocol without Claude credentials. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Not inherited by Claude children, including full-access threads. Claude uses its own login/configuration; the PTY may supply its own loopback proxy URL. |
| `ANYENGINE_HOME` | Adapter state directory (config, debug log, run log, sockets). Default `$CODEX_HOME/anyengine`. |
| `ANYENGINE_ROOT` | AnyEngine's own directory (default `~/.anyengine`): settings, state, claim sockets, logs, installed libs. It must be an absolute path: a relative one or `~` is an error, never read as the default. |
| `ANYENGINE_DEBUG_LOG` | Path of the JSONL debug log, or `0` / `false` to disable it. Default `$ANYENGINE_HOME/debug.jsonl`. |
| `ANYENGINE_DEBUG_LOG_MAX_BYTES` / `ANYENGINE_DEBUG_LOG_KEEP` | Rotation size and how many rotated files to keep (default 50 MB, 3). |
| `ANYENGINE_RUN_LOG` | Path of the run registry JSONL (thread / turn lifecycle, no prompt text). |
| `ANYENGINE_EFFORT` | Fallback reasoning effort when neither the turn nor saved config names one. |
| `ANYENGINE_WEBSEARCH` | `0` advertises `webSearch: false` in `modelProvider/capabilities/read`. |
| `ANYENGINE_PERMISSION_MODE` | Overrides the Claude Code permission mode for the `agent-sdk-sidecar` runtime. An explicit operator override: it can loosen what the thread's posture allows, except the shell: where no sandbox bounds it, `Bash` stays out of the session (docs/guide/bridge.md, "Shell"). |
| `ANYENGINE_SUBAGENT_TIMEOUT_MS` | How long a turn waits for a launched sub-agent before failing it. |
| `ANYENGINE_SUBAGENT_COMPLETED` | Forces the modern sub-agent presentation on (`1`) or off (`0`), overriding what the client declared at `initialize`. On, a sub-agent gets `subAgentActivity` `started` / `completed` markers. Off, it gets none of them bar `interrupted`, and a failed or orphaned child is closed with a synthetic `closeAgent` instead — which is what Codex cc 26.x needs. Unset, the adapter follows the client's `subAgentActivityCompleted` capability or a `completed` entry in `subAgentActivityKinds`. |
| `ANYENGINE_TITLE_MODEL` / `ANYENGINE_SUMMARY_MODEL` | Model used for the desktop's hidden title and summary turns. |
| `ANYENGINE_CODEX_MODELS` | Overrides the gpt-* entries added to `model/list`. |
| `ANYENGINE_DISABLE_CODEX_PROXY` | `1` hides the gpt-* models and the `codex-proxy` route. |
| `ANYENGINE_CODEX_PLUGIN_MCP` | `0` stops a Codex plugin's own stdio MCP servers being merged into an engine. |
| `ANYENGINE_BRIDGE_INSTRUCTIONS` | `0` omits the cross-engine bridge instructions from the system prompt. |
| `ANYENGINE_SMOKE_PROJECT` | Read by `scripts/smoke-anyengine.mjs` only, not the adapter: the folder the real-Claude smoke's Claude works in when `--project` is not given (the smoke stops without one). One stable folder, created if missing and never removed, so runs do not each add a new Claude project entry. |

### `agent-http` / `agentapi` / `claude-p` routes

Only read when `ANYENGINE_RUNTIME_TYPE` selects one of these experimental
backends; see [Backends](/guide/backends).

| Variable | Purpose |
| --- | --- |
| `ANYENGINE_HTTP_BASE_URL` | Bridge base URL. `ANYENGINE_AGENT_HTTP_URL` and `ANYENGINE_AGENTAPI_URL` override it per route. |
| `ANYENGINE_BRIDGE_URL` | Base URL the managed bridge is started on. |
| `ANYENGINE_HTTP_USE_SSE` | Stream over `GET /events` instead of polling. |
| `ANYENGINE_HTTP_POLL_MS` / `ANYENGINE_HTTP_TIMEOUT_MS` | Poll interval and per-request timeout. |
| `ANYENGINE_HTTP_INTERRUPT_RAW` | Send interrupts as a raw control byte rather than a JSON body. |
| `ANYENGINE_HTTP_MANAGE_BRIDGE` | Let the adapter start and stop the bridge process itself. |
| `ANYENGINE_MODE_COMMAND` | Command used to switch the bridge's mode. |
| `ANYENGINE_CLAUDE_P_COMMAND` / `_ARGS` | `claude-p` binary and extra flags. |
| `ANYENGINE_CLAUDE_P_TIMEOUT_MS` / `ANYENGINE_CLAUDE_P_STOP_TIMEOUT_RETRIES` | Per-turn timeout and stop retries. |
| `ANYENGINE_CLAUDE_P_RESUME` | Combine `--resume` with `--input-file` (verify your build first — some replay results). |
| `ANYENGINE_CLAUDE_P_SKIP_PERMISSIONS` | Pass `--dangerously-skip-permissions` regardless of the thread's posture (an explicit operator opt-in; without it only an unrestricted posture passes the flag). |
| `ANYENGINE_GROK_TURN_TIMEOUT_MS` / `_STARTUP_TIMEOUT_MS` / `_IDLE_MS` | Grok per-turn, startup and idle-reap timings. |

### Direct WebSocket authentication

`ANYENGINE_WS_TOKEN` configures the raw WebSocket listener's exact bearer.
When genuinely unset, the existing no-Origin raw caller contract remains;
an explicitly empty value rejects every upgrade. Every Origin header is
rejected, including an empty one. `anyengine codex` and its headless probe
always generate a nonempty per-run token in memory; do not persist that token
in configuration or logs.

`ANYENGINE_REMOTE_TOKEN` is the launch-owned child environment variable named
by the vendor CLI's `--remote-auth-token-env` flag. The host supplies it only to
its private remote CLI. It is not a user setting and is never a token argument.

### Set by the adapter, not by you

These are passed into a child process by the adapter itself, or by AnyEngine's
LaunchAgents. They are listed so a stray value in a shell is recognisable, not
because they are settings.

| Variable | Purpose |
| --- | --- |
| `ANYENGINE_TRAMPOLINE_SOCKET` | Private per-turn Codex tool socket used by the model-mode MCP proxy; created under `~/.anyengine/router/tools/` and removed when its Claude child ends. |
| `ANYENGINE_PTY_HOOK_URL` / `_TOKEN` | Loopback hook-server address and token handed to `anyengine-hook-relay.mjs` through the PTY environment. |
| `ANYENGINE_LAUNCHD_LOG` | Set by the router's LaunchAgent: the file launchd appends the router's output to (`~/.anyengine/logs/router.launchd.log`). The router keeps it under 200 KB while it runs, and only when it is a plain file directly in `$ANYENGINE_ROOT/logs` ([Router](/guide/router)). |


Claude child processes use one shared environment filter, selected by the effective
shell mode. Full-access threads with shell mode `bash` inherit the operator's
environment except Claude/provider steering controls. This preserves
`SSH_AUTH_SOCK`, `GH_TOKEN`, cloud SDK credentials, `EDITOR`, nvm/pyenv variables
and other ordinary shell configuration.

Every other mode (`exec`, shell off, planning and read-restricted threads) retains
the strict Task 2c allowlist: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`,
`LANG`, `LC_*`, `TMPDIR`, `TERM`, `CLAUDE_CONFIG_DIR`, and `ANYENGINE_*`.
The router's model-mode trampoline, capability probes and compaction always use
this strict default, even when the parent has full access.

Full access excludes `ANTHROPIC_*`, `CLAUDE_*` (except `CLAUDE_CONFIG_DIR`),
internal Claude markers, `OPENAI_*`, provider selectors, alternative OAuth,
remote/host-runner settings and authentication controls, proxy overrides,
Node/Bun/native loader and TLS controls, and telemetry destinations. The
[Task 2d report](../superpowers/reports/2026-10-02-t02d-environment.md) lists every
denied name/pattern and its reason, including the Claude 2.1.287 binary audit.
General AWS, Google Cloud and Azure credentials remain available to full-access
Bash; Claude's provider-selection overrides do not.

Each launch supplies its own trusted controls after filtering. The PTY supplies
terminal/resume controls and hook URL/token, and turns Claude's prompt
suggestions off (`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`): a server-side
flag enables them for some accounts, they cost a model request after every
turn that the app never shows, and their faint placeholder sits in the empty
composer (the composer check reads faint text as empty either way). Its SSE
proxy supplies the loopback `ANTHROPIC_BASE_URL` and first-party marker. The trampoline supplies MCP tool
description-length and timeout limits. These controls are never inherited.

Bridge-authored turns disable Claude slash commands and prefix leading slash text
with a visible prose marker. Model-authored text also loses terminal control
characters (except newline and tab) before paste. Changing turn authorship
respawns a warm PTY with the appropriate flags. Rehome/handover prefixes are also
treated as model text. **Existing operator limitation:** the PTY paste layer
prefixes operator slash text with a space, so Claude 2.1.287 sends it to the model
as prose rather than dispatching the native slash command. Task 2c preserves
that pre-existing behavior; omitting the disable flag does not restore commands.

Custom permission profiles and deny-read restrictions received over the wire set a persistent,
conservative read restriction. Until per-path read policies are supported, these
threads have no Claude file or shell tools (including sandboxed bridge `exec`).
A later built-in profile selection does not silently clear that restriction.
Bridge sends apply a caller's new restriction to older children before their next
turn. Such callers can spawn or drive only Claude children; GPT and Grok
delegation is refused until their runtimes can enforce the same read limit.


Local Codex requirements are read at adapter startup and every posture resolution:
`/etc/codex/requirements.toml` and the macOS preference `com.openai.codex` /
`requirements_toml_base64` (decoded as base64 TOML). The preference query is cached
for at most five seconds. Any `permissions.filesystem.deny_read` key restricts
**every** thread, including existing threads and built-in profiles. Unreadable,
malformed or oversized sources and failed preference queries restrict reads too;
a missing file or missing preference does not. A parsed TOML dependency handles
quoted keys, dotted keys and inline tables. The wire scan is only a conservative
superset: Codex 0.159 does not send these requirement fields over app-server.
Local requirements are applied only while resolving a posture, never persisted in
thread rows or inherited as a permanent restriction. A failed source that recovers
restores the thread's own tools; a wire restriction remains sticky.

The legacy `/etc/codex/managed_config.toml` file and `com.openai.codex` preference
`config_toml_base64` fail closed on **presence**, including malformed/unreadable
sources. Their older approval/sandbox semantics are not projected into read access.
Observed `config/read` layer/origin metadata for `enterpriseManaged`,
`compositeEnterpriseManaged`, `cloudConfigFragment` or either legacy managed
source also restricts every thread. A complete layers snapshot refreshes that
observation; a partial response cannot clear it.

**Cloud requirements are not read locally.** Codex's
`CompositeEnterpriseManaged` pseudo-path (`<enterprise-managed:…>/requirements.toml`)
and `CloudConfigFragment` are not local policy files. Layer metadata can reveal
managed configuration, but a requirements-only cloud bundle may have no visible
config layer or origin, and no metadata is known before Codex returns it. Such
undisclosed cloud-only deny-read policies remain unhandled; do not rely on this
adapter to inherit them. Source semantics were checked against the
[Codex 0.160 loader](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/config/src/loader/mod.rs)
and [config provenance schema](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/config.rs).

| Variable | Purpose |
| --- | --- |
| `ANYENGINE_REQUIREMENTS_FILE` | Override `/etc/codex/requirements.toml` for isolated requirement-source tests. Must be trusted operator configuration. |
| `ANYENGINE_MANAGED_CONFIG_FILE` | Override `/etc/codex/managed_config.toml` for isolated tests; any present source restricts reads. Trusted operator configuration only. |
| `ANYENGINE_MDM_CONFIG_FILE` | Read the legacy managed preference from this file instead of querying `config_toml_base64`; any present source restricts reads. Trusted operator configuration only. |
| `ANYENGINE_MDM_REQUIREMENTS_FILE` | Read base64 TOML from this file instead of querying macOS managed preferences; isolated tests only. An absent file means no MDM requirements. Must be trusted operator configuration. |

When a bridge caller cannot be identified and any active local or upstream thread
restricts reads, spawning is refused. Claude startup offers are handled explicitly;
unknown dialogs block prompt submission, including offers appearing after the
composer first becomes ready. The auto-mode default offer is declined.


Claude composer readiness is structural: the input row sits between horizontal
rules. Shortcut hints and mode/status footers are not required. Faint text in the
input row (an example-prompt placeholder such as `Try "refactor <filepath>"`, a
queued-message hint, a prompt suggestion) is not input, so such a composer reads
as empty; dialogs are still read from everything on the screen. The default
layout and `"tui": "fullscreen"` (inline, as the PTY runs it, or on the alternate
screen with the composer pinned to the bottom rows) share that frame. Unknown dialogs
block paste, Enter and steering, then produce a bounded error naming the dialog
and the thread directory where it can be answered manually. Auto-mode offers are
declined while preserving manual, plan or accept-edits mode. Real 2.1.287 screens
and a sandboxed zero-spend production-paste probe cover each mode in both layouts
(`scripts/probe-claude-composer.mjs`; `PROBE_TUI=fullscreen`, `PROBE_ALT_SCREEN=1`
and `PROBE_PROMPT_SUGGESTIONS=1` select the variants).

### Recovery tool selection

Generated Node-free recovery records its configured app, bundle id and system
tool paths when published. It ignores ambient `ANYENGINE_LAUNCHCTL`,
`ANYENGINE_OSASCRIPT`, `ANYENGINE_OPEN`, `ANYENGINE_PGREP` and
`ANYENGINE_PLUTIL` overrides; the Node control test seams above are separate.
Recovery waits up to 30 seconds for exit. Fixture generators can pass absolute
`RecoveryOptions.commands` and `quitWaitSeconds` (0–3600), baked into the script.
`ANYENGINE_QUIT_WAIT` is not a runtime recovery setting.
