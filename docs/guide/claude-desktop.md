# GPT consultation in Claude Desktop

The optional AnyEngine connector lets Claude consult GPT through your existing
Codex/ChatGPT subscription. It works in Claude Desktop's **Chat** and local
**Code** tabs. Claude stays the main model; GPT returns an answer as a tool result.
This does not add GPT to Desktop's native model picker.

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
Claude Code CLI. Its [third-party gateway mode](https://code.claude.com/docs/en/llm-gateway-connect)
has separate authentication and model requirements. AnyEngine uses the app's
supported local MCP configuration instead; it does not patch the application.
