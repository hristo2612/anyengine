# Status

- **Shipped:** multi-engine `codex app-server` adapter — Claude over an interactive PTY, Grok over ACP, GPT passed through to the real Codex child, plus the cross-engine `anyengine` MCP bridge and its natural-language model aliases.
- **Shipped:** the full rebrand to anyengine, with a one-release `CLAUDE_CODEX_*` environment-variable compatibility shim (see CHANGELOG).
- **Verified:** `npm ci`, `npm run build` and `npm test` on Node 24; the rebranded tree is free of machine-specific paths and secrets.
- **Verified:** `smoke:anyengine` and `smoke:grok` pass against the real `claude` and `grok` CLIs (streamed turn plus a command-approval round-trip on each).
- **Not verified here:** `smoke:bridge` and `smoke:native-codex` need the host's own runtime.env and the bundled Codex child, so they run at the live flip.
- **Known issue:** `npm test` does not terminate — one adapter test (`approval requests round-trip through Codex server requests`) waits forever, leaving 22 later tests unrun. Pre-existing, reproduced on the pre-rebrand branch. Run the test files individually until it is fixed: 174 tests pass that way.
- **Next:** publish the repository, fix the hanging test so CI is green, then flip the installed `codex` shim to this build and drop the legacy env shim one release later.
