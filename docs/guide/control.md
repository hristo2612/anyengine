# Control commands

Run the installed `anyengine` launcher, or use `npm run anyengine -- <command>`
from a source checkout. This build implements `status`, `doctor`, `mode`, `config`, `cache clean`,
`on`, `off`, `rollback m2|m3`, `restart`, `smoke`, `accounts`, `limits`, `sessions`, and `codex`.

Use `npm run setup` for a clean source installation or update. It stages the
verified library and invokes `on` with automatic rollback. After a fresh install,
a new terminal finds `anyengine` through the managed PATH entry; older installs
may need `export PATH="$HOME/.anyengine/bin:$PATH"`. The absolute launcher is
`~/.anyengine/bin/anyengine`. See [Getting started](getting-started.md).

Exit codes are 0 for a completed command, 1 for failed inspection or operation,
and 2 for invalid arguments or refused settings. Read commands can return a
partial report with explicit errors and exit 1. Importing the command registry
performs no app, launchd, filesystem, or engine action.

## Optional conversation history

`sessions on` enables unified Claude Code and Codex/ChatGPT coding-history
browsing. `sessions list`, `search`, `show` and `open` browse or create a marked
copy in the other host. `sessions sync` copies a batch of new conversations;
`sessions sync on|off` controls automatic copying while AnyEngine is running.
Both options default off, and `sessions off` disables both. Originals and
continued branches are preserved. See [Session browsing and cross-open](sessions.md).

## Accounts and limits

`on` prepares the shared Codex home before account controls become available.
Home is your existing login. Add another login with the official device flow,
or register an account already logged in under the managed account directory:

```bash
anyengine accounts add work --label Work
anyengine accounts add backup --existing --label Backup
anyengine accounts list
anyengine limits --refresh
anyengine limits --json
```

Limits show every registered account, its usage windows, credits, reading age,
and any unavailable reading. Parked-account refreshes use official metadata
requests and are limited to one attempt per ten minutes.

Rotation starts off. Manual switching waits for managed work to finish;
the next message resumes the same thread on the selected account:

```bash
anyengine accounts use work --dry-run
anyengine accounts use work --wait-quiet 60
anyengine accounts rotate on --threshold 100 --replay none
anyengine accounts rotate off
anyengine accounts use home
```

The app, remote Codex, and Claude Code translator share one active account.
The app's displayed login stays Home. Ordinary Codex processes outside
AnyEngine retain their own login; doctor reports possible concurrent use.
Optional `--replay continue-prompt` adds one visible continuation after a
quota-triggered switch. Replay is off by default.

Before a switch, `accounts backup --metadata-only` retains account metadata
and recovery references without credentials. `accounts recover --dry-run`
reports the recovery state without changing it. Use `accounts recover` to
finish an interrupted account transition. `rollback m3` restores the retained
M2 installation and Home; `off` also returns managed credentials to their
parked homes before removing the installed layers. Preserve the absolute
recovery command printed by the installer if the public launcher is unavailable.

## Status

```bash
anyengine status
anyengine status --json
```

Status reads installed state, configured app/process information, the adapter's
bounded debug-log tail, the models cache, and the loaded router's loopback
`/health` with a one-second deadline. It never quits or opens the app, changes
a job, writes a file, reads authentication, or runs a model/engine probe.

The report distinguishes:

- `lib.current`: installed `lib/current`; `layers`: recorded layer names, or
  `null` with a diagnostic when recovery state cannot be read.
- `app`: configured bundle and current observed version/running state, selected
  Codex executable path, and the historical `knownGood` app version.
- `adapters`: observed running PIDs/lib versions, each PID's last router-link
  event, and the Codex child state. A live matching child process and spawn
  record are required to report running; missing or stale evidence is unknown.
  `processesKnown` distinguishes failed inspection from no adapter observed.
- `router`: launchd job state, current health response, last persisted status,
  and observed fan-out path/reason. Historical native state cannot prove the
  current path. Native display requires matching proof/settings, app version,
  selected executable availability, and running/current/router lib versions.
  The Codex version comes from the router's health proof key; status does not
  certify an unobserved child or independently probe that executable.
- `mode`: saved settings; `modeNote` explains model mode's agent fallback on a
  confirmed bridge path. Router and child attachments may reflect older settings.
- `degraded`, `smoke`, `cache`: recorded failures, the last smoke result, and
  shared-cache identity/counts. These are observations, not fresh verification.
- `flip`: journal and process-start-checked liveness (`true`, `false`, or
  `null` when unknown); `recovery`: retained `RECOVER.txt` path and instructions.
