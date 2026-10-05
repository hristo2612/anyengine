# M0: live flip to the installed adapter, with rollback

This is the historical M0 acceptance record from 2026-09-30. Its carryovers and
rollback examples describe that build. Current acceptance is recorded in
[M1](m1-acceptance.md), [M2](m2-acceptance.md), and [M3](m3-accounts-limits.md);
use the current [control guide](../guide/control.md) for installation and recovery.

Host: the Mac that runs ChatGPT.app as a daily driver. The flip is Task 14 of
`docs/superpowers/plans/2026-09-29-anyengine-m0-adapter-safe.md`: ChatGPT.app's
local host moves from its own bundled codex onto the adapter installed under
`~/.anyengine/lib`, behind a backup and a tested `ROLLBACK.sh`.

## Attempt 1 (rolled back)

Date: 2026-09-30, 09:31:58Z (backup) to 09:34:27Z (the app back on its own
codex). Build: `c57e9d2`, installed as `~/.anyengine/lib/0.1.0-c57e9d2135a3`.

### Before the flip

ChatGPT.app was 26.911.61220, its bundled codex
`/Applications/ChatGPT.app/Contents/Resources/codex`, `codex-cli
0.155.0-alpha.2.6`. Every gate, `npm run doctor` against the staged
`runtime.env.m0` and the headless probe of Step 6 passed against that codex.
As Step 4 then required, `runtime.env.m0` pinned
`ANYENGINE_REAL_CODEX="/Applications/ChatGPT.app/Contents/Resources/codex"`.

Nothing looked for a pending app update, and one was waiting. ChatGPT.app
updates itself with Sparkle, which had downloaded 26.928 the evening before:

```
2026-09-29T19:53:00.826Z info [sparkle] Production Sparkle update event action=download_completed backendAppcastEnabled=true checkType=null currentBuildNumber=9647 result=succeeded targetBuildNumber=null
```

The new bundle carries that time as its modification time (Sep 29, 19:53Z).
Sparkle installs such an update when the app quits.

### The change

1. `node scripts/flip-backup.mjs` wrote `~/.anyengine/rollback-20260930T093158Z/`:
   `~/.zshrc`, `~/bin/codex` and `~/.anyengine/runtime.env`, modes kept, and
   `ROLLBACK.sh`.
2. `ROLLBACK.sh --copy-only` was run on the real, still unchanged files first:
   each restored onto itself, and `diff` against the backups found all three
   identical.
3. The three approved changes were applied: `runtime.env` replaced by
   `runtime.env.m0`, `~/bin/codex` replaced by the installed lib's
   `scripts/codex-shim`, and the `CODEX_SHELL`-guarded `CODEX_CLI_PATH` block
   in `~/.zshrc` uncommented.
4. The app was quit and reopened. The quit installed
   the staged update (Sparkle's `Installation/` directory was last changed at
   09:32:16Z), and the app came back as **26.928.20755** (build 12246).

### What happened

The app started the shim, and the handshake succeeded:

```
2026-09-30T09:32:18.545Z info [StdioConnection] stdio_transport_spawned argsCount=4 coreRuntimeInUse=false executablePath=~/bin/codex pid=54928 spawnCommand=~/bin/codex
2026-09-30T09:32:19.767Z info [AppServerConnection] initialize_handshake_result durationMs=775 initializeRequestId=__codex_initialize__ outcome=success transportKind=stdio
```

The adapter ran from `~/.anyengine/lib/0.1.0-c57e9d2135a3` and spawned its GPT
child at the path `runtime.env` named, which 26.928 had removed:

```
{"ts":"2026-09-30T09:32:18.462Z","pid":54928,"event":"codex.upstream.spawnError","message":"spawn /Applications/ChatGPT.app/Contents/Resources/codex ENOENT"}
{"ts":"2026-09-30T09:32:18.462Z","pid":54928,"event":"codex.upstream.unavailable","reason":"spawn /Applications/ChatGPT.app/Contents/Resources/codex ENOENT"}
```

(the same pair again at 09:32:19.763Z for the app's second app-server, pid
54964). 26.928 keeps its codex in `Contents/Resources/codex-cli/`:
`bin/codex` is a `/bin/sh` wrapper that execs
`CodexCLI.app/Contents/MacOS/codex`, the Mach-O the app spawns itself; both
print `codex-cli 0.159.0`.

With no GPT child, the adapter answered `account/read` with its non-ChatGPT
shape, and the app refused to start a thread:

```
2026-09-30T09:32:21.488Z warning [AppServerConnection] app_server_connection.transport_connect_failed errorMessage="Sign in to ChatGPT to start a durable thread."
```

It degraded silently. The adapter itself loaded, so the shim's selfcheck
passed, nothing fell back and no `~/.anyengine/shim-fallback.json` was
written; the only trace was the debug log above and a stderr line. No doctor
check looked at the codex path, so doctor could not have caught it afterwards
either.

