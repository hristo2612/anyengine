# M1 acceptance — 2026-10-04

**Accepted with the Open items below**, as permitted by Task 31. The chosen
installed build is `0.1.0-351b59fb8004`, with ChatGPT.app `26.930.31730`,
Codex `0.160.0`, agent mode and native routing. Status reports adapter and
router layers, `flip none`; doctor passes. This is local acceptance, not a
package publication.

| Observation | Actual result |
| --- | --- |
| Headless picker | PASS: Opus, Sonnet and Haiku, with the router serving three Claude entries. Captured on `f50eb57`; the final runtime sources are unchanged. |
| Same-thread GPT → Opus → GPT | PASS: three completed PONG turns on one persistent thread; upstream GPT correlation and the actual Claude PTY checked. Captured on `f50eb57`. |
| Seven native children, three Opus | PARTIAL: seven distinct successful children, three actual Opus PTYs, lineage and terminal checks passed on `153e018`; parent returned seven entries. Exact returned sentence/model matching failed, so this probe is not a pass. |
| Same seven-child bridge task | OPEN: native v1 was disabled and bridge health confirmed. No bridge spawn receipt was produced; the headless client refused an unidentified MCP elicitation. All owned cleanup completed; native settings were restored. |
| Authenticated remote CLI host | PASS on final build: initialize, Claude model catalog, GPT PONG, Claude PONG and native spawn claimed. This is protocol evidence, not interactive TUI evidence. |
| Ordinary terminal Codex | PASS: actual shared cache held three AnyEngine entries; bundled `0.160.0` and alternate `0.154.0` ignored them, explicit/default GPT selection held, and router priority preserved the GPT default. Outbound-denied fake backends; no model spend. |
| Final switch-on | PASS: genuine installed native proof, five isolated rollback routes and all ten actual postflight checks, including restricted OAuth, real-config Claude PTY and GPT work. |
| Scheduled smoke/update | PASS: current vendor update verification and router, GPT, Claude agent, native fanout and bridge paths. Claude-model path is not applicable in agent mode. Known-good evidence names the final build and current vendor versions. |
| Schedule, storage and update detection | PASS: loaded 03:30 job with two watch paths; doctor reports bounded storage, detect-and-alert loaded, no staged update. |
| Router-only/full live Off cycle | OPEN in this final acceptance run. Five isolated system-Bash/Node recovery routes passed for twelve mutable targets and verified jobs; these do not establish a fresh live M0 downgrade. |

Successful owned probes closed their threads, sessions and process families.
Failed captures and uncertain older cleanup evidence are retained separately;
a later successful attempt does not upgrade their verdicts. Recovery remains
available through the generated system-Bash recovery entry and retained
instructions.

## Live follow-up — 2026-10-05

Build `13e459d`, on the same app and Codex versions, passed the seven-child
native test in ChatGPT.app. Seven distinct children completed: three actual
Opus subscription PTYs and four GPT-6.1 Sol children. The parent's seven
numbered results matched each child's complete returned sentence exactly.
The six-thread concurrency limit caused one refused spawn; the parent closed
a completed child and successfully created the seventh. This closes the
native consumer item without changing the historical partial result above.

The current app picker visibly listed Claude Opus, Sonnet and Haiku. Switching
that conversation from GPT to Opus preserved its context: Opus returned
`discount.mjs`, the file the children had reviewed. The final bridge run on
`258b239` completed exactly seven bridge children,
three on the Claude plan and four GPT, with every returned sentence matching.
Full Off from C restored Home, removed injected cache entries and retired
milestone records; M1 → M2 → M3 reinstall passed on final product `ad0bdf7`.
A saved Claude Opus selection also survived a cold app reopen on `ad0bdf7`;
the same conversation recalled its exact remembered token.

## Open

- Interactive Codex TUI observation remains unexecuted in this environment;
  the recorded suspend/resume limitation is not a successful TUI run.
- The legacy router-only M0 downgrade remains unexercised against a current
  compatible baseline. Its historical recovery evidence is retained. The
  actual full Off/reinstall cycle above passed.

## Source verification

The settled full suite passed **1,686/1,686** on `f50eb57`. Subsequent changes
were limited to acceptance consumers and their tests: focused **26/26**, then
**27/27**, build/type, static and privacy checks passed; each exact delta had
an independent scoped review with no findings. No new final-tree full-suite
pass is claimed. The installed manifest and shipped source/compiled bytes were
verified before genuine proof and activation.