- `configErrors` and `inspectionErrors`: invalid, unsupported, unreadable,
  dangling, oversized, or invalid-encoding evidence. Errors suppress healthy
  and native conclusions and preserve the original files.

An interrupted flip shows its phase and log. Preserve its marker, rollback
records and backups, and use the exact durable command in `RECOVER.txt` when
available. A public launcher restored to an older lib may lack recovery commands.
If no stable recovery instruction exists, status says so; it does not promise
that invoking the older public CLI can finish recovery.

## Doctor

Run `anyengine doctor` for 20 ordered read-only checks. Each inspection failure
is printed as `fail` and makes the command exit 1; warnings alone exit 0. A
failed process, app, socket, configuration or evidence read stays unknown and
cannot establish current health. Every check still prints if another fails.

| Check | Meaning and response |
| --- | --- |
| adapter checks (scripts/doctor.mjs) | Verify installed code/dependencies, resolved binaries, compatibility pin and current posture/Rust schema checks. Repair the reported install or drift before relying on it. |
| config.json | Saved settings errors warn; invalid settings also block native eligibility. Correct the file before changing a preference. |
| router job | A recorded router layer requires its loaded launchd job; an inspection error fails. |
| router health | An active router layer requires a bounded loopback health response, matching current process/start/library identity, zero fault counters and no unresolved upstream failure. |
| router version | Compare the observed router with `lib/current`; refresh the router after a lib update. |
| adapters run the current lib | Old/unknown adapter versions warn; the app retains its loaded lib until the next launch. |
| codex child | Require current process/start/binary evidence for each adapter's child; unavailable or unknown fails. |
| router attached | Warn about absent, stale or detached `router.link` evidence and print its reason. |
| fan-out path | Explain bridge fallback and the last proof's time/key. Native requires matching current app, independently isolated Codex version, running/current libs, settings, mode and proof. Historical native state cannot establish it. |
| Claude mode and runtime | Agent mode with another effective runtime warns; model mode carries the trampoline policy warning. |
| claim sockets | Missing adapter sockets warn. A refused, silent or invalid pong fails within one second, including wrong PID. |
| models cache | Owned entries with no active layer fail. Use `anyengine cache clean` only after confirmed app exit. |
| terminal codex and the router | A shared top-level router URL warns. Ordinary cache identity includes base URL/client version; live differential acceptance remains a separate gate. |
| shared config model | Quote non-GPT top-level/profile assignments and line numbers plus the app pick. A complete switch-on can migrate a top-level pick; profile lines remain yours to edit. Invalid TOML/bytes/pick evidence fails. |
| conflicting settings | A login-shell backend override pointing elsewhere warns; failed shell inspection fails. |
| app update | A positively identified staged update warns that it installs on quit and requires verification. Other failed inspection is a failure, not “no update.” |
| update hold | Report the lack of a reliable hold, smoke-job state and saved schedule setting. An enabled schedule with an active router but no job warns. |
| flip | A process/start/operation-matched running flip warns. Interrupted or unknown recovery state fails and names the exact retained `RECOVER.txt` command when available. |
| Claude Code GPT | Check the M2 translation pin and MIT attribution, installed Claude fixture, owned settings/rows, local GPT broker and possible credential or precedence overrides without emitting values. See [GPT in Claude Code](./claude-code.md). |
| storage | Report root (excluding lib/rollbacks), state, adapter logs, launchd logs and the smoke's Claude project against 500/20/250/50/50 MB limits. Walk only metadata, bounded at 200,000 entries per inspected tree. Invalid layer/known-good/recovery evidence fails. |

Doctor never edits the shared config or cache, clears proof, changes launchd,
or quits/reopens the app. Official help/version/schema probes use private
HOME/CODEX_HOME, a refusing provider, a sandbox that permits writes only in the
probe directory, a total deadline and joined owned process-family cleanup.
Version probes retain their two-second health budget and stat-identity cache;
a timeout or failed cleanup cannot supply a healthy version. The installed
package includes the probe supervisor and exact posture/Rust fixtures.
Before executing an installed doctor, the control command reads its explicit
`anyengine-doctor-isolation: 1` declaration and checks the required regular,
readable helpers and fixtures in that physical lib. Missing or legacy support
fails the adapter row without starting that helper; all 20 rows still print.
The admitted doctor and adapter use that same resolved lib even if `current`
moves during execution; a different current lib at completion fails the check
and leaves its version unknown. The declaration is a package compatibility contract,
not authentication of arbitrary modified code.
The same supervisor also reclaims its group if the blocked caller is terminated.
It checks current member identities before signalling and the private home's
device/inode before removal. Unknown ownership retains evidence. macOS EPERM
alone does not establish absence; cleanup requires scoped terminal-process
evidence. No live credential homes are copied.
An ordinary caller also checks the captured directory device/inode before
reading generated results and again before removing its private home. Missing,
changed or unreadable ownership retains evidence and fails the result; it
cannot supply a healthy schema or cached version.

