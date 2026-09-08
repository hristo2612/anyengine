# Backends

The adapter's internal Codex protocol layer talks to a small `ClaudeRuntime`
interface, so non-SDK Claude Code bridges can be selected without removing the
default Agent SDK route.

| Backend | Status | Streaming | Approvals / diffs |
| --- | --- | --- | --- |
| `agent-sdk-sidecar` (default) | Stable | Full (text, reasoning, tools) | Yes |
| `agent-http` / Channels | Experimental | Message-level deltas | No |
| `agentapi` | Experimental | Terminal-derived text | No |
| `claude-p` | Experimental | None (one-shot) | No |
| `jinn-pty` | Experimental | Full (text, reasoning, tools) via SSE tee | Yes (hook-driven) |
| `codex` (native passthrough) | Stable | Native Codex | Native Codex |
| `grok` (xAI Grok Build CLI, per `grok-*` model) | Experimental | Full (text, reasoning, tools) | Yes (App approvals) |

## Switching routes

Install the host helper next to the shim:

```bash
install -m 0755 scripts/claude-codex-mode ~/.local/bin/claude-codex-mode
```

It rewrites `~/.claude-codex/runtime.env`, prepares the matching bridge daemon
(`agent-http` / `agentapi`), stops the current app-server so Codex App reconnects
into the new route, and provides readback commands:

```bash
claude-codex-mode list                 # selectable modes; current marked *
claude-codex-mode set agent-http opus  # switch route, restart bridge with Opus
claude-codex-mode model opus           # keep route; update default/bridge model
claude-codex-mode status               # mode, bridge health, recent logs
claude-codex-mode logs adapter|agent-http|agentapi
```

::: warning Model switching
Model switching is exact per turn for the SDK runtime and `claude-p` (the adapter
passes `model` directly). For `agent-http` / `agentapi` the bridge talks to a
long-lived Claude Code session, so changing the model means restarting that
bridge (`claude-codex-mode model <alias>`).
:::

::: warning Native codex passthrough
In `CLAUDE_CODEX_RUNTIME_TYPE=codex` the shim launches the real Codex
app-server, so the adapter is not in the process and cannot switch back from
in-App controls. Use `claude-codex-mode set codex` / `set agent-sdk-sidecar` on
the host and reconnect.
:::

## agent-http / Channels

Loads the bridge from `$CLAUDE_CODEX_AGENT_HTTP_DIR` (or `~/agent-http`) but
launches Claude Code from the thread cwd. Uses `POST /message`, `GET /messages`,
`GET /status`, `GET /events`; streams message-level deltas only (no semantic
tool / thinking / permission events).

```bash
claude-codex-mode set agent-http opus
```

## agentapi

Runs `agentapi server --type=claude` from the thread cwd and maps final agent
text into Codex messages. No rich approval / file-change events (terminal-derived
text only). Run `claude-codex-mode trust` if Claude's workspace-trust prompt
appears.

```bash
claude-codex-mode set agentapi opus
```

## claude-p

Runs `claude-p --output-format json --input-file ...` per turn and emits the
final assistant text. Not streaming, no `turn/steer`; defaults to one-shot turns
(some `claude-p` builds replay results when combining `--resume` with
`--input-file`).

```bash
export CLAUDE_CODEX_RUNTIME_TYPE="claude-p"
export CLAUDE_CODEX_CLAUDE_P_COMMAND="claude-p"
# export CLAUDE_CODEX_CLAUDE_P_RESUME=1   # only after verifying --resume + --input-file
```

## jinn-pty (interactive `claude` in a PTY)

Drives the real **interactive** `claude` TUI inside one long-lived
pseudo-terminal per thread. Interactive use is covered by a Claude
subscription (Max/Pro), whereas `claude -p` and the Agent SDK bill as API
usage, which is the reason this backend exists. The technique is ported from
[Jinn](https://github.com/hristo2612/jinn)'s interactive engine and is
self-contained in `src/jinn-pty-*.mts`.

```bash
export CLAUDE_CODEX_RUNTIME_TYPE="jinn-pty"   # aliases: pty, claude-pty
# export CLAUDE_CODEX_CLI="$HOME/.local/bin/claude"
```

How a turn works:

1. **Spawn.** The first turn of a thread spawns `claude` (node-pty) in the
   thread cwd with `--model`, `--settings <per-thread hooks json>`,
   `--append-system-prompt`, `--mcp-config`, `--add-dir`, and
   `--permission-mode plan` when the App asks for plan mode. A thread whose
   PTY is gone but that has a Claude session id respawns with `--resume <id>`.
   The workspace-trust dialog is answered from the screen (the runtime keeps a
   headless terminal emulator of the PTY), and the PTY is kept warm afterwards.
2. **Submit.** The prompt is bracketed-pasted into the composer followed by
   Enter; the `UserPromptSubmit` hook confirms the submit landed (the CR is
   re-sent until it does). `turn/steer` pastes into the live PTY;
   `turn/interrupt` sends Escape.
3. **Hooks.** The settings file wires `SessionStart`, `UserPromptSubmit`,
   `PreToolUse`, `PostToolUse`, `Stop`, `StopFailure`, `Notification` and
   `SessionEnd` to `scripts/jinn-pty-hook-relay.mjs`, which POSTs each payload
   to a loopback HTTP server owned by the adapter (random port, token passed
   through the PTY environment only). `PreToolUse` becomes the App's native
   command / file-change approval: read-only tools (Read, Glob, Grep,
   WebSearch, WebFetch, TodoWrite, Task) are auto-allowed, everything else is
   allowed only if the App accepts, unless the thread runs with Full access
   (`approvalPolicy=never` or `sandbox=danger-full-access`). `PostToolUse`
   closes the tool item, `Stop` completes the turn with the final assistant
   text (from the hook, or the session transcript as a fallback),
   `StopFailure` fails it.
4. **Streaming.** `ANTHROPIC_BASE_URL` points the CLI at a per-PTY loopback
   proxy that forwards every request unchanged to `api.anthropic.com`
   (auth headers pass through untouched and are never logged) and tees the
   SSE response into `text_delta` / `reasoning_delta` events. Only the main
   agent's requests are teed (identified by a sentinel appended to the system
   prompt); sub-agents, title generation and auto-compaction summaries never
   reach the transcript. Set `CLAUDE_CODEX_PTY_STREAM_PROXY=0` to disable the
   proxy — the final text then arrives as one delta at `Stop`.
