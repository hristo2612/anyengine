# scripts/AGENTS.md

Operational scripts. See the [root AGENTS.md](../AGENTS.md) for build/test and
project-wide conventions. These run on Node directly (no build step) and ship as
plain `.mjs` / shell.

## Map

- `codex-shim`: the `PATH` shim Codex App invokes. Routes `codex app-server`
  into the adapter (`ANYENGINE_ADAPTER`), passing the desktop's leading `-c`
  globals through so the adapter can replay them to the real child; forwards
  everything else to the app's own codex (the rule below), and only when there
  is none to `CODEX_REAL` or the first other `codex` on PATH, with a line on
  stderr and a `shim.nonBundledCodex` event. Before it hands the app
  an adapter it runs `adapter.mjs selfcheck`. A failed update block for the
  selected binary routes it to vendor Codex. Production adapter startup freshly
  observes schema compatibility before traffic; `lib/startup-schema.mjs` owns
  the isolated probe and Unix launch channel, whose private pending record
  precedes any child. Unknown cleanup refuses another vendor launch. When that fails (a pruned
  `node_modules`, a half-written install) or a daemon's socket never appears,
  it execs the vendor-bundled codex (`ANYENGINE_REAL_CODEX` while it names an
  executable file, else the app's own codex in whichever layout the installed
  ChatGPT.app ships; `CODEX_REAL` only as a last resort, labelled as such) and
  says so: a
  line in the app log, a `shim.fallback` event in the debug log, and
  `~/.anyengine/shim-fallback.json`, which `npm run doctor` reports until
  `npm run install:lib` succeeds. It resolves the `lib/current` link before
  it launches the adapter, so a running adapter's argv names the version
  directory install-lib's prune must not remove. A daemon launch on the
  app-server control socket goes to the bundled codex unless
  ANYENGINE_REMOTE_NATIVE_CODEX=1: plain codex TUIs attach there. Keep it
  dependency-free and bash-3.2 safe (macOS `/bin/bash`). Its
  `resolve_bundled_codex` is a copy of `src/bundled-codex.mts`: change both
  together; `test/bundled-codex.test.mts` fails when they disagree.
- `smoke-native-codex.mjs` — real smoke for the native-codex multiplexer
  (`npm run smoke:native-codex`): gpt PONG through the bundled app-server,
  native command approval, then a Claude PONG.
- `anyengine-launch` — installed control/launchd entry: source runtime.env,
  resolve the versioned lib, preserve argv and exec pinned Node. Bash 3.2 and
  minimal PATH safe; trims only plain launchd logs in the root's logs directory,
  keeping their inode. Missing lib diagnostics point to retained recovery.
- `anyengine-mode` — host helper to switch runtime backends, restart bridges,
  and read status/logs. Writes `~/.anyengine/runtime.env`.
- `hooks/guard.mjs` — Claude Code hook enforcing project conventions (blocks
  build-artifact edits; warns on non-`.mts` src, misplaced runtime code, and
  files > ~1000 lines). Wired in `.claude/settings.json`. Must exit 0 on any
  internal error so it never wedges a session.
- `doctor.mjs` — environment self-check (`npm run doctor`). It reads the
  environment it is given, so run it with the `runtime.env` under test
  sourced. It applies the legacy `CLAUDE_CODEX_*` names and takes the runtime
  type and the bundled-codex rule from the adapter it checks, and fails while `ANYENGINE_REAL_CODEX` names a codex that
  is gone or a codex child is expected and none resolves.
- `install-lib.mjs`: installs the built adapter and its production
  dependencies under `~/.anyengine/lib/<version>/` from a clean tree, verifies
  it, moves `~/.anyengine/lib/current`, prunes old versions no running process
  names in its argv, and prunes nothing when `ps` cannot say
  (`npm run install:lib`). `--no-activate` stages a verified version without
  moving current or clearing its marker; `--activate VERSION` verifies an existing
  staged version without source/build/npm. Pruning keeps current/staged/previous,
  running and validated control/initial/settled/pending/last-good pins, including
  POPPED evidence. Invalid or unreadable journals refuse staging, activation and
  pruning. `--dest-root` determines the related state and marker root.
- `lib-verify.mjs`: checks an installed lib against its manifest (file
  hashes) and runs `selfcheck --deep`; used by install-lib and doctor.