The TOML mutation helper used by later switch/recovery code scans actual
assignment spans (quoted keys, multiline strings, table and array headers,
CRLF), validates both documents with smol-toml, and preserves unrelated bytes.
Invalid documents, unsupported values and stale removal coordinates refuse.

Proof/degraded publication uses one short synchronous `state/proof-degraded.lock`
gate. Every public mutator validates both raw records and its exact serialized
publication before artifacts, then rereads under that gate. Callers use these
mutators directly and never wrap the same lock. Invalid UTF-8, malformed,
unsupported, dangling and unreadable evidence is retained; it cannot become
an empty baseline or be cleared into health. Legitimately encoded U+FFFD is
valid. A degraded publication clears its proof first so a partial write remains
conservative. The persistent SQLite gate and sidecars remain opaque and retain
their inode; later smoke/update code must supply authentic correlated-success
evidence before publishing or clearing a path.

## Mode

```bash
anyengine mode
anyengine mode codex-claude agent
anyengine mode codex-claude model
```

This changes only `modes.codexClaude` in AnyEngine's `config.json`. Agent mode
is the default. Model mode uses `claude -p` on eligible native routes, a policy
grey area; bridge routes run Claude in agent mode.

The child router/proof key and bridge MCP metadata are fixed at spawn.
Settings/proof drift stops native Claude eligibility until a new attachment.
Restart the adapter to refresh its router and bridge MCP metadata. A changed
mode requires a new native-fan-out proof; run
`anyengine smoke --paths native-fanout`. No command here restarts automatically.
See the [router](./router.md) and [bridge](./bridge.md) guides for route behavior.

## Config

```bash
anyengine config
anyengine config get router.port
anyengine config set router.multiAgentV1 false
```

Reads show validated effective settings and diagnostics. Setters preserve
unknown fields and change only the requested key, under the existing short
config lock. Invalid JSON/UTF-8, non-file or oversized input, and other invalid
settings refuse mutation before root/lock/temp creation. The exact pretty JSON
publication, including its newline, must fit the two-million-byte read limit.
A legitimately encoded replacement character is valid UTF-8.

Native proof includes the v1 switch, modes, Claude models/spawn order, and claim
settings. Changing those settings changes the proof key and prints re-proof
and restart guidance. Disabling `router.multiAgentV1` stops native eligibility.
Coordination SQLite files/sidecars are opaque stable storage; the CLI never
copies, hashes, restores, or prunes them with ordinary file handles.

## Cache clean

```bash
anyengine cache clean --dry-run
anyengine cache clean
```

Dry-run reads the JSON models cache and may run while the app is running.
Actual cleanup requires confirmed app exit; running or unknown state refuses
before any backup/removal. This command never quits or reopens the app.

Only a cache carrying AnyEngine model entries is removed. First it creates a
fresh private `state/cache-backups/clean-*/models_cache.json` backup with the
original bytes. Observed replacement, backup/write failure, and corrupt cache
retain evidence and return 1. A retry uses a new destination and keeps previous
partial backups. After 32 retained backup destinations, cleanup refuses until
the operator has deliberately archived/resolved old evidence. It never prunes
those backups automatically. The final stamp-to-unlink interval does not
exclude arbitrary nonparticipating terminal writers; this is not a global
atomic compare-delete.

## Launcher and recovery

The Bash 3.2 launcher sources `runtime.env` (or `ANYENGINE_RUNTIME_ENV`),
resolves `lib/current`, and execs `ANYENGINE_NODE` with the original arguments.
Installed paths with spaces and launchd's minimal PATH are supported. The
router and smoke jobs set `ANYENGINE_ROOT` to the installation's chosen absolute
root, so a custom root uses its own runtime, library and logs. Plain
`.log` files directly in the root's `logs` directory are trimmed in place to
200 KB at launch; symlink/foreign log targets are retained. No user-shell model
setting or global Codex configuration is changed.

When the reviewed flip commands are installed, `anyengine off` is the normal way
back. If Node or the lib is broken, the installed `~/.anyengine/bin/anyengine-off`
provides Node-free recovery. For pending recovery, prefer the exact durable
entry recorded in `RECOVER.txt`. Layered file installation and recovery are
implemented, along with the postflight consumer and scratch rollback proof.
Detached `on`/`off` orchestration and the installed mandatory work producer are
wired in source. Actual installed/native acceptance remains pending.

