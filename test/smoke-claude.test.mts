import assert from 'node:assert/strict'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { claudeProjectFolder, parseOAuthStatus, pruneOwnSessions } from '../src/smoke-claude.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const session = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

test('smoke removes only its exact regular session file in the fixed project', async () => {
  const home = await tempDir('ae-sm-home-')
  const project = join(home, 'smoke/claude-project')
  const folder = claudeProjectFolder(home, project)
  mkdirSync(join(folder, session), { recursive: true })
  writeFileSync(join(folder, `${session}.jsonl`), '{}\n')
  writeFileSync(join(folder, 'other.jsonl'), '{}\n')
  writeFileSync(join(home, '.claude.json'), 'operator state')
  const result = pruneOwnSessions(home, project, [session, session])
  assert.deepEqual(result, { removed: [session], missing: [] })
  assert.equal(existsSync(join(folder, session)), true)
  assert.equal(existsSync(join(folder, 'other.jsonl')), true)
  assert.deepEqual(pruneOwnSessions(home, project, [session]), { removed: [], missing: [session] })
})
test('smoke session cleanup refuses traversal and symlinked files or project folders', async () => {
  const home = await tempDir('ae-sm-prune-')
  const project = join(home, 'project')
  const folder = claudeProjectFolder(home, project)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(home, 'outside'), 'retain')
  symlinkSync(join(home, 'outside'), join(folder, `${session}.jsonl`))
  assert.throws(() => pruneOwnSessions(home, project, ['../outside']), /session/)
  assert.throws(() => pruneOwnSessions(home, project, [session]), /regular/)
  const another = join(home, 'another')
  symlinkSync(folder, claudeProjectFolder(home, another))
  assert.throws(() => pruneOwnSessions(home, another, [session]), /directory/)
  assert.equal(existsSync(join(home, 'outside')), true)
})
// Controlled vendor-status fixtures. They do not observe or claim installed OAuth.
const status = (extra: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      configDirectory: '/controlled/claude',
      email: 'redacted@example.invalid',
      organization: 'must not be retained',
      ...extra,
    }),
  )
test('OAuth status retains only the documented nonsecret selection under the exact home', () => {
  assert.deepEqual(parseOAuthStatus(status(), 0, '/controlled/claude'), {
    loggedIn: true,
    method: 'claude.ai',
    home: '/controlled/claude',
  })
})
test('OAuth status rejects other methods, failed login, malformed bytes and home drift', () => {
  for (const method of [
    'none',
    'oauth_token',
    'api_key',
    'api_key_helper',
    'third_party',
    'unknown',
  ])
    assert.throws(
      () => parseOAuthStatus(status({ authMethod: method }), 0, '/controlled/claude'),
      /OAuth/,
    )
  assert.throws(() => parseOAuthStatus(status(), 1, '/controlled/claude'), /OAuth/)
  assert.throws(
    () => parseOAuthStatus(status({ loggedIn: false }), 0, '/controlled/claude'),
    /OAuth/,
  )
  assert.throws(() => parseOAuthStatus(status(), 0, '/other'), /OAuth/)
  assert.throws(() => parseOAuthStatus(Buffer.from([0xff]), 0, '/controlled/claude'))
  assert.throws(() => parseOAuthStatus(Buffer.alloc(64_001), 0, '/controlled/claude'))
})
