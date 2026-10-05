# AnyEngine M3 accounts and limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The operator has authorized M1 → M2 → M3, necessary decisions, verification, and commits on main. Start implementation only after M2's acceptance gate passes. No additional plan approval is required. Use one owner and a fresh independent reviewer before live installation.

**Goal:** Keep one OpenAI account active across every AnyEngine-managed surface, safely continue threads after a sequential account change, and report faithful account limits without copying credentials or spending usage on probes.

**Architecture:** A shared SQLite admission ledger covers managed turns, translator streams, official child lifetimes, and parked-account reads. A durable move journal freezes admission, drains work, stops every relevant official child, moves the sole credential files, increments the account generation, and restarts clients. The existing mux retains desktop thread IDs and the home identity; limit observations are captured before reserve masking and never confused with authorization recovery.

**Tech Stack:** Node.js >=24; erasable TypeScript ESM; existing `node:sqlite`, `node:fs`, `node:net`, `node:child_process`; existing test helpers, Biome and quality ratchets. No new runtime dependency or second daemon. The router hosts control IPC; the SQLite ledger remains the cross-process authority if the router dies.

**Spec:** `docs/specs/2026-09-29-anyengine-v1-design.md`, §§3, 5.3–5.5, 5.7, 7–9. Consumes completed M1 control interfaces and completed M2 broker interfaces. This plan was researched against partial M1 `503a7e1`; before implementation read the final versions of the named integration files and preserve their actual public signatures.

## Global Constraints

- “Exactly one process family refreshes each account's token chain. Credentials are moved, never copied.” Official Codex processes sharing one canonical auth file are the account's refresh family; AnyEngine never refreshes or parses that file.
- “Account rotation must be sequential, with no proxy pooling.” One active managed account globally, including desktop, web, remote CLI and translator, even if several turns share that account.
- “Everything in `~/.codex` except `auth.json` is symlinked in, so sessions, state, config, skills and plugins are shared.”
- “When the active account is the user's own `~/.codex` login, `auth.json` is a symlink to `~/.codex/auth.json`.” Never move the canonical home credential.
- “When another account is active, its `auth.json` is moved in, and moved back out on rotation.” Do not use `copyFile`, hard links, reflinks, `cp`, archives, credential JSON reads or credential hashes.
- “Every live change is reversible with one command.” Back up configuration and metadata, and retain a move-only credential rollback record.
- “Mid-turn replay (option, default off).” Never silently replay a failed request or a translator tool call.
- “Parked accounts use a short-lived app-server on that account's home, rate-limited to one read per 10 minutes.” `--refresh` does not bypass this floor.
- “The active account's reading is passive, taken from `account/rateLimits/updated`.” Existing reserve reads may feed the cache; limits adds no active-account polling loop.
- “The Claude row comes from the `rate_limit_event` data the PTY engine already sees.” Missing percentages/credits remain unknown; no Claude OAuth reads and no new usage endpoint fetcher.
- “Never scripted: the interactive codex TUI.” Account creation uses official `login --device-auth`; probes use official `app-server` only.
- “Hermetic suite: no reliance on the user's `~/.codex` or `~/.claude`.” Every fake process uses the existing tracked-child helper and every temporary directory uses `tempDir()` and `removeTempDirs`.
- SQLite alone manages descriptors for coordination databases: an ordinary read/copy/hash descriptor closed in the owning process can release its POSIX locks. Keep database inodes and sidecars stable while owners or waiters may exist; backup, overlay, layer, doctor and recovery paths use stat or SQLite-aware access and never replace, truncate, restore or remove live coordination storage. Node-free recovery preserves it without requiring a sqlite3 binary. Metadata-only backup exports logical metadata through SQLite; it does not copy a live database file.
- `.mts` source, `.mjs` imports; no enum/namespace/parameter properties. New modules ≤500 lines. Split cohesive helpers rather than raising size/complexity/coverage ratchets. Never hand-edit generated output.
- No personal paths/names/account identifiers, tokens, emails or real conversation text in committed fixtures/evidence. Runtime private metadata may contain user-provided labels and vendor identity; report them only through explicit local account commands.
- Do not add credit consumption, cross-vendor automatic failover, Anthropic rotation, token impersonation or usage-spending “health” prompts in M3.

## Review Focus

1. App and translator overlap while a third surface registers during a switch: admission closes atomically before draining; no late old-generation work. Tasks 3, 7 and 11.
2. Process is killed between a rename and its journal update, or parent dies while its native child survives: startup stays frozen until the inode inventory and process groups prove recovery. Tasks 3, 4 and 11.
3. A sparse 0% update or elapsed reset arrives after an authoritative denial: display fresh fields without clearing exhaustion; only a later authoritative allowed read clears it. Tasks 5 and 6.
4. Symlinked config/cache replaced by atomic rename, or SQLite creates a sidecar in the overlay: installed-binary fixture must prove shared data and preserve conflicting user edits. Task 2.
5. An error after a real tool effect resembles encrypted-content failure: preserve the original failure and require a new user turn; no automatic repeated side effects. Task 9.

---

## Decisions and file boundaries

Eleven independently testable deliverables, with focused checks and a commit for each. One whole-change independent review precedes the live change. A failed acceptance gate stops promotion; it does not justify skipping evidence.

| Files | Responsibility |
|---|---|
| `src/accounts-types.mts`, `accounts-store.mts`, `accounts-metadata.mts` | Strict metadata registry, paths, public types and official login registration |
| `src/accounts-overlay.mts`, `accounts-overlay-reconcile.mts` | Shared non-auth symlinks and collision-safe reconciliation |
| `src/accounts-ledger.mts`, `accounts-processes.mts`, `accounts-control.mts` | Admission ledger, process-family liveness, private control channel |
| `src/accounts-files.mts`, `accounts-journal.mts` | Durable JSON/rename primitives and recoverable credential move transaction |
| `src/limits-openai.mts`, `limits-claude.mts`, `limits-store.mts`, `limits-format.mts` | Vendor observations, sparse merge, durable scheduling and display |
| `src/accounts-probe.mts` | Bounded official parked-account identity/limits reads |
| `src/accounts-policy.mts`, `accounts-rotation.mts` | Pure target choice and global drain/switch transaction |
| `src/accounts-adapter.mts`, `accounts-identity.mts` | Managed child integration, home identity pin and raw limits observation |
| `src/accounts-continuity.mts` | Lazy resume, plaintext rehome, bounded opt-in continue prompt |
| `src/control-accounts.mts`, `control-limits.mts`, `accounts-rollback.mts` | CLI, doctor/status/off, credential-free backup proof |
| `scripts/capture-accounts-contract.mjs`, `scripts/prove-accounts-rollback.mjs`, `scripts/acceptance-accounts.mjs` | Zero-spend contract capture, fake rollback proof and live acceptance |
| `test/accounts-*.test.mts`, `test/limits-*.test.mts` | Focused hermetic and multi-process tests |

The registry is metadata-only `accounts.json`; `limits.json` is a private metadata cache. `accounts-state.sqlite` is the single cross-process mutation authority: its revisioned JSON document rows hold registry/limits state, with these two files maintained as durable readable projections. Runtime readers use the document rows, never a possibly stale projection. The same database coordinates generation, work, process holders, observation authorities and probe reservations. SQLite uses `busy_timeout=5000`, WAL and `synchronous=FULL`. Do not put credentials in any of these files. An unfinished journal always overrides the registry's apparent active account and keeps admission closed.

Private IPC carries account IDs, generations, counts, pause/restart acknowledgements and sanitized errors, never bearer values. M2's private source socket remains the only bearer RPC. Do not add bearer fields to account-control RPCs.

M2's agreed seam:

```ts
export interface ActiveAccount { home: string; generation: number }
export interface AdmissionLease { generation: number; release(): Promise<void> }
export interface AccountAdmission {
  begin(signal?: AbortSignal): Promise<AdmissionLease>
}
// M2 TokenBroker.invalidate(generation: number): void is synchronous.
// M2 BrokerOwner.stopSources(): Promise<void> awaits owned child-family exit.
// M2's translator holds AccountAdmission from before get() through final stream
// close/abort, including any 401 retry. M3 supplies the real admission object.
// M2 BrokerLease also carries cacheRevision; invalidate increments it even when
// generation is unchanged. TokenBroker.isCurrent checks every revision axis.
// Source id/sourceRevision are independent of account generation: a same-account
// child restart invalidates pending RPCs, bearer cache and catalog snapshots.
// Resolve the requested model and lane only after admission, using the catalog
// snapshot matching that lease's generation and the selected source revision.
```

## Task 1: Pin current contracts and build a strict metadata registry

**Files:** Create `scripts/capture-accounts-contract.mjs`, `test/fixtures/accounts-contract-<version>.json`, `src/accounts-types.mts`, `src/accounts-store.mts`, `src/accounts-metadata.mts`, `test/accounts-store.test.mts`; modify environment documentation only for newly introduced variables.

**Consumes:** completed M1 `scripts/lib/codex-probe.mjs` and `fake-chatgpt-auth.mjs`, bundled binary resolver; M2's fake `getAuthStatus` fixture. Read `src/AGENTS.md`, `scripts/AGENTS.md`, `test/AGENTS.md`.

**Produces:** `AccountPaths`, `AccountRegistry`, `loadAccounts`, `initializeAccounts`, `AccountMetadata`, `accountPaths`, `accountHome`, `validateAccounts`; generated schema-derived fixture. Define these types exactly:

```ts
export interface Account {
  id: string
  label: string
  kind: 'home' | 'managed'
  vendorAccountId: string | null
  email: string | null
  planType: string | null
  login: 'ready' | 'needs-login'
}
export interface AccountRegistry {
  version: 1
  active: string
  home: string
  generation: number
  rotation: { enabled: boolean; threshold: number; cooldownMs: number }
  replay: 'none' | 'continue-prompt'
  accounts: Account[]
}
export interface AccountPaths {
  root: string
  canonical: string
  overlay: string
  registry: string
  ledger: string
  journal: string
  limits: string
}
export interface ProcessIdentity { pid: number; pgid: number; start: string }
export interface Participant {
  id: string
  kind: 'adapter' | 'broker' | 'probe' | 'maintenance' | 'login'
  process: ProcessIdentity
  socket: string
  generation: number
}
export interface Family {
  id: string
  participant: string
  account: string
  generation: number
  process: ProcessIdentity
}
export interface WorkLease {
  id: string
  generation: number
  release(): Promise<void>
}
export type SwitchReason = 'manual' | 'usage-limit' | 'threshold' | 'off'
```

- [ ] **Step 1: Write and run the failing registry tests.** Import `tempDir`, `removeTempDirs`, Node assert/test/after and the new functions. Include these exact cases:

```ts
test('registry rejects credentials, unsafe IDs and duplicate identities', () => {
  const registry: AccountRegistry = {
    version: 1, home: 'home', active: 'home', generation: 0,
    rotation: { enabled: false, threshold: 100, cooldownMs: 300000 },
    replay: 'none', accounts: [
      { id: 'home', label: 'Home', kind: 'home', vendorAccountId: null,
        email: null, planType: null, login: 'ready' },
    ],
  }
  assert.deepEqual(validateAccounts(registry), registry)
  assert.throws(() => validateAccounts({ ...registry, access_token: 'fake' }))
  assert.throws(() => validateAccounts({ ...registry, active: '../escape' }))
  assert.throws(() => validateAccounts({ ...registry, generation: -1 }))
  assert.throws(() => validateAccounts({ ...registry, accounts: [
    { ...registry.accounts[0], id: 'home', vendorAccountId: 'same' },
    { ...registry.accounts[0], id: 'b', kind: 'managed', vendorAccountId: 'same' },
  ] }))
})
```

Run `npm run build && node scripts/test-hermetic.mjs dist/test/accounts-store.test.mjs`; expected missing module/function failure.

- [ ] **Step 2: Capture the installed contract, isolated and without model calls.** Implement capture by invoking `codex app-server generate-json-schema --out <isolated>/schema` using the existing sandbox helpers. Record the binary version and SHA-256 of schemas, and only the selected definitions listed below. Do not record auth files or `getAuthStatus` values. Assert fixture structure in the test.

Verified on installed **0.159.0-alpha.12.1**, with a blank isolated home:

```ts
// Map these from the generated JSON schema, not a hand-rolled backend API.
export interface WindowReading {
  usedPercent: number
  windowDurationMins?: number | null
  resetsAt?: number | null // Unix seconds
}
export interface CreditsReading {
  hasCredits: boolean
  unlimited: boolean
  balance?: string | null // preserve exact decimal string
}
export interface BucketReading {
  limitId?: string | null
  limitName?: string | null
  normalModelSlug?: string | null
  primary?: WindowReading | null
  secondary?: WindowReading | null
  credits?: CreditsReading | null
  individualLimit?: {
    limit: string; used: string; remainingPercent: number; resetsAt: number
  } | null
  spendControlReached?: boolean | null
  planType?: string | null
  rateLimitReachedType?: string | null
}
export interface OpenAIRead {
  rateLimits: BucketReading
  rateLimitsByLimitId?: Record<string, BucketReading> | null
  ordinaryUsageAllowed?: boolean | null
  accountId?: string | null
  rateLimitResetCredits?: { availableCount: number; credits?: unknown[] | null } | null
}
```

`AccountRateLimitsUpdatedNotification` contains `{rateLimits: BucketReading}` and is sparse. Null account metadata is unavailable, not recovery. The installed schema explicitly says `ordinaryUsageAllowed: null` must not be inferred from percentages or reset times. `usageLimitExceeded` and `rateLimitExceeded` are distinct `CodexErrorInfo` values. `invalid_encrypted_content` is not an enum: match the backend code in structured error details first, then its exact token in sanitized error text; never treat all `badRequest` as this error. `account/read` has email/plan but no account ID. The ID comes from the limits read. Legacy `getAuthStatus` is absent from the generated v2 schema; consume M2's proven fake-RPC fixture rather than inventing a shape.

- [ ] **Step 3: Implement strict registry validation and safe paths.** Core:

```ts
import { join, resolve } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { durableJson } from './accounts-files.mjs'
import type { AccountPaths, AccountRegistry } from './accounts-types.mjs'
const ID = /^[a-z][a-z0-9-]{0,47}$/
function keys(value: object, allowed: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error('Unknown metadata key')
}
export function validateAccounts(value: unknown): AccountRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid registry')
  const r = value as AccountRegistry
  keys(r, ['version', 'active', 'home', 'generation', 'rotation', 'replay', 'accounts'])
  if (r.version !== 1 || !Number.isSafeInteger(r.generation) || r.generation < 0)
    throw new Error('Unsupported registry')
  if (!Array.isArray(r.accounts) || r.accounts.length === 0 || r.accounts.length > 32)
    throw new Error('Invalid accounts')
  const ids = new Set<string>()
  const vendorIds = new Set<string>()
  for (const a of r.accounts) {
    if (!a || typeof a !== 'object') throw new Error('Invalid account')
    keys(a, ['id', 'label', 'kind', 'vendorAccountId', 'email', 'planType', 'login'])
    if (!ID.test(a.id) || ids.has(a.id) || typeof a.label !== 'string' || a.label.length > 120)
      throw new Error('Invalid account label or id')
    if (!['home', 'managed'].includes(a.kind) || !['ready', 'needs-login'].includes(a.login))
      throw new Error('Invalid account state')
    for (const field of ['vendorAccountId', 'email', 'planType'] as const)
      if (a[field] !== null && (typeof a[field] !== 'string' || a[field].length > 320))
        throw new Error('Invalid identity metadata')
    if (a.vendorAccountId && vendorIds.has(a.vendorAccountId)) throw new Error('Duplicate vendor account')
    if (a.vendorAccountId) vendorIds.add(a.vendorAccountId)
    ids.add(a.id)
  }
  if (!ids.has(r.home) || !ids.has(r.active) || r.accounts.filter(a => a.kind === 'home').length !== 1 ||
      r.accounts.find(a => a.id === r.home)?.kind !== 'home') throw new Error('Invalid active or home account')
  if (!r.rotation || typeof r.rotation !== 'object') throw new Error('Invalid rotation')
  keys(r.rotation, ['enabled', 'threshold', 'cooldownMs'])
  if (typeof r.rotation.enabled !== 'boolean' || !Number.isFinite(r.rotation.threshold) ||
      r.rotation.threshold < 1 || r.rotation.threshold > 100 ||
      !Number.isSafeInteger(r.rotation.cooldownMs) || r.rotation.cooldownMs < 0 ||
      !['none', 'continue-prompt'].includes(r.replay)) throw new Error('Invalid rotation policy')
  return r
}
export function accountPaths(root: string, canonical: string): AccountPaths {
  root = resolve(root)
  return { root, canonical: resolve(canonical), overlay: join(root, 'codex-home'),
    registry: join(root, 'accounts.json'), ledger: join(root, 'accounts-state.sqlite'),
    journal: join(root, 'account-switch.json'), limits: join(root, 'limits.json') }
}
export function accountHome(p: AccountPaths, id: string): string {
  if (!ID.test(id)) throw new Error('Invalid account id')
  return join(p.root, 'accounts', 'openai', id)
}
export function loadAccounts(p: AccountPaths): AccountRegistry {
  const metadata = new AccountMetadata(p)
  try { return validateAccounts(metadata.read<AccountRegistry>('registry').value) }
  finally { metadata.close() }
}
export function initializeAccounts(p: AccountPaths, r: AccountRegistry): void {
  mkdirSync(p.root, { recursive: true, mode: 0o700 })
  const metadata = new AccountMetadata(p)
  try { metadata.initialize('registry', validateAccounts(r)); metadata.initialize('limits', {}); metadata.project() }
  finally { metadata.close() }
}
```

