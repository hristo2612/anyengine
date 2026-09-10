# anyengine

[![CI](https://github.com/hristo2612/anyengine/actions/workflows/ci.yml/badge.svg)](https://github.com/hristo2612/anyengine/actions/workflows/ci.yml)

**Run Claude, Grok and GPT inside the ChatGPT desktop app.**

Pick the engine per turn — move the picker mid-conversation and the thread
follows, in either direction, with its history. Spawn mixed sub-agents ("two on
Grok, two on Claude") and watch them in the app's own agent view. GPT threads
pass straight through to the real Codex, untouched.

## How it works

The ChatGPT desktop app talks to a local `codex app-server`. anyengine is a
`codex` shim that answers that protocol and patches each thread through to the
engine you name. Claude runs on the official `claude` CLI, Grok on the official
`grok` CLI, GPT on the bundled Codex. No app patching, no signing, survives app
updates.

```
ChatGPT.app ──▶ codex (shim, earlier in PATH) ──▶ anyengine adapter
                                                    ├─▶ claude  (Anthropic CLI)
                                                    ├─▶ grok    (xAI CLI)
                                                    └─▶ codex   (real app-server child)
```

Agent text and reasoning stream into the conversation; `Bash` becomes a command
approval; `Edit` / `Write` become file-change approvals with live diffs. Every
thread also gets an `anyengine` MCP server, so any engine can start sessions and
parallel sub-agents on any other one ([cross-engine bridge](docs/guide/bridge.md)).

## Install

```bash
npm install
npm run build                       # tsc -> dist/
mkdir -p ~/bin
cp scripts/codex-shim ~/bin/codex   # the app looks for a binary called `codex`
chmod +x ~/bin/codex
export PATH="$HOME/bin:$PATH"
export ANYENGINE_ADAPTER="$PWD/dist/src/adapter.mjs"
```

Then open ChatGPT.app, start a thread, and pick Claude or Grok from the model
picker. `npm run doctor` checks the environment.

Provide credentials only through your own shell or secret manager. Never commit
API keys, OAuth or session data, `.env` files, or acceptance logs.

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
| Capability matrix | [docs/reference/capability-matrix.md](docs/reference/capability-matrix.md) |
| Status and next steps | [docs/STATUS.md](docs/STATUS.md) |
| Security policy | [SECURITY.md](SECURITY.md) |
| Safe examples | [examples/](examples/) |

## Development

```bash
npm run dev          # run from TypeScript via tsx
npm run typecheck    # tsc --noEmit
npm run check        # biome format + lint
npm test             # build + node --test
npm run docs:dev     # preview the documentation site
```

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
