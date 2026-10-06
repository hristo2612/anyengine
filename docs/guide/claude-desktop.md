# Claude and GPT in Claude Desktop

AnyEngine offers two independent options: Claude and GPT together in the model
picker, or GPT tool consultation while keeping Claude's ordinary cloud mode.

## Combined model picker

You need a signed-in Claude Code subscription and a working Codex/ChatGPT login.
After installing and enabling AnyEngine:

```bash
anyengine desktop picker on
anyengine desktop picker status
anyengine desktop picker status --json
```

If Claude is running, AnyEngine quits and reopens it to apply the profile.
Otherwise, open Claude after the command. The normal model menu contains your
configured Claude models (Opus, Sonnet and Haiku by default) plus the GPT models
available to your selected Codex account. Choose either provider and send a
message. You can switch providers in an existing conversation; the conversation
and tool results are supplied to the next model as context.

Claude runs through the **official Claude Code client and its saved subscription
login**. AnyEngine does not extract or proxy Claude OAuth credentials. GPT runs
through the existing Codex subscription route. In local Code, Desktop executes
the tools and handles approvals for both providers; the nested Claude client has
its own built-in tools, user hooks and project settings disabled.

This uses Desktop's [gateway mode](https://claude.com/docs/third-party/claude-desktop/gateway).
The ordinary signed-in mode does not expose a supplemental-provider model setting.
The app requires Claude-compatible gateway identifiers; AnyEngine displays the
actual model labels and routes each identifier to its configured provider. No app
bundle patch, paid API key or additional daemon is needed.

Gateway mode has separate **local conversation history**. Your original Claude
cloud history and login remain saved. This is a subscription-backed combined
picker, with different history and service availability from ordinary cloud mode.
Cowork and every Desktop tool have not been verified. SSH/cloud Code environments
and Remote Control are unavailable in gateway mode. Images and documents are
forwarded to Claude as native attachment blocks; full multimodal parity has not
been verified. Existing optional session sync controls remain independent.

To return to your original mode:

```bash
anyengine desktop picker off
```

The previous mode and inference profile are restored. Other profiles, preferences
and connectors survive. An edited AnyEngine profile or foreign selection is
retained and reported as a conflict. Recovery intent is saved before settings
change; interrupted enable can be retried or undone, and install/launch failures
restore the prior selection automatically. Existing GPT-only installations upgrade
when you rerun `picker on`. Refresh model lists by switching the option off/on.

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
