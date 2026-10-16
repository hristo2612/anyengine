// The 2026-10-10 GPT outage, end to end: real token cache, owner, file source,
// catalog and settings view against a local upstream that answers a refused
// bearer exactly as chatgpt.com did (captured 2026-10-16).
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import test, { after, type TestContext } from 'node:test'
import { createTokenBroker } from '../src/broker-cache.mjs'
import { createBrokerOwner } from '../src/broker-owner.mjs'
import type { AccountAdmission, AuthStatus } from '../src/broker-types.mjs'
import { createGptCatalogs, readGptSettingsView } from '../src/claude-catalog.mjs'
import { brokerProblem } from '../src/control-status-evidence.mjs'
import { gptEntry } from './helpers/fake-backend.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const bounded = { timeout: 30_000 }
const NOW = Date.parse('2026-10-10T09:12:07.078Z')
const captured = JSON.parse(readFileSync('test/fixtures/chatgpt-401-2026-10-16.json', 'utf8')) as {
  calls: { path: string; status: number; contentType: string; body: unknown }[]
}
const found = captured.calls.find((call) => call.path === '/backend-api/codex/models')
assert.ok(found && found.status === 401)
const refusal = found

function token(name: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    exp: NOW / 1000 + 3600,
    marker: `FAKE_BEARER_${name}`,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-outage-fixture' },
  })}.${Buffer.from('unsigned').toString('base64url')}`
}
function writeLogin(home: string, access: string) {
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: token('id'),
        access_token: access,
        refresh_token: 'rt-fake-outage',
        account_id: 'acct-outage-fixture',
      },
      last_refresh: new Date(NOW).toISOString(),
    }),
    { mode: 0o600 },
  )
}

async function fixture(t: TestContext) {
  const root = realpathSync(await tempDir('bi-'))
  const home = join(root, 'codex')
  mkdirSync(home, { mode: 0o700 })
  writeLogin(home, token('A'))
  const refused = new Set([token('A')])
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    seen.push(bearer)
    if (refused.has(bearer)) {
      res.writeHead(refusal.status, { 'content-type': refusal.contentType })
      res.end(JSON.stringify(refusal.body))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ models: [gptEntry('gpt-outage', 1, { use_responses_lite: true })] }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const official: { refreshToken: boolean }[] = []
  let refresh: () => AuthStatus = () => {
    throw new Error('official refresh not expected')
  }
  const account = () => ({ home, generation: 1 })
  const owner = createBrokerOwner({
    account,
    official: {
      status: async (_home, _generation, refreshToken) => {
        official.push({ refreshToken })
        return refresh()
      },
    },
    now: () => NOW,
  })
  const events: { event: string; fields: Record<string, unknown> }[] = []
  const broker = createTokenBroker({
    account,
    owner,
    now: () => NOW,
    log: (event, fields) => events.push({ event, fields }),
  })
  const catalogs = createGptCatalogs({
    root,
    broker,
    owner,
    upstream: new URL(`http://127.0.0.1:${address.port}/backend-api/codex`),
    now: () => NOW,
  })
  const admission: AccountAdmission = {
    begin: async () => ({ generation: 1, release: async () => {} }),
  }
  t.after(() => broker.close())
  return {
    home,
    broker,
    seen,
    refused,
    official,
    events,
    view: () =>
      readGptSettingsView({ admission, broker, catalogs, signal: new AbortController().signal }),
    onRefresh: (next: typeof refresh) => {
      refresh = next
    },
  }
}

test(
  'a login another process already replaced is used on the first retry (no official refresh)',
  bounded,
  async (t) => {
    const f = await fixture(t)
    // The router read A; then the login on disk became B (10-10 10:00Z) and A was refused.
    await f.broker.get()
    writeLogin(f.home, token('B'))
    const view = await f.view()
    assert.deepEqual(
      view.models.map((model) => model.id),
      ['gpt-outage'],
    )
    assert.deepEqual(f.seen, [token('A'), token('B')])
    assert.deepEqual(f.official, [])
    assert.deepEqual(f.broker.status().rejection, {
      at: new Date(NOW).toISOString(),
      endpoint: 'models',
      open: false,
    })
    assert.deepEqual(
      f.events.map((entry) => entry.event),
      ['gpt.upstream-rejected', 'gpt.upstream-recovered'],
    )
    assert.equal(JSON.stringify(f.events).includes('FAKE_BEARER'), false)
    assert.equal(JSON.stringify(f.broker.status()).includes('FAKE_BEARER'), false)
  },
)

test(
  'a refused bearer still on disk is refreshed once by the official client',
  bounded,
  async (t) => {
    const f = await fixture(t)
    f.onRefresh(() => {
      // The real client persists the replacement (captured 0.162.0-alpha.2 contract).
      writeLogin(f.home, token('C'))
      return { authMethod: 'chatgpt', authToken: token('C'), requiresOpenaiAuth: true }
    })
    const view = await f.view()
    assert.equal(view.models.length, 1)
    assert.deepEqual(f.seen, [token('A'), token('C')])
    assert.deepEqual(f.official, [{ refreshToken: true }])
    assert.equal(f.broker.status().rejection?.open, false)
    assert.equal(
      brokerProblem({ ...f.broker.status(), rejection: f.broker.status().rejection ?? null }),
      null,
    )
  },
)

test(
  'a refresh OpenAI still refuses leaves the 401 open and named for doctor',
  bounded,
  async (t) => {
    const f = await fixture(t)
    f.refused.add(token('D'))
    f.onRefresh(() => {
      writeLogin(f.home, token('D'))
      return { authMethod: 'chatgpt', authToken: token('D'), requiresOpenaiAuth: true }
    })
    await assert.rejects(f.view(), /catalog\.rejected/)
    assert.deepEqual(f.seen, [token('A'), token('D')])
    assert.deepEqual(f.official, [{ refreshToken: true }])
    const status = f.broker.status()
    assert.equal(status.rejection?.open, true)
    assert.equal(status.rejection?.endpoint, 'models')
    const problem = brokerProblem({ ...status, rejection: status.rejection ?? null })
    assert.match(String(problem), /HTTP 401 on \/models at 2026-10-10T09:12:07\.078Z/)
    assert.match(String(problem), /codex login/)
    assert.equal(JSON.stringify(status).includes('FAKE_BEARER'), false)
  },
)
