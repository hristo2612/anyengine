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
| `anyengine` | Experimental | Full (text, reasoning, tools) via SSE tee | Yes (hook-driven) |
| `codex` (native passthrough) | Stable | Native Codex | Native Codex |
| `native-codex` multiplexer (gpt-* threads) | Experimental | Native Codex | Native Codex (mid-turn approvals, steer, subagents, plan mode) |
| `grok` (xAI Grok Build CLI, per `grok-*` model) | Experimental | Full (text, reasoning, tools) | Yes (App approvals) |

## Switching routes

Install the host helper next to the shim:

```bash
install -m 0755 scripts/anyengine-mode ~/.local/bin/anyengine-mode
```

It rewrites `~/.anyengine/runtime.env`, prepares the matching bridge daemon
(`agent-http` / `agentapi`), stops the current app-server so Codex App reconnects
into the new route, and provides readback commands:

```bash
anyengine-mode list                 # selectable modes; current marked *
anyengine-mode set agent-http opus  # switch route, restart bridge with Opus
anyengine-mode model opus           # keep route; update default/bridge model
anyengine-mode status               # mode, bridge health, recent logs
anyengine-mode logs adapter|agent-http|agentapi
```

::: warning Model switching
Model switching is exact per turn for the SDK runtime and `claude-p` (the adapter
passes `model` directly). For `agent-http` / `agentapi` the bridge talks to a
long-lived Claude Code session, so changing the model means restarting that
bridge (`anyengine-mode model <alias>`).
:::

::: warning Native codex passthrough
In `ANYENGINE_RUNTIME_TYPE=codex` the shim launches the real Codex
app-server, so the adapter is not in the process and cannot switch back from
in-App controls. Use `anyengine-mode set codex` / `set agent-sdk-sidecar` on
the host and reconnect.
:::

## agent-http / Channels

Loads the bridge from `$ANYENGINE_AGENT_HTTP_DIR` (or `~/agent-http`) but
launches Claude Code from the thread cwd. Uses `POST /message`, `GET /messages`,
`GET /status`, `GET /events`; streams message-level deltas only (no semantic
tool / thinking / permission events).

```bash
anyengine-mode set agent-http opus
```

## agentapi

Runs `agentapi server --type=claude` from the thread cwd and maps final agent
text into Codex messages. No rich approval / file-change events (terminal-derived
text only). Run `anyengine-mode trust` if Claude's workspace-trust prompt
appears.

```bash
anyengine-mode set agentapi opus
```

## claude-p

