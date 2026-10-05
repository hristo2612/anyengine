# M3 local acceptance — 2026-10-05

M3 is locally accepted on product commit `ad0bdf7`. One independent milestone
review completed; its six findings were fixed in `a376420`. Later owner fixes
addressed observed live failures. All changes are committed on main.

Environment: ChatGPT.app `26.930.31730`, bundled Codex `0.160.0`, Claude Code
`2.1.289`, agent mode. Final installed library: `0.1.0-ad0bdf7a7cac`.

## Actual behavior

- All ten activation checks and real GPT/Claude mandatory probes passed on the
  final build. Native fan-out was published and the app restarted successfully.
- The app completed seven native children on `13e459d`: three actual Opus
  subscription children and four GPT children. Every complete returned sentence
  matched the parent's seven numbered entries.
- With native v1 disabled, the app completed exactly seven bridge children on
  `258b239`: three actual Opus children and four GPT children. All seven terminal
  receipts and exact returned sentences matched the parent.
- Desktop work and Claude Code's translated GPT Read/PONG request overlapped
  on Home. The queued switch entered draining, waited for the desktop turn,
  then activated C. That same seven-child parent continued on C and correctly
  recalled the number of Opus reviewers. Work leases returned to zero.
- Manual and automatic threshold Home → C rotations also preserved an exact
  remembered token in another app thread. The desktop retained its Home login
  identity while model traffic used C. Final state is Home; rotation and replay
  are off.
- Limits lists Home, B and C. Home and C have official readings. B remains
  parked with unavailable metadata and needs login; no login repair was attempted.
- Metadata-only backups, switch dry-run and recovery dry-run passed.
- M3-only rollback from C restored Home and verified accepted M2. The M2
  baseline record remained byte-for-byte unchanged. The retained system-Bash
  command repeated successfully without invoking the Node CLI wrapper.
- Full Off from C restored Home, removed all layers and router jobs, disabled
  Claude Code routing, left zero AnyEngine entries in the shared cache, and
  retired both milestone markers. M1 → M2 → M3 then reinstalled successfully.
- The current native picker lists Claude Opus, Sonnet and Haiku. GPT → Opus
  preserved the reviewed filename. A saved Opus selection survived a cold app
  reopen and retained its exact remembered token.

## Concrete fixes and recovery

Automatic rollback remains enabled and actually restored M2 after failed M3
activation, including the final restart handoff. Earlier activation fixes
covered bootstrap MCP configuration, recovery pin refresh and coherent status
reads. Restart recovery now prefers retained M2 over broader removal, and
broader removal restores Home and retires milestone records.

Live overlap exposed a bridge child being announced as running before its
turn was admitted. `258b239` moves that announcement after admission; the
successful repeat had no leaked work leases.

A scheduled verifier overlapped a library switch and invalidated its own
snapshot, causing safe rollback. `ad0bdf7` removes the scheduled job's redundant
run-at-load trigger. Mandatory app startup verification remains; the router
still starts immediately, and the loaded 03:30 schedule and vendor update
watches remain configured.

## Verification and limits

The full hermetic suite passed **2,101/2,101** on `13e459d`. Subsequent recovery
changes passed 38 and 26 affected checks; bridge admission passed 28 checks;
the scheduling change passed 59 installation checks. Build and static gates
passed. These focused results do not claim a new full-suite run on `ad0bdf7`.

Interactive Codex TUI was not scripted, as the design requires. The legacy
router-only M0 downgrade remains unexercised against a current compatible
baseline; the actual full Off/reinstall cycle above passed. These historical
M1 observations do not add scope to M3's accepted account/limits criteria.

Final doctor passed; it notes that older external adapters may use homes whose
canonical source is unproven. Those pre-existing adapters were preserved.
Private live receipts and recovery evidence are retained outside public code.