### Rollback

The full `~/.anyengine/rollback-20260930T093158Z/ROLLBACK.sh` restored the
three files and restarted the app. Afterwards all three were identical to the
backup (`diff -q`, re-checked later the same day), and the app was back on its
own codex with no adapter:

```
2026-09-30T09:34:27.179Z info [StdioConnection] stdio_transport_spawned argsCount=4 coreRuntimeInUse=false executablePath=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex pid=57651 spawnCommand=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
2026-09-30T09:34:27.528Z info [AppServerConnection] initialize_handshake_result durationMs=66 initializeRequestId=__codex_initialize__ outcome=success transportKind=stdio
```

`ps -axww -o pid=,command= | grep '[.]anyengine/lib/' | grep ' app-server'`
found no adapter process.

### What changed before the retry (Task 14a)

- **One rule for which codex runs** (`src/bundled-codex.mts`, a bash copy in
  the shim, a parity test over every layout): `ANYENGINE_REAL_CODEX` while it
  names an executable file, else the app's own codex, newest layout first
  (`codex-cli/CodexCLI.app/Contents/MacOS/codex`, `codex-cli/bin/codex`,
  `Contents/Resources/codex`). A named codex that is gone is skipped for the
  app's own, with a line in the app log and a debug event. Attempt 1's exact
  configuration would now start the GPT child from the 26.928 layout.
- **Doctor fails** (`bundled codex resolves`) while `ANYENGINE_REAL_CODEX`
  names a codex that is gone, or a codex child is expected and none resolves.
  Against attempt 1's `runtime.env.m0` it now fails.
