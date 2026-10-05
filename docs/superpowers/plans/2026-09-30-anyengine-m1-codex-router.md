# AnyEngine M1: Codex router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task ends with an independent review before the next one starts.

**Goal:** Put a loopback router between the adapter's real codex child and chatgpt.com, so that ChatGPT.app (and `codex --remote`) list Claude next to GPT, switch a thread between them, and fan out native `spawn_agent` children on Claude, with Claude running in agent mode by default, a one-command way back, a nightly live smoke, and an update gate.

**Architecture:** A new router process (`adapter.mjs router`, launchd KeepAlive, `127.0.0.1:18790`) serves the Codex face: `/models` (upstream catalog plus Claude entries, v1 multi-agent marking, spawn priority), GPT `/responses` relayed byte for byte over HTTP and WebSocket, and Claude `/responses` for threads an adapter owns, either claimed by that adapter (agent mode, the default: the adapter runs the turn on its interactive Claude PTY under the parent's posture) or run through the `claude -p` trampoline (model mode, opt-in, ported from claude-in-codex). The adapter points its own codex child at the router with `-c openai_base_url=...` only while the router is healthy, learns the children its codex spawns from the parent's collab spawn items, and exposes a claim socket the router uses to confirm ownership and hand over Claude threads it cannot run itself. It keeps the app's Claude model pick out of the shared `config.toml`. An `anyengine` control CLI encodes the M0 live-flip procedure as a detached, resumable flip (write-ahead layers of backed-up changes, hash-guarded restore, a node-free `anyengine-off`, a rollback proven on a scratch copy, idle and staged-update checks, app-version checks, post-relaunch checks, auto-rollback), and a launchd smoke job verifies every path nightly and after each app update, proving native fan-out or moving the router to the bridge path.

**Tech Stack:** Node.js 24 (TypeScript ESM `.mts`, erasable syntax, `node:test`, `node:http`, `node:https`, `node:net`), `ws` (already a runtime dependency), bash 3.2 (shim, launchers, rollback scripts), launchd, the Codex app-server protocol and the ChatGPT Codex backend wire (bundled codex `0.159.0` in ChatGPT.app `26.928.20755`), the `claude` CLI (interactive PTY for agent mode, `claude -p` for model mode).

**Spec:** `docs/specs/2026-09-29-anyengine-v1-design.md` (section 9, M1; details in 3, 4, 5.1, 5.2, 5.6, 5.7, 6, 7, 8 and 10). The spec lives on branch `spec/anyengine-v1`; this branch carries it through `m0/adapter-safe`.

**Where to work:** branch `m1/codex-router`, cut from `m0/adapter-safe` @ `986ab70`, in an isolated worktree on the configured external task volume. The M0 worktree stays untouched.

**Line ranges** name the tree at `986ab70`. When an earlier task has moved them, anchor on the quoted code.

## Amendments during execution (read before your task)

Later tasks must follow these changes. Each came out of an implemented and independently reviewed task, and each overrides the task text further down.

- **Hermetic tests (Tasks 1, 1b, 1c, 1d).**
  - Create temp dirs with `test/helpers/tmp.mts` `tempDir` and `after(removeTempDirs)`.
  - A run that leaves anything in its root, or adds `anyengine-*` entries to the real temp dir, fails. The one exception is another run's `anyengine-hermetic-*` root.
  - On this Mac the first exec of a newly written script takes 0.1 to 3.1 s. Run fakes via `node <fake>`, or warm them once (`warmUp` in `test/shim.test.mts`) before the timed part. Use condition-based waits with generous upper bounds, never 1 to 4 s wall-clock budgets.
  - Scratch files go in a subfolder of the T7 tmp, never under a top-level `anyengine-*` name.
- **Shell and approvals (Tasks 2 and 3).**
  - `server.mts` `requestApproval` uses `approvalVerdict`, which declines shell approvals from every engine (Grok included) unless `shellMode(...) === 'bash'`.
  - The SDK runtime always passes `disallowedTools`.
  - `PostToolUseFailure` completes the item.
  - `mcp__anyengine__exec` carries `_meta['anthropic/alwaysLoad']`.
  - Anything that spawns a Claude child must go through `toClaudeLaunch` so these rules hold.
- **Restart idle check (Task 4).**
  - Only `session_meta.source == "exec"` rollouts are ignored. `cli` and `mcp` count as app activity: a resumed CLI thread gets app turns, and `--session-source app-server` writes `mcp`.
  - An `exec` rollout held open by an ` app-server` process (checked with `/usr/sbin/lsof` and `/bin/ps` by absolute path, override `ANYENGINE_LSOF`) counts as busy.
  - Any failure reads as "cannot tell".
- **Model pick (Task 5).**
  - Only top-level `model` and `review_model` stay local. `profiles.*` writes go to codex as sent, and codex 0.159 refuses them.
  - The pick shows only where the key's origin ranks at or below the user file (codex's `ConfigLayerSource::precedence()` table in `src/config-writes.mts`).
  - Tasks 21, 23 and 24 must treat only top-level lines.
- **Codex wire (Task 6).**
  - Per-turn metadata is read from the body's `client_metadata['x-codex-turn-metadata']` first, and the header second. Codex 0.159 keeps one WebSocket open from prewarm and sends every later turn as a `response.create` frame. The upgrade header is stale: `request_kind: prewarm`, `turn_id: ""`, or an older turn after a reconnect.
  - Claude clones set `use_responses_lite: false`, so the Claude path receives the non-lite shape: top-level tools, no lite header, no `additional_tools` item.
  - The `multi_agent_v1__*` tools appear inside the `exec` tool description even with an API-key login. Task 12 may not need the fake ChatGPT login; record which login you used and why.
  - Codex's startup plugin sync contacts github.com and a hard-coded `chatgpt.com/backend-api/plugins/export/curated`, whatever `chatgpt_base_url` says. Every zero-spend codex run must be sandboxed (`sandbox-exec`, loopback only), with an isolated env on every spawn, `--version` included, because codex writes `$CODEX_HOME/tmp/arg0` on every invocation.
  - The parent id of a child request may also be in the body. Task 12 records the header and the body, over both HTTP and the WebSocket.
  - **Task 15** passes the request body to `parentThreadIdOfRequest(headers, body)` (the plan text calls it with the headers only, at about l.7092 and l.7141). The contract reads the body first and the header second, and the body-first parent rule stays inert until the body is passed.
- **Settings (Task 7).**
  - `router.upstream` is only `https://chatgpt.com/...` or `http://127.0.0.1:<port>`.
  - `set` refuses to run over a broken file and writes only its own key.
  - A broken file or a bad value makes `router.enabled` and `router.multiAgentV1` read `false`.
  - **Task 27** uses `config.smoke.claudeModel` wherever the plan text says `haiku`: the native-fanout prompt, the `collabAgentToolCall` check and the claude-model POST.
  - **Tasks 24 and 27** honour `smoke.enabled`: no smoke job is installed or run when it is false.
  - **Task 18** applies the same loopback check to `ANYENGINE_ROUTER_URL` before it becomes `-c openai_base_url=...`.
  - **Task 20:** a change to a proof-relevant setting must invalidate the native proof, through `settingsHash` or by clearing it. Never leave native on after the operator turns it off.
  - **Task 24:** `setConfigValue('claude.cli', …)` now requires an executable file, so its tests need a real executable for `plan.claudeCli`. `DEFAULT_CONFIG` is frozen: `structuredClone` it before changing anything.
  - **Task 26:** `setConfigValue('router.multiAgentV1', false)` throws when `config.json` has errors in other keys. A broken file already reads as the bridge path, so catch the error and report it rather than aborting the flip.
  - **Task 26 `flip.lock`** must not use "the holder is gone, so delete the lock by name". That races: a waiter can delete a successor's fresh lock. Use the pattern Task 7's `config.json.lock` settles on:
    - take over a stale lock by renaming it to a unique name, and remove it only if its inode is the one judged stale;
    - treat a lock older than a bound as stale, whatever its pid;
    - release only a lock that still holds your own pid.
  - **`anyengineRoot()`, `enginePaths()`, `readConfig()` and `loadConfig()` (no explicit root) throw on a relative `ANYENGINE_ROOT`.** Never resolve the root at module load. Handle the throw per task:
    - **Task 18 `router-link.mts`:** resolve inside `linkRouter`; a throw means "router not attached", so GPT goes direct.
    - **Task 15 `startClaims`:** catch it and skip the claim socket.
    - **Task 8 daemon:** print the message and exit non-zero.
    - **Task 20 `runControl`:** print the message and exit 2, with no stack trace.
  - **Lock helper:** `src/file-lock.mts` `withFileLock` is for SHORT SYNCHRONOUS critical sections only (the `config.json` read-modify-write). It releases before an async body finishes, and it takes over any lock older than 60 s.
  - **Task 26 `flip.lock` must NOT use `withFileLock`.** A flip holds its lock for minutes (up to the 60 min quiet wait), so the age rule would take over a live flip every time. Give it its own acquire/release handle, held across the async work:
    - `wx` create, with the pid, the process start time and a token written into the lock;
    - no age-based staleness;
    - the holder counts as alive when its pid is running with the same start time;
    - a second flip that finds a live holder STOPS (it doesn't wait);
    - only a flip that finds a dead holder takes over, with a rename-or-link-aside plus inode check;
    - release only when the token matches.
  - **Native proof keying:** a problem in any key that shapes the native proof (`modes.*`, `claude.models`, `claude.spawnPriority`, `claims.*`), or a `version` other than 1, reads `router.multiAgentV1` as false.
  - **`set` semantics:** `set` writes one field onto the raw file (unknown names are kept) under a `config.json.lock`. It refuses while the file is unusable or another key has errors.
- **Ported Responses modules (Task 10), for Tasks 11, 15 and 16.**
  - `ResponsesStream.send` serialises well-formed JSON: lone surrogates become `\uFFFD`. Codex 0.159 silently skips any event it can't parse, including `response.completed`, and then retries the stream up to 5 times, re-running the Claude turn. Every new emitter must go through `send`.
  - **Task 11:**
    - Answer `generate: false` before asking `isAgentTurn`. A plain-shape prewarm frame carries `tools`, so `isAgentTurn` alone would call it a turn.
    - Don't add a `once('close')` listener per Claude turn on a socket that lives as long as its thread. Register one per socket, or remove the listener at turn end; otherwise the 11th turn prints MaxListenersExceededWarning.
    - Wrap every frame handler so a throw can't escape to `uncaughtException`, which exits the daemon and drops every in-flight stream.
  - **Task 15:** `parseCodexRequest` can throw on crafted bodies (deep nesting, a poisoned `toString`, a null body). Call it inside try/catch and answer with `stream.fail()`.
  - **Tasks 15 and 16:** `WebSocketSink` may emit `close` twice (a socket drop mid-stream, then the stream ending). Listeners must be idempotent.
- **Child spawn recording (Task 12), for Tasks 13, 14, 15 and 30.** Codex 0.159 offers and runs a v1 `spawn_agent` child. The recordings are `test/fixtures/codex-spawn-0.159.0.json` and `codex-spawn-0.155-spike.json`.
  - **Announcement order (the app uses PERSISTED threads; the review measured 38 spawns):**
    - The parent's `item/started` `collabAgentToolCall` (`tool: spawnAgent`, no receivers) comes first. About 50–110 ms later on persisted threads, the parent's `item/completed` with `receiverThreadIds: [CHILD]` arrives. That completion is the link.
    - The link ALWAYS comes before the child's first backend request, by ≥ about 70 ms (72–98 ms measured). So a claim normally finds the child already known.
    - Notifications on the child's own thread can come BEFORE the link, by up to about 10 ms: its `thread/status/changed` always, its `mcpServer/startupStatus/updated`, and its `turn/started` in about 8% of spawns.
      - Never treat those as the announcement.
      - Never assume a child is known when its `turn/started` or status arrives. Buffer or look it up later.
      - Task 13's mux tests must cover the child-first order.
    - There is NO `thread/started` for a child.
  - **Test harness (Task 12):** `test/fixtures/fake-codex-app-server.mjs` spawns children in the recorded shape:
    - `FAKE_CODEX_SPAWN_CHILD=<model>`, or `inherit` for `model: ""` on `item/started`;
    - `FAKE_CODEX_SPAWN_ORDER=child-first` (or the default `link-first`);
    - `FAKE_CODEX_CHILD_THREAD_STARTED=1`, which adds the `thread/started` 0.159 does NOT send. Use it for negative tests only.
    - **Task 13** must test the race with `child-first`.
    - The fixture's top-level `notifications` list is in canonical order, not arrival order. `orderInvariant` and `linkBeforeFirstModelRequest` hold the guarantees.
    - **Correction:** `close_agent` and `resume_agent` do not start child turns by themselves. Only `send_input` (and the spawn) do.
  - **Spawn shapes Task 13 must handle:**
    - **No `model`:** the child inherits the parent's. The spawn item's `item/started` carries `model: ""`; only `item/completed` carries the resolved model and effort.
    - **`fork_context: true`:** the announcement is the same, but the child's request carries the forked history as an extra user message, so prompt extraction must take the LAST user text.
    - **Follow-ups:** `send_input`, `close_agent` and `resume_agent` start new child turns and requests with no new spawn item. Their items have tool `sendInput`/`closeAgent`/`resumeAgent` and name the child in their receivers.
      - Children must NOT be forgotten after their first turn.
      - After a close and resume, codex resumes the child on the PARENT's model: it sends a `warning`, and the next request carries the parent's model while still sending `collab_spawn` and the parent header.
      - The router routes by the REQUEST's model, never by a stored `NativeChild.model`.
    - **Catalog version:** `multi_agent_version` null or absent means v1. A v2 entry offers no `multi_agent_v1__*` tools, and D6/D11 already send v2 to the bridge. No grandchildren appear under the defaults, because a depth-1 child is offered no multi-agent tools.
  - **`thread/read` on a child** returns `parentThreadId` and `source.subAgent.thread_spawn.parent_thread_id`. The `collabAgentToolCall` item also carries `reasoningEffort`, and `agentsStates` lists the child as `pendingInit`.
  - **Child request identity.** Only the `thread-id` header names the child. The `session-id` header and `prompt_cache_key` carry the PARENT's id.
    - Task 15's `recordedChildHeaders` must set the `session-id` header AND the turn metadata's `session_id` to the parent. It must substitute the labels a recorded `turnMetadata` carries (`"PARENT"`, `"TURN_PARENT"` in `parent_thread_id`, `parent_turn_id`, `root_turn_id`) with the real ids.
    - The child is also named by `x-client-request-id`, `x-codex-window-id` (`CHILD:0`), the turn metadata and `client_metadata.thread_id`. `threadIdOfRequest` reads them in the right order.
    - Never use `session-id` or `prompt_cache_key` to identify the child.
  - **Parent linkage on child requests:**
    - The `x-codex-parent-thread-id` header and `client_metadata['x-codex-parent-thread-id']` appear on HTTP and on every WebSocket frame, prewarm included.
    - `x-openai-subagent: collab_spawn` and the turn metadata's `parent_thread_id` appear too.
    - A v1 child's `agent_name` is `/root`.
  - **WebSocket:** each child opens its own socket and sends a prewarm frame, then a turn frame whose `previous_response_id` points at the prewarm.
  - **Under a ChatGPT login,** codex sends `x-codex-routing-hint` and a `chatgpt-account-id` header, with zstd-compressed HTTP bodies.
  - **Before any model request,** codex fetches `wham/accounts/check` from `chatgpt_base_url`, and the answer's origin must be `https`. Without an answer, every turn fails with "workspace routing discovery failed". Task 30's differential gate, and any fake-ChatGPT-login probe, must answer it on a separate loopback port from the model backend. Reuse `scripts/lib/fake-chatgpt-auth.mjs` and `scripts/lib/codex-probe.mjs`.
- **Router core (Task 8), for Tasks 9, 11, 15, 18, 21 and 24.**
  - **No header values or raw paths in logs.** The scrubber can't catch everything: a non-Bearer scheme token, `Bearer%20…`, a bare account UUID in a path, a lone JWT signature. So hooks and relays must never log header values, raw request paths or upstream error bodies except through `RouterLog`, and should log ids and codes, not content.
  - **Dedicated agents.** Relays use their own `https.Agent`/`http.Agent`, never the global agents, so the environment's proxy and TLS settings can't reroute or expose traffic. Any new outbound connection (Task 11's WebSocket to chatgpt.com, the Task 16 trampoline) must do the same.
  - **Task 24's launchd plist** sets a minimal, explicit `EnvironmentVariables`: no proxy variables, no `NODE_TLS_REJECT_UNAUTHORIZED`, no `NODE_EXTRA_CA_CERTS`.
  - **`/health` reports an error counter** (unhandled rejections and hook errors). Tasks 18 and 21 should treat a rising counter as degraded.
- **Catalog and proof (Task 9), for Tasks 18, 21, 27 and 28.**
  - **The proof is for what RUNS.** When `<root>/lib/current` exists, native also requires it to equal the RUNNING lib (`routerVersion()` on the router). **Task 18** applies the same rule on the adapter side: the adapter's own running lib must equal `lib/current` and the proof's lib, or it takes the bridge.
  - **Version reads** for the proof key are cached on a stat stamp of `Info.plist` and the codex binary. A value that couldn't be read never matches another unreadable value.
  - **An unreadable `degraded.json`** counts as degraded.
  - **Tasks 27 and 28** wrap the `proven.json` and `degraded.json` read-modify-writes in `withFileLock`.
  - **The router's codex version probe is synchronous** (cold, up to 2 s). Task 18's 500 ms `/health` budget can then fail, but that is safe: GPT goes direct.
- **Claude launch hardening (Task 16's review), for Tasks 14, 17 and any Claude launch.**
  - **Slash commands.** A prompt from a GPT parent (spawn or `send_input` text) reaches Claude verbatim. In claude 2.1.287, `/config` persistently rewrites the user's `settings.json`, and `/heapdump` writes a heap dump containing the API key to `~/Desktop`.
    - Every non-interactive Claude launch (`claude -p`, the trampoline) passes `--disable-slash-commands`, with `disableSkillShellExecution: true` in `--settings`.
    - **Task 14** (the claim socket runs Claude children on the PTY with prompts from a codex child) must also stop slash commands. Either launch claimed children with `--disable-slash-commands`, or neutralise a leading `/` in the injected prompt. Choose one and test it.
    - **M0 follow-up:** the bridge `spawn_subagents` / `send_to_session` paths that feed GPT-authored text to a Claude PTY need the same treatment. Track it as a separate fix task before switch-on.
  - **Task 17 interface (from Task 16's fixes):**
    - `runTrampolineTurn` and `compactTrampolineSession` require `trustedCwd: string | null` and `engineRoot: string`.
    - `trustedCwd` comes from the OWNING adapter's thread record (over the claim socket's `owns` answer), NEVER from parsed request text.
    - `null` means an empty private `<engineRoot>/router/trampoline-cwd`.
    - Ordinary trampoline turns fail closed when the installed `claude` lacks `--disable-slash-commands` or `--restricted`.
    - **Task 30's live gate** must verify that a real OAuth login works under `--restricted` and the env allowlist, because that is unverified.
    - **Task 17:** `compactTrampolineSession` compacts only a session id that is a UUID AND recorded in `TrampolineState` for this thread. A forged marker can otherwise name another Claude session (`--resume` also matches titles), such as the operator's own.
    - **Plan mode** offers the trampoline no tools at all: no `--allowedTools mcp__codex`. That is tighter than Codex's plan mode, and intended.
  - **Model mode has no Read/Glob/Grep.** Claude reads through Codex's sandboxed tools. The cwd comes from the owning adapter's thread record, never from request text. The fallback is an empty dedicated directory, never `$HOME`.
  - **Child environment.** Use `--restricted` (gated by the help probe) wherever user settings must not act. Build the child environment from an allowlist, not a denylist; the same applies to M0's PTY launch, as a follow-up.
  - **WebSearch** is offered only when the request carries `web_search` with `external_web_access: true`.
  - **Posture model gap (M0 follow-up).** `src/posture.mts` treats reads as always allowed, but Codex 0.159 can restrict reads (`permissionProfile`, `permissions.filesystem.deny_read`). Until the model expresses read restrictions, a parent with a non-built-in permission profile or deny-read requirements must give its Claude children no read tools, i.e. the strictest posture. The operator uses none today.
- **Real-CLI fixtures rule (from Task 2c's review).** Hand-written fakes drifted from the real CLI, and a change that passed all 569 tests would have failed every live Claude turn: the real 2.1.287 footer drops "? for shortcuts" once text is typed, and every mode shows its own status line.
  - Any code that reads Claude Code's or Codex's screen, wire or output must be tested against fixtures CAPTURED from the real binary, at zero spend (isolated HOME/config, a fake API on loopback, sandboxed).
  - The fakes in `test/fixtures/` must reproduce those captures.
  - A behaviour change to PTY readiness, paste or submit needs a zero-spend real-CLI end-to-end proof in every permission mode before it merges.
- **Operator-config rule (from the rolled-back interim deploy, 2026-10-02).** Isolated real-CLI captures must also mirror the operator's actual settings shape. This Mac runs Claude Code with `"tui": "fullscreen"`, a dark theme, `effortLevel` high and an enabled plugin. The ACCOUNT also has server-side prompt suggestions, so an empty composer shows a FAINT placeholder (`❯ Try "…"`) that fresh configs never render; that, not the fullscreen setting, broke the interim deploy. Screen logic must ignore faint text. Every live switch-on and update (Tasks 25, 28, 30) ends with a REAL Claude turn using the operator's REAL config through the INSTALLED lib, plus a GPT turn check. A failure triggers the rollback.
- **Local requirements are resolved, never persisted.** Local requirement sources (`/etc/codex/requirements.toml`, MDM `requirements_toml_base64`) are applied when a posture is resolved and never folded into a persisted posture. Only restrictions that arrive over the wire are sticky.

### Remaining-task preflight corrections

These accepted execution rulings bind Tasks 15 and 17–31 and override conflicting literal snippets. Task 14 has incorporated the ownership-metadata, shutdown and model-authored-prompt producer corrections; extend its consumers without repeating completed work. Preserve all earlier reviewed amendments, exact catalog/proof scoping, body-first parent metadata, effective posture and Claude launch hardening. No new framework or runtime dependency is authorized by these corrections.

1. **Tasks 15/17 — Trusted ownership metadata (F01).** An owned `owns` response includes `cwd: string | null` from refreshed `ClaimThread.parentCwd ?? cwd`; an unowned response has no cwd. The server answers once and closes that connection. Task 15 returns and retains the selected owner socket **path** plus metadata, then opens a claim connection only on that path; never broadcast the claim. Task 17 passes its cwd as `trustedCwd` with `engineRoot`; owned null cwd retains the existing empty private-directory fallback. Never substitute caller `parsed.cwd` or add a trampoline posture field. **Checks:** forged request cwd, null cwd, owner disappearance and conflicting owners; preserve existing restricted/read-denial and `modelAuthored` guards.

2. **Task 15; interfaces to Tasks 14/17 — Claim lifecycle (F02).** Use one idempotent socket/abort/sink cleanup path. Owns/acceptance deadlines cover server `graceMs + CLAIM_DISCOVERY_READ_MS` (exported read allowance: 5000 ms) plus a small transport margin; do not apply them to legitimate streaming after acceptance. Preserve Task 14's stop contract: cancel admission/discovery, interrupt and await active cleanup, close idle/active connections, and prevent late work or timer rearming. `owns=true` is only a gate; report a positive agent claim only on `done`. A `done` with `success=false` still counts as a claim and fails the stream. **Checks:** silent accepted socket, maximum discovery grace, abort before acceptance, repeated sink close, late discovery, active/idle shutdown and failed claimed turn. Retain body-first parent lookup at both request sites and recorded child/parent substitutions; parser failures terminate the stream.

3. **Task 17 — Tool continuation ownership (F03).** Bind every waiting turn/call to its originating thread and selected owner path; validate both before resolving tool results. While waiting, use bounded read-only ownership rechecks against that selected adapter so owner loss cancels within a bound despite stateless `owns` connections; no fresh coordinator is needed. Cancel and reap on owner loss, replacement, shutdown or the existing expiry. Bind state methods passed as callbacks; keep recorded-UUID-only compaction and the plan-mode no-tools rule. **Checks:** thread B submits A's call id, mixed/late results, owner disappears while awaiting a tool, bounded recheck timeout, replacement, expiry, and closed MCP sockets/Claude children after cancellation.

4. **Tasks 21/23/24/30/31 — Conservative TOML mutation (F04).** Identify lexical spans of actual top-level `model`/`review_model`, accounting for quoted keys, multiline strings and both table forms. Validate Node before/after documents with existing `smol-toml`; preserve unrelated bytes. Bash supports the equivalent conservative shape boundary and refuses unsupported input. Unsupported input or real I/O failure preserves pick, journal and recovery evidence. **Checks:** a model-looking line inside a multiline string, `[[projects]]`, quoted keys, CRLF, unrelated-byte preservation and Node/Bash restore parity.

5. **Tasks 22/23/24/26 — Settled and pending writes (F05).** Keep the original before backup, last settled after-state and intended pending after-state until a write settles, including hashes, symlink targets and after bytes needed by hunk restore. Publish recovery records/scripts before target changes; Node and Bash consume both recoverable states consistently. **Checks:** kill before/after each journal, script and target publication for initial writes and repeated on/file/link upgrades; old M1 state remains recoverable before the new target lands.

6. **Tasks 19/21/22/24/26 — Invalid state is not absent state (F06).** Missing state may be empty; present unreadable, malformed, dangling or unsupported state is a recoverable error. It blocks journal overwrite and pruning rather than authorizing an empty baseline. Retain rollback scripts/backups and all possibly pinned versions until resolved. Update real/fake process identity and marker contracts consistently. **Checks:** each invalid-state form, attempted on/off overwrite, and an old rollback version beyond the ordinary prune limit.

7. **Tasks 23/24/25/26 — Real rollback failures propagate (F07).** Propagate operation failures through layer and outer status; drop records or mark a layer popped only after required operations succeeded or were verified already complete. Distinguish a successful keep of a newer pick from an I/O failure. On failure retain all records, scripts and stable recovery entry. Use quoted Bash 3.2 arrays or explicit quoted calls for path collections. When restarting, attempt reopen after a successful quit even if recovery fails and report both outcomes. **Checks:** failed install/rm/link/bootout/config/cache write, roots with spaces, partial retry, signal after quit and Node-free execution.

8. **Tasks 23/24/26 — Off without restart requires confirmed exit (F08).** Both Node and Bash refuse off `--no-restart` when the app is running or its state is unknown, before any unsafe off mutation. Only confirmed-down state permits after-quit work without restarting. **Checks:** running/unknown refusal leaves dependent jobs/config/cache and recovery evidence intact; confirmed-down scratch recovery completes.

9. **Tasks 19/20/22/23/24/25/26/30/31 — Durable recovery and last-good upgrades (F09).** Retain a stable private control/recovery entry outside restored and pruned targets, with Node-free recovery, pending journal and pinned control/rollback libs. Record last-good M1 state before upgrading an existing router layer; recover that state on failure. Preserve the initial M0→vanilla rollback ladder. Publish the exact durable, quoted recovery command in `RECOVER.txt` before restoring a public CLI that cannot recover; status/errors/evidence direct the operator to it, never promise `anyengine off/on` through M0. Clear marker/journal/pins only after verified terminal recovery/postflight. Preserve the async lock's process-start/token/inode ownership rules. **Checks:** failed quit after public launcher/current restore, SIGKILL and durable-command re-entry, later-M1 upgrade rollback, Node-free recovery, failed after-quit retry, and prune while pending.

10. **Tasks 25/27/28/30/31 — Authentic proof evidence (F10).** Freeze tested code/lib, proof-relevant config and versions together; router and adapters must execute the verified installed lib. Correlate spawn receiver, owned child, selected owner, exact model, claim and parent result; require actual successful turns. Keep agent/bridge PTY probes explicitly in local agent mode without changing live preferences. Use structured direct/router outcomes, not text matching. Preserve the existing four proof-key fields, valid-version rules, running/current/proof-lib equality and short locked proof/degraded updates. **Checks:** config/version drift, wrong router lib, unrelated claim, failed turn containing PONG, negative direct result containing PONG, and agent/bridge probes while configured model mode is native.

11. **Task 28 — Failed verification can be retried (F11).** Separate attempts from successful known-good verification. Bound automatic retry/backoff to avoid WatchPaths storms; allow an explicit manual force/retry. Keep drift fallback until a real pass. **Checks:** same-version fail→pass, repeated notifications, changed/unreadable version, and no false known-good record after failure.

12. **Task 29 — CLI auth and complete process cleanup (F12).** Missing vendor bearer support fails closed with a drift diagnostic; never fall back to Origin alone. Reject any Origin header presence, including empty. Bounded cleanup handles adapter startup timeout/error, TUI error/exit and caller signals, removes timers/listeners, bounds stderr, awaits all launched children and escalates when necessary. **Checks:** missing flag, empty Origin, silent startup, spawn error, signal, stubborn child, and hermetic cleanup after an assertion fails; directly spawned children must be awaited too.

13. **Tasks 21/25/27/28/29/30/31 — Installed and real-auth gates (F13).** Route every zero-spend official Codex invocation, including help/version/schema and fake-backend calls, through existing `scripts/lib/codex-probe.mjs` isolation, sandbox and timeout behavior; package needed helpers/fixtures. Fake ChatGPT routing uses the separate responder and HTTPS origin from the earlier amendment. The only `codex exec` exception is sandboxed, noninteractive, zero-spend differential checks **P3a** (explicit GPT), **P4a** (copied-cache/config default parity) and **M7** (router GPT default), against refusing/fake loopback backends. Never script the interactive TUI. Before switch-on/update success, require a real OAuth restricted/allowlisted trampoline PONG plus Claude PTY and GPT turns using real operator config through the installed lib; failure invokes rollback. These deployment gates remain mandatory when `smoke.enabled=false`; disabling scheduled smoke does not waive them. **Checks:** real paths unwritable in zero-spend probes, timeout cleanup, missing packaged fixture/helper, restricted auth failure and installed PTY/GPT failure rollback.

14. **Tasks 30/31 — Full acceptance and owned cleanup (F14).** Use the same seven-child prompt, including three Claude Opus children, for native and disabled-native bridge acceptance; vendor concurrency limits may batch it. Correlate all results. STATUS/CHANGELOG/evidence distinguish verified from Open/pending native or GUI outcomes; never append unconditional acceptance with required checks pending. In `finally`, restore run-owned settings and reap/delete only that run's exact threads/sessions/fixture files, preserving preexisting files and unrelated state. **Checks:** batching, unrelated events, occupied fixture filenames, interrupted runs, exact owned cleanup and pending native/GUI status.

15. **Tasks 28/29 — Every-start schema admission (F15).** Before accepting traffic on each production adapter app-server start, generate and canonicalize the actual selected Codex schema under the shared isolated official-command policy. Compare its hash against successful evidence for the running lib and shipped fixture suite; unknown or changed schema requires the focused installed posture/protocol fixture checks first. A version/stat cache or prior attempt is insufficient. Keep startup compatibility, full installed update known-good, and retry attempts separate; startup fixtures cannot clear a failed mandatory update gate. Detect same-version schema changes and invalidate/degrade existing native proof without changing its four fields. Short locks protect state publication, never subprocess/live work. Package exact validators/fixtures. Provide a real current-launch vendor fallback for stdio/unix failures; direct private WS startup must fail closed, and the CLI launcher may select the bundled CLI directly after reaping the failed adapter, with explicit fallback diagnostics and no unauthenticated replacement socket. Align bounded startup budgets with the shim/CLI. Mock tests neither run official probes nor publish production success. **Checks:** fresh observation on cache hit, same-version drift, changed lib/suite, unknown/unreadable records, binary replacement, fail→pass retry, update-failure separation, durable publication failure, original argv/stdin fallback, authenticated CLI cleanup, missing packaged helper, and hermetic no-real-engine behavior.

16. **Tasks 20–28 — Authoritative JSON bytes and evidence (F16).** A bounded audit demonstrated invalid UTF-8 silently rewritten by shared config setters, corrupt proof still eligible for native routing, and degraded clearing turning unreadable evidence healthy. Task20 adds raw-byte/fatal-UTF8 config refusal; Task21 corrects proof/degraded reads and mutations together, before later smoke/update consumers. Missing differs from malformed, unreadable, unsupported or invalid encoding. Preserve original bytes; invalid state cannot be an empty read-modify-write baseline, native eligibility, clearance or prune authority. Validate before mutation artifacts and reread under existing short locks; never open/copy/hash opaque coordination SQLite with ordinary descriptors. Later layers, recovery, pick, smoke, known-good and startup records enforce this same boundary at their named authoritative inputs. No repository-wide parser refactor. **Checks:** invalid bytes inside otherwise parseable strings, config switches off and setter refusal, exact evidence preservation, cross-path proof publication, malformed degraded clear, pending/pin retention, absence and legitimately encoded U+FFFD controls.

### Additional runtime and port integration corrections

- **Task 14:** cancellation must be latched at the production runtime preparation boundary before its first await, rechecked before creating/registering/submitting work, and invalidated or joined by shared stop. Claim-server interrupt of an unregistered turn is insufficient. Preserve existing launch, resume, readiness and paste behavior; obey the file-size ratchet using a cohesive helper if needed. Verify real lifecycle methods with fake resources held across disconnect and beyond the claim shutdown deadline, without requiring a session callback.
- **Task 17:** deterministic MCP aliases must preserve each original tool namespace/name within the vendor name-length limit. Sanitizing or truncating distinct names must not silently overwrite a catalog entry. Verify colliding original names and long-name collisions retain the correct reverse mapping.

- **Task 17 search/plan distinction:** preserve the reviewed ordinary-turn native `WebSearch` exception only for `web_search` with `external_web_access: true`. Plan mode offers no builtins or MCP tools, including `ToolSearch` and native search. Existing filesystem-read denial remains; a summary omitting the explicit search exception does not supersede the earlier reviewed amendment.

- **Task15b shared config locking:** repair the independently diagnosed stale-coordinator unlink race before further router/control work. A stable built-in SQLite transaction serializes the whole short synchronous file-lock callback and legacy-marker recovery; elapsed age never breaks a live SQLite owner. Keep the per-lock database inode stable for owners/waiters, bound acquisition, close handles on every path, and distinguish intentional coordination files from leaks in tests. SQLite alone manages database descriptors: an ordinary read/copy/hash descriptor closed in the owning process can release its POSIX locks. Backup, layer, doctor and recovery tooling treat coordination databases and sidecars as opaque stable storage, using stat or SQLite-aware access; never unlink, replace, truncate or restore them while participants may exist. Node-free recovery preserves them without requiring a sqlite3 binary. Concurrent old binaries are outside the new gate and must be drained before mutation; no new dependency or async lock framework. Verify deterministic exclusion, nested refused acquisition, thrown callbacks, live contention, process death and seeded dead main/coordinator recovery.

- **Task 18 router override:** a named router URL selects the validated loopback address but never overrides disabled or invalid configuration; health redirects are refused. Verify named overrides under disabled/invalid settings and redirected health responses.

- **Task 18 provider metadata:** an explicitly recognized Claude model follows proven native model-mode routing even with `modelProvider: "claude-code"`. Preserve title/helper precedence and provider-only/unknown local fallback. Keep start, switch and switch-back ownership consistent; arbitrary unknown IDs do not become native Claude merely through `engineForModel`'s fallback.

- **Task 23 direct recovery entry:** per-layer rollback scripts enforce the same confirmed-app-exit boundary as the outer off command before changing dependent jobs, shared config or cache. Files-only/copy-only staging remains available. Verify direct Node-free entry under running and unknown app state as well as the outer command.

- **Task 27 evidence producers:** add the minimal missing structured terminal claim/model and run-owned Claude-session producer/collector contract in the existing relevant surfaces. Correlate selected ownership, child/parent IDs and turns, exact model and terminal success; a protocol done receipt or spawn event alone is insufficient. Preserve source ratchets and credential redaction.
- **Task 27 mode attribution:** native-fanout proof runs under the frozen configured mode/settings. Agent and bridge PTY diagnostics force only private effective agent mode and record that attribution separately; they never publish a model-mode native proof from overridden agent execution. Native agent proof uses successful claim outcomes, and native model proof uses selected ownership and successful trampoline outcomes, each correlated with the parent result. Keep the four proof-key fields.
- **Task 27 mandatory gates:** provide a callable installed deployment/update gate independent of scheduled `smoke.enabled`, consumed by Tasks 25/26/28 before success. Restricted real-OAuth trampoline, real-config Claude PTY and GPT checks remain required; missing or skipped mandatory work is not success, and disabled schedule status stays truthful.
- **Tasks 30/31 source ordering:** prepare Task 31's acceptance-probe source and owned-cleanup/structured-result tests before whole-M1 review and immutable staging in Task 30. Task 31 live execution and evidence remain after switch-on. Package every used helper/fixture before freezing; never add unmanifested probe code to a verified installed lib.

## Storage (read first)

Keep temporary files and the npm cache on the configured external task volume. Set `TASK_STORAGE` to an absolute directory there, then define this prefix once per shell and use it on every gate, test and npm command:

```bash
TASK_STORAGE=/path/to/external/anyengine
export TMPDIR="$TASK_STORAGE/tmp" npm_config_cache="$TASK_STORAGE/npm-cache"
```

Commands below are written as `T7 npm test`, `T7 npm run check` and so on, where `T7` stands for that prefix:

```bash
T7() { TMPDIR="$TASK_STORAGE/tmp" npm_config_cache="$TASK_STORAGE/npm-cache" "$@"; }
```

(an agent that runs every command in a fresh shell writes the two assignments in front of the command instead). Probe homes and scratch output go under `mktemp -d "$TMPDIR/<name>.XXXXXX"` and are removed when the step is done. Nothing the router, the smoke or the control CLI writes at runtime may grow without a bound: every log rotates, every cache has a cap, and `anyengine doctor` reports the size of everything it owns (Tasks 8, 9, 21 and 27).

## Global Constraints

- Node.js 24+ (`engines.node: ">=24"`); TypeScript ESM `.mts` only, erasable syntax only (no `enum`, `namespace`, parameter properties); tests import compiled `dist/` output and run only through `scripts/test-hermetic.mjs`.
- "Claude always runs through the `claude` CLI, and no component ever holds, stores or relays a Claude OAuth token. GPT traffic always carries a bearer that a real `codex` process owns and refreshes." (spec 3)
- "The router never stores or refreshes these tokens." (spec 5.2) It relays the caller's headers, never logs a header value that could carry a credential, and keys its caches by account id and query only.
- "Every live change is reversible with one command." (spec 3) The command must work when Node, the lib or the router is broken.
- "Minimal footprint: No heavy system prompts. Native mode injects nothing. The bridge fallback injects one line." (spec 3)
- Posture: "the child's posture must be no looser than the parent's" (spec 5.6), for trampoline children and natively spawned (claimed) Claude children alike, judged by M0's `decide`/`reach` over every enumerable parent posture.
- "Never scripted: the interactive codex TUI. It can accept a self-update prompt." (spec 7) No task starts `codex` without `app-server`, `exec`-free subcommands such as `--version`/`--help`, or `login --with-api-key` in an isolated home.
- "Hermetic suite: no reliance on the user's `~/.codex` or `~/.claude`. Tests spawn with isolated homes and kill their children in `after()`." (spec 8) After Task 1, a suite that leaves anything in its temp directory fails.
- Router: "A single process, supervised by launchd with KeepAlive, listening on a fixed loopback port." (spec 5.2) Port `18790`, bound to `127.0.0.1` only.
- Vendored code: modules ported from EthanSK/claude-in-codex (MIT, "Copyright (c) 2026 codex-claude-bridge contributors") at commit `e2adced` start with a header naming the source file and commit, and `THIRD_PARTY_NOTICES.md` carries the full license text (Task 10).
- Quality gates, all green after every task: Biome (`npm run check`), `npm run typecheck`, the file-size ratchet (500-line cap for every new `src/**/*.mts`; a baselined file may shrink but never grow: `src/codex-mux.mts` 1177, `src/anyengine-runtime.mts` 1402, `src/server.mts` 3798, `src/bridge-control.mts` 891, `src/util.mts` 670, `src/codex-upstream.mts` 503, `src/store.mts` 740, `src/native-runtime.mts` 1461, `src/server-helpers.mts` 991; a shrink lowers the baseline for good), the complexity ratchet (worst 112, 15 functions over 30; neither may rise, so every new function has cognitive complexity 30 or less), the dependency guard (no new runtime dependency in M1: `ws` covers the WebSocket relay), the env-docs gate (every `ANYENGINE_*` read in `src/` documented in `docs/guide/configuration.md`), the coverage floor (80.7% lines).
- Public repository: no personal names, no absolute personal paths in code, docs, fixtures or commits; write `~` or `$HOME`. Evidence files say "the operator".
- Commits: conventional messages (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), no `Co-Authored-By` trailer, no push.
- Claude Code's global state (COO ruling): no code, script or step in this plan opens `~/.claude.json` for writing, and nothing deletes under `~/.claude/projects` except the smoke's own session files, inside its one project folder, by exact filename. Many Claude processes on this Mac rewrite `~/.claude.json` constantly; a read-modify-write of it, even one that checks for changes first, could clobber their state. Every live Claude run the plan starts works in one fixed directory instead, so Claude Code adds one project entry, once: `~/.anyengine/smoke/claude-project` after the switch-on (the smoke, the probes of Tasks 29 and 31), and `$TASK_STORAGE/claude-project` before it (the probe of Task 3, run again in Task 30 Step 3, while `~/.anyengine` is read-only).
- The live machine before Task 30 (the switch-on): read-only. Never write `~/.anyengine/`, `~/.zshrc`, `~/bin/codex`, `~/.claude/settings.json`, `~/Library/LaunchAgents/` or ChatGPT.app; treat `~/.codex/` as read-only; never run `npm run install:lib` before Task 24 adds `--no-activate` (an older `install-lib` ignores the unknown flag and activates the new lib, which changes what the live app runs), and after that only with `--no-activate`; never `pkill -f` or `killall` (stop a test process by its pid).

## Review Focus

1. **The router is down, slow or crash-looping** when the app starts or in the middle of a session: GPT keeps working after one app restart (the adapter only attaches a healthy router), and the way back works with the lib or Node broken (`~/.anyengine/bin/anyengine-off` is bash). Pinned in Task 18 (`router link: an unhealthy router is never attached`) and Task 23 (`anyengine-off undoes every layer without node, and removes layers.json only when clean`).
2. **ChatGPT.app updates itself** (a quit installs a staged update, the bundled codex moves, the wire changes): the router and the adapter re-resolve the bundled codex on every spawn, the update watcher verifies the new version, and a version that fails is run on the vendor codex at the next launch; the native fan-out proof, keyed on the app's and codex's versions, lapses and is earned again by that verification. Pinned in Task 28 (`a version that fails verification is run on the vendor codex by the shim`, `a staged update is reported once`) and Task 9 (`native only while proven for this lib, app, codex and settings`).
3. **Files AnyEngine touched were edited afterwards** (the operator adds a line to `~/.zshrc`, the M0 hand-flip block differs slightly from what `on` would write): `off` reverts only AnyEngine's lines, never overwrites the operator's, and says so when it cannot; the bash way back takes only AnyEngine's block out and keeps what the rc still points at. Pinned in Task 22 (`adoptM0: the rc after-state is withRcBlock(backup), and an rc edited since is reverted by hunk`), Task 23 (`an rc it cannot restore loses its block by bash`) and Task 24 (`off reverts only its own hunk when the rc changed since`, `a file changed beyond recognition is left alone and reported, and its layer stays recorded`).
4. **Concurrent and racing Claude children**: three claimed children at once, a claim that arrives before the adapter has learned the child, a Codex client that disconnects mid-claim, an adapter that closes before `done`. No orphaned PTY survives its idle window, an interrupt reaches the runtime, and no Claude turn starts for a thread no adapter owns. Pinned in Task 13 (`children: a waiter wakes when the link arrives`), Task 14 (`claim: a claim waits for the thread to appear`, `claim: a disconnect interrupts the claimed turn`, `claim: an idle claimed child releases its PTY`) and Task 15 (`agent mode: three children are claimed concurrently`, `an adapter that closes before \`done\` is a failure`, `ownership gate: no Claude turn runs, in either mode, for a thread no adapter owns`).
5. **The shared models cache and the shared config** (`~/.codex/models_cache.json`, `~/.codex/config.toml`): the cache is rewritten by other codex versions while the router is on, or `off` runs while the app is still up; the app saves its model pick into `config.toml`. Cleaning is idempotent, happens between the quit and the reopen, and removes the file only when it carries AnyEngine entries; a terminal codex ignores the router's cache (identity) and never gets a non-GPT model from `config.toml`. Pinned in Task 5 (`native mux: the app's Claude pick never reaches the shared config, and survives a restart`), Task 23 (`a GPT pick made while M1 was on is kept, never duplicated`), Task 24 (`off keeps a GPT pick made while M1 was on, puts back a changed Claude pick`), Task 19 (`cache clean ...`), Task 24 (`the shared config: only the top-level non-GPT model line goes`), Task 26 (`off --router-only cleans the models cache after the quit and before the reopen`) and Task 30 Step 6 (the differential gate).
6. **A flip interrupted or killed** (the agent that started it ends, a SIGTERM between quit and reopen, a quit that fails, a crash mid-write): the flip runs detached, writes ahead, and is resumed to the last good state with the app running. Pinned in Task 22 (`layers: each change is recorded and persisted before the file changes`), Task 24 (`write-ahead: an on killed in the middle is undone by anyengine-off alone`) and Task 26 (the signal, quit-failure, inside-the-app and resume tests).
7. **Native fan-out that does not work on 0.159** (the recording or the live check fails): the router and every new adapter take the bridge path, and the GPT child keeps the bridge until native is proven. Pinned in Task 9 (`fan-out: consecutive unclaimed Claude turns, or a degraded native-fanout smoke, move it to the bridge`), Task 18 (`router link: native fan-out is taken only when proven and not degraded`) and Task 27 (`native-fanout marks the path proven on a pass and degraded on a failure`).

## Decisions this plan takes (read before Task 5)

**DECISION NEEDED (D1). How the app's codex reaches the router.** The spec (5.7) writes `CODEX_APP_SERVER_OPENAI_BASE_URL` into the login-shell rc. **Recommendation, implemented by this plan:** do not export it. The adapter adds `-c openai_base_url="http://127.0.0.1:18790/backend-api/codex"` to its own real codex child, and only when the router's `/health` answers within 500 ms at spawn time and the router has not been marked degraded by the smoke (Task 18). Every AnyEngine-managed surface (ChatGPT.app, codex-web, `anyengine codex`) runs through the adapter, so the router still takes all of their GPT traffic. What this buys: a dead router can no longer take GPT down (one app restart spawns the child direct), the shim's fallback to the vendor codex stays vanilla, and `on` writes no new rc line. The cost: an app that runs without the adapter never sees the router. If the COO prefers the spec's wording, the guarded block Task 22's `withRcBlock` writes gets one more line (`export CODEX_APP_SERVER_OPENAI_BASE_URL="http://127.0.0.1:18790/backend-api/codex"`), and on the live Mac `on` inserts it into the adopted M0 block as a tracked change; the adapter then sees the app pass the router URL and does not add its own (Task 18, `appOpenaiBaseUrl`). Nothing else changes, but a dead router then breaks the app's GPT until `anyengine off`.

**D2. Default Claude mode in the Codex surface: agent.** Research lane 2 (section 4.4) rates Claude in Codex on the plan through `claude -p` or the Agent SDK as a model endpoint for a foreign loop "grey ... most exposed to the next Anthropic policy turn", and the interactive Claude Code PTY with the user's own login "allowed"; Anthropic's billing already tells the entrypoints apart (`cc_entrypoint=cli` vs `sdk-cli`). The success test must run in the default mode, so native `spawn_agent(model="opus")` children are **claimed**: codex validates the id against the router's catalog and sends the child's `/responses` to the router; the router cannot run agent mode itself, so it asks every live adapter over its claim socket (`~/.anyengine/run/claim-<pid>.sock`); the adapter whose codex child spawned it knows the child from the parent's `collabAgentToolCall` spawn items (`item/completed` names the child in `receiverThreadIds`, a few milliseconds before the child's first turn; `thread/started` is read as a second source, but the spike showed codex does not send it for a child; Task 12 records the 0.159 sequence at zero spend, Task 13 learns it) and runs the task on its Claude runtime under the claim posture (the parent's current posture when it is no looser than the child's, the child's when that is no looser than the parent's, the strictest posture otherwise or for an unknown parent), rooted at the parent's cwd (M0's `childStart`, relay, `exec` through the real child's sandbox), and streams progress and the final answer back; the router returns them as the child model's Responses stream, so the result reaches the parent through Codex's own agent machinery. A claim counts only when the adapter sends `done`. Model mode (`anyengine mode codex-claude model`) runs the same children through the trampoline instead.

**DECISION NEEDED (D3). Approvals in claimed children.** A claimed child has no approval card: the app draws cards for threads the adapter owns, and a claimed child's thread belongs to the codex child. **Recommendation:** in M1 a tool call the posture would ask about is refused with a reason (tighter than the parent, never looser). Under the default workspace-write + on-request posture, writes inside the workspace and shell through `exec` run unattended; only escalations are refused. Routing these asks to the parent's card is follow-up work.

**DECISION NEEDED (D4). What `anyengine off` undoes.** The live machine has M0 flipped on by hand (rollback `~/.anyengine/rollback-20260930T114234Z/`). `on` adopts it as the **adapter** layer and adds a **router** layer on top (Task 22). **Recommendation:** `anyengine off` pops every layer (router, then adapter: the app runs its own codex, exactly as before M0); `anyengine off --router-only` pops the router layer (back to the M0 adapter). The switch-on's automatic rollback uses `--router-only` and escalates to the full `off` only when the adapter-only state fails its checks, so the operator is never left without GPT.

**D5. Injection.** On the native path the GPT child gets no `anyengine` MCP server and no instruction (spec 3: native injects nothing). The native path is taken only when it is proven healthy (decision D18); otherwise the GPT child is on the bridge path. On the bridge path it gets the server, one developer-instruction line and a one-line MCP `instructions`. Claude and Grok threads always get the bridge server with the same single line as their addendum (the multi-line `# Other engines available` block goes).

**D6. No Claude entries on the bridge path.** A Claude child under the v2 tools cannot read its task (it arrives as OpenAI ciphertext) and re-executes the parent's instruction (06a findings 2 and 4). When native fan-out is unavailable the router serves the upstream catalog untouched, so codex rejects `spawn_agent(model="opus")` and GPT uses the bridge tool the one line names. The picker still lists Claude because the adapter merges its own entries (`mergeModelList`), and model mode falls back to agent mode for top-level threads.

**D7. The smoke's GPT paths use the real `~/.codex`.** Refresh tokens are single-use (spec 3); a copied or symlinked `auth.json` in an isolated home could become a second refresher of the operator's token chain if codex replaces the file on refresh. The smoke therefore runs its codex children on `CODEX_HOME=~/.codex` (the same process family as the app), uses ephemeral threads, deletes the fan-out threads it persisted, and isolates everything else (adapter state, Claude-only paths, model-mode checks against a private router instance). This is the "wherever possible" limit of spec 7.

**D8. Update gate: detect and alert.** Static reading of the installed 26.928 (`Contents/Resources/app.asar`, `native/sparkle.node`) shows no reliable hold: the app sets Sparkle's automatic download from server gates at every launch (`electron-sparkle-gates-changed` → `disableSparkleAutodownload` → `setAutomaticBackgroundDownloadsEnabled`, which rewrites the `SUAutomaticallyUpdate` default), runs a background check at every launch even with `SPARKLE_UPDATE_INTERVAL_MINUTES=0`, and installs "an update required by managed relaunch policy" on its own timer (`installForcedUpdate`). Holding it would mean fighting the vendor's updater. M1 detects a staged update (heads-up notification), verifies each new version after it installs (schema, posture gate, wire capture, smoke), notifies on failure, and marks a failing version so the shim runs it on the vendor codex at the next launch (spec 7's drift fallback). Task 28 re-checks this evidence on the installed app.

**D9. Terminal `codex`, the shared cache and the shared config.** The review corrected this plan's first reading. The models cache's identity includes the resolved base URL (and the client version), so the catalog the router serves, which the app's codex writes to `~/.codex/models_cache.json` while it talks to the router, is ignored by a terminal codex that talks to chatgpt.com and by any other codex version. Task 30 Step 6 proves this on the Mac before the switch-on, against the staged router's real catalog merge (a 0.159 codex pointed at chatgpt.com or another URL rejects the router-written cache; 0.154 rejects it; `-m <gpt>` is sent exactly; the no-model default is unchanged), and Task 31 Step 8 repeats it against the live cache. The real leak was elsewhere, in the shared `config.toml`: decision D15. `off` still cleans the cache (Task 24), between the app's quit and its reopen (Task 26).

**D10. Claude ids are the adapter's ids** (`opus`, `sonnet`, `haiku`, display names "Claude Opus", "Claude Sonnet", "Claude Haiku"). The picker shows one entry per model (the mux dedupes by id), and a leaked entry resolves to the adapter's own Claude in agent mode.

**D11. Every GPT entry is marked v1 while native fan-out is on** (spec 5.2). Pure-GPT fan-outs lose v2's task paths, `fork_turns` and `followup_task`. `anyengine config set router.multiAgentV1 false` turns it off (bridge path; the change also clears the native fan-out proof, decision D18).

**D12. Codex's per-session agent limit is not overridden.** If `agents.max_concurrent_threads_per_session` is below 7, codex runs the success test's children in batches; the vendor stays in charge of orchestration (brief).

**DECISION NEEDED (D14). Claude's shell with no sandbox (a live-build safety fix, Task 2).** A headless probe of the installed `986ab70` showed that when the real codex child is unavailable, a Claude thread in workspace-write mode keeps its own `Bash`, and an approved command runs with no sandbox. **Recommendation, implemented by Task 2:** refuse shell, keep the file tools. Where the posture bounds the file system and no sandboxed shell can run, `Bash` is disallowed and the thread shows why; `Read`/`Edit`/`Write` stay under the relay's path checks, which bound them without an OS sandbox. The same rule removes the shell under `untrusted` (M0 kept an asked, unsandboxed `Bash` there, because the sandboxed `exec` tool has no approval card). Alternative not taken: keep `Bash` with an approval card that says the command runs without a sandbox; the app's card has no field for that warning.

**D13. Names.** Router port `18790`; launchd labels `dev.anyengine.router` and `dev.anyengine.smoke`; AnyEngine root `~/.anyengine` (`ANYENGINE_ROOT` moves it for tests); claim sockets `~/.anyengine/run/claim-<pid>.sock`; the flip marker `~/.anyengine/state/flip.json` and its logs `state/flip-<id>.log`; the native fan-out proof `state/proven.json`; the app's model pick `~/.codex/anyengine/app-model-pick.json` (the adapter's own directory); the one working directory of every live Claude run after the switch-on, `~/.anyengine/smoke/claude-project`.

**D15. The app's model pick stays out of the shared `config.toml` (COO ruling C3b).** ChatGPT.app saves its picker with `config/batchWrite`; forwarded to codex, a Claude pick lands in `~/.codex/config.toml` (today `model = "sonnet"`), and a terminal codex with no `-m` then asks OpenAI for it. The adapter keeps any pick codex cannot serve in its own pick file and lays it over `config/read`, so the app still shows it; GPT picks go to codex as before (Task 5). `doctor` warns about such a line (Task 21). The switch-on removes the existing top-level line and seeds the pick file with it, as a tracked, backed-up, reversible router-layer change that touches only that line (Task 24; the COO: "This `~/.codex` write is authorized by the COO under the operator's standing order. It must be minimal, backed up and reversible, and must touch only that line."), and checks both directions live (Task 30 Steps 6 and 12). The app keeps rewriting `config.toml` while M1 is on (HIGH 1), so `off` puts the line back by a rule of its own, never by hash or hunk: only where no top-level key of that name exists now (a GPT pick made meanwhile is kept), with the pick file's current value first, checked for duplicate top-level keys before it is written, after the app's quit and before its reopen; the pick file is deleted; neither file ever counts as `left-changed` (Tasks 23, 24).

**D16. No Claude turn without an owning adapter (M3).** Before any Claude turn, in agent or model mode, the router asks the adapters over the claim socket whether one owns the thread (`owns`). No owner: the turn fails at once with a message that names the fix. The refusal counts toward the fan-out monitor's unclaimed streak only when it is evidence about native fan-out: a spawned child whose parent an adapter owns (asked with `owns` as parent), and a request the caller did not abort. An adapter asked about a child it never saw announced may ask its codex child (`thread/read`) before it says no. So a stray client of the loopback router (a terminal codex pointed at it, a leaked catalog entry) never spends Claude and never moves the fan-out path. The gate assumes a single-user Mac (thread ids are readable to the group `staff`; `docs/guide/router.md` says so) (Tasks 13, 14, 15, 17).

**D17. Flips are detached, write-ahead and resumable (COO ruling C2).** `anyengine on`, `off` and `restart` run in a runner of their own (new session, SIGHUP ignored) with a progress log the caller polls; each change is recorded, with `layers.json`, the layer's `ROLLBACK.sh` and `anyengine-off` rewritten, before it happens; a marker names the phase. One flip runs at a time (an exclusive `state/flip.lock`, created with `wx`; a stale one is taken over). A flip whose runner died is resumed by the next command to the last good state with the app running, after waiting for a quiet app (or `--force`), down the same rollback ladder as a failed `on` (decision D4); SIGTERM between the quit and the reopen finishes the reopen with the files rolled back; once the quit has happened, a `finally` reopens the app whatever else fails; a quit that fails restores the files and never reopens; on the way back nothing the running app depends on (the jobs, the shared config line, the models cache) goes before the app has quit, so an `off` whose quit fails leaves a working app; a flip refuses to run inside ChatGPT.app; a staged update is re-checked before every quit (a stop on the way in, expected and re-verified on the way back); the models cache is cleaned between the quit and the reopen. The rollback is proven on a scratch copy of every target before the live switch-on (Tasks 22 to 26).

**D18. Native fan-out only when proven, and proven for exactly what runs (H1, second review).** The proof, `state/proven.json`, is keyed on the lib, the app's version, the bundled codex's version and a hash of the settings that shape native fan-out (`router.multiAgentV1`, the modes, the Claude models and their order, the claim settings); `isProven` compares all four, so any of them changing needs a new proof. The router serves the native path (v1 marking and Claude entries) only while it holds such a proof, and reports bridge otherwise; the adapter takes the native path (no bridge server, no line on the GPT child) only when the router reports it, `native-fanout` is not degraded and its own view of the key matches. The smoke's `native-fanout` path writes the proof (it probes a private router, so a pass can bring native back after a failure), and so does the update watch's verification of a new app version. N consecutive unclaimed spawned children of owned parents (`claims.unclaimedFlipThreshold`, 3) or a degraded `native-fanout` move the router to the bridge path; a newer proof clears that evidence; for ten minutes after a router start or a configuration change, v2 evidence is ignored (a codex child spawned before may still hold the older catalog). The switch-on proves native fan-out on the staged lib before `on` (`smoke --lib --out`), and `on --native-proof` writes that proof or starts with `router.multiAgentV1 false`, so the app restarts once and comes up on its final path; only if that pre-proof cannot run does the switch-on fall back to proving it afterwards with a second restart (Tasks 9, 18, 26, 27, 28, 30).

## What the live machine looks like today (read-only facts, 2026-09-30)

- ChatGPT.app `26.928.20755`, bundled codex `codex-cli 0.159.0` at `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`, bundle id `com.openai.codex`, Sparkle 2 with `SUAutomaticallyUpdate = 1`.
- M0 is live by hand: `~/.zshrc` has the uncommented `CODEX_SHELL`-guarded `CODEX_CLI_PATH` block (three lines, preceded by a two-line comment), `~/bin/codex` is the lib's shim, `~/.anyengine/lib/current` → `0.1.0-986ab707750e` (the build of `986ab70`, this plan's base; `0.1.0-e15658394a9c`, the version the M0 flip installed first, is still in `lib/`), and `~/.anyengine/rollback-20260930T114234Z/` holds `manifest.json` (entries `{target, backup, mode}` with `mode` as an octal **string**, for example `"0644"`) and `ROLLBACK.sh`. Two older `rollback-*` directories exist; only the newest one whose manifest lists exactly `~/.zshrc`, `~/bin/codex` and `~/.anyengine/runtime.env` is the M0 layer. `~/.anyengine/runtime.env.m0` is still present and is left alone.
- `~/.codex/models_cache.json` is written by several codex versions in turn (it held `client_version 0.154.0` at the time of writing; the npm-global codex under `~/.nvm` is `codex-cli 0.154.0`). The live GPT catalog leads with `gpt-6.1-sol` at priority 1.
- `~/.codex/config.toml` line 1 is `model = "sonnet"`: the app's model pick, saved through the M0 adapter into the shared file (decision D15). There is no `[profiles]` table.

## Wire facts this plan relies on (zero-spend probe, 2026-09-30)

A standalone `codex app-server` 0.159.0 with an isolated `CODEX_HOME` (API-key login with a fake key), `-c openai_base_url` pointing at a loopback fake backend and `-c model_catalog_json` holding a v1-marked catalog plus an `opus` entry at priority 2, showed:

- `model/list` returned the injected `opus` second, after the default (`gpt-6-astra`, `isDefault: true`).
- The first request is a WebSocket upgrade to `/backend-api/codex/responses` (`request_kind: "prewarm"`); on `426` it falls back to HTTP `POST /backend-api/codex/responses`.
- Headers on both: `thread-id`, `session-id` (both the thread id), `x-client-request-id`, `x-codex-window-id`, `version`, `x-codex-beta-features: remote_compaction_v2`, and `x-codex-turn-metadata`, a JSON string with `thread_id`, `turn_id`, `session_id`, `agent_name` (`/root` for a root thread), `request_kind` (`prewarm`, `turn`), `sandbox_mode`, `model`, `reasoning_effort`. The HTTP request adds `x-openai-internal-codex-responses-lite: true`; no `x-codex-routing-hint` was sent.
- The body carries `model`, `input`, `prompt_cache_key` (the thread id), `client_metadata` (with `thread_id`, `turn_id`, `session_id` and the turn metadata) and, in responses-lite, the tools inside an `additional_tools` input item (`functions.exec` custom, `functions.wait`, `request_user_input`, `request_user_input_async`, `clock.sleep`).
- The binary also knows `x-codex-parent-thread-id` and `x-openai-subagent` (not sent for a root thread). Multi-agent tools did not appear with API-key auth; Task 12 records the v1 spawn path on 0.159 with a fake ChatGPT login against a fake backend, at zero spend, and Tasks 30 and 31 check it live. The generated schema confirms `Thread.parentThreadId`, `Thread.model` and `Thread.cwd`.
- The spike's 0.155 logs (`s1/logs` q2b, q2f, q2g, q2h) show how a spawned child is announced: the parent's `collabAgentToolCall` items with `tool: "spawnAgent"`, `senderThreadId`, `receiverThreadIds` and `model`, `item/started` without receivers and then `item/completed` naming the child, 1 to 5 ms before the child's `turn/started`. `thread/started` arrived for the root thread only.

Task 6 turns this probe into a repeatable script and a committed fixture.

---
## Shape of M1

```
ChatGPT.app / codex-web / anyengine codex
        |  (app-server protocol)
        v
   [adapter] --- claim socket (~/.anyengine/run/claim-<pid>.sock) <-------------------+
        |  real codex child, spawned with -c openai_base_url=<router> iff healthy      |
        v                                                                               |
   [router 127.0.0.1:18790 /backend-api/codex]                                          |
        |- GET /models   upstream catalog + Claude entries (v1, spawn priority)         |
        |- GPT /responses (HTTP, WS)  relayed byte for byte to chatgpt.com              |
        |- Claude /responses, mode agent  -> claim client ------------------------------+
        |- Claude /responses, mode model  -> claude -p trampoline (Codex tools via MCP)
        '- GET /health   pid, version, mode, fan-out path, upstream, in flight
   [launchd] dev.anyengine.router (KeepAlive), dev.anyengine.smoke (03:30 + app update)
   [anyengine CLI] on | off [--router-only] [--force] | restart | status | doctor | mode | config | cache clean | smoke | codex
```

## File structure

New modules (each under the 500-line cap):

| File | Responsibility |
|---|---|
| `src/anyengine-config.mts` | `~/.anyengine` paths, `config.json` schema, defaults, validated get/set, cached reads. |
| `src/codex-wire.mts` | The wire contract the router reads from Codex requests: thread, turn and parent ids, request kind, model, turn metadata. |
| `src/router-log.mts` | Size-bounded JSONL logger with credential scrubbing. |
| `src/router-hooks.mts` | The one place the router daemon's features are wired (catalog, WebSocket relay, Claude turns, status). |
| `src/router-turns.mts` | The `ClaudeTurns` interface both Claude modes implement; HTTP routing of Claude requests; housekeeping calls to GPT. |
| `src/router-server.mts` | The router: loopback guard, `/health`, routing by path and model, HTTP passthrough, `startRouter`, the daemon entry. |
| `src/router-catalog.mts` | `/models`: merge, Claude entries, spawn priority, v1 marking, scoped persistent cache, etag. |
| `src/router-fanout.mts` | Native vs bridge fan-out detection, router status file, in-flight counters. |
| `src/router-ws.mts` | WebSocket relay: per-frame routing, byte-exact GPT frames, prewarm, previous-response handling. |
| `src/responses-stream.mts` | Responses SSE/WS event writer (port of `responsesStream.js`). |
| `src/codex-input.mts` | Codex request parsing: prompt, context, images, sanitising for OpenAI (port of `codexInput.js`). |
| `src/tool-display.mts` | One-line summaries of tool calls for progress (port of `toolDisplay.js`). |
| `src/config-writes.mts` | The app's model picker: picks codex cannot serve stay in the adapter's pick file and are laid over `config/read`; the merged `config/read` (moved out of `codex-mux.mts`). |
| `src/claim-types.mts` | `ClaimThread`: a claimable child, its parent, the parent's cwd, model and claim posture. |
| `src/claim-protocol.mts` | Claim socket paths, NDJSON framing, `owns`/`claim`/`ping` and the events, live-socket discovery. |
| `src/claim-server.mts` | Adapter side: claim socket server, `owns`, per-thread sessions, idle release, interrupts. |
| `src/claim-turn.mts` | A claimed turn's `RuntimeTurnContext` under the claim posture and the parent's cwd, and runtime events mapped to claim events. |
| `src/native-children.mts` | Codex-spawned children learned from the parent's collab spawn items (and `thread/started`), with their parent, model and cwd; waiters. |
| `src/rpc-shape.mts` | `asRecord`, `threadIdOf`, `idOf`, moved out of `codex-mux.mts` (size ratchet). |
| `src/degraded.mts` | Paths the smoke marked degraded, and the native fan-out proof keyed on the lib, app, codex and settings; the router and the adapter read both. |
| `src/anyengine-env.mts` | The PTY child's environment, moved out of `anyengine-runtime.mts` (size ratchet). |
| `src/router-claude.mts` | Router side of Claude turns: the ownership gate (`owns`), agent mode through the claim client, model mode through the trampoline, compaction. |
| `src/router-claim-client.mts` | Router side of the claim protocol: find the adapter that knows a thread, stream its events. |
| `src/trampoline-launch.mts` | The `claude -p` launch for a model-mode turn: flags derived so that Claude has no effectful built-in tool. |
| `src/trampoline-runner.mts`, `src/trampoline-events.mts` | Runs one `claude -p` turn and streams it as Responses events (port of `claudeRunner.js`, split for the complexity ratchet). |
| `src/trampoline-tools.mts` | Codex tools offered to Claude as a per-turn MCP server, calls ended as Codex tool calls, results resumed (port of `codexTools.js`). |
| `src/trampoline-mcp.mts` | The per-turn stdio MCP server (`adapter.mjs trampoline-mcp`) (port of `codexToolsMcpProxy.js`). |
| `src/trampoline-state.mts` | Claude session index per Codex thread (port of `state.js`). |
| `src/router-link.mts` | Adapter side: health-gated router attach, fan-out path at spawn, `routerServesClaude()`, the one bridge line. |
| `src/control-cli.mts`, `src/control-commands.mts` | `anyengine <command>` dispatch and argument parsing; the commands later tasks register. |
| `src/control-logs.mts` | Reading the end of a JSONL log (the adapter's debug log) for status, doctor and postflight. |
| `src/control-system.mts` | The seam to the Mac: launchctl, app version, quit and open, ps, notifications, clock (fakes in tests). |
| `src/control-marker.mts` | The flip marker (`state/flip.json`): read, write, alive. |
| `src/control-status.mts` | `anyengine status [--json]`. |
| `src/control-doctor.mts` | M1 doctor checks, run after `scripts/doctor.mjs`. |
| `src/codex-config-toml.mts` | The model lines of the shared `config.toml`, and removing exactly those lines. |
| `src/control-cache.mts` | `~/.codex/models_cache.json` inspection and cleaning. |
| `src/control-layers.mts` | Layers of recorded changes: write-ahead record, adopt M0, hash-guarded restore, symlinks. |
| `src/control-rc.mts` | Login-shell rc: find the guarded block, add it, revert a hunk. |
| `src/control-scripts.mts` | Each layer's `ROLLBACK.sh` and the bash `anyengine-off`. |
| `src/control-launchd.mts` | Router and smoke LaunchAgent plists. |
| `src/control-install.mts` | The file half of `on` and `off`: the files before the quit, `finishOff` after it (the jobs, the shared `config.toml` line by its own rule, the models cache). |
| `src/control-proof.mts` | The rollback proven on a scratch copy of every target. |
| `src/control-postflight.mts` | Post-relaunch checks: app version, handshake, adapter process, GPT child, router attached, foreign codex, doctor, smoke. |
| `src/control-flip.mts` | `on`, `off` and `restart` phase by phase, the rollback and the resume. |
| `src/control-flip-run.mts` | The detached flip runner, its marker, signals and log, and the command front. |
| `src/smoke.mts` | `anyengine smoke`: runs the paths, judges them (degraded marks, the keyed proof), notifications, `--lib`/`--out` for the pre-proof. |
| `src/smoke-paths.mts` | One runner per smoke path (router, gpt, claude-agent, native-fanout, bridge, claude-model). |
| `src/smoke-claude.mts` | The one fixed Claude project directory and the pruning of the smoke's own session files. |
| `src/smoke-client.mts` | A minimal app-server client for the smoke and the headless probes. |
| `src/update-watch.mts` | Staged-update and version-change detection, verification, drift marker. |
| `src/codex-remote.mts` | `anyengine codex`: adapter on a loopback WebSocket plus the app's codex with `--remote`. |
| `scripts/capture-codex-wire.mjs` | Zero-spend wire capture of the bundled codex against a fake backend. |
| `scripts/capture-codex-spawn.mjs` | Zero-spend recording of how the bundled codex announces a spawned child (fake ChatGPT login, outbound denied). |
| `scripts/lib/fake-chatgpt-auth.mjs` | The fake ChatGPT `auth.json` (unsigned JWTs) the two zero-spend probes log in with. |
| `scripts/probe-terminal-codex.mjs` | The differential gate: a terminal codex ignores the router's cache and keeps its models (zero spend). |
| `scripts/anyengine-launch` | Bash launcher used by launchd and `~/.anyengine/bin/anyengine`: sources `runtime.env`, resolves `lib/current`, bounds the launchd log, execs Node. |
| `scripts/probe-remote-headless.mjs` | Headless stand-in for `codex --remote`: a WebSocket app-server client. |
| `scripts/probe-claude-exec.mjs` | One real, tiny Claude turn in an isolated adapter: does Claude find the sandboxed `exec` tool. |
| `scripts/probe-acceptance.mjs` | The live acceptance checks (picker, mid-thread switch, seven-agent fan-out, bridge fan-out). |
| `THIRD_PARTY_NOTICES.md` | Attribution and license text for vendored MIT code. |

Modified: `scripts/test-hermetic.mjs`, `scripts/install-lib.mjs`, `scripts/codex-shim`, `scripts/preflip-check.mjs`, `test/fixtures/fake-codex-app-server.mjs`, `src/adapter.mts`, `src/codex-mux.mts`, `src/reserve.mts`, `src/posture-claude.mts`, `src/bridge-instructions.mts`, `src/bridge-mcp.mts`, `src/anyengine-runtime.mts`, `src/runtime-factory.mts`, `src/types.mts`, `src/transports.mts`, `src/rehome.mts`, `src/server.mts` (one line), `package.json`, docs.

Test helpers (compiled to `dist/test/helpers/`): `test/helpers/tmp.mts`, `test/helpers/fake-backend.mts`, `test/helpers/fake-system.mts`, `test/helpers/m0-home.mts`, `test/helpers/flip-deps.mts`. New fixtures: `test/fixtures/codex-wire-0.159.0.json`, `test/fixtures/codex-spawn-0.159.0.json` and `codex-spawn-0.155-spike.json`, `test/fixtures/fake-claude-print.mjs` (port of claude-in-codex's `test/fixtures/fake-claude.js`), `test/fixtures/m0-live-layout/` (a synthetic copy of the M0 hand-flip layout, no personal paths).

---
### Task 1: Tests keep their temp files inside the hermetic root and remove them

Each `npm test` run leaves about 47 `anyengine-*` directories in the OS temp directory (`anyengine-workflow-cli-`, `anyengine-workflow-state-`, `anyengine-workflow-log-`, `anyengine-run-registry-`, `anyengine-github-json-`, `anyengine-test-`); 1,091 had piled up by 2026-09-30. The runner sets every home but not `TMPDIR`, and four suites never remove what they create. After this task the runner points `TMPDIR` into its throwaway root, fails a run that leaves anything there, and fails a run that adds `anyengine-*` entries to the real temp directory.

**Files:**
- Modify: `scripts/test-hermetic.mjs`
- Create: `test/helpers/tmp.mts`
- Modify: `test/hermetic.test.mts` (one new test)
- Modify: `test/adapter.test.mts`, `test/workflow-cli.test.mts`, `test/workflow-scheduler.test.mts`, `test/run-registry.test.mts`, and any other suite the new check names
- Modify: `test/AGENTS.md`, `docs/quality.md`, `CHANGELOG.md` (new `### M1: Codex router` under `## Unreleased`)

**Interfaces:**
- Consumes: `test/helpers/children.mts` (`killChildren(): Promise<void>`).
- Produces: `test/helpers/tmp.mts` exports `tempDir(prefix: string): Promise<string>` and `removeTempDirs(): Promise<void>`. Every later task creates temp directories with `tempDir` and registers `after(removeTempDirs)` (after `killChildren` where the suite spawns children). The runner exports `TMPDIR`, `TMP` and `TEMP` as `<root>/tmp` to every suite.

- [ ] **Step 1: Write the failing guard test**

Append to `test/hermetic.test.mts`:

```ts
test('temp files land inside the hermetic root', () => {
  const tmp = process.env.TMPDIR ?? ''
  assert.ok(inside(tmp), `TMPDIR is outside the hermetic root: ${tmp}`)
  assert.equal(realpathSync(tmpdir()), realpathSync(tmp))
})
```

Add `realpathSync` from `node:fs` and `tmpdir` from `node:os` to its imports.

- [ ] **Step 2: Run it to see it fail**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/hermetic.test.mjs`
Expected: FAIL, `✖ temp files land inside the hermetic root` with `TMPDIR is outside the hermetic root`.

- [ ] **Step 3: Point TMPDIR into the root and check what is left behind**

In `scripts/test-hermetic.mjs`:

1. Add `readdirSync` is already imported; add `basename` to the `node:path` import.
2. Directly after `const root = realpathSync(mkdtempSync(join(tmpdir(), 'anyengine-hermetic-')))`, add:

```js
// Every suite's temp files land here, so the run can check what is left.
const tmp = join(root, 'tmp')
mkdirSync(tmp)
// The real temp directory, and what already sat there: a suite that bypasses
// TMPDIR (a hard-coded /tmp, an inherited variable) shows up as a new entry.
const hostTmp = tmpdir()
const hostBefore = new Set(listAnyengine(hostTmp))

function listAnyengine(dir) {
  try {
    return readdirSync(dir).filter((name) => name.startsWith('anyengine-'))
  } catch {
    return []
  }
}
```

3. In the `Object.assign(env, { ... })` block, add `TMPDIR: tmp, TMP: tmp, TEMP: tmp,`.
4. Replace the last two lines (`rmSync(root, ...)` and `process.exit(result.status ?? 1)`) with:

```js
// Node's own coverage scratch is removed by Node; anything else a suite made
// in TMPDIR and did not remove is a leak (1,091 dirs piled up before this).
const IGNORED = /^node-coverage-/
const leftovers = readdirSync(tmp).filter((name) => !IGNORED.test(name))
const strays = listAnyengine(hostTmp).filter(
  (name) => !hostBefore.has(name) && name !== basename(root),
)
rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
let status = result.status ?? 1
if (leftovers.length > 0) {
  console.error(
    `test-hermetic: suites left ${leftovers.length} entr${leftovers.length === 1 ? 'y' : 'ies'} in TMPDIR (remove them in after()):\n  ${leftovers.sort().join('\n  ')}`,
  )
  status = status || 1
}
if (strays.length > 0) {
  console.error(
    `test-hermetic: suites wrote outside TMPDIR, into ${hostTmp}:\n  ${strays.sort().join('\n  ')}`,
  )
  status = status || 1
}
process.exit(status)
```

(`strays` only lists names that appeared during this run, so the 1,091 old directories do not fail it. Remove them once by hand after this task lands: `find "$(node -e 'console.log(require("os").tmpdir())')" -maxdepth 1 -name 'anyengine-*' -mmin +60 -print` to review, then the same command with `-exec rm -r {} +`. Never on a path you did not list first.)

- [ ] **Step 4: Add the temp-dir helper**

Create `test/helpers/tmp.mts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Temp directories a suite made, so `after(removeTempDirs)` removes them even
// when an assertion failed half way. scripts/test-hermetic.mjs fails a run
// that leaves anything in TMPDIR.
const made = new Set<string>()

export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  made.add(dir)
  return dir
}

export async function removeTempDirs(): Promise<void> {
  const dirs = [...made]
  made.clear()
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  )
}
```

- [ ] **Step 5: Run the whole suite to see which suites leak**

Run: `T7 npm test 2>&1 | tail -30`
Expected: every test passes, then `test-hermetic: suites left N entries in TMPDIR` listing names such as `anyengine-test-…`, `anyengine-workflow-cli-…`, `anyengine-workflow-state-…`, `anyengine-workflow-log-…`, `anyengine-github-json-…`, `anyengine-run-registry-…`, and exit status 1.

- [ ] **Step 6: Make each suite remove what it creates**

In each suite the check names:

- Replace `await mkdtemp(join(tmpdir(), '<prefix>'))` with `await tempDir('<prefix>')`, keeping the prefix.
- Import `{ removeTempDirs, tempDir } from './helpers/tmp.mjs'` and drop `mkdtemp`/`tmpdir` imports that are no longer used.
- Register cleanup: in a suite without children add `after(removeTempDirs)` (import `after` from `node:test`); in a suite that already has `after(() => killChildren())`, replace that line with `after(async () => { await killChildren(); await removeTempDirs() })` so no child is still writing into a directory being removed.
- A suite that makes a temp file some other way (a socket, `mkdtempSync`) removes it in the same `after`.

For `test/adapter.test.mts` (25 `anyengine-test-` directories) this is one mechanical replacement:

```bash
sed -i '' "s/await mkdtemp(join(tmpdir(), 'anyengine-test-'))/await tempDir('anyengine-test-')/" test/adapter.test.mts
```

then fix its imports and its `after` line by hand.

- [ ] **Step 7: Run the suite until nothing is left behind**

Run: `T7 npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`, the coverage line at or above 80.7, no `test-hermetic:` line, exit status 0. Then:

Run: `T7 node scripts/test-hermetic.mjs dist/test/hermetic.test.mjs`
Expected: `ℹ pass 4`, `ℹ fail 0`.

- [ ] **Step 8: Docs, gates, commit**

In `test/AGENTS.md`, extend the paragraph under `## Running` with: "The runner also points TMPDIR into that root and fails a run that leaves anything there, or that adds `anyengine-*` entries to the real temp directory: make temp directories with `tempDir()` from `test/helpers/tmp.mts` and register `after(removeTempDirs)` (after `killChildren` where the suite spawns children)."

In `docs/quality.md`, extend section 7 with the same two sentences.

In `CHANGELOG.md`, directly under `## Unreleased`, add:

```markdown
### M1: Codex router

- **Tests clean up after themselves.** The hermetic runner points TMPDIR
  into its throwaway root and fails a run that leaves anything there or
  writes `anyengine-*` entries into the real temp directory; the four suites
  that leaked about 47 directories per run now remove them.
```

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: `File-size ratchet OK`, `Complexity ratchet OK: worst 112, 15 over`, `Dependency guard OK`, `Env-docs gate OK`, no typecheck output, `ℹ fail 0`.

```bash
git add scripts/test-hermetic.mjs test/helpers/tmp.mts test/hermetic.test.mts test/*.test.mts \
  test/AGENTS.md docs/quality.md CHANGELOG.md
git commit -m "test: keep suite temp files in the hermetic root and fail on leftovers"
```

**Acceptance:** two consecutive `T7 npm test` runs leave no new `anyengine-*` entry in the real temp directory (`ls "$TMPDIR" | grep -c '^anyengine-'` equal before and after each), and a suite that creates a temp dir without removing it fails the run.

---

### Task 2: Claude's shell fails closed when no sandbox bounds it

**Safety fix to the live build.** A headless probe of the installed `986ab70` (a Claude Sonnet thread, `workspace-write`, `on-request`) found the M0 no-sandbox path relying on the operator: with the real codex child unavailable (`codex.upstream.unavailable`, as after an app update moves the bundled codex), the Claude child kept its own `Bash`; every command raised an approval card, and after "accept" commands ran with **no sandbox** (`echo probe > ~/anyengine-probe.txt` wrote to the home directory). Spec 5.6: "If no sandbox is available, the child refuses to start." M0 deferred that refusal (M0 plan, "Decisions": "nothing unbounded ever runs unattended"), but an approval card for `Bash` does not tell the operator the command runs outside every sandbox, so it is not the consent Codex asks for when it escalates.

**Decision (DECISION NEEDED, D14, recommendation implemented): refuse shell, keep the file tools.** Where the thread's posture bounds the file system (read-only, workspace-write, external) and no sandboxed shell can run, Claude gets no shell at all: `Bash` and `Monitor` are disallowed, the thread shows a one-line notice saying why, and `anyengine status`/`doctor` report the missing codex child (Tasks 19 and 21). `Read`, `Edit` and `Write` stay, under the PreToolUse path checks, which do bound them without an OS sandbox (a write outside the writable roots is asked, with the path on the card, as Codex asks before an escalated patch). This is the narrowest reading of spec 5.6 that keeps it true: the part of the child that cannot be bounded refuses to start. The same rule closes a second case M0 left open: under `untrusted` (every command asked) M0 kept `Bash` so an approval card could be drawn, and an approved command then ran unsandboxed; the sandboxed `exec` tool has no card, so under `untrusted` Claude gets no shell either. Full access (nothing to bound) keeps `Bash`; plan mode has no shell, as before.

**Files:**
- Modify: `src/posture-claude.mts` (`shellMode`, `toClaudeLaunch`, the notices)
- Modify: `test/posture.test.mts` (replace `posture: shell moves to exec only where a sandbox bounds it`; tighten the Codex-to-Claude property test)
- Modify: `test/posture-runtimes.test.mts` (runtime-level regression; the two tests at lines 324-415 that probe `Bash`), `test/anyengine-runtime.test.mts` (the tests at lines 460-490 and around 730 that expect a `Bash` approval round-trip)
- Modify: `docs/guide/bridge.md` (the shell rule), `CHANGELOG.md`

**Interfaces:**
- Consumes: `posture.mts` (`isUnrestricted`, `Posture`), `bridge-exec.mts` (`sandboxExecAvailable`).
- Produces (`src/posture-claude.mts`):

```ts
export type ShellMode = 'bash' | 'exec' | 'none'
export const SHELL_OFF_NO_SANDBOX: string
export const SHELL_OFF_UNTRUSTED: string
export function shellMode(posture: Posture, sandboxExec: boolean): ShellMode
// toClaudeLaunch: disallowedTools is ['Bash', 'Monitor'] unless shellMode is 'bash';
// notice carries SHELL_OFF_* when shellMode is 'none' (joined after PROJECT_CONFIG_NOTICE)
```

- [ ] **Step 1: Write the failing tests**

In `test/posture.test.mts`, replace the test `posture: shell moves to exec only where a sandbox bounds it` with:

```ts
test('posture: shell is exec inside a sandbox, Bash only where nothing is bounded, else none', () => {
  const ws = applyCodexParams(DEFAULT_POSTURE, { permissions: ':workspace' })
  const full = applyCodexParams(DEFAULT_POSTURE, { permissions: ':danger-full-access' })
  const ro = DEFAULT_POSTURE
  assert.equal(shellMode(ws, true), 'exec')
  assert.equal(shellMode(ws, false), 'none')
  assert.equal(shellMode(ro, false), 'none')
  assert.equal(shellMode(full, false), 'bash')
  assert.equal(shellMode(full, true), 'bash')
  assert.equal(shellMode({ ...ws, approval: 'untrusted' }, true), 'none')
  assert.equal(shellMode({ ...ws, plan: true }, true), 'none')
  assert.deepEqual(toClaudeLaunch(ws, { sandboxExec: true }).disallowedTools, ['Bash', 'Monitor'])
  assert.deepEqual(toClaudeLaunch(ws, { sandboxExec: false }).disallowedTools, ['Bash', 'Monitor'])
  assert.deepEqual(toClaudeLaunch(full, { sandboxExec: false }).disallowedTools, [])
  assert.equal(toClaudeLaunch(ws, { sandboxExec: false }).notice, SHELL_OFF_NO_SANDBOX)
  assert.equal(toClaudeLaunch({ ...ws, approval: 'untrusted' }, { sandboxExec: true }).notice, SHELL_OFF_UNTRUSTED)
  assert.equal(toClaudeLaunch(ws, { sandboxExec: true }).notice, null)
})
```

and add `shellMode`, `SHELL_OFF_NO_SANDBOX`, `SHELL_OFF_UNTRUSTED` to its `../src/posture-claude.mjs` import. In the property test `never looser: Codex parent to Claude child (launch and relay), over every posture`, add inside the `sandboxExec` loop, before the tool loop:

```ts
      // Nothing runs a shell outside a sandbox unless nothing is bounded (spec 5.6).
      if (parent.fileSystem.kind !== 'full-access')
        assert.ok(launch.disallowedTools.includes('Bash'), `${JSON.stringify(parent)} keeps Bash`)
```

In `test/posture-runtimes.test.mts` (no codex child is registered in this suite, so `sandboxExecAvailable()` is false, which is the probe's situation), add:

```ts
test('posture: no codex child + workspace-write: no Bash in any runtime, the thread says why, and a shell write outside the workspace is refused, never asked', async () => {
  const ws = applyCodexParams(DEFAULT_POSTURE, { permissions: ':workspace', approvalPolicy: 'on-request' })
  const bridged = context(ws, { mcpServers: { anyengine: { command: 'node', args: [] } } })
  const escape = { command: 'echo probe > ~/anyengine-probe.txt' }
  // The interactive PTY runtime: Bash is not in the session at all.
  const pty = buildInteractiveArgs({ context: bridged, settingsPath: join(tree.base, 's.json'), mcpPath: null, extraArgs: [] })
  assert.ok(pty.slice(pty.indexOf('--disallowedTools')).includes('Bash'))
  assert.ok((claudeLaunchFor(bridged).notice ?? '').includes(SHELL_OFF_NO_SANDBOX))
  // The relay every runtime shares refuses it outright: no approval card.
  assert.equal(relayDecision(bridged, 'Bash', escape).verdict, 'deny')
  // claude -p: refused by flag.
  const args = claudeP().args(bridged)
  assert.ok((args[args.indexOf('--disallowedTools') + 1] ?? '').split(',').includes('Bash'))
  // The SDK runtime: its PreToolUse hook denies, which beats any allow rule.
  const hook = sdkOptions(bridged).hooks.PreToolUse[0].hooks[0]
  const answer = await hook(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: escape },
    'tool-1',
    { signal: new AbortController().signal },
  )
  assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny')
  // Full access keeps Bash: nothing is bounded there.
  assert.notEqual(relayDecision(context(FULL, { mcpServers: bridged.mcpServers }), 'Bash', escape).verdict, 'deny')
})
```

with `buildInteractiveArgs` imported from `../src/anyengine-runtime.mjs`, and `claudeLaunchFor`, `relayDecision`, `SHELL_OFF_NO_SANDBOX` from `../src/posture-claude.mjs`.

Existing tests that expect the old behaviour change with it (no codex child is registered in either suite, so a bounded posture now has no shell):

- `test/posture-runtimes.test.mts`, `an allow rule or a pre-approved tool never runs a call the posture refuses` (line 324): the `Bash` hook answer is still `deny`, but its `permissionDecisionReason` is now the shell-off notice: replace the expected reason string with `SHELL_OFF_NO_SANDBOX` (for `WS_NEVER`, the thread's notice; `claudeLaunchFor(context).notice` may prefix the project-config notice, so compare with `includes`).
- `test/posture-runtimes.test.mts`, `SDK runtime: a call the posture asks about is asked, whatever an allow rule says` (line 374): its probe must be a tool the posture still asks about. Replace the `Bash` call and its `Bash(npm *)` allow rule with a `Write` to a path outside the writable roots (`join(tree.outside, 'x.txt')`) and a `Write(*)` allow rule; the assertions (the hook asks, the allow rule does not turn it into an allow, the call reaches `canUseTool`) stay.
- `test/posture-runtimes.test.mts`, `SDK runtime: on-failure is on-request, and never refuses out-of-bounds calls unasked` (line 236), lines 259-263: `canUseTool('Bash', { command: 'ls' })` under `WS_NEVER` is still `deny`, but the relay now refuses the shell before the sandbox check, so its `message` is the thread's shell-off notice: replace the `deepEqual` with `behavior === 'deny'` and `message.includes(SHELL_OFF_NO_SANDBOX)`.
- `test/posture-runtimes.test.mts`, lines 367-371 (the on-request pre-approval at the end of the line-324 test): `claudeP().args(context(onRequest, { allowedTools: ['Bash'] }))` no longer yields `--allowedTools Bash`, because `Bash` is refused (no sandboxed shell) and so dropped from the pre-approvals and listed under `--disallowedTools`. Move the contract probe to a tool the posture still asks about: `allowedTools: ['Write']`, expecting `--allowedTools` `Write` and `Write` absent from `--disallowedTools`, and add an assertion that `--disallowedTools` lists `Bash`.
- `test/anyengine-runtime.test.mts`, `anyengine runtime: turn, warm-PTY permission round-trip, deny and full access` (line 460): the permission round-trip on the warm PTY moves from `Bash` to an out-of-bounds `Write` (the fake Claude's tool call name and input change; `h.permissionRequests[0]?.toolName` becomes `Write`); add one assertion that the launch argv for that thread lists `Bash` under `--disallowedTools`; the full-access part keeps `Bash`.
- `test/anyengine-runtime.test.mts`, `anyengine runtime: in-bounds writes run, out-of-bounds writes ask the app` (around line 730): its file-tool assertions stay; any expectation that `Bash` is asked becomes `deny`.

Read each test before changing it; change only what the new rule changes.

- [ ] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `shellMode` is not exported.

- [ ] **Step 3: Implement the rule**

In `src/posture-claude.mts`, replace `usesSandboxExec` with:

```ts
export type ShellMode = 'bash' | 'exec' | 'none'

export const SHELL_OFF_NO_SANDBOX =
  "Shell commands are off in this thread: this Mac's codex, which sandboxes them, is not running. Files can still be read and edited within the thread's folders."
export const SHELL_OFF_UNTRUSTED =
  'Shell commands are off in this thread: its approval mode asks before every command, and sandboxed commands have no approval card here.'

// Where a Claude child's shell runs (spec 5.6): in the parent's sandbox (the
// bridge `exec` tool, the real codex child's command/exec) whenever that
// sandbox exists and bounds something; as Claude's own Bash only where
// nothing is bounded (full access); nowhere otherwise. "Nowhere" is the
// fail-closed case: no codex child to sandbox a command, or an approval mode
// that asks before every command while exec has no approval card.
export function shellMode(posture: Posture, sandboxExec: boolean): ShellMode {
  if (posture.plan) return 'none'
  if (posture.fileSystem.kind === 'full-access') return 'bash'
  if (posture.approval === 'untrusted') return 'none'
  return sandboxExec ? 'exec' : 'none'
}
```

and in `toClaudeLaunch`:

```ts
  const shell = shellMode(posture, options.sandboxExec)
  const shellNotice =
    shell !== 'none' || posture.plan
      ? null
      : posture.approval === 'untrusted'
        ? SHELL_OFF_UNTRUSTED
        : SHELL_OFF_NO_SANDBOX
  const notices = [isolated ? PROJECT_CONFIG_NOTICE : null, shellNotice].filter(Boolean)
  return {
    permissionMode: posture.plan ? 'plan' : null,
    disallowedTools: shell === 'bash' ? [] : ['Bash', 'Monitor'],
    relayPosture: posture,
    trustWorkspace: posture.trust !== 'untrusted',
    settingSources: isolated ? 'user' : null,
    notice: notices.length > 0 ? notices.join(' ') : null,
  }
```

(`isolated` and `exempt` stay as they are.) Update the comment above `usesSandboxExec`'s old call sites; `grep -rn usesSandboxExec src test` must print nothing afterwards. In plan mode Bash was already unavailable (Claude's plan mode); listing it as disallowed changes nothing there.

The launch flag covers the PTY runtime; the SDK runtime (`src/native-runtime.mts`, at its size baseline) does not read `disallowedTools`, so the refusal also goes where every runtime looks, the relay. In `relayDecision`, before `decideClaudeTool`:

```ts
  // A tool the launch leaves out (a shell no sandbox bounds, Task 2) is
  // refused outright, whichever runtime asks: never an approval card.
  const launch = claudeLaunchFor(context)
  if (launch.disallowedTools.includes(toolName)) {
    const why = launch.notice ?? 'shell commands go through the sandboxed exec tool in this thread'
    return { verdict: 'deny', reason: why }
  }
```

(`claude -p` builds its `--disallowedTools` from the relay's refusals, so it follows too.)

- [ ] **Step 4: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/posture.test.mjs dist/test/posture-runtimes.test.mjs dist/test/anyengine-runtime.test.mjs`
Expected: PASS, `ℹ fail 0`, including the regression test and `never looser: Codex parent to Claude child (launch and relay), over every posture`.

- [ ] **Step 5: Docs, gates, commit**

In `docs/guide/bridge.md`, in the section on Claude children's posture, add: "Shell: inside the thread's sandbox through the `exec` tool when this Mac's codex is running; Claude's own Bash only under full access; otherwise no shell, and the thread says so. Under an approval mode that asks before every command (`untrusted`) Claude has no shell either, because sandboxed commands have no approval card."

In `CHANGELOG.md` under `### M1: Codex router`:

```markdown
- **Claude's shell fails closed.** When this Mac's codex (which sandboxes
  shell commands) is not running, or the thread asks before every command, a
  Claude thread in a bounded mode gets no shell instead of an approval card
  for a command that would run outside every sandbox. File tools stay, under
  the relay's path checks.
```

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/posture-claude.mts test/posture.test.mts test/posture-runtimes.test.mts test/anyengine-runtime.test.mts docs/guide/bridge.md CHANGELOG.md
git commit -m "fix: give Claude no shell where no sandbox bounds it, instead of an unsandboxed approval"
```

**Acceptance:** no posture other than full access yields a launch with `Bash` when `sandboxExec` is false; in the PTY, `claude -p` and SDK runtimes a shell write outside the workspace is refused without an approval card, and the thread carries the notice.

---

### Task 3: Claude finds the sandboxed shell without being told

**UX fix to the live build.** With the codex child running, Bash is correctly removed and shell goes through `mcp__anyengine__exec`, which works (`pwd`, a write in the cwd, "Operation not permitted" outside it, no prompts). But Claude Code defers MCP tools behind tool search, so asked plainly to "run pwd", Claude answered that the session has no shell tool; it only worked once told to search for `mcp__anyengine__exec`. Claude Code 2.1.285 reads `_meta["anthropic/alwaysLoad"] === true` on a tool in an MCP server's `tools/list` ("always included in the prompt and never deferred behind tool search"; the string is in the installed bundle). Marking `exec` that way fixes it with no prompt text at all, inside spec 3's minimal-injection rule.

**Files:**
- Modify: `src/bridge-mcp.mts` (`exec` gets `_meta`)
- Modify: `test/bridge.test.mts` (tools/list assertion)
- Create: `scripts/probe-claude-exec.mjs` (one real, tiny Claude turn, isolated homes)
- Modify: `scripts/AGENTS.md`, `docs/guide/bridge.md`

**Interfaces:**
- Consumes: `bridge-mcp.mts` `BRIDGE_TOOLS`, `toolsFor`.
- Produces: `toolsFor(threadId)` lists `exec` with `_meta: { 'anthropic/alwaysLoad': true }`; no other tool carries it. `node scripts/probe-claude-exec.mjs` exits 0 when a real Claude turn asked to "run pwd" called `exec` and was never asked for approval.

- [ ] **Step 1: Check the mechanism in the installed Claude**

Run: `strings "$(python3 -c 'import os,shutil;print(os.path.realpath(shutil.which("claude")))')" | grep -c 'anthropic/alwaysLoad'`
Expected: 1 or more. If 0, stop: the fallback is one line in the Claude addendum ("Shell: run commands with the anyengine `exec` tool."), which must then replace, not add to, the addendum's line (spec 3 allows one).

- [ ] **Step 2: Write the failing test**

In `test/bridge.test.mts`, in the test `bridge: exec runs through the child's command/exec under the caller's sandbox` (around line 985; its bridge process carries a thread id, so `exec` is listed), directly after `const tools = await bridge.request('tools/list', {})` (around line 1001), add:

```ts
    const listed = tools.result.tools as Array<{ name: string; _meta?: Record<string, unknown> }>
    // exec is never deferred behind Claude Code's tool search; nothing else is forced in.
    for (const tool of listed) {
      assert.equal(tool._meta?.['anthropic/alwaysLoad'] === true, tool.name === 'exec', tool.name)
    }
```

(the test at line 278 lists tools for a bridge without a thread id, where `exec` is absent, so the assertion belongs here.)

- [ ] **Step 3: Run it to see it fail**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/bridge.test.mjs 2>&1 | grep -E '✖|ℹ fail' | head -3`
Expected: FAIL on `exec`.

- [ ] **Step 4: Mark exec always loaded**

In `src/bridge-mcp.mts`, add to the `exec` entry of `BRIDGE_TOOLS`, after `inputSchema`:

```ts
    // Claude Code defers MCP tools behind tool search; a Claude thread whose
    // shell is this tool then believes it has none. Always loaded instead.
    _meta: { 'anthropic/alwaysLoad': true },
```

- [ ] **Step 5: Run it to see it pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/bridge.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 6: Verify with one real, tiny Claude turn**

Create `scripts/probe-claude-exec.mjs`: it starts `dist/src/adapter.mjs app-server` over stdio from this worktree with `CODEX_HOME`, `ANYENGINE_HOME`, `ANYENGINE_DEBUG_LOG` and `ANYENGINE_ROOT` in one fresh `mktemp -d "$TMPDIR/claude-exec.XXXXXX"` directory, `ANYENGINE_RUNTIME_TYPE=anyengine`, `ANYENGINE_MODELS=haiku`, and no `ANYENGINE_REAL_CODEX` (the app's bundled codex; it needs no login for `command/exec`); sends `initialize`, `thread/start {model: "haiku", cwd: <project>, sandbox: "workspace-write", approvalPolicy: "on-request"}`, `turn/start` with the text `run pwd and reply with its output only`, where `<project>` is `--project DIR` (default `~/.anyengine/smoke/claude-project`), created if missing and never removed: one fixed directory, so Claude Code adds one project entry to `~/.claude.json`, once, however often the probe runs (it never touches that file itself); waits up to 180 s for `turn/completed`; then prints `exec-called` if any `item/completed` notification carries an `mcpToolCall` item for server `anyengine` and tool `exec`, `approval-requested` if the adapter sent any `item/commandExecution/requestApproval` or `item/fileChange/requestApproval` request, and the final agent message; exits 0 only for `exec-called` without `approval-requested` and an answer containing `<project>`; removes the probe directory (not `<project>`). It never touches `~/.codex`; the Claude login it uses is the operator's own `claude`, and the turn is PONG-sized.

Run: `T7 npm run build && T7 node scripts/probe-claude-exec.mjs --project "$TASK_STORAGE/claude-project"`
Expected: `exec-called`, the probe's `work` path as the answer, exit 0. If it prints `exec-called` never, stop and report the transcript: the tool was not loaded or not chosen.

- [ ] **Step 7: Docs, gates, commit**

In `scripts/AGENTS.md` add: "- `probe-claude-exec.mjs`: one real, tiny Claude turn in an isolated adapter asked to run `pwd`; passes when Claude used the sandboxed `exec` tool without an approval prompt." In `docs/guide/bridge.md`: "The `exec` tool is marked always-loaded (`_meta["anthropic/alwaysLoad"]`), so Claude sees its shell without searching for it."

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/bridge-mcp.mts test/bridge.test.mts scripts/probe-claude-exec.mjs scripts/AGENTS.md docs/guide/bridge.md
git commit -m "fix: keep the sandboxed exec tool loaded so Claude finds its shell"
```

**Acceptance:** `tools/list` marks only `exec` always-loaded; the real probe shows Claude running `pwd` through `exec` with no approval request.

---

### Task 4: The restart check watches only the app's own activity

`scripts/preflip-check.mjs` treats any rollout written in `~/.codex/sessions` in the last 120 s as a turn in flight. A batch job on this Mac runs `codex exec` every few minutes (`session_meta.source == "exec"`), which kept an app restart waiting about 50 minutes on 2026-09-30 while the app was idle. A restart of ChatGPT.app interrupts only the app's turns: the adapter's (its debug log and in-progress rows) and the app's codex threads (rollouts whose `session_meta.source` is the app's, `vscode`, or a sub-agent of one). `anyengine on`/`off`/`restart` (Task 26) run this check; the switch-on (Task 30) waits on it.

**Files:**
- Modify: `scripts/preflip-check.mjs`
- Modify: `test/flip-tools.test.mts`
- Modify: `scripts/AGENTS.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: `preflip-check` ignores a recent rollout only when its first line is a `session_meta` whose `payload.source` is exactly `exec`, `cli` or `mcp` (listed as "ignored (not the app's)"); every other rollout counts as activity: the app's (`vscode`), a sub-agent's, an unknown source, no `session_meta` line, or a first line that cannot be read or parsed (fail closed). The existing test at `test/flip-tools.test.mts:438`, whose rollout is `{}`, therefore stays busy. The quiet report names how many were ignored.

- [ ] **Step 1: Write the failing test**

Append to `test/flip-tools.test.mts`:

```ts
test('preflip-check ignores codex exec and CLI rollouts, but not the app’s or a sub-agent’s', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-preflip-'))
  try {
    const codexHome = join(root, 'codex')
    const adapterHome = join(root, 'adapter')
    const day = join(codexHome, 'sessions', '2026', '09', '30')
    mkdirSync(day, { recursive: true })
    mkdirSync(adapterHome, { recursive: true })
    const meta = (source: unknown) => `${JSON.stringify({ type: 'session_meta', payload: { id: 'x', source } })}\n`
    writeFileSync(join(day, 'rollout-exec.jsonl'), meta('exec'))
    writeFileSync(join(day, 'rollout-cli.jsonl'), meta('cli'))
    const quiet = quietCheck(codexHome, adapterHome)
    assert.equal(quiet.status, 0, quiet.stderr)
    assert.match(quiet.stdout, /2 recent rollouts ignored \(not the app's\)/)
    writeFileSync(join(day, 'rollout-sub.jsonl'), meta({ subagent: { thread_spawn: { parent_thread_id: 'p' } } }))
    assert.equal(quietCheck(codexHome, adapterHome).status, 1)
    rmSync(join(day, 'rollout-sub.jsonl'))
    writeFileSync(join(day, 'rollout-app.jsonl'), meta('vscode'))
    assert.match(quietCheck(codexHome, adapterHome).stderr, /rollout-app\.jsonl was written \d+s ago/)
    rmSync(join(day, 'rollout-app.jsonl'))
    writeFileSync(join(day, 'rollout-junk.jsonl'), 'not json\n')
    assert.equal(quietCheck(codexHome, adapterHome).status, 1, 'unreadable counts as busy')
    rmSync(join(day, 'rollout-junk.jsonl'))
    writeFileSync(join(day, 'rollout-bare.jsonl'), '{}\n')
    assert.equal(quietCheck(codexHome, adapterHome).status, 1, 'no session_meta counts as busy')
    rmSync(join(day, 'rollout-bare.jsonl'))
    writeFileSync(join(day, 'rollout-odd.jsonl'), meta('something-new'))
    assert.equal(quietCheck(codexHome, adapterHome).status, 1, 'an unknown source counts as busy')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
```

Update the two existing assertions on the report's rollout line, which Step 3 replaces: `test/flip-tools.test.mts:453` (`/sessions: newest rollout \d+s ago/`) becomes `/sessions: 0 app rollouts in the window, 0 recent rollouts ignored \(not the app's\)/` (that rollout was aged out of the window just before), and `:575` (`${join(codexHome, 'sessions')}: no rollouts`) becomes `${join(codexHome, 'sessions')}: 0 app rollouts in the window, 0 recent rollouts ignored (not the app's)`.

(`quietCheck` is the existing helper in this file; the test's sandbox has no ChatGPT.app, so run it with `--app` pointed at a fake bundle the existing staged-update tests already build, or reuse their helper that does.)

- [ ] **Step 2: Run it to see it fail**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/flip-tools.test.mjs 2>&1 | grep -E '✖|ℹ fail' | head -3`
Expected: FAIL, the exec rollout counts as activity.

- [ ] **Step 3: Classify rollouts by their source**

In `scripts/preflip-check.mjs`, replace the single `newestFile(sessions, 4)` check with a scan of rollouts written within the quiet window:

```js
// A restart interrupts the app's turns only. Its codex threads write rollouts
// whose session_meta names the app (`vscode`) or a sub-agent of one; a
// `codex exec` batch job or a terminal session also writes rollouts here and
// must not hold the restart (2026-09-30: an exec job every few minutes kept
// one waiting for 50 minutes). A rollout whose first line cannot be read is
// counted: not being able to tell is not quiet.
function recentFiles(dir, depth, sinceMs, out = []) {
  const listing = depth < 0 ? null : listOrNull(dir)
  if (!listing) return out
  for (const entry of listing) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) recentFiles(full, depth - 1, sinceMs, out)
    else {
      try {
        const mtimeMs = statSync(full).mtimeMs
        if (mtimeMs >= sinceMs) out.push({ path: full, mtimeMs })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
  return out
}

// Only a rollout that says it is not the app's is ignored.
const NOT_THE_APP = new Set(['exec', 'cli', 'mcp'])

function isAppRollout(path) {
  let first = ''
  try {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(65536)
      first = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8').split('\n')[0]
    } finally {
      closeSync(fd)
    }
    const line = JSON.parse(first)
    return !(line?.type === 'session_meta' && NOT_THE_APP.has(line?.payload?.source))
  } catch {
    return true
  }
}
```

(import `openSync`, `readSync`, `closeSync` from `node:fs`). In the main block, replace `const rollout = newestFile(sessions, 4)` and its use with:

```js
  const recent = recentFiles(sessions, 4, now - quietMs)
  const appRollouts = recent.filter((file) => isAppRollout(file.path))
  const ignored = recent.length - appRollouts.length
```

push `${file.path} was written ${ago(file)}` into `busy` for each of `appRollouts`, and in the quiet report replace the rollout line with `  ${sessions}: ${appRollouts.length} app rollouts in the window, ${ignored} recent rollouts ignored (not the app's)`. Keep `newestFile` only if something else still uses it.

Update the header comment's first paragraph to say "a rollout that is not explicitly a `codex exec`, CLI or MCP session's".

- [ ] **Step 4: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/flip-tools.test.mjs`
Expected: PASS, `ℹ fail 0`, including the existing `preflip-check refuses while a rollout or the adapter log was just written` (its `{}` rollout still counts as busy).

- [ ] **Step 5: Docs, gates, commit**

Update the `preflip-check.mjs` entry in `scripts/AGENTS.md`: "exits 1 while a recent Codex rollout that is not explicitly a `codex exec`, CLI or MCP session's, the adapter log or an in-progress adapter turn shows activity, or while ChatGPT.app has a Sparkle update staged".

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add scripts/preflip-check.mjs test/flip-tools.test.mts scripts/AGENTS.md
git commit -m "fix: let the restart check ignore codex exec and CLI rollouts"
```

**Acceptance:** an `exec`, `cli` or `mcp` rollout written seconds ago does not block the check; every other rollout does (the app's, a sub-agent's, an unknown source, no `session_meta`, unreadable).

---
### Task 5: The app's Claude pick stays out of the shared `config.toml`

Decision D15. The operator's `~/.codex/config.toml` says `model = "sonnet"` today. ChatGPT.app saves its model picker with `config/batchWrite` (or `config/value/write`); in the native mux those go to the codex child (`routeRequest` falls through to `upstream`, `src/codex-mux.mts:420-426`), and codex writes them into the shared user `config.toml`, the file every terminal `codex` reads too. A terminal `codex` with no `-m` then asks OpenAI for `sonnet`. From this task on, the adapter keeps a non-GPT model pick (one the adapter serves: Claude, Grok, anything `isCodexOpenAiModel` rejects) in its own state, `$ANYENGINE_HOME/app-model-pick.json`, and overlays it on `config/read`, so the app still shows its pick; a GPT pick still goes to codex and clears the adapter's. The existing line is removed at the switch-on (Task 24 writes it as a tracked change, Task 30 checks both directions live); the doctor warns about it (Task 21).

Nothing here changes what the live app reads: it is code in the worktree, activated with the lib at the switch-on.

**Files:**
- Create: `src/config-writes.mts`
- Modify: `src/codex-mux.mts` (move `mergeConfigRead` out, route the two write methods, about 20 lines shorter)
- Modify: `test/fixtures/fake-codex-app-server.mjs` (a config file it really writes, versions, layers)
- Create: `test/config-writes.test.mts`
- Modify: `src/AGENTS.md`, `docs/guide/bridge.md`, `scripts/size-baseline.json` (the lower `codex-mux.mts` figure)

**Interfaces:**
- Consumes: `util.mts` (`adapterHome`, `isCodexOpenAiModel`, `debugLog`), `codex-upstream.mts` (`CodexUpstream.request`, `forwardRequest`), `rpc-shape` helpers as they are in `codex-mux.mts` today (`asRecord`).
- Produces:

```ts
// src/config-writes.mts
export const CONFIG_WRITE_METHODS: ReadonlySet<string>          // 'config/value/write', 'config/batchWrite'
export function appModelPickPath(): string                       // <adapterHome()>/app-model-pick.json
// A model key is `model` or `review_model`, top level or under a profile
// (`profiles.<name>.model`). It stays local when its value is a non-empty id
// codex cannot serve itself.
export function staysLocal(edit: { keyPath: string; value: unknown }): boolean
export interface SplitWrite {
  forward: Record<string, unknown> | null   // params for the child, or null when nothing is left for it
  picks: Record<string, string | null>      // keyPath -> the adapter's pick; null clears it
}
export function splitModelEdits(method: string, params: Record<string, unknown>): SplitWrite
export class AppModelPick {
  constructor(path?: string)
  read(): Record<string, string>            // {} when missing or unreadable
  apply(picks: Record<string, string | null>): void   // 0600, write-then-rename; removes the file when empty
  overlay(config: Record<string, unknown>): Record<string, unknown>   // each keyPath set on a copy
}
export interface ConfigChild {
  request(method: string, params: unknown): Promise<unknown>
}
export type WritePlan = { forward: Record<string, unknown> } | { answer: unknown } | { error: string }
export class ConfigWrites {
  constructor(child: ConfigChild, pick?: AppModelPick)
  plan(method: string, params: Record<string, unknown>): Promise<WritePlan>
  mergeRead(upstream: Promise<unknown>, local: Promise<unknown>): Promise<unknown>
}
```

The pick file's shape is `{ "model": "sonnet" }` (keyPath to id). Task 24 seeds it at the switch-on with the value it removes from `config.toml`, and the doctor (Task 21) reads it.

- [ ] **Step 1: Give the fake codex a config file it really writes**

In `test/fixtures/fake-codex-app-server.mjs`, add a config state that behaves like codex's user `config.toml` as far as these methods go: a JSON object of `keyPath -> value` kept in `process.env.FAKE_CODEX_CONFIG` when that is set (read at every request, written after every write), in memory otherwise; its version is `fake-` plus the first 12 hex of the SHA-256 of `JSON.stringify(state)`.

```js
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
// (readFileSync / writeFileSync / join are already imported by the fixture; add what is missing)

let memoryConfig = {}
function configState() {
  const path = process.env.FAKE_CODEX_CONFIG
  if (!path) return memoryConfig
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}
function saveConfig(state) {
  const path = process.env.FAKE_CODEX_CONFIG
  if (path) writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
  else memoryConfig = state
}
const configVersion = (state) =>
  `fake-${createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 12)}`
const userConfigFile = () => join(process.env.CODEX_HOME ?? '/nonexistent', 'config.toml')

function writeConfig(id, edits) {
  const state = configState()
  for (const edit of edits) {
    if (edit.value === null) delete state[edit.keyPath]
    else state[edit.keyPath] = edit.value
  }
  saveConfig(state)
  return respond(id, {
    status: 'ok',
    version: configVersion(state),
    filePath: userConfigFile(),
    overriddenMetadata: null,
  })
}
```

In `handleRequest`, add the two write cases and make `config/read` answer from the state (the default model stays `gpt-5.6-sol`, so the existing mux test at `test/codex-mux.test.mts:315` keeps passing):

```js
    case 'config/value/write':
      return writeConfig(id, [{ keyPath: params.keyPath, value: params.value }])
    case 'config/batchWrite':
      return writeConfig(id, Array.isArray(params.edits) ? params.edits : [])
    case 'config/read': {
      const state = configState()
      const user = { type: 'user', file: userConfigFile(), profile: null }
      return respond(id, {
        config: {
          model: 'gpt-5.6-sol',
          model_provider: 'openai',
          model_providers: { openai: { name: 'OpenAI' } },
          ...state,
        },
        origins: { model: { name: 'fake' } },
        layers: params.includeLayers
          ? [{ name: user, version: configVersion(state), config: state, disabledReason: null }]
          : null,
      })
    }
```

(replace the existing `config/read` case; `state` holds dotted keyPaths flat, which is enough for the tests: they only read `model`).

- [ ] **Step 2: Write the failing tests**

Create `test/config-writes.test.mts`:

```ts
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { AppModelPick, ConfigWrites, splitModelEdits, staysLocal } from '../src/config-writes.mjs'
import { AdapterClient, type Wire } from './helpers/adapter-client.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(async () => {
  await killChildren()
  await removeTempDirs()
})

const adapter = resolve('dist/src/adapter.mjs')
const fakeCodex = resolve('test/fixtures/fake-codex-app-server.mjs')
const edit = (keyPath: string, value: unknown) => ({ keyPath, value, mergeStrategy: 'replace' })

test('config writes: a model codex cannot serve stays local, anything else goes to codex', () => {
  for (const id of ['sonnet', 'opus', 'haiku', 'fable', 'claude-opus-4-7', 'grok-4', 'grok-code-fast-1', 'some-future-claude']) {
    assert.equal(staysLocal(edit('model', id)), true, id)
    assert.equal(staysLocal(edit('review_model', id)), true, id)
    assert.equal(staysLocal(edit('profiles.work.model', id)), true, id)
  }
  for (const id of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'o3', 'codex-mini-latest']) {
    assert.equal(staysLocal(edit('model', id)), false, id)
  }
  assert.equal(staysLocal(edit('model', '')), false)
  assert.equal(staysLocal(edit('model', null)), false)
  assert.equal(staysLocal(edit('model_reasoning_effort', 'sonnet')), false, 'only model keys')
  assert.equal(staysLocal(edit('model_provider', 'claude-code')), false)
})

test('config writes: a batch is split, and a GPT pick clears the local one', () => {
  const batch = splitModelEdits('config/batchWrite', {
    edits: [edit('model', 'sonnet'), edit('model_reasoning_effort', 'high')],
    expectedVersion: 'v1',
  })
  assert.deepEqual(batch.picks, { model: 'sonnet' })
  assert.deepEqual(batch.forward, { edits: [edit('model_reasoning_effort', 'high')], expectedVersion: 'v1' })

  const onlyClaude = splitModelEdits('config/value/write', edit('model', 'opus'))
  assert.equal(onlyClaude.forward, null)
  assert.deepEqual(onlyClaude.picks, { model: 'opus' })

  const gpt = splitModelEdits('config/value/write', edit('model', 'gpt-6.1-sol'))
  assert.deepEqual(gpt.forward, edit('model', 'gpt-6.1-sol'))
  assert.deepEqual(gpt.picks, { model: null })

  const cleared = splitModelEdits('config/batchWrite', { edits: [edit('model', null)] })
  assert.deepEqual(cleared.picks, { model: null })
  assert.deepEqual(cleared.forward, { edits: [edit('model', null)] })

  const unrelated = splitModelEdits('config/batchWrite', { edits: [edit('approval_policy', 'never')] })
  assert.deepEqual(unrelated.picks, {})
  assert.deepEqual(unrelated.forward, { edits: [edit('approval_policy', 'never')] })
})

test('config writes: the pick file is private, round-trips, and disappears when empty', async () => {
  const dir = await tempDir('ae-cfg-')
  const pick = new AppModelPick(join(dir, 'app-model-pick.json'))
  assert.deepEqual(pick.read(), {})
  pick.apply({ model: 'sonnet', 'profiles.work.model': 'opus' })
  assert.equal(statSync(join(dir, 'app-model-pick.json')).mode & 0o777, 0o600)
  assert.deepEqual(new AppModelPick(join(dir, 'app-model-pick.json')).read(), {
    model: 'sonnet',
    'profiles.work.model': 'opus',
  })
  const overlaid = pick.overlay({ model: 'gpt-6.1-sol', profiles: { work: { model: 'gpt-6-astra', x: 1 } } })
  assert.deepEqual(overlaid, { model: 'sonnet', profiles: { work: { model: 'opus', x: 1 } } })
  pick.apply({ model: null, 'profiles.work.model': null })
  assert.equal(existsSync(join(dir, 'app-model-pick.json')), false)
  assert.deepEqual(pick.overlay({ model: 'gpt-6.1-sol' }), { model: 'gpt-6.1-sol' })
})

test('config writes: a write with nothing left for codex is answered with the file’s current version', async () => {
  const dir = await tempDir('ae-cfg-')
  const calls: Array<[string, unknown]> = []
  const child = {
    request: async (method: string, params: unknown) => {
      calls.push([method, params])
      return {
        config: {},
        origins: {},
        layers: [
          { name: { type: 'system', file: '/etc/codex/config.toml' }, version: 'sys', config: {}, disabledReason: null },
          { name: { type: 'user', file: '/h/.codex/config.toml', profile: null }, version: 'user-v7', config: {}, disabledReason: null },
        ],
      }
    },
  }
  const writes = new ConfigWrites(child, new AppModelPick(join(dir, 'pick.json')))
  const plan = await writes.plan('config/value/write', edit('model', 'sonnet'))
  assert.deepEqual(plan, {
    answer: { status: 'ok', version: 'user-v7', filePath: '/h/.codex/config.toml', overriddenMetadata: null },
  })
  assert.deepEqual(calls, [['config/read', { includeLayers: true }]])

  const failing = new ConfigWrites(
    { request: async () => { throw new Error('child gone') } },
    new AppModelPick(join(dir, 'pick2.json')),
  )
  const failed = await failing.plan('config/value/write', edit('model', 'opus'))
  assert.ok('error' in failed)
  assert.deepEqual(new AppModelPick(join(dir, 'pick2.json')).read(), {}, 'no pick stored when the answer failed')
})

function launchMux(home: string): AdapterClient {
  return new AdapterClient(
    spawn(process.execPath, [adapter, '-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        ANYENGINE_MOCK: '1',
        ANYENGINE_HOME: join(home, 'adapter'),
        CODEX_HOME: join(home, 'codex'),
        ANYENGINE_REAL_CODEX: fakeCodex,
        ANYENGINE_MODELS: 'opus,sonnet',
        ANYENGINE_DEFAULT_MODEL: 'opus',
        ANYENGINE_RUNTIME_TYPE: 'mock',
        ANYENGINE_RUNTIME_ENV: join(home, 'missing.env'),
        ANYENGINE_NATIVE_CODEX: '',
        CLAUDE_CODEX_NATIVE_CODEX: '',
        ANYENGINE_GPT_ROUTE: '',
        FAKE_CODEX_CONFIG: join(home, 'codex-config.json'),
        NODE_NO_WARNINGS: '1',
      },
    }),
  )
}

async function started(home: string): Promise<AdapterClient> {
  const client = launchMux(home)
  await client.request('initialize', { clientInfo: { name: 'codex_desktop', title: 'Codex Desktop', version: '26.928' } })
  client.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`)
  return client
}

const sharedConfig = (home: string): Wire =>
  existsSync(join(home, 'codex-config.json')) ? JSON.parse(readFileSync(join(home, 'codex-config.json'), 'utf8')) : {}

test('native mux: the app’s Claude pick never reaches the shared config, and survives a restart', async () => {
  const home = await tempDir('ae-cfgmux-')
  let client = await started(home)
  try {
    const batch = await client.request('config/batchWrite', {
      edits: [edit('model', 'sonnet'), edit('model_reasoning_effort', 'high')],
    })
    assert.equal(batch.result.status, 'ok')
    assert.deepEqual(sharedConfig(home), { model_reasoning_effort: 'high' }, 'only the effort reached codex')
    assert.equal((await client.request('config/read', {})).result.config.model, 'sonnet')

    const layers = await client.request('config/read', { includeLayers: true })
    const single = await client.request('config/value/write', edit('model', 'opus'))
    assert.equal(single.result.version, layers.result.layers[0].version, 'nothing was written, same version')
    assert.equal(sharedConfig(home).model, undefined)
    await client.close()

    client = await started(home)
    assert.equal((await client.request('config/read', {})).result.config.model, 'opus', 'the pick survives a restart')
    assert.equal(sharedConfig(home).model, undefined, 'a terminal codex with no -m still gets its GPT default')

    await client.request('config/value/write', edit('model', 'gpt-6.1-sol'))
    assert.equal(sharedConfig(home).model, 'gpt-6.1-sol')
    assert.equal((await client.request('config/read', {})).result.config.model, 'gpt-6.1-sol')
    assert.equal(existsSync(join(home, 'adapter', 'app-model-pick.json')), false, 'a GPT pick clears the local one')
  } finally {
    await client.close()
  }
})
```

(The Grok ids in the first test are examples of ids `isCodexOpenAiModel` rejects; `staysLocal` does not look them up. If `AdapterClient`'s `request` numbering collides with an explicit id, pass none: the calls above do not.)

- [ ] **Step 3: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/config-writes.mjs'`.

- [ ] **Step 4: Write `src/config-writes.mts`**

```ts
// The app's model picker writes `model` with config/batchWrite or
// config/value/write. Forwarded as they are, codex puts whatever the app picked
// into the user's config.toml, which every terminal `codex` reads too; a
// terminal codex with no -m then asks OpenAI for `sonnet`. A pick codex cannot
// serve itself stays here instead (app-model-pick.json) and is laid over
// config/read, so the app still shows it; a GPT pick goes to codex and clears
// ours. The switch-on seeds this file from the line it removes (Task 24).

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapterHome, debugLog, ensureParent, isCodexOpenAiModel } from './util.mjs'

export const CONFIG_WRITE_METHODS: ReadonlySet<string> = new Set(['config/value/write', 'config/batchWrite'])
const MODEL_KEYS = new Set(['model', 'review_model'])

export function appModelPickPath(): string {
  return join(adapterHome(), 'app-model-pick.json')
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

function isModelKey(keyPath: string): boolean {
  return MODEL_KEYS.has(keyPath.split('.').at(-1) ?? '')
}

export function staysLocal(edit: { keyPath: string; value: unknown }): boolean {
  if (!isModelKey(edit.keyPath) || typeof edit.value !== 'string') return false
  const id = edit.value.trim()
  return id.length > 0 && !isCodexOpenAiModel(id)
}

export interface SplitWrite {
  forward: Record<string, unknown> | null
  picks: Record<string, string | null>
}

export function splitModelEdits(method: string, params: Record<string, unknown>): SplitWrite {
  const single = method === 'config/value/write'
  const edits = single ? [params] : Array.isArray(params.edits) ? params.edits.map(record) : []
  const picks: Record<string, string | null> = {}
  const kept: Record<string, unknown>[] = []
  for (const edit of edits) {
    const keyPath = String(edit.keyPath ?? '')
    if (staysLocal({ keyPath, value: edit.value })) {
      picks[keyPath] = String(edit.value).trim()
      continue
    }
    if (isModelKey(keyPath)) picks[keyPath] = null
    kept.push(edit)
  }
  if (single) return { forward: kept.length > 0 ? params : null, picks }
  return { forward: kept.length > 0 ? { ...params, edits: kept } : null, picks }
}

export class AppModelPick {
  // Fields are declared and assigned in the constructor body: the build is
  // erasable-syntax only (tsconfig erasableSyntaxOnly, src/AGENTS.md), so no
  // parameter properties.
  readonly path: string

  constructor(path: string = appModelPickPath()) {
    this.path = path
  }

  read(): Record<string, string> {
    try {
      const parsed = record(JSON.parse(readFileSync(this.path, 'utf8')))
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    } catch {
      return {}
    }
  }

  apply(picks: Record<string, string | null>): void {
    if (Object.keys(picks).length === 0) return
    const next: Record<string, string> = { ...this.read() }
    for (const [keyPath, id] of Object.entries(picks)) {
      if (id === null) delete next[keyPath]
      else next[keyPath] = id
    }
    if (Object.keys(next).length === 0) {
      rmSync(this.path, { force: true })
      return
    }
    ensureParent(this.path)
    const temp = `${this.path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.path)
  }

  overlay(config: Record<string, unknown>): Record<string, unknown> {
    const picks = Object.entries(this.read())
    if (picks.length === 0) return config
    const out = structuredClone(config)
    for (const [keyPath, id] of picks) setPath(out, keyPath.split('.'), id)
    return out
  }
}

function setPath(target: Record<string, unknown>, path: string[], value: string): void {
  let node = target
  for (const key of path.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object') node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[path.at(-1) as string] = value
}

export interface ConfigChild {
  request(method: string, params: unknown): Promise<unknown>
}

export type WritePlan = { forward: Record<string, unknown> } | { answer: unknown } | { error: string }

export class ConfigWrites {
  private readonly child: ConfigChild
  private readonly pick: AppModelPick

  constructor(child: ConfigChild, pick: AppModelPick = new AppModelPick()) {
    this.child = child
    this.pick = pick
  }

  async plan(method: string, params: Record<string, unknown>): Promise<WritePlan> {
    const split = splitModelEdits(method, params)
    if (split.forward) {
      this.pick.apply(split.picks)
      return { forward: split.forward }
    }
    // Nothing is left for codex, so nothing is written: answer with the file's
    // current version, so the app's next expectedVersion still matches.
    try {
      const answer = await this.unchangedAnswer(params)
      this.pick.apply(split.picks)
      debugLog('config.modelPickKeptLocal', { keyPaths: Object.keys(split.picks) })
      return { answer }
    } catch (error) {
      return { error: `anyengine: the model pick was not saved (${error instanceof Error ? error.message : String(error)})` }
    }
  }

  private async unchangedAnswer(params: Record<string, unknown>): Promise<unknown> {
    const read = record(await this.child.request('config/read', { includeLayers: true }))
    const layers = Array.isArray(read.layers) ? read.layers.map(record) : []
    const wanted = typeof params.filePath === 'string' ? params.filePath : null
    const layer = layers.find((entry) => {
      const name = record(entry.name)
      return wanted ? name.file === wanted : name.type === 'user' && (name.profile ?? null) === null
    })
    if (!layer || typeof layer.version !== 'string') throw new Error('no version for the config file')
    return { status: 'ok', version: layer.version, filePath: record(layer.name).file, overriddenMetadata: null }
  }

  // Moved from codex-mux.mts (mergeConfigRead), plus the overlay: the child's
  // config verbatim, the `claude-code` provider added so the desktop keeps a
  // home for the Claude models in its picker, the app's local pick laid over.
  async mergeRead(upstream: Promise<unknown>, local: Promise<unknown>): Promise<unknown> {
    const [upstreamSettled, localSettled] = await Promise.allSettled([upstream, local])
    const localResult = localSettled.status === 'fulfilled' ? record(localSettled.value) : null
    if (upstreamSettled.status !== 'fulfilled') {
      return localResult ? { ...localResult, config: this.pick.overlay(record(localResult.config)) } : {}
    }
    const upstreamResult = record(upstreamSettled.value)
    const config = record(upstreamResult.config)
    const claudeProvider = record(record(localResult?.config).model_providers)['claude-code']
    if (!claudeProvider) return { ...upstreamResult, config: this.pick.overlay(config) }
    const origins = record(upstreamResult.origins)
    const localOrigins = record(localResult?.origins)
    return {
      ...upstreamResult,
      config: this.pick.overlay({
        ...config,
        model_providers: { ...record(config.model_providers), 'claude-code': claudeProvider },
      }),
      origins: {
        ...origins,
        ...(localOrigins['model_providers.claude-code']
          ? { 'model_providers.claude-code': localOrigins['model_providers.claude-code'] }
          : {}),
      },
    }
  }
}
```

`mergeRead` is `mergeConfigRead` from `src/codex-mux.mts:764-791` with the two requests passed in as promises and every returned `config` passed through the overlay; the mux test at `test/codex-mux.test.mts:314-318` pins its unchanged behaviour. If `ensureParent` is not exported from `util.mts` (it is used by `server-config.mts`), import it from where that file does.

- [ ] **Step 5: Route the writes in the mux**

In `src/codex-mux.mts`:

1. Import `{ CONFIG_WRITE_METHODS, ConfigWrites } from './config-writes.mjs'`, add a field `private readonly configWrites = new ConfigWrites(this.upstream)` next to the other fields that use `this.upstream` (initialise it in the constructor after `this.upstream` if field order requires).
2. In `handleMerged`, the `config/read` case becomes:

```ts
        case 'config/read':
          respond(
            await this.configWrites.mergeRead(
              this.upstream.request('config/read', params),
              this.local.dispatch(peer, 'config/read', params),
            ),
          )
          return
```

3. Delete `mergeConfigRead` (lines 762-791, the comment included).
4. In `handleRequest`, after the `thread/read` rehome line and before `const route = this.routeRequest(...)`:

```ts
    if (CONFIG_WRITE_METHODS.has(method)) {
      const plan = await this.configWrites.plan(method, params)
      if ('forward' in plan) this.upstream.forwardRequest(peer, request.id, method, plan.forward)
      else if ('error' in plan) this.failRequest(peer, request.id, plan.error)
      else peer.send({ jsonrpc: '2.0', id: request.id, result: plan.answer })
      return true
    }
```

A forwarded write keeps the child's own answer and error codes (the app's version-conflict handling is untouched). In degraded mode (no child) the writes already go to the local layer, which writes only `$ANYENGINE_HOME/config.json`.

Run: `wc -l src/codex-mux.mts`
Expected: about 1157, below the 1177 baseline; lower `scripts/size-baseline.json` to the new figure (the gate rewrites or asks, as for Task 13 Step 1).

- [ ] **Step 6: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/config-writes.test.mjs dist/test/codex-mux.test.mjs dist/test/adapter.test.mjs`
Expected: PASS, `ℹ fail 0` (the mux test's `config/read` still sees `gpt-5.6-sol` and the `claude-code` provider; the adapter's local-mode config tests at `test/adapter.test.mts:797-1045` and 2724 are untouched because they run with `ANYENGINE_NATIVE_CODEX=0`).

- [ ] **Step 7: Docs, gates, commit**

Add to `src/AGENTS.md`: "- `config-writes.mts` — the app's model picker: a pick codex cannot serve (Claude, Grok) stays in `$ANYENGINE_HOME/app-model-pick.json` and is laid over `config/read`; only GPT picks reach the shared `config.toml`. Also the merged `config/read`."

Add to `docs/guide/bridge.md`, in the native-codex section, one paragraph: "Picking a Claude or Grok model in the app no longer writes it to `~/.codex/config.toml`. AnyEngine keeps that pick in `~/.codex/anyengine/app-model-pick.json` and shows it to the app, so a terminal `codex` with no `-m` keeps its GPT default. Picking a GPT model writes `config.toml` as before."

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK (`File-size ratchet OK` with the lower `codex-mux.mts` baseline, complexity not up), `ℹ fail 0`, no temp leftovers.

```bash
git add src/config-writes.mts src/codex-mux.mts test/fixtures/fake-codex-app-server.mjs test/config-writes.test.mts \
  src/AGENTS.md docs/guide/bridge.md scripts/size-baseline.json
git commit -m "fix: keep the app's Claude model pick out of the shared codex config"
```

**Acceptance:** with the native mux, a Claude or Grok pick from the app never reaches the child's config writes (so never `config.toml`), is answered with the file's unchanged version, and shows in `config/read` before and after an adapter restart; a GPT pick reaches codex and clears the local one; the shared config's `model` after a Claude pick is still the GPT default a terminal `codex` with no `-m` uses. The live checks of both directions are Task 30 Steps 6 and 12.

---
### Task 6: The Codex wire contract, a repeatable capture, and a 0.159.0 fixture

The router reads a handful of facts from every Codex request: which thread and turn it belongs to, its parent (for a spawned child), whether it is a prewarm, and the model. This task writes those readers once, pins them to a fixture captured from the real bundled codex at zero spend, and leaves a script the update gate (Task 27) reruns against every new app version.

**Files:**
- Create: `src/codex-wire.mts`
- Create: `scripts/capture-codex-wire.mjs`
- Create: `test/fixtures/codex-wire-0.159.0.json` (written by the script, then committed)
- Create: `test/codex-wire.test.mts`
- Modify: `scripts/AGENTS.md`, `src/AGENTS.md`

**Interfaces:**
- Consumes: nothing.
- Produces (`src/codex-wire.mts`):

```ts
export type HeaderBag = Record<string, string | string[] | undefined>
export interface TurnMetadata {
  threadId: string | null
  turnId: string | null
  sessionId: string | null
  agentName: string | null
  requestKind: string | null
  sandboxMode: string | null
  model: string | null
}
export function headerValue(headers: HeaderBag, name: string): string | null
export function turnMetadata(headers: HeaderBag, body: Record<string, unknown> | null): TurnMetadata
export function threadIdOfRequest(headers: HeaderBag, body: Record<string, unknown> | null): string | null
export function turnIdOfRequest(headers: HeaderBag, body: Record<string, unknown> | null): string | null
export function parentThreadIdOfRequest(headers: HeaderBag): string | null
export function isPrewarm(headers: HeaderBag, body: Record<string, unknown> | null): boolean
export function modelHint(headers: HeaderBag): string | null
```

`scripts/capture-codex-wire.mjs [--codex PATH] [--out FILE]` exits 0 and writes the fixture when every contract field was seen, 1 naming the missing ones.

- [ ] **Step 1: Write the capture script**

Create `scripts/capture-codex-wire.mjs`:

```js
#!/usr/bin/env node
// Zero-spend capture of what a bundled codex sends to its model backend.
// Runs `codex app-server` with an isolated CODEX_HOME (an API-key login with
// a fake key, so nothing reaches OpenAI), points openai_base_url at a loopback
// fake backend, hands it a catalog with one extra model through the documented
// model_catalog_json key, starts one ephemeral thread and one turn, and records
// the shape (never the values of credentials) of every request. The router's
// wire contract (src/codex-wire.mts) is checked against the result; the update
// gate runs this against every new app version (src/update-watch.mts).
//
// Usage: node scripts/capture-codex-wire.mjs [--codex PATH] [--out FILE] [--catalog-from FILE]
//   --codex        default: the app's bundled codex (src/bundled-codex.mts rule)
//   --out          default: test/fixtures/codex-wire-<version>.json
//   --catalog-from a models_cache.json or /models answer to take one entry
//                  from (read only); default: a minimal built-in entry
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({
  options: {
    codex: { type: 'string' },
    out: { type: 'string' },
    'catalog-from': { type: 'string' },
  },
})

async function bundledCodex() {
  const url = pathToFileURL(join(repo, 'dist', 'src', 'bundled-codex.mjs')).href
  const { resolveBundledCodex } = await import(url)
  return resolveBundledCodex().path
}

const codex = values.codex ?? (await bundledCodex())
if (!codex) {
  console.error('capture-codex-wire: no bundled codex found; pass --codex')
  process.exit(1)
}
const version = spawnSync(codex, ['--version'], { encoding: 'utf8' }).stdout.trim().split(' ').pop()
const out = values.out ?? join(repo, 'test', 'fixtures', `codex-wire-${version}.json`)
const probe = mkdtempSync(join(tmpdir(), 'anyengine-wire-'))
const home = join(probe, 'codex-home')
const fakeHome = join(probe, 'home')
const work = join(probe, 'work')
for (const dir of [home, fakeHome, work]) mkdirSync(dir, { recursive: true })
const env = { HOME: fakeHome, CODEX_HOME: home, PATH: '/usr/bin:/bin', RUST_LOG: 'warn' }

// Minimal catalog entry (the shape claude-in-codex's FALLBACK_TEMPLATE uses),
// or one real entry taken read-only from a cache the caller names.
function catalog() {
  const minimal = {
    slug: 'gpt-wire-probe',
    display_name: 'Wire probe',
    description: 'capture-codex-wire',
    default_reasoning_level: 'low',
    supported_reasoning_levels: [{ effort: 'low', description: 'low' }],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    availability_nux: null,
    upgrade: null,
    base_instructions: '',
    supports_reasoning_summaries: true,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    context_window: 272000,
    multi_agent_version: 'v1',
  }
  let first = minimal
  if (values['catalog-from']) {
    const models = JSON.parse(readFileSync(values['catalog-from'], 'utf8')).models ?? []
    first = models.find((m) => m.visibility === 'list') ?? minimal
  }
  const gpt = { ...first, priority: 1, multi_agent_version: 'v1' }
  const extra = { ...gpt, slug: 'opus', display_name: 'Claude Opus', priority: 2 }
  return { models: [gpt, extra] }
}
const catalogFile = join(probe, 'catalog.json')
writeFileSync(catalogFile, JSON.stringify(catalog()))

const seen = []
const scrub = (headers) =>
  Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, /authorization|cookie/i.test(k) ? '<redacted>' : v]),
  )
function shapeOfBody(body) {
  if (!body || typeof body !== 'object') return null
  const input = Array.isArray(body.input) ? body.input : []
  return {
    keys: Object.keys(body).sort(),
    clientMetadataKeys: body.client_metadata ? Object.keys(body.client_metadata).sort() : [],
    inputTypes: input.map((i) => `${i?.type}${i?.role ? `:${i.role}` : ''}`),
    promptCacheKeyIsThread: typeof body.prompt_cache_key === 'string',
  }
}
const backend = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    let body = null
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {}
    seen.push({ kind: 'http', method: req.method, path: req.url.split('?')[0], headers: scrub(req.headers), body: shapeOfBody(body) })
    if (req.url.includes('/responses')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const item = { id: 'msg_wire', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PONG', annotations: [] }] }
      const response = { id: 'resp_wire', object: 'response', status: 'completed', model: body?.model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
      let seq = 0
      const send = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`)
      send('response.created', { response: { ...response, status: 'in_progress', output: [] } })
      send('response.output_item.done', { output_index: 0, item })
      send('response.completed', { response })
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
})
backend.on('upgrade', (req, socket) => {
  seen.push({ kind: 'upgrade', path: req.url.split('?')[0], headers: scrub(req.headers) })
  socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n')
})
await new Promise((ok) => backend.listen(0, '127.0.0.1', ok))
const port = backend.address().port

const login = spawnSync(codex, ['login', '--with-api-key'], { env, input: 'sk-anyengine-wire-probe\n', encoding: 'utf8' })
if (login.status !== 0) {
  console.error(`capture-codex-wire: fake API-key login failed: ${login.stderr}`)
  process.exit(1)
}
const args = [
  'app-server',
  '-c', `openai_base_url="http://127.0.0.1:${port}/backend-api/codex"`,
  '-c', `model_catalog_json="${catalogFile}"`,
  '-c', 'mcp_servers={}',
  '-c', 'notify=[]',
]
const child = spawn(codex, args, { env, stdio: ['pipe', 'pipe', 'ignore'] })
const pending = new Map()
const events = []
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.id != null && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  } else if (m.method) events.push(m.method)
})
let nextId = 0
const request = (method, params) =>
  new Promise((ok) => {
    const id = ++nextId
    pending.set(id, ok)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
const timer = setTimeout(() => {
  console.error('capture-codex-wire: timed out')
  child.kill('SIGKILL')
  process.exit(1)
}, 60_000)
await request('initialize', { clientInfo: { name: 'anyengine-wire', version: '0' }, capabilities: { experimentalApi: true } })
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`)
const list = await request('model/list', { includeHidden: true, limit: 100 })
const started = await request('thread/start', { model: catalog().models[0].slug, cwd: work, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true })
const threadId = started.result?.thread?.id ?? null
if (threadId) {
  await request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with the single word PONG' }], effort: 'low' })
  for (let i = 0; i < 100 && !events.includes('turn/completed'); i += 1) await new Promise((ok) => setTimeout(ok, 100))
}
clearTimeout(timer)
child.kill('SIGTERM')
backend.close()

const upgrade = seen.find((s) => s.kind === 'upgrade')
const post = seen.find((s) => s.kind === 'http' && s.method === 'POST' && s.path.endsWith('/responses'))
const meta = (h) => {
  try {
    return Object.keys(JSON.parse(h?.['x-codex-turn-metadata'] ?? '{}')).sort()
  } catch {
    return []
  }
}
const fixture = {
  codexVersion: version,
  modelListIds: (list.result?.data ?? []).map((m) => m.id),
  websocketFirst: Boolean(upgrade),
  upgradeHeaderNames: upgrade ? Object.keys(upgrade.headers).sort() : [],
  upgradeTurnMetadataKeys: meta(upgrade?.headers),
  responsesHeaderNames: post ? Object.keys(post.headers).sort() : [],
  responsesTurnMetadataKeys: meta(post?.headers),
  responsesBody: post?.body ?? null,
  notifications: [...new Set(events)].sort(),
}
const missing = []
if (!fixture.modelListIds.includes('opus')) missing.push('catalog entry "opus" in model/list')
for (const name of ['thread-id', 'session-id', 'x-codex-turn-metadata']) {
  if (!fixture.responsesHeaderNames.includes(name)) missing.push(`header ${name}`)
}
for (const key of ['thread_id', 'turn_id', 'request_kind', 'model']) {
  if (!fixture.responsesTurnMetadataKeys.includes(key)) missing.push(`turn metadata ${key}`)
}
rmSync(probe, { recursive: true, force: true })
if (missing.length > 0) {
  console.error(`capture-codex-wire: ${version} is missing:\n  ${missing.join('\n  ')}`)
  process.exit(1)
}
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`capture-codex-wire: ${version} ok -> ${out}`)
```

- [ ] **Step 2: Capture the fixture from the installed app's codex**

The probe home is isolated and the login key is fake; nothing reaches OpenAI and nothing under `~/.codex` is read or written.

Run: `T7 npm run build && T7 node scripts/capture-codex-wire.mjs`
Expected: `capture-codex-wire: 0.159.0 ok -> <worktree>/test/fixtures/codex-wire-0.159.0.json`. Open the file: `modelListIds` contains `opus`, `websocketFirst` is `true`, `responsesHeaderNames` contains `thread-id`, `session-id`, `x-codex-turn-metadata`, `x-openai-internal-codex-responses-lite`, and `responsesBody.inputTypes` starts with `additional_tools:developer`. If the app has updated since this plan was written, the file is named after the new version; use that name in Step 3.

- [ ] **Step 3: Write the failing contract tests**

Create `test/codex-wire.test.mts`:

```ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  isPrewarm,
  modelHint,
  parentThreadIdOfRequest,
  threadIdOfRequest,
  turnIdOfRequest,
  turnMetadata,
} from '../src/codex-wire.mjs'

const fixture = JSON.parse(readFileSync(resolve('test/fixtures/codex-wire-0.159.0.json'), 'utf8'))
const THREAD = '01a0f297-8ac5-7862-bd5c-50e6ed797973'
const TURN = '01a0f297-8acd-7b93-a3d6-0bb7238f5bce'
const metadata = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ thread_id: THREAD, turn_id: TURN, session_id: THREAD, agent_name: '/root', request_kind: 'turn', sandbox_mode: 'read-only', model: 'opus', ...extra })

test('wire: the 0.159.0 capture carries every field the contract reads', () => {
  for (const name of ['thread-id', 'session-id', 'x-codex-turn-metadata']) {
    assert.ok(fixture.responsesHeaderNames.includes(name), name)
  }
  for (const key of ['thread_id', 'turn_id', 'request_kind', 'model', 'agent_name']) {
    assert.ok(fixture.responsesTurnMetadataKeys.includes(key), key)
  }
  assert.ok(fixture.modelListIds.includes('opus'))
})

test('wire: the thread id comes from the header, then the metadata, then the body', () => {
  assert.equal(threadIdOfRequest({ 'thread-id': THREAD }, null), THREAD)
  assert.equal(threadIdOfRequest({ 'x-codex-turn-metadata': metadata() }, null), THREAD)
  assert.equal(threadIdOfRequest({}, { client_metadata: { thread_id: THREAD } }), THREAD)
  assert.equal(threadIdOfRequest({ 'session-id': THREAD }, null), THREAD)
  assert.equal(threadIdOfRequest({}, { prompt_cache_key: THREAD }), THREAD)
  assert.equal(threadIdOfRequest({}, {}), null)
})

test('wire: turn id, request kind and model come from the turn metadata', () => {
  const headers = { 'x-codex-turn-metadata': metadata() }
  assert.equal(turnIdOfRequest(headers, null), TURN)
  assert.equal(turnMetadata(headers, null).requestKind, 'turn')
  assert.equal(turnMetadata(headers, null).agentName, '/root')
  assert.equal(modelHint(headers), 'opus')
  assert.equal(modelHint({ 'x-codex-routing-hint': 'model=gpt-6-sol' }), 'gpt-6-sol')
  assert.equal(isPrewarm({ 'x-codex-turn-metadata': metadata({ request_kind: 'prewarm' }) }, null), true)
  assert.equal(isPrewarm({}, { generate: false }), true)
  assert.equal(isPrewarm(headers, {}), false)
})

test('wire: junk metadata and arrays read as nothing, never throw', () => {
  assert.equal(turnMetadata({ 'x-codex-turn-metadata': '{not json' }, null).threadId, null)
  assert.equal(threadIdOfRequest({ 'thread-id': ['a', 'b'] }, null), 'a')
  assert.equal(parentThreadIdOfRequest({ 'x-codex-parent-thread-id': ' p1 ' }), 'p1')
  assert.equal(parentThreadIdOfRequest({}), null)
})
```

- [ ] **Step 4: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/codex-wire.mjs'`.

- [ ] **Step 5: Implement the contract**

Create `src/codex-wire.mts`:

```ts
// What the router reads from a Codex request to its model backend (the
// Responses API under /backend-api/codex). Captured from the bundled codex by
// scripts/capture-codex-wire.mjs; test/fixtures/codex-wire-<version>.json is
// the evidence. Every reader tolerates junk and returns null rather than
// throwing: a request the router cannot place is relayed, never dropped.

export type HeaderBag = Record<string, string | string[] | undefined>

export interface TurnMetadata {
  threadId: string | null
  turnId: string | null
  sessionId: string | null
  agentName: string | null
  requestKind: string | null
  sandboxMode: string | null
  model: string | null
}

export function headerValue(headers: HeaderBag, name: string): string | null {
  const raw = headers[name.toLowerCase()]
  const value = Array.isArray(raw) ? raw[0] : raw
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return record(raw)
  try {
    return record(JSON.parse(raw))
  } catch {
    return {}
  }
}

// The x-codex-turn-metadata header (a JSON string), else the copy codex puts
// in the body's client_metadata.
export function turnMetadata(
  headers: HeaderBag,
  body: Record<string, unknown> | null,
): TurnMetadata {
  const client = record(body?.client_metadata)
  const fromHeader = parseMetadata(headerValue(headers, 'x-codex-turn-metadata'))
  const meta = Object.keys(fromHeader).length > 0 ? fromHeader : parseMetadata(client['x-codex-turn-metadata'])
  return {
    threadId: text(meta.thread_id),
    turnId: text(meta.turn_id),
    sessionId: text(meta.session_id),
    agentName: text(meta.agent_name),
    requestKind: text(meta.request_kind),
    sandboxMode: text(meta.sandbox_mode),
    model: text(meta.model),
  }
}

export function threadIdOfRequest(
  headers: HeaderBag,
  body: Record<string, unknown> | null,
): string | null {
  const client = record(body?.client_metadata)
  return (
    headerValue(headers, 'thread-id') ??
    turnMetadata(headers, body).threadId ??
    text(client.thread_id) ??
    headerValue(headers, 'session-id') ??
    text(body?.prompt_cache_key)
  )
}

export function turnIdOfRequest(
  headers: HeaderBag,
  body: Record<string, unknown> | null,
): string | null {
  const client = record(body?.client_metadata)
  return turnMetadata(headers, body).turnId ?? text(client.turn_id) ?? headerValue(headers, 'turn-id')
}

export function parentThreadIdOfRequest(headers: HeaderBag): string | null {
  return headerValue(headers, 'x-codex-parent-thread-id')
}

// A prewarm opens the socket before the turn; `generate: false` frames ask
// for no output.
export function isPrewarm(headers: HeaderBag, body: Record<string, unknown> | null): boolean {
  if (body?.generate === false) return true
  return turnMetadata(headers, body).requestKind === 'prewarm'
}

// The model a WebSocket upgrade is for: the routing hint older clients send,
// else the turn metadata's model (0.159 sends no routing hint).
export function modelHint(headers: HeaderBag): string | null {
  const hint = headerValue(headers, 'x-codex-routing-hint')
  const match = hint ? /(?:^|;)\s*model=([\w.[\]-]+)/.exec(hint) : null
  return match?.[1] ?? turnMetadata(headers, null).model
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/codex-wire.test.mjs`
Expected: PASS, `ℹ pass 4`, `ℹ fail 0`.

- [ ] **Step 7: Docs, gates, commit**

In `scripts/AGENTS.md` add under `## Map`:

```markdown
- `capture-codex-wire.mjs`: zero-spend capture of what a bundled codex sends
  to its model backend (isolated CODEX_HOME, fake API key, loopback fake
  backend, `model_catalog_json`); writes `test/fixtures/codex-wire-<version>.json`
  and exits 1 when a field the router reads is missing. The update gate runs it
  against every new app version.
```

In `src/AGENTS.md` add under `## Map`: "- `codex-wire.mts` — what the router reads from a Codex model request (thread, turn and parent ids, request kind, model); pinned to `test/fixtures/codex-wire-<version>.json`."

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/codex-wire.mts scripts/capture-codex-wire.mjs test/fixtures/codex-wire-0.159.0.json \
  test/codex-wire.test.mts scripts/AGENTS.md src/AGENTS.md
git commit -m "feat: add the Codex wire contract and a zero-spend capture of it"
```

**Acceptance:** the fixture is committed, the capture exits 0 against the installed app's codex without touching `~/.codex`, and the contract tests pass.

---
### Task 7: AnyEngine settings and paths

Spec 5.7: "State lives in `~/.anyengine/config.json` (JSON). `runtime.env` remains only for shim bootstrap paths." The router, the adapter and the control CLI all read the same file; this task gives them one reader, one validated writer and one map of where everything lives.

**Files:**
- Create: `src/anyengine-config.mts`
- Create: `test/anyengine-config.test.mts`
- Modify: `docs/guide/configuration.md` (new section `## AnyEngine settings (config.json)`, `ANYENGINE_ROOT` in the reference table)

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export type CodexClaudeMode = 'agent' | 'model'
export interface ClaudeModelEntry { id: string; displayName: string; claudeModel: string; contextWindow: number }
export interface AnyEngineConfig {
  version: 1
  router: { enabled: boolean; port: number; upstream: string; multiAgentV1: boolean }
  modes: { codexClaude: CodexClaudeMode }
  claude: { models: ClaudeModelEntry[]; spawnPriority: string[]; cli: string | null }
  smoke: { enabled: boolean; hour: number; minute: number; claudeModel: string; gptModel: string | null }
  claims: { idleReleaseMinutes: number; graceMs: number; unclaimedFlipThreshold: number }
}
export interface EnginePaths {
  root: string; config: string; state: string; run: string; logs: string; router: string
  smoke: string; bin: string; lib: string; layers: string; routerStatus: string
  smokeResult: string; knownGood: string; driftMarker: string; updateWatch: string
}
export const DEFAULT_CONFIG: AnyEngineConfig
export const CONFIG_KEYS: readonly string[]
export function anyengineRoot(env?: NodeJS.ProcessEnv): string
export function enginePaths(root?: string): EnginePaths
export function readConfig(root?: string): { config: AnyEngineConfig; errors: string[] }
export function loadConfig(root?: string): AnyEngineConfig          // cached by file mtime
export function getConfigValue(config: AnyEngineConfig, key: string): unknown
export function setConfigValue(root: string, key: string, raw: string): AnyEngineConfig
export function routerBaseUrl(config: AnyEngineConfig): string   // http://127.0.0.1:<port>/backend-api/codex
export function routerHealthUrl(config: AnyEngineConfig): string // http://127.0.0.1:<port>/health
export function writeJsonAtomic(path: string, value: unknown): void
```

- [ ] **Step 1: Write the failing tests**

Create `test/anyengine-config.test.mts`:

```ts
import assert from 'node:assert/strict'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import {
  anyengineRoot,
  DEFAULT_CONFIG,
  enginePaths,
  getConfigValue,
  loadConfig,
  readConfig,
  routerBaseUrl,
  setConfigValue,
} from '../src/anyengine-config.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

test('config: a missing file reads as the defaults, agent mode, port 18790', async () => {
  const root = await tempDir('anyengine-config-')
  const { config, errors } = readConfig(root)
  assert.deepEqual(config, DEFAULT_CONFIG)
  assert.deepEqual(errors, [])
  assert.equal(config.modes.codexClaude, 'agent')
  assert.equal(routerBaseUrl(config), 'http://127.0.0.1:18790/backend-api/codex')
  assert.deepEqual(
    config.claude.models.map((m) => m.id),
    ['opus', 'sonnet', 'haiku'],
  )
})

test('config: a bad value falls back to its default and is reported, never thrown', async () => {
  const root = await tempDir('anyengine-config-')
  writeFileSync(
    enginePaths(root).config,
    JSON.stringify({ router: { port: 'x', multiAgentV1: false }, modes: { codexClaude: 'weird' } }),
  )
  const { config, errors } = readConfig(root)
  assert.equal(config.router.port, 18790)
  assert.equal(config.router.multiAgentV1, false)
  assert.equal(config.modes.codexClaude, 'agent')
  assert.equal(errors.length, 2)
  writeFileSync(enginePaths(root).config, '{not json')
  assert.match(readConfig(root).errors[0] ?? '', /not valid JSON/)
})

test('config: set validates, writes atomically with mode 0600, and get reads it back', async () => {
  const root = await tempDir('anyengine-config-')
  const next = setConfigValue(root, 'modes.codexClaude', 'model')
  assert.equal(getConfigValue(next, 'modes.codexClaude'), 'model')
  assert.equal(statSync(enginePaths(root).config).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(enginePaths(root).config, 'utf8')).modes.codexClaude, 'model')
  assert.throws(() => setConfigValue(root, 'modes.codexClaude', 'both'), /agent or model/)
  assert.throws(() => setConfigValue(root, 'router.port', '80'), /1024/)
  assert.throws(() => setConfigValue(root, 'nope.key', '1'), /unknown setting/)
  assert.throws(
    () => setConfigValue(root, 'claude.spawnPriority', '["gpt-6-sol"]'),
    /not a configured Claude model/,
  )
  setConfigValue(root, 'router.multiAgentV1', 'false')
  assert.equal(loadConfig(root).router.multiAgentV1, false)
})

test('config: ANYENGINE_ROOT moves every path', () => {
  assert.equal(anyengineRoot({ ANYENGINE_ROOT: '/x/y' }), '/x/y')
  const paths = enginePaths('/x/y')
  assert.equal(paths.run, join('/x/y', 'run'))
  assert.equal(paths.layers, join('/x/y', 'state', 'layers.json'))
  assert.equal(paths.driftMarker, join('/x/y', 'state', 'drift-failed'))
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/anyengine-config.mjs'`.

- [ ] **Step 3: Implement**

Create `src/anyengine-config.mts`:

```ts
// AnyEngine's own settings and state (spec 5.7). ~/.anyengine/config.json
// holds what the operator chooses (router port, Claude mode in the Codex
// surface, the Claude models the router advertises); state/ holds what the
// router, the smoke and the control CLI record; run/ holds the adapters'
// claim sockets. ANYENGINE_ROOT moves all of it (tests, probes).
//
// Reading never throws: a bad value falls back to its default and is listed
// in `errors`, which `anyengine status` and `doctor` print. Writing validates
// and throws with a message a person can act on.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type CodexClaudeMode = 'agent' | 'model'

export interface ClaudeModelEntry {
  id: string
  displayName: string
  claudeModel: string
  contextWindow: number
}

export interface AnyEngineConfig {
  version: 1
  router: { enabled: boolean; port: number; upstream: string; multiAgentV1: boolean }
  modes: { codexClaude: CodexClaudeMode }
  claude: { models: ClaudeModelEntry[]; spawnPriority: string[]; cli: string | null }
  smoke: { enabled: boolean; hour: number; minute: number; claudeModel: string; gptModel: string | null }
  claims: { idleReleaseMinutes: number; graceMs: number; unclaimedFlipThreshold: number }
}

export interface EnginePaths {
  root: string
  config: string
  state: string
  run: string
  logs: string
  router: string
  smoke: string
  bin: string
  lib: string
  layers: string
  routerStatus: string
  smokeResult: string
  knownGood: string
  driftMarker: string
  updateWatch: string
}

// Ids match the adapter's own Claude ids (util.mts claudeModelOptions), so
// the picker shows one entry per model and a leaked catalog entry resolves to
// the adapter's Claude.
export const DEFAULT_CONFIG: AnyEngineConfig = {
  version: 1,
  router: {
    enabled: true,
    port: 18790,
    upstream: 'https://chatgpt.com/backend-api/codex',
    multiAgentV1: true,
  },
  modes: { codexClaude: 'agent' },
  claude: {
    models: [
      { id: 'opus', displayName: 'Claude Opus', claudeModel: 'opus', contextWindow: 200000 },
      { id: 'sonnet', displayName: 'Claude Sonnet', claudeModel: 'sonnet', contextWindow: 200000 },
      { id: 'haiku', displayName: 'Claude Haiku', claudeModel: 'haiku', contextWindow: 200000 },
    ],
    spawnPriority: ['opus', 'sonnet', 'haiku'],
    cli: null,
  },
  smoke: { enabled: true, hour: 3, minute: 30, claudeModel: 'haiku', gptModel: null },
  claims: { idleReleaseMinutes: 10, graceMs: 3000, unclaimedFlipThreshold: 3 },
}

export function anyengineRoot(env: NodeJS.ProcessEnv = process.env): string {
  const named = (env.ANYENGINE_ROOT ?? '').trim()
  return named || join(homedir(), '.anyengine')
}

export function enginePaths(root: string = anyengineRoot()): EnginePaths {
  const state = join(root, 'state')
  return {
    root,
    config: join(root, 'config.json'),
    state,
    run: join(root, 'run'),
    logs: join(root, 'logs'),
    router: join(root, 'router'),
    smoke: join(root, 'smoke'),
    bin: join(root, 'bin'),
    lib: join(root, 'lib'),
    layers: join(state, 'layers.json'),
    routerStatus: join(state, 'router-status.json'),
    smokeResult: join(state, 'smoke.json'),
    knownGood: join(state, 'known-good.json'),
    driftMarker: join(state, 'drift-failed'),
    updateWatch: join(state, 'update-watch.json'),
  }
}

type Parser = (value: unknown, config: AnyEngineConfig) => unknown

const bool: Parser = (value) => {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw new Error('needs true or false')
}
const intIn =
  (min: number, max: number): Parser =>
  (value) => {
    const n = typeof value === 'string' ? Number(value) : value
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)
      throw new Error(`needs a whole number from ${min} to ${max}`)
    return n
  }
const upstreamUrl: Parser = (value) => {
  const url = new URL(String(value))
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('needs an https URL (or http on loopback, for tests)')
  return url.toString().replace(/\/+$/, '')
}
const mode: Parser = (value) => {
  if (value === 'agent' || value === 'model') return value
  throw new Error('needs agent or model')
}
const models: Parser = (value) => {
  const list = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(list) || list.length === 0) throw new Error('needs a non-empty JSON array')
  return list.map((entry) => {
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string' || !/^[a-z][\w.-]*$/.test(e.id))
      throw new Error('every model needs an id')
    return {
      id: e.id,
      displayName: typeof e.displayName === 'string' ? e.displayName : e.id,
      claudeModel: typeof e.claudeModel === 'string' ? e.claudeModel : e.id,
      contextWindow: intIn(8000, 2_000_000)(e.contextWindow ?? 200000, DEFAULT_CONFIG) as number,
    }
  })
}
const modelIdList: Parser = (value, config) => {
  const list = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(list)) throw new Error('needs a JSON array of model ids')
  const known = new Set(config.claude.models.map((m) => m.id))
  for (const id of list) {
    if (typeof id !== 'string' || !known.has(id)) throw new Error(`${id} is not a configured Claude model`)
  }
  return list
}
const modelId: Parser = (value, config) => {
  if (typeof value === 'string' && config.claude.models.some((m) => m.id === value)) return value
  throw new Error(`${String(value)} is not a configured Claude model`)
}
const modelOrNull: Parser = (value) => {
  if (value === null || value === 'null' || value === '') return null
  if (typeof value === 'string' && /^[\w.[\]-]+$/.test(value)) return value
  throw new Error('needs a model id or null')
}
const pathOrNull: Parser = (value) => {
  if (value === null || value === 'null' || value === '') return null
  if (typeof value === 'string' && value.startsWith('/')) return value
  throw new Error('needs an absolute path or null')
}

const PARSERS: Record<string, Parser> = {
  'router.enabled': bool,
  'router.port': intIn(1024, 65535),
  'router.upstream': upstreamUrl,
  'router.multiAgentV1': bool,
  'modes.codexClaude': mode,
  'claude.models': models,
  'claude.spawnPriority': modelIdList,
  'claude.cli': pathOrNull,
  'smoke.enabled': bool,
  'smoke.hour': intIn(0, 23),
  'smoke.minute': intIn(0, 59),
  'smoke.claudeModel': modelId,
  'smoke.gptModel': modelOrNull,
  'claims.idleReleaseMinutes': intIn(1, 1440),
  'claims.graceMs': intIn(0, 30000),
  'claims.unclaimedFlipThreshold': intIn(1, 100),
}
export const CONFIG_KEYS: readonly string[] = Object.keys(PARSERS)

export function getConfigValue(config: AnyEngineConfig, key: string): unknown {
  let at: unknown = config
  for (const part of key.split('.')) {
    if (!at || typeof at !== 'object' || !(part in at)) throw new Error(`unknown setting ${key}`)
    at = (at as Record<string, unknown>)[part]
  }
  return at
}

function assign(config: AnyEngineConfig, key: string, value: unknown): void {
  const [section, field] = key.split('.') as [keyof AnyEngineConfig, string]
  const target = config[section] as unknown as Record<string, unknown>
  target[field] = value
}

// Section by section, field by field: one bad value costs only itself. The
// models list goes first so spawnPriority and smoke.claudeModel are checked
// against the models this file names.
function merge(raw: Record<string, unknown>, errors: string[]): AnyEngineConfig {
  const config = structuredClone(DEFAULT_CONFIG)
  const ordered = ['claude.models', ...CONFIG_KEYS.filter((key) => key !== 'claude.models')]
  for (const key of ordered) {
    const [section, field] = key.split('.') as [string, string]
    const block = raw[section]
    if (!block || typeof block !== 'object' || !(field in block)) continue
    try {
      assign(config, key, PARSERS[key]?.((block as Record<string, unknown>)[field], config))
    } catch (error) {
      errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return config
}

export function readConfig(root: string = anyengineRoot()): {
  config: AnyEngineConfig
  errors: string[]
} {
  let text: string
  try {
    text = readFileSync(enginePaths(root).config, 'utf8')
  } catch {
    return { config: structuredClone(DEFAULT_CONFIG), errors: [] }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { config: structuredClone(DEFAULT_CONFIG), errors: ['config.json is not valid JSON'] }
  }
  const errors: string[] = []
  const config = merge(raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}, errors)
  return { config, errors }
}

const cache = new Map<string, { mtimeMs: number; config: AnyEngineConfig }>()

// For hot paths (every routed request): re-read only when the file changed.
export function loadConfig(root: string = anyengineRoot()): AnyEngineConfig {
  let mtimeMs = -1
  try {
    mtimeMs = statSync(enginePaths(root).config).mtimeMs
  } catch {}
  const hit = cache.get(root)
  if (hit && hit.mtimeMs === mtimeMs) return hit.config
  const { config } = readConfig(root)
  cache.set(root, { mtimeMs, config })
  return config
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

export function setConfigValue(root: string, key: string, raw: string): AnyEngineConfig {
  const parse = PARSERS[key]
  if (!parse) throw new Error(`unknown setting ${key}; known: ${CONFIG_KEYS.join(', ')}`)
  const { config } = readConfig(root)
  assign(config, key, parse(raw, config))
  writeJsonAtomic(enginePaths(root).config, config)
  cache.delete(root)
  return config
}

export function routerBaseUrl(config: AnyEngineConfig): string {
  return `http://127.0.0.1:${config.router.port}/backend-api/codex`
}

export function routerHealthUrl(config: AnyEngineConfig): string {
  return `http://127.0.0.1:${config.router.port}/health`
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/anyengine-config.test.mjs`
Expected: PASS, `ℹ pass 4`, `ℹ fail 0`.

- [ ] **Step 5: Docs, gates, commit**

In `docs/guide/configuration.md`, add before `## Reference table`:

````markdown
## AnyEngine settings (config.json)

`~/.anyengine/config.json` holds the settings `anyengine config get|set`
and `anyengine mode` change. A missing file means the defaults; a bad value
falls back to its default and `anyengine status` lists it.

| Key | Default | Meaning |
|---|---|---|
| `router.enabled` | `true` | Attach the router to the adapter's codex child. |
| `router.port` | `18790` | Loopback port of the router. |
| `router.upstream` | `https://chatgpt.com/backend-api/codex` | Where GPT traffic goes. |
| `router.multiAgentV1` | `true` | Mark the catalog v1 so native `spawn_agent` can start Claude children; `false` uses the bridge. |
| `modes.codexClaude` | `agent` | Claude in the Codex surface: `agent` (Claude Code PTY) or `model` (`claude -p` trampoline). |
| `claude.models` | opus, sonnet, haiku | Claude entries the router adds to the catalog. |
| `claude.spawnPriority` | `["opus","sonnet","haiku"]` | Order in which they rank just after the default GPT model. |
| `claude.cli` | `null` | Absolute path of `claude` for the router; `null` resolves it at `anyengine on`. |
| `smoke.enabled`, `smoke.hour`, `smoke.minute`, `smoke.claudeModel` | `true`, 3, 30, `haiku` | Nightly live smoke. |
| `smoke.gptModel` | `null` | GPT model for the smoke's PONG turns; `null` takes the lowest-ranked listed GPT model. |
| `claims.idleReleaseMinutes`, `claims.graceMs` | 10, 3000 | Claimed Claude children: when an idle one's PTY is released, how long a claim waits for its thread. |
| `claims.unclaimedFlipThreshold` | 3 | Consecutive Claude turns no adapter claimed before the router moves to the bridge path. |
````

and add to the reference table: `| \`ANYENGINE_ROOT\` | AnyEngine's own directory (default \`~/.anyengine\`): settings, state, claim sockets, logs, installed libs. |`

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK (`Env-docs gate OK: 89 ANYENGINE_* settings, all documented.`), `ℹ fail 0`.

```bash
git add src/anyengine-config.mts test/anyengine-config.test.mts docs/guide/configuration.md
git commit -m "feat: add AnyEngine's config.json with validated get and set"
```

**Acceptance:** tests pass; `readConfig` never throws on a bad file; `setConfigValue` rejects unknown keys and bad values with a message.

---
### Task 8: Router core: loopback server, health, bounded log, GPT HTTP passthrough, daemon

Spec 5.2: "A single process, supervised by launchd with KeepAlive, listening on a fixed loopback port", and "GPT `/responses` (HTTP and WebSocket): relayed unchanged to chatgpt.com with the caller's headers. The router never stores or refreshes these tokens." This task builds the process and its HTTP half; `/models` (Task 9), WebSockets (Task 11) and Claude (Tasks 15 to 17) plug into it.

**Files:**
- Create: `src/router-log.mts`, `src/router-server.mts`, `src/router-hooks.mts`
- Create: `test/helpers/fake-backend.mts`, `test/router-core.test.mts`
- Modify: `src/adapter.mts` (the `router` subcommand)
- Create: `docs/guide/router.md`; modify `docs/.vitepress/config.*` sidebar if it lists guide pages (add "Router"), `src/AGENTS.md`

**Interfaces:**
- Consumes: `anyengine-config.mts` (`loadConfig`, `enginePaths`, `anyengineRoot`), `codex-wire.mts` (`threadIdOfRequest`).
- Produces:

```ts
// src/router-log.mts
export interface RouterLog { readonly path: string; info(event: string, data?: Record<string, unknown>): void; error(event: string, data?: Record<string, unknown>): void }
export function createRouterLog(path: string, options?: { maxBytes?: number; keep?: number }): RouterLog
export function scrubForLog(value: unknown): unknown   // credential-looking keys and strings redacted

// src/router-server.mts
export const CODEX_BASE_PATH = '/backend-api/codex'
export interface UpstreamHealth { lastOkAt: string | null; lastError: string | null; lastErrorAt: string | null }
export interface RouterContext {
  root: string
  config: () => AnyEngineConfig
  upstream: () => string
  log: RouterLog
  inflight: { gpt: number; claude: number }
  health: UpstreamHealth
  startedAt: string
}
export interface RouterHooks {
  // Task 9: GET /models. Task 11: WebSocket upgrades. Tasks 15 and 17: Claude turns.
  models?: (ctx: RouterContext, req: IncomingMessage, res: ServerResponse, query: string) => Promise<void>
  upgrade?: (ctx: RouterContext, req: IncomingMessage, socket: Duplex, head: Buffer) => void
  claudeHttp?: (ctx: RouterContext, req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => Promise<boolean>
  status?: (ctx: RouterContext) => Record<string, unknown>
  observeGptBody?: (body: Record<string, unknown>) => void
  observeUpstreamError?: (status: number, text: string) => void
}
export interface RouterOptions { root: string; port: number; host?: string; upstream?: string; log?: RouterLog; hooks?: RouterHooks }
export interface RunningRouter { port: number; baseUrl: string; healthUrl: string; context: RouterContext; close(drainMs?: number): Promise<void> }
export function localOnly(req: IncomingMessage): string | null
export function forwardHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders
export function decodeBody(raw: Buffer, encoding: string | undefined): Buffer
export function readJsonBody(raw: Buffer, encoding: string | undefined): Record<string, unknown> | null
export function passthrough(ctx: RouterContext, req: IncomingMessage, res: ServerResponse, subpath: string, query: string, body: Buffer | null, hooks?: RouterHooks): void
export function routerVersion(): string
export function trimInPlace(path: string, max: number): void
// src/router-hooks.mts: the one place the daemon's features are wired
export function buildRouterHooks(root: string, log: RouterLog): RouterHooks
export async function startRouter(options: RouterOptions): Promise<RunningRouter>
export async function runRouterDaemon(env?: NodeJS.ProcessEnv): Promise<void>   // `adapter.mjs router`
```

- `test/helpers/fake-backend.mts`:

```ts
export interface RecordedRequest { method: string; path: string; query: string; headers: IncomingHttpHeaders; raw: Buffer }
export interface FakeBackend {
  port: number
  url: string                         // http://127.0.0.1:<port>/backend-api/codex
  requests: RecordedRequest[]
  upgrades: { path: string; headers: IncomingHttpHeaders }[]
  frames: string[]                    // client frames received over WebSocket
  models: unknown[]                   // served by GET /models
  etag: string
  respond: ((req: RecordedRequest, res: ServerResponse) => void) | null   // override POST /responses
  failModels: number | null           // status for GET /models, null = 200
  close(): Promise<void>
}
export async function startFakeBackend(): Promise<FakeBackend>
export function ssePong(res: ServerResponse, model: string, text?: string): void
export function gptEntry(slug: string, priority: number, extra?: Record<string, unknown>): Record<string, unknown>
```

- [ ] **Step 1: Write the fake backend helper**

Create `test/helpers/fake-backend.mts`:

```ts
import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'

// A stand-in for chatgpt.com/backend-api/codex: GET /models, POST /responses
// (SSE) and a WebSocket on /responses that answers every response.create
// frame with a PONG. Records everything it received, raw.

export interface RecordedRequest {
  method: string
  path: string
  query: string
  headers: IncomingHttpHeaders
  raw: Buffer
}

export interface FakeBackend {
  port: number
  url: string
  requests: RecordedRequest[]
  upgrades: { path: string; headers: IncomingHttpHeaders }[]
  frames: string[]
  models: unknown[]
  etag: string
  respond: ((req: RecordedRequest, res: ServerResponse) => void) | null
  failModels: number | null
  close(): Promise<void>
}

export function gptEntry(
  slug: string,
  priority: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: `${slug} upstream`,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'medium', description: 'm' }],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    context_window: 272000,
    multi_agent_version: 'v2',
    ...extra,
  }
}

export function ssePong(res: ServerResponse, model: string, text = 'PONG'): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const item = {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  const response = { id: 'resp_fake', object: 'response', status: 'completed', model, output: [item] }
  let seq = 0
  const send = (type: string, payload: Record<string, unknown>) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`)
  send('response.created', { response: { ...response, status: 'in_progress', output: [] } })
  send('response.output_item.done', { output_index: 0, item })
  send('response.completed', { response })
  res.end()
}

export async function startFakeBackend(): Promise<FakeBackend> {
  const state: Omit<FakeBackend, 'port' | 'url' | 'close'> = {
    requests: [],
    upgrades: [],
    frames: [],
    models: [gptEntry('gpt-6-astra', 2), gptEntry('gpt-6-sol', 5), gptEntry('gpt-6-luna', 9)],
    etag: '"upstream-1"',
    respond: null,
    failModels: null,
  }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x')
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.search,
        headers: req.headers,
        raw: Buffer.concat(chunks),
      }
      state.requests.push(recorded)
      if (url.pathname.endsWith('/models')) {
        if (state.failModels) {
          res.writeHead(state.failModels)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', etag: state.etag })
        res.end(JSON.stringify({ models: state.models }))
        return
      }
      if (req.method === 'POST' && url.pathname.endsWith('/responses')) {
        if (state.respond) return state.respond(recorded, res)
        let model = 'unknown'
        try {
          model = JSON.parse(recorded.raw.toString('utf8')).model ?? model
        } catch {}
        ssePong(res, model)
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x')
    state.upgrades.push({ path: url.pathname, headers: req.headers })
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, isBinary) => {
        const text = isBinary ? '' : data.toString()
        state.frames.push(text)
        let model = 'unknown'
        try {
          model = JSON.parse(text).model ?? model
        } catch {}
        for (const type of ['response.created', 'response.output_item.done', 'response.completed']) {
          ws.send(JSON.stringify({ type, response: { id: 'resp_ws', model, status: 'completed' } }))
        }
      })
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const fake = Object.assign(state, {
    port,
    url: `http://127.0.0.1:${port}/backend-api/codex`,
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((ok) => server.close(() => ok()))
    },
  })
  return fake
}
```

- [ ] **Step 2: Write the failing router tests**

Create `test/router-core.test.mts`:

```ts
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { createRouterLog } from '../src/router-log.mjs'
import { startRouter, trimInPlace } from '../src/router-server.mjs'
import { type FakeBackend, startFakeBackend } from './helpers/fake-backend.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const closers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await removeTempDirs()
})

async function setup(): Promise<{ backend: FakeBackend; base: string; health: string; root: string }> {
  const root = await tempDir('anyengine-router-')
  const backend = await startFakeBackend()
  closers.push(() => backend.close())
  const router = await startRouter({ root, port: 0, upstream: backend.url })
  closers.push(() => router.close(0))
  return { backend, base: router.baseUrl, health: router.healthUrl, root }
}

function post(url: string, body: Buffer, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const SECRET = `Bearer ${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"sub":"fixture"}').toString('base64url')}.test-signature`

test('router: a GPT request is relayed byte for byte, headers and all', async () => {
  const { backend, base } = await setup()
  const body = Buffer.from('{"model":"gpt-6-sol","input":[],  "stream":true}')
  const res = await post(`${base}/responses`, body, {
    'content-type': 'application/json',
    authorization: SECRET,
    'chatgpt-account-id': 'acct-1',
    'thread-id': 't1',
  })
  assert.equal(res.status, 200)
  assert.match(res.text, /response\.completed/)
  const seen = backend.requests.find((r) => r.path.endsWith('/responses'))
  assert.ok(seen)
  assert.deepEqual(seen.raw, body)
  assert.equal(seen.headers.authorization, SECRET)
  assert.equal(seen.headers['chatgpt-account-id'], 'acct-1')
  assert.equal(seen.headers['thread-id'], 't1')
})

test('router: no credential reaches the router log', async () => {
  const { base, root } = await setup()
  await post(`${base}/responses`, Buffer.from('{"model":"gpt-6-sol","input":[]}'), {
    'content-type': 'application/json',
    authorization: SECRET,
    'chatgpt-account-id': 'acct-secret-42',
  })
  const logs = join(root, 'logs')
  const text = existsSync(logs)
    ? readdirSync(logs).map((f) => readFileSync(join(logs, f), 'utf8')).join('\n')
    : ''
  assert.ok(!text.includes('eyJhbGci'), 'bearer in log')
  assert.ok(!text.includes('acct-secret-42'), 'account id in log')
})

test('router: browser origins, foreign hosts and non-loopback peers are refused', async () => {
  const { base } = await setup()
  const origin = await post(`${base}/responses`, Buffer.from('{}'), { origin: 'https://evil.example' })
  assert.equal(origin.status, 403)
  const host = await post(`${base}/responses`, Buffer.from('{}'), { host: 'evil.example' })
  assert.equal(host.status, 403)
})

test('router: an unreachable upstream is a 502 with a reason, and health records it', async () => {
  const root = await tempDir('anyengine-router-')
  const router = await startRouter({ root, port: 0, upstream: 'http://127.0.0.1:9/backend-api/codex' })
  closers.push(() => router.close(0))
  const res = await post(`${router.baseUrl}/responses`, Buffer.from('{"model":"gpt-6-sol"}'), {
    'content-type': 'application/json',
  })
  assert.equal(res.status, 502)
  assert.match(res.text, /could not reach upstream/)
  const health = (await (await fetch(router.healthUrl)).json()) as {
    ok: boolean
    upstream: { lastError: string | null }
  }
  assert.equal(health.ok, true)
  assert.match(String(health.upstream.lastError), /ECONNREFUSED/)
})

test('router: health names the process and its version', async () => {
  const { health } = await setup()
  const body = (await (await fetch(health)).json()) as Record<string, unknown>
  assert.equal(body.ok, true)
  assert.equal(body.pid, process.pid)
  assert.match(String(body.version), /^\d+\.\d+\.\d+/)
})

test('router: the launchd log is trimmed in place to its bound', async () => {
  const dir = await tempDir('anyengine-router-trim-')
  const path = join(dir, 'router.launchd.log')
  writeFileSync(path, `${'x'.repeat(5000)}END`)
  const before = statSync(path).ino
  trimInPlace(path, 1000)
  assert.equal(statSync(path).size, 1000)
  assert.equal(statSync(path).ino, before, 'same inode')
  assert.ok(readFileSync(path, 'utf8').endsWith('END'))
})

test('router log: rotates at its bound and keeps at most `keep` old files', async () => {
  const dir = await tempDir('anyengine-router-log-')
  const log = createRouterLog(join(dir, 'router.jsonl'), { maxBytes: 2000, keep: 2 })
  for (let i = 0; i < 200; i += 1) log.info('tick', { i, pad: 'x'.repeat(50) })
  const files = readdirSync(dir).sort()
  assert.deepEqual(files, ['router.jsonl', 'router.jsonl.1', 'router.jsonl.2'])
  log.info('auth', { authorization: SECRET, note: `sent ${SECRET}` })
  const last = readFileSync(join(dir, 'router.jsonl'), 'utf8')
  assert.ok(!last.includes('eyJhbGci'))
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/router-log.mjs'`.

- [ ] **Step 4: Write the log**

Create `src/router-log.mts`:

```ts
// The router's own log: one JSON object per line, rotated at a size bound
// (default 5 MB, three old files), with anything that could be a credential
// replaced before it is written. The router relays bearers; it never logs
// them (spec 5.2, spec 8 "header relay (tokens never logged)").
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export interface RouterLog {
  readonly path: string
  info(event: string, data?: Record<string, unknown>): void
  error(event: string, data?: Record<string, unknown>): void
}

const SECRET_KEY = /authorization|cookie|token|secret|password|api.?key|account.?id|bearer/i
const SECRET_TEXT = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
]

export function scrubForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (typeof value === 'string') {
    let text = value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value
    for (const pattern of SECRET_TEXT) text = text.replace(pattern, '[redacted]')
    return text
  }
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubForLog(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : scrubForLog(entry, depth + 1)
  }
  return out
}

function rotate(path: string, maxBytes: number, keep: number): void {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return
  }
  if (size < maxBytes) return
  rmSync(`${path}.${keep}`, { force: true })
  for (let index = keep - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${path}.${index}`, `${path}.${index + 1}`)
    } catch {}
  }
  renameSync(path, `${path}.1`)
}

export function createRouterLog(
  path: string,
  options: { maxBytes?: number; keep?: number } = {},
): RouterLog {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024
  const keep = Math.max(1, options.keep ?? 3)
  const write = (level: string, event: string, data: Record<string, unknown>) => {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      rotate(path, maxBytes, keep)
      const line = { ts: new Date().toISOString(), pid: process.pid, level, event, ...(scrubForLog(data) as object) }
      appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 })
    } catch {}
  }
  return {
    path,
    info: (event, data = {}) => write('info', event, data),
    error: (event, data = {}) => write('error', event, data),
  }
}
```

- [ ] **Step 5: Write the server**

Create `src/router-server.mts`:

```ts
// The AnyEngine router (spec 5.2), Codex face. One process on a fixed
// loopback port. Everything under /backend-api/codex that is not a model
// catalog or a Claude turn is relayed to the upstream (chatgpt.com) with the
// caller's own headers, byte for byte: the body is buffered only to read the
// model and forwarded as received, encoding and all. The router never reads
// ~/.codex/auth.json, never refreshes a token and never logs a credential.
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
} from 'node:fs'
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http'
import https from 'node:https'
import type { Duplex } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { type AnyEngineConfig, anyengineRoot, enginePaths, loadConfig } from './anyengine-config.mjs'
import { createRouterLog, type RouterLog } from './router-log.mjs'

export const CODEX_BASE_PATH = '/backend-api/codex'

export interface UpstreamHealth {
  lastOkAt: string | null
  lastError: string | null
  lastErrorAt: string | null
}

export interface RouterContext {
  root: string
  config: () => AnyEngineConfig
  upstream: () => string
  log: RouterLog
  inflight: { gpt: number; claude: number }
  health: UpstreamHealth
  startedAt: string
}

export interface RouterHooks {
  models?: (ctx: RouterContext, req: IncomingMessage, res: ServerResponse, query: string) => Promise<void>
  upgrade?: (ctx: RouterContext, req: IncomingMessage, socket: Duplex, head: Buffer) => void
  claudeHttp?: (
    ctx: RouterContext,
    req: IncomingMessage,
    res: ServerResponse,
    body: Record<string, unknown>,
  ) => Promise<boolean>
  status?: (ctx: RouterContext) => Record<string, unknown>
  observeGptBody?: (body: Record<string, unknown>) => void
  observeUpstreamError?: (status: number, text: string) => void
}

export interface RouterOptions {
  root: string
  port: number
  host?: string
  upstream?: string
  log?: RouterLog
  hooks?: RouterHooks
}

export interface RunningRouter {
  port: number
  baseUrl: string
  healthUrl: string
  context: RouterContext
  close(drainMs?: number): Promise<void>
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
])

export function localOnly(req: IncomingMessage): string | null {
  const address = req.socket.remoteAddress ?? ''
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return 'not loopback'
  if (req.headers.origin) return 'browser origin'
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return 'bad host'
  return null
}

export function forwardHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}

export function decodeBody(raw: Buffer, encoding: string | undefined): Buffer {
  const enc = (encoding ?? '').toLowerCase().trim()
  if (!enc || enc === 'identity') return raw
  if (enc === 'zstd') return zlib.zstdDecompressSync(raw)
  if (enc === 'gzip') return zlib.gunzipSync(raw)
  if (enc === 'br') return zlib.brotliDecompressSync(raw)
  if (enc === 'deflate') return zlib.inflateSync(raw)
  throw new Error(`unsupported content-encoding ${enc}`)
}

export function readJsonBody(raw: Buffer, encoding: string | undefined): Record<string, unknown> | null {
  if (raw.length === 0) return null
  try {
    const parsed = JSON.parse(decodeBody(raw, encoding).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => ok(Buffer.concat(chunks)))
    req.on('error', fail)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function noteUpstreamError(ctx: RouterContext, message: string): void {
  ctx.health.lastError = message
  ctx.health.lastErrorAt = new Date().toISOString()
}

// Relay one request to the upstream and its answer back, unchanged. `body`
// is the raw request body when it was buffered, else the request is piped.
export function passthrough(
  ctx: RouterContext,
  req: IncomingMessage,
  res: ServerResponse,
  subpath: string,
  query: string,
  body: Buffer | null,
  hooks: RouterHooks = {},
): void {
  const target = new URL(`${ctx.upstream()}${subpath}${query}`)
  const transport = target.protocol === 'https:' ? https : http
  const headers = forwardHeaders(req.headers)
  if (body) headers['content-length'] = String(body.length)
  const upstream = transport.request(target, { method: req.method ?? 'GET', headers }, (answer) => {
    const status = answer.statusCode ?? 502
    if (status < 500) ctx.health.lastOkAt = new Date().toISOString()
    else noteUpstreamError(ctx, `upstream ${subpath} answered ${status}`)
    const out: OutgoingHttpHeaders = {}
    for (const [key, value] of Object.entries(answer.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(key)) out[key] = value
    }
    res.writeHead(status, out)
    if (status >= 400 && hooks.observeUpstreamError) {
      let head = ''
      answer.on('data', (chunk: Buffer) => {
        if (head.length < 4096) head += chunk.toString('utf8')
      })
      answer.on('end', () => hooks.observeUpstreamError?.(status, head))
    }
    answer.pipe(res)
  })
  upstream.on('error', (error: NodeJS.ErrnoException) => {
    const reason = error.code ?? error.message
    noteUpstreamError(ctx, `${subpath}: ${reason}`)
    ctx.log.error('upstream.error', { subpath, reason })
    sendJson(res, 502, { error: { message: `anyengine router could not reach upstream: ${reason}` } })
  })
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy()
  })
  if (body) upstream.end(body)
  else req.pipe(upstream)
}

// The installed lib's manifest version (install-lib.mjs writes it), else the
// package version marked -dev.
export function routerVersion(): string {
  const libRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  try {
    const manifest = join(libRoot, 'install-manifest.json')
    if (existsSync(manifest)) return String(JSON.parse(readFileSync(manifest, 'utf8')).version)
    return `${JSON.parse(readFileSync(join(libRoot, 'package.json'), 'utf8')).version}-dev`
  } catch {
    return '0.0.0-unknown'
  }
}

async function handleCodex(
  ctx: RouterContext,
  hooks: RouterHooks,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const subpath = url.pathname.slice(CODEX_BASE_PATH.length) || '/'
  if (req.method === 'GET' && subpath === '/models' && hooks.models) {
    await hooks.models(ctx, req, res, url.search)
    return
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    passthrough(ctx, req, res, subpath, url.search, null, hooks)
    return
  }
  const raw = await readRaw(req)
  const body = subpath.startsWith('/responses') ? readJsonBody(raw, req.headers['content-encoding']) : null
  if (body && hooks.claudeHttp && (await hooks.claudeHttp(ctx, req, res, body))) return
  if (body) hooks.observeGptBody?.(body)
  ctx.inflight.gpt += 1
  res.once('close', () => {
    ctx.inflight.gpt -= 1
  })
  passthrough(ctx, req, res, subpath, url.search, raw, hooks)
}

export async function startRouter(options: RouterOptions): Promise<RunningRouter> {
  const hooks = options.hooks ?? {}
  const paths = enginePaths(options.root)
  const context: RouterContext = {
    root: options.root,
    config: () => loadConfig(options.root),
    upstream: () => (options.upstream ?? loadConfig(options.root).router.upstream).replace(/\/+$/, ''),
    log: options.log ?? createRouterLog(join(paths.logs, 'router.jsonl')),
    inflight: { gpt: 0, claude: 0 },
    health: { lastOkAt: null, lastError: null, lastErrorAt: null },
    startedAt: new Date().toISOString(),
  }
  const server = http.createServer((req, res) => {
    const denied = localOnly(req)
    if (denied) {
      context.log.info('request.refused', { reason: denied, path: req.url ?? '' })
      sendJson(res, 403, { error: { message: `anyengine router: ${denied}` } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        version: routerVersion(),
        startedAt: context.startedAt,
        upstream: context.health,
        inflight: context.inflight,
        ...(hooks.status?.(context) ?? {}),
      })
      return
    }
    if (!url.pathname.startsWith(CODEX_BASE_PATH)) {
      sendJson(res, 404, { error: { message: 'anyengine router: unknown path' } })
      return
    }
    handleCodex(context, hooks, req, res, url).catch((error: unknown) => {
      context.log.error('request.failed', { message: error instanceof Error ? error.message : String(error) })
      sendJson(res, 500, { error: { message: 'anyengine router: request failed' } })
    })
  })
  server.on('upgrade', (req, socket, head) => {
    const denied = localOnly(req)
    if (denied || !hooks.upgrade) {
      socket.end(`HTTP/1.1 ${denied ? '403 Forbidden' : '404 Not Found'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    hooks.upgrade(context, req, socket, head)
  })
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 65_000
  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(options.port, options.host ?? '127.0.0.1', () => ok())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}${CODEX_BASE_PATH}`,
    healthUrl: `http://127.0.0.1:${port}/health`,
    context,
    close: (drainMs = 10_000) =>
      new Promise<void>((ok) => {
        const force = setTimeout(() => server.closeAllConnections(), drainMs)
        force.unref()
        server.close(() => {
          clearTimeout(force)
          ok()
        })
        if (drainMs === 0) server.closeAllConnections()
      }),
  }
}

// Keep the last `max` bytes of a file that another process holds open.
export function trimInPlace(path: string, max: number): void {
  try {
    const size = statSync(path).size
    if (size <= max) return
    const fd = openSync(path, 'r')
    const tail = Buffer.alloc(max)
    readSync(fd, tail, 0, max, size - max)
    closeSync(fd)
    truncateSync(path, 0)
    appendFileSync(path, tail)
  } catch {}
}

// `adapter.mjs router`: the launchd daemon. A crash exits non-zero so launchd
// (KeepAlive) starts a fresh one; SIGTERM drains for up to 10 s.
export async function runRouterDaemon(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const root = anyengineRoot(env)
  const log = createRouterLog(join(enginePaths(root).logs, 'router.jsonl'))
  process.on('uncaughtException', (error) => {
    log.error('router.crash', { message: error.message, stack: error.stack ?? null })
    process.exit(1)
  })
  const { buildRouterHooks } = await import('./router-hooks.mjs')
  const router = await startRouter({
    root,
    port: loadConfig(root).router.port,
    log,
    hooks: buildRouterHooks(root, log),
  })
  log.info('router.start', { port: router.port, version: routerVersion() })
  // launchd appends the router's stdout and stderr to this file for as long
  // as it runs; keep it under 200 KB while running, not only at each start
  // (the launcher trims it too), rewriting in place: launchd holds the file
  // open, so it must stay the same inode.
  const launchdLog = (env.ANYENGINE_LAUNCHD_LOG ?? '').trim()
  if (launchdLog) setInterval(() => trimInPlace(launchdLog, 204_800), 600_000).unref()
  const stop = (signal: string) => {
    log.info('router.stop', { signal })
    void router.close(10_000).then(() => process.exit(0))
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
}
```

The daemon wires hooks from one place, `src/router-hooks.mts`, which later tasks extend. Create it now:

```ts
// Which features the router daemon runs with. Each task that adds a face of
// the router (catalog, WebSocket relay, Claude turns) registers its hook here,
// so startRouter stays testable with any subset.
import type { RouterLog } from './router-log.mjs'
import type { RouterHooks } from './router-server.mjs'

export function buildRouterHooks(_root: string, _log: RouterLog): RouterHooks {
  return {}
}
```

- [ ] **Step 6: Add the `router` subcommand**

In `src/adapter.mts`, in `main()` directly after the `bridge-mcp` branch, add:

```ts
  // The AnyEngine router daemon (docs/guide/router.md), run by launchd.
  if (args[0] === 'router') {
    const { runRouterDaemon } = await import('./router-server.mjs')
    await runRouterDaemon()
    return
  }
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/router-core.test.mjs`
Expected: PASS, `ℹ pass 7`, `ℹ fail 0`.

- [ ] **Step 8: Docs, gates, commit**

Create `docs/guide/router.md`:

````markdown
# Router

The router is AnyEngine's model-level service (spec 5.2). It listens on
`127.0.0.1:18790` and speaks the Codex model backend's API under
`/backend-api/codex`:

- `GET /models`: the upstream catalog plus Claude entries (see below).
- GPT `/responses` over HTTP and WebSocket: relayed to chatgpt.com unchanged,
  with the caller's own headers. The router never stores, refreshes or logs a
  token.
- Claude `/responses`: agent mode hands the turn to the adapter that owns the
  thread; model mode runs it through the `claude -p` trampoline.
- `GET /health`: pid, version, mode, fan-out path, upstream state, requests in
  flight.

It runs under launchd as `dev.anyengine.router` (KeepAlive), started by
`anyengine on`. Its log is `~/.anyengine/logs/router.jsonl`, rotated at 5 MB
with three old files kept.

Only the adapter's own codex child talks to it: the adapter adds
`-c openai_base_url=http://127.0.0.1:18790/backend-api/codex` to that child
when the router answers `/health`, and leaves it out otherwise, so a stopped
router never takes GPT down for longer than one app restart.
````

Add to `src/AGENTS.md` under `## Map`: "- `router-server.mts` — the AnyEngine router (Codex face): loopback guard, `/health`, byte-exact GPT passthrough, the `adapter.mjs router` daemon; hooks for the catalog, WebSockets and Claude turns are registered in `router-hooks.mts`. `router-log.mts` is its bounded, credential-scrubbing log."

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/router-log.mts src/router-server.mts src/router-hooks.mts src/adapter.mts \
  test/helpers/fake-backend.mts test/router-core.test.mts docs/guide/router.md src/AGENTS.md
git commit -m "feat: add the router core with byte-exact GPT passthrough and a bounded log"
```

**Acceptance:** tests pass; a GPT body and its headers reach the upstream unchanged; no credential appears in the router log; the router refuses browser origins and non-loopback hosts.

---
### Task 9: Router catalog and the fan-out path

Spec 5.2 `/models`: "fetches the upstream catalog with the caller's own headers, then appends Claude entries cloned from a GPT template with Claude's context window. It raises their priority so they fall inside the spawn tool's top-5 model list. It marks every entry as multi-agent **v1**". Spec 5.2 fallback: "whenever the upstream catalog or a spawn error shows that v1 is unavailable, the router marks native mixed fan-out as unavailable". Decision D6: on the bridge path the router serves no Claude entries. Decision D18: the router serves the native path only while native fan-out is proven for exactly the lib, app, codex and settings in use (`state/proven.json`, keyed); until then it reports bridge and serves no Claude entries, so nothing reaches a native spawn that has not been shown to work.

**Files:**
- Create: `src/degraded.mts`, `src/router-fanout.mts`, `src/router-catalog.mts`
- Modify: `src/router-hooks.mts`, `scripts/test-hermetic.mjs` (`ANYENGINE_CHATGPT_APP` points at a path that does not exist, so no test reads the real app's versions)
- Create: `test/router-catalog.test.mts`
- Modify: `docs/guide/router.md`

**Interfaces:**
- Consumes: `anyengine-config.mts` (`AnyEngineConfig`, `ClaudeModelEntry`, `enginePaths`, `writeJsonAtomic`, `loadConfig`), `router-server.mts` (`RouterContext`, `RouterHooks`, `forwardHeaders`, `routerVersion`), `codex-wire.mts` (`headerValue`), `degraded.mts` (`readDegraded`, `readProof`, `isProven`, `proofKey`; this task creates the module, see Step 3), `bundled-codex.mts` (`resolveBundledCodex`).
- Produces:

```ts
// src/degraded.mts
export type SmokePath = 'router' | 'gpt' | 'claude-agent' | 'claude-model' | 'native-fanout' | 'bridge'
export interface DegradedFile { paths: Partial<Record<SmokePath, { since: string; reason: string }>> }
export function readDegraded(root: string): DegradedFile
export function markDegraded(root: string, path: SmokePath, reason: string): void   // also clears that path's proof
export function clearDegraded(root: string, path: SmokePath): void
// The native fan-out proof (decision D18): valid only for the exact lib, app,
// codex and settings it was earned under.
export interface ProofKey { lib: string | null; appVersion: string | null; codexVersion: string | null; settings: string }
export interface ProofReads { lib?(): string | null; appVersion?(): string | null; codexVersion?(): string | null; config?(): AnyEngineConfig }
export function settingsHash(config: AnyEngineConfig): string           // sha256 of what shapes native fan-out (see Step 3)
export function proofKey(root: string, reads?: ProofReads): ProofKey    // defaults: lib/current, the app's and its codex's versions, config.json
export function sameKey(a: ProofKey, b: ProofKey): boolean
export function markProven(root: string, path: SmokePath, detail: string, key: ProofKey): void   // <state>/proven.json
export function readProof(root: string, path: SmokePath): { at: string; detail: string; key: ProofKey } | null
export function isProven(root: string, path: SmokePath, key: ProofKey): boolean   // proven with an equal key, and not degraded
export function clearProof(root: string, path: SmokePath): void

// src/router-fanout.mts
export type FanoutPath = 'native' | 'bridge'
export interface FanoutState { path: FanoutPath; reason: string; since: string }
export interface RouterStatusFile { pid: number; version: string; port: number; startedAt: string; mode: string; fanout: FanoutState; writtenAt: string }
export class FanoutMonitor {
  // root null: no degraded marks and no proof check (unit tests of the evidence).
  // clock: Date.now unless a test passes its own.
  constructor(config: () => AnyEngineConfig, root: string | null, onChange?: (state: FanoutState) => void, clock?: () => number)
  get state(): FanoutState
  noteServed(v1Slugs: string[]): void          // the models the last catalog marked v1
  observeCatalog(models: unknown[]): void
  observeGptBody(body: Record<string, unknown>): void
  observeUpstreamError(status: number, text: string): void
  observeClaim(claimed: boolean): void         // Task 15: a spawned child of an owned parent, claimed or not
}
export function usesV2Collaboration(body: Record<string, unknown>): boolean
export function usesV1MultiAgent(body: Record<string, unknown>): boolean
export function writeRouterStatus(root: string, status: RouterStatusFile): void
export function readRouterStatus(root: string): RouterStatusFile | null

// src/router-catalog.mts
export type CatalogEntry = Record<string, unknown> & { slug: string }
export const ANYENGINE_MARKER = 'via AnyEngine'
export function isAnyEngineEntry(entry: unknown, claudeIds?: ReadonlySet<string>): boolean
export function orderedClaudeModels(config: AnyEngineConfig): ClaudeModelEntry[]
export function mergeCatalog(upstream: CatalogEntry[], config: AnyEngineConfig, fanout: FanoutPath): CatalogEntry[]
export function catalogKey(upstream: string, query: string, accountId: string | null): string
export function catalogEtag(upstreamEtag: string | null, config: AnyEngineConfig, fanout: FanoutPath): string
export class CatalogCache { constructor(file: string, max?: number); get(key: string): CatalogEntry[] | null; set(key: string, models: CatalogEntry[]): void }
export function modelsHook(cache: CatalogCache, fanout: FanoutMonitor): NonNullable<RouterHooks['models']>
```

- [ ] **Step 1: Write the failing tests**

Create `test/router-catalog.test.mts`:

```ts
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { DEFAULT_CONFIG, enginePaths } from '../src/anyengine-config.mjs'
import {
  CatalogCache,
  type CatalogEntry,
  catalogKey,
  isAnyEngineEntry,
  mergeCatalog,
  modelsHook,
} from '../src/router-catalog.mjs'
import { isProven, markDegraded, markProven, proofKey } from '../src/degraded.mjs'
import { FanoutMonitor, usesV2Collaboration } from '../src/router-fanout.mjs'
import { startRouter } from '../src/router-server.mjs'
import { gptEntry, startFakeBackend } from './helpers/fake-backend.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const closers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await removeTempDirs()
})

// Shaped like the live catalog on 2026-09-30: gpt-6.1-sol leads at priority
// 1 with a notice, and every entry names the access programs it serves.
const ACCESS = { available_access_programs: { cyber: ['standard'] } }
const upstream = (): CatalogEntry[] =>
  [
    gptEntry('gpt-6.1-sol', 1, { ...ACCESS, availability_nux: { message: 'Maximize usage with GPT-6.1 Sol.' } }),
    gptEntry('gpt-6-astra', 2, ACCESS),
    gptEntry('gpt-reserve', 4, { ...ACCESS, visibility: 'hide', multi_agent_version: 'v1' }),
    gptEntry('gpt-6-sol', 5, ACCESS),
    gptEntry('gpt-5.5', 13, { ...ACCESS, multi_agent_version: null }),
  ] as CatalogEntry[]

const byPriority = (models: CatalogEntry[]) =>
  models
    .filter((m) => m.visibility === 'list')
    .sort((a, b) => Number(a.priority) - Number(b.priority))
    .map((m) => m.slug)

test('catalog: native path puts every Claude model just after the default, all v1', () => {
  const merged = mergeCatalog(upstream(), DEFAULT_CONFIG, 'native')
  assert.deepEqual(byPriority(merged).slice(0, 5), ['gpt-6.1-sol', 'opus', 'sonnet', 'haiku', 'gpt-6-astra'])
  for (const m of merged) assert.notEqual(m.multi_agent_version, 'v2', m.slug)
  const opus = merged.find((m) => m.slug === 'opus')
  assert.ok(opus)
  assert.equal(opus.display_name, 'Claude Opus')
  assert.equal(opus.context_window, 200000)
  assert.equal(opus.multi_agent_version, 'v1')
  assert.ok(isAnyEngineEntry(opus))
  assert.equal(merged.find((m) => m.slug === 'gpt-5.5')?.multi_agent_version, null)
  assert.ok(!isAnyEngineEntry(merged.find((m) => m.slug === 'gpt-6-sol')))
  // Claude keeps the template's access fields and none of its GPT notice.
  assert.deepEqual(opus.available_access_programs, ACCESS.available_access_programs)
  assert.equal(opus.availability_nux, null)
})

test('catalog: the first visible entry is GPT under every access filter', () => {
  const merged = mergeCatalog(upstream(), DEFAULT_CONFIG, 'native')
  const programs = new Set<string>()
  for (const m of merged) {
    const access = (m.available_access_programs ?? {}) as Record<string, string[]>
    for (const [program, tiers] of Object.entries(access)) for (const tier of tiers) programs.add(`${program}:${tier}`)
  }
  for (const filter of [null, ...programs]) {
    const visible = merged.filter((m) => {
      if (m.visibility !== 'list') return false
      if (filter === null) return true
      const [program, tier] = filter.split(':') as [string, string]
      const access = (m.available_access_programs ?? {}) as Record<string, string[]>
      return !(program in access) || (access[program] ?? []).includes(tier)
    })
    const first = visible.sort((a, b) => Number(a.priority) - Number(b.priority))[0]
    assert.ok(first && !isAnyEngineEntry(first), `filter ${filter}: first is ${first?.slug}`)
  }
})

test('catalog: bridge path serves the upstream catalog untouched, with no Claude', () => {
  assert.deepEqual(mergeCatalog(upstream(), DEFAULT_CONFIG, 'bridge'), upstream())
})

test('catalog: the cache is scoped by account and query, bounded, and holds no credential', async () => {
  const dir = await tempDir('anyengine-catalog-')
  const cache = new CatalogCache(join(dir, 'catalogs.json'), 3)
  for (let i = 0; i < 5; i += 1) cache.set(catalogKey('u', `?client_version=${i}`, 'acct'), upstream())
  const stored = JSON.parse(readFileSync(join(dir, 'catalogs.json'), 'utf8'))
  assert.equal(Object.keys(stored).length, 3)
  assert.equal(cache.get(catalogKey('u', '?client_version=0', 'acct')), null)
  assert.ok(cache.get(catalogKey('u', '?client_version=4', 'acct')))
  assert.equal(cache.get(catalogKey('u', '?client_version=4', 'other')), null)
})

const v2Body = (model: string) => ({
  model,
  input: [
    {
      type: 'additional_tools',
      tools: [
        {
          type: 'namespace',
          name: 'collaboration',
          tools: [{ type: 'function', name: 'spawn_agent', parameters: { properties: { message: { type: 'string', encrypted: true } } } }],
        },
      ],
    },
  ],
})

test('fan-out: config, catalog shape, v2 tools on a served v1 model and upstream errors each move it to the bridge', () => {
  let config = structuredClone(DEFAULT_CONFIG)
  const changes: string[] = []
  const clock = { now: Date.now() }
  const monitor = new FanoutMonitor(() => config, null, (s) => changes.push(s.path), () => clock.now)
  // Past the ten minutes after a start in which v2 evidence is ignored.
  clock.now += 11 * 60_000
  assert.equal(monitor.state.path, 'native')
  config = { ...config, router: { ...config.router, multiAgentV1: false } }
  assert.equal(monitor.state.path, 'bridge')
  config = structuredClone(DEFAULT_CONFIG)
  assert.equal(usesV2Collaboration(v2Body('gpt-6-sol')), true)
  // Only a model this router served as v1 is evidence: another model's v2
  // tools say nothing about the rewrite.
  monitor.noteServed(['gpt-6-astra'])
  monitor.observeGptBody(v2Body('gpt-6-sol'))
  assert.equal(monitor.state.path, 'native')
  monitor.observeGptBody(v2Body('gpt-6-astra'))
  assert.equal(monitor.state.path, 'bridge')
  assert.match(monitor.state.reason, /v2 collaboration/)
  assert.deepEqual(changes, ['bridge'])
  // A config change clears the evidence.
  config = { ...structuredClone(DEFAULT_CONFIG), claude: { ...DEFAULT_CONFIG.claude, spawnPriority: ['sonnet', 'opus', 'haiku'] } }
  assert.equal(monitor.state.path, 'native')
  const fresh = new FanoutMonitor(() => DEFAULT_CONFIG, null)
  fresh.observeCatalog([{ slug: 'gpt-x', priority: 1 }])
  assert.match(fresh.state.reason, /multi_agent_version/)
  const rejected = new FanoutMonitor(() => DEFAULT_CONFIG, null)
  rejected.observeUpstreamError(400, '{"error":{"message":"multi_agent_version v1 is not supported"}}')
  assert.equal(rejected.state.path, 'bridge')
})

test('fan-out: for ten minutes after a start or a config change, v2 evidence is ignored (an older child may still hold the v2 catalog)', () => {
  const start = Date.now()
  const clock = { now: start }
  let config = structuredClone(DEFAULT_CONFIG)
  const monitor = new FanoutMonitor(() => config, null, undefined, () => clock.now)
  monitor.noteServed(['gpt-6-astra'])
  clock.now = start + 9 * 60_000
  monitor.observeGptBody(v2Body('gpt-6-astra'))
  assert.equal(monitor.state.path, 'native', 'still inside the window after the start')
  clock.now = start + 11 * 60_000
  config = { ...structuredClone(DEFAULT_CONFIG), claude: { ...DEFAULT_CONFIG.claude, spawnPriority: ['sonnet', 'opus', 'haiku'] } }
  assert.equal(monitor.state.path, 'native')
  monitor.observeGptBody(v2Body('gpt-6-astra'))
  assert.equal(monitor.state.path, 'native', 'a config change opens a new window')
  clock.now = start + 22 * 60_000
  monitor.observeGptBody(v2Body('gpt-6-astra'))
  assert.equal(monitor.state.path, 'bridge')
})

test('fan-out: native only while proven for this lib, app, codex and settings; a newer proof clears the evidence', async () => {
  const root = await tempDir('anyengine-fanout-')
  const monitor = new FanoutMonitor(() => DEFAULT_CONFIG, root)
  assert.equal(monitor.state.path, 'bridge')
  assert.match(monitor.state.reason, /not proven/)
  markProven(root, 'native-fanout', 'test', { ...proofKey(root), lib: '0.1.0-other' })
  assert.equal(monitor.state.path, 'bridge', 'proven for another lib')
  markProven(root, 'native-fanout', 'test', proofKey(root))
  assert.equal(monitor.state.path, 'native')
  for (let i = 0; i < 3; i += 1) monitor.observeClaim(false)
  assert.equal(monitor.state.path, 'bridge')
  await new Promise((ok) => setTimeout(ok, 5))
  markProven(root, 'native-fanout', 'a later smoke', proofKey(root))
  assert.equal(monitor.state.path, 'native', 'a proof newer than the evidence clears it')
  markDegraded(root, 'native-fanout', 'smoke: no claim.done')
  assert.equal(isProven(root, 'native-fanout', proofKey(root)), false, 'a degraded mark clears the proof')
})

test('fan-out: consecutive unclaimed Claude turns, or a degraded native-fanout smoke, move it to the bridge', async () => {
  const unclaimed = new FanoutMonitor(() => DEFAULT_CONFIG, null)
  unclaimed.observeClaim(false)
  unclaimed.observeClaim(false)
  unclaimed.observeClaim(true)
  unclaimed.observeClaim(false)
  unclaimed.observeClaim(false)
  assert.equal(unclaimed.state.path, 'native', 'a claim in between resets the count')
  unclaimed.observeClaim(false)
  assert.equal(unclaimed.state.path, 'bridge')
  assert.match(unclaimed.state.reason, /3 Claude turns in a row/)
  const root = await tempDir('anyengine-fanout-')
  mkdirSync(enginePaths(root).state, { recursive: true })
  writeFileSync(join(enginePaths(root).state, 'degraded.json'), JSON.stringify({ paths: { 'native-fanout': { since: 'x', reason: 'smoke: no claim.done' } } }))
  assert.equal(new FanoutMonitor(() => DEFAULT_CONFIG, root).state.path, 'bridge')
})

test('router /models: caller headers upstream, merged answer back, cache on outage, 503 without one', async () => {
  const root = await tempDir('anyengine-catalog-')
  const backend = await startFakeBackend()
  closers.push(() => backend.close())
  backend.models = upstream()
  markProven(root, 'native-fanout', 'test', proofKey(root))
  const fanout = new FanoutMonitor(() => DEFAULT_CONFIG, root)
  const cache = new CatalogCache(join(enginePaths(root).router, 'catalogs.json'))
  const router = await startRouter({ root, port: 0, upstream: backend.url, hooks: { models: modelsHook(cache, fanout), status: () => ({ fanout: fanout.state }) } })
  closers.push(() => router.close(0))
  const get = (account: string, extra: Record<string, string> = {}) =>
    fetch(`${router.baseUrl}/models?client_version=0.159.0`, {
      headers: { authorization: 'Bearer secret-token', 'chatgpt-account-id': account, ...extra },
    })
  const first = await get('acct-1')
  assert.equal(first.status, 200)
  const body = (await first.json()) as { models: CatalogEntry[] }
  assert.ok(body.models.some((m) => m.slug === 'opus'))
  const seen = backend.requests.find((r) => r.path.endsWith('/models'))
  assert.equal(seen?.headers.authorization, 'Bearer secret-token')
  assert.equal(seen?.headers['if-none-match'], undefined)
  const etag = first.headers.get('etag')
  assert.ok(etag)
  assert.equal((await get('acct-1', { 'if-none-match': etag })).status, 304)
  backend.failModels = 500
  assert.equal((await get('acct-1')).status, 200)
  assert.equal((await get('acct-2')).status, 503)
  const cacheText = readFileSync(join(enginePaths(root).router, 'catalogs.json'), 'utf8')
  assert.ok(!cacheText.includes('secret-token'))
  const health = (await (await fetch(router.healthUrl)).json()) as { fanout: { path: string } }
  assert.equal(health.fanout.path, 'native')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/router-catalog.mjs'`.

- [ ] **Step 3: Write the degraded markers, the keyed proof and the fan-out monitor**

Create `src/degraded.mts`:

```ts
// Paths the nightly smoke found broken (spec 7: "A failure raises a macOS
// notification and marks the path degraded"). The adapter reads the router's
// mark before it attaches the router; `anyengine status` shows them all; a
// passing smoke clears its own path.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { type AnyEngineConfig, enginePaths, loadConfig, writeJsonAtomic } from './anyengine-config.mjs'
import { resolveBundledCodex } from './bundled-codex.mjs'

export type SmokePath = 'router' | 'gpt' | 'claude-agent' | 'claude-model' | 'native-fanout' | 'bridge'

export interface DegradedFile {
  paths: Partial<Record<SmokePath, { since: string; reason: string }>>
}

function file(root: string): string {
  return `${enginePaths(root).state}/degraded.json`
}

export function readDegraded(root: string): DegradedFile {
  try {
    const parsed = JSON.parse(readFileSync(file(root), 'utf8')) as DegradedFile
    return parsed && typeof parsed.paths === 'object' ? parsed : { paths: {} }
  } catch {
    return { paths: {} }
  }
}

export function markDegraded(root: string, path: SmokePath, reason: string): void {
  const current = readDegraded(root)
  const since = current.paths[path]?.since ?? new Date().toISOString()
  writeJsonAtomic(file(root), { paths: { ...current.paths, [path]: { since, reason } } })
}

export function clearDegraded(root: string, path: SmokePath): void {
  const current = readDegraded(root)
  if (!current.paths[path]) return
  const { [path]: _cleared, ...rest } = current.paths
  writeJsonAtomic(file(root), { paths: rest })
}
```

Add `clearProof(root, path)` to `markDegraded` (a failing smoke takes the proof away), and, in the same file, the proof (decision D18):

```ts
// The native fan-out proof: a passing native-fanout check (the smoke, Task 27;
// or the switch-on's pre-proof of the staged lib, Task 30) holds only for the
// exact lib, ChatGPT.app version, bundled codex version and settings (the
// ones that shape native fan-out, settingsHash) it ran under. Any of them
// changing needs a new proof; the router serves the bridge path until then.
export interface ProofKey {
  lib: string | null
  appVersion: string | null
  codexVersion: string | null
  settings: string
}
export interface ProofReads {
  lib?(): string | null
  appVersion?(): string | null
  codexVersion?(): string | null
  config?(): AnyEngineConfig
}
interface ProofEntry { at: string; detail: string; key: ProofKey }
interface ProofFile { paths: Partial<Record<SmokePath, ProofEntry>> }

const proofFile = (root: string) => `${enginePaths(root).state}/proven.json`

// Only what shapes native fan-out: whether v1 is marked, the modes, which
// Claude models are offered and in what order, and the claim settings. Not
// the port, not the claude CLI path (`on` fills that in), so a pre-proof run
// before `on` and the running router agree (Task 30).
export function settingsHash(config: AnyEngineConfig): string {
  const shaping = [config.router.multiAgentV1, config.modes, config.claude.models, config.claude.spawnPriority, config.claims]
  return createHash('sha256').update(JSON.stringify(shaping)).digest('hex').slice(0, 16)
}

export function proofKey(root: string, reads: ProofReads = {}): ProofKey {
  return {
    lib: reads.lib ? reads.lib() : currentLib(root),
    appVersion: reads.appVersion ? reads.appVersion() : appVersionCached(),
    codexVersion: reads.codexVersion ? reads.codexVersion() : codexVersionCached(),
    settings: settingsHash(reads.config ? reads.config() : loadConfig(root)),
  }
}

export function sameKey(a: ProofKey, b: ProofKey): boolean {
  return a.lib === b.lib && a.appVersion === b.appVersion && a.codexVersion === b.codexVersion && a.settings === b.settings
}

function readProofFile(root: string): ProofFile {
  try {
    const parsed = JSON.parse(readFileSync(proofFile(root), 'utf8')) as ProofFile
    return parsed && typeof parsed.paths === 'object' ? parsed : { paths: {} }
  } catch {
    return { paths: {} }
  }
}

export function markProven(root: string, path: SmokePath, detail: string, key: ProofKey): void {
  const current = readProofFile(root)
  writeJsonAtomic(proofFile(root), { paths: { ...current.paths, [path]: { at: new Date().toISOString(), detail, key } } })
}

export function readProof(root: string, path: SmokePath): ProofEntry | null {
  return readProofFile(root).paths[path] ?? null
}

export function isProven(root: string, path: SmokePath, key: ProofKey): boolean {
  const proof = readProof(root, path)
  return proof !== null && !readDegraded(root).paths[path] && sameKey(proof.key, key)
}

export function clearProof(root: string, path: SmokePath): void {
  const current = readProofFile(root)
  if (!current.paths[path]) return
  const { [path]: _cleared, ...rest } = current.paths
  writeJsonAtomic(proofFile(root), { paths: rest })
}
```

The three default reads, each returning null when it cannot tell (never throwing): `currentLib(root)` is the name of the directory `<root>/lib/current` resolves to; `appVersionCached()` is `CFBundleShortVersionString` of `$ANYENGINE_CHATGPT_APP` (default `/Applications/ChatGPT.app`) read with `/usr/bin/plutil`, and `codexVersionCached()` the version of the codex `resolveBundledCodex()` finds (`<codex> --version` with stdin closed and a 2 s timeout, parsed; anything that does not print a version gives null), both cached for 30 s so a router answering `/models` does not spawn a process per request. In `scripts/test-hermetic.mjs`, set `ANYENGINE_CHATGPT_APP` to `<root>/no-app/ChatGPT.app` unless a suite sets its own, so tests never read the operator's app.


Create `src/router-fanout.mts`:

```ts
// Which way mixed fan-out goes (spec 5.2 fallback): native Codex spawn_agent
// with Claude children needs the v1 multi-agent tools, whose task text is
// plain; the v2 tools deliver it as OpenAI ciphertext a Claude child cannot
// read. Native unless the operator turned v1 marking off, the smoke marked
// native fan-out degraded, or the evidence says v1 is gone: the upstream
// catalog lost the multi_agent_version field, codex used the v2 collaboration
// tools on a model this router served as v1, the upstream rejected a request
// over it, or several spawned children of owned parents in a row found no
// adapter to claim them. Native also needs a proof for this lib, app, codex and
// settings (decision D18); without one the path is bridge. Evidence is sticky
// until the configuration changes, a newer proof arrives, or the router
// restarts: flapping would change the catalog under a running fan-out. For ten
// minutes after a start or a configuration change, v2 evidence is ignored: an
// adapter spawned earlier may still hold a catalog without the v1 marking.
import { readFileSync } from 'node:fs'
import {
  type AnyEngineConfig,
  enginePaths,
  writeJsonAtomic,
} from './anyengine-config.mjs'
import { isProven, proofKey, readDegraded, readProof } from './degraded.mjs'

export type FanoutPath = 'native' | 'bridge'
const V2_GRACE_MS = 10 * 60_000

export interface FanoutState {
  path: FanoutPath
  reason: string
  since: string
}

export interface RouterStatusFile {
  pid: number
  version: string
  port: number
  startedAt: string
  mode: string
  fanout: FanoutState
  writtenAt: string
}

type Tool = Record<string, unknown>

function toolsOf(body: Record<string, unknown>): Tool[] {
  const out: Tool[] = []
  if (Array.isArray(body.tools)) out.push(...(body.tools as Tool[]))
  if (Array.isArray(body.input)) {
    for (const item of body.input as Tool[]) {
      if (item?.type === 'additional_tools' && Array.isArray(item.tools)) out.push(...(item.tools as Tool[]))
    }
  }
  return out
}

function walk(tools: Tool[], visit: (tool: Tool, namespace: string | null) => boolean, ns: string | null = null): boolean {
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      if (walk(tool.tools as Tool[], visit, String(tool.name ?? ''))) return true
    } else if (visit(tool, ns)) return true
  }
  return false
}

export function usesV2Collaboration(body: Record<string, unknown>): boolean {
  return walk(toolsOf(body), (tool, ns) => {
    const name = String(tool.name ?? '')
    const collaboration = ns === 'collaboration' || name.startsWith('collaboration.')
    return collaboration && JSON.stringify(tool.parameters ?? {}).includes('"encrypted":true')
  })
}

export function usesV1MultiAgent(body: Record<string, unknown>): boolean {
  return walk(toolsOf(body), (tool) => String(tool.description ?? '').includes('multi_agent_v1__spawn_agent'))
}

export class FanoutMonitor {
  private readonly config: () => AnyEngineConfig
  private readonly root: string | null
  private readonly onChange: ((state: FanoutState) => void) | null
  private readonly startedAt = new Date().toISOString()
  private evidence: FanoutState | null = null
  private evidenceConfig = ''
  private served = new Set<string>()
  private unclaimedInARow = 0
  private readonly clock: () => number
  private windowFrom: number
  private windowConfig = ''

  constructor(config: () => AnyEngineConfig, root: string | null, onChange?: (state: FanoutState) => void, clock: () => number = Date.now) {
    this.config = config
    this.root = root
    this.onChange = onChange ?? null
    this.clock = clock
    this.windowFrom = clock()
  }

  // Evidence holds for the configuration it was seen under: a change to the
  // router or Claude settings (a v1 toggle, new models) starts clean.
  private configKey(): string {
    const cfg = this.config()
    return JSON.stringify([cfg.router, cfg.claude])
  }

  get state(): FanoutState {
    const cfg = this.config()
    if (!cfg.router.multiAgentV1) {
      return { path: 'bridge', reason: 'router.multiAgentV1 is false', since: this.startedAt }
    }
    const degraded = this.root ? readDegraded(this.root).paths['native-fanout'] : undefined
    if (degraded) return { path: 'bridge', reason: `the smoke marked native fan-out degraded: ${degraded.reason}`, since: degraded.since }
    if (this.root && !isProven(this.root, 'native-fanout', proofKey(this.root))) {
      return { path: 'bridge', reason: 'native fan-out is not proven for this lib, app, codex and settings', since: this.startedAt }
    }
    this.dropStaleEvidence()
    return this.evidence ?? { path: 'native', reason: 'catalog marked v1', since: this.startedAt }
  }

  // Evidence ends with the configuration it was seen under, or when a proof
  // newer than it arrives (the smoke passed again since).
  private dropStaleEvidence(): void {
    if (!this.evidence) return
    const proof = this.root ? readProof(this.root, 'native-fanout') : null
    if (this.evidenceConfig !== this.configKey() || (proof && proof.at > this.evidence.since)) {
      this.evidence = null
      this.unclaimedInARow = 0
    }
  }

  private inV2Grace(): boolean {
    const key = this.configKey()
    if (this.windowConfig === '') this.windowConfig = key
    else if (key !== this.windowConfig) {
      this.windowConfig = key
      this.windowFrom = this.clock()
    }
    return this.clock() - this.windowFrom < V2_GRACE_MS
  }

  private flip(reason: string): void {
    if (this.evidence || this.state.path === 'bridge') return
    this.evidence = { path: 'bridge', reason, since: new Date().toISOString() }
    this.evidenceConfig = this.configKey()
    this.onChange?.(this.evidence)
  }

  noteServed(v1Slugs: string[]): void {
    this.served = new Set(v1Slugs)
  }

  observeCatalog(models: unknown[]): void {
    const carriesVersion = models.some(
      (m) => m !== null && typeof m === 'object' && 'multi_agent_version' in (m as object),
    )
    if (models.length > 0 && !carriesVersion)
      this.flip('the upstream catalog no longer carries multi_agent_version')
  }

  // Only a model this router served as v1 is evidence (M5): its v2 tools
  // mean codex ignored the rewrite.
  observeGptBody(body: Record<string, unknown>): void {
    if (typeof body.model !== 'string' || !this.served.has(body.model)) return
    if (this.inV2Grace()) return
    if (this.state.path === 'native' && usesV2Collaboration(body))
      this.flip('codex used the v2 collaboration tools although the catalog said v1')
  }

  observeUpstreamError(status: number, text: string): void {
    if (status === 400 && /multi_agent|collaboration/i.test(text))
      this.flip(`the upstream rejected a request: ${text.replace(/\s+/g, ' ').slice(0, 160)}`)
  }

  observeClaim(claimed: boolean): void {
    this.unclaimedInARow = claimed ? 0 : this.unclaimedInARow + 1
    const threshold = this.config().claims.unclaimedFlipThreshold
    if (this.unclaimedInARow >= threshold)
      this.flip(`${this.unclaimedInARow} Claude turns in a row that no adapter claimed`)
  }
}

export function writeRouterStatus(root: string, status: RouterStatusFile): void {
  try {
    writeJsonAtomic(enginePaths(root).routerStatus, status)
  } catch {}
}

export function readRouterStatus(root: string): RouterStatusFile | null {
  try {
    return JSON.parse(readFileSync(enginePaths(root).routerStatus, 'utf8')) as RouterStatusFile
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Write the catalog**

Create `src/router-catalog.mts`:

```ts
// GET /models (spec 5.2). The upstream catalog with the caller's own headers,
// plus one Claude entry per configured model, cloned from the highest-ranked
// listed GPT entry. On the native path every Claude entry ranks just after
// the default GPT model (so it falls inside the spawn tool's top-5 list:
// without that, "spawn one on Haiku" silently spawned GPT in the spike), the
// other entries move down by as many places, and v2 entries are marked v1.
// On the bridge path the upstream catalog goes back untouched (decision D6).
//
// Answers are cached per (upstream, query, account id), never per bearer, so
// an upstream outage serves the same client's last good list and a client
// with no cached list gets 503, never a partial catalog (claude-in-codex
// LEARNINGS, 2026-09-27). The cache file keeps at most 16 lists.
//
// Entry shape and the fallback template follow EthanSK/claude-in-codex (MIT)
// src/catalog.js @ e2adced; see THIRD_PARTY_NOTICES.md.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AnyEngineConfig, ClaudeModelEntry } from './anyengine-config.mjs'
import { writeJsonAtomic } from './anyengine-config.mjs'
import { headerValue } from './codex-wire.mjs'
import type { FanoutMonitor, FanoutPath } from './router-fanout.mjs'
import { forwardHeaders, type RouterContext, type RouterHooks } from './router-server.mjs'

export type CatalogEntry = Record<string, unknown> & { slug: string }

export const ANYENGINE_MARKER = 'via AnyEngine'

const EFFORT_LEVELS = [
  { effort: 'low', description: 'Fastest; light thinking' },
  { effort: 'medium', description: 'Balanced speed and depth' },
  { effort: 'high', description: 'Deeper thinking for harder tasks' },
  { effort: 'xhigh', description: 'Extra-deep thinking' },
  { effort: 'max', description: 'Maximum thinking budget' },
]

const FALLBACK_TEMPLATE: Record<string, unknown> = {
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  priority: 100,
  availability_nux: null,
  upgrade: null,
  base_instructions: '',
  supports_reasoning_summaries: true,
  support_verbosity: false,
  default_verbosity: null,
  apply_patch_tool_type: 'freeform',
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_parallel_tool_calls: true,
  experimental_supported_tools: [],
}

// Kept: `available_access_programs` and the other access fields, so the app
// filters a Claude entry exactly as it filters the GPT entry it was cloned
// from (availability_nux, a GPT notice, is set to null below).
const DROPPED_FIELDS = ['default_service_tier', 'auto_compact_token_limit', 'guardian']

export function isAnyEngineEntry(entry: unknown, claudeIds?: ReadonlySet<string>): boolean {
  if (!entry || typeof entry !== 'object') return false
  const record = entry as Record<string, unknown>
  if (typeof record.description === 'string' && record.description.includes(ANYENGINE_MARKER)) return true
  return typeof record.slug === 'string' && claudeIds?.has(record.slug) === true
}

export function orderedClaudeModels(config: AnyEngineConfig): ClaudeModelEntry[] {
  const byId = new Map(config.claude.models.map((m) => [m.id, m]))
  const first = config.claude.spawnPriority.flatMap((id) => byId.get(id) ?? [])
  return [...first, ...config.claude.models.filter((m) => !config.claude.spawnPriority.includes(m.id))]
}

function priorityOf(entry: CatalogEntry): number {
  return typeof entry.priority === 'number' ? entry.priority : 0
}

function claudeEntry(template: CatalogEntry | null, model: ClaudeModelEntry, priority: number): CatalogEntry {
  const entry = structuredClone(template ?? FALLBACK_TEMPLATE) as Record<string, unknown>
  for (const field of DROPPED_FIELDS) delete entry[field]
  Object.assign(entry, {
    slug: model.id,
    display_name: model.displayName,
    description: `${model.displayName}, on your Claude plan, ${ANYENGINE_MARKER}`,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: EFFORT_LEVELS,
    visibility: 'list',
    // supported_in_api stays as the template has it (a GPT entry of this very
    // catalog): forcing true could list a Claude entry where the GPT one is not.
    priority,
    upgrade: null,
    availability_nux: null,
    additional_speed_tiers: [],
    service_tiers: [],
    context_window: model.contextWindow,
    max_context_window: model.contextWindow,
    input_modalities: ['text', 'image'],
    supports_reasoning_effort_updates: false,
    use_responses_lite: false,
    multi_agent_version: 'v1',
  })
  return entry as CatalogEntry
}

export function mergeCatalog(
  upstream: CatalogEntry[],
  config: AnyEngineConfig,
  fanout: FanoutPath,
): CatalogEntry[] {
  if (fanout === 'bridge') return upstream
  const claudeIds = new Set(config.claude.models.map((m) => m.id))
  const gpt = upstream.filter((entry) => !claudeIds.has(entry.slug))
  const first = [...gpt].filter((e) => e.visibility === 'list').sort((a, b) => priorityOf(a) - priorityOf(b))[0] ?? null
  const claude = orderedClaudeModels(config)
  const base = first ? priorityOf(first) : 0
  const shifted = gpt.map((entry) =>
    entry === first ? entry : { ...entry, priority: priorityOf(entry) + claude.length },
  )
  const added = claude.map((model, index) => claudeEntry(first, model, base + 1 + index))
  return [...shifted, ...added].map((entry) =>
    entry.multi_agent_version === 'v2' ? { ...entry, multi_agent_version: 'v1' } : entry,
  )
}

export function catalogKey(upstream: string, query: string, accountId: string | null): string {
  return createHash('sha256').update(JSON.stringify([upstream, query, accountId])).digest('hex')
}

export function catalogEtag(upstreamEtag: string | null, config: AnyEngineConfig, fanout: FanoutPath): string {
  const extra = JSON.stringify([upstreamEtag, config.claude, config.router.multiAgentV1, fanout])
  return `"ae-${createHash('sha1').update(extra).digest('hex').slice(0, 16)}"`
}

export class CatalogCache {
  private readonly file: string
  private readonly max: number
  private entries: Record<string, { at: number; models: CatalogEntry[] }>

  constructor(file: string, max = 16) {
    this.file = file
    this.max = max
    try {
      this.entries = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      this.entries = {}
    }
  }

  get(key: string): CatalogEntry[] | null {
    return this.entries[key]?.models ?? null
  }

  set(key: string, models: CatalogEntry[]): void {
    this.entries[key] = { at: Date.now(), models }
    const keys = Object.keys(this.entries).sort((a, b) => (this.entries[b]?.at ?? 0) - (this.entries[a]?.at ?? 0))
    for (const stale of keys.slice(this.max)) delete this.entries[stale]
    try {
      writeJsonAtomic(this.file, this.entries)
    } catch {}
  }
}

async function fetchUpstream(
  ctx: RouterContext,
  req: IncomingMessage,
  query: string,
): Promise<{ models: CatalogEntry[]; etag: string | null } | null> {
  const headers = forwardHeaders(req.headers) as Record<string, string>
  delete headers['if-none-match']
  delete headers['accept-encoding']
  try {
    const answer = await fetch(`${ctx.upstream()}/models${query}`, { headers, signal: AbortSignal.timeout(8000) })
    if (!answer.ok) {
      ctx.log.error('models.upstream', { status: answer.status })
      return null
    }
    const body = (await answer.json()) as { models?: unknown }
    if (!Array.isArray(body.models)) return null
    ctx.health.lastOkAt = new Date().toISOString()
    return { models: body.models as CatalogEntry[], etag: answer.headers.get('etag') }
  } catch (error) {
    ctx.health.lastError = `models: ${error instanceof Error ? error.message : String(error)}`
    ctx.health.lastErrorAt = new Date().toISOString()
    return null
  }
}

export function modelsHook(cache: CatalogCache, fanout: FanoutMonitor): NonNullable<RouterHooks['models']> {
  return async (ctx, req, res, query) => {
    const key = catalogKey(ctx.upstream(), query, headerValue(req.headers, 'chatgpt-account-id'))
    const fetched = await fetchUpstream(ctx, req, query)
    if (fetched) cache.set(key, fetched.models)
    const models = fetched?.models ?? cache.get(key)
    if (!models) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Model catalog unavailable; no cached catalog for this client.', type: 'server_error' } }))
      return
    }
    fanout.observeCatalog(models)
    const config = ctx.config()
    const path = fanout.state.path
    const etag = catalogEtag(fetched?.etag ?? null, config, path)
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag })
      res.end()
      return
    }
    const merged = mergeCatalog(models, config, path)
    fanout.noteServed(merged.filter((m) => m.multi_agent_version === 'v1' && !isAnyEngineEntry(m)).map((m) => m.slug))
    ctx.log.info('models.served', {
      query,
      fanout: path,
      total: merged.length,
      claude: merged.filter((m) => isAnyEngineEntry(m)).length,
      fromCache: !fetched,
    })
    res.writeHead(200, { 'content-type': 'application/json', etag })
    res.end(JSON.stringify({ models: merged }))
  }
}
```

(`catalogEtag` folds in the upstream etag; on a cache hit after an outage it is computed from `null`, so a later fresh answer changes it and codex refetches.)

- [ ] **Step 5: Register the catalog in the daemon**

Replace `src/router-hooks.mts` with:

```ts
// Which features the router daemon runs with. Each task that adds a face of
// the router (catalog, WebSocket relay, Claude turns) registers its hook here,
// so startRouter stays testable with any subset.
import { join } from 'node:path'
import { enginePaths, loadConfig } from './anyengine-config.mjs'
import { CatalogCache, modelsHook } from './router-catalog.mjs'
import { FanoutMonitor, writeRouterStatus } from './router-fanout.mjs'
import type { RouterLog } from './router-log.mjs'
import { type RouterHooks, routerVersion } from './router-server.mjs'

export interface RouterRuntime {
  hooks: RouterHooks
  fanout: FanoutMonitor
}

export function buildRouterRuntime(root: string, log: RouterLog): RouterRuntime {
  const config = () => loadConfig(root)
  const startedAt = new Date().toISOString()
  const record = () =>
    writeRouterStatus(root, {
      pid: process.pid,
      version: routerVersion(),
      port: config().router.port,
      startedAt,
      mode: config().modes.codexClaude,
      fanout: fanout.state,
      writtenAt: new Date().toISOString(),
    })
  const fanout = new FanoutMonitor(config, root, (state) => {
    log.info('fanout.changed', { ...state })
    record()
  })
  record()
  const cache = new CatalogCache(join(enginePaths(root).router, 'catalogs.json'))
  return {
    fanout,
    hooks: {
      models: modelsHook(cache, fanout),
      status: (ctx) => ({ mode: ctx.config().modes.codexClaude, fanout: fanout.state }),
      observeGptBody: (body) => fanout.observeGptBody(body),
      observeUpstreamError: (status, text) => fanout.observeUpstreamError(status, text),
    },
  }
}

export function buildRouterHooks(root: string, log: RouterLog): RouterHooks {
  return buildRouterRuntime(root, log).hooks
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/router-catalog.test.mjs dist/test/router-core.test.mjs`
Expected: PASS, `ℹ pass 14`, `ℹ fail 0`.

- [ ] **Step 7: Docs, gates, commit**

Append to `docs/guide/router.md`:

````markdown
## The catalog and the fan-out path

On the **native** path the router adds one entry per `claude.models` model
("Claude Opus", "Claude Sonnet", "Claude Haiku", ids `opus`, `sonnet`,
`haiku`, the adapter's own ids), ranks them just after the default GPT model
so Codex's spawn tool lists them, and marks every entry multi-agent v1, the
version whose task messages a Claude child can read. Codex's own
`spawn_agent(model="opus")` then starts a Claude child.

The router moves to the **bridge** path, and serves the upstream catalog
untouched, when `router.multiAgentV1` is `false`, when the upstream catalog
stops carrying `multi_agent_version`, when codex uses the v2 collaboration
tools despite a v1 catalog, or when the upstream rejects a request over it.
Claude children then come from the adapter's `spawn_subagents` tool, named by
one line in the GPT thread's instructions. `anyengine status` shows the path
and why; `~/.anyengine/state/router-status.json` keeps the last one.
````

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/degraded.mts src/router-fanout.mts src/router-catalog.mts src/router-hooks.mts scripts/test-hermetic.mjs \
  test/router-catalog.test.mts docs/guide/router.md
git commit -m "feat: serve Claude in the Codex catalog with v1 marking and a fan-out path"
```

**Acceptance:** with three Claude models and the live-shaped catalog (gpt-6.1-sol at priority 1), the five best-ranked listed entries are gpt-6.1-sol, Opus, Sonnet, Haiku and the next GPT model; the first visible entry is GPT under every access filter; on the bridge path the catalog is byte-for-byte the upstream one; fan-out evidence counts only models served as v1, is ignored for ten minutes after a start or a configuration change, and clears on a configuration change or a newer proof; the router serves native (and Claude entries) only while native fan-out is proven for this lib, app, codex and settings; a Claude entry keeps the template's `supported_in_api`; the cache never holds a bearer.

---
### Task 10: Port the Responses writer, the Codex input parser and the tool summaries (MIT)

The router answers Claude turns in the Responses event shape Codex parses, reads the prompt and context out of Codex's input, and strips its own items before a GPT request goes upstream. EthanSK/claude-in-codex (MIT) has all three, proven against desktop 0.158 and, in the spike, 0.155; this task ports them to typed `.mts` with AnyEngine's id prefixes.

**Source:** `https://github.com/EthanSK/claude-in-codex` at `e2adced`, read from the commit, never from a working tree: the spike's clone (`<spike-clone>`) carries uncommitted spike patches (`spikeFix.js`, `SPIKE_FORCE_V1`, a WS frame dump, the catalog cache-key change). Read each file with `git -C <clone> show e2adced:src/<file>`; if the clone is gone, `git clone` the repository into `$TMPDIR/claude-in-codex` and use the same command. Files: `src/responsesStream.js`, `src/codexInput.js`, `src/toolDisplay.js`, and the `WebSocketResponse` class in `src/server.js`. The same rule holds for every later port (Tasks 16 and 17) and for `LICENSE`.

**Files:**
- Create: `src/responses-stream.mts`, `src/codex-input.mts`, `src/tool-display.mts`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `test/responses-port.test.mts`
- Modify: `package.json` (`files` gains `THIRD_PARTY_NOTICES.md`), `scripts/install-lib.mjs` (`COPY` gains `THIRD_PARTY_NOTICES.md`)

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
// src/responses-stream.mts
export interface ResponseSink {
  writeHead?(status: number, headers: Record<string, string>): unknown
  write(chunk: string): boolean
  end(): void
  readonly writableEnded: boolean
  readonly destroyed: boolean
  on(event: 'close', listener: () => void): unknown
}
export function rid(prefix: string): string
export function usageObject(counts?: { input?: number; cached?: number; output?: number }): Record<string, unknown>
export class ResponsesStream {
  readonly id: string                 // resp_ae_<hex>
  readonly output: Record<string, unknown>[]
  constructor(sink: ResponseSink, options: { model: string })
  begin(): void
  keepAlive(): void
  textDelta(delta: string): void
  reasoningDelta(delta: string, options?: { marker?: string }): void
  reasoning(text: string, options?: { marker?: string }): void
  marker(marker: string): void
  codexToolCall(call: { callId: string; name: string; namespace?: string; custom: boolean; args: Record<string, unknown> }): void
  compaction(encryptedContent: string): void
  complete(usage: Record<string, unknown>, options?: { endTurn?: boolean }): void
  fail(message: string): void
  get closed(): boolean
}
export class WebSocketSink implements ResponseSink {   // from server.js WebSocketResponse
  constructor(socket: WebSocket, onCompleted?: (response: Record<string, unknown>) => void)
}

// src/codex-input.mts
export const MARKER_PREFIX = 'ae:v1:'
export const ROUTER_ID_PREFIXES: readonly string[]  // msg_ae_, rs_ae_, ws_ae_, cmp_ae_, fc_ae_, ctc_ae_, resp_ae_
export function makeMarker(sessionId: string, turnId: string): string
export function parseMarker(value: unknown): { sid: string; turnId: string } | null
export function isRouterItem(item: unknown): boolean
export function classifyUserText(text: string): 'prompt' | 'context' | 'environment' | 'agents_md' | 'aborted'
export function parseEnvironment(text: string): string | null
export interface ParsedCodexRequest {
  cwd: string | null; sandboxMode: string | null; planMode: boolean; agentsMd: string[]
  marker: { sid: string; turnId: string; index: number } | null
  resume: { sid: string; turnId: string; index: number } | null
  hasCompactionTrigger: boolean; skills: string | null; codexMemory: string | null
  context: string; promptText: string; images: ClaudeImageBlock[]
}
export type ClaudeImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } }
export function parseCodexRequest(body: Record<string, unknown>, isLatestTurn?: (sid: string, turnId: string) => boolean): ParsedCodexRequest
export function claudePromptText(parsed: ParsedCodexRequest, options: { newSession: boolean }): string
export function buildClaudeUserMessage(parsed: ParsedCodexRequest, options: { newSession: boolean }): Record<string, unknown>
export function sanitizeInputForOpenAI(input: unknown): { input: unknown; changed: boolean }
export function isAgentTurn(body: Record<string, unknown>): boolean   // from server.js

// src/tool-display.mts
export type ToolDisplay = { kind: 'reasoning'; text: string } | { kind: 'web'; action: Record<string, unknown> } | { kind: 'plan'; plan: unknown } | null
export function describeToolUse(block: { name?: string; input?: Record<string, unknown> }, cwd: string | null): ToolDisplay
export function describeToolError(name: string, content: unknown, description?: string): string
export function progressLine(toolName: string, input: Record<string, unknown>, cwd: string | null): string  // one line, <= 160 chars
```

- [ ] **Step 1: Add the attribution**

Create `THIRD_PARTY_NOTICES.md`:

```markdown
# Third-party notices

## claude-in-codex (codex-claude-bridge)

Source: https://github.com/EthanSK/claude-in-codex, commit `e2adced`.
Ported into `src/responses-stream.mts`, `src/codex-input.mts`,
`src/tool-display.mts`, `src/router-catalog.mts` (entry shape and fallback
template), `src/trampoline-runner.mts`, `src/trampoline-tools.mts`,
`src/trampoline-mcp.mts`, `src/trampoline-state.mts` and
`test/fixtures/fake-claude-print.mjs`, with changes (TypeScript, AnyEngine id
prefixes, AnyEngine's posture rules). Each ported file names its source file.

MIT License

Copyright (c) 2026 codex-claude-bridge contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Diff the license text against the source's `LICENSE` before committing: `diff <(sed -n '/^MIT License/,$p' THIRD_PARTY_NOTICES.md) <(git -C <clone> show e2adced:LICENSE)` must print nothing.

- [ ] **Step 2: Write the failing tests**

Create `test/responses-port.test.mts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyUserText,
  isAgentTurn,
  isRouterItem,
  makeMarker,
  parseCodexRequest,
  sanitizeInputForOpenAI,
} from '../src/codex-input.mjs'
import { ResponsesStream, type ResponseSink, usageObject } from '../src/responses-stream.mjs'
import { describeToolUse, progressLine } from '../src/tool-display.mjs'

function sink(): ResponseSink & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = []
  return {
    events,
    writableEnded: false,
    destroyed: false,
    write(chunk: string) {
      const data = chunk.split('\n').find((line) => line.startsWith('data: '))
      if (data) events.push(JSON.parse(data.slice(6)))
      return true
    },
    end() {
      ;(this as { writableEnded: boolean }).writableEnded = true
    },
    on: () => undefined,
  }
}

const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })

test('responses: text streams as a message that is done before the response completes', () => {
  const out = sink()
  const stream = new ResponsesStream(out, { model: 'opus' })
  stream.begin()
  stream.textDelta('PO')
  stream.textDelta('NG')
  stream.complete(usageObject())
  const types = out.events.map((e) => e.type)
  assert.deepEqual(types.slice(0, 2), ['response.created', 'response.in_progress'])
  const done = out.events.find((e) => e.type === 'response.output_item.done') as { item: { content: Array<{ text: string }> } }
  assert.equal(done.item.content[0]?.text, 'PONG')
  assert.equal(types.at(-1), 'response.completed')
  assert.ok(types.indexOf('response.output_item.done') < types.indexOf('response.completed'))
  assert.match(String((out.events[0] as { response: { id: string } }).response.id), /^resp_ae_/)
})

test('responses: a failure is a non-retryable response.failed, and nothing is written after the end', () => {
  const out = sink()
  const stream = new ResponsesStream(out, { model: 'opus' })
  stream.begin()
  stream.fail('no adapter owns this thread')
  stream.textDelta('late')
  const last = out.events.at(-1) as { type: string; response: { error: { code: string; message: string } } }
  assert.equal(last.type, 'response.failed')
  assert.equal(last.response.error.code, 'invalid_prompt')
  assert.ok(stream.closed)
})

test('codex input: the task is the prompt; environment, AGENTS.md and injected context are not', () => {
  const parsed = parseCodexRequest({
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '`sandbox_mode` is `workspace-write`' }] },
      user('<environment_context>\n  <cwd>/work/repo</cwd>\n</environment_context>'),
      user('# AGENTS.md instructions for /work/repo\n\nBe brief.'),
      user('Review src/a.ts and reply in one sentence.'),
    ],
  })
  assert.equal(parsed.cwd, '/work/repo')
  assert.equal(parsed.sandboxMode, 'workspace-write')
  assert.equal(parsed.promptText, 'Review src/a.ts and reply in one sentence.')
  assert.equal(parsed.agentsMd.length, 1)
  assert.equal(classifyUserText('<environment_context><cwd>x</cwd></environment_context>'), 'environment')
})

test('codex input: a marker resumes only its own latest turn', () => {
  const marker = makeMarker('sess-1', 'turn-1')
  const body = {
    input: [
      user('first'),
      { type: 'reasoning', id: 'rs_ae_1', summary: [], encrypted_content: marker },
      user('second'),
    ],
  }
  assert.equal(parseCodexRequest(body, () => true).resume?.sid, 'sess-1')
  assert.equal(parseCodexRequest(body, () => true).promptText, 'second')
  assert.equal(parseCodexRequest(body, () => false).resume, null)
})

test('codex input: router items never reach OpenAI; a Claude reply keeps its content without its id', () => {
  const input = [
    user('hi'),
    { type: 'message', id: 'msg_ae_1', role: 'assistant', content: [{ type: 'output_text', text: 'PONG' }] },
    { type: 'reasoning', id: 'rs_ae_2', summary: [], encrypted_content: makeMarker('s', 't') },
    { type: 'message', id: 'msg_real', role: 'assistant', content: [] },
  ]
  const { input: clean, changed } = sanitizeInputForOpenAI(input)
  assert.equal(changed, true)
  const list = clean as Array<Record<string, unknown>>
  assert.equal(list.length, 3)
  assert.ok(!list.some((item) => isRouterItem(item)))
  assert.equal(list[1]?.id, undefined)
  assert.equal(sanitizeInputForOpenAI([user('x')]).changed, false)
})

test('codex input: agent turns are told apart from housekeeping calls', () => {
  assert.equal(isAgentTurn({ input: [{ type: 'additional_tools', tools: [] }] }), true)
  assert.equal(isAgentTurn({ input: [user('<environment_context><cwd>/x</cwd></environment_context>')] }), true)
  assert.equal(isAgentTurn({ input: [user('Summarize this title')] }), false)
})

test('tool display: one short progress line per tool call', () => {
  assert.match(progressLine('Bash', { command: 'npm test -- --grep x' }, '/w'), /^Ran `npm test/)
  assert.equal(progressLine('Read', { file_path: '/w/src/a.ts' }, '/w'), 'Read `src/a.ts`')
  assert.ok(progressLine('Bash', { command: 'x'.repeat(500) }, null).length <= 160)
  assert.equal(describeToolUse({ name: 'Read', input: { file_path: '/w/a' } }, '/w')?.kind, 'reasoning')
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/codex-input.mjs'`.

- [ ] **Step 4: Port the three modules**

Port file by file, keeping the upstream logic and comments, with these changes and nothing else:

1. Each file starts with: `// Ported from EthanSK/claude-in-codex (MIT) src/<name>.js @ e2adced, with changes; see THIRD_PARTY_NOTICES.md.` followed by one line naming the changes.
2. TypeScript: the signatures in **Interfaces** above; `Record<string, unknown>` for Codex items; no `any`; erasable syntax (fields declared, assigned in the constructor body).
3. Prefixes: every `ccb` becomes `ae` (`resp_ae_`, `msg_ae_`, `rs_ae_`, `ws_ae_`, `cmp_ae_`, `fc_ae_`, `ctc_ae_`, marker `ae:v1:`). `isBridgeItem` becomes `isRouterItem` (the adapter already uses "bridge" for its spawn tool). `BRIDGE_ID_PREFIXES` becomes `ROUTER_ID_PREFIXES` and also lists `resp_ae_`.
4. `responses-stream.mts`: `ResponsesStream` takes a `ResponseSink`; `codexToolCall` takes `{ callId, name, namespace, custom, args }` instead of the upstream `entry`; add a `closed` getter; `send` is private. Move `WebSocketResponse` from `server.js` here as `WebSocketSink` (typed on `ws`'s `WebSocket`), and have it drop writes once the socket is not `OPEN`.
5. `codex-input.mts`: also export `isAgentTurn` (from `server.js`) and `claudePromptText` (the text half of `buildClaudeUserMessage`, which the claim path sends to the adapter). Split `parseCodexRequest` so no function exceeds cognitive complexity 30: one helper scans the items (cwd, sandbox mode, plan mode, AGENTS.md, marker, skills, memory), one finds where the prompt starts, one collects prompt texts and images.
6. `tool-display.mts`: port `describeToolUse` and `describeToolError` as they are, and add:

```ts
// One line for a claimed turn's progress (the reasoning summary Codex shows
// under a sub-agent): what ran, without output, at most 160 characters.
export function progressLine(toolName: string, input: Record<string, unknown>, cwd: string | null): string {
  const rel = (file: unknown) => {
    const path = typeof file === 'string' ? file : ''
    return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
  }
  const one = (text: string) => {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > 150 ? `${flat.slice(0, 149)}…` : flat
  }
  switch (toolName) {
    case 'Bash':
    case 'mcp__anyengine__exec':
      return one(`Ran \`${String(input.command ?? input.cmd ?? '')}\``)
    case 'Read':
      return one(`Read \`${rel(input.file_path)}\``)
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return one(`Edited \`${rel(input.file_path)}\``)
    case 'Grep':
    case 'Glob':
      return one(`Searched for \`${String(input.pattern ?? '')}\``)
    default:
      return one(`Used ${toolName}`)
  }
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/responses-port.test.mjs`
Expected: PASS, `ℹ pass 7`, `ℹ fail 0`.

- [ ] **Step 6: Package the notice, gates, commit**

In `package.json`, add `"THIRD_PARTY_NOTICES.md"` to `files`. In `scripts/install-lib.mjs`, change `COPY` to `['dist/src', 'scripts', 'package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']`.

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK (`Complexity ratchet OK: worst 112, 15 over`), `ℹ fail 0`.

```bash
git add THIRD_PARTY_NOTICES.md src/responses-stream.mts src/codex-input.mts src/tool-display.mts \
  test/responses-port.test.mts package.json scripts/install-lib.mjs
git commit -m "feat: port the Responses writer and Codex input parser from claude-in-codex (MIT)"
```

**Acceptance:** tests pass; every ported file names its source and commit; the notice's license text is identical to the source's `LICENSE`.

---
### Task 11: Router WebSocket relay, Claude turn routing and in-flight counts

Codex opens a WebSocket to `/responses` first (0.159 prewarms one per thread) and falls back to HTTP on failure. The relay must forward GPT frames unchanged, send Claude frames to a Claude turn handler, keep the rate-limit headers the upstream returns on the upgrade, and let the fan-out monitor see GPT tool declarations. This task also fixes the one interface the Claude modes implement (`ClaudeTurns`) and routes HTTP Claude requests to it, so Tasks 15 and 17 only add implementations.

**Files:**
- Create: `src/router-turns.mts`, `src/router-ws.mts`
- Modify: `src/router-catalog.mts` (remember the default GPT slug), `src/router-hooks.mts`
- Create: `test/router-ws.test.mts`

**Interfaces:**
- Consumes: `router-server.mts` (`RouterContext`, `RouterHooks`, `CODEX_BASE_PATH`, `passthrough`), `router-fanout.mts` (`FanoutMonitor`), `responses-stream.mts` (`ResponsesStream`, `WebSocketSink`, `ResponseSink`, `usageObject`), `codex-input.mts` (`sanitizeInputForOpenAI`, `isAgentTurn`), `codex-wire.mts` (`modelHint`).
- Produces:

```ts
// src/router-turns.mts
export interface ClaudeTurnRequest {
  body: Record<string, unknown>
  headers: IncomingHttpHeaders
  sink: ResponseSink
  signal: AbortSignal
}
export interface ClaudeTurns {
  readonly mode: 'agent' | 'model'
  run(ctx: RouterContext, request: ClaudeTurnRequest): Promise<void>   // resolves once the sink has ended
}
export function isClaudeModel(config: AnyEngineConfig, model: unknown): boolean
export function housekeepingBody(body: Record<string, unknown>): Record<string, unknown> | null  // model -> default GPT, null when none is known
export function claudeHttpHook(turns: (ctx: RouterContext) => ClaudeTurns | null): NonNullable<RouterHooks['claudeHttp']>
export function unavailable(sink: ResponseSink, model: string, message: string): void

// src/router-ws.mts
export function wsUpgradeHook(deps: { fanout: FanoutMonitor; turns: (ctx: RouterContext) => ClaudeTurns | null }): NonNullable<RouterHooks['upgrade']>

// src/router-catalog.mts (added)
export function defaultGptSlug(): string | null
```

- [ ] **Step 1: Write the failing tests**

Create `test/router-ws.test.mts`:

```ts
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import WebSocket from 'ws'
import { DEFAULT_CONFIG } from '../src/anyengine-config.mjs'
import { FanoutMonitor } from '../src/router-fanout.mjs'
import { ResponsesStream, usageObject } from '../src/responses-stream.mjs'
import { startRouter } from '../src/router-server.mjs'
import { type ClaudeTurns, claudeHttpHook } from '../src/router-turns.mjs'
import { wsUpgradeHook } from '../src/router-ws.mjs'
import { type FakeBackend, startFakeBackend } from './helpers/fake-backend.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const closers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await removeTempDirs()
})

const stubClaude = (calls: string[]): ClaudeTurns => ({
  mode: 'agent',
  run: async (_ctx, request) => {
    calls.push(String(request.body.model))
    const stream = new ResponsesStream(request.sink, { model: String(request.body.model) })
    stream.begin()
    stream.textDelta('CLAUDE')
    stream.complete(usageObject())
  },
})

async function setup(turns: ClaudeTurns | null) {
  const root = await tempDir('anyengine-ws-')
  const backend = await startFakeBackend()
  closers.push(() => backend.close())
  // Each read of this clock is eleven minutes later: past the grace in which
  // v2 evidence is ignored after a start (Task 9).
  let t = Date.now()
  const fanout = new FanoutMonitor(() => DEFAULT_CONFIG, null, undefined, () => (t += 11 * 60_000))
  fanout.noteServed(['gpt-6-sol'])
  const router = await startRouter({
    root,
    port: 0,
    upstream: backend.url,
    hooks: {
      upgrade: wsUpgradeHook({ fanout, turns: () => turns }),
      claudeHttp: claudeHttpHook(() => turns),
      observeGptBody: (b) => fanout.observeGptBody(b),
    },
  })
  closers.push(() => router.close(0))
  return { backend, fanout, ws: router.baseUrl.replace('http', 'ws'), http: router.baseUrl }
}

function open(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((ok, fail) => {
    const socket = new WebSocket(`${url}/responses`, { headers })
    socket.once('open', () => ok(socket))
    socket.once('error', fail)
    socket.once('unexpected-response', (_req, res) => fail(new Error(`status ${res.statusCode}`)))
    closers.push(async () => socket.terminate())
  })
}

function until(socket: WebSocket, done: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>[]> {
  return new Promise((ok) => {
    const seen: Record<string, unknown>[] = []
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      seen.push(frame)
      if (done(frame)) ok(seen)
    })
  })
}

const meta = (model: string) => JSON.stringify({ thread_id: 't1', turn_id: 'u1', request_kind: 'turn', model })
const completed = (f: Record<string, unknown>) => f.type === 'response.completed' || f.type === 'error'

test('ws: a GPT socket reaches the upstream with its headers, and frames pass byte for byte', async () => {
  const { backend, ws } = await setup(null)
  const socket = await open(ws, { authorization: 'Bearer t', 'x-codex-turn-metadata': meta('gpt-6-sol') })
  const frame = '{"type":"response.create","model":"gpt-6-sol","input":[] }'
  const answer = until(socket, completed)
  socket.send(frame)
  await answer
  assert.equal(backend.upgrades[0]?.headers.authorization, 'Bearer t')
  assert.equal(backend.frames[0], frame)
})

test('ws: a Claude frame goes to the Claude handler, a GPT frame on the same socket upstream', async () => {
  const calls: string[] = []
  const { backend, ws } = await setup(stubClaude(calls))
  const socket = await open(ws)
  const claude = until(socket, completed)
  socket.send(JSON.stringify({ type: 'response.create', model: 'opus', input: [{ type: 'additional_tools', tools: [] }] }))
  const frames = await claude
  assert.deepEqual(calls, ['opus'])
  assert.ok(frames.some((f) => f.type === 'response.output_text.delta'))
  assert.equal(backend.frames.length, 0)
  const gpt = until(socket, completed)
  socket.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-sol', input: [] }))
  await gpt
  assert.equal(backend.frames.length, 1)
})

test('ws: without a Claude handler a Claude frame gets a clear error, not a hang', async () => {
  const { ws } = await setup(null)
  const socket = await open(ws)
  const frames = until(socket, completed)
  socket.send(JSON.stringify({ type: 'response.create', model: 'opus', input: [{ type: 'additional_tools', tools: [] }] }))
  const last = (await frames).at(-1) as { type: string; error: { code: string } }
  assert.equal(last.type, 'error')
  assert.equal(last.error.code, 'anyengine_claude_unavailable')
})

test('ws: a Claude prewarm is answered at once without running Claude', async () => {
  const calls: string[] = []
  const { ws } = await setup(stubClaude(calls))
  const socket = await open(ws)
  const frames = until(socket, completed)
  socket.send(JSON.stringify({ type: 'response.create', model: 'opus', generate: false, input: [] }))
  await frames
  assert.deepEqual(calls, [])
})

test('ws: router items are stripped from GPT frames; v2 collaboration tools move fan-out to the bridge', async () => {
  const { backend, ws, fanout } = await setup(null)
  const socket = await open(ws, { 'x-codex-turn-metadata': meta('gpt-6-sol') })
  const done = until(socket, completed)
  socket.send(
    JSON.stringify({
      type: 'response.create',
      model: 'gpt-6-sol',
      input: [
        { type: 'message', id: 'msg_ae_1', role: 'assistant', content: [{ type: 'output_text', text: 'x' }] },
        { type: 'additional_tools', tools: [{ type: 'namespace', name: 'collaboration', tools: [{ type: 'function', name: 'spawn_agent', parameters: { properties: { message: { encrypted: true } } } }] }] },
      ],
    }),
  )
  await done
  assert.ok(!(backend.frames[0] ?? '').includes('msg_ae_1'))
  assert.equal(fanout.state.path, 'bridge')
})

test('ws: another upgrade path (a realtime socket) is tunnelled to the upstream untouched', async () => {
  const { backend, ws } = await setup(null)
  const socket = await new Promise<WebSocket>((ok, fail) => {
    const s = new WebSocket(`${ws}/realtime?intent=x`, { headers: { authorization: 'Bearer t' } })
    s.once('open', () => ok(s))
    s.once('error', fail)
    closers.push(async () => s.terminate())
  })
  const answer = until(socket, completed)
  socket.send('{"type":"response.create","model":"gpt-realtime"}')
  await answer
  const upgrade = backend.upgrades.find((u) => u.path.endsWith('/realtime'))
  assert.ok(upgrade)
  assert.equal(upgrade.headers.authorization, 'Bearer t')
  assert.equal(backend.frames.at(-1), '{"type":"response.create","model":"gpt-realtime"}')
})

test('ws: a browser origin is refused at the upgrade', async () => {
  const { ws } = await setup(null)
  await assert.rejects(open(ws, { origin: 'https://evil.example' }), /403/)
})

test('http: a Claude request goes to the handler; previous_response_id over HTTP asks for a replay', async () => {
  const calls: string[] = []
  const { http } = await setup(stubClaude(calls))
  const res = await fetch(`${http}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'opus', input: [{ type: 'additional_tools', tools: [] }] }),
  })
  assert.match(await res.text(), /CLAUDE/)
  const replay = await fetch(`${http}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'opus', previous_response_id: 'resp_ae_x', input: [] }),
  })
  assert.equal(replay.status, 400)
  assert.match(await replay.text(), /previous_response_not_found/)
})
```

Add `import type { FakeBackend }` only if a test needs the type; remove unused imports before running Biome.

- [ ] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/router-turns.mjs'`.

- [ ] **Step 3: Remember the default GPT model in the catalog**

In `src/router-catalog.mts`, add below `ANYENGINE_MARKER`:

```ts
// The best-ranked listed GPT entry of the last upstream catalog served: where
// housekeeping requests made "as" a Claude model (titles, summaries) go.
let lastDefaultGpt: string | null = null

export function defaultGptSlug(): string | null {
  return lastDefaultGpt
}
```

and in `modelsHook`, directly after `fanout.observeCatalog(models)`, add:

```ts
    const listed = models.filter((m) => m.visibility === 'list' && !isAnyEngineEntry(m))
    lastDefaultGpt = listed.sort((a, b) => priorityOf(a) - priorityOf(b))[0]?.slug ?? lastDefaultGpt
```

- [ ] **Step 4: Write the Claude turn routing**

Create `src/router-turns.mts`:

```ts
// Where a Claude-model request goes. A Claude agent turn (it carries tools
// or an environment context) runs in the configured mode: the adapter's
// agent (Task 15) or the claude -p trampoline (Task 17). A housekeeping call
// made "as" a Claude model (a title, a summary) goes to the default GPT model
// instead, as claude-in-codex does. Over HTTP a previous_response_id cannot be
// honoured (no socket to hold the context), so the client is asked to replay.
import type { IncomingHttpHeaders } from 'node:http'
import type { AnyEngineConfig } from './anyengine-config.mjs'
import { isAgentTurn } from './codex-input.mjs'
import { ResponsesStream, type ResponseSink } from './responses-stream.mjs'
import { defaultGptSlug } from './router-catalog.mjs'
import { passthrough, type RouterContext, type RouterHooks } from './router-server.mjs'

export interface ClaudeTurnRequest {
  body: Record<string, unknown>
  headers: IncomingHttpHeaders
  sink: ResponseSink
  signal: AbortSignal
}

export interface ClaudeTurns {
  readonly mode: 'agent' | 'model'
  run(ctx: RouterContext, request: ClaudeTurnRequest): Promise<void>
}

export function isClaudeModel(config: AnyEngineConfig, model: unknown): boolean {
  return typeof model === 'string' && config.claude.models.some((m) => m.id === model)
}

export function housekeepingBody(body: Record<string, unknown>): Record<string, unknown> | null {
  const model = defaultGptSlug()
  if (!model) return null
  const effort = (body.reasoning as { effort?: unknown } | undefined)?.effort
  const reasoning =
    typeof effort === 'string' && !['low', 'medium', 'high'].includes(effort)
      ? { ...(body.reasoning as object), effort: 'medium' }
      : body.reasoning
  return { ...body, model, ...(reasoning ? { reasoning } : {}) }
}

// A completed-then-failed Responses stream naming why; non-retryable.
export function unavailable(sink: ResponseSink, model: string, message: string): void {
  const stream = new ResponsesStream(sink, { model })
  stream.begin()
  stream.fail(message)
}

function httpError(res: import('node:http').ServerResponse, code: string, message: string): void {
  res.writeHead(400, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { type: 'invalid_request_error', code, message } }))
}

export function claudeHttpHook(
  turns: (ctx: RouterContext) => ClaudeTurns | null,
): NonNullable<RouterHooks['claudeHttp']> {
  return async (ctx, req, res, body) => {
    if (!isClaudeModel(ctx.config(), body.model)) return false
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const subpath = url.pathname.replace(/^\/backend-api\/codex/, '')
    if (!isAgentTurn(body)) {
      const rewritten = housekeepingBody(body)
      if (!rewritten) {
        httpError(res, 'anyengine_no_gpt_model', 'no GPT model known yet for a housekeeping request')
        return true
      }
      const raw = Buffer.from(JSON.stringify(rewritten))
      delete req.headers['content-encoding']
      passthrough(ctx, req, res, subpath, url.search, raw)
      return true
    }
    if (typeof body.previous_response_id === 'string') {
      httpError(res, 'previous_response_not_found', `Previous response with id '${body.previous_response_id}' not found.`)
      return true
    }
    const handler = turns(ctx)
    if (!handler) {
      httpError(res, 'anyengine_claude_unavailable', 'Claude turns are not available in this router')
      return true
    }
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) abort.abort()
    })
    ctx.inflight.claude += 1
    try {
      await handler.run(ctx, { body, headers: req.headers, sink: res, signal: abort.signal })
    } finally {
      ctx.inflight.claude -= 1
    }
    return true
  }
}
```

- [ ] **Step 5: Write the WebSocket relay**

Create `src/router-ws.mts`:

```ts
// WebSocket relay for /backend-api/codex/responses. Codex (0.159) opens one
// per thread as a prewarm and routes every turn of that thread over it; the
// socket can carry GPT and Claude frames in turn (a mid-thread switch).
//
// - A socket whose upgrade names a GPT model opens the upstream socket first
//   and hands the client the upstream's handshake headers (rate-limit headers
//   ride there); an upstream refusal (for example 426) is passed back, so
//   Codex falls back to HTTP exactly as it would against chatgpt.com.
// - A socket for Claude, or one with no model, is accepted here; the upstream
//   opens on its first GPT frame.
// - GPT frames go upstream as received unless they carry router items (then
//   they are re-serialised without them) or continue a router response.
// - Claude frames go to the configured ClaudeTurns; a prewarm is answered at
//   once. The last router response per socket is kept so a previous_response_id
//   delta can be expanded, as claude-in-codex does.
import type { IncomingMessage } from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import tls from 'node:tls'
import WebSocket, { WebSocketServer } from 'ws'
import { isAgentTurn, sanitizeInputForOpenAI } from './codex-input.mjs'
import { modelHint } from './codex-wire.mjs'
import { ResponsesStream, usageObject, WebSocketSink } from './responses-stream.mjs'
import type { FanoutMonitor } from './router-fanout.mjs'
import { CODEX_BASE_PATH, type RouterContext, type RouterHooks } from './router-server.mjs'
import { type ClaudeTurns, housekeepingBody, isClaudeModel } from './router-turns.mjs'

interface Deps {
  fanout: FanoutMonitor
  turns: (ctx: RouterContext) => ClaudeTurns | null
}

type Forward = (data: WebSocket.RawData | string, isBinary: boolean) => void

const DROPPED_UPGRADE = /^(host|connection|upgrade|sec-websocket-.*)$/i
const DONE_HEAD = /^\{"type":"(response\.(completed|failed|incomplete)|error)"/

function upstreamHeaders(req: IncomingMessage): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined && !DROPPED_UPGRADE.test(key)) out[key] = value
  }
  return out
}

function upstreamUrl(ctx: RouterContext, search: string): URL {
  const url = new URL(`${ctx.upstream()}/responses${search}`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url
}

function reject(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function sendError(client: WebSocket, code: string, message: string): void {
  if (client.readyState !== WebSocket.OPEN) return
  client.send(JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', code, message } }))
}

class Session {
  private readonly ctx: RouterContext
  private readonly deps: Deps
  private readonly req: IncomingMessage
  private readonly client: WebSocket
  private upstream: WebSocket | null = null
  private readonly queued: Array<{ data: WebSocket.RawData | string; isBinary: boolean }> = []
  private last: { id: string; input: unknown[] } | null = null
  private gptInFlight = 0

  constructor(ctx: RouterContext, deps: Deps, req: IncomingMessage, client: WebSocket, upstream: WebSocket | null) {
    this.ctx = ctx
    this.deps = deps
    this.req = req
    this.client = client
    this.upstream = upstream
    if (upstream) this.pipeUpstream(upstream)
    client.on('message', (data, isBinary) => this.onFrame(data, isBinary))
    client.on('close', () => {
      this.upstream?.terminate()
      this.ctx.inflight.gpt -= this.gptInFlight
      this.gptInFlight = 0
    })
  }

  private pipeUpstream(upstream: WebSocket): void {
    upstream.on('message', (data, isBinary) => {
      if (!isBinary) this.noteUpstreamFrame(data.toString('utf8', 0, Math.min(4096, (data as Buffer).length)))
      if (this.client.readyState === WebSocket.OPEN) this.client.send(data, { binary: isBinary })
    })
    upstream.on('close', () => this.client.close())
    upstream.on('error', (error) => {
      this.ctx.log.error('ws.upstream', { message: error.message })
      if (this.client.readyState === WebSocket.OPEN) this.client.close(1011, 'Upstream WebSocket failed')
    })
  }

  private noteUpstreamFrame(head: string): void {
    const match = DONE_HEAD.exec(head)
    if (!match) return
    if (this.gptInFlight > 0) {
      this.gptInFlight -= 1
      this.ctx.inflight.gpt -= 1
    }
    if (match[1] === 'error' && /"status":\s*400/.test(head)) this.deps.fanout.observeUpstreamError(400, head)
    else this.ctx.health.lastOkAt = new Date().toISOString()
  }

  private forwardGpt: Forward = (data, isBinary) => {
    this.gptInFlight += 1
    this.ctx.inflight.gpt += 1
    if (!this.upstream) {
      const upstream = new WebSocket(upstreamUrl(this.ctx, new URL(this.req.url ?? '/', 'http://x').search), {
        headers: upstreamHeaders(this.req),
        perMessageDeflate: true,
        handshakeTimeout: 15_000,
      })
      upstream.on('open', () => {
        for (const q of this.queued.splice(0)) upstream.send(q.data, { binary: q.isBinary })
      })
      this.upstream = upstream
      this.pipeUpstream(upstream)
    }
    if (this.upstream.readyState === WebSocket.OPEN) this.upstream.send(data, { binary: isBinary })
    else this.queued.push({ data, isBinary })
  }

  private onFrame(data: WebSocket.RawData, isBinary: boolean): void {
    let body: Record<string, unknown> | null = null
    if (!isBinary) {
      try {
        body = JSON.parse(data.toString()) as Record<string, unknown>
      } catch {}
    }
    if (!body) return this.forwardGpt(data, isBinary)
    let rewritten = false
    if (typeof body.previous_response_id === 'string' && body.previous_response_id.startsWith('resp_ae_')) {
      if (this.last?.id !== body.previous_response_id) {
        sendError(this.client, 'previous_response_not_found', `Previous response with id '${body.previous_response_id}' not found.`)
        return
      }
      const { previous_response_id: _drop, ...rest } = body
      body = { ...rest, input: [...this.last.input, ...(Array.isArray(body.input) ? body.input : [])] }
      rewritten = true
    }
    if (isClaudeModel(this.ctx.config(), body.model)) return this.onClaudeFrame(body)
    this.deps.fanout.observeGptBody(body)
    const clean = sanitizeInputForOpenAI(body.input)
    if (clean.changed || rewritten) return this.forwardGpt(JSON.stringify({ ...body, input: clean.input }), false)
    this.forwardGpt(data, isBinary)
  }

  private onClaudeFrame(body: Record<string, unknown>): void {
    const model = String(body.model)
    const remember = (response: Record<string, unknown>) => {
      const output = Array.isArray(response.output) ? response.output : []
      this.last = { id: String(response.id), input: [...(Array.isArray(body.input) ? body.input : []), ...output] }
    }
    if (body.generate === false) {
      const stream = new ResponsesStream(new WebSocketSink(this.client, remember), { model })
      stream.begin()
      stream.complete(usageObject())
      return
    }
    if (!isAgentTurn(body)) {
      const rewritten = housekeepingBody(body)
      if (!rewritten) return sendError(this.client, 'anyengine_no_gpt_model', 'no GPT model known yet')
      return this.forwardGpt(JSON.stringify(rewritten), false)
    }
    const turns = this.deps.turns(this.ctx)
    if (!turns) return sendError(this.client, 'anyengine_claude_unavailable', 'Claude turns are not available in this router')
    const abort = new AbortController()
    this.client.once('close', () => abort.abort())
    this.ctx.inflight.claude += 1
    turns
      .run(this.ctx, { body, headers: this.req.headers, sink: new WebSocketSink(this.client, remember), signal: abort.signal })
      .catch((error: unknown) => {
        this.ctx.log.error('claude.ws', { message: error instanceof Error ? error.message : String(error) })
        if (this.client.readyState === WebSocket.OPEN) this.client.close(1011, 'Claude turn failed')
      })
      .finally(() => {
        this.ctx.inflight.claude -= 1
      })
  }
}

function acceptLocally(ctx: RouterContext, deps: Deps, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true })
  wss.handleUpgrade(req, socket, head, (client) => new Session(ctx, deps, req, client, null))
}

function acceptAfterUpstream(ctx: RouterContext, deps: Deps, req: IncomingMessage, socket: Duplex, head: Buffer, search: string): void {
  socket.pause()
  const upstream = new WebSocket(upstreamUrl(ctx, search), {
    headers: upstreamHeaders(req),
    perMessageDeflate: true,
    handshakeTimeout: 15_000,
  })
  let answer: IncomingMessage | null = null
  upstream.on('upgrade', (response) => {
    answer = response
  })
  upstream.on('open', () => {
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true })
    wss.on('headers', (headers) => {
      const raw = answer?.rawHeaders ?? []
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const name = raw[i] ?? ''
        if (!/^(upgrade|connection|content-length|sec-websocket-.*)$/i.test(name)) headers.push(`${name}: ${raw[i + 1]}`)
      }
    })
    wss.handleUpgrade(req, socket, head, (client) => {
      socket.resume()
      new Session(ctx, deps, req, client, upstream)
    })
  })
  upstream.on('unexpected-response', (_request, response) => {
    response.resume()
    reject(socket, `${response.statusCode} ${response.statusMessage ?? ''}`.trim())
  })
  upstream.on('error', (error) => {
    ctx.health.lastError = `ws: ${error.message}`
    ctx.health.lastErrorAt = new Date().toISOString()
    if (!socket.destroyed) reject(socket, '502 Bad Gateway')
  })
  socket.on('close', () => upstream.terminate())
}

// Any other upgrade under the base path (a realtime socket, say) is none of
// the router's business: the request goes to the upstream as it came, over a
// raw connection, and bytes flow both ways untouched.
function tunnel(ctx: RouterContext, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const target = new URL(`${ctx.upstream()}${url.pathname.slice(CODEX_BASE_PATH.length)}${url.search}`)
  const secure = target.protocol === 'https:'
  const port = Number(target.port || (secure ? 443 : 80))
  const upstream = secure
    ? tls.connect({ host: target.hostname, port, servername: target.hostname })
    : net.connect({ host: target.hostname, port })
  upstream.once(secure ? 'secureConnect' : 'connect', () => {
    const lines = [`${req.method ?? 'GET'} ${target.pathname}${target.search} HTTP/1.1`]
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i] ?? ''
      lines.push(`${name}: ${/^host$/i.test(name) ? target.host : req.rawHeaders[i + 1]}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => {
    if (!socket.destroyed) reject(socket, '502 Bad Gateway')
  })
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
}

export function wsUpgradeHook(deps: Deps): NonNullable<RouterHooks['upgrade']> {
  return (ctx, req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(CODEX_BASE_PATH)) return reject(socket, '404 Not Found')
    if (url.pathname !== `${CODEX_BASE_PATH}/responses`) return tunnel(ctx, req, socket, head)
    const hint = modelHint(req.headers)
    if (hint && !isClaudeModel(ctx.config(), hint)) return acceptAfterUpstream(ctx, deps, req, socket, head, url.search)
    acceptLocally(ctx, deps, req, socket, head)
  }
}
```

(A prewarm frame says `generate: false`: it must be answered, and must not start Claude. The socket's `request_kind: prewarm` metadata only says the socket was opened early; later frames on it are real turns.)

- [ ] **Step 6: Register the relay in the daemon**

In `src/router-hooks.mts`, extend `RouterRuntime` and `buildRouterRuntime`:

```ts
import { claudeHttpHook, type ClaudeTurns } from './router-turns.mjs'
import { wsUpgradeHook } from './router-ws.mjs'
```

add a field `claude: { current: ClaudeTurns | null }` to `RouterRuntime`, create `const claude = { current: null as ClaudeTurns | null }` in `buildRouterRuntime`, return it, and add to the hooks object:

```ts
      upgrade: wsUpgradeHook({ fanout, turns: () => claude.current }),
      claudeHttp: claudeHttpHook(() => claude.current),
```

Tasks 15 and 17 set `claude.current` from the configured mode.

- [ ] **Step 7: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/router-ws.test.mjs dist/test/router-catalog.test.mjs dist/test/router-core.test.mjs`
Expected: PASS, `ℹ pass 22`, `ℹ fail 0`.

- [ ] **Step 8: Gates, commit**

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/router-turns.mts src/router-ws.mts src/router-catalog.mts src/router-hooks.mts test/router-ws.test.mts
git commit -m "feat: relay Codex WebSockets and route Claude turns in the router"
```

**Acceptance:** GPT frames reach the upstream unchanged (byte-compared), another upgrade path is tunnelled byte for byte, a Claude frame never reaches the upstream, a browser origin cannot open a socket, and a v2 tool declaration on a model served as v1 moves the fan-out path to the bridge.

---
### Task 12: Record how codex 0.159 announces a spawned child (zero-spend gate)

The claim design (decision D2) depends on two facts the adapter reads from its codex child: which notification links a spawned child to its parent, and what the child's model request carries. The spike logs (0.155, `s1/logs` q2b, q2f, q2g, q2h) show that `thread/started` arrives for the root thread only; a child is announced by the parent's `collabAgentToolCall` items (`tool: "spawnAgent"`, `senderThreadId`, `receiverThreadIds`, `model`): `item/started` with no receivers, then `item/completed` with the child's id, about 1 to 5 ms before the child's own `turn/started`. The capture of Task 6 saw no multi-agent tools at all, because it logged in with an API key. This task records the real 0.159 sequence at zero spend, with a fake ChatGPT login and a fake backend that answers the parent's first turn with a v1 spawn, and commits the recording. Tasks 13, 14 and 15 are proven against it. Nothing here touches `~/.codex` or reaches OpenAI.

**Files:**
- Create: `scripts/capture-codex-spawn.mjs`, `scripts/lib/fake-chatgpt-auth.mjs` (shared with Task 30's differential gate)
- Create: `test/fixtures/codex-spawn-0.159.0.json` (written by the script, then committed)
- Create: `test/fixtures/codex-spawn-0.155-spike.json` (the spike's shape, from `s1/logs/q2f.jsonl`, ids normalised; the fallback reference)
- Create: `test/codex-spawn.test.mts`
- Modify: `scripts/AGENTS.md`

**Interfaces:**
- Consumes: `scripts/capture-codex-wire.mjs`'s fake-backend pattern (Task 6), `src/bundled-codex.mts` (`resolveBundledCodex`).
- Produces: the fixture, with this shape (ids replaced by `PARENT`, `CHILD`, `TURN_n`):

```json
{
  "codexVersion": "0.159.0",
  "multiAgentToolsOffered": true,
  "spawnVia": "exec:tools.multi_agent_v1__spawn_agent",
  "notifications": [
    { "method": "item/started", "threadId": "PARENT", "item": { "type": "collabAgentToolCall", "tool": "spawnAgent", "senderThreadId": "PARENT", "receiverThreadIds": [], "model": "opus" } },
    { "method": "item/completed", "threadId": "PARENT", "item": { "type": "collabAgentToolCall", "tool": "spawnAgent", "senderThreadId": "PARENT", "receiverThreadIds": ["CHILD"], "model": "opus" } },
    { "method": "turn/started", "threadId": "CHILD" }
  ],
  "childThreadStarted": false,
  "childRequest": { "headerNames": ["..."], "threadIdHeader": "CHILD", "parentThreadIdHeader": "PARENT", "subagentHeader": "collab_spawn", "turnMetadata": { "agent_name": "/root/...", "request_kind": "turn" } }
}
```

(the values are what the recording shows; the example is the expected shape, not a claim about them).

- [ ] **Step 1: Write the capture script**

Create `scripts/capture-codex-spawn.mjs`, built like `capture-codex-wire.mjs` (Task 6) with these differences:

1. **Fake ChatGPT login, isolated home.** Put the login in `scripts/lib/fake-chatgpt-auth.mjs`, exporting `fakeJwt(payload): string` and `writeFakeChatgptAuth(codexHome: string, options?: { accountId?: string; plan?: string }): string` (returns the path it wrote, 0600), so Task 30's differential gate logs in the same way. It writes `<codexHome>/auth.json` in the shape codex's own `login` writes for a ChatGPT account (`auth_mode` `"chatgpt"`, `OPENAI_API_KEY` null, `tokens` with `id_token`, `access_token`, `refresh_token`, `account_id`, and `last_refresh` set to now). The two tokens are unsigned JWTs (`{"alg":"none","typ":"JWT"}` header, empty signature) whose payload has `exp` one year ahead, `email: "probe@example.invalid"`, and the claim object `https://api.openai.com/auth` with `chatgpt_plan_type: "pro"`, `chatgpt_account_id: "acct-anyengine-probe"`, `chatgpt_user_id: "user-anyengine-probe"`. Take the exact field names from the installed codex, not from `~/.codex/auth.json` (never read it): `codex login --help` and the generated schema (`GetAuthStatusResponse`, `AuthMode`) name them; a first run with `codex login status` in the probe home must print that it is logged in with ChatGPT (no network: status reads the file). If codex rejects the token shape, adjust until `login status` accepts it; if it cannot be made to accept one, record `multiAgentToolsOffered: false` with the reason and go to Step 3's fallback.
2. **No way out.** Start the app-server under `sandbox-exec -p '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))'` so nothing can leave the Mac, with `-c openai_base_url="http://127.0.0.1:<port>/backend-api/codex"`, `-c chatgpt_base_url="http://127.0.0.1:<port>/backend-api/"`, `-c 'mcp_servers={}'`, `-c notify=[]` and `-c features.code_mode_host=true` (as the app passes it). If `sandbox-exec` is missing, stop: this probe runs only with outbound traffic denied.
3. **The fake backend** answers everything under `/backend-api/` (404 JSON for what it does not know, recorded): `GET /backend-api/codex/models` returns a catalog whose GPT entry and an `opus` entry are `multi_agent_version: "v1"` (the entry shape of Task 6's capture); the WebSocket upgrade gets 426; `POST /backend-api/codex/responses` is answered by turn:
   - the parent's first request: record the `exec` tool's description (it lists the nested tools and how to call them), then answer with one `custom_tool_call` for `exec` whose input calls the v1 spawn tool with `model: "opus"` and the message `Reply with exactly the word PONG`, in the syntax that description gives (the spike's rollout recorded `tools.multi_agent_v1__spawn_agent({model:"...", reasoning_effort:"low", message:"..."})`);
   - a request whose `thread-id` differs from the parent's: the child's. Record its headers (names; the values of `thread-id`, `session-id`, `x-codex-parent-thread-id`, `x-openai-subagent`; the keys and `agent_name`/`request_kind` of `x-codex-turn-metadata`) and body shape, and answer PONG;
   - the parent's later requests: answer with a final message `done`.
4. **Record** every app-server notification after `turn/start` (method, `threadId`, and for `item/*` the item's `type`, `tool`, `senderThreadId`, `receiverThreadIds`, `model`, `status`), whether any `thread/started` names the child, and the order of the child's link and its `turn/started`. Normalise ids and write the fixture. Exit 0 when the child was linked by some notification and its request was seen; exit 1 naming what is missing.

- [ ] **Step 2: Run it**

Run: `T7 npm run build && T7 node scripts/capture-codex-spawn.mjs`
Expected: `capture-codex-spawn: 0.159.0 ok -> test/fixtures/codex-spawn-0.159.0.json`, the fixture showing the link (on 0.155 it was `item/completed` of a `collabAgentToolCall` with `receiverThreadIds`), `childThreadStarted` true or false as observed, and the child's headers.

If the multi-agent tools were not offered (the fixture says `multiAgentToolsOffered: false`, for example because they are gated by an account feature the fake login does not have), the script exits 1 with that reason. Then: commit the fixture as it is, build `test/fixtures/codex-spawn-0.155-spike.json` from `<spike-output>/q2f.jsonl` (the same shape, ids normalised; read-only), and record in the task's commit message that 0.159's sequence is proven only live (the switch-on's native fan-out check in Task 30 and the nightly `native-fanout` smoke in Task 27; when either fails, the router takes the bridge path: Tasks 9, 18 and 27). Tasks 13 to 15 then test against both link shapes.

- [ ] **Step 3: Write the contract test**

Create `test/codex-spawn.test.mts`:

```ts
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const recordings = ['test/fixtures/codex-spawn-0.159.0.json', 'test/fixtures/codex-spawn-0.155-spike.json']
  .map((p) => resolve(p))
  .filter((p) => existsSync(p))
  .map((p) => JSON.parse(readFileSync(p, 'utf8')))

test('spawn recording: at least one recording exists', () => {
  assert.ok(recordings.length > 0)
})

test('spawn recording: a child is linked to its parent before its first turn starts', () => {
  for (const rec of recordings.filter((r) => r.multiAgentToolsOffered !== false)) {
    const n = rec.notifications as Array<{ method: string; threadId?: string; item?: Record<string, any> }>
    const link = n.findIndex(
      (m) =>
        (m.method === 'item/completed' && m.item?.type === 'collabAgentToolCall' && m.item?.tool === 'spawnAgent' && m.item?.receiverThreadIds?.includes('CHILD')) ||
        (m.method === 'thread/started' && m.item === undefined && m.threadId === 'CHILD'),
    )
    const childTurn = n.findIndex((m) => m.method === 'turn/started' && m.threadId === 'CHILD')
    assert.ok(link >= 0, `${rec.codexVersion}: no notification links the child`)
    assert.ok(childTurn > link, `${rec.codexVersion}: the child's turn starts before its link`)
  }
})

test('spawn recording (0.159): the child request names its own thread', () => {
  const rec = recordings.find((r) => r.codexVersion === '0.159.0' && r.multiAgentToolsOffered !== false)
  if (!rec) return
  assert.equal(rec.childRequest.threadIdHeader, 'CHILD')
})
```

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/codex-spawn.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 4: Docs, gates, commit**

Add to `scripts/AGENTS.md`: "- `capture-codex-spawn.mjs`: zero-spend recording of how the bundled codex announces a `spawn_agent` child and what the child's model request carries: a fake ChatGPT login (unsigned JWTs) in an isolated home, outbound traffic denied by `sandbox-exec`, a loopback fake backend that answers the parent with a v1 spawn. Writes `test/fixtures/codex-spawn-<version>.json`."

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add scripts/capture-codex-spawn.mjs scripts/lib/fake-chatgpt-auth.mjs test/fixtures/codex-spawn-*.json test/codex-spawn.test.mts scripts/AGENTS.md
git commit -m "test: record how codex announces a spawned child, at zero spend"
```

**Acceptance:** a committed recording shows which notification links a spawned child to its parent and what the child's request carries, captured with outbound traffic denied; or, if 0.159 would not offer the tools to a fake login, the reason is recorded and the spike's 0.155 shape is committed as the reference.

---
### Task 13: The adapter learns the children codex spawns, under the parent's posture

Decision D2, first half. Before a claimed child can run on the adapter's Claude, the adapter must know it: which thread is a spawned child, whose child, with what model, and under what posture. The recording of Task 12 (and the 0.155 spike logs) says how codex tells: the parent's `collabAgentToolCall` items with `tool: "spawnAgent"`, `item/started` without receivers, then `item/completed` with `receiverThreadIds` naming the child, a few milliseconds before the child's `turn/started`; `thread/started` may not be sent for a child at all. This task teaches the mux both sources, gives each child a posture that is never looser than its parent's (recorded at spawn, narrowed if the parent tightens later, the strictest posture for an unknown parent), makes room for that in the two baselined files, and lets the runtime release one thread's warm PTY. The claim socket is Task 14.

**Files:**
- Create: `src/rpc-shape.mts` (moved helpers), `src/native-children.mts`, `src/anyengine-env.mts` (moved `buildEnv`)
- Modify: `src/codex-mux.mts` (helpers out, reserve probe out, children learned, `claimThread`, `waitForClaimThread`), `src/reserve.mts` (reserve-model probe moved in), `src/posture.mts` (`STRICTEST_POSTURE`, `noLooser`, `claimPosture`), `src/anyengine-runtime.mts` (`release`, `buildEnv` out), `src/runtime-factory.mts` (`release` to every runtime), `src/types.mts` (`ClaudeRuntime.release?`)
- Modify: `test/fixtures/fake-codex-app-server.mjs` (`FAKE_CODEX_SPAWN_CHILD`, in the recorded shape)
- Create: `test/native-children.test.mts`; modify `test/posture.test.mts` (one property test)

**Interfaces:**
- Consumes: Task 12's recordings (`test/fixtures/codex-spawn-*.json`), `posture.mts` (`reach`, `sandboxedOutcome`, `postureContext`, `DEFAULT_POSTURE`), `store.mts`, `codex-upstream.mts`.
- Produces:

```ts
// src/native-children.mts
export interface NativeChild { threadId: string; parentThreadId: string; model: string | null; cwd: string | null }
export class NativeChildren {
  observeItem(item: Record<string, unknown>): NativeChild[]            // collabAgentToolCall spawnAgent with receivers
  observeThread(thread: Record<string, unknown>): NativeChild | null   // thread/started, the second source
  get(threadId: string): NativeChild | null
  waitFor(threadId: string, ms: number): Promise<NativeChild | null>
  forget(threadId: string): void
}
export function inheritedInfo(child: NativeChild, parent: UpstreamThreadInfo | null): UpstreamThreadInfo

// src/posture.mts
export const STRICTEST_POSTURE: Posture      // plan mode, read-only, no network, untrusted
export function noLooser(a: Posture, b: Posture, ctx: PostureContext): boolean
export function claimPosture(child: Posture | null, parent: Posture | null, ctx: PostureContext): Posture

// src/codex-mux.mts (public)
claimThread(threadId: string): ClaimThread | null
waitForClaimThread(threadId: string, ms: number): Promise<ClaimThread | null>   // after the wait, asks the codex child (thread/read)
knowsThread(threadId: string): boolean                                          // one of the codex child's threads

// src/claim-types.mts (new, tiny: shared by the mux and Task 14)
export interface ClaimThread { threadId: string; parentThreadId: string | null; parentCwd: string | null; cwd: string | null; model: string | null; posture: Posture }

// src/types.mts: ClaudeRuntime gains
release?(threadId: string): Promise<void>
```

- [ ] **Step 1: Make room in the two baselined files**

`src/codex-mux.mts` is at its 1177-line baseline and `src/anyengine-runtime.mts` at 1402; both gain a few lines in this task, so first move self-contained code out, with no behaviour change.

1. Create `src/rpc-shape.mts` with `asRecord`, `threadIdOf` and `idOf` exactly as they are at the bottom of `codex-mux.mts` (lines 1159-1177), plus `const THREAD_ID_KEYS = ['threadId', 'thread_id'] as const` from line 115, all exported. Delete them from `codex-mux.mts` and add `import { asRecord, idOf, threadIdOf } from './rpc-shape.mjs'`.
2. Move the reserve-model probe (the field `rateLimitReachedCache` and the method `shouldHideReserveModels`, lines 704-726) into `src/reserve.mts` as:

```ts
// ANYENGINE_HIDE_RATE_LIMIT_UPSELL=1 (legacy): whether model/list should hide
// the OpenAI half because the account's limit is reached. Cached 30 s.
export class ReserveModelsProbe {
  private readonly read: () => Promise<unknown>
  private cache: { at: number; reached: boolean } | null = null

  constructor(read: () => Promise<unknown>) {
    this.read = read
  }

  async hidden(): Promise<boolean> {
    // body of shouldHideReserveModels, with `this.upstream.request('account/rateLimits/read', {})`
    // replaced by `this.read()`, `this.rateLimitReachedCache` by `this.cache`,
    // and RATE_LIMIT_CACHE_MS (30_000) moved here
  }
}
```

(`asRecord` and `debugLog` are imported into `reserve.mts` from `rpc-shape.mjs` and `util.mjs`.) In `codex-mux.mts`: remove `RATE_LIMIT_CACHE_MS`, add a field `private readonly reserveModels: ReserveModelsProbe`, initialise it in the constructor with `new ReserveModelsProbe(() => this.upstream.request('account/rateLimits/read', {}))`, and replace `await this.shouldHideReserveModels()` with `await this.reserveModels.hidden()`.
3. Create `src/anyengine-env.mts`:

```ts
// The environment of an interactive `claude` child: the adapter's own minus
// nested-session markers and any Anthropic endpoint or key the operator did
// not ask to keep, plus the hook relay and, when present, the loopback SSE
// proxy. Moved out of anyengine-runtime.mts (size ratchet).
export function ptyEnv(
  input: { hookUrl: string; hookToken: string; proxyPort: number | null; keepApiKey: boolean },
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  // body of AnyEngineRuntime#buildEnv, reading `input` instead of `this`
}
```

and in `anyengine-runtime.mts` replace `const env = this.buildEnv(proxy)` (line 422) with `const env = ptyEnv({ hookUrl: this.hooks.url, hookToken: this.hooks.token, proxyPort: proxy?.port ?? null, keepApiKey: this.options.keepApiKey })`, delete `buildEnv`, and import `ptyEnv`.

Run: `T7 npm run build && T7 npm test 2>&1 | tail -4 && wc -l src/codex-mux.mts src/anyengine-runtime.mts`
Expected: `ℹ fail 0`, `src/codex-mux.mts` at or below 1140, `src/anyengine-runtime.mts` at or below 1375. Commit this step on its own:

```bash
git add src/rpc-shape.mts src/reserve.mts src/codex-mux.mts src/anyengine-env.mts src/anyengine-runtime.mts scripts/size-baseline.json
git commit -m "refactor: move mux helpers, the reserve-model probe and the PTY env out of baselined files"
```

- [ ] **Step 2: Teach the fake codex child to spawn a child, as 0.159 does**

In `test/fixtures/fake-codex-app-server.mjs`, add to the header comment: "`FAKE_CODEX_SPAWN_CHILD=<model>` makes every `turn/start` spawn one child the way codex announces a `spawn_agent` child (Task 12's recording): the parent's `collabAgentToolCall` `item/started` without receivers, its `item/completed` naming the child, then the child's `turn/started`; no `thread/started` for the child, unless `FAKE_CODEX_CHILD_THREAD_STARTED=1` (the second source)." In the `turn/start` case, directly after `notify('turn/started', ...)` for the parent, add:

```js
      if (process.env.FAKE_CODEX_SPAWN_CHILD) {
        const childId = `fake-child-${turnId}`
        const model = process.env.FAKE_CODEX_SPAWN_CHILD
        const item = (status, receivers) => ({
          type: 'collabAgentToolCall',
          id: `${turnId}-spawn`,
          tool: 'spawnAgent',
          status,
          senderThreadId: threadId,
          receiverThreadIds: receivers,
          prompt: 'Reply with exactly the word PONG',
          model,
          agentsStates: {},
        })
        notify('item/started', { threadId, turnId, item: item('inProgress', []) })
        notify('item/completed', { threadId, turnId, item: item('completed', [childId]) })
        if (process.env.FAKE_CODEX_CHILD_THREAD_STARTED === '1') {
          notify('thread/started', { thread: thread(childId, { parentThreadId: threadId, model }) })
        }
        notify('turn/started', { threadId: childId, turn: { id: `${turnId}-child`, items: [], status: 'inProgress' } })
      }
```

Compare the item's fields with `test/fixtures/codex-spawn-0.159.0.json` (Task 12) and make the fake match what 0.159 sent; where the recording differs from the code above, the recording wins.

In the same file's `thread/read` case, a thread id of the form `fake-missed-child-of-<parent>` is answered with `thread(target, { parentThreadId: <parent>, model: 'opus' })`: a child the adapter never saw announced, which the mux's `thread/read` fallback must still find.

- [ ] **Step 3: Write the failing tests**

Create `test/native-children.test.mts`:

```ts
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { CodexUpstream } from '../src/codex-upstream.mjs'
import { type MuxLocalServer, NativeCodexMux } from '../src/codex-mux.mjs'
import { inheritedInfo, NativeChildren } from '../src/native-children.mjs'
import { DEFAULT_POSTURE, STRICTEST_POSTURE } from '../src/posture.mjs'
import { SessionStore } from '../src/store.mjs'
import type { RpcPeer, WireMessage } from '../src/types.mjs'
import { killChildren } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const stops: Array<() => Promise<void>> = []
after(async () => {
  for (const stop of stops.splice(0)) await stop()
  await killChildren()
  await removeTempDirs()
})

const recordings = ['test/fixtures/codex-spawn-0.159.0.json', 'test/fixtures/codex-spawn-0.155-spike.json']
  .map((p) => resolve(p))
  .filter((p) => existsSync(p))
  .map((p) => JSON.parse(readFileSync(p, 'utf8')))
  .filter((r) => r.multiAgentToolsOffered !== false)

test('children: every recorded link shape names the child and its parent', () => {
  assert.ok(recordings.length > 0)
  for (const rec of recordings) {
    const children = new NativeChildren()
    for (const n of rec.notifications as Array<{ method: string; item?: Record<string, unknown>; thread?: Record<string, unknown> }>) {
      if (n.item) children.observeItem(n.item)
      if (n.method === 'thread/started' && n.thread) children.observeThread(n.thread)
    }
    const child = children.get('CHILD')
    assert.equal(child?.parentThreadId, 'PARENT', rec.codexVersion)
  }
})

test('children: an in-progress spawn, a wait, and a non-collab item link nothing', () => {
  const children = new NativeChildren()
  assert.deepEqual(children.observeItem({ type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: 'p', receiverThreadIds: [], model: 'opus' }), [])
  assert.deepEqual(children.observeItem({ type: 'collabAgentToolCall', tool: 'wait', senderThreadId: 'p', receiverThreadIds: ['c'] }), [])
  assert.deepEqual(children.observeItem({ type: 'agentMessage', text: 'x' }), [])
  const linked = children.observeItem({ type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: 'p', receiverThreadIds: ['c1', 'c2'], model: 'opus' })
  assert.deepEqual(linked.map((c) => [c.threadId, c.parentThreadId, c.model]), [['c1', 'p', 'opus'], ['c2', 'p', 'opus']])
  assert.equal(children.observeThread({ id: 'c3', source: { subagent: { thread_spawn: { parent_thread_id: 'p' } } } })?.parentThreadId, 'p')
  assert.equal(children.observeThread({ id: 'c4', source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } } })?.parentThreadId, 'p')
  assert.equal(children.observeThread({ id: 'root' }), null)
})

test('children: a waiter wakes when the link arrives, and gives up after its time', async () => {
  const children = new NativeChildren()
  const waiting = children.waitFor('late', 500)
  setTimeout(() => children.observeItem({ type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: 'p', receiverThreadIds: ['late'], model: 'opus' }), 50)
  assert.equal((await waiting)?.parentThreadId, 'p')
  assert.equal(await children.waitFor('never', 50), null)
  assert.deepEqual(inheritedInfo({ threadId: 'x', parentThreadId: 'p', model: 'opus', cwd: null }, null).posture, DEFAULT_POSTURE)
})

// The mux, in process, against the fake codex child: what a claim will see.
async function muxWithFakeChild(root: string) {
  mkdirSync(join(root, 'home'), { recursive: true })
  const store = new SessionStore(join(root, 'state.sqlite'))
  let mux: NativeCodexMux | null = null
  process.env.FAKE_CODEX_SPAWN_CHILD = 'opus'
  process.env.FAKE_CODEX_NO_APPROVAL = '1'
  const upstream = new CodexUpstream({
    binary: resolve('test/fixtures/fake-codex-app-server.mjs'),
    args: ['app-server'],
    onMessage: (message: WireMessage) => mux?.onUpstreamMessage(message),
  })
  const local: MuxLocalServer = {
    dispatch: async () => ({}),
    localThreadOwner: () => null,
    localThreadModel: () => null,
    localThreadPosture: () => DEFAULT_POSTURE,
    hasActiveTurn: () => false,
    adoptThread: () => {},
  }
  mux = new NativeCodexMux({ store, upstream, local })
  stops.push(async () => {
    await mux?.stop()
    store.close()
  })
  const sent: WireMessage[] = []
  const peer: RpcPeer = { id: 'app', send: (m) => sent.push(m), close: () => {} }
  let id = 0
  const request = async (method: string, params: unknown) => {
    const n = ++id
    await mux?.handle(peer, { jsonrpc: '2.0', id: n, method, params } as WireMessage)
    for (let i = 0; i < 200; i += 1) {
      const answer = sent.find((m) => 'id' in m && m.id === n && !('method' in m))
      if (answer) return answer as Record<string, any>
      await new Promise((ok) => setTimeout(ok, 10))
    }
    throw new Error(`no answer to ${method}`)
  }
  return { mux, request, sent }
}

test('mux: a spawned child is claimable under its parent posture; a later tightening narrows it; an unknown parent is the strictest', async () => {
  const root = await tempDir('ae-mux-')
  const { mux, request } = await muxWithFakeChild(root)
  await request('initialize', { clientInfo: { name: 't', version: '0' } })
  const started = await request('thread/start', { model: 'gpt-6-sol', cwd: root, sandbox: 'workspace-write', approvalPolicy: 'on-request' })
  const parent = started.result.thread.id as string
  await request('turn/start', { threadId: parent, input: [{ type: 'text', text: 'spawn one' }] })
  const child = await mux.waitForClaimThread('fake-child-fake-turn-1', 2000)
  assert.ok(child, 'the child is known without any thread/started')
  assert.equal(child.parentThreadId, parent)
  assert.equal(child.parentCwd, root)
  assert.equal(child.posture.fileSystem.kind, 'workspace-write')
  await request('turn/start', { threadId: parent, sandboxPolicy: { type: 'readOnly' }, input: [{ type: 'text', text: 'again' }] })
  assert.equal(mux.claimThread(child.threadId)?.posture.fileSystem.kind, 'read-only', 'the parent tightened, so the child did')
  mux.onUpstreamMessage({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'ghost', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: 'ghost', receiverThreadIds: ['orphan'], model: 'opus' } } } as WireMessage)
  assert.deepEqual(mux.claimThread('orphan')?.posture, STRICTEST_POSTURE)
  assert.equal(mux.knowsThread(parent), true)
  assert.equal(mux.knowsThread('never-seen'), false)
  // An announcement the adapter missed: the codex child still knows the
  // thread and its parent (thread/read), so the claim finds it after the wait.
  const missed = await mux.waitForClaimThread(`fake-missed-child-of-${parent}`, 50)
  assert.ok(missed, 'learned through thread/read')
  assert.equal(missed.parentThreadId, parent)
  assert.equal(missed.posture.fileSystem.kind, 'read-only', 'under the parent’s current posture')
  assert.equal(await mux.waitForClaimThread('fake-missed-child-of-nobody', 50), null, 'a parent this adapter does not know')
})
```

(The fake names its turns `fake-turn-<n>`, so the first spawned child is `fake-child-fake-turn-1`; adjust to whatever id the fake emits. The process-level `FAKE_CODEX_*` variables reach the child because `CodexUpstream` inherits the environment.)

Append to `test/posture.test.mts` (reusing its `tree`, `ctx`, `probes` and `looser`):

```ts
test('never looser: a claimed child posture is no looser than the child or its parent, over every posture', () => {
  const children = [...everyPosture(tree)].filter((_, i) => i % 97 === 0)
  for (const parent of everyPosture(tree)) {
    for (const child of children) {
      const got = claimPosture(child, parent, ctx)
      for (const probe of probes(tree)) {
        const g = reach(got, probe.effect, ctx)
        assert.ok(!looser(g, reach(parent, probe.effect, ctx)), `${probe.label}: looser than the parent`)
        assert.ok(!looser(g, reach(child, probe.effect, ctx)), `${probe.label}: looser than the child`)
      }
      assert.ok(!looser(sandboxedOutcome(got), sandboxedOutcome(parent)))
      assert.ok(!looser(sandboxedOutcome(got), sandboxedOutcome(child)))
    }
  }
  for (const probe of probes(tree)) {
    for (const any of [...everyPosture(tree)].filter((_, i) => i % 53 === 0)) {
      assert.ok(!looser(reach(claimPosture(null, null, ctx), probe.effect, ctx), reach(any, probe.effect, ctx)), 'the strictest is no looser than anything')
    }
  }
})
```

with `claimPosture` added to its `../src/posture.mjs` import.

- [ ] **Step 4: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/native-children.mjs'`.

- [ ] **Step 5: Write the children tracker and the claim posture**

Create `src/claim-types.mts`:

```ts
import type { Posture } from './posture.mjs'

// A thread a claim may run on the adapter's Claude: a child codex spawned
// (its parent known or not) or a thread the adapter forwarded itself.
export interface ClaimThread {
  threadId: string
  parentThreadId: string | null
  parentCwd: string | null
  cwd: string | null
  model: string | null
  posture: Posture
}
```

Create `src/native-children.mts`:

```ts
// Children codex spawned itself (spawn_agent). Codex announces one through
// its parent's `collabAgentToolCall` items (tool `spawnAgent`): `item/started`
// with no receivers, then `item/completed` naming the child in
// `receiverThreadIds`, a few milliseconds before the child's own
// `turn/started`; `thread/started` may not come for a child at all
// (test/fixtures/codex-spawn-*.json). Both sources are read. A claim for a
// child can arrive before either, hence the waiters.
import type { UpstreamThreadInfo } from './codex-mux.mjs'
import { DEFAULT_POSTURE } from './posture.mjs'
import { asRecord } from './rpc-shape.mjs'

export interface NativeChild {
  threadId: string
  parentThreadId: string
  model: string | null
  cwd: string | null
}

const CAP = 1000

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// The posture a child is spawned with: its parent's, as the mux knows it at
// that moment (claimPosture narrows it later if the parent tightens).
export function inheritedInfo(child: NativeChild, parent: UpstreamThreadInfo | null): UpstreamThreadInfo {
  return { cwd: child.cwd ?? parent?.cwd ?? null, model: child.model, posture: parent?.posture ?? DEFAULT_POSTURE }
}

export class NativeChildren {
  private readonly children = new Map<string, NativeChild>()
  private readonly waiters = new Map<string, Array<(child: NativeChild) => void>>()

  private remember(child: NativeChild): NativeChild {
    const known = this.children.get(child.threadId)
    const merged = known ? { ...known, model: known.model ?? child.model, cwd: known.cwd ?? child.cwd } : child
    this.children.set(child.threadId, merged)
    if (this.children.size > CAP) this.children.delete(this.children.keys().next().value as string)
    for (const wake of this.waiters.get(child.threadId) ?? []) wake(merged)
    this.waiters.delete(child.threadId)
    return merged
  }

  observeItem(item: Record<string, unknown>): NativeChild[] {
    if (item.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent') return []
    const parentThreadId = text(item.senderThreadId)
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
    if (!parentThreadId) return []
    return receivers.flatMap((id) => {
      const threadId = text(id)
      return threadId ? [this.remember({ threadId, parentThreadId, model: text(item.model), cwd: null })] : []
    })
  }

  observeThread(thread: Record<string, unknown>): NativeChild | null {
    const threadId = text(thread.id)
    // The generated schema spells it `subagent`; ChatGPT.app 26.928 reads `subAgent`.
    const source = asRecord(thread.source)
    const spawn = asRecord(asRecord(source.subagent ?? source.subAgent).thread_spawn)
    const parentThreadId = text(thread.parentThreadId) ?? text(spawn.parent_thread_id)
    if (!threadId || !parentThreadId) return null
    return this.remember({ threadId, parentThreadId, model: text(thread.model), cwd: text(thread.cwd) })
  }

  get(threadId: string): NativeChild | null {
    return this.children.get(threadId) ?? null
  }

  waitFor(threadId: string, ms: number): Promise<NativeChild | null> {
    const known = this.get(threadId)
    if (known || ms <= 0) return Promise.resolve(known)
    return new Promise((resolve) => {
      const wake = (child: NativeChild) => {
        clearTimeout(timer)
        resolve(child)
      }
      const timer = setTimeout(() => {
        const rest = (this.waiters.get(threadId) ?? []).filter((w) => w !== wake)
        if (rest.length > 0) this.waiters.set(threadId, rest)
        else this.waiters.delete(threadId)
        resolve(null)
      }, ms)
      this.waiters.set(threadId, [...(this.waiters.get(threadId) ?? []), wake])
    })
  }

  forget(threadId: string): void {
    this.children.delete(threadId)
  }
}
```

In `src/posture.mts`, add:

```ts
// The posture a child whose parent is unknown gets: plan mode (reads and MCP
// calls only; nothing else runs) with everything else at its tightest. By
// `decide` it is no looser than any posture.
export const STRICTEST_POSTURE: Posture = {
  fileSystem: { kind: 'read-only' },
  network: false,
  approval: 'untrusted',
  reviewer: 'user',
  plan: true,
  trust: 'untrusted',
}

// Effects the comparison looks at: a read, writes inside and outside the
// cwd and to the temp roots, the network, anything unbounded, an MCP call,
// and a command inside the sandbox.
function comparisonEffects(ctx: PostureContext): Effect[] {
  return [
    { kind: 'read' },
    { kind: 'write', path: join(ctx.cwd, 'anyengine-probe') },
    { kind: 'write', path: join(ctx.tmpdir, 'anyengine-probe') },
    { kind: 'write', path: join(ctx.slashTmp, 'anyengine-probe') },
    { kind: 'write', path: join(dirname(ctx.cwd), 'anyengine-probe-outside') },
    { kind: 'net' },
    { kind: 'unbounded' },
    { kind: 'mcp' },
  ]
}

// Is `a` no looser than `b` on every effect (and on a sandboxed command)?
export function noLooser(a: Posture, b: Posture, ctx: PostureContext): boolean {
  if (outcomeRank(sandboxedOutcome(a)) > outcomeRank(sandboxedOutcome(b))) return false
  return comparisonEffects(ctx).every((effect) => outcomeRank(reach(a, effect, ctx)) <= outcomeRank(reach(b, effect, ctx)))
}

// A claimed child runs under the tighter of what it was spawned with and what
// its parent has now: a parent that tightened since tightens the child, one
// that loosened does not loosen it. When neither is no looser than the other,
// or the parent is unknown, the child gets the strictest posture.
export function claimPosture(child: Posture | null, parent: Posture | null, ctx: PostureContext): Posture {
  if (!parent || !child) return STRICTEST_POSTURE
  if (noLooser(parent, child, ctx)) return parent
  if (noLooser(child, parent, ctx)) return child
  return STRICTEST_POSTURE
}
```

(`dirname` and `join` from `node:path`; check that `reach`, `sandboxedOutcome` and `outcomeRank` are in the same module, which they are.)

- [ ] **Step 6: The runtime can release one thread's PTY**

In `src/types.mts`, add to `ClaudeRuntime`:

```ts
  // End a thread's warm engine process when no turn is running on it; the
  // next turn resumes its session cold. Optional: only warm runtimes have one.
  release?(threadId: string): Promise<void>
```

In `src/anyengine-runtime.mts`, below `interrupt`:

```ts
  async release(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId)
    if (session && !this.turns.has(threadId)) this.releaseSession(session, 'release')
  }
```

In `src/runtime-factory.mts`, in `SelectableRuntime` (the dispatcher), add, next to `interrupt`:

```ts
  // A thread's entry in activeRuntimeByThread goes when its turn ends, and a
  // release comes after that, so it goes to every runtime, as a stray
  // interrupt does; each ignores a thread it has no process for.
  async release(threadId: string): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.release?.(threadId)))
  }
```

and a test in `test/anyengine-runtime.test.mts` (or wherever the suite builds a `SelectableRuntime`): after a turn on a thread completed, `release(threadId)` reaches the runtime that ran it (a stub runtime registered for the type records the call).

- [ ] **Step 7: The mux learns children and answers claims**

In `src/codex-mux.mts`:

1. Import `{ NativeChildren, inheritedInfo }` from `./native-children.mjs`, `type { ClaimThread }` from `./claim-types.mjs`, and `claimPosture`, `postureContext` from `./posture.mjs`.
2. Add the field `private readonly children = new NativeChildren()`.
3. In `onUpstreamMessage`, in the `switch (message.method)`, add:

```ts
      case 'item/started':
      case 'item/completed':
        for (const child of this.children.observeItem(asRecord(params.item))) this.adoptChild(child)
        break
```

   and in `case 'thread/started'`, after `if (id) this.recordUpstreamThread(id, this.primaryPeer)`, add `const spawned = this.children.observeThread(asRecord(params.thread)); if (spawned) this.adoptChild(spawned)`.
4. In `case 'thread/deleted'`, add `this.children.forget(threadId)` next to `this.subagents.forget(threadId)`.
5. Add (after `upstreamThreadInfo`):

```ts
  // A child codex spawned: owned by the codex child, routed to its parent's
  // peer, and recorded with the posture it was spawned under.
  private adoptChild(child: NativeChild): void {
    this.recordUpstreamThread(child.threadId, this.peerForThread(child.parentThreadId))
    if (!this.upstreamThreads.has(child.threadId))
      this.upstreamThreads.set(child.threadId, inheritedInfo(child, this.upstreamThreads.get(child.parentThreadId) ?? null))
  }

  // What a claim needs to run a child-owned thread on a local engine.
  claimThread(threadId: string): ClaimThread | null {
    const info = this.upstreamThreads.get(threadId)
    const child = this.children.get(threadId)
    if (!child) return info ? { threadId, parentThreadId: null, parentCwd: info.cwd, cwd: info.cwd, model: info.model, posture: info.posture } : null
    const parent = this.upstreamThreads.get(child.parentThreadId) ?? null
    const cwd = parent?.cwd ?? info?.cwd ?? process.cwd()
    const posture = claimPosture(info?.posture ?? null, parent?.posture ?? null, postureContext(cwd))
    return { threadId, parentThreadId: child.parentThreadId, parentCwd: parent?.cwd ?? null, cwd: child.cwd ?? info?.cwd ?? null, model: child.model, posture }
  }

  async waitForClaimThread(threadId: string, ms: number): Promise<ClaimThread | null> {
    if (!this.claimThread(threadId)) await this.children.waitFor(threadId, ms)
    if (!this.claimThread(threadId)) await this.learnFromChild(threadId)
    return this.claimThread(threadId)
  }

  // Missed the announcement (the adapter restarted, or codex changed how it
  // announces a child): ask the codex child. A thread it knows, with a parent
  // this adapter knows, is adopted like an announced one; its posture is the
  // claim posture of that parent (claimPosture).
  private async learnFromChild(threadId: string): Promise<void> {
    if (!this.upstream.available) return
    try {
      const read = asRecord(await this.upstream.request('thread/read', { threadId, includeTurns: false }))
      const spawned = this.children.observeThread(asRecord(read.thread))
      if (spawned && this.knowsThread(spawned.parentThreadId)) this.adoptChild(spawned)
    } catch {
      // unknown to the child as well: the claim answers unknown
    }
  }

  // A thread of this adapter's codex child (Task 14's `owns` as parent).
  knowsThread(threadId: string): boolean {
    return this.upstreamThreads.has(threadId) || this.store.isNativeCodexThread(threadId)
  }
```

   (`NativeChild` type imported too.) A child whose parent was unknown when it was spawned has no recorded posture, so `claimPosture` gives it the strictest one, and so does a parent that is gone.

Run: `wc -l src/codex-mux.mts`
Expected: at or below the 1177 baseline (Step 1 freed about 40 lines).

- [ ] **Step 8: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/native-children.test.mjs dist/test/posture.test.mjs dist/test/codex-mux.test.mjs dist/test/anyengine-runtime.test.mjs`
Expected: PASS, `ℹ fail 0`, including `never looser: a claimed child posture is no looser than the child or its parent, over every posture`.

- [ ] **Step 9: Gates, commit**

Add to `src/AGENTS.md`: "- `native-children.mts` — children codex spawned, learned from the parent's `collabAgentToolCall` spawn items (and `thread/started` when codex sends one); `claim-types.mts` the thread a claim runs on."

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK (`File-size ratchet OK`, `codex-mux.mts` and `anyengine-runtime.mts` at or below their baselines), `ℹ fail 0`.

```bash
git add src/native-children.mts src/claim-types.mts src/posture.mts src/codex-mux.mts src/runtime-factory.mts \
  src/anyengine-runtime.mts src/types.mts test/fixtures/fake-codex-app-server.mjs test/native-children.test.mts \
  test/posture.test.mts test/anyengine-runtime.test.mts src/AGENTS.md scripts/size-baseline.json
git commit -m "feat: learn the children codex spawns, under a posture never looser than the parent's"
```

**Acceptance:** every recorded link shape (Task 12) is learned without a child `thread/started`; through the mux, a child gets its parent's posture, is narrowed when the parent tightens, and gets the strictest posture when its parent is unknown; the property test passes; a release reaches the runtime that ran the thread; the baselined files did not grow.

---
### Task 14: The adapter's claim socket runs Claude children on its own Claude

Decision D2, second half. The router cannot run agent mode; it asks the adapters. This task gives each adapter a private claim socket (`~/.anyengine/run/claim-<pid>.sock`, 0700 directory, 0600 socket) with three operations: `owns` (does this adapter know a thread; the router asks before any Claude turn, in either mode, decision D16), `claim` (run one turn of a child the adapter learned in Task 13 on the adapter's Claude runtime, the interactive PTY in the live configuration, under the claim posture, and stream progress and the answer back) and `ping`. The router side is Task 15.

**Files:**
- Create: `src/claim-protocol.mts`, `src/claim-turn.mts`, `src/claim-server.mts`
- Modify: `src/bridge-instructions.mts` (the one-line constants), `src/adapter.mts` (start and stop the claim server)
- Create: `test/claim.test.mts`; modify `test/posture.test.mts` (one property test)
- Modify: `docs/guide/router.md`, `src/AGENTS.md`

**Interfaces:**
- Consumes: Task 13 (`ClaimThread`, `NativeCodexMux.claimThread`, `waitForClaimThread`, `ClaudeRuntime.release`), `posture.mts` (`childStart`, `postureFields`, `postureSummary`), `util.mts` (`resolveClaudeModel`, `resolveClaudeEffort`, `debugLog`, `socketPathLimit`), `tool-display.mts` (`progressLine`), `anyengine-config.mts` (`loadConfig`, `enginePaths`), `mcp.mts` (`readMcpConfig`), `bridge-control.mts` (`BridgeControl.mergeMcpServers`).
- Produces:

```ts
// src/claim-protocol.mts
export interface OwnsRequest { op: 'owns'; threadId: string; as?: 'child' | 'parent' }
export interface ClaimRequest { op: 'claim'; threadId: string; parentThreadId: string | null; turnId: string | null; model: string; prompt: string; cwd: string | null; effort: string | null }
export type ClaimEvent =
  | { type: 'unknown' }
  | { type: 'accepted'; posture: string; cwd: string }
  | { type: 'progress'; text: string }
  | { type: 'text'; delta: string }
  | { type: 'done'; success: boolean; text: string }
  | { type: 'error'; message: string }
  | { type: 'pong'; pid: number; threads: number }
  | { type: 'owns'; owned: boolean }
export function claimSocketPath(runDir: string, pid?: number): string   // <runDir>/claim-<pid>.sock
export function liveClaimSockets(runDir: string): string[]
export function writeLine(socket: Socket, message: object): void
export function onLines(socket: Socket, handle: (message: Record<string, unknown>) => void): void

// src/claim-turn.mts
export function claimTurnContext(input: { thread: ClaimThread; request: ClaimRequest; sessionId: string | null; mcpServers: unknown }): RuntimeTurnContext
export function claimEventsFor(event: RuntimeEvent, cwd: string | null): ClaimEvent[]

// src/claim-server.mts
export interface ClaimHost { claimThread(threadId: string): ClaimThread | null; waitForClaimThread(threadId: string, ms: number): Promise<ClaimThread | null>; knowsThread(threadId: string): boolean; runtime: ClaudeRuntime; mcpServersFor(threadId: string): unknown }
export interface ClaimServerOptions { runDir: string; graceMs: number; idleReleaseMs: number }
export class ClaimServer { constructor(host: ClaimHost, options: ClaimServerOptions); readonly socketPath: string; start(): Promise<string>; stop(): Promise<void> }

// src/bridge-instructions.mts
export const BRIDGE_LINE: string       // Claude and Grok engines, claimed children
export const BRIDGE_LINE_GPT: string   // a GPT parent while native fan-out is not proven (Task 18)
```

- [ ] **Step 1: Write the failing tests**

Create `test/claim.test.mts`:

```ts
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { type ClaimEvent, liveClaimSockets, onLines, writeLine } from '../src/claim-protocol.mjs'
import { type ClaimHost, ClaimServer } from '../src/claim-server.mjs'
import type { ClaimThread } from '../src/claim-types.mjs'
import { DEFAULT_POSTURE, type Posture } from '../src/posture.mjs'
import type { ClaudeRuntime, RuntimeHandlers, RuntimeTurnContext } from '../src/types.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const servers: ClaimServer[] = []
after(async () => {
  for (const server of servers.splice(0)) await server.stop()
  await removeTempDirs()
})

const WORKSPACE: Posture = {
  fileSystem: { kind: 'workspace-write', writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  network: false,
  approval: 'on-request',
  reviewer: 'user',
  plan: false,
  trust: 'trusted',
}

class StubRuntime implements ClaudeRuntime {
  contexts: RuntimeTurnContext[] = []
  interrupted: string[] = []
  released: string[] = []
  decisions: string[] = []
  hold: Promise<void> | null = null
  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    this.contexts.push(context)
    await handlers.onEvent({ type: 'session', claudeSessionId: context.claudeSessionId ?? 'sess-1' })
    await handlers.onEvent({ type: 'tool_use', toolUseId: 'u1', toolName: 'Read', input: { file_path: `${context.cwd}/a.ts` } })
    const decision = await handlers.onPermissionRequest({ type: 'permission_request', requestId: 'r', toolUseId: 'u2', toolName: 'Bash', input: { command: 'rm -rf /' } })
    this.decisions.push(decision.decision)
    if (this.hold) await this.hold
    await handlers.onEvent({ type: 'text_delta', delta: 'PONG' })
    await handlers.onEvent({ type: 'completed', success: true, claudeSessionId: 'sess-1' })
  }
  async steer(): Promise<void> {}
  async interrupt(threadId: string): Promise<void> {
    this.interrupted.push(threadId)
  }
  async stop(): Promise<void> {}
  async release(threadId: string): Promise<void> {
    this.released.push(threadId)
  }
}

async function serve(threads: Map<string, ClaimThread>, runtime: StubRuntime, options: { graceMs?: number; idleReleaseMs?: number } = {}) {
  const runDir = join(await tempDir('ae-cl-'), 'run')
  const host: ClaimHost = {
    claimThread: (id) => threads.get(id) ?? null,
    knowsThread: (id) => id === 'p' || threads.has(id),
    waitForClaimThread: async (id, ms) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const found = threads.get(id)
        if (found) return found
        await new Promise((ok) => setTimeout(ok, 20))
      }
      return threads.get(id) ?? null
    },
    runtime,
    mcpServersFor: (id) => ({ anyengine: { thread: id } }),
  }
  const server = new ClaimServer(host, { runDir, graceMs: options.graceMs ?? 200, idleReleaseMs: options.idleReleaseMs ?? 60_000 })
  servers.push(server)
  const path = await server.start()
  return { server, path, runDir }
}

function claim(path: string, threadId: string, extra: Record<string, unknown> = {}): Promise<ClaimEvent[]> {
  return new Promise((ok, fail) => {
    const socket = net.connect(path)
    const events: ClaimEvent[] = []
    socket.on('error', fail)
    onLines(socket, (message) => events.push(message as ClaimEvent))
    socket.on('close', () => ok(events))
    writeLine(socket, { op: 'claim', threadId, parentThreadId: 'parent', turnId: 'turn-1', model: 'opus', prompt: 'Reply PONG', cwd: null, effort: 'low', ...extra })
  })
}

test('claim: a known child runs under its parent posture and cwd, and streams progress and the answer', async () => {
  const cwd = await tempDir('anyengine-claim-cwd-')
  const runtime = new StubRuntime()
  const threads = new Map([['child-1', { threadId: 'child-1', parentThreadId: 'parent', parentCwd: cwd, cwd, model: 'opus', posture: WORKSPACE }]])
  const { path } = await serve(threads, runtime)
  const events = await claim(path, 'child-1')
  assert.equal(events[0]?.type, 'accepted')
  assert.ok(events.some((e) => e.type === 'progress' && e.text === 'Read `a.ts`'))
  assert.deepEqual(events.at(-1), { type: 'done', success: true, text: 'PONG' })
  const context = runtime.contexts[0]
  assert.ok(context)
  assert.deepEqual(context.posture, WORKSPACE)
  assert.equal(context.cwd, cwd)
  assert.equal(context.allowedTools, null)
  assert.equal(context.threadId, 'child-1')
  assert.equal((context.systemPromptAddendum ?? '').split('\n').length, 1)
  assert.deepEqual(context.mcpServers, { anyengine: { thread: 'child-1' } })
  assert.deepEqual(runtime.decisions, ['decline'])
})

test('claim: a follow-up on the same child resumes its Claude session', async () => {
  const runtime = new StubRuntime()
  const threads = new Map([['child-2', { threadId: 'child-2', parentThreadId: 'parent', parentCwd: null, cwd: null, model: 'opus', posture: DEFAULT_POSTURE }]])
  const { path } = await serve(threads, runtime)
  await claim(path, 'child-2')
  await claim(path, 'child-2')
  assert.equal(runtime.contexts[1]?.claudeSessionId, 'sess-1')
})

test('claim: a claim waits for the thread to appear, then answers unknown after the grace period', async () => {
  const runtime = new StubRuntime()
  const threads = new Map<string, ClaimThread>()
  const { path } = await serve(threads, runtime, { graceMs: 300 })
  setTimeout(() => threads.set('late', { threadId: 'late', parentThreadId: 'p', parentCwd: null, cwd: null, model: 'opus', posture: DEFAULT_POSTURE }), 100)
  assert.equal((await claim(path, 'late'))[0]?.type, 'accepted')
  assert.deepEqual(await claim(path, 'never'), [{ type: 'unknown' }])
})

test('claim: a disconnect interrupts the claimed turn', async () => {
  const runtime = new StubRuntime()
  let release: () => void = () => {}
  runtime.hold = new Promise((ok) => {
    release = ok
  })
  const threads = new Map([['child-3', { threadId: 'child-3', parentThreadId: 'p', parentCwd: null, cwd: null, model: 'opus', posture: DEFAULT_POSTURE }]])
  const { path } = await serve(threads, runtime)
  const socket = net.connect(path)
  onLines(socket, (message) => {
    if (message.type === 'accepted') setTimeout(() => socket.destroy(), 50)
  })
  writeLine(socket, { op: 'claim', threadId: 'child-3', parentThreadId: 'p', turnId: null, model: 'opus', prompt: 'x', cwd: null, effort: null })
  await new Promise((ok) => setTimeout(ok, 300))
  release()
  assert.deepEqual(runtime.interrupted, ['child-3'])
})

test('claim: an idle claimed child releases its PTY; a cwd outside the parent roots is refused', async () => {
  const runtime = new StubRuntime()
  const cwd = await tempDir('anyengine-claim-cwd-')
  const threads = new Map([['child-4', { threadId: 'child-4', parentThreadId: 'p', parentCwd: cwd, cwd, model: 'opus', posture: WORKSPACE }]])
  const { path } = await serve(threads, runtime, { idleReleaseMs: 100 })
  await claim(path, 'child-4')
  await new Promise((ok) => setTimeout(ok, 250))
  assert.deepEqual(runtime.released, ['child-4'])
  const refused = await claim(path, 'child-4', { cwd: '/' })
  assert.equal(refused.at(-1)?.type, 'error')
})

test('claim: the socket is private, listed while its adapter lives, and gone after stop', async () => {
  const { server, path, runDir } = await serve(new Map(), new StubRuntime())
  assert.equal(statSync(runDir).mode & 0o777, 0o700)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(liveClaimSockets(runDir), [path])
  await server.stop()
  assert.deepEqual(liveClaimSockets(runDir), [])
})

test('claim: `owns` answers whether this adapter knows a thread, without running anything', async () => {
  const runtime = new StubRuntime()
  const threads = new Map([['mine', { threadId: 'mine', parentThreadId: 'p', parentCwd: null, cwd: null, model: 'opus', posture: DEFAULT_POSTURE }]])
  const { path } = await serve(threads, runtime, { graceMs: 50 })
  const ask = (threadId: string) =>
    new Promise<ClaimEvent[]>((ok) => {
      const socket = net.connect(path)
      const events: ClaimEvent[] = []
      onLines(socket, (m) => events.push(m as ClaimEvent))
      socket.on('close', () => ok(events))
      writeLine(socket, { op: 'owns', threadId })
    })
  assert.deepEqual(await ask('mine'), [{ type: 'owns', owned: true }])
  assert.deepEqual(await ask('theirs'), [{ type: 'owns', owned: false }])
  assert.equal(runtime.contexts.length, 0)
  const asParent = (threadId: string) =>
    new Promise<ClaimEvent[]>((ok) => {
      const socket = net.connect(path)
      const events: ClaimEvent[] = []
      onLines(socket, (m) => events.push(m as ClaimEvent))
      socket.on('close', () => ok(events))
      writeLine(socket, { op: 'owns', threadId, as: 'parent' })
    })
  assert.deepEqual(await asParent('p'), [{ type: 'owns', owned: true }], 'p is a thread of this adapter’s codex child')
  assert.deepEqual(await asParent('elsewhere'), [{ type: 'owns', owned: false }])
})
```

Append to `test/posture.test.mts` (it already has `tree`, `ctx`, `CLAUDE_TOOLS` and `looser`):

```ts
test('never looser: a claimed Claude child (native spawn) under a Codex parent, over every posture', () => {
  for (const parent of everyPosture(tree)) {
    const context = claimTurnContext({
      thread: { threadId: 't', parentThreadId: 'p', parentCwd: ctx.cwd, cwd: ctx.cwd, model: 'opus', posture: parent },
      request: { op: 'claim', threadId: 't', parentThreadId: 'p', turnId: 'u', model: 'opus', prompt: 'x', cwd: null, effort: null },
      sessionId: null,
      mcpServers: null,
    })
    assert.deepEqual(contextPosture(context), parent)
    assert.equal(context.allowedTools, null)
    for (const sandboxExec of [false, true]) {
      const launch = toClaudeLaunch(contextPosture(context), { sandboxExec })
      for (const { tool, input, effect } of CLAUDE_TOOLS) {
        let got: Outcome = launch.disallowedTools.includes(tool)
          ? 'deny'
          : decideClaudeTool(launch.relayPosture, tool, input, ctx)
        // A claimed child has no approval card (decision D3): an ask is refused.
        if (got === 'ask') got = 'deny'
        const bound: Outcome =
          effect === 'inert' ? 'allow' : effect === 'sandboxed' ? sandboxedOutcome(parent) : reach(parent, effect, ctx)
        assert.ok(!looser(got, bound), `${JSON.stringify(parent)} ${tool}: ${got} > ${bound}`)
      }
    }
  }
})
```

with `import { claimTurnContext } from '../src/claim-turn.mjs'` and `contextPosture` added to its `../src/posture.mjs` import.

- [ ] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/claim-protocol.mjs'`.

- [ ] **Step 3: Write the protocol**

Create `src/claim-protocol.mts`:

```ts
// The claim socket between the router and an adapter (decision D2). One unix
// socket per adapter in ~/.anyengine/run/ (0700), named after the adapter's
// pid, so the router can find every live adapter and skip dead ones. One
// request per connection, newline-delimited JSON both ways; the connection
// closing early means "stop": the adapter interrupts the turn.
import { readdirSync } from 'node:fs'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import readline from 'node:readline'

// `owns` asks whether this adapter knows a thread (the router asks before any
// Claude turn, in either mode); `claim` runs one.
export interface OwnsRequest {
  op: 'owns'
  threadId: string
  // 'child' (the default): a child this adapter can claim. 'parent': a thread
  // of this adapter's codex child (the router asks before it counts an
  // unclaimed child as evidence, Task 15).
  as?: 'child' | 'parent'
}

export interface ClaimRequest {
  op: 'claim'
  threadId: string
  parentThreadId: string | null
  turnId: string | null
  model: string
  prompt: string
  cwd: string | null
  effort: string | null
}

export type ClaimEvent =
  | { type: 'unknown' }
  | { type: 'accepted'; posture: string; cwd: string }
  | { type: 'progress'; text: string }
  | { type: 'text'; delta: string }
  | { type: 'done'; success: boolean; text: string }
  | { type: 'error'; message: string }
  | { type: 'pong'; pid: number; threads: number }
  | { type: 'owns'; owned: boolean }

export function claimSocketPath(runDir: string, pid: number = process.pid): string {
  return join(runDir, `claim-${pid}.sock`)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function liveClaimSockets(runDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(runDir)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const match = /^claim-(\d+)\.sock$/.exec(name)
    return match && alive(Number(match[1])) ? [join(runDir, name)] : []
  })
}

export function writeLine(socket: Socket, message: object): void {
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`)
}

export function onLines(socket: Socket, handle: (message: Record<string, unknown>) => void): void {
  readline.createInterface({ input: socket }).on('line', (line) => {
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object') handle(value as Record<string, unknown>)
    } catch {}
  })
}
```

- [ ] **Step 4: Write the claimed turn**

In `src/bridge-instructions.mts`, add below `BRIDGE_INSTRUCTIONS_HEADING`:

```ts
// The single line of standing instruction AnyEngine adds (spec 3: "Native
// mode injects nothing. The bridge fallback injects one line."). BRIDGE_LINE
// goes to Claude and Grok threads and to claimed children; BRIDGE_LINE_GPT to
// a GPT thread whose native spawn_agent cannot start Claude (Task 18).
export const BRIDGE_LINE =
  'For sub-agents or sessions on another engine (Claude, GPT), use the anyengine tools spawn_subagents (parallel, one task and model per agent) or spawn_session.'
export const BRIDGE_LINE_GPT =
  "For Claude sub-agents use the anyengine spawn_subagents tool (one task and model per agent); Codex's own spawn_agent cannot start Claude in this session."
```

Create `src/claim-turn.mts`:

```ts
// One claimed turn (decision D2): the RuntimeTurnContext a native child's
// task runs with on the adapter's Claude runtime, and the runtime's events as
// claim events. The posture is the thread's own, which for a spawned child is
// the claim posture (src/posture.mts claimPosture), and the cwd must be the
// parent's cwd or one of its roots (childStart). No ANYENGINE_ALLOWED_TOOLS: nothing
// turns an ask into an allow here, and an ask is declined (decision D3).
import { BRIDGE_LINE } from './bridge-instructions.mjs'
import type { ClaimEvent, ClaimRequest } from './claim-protocol.mjs'
import type { ClaimThread } from './claim-types.mjs'
import { childStart, postureFields } from './posture.mjs'
import { progressLine } from './tool-display.mjs'
import type { RuntimeEvent, RuntimeTurnContext } from './types.mjs'
import { resolveClaudeEffort, resolveClaudeModel } from './util.mjs'

export function claimTurnContext(input: {
  thread: ClaimThread
  request: ClaimRequest
  sessionId: string | null
  mcpServers: unknown
}): RuntimeTurnContext {
  const { thread, request } = input
  // The workspace root is the parent's cwd: a child may run in it or in one of
  // the parent's roots, never elsewhere.
  const root = thread.parentCwd ?? thread.cwd
  const start = childStart({ posture: thread.posture, cwd: root }, request.cwd ?? thread.cwd ?? undefined)
  return {
    threadId: thread.threadId,
    turnId: request.turnId ?? `claim-${Date.now()}`,
    purpose: 'normal',
    prompt: request.prompt,
    cwd: start.cwd,
    runtimeType: null,
    model: resolveClaudeModel(request.model),
    effort: resolveClaudeEffort(request.effort),
    claudeSessionId: input.sessionId,
    forkSession: false,
    mcpServers: input.mcpServers,
    allowedTools: null,
    addDirs: [],
    enableFileCheckpointing: false,
    outputFormat: null,
    ...postureFields(start.posture),
    systemPromptAddendum: BRIDGE_LINE,
    planMode: start.posture.plan,
    imageInputs: [],
  }
}

export function claimEventsFor(event: RuntimeEvent, cwd: string | null): ClaimEvent[] {
  switch (event.type) {
    case 'text_delta':
      return event.delta ? [{ type: 'text', delta: event.delta }] : []
    case 'tool_use':
      return [{ type: 'progress', text: progressLine(event.toolName, event.input, cwd) }]
    case 'notice':
      return event.level === 'info' ? [] : [{ type: 'progress', text: event.message.slice(0, 160) }]
    case 'error':
      return [{ type: 'error', message: event.message }]
    default:
      return []
  }
}
```

- [ ] **Step 5: Write the claim server**

A unix socket path is limited to about 104 bytes on macOS (`socketPathLimit()` in `src/util.mts`). The live path, `~/.anyengine/run/claim-<pid>.sock`, is short; the hermetic root on T7 is not, which is why every suite that gives an adapter an `ANYENGINE_ROOT` uses a short temp prefix (`ae-...`). `start()` refuses a path over the limit with a message naming it, rather than failing inside `listen`.

Create `src/claim-server.mts`:

```ts
// Adapter side of the claim socket (decision D2). The router asks every live
// adapter to run a Claude thread it cannot run itself; the adapter that knows
// the thread (it saw the child's thread/started, or forwarded its thread/start)
// runs it on its own Claude runtime and streams claim events back. A claim for
// a thread not seen yet waits up to `graceMs` for its announcement. A claimed
// thread's warm PTY is released after `idleReleaseMs` without a turn; its
// Claude session id is kept, so a later follow-up resumes cold.
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import net, { type Socket } from 'node:net'
import {
  type ClaimRequest,
  claimSocketPath,
  onLines,
  writeLine,
} from './claim-protocol.mjs'
import { claimEventsFor, claimTurnContext } from './claim-turn.mjs'
import type { ClaimThread } from './claim-types.mjs'
import { postureSummary } from './posture.mjs'
import type { ClaudeRuntime } from './types.mjs'
import { debugLog, socketPathLimit } from './util.mjs'

export interface ClaimHost {
  claimThread(threadId: string): ClaimThread | null
  waitForClaimThread(threadId: string, ms: number): Promise<ClaimThread | null>
  runtime: ClaudeRuntime
  mcpServersFor(threadId: string): unknown
}

export interface ClaimServerOptions {
  runDir: string
  graceMs: number
  idleReleaseMs: number
}

interface Session {
  sessionId: string | null
  busy: boolean
  timer: NodeJS.Timeout | null
}

const SESSION_CAP = 500

function isClaimRequest(message: Record<string, unknown>): message is ClaimRequest & Record<string, unknown> {
  return message.op === 'claim' && typeof message.threadId === 'string' && typeof message.model === 'string' && typeof message.prompt === 'string'
}

export class ClaimServer {
  readonly socketPath: string
  private readonly host: ClaimHost
  private readonly options: ClaimServerOptions
  private readonly sessions = new Map<string, Session>()
  private server: net.Server | null = null

  constructor(host: ClaimHost, options: ClaimServerOptions) {
    this.host = host
    this.options = options
    this.socketPath = claimSocketPath(options.runDir)
  }

  async start(): Promise<string> {
    if (this.socketPath.length > socketPathLimit())
      throw new Error(`claim socket path is ${this.socketPath.length} bytes, over the ${socketPathLimit()}-byte limit: ${this.socketPath}`)
    mkdirSync(this.options.runDir, { recursive: true, mode: 0o700 })
    chmodSync(this.options.runDir, 0o700)
    rmSync(this.socketPath, { force: true })
    const server = net.createServer((socket) => this.accept(socket))
    await new Promise<void>((ok, fail) => {
      server.once('error', fail)
      server.listen(this.socketPath, () => ok())
    })
    chmodSync(this.socketPath, 0o600)
    this.server = server
    debugLog('claim.listen', { socketPath: this.socketPath })
    return this.socketPath
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    for (const [threadId, session] of this.sessions) {
      if (session.timer) clearTimeout(session.timer)
      void this.host.runtime.release?.(threadId)
    }
    this.sessions.clear()
    if (server) await new Promise<void>((ok) => server.close(() => ok()))
    rmSync(this.socketPath, { force: true })
  }

  private accept(socket: Socket): void {
    socket.on('error', () => {})
    onLines(socket, (message) => {
      if (message.op === 'ping') {
        writeLine(socket, { type: 'pong', pid: process.pid, threads: this.sessions.size })
        socket.end()
        return
      }
      if (message.op === 'owns' && typeof message.threadId === 'string') {
        const threadId = message.threadId
        const answer =
          message.as === 'parent'
            ? Promise.resolve(this.host.knowsThread(threadId))
            : this.host.waitForClaimThread(threadId, this.options.graceMs).then((thread) => thread !== null)
        void answer.then((owned) => {
          writeLine(socket, { type: 'owns', owned })
          socket.end()
        })
        return
      }
      if (!isClaimRequest(message)) {
        writeLine(socket, { type: 'error', message: 'not a claim request' })
        socket.end()
        return
      }
      void this.claim(socket, message)
    })
  }

  private session(threadId: string): Session {
    let session = this.sessions.get(threadId)
    if (!session) {
      session = { sessionId: null, busy: false, timer: null }
      this.sessions.set(threadId, session)
      if (this.sessions.size > SESSION_CAP) {
        const oldest = [...this.sessions.entries()].find(([, s]) => !s.busy)
        if (oldest) this.forgetSession(oldest[0], oldest[1])
      }
    }
    return session
  }

  private forgetSession(threadId: string, session: Session): void {
    if (session.timer) clearTimeout(session.timer)
    this.sessions.delete(threadId)
    void this.host.runtime.release?.(threadId)
  }

  private armRelease(threadId: string, session: Session): void {
    if (session.timer) clearTimeout(session.timer)
    session.timer = setTimeout(() => {
      session.timer = null
      if (session.busy) return
      debugLog('claim.released', { threadId })
      void this.host.runtime.release?.(threadId)
    }, this.options.idleReleaseMs)
    session.timer.unref()
  }

  private async claim(socket: Socket, request: ClaimRequest): Promise<void> {
    const thread = await this.host.waitForClaimThread(request.threadId, this.options.graceMs)
    // The router took another adapter's answer meanwhile: never run a turn nobody reads.
    if (socket.destroyed) return
    if (!thread) {
      debugLog('claim.unknown', { threadId: request.threadId })
      writeLine(socket, { type: 'unknown' })
      socket.end()
      return
    }
    const session = this.session(thread.threadId)
    if (session.busy) {
      writeLine(socket, { type: 'error', message: 'a turn is already running on this thread' })
      socket.end()
      return
    }
    let context: ReturnType<typeof claimTurnContext>
    try {
      context = claimTurnContext({ thread, request, sessionId: session.sessionId, mcpServers: this.host.mcpServersFor(thread.threadId) })
    } catch (error) {
      writeLine(socket, { type: 'error', message: error instanceof Error ? error.message : String(error) })
      socket.end()
      return
    }
    await this.run(socket, thread, session, context)
  }

  private async run(socket: Socket, thread: ClaimThread, session: Session, context: ReturnType<typeof claimTurnContext>): Promise<void> {
    const posture = context.posture ?? thread.posture
    writeLine(socket, { type: 'accepted', posture: postureSummary(posture), cwd: context.cwd })
    debugLog('claim.accepted', { threadId: thread.threadId, parentThreadId: thread.parentThreadId, model: context.model, posture: postureSummary(posture) })
    session.busy = true
    if (session.timer) clearTimeout(session.timer)
    const started = Date.now()
    let text = ''
    let success = false
    const onClose = () => {
      if (session.busy) void this.host.runtime.interrupt(thread.threadId)
    }
    socket.once('close', onClose)
    try {
      await this.host.runtime.runTurn(context, {
        onEvent: (event) => {
          if (event.type === 'session') session.sessionId = event.claudeSessionId
          if (event.type === 'text_delta') text += event.delta
          if (event.type === 'completed') {
            success = event.success
            if (event.claudeSessionId) session.sessionId = event.claudeSessionId
            if (!text && event.result) text = event.result
          }
          for (const out of claimEventsFor(event, context.cwd)) writeLine(socket, out)
        },
        onPermissionRequest: async () => ({ decision: 'decline' }),
        onUserInputRequest: async (event) => ({
          answers: Object.fromEntries(event.questions.map((q) => [q.id, { answers: [] }])),
        }),
      })
      writeLine(socket, { type: 'done', success, text })
    } catch (error) {
      writeLine(socket, { type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      session.busy = false
      socket.off('close', onClose)
      socket.end()
      debugLog('claim.done', { threadId: thread.threadId, success, ms: Date.now() - started })
      this.armRelease(thread.threadId, session)
    }
  }
}
```

(`UserInputAnswers` is the type `onUserInputRequest` returns; if `{ answers: [] }` does not satisfy it, use the shape `server.mts` returns for compaction turns, which is the same expression.)

- [ ] **Step 6: Start the claim server with the adapter**

In `src/adapter.mts`:

1. Capture the mux: `const mux = nativeCodexBinary ? server.attachNativeCodex({ ... }) : null` (same arguments as today), replacing the `if (nativeCodexBinary) { server.attachNativeCodex(...) }` block.
2. After the bridge has started (after the `if (bridge) { try { await bridge.start() } ... }` block), add:

```ts
  // Agent-mode Claude children codex spawned (docs/guide/router.md): the
  // router hands them to whichever adapter saw them start.
  const claims = mux && bridge ? await startClaims(mux, runtime, bridge) : null
```

3. In `shutdown`, before `await server.stop()`, add `await claims?.stop()`.
4. Add at the bottom of the file:

```ts
async function startClaims(
  mux: NativeCodexMux,
  runtime: ClaudeRuntime,
  bridge: BridgeControl,
): Promise<ClaimServer | null> {
  const config = loadConfig()
  const claims = new ClaimServer(
    {
      claimThread: (id) => mux.claimThread(id),
      waitForClaimThread: (id, ms) => mux.waitForClaimThread(id, ms),
      knowsThread: (id) => mux.knowsThread(id),
      runtime,
      mcpServersFor: (id) => bridge.mergeMcpServers(id, readMcpConfig().sdkValue),
    },
    {
      runDir: enginePaths().run,
      graceMs: config.claims.graceMs,
      idleReleaseMs: config.claims.idleReleaseMinutes * 60_000,
    },
  )
  try {
    await claims.start()
    return claims
  } catch (error) {
    process.stderr.write(`[anyengine] claim socket disabled: ${error instanceof Error ? error.message : String(error)}\n`)
    return null
  }
}
```

with the imports (`ClaimServer`, `NativeCodexMux` type, `ClaudeRuntime` type, `loadConfig`, `enginePaths`, `readMcpConfig`).

- [ ] **Step 7: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/claim.test.mjs dist/test/posture.test.mjs`
Expected: PASS, `ℹ fail 0`, including `never looser: a claimed Claude child (native spawn) under a Codex parent, over every posture`.

Run: `T7 npm test`
Expected: `ℹ fail 0` (adapter suites start a claim socket only when a native child and the bridge are attached; they give it a short `ANYENGINE_ROOT` or none, landing in the hermetic home).

- [ ] **Step 8: Docs, gates, commit**

Append to `docs/guide/router.md`:

````markdown
## Claude children in agent mode (the claim socket)

In agent mode (the default, `anyengine mode codex-claude agent`) the router
does not run Claude. When a GPT thread's `spawn_agent(model="opus")` starts a
child, codex sends that child's requests to the router, which asks every live
adapter over `~/.anyengine/run/claim-<pid>.sock` whether it knows the thread.
The adapter that saw the child start runs the task on its own Claude runtime
(the interactive Claude Code PTY when `ANYENGINE_RUNTIME_TYPE=anyengine`),
under the parent thread's posture: the same sandbox, shell through the real
child's `command/exec`, and no approval prompts: a tool call the posture would
ask about is refused with a reason. Progress lines and the answer come back as
the child's reply, so the parent receives them through Codex's own agent
tools. An idle claimed child's PTY is released after
`claims.idleReleaseMinutes`.
````

Add to `src/AGENTS.md`: "- `claim-server.mts`, `claim-turn.mts`, `claim-protocol.mts` — agent-mode Claude children codex spawned: the adapter's claim socket (`owns`, `claim`, `ping`), the turn context under the claim posture, the NDJSON protocol."

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/claim-protocol.mts src/claim-turn.mts src/claim-server.mts src/bridge-instructions.mts src/adapter.mts \
  test/claim.test.mts test/posture.test.mts docs/guide/router.md src/AGENTS.md
git commit -m "feat: let the adapter claim Claude children codex spawns over a private socket"
```

**Acceptance:** the claim tests and the property test pass; `owns` answers without running anything; a claimed turn's context carries exactly the claim posture, the parent's cwd as its root, no pre-approved tools and one line of addendum; a connection that closed while the claim waited never starts a turn.

---
### Task 15: Router runs Claude turns in agent mode through the claim socket

The router half of decision D2. Before any Claude turn, in either mode, the router asks the adapters whether one of them owns the thread (`owns`, decision D16); no owner, no Claude turn, and the answer counts toward the fan-out monitor's unclaimed streak (Task 9, H1). In agent mode the turn is then offered to every live adapter; the one that accepts streams it back, and the router writes it as the child model's Responses stream (progress as reasoning summaries, the answer as the message, a keep-alive every 15 s so Codex's stream idle timeout never fires). A claim counts as claimed only when the adapter sends `done`; a connection that closes first is a failure. The task ends with an end-to-end test proven against Task 12's recording: a real adapter process whose fake codex child spawns a Claude child the way codex 0.159 announces one (collab items, no child `thread/started`), the router, and a Claude answer arriving through the claim for a request shaped like the recorded child request.

**Files:**
- Create: `src/router-claim-client.mts`, `src/router-claude.mts`
- Modify: `src/router-hooks.mts`
- Create: `test/router-agent.test.mts`

**Interfaces:**
- Consumes: `claim-protocol.mts` (`ClaimRequest`, `ClaimEvent`, `liveClaimSockets`, `writeLine`, `onLines`; Task 14), `claim-server.mts` (`ClaimServer`, `ClaimHost`; Task 14), `claim-types.mts` (`ClaimThread`; Task 13), `router-turns.mts` (`ClaudeTurns`, `ClaudeTurnRequest`, `claudeHttpHook`; Task 11), `router-fanout.mts` (`FanoutMonitor.observeClaim`; Task 9), `responses-stream.mts`, `codex-input.mts` (`parseCodexRequest`, `claudePromptText`, `makeMarker`), `codex-wire.mts` (`threadIdOfRequest`, `turnIdOfRequest`, `parentThreadIdOfRequest`), `anyengine-config.mts` (`enginePaths`), Task 12's recordings, Task 13's `FAKE_CODEX_SPAWN_CHILD`.
- Produces:

```ts
// src/router-claim-client.mts
export type ClaimOutcome = 'claimed' | 'unknown' | 'failed'   // claimed = `done` received
export function adapterOwns(runDir: string, threadId: string, signal: AbortSignal, timeoutMs?: number, as?: 'child' | 'parent'): Promise<boolean>
export function claimOnAdapters(runDir: string, request: ClaimRequest, onEvent: (event: ClaimEvent) => void, signal: AbortSignal): Promise<ClaimOutcome>

// src/router-claude.mts
export const UNCLAIMED_MESSAGE: string
export class AgentClaudeTurns implements ClaudeTurns {
  readonly mode: 'agent'
  constructor(runDir: string, keepAliveMs?: number)
  run(ctx: RouterContext, request: ClaudeTurnRequest): Promise<void>
}
// The ownership gate every Claude turn passes, in either mode.
export class OwnedClaudeTurns implements ClaudeTurns {
  constructor(inner: ClaudeTurns, runDir: string, onClaim?: (claimed: boolean) => void)
  readonly mode: ClaudeTurns['mode']
  run(ctx: RouterContext, request: ClaudeTurnRequest): Promise<void>
}
export function pickClaudeTurns(ctx: RouterContext, available: { agent: ClaudeTurns | null; model: ClaudeTurns | null }): ClaudeTurns | null
```

- [ ] **Step 1: Write the failing tests**

Create `test/router-agent.test.mts`:

```ts
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { enginePaths } from '../src/anyengine-config.mjs'
import { claimSocketPath, onLines, writeLine } from '../src/claim-protocol.mjs'
import { type ClaimHost, ClaimServer } from '../src/claim-server.mjs'
import type { ClaimThread } from '../src/claim-types.mjs'
import { DEFAULT_POSTURE } from '../src/posture.mjs'
import { AgentClaudeTurns, OwnedClaudeTurns, UNCLAIMED_MESSAGE } from '../src/router-claude.mjs'
import { startRouter } from '../src/router-server.mjs'
import { type ClaudeTurns, claudeHttpHook } from '../src/router-turns.mjs'
import type { ClaudeRuntime, RuntimeHandlers, RuntimeTurnContext } from '../src/types.mjs'
import { launchAdapter, type Wire } from './helpers/adapter-client.mjs'
import { killChildren } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const closers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await killChildren()
  await removeTempDirs()
})

class SlowRuntime implements ClaudeRuntime {
  seen: string[] = []
  interrupted: string[] = []
  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    this.seen.push(context.threadId)
    await handlers.onEvent({ type: 'tool_use', toolUseId: 'u', toolName: 'Bash', input: { command: 'ls' } })
    await new Promise((ok) => setTimeout(ok, 150))
    await handlers.onEvent({ type: 'text_delta', delta: `PONG ${context.threadId}` })
    await handlers.onEvent({ type: 'completed', success: true })
  }
  async steer(): Promise<void> {}
  async interrupt(threadId: string): Promise<void> {
    this.interrupted.push(threadId)
  }
  async stop(): Promise<void> {}
}

async function routerWith(root: string, turns: ClaudeTurns | null = null, claims: boolean[] = []) {
  const runDir = enginePaths(root).run
  const inner = turns ?? new AgentClaudeTurns(runDir, 50)
  const gated = new OwnedClaudeTurns(inner, runDir, (claimed) => claims.push(claimed))
  const router = await startRouter({ root, port: 0, upstream: 'http://127.0.0.1:9/backend-api/codex', hooks: { claudeHttp: claudeHttpHook(() => gated) } })
  closers.push(() => router.close(0))
  return router
}

const agentBody = (task: string) => ({
  model: 'opus',
  input: [
    { type: 'additional_tools', tools: [] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: task }] },
  ],
})

async function childRequest(
  base: string,
  headers: Record<string, string>,
  init: RequestInit = {},
  task = 'Reply PONG',
): Promise<string> {
  const res = await fetch(`${base}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(agentBody(task)),
    ...init,
  })
  return res.text()
}
const plainHeaders = (threadId: string) => ({ 'thread-id': threadId, 'x-codex-parent-thread-id': 'parent' })

async function claimServer(root: string, threads: Map<string, ClaimThread>, runtime: ClaudeRuntime, parents: Set<string> = new Set(['parent'])) {
  const host: ClaimHost = {
    claimThread: (id) => threads.get(id) ?? null,
    waitForClaimThread: async (id) => threads.get(id) ?? null,
    knowsThread: (id) => parents.has(id) || threads.has(id),
    runtime,
    mcpServersFor: () => null,
  }
  const server = new ClaimServer(host, { runDir: enginePaths(root).run, graceMs: 0, idleReleaseMs: 60_000 })
  await server.start()
  closers.push(() => server.stop())
}

const child = (id: string): [string, ClaimThread] => [
  id,
  { threadId: id, parentThreadId: 'parent', parentCwd: null, cwd: null, model: 'opus', posture: DEFAULT_POSTURE },
]

test('agent mode: a claimed child streams progress, keep-alives and the answer, then a marker', async () => {
  const root = await tempDir('ae-ag-')
  await claimServer(root, new Map([child('c1')]), new SlowRuntime())
  const claims: boolean[] = []
  const router = await routerWith(root, null, claims)
  const sse = await childRequest(router.baseUrl, plainHeaders('c1'))
  assert.match(sse, /response\.reasoning_summary_text\.delta[\s\S]*Ran `ls`/)
  assert.match(sse, /"delta":"PONG c1"/)
  assert.match(sse, /"type":"response\.in_progress"[\s\S]*"type":"response\.in_progress"/)
  assert.match(sse, /ae:v1:c1:/)
  assert.match(sse, /response\.completed/)
  assert.deepEqual(claims, [true])
})

test('agent mode: three children are claimed concurrently', async () => {
  const root = await tempDir('ae-ag-')
  const runtime = new SlowRuntime()
  await claimServer(root, new Map([child('a'), child('b'), child('c')]), runtime)
  const router = await routerWith(root)
  const answers = await Promise.all(['a', 'b', 'c'].map((id) => childRequest(router.baseUrl, plainHeaders(id))))
  for (const [index, id] of ['a', 'b', 'c'].entries()) assert.match(answers[index] ?? '', new RegExp(`PONG ${id}`))
  assert.deepEqual([...runtime.seen].sort(), ['a', 'b', 'c'])
})

test('agent mode: a thread no adapter owns fails clearly and is not retried; only a child of an owned parent counts as unclaimed', async () => {
  const root = await tempDir('ae-ag-')
  const claims: boolean[] = []
  // The stand-in adapter owns the parent `parent` (as a codex thread) but not
  // the children below.
  await claimServer(root, new Map(), new SlowRuntime(), new Set(['parent']))
  const router = await routerWith(root, null, claims)
  const sse = await childRequest(router.baseUrl, plainHeaders('nobody'))
  assert.match(sse, /response\.failed/)
  assert.ok(sse.includes(JSON.stringify(UNCLAIMED_MESSAGE).slice(1, 40)))
  assert.deepEqual(claims, [false], 'a child of an owned parent that no adapter knows is evidence')
  await childRequest(router.baseUrl, { 'thread-id': 'stray' })
  await childRequest(router.baseUrl, { 'thread-id': 'orphan', 'x-codex-parent-thread-id': 'unknown-parent' })
  const abort = new AbortController()
  abort.abort()
  await childRequest(router.baseUrl, plainHeaders('gave-up'), { signal: abort.signal }).catch(() => '')
  assert.deepEqual(claims, [false], 'no parent, an unowned parent or an aborted request is not evidence')
})

test('ownership gate: no Claude turn runs, in either mode, for a thread no adapter owns', async () => {
  const root = await tempDir('ae-ag-')
  const ran: string[] = []
  const stub: ClaudeTurns = {
    mode: 'model',
    run: async (_ctx, request) => {
      ran.push(String(request.headers['thread-id']))
      request.sink.end?.()
    },
  } as ClaudeTurns
  await claimServer(root, new Map([child('mine')]), new SlowRuntime())
  const router = await routerWith(root, stub)
  const refused = await childRequest(router.baseUrl, plainHeaders('stranger'))
  assert.match(refused, /response\.failed/)
  assert.deepEqual(ran, [], 'the model-mode turn never started for a stranger')
  await childRequest(router.baseUrl, plainHeaders('mine'))
  assert.deepEqual(ran, ['mine'])
})

test('agent mode: an adapter that closes before `done` is a failure, not a claim', async () => {
  const root = await tempDir('ae-ag-')
  const runDir = enginePaths(root).run
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const path = claimSocketPath(runDir, 424242)
  const fake = net.createServer((socket) =>
    onLines(socket, (message) => {
      if (message.op === 'owns') {
        writeLine(socket, { type: 'owns', owned: true })
        socket.end()
        return
      }
      writeLine(socket, { type: 'accepted', posture: 'workspace-write', cwd: '/w' })
      writeLine(socket, { type: 'text', delta: 'partial' })
      socket.destroy()
    }),
  )
  await new Promise<void>((ok) => fake.listen(path, ok))
  closers.push(() => new Promise((ok) => fake.close(() => ok())))
  const router = await routerWith(root)
  const sse = await childRequest(router.baseUrl, plainHeaders('half'))
  assert.match(sse, /response\.failed/)
  assert.doesNotMatch(sse, /response\.completed/)
  assert.doesNotMatch(sse, /ae:v1:half:/, 'no marker for a turn that did not finish')
})

test('agent mode: the Codex client going away interrupts the claimed turn', async () => {
  const root = await tempDir('ae-ag-')
  const runtime = new SlowRuntime()
  await claimServer(root, new Map([child('gone')]), runtime)
  const router = await routerWith(root)
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 60)
  await childRequest(router.baseUrl, plainHeaders('gone'), { signal: abort.signal }).catch(() => '')
  await new Promise((ok) => setTimeout(ok, 300))
  assert.deepEqual(runtime.interrupted, ['gone'])
})

// Task 12's recording: the child's request as codex sent it. Only header names
// and the turn metadata's fields are kept; ids are substituted.
function recordedChildHeaders(childId: string, parentId: string): Record<string, string> {
  const files = ['test/fixtures/codex-spawn-0.159.0.json', 'test/fixtures/codex-spawn-0.155-spike.json'].map((p) => resolve(p))
  const rec = files.filter((p) => existsSync(p)).map((p) => JSON.parse(readFileSync(p, 'utf8'))).find((r) => r.childRequest)
  const recorded = (rec?.childRequest ?? {}) as Wire
  const names = new Set<string>(Array.isArray(recorded.headerNames) ? recorded.headerNames : ['thread-id', 'session-id'])
  const headers: Record<string, string> = { 'thread-id': childId }
  if (names.has('session-id')) headers['session-id'] = childId
  if (recorded.parentThreadIdHeader) headers['x-codex-parent-thread-id'] = parentId
  if (recorded.subagentHeader) headers['x-openai-subagent'] = String(recorded.subagentHeader)
  if (names.has('x-codex-turn-metadata')) {
    headers['x-codex-turn-metadata'] = JSON.stringify({
      ...(recorded.turnMetadata ?? {}),
      thread_id: childId,
      turn_id: 'e2e-turn',
      session_id: childId,
      model: 'opus',
    })
  }
  return headers
}

test('end to end: a child the fake codex spawns (recorded shape, no thread/started) is claimed by the real adapter', async () => {
  const root = await tempDir('ae-e2e-')
  const home = join(root, 'h')
  mkdirSync(home, { recursive: true })
  const client = launchAdapter({
    ANYENGINE_ROOT: root,
    ANYENGINE_MOCK: '1',
    ANYENGINE_HOME: home,
    ANYENGINE_DEBUG_LOG: join(home, 'debug.jsonl'),
    ANYENGINE_REAL_CODEX: resolve('test/fixtures/fake-codex-app-server.mjs'),
    ANYENGINE_MODELS: 'opus,sonnet',
    ANYENGINE_RUNTIME_TYPE: 'mock',
    ANYENGINE_RUNTIME_ENV: join(home, 'missing.env'),
    FAKE_CODEX_NO_APPROVAL: '1',
    FAKE_CODEX_SPAWN_CHILD: 'opus',
    // This test IS the native child path. launchAdapter spreads process.env
    // first, so the suite-wide kill switch is overridden here, not deleted.
    ANYENGINE_NATIVE_CODEX: '',
    CLAUDE_CODEX_NATIVE_CODEX: '',
  })
  closers.push(() => client.close())
  await client.request('initialize', { clientInfo: { name: 'test', version: '0' } })
  const started = await client.request('thread/start', { model: 'gpt-6-sol', cwd: root, sandbox: 'workspace-write', approvalPolicy: 'on-request' })
  const parent = started.result.thread.id as string
  await client.request('turn/start', { threadId: parent, input: [{ type: 'text', text: 'spawn one on opus' }] })
  const linked = await client.waitFor(
    (m) => m.method === 'item/completed' && m.params?.item?.type === 'collabAgentToolCall' && (m.params.item.receiverThreadIds ?? []).length > 0,
  )
  const childId = linked.params.item.receiverThreadIds[0] as string
  assert.equal(
    client.messages.some((m) => m.method === 'thread/started' && m.params?.thread?.id === childId),
    false,
    'the child is known without a thread/started',
  )
  const router = await routerWith(root)
  const sse = await childRequest(router.baseUrl, recordedChildHeaders(childId, parent), {}, 'model effort check')
  assert.match(sse, /response\.completed/)
  assert.match(sse, /model=opus/)
})
```

(The mock runtime answers a prompt containing "model effort check" with `model=<model> effort=<effort>`, which shows the claimed turn ran with the child's Claude model. The adapter's claim socket lives at `<root>/run/claim-<pid>.sock`; `ae-e2e-` keeps that under the socket path limit. If the stub's `sink.end` is named differently in `router-turns.mts`, use the name Task 11 gave it.)

- [ ] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/router-claude.mjs'`.

- [ ] **Step 3: Write the claim client**

Create `src/router-claim-client.mts`:

```ts
// Router side of the claim socket. `adapterOwns` asks every live adapter
// whether it knows a thread; the router runs no Claude turn, in either mode,
// for a thread no adapter owns (decision D16). `claimOnAdapters` offers an
// agent-mode turn to every live adapter at once; the first to accept runs it
// and its events are passed on, the others are dropped. A claim is claimed
// only when `done` arrives: a connection that closes first is a failure.
// Aborting the signal closes the connection, which the adapter takes as an
// interrupt.
import net from 'node:net'
import { type ClaimEvent, type ClaimRequest, liveClaimSockets, onLines, writeLine } from './claim-protocol.mjs'

export type ClaimOutcome = 'claimed' | 'unknown' | 'failed'

// `as: 'parent'` asks whether an adapter knows the thread as one of its codex
// child's threads (a parent that spawned children), not as a claimable child.
export function adapterOwns(runDir: string, threadId: string, signal: AbortSignal, timeoutMs = 5_000, as: 'child' | 'parent' = 'child'): Promise<boolean> {
  const paths = liveClaimSockets(runDir)
  if (paths.length === 0 || signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const sockets: net.Socket[] = []
    let pending = paths.length
    let settled = false
    const finish = (owned: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      resolve(owned)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref()
    signal.addEventListener('abort', () => finish(false), { once: true })
    for (const path of paths) {
      const socket = net.connect(path)
      sockets.push(socket)
      let answered = false
      const answer = (owned: boolean) => {
        if (answered) return
        answered = true
        if (owned) return finish(true)
        pending -= 1
        if (pending === 0) finish(false)
      }
      socket.on('connect', () => writeLine(socket, { op: 'owns', threadId, as }))
      onLines(socket, (message) => answer(message.type === 'owns' && message.owned === true))
      socket.on('error', () => answer(false))
      socket.on('close', () => answer(false))
    }
  })
}

export function claimOnAdapters(
  runDir: string,
  request: ClaimRequest,
  onEvent: (event: ClaimEvent) => void,
  signal: AbortSignal,
): Promise<ClaimOutcome> {
  const paths = liveClaimSockets(runDir)
  if (paths.length === 0 || signal.aborted) return Promise.resolve('unknown')
  return new Promise((resolve) => {
    let winner: net.Socket | null = null
    let finished = false
    let pending = paths.length
    const sockets: net.Socket[] = []
    const finish = (outcome: ClaimOutcome) => {
      if (finished) return
      finished = true
      resolve(outcome)
    }
    const lose = () => {
      pending -= 1
      if (pending === 0 && !winner) finish('unknown')
    }
    signal.addEventListener(
      'abort',
      () => {
        for (const socket of sockets) socket.destroy()
        finish(winner ? 'failed' : 'unknown')
      },
      { once: true },
    )
    for (const path of paths) {
      const socket = net.connect(path)
      sockets.push(socket)
      let decided = false
      socket.on('connect', () => writeLine(socket, request))
      onLines(socket, (message) => {
        const event = message as ClaimEvent
        if (!decided) {
          decided = true
          if (event.type !== 'accepted' || winner) {
            socket.destroy()
            lose()
            return
          }
          winner = socket
          for (const other of sockets) if (other !== socket) other.destroy()
        }
        if (socket !== winner) return
        onEvent(event)
        if (event.type === 'done') finish('claimed')
      })
      const gone = () => {
        if (socket === winner) finish('failed')
        else if (!decided) {
          decided = true
          lose()
        }
      }
      socket.on('error', gone)
      socket.on('close', gone)
    }
  })
}
```

(`finish` is idempotent, so the winner's `close` after `done` changes nothing.)

- [ ] **Step 4: Write the agent-mode turns and the ownership gate**

Create `src/router-claude.mts`:

```ts
// Claude turns the router serves (spec 5.2 mode switch). Every turn first
// passes the ownership gate (decision D16): an adapter must say it knows the
// thread, or no Claude runs. Agent mode (the default, decision D2): the turn
// is offered to the adapters over the claim socket and the adapter's Claude
// agent runs it; the router only writes what comes back as the model's
// Responses stream. A marker item at the end lets the next request on the
// same thread send only what is new. Model mode (the trampoline) is added by
// Task 17.
import { claudePromptText, makeMarker, parseCodexRequest } from './codex-input.mjs'
import { parentThreadIdOfRequest, threadIdOfRequest, turnIdOfRequest } from './codex-wire.mjs'
import type { ClaimEvent } from './claim-protocol.mjs'
import { ResponsesStream, usageObject } from './responses-stream.mjs'
import { adapterOwns, claimOnAdapters } from './router-claim-client.mjs'
import type { RouterContext } from './router-server.mjs'
import type { ClaudeTurnRequest, ClaudeTurns } from './router-turns.mjs'

export const UNCLAIMED_MESSAGE =
  'Claude runs through the AnyEngine adapter that started this thread, and no running adapter knows it. Continue in ChatGPT.app with AnyEngine on, or pick a GPT model here.'

const MAX_THREADS = 2_000
const lastTurnByThread = new Map<string, string>()
function rememberTurn(threadId: string, turnKey: string): void {
  lastTurnByThread.delete(threadId)
  lastTurnByThread.set(threadId, turnKey)
  if (lastTurnByThread.size > MAX_THREADS) {
    const oldest = lastTurnByThread.keys().next().value
    if (oldest !== undefined) lastTurnByThread.delete(oldest)
  }
}

function effortOf(body: Record<string, unknown>): string | null {
  const effort = (body.reasoning as { effort?: unknown } | undefined)?.effort
  return typeof effort === 'string' ? effort : null
}

function failTurn(request: ClaudeTurnRequest, message: string): void {
  const stream = new ResponsesStream(request.sink, { model: String(request.body.model) })
  stream.begin()
  stream.fail(message)
}

export class OwnedClaudeTurns implements ClaudeTurns {
  readonly mode: ClaudeTurns['mode']
  private readonly inner: ClaudeTurns
  private readonly runDir: string
  private readonly onClaim: (claimed: boolean) => void

  constructor(inner: ClaudeTurns, runDir: string, onClaim: (claimed: boolean) => void = () => {}) {
    this.inner = inner
    this.runDir = runDir
    this.onClaim = onClaim
    this.mode = inner.mode
  }

  async run(ctx: RouterContext, request: ClaudeTurnRequest): Promise<void> {
    const threadId = threadIdOfRequest(request.headers, request.body)
    const owned = threadId ? await adapterOwns(this.runDir, threadId, request.signal) : false
    if (owned) {
      this.onClaim(true)
      await this.inner.run(ctx, request)
      return
    }
    ctx.log.info('claim.unclaimed', { threadId, mode: this.mode })
    if (await this.isEvidence(request)) this.onClaim(false)
    failTurn(request, UNCLAIMED_MESSAGE)
  }

  // An unowned turn counts toward the unclaimed streak (Task 9) only when it
  // says something about native fan-out: a spawned child (it names a parent)
  // whose parent an adapter does own, so that adapter should have learned the
  // child and did not. A stray client, a thread from before a restart, or a
  // request the caller already gave up on is not evidence.
  private async isEvidence(request: ClaudeTurnRequest): Promise<boolean> {
    if (request.signal.aborted) return false
    const parent = parentThreadIdOfRequest(request.headers)
    if (!parent) return false
    return adapterOwns(this.runDir, parent, request.signal, undefined, 'parent')
  }
}

interface TurnState {
  answered: boolean
  error: string | null
  done: { success: boolean } | null
}

export class AgentClaudeTurns implements ClaudeTurns {
  readonly mode = 'agent' as const
  private readonly runDir: string
  private readonly keepAliveMs: number

  constructor(runDir: string, keepAliveMs = 15_000) {
    this.runDir = runDir
    this.keepAliveMs = keepAliveMs
  }

  async run(ctx: RouterContext, request: ClaudeTurnRequest): Promise<void> {
    const { body, headers, sink, signal } = request
    const model = String(body.model)
    const stream = new ResponsesStream(sink, { model })
    stream.begin()
    const threadId = threadIdOfRequest(headers, body)
    const parsed = parseCodexRequest(body, (sid, turnId) => lastTurnByThread.get(sid) === turnId)
    if (parsed.hasCompactionTrigger) {
      // The adapter's Claude keeps its own context; Codex only needs a
      // compaction item back.
      stream.compaction(makeMarker(threadId ?? 'none', 'compacted'))
      stream.complete(usageObject())
      return
    }
    if (!threadId) {
      stream.fail('Claude agent mode needs the Codex thread id, and this request carries none.')
      return
    }
    const keep = setInterval(() => stream.keepAlive(), this.keepAliveMs)
    keep.unref()
    const state: TurnState = { answered: false, error: null, done: null }
    try {
      const outcome = await claimOnAdapters(
        this.runDir,
        {
          op: 'claim',
          threadId,
          parentThreadId: parentThreadIdOfRequest(headers),
          turnId: turnIdOfRequest(headers, body),
          model,
          prompt: claudePromptText(parsed, { newSession: !parsed.resume }),
          cwd: parsed.cwd,
          effort: effortOf(body),
        },
        (event) => this.onEvent(stream, state, event),
        signal,
      )
      this.finish(ctx, stream, state, outcome, threadId)
    } finally {
      clearInterval(keep)
    }
  }

  private finish(ctx: RouterContext, stream: ResponsesStream, state: TurnState, outcome: string, threadId: string): void {
    if (outcome === 'unknown') {
      ctx.log.info('claim.unclaimed', { threadId, mode: 'agent', after: 'owns' })
      stream.fail(UNCLAIMED_MESSAGE)
      return
    }
    if (outcome === 'failed') {
      ctx.log.info('claim.failed', { threadId })
      stream.fail(`Claude could not finish this task: ${state.error ?? 'the adapter closed the claim before it finished'}`)
      return
    }
    // A turn that ended unsuccessfully is a failure, even if it streamed text
    // first: the parent must not take a partial answer as the result.
    if (state.done?.success === false) {
      stream.fail(`Claude could not finish this task: ${state.error ?? 'the turn failed'}`)
      return
    }
    const turnKey = `t${Date.now().toString(36)}`
    rememberTurn(threadId, turnKey)
    stream.marker(makeMarker(threadId, turnKey))
    stream.complete(usageObject())
  }

  private onEvent(stream: ResponsesStream, state: TurnState, event: ClaimEvent): void {
    switch (event.type) {
      case 'progress':
        stream.reasoning(event.text)
        return
      case 'text':
        state.answered = true
        stream.textDelta(event.delta)
        return
      case 'done':
        state.done = { success: event.success }
        if (!state.answered && event.text) {
          state.answered = true
          stream.textDelta(event.text)
        }
        return
      case 'error':
        state.error = event.message
        return
      default:
        return
    }
  }
}

export function pickClaudeTurns(
  ctx: RouterContext,
  available: { agent: ClaudeTurns | null; model: ClaudeTurns | null },
): ClaudeTurns | null {
  return ctx.config().modes.codexClaude === 'model' ? available.model : available.agent
}
```

- [ ] **Step 5: Run agent mode in the daemon, behind the gate**

In `src/router-hooks.mts`, replace the `claude` holder of Task 11 with the mode-aware pick behind the ownership gate:

```ts
import { AgentClaudeTurns, OwnedClaudeTurns, pickClaudeTurns } from './router-claude.mjs'
...
  const runDir = enginePaths(root).run
  const available = { agent: new AgentClaudeTurns(runDir), model: null as ClaudeTurns | null }
  // Every Claude turn, in either mode, passes the ownership gate; its answers
  // feed the fan-out monitor's unclaimed streak (Task 9).
  const turns = (ctx: RouterContext): ClaudeTurns | null => {
    const inner = pickClaudeTurns(ctx, available)
    return inner ? new OwnedClaudeTurns(inner, runDir, (claimed) => fanout.observeClaim(claimed)) : null
  }
  ...
      upgrade: wsUpgradeHook({ fanout, turns }),
      claudeHttp: claudeHttpHook(turns),
```

and expose `available` on `RouterRuntime` (Task 17 sets `available.model`).

- [ ] **Step 6: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/router-agent.test.mjs dist/test/claim.test.mjs dist/test/router-fanout.test.mjs`
Expected: PASS, `ℹ fail 0`, including `an adapter that closes before \`done\` is a failure, not a claim` and `end to end: a child the fake codex spawns (recorded shape, no thread/started) is claimed by the real adapter`.

- [ ] **Step 7: Gates, commit**

Add to `docs/guide/router.md` (the section Task 14 started): "The router runs no Claude turn, in agent or model mode, unless an adapter answers `owns` for the thread. A thread no adapter owns fails at once with a message that names the fix; three such failures in a row for spawned children whose parent an adapter owns move the router to the bridge path (`claims.unclaimedFlipThreshold`). The gate assumes a single-user Mac: thread ids appear in files the group `staff` can read, so on a Mac with other local users, one of them who learned a live thread id could ask the router for a Claude turn on it; the claim socket itself is private (0700 directory, 0600 socket)."

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/router-claim-client.mts src/router-claude.mts src/router-hooks.mts test/router-agent.test.mts docs/guide/router.md
git commit -m "feat: run agent-mode Claude children through the adapter's claim socket"
```

**Acceptance:** the end-to-end test passes with the recorded announcement (no child `thread/started`) and a request shaped like the recorded child request; no Claude turn starts, in either mode, for a thread no adapter owns, and only a refused child of an owned parent (not aborted) reaches the fan-out monitor; a turn that ends with `success: false` fails even if it streamed text; a claim is claimed only on `done` (an early close fails the turn and writes no marker); three children run at once; a client abort reaches the runtime as an interrupt.

---
### Task 16: The `claude -p` trampoline (model mode), with no effectful built-in tool

Spec 5.2: "Claude `/responses`: translated into a `claude -p` trampoline turn (option a). Codex's tools are exposed to Claude as a per-turn MCP server and executed by Codex. Foreign reasoning and encrypted items are stripped in both directions." Posture: in model mode Claude is the model inside Codex's loop, so this plan makes it only that. Its launch offers Claude only a closed list of built-in tools (`--tools`: reads and tools with no effect), denies every effectful one besides (a second guard), disables every hook, and loads no MCP server but Codex's own tools; every effect is then a Codex tool call that Codex runs under the thread's own sandbox and approvals. Because the list is closed, a built-in tool a later Claude release adds is not offered at all. That makes "never looser" hold by construction, for every parent posture and for tools this build does not know, including full access (claude-in-codex maps full access to `--dangerously-skip-permissions`; AnyEngine never passes it). This task ports the runner; Task 17 adds the Codex tool handoff and turns model mode on in the router.

**Source:** claude-in-codex `e2adced`: `src/claudeRunner.js`, `src/state.js`, `test/fixtures/fake-claude.js`, read from the commit with `git -C <clone> show e2adced:<path>` (Task 10's rule: the spike clone's working tree carries uncommitted spike patches).

**Files:**
- Create: `src/trampoline-launch.mts`, `src/trampoline-runner.mts`, `src/trampoline-events.mts`, `src/trampoline-state.mts`
- Create: `test/fixtures/fake-claude-print.mjs` (port of `fake-claude.js`)
- Create: `test/trampoline.test.mts`; modify `test/posture.test.mts` (one property test)

**Interfaces:**
- Consumes: `responses-stream.mts`, `codex-input.mts` (`ParsedCodexRequest`, `buildClaudeUserMessage`, `makeMarker`), `tool-display.mts`, `anyengine-config.mts` (`enginePaths`, `ClaudeModelEntry`), `router-log.mts`, `posture-claude.mts` (`claudeToolEffect`).
- Produces:

```ts
// src/trampoline-launch.mts
export const CODEX_TOOLS_SERVER = 'codex'
export const TRAMPOLINE_BUILTINS: readonly string[]   // the closed list passed to --tools
export const TRAMPOLINE_DENIED: readonly string[]
export interface ClaudeCapabilities { ok: boolean; partial: boolean; effort: boolean; permissionPrompts: boolean; tools: boolean }
export function claudeCapabilities(claudePath: string): Promise<ClaudeCapabilities>   // `claude --help`, successful probes cached per path
export interface TrampolineLaunchInput {
  claudeModel: string
  effort: string | null
  planMode: boolean
  resume: string | null
  fork: boolean
  mcpConfig: { mcpServers: Record<string, unknown> }
  systemPrompt: string
  codexToolsOffered: boolean
  caps: ClaudeCapabilities
}
export function trampolineArgs(input: TrampolineLaunchInput): string[]

// src/trampoline-state.mts
export class TrampolineState {
  constructor(file: string, maxSessions?: number)
  isLatestTurn(sid: string, turnId: string): boolean
  ownerThread(sid: string): string | null
  recordTurn(sid: string, turnId: string, threadId: string | null): void
  setContextWindow(model: string, size: number): void
  contextWindow(model: string): number | null
}

// src/trampoline-runner.mts
export interface TrampolineTurn {
  stream: ResponsesStream
  parsed: ParsedCodexRequest & { threadId: string | null; codexTurnId: string; fork: boolean }
  model: ClaudeModelEntry
  effort: string | null
  codexTools: unknown[]
  claudePath: string
  state: TrampolineState
  log: RouterLog
}
export function runTrampolineTurn(turn: TrampolineTurn): Promise<void>
export function compactTrampolineSession(input: { claudePath: string; sid: string; cwd: string | null }): Promise<{ sessionId: string | null }>
```

- [ ] **Step 1: Check what the installed `claude` supports**

Run: `claude --version && claude --help | grep -E -- '--(tools|strict-mcp-config|mcp-config|settings|disallowedTools|allowedTools|permission-mode|include-partial-messages|permission-prompts|effort|fork-session|no-session-persistence) ' | sed 's/^ *//' | cut -c1-60`
Expected: `2.1.28x (Claude Code)` and one line for each flag (`--permission-prompts` may be absent; the launch only adds it when `claudeCapabilities` finds it). `--tools` must be there (2.1.285 has it: "Specify the list of available tools from the built-in set"); if it is missing, stop and report: model mode's bound on unknown tools depends on it.

Run: `strings "$(python3 -c 'import os,shutil;print(os.path.realpath(shutil.which("claude")))')" | grep -c disableAllHooks`
Expected: 1 or more. If it prints 0, stop and report: the launch below relies on the `disableAllHooks` setting to keep hooks from running outside Codex's sandbox, and needs a replacement before model mode can ship.

- [ ] **Step 2: Port the fake Claude**

Port `test/fixtures/fake-claude.js` to `test/fixtures/fake-claude-print.mjs` unchanged except: the header names its source (`// Ported from EthanSK/claude-in-codex (MIT) test/fixtures/fake-claude.js @ e2adced; see THIRD_PARTY_NOTICES.md.`), `FAKE_CLAUDE_LOG` keeps its name, and it additionally appends its full argv to `FAKE_CLAUDE_ARGS_FILE` when that is set (one JSON array per line).

- [ ] **Step 3: Write the failing tests**

Create `test/trampoline.test.mts` with these tests, ported from claude-in-codex `test/bridge.test.js` (same fixture scenarios, driven through `runTrampolineTurn` with a `ResponsesStream` over an in-memory sink instead of the upstream bridge server), plus two new ones:

1. Ported `Claude turn streams text, reasoning, web search and a marker; second turn resumes`: a new session, then a second turn whose input carries the first turn's marker resumes it (`--resume <sid>` in the second argv).
2. Ported `plan mode maps to Claude plan mode and returns a proposed_plan block`.
3. Ported `Claude errors surface as a message, not a retryable failure` (scenario `error`: the stream ends with `response.failed` and `code: invalid_prompt`, never an HTTP 5xx).
4. Ported `compaction of a Claude thread runs /compact and returns one compaction item` (through `compactTrampolineSession`).
5. Ported `side chat (different thread) forks the parent Claude session; parent keeps its own` and `a new side chat does not wait for its parent's running Claude turn`.
6. New, `trampoline: the launch never gives Claude an effectful built-in, a hook or a foreign MCP server` (imports `TRAMPOLINE_BUILTINS` and `trampolineArgs` from `../src/trampoline-launch.mjs`):

```ts
test('trampoline: the launch never gives Claude an effectful built-in, a hook or a foreign MCP server', () => {
  const caps = { ok: true, partial: true, effort: true, permissionPrompts: true, tools: true }
  for (const planMode of [false, true]) {
    const args = trampolineArgs({
      claudeModel: 'opus', effort: 'high', planMode, resume: null, fork: false,
      mcpConfig: { mcpServers: { codex: { command: 'node', args: ['x'] } } },
      systemPrompt: 'x', codexToolsOffered: true, caps,
    })
    assert.ok(!args.includes('--dangerously-skip-permissions'))
    assert.equal(args[args.indexOf('--permission-mode') + 1], planMode ? 'plan' : 'default')
    const denied = (args[args.indexOf('--disallowedTools') + 1] ?? '').split(',')
    for (const tool of ['Bash', 'BashOutput', 'Monitor', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'Task', 'Agent'])
      assert.ok(denied.includes(tool), tool)
    assert.ok(args.includes('--strict-mcp-config'))
    assert.deepEqual(Object.keys(JSON.parse(args[args.indexOf('--mcp-config') + 1] ?? '{}').mcpServers), ['codex'])
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}'), { disableAllHooks: true })
    assert.equal(args.includes('--allowedTools'), !planMode)
    assert.deepEqual((args[args.indexOf('--tools') + 1] ?? '').split(','), [...TRAMPOLINE_BUILTINS])
  }
  assert.throws(
    () => trampolineArgs({ claudeModel: 'opus', effort: null, planMode: false, resume: null, fork: false, mcpConfig: { mcpServers: {} }, systemPrompt: '', codexToolsOffered: false, caps: { ...caps, tools: false } }),
    /--tools/,
    'no launch without the closed tool list',
  )
})
```

7. New, `trampoline: the argv the fake Claude received matches the launch`: run the default scenario with `FAKE_CLAUDE_ARGS_FILE` set and assert the recorded argv contains `--tools` with the closed list, `--strict-mcp-config`, the `--disallowedTools` list and `--settings {"disableAllHooks":true}`, and never `--dangerously-skip-permissions`, for a request whose developer text says `` `sandbox_mode` is `danger-full-access` ``.

Append to `test/posture.test.mts`:

```ts
test('never looser: a model-mode (trampoline) Claude child, over every posture and every tool, known or not', () => {
  for (const parent of everyPosture(tree)) {
    const args = trampolineArgs({
      claudeModel: 'opus', effort: null, planMode: parent.plan, resume: null, fork: false,
      mcpConfig: { mcpServers: { codex: {} } }, systemPrompt: '', codexToolsOffered: true,
      caps: { ok: true, partial: true, effort: true, permissionPrompts: true, tools: true },
    })
    const offered = new Set((args[args.indexOf('--tools') + 1] ?? '').split(','))
    const denied = new Set((args[args.indexOf('--disallowedTools') + 1] ?? '').split(','))
    const servers = Object.keys(JSON.parse(args[args.indexOf('--mcp-config') + 1] ?? '{}').mcpServers)
    assert.ok(args.includes('--strict-mcp-config'))
    assert.deepEqual(servers, ['codex'])
    // The bound: every built-in Claude is offered is one this build knows to be
    // a read or to have no effect. A tool it does not know (CLAUDE_TOOLS'
    // `SomeFutureTool`, effect unbounded) is therefore never offered, whether or
    // not TRAMPOLINE_DENIED names it.
    for (const tool of offered) {
      const effect = claudeToolEffect(tool, {})
      assert.ok(effect === 'inert' || (typeof effect === 'object' && effect.kind === 'read'), `${tool} is offered with effect ${JSON.stringify(effect)}`)
      assert.ok(!denied.has(tool), `${tool} is both offered and denied`)
    }
    for (const { tool, input, effect } of CLAUDE_TOOLS) {
      // MCP tools other than Codex's own are not loaded at all (--strict-mcp-config).
      if (tool.startsWith('mcp__')) continue
      if (!offered.has(tool) || denied.has(tool)) continue
      assert.ok(
        effect === 'inert' || (typeof effect === 'object' && effect.kind === 'read'),
        `${JSON.stringify(parent)}: ${tool} (${JSON.stringify(effect)}) is offered`,
      )
      if (typeof effect === 'object') assert.equal(reach(parent, effect, ctx), 'allow')
      assert.equal(claudeToolEffect(tool, input) === 'sandboxed', false)
    }
    assert.equal(offered.has('SomeFutureTool'), false)
  }
})
```

with `import { trampolineArgs } from '../src/trampoline-launch.mjs'` (and `claudeToolEffect` from `posture-claude.mjs` if the file does not import it yet). (Codex tools are MCP calls Codex executes itself under the thread's own posture, so they are outside this check by design.)

- [ ] **Step 4: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/trampoline-launch.mjs'`.

- [ ] **Step 5: Write the launch**

Create `src/trampoline-launch.mts`:

```ts
// The `claude -p` launch for one model-mode turn. Claude is the model inside
// Codex's loop and nothing else: every built-in tool that runs a command,
// writes a file, fetches the network, delegates to a sub-agent or asks a
// question Codex cannot show is denied (deny rules beat any allow rule in the
// user's settings); besides, only a closed list of built-ins is offered at
// all (--tools), so a tool a later Claude release adds is never offered; hooks are off (`disableAllHooks` in flag settings, the
// highest precedence), so no user or project hook runs outside Codex's
// sandbox; the only MCP server is Codex's own tools (--strict-mcp-config).
// Every effect is therefore a Codex tool call, which Codex runs under the
// thread's own sandbox and approval policy. Reads stay: a read is allowed
// under every Codex posture. The launch is the same for every sandbox mode;
// only plan mode changes it (spec 5.6; test/posture.test.mts).
import { execFile } from 'node:child_process'

export const CODEX_TOOLS_SERVER = 'codex'

// Reads (allowed under every Codex posture) and tools with no effect outside
// the conversation. ToolSearch stays so Claude can load Codex's deferred MCP
// tools; ExitPlanMode lets a plan-mode turn hand back its plan. Every name here
// must map to a read or to 'inert' in posture-claude.mts (test/posture.test.mts).
export const TRAMPOLINE_BUILTINS: readonly string[] = [
  'Read', 'Glob', 'Grep', 'TodoWrite', 'WebSearch', 'ToolSearch', 'ExitPlanMode',
]

export const TRAMPOLINE_DENIED: readonly string[] = [
  'Bash', 'BashOutput', 'KillShell', 'KillBash', 'Monitor',
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'WebFetch',
  'Task', 'Agent', 'TaskStop',
  'AskUserQuestion',
  'CronCreate', 'CronDelete', 'ScheduleWakeup',
  'SendMessage', 'SendUserMessage', 'PushNotification', 'RemoteTrigger',
  'LSP', 'Workflow', 'EnterWorktree', 'ExitWorktree', 'Artifact',
  'Skill', 'SlashCommand',
]

export interface ClaudeCapabilities {
  ok: boolean
  partial: boolean
  effort: boolean
  permissionPrompts: boolean
  tools: boolean
}

const probes = new Map<string, ClaudeCapabilities>()

// `claude --help`, cached per executable only when it succeeded: a slow first
// probe must not disable Claude for the life of the router (claude-in-codex
// LEARNINGS, 2026-09-26).
export function claudeCapabilities(claudePath: string): Promise<ClaudeCapabilities> {
  const known = probes.get(claudePath)
  if (known) return Promise.resolve(known)
  return new Promise((resolve) => {
    execFile(claudePath, ['--help'], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const help = `${stdout}${stderr}`
      if (error || !help.includes('--print')) {
        resolve({ ok: false, partial: false, effort: false, permissionPrompts: false, tools: false })
        return
      }
      const caps = {
        ok: true,
        partial: help.includes('--include-partial-messages'),
        effort: help.includes('--effort'),
        permissionPrompts: help.includes('--permission-prompts'),
        tools: /--tools\b/.test(help),
      }
      probes.set(claudePath, caps)
      resolve(caps)
    })
  })
}

export interface TrampolineLaunchInput {
  claudeModel: string
  effort: string | null
  planMode: boolean
  resume: string | null
  fork: boolean
  mcpConfig: { mcpServers: Record<string, unknown> }
  systemPrompt: string
  codexToolsOffered: boolean
  caps: ClaudeCapabilities
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

export function trampolineArgs(input: TrampolineLaunchInput): string[] {
  // Without the closed list an unknown built-in could be offered: no launch.
  if (!input.caps.tools) throw new Error('model mode needs a claude CLI with --tools')
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', input.claudeModel,
    '--permission-mode', input.planMode ? 'plan' : 'default',
    '--tools', TRAMPOLINE_BUILTINS.join(','),
    '--disallowedTools', TRAMPOLINE_DENIED.join(','),
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify(input.mcpConfig),
    '--settings', JSON.stringify({ disableAllHooks: true }),
    '--append-system-prompt', input.systemPrompt,
  ]
  // Codex runs its own tools under its own approvals; plan mode keeps
  // Claude's read-only rules and asks nothing of them.
  if (input.codexToolsOffered && !input.planMode) args.push('--allowedTools', `mcp__${CODEX_TOOLS_SERVER}`)
  if (input.caps.partial) args.push('--include-partial-messages')
  if (input.caps.permissionPrompts) args.push('--permission-prompts', 'none')
  const effort = (input.effort ?? '').toLowerCase()
  if (input.caps.effort && EFFORTS.has(effort)) args.push('--effort', effort)
  if (input.resume) args.push('--resume', input.resume)
  if (input.fork) args.push('--fork-session')
  return args
}
```

- [ ] **Step 6: Port the state and the runner**

1. `src/trampoline-state.mts`: port `src/state.js` as `TrampolineState` with the signatures above; the file is `~/.anyengine/router/trampoline-state.json`, written atomically (`writeJsonAtomic`), sessions pruned to the newest `maxSessions` (default 500) on every `recordTurn`. Drop `setUpstreamModels` (the router's catalog cache is Task 9's).
2. `src/trampoline-runner.mts` and `src/trampoline-events.mts`: port `runClaudeTurn`, `handleEvent` and `compactSession` from `src/claudeRunner.js`, with these changes and nothing else:
   - The argv comes from `trampolineArgs` (above). Remove `permissionArgs`, the `config.permissionModes` mapping, `config.extraSystemPrompt`, and the computer-use proxy (`cuaMcpProxy`) with its config: Codex's own tools carry Computer Use and the in-app browser.
   - `claudePath` comes from the turn (Task 17 passes `config.claude.cli`, resolved at `anyengine on`), `claudeModel` from the `ClaudeModelEntry`.
   - The child's environment is `process.env` minus `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` (the plan's login must bill, and no token passes through AnyEngine), plus `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` and `MCP_TOOL_TIMEOUT` as upstream sets them.
   - The Codex tool server comes from Task 17; until then `codexTools` is honoured only for the question-tool note (`AskUserQuestion` is denied by the launch in every case).
   - Split so no function exceeds cognitive complexity 30: argv and prompt assembly, spawn and lifecycle (session locks, fork locks), and the stream-json event mapping (`trampoline-events.mts`).
   - Log lines go to the `RouterLog` (`trampoline.turn` with model, mode, effort, `new-session`/`resume`/`fork`), never with prompt text.
   - Header on each file: `// Ported from EthanSK/claude-in-codex (MIT) src/claudeRunner.js @ e2adced, with changes; see THIRD_PARTY_NOTICES.md.` plus one line naming the changes above.

- [ ] **Step 7: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/trampoline.test.mjs dist/test/posture.test.mjs`
Expected: PASS, `ℹ fail 0`, including `never looser: a model-mode (trampoline) Claude child, over every posture`.

- [ ] **Step 8: Gates, commit**

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK (no new function over complexity 30), `ℹ fail 0`.

```bash
git add src/trampoline-launch.mts src/trampoline-runner.mts src/trampoline-events.mts src/trampoline-state.mts \
  test/fixtures/fake-claude-print.mjs test/trampoline.test.mts test/posture.test.mts
git commit -m "feat: port the claude -p trampoline with a launch that gives Claude no effectful tool"
```

**Acceptance:** the ported tests pass against `fake-claude-print.mjs`; no argv the trampoline builds contains `--dangerously-skip-permissions`, a hook, a foreign MCP server or an effectful built-in, for any posture; every built-in it offers is a known read or inert tool, so an unknown one (`SomeFutureTool`) is never offered; no launch without `--tools`; the property test passes.

---

### Task 17: Codex tools for the trampoline, and model mode in the router

The trampoline's Claude reaches the world only through Codex's tools: each tool Codex offered in the request becomes an MCP tool (`mcp__codex__<name>`); a call ends the current Responses stream with a real `function_call` / `custom_tool_call` (`end_turn: false`); Codex runs it with its own approvals and UI, and its next request carries the result, which resumes the same waiting Claude process. This task ports that handoff and turns model mode on in the router, behind the same ownership gate as agent mode (Task 15, decision D16): a thread no adapter owns never starts `claude`.

**Source:** claude-in-codex `e2adced`: `src/codexTools.js`, `src/codexToolsMcpProxy.js`, the `handleClaudeResponses` function in `src/server.js`, and the tests in `test/bridge.test.js`, each read with `git -C <clone> show e2adced:<path>` (Task 10's rule).

**Files:**
- Create: `src/trampoline-tools.mts`, `src/trampoline-mcp.mts`
- Modify: `src/trampoline-runner.mts` (tool server wiring), `src/router-claude.mts` (`ModelClaudeTurns`), `src/router-hooks.mts` (`available.model`)
- Modify: `test/trampoline.test.mts`; create `test/trampoline-tools.test.mts`
- Modify: `docs/guide/router.md`

**Interfaces:**
- Consumes: Task 16's runner, state and launch; Task 15's `OwnedClaudeTurns` (the gate) and Task 14's `ClaimServer` (a stand-in owning adapter in the tests); `responses-stream.mts` (`codexToolCall`); `codex-input.mts` (`parseCodexRequest`, `buildClaudeUserMessage`, `makeMarker`); `codex-wire.mts`; `anyengine-config.mts` (`loadConfig`, `enginePaths`).
- Produces:

```ts
// src/trampoline-tools.mts
export interface CodexToolEntry { name: string; namespace?: string; custom: boolean; mcpTool: { name: string; description: string; inputSchema: unknown } }
export function isCodexToolName(name: unknown): boolean
export function codexToolCatalog(tools: unknown): Map<string, CodexToolEntry>
export class CodexToolServer { constructor(catalog: Map<string, CodexToolEntry>, onCall: (call: PendingCodexCall) => void); listen(): Promise<string>; close(): void }
export interface PendingCodexCall { callId: string; toolUseId: string | null; entry: CodexToolEntry; args: Record<string, unknown>; resolve(output: unknown): void }
export function findCodexResults(input: unknown): { turn: WaitingTurn; results: Map<string, unknown> } | null
export function cancelWaitingCodexTurns(threadId: string | null): Promise<void>
export function codexOutputToMcp(output: unknown): Array<Record<string, unknown>>

// src/trampoline-mcp.mts: run directly with node; stdio <-> the per-turn socket
export function runTrampolineMcp(socketPath: string): void

// src/router-claude.mts
export class ModelClaudeTurns implements ClaudeTurns {
  readonly mode: 'model'
  constructor(root: string, log: RouterLog)
  run(ctx: RouterContext, request: ClaudeTurnRequest): Promise<void>
}
```

- [ ] **Step 1: Write the failing tests**

Create `test/trampoline-tools.test.mts` with these tests ported from claude-in-codex `test/bridge.test.js` (driven through `startRouter` with the daemon's own hooks from `buildRouterRuntime`, so the ownership gate is in the path, with `modes.codexClaude = "model"` written to the test root's `config.json`, `claude.cli` pointing at `test/fixtures/fake-claude-print.mjs`, and the fake backend as upstream). Every test root comes from `tempDir('ae-tt-')`: the per-turn tool sockets live under it and a long root would pass the socket path limit. Each test also starts a stand-in adapter, a `ClaimServer` on `<root>/run` whose host owns every thread id the test uses (`waitForClaimThread` returns a `ClaimThread` with `DEFAULT_POSTURE`) and whose runtime is a stub that records what it was asked to run:

1. `Claude calls Codex tools that Codex runs, and the same Claude process continues with the result` (HTTP).
2. `WebSocket follow-ups carrying only Codex tool results continue the waiting Claude turn`.
3. `a new message without the tool results stops the waiting Claude turn before resuming its session`.
4. `GPT requests keep bridge-made Codex tool calls, without their bridge ids` (the `fc_ae_`/`ctc_ae_` items reach the upstream without their `id`).
5. `Claude asks through the desktop question card, and the answer reaches it during a later tool result` and `a question-card answer starting a new turn is the user's prompt, not background context`.
6. `model switch GPT -> Claude carries GPT output as context` (one WebSocket, a GPT frame then a Claude frame).
7. New, `model mode: mode agent sends the same request to the claim socket, not to claude`: with `modes.codexClaude = "agent"`, the same request is run by the stand-in adapter's stub runtime and the fake Claude's log stays empty.
8. New, `model mode: a thread no adapter owns never starts claude`: in model mode, a request for a thread id the stand-in does not own (and, separately, with no claim socket at all) ends in `response.failed` with `UNCLAIMED_MESSAGE`, and the fake Claude's log stays empty.

- [ ] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/trampoline-tools.mjs'`.

- [ ] **Step 3: Port the handoff**

1. `src/trampoline-tools.mts`: port `src/codexTools.js` with the signatures above; waiting calls are keyed by `call_id` across requests exactly as upstream; ids the router mints use `fc_ae_` / `ctc_ae_`; a waiting turn holds the Claude process for at most 30 minutes, then is cancelled.
2. `src/trampoline-mcp.mts`: port `src/codexToolsMcpProxy.js` as `runTrampolineMcp(socketPath)` plus a direct-run guard at the bottom:

```ts
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const socketPath = process.env.ANYENGINE_TRAMPOLINE_SOCKET ?? ''
  if (!socketPath) {
    process.stderr.write('anyengine trampoline-mcp: ANYENGINE_TRAMPOLINE_SOCKET is not set\n')
    process.exit(1)
  }
  runTrampolineMcp(socketPath)
}
```

   The per-turn socket lives in `~/.anyengine/router/tools/` (0700), one per turn, named `t-<8 hex>.sock`, removed when the turn ends; before listening, the server checks the path against `socketPathLimit()` (as the claim socket does, Task 14) and fails the turn with a clear message instead of an `EINVAL`. The runner starts it as `{ command: process.execPath, args: [<dist>/src/trampoline-mcp.mjs], env: { ANYENGINE_TRAMPOLINE_SOCKET: <socket> } }`; document `ANYENGINE_TRAMPOLINE_SOCKET` in `docs/guide/configuration.md` under "Set by the adapter, not by you" (it is read in `src/`, so the env-docs gate requires it).
3. `src/router-claude.mts`: add `ModelClaudeTurns`, the port of `handleClaudeResponses`: parse with `parseCodexRequest(body, state.isLatestTurn)`; thread id from `threadIdOfRequest`; a fork when the resumed session belongs to another thread; `findCodexResults(body.input)` continues a waiting turn; otherwise `cancelWaitingCodexTurns(threadId)`, then a compaction trigger compacts the Claude session (`compactTrampolineSession`) and returns one compaction item, and anything else runs `runTrampolineTurn` with `claudePath = ctx.config().claude.cli ?? 'claude'` and the `ClaudeModelEntry` whose id is `body.model`.
4. In `src/router-hooks.mts`, set `available.model = new ModelClaudeTurns(root, log)`. It is reached only through `pickClaudeTurns` inside `OwnedClaudeTurns` (Task 15 Step 5), so model mode passes the same ownership gate; do not wire it any other way.

- [ ] **Step 4: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/trampoline-tools.test.mjs dist/test/trampoline.test.mjs dist/test/router-agent.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 5: Docs, gates, commit**

Append to `docs/guide/router.md`:

````markdown
## Model mode (opt-in)

`anyengine mode codex-claude model` runs Claude turns through `claude -p`
instead of the adapter's agent. Claude is then only the model inside Codex's
loop: it is offered a closed list of built-in tools that only read (a later
Claude release's new tools are not offered), the effectful ones are denied
besides, hooks are off, and its only MCP server is Codex's tool list, so every
action is a Codex tool call that Codex runs under the thread's own sandbox and
approvals. As in agent mode, a Claude turn runs only for a thread an AnyEngine
adapter owns. Anthropic's policy treats the CLI as
a model endpoint for another agent loop as a grey area; agent mode is the
default for that reason.
````

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/trampoline-tools.mts src/trampoline-mcp.mts src/trampoline-runner.mts src/router-claude.mts \
  src/router-hooks.mts test/trampoline-tools.test.mts test/trampoline.test.mts docs/guide/router.md \
  docs/guide/configuration.md
git commit -m "feat: hand Codex tools to the trampoline's Claude and add model mode to the router"
```

**Acceptance:** the ported tool-handoff tests pass; in model mode a Claude tool call reaches Codex as a real tool call and its result resumes the same Claude process; in agent mode the same request never starts `claude`; in model mode a thread no adapter owns never starts `claude`.

---
### Task 18: The adapter attaches the router, routes by mode, and injects at most one line

Decision D1: the adapter points its own codex child at the router with `-c openai_base_url=...`, and only when the router answers `/health` within 500 ms at spawn time, is enabled, and has not been marked degraded by the smoke. Decision D5: on the native path the GPT child gets no `anyengine` MCP server and no instruction; on the bridge path it gets the server and one developer line. The native path is taken only when it is proven healthy (H1, decision D18): the router reports it (the router itself reports bridge while native fan-out is not proven for the lib, app, codex and settings in use, Task 9), and the adapter checks the same keyed proof and the degraded mark once more at spawn, with its own view of those versions. Whenever native is not proven, the GPT child keeps the `anyengine` server and the bridge line; Claude and Grok threads get the one-line addendum instead of the multi-line block. Spec 5.2 mode switch: in model mode (and only while the native path is up) Claude threads and mid-thread switches to Claude go to the codex child, so the router's trampoline runs them; in agent mode they stay on the adapter as today.

**Files:**
- Create: `src/router-link.mts`
- Modify: `src/adapter.mts` (link before the child spawns; bridge args only off the native path), `src/codex-mux.mts` (routing and injection), `src/rehome.mts` (`engineForModelRouted`), `src/bridge-instructions.mts` (one line), `src/bridge-mcp.mts` (no MCP `instructions`), `src/server.mts` (one line: the mux option), `docs/guide/configuration.md`, `docs/guide/bridge.md`
- Modify: `test/bridge.test.mts`, `test/grok-runtime.test.mts` (the new single line)
- Create: `test/router-link.test.mts`

**Interfaces:**
- Consumes: `anyengine-config.mts` (`loadConfig`, `routerBaseUrl`, `anyengineRoot`, `enginePaths`, `writeJsonAtomic`), `router-fanout.mts` (`FanoutPath`), `degraded.mts` (`readDegraded`, `isProven`, `proofKey`; Task 9), `bridge-instructions.mts` (`BRIDGE_LINE`, `BRIDGE_LINE_GPT`).
- Produces:

```ts
// src/router-link.mts
export interface RouterLinkState { attached: boolean; url: string | null; fanout: FanoutPath; reason: string; checkedAt: string }
export function appOpenaiBaseUrl(argv: string[]): string | null
export function linkRouter(argv: string[], options?: { root?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ state: RouterLinkState; configArgs: string[] }>
export function currentRouterLink(): RouterLinkState
export function nativeFanout(): boolean
export function routerServesClaude(): boolean
export function gptBridgeLine(bridgeAttached: boolean): string | null

// src/rehome.mts
export function engineForModelRouted(model: string | null | undefined): Engine

// src/bridge-instructions.mts (changed)
export function bridgeInstructions(_catalog: BridgeCatalogModel[]): string          // BRIDGE_LINE
export function appendBridgeInstructions(existing: string | null | undefined, catalog: BridgeCatalogModel[], line?: string): string
```

- [ ] **Step 1: Write the failing tests**

Create `test/router-link.test.mts`:

```ts
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { enginePaths } from '../src/anyengine-config.mjs'
import { BRIDGE_LINE_GPT } from '../src/bridge-instructions.mjs'
import { markDegraded, markProven, proofKey } from '../src/degraded.mjs'
import { appOpenaiBaseUrl, linkRouter, nativeFanout, routerServesClaude } from '../src/router-link.mjs'
import { launchAdapter } from './helpers/adapter-client.mjs'
import { killChildren } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const closers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await killChildren()
  await removeTempDirs()
})

async function fakeRouter(fanout: 'native' | 'bridge', delayMs = 0): Promise<string> {
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, fanout: { path: fanout, reason: 'test' } }))
    }, delayMs)
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  closers.push(() => new Promise((ok) => server.close(() => ok())))
  const address = server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/backend-api/codex`
}

test('router link: a healthy router is attached through -c openai_base_url', async () => {
  const root = await tempDir('ae-ln-')
  const url = await fakeRouter('native')
  markProven(root, 'native-fanout', 'test', proofKey(root))
  const { state, configArgs } = await linkRouter(['app-server'], { root, env: { ANYENGINE_ROUTER_URL: url } })
  assert.equal(state.attached, true)
  assert.deepEqual(configArgs, ['-c', `openai_base_url="${url}"`])
  assert.equal(nativeFanout(), true)
  assert.equal(routerServesClaude(), false, 'agent mode is the default')
  writeFileSync(enginePaths(root).config, JSON.stringify({ modes: { codexClaude: 'model' } }))
  await linkRouter(['app-server'], { root, env: { ANYENGINE_ROUTER_URL: url } })
  assert.equal(routerServesClaude(), true)
})

test('router link: native fan-out is taken only when proven and not degraded', async () => {
  const root = await tempDir('ae-ln-')
  const url = await fakeRouter('native')
  const unproven = await linkRouter(['app-server'], { root, env: { ANYENGINE_ROUTER_URL: url } })
  assert.equal(unproven.state.attached, true)
  assert.equal(unproven.state.fanout, 'bridge')
  assert.match(unproven.state.reason, /not proven/)
  assert.equal(nativeFanout(), false)
  markProven(root, 'native-fanout', 'switch-on check', proofKey(root))
  assert.equal((await linkRouter(['app-server'], { root, env: { ANYENGINE_ROUTER_URL: url } })).state.fanout, 'native')
  markDegraded(root, 'native-fanout', 'smoke: no claim.done')
  const degraded = await linkRouter(['app-server'], { root, env: { ANYENGINE_ROUTER_URL: url } })
  assert.equal(degraded.state.fanout, 'bridge')
  assert.match(degraded.state.reason, /degraded/)
  const bridged = await linkRouter(['app-server'], { root: await tempDir('ae-ln-'), env: { ANYENGINE_ROUTER_URL: await fakeRouter('bridge') } })
  assert.equal(bridged.state.fanout, 'bridge', 'the router itself says bridge (for example after unclaimed turns)')
})

test('router link: an unhealthy router is never attached', async () => {
  const root = await tempDir('ae-ln-')
  const started = Date.now()
  const down = await linkRouter(['app-server'], { root, env: { ANYENGINE_ROUTER_URL: 'http://127.0.0.1:9/backend-api/codex' } })
  assert.equal(down.state.attached, false)
  assert.deepEqual(down.configArgs, [])
  assert.match(down.state.reason, /did not answer/)
  const slow = await linkRouter(['app-server'], { root, env: { ANYENGINE_ROUTER_URL: await fakeRouter('native', 2000) } })
  assert.equal(slow.state.attached, false)
  assert.ok(Date.now() - started < 3000)
  assert.equal(nativeFanout(), false)
})

test('router link: disabled, degraded, or the app naming its own base URL keeps it out', async () => {
  const root = await tempDir('ae-ln-')
  const url = await fakeRouter('native')
  markDegraded(root, 'router', 'smoke: GPT through the router failed')
  assert.match((await linkRouter(['app-server'], { root, env: { ANYENGINE_ROUTER_URL: url } })).state.reason, /degraded/)
  const other = await tempDir('ae-ln-')
  const argv = ['-c', 'openai_base_url="https://proxy.example/v1"', 'app-server']
  assert.equal(appOpenaiBaseUrl(argv), 'https://proxy.example/v1')
  assert.match((await linkRouter(argv, { root: other, env: { ANYENGINE_ROUTER_URL: url } })).state.reason, /its own openai_base_url/)
  writeFileSync(enginePaths(other).config, JSON.stringify({ router: { enabled: false } }))
  assert.match((await linkRouter(['app-server'], { root: other })).state.reason, /router.enabled is false/)
})

function adapterWith(root: string, routerUrl: string, extra: NodeJS.ProcessEnv = {}) {
  const home = join(root, 'home')
  const env: NodeJS.ProcessEnv = {
    ANYENGINE_ROOT: root,
    ANYENGINE_ROUTER_URL: routerUrl,
    ANYENGINE_MOCK: '1',
    ANYENGINE_HOME: home,
    ANYENGINE_DEBUG_LOG: join(home, 'debug.jsonl'),
    ANYENGINE_REAL_CODEX: resolve('test/fixtures/fake-codex-app-server.mjs'),
    ANYENGINE_MODELS: 'opus,sonnet',
    ANYENGINE_RUNTIME_TYPE: 'mock',
    FAKE_CODEX_ARGV_FILE: join(root, 'argv.json'),
    FAKE_CODEX_REQUESTS_FILE: join(root, 'requests.jsonl'),
    FAKE_CODEX_NO_APPROVAL: '1',
    ANYENGINE_RUNTIME_ENV: join(home, 'missing.env'),
    // The native child path under test. launchAdapter spreads process.env
    // first, so the suite-wide kill switch is overridden, not deleted.
    ANYENGINE_NATIVE_CODEX: '',
    CLAUDE_CODEX_NATIVE_CODEX: '',
    ...extra,
  }
  const client = launchAdapter(env)
  closers.push(() => client.close())
  return client
}

const argvOf = (root: string) => (JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8')) as { argv: string[] }).argv.join(' ')

test('adapter: native path = router URL, no anyengine server, no instruction', async () => {
  const root = await tempDir('ae-ln-')
  markProven(root, 'native-fanout', 'test', proofKey(root))
  const client = adapterWith(root, await fakeRouter('native'))
  await client.request('initialize', { clientInfo: { name: 't', version: '0' } })
  const started = await client.request('thread/start', { model: 'gpt-6-sol', developerInstructions: 'Be terse.' })
  assert.equal(started.result.receivedDeveloperInstructions, 'Be terse.')
  assert.match(argvOf(root), /openai_base_url=/)
  assert.doesNotMatch(argvOf(root), /mcp_servers\.anyengine/)
})

test('adapter: bridge path = router URL, the anyengine server, exactly one line', async () => {
  for (const [router, prove] of [['bridge', true], ['native', false]] as const) {
    // The router says bridge, or it says native but native is not proven:
    // either way the GPT child keeps the bridge.
    const root = await tempDir('ae-ln-')
    if (prove) markProven(root, 'native-fanout', 'test', proofKey(root))
    const client = adapterWith(root, await fakeRouter(router))
    await client.request('initialize', { clientInfo: { name: 't', version: '0' } })
    const started = await client.request('thread/start', { model: 'gpt-6-sol', developerInstructions: 'Be terse.' })
    assert.equal(started.result.receivedDeveloperInstructions, `Be terse.\n\n${BRIDGE_LINE_GPT}`, router)
    assert.match(argvOf(root), /openai_base_url=/)
    assert.match(argvOf(root), /mcp_servers\.anyengine/)
    await client.close()
  }
})

test('adapter: model mode sends a Claude thread to the codex child; agent mode keeps it local', async () => {
  const root = await tempDir('ae-ln-')
  writeFileSync(join(root, 'config.json'), JSON.stringify({ modes: { codexClaude: 'model' } }))
  markProven(root, 'native-fanout', 'test', proofKey(root))
  const client = adapterWith(root, await fakeRouter('native'))
  await client.request('initialize', { clientInfo: { name: 't', version: '0' } })
  await client.request('thread/start', { model: 'opus' })
  const upstream = readFileSync(join(root, 'requests.jsonl'), 'utf8')
  assert.match(upstream, /"method":"thread\/start".*"model":"opus"/)
  const agentRoot = await tempDir('ae-ln-')
  const local = adapterWith(agentRoot, await fakeRouter('native'))
  await local.request('initialize', { clientInfo: { name: 't', version: '0' } })
  await local.request('thread/start', { model: 'opus' })
  assert.doesNotMatch(readFileSync(join(agentRoot, 'requests.jsonl'), 'utf8'), /"model":"opus"/)
})
```

(`FAKE_CODEX_REQUESTS_FILE` already makes the fake write one JSON line per request; `receivedDeveloperInstructions` is what the fake echoes from `thread/start`, as `test/bridge.test.mts` uses.)

- [ ] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/router-link.mjs'`.

- [ ] **Step 3: Write the link**

The proof itself is Task 9's (`proven.json`, keyed on the lib, app, codex and settings). The link reads it with the adapter's own key, `proofKey(root)`: the lib `current` names, the app's and its codex's versions, and `config.json` (in tests `ANYENGINE_CHATGPT_APP` points nowhere, so the versions are null on both sides).

Create `src/router-link.mts`:

```ts
// Adapter side of the router (decision D1). Before the real codex child
// spawns, the adapter asks the router's /health (500 ms). Only a router that
// is enabled, answers, and is not marked degraded is attached, with
// `-c openai_base_url=<router>` on the child; otherwise the child talks to
// chatgpt.com directly and a dead router costs nothing but Claude in the
// catalog. The fan-out path decided at that moment holds for the child's life
// (the anyengine MCP server is fixed at spawn), and decides both what the GPT
// child is given (decision D5) and where Claude threads go in model mode. It
// is native only when the router says native, the smoke has not marked
// native-fanout degraded, and a native fan-out check has proven it since the
// last change (H1); otherwise the GPT child keeps the bridge.
import { anyengineRoot, loadConfig, routerBaseUrl } from './anyengine-config.mjs'
import { BRIDGE_LINE_GPT } from './bridge-instructions.mjs'
import { isProven, proofKey, readDegraded } from './degraded.mjs'
import type { FanoutPath } from './router-fanout.mjs'
import { debugLog } from './util.mjs'

export interface RouterLinkState {
  attached: boolean
  url: string | null
  fanout: FanoutPath
  reason: string
  checkedAt: string
}

let state: RouterLinkState = { attached: false, url: null, fanout: 'bridge', reason: 'not linked', checkedAt: '' }
let root = anyengineRoot()

export function currentRouterLink(): RouterLinkState {
  return state
}

export function nativeFanout(): boolean {
  return state.attached && state.fanout === 'native'
}

export function routerServesClaude(): boolean {
  return nativeFanout() && loadConfig(root).modes.codexClaude === 'model'
}

// The line a GPT thread gets: none on the native path (spec 3), the bridge
// line when the bridge server is attached to the child and native spawn
// cannot start Claude.
export function gptBridgeLine(bridgeAttached: boolean): string | null {
  return bridgeAttached && !nativeFanout() ? BRIDGE_LINE_GPT : null
}

export function appOpenaiBaseUrl(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    const value = arg === '-c' || arg === '--config' ? (argv[i + 1] ?? '') : /^(-c|--config)=(.*)$/.exec(arg)?.[2] ?? ''
    const match = /^openai_base_url\s*=\s*"?([^"]*)"?$/.exec(value)
    if (match?.[1]) return match[1]
  }
  return null
}

async function health(url: string, timeoutMs: number): Promise<{ fanout: FanoutPath; reason: string } | null> {
  try {
    const answer = await fetch(url.replace(/\/backend-api\/codex$/, '/health'), { signal: AbortSignal.timeout(timeoutMs) })
    if (!answer.ok) return null
    const body = (await answer.json()) as { ok?: unknown; fanout?: { path?: unknown; reason?: unknown } }
    if (body.ok !== true) return null
    const path = body.fanout?.path === 'native' ? 'native' : 'bridge'
    return { fanout: path, reason: typeof body.fanout?.reason === 'string' ? body.fanout.reason : '' }
  } catch {
    return null
  }
}

export async function linkRouter(
  argv: string[],
  options: { root?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ state: RouterLinkState; configArgs: string[] }> {
  const env = options.env ?? process.env
  root = options.root ?? anyengineRoot(env)
  const config = loadConfig(root)
  const named = (env.ANYENGINE_ROUTER_URL ?? '').trim()
  const url = named || routerBaseUrl(config)
  const fromApp = appOpenaiBaseUrl(argv)
  const checkedAt = new Date().toISOString()
  const out = (attached: boolean, fanout: FanoutPath, reason: string, args: string[]) => {
    state = { attached, url: attached ? url : null, fanout, reason, checkedAt }
    debugLog('router.link', { ...state })
    return { state, configArgs: args }
  }
  if (!config.router.enabled && !named) return out(false, 'bridge', 'router.enabled is false', [])
  if (fromApp && fromApp !== url) return out(false, 'bridge', `the app passes its own openai_base_url (${fromApp})`, [])
  const degraded = readDegraded(root).paths.router
  if (degraded) return out(false, 'bridge', `the smoke marked the router degraded: ${degraded.reason}`, [])
  const answer = await health(url, options.timeoutMs ?? 500)
  if (!answer) return out(false, 'bridge', `the router did not answer at ${url} within ${options.timeoutMs ?? 500} ms`, [])
  const args = fromApp ? [] : ['-c', `openai_base_url="${url}"`]
  return out(true, ...fanoutFor(answer), args)
}

function fanoutFor(answer: { fanout: FanoutPath; reason: string }): [FanoutPath, string] {
  if (answer.fanout !== 'native') return ['bridge', answer.reason]
  const degraded = readDegraded(root).paths['native-fanout']
  if (degraded) return ['bridge', `the smoke marked native fan-out degraded: ${degraded.reason}`]
  if (!isProven(root, 'native-fanout', proofKey(root))) return ['bridge', 'native fan-out is not proven for this lib, app, codex and settings (the smoke, or the switch-on pre-proof)']
  return ['native', answer.reason]
}
```

- [ ] **Step 4: One line of instruction**

In `src/bridge-instructions.mts`:

1. Replace the body of `bridgeInstructions` so it returns `BRIDGE_LINE` (rename its parameter `_catalog`; the file's header comment now says "one line").
2. Replace `appendBridgeInstructions` with:

```ts
// Appends one line to existing instructions; idempotent, so a resend
// (thread/resume, per-turn overrides) never stacks two copies.
export function appendBridgeInstructions(
  existing: string | null | undefined,
  _catalog: BridgeCatalogModel[],
  line: string = BRIDGE_LINE,
): string {
  const base = (existing ?? '').trim()
  if (base.includes(line)) return base
  return base ? `${base}\n\n${line}` : line
}
```

3. Delete `BRIDGE_INSTRUCTIONS_HEADING`, `PROVIDER_LABEL`, `PROVIDER_ORDER` and `MAX_IDS_PER_PROVIDER` if nothing else uses them (`grep -rn` first).

In `src/bridge-mcp.mts`, delete the `instructions:` property of the `initialize` result (line 311): the tool descriptions carry the details and the one line names the tool.

- [ ] **Step 5: Route by mode, inject by path**

In `src/rehome.mts`, add below `engineForModel`:

```ts
// The engine a model runs on in this adapter: a Claude model runs on the
// codex child (the router's trampoline) while model mode is on and the native
// path is up (src/router-link.mts); otherwise as engineForModel says.
export function engineForModelRouted(model: string | null | undefined): Engine {
  const engine = engineForModel(model)
  return engine === 'claude' && routerServesClaude() ? 'gpt' : engine
}
```

(import `routerServesClaude` from `./router-link.mjs`).

In `src/codex-mux.mts`:

1. `routeForModel`: replace `if (isClaudeModelId(id)) return 'local'` with `if (isClaudeModelId(id)) return routerServesClaude() ? 'upstream' : 'local'`.
2. In `prepareEngineSwitch`, replace `const to = engineForModel(model)` with `const to = engineForModelRouted(model)`.
3. Replace the `bridgeCatalog` option with `bridgeLine?: () => string | null` (field, constructor and `NativeCodexMuxOptions`), and `withBridgeInstructions` with:

```ts
  private withBridgeInstructions(request: JsonRpcRequest): JsonRpcRequest {
    const line = this.bridgeLine?.() ?? null
    if (!line) return request
    const params = asRecord(request.params)
    const existing = typeof params.developerInstructions === 'string' ? params.developerInstructions : null
    return { ...request, params: { ...params, developerInstructions: appendBridgeInstructions(existing, [], line) } }
  }
```

Run: `wc -l src/codex-mux.mts`; expected at or below the baseline.

In `src/server.mts`, in `attachNativeCodex`, replace the one line `bridgeCatalog: () => this.bridgeCatalogForInstructions(),` with `bridgeLine: () => (this.bridgeCatalogForInstructions() ? gptBridgeLine(this.childHasBridge) : null),` and add the field `childHasBridge = false` set by `attachNativeCodex` from a new option `bridgeOnChild: boolean`. Keep `server.mts` at or below 3798 lines: keep the `appendBridgeInstructions` import (the addendum call at line 2180 still uses it) and fold the two new lines into existing ones where Biome allows; if it still grows, move `localModelOptions` (lines 451-459) into `src/bridge-instructions.mts` as an exported function taking the default model (not into `src/server-helpers.mts`, which is baselined too).

In `src/adapter.mts`, before `server.attachNativeCodex`:

```ts
  // Decision D1: the router is attached only if it is healthy right now.
  const link = nativeCodexBinary ? await linkRouter([...codexGlobals, ...args]) : null
  const bridgeOnChild = bridge != null && !nativeFanout()
```

and pass `args: childArgv(codexGlobals, [...(bridgeOnChild && bridge ? bridge.codexConfigArgs() : []), ...(link?.configArgs ?? [])], stripListenArgs(args))`, `bridgeOnChild`, and the bridge env only when `bridgeOnChild`.

- [ ] **Step 6: Move the existing tests to the single line**

In `test/bridge.test.mts` (lines 1317-1335 and 1373-1400) and `test/grok-runtime.test.mts` (line 647), replace the heading assertions: `bridgeInstructions(...)` equals `BRIDGE_LINE`; `appendBridgeInstructions('Avoid SELECT *.', ALIAS_CATALOG)` equals `` `Avoid SELECT *.\n\n${BRIDGE_LINE}` `` and is idempotent; the Claude addendum contains `BRIDGE_LINE` once; the GPT child's `receivedDeveloperInstructions` start with `` `Be terse.\n\n${BRIDGE_LINE_GPT}` `` (no router in these suites, so the bridge path) and contain the line once; the grok prompt starts with `` `${BRIDGE_LINE}\n` ``. Delete assertions about the removed MCP `instructions` text.

- [ ] **Step 7: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/router-link.test.mjs dist/test/bridge.test.mjs dist/test/grok-runtime.test.mjs dist/test/codex-mux.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 8: Docs, gates, commit**

In `docs/guide/configuration.md` reference table add: `| \`ANYENGINE_ROUTER_URL\` | Router base URL the adapter checks and attaches instead of the configured port (probes, tests). |`. In `docs/guide/bridge.md`, replace the description of the standing instructions with: "AnyEngine adds one line, not a block: Claude and Grok threads get `BRIDGE_LINE` in their system prompt; a GPT thread gets `BRIDGE_LINE_GPT` in its developer instructions only when native `spawn_agent` cannot start Claude (the bridge path, see the router guide). On the native path GPT threads get neither the line nor the `anyengine` MCP server."

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/router-link.mts src/adapter.mts src/codex-mux.mts src/rehome.mts \
  src/bridge-instructions.mts src/bridge-mcp.mts src/server.mts test/router-link.test.mts \
  test/bridge.test.mts test/grok-runtime.test.mts docs/guide/configuration.md docs/guide/bridge.md \
  scripts/size-baseline.json
git commit -m "feat: attach a healthy router to the codex child and inject at most one line"
```

**Acceptance:** a router that does not answer within 500 ms is not attached and the child argv carries no `openai_base_url`; native fan-out is taken only when the router says native, `native-fanout` is not degraded and a check has proven it; on the native path the GPT child has neither the `anyengine` server nor an instruction; whenever native is not proven it has both, one line; in model mode a Claude `thread/start` reaches the codex child, in agent mode it does not.

---
### Task 19: The seam to the Mac, the flip marker, logs and the models cache

Everything the control commands do to the Mac goes through one seam (`System`: launchd, the app's version, quitting and opening it, the process list, notifications), so tests never touch launchd, the app or the real processes; a fake stands in for it. This task adds that seam and the small read-mostly pieces the later control tasks share: the flip marker every flip writes and `status` shows (decision D17), the reader for the end of a JSONL log, and the models-cache inspector and cleaner. The commands that use them are Tasks 20 and 21.

**Files:**
- Create: `src/control-system.mts`, `src/control-marker.mts`, `src/control-logs.mts`, `src/control-cache.mts`
- Create: `test/helpers/fake-system.mts`, `test/control-seam.test.mts`
- Modify: `scripts/test-hermetic.mjs` (the tools that change the Mac are refused in tests), `docs/guide/configuration.md`, `src/AGENTS.md`

**Interfaces:**
- Consumes: `anyengine-config.mts` (`enginePaths`, `writeJsonAtomic`), `router-catalog.mts` (`isAnyEngineEntry`).
- Produces:

```ts
// src/control-system.mts
export interface ExecResult { status: number | null; stdout: string; stderr: string }
export interface System {
  readonly home: string
  readonly app: string                              // /Applications/ChatGPT.app unless ANYENGINE_CHATGPT_APP
  now(): Date
  exec(command: string, args: string[], options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string }): ExecResult
  appVersion(): string | null                       // CFBundleShortVersionString
  appRunning(): boolean
  quitApp(timeoutMs?: number): boolean              // true once the app is gone
  openApp(): void
  launchctl(args: string[]): ExecResult
  processes(): Array<{ pid: number; ppid: number; command: string }>
  notify(title: string, message: string): void
  sleep(ms: number): Promise<void>
}
export function realSystem(env?: NodeJS.ProcessEnv): System
export function adapterProcesses(system: System): Array<{ pid: number; version: string | null; command: string }>
export function ancestorCommands(system: System, pid: number): string[]   // the ppid chain above pid, nearest first

// src/control-marker.mts (decision D17; written by Task 26)
export type FlipOp = 'on' | 'off' | 'restart'
export interface FlipMarker { id: string; op: FlipOp; args: string[]; pid: number; runner: 'detached' | 'foreground'; phase: string; startedAt: string; updatedAt: string; log: string; state: Record<string, unknown> }   // state: what the engine needs to resume (Task 26)
export function flipMarkerPath(root: string): string                 // <state>/flip.json
export function readFlipMarker(root: string): FlipMarker | null
export function writeFlipMarker(root: string, marker: FlipMarker): void   // atomic
export function clearFlipMarker(root: string): void
export function markerAlive(marker: FlipMarker, system: System): boolean  // its pid runs `flip-run` (detached) or `adapter.mjs` (a --foreground flip)

// src/control-logs.mts
export function tailJsonl(path: string, maxBytes?: number): Array<Record<string, unknown>>   // last lines, newest last
export function lastEvent(events: Array<Record<string, unknown>>, names: RegExp, pid?: number): Record<string, unknown> | null

// src/control-cache.mts
export interface CacheReport { path: string; exists: boolean; clientVersion: string | null; models: number; anyengine: string[]; parseError: string | null }
export function inspectModelsCache(codexHome: string, claudeIds: ReadonlySet<string>): CacheReport
export function cleanModelsCache(codexHome: string, claudeIds: ReadonlySet<string>, backupDir: string | null): { removed: boolean; report: CacheReport }
```

- [ ] **Step 1: Write the seam and its fake**

Create `src/control-system.mts`:

```ts
// Everything the control CLI does to the Mac goes through here: launchd, the
// app's version, quitting and opening it, the process list, notifications.
// Absolute paths, so launchd's minimal PATH and a hostile PATH find the
// system's own tools. Tests pass test/helpers/fake-system.mts instead.
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ExecResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface System {
  readonly home: string
  readonly app: string
  now(): Date
  exec(command: string, args: string[], options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string }): ExecResult
  appVersion(): string | null
  appRunning(): boolean
  quitApp(timeoutMs?: number): boolean
  openApp(): void
  launchctl(args: string[]): ExecResult
  processes(): Array<{ pid: number; ppid: number; command: string }>
  notify(title: string, message: string): void
  sleep(ms: number): Promise<void>
}

function run(command: string, args: string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {}): ExecResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 64 * 1024 * 1024,
    ...(options.env ? { env: options.env } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? String(result.error ?? '') }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// ANYENGINE_LAUNCHCTL, ANYENGINE_OSASCRIPT and ANYENGINE_OPEN replace the
// three tools that change the Mac; the hermetic test runner points them at a
// stub that refuses, so no test can ever reach the real launchd or the app.
export function realSystem(env: NodeJS.ProcessEnv = process.env): System {
  const app = env.ANYENGINE_CHATGPT_APP || '/Applications/ChatGPT.app'
  const launchctl = env.ANYENGINE_LAUNCHCTL || '/bin/launchctl'
  const osascript = env.ANYENGINE_OSASCRIPT || '/usr/bin/osascript'
  const open = env.ANYENGINE_OPEN || '/usr/bin/open'
  const appRunning = () => run('/usr/bin/pgrep', ['-x', 'ChatGPT']).status === 0
  return {
    home: homedir(),
    app,
    now: () => new Date(),
    exec: run,
    appVersion: () => {
      const out = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')])
      return out.status === 0 ? out.stdout.trim() : null
    },
    appRunning,
    quitApp: (timeoutMs = 30_000) => {
      run(osascript, ['-e', 'quit app "ChatGPT"'])
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (!appRunning()) return true
        sleepSync(500)
      }
      return !appRunning()
    },
    openApp: () => {
      run(open, ['-a', app])
    },
    launchctl: (args) => run(launchctl, args),
    processes: () =>
      run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command=']).stdout.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '' }] : []
      }),
    notify: (title, message) => {
      const quote = (s: string) => `"${s.replace(/["\\]/g, ' ').slice(0, 200)}"`
      run(osascript, ['-e', `display notification ${quote(message)} with title ${quote(title)}`])
    },
    sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
  }
}

// Adapters the app (or codex-web, or `anyengine codex`) is running, and the
// installed lib version each loaded (its argv names the version directory;
// the shim resolves lib/current before it launches one).
export function adapterProcesses(system: System): Array<{ pid: number; version: string | null; command: string }> {
  return system.processes().flatMap(({ pid, command }) => {
    if (!/adapter\.mjs\b/.test(command) || !/\bapp-server\b/.test(command) || /bridge-mcp/.test(command)) return []
    const version = /\.anyengine\/lib\/([^/]+)\/dist\/src\/adapter\.mjs/.exec(command)?.[1] ?? null
    return [{ pid, version, command }]
  })
}

// The commands of every process above `pid`, nearest first. A flip must not
// run inside the app it restarts (Task 26): quitting ChatGPT.app would take
// the flip down with it.
export function ancestorCommands(system: System, pid: number): string[] {
  const byPid = new Map(system.processes().map((p) => [p.pid, p]))
  const out: string[] = []
  let current = byPid.get(pid)?.ppid ?? 0
  for (let hops = 0; current > 1 && hops < 64; hops += 1) {
    const parent = byPid.get(current)
    if (!parent) break
    out.push(parent.command)
    current = parent.ppid
  }
  return out
}
```

Create `test/helpers/fake-system.mts`:

```ts
import { join } from 'node:path'
import type { ExecResult, System } from '../../src/control-system.mjs'

// A Mac that exists only in memory: the app's version (and what it becomes
// after a relaunch, for staged updates), whether it runs, launchd jobs, the
// process list, and a record of everything asked of it.
export interface FakeSystem extends System {
  calls: string[]
  version: string | null
  versionAfterRelaunch: string | null
  running: boolean
  jobs: Map<string, { plist: string; pid: number | null }>
  procs: Array<{ pid: number; ppid: number; command: string }>
  notifications: Array<{ title: string; message: string }>
  execs: Map<string, ExecResult>   // key: `${command} ${args.join(' ')}`
  onOpen: (() => void) | null
}

export function fakeSystem(home: string): FakeSystem {
  const fake: FakeSystem = {
    home,
    app: join(home, 'Applications', 'ChatGPT.app'),
    calls: [],
    version: '26.928.20755',
    versionAfterRelaunch: null,
    running: true,
    jobs: new Map(),
    procs: [],
    notifications: [],
    execs: new Map(),
    onOpen: null,
    // Advances a minute per recorded call, so evidence of one relaunch is
    // never mistaken for the next one's.
    now: () => new Date(Date.parse('2026-10-01T00:00:00Z') + fake.calls.length * 60_000),
    exec(command, args) {
      fake.calls.push(`exec ${command} ${args.join(' ')}`)
      return fake.execs.get(`${command} ${args.join(' ')}`) ?? { status: 0, stdout: '', stderr: '' }
    },
    appVersion: () => fake.version,
    appRunning: () => fake.running,
    quitApp() {
      fake.calls.push('quitApp')
      fake.running = false
      if (fake.versionAfterRelaunch) fake.version = fake.versionAfterRelaunch
      return true
    },
    openApp() {
      fake.calls.push('openApp')
      fake.running = true
      fake.onOpen?.()
    },
    launchctl(args) {
      fake.calls.push(`launchctl ${args.join(' ')}`)
      const [verb, target, plist] = args
      const label = (target ?? '').split('/').pop() ?? ''
      if (verb === 'print') {
        const job = fake.jobs.get(label)
        return job ? { status: 0, stdout: `pid = ${job.pid ?? 0}\n`, stderr: '' } : { status: 113, stdout: '', stderr: '' }
      }
      if (verb === 'bootstrap' && plist) fake.jobs.set(plist.split('/').pop()?.replace(/\.plist$/, '') ?? '', { plist, pid: 4242 })
      if (verb === 'bootout') fake.jobs.delete(label)
      return { status: 0, stdout: '', stderr: '' }
    },
    processes: () => fake.procs,
    notify(title, message) {
      fake.notifications.push({ title, message })
    },
    sleep: async () => {},
  }
  return fake
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/control-seam.test.mts`:

```ts
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { cleanModelsCache, inspectModelsCache } from '../src/control-cache.mjs'
import { markerAlive, readFlipMarker, writeFlipMarker } from '../src/control-marker.mjs'
import { ancestorCommands } from '../src/control-system.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

const CLAUDE = new Set(['opus', 'sonnet', 'haiku'])
const cache = (models: unknown[]) => JSON.stringify({ client_version: '0.159.0', etag: '"e"', fetched_at: 'now', models })

test('cache clean leaves a clean cache alone', async () => {
  const home = await tempDir('anyengine-cache-')
  writeFileSync(join(home, 'models_cache.json'), cache([{ slug: 'gpt-6-sol', description: 'x' }]))
  const { removed, report } = cleanModelsCache(home, CLAUDE, null)
  assert.equal(removed, false)
  assert.deepEqual(report.anyengine, [])
  assert.ok(existsSync(join(home, 'models_cache.json')))
})

test('cache clean removes a cache with AnyEngine entries, keeps a copy, and is idempotent', async () => {
  const home = await tempDir('anyengine-cache-')
  const backup = await tempDir('anyengine-cache-bk-')
  writeFileSync(join(home, 'models_cache.json'), cache([{ slug: 'gpt-6-sol' }, { slug: 'opus', description: 'Claude Opus, on your Claude plan, via AnyEngine' }]))
  assert.deepEqual(inspectModelsCache(home, CLAUDE).anyengine, ['opus'])
  const first = cleanModelsCache(home, CLAUDE, backup)
  assert.equal(first.removed, true)
  assert.ok(!existsSync(join(home, 'models_cache.json')))
  assert.match(readFileSync(join(backup, 'models_cache.json'), 'utf8'), /opus/)
  assert.equal(cleanModelsCache(home, CLAUDE, backup).removed, false)
  writeFileSync(join(home, 'models_cache.json'), '{broken')
  const broken = cleanModelsCache(home, CLAUDE, backup)
  assert.equal(broken.removed, false)
  assert.ok(broken.report.parseError)
})

test('the flip marker round-trips, and ancestors are found through ppid', async () => {
  const home = await tempDir('anyengine-marker-')
  const root = join(home, '.anyengine')
  assert.equal(readFlipMarker(root), null)
  const marker = { id: 'f2', op: 'off' as const, args: [], pid: 5, runner: 'detached' as const, phase: 'restore-files', startedAt: 'a', updatedAt: 'b', log: 'l', state: { routerLayerWasNew: true } }
  writeFlipMarker(root, marker)
  assert.deepEqual(readFlipMarker(root), marker)
  const system = fakeSystem(home)
  system.procs = [
    { pid: 100, ppid: 1, command: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' },
    { pid: 200, ppid: 100, command: 'codex app-server' },
    { pid: 300, ppid: 200, command: 'node adapter.mjs on' },
  ]
  assert.deepEqual(ancestorCommands(system, 300), ['codex app-server', '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'])
  assert.deepEqual(ancestorCommands(system, 100), [])
  system.procs = [{ pid: 5, ppid: 1, command: 'node /x/dist/src/adapter.mjs flip-run f2 off' }]
  assert.equal(markerAlive(marker, system), true)
  assert.equal(markerAlive({ ...marker, runner: 'foreground' }, { ...system, processes: () => [{ pid: 5, ppid: 1, command: 'node /x/dist/src/adapter.mjs off --foreground' }] }), true, 'a --foreground flip is alive too')
  system.procs = []
  assert.equal(markerAlive(marker, system), false)
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/control-cache.mjs'`.

- [ ] **Step 4: Write the cache cleaner, the log reader and the flip marker**

Create `src/control-cache.mts`:

```ts
// ~/.codex/models_cache.json is shared by every codex on the Mac. Its identity
// includes the resolved base URL and the client version, so the router's
// catalog, which the app's codex writes there while it talks to the router, is
// ignored by a codex that talks to chatgpt.com (decision D9). `anyengine off`
// and `anyengine cache clean` still remove the file when it holds an AnyEngine
// entry, so nothing of the router outlives it: codex rebuilds it from the real
// backend on its next fetch.
// A clean file is left alone, a file that does not parse is left alone and
// reported, and a copy goes to the rollback directory first.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isAnyEngineEntry } from './router-catalog.mjs'

export interface CacheReport {
  path: string
  exists: boolean
  clientVersion: string | null
  models: number
  anyengine: string[]
  parseError: string | null
}

export function inspectModelsCache(codexHome: string, claudeIds: ReadonlySet<string>): CacheReport {
  const path = join(codexHome, 'models_cache.json')
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { path, exists: false, clientVersion: null, models: 0, anyengine: [], parseError: null }
  }
  try {
    const parsed = JSON.parse(text) as { client_version?: unknown; models?: unknown }
    const models = Array.isArray(parsed.models) ? (parsed.models as Array<Record<string, unknown>>) : []
    return {
      path,
      exists: true,
      clientVersion: typeof parsed.client_version === 'string' ? parsed.client_version : null,
      models: models.length,
      anyengine: models.filter((m) => isAnyEngineEntry(m, claudeIds)).map((m) => String(m.slug)),
      parseError: null,
    }
  } catch (error) {
    return { path, exists: true, clientVersion: null, models: 0, anyengine: [], parseError: error instanceof Error ? error.message : String(error) }
  }
}

export function cleanModelsCache(
  codexHome: string,
  claudeIds: ReadonlySet<string>,
  backupDir: string | null,
): { removed: boolean; report: CacheReport } {
  const report = inspectModelsCache(codexHome, claudeIds)
  if (!report.exists || report.parseError || report.anyengine.length === 0) return { removed: false, report }
  if (backupDir) {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    copyFileSync(report.path, join(backupDir, 'models_cache.json'))
  }
  rmSync(report.path, { force: true })
  return { removed: true, report }
}
```

Create `src/control-logs.mts`:

```ts
// Reads the end of a JSONL log (the adapter's debug log can be 50 MB): the
// last `maxBytes`, parsed line by line, junk skipped, newest last.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

export function tailJsonl(path: string, maxBytes = 2_000_000): Array<Record<string, unknown>> {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return []
  }
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    return lines.flatMap((line) => {
      try {
        const value = JSON.parse(line)
        return value && typeof value === 'object' ? [value as Record<string, unknown>] : []
      } catch {
        return []
      }
    })
  } finally {
    closeSync(fd)
  }
}

export function lastEvent(events: Array<Record<string, unknown>>, names: RegExp, pid?: number): Record<string, unknown> | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event || !names.test(String(event.event ?? ''))) continue
    if (pid !== undefined && event.pid !== pid) continue
    return event
  }
  return null
}
```

Create `src/control-marker.mts` with the interface above: `flipMarkerPath(root)` is `<enginePaths(root).state>/flip.json`; writes go through `writeJsonAtomic` (0600); `readFlipMarker` returns null for a missing or unreadable file; `markerAlive` is true when `system.processes()` has the marker's pid and its command contains `flip-run` (`runner: 'detached'`) or `adapter.mjs` (`runner: 'foreground'`, a flip run with `--foreground` in the caller's own process). Header comment: "A flip (`on`, `off`, `restart`) in progress. Task 26 writes it before the first change and removes it after the last check; `status` shows it, `doctor` fails on a dead one (Task 21), and `on`/`off` resume from it (decision D17)."

- [ ] **Step 5: Refuse the Mac in tests**

In `scripts/test-hermetic.mjs`, write a stub `<root>/bin/refuse` (`#!/bin/sh`, `echo "refused in tests: $0 $*" >&2`, `exit 1`, mode 755) and add `ANYENGINE_LAUNCHCTL`, `ANYENGINE_OSASCRIPT` and `ANYENGINE_OPEN` pointing at it to the suite environment, so neither `realSystem()` nor a generated rollback script (Task 23) can reach the real launchd or the app from a test. Document the three names in `docs/guide/configuration.md` ("Set by tests; replace the tools that change the Mac").

- [ ] **Step 6: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/control-seam.test.mjs`
Expected: PASS, `ℹ pass 3`, `ℹ fail 0`.

- [ ] **Step 7: Gates, commit**

Add the four modules to `src/AGENTS.md`.

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/control-system.mts src/control-marker.mts src/control-logs.mts src/control-cache.mts \
  test/helpers/fake-system.mts test/control-seam.test.mts scripts/test-hermetic.mjs docs/guide/configuration.md src/AGENTS.md
git commit -m "feat: add the control seam to the Mac, the flip marker and the models-cache cleaner"
```

**Acceptance:** the fake system stands in for every Mac action; `cache clean` removes the cache only when it holds AnyEngine entries and keeps a copy; the flip marker round-trips, and a detached or a `--foreground` flip counts as alive while its process runs; in tests, the tools that change the Mac are refused.

---
### Task 20: `anyengine status`, `mode`, `config`, the CLI and the launcher

Spec 5.7: `anyengine status` "Shows active paths (native fan-out or bridge fallback), modes, the active account, and router, adapter and app versions". This task adds the command dispatch every later control command registers with, `status`, `mode`, `config get|set`, `cache clean`, and the bash launcher launchd and the operator use (`~/.anyengine/bin/anyengine`). `doctor` is Task 21.

**Files:**
- Create: `src/control-cli.mts`, `src/control-commands.mts`, `src/control-status.mts`, `scripts/anyengine-launch`, `test/control-read.test.mts`
- Modify: `src/adapter.mts` (dispatch the control commands), `package.json` (`scripts.anyengine`), `docs/guide/control.md` (new), `docs/.vitepress` sidebar if it lists guides, `scripts/AGENTS.md`, `src/AGENTS.md`

**Interfaces:**
- Consumes: Task 19 (`System`, `adapterProcesses`, `tailJsonl`, `lastEvent`, `inspectModelsCache`, `cleanModelsCache`, `readFlipMarker`, `markerAlive`), `anyengine-config.mts`, `router-fanout.mts` (`readRouterStatus`), `degraded.mts` (`readDegraded`, `readProof`), `bundled-codex.mts` (`resolveBundledCodex`), `util.mts` (`codexHome`, `adapterHome`).
- Produces:

```ts
// src/control-status.mts
export interface StatusReport { /* fields listed in Step 5 */ }
export function gatherStatus(system: System, root: string): Promise<StatusReport>
export function formatStatus(report: StatusReport): string

// src/control-cli.mts
export type Say = (text: string) => void
export type Command = (args: string[], system: System, root: string, say: Say) => Promise<number>
export const CONTROL_COMMANDS: ReadonlySet<string>   // on off restart status doctor mode config cache smoke codex
export function registerCommand(name: string, command: Command): void
export function runControl(argv: string[], system?: System, root?: string, say?: Say): Promise<number>   // exit code
```

- [ ] **Step 1: Write the failing tests**

Create `test/control-read.test.mts`:

```ts
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { enginePaths } from '../src/anyengine-config.mjs'
import { runControl } from '../src/control-cli.mjs'
import { writeFlipMarker } from '../src/control-marker.mjs'
import { formatStatus, gatherStatus } from '../src/control-status.mjs'
import { adapterProcesses } from '../src/control-system.mjs'
import { isProven, markDegraded, markProven, proofKey } from '../src/degraded.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

test('status names paths, modes, versions, the fan-out path and degraded paths', async () => {
  const home = await tempDir('anyengine-status-')
  const root = join(home, '.anyengine')
  mkdirSync(enginePaths(root).state, { recursive: true })
  writeFileSync(
    enginePaths(root).routerStatus,
    JSON.stringify({ pid: 1, version: '0.1.0-abc', port: 18790, startedAt: 'x', mode: 'agent', fanout: { path: 'bridge', reason: 'router.multiAgentV1 is false', since: 'x' }, writtenAt: 'x' }),
  )
  markDegraded(root, 'native-fanout', 'smoke: spawn_agent with opus did not answer')
  const system = fakeSystem(home)
  system.procs = [{ pid: 77, ppid: 1, command: `node ${home}/.anyengine/lib/0.1.0-abc123/dist/src/adapter.mjs app-server --analytics-default-enabled` }]
  writeFlipMarker(root, { id: 'f1', op: 'on', args: ['--yes'], pid: 999999, phase: 'quit-app', startedAt: 'x', updatedAt: 'x', runner: 'detached', log: join(root, 'state', 'flip-f1.log'), state: {} })
  assert.deepEqual(adapterProcesses(system).map((p) => p.version), ['0.1.0-abc123'])
  const report = await gatherStatus(system, root)
  assert.equal(report.mode, 'agent')
  assert.equal(report.router.lastStatus?.fanout.path, 'bridge')
  assert.equal(report.app.version, '26.928.20755')
  assert.ok('native-fanout' in report.degraded.paths)
  assert.equal(report.flip?.op, 'on')
  assert.equal(report.flip?.alive, false)
  assert.match(formatStatus(report), /flip\s+on interrupted at quit-app: run `anyengine on` or `anyengine off` to finish/)
  let printed = ''
  const code = await runControl(['status', '--json'], system, root, (text) => {
    printed += text
  })
  assert.equal(code, 0)
  assert.equal(JSON.parse(printed).router.lastStatus.fanout.reason, 'router.multiAgentV1 is false')
})

test('mode and config write config.json and refuse nonsense', async () => {
  const home = await tempDir('anyengine-mode-')
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const out: string[] = []
  const say = (text: string) => out.push(text)
  assert.equal(await runControl(['mode', 'codex-claude', 'model'], system, root, say), 0)
  assert.match(out.join(''), /grey/i)
  assert.equal(JSON.parse(readFileSync(enginePaths(root).config, 'utf8')).modes.codexClaude, 'model')
  assert.equal(await runControl(['mode', 'codex-claude', 'both'], system, root, say), 2)
  assert.equal(await runControl(['mode', 'claude-gpt', 'model'], system, root, say), 2)
  assert.equal(await runControl(['config', 'set', 'router.port', '80'], system, root, say), 2)
  assert.equal(await runControl(['config', 'get', 'router.port'], system, root, say), 0)
  assert.match(out.at(-1) ?? '', /18790/)
  markProven(root, 'native-fanout', 'test', proofKey(root))
  assert.equal(await runControl(['config', 'set', 'router.multiAgentV1', 'false'], system, root, say), 0)
  assert.equal(isProven(root, 'native-fanout', proofKey(root)), false, 'the proof is keyed on the settings: a router or mode change must be proven again')
  assert.match(out.join(''), /native fan-out must be proven again/)
})

```

(`runControl` takes an optional fourth argument, the writer for stdout, so tests can read what it prints.)

- [ ] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/control-cli.mjs'`.

- [ ] **Step 3: Write status**

Create `src/control-status.mts`. `StatusReport` has exactly these fields, and `gatherStatus` fills them read-only:

```ts
export interface StatusReport {
  lib: { current: string | null }                       // readlink ~/.anyengine/lib/current
  layers: string[]                                      // names in state/layers.json (Task 22), [] when absent
  app: { path: string; version: string | null; codex: string | null; knownGood: string | null }
  adapters: Array<{ pid: number; version: string | null; link: Record<string, unknown> | null; codexChild: 'running' | 'unavailable' | 'unknown' }>
  router: { job: 'loaded' | 'not loaded'; health: Record<string, unknown> | null; lastStatus: RouterStatusFile | null }
  mode: CodexClaudeMode
  modeNote: string | null                               // e.g. "model mode is inactive: the fan-out path is bridge"
  degraded: DegradedFile
  smoke: Record<string, unknown> | null                 // state/smoke.json
  cache: CacheReport
  flip: (FlipMarker & { alive: boolean }) | null        // state/flip.json (Task 26 writes it)
  configErrors: string[]
}
```

- `adapters[].link` is the last `router.link` event of that pid in the adapter debug log (`join(adapterHome(), 'debug.jsonl')`, via `tailJsonl`/`lastEvent`); `codexChild` is `running` when that pid's last `codex.upstream.*` event is `codex.upstream.spawn`, `unavailable` for `spawnError`/`unavailable`/`missing`, else `unknown`.
- `router.health` is `GET routerHealthUrl(config)` with a 1 s timeout, null on failure; `router.job` is `launchctl print gui/<uid>/dev.anyengine.router` exit 0 or not.
- `app.codex` is `resolveBundledCodex().path`; `app.knownGood` is the `appVersion` in `state/known-good.json` (Task 28), null when absent.
- `modeNote`: in model mode, `"model mode is inactive: the fan-out path is bridge, Claude runs in agent mode"` when the router's last status says bridge.
- `flip` is `readFlipMarker(root)` plus `markerAlive`.

`formatStatus` prints one line per area, in this order, for example:

```
anyengine   lib 0.1.0-1a2b3c4d5e6f, layers: adapter, router
flip        none
app         ChatGPT.app 26.928.20755, codex .../codex-cli/CodexCLI.app/Contents/MacOS/codex (verified)
adapter     pid 12829 0.1.0-1a2b3c4d5e6f, codex child running, router attached (native)
router      dev.anyengine.router loaded, healthy, pid 4242, 0.1.0-1a2b3c4d5e6f, in flight gpt 0 claude 0
mode        codex-claude: agent
fan-out     native (catalog marked v1)
smoke       2026-10-01T00:30:00Z: gpt ok, claude-agent ok, claude-model ok, native-fanout ok, bridge ok
degraded    none
cache       ~/.codex/models_cache.json: client 0.159.0, 12 models, 3 AnyEngine entries
```

(home paths printed with `~`). The `flip` line reads `none`, `on in progress (phase quit-app), pid 4242, log ~/.anyengine/state/flip-<id>.log` while the flip's process runs, or `on interrupted at quit-app: run \`anyengine on\` or \`anyengine off\` to finish` when it does not.

- [ ] **Step 4: Write the CLI dispatch and the launcher**

Create `src/control-cli.mts`:

```ts
// `anyengine <command>`: the control CLI (spec 5.7). `doctor` arrives in
// Task 21, `on`, `off` and `restart` in Task 26, `smoke` in Task 27, `codex`
// in Task 29; each registers in COMMANDS below. Exit codes: 0 done, 1 a check
// failed, 2 bad usage.
import { anyengineRoot, CONFIG_KEYS, getConfigValue, readConfig, setConfigValue } from './anyengine-config.mjs'
import { cleanModelsCache } from './control-cache.mjs'
import { formatStatus, gatherStatus } from './control-status.mjs'
import { realSystem, type System } from './control-system.mjs'
import { codexHome } from './util.mjs'

export type Say = (text: string) => void
export type Command = (args: string[], system: System, root: string, say: Say) => Promise<number>

const USAGE = `usage: anyengine <command>
  on [--yes] [--no-restart] [--auto-rollback] [--wait-quiet MIN] [--lib VERSION] [--dry-run] [--native-proof FILE] [--force] [--foreground] [--no-follow]
  off [--router-only] [--force] [--yes] [--no-restart] [--wait-quiet MIN] [--foreground] [--no-follow]
  restart [--yes] [--wait-quiet MIN] [--force] [--foreground] [--no-follow]
  status [--json]
  doctor
  mode [codex-claude agent|model]
  config [get KEY | set KEY VALUE]
  cache clean [--dry-run]
  smoke [--paths a,b] [--notify] [--lib VERSION --out FILE] [--scheduled]
  codex [codex args...]
`

const COMMANDS: Record<string, Command> = {
  status: async (args, system, root, say) => {
    const report = await gatherStatus(system, root)
    say(args.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : formatStatus(report))
    return 0
  },
  mode: async (args, _system, root, say) => {
    if (args.length === 0) {
      say(`codex-claude: ${readConfig(root).config.modes.codexClaude}\n`)
      return 0
    }
    const [direction, value] = args
    if (direction !== 'codex-claude') {
      say(`unknown direction ${direction ?? ''}; M1 has codex-claude only\n`)
      return 2
    }
    try {
      setConfigValue(root, 'modes.codexClaude', value ?? '')
    } catch (error) {
      say(`${error instanceof Error ? error.message : String(error)}\n`)
      return 2
    }
    say(
      value === 'model'
        ? 'codex-claude: model. New Claude turns in the Codex surface run through claude -p (a policy grey area; agent mode is the default for that reason).\n'
        : 'codex-claude: agent. New Claude turns run on the adapter\'s Claude Code agent.\n',
    )
    say('Takes effect for new threads and spawned children now; existing threads keep their engine.\n')
    return 0
  },
  config: async (args, _system, root, say) => {
    const [verb, key, value] = args
    try {
      if (!verb) {
        const { config, errors } = readConfig(root)
        say(`${JSON.stringify(config, null, 2)}\n`)
        for (const error of errors) say(`error: ${error}\n`)
        return 0
      }
      if (verb === 'get' && key) {
        say(`${JSON.stringify(getConfigValue(readConfig(root).config, key))}\n`)
        return 0
      }
      if (verb === 'set' && key && value !== undefined) {
        setConfigValue(root, key, value)
        say(`${key} = ${JSON.stringify(getConfigValue(readConfig(root).config, key))}\n`)
        // The native fan-out proof is keyed on these settings (Task 9, H1).
        if (/^(router\.multiAgentV1|modes\.|claude\.models|claude\.spawnPriority|claims\.)/.test(key)) say('native fan-out must be proven again: anyengine smoke --paths native-fanout\n')
        return 0
      }
    } catch (error) {
      say(`${error instanceof Error ? error.message : String(error)}\n`)
      return 2
    }
    say(`usage: anyengine config [get KEY | set KEY VALUE]; keys: ${CONFIG_KEYS.join(', ')}\n`)
    return 2
  },
  cache: async (args, _system, root, say) => {
    if (args[0] !== 'clean') {
      say('usage: anyengine cache clean [--dry-run]\n')
      return 2
    }
    const ids = new Set(readConfig(root).config.claude.models.map((m) => m.id))
    if (args.includes('--dry-run')) {
      const { inspectModelsCache } = await import('./control-cache.mjs')
      const report = inspectModelsCache(codexHome(), ids)
      say(`${report.path}: ${report.anyengine.length} AnyEngine entries${report.parseError ? ` (unreadable: ${report.parseError})` : ''}\n`)
      return 0
    }
    const { removed, report } = cleanModelsCache(codexHome(), ids, null)
    say(removed ? `removed ${report.path} (${report.anyengine.join(', ')}); codex rebuilds it on its next fetch\n` : `left ${report.path} alone (${report.exists ? `${report.anyengine.length} AnyEngine entries` : 'absent'})\n`)
    return 0
  },
}

export const CONTROL_COMMANDS: ReadonlySet<string> = new Set(['on', 'off', 'restart', 'status', 'doctor', 'mode', 'config', 'cache', 'smoke', 'codex'])

export function registerCommand(name: string, command: Command): void {
  COMMANDS[name] = command
}

export async function runControl(
  argv: string[],
  system: System = realSystem(),
  root: string = anyengineRoot(),
  say: Say = (text) => process.stdout.write(text),
): Promise<number> {
  const [name, ...args] = argv
  const command = name ? COMMANDS[name] : undefined
  if (!command) {
    say(USAGE)
    return 2
  }
  return command(args, system, root, say)
}
```

In `src/adapter.mts`, after the `router` branch, add:

```ts
  // The control CLI (docs/guide/control.md): anyengine on|off|status|...
  if (args[0] && CONTROL_COMMANDS.has(args[0])) {
    const { runControl } = await import('./control-cli.mjs')
    await import('./control-commands.mjs')
    process.exitCode = await runControl(args)
    return
  }
```

and create `src/control-commands.mts`, whose only job is to import the modules that call `registerCommand` (empty now: `export {}` with a comment naming Tasks 21 to 29). Import `CONTROL_COMMANDS` statically from `./control-cli.mjs`.

Create `scripts/anyengine-launch` (mode 755, bash 3.2 safe, no build output read):

```bash
#!/usr/bin/env bash
# The AnyEngine launcher: launchd runs the router and the smoke through it,
# and it is installed as ~/.anyengine/bin/anyengine for the operator. It
# sources runtime.env (ANYENGINE_NODE and the adapter's settings), resolves
# lib/current to its version directory (so the process's argv names the
# version install-lib must not prune), keeps launchd's log for this job under
# 200 KB (a crash loop must not fill the disk), and execs Node.
set -euo pipefail
ROOT="${ANYENGINE_ROOT:-$HOME/.anyengine}"
RUNTIME_ENV="${ANYENGINE_RUNTIME_ENV:-$ROOT/runtime.env}"
if [ -f "$RUNTIME_ENV" ]; then
  # shellcheck source=/dev/null
  . "$RUNTIME_ENV"
fi
if ! LIB="$(cd "$ROOT/lib/current" 2>/dev/null && pwd -P)"; then
  echo "anyengine: no installed lib at $ROOT/lib/current. To undo AnyEngine without it: $ROOT/bin/anyengine-off" >&2
  exit 78
fi
LOG="${ANYENGINE_LAUNCHD_LOG:-}"
if [ -n "$LOG" ] && [ -f "$LOG" ]; then
  size="$(wc -c < "$LOG" | tr -d ' ')"
  if [ "$size" -gt 204800 ]; then
    # Rewrite in place: launchd holds this file open, so it must stay the same inode.
    tail -c 204800 "$LOG" > "$LOG.tail" && cat "$LOG.tail" > "$LOG" && rm -f "$LOG.tail"
  fi
fi
exec "${ANYENGINE_NODE:-node}" "$LIB/dist/src/adapter.mjs" "$@"
```

In `package.json` add `"anyengine": "npm run build && node dist/src/adapter.mjs"` to `scripts`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/control-read.test.mjs dist/test/control-seam.test.mjs`
Expected: PASS, `ℹ fail 0`.

Run (read-only against the real Mac, before anything is installed): `T7 npm run anyengine -- status`
Expected: `status` prints every area (router `not loaded`, layers none, flip none, the M0 adapter process with version `0.1.0-986ab707750e` or whatever `lib/current` names, `codex child running`, router link `not linked` for that pre-M1 adapter), and nothing under `~/.anyengine` or `~/Library/LaunchAgents` changes (`ls -la ~/.anyengine ~/.anyengine/state ~/Library/LaunchAgents 2>&1 | md5` before and after are equal; `~/.codex` is not compared, because the app writes there all the time, and `status` only reads it).

- [ ] **Step 6: Docs, gates, commit**

Create `docs/guide/control.md` with one section per command of this task (what it reads, what it changes, exit codes; later tasks add theirs), the recovery paragraph ("`anyengine off`; if Node or the lib is broken, `~/.anyengine/bin/anyengine-off`"), and the status fields. Add the new modules to `src/AGENTS.md` and `anyengine-launch` to `scripts/AGENTS.md`.

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/control-cli.mts src/control-commands.mts src/control-status.mts src/adapter.mts scripts/anyengine-launch \
  test/control-read.test.mts package.json docs/guide/control.md scripts/AGENTS.md src/AGENTS.md
git commit -m "feat: add anyengine status, mode, config and cache clean"
```

**Acceptance:** tests pass; against the live Mac `status` runs read-only and prints every area; a change to a setting that shapes native fan-out (`router.multiAgentV1`, the modes, the Claude models and their order, the claim settings) says native fan-out must be proven again (the proof is keyed on those settings, Task 9); `status` shows a flip in progress or interrupted.

---
### Task 21: `anyengine doctor`

Spec 5.7: `anyengine doctor` "Checks the install, versions, sockets, the node_modules integrity of the installed lib, and schema drift against the running codex. It also warns about outside processes and conflicting settings." This task adds the M1 checks on top of the existing `scripts/doctor.mjs`, including the two the review asked for: the shared `config.toml` naming a model codex cannot serve (decision D15), and a flip that was interrupted (decision D17). It also adds the small reader for the shared `config.toml` that the switch-on uses to remove one line (Task 24).

**Files:**
- Create: `src/control-doctor.mts`, `src/codex-config-toml.mts`
- Create: `test/control-doctor.test.mts`
- Modify: `src/control-commands.mts` (import the doctor), `docs/guide/control.md` (the doctor section), `src/AGENTS.md`

**Interfaces:**
- Consumes: Task 19 (`System`, `adapterProcesses`, `tailJsonl`, `lastEvent`, `inspectModelsCache`, `readFlipMarker`, `markerAlive`), Task 20 (`registerCommand`), Task 9 (`readDegraded`, `isProven`, `readProof`, `proofKey`), `router-fanout.mts` (`readRouterStatus`), `anyengine-config.mts`, `config-writes.mts` (`appModelPickPath`; Task 5), `claim-protocol.mts` (`liveClaimSockets`, `writeLine`, `onLines`), `util.mts` (`codexHome`, `adapterHome`, `isCodexOpenAiModel`).
- Produces:

```ts
// src/codex-config-toml.mts: not a TOML parser. Only `key = "string"` lines at
// the top level or directly in a [profiles.<name>] table are recognised.
export interface ModelLine { index: number; table: string | null; key: 'model' | 'review_model'; value: string; text: string }
export function modelLines(text: string): ModelLine[]
export function nonGptModelLines(text: string): ModelLine[]               // values isCodexOpenAiModel rejects
export function withoutLines(text: string, lines: readonly ModelLine[]): string   // exactly those lines removed, every other byte kept
export function topLevelString(text: string, key: string): string | null  // e.g. openai_base_url
export function topLevelKeys(text: string): string[]                       // every `key =` line before the first table, any value type
export function duplicateTopLevelKeys(text: string): string[]              // keys that appear more than once there
export function insertTopLevelLine(text: string, index: number, line: string): string   // at index, or at the end of the top-level section

// src/control-doctor.mts
export interface DoctorCheck { name: string; level: 'ok' | 'warn' | 'fail'; detail: string }
export function runDoctor(system: System, root: string, options?: { codexHome?: string }): Promise<DoctorCheck[]>
export const DOCTOR_CHECKS: readonly string[]    // the names, in order
```

- [ ] **Step 1: Write the failing tests**

Create `test/control-doctor.test.mts`:

```ts
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { enginePaths } from '../src/anyengine-config.mjs'
import { duplicateTopLevelKeys, insertTopLevelLine, modelLines, nonGptModelLines, topLevelKeys, topLevelString, withoutLines } from '../src/codex-config-toml.mjs'
import { writeFlipMarker } from '../src/control-marker.mjs'
import { DOCTOR_CHECKS, runDoctor } from '../src/control-doctor.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

const TOML = [
  '# the operator keeps notes here',
  'model = "sonnet"',
  'model_reasoning_effort = "medium"',
  '',
  '[profiles.work]',
  'model = "opus"',
  '',
  '[profiles.fast]',
  "model = 'gpt-6-astra'",
  '',
  '[mcp_servers.x]',
  'command = "x"',
  'model = "not-a-model-key-here"',
  '',
].join('\n')

test('config.toml: model lines are found at the top level and in profiles only', () => {
  const lines = modelLines(TOML)
  assert.deepEqual(lines.map((l) => [l.table, l.key, l.value]), [
    [null, 'model', 'sonnet'],
    ['profiles.work', 'model', 'opus'],
    ['profiles.fast', 'model', 'gpt-6-astra'],
  ])
  assert.deepEqual(nonGptModelLines(TOML).map((l) => l.value), ['sonnet', 'opus'])
  const topOnly = nonGptModelLines(TOML).filter((l) => l.table === null)
  const edited = withoutLines(TOML, topOnly)
  assert.equal(edited, TOML.replace('model = "sonnet"\n', ''), 'exactly that line, every other byte kept')
  assert.equal(topLevelString('openai_base_url = "http://127.0.0.1:18790/backend-api/codex"\n', 'openai_base_url'), 'http://127.0.0.1:18790/backend-api/codex')
  assert.equal(topLevelString('[t]\nopenai_base_url = "x"\n', 'openai_base_url'), null)
  assert.deepEqual(topLevelKeys(TOML), ['model', 'model_reasoning_effort'])
  assert.deepEqual(duplicateTopLevelKeys('model = "a"\nmodel = "b"\n[t]\nmodel = "c"\n'), ['model'])
  assert.equal(insertTopLevelLine(edited, 1, 'model = "sonnet"'), TOML, 'the removed line goes back where it was')
  assert.equal(insertTopLevelLine('[t]\nx = 1\n', 5, 'model = "opus"'), 'model = "opus"\n[t]\nx = 1\n', 'never inside a table')
})

async function doctorHome() {
  const home = await tempDir('anyengine-doctor-')
  const root = join(home, '.anyengine')
  const codex = join(home, '.codex')
  mkdirSync(enginePaths(root).state, { recursive: true })
  mkdirSync(codex, { recursive: true })
  return { home, root, codex, system: fakeSystem(home) }
}

test('doctor: every check is reported, in order', async () => {
  const { root, codex, system } = await doctorHome()
  const checks = await runDoctor(system, root, { codexHome: codex })
  assert.deepEqual(checks.map((c) => c.name), [...DOCTOR_CHECKS])
  assert.equal(DOCTOR_CHECKS.length, 19)
})

test('doctor: a model codex cannot serve in the shared config.toml is a warning, a GPT one is not', async () => {
  const { root, codex, system } = await doctorHome()
  writeFileSync(join(codex, 'config.toml'), 'model = "sonnet"\n')
  const warned = (await runDoctor(system, root, { codexHome: codex })).find((c) => c.name === 'shared config model')
  assert.equal(warned?.level, 'warn')
  assert.match(warned?.detail ?? '', /sonnet.*terminal codex with no -m/)
  writeFileSync(join(codex, 'config.toml'), 'model = "gpt-6.1-sol"\n')
  assert.equal((await runDoctor(system, root, { codexHome: codex })).find((c) => c.name === 'shared config model')?.level, 'ok')
})

test('doctor: config.toml pointing terminal codex at the router is a warning', async () => {
  const { root, codex, system } = await doctorHome()
  writeFileSync(join(codex, 'config.toml'), 'openai_base_url = "http://127.0.0.1:18790/backend-api/codex"\n')
  const check = (await runDoctor(system, root, { codexHome: codex })).find((c) => c.name === 'terminal codex and the router')
  assert.equal(check?.level, 'warn')
})

test('doctor: an interrupted flip fails, a running one warns', async () => {
  const { root, codex, system } = await doctorHome()
  const marker = { id: 'f', op: 'on' as const, args: [], pid: 4321, phase: 'quit-app', startedAt: 'a', updatedAt: 'b', log: join(root, 'state', 'flip-f.log'), state: {} }
  writeFlipMarker(root, marker)
  const dead = (await runDoctor(system, root, { codexHome: codex })).find((c) => c.name === 'flip')
  assert.equal(dead?.level, 'fail')
  assert.match(dead?.detail ?? '', /interrupted at quit-app/)
  system.procs = [{ pid: 4321, ppid: 1, command: 'node adapter.mjs flip-run f' }]
  assert.equal((await runDoctor(system, root, { codexHome: codex })).find((c) => c.name === 'flip')?.level, 'warn')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/codex-config-toml.mjs'`.

- [ ] **Step 3: Write the config.toml reader**

Create `src/codex-config-toml.mts`:

```ts
// The few facts AnyEngine reads from the shared ~/.codex/config.toml, and the
// one kind of line the switch-on may remove from it (decision D15: a model id
// codex cannot serve, which a terminal codex with no -m would send to OpenAI).
// Not a TOML parser: a line is recognised only as `key = "string"` (or single
// quotes) at the top level or directly in a [profiles.<name>] table. Anything
// else, including multi-line values and inline tables, is left as it is.
import { isCodexOpenAiModel } from './util.mjs'

export interface ModelLine {
  index: number
  table: string | null
  key: 'model' | 'review_model'
  value: string
  text: string
}

const TABLE = /^\s*\[\s*([^\]\s][^\]]*?)\s*\]\s*(#.*)?$/
const STRING_KEY = /^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(#.*)?$/

function scan(text: string, visit: (table: string | null, key: string, value: string, index: number, line: string) => void): void {
  let table: string | null = null
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    const header = TABLE.exec(line)
    if (header) {
      table = header[1] ?? null
      continue
    }
    const pair = STRING_KEY.exec(line)
    if (pair) visit(table, pair[1] ?? '', pair[2] ?? pair[3] ?? '', index, line)
  }
}

export function modelLines(text: string): ModelLine[] {
  const out: ModelLine[] = []
  scan(text, (table, key, value, index, line) => {
    if (key !== 'model' && key !== 'review_model') return
    if (table !== null && !/^profiles\.[^.]+$/.test(table)) return
    out.push({ index, table, key, value, text: line })
  })
  return out
}

export function nonGptModelLines(text: string): ModelLine[] {
  return modelLines(text).filter((line) => line.value.trim() !== '' && !isCodexOpenAiModel(line.value.trim()))
}

export function withoutLines(text: string, lines: readonly ModelLine[]): string {
  const drop = new Set(lines.map((line) => line.index))
  return text
    .split('\n')
    .filter((_, index) => !drop.has(index))
    .join('\n')
}

const ANY_KEY = /^\s*([A-Za-z0-9_-]+)\s*=/

export function topLevelKeys(text: string): string[] {
  const keys: string[] = []
  for (const line of text.split('\n')) {
    if (TABLE.test(line)) break
    const key = ANY_KEY.exec(line)?.[1]
    if (key) keys.push(key)
  }
  return keys
}

export function duplicateTopLevelKeys(text: string): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const key of topLevelKeys(text)) (seen.has(key) ? dup : seen).add(key)
  return [...dup]
}

// A top-level line goes before the first table header: at `index` when the
// top-level section still reaches that far, otherwise at the section's end.
export function insertTopLevelLine(text: string, index: number, line: string): string {
  const lines = text.split('\n')
  const firstTable = lines.findIndex((l) => TABLE.test(l))
  const end = firstTable === -1 ? (lines.at(-1) === '' ? lines.length - 1 : lines.length) : firstTable
  lines.splice(Math.min(Math.max(index, 0), end), 0, line)
  return lines.join('\n')
}

export function topLevelString(text: string, key: string): string | null {
  let found: string | null = null
  scan(text, (table, name, value) => {
    if (table === null && name === key && found === null) found = value
  })
  return found
}
```

- [ ] **Step 4: Write doctor**

Create `src/control-doctor.mts`. `runDoctor` returns these checks, in this order (`DOCTOR_CHECKS` lists the names); `fail` makes `anyengine doctor` exit 1, `warn` does not. Write each check as its own small function (the complexity ratchet: 30 or less each) and `runDoctor` as the list that calls them; a check that throws is reported as `fail` with the error, never as a crash of the whole command.

| # | Name | fail / warn when |
|---|---|---|
| 1 | `adapter checks (scripts/doctor.mjs)` | fail: `node <lib>/scripts/doctor.mjs` exits non-zero (its output is printed under this line) |
| 2 | `config.json` | warn: `readConfig().errors` not empty |
| 3 | `router job` | fail: the router layer is on and `launchctl print` does not find `dev.anyengine.router` |
| 4 | `router health` | fail: the router layer is on and `/health` does not answer within 1 s |
| 5 | `router version` | warn: health's `version` differs from `lib/current`'s version (the router reloads when the lib changes, Task 24; if it did not, `anyengine on` again) |
| 6 | `adapters run the current lib` | warn: an adapter process runs another lib version (the app keeps it until its next launch) |
| 7 | `codex child` | fail: a live adapter's codex child is `unavailable` (Claude threads have no shell, Task 2; the bundled codex moved or is missing) |
| 8 | `router attached` | warn: the router layer is on and an adapter's last `router.link` says not attached (quote the reason) |
| 9 | `fan-out path` | warn: the router reports `bridge` while `router.multiAgentV1` is true (quote the reason; "native fan-out is not proven" means the smoke has not passed for this lib, app, codex and settings: `readProof` names what the last proof was for, and which of the four changed); ok names the proof's time and key |
| 10 | `Claude mode and runtime` | warn: mode `agent` with `ANYENGINE_RUNTIME_TYPE` other than `anyengine` ("Claude runs through the Agent SDK, not the interactive CLI"), or mode `model` ("the trampoline is a policy grey area") |
| 11 | `claim sockets` | warn: an adapter pid has no `claim-<pid>.sock`, or a socket does not answer `ping` within 1 s |
| 12 | `models cache` | fail: no layer is on and the cache holds AnyEngine entries (`anyengine cache clean`); otherwise ok with the counts |
| 13 | `terminal codex and the router` | ok by default, with the reason: a terminal `codex` does not read the router's catalog, because the models cache's identity includes the resolved base URL (and the client version), so a cache the router's catalog wrote is ignored by a codex that talks to chatgpt.com (decision D9, proven on this Mac by Task 30's differential gate). warn: `~/.codex/config.toml` sets a top-level `openai_base_url` that is the router (then every terminal codex goes through the router, whose Claude turns it cannot own) |
| 14 | `shared config model` | warn: `~/.codex/config.toml` has a top-level or profile `model`/`review_model` codex cannot serve (`nonGptModelLines`): "`<key> = "<id>"` (line N): a terminal codex with no -m asks OpenAI for &lt;id&gt;. `anyengine on` removes the top-level line and keeps the app's pick in `app-model-pick.json` (decision D15); a profile line is yours to edit." The detail also names the app's pick (`appModelPickPath()`), if any |
| 15 | `conflicting settings` | warn: `CODEX_APP_SERVER_OPENAI_BASE_URL` is set in the app's login-shell environment (`CODEX_SHELL=1 zsh -ilc 'print -r -- ${CODEX_APP_SERVER_OPENAI_BASE_URL-}'`) and is not the router (the adapter will not attach the router, decision D1) |
| 16 | `app update` | warn: `node <lib>/scripts/preflip-check.mjs --quiet-seconds 0` reports a staged update ("it installs at the next quit; AnyEngine verifies it afterwards") |
| 17 | `update hold` | ok, always: "no reliable hold (decision D8); detect-and-alert via dev.anyengine.smoke" plus whether that job is loaded (warn if the router layer is on and it is not) |
| 18 | `flip` | fail: `readFlipMarker` finds a marker whose process is gone ("`<op>` interrupted at `<phase>`: run `anyengine on` or `anyengine off` to finish; log `<path>`"); warn: a flip is running (its pid and log); ok: none |
| 19 | `storage` | warn: `~/.anyengine` without `lib/` and `rollback-*` over 500 MB; `~/.anyengine/state` over 20 MB (flip logs are kept to the newest 10, Task 26); the adapter's `debug.jsonl*` over 250 MB; `~/.anyengine/logs` over 50 MB; the smoke project's folder under `~/.claude/projects` over 50 MB (read only; `doctor` never deletes there). Each size is printed. |

Sizes come from a recursive `lstat` walk (no `du`), capped at 200,000 entries. `options.codexHome` defaults to `codexHome()`; the file is read, never written.

Register the command at the bottom of the file:

```ts
registerCommand('doctor', async (_args, system, root, say) => {
  const checks = await runDoctor(system, root)
  for (const check of checks) say(`${check.level.padEnd(4)} - ${check.name}${check.detail ? `: ${check.detail}` : ''}\n`)
  return checks.some((c) => c.level === 'fail') ? 1 : 0
})
```

and add `import './control-doctor.mjs'` to `src/control-commands.mts`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/control-doctor.test.mjs dist/test/control-read.test.mjs`
Expected: PASS, `ℹ fail 0`.

Run (read-only against the real Mac): `ls -la ~/.anyengine ~/.anyengine/state ~/Library/LaunchAgents 2>&1 | md5; T7 npm run anyengine -- doctor; ls -la ~/.anyengine ~/.anyengine/state ~/Library/LaunchAgents 2>&1 | md5`
Expected: all 19 checks printed; check 14 warns about `model = "sonnet"` (line 1), which is the live state today and what Task 30 removes; the two checksums are equal (`~/.codex` is not compared: the app writes there all the time; doctor only reads `config.toml`, `models_cache.json` and `anyengine/app-model-pick.json`, which the tests check). Report any `fail`: it is information for the switch-on, not a reason to change the live machine now.

- [ ] **Step 6: Docs, gates, commit**

Add the doctor section to `docs/guide/control.md` (the table above, one line per check, and what to do for each warning). Add `control-doctor.mts` and `codex-config-toml.mts` to `src/AGENTS.md`.

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/control-doctor.mts src/codex-config-toml.mts src/control-commands.mts test/control-doctor.test.mts \
  docs/guide/control.md src/AGENTS.md
git commit -m "feat: add anyengine doctor with the shared-config and interrupted-flip checks"
```

**Acceptance:** tests pass; `doctor` reports 19 checks in order; a model codex cannot serve in the shared `config.toml` warns and names the line; a `config.toml` that points terminal codex at the router warns; an interrupted flip fails; against the live Mac it runs read-only.

---
### Task 22: Layers: what `on` records, with write-ahead, M0 adoption and hash-guarded restore

Spec 5.7: `anyengine on` "Backs up every file it touches"; `anyengine off` "Restores every backed-up file". Decision D4 and the live state: M0 is on by hand, with its own rollback; `on` must adopt it (detect the backup and the guarded rc block, never write either twice, and adopt only while M0 is verifiably on), and `off` must put back exactly what was there. This task builds the record both halves use: **layers** (the adopted M0 adapter layer, then the router layer), each with its own rollback directory and every change it made, recorded and persisted before the change happens (write-ahead, decision D17), and a hash-guarded restore that never overwrites a file the operator changed since. The rollback scripts are Task 23; the launchd jobs and the file half of `on`/`off` are Task 24; the app restart around them is Task 26.

**Files:**
- Create: `src/control-rc.mts`, `src/control-layers.mts`
- Create: `test/fixtures/m0-live-layout/` (synthetic, see Step 1), `test/helpers/m0-home.mts`, `test/control-layers.test.mts`
- Modify: `src/AGENTS.md`

**Interfaces:**
- Consumes: `anyengine-config.mts` (`enginePaths`, `writeJsonAtomic`).
- Produces:

```ts
// src/control-rc.mts
export const RC_BEGIN: string            // '# >>> anyengine >>> ...'
export const RC_END: string              // '# <<< anyengine <<<'
export type RcState = 'active' | 'commented' | 'absent'
export function rcPath(home: string, shell: string | undefined): string | null     // zsh -> ~/.zshrc, bash -> ~/.bash_profile
export function findCodexCliBlock(text: string): { state: RcState; start: number; end: number }
export function withRcBlock(text: string): { text: string; changed: boolean; state: RcState }
export function revertHunk(current: string, before: string, after: string): string | null

// src/control-layers.mts
export type LayerName = 'adapter' | 'router'
export interface FileChange {
  target: string
  before: 'file' | 'symlink' | 'absent'
  backup: string | null          // file in the layer's rollback dir holding the before bytes
  after: string | null           // file in the layer's rollback dir holding the after bytes (text files)
  mode: number | null
  beforeSha: string | null
  afterSha: string | null
  beforeLink: string | null
  afterLink: string | null
}
// The one ~/.codex/config.toml change (decision D15) is not a FileChange: it is
// never restored by hash or hunk, but by its own rule (Tasks 23 and 24): a
// removed line goes back only if no top-level key of that name exists, with
// the pick file's current value, and the pick file is deleted.
export interface SharedConfigRecord { target: string; pickFile: string; backup: string; removed: Array<{ key: string; value: string; index: number; text: string }> }
export interface Layer {
  name: LayerName; rollbackDir: string; adoptedFrom: string | null; createdAt: string
  changes: FileChange[]; jobs: string[]; cleansCache: boolean
  sharedConfig?: SharedConfigRecord | null
  pending?: 'after-quit' | null   // files restored; jobs, shared config and cache wait for the app's quit (Task 24)
}
export interface LayerFile { version: 1; layers: Layer[] }
export type RestoreOutcome = 'restored' | 'already' | 'reverted-hunk' | 'left-changed'
export const POPPED: string                     // a file in a rollback dir: the bash anyengine-off undid this layer
export type OnRecord = (layer: Layer) => void   // persists the record before each change (Task 24 wires it)
export function sha256Of(path: string): string | null
export function readLayers(root: string): LayerFile            // POPPED layers dropped
export function writeLayers(root: string, file: LayerFile): void   // no layers: the file is removed
export class LayerWriter {
  constructor(root: string, existing: Layer | null, name: LayerName, stamp: string, onRecord?: OnRecord)
  readonly layer: Layer
  track(target: string): FileChange
  writeFile(target: string, content: string | Buffer, mode: number): boolean   // records, persists, then writes
  writeSymlink(target: string, to: string): boolean                          // records, persists, then swaps
  settle(target: string): void
  addJob(label: string): void                                                // records and persists before the load
}
export function m0Active(home: string, shimBackupSha: string | null): { rc: boolean; shim: boolean }
export type Adoption = { layer: Layer } | { refused: string } | null
export function adoptM0(root: string, home: string, stamp: string): Adoption
export function restoreChange(change: FileChange, rollbackDir: string, allowHunk: boolean): { outcome: RestoreOutcome; detail: string }
```

- [ ] **Step 1: Build a synthetic copy of the live M0 layout**

Create `test/fixtures/m0-live-layout/` (no personal names or paths; `@HOME@` is substituted at test time):

- `home/.zshrc`:

  ```
  export PATH="$HOME/.local/bin:$PATH"

  # ChatGPT.app (Codex desktop) local host -> adapter. The app imports
  # the login-shell env at startup with CODEX_SHELL=1, so only the app sees this.
  if [[ -n "$CODEX_SHELL" ]]; then
    export CODEX_CLI_PATH="$HOME/bin/codex"
  fi
  ```

- `home/bin/codex`: two lines, `#!/usr/bin/env bash` and `# anyengine codex shim (marker: ANYENGINE_ADAPTER) m0` (mode 755 set by the test).
- `home/.codex/config.toml`: `model = "sonnet"` and `model_reasoning_effort = "medium"` (the live file's two top-level lines; Tasks 24 and 25 remove and restore the first).
- `home/.anyengine/runtime.env`: `export ANYENGINE_RUNTIME_TYPE="anyengine"` and `export ANYENGINE_ADAPTER="$HOME/.anyengine/lib/current/dist/src/adapter.mjs"`.
- `home/.anyengine/lib/0.1.0-986ab707750e/package.json` (`{}`); the test creates `home/.anyengine/lib/current` → `0.1.0-986ab707750e` (git does not keep that symlink reliably).
- `home/.anyengine/rollback-20260930T114234Z/`: `00-.zshrc.bak` (the `.zshrc` above with each of the three block lines prefixed `# `), `01-codex.bak` (`#!/usr/bin/env bash` and `# anyengine codex shim (marker: ANYENGINE_ADAPTER) pre-m0`: the shim from before M0 carried the marker too, which is why adoption compares hashes), `02-runtime.env.bak` (`export ANYENGINE_RUNTIME_TYPE="anyengine"` and `export ANYENGINE_ADAPTER="$HOME/Projects/anyengine/dist/src/adapter.mjs"`), `ROLLBACK.sh` (`#!/usr/bin/env bash` and `exit 0`), and `manifest.json`:

  ```json
  {
    "createdAt": "2026-09-30T11:42:34.139Z",
    "entries": [
      { "target": "@HOME@/.zshrc", "backup": "00-.zshrc.bak", "mode": "0644" },
      { "target": "@HOME@/bin/codex", "backup": "01-codex.bak", "mode": "0755" },
      { "target": "@HOME@/.anyengine/runtime.env", "backup": "02-runtime.env.bak", "mode": "0644" }
    ]
  }
  ```

  (the live manifest names the absolute home and writes `mode` as an octal string; the adoption must read both that and a number).
- `home/.anyengine/rollback-20260909T231247Z/ROLLBACK.sh` only: an older rollback without a manifest, which adoption must skip.
- `home/.anyengine/rollback-20260930T120000Z/manifest.json` listing only `@HOME@/.zshrc` (a newer rollback of something else, which adoption must also skip: it lists not exactly the three M0 targets).

Create `test/helpers/m0-home.mts`, exporting `m0Home(): Promise<string>`: copy `test/fixtures/m0-live-layout/home` into a `tempDir('anyengine-layers-')`, substitute `@HOME@` in both manifests, `chmod 755 bin/codex`, and create the `lib/current` symlink (Task 24 adds `fakeLib` to this helper).

- [ ] **Step 2: Write the failing tests**

Create `test/control-layers.test.mts`:

```ts
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { adoptM0, type Layer, LayerWriter, POPPED, readLayers, restoreChange, sha256Of, writeLayers } from '../src/control-layers.mjs'
import { findCodexCliBlock, revertHunk, withRcBlock } from '../src/control-rc.mjs'
import { m0Home } from './helpers/m0-home.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

const STAMP = '20261001T000000Z'

test('adoptM0: the rc after-state is withRcBlock(backup), and an rc edited since is reverted by hunk', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const operatorDir = readdirSync(join(root, 'rollback-20260930T114234Z')).sort()
  const adopted = adoptM0(root, home, STAMP)
  assert.ok(adopted && 'layer' in adopted)
  const layer = adopted.layer
  assert.match(layer.adoptedFrom ?? '', /rollback-20260930T114234Z$/, 'the newer rollback of something else is skipped')
  const rc = layer.changes.find((c) => c.target.endsWith('.zshrc'))
  assert.ok(rc?.backup && rc.after)
  const backup = readFileSync(join(layer.rollbackDir, rc.backup), 'utf8')
  assert.equal(readFileSync(join(layer.rollbackDir, rc.after), 'utf8'), withRcBlock(backup).text)
  assert.equal(sha256Of(join(home, '.zshrc')), rc.afterSha, 'the fixture rc is exactly what on would have made')
  writeFileSync(join(home, '.zshrc'), `${readFileSync(join(home, '.zshrc'), 'utf8')}alias ll='ls -l'\n`)
  assert.equal(restoreChange(rc, layer.rollbackDir, true).outcome, 'reverted-hunk')
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), `${backup}alias ll='ls -l'\n`)
  assert.equal(findCodexCliBlock(readFileSync(join(home, '.zshrc'), 'utf8')).state, 'commented')
  assert.equal(restoreChange(rc, layer.rollbackDir, true).outcome, 'already', "a second pass finds AnyEngine's lines already out")
  assert.deepEqual(readdirSync(join(root, 'rollback-20260930T114234Z')).sort(), operatorDir, "the operator's directory is only read")
})

test('adoptM0: a half-on M0 is refused, an M0 that is off is not adopted', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  // Back to the shim from before M0: it carries the marker as well, so only
  // its hash tells it apart.
  writeFileSync(join(home, 'bin', 'codex'), readFileSync(join(root, 'rollback-20260930T114234Z', '01-codex.bak')))
  const half = adoptM0(root, home, STAMP)
  assert.ok(half && 'refused' in half)
  assert.match(half.refused, /half on/)
  writeFileSync(join(home, '.zshrc'), readFileSync(join(root, 'rollback-20260930T114234Z', '00-.zshrc.bak')))
  assert.equal(adoptM0(root, home, STAMP), null)
})

test('layers: each change is recorded and persisted before the file changes (write-ahead)', async () => {
  const dir = await tempDir('anyengine-layers-')
  const root = join(dir, '.anyengine')
  const target = join(dir, 'file.txt')
  writeFileSync(target, 'before\n')
  const seen: Array<{ onDisk: string; afterSha: string | null }> = []
  const writer = new LayerWriter(root, null, 'router', STAMP, (layer) => {
    const change = layer.changes.find((c) => c.target === target)
    seen.push({ onDisk: readFileSync(target, 'utf8'), afterSha: change?.afterSha ?? null })
    writeLayers(root, { version: 1, layers: [layer] })
  })
  assert.equal(writer.writeFile(target, 'after\n', 0o644), true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.onDisk, 'before\n', 'recorded while the file still held its before bytes')
  assert.equal(seen[0]?.afterSha, sha256Of(target))
  const recorded = readLayers(root).layers[0]
  assert.ok(recorded?.changes[0])
  assert.equal(restoreChange(recorded.changes[0], recorded.rollbackDir, false).outcome, 'restored', 'the record alone is enough to undo it')
  assert.equal(readFileSync(target, 'utf8'), 'before\n')

  const untouched = join(dir, 'untouched.txt')
  writeFileSync(untouched, 'x\n')
  const killed = new LayerWriter(root, null, 'router', `${STAMP}b`, () => {
    throw new Error('killed')
  })
  assert.throws(() => killed.writeFile(untouched, 'y\n', 0o644), /killed/)
  assert.equal(readFileSync(untouched, 'utf8'), 'x\n', 'a flip killed at the record never wrote')
  const change = killed.layer.changes[0]
  assert.ok(change)
  assert.equal(restoreChange(change, killed.layer.rollbackDir, false).outcome, 'already')
})

test('layers: restore is hash-guarded for files, symlinks and created files', async () => {
  const dir = await tempDir('anyengine-layers-')
  const root = join(dir, '.anyengine')
  mkdirSync(join(dir, 'lib', 'v1'), { recursive: true })
  mkdirSync(join(dir, 'lib', 'v2'), { recursive: true })
  symlinkSync('v1', join(dir, 'lib', 'current'))
  const writer = new LayerWriter(root, null, 'router', STAMP)
  writer.writeSymlink(join(dir, 'lib', 'current'), 'v2')
  writer.writeFile(join(dir, 'created.txt'), 'new\n', 0o644)
  const [link, created] = writer.layer.changes
  assert.ok(link && created)
  writeFileSync(join(dir, 'created.txt'), 'the operator wrote this\n')
  assert.equal(restoreChange(created, writer.layer.rollbackDir, true).outcome, 'left-changed')
  assert.equal(readFileSync(join(dir, 'created.txt'), 'utf8'), 'the operator wrote this\n')
  assert.equal(restoreChange(link, writer.layer.rollbackDir, true).outcome, 'restored')
  assert.equal(readlinkSync(join(dir, 'lib', 'current')), 'v1')
  assert.equal(restoreChange(link, writer.layer.rollbackDir, true).outcome, 'already')
})

test('layers: a layer the bash anyengine-off popped is dropped on read; no layers, no file', async () => {
  const dir = await tempDir('anyengine-layers-')
  const root = join(dir, '.anyengine')
  const a = new LayerWriter(root, null, 'adapter', STAMP).layer
  const b = new LayerWriter(root, null, 'router', STAMP).layer
  writeLayers(root, { version: 1, layers: [a, b] })
  writeFileSync(join(b.rollbackDir, POPPED), '')
  assert.deepEqual(readLayers(root).layers.map((l: Layer) => l.name), ['adapter'])
  writeLayers(root, { version: 1, layers: [] })
  assert.deepEqual(readLayers(root).layers, [])
})

test('rc: the hunk revert finds its lines once, or refuses', () => {
  const before = 'a\nb\n'
  const after = 'a\nb\nX\nY\n'
  assert.equal(revertHunk('a\nb\nX\nY\nc\n', before, after), 'a\nb\nc\n')
  assert.equal(revertHunk('a\nb\nX\nY\nb\nX\nY\n', before, after), null, 'ambiguous')
  assert.equal(revertHunk('zzz\n', before, after), null, 'gone')
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/control-layers.mjs'`.

- [ ] **Step 4: Write the rc helpers**

Create `src/control-rc.mts`:

```ts
// The login-shell rc and its one AnyEngine block. ChatGPT.app imports its
// login shell's environment with CODEX_SHELL=1, so a CODEX_SHELL-guarded
// `export CODEX_CLI_PATH=...` reaches only the app. M0 left that block in
// ~/.zshrc by hand (uncommented, unmarked); `on` recognises it in any of
// three states and never writes a second one: active (leave it), commented
// (uncomment its three lines) or absent (append a marked block).
//
// `off` restores the whole file when it is byte for byte what `on` left.
// When the operator edited it since, revertHunk takes out only the lines `on`
// changed, anchored on their neighbours, and refuses when it cannot find them
// exactly once.
import { join } from 'node:path'

export const RC_BEGIN = '# >>> anyengine >>> (managed by `anyengine on`; `anyengine off` removes it)'
export const RC_END = '# <<< anyengine <<<'
export type RcState = 'active' | 'commented' | 'absent'

const GUARD = /^\s*(#\s*)?if \[\[ -n "\$CODEX_SHELL" \]\]; then\s*$/
const EXPORT = /^\s*(#\s*)?export CODEX_CLI_PATH=/
const FI = /^\s*(#\s*)?fi\s*$/

export function rcPath(home: string, shell: string | undefined): string | null {
  const name = (shell ?? '').split('/').pop()
  if (name === 'zsh') return join(home, '.zshrc')
  if (name === 'bash') return join(home, '.bash_profile')
  return null
}

export function findCodexCliBlock(text: string): { state: RcState; start: number; end: number } {
  const lines = text.split('\n')
  let commented: { start: number; end: number } | null = null
  for (let i = 0; i + 2 < lines.length; i += 1) {
    const [a, b, c] = [lines[i] ?? '', lines[i + 1] ?? '', lines[i + 2] ?? '']
    if (!GUARD.test(a) || !EXPORT.test(b) || !FI.test(c)) continue
    if (![a, b, c].every((line) => /^\s*#/.test(line))) return { state: 'active', start: i, end: i + 2 }
    commented ??= { start: i, end: i + 2 }
  }
  return commented ? { state: 'commented', ...commented } : { state: 'absent', start: -1, end: -1 }
}

export function withRcBlock(text: string): { text: string; changed: boolean; state: RcState } {
  const block = findCodexCliBlock(text)
  if (block.state === 'active') return { text, changed: false, state: 'active' }
  if (block.state === 'commented') {
    const lines = text.split('\n')
    for (let i = block.start; i <= block.end; i += 1) lines[i] = (lines[i] ?? '').replace(/^(\s*)#\s?/, '$1')
    return { text: lines.join('\n'), changed: true, state: 'commented' }
  }
  const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n'
  const block5 = [RC_BEGIN, 'if [[ -n "$CODEX_SHELL" ]]; then', '  export CODEX_CLI_PATH="$HOME/bin/codex"', 'fi', RC_END]
  return { text: `${text}${separator}${block5.join('\n')}\n`, changed: true, state: 'absent' }
}

export function revertHunk(current: string, before: string, after: string): string | null {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  if (start === endA && start === endB) return current
  const lead = start > 0 ? [b[start - 1] ?? ''] : []
  const trail = endB < b.length ? [b[endB] ?? ''] : []
  const needle = [...lead, ...b.slice(start, endB), ...trail].join('\n')
  const replacement = [...lead, ...a.slice(start, endA), ...trail].join('\n')
  const first = current.indexOf(needle)
  if (first < 0 || current.indexOf(needle, first + 1) >= 0) return null
  return current.slice(0, first) + replacement + current.slice(first + needle.length)
}
```

- [ ] **Step 5: Write the layers**

Create `src/control-layers.mts`:

```ts
// A layer is one `on` step and everything it changed: each file's before
// state (bytes and mode, a symlink's target, or "absent"), its after state
// (hash, and the bytes for text files so a line-level revert is possible),
// and the launchd jobs it loaded. Every file is backed up once per layer,
// the first time the layer touches it, so a second `on` never overwrites the
// original backup. Layers live in ~/.anyengine/state/layers.json, oldest
// first; `off` pops them newest first.
//
// Write-ahead (decision D17): a change is recorded, with the after state it
// is about to get, and the record persisted (onRecord: layers.json, the
// layer's ROLLBACK.sh and anyengine-off, Tasks 23 and 24) before the file
// itself changes. A flip killed at any point leaves a record that already
// names every file it may have touched. A layer whose rollback directory
// holds POPPED was undone by the bash anyengine-off and is dropped on read.
//
// Restore is hash-guarded. A file still as `on` left it is restored exactly;
// one already back to its before state is left; one the operator changed is
// reverted line by line when the change can be found exactly once, and
// otherwise left alone and reported. Nothing is overwritten blind.
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { enginePaths, writeJsonAtomic } from './anyengine-config.mjs'
import { findCodexCliBlock, revertHunk, withRcBlock } from './control-rc.mjs'

export type LayerName = 'adapter' | 'router'

export interface FileChange {
  target: string
  before: 'file' | 'symlink' | 'absent'
  backup: string | null
  after: string | null
  mode: number | null
  beforeSha: string | null
  afterSha: string | null
  beforeLink: string | null
  afterLink: string | null
}

export interface Layer {
  name: LayerName
  rollbackDir: string
  adoptedFrom: string | null
  createdAt: string
  changes: FileChange[]
  jobs: string[]
  cleansCache: boolean
  sharedConfig?: SharedConfigRecord | null
  pending?: 'after-quit' | null
}

export interface SharedConfigRecord {
  target: string
  pickFile: string
  backup: string
  removed: Array<{ key: string; value: string; index: number; text: string }>
}

export interface LayerFile {
  version: 1
  layers: Layer[]
}

export type RestoreOutcome = 'restored' | 'already' | 'reverted-hunk' | 'left-changed'

export function sha256Of(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

function linkOf(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null
  } catch {
    return null
  }
}

export const POPPED = 'POPPED'

export function readLayers(root: string): LayerFile {
  try {
    const parsed = JSON.parse(readFileSync(enginePaths(root).layers, 'utf8')) as LayerFile
    if (parsed?.version !== 1 || !Array.isArray(parsed.layers)) return { version: 1, layers: [] }
    const live = parsed.layers.filter((layer) => !lstatSync(join(layer.rollbackDir, POPPED), { throwIfNoEntry: false }))
    return { version: 1, layers: live }
  } catch {
    return { version: 1, layers: [] }
  }
}

export function writeLayers(root: string, file: LayerFile): void {
  if (file.layers.length === 0) rmSync(enginePaths(root).layers, { force: true })
  else writeJsonAtomic(enginePaths(root).layers, file)
}

function isText(bytes: Buffer): boolean {
  return bytes.length < 1_000_000 && !bytes.includes(0)
}

// Swap a symlink in one rename: a shim starting mid-swap sees old or new.
function swapLink(target: string, to: string): void {
  const temp = `${target}.anyengine-${process.pid}`
  rmSync(temp, { force: true })
  symlinkSync(to, temp)
  renameSync(temp, target)
}

export type OnRecord = (layer: Layer) => void

export class LayerWriter {
  readonly layer: Layer
  private count: number
  private readonly onRecord: OnRecord

  constructor(root: string, existing: Layer | null, name: LayerName, stamp: string, onRecord: OnRecord = () => {}) {
    this.onRecord = onRecord
    this.layer = existing ?? {
      name,
      rollbackDir: join(root, `rollback-${stamp}-${name}`),
      adoptedFrom: null,
      createdAt: new Date().toISOString(),
      changes: [],
      jobs: [],
      cleansCache: name === 'router',
    }
    this.count = this.layer.changes.length
    mkdirSync(this.layer.rollbackDir, { recursive: true, mode: 0o700 })
  }

  track(target: string): FileChange {
    const known = this.layer.changes.find((c) => c.target === target)
    if (known) return known
    const index = String(this.count++).padStart(2, '0')
    const link = linkOf(target)
    const sha = sha256Of(target)
    const blank = { backup: null, after: null, mode: null, beforeSha: null, afterSha: null, beforeLink: null, afterLink: null }
    let change: FileChange
    if (link !== null) {
      change = { ...blank, target, before: 'symlink', beforeLink: link, afterLink: link }
    } else if (sha !== null) {
      const backup = `${index}-${basename(target)}.bak`
      copyFileSync(target, join(this.layer.rollbackDir, backup))
      const mode = lstatSync(target).mode & 0o777
      chmodSync(join(this.layer.rollbackDir, backup), mode)
      change = { ...blank, target, before: 'file', backup, mode, beforeSha: sha, afterSha: sha }
    } else {
      change = { ...blank, target, before: 'absent' }
    }
    this.layer.changes.push(change)
    return change
  }

  // Writes only when the content or mode differs; returns whether it wrote.
  // The record (with the after hash and bytes) is persisted first.
  writeFile(target: string, content: string | Buffer, mode: number): boolean {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const wanted = createHash('sha256').update(bytes).digest('hex')
    const stat = lstatSync(target, { throwIfNoEntry: false })
    if (sha256Of(target) === wanted && stat && (stat.mode & 0o777) === mode) return false
    const change = this.track(target)
    change.afterSha = wanted
    change.afterLink = null
    if (isText(bytes)) {
      const stem = change.backup ?? `${String(this.layer.changes.indexOf(change)).padStart(2, '0')}-${basename(target)}`
      change.after = `${stem}.after`
      writeFileSync(join(this.layer.rollbackDir, change.after), bytes, { mode: 0o600 })
    }
    this.onRecord(this.layer)
    mkdirSync(dirname(target), { recursive: true })
    const temp = `${target}.anyengine-${process.pid}`
    writeFileSync(temp, bytes, { mode })
    chmodSync(temp, mode)
    renameSync(temp, target)
    this.settle(target)
    return true
  }

  writeSymlink(target: string, to: string): boolean {
    if (linkOf(target) === to) return false
    const change = this.track(target)
    change.afterLink = to
    change.afterSha = null
    this.onRecord(this.layer)
    mkdirSync(dirname(target), { recursive: true })
    swapLink(target, to)
    this.settle(target)
    return true
  }

  settle(target: string): void {
    const change = this.track(target)
    change.afterSha = sha256Of(target)
    change.afterLink = linkOf(target)
  }

  // A job is recorded (and persisted) before it is loaded.
  addJob(label: string): void {
    if (this.layer.jobs.includes(label)) return
    this.layer.jobs.push(label)
    this.onRecord(this.layer)
  }
}

// Is the hand-flipped M0 on right now? Both halves must be: the rc's
// CODEX_SHELL block active, and ~/bin/codex the shim M0 installed. The marker
// line alone does not tell: the shim from before M0 carried it too, so the
// shim counts as M0's only when it is not the manifest's backup of it. One
// half without the other is a state `on` must not guess about.
export function m0Active(home: string, shimBackupSha: string | null): { rc: boolean; shim: boolean } {
  const read = (path: string) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }
  return {
    rc: findCodexCliBlock(read(join(home, '.zshrc'))).state === 'active',
    shim:
      read(join(home, 'bin', 'codex')).includes('(marker: ANYENGINE_ADAPTER)') &&
      sha256Of(join(home, 'bin', 'codex')) !== shimBackupSha,
  }
}

export type Adoption = { layer: Layer } | { refused: string } | null

// The M0 flip done by hand: the newest rollback-* directory whose manifest
// lists exactly the rc, the shim and runtime.env, adopted only while M0 is
// verifiably on (m0Active). Its backups are the before state. The rc's after
// state is what `on` itself would make of the backup, withRcBlock(backup), so
// the recorded hunk is exactly the CODEX_SHELL block (H2): an rc the operator
// edited since, or whose hand-made block differs, is then reverted by hunk,
// never overwritten. The shim's and runtime.env's after states are the files
// as they are now. Everything is copied into a layer directory of AnyEngine's
// own; the operator's directory is only read. A manifest writes `mode` as a
// number or an octal string. Returns null when there is no M0 to adopt (no
// such manifest, or M0 plainly off), and `refused` when a manifest exists and
// M0 is half on.
export function adoptM0(root: string, home: string, stamp: string): Adoption {
  const wanted = ['.zshrc', 'bin/codex', '.anyengine/runtime.env'].map((p) => join(home, p)).sort()
  let dirs: string[] = []
  try {
    dirs = readdirSync(root).filter((d) => /^rollback-\d{8}T\d{6}Z$/.test(d)).sort().reverse()
  } catch {
    return null
  }
  for (const dir of dirs) {
    let entries: Array<{ target: string; backup: string | null; mode: string | number | null }>
    try {
      entries = JSON.parse(readFileSync(join(root, dir, 'manifest.json'), 'utf8')).entries ?? []
    } catch {
      continue
    }
    if (JSON.stringify(entries.map((e) => e.target).sort()) !== JSON.stringify(wanted)) continue
    const shimEntry = entries.find((e) => e.target === join(home, 'bin', 'codex'))
    const active = m0Active(home, shimEntry?.backup ? sha256Of(join(root, dir, shimEntry.backup)) : null)
    if (!active.rc && !active.shim) return null
    if (!active.rc || !active.shim) {
      return { refused: `M0's rollback ${join(root, dir)} exists but M0 is half on (rc block ${active.rc ? 'active' : 'not active'}, shim ${active.shim ? "M0's" : 'the one from before M0'}); finish or undo M0 by hand first` }
    }
    return { layer: adoptedLayer(root, home, dir, entries, stamp) }
  }
  return null
}

function adoptedLayer(
  root: string,
  home: string,
  dir: string,
  entries: Array<{ target: string; backup: string | null; mode: string | number | null }>,
  stamp: string,
): Layer {
  const layerDir = join(root, `rollback-${stamp}-adapter`)
  mkdirSync(layerDir, { recursive: true, mode: 0o700 })
  const rc = join(home, '.zshrc')
  const changes = entries.map((entry, index): FileChange => {
    const mode = typeof entry.mode === 'string' ? Number.parseInt(entry.mode, 8) : entry.mode
    if (entry.backup) copyFileSync(join(root, dir, entry.backup), join(layerDir, entry.backup))
    const backupBytes = entry.backup ? readFileSync(join(root, dir, entry.backup)) : null
    // The rc's after state is derived from its backup; the others are as they are now.
    const now =
      entry.target === rc && backupBytes
        ? Buffer.from(withRcBlock(backupBytes.toString('utf8')).text)
        : lstatSync(entry.target, { throwIfNoEntry: false })
          ? readFileSync(entry.target)
          : null
    const after = now && isText(now) ? `${String(index).padStart(2, '0')}-${basename(entry.target)}.after` : null
    if (after && now) writeFileSync(join(layerDir, after), now, { mode: 0o600 })
    return {
      target: entry.target,
      before: entry.backup ? 'file' : 'absent',
      backup: entry.backup,
      after,
      mode: mode ?? null,
      beforeSha: backupBytes ? createHash('sha256').update(backupBytes).digest('hex') : null,
      afterSha: now ? createHash('sha256').update(now).digest('hex') : null,
      beforeLink: null,
      afterLink: null,
    }
  })
  return { name: 'adapter', rollbackDir: layerDir, adoptedFrom: join(root, dir), createdAt: new Date().toISOString(), changes, jobs: [], cleansCache: false }
}

function restoreFile(change: FileChange, dir: string, allowHunk: boolean): { outcome: RestoreOutcome; detail: string } {
  const current = sha256Of(change.target)
  if (current === change.beforeSha) return { outcome: 'already', detail: 'already as before' }
  if (current === change.afterSha && change.backup) {
    const temp = `${change.target}.anyengine-${process.pid}`
    copyFileSync(join(dir, change.backup), temp)
    chmodSync(temp, change.mode ?? 0o644)
    renameSync(temp, change.target)
    return { outcome: 'restored', detail: 'restored from backup' }
  }
  if (allowHunk && change.backup && change.after && current !== null) {
    const text = readFileSync(change.target, 'utf8')
    const before = readFileSync(join(dir, change.backup), 'utf8')
    const after = readFileSync(join(dir, change.after), 'utf8')
    const reverted = revertHunk(text, before, after)
    if (reverted !== null) {
      writeFileSync(change.target, reverted)
      return { outcome: 'reverted-hunk', detail: "changed since; only AnyEngine's lines were taken out" }
    }
    // AnyEngine's lines are already out (the bash anyengine-off commented the
    // block, or the operator did): the before hunk is there exactly once.
    if (revertHunk(text, after, before) !== null) return { outcome: 'already', detail: "AnyEngine's lines are already taken out" }
  }
  return { outcome: 'left-changed', detail: `changed since AnyEngine wrote it; the original is ${join(dir, change.backup ?? '')}` }
}

export function restoreChange(change: FileChange, rollbackDir: string, allowHunk: boolean): { outcome: RestoreOutcome; detail: string } {
  if (change.before === 'symlink') {
    const current = linkOf(change.target)
    if (current === change.beforeLink) return { outcome: 'already', detail: 'already as before' }
    if (current !== change.afterLink || !change.beforeLink) return { outcome: 'left-changed', detail: `points at ${current ?? 'nothing'}, not what AnyEngine set` }
    swapLink(change.target, change.beforeLink)
    return { outcome: 'restored', detail: `-> ${change.beforeLink}` }
  }
  if (change.before === 'absent') {
    if (!lstatSync(change.target, { throwIfNoEntry: false })) return { outcome: 'already', detail: 'already absent' }
    const same = change.afterLink !== null ? linkOf(change.target) === change.afterLink : sha256Of(change.target) === change.afterSha
    if (!same) return { outcome: 'left-changed', detail: 'AnyEngine created it, and it changed since' }
    rmSync(change.target, { force: true })
    return { outcome: 'restored', detail: 'removed (AnyEngine created it)' }
  }
  return restoreFile(change, rollbackDir, allowHunk)
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/control-layers.test.mjs`
Expected: PASS, `ℹ pass 6`, `ℹ fail 0`.

- [ ] **Step 7: Gates, commit**

Add `control-rc.mts` and `control-layers.mts` to `src/AGENTS.md` ("the login-shell rc block; layers of recorded changes, write-ahead, M0 adoption, hash-guarded restore").

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/control-rc.mts src/control-layers.mts test/fixtures/m0-live-layout test/helpers/m0-home.mts \
  test/control-layers.test.mts src/AGENTS.md
git commit -m "feat: record on as write-ahead layers, adopt a live M0, restore by hash"
```

**Acceptance:** with the synthetic M0 layout, adoption records the rc's after state as `withRcBlock(backup)` and reverts an rc edited since by hunk; a half-on M0 is refused and an M0 that is off is not adopted; every change is persisted before the file changes, and a record written by a flip killed at any point undoes exactly what happened; restore never overwrites a file changed since; a layer popped by the bash script is dropped on read.

---
### Task 23: Rollback scripts and the Node-free `anyengine-off`

Spec 3: "Every live change is reversible with one command. The command must work when Node, the lib or the router is broken." Each layer gets a `ROLLBACK.sh`, and `~/.anyengine/bin/anyengine-off` pops the layers with bash and the system's own tools only. The review's rules (H2, M1, M2, M4) shape it: the rc goes first, because it is what points the app at AnyEngine; when the rc cannot be restored (the operator edited it since), bash takes AnyEngine's block out of it and keeps the shim and `runtime.env` for a later `anyengine off` to finish, so the app is never left pointed at a missing shim; `--router-only` pops only the router layer; `layers.json` is removed only when every layer was undone cleanly; nothing that the running app depends on goes before the app has actually quit: the router and smoke jobs are booted out, the shared `config.toml` line is put back and the models cache is moved aside after the quit and before the reopen, and when the app does not quit, the script reopens nothing, keeps the jobs running (so the app keeps working) and says how to finish (MEDIUM 5); the `config.toml` line goes back only if no top-level key of that name exists, with the pick file's current value, and never counts as a failure (HIGH 1); `--router-only` pops only a layer named `router`; a staged app update is named before the quit and is expected on the way back. Task 24 writes these scripts on every `on`; Task 25 proves them on a scratch copy before the live switch-on.

**Files:**
- Create: `src/control-scripts.mts`
- Create: `test/control-scripts.test.mts`
- Modify: `scripts/test-hermetic.mjs` (`ANYENGINE_PGREP` points at the refusing stub), `docs/guide/configuration.md` (`ANYENGINE_PGREP`, `ANYENGINE_QUIT_WAIT`), `docs/guide/control.md` (the way back), `src/AGENTS.md`

**Interfaces:**
- Consumes: Task 22 (`Layer`, `FileChange`, `SharedConfigRecord`, `POPPED`, `RC_BEGIN`, `RC_END`), Task 19 (the refusing stub in `scripts/test-hermetic.mjs`).
- Produces:

```ts
// src/control-scripts.mts
export function shellQuote(value: string): string                  // '...' with ' as '\''
export function isRcChange(change: FileChange): boolean            // a .zshrc / .bash_profile the layer changed
// flags: --files-only (the files, before the quit), --after-quit (jobs, shared config, cache), --copy-only (files, for the proof); no flag: all of it
export function rollbackScript(layer: Layer, options: { codexHome: string }): string
export function offScript(layers: Layer[], options: { root: string; app: string; bundleId: string; codexHome: string }): string   // flags: --router-only, --no-restart
```

- [x] **Step 1: Write the failing tests**

Create `test/control-scripts.test.mts`. It builds the two layers by hand with Task 22's `adoptM0` and `LayerWriter` (Task 24 does the same through `applyOnFiles`), writes the scripts, and runs them with `/bin/bash`, `PATH=/usr/bin:/bin` and no Node:

```ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { enginePaths } from '../src/anyengine-config.mjs'
import { adoptM0, type Layer, LayerWriter, POPPED, readLayers, restoreChange, sha256Of, writeLayers } from '../src/control-layers.mjs'
import { findCodexCliBlock } from '../src/control-rc.mjs'
import { offScript, rollbackScript } from '../src/control-scripts.mjs'
import { m0Home } from './helpers/m0-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)

const STAMP = '20261001T000000Z'

function layered(home: string): { root: string; adapter: Layer; router: Layer; codexHome: string } {
  const root = join(home, '.anyengine')
  const codexHome = join(home, '.codex')
  mkdirSync(codexHome, { recursive: true })
  const adopted = adoptM0(root, home, STAMP)
  assert.ok(adopted && 'layer' in adopted)
  const adapter = adopted.layer
  const writer = new LayerWriter(root, null, 'router', STAMP)
  mkdirSync(join(root, 'lib', '0.1.0-m1test'), { recursive: true })
  writer.writeSymlink(join(root, 'lib', 'current'), '0.1.0-m1test')
  writer.writeFile(join(home, 'bin', 'codex'), '#!/usr/bin/env bash\n# anyengine codex shim (marker: ANYENGINE_ADAPTER) m1\n', 0o755)
  writer.writeFile(join(root, 'bin', 'anyengine'), '#!/usr/bin/env bash\nexit 0\n', 0o755)
  writer.writeFile(join(home, 'Library', 'LaunchAgents', 'dev.anyengine.router.plist'), '<plist/>\n', 0o644)
  writer.addJob('dev.anyengine.router')
  const router = writer.layer
  // The shared config line, as Task 24's applySharedConfig records it.
  const toml = join(codexHome, 'config.toml')
  copyFileSync(join(home, '.codex', 'config.toml'), join(router.rollbackDir, 'config.toml.bak'))
  const pickFile = join(codexHome, 'anyengine', 'app-model-pick.json')
  mkdirSync(join(codexHome, 'anyengine'), { recursive: true })
  writeFileSync(pickFile, '{\n  "model": "sonnet"\n}\n')
  writeFileSync(toml, readFileSync(toml, 'utf8').replace('model = "sonnet"\n', ''))
  router.sharedConfig = { target: toml, pickFile, backup: 'config.toml.bak', removed: [{ key: 'model', value: 'sonnet', index: 0, text: 'model = "sonnet"' }] }
  const options = { root, app: '/Applications/ChatGPT.app', bundleId: 'com.openai.codex', codexHome }
  for (const layer of [adapter, router]) writeFileSync(join(layer.rollbackDir, 'ROLLBACK.sh'), rollbackScript(layer, { codexHome }), { mode: 0o755 })
  writeFileSync(join(root, 'bin', 'anyengine-off'), offScript([adapter, router], options), { mode: 0o755 })
  writeLayers(root, { version: 1, layers: [adapter, router] })
  return { root, adapter, router, codexHome }
}

function stubs(home: string, options: { appStaysUp?: boolean } = {}) {
  const recorder = join(home, 'calls.log')
  const stub = (name: string, body: string) => {
    const path = join(home, `stub-${name}.sh`)
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return path
  }
  return {
    recorder,
    env: {
      HOME: home,
      PATH: '/usr/bin:/bin',
      ANYENGINE_LAUNCHCTL: stub('launchctl', `echo "launchctl $*" >> '${recorder}'`),
      ANYENGINE_OSASCRIPT: stub('osascript', `echo "quit" >> '${recorder}'`),
      ANYENGINE_OPEN: stub('open', `if [ -e '${join(home, '.codex', 'models_cache.json')}' ]; then echo "open cache=present" >> '${recorder}'; else echo "open cache=absent" >> '${recorder}'; fi`),
      ANYENGINE_PGREP: stub('pgrep', options.appStaysUp ? 'exit 0' : 'exit 1'),
      ANYENGINE_QUIT_WAIT: '1',
    },
  }
}

const off = (root: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  spawnSync('/bin/bash', [join(root, 'bin', 'anyengine-off'), ...args], { encoding: 'utf8', env })

test('anyengine-off undoes every layer without node, and removes layers.json only when clean', async () => {
  const home = await m0Home()
  const { root, adapter } = layered(home)
  const { env, recorder } = stubs(home)
  const run = off(root, env, '--no-restart')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  const bk = adapter.rollbackDir
  assert.equal(sha256Of(join(home, 'bin', 'codex')), sha256Of(join(bk, '01-codex.bak')))
  assert.equal(sha256Of(join(home, '.zshrc')), sha256Of(join(bk, '00-.zshrc.bak')))
  assert.equal(readlinkSync(join(root, 'lib', 'current')), '0.1.0-986ab707750e')
  assert.ok(!existsSync(join(home, 'Library', 'LaunchAgents', 'dev.anyengine.router.plist')))
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), 'model = "sonnet"\nmodel_reasoning_effort = "medium"\n', 'the line is back where it was')
  assert.ok(!existsSync(join(home, '.codex', 'anyengine', 'app-model-pick.json')), 'the pick file goes')
  assert.ok(!existsSync(enginePaths(root).layers))
  assert.ok(!existsSync(join(root, 'bin', 'anyengine-off')))
  assert.match(readFileSync(recorder, 'utf8'), /launchctl bootout gui\/\d+\/dev\.anyengine\.router/)
})

test('anyengine-off --router-only undoes only the router layer and marks it popped', async () => {
  const home = await m0Home()
  const { root, router } = layered(home)
  const { env } = stubs(home)
  const run = off(root, env, '--router-only', '--no-restart')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(readFileSync(join(home, 'bin', 'codex'), 'utf8'), /m0/)
  assert.equal(readlinkSync(join(root, 'lib', 'current')), '0.1.0-986ab707750e')
  assert.equal(findCodexCliBlock(readFileSync(join(home, '.zshrc'), 'utf8')).state, 'active', 'M0 stays on')
  assert.ok(existsSync(join(router.rollbackDir, POPPED)))
  assert.deepEqual(readLayers(root).layers.map((l) => l.name), ['adapter'])
  assert.ok(existsSync(join(root, 'bin', 'anyengine-off')), 'still there for the adapter layer')
})

test('anyengine-off: an rc it cannot restore loses its block by bash; the shim and runtime.env stay for off to finish', async () => {
  const home = await m0Home()
  const { root, adapter } = layered(home)
  const { env } = stubs(home)
  const rcBefore = readFileSync(join(adapter.rollbackDir, '00-.zshrc.bak'), 'utf8')
  writeFileSync(join(home, '.zshrc'), `${readFileSync(join(home, '.zshrc'), 'utf8')}alias ll='ls -l'\n`)
  const run = off(root, env, '--no-restart')
  assert.notEqual(run.status, 0)
  assert.match(run.stdout, /KEPT .*bin\/codex/)
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), `${rcBefore}alias ll='ls -l'\n`, 'the block is commented exactly as M0 had it')
  assert.match(readFileSync(join(home, 'bin', 'codex'), 'utf8'), /m0/, 'the router layer still restored the M0 shim; the adapter layer kept it')
  assert.ok(existsSync(enginePaths(root).layers))
  assert.deepEqual(readLayers(root).layers.map((l) => l.name), ['adapter'])
  // The Node path finishes the job: the rc is already as before, the rest is restored.
  const outcomes = adapter.changes.map((c) => restoreChange(c, adapter.rollbackDir, true).outcome)
  assert.deepEqual(outcomes, ['already', 'restored', 'restored'])
})

test('anyengine-off boots out the jobs, restores the shared config and moves the cache only after the quit, then reopens', async () => {
  const home = await m0Home()
  const { root, router, codexHome } = layered(home)
  const { env, recorder } = stubs(home)
  writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'opus', description: 'Claude Opus, via AnyEngine' }] }))
  const run = off(root, env, '--router-only')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  const calls = readFileSync(recorder, 'utf8').split('\n').filter((l) => l === 'quit' || l.startsWith('open') || l.includes('bootout'))
  assert.equal(calls[0], 'quit', 'nothing the app depends on goes before the quit')
  assert.match(calls[1] ?? '', /bootout gui\/\d+\/dev\.anyengine\.router/)
  assert.equal(calls.at(-1), 'open cache=absent')
  assert.ok(existsSync(join(router.rollbackDir, 'models_cache.json')))
  assert.ok(existsSync(join(router.rollbackDir, POPPED)))
})

test('anyengine-off: an app that does not quit is not reopened, keeps its router, and the layer stays for a second run', async () => {
  const home = await m0Home()
  const { root, router } = layered(home)
  const { env, recorder } = stubs(home, { appStaysUp: true })
  const run = off(root, env, '--router-only')
  assert.notEqual(run.status, 0)
  assert.match(run.stdout, /did not quit/)
  const calls = readFileSync(recorder, 'utf8')
  assert.doesNotMatch(calls, /bootout/, 'the router keeps running, so the app keeps working')
  assert.doesNotMatch(calls, /open/)
  assert.ok(!existsSync(join(router.rollbackDir, POPPED)))
  assert.match(readFileSync(join(home, 'bin', 'codex'), 'utf8'), /m0/, 'the files are back already')
  const again = off(root, stubs(home).env, '--router-only')
  assert.equal(again.status, 0, again.stdout + again.stderr)
  assert.ok(existsSync(join(router.rollbackDir, POPPED)))
})

test('anyengine-off: a GPT pick made while M1 was on is kept, never duplicated; a changed Claude pick goes back', async () => {
  const gptHome = await m0Home()
  const gpt = layered(gptHome)
  // The app picked GPT while M1 was on: codex wrote the key, and the adapter
  // dropped its pick (Task 5).
  writeFileSync(join(gpt.codexHome, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n')
  rmSync(join(gpt.codexHome, 'anyengine', 'app-model-pick.json'))
  const kept = off(gpt.root, stubs(gptHome).env, '--router-only', '--no-restart')
  assert.equal(kept.status, 0, kept.stdout + kept.stderr)
  assert.match(kept.stdout, /kept the model line/)
  assert.equal(readFileSync(join(gpt.codexHome, 'config.toml'), 'utf8'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n')
  const opusHome = await m0Home()
  const opus = layered(opusHome)
  writeFileSync(join(opus.codexHome, 'anyengine', 'app-model-pick.json'), '{\n  "model": "opus"\n}\n')
  writeFileSync(join(opus.codexHome, 'config.toml'), 'model_reasoning_effort = "high"\n')
  const back = off(opus.root, stubs(opusHome).env, '--router-only', '--no-restart')
  assert.equal(back.status, 0, back.stdout + back.stderr)
  assert.equal(readFileSync(join(opus.codexHome, 'config.toml'), 'utf8'), 'model = "opus"\nmodel_reasoning_effort = "high"\n', 'the newer pick, not the backup')
  assert.ok(!existsSync(join(opus.codexHome, 'anyengine', 'app-model-pick.json')))
})

test('rollback scripts quote every path', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const odd = join(home, "it's here.txt")
  writeFileSync(odd, 'before\n')
  const writer = new LayerWriter(root, null, 'router', STAMP)
  writer.writeFile(odd, 'after\n', 0o644)
  writeFileSync(join(writer.layer.rollbackDir, 'ROLLBACK.sh'), rollbackScript(writer.layer, { codexHome: join(home, '.codex') }), { mode: 0o755 })
  const run = spawnSync('/bin/bash', [join(writer.layer.rollbackDir, 'ROLLBACK.sh'), '--copy-only'], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(readFileSync(odd, 'utf8'), 'before\n')
})
```

- [x] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/control-scripts.mjs'`.

- [x] **Step 3: Write the rollback script**

Create `src/control-scripts.mts`. `rollbackScript(layer, { codexHome })` returns a bash 3.2 script (`#!/usr/bin/env bash`, `set -u`, `BK=<layer dir>`, `RC_BEGIN_LINE=<RC_BEGIN>`, `RC_END_LINE=<RC_END>`) that:

1. the files, unless `--after-quit`: the layer's rc change first, when it has one (`isRcChange`: the target's basename is `.zshrc` or `.bash_profile`), with `restore_rc`; then every other change, newest first, as one line calling `restore_file`, `remove_created` or `restore_link`; in a layer with an rc change each of these lines is prefixed `rc_gate '<target>' &&`, so nothing the rc still points at is removed while the rc could not be restored;
2. the part the running app depends on, unless `--files-only` or `--copy-only`: it boots out each of the layer's jobs (`"${ANYENGINE_LAUNCHCTL:-/bin/launchctl}" bootout "gui/$(id -u)/<label>" 2>/dev/null || true`); when the layer has a `sharedConfig` record, puts each removed line back with `restore_model_line` and removes the pick file (`rm -f`); and, when `cleansCache`, moves `<codexHome>/models_cache.json` into `$BK` if `grep -q 'via AnyEngine'` matches it;
3. prints one `[rollback]` line per item and exits `$FAILED` (the shared config never sets it).

`anyengine-off` runs `--files-only` before the app's quit and `--after-quit` once the app is gone; the proof (Task 25) runs `--copy-only`; with no flag a script does all of it in order, for a person running it by hand.

Every path is single-quoted with `shellQuote` and absolute. The functions at the top of every script:

```bash
FAILED=0
RC_OK=1
sha() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }
restore_file() {
  local cur; cur="$(sha "$1" || true)"
  if [ "$cur" = "$5" ]; then echo "[rollback] $1 already as before"
  elif [ "$cur" = "$4" ]; then install -m "$3" "$BK/$2" "$1" && echo "[rollback] restored $1"
  else echo "[rollback] LEFT $1: changed since AnyEngine wrote it (anyengine off reverts only its lines; original: $BK/$2)"; FAILED=1; fi
}
remove_created() {
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then echo "[rollback] $1 already absent"; return; fi
  if [ -n "$3" ] && [ "$(readlink "$1" 2>/dev/null)" = "$3" ]; then rm -f "$1" && echo "[rollback] removed $1"; return; fi
  if [ -n "$2" ] && [ "$(sha "$1" || true)" = "$2" ]; then rm -f "$1" && echo "[rollback] removed $1"; return; fi
  echo "[rollback] LEFT $1: AnyEngine created it and it changed since"; FAILED=1
}
restore_link() {
  local cur; cur="$(readlink "$1" 2>/dev/null || true)"
  if [ "$cur" = "$2" ]; then echo "[rollback] $1 already -> $2"
  elif [ "$cur" = "$3" ]; then ln -sfh "$2" "$1" && echo "[rollback] $1 -> $2"
  else echo "[rollback] LEFT $1: points at ${cur:-nothing}"; FAILED=1; fi
}
# The rc first (H2). Restored or already as before: RC_OK=1. Changed since:
# bash takes AnyEngine's block out (the marked block is deleted; M0's unmarked
# CODEX_SHELL block is commented exactly as M0's backup had it), RC_OK=2, and
# the files the block pointed at stay for `anyengine off` to finish. Neither:
# RC_OK=0 and everything stays.
restore_rc() {
  local cur; cur="$(sha "$1" || true)"
  if [ "$cur" = "$5" ]; then echo "[rollback] $1 already as before"; return; fi
  if [ "$cur" = "$4" ]; then install -m "$3" "$BK/$2" "$1" && echo "[rollback] restored $1" && return; fi
  if take_block_out "$1"; then
    RC_OK=2; FAILED=1
    echo "[rollback] $1 changed since; AnyEngine's block was taken out by bash, so the app runs its own codex. Run anyengine off to finish."
    return
  fi
  RC_OK=0; FAILED=1
  echo "[rollback] LEFT $1: changed since, and AnyEngine's block could not be found exactly once (original: $BK/$2)"
}
# The shared config.toml line (decision D15): back only if no top-level key of
# that name exists now (a newer pick written while AnyEngine was on is kept),
# with the pick file's value when it has one; at its old line when the
# top-level section reaches that far, else at the section's end. Never FAILED.
restore_model_line() {  # target pickfile key backupValue index
  local f="$1" pick="$2" key="$3" value="$4" at="$5" picked tmp
  [ -f "$f" ] || : > "$f"
  if awk -v k="$key" 'BEGIN{found=0} /^[[:space:]]*\[/{exit} $0 ~ ("^[[:space:]]*" k "[[:space:]]*=") {found=1; exit} END{exit found ? 0 : 1}' "$f"; then
    echo "[rollback] kept the $key line of $f: it was set while AnyEngine was on"
    return
  fi
  picked="$(sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([A-Za-z0-9._:\/-]*\)\".*/\1/p" "$pick" 2>/dev/null | head -1)"
  [ -n "$picked" ] && value="$picked"
  tmp="$f.anyengine-off.$$"
  awk -v n="$at" -v line="$key = \"$value\"" '!done && (NR == n + 1 || /^[[:space:]]*\[/) {print line; done=1} {print} END{if (!done) print line}' "$f" > "$tmp" && cat "$tmp" > "$f"
  rm -f "$tmp"
  echo "[rollback] put back $key = \"$value\" in $f"
}
rc_gate() {
  [ "$RC_OK" = 1 ] && return 0
  echo "[rollback] KEPT $1: the rc was not restored, so what it points at stays for anyengine off"; FAILED=1; return 1
}
GUARD_RE='^[[:space:]]*if \[\[ -n "\$CODEX_SHELL" \]\]; then[[:space:]]*$'
EXPORT_RE='^[[:space:]]*export CODEX_CLI_PATH='
FI_RE='^[[:space:]]*fi[[:space:]]*$'
take_block_out() {
  local f="$1" n=0 i begin=-1 end=-1 found=-1 count=0 line tmp nl=1
  local -a L
  while IFS= read -r line || [ -n "$line" ]; do L[n]="$line"; n=$((n + 1)); done < "$f"
  [ -n "$(tail -c1 "$f")" ] && nl=0
  for ((i = 0; i < n; i++)); do
    if [ "${L[i]}" = "$RC_BEGIN_LINE" ]; then [ "$begin" -ge 0 ] && return 1; begin=$i; fi
    if [ "${L[i]}" = "$RC_END_LINE" ] && [ "$begin" -ge 0 ] && [ "$end" -lt 0 ]; then end=$i; fi
  done
  [ "$begin" -ge 0 ] && [ "$end" -lt 0 ] && return 1
  if [ "$begin" -lt 0 ]; then
    for ((i = 0; i + 2 < n; i++)); do
      if [[ ${L[i]} =~ $GUARD_RE ]] && [[ ${L[i+1]} =~ $EXPORT_RE ]] && [[ ${L[i+2]} =~ $FI_RE ]]; then found=$i; count=$((count + 1)); fi
    done
    [ "$count" -gt 1 ] && return 1
    if [ "$count" -eq 0 ]; then echo "[rollback] $f: no active AnyEngine block"; return 0; fi
  fi
  tmp="$f.anyengine-off.$$"
  : > "$tmp" || return 1
  for ((i = 0; i < n; i++)); do
    if [ "$begin" -ge 0 ] && [ "$i" -ge "$begin" ] && [ "$i" -le "$end" ]; then continue; fi
    line="${L[i]}"
    if [ "$found" -ge 0 ] && [ "$i" -ge "$found" ] && [ "$i" -le $((found + 2)) ]; then line="# $line"; fi
    if [ "$i" -lt $((n - 1)) ] || [ "$nl" = 1 ]; then printf '%s\n' "$line" >> "$tmp"; else printf '%s' "$line" >> "$tmp"; fi
  done
  cat "$tmp" > "$f" && rm -f "$tmp"
}
```

with one generated line per removed shared-config line, `restore_model_line '<target>' '<pickFile>' '<key>' '<value>' <index>` (the generator writes it only for a key and value matching `^[A-Za-z0-9._:/-]+$`, which model ids do; any other value is left for `anyengine off` and says so), and one generated line per change: `restore_rc '<target>' '<backup>' '<mode octal>' '<afterSha>' '<beforeSha>'`, `restore_file '<target>' '<backup>' '<mode octal>' '<afterSha>' '<beforeSha>'`, `remove_created '<target>' '<afterSha or empty>' '<afterLink or empty>'`, or `restore_link '<target>' '<beforeLink>' '<afterLink>'` (`ln -sfh` replaces a link to a directory instead of following it). `cat "$tmp" > "$f"` keeps the rc's inode and mode.

- [x] **Step 4: Write `anyengine-off`**

`offScript(layers, { root, app, bundleId, codexHome })` returns `~/.anyengine/bin/anyengine-off`:

```bash
#!/usr/bin/env bash
# anyengine-off: undo AnyEngine with bash alone, when Node, the lib or the
# router is broken. Layers go newest first; the router layer's rollback
# restores the M0 state, the adapter layer's the state before AnyEngine.
# The files go first; what the running app depends on (the router job, the
# shared config line, the models cache) goes only once the app has quit, so an
# app that will not quit keeps working. A layer undone cleanly, both halves, is
# marked POPPED (Node's readLayers drops it); one that is not stays recorded
# for a second run or `anyengine off`. layers.json and this script go only when
# every layer was undone cleanly.
set -u
ROUTER_ONLY=0
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --router-only) ROUTER_ONLY=1 ;;
    --no-restart) RESTART=0 ;;
    *) echo "usage: anyengine-off [--router-only] [--no-restart]" >&2; exit 2 ;;
  esac
done
STATUS=0
FILES_DONE=''
files() {
  if [ -e "$2/POPPED" ]; then echo "[anyengine-off] the $1 layer was already undone"; return 0; fi
  if /bin/bash "$2/ROLLBACK.sh" --files-only; then
    FILES_DONE="$FILES_DONE $2"
    echo "[anyengine-off] the $1 layer's files are back"
    return 0
  fi
  echo "[anyengine-off] the $1 layer is only partly undone and stays recorded; run anyengine off when Node works"
  STATUS=1
  return 1
}
after_quit() {
  local dir
  for dir in $FILES_DONE; do
    /bin/bash "$dir/ROLLBACK.sh" --after-quit && : > "$dir/POPPED"
  done
}
staged_notice() {
  local sparkle="$HOME/Library/Caches/<bundleId>/org.sparkle-project.Sparkle"
  if [ -n "$(ls -A "$sparkle/Installation" "$sparkle/PersistentDownloads" 2>/dev/null)" ] ||
    "${ANYENGINE_LAUNCHCTL:-/bin/launchctl}" print "gui/$(id -u)/<bundleId>-sparkle-updater" >/dev/null 2>&1; then
    echo "[anyengine-off] an app update is staged and installs with this restart; on the way back that is expected"
  fi
}
```

followed by one `files` line per layer, newest first: the router layer's unconditional, every other layer's as `[ "$ROUTER_ONLY" = 1 ] || files <name> <dir>`, so `--router-only` pops a layer only if it is named `router` (the generator emits the unconditional line for a layer named `router` and nothing else). Then (a rollback directory path never holds a space: it is `<root>/rollback-<stamp>-<name>`):

```bash
if [ "$RESTART" = 1 ]; then
  staged_notice
  "${ANYENGINE_OSASCRIPT:-/usr/bin/osascript}" -e 'quit app "ChatGPT"' >/dev/null 2>&1 || true
  WAIT=$(( ${ANYENGINE_QUIT_WAIT:-30} * 2 ))
  QUIT=0
  for _ in $(seq 1 "$WAIT"); do
    if ! "${ANYENGINE_PGREP:-/usr/bin/pgrep}" -x ChatGPT >/dev/null 2>&1; then QUIT=1; break; fi
    sleep 0.5
  done
  if [ "$QUIT" = 0 ] && ! "${ANYENGINE_PGREP:-/usr/bin/pgrep}" -x ChatGPT >/dev/null 2>&1; then QUIT=1; fi
  if [ "$QUIT" = 1 ]; then
    after_quit
    "${ANYENGINE_OPEN:-/usr/bin/open}" -a <app>
  else
    echo "[anyengine-off] ChatGPT.app did not quit. Its files are back, and the router still runs, so the app keeps working as it is. Quit it yourself, then run anyengine-off again to finish; it will not reopen the app."
    STATUS=1
  fi
else
  after_quit
  echo "[anyengine-off] no restart: the router is stopped; restart ChatGPT.app now (its GPT went through the router)"
fi
if [ "$STATUS" = 0 ] && [ "$ROUTER_ONLY" = 0 ]; then
  rm -f <root>/state/layers.json "$0"
  echo "[anyengine-off] every layer is undone"
fi
exit "$STATUS"
```

(`<codexHome>`, `<bundleId>`, `<app>` and `<root>` are substituted with `shellQuote`; inside the double-quoted Sparkle path the bundle id is validated against `^[A-Za-z0-9.-]+$` instead.)

In `scripts/test-hermetic.mjs`, add `ANYENGINE_PGREP` pointing at the refusing stub (so no test ever waits on the real app); document it with the other three in `docs/guide/configuration.md`, and `ANYENGINE_QUIT_WAIT` (seconds `anyengine-off` waits for the app to quit, default 30; tests use 1).

- [x] **Step 5: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/control-scripts.test.mjs dist/test/control-layers.test.mjs`
Expected: PASS, `ℹ fail 0`.

Run: `bash -n` on a generated script as a syntax check under the system bash: `T7 node -e "import('./dist/src/control-scripts.mjs').then(m => process.stdout.write(m.offScript([], { root: '/r', app: '/Applications/ChatGPT.app', bundleId: 'com.openai.codex', codexHome: '/c' })))" | /bin/bash -n && /bin/bash --version | head -1`
Expected: no output from `bash -n`, then `GNU bash, version 3.2.57(1)-release ...`.

- [x] **Step 6: Docs, gates, commit**

In `docs/guide/control.md`, add "The way back without Node": what `anyengine-off` does, `--router-only` and `--no-restart`, what `KEPT` and `LEFT` mean, and that `anyengine off` finishes what the bash script kept.

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/control-scripts.mts test/control-scripts.test.mts scripts/test-hermetic.mjs docs/guide/configuration.md \
  docs/guide/control.md src/AGENTS.md
git commit -m "feat: add per-layer rollback scripts and a node-free anyengine-off"
```

**Acceptance:** with bash 3.2, `PATH=/usr/bin:/bin` and no Node, `anyengine-off` undoes both layers and removes `layers.json` and itself; `--router-only` undoes only a layer named `router` and marks it popped; an rc edited since loses only AnyEngine's block and keeps the operator's line, while the shim and `runtime.env` stay and `anyengine off` finishes the rest; the jobs, the shared config line and the models cache go only after the app has quit, and an app that does not quit is not reopened and keeps its router; the `config.toml` line comes back only where no top-level key of its name exists, with the newer pick, never duplicated and never a failure; every path is quoted.

---
### Task 24: The file half of `on` and `off`: launchd jobs, the install, the shared config line

This task writes what `on` changes and what `off` puts back, on top of Task 22's layers and Task 23's scripts: with no layers yet, adopt the live M0 as the adapter layer (or, on a fresh Mac, write it); then the router layer: `lib/current`, the shim, the launcher, the router and smoke LaunchAgents. Every change is persisted before it happens (the layer, its `ROLLBACK.sh` and `anyengine-off`), so a flip killed at any point can be undone. It also writes the one line the review authorised in the shared `~/.codex/config.toml` (decision D15), stages a lib without activating it, and keeps every lib version a layer can roll back to. The app restart around these files is Task 26; a proof of the rollback on a scratch copy is Task 25.

The `~/.codex` write, in the COO's words: "This `~/.codex` write is authorized by the COO under the operator's standing order. It must be minimal, backed up and reversible, and must touch only that line." Only a top-level `model =` (or `review_model =`) line whose value codex cannot serve is removed, recorded in the router layer (with a backup of the file) before it is removed, and the app's pick moves to the adapter's own pick file (Task 5), so the app keeps showing it.

The app rewrites `config.toml` whenever the operator changes a setting, so `off` cannot put that file back by hash or by hunk (HIGH 1): a GPT pick made while M1 was on writes `model = "gpt-6.1-sol"`, and re-inserting `model = "sonnet"` beside it would give the file a duplicate key, which breaks every codex that reads it (the app's, Jinn's `codex exec`, the SSH twin, a terminal codex). So the shared config has a restore of its own: a removed line goes back only if no top-level key of that name exists now, with the pick file's current value when there is one (the operator may have picked another Claude model since), at its old line when the top-level section still reaches that far; the result is checked for duplicate top-level keys before it is written; the pick file is deleted; and neither file ever counts as `left-changed`. And `off` leaves everything the running app depends on (the jobs, the shared config line, the models cache) until the app has quit (MEDIUM 5): `applyOffFiles` puts the files back and marks the popped layers pending; `finishOff`, which Task 26 runs between the quit and the reopen, does the rest.

**Files:**
- Create: `src/control-launchd.mts`, `src/control-install.mts`
- Create: `test/control-install.test.mts`
- Modify: `test/helpers/m0-home.mts` (`fakeLib`), `scripts/install-lib.mjs` (`--no-activate`, `--activate VERSION`, pruning that keeps layer versions), `test/install-lib.test.mts`
- Modify: `docs/guide/control.md`, `docs/guide/deployment.md`, `scripts/AGENTS.md`, `src/AGENTS.md`

**Interfaces:**
- Consumes: Task 19 (`System`, `ExecResult`, `cleanModelsCache`), Task 21 (`nonGptModelLines`, `withoutLines`, `topLevelKeys`, `duplicateTopLevelKeys`, `insertTopLevelLine`), Task 22 (`LayerWriter`, `SharedConfigRecord`, `adoptM0`, `readLayers`, `writeLayers`, `restoreChange`, `OnRecord`, `Layer`), Task 23 (`rollbackScript`, `offScript`, `isRcChange`), Task 5 (`appModelPickPath`), `control-cache.mts` (`cleanModelsCache`), `anyengine-config.mts` (`enginePaths`, `writeJsonAtomic`, `readConfig`, `DEFAULT_CONFIG`), `util.mts` (`codexHome`).
- Produces:

```ts
// src/control-launchd.mts
export const ROUTER_LABEL = 'dev.anyengine.router'
export const SMOKE_LABEL = 'dev.anyengine.smoke'
export function plistPath(home: string, label: string): string
export function routerPlist(input: { launcher: string; node: string; pathDirs: string[]; log: string }): string
export function smokePlist(input: { launcher: string; node: string; pathDirs: string[]; log: string; hour: number; minute: number; watchPaths: string[] }): string
export function loadJob(system: System, label: string, plist: string): ExecResult
export function reloadJob(system: System, label: string): ExecResult     // launchctl kickstart -k: the running job picks up the new lib
export function unloadJob(system: System, label: string): void
export function jobLoaded(system: System, label: string): boolean

// src/control-install.mts
export interface OnPlan { version: string; libDir: string; node: string; claudeCli: string | null; shimSource: string; launcherSource: string; stamp: string; app: string; bundleId: string }
export interface InstallPaths { codexHome: string; pickFile: string }      // defaults: codexHome(), appModelPickPath()
export interface OnResult { adopted: boolean; refused: string | null; wrote: string[]; unchanged: string[]; layers: LayerName[] }
export function persistRecord(root: string, system: System, plan: Pick<OnPlan, 'app' | 'bundleId'>, paths: InstallPaths, before: Layer[]): OnRecord
export function applyOnFiles(system: System, root: string, plan: OnPlan, options: { dryRun: boolean; paths?: InstallPaths }): OnResult
// dryRun needs no router layer (on the live Mac the line exists and no layer does yet)
export function applySharedConfig(system: System, root: string, plan: OnPlan, options: { dryRun: boolean; paths?: InstallPaths }): { wrote: string[]; removed: string[] }
export interface OffResult { popped: LayerName[]; kept: LayerName[]; results: Array<{ target: string; outcome: RestoreOutcome; detail: string }>; ok: boolean }
// The files only; popped layers stay in layers.json as pending until finishOff.
// routerOnly pops a layer only if it is named `router`.
export function applyOffFiles(system: System, root: string, options: { routerOnly: boolean; paths?: InstallPaths }): OffResult
export type SharedConfigOutcome = 'restored' | 'kept-newer' | 'nothing'
export function restoreSharedConfig(record: SharedConfigRecord): Array<{ key: string; outcome: SharedConfigOutcome; detail: string }>
export interface FinishResult { bootedOut: string[]; sharedConfig: Array<{ key: string; outcome: SharedConfigOutcome; detail: string }>; cacheRemoved: boolean }
// After the app's quit: the pending layers' jobs, shared config and cache; then they leave layers.json.
export function finishOff(system: System, root: string, paths?: InstallPaths): FinishResult
```

- [x] **Step 1: Write the failing tests**

Add to `test/helpers/m0-home.mts`:

```ts
export function fakeLib(home: string, version = '0.1.0-m1test'): OnPlan {
  const lib = join(home, '.anyengine', 'lib', version)
  mkdirSync(join(lib, 'scripts'), { recursive: true })
  writeFileSync(join(lib, 'scripts', 'codex-shim'), '#!/usr/bin/env bash\n# anyengine codex shim (marker: ANYENGINE_ADAPTER) m1\n')
  writeFileSync(join(lib, 'scripts', 'anyengine-launch'), '#!/usr/bin/env bash\nexit 0\n')
  return {
    version, libDir: lib, node: process.execPath, claudeCli: '/usr/local/bin/claude',
    shimSource: join(lib, 'scripts', 'codex-shim'), launcherSource: join(lib, 'scripts', 'anyengine-launch'),
    stamp: '20261001T000000Z', app: '/Applications/ChatGPT.app', bundleId: 'com.openai.codex',
  }
}

export function pathsFor(home: string): InstallPaths {
  return { codexHome: join(home, '.codex'), pickFile: join(home, '.codex', 'anyengine', 'app-model-pick.json') }
}
```

Create `test/control-install.test.mts` (the snapshot helper and `WATCHED` list as below; every `apply*` call passes `paths: pathsFor(home)`):

```ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { enginePaths } from '../src/anyengine-config.mjs'
import { applyOffFiles, applyOnFiles, applySharedConfig, finishOff } from '../src/control-install.mjs'
import { duplicateTopLevelKeys } from '../src/codex-config-toml.mjs'
import { readLayers, sha256Of } from '../src/control-layers.mjs'
import { findCodexCliBlock, RC_BEGIN } from '../src/control-rc.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { fakeLib, m0Home, pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

const snapshot = (home: string, paths: string[]) =>
  Object.fromEntries(
    paths.map((p) => {
      const full = join(home, p)
      const stat = lstatSync(full, { throwIfNoEntry: false })
      if (!stat) return [p, 'absent']
      if (stat.isSymbolicLink()) return [p, `-> ${readlinkSync(full)}`]
      return [p, `${sha256Of(full)} ${(stat.mode & 0o777).toString(8)}`]
    }),
  )
const WATCHED = [
  // anyengine-off and layers.json are AnyEngine's own record, checked separately.
  '.zshrc', 'bin/codex', '.anyengine/runtime.env', '.anyengine/lib/current', '.anyengine/bin/anyengine',
  'Library/LaunchAgents/dev.anyengine.router.plist',
  'Library/LaunchAgents/dev.anyengine.smoke.plist', '.codex/config.toml', '.codex/anyengine/app-model-pick.json',
]

test('on adopts the hand-flipped M0 state without writing the rc block or the backup again', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const rcBefore = readFileSync(join(home, '.zshrc'), 'utf8')
  const result = applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  assert.equal(result.adopted, true)
  assert.deepEqual(result.layers, ['adapter', 'router'])
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), rcBefore, 'rc untouched')
  assert.equal(readlinkSync(join(root, 'lib', 'current')), '0.1.0-m1test')
  assert.match(readFileSync(join(home, 'bin', 'codex'), 'utf8'), /m1/)
  assert.ok(system.jobs.has('dev.anyengine.router'))
  assert.ok(system.jobs.has('dev.anyengine.smoke'))
  assert.match(readLayers(root).layers[0]?.adoptedFrom ?? '', /rollback-20260930T114234Z$/)
  const again = applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  assert.deepEqual(again.wrote, [], 'a second on writes nothing')
  assert.equal(readLayers(root).layers.length, 2)
})

test('on refuses a half-on M0', async () => {
  const home = await m0Home()
  writeFileSync(join(home, 'bin', 'codex'), readFileSync(join(home, '.anyengine', 'rollback-20260930T114234Z', '01-codex.bak')))
  const result = applyOnFiles(fakeSystem(home), join(home, '.anyengine'), fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  assert.match(result.refused ?? '', /half on/)
  assert.deepEqual(result.wrote, [])
  assert.ok(!existsSync(enginePaths(join(home, '.anyengine')).layers))
})

test('off --router-only returns exactly to M0; off returns exactly to before M0', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const m0 = snapshot(home, WATCHED)
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  const routerOff = applyOffFiles(system, root, { routerOnly: true, paths: pathsFor(home) })
  assert.equal(routerOff.ok, true)
  assert.deepEqual(snapshot(home, WATCHED), m0)
  assert.ok(system.jobs.has('dev.anyengine.router'), 'the running app still needs the router until it has quit')
  assert.equal(readLayers(root).layers.find((l) => l.name === 'router')?.pending, 'after-quit')
  finishOff(system, root, pathsFor(home))
  assert.ok(!system.jobs.has('dev.anyengine.router'))
  assert.deepEqual(readLayers(root).layers.map((l) => l.name), ['adapter'])
  assert.deepEqual(applyOffFiles(system, root, { routerOnly: true, paths: pathsFor(home) }).popped, [], '--router-only pops only a layer named router')
  assert.deepEqual(readLayers(root).layers.map((l) => l.name), ['adapter'])
  assert.match(readFileSync(join(root, 'bin', 'anyengine-off'), 'utf8'), /rollback-20261001T000000Z-adapter/, 'the way back now names the adapter layer only')
  assert.doesNotMatch(readFileSync(join(root, 'bin', 'anyengine-off'), 'utf8'), /rollback-\d{8}T\d{6}Z-router/)
  const full = applyOffFiles(system, root, { routerOnly: false, paths: pathsFor(home) })
  assert.equal(full.ok, true)
  finishOff(system, root, pathsFor(home))
  const bk = join(root, 'rollback-20260930T114234Z')
  assert.equal(sha256Of(join(home, '.zshrc')), sha256Of(join(bk, '00-.zshrc.bak')))
  assert.equal(sha256Of(join(home, 'bin', 'codex')), sha256Of(join(bk, '01-codex.bak')))
  assert.equal(findCodexCliBlock(readFileSync(join(home, '.zshrc'), 'utf8')).state, 'commented')
  assert.ok(!existsSync(enginePaths(root).layers))
  assert.ok(!existsSync(join(root, 'bin', 'anyengine-off')))
})

test('on on a fresh Mac writes one marked rc block, and off removes it', async () => {
  const dir = await tempDir('anyengine-install-')
  const home = join(dir, 'home')
  mkdirSync(join(home, '.anyengine', 'lib'), { recursive: true })
  writeFileSync(join(home, '.zshrc'), 'export A=1\n')
  const system = fakeSystem(home)
  const before = snapshot(home, WATCHED)
  applyOnFiles(system, join(home, '.anyengine'), fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  const rc = readFileSync(join(home, '.zshrc'), 'utf8')
  assert.equal(rc.split(RC_BEGIN).length - 1, 1)
  assert.equal(findCodexCliBlock(rc).state, 'active')
  applyOffFiles(system, join(home, '.anyengine'), { routerOnly: false, paths: pathsFor(home) })
  finishOff(system, join(home, '.anyengine'), pathsFor(home))
  assert.deepEqual(snapshot(home, WATCHED), before)
})

test('on on a fresh Mac rewrites a stale ANYENGINE_ADAPTER in runtime.env as a tracked change, and off puts it back', async () => {
  const dir = await tempDir('anyengine-install-')
  const home = join(dir, 'home')
  mkdirSync(join(home, '.anyengine', 'lib'), { recursive: true })
  writeFileSync(join(home, '.zshrc'), 'export A=1\n')
  const stale = 'export ANYENGINE_RUNTIME_TYPE="anyengine"\nexport ANYENGINE_ADAPTER="$HOME/Projects/anyengine/dist/src/adapter.mjs"\n'
  writeFileSync(join(home, '.anyengine', 'runtime.env'), stale)
  const system = fakeSystem(home)
  applyOnFiles(system, join(home, '.anyengine'), fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  assert.match(readFileSync(join(home, '.anyengine', 'runtime.env'), 'utf8'), /^export ANYENGINE_ADAPTER="\$HOME\/\.anyengine\/lib\/current\/dist\/src\/adapter\.mjs"$/m)
  applyOffFiles(system, join(home, '.anyengine'), { routerOnly: false, paths: pathsFor(home) })
  finishOff(system, join(home, '.anyengine'), pathsFor(home))
  assert.equal(readFileSync(join(home, '.anyengine', 'runtime.env'), 'utf8'), stale)
})

test('off reverts only its own hunk when the rc changed since', async () => {
  const dir = await tempDir('anyengine-install-')
  const home = join(dir, 'home')
  mkdirSync(join(home, '.anyengine', 'lib'), { recursive: true })
  writeFileSync(join(home, '.zshrc'), 'export A=1\n')
  const system = fakeSystem(home)
  applyOnFiles(system, join(home, '.anyengine'), fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  writeFileSync(join(home, '.zshrc'), `${readFileSync(join(home, '.zshrc'), 'utf8')}alias ll='ls -l'\n`)
  const off = applyOffFiles(system, join(home, '.anyengine'), { routerOnly: false, paths: pathsFor(home) })
  finishOff(system, join(home, '.anyengine'), pathsFor(home))
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), "export A=1\nalias ll='ls -l'\n")
  assert.equal(off.results.find((r) => r.target.endsWith('.zshrc'))?.outcome, 'reverted-hunk')
})

test('a file changed beyond recognition is left alone and reported, and its layer stays recorded', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  writeFileSync(join(home, 'bin', 'codex'), '#!/bin/sh\necho mine\n')
  const off = applyOffFiles(system, root, { routerOnly: true, paths: pathsFor(home) })
  assert.equal(off.ok, false)
  assert.equal(off.results.find((r) => r.target.endsWith('bin/codex'))?.outcome, 'left-changed')
  assert.equal(readFileSync(join(home, 'bin', 'codex'), 'utf8'), '#!/bin/sh\necho mine\n')
  assert.equal(readlinkSync(join(root, 'lib', 'current')), '0.1.0-986ab707750e', 'the rest was still undone')
  assert.deepEqual(off.kept, ['router'])
  assert.deepEqual(readLayers(root).layers.map((l) => l.name), ['adapter', 'router'], 'layers.json keeps what is not undone')
})

test('write-ahead: an on killed in the middle is undone by anyengine-off alone', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const m0 = snapshot(home, WATCHED)
  const launchctl = system.launchctl
  system.launchctl = (args) => {
    if (args[0] === 'bootstrap') throw new Error('killed at the first job load')
    return launchctl(args)
  }
  assert.throws(() => applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) }), /killed/)
  assert.ok(existsSync(join(root, 'bin', 'anyengine-off')))
  assert.ok(readLayers(root).layers.some((l) => l.name === 'router'))
  const off = spawnSync('/bin/bash', [join(root, 'bin', 'anyengine-off'), '--router-only', '--no-restart'], {
    encoding: 'utf8',
    env: { HOME: home, PATH: '/usr/bin:/bin', ANYENGINE_LAUNCHCTL: '/usr/bin/true', ANYENGINE_PGREP: '/usr/bin/false' },
  })
  assert.equal(off.status, 0, off.stdout + off.stderr)
  assert.deepEqual(snapshot(home, WATCHED), m0)
})

test('the shared config: only the top-level non-GPT model line goes, the pick moves, and off puts both back', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  const toml = ['model = "sonnet"', 'model_reasoning_effort = "medium"', '', '[profiles.work]', 'model = "opus"', ''].join('\n')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'config.toml'), toml, { mode: 0o600 })
  const m0 = snapshot(home, WATCHED)
  const early = applySharedConfig(system, root, fakeLib(home), { dryRun: true, paths: pathsFor(home) })
  assert.deepEqual(early.removed, ['model = "sonnet"'], 'a dry run needs no router layer')
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  const dry = applySharedConfig(system, root, fakeLib(home), { dryRun: true, paths: pathsFor(home) })
  assert.deepEqual(dry.removed, ['model = "sonnet"'])
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), toml, 'a dry run writes nothing')
  applySharedConfig(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), toml.replace('model = "sonnet"\n', ''))
  assert.deepEqual(JSON.parse(readFileSync(pathsFor(home).pickFile, 'utf8')), { model: 'sonnet' })
  assert.equal(lstatSync(join(home, '.codex', 'config.toml')).mode & 0o777, 0o600)
  assert.deepEqual(applySharedConfig(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) }).wrote, [], 'idempotent')
  applyOffFiles(system, root, { routerOnly: true, paths: pathsFor(home) })
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), toml.replace('model = "sonnet"\n', ''), 'the line waits for the quit')
  finishOff(system, root, pathsFor(home))
  assert.deepEqual(snapshot(home, WATCHED), m0)
})

test('off keeps a GPT pick made while M1 was on, puts back a changed Claude pick, never duplicates a key, never reports left-changed', async () => {
  const cases = [
    { name: 'a GPT pick while on', now: 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n', pick: null, outcome: 'kept-newer', after: 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n' },
    { name: 'a changed Claude pick', now: 'model_reasoning_effort = "high"\n', pick: { model: 'opus' }, outcome: 'restored', after: 'model = "opus"\nmodel_reasoning_effort = "high"\n' },
  ]
  for (const c of cases) {
    const home = await m0Home()
    const root = join(home, '.anyengine')
    const system = fakeSystem(home)
    applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
    applySharedConfig(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
    // What the app and codex did while M1 was on (Task 5: a GPT pick clears the adapter's pick).
    writeFileSync(join(home, '.codex', 'config.toml'), c.now)
    if (c.pick) writeFileSync(pathsFor(home).pickFile, JSON.stringify(c.pick))
    else rmSync(pathsFor(home).pickFile, { force: true })
    const off = applyOffFiles(system, root, { routerOnly: true, paths: pathsFor(home) })
    assert.equal(off.ok, true, c.name)
    const done = finishOff(system, root, pathsFor(home))
    assert.deepEqual(done.sharedConfig.map((r) => r.outcome), [c.outcome], c.name)
    const text = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    assert.equal(text, c.after, c.name)
    assert.deepEqual(duplicateTopLevelKeys(text), [], c.name)
    assert.ok(!existsSync(pathsFor(home).pickFile), c.name)
  }
})

test('the router job is reloaded when the lib changes under it', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  system.calls.length = 0
  applyOnFiles(system, root, fakeLib(home, '0.1.0-m1next'), { dryRun: false, paths: pathsFor(home) })
  assert.ok(system.calls.some((c) => /^launchctl kickstart -k gui\/\d+\/dev\.anyengine\.router$/.test(c)))
  assert.equal(readLayers(root).layers.find((l) => l.name === 'router')?.changes.find((c) => c.target.endsWith('lib/current'))?.beforeLink, '0.1.0-986ab707750e', 'the rollback target stays M0')
})

test('the models cache is cleaned into the popped router layer', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  const routerDir = readLayers(root).layers.find((l) => l.name === 'router')?.rollbackDir ?? ''
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'models_cache.json'), JSON.stringify({ models: [{ slug: 'opus', description: 'Claude Opus, via AnyEngine' }] }))
  applyOffFiles(system, root, { routerOnly: true, paths: pathsFor(home) })
  assert.ok(existsSync(join(home, '.codex', 'models_cache.json')), 'not before the quit')
  assert.equal(finishOff(system, root, pathsFor(home)).cacheRemoved, true)
  assert.ok(!existsSync(join(home, '.codex', 'models_cache.json')))
  assert.ok(existsSync(join(routerDir, 'models_cache.json')))
})
```

In `test/install-lib.test.mts`, add:
- `--no-activate stages a verified version and leaves current alone`: install A (current → A), then B with `--no-activate`: `current` still A, B verifies, the output says `staged`.
- `--no-activate prunes to --keep 2 and keeps what a layer can roll back to`: install A, B, C in turn (current → C), write `<root>/state/layers.json` naming `lib/current` with `beforeLink: A`, then stage D with `--no-activate`: A (in a layer), C (current) and D (staged) remain, B is gone.
- `--activate moves current to a staged version and keeps the previous one`.

- [x] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/control-install.mjs'`.

- [x] **Step 3: Write the launchd jobs**

Create `src/control-launchd.mts`. `routerPlist` produces a LaunchAgent with `Label` `dev.anyengine.router`, `ProgramArguments` `["/bin/bash", <launcher>, "router"]`, `RunAtLoad` true, `KeepAlive` true, `ThrottleInterval` 5, `EnvironmentVariables` `{ ANYENGINE_NODE: <node>, PATH: <pathDirs joined>:/usr/bin:/bin:/usr/sbin:/sbin, ANYENGINE_LAUNCHD_LOG: <log> }`, `StandardOutPath` and `StandardErrorPath` `<log>` (`~/.anyengine/logs/router.launchd.log`; the launcher trims it at start and the router every 10 minutes, Task 8). `smokePlist` has the same shape with label `dev.anyengine.smoke`, `ProgramArguments` `["/bin/bash", <launcher>, "smoke", "--scheduled", "--notify"]`, no `KeepAlive`, `StartCalendarInterval` `{ Hour, Minute }`, `WatchPaths` `[<app>/Contents/Info.plist, ~/Library/Caches/<bundleId>/org.sparkle-project.Sparkle]`, `ProcessType` `Background` and its own log. XML is written by a small helper that escapes `&`, `<` and `>`. `loadJob` runs `launchctl bootout gui/<uid>/<label>` (ignoring "not loaded"), then `launchctl bootstrap gui/<uid> <plist>`; `reloadJob` runs `launchctl kickstart -k gui/<uid>/<label>`; `jobLoaded` is `launchctl print gui/<uid>/<label>` exiting 0; the uid is `process.getuid()`.

- [x] **Step 4: Write the file half of on and off**

Create `src/control-install.mts`, starting with this comment and implementing it:

```ts
// The file half of `anyengine on` and `off` (decision D4). `on`:
//  1. no layers yet: adopt a hand-flipped M0 as the adapter layer (refused
//     when M0 is half on), or, on a fresh Mac, write it (the rc block,
//     ~/bin/codex, runtime.env if absent);
//  2. the router layer: lib/current -> the version being turned on, the new
//     shim if it differs, ~/.anyengine/bin/anyengine (the launcher), the
//     router and smoke LaunchAgents (loaded; the router reloaded when only the
//     lib changed under it).
// Write-ahead (decision D17): before each change, the layers so far, each
// layer's ROLLBACK.sh and ~/.anyengine/bin/anyengine-off are rewritten to
// name it (persistRecord), so a flip killed anywhere is undone by
// anyengine-off alone. Those three are AnyEngine's own record, not changes.
// config.json is created with defaults if absent and never restored: it is a
// preference, inert while AnyEngine is off.
// applySharedConfig runs between the app's quit and its reopen (Task 26):
// the one ~/.codex line (decision D15), recorded before it is removed.
// `off` is two halves around the app's quit: applyOffFiles puts the files of
// the router layer (and the adapter layer unless --router-only; --router-only
// pops only a layer named `router`) back, newest first, and marks those
// layers pending; a layer with a change it could not restore stays recorded.
// finishOff, after the quit, boots out the pending layers' jobs, restores the
// shared config line by its own rule, cleans the models cache, and drops the
// layers from layers.json.
```

Rules:

- `persistRecord(root, system, plan, paths, before)` returns an `OnRecord` that, given the layer being written, writes `layers.json` as `[...before, layer]`, the layer's `ROLLBACK.sh` (`rollbackScript(layer, { codexHome: paths.codexHome })`, mode 755) and `bin/anyengine-off` (`offScript([...before, layer], { root, app: plan.app, bundleId: plan.bundleId, codexHome: paths.codexHome })`, mode 755). The adopted adapter layer is persisted the same way as soon as it is adopted.
- The router layer's `lib/current` change is `writeSymlink(join(root, 'lib', 'current'), plan.version)`; when the layer already exists its recorded before-link is kept, so an upgrade on top of M1 still rolls back to the M0 version.
- `bin/anyengine` is a copy of `plan.launcherSource` (mode 755).
- `config.json`: when absent, written with `DEFAULT_CONFIG` plus `claude.cli = plan.claudeCli`; when present and `claude.cli` is null, that one key is set; never tracked.
- The LaunchAgent plists are tracked files; their jobs are recorded with `addJob` (persisted) before `loadJob`, which runs only when the plist changed or the job is not loaded. When neither plist changed but `lib/current` did and the router job is loaded, `reloadJob(system, ROUTER_LABEL)` makes the running router pick up the new lib. `pathDirs` are the directories of `plan.node` and `plan.claudeCli`.
- A fresh Mac (no layer, `adoptM0` null): the adapter layer writes `rcPath(system.home, process.env.SHELL)` through `withRcBlock` (refuse with a message when `rcPath` is null), `~/bin/codex` from `plan.shimSource` (mode 755), and `~/.anyengine/runtime.env`: when absent, `export ANYENGINE_RUNTIME_TYPE="anyengine"` and `export ANYENGINE_NODE="<plan.node>"`; when present with an `export ANYENGINE_ADAPTER=` line naming anything but `$HOME/.anyengine/lib/current/dist/src/adapter.mjs` (a checkout, an old copy: the shim would run that instead of the lib), that one line is rewritten to name the lib, as a tracked change `off` puts back; nothing else in the file changes. `adoptM0` returning `refused` returns it in `OnResult.refused`, with nothing written.
- `applySharedConfig`: reads `<codexHome>/config.toml` (absent: nothing to do); takes `nonGptModelLines(text).filter((l) => l.table === null)`; when there are none, returns `{ wrote: [], removed: [] }`. `dryRun` returns what it would remove and write and writes nothing; it needs no router layer. Otherwise (it throws when there is no router layer yet): check that `withoutLines(text, lines)` has exactly `lines.length` fewer lines and every other line identical, in order, and no duplicate top-level key (else refuse, writing nothing); copy the file to `<rollbackDir>/config.toml.bak`; set the router layer's `sharedConfig` record (`target`, `pickFile`, `backup: 'config.toml.bak'`, and each removed line's `key`, `value`, `index`, `text`) and persist it with `persistRecord`; then write the pick file, `paths.pickFile`, with each removed key and value it does not already hold (mode 600), and then `config.toml` with `withoutLines(text, lines)` in its own mode. Neither file is a `FileChange`: the generic restore never touches them.
- `dryRun` in `applyOnFiles` records nothing and writes nothing, and returns in `wrote` what it would write.
- `applyOffFiles` pops the newest layer when it is named `router` (with `routerOnly`, only that; a newest layer of another name is left and reported), then, unless `routerOnly`, the adapter layer. For each popped layer it restores the files only: its rc change first when it has one (`isRcChange`), and when that one is `left-changed` it keeps the rest of that layer as it is (as the bash script does); then the other changes newest first with `restoreChange(change, layer.rollbackDir, true)`. It boots out no job and touches neither the shared config nor the cache: the running app still depends on them. A layer whose files all came back is marked `pending: 'after-quit'` in `layers.json`; a layer with any `left-changed` change is kept as it was. `ok` is false when any change was `left-changed`.
- `restoreSharedConfig(record)`: for each removed line, in order: when `topLevelKeys(current)` already has that key, keep the file (`kept-newer`, the detail names the current line: it was set while AnyEngine was on); otherwise insert `key = "<value>"`, where the value is the pick file's current value for that key when it has one and the recorded value otherwise (the recorded `text` when the value is unchanged), with `insertTopLevelLine(current, index, line)` (`restored`). The result must have no duplicate top-level key (`duplicateTopLevelKeys`); if it would, nothing is written and the line is reported as `kept-newer`. A missing file counts as empty. The write keeps the file's mode and goes through a temp file and a rename. Then the pick file is removed. Never `left-changed`.
- `finishOff(system, root, paths)`: for each pending layer, newest first: boot out its jobs through `system.launchctl`, run `restoreSharedConfig` when it has a record, and, when `cleansCache`, `cleanModelsCache(paths.codexHome, ids, layer.rollbackDir)` (a copy goes into that layer's directory); then drop it from `layers.json`. `anyengine-off` is regenerated for the layers that remain; when none remain, `layers.json` and `anyengine-off` are removed. Task 26 calls it after the quit and before the reopen; with `--no-restart`, right after `applyOffFiles`. `on` refuses while any layer is pending (`finish the last off first: anyengine off`).

- [x] **Step 5: Stage and activate in install-lib**

In `scripts/install-lib.mjs`, add two options:

- `--no-activate`: install and verify `<dest-root>/<version>` exactly as now, then prune (below) with the staged version protected, print `install-lib: staged <target> (current unchanged)` and exit, without `pointCurrent` or removing `shim-fallback.json`.
- `--activate VERSION`: verify `<dest-root>/VERSION` (fail when missing or not verifying), `pointCurrent`, `prune`, remove `shim-fallback.json`, print `install-lib: current -> <target>`; no build, no `npm ci`.

`prune()` also keeps every version named in `<dest-root>/../state/layers.json` (the `beforeLink` and `afterLink` of any change whose target ends in `/lib/current`; a missing or unreadable file names none) and, with `--no-activate`, the staged one; `--keep 2` otherwise works as today (current plus the newest other). A version kept only because a layer names it is printed (`kept <version>: a layer rolls back to it`).

Before this task, `install-lib` does not know `--no-activate`: it ignores the flag and activates. No earlier task may run it on the live machine; the preamble's constraint says so.

- [x] **Step 6: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/control-install.test.mjs dist/test/control-scripts.test.mjs dist/test/control-layers.test.mjs dist/test/install-lib.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [x] **Step 7: Docs, gates, commit**

In `docs/guide/control.md`, add "What `on` changes": the two layers, where each rollback directory is, the four restore outcomes, the write-ahead record, and the one `~/.codex/config.toml` line (why, and that `off` puts it back). In `docs/guide/deployment.md`, add at the top of the flip section: "`anyengine on` does this now; `scripts/flip-backup.mjs` remains for M0's record." Add the new install-lib flags and the pruning rule to `scripts/AGENTS.md`, and the two modules to `src/AGENTS.md`.

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/control-launchd.mts src/control-install.mts test/control-install.test.mts test/helpers/m0-home.mts \
  scripts/install-lib.mjs test/install-lib.test.mts docs/guide/control.md docs/guide/deployment.md \
  scripts/AGENTS.md src/AGENTS.md
git commit -m "feat: write on and off as layers, with launchd jobs, the shared config line and staged installs"
```

**Acceptance:** with the synthetic M0 layout, `on` adopts M0 without touching the rc or writing a second backup, and refuses a half-on M0 (the shim from before M0 is told apart by its hash); `off --router-only` restores the M0 state byte for byte and `off` the pre-M0 state, with the jobs, the shared config line and the cache left until `finishOff`; `--router-only` pops only a layer named `router`; after a GPT pick made while M1 was on, `off` keeps the GPT line and never duplicates a key, and after a changed Claude pick it puts back the newer pick, neither ever `left-changed`; a stale `ANYENGINE_ADAPTER` on a fresh Mac is rewritten and put back; a second `on` writes nothing; an rc edited since is reverted line by line; a layer that could not be undone stays recorded; an `on` killed in the middle is undone by `anyengine-off` alone; only the top-level non-GPT `model` line leaves `config.toml`, the pick moves to the pick file, and `off` puts both back byte for byte; the router reloads when the lib changes; `--no-activate` stages without activating and pruning keeps every version a layer can roll back to.

---

Accepted source `9bdf0f2` after independent review and two bounded corrections. The enabled-to-disabled smoke transition unloads its owned job and journals removal of its plist; last-good recovery restores prior job activity and propagates failed stops. Final affected tests 96/96; full suite 1246/1246 with 89.26% line coverage; static, type, Bash and repository ratchets pass. Installed/native acceptance remains downstream. Failed and interrupted verification evidence is retained privately.

---

### Task 25: Post-relaunch checks and a real proof of the rollback

Two pieces the flip engine (Task 26) runs around every app restart. The **postflight** is M0's post-relaunch evidence as code: the app version, the handshake, the adapter process, the GPT child, the router link, foreign codex processes, the router's health, the claim socket, doctor and (when wired) the smoke; on the way back (a rollback, or `off`) a changed app version is expected, because a staged update installs with that restart, and is re-verified instead of failed (M2). The **proof** replaces a copy-only dry run with the real thing (H2): it copies every target `on` would touch into a scratch directory on the T7 volume, replays `on` there, runs the generated `anyengine-off` (bash, no Node) and the Node `off`, and compares the copy with the original byte for byte, mode for mode and link for link. Nothing outside the scratch directory changes.

**Files:**
- Create: `src/control-postflight.mts`, `src/control-proof.mts`
- Create: `test/helpers/flip-deps.mts`, `test/control-postflight.test.mts`
- Modify: `docs/guide/control.md`, `src/AGENTS.md`

**Interfaces:**
- Consumes: Task 19 (`System`, `adapterProcesses`, `tailJsonl`, `lastEvent`, `inspectModelsCache`), Task 21 (`runDoctor`), Task 22 (`readLayers`, `sha256Of`), Task 24 (`applyOnFiles`, `applySharedConfig`, `applyOffFiles`, `finishOff`, `OnPlan`, `InstallPaths`), `anyengine-config.mts` (`routerHealthUrl`, `loadConfig`, `enginePaths`), `bundled-codex.mts` (`resolveBundledCodex`), `claim-protocol.mts` (`claimSocketPath`, `writeLine`, `onLines`), `util.mts` (`adapterHome`).
- Produces:

```ts
// src/control-postflight.mts
export interface CheckResult { name: string; ok: boolean; detail: string }
export type Expect = 'router' | 'adapter' | 'vanilla'
export interface CodexProcess { kind: 'app' | 'ssh-remote' | 'other'; path: string; command: string }
export function classifyCodexProcesses(procs: Array<{ command: string }>, app: string): CodexProcess[]
export interface FlipDeps {
  preflip(quietSeconds: number): { quiet: boolean; staged: boolean; text: string }
  verifyLib(libDir: string): string[]
  doctor(): Promise<{ ok: boolean; text: string }>
  smoke: ((paths: string[]) => Promise<{ ok: boolean; text: string }>) | null   // Task 27 fills it
  routerHealth(timeoutMs: number): Promise<Record<string, unknown> | null>
  claimPing(pid: number): Promise<boolean>
  bundledCodex(): string | null
  appLog(since: Date): string[]
  debugEvents(since: Date): Array<Record<string, unknown>>
}
export function realFlipDeps(system: System, root: string, libDir: string): FlipDeps
export interface PostflightInput {
  expect: Expect
  since: Date
  appVersionBefore: string
  versionChangeExpected: boolean   // on the way back: a changed version passes and is re-verified (M2)
  libVersion: string | null        // the version adapters must run from ('router'/'adapter')
  routerUrl: string | null         // 'router': the URL the child must be pointed at
  baselineOther: string[]          // codex executables of kind 'other' before the restart
}
export function postflight(system: System, deps: FlipDeps, input: PostflightInput): Promise<CheckResult[]>

// src/control-proof.mts
export interface ProofResult { ok: boolean; lines: string[] }
export function proveRollback(
  system: System,
  root: string,
  plan: OnPlan,
  options: { paths: InstallPaths; scratchParent: string; afterOn?: (scratchHome: string) => void },
): ProofResult
```

- [x] **Step 1: Move the scripted Mac into a helper**

Create `test/helpers/flip-deps.mts` exporting `scripted(system, options)`: a `FlipDeps` whose every relaunch produces the evidence of whatever is on at that moment (the code below), used by this task's tests and by Task 26's.

```ts
import { readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { readLayers } from '../../src/control-layers.mjs'
import type { FlipDeps } from '../../src/control-postflight.mjs'
import type { FakeSystem } from './fake-system.mjs'

export const BUNDLED = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
export const ROUTER = 'http://127.0.0.1:18790/backend-api/codex'

// A Mac whose every relaunch produces the evidence of whatever is on at that
// moment: with layers, the handshake through ~/bin/codex, the adapter from the
// lib `current` names, its GPT child from the bundled codex (pointed at the
// router only while the router layer is on) and the router link; with no
// layer, the app's own codex and no adapter. The router answers only while
// its job is loaded.
export function scripted(system: FakeSystem, options: { attached?: boolean; versionOnOpen?: Record<number, string> } = {}) {
  const events: Array<Record<string, unknown>> = []
  const log: string[] = []
  let opens = 0
  const deps: FlipDeps = {
    preflip: () => ({ quiet: true, staged: false, text: 'preflip-check: quiet' }),
    verifyLib: () => [],
    doctor: async () => ({ ok: true, text: 'all ok' }),
    smoke: null,
    routerHealth: async () =>
      system.jobs.has('dev.anyengine.router') ? { ok: true, pid: 4242, fanout: { path: 'native', reason: 'catalog marked v1' } } : null,
    claimPing: async () => true,
    bundledCodex: () => BUNDLED,
    appLog: () => log,
    debugEvents: () => events,
  }
  const previous = system.onOpen
  system.onOpen = () => {
    previous?.()
    opens += 1
    const root = join(system.home, '.anyengine')
    const layers = readLayers(root).layers.map((l) => l.name)
    const ts = system.now().toISOString()
    if (layers.length === 0) {
      system.procs = []
      log.push(`${ts} info [StdioConnection] stdio_transport_spawned executablePath=${BUNDLED} pid=900`)
    } else {
      const lib = readlinkSync(join(root, 'lib', 'current'))
      const router = layers.includes('router')
      const pid = 12829 + opens
      system.procs = [{ pid, ppid: 1, command: `node ${root}/lib/${lib}/dist/src/adapter.mjs app-server --analytics-default-enabled` }]
      log.push(`${ts} info [StdioConnection] stdio_transport_spawned executablePath=~/bin/codex pid=${pid}`)
      events.push({ ts, pid, event: 'codex.upstream.spawn', binary: BUNDLED, args: ['app-server', ...(router ? ['-c', `openai_base_url="${ROUTER}"`] : [])] })
      if (router) events.push({ ts, pid, event: 'router.link', attached: options.attached ?? true, fanout: 'native' })
    }
    log.push(`${ts} info [AppServerConnection] initialize_handshake_result outcome=success transportKind=stdio`)
    const version = options.versionOnOpen?.[opens]
    if (version) system.version = version
  }
  return { deps, events, log }
}
```

- [x] **Step 2: Write the failing tests**

Create `test/control-postflight.test.mts`:

```ts
import assert from 'node:assert/strict'
import { lstatSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { applyOnFiles } from '../src/control-install.mjs'
import { sha256Of } from '../src/control-layers.mjs'
import { classifyCodexProcesses, postflight } from '../src/control-postflight.mjs'
import { proveRollback } from '../src/control-proof.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { ROUTER, scripted } from './helpers/flip-deps.mjs'
import { fakeLib, m0Home, pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

test('postflight: codex processes are classified as the M0 flip did', () => {
  const app = '/Applications/ChatGPT.app'
  const kinds = classifyCodexProcesses(
    [
      { command: `${app}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server` },
      { command: '/opt/node-v24/bin/node /opt/node-v24/bin/codex app-server proxy' },
      { command: '/opt/other/codex exec --json' },
      { command: 'node /x/dist/src/adapter.mjs app-server' },
    ],
    app,
  ).map((p) => p.kind)
  assert.deepEqual(kinds, ['app', 'ssh-remote', 'other'])
})

test('postflight: a changed app version fails a forward flip and passes, re-verified, on the way back', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  applyOnFiles(system, root, fakeLib(home), { dryRun: false, paths: pathsFor(home) })
  const { deps } = scripted(system, { versionOnOpen: { 1: '26.935.1' } })
  const since = system.now()
  system.quitApp()
  system.openApp()
  const input = { expect: 'router' as const, since, appVersionBefore: '26.928.20755', libVersion: '0.1.0-m1test', routerUrl: ROUTER, baselineOther: [] }
  const forward = await postflight(system, deps, { ...input, versionChangeExpected: false })
  assert.equal(forward.find((c) => c.name === 'app version')?.ok, false)
  assert.match(forward.find((c) => c.name === 'app version')?.detail ?? '', /came back as 26\.935\.1/)
  const back = await postflight(system, deps, { ...input, versionChangeExpected: true })
  assert.equal(back.find((c) => c.name === 'app version')?.ok, true)
  assert.match(back.find((c) => c.name === 'app version')?.detail ?? '', /expected on the way back/)
  assert.ok(back.every((c) => c.ok), JSON.stringify(back.filter((c) => !c.ok)))
})

test('postflight: every check is reported, in order, for each expectation', async () => {
  const home = await m0Home()
  const system = fakeSystem(home)
  const { deps } = scripted(system)
  const since = system.now()
  system.openApp()
  const names = (await postflight(system, deps, { expect: 'adapter', since, appVersionBefore: '26.928.20755', versionChangeExpected: false, libVersion: '0.1.0-986ab707750e', routerUrl: null, baselineOther: [] })).map((c) => c.name)
  assert.deepEqual(names, ['app version', 'handshake', 'adapter process', 'GPT child', 'router attached', 'foreign codex', 'router health', 'claim socket', 'doctor', 'smoke'])
})

test('proof: on, then anyengine-off or off, leaves a scratch copy byte for byte, and the real home untouched', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const scratchParent = await tempDir('anyengine-proof-')
  const watched = ['.zshrc', 'bin/codex', '.anyengine/runtime.env', '.anyengine/lib/current']
  const before = watched.map((p) => [p, lstatSync(join(home, p)).isSymbolicLink() ? readlinkSync(join(home, p)) : sha256Of(join(home, p))])
  // The fixture has the live config.toml line, so each pass removes it and puts it back.
  const proof = proveRollback(fakeSystem(home), root, fakeLib(home), { paths: pathsFor(home), scratchParent })
  assert.equal(proof.ok, true, proof.lines.join('\n'))
  assert.match(proof.lines.join('\n'), /config\.toml/, 'the shared config line is among the targets')
  assert.match(proof.lines.join('\n'), /bash anyengine-off: ok/)
  assert.match(proof.lines.join('\n'), /node off: ok/)
  assert.match(proof.lines.join('\n'), /bash anyengine-off --router-only: ok/)
  const after = watched.map((p) => [p, lstatSync(join(home, p)).isSymbolicLink() ? readlinkSync(join(home, p)) : sha256Of(join(home, p))])
  assert.deepEqual(after, before)
  assert.deepEqual(readdirSync(scratchParent), [], 'the scratch copy is removed')
})

test('proof: a file the rollback does not bring back fails the proof and is named', async () => {
  const home = await m0Home()
  const scratchParent = await tempDir('anyengine-proof-')
  const proof = proveRollback(fakeSystem(home), join(home, '.anyengine'), fakeLib(home), {
    paths: pathsFor(home),
    scratchParent,
    afterOn: (scratchHome) => {
      // stands in for a rollback that misses a file: the copy differs after it
      writeFileSync(join(scratchHome, 'bin', 'codex'), '#!/bin/sh\necho changed\n')
    },
  })
  assert.equal(proof.ok, false)
  assert.match(proof.lines.join('\n'), /bin\/codex/)
})
```

- [x] **Step 3: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/control-postflight.mjs'`.

- [x] **Step 4: Write the postflight checks**

Create `src/control-postflight.mts`. `postflight` returns these checks (all of them, in this order, each `ok` with a detail naming what it saw):

| Check | ok when |
|---|---|
| `app version` | `system.appVersion()` equals `appVersionBefore`. When it differs: fails with `the app came back as <version>` (a quit installs a staged update), unless `versionChangeExpected`, when it passes with `came back as <version>, expected on the way back; re-verified by the checks below` |
| `handshake` | an app log line after `since` has `initialize_handshake_result` with `outcome=success`, and for `router`/`adapter` a `stdio_transport_spawned` line names `executablePath=~/bin/codex`; for `vanilla` it names the bundled codex as `deps.bundledCodex()` resolves it now |
| `adapter process` | `router`/`adapter`: at least one adapter process runs from `.anyengine/lib/<libVersion>/`, none from another version started after `since`, and `~/.anyengine/shim-fallback.json` is absent; `vanilla`: no adapter process |
| `GPT child` | `router`/`adapter`: every `codex.upstream.(spawn|spawnError|unavailable|staleRealCodex|missing)` event after `since` is a `spawn` whose `binary` is `deps.bundledCodex()` resolved after the relaunch (so a moved codex after an update is followed, not failed), and there is at least one |
| `router attached` | `router`: the last `router.link` event after `since` has `attached: true`, and the spawn's `args` contain `openai_base_url="<routerUrl>"`; `adapter`/`vanilla`: no spawn carries `openai_base_url` |
| `foreign codex` | no `other` codex executable from `classifyCodexProcesses` is missing from `baselineOther`, and no `shim.nonBundledCodex` event after `since` |
| `router health` | `router`: `deps.routerHealth(2000)` answers `ok: true` with a `fanout.path`; `adapter`/`vanilla`: it does not answer (the job is gone) |
| `claim socket` | `router`: `deps.claimPing(pid)` is true for every adapter pid; otherwise skipped |
| `doctor` | `router`/`adapter`: `deps.doctor()` is ok; `vanilla`: skipped (nothing of AnyEngine is left to check) |
| `smoke` | `router`, when `deps.smoke` is set: `deps.smoke(['gpt', 'claude-agent', 'bridge'])` is ok (Task 27); otherwise skipped with detail `not wired` |

`classifyCodexProcesses` ports M0's awk classifier: the path is the first token when its basename is `codex`, else the second when the first is `node` and the second's basename is `codex` (otherwise the process is skipped); `app` when the path starts with `<app>/`; `ssh-remote` when the path contains `/.nvm/versions/node/` and the command ends with ` app-server proxy` or ` app-server --listen unix://`; else `other`.

Handshake and GPT-child evidence can lag the relaunch by a few seconds: `postflight` polls those two checks every 2 s for up to 60 s before failing them (`system.sleep`, so the tests do not wait).

`realFlipDeps(system, root, libDir)` runs `node <libDir>/scripts/preflip-check.mjs --quiet-seconds N` (quiet: exit 0; staged: its stderr contains `an app update is staged`), `node <libDir>/scripts/lib-verify.mjs <libDir>`, `runDoctor` plus `node <libDir>/scripts/doctor.mjs` (with `ANYENGINE_ADAPTER=<libDir>/dist/src/adapter.mjs`), `GET routerHealthUrl(loadConfig(root))`, a `ping` on `claimSocketPath(enginePaths(root).run, pid)`, `resolveBundledCodex()` (fresh on every call), the lines of the newest two `~/Library/Logs/com.openai.codex/YYYY/MM/DD/*.log` files with a timestamp at or after `since`, and `tailJsonl(join(adapterHome(), 'debug.jsonl'))` filtered by `ts >= since`.

- [x] **Step 5: Write the proof**

Create `src/control-proof.mts`:

```ts
// The rollback, proven on a copy before the live switch-on (H2). Every target
// `on` would touch (applyOnFiles and applySharedConfig in dry-run, plus the
// adapter layer's targets and the M0 rollback directory adoption reads) is
// copied into a scratch home under `scratchParent` (the T7 volume: the caller
// runs with TMPDIR there), keeping modes and symlinks; lib/ becomes empty
// version directories and the `current` link; manifests and any layers.json
// are rewritten to name the scratch home. Then, three times on a fresh copy:
// `on` (files, then the shared config), and one of: the generated
// anyengine-off --no-restart (bash, PATH=/usr/bin:/bin, launchctl/osascript/
// open/pgrep replaced by /usr/bin/true or /usr/bin/false), the Node `off`
// (applyOffFiles, then finishOff), or anyengine-off --router-only --no-restart.
// What each pass is compared with (MUST 4): after a full off, the three M0
// targets (the rc, ~/bin/codex, runtime.env) must equal the M0 manifest's
// backups, the state before M0, and everything else the state as found; after
// a router-only off, everything must equal the state as found, which is M0.
// Same bytes, same mode, same link targets, nothing added among the targets.
// The real home is only read; the scratch directory is removed.
```

Implementation notes:
- A proof `System` wraps the real one: `home` is the scratch home, `launchctl` records and returns status 0, `processes()` returns `[]`, `quitApp`/`openApp` throw (the proof never restarts anything).
- The comparison walks the list of copied targets plus every path `applyOnFiles` and `applySharedConfig` reported in `wrote` (the shared `config.toml` and the pick file included), and reports each difference as one line (`bin/codex: sha 1a2b... != 3c4d...`, `Library/LaunchAgents/dev.anyengine.router.plist: added`).
- `afterOn` (tests only) runs after `on` in each pass, to simulate a rollback that misses a file.
- With no M0 to adopt (a fresh Mac), there is no manifest: a full off is compared with the state as found for every target.
- Lines: `proof: N targets copied to <scratch>`, then `proof bash anyengine-off: ok` / `FAILED: <diffs>`, `proof node off: ...` (both against the M0 backups for the three M0 targets and the as-found state for the rest), `proof bash anyengine-off --router-only: ...` (against the as-found state, which is M0), and `proof: scratch removed`.

- [x] **Step 6: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/control-postflight.test.mjs`
Expected: PASS, `ℹ pass 5`, `ℹ fail 0`.

- [x] **Step 7: Docs, gates, commit**

In `docs/guide/control.md`, document the postflight checks (the table) and the proof (what is copied, the three passes, where the scratch copy lives).

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/control-postflight.mts src/control-proof.mts test/helpers/flip-deps.mts test/control-postflight.test.mts \
  docs/guide/control.md src/AGENTS.md
git commit -m "feat: add the post-relaunch checks and a proof of the rollback on a scratch copy"
```

**Acceptance:** the proof compares a full off with the M0 backups for the three M0 targets and with the as-found state for the rest, and a router-only off with the as-found (M0) state, the shared `config.toml` included; the postflight reports every check in order; a changed app version fails a forward flip and passes, re-verified against the re-resolved bundled codex, on the way back; the proof replays `on` on a scratch copy and shows that `anyengine-off`, `anyengine-off --router-only` and the Node `off` each bring every target back byte for byte, names any file that does not come back, and leaves the real home untouched.

---
### Task 26: `anyengine on`, `off` and `restart`: a detached flip that survives its caller, resumes, and rolls back

This task encodes the live flip M0 did by hand (M0 plan Task 14, `docs/evidence/m0-flip.md`) as commands, around Task 24's files and Task 25's checks, and makes it safe to run from an agent session (decision D17, the review's C2):

- **Detached.** `on`, `off` and `restart` run in a runner process of their own (`adapter.mjs flip-run`), started in a new session with SIGHUP ignored and its output in a progress log, `~/.anyengine/state/flip-<id>.log`. The command that starts it follows the log and returns the runner's exit code; if the caller dies, the runner carries on, and the log and `anyengine status` show where it is.
- **Refuses to run inside the app it restarts.** If any ancestor of the command is ChatGPT.app, it stops before doing anything: quitting the app would take the command with it.
- **Write-ahead and resumable.** A marker, `~/.anyengine/state/flip.json`, is written before the first change and updated at each phase (`runner: 'detached'`, or `'foreground'` with `--foreground`, so either counts as alive while it runs); the layers are persisted before each change (Task 24). A flip whose runner died is resumed by the next `on`, `off` or `restart`, which waits for the app to be quiet (or `--force`) before any restart and walks the same rollback ladder as a failed `on` (and it is shown by `status`, failed by `doctor`): it rolls back to the last good state and makes sure the app is running.
- **Signals.** SIGTERM or SIGINT before the quit: the files go back and the app is never touched. Between the quit and the reopen: the flip finishes the reopen, with the files rolled back. After the reopen: treated as a failed postflight (roll back).
- **One flip at a time.** A lock, `~/.anyengine/state/flip.lock`, is created with `wx` (exclusive) and holds the runner's pid; a second flip finds it and stops. A lock whose pid is gone is stale and taken over once.
- **A quit that fails** (the app is still up after 30 s): the files go back and the app is not reopened. And nothing the running app depends on goes before its quit: on the way back, `finishOff` (Task 24: the jobs, the shared config line, the models cache) runs only after the quit succeeded, so an `off` whose quit fails leaves a working app.
- **The app is never left closed by the flip.** Once the quit has happened, a `finally` reopens the app whatever else went wrong (an exception, a failed rollback), after putting the files back as far as it can.
- **Staged updates (M2).** Checked right before every quit, the rollback restarts included: a forward flip stops with its files undone; on the way back the update is expected, the restart goes on, and the postflight re-verifies the new version.
- **The models cache (M4)** is cleaned after the quit and before the reopen; the shared `config.toml` line (Task 24, decision D15) is written, and on the way back restored, in the same window.
- **A native fan-out pre-proof** (decision D18): `on --native-proof FILE` takes the result of `smoke --lib <version> --paths native-fanout --out FILE` (Task 27). When it passed and its key matches what `on` is about to run (that lib, the app and codex versions now, the settings `on` writes), `on` writes it as the proof after the files; otherwise it starts with `router.multiAgentV1 false` and says why. Either way the app restarts once and comes up on its final path.
- **`off --force`** skips the quiet check (M1); **`restart`** does one checked restart of whatever is on, with the models cache cleaned in between (used by the switch-on after native fan-out is proven or turned off, H1).

**Files:**
- Create: `src/control-flip.mts` (the phases of `on`, `off`, `restart`, the rollback and the resume), `src/control-flip-run.mts` (the detached runner, the marker, signals, the log, the command front)
- Modify: `src/control-system.mts` and `test/helpers/fake-system.mts` (`spawnDetached`), `src/control-commands.mts` (register `on`, `off`, `restart`), `src/adapter.mts` (dispatch `flip-run`)
- Create: `test/control-flip.test.mts`
- Modify: `docs/guide/control.md`

**Interfaces:**
- Consumes: Task 19 (`System`, `ancestorCommands`, `readFlipMarker`, `writeFlipMarker`, `clearFlipMarker`, `markerAlive`, `adapterProcesses`), Task 20 (`registerCommand`), Task 9 (`markProven`, `proofKey`, `sameKey`), Task 22 (`readLayers`), Task 24 (`applyOnFiles`, `applySharedConfig`, `applyOffFiles`, `finishOff`, `OnPlan`), Task 25 (`postflight`, `FlipDeps`, `realFlipDeps`, `proveRollback`, `classifyCodexProcesses`).
- Produces:

```ts
// src/control-system.mts (added)
//   spawnDetached(argv: string[], log: string): number   // new session, stdin ignored, stdout+stderr to log; returns the pid

// src/control-flip.mts
export interface Stop { requested: NodeJS.Signals | null }
export interface OnOptions { yes: boolean; noRestart: boolean; autoRollback: boolean; waitQuietMinutes: number; lib: string | null; dryRun: boolean; nativeProof: string | null }
export interface OffOptions { routerOnly: boolean; force: boolean; yes: boolean; noRestart: boolean; waitQuietMinutes: number }
export interface RestartOptions { yes: boolean; waitQuietMinutes: number }
export interface FlipContext { system: System; root: string; deps: FlipDeps; say: Say; stop: Stop; marker: (phase: string, state?: Record<string, unknown>) => void }
export function runOn(ctx: FlipContext, options: OnOptions): Promise<number>
export function runOff(ctx: FlipContext, options: OffOptions): Promise<number>
export function runRestart(ctx: FlipContext, options: RestartOptions): Promise<number>
export function resumeFlip(ctx: FlipContext, marker: FlipMarker, options: { force: boolean; waitQuietMinutes: number }): Promise<number>
export function takeFlipLock(root: string, system: System): { ok: true; release(): void } | { ok: false; holder: number }
export function insideTheApp(system: System, pid: number): string | null   // the ancestor command, or null
export function parseOnArgs(args: string[]): (OnOptions & { foreground: boolean; follow: boolean }) | string
export function parseOffArgs(args: string[]): (OffOptions & { foreground: boolean; follow: boolean }) | string
export function parseRestartArgs(args: string[]): (RestartOptions & { foreground: boolean; follow: boolean }) | string

// src/control-flip-run.mts
export function flipCommand(op: FlipOp): Command                  // the front: checks, spawns the runner, follows its log
export function runFlipForeground(op: FlipOp, args: string[], system: System, root: string, deps: FlipDeps, say: Say, stop?: Stop): Promise<number>
export function flipRunMain(argv: string[]): Promise<number>      // `adapter.mjs flip-run <id> <op> [args...]`
```

- [x] **Step 1: Write the failing tests**

Create `test/control-flip.test.mts`. Every test runs a flip in the foreground (`runFlipForeground`) against Task 22's synthetic M0 layout, `fakeSystem`, and Task 25's `scripted` deps; one test covers the front and the detached runner with a fake `spawnDetached`:

```ts
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { isProven, proofKey } from '../src/degraded.mjs'
import { readLayers } from '../src/control-layers.mjs'
import { readFlipMarker, writeFlipMarker } from '../src/control-marker.mjs'
import { flipCommand, runFlipForeground } from '../src/control-flip-run.mjs'
import { type FakeSystem, fakeSystem } from './helpers/fake-system.mjs'
import { scripted } from './helpers/flip-deps.mjs'
import { fakeLib, m0Home } from './helpers/m0-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)

const ON = ['--yes', '--auto-rollback', '--lib', '0.1.0-m1test']
const quiet = () => {}
const layersOf = (home: string) => readLayers(join(home, '.anyengine')).layers.map((l) => l.name)
const restarts = (system: FakeSystem) => system.calls.filter((c) => c === 'quitApp' || c === 'openApp')

async function setup(options: Parameters<typeof scripted>[1] = {}) {
  const home = await m0Home()
  fakeLib(home)
  const system = fakeSystem(home)
  const { deps } = scripted(system, options)
  const root = join(home, '.anyengine')
  return { home, root, system, deps }
}

test('on: a healthy flip restarts the app once, leaves both layers on and removes its marker', async () => {
  const { home, root, system, deps } = await setup()
  assert.equal(await runFlipForeground('on', ON, system, root, deps, quiet), 0)
  assert.deepEqual(restarts(system), ['quitApp', 'openApp'])
  assert.deepEqual(layersOf(home), ['adapter', 'router'])
  assert.equal(readFlipMarker(root), null)
})

test('on: a staged app update stops everything before a single write', async () => {
  const { home, root, system, deps } = await setup()
  deps.preflip = () => ({ quiet: true, staged: true, text: 'an app update is staged and would install on restart' })
  assert.equal(await runFlipForeground('on', ON, system, root, deps, quiet), 1)
  assert.deepEqual(layersOf(home), [])
  assert.ok(!system.calls.includes('quitApp'))
})

test('on: an update staged between the files and the quit undoes the files and never quits', async () => {
  const { home, root, system, deps } = await setup()
  let checks = 0
  deps.preflip = () => ({ quiet: true, staged: (checks += 1) > 1, text: 'staged' })
  assert.equal(await runFlipForeground('on', ON, system, root, deps, quiet), 1)
  assert.deepEqual(layersOf(home), ['adapter'])
  assert.ok(!system.calls.includes('quitApp'))
})

test('on: an app that stays busy is never restarted', async () => {
  const { home, root, system, deps } = await setup()
  deps.preflip = () => ({ quiet: false, staged: false, text: 'rollout-app.jsonl was written 3s ago' })
  assert.equal(await runFlipForeground('on', [...ON, '--wait-quiet', '1'], system, root, deps, quiet), 1)
  assert.ok(!system.calls.includes('quitApp'))
  assert.deepEqual(layersOf(home), [])
})

test('on: the app coming back as another version rolls back to the adapter layer; that restart may change it again', async () => {
  const { home, root, system, deps } = await setup({ versionOnOpen: { 1: '26.935.1', 2: '26.936.0' } })
  let staged = 0
  deps.preflip = () => ({ quiet: true, staged: staged++ >= 2, text: 'staged before the rollback restart' })
  const out: string[] = []
  assert.equal(await runFlipForeground('on', ON, system, root, deps, (t) => out.push(t)), 1)
  assert.match(out.join(''), /came back as 26\.935\.1/)
  assert.match(out.join(''), /expected on the way back/)
  assert.deepEqual(layersOf(home), ['adapter'])
  assert.equal(restarts(system).filter((c) => c === 'openApp').length, 2)
})

test('on: a router the adapter did not attach rolls back; if the adapter-only state fails too, everything is undone', async () => {
  const first = await setup({ attached: false })
  assert.equal(await runFlipForeground('on', ON, first.system, first.root, first.deps, quiet), 1)
  assert.deepEqual(layersOf(first.home), ['adapter'])
  const second = await setup({ attached: false })
  second.deps.doctor = async () => ({ ok: false, text: 'bundled codex resolves: missing' })
  assert.equal(await runFlipForeground('on', ON, second.system, second.root, second.deps, quiet), 1)
  assert.deepEqual(layersOf(second.home), [])
})

test('on --dry-run proves the rollback on a scratch copy and changes nothing', async () => {
  const { home, root, system, deps } = await setup()
  const out: string[] = []
  assert.equal(await runFlipForeground('on', [...ON, '--dry-run'], system, root, deps, (t) => out.push(t)), 0)
  assert.match(out.join(''), /proof bash anyengine-off: ok/)
  assert.deepEqual(layersOf(home), [])
  assert.ok(!system.calls.includes('quitApp'))
})

test('on: a quit that fails undoes the files and never reopens', async () => {
  const { home, root, system, deps } = await setup()
  system.quitApp = () => {
    system.calls.push('quitApp')
    return false
  }
  assert.equal(await runFlipForeground('on', ON, system, root, deps, quiet), 1)
  assert.deepEqual(layersOf(home), ['adapter'])
  assert.ok(!system.calls.includes('openApp'))
})

test('on: SIGTERM between the quit and the reopen reopens the app with the files rolled back', async () => {
  const { home, root, system, deps } = await setup()
  const stop = { requested: null as NodeJS.Signals | null }
  const quit = system.quitApp.bind(system)
  system.quitApp = (ms?: number) => {
    const done = quit(ms)
    stop.requested = 'SIGTERM'
    return done
  }
  assert.equal(await runFlipForeground('on', ON, system, root, deps, quiet, stop), 1)
  assert.deepEqual(restarts(system), ['quitApp', 'openApp'])
  assert.equal(system.running, true)
  assert.deepEqual(layersOf(home), ['adapter'])
})

test('on refuses to run inside ChatGPT.app', async () => {
  const { home, root, system, deps } = await setup()
  system.procs = [
    { pid: 100, ppid: 1, command: `${system.app}/Contents/MacOS/ChatGPT` },
    { pid: process.pid, ppid: 100, command: 'node adapter.mjs on' },
  ]
  const out: string[] = []
  assert.equal(await runFlipForeground('on', ON, system, root, deps, (t) => out.push(t)), 1)
  assert.match(out.join(''), /inside ChatGPT\.app/)
  assert.deepEqual(layersOf(home), [])
})

test('a flip whose runner died is resumed: back to the last good state, and the app running', async () => {
  const { home, root, system, deps } = await setup()
  assert.equal(await runFlipForeground('on', ON, system, root, deps, quiet), 0)
  writeFlipMarker(root, { id: 'dead', op: 'on', args: ON, pid: 999999, runner: 'detached', phase: 'postflight', startedAt: 'a', updatedAt: 'b', log: join(root, 'state', 'flip-dead.log'), state: { routerLayerWasNew: true } })
  system.running = false
  const out: string[] = []
  assert.equal(await runFlipForeground('on', ON, system, root, deps, (t) => out.push(t)), 1)
  assert.match(out.join(''), /resumed an interrupted on/)
  assert.deepEqual(layersOf(home), ['adapter'])
  assert.equal(system.running, true)
  assert.equal(readFlipMarker(root), null)
})

test('a resume that needs a restart waits for quiet (or --force) and escalates down the rollback ladder', async () => {
  const { home, root, system, deps } = await setup()
  assert.equal(await runFlipForeground('on', ON, system, root, deps, quiet), 0)
  const dead = { id: 'dead', op: 'on' as const, args: ON, pid: 999999, runner: 'detached' as const, phase: 'postflight', startedAt: 'a', updatedAt: 'b', log: join(root, 'state', 'flip-dead.log'), state: { routerLayerWasNew: true } }
  writeFlipMarker(root, dead)
  deps.preflip = () => ({ quiet: false, staged: false, text: 'busy' })
  system.calls.length = 0
  assert.equal(await runFlipForeground('on', ON, system, root, deps, quiet), 1)
  assert.deepEqual(restarts(system), [], 'a busy app is not restarted by a resume')
  assert.ok(readFlipMarker(root), 'the marker stays until the resume can finish')
  deps.doctor = async () => ({ ok: false, text: 'bundled codex resolves: missing' })
  assert.equal(await runFlipForeground('on', [...ON, '--force'], system, root, deps, quiet), 1)
  assert.deepEqual(layersOf(home), [], 'the adapter-only state failed its checks too: back to the app’s own codex (D4)')
  assert.equal(system.running, true)
  assert.equal(readFlipMarker(root), null)
})

test('one flip at a time: the lock is exclusive, and a stale one is taken over', async () => {
  const { root, system, deps } = await setup()
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(join(root, 'state', 'flip.lock'), `${process.ppid}\n`)
  system.procs = [{ pid: process.ppid, ppid: 1, command: 'node adapter.mjs flip-run x on' }]
  const out: string[] = []
  assert.equal(await runFlipForeground('on', ON, system, root, deps, (t) => out.push(t)), 1)
  assert.match(out.join(''), /another flip holds the lock/)
  system.procs = []
  assert.equal(await runFlipForeground('on', ON, system, root, deps, quiet), 0, 'the holder is gone: stale, taken over')
  assert.ok(!existsSync(join(root, 'state', 'flip.lock')), 'released at the end')
})

test('once the app has quit, it is reopened whatever else fails', async () => {
  const { root, system, deps } = await setup()
  await runFlipForeground('on', ON, system, root, deps, quiet)
  const launchctl = system.launchctl.bind(system)
  system.launchctl = (args) => {
    if (args[0] === 'bootout') throw new Error('launchctl broke')
    return launchctl(args)
  }
  system.calls.length = 0
  assert.notEqual(await runFlipForeground('off', ['--router-only', '--yes'], system, root, deps, quiet), 0)
  assert.deepEqual(restarts(system), ['quitApp', 'openApp'])
  assert.equal(system.running, true)
})

test('off: a quit that fails keeps the router running and does not reopen the app', async () => {
  const { home, root, system, deps } = await setup()
  await runFlipForeground('on', ON, system, root, deps, quiet)
  system.quitApp = () => {
    system.calls.push('quitApp')
    return false
  }
  system.calls.length = 0
  assert.equal(await runFlipForeground('off', ['--router-only', '--yes'], system, root, deps, quiet), 1)
  assert.ok(system.jobs.has('dev.anyengine.router'), 'the running app still has its router')
  assert.ok(!system.calls.includes('openApp'))
  assert.equal(readLayers(join(home, '.anyengine')).layers.find((l) => l.name === 'router')?.pending, 'after-quit', 'the next off finishes it')
})

test('on --native-proof: a matching pre-proof becomes the proof; a failed or mismatched one starts with v1 off; one restart either way', async () => {
  const good = await setup()
  const proofFile = join(good.root, 'pre-proof.json')
  const key = { ...proofKey(good.root), lib: '0.1.0-m1test' }
  writeFileSync(proofFile, JSON.stringify({ key, paths: { 'native-fanout': { ok: true, ms: 1, detail: 'claim.done' } } }))
  assert.equal(await runFlipForeground('on', [...ON, '--native-proof', proofFile], good.system, good.root, good.deps, quiet), 0)
  assert.equal(isProven(good.root, 'native-fanout', proofKey(good.root)), true)
  assert.deepEqual(restarts(good.system), ['quitApp', 'openApp'])
  const bad = await setup()
  const badFile = join(bad.root, 'pre-proof.json')
  writeFileSync(badFile, JSON.stringify({ key: { ...key, codexVersion: 'another' }, paths: { 'native-fanout': { ok: true, ms: 1, detail: 'x' } } }))
  const out: string[] = []
  assert.equal(await runFlipForeground('on', [...ON, '--native-proof', badFile], bad.system, bad.root, bad.deps, (t) => out.push(t)), 0)
  assert.match(out.join(''), /pre-proof does not match/)
  assert.equal(JSON.parse(readFileSync(join(bad.root, 'config.json'), 'utf8')).router.multiAgentV1, false)
  assert.deepEqual(restarts(bad.system), ['quitApp', 'openApp'])
})

test('off --router-only cleans the models cache after the quit and before the reopen; off --force skips the quiet check', async () => {
  const { home, root, system, deps } = await setup()
  await runFlipForeground('on', ON, system, root, deps, quiet)
  mkdirSync(join(home, '.codex'), { recursive: true })
  const cache = join(home, '.codex', 'models_cache.json')
  writeFileSync(cache, JSON.stringify({ models: [{ slug: 'opus', description: 'Claude Opus, via AnyEngine' }] }))
  const seen: boolean[] = []
  const previous = system.onOpen
  system.onOpen = () => {
    seen.push(existsSync(cache))
    previous?.()
  }
  deps.preflip = () => ({ quiet: false, staged: false, text: 'busy' })
  assert.equal(await runFlipForeground('off', ['--router-only', '--yes'], system, root, deps, quiet), 1, 'busy without --force')
  assert.equal(await runFlipForeground('off', ['--router-only', '--yes', '--force'], system, root, deps, quiet), 0)
  assert.deepEqual(seen, [false], 'the cache was gone when the app reopened')
  assert.deepEqual(layersOf(home), ['adapter'])
})

test('restart: one checked restart of whatever is on', async () => {
  const { root, system, deps } = await setup()
  await runFlipForeground('on', ON, system, root, deps, quiet)
  system.calls.length = 0
  assert.equal(await runFlipForeground('restart', ['--yes'], system, root, deps, quiet), 0)
  assert.deepEqual(restarts(system), ['quitApp', 'openApp'])
})

test('the front starts a detached runner and follows its log to the exit code', async () => {
  const { root, system } = await setup()
  const spawned: string[][] = []
  system.spawnDetached = (argv, log) => {
    spawned.push(argv)
    const id = argv[argv.indexOf('flip-run') + 1]
    mkdirSync(join(root, 'state'), { recursive: true })
    writeFileSync(log, `flip started\nflip ${id} exit 0\n`)
    return 4242
  }
  const out: string[] = []
  assert.equal(await flipCommand('on')(ON, system, root, (t) => out.push(t)), 0)
  assert.equal(spawned[0]?.includes('flip-run'), true)
  assert.match(out.join(''), /flip started/)
})
```

- [x] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/control-flip-run.mjs'`.

- [x] **Step 3: Add `spawnDetached` to the seam**

In `src/control-system.mts`, add to `System` and `realSystem`:

```ts
  // A process in a session of its own (detached: setsid), stdin closed,
  // stdout and stderr appended to `log`, not waited for. A flip runs this way
  // so that quitting the app, closing a terminal or ending an agent session
  // does not end it.
  spawnDetached(argv: string[], log: string): number
```

implemented with `openSync(log, 'a', 0o600)`, `spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', fd, fd], env: process.env })`, `child.unref()`, `closeSync(fd)`, returning `child.pid`. In `test/helpers/fake-system.mts`, the default `spawnDetached` records the call and returns a fixed pid.

- [x] **Step 4: Write the phases**

Create `src/control-flip.mts`, starting with this comment and implementing it in helpers of complexity 30 or less:

```ts
// `anyengine on`, `off` and `restart`: the M0 live flip as code (M0 plan
// Task 14, docs/evidence/m0-flip.md), phase by phase. ctx.marker(phase)
// records each phase in state/flip.json before it starts (Task 19's marker).
//
// on:
//   preflight   the lib is installed and verifies (resolveLib); this command
//               is not inside ChatGPT.app; no app update is staged; the
//               app's own activity is quiet (Task 4), waiting up to
//               --wait-quiet; a staged answer stops at once
//   prove       proveRollback on a scratch copy (Task 25); --dry-run prints
//               its lines and the planned writes, and stops here
//   files       applyOnFiles (Task 24; refused when M0 is half on, or
//               while a layer is pending). With --native-proof: a pre-proof
//               that passed and whose key equals proofKey for this lib, the
//               app and codex now and the settings just written is written
//               with markProven; any other starts with router.multiAgentV1
//               false (setConfigValue), said out loud. The router must answer
//               /health within 20 s, else the files go back before the app
//               is touched
//   pre-quit    staged update? stop, files back, app untouched. Stop
//               requested? the same. The app version is recorded.
//   quit        quitApp; still running after 30 s: files back, never reopened
//   between     applySharedConfig (the one ~/.codex line, decision D15)
//   open        openApp. A stop requested between quit and open lands here:
//               the files go back first, then the app reopens
//   postflight  expect 'router'; any failure, or a stop requested now, rolls
//               back (with --auto-rollback, which the switch-on passes)
// rollback (the way back; each restart rechecks for a staged update, which
// is expected here, and its postflight passes a changed version, re-verified):
//   router      applyOffFiles --router-only, quit, finishOff (jobs, shared
//               config, cache), open, postflight 'adapter'
//   adapter     only when that fails: applyOffFiles, quit, finishOff, open,
//               postflight 'vanilla'
// off: preflight (quiet unless --force; a staged update is named, not a
//   stop), applyOffFiles (the files), quit (failure: stop; the jobs and the
//   shared config stay, so the running app keeps working; the layers stay
//   pending for the next off), finishOff, open, postflight 'adapter' or
//   'vanilla' plus a `models cache` check (no AnyEngine entry, polled 30 s).
// Any flip: once quitApp has returned true, a finally reopens the app if it
// is not running when the flip ends, whatever threw.
// restart: preflight (a staged update stops it), quit, clean the models
//   cache when the router layer is on (its catalog may have changed, for
//   example router.multiAgentV1), open, postflight for what is on; a failure
//   rolls back as `on` does.
// Without --yes a restart is asked on a terminal and refused elsewhere.
```

Rules:
- `resolveLib`: the `--lib` version, else the version of the lib this process runs from; refuse a checkout build with `install it first: npm run install:lib -- --no-activate, then run <root>/lib/<version>/scripts/anyengine-launch on --lib <version>`.
- `parseOnArgs` also takes `--native-proof FILE` and `--force`; `--force` on `on` or `restart` is used only when a dead flip must be resumed first (it skips that resume's quiet wait); a forward `on` always waits for quiet.
- `insideTheApp(system, pid)`: the first of `ancestorCommands(system, pid)` that starts with `system.app + '/'`, or null. `on`, `off` and `restart` check it in the front and again in the runner, and stop with `this command runs inside ChatGPT.app (<ancestor>); quitting the app would stop it. Run it from Terminal or another app.`
- The marker's `state` records what the resume needs: `routerLayerWasNew` (there was no router layer before this `on`), `appVersionBefore`, and `quitDone`.
- Each check the postflight returns is printed as `ok   - name: detail` or `FAIL - name: detail`.
- `takeFlipLock(root, system)`: `openSync(<state>/flip.lock, 'wx', 0o600)` with the pid written in; on `EEXIST`, read the pid: alive (in `system.processes()`) means `another flip holds the lock (pid N)`; gone means stale, so remove it and try `wx` once more. `release()` removes it only if it still holds this pid. `runFlipForeground` takes it before anything else and releases it in a `finally`.
- `resumeFlip(ctx, marker, { force, waitQuietMinutes })`: work out the last good state and get there. For `on`: when `routerLayerWasNew`, `applyOffFiles --router-only`. For `off`: `applyOffFiles` again (idempotent). Then, when the app is running and a restart is needed (a pending layer, or an `on` that stopped at `between`, `open` or `postflight`, when a new state may be loaded): run the same preflight as a flip (`waitQuiet` for up to `waitQuietMinutes`, skipped with `--force`; a staged update is expected on the way back and named) and, if still busy, stop with exit 1, the marker kept (`resume waits for a quiet app; run it again, or with --force`); then the rollback ladder of a failed `on`: quit, `finishOff`, open, postflight 'adapter'; if that fails, the adapter layer too, quit, `finishOff`, open, postflight 'vanilla' (decision D4). When the app is not running: `finishOff` and open it. For `restart`: open the app when it is not running. Then clear the marker, print `resumed an interrupted <op> (it stopped at <phase>); run the command again if you still want it`, and return 1.

- [x] **Step 5: Write the runner and the front**

Create `src/control-flip-run.mts`:

- `runFlipForeground(op, args, system, root, deps, say, stop = { requested: null })`: parse the args (usage error: exit 2); take the flip lock (`another flip holds the lock (pid N)`, exit 1); a live marker (`markerAlive`) of another flip: `another flip is running (pid N, log L)`, exit 1; a dead marker: `resumeFlip` (with this command's `--force` and `--wait-quiet`) and return its code; otherwise write the marker (`id` random, `pid` = `process.pid`, `runner` `foreground` when called from the front with `--foreground` or from a test, `detached` from `flipRunMain`, phase `preflight`), run `runOn`/`runOff`/`runRestart` with a `ctx.marker` that rewrites the marker, clear the marker when it returns, and return its code.
- `flipRunMain(['<id>', '<op>', ...args])` (the detached runner): ignore SIGHUP (`process.on('SIGHUP', () => {})`); on SIGTERM and SIGINT set `stop.requested` (a second signal is ignored too: the runner always reaches a safe state); build `realSystem()`, `anyengineRoot()`, `realFlipDeps(...)`; prune `state/flip-*.log` to the newest 10; run `runFlipForeground` with `say` writing timestamped lines to stdout (the log); end with the line `flip <id> exit <code>` and exit with that code.
- `flipCommand(op)` (the front, registered for `on`, `off`, `restart`): parse; with `--foreground`, run `runFlipForeground` in this process; otherwise check `insideTheApp` here too, create the log `state/flip-<id>.log`, `system.spawnDetached([process.execPath, <this lib's dist/src/adapter.mjs>, 'flip-run', id, op, ...args], log)`, print `flip <id> started (pid N); progress: <log>; anyengine status shows it`, and, unless `--no-follow`, print the log's new lines every second (`system.sleep`) until its last line is `flip <id> exit <code>`, and return that code; read the log before looking for the runner's pid, so a runner that already finished is never mistaken for a dead one. If the runner's pid is gone without that line, print `the flip runner stopped without finishing; run anyengine <op> again to resume` and return 1.
- In `src/adapter.mts`, next to the control-command dispatch: `if (args[0] === 'flip-run') { const { flipRunMain } = await import('./control-flip-run.mjs'); process.exitCode = await flipRunMain(args.slice(1)); return }`.
- Register the three commands in `src/control-commands.mts`: `registerCommand('on', flipCommand('on'))`, and the same for `off` and `restart`.

- [x] **Step 6: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/control-flip.test.mjs dist/test/control-postflight.test.mjs dist/test/control-install.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [x] **Step 7: Docs, gates, commit**

In `docs/guide/control.md`, document `on`, `off` and `restart` phase by phase (the comment above), their flags, the progress log and the marker, what happens on a signal, on a failed quit and on a staged update, how an interrupted flip is resumed, and what "automatic rollback" does.

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/control-flip.mts src/control-flip-run.mts src/control-system.mts src/control-commands.mts src/adapter.mts \
  test/helpers/fake-system.mts test/control-flip.test.mts docs/guide/control.md
git commit -m "feat: add detached anyengine on, off and restart with resume and automatic rollback"
```

**Acceptance:** tests pass: only one flip runs at a time (a stale lock is taken over); a staged update or a busy app stops `on` before any write; a resume waits for quiet (or `--force`) and escalates down the rollback ladder to the app's own codex when the adapter-only state fails; once the app has quit it is always reopened; an `off` whose quit fails keeps the router and the shared config and does not reopen; `on --native-proof` writes a matching pre-proof as the proof or starts with v1 off, with one restart either way; an update staged later stops it before the quit with its files undone; the app coming back as another version, or an unattached router, rolls back to the adapter layer (the rollback's own restart accepts and re-verifies a version change); a failing adapter-only state rolls back to vanilla; `--dry-run` proves the rollback on a scratch copy and writes nothing; a failed quit undoes the files and never reopens; SIGTERM between quit and reopen reopens the app with the files rolled back; the command refuses to run inside ChatGPT.app; an interrupted flip is resumed to the last good state with the app running; the models cache is gone before the reopen; `off --force` skips the quiet check; the front starts a detached runner and returns its exit code.

---
### Task 27: Nightly live smoke, with the native fan-out proof

Spec 7: "Nightly live smoke (launchd). A tiny PONG on each path ... It uses an isolated `CODEX_HOME` wherever possible. A failure raises a macOS notification and marks the path degraded." This task adds `anyengine smoke`: one PONG-sized check per path, the degraded marks, the keyed native fan-out proof (decision D18), and a pre-proof mode that tests a staged lib without touching any live state, so the switch-on needs one app restart (Task 30). The update watch and the drift fallback are Task 28.

**Paths and what each proves** (all PONG-sized: `Reply with exactly the word PONG`, effort `low`):

| Path | How | Home |
|---|---|---|
| `router` | `GET /health` answers `ok` | none |
| `gpt` | an ephemeral GPT thread through a smoke adapter (the installed lib) whose codex child is attached to the live router | real `~/.codex` (decision D7), adapter state isolated |
| `claude-agent` | a Claude thread (`smoke.claudeModel`) on the same smoke adapter: the interactive Claude Code PTY | adapter state isolated |
| `native-fanout` | whenever `router.multiAgentV1` is true, whatever path the live router is on now: a private router instance (port 0, a temporary root with a copy of `config.json` and no degraded marks) and a probe adapter attached to it on the native path; a persisted GPT thread asked to use `spawn_agent` for one `haiku` child that replies PONG; passes when a `collabAgentToolCall` for `haiku` completed, the probe adapter logged `claim.done` with success, and the parent's answer contains PONG; the threads are deleted afterwards. A pass marks native fan-out proven (Task 18) and clears its degraded mark; a failure marks it degraded, which moves the live router and every adapter spawned afterwards to the bridge path (H1). Because the probe does not depend on the live router's path, a later pass brings native back | real `~/.codex`, threads deleted, router state isolated |
| `bridge` | a Claude thread asked to use `spawn_subagents` for one GPT child that replies PONG (`bridge.spawnSubagent` event, answer contains PONG) | adapter state isolated |
| `claude-model` | only when `modes.codexClaude` is `model` (otherwise not applicable): a private router instance on a free port with `modes.codexClaude = "model"` in a temporary root, and a stand-in claim socket there that owns the smoke's thread id (the ownership gate, decision D16); one synthetic Responses request for `haiku` answered PONG through `claude -p` | isolated, no codex at all |

**Claude Code's global state (COO ruling).** The smoke never opens `~/.claude.json` for writing: it is Claude Code's global state file, and the Claude processes on this Mac rewrite it constantly, so any read-modify-write could clobber theirs. Instead every Claude run the smoke starts (`claude-agent`, the bridge's Claude thread, the claimed `native-fanout` child, which works in its parent's directory, and `claude-model`) works in one fixed, stable directory, `~/.anyengine/smoke/claude-project` (created once, never removed, never renamed), so Claude Code adds exactly one project entry, once, and it never grows. Under `~/.claude/projects` the smoke removes only its own session files: `<sessionId>.jsonl` for each Claude session id this run's adapters logged, inside that one project's folder, by exact filename. Nothing else there is ever deleted: not other files in the folder, not the session's own subdirectory, not other folders. A file it cannot find under that exact name is left and logged (the folder's name is Claude Code's escaping of the project path; the smoke looks for it by that exact name and does not search).

The smoke also cleans up the rest of what it made: every thread it persisted is deleted, and at start, `smoke/run-*` directories older than an hour (a crashed run) are removed.

If `gpt` fails with the router attached, the smoke runs the same turn once more with the router forced off (`ANYENGINE_ROUTER_URL` pointed at a closed port): when that one passes, the router is the fault and `router` is marked degraded, so every adapter spawned afterwards talks to chatgpt.com directly (Task 18) and the operator's GPT recovers at the next app launch; when it fails too, only `gpt` is marked (an upstream or login problem AnyEngine cannot fix).

**Files:**
- Create: `src/smoke-client.mts`, `src/smoke.mts`, `src/smoke-paths.mts`, `src/smoke-claude.mts`
- Modify: `src/control-commands.mts` (register `smoke`), `src/control-postflight.mts` (`realFlipDeps().smoke`), `test/fixtures/fake-codex-app-server.mjs` (`FAKE_CODEX_REPLY`, an `agentMessage` `item/completed`)
- Create: `test/smoke.test.mts`
- Modify: `docs/guide/control.md`, `docs/guide/router.md`, `src/AGENTS.md`

**Interfaces:**
- Consumes: Task 7 (`loadConfig`, `enginePaths`, `writeJsonAtomic`), Task 8 (`startRouter`, `createRouterLog`), Task 9 (`markDegraded`, `clearDegraded`, `readDegraded`, `markProven`, `proofKey`, `ProofKey`), Task 11 (`buildRouterRuntime`), Tasks 14 and 15 (the claim socket and the claim events in the adapter's debug log), Task 17 (model mode), Task 19 (`System`, `tailJsonl`), Task 25 (`FlipDeps.smoke`), `bundled-codex.mts` (`resolveBundledCodex`).
- Produces:

```ts
// src/smoke-client.mts
export class AppServerClient {
  static launch(command: string, args: string[], env: NodeJS.ProcessEnv): AppServerClient
  request(method: string, params: unknown, timeoutMs?: number): Promise<Record<string, any>>
  waitFor(match: (message: Record<string, any>) => boolean, timeoutMs?: number): Promise<Record<string, any>>
  turn(threadId: string, text: string, timeoutMs?: number): Promise<{ text: string; items: Array<Record<string, any>> }>
  close(): Promise<void>
}

// src/smoke-claude.mts: the one Claude project directory and the smoke's own session files
export function claudeProjectFolder(claudeHome: string, project: string): string   // <claudeHome>/.claude/projects/<escaped project>
export function pruneOwnSessions(claudeHome: string, project: string, sessionIds: string[]): { removed: string[]; missing: string[] }

// src/smoke-paths.mts: one runner per path, each (ctx) => Promise<PathResult>
export const PATH_RUNNERS: Record<SmokePathName, (ctx: PathContext) => Promise<PathResult>>

// src/smoke.mts
export type SmokePathName = 'router' | 'gpt' | 'claude-agent' | 'native-fanout' | 'bridge' | 'claude-model'
export interface PathResult { ok: boolean | null; ms: number; detail: string }    // null: not applicable
export interface SmokeResult { at: string; appVersion: string | null; codexVersion: string | null; lib: string | null; key: ProofKey; paths: Partial<Record<SmokePathName, PathResult>> }   // key: what a native-fanout pass proves (Task 9)
export interface SmokeDeps {
  adapter: string
  adapterEnv: (extra: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
  codexHome: string
  project: string              // the one Claude working directory: <root>/smoke/claude-project
  runDir: string
  claudeHome?: string          // where ~/.claude lives (default: the home directory); only its projects/<project folder> is ever written
  ownSessions?: string[]       // tests only: Claude session ids this run "created" (the mock runtime logs none)
}
export function realSmokeDeps(root: string, lib?: string): SmokeDeps   // lib: an installed version other than current (the pre-proof, Task 30)
// out: write the result there and change no live state (no smoke.json, no degraded or proven mark)
export function runSmoke(system: System, root: string, deps: SmokeDeps, options: { paths: SmokePathName[]; notify: boolean; lib?: string; out?: string }): Promise<SmokeResult>
export function judge(root: string, result: SmokeResult): { degraded: SmokePathName[]; cleared: SmokePathName[]; routerAtFault: boolean }
```

- [x] **Step 1: Write the failing tests**

In `test/fixtures/fake-codex-app-server.mjs`, the `turn/start` case sends a hard-coded `PONG` delta (line 229) and no `item/completed` for the agent message, so a client that reads the final message (the smoke's `turn()`) sees nothing. Make the reply `const reply = process.env.FAKE_CODEX_REPLY ?? 'PONG'`, use it for the delta at line 229 and the history's `agentMessage` text (line 243), and send, right before `turn/completed`:

```js
      notify('item/completed', {
        threadId,
        turnId,
        item: { type: 'agentMessage', id: `${turnId}-msg`, text: reply, phase: null },
      })
```

Run `T7 npm test` after this change alone: a suite whose `waitFor` matched any `item/completed` must now name the item type it waits for (narrow the predicate; do not remove the new notification).

Create `test/smoke.test.mts`:

```ts
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { enginePaths } from '../src/anyengine-config.mjs'
import { isProven, proofKey, readDegraded } from '../src/degraded.mjs'
import { judge, runSmoke, type SmokeDeps } from '../src/smoke.mjs'
import { claudeProjectFolder } from '../src/smoke-claude.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { killChildren } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(async () => {
  await killChildren()
  await removeTempDirs()
})

async function deps(root: string, reply = 'PONG'): Promise<SmokeDeps> {
  const project = join(root, 'smoke', 'claude-project')
  mkdirSync(project, { recursive: true })
  return {
    adapter: resolve('dist/src/adapter.mjs'),
    adapterEnv: (extra) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ANYENGINE_ROOT: root,
        ANYENGINE_MOCK: '1',
        ANYENGINE_RUNTIME_TYPE: 'mock',
        ANYENGINE_MODELS: 'haiku,opus',
        ANYENGINE_REAL_CODEX: resolve('test/fixtures/fake-codex-app-server.mjs'),
        FAKE_CODEX_NO_APPROVAL: '1',
        FAKE_CODEX_REPLY: reply,
        ...extra,
      }
      // The native child path is under test: override the suite-wide kill switch.
      env.ANYENGINE_NATIVE_CODEX = ''
      env.ANYENGINE_RUNTIME_ENV = join(root, 'missing.env')
      return env
    },
    codexHome: join(root, 'codex-home'),
    project,
    runDir: join(root, 'smoke-run'),
    // A home of the test's own: nothing may reach the real ~/.claude.
    claudeHome: join(root, 'claude-home'),
  }
}

test('smoke: gpt and claude-agent pass through a smoke adapter, and results are recorded', async () => {
  const root = await tempDir('ae-sm-')
  const system = fakeSystem(root)
  const result = await runSmoke(system, root, await deps(root), { paths: ['gpt', 'claude-agent'], notify: true })
  assert.equal(result.paths.gpt?.ok, true, result.paths.gpt?.detail)
  assert.equal(result.paths['claude-agent']?.ok, true, result.paths['claude-agent']?.detail)
  assert.equal(JSON.parse(readFileSync(enginePaths(root).smokeResult, 'utf8')).paths.gpt.ok, true)
  assert.deepEqual(system.notifications, [])
  assert.ok(!existsSync(join(root, 'smoke-run')), 'the run directory is removed')
})

test('smoke: a failing path is marked degraded and notified; a later pass clears it', async () => {
  const root = await tempDir('ae-sm-')
  const system = fakeSystem(root)
  await runSmoke(system, root, await deps(root, 'something else'), { paths: ['gpt'], notify: true })
  assert.ok('gpt' in readDegraded(root).paths)
  assert.match(system.notifications[0]?.message ?? '', /gpt/)
  await runSmoke(system, root, await deps(root), { paths: ['gpt'], notify: true })
  assert.ok(!('gpt' in readDegraded(root).paths))
})

test('smoke: native-fanout marks the path proven on a pass and degraded on a failure; claude-model runs only in model mode', async () => {
  const root = await tempDir('ae-sm-')
  const system = fakeSystem(root)
  const key = proofKey(root)
  const passed = judge(root, { at: 'x', appVersion: null, codexVersion: null, lib: null, key, paths: { 'native-fanout': { ok: true, ms: 1, detail: 'claim.done' } } })
  assert.deepEqual(passed.cleared, ['native-fanout'])
  assert.equal(isProven(root, 'native-fanout', key), true)
  assert.equal(isProven(root, 'native-fanout', { ...key, lib: '0.1.0-other' }), false, 'proven for this lib only')
  judge(root, { at: 'y', appVersion: null, codexVersion: null, lib: null, key, paths: { 'native-fanout': { ok: false, ms: 1, detail: 'no claim.done' } } })
  assert.ok('native-fanout' in readDegraded(root).paths)
  assert.equal(isProven(root, 'native-fanout', key), false)
  const agentMode = await runSmoke(system, root, await deps(root), { paths: ['claude-model'], notify: false })
  assert.equal(agentMode.paths['claude-model']?.ok, null)
  assert.match(agentMode.paths['claude-model']?.detail ?? '', /mode is agent/)
})

test('smoke: a crashed run directory is swept, and only this run's session files are removed, by exact name', async () => {
  const root = await tempDir('ae-sm-')
  const smokeDeps = await deps(root)
  const claudeHome = smokeDeps.claudeHome ?? ''
  const crashed = join(root, 'smoke', 'run-20260101T000000Z')
  mkdirSync(crashed, { recursive: true })
  utimesSync(crashed, new Date('2026-01-01'), new Date('2026-01-01'))
  const folder = claudeProjectFolder(claudeHome, smokeDeps.project)
  const other = join(claudeHome, '.claude', 'projects', '-some-other-project')
  mkdirSync(join(folder, 'own-1'), { recursive: true })
  mkdirSync(other, { recursive: true })
  for (const file of [join(folder, 'own-1.jsonl'), join(folder, 'someone-else.jsonl'), join(folder, 'own-1', 'sub.jsonl'), join(other, 'own-1.jsonl')]) {
    writeFileSync(file, '{}\n')
  }
  await runSmoke(fakeSystem(root), root, { ...smokeDeps, ownSessions: ['own-1', 'never-written'] }, { paths: ['claude-agent'], notify: false })
  assert.ok(!existsSync(crashed))
  assert.ok(!existsSync(join(folder, 'own-1.jsonl')), 'its own session file, by exact name')
  assert.ok(existsSync(join(folder, 'someone-else.jsonl')), 'another session in the same folder stays')
  assert.ok(existsSync(join(folder, 'own-1', 'sub.jsonl')), 'the session directory is not removed')
  assert.ok(existsSync(join(other, 'own-1.jsonl')), 'another project folder is never touched')
  assert.ok(existsSync(smokeDeps.project), 'the fixed project directory stays')
})

test('smoke: never opens ~/.claude.json for writing', async () => {
  const root = await tempDir('ae-sm-')
  const smokeDeps = await deps(root)
  const claudeHome = smokeDeps.claudeHome ?? ''
  mkdirSync(join(claudeHome, '.claude', 'projects'), { recursive: true })
  const state = join(claudeHome, '.claude.json')
  writeFileSync(state, JSON.stringify({ projects: { [smokeDeps.project]: { a: 1 }, '/other': { b: 2 } } }))
  const before = { bytes: readFileSync(state, 'utf8'), stat: statSync(state) }
  // A write, a truncate or an atomic replace of the file now fails with
  // EACCES instead of going unnoticed: the file is read-only and so is the
  // directory that holds it (only .claude/projects below stays writable).
  chmodSync(state, 0o444)
  chmodSync(claudeHome, 0o555)
  try {
    const result = await runSmoke(fakeSystem(root), root, { ...smokeDeps, ownSessions: ['own-1'] }, { paths: ['gpt', 'claude-agent'], notify: false })
    for (const path of ['gpt', 'claude-agent'] as const) assert.equal(result.paths[path]?.ok, true, result.paths[path]?.detail)
  } finally {
    chmodSync(claudeHome, 0o755)
    chmodSync(state, 0o644)
  }
  const after = statSync(state)
  assert.equal(readFileSync(state, 'utf8'), before.bytes)
  assert.equal(after.ino, before.stat.ino, 'not replaced')
  assert.equal(after.mtimeMs, before.stat.mtimeMs, 'not written')
  for (const file of ['src/smoke.mts', 'src/smoke-paths.mts', 'src/smoke-claude.mts', 'src/smoke-client.mts']) {
    assert.doesNotMatch(readFileSync(resolve(file), 'utf8'), /\.claude\.json/, `${file} names ~/.claude.json`)
  }
})

test('smoke: GPT failing only through the router marks the router, not GPT', () => {
  const root = '/nonexistent-root-for-judge'
  const verdict = judge(root, {
    at: 'x', appVersion: null, codexVersion: null, lib: null, key: { lib: null, appVersion: null, codexVersion: null, settings: '' },
    paths: { gpt: { ok: false, ms: 1, detail: 'via router: no PONG; direct: PONG' } },
  })
  assert.equal(verdict.routerAtFault, true)
  assert.deepEqual(verdict.degraded, ['router'])
})

test('smoke --out: the result goes to the file and no live state changes (the pre-proof, Task 30)', async () => {
  const root = await tempDir('ae-sm-')
  const out = join(root, 'pre-proof.json')
  await runSmoke(fakeSystem(root), root, await deps(root), { paths: ['gpt'], notify: true, lib: '0.1.0-staged', out })
  const written = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(written.paths.gpt.ok, true)
  assert.equal(written.key.lib, '0.1.0-staged')
  assert.ok(!existsSync(enginePaths(root).smokeResult), 'no smoke.json')
  assert.ok(!existsSync(join(enginePaths(root).state, 'degraded.json')))
  assert.ok(!existsSync(join(enginePaths(root).state, 'proven.json')))
})

test('smoke: smoke.mts, smoke-paths.mts and smoke-claude.mts stay under the 500-line cap', () => {
  for (const file of ['src/smoke.mts', 'src/smoke-paths.mts', 'src/smoke-claude.mts']) {
    assert.ok(readFileSync(resolve(file), 'utf8').split('\n').length <= 500, file)
  }
})
```

- [x] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/smoke.mjs'`.

- [x] **Step 3: Write the client and the smoke**

`src/smoke-client.mts`: `AppServerClient` spawns the given command over stdio (JSON-RPC lines), sends `initialize` on launch, and offers `request`, `waitFor` (match on any message), `turn(threadId, text)` (sends `turn/start` with `effort: "low"`, collects `item/completed` items until `turn/completed` for that thread, returns the final `agentMessage` text and the items) and `close` (stdin end, SIGTERM, SIGKILL after 5 s).

`src/smoke-claude.mts`, `src/smoke-paths.mts` and `src/smoke.mts` (three modules so each stays under the 500-line cap; `smoke.mts` runs and judges, `smoke-paths.mts` holds one runner per path, `smoke-claude.mts` the project directory and the pruning):

- `claudeProjectFolder(claudeHome, project)` is `<claudeHome>/.claude/projects/<name>`, where `<name>` is `project` with every character outside `[A-Za-z0-9]` replaced by `-` (Claude Code's own naming; after the first live smoke, check that this folder exists, read-only, and fix the rule if Claude Code named it differently). `pruneOwnSessions` removes `<folder>/<id>.jsonl` for each id that matches `^[A-Za-z0-9-]+$` and is a regular file (`lstat`), and nothing else; it reports what it removed and what it did not find, and never lists, walks or creates anything.
- `runSmoke` never opens `~/.claude.json` for writing and names that file nowhere in its code (the test above checks both). It first sweeps `smoke/run-*` directories older than an hour (only direct children of `<root>/smoke/` whose name matches `^run-\d{8}T\d{6}Z$`; the walk fails closed on anything else), then creates `deps.runDir` (0700), launches one smoke adapter for the adapter paths: `AppServerClient.launch(process.execPath, [deps.adapter, 'app-server', '-c', 'mcp_servers={}', '-c', 'notify=[]'], deps.adapterEnv({ CODEX_HOME: deps.codexHome, ANYENGINE_HOME: join(deps.runDir, 'adapter'), ANYENGINE_DEBUG_LOG: join(deps.runDir, 'debug.jsonl') }))`, runs the requested paths in the order router, gpt, claude-agent, native-fanout, bridge, claude-model, each with its own timeout (`gpt` and `claude-agent` 120 s; `native-fanout` and `bridge` 300 s; `claude-model` 120 s), records `{ ok, ms, detail }`, closes the adapter, deletes every persisted thread it created (`thread/delete`) before closing, removes `deps.runDir`, calls `pruneOwnSessions(claudeHome, deps.project, ids)` with the Claude session ids this run's adapters logged (the anyengine runtime's session events in the smoke's debug logs; take the event name from `src/anyengine-runtime.mts`) plus `deps.ownSessions`, writes `state/smoke.json` atomically, appends one line to `~/.anyengine/logs/smoke.jsonl` (a `createRouterLog` with `maxBytes: 1_000_000`, `keep: 3`), applies `judge`, and, when `notify` and any path failed, calls `system.notify('AnyEngine smoke', '<paths> failed. Run anyengine status. GPT affected? anyengine off')`.
- `gpt`: `model/list`, the model is `smoke.gptModel` or the lowest-ranked listed GPT entry (`isAnyEngineEntry` false); `thread/start { model, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', cwd: deps.project }`; passes when the answer contains `PONG`. When it fails and the smoke adapter's last `router.link` says attached, a second adapter with `ANYENGINE_ROUTER_URL=http://127.0.0.1:9/backend-api/codex` repeats it; the detail becomes `via router: <...>; direct: <...>`.
- `claude-agent`: `thread/start { model: smoke.claudeModel, sandbox: 'workspace-write', approvalPolicy: 'on-request', cwd: deps.project }`; passes on `PONG`.
- `native-fanout`: `null` (not applicable) when `router.multiAgentV1` is false. Otherwise it starts a private router (`startRouter` in-process on port 0 with a temporary root holding a copy of `config.json`, `hooks: buildRouterRuntime(tempRoot, log).hooks`), seeds `markProven(tempRoot, 'native-fanout', 'smoke probe', proofKey(tempRoot))` so the private router serves the native catalog and the probe adapter's link takes the native path (both read the proof, Tasks 9 and 18), and launches a probe adapter like the smoke adapter with `ANYENGINE_ROOT=<tempRoot>` (its claim socket lands where the private router looks) and `ANYENGINE_ROUTER_URL=<private router>/backend-api/codex`; the GPT thread starts with `cwd: deps.project`, so the claimed child works there too; the prompt is `Use spawn_agent to start exactly one sub-agent with model "haiku" whose task is: Reply with exactly the word PONG. Wait for it, then reply with its answer only.`; passes when an item of type `collabAgentToolCall` with `model: "haiku"` completed, the smoke debug log has a `claim.done` event with `success: true`, and the answer contains PONG.
- `bridge`: a Claude thread (`cwd: deps.project`) asked `Use the anyengine spawn_subagents tool to start one sub-agent on gpt whose task is: Reply with exactly the word PONG. Reply with its answer only.`; passes on a `bridge.spawnSubagent` debug event and PONG.
- `claude-model`: `null` with detail `not applicable: mode is agent` unless the real config's `modes.codexClaude` is `model`. Otherwise `startRouter` in-process on port 0 with a temporary root whose `config.json` has `modes.codexClaude: "model"` and `claude.cli` from the real config, and `hooks: buildRouterRuntime(tempRoot, log).hooks`, plus a stand-in `ClaimServer` on `<tempRoot>/run` whose host owns the smoke's thread id (the ownership gate); POST `{ model: 'haiku', input: [{ type: 'additional_tools', tools: [] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly the word PONG' }] }] }` with `thread-id: <random uuid>`, plus the environment-context input item Codex sends, naming `deps.project` as the cwd, so `claude -p` runs there (use the item shape `codex-input.mts` parses for `parsed.cwd`); passes on `PONG` in the stream.
- `router`: `GET /health` with a 2 s timeout.
- `judge(root, result)`: every `ok: false` path is marked degraded with its detail (for `native-fanout` that also clears its proof), every `ok: true` path cleared, and a passing `native-fanout` is marked proven for exactly what it tested: `markProven(root, 'native-fanout', <detail>, result.key)`, where `result.key` is `proofKey(root)` taken when the run started, with `lib` set to the version the smoke ran (Task 9); for `gpt`, a detail matching `/^via router: .*; direct: .*PONG/` marks `router` instead of `gpt` (`routerAtFault: true`).
- `realSmokeDeps(root, lib)`: `adapter` is `<root>/lib/<lib>/dist/src/adapter.mjs`, or `<root>/lib/current/...` resolved to its version directory when `lib` is not given, `adapterEnv` is `process.env` plus `extra`, `codexHome` is `~/.codex`, `project` is `<root>/smoke/claude-project` (created 0700 if missing, never removed), `runDir` is `<root>/smoke/run-<stamp>`, `claudeHome` is the home directory.

- `options.out` (the pre-proof): the result, with its `key`, is written to that file (0600) and nothing else is: no `smoke.json`, no log line, no `judge`, no notification. `options.lib` names the version under test and is recorded in the result's `key`; the `smoke --lib` command checks that it exists under `<root>/lib/` and verifies with `lib-verify` before it builds `realSmokeDeps(root, lib)`. Run that command from the version's own `dist/src/adapter.mjs`, so the private router is that version's code too.

Register `smoke` in `src/control-commands.mts` (`--paths a,b` default all; `--notify`; `--lib VERSION`; `--out FILE`; `--scheduled` is added by Task 28), and set `realFlipDeps(...).smoke` in `src/control-postflight.mts` to `(paths) => runSmoke(system, root, realSmokeDeps(root), { paths, notify: false })` mapped to `{ ok: every requested path ok or null, text: one line per path }`.

- [x] **Step 4: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/smoke.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [x] **Step 5: Docs, gates, commit**

In `docs/guide/control.md`, add `smoke` (paths, homes, the one Claude project directory, what "degraded" and "proven" do, `--lib` and `--out`, where results go). In `docs/guide/router.md`, a paragraph on the `router` degraded mark and the native fan-out proof. Add the four modules to `src/AGENTS.md`.

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK (`File-size ratchet OK`: each new module under 500 lines), `ℹ fail 0`.

```bash
git add src/smoke-client.mts src/smoke.mts src/smoke-paths.mts src/smoke-claude.mts src/control-commands.mts \
  src/control-postflight.mts test/fixtures/fake-codex-app-server.mjs test/smoke.test.mts \
  docs/guide/control.md docs/guide/router.md src/AGENTS.md
git commit -m "feat: add the nightly smoke with the keyed native fan-out proof"
```

**Acceptance:** tests pass; a failing path is marked degraded and notified once; a native fan-out pass proves exactly the lib, app, codex and settings it ran under, and a failure moves the router and new adapters to the bridge path, while a later pass (probed on a private router, whatever the live path) proves native again; `--out` writes a result and changes no live state; GPT failing only through the router marks the router (which the adapter then leaves out); `claude-model` runs only in model mode; every Claude run works in the one fixed project directory; the smoke never opens `~/.claude.json` for writing, removes only its own session files by exact name inside that project's folder, deletes its threads, and sweeps crashed runs; each smoke module is under the size cap.

---

Source acceptance: Task 27 is integrated at `9d87a36d485dba6d12080759b6c7be49bfbbea3c`; the settled frozen full passed 1,514/1,514 with zero failures, cancellations, skips or todos. Independent complete review plus scoped corrections closed I1 and I2 with zero open findings. Installed and live acceptance remains in Tasks 30–31.

### Task 28: The update watch and the drift fallback

Spec 7: "Update gate (approved; best effort) ... if Sparkle offers no reliable hold, degrade to detect-and-alert" (decision D8: it does not). "Drift. On every adapter start, compare the running codex's generated schema hash with the last known-good one ... On failure, fall back to the bundled codex and flag the problem in `status`." This task adds the scheduled `smoke --scheduled` run that fires nightly and whenever the app's bundle or Sparkle's cache changes, the verification of every new app version (bundled codex found, wire capture, posture schema, smoke, native fan-out proof), and the drift marker the shim honours by running an unverified version on the vendor codex.

**Files:**
- Create: `src/update-watch.mts`, `test/update-watch.test.mts`
- Modify: `src/control-commands.mts` (`smoke --scheduled`), `scripts/codex-shim` (drift fallback), `scripts/install-lib.mjs` (two fixtures copied into the lib), `test/shim.test.mts`
- Modify: `docs/guide/control.md`, `scripts/AGENTS.md`

**Interfaces:**
- Consumes: Task 6 (`scripts/capture-codex-wire.mjs`), Task 7 (`enginePaths`, `writeJsonAtomic`), Task 19 (`System`), Task 27 (`runSmoke`, `realSmokeDeps`), `bundled-codex.mts` (`resolveBundledCodex`).
- Produces:

```ts
// src/update-watch.mts
export interface KnownGood { appVersion: string; codexVersion: string; codexPath: string; verifiedAt: string }
export interface WatchOutcome { staged: 'none' | 'notified' | 'seen'; verified: 'unchanged' | 'passed' | 'failed'; reason: string | null }
export function watchOnce(system: System, root: string, deps: { preflipStaged(): boolean; verify(): Promise<{ ok: boolean; reason: string; codexVersion: string; codexPath: string }> }): Promise<WatchOutcome>
export function writeDriftMarker(root: string, appVersion: string, reason: string): void    // two lines: version, reason
export function clearDriftMarker(root: string): void
```

- [x] **Step 1: Write the failing tests**

Create `test/update-watch.test.mts`:

```ts
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import test, { after } from 'node:test'
import { enginePaths } from '../src/anyengine-config.mjs'
import { watchOnce } from '../src/update-watch.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

test('update watch: a staged update is reported once; a new version is verified, and a failure leaves a drift marker', async () => {
  const root = await tempDir('anyengine-watch-')
  const system = fakeSystem(root)
  mkdirSync(enginePaths(root).state, { recursive: true })
  writeFileSync(enginePaths(root).knownGood, JSON.stringify({ appVersion: '26.928.20755', codexVersion: '0.159.0', codexPath: '/x', verifiedAt: 'x' }))
  let staged = true
  const verifyOk = async () => ({ ok: true, reason: '', codexVersion: '0.160.0', codexPath: '/y' })
  const first = await watchOnce(system, root, { preflipStaged: () => staged, verify: verifyOk })
  assert.equal(first.staged, 'notified')
  assert.equal((await watchOnce(system, root, { preflipStaged: () => staged, verify: verifyOk })).staged, 'seen')
  assert.equal(system.notifications.length, 1)
  staged = false
  system.version = '26.935.1'
  const failed = await watchOnce(system, root, {
    preflipStaged: () => false,
    verify: async () => ({ ok: false, reason: 'posture schema: 2 new values', codexVersion: '0.160.0', codexPath: '/y' }),
  })
  assert.equal(failed.verified, 'failed')
  assert.deepEqual(readFileSync(enginePaths(root).driftMarker, 'utf8').split('\n').slice(0, 2), ['26.935.1', 'posture schema: 2 new values'])
  const passed = await watchOnce(system, root, { preflipStaged: () => false, verify: verifyOk })
  assert.equal(passed.verified, 'passed')
  assert.ok(!existsSync(enginePaths(root).driftMarker))
  assert.equal(JSON.parse(readFileSync(enginePaths(root).knownGood, 'utf8')).appVersion, '26.935.1')
})
```

In `test/shim.test.mts`, add:

```ts
const plist = (version: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`

test('a version that failed verification is run on the vendor codex by the shim', async () => {
  const dir = await home('anyengine-shim-drift-')
  const app = await fakeApp(dir, 'app')
  await writeFile(join(app, 'Contents', 'Info.plist'), plist('26.935.1'))
  await mkdir(join(dir, '.anyengine', 'state'), { recursive: true })
  await writeFile(join(dir, '.anyengine', 'state', 'drift-failed'), '26.935.1\nposture schema: 2 new values\n')
  const proc = spawn(shim, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: shimEnv(dir, { ANYENGINE_ADAPTER: adapter, ANYENGINE_MOCK: '1', ANYENGINE_CHATGPT_APP: app }),
  })
  try {
    const recorded = JSON.parse(await waitForFile(join(dir, 'fake-argv.json')))
    assert.equal(recorded.tag, 'app', "the app's own codex, not the adapter")
    const marker = JSON.parse(await readFile(join(dir, '.anyengine', 'shim-fallback.json'), 'utf8'))
    assert.match(marker.reason, /not verified ChatGPT\.app 26\.935\.1: posture schema/)
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})

test('a drift marker for another version leaves the adapter running', async () => {
  const dir = await home('anyengine-shim-drift-ok-')
  const app = await fakeApp(dir, 'app')
  await writeFile(join(app, 'Contents', 'Info.plist'), plist('26.928.20755'))
  await mkdir(join(dir, '.anyengine', 'state'), { recursive: true })
  await writeFile(join(dir, '.anyengine', 'state', 'drift-failed'), '26.935.1\nx\n')
  const proc = spawn(shim, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: shimEnv(dir, { ANYENGINE_ADAPTER: adapter, ANYENGINE_MOCK: '1', ANYENGINE_CHATGPT_APP: app }),
  })
  try {
    const initialize = { clientInfo: { name: 't', version: '0' } }
    proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initialize })}\n`)
    await waitForOutput(proc, /"userAgent":"[^"]*anyengine/)
    await assert.rejects(readFile(join(dir, '.anyengine', 'shim-fallback.json')))
  } finally {
    proc.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})
```

(`home`, `fakeApp`, `shimEnv`, `waitForFile` and `waitForOutput` are this suite's own helpers.)

- [x] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/update-watch.mjs'`.

- [x] **Step 3: Write the update watch and wire `--scheduled`**

`src/update-watch.mts`, `watchOnce`:

1. Staged update: when `deps.preflipStaged()` and `update-watch.json` has not recorded a notification for the current app version, notify `ChatGPT.app <version> has an update waiting; it installs when the app quits. AnyEngine will verify the new version then.` and record it (`staged: 'notified'`); when already recorded, `staged: 'seen'`.
2. Version: when `system.appVersion()` differs from `known-good.json`'s `appVersion` (or there is none), and `update-watch.json` has not already verified this version, run `deps.verify()`. Pass: write `known-good.json` with the new version and `verifiedAt`, remove the drift marker (`verified: 'passed'`). Fail: `writeDriftMarker(root, version, reason)`, notify `AnyEngine: ChatGPT.app <version> failed verification (<reason>). The app runs on its own codex until fixed; run anyengine status.` (`verified: 'failed'`). Either way record the version in `update-watch.json` so a WatchPaths storm verifies it once.

The real `verify` (in `src/control-commands.mts`, where `--scheduled` wires it): resolve the bundled codex (`resolveBundledCodex()`; missing is a failure), run `node <lib>/scripts/capture-codex-wire.mjs --codex <codex> --out <tmp>` (exit 0 required), run `node <lib>/scripts/check-posture-schema.mjs` with `CODEX_REAL=<codex>` (exit 0 required; this needs the lib's `test/fixtures/posture-schema.json` and the Claude fixture, so add `test/fixtures/posture-schema.json` and `test/fixtures/claude-permission-modes.json` to `install-lib.mjs`'s `COPY` list), then `runSmoke` for `router, gpt, claude-agent`, and `native-fanout` when `router.multiAgentV1` is true (a new app or codex version invalidates the native fan-out proof, which is keyed on both, Task 9; this run proves it again or marks it degraded). The reason names the first step that failed; a `native-fanout` failure alone is not a verification failure (the router is on the bridge path until it passes), so it does not write the drift marker.

Add `--scheduled` to the `smoke` command in `src/control-commands.mts`: run `watchOnce` first, then the full smoke only if the last full smoke is older than 20 hours or `watchOnce` just verified a new version.

- [x] **Step 4: The shim honours the drift marker**

In `scripts/codex-shim`, add near `resolve_bundled_codex`:

```bash
# The app's version, as its Info.plist says (the update gate keys on it).
# plutil reads any plist on macOS; elsewhere (CI on Linux) an XML plist is read
# with sed.
app_version() {
  local plist="$CHATGPT_APP/Contents/Info.plist"
  if [ -x /usr/bin/plutil ] && /usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$plist" 2>/dev/null; then
    return 0
  fi
  sed -n '/<key>CFBundleShortVersionString<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$plist" 2>/dev/null | head -1
}
```

and in the `app-server)` branch, before `if ! adapter_ready; then`:

```bash
    # Spec 7 drift: a ChatGPT.app version the update gate could not verify
    # runs on its own codex until AnyEngine is fixed (anyengine status says why).
    DRIFT="${ANYENGINE_ROOT:-$HOME/.anyengine}/state/drift-failed"
    if [ -f "$DRIFT" ]; then
      drift_version="$(sed -n 1p "$DRIFT" 2>/dev/null || true)"
      if [ -n "$drift_version" ] && [ "$drift_version" = "$(app_version)" ]; then
        fallback_to_bundled "AnyEngine has not verified ChatGPT.app ${drift_version}: $(sed -n 2p "$DRIFT" 2>/dev/null)" "$@" || true
        exit 1
      fi
    fi
```

(`fallback_to_bundled` execs the bundled codex when it finds one, so `exit 1` is reached only when nothing can run.)

- [x] **Step 5: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/update-watch.test.mjs dist/test/shim.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [x] **Step 6: Check the update-hold evidence on the installed app (read-only)**

Run: `strings /Applications/ChatGPT.app/Contents/Resources/native/sparkle.node | grep -c setAutomaticallyDownloadsUpdates; LC_ALL=C grep -a -c 'electron-sparkle-gates-changed' /Applications/ChatGPT.app/Contents/Resources/app.asar; LC_ALL=C grep -a -c 'installForcedUpdate' /Applications/ChatGPT.app/Contents/Resources/app.asar`
Expected: three counts of 1 or more: the app sets Sparkle's automatic download itself, from server gates, and has a forced-install path, so decision D8 (no reliable hold; detect and alert) still holds. If any count is 0, record it in `docs/guide/router.md` and in the Task 31 evidence as "re-check D8": the app changed how it updates.

- [x] **Step 7: Docs, gates, commit**

In `docs/guide/control.md`, add "Updates" (no hold; staged-update notice; verification of each new version, the native fan-out proof included; the drift marker and what the shim does with it; `anyengine smoke --scheduled` clears it after a passing verification). Add to `scripts/AGENTS.md`'s shim entry: "the shim also runs a version the update gate marked failed on the vendor codex".

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/update-watch.mts test/update-watch.test.mts src/control-commands.mts scripts/codex-shim scripts/install-lib.mjs \
  test/shim.test.mts docs/guide/control.md scripts/AGENTS.md
git commit -m "feat: add the update watch and the shim's drift fallback"
```

**Acceptance:** tests pass; a staged update is notified once; a new app version is verified once (the native fan-out proof included), and a failure makes the shim run it on the vendor codex; the Sparkle evidence for decision D8 is re-checked on the installed app.

**Source acceptance (2026-10-04):** the complete combined review and scoped lifecycle corrections are approved. The exact source passed 1,552 hermetic tests with 89.39% line coverage on Node 24.13.0/npm 11.6.2; affected startup, fallback and identity-refusal controls passed. The installed read-only Sparkle markers remain 1/3/1 and support D8 detect-and-alert. Real installed update verification, OAuth/PTY/GPT, native and GUI acceptance remain pending in Tasks 30–31.

---
### Task 29: The Codex CLI host: `anyengine codex`

**Accepted terminal scope amendment (R121):** preserve normal controlling-terminal
access, foreground restoration, original argv/stdin, exit status and signals.
Suspend/resume is unsupported: a stopped vendor job ends this host nonzero,
restores the caller foreground, and joins its owned CLI/adapter/resources.
Never resume/restart/replay a turn or invoke fallback after the CLI starts;
existing user sessions remain intact. Use the proved fixed Bash job-control
seam with private ownership admission before vendor exec. Permanent fake PTY
controls verify normal and safe-stopped termination; official interactive TUI
acceptance remains Task 31. The fixed Task29 dispatch brief and failed control
evidence remain unchanged.

The spec's v1 scope has "Codex CLI | Claude | `codex --remote` to the adapter, which gives the same engines, modes and rotation. No global `config.toml` edit.", and no milestone owned it; the COO put it in M1. `anyengine codex [codex args...]` starts an adapter on a random loopback WebSocket port, then the app's own codex TUI with `--remote` pointed at it, and stops the adapter when the TUI exits. The adapter's codex child is linked to the router exactly as the app's is (Task 18), so the TUI's picker lists Claude, a Claude thread runs in the configured mode, and native `spawn_agent` children are claimed. Nothing global changes: no `config.toml` edit, no rc line. Because a browser page can open `ws://127.0.0.1:<port>`, the adapter's WebSocket listener refuses any upgrade with an `Origin` header and, when `ANYENGINE_WS_TOKEN` is set, any without `Authorization: Bearer <token>`; `anyengine codex` generates a token per run and hands it to codex with `--remote-auth-token-env`.

Never script the TUI (spec 7): the tests and the acceptance probe speak the TUI's protocol over the same WebSocket instead; the operator runs the TUI itself.

**Files:**
- Create: `src/codex-remote.mts`, `scripts/probe-remote-headless.mjs`
- Modify: `src/transports.mts` (Origin and token checks on the WebSocket listener), `src/control-commands.mts` (register `codex`)
- Create: `test/codex-remote.test.mts`
- Modify: `docs/guide/control.md`, `docs/guide/configuration.md` (`ANYENGINE_WS_TOKEN`), `scripts/AGENTS.md`

**Interfaces:**
- Consumes: `bundled-codex.mts` (`resolveBundledCodex`), `control-system.mts`, `smoke-client.mts` (for the probe's message handling, reimplemented over WebSocket).
- Produces:

```ts
// src/codex-remote.mts
export interface RemoteLaunch { url: string; token: string; adapter: ChildProcess }
export function startRemoteAdapter(adapterPath: string, env: NodeJS.ProcessEnv): Promise<RemoteLaunch>
export function codexRemoteArgs(url: string, userArgs: string[]): string[]   // ['--remote', url, '--remote-auth-token-env', 'ANYENGINE_REMOTE_TOKEN', ...userArgs]
export function runCodexRemote(args: string[], options: { adapterPath: string; codex: string | null; env: NodeJS.ProcessEnv }): Promise<number>

// src/transports.mts
// WebSocket upgrades: 403 with an Origin header; 401 without the bearer when ANYENGINE_WS_TOKEN is set.
```

`node scripts/probe-remote-headless.mjs [--mode agent|model]` runs against the installed lib, prints one line per check and exits 0 when all pass: `initialize`, `model/list lists Claude`, `GPT PONG`, `Claude PONG`, `native spawn claimed` (native path only).

- [x] **Step 1: Write the failing tests**

Create `test/codex-remote.test.mts`:

```ts
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test, { after } from 'node:test'
import WebSocket from 'ws'
import { codexRemoteArgs, startRemoteAdapter } from '../src/codex-remote.mjs'
import { killChildren } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const launched: Array<{ adapter: { kill(): void } }> = []
after(async () => {
  for (const l of launched) l.adapter.kill()
  await killChildren()
  await removeTempDirs()
})

async function adapterEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await tempDir('ae-rm-')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANYENGINE_ROOT: root,
    ANYENGINE_HOME: `${root}/home`,
    ANYENGINE_DEBUG_LOG: `${root}/debug.jsonl`,
    ANYENGINE_MOCK: '1',
    ANYENGINE_RUNTIME_TYPE: 'mock',
    ANYENGINE_MODELS: 'haiku',
    ANYENGINE_REAL_CODEX: resolve('test/fixtures/fake-codex-app-server.mjs'),
    FAKE_CODEX_NO_APPROVAL: '1',
    // The native child path is under test: override the suite-wide kill switch.
    ANYENGINE_NATIVE_CODEX: '',
    ANYENGINE_RUNTIME_ENV: `${root}/missing.env`,
  }
  return env
}

function connect(url: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url, { headers })
    ws.once('open', () => ok(ws))
    ws.once('unexpected-response', (_q, res) => fail(new Error(String(res.statusCode))))
    ws.once('error', fail)
  })
}

function rpc(ws: WebSocket) {
  let id = 0
  const waiting = new Map<number, (m: Record<string, any>) => void>()
  const seen: Array<Record<string, any>> = []
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString())
    seen.push(message)
    if (message.id != null && waiting.has(message.id)) waiting.get(message.id)?.(message)
  })
  return {
    seen,
    request: (method: string, params: unknown) =>
      new Promise<Record<string, any>>((ok) => {
        const n = ++id
        waiting.set(n, ok)
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }))
      }),
  }
}

test('codex remote: the TUI arguments carry the URL and the token variable, then the user’s', () => {
  assert.deepEqual(codexRemoteArgs('ws://127.0.0.1:5000', ['--model', 'opus']), [
    '--remote', 'ws://127.0.0.1:5000', '--remote-auth-token-env', 'ANYENGINE_REMOTE_TOKEN', '--model', 'opus',
  ])
})

test('codex remote: the listener refuses browsers and missing tokens, and serves Claude and GPT', async () => {
  const launch = await startRemoteAdapter(resolve('dist/src/adapter.mjs'), await adapterEnv())
  launched.push(launch)
  await assert.rejects(connect(launch.url, { origin: 'https://evil.example', authorization: `Bearer ${launch.token}` }), /403/)
  await assert.rejects(connect(launch.url, {}), /401/)
  const ws = await connect(launch.url, { authorization: `Bearer ${launch.token}` })
  const client = rpc(ws)
  await client.request('initialize', { clientInfo: { name: 'probe', version: '0' } })
  const claude = await client.request('thread/start', { model: 'haiku', cwd: process.cwd() })
  await client.request('turn/start', { threadId: claude.result.thread.id, input: [{ type: 'text', text: 'Reply with exactly the word PONG' }] })
  const gpt = await client.request('thread/start', { model: 'gpt-6-sol' })
  assert.ok(gpt.result.thread.id)
  ws.close()
})
```

- [x] **Step 2: Run them to see them fail**

Run: `T7 npm run build 2>&1 | tail -3`
Expected: FAIL to compile, `Cannot find module '../src/codex-remote.mjs'`.

- [x] **Step 3: Guard the WebSocket listener**

In `src/transports.mts`, `startWebSocketTransport`, replace `const wss = new WebSocketServer({ server })` with:

```ts
  // A browser page can open ws://127.0.0.1:<port>; the Codex TUI sends no
  // Origin. With ANYENGINE_WS_TOKEN set (anyengine codex sets one per run),
  // only a client presenting it as a bearer is let in.
  const token = (process.env.ANYENGINE_WS_TOKEN ?? '').trim()
  const wss = new WebSocketServer({
    server,
    verifyClient: (info, done) => {
      if (info.req.headers.origin) return done(false, 403, 'Forbidden')
      if (!token) return done(true)
      const given = Buffer.from(String(info.req.headers.authorization ?? ''))
      const wanted = Buffer.from(`Bearer ${token}`)
      done(given.length === wanted.length && timingSafeEqual(given, wanted), 401, 'Unauthorized')
    },
  })
```

with `import { timingSafeEqual } from 'node:crypto'`. Document `ANYENGINE_WS_TOKEN` in `docs/guide/configuration.md` ("Set by `anyengine codex`: the bearer the adapter's WebSocket listener requires").

- [x] **Step 4: Write the launcher**

Create `src/codex-remote.mts`:

```ts
// `anyengine codex`: the Codex CLI host (spec 2, "Codex CLI | Claude |
// codex --remote to the adapter"). An adapter listens on a random loopback
// WebSocket port with a one-run bearer token; the app's own codex TUI
// connects to it with --remote. The adapter attaches the router to its codex
// child like the app's adapter does, so the TUI gets the same engines and
// modes. Nothing global changes, and the adapter stops when the TUI exits.
// The TUI is the operator's: this never scripts it (spec 7).
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { resolveBundledCodex } from './bundled-codex.mjs'

export interface RemoteLaunch {
  url: string
  token: string
  adapter: ChildProcess
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const server = net.createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => ok(port))
    })
  })
}

export function codexRemoteArgs(url: string, userArgs: string[]): string[] {
  return ['--remote', url, '--remote-auth-token-env', 'ANYENGINE_REMOTE_TOKEN', ...userArgs]
}

export async function startRemoteAdapter(adapterPath: string, env: NodeJS.ProcessEnv): Promise<RemoteLaunch> {
  const port = await freePort()
  const url = `ws://127.0.0.1:${port}`
  const token = randomBytes(24).toString('hex')
  const adapter = spawn(process.execPath, [adapterPath, 'app-server', '--listen', url], {
    env: { ...env, ANYENGINE_WS_TOKEN: token },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`the adapter did not listen on ${url}: ${stderr.slice(-400)}`)), 15_000)
    adapter.stderr?.setEncoding('utf8')
    adapter.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.includes(`listening on ${url}`)) {
        clearTimeout(timer)
        ok()
      }
    })
    adapter.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`the adapter exited (${code}) before listening: ${stderr.slice(-400)}`))
    })
  })
  return { url, token, adapter }
}

export async function runCodexRemote(
  args: string[],
  options: { adapterPath: string; codex: string | null; env: NodeJS.ProcessEnv },
): Promise<number> {
  const codex = options.codex ?? resolveBundledCodex(options.env).path
  if (!codex) {
    process.stderr.write('anyengine codex: ChatGPT.app\'s codex was not found\n')
    return 1
  }
  const launch = await startRemoteAdapter(options.adapterPath, options.env)
  try {
    const tui = spawn(codex, codexRemoteArgs(launch.url, args), {
      env: { ...options.env, ANYENGINE_REMOTE_TOKEN: launch.token },
      stdio: 'inherit',
    })
    return await new Promise<number>((ok) => tui.once('exit', (code) => ok(code ?? 1)))
  } finally {
    launch.adapter.kill('SIGTERM')
  }
}
```

(`resolveBundledCodex` takes the environment; if its current signature differs, pass what `src/bundled-codex.mts` expects.)

Register `codex` in `src/control-commands.mts`: `runCodexRemote(args, { adapterPath: <this lib's dist/src/adapter.mjs>, codex: null, env: process.env })`.

- [x] **Step 5: Write the headless acceptance probe**

Create `scripts/probe-remote-headless.mjs` (runs from the installed lib, never from a checkout; reads no build output of this checkout): it imports `startRemoteAdapter` from `<lib>/dist/src/codex-remote.mjs` (`<lib>` is `~/.anyengine/lib/current` resolved), starts the adapter with `process.env` (the real `~/.codex` and the live router, as `anyengine codex` would), connects with the bearer, and checks, printing `ok`/`FAIL` per line: `initialize` (a `userAgent`), `model/list lists Claude` (an entry `opus`, `sonnet` or `haiku`), `GPT PONG` (an ephemeral thread on the lowest-ranked listed GPT model), `Claude PONG` (`haiku`, workspace-write, cwd `--project DIR`, default `~/.anyengine/smoke/claude-project`: the one fixed Claude directory, so no new `~/.claude.json` entry per run; the probe's own state goes in `mktemp -d "$TMPDIR/remote.XXXXXX"`), and, when the adapter's router link took the native path (the router says native and native fan-out is proven, Task 18), `native spawn claimed` (the Task 27 `native-fanout` prompt; the debug log is the adapter's own, in the probe directory). It deletes the persisted threads, stops the adapter, removes its directory and exits 0 only when every line is `ok`.

- [x] **Step 6: Run the tests to see them pass**

Run: `T7 npm run build && T7 node scripts/test-hermetic.mjs dist/test/codex-remote.test.mjs`
Expected: PASS, `ℹ pass 2`, `ℹ fail 0`.

Run: `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex --help | grep -A1 -- '--remote-auth-token-env'`
Expected: the flag and its description ("bearer token to send to a remote app ..."). If the flag is gone, drop it from `codexRemoteArgs` and keep the Origin check alone.

- [x] **Step 7: Docs, gates, commit**

In `docs/guide/control.md`, add `anyengine codex`: what it starts, that it changes nothing global, the token, and that `exit` in the TUI stops the adapter. Add the probe to `scripts/AGENTS.md`.

Run: `T7 npm run check && T7 npm run typecheck && T7 npm test`
Expected: all gates OK, `ℹ fail 0`.

```bash
git add src/codex-remote.mts src/transports.mts src/control-commands.mts scripts/probe-remote-headless.mjs \
  test/codex-remote.test.mts docs/guide/control.md docs/guide/configuration.md scripts/AGENTS.md
git commit -m "feat: add anyengine codex, the Codex CLI host over a token-guarded loopback socket"
```

**Acceptance:** tests pass: the adapter's WebSocket refuses a browser origin and a missing token and serves Claude and GPT threads with the token; `anyengine codex` changes nothing outside its own processes.

**Source acceptance (2026-10-04):** the complete combined review and scoped pending-start cleanup correction are approved. The exact source passed 1,571 hermetic tests with 89.48% line coverage on Node 24.13.0/npm 11.6.2; authenticated WebSocket, CLI terminal lifecycle and late thread-start cleanup controls passed. Suspend/resume is explicitly unsupported. Actual bundled-vendor token capability, installed admission, real model/auth and native GUI acceptance remain pending in Tasks 30–31.

---
### Task 30: Live switch-on (automatic rollback pre-approved)

The one task that changes the live machine. The operator has authorized M1's execution without being in the loop and pre-approved automatic rollback. Everything below runs from the M1 worktree unless it names the installed lib, and with the T7 prefix (the rollback proof's scratch copy and every probe home go to `$TMPDIR`). Never start the interactive `codex` TUI; never `pkill -f` or `killall`; stop a process only by its pid. State this task compares against goes into `.anyengine/flip-m1/` in the worktree (git-ignored), because each command may run in a fresh shell. The executor must not run inside ChatGPT.app (Step 1 checks; `on` refuses too): quitting the app would end it. `on` runs detached and is polled (Step 9), because it can wait up to an hour for the app to go quiet, longer than one shell command may run.

What changes, all recorded in the router layer and undone by `anyengine off --router-only`: `~/.anyengine/lib/current` (→ the M1 version), `~/bin/codex` (the M1 shim, if it differs), `~/.anyengine/bin/anyengine`, `~/Library/LaunchAgents/dev.anyengine.router.plist` and `dev.anyengine.smoke.plist` (loaded), and, between the quit and the reopen, the one `~/.codex` change the COO authorised (decision D15): the top-level `model = "sonnet"` line leaves `~/.codex/config.toml` and the pick moves to `~/.codex/anyengine/app-model-pick.json`. One app restart: native fan-out is pre-proven on the staged lib before `on` (Step 7), so the app comes up on its final path; a second restart happens only if that pre-proof could not run at all (Step 11). AnyEngine's own record, written ahead of each change: `~/.anyengine/state/layers.json`, each layer's `ROLLBACK.sh`, `~/.anyengine/bin/anyengine-off`, the flip marker and lock; and the native fan-out proof, `~/.anyengine/state/proven.json`. The one fixed Claude directory, `~/.anyengine/smoke/claude-project`, appears with the pre-proof (Step 7). Created and not restored (inert while off): `~/.anyengine/config.json`, `~/.anyengine/state/`, `~/.anyengine/logs/`. Not touched: `~/.zshrc` (the M0 block is adopted as it is, decision D1), `~/.anyengine/runtime.env`, `~/.claude/settings.json`, ChatGPT.app. Written by the app's own codex while on: `~/.codex/models_cache.json` (the router's catalog, under an identity that names the router's base URL, so a terminal codex does not read it: Step 6 proves this; decision D9), cleaned by `off`.

**Files:**
- Create: `scripts/probe-terminal-codex.mjs` (the differential gate, Step 6), `docs/evidence/m1-switch-on.md`
- Modify: `CHANGELOG.md`, `scripts/AGENTS.md`
- Live (from Step 4 on): `~/.anyengine/lib/<version>/`, then the list above.

**Interfaces:**
- Consumes: everything before; in particular `npm run install:lib -- --no-activate` (Task 24), `anyengine on|off|restart|status|doctor|smoke|config` (Tasks 19 to 27), `scripts/capture-codex-wire.mjs` (Task 6), `scripts/capture-codex-spawn.mjs` (Task 12), `scripts/preflip-check.mjs` (Task 4), `mergeCatalog`/`startRouter` of the staged lib (Tasks 8, 9).
- Produces: M1 live, and `docs/evidence/m1-switch-on.md`.

- [ ] **Step 1: Start from the reviewed tip**

The whole branch has passed its final review (superpowers:subagent-driven-development, final code reviewer).

Run: `git status --porcelain && git log --oneline -1`
Expected: no output from `git status`; the tip is the reviewed commit.

Run: `p=$$; while [ "$p" -gt 1 ]; do c="$(ps -o command= -p "$p")"; case "$c" in */ChatGPT.app/*) echo "STOP: this shell runs inside ChatGPT.app: $c"; break ;; esac; p="$(ps -o ppid= -p "$p" | tr -d ' ')"; done; echo checked`
Expected: `checked` with no `STOP` line. A `STOP` means this executor is a descendant of ChatGPT.app (a thread in the app, or its codex): stop and report; the switch-on must run from a process the app's quit cannot end.

- [ ] **Step 2: Stop if an app update is staged; record the app**

Run: `mkdir -p .anyengine/flip-m1 && T7 node scripts/preflip-check.mjs --quiet-seconds 0; echo "exit $?"`
Expected: `exit 0` and the Sparkle lines `no staged update` (or `absent`) and `...-sparkle-updater: not loaded`. `exit 1` with `not quiet: ... was written Ns ago` means a turn is in flight in the app: that is not a stop (`on` waits for quiet by itself, Step 9); only a staged update is. **If it says `an app update is staged`, stop here**: do not quit the app, do not install anything; record the staged-update lines in `docs/evidence/m1-switch-on.md` under "Not switched on", commit that, and report to the COO that the switch-on waits for the update to be installed (a quit installs it) and re-verified. If it says `cannot tell`, stop and report what it names.

Run:

```bash
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/ChatGPT.app/Contents/Info.plist > .anyengine/flip-m1/app-version
readlink ~/.anyengine/lib/current > .anyengine/flip-m1/lib-before
cat .anyengine/flip-m1/app-version .anyengine/flip-m1/lib-before
/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex --version
```

Expected: `26.928.20755` (or the version the gates below are run against), the M0 lib (`0.1.0-986ab707750e` at the time of writing), `codex-cli 0.159.0`. If the app version is not the one the committed wire fixture and posture gate cover, run Step 3's capture and gates against it before going on; a new posture value means stop and map it (Task 8 of M0) first.

- [ ] **Step 3: Every gate against the installed app's codex**

Run: `T7 npm ci && T7 npm run check && T7 npm run typecheck && T7 npm test && T7 node scripts/sync-codex-compat.mjs --check && CODEX_REAL=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex T7 npm run check:posture-schema && CODEX_REAL=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex T7 npm run check:rust-protocol-fixtures && T7 node scripts/capture-codex-wire.mjs --out .anyengine/flip-m1/wire.json && diff <(python3 -m json.tool test/fixtures/codex-wire-0.159.0.json) <(python3 -m json.tool .anyengine/flip-m1/wire.json)`
Expected: every gate OK, `ℹ fail 0`, the pin lines at `0.159.0`, `Posture schema coverage OK`, the protocol fixtures matching, `capture-codex-wire: 0.159.0 ok`, and no diff. A diff is not a failure by itself; a missing contract field is (the capture exits 1).

Run: `T7 node scripts/capture-codex-spawn.mjs --out .anyengine/flip-m1/spawn.json && diff <(python3 -m json.tool test/fixtures/codex-spawn-0.159.0.json) <(python3 -m json.tool .anyengine/flip-m1/spawn.json)`
Expected: `capture-codex-spawn: 0.159.0 ok`, and no diff in the notifications that link the child (the claim design, decision D2, rests on them; Task 12). If Task 12 committed only the 0.155 fallback (the fake login was not offered the tools), the script exits 1 again with the same reason: record it; the native fan-out pre-proof (Step 7) is then the only proof, and its failure moves the router to the bridge path (H1). A diff in the link itself: stop and report.

Run: `T7 node scripts/probe-claude-exec.mjs --project "$TASK_STORAGE/claude-project"`
Expected: `exec-called`, exit 0 (Task 3; one tiny Claude turn, isolated homes, the same fixed Claude project directory as Task 3's run).

- [ ] **Step 4: Install the lib, staged**

Run: `T7 npm run install:lib -- --no-activate | tee .anyengine/flip-m1/install.log && sed -n 's/^install-lib: staged .*\/\([^/ ]*\) (current unchanged)$/\1/p' .anyengine/flip-m1/install.log > .anyengine/flip-m1/version && cat .anyengine/flip-m1/version && test "$(readlink ~/.anyengine/lib/current)" = "$(cat .anyengine/flip-m1/lib-before)" && echo current-unchanged`
Expected: `install-lib: staged <HOME>/.anyengine/lib/0.1.0-<12 hex> (current unchanged)`, the version on its own line, `current-unchanged`. Nothing reads the staged lib yet. Undo of this step alone: remove that one version directory.

Run: `T7 node ~/.anyengine/lib/"$(cat .anyengine/flip-m1/version)"/scripts/lib-verify.mjs ~/.anyengine/lib/"$(cat .anyengine/flip-m1/version)"`
Expected: `lib-verify: ... ok`.

- [ ] **Step 5: Headless wiring probe of the staged lib (zero spend, isolated)**

This starts the staged lib's router and the staged shim exactly as the app would start them, with every home isolated: a throwaway `ANYENGINE_ROOT` (so a different router port and claim directory), a throwaway `CODEX_HOME` (no login, so nothing reaches OpenAI), and the app's own argv.

Run (one shell):

```bash
V="$(cat .anyengine/flip-m1/version)"; L="$HOME/.anyengine/lib/$V"
P="$(mktemp -d "$TMPDIR/m1-probe.XXXXXX")"
mkdir -p "$P/root" "$P/codex"
printf '{"router":{"port":18899}}\n' > "$P/root/config.json"
# The shim sources runtime.env after the probe's environment: give it a copy
# that names the staged adapter, and stop if it would name a home of its own.
sed -e "s|^export ANYENGINE_ADAPTER=.*|export ANYENGINE_ADAPTER=\"$L/dist/src/adapter.mjs\"|" "$HOME/.anyengine/runtime.env" > "$P/runtime.env"
if grep -nE '^[[:space:]]*(export[[:space:]]+)?(CODEX_HOME|ANYENGINE_HOME|ANYENGINE_DEBUG_LOG|ANYENGINE_ROOT)=' "$P/runtime.env"; then echo "STOP: runtime.env names a home"; exit 1; fi
# Native fan-out proven in this throwaway root only, keyed exactly as the
# probe's router and adapter will compute it (Task 9), so the probe sees the
# native wiring (H1: an unproven root is served the bridge).
node --input-type=module -e "const m = await import('$L/dist/src/degraded.mjs'); m.markProven('$P/root', 'native-fanout', 'staged-lib probe', m.proofKey('$P/root'))"
ANYENGINE_ROOT="$P/root" node "$L/dist/src/adapter.mjs" router > "$P/router.out" 2>&1 & RPID=$!
for _ in $(seq 1 50); do curl -sf http://127.0.0.1:18899/health >/dev/null && break; sleep 0.2; done
curl -s http://127.0.0.1:18899/health; echo
ANYENGINE_ROOT="$P/root" CODEX_HOME="$P/codex" ANYENGINE_HOME="$P/adapter" ANYENGINE_DEBUG_LOG="$P/debug.jsonl" \
  ANYENGINE_RUNTIME_ENV="$P/runtime.env" ANYENGINE_ADAPTER="$L/dist/src/adapter.mjs" node --input-type=module - <<'EOF'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
const shim = `${process.env.HOME}/.anyengine/lib/${process.env.ANYENGINE_ADAPTER.split('/lib/')[1].split('/')[0]}/scripts/codex-shim`
const argv = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled']
const child = spawn(shim, argv, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
const pending = new Map()
readline.createInterface({ input: child.stdout }).on('line', (line) => { const m = JSON.parse(line); pending.get(m.id)?.(m) })
const request = (id, method, params) => new Promise((ok) => { pending.set(id, ok); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`) })
const timer = setTimeout(() => { console.log('probe: timed out'); child.kill('SIGKILL'); process.exit(1) }, 60_000)
const init = await request(1, 'initialize', { clientInfo: { name: 'm1-probe', version: '0' } })
console.log(`probe: userAgent ${init.result?.userAgent}`)
const servers = await request(2, 'mcpServerStatus/list', {})
console.log(`probe: mcp servers ${JSON.stringify((servers.result?.data ?? []).map((e) => e.name))}`)
const models = await request(3, 'model/list', { includeHidden: true, limit: 100 })
console.log(`probe: models ${JSON.stringify((models.result?.data ?? []).map((m) => m.id))}`)
clearTimeout(timer); child.kill('SIGTERM'); process.exit(0)
EOF
sleep 1
grep -E '"event":"(router\.link|codex\.upstream\.spawn|claim\.listen)"' "$P/debug.jsonl" | cut -c1-300
ls "$P/root/run"
kill "$RPID"; wait "$RPID" 2>/dev/null
case "$P" in "$TMPDIR"/?*) find "$P" -depth -delete ;; *) echo "not removing $P" ;; esac
```

Expected:
- `/health` prints `"ok":true` with `"fanout":{"path":"native",...}` and the staged version;
- `probe: userAgent` naming `0.159.0`;
- `probe: mcp servers` **without** `"anyengine"` (native path, decision D5);
- `probe: models` listing the GPT ids and `opus`, `sonnet`, `haiku` (the adapter's own entries: the router cannot fetch the upstream catalog without a login, so it answers 503 and codex keeps its bundled list);
- a `router.link` line with `"attached":true`, `"fanout":"native"` and `"url":"http://127.0.0.1:18899/backend-api/codex"`; a `codex.upstream.spawn` line whose `binary` is `.../codex-cli/CodexCLI.app/Contents/MacOS/codex` and whose `args` contain `openai_base_url="http://127.0.0.1:18899/backend-api/codex"`; a `claim.listen` line;
- `ls` shows one `claim-<pid>.sock` (gone after the shim exits is fine; it may already be removed).

Any difference: stop, record it, and report; nothing live has changed yet (the staged lib directory is inert).

- [ ] **Step 6: The differential gate: the router changes nothing for terminal codex (zero spend)**

Decision D9, proven on this Mac before anything live changes. The review found the mechanism: codex's models cache carries an identity that includes the resolved base URL (and the client version), so a cache the router's catalog wrote should be ignored by any codex that talks to chatgpt.com, and by another codex version. This step checks that, and that the router alters no model a terminal codex sends, against the staged lib's real catalog merge.

Create `scripts/probe-terminal-codex.mjs` (`node scripts/probe-terminal-codex.mjs --lib <lib> [--codex <path>] [--old-codex <path>] [--config-from <config.toml>] [--cache-from <models_cache.json>]`). With `--cache-from`, the checks after `write` use a copy of that cache instead of the one `write` produced (Task 31 runs it against the live shared cache); the file is only read. It makes `mktemp -d "$TMPDIR/term.XXXXXX"` and removes it at the end, and every codex it runs is under `sandbox-exec -p '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))'` with an isolated `CODEX_HOME`, `-c 'mcp_servers={}'` and `-c notify=[]`, logged in with Task 12's fake ChatGPT login (`writeFakeChatgptAuth` from `scripts/lib/fake-chatgpt-auth.mjs`; with an API key, codex neither fetches `/models` nor reads the models cache, so an API-key login would prove nothing), and with `-c chatgpt_base_url=<B>/backend-api/` so nothing ChatGPT-side leaves for chatgpt.com either. It starts two loopback fake backends, A and B (each serves `GET /backend-api/codex/models` a GPT-only catalog in the entry shape of Task 6's fixture, headed by `gpt-6.1-sol` at priority 1, answers `POST .../responses` with a PONG stream, recording the request body's `model`, and answers anything else under `/backend-api/` with a recorded 404), and the staged lib's router in-process (`startRouter` from `<lib>/dist/src/router-server.mjs` with its daemon hooks, a temporary `ANYENGINE_ROOT` whose config has `router.multiAgentV1: true`, upstream = A, and a native fan-out proof seeded there with the staged lib's `markProven(root, 'native-fanout', 'differential gate', proofKey(root))`, without which the router serves no Claude entry). Then, printing `ok`/`FAIL` per line:

1. `write`: the bundled codex (`--codex`, default the app's), `app-server` with `-c openai_base_url=<router>`: `initialize`, `model/list`; `models_cache.json` appears in the home with the AnyEngine entries (`opus`, `sonnet`, `haiku`). Record its `client_version` and identity fields in the output. (Without Claude entries here the gate proves nothing: `FAIL`.)
2. `P2c`: the same codex and home, the default base URL (chatgpt.com, unreachable under the sandbox), `model/list`: no AnyEngine entry. And with `-c openai_base_url=<B>`: no AnyEngine entry, and B saw a `/models` request.
3. `P2d`: `--old-codex` (a 0.154 build; on this Mac the npm-global one under `~/.nvm`, `codex --version` says `codex-cli 0.154.0`) in the same home, default base URL: no AnyEngine entry. Without `--old-codex` the line is `skipped` and the exit code is 2.
4. `P3a`: `codex exec --skip-git-repo-check -m gpt-6.1-sol 'Reply PONG'` with `-c openai_base_url=<router>` and again with `<B>`: A (through the router) and B each saw exactly `gpt-6.1-sol`.
5. `P4a`: `codex exec --skip-git-repo-check 'Reply PONG'` with no `-m`, base URL B, once with the router-written cache in the home and once with it removed: B saw the same model both times, a GPT id. With `--config-from <file>`, the home's `config.toml` is a copy of that file for this check (read, never written).
6. `M7`: `codex exec --skip-git-repo-check 'Reply PONG'` with no `-m` and `-c openai_base_url=<router>`: A (through the router) saw `gpt-6.1-sol`. With the router's catalog in front of it, a real codex still defaults to the upstream's first GPT entry: the Claude entries do not take the default (Task 9's ordering, checked on real codex).

With `--cache-from`, when the copied cache holds no AnyEngine entry, `P2c`, `P2d` and `P4a` print `not exercised (the cache has no AnyEngine entry)` instead of `ok`: nothing in it could leak, so the gate proves nothing about it.

Exit 0 when every line is `ok`. Add it to `scripts/AGENTS.md`.

Run: `V="$(cat .anyengine/flip-m1/version)" && T7 node scripts/probe-terminal-codex.mjs --lib ~/.anyengine/lib/"$V" --old-codex "$(ls ~/.nvm/versions/node/*/bin/codex | head -1)" | tee .anyengine/flip-m1/terminal.txt; echo "exit ${PIPESTATUS[0]}"`
Expected: `write`, `P2c`, `P2d`, `P3a`, `P4a`, `M7` all `ok`, `exit 0`. Any `FAIL`: stop and report; the identity mechanism is not what the review found, and decision D9 needs a new answer before the router goes live. (If the npm-global codex is gone, install `@openai/codex@0.154.0` with `npm install --prefix "$TMPDIR/codex-0154"` under the T7 prefix and pass its `bin/codex`.)

Run: `T7 node scripts/probe-terminal-codex.mjs --lib ~/.anyengine/lib/"$(cat .anyengine/flip-m1/version)" --old-codex "$(ls ~/.nvm/versions/node/*/bin/codex | head -1)" --config-from ~/.codex/config.toml | grep P4a`
Expected: `P4a ... FAIL`, the model B saw being `sonnet`: today's `config.toml` line leaks into terminal codex. This is the "before" of decision D15; Step 12 repeats it after the switch-on and expects `ok`.

- [ ] **Step 7: Pre-prove native fan-out on the staged lib (PONG-sized)**

So that `on` restarts the app once, onto its final path, native fan-out is proven on the staged lib before anything live changes: a private router of the staged lib's code on a free port, a probe adapter of the staged lib, the real `~/.codex` (decision D7; the threads are deleted), Claude in the one fixed project directory. Nothing else of the live state changes (`--out`: no `smoke.json`, no degraded or proven mark).

Run: `V="$(cat .anyengine/flip-m1/version)" && ( set -a; . ~/.anyengine/runtime.env; set +a; T7 node ~/.anyengine/lib/"$V"/dist/src/adapter.mjs smoke --lib "$V" --paths native-fanout --out "$PWD/.anyengine/flip-m1/native-proof.json" ); echo "exit $?"; python3 -c "import json;d=json.load(open('.anyengine/flip-m1/native-proof.json'));print(d['paths']['native-fanout'], d['key'])"`
Expected: `native-fanout` `ok: true` with its detail (`collabAgentToolCall` for `haiku`, `claim.done`, PONG), and a key naming the staged version, `26.928.20755`, `0.159.0` and the settings hash. A result with `ok: false` is not a stop: `on --native-proof` then starts with `router.multiAgentV1 false` (the bridge carries fan-out) and the smoke's detail goes to the COO as the M1 open item (native `spawn_agent` onto Claude does not work on 0.159 as recorded, Task 12). If the command could not run at all (it crashed, or wrote no file), record why and switch on without `--native-proof` in Step 9; Step 11 is then the fallback.

- [ ] **Step 8: Dry run: the plan and the rollback proof**

Run: `V="$(cat .anyengine/flip-m1/version)" && T7 node ~/.anyengine/lib/"$V"/dist/src/adapter.mjs on --lib "$V" --dry-run --foreground | tee .anyengine/flip-m1/dry-run.txt`
Expected: `adapter layer: adopted from <HOME>/.anyengine/rollback-20260930T114234Z`; planned writes exactly: `~/.anyengine/lib/current`, `~/bin/codex` (only if the M1 shim differs from the live one), `~/.anyengine/bin/anyengine`, `~/Library/LaunchAgents/dev.anyengine.router.plist`, `~/Library/LaunchAgents/dev.anyengine.smoke.plist`, and between quit and reopen `~/.codex/anyengine/app-model-pick.json` and `~/.codex/config.toml` (remove line 1: `model = "sonnet"`); `~/.zshrc` **not** listed; `proof bash anyengine-off: ok`, `proof node off: ok`, `proof bash anyengine-off --router-only: ok`, `proof: scratch removed`; exit 0. Anything else planned (the rc above all, or any other `~/.codex` line): stop and report.

- [ ] **Step 9: Switch on (detached, polled)**

Run: `V="$(cat .anyengine/flip-m1/version)" && T7 node ~/.anyengine/lib/"$V"/dist/src/adapter.mjs on --lib "$V" --yes --auto-rollback --wait-quiet 60 --native-proof "$PWD/.anyengine/flip-m1/native-proof.json" --no-follow | tee .anyengine/flip-m1/on-start.txt` (without `--native-proof` if Step 7 could not run)
Expected: `flip <id> started (pid N); progress: <HOME>/.anyengine/state/flip-<id>.log; anyengine status shows it`. The flip now runs on its own; this shell may end.

Poll, every two minutes, until the log's last line is `flip <id> exit <code>`: `L="$(sed -n 's/.*progress: \([^;]*\);.*/\1/p' .anyengine/flip-m1/on-start.txt)"; tail -n 5 "$L"; ~/.anyengine/lib/"$(cat .anyengine/flip-m1/version)"/scripts/anyengine-launch status | grep -E '^(flip|anyengine) '`
Expected while it runs: the log advancing through the phases (preflight, quiet wait, prove, files with `native fan-out proof written` or `starting with router.multiAgentV1 false: <why>`, pre-quit, quit, between, open, postflight) and `flip  on in progress (phase ...)`. At the end: `cp "$L" .anyengine/flip-m1/on.txt`; the last line `flip <id> exit 0`, after every postflight line `ok` (`app version`, `handshake`, `adapter process`, `GPT child`, `router attached`, `foreign codex`, `router health`, `claim socket`, `doctor`, `smoke` for gpt, claude-agent and bridge).

If it waited 60 minutes and never went quiet: `exit 1`, nothing changed; record and report (the operator is using the app; retry later).
If it stopped on a staged update (before any write, or right before the quit with its files undone): nothing is left changed; go to Step 2's stop.
If any postflight check failed: it has already rolled back (to the adapter layer, or to the app's own codex if that failed too) and logged each stage's checks. Record everything from `on.txt` in the evidence under "Rolled back", commit it, and report to the COO; do not retry without a fix.
If `status` shows `flip on interrupted` (the runner died): run `~/.anyengine/bin/anyengine on --lib "$V" --yes --no-follow` once; it resumes (back to the last good state, the app running) and exits 1 with `resumed an interrupted on`; record it and report.

- [ ] **Step 10: Independent checks after the switch**

These repeat, from outside the command, what it claimed.

Run: `~/.anyengine/bin/anyengine status | tee .anyengine/flip-m1/status.txt`
Expected: `layers: adapter, router`; `flip none`; the app at the version in `.anyengine/flip-m1/app-version` (verified); one adapter from the M1 version with `codex child running, router attached (native)` and `fan-out native (catalog marked v1)` when the pre-proof passed, or `router attached (bridge)` and `fan-out bridge (router.multiAgentV1 is false)` when it failed; the router `loaded, healthy`; `mode codex-claude: agent`; `degraded none`.

Run: `~/.anyengine/bin/anyengine doctor; echo "exit $?"`
Expected: no `fail` line, `exit 0`; `shared config model` ok (the line is gone); `fan-out path` ok with the proof's time and key, or warning that `router.multiAgentV1` is false after a failed pre-proof. Other `warn` lines are recorded.

Run: `grep -nE '^[[:space:]]*(model|review_model)[[:space:]]*=' ~/.codex/config.toml; cat ~/.codex/anyengine/app-model-pick.json; diff <(grep -vxF 'model = "sonnet"' "$(ls -d ~/.anyengine/rollback-*-router | tail -1)"/config.toml.bak) ~/.codex/config.toml && echo only-that-line`
Expected: no top-level non-GPT `model` line printed (a profile line, if any, is still there and was never touched); `{"model": "sonnet"}`; `only-that-line` (the backup minus the one line is exactly today's file, unless the app wrote other keys since, which `diff` then shows and the evidence records).

Run: `~/.anyengine/bin/anyengine smoke --paths router,gpt,claude-agent,bridge,claude-model --notify; echo "exit $?"; cat ~/.anyengine/state/smoke.json`
Expected: `router`, `gpt`, `claude-agent` and `bridge` `ok: true`; `claude-model` `null` (mode is agent). `gpt`, `claude-agent` or `bridge` failing is a rollback: run `~/.anyengine/bin/anyengine off --router-only --yes --wait-quiet 30 --no-follow` and poll it as in Step 9 (and, if its checks fail, `~/.anyengine/bin/anyengine off --yes --no-follow`), record, and report.

Run: `python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.codex/models_cache.json')));print(d.get('client_version'), {k: v for k, v in d.items() if k not in ('models',)}, [m['slug'] for m in d['models'] if 'via AnyEngine' in (m.get('description') or '')])"`
Expected: after the app's first catalog fetch, the client version, an identity that names the router's base URL, and `['opus', 'sonnet', 'haiku']`. Step 6 showed a terminal codex ignores such a cache. Another version may have rewritten it in between; then note what is there.

- [ ] **Step 11: Only if the pre-proof could not run: prove native fan-out now, or turn it off, with one more restart (H1)**

Skip this step when Step 7 wrote a result (pass or fail): the app already runs on its final path. Otherwise the router came up without a proof, so it serves the bridge path, and this is the fallback:

Run: `~/.anyengine/bin/anyengine smoke --paths native-fanout --notify; echo "exit $?"; python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.anyengine/state/smoke.json')))['paths']['native-fanout'])"`

- Pass (`ok: true`): native fan-out is now proven (`~/.anyengine/state/proven.json`). Run `~/.anyengine/bin/anyengine restart --yes --no-follow` and poll it as in Step 9 to `exit 0`, so the app's adapter links again and takes the native path: the GPT child loses the `anyengine` server and the bridge line (decision D5). Then `~/.anyengine/bin/anyengine status | grep adapter` shows `router attached (native)`.
- Fail: native fan-out is marked degraded, and the router already serves the bridge path. Make it explicit and stable: `~/.anyengine/bin/anyengine config set router.multiAgentV1 false`, then `~/.anyengine/bin/anyengine restart --yes --no-follow`, polled to `exit 0` (the restart cleans the models cache between quit and reopen, so the app refetches a catalog without Claude entries). `status` shows `fan-out bridge (router.multiAgentV1 is false)` and the adapter `router attached (bridge)`: GPT keeps the `anyengine` server and its one bridge line, which is how it reaches Claude now. Record the smoke's detail and report it to the COO as the M1 open item: native `spawn_agent` onto Claude does not work on 0.159 as recorded (Task 12), and the bridge carries fan-out until it is fixed. This is not a rollback reason.

- [ ] **Step 12: Both directions of the shared config (decision D15)**

Run: `T7 node scripts/probe-terminal-codex.mjs --lib ~/.anyengine/lib/"$(cat .anyengine/flip-m1/version)" --old-codex "$(ls ~/.nvm/versions/node/*/bin/codex | head -1)" --config-from ~/.codex/config.toml | grep P4a`
Expected: `P4a ... ok`: with today's `config.toml`, a terminal codex with no `-m` sends a GPT id (Step 6 showed `sonnet` before).

The app's side: the app's model picker still shows the Claude pick (Claude Sonnet) after the restart. **GUI-only**: record it for Task 31's operator check; headless, `~/.anyengine/bin/anyengine doctor | grep 'shared config model'` names the pick file with `sonnet`.

- [ ] **Step 13: Record the evidence**

Create `docs/evidence/m1-switch-on.md` in the style of `docs/evidence/m0-flip.md` (no personal names or paths; write `~`): date and time range (UTC), app and codex versions, the M1 build and lib version, what changed (a table: file, before, after), the rollback (`~/.anyengine/rollback-<stamp>-router/`, `~/.anyengine/bin/anyengine-off`), the checks before (descendant check, preflip, gates, wire and spawn captures, exec probe, staged-lib probe, the differential gate, the native fan-out pre-proof, dry run and rollback proof), the `on` log, the independent checks, the smoke results, the native fan-out outcome (and, only if the pre-proof could not run, the second restart), the `config.toml` line removed and the pick moved (both directions), the models-cache state, and open items. Add to `CHANGELOG.md` under `### M1: Codex router`: "**Live.** ChatGPT.app's adapter runs M1 with the router attached; record and rollback: `docs/evidence/m1-switch-on.md`."

```bash
git add scripts/probe-terminal-codex.mjs scripts/AGENTS.md docs/evidence/m1-switch-on.md CHANGELOG.md
git commit -m "docs: record the M1 switch-on, its checks and its rollback"
```

Keep `.anyengine/flip-m1/` until Task 31 is recorded, then remove it.

**Acceptance:** the differential gate passed before the switch; `on` exited 0 with every postflight check `ok`; `status` and `doctor` agree; the smoke's gpt, claude-agent and bridge paths pass; the app restarted once and came up on its final path: native fan-out proven by the pre-proof and in use, or turned off with the bridge carrying fan-out (a second restart only if the pre-proof could not run); `config.toml` lost exactly the one line, a terminal codex with no `-m` sends a GPT id, and the app keeps its pick; the evidence file names the rollback.

---
### Task 31: Live acceptance (spec 9, M1, plus the Codex CLI host)

Spec 9, M1 acceptance: "The app picker lists Claude. A GPT to Claude switch works mid-thread. "spawn 7 sub-agents, 3 on Opus" runs natively. With v1 disabled, the same prompt uses the bridge. `off` leaves no Claude entries in the cache." Plus, from the COO's scope: the Codex CLI → Claude host, and how a terminal `codex` behaves while the router is on (decision D9). Each item has a headless check the agent runs (the installed lib, the real `~/.codex`, the live router: the same wiring as the app's adapter) and, where only the app can show it, a GUI check listed for the operator. Spend stays small: PONG-sized turns, except the seven-agent run, whose tasks are one sentence about a two-file folder.

**Files:**
- Create: `docs/evidence/m1-acceptance.md`, `scripts/probe-acceptance.mjs`
- Modify: `CHANGELOG.md`, `docs/STATUS.md`

**Interfaces:**
- Consumes: `smoke-client.mts` (`AppServerClient`), `anyengine` CLI, `scripts/probe-remote-headless.mjs` (Task 29), `scripts/probe-terminal-codex.mjs` (Task 30). Every command runs with the T7 prefix; `on`, `off` and `restart` run detached with `--no-follow` and are polled as in Task 30 Step 9.
- Produces: `node scripts/probe-acceptance.mjs <check>` for `picker`, `switch`, `fanout7`, `bridge-fanout`, run against the installed lib; each prints its evidence lines and exits 0 on a pass.

- [ ] **Step 1: Write the acceptance probe**

Create `scripts/probe-acceptance.mjs`. It imports `AppServerClient` from `~/.anyengine/lib/current/dist/src/smoke-client.mjs` (resolved), launches the installed adapter (`app-server -c 'mcp_servers={}' -c notify=[]`) with the real `CODEX_HOME`, an isolated `ANYENGINE_HOME` and `ANYENGINE_DEBUG_LOG` in a `mktemp -d "$TMPDIR/accept.XXXXXX"` directory, and the default `ANYENGINE_ROOT` (the live router and claim directory), runs one check, deletes every thread it persisted, stops the adapter and removes its directory. Every thread it starts uses `cwd: ~/.anyengine/smoke/claude-project`, the one fixed Claude directory (so Claude Code adds no new `~/.claude.json` entry; the probe never touches that file):

- `picker`: `model/list`; passes when `opus`, `sonnet` and `haiku` are listed and at least one of them came from the router (the adapter's debug log has `router.link` attached, and the router log `~/.anyengine/logs/router.jsonl` has a `models.served` line after the probe started with `claude: 3`).
- `switch`: an ephemeral GPT thread answers PONG; `turn/start` on the same thread with `model: "opus"` answers PONG; the adapter's debug log shows `thread.rehome` events for that thread (agent mode moves it to the adapter's Claude, as M0's A5 evidence did); then `thread/settings/update` back to the GPT model and a third PONG.
- `fanout7`: writes `README.md` ("A tiny repository for the AnyEngine acceptance run.") and `main.txt` ("print('hello')") into the fixed project directory (refusing if either name already exists there) and removes those two files, by name, when the check ends; starts a persisted GPT thread there (default GPT model, `workspace-write`, `on-request`), and sends: `Use spawn_agent to start 7 sub-agents: 3 with model "opus" and 4 with your default model. Each one reads README.md in this folder and replies with one sentence about it. Wait for all 7, then list each agent's model and its sentence.` Passes when 7 `collabAgentToolCall` spawn items completed, 3 of them name `opus`, the adapter's debug log has 3 `claim.done` events with `success: true` for those children (the Opus children ran on the adapter's Claude, on the operator's own Claude login), and the parent's final message has 7 entries. Codex may run the children in batches if its per-session agent limit is below 7 (decision D12); that still passes.
- `bridge-fanout`: the same persisted-thread setup with `Spawn 2 sub-agents: 1 on Opus and 1 on your default model. Each replies with exactly the word PONG. Report both answers.`; passes when the adapter's debug log has a `bridge.spawnSubagent` event for a Claude model and no `claim.done` (the bridge, not native spawn), and the answer has two PONGs.

- [ ] **Step 2: The picker lists Claude**

Run: `T7 node scripts/probe-acceptance.mjs picker`
Expected: the model ids, `router attached`, `models.served ... claude: 3`, exit 0.

GUI (operator): open the model picker in a new ChatGPT.app thread: "Claude Opus", "Claude Sonnet", "Claude Haiku" are listed next to the GPT models (a screenshot for the evidence).

- [ ] **Step 3: A GPT to Claude switch works mid-thread**

Run: `T7 node scripts/probe-acceptance.mjs switch`
Expected: three PONGs (GPT, Claude, GPT), the `thread.rehome` lines, exit 0.

GUI (operator): in one app thread, ask the GPT model for PONG, switch the picker to Claude Opus, ask again, switch back.

- [ ] **Step 4: "spawn 7 sub-agents, 3 on Opus" runs natively**

Run: `T7 node scripts/probe-acceptance.mjs fanout7`
Expected: 7 spawns (3 `opus`), 3 `claim.done` successes, the parent's list, exit 0. A failure here is the M1 finding that matters most: record every line (the collab items, the claim events, the router log lines for those children) and report it; do not roll back for it: a failing `native-fanout` smoke moves the router to the bridge path (H1), which Step 5 checks. If Task 30 (its pre-proof, Step 7, or its fallback, Step 11) turned native fan-out off, this step is recorded under "Open" with that step's evidence and not run.

GUI (operator): the success test itself in the app: `spawn 7 sub-agents, 3 on Opus, review this repo` in a GPT thread of a small repository; the three Opus children show as sub-agents and their results come back to the parent. (The success test's rotation clause is M3.)

- [ ] **Step 5: With v1 disabled, the same prompt uses the bridge**

Run:

```bash
~/.anyengine/bin/anyengine config set router.multiAgentV1 false
curl -s http://127.0.0.1:18790/health | python3 -c 'import json,sys;print(json.load(sys.stdin)["fanout"])'
~/.anyengine/bin/anyengine cache clean
T7 node scripts/probe-acceptance.mjs bridge-fanout; echo "exit $?"
~/.anyengine/bin/anyengine config set router.multiAgentV1 true
~/.anyengine/bin/anyengine cache clean
curl -s http://127.0.0.1:18790/health | python3 -c 'import json,sys;print(json.load(sys.stdin)["fanout"])'
```

Expected: the fan-out path `bridge` with reason `router.multiAgentV1 is false`; `cache clean` removes the cached v1 catalog so the probe's fresh codex child fetches the bridge-path catalog; the probe passes (`bridge.spawnSubagent` for Claude, no claim, two PONGs), exit 0. The app's own adapter keeps the path it was spawned with throughout; for the minutes this step takes, a Claude `spawn_agent` in the app may fail validation after its catalog refreshes, which is why the setting goes back at once. (If Task 30 left `router.multiAgentV1` false, skip the two `config set` lines: the bridge is already the path.)

The toggle leaves the router's fan-out evidence from the minutes it served the bridge catalog. The proof itself holds again (it is keyed on the settings, and they are back to what it was earned under, Task 9), but the evidence should not linger: restart the router clean (M5). A restart of the router cuts every stream it relays, so first wait until the app is quiet and nothing is in flight:

```bash
L="$(cd ~/.anyengine/lib/current && pwd -P)"
for _ in $(seq 1 60); do T7 node "$L/scripts/preflip-check.mjs" --quiet-seconds 120 >/dev/null 2>&1 && break; sleep 30; done
for _ in $(seq 1 120); do
  curl -s http://127.0.0.1:18790/health | python3 -c 'import json,sys;f=json.load(sys.stdin)["inflight"];sys.exit(0 if f["gpt"]==0 and f["claude"]==0 else 1)' && break
  sleep 5
done
curl -s http://127.0.0.1:18790/health | python3 -c 'import json,sys;print(json.load(sys.stdin)["inflight"])'
launchctl kickstart -k "gui/$(id -u)/dev.anyengine.router"
for _ in $(seq 1 25); do curl -sf http://127.0.0.1:18790/health >/dev/null && break; sleep 0.2; done
~/.anyengine/bin/anyengine smoke --paths native-fanout; echo "exit $?"
curl -s http://127.0.0.1:18790/health | python3 -c 'import json,sys;print(json.load(sys.stdin)["fanout"])'
```

Expected: `{'gpt': 0, 'claude': 0}` printed before the restart (if the loops ran out while the app stayed busy or a stream stayed open, do not restart: record it and try later); the router back (a new pid in `/health`), the `native-fanout` smoke `ok` (a fresh proof), and the path `native`. A failing smoke here moves the router to the bridge path; record it under "Open".

- [ ] **Step 6: `off` leaves no Claude entries in the cache, puts the shared config back, and `on` comes back**

Run first (the shared config as it is right before the `off`; the app may have changed it since the switch-on): `cp ~/.codex/config.toml .anyengine/flip-m1/config.before-off; cat ~/.codex/anyengine/app-model-pick.json > .anyengine/flip-m1/pick.before-off 2>/dev/null; true`

Run: `T7 ~/.anyengine/bin/anyengine off --router-only --yes --wait-quiet 60 --no-follow`, then poll its log as in Task 30 Step 9 until `flip <id> exit <code>`.
Expected: every restore `restored` or `already`, the models cache moved aside between the quit and the reopen, the app restarted, the `adapter` postflight checks `ok` (the M0 lib, the GPT child from the bundled codex without `openai_base_url`, no router answering), the `models cache` check `ok` (no AnyEngine entry after the app's first catalog fetch), `exit 0`.

Run (compare line by line, not byte for byte: the app rewrites this file whenever a setting changes):

```bash
python3 - <<'PY'
import json, os, re
before = open('.anyengine/flip-m1/config.before-off').read().split('\n')
after = open(os.path.expanduser('~/.codex/config.toml')).read().split('\n')
top = lambda lines: [re.match(r'\s*([A-Za-z0-9_-]+)\s*=', l).group(1) for l in lines[: next((i for i, l in enumerate(lines) if re.match(r'\s*\[', l)), len(lines))] if re.match(r'\s*[A-Za-z0-9_-]+\s*=', l)]
try:
    pick = json.load(open('.anyengine/flip-m1/pick.before-off')).get('model')
except Exception:
    pick = None
print('added:', [l for l in after if l not in before])
print('removed:', [l for l in before if l not in after])
print('duplicate top-level keys:', sorted({k for k in top(after) if top(after).count(k) > 1}))
print('pick before off:', pick, '| pick file now:', os.path.exists(os.path.expanduser('~/.codex/anyengine/app-model-pick.json')))
PY
```

Expected: `added: ['model = "<pick>"']` with the pick from before the `off` (`sonnet` unless the operator picked another Claude model meanwhile), or `added: []` when the file already had a top-level `model` key (a GPT pick made while M1 was on is kept); `removed: []`; no duplicate top-level key; the pick file gone. Any other difference: record it; it means the restore touched more than its one line.

Run: `python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.codex/models_cache.json')));print(d['client_version'], [m['slug'] for m in d['models'] if 'via AnyEngine' in (m.get('description') or '')])"`
Expected: a `client_version` and `[]`.

Run: `V="$(cat .anyengine/flip-m1/version)" && T7 node ~/.anyengine/lib/"$V"/dist/src/adapter.mjs on --lib "$V" --yes --auto-rollback --wait-quiet 60 --no-follow`, then poll as in Task 30 Step 9.
Expected: as in Task 30 Step 9, every postflight line `ok`, `exit 0`: M1 is on again; `grep -c '^model = "sonnet"' ~/.codex/config.toml` prints `0` and the pick file holds `sonnet` again (or whatever non-GPT pick the file had; a GPT line is not removed). Native fan-out stays proven from Step 5 (a new `on` of the same version changes no setting), so the adapter links native again.

- [ ] **Step 7: Codex CLI → Claude**

Run: `T7 node ~/.anyengine/lib/current/scripts/probe-remote-headless.mjs`
Expected: `ok` for `initialize`, `model/list lists Claude`, `GPT PONG`, `Claude PONG` and, when native fan-out is in use, `native spawn claimed`; exit 0.

GUI/TTY (operator): in a terminal, `~/.anyengine/bin/anyengine codex`; pick Claude Haiku in the TUI's model picker; ask for PONG; `/exit`. The adapter stops with the TUI.

- [ ] **Step 8: A terminal `codex` while the router is on (decision D9)**

Task 30 Step 6 proved the mechanism against a cache the staged router wrote. This repeats it against the live shared cache the app's codex wrote while M1 was on, and the live `config.toml`, with zero spend (isolated homes, outbound traffic denied, fake backends).

Run: `T="$(zsh -lc 'command -v codex')"; echo "terminal codex: ${T/#$HOME/~}"; "$T" --version; T7 node scripts/probe-terminal-codex.mjs --lib ~/.anyengine/lib/current --codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex --old-codex "$(ls ~/.nvm/versions/node/*/bin/codex | head -1)" --cache-from ~/.codex/models_cache.json --config-from ~/.codex/config.toml; echo "exit $?"`
Expected: the terminal codex's path and version (recorded: whichever it is, the bundled 0.159 and the 0.154 below cover both kinds), then `P2c`, `P2d`, `P3a`, `P4a` and `M7` all `ok`, exit 0: a codex of the app's version and a 0.154 both list no Claude entry from the shared cache, `-m` is sent exactly as given, with no `-m` a GPT id goes out, and the router's catalog does not take the default. When the live cache holds no AnyEngine entry at that moment (another codex rewrote it), `P2c`, `P2d` and `P4a` say `not exercised`: record that, and rerun after the app's next catalog fetch. `anyengine doctor`'s `terminal codex and the router` and `shared config model` lines are `ok`.

- [ ] **Step 9: The nightly job, storage and the update gate**

Run: `launchctl print gui/$(id -u)/dev.anyengine.smoke | grep -E 'state|path|StartCalendarInterval|Hour|Minute|WatchPaths' | head -12; ~/.anyengine/bin/anyengine smoke --scheduled --notify; echo "exit $?"; cat ~/.anyengine/state/smoke.json; cat ~/.anyengine/state/update-watch.json 2>/dev/null; ls -la ~/.anyengine/logs`
Expected: the job loaded with 03:30 and the two watch paths; a scheduled run that verifies the current app version once (it has no `known-good.json` yet) and writes `known-good.json`; every smoke path `ok` except `claude-model`, which is `null` in agent mode; the logs directory holding `router.jsonl`, `router.launchd.log`, `smoke.jsonl` and nothing over its bound; no `smoke/run-*` directory left behind.

Run: `~/.anyengine/bin/anyengine doctor | grep -E 'storage|update hold|app update'`
Expected: `storage` ok with the sizes; `update hold` ok (`no reliable hold ... dev.anyengine.smoke loaded`); `app update` ok (none staged).

- [ ] **Step 10: Record the evidence**

Create `docs/evidence/m1-acceptance.md` (no personal names or paths): one section per spec 9 item and per extra item (Codex CLI, terminal codex and the shared config, nightly job and storage, update gate), each with the headless output that proves it and, for the GUI checks, what the operator is asked to confirm and the result once they have. Items that did not pass are listed under "Open" with their evidence and what they need.

Update `docs/STATUS.md` (M1 live; native fan-out state; GUI checks pending or done) and `CHANGELOG.md` (`### M1: Codex router`: "**Accepted.** `docs/evidence/m1-acceptance.md`.").

Remove `.anyengine/flip-m1/`.

```bash
git add scripts/probe-acceptance.mjs docs/evidence/m1-acceptance.md docs/STATUS.md CHANGELOG.md
git commit -m "docs: record the M1 live acceptance"
```

**Acceptance:** every headless check passes or is recorded under "Open" with its evidence; the GUI checks are listed for the operator (the picker, the mid-thread switch, the seven-agent run in the app, the app keeping its Claude pick, the Codex TUI); M1 is on at the end (`anyengine status` shows both layers and `flip none`).

---

## Risks and open questions

**DECISION NEEDED** items are in "Decisions this plan takes": D1 (router attach through the adapter, not the rc), D3 (claimed children refuse what they would have to ask), D4 (`off` undoes every layer; `--router-only` for the router alone), D14 (Claude's shell fails closed without a sandbox). Each has a recommendation, and the plan implements it. D9, D15, D16, D17 and D18 follow the COO's rulings on the independent review.

1. **Native fan-out on 0.159 may not work as recorded.** The spike proved v1 `spawn_agent` with a Claude model on 0.155. Task 12 records the 0.159 announcement at zero spend with a fake ChatGPT login; if 0.159 does not offer the multi-agent tools to that login (they may be gated by an account feature), the 0.155 shape is the reference and the path is first exercised live by the pre-proof of the staged lib in Task 30 Step 7, then in Task 31 Step 4. If it fails, the switch-on starts with `router.multiAgentV1 false` (one restart, as with a pass), a later failure moves the router and every adapter spawned afterwards to the bridge path (decision D18), and fan-out onto Claude goes through the bridge tool the GPT child then has. While native is in use, the GPT child has no bridge: nothing else fans out onto Claude, which is why native is used only once proven.
2. **OpenAI can retire the v1 multi-agent tools, or change how the catalog selects them.** Then native mixed fan-out ends; the router's evidence and the smoke's `native-fanout` failure move everything to the bridge path, loudly. Marking every GPT entry v1 also costs pure-GPT fan-outs v2's features (decision D11).
3. **Claimed children are text in, text out.** The Codex child thread shows the claimed Claude's progress as reasoning lines and its answer as the message; Claude's individual tool calls are not rendered as items, and a tool call the posture would ask about is refused (D3). A long claimed task holds a `/responses` stream open with keep-alives every 15 s; a Codex version with a stricter overall request timeout would cut it (the smoke uses short tasks; Task 31 Step 4 uses a one-sentence task).
4. **The router is in the path of every GPT turn while attached.** Mitigations: attach only when healthy at spawn (D1), launchd KeepAlive, the smoke's `router` degraded mark (the next spawn goes direct), `anyengine off --router-only`, and `~/.anyengine/bin/anyengine-off` without Node. What remains: a router that is healthy but corrupts traffic subtly would only be caught by the smoke (nightly) or the operator; the GPT relay is byte for byte and pinned by tests to keep that class small. The router runs no Claude turn for a thread no adapter owns (D16).
5. **The shared codex files** (D9, D15). The models cache does not leak to a terminal codex, because its identity includes the base URL; Task 30 Step 6 proves it before the switch-on (with a fake ChatGPT login, since an API-key login never reads the cache) and Task 31 Step 8 on the live cache. The `config.toml` leak is closed for the app's picker (Task 5) and the existing line is removed at the switch-on. The app keeps rewriting `config.toml` while M1 is on, so `off` puts the line back by its own rule, never by hash or hunk: only where no top-level key of that name exists, with the newer pick, checked for duplicate keys, never a failure (Tasks 23, 24). Residual: another writer of `config.toml` (a terminal codex's own model command, run by the operator) is not intercepted; `doctor` warns when a non-GPT `model` line appears.
6. **ChatGPT.app updates itself and cannot be held** (D8). A quit installs a staged update; every flip re-checks right before each quit (a stop on the way in; expected and re-verified on the way back), the watcher verifies each new version after it installs, and a version that fails runs on the vendor codex until fixed. The window between an install and the first verification (the smoke job fires on the Info.plist change) is minutes; if verification cannot run (Mac asleep), the adapter keeps working as M0's 14a fixes made it resilient to layout moves.
7. **Policy.** Agent mode (the default) runs the official interactive CLI on the operator's own login; the live runtime type must be `anyengine` for that (doctor warns otherwise). Model mode is grey and opt-in (spec 3); the smoke's `claude-model` path runs only in model mode.
8. **The live lib today is `0.1.0-986ab707750e`**, the build of `986ab70`, this plan's base. The switch-on activates the M1 build on top; `off --router-only` returns to `986ab707750e`, which pruning keeps because the router layer names it (Task 24).
9. **Codex's per-session agent limit** may be below 7 (D12); the success test then runs in batches. Not overridden.
10. **Sizes.** `codex-mux.mts`, `anyengine-runtime.mts` and `server.mts` are at their baselines; Tasks 5, 13 and 18 name the extractions that make room. If an implementer finds less room than planned, the rule is: extract a self-contained function to a new module before adding lines, never raise a baseline.
11. **Time and quiet.** The switch-on and the `off`/`on` cycle each need a quiet app (up to 60 minutes of waiting each). The flips run detached and are polled, so an agent's command time limit does not cut them; if the operator is busy all day, Tasks 30 and 31 finish later; nothing is forced.
12. **A flip's own failures** (D17). One flip runs at a time (an exclusive lock). A runner killed outright (SIGKILL, a crash) leaves the write-ahead record and the marker; the next `anyengine` flip command resumes it to the last good state, waiting for a quiet app first (or `--force`), and opens the app if it is closed; any other failure after the quit reopens the app in a `finally`; nothing the running app depends on goes before its quit. What remains: a power loss between the quit and the reopen leaves the app closed until the operator opens it or runs any flip command.
13. **Claude Code's global state is never edited** (COO ruling). Nothing in this plan opens `~/.claude.json` for writing; every live Claude run works in one fixed directory, so the file gains one project entry for the smoke and the probes after the switch-on, and one for the probe of Task 3 before it, each once. The smoke's own session files are the only thing it deletes under `~/.claude/projects`, by exact name in its one folder; if Claude Code changes how it names that folder or its session files, the smoke finds nothing to delete, logs it, and the folder grows slowly (the `storage` check in `doctor` reports its size).
14. **The native fan-out proof is keyed on four things** (decision D18): the lib, the app's version, its codex's version and the settings. Any of them changing puts the router on the bridge path until the next proof: after an app update, the update watch (Task 28) proves it again as part of verifying the new version, so native is back within minutes; until then fan-out onto Claude goes through the bridge. The unclaimed streak counts only spawned children of owned parents, which needs the child request to name its parent (`x-codex-parent-thread-id`); if 0.159 does not send that header (Task 12 records it), the streak never grows and only the smoke can move native fan-out to the bridge.
15. **The ownership gate assumes a single-user Mac** (decision D16): thread ids appear in files the group `staff` can read, so another local user who learned a live thread id could ask the router for a Claude turn on it. The claim socket itself is private; `docs/guide/router.md` says so.
16. **Open question for M2:** `posture.strict` (spec 5.6) has no M1 path (no flow converts a Claude permission mode into a Codex one here); it lands with the Claude Code face.

## Spec coverage (section 9, M1, and the COO's scope)

| Item | Task |
|---|---|
| Router Codex face: loopback service, launchd KeepAlive, fixed port, health | 8, 24 |
| `/models`: upstream with the caller's headers, Claude entries (availability fields and `supported_in_api` kept from the template, first visible entry GPT under every auth filter), v1 marking, spawn priority (top-5) | 9 |
| GPT `/responses` relay, HTTP and WebSocket (other upgrade paths passed through byte for byte), tokens never stored, refreshed or logged | 8, 11 |
| Trampoline (`claude -p`, a closed built-in tool list, Codex tools via a per-turn MCP server, foreign items stripped) | 10, 16, 17 |
| Mode switch `anyengine mode codex-claude model|agent`; agent mode claims Claude threads | 13, 14, 15, 17, 20 |
| Default Claude mode: agent, with native children claimed (COO point 3) | Decisions D2, D3; 12, 13, 14, 15 |
| Bridge fallback detection, one injected line, native injects nothing | 9, 11, 18 |
| `on/off/status/doctor`, `mode`, `config get|set`, encoding the M0 flip (backup, rollback, idle, staged update, app version, handshake, GPT child, foreign codex, doctor) | 4, 19, 20, 21, 22, 23, 24, 25, 26 |
| `on`/`off` adopt the hand-flipped M0 state without double writes; `off` restores exactly | 22, 23, 24, 25 |
| `status` shows the fan-out path | 20 |
| Models cache cleanup on `off`; terminal codex behaviour checked | 19, 24, 26, 30, 31 |
| Router availability: health-gated attach, KeepAlive, doctor, degraded mark, one-command recovery (with and without Node) | 18, 20, 21, 23, 24, 27 |
| Posture never looser for trampoline and claimed children (property tests extended) | 2, 13, 14, 16 |
| Nightly live smoke (launchd, isolated homes where possible, notification, degraded marks, PONG-sized) | 27 |
| Update gate: Sparkle hold verified (none), detect and alert, re-resolve the bundled codex after updates, drift fallback | Decision D8; 25, 26, 28 |
| Codex CLI → Claude (`codex --remote` to the adapter) with acceptance | 29, 31 |
| Live switch-on with staged-update stop, backups, rollback proof, M0 and router checks, auto-rollback | 30 |
| Live acceptance: picker, mid-thread switch, 7 sub-agents with 3 Opus, v1-off uses the bridge, `off` cleans the cache | 31 |
| Storage on T7, test temp-dir leak, bounded runtime storage with a doctor check | Storage; 1, 7, 8, 21, 27 |
| Safety: Claude's shell fails closed without a sandbox; Claude finds the sandboxed shell | 2, 3 |
| Restart check scoped to the app's own activity | 4 |

## Review findings and where each is addressed

First round:

| Finding (COO ruling) | Task |
|---|---|
| C1: children learned from the parent's collab spawn items (with `thread/started` as a second source); the fake codex emits that shape; a zero-spend recording gate; claim and router tasks proven against it | 12, 13, 14, 15 |
| C2: detached `on`/`off` with a progress log; SIGTERM between quit and open; write-ahead record and a resumable marker; failed quit; not inside ChatGPT.app | 19, 22, 24, 26 |
| C3a: the differential gate for terminal codex against the staged router's real catalog; D9 and doctor check 13 corrected | 21, 30, 31 |
| C3b: the app's non-GPT pick kept out of `config.toml` and laid over `config/read`; doctor warns; the switch-on removes the one line, backed up and reversible; both directions tested | 5, 21, 24, 30, 31 |
| H1: degraded native fan-out or unclaimed streaks move to the bridge; native only when proven; failure at the switch-on turns v1 off | 9, 18, 26, 27, 30 |
| H2: the rollback proven on a scratch copy; M0 adoption with `after = withRcBlock(backup)`, refused unless M0 is on; the bash way back restores the rc first; `layers.json` removed only when clean | 22, 23, 24, 25 |
| H3: the test corrections (fetched counts, env overrides, moved assertions, the fake reply, a bounded property test) | 2, 3, 4, 15, 16, 18, 27, 29 |
| H4: `SelectableRuntime.release` reaches every runtime | 13 |
| M1: `off --force`; `anyengine-off --router-only` | 23, 26 |
| M2: a staged update re-checked before every quit; a version change expected and re-verified on the way back | 23, 25, 26 |
| M3: the `owns` op before any Claude turn, in either mode | 14, 15, 17 |
| M4: the models cache cleaned between the quit and the reopen | 23, 24, 26 |
| M5: fan-out evidence only from models served as v1, reset on a config change; the router restarted after acceptance Step 5 | 9, 31 |
| M6: a claim counts only on `done`; a closed socket is a failure | 15 |
| M7: Claude clones keep the availability fields; the first visible entry is GPT under every auth filter; fixtures lead with `gpt-6.1-sol` | 9, 30 |
| M8: other upgrade paths relayed byte for byte | 11 |
| M9: claimed-child posture through the mux (parent's posture, later tightening, unknown parent strictest); the parent's cwd as the workspace root | 13, 14 |
| LOW: vendored code ported from the clean commit; the router reloads when the lib changes; pruning keeps every layer version; stale facts; short socket roots; storage bounds; split tasks | 8, 10, 16, 17, 23, 24, 27; preamble |

Second round:

| Finding (COO ruling) | Task |
|---|---|
| HIGH 1: `off` never breaks `config.toml`: a dedicated restore (a line back only where no top-level key of that name exists, the pick file's value first, no duplicate keys, the pick file deleted, never `left-changed`), run between the quit and the reopen; tests for a GPT pick made while on and a changed Claude pick; acceptance compares line by line | 21, 22, 23, 24, 26, 31 |
| HIGH 2: the D9 gate logs in with the fake ChatGPT `auth.json` (a shared helper) and points `chatgpt_base_url` at a fake too; a no-model check through the router expects `gpt-6.1-sol`; acceptance keeps the bundled codex and the 0.154 and reports "not exercised" for a cache with no AnyEngine entry | 12, 30, 31 |
| MUST 3: no TypeScript parameter properties (`erasableSyntaxOnly`) | 5, 15 |
| MUST 4: the proof compares a full off with the M0 backups for the three M0 targets and the as-found state for the rest, a router-only off with the as-found state; `applySharedConfig` dry run needs no layer; the fixture has a `config.toml` | 22, 24, 25 |
| MEDIUM 5: the jobs are booted out only after the quit; the bash way back does not reopen an app that did not quit | 23, 24, 26 |
| MEDIUM 6: M0 is told from pre-M0 by the shim's hash (the fixture's old shim has the marker); a stale `ANYENGINE_ADAPTER` on a fresh Mac is rewritten as a tracked change | 22, 24 |
| MEDIUM 7: the router reports bridge while native fan-out is not proven | 9 |
| MEDIUM 8: `proven.json` keyed on the lib, app and codex versions and the settings; `native-fanout` in the update check; the probe's proof written by the staged lib | 9, 18, 27, 28, 30 |
| MEDIUM 9: the unclaimed streak counts only children of owned parents, never aborted requests; a newer proof clears the evidence; `owns` can ask the codex child (`thread/read`) | 9, 13, 14, 15 |
| MEDIUM 10: `resumeFlip` waits for quiet (or `--force`) before any restart and walks the rollback ladder | 26 |
| MEDIUM 11: before the acceptance router restart, wait for quiet and zero in-flight | 31 |
| MEDIUM 12: the test residue in `posture-runtimes.test.mts` and `flip-tools.test.mts` | 2, 4 |
| LOW: an exclusive flip lock; `markerAlive` for `--foreground`; a `finally` reopen after the quit; router-only pops only `router`; v2 evidence ignored for 10 minutes after a start or config change; `done` with `success: false` is a failure; the clone keeps `supported_in_api`; the `control-cache.mts` header; a narrower doctor check; the single-user note; one restart at switch-on with a pre-proof of the staged lib | 9, 15, 19, 21, 23, 24, 26, 27, 30 |
| SIZING: Task 19 split into the seam (19) and the commands (20); the smoke split into the smoke (27) and the update watch (28), `smoke.mts` under the size cap | 19, 20, 27, 28 |