- `flip-backup.mjs`: backs up the files a live flip touches and writes a
  `ROLLBACK.sh` (`--copy-only` restores files without restarting the app).
- `preflip-check.mjs`: exits 1 while a recent Codex rollout that is not
  explicitly a `codex exec` session's (or is one an app-server holds open, as
  `lsof` and `ps` tell), the adapter log or an in-progress adapter turn shows
  activity, while ChatGPT.app has a Sparkle update staged (the restart would
  install it), or when it cannot tell; run it before an app restart.
- `sync-codex-compat.mjs`: moves the codex version pin (adapter, shim, CI,
  docs) to the bundled codex's version, or `--check`s that every site agrees.
- `smoke-real-claude.mjs` — round-trips a real Claude turn (`npm run smoke:real`).
- `smoke-anyengine.mjs` — real-Claude smoke for the `anyengine` runtime over a
  WebSocket listener (`npm run smoke:anyengine -- --project DIR`, or
  `ANYENGINE_SMOKE_PROJECT=DIR`; with neither it stops, because Claude needs
  one stable folder so runs do not each add a new Claude project entry).
- `lib/claude-scratch.mjs`: the one fixed project folder a live Claude run
  works in (`--project`) and the scratch folder next to it, outside TMPDIR
  and /tmp, that holds the run's adapter and relay state (the probe and the
  anyengine smoke).
- `smoke-grok.mjs` — real-grok smoke for the `grok` runtime: a `grok-*` thread
  over a WebSocket listener, text turn + approved Bash turn (`npm run smoke:grok`).
- `smoke-bridge.mjs` — real smoke for the cross-engine bridge: a claude / grok /
  gpt thread uses the `anyengine` MCP tools to spawn a session or parallel
  sub-agents on other engines (`node scripts/smoke-bridge.mjs claude|grok|gpt`).
- `bridge-mcp.mjs` — launcher for the `anyengine` MCP server (same as
  `node dist/src/adapter.mjs bridge-mcp`), for hand-written MCP configs.
- `anyengine-hook-relay.mjs` — Claude Code hook command for `anyengine`; POSTs
  hook JSON to the adapter's loopback hook server and prints its reply.
- `fix-node-pty-permissions.mjs` — `postinstall`: restores the exec bit on
  node-pty's `spawn-helper`.
- `acceptance-*.mjs` — end-to-end checks (local-remote, gui-ssh-localhost,
  ssh-runtime-matrix); transcripts land under git-ignored `.anyengine/`.
- `probe-*.mjs` — capability / codex-cli-remote probes.
- `probe-terminal-codex.mjs` — installed-library catalog/cache differential.
  `--lib` selects the reviewed build; optional `--codex`, `--old-codex`,
  `--cache-from` and `--config-from` select read-only inputs. Every Codex child
  uses private homes, fake ChatGPT login, loopback backends and outbound denial.
  Only P3a/P4a/M7 use noninteractive `exec`. Failed terminal status or a wire
  model mismatch fails the check. Missing old binary and caches without
  AnyEngine entries remain skipped/not exercised, with exit 2. Its private
  fake proof bootstrap grants no native acceptance authority.
- `probe-acceptance.mjs` — installed-only `picker`, `switch`, `fanout7` and
  `bridge-fanout` observations. Admits the frozen library/key/mode and actual
  router path; both fanout checks use the same seven-child prompt with three
  Opus children. Requires terminal reads, lineage and actual producer receipts.
  The two project fixture names must be absent; cleanup preserves changed
  files. Pending starts precede writes; exact reply observers survive timeout.
  Unknown ownership retains private evidence and fails. Native GUI checks and
  the accepted smoke's proof receipt remain separate requirements.
- `lib/acceptance-evidence.mjs`, `lib/acceptance-lifecycle.mjs`,
  `lib/probe-processes.mjs` — bounded structured
  acceptance checks and private cleanup metadata. Reuse smoke's process family
  observation/joining and exact thread/session ownership, without publishing
  proof or recording prompts/authentication.
- `probe-remote-headless.mjs` — installed-only authenticated CLI-host WebSocket
  probe. Reuses frozen smoke admission and terminal/native receipt verification;
  never drives the interactive TUI. Uses one fixed Claude project and adjacent
  private scratch, releases owned threads/sessions, and joins its adapter family.
  Unknown cleanup retains evidence and fails; it publishes no replacement proof.
