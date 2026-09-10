# Status

- **Shipped:** multi-engine `codex app-server` adapter — Claude over an interactive PTY, Grok over ACP, GPT passed through to the real Codex child, plus the cross-engine `anyengine` MCP bridge and its natural-language model aliases.
- **Shipped:** the full rebrand to anyengine, with a one-release `CLAUDE_CODEX_*` environment-variable compatibility shim (see CHANGELOG), and the public repository at <https://github.com/hristo2612/anyengine>.
- **Verified:** `npm ci`, `npm run build`, `npm run check`, `npm run typecheck`, `npm run docs:build` and `cargo test --workspace` on Node 24; `npm test` now terminates in one run — 205 tests, 205 pass, 0 skipped. The inherited hang and the three failures it hid are fixed ([review](review-a2.md)).
- **Verified:** `smoke:anyengine` and `smoke:grok` pass against the real `claude` and `grok` CLIs; the compatibility shim and the app's `-c … app-server` argv shape were re-checked against a fake adapter.
- **Shipped:** A3 — the installed `codex` shim on the maintainer's Mac is this build, driving ChatGPT.app 26.901 through `~/.anyengine/runtime.env` (`ANYENGINE_RUNTIME_TYPE=anyengine`). Both hosts reconnected on the first attempt: stdio handshake 952 ms, SSH bootstrap 1435 ms. Backup and a tested `ROLLBACK.sh` sit in `~/.anyengine/rollback-<utc>/`. Full record: [evidence/a3-flip.md](evidence/a3-flip.md).
- **Verified in the app:** Claude Sonnet and Grok 4.6 both answer `PONG` in a local project. Reaching Claude needed two reversible flags in `~/.anyengine/runtime.env` — `ANYENGINE_HIDE_RATE_LIMIT_UPSELL=1` and `ANYENGINE_NATIVE_CODEX=0` — because the desktop hides the whole model picker while the account's Codex usage is spent; revert them on/after 15 Sept to restore native GPT passthrough. Claude still cannot run under the SSH twin (keychain, pre-existing).
- **Verified at the flip:** Grok 4.6 answered `PONG` in the desktop app; `smoke:anyengine`, `smoke:grok`, `smoke:bridge` and `smoke:native-codex` all pass against the live runtime.env ([evidence/a3-smokes.txt](evidence/a3-smokes.txt)). Two environment limits, both predating the flip: a `claude` PTY started from the SSH twin cannot read its OAuth token out of the macOS keychain (`errSecInteractionNotAllowed`), and native GPT turns are quota-blocked until 15 Sept, which also puts the desktop in reserve mode and hides the model picker on the local host.
- **Shipped:** B5b — MCP tools, skills and plugins work inside the desktop app. A Claude thread's tool calls used to deadlock on an approval card the app cannot draw for an `mcpToolCall` item; the approval now follows the item type, and the Plugins pane reads the real `CODEX_HOME` catalog instead of failing two of its three calls. A plugin's own stdio MCP servers now reach Claude *and* Grok. Mechanism, evidence and rollback: [evidence/b5b-mcp-approvals.md](evidence/b5b-mcp-approvals.md).
- **Verified in the app (2026-09-10, local project, ChatGPT.app 26.901, "Ask for approval"):**

  | Check | Result | Screenshot |
  | --- | --- | --- |
  | Claude Sonnet, "use the jinn search tool … quote one line" | 6 s; `Toolsearch` and `MCP jinn search` visible in the thread, quoted a real 2026-09-08 Codex session | [b5b-mcp-tool-call.png](evidence/b5b-mcp-tool-call.png) |
  | `$jimbo Reply with exactly the word PONG` | `PONG` | [b5b-jimbo-pong.png](evidence/b5b-jimbo-pong.png) |
  | Plugins → Personal | renders: `personal` marketplace, "Jinn — One memory, every engine", no spinner | [b5b-plugins-personal.png](evidence/b5b-plugins-personal.png) |
  | Grok 4.6, `Reply with exactly the word PONG` | `PONG`, 2 s | [b5b-grok-pong.png](evidence/b5b-grok-pong.png) |
  | Grok 4.6, "use the jinn search tool …" | 2 s; quoted the session jinn had just recorded — Grok had no MCP server but the bridge before this | [b5b-grok-jinn-tool.png](evidence/b5b-grok-jinn-tool.png) |

  The Plugins pane's **Public** tab still spins: that list is the remote plugin
  catalog the desktop fetches from its own backend, not something the local
  app-server answers. Personal, the tab that shows what is installed here, is
  the one this packet fixed.
- **Next:** re-run `smoke:native-codex` once GPT quota resets, decide how Claude should authenticate under the SSH twin (see the open items in the A3 evidence), and drop the legacy `CLAUDE_CODEX_*` env shim and the `~/.claude-codex/runtime.env` fallback one release from now.