Runs `claude-p --output-format json --input-file ...` per turn and emits the
final assistant text. Not streaming, no `turn/steer`; defaults to one-shot turns
(some `claude-p` builds replay results when combining `--resume` with
`--input-file`). Like the `anyengine` runtime below (and the SDK runtime, via
`settingSources` and `strictMcpConfig`), it runs with `--setting-sources user
--strict-mcp-config` when the project's Claude config no longer matches the
thread's baseline under a bounded or untrusted posture, and says so; with no
trust dialog to refuse, it does the same for a project the parent does not
trust. It takes no hook of ours, so a pre-approved tool the posture refuses is
dropped from `--allowedTools`, and a tool the posture refuses in every call is
passed as `--disallowedTools`, which beats an allow rule in the user's
settings. `--permission-mode` is pinned on every call (`dontAsk`, `plan` when
planning, `bypassPermissions` only with `--dangerously-skip-permissions`), so
a settings `defaultMode` such as `acceptEdits` never applies, and a call that
would ask is refused, since nothing answers a prompt here. The SDK runtime
does this per call with a PreToolUse hook: the posture's deny, or its ask
(which then reaches the App's card), beats any allow rule.

::: warning claude-p and allow rules
Without a per-call hook, an allow rule in the user's or the project's Claude
settings still pre-approves a call under `claude-p` that the posture would
ask about, or a write outside the thread's writable roots. Use the SDK or
`anyengine` runtime where that matters.
:::

```bash
export ANYENGINE_RUNTIME_TYPE="claude-p"
export ANYENGINE_CLAUDE_P_COMMAND="claude-p"
# export ANYENGINE_CLAUDE_P_RESUME=1   # only after verifying --resume + --input-file
```

## anyengine (interactive `claude` in a PTY)

Drives the real **interactive** `claude` TUI inside one long-lived
pseudo-terminal per thread. Interactive use is covered by a Claude
subscription (Max/Pro), whereas `claude -p` and the Agent SDK bill as API
usage, which is the reason this backend exists. The technique is ported from a prior interactive-CLI engine of ours and is
self-contained in `src/anyengine-*.mts`.

```bash
export ANYENGINE_RUNTIME_TYPE="anyengine"   # aliases: pty, claude-pty
# export ANYENGINE_CLI="$HOME/.local/bin/claude"
```

How a turn works:

1. **Spawn.** The first turn of a thread spawns `claude` (node-pty) in the
   thread cwd with `--model`, `--settings <per-thread hooks json>`,
   `--append-system-prompt`, `--mcp-config`, `--add-dir`, and
   `--permission-mode plan` when the App asks for plan mode. A thread whose
   PTY is gone but that has a Claude session id respawns with `--resume <id>`.
   The workspace-trust dialog is answered from the screen (the runtime keeps a
   headless terminal emulator of the PTY), or refused when the parent does not
   trust the project, and the PTY is kept warm afterwards.
2. **Submit.** The prompt is bracketed-pasted into the composer followed by
   Enter; the `UserPromptSubmit` hook confirms the submit landed (the CR is
   re-sent until it does). `turn/steer` pastes into the live PTY;
   `turn/interrupt` sends Escape.
3. **Hooks.** The settings file wires `SessionStart`, `UserPromptSubmit`,
   `PreToolUse`, `PostToolUse`, `PostToolUseFailure` (a failed call, read as
   an error result), `Stop`, `StopFailure`, `SubagentStop`,
   `Notification` and `SessionEnd` to `scripts/anyengine-hook-relay.mjs`, which POSTs each payload
   to a loopback HTTP server owned by the adapter (random port, token passed
   through the PTY environment only).
   `PreToolUse` enforces the thread's posture (`src/posture-claude.mts`):
   a call inside the thread's bounds runs, a call the posture refuses is
   denied with the reason, and only what the posture would ask about becomes
   the App's native command / file-change approval. Outside full access
   Claude's `Bash` is switched off: with a native codex child running, shell
   commands go through the bridge `exec` tool, which runs them in that
   child's sandbox (`command/exec`); without one the thread has no shell and
   says so (docs/guide/bridge.md, "Shell"). A project the parent does not trust is not trusted
   here either: the workspace trust dialog is refused. The project's Claude
   config (`.claude/settings.json`, `.claude/settings.local.json` here, at
   the git root and at a linked worktree's main checkout, `.mcp.json` here
   and above) is fingerprinted when the app
   starts the thread (`src/claude-project-guard.mts`); if it no longer
   matches at a launch and the posture is bounded or untrusted, Claude starts
   with `--setting-sources user --strict-mcp-config` and the thread says so.
   `PostToolUse`
   closes the tool item, `Stop` completes the turn with the final assistant
   text (from the hook, or the session transcript as a fallback),
   `StopFailure` fails it.
4. **Background sub-agents.** Claude Code 2.1.x runs `Task`/`Agent` in the
   background: `PostToolUse` answers `async_launched` immediately and the
   result reaches the main agent later (as an injected `<task-notification>`
   message, or after a `ScheduleWakeup` call). The runtime withholds the
   tool result until the sub-agent's `SubagentStop` (or its notification)
   lands, so the App's child thread shows as running and then receives the
   real answer; a `Stop` that arrives while a launched sub-agent is still
   running, or has finished but the main agent has not yet answered its
   notification, keeps the turn open and the later text streams into the
   same turn. The turn completes on the `Stop` after the last result has been
   consumed, or after `ANYENGINE_PTY_ASYNC_SUBAGENT_TIMEOUT_MS`
   (default 10 min) with what it has; sub-agents that never report get a
   failed placeholder result.
5. **Streaming.** `ANTHROPIC_BASE_URL` points the CLI at a per-PTY loopback
   proxy that forwards every request unchanged to `api.anthropic.com`
   (auth headers pass through untouched and are never logged) and tees the
   SSE response into `text_delta` / `reasoning_delta` events. Only the main
   agent's requests are teed (identified by a sentinel appended to the system
   prompt); sub-agents, title generation and auto-compaction summaries never
   reach the transcript. Each teed request is stamped with its start time and
   the turn's prompt-acceptance epoch (`UserPromptSubmit`); requests that
   began before the prompt was accepted, after a held `Stop`, or with no turn
   active are dropped, which keeps the CLI's post-`Stop` follow-up-suggestion
   call out of the next turn. Set `ANYENGINE_PTY_STREAM_PROXY=0` to
   disable the proxy — the final text then arrives as one delta at `Stop`.
6. **Safety prompts.** Claude Code keeps a few hardcoded prompts (dangerous
   `rm`, `&` background operator) that ignore hook decisions. When the CLI
   reports one via the `Notification` hook the runtime reads the dialog from the
   screen and answers it consistently with the App's decision for that tool.

Daemon lifetime: because PTYs stay warm between turns, this runtime defaults
`ANYENGINE_IDLE_EXIT_MS` to `0` (never idle-exit). `stop()` kills every PTY
the adapter spawned by pid.

Known limits: `AskUserQuestion` and `ExitPlanMode` are disallowed (they render
TUI dialogs no hook can answer), and so is `EnterPlanMode`, since a plan mode
Claude entered on its own could not be left; the Codex App's title/summary turns are
answered locally instead of through the PTY; one turn per thread at a time;
Windows is untested.

