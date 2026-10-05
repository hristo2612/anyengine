# AnyEngine v1 design

Status: approved (2026-09-29). Research and spike evidence live outside this repository. This document keeps only the conclusions.

## 1. Goal

A user who pays for several AI plans should be able to use every engine from whichever harness they sit in. The engine should run natively (picker, sub-agents, history) on the auth each vendor CLI already has. Vendors will keep improving orchestration inside their own harnesses, but they will not let those harnesses run each other's engines. AnyEngine is the thin layer that closes that gap.

### Success test

In ChatGPT.app, the user asks: "spawn 7 sub-agents, 3 on Opus, review this repo".
- All 7 run, and the 3 Opus children run on the user's Claude plan.
- Their results land in the parent thread.
- When the active ChatGPT account hits its limit mid-thread, the next message continues on the next account (rotation on) with its context intact.

## 2. Scope

**v1 (this document)**

| Host (harness) | Other engine | Mode |
|---|---|---|
| ChatGPT.app Codex surface (and codex-web, which runs the same webview) | Claude | Model mode via the router (`claude -p` trampoline), or agent mode via the adapter; user choice |
| Codex CLI | Claude | `codex --remote` to the adapter, which gives the same engines, modes and rotation. No global `config.toml` edit. |
| Claude Code CLI | GPT | Model mode via the router |

M1 CLI terminal scope (R121): the host preserves the caller terminal, input,
arguments, normal exit status and signals with an owned foreground vendor
group. Suspend/resume is unsupported: Ctrl-Z or a stopped vendor safely ends
nonzero, restores the caller foreground, and joins only the owned CLI/adapter
family. It never resumes, restarts or replays input/turns after the CLI starts,
and never deletes existing user sessions. Native interactive acceptance remains
an operator check; fake PTY controls establish process mechanics only.

Also in v1: OpenAI account rotation (opt-in, one account at a time), `anyengine limits`, the posture map (never looser than the parent), and `anyengine on | off | status | doctor`.

**v2 (out of scope here)**
- Sessions (list everywhere, cross-open, search).
- Claude account rotation.
- Cross-vendor failover with an editable handoff template.
- Claude desktop Code tab.
- The Anthropic API-key model-mode backend.
- Grok, Gemini, Kimi as maintained engines. The existing Grok code stays but is unmaintained.

## 3. Constraints

| Constraint | Consequence |
|---|---|
| Subscriptions only work through each vendor's official client | Claude always runs through the `claude` CLI, and no component ever holds, stores or relays a Claude OAuth token. GPT traffic always carries a bearer that a real `codex` process owns and refreshes. |
| Policy (September 2026) | `claude -p` and the Agent SDK still draw on the plan: the de-subsidy was paused, not reverted. Using the harness as a model endpoint for a foreign loop (the trampoline) is grey, so it is a user-selected option. Agent mode is clean. GPT on a ChatGPT login inside Claude Code is grey but tolerated. Account rotation must be sequential, with no proxy pooling. |
| Vendor apps update weekly or faster | Hook through documented config keys wherever possible. Detect drift and fail loudly. Every live change is reversible with one command. |
| Refresh tokens are single-use | Exactly one process family refreshes each account's token chain. Credentials are moved, never copied. |
| Minimal footprint | No heavy system prompts. Native mode injects nothing. The bridge fallback injects one line. |

## 4. Architecture

```
ChatGPT.app / codex-web --CODEX_CLI_PATH--> [adapter] --real codex child (CODEX_HOME = overlay home)--+
                                                |                                                  |
                                                +-- Claude agent mode (interactive PTY)             | openai_base_url
                                                +-- bridge MCP (fallback spawn)                     v
Codex CLI --codex --remote--> [adapter]                                  [router: /backend-api/codex]
                                                                           |- GPT: relay unchanged to chatgpt.com
                                                                           |- Claude: claude -p trampoline
Claude Code --ANTHROPIC_BASE_URL--> [router: /v1/messages]
                                       |- claude-*: byte-exact passthrough to api.anthropic.com
                                       |- gpt-*: translator (bearer injected by the token broker)
[accounts] owns account homes and the overlay; rotates at turn boundaries
[broker]   hands the active account's bearer to the translator; never refreshes
[limits]   reads account/rateLimits/read per account
```

The **adapter** is the existing app-server shim. It owns anything that must answer the desktop at the protocol level: agent mode, the bridge, reserve and quota handling, rotation respawns, and posture.

