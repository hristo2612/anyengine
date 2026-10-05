# AnyEngine M2 Claude Code face and broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The operator has authorized M1 → M2 → M3, decisions and commits on main. Finish M1 first; do not request another plan approval. Use one owner and a fresh independent reviewer before the live change.

**Goal:** Make subscription-backed GPT models and GPT subagents work in Claude Code while ordinary Claude traffic keeps its native subscription behavior, with one reversible installation.

**Architecture:** Add a Messages face to M1's router and port the translation-only MIT core of raine/claude-code-proxy into focused TypeScript modules. The router's in-memory broker borrows one real Codex app-server's bearer through a private Unix socket, or owns one fallback real app-server on the same canonical account home when no adapter exists. Claude Code retains execution and permission enforcement; the translator returns tool calls and never runs tools.

**Tech Stack:** Node.js >=24, erasable TypeScript ESM `.mts`, `node:http`, `node:https`, `node:net`, existing `ws`, existing test helpers and Biome. No new production dependency, Rust runtime, second proxy daemon, login store or token refresh implementation.

**Spec:** `docs/specs/2026-09-29-anyengine-v1-design.md`, §§3, 5.2 Claude Code face, 5.3, 5.6, 5.7, 7–9. M1 interfaces: `docs/superpowers/plans/2026-09-30-anyengine-m1-codex-router.md`, Tasks 18, 21–27. This plan was prepared against partial M1 main `44f1acd`; read the completed implementations of the named interfaces before execution and retain their final signatures where M1 changed them.

## Global Constraints

- “GPT traffic always carries a bearer that a real `codex` process owns and refreshes.”
- “Exactly one process family refreshes each account's token chain. Credentials are moved, never copied.”
- “Vendor apps update weekly or faster”; “Every live change is reversible with one command.”
- “No heavy system prompts. Native mode injects nothing. The bridge fallback injects one line.”
- “The child's posture must be no looser than the parent's.”
- “Never scripted: the interactive codex TUI.”
- “Hermetic suite: no reliance on the user's `~/.codex` or `~/.claude`. Tests spawn with isolated homes and kill their children in `after()`.”
- Node.js 24+; `.mts` sources, `.mjs` imports; no enum, namespace or parameter properties; never edit `dist/` or `generated/`; Biome 2-space, single quotes, no semicolons.
- No credential values in logs, evidence, exceptions, status, fixtures, environment, argv or files. Broker alone acquires OpenAI bearer values from a real Codex process; it never opens an auth file or calls an OAuth endpoint.
- Spec §3's blanket “no component ever holds, stores or relays a Claude OAuth token” conflicts literally with §5.2's required transparent Claude passthrough. Implement the explicitly approved interpretation: blindly forward caller headers only to fixed `https://api.anthropic.com`; never acquire, parse, decode, persist, log or reuse a Claude credential. No credential header reaches GPT, broker or translation core.
- No `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, Claude login replacement, or subscription credential harvesting is introduced.
- Keep one existing launchd router, M1's fixed loopback binding and browser/DNS-rebinding gate. No externally reachable authentication endpoint.
- M1's storage, bounded logs, real-CLI fixtures and operator-config rules remain in force. Real Claude runs use the existing fixed `<root>/smoke/claude-project`; never write `~/.claude.json`. Clean only attributable smoke session files by exact name.
- Preserve M1's stable SQLite coordination databases and sidecars while owners or waiters may exist. SQLite alone manages database descriptors; an ordinary read/copy/hash descriptor closed in the owning process can release its POSIX locks. Backup, layer, doctor and recovery code uses stat or SQLite-aware access and never replaces, truncates, restores or removes live coordination storage. Node-free recovery preserves it without requiring a sqlite3 binary.
- M3 owns account storage, overlay creation, move-swap and rotation. M2 accepts an `ActiveAccount` provider; until M3 supplies its overlay, it uses the same canonical Codex home already used by the adapter. It must not preemptively copy or move credentials.

## Review Focus

1. App starts/stops or respawns its Codex child while seven GPT requests await a bearer: invalidate the source revision even within the same account generation, coalesce renewal on the replacement, never return/cache a late result from the old source. Task 2 pins this race.
2. A Claude request contains unusual JSON whitespace, compressed bytes, duplicate rate-limit headers or unknown beta fields: Claude receives the same entity bytes and end-to-end headers. Task 5 pins this, including GPT credential stripping.
3. A GPT stream ends after a tool fragment or emits a quota/context error after HTTP 200: never fabricate success, execute a tool, or silently retry emitted output. Task 4 pins these terminals.
4. The operator edits settings, saves GPT as the default, or edits an owned agent after `on`: `off` removes routing without destroying unrelated edits and clears only the now-unroutable AnyEngine-owned GPT default. Task 6 pins semantic undo, M2-only restoration of the prior M1 baseline and node-free rollback.
5. Two subagents share a parent session but differ in tool lists or posture: stable independent cache identities, no continuation state crossing agents, no permission overrides, and no translator-side tools. Tasks 3 and 7 pin these boundaries.

---

## Decisions and file map

Eight deliverables, sequential implementation, one final independent review. Each task has a focused test run and commit. Do not split this into employee assignments or create a Workflow.

**Vendoring choice:** adapt the translation-only core of raine v0.1.42, commit `1e30e301a48c01a797308e2d24f6c66515363cbf`, into `src/vendor/claude-code-proxy/`. Preserve MIT LICENSE and source-file/function mapping in `vendor/claude-code-proxy/UPSTREAM.md`; keep selected original `.rs` files as review/differential references under `vendor/claude-code-proxy/upstream/`. Exclude all auth, OAuth, token-store, keychain, server, monitor, traffic-capture and provider CLI code. This is a port, not the unmodified proxy. Do not import its Claude→GPT aliases, provider fallback or hidden Read-tool prompt alterations. Every intentional difference gets a fixture and provenance note.

**Transport choice:** HTTP Responses streaming with full request history on every call, `store:false`; no `previous_response_id`, server-side compaction cache, global continuation state or WebSocket pool. This avoids cross-agent/restart state corruption while retaining upstream's Responses Lite formatting where the active catalog requires it. M1's existing WebSocket path is unchanged.

**Identity choice:** retain a truthful AnyEngine user-agent on the normal Responses lane. The pinned source uses `originator: codex_cli_rs` on Responses Lite; reproduce only required lane headers proven by M1's captured Codex wire fixture, document that compatibility choice and verify live. Do not claim the GPT backend is a documented third-party API.

**Model choice:** offer GPT entries actually returned by the active real Codex model catalog. Filter out router-injected Claude rows. Persist a bounded, non-secret selection of IDs/capabilities as part of the settings layer. Do not freeze the old raine allowlist, which lacks the operator's newer GPT model. Test with `gpt-6.1-sol` and `gpt-6-luna`; live IDs come from the real catalog. No Claude alias is ever translated. Unknown `gpt-*` gets a local Anthropic-shaped 400; every non-GPT unknown model passes to Anthropic.

**Context choice:** plain GPT model IDs in the initial picker and agents; omit `[1m]`, `behavesAs`, and a global `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Claude's conservative unknown-model window is safer than claiming 1M without a per-model window setting. This leaves native Claude context untouched. Document the conservative GPT budget; do not market the full upstream context window until a model-specific setting is proven.

| Files | Responsibility |
|---|---|
| `src/broker-types.mts`, `broker-cache.mts` | Secret-bearing types internal to broker; coalesced cache, expiry and source generations |
| `src/broker-source.mts`, `broker-owner.mts` | Adapter private source socket; source election and bounded standalone real Codex lifecycle |
| `src/claude-models.mts` | Pure catalog selection, aliases, model lane/capability mapping |
| `src/vendor/claude-code-proxy/{types,request,tools,reasoning,stream,usage,errors}.mts` | Pure Messages/Responses translation port; no I/O or auth |
| `src/claude-gpt.mts`, `src/claude-catalog.mts` | Admitted-generation catalog retrieval/model resolution, broker injection, HTTP call, one safe 401 retry, SSE/backpressure/cancellation |
| `src/router-messages.mts` | Claude/GPT route selection and transparent Anthropic relay |
| `src/control-claude-settings.mts`, `control-claude.mts`, `control-m2-rollback.mts` | Settings/agents transform, M1 layer integration, M2-only baseline restoration and library retention |
| `src/smoke-claude-code.mts` | Tiny GPT turn/tool/subagent checks within M1 smoke infrastructure |
| `scripts/capture-codex-auth.mjs`, `capture-claude-messages.mjs` | Real binary, fake credential, loopback-only protocol fixtures |
| `scripts/capture-raine-translation.mjs` | Optional pinned upstream differential fixture recorder, never a runtime dependency |
| `scripts/acceptance-claude-code.mjs` | Live acceptance with installed library and evidence redaction |
| `test/{broker,claude-models,claude-request,claude-stream,claude-gpt,claude-catalog,router-messages,control-claude,control-m2-rollback,claude-posture,smoke-claude-code}.test.mts` | Focused hermetic suites |

Cross-task types: auth/admission/source types in `broker-types.mts`; pure model/snapshot/view types in `claude-models.mts`; broker-dependent `GptCatalogs` in Task 4's `claude-catalog.mts`; translation JSON/event types in the vendored `types.mts`. Pure catalog types add no broker dependency to Task 1:

```ts
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Obj = { [key: string]: Json }
export interface ActiveAccount { home: string; generation: number }
export interface AccountAdmission {
  begin(signal?: AbortSignal): Promise<{ generation: number; release(): Promise<void> }>
}
export interface AuthStatus { authMethod: string | null; authToken: string | null; requiresOpenaiAuth: boolean }
export interface AuthSource {
  id: string
  generation: number
  home: string
  request(method: 'getAuthStatus', params: { includeToken: true; refreshToken: boolean }): Promise<AuthStatus>
}
export interface SourceSelection { revision: number; source: AuthSource | null }
export interface BrokerOwner {
  current(): SourceSelection
  source(): Promise<SourceSelection & { source: AuthSource }>
  onChange(listener: (selection: SourceSelection) => void): () => void
  stopSources(): Promise<void>
  close(): Promise<void>
}
export interface BrokerLease { bearer: string; accountId: string; generation: number; sourceId: string; sourceRevision: number; cacheRevision: number }
export interface TokenBroker {
  get(options?: { rejected?: BrokerLease }): Promise<BrokerLease>
  invalidate(generation: number): void
  isCurrent(lease: BrokerLease): boolean
  close(): Promise<void>
  status(): { ready: boolean; source: 'adapter' | 'standalone' | 'none'; generation: number; reason: string | null }
}
export interface GptModel { id: string; label: string; contextWindow: number; lite: boolean; efforts: string[] }
export interface GptCatalogSnapshot {
  generation: number
  sourceId: string
  sourceRevision: number
  cacheRevision: number
  fetchedAt: number
  models: readonly GptModel[]
}
export interface GptCatalogs {
  get(lease: BrokerLease, signal: AbortSignal): Promise<GptCatalogSnapshot>
  invalidate(): void
}
export interface GptSettingsView { generation: number; fetchedAt: number; models: readonly GptModel[] }
export interface ModelChoice { requested: string; upstream: string; lite: boolean; effort: string | null; efforts: readonly string[] }
export interface TranslationContext { model: ModelChoice; sessionKey: string }
export interface StreamEvent { event: string; data: Obj }
export interface TranslationFailure { status: number; type: string; code: string; message: string; retryAfter: string | null }
```

## Task 1: Capture the auth/Claude wire contracts and vendor the reference

**Files:** Create the three capture scripts above; `test/fixtures/codex-auth-<version>.json`, `claude-messages-<version>.json`, `raine-translation-v0.1.42.json`; `vendor/claude-code-proxy/{LICENSE,UPSTREAM.md,upstream/}`; `src/claude-models.mts`, vendored `types.mts`; `test/claude-models.test.mts`; modify `THIRD_PARTY_NOTICES.md` and install manifest inclusion.

**Consumes:** `scripts/lib/codex-probe.mjs` (`sandboxed`, `probeDirs`, `codexVersion`, `requireSandbox`), `scripts/lib/fake-chatgpt-auth.mjs` (`writeFakeChatgptAuth`); completed M1 bundled binary resolver and real-CLI fixture rule.

**Produces:** captured immutable fake wire examples; `selectGptModels(catalog: Obj): GptModel[]`, `resolveGptModel(requested: string, models: readonly GptModel[]): ModelChoice | null`; source provenance.

- [ ] Write the model tests with explicit expectations; run the focused suite after build and see the missing import fail:

```ts
const models: GptModel[] = [
  { id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol', contextWindow: 272000, lite: true, efforts: ['low', 'medium', 'high'] },
]
assert.equal(resolveGptModel('claude-opus-5-5', models), null)
assert.equal(resolveGptModel('gpt-missing', models), null)
assert.deepEqual(resolveGptModel('gpt-6.1-sol', models), {
  requested: 'gpt-6.1-sol', upstream: 'gpt-6.1-sol', lite: true, effort: null, efforts: ['low', 'medium', 'high'],
})
assert.equal(resolveGptModel('gpt-6.1-sol[1m]', models)?.requested, 'gpt-6.1-sol[1m]')
```

Reject IDs containing control characters, YAML delimiters, slash/path traversal, length >128; use `^gpt-[a-z0-9][a-z0-9.-]*(?:\[1m\])?$`. Strip a recognized suffix for upstream lookup only; echo the exact wire request model. Do not implement priority/fast aliases without catalog support.

- [ ] Record `initialize` → `initialized` → `getAuthStatus` against empty and fake homes, using this exact request matrix and recording types/presence only:

```js
const calls = [
  ['getAuthStatus', { includeToken: false, refreshToken: false }],
  ['getAuthStatus', { includeToken: true, refreshToken: false }],
  ['getAuthStatus', { includeToken: true, refreshToken: true }],
]
const shape = result => ({
  keys: Object.keys(result).sort(),
  authMethod: result.authMethod,
  hasAuthToken: typeof result.authToken === 'string' && result.authToken.length > 0,
  requiresOpenaiAuth: result.requiresOpenaiAuth,
})
```

Use clean `env`, sandbox every binary invocation, including `--version`, and do not print RPC payloads. The planning probe on 2026-10-02 already found keys `authMethod`, `authToken`, `requiresOpenaiAuth`; empty home returns null/null/true; fake ChatGPT home returns `chatgpt`/string/true with refresh false and true. `requiresOpenaiAuth:true` is not a failed login. A fresh fake-token probe proves return shape, not live refresh. The planning pass then verified stale refresh too: an expired fake token (issued 2024-01-01) plus `CODEX_REFRESH_TOKEN_URL_OVERRIDE=http://127.0.0.1:<port>/oauth/token` made the real Codex process request replacement tokens, return the new fake bearer and update its own fake refresh chain. There were two calls across initialization plus the explicit RPC; do not assert one HTTP refresh across startup. Preserve this as a repeatable capture using the exact local response below:

```js
const response = {
  access_token: fakeJwt({ exp: nowSeconds + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-anyengine-probe', chatgpt_plan_type: 'pro' } }),
  id_token: fakeJwt({ exp: nowSeconds + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-anyengine-probe', chatgpt_plan_type: 'pro' } }),
  refresh_token: 'rt-fake-rotated', expires_in: 3600, token_type: 'Bearer',
}
```

Only this isolated fake capture sets the refresh override. The recorder may inspect its own generated fake auth file to assert `tokens.refresh_token === 'rt-fake-rotated'`; production broker code must never read it. Record booleans/counts, not even the fake bearer text in normal evidence.

- [ ] Capture real Claude requests against a loopback fake Messages API with fake `ANTHROPIC_API_KEY` in an isolated HOME/config and no real settings. Record main GPT request, tool result, Claude parent/GPT agent, quota/title auxiliary, `HEAD /api/hello`, stream/non-stream, request hint headers, `/v1/messages/count_tokens`, default/plan/dontAsk permission behavior. Mask generated IDs deterministically. No live model calls. Use Node's existing `node-pty` only for the fake picker capture; no Codex TUI.

- [ ] Vendor only these pinned reference source files and full license: `anthropic/{schema,sse,error}.rs`, `providers/codex/translate/{request,model_allowlist,reasoning_signature,live_stream,reducer,read_rewrite}.rs`, `providers/codex/events.rs`. Record each file's upstream relative path, commit, SHA-256 and adapted destination. Keep source references out of compiled runtime. The source checkout from the earlier spike is available privately; committed documentation must use upstream URLs, not personal source paths.

- [ ] Create the differential recorder using the pinned release binary and a fake Codex backend. Set an isolated `CCP_CONFIG_DIR` with fixture-only dummy values, `CCP_CODEX_BASE_URL` to loopback and `CCP_CODEX_TRANSPORT=http`; sandbox denies external network and keychain access. Never point this recorder at the user's homes. Record exact translated JSON/SSE for text, tool round-trip, image, cached usage, reasoning replay, 429, context overflow and truncated stream. Include a documented expected delta for every intentional upstream bug fix; do not rubber-stamp a bad upstream output.

- [ ] Implement catalog mapping against M1's upstream catalog shape: root `models` array, entry `slug`, `display_name`, `visibility === 'list'`, numeric `context_window`, `supported_reasoning_levels[].effort`, numeric ascending `priority`. Task 1 only maps provided fixture data: no broker, HTTP, persistence or runtime producer. Task 4 owns authenticated retrieval and generation-bound snapshots; Task 5 wires their producer and settings view. Never synthesize lane capabilities from `model/list` if that RPC omits them. Preserve `use_responses_lite` and supported efforts instead of guessing from model name. Missing lane information uses the normal Responses lane only if the captured backend accepts it; otherwise omit that model with a doctor reason. Keep first ten visible GPT rows in stable catalog order.

```ts
export function resolveGptModel(requested: string, models: readonly GptModel[]): ModelChoice | null {
  if (!/^gpt-[a-z0-9][a-z0-9.-]*(?:\[1m\])?$/.test(requested) || requested.length > 128) return null
  const id = requested.replace(/\[1m\]$/, '')
  const model = models.find(row => row.id === id)
  return model ? { requested, upstream: id, lite: model.lite, effort: null, efforts: model.efforts } : null
}
```

- [ ] Run `npm run build` and `node scripts/test-hermetic.mjs dist/test/claude-models.test.mjs`; verify fixtures contain no real names, paths, tokens or uncontrolled timestamps; commit `test: capture Claude messages and Codex broker contracts`.

## Task 2: Broker cache and real Codex source ownership

**Files:** Create `broker-{types,cache,source,owner}.mts`, `test/broker.test.mts`; modify `codex-upstream.mts` real-child lifecycle events/guarded requests, `codex-mux.mts` source lifecycle wiring, `router-hooks.mts` runtime lifecycle and router shutdown. Do not route broker calls through desktop-facing reserve/identity responses.

**Consumes:** `CodexUpstream.request(method, params, timeoutMs)` and `.running`; M1 private-socket conventions and shutdown hooks; `resolveBundledCodex`; Task 1 auth fixture.

**Produces:**

```ts
export function createTokenBroker(input: { account: () => ActiveAccount; owner: BrokerOwner; now?: () => number }): TokenBroker
export function startBrokerSource(input: { root: string; home: string; generation: number; childId: string; pid: number; request: AuthSource['request'] }): Promise<{ id: string; close(): Promise<void> }>
export function createBrokerOwner(input: { root: string; account: () => ActiveAccount; launch: (home: string) => Promise<AuthSource & { close(): Promise<void> }> }): BrokerOwner
// Added to CodexUpstream; childId is fresh for each spawned process, not the mux lifetime.
export type CodexChildEvent = { type: 'ready'; childId: string; pid: number } | { type: 'exit'; childId: string }
// CodexUpstream instance methods:
onChildLifecycle(listener: (event: CodexChildEvent) => void): () => void
requestForChild(childId: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown>
```

