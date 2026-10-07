# Claude and GPT in Claude Desktop

AnyEngine offers independent options: Claude and GPT together in the model
picker, GPT tool consultation in ordinary cloud mode, and local Code sessions
visible across Desktop accounts.

Claude options use `anyengine desktop claude picker|tools|sessions`. The earlier
`desktop picker ...`, `desktop on|off|status`, and `desktop sessions ...` commands
remain aliases. ChatGPT.app uses `desktop chatgpt on|off|restart|status|doctor`,
which controls the shared core routing; see [Desktop app controls](control.md#desktop-apps).

## Combined model picker

You need a signed-in Claude Code subscription and a working Codex/ChatGPT login.
After installing and enabling AnyEngine:

```bash
anyengine desktop claude picker on
anyengine desktop claude picker refresh
anyengine desktop claude picker status
anyengine desktop claude picker status --json
```

If Claude is running, AnyEngine quits and reopens it to apply the profile.
Otherwise, open Claude after the command. The normal model menu contains your
model choices reported by your signed-in Claude Code client, including Fable
and available earlier versions, plus the GPT models available to your selected
Codex account. Explicit custom Claude entries remain available too. Choose either provider and send a
message. You can switch providers in an existing conversation; the conversation
and tool results are supplied to the next model as context.

Claude labels and effort ranges come from the official client rather than a fixed
list. Native model IDs let Desktop match its own signed thinking/effort catalog;
multiple CLI aliases for the same model share one Desktop row. Discovery initializes the client without sending an inference request.
Run `picker refresh` after changing accounts or when models change; rerunning
`picker on` also refreshes an existing installation. Desktop restarts when its
profile changes. Gateway mode blocks Claude's fast mode, and Desktop's signed
catalog controls some thinking options; AnyEngine does not bypass those limits.

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
anyengine desktop claude picker off
```

The previous mode and inference profile are restored. Other profiles, preferences
and connectors survive. An edited AnyEngine profile or foreign selection is
retained and reported as a conflict. Recovery intent is saved before settings
change; interrupted enable can be retried or undone, and install/launch failures
restore the prior selection automatically. Existing GPT-only installations upgrade
when you rerun `picker on`. Use `picker refresh` to update model lists.

## Optional sessions across accounts

Claude Desktop indexes local Code sessions under the account and organization
that created them. Switching accounts changes which folder it reads; the CLI
transcripts remain in the shared Claude Code history. AnyEngine can make these
local conversations visible in the other account folders:

```bash
anyengine desktop claude sessions on
anyengine desktop claude sessions status
anyengine desktop claude sessions list
anyengine desktop claude sessions sync
anyengine desktop claude sessions off
```

This option starts **off** and is independent of the combined picker and
cross-engine session copying. `on` shares existing eligible sessions, then checks
for new ones once a minute while AnyEngine runs. `sync` repeats the check manually.
Quit and reopen Claude after sharing or switching accounts to reload its list;
AnyEngine does not restart an active session in the background.

Sharing creates minimal local Code entries across existing account/organization
folders in both `Claude` and `Claude-3p`. If a new account has no local Code folder,
start one Code session there, then sync. Entries link to the existing CLI
transcript; they do not copy its content or transfer login credentials, connector
settings, permission grants, model picks, Chrome access or stale error banners.
The destination uses its own defaults and approvals. Original entries and
transcripts are untouched, and existing destination entries are never overwritten.

`off` stops sharing and removes unchanged entries created by AnyEngine. Entries
you have continued or edited are retained, along with their transcripts. Desktop
keeps separate titles and sidebar metadata in each account; AnyEngine does not
merge those changes. Avoid opening the same transcript for concurrent writes in
two accounts.

Only local Code sessions with an existing local CLI transcript are included.
Claude cloud chats, gateway Chat history, Cowork, SSH/remote sessions, staged
imports, schedules and scratch workspaces are outside this option. Desktop and
Claude Code logins remain independent. The setting is `sessions.desktopAccounts`
in `~/.anyengine/config.json`; ownership receipts live under
`~/.anyengine/recovery/claude-desktop/sessions.json`.

## Optional GPT tool consultation

The optional AnyEngine connector lets Claude consult GPT through your existing
Codex/ChatGPT subscription. It works in Claude Desktop's **Chat** and local
**Code** tabs. Claude stays the main model; GPT returns an answer as a tool result.
For native model selection instead, use `desktop claude picker on` above.

After installing and enabling AnyEngine, opt in:

```bash
anyengine desktop claude tools on
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
anyengine desktop claude tools status
anyengine desktop claude tools status --json
anyengine desktop claude tools off
```

Status reports the saved connector configuration, not whether a running app has
reloaded it. Quit and reopen Claude after enabling or disabling the connector.

`desktop claude tools off` removes the one managed `mcpServers.anyengine` entry from
`~/Library/Application Support/Claude/claude_desktop_config.json`. Other
connectors and preferences survive. An existing unowned entry or an edited
managed entry is retained and reported as a conflict. Interrupted installation
can be retried with `desktop claude tools on` or undone with `desktop claude tools off`.

The Desktop option is independent of the core routing controls. Disable it with
`desktop claude tools off` before turning all routing off with `anyengine off`. If the router
is stopped, GPT tool calls return an error; ordinary Claude remains usable.

## Supported scope

Live checks passed in Chat and local Code on Claude Desktop 2.19675.1, using
embedded Claude Code 2.1.288 and bundled Codex 0.160.0. Cowork and remote Code
sessions have not been verified. See the [acceptance record](../evidence/claude-desktop-acceptance.md).

Desktop's regular model picker does not read the custom GPT picker rows used by
Claude Code CLI. Native selection therefore uses the separate gateway profile;
the tool option uses local MCP configuration in ordinary Claude mode.