```bash
npm run smoke:anyengine   # real-Claude smoke: PONG turn, out-of-bounds Write approval, no shell without a sandbox
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
   `opus`, `sonnet`, `haiku`, `fable` and any id in `ANYENGINE_MODELS` stay
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
# Binary resolution order for the child (src/bundled-codex.mts; the shim and
# `npm run doctor` use the same rule):
#   1. ANYENGINE_REAL_CODEX, while it names an executable file (leave it unset
#      on a Mac with the app)
#   2. ChatGPT.app's own codex, newest layout first:
#        Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex  (26.928+)
#        Contents/Resources/codex-cli/bin/codex                          (26.928+)
#        Contents/Resources/codex                                        (26.911-)
#   3. CODEX_REAL               (nothing found = multiplexer off, local-only as before)
# A named codex that is gone is skipped for 2, loudly; `npm run doctor` fails on it.

export ANYENGINE_GPT_ROUTE="native"   # default; `exec` restores the codex-exec proxy
export ANYENGINE_TITLE_ROUTE="real"   # default; `local` answers the desktop's hidden
                                         # title/summary threads locally (no ChatGPT quota)
```

With `ANYENGINE_MOCK=1` only an explicit `ANYENGINE_REAL_CODEX` enables
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
## Cross-engine bridge

Every engine the adapter runs (interactive `claude`, `grok agent`, the real
`codex app-server` child) gets one extra MCP server, `anyengine`, whose
tools start sessions and parallel sub-agents on **any** model: a Claude
thread can fan out to Grok, a Grok thread can ask GPT, a GPT thread can spawn
Claude. Requests go back through the adapter's protocol layer, so the model
routing above applies unchanged and the spawned threads (and their approvals)
show up in the App under the calling thread. Details, wiring per engine and
the smoke: [Cross-engine bridge](./bridge.md).

## grok (xAI Grok Build CLI)

Runs xAI's `grok` CLI in its agent mode (`grok agent -m <model> stdio`, the
Agent Client Protocol over stdio) and maps the stream onto native Codex items:
per-token answer text, reasoning, `run_terminal_command` as a command item,
`write`/`edit` as file changes, and grok's `session/request_permission` as the
App's own command / file-change approval. The technique is ported from a prior grok engine of ours and is self-contained in
`src/grok-runtime.mts` + `src/grok-acp.mts` + `src/grok-models.mts`.

You do not switch the whole adapter to this backend: **picking a `grok-*` model
in the Codex App's model picker routes that thread to grok**, whatever
`ANYENGINE_RUNTIME_TYPE` is (the same rule that sends `gpt-*` to
`codex-proxy`). The models appear in the picker whenever a `grok` binary is
resolvable (`ANYENGINE_GROK_BIN`, `PATH`, `~/.local/bin/grok`) and are read
from `grok models` (currently `grok-4.6`, `grok-4.5`), shown as "Grok 4.6" and
"Grok 4.5". Log in once with `grok login`; the adapter never handles xAI
credentials.

```bash
# Optional: pin the binary and the picker entries.
export ANYENGINE_GROK_BIN="$HOME/.local/bin/grok"
export ANYENGINE_GROK_MODELS="grok-4.6,grok-4.5"   # or a JSON array of ids / {id, displayName}
# export ANYENGINE_GROK_ARGS="--debug"              # extra `grok agent` flags
# export ANYENGINE_GROK_IDLE_MS=600000              # reap an idle grok process (0 = keep)
# export ANYENGINE_DISABLE_GROK=1                   # hide the Grok models
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
3. **Approvals.** Only an unrestricted posture (full access, nothing that
   asks, not planning) runs grok with `--always-approve`; `never` alone does
   not. Otherwise grok's `session/request_permission` is answered locally for
   read-only tools (not a web fetch, which is network); for everything else
   the thread's posture decides: a request it refuses is rejected without a
   card, one it allows runs, and only what it would ask about reaches the
   App. Grok's shell runs in its own process, outside every sandbox, so
   outside full access it is refused without a card, as Claude's `Bash` is
   (docs/guide/bridge.md, "Shell"); *accept* selects grok's
   `allow_once`, *accept for session* its `allow_always`, *decline* its
   `reject_once`. grok also honours its own permission rules (it reads
   `~/.claude/settings.json` allow rules), so pre-allowed tools never prompt.
4. **Interrupt.** `turn/interrupt` sends `session/cancel`; the turn settles with
   grok's `cancelled` stop reason. `turn/steer` is not supported (logged no-op).

Known gaps: no image input (grok's agent mode declares `image: false`), no
mid-turn steer, no cost figure (grok reports token counts only), and
`--always-approve` is process-wide, so flipping a thread between Full access and
on-request restarts its grok process (the session is reloaded, history kept).