## The way back without Node

Recovery generation now provides a private entry at
`~/.anyengine/recovery/anyengine-off`. The installer integration supplies the
public `~/.anyengine/bin/anyengine-off` forwarding script. Use the exact quoted
command in `~/.anyengine/RECOVER.txt` when a flip is incomplete: the private
entry survives restoring the public CLI and `lib/current` to M0.

```sh
/bin/bash "$HOME/.anyengine/recovery/anyengine-off"
/bin/bash "$HOME/.anyengine/recovery/anyengine-off" --router-only
```

The first command restores the initial layers, newest first. `--router-only`
restores only the router layer and leaves the adapter. `--last-good` restores
an existing router's immediate upgrade checkpoint and retains its journal and
pins for the control owner to verify; full recovery still uses the original
pre-install baseline.

Files restore before quitting. Jobs, shared model settings and the owned
models cache change only after the configured application is confirmed down.
`--no-restart` requires that confirmation too. Unknown inspection and failed
quit retain those resources. After a confirmed quit, recovery attempts to
reopen the app even if a later operation fails. A staged update is reported
before quitting. Direct per-layer `ROLLBACK.sh` entries use the same checks;
`--files-only` and `--copy-only` perform only file restoration.

`KEPT` means a dependency remains while rc recovery needs a retry. `LEFT`
means changed content, unsupported evidence or an operation error needs
attention. A unique rc hunk preserves operator edits and initially keeps its
dependent files; retry the same durable command to finish. Unsupported TOML,
invalid UTF-8/JSON, conflicting cache backups and unknown launchd failures
retain evidence. Recovery handles ordinary scalar/array TOML values, quoted
keys, multiline strings and table headers conservatively; unsupported forms
are retained for the Node control path or operator resolution.

The scripts use macOS Bash 3.2, system JXA and system file tools with no Node,
`jq`, `sqlite3` or installed-library dependency. Coordination databases and
sidecars remain untouched. A layer receives `POPPED` only after both phases
succeed; full terminal recovery verifies and keeps the original public file,
link or absence recorded by the initial layer ladder. Without that record it
removes only the exact owned public wrapper or verifies absence. Changed or
unreadable public state retains the journal/pins, including on a retirement retry.
The public operation completes before journal/pin retirement.
The private entry, RECOVER.txt and backups stay available. Re-entry with a
positively absent journal performs no app, job, config or public-file action.
Source tests do not certify detached flip coordination or live app acceptance.

## What `on` changes

The file implementation keeps two layers. The adapter layer adopts a complete
M0 receipt or records the fresh shell guard, shim, runtime environment and public
Node-free recovery forwarder. An apparently active M0 without a complete receipt
refuses installation. The router layer records `lib/current`, the newer shim,
control launcher and router/smoke LaunchAgents. Disabled `smoke.enabled` installs
no smoke job. Settings remain preferences, preserving user and unknown fields.
Disabling an owned smoke job on a later `on` requires the app to be confirmed
down, unloads the job and records plist removal before deleting it. Re-enabling
restores the job without replacing its original baseline. Same-version changes
also retain the immediate last-good checkpoint until caller postflight; failed
publication or deletion preserves ownership and reachable recovery for retry.
Node-free last-good recovery uses the recorded prior plist state: it reloads a
restored prior-enabled job or keeps a prior-disabled job absent. Unknown job
state, ambiguous plist authority and failed bootstrap retain recovery evidence.

Each layer keeps immutable original backups under
`~/.anyengine/recovery/layers/<stamp>-<layer>/`. The strict live journal records
settled and pending generations before publication; private recovery and the
quoted command in `RECOVER.txt` are durable before target changes. An upgrade
also retains the immediately working M1 version, jobs and shared-config record.
The caller retires that checkpoint only after successful postflight. Router-only
off uses the original M0 baseline; full off continues to the pre-M0 baseline.

File restoration reports `restored`, `already`, `reverted-hunk` or `left-changed`.
A unique hunk preserves later rc edits. Changed or unreadable files keep the
layer and its recovery evidence. Files restore first; after-quit cleanup requires
positive app-exit evidence before unloading jobs, restoring shared model picks
or removing an owned cache. Failed cleanup retains pending layers; each cache
retry uses a fresh private destination and preserves older partial backups.

Only actual top-level non-GPT `model`/`review_model` assignments leave
`~/.codex/config.toml`, with a backup and journal before the write. This keeps
terminal Codex from inheriting an app-only Claude pick. Profile assignments and
unrelated bytes stay. Off restores the current app preference only when that
key is absent, keeps newer GPT keys, validates TOML before writing and preserves
unknown pick fields. Invalid UTF-8/JSON/TOML and actual I/O errors retain evidence.
The direct `restoreSharedConfig(record, system)` consumer requires the same
confirmed-down System boundary as `finishOff`.

