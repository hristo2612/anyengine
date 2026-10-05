# Task 2d — full-access Claude threads retain the operator environment

Implemented from M1 tip `72d2a3f` on `m1/t02d`. No push, deployment, real
credential use, live application change or user-settings write.

## Behavior

`claudeEnvironment(mode, source)` is the only inherited-environment filter.
Only `mode === 'bash'` passes ordinary variables through. Undefined values are
omitted and the source object is not changed. The PTY and `claude-p` use the
effective shell mode from `claudeLaunchFor`; SDK posture options use that same
resolved launch to supply both environment and tool restrictions. Local read
restrictions and plan mode therefore cannot accidentally opt into full access.
The normal warm-PTY posture key still causes respawn when Bash availability changes.

`exec`, shell-off, plan and read-restricted launches retain Task 2c's exact
allowlist: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`,
`LC_*` (the existing uppercase/underscore suffix matcher), `TMPDIR`, `TERM`,
`CLAUDE_CONFIG_DIR` and `ANYENGINE_*`. The trampoline, capability probes and
compaction omit the mode argument and remain strict regardless of parent posture.

Trusted PTY terminal/resume controls, hook credentials and optional loopback SSE
proxy settings are applied after filtering. Trampoline MCP description/timeout
controls remain adapter-generated. No inherited exception was added for those
controls. `CLAUDE_CONFIG_DIR` remains the intentional saved-login/configuration
exception in both policies.

## Full-access denylist

Patterns below match prefixes unless marked otherwise. This list describes
inherited names, not adapter-generated settings. Proxy matching is case-insensitive;
other names follow the CLI's case-sensitive environment lookups.

| Names / patterns | Reason |
| --- | --- |
| `ANTHROPIC_*` | API/auth keys, bearer/custom headers, model/provider selection, endpoint overrides including Unix sockets, AWS/Bedrock/Mantle, Vertex, Foundry and Google Cloud; alternate config directory and identity token files. |
| `CLAUDE_*`, `_CLAUDE_*`, `__CLAUDE_*` (any number of leading underscores), except exact `CLAUDE_CONFIG_DIR` | Covers all `CLAUDE_CODE_*`: provider switches; API/gateway/session/OAuth tokens and file descriptors; custom OAuth/API URLs; host-auth selection and helpers; managed/remote settings and plugin paths. Also covers local OAuth bases, secure-storage paths, env files, background auth snapshots and remote tool/bridge URLs outside `CLAUDE_CODE_*`. Internal first-party and keep markers cannot bypass filtering. |
| `CLAUDECODE` | Nested-session marker must not change the child launch. |
| `OPENAI_*` | Prevent inherited OpenAI auth/provider/endpoint configuration. |
| `AWS_BEARER_TOKEN_BEDROCK`; `AWS_ENDPOINT_URL_BEDROCK*`; `VERTEX_REGION_CLAUDE_*` | Claude-provider-specific credentials, endpoints and per-model region routing. General AWS/Google/Azure credentials and configuration remain available to Bash because the Claude provider selectors above are removed. |
| `USE_LOCAL_OAUTH`, `USE_STAGING_OAUTH`, `LOCAL_BRIDGE` | Select local/staging OAuth or bridge services instead of production. |
| `SESSION_INGRESS_URL`, `VOICE_STREAM_BASE_URL` | Redirect authenticated remote-session or voice requests. |
| `CCR_*`, `AGENT_PROXY_*` | Remote-session OAuth token files, proxy endpoints/auth tokens, relay modes and proxy trust material. |
| `SELF_HOSTED_RUNNER_*` | Claude host-runner configuration directories/snapshots, injected hooks, proxy authorization commands/files and runner secrets. |
| `MCP_CLIENT_SECRET`, `MCP_OAUTH_CLIENT_METADATA_URL`, `MCP_OAUTH_CALLBACK_PORT`, `MCP_PROXY_URL` | Override MCP OAuth authentication/registration or routing. `MCP_PROXY_URL` is excluded conservatively; the inspected CLI uses that name as a configuration field rather than a confirmed direct env lookup. |
| `SDK_NATIVE_BIN` | Selects the SDK's native Claude executable. |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `GRPC_PROXY`, `NO_GRPC_PROXY`; `GLOBAL_AGENT_HTTP_PROXY`, `GLOBAL_AGENT_HTTPS_PROXY`, `GLOBAL_AGENT_NO_PROXY`; `NPM_CONFIG_PROXY`, `NPM_CONFIG_HTTP_PROXY`, `NPM_CONFIG_HTTPS_PROXY` (all case-insensitive) | Redirect or bypass request proxies, including Node/wrapper/library variants. |
| `NODE_OPTIONS`, `NODE_PATH`, `BUN_OPTIONS`, `BUN_CONFIG_FILE`; `LD_*`, `DYLD_*` | Runtime flags/configuration, module resolution or native-library injection can execute code before Claude's auth/request handling. Includes defensive loader coverage beyond confirmed direct CLI env reads. |
| `NODE_TLS_*`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY`, `NODE_USE_SYSTEM_CA`, `SSL_CERT_FILE`, `SSL_CERT_DIR` | Alter TLS validation/trust or Node's proxy behavior. |
| `OTEL_*`, `BETA_TRACING_*` | Telemetry/tracing destinations, headers and raw-content logging can redirect Claude request data. |

