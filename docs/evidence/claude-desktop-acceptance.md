# Claude Desktop connector acceptance

Checked on 2026-10-06 with Claude Desktop 2.19675.1, embedded Claude Code
2.1.288, bundled Codex 0.160.0 and the existing subscription-backed AnyEngine
router.

## Live checks

- **Local Code:** a new dedicated empty workspace loaded the optional AnyEngine
  MCP connector. Claude requested `ask_gpt` with `gpt-6-luna`. After its normal
  allow-once prompt, GPT returned `ANYENGINE_DESKTOP_OK` and Claude displayed it.
- **Chat:** a new Chat conversation requested the same tool/model. After its
  allow-once prompt, GPT returned `ANYENGINE_CHAT_OK` and Claude displayed it.
- Neither check requested file or shell access from GPT. No API key, new login,
  third-party inference configuration or app bundle change was required.
- A temporary CLI GPT default did not add a GPT Desktop picker row; Desktop
  fell back to a built-in model. The original default was restored. This
  integration is GPT consultation, not native model switching.

## Automated coverage

The Desktop suite checks opt-in/idempotent installation, removal preserving
unrelated preferences/connectors, restoration of absent configuration, conflict
refusal, retry after interrupted installation, installed-library resolution,
local routing without caller credentials, argument validation, MCP handshake,
upstream errors, cancellation and input/output size limits.

Cowork and remote sessions remain unverified. GPT calls are independent text
consultations; follow-ups require supplied context. Desktop history is not added
to unified session browsing by this feature.
