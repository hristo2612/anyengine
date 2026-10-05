# M1 Task 14b: bundled Codex adoption

Verified 2026-10-02 against ChatGPT.app **26.930.21537** (bundle build
**12776**) and its bundled **`codex-cli 0.159.0-alpha.12.1`** at
`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`.
This is an exact compatibility target, not an assertion that it has greater
SemVer precedence than 0.159.0 or 0.159.2. No live deployment was performed.

## Pins and version handling

`node scripts/sync-codex-compat.mjs` read the bundled binary and moved all
nine pin sites, including the compatibility and doctor tests (now owned by
the sync script). The alpha suffix survives discovery, the shim's version
reply and the adapter's initialize user agent. Regression tests move pins
from 0.159.2 to 0.159.0-alpha.12.1: synchronization follows the installed
binary regardless of ordering. The exact npm version used by CI is published.

The only ordering comparator found is plugin-cache package selection;
Codex compatibility and native-proof version checks use identity, not
ordering. The plugin comparator previously ranked a prerelease above its
release and compared numeric runs before alpha/beta identifiers. It now
orders the version core, then prerelease identifiers, with stable releases
above prereleases. Build metadata breaks ties only after equal SemVer
precedence (preserving dated cache-build selection); opaque directory names
retain natural ordering. Four regression cases failed before the fix;
all 17 plugin tests passed afterwards. No runtime dependency was added.

## Generated schema comparison

Both binaries generated `app-server generate-json-schema --experimental`
into separate scratch directories, each with an isolated environment and
CODEX_HOME under `sandbox-exec`. The previous binary came from the published
`@openai/codex@0.159.0-darwin-arm64` package; its sandboxed `--version`
confirmed `codex-cli 0.159.0`.

**All 440 generated JSON files are byte-identical**, including both protocol
bundles and every individual definition (`diff -qr` produced no output).
There are **no posture-relevant or protocol-relevant changes**: no added,
removed or changed sandbox, approval, permission, network, request,
response or notification fields/values. Consequently no posture mapping or
schema-fixture rewrite is needed; the existing never-looser mappings and
conservative permission-profile/read-restriction guards remain applicable.
The posture coverage gate passed all **38** values and fields it enumerates.
The Rust fixture drift check passed against this bundled binary's generated
TypeScript methods. That gate checks its fixture envelopes and method
presence; it is not a full schema validator for every fixture field.

The SHA-256 of `codex_app_server_protocol.v2.schemas.json` from either binary is
`e77b7d1436a78f431a74b2cb263a862e92ae40d70411bc63835b47ab2168827c`.

## Wire and spawn recordings

The existing capture scripts ran twice each, sandboxed and at zero spend.
Both new files are committed exactly as generated; `cmp` against the second
capture passed. The 0.159.0 files are retained. A recursive JSON comparison
against those older recordings found exactly one difference in each file:
`codexVersion` changes to `0.159.0-alpha.12.1`.

| Contract | Result on the new binary |
| --- | --- |
| Spawn announcement | Unchanged: parent `item/started` precedes `item/completed`; the latter supplies `receiverThreadIds` and links the child before its first model request. No child `thread/started`. Child status/turn notifications can still precede the link. |
| `collabAgentToolCall` | Unchanged `id`, `tool: spawnAgent`, status, sender/receivers, model, reasoning effort and prompt. Inherited model is empty at start, resolved at completion. |
| Parent linkage | Unchanged `x-codex-parent-thread-id` in HTTP/upgrade headers and `client_metadata`, including every child WebSocket frame and prewarm; turn metadata also names the parent. |
| Session identity | Unchanged: `thread-id` identifies the child; `session-id`, metadata `session_id` and `prompt_cache_key` identify the parent. Never identify a child by its session/cache key. |
| Prewarm / WebSocket | Unchanged: child opens its own socket, prewarms, then sends a turn with `previous_response_id` referring to the prewarm. Reused/reconnected socket headers can be stale; body metadata remains authoritative. |
| `use_responses_lite` | Unchanged: the GPT probe uses lite; the Claude clone sets it false and receives top-level tools, no lite header and no `additional_tools` item. |
| Multi-agent offer | Unchanged v1 tools inside `exec`; the fake ChatGPT login successfully spawned children, tested inheritance/forked context and send/close/resume follow-ups. |
| Login transport | Unchanged fake API-key wire capture and fake ChatGPT spawn capture; the latter retains routing/account headers and zstd HTTP bodies. |