Stage with `node scripts/install-lib.mjs --no-activate`; activate an already
verified library with `node scripts/install-lib.mjs --activate VERSION`.
Staging leaves `current` and its fallback marker alone; activation verifies the
staged bytes without rebuilding or reinstalling dependencies. Pruning protects
current, staged, prior activation, running, control, initial and last-good/pending
recovery versions, including retained POPPED records. Invalid recovery evidence
refuses installation/pruning. `--dest-root` also selects related state and marker
paths, so an isolated installation cannot clear a different home's marker.

## Post-relaunch verification

The `postflight(system, deps, input)` consumer reports all ten checks in this
order, including failed inspections. It polls handshake and child readiness
every two seconds for at most sixty seconds. A recent spawn or attached link
establishes readiness; successful model work needs the separate mandatory gate.

| Check | Required observation |
| --- | --- |
| app version | Configured app running with the expected version. A forward change fails; an expected recovery change is reported and freshly verified. |
| handshake | A current process's selected stdio executable appears in the app log, followed by a successful stdio initialize handshake. |
| adapter process | Restarted adapters use the frozen, verified installed library, with no shim fallback marker. Vanilla requires no adapters. |
| GPT child | Each restarted adapter has a live child from the freshly resolved bundled Codex, matching current spawn evidence without errors or stale/non-bundled selection. Vanilla requires its fresh bundled child. |
| router attached | Current adapter links and child arguments name the exact expected router URL and fan-out path. Adapter/vanilla children carry no router URL. |
| foreign codex | No newly observed foreign executable outside the pre-restart baseline, and no non-bundled shim fallback event. |
| router health | Current router process/start/lib, mode, four-field key, valid counters, zero faults, resolved upstream errors and matching fan-out. Native needs a matching native proof; degraded state fails. Adapter/vanilla require connection refusal and positively absent job. |
| claim socket | Every restarted router adapter answers a bounded ping with its own PID. |
| doctor | All required installed diagnostic checks pass for adapter/router. |
| smoke | Fresh mandatory restricted OAuth, real operator-config Claude PTY and GPT terminal successes; router also requires a successful configured-Claude parent and GPT bridge child with matching terminal identities. Cleanup and frozen identity must remain verified. |

`PostflightInput.frozen` supplies `{ codeIdentity, key, mode }` captured from
the verified selected immutable library **before restart**. Router and adapter
acceptance require it. The code identity is the SHA-256 of that library's
validated `install-manifest.json`. `FlipDeps.currentSnapshot()` independently
observes current selection, manifest, bundled executable, app/Codex versions,
settings, mode, proof and degraded state. Installed manifested bytes are
verified before and after mandatory work. Same-version code replacement,
settings/mode drift, a moved current link or changed process family fails.

`versionChangeExpected` permits only fresh app/Codex fields to change during
recovery; frozen library, manifest identity, settings and mode remain fixed.
The changed four-field key still needs fresh work evidence. A snapshot cannot
establish its own expected identity.

The installed mandatory gate runs after each deployment even when
`smoke.enabled=false`. It verifies the selected installed library before and
after work, observes each probe process while alive, and awaits owned process,
thread and session cleanup. The restricted Claude check uses the same executable,
closed environment and authentication home for documented OAuth status checks
before and after its successful turn. The ordinary Claude check retains the
operator's configuration and must use the interactive PTY. Bridge work requires
a completed Claude parent and GPT child; native claim evidence is separate.
Vanilla recovery uses app/process/absence checks and does not claim model acceptance.

## Smoke

```bash
anyengine smoke
anyengine smoke --paths gpt,claude-agent --notify
anyengine smoke --paths native-fanout
/path/to/node /path/to/installed/lib/VERSION/dist/src/adapter.mjs smoke --lib VERSION --out /absolute/fresh-proof.json
```

For a direct library invocation, run the `.mjs` entry with the installed Node
binary. `--lib` must name that entry's admitted installed library. `--out` must
be a fresh absolute filename; it receives a private pre-proof result without
changing live smoke results, proof/degraded flags, logs or notifications.
`on --native-proof FILE` accepts only a completed correlated native receipt for
the exact selected code, app/Codex versions, settings and configured mode.
Unsupported or mismatched evidence selects the bridge path.

