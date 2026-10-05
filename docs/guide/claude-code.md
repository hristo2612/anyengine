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

When scheduled smoke is enabled, `claude-code-gpt` performs one bounded Read of
the fixed smoke marker and requires its tool result followed by PONG. It restores
an existing marker and joins its owned process family. Failure degrades only
that path and uses the existing once-until-pass notification. Disabling smoke
prevents this scheduled model work.

The isolated Claude 2.1.289 posture capture proves default and dontAsk child
inheritance with native tool denials. Plan denied Agent launch, so its child
checks remain unexercised. The interactive picker displayed GPT and Claude rows,
and a session-only GPT selection passed without changing the saved default.
These checks do not establish every permission mode. See the
[M2 acceptance record](../evidence/m2-acceptance.md) for evidence and limits.
