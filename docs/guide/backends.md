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
| `native-codex` multiplexer (gpt-* threads) | Experimental | Native Codex | Native Codex (mid-turn approvals, steer, subagents, plan mode) |

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

## native-codex passthrough (multiplexer)

The adapter can run in front of the REAL `codex app-server` instead of
replacing it. gpt-* threads then get the native Codex experience (mid-turn
approvals, `turn/steer`, subagents, plan mode, worktrees, the desktop's
`codex_app` tools) while Claude threads keep using the configured Claude
runtime. This replaces the older `codex exec` proxy as the default route for
gpt-* models.

How it works (`src/codex-upstream.mts`, `src/codex-mux.mts`):

1. **Child.** On startup in stdio mode (lazily on the first `initialize`
   otherwise) the adapter spawns one real app-server child with the exact argv
   the desktop handed the shim: the leading `-c key=value` globals, then
   `app-server` and the desktop's flags (`--analytics-default-enabled`,
   `-c mcp_servers.codex_app=...`). The environment is inherited unchanged, so
   the child sees `CODEX_APP_TOOLS_PIPE_PATH`, the ChatGPT login in
   `~/.codex/auth.json` and everything else the desktop's private server would.
   The child is restarted with backoff (1 s, 2 s, 4 s) if it exits and is
   killed by pid when the adapter exits.
2. **Routing.** `thread/start` picks the owner from the model id: `claude-*`,
   `opus`, `sonnet`, `haiku`, `fable` and any id in `CLAUDE_CODEX_MODELS` stay
   local; `gpt-*` and anything else go to the child. The owner map is
   persisted in the adapter store (`native_codex_threads`), learned from every
   `thread/started` / `thread/list` the child emits (subagents, `codex_app
   create_thread`, CLI resumes), and consulted for every request that carries a
   `threadId`. Unknown ids belong to the child.
3. **Default route = child.** Any global method the adapter does not merge
   (`getAuthStatus`, `process/spawn`, `fs/*`, `plugin/*`, `account/*`,
   `config/*`, `threadSection/*`, `collaborationMode/list`, ...) is forwarded
   verbatim, which is what keeps desktop-only calls native across app updates.
4. **Id rewriting.** Desktop request ids are replaced on the way up and
   restored on the way back; the child's server requests (`item/commandExecution/requestApproval`,
   `item/fileChange/requestApproval`, `item/permissions/requestApproval`,
   `item/tool/requestUserInput`, ...) get adapter ids on the way down, and the
   desktop's answers plus `serverRequest/resolved` are translated back.
5. **Merged lists.** `thread/list` page 1 is the child's page 1 with the Claude
   threads merged in by sort key (later pages are child-only, cursors are the
   child's); `thread/loaded/list` is the union; `model/list` is the child's
   catalog with the Claude models appended (`isDefault: false`); `config/read`
   is the child's config plus the `claude-code` provider entry. `initialize`
   goes to both sides and the child's answer (real `userAgent`) wins.

```bash
# Binary resolution order for the child:
export CLAUDE_CODEX_REAL_CODEX="/Applications/ChatGPT.app/Contents/Resources/codex"
#   1. CLAUDE_CODEX_REAL_CODEX   2. the bundled desktop binary above, if present
#   3. CODEX_REAL               (nothing found = multiplexer off, local-only as before)

export CLAUDE_CODEX_GPT_ROUTE="native"   # default; `exec` restores the codex-exec proxy
export CLAUDE_CODEX_TITLE_ROUTE="real"   # default; `local` answers the desktop's hidden
                                         # title/summary threads locally (no ChatGPT quota)
```

With `CLAUDE_CODEX_MOCK=1` only an explicit `CLAUDE_CODEX_REAL_CODEX` enables
the multiplexer (the unit tests point it at
`test/fixtures/fake-codex-app-server.mjs`). The shim must pass the desktop's
leading `-c` globals through (`scripts/codex-shim` does since this feature
landed; reinstall it after upgrading).

Known limits (M1): later `thread/list` pages are not merged (Claude threads
appear on page 1 only); `thread/section/move` for Claude threads is a no-op;
the child is stdio-only, so a desktop restart restarts it too; cross-backend
`thread/fork` is refused.

```bash
npm run smoke:native-codex   # real smoke: gpt PONG + native command approval + Claude PONG
```