`BrokerOwner.current()` is synchronous. Its monotonically increasing `revision` changes before publishing a different ready source or no source, including same-account replacements; subscribers are notified synchronously before a new source is usable. `stopSources()` first publishes no source/revises/invalidate, then waits for the broker-owned real child family to exit and closes borrowed adapter source connections; it never independently kills an adapter child. M3 coordinates adapter child shutdown separately. `TokenBroker.invalidate(generation)` remains synchronous and always advances an internal cache revision even when the generation argument equals the current one. `isCurrent(lease)` compares active generation, elected source ID/revision and the captured internal cache revision; no secret is exposed.


- [ ] Add concrete fake-source tests before implementation. Create JWTs entirely in tests, with `exp` and `https://api.openai.com/auth.chatgpt_account_id`; never read fixture credentials from disk:

```ts
let calls = 0
const source: AuthSource = {
  id: 'fake-source', generation: 1, home: '/fake/codex',
  async request(method, params) {
    assert.equal(method, 'getAuthStatus')
    assert.equal(params.includeToken, true)
    calls++
    return { authMethod: 'chatgpt', authToken: fakeJwt({ exp: 2000, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-fake' } }), requiresOpenaiAuth: true }
  },
}
const owner: BrokerOwner = {
  current: () => ({ revision: 1, source }),
  source: async () => ({ revision: 1, source }),
  onChange: () => () => {},
  stopSources: async () => {}, close: async () => {},
}
const broker = createTokenBroker({ account: () => ({ home: '/fake/codex', generation: 1 }), owner, now: () => 1000000 })
const leases = await Promise.all(Array.from({ length: 7 }, () => broker.get()))
assert.equal(calls, 1)
assert.ok(leases.every(lease => lease.accountId === 'acct-fake' && lease.generation === 1))
assert.equal(JSON.stringify(broker.status()).includes('acct-fake'), false)
await broker.close()
```

Add cases: empty login; API-key mode rejected for this subscription backend; malformed JWT/claims; missing account ID; expired bearer; refresh rejected; seven concurrent 401s cause one renewed request; source generation changes during pending request; no source; source dies; two adapter candidates; stale Unix socket; wrong home; session shutdown; old rejected lease must not evict a newer lease. Check returned/logged errors use stable codes and cannot contain the fake secret.

- [ ] Implement the cache using one value and one in-flight promise keyed by `(accountGeneration, ownerSourceRevision, cacheRevision, sourceId)`. Subscribe to `owner.onChange` at broker construction. Every change drops cached state, advances `cacheRevision`, detaches the old in-flight slot and wakes its waiters with `broker.source-changed`; they may retry once against the new selection and coalesce on its one new promise. The old RPC may still settle, but cannot fulfill an old waiter or overwrite/clear the replacement flight. In each flight finalizer clear the shared slot only if `inflight === thisFlight`. Unsubscribe on close. Decode only the OpenAI access-token claims returned by Codex; accept `chatgpt` only and require account claim and finite future `exp`. Treat claims as expiry/account metadata, never as independently verified identity. Cache until `min(exp * 1000 - 60_000, now + 300_000)`. On cache miss first use `getAuthStatus` with `refreshToken:false`; if its bearer is within 60 seconds of expiry, or a matching cached lease was rejected with 401, ask the same real process once with `refreshToken:true`. This avoids forcing refresh on every cache poll. Do not directly refresh OAuth. If the refreshed token is still within 60 seconds of expiry, report `broker.token-expired` rather than loop. On a rejected lease, invalidate only if source ID, source revision, cache revision, generation and bearer still equal the cached lease; a late 401 from A must not evict B.

```ts
const selected = await owner.source()
const generation = account().generation
const capturedCacheRevision = cacheRevision
const { source, revision } = selected
const auth = await source.request('getAuthStatus', { includeToken: true, refreshToken: false })
const current = owner.current()
if (generation !== account().generation || source.generation !== generation ||
    capturedCacheRevision !== cacheRevision || current.revision !== revision ||
    current.source?.id !== source.id) throw new Error('broker.source-changed')
// Apply this guard after every awaited auth RPC, including forced refresh, before returning or caching.
// The returned BrokerLease includes sourceRevision: revision and cacheRevision: capturedCacheRevision.
```

A source-change rejection is retried once inside `get()` with the new source; continued churn becomes 503. JavaScript cannot zero immutable strings; drop references on invalidation/close and never serialize cache state.

- [ ] Add a private broker source socket for each adapter real child. Directory `<root>/broker/sources` mode 0700; sockets mode 0600; metadata only `{id,childId,pid,home,generation,socket}`; no bearer file. Frame one JSON line, max 32 KiB, 10-second request deadline, only method `getAuthStatus`, hard-code allowed parameters, no general JSON-RPC tunnel. Validate directory/file ownership and reject symlink registrations/out-of-root sockets. Connect directly to the real `CodexUpstream.request` so reserve mode continues masking desktop auth while the broker sees the actual child's result. Wire registration to `CodexUpstream.onChildLifecycle`, not just mux creation/destruction: generate a new childId on each real spawn; emit ready only after that child's successful initialize/initialized handshake; emit exit immediately on exit or before terminating it for restart. Cover the internal `scheduleRestart()` path. The registration socket closes/unregisters on exit and a fresh socket/ID is published on replacement ready. Bind its RPC callback to `requestForChild(childId, ...)`, which rejects if that child is no longer current, so an A socket cannot silently send through B. Owner socket-close/unregister/ready events synchronously revise selection before serving another token request. No broker source is published for a mocked/reserve-only child.

- [ ] Add the exact same-account late-result regression with deferred promises, without timing sleeps. In the test helper, `elect(source)` advances a revision and synchronously invokes every listener; `deferred<T>()` returns `{promise, resolve, reject}` backed by captured Promise callbacks. Both sources have generation 1, home `/fake/codex`, distinct IDs and tokens. Start seven `broker.get()` calls while A's `request()` waits; assert A RPC count is 1. Elect B; allow B's single RPC to return before resolving A, then resolve A late. Assert:

```ts
assert.equal(owner.current().source?.id, 'B')
assert.equal(aCalls, 1)
assert.equal(bCalls, 1)
assert.ok((await Promise.all(waiters)).every(lease => lease.sourceId === 'B' && lease.sourceRevision === 2))
assert.equal((await broker.get()).sourceId, 'B')
assert.equal(bCalls, 1)
```

Repeat with A settling before B, a same-generation explicit `invalidate(1)`, A rejecting after B was cached, and real fake-child exit/internal respawn with a held RPC. In every case no A lease is returned/cached after B is elected, and A's finalizer cannot clear B's flight. Add a lifecycle test proving two ready events/IDs and an intervening exit across `scheduleRestart()`, with no socket ready during initialization.

- [ ] Elect the oldest ready adapter source matching canonical home and active generation. An already-started model stream keeps its account admission; on source loss invalidate the auth cache immediately and elect a replacement for new auth requests. Never retain a dead source until a pending auth RPC completes. If none exists, lazily launch exactly one real app-server with `CODEX_HOME` equal to that canonical home, no copied auth, clean env, no model turn, and no router recursion. Do not inherit `CODEX_REFRESH_TOKEN_URL_OVERRIDE`, `CODEX_REVOKE_TOKEN_URL_OVERRIDE`, `CODEX_AUTHAPI_BASE_URL`, bearer/API-key environment overrides or proxy variables into this production child; those are fake-capture seams only. Hold a local ownership lock and record only PID/source metadata. Close and await a standalone source before borrowing a newly ready adapter. Router shutdown closes only its own standalone child, never adapter children. A new account generation invalidates all old leases before serving new calls. M3 will drain active translated requests before changing `ActiveAccount`; M2 must expose active-request counts for that future gate.

- [ ] Prove filesystem/network boundaries with a fake child: bearer exists only in RPC/in-memory HTTP injection, the launch argv/env contain none, no auth file is created by broker code, and no request targets an OAuth host. Scan the new modules for `auth.json`, `refresh_token`, `keychain`, `oauth/token`; any reference must be a negative test/comment, never a production operation.

- [ ] Run build plus broker tests; commit `feat: broker GPT bearer from the active Codex process`.

## Task 3: Port pure request, tool, reasoning and usage translation

**Files:** Create vendored `request.mts`, `tools.mts`, `reasoning.mts`, `usage.mts`; `test/claude-request.test.mts`; update provenance.

**Consumes:** Task 1 `ModelChoice`, fixtures and pinned Rust functions.

**Produces:** `translateRequest(request: Obj, ctx: TranslationContext): Obj`; `sanitizeToolSchema(schema: Json): Json`; `sessionKey(headers: Record<string, string | string[] | undefined>, request: Obj): string`; `encodeReasoning(id: string, encrypted: string): string | null`, `decodeReasoning(signature: string): { id: string; encrypted_content: string } | null`; `mapUsage(usage: Obj): Obj`.

- [ ] Write the first behavior tests and run them failing:

```ts
const request: Obj = {
  model: 'gpt-6.1-sol', stream: true, system: [{ type: 'text', text: 'Be brief.' }],
  messages: [
    { role: 'user', content: 'Read marker.txt' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'marker.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'MARKER-42' }] },
  ],
  tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string', pattern: '^/' } } } }],
}
const translated = translateRequest(request, {
  model: { requested: 'gpt-6.1-sol', upstream: 'gpt-6.1-sol', lite: true, effort: null, efforts: ['low', 'medium', 'high'] }, sessionKey: 'session-a/agent-one',
})
assert.equal(translated.store, false)
assert.equal(translated.stream, true)
assert.equal(translated.prompt_cache_key, 'session-a/agent-one')
assert.equal(translated.tools, undefined)
const input = translated.input as Obj[]
assert.equal(input[0]?.type, 'additional_tools')
assert.ok(input.some(item => item.type === 'function_call' && item.call_id === 'call_1'))
assert.ok(input.some(item => item.type === 'function_call_output' && item.output === 'MARKER-42'))
assert.deepEqual(mapUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 75 }, output_tokens: 8 }), {
  input_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 75, output_tokens: 8,
})
```

- [ ] Port the selected source algorithms, keeping each concern under roughly 350 lines. Exact mapping requirements:

| Messages input | Responses output |
|---|---|
| string/text user content | `message` / `input_text` in original order |
| assistant text | assistant message / `output_text` |
| system text blocks | normal lane `instructions`; Lite `developer` message before history |
| tool definition | function `{type:'function',name,description,parameters,strict:false}` |
| `tool_use` | `function_call` with original name/call ID and serialized input |
| `tool_result` | `function_call_output` with matching `call_id`; preserve error text and image parts |
| base64/URL image | `input_image` data URL/URL; validate media type/size, no URL fetch in translator |
| own `thinking.signature` | decode `ccp:codex:v1:` reasoning item; foreign signatures never replay to GPT |
| `tool_choice:auto/any/none/tool` | `auto/required/none/{type:'function',name}`; reject a named tool absent from the request |
| `output_config.effort` | choose supported effort; `max` maps to highest supported level; adaptive thinking alone uses model default |
| JSON output schema | `text.format:{type:'json_schema',name:'response',schema,strict:true}` using pinned schema normalizer |
| Claude-only `safeguards`, `context_management`, beta annotations | not forwarded as unknown GPT top-level fields |
| normal vs Lite lane | top-level tools vs `additional_tools` developer item; Lite parallel tool calls false, recorded lane metadata |

Never append tools, a system message, filesystem instructions or broader permissions that the caller did not provide. Do not port raine's optional Read offset rewrite/guidance into the first implementation: preserve tool args/names verbatim. Reject unsupported executable server tools with a clear 400 instead of silently dropping them or running them. For Anthropic hosted web-search, port the pinned full-lane mapping and result events only after its fixture passes for a supported catalog model; otherwise return explicit `unsupported_tool` without execution. Claude Code client-executed `WebSearch` as a normal function remains supported.

- [ ] Implement schema sanitization as a clone, removing `pattern` only in schema-bearing positions (`properties`, `$defs`, `definitions`, `dependentSchemas`, tuple/items, applicators). Preserve literal defaults/examples and properties named `pattern`; never recursively delete matching keys in arbitrary data. Do not mutate the incoming request. Handle prototype keys as data using `Object.create(null)` or safe entry construction.

```ts
const original = { type: 'object', properties: { pattern: { type: 'string', pattern: 'x', default: { pattern: 'literal' } } } }
const cleaned = sanitizeToolSchema(original) as Obj
assert.equal(JSON.stringify(cleaned).includes('"pattern":"x"'), false)
assert.equal(JSON.stringify(cleaned).includes('"pattern":"literal"'), true)
assert.equal(JSON.stringify(original).includes('"pattern":"x"'), true)
```

- [ ] Port the reasoning signature byte limits and exact format (4 KiB UTF-8 ID, 8 MiB encrypted blob). Unit-test invalid base64, oversized ID/blob, foreign signatures, missing `encrypted_content` on a final event and resumed transcript replay. Retain opaque ciphertext only in response content returned to Claude; never log it.

- [ ] Build cache identity from validated session and agent hint headers: `sha256('claude-code\0' + session + '\0' + agent)`. Use a stable metadata session ID only when the captured real request provides one. With no identity, use a fresh UUID per request rather than one global key. Cap each input identifier at 256 bytes; reject control characters. Auxiliary and compaction calls with the same session/agent keep the same key; different agents never collide. Full-history transport requires no server-side state.

- [ ] Run request/model tests and fixture comparisons, including nested schema, all tool-choice forms, MCP names, tool-result errors/images, reasoning resume, usage where cached tokens exceed total (saturating subtraction), and unsupported block errors. Commit `feat: port Messages request translation from raine`.

## Task 4: Stream translation, faithful errors and broker-authenticated transport

**Files:** Create vendored `stream.mts`, `errors.mts`; `src/claude-gpt.mts`, `src/claude-catalog.mts`; `test/claude-stream.test.mts`, `test/claude-gpt.test.mts`, `test/claude-catalog.test.mts`; update provenance.

**Consumes:** Task 2 `TokenBroker`/`BrokerOwner`, Task 1 pure `selectGptModels`/`resolveGptModel`, Task 3 translation, M1 `relayAgent` (dedicated verified-TLS agents), upstream reference `live_stream`, `reducer`, `events`.

**Produces:** `createStreamTranslator(requestedModel: string, messageId: string): { push(event: Obj): StreamEvent[]; end(): StreamEvent[]; readonly finished: boolean }`; `mapFailure(status: number, body: Obj, retryAfter?: string): TranslationFailure`; `serveGpt(input: { req: IncomingMessage; res: ServerResponse; body: Obj; requestedModel: string; broker: TokenBroker; catalogs: GptCatalogs; upstream: URL; signal: AbortSignal; admission: AccountAdmission }): Promise<void>`.

- [ ] Write stream fixtures as assertions before implementation:

```ts
const stream = createStreamTranslator('gpt-6.1-sol[1m]', 'msg_test')
const start = stream.push({ type: 'response.created', response: { id: 'resp_1' } })
assert.equal((start[0]?.data.message as Obj).model, 'gpt-6.1-sol[1m]')
stream.push({ type: 'response.output_item.added', output_index: 0,
  item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '' } })
stream.push({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"file_path":' })
assert.throws(() => stream.end(), /incomplete_stream/)
assert.equal(stream.finished, false)
assert.equal(mapFailure(429, { error: { message: 'quota', code: 'usage_limit_reached' } }, '15').status, 429)
assert.equal(mapFailure(400, { error: { code: 'context_length_exceeded', message: 'input too long' } }).code, 'context_length_exceeded')
```

- [ ] Port the reducer/state machine. Index content blocks by output index/item ID; start each block once, close it once, retain tool call IDs/names, accumulate JSON fragments and emit `input_json_delta`. Forward text and reasoning deltas, including signatures from reasoning items. Emit `message_start` with the requested alias; terminal usage must contain authoritative totals. `response.completed` becomes `tool_use` when a function call was emitted, otherwise `end_turn`. A standard `response.incomplete` with `max_output_tokens` becomes `max_tokens`; other incomplete/failed/error events are failures. An EOF before terminal must fail. Duplicate terminal events do not emit duplicate `message_stop`. Empty completion fails instead of claiming useful output.

- [ ] Implement incremental SSE parsing with split UTF-8/codepoint, CRLF and multi-line data support, 8 MiB maximum frame and 32 MiB bounded aggregate for a nonstreaming answer. Keep network reads backpressured on `res.write`/`drain`; cap buffered tool args at 5 MiB. Send Anthropic `ping` every 15 seconds while waiting; always clear timers/listeners. Caller disconnect aborts the upstream request and stops the timer. Nonstreaming input aggregates the same reducer into one Anthropic message instead of silently switching client format.

- [ ] Use error rules below before headers; after streaming starts emit one Anthropic SSE `error` with the same error object and close without `message_stop`:

| Upstream condition | HTTP / Anthropic error |
|---|---|
| invalid input or unsupported tool/model | 400 `invalid_request_error`, precise stable code |
| context overflow (400/413 or in-stream error) | 400 `invalid_request_error`, code `context_length_exceeded`, message `prompt is too long: context length exceeded` |
| broker has no ChatGPT login / repeated upstream 401 | 401 `authentication_error`; “Run codex login” without token/account details |
| GPT permission denial | 403 `permission_error` |
| quota/rate limit, HTTP or event | 429 `rate_limit_error`; preserve valid Retry-After |
| overload | 529 `overloaded_error` |
| timeout before response | 504 `api_error` |
| malformed/truncated stream or other backend failure | 502 `api_error` |

Do not echo raw backend bodies in error/log fields. Preserve a small allowlist of public error codes and sanitize bounded explanatory text; fake credential markers in backend errors must never escape. Do not translate rate limits to 502 or fabricate estimated final usage.

- [ ] Implement the named authenticated catalog producer in `src/claude-catalog.mts`:

```ts
export function createGptCatalogs(input: { broker: TokenBroker; owner: BrokerOwner; upstream: URL; root: string; now?: () => number }): GptCatalogs
export function readGptSettingsView(input: { admission: AccountAdmission; broker: TokenBroker; catalogs: GptCatalogs; signal: AbortSignal }): Promise<GptSettingsView>
```

`GptCatalogs.get(lease, signal)` fetches the real upstream `/models` with the passed broker lease's bearer/account header and M1's known catalog query, using fixed-origin no-redirect verified-TLS transport. Caller must already hold account admission; get never acquires a nested lease. Before starting and after consuming the bounded response, require `broker.isCurrent(lease)` and bind the returned `GptCatalogSnapshot` to that exact generation/source ID/source revision/cache revision. Use only `selectGptModels` to parse the response. Cache for at most five minutes and coalesce by generation/source ID/source revision/cache revision; owner change or `invalidate()` clears pending publication just like the broker. An A catalog completing after B is elected cannot be returned or persisted as B. A source-stale error permits one fresh broker+catalog attempt inside the same admission before any model bytes; further churn is 503.

Persist only a bounded metadata projection `{generation, sourceId, sourceRevision, cacheRevision, fetchedAt, models}` at `<root>/router/claude-gpt-catalog.json`, mode 0600; never account IDs, auth or response headers. The on-disk snapshot is diagnostic/settings evidence only and cannot authorize routing after runtime restart; re-fetch before accepting model traffic. Keep one current snapshot, no history. A successful snapshot with no requested model yields local 400; failed/unavailable catalog yields 503 rather than falsely claiming the model unsupported. The settings view function acquires its own admission, gets matching lease/snapshot, strips source identifiers to `GptSettingsView`, then releases; Task 5 exposes this credential-free view to the control CLI. No Task 1 I/O and no dependency on settings installation exist in this producer.

- [ ] Acquire `AccountAdmission.begin(signal)` before calling the broker or catalog and resolve the requested model only after admission. `serveGpt` accepts `requestedModel`, never a pre-resolved `ModelChoice`. Retain admission across bearer acquisition, capability lookup, the one 401 retry and the complete model stream. Release once in `finally` after upstream closure. M2 supplies in-memory admission using active generation/count; M3 injects its coordinator. Do not timeout-release a live participant.

