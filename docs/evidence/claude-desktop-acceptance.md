# Claude Desktop acceptance

## Native picker (2026-10-06)

The installed Claude Desktop 2.19675.1 displayed **GPT-6-Luna** as the selected
conversation model in its native picker. A local gateway profile routed its
Claude-compatible ID to the exact `gpt-6-luna` model through the existing router
and Codex login. No application bundle changes were made.

- **Chat:** direct streaming reply `ANYENGINE_NATIVE_PICKER_OK` rendered.
- **Local Code:** direct reply `ANYENGINE_NATIVE_CODE_OK` rendered in an empty
  workspace, without a tool call or file change.
- **Restoration:** returning to the prior mode restored the existing signed-in
  Claude account, history, and Opus 5.5 picker without another login.
- Gateway history remained separate from the original Claude history.

Automated checks cover the exact alias-to-model mapping, credential separation,
streaming and unknown-model refusal; profile recovery, conflicts, preservation
of unrelated settings/profiles, interrupted installation, and launch rollback.

## Optional tool connector

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
  fell back to a built-in model. The original default was restored. Native
  model selection uses the gateway profile described above.

## Automated coverage

The Desktop suite checks opt-in/idempotent installation, removal preserving
unrelated preferences/connectors, restoration of absent configuration, conflict
refusal, retry after interrupted installation, installed-library resolution,
local routing without caller credentials, argument validation, MCP handshake,
upstream errors, cancellation and input/output size limits.

Cowork and remote sessions remain unverified. GPT calls are independent text
consultations; follow-ups require supplied context. Desktop history is not added
to unified session browsing by this feature.
