# GPT in Claude Desktop

AnyEngine offers two independent options: select GPT as the conversation model,
or let Claude consult GPT as a tool. Both use your existing Codex/ChatGPT login.

## Native GPT model picker

After installing and enabling AnyEngine:

```bash
anyengine desktop picker on
anyengine desktop picker status
anyengine desktop picker status --json
```

If Claude is running, AnyEngine quits and reopens it to apply the profile.
Otherwise, open Claude after the command. Choose a GPT model in the app's normal
model menu, then send your message. GPT answers directly; Claude does not mediate
the answer or make an `ask_gpt` tool call. Available models come from your selected
Codex account when you enable the option. To refresh that list, switch the option
off and on again.

This uses Desktop's [gateway mode](https://claude.com/docs/third-party/claude-desktop/gateway).
The app requires Claude-compatible gateway identifiers. AnyEngine gives those
routes the actual GPT display names and resolves them only to the exact available
GPT model. It does not patch the app or send Desktop credentials to GPT.

Gateway mode has its own **local conversation history**. Your normal Claude
history and login remain saved in their original location. Native Claude models
are available again when you return to ordinary mode:

```bash
anyengine desktop picker off
```

This restores the previous Desktop mode and inference profile. If the previous
mode was a different gateway, that gateway is restored. Other profiles, preferences,
and connectors survive. An edited AnyEngine profile or foreign profile selection
is retained and reported as a conflict. Recovery intent is saved before changing
settings, so interrupted enable can be retried or undone. Installation and launch
failures restore the prior selection automatically; retained recovery handles any
failed restoration. No login reset, API purchase, or additional daemon is needed.

Chat and local Code were live-tested on Claude Desktop 2.19675.1. Code retains
its own tools and approval flow. Desktop's gateway mode removes SSH/cloud Code
environments and Remote Control. Cowork, images, and every Desktop tool have not
been separately verified. Existing session sync options remain independent;
this does not copy your cloud Claude history into the gateway history.

## Optional GPT tool consultation

The optional AnyEngine connector lets Claude consult GPT through your existing
Codex/ChatGPT subscription. It works in Claude Desktop's **Chat** and local
**Code** tabs. Claude stays the main model; GPT returns an answer as a tool result.
For native model selection instead, use `desktop picker on` above.

After installing and enabling AnyEngine, opt in:

```bash
anyengine desktop on
```

Quit and reopen Claude Desktop. Start a conversation and ask:

> Ask GPT for a second opinion on this design. Use AnyEngine to list the available
> GPT models, then consult the model I choose.

Or name a model directly, such as `gpt-6-luna`. Claude asks permission to use the
connector through its normal tool prompt. Allow the call to get GPT's answer.

The connector offers two tools:

| Tool | What it does |
| --- | --- |
| `list_models` | Lists the GPT models currently available to your selected Codex account. |
| `ask_gpt` | Sends a question and optional context to the chosen GPT model and returns its text answer. |

GPT does not run commands or read files through this connector. Each call is
independent: Claude must include relevant context for a follow-up. The tool
returns whether an answer hit its output limit. Calls time out after two minutes,
and cancellation closes the router request.

Only the supplied question and context go to GPT. Enabling this option does not
copy or sync conversations, change either vendor's login, or enable session sync.
The router must be running, and Codex must have a working ChatGPT login.

## Status and removal

```bash
anyengine desktop status
anyengine desktop status --json
anyengine desktop off
```

Status reports the saved connector configuration, not whether a running app has
reloaded it. Quit and reopen Claude after enabling or disabling the connector.

`desktop off` removes the one managed `mcpServers.anyengine` entry from
`~/Library/Application Support/Claude/claude_desktop_config.json`. Other
connectors and preferences survive. An existing unowned entry or an edited
managed entry is retained and reported as a conflict. Interrupted installation
can be retried with `desktop on` or undone with `desktop off`.

The Desktop option is independent of the core routing controls. Disable it with
`desktop off` before turning all routing off with `anyengine off`. If the router
is stopped, GPT tool calls return an error; ordinary Claude remains usable.

## Supported scope

Live checks passed in Chat and local Code on Claude Desktop 2.19675.1, using
embedded Claude Code 2.1.288 and bundled Codex 0.160.0. Cowork and remote Code
sessions have not been verified. See the [acceptance record](../evidence/claude-desktop-acceptance.md).

Desktop's regular model picker does not read the custom GPT picker rows used by
Claude Code CLI. Native selection therefore uses the separate gateway profile;
the tool option uses local MCP configuration in ordinary Claude mode.
