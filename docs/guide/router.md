# Router

The router is AnyEngine's model-level service (spec 5.2). It listens on
`127.0.0.1:18790` and speaks the Codex model backend's API under
`/backend-api/codex`:

- `GET /models`: the upstream catalog plus Claude entries (see below).
- GPT `/responses` over HTTP and WebSocket: relayed to chatgpt.com unchanged,
  with the caller's own headers. The router never stores, refreshes or logs a
  token.
- Claude `/responses`: agent mode hands the turn to the adapter that owns the
  thread; model mode runs it through the `claude -p` trampoline.
- `GET /health`: pid, version, mode, fan-out path, upstream state, requests in
  flight, and `faults`: unhandled rejections and hook errors since the router
  started (a router that answers but keeps failing shows them here).

It runs under launchd as `dev.anyengine.router` (KeepAlive), started by
`anyengine on`. Its log is `~/.anyengine/logs/router.jsonl`, rotated at 5 MB
with three old files kept.

Only the adapter's own codex child talks to it: the adapter adds
`-c openai_base_url=http://127.0.0.1:18790/backend-api/codex` to that child
when the router answers `/health`, and leaves it out otherwise, so a stopped
router never takes GPT down for longer than one app restart.

## GPT passthrough

A GPT request goes to `router.upstream` (`https://chatgpt.com/backend-api/codex`;
the setting accepts nothing else but a loopback test backend) with its path,
query, body and headers as codex sent them, a compressed body included. Only
the headers that belong to one connection (`Connection` and the ones it
names, `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, `Host`, `Expect`,
`Proxy-*`, `TE`, `Trailer`) are left to each hop. The answer comes back the
same way: status, headers and body as chatgpt.com sent them, streamed as
they arrive and no faster than codex reads them. A caller that disconnects
closes the upstream request; an upstream that fails mid-stream ends the
caller's stream. An upstream that cannot be reached is a `502` naming the
error code, and `/health` shows it under `upstream.lastError`.

The router reads the body only to see which model it names (decoding at most
256 MB), and adds no credential of its own: a request with no
`Authorization` goes upstream with none. The answer's headers keep their
duplicates, order and case (each `Set-Cookie` on its own line).

Limits, each answered at once and never relayed:

- A `GET` or `HEAD` that carries a body (`Transfer-Encoding`, or a
  `Content-Length` above 0) is a `400`: no body is defined for them, and
  with `Transfer-Encoding` left to each hop its bytes would reach the
  upstream unframed.
- A request body over 128 MB, declared or as it arrives, is a `413`.
- A request has 300 s to arrive, head and body (`408` after that). Its
  answer is not bounded: a turn's stream runs as long as it runs.

## Its own connections

The relay keeps its own connection pools and never uses Node's global ones,
so a proxy named in the environment (`NODE_USE_ENV_PROXY` with
`HTTP_PROXY`/`HTTPS_PROXY`) never sees a request, and it always verifies
chatgpt.com's certificate, whatever `NODE_TLS_REJECT_UNAUTHORIZED` says. At
start the daemon writes to `router.jsonl` when the environment sets any of
these: `NODE_TLS_REJECT_UNAUTHORIZED=0` (also a `WARNING` line in launchd's
log), `NODE_EXTRA_CA_CERTS` (it adds authorities the relay trusts), and the
proxy variables (names only, never their values).

## Who may call it

Only a process on this Mac, never a web page. The router binds `127.0.0.1`,
and refuses with `403`, over HTTP and on WebSocket upgrades, any request
that:

- comes from a peer that is not loopback,
- carries an `Origin`, `Sec-Fetch-Site` or `Sec-Fetch-Dest` header (every
  browser sends these, and a page cannot remove them), or
- names a `Host` other than `127.0.0.1`, `localhost` or `[::1]` (DNS
  rebinding).

Codex sends none of these, nor does Node's `fetch`. Paths outside
`/backend-api/codex` and `/health` are `404`.

## Logs and disk

- `router.jsonl` holds events only (start, stop, refusals, upstream errors,
  crashes), never a request's headers or body. Anything credential-shaped
  (a `Bearer` or `Basic` value, a JWT, an `sk-` key, a cookie line, a value
  named like a token, key or account id) is replaced before a line is
  written.
- launchd appends the router's stdout and stderr to
  `~/.anyengine/logs/router.launchd.log` (`ANYENGINE_LAUNCHD_LOG`). The
  launcher trims it to 200 KB at each start, and the router every minute
  while it runs, in place (launchd keeps the file open). The router trims it
  only when it is a plain file directly in `~/.anyengine/logs`.

A crash is logged as `router.crash` and exits non-zero, so launchd starts a
fresh router. `SIGTERM` lets requests in flight finish for up to 10 s.

## The catalog and the fan-out path

On the **native** path, the router adds the configured Claude models (by
default `opus`, `sonnet`, and `haiku`) just after the leading listed upstream
model. `claude.spawnPriority` orders them inside Codex's five-model spawn
list. Each Claude entry inherits its upstream template's access restrictions,
including `supported_in_api`, so filtering cannot promote Claude above that
upstream default, even if its name does not start with `gpt-`. Without a
listed non-AnyEngine template, the router reports bridge and adds no Claude
entries.
Claude clones use the non-lite Responses format and their configured context
windows. The router changes v2 entries to v1; null or absent versions already
mean v1 to Codex.

Native fan-out requires `router.multiAgentV1` and a matching proof in
`state/proven.json`, with no `native-fanout` degraded marker. The proof names
the installed lib, app and resolved Codex versions, plus a hash of the v1
switch, modes, Claude models and spawn order, and claim settings. Version
reads are cached for up to 30 seconds, with immediate invalidation when
the plist or binary inode, size, mtime or ctime changes. Codex version probes
use an isolated home and a loopback-only Mac sandbox. Unsupported or failed
probing returns an unreadable version (`null`), which
never matches a proof. Confirmed absence is recorded as `"absent"`; `lib: null`
is allowed for private probe roots. When `lib/current` exists, it must also
match the running router version. A malformed or unreadable degraded marker
blocks native fan-out until repaired or cleared. The selected router's
`/health` reports those same four proof fields; native attachment requires
all four to match the adapter, including the version of its actual selected
Codex executable (`CODEX_REAL` included). Missing or unreadable proof fields
retain bridge attachment. The selected key is fixed at child spawn; current
proof drift stops Claude model routing until a new attachment is established.

Until proven, the router serves the **bridge** path: the upstream catalog
without Claude additions or v1 rewriting. The adapter's picker still offers
Claude, and its bridge handles mixed fan-out. The path also falls back when
the upstream names an unsupported `multi_agent_version`, rejects multi-agent
collaboration, or a model served as v1 sends encrypted v2 collaboration tools. For ten
minutes after startup, a configuration change, or a return from bridge to
native, v2 evidence is ignored to allow existing Codex children to age out
their old catalogs.

Three consecutive unclaimed children (configurable with
`claims.unclaimedFlipThreshold`) also cause fallback. The claim caller counts
only spawned children of owned parents and excludes caller cancellations;
a completed claim resets the streak. Configuration changes or a newer proof
clear monitor evidence. A degraded smoke removes its proof; clearing the
marker alone does not re-prove native fan-out.

`anyengine smoke --paths native-fanout` tests a private router and adapter in
the saved agent/model mode, independent of the current live path. Only matching
successful parent/child terminal work and completed cleanup publish a proof for
the exact library, app, Codex and shaping settings. A private bootstrap marker
cannot supply that evidence. For GPT, a routed failure followed by a separately
observed successful direct turn marks `router` degraded. Newly started adapters
then connect directly; clear the fault with a successful smoke before expecting
new router attachments. Failed or uncertain cleanup retains diagnostic state
and cannot certify native success.


`/health` reports the current path and reason; `state/router-status.json`
records startup and evidence-driven transitions. The catalog cache holds at
most 16 upstream lists, keyed by upstream URL, query and account, never by
bearer. Fetches have an eight-second deadline and an 8 MiB response bound,
use dedicated agents, and refuse redirects. An outage uses only the matching
cached catalog, or returns 503. ETags include catalog content and settings,
so upstream changes and native/bridge switches invalidate conditional reads.

A GET or HEAD with a body is refused before catalog dispatch. Catalog fetches
also strip body framing headers before using a pooled upstream connection.

## Claude children in agent mode (the claim socket)

In agent mode (the default, `anyengine mode codex-claude agent`) the router
does not run Claude. When a GPT thread's `spawn_agent(model="opus")` starts a
child, codex sends that child's requests to the router, which asks every live
adapter over `~/.anyengine/run/claim-<pid>.sock` whether it knows the thread.
The adapter that saw the child start runs the task on its own Claude runtime
(the interactive Claude Code PTY when `ANYENGINE_RUNTIME_TYPE=anyengine`),
under the claim posture: the parent's current posture when it is no looser
than the child's, the child's when it is no looser, and the strictest posture
otherwise or for an unknown parent. Shell commands use the real child's
`command/exec`. A tool call that requires approval is refused: claimed
children have no approval card. Model-authored prompts cannot invoke Claude's
local slash commands. Progress lines and the answer come back as the child's
reply, so the parent receives them through Codex's own agent tools.

The run directory is private (0700), and each socket is 0600. This ownership
gate assumes a single-user Mac; thread ids alone are not authentication
against another process running as the same user. `owns` confirms ownership
without running a turn. A successful answer also includes `cwd`, taken only
from the adapter's thread record (parent cwd, then thread cwd). Explicit null
means the model-mode trampoline uses its empty private directory; a caller's
requested cwd never supplies that trusted root.

The router runs no Claude turn in either mode unless an adapter answers
`owns` for the thread. It retains that adapter's socket path and trusted cwd,
and offers an agent turn only to that socket. Losing the selected owner fails
the turn rather than trying another adapter. An unowned thread gets a clear,
nonretryable failure explaining how to continue. Only refused children whose
parent an adapter owns count toward `claims.unclaimedFlipThreshold`; caller
cancellations and stray requests do not count. Ownership and acceptance do
not reset the streak: receiving `done` does, even when its unsuccessful result
fails the Responses turn. A connection closed before `done` fails without a
completion marker.

Thread ids may appear in files readable by the local `staff` group. On a Mac
with other local users, someone who learns a live thread id could request a
Claude turn through the loopback router. The private claim socket does not
make thread ids authentication for that HTTP or WebSocket request.

An idle claimed child's PTY is released after `claims.idleReleaseMinutes`;
its Claude session id remains available for a cold resume. Disconnecting
interrupts the turn, and adapter shutdown closes claim connections and
releases their runtime processes. Each connection accepts one request.
Announcements wait up to `claims.graceMs`, with at most five additional
seconds for the owning adapter's `thread/read` fallback; malformed requests
fail with an error. The router allows that grace and read budget plus a
one-second transport margin for ownership and claim acceptance. Accepted
streams have no deadline and receive keep-alives every 15 seconds. The server
bounds sessions at 500, connections at 256,
each JSON frame and queued output at 8 MiB, and the accumulated answer at
1 MiB. Runtime
cleanup has a five-second deadline; a failed release blocks another turn on
that thread rather than racing its old PTY.


## Model mode (opt-in)

`anyengine mode codex-claude model` runs Claude turns through `claude -p`
instead of the adapter's agent. Claude is the model inside Codex's loop:
file access and actions use Codex's own tool calls, sandbox and approvals.
Claude receives a closed built-in list for tool discovery; native WebSearch
is enabled only when Codex explicitly offers external web access. Other
built-ins are denied, hooks and slash commands are disabled, and its only
MCP server exposes the current Codex tool list. Plan mode offers no tools.
As in agent mode, a Claude turn runs only for a thread an AnyEngine adapter
owns. Anthropic's policy treats the CLI as a model endpoint for another
agent loop as a grey area; agent mode is the default for that reason.

When Claude calls a Codex tool, the response ends with `end_turn: false`.
The same Claude process waits for the result and continues in the next
response. Results must match both the originating thread and its selected
adapter. A new message or mode change stops and reaps the waiting process
before replacement. Owner loss, router shutdown and a 30-minute wait limit
also clean up the process and private tool socket. Ownership checks while
waiting use only the selected adapter and a bounded read deadline.
