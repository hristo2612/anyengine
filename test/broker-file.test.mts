import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import type { AuthStatus } from '../src/broker-types.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const load = () => import('../src/' + 'broker-file.mjs')
// The repo's zero-spend fake login: field names come from the installed codex.
const fakeLogin = () =>
  import('../../scripts/lib/' + 'fake-chatgpt-auth.mjs') as Promise<{
    fakeJwt(payload: unknown): string
    writeFakeChatgptAuth(home: string, options?: { now?: Date }): string
  }>
const NOW = Date.parse('2026-10-16T10:00:00Z')
const HOUR = 3600

function bearer(
  fakeJwt: (payload: unknown) => string,
  name: string,
  expSeconds = NOW / 1000 + HOUR,
) {
  return fakeJwt({
    exp: expSeconds,
    marker: name,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-file-fixture' },
  })
}

// Rewrites only the access token, the way a Codex refresh or re-login replaces it.
function replaceToken(home: string, token: string) {
  const path = join(home, 'auth.json')
  const login = JSON.parse(readFileSync(path, 'utf8'))
  login.tokens.access_token = token
  writeFileSync(path, JSON.stringify(login), { mode: 0o600 })
}

async function setup() {
  const root = await tempDir('bf-')
  const home = join(root, 'codex')
  mkdirSync(home, { mode: 0o700 })
  const { fakeJwt, writeFakeChatgptAuth } = await fakeLogin()
  writeFakeChatgptAuth(home)
  const calls: { refreshToken: boolean }[] = []
  let answer: () => AuthStatus | Promise<AuthStatus> = () => {
    throw new Error('official client not expected')
  }
  const official = {
    status: async (target: string, generation: number, refreshToken: boolean) => {
      assert.equal(target, home)
      assert.equal(generation, 3)
      calls.push({ refreshToken })
      return answer()
    },
  }
  const source = (await load()).createFileAuthSource({
    home,
    generation: 3,
    official,
    now: () => NOW,
  })
  const ask = (refreshToken: boolean) =>
    source.request('getAuthStatus', { includeToken: true, refreshToken })
  return {
    root,
    home,
    source,
    ask,
    calls,
    token: (name: string, exp?: number) => bearer(fakeJwt, name, exp),
    official: (next: typeof answer) => {
      answer = next
    },
  }
}

test('the fake login has the exact key shape of the real Codex login', async () => {
  const captured = JSON.parse(
    readFileSync('test/fixtures/codex-login-shape-2026-10-16.json', 'utf8'),
  ) as { authMode: string; shape: unknown }
  const s = await setup()
  const login = JSON.parse(readFileSync(join(s.home, 'auth.json'), 'utf8'))
  const shape = (value: unknown): unknown =>
    value === null
      ? 'null'
      : typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, inner]) => [key, shape(inner)]),
          )
        : typeof value
  assert.deepEqual(shape(login), captured.shape)
  assert.equal(login.auth_mode, captured.authMode)
  const read = (await load()).readCodexLogin(s.home)
  assert.equal(read?.authMethod, 'chatgpt')
  assert.equal(read?.authToken, login.tokens.access_token)
})

test('each use reads the login again, so a replaced login is picked up without a restart', async () => {
  // 2026-10-10: another Codex process replaced ~/.codex/auth.json at 10:00Z
  // while the borrowed long-lived process kept serving the old bearer.
  const s = await setup()
  const first = await s.ask(false)
  replaceToken(s.home, s.token('replacement'))
  const second = await s.ask(false)
  assert.notEqual(first.authToken, second.authToken)
  assert.equal(second.authToken, s.token('replacement'))
  assert.deepEqual(s.calls, [])
})

test('a forced refresh takes a replacement already on disk, else asks the official client once', async () => {
  const s = await setup()
  const served = await s.ask(false)
  // Disk still holds the rejected bearer: only the official client may refresh.
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  s.official(async () => {
    await gate
    replaceToken(s.home, s.token('official'))
    return { authMethod: 'chatgpt', authToken: s.token('official'), requiresOpenaiAuth: true }
  })
  const both = Promise.all([s.ask(true), s.ask(true)])
  release()
  const [a, b] = await both
  assert.deepEqual(s.calls, [{ refreshToken: true }])
  assert.equal(a.authToken, s.token('official'))
  assert.equal(b.authToken, s.token('official'))
  assert.notEqual(a.authToken, served.authToken)
  // Another process wrote a fresh login: no second official refresh.
  replaceToken(s.home, s.token('elsewhere'))
  assert.equal((await s.ask(true)).authToken, s.token('elsewhere'))
  assert.deepEqual(s.calls, [{ refreshToken: true }])
})

