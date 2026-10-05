# Getting started

AnyEngine connects ChatGPT's Codex workspace and Claude Code, so you can use
your Claude and ChatGPT subscriptions from either tool. Switch between Claude
and GPT in the same conversation, and run sub-agents from both providers.
It uses the official vendor clients and your existing local logins. Grok is also
available through its experimental CLI backend.

## Before you start

You need macOS, Node.js 24 or newer with npm, Git, ChatGPT.app, and the official
Claude Code CLI. Use zsh or bash as your login shell. Sign in to ChatGPT.app and
Claude Code through their normal login flows before setup. Grok is optional.

M1–M3 have passed local acceptance and are available in this source checkout.
A packaged release is pending; the package is not currently published to npm.

## Install from a checkout

From a clean AnyEngine Git checkout, run:

```bash
npm run setup
```

Setup installs dependencies, builds and verifies a versioned library outside the
checkout, then runs the existing activation command with automatic rollback.
It asks before restarting ChatGPT.app, refuses while managed work is active, and
checks real GPT and Claude work after activation. These checks use your existing
plans and usage allowances. A staged app update or failed check can stop setup;
follow the diagnostic and retained recovery command instead of forcing it.

For an unattended restart you have already authorized:

```bash
npm run setup -- --yes
```

Open a new terminal after setup. To use the CLI in the current terminal:

```bash
export PATH="$HOME/.anyengine/bin:$PATH"
anyengine status
anyengine doctor
```

Fresh installs manage that PATH entry in your shell configuration. Older installs
keep their existing shell block for rollback compatibility; use the export above
in each terminal. The control launcher
lives at `~/.anyengine/bin/anyengine`. For a custom root, set `ANYENGINE_ROOT`
before setup and use the current-terminal PATH command setup prints.

## Use it

**ChatGPT.app:** open a local coding project or conversation, choose GPT or Claude
in the model picker, and send a prompt. Switch engines in the same conversation
when useful. Ask for mixed sub-agents, for example “spawn seven agents, three on
Opus and four on GPT.” Their results appear in the app's agent view.

A new build starts with the bridge fallback until native fan-out is verified.
To verify native fan-out for that build, run the following live check, then
restart when the app is idle:

```bash
anyengine smoke --paths native-fanout
anyengine restart
```

**Claude Code:** start a new `claude` session and use `/model` to select GPT.
Generated `gpt-*` agents also let a Claude parent delegate to GPT. Select GPT
for the current session when trying it; saving a default changes future sessions.
See [GPT in Claude Code](claude-code.md).

## Accounts and limits

Your existing ChatGPT/Codex login is named Home. One account is enough. You can
add your other accounts through the official login flow:

```bash
anyengine accounts list
anyengine limits --refresh
anyengine accounts add work --label Work
anyengine accounts use work
```

Manual switches wait for managed work to finish, then the next message resumes
on the selected account with context. Automatic rotation and replay start off.
Enable rotation only when you want it:

```bash
anyengine accounts rotate on --threshold 100 --replay none
anyengine accounts rotate off
```

An unavailable usage reading remains unknown. An account marked “needs login”
cannot supply usable usage metadata until you sign in again. Ordinary Codex
processes outside AnyEngine keep their own login. See [Control commands](control.md).

## Turn it off

```bash
anyengine off
```

Off restores managed settings, returns managed account traffic to Home, stops
router jobs and removes AnyEngine model entries from the shared cache. Start a
new Claude Code session afterward because running sessions retain their environment.
The existing library and recovery evidence remain available.

For interrupted operations, preserve the recovery command printed during setup.
[Deployment and recovery](deployment.md) explains staging and retries;
[Using ChatGPT.app](gui.md) covers the picker and approvals.