```ts
const admissionLease = await admission.begin(signal)
try {
  const lease = await broker.get()
  if (lease.generation !== admissionLease.generation) throw new Error('broker.source-changed')
  const snapshot = await catalogs.get(lease, signal)
  if (snapshot.generation !== admissionLease.generation || snapshot.sourceId !== lease.sourceId ||
      snapshot.sourceRevision !== lease.sourceRevision || snapshot.cacheRevision !== lease.cacheRevision || !broker.isCurrent(lease)) {
    throw new Error('catalog.source-changed')
  }
  const model = resolveGptModel(requestedModel, snapshot.models)
  if (!model) throw new Error('invalid_request_error: unsupported_model')
  // Build translated body and headers from this model/lease; recheck isCurrent immediately
  // before the synchronous http.request/end invocation. No await between final check and send.
} finally {
  await admissionLease.release()
}
```

Use typed failure codes in implementation so unsupported-model is 400 and source/catalog stale is 503. A 401 retry must reacquire bearer, retrieve/revalidate the admitted-generation snapshot, resolve the original requested string again and rebuild lane-dependent body/headers. A same-account source replacement can change capabilities; do not reuse the first attempt's ModelChoice. If account generation mismatches, send no model bytes and return 503; never acquire another generation inside this request's admission.

- [ ] Add the freeze/rotation catalog regression. Request begins with active generation A=1 and metadata showing `gpt-shared` Lite=true plus `gpt-a-only`; admission is held by a deferred gate. Change provider/elected source to B=2 with `gpt-shared` Lite=false and no `gpt-a-only`, then admit the waiting request at generation 2. Assert no broker/catalog/model I/O occurred while frozen. For `gpt-a-only`, B catalog is read, response is 400 and model endpoint receives zero requests. For `gpt-shared`, the only model call uses B's fake bearer/account, normal-lane top-level tools and no Lite header/additional_tools. A's cached or late catalog cannot be used. Test both concurrent requests and source replacement within B without changing generation, plus 401→new source/capabilities. Assert each request releases admission once on success/error/abort.

Test normal completion, client abort, pre-header auth error and in-stream failure each release once; seven open streams retain seven admissions until their respective sockets close. Test `readGptSettingsView` waits through the same freeze and emits B models only, with no bearer/account/source fields, and never holds admission while writing settings.

- [ ] Inject only broker-owned headers. Construct the outgoing header object from scratch, never spread incoming headers:

```ts
// lease and model were obtained/revalidated together after admission above.
const headers: Record<string, string> = {
  authorization: `Bearer ${lease.bearer}`,
  'chatgpt-account-id': lease.accountId,
  'content-type': 'application/json', accept: 'text/event-stream',
  'user-agent': 'anyengine',
  'openai-beta': 'responses=experimental',
}
if (model.lite) {
  headers.originator = 'codex_cli_rs'
  headers['x-openai-internal-codex-responses-lite'] = 'true'
} else headers.originator = 'anyengine'
```

Use the fixed ChatGPT Responses origin in production; loopback override is injectable only in tests. Do not forward incoming Authorization, x-api-key, cookie, anthropic-beta, proxy headers or arbitrary session metadata. Disable redirect-following so bearer cannot leave the selected origin. Use `relayAgent` rather than environment proxy agents. Retry a backend 401 exactly once, only before semantic output, asking `broker.get({rejected:lease})`, then revalidating/refetching that lease's catalog and resolving the requested model again as above; compare admitted generation and never mix accounts in one stream. No automatic retry of quota, tools already emitted, incomplete streams or ordinary 5xx.

- [ ] Test local fake backend receives fake broker auth and never any Claude credential; simulate 401→refresh→200, 401 twice, seven parallel requests, 429/Retry-After, context error after 200, abrupt EOF, slow consumer and cancellation. Compare text/tool/reasoning/usage results against Task 1 differential fixtures. Run build plus stream/GPT/request suites; commit `feat: stream GPT messages with broker authentication`.

## Task 5: Add the Claude Code face without changing Claude payloads

**Files:** Create `src/router-messages.mts`, `test/router-messages.test.mts`; modify `router-server.mts`, `router-hooks.mts`.

**Consumes:** `readBody`, `readJsonBody`, `passthrough`, `localOnly` from M1; Task 4 `serveGpt`, `createGptCatalogs`, `readGptSettingsView`.

**Produces:** `messagesHook(deps: { broker: TokenBroker; admission: AccountAdmission; catalogs: GptCatalogs; anthropicOrigin?: string; gptOrigin?: string }): (ctx: RouterContext, req: IncomingMessage, res: ServerResponse) => Promise<boolean>`; new optional `RouterHooks.messages` of that signature. Origin overrides accept loopback only in explicit test dependencies; production Anthropic target remains fixed.

- [ ] Add raw-wire test expectations before routing implementation:

```ts
const raw = Buffer.from('{ "model" : "claude-opus-5-5", "messages":[], "future": {"n":1} }\n')
// Send raw to the test router with a fake Authorization, beta header and query.
// The fake Anthropic server captures bytes in memory only.
assert.deepEqual(capturedBody, raw)
assert.equal(capturedPath, '/v1/messages?beta=true')
assert.equal(capturedHeaders['anthropic-beta'], 'oauth-2025-04-20,future-beta')
assert.equal(capturedHeaders.authorization, 'Bearer FAKE-CLAUDE-ONLY')
assert.equal(answer.headers['anthropic-ratelimit-unified-5h-status'], 'allowed')
assert.deepEqual(answer.body, upstreamBody)
```

The HTTP test harness uses ephemeral ports and existing `tempDir`/child cleanup helpers; the fake server is the only allowed destination for test credentials.

- [ ] Dispatch the Messages hook after the same M1 `localOnly`/health gates and before rejecting non-Codex paths. It must return false for `/backend-api/codex/*`, `/health` and internal router endpoints. Return true for Claude API paths; bound body length with M1 limits, parse a copy only to select a string model. Retain the original raw buffer for Claude. Malformed/unknown JSON goes unchanged to Anthropic, which owns its error semantics; size/decompression limits remain local protections. Query strings are retained.

```ts
const parsed = readJsonBody(raw, req.headers['content-encoding'])
const requested = typeof parsed?.model === 'string' ? parsed.model : ''
if (!requested.startsWith('gpt-')) {
  passthrough({ ...ctx, upstream: () => 'https://api.anthropic.com' }, req, res, path, query, raw)
  return true
}
// Prefix selection only; do not inspect cached model availability/lane here.
await serveGpt({ req, res, body: parsed!, requestedModel: requested, broker: deps.broker,
  catalogs: deps.catalogs, admission: deps.admission, upstream: gptUpstream, signal })
// serveGpt resolves/rejects this model against the admitted-generation snapshot.
```

Existing relay changes only transport hop headers/Host/Content-Length as necessary; “byte-exact” means entity bytes and end-to-end header values, not TCP framing or header casing. Forward response raw headers with duplicate order via existing `forwardRawHeaders`. Do not attach M1's GPT error-body observer to the Anthropic relay: it must not capture/log Claude bodies. Pass through `HEAD /api/hello`, unknown Anthropic paths and Claude `count_tokens` with no JSON re-encoding. Reject absolute-form/cross-origin URLs using the existing target-origin check.

- [ ] For GPT `/v1/messages/count_tokens`, answer a deterministic conservative local estimate explicitly identified as estimated in internal diagnostics: UTF-8 text/tool-schema bytes divided by 3 rounded up, plus 1024 per image, minimum 1. Do not forward GPT IDs with Claude auth to Anthropic. Main `message_delta.usage` is always upstream-authoritative. Pin this endpoint against the real Claude fixture; if CLI does not call it, keep the bounded implementation for manual/next-version clients.

- [ ] Test gzip, br and uncompressed bodies; unknown non-GPT model; missing model; malformed JSON; HEAD; beta query; SSE payload bytes; duplicate rate-limit headers; 401/429 passthrough; disconnect; oversize request; browser-origin gate; Anthropic redirect returned without following; known GPT sends no Anthropic headers; broker unavailable still permits Claude traffic. Assert no fake credential appears in router logs/status/error output.

- [ ] In `buildRouterRuntime`, construct one broker owner → broker → `createGptCatalogs` instance, inject catalogs/admission into Messages routing, and clear catalog state before broker/source shutdown. Add local-gated `GET /control/claude-code/models`, which calls `readGptSettingsView` and serializes only `{generation,fetchedAt,models}`; this route is handled before generic Anthropic passthrough and never returns auth/source/account values. The control CLI's `fetchGptSettingsView(baseUrl: string, signal: AbortSignal): Promise<GptSettingsView>` consumes this route; HTTP 503 is a preflight failure, not an empty model list. Task 6 passes that view into pure settings generation and records its generation/fetchedAt as metadata. UI rows are suggestions; every subsequent GPT request still revalidates live after admission, so an account change after a settings read cannot authorize an old model/lane.

Wire the broker/runtime close lifecycle into the completed M1 runtime; keep health success for the router while publishing a separate Claude-Code-GPT readiness field. The router's Claude passthrough remains usable with GPT degraded. Run build plus router/Claude suites; commit `feat: route Claude Code Messages through AnyEngine`.

## Task 6: Reversible user settings and generated GPT agents

**Files:** Create `control-claude-settings.mts`, `control-claude.mts`, `control-m2-rollback.mts`, `test/control-claude.test.mts`, `test/control-m2-rollback.test.mts`; modify `control-layers.mts`, `control-install.mts`, `control-scripts.mts`, `control-flip.mts`, `control-flip-run.mts` (completed M1 detached flip/recovery owners), `control-commands.mts`, `scripts/install-lib.mjs` retention pins, settings docs and install selfcheck.

**Consumes:** M1 `System`, `OnPlan`, `LayerWriter`, `FileChange`, `Layer`, `persistRecord`, `readLayers/writeLayers`, `restoreChange`, `applyOnFiles/applyOffFiles/finishOff`, node-free rollback generation and detached flip/recovery gate; Task 5 `fetchGptSettingsView` and Task 4 `GptSettingsView`.

**Produces:**

