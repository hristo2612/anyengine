# Task 2c — Claude child hardening

> Environment-policy update: [Task 2d](2026-10-02-t02d-environment.md) preserves the
> operator's ordinary environment only when the effective shell mode is `bash`,
> while filtering Claude/provider steering controls. The strict allowlist described
> below remains unchanged for every other mode, the trampoline and compaction.
> The verification below records Task 2c's historical all-strict implementation.


Implemented on `m1/t02c` from M1 tip `639354c`. No push or production installation.

## Behavior

Bridge `spawn_session`, `spawn_subagents`, and `send_to_session` mark injected turns as model-authored. Claude PTYs for those turns receive `--disable-slash-commands`. A whitespace-leading `/` is also prefixed with `Message from another model:` at the bridge boundary and PTY prompt composition. Rehome/handover prefixes use the same neutralisation. Authorship participates in the PTY spawn key, so a subsequent operator turn gets a process without the model-only flag. Operator steering stays unchanged. **Correction after external review:** the production paste layer already adds a leading space to operator slash text; Claude 2.1.287 treats that as prose, not a native command. That pre-existing limitation is preserved, not fixed, by Task 2c.

The PTY, `claude-p`, and SDK construct their environment from one allowlist: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TMPDIR`, `TERM`, `CLAUDE_CONFIG_DIR`, and `ANYENGINE_*`. All other inherited variables are excluded, including credentials, provider selectors/URLs, managed-settings overrides, proxies, Node loader and TLS controls. `ANYENGINE_PTY_KEEP_API_KEY` remains accepted for configuration compatibility but is ignored. The previous SDK mutation of global `ANTHROPIC_BETAS` is removed.

The PTY itself supplies `TERM`, `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD`, and its hook URL/token. When its SSE proxy is active it supplies a freshly generated loopback `ANTHROPIC_BASE_URL` and `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`. These values never come from the inherited environment. The installed SDK replaces its subprocess environment; its own generated SDK entrypoint/version markers remain SDK-owned.

Non-built-in or unreadable permission profiles and the conservative wire scan for deny-read requirements and filesystem `access`/`mode: deny` rules set a sticky `readRestricted` posture bit. It survives persistence, child inheritance, and later built-in profile selections. File tools, shell tools, and bridge `exec` are denied; full-access and plan variants cannot restore reads. The initial wire scan cannot observe actual requirement-source denies in Codex 0.159. The follow-up reads local TOML and MDM sources directly; cloud requirements remain unhandled. `claude-p` consumes the centralized launch deny list too. Existing children inherit a caller's newly applied read restriction before subsequent sends. Restricted callers cannot spawn or drive GPT/Grok children because those M0 runtimes cannot enforce the same restriction.

## Real Claude verification

`claude --version` reported **2.1.287**. Its `--help` lists `--disable-slash-commands` (described as “Disable all skills”). Interactive PTY probes confirmed its stronger practical effect:

| Case | Result |
| --- | --- |
| Flag + `/config permissionMode=acceptEdits` | Unknown command; settings unchanged; no Messages request. |
| Flag + `/heapdump` | Unknown command; no heap snapshot; settings unchanged; no Messages request. |
| Wrapper only, without the flag + `/config ...` | Ordinary prompt reached the fake Messages API; settings unchanged. |
| Direct CLI control (not the adapter operator path), no flag/wrapper + `/config ...` | Updated the isolated settings file to `acceptEdits`; no Messages request. |

Every probe used separate HOME/config/work directories, an explicitly fake key, a fake loopback API, and `sandbox-exec` denying non-loopback networking and writes outside scratch. Initial probe setup needed the fake-key confirmation and correct positional-argument delimiter; the table reports the subsequent verified cases. No paid requests or real Claude settings writes occurred. The fake backend deliberately returns an error, so wrapper verification proves prompt dispatch, not a successful model answer.

## Regression and mutation evidence

The baseline full suite passed 528 tests. New tests first exposed inherited credentials, missing model-turn flags, custom-profile read access, raw bridge slash prompts, and missing `claude-p` read-tool denies. An initial bridge-lifecycle test waited for a fake GPT approval until its harness was corrected; the corrected test demonstrably fails when send inheritance is removed.

All **16** mutation checks failed as intended, then sources were restored: bridge-send inheritance; unsupported child engines; slash text wrapper; slash launch flag; PTY, SDK, and `claude-p` environment filtering; read detection; direct read decision; read launch exclusions; shell mode; read inheritance; persistence; `claude-p` launch exclusions; bridge exec; and the independent read-property bound. The final compound mutation removes both the direct read guard and launch exclusions: the property test still fails against its independently specified deny bound.

The independent review ran on GPT-6.1-sol (implementation: GPT-6-astra). It found later-send inheritance and unsupported-engine delegation gaps; both are fixed and regression/mutation checked. Its operator-steering observation was also fixed by preserving the existing operator-only steering path. That review did not cover the later external findings; see the follow-up report for their fixes and the remaining cloud/operator-command limitations.

## Changes per file

| File | Change |
| --- | --- |
| `src/claude-environment.mts` | Shared child environment allowlist. |
| `src/anyengine-runtime.mts` | PTY allowlist, model-turn launch flag and prompt neutralisation. |
| `src/native-runtime.mts` | Explicit SDK environment; remove global Anthropic beta environment mutation. |
| `src/claude-p-runtime.mts` | Allowlisted process environment; centralized deny list and filtered tool pre-approvals. |
| `src/model-prompt.mts` | Leading-slash and rehome prompt guards. |
| `src/bridge-control.mts` | Guard every injected bridge turn; enforce read-safe spawn/send paths. |
| `src/bridge-input.mts` | Extract argument validation; reject unsupported restricted targets and tighten older children. |
| `src/server.mts` | Carry model-authored provenance into runtime context; call extracted rehome helper. |
| `src/server-rehome-prefix.mts` | Consume history with slash-safe composition while preserving summary/operator behavior. |
| `src/types.mts` | Optional model-authored runtime-context field. |
| `src/posture.mts` | Sticky read-restriction type and fail-closed effect/shell/bypass decisions. |
| `src/posture-reads.mts` | Detect profile and deny-read requirements; extracted profile-ID parsing. |
| `src/posture-convert.mts` | Apply and persist read restrictions. |
| `src/posture-claude.mts` | Remove file/shell tools for restricted reads; explain restriction; authorship-sensitive spawn key. |
| `src/claude-project-guard.mts` | Preserve caller read restriction during inheritance. |
| `test/claude-child-hardening.test.mts` | Environment poisoning across three runtimes; flag, spawn-key, prompt and operator-command regressions. |
| `test/read-restrictions.test.mts` | Profile shapes, persistence, inheritance, read/shell decisions, unsupported targets and bridge-exec refusal. |
| `test/rehome-prompt.test.mts` | Rehome/handover slash guard and subsequent operator-command preservation. |
| `test/bridge.test.mts` | Spawn/fanout/send prompt guards and later restriction propagation/unsupported-target regression. |
| `test/posture-runtimes.test.mts` | All Claude runtimes exclude read and shell tools. |
| `test/posture.test.mts` | Read-restricted variants and independently specified bounds in the never-looser property. |
| `test/anyengine-runtime.test.mts` | Pass fake CLI configuration explicitly in argv. |
| `test/fixtures/fake-claude.mjs` | Consume explicit test configuration without a production allowlist exception. |
| `scripts/size-baseline.json` | Ratchet down four existing oversized modules; no cap increases. |
| `docs/guide/configuration.md` | Document allowlist, deprecated key flag, model prompts and read restrictions. |
| This report and its evidence JSON | Record real-binary checks, mutations, final gates and review disposition. |

## Final gates

Implementation commit: `08572a270e1458e78932709b04ffddb76960612f`. All commands used the required T7 temporary directory and npm cache. Loads below are 1/5/15-minute averages.

| Gate | Result | Seconds | Load before | Load after |
| --- | --- | ---: | --- | --- |
| check (`npm run check`) | exit 0 | 0.85 | 2.50/4.09/3.81 | 2.70/4.11/3.81 |
| typecheck (`npm run typecheck`) | exit 0 | 1.29 | 2.70/4.11/3.81 | 2.70/4.11/3.81 |
| test-1 (`npm test`) | 539/539, 0 failed/cancelled/skipped | 41.56 | 2.70/4.11/3.81 | 5.18/4.65/4.03 |
| test-2 (`npm test`) | 539/539, 0 failed/cancelled/skipped | 42.14 | 5.18/4.65/4.03 | 5.57/4.94/4.17 |
| test-3 (`npm test`) | 539/539, 0 failed/cancelled/skipped | 42.15 | 5.57/4.94/4.17 | 6.50/5.38/4.38 |

`check` passed formatting/lint and the size, complexity, dependency, and environment-documentation ratchets. Existing lint warnings remain; the command exits zero. The three coverage-enabled full test runs were back-to-back, with no source changes between them.

[Machine-readable verification evidence](2026-10-02-t02c-evidence.json).

Scratch was removed after copying the verification evidence. The review worktree, normal dependencies, and build output remain. No production paths were modified and nothing was pushed.
