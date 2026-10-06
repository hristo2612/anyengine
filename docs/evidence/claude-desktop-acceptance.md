# Claude Desktop acceptance

## Combined picker (2026-10-06)

Installed Claude Desktop 2.19675.1 displayed Claude Opus, Sonnet and Haiku alongside
seven GPT models in the same native Chat and local Code menus. No app bundle
changes or debugging-guard bypasses were made.

- **Claude Chat:** Haiku streamed the requested acknowledgement through the
  official Claude Code client; its existing login reported a Claude Max subscription.
- **Cross-provider context:** switching that Chat to GPT-6-Luna returned the
  codeword from the earlier Claude turn. Switching back to Claude Opus retained it.
- **Claude local Code:** Sonnet emitted Desktop's native `Read` call, Desktop
  read the requested README, and the subsequent tool result produced the requested
  final acknowledgement. The nested Claude client did not execute filesystem tools.
- **GPT:** the existing exact-model, broker-authenticated subscription route is
  reused. Earlier live checks established Chat streaming and local Code tool use.
- **Restoration:** returning to ordinary mode retained the signed-in account,
  cloud history and regular Claude picker without another login.

Claude uses its saved Claude Code subscription, rather than Desktop's cloud Chat
inference endpoint. Gateway history is separate from cloud history; gateway mode
also excludes remote/cloud Code and Remote Control. Conversation history is passed
as context for each Claude turn. Cowork and full multimodal/tool parity remain
unverified.

Automated checks cover the two routing lanes and credential separation, local
counts without inference, native tool-name/result handoff, disabled nested tools
and hooks, incomplete-stream errors, profile migration/recovery/conflicts and
preservation of existing settings/login. The existing automatic rollback remains.

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