**Cross-process metadata contract, implemented in this task.** No caller performs `load → mutate → save` on either JSON projection. `AccountMetadata` opens the same ledger file, uses short `BEGIN IMMEDIATE` transactions, and applies a mutation against the latest document row. Both observed limits and registry identity updates from a completed probe are one transaction. No network/child wait occurs inside a SQLite transaction. A router-down CLI uses this same local API and ownership checks; it does not require a running router or bypass serialization.

```ts
export interface MetadataDocument<T> { revision: number; value: T }
export type MutationKind = 'settings' | 'observation' | 'switch'
// In accounts-metadata.mts. db is DatabaseSync opened on p.ledger.
// Initialize before runtime starts; existing rows are never overwritten.
const METADATA_SQL = `CREATE TABLE IF NOT EXISTS metadata (
  name TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS projection (name TEXT PRIMARY KEY, revision INTEGER NOT NULL);`
function readDocument<T>(db: DatabaseSync, name: string): MetadataDocument<T> {
  const row = db.prepare('SELECT revision,body FROM metadata WHERE name=?').get(name)
  if (!row) throw new Error('Metadata not initialized')
  return { revision: Number(row.revision), value: JSON.parse(String(row.body)) as T }
}
function replaceDocument<T>(db: DatabaseSync, name: string, previous: MetadataDocument<T>, value: T): void {
  const changed = db.prepare('UPDATE metadata SET revision=revision+1,body=? WHERE name=? AND revision=?')
    .run(JSON.stringify(value), name, previous.revision)
  if (Number(changed.changes) !== 1) throw new Error('Metadata revision conflict')
}
// AccountMetadata.edit runs this body inside BEGIN IMMEDIATE/COMMIT:
export function editRegistryLocked(db: DatabaseSync, edit: (current: AccountRegistry) => AccountRegistry): AccountRegistry {
  const previous = readDocument<AccountRegistry>(db, 'registry')
  const next = validateAccounts(edit(structuredClone(previous.value)))
  if (next.active !== previous.value.active || next.generation !== previous.value.generation)
    throw new Error('Active account changes require sealed switch publication')
  replaceDocument(db, 'registry', previous, next)
  return next
}
```

`AccountMetadata` exact public API: constructor `(p:AccountPaths)`; `initialize<T>(name:'registry'|'limits',value:T):void` (`INSERT OR IGNORE`, validates existing row); `read<T>(name):MetadataDocument<T>`; `editRegistry(edit:(current:AccountRegistry)=>AccountRegistry):AccountRegistry`; `acceptObservation(envelope:ObservationEnvelope):boolean`; `project():void`; `close():void`. Task 5 adds `acceptObservation` and its typed reducer; Task 1 implements the remaining methods. Task 3 supplies the shared gate check used by editRegistry: settings/identity changes are permitted while open, draining, or stopped; denied with busy during sealed/journal/rollback/cleanup phases. Only the switch owner may publish active/generation, through Task 4's combined ledger+metadata transaction. Raw observation bodies pass allowlist validation before storage.

`project()` holds its own short `BEGIN IMMEDIATE`, reads the **latest** registry and limits documents, calls `durableJson` on `accounts.json`/`limits.json`, updates projection revisions, then commits. A killed projection writer can leave one readable JSON file old; normal startup/control completion retries projection from the committed DB and never imports it back over a newer DB row. Explicit dry-run opens the existing database read-only, reads authoritative rows without initialization/projection/repair, and only reports stale projections; no absent database is created by dry-run. Projection corruption or unsupported manual edits are reported with both revisions and preserved for diagnosis. Initial import of an existing registry is allowed exactly once before its document row exists, under the same transaction. A killed writer before SQL commit publishes no new state; after commit its state survives even if projection never ran.

Add two independent-process barrier tests in this task: concurrent label/rotation edits must both survive reopen; a writer killed after SQL commit but before projection is visible to a fresh `loadAccounts`, which repairs the projection. Task 5 adds observation merge races. Validate permissions and symlink safety on the ledger and projections before open/write. Do not copy the live SQLite ledger into backup: use transactionally read metadata snapshots.

Move `durableJson` implementation from Task 4 into `accounts-files.mts` now, so this commit builds independently. Reject symlinked registry/root directories outside the declared private root using `lstatSync` before writing; runtime roots are resolved once and never user-selected through account IDs. Accept an absent home auth file as `needs-login`; do not create fake credentials. Only the official login command can populate a managed slot.

- [ ] **Step 4: Run focused tests plus typecheck; commit.** `git add src/accounts-types.mts src/accounts-store.mts src/accounts-files.mts scripts/capture-accounts-contract.mjs test/accounts-store.test.mts test/fixtures/accounts-contract-* && git commit -m "feat: add metadata-only account registry and protocol contract"`.

## Task 2: Share the canonical home without duplicating credentials or state

**Files:** Create `src/accounts-overlay.mts`, `src/accounts-overlay-reconcile.mts`, `test/accounts-overlay.test.mts`; extend the contract capture script with an isolated home/config/state probe.

**Consumes:** Task 1 paths; Task 4 durable rename primitives moved forward as needed. **Produces:** `prepareOverlay(p): OverlayManifest`, `reconcileOverlay(p, manifest): OverlayManifest`, `verifyOverlay(p): string[]`.

```ts
export interface FileStamp { dev: number; ino: number; size: number; mtimeMs: number }
export interface OverlayManifest { targets: Record<string, FileStamp | null> }
```

- [ ] **Step 1: Write the failing symlink and conflict tests.** Use `tempDir()` to create `root` and `canonical`, then `accountPaths(root, canonical)`; create canonical `sessions`, `skills`, `plugins`, `config.toml`, `state_5.sqlite`, `models_cache.json` and dummy `auth.json` with fake marker text. The test can read fake markers; production code must not read credentials.

```ts
test('overlay shares non-auth entries and pins home auth', () => {
  const base = tempDir('accounts-overlay-')
  const p = accountPaths(join(base, 'engine'), join(base, 'codex'))
  mkdirSync(p.canonical, { recursive: true })
  mkdirSync(join(p.canonical, 'sessions'))
  writeFileSync(join(p.canonical, 'config.toml'), 'model = "gpt-test"\n')
  writeFileSync(join(p.canonical, 'auth.json'), 'FAKE_HOME', { mode: 0o600 })
  prepareOverlay(p)
  assert.equal(realpathSync(join(p.overlay, 'sessions')), join(p.canonical, 'sessions'))
  assert.equal(readlinkSync(join(p.overlay, 'auth.json')), join(p.canonical, 'auth.json'))
  assert.equal(statSync(join(p.overlay, 'config.toml')).ino, statSync(join(p.canonical, 'config.toml')).ino)
  assert.deepEqual(verifyOverlay(p), [])
})
test('atomic replacement preserves edits and rejects two writers', () => {
  const base = tempDir('accounts-overlay-conflict-')
  const p = accountPaths(join(base, 'engine'), join(base, 'codex'))
  mkdirSync(p.canonical, { recursive: true })
  writeFileSync(join(p.canonical, 'config.toml'), 'old\n')
  const m = prepareOverlay(p)
  unlinkSync(join(p.overlay, 'config.toml'))
  writeFileSync(join(p.overlay, 'config.toml'), 'overlay edit\n')
  writeFileSync(join(p.canonical, 'config.toml'), 'outside edit\n')
  assert.throws(() => reconcileOverlay(p, m), /conflict/)
  assert.equal(readFileSync(join(p.canonical, 'config.toml'), 'utf8'), 'outside edit\n')
  assert.equal(readFileSync(join(p.overlay, 'config.toml'), 'utf8'), 'overlay edit\n')
})
```

- [ ] **Step 2: Implement symlink creation and quiet-boundary reconciliation.** Core `prepareOverlay`:

```ts
import { lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountPaths } from './accounts-types.mjs'
export function fileStamp(path: string): FileStamp | null {
  try { const s = statSync(path); return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs } }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export function prepareOverlay(p: AccountPaths): OverlayManifest {
  mkdirSync(p.overlay, { recursive: true, mode: 0o700 })
  const targets: OverlayManifest['targets'] = {}
  for (const name of readdirSync(p.canonical)) {
    if (name === 'auth.json') continue
    const source = join(p.canonical, name)
    const dest = join(p.overlay, name)
    targets[name] = fileStamp(source)
    try {
      const st = lstatSync(dest)
      if (!st.isSymbolicLink() || readlinkSync(dest) !== source) throw new Error(`Overlay conflict: ${name}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      symlinkSync(source, dest)
    }
  }
  const auth = join(p.overlay, 'auth.json')
  try { lstatSync(auth) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    symlinkSync(join(p.canonical, 'auth.json'), auth)
  }
  return { targets }
}
```

**Planning proof, 2026-10-02:** installed 0.159.0-alpha.12.1 passed a loopback-only fake-auth probe. Two official refresh calls updated the canonical fake chain through the overlay auth symlink; the symlink and canonical inode remained unchanged. `config/value/write` preserved the config symlink and changed canonical config. Models-cache symlink remained intact. With main databases already canonical, SQLite created WAL/SHM beside those canonical files, including a repeat with every overlay sidecar link absent. No model endpoint was called.

**Required bootstrap:** the first run on a blank canonical fixture created new databases in the overlay because those canonical targets did not yet exist. Before first overlay activation and after every Codex version change, perform one official **zero-turn canonical-home warmup**, under the canonical account's credential-family lease: initialize and thread/start with `ephemeral:false`, then shutdown without turn/start; remove only the attributable empty warmup thread through the supported archive/delete path and preserve state databases. Stop the warmup family, then build the complete overlay link inventory. Initialize the overlay with admission closed; inspect for unexpected regular state/database files. If any were newly introduced, stop all overlay families, move each unique non-auth file to an absent canonical destination, symlink it, then reinitialize once. Collision or repeated unshared state fails closed. Existing canonical data is never overwritten by bootstrap. SQLite sidecars need not be fabricated: the verified SQLite path resolves their main file canonically. Repeat the zero-spend installed-binary fixture after upgrades; unsupported behavior prevents activation. This retains the approved auth symlink and needs no home-path exception.

Only initialize the home auth symlink while the registry says home and no journal exists. A managed-active regular overlay auth is valid and must be left alone. Reject unexpected symlinks for every managed auth slot. Reconciliation never enumerates or reads credentials beyond lstat/readlink. For each non-auth overlay entry that has become a regular file: compare the canonical stamp with the saved manifest; if unchanged, rename the overlay file onto the canonical path, fsync both directories and replace it with a canonical symlink; if changed, retain both, freeze managed starts and report the conflict. New overlay entries are moved to absent canonical paths, then symlinked. New canonical entries are symlinked before every official child start. Do not unlink live SQLite WAL/SHM files or merge databases.

The installed-Codex fixture must run two isolated official app-servers with fake credentials and loopback backend, create/resume a thread without model generation, perform `config/value/write`, and inspect **paths/stat only** for generated state files. Assert the second server sees the first server's state and canonical config. Assert canonical SQLite main file and sidecars are shared, and inspect `state_*.sqlite` with read-only SQLite only after both fake children exit. A process still using a detached state file is a hard failure, not an acceptable eventual reconciliation. Keep the real CLI transcript redacted.

If atomic config/cache writes detach symlinks, put canonical-path reconciliation under the shared account control lane around the specific writing RPCs, before returning their response or allowing another managed config read. If SQLite itself resolves a different sidecar path, stop here and add a documented canonical database-path override **only if the installed CLI schema/config supports it**; otherwise this is an M3 feasibility failure and no live overlay installation occurs. Never claim a directory symlink fixes a top-level database without the fixture.

- [ ] **Step 3: Run focused overlay tests and the zero-spend contract capture; commit.** `git add src/accounts-overlay.mts src/accounts-overlay-reconcile.mts test/accounts-overlay.test.mts scripts/capture-accounts-contract.mjs test/fixtures/accounts-contract-* && git commit -m "feat: share canonical Codex state through an account overlay"`.

## Task 3: Add durable transition ownership, admission and credential leases

**Files:** Create `src/accounts-ledger.mts`, `accounts-transition.mts`, `accounts-processes.mts`, `accounts-control.mts`; extend Task 1 metadata transaction helpers; tests `test/accounts-ledger.test.mts`, `test/fixtures/accounts-worker.mjs`.

**Consumes:** revisioned metadata authority, registry, process-system seam. **Produces:** interfaces below plus `identifyProcess(pid):ProcessIdentity|null`, `familyAlive(identity):'alive'|'dead'|'unknown'`, `stopFamily(identity):Promise<void>`, and one `recoverAccounts(p,newOwner):Promise<void>` entrypoint (Task 4 completes its file operations).

A parked metadata probe runs alongside another account's model traffic, with an exclusive lease on its own credential. Model admission and credential-file admission are distinct. Login, probe and bootstrap may not share one account's credential with each other or with a managed model family. Multiple official model children on the same active account share its one canonical file/refresh family; no second copy or refresher implementation exists.

```ts
export interface OwnerToken { transaction: string; claim: number; process: ProcessIdentity }
export type GatePhase = 'open' | 'draining' | 'stopped' | 'sealed' | 'journal' |
  'rolling-back' | 'cleanup-commit' | 'cleanup-rollback' | 'bootstrap'
