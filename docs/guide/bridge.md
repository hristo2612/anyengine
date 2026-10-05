# Cross-engine bridge

Any thread the adapter runs can start sessions and sub-agents on **any other
engine**: a Claude thread can fan out to Grok, a Grok thread can ask GPT, a GPT
thread (native Codex child) can spawn Claude. The engines never talk to each
other directly; each one gets one extra MCP server, `anyengine`, whose tools
go back through the adapter's own protocol layer.

```
claude / grok / codex child ──stdio MCP──▶ anyengine   ──unix socket──▶ adapter
                                          (bridge-mcp)   (bridge-control)   │
                                                                             ▼
                                                    thread/start · turn/start (as the desktop would)
                                                                             │
                                          ┌──────────────────────────────────┼─────────────┐
                                          ▼                                  ▼             ▼
                                   anyengine (Claude)                grok runtime      real codex child (gpt-*)
```

## Natural language

No tool names are needed. Every engine carries a short standing instruction
("Other engines available", generated from the live model catalog) that says
where it runs, which other models exist, and to act at once when the user
names another engine or says spawn / delegate / hand off / ask X / run in
parallel. Typed verbatim in any thread:

| You type | What happens |
| --- | --- |
| `spawn another session with claude opus and say hi` | a new Opus thread appears in the sidebar, is greeted, and its reply is relayed back |
| `spawn 4 sub-agents, 2 with grok and 2 with claude, each should reply with a different fruit, then list what they said` | four children under the thread (2x `grok-4.6`, 2x the default Claude model) and a final list |
| `ask grok to review this diff` | one Grok session with the task, answer relayed |
| `delegate this to claude sonnet` | one Sonnet session |
| `run this in parallel with 3 grok agents` | three Grok sub-agents |
| `hand this off to gpt` | one GPT session (the native child; its quota errors come back as-is) |

Informal model names are resolved by the bridge, case-insensitively:
`claude opus`, `opus 5`, `claude sonnet`, `sonnet`, `haiku`, `fable`, `grok`,
`grok 4.5`, `gpt`, `gpt 5.6`, `codex`, plus any exact id or display name.
An engine on its own (`claude`, `grok`, `gpt`) picks that engine's default
model; an unknown name is refused with the list of valid ids.

AnyEngine adds one line: Claude and Grok threads get `BRIDGE_LINE` in
their system prompt (Grok prefixes it on the first prompt of a session).
A GPT thread gets `BRIDGE_LINE_GPT` in its developer instructions only
when native `spawn_agent` cannot start Claude (the bridge path; see the
[router guide](./router.md)). On the native path GPT threads get neither
the line nor the `anyengine` MCP server. New GPT handovers keep the caller's
developer block, or the local thread's stored block, before appending once.
Internal handovers back to a known GPT child omit an instruction override:
warm resumes ignore it, and cold resumes would replace the stored block.
This preserves existing instructions; it does not establish retroactive
bridge-line insertion into a preexisting or restarted rollout whose desktop
block is unavailable.

The GPT child's router and MCP attachment stay fixed until the adapter
restarts. Proof or settings drift immediately stops Claude model-mode
routing through that child; restart the adapter to refresh GPT's bridge
attachment after drift.

`ANYENGINE_BRIDGE_INSTRUCTIONS=0` turns the injection off (the tools stay
available; the model then needs to be told about them).

## Tools

| Tool | What it does |
| --- | --- |
| `list_models()` | The merged catalog (`model/list`): GPT ids from the native child when attached, the Claude entries from `ANYENGINE_MODELS`, the Grok models. Ids, display names, provider. |
| `spawn_session({ model, prompt, cwd?, title?, wait?, timeoutMs? })` | New top-level thread (visible in the App sidebar), one turn. Waits for the answer by default (10 min). Returns `{ threadId, turnId, status, text }`. |
| `spawn_subagents({ tasks: [{ model, prompt, name? }], cwd?, timeoutMs?, parentThreadId? })` | Runs the tasks in parallel as **children of the calling thread**; returns every result. The App shows them as native sub-agents under the parent. |
| `send_to_session({ threadId, prompt, wait?, timeoutMs? })` | Another turn on a thread the calling thread started, directly or through its own children. A caller with full access may send to any thread; an unknown caller to none. |
| `wait_session({ threadId, timeoutMs? })` | Waits for the running turn (after `wait:false`), or returns the last finished one. |

