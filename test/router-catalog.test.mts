import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { DEFAULT_CONFIG, enginePaths } from '../src/anyengine-config.mjs'
import { isProven, markDegraded, markProven, proofKey } from '../src/degraded.mjs'
import {
  CatalogCache,
  type CatalogEntry,
  catalogKey,
  isAnyEngineEntry,
  mergeCatalog,
  modelsHook,
} from '../src/router-catalog.mjs'
import { FanoutMonitor, usesV2Collaboration } from '../src/router-fanout.mjs'
import { startRouter } from '../src/router-server.mjs'
import { gptEntry, startFakeBackend } from './helpers/fake-backend.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const closers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await removeTempDirs()
})

// Shaped like the live catalog on 2026-09-30: gpt-6.1-sol leads at priority
// 1 with a notice, and every entry names the access programs it serves.
const ACCESS = { available_access_programs: { cyber: ['standard'] } }
const upstream = (): CatalogEntry[] =>
  [
    gptEntry('gpt-6.1-sol', 1, {
      ...ACCESS,
      availability_nux: { message: 'Maximize usage with GPT-6.1 Sol.' },
    }),
    gptEntry('gpt-6-astra', 2, ACCESS),
    gptEntry('gpt-reserve', 4, { ...ACCESS, visibility: 'hide', multi_agent_version: 'v1' }),
    gptEntry('gpt-6-sol', 5, ACCESS),
    gptEntry('gpt-5.5', 13, { ...ACCESS, multi_agent_version: null }),
  ] as CatalogEntry[]

const byPriority = (models: CatalogEntry[]) =>
  models
    .filter((m) => m.visibility === 'list')
    .sort((a, b) => Number(a.priority) - Number(b.priority))
    .map((m) => m.slug)

test('catalog: native path puts every Claude model just after the default, all v1', () => {
  const merged = mergeCatalog(upstream(), DEFAULT_CONFIG, 'native')
  assert.deepEqual(byPriority(merged).slice(0, 5), [
    'gpt-6.1-sol',
    'opus',
    'sonnet',
    'haiku',
    'gpt-6-astra',
  ])
  for (const m of merged) assert.notEqual(m.multi_agent_version, 'v2', m.slug)
  const opus = merged.find((m) => m.slug === 'opus')
  assert.ok(opus)
  assert.equal(opus.display_name, 'Claude Opus')
  assert.equal(opus.context_window, 200000)
  assert.equal(opus.multi_agent_version, 'v1')
  assert.ok(isAnyEngineEntry(opus))
  assert.equal(merged.find((m) => m.slug === 'gpt-5.5')?.multi_agent_version, null)
  assert.ok(!isAnyEngineEntry(merged.find((m) => m.slug === 'gpt-6-sol')))
  // Claude keeps the template's access fields and none of its GPT notice.
  assert.deepEqual(opus.available_access_programs, ACCESS.available_access_programs)
  assert.equal(opus.availability_nux, null)
})

test('catalog: the first visible entry is GPT under every access filter', () => {
  const merged = mergeCatalog(upstream(), DEFAULT_CONFIG, 'native')
  const programs = new Set<string>()
  for (const m of merged) {
    const access = (m.available_access_programs ?? {}) as Record<string, string[]>
    for (const [program, tiers] of Object.entries(access))
      for (const tier of tiers) programs.add(`${program}:${tier}`)
  }
  for (const filter of [null, ...programs]) {
    const visible = merged.filter((m) => {
      if (m.visibility !== 'list') return false
      if (filter === null) return true
      const [program, tier] = filter.split(':') as [string, string]
      const access = (m.available_access_programs ?? {}) as Record<string, string[]>
      return !(program in access) || (access[program] ?? []).includes(tier)
    })
    const first = visible.sort((a, b) => Number(a.priority) - Number(b.priority))[0]
    assert.ok(first && !isAnyEngineEntry(first), `filter ${filter}: first is ${first?.slug}`)
  }
})

test('catalog: bridge path serves the upstream catalog untouched, with no Claude', () => {
  assert.deepEqual(mergeCatalog(upstream(), DEFAULT_CONFIG, 'bridge'), upstream())
})