5. **Safety prompts.** Claude Code keeps a few hardcoded prompts (dangerous
   `rm`, `&` background operator) that ignore hook decisions. When the CLI
   reports one via the `Notification` hook the runtime reads the dialog from the
   screen and answers it consistently with the App's decision for that tool.

Daemon lifetime: because PTYs stay warm between turns, this runtime defaults
`CLAUDE_CODEX_IDLE_EXIT_MS` to `0` (never idle-exit). `stop()` kills every PTY
the adapter spawned by pid.

Known limits: `AskUserQuestion` and `ExitPlanMode` are disallowed (they render
TUI dialogs no hook can answer); the Codex App's title/summary turns are
answered locally instead of through the PTY; one turn per thread at a time;
Windows is untested.

```bash
npm run smoke:jinn-pty   # real-Claude smoke: PONG turn + Bash approval round-trip
```

## grok (xAI Grok Build CLI)

Runs xAI's `grok` CLI in its agent mode (`grok agent -m <model> stdio`, the
Agent Client Protocol over stdio) and maps the stream onto native Codex items:
per-token answer text, reasoning, `run_terminal_command` as a command item,
`write`/`edit` as file changes, and grok's `session/request_permission` as the
App's own command / file-change approval. The technique is ported from
[Jinn](https://github.com/hristo2612/jinn)'s grok engines and is self-contained in
`src/grok-runtime.mts` + `src/grok-acp.mts` + `src/grok-models.mts`.

You do not switch the whole adapter to this backend: **picking a `grok-*` model
in the Codex App's model picker routes that thread to grok**, whatever
`CLAUDE_CODEX_RUNTIME_TYPE` is (the same rule that sends `gpt-*` to
`codex-proxy`). The models appear in the picker whenever a `grok` binary is
resolvable (`CLAUDE_CODEX_GROK_BIN`, `PATH`, `~/.local/bin/grok`) and are read
from `grok models` (currently `grok-4.6`, `grok-4.5`), shown as "Grok 4.6" and
"Grok 4.5". Log in once with `grok login`; the adapter never handles xAI
credentials.

```bash
# Optional: pin the binary and the picker entries.
export CLAUDE_CODEX_GROK_BIN="$HOME/.local/bin/grok"
export CLAUDE_CODEX_GROK_MODELS="grok-4.6,grok-4.5"   # or a JSON array of ids / {id, displayName}
# export CLAUDE_CODEX_GROK_ARGS="--debug"              # extra `grok agent` flags
# export CLAUDE_CODEX_GROK_IDLE_MS=600000              # reap an idle grok process (0 = keep)
# export CLAUDE_CODEX_DISABLE_GROK=1                   # hide the Grok models
```

How a turn works:

1. **Spawn.** The first turn of a thread spawns one warm `grok agent --no-leader
   -m <model> [--reasoning-effort <effort>] [--always-approve] stdio` in the
   thread cwd and sends `initialize` + `session/new {cwd}`. The grok session id
   is stored on the thread as `grok:<uuid>`; when the process is gone (adapter
   restart, idle reap, model or effort change) the next turn re-attaches with
   `session/load`, whose history replay is ignored. The App's per-thread
   instructions (`baseInstructions` / `developerInstructions` / personality) are
   prepended to the first prompt of a fresh session, since `grok agent` has no
   system-prompt flag.
2. **Stream.** `session/prompt` streams `agent_message_chunk` → agent text,
   `agent_thought_chunk` → reasoning, `tool_call` / `tool_call_update` → tool
   items with their output. The prompt result's `_meta.usage` becomes the turn's
   token usage.
3. **Approvals.** With `approvalPolicy=never` or `sandbox=danger-full-access`
   the process runs with `--always-approve`. Otherwise grok's
   `session/request_permission` is answered locally for read-only tools and
   forwarded to the App for everything else; *accept* selects grok's
   `allow_once`, *accept for session* its `allow_always`, *decline* its
   `reject_once`. grok also honours its own permission rules (it reads
   `~/.claude/settings.json` allow rules), so pre-allowed tools never prompt.
4. **Interrupt.** `turn/interrupt` sends `session/cancel`; the turn settles with
   grok's `cancelled` stop reason. `turn/steer` is not supported (logged no-op).

Known gaps: no image input (grok's agent mode declares `image: false`), no
mid-turn steer, no cost figure (grok reports token counts only), and
`--always-approve` is process-wide, so flipping a thread between Full access and
on-request restarts its grok process (the session is reloaded, history kept).
