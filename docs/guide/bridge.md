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

How the instruction reaches each engine (one helper, `bridgeInstructions`
in `src/bridge-instructions.mts`):

- **Claude** — appended to the per-turn `systemPromptAddendum`, i.e.
  `--append-system-prompt` for `anyengine` and the SDK's `systemPrompt.append`.
- **Grok** — the same addendum prefixed on the first prompt of a session
  (ACP has no system-prompt field).
- **GPT (native child)** — appended to `developerInstructions` on every
  `thread/start` / `thread/resume` / `thread/fork` the multiplexer forwards
  (`turn/start` has no instruction fields in the v2 schema). The desktop's
  own instructions stay first; a resend never stacks a second copy.

`ANYENGINE_BRIDGE_INSTRUCTIONS=0` turns the injection off (the tools stay
available; the model then needs to be told about them).

## Tools

| Tool | What it does |
| --- | --- |
| `list_models()` | The merged catalog (`model/list`): GPT ids from the native child when attached, the Claude entries from `ANYENGINE_MODELS`, the Grok models. Ids, display names, provider. |
| `spawn_session({ model, prompt, cwd?, title?, wait?, timeoutMs? })` | New top-level thread (visible in the App sidebar), one turn. Waits for the answer by default (10 min). Returns `{ threadId, turnId, status, text }`. |
| `spawn_subagents({ tasks: [{ model, prompt, name? }], cwd?, timeoutMs?, parentThreadId? })` | Runs the tasks in parallel as **children of the calling thread**; returns every result. The App shows them as native sub-agents under the parent. |
| `send_to_session({ threadId, prompt, wait?, timeoutMs? })` | Another turn on an existing thread (spawned or not). |
| `wait_session({ threadId, timeoutMs? })` | Waits for the running turn (after `wait:false`), or returns the last finished one. |

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
- the child inherits the caller's `cwd`, `approvalPolicy` and sandbox (falls
  back to `on-request` / `workspace-write` when the caller is unknown).

Sub-agents mirror what the Task tool path emits: `collabAgentToolCall
spawnAgent` → `subAgentActivity started` → `wait` on the parent's active turn,
closed with `wait completed|failed` and `subAgentActivity completed|interrupted`.
Local children are created with `parentThreadId`, `threadSource: subagent`,
`agentRole` (= task name) and an `agent-<hex>` nickname; a gpt-* child is
allocated by the real app-server and linked through the parent items only.

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

Hand-written configs can use `scripts/bridge-mcp.mjs` as the command with the
three variables set.

## Control channel

`bridge-control.mts` listens on a unix socket under the adapter home
(`bridge-<pid>.sock`, dir mode 0700) and requires `Authorization: Bearer
<token>` on the WebSocket upgrade; the token is random per adapter process.
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

- A gpt-* **child** thread is not linked by `parentThreadId` (the real
  app-server owns it); the parent's collab items carry the link.
- Parent-side collab items for a gpt-* **parent** are live notifications
  only: the child's rollout does not persist them.
- The caller of a GPT thread is inferred; two GPT turns calling the bridge at
  once need `parentThreadId`.
- Turn text is collected from `item/completed agentMessage` (fallback: the
  deltas); tool output of the spawned thread is not returned.