test('catalog: the cache is scoped by account and query, bounded, and holds no credential', async () => {
  const dir = await tempDir('anyengine-catalog-')
  const cache = new CatalogCache(join(dir, 'catalogs.json'), 3)
  for (let i = 0; i < 5; i += 1)
    cache.set(catalogKey('u', `?client_version=${i}`, 'acct'), upstream())
  const stored = JSON.parse(readFileSync(join(dir, 'catalogs.json'), 'utf8'))
  assert.equal(Object.keys(stored).length, 3)
  assert.equal(cache.get(catalogKey('u', '?client_version=0', 'acct')), null)
  assert.ok(cache.get(catalogKey('u', '?client_version=4', 'acct')))
  assert.equal(cache.get(catalogKey('u', '?client_version=4', 'other')), null)
})

const v2Body = (model: string) => ({
  model,
  input: [
    {
      type: 'additional_tools',
      tools: [
        {
          type: 'namespace',
          name: 'collaboration',
          tools: [
            {
              type: 'function',
              name: 'spawn_agent',
              parameters: { properties: { message: { type: 'string', encrypted: true } } },
            },
          ],
        },
      ],
    },
  ],
})

test('fan-out: config, catalog shape, v2 tools on a served v1 model and upstream errors each move it to the bridge', () => {
  let config = structuredClone(DEFAULT_CONFIG)
  const changes: string[] = []
  const clock = { now: Date.now() }
  const monitor = new FanoutMonitor(
    () => config,
    null,
    (s) => changes.push(s.path),
    () => clock.now,
  )
  // Past the ten minutes after a start in which v2 evidence is ignored.
  clock.now += 11 * 60_000
  assert.equal(monitor.state.path, 'native')
  config = { ...config, router: { ...config.router, multiAgentV1: false } }
  assert.equal(monitor.state.path, 'bridge')
  config = structuredClone(DEFAULT_CONFIG)
  assert.equal(monitor.state.path, 'native')
  clock.now += 11 * 60_000 // A toggle also starts a new grace window.
  assert.equal(usesV2Collaboration(v2Body('gpt-6-sol')), true)
  // Only a model this router served as v1 is evidence: another model's v2
  // tools say nothing about the rewrite.
  monitor.noteServed(['gpt-6-astra'])
  monitor.observeGptBody(v2Body('gpt-6-sol'))
  assert.equal(monitor.state.path, 'native')
  monitor.observeGptBody(v2Body('gpt-6-astra'))
  assert.equal(monitor.state.path, 'bridge')
  assert.match(monitor.state.reason, /v2 collaboration/)
  assert.deepEqual(changes, ['bridge'])
  // A config change clears the evidence.
  config = {
    ...structuredClone(DEFAULT_CONFIG),
    claude: { ...DEFAULT_CONFIG.claude, spawnPriority: ['sonnet', 'opus', 'haiku'] },
  }
  assert.equal(monitor.state.path, 'native')
  const fresh = new FanoutMonitor(() => DEFAULT_CONFIG, null)
  fresh.observeCatalog([
    { slug: 'gpt-x', priority: 1, visibility: 'list', multi_agent_version: 'v3' },
  ])
  assert.match(fresh.state.reason, /multi_agent_version/)
  const rejected = new FanoutMonitor(() => DEFAULT_CONFIG, null)
  rejected.observeUpstreamError(
    400,
    '{"error":{"message":"multi_agent_version v1 is not supported"}}',
  )
  assert.equal(rejected.state.path, 'bridge')
})

