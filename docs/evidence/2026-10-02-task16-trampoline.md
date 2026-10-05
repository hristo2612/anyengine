# M1 Task 16: restricted model-mode trampoline

This record supersedes the initial Task 16 launch after independent review
against Claude 2.1.287. The initial implementation was `100c1c4`; fixes are on
`m1/t16`, based on `8103b08`. Nothing was installed or pushed.

## Corrected launch

Ordinary turns use:

```text
claude -p --restricted --disable-slash-commands
  --input-format stream-json --output-format stream-json --verbose
  --model <model> --permission-mode <default|plan>
  --tools ToolSearch[,WebSearch]
  --disallowedTools Read,Glob,Grep,LS,NotebookRead,TodoWrite,ExitPlanMode,Bash,BashOutput,KillShell,KillBash,Monitor,Write,Edit,MultiEdit,NotebookEdit,WebFetch,Task,Agent,TaskStop,AskUserQuestion,CronCreate,CronDelete,ScheduleWakeup,SendMessage,SendUserMessage,PushNotification,RemoteTrigger,LSP,Workflow,EnterWorktree,ExitWorktree,Artifact,Skill,SlashCommand
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --setting-sources user
  --settings '{"disableAllHooks":true,"disableSkillShellExecution":true}'
  --append-system-prompt <guidance>
  [--include-partial-messages] [--permission-prompts none]
  [--effort <level>] [--resume <sid>] [--fork-session]
```

- Help must advertise `--tools`, `--restricted` and `--disable-slash-commands`;
  otherwise the turn fails closed. Other capability flags remain optional.
- No native read tools: the earlier posture model could not represent Codex's
  read-deny profiles/globs. Reads must go through Task 17's Codex executor.
- WebSearch appears only for an offered `web_search` tool with
  `external_web_access === true`. Missing, disabled and cached search omit it.
- Restricted mode ignores user, project and local settings, including
  `apiKeyHelper`, user environment overrides, skills and commands. Flag settings
  disable hooks and skill shell execution. Vendor-managed settings still apply.
- Strict MCP config loads no server in Task 16. The builder allows only the
  trusted `codex` entry for Task 17 and uses `--allowedTools mcp__codex` when
  Codex tools are offered outside plan mode. No bypass-permissions flag exists.
- Ordinary prompts cannot invoke slash commands. Only the fixed `/compact`
  invocation removes `--disable-slash-commands`; it accepts no user command.
- TodoWrite and ExitPlanMode are absent. Plan text comes from the successful
  result and is wrapped in `<proposed_plan>`; partial plan text is not duplicated.

## Trusted cwd and environment

`runTrampolineTurn` now requires `trustedCwd: string | null` and
`engineRoot: string`. `compactTrampolineSession` takes the same two fields
instead of the old `cwd` field. **Task 17 must obtain trustedCwd from the owning
adapter's thread record, never request text or parsed.cwd.** An invalid supplied
cwd fails; null uses an empty, private `<engineRoot>/router/trampoline-cwd`
directory. The runner ignores cwd tags in user messages and never falls back
to the user's home.

The child environment is built from an empty object. Inherited keys are only
PATH, HOME, USER, LOGNAME, LANG, LC_* locale keys, TMPDIR, TERM and
CLAUDE_CONFIG_DIR. The adapter sets its own CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH
(minimum 2048) and MCP_TOOL_TIMEOUT (86400000 ms). Credentials, backend selectors,
proxy variables, TLS overrides, NODE_OPTIONS and managed-settings path overrides
are absent. This applies to probes, ordinary turns and compaction.

Compaction keeps `--verbose --output-format json` and parses the returned JSON
array's final result, including pretty-printed arrays. Output is bounded to
4 MiB; timeout, parse failure or an error result returns a null session.
The fake models the real array shape and plan-result text.

## Test-first and mutation evidence

