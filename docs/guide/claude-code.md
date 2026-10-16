# GPT in Claude Code

M2 adds a locally accepted Claude Code face to the existing local router. Live
acceptance passed with Claude Code 2.1.289 and bundled Codex 0.160.0. Ordinary Claude requests pass through to Anthropic;
available GPT requests use the official Codex process for authentication and
AnyEngine's Messages-to-Responses translation. Claude Code executes the tools.
The translator does not start a Codex tool-executing thread or provide a login.

`npm run setup` enables this path through `anyengine on`, which installs the Claude layer after a healthy router supplies a
current GPT catalog. It merges the local base URL, pinned Claude Haiku auxiliary
model and gateway hint setting into your user settings. It preserves permission
rules, hooks, credentials, built-in picker behavior and existing user rows.
Generated GPT agents contain only name, description and model frontmatter with a
blank body. Existing unowned agent files are retained and reported as collisions.

Use the current-session selection (`s`) in `/model` when experimenting. Saving a
GPT default affects future sessions. GPT aliases such as `[1m]` retain their
requested name; they do not promise a million-token GPT context. The backend's
validated catalog determines the actual context budget and supported effort.

## Recovery

For an installation upgraded through the milestones, first restore M2 with
`anyengine rollback m3` if M3 is active. Then restore the retained M1 installation:

```bash
anyengine rollback m2
```

A fresh full-v1 installation has no historical M1/M2 baseline. Use
`anyengine off` to restore its original settings and routing.

The initial Node-free public entry also supports:

```bash
/bin/bash "$HOME/.anyengine/bin/anyengine-off" --m2-only
```

Both hand off to the durable command printed before activation:

```bash
/bin/bash "$HOME/.anyengine/recovery/m2/recover.sh"
```

Use that absolute command to resume an interruption or repeat recovery after
M1 has been restored. The restored M1 launchers do not understand M2 options.
For a custom installation root, use the exact retained command in its
`recovery/m2/RECOVER.txt`.

M2 recovery restores the captured M1 library, controls, layer records and prior
job state. It keeps the private recovery evidence and refuses foreign or edited
authority. A settings or generated-agent conflict keeps the functioning M2
router and reports the exact file that needs resolution.

Full `anyengine off` and `off --router-only` are broader operations. They undo
the dependent Claude layer before removing router routing. Unrelated settings
edits and added picker rows survive; edited owned fields or agents can refuse
the operation. An owned saved GPT default is restored to its prior value or
removed when routing goes away. Already running Claude sessions cache their
environment: start a fresh session after off. Recovery does not kill them.

## Diagnostics and checks

`anyengine status --json` reports `claudeCode` settings, model IDs, broker source
kind/generation/readiness and translation version without credentials.
`anyengine doctor` checks attribution, the installed CLI fixture, local routing,
owned picker rows and possible higher-priority settings or credential overrides.
A ready GPT broker is separate from transparent Claude health.

The GPT bearer comes from the active account's own Codex login. The router reads
`auth.json` in that Codex home each time it needs a bearer (at most every five
minutes, or at once after a refusal) and keeps it only in memory. It never
refreshes or writes the login: when the bearer is expiring, or OpenAI answers
HTTP 401 and the file still holds the same bearer, one short-lived official
`codex app-server` refreshes it, exactly as Codex would. Official children run
one at a time, and a bearer refused again within five minutes of a refresh is
not refreshed again, so a retrying client cannot spend the shared single-use
refresh token in a loop; a new login on disk is used at once. No app, adapter or
codex-anywhere process is borrowed, so their restarts no longer decide which
bearer the router holds. Each GPT request gets at most one fresh read after a
401; a second refusal returns HTTP 401 (`gpt_login_refused` from the model
catalog, `authentication_required` from Responses), which clients do not retry
in a loop. After a refresh that failed outright, the next one waits a minute.

`anyengine doctor` then says so plainly: "OpenAI refused the GPT login with
HTTP 401 on /models at <time> and no GPT call has succeeded since ... run codex
login for the active account". The router log records `gpt.upstream-rejected`
and, once a later request succeeds, `gpt.upstream-recovered`. A 401 on the Codex face
(`models: HTTP_401` in router health) is the app's own login, which the router
forwards unchanged; doctor names that case separately.

When scheduled smoke is enabled, `claude-code-gpt` performs one bounded Read of
the fixed smoke marker and requires its tool result followed by PONG. It restores
an existing marker and joins its owned process family. It then runs one more
turn with your real settings and whole tool surface, MCP servers and claude.ai
connectors included, and requires PONG. In that turn a flag-scope PreToolUse
hook refuses every tool call, so no tool runs whatever your allow rules say; a
tool the model tries anyway must show that refusal. It also runs in plan mode,
without Bash and Agent, for at most two turns, with no saved session. Your own
session hooks still run, as for any Claude session. If any Claude setting
could switch hooks off (`disableAllHooks`, managed policy, MDM, safe or simple
mode), the turn is skipped as unknown, which keeps an earlier failure marked. Both turns pin
the router URL in flag settings, which outrank a base URL in your own
settings.

Claude Code 2.1.30x can change its tool set mid-conversation: a `system`
message adds tools (`tool_addition`) or removes them (`tool_removal`), tools
marked `defer_loading` stay off until added, and ToolSearch results name the
tools they load (`tool_reference`). claude.ai connectors arrive this way. GPT
gets the tools that are on at the end of the conversation as ordinary function
tools; the text of such a system message still reaches it. Failure degrades only
that path and uses the existing once-until-pass notification. Disabling smoke
prevents this scheduled model work.

The isolated Claude 2.1.289 posture capture proves default and dontAsk child
inheritance with native tool denials. Plan denied Agent launch, so its child
checks remain unexercised. The interactive picker displayed GPT and Claude rows,
and a session-only GPT selection passed without changing the saved default.
These checks do not establish every permission mode. See the
[M2 acceptance record](../evidence/m2-acceptance.md) for evidence and limits.