test('fan-out: for ten minutes after a start or a config change, v2 evidence is ignored (an older child may still hold the v2 catalog)', () => {
  const start = Date.now()
  const clock = { now: start }
  let config = structuredClone(DEFAULT_CONFIG)
  const monitor = new FanoutMonitor(
    () => config,
    null,
    undefined,
    () => clock.now,
  )
  monitor.noteServed(['gpt-6-astra'])
  clock.now = start + 9 * 60_000
  monitor.observeGptBody(v2Body('gpt-6-astra'))
  assert.equal(monitor.state.path, 'native', 'still inside the window after the start')
  clock.now = start + 11 * 60_000
  config = {
    ...structuredClone(DEFAULT_CONFIG),
    claude: { ...DEFAULT_CONFIG.claude, spawnPriority: ['sonnet', 'opus', 'haiku'] },
  }
  assert.equal(monitor.state.path, 'native')
  monitor.observeGptBody(v2Body('gpt-6-astra'))
  assert.equal(monitor.state.path, 'native', 'a config change opens a new window')
  clock.now = start + 22 * 60_000
  monitor.observeGptBody(v2Body('gpt-6-astra'))
  assert.equal(monitor.state.path, 'bridge')
})

test('fan-out: native only while proven for this lib, app, codex and settings; a newer proof clears the evidence', async () => {
  const root = await tempDir('anyengine-fanout-')
  const monitor = new FanoutMonitor(() => DEFAULT_CONFIG, root)
  assert.equal(monitor.state.path, 'bridge')
  assert.match(monitor.state.reason, /not proven/)
  markProven(root, 'native-fanout', 'test', { ...proofKey(root), lib: '0.1.0-other' })
  assert.equal(monitor.state.path, 'bridge', 'proven for another lib')
  markProven(root, 'native-fanout', 'test', proofKey(root))
  assert.equal(monitor.state.path, 'native')
  for (let i = 0; i < 3; i += 1) monitor.observeClaim(false)
  assert.equal(monitor.state.path, 'bridge')
  await new Promise((ok) => setTimeout(ok, 5))
  markProven(root, 'native-fanout', 'a later smoke', proofKey(root))
  assert.equal(monitor.state.path, 'native', 'a proof newer than the evidence clears it')
  markDegraded(root, 'native-fanout', 'smoke: no claim.done')
  assert.equal(
    isProven(root, 'native-fanout', proofKey(root)),
    false,
    'a degraded mark clears the proof',
  )
})

test('fan-out: consecutive unclaimed Claude turns, or a degraded native-fanout smoke, move it to the bridge', async () => {
  const unclaimed = new FanoutMonitor(() => DEFAULT_CONFIG, null)
  unclaimed.observeClaim(false)
  unclaimed.observeClaim(false)
  unclaimed.observeClaim(true)
  unclaimed.observeClaim(false)
  unclaimed.observeClaim(false)
  assert.equal(unclaimed.state.path, 'native', 'a claim in between resets the count')
  unclaimed.observeClaim(false)
  assert.equal(unclaimed.state.path, 'bridge')
  assert.match(unclaimed.state.reason, /3 Claude turns in a row/)
  const root = await tempDir('anyengine-fanout-')
  mkdirSync(enginePaths(root).state, { recursive: true })
  writeFileSync(
    join(enginePaths(root).state, 'degraded.json'),
    JSON.stringify({ paths: { 'native-fanout': { since: 'x', reason: 'smoke: no claim.done' } } }),
  )
  assert.equal(new FanoutMonitor(() => DEFAULT_CONFIG, root).state.path, 'bridge')
})