- `probe-claude-exec.mjs`: one real, tiny Claude turn in an isolated adapter asked to run `pwd`; passes when Claude used the sandboxed `exec` tool without an approval prompt.
- `capture-codex-wire.mjs`: zero-spend capture of what a bundled codex sends
  to its model backend (isolated CODEX_HOME and HOME for every codex call,
  fake API key, loopback fake backend, `model_catalog_json`; `sandbox-exec`
  denies outbound traffic and writes under the real `~/.codex`, `~/.anyengine`
  and `~/.claude`). Two passes, HTTP fallback and an accepted WebSocket
  (prewarm, a socket reused across turns, a reconnect), each for a
  responses-lite GPT entry and the router's Claude clone with lite off. Writes
  `test/fixtures/codex-wire-<version>.json` (ids as labels, so a rerun writes
  the same bytes; Biome skips the file, so commit it as written) and exits 1
  when a field the router reads is missing. The update gate runs it against
  every new app version and relies on that exit code alone.
- `capture-codex-spawn.mjs`: zero-spend recording of how the bundled codex
  announces a `spawn_agent` child and what the child's model requests carry:
  a fake ChatGPT login (unsigned JWTs) in an isolated home, outbound traffic
  denied by `sandbox-exec`, a loopback fake model backend that answers each
  parent turn with one `exec` call of multi-agent tools, and a second fake
  for the ChatGPT side (workspace routing discovery, which 0.159 needs under
  a ChatGPT login before it sends a model request). Passes: persisted
  threads (the primary: one child over HTTP, two over WebSockets), an
  ephemeral extra, the spawn shapes (no `model`, `fork_context`) and the
  follow-ups (`send_input`, `close_agent`, `resume_agent`), one parent turn
  per step. Writes `test/fixtures/codex-spawn-<version>.json`: ids as labels,
  notifications in canonical order with the guaranteed order stated as
  `orderInvariant` (the link precedes the child's first model request; the
  child's own notifications may precede the link), so a rerun writes the
  same bytes (Biome skips the file); timings go to stdout. Exits 1 when a
  child is not linked, its link does not precede its first model request,
  or a child request does not name its thread and parent as
  `src/codex-wire.mts` reads them. `--login apikey` shows the API-key wire
  for comparison.
- `lib/spawn-recording.mjs`: how the spawn capture labels ids and shapes a
  pass's notifications and requests into the fixture.
- `lib/codex-probe.mjs`, `lib/codex-probe-runner.mjs`: use `isolatedCommand`
  for official help/version/schema work. It owns private homes, probe-only
  sandbox writes, a refusing provider, total deadline and process-group cleanup,
  including supervisor or blocked-caller termination. Reclamation verifies
  current group membership and private-home identity; unknown ownership retains
  evidence. Schema validators and their exact posture/Rust
  fixtures ship in installed libs. The older capture primitives below retain
  their existing call shape for the separate wire/spawn capture scripts.
- `lib/codex-probe.mjs`: what the zero-spend codex captures share: the codex
  they run, the `sandbox-exec` profile (loopback only, no write under the
  real `~/.codex`, `~/.anyengine`, `~/.claude`), and a probe folder whose
  `CODEX_HOME` and `HOME` exist before codex first runs.
- `lib/fake-chatgpt-auth.mjs`: `writeFakeChatgptAuth(codexHome)` writes a
  ChatGPT `auth.json` with unsigned JWTs that `codex login status` accepts
  without the network (0.159 wants a non-empty signature segment); for
  sandboxed probes against loopback fakes only.

## Conventions

- Shell scripts: no Bash-only features in `codex-shim` (it runs under the remote
  login shell). Keep it side-effect free except routing.
- `.mjs` scripts read no build output unless they `npm run build` first (the
  acceptance/smoke scripts do via their npm wrappers).
- When adding a hook, branch on `hook_event_name`, read JSON from stdin, and
  fail open (exit 0) on error.
- `.mjs` scripts are Biome-formatted (`npm run format` covers `scripts/`); the
  shell scripts (`codex-shim`, `anyengine-mode`) are left untouched.