`exec` (Claude and Grok threads only) runs one shell command in the real
codex child's sandbox with the calling thread's posture, through app-server
`command/exec`, and returns the exit code, stdout and stderr. It refuses when
no native codex child is running, in plan mode, and under `untrusted` (which
asks before every command). The `exec` tool is marked always-loaded
(`_meta["anthropic/alwaysLoad"]`), so Claude sees its shell without searching
for it.

Shell: inside the thread's sandbox through the `exec` tool when this Mac's
codex is running; Claude's own Bash only under full access; otherwise no
shell, and the thread says so. Under an approval mode that asks before every
command (`untrusted`) Claude has no shell either, because sandboxed commands
have no approval card. Grok's own shell (`run_terminal_command`) runs in
grok's process, outside every sandbox, so the adapter declines it without a
card under the same rule: only full access runs it (and asks, where the
approval mode does).

`model` accepts an id (`grok-4.6`, `haiku`, `gpt-5.6-sol`), a display name
(`Claude Opus`) or an informal alias (`claude opus`, `grok`, `gpt`; see
"Natural language"). Unknown names are refused with the catalog.

## How a spawn is routed

The bridge does not call runtimes. It injects `thread/start` and `turn/start`
into the protocol layer under a **bridge peer**, so:

- the native-codex multiplexer picks the owner from the model exactly as for
  the desktop (`claude-*`/`opus`/`sonnet`/`haiku`/`fable`/`grok-*` local,
  `gpt-*` to the child);
- the spawned thread is persisted, listed and resumable like any other;
- every notification, approval and `requestUserInput` the spawned thread
  produces is teed to the desktop peer that owns the **calling** thread, so
  approvals still surface in the App for the child thread;
- the child inherits the caller's `cwd` and full posture (`src/posture.mts`:
  sandbox with its roots and network, approval policy including granular
  flags, reviewer, trust); a GPT child gets it on `thread/start` and its first
  `turn/start`. No Codex request carries trust or the project baseline (the
  fingerprint of the project's Claude config the app took when it started
  the calling thread), so the adapter hands both to the child itself (on the
  row of a Claude or Grok child, beside what a GPT child reports). A child
  never takes a baseline of its own, so Claude config written during the
  session is not loaded by the Claude children started after it. When the caller is unknown the
  child gets the default: read-only, asking before anything leaves it;
- a `cwd` the model passes is resolved against the caller's. When the
  caller can write (workspace-write or an external sandbox), it must be the
  caller's own cwd or one of its explicit writable roots, matched by real
  path, and the child gets that root as the caller holds it; anything else,
  a subdirectory included, fails the call. A child writes to its own cwd,
  and the caller could later swap a subdirectory or a link for a link to
  anywhere;
- `parentThreadId` must name the calling thread when the bridge knows it.
  When it does not, the named thread only links the children, which get the
  default posture, never the named thread's;
- `send_to_session` runs the turn under the target thread's own posture,
  which may be looser than the caller's. So the adapter remembers which
  thread started each child (in memory: after an adapter restart a continue
  is refused until the caller spawns again) and refuses a send from any other
  thread, unless the caller is unrestricted (full access, not planning, not
  under `untrusted`). A caller the bridge cannot identify is refused.

Sub-agents mirror what the Task tool path emits: `collabAgentToolCall
spawnAgent` → `subAgentActivity started` → `wait` on the parent's active turn,
closed with `wait completed|failed` and `subAgentActivity completed|interrupted`.
Local children are created with `parentThreadId`, `threadSource: subagent`,
`agentRole` (= task name) and an `agent-<hex>` nickname. A gpt-* child is
allocated by the real app-server, which records it as a plain thread; the
adapter keeps its parent (and depth, nickname, role) on the child thread's
row and gives every Thread the app-server sends for it the same
`parentThreadId` and `source.subAgent.thread_spawn` a local child has, so it
is listed under its parent, kept out of the sidebar, and opens like one
(`src/upstream-subagents.mts`).

