# B5b — MCP tool calls in a Claude-routed app thread

Date: 2026-09-10, Mac mini running ChatGPT.app 26.901 on the live anyengine
build (`~/bin/codex` shim → `dist/src/adapter.mjs`). Baseline commit `96b3d7c`.

## The bug

In a Claude thread the `jinn` MCP server's six tools are visible (the `claude`
CLI merges `~/.claude.json` because anyengine passes `--mcp-config` without
`--strict-mcp-config`), but no tool call could finish. From the live adapter log
`~/.codex/anyengine/debug.jsonl`:

```
00:40:16.769Z PreToolUse tool=Skill
00:40:16.771Z item/started                       (an mcpToolCall item)
00:40:16.772Z item/fileChange/requestApproval    grantRoot:null, reason:null
00:41:29.242Z responseFromClient                 (73 s later, after Stop)
```

The same shape appeared for `ToolSearch` at 00:28:47 and 00:34:05. It is not
specific to `mcp__*`: **every** tool that is not `Bash`, `Edit`, `Write` or
`MultiEdit` took this path.

## What the app actually expects

`codex app-server generate-json-schema` from the real bundled binary
(`/Applications/ChatGPT.app/Contents/Resources/codex`) lists every
server-initiated request in `ServerRequest.json`:

| method | attaches to |
| --- | --- |
| `item/commandExecution/requestApproval` | a `commandExecution` item |
| `item/fileChange/requestApproval` | a `fileChange` item |
| `item/permissions/requestApproval` | a sandbox filesystem/network grant, not a tool |
| `item/tool/call`, `item/tool/requestUserInput` | a `dynamicToolCall` item |
| `mcpServer/elicitation/request` | an MCP server asking the *user* a question |

**There is no approval request for an `mcpToolCall` item.** Codex does not ask:
it gates MCP tools by configuration (`default_tools_approval_mode`, present in
the binary's config surface, `auto` for local servers) and runs them, emitting
`item/started` + `item/completed` for the `mcpToolCall`. So a
`item/fileChange/requestApproval` naming an `mcpToolCall` item leaves the
renderer with no card to draw, and the turn waits on a response that only a
Stop can produce. "Approve for me" does not help — the composer setting changes
the policy anyengine is asked to apply, not the item type the card binds to.

## What changed

- `src/server-helpers.mts`: `COMMAND_TOOLS` / `FILE_CHANGE_TOOLS` and
  `approvalKindForTool()`. `toolUseToItem` now builds its items from the same
  two sets, so the item type and the approval type cannot drift apart.
- `src/server.mts` `requestApproval()`: a tool whose kind is `none` is accepted
  immediately (`approval.autoAccepted` in the debug log) instead of sending a
  request the app cannot render. `Bash` → command approval and
  `Edit`/`Write`/`MultiEdit` → file-change approval are byte-for-byte unchanged,
  including the `acceptForSession` command allow-list and the
  `never` / `danger-full-access` short circuits above it.

The `mcpToolCall` item is still emitted and completed, so the call and its
result stay visible in the thread.

**Accepted consequence.** A tool anyengine renders as an `mcpToolCall` now runs
without a person seeing a card. That is what Codex itself does with MCP tools,
and the alternative was not "the user approves it" but "the turn hangs". The
tools with real local effect — a shell command, a file write — still stop for
approval, including when a skill or an MCP tool is what asked for them. Grok's
`str_replace` / `run_terminal_command` family map onto the same two sets
(`TOOL_NAME_MAP` in `src/grok-acp.mts`), so Grok keeps its approvals too.

## Plugins pane

`plugin/list` was already answering in ~1 ms with `{marketplaces: []}`. The
spinner came from its neighbour: `plugin/installed` and
`externalAgentConfig/import/readHistories` both returned
`method not implemented`, and the pane re-polled the trio every two seconds
forever (16 and 4 failures in the live log).

`src/codex-plugins.mts` now reads the catalog off disk — `config.toml`
`[plugins."<name>@<marketplace>"] enabled = true` via a line parser, resolved to
the newest `plugins/cache/<marketplace>/<name>/<version>/` package, with
`.codex-plugin/plugin.json` and `.mcp.json` — and `plugin/list`,
`plugin/installed`, `plugin/read` and `plugin/skill/read` answer from it.
`externalAgentConfig/import/readHistories` returns its empty shape. Nothing is
ever written.

The same list feeds one more thing: the stdio MCP servers of the user's own
marketplaces are merged into the record every engine gets
(`withCodexPluginMcpServers` at the single `turn/start` call site), with `env`
carried through, so a plugin installed once reaches Claude *and* Grok. The
bundled `openai-*` marketplaces are excluded on purpose — their servers are the
desktop app's own runtime (a relative `./bin/...` launcher, ChatGPT.app's
private node, an HTTP server behind a Codex-only token indirection) and belong
to the real Codex child. `ANYENGINE_CODEX_PLUGIN_MCP=0` turns the merge off.

## Rollback

Rebuild the last green build and restart the app:

```bash
cd ~/Projects/anyengine && git checkout 96b3d7c -- src test && npm run build
osascript -e 'quit app "ChatGPT"'   # check for an active turn first
# wait for the adapter pid to exit, then
open -a /Applications/ChatGPT.app
```

The flip itself (shim, runtime.env) is untouched by this packet; its own
rollback is `~/.anyengine/rollback-20260909T231247Z/ROLLBACK.sh`.

## In-app verification

See `b5b-*.png` beside this file, and the table in `docs/STATUS.md`.