export interface CredentialStamp {
  account: string; path: string; kind: 'file' | 'home-link' | 'absent'
  dev: number | null; ino: number | null; nlink: number | null; target: string | null
}
export interface TransitionIntent {
  from: string; to: string; generation: number; reason: SwitchReason | 'bootstrap'
  registryRevision: number | null
  inventory: CredentialStamp[] | null
  finalInventory: CredentialStamp[] | null
  journalPath: string | null
}
export interface GateState {
  active: string; generation: number; phase: GatePhase
  owner: OwnerToken | null; intent: TransitionIntent | null
}
export type FamilyPurpose = 'model' | 'probe' | 'login' | 'bootstrap'
export interface FamilyIntent {
  id: string; participant: string; account: string; purpose: FamilyPurpose
  generation: number; owner: OwnerToken | null; supervisor: ProcessIdentity
}
export interface ControlRequest {
  method: 'pause' | 'stop' | 'restart' | 'invalidate' | 'status'
  owner: OwnerToken; generation: number
}
export function callParticipant(socket: string, request: ControlRequest): Promise<void>
export interface AccountLedgerApi {
  state(): GateState
  freeze(owner: OwnerToken, to: string, reason: SwitchReason): GateState
  beginBootstrap(owner: OwnerToken): GateState
  adopt(replacement: OwnerToken, expected: OwnerToken): void
  register(p: Participant, owner?: OwnerToken): void
  begin(participant: string, generation: number): WorkLease
  reserveFamily(intent: FamilyIntent): void
  attachNativeFamily(id: string, process: ProcessIdentity): void
  releaseFamily(id: string): void
  holders(account?: string): Family[]
  workCount(): number
  phase(owner: OwnerToken, expected: GatePhase, next: GatePhase): void
  open(owner: OwnerToken, verifiedInventory: CredentialStamp[]): void
  reserveProbe(account: string, now: number): boolean
  probeAttempt(account: string): number
  close(): void
}
```

- [ ] **Step 1: Write owner-death and closed-admission failures.** Use independent workers, IPC barriers and tracked child cleanup. New helper `owner(transaction,pid,start,claim=1)` returns the full token, using `pgid:pid` in fake process-table tests.

```ts
test('freeze persists its owner and pre-journal intent atomically', async () => {
  const fx = await accountFixture()
  const first = owner('switch-1', 101, 'started-101')
  fx.ledger.freeze(first, 'b', 'manual')
  fx.reopen()
  assert.deepEqual(fx.ledger.state().owner, first)
  assert.equal(fx.ledger.state().phase, 'draining')
  assert.equal(fx.ledger.state().intent?.to, 'b')
  assert.throws(() => fx.ledger.begin('app', 0), /frozen/)
  fx.processes.set(101, 'alive')
  await assert.rejects(fx.recover(owner('switch-1', 102, 'started-102', 2)), /live owner/)
  fx.processes.set(101, 'unknown')
  await assert.rejects(fx.recover(owner('switch-1', 102, 'started-102', 2)), /unknown owner/)
  fx.processes.set(101, 'dead')
  await fx.recover(owner('switch-1', 102, 'started-102', 2))
  assert.equal(fx.ledger.state().phase, 'open')
  assert.equal(fx.registry().active, 'home')
})
```

- [ ] **Step 2: Implement the durable gate and fenced owner.** SQL (all changing methods use a short `BEGIN IMMEDIATE`; no async callback inside):

```sql
CREATE TABLE IF NOT EXISTS gate (
 id INTEGER PRIMARY KEY CHECK(id=1), active TEXT NOT NULL,
 generation INTEGER NOT NULL, phase TEXT NOT NULL,
 owner TEXT, intent TEXT
);
CREATE TABLE IF NOT EXISTS participant (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work (id TEXT PRIMARY KEY, participant TEXT NOT NULL, generation INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS family (
 id TEXT PRIMARY KEY, account TEXT NOT NULL, purpose TEXT NOT NULL,
 participant TEXT NOT NULL, body TEXT NOT NULL, native TEXT
);
CREATE TABLE IF NOT EXISTS probe (account TEXT PRIMARY KEY, attempted INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS observation_authority (
 id TEXT PRIMARY KEY, account TEXT NOT NULL, epoch INTEGER NOT NULL,
 source_id TEXT NOT NULL, source_revision INTEGER NOT NULL, family_id TEXT NOT NULL,
 purpose TEXT NOT NULL, valid INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_sequence (account TEXT PRIMARY KEY, next INTEGER NOT NULL);
```

```ts
function sameOwner(a: OwnerToken | null, b: OwnerToken): boolean {
  return a !== null && a.transaction === b.transaction && a.claim === b.claim &&
    a.process.pid === b.process.pid && a.process.pgid === b.process.pgid && a.process.start === b.process.start
}
function requireOwner(state: GateState, owner: OwnerToken): void {
  if (!sameOwner(state.owner, owner)) throw new Error('Stale transition owner')
}
// Method bodies run through tx() from the prior SQLite convention.
function freezeLocked(db: DatabaseSync, owner: OwnerToken, to: string, reason: SwitchReason): GateState {
  const gate = readGate(db)
  if (gate.phase !== 'open') throw new Error('Account switch owned')
  const registry = readDocument<AccountRegistry>(db, 'registry').value
  if (registry.active !== gate.active || registry.generation !== gate.generation)
    throw new Error('Registry and ledger disagree')
  if (!registry.accounts.some(a => a.id === to && a.login === 'ready')) throw new Error('Target needs login')
  const intent: TransitionIntent = { from: gate.active, to, generation: gate.generation, reason,
    registryRevision: null, inventory: null, finalInventory: null, journalPath: null }
  db.prepare('UPDATE gate SET phase=?,owner=?,intent=? WHERE id=1')
    .run('draining', JSON.stringify(owner), JSON.stringify(intent))
  return { ...gate, phase: 'draining', owner, intent }
}
function admitFamilyLocked(db: DatabaseSync, f: FamilyIntent): void {
  const gate = readGate(db)
  const maintenance = f.purpose === 'bootstrap'
  if (maintenance) {
    if (!f.owner) throw new Error('Maintenance owner missing')
    requireOwner(gate, f.owner)
    if (!['bootstrap', 'stopped'].includes(gate.phase)) throw new Error('Maintenance phase refused')
    const registry = readDocument<AccountRegistry>(db, 'registry').value
    if (![registry.home, gate.active, gate.intent?.to].includes(f.account)) throw new Error('Unrelated maintenance account')
  } else if (gate.phase !== 'open') throw new Error('Account admission frozen')
  if (f.generation !== gate.generation) throw new Error('Stale account generation')
  if (f.purpose === 'model' && f.account !== gate.active) throw new Error('Model family uses inactive account')
  if (f.purpose === 'probe' && f.account === gate.active) throw new Error('Active readings are passive')
  const existing = db.prepare('SELECT purpose FROM family WHERE account=?').all(f.account)
  if (existing.some(row => row.purpose !== 'model') || (f.purpose !== 'model' && existing.length))
    throw new Error('Credential lease busy')
  db.prepare('INSERT INTO family VALUES (?,?,?,?,?,NULL)')
    .run(f.id, f.account, f.purpose, f.participant, JSON.stringify(f))
}
```

`readGate(db)` decodes the sole row into `GateState`, validating phase/OwnerToken/intent fields. `adopt` first obtains a fresh process-table proof of the recorded owner's **dead** identity, then in a transaction compares the entire expected token, retains the transaction/intent, increments claim and installs the new process identity. Live/unknown/reused PID refuses adoption; the same surviving owner may re-enter with its exact token. All phase changes, journal publication and control requests check token+claim, so a stale runner cannot resume after replacement. Control framing ≤16KiB; private parent/socket modes 0700/0600; method/field allowlist; no bearer fields.

`begin` requires phase open, registered participant's matching generation and no pending recovery; inserts a work row. Release is idempotent. `register` allows a normal participant only while open. A maintenance participant must supply the exact current owner and may register while phase bootstrap/stopped; it has **no** model admission capability. `open` requires matching owner, zero work/old holders, valid latest metadata and the expected unique credential inventory. It atomically clears owner/intent and sets phase open. `phase` is compare-and-swap on owner and expected phase. Frozen state never expires with time.

Record `FamilyIntent` while the supervisor wrapper is blocked on IPC, before allowing any official process to access auth. Attach native group identity before granting the wrapper its run acknowledgement. Dead supervisor with a surviving native group stays a holder; release requires every recorded native descendant gone. A wrapper losing parent IPC closes stdin, TERM/KILLs its dedicated child group within the bounded grace period, then waits for confirmed absence. Never signal an adapter/router process group or a PID whose identity changed. `retireParticipant` requires no work and no family rows; recovery may remove abandoned work only after exact participant and all child identities are dead. Do not subtract a disconnected socket or steal by TTL.

- [ ] **Step 3: Implement owner-only maintenance without opening model admission.** `beginBootstrap(owner)` is a specialized freeze that stores reason bootstrap and phase draining; drain/stop, then set bootstrap. Canonical warmup reserves the registry home account; overlay validation reserves the recorded current active account. Each takes that account's exclusive bootstrap family, one at a time, while phase remains bootstrap. The maintenance RPC transport hard-allowlists initialize/initialized, account/read, account/rateLimits/read, config/read, thread/start (no turn), thread/read/resume/archive; no turn/start, steer, compact, review, realtime or broker bearer route exists. The fixture thread/start is non-generating, with the approved posture. The maintenance family path is fixed from its recorded account and canonical/overlay purpose; a caller cannot supply an arbitrary credential home. Bootstrap callback limits still use valid observation permits. Stop and release the family before reconciliation; repeated init uses another tracked family. Verify all links/state and metadata, then reopen. There is no untracked special-case subprocess.

Device login uses an exclusive `purpose:'login'` lease while gate open; `accounts add` reserves it before launching official login. Existing probe or login on that slot returns busy; login cannot replace an active model credential. Home/active re-login must first use an explicit owner maintenance drain. A switch freezes new login/probe reservations and waits for existing ones; a device-login wait can make a switch busy, but does not get killed to force progress. No login API runs inside bootstrap's RPC allowlist.

- [ ] **Step 4: Run exact process-boundary regressions.** Kill after freeze, during drain, after last family stop before journal, and after journal removal before open. A fresh public `accounts recover` must restore the known unchanged/final state. Test live/unknown/reused owner refusals and old-claim IPC rejection. Concurrent app+translator work must drain; a late web participant cannot register. Blank-home and version-change bootstrap run with model gate closed, including one reconcile/reinitialize, while a competing worker's turn admission fails. Login/probe same-account races admit exactly one credential writer. Different parked-account metadata probe and active model family coexist. Clock rollback preserves the ten-minute reservation floor.

- [ ] **Step 5: Run focused ledger tests, typecheck and quality checks; commit.** `git commit -m "feat: coordinate durable account transition ownership and credential lifetimes"`.

## Task 4: Journal move-only credential switches and prove crash recovery

**Files:** Create `src/accounts-journal.mts`, extend `src/accounts-files.mts`; create `test/accounts-journal.test.mts` and crash checkpoints in the fake worker.

**Consumes:** drained/frozen ledger; revisioned metadata; process-family proof. **Produces:** `sealTransition(p,owner,to):SealedTransition`, `planAuthMoves(p,before,to):AuthOp[]`, `beginJournal(p,sealed):SwitchJournal`, `applyJournal(p,j):SwitchJournal`, `publishTransition(p,owner,j):AccountRegistry`, `finishTransition(p,owner):void`, and `recoverAccounts(p,newOwner):Promise<void>`. `SealedTransition` carries the current owner, registry document revision/value, operations and exact inventory. Recovery always runs before creating any official managed child.

- [ ] **Step 1: Write the failure-matrix test before implementation.** Construct fixture homes with fake A/B/C marker files and record lstat inode/mtime/size. For each checkpoint below fork an independent switch worker, await its checkpoint IPC, SIGKILL it, reopen the ledger and call recovery. Assert canonical A unchanged, B and C each exist at exactly one legal path, no token copies anywhere, and generation/active agree. Do not pass a successful in-memory mock off as kill-mid-swap coverage.

```ts
const crashPoints = [
  'freeze-durable', 'draining', 'children-stopped', 'sealed-no-journal', 'journal-durable', 'outgoing-renamed', 'outgoing-recorded',
  'incoming-renamed', 'incoming-recorded', 'registry-durable',
  'ledger-published', 'journal-committed', 'journal-unlinked-before-open',
]
for (const point of crashPoints) {
  test(`recover SIGKILL at ${point} without duplicate credentials`, async () => {
    const fx = await accountFixture()
    const worker = await startSwitchWorker(fx, point)
    await worker.at(point)
    await worker.kill('SIGKILL')
    const result = await recoverFixture(fx)
    assert.equal(result.gate.phase, 'open')
    assert.equal(result.locations.home, 'canonical/auth.json')
    assert.equal(result.counts.home, 1)
    assert.equal(result.counts.b, 1)
    assert.equal(result.counts.c, 1)
    assert.equal(result.registry.generation, result.gate.generation)
    assert.equal(result.registry.active, result.gate.active)
    assert.equal(result.stats.home.ino, fx.original.home.ino)
    assert.equal(result.stats.home.mtimeMs, fx.original.home.mtimeMs)
  })
}
```

Define `accountFixture`, `startSwitchWorker`, `recoverFixture` in `test/helpers/accounts-fixture.mts`: fixture uses `tempDir`, writes only the exact markers `FAKE_HOME`, `FAKE_B`, `FAKE_C`, installs home symlink, constructs registry and ledger; worker is the Task 3 fixture imported through tracked spawn, emits `{checkpoint}` and waits for parent `continue`; recovery result inventories only fixture credential files using the known marker values. `kill` resolves on process exit. Include `EXDEV`, pre-existing destination, substituted symlink, ENOSPC on journal write, and unexpected inode tests: no copy fallback, no overwrite, admission remains closed with a precise repair report.

- [ ] **Step 2: Implement durable primitives and the idempotent operation interpreter.** These are the core implementations, including `durableJson` consumed by Task 1:

```ts
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readlinkSync, renameSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
export function syncDir(path: string): void {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
export function durableJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${randomUUID()}`
  const fd = openSync(tmp, 'wx', 0o600)
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd) }
  finally { closeSync(fd) }
  renameSync(tmp, path)
  syncDir(dirname(path))
}
export type AuthOp =
  | { kind: 'move'; from: string; to: string; dev: number; ino: number }
  | { kind: 'link' | 'unlink'; path: string; target: string }
function entry(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export function applyAuthOp(op: AuthOp): void {
  if (op.kind === 'move') {
    const from = entry(op.from), to = entry(op.to)
    const matches = (s: ReturnType<typeof lstatSync> | null) =>
      !!s && s.isFile() && s.dev === op.dev && s.ino === op.ino
    if (!from && matches(to)) return
    if (!matches(from) || to) throw new Error('Credential inventory conflict; admission remains closed')
    if (lstatSync(dirname(op.to)).dev !== op.dev) throw new Error('Credential moves require one filesystem')
    renameSync(op.from, op.to)
    syncDir(dirname(op.from)); syncDir(dirname(op.to))
    return
  }
  const current = entry(op.path)
  const correct = current?.isSymbolicLink() && readlinkSync(op.path) === op.target
  if (op.kind === 'link') {
    if (correct) return
    if (current) throw new Error('Auth link destination occupied')
    symlinkSync(op.target, op.path)
  } else {
    if (!current) return
    if (!correct) throw new Error('Refusing to unlink unexpected auth entry')
    unlinkSync(op.path)
  }
  syncDir(dirname(op.path))
}
export function inverseAuthOp(op: AuthOp): AuthOp {
  if (op.kind === 'move') return { ...op, from: op.to, to: op.from }
  return { ...op, kind: op.kind === 'link' ? 'unlink' : 'link' }
}
```

Preflight every source/destination with `lstat`, owner/mode checks and same-device check **before** changing anything. Private directories 0700, real auth files 0600, no group/world permissions. Strictly reject a managed credential symlink or hard-linked regular auth (`nlink !== 1`). Canonical home symlink is the only auth symlink exception. Never log file contents or raw filesystem errors with uncontrolled path text; CLI may display private paths on explicit local request.

Journal types and exact durable ordering:

```ts
export interface PendingAuthOperation {
  direction: 'forward' | 'reverse'
  index: number
  operation: AuthOp
  before: CredentialStamp[]
  after: CredentialStamp[]
}
export interface SwitchJournal {
  version: 2
  transaction: string
  from: string
  to: string
  generation: number
  registryRevision: number
  phase: 'forward' | 'rollback' | 'metadata-restored' | 'committed'
  before: AccountRegistry
  ops: AuthOp[]
  forwardDone: number
  reverseNext: number | null
  pending: PendingAuthOperation | null
}
```

`sealTransition(p,owner,to)` runs after all work/families stop. Under one SQLite write transaction it validates owner/phase, reloads the **latest** registry document and its revision, preserves completed probe identity/login updates and user settings, revalidates from/to/generation and automatic-rotation enablement, inventories exact credential locations and stores phase sealed plus that inventory/revision in gate intent. Metadata settings are busy from this point until open. `beginJournal` consumes this sealed snapshot; it does not accept a pre-drain registry parameter. Write/fsync the complete journal, then CAS gate sealed→journal; no file operation can run before both are durable. A killed sealed operation with no journal is therefore provably pre-move.

Each operation gets a write-ahead `pending` containing the **complete credential inventory** before and after the one operation. Predict regular credential dev/inode/nlink unchanged; home-link expectations compare exact target and symlink kind (not a fabricated future symlink inode). Canonical home regular-file identity is retained. All expected paths include absence where necessary. No extra regular auth path is allowed. Use the following loop for forward and reverse work:

```ts
function settlePending(p: AccountPaths, j: SwitchJournal): SwitchJournal {
  const pending = j.pending
  if (!pending) return j
  const actual = inventoryCredentials(p)
  if (sameInventory(actual, pending.before)) {
    applyAuthOp(pending.operation)
    if (!sameInventory(inventoryCredentials(p), pending.after)) throw new Error('Unexpected credential result')
  } else if (!sameInventory(actual, pending.after)) {
    throw new Error('Credential inventory conflict; recovery remains frozen')
  }
  const next = { ...j, pending: null,
    forwardDone: pending.direction === 'forward' ? pending.index + 1 : j.forwardDone,
    reverseNext: pending.direction === 'reverse' ? pending.index - 1 : j.reverseNext }
  durableJson(p.journal, next)
  return next
}
function applyRecordedOperation(p: AccountPaths, j: SwitchJournal, direction: 'forward' | 'reverse', index: number): SwitchJournal {
  if (j.pending) throw new Error('Settle prior operation first')
  const operation = direction === 'forward' ? j.ops[index] : inverseAuthOp(j.ops[index])
  const before = inventoryCredentials(p)
  // projectInventory verifies source kind/dev/ino/nlink, absent destination,
  // allowed home link and same filesystem before returning expected after.
  const after = projectInventory(before, operation)
  const prepared = { ...j, pending: { direction, index, operation, before, after } }
  durableJson(p.journal, prepared)
  return settlePending(p, prepared)
}
function reverseJournal(p: AccountPaths, input: SwitchJournal): SwitchJournal {
  let j = settlePending(p, input)
  if (j.phase !== 'rollback') {
    j = { ...j, phase: 'rollback', reverseNext: j.forwardDone - 1 }
    durableJson(p.journal, j)
  }
  while (j.reverseNext !== null && j.reverseNext >= 0)
    j = applyRecordedOperation(p, j, 'reverse', j.reverseNext)
  return j
}
```

`inventoryCredentials` enumerates only canonical auth, overlay auth and registered account auth slots using lstat/readlink; it never reads/hashes content. `sameInventory` compares sorted paths, presence/kind and every regular dev/inode/nlink; home-link target exact. `projectInventory` applies one operation to the metadata graph and refuses occupied destinations, unknown paths, incorrect inode, hard links, cross-device movement or an extra credential location. `applyAuthOp` retains its existing strict checks; do not weaken them to tolerate completed reverse operations. The cursor plus pending pre/post graph makes that unnecessary.

An unexpected regular file/symlink cannot become “already done” merely because a cursor claims progress. The pending operation is settled against the full graph before advancing its cursor. Validate the settled journal graph before preparing the next operation. A process killed after an inverse rename but before decrementing reverseNext observes pending.after, commits that decrement without renaming again, and continues. It never replays an inverse whose source is now another account.

**Commit decision:** after forward completion and exact final inventory verification, `publishTransition(owner,j)` uses a single SQLite transaction to require matching sealed metadata revision, zero work/holders, then update registry active/generation, ledger active/generation, revoke all old observation authorities, add the deduplicated rotation event, and set phase cleanup-commit with finalInventory. Settings/identity/limits not owned by the transition remain intact. The database commit is the irreversible decision between rollback and roll-forward; after it, recovery **never** reverses the journal, even if the file still says forward. Project latest JSON, mark journal committed, remove/fsync journal, validate final inventory and open admission. A crash at any cleanup point rolls forward from the durable gate intent.

**Rollback decision:** before the commit decision, explicit recovery/cancellation sets gate rolling-back and settles/reverses the journal as above. After reverseNext reaches -1 and original inventory matches, restore registry active/generation and the same-owner gate state atomically from the post-drain sealed before snapshot; leave unrelated documents untouched. There are no settings writers after seal. Set gate cleanup-rollback, project JSON, mark journal metadata-restored, remove/fsync journal, validate original inventory and open. A kill after registry restoration or journal unlink resumes cleanup from the gate and does not restart reversal. Keep a private terminal metadata record for diagnostic/repeat verification.

**One public recovery entrypoint covers every frozen interval:** `recoverAccounts(p,newOwner)` first adopts only a proven-dead owner (or resumes its exact live token), fences the prior claim, and retains holders/work. It drains or proves dead all recorded families before credential operations. Its state table is mandatory:

| Gate state | Journal | Recovery action |
|---|---|---|
| draining/stopped | absent | No auth move was permitted; verify current registry active/generation and unique legal credential layout, preserve newest settings/identity metadata, reopen unchanged. |
| sealed | absent | Compare recorded sealed inventory and registry revision; no move permitted. Clear seal and reopen unchanged. |
| sealed | present | Journal durable but gate not advanced; validate transaction and pre-state, enter journal then the normal reversible recovery. |
| journal/rolling-back | present | Resume pending forward settlement and durable reverse cursor; restore pre-state. |
| journal/rolling-back | absent | Unexplained data loss: refuse, retain freeze/pins and report missing journal; never guess. |
| cleanup-commit | present or absent | Verify committed metadata/finalInventory, finish projection/journal cleanup, reopen committed account. |
| cleanup-rollback | present or absent | Verify restored metadata/original inventory, finish cleanup, reopen original account. |
| bootstrap | absent | Stop exact maintenance families, reconcile only attributable non-auth state, validate unchanged credential layout, reopen or retain explicit overlay conflict. |
| open | absent | Verify consistency and return; no adoption or mutation. |

A journal from another transaction/generation, unrecognized owner or unexplained inventory mismatch always refuses. Gate tokens retain transaction identity across adoption; never rewind a newer generation. Recovery re-entry never relies on the router remaining alive.

- [ ] **Step 3: Kill recovery itself at every reverse/cleanup boundary.** For home→B, B→C and B→home: kill before reverse pending write, after it, after every inverse rename/link/unlink, before/after reverse cursor write, after reverseNext=-1, after metadata restoration, after projection, after journal unlink and before open. Repeatedly recover from a fresh process through public `accounts recover`, killing it at a second distinct reverse checkpoint where available; final recovery must reopen with exactly one credential location per account and consistent metadata, not stop at a preserved conflict. Add the no-journal checkpoints after freeze/during drain/after last child stop and committed journal-unlink interval. Live/unknown/reused owner still refuses. Keep EXDEV/occupied destination/wrong inode failures exactly strict.

- [ ] **Step 4: Run focused checks and commit.** `git commit -m "feat: journal crash-safe forward and reverse account transitions"`.

## Task 5: Persist faithful limits independently of callback epochs

**Files:** Create `src/limits-openai.mts`, `limits-claude.mts`, `limits-store.mts`, `limits-format.mts`, `accounts-observations.mts`; extend AccountMetadata; focused limits/observation tests.

**Consumes:** installed schema, SDK event shape, revisioned metadata and family authority. **Produces:** pure `observeOpenAIRead`, `observeOpenAIUpdate`, `observeClaude`, `formatLimits`; transactional `issueObservationPermit`, `allocateObservationSample`, `AccountMetadata.acceptObservation`.

An account's observations survive parking, activation and process restart. **LimitState has no admission generation.** Epoch/source validation belongs to the callback envelope and ledger permit, not retained account data. Moving to a new generation never initializes an empty limits row or clears denials/field ages.

```ts
export interface Observed<T> { value: T; at: number; sequence: number; source: 'read' | 'update' | 'claude-event' }
export interface DenialEvidence { quotaAt: number | null; spendAt: number | null; quotaSequence: number; spendSequence: number }
export interface LimitState {
  account: string
  buckets: Record<string, Observed<BucketReading>>
  ordinary: Observed<boolean> | null
  resetCredits: Observed<{ availableCount: number; credits?: unknown[] | null }> | null
  denials: Record<string, DenialEvidence> // 'global' or 'bucket:<exact limitId>'
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  error: 'needs-login' | 'unavailable' | null
  fieldTimes: Record<string, number>
  fieldSequences: Record<string, number>
}
export interface ObservationPermit {
  id: string; account: string; epoch: number; sourceId: string; sourceRevision: number
  familyId: string; purpose: 'active' | 'probe' | 'maintenance'
}
export interface ObservationSample { permit: ObservationPermit; sequence: number; startedAt: number }
export interface ObservationEnvelope {
  sample: ObservationSample
  kind: 'openai-read' | 'openai-update' | 'openai-quota-error' | 'claude-event'
  payload: unknown
  identity?: { vendorAccountId: string | null; email: string | null; planType: string | null }
}
export function emptyLimits(account: string): LimitState {
  return { account, buckets: {}, ordinary: null, resetCredits: null, denials: {},
    lastAttemptAt: null, lastSuccessAt: null, error: null, fieldTimes: {}, fieldSequences: {} }
}
export function blocked(state: LimitState, scope: string): boolean {
  const d = state.denials[scope]
  return !!d && (d.quotaAt !== null || d.spendAt !== null)
}
```

- [ ] **Step 1: Write epoch and independent-writer tests.**

```ts
test('account observations persist across activation while stale callbacks are fenced', async () => {
  const fx = await accountFixture()
  const old = await fx.parkedPermit('b')
  await fx.observe(old, { ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' } })
  const held = await fx.sample(old)
  const before = fx.limits('b')
  await fx.closePermitFamily(old)
  await fx.use('b')
  const active = await fx.activePermit('b')
  assert.equal(active.epoch, 1)
  assert.deepEqual(fx.limits('b'), before)
  assert.equal(await fx.deliver(held, { rateLimits: { limitId: 'codex', primary: { usedPercent: 99 } } }), false)
  assert.equal(await fx.observeUpdate(active, { rateLimits: { limitId: 'codex', primary: { usedPercent: 7, windowDurationMins: 10080 } } }), true)
  await fx.closePermitFamily(active)
  await fx.use('home')
  const parkedAgain = await fx.parkedPermit('b')
  assert.equal(parkedAgain.epoch, 2)
  assert.equal(await fx.observe(parkedAgain, { ordinaryUsageAllowed: false, rateLimits: {} }), true)
  await fx.closePermitFamily(parkedAgain)
  await fx.use('b')
  assert.equal(blocked(fx.limits('b'), 'global'), true)
  fx.reopen()
  assert.equal(blocked(fx.limits('b'), 'global'), true)
})
```

`reduceObservation` dispatches validated openai-read/update to the pure reducers below. For openai-quota-error, accept only a terminal usageLimitExceeded enum plus a bucket association verified from the admitted model/catalog; set that scope’s quota evidence using the sample sequence without inventing percentages or advancing lastSuccessAt. Claude-event dispatch uses its separate PTY authority.

The fixture wrappers call real ledger/metadata APIs with fake families; a held sample is allocated before the family closes. Add independent workers that allocate samples under barriers then submit (a) a denial and (b) an unrelated model bucket. Both fields and the denial must survive process restart and JSON projection repair regardless of commit order. Older observations of the **same field/scope** cannot override newer ones; an older unrelated bucket may still merge. Test a read that began before a later push but completes afterward.

- [ ] **Step 2: Implement callback authority and atomic merge.** `issueObservationPermit` runs under SQLite write lock, requires the recorded live family and correct source revision, and records epoch equal to gate generation. `allocateObservationSample` verifies that permit and allocates a monotonically increasing per-account sequence before a read is sent (for push events, at raw receipt). Source closure/respawn revokes its permits before releasing the family; a committed account change revokes every old-epoch permit. A reopened process must issue a new permit. Retained limits never change solely because a permit changes.

`acceptObservation` executes the following OpenAI path in **one** `BEGIN IMMEDIATE`; the Claude-event branch uses its independently validated PTY source authority instead of the OpenAI epoch predicate:

```ts
function acceptObservationLocked(db: DatabaseSync, e: ObservationEnvelope): boolean {
  const p = e.sample.permit
  const authority = db.prepare('SELECT * FROM observation_authority WHERE id=?').get(p.id)
  const gate = readGate(db)
  if (!authority || Number(authority.valid) !== 1 || String(authority.account) !== p.account ||
      Number(authority.epoch) !== p.epoch || p.epoch !== gate.generation ||
      String(authority.source_id) !== p.sourceId || Number(authority.source_revision) !== p.sourceRevision ||
      String(authority.family_id) !== p.familyId ||
      !db.prepare('SELECT id FROM family WHERE id=?').get(p.familyId)) return false
  if (['sealed', 'journal', 'rolling-back', 'cleanup-commit', 'cleanup-rollback'].includes(gate.phase)) return false
  if (e.identity && !mergeVerifiedIdentityLocked(db, p.account, e.identity)) return false
  const doc = readDocument<Record<string, LimitState>>(db, 'limits')
  const old = doc.value[p.account] ?? emptyLimits(p.account)
  const next = reduceObservation(old, e) // allowlist decoder + reducer below
  replaceDocument(db, 'limits', doc, { ...doc.value, [p.account]: next })
  return true
}
```

`mergeVerifiedIdentityLocked(...):boolean` reloads the latest registry in this transaction, updates only that account's verified identity/login fields, rejects a duplicate/mismatched non-null vendor ID, and leaves active/generation/rotation/replay/labels unchanged. A mismatch commits needs-login/quarantine while preserving previous identity evidence, returns false, and skips all limit-payload merging; it does not throw away the quarantine transaction. Its payload is never attributed to the old account. On failed probe save lastAttempt/error by a metadata transaction without changing lastSuccessAt. Runtime callers then call `project()`; the committed row is already authoritative if projection is interrupted. Router-down control/probe paths use exactly this function through AccountMetadata, not raw JSON writes.

- [ ] **Step 3: Implement sticky evidence independently of display buckets.** Installed positive-recovery rules:

| Scope/evidence | Set by | Positive recovery |
|---|---|---|
| global quota | authoritative ordinaryUsageAllowed=false, default codex reached quota, or usageLimitExceeded for the ordinary bucket | Later authoritative ordinaryUsageAllowed=true with no contemporaneous default-codex denial. |
| global spend | default codex spendControlReached=true/workspace credit/spend rejection | Later authoritative default codex spendControlReached=false and ordinaryUsageAllowed=true, with no contemporaneous rejection. |
| bucket quota | non-default bucket's rate_limit_reached or a quota error attributed by catalog to that bucket | Current installed schema has **no explicit positive per-bucket ordinary-usage permission**. Keep the latch until a future captured supported field proves recovery; null/0%/reset passage and global allowance never clear it. Manual account selection remains an explicit choice, not automatic inferred recovery. |
| bucket spend | exact bucket spendControlReached=true or workspace credit/spend rejection | Later authoritative read of that **same bucket** has spendControlReached=false and no contemporaneous spend rejection; clears spend evidence only. |

This conservative scoped-quota latch costs automatic reuse of that model bucket after reset until supported positive evidence exists; it does not disable unrelated models or force account rotation for them. Do not invent a `allowed` field in the installed app-server response. Preserve both quota/spend evidence when present; clearing one does not clear the other.

```ts
function updateDenial(old: DenialEvidence | undefined, bucket: BucketReading,
  ordinary: boolean | null | undefined, scope: string, authoritative: boolean,
  at: number, sequence: number): DenialEvidence {
  const d = old ? { ...old } : { quotaAt: null, spendAt: null, quotaSequence: -1, spendSequence: -1 }
  const reached = bucket.rateLimitReachedType
  const quota = reached === 'rate_limit_reached' || (scope === 'global' && ordinary === false)
  const spend = bucket.spendControlReached === true ||
    (typeof reached === 'string' && reached.startsWith('workspace_'))
  const quotaRecovered = authoritative && scope === 'global' && ordinary === true && !quota && !spend
  const spendRecovered = authoritative && bucket.spendControlReached === false && !spend &&
    (scope !== 'global' || (ordinary === true && !quota))
  if (sequence >= d.quotaSequence && (quota || quotaRecovered)) {
    d.quotaAt = quota ? at : null
    d.quotaSequence = sequence
  }
  if (sequence >= d.spendSequence && (spend || spendRecovered)) {
    d.spendAt = spend ? at : null
    d.spendSequence = sequence
  }
  return d
}
export function observeOpenAIRead(old: LimitState, read: OpenAIRead, sample: ObservationSample): LimitState {
  return mergeOpenAI(old, read, sample, true)
}
export function observeOpenAIUpdate(old: LimitState, update: { rateLimits: BucketReading }, sample: ObservationSample): LimitState {
  return mergeOpenAI(old, { rateLimits: update.rateLimits }, sample, false)
}
function mergeOpenAI(old: LimitState, read: OpenAIRead, sample: ObservationSample, full: boolean): LimitState {
  const next = structuredClone(old)
  const { sequence, startedAt: at } = sample
  const singleId = read.rateLimits.limitId ?? 'codex'
  const incoming: Record<string, BucketReading> = {
    [singleId]: read.rateLimits,
    ...(full ? read.rateLimitsByLimitId ?? {} : {}),
  }
  for (const [id, bucket] of Object.entries(incoming)) {
    if (bucket.limitId != null && bucket.limitId !== id)
      throw new Error('Conflicting rate-limit bucket identity')
    mergeBucketFields(next, id, bucket, full, at, sequence)
    const scope = id === 'codex' ? 'global' : `bucket:${id}`
    next.denials[scope] = updateDenial(next.denials[scope], bucket,
      full ? read.ordinaryUsageAllowed : undefined, scope, full, at, sequence)
  }
  if (full && !Object.hasOwn(incoming, 'codex'))
    next.denials.global = updateDenial(next.denials.global, {},
      read.ordinaryUsageAllowed, 'global', true, at, sequence)
  if (full && read.ordinaryUsageAllowed !== null && read.ordinaryUsageAllowed !== undefined &&
      sequence >= (next.ordinary?.sequence ?? -1))
    next.ordinary = { value: read.ordinaryUsageAllowed, at, sequence, source: 'read' }
  if (full && read.rateLimitResetCredits !== null && read.rateLimitResetCredits !== undefined &&
      sequence >= (next.resetCredits?.sequence ?? -1))
    next.resetCredits = { value: read.rateLimitResetCredits, at, sequence, source: 'read' }
  next.lastSuccessAt = Math.max(next.lastSuccessAt ?? 0, at)
  next.error = null
  return next
}
```

**Scope normalization:** preserve an explicit single-snapshot limitId exactly, including when the multi-bucket map is absent, null, empty or lacks that bucket. Only an absent/null single-snapshot ID uses the captured historical codex default. Merge the single snapshot into the keyed input, then let an existing map entry for the same ID supply that bucket once; do not apply a duplicate mirror as a second global observation. Reject a map-key/explicit-limitId mismatch instead of promoting it. The codex entry alone supplies global **bucket** evidence. If no codex entry exists, global ordinaryUsageAllowed is still processed, with an empty bucket input: true may clear authorized global quota evidence, false may set it, and neither imports another bucket's quota/spend rejection. All scoped sticky-denial recovery rules remain unchanged.

`mergeBucketFields` walks the allowlisted BucketReading leaves. For each supplied non-null sparse field, apply only if its sequence ≥ fieldSequences[key]; preserve old null/absent sparse values and their ages. For a full read, absent/null display fields become unknown only if its sequence is not older than that field's recorded sequence. Required `usedPercent` is validated numeric/finite, and retained verbatim (out-of-range values flagged invalid for policy). Record fieldTimes and fieldSequences independently per leaf; update bucket observation at the maximum applied field time/sequence. Do **not** remove denials when a bucket becomes unknown or disappears from a full read. Bucket source/label changes never rename an existing denial key.

- [ ] **Step 4: Pin scoped recovery and faithful display with exact tests.**

```ts
for (const mapForm of ['present', 'absent', 'null'] as const) {
  test(`explicit Spark remains scoped with ${mapForm} multi-bucket map`, () => {
    const spark: BucketReading = { limitId: 'spark', normalModelSlug: 'spark-model',
      rateLimitReachedType: 'rate_limit_reached', primary: { usedPercent: 100, resetsAt: 1 } }
    const read: OpenAIRead = { ordinaryUsageAllowed: true, rateLimits: spark,
      ...(mapForm === 'present' ? { rateLimitsByLimitId: { spark } } :
        mapForm === 'null' ? { rateLimitsByLimitId: null } : {}) }
    let state = observeOpenAIRead(emptyLimits('b'), read, sample(1, 100))
    assert.deepEqual(Object.keys(state.buckets), ['spark'])
    assert.equal(blocked(state, 'bucket:spark'), true)
    assert.equal(blocked(state, 'global'), false)
    assert.equal(eligibleForModel(state, 'ordinary-model', { 'ordinary-model': ['codex'] }, 200), true)
    assert.equal(eligibleForModel(state, 'spark-model', { 'spark-model': ['spark'] }, 200), false)
    state = observeOpenAIRead(state, { ordinaryUsageAllowed: null,
      rateLimits: { limitId: 'spark', primary: null, rateLimitReachedType: null, spendControlReached: null } }, sample(2, 300))
    assert.equal(blocked(state, 'bucket:spark'), true)
    assert.equal(blocked(state, 'global'), false)
    assert.equal(eligibleForModel(state, 'spark-model', { 'spark-model': ['spark'] }, 400), false)
    state = observeOpenAIRead(state, { ...read, ordinaryUsageAllowed: false }, sample(3, 500))
    assert.equal(blocked(state, 'global'), true)
    state = observeOpenAIRead(state, read, sample(4, 600))
    assert.equal(blocked(state, 'global'), false) // independent positive ordinary permission
    assert.equal(blocked(state, 'bucket:spark'), true)
  })
}
test('single snapshot absent from map keeps its scope; duplicate mirror is applied once', () => {
  const spark: BucketReading = { limitId: 'spark', rateLimitReachedType: 'rate_limit_reached' }
  const missing = observeOpenAIRead(emptyLimits('b'), { ordinaryUsageAllowed: true,
    rateLimits: spark, rateLimitsByLimitId: { codex: { limitId: 'codex' } } }, sample(1, 100))
  assert.deepEqual(Object.keys(missing.buckets).sort(), ['codex', 'spark'])
  assert.equal(blocked(missing, 'bucket:spark'), true)
  assert.equal(blocked(missing, 'global'), false)
  const duplicate = observeOpenAIRead(emptyLimits('b'), { ordinaryUsageAllowed: true,
    rateLimits: spark, rateLimitsByLimitId: { spark: { ...spark, limitName: 'Spark' } } }, sample(1, 100))
  assert.deepEqual(Object.keys(duplicate.buckets), ['spark'])
  assert.equal(duplicate.buckets.spark.value.limitName, 'Spark')
  assert.equal(blocked(duplicate, 'bucket:spark'), true)
  assert.equal(blocked(duplicate, 'global'), false)
  const empty = observeOpenAIRead(emptyLimits('b'), { ordinaryUsageAllowed: true,
    rateLimits: spark, rateLimitsByLimitId: {} }, sample(1, 100))
  assert.equal(blocked(empty, 'bucket:spark'), true)
  assert.equal(blocked(empty, 'global'), false)
})
for (const mapForm of ['present', 'absent', 'null'] as const) {
  test(`genuine codex rejection remains global with ${mapForm} map`, () => {
    const codex: BucketReading = { limitId: 'codex', rateLimitReachedType: 'rate_limit_reached' }
    const state = observeOpenAIRead(emptyLimits('b'), { ordinaryUsageAllowed: true, rateLimits: codex,
      ...(mapForm === 'present' ? { rateLimitsByLimitId: { codex } } :
        mapForm === 'null' ? { rateLimitsByLimitId: null } : {}) }, sample(1, 100))
    assert.equal(blocked(state, 'global'), true)
    assert.equal(eligibleForModel(state, 'ordinary-model', { 'ordinary-model': ['codex'] }, 200), false)
  })
}
test('historical absent limit ID retains the codex default', () => {
  const state = observeOpenAIRead(emptyLimits('b'), { ordinaryUsageAllowed: true,
    rateLimits: { rateLimitReachedType: 'rate_limit_reached' } }, sample(1, 100))
  assert.equal(blocked(state, 'global'), true)
})
```

```ts
test('scoped denial survives null fields and elapsed reset; unrelated model remains eligible', () => {
  let s = emptyLimits('b')
  s = observeOpenAIRead(s, { ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex' } }, sample(1, 100))
  s = observeOpenAIUpdate(s, { rateLimits: { limitId: 'spark', normalModelSlug: 'spark-model',
    rateLimitReachedType: 'rate_limit_reached', primary: { usedPercent: 100, resetsAt: 1 } } }, sample(2, 200))
  s = observeOpenAIUpdate(s, { rateLimits: { limitId: 'spark', primary: { usedPercent: 0 } } }, sample(3, 300))
  s = observeOpenAIRead(s, { ordinaryUsageAllowed: null, rateLimits: {}, rateLimitsByLimitId: {
    spark: { primary: null, rateLimitReachedType: null, spendControlReached: null },
  } }, sample(4, 400))
  assert.equal(blocked(s, 'bucket:spark'), true)
  assert.equal(blocked(s, 'global'), false)
  assert.equal(eligibleForModel(s, 'spark-model', { 'spark-model': ['spark'] }, 500), false)
  assert.equal(eligibleForModel(s, 'ordinary-model', { 'ordinary-model': ['codex'] }, 500), true)
  s = observeOpenAIRead(s, { ordinaryUsageAllowed: true, rateLimits: {}, rateLimitsByLimitId: {
    spark: { spendControlReached: false, rateLimitReachedType: null },
  } }, sample(5, 500))
  assert.equal(blocked(s, 'bucket:spark'), true) // explicit spend recovery does not clear quota
})
```

`sample(sequence,startedAt)` is a pure-test helper returning an ObservationSample with a fixed fake permit; reducer tests do not bypass authority integration tests. Add spend-only bucket denial→authoritative same-bucket false clears that one scope while another bucket and global denial survive. Include weekly in primary, missing five-hour as `—`, unknown durations, decimals as strings, reset-credit details null vs [], old-field ages after sparse update and record/restart persistence.

Claude reducer uses actual `rate_limit_event.rate_limit_info`, one retained entry per type: utilization fraction→percent only when supplied; status and overage separately; unknown credit balance stays unknown. It uses the same serialized document update and source permit discipline with vendor-specific source identity, no OpenAI epoch reset of the Claude cache. A Claude event authority is tied to its PTY lifecycle and remains independent of an OpenAI switch. Always show the Claude row, honestly “not observed” before a real event.

- [ ] **Step 5: Run focused reducer, cross-process observation, formatting tests and commit.** `git commit -m "feat: persist scoped account limits with fenced serialized observations"`.

## Task 6: Read parked limits through official exclusive probes

**Files:** Create `src/accounts-probe.mts`, `test/accounts-probe.test.mts`; extend fake official child identity/refresh barriers. **Consumes:** per-account family exclusion, durable ten-minute reservation, ObservationPermit and AccountMetadata. **Produces:** `probeParked(options):Promise<ProbeResult>`.

```ts
export interface ProbeClient {
  permit: ObservationPermit
  request(method: 'account/read' | 'account/rateLimits/read', params: unknown): Promise<unknown>
  close(): Promise<void>
}
export interface ProbeResult { status: 'read' | 'cached' | 'needs-login' | 'unavailable'; nextAllowedAt: number }
export interface ProbeOptions {
  p: AccountPaths; accountId: string; ledger: AccountLedger; metadata: AccountMetadata
  now(): number
  launch(home: string, account: string, generation: number): Promise<ProbeClient>
  sample(permit: ObservationPermit): ObservationSample
}
```

- [ ] **Step 1: Write the exclusive/throttled test.**

```ts
test('parked probe does not block active model work and preserves its authoritative result', async () => {
  const fx = await accountFixture()
  const probe = fx.blockProbe('b', 'before-read-response')
  const pending = probeParked(fx.probeOptions('b'))
  await probe.atBarrier()
  const app = fx.ledger.begin(fx.appParticipant, 0)
  assert.equal(app.generation, 0)
  await assert.rejects(fx.login('b'), /Credential lease busy/)
  assert.equal((await probeParked(fx.probeOptions('b'))).status, 'cached')
  probe.release({ accountId: 'FAKE_B', ordinaryUsageAllowed: true, rateLimits: {} })
  assert.equal((await pending).status, 'read')
  assert.equal(fx.registry().accounts.find(a => a.id === 'b')?.vendorAccountId, 'FAKE_B')
  assert.equal(fx.limits('b').ordinary?.value, true)
  assert.equal(fx.calls.some(m => /turn|thread|responses/.test(m)), false)
  await app.release()
})
```

- [ ] **Step 2: Implement the official probe with a launch-scoped permit.**

```ts
export async function probeParked(o: ProbeOptions): Promise<ProbeResult> {
  const at = o.now()
  const registry = o.metadata.read<AccountRegistry>('registry').value
  const account = registry.accounts.find(a => a.id === o.accountId)
  if (!account) throw new Error('Unknown account')
  if (account.id === registry.active) return { status: 'cached', nextAllowedAt: at }
  if (!o.ledger.reserveProbe(account.id, at))
    return { status: 'cached', nextAllowedAt: o.ledger.probeAttempt(account.id) + 600000 }
  let client: ProbeClient | null = null
  let sample: ObservationSample | null = null
  try {
    const home = account.kind === 'home' ? o.p.canonical : accountHome(o.p, account.id)
    client = await o.launch(home, account.id, registry.generation)
    sample = o.sample(client.permit)
    const identity = decodeAccountIdentity(await client.request('account/read', {}))
    const read = decodeOpenAIRead(await client.request('account/rateLimits/read', { excludeResetCreditDetails: false }))
    const accepted = o.metadata.acceptObservation({ sample, kind: 'openai-read', payload: read,
      identity: { ...identity, vendorAccountId: read.accountId ?? null } })
    o.metadata.project()
    return { status: accepted ? 'read' : 'unavailable', nextAllowedAt: at + 600000 }
  } catch (error) {
    const status = isLoginFailure(error) ? 'needs-login' : 'unavailable'
    o.metadata.recordProbeFailure({ account: account.id, epoch: registry.generation, sample, attemptedAt: at, status })
    o.metadata.project()
    return { status, nextAllowedAt: at + 600000 }
  } finally { await client?.close() }
}
```

`decodeAccountIdentity` allowlists account.email/planType from official account/read; account:null is needs-login. `decodeOpenAIRead` validates Task 1 schema fields and drops uncontrolled envelope fields. `isLoginFailure` matches structured unauthorized/notLoggedIn/account:null, never generic network errors. Mismatched vendor identity is quarantined inside acceptObservation atomically with the current registry, not merely checked against a pre-launch snapshot. `recordProbeFailure(input:{account:string,epoch:number,sample:ObservationSample|null,attemptedAt:number,status:'needs-login'|'unavailable'}):void` is added to AccountMetadata in this task. Inside the same SQLite mutation authority it revalidates the original permit/epoch and only changes lastAttempt/error and, for a currently valid explicit login error, login state; it does not erase observed fields or denial evidence. A revoked late callback records no result; cancellation/closed-generation failures must not quarantine a newly active identity. Without a sample (launch failed before permit issuance), record only unavailable against the unchanged epoch/parked account; never change its login state. The persisted attempt reservation already records that launch attempt.

`launch` reserves exclusive purpose probe and durably records family/supervisor/native identity before Codex can open auth, initializes once, issues the permit, and exposes only the two metadata RPC methods. Clear bearer/API-key/router override environment; choose real official binary. Active account stays running. Cap total time 20 seconds; timeout closes the exact family and waits for confirmed exit before releasing credential lease/permit. If proof of exit fails, switch remains blocked. `close` revokes the permit before family removal; observation/identity transaction completes **before** close so a waiting switch's post-drain snapshot includes it.

Persist attempted time before launch, even on failure/kill; `probeAttempt` returns that actual value. No `--refresh` bypass, no sliding cooldown per view. If gate freezes between reservation and launch, family admission refuses before auth access and the attempt remains throttled. Never start a second probe on the same account because a clock jump made its prior timestamp look old: family exclusion remains authoritative.

Read triggers: explicit limits --refresh, stale rotation candidate, bounded router metadata scheduler (one probe at a time). Exhausted known-reset next attempt is max(lastAttempt+600000,reset+1000). No perpetual auto timer with rotation off; no usage-spending health requests.

- [ ] **Step 3: Test refresh, generation and metadata races.** Hold fake refresh immediately before auth replacement; queue switch to its account; assert no credential move until the fake file is refreshed and official native family exits. Kill probe parent while native child survives and keep its holder. Probe at epoch 0, activate at 1, accept active epoch-1 update, reject held epoch-0 callback, park/read at 2 and reactivate without losing limits. Finish identity read while a manual switch drains and concurrently disable automatic rotation: final switched registry retains both identity and disabled policy. Failure throttle survives process restart and clock rollback. No model or thread RPC occurs in any probe trace.

- [ ] **Step 4: Run focused tests and commit.** `git commit -m "feat: read parked limits with exclusive fenced official probes"`.

## Task 7: Select and switch at a global safe boundary without stale metadata

**Files:** Create `src/accounts-policy.mts`, `accounts-rotation.mts`, policy/rotation tests. **Consumes:** scoped persistent limits, current registry/ledger, fenced owner, journal, probes and M2 broker. **Produces:** `chooseAccount`, `eligibleForModel`, `quotaFailure`, `rotateAccount`.

```ts
export interface Candidate {
  account: Account; limits: LimitState | null; credentialPresent: boolean
  scopeMap: Record<string, readonly string[]> // verified model -> exact quota bucket IDs
}
export interface RotationDeps {
  paths: AccountPaths; ledger: AccountLedger; metadata: AccountMetadata
  owner(): OwnerToken
  waitForQuiet(owner: OwnerToken, signal: AbortSignal): Promise<void>
  stopParticipants(owner: OwnerToken): Promise<void>
  invalidate(generation: number): void
  restartParticipants(generation: number): Promise<void>
}
export function eligibleForModel(l: LimitState, model: string,
  scopeMap: Record<string, readonly string[]>, now: number): boolean {
  if (blocked(l, 'global') || l.error || !l.ordinary?.value || now - l.ordinary.at > 600000) return false
  const buckets = scopeMap[model] ?? ['codex']
  return !buckets.some(id => id !== 'codex' && blocked(l, `bucket:${id}`))
}
export function chooseAccount(active: string, candidates: Candidate[], now: number, model: string): string | null {
  for (const c of candidates) {
    if (c.account.id === active || c.account.login !== 'ready' || !c.credentialPresent || !c.limits) continue
    if (eligibleForModel(c.limits, model, c.scopeMap, now)) return c.account.id
  }
  return null
}
export function quotaFailure(params: unknown): boolean {
  if (!params || typeof params !== 'object') return false
  const p = params as { error?: { codexErrorInfo?: unknown }; turn?: { status?: string; error?: { codexErrorInfo?: unknown } }; willRetry?: boolean }
  if (p.willRetry === true) return false
  return p.error?.codexErrorInfo === 'usageLimitExceeded' ||
    (p.turn?.status === 'failed' && p.turn.error?.codexErrorInfo === 'usageLimitExceeded')
}
```

The stable account list order is v1 drain order. Preserve quota-scope/model associations from verified catalog or `normalModelSlug` as separate private metadata; a null display read cannot discard that association and bypass a retained denial. Do not guess unknown bucket applicability; report unknown scope and require a verified mapping before offering that specific alias automatically. Ordinary-model mapping defaults to codex only for a catalog-proven ordinary GPT model. Proactive thresholds apply only valid percentages in applicable buckets; Spark-only rejection does not block unrelated GPT. `rateLimitExceeded`/generic 429 is congestion, not exhaustion. Elapsed resets and floating 0% reset times never recover capacity.

- [ ] **Step 1: Write policy and post-drain merge tests.**

```ts
test('manual switch preserves identity and settings committed during drain', async () => {
  const fx = await accountFixture()
  const turn = fx.ledger.begin(fx.appParticipant, 0)
  const probe = fx.blockProbe('b', 'before-read-response')
  const reading = probeParked(fx.probeOptions('b'))
  await probe.atBarrier()
  const switching = rotateAccount(fx.rotationDeps(), 'b', 'manual', new AbortController().signal)
  await fx.atPhase('draining')
  fx.metadata.editRegistry(r => ({ ...r, rotation: { ...r.rotation, enabled: false } }))
  probe.release({ accountId: 'FAKE_B', ordinaryUsageAllowed: true, rateLimits: {} })
  await reading
  await turn.release()
  await switching
  assert.equal(fx.registry().active, 'b')
  assert.equal(fx.registry().generation, 1)
  assert.equal(fx.registry().rotation.enabled, false)
  assert.equal(fx.registry().accounts.find(a => a.id === 'b')?.vendorAccountId, 'FAKE_B')
  assert.equal(fx.ledger.state().active, 'b')
})
```

Add all-exhausted returns null; ordinary allowance plus Spark sticky denial selects for ordinary model but not Spark; global denial blocks every model; expired/stale read never becomes usable by time alone. Duplicate error/completed signals dedupe by generation/thread/turn; cooldown 300 seconds; no failed-turn replay unless Task 9's explicit option.

- [ ] **Step 2: Implement this one ordering everywhere.** Freeze new admission → drain existing complete requests/turns → synchronously invalidate M2 broker cache → stop official families → seal a fresh registry snapshot → journal/move → atomically publish → cleanup/open → restart. **Do not invalidate at freeze:** already-admitted M2 streams/401 retry continue on their pinned source until drain. An unrelated actual source exit still invalidates its sourceRevision immediately by M2's existing contract.

```ts
export async function rotateAccount(d: RotationDeps, to: string, reason: SwitchReason, signal: AbortSignal): Promise<void> {
  const initial = d.ledger.state()
  if (initial.phase !== 'open') throw new Error('Account switch owned; recover or await its owner')
  if (initial.active === to) return
  const owner = d.owner()
  const frozen = d.ledger.freeze(owner, to, reason) // owner+intent+current registry validation in one transaction
  let published = false
  try {
    await d.waitForQuiet(owner, signal)
    d.invalidate(frozen.generation + 1)
    await d.stopParticipants(owner)
    d.ledger.phase(owner, 'draining', 'stopped')
    const sealed = sealTransition(d.paths, owner, to) // fresh post-drain metadata revision + inventory
    let journal = beginJournal(d.paths, sealed)
    journal = applyJournal(d.paths, journal)
    const after = publishTransition(d.paths, owner, journal) // atomic registry+gate+permit revocation+event
    published = true
    finishTransition(d.paths, owner) // cleanup graph, projection, journal unlink, open
    await d.restartParticipants(after.generation)
  } catch (error) {
    if (d.ledger.state().phase !== 'open') await recoverAccounts(d.paths, owner)
    if (published || d.ledger.state().generation !== frozen.generation) {
      // State is committed. Restart failure is degraded on the new account;
      // a rollback requires another fully drained transition.
      throw new Error('Account transition committed; managed restart or cleanup requires recovery', { cause: error })
    }
    d.invalidate(d.ledger.state().generation)
    await d.restartParticipants(d.ledger.state().generation)
    throw error
  }
}
```

`sealTransition` checks no work/family rows remain and validates the fresh registry revision before changing phase to sealed. While draining, a finishing probe may publish identity/limits and the operator may disable rotation or edit unrelated account labels; preserve them. If reason is automatic and rotation is now disabled, cancel safely before sealing; manual use remains authorized. If source/target login/identity changed, revalidate rather than applying the earlier choice. After seal, settings and observations receive busy/refused until completion; no stale pre-drain whole-document replacement exists. Publish mutates only active/generation in the revisioned registry and retains the final sealed settings/identity state.

`waitForQuiet` includes pending starts, running turns, approvals, native subagents, compaction/review/realtime and whole translator streams. Intermediate willRetry errors do not end work. Start RPC failure releases pending admission; terminal completion/confirmed interruption releases once. Unknown active state stays busy after default 60 seconds. Cancellation before moving reopens the proven unchanged state; after a pending auth operation exists, settle/recover the durable transaction first. Never force-interrupt unrelated user work to switch.

Manual use works with automatic rotation off. Rotate off cancels queued automatic work before seal but does not change chosen account. Full off/M3 rollback explicitly return home. All exhausted hands the original vendor failure to existing reserve behavior: no credit use, no cross-vendor model call, no cycle through unknown candidates. Event `account.rotated` is a metadata table row unique on transaction/generation, committed with publication; output/log projection cannot cause duplicates on recovery.

- [ ] **Step 3: Run deterministic independent-process overlaps.** App turn+remote turn+translator stream drain on old account; late web start fails admission; parked refresh retains its exclusive account lease; every model call uses the one committed active account. Crash at every no-journal/forward/reverse/cleanup checkpoint invokes Task 4 public recovery. Also cancellation during drain, missing target credential, child-stop failure, registry mutation during drain, settings attempted after seal, restart failure after commit and all exhausted. Source/cache revisions remain independent of account generation. No registry/limit update is lost across process restart.

- [ ] **Step 4: Run focused tests and commit.** `git commit -m "feat: rotate at safe boundaries with fresh transactional metadata"`.

## Task 8: Wire all managed surfaces, raw observations and pinned desktop identity

**Files:** Create `src/accounts-adapter.mts`, `src/accounts-identity.mts`, `test/accounts-adapter.test.mts`, `test/accounts-identity.test.mts`; modify `src/codex-upstream.mts`, `src/codex-mux.mts`, `src/adapter.mts`, M2 `broker-owner.mts`, `broker-source.mts`, `claude-gpt.mts`; tap `anyengine-proxy.mts`/the actual PTY event decoder for Claude observations.

**Consumes:** Task 3 AccountAdmission; Task 7 rotation; M2 broker generation and `stopSources`; existing upstream raw `request` and downstream `forwardRequest` distinction. **Produces:** managed startup and exact helper contract:

```ts
export interface HomeIdentity {
  accountRead: { account: { type: 'chatgpt'; email: string; planType: string } | null; requiresOpenaiAuth: boolean }
  authMethod: string | null
  planType: string | null
}
export interface ManagedAdapter {
  admission: AccountAdmission
  generation(): number
  childHome(): string
  observeRaw(method: string, params: unknown, generation: number): void
  stop(): Promise<void>
}
export function desktopIdentity(method: string, home: HomeIdentity): unknown {
  if (method === 'account/read') return home.accountRead
  if (method === 'account/updated') return { authMode: home.authMethod, planType: home.planType }
  if (method === 'getAuthStatus') return {
    authMethod: home.authMethod, authToken: null, requiresOpenaiAuth: home.accountRead.requiresOpenaiAuth,
  }
  throw new Error('Not an identity method')
}
```

- [ ] **Step 1: Write downstream/internal distinction tests.**

```ts
test('desktop identity is home while internal broker auth remains active', () => {
  const home: HomeIdentity = { accountRead: { account: {
    type: 'chatgpt', email: 'home@example.invalid', planType: 'pro',
  }, requiresOpenaiAuth: true }, authMethod: 'chatgpt', planType: 'pro' }
  assert.deepEqual(desktopIdentity('account/read', home), home.accountRead)
  assert.equal((desktopIdentity('getAuthStatus', home) as { authToken: unknown }).authToken, null)
  assert.deepEqual(desktopIdentity('account/updated', home), { authMode: 'chatgpt', planType: 'pro' })
})
```

Integration fake backend returns B account and `FAKE_ACTIVE_BEARER`; M2 private broker sees B's bearer through raw `upstream.request`, downstream app sees home email/plan and no bearer. Raw limits cache records B's real 100%/reached state before `stripReserveMarkers`; the app's masked payload must not overwrite the cache. `getAuthStatus` desktop requests with `includeToken:true` still never receive the managed B token. Preserve the installed fixture's legacy auth method spelling, not an assumed new enum.

- [ ] **Step 2: Add the seam without ballooning upstream/mux.** Extend `CodexUpstreamOptions` with `onRawMessage?: (method:string, params:unknown)=>void`, `mapDownstreamResult?: (method:string,result:unknown)=>unknown`, and `processLifecycle?: ManagedChildLifecycle`. `ManagedChildLifecycle` defines `spawn(options):Promise<ManagedChild>` and `stop(child):Promise<void>` and delegates to Task 3 supervised families. Observe raw notifications before reserve transformation; observe raw successful response values for both internal reads and forwarded reads before transformation. Existing behavior remains default when no account manager is configured. Recreate `CodexUpstream` on generation change; do not call `start()` on an instance whose `stop()` permanently set `stopping=true`.

Mux acquires work admission before forwarding `turn/start`, manual compact/review/start and any other schema-supported operation that can start model work; steering inherits the ongoing turn lease. Observe native subagent turns and retain parent work until all owned native children finish; lineage from M1 remains authoritative. Release pending start on RPC failure, promote to turn lease on started, finish on terminal completion. The wrapper's family lease separately protects refresh even when no turn is active. Loss of control socket prevents new work until the ledger is reopened and generation verified.

All managed children receive `CODEX_HOME=p.overlay`; external terminal Codex continues canonical home. M1 native remote CLI and codex-web must enter the same adapter registration path, not create an independent account flag. M2 `ActiveAccount` callback returns `{home:p.overlay,generation:ledger.state().generation}`. Catalog snapshot and bearer are resolved only after request admission and both match generation/source ID/sourceRevision/cacheRevision; same-account Codex respawn invalidates source revision without pretending the account rotated. Freeze admission, await whole translator admissions draining, synchronously invalidate broker, then call `stopSources`, and reject a bearer result tagged with an older source/generation even if its RPC resolves later. Parked reads never register as broker sources. Home account refresh owns the canonical symlink target; fixture official refresh must leave overlay auth as a symlink and update only canonical auth. If the installed official CLI replaces that symlink rather than following it, fail the overlay gate before live; do not silently copy the resulting auth chain.

Home identity is acquired once from an official `account/read` while home is active, then refreshed through the same permitted metadata-only home probe when home is parked. Store only allowed identity fields. In a missing-home-login state, expose the home unauthenticated status and a local needs-login warning; never substitute B's identity. Suppress backend B `account/updated` and emit the pinned home update only when the home metadata changes. Existing reserve's synthetic externally-authenticated compatibility response is allowed only in its existing exhausted-reserve path; its underlying pinned identity remains home and never becomes B. Live acceptance must prove Remote pairing and Send behavior across that transition; record any synthetic reserve identity exception explicitly.

Claude events are tapped at the existing PTY stream/proxy boundary, decoded only when the actual `rate_limit_event` shape is present, and passed to `observeClaude`. Do not synthesize SDK events from screen text and claim measured utilization. If that runtime does not emit an event for a real turn, the Claude row remains “not observed”; capture the actual runtime event path in the fixture before claiming limits support. Passthrough response headers in M2 remain byte-faithful.

- [ ] **Step 3: Run fake multi-surface integration.** App A, web B and remote C share generation and active model account; broker source registration cannot bypass admission; restart all surfaces on generation advance; assert lazy thread resume on the next turn. Late limits callbacks are rejected by their original epoch/source permit without resetting retained account observations; old-generation auth and protocol notifications are discarded. Test unrecognized operation/model-start paths fail closed during freeze. Feed a Claude `seven_day_opus` event followed by five_hour and assert both survive in the row.

- [ ] **Step 4: Run upstream, mux, broker and new integration suites; commit.** `git commit -m "feat: integrate account generations across managed surfaces"`.

## Task 9: Resume threads and safely rehome rejected encrypted history

**Files:** Create `src/accounts-continuity.mts`, `test/accounts-continuity.test.mts`; modify the existing mux rehome helper with a forced-fresh path and extracted helper if needed; extend fake app-server encrypted error/replay modes.

**Consumes:** existing `formatTranscript`, `transcriptEntriesFromTurns`, `injectItemsFor`, `rewriteThreadIds`, persisted `ThreadEngineRecord` alias map, existing posture conversion. **Produces:** continuity state machine below plus mux integration.

```ts
export interface ResumeState {
  generation: number
  resumed: boolean
  rehomed: boolean
  outputSeen: boolean
  toolSeen: boolean
  completedTurn: boolean
}
export function encryptedFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: unknown; message?: unknown; additionalDetails?: unknown }
  if (e.code === 'invalid_encrypted_content') return true
  return [e.message, e.additionalDetails].some(value =>
    typeof value === 'string' && /\binvalid_encrypted_content\b/.test(value))
}
export function mayRehome(s: ResumeState, error: unknown): boolean {
  return !s.rehomed && !s.outputSeen && !s.toolSeen && !s.completedTurn && encryptedFailure(error)
}
export const CONTINUE_PROMPT = 'The previous turn stopped at a usage limit; continue from where you left off.'
export function mayReplay(mode: 'none' | 'continue-prompt', failed: boolean,
  rotated: boolean, replayed: boolean, connected: boolean): boolean {
  return mode === 'continue-prompt' && failed && rotated && !replayed && connected
}
```

- [ ] **Step 1: Add exact safety tests.**

```ts
test('encrypted fallback is once only and never repeats visible output or tools', () => {
  const s: ResumeState = { generation: 2, resumed: true, rehomed: false,
    outputSeen: false, toolSeen: false, completedTurn: false }
  const error = { code: 'invalid_encrypted_content' }
  assert.equal(mayRehome(s, error), true)
  assert.equal(mayRehome({ ...s, rehomed: true }, error), false)
  assert.equal(mayRehome({ ...s, outputSeen: true }, error), false)
  assert.equal(mayRehome({ ...s, toolSeen: true }, error), false)
  assert.equal(mayRehome(s, { code: 'badRequest', message: 'Other validation failed' }), false)
  assert.equal(mayReplay('none', true, true, false, true), false)
  assert.equal(mayReplay('continue-prompt', true, true, false, true), true)
  assert.equal(mayReplay('continue-prompt', true, true, true, true), false)
})
```

- [ ] **Step 2: Implement per-thread generation and lazy resume.** After a global switch the existing desktop ID still aliases its previous upstream thread. Before its next model operation, acquire admission, send `thread/resume` with stored upstream ID, exact model/posture/cwd from the prior thread, and mark resumed only on success. Do not resume every thread eagerly. Preserve session title/order and list deduplication through the existing alias store. Posture comes from the existing `UpstreamThreadInfo`/local posture, never defaults to a looser setting.

For the first resume or first failed turn of the new generation, intercept exact encrypted-content rejection before emitting a terminal failure. Rehome through a fresh `thread/start` on the same GPT model; force bypass of the normal `knownUpstreamId` resume branch. Build plaintext only from user/assistant messages through the existing bounded transcript formatter. Exclude encrypted reasoning, compaction blobs, tool credentials and raw trace bodies. Use `thread/inject_items` when supported; otherwise prefix that first user turn. Persist the new upstream alias before replaying the pending input, rewriting thread IDs in every resulting response/notification. Do not duplicate already-carried plaintext. Set `rehomed=true` durably for `(desktopThreadId,generation)` before retry. A repeated failure surfaces normally and never loops.

Track any streamed assistant output, tool request/item, approval or successful tool effect from the attempted turn. Such a turn is ineligible for automatic retry; report the original error and preserve state for the next explicit user message. If a first-turn input includes a file/image attachment that cannot be preserved by the protocol's original input items, fail visibly rather than dropping it. Rehome transcript is bounded, and original current input items are retained byte-for-byte where the protocol permits.

Opt-in usage-limit replay creates a new adapter-visible turn with `CONTINUE_PROMPT`, after the failed turn's terminal event and successful rotation. It does not resend the original tool-producing prompt, alter a vendor request already in flight, or replay a translator HTTP request after output. Hold a fresh admission lease; preserve model/posture; expose normal turn/started/item/turn/completed messages. One replay per failed turn ID, persisted before scheduling. If the client disconnected or another user turn already started, cancel replay. Default mode remains `none`. A translator quota failure schedules a global account change for the next request and returns the original error; Claude's own next request determines continuation.

- [ ] **Step 3: Exercise end-to-end fake protocol cases.** Force B→C mid-thread, `thread/resume` success and remembered plaintext; reject resume with encrypted-content then verify new thread, retained desktop alias and one successful answer; reject first turn after resume then same fallback; emit a tool before encrypted rejection and assert zero automatic resend; repeated rejection returns one failure; replay off produces no unsolicited turn; replay on renders one continue turn and never doubles on duplicate notifications. Include an image input, compaction history, process restart, new user turn racing queued replay and disconnected peer.

- [ ] **Step 4: Run continuity/mux/rehome suites and commit.** `git commit -m "feat: preserve thread continuity across account rotation"`.

## Task 10: Ship controls and an executable M3-only M2-baseline rollback

**Files:** Create `src/control-accounts.mts`, `control-limits.mts`, `accounts-rollback.mts`, `control-m3-rollback.mts`, `accounts-recovery-script.mts`, `accounts-recovery-jxa.mts`, `scripts/prove-accounts-rollback.mjs`; modify completed M1/M2 install/layer/flip/rollback dispatch and pruning; control docs/tests. Generated recovery scripts live in the private install root, not source/test fixtures containing personal paths.

**Consumes:** M1 control/System/LayerWriter contracts; M2 Task 6 stable-recovery and immutable-baseline pattern; account recovery/metadata authority. **Produces:** CLI grammar and concrete upgrade contracts below. Preserve M2's existing M1 baseline; M3 takes a separate immediate **verified M2** snapshot.

| Command | Exact behavior |
|---|---|
| `accounts add <id> [--label <text>]` | Validate fixed slot path, acquire exclusive login family, run official device login, then official metadata identity read; no credential parse/copy. Duplicate/mismatched identity is quarantined without deleting its unique auth file. |
| `accounts add <id> --existing` | Metadata-register an already logged-in fixed slot under exclusive probe admission. No arbitrary auth-file argument. |
| `accounts list [--json]` | Ordered metadata only; no implicit probe. |
| `accounts use <id> [--wait-quiet <seconds>] [--dry-run]` | Manual safe switch; default 60-second quiet timeout; exits 0 success/no-op, 2 invalid/conflict, 3 busy. Dry-run path/stat only, no freeze, stop, reservation or write. |
| `accounts rotate on\|off` | Serialized settings mutation; no implicit manual switch. During drain may disable queued automatic choice; after seal returns busy. |
| `accounts recover [--dry-run]` | One recovery entrypoint for frozen owner with or without journal and every forward/reverse/cleanup phase. Dry-run performs no adoption/mutation. |
| `accounts backup --metadata-only` | Transactionally read registry/config/state references, exact credential lstat inventory, overlay manifest and M2 baseline ID; produce private immutable backup ID and stable recovery command; no auth/session bytes or recursive account-directory copy. |
| `limits [--json] [--refresh]` | All OpenAI accounts plus honest Claude row; active passive cache and optional throttled exclusive parked reads. |
| `rollback m3 [--no-restart]` | While M3-aware dispatcher exists, hand off to stable M3 recovery command; restore verified immediate M2 only. |
| `anyengine-off --m3-only [--no-restart]` | Same target without Node; exec stable dispatcher before restoring installed scripts. Mutually exclusive with --m2-only/--router-only. |
| `status` / `doctor` | Generation, account, policies, gate owner/phase, holder/work counts, projection revisions, stale limits and overlay/process conflicts; no credentials. |
| full `off` / `off --router-only` | First complete safe M3 home restoration, then the existing broader M2/M1 undo. They are never an automatic fallback for failed M3-only rollback. |

```ts
export interface M3Baseline {
  version: 1
  id: string
  priorLib: string
  priorLayersPath: string
  priorLayersSha256: string
  m2Records: Array<{ path: string; backup: string; sha256: string; mode: number; link: string | null }>
  controlChanges: FileChange[]
  jobs: Array<{ label: string; plist: string; backup: string; loaded: boolean }>
  recoveryScript: string
  recoveryJournal: string
  phase: 'prepared' | 'activating' | 'active' | 'rolling-back' | 'rolled-back' | 'conflict'
}
export interface M3RecoveryJournal {
  version: 1; baselineId: string; transaction: string
  phase: 'prepared' | 'home' | 'overlay-detached' | 'marker-detached' |
    'controls' | 'layers' | 'jobs' | 'verified' | 'conflict'
  sharedMarkerDetached: boolean
  completedChanges: string[]
  pendingChange: string | null
  conflicts: string[]
}
export interface M3RollbackResult { ok: boolean; restoredLib: string | null; m2Verified: boolean; conflicts: string[] }
export function prepareM3Upgrade(system: System, root: string, plan: OnPlan): M3Baseline
export function readM3Baseline(root: string): M3Baseline | null
export function retainedM3Libraries(root: string): string[]
export function rollbackM3(system: System, root: string, options: { noRestart: boolean }): Promise<M3RollbackResult>
export function m3RollbackScript(baseline: M3Baseline, options: { root: string; app: string; bundleId: string }): string
```

- [ ] **Step 1: Write baseline/retention tests before implementation.**

```ts
test('M3 captures the immediate M2 baseline once, preserving M2-to-M1 evidence', async () => {
  const fx = await installedM2Fixture()
  const originalM2Records = fx.snapshotM2Records()
  const baseline = prepareM3Upgrade(fx.system, fx.root, fx.m3Plan)
  assert.equal(baseline.priorLib, fx.m2Lib)
  assert.ok(retainedM3Libraries(fx.root).includes(fx.m2Lib))
  await fx.activateM3()
  const again = prepareM3Upgrade(fx.system, fx.root, fx.m3Plan)
  assert.equal(again.id, baseline.id)
  await fx.prune()
  assert.equal(existsSync(fx.m2Lib), true)
  assert.deepEqual(fx.snapshotM2Records(), originalM2Records)
})
```

`installedM2Fixture` constructs distinct M1/M2/M3 lib trees, original M2 launcher/dispatcher bytes, router/smoke job states, M2 layer records and its M1 backup/recovery namespace. Its restored M2 dispatcher rejects unknown M3 options; it must not be an M3-aware fake. Snapshot sorted path/hash/mode/symlink records, excluding runtime logs and separate new recovery evidence. Credential fixtures remain fake single-inode markers.

- [ ] **Step 2: Capture/pin immutable M2 before any staging, prune or control mutation.** Require M2 library/manifest/router/Claude-code face preflight. Under the existing install control lock, create a unique private M3 baseline directory, record current immutable lib target and exact pre-M3 layer bytes, and preserve M2's own M1 baseline pointer, layer/backup/script bytes unchanged. Snapshot each M3-touched control target immediately before its first change: lib/current, installed launchers/shims/runtime env, rollback scripts, plists and M3-specific config. M2 unchanged files are recorded for verification, not rewritten unnecessarily. Use write-ahead before/after hashes and semantic owned fields for each delta; registry backup comes from the serialized metadata transaction, never a stale projection.

Persist/fsync `m3-upgrade.json`, versioned recovery script, private recovery journal and stable pointer **before** allowing installer staging/pruning to run. `retainedM3Libraries` pins prior M2 for prepared/activating/active/rolling-back/conflict, in addition to all M1/M2/current/running pins. Parse/verification failure disables pruning instead of guessing. Repeated on/update reuses an active/pending M3 baseline, never captures M3 as its own M2 baseline. A later new M3 installation after terminal rollback may create a new baseline; old evidence remains.

- [ ] **Step 3: Generate the surviving node-free recovery entrypoint and discovery record.**

`<root>/recovery/m3/recover.sh` (0700) is outside lib/bin, every controlChanges restore set, layer cleanup and pruning. `<root>/recovery/m3/current.json` (0600) contains absolute `script`, `journal`, `baselineId`, `scriptSha256`. Versioned script/journal live below `<root>/recovery/m3/<id>/`. Dispatcher validates same-owner, no symlink, permitted recovery-root path and hash before exec. It uses system bash/JXA/stat/shasum/sqlite3/ps/launchctl only, never lib/current, installed anyengine, installed anyengine-off or Node. Retain dispatcher, pointer, versioned script and terminal journal after success; `RECOVER.txt` stores the exact absolute command/baseline/journal before activation and failure output prints it.

Public resume/repeat after installed commands revert to M2:

```sh
/bin/bash "$HOME/.anyengine/recovery/m3/recover.sh"
```

Custom roots print the actual properly quoted absolute command. Unmodified M2 does **not** understand M3 rollback options or phases. Initial M3-aware `rollback m3`/`anyengine-off --m3-only` exec the stable dispatcher; after a killed restore, use the direct stable command. No new daemon/schedule or automatic old-M2 behavior is promised.

Generated script includes the exact Task 4 transition inventory/cursor protocol using system JXA for JSON and `/usr/bin/sqlite3` for the same metadata transactions and owner fencing. It is not a second recovery algorithm: test the same forward/reverse/cleanup fixtures through both Node and this script. JXA projection/durable-journal writes fsync their file and parent directory; use Foundation atomic write plus POSIX fsync bindings (argv filenames, never source interpolation):

```js
ObjC.import('Foundation')
ObjC.bindFunction('open', ['int', ['char *', 'int']])
ObjC.bindFunction('fsync', ['int', ['int']])
ObjC.bindFunction('close', ['int', ['int']])
function syncPath(path) {
  const fd = $.open(path, 0)
  if (fd < 0) throw Error('Cannot open durable path')
  try { if ($.fsync(fd) !== 0) throw Error('Cannot sync durable path') }
  finally { $.close(fd) }
}
function durableJsonFile(path, value) {
  const data = $(JSON.stringify(value) + '\n').dataUsingEncoding($.NSUTF8StringEncoding)
  if (!data.writeToFileAtomically(path, true)) throw Error('Cannot write recovery state')
  const permissions = $.NSDictionary.dictionaryWithObjectForKey($(384), $.NSFilePosixPermissions)
  if (!$.NSFileManager.defaultManager.setAttributesOfItemAtPathError(permissions, path, null))
    throw Error('Cannot protect recovery state')
  syncPath(path)
  syncPath(ObjC.unwrap($(path).stringByDeletingLastPathComponent))
}
```

The script validates the system tools in its scratch proof before installation. SQLite string values are bound through validated hex `CAST(X'<hex UTF-8>' AS TEXT)` generated by the static JXA helper, never interpolated from labels/paths into SQL. Use BEGIN IMMEDIATE and check owner claim/revision/expected phase in each mutation. A child process identity is proven using recorded supervisor/native group identities and system process metadata; unknown/reused identity refuses without signaling/deleting its holder. Missing/broken sqlite3/JXA is a recovery failure with preserved files and the exact public command, not permission to do a blind mv. No auth value is read by either recovery implementation.

- [ ] **Step 4: Implement this M3-only recovery sequence, checkpointed in its private journal.**

1. Acquire the existing install control lock and the account transition owner; freeze/drain managed turns/probes/login, recover any existing interrupted account transition via Task 4, disable automatic rotation through serialized metadata while allowed, then perform a normal journaled return to home. The account journal's forward/reverse progress remains separate from the upgrade journal. Record phase home only after the home symlink, unique parked credentials, zero old-generation families and metadata agree. A repeat of this phase verifies or resumes; never restores credential backups.
2. Stop remaining M3 official families, remove only M3 overlay routing/config deltas, and preserve canonical sessions/config plus every parked credential. Reconcile attributable non-auth overlay entries only through Task 2's collision safeguards. Semantic settings restore preserves later unrelated edits. If a retained setting still requires M3 or a credential/metadata conflict exists, keep functioning M3 lib/router and pins; return conflict without downgrading. Record overlay-detached.
3. Before touching the M2 library/dispatcher, under the control lock write phase marker-detached and `sharedMarkerDetached:true` to the **private** M3 recovery journal, disable shared FlipMarker writes, and remove only this operation's matching shared marker. A different marker is a conflict. Signal/finally handlers thereafter write only the private journal. No M3 phase/failureTarget reaches an old M2 parser. Re-entry at marker-detached still removes a matching marker if it remains: the durable flag disables writers before deletion, it is not proof deletion already happened. Persist any active account-gate terminal cleanup before restoring M2; old M2 never consumes a frozen M3 ledger.
4. Restore immediate pre-M3 control delta and lib/current to baseline.priorLib with before/after/hash/semantic checks. Every restore has pendingChange written before mutation and completedChanges after durable result; compare actual current/before/after state to settle a killed pending restore. Never call broad off or M2's M1 rollback to implement this target. Record controls. Restore pre-M3 layer/control records only when they match the expected M3 delta, preserve M2 original M1 records byte-for-byte, record layers. M3 immutable evidence remains outside the restored paths.
5. Restore prior router/smoke job loaded state/plists and restart onto verified M2 when originally loaded; record bootout/bootstrap phases separately when necessary. Initially unloaded jobs stay unloaded. Apply existing authorized idle-safe app restart only when required. Keep recovery pointer/journal/script usable if killed here.
6. Verify M2 manifest/lib link/router/Claude-code face, control/layer/job state, home identity path and unique parked credential locations. Mark verified/rolled-back and retire M3 active layer/upgrade records while retaining terminal recovery evidence; prior M2 lib is now protected by current pin. Repeating the stable command re-verifies and makes no changes. If another explicit install has superseded the terminal baseline, report superseded and do not mutate it.

While M3-aware install/flip code is active, set `failureTarget:'m3'` and stable recovery command before activation. Failed activation/postflight/signals hand off to that target automatically. After marker-detachment and old-M2 bootstrap restoration, only the surviving runner or explicitly invoked stable command continues; do not claim old M2 automatically resumes it. On conflict retain journal, M3/M2 pins, unique credentials and command output. Full/router-only off remains a separate explicit broader action.

An M2-only rollback dispatched while M3 is present first invokes and verifies this M3 stable boundary. Only afterward may the surviving M2-aware entrypoint invoke **M2's own separate** recovery dispatcher toward M1. Never repoint `recovery/m2/current.json` at an M3 script, overwrite M2's M1 baseline, or remove either namespace during broad cleanup.

- [ ] **Step 5: Prove normal/no-Node rollback and public crash re-entry.**

```ts
for (const point of ['home-returned', 'overlay-detached', 'marker-detached',
  'library-restored', 'dispatcher-restored', 'layers-restored', 'job-bootout', 'job-restored']) {
  test(`stable M3 recovery resumes after ${point}`, async () => {
    const fx = await installedM2Fixture()
    const baseline = fx.snapshotM2Records()
    await fx.activateM3()
    await fx.use('b')
    await fx.prune()
    await fx.killRollbackAt(point, { node: false })
    const result = await fx.exec('/bin/bash', [join(fx.root, 'recovery/m3/recover.sh')], { PATH: '/usr/bin:/bin' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(realpathSync(join(fx.root, 'lib/current')), fx.m2Lib)
    assert.deepEqual(fx.snapshotM2Records(), baseline)
    assert.deepEqual(fx.jobs(), fx.originalJobs)
    assert.equal(fx.sharedMarkerContains('m3'), false)
    assert.deepEqual(fx.credentialCounts(), { home: 1, b: 1, c: 1 })
    const again = await fx.exec('/bin/bash', [join(fx.root, 'recovery/m3/recover.sh')], { PATH: '/usr/bin:/bin' })
    assert.equal(again.status, 0, again.stderr)
    assert.deepEqual(fx.snapshotM2Records(), baseline)
  })
}
```

Run initial dispatch both normal rollbackM3 and installed anyengine-off --m3-only with Node absent/broken. After dispatcher restoration the test must invoke the actual stable public command and prove restored M2 rejects M3-only flags. Add kill during account inverse recovery, after registry restoration, around marker detach and after journal cleanup before reopen. Add repeated on/prune, unrelated settings edits, conflicting M3-owned edit, initially unloaded job, superseded terminal baseline and M2-only rollback crossing M3 boundary. M2-to-M1 record snapshot must remain unchanged throughout M3-only rollback, and M2 functionality/config/jobs verified. No fixture may pass by leaving a frozen gate or only preserving credentials without completing supported recovery.

- [ ] **Step 6: Run doctor/control/fake rollback proof and commit.** `scripts/prove-accounts-rollback.mjs --root <private-proof-root>` uses fresh fake homes, not a clone of live directories. Include gate-owner/no-journal kills, every forward/reverse crash, metadata writer races and both public recovery entrypoints. Output booleans/fake IDs only. Doctor checks outside canonical processes without killing them, projection revision drift, owner/claim, source state and supported schema. `git commit -m "feat: add account controls and stable M3-only M2 recovery"`.

## Task 11: Review, prove rollback, install and complete M3 acceptance

**Files:** Create `scripts/acceptance-accounts.mjs`, `test/accounts-acceptance.test.mts`, `docs/evidence/m3-accounts-limits.md`; update `docs/evidence/v1-progress.md`, `docs/STATUS.md`, `CHANGELOG.md` only after actual results.

**Consumes:** all preceding tasks, completed M1/M2 smoke and control scripts. **Produces:** independently reviewed main commits, a verified live M3 or an explicit unpassed acceptance gate with rollback evidence.

- [ ] **Step 1: Run the complete non-live gate once on the final implementation.**

```bash
npm run check:fix
npm run typecheck
npm run check
npm test
npm run docs:build
```

Preserve existing quality ratchets. New modules stay ≤500 lines; split `accounts-ledger` process recovery/IPC and normalizers by responsibility. Inspect `git diff --check`, diff for accidental credentials/personal paths, and `git status --short`. Commit only task-owned files. No generated state or scratch artifacts in git. Request fresh independent review of material account/refresh ownership, crash recovery, sparse limits, identity pin, replay and rollback, providing these exact test results and the final diff. Fix concrete defects and rerun affected checks. Do not ask a reviewer to invent findings.

- [ ] **Step 2: Run the zero-spend installed-binary contract gate on the exact binary/library to install.**

```bash
node scripts/capture-accounts-contract.mjs --out .anyengine/m3-proof/contract.json
node scripts/prove-accounts-rollback.mjs --root .anyengine/m3-proof/fake-rollback
```

The contract script enforces isolated fake homes and loopback-only networking before starting Codex. Record binary version/hash, schema fixture hash, fake refresh symlink preservation, config/cache sharing, canonical SQLite sidecars, thread start/resume with no turn, and zero model endpoint requests. A version change requires a new fixture and tests before acceptance. Prove inode single-location and canonical untouched across home→B, B→C, B→home, every pre-journal/forward/reverse/cleanup crash checkpoint and a second crash during recovery. Run normal and Node-free M3→M2 rollback through the stable public entrypoint after restoring the old dispatcher; verify prune/repeated-on retention, unchanged M2→M1 records and unrelated settings preservation. Repeated proof must not read live credentials or copy live account directories.

- [ ] **Step 3: Prepare the live metadata backup and read-only dry run.** The following commands are execution instructions, not actions taken during planning:

```bash
~/.anyengine/bin/anyengine status
~/.anyengine/bin/anyengine doctor
~/.anyengine/bin/anyengine accounts list --json
~/.anyengine/bin/anyengine accounts backup --metadata-only
~/.anyengine/bin/anyengine accounts use home --dry-run
~/.anyengine/bin/anyengine accounts recover --dry-run
```

The Task 10 `accounts backup --metadata-only` command returns a private backup ID and the exact stable M3 recovery command; verify its recorded M2 baseline and excluded credential/session paths. If a different home ID is already configured, read it from registry and use that ID instead of the example `home`. Home, selected target and active login identities must be verified through official account metadata reads; use already registered slots and do not script a new vendor sign-in. Missing second usable account is an acceptance prerequisite failure; never manufacture one from copied auth.

Dry-run must list source/destination paths, source inode/device, active work/holder count, generation, intended drain/restart, and selected target. It must not stop a child, freeze admission, mutate registry/cache, reserve a probe, change file mtime, or read auth bytes. Compare filesystem metadata before/after. Inspect outside canonical Codex processes and report scoped simultaneous usage; do not stop operator-owned processes outside AnyEngine.

- [ ] **Step 4: Install the reviewed library through the completed control flow and retain M2 rollback.** Use M1's staged `on --lib <verified-lib-id> --yes --auto-rollback` flow; copy only the verified build/dependencies through its normal installer. Register an M3 layer after M2. `anyengine rollback m3` restores home through the account journal, disables rotation, removes overlay routing and returns to the verified M2 library/config while preserving parked credential slots. It uses a new fully drained transition if M3 already published a new generation. An M2 rollback requested with M3 present first rolls M3 back safely, then executes M2's baseline restore. Do not restore an M1/M2 library while it can leave M3 credential holders untracked.

The automatic rollback triggers on failed overlay verification, missing home identity, stuck holder/unknown process family, inability to resume a fixture thread, or new router/broker regression. Model spending remains limited to the acceptance prompts below. Do not change accounts during another active user turn; a quiet timeout returns busy and retains the previously working state.

- [ ] **Step 5: Verify forced account rotation mid-thread with real app state.** Use the official app/browser skill at execution time. Create a small scratch repo with two trivial files and a thread: “Remember the marker ORCHID-29; reply OK.” Follow with a small arithmetic request to include reasoning history. With automatic replay off, switch to a second already registered usable account through `accounts use <id>` while the app thread is idle; verify home desktop identity/pairing remains stable and backend account fingerprint changes through official metadata only. Next user message “What marker did I ask you to remember?” must answer `ORCHID-29` in the same desktop thread, with the expected model, posture and visible history. Switch back and repeat once. Never intentionally exhaust a real account.

Prove quota-triggered rotation in the acceptance script's isolated fake-home mode: launch the normal adapter against the existing fake official app-server, which emits a `usageLimitExceeded` terminal from its fixture. No production fault-injection endpoint or capability is added. Live app manual rotation proves continuity; hermetic forced terminal proves automatic trigger/state machine. Record those as distinct evidence, not “live real quota exhaustion”. If an actual vendor quota error naturally occurs, record its redacted shape and verify the next message; it is not required to spend down the account.

- [ ] **Step 6: Verify overlap, limits and all-exhausted behavior.** Run one tiny app GPT turn and one Claude Code GPT subagent turn concurrently. Queue a switch: both must finish under the old generation, no new work starts on it after freeze, and both next requests use the new generation. A concurrent parked `limits --refresh` must not restart or stall the active app; two refresh invocations within ten minutes make at most one official metadata read per parked account. CLI lists all accounts plus the observed Claude row, correct weekly-only placement where reported, per-model windows, credits and ages. Verify actual desktop home identity before/after, and check broker sourceRevision changes on same-account child respawn without changing account generation.

All-exhausted, refresh-race, stale-limit and every kill-mid-swap case are run against fake homes, not by consuming or killing live user work. With all fake accounts exhausted, verify vendor failure and reserve path; no rotation/replay loop, no credit debit and no cross-vendor model request.

- [ ] **Step 7: Re-run the full v1 success test and rollback cycle.** On the small scratch repo ask in ChatGPT.app: “spawn 7 sub-agents, 3 on Opus, review this repo”. Verify seven children, exactly three using the Claude plan path, and all seven results in the parent; preserve M1's actual native/bridge acceptance status instead of relabeling a bridge run native. On the same parent perform the forced safe-boundary account change and verify the next message continues with context. Re-run M2's `/model` GPT entry, one GPT tool call and GPT subagent checks at PONG size. Verify Claude rate-limit headers remain intact.

Start with the M3-aware `anyengine rollback m3`; after it restores installed M2, resume/repeat only with `/bin/bash "$HOME/.anyengine/recovery/m3/recover.sh"`. Confirm M2 works, M2-to-M1 recovery records are unchanged and canonical auth remains the unique home chain; reinstall M3 via recorded lib; finally restore the user's chosen active account and opt-in settings exactly as agreed by the execution brief. Rotation stays off unless the user requested automatic rotation or the scoped acceptance explicitly enabled it. Account existence is not permission to silently enable automation after testing.

- [ ] **Step 8: Record evidence and commit on main.** Evidence contains UTC interval, app/Codex/library versions, registry generation counts with fake/public account labels only, independent review disposition, proof summary, actual acceptance results, limitations, rollback command/ID and credential single-location/stat checks. No JWT, email, account ID, real absolute path or conversation body beyond test prompts. `git commit -m "docs: record verified M3 accounts limits and rollback acceptance"`. Remove attributable scratch/proof data after evidence is saved; preserve private metadata rollback records and every unique credential file. Do not mark M3 accepted unless its required live app continuation, full success test, limits and locking evidence pass.

## Self-review and coverage map

| Requirement | Owner |
|---|---|
| Metadata-only revisioned registry; serialized merge/CAS; exclusive official device login | 1, 3, 5, 6, 10 |
| Canonical home auth symlink; shared session/state/config | 2, 8 |
| Move-only credentials, durable freeze owner/no-journal recovery, forward/reverse journal cursors | 3, 4, 10, 11 |
| One active model account across app/web/remote/translator | 3, 7, 8, 11 |
| Official refresh ownership, target probe exclusion, killed parent/native child | 3, 4, 6 |
| Turn-boundary manual/proactive/quota rotation; all exhausted | 5, 7 |
| Home identity pinned; raw internal broker distinct from desktop | 8, 11 |
| Lazy resume, encrypted fallback, opt-in bounded replay | 9 |
| Persistent per-account observations, callback epoch fencing, sticky per-scope denial and ages; Claude events | 5, 6, 8 |
| Ten-minute persistent parked read floor, no model probes | 3, 6 |
| CLI/status/doctor/off; pinned immediate M2 baseline; stable Node-free M3-only recovery | 10, 11 |
| Schema drift, full existing suite/quality gates and live success | 1, 2, 11 |

Planning verified: current generated 0.159.0-alpha.12.1 schema and SDK event shape; S4 evidence; completed-plan interfaces for M1 and M2; fake official refresh, config write, cache and SQLite sidecar behavior. No production code was edited, package installed, live account queried, real credential read or model called during planning. Live pairing, exact desktop replay presentation and full v1 multi-agent acceptance remain execution gates, not claims established by this plan.


**Scoped revision self-review (accepted seven-finding preflight):** owner identity/claim and intent survive freeze without a journal; forward and reverse pending inventories/cursors survive a second kill; bootstrap and login use tracked owner/per-account admission with model traffic closed; retained limits have no generation; callbacks carry revocable source/epoch permits; quota/spend denial evidence is independent per scope and from unknown display fields; all metadata mutations serialize against latest revision in one SQLite authority; switch snapshot is sealed after drain; M3-only recovery pins immediate M2 and survives dispatcher/job restoration without modifying M2's M1 baseline. One synchronous M2 invalidation occurs after drain and before family stop. All backup/rollback grammar is implemented in Task 10. Existing installed symlink/inode/SQLite evidence is unchanged. Independent re-review remains the parent's next gate; no implementation or live acceptance is claimed by this revision.