The full-access tests preserve SSH agent access, GitHub tokens, AWS credentials
and profile, Google application credentials, Azure credentials, editor, nvm,
pyenv, virtualenv, XDG configuration and an otherwise unknown environment name.
General-purpose credential names are deliberately not denylisted.

## Binary inspection and proof limits

Read the installed Claude **2.1.287** executable without executing it. SHA-256:
`6eab8333fe2121553100d8f40bfada384a3e989b94f947e18ba6677a6fcb41ea`.

The inspection covered direct `process.env` references, the bundled env-registry
accesses and environment-name string literals. In particular, executable code
confirmed local/staging OAuth and bridge selection; remote-session ingress;
voice base URL selection before an OAuth-authenticated request; agent-proxy
URL/token consumption; secure-storage configuration; host-runner config selection;
SDK native executable selection; MCP client secret/metadata overrides; and
dynamically constructed OpenTelemetry exporter endpoints. Provider and Claude
prefix rules also cover future controls in those namespaces.

This is a version-specific static audit, not a proof against every future
unprefixed CLI control. No real Claude/model call or real GitHub/SSH/cloud
operation was made. Tests observe actual Node child environments through PTY and
`claude-p` launch paths, SDK launch options, and trampoline/compaction children.
Probes emit environment **names only**; value-preservation assertions use booleans.
macOS may add `__CF_USER_TEXT_ENCODING` and node-pty adds `PWD` after filtering.
Node's child_process explicitly propagates `NODE_V8_COVERAGE` when collecting
coverage, even with an explicit environment. Child probes account for those
runtime additions; the strict filter itself is tested against an exact independent
key list. The first coverage-enabled run found four over-strict probe assertions
on `NODE_V8_COVERAGE`; inspecting Node's child_process implementation confirmed
the cause, and only the test observation rule needed correction.

No screen, wire or readiness behavior changed, so the existing captured real-CLI
fixtures remain unchanged; no new hand-authored Claude screen fixture was added.

## Verification

The regression failed before implementation on missing `SSH_AUTH_SOCK` in both
the actual PTY child and SDK launch options. The baseline suite passed 581/581.
Final mutation and gate evidence is recorded alongside this report.

The designated independent review follows this implementation handoff.


All six mutations built and were killed by behavioral assertions; sources were
restored before the final gates:

| Mutation | Detection |
| --- | --- |
| Force the strict policy for every mode | Full-access PTY/SDK lose SSH environment; exact helper contract fails. |
| Force full-access policy for every mode | Workspace, shell-off, plan, read-restricted and trampoline checks reject inherited ordinary variables. |
| Remove the Anthropic prefix deny rule | Full-access child and helper checks detect provider steering names. |
| Lose the PTY's effective mode | The actual full-access PTY child loses ordinary variables. |
| Lose the SDK's effective mode | Full-access SDK options lose ordinary variables. |
| Opt the trampoline into full access | Its strict environment assertion detects ordinary inherited variables. |

Final gates ran in this order, with no source changes between the three full runs.

| Gate | Result | Seconds |
| --- | --- | ---: |
| `npm run check` (check) | passed | 0.81 |
| `npm run typecheck` (typecheck) | passed | 1.28 |
| `npm test` (test-1) | 592/592; zero failures, skips or cancellations | 40.46 |
| `npm test` (test-2) | 592/592; zero failures, skips or cancellations | 40.51 |
| `npm test` (test-3) | 592/592; zero failures, skips or cancellations | 40.58 |


`check` includes formatting/lint and size, complexity, dependency and env-docs
gates. Existing non-fatal lint warnings remain. The size ratchet decreased the
SDK module baseline; no cap or dependency changed. Full-suite line coverage
remained above the repository's 80.7% threshold.

[Machine-readable gate and mutation evidence](2026-10-02-t02d-evidence.json).

Implementation commit: `a71962fcccfe9f2a963e63810d90e35518773922`.

Task scratch was removed after saving the evidence above. The isolated review
worktree, normal dependencies and compiled output remain. No scratch directory
was left, and nothing was pushed.