- **The shim runs the app's codex for every command**, not only for
  app-server. Another codex (on this Mac an npm-global 0.154.0 sits ahead on
  the app's PATH) runs only when the app's is missing, with a line on stderr
  and a `shim.nonBundledCodex` debug event; Step 11 checks that none runs.
- **The pin is `0.159.0`.** Its posture schema has the same 38 values and
  fields as 0.155.0-alpha.2.6, all mapped. A collaboration mode this build
  does not know now reads as plan, as an unknown sandbox or approval reads as
  the tightest, since the app keeps updating itself after the flip.
- **`preflip-check` refuses while an app update is staged**, reading
  Sparkle's cache and installer job from the app's bundle id and failing
  closed on anything it cannot read, and the plan's Steps 2, 10 and 11 record
  the app version before the quit and stop if a different one comes back.
- **Step 4 drops `ANYENGINE_REAL_CODEX`** from the staged `runtime.env`: the
  shim and the adapter find the codex in whichever layout the app ships.

## Attempt 2 (live)

Date: 2026-09-30, 11:42:34Z (backup) to 11:43:10Z (every Step 11 check
green). ChatGPT.app 26.928.20755, bundled codex
`codex-cli/CodexCLI.app/Contents/MacOS/codex`, `codex-cli 0.159.0`. Build:
`e156583`, installed as `~/.anyengine/lib/0.1.0-e15658394a9c` and verified by
`scripts/lib-verify.mjs`.

### Checks before the flip

- `preflip-check`: quiet, Sparkle `no staged update`, the updater job
  `gui/<uid>/com.openai.codex-sparkle-updater: not loaded`.
- Gates against the app's codex: `npm test` 381/381, seven pin sites at
  `0.159.0`, `Posture schema coverage OK: 38 values and fields, all mapped.`,
  the Rust protocol fixtures matching the app's codex.
- `npm run doctor` against the staged `runtime.env.m0`: all ten lines `ok`,
  among them `bundled codex resolves:
  /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`.
- The Step 6 probe: `userAgent m0-probe/0.159.0`, MCP servers `["anyengine"]`,
  `upstream-ok (1 spawn from the app layout)`, no fallback.

One deviation from Step 4: the live `runtime.env` also exported
`CODEX_REAL`, naming an npm-global codex 0.154.0, which Step 4's `sed` did not
remove, so its `no-codex-pins` check failed. Only the shim and the adapter read
`runtime.env` on this Mac; there `CODEX_REAL` is the last resort when the app's
codex does not resolve, which would run a codex the gates never checked. It was
removed from `runtime.env.m0` as well, and Step 4 now removes it. The staged
diff was four lines: the adapter path, and the `CODEX_REAL`,
`ANYENGINE_COMPAT_VERSION` and `ANYENGINE_REAL_CODEX` exports removed.

### The change

1. `flip-backup.mjs` wrote `~/.anyengine/rollback-20260930T114234Z/`, and
   `ROLLBACK.sh --copy-only` on the unchanged files left all three
   diff-identical.
2. The approved changes were applied: `runtime.env` from `runtime.env.m0`,
   `~/bin/codex` from the installed lib's `scripts/codex-shim` (byte-identical),
   and the `CODEX_SHELL`-guarded block in `~/.zshrc` uncommented;
   `CODEX_SHELL=1 zsh -lic` expanded `CODEX_CLI_PATH` to `~/bin/codex`.
3. Step 10: quiet, no staged update, `same-app`. The pre-flip baseline of
   codex executables from outside the app held one path, an unrelated
   service's own codex-cli copy. The app was quit and reopened at 11:42:49Z.

### Verification after the relaunch

The app came back as the same version, and the adapter's GPT child started
from the 26.928 layout:

```
2026-09-30T11:42:54.351Z info [StdioConnection] stdio_transport_spawned argsCount=8 coreRuntimeInUse=false executablePath=~/bin/codex pid=12829 spawnCommand=~/bin/codex
2026-09-30T11:42:55.735Z info [AppServerConnection] initialize_handshake_result durationMs=1383 initializeRequestId=__codex_initialize__ outcome=success transportKind=stdio
2026-09-30T11:42:52.966Z codex.upstream.spawn /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
2026-09-30T11:42:55.117Z codex.upstream.spawn /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
gpt-child-ok
```

- One adapter process, from `.anyengine/lib/0.1.0-e15658394a9c/dist/src/adapter.mjs`,
  with one GPT child (the app's other codex process is its own cloud
  `exec-server`); no `shim-fallback.json`.
- `no-foreign-codex`, and `0` `shim.nonBundledCodex` events: besides the app's
  codex, only the SSH host's nvm `app-server proxy` and `app-server --listen
  unix://` processes and the baseline service ran.
- `npm run doctor` against the live `runtime.env`: all ten lines `ok`.
- No "Sign in to ChatGPT to start a durable thread" in the app log.

### Acceptance in the app

- In a Claude Sonnet thread (the operator's choice, in Full access), a
  `spawn_subagents` fan-out to Sonnet and `gpt-6-luna`: two
  `bridge.spawnSubagent` events (11:47:55.768Z `sonnet`, 11:47:56.506Z
  `gpt-6-luna`), both children answered. The GPT child's rollout records
  `model=gpt-6-luna`, `sandbox danger-full-access`, `approval never` and
  `task_complete "PONG"`: equal to its parent's recorded posture
  (`danger-full-access`, `never`, set by the operator), not looser.
- Found: only the Sonnet child could be opened from the parent. A bridge GPT
  child is a plain upstream thread (`source: "vscode"`, no parent), so the app
  showed it as a top-level chat and could not walk from it to the parent. This
  predates M0 (`2ffa05c`, 2026-09-08). Fixed on `m0/gpt-subagent-view`, to be
  deployed as a separate, approved update.
- GPT in its own thread: the operator's own GPT threads in the app after the
  flip (12:12Z and 12:25Z, `gpt-6-astra`) answered through the adapter.
- Sandbox, run headless against the installed build through the shim, with
  isolated homes: a Claude Sonnet thread, `sandbox: workspace-write`,
  `approvalPolicy: on-request`, and three separate `mcp__anyengine__exec`
  calls. `pwd` returned the workspace (exit 0), `echo ok > probe.txt` created
  the file in the workspace (exit 0), and `echo probe > ~/anyengine-probe.txt`
  failed with `Operation not permitted` (exit 1). No approval was requested,
  and no file appeared in the home directory. Codex's sandbox confined the
  Claude child.

### Update deployed the same day: GPT sub-agents open from their parent

`m0/gpt-subagent-view`, merged as `986ab70` and independently reviewed twice.
A bridge-spawned GPT child now carries its parent link (`parentThreadId`,
`source.subAgent.thread_spawn`) wherever the app reads a thread: the lineage
lives on its `native_codex_threads` row. The deploy was `install:lib`
(`current -> 0.1.0-986ab707750e`, the previous build kept as the rollback
target), `doctor` on the live `runtime.env` (all ten `ok`), and one app restart
at 14:26:08Z once the app had been quiet for three minutes. After the restart:
the same app version, a stdio handshake `outcome=success`, the adapter running
from `0.1.0-986ab707750e` with no older adapter left, `gpt-child-ok` (spawns
from the 26.928 layout only), `no-foreign-codex`, and `doctor` ten `ok`.
Rollback: `ln -sfn 0.1.0-e15658394a9c ~/.anyengine/lib/current`, then restart
the app.

### Carryovers at M0 acceptance (historical)

- **The fallback with no sandbox relies on approvals.** With the codex child
  unavailable, a workspace-mode Claude thread keeps Claude's Bash tool, asks
  for approval on every command, and runs an approved command with no sandbox.
  A headless probe with a missing `CODEX_HOME` wrote to the home directory
  after an approval. Spec §5.6 requires the child to refuse instead.
- **Claude does not find the sandboxed shell by itself.** `mcp__anyengine__exec`
  is a deferred MCP tool, and asked plainly to run `pwd`, Claude answered that
  it has no shell tool.
- **The pre-flip idle check reads `codex exec` rollouts as app activity.** It
  should only count the app's own activity.
