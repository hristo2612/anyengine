# Translation source provenance

Pinned MIT reference: [raine/claude-code-proxy v0.1.42](https://github.com/raine/claude-code-proxy/tree/1e30e301a48c01a797308e2d24f6c66515363cbf),
commit `1e30e301a48c01a797308e2d24f6c66515363cbf`. Full license: [LICENSE](LICENSE).

Only the listed pure reference files are vendored. Original Rust is excluded
from the runtime. Auth, token stores, OAuth, keychain, server, monitor and
provider CLI implementations are excluded. The TypeScript translation port
lives under `src/vendor/claude-code-proxy/`; model mapping lives separately
in `src/claude-models.mts`.

| Upstream source | SHA-256 | Adapted destination |
| --- | --- | --- |
| `src/anthropic/schema.rs` | `a403fd04910128c41f639af7ce7d436da5735df50e339e96ada5fb5ee7fe1b5e` | types.mts, request.mts |
| `src/anthropic/sse.rs` | `1c2b92b3820b456e07ec70746576bf6f28ef48a54f8959fd3d93ec9bb420c99a` | stream.mts, sse.mts |
| `src/anthropic/error.rs` | `1a4559cf3fa753d0ec4c7e62f8c835aac309089a42d1751b53e9a2047ffe83d0` | errors.mts |
| `src/providers/codex/translate/request.rs` | `8a298f4d9d60098461afcaa9a53cbccbf63ec12af38527cf45811e205e2be32c` | request.mts, tools.mts |
| `src/providers/codex/translate/model_allowlist.rs` | `8c1007d0e8e2236e5801cc7033e927170c4e811327647d52216c827a9b1dd1ef` | claude-models.mts (catalog replaces allowlist) |
| `src/providers/codex/translate/reasoning_signature.rs` | `410fb95724c86d51cfdf427a1e6fe0f7c67f6437b40ba5d5642983b95dea0e10` | reasoning.mts |
| `src/providers/codex/translate/live_stream.rs` | `90416a7f02d3da03404dc6408a46691137634d23a30b0b001a28055bcbf39cb3` | stream.mts |
| `src/providers/codex/translate/reducer.rs` | `c4b8cf9221ab183bf7f9f5edb420ea04310f4b94c229cbd0d5fe3f40f77e5d5d` | stream.mts, usage.mts |
| `src/providers/codex/translate/read_rewrite.rs` | `d6c2651dec5e812a95a302613d6ee0dad0b75144b3b699116b158a106edbc1ea` | reference only; no runtime port |
| `src/providers/codex/events.rs` | `a4b764240a8bea21cc9c4e4240235d78c0dc6ad87a855fecac364b62ad4b39b3` | errors.mts, usage.mts |

## Intentional differences

- Real catalog IDs/capabilities replace the old Claude-to-GPT allowlist and
  aliases. Non-GPT models remain native Claude requests.
- Read-tool repair and hidden prompt/tool injection are excluded. The original
  `read_rewrite.rs` is retained solely for review of that deliberate omission.
- Full history and `store:false` replace server-side/global continuation state.
- Request, tools, reasoning signatures and usage are ported. Schema traversal
  preserves defaults/examples as literal caller data. Tool-result URL images
  remain `input_image` parts rather than becoming a placeholder. Unsupported
  content and hosted executable tools return an explicit 400.
- The port uses bounded prototype-safe JSON cloning and cache identity from
  captured session/agent headers. Reasoning effort comes only from caller
  input and supported catalog levels; provider/environment overrides are absent.
- The incremental stream port rejects malformed or truncated input and
  require actual terminal output/usage. Upstream whole-buffer parsing is not
  accepted as proof of those cases.
- Error messages use fixed credential-free codes and messages; raw backend
  text stays private. The incremental SSE parser bounds frames and rejects
  malformed UTF-8, partial EOF framing and invalid terminals. Final usage
  is authoritative; failed or incomplete responses never fabricate success.
  Transport uses the same event reducer for streaming and buffered output,
  preserves quota/context errors and retries only one pre-output 401.
