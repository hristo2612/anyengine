# anyengine

[![CI](https://github.com/hristo2612/anyengine/actions/workflows/ci.yml/badge.svg)](https://github.com/hristo2612/anyengine/actions/workflows/ci.yml)

**Claude in ChatGPT/Codex. GPT in Claude Code.**

AnyEngine connects ChatGPT's Codex workspace and Claude Code, so you can use
your Claude and ChatGPT subscriptions from either tool. Switch between Claude
and GPT in the same conversation, and run sub-agents from both providers.

Grok is also available through its experimental CLI backend.

## How it works

The ChatGPT desktop app talks to a local `codex app-server`. AnyEngine provides
a `codex` shim and local router that connect the app to the engine you name.
Claude runs on the official `claude` CLI, Grok on the official
`grok` CLI, GPT on the bundled Codex. No app patching, no signing. The version
it reports follows the app's own codex after an update. Startup compatibility
checks and live activation checks fall back safely when a build is incompatible.
In Claude Code, the local router supplies GPT turns and GPT sub-agents using
the official Codex client's authentication. Claude Code executes the tools.

```
ChatGPT.app ──▶ codex (shim, earlier in PATH) ──▶ anyengine adapter
                                                    ├─▶ claude  (Anthropic CLI)
                                                    ├─▶ grok    (xAI CLI)
                                                    └─▶ codex   (real app-server child)

Claude Code ──▶ anyengine router ──▶ GPT (authenticated by Codex)
```

Agent text and reasoning stream into the conversation; `Bash` becomes a command
approval; `Edit` / `Write` become file-change approvals with live diffs. Every
thread also gets an `anyengine` MCP server, so any engine can start sessions and
parallel sub-agents on any other one ([cross-engine bridge](docs/guide/bridge.md)).

## Install

On macOS with Node.js 24+, ChatGPT.app and Claude Code installed and signed in:

```bash
npx anyengine-cli@latest setup
```

Setup installs the prebuilt runtime, adds the controls and shell paths, and checks
routing with automatic rollback. It asks before restarting the app. Open a new
terminal afterward:

```bash
anyengine status
```

In ChatGPT.app's coding workspace, pick GPT or Claude and switch engines in the
same conversation. In a new Claude Code session, `/model` lists GPT; generated
`gpt-*` agents also let Claude delegate to GPT. `anyengine limits` reports your
registered ChatGPT accounts. Rotation and replay start off. `anyengine off`
restores the managed settings and routing.

The library lives outside project directories, so cleanup of an idle checkout
cannot remove the live runtime's dependencies. Native fan-out becomes available
after its live proof; bridge fallback remains available before that. See
[Getting started](docs/guide/getting-started.md) for first use and
[Installation and recovery](docs/guide/deployment.md) for staging and updates.

Update with the same `npx anyengine-cli@latest setup` command. The npm package
is named `anyengine-cli`; the installed command is `anyengine`.

For development from a clean checkout, use `npm run setup` instead. You can also
install the npm CLI globally with `npm install -g anyengine-cli`; use the `npx`
command above for setup and updates even when the installed controls are on PATH.

Provide credentials only through your own shell or secret manager. Never commit
API keys, OAuth or session data, `.env` files, or acceptance logs.

## Optional Claude Desktop model picker

Select Claude or GPT in the same Claude Desktop model menu, in Chat or local Code:

```bash
anyengine desktop picker on
anyengine desktop picker status
anyengine desktop picker off
```

Claude uses your signed-in Claude Code subscription; GPT uses your Codex/ChatGPT
subscription. Both appear together, and you can switch models within a conversation.
This uses Desktop's gateway mode with separate local history; `picker off` restores
Claude's cloud mode and saved login. A running Claude app is restarted on enable/disable.

## Optional Claude Desktop tool connector

Claude Desktop can consult GPT in its Chat and local Code tabs through an
optional connector. Claude stays the main model; GPT's answer arrives as a tool
result. This does not change Desktop's native model picker.

```bash
anyengine desktop on
# Quit and reopen Claude, then ask it to consult GPT through AnyEngine.
anyengine desktop status
anyengine desktop off
```

Your existing logins stay intact, and session sync remains a separate option.
See [Claude Desktop](docs/guide/claude-desktop.md) for tools, scope and recovery.

## Optional conversation history

Browse and search Claude Code and Codex/ChatGPT coding conversations together,
then cross-open a marked copy in the other tool. Both browsing and automatic
sync start off:

```bash
anyengine sessions on
anyengine sessions list
anyengine sessions search "the auth bug"
anyengine sessions open claude:YOUR-SESSION-UUID --in chatgpt
anyengine sessions open codex:YOUR-SESSION-UUID --in claude --launch
anyengine sessions sync on   # Optional: copy new conversations automatically
anyengine sessions sync off
```

Originals and continued branches stay intact. Sync copies new conversations
once; cross-open again to bring over newer history. See
[Session browsing and cross-open](docs/guide/sessions.md) for controls and limits.

## Requirements

macOS, ChatGPT.app 26.9 or newer, Node.js 24+ (for stable `node:sqlite`), and
whichever CLIs you want to route to: `claude`, `grok`. Codex ships with the app.

## Documentation

| Topic | Link |
| --- | --- |
| Getting started | [docs/guide/getting-started.md](docs/guide/getting-started.md) |
| Deployment (remote host) | [docs/guide/deployment.md](docs/guide/deployment.md) |
| Using the desktop app | [docs/guide/gui.md](docs/guide/gui.md) |
| Configuration | [docs/guide/configuration.md](docs/guide/configuration.md) |
| Backends | [docs/guide/backends.md](docs/guide/backends.md) |
| Cross-engine bridge | [docs/guide/bridge.md](docs/guide/bridge.md) |
| Optional session browsing and cross-open | [docs/guide/sessions.md](docs/guide/sessions.md) |
| Capability matrix | [docs/reference/capability-matrix.md](docs/reference/capability-matrix.md) |
| Status and next steps | [docs/STATUS.md](docs/STATUS.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Quality gates | [docs/quality.md](docs/quality.md) |
| Security policy | [SECURITY.md](SECURITY.md) |
| Safe examples | [examples/](examples/) |

## Development

```bash
npm run dev          # run from TypeScript via tsx
npm run typecheck    # tsc --noEmit
npm run check        # biome + file-size ratchet + dependency guard
npm test             # build + node --test, with the coverage floor
npm run docs:dev     # preview the documentation site
```

Run `scripts/setup-hooks.sh` once per clone: it points `core.hooksPath` at
`scripts/hooks`, so `git push` runs the same checks CI runs plus `gitleaks`.
The gates and why each one exists: [docs/quality.md](docs/quality.md).
Conventions for humans and agents: [CONTRIBUTING.md](CONTRIBUTING.md).

Environment variables are all spelled `ANYENGINE_*`. The pre-rebrand
`CLAUDE_CODEX_*` names are still accepted for one release; the new spelling
always wins. See [docs/guide/configuration.md](docs/guide/configuration.md).

## Credits

anyengine started as a fork of
[claude-codex](https://github.com/fuergaosi233/claude-codex) by fuergaosi233,
MIT. The Codex `app-server` protocol groundwork, the workflow compatibility
layer and the Rust protocol fixtures are theirs. The multi-engine routing, the
PTY runtime that drives the interactive `claude` CLI, the native GPT
passthrough, the Grok engine and the cross-engine bridge are ours.

MIT.
