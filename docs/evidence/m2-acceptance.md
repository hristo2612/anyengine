# M2 acceptance — 2026-10-05

M2 provides GPT models and generated GPT agents in Claude Code through the local
Messages router. The implementation received one independent milestone review.
Subsequent fixes address concrete failures observed during live activation.

Live environment: ChatGPT.app 26.930.31730, bundled Codex 0.160.0 and Claude Code
2.1.289. Installed build `97f3745` passed all five scratch rollback routes and
all ten live postflight checks. Its first activation encountered a transient
catalog connection failure and automatically restored M1; the unchanged retry
passed. The following checks passed:

- The official `getAuthStatus` RPC returned a usable bearer and refreshed it.
  The translator has no login flow and does not read credential files.
- Interactive `/model` displayed GPT and Claude rows. Selecting GPT with `s`
  changed that session while preserving the saved default.
- A real translated GPT turn performed one Read and returned PONG. Installed
  scheduled smoke independently passed the same tool path.
- A Claude parent invoked a generated GPT agent. Only the child's Read exposed
  a fresh random marker; its matching tool result contained the marker and the
  parent returned it exactly. The parent did not read the marker itself.
- Claude subscription traffic preserved request bytes, caller authentication
  and the actual permitted subscription rate-limit headers.
- Closing the probe's adapter caused its broker to use a same-home standalone
  official child. A real GPT request passed, then a replacement adapter became
  the source. The probe joined all its owned children.
- One persisted session completed Claude → GPT → GPT → Claude turns with actual
  Read results. GPT's own reasoning signature survived GPT resume and was absent
  from the later Claude request. The CLI omitted foreign Claude thinking before
  sending GPT requests; hermetic tests cover translator-side foreign signatures.
- A local desktop conversation returned PONG through the installed upstream
  route, with the selected GPT model visible in ChatGPT.app.
- Installed mandatory probes and scheduled smoke passed router, GPT, Claude
  agent, native fanout, bridge and Claude Code GPT paths. These small probes do
  not close M1's separate seven-child GUI acceptance items.

Normal Node recovery and the retained Node-free Bash command restored M1.
Automatic recovery also restored M1 after a postflight failure, with no remaining
conflicts. Live failures identified short launchd shutdown waits, stale M2 smoke
status and concurrent vendor cache/log updates. Focused regressions passed for
their fixes. Credential files were neither copied nor inspected.

Validation used the hermetic runner, TypeScript build and the repository's
static gates. The historical full M2 run had nine stale assertions; corrected
affected tests passed. This record does not claim a fresh all-suite pass.

GPT context and effort follow the validated backend catalog, including aliases
such as `[1m]`. Running Claude sessions cache their environment and need a fresh
session after Off. Plan-mode child inheritance remains unexercised because the
official CLI denied the Agent launch in that mode. M1's broader GUI fanout and
Off-cycle items remain explicitly open in its acceptance record.
