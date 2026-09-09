# Status

- **Shipped:** multi-engine `codex app-server` adapter — Claude over an interactive PTY, Grok over ACP, GPT passed through to the real Codex child, plus the cross-engine `anyengine` MCP bridge and its natural-language model aliases.
- **Shipped:** the full rebrand to anyengine, with a one-release `CLAUDE_CODEX_*` environment-variable compatibility shim (see CHANGELOG), and the public repository at <https://github.com/hristo2612/anyengine>.
- **Verified:** `npm ci`, `npm run build`, `npm run check`, `npm run typecheck`, `npm run docs:build` and `cargo test --workspace` on Node 24; `npm test` now terminates in one run — 197 tests, 197 pass, 0 skipped. The inherited hang and the three failures it hid are fixed ([review](review-a2.md)).
- **Verified:** `smoke:anyengine` and `smoke:grok` pass against the real `claude` and `grok` CLIs; the compatibility shim and the app's `-c … app-server` argv shape were re-checked against a fake adapter.
- **Next:** A3 — flip the installed `codex` shim to this build on the host (`ANYENGINE_RUNTIME_TYPE` moves from `jinn-pty` to `anyengine`), then drop the legacy env shim one release later. `smoke:bridge` and `smoke:native-codex` run at that flip.