The six paths are router health, GPT, interactive Claude (`claude-agent`), native
fan-out, Claude-to-GPT bridge, and restricted model-mode Claude (`claude-model`).
Native fan-out uses a private router whenever `router.multiAgentV1` is enabled,
even when the live router is disabled or degraded. Its private bootstrap marker
only enables the probe transport. Proof requires completed matching parent and
child work in the actual configured mode. The model diagnostic uses a synthetic
owned thread and cannot prove native fan-out.

GPT uses the real Codex home for its existing login; adapter state and private
routers live under `~/.anyengine/smoke/run-<timestamp>`. Every Claude path uses
one stable `~/.anyengine/smoke/claude-project` directory. Cleanup removes only
exact logged session UUID files in that project's Claude folder. It never
rewrites Claude's global state or removes unrelated session files.
Private local Claude threads unsubscribe, then their private state leaves only
after all owners exit. Ephemeral GPT threads unsubscribe and exit; persisted
Codex threads require acknowledged deletion and matching deletion observations.
Uncertain cleanup retains the run and prevents successful publication. The next
run sweeps only admitted old runs whose complete owned family is positively gone.

Normal results go to `state/smoke.json` and a bounded `logs/smoke.jsonl`.
Successful paths clear their degraded mark; failed paths set it. A successful
native probe also publishes its exact four-field proof; native failure clears
that proof. A GPT failure is attributed to the router only if the observed routed
turn fails and a separate observed direct turn succeeds. `--notify` reports
failed paths once. Hermetic tests exercise these contracts; actual installed
OAuth, model and native acceptance require successful live work.

## Scratch rollback proof

`proveRollback(system, root, plan, { paths, scratchParent })` reads named
installation inputs and creates five independent scratch homes under the
caller's absolute scratch parent (the configured temporary volume). Each
replays the actual file/shared-config installer and one recovery route:

1. Private Node-free Bash full Off.
2. Node `applyOffFiles` plus `finishOff`.
3. Private Bash router-only Off.
4. Private Bash immediate last-good recovery.
5. Node immediate last-good file/job recovery primitives.

The last-good routes first create a real upgrade checkpoint. Node's route
verifies files, jobs and unchanged shared/config/cache state before retiring
that checkpoint. Bash also performs its recorded cache cleanup on last-good;
the later flip controller still owns restart and postflight acceptance.
The proof never launches an app or model.

The snapshot includes rc/shim/runtime, current link, control/public recovery
launchers, both plists, shared TOML/pick/cache, settings and the validated M0
receipts and physical layer records/backups. Every absolute home/root/app,
tool, config, pick, journal and recovery reference is relocated. Library
directories are empty storage placeholders. External link targets, indirect
parents, malformed authoritative records and unsupported starting states fail
without repairing or changing the source. Authentication is never copied.

Comparisons name each differing byte hash, mode, link or absence. Full Off
uses the recorded initial/pre-M0 baseline; router-only uses the router's
original before-state and explicitly verifies retained adapter targets,
including its public recovery forwarder. Last-good uses immediate pre-upgrade
bytes. Existing settings retain their bytes/mode and unknown fields; newly
created retained preferences must match planned defaults captured before any
test perturbation. Private recovery, `RECOVER.txt`, backups, journal lifecycle,
pins and physical `POPPED` evidence are validated separately. They are not
blanket exclusions. SQLite coordination storage is inspected only by metadata
or SQLite-aware APIs; source databases/sidecars are never copied or hashed.

Owned model caches follow the selected recorded cleanup action. Full/router
Off and Bash last-good may remove one only after a fresh raw backup in that
exact layer, with the pre-perturbation bytes, file mode `0600` and private
parent mode `0700`. Node's file/job last-good simulation leaves its cache
byte-exact. Unrelated/absent caches stay exact. Missing, reused, duplicate,
misplaced or changed backups fail by name; an existing Bash backup conflict
remains a truthful refusal with both source records preserved.

`OnPlan.recoveryCommands?: RecoveryOptions['commands']` is a generation-time
test seam for the five validated absolute tool paths. The installer rejects
invalid paths before artifacts and passes these same paths into every recovery
publication. Production callers omit it and keep system defaults; there is no
ambient configuration or command-line override. Scratch supplies stateful
tools from the first publication, including exact UID/service/domain job
evidence and positive app-down observation. Unknown state refuses recovery.