Across the two spawn runs (14 children), links preceded first model requests
by **75.9–122.9 ms**. One child's `turn/started` preceded its link by **3.9 ms**,
confirming the existing child-first race. Timings are diagnostic output;
the fixtures preserve canonical notification order and the measured invariant.

Wire SHA-256: `c93862f43603f18f8c34b2a1ac37a7f07629cc17aaf08cd6ac5f817fa55924ba`.
Spawn SHA-256: `f2056ef8644376efa2243941a21efde475907d689caa2eb70bd6922d0bad5529`.

The wire and spawn suites now derive their current fixture path from the
compatibility pin and verify the recorded version. Missing current recordings
fail rather than silently testing 0.159.0. Historical spawn recordings still
participate in the shared announcement assertions.

## Execution safety and reproduction

Every command used the designated external-volume TMPDIR and npm cache.
Capture commands used the existing sandbox/isolated-home implementation:

```sh
node scripts/capture-codex-wire.mjs --codex "$CODEX_REAL"
node scripts/capture-codex-spawn.mjs --codex "$CODEX_REAL"
node scripts/capture-codex-wire.mjs --codex "$CODEX_REAL" --out "$TASK_TMP/wire-repeat.json"
node scripts/capture-codex-spawn.mjs --codex "$CODEX_REAL" --out "$TASK_TMP/spawn-repeat.json"
cmp test/fixtures/codex-wire-0.159.0-alpha.12.1.json "$TASK_TMP/wire-repeat.json"
cmp test/fixtures/codex-spawn-0.159.0-alpha.12.1.json "$TASK_TMP/spawn-repeat.json"
```

`CODEX_REAL` names the bundled binary above; `TASK_TMP` is a subdirectory
of the configured TMPDIR, never a top-level `anyengine-*` directory.
The sync and schema scripts do not provide the captures' complete isolation
on their own. For this verification they ran inside an outer `sandbox-exec`
wrapper using `scripts/lib/codex-probe.mjs`'s `sandboxed` and `probeDirs`:
loopback-only outbound traffic; writes to real engine homes denied; a fresh
HOME, CODEX_HOME and TMPDIR for each gate; an allowlisted environment with
PATH for Node/npm, CODEX_REAL and npm_config_cache. No real credentials,
TUI, launchd, app restart or live configuration were involved.

## Plan expectations

The implementation plan remains read-only. For its version-bound checks
(especially Tasks 6, 12 and 30), use **0.159.0-alpha.12.1**, app version
**26.930.21537**, and the new version-named wire/spawn fixtures wherever it
expects the current installed version. Historical observations of 0.159.0
remain historical. This adoption does not satisfy any later live-flip,
credentialed smoke or native fan-out proof requirement.

## Gate results

| Gate | Result |
| --- | --- |
| `node scripts/sync-codex-compat.mjs --check` | PASS, all nine sites at the exact bundled version |
| `npm run check` | PASS: formatting/lint, size, complexity, dependencies and environment docs; existing warnings remain |
| `npm run typecheck` | PASS |
| `CODEX_REAL=<bundled> npm run check:posture-schema` | PASS, 38 mapped values/fields (outer sandbox) |
| `CODEX_REAL=<bundled> npm run check:rust-protocol-fixtures` | PASS (outer sandbox) |
| Full `npm test`, run 1 | PASS, 602/602, 0 failures; line coverage 86.13% |
| Full `npm test`, run 2 | PASS, 602/602, 0 failures; line coverage 86.12% |
| Full `npm test`, run 3 | PASS, 602/602, 0 failures; line coverage 86.10% |
| Wire capture, two executions | PASS; byte-identical |
| Spawn capture, two executions | PASS; byte-identical |

The three full coverage/hermetic test runs ran consecutively against the
same final code. Their cleanup/stray checks passed. No gate was weakened,
no size/complexity/dependency baseline changed, and no plan file was edited.

## Independent review

A fresh reviewer on GPT-6.1 reviewed the change against the Task 14b brief,
raw schema/capture evidence and gate logs. No unresolved findings. The one
minor finding, a stale ChatGPT.app 26.928 label beside the current pin in
the capability matrix, was corrected to 26.930.21537 and the pin/whitespace
checks passed again.

Authenticated desktop behavior, credentialed engine smoke, live deployment
and native fan-out proof were deliberately left to their later authorized
gates. Neither the implementation nor review claims those checks passed.
The review independently compared the captured artifacts; it did not rerun
the real CLI. Task scratch was removed after review; this document and the
committed fixtures retain the findings and reproduction details.