test('router /models: caller headers upstream, merged answer back, cache on outage, 503 without one', async () => {
  const root = await tempDir('anyengine-catalog-')
  const backend = await startFakeBackend()
  closers.push(() => backend.close())
  backend.models = upstream()
  markProven(root, 'native-fanout', 'test', proofKey(root))
  const fanout = new FanoutMonitor(() => DEFAULT_CONFIG, root)
  const cache = new CatalogCache(join(enginePaths(root).router, 'catalogs.json'))
  const router = await startRouter({
    root,
    port: 0,
    upstream: backend.url,
    hooks: { models: modelsHook(cache, fanout), status: () => ({ fanout: fanout.state }) },
  })
  closers.push(() => router.close(0))
  const get = (account: string, extra: Record<string, string> = {}) =>
    fetch(`${router.baseUrl}/models?client_version=0.159.0`, {
      headers: { authorization: 'Bearer secret-token', 'chatgpt-account-id': account, ...extra },
    })
  const first = await get('acct-1')
  assert.equal(first.status, 200)
  const body = (await first.json()) as { models: CatalogEntry[] }
  assert.ok(body.models.some((m) => m.slug === 'opus'))
  const seen = backend.requests.find((r) => r.path.endsWith('/models'))
  assert.equal(seen?.headers.authorization, 'Bearer secret-token')
  assert.equal(seen?.headers['if-none-match'], undefined)
  const etag = first.headers.get('etag')
  assert.ok(etag)
  assert.equal((await get('acct-1', { 'if-none-match': etag })).status, 304)
  backend.failModels = 500
  assert.equal((await get('acct-1')).status, 200)
  assert.equal((await get('acct-2')).status, 503)
  const cacheText = readFileSync(join(enginePaths(root).router, 'catalogs.json'), 'utf8')
  assert.ok(!cacheText.includes('secret-token'))
  const health = (await (await fetch(router.healthUrl)).json()) as { fanout: { path: string } }
  assert.equal(health.fanout.path, 'native')
})

test('catalog: API filtering cannot promote Claude above its template; clones use non-lite', () => {
  const list = [
    gptEntry('gpt-chat', 1, { supported_in_api: false }),
    gptEntry('gpt-api', 2),
  ] as CatalogEntry[]
  const merged = mergeCatalog(list, DEFAULT_CONFIG, 'native')
  const opus = merged.find((m) => m.slug === 'opus')
  assert.equal(opus?.supported_in_api, false)
  assert.equal(opus?.use_responses_lite, false)
  assert.equal(byPriority(merged.filter((m) => m.supported_in_api))[0], 'gpt-api')
  assert.deepEqual(
    list.map((m) => m.priority),
    [1, 2],
    'input is untouched',
  )
})

test('catalog: without a listed upstream template, do not invent a Claude default', () => {
  for (const list of [[], [gptEntry('gpt-hidden', 1, { visibility: 'hide' })]]) {
    assert.ok(
      !mergeCatalog(list as CatalogEntry[], DEFAULT_CONFIG, 'native').some((m) =>
        isAnyEngineEntry(m),
      ),
    )
  }
})

test('fan-out: a config change resets partial claim evidence and opens grace immediately', () => {
  const config = structuredClone(DEFAULT_CONFIG)
  let now = 0
  const monitor = new FanoutMonitor(
    () => config,
    null,
    undefined,
    () => now,
  )
  monitor.noteServed(['gpt-a'])
  monitor.observeClaim(false)
  monitor.observeClaim(false)
  now = 20 * 60_000
  config.claims.graceMs += 1
  assert.equal(monitor.state.path, 'native')
  monitor.observeClaim(false)
  assert.equal(monitor.state.path, 'native')
  monitor.observeGptBody(v2Body('gpt-a'))
  assert.equal(monitor.state.path, 'native')
  now += 10 * 60_000
  monitor.observeGptBody(v2Body('gpt-a'))
  assert.equal(monitor.state.path, 'bridge')
})

test('fan-out: first v2 observation after grace counts; error evidence contains no upstream content', () => {
  let now = 0
  const monitor = new FanoutMonitor(
    () => DEFAULT_CONFIG,
    null,
    undefined,
    () => now,
  )
  monitor.noteServed(['gpt-a'])
  now = 10 * 60_000
  monitor.observeGptBody(v2Body('gpt-a'))
  assert.equal(monitor.state.path, 'bridge')
  const rejected = new FanoutMonitor(() => DEFAULT_CONFIG, null)
  rejected.observeUpstreamError(400, 'multi_agent Authorization Basic secret-token')
  assert.equal(rejected.state.path, 'bridge')
  assert.ok(!rejected.state.reason.includes('secret-token'))
})

test('fan-out: a catalog with every version absent still means v1', () => {
  const monitor = new FanoutMonitor(() => DEFAULT_CONFIG, null)
  monitor.observeCatalog([{ slug: 'gpt-a', priority: 1, visibility: 'list' }])
  assert.equal(monitor.state.path, 'native')
})
