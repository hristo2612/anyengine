# Optional session browsing and cross-open

Browse Claude Code and Codex/ChatGPT coding conversations from one CLI. Search
titles and conversation text, then copy a conversation into the other tool and
continue there. These features use local history; ordinary ChatGPT web chats,
Claude Desktop chats and Grok history are outside this feature.

Both **session browsing and automatic sync start off**. Enabling browsing does
not enable automatic sync or run any model requests:

```bash
anyengine sessions on
anyengine sessions status
anyengine sessions list
anyengine sessions search "the auth bug"
anyengine sessions list --cwd "$PWD" --limit 50 --json
anyengine sessions show claude:YOUR-SESSION-UUID
```

Use the exact `claude:UUID` or `codex:UUID` printed by `list`. Browsing and search
leave conversation files unchanged. Codex may maintain its own history index
through its official app-server API. Search includes message text, rather than
only titles. Results are newest first, with the source and copied-history marker.
Archived Codex conversations are included and marked; paginated histories are
read through the vendor's full-turn API.

## Cross-open

```bash
# Copy Claude history into the normal ChatGPT Codex workspace history list.
anyengine sessions open claude:YOUR-SESSION-UUID --in chatgpt

# Copy Codex history into Claude Code; print the resume command.
anyengine sessions open codex:YOUR-SESSION-UUID --in claude

# Launch the other CLI immediately and choose its model.
anyengine sessions open codex:YOUR-SESSION-UUID --in claude --model gpt-6-sol --launch
anyengine sessions open claude:YOUR-SESSION-UUID --in codex --launch
```

`open` creates a native conversation copy titled `[AnyEngine from Claude] …` or
`[AnyEngine from Codex] …`. Without `--launch`, it prints the destination and a
resume command. With `--in chatgpt --launch`, it opens ChatGPT; select the marked
conversation in its coding workspace history. The browser itself remains a CLI
feature. ChatGPT and Codex share the same local Codex history.

The destination runs its selected model. Continuing with GPT in Claude Code
requires AnyEngine's existing GPT routing setup. You can also change models
normally after opening. Claude resume commands fork the imported copy, keeping
the reusable history intact.

Reopening unchanged source history reuses its existing copy. If the source has
new messages, cross-open creates a new snapshot. Use `--fresh` to create another
branch even when the source is unchanged. Deleted copies can be recreated.
Original conversations and continued destination branches are never overwritten.

Copies carry conversation text, with Claude tool results flattened into text and
images marked as omitted. Native tool execution state, reasoning blocks, undo
state and approvals are not transferable. Opening or syncing does not execute
imported tool calls. A continuation makes normal authenticated model requests
using the destination's existing login.

## Choose whether to sync

```bash
anyengine sessions sync                 # One explicit batch, up to 100 new conversations
anyengine sessions sync --cwd "$PWD"    # One project only
anyengine sessions sync on              # Enable automatic copying of new conversations
anyengine sessions sync off             # Stop automatic copying
anyengine sessions off                  # Disable both session options
```

Automatic sync checks once a minute while AnyEngine's adapter or router is
running, copying up to 25 new conversations per check. No separate service is
installed. Changes take effect without restarting the host. Conversations
modified within the last five seconds are deferred.

Sync copies each original conversation once. It skips marked imports, never
merges divergent branches and never rewrites a copy as either side continues.
Use cross-open again to bring over newer history deliberately. Turning sync off
stops future automatic copies; an import already in progress may finish. Existing
copies remain available and your logins, model settings and original histories
are retained.

Settings are `sessions.enabled` and `sessions.sync` in
`~/.anyengine/config.json`, both `false` by default. Copy mappings live under
`~/.anyengine/sessions/`; actual copies live in the destination's native history.
`CODEX_HOME` and `CLAUDE_CONFIG_DIR` select the vendor history homes.

For local Claude Desktop Code sessions hidden after switching accounts, use the
separate opt-in [Desktop account sharing](claude-desktop.md#optional-sessions-across-accounts)
option. `sessions off` disables cross-engine browsing and copying; Desktop account
sharing has its own `desktop sessions off` control.