Every Bash invocation has a deadline and its owned process family is reaped
before exact scratch removal. Unknown cleanup ownership retains the scratch
home. The packaged supervisor resolves from the executing immutable control
library's compiled layout, never from a relocated placeholder library. Its
Node process is proof infrastructure; recovery itself remains system Bash/JXA
without Node on PATH. The subprocess CWD, HOME, CODEX_HOME and TMPDIR all
belong to the admitted scratch home; its sandbox denies network and writes
outside that home and `/dev/null`. Bash heredoc temporary files therefore
remain inside the same owned home. On caller termination the supervisor reclaims only its
identified route home after owned descendants terminate; the outer proof
directory can remain for the caller to inspect. Failure output names differences and preserves the validated failure
authority before removal; the source home remains read-only. These isolated
routes do not certify installed jobs, actual authentication or model behavior.

## On, off, and restart

Run these commands from Terminal or another app. They refuse when the configured
ChatGPT.app is an ancestor of the caller, since quitting it could kill that caller.
The default runs in a detached process, follows its progress log, and returns its
exit code. Closing the caller leaves the detached runner working.

```bash
anyengine on --yes --lib <installed-version> --auto-rollback
anyengine off --yes --router-only
anyengine off --yes
anyengine restart --yes
```

`on` first admits the selected immutable installed library, current evidence and
app version. It waits for quiet, refuses a staged app update, plans the install
without target writes, and proves recovery on an independent scratch copy. It
publishes private recovery instructions and pins before quitting, then checks
quiet and staged state again. Only after confirmed app exit does it apply files,
load jobs, migrate shared model preferences and clean the owned models cache.
It checks the selected router, reopens the app, and runs the ten postflight checks
against the frozen code, settings and app identity.

`off --router-only` returns to the adapter layer. Full `off` restores both layers
and the original public launchers. It records intent before quitting and restores
files, jobs, shared preferences and cache only after confirmed exit. Completed
layers keep their journal and recovery pins through reopen and terminal checks;
retirement after those checks is metadata-only. `restart` keeps the current
installation, cleans its owned cache while the app is down, and verifies the
reopened state against the captured identity.

| Flag | Meaning |
| --- | --- |
| `--yes` | Confirm the restart; required outside an interactive terminal. |
| `--foreground` | Run in this process, mainly for diagnosis. |
| `--no-follow` | Return after spawning; use the printed log and `status` for completion. |
| `--wait-quiet N` | Wait up to 0–60 minutes; default 0 refuses immediately when busy. |
| `--force` | Skip quiet waiting for `off` or interrupted recovery. Forward `on` and `restart` still require quiet. |
| `--lib VERSION` | `on`: use this installed immutable library. Otherwise use the executing installed library. |
| `--auto-rollback` | `on`: restore the last good state when installation or postflight fails. |
| `--dry-run` | `on`: inspect, plan and prove recovery in scratch; create no target log, marker, lock or other artifact. |
| `--native-proof FILE` | `on`: validate a correlated native receipt against frozen code, full key and configured mode. Unsupported or mismatched receipts explicitly choose bridge; invalid bytes refuse. |
| `--router-only` | `off`: retain the adapter layer and its recovery authority. |
| `--no-restart` | `on`/`off`: require positively confirmed app-down and leave it down. `on` returns 1 with postflight pending and recovery retained. |

The installed mandatory deployment gate runs through the smoke producer and its
correlated terminal receipts, even if scheduled smoke is disabled. Failed or
uncertain work refuses successful publication. Source wiring and synthetic tests
do not certify a successful live deployment; installed/native acceptance remains
pending. Synthetic tests use no model work, authentication or live app changes.

The private progress log is `~/.anyengine/state/flip-<id>.log`; the marker is
`~/.anyengine/state/flip.json`. Logs are bounded and older logs are pruned while
preserving active recovery. A PID/start/token/inode lock excludes concurrent
flips. Lock age cannot displace a live owner, and unknown process inspection
refuses takeover. Preserve SQLite coordination files and their sidecars.

A failed or unknown quit preserves the dependencies and does not reopen an app
whose quit was never confirmed. After confirmed quit, a `finally` always attempts
to reopen, including after restoration errors. SIGTERM/SIGINT request recovery;
before mutation they preserve the working state, and after mutation they restore
as far as possible before reopening. Detached runners ignore SIGHUP.

For an M1 operation, automatic recovery tries the immediate last-good M1 checkpoint before the initial
router baseline, then the original vanilla baseline if postflight fails. Staged
updates are expected on recovery; the reopened version is verified again. A
restoration or evidence failure retains authority for retry rather than escalating
past an uncertain state.

