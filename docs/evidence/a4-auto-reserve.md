# A4 — auto-reserve: the adapter handles reserve mode by itself

Date: 2026-09-10, 10:55–11:20 local (07:55–08:20Z). Host: the Mac that runs
ChatGPT.app 26.901 as a daily driver, with the account's Codex usage spent
(resets 15 Sept, 21:29). Replaces the two static flags A3 shipped.

## The problem

While the account is out of Codex usage the desktop hides the whole model
picker on a host that reports a ChatGPT account, Claude and Grok included, and
shows a blocking "You're out of Codex and Work usage" banner over the composer.
A3 worked around it with two flags in `~/.anyengine/runtime.env`,
`ANYENGINE_HIDE_RATE_LIMIT_UPSELL=1` and `ANYENGINE_NATIVE_CODEX=0`. They were
static — set by hand, reverted by hand — and the second one paid for the picker
by dropping the real Codex child, so GPT threads had nowhere to go.

## How the desktop decides

Read out of the app bundle (`app.asar`, `webview/assets/app-initial-*.js`) and
confirmed live:

- The desktop takes its **own** ChatGPT identity from the **local** host's
  `account/read` and `getAuthStatus`. `account.type` decides `authMethod`
  (`chatgpt` / `apikey` / `amazonBedrock`), and the auth status carries the
  bearer it calls its own backend with.
- Reserve mode arms only when that identity says `chatgpt`; it then filters the
  picker down to `gpt-reserve` / `gpt-5.6-luna`.
- The usage banner is drawn from the app's own backend read (`/wham/usage`),
  not from the app-server. It stops resolving once the host stops handing over
  a ChatGPT identity — which is exactly what `ANYENGINE_NATIVE_CODEX=0` did by
  accident, and why the banner disappeared under the A3 flags.
- The desktop **never asks the app-server for `account/rateLimits/read`**: 0
  calls in 8.5 h of live adapter logs, against 485 `account/read` and 524
  `getAuthStatus` calls in the same window.

## What A4 does

`src/reserve.mts` plus a small amount of wiring in `src/codex-upstream.mts`:

- Every 5 minutes (and once before the handshake returns) the adapter reads
  `account/rateLimits/read` from the real child and caches the answer. Limited
  is `rateLimitReachedType` on any `RateLimitSnapshot` — the single-bucket
  `rateLimits` view or a bucket in `rateLimitsByLimitId` — or
  `rateLimitUpsell.banner_type === 'luna_reserve'`. Field names verified
  against the bundled binary's own schema
  (`codex app-server generate-json-schema`, `v2/GetAccountRateLimitsResponse.json`).
- **While limited**, three answers on their way to the desktop are rewritten:
  `account/read` becomes `{account:{type:'amazonBedrock'}, requiresOpenaiAuth:false}`,
  `getAuthStatus` becomes `{authMethod:null, authToken:null, requiresOpenaiAuth:false}`
  (both are byte-for-byte what the adapter answers by itself when there is no
  child at all), the `account/updated` notification becomes
  `{authMode:'apikey', planType:null}`, and any rate-limit payload loses its
  `rateLimitReachedType` / `rateLimitUpsell` markers while keeping the real
  usage numbers.
- **Nothing else changes.** The child keeps running, the model list keeps its
  OpenAI half, and gpt-* threads still reach the child and still fail with the
  account's own usage-limit error.
- **The moment a read says not limited** the rewriting stops — with that
  answer, not on a timer — and the adapter pushes one `account/updated`
  carrying the child's real account so the desktop re-reads it instead of
  waiting for its own next poll.
- Each transition logs one line, `reserve.entered` / `reserve.cleared`, in
  `~/.codex/anyengine/debug.jsonl`.
- Kill switch: `ANYENGINE_AUTO_RESERVE=0`. The two A3 flags still work for one
  release and are documented as superseded.

A rate-limit *notification* may only move the state into reserve, never out of
it: `account/rateLimits/updated` carries a snapshot that can omit fields, so a
missing marker there is not evidence the limit lifted. Clearing waits for a
full read.

## Live verification

`~/.anyengine/runtime.env` lost both static flags (backup:
`~/.anyengine/rollback-20260909T231247Z/runtime.env.pre-auto-reserve`, with a
dated comment in the file). ChatGPT.app was quit with no turn in flight, the
adapter pids were watched out, and the app reopened. `reserve.entered` at
08:03:51.541Z, 71 ms before the desktop's first `account/read` reached the
child — the desktop never saw the ChatGPT account.

| Check | Result | Screenshot |
| --- | --- | --- |
| Local project picker | GPT (6 Astra, 5.6 Sol/Terra/Luna, 5.5, 5.3 Codex Spark) **and** Claude Fable 5.1 / Opus / Sonnet / Haiku **and** Grok 4.6 / 4.5 — no reserve filtering | [a4-model-picker.png](a4-model-picker.png) |
| "You're out of Codex usage" banner | gone | [a4-banner-gone.png](a4-banner-gone.png) |
| Claude Sonnet, `Reply with exactly the word PONG` | `PONG` | [a4-claude-pong.png](a4-claude-pong.png) |
| Grok 4.6, same prompt | `PONG`, "Worked for 3s" | [a4-grok-pong.png](a4-grok-pong.png) |
| GPT-5.6 Sol in a new thread, same prompt | routed `upstream` (adapter log), answered `You've hit your usage limit. Try again later.` | [a4-gpt-usage-limit.png](a4-gpt-usage-limit.png) |

The last row is the point: native GPT passthrough is back, and what comes back
is OpenAI's own honest answer, not something the adapter invented.

The banner **is** suppressible at the response level with the child kept — it
needed `getAuthStatus` as well as `account/read`. With `account/read` alone the
picker came back but the banner stayed, because the app was still holding the
host's ChatGPT bearer.

The cleared direction cannot be exercised live (the quota cannot be reset), so
it is covered by tests only: `test/reserve.test.mts` drives a limited fixture
and a cleared one through the state in both directions, and
`test/codex-mux.test.mts` proves the transform end-to-end against the fake
child, with and without the kill switch. 217 tests, 217 pass.

## Rollback

```bash
cp ~/.anyengine/rollback-20260909T231247Z/runtime.env.pre-auto-reserve \
   ~/.anyengine/runtime.env
osascript -e 'quit app "ChatGPT"'   # check for an active turn first
# wait for the adapter pid to exit, then
open -a /Applications/ChatGPT.app
```

That restores the two static flags (and with them the A3 behaviour, native GPT
passthrough off). To keep the child but switch the automatic behaviour off,
`export ANYENGINE_AUTO_RESERVE=0` instead and restart the app.

## Open items

- The 2026-09-15 "revert the two flags" item from
  [a3-flip.md](a3-flip.md) is **void**: the flags are gone and the adapter
  follows the limit on its own, in both directions.
- Re-run `npm run smoke:native-codex` once the quota resets, for a GPT turn
  that answers instead of erroring.
