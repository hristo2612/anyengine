# Using ChatGPT.app

After [setup](getting-started.md), use ChatGPT.app's local coding workspace as
usual. AnyEngine adds cross-engine routing behind the app's existing model picker,
conversation history, agent view and approval controls.

## Pick or switch an engine

Start a conversation and choose GPT, Claude Opus, Sonnet or Haiku. GPT runs
through the real Codex client. Claude runs through the official Claude CLI.
The existing Grok backend also supports Grok selections when its CLI is available.

Change the model mid-conversation to move work between engines. AnyEngine carries
conversation context across the handoff and saves the selected engine for a cold
reopen. An engine switch remains subject to that engine's permissions and context
budget; it does not grant extra access or a larger context window.

## Mixed sub-agents

Ask the parent to delegate across engines, for example:

> Spawn seven sub-agents: three on Opus and four on GPT. Collect their results.

A verified native route uses Codex's agent machinery. An unproven or disabled
native route uses the AnyEngine bridge fallback. `anyengine status` reports the
observed path. See [Cross-engine bridge](bridge.md) and [Router](router.md).

## Tools and approvals

Text and reasoning stream into the conversation. Command and file-change
approvals use the app's existing controls, including live diffs. Tool behavior
follows the thread's access and sandbox policy. Keep using the app's approval
controls for the actions you authorize.

## Account switches

The app continues to show the Home login identity while managed model traffic
can use another registered account. A switch waits for managed work to finish;
your next message continues with context on the selected account. Rotation and
replay are off by default. Inspect accounts and limits through the
[control CLI](control.md).

## SSH Remote

Advanced remote connections keep the app's normal SSH version probe, daemon
bootstrap and proxy flow. The host's `codex` shim routes app-server calls into its
installed adapter. The daemon owns its Unix socket while clients are connected
and idles out after the last client leaves and active work finishes.

Local setup and live acceptance do not establish remote authentication. See
[Installation and recovery](deployment.md#remote-connections) for the limitations.