test('an expiring login goes to the official client even before it was served', async () => {
  const s = await setup()
  replaceToken(s.home, s.token('expiring', NOW / 1000 + 30))
  s.official(() => ({
    authMethod: 'chatgpt',
    authToken: s.token('renewed'),
    requiresOpenaiAuth: true,
  }))
  assert.equal((await s.ask(true)).authToken, s.token('renewed'))
  assert.deepEqual(s.calls, [{ refreshToken: true }])
})

test('a missing file login defers to the official client (keyring or logged out)', async () => {
  const root = await tempDir('bf-')
  const home = join(root, 'codex')
  mkdirSync(home, { mode: 0o700 })
  const calls: boolean[] = []
  const source = (await load()).createFileAuthSource({
    home,
    generation: 1,
    official: {
      status: async (_home: string, _generation: number, refreshToken: boolean) => {
        calls.push(refreshToken)
        return { authMethod: null, authToken: null, requiresOpenaiAuth: true }
      },
    },
  })
  const status = await source.request('getAuthStatus', { includeToken: true, refreshToken: false })
  assert.equal(status.authMethod, null)
  assert.deepEqual(calls, [false])
  assert.equal(source.kind, 'file')
})

test("a managed overlay's link to the canonical login is followed", async () => {
  const s = await setup()
  const overlay = join(s.root, 'overlay')
  mkdirSync(overlay, { mode: 0o700 })
  symlinkSync(join(s.home, 'auth.json'), join(overlay, 'auth.json'))
  const read = (await load()).readCodexLogin(overlay)
  assert.equal(
    read?.authToken,
    JSON.parse(readFileSync(join(s.home, 'auth.json'), 'utf8')).tokens.access_token,
  )
})

test('unsafe, oversized or malformed logins fail closed; an API-key login is not a bearer', async () => {
  const { readCodexLogin } = await load()
  const root = await tempDir('bf-')
  const make = (name: string) => {
    const home = join(root, name)
    mkdirSync(home, { mode: 0o700 })
    return home
  }
  const dir = make('dir')
  mkdirSync(join(dir, 'auth.json'))
  assert.throws(() => readCodexLogin(dir), /broker\.unsafe-login/)
  const big = make('big')
  writeFileSync(join(big, 'auth.json'), 'x'.repeat(70 * 1024), { mode: 0o600 })
  assert.throws(() => readCodexLogin(big), /broker\.unsafe-login/)
  for (const [name, bytes] of [
    ['junk', '{ not json'],
    ['array', '[]'],
    ['bom', Buffer.from([0xff, 0xfe, 0x7b, 0x7d])],
  ] as const) {
    const home = make(name)
    writeFileSync(join(home, 'auth.json'), bytes, { mode: 0o600 })
    assert.throws(() => readCodexLogin(home), /broker\.invalid-login/)
  }
  const key = make('key')
  writeFileSync(
    join(key, 'auth.json'),
    JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'FAKE_KEY_NOT_A_BEARER', tokens: null }),
    { mode: 0o600 },
  )
  assert.deepEqual(readCodexLogin(key), {
    authMethod: 'apikey',
    authToken: null,
    requiresOpenaiAuth: true,
  })
  const unknown = make('unknown')
  writeFileSync(join(unknown, 'auth.json'), JSON.stringify({ auth_mode: 'somethingNew' }), {
    mode: 0o600,
  })
  assert.equal(readCodexLogin(unknown), null)
})

test('the official refresh contract this source relies on matches the captured real binary', () => {
  // capture-codex-auth.mjs ran the real codex 0.162.0-alpha.2 against fake
  // homes: getAuthStatus with refreshToken true refreshed, returned the
  // replacement bearer and persisted it to auth.json for the next disk read.
  const capture = JSON.parse(
    readFileSync('test/fixtures/codex-auth-0.162.0-alpha.2.json', 'utf8'),
  ) as {
    homes: { home: string; refresh?: Record<string, unknown> }[]
  }
  for (const name of ['fresh-fake', 'stale-fake']) {
    const home = capture.homes.find((entry) => entry.home === name)
    assert.ok(home?.refresh, name)
    assert.equal(home.refresh.returnsReplacementBearer, true)
    assert.equal(home.refresh.replacementBearer, true)
    assert.equal(home.refresh.rotatedChain, true)
  }
})

test('the source refuses anything but a token status request', async () => {
  const s = await setup()
  await assert.rejects(
    s.source.request('getAuthStatus', { includeToken: false as true, refreshToken: false }),
    /broker\.source-unavailable/,
  )
  await assert.rejects(
    s.source.request('other' as 'getAuthStatus', { includeToken: true, refreshToken: false }),
    /broker\.source-unavailable/,
  )
})