M2 activation instead targets the immediate verified M1 baseline through its separate [durable M2 recovery command](./claude-code.md#recovery). After that command restores the M1 bootstrap, use the retained absolute command to resume; the old M1 dispatcher cannot interpret M2 phases.

After a killed M1 runner, the next installed `on`, `off` or `restart` first recovers
the interrupted operation, keeps its original journal identity across repeated
interruptions, and returns 1. Run the desired command again after recovery. Busy
recovery waits or requires `--force`; invalid evidence remains untouched. If a
public launcher has reverted to an older version, use the exact Node-free command
printed before mutation and retained in `~/.anyengine/RECOVER.txt`, whose stable
entry is `~/.anyengine/recovery/anyengine-off`. Do not delete the marker, backups
or pinned libraries to bypass a failed recovery.


## Updates

AnyEngine detects and reports app updates; it cannot reliably hold Sparkle
updates (D8). A staged update produces one notice for the current app version.
`anyengine smoke --scheduled` checks the update first, then runs periodic full
smoke when enabled and its previous full result is older than 20 hours, or an
update just passed. Disabling periodic smoke does not waive mandatory update
verification on an explicitly invoked watcher. `anyengine smoke --force` retries
that verification, bypassing attempt backoff while preserving identity, ownership,
quiet-app and verification checks.

Each production adapter app-server start freshly generates the selected Codex's
complete JSON schema artifact set. The hash covers sorted relative file paths,
sorted object keys and unchanged arrays. A successful fixture result is reusable
only for the same library, shipped fixture suite and schema hash. The focused
suite checks the existing posture mappings and Rust protocol fixture envelopes
and methods; it is not an exhaustive JSON-schema validator. Same-version schema
drift invalidates native fan-out proof. Mock and utility commands publish no
production compatibility success.

Startup has a 30-second total deadline: up to 20 seconds for version, schema and
focused fixtures, reserving the existing producer lock's 10-second maximum.
Version probing retains its 2-second limit. Publication uses only the remaining
budget; the Unix launcher waits 35 seconds before bounded owned-family cleanup.
Stdio and Unix rejection delegates the original arguments to vendor Codex;
stdio input remains unread. Direct WebSocket startup fails with a typed
`direct-cli-required` diagnostic and exit 78. It opens no replacement listener.

Full installed update verification separately requires the fresh schema and
fixtures, zero-spend wire capture, and correlated restricted OAuth, real-config
Claude PTY and GPT work through the installed mandatory gate. Native fan-out is
also checked when enabled; its failure alone retains bridge routing. A failed
update remains blocked even if startup fixtures later pass. The watcher attempts
safe router-only Off through the existing detached runner, with a one-minute
quiet wait and its actual completion status. Busy, interrupted or failed recovery
retains the block and recovery evidence. Automatic attempts back off from one
minute up to six hours; a live verifier excludes concurrent attempts.

`anyengine status` and `anyengine doctor` report startup failure, full-update
failure, pending attempts and the last successful schema/library identity
separately. `state/drift-failed` is a two-line diagnostic summary; the selected
binary's update block supplies fallback authority. Invalid or unreadable saved
bytes are preserved and refuse verification. Only successful full installed
verification clears the update block. Local schema rejection alone does not
restart the app.

## Codex CLI host

Run `anyengine codex [codex arguments...]` to open the selected bundled Codex
CLI against a private loopback adapter. Its model picker includes Claude, with
the configured mode and router path. The CLI inherits your terminal and input;
exiting it stops the adapter and joins the process groups owned by this launch.
It does not edit global Codex configuration or shell startup files.

The host generates a fresh bearer in memory for every run. It refuses every
WebSocket Origin header, including an empty one, and requires the exact bearer.
The selected vendor must advertise `--remote-auth-token-env` in an isolated help
probe; missing support refuses startup. Remote URL/token flag overrides are
rejected. A typed adapter schema refusal can invoke that same selected vendor
CLI directly, only after the failed adapter is fully stopped; binary drift and
other startup failures refuse launch.

**Suspend/resume is unsupported.** Ctrl-Z or a stopped vendor job ends this host
with a failure, restores the terminal foreground, and stops its owned CLI,
adapter and descendants. It never resumes, restarts or replays the input/turn,
and it does not delete existing user sessions. Normal exit status and
interrupt/terminate/hangup handling are preserved.

The installed `lib/current/scripts/probe-remote-headless.mjs` checks the actual
authenticated WebSocket protocol without driving the interactive TUI. It reads
the installed verifier and frozen full identity/mode, checks matched GPT/Claude
terminal results and native fan-out receipts when eligible, then releases only
its owned threads and Claude sessions. `--mode agent|model` asserts the current
mode; `--project DIR` chooses a fixed canonical Claude project outside temporary
directories. The default is `~/.anyengine/smoke/claude-project`. Run-owned state
sits beside that project and is retained if cleanup cannot be proved. This probe
performs real model calls; installed/live acceptance is a separate check.