The **router** is a new loopback HTTP and WebSocket service. It owns anything at the model level: catalog injection, GPT relay, the Claude trampoline, and the Claude Code face. It survives app updates because it relies only on documented keys (`openai_base_url`, `CODEX_APP_SERVER_OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `modelPicker`).

## 5. Components

### 5.1 Adapter (existing, hardened in M0)

Keeps today's behaviour: Claude PTY, GPT passthrough to the real codex child, the bridge, auto-reserve, and mid-thread engine switching. It changes in four ways:

- Its real codex child runs with `CODEX_HOME` set to the overlay home (5.4) and `-c openai_base_url=<router>`, so GPT threads see Claude in the catalog and native `spawn_agent` can target Claude.
- It is installed outside any project directory, at `~/.anyengine/lib/<version>/`, with the shim pointing there. A dependency-pruning job can no longer break the live install, which is what caused the 2026-09-15 outage.
- When the adapter cannot start, the shim falls back to the vendor-bundled codex and logs the fallback loudly.
- Agent mode for Claude inside Codex stays the clean option (option c). Its sub-agents come from the bridge tool, not from Codex's `spawn_agent`.

### 5.2 Router

A single process, supervised by launchd with KeepAlive, listening on a fixed loopback port. It has two faces.

**Codex face (`/backend-api/codex/*`)**
- **`/models`:** fetches the upstream catalog with the caller's own headers, then appends Claude entries cloned from a GPT template with Claude's context window. It raises their priority so they fall inside the spawn tool's top-5 model list. It marks every entry as multi-agent **v1**, because v2 encrypts child task text server-side and a Claude child cannot read it.
- **GPT `/responses` (HTTP and WebSocket):** relayed unchanged to chatgpt.com with the caller's headers. The router never stores or refreshes these tokens.
- **Claude `/responses`:** translated into a `claude -p` trampoline turn (option a). Codex's tools are exposed to Claude as a per-turn MCP server and executed by Codex. Foreign reasoning and encrypted items are stripped in both directions. The modules are ported from EthanSK/claude-in-codex (MIT).
- **Mode switch:** `anyengine mode codex-claude model|agent`. In `agent`, the router still serves the catalog, but Claude-model threads are claimed by the adapter's PTY engine.

**Claude Code face (`/v1/messages`)**
- **`claude-*` and unknown models:** byte-exact passthrough, so Claude usage stays on the plan and the router never reads the token.
- **`gpt-*`:** sent to the translator, vendored raine/claude-code-proxy (MIT). The broker (5.3) injects the bearer and account header. The translator never logs in and never refreshes. If raine cannot accept an injected bearer, we carry a minimal patch in our vendored copy.
- **Translator requirements:** it echoes the requested alias in `message.model`, sanitizes tool schemas, maps 429 and context-length errors faithfully, and uses a stable per-session `prompt_cache_key`.

**Fallback when v1 multi-agent is gone.** At startup, and whenever the upstream catalog or a spawn error shows that v1 is unavailable, the router marks native mixed fan-out as unavailable. The adapter then adds one line to the parent's developer instructions naming the bridge spawn tool. `anyengine status` shows which path is active.

### 5.3 Token broker (AnyEngine is the central place)

The broker is the only component that reads OpenAI bearers, and it reads them only from a real codex process. Each account's token chain is refreshed only by the codex processes that share that account's `auth.json`.

- **Mechanism:** the broker keeps one codex app-server on the overlay home: the adapter's real child when the app is running, otherwise one it starts itself. It asks that app-server for the current bearer with `getAuthStatus` (include token, refresh if stale). It caches the bearer in memory until shortly before expiry and injects it into translator requests.
- **Rotation:** the broker follows the active account automatically, because its app-server is respawned on rotation.
- **Verification gate (M2):** confirm that `getAuthStatus` returns a usable bearer and refreshes it. If it does not, the fallback is to route translator traffic through a codex app-server started on the account's home, with the same single-refresher rule.

### 5.4 Accounts and rotation (OpenAI, opt-in)

- **Store:**
  - `~/.anyengine/accounts/openai/<id>/auth.json` holds one account per directory, logged in once with `codex login --device-auth`.
  - `~/.anyengine/accounts.json` holds the order, labels and state. It contains no secrets.
- **Overlay home:** `~/.anyengine/codex-home/`.
  - Everything in `~/.codex` except `auth.json` is symlinked in, so sessions, state, config, skills and plugins are shared.
  - When the active account is the user's own `~/.codex` login, `auth.json` is a symlink to `~/.codex/auth.json`. Rotation off is therefore identical to today.
  - When another account is active, its `auth.json` is moved in, and moved back out on rotation.
- **Scope:** rotation affects AnyEngine-managed surfaces only: the app and codex-web through the adapter, `codex --remote`, and the Claude Code translator. Codex processes started outside AnyEngine keep using `~/.codex`. `anyengine doctor` warns when that means two accounts are in use at once.
- **Triggers (turn boundary only):**
  - a turn fails with `usageLimitExceeded`;
  - `account/rateLimits/updated` shows a window at or above the threshold (default: reached);
  - the user runs `anyengine accounts use <id>`.
- **Switch sequence:**
  1. Take the lock.
  2. Move-swap `auth.json`.
  3. Respawn the child.
  4. On the next turn, resume the thread with `thread/resume`.
  5. Log `account.rotated`.

  Only one account is active at a time, and the lock enforces it. The desktop's own identity (`account/read`, `getAuthStatus`) stays pinned to the home account so pairing and the reserve logic stay stable.
- **Failures:**
  - `invalid_encrypted_content` on the first turn after a switch: rehome the thread onto a fresh child thread and retry once.
  - All accounts exhausted: hand over to the adapter's reserve handling and surface the vendor error.
- **Mid-turn replay (option, default off):** after rotating on a failed turn, issue a short continue prompt on the same thread.

### 5.5 Limits

`anyengine limits [--json] [--refresh]` prints one row per vendor account:
- 5-hour and weekly windows (`usedPercent`, `resetsAt`)
- per-model windows
- credits
- state (`active`, `parked`, `exhausted until`, `needs login`)
- the age of the reading

OpenAI accounts are read with `account/rateLimits/read`. Parked accounts use a short-lived app-server on that account's home, rate-limited to one read per 10 minutes. The active account's reading is passive, taken from `account/rateLimits/updated`. The Claude row comes from the `rate_limit_event` data the PTY engine already sees. Other vendors are v2.

### 5.6 Posture (never looser than the parent)

- **One canonical type.** `Posture` follows Codex's model: file system entries, network, approval policy (with granular flags and reviewer), plan mode, and trust. Converters run in both directions: from Codex thread params and from Claude hook permission mode, and into a Claude launch or a Codex thread start.
- **Property test.** For every enumerable parent posture, the child's posture must be no looser than the parent's. CI fails when a new enum value appears in the generated Codex schema or the Claude docs fixture that the map does not cover.
- **Enforcement for a Claude child under a Codex parent:**
  - Claude's Bash is disabled and shell commands run through the real child's `command/exec` with the parent's sandbox policy.
  - Path checks for Write/Edit happen in the PreToolUse relay.
  - If no sandbox is available, the child refuses to start.
- **Fixes shipped in M0.** Today these default to full access or drop sandbox fields:
  - missing posture treated as full access;
  - granular approval policy dropped;
  - `writableRoots` and `networkAccess` discarded;
  - `never` treated as unbounded;
  - the bypass flag passed on an unknown sandbox;
  - `on-failure` mapped to acceptEdits;
  - custom profiles falling to full access.
- **Approximate mappings.** Codex `auto_review` and Claude `auto` map to each other, but are labelled approximate. `anyengine config set posture.strict true` maps both to manual approval instead.

### 5.7 Install and control (CLI only)

| Command | Effect |
|---|---|
| `anyengine on` | Backs up every file it touches, then:<ul><li>installs the adapter and router under `~/.anyengine/lib`</li><li>writes the guarded `CODEX_CLI_PATH` and `CODEX_APP_SERVER_OPENAI_BASE_URL` block into the login shell rc</li><li>writes Claude Code's `env` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`), the `modelPicker` rows and the generated `~/.claude/agents/gpt-*.md` files</li><li>loads the launchd router job</li></ul>It asks before restarting ChatGPT.app, and checks for an active turn first. |
| `anyengine off` | Restores every backed-up file, unloads the router, and removes injected entries from `~/.codex/models_cache.json` (router catalogs leak there, and every Codex surface reads that file). It also removes the generated agent files. |
| `anyengine status` | Shows active paths (native fan-out or bridge fallback), modes, the active account, and router, adapter and app versions. |
| `anyengine doctor` | Checks the install, versions, sockets, the node_modules integrity of the installed lib, and schema drift against the running codex. It also warns about outside processes and conflicting settings. |
| `anyengine mode <direction> model\|agent`, `anyengine config get\|set`, `anyengine accounts add\|list\|use\|rotate on\|off`, `anyengine limits` | As described above. |

State lives in `~/.anyengine/config.json` (JSON). `runtime.env` remains only for shim bootstrap paths.

## 6. Key flows

1. **Mixed native fan-out (ChatGPT.app, GPT parent):**
   - The parent calls `spawn_agent(model="claude-opus-…")`.
   - The real codex child validates the id against the router catalog.
   - The child thread's requests hit the router, which runs the `claude -p` trampoline.
   - The child's result flows back to the parent through Codex's own agent machinery.
2. **Bridge fan-out (fallback, or agent mode):** the parent calls the `anyengine` bridge spawn tool. The adapter starts a Claude PTY child and renders it as a native sub-agent thread.
3. **Claude Code, GPT sub-agent:**
   - The Agent tool spawns `gpt-*` from a generated agent file.
   - Its requests carry the exact id to the router.
   - The translator runs on the broker's bearer, and the result returns to the Claude parent.
   - Claude traffic in the same session passes through byte-exact.
4. **Rotation:** a turn fails with `usageLimitExceeded`. The accounts module swaps and respawns, and the next user message continues the thread on the next account.

## 7. Failure handling

- **Drift.** On every adapter start, compare the running codex's generated schema hash with the last known-good one. If it changed, run the fixture suite before accepting traffic. On failure, fall back to the bundled codex and flag the problem in `status`.
- **Nightly live smoke (launchd).** A tiny PONG on each path: GPT, Claude through the router, Claude through the adapter, bridge spawn and Claude Code GPT. It uses an isolated `CODEX_HOME` wherever possible. A failure raises a macOS notification and marks the path degraded.
- **Update gate (approved; best effort).** Hold ChatGPT.app's automatic updates until the smoke passes on the new version. This is verified in M1; if Sparkle offers no reliable hold, degrade to detect-and-alert.
- **Quota-exhausted desktop (openai/codex#48650).** The desktop disables Send once the ChatGPT quota is spent, whatever the provider. Rotation avoids that state, and the adapter's auto-reserve covers the case where every account is spent.
- **Never scripted: the interactive codex TUI.** It can accept a self-update prompt.

## 8. Testing

- **Unit and property tests:** posture map, catalog merge, header relay (tokens never logged), accounts state machine, and broker cache.
- **Protocol fixtures:** generated from the bundled codex schema of each supported app version, and diffed in CI.
- **Hermetic suite:** no reliance on the user's `~/.codex` or `~/.claude`. Tests spawn with isolated homes and kill their children in `after()`.
- **Live acceptance per milestone:** see section 9. Evidence goes into `docs/evidence/`.

## 9. Milestones

| Milestone | Deliverable | Acceptance |
|---|---|---|
| **M0: adapter safe** | Janitor-proof install, committed shim fallback, bridge argv fix, `thread/list` empty-provider fix, compat pin bump, posture type and the seven fixes plus property test, twin socket guard, hermetic tests | Full suite hermetic and green. Property test green. Live flip with rollback. In the app: Claude PONG, GPT PONG, bridge fan-out of 1 Claude + 1 GPT child. |
| **M1: Codex router** | Router Codex face, v1 catalog marking and priority, trampoline, GPT relay (HTTP and WS), bridge fallback detection, `on/off/status/doctor`, cache cleanup, nightly smoke | The app picker lists Claude. A GPT to Claude switch works mid-thread. "spawn 7 sub-agents, 3 on Opus" runs natively. With v1 disabled, the same prompt uses the bridge. `off` leaves no Claude entries in the cache. |
| **M2: Claude Code face and broker** | `/v1/messages` passthrough, vendored translator with injected bearer, broker, `modelPicker` rows and generated agents, the haiku and hint-header settings | `/model` lists GPT. A GPT turn with one tool call works. A GPT sub-agent answers a Claude parent. Claude responses keep the plan rate-limit headers. No translator login exists anywhere. |
| **M3: accounts and limits** | Overlay home, account store, rotation state machine, rehome fallback, optional replay, `anyengine limits` | A forced rotation mid-thread in the app continues on the next account. `limits` lists every account. The lock prevents two active accounts. The full success test passes. |

## 10. Decisions from review (2026-09-29)

1. **"Never two accounts at once" is enforced among AnyEngine-managed surfaces.** Codex processes outside AnyEngine keep the home login, and `anyengine doctor` warns when that means two accounts are active. Routing the terminal `codex` through the overlay with a PATH shim is a later option.
2. **Claude Code routing is user-wide:** `ANTHROPIC_BASE_URL` goes in `~/.claude/settings.json`. The router runs under launchd KeepAlive, `doctor` checks it, and `off` restores the file.

Status: approved 2026-09-29.