```ts
export function buildClaudeSettings(before: Obj, input: { baseUrl: string; haiku: string; models: readonly GptModel[] }): Obj
export function renderGptAgent(model: GptModel): string
export function applyClaudeLayer(input: { root: string; home: string; writer: LayerWriter; catalog: GptSettingsView; baseUrl: string; haiku: string }): void
export function restoreClaudeSettings(current: Obj, before: Obj, after: Obj, ownedModels: readonly string[]): { value: Obj; conflicts: string[] }
export interface M2Baseline {
  version: 1
  rollbackDir: string
  recoveryScript: string
  recoveryJournal: string
  phase: 'prepared' | 'activating' | 'active' | 'rolling-back' | 'rolled-back' | 'conflict'
  priorLib: string
  m1LayersBackup: string
  m1LayersSha256: string
  controlChanges: FileChange[]
  jobs: Array<{ label: string; plist: string; loaded: boolean }>
}
export interface M2RollbackResult { ok: boolean; restoredLib: string | null; conflicts: string[]; m1Verified: boolean }
export function prepareM2Upgrade(system: System, root: string, plan: OnPlan): M2Baseline
export function readM2Baseline(root: string): M2Baseline | null
export function rollbackM2(system: System, root: string, options: { noRestart: boolean }): Promise<M2RollbackResult>
export function m2RollbackScript(baseline: M2Baseline, options: { root: string; app: string; bundleId: string }): string
export function retainedM2Libraries(root: string): string[]
```

CLI contracts while M2-aware entrypoints are installed: `anyengine rollback m2 [--no-restart]` calls `rollbackM2`; generated `<root>/bin/anyengine-off --m2-only [--no-restart]` performs the same target without Node. Both hand off to the surviving recovery entrypoint below. Once those commands have reverted to M1, resume/repeat by that surviving command directly; unmodified M1 does not implement either M2 option. `--m2-only` and `--router-only` are mutually exclusive. Normal full `off` and `--router-only` retain their documented broad semantics after undoing their dependent Claude layer. The automatic M2 failure target is `m2`, not either broad off mode.


- [ ] Test the pure settings transform before implementation:

```ts
const before: Obj = { theme: 'dark', permissions: { deny: ['Read(secret.txt)'] }, env: { MY_ENV: 'keep' }, modelPicker: { options: [{ model: 'custom-claude', label: 'Mine' }] } }
const after = buildClaudeSettings(before, { baseUrl: 'http://127.0.0.1:18790', haiku: 'claude-haiku-4-5-20251001', models })
assert.deepEqual(after.permissions, before.permissions)
assert.equal((after.env as Obj).MY_ENV, 'keep')
assert.equal((after.env as Obj).ANTHROPIC_BASE_URL, 'http://127.0.0.1:18790')
assert.equal((after.env as Obj).CLAUDE_CODE_GATEWAY_HINT_HEADERS, '1')
assert.equal((after.env as Obj).ANTHROPIC_AUTH_TOKEN, undefined)
assert.equal(after.model, undefined)
assert.equal(JSON.stringify(after).includes('bypassPermissions'), false)
```

- [ ] Before the first M2 staging/install operation can prune or mutate anything, capture and fsync the M1 baseline with `prepareM2Upgrade`. Require the prior installed M1 library and router health verified by existing M1 preflight; record the resolved immutable `lib/current` target, copy `layers.json` bytes and hash into a private immutable rollback directory, and retain every prior M1 layer/backup/rollback script unchanged as the baseline. Record router/smoke job labels, plist paths and loaded state. Record every install-control target the M2 upgrade changes with its immediate pre-M2 value, even when an older M1 layer already tracks that path: `lib/current`, launcher/shim/runtime bootstrap files, control/rollback scripts and LaunchAgent plists. Use a write-ahead `controlChanges` record before each such mutation; this is the upgrade delta, not a rewrite of M1's original pre-M1 backup. The current flip's progress journal stays separate so recovery can resume instead of restoring an obsolete active transaction.

Persist `<root>/m2-upgrade.json` (0600, metadata/reference only) and generate the self-contained M2 rollback script before modifying `lib/current` or any live control file. Recovery has an independent lifetime:

- `<root>/recovery/m2/recover.sh` is the stable public bash/JXA dispatcher, mode 0700. It is outside `lib/`, `bin/`, `controlChanges`, M1 layer restoration and all pruning/cleanup targets.
- `<root>/recovery/m2/current.json` (0600) contains absolute `script`, `journal`, `baselineId` and `scriptSha256` fields. The versioned immutable script and retained mutable journal live at `<root>/recovery/m2/<baselineId>/recover.sh` and `journal.json`. `M2Baseline.recoveryScript`/`recoveryJournal` name those absolute files. The dispatcher validates same-owner/non-symlink files, SHA-256 and paths within this recovery directory, then execs the versioned script with arguments as argv. No lookup through `lib/current`, installed `anyengine`, installed `anyengine-off` or Node occurs.
- Persist/fsync script, journal and pointer before advertising recovery or mutating the install. The generated script contains baseline/control hashes and uses system bash/JXA/launchctl tools; every checkpoint goes to its retained journal. It performs idempotent recovery and terminal verification without the M2 library. Keep dispatcher, pointer, script and terminal journal after success for discovery/evidence and repeated verification; a later M2 installation creates a new baseline directory and atomically replaces the pointer, retaining the previous evidence.
- Save a plain-text `<root>/recovery/m2/RECOVER.txt` before activation containing the actual absolute command, baseline ID and journal path. Print the same command on activation/failure. After process death, this retained file/pointer is the discovery mechanism; no automatic behavior from restored M1 is assumed.

The actual public resume/repeat invocation on the default root is:

```sh
/bin/bash "$HOME/.anyengine/recovery/m2/recover.sh"
```

For a custom root, print/use `/bin/bash '<absolute-root>/recovery/m2/recover.sh'` with proper shell quoting. `--no-restart` is accepted by the surviving dispatcher and forwarded. `anyengine-off --m2-only` execs this dispatcher before restoring bootstrap/control scripts; it never rewrites the shell file currently being executed. Existing full/router-only operations must not delete recovery files or an unfinished journal. `prepareM2Upgrade` is idempotent: when an active/pending M2 baseline exists, reuse it instead of snapshotting M2 as its own M1 baseline. Repeated M2 updates keep this first valid M1 baseline until M2-only rollback/full removal succeeds.

`retainedM2Libraries(root)` returns the baseline library while the record is prepared, activating, active, rolling-back or conflicted. Add those pins to `install-lib.mjs` before any pruning, alongside existing current/running-process/layer pins. If a referenced M2 record cannot be parsed/verified, skip pruning and report why. Do not release the pin on failed postflight or incomplete rollback. After successful rollback the old library is current and protected by the ordinary pin; archive rollback evidence outside scratch.

- [ ] Extend `LayerName` with 'claude-code'; add a separate layer after router. It records full backup/after hashes plus a semantic settings descriptor containing touched JSON paths, before/after values and owned row IDs. Repeated `on` adopts the existing M2 layer without replacing its original before snapshot. An upgrade modifies owned rows/files through the same layer and keeps the original rollback. Keep the new M2 baseline pointer separate from M1's original before-link so M1 full/router-only rollback semantics remain intact. Never put full settings content into public status/evidence.

Fetch the credential-free `GptSettingsView` from Task 5 after the staged M2 runtime is ready (private staging router with the canonical home and normal admission is allowed), before writing Claude settings. In dry-run use the last verified view only to preview and label its age; activation requires a successful current view. `applyClaudeLayer` consumes `catalog.models`, records `catalog.generation`/`fetchedAt` in its metadata, and never obtains a bearer or fetches models itself. Do not hold account admission over filesystem writes: row availability is revalidated by every request at runtime, not promised indefinitely by the installer.

