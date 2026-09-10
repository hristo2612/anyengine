# A5 — switching engines in the middle of a thread

Date: 2026-09-10, 12:20–12:45 local (09:20–09:45Z). Host: the Mac that runs
ChatGPT.app 26.901 as a daily driver, local project, Codex usage spent
(resets 15 Sept).

## The problem

A thread was bound to one engine at `thread/start`. Moving the picker on a GPT
thread to Sonnet and sending a turn came back as the real Codex child's own
refusal — *"the 'sonnet' model is not supported when using Codex with a ChatGPT
account"* — because the turn was still being forwarded to the child. The other
direction could not work either: a Claude thread had no child thread to send a
gpt-* turn to.

## What the desktop actually sends

The first cut of this packet routed on `turn/start.model`. Driving the app
showed that is not where the model change appears. Moving the picker on an
existing thread sends

```
thread/settings/update {threadId, model: "grok-4.6", effort: "medium", …}
```

and the `turn/start` that follows carries `model: null` — it means "whatever
the thread is set to". So the switch is caught on the model-carrying methods
(`thread/settings/update`, `thread/metadata/update`) as well as on an explicit
`turn/start.model`, which other clients do send. A turn that names no model
never moves a thread.

The app draws its own `Model changed from X to Y.` divider between the turns,
so a switch is visible in the transcript without the adapter adding anything.

## Mechanism

`src/rehome.mts` decides which engine a model id belongs to (`gpt` for OpenAI
Codex ids, `grok` for grok-*, `claude` for everything else) and distils a
transcript out of thread items. The wiring lives in `src/codex-mux.mts` for
anything crossing the boundary to the real Codex child, and in `src/server.mts`
for Claude ↔ Grok, which never leaves the local layer (and so works with no
child attached at all).

| From → to | What happens |
| --- | --- |
| Claude ↔ Grok | The local thread's runtime session id is cleared, so the next turn starts a fresh `claude` / `grok` session, and the transcript rides on that turn's prompt. |
| Claude/Grok → GPT | The child thread this app thread already had is `thread/resume`d; otherwise a new one is `thread/start`ed with the same cwd and model and **aliased** to the app's thread id. The transcript goes over as `thread/inject_items` (one Responses user message); if the child refuses, it is prefixed onto the first turn's input instead. |
| GPT → Claude/Grok | The child's history is read with `thread/read {includeTurns:true}`, the local thread row is created if the thread was born upstream, its session is cleared, and the merged transcript rides on the first turn's prompt. |

**Transcript policy.** User and assistant messages only, in order; tool calls,
reasoning, diffs and image views are dropped. Over `ANYENGINE_REHOME_MAX_CHARS`
(12000) the block keeps the first user message and the most recent exchanges
with `[earlier turns trimmed]` between them. Going *to* GPT only the local
turns the child has not already been given are carried (a watermark on the last
carried turn id), because a resumed child thread still holds its own history.
Going *to* a local engine the session is always fresh, so the whole merged
history is carried. The stored `userMessage` item is never touched, so the
app's transcript shows what the user typed, not the carried block.

**Ownership** lives in `thread_engines` in the adapter's `state.sqlite`: the app
thread id, the engine that owns it, the child thread id behind it (equal to the
app id for a thread born upstream), the carry watermark, and any transcript
that could not be injected. It survives an adapter restart. Thread ids are
aliased in both directions inside the multiplexer, so the desktop always sees
the id it started with — in notifications, in `thread/list` (deduped to one
row) and in `thread/read`, which answers a re-homed thread with both halves of
the item history in one list.

**Guards.** A `turn/start` that would switch while a turn is running is refused
with a readable message rather than cutting the turn off; a picker change
during a turn pins the current owner so the switch still happens on the next
turn. A handover that fails leaves the thread with its previous owner and
errors the turn. Every handover logs one `thread.rehomed {from,to}` line in
`~/.codex/anyengine/debug.jsonl`.

## Live verification

One thread in a local project, started on Claude Sonnet, moved through three
more engines. Screenshots are cropped to the conversation pane.

| Step | Result | Screenshot |
| --- | --- | --- |
| Claude Sonnet: `Remember the codeword BANANA and reply OK` | `OK` | — |
| → Grok 4.6: `What is the codeword?` | `BANANA`, 12 s (`thread.rehomed {claude→grok, carriedChars:114}`) | [a5-claude-to-grok.png](a5-claude-to-grok.png) |
| → GPT-5.6 Sol: `Codeword again?` | routed to the real child, which answered `You've hit your usage limit. Try again later.` — OpenAI's own error, which is what proves the turn went upstream | [a5-grok-to-gpt-usage-limit.png](a5-grok-to-gpt-usage-limit.png) |
| → Claude Sonnet: `Codeword again?` | `BANANA`, 1 s | [a5-gpt-to-claude.png](a5-gpt-to-claude.png) |
| Reopened from the app's search, cold | one thread: `OK` → `BANANA` → the usage-limit error → `BANANA`, with the app's own model-change dividers | [a5-one-thread-four-engines.png](a5-one-thread-four-engines.png) |

And the reported bug itself, in a second thread **started** on GPT-5.6 Sol:

| Step | Result | Screenshot |
| --- | --- | --- |
| GPT-5.6 Sol: `Remember the codeword MANGO and reply OK` | `You've hit your usage limit` (quota, expected) | — |
| → Claude Sonnet: `What is the codeword?` | `MANGO`, 2 s — **no** "the 'sonnet' model is not supported" | [a5-gpt-thread-to-sonnet.png](a5-gpt-thread-to-sonnet.png) |

Persisted afterwards, read straight out of `state.sqlite`:

```
{ id: '01a08ab0-…', engine: 'claude', upstream_thread_id: '01a08ab0-…' }   # born on GPT
{ id: '76653070-…', engine: 'claude', upstream_thread_id: '01a08aae-…' }   # born on Claude, aliased
```

The second row is the alias: the desktop knows that thread as `76653070…`
throughout, the child knows its half as `01a08aae…`.

Automated coverage: 229 tests, 229 pass (`npm test`), of which 6 unit tests in
`test/rehome.test.mts` and 6 multiplexer tests against the fake child in
`test/codex-mux.test.mts` — GPT→Claude→GPT, Claude→Grok→GPT→Grok→Claude, the
desktop's `thread/settings/update` signal, transcript trimming, persistence
across a restart, a failed handover keeping the owner, the busy-turn refusal,
the injection fallback, and the no-op when the model is unchanged.

## Limits

- Turns from the two engines are ordered by start time, and the local side
  records whole seconds. Two turns that start inside the same second fall back
  to phase order (the engine that owns the thread now ran last).
- The shadow child thread created for a Claude thread's GPT leg is folded into
  one row in `thread/list`, but the desktop's own **search** indexes it
  separately and shows it as an extra "Untitled chat" whose text is the
  injected transcript. Cosmetic; the thread itself is never duplicated in the
  sidebar.
- Carrying context is not the same as sharing state: the new engine gets what
  was said, not the previous engine's tool state, plan, or open files.
- `thread/read` on a re-homed thread costs one extra round trip to the child.

## Rollback

```bash
cd ~/Projects/anyengine
git checkout 5b492c2 -- src test      # the commit before this packet
npm run build
osascript -e 'quit app "ChatGPT"'     # check for an active turn first
# wait for the adapter pids to exit, then
open -a /Applications/ChatGPT.app
```

Nothing outside the repository changed: `~/.anyengine/runtime.env`, the
`~/bin/codex` shim and the app itself are untouched, and the new
`thread_engines` table and `threads.rehome_prefix` column are additive — an
older build ignores them.
