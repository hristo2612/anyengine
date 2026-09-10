# A3 — live flip to anyengine, with rollback

Date: 2026-09-10, 02:12–02:30 local (2026-09-09T23:12–23:30Z). Host: the Mac
that runs ChatGPT.app 26.901 as a daily driver. Build flipped: this checkout at
`ca6bdb2` (`npm ci && npm run build`, Node 24.13.0).

## What changed

| File | Before | After |
| --- | --- | --- |
| `~/bin/codex` | claude-codex shim (reads `~/.claude-codex/runtime.env`, `CLAUDE_CODEX_*`) | `scripts/codex-shim` from this checkout, byte-identical, mode 755 |
| `~/.anyengine/runtime.env` | did not exist | new file: every `CLAUDE_CODEX_*` key renamed to `ANYENGINE_*`, route `jinn-pty` → `anyengine`, `ANYENGINE_ADAPTER` → this checkout's `dist/src/adapter.mjs` |
| `~/.codex/anyengine/` | only a debug log from earlier testing | `state.sqlite` (33 threads), `config.json`, `runs.jsonl` copied from `~/.codex/claude-codex-adapter/` while both adapters were stopped, so the app's thread history survived the move to the new adapter home |

Not changed: `~/.zshrc` (its `CODEX_SHELL`-guarded `CODEX_CLI_PATH=$HOME/bin/codex`
export still points at the same path), `~/.zshenv`, `~/.claude-codex/runtime.env`
(left intact as the rollback source), `~/.codex/config.toml`.

`~/.zshenv` and `~/.zshrc` still source `~/.claude-codex/runtime.env` for SSH
sessions. That is harmless: the shim copies the legacy names onto the new ones
only when the new name is unset, and then sources `~/.anyengine/runtime.env`,
which sets every migrated key explicitly. Verified on the live daemon's
environment.

## Backup and rollback

Backup directory: `~/.anyengine/rollback-20260909T231247Z/`

- `codex.shim.bak` — the pre-flip `~/bin/codex`
- `claude-codex-runtime.env.bak` — the pre-flip `~/.claude-codex/runtime.env`
- `zshrc.bak`, `zshrc-codex-snippet.txt` — reference copies (the flip did not edit either)
- `ROLLBACK.sh` — restores both files, parks `~/.anyengine/runtime.env`, quits
  ChatGPT.app, waits for orphaned app-server adapters (terminated by pid, each
  one printed first), reopens the app

Rollback command:

```bash
~/.anyengine/rollback-20260909T231247Z/ROLLBACK.sh
```

The copy step was exercised before the flip with `ROLLBACK.sh --copy-only`
(restore-onto-identical-files, then `diff` against the backups: identical, mode
755 preserved). The restart half was not exercised — it is the same quit/open
sequence the flip itself used successfully.

## Timings

Old daemon and stdio adapter stopped at 23:15:26Z; app relaunched 23:17:48Z
(one extra quit/open cycle because an SSH bootstrap re-started the *old* daemon
in the second between the state copy and the shim install — see "Open items").

- local host (stdio): `initialize_handshake_result outcome=success transportKind=stdio durationMs=952` at 23:17:50.693Z — 2.7 s after `open -a`
- remote host (ssh localhost): `app_server_bootstrap` 1435 ms, then
  `initialize_handshake_result outcome=success transportKind=websocket durationMs=5` at 23:17:54.361Z — 6.5 s after `open -a`

Both connected on the first attempt; no bootstrap timeout, no shim diagnosis
line in the app log. Total time with the app down: about 2.5 minutes.

## Verification

**Grok in the app — pass.** New thread in the remote "Claude playground"
project, model picker → Grok 4.6, prompt `Reply with exactly the word PONG`:
answered `PONG`, "Worked for 3s". [a3-grok-pong.png](a3-grok-pong.png). The
picker itself, served by the new adapter, is in
[a3-model-picker.png](a3-model-picker.png) — Claude Fable 5.1 / Opus / Sonnet /
Haiku, Grok 4.6 / 4.5.

**Claude in the app — blocked by the environment, not by the flip.** The same
prompt on Claude Sonnet failed instantly with
`Claude Code turn failed (authentication_failed)`
([a3-claude-remote-auth-failure.png](a3-claude-remote-auth-failure.png)), twice.
Root cause, verified:

```
$ ssh -o BatchMode=yes localhost 'security find-generic-password -s "Claude Code-credentials" -a "$USER" -w; echo rc=$?'
rc=36    # errSecInteractionNotAllowed
```

The `claude` CLI keeps its subscription OAuth token in the macOS login keychain,
and a process in an SSH session cannot read it — so every PTY the *remote* twin
spawns fails authentication in under 100 ms. The pre-flip claude-codex adapter
logged the identical `authentication_failed` on 2026-09-09T07:55:03Z, so this
predates the flip and a rollback would not fix it. The local (stdio) host is
spawned by the app inside the GUI session and reads the keychain normally.

**Claude on the local host — pass in the app, after two reversible flags (see
below).** Before them the app's local project could not select Claude at all:
the account's Codex usage is 100 % spent (resets 15 Sept), so the desktop forced
reserve mode and hid the whole model picker on a host that reports a ChatGPT
account. Claude was also verified with the adapter's own smokes against the live
`~/.anyengine/runtime.env`, all four green
([a3-smokes.txt](a3-smokes.txt)):

| Smoke | Result |
| --- | --- |
| `smoke:anyengine` | pass — `PONG`, plus a `Bash` approval round-trip (re-run after the flip: pass again) |
| `smoke:grok` | pass — `grok-4.6`, `PONG`, and an approval for `rm -f` |
| `smoke:bridge` (`claude`) | pass — a sonnet thread spawned a grok-4.6 session through the `anyengine` MCP bridge and relayed `GROK SAID: GROKPONG` |
| `smoke:native-codex` | pass **without GPT turns** — the real Codex child forwarded `You've hit your usage limit … try again at Sep 15th`; the claude leg of the same run answered `PONG` on opus with the live `CODEX_HOME` |

Native GPT is therefore unverified end-to-end: it is quota-blocked, not broken.
Re-run `npm run smoke:native-codex` after 15 Sept.

## Follow-up, 02:31–02:38 local — Claude answering in the app

Two reversible flags were added to `~/.anyengine/runtime.env` (the pre-flag file
is backed up beside the others as `runtime.env.pre-flags`), with a dated comment
in the file:

```bash
export ANYENGINE_HIDE_RATE_LIMIT_UPSELL="1"
export ANYENGINE_NATIVE_CODEX="0"
# revert these two on/after 2026-09-15 to restore native GPT passthrough
```

Together they make the local host report an apikey account, which is what the
desktop's reserve gating keys off, so the full model list comes back on local
projects. The cost is native GPT passthrough — the local adapter no longer
spawns a real Codex child — and GPT has no quota until 15 Sept anyway.

After a clean restart (no active turn; stdio handshake 887 ms, websocket 11 ms,
both first try) the local project's picker lists Claude Fable 5.1 / Opus /
Sonnet / Haiku and Grok 4.6 / 4.5, and the "out of Codex usage" banner is gone.
In a new local thread:

- **Claude Sonnet → `PONG`** — [a3-claude-pong.png](a3-claude-pong.png)
- **Grok 4.6 → `PONG`**, "Worked for 2s" — re-checked after the restart, unchanged

The keychain limit is untouched and unchanged: Claude still cannot run under the
SSH twin, and that is pre-existing (see above). Claude in the app now runs on the
local host, where the adapter is a child of ChatGPT.app inside the GUI session
and reads the keychain normally.

## Open items

1. ~~**Revert the two flags on or after 2026-09-15**, when Codex usage resets, to
   get native GPT passthrough back.~~ **Void since 2026-09-10:** A4 replaced
   both flags with automatic reserve handling that keeps the real child and
   follows the limit in both directions. They are gone from the live
   `runtime.env`; see [a4-auto-reserve.md](a4-auto-reserve.md).
2. **Claude over the SSH twin stays unusable while the keychain is unreachable.**
   Either keep Claude on the local host (now the case), teach the shim to
   re-enter the user's GUI session (`launchctl asuser`) before spawning the
   adapter, or hand the CLI a token through the environment. The last option
   puts a credential in a file and was not taken.
3. **Bootstrap race during a flip.** Between stopping the old daemon and
   installing the new shim, an SSH bootstrap started the *old* adapter again and
   it took the control socket. Install the shim *first*, then stop the daemon.
4. A stale, unrelated claude-codex adapter from an earlier acceptance run
   (temp-dir socket) is still alive; it owns nothing the app uses.
