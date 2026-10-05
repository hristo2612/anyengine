# Installation and recovery

The supported local macOS setup is `npm run setup` from a clean source checkout.
See [Getting started](getting-started.md) for prerequisites and first use.

The installed runtime lives under `~/.anyengine/lib/<version>/`. Each version
contains compiled code and production dependencies; cleaning a checkout cannot
remove the dependencies of a running app. `lib/current` selects the active build,
and the Bash launcher pins Node from `runtime.env`.

## Update from a checkout

Finish active app work, obtain the intended source revision, and run setup again:

```bash
npm run setup
```

Setup stages a verified build before activation. The existing `on` command owns
backups, app restart, postflight checks and automatic rollback. A clean Git tree
is required so the installed version can be reproduced. Do not delete unrelated
uncommitted files just to satisfy that check; use a clean checkout instead.

A fresh v1 install uses the full layer recovery path. Subsequent direct-v1
updates retain their immediate prior layer checkpoints. Installations upgraded
through M1/M2 also retain their existing milestone-specific recovery.

## Stage without enabling

```bash
npm run setup -- --stage-only
```

This installs dependencies, builds and verifies the library without moving
`lib/current`, editing shell or Claude settings, loading jobs, or restarting the
app. It prints the exact command to activate the staged version later.

For maintainers who already built the source:

```bash
node scripts/install-lib.mjs --no-activate
```

`install-lib` preserves libraries referenced by running adapters and recovery
records. Its `--activate VERSION` option only moves the verified library pointer;
use `on --lib VERSION` for the full managed activation and live checks.

## Shell and configuration

Setup supports zsh (`~/.zshrc`) and bash (`~/.bash_profile`). On fresh installs, the
managed shell block puts `~/.anyengine/bin` on PATH and sets the app's Codex entry only when
ChatGPT.app imports its shell environment. Ordinary terminal Codex keeps its
normal entry. Off restores the owned changes while preserving unrelated edits;
conflicting edits are reported for resolution.

Older installs preserve their existing shell block to keep retained recovery
working. Use the absolute launcher or `export PATH="$HOME/.anyengine/bin:$PATH"`
in a terminal.

Advanced installations can set `ANYENGINE_ROOT` before setup. The generated
launcher, jobs, state and CLI PATH use that root. Do not hand-copy adapters or
point a live launcher into a source checkout.

Current settings live in `~/.anyengine/config.json`. Use `anyengine config` for
inspection and edits. `runtime.env` contains bootstrap paths and legacy backend
overrides. See [Configuration](configuration.md) and [Control commands](control.md).

## Recover a failed activation

Run `anyengine status` and preserve the exact recovery command and evidence
printed by the installer. Automatic rollback attempts to restore a working
baseline after failed activation. Inspection or restore conflicts keep the
recovery records for a safe retry.

```bash
anyengine off
```

For an installation with retained milestone history, the narrower commands are:

```bash
anyengine rollback m3
anyengine rollback m2
```

Those commands require an actual retained baseline; a fresh full-v1 install has
no historical M1/M2 installation to downgrade to. Its full Off path remains
available. If the public CLI is unavailable, use the absolute system-Bash
recovery command retained in `RECOVER.txt`. Do not remove recovery records or
libraries while recovery is pending.

## Remote connections

The adapter still supports the app's SSH Remote flow through `codex app-server`
and `app-server proxy`. The local setup command requires macOS and a local app;
it is not a general Linux or headless remote-host installer.

An advanced remote deployment needs its own installed library, official vendor
clients, login-shell paths and authentication on that host. macOS Keychain auth
can fail under an SSH session; local acceptance does not establish that path.
Use a read-only version probe to check routing:

```bash
ssh host 'command -v codex'
ssh host 'codex --version'
```

Remote protocol examples are in [Using ChatGPT.app](gui.md) and
[Configuration](configuration.md). Do not script the interactive Codex TUI; it
can present a self-update prompt.