## Wiring per engine

The adapter builds the server spec once per thread:

```json
{ "anyengine": { "type": "stdio",
                   "command": "<node>", "args": ["<dist>/src/adapter.mjs", "bridge-mcp"],
                   "env": { "ANYENGINE_BRIDGE_SOCKET": "…/bridge-<pid>.sock",
                            "ANYENGINE_BRIDGE_TOKEN": "<per-process>",
                            "ANYENGINE_BRIDGE_THREAD": "<calling thread id>" } } }
```

- **Claude (`anyengine`, native SDK)** — merged into the turn's `mcpServers`
  next to `ANYENGINE_MCP_SERVERS`; `anyengine` writes it to the
  `--mcp-config` file it already passes to `claude`. One PTY per thread, so
  the thread id rides the server env.
- **Grok** — the same record converted to ACP `session/new` / `session/load`
  `mcpServers` (`env` as `[{name, value}]`). Grok reaches the tools through its
  `search_tool` / `use_tool` pair.
- **GPT (native child)** — the adapter appends
  `-c mcp_servers.anyengine={command=…,args=[…],env_vars=["ANYENGINE_BRIDGE_SOCKET","ANYENGINE_BRIDGE_TOKEN"],tool_timeout_sec=3600,enabled=true}`
  to the child's argv (after the desktop's own `-c` globals) and puts the two
  variables in the child's environment; the token never appears in argv.
  Codex spawns one bridge per process, so there is no thread id: the adapter
  uses the single thread with a turn in flight, or `parentThreadId` when
  given. `tool_timeout_sec` is raised because Codex defaults MCP calls to 60 s.

Picking a Claude or Grok model in the app no longer writes it to
`~/.codex/config.toml`. AnyEngine keeps that pick in
`~/.codex/anyengine/app-model-pick.json` and shows it to the app, so a
terminal `codex` with no `-m` keeps its GPT default. Picking a GPT model
writes `config.toml` as before. The pick counts as a line in your own
`config.toml`: it wins over a default from MDM, enterprise or system
configuration, and only a trusted project's `.codex/config.toml`, a
`--profile` or `-c` flag, or a legacy `managed_config.toml` that sets `model`
wins over it. Only the top-level
`model` and `review_model` are kept; codex refuses writes to profile tables,
and that refusal reaches the app unchanged.

Hand-written configs can use `scripts/bridge-mcp.mjs` as the command with the
three variables set.

## Control channel

`bridge-control.mts` listens on a unix socket under the adapter home
(`bridge-<pid>.sock`, dir mode 0700) and requires an
`Authorization: Bearer <token>` header on the WebSocket upgrade; the token is
random per adapter process.
Both can be pinned (`ANYENGINE_BRIDGE_SOCKET`, `ANYENGINE_BRIDGE_TOKEN`;
the tests do). `ANYENGINE_BRIDGE=0` disables the bridge entirely. Stale
sockets from dead adapters are reaped on start.

## Testing

```bash
npm run build && node --test dist/test/bridge.test.mjs   # fake child + mock runtime
source ~/.anyengine/runtime.env
node scripts/smoke-bridge.mjs claude   # sonnet thread spawns a grok-4.6 session
node scripts/smoke-bridge.mjs grok     # grok thread fans out 2 haiku + 2 grok sub-agents
node scripts/smoke-bridge.mjs gpt      # gpt thread spawns a haiku session (records usage limits)
node scripts/smoke-bridge.mjs natural  # the two natural-language prompts above, no tool names:
                                       # sonnet thread -> opus session; grok thread -> 2 grok + 2 claude
```

## Known gaps

- A gpt-* **child** thread is linked by the adapter, not by the real
  app-server: its own rollout still says `source: vscode`, so a codex TUI
  opening that rollout directly sees a plain thread.
- Parent-side collab items for a gpt-* **parent** are live notifications
  only: the child's rollout does not persist them.
- The caller of a GPT thread is inferred on each call; two GPT turns calling
  the bridge at once need `parentThreadId`, and their children then get the
  default posture.
- Turn text is collected from `item/completed agentMessage` (fallback: the
  deltas); tool output of the spawned thread is not returned.