New regressions first reproduced slash execution, native reads, a prompt choosing
`/` as cwd, inherited unknown credential variables, missing isolation-capability
checks, broken array compaction and the missing plan wrapper. After fixes,
38 trampoline/posture tests passed.

The bounded property test traverses exactly 3,080 postures. It checks actual argv,
requires ToolSearch availability (nonempty coverage), forbids all native reads,
unknown tools, delegation, unrestricted settings and slash execution. The
live-search permission cases are additionally tested through spawned fake argv.

Four production mutations were applied independently, rebuilt and tested through
the hermetic runner. Each failed its regression; original source was restored:

| Mutation | Detection |
| --- | --- |
| Remove ordinary `--disable-slash-commands` | Slash prompt side effect/property failure |
| Restore Read to the built-in allowlist | Property fails with `Read` |
| Remove `--restricted` | Property fails on missing restricted flag |
| Start child env with `{ ...process.env }` | Unknown `ANTHROPIC_FUTURE_SECRET` reaches child |

The fake's own configuration is now embedded in a disposable fake executable;
production does not allow test-only environment variables through its boundary.

## Zero-spend real CLI proof

Reproducible command (after build):

```sh
node scripts/probe-trampoline-isolation.mjs \
  "$(command -v claude)" "$FIXED_PROJECT" "$NEW_STATE_DIR"
```

The state directory must be new, beside the fixed project and outside TMPDIR.
The check uses an isolated HOME and CLAUDE_CONFIG_DIR, a fake API key and a
loopback Messages API. `sandbox-exec` denies all non-loopback outbound traffic,
all writes outside the probe state, and reads of the real Claude/Codex/AnyEngine
homes. The fake endpoint/key are deliberate probe-only additions after the
production environment allowlist. No OAuth credentials are read or copied.

Verified on **Claude Code 2.1.287**:

- `/config permissionMode=acceptEdits` was refused as unavailable.
- The backend observed **no offered tools** with the empty MCP config.
- A deliberately injected Read call was refused with **No such tool available: Read**;
  the read canary did not enter output.
- Hostile apiKeyHelper and hook markers were not created; user settings were
  byte-for-byte unchanged; hostile skill/command markers did not reach the API.
- Hostile user environment settings did not divert the call to Bedrock or their
  bogus API endpoint. Both Messages requests reached the loopback fake API.

Machine-readable sanitized results: `2026-10-02-task16-real-cli.json`.
**Real OAuth login with --restricted remains unverified. Task 30's authorized
live gate must verify it.** This check spent no provider tokens.

## Final verification

All commands used the prescribed external-volume TMPDIR/npm cache. The three
full runs below were consecutive on unchanged implementation/test sources.

| Gate | Exit | Seconds | Load before (1/5/15 min) | Load after | Result |
| --- | ---: | ---: | --- | --- | --- |
| check | 0 | 0.65 | 1.69 / 2.23 / 2.73 | 1.69 / 2.23 / 2.73 | Pass |
| typecheck | 0 | 1.30 | 1.69 / 2.23 / 2.73 | 1.96 / 2.28 / 2.74 | Pass |
| test-1 | 0 | 43.03 | 1.96 / 2.28 / 2.74 | 3.68 / 2.76 / 2.90 | 547 passed; 85.55% lines |
| test-2 | 0 | 43.11 | 3.68 / 2.76 / 2.90 | 6.08 / 3.61 / 3.21 | 547 passed; 85.57% lines |
| test-3 | 0 | 42.15 | 6.08 / 3.61 / 3.21 | 5.85 / 3.94 / 3.36 | 547 passed; 85.54% lines |

No failures, cancellations, skips or hermetic leftovers. All size, complexity,
dependency and environment-documentation ratchets passed. Biome reports existing
warnings plus informational template-style suggestions in the ported fake.
New source maximum: 360 lines. No new runtime dependencies or env settings.

The committed worktree remains available for review. Task scratch and isolated
real-CLI proof state are removed after retaining this sanitized evidence.
