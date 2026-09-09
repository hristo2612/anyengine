# Status

- **Shipped:** multi-engine `codex app-server` adapter — Claude over an interactive PTY, Grok over ACP, GPT passed through to the real Codex child, plus the cross-engine `anyengine` MCP bridge and its natural-language model aliases.
- **Shipped:** the full rebrand to anyengine, with a one-release `CLAUDE_CODEX_*` environment-variable compatibility shim (see CHANGELOG).
- **Verified:** `npm ci`, `npm run build` and `npm test` on Node 24; the rebranded tree is free of machine-specific paths and secrets.
- **Not verified here:** the smoke scripts (`smoke:anyengine`, `smoke:grok`, `smoke:bridge`) need a real `claude` / `grok` login and a live desktop app, so they run on the target machine only.
- **Next:** publish the repository, get CI green, then flip the installed `codex` shim to this build and drop the legacy env shim one release later.