Write only:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18790",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001",
    "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1"
  },
  "modelPicker": { "options": [
    { "model": "gpt-6.1-sol", "label": "GPT 6.1 Sol", "description": "via AnyEngine" }
  ] }
}
```

Merge into existing objects; preserve built-in picker behavior, existing options, `replaceBuiltInOptions` and unknown fields. De-duplicate by exact model ID; an existing user row of that model is not owned or overwritten. Validate existing JSON before any write; malformed settings fail the Claude layer atomically. Preserve file mode and use M1 write-ahead records. Refuse symlink settings/agent targets whose resolved location escapes the intended Claude config directory. Detect a concurrent file hash change just before replacement and abort/recompute under the control lock instead of overwriting it.

- [ ] Generate one `~/.claude/agents/<id>.md` per selected safe model ID. If an unowned file already exists, leave it alone and report the collision. Content has no tools list, hooks, permissionMode, MCP server, memory or instruction injection:

```md
---
name: gpt-6.1-sol
description: Use GPT 6.1 Sol through AnyEngine when this model is requested.
model: gpt-6.1-sol
---
```

Omitting permissionMode inherits the parent, including plan/dontAsk. A blank body avoids another system prompt. Name/description values must be escaped from validated catalog strings, never concatenated from an arbitrary unvalidated model description. The local fake Claude agent-load capture must confirm blank body works on the installed CLI before this format ships.

- [ ] Implement semantic off: for each owned env leaf, restore prior value only while current equals the installed value; preserve operator replacement values and report them. Remove only unchanged owned picker rows, restore any prior row state, preserve all added user rows. Remove unchanged generated files and keep edited files as `left-changed`; leave the layer recorded when unresolved work remains. If the operator saved an owned GPT model as `model` while on, replace it with the before `model` or delete it if absent, because routing is being removed. Keep a newly selected Claude or an unowned model default. Apply the same rule to `ANTHROPIC_MODEL` only when M2 owned that exact setting; never alter arbitrary outside environment exports.

Node-free `anyengine-off` must undo this layer too. Extend M1's generated rollback with a system `/usr/bin/osascript -l JavaScript` JSON merge helper embedded as static source (JXA needs no Node/dependency); pass filenames as argv, not code interpolation, check hashes before writing and use atomic sibling replacement. Test it under `/bin/bash` with Node absent from PATH. If current JSON is invalid, do not destroy it: emit the exact settings path, retain the layer and exit nonzero. Hash-identical files use M1's existing backup restore. Do not let a generic hunk fallback corrupt JSON.

- [ ] Implement M2-only rollback in both Node and generated bash/JXA paths, using this order and writing each completed phase to the M2 journal:

1. Freeze new M2 GPT admission and drain/abort acceptance-owned translated requests using existing bounded shutdown, without killing unrelated operator Claude processes. Apply M1's idle/restart safeguards where an app-owned adapter must restart on the prior library.
2. Undo only M2-owned Claude settings/agents with the semantic rules above. If a conflict still points Claude settings at the M2-only face, retain the functioning M2 router/library and return a conflict; do not switch to M1 which cannot serve that face. Record exactly which target needs resolution.
3. Before restoring any M1 library/bootstrap entrypoint, detach M2 recovery metadata from the M1 control namespace: under the control lock, persist the current phase, baseline reference, recovery command and `sharedMarkerDetached:true` to the retained recovery journal; disable further shared `FlipMarker` writes by this M2 runner; remove the shared marker only if its transaction ID matches this M2 operation. A different marker is a conflict, not something to clear. Re-entry handles an already-removed matching marker idempotently. No M2 `failureTarget` or M2 phase is left for old M1 to interpret. Signal/finally handlers after this handoff write only the private recovery journal. Then restore the pre-M2 control delta with hash/hunk safeguards. Restore `lib/current` to `baseline.priorLib`; restore prior launchers/shims/runtime env/plists as captured. Never call `applyOffFiles({routerOnly:true})`, `finishOff` on the M1 router layer, or M1's adapter-only/vanilla rollback for this target. Do not remove the M1 catalog cache or native-fanout proof merely for M2 rollback.
4. Restore the M1 layer/control records from the immutable baseline only when current records match the expected M2 transaction; otherwise report conflict. The prior M1 layer records, original backup directories and rollback script bytes must be unchanged after the round-trip. Retain the recovery journal/pointer/script across restoration and afterward; a crash after restoring `layers.json` is resumed explicitly by the surviving absolute recovery command, even though both installed entrypoints are now M1.
5. Restore router/smoke job loaded state. For a job loaded before M2, keep the same label/plist and restart it onto the prior library; no persistent unload or removal. For a job initially unloaded, restore that unloaded state. If launchctl requires bootout/bootstrap for changed plist contents, journal both and recover to the recorded baseline state. Restart the app only through the normal authorized idle-safe flip when needed.
6. Verify prior M1 library link/manifest, router health/version, job state and M1 records; mark rolled-back, remove M2-only active records/layer and retain rollback evidence. A repeated invocation of the surviving recovery command is a verified no-op; do not test or document a repeated M2-only option through the restored M1 CLI. If the terminal baseline has since been superseded by another explicit installation, the old versioned recovery script reports superseded and makes no changes rather than rolling back unrelated work; exit nonzero on a conflict or unhealthy M1 instead of claiming success.

While the M2-aware dispatcher is installed, register `failureTarget:'m2'` and the absolute recovery command in `FlipMarker.state` before activation; its postflight failure, signal handling and pending-activation resume dispatch to the stable recovery command first. This automatic promise ends at step 3's metadata handoff/bootstrap restoration. A surviving M2 recovery process continues on its private journal, but after it is killed the operator/executor resumes with `/bin/bash "$HOME/.anyengine/recovery/m2/recover.sh"`, not `anyengine on`, `anyengine rollback m2` or M1 `anyengine-off`. The retained pointer/RECOVER.txt is sufficient discovery; no recovery daemon or new schedule is added. The recovery script uses the existing control lock itself and refuses a concurrent live control operation.

Before any restored M1 command can be used, its shared FlipMarker is absent or a valid unchanged pre-existing M1 marker; no stale M2 phase/failureTarget remains. The M2 journal is confined to the recovery namespace and unmodified M1 never consumes it. A failure before shared-marker detachment remains discoverable by the still-M2-aware runner and the stable command; a failure after detachment is recoverable only through the stable command unless that recovery process itself remains running. On conflict leave journal/pins and print the exact surviving command. Broad off remains an explicit separate action and is never an implicit recovery fallback.

- [ ] Add `test/control-m2-rollback.test.mts` with a synthetic healthy installed M1 baseline, distinct M0 and M1 library targets, existing router/smoke records and node-free command stubs. Snapshot baseline control bytes/modes/symlinks and `layers.json`, then run first M2 activation and rollback through each entry point:

```ts
const baseline = prepareM2Upgrade(system, root, m2Plan)
assert.equal(baseline.priorLib, m1Lib)
assert.ok(retainedM2Libraries(root).includes(m1Lib))
// Activate the fake M2 library and layer through applyOnFiles/applyClaudeLayer, then:
const result = await rollbackM2(system, root, { noRestart: false })
assert.equal(result.ok, true)
assert.equal(result.restoredLib, m1Lib)
assert.equal(result.m1Verified, true)
assert.equal(realpathSync(join(root, 'lib/current')), m1Lib)
assert.deepEqual(readFileSync(join(root, 'layers.json')), beforeLayersBytes)
assert.equal(system.jobs.has('dev.anyengine.router'), true)
assert.equal(system.jobs.has('dev.anyengine.smoke'), true)
assert.deepEqual(readFileSync(settingsPath), beforeSettingsBytes)
assert.equal(existsSync(generatedAgentPath), false)
assert.deepEqual(snapshotM1Records(), beforeM1Records)
```

Define the test-local `snapshotM1Records()` to return sorted `{path,sha256,mode,linkTarget}` for the baseline's recorded control files plus each pre-existing layer's manifest/rollback files; it excludes mutable router runtime logs and the separate retained recovery evidence. Test initial dispatch through the M2-installed `/bin/bash <root>/bin/anyengine-off --m2-only` with `PATH=/usr/bin:/bin` and broken/absent Node/lib. In distinct fault-injection runs, kill the recovery process immediately after (a) restoring the M1 library and bootstrap/control scripts, (b) restoring M1 layer records, and (c) during job reload. Assert installed command bytes are already the unmodified M1 baseline where expected, the shared FlipMarker carries no M2 transaction/failureTarget, and the stable recovery script/pointer/journal still exist. For each of these runs use the real public re-entry command, not an M2 library helper:

```ts
const resumed = spawnSync('/bin/bash', [join(root, 'recovery/m2/recover.sh')], {
  env: { ...fakeSystemEnv, PATH: '/usr/bin:/bin' }, encoding: 'utf8',
})
assert.equal(resumed.status, 0, resumed.stderr)
assert.deepEqual(snapshotM1Records(), beforeM1Records)
assert.equal(readFlipMarker(root), null)
const again = spawnSync('/bin/bash', [join(root, 'recovery/m2/recover.sh')], {
  env: { ...fakeSystemEnv, PATH: '/usr/bin:/bin' }, encoding: 'utf8',
})
assert.equal(again.status, 0, again.stderr)
assert.deepEqual(snapshotM1Records(), beforeM1Records)
```

Use the suite's existing launchctl/process stubs in `fakeSystemEnv`; the restored M1 command fixture must reject unknown `rollback m2`/`--m2-only`, so a test cannot accidentally succeed through an M2-aware fake. Verify no call to those restored commands occurs. Also fault immediately before/after shared-marker detachment, then resume via the stable command and assert the marker was neither resurrected by signal/finally handlers nor exposed to M1's fallback parser. While M2 is still installed, failure/activation resume chooses this command automatically; after bootstrap restoration, no automatic old-M1 resume is claimed.

Test pruning leaves the prior library and entire recovery namespace intact; repeat-on keeps its first baseline; unrelated settings edits survive; conflicts retain journal/library pin; no M1 cache cleanup, broad fallback, or M0 activation occurs. Test initially unloaded smoke job, loaded router job, terminal repeated stable invocation and a superseded terminal baseline that performs no mutation.

- [ ] Ensure full `off` unwinds Claude layer before router/adapter; router-only off must also unwind the dependent Claude layer before unloading router. If a remaining settings conflict still points at this router, keep the router loaded and report incomplete off rather than strand all Claude calls. Existing sessions cache env; document that they need a fresh Claude session after off. Do not kill operator Claude processes. No ChatGPT restart merely to enable Claude settings; use M1's existing idle/restart contract if the installed library upgrade needs it.

- [ ] Tests: absent/existing settings; unexpected env value; malformed JSON; repeat on; interrupted write; overwrite detection; row collision; agent collision; after-on unrelated edit; after-on owned row edit; persisted owned GPT default; selected Claude default; full off/router-only off; Node unavailable; symlink escape; permission fields remain byte-equivalent. Run build and control suites; commit `feat: install reversible Claude Code picker and agents`.

## Task 7: Posture, diagnostics, drift and nightly Claude Code smoke

**Files:** Create `smoke-claude-code.mts`, `test/claude-posture.test.mts`, `test/smoke-claude-code.test.mts`; modify M1 `smoke.mts`, `smoke-paths.mts`, status/doctor modules, `src/control-status.mts`, `src/control-doctor.mts`, update-gate capture list, docs and env documentation.

**Consumes:** M1 `SmokePathName`, `PathResult`, `SmokeDeps`, `runSmoke`, `judge`, `pruneOwnSessions`, `fromClaudePermissionMode`, canonical `Posture` and docs/schema drift fixtures; M2 models/broker/runtime status.

**Produces:** `runClaudeCodeSmoke(ctx: PathContext): Promise<PathResult>` using the final M1 `PathContext` exported from `smoke-paths.mts` (export that existing context if still private) as the `claude-code-gpt` path; status `{claudeCode:{enabled,settingsInstalled,models,broker,translationVersion,health}}`; doctor checks for routing/settings conflicts without emitting credential values.

- [ ] Add posture tests tied to the real fixture, not inferred CLI enums:

```ts
for (const mode of ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan', 'manual']) {
  const rendered = renderGptAgent(models[0]!)
  assert.equal(/^permissionMode:/m.test(rendered), false)
  assert.equal(/^tools:|^mcpServers:|^hooks:/m.test(rendered), false)
  // The fake real-Claude capture for this mode must show inherited mode.
  assert.equal(captureByMode[mode].childPermissionMode, captureByMode[mode].parentPermissionMode)
}
```

Update the Claude docs fixture's enum coverage if the completed M1 fixture lacks `manual`/`dontAsk`; map `manual` as `default` and verify `dontAsk` stays fail-closed. Retain M0/M1 strict-mode behavior for approximate auto mappings. Do not convert a GPT Messages request into a Codex tool-executing thread: tools remain in the Claude harness, so no model-specific posture override is needed.

- [ ] Add a fake endpoint test that asks for an out-of-scope file read/write in plan/dontAsk. Observe the real isolated Claude harness denies it, the translator performs zero filesystem/subprocess operations, and the user's tool-result denial is passed back as data. Mixed-agent tests give agent A only Read and agent B a different list; their translated tool registries and session keys must remain separate.

- [ ] Register the smoke path in existing M1 scheduling and degrade bookkeeping. It launches the installed Claude binary with the installed router URL and chosen available GPT model, one fixed smoke project, `--no-session-persistence`, `--disable-slash-commands`, a Read-only tool allowance and bounded turn/time budget. Prompt: `Read the file anyengine-smoke-marker.txt using Read once and reply with exactly PONG.` Write that public marker only in the fixed smoke project, preserve/restore a colliding user file through scratch bookkeeping, and prove `tool_use Read` followed by `tool_result` and PONG. Keep 60-second process/turn limits; ensure child cleanup. No separate login, no copied Claude/Codex home. Respect `smoke.enabled`; not enabled means no new job or spend.

- [ ] Add doctor outputs: M2 installed lib and MIT files valid; installed Claude fixture version matches; user settings parse; base URL points to healthy local router; haiku/hint settings active; higher precedence managed/project settings may shadow rows/env; existing API-key/helper credential config means subscription passthrough is not proven; active canonical Codex source available; external Codex processes using different homes are a warning, not auto-killed. Do not read auth values or enumerate secret settings into output. Broker status reports source kind/generation/readiness only.

- [ ] Update gate reruns zero-spend auth and Claude Messages captures before trusting a new binary. A missing/changed auth shape marks GPT-in-Claude degraded; leave transparent Claude and other M1 paths functioning. Nightly failure notifies once through existing local macOS notification plumbing and marks only the failed path. Include port/socket/version and recovery (`codex login`, `anyengine off`) in human-readable diagnostics, no tokens.

- [ ] Run new posture/smoke suites and M1 smoke/doctor/control suites. Commit `feat: monitor and verify the Claude Code GPT path`.

## Task 8: Independent review, live acceptance and one-command rollback proof

**Files:** Create `scripts/acceptance-claude-code.mjs`; `docs/evidence/2026-10-02-m2-claude-code.md` (use execution date if later); final guide updates and plan checklist.

**Consumes:** completed Tasks 1–7, Task 6 `prepareM2Upgrade`/`rollbackM2`, initial `--m2-only` dispatch and surviving absolute recovery command, M1 staged install/preflight/flip/postflight APIs and standing live-change authorization.

**Produces:** installed M2, concrete acceptance evidence, clean main commits and a recoverable rollback layer. No M3 account rotation in this task.

- [ ] Run the full required checks once after changes settle:

```sh
npm run check:fix
npm run typecheck
npm run check
npm test
npm run check:rust-protocol-fixtures
npm run check:posture-schema
npm run docs:build
```

Use M1's existing T7 temp/npm-cache command wrapper where still required. Check final `git diff --check`, inspect diff for personal data/credentials and confirm no auth code was vendored. No tests in ordinary `npm test` may hit a real service.

- [ ] Have a fresh independent native reviewer inspect broker lifecycle/invalidation, secret separation, stream terminals/tool IDs, semantic and node-free rollback, posture inheritance and vendor attribution. Fix concrete findings with targeted failing tests, rerun affected suites, then final full check if the fixes affect integration. Do not manufacture review issues. Record actual review result.

- [ ] Run the live bearer gate entirely inside the test process, against the existing real Codex source on the canonical shared home. Call `getAuthStatus` include-token/refresh=true, check bearer/account/expiry presence in memory, and perform one broker-authenticated GPT tool turn through the installed translator. Evidence records only boolean checks, source PID/version, model and status. Capture neither the RPC result nor outgoing request headers. Verify refresh ownership from code and the real-Codex stale fake-token refresh fixture already proven during planning; a live fresh token does not prove a real-account expired refresh. If a live refresh can be observed naturally during the bounded acceptance window, record that separately; do not edit, expire or copy the real auth chain to manufacture it.

**Gate handling:** if `getAuthStatus` no longer returns a usable token, do not enable GPT rows. The allowed fallback is a real Codex app-server on this same canonical home, with all model execution/auth still owned by Codex; it is not permission to read auth.json or give a proxy its own login. Current fake-binary evidence supports the primary path, so do not implement an unverified alternate HTTP/auth API speculatively. A failed live gate is a concrete feasibility blocker requiring a new captured official-process forwarding contract before M2 can be declared complete. Keep completed local work and M1 operational; report the exact failing contract without token material.

- [ ] On a synthetic M1 home, prove M1→M2→M1 using both `anyengine rollback m2` and generated `anyengine-off --m2-only` with Node unavailable; require prior lib, loaded router/smoke state and M1 records/rollback files unchanged. Run the fault/recovery matrix and pruning-pin test from Task 6. For live activation run M1 preflight, persist `prepareM2Upgrade` and its library pin before staging/pruning, then stage with the non-activating installer. Activate with authorized `anyengine on` through the detached flip journal explicitly carrying `failureTarget:'m2'`; use existing idle checks before app restart. Failing M2 postflight or interrupted activation invokes the surviving absolute recovery script first while the M2-aware dispatcher remains. After M1 bootstrap restoration, resume explicitly with `/bin/bash "$HOME/.anyengine/recovery/m2/recover.sh"`; retain/print that command before activation. Do not invoke an M2 option through the restored M1 commands. Never substitute full/router-only off for the promised M1 recovery. Do not request another generic approval.

- [ ] Execute and record all live acceptance cases with the installed library, current user config, fixed smoke project and bounded turns:

| Acceptance | Evidence required |
|---|---|
| `/model` shows GPT and ordinary Claude rows | actual Claude picker capture, current CLI version; select using `s` for the acceptance session |
| GPT tool turn | real GPT answer PONG after one Read tool call and its marker result; requested alias echoed |
| GPT agent from Claude parent | real Claude parent explicitly uses one generated GPT agent; GPT child result reaches parent; session/agent hints routed correctly |
| Claude subscription passthrough | real Claude PONG with same request body forwarding; plan unified rate-limit headers present and returned unchanged; no gateway credential introduced |
| mixed history | Claude→GPT→Claude text/tool transcript continues; no foreign thinking sent to the wrong backend; GPT resume keeps its own signature |
| broker without app adapter | close only acceptance-owned adapter; router-owned real Codex source serves one tiny GPT turn using the same home; new adapter replaces fallback cleanly |
| no translator login | installed files/process args/code contain no login/token-store path; no CCP config/keychain store created |
| rollback | Node and node-free M2-only scratch round-trips restore M1 lib/jobs/layer records and remove owned Claude changes; prior lib survives pruning; interrupted/failure recovery targets M2-only first. Live initial `anyengine rollback m2` hands off to the stable script; repeat/interrupt recovery uses `/bin/bash "$HOME/.anyengine/recovery/m2/recover.sh"`, verifies previous M1 state, then re-enable once; full/router-only off remain separately tested broad operations |
| M1 regression | installed real-config Claude PTY PONG plus GPT PONG, existing router/native/bridge path status remains healthy |

For the live Claude rate-limit observation, add a test-only in-process assertion/boolean observation of the permitted header names; never add production body/header traffic logging. A usage header demonstrates subscription semantics, not an account billing audit.

- [ ] Clean scratch/fake homes and all acceptance-owned children/sockets; preserve rollback evidence outside scratch. Update docs with current supported versions, conservative GPT context budget, `s` vs persisted model behavior, error recovery and exact off limitation for already running Claude sessions. Commit `docs: record verified M2 Claude Code acceptance` and report completed acceptance or exact blockers. Continue to M3 only after the M2 acceptance gates pass.

## Self-review record

- Spec coverage: §5.2 route/translator → Tasks 3–5; §5.3 broker/live gate → Tasks 1–2, 8; §5.6 inheritance and strict mappings → Tasks 6–7; §5.7 reversible user-wide settings/agents → Task 6; §7 smoke/drift/failure → Tasks 4, 7–8; §8 hermetic/property/fixtures → all tasks; §9 M2 five acceptance bullets → Task 8 table.
- Type/interface review: owner source revision/change signal is distinct from account generation; broker cache revision guards every awaited result/finalizer. Model resolution accepts the requested string only and happens after admission against a named authenticated snapshot producer. Settings consumes a credential-free view. Every newly named public interface is defined above or in its owning task. M1 interfaces are explicitly quoted and must follow the completed M1 implementation.
- Review Focus coverage: all five conditions have an owning task and concrete assertions; no additional unmanaged subprocess or auth store is introduced.
- Implementation decisions reviewed: pure MIT port approved by the owner; no new runtime dependency; full history avoids continuation cache bugs; conservative GPT IDs avoid changing Claude context globally; exact Claude passthrough interpretation explicit.
- Scoped independent-review corrections: finding 1 → Task 6/8 explicit M2-only baseline and node-free target, failure/interruption first target, retention pin and round-trip tests; finding 2 → Task 2 real-child registration/change signal and same-generation A→B late-result/coalescing regression; finding 3 → Task 1 pure mapping, Task 4 authenticated generation/source-bound snapshots and admitted resolution, Task 5 runtime/settings view, Task 6 metadata-only consumer. No additional task, auth implementation or approval gate.
- Round-2 recovery entrypoint correction: Task 6/8 retain a stable absolute node-free dispatcher, versioned script, pointer and private journal outside restored/pruned targets; shared M2 FlipMarker is detached before restoring old bootstrap. Automatic recovery is limited to an M2-aware dispatcher; later recovery/repeat directly invokes the surviving command. Fault tests kill after library/bootstrap restore, layer restore and job reload with genuinely unmodified M1 entrypoint fixtures.
- Outstanding feasibility evidence: successful fake real-Codex token-return shape is observed. Real-Codex stale-token refresh through a fake endpoint is observed too. Real bearer usability and installed current-Claude picker/tool/subagent behavior remain live gates, not claimed successes.
