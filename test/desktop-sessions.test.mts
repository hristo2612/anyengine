import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { readConfig, setConfigValue } from '../src/anyengine-config.mjs'
import { desktopSessionsCommand } from '../src/control-desktop-sessions.mjs'
import {
  desktopSessionStatus,
  listDesktopSessions,
  removeDesktopSessionCopies,
  syncDesktopSessions,
} from '../src/desktop-sessions.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const accountA = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  accountB = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
  org = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
const id = 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
  cli = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee'
function write(path: string, value: object) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}
async function fixture() {
  const home = await tempDir('desktop-sessions-'),
    root = join(home, '.anyengine'),
    configDir = join(home, '.claude')
  const folder = (app: string, account: string) =>
    join(home, 'Library/Application Support', app, 'claude-code-sessions', account, org)
  const source = join(folder('Claude', accountA), `local_${id}.json`),
    destination = join(folder('Claude', accountB), `local_${cli}.json`)
  const record = {
    sessionId: `local_${id}`,
    cliSessionId: cli,
    cwd: home,
    originCwd: home,
    title: 'Shared work',
    createdAt: 1,
    lastActivityAt: 2,
    isArchived: false,
    permissionMode: 'bypassPermissions',
    enabledMcpTools: ['private'],
    remoteMcpServersConfig: { private: { token: 'fixture-only' } },
    error: { type: 'rate_limit' },
    model: 'old-model',
    chromePermissionMode: 'all',
  }
  write(source, record)
  mkdirSync(folder('Claude', accountB), { recursive: true })
  mkdirSync(folder('Claude-3p', accountA), { recursive: true })
  const transcript = join(configDir, 'projects', 'project', `${cli}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, '{"type":"user","message":"Kept"}\n')
  return { home, root, configDir, folder, source, destination, record, transcript }
}
test('Desktop account sharing is independent, opt-in, idempotent and uses permission-free local records', async () => {
  const f = await fixture(),
    before = readFileSync(f.source),
    transcript = readFileSync(f.transcript)
  assert.equal(readConfig(f.root).config.sessions.desktopAccounts, false)
  assert.throws(() => syncDesktopSessions(f.home, f.root, f.configDir), /sharing is off/)
  assert.equal(existsSync(f.destination), false)
  setConfigValue(f.root, 'sessions.desktopAccounts', 'true')
  assert.deepEqual(syncDesktopSessions(f.home, f.root, f.configDir), {
    created: 2,
    folders: 3,
    conversations: 1,
  })
  assert.equal(syncDesktopSessions(f.home, f.root, f.configDir).created, 0)
  const projected = JSON.parse(readFileSync(f.destination, 'utf8'))
  assert.deepEqual(
    Object.keys(projected).sort(),
    [
      'sessionId',
      'cliSessionId',
      'cwd',
      'originCwd',
      'title',
      'createdAt',
      'lastActivityAt',
      'indexedAt',
      'isArchived',
    ].sort(),
  )
  assert.equal(projected.cliSessionId, cli)
  assert.deepEqual(readFileSync(f.source), before)
  assert.deepEqual(readFileSync(f.transcript), transcript)
  assert.equal(readConfig(f.root).config.sessions.enabled, false)
  // Continued/edited destination metadata is retained on undo; pristine projections disappear.
  projected.title = 'Continued here'
  write(f.destination, projected)
  setConfigValue(f.root, 'sessions.desktopAccounts', 'false')
  assert.deepEqual(removeDesktopSessionCopies(f.home, f.root), { removed: 1, retained: 1 })
  assert.equal(existsSync(f.destination), true)
  assert.deepEqual(readFileSync(f.source), before)
  assert.deepEqual(readFileSync(f.transcript), transcript)
  assert.deepEqual(removeDesktopSessionCopies(f.home, f.root), { removed: 0, retained: 1 })
})
test('foreign entries, missing transcripts and symlinked account folders are never overwritten or followed', async () => {
  const f = await fixture()
  const foreign = { ...f.record, sessionId: `local_${cli}`, title: 'Foreign entry' }
  write(f.destination, foreign)
  const outside = join(f.home, 'outside')
  mkdirSync(join(outside, org), { recursive: true })
  symlinkSync(
    outside,
    join(dirname(f.folder('Claude', accountA)), 'ffffffff-ffff-4fff-ffff-ffffffffffff'),
  )
  write(join(f.folder('Claude', accountA), 'local_11111111-1111-4111-8111-111111111111.json'), {
    ...f.record,
    sessionId: 'local_11111111-1111-4111-8111-111111111111',
    cliSessionId: '22222222-2222-4222-8222-222222222222',
  })
  setConfigValue(f.root, 'sessions.desktopAccounts', 'true')
  assert.equal(syncDesktopSessions(f.home, f.root, f.configDir).created, 1)
  assert.deepEqual(JSON.parse(readFileSync(f.destination, 'utf8')), foreign)
  assert.equal(desktopSessionStatus(f.home, f.root, f.configDir).folders, 3)
  assert.equal(listDesktopSessions(f.home, f.configDir).length, 3)
  assert.deepEqual(removeDesktopSessionCopies(f.home, f.root), { removed: 1, retained: 0 })
  assert.deepEqual(JSON.parse(readFileSync(f.destination, 'utf8')), foreign)
  // A receipt cannot redirect undo to an unrelated account path.
  write(join(f.root, 'recovery/claude-desktop/sessions.json'), {
    version: 1,
    copies: [
      {
        app: 'Claude',
        account: '../outside',
        org,
        record: f.record,
        sessionId: f.record.sessionId,
        cliSessionId: cli,
      },
    ],
  })
  assert.throws(
    () => removeDesktopSessionCopies(f.home, f.root),
    /Invalid Desktop session recovery/,
  )
})
test('Desktop session control exposes the option and off restores only owned metadata', async () => {
  const f = await fixture(),
    system = fakeSystem(f.home),
    output: string[] = []
  // The command honours the configured Claude home; tests set it explicitly for this fixture.
  const old = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = f.configDir
  try {
    assert.equal(
      await desktopSessionsCommand(['on', '--json'], system, f.root, (s) => output.push(s)),
      0,
    )
    assert.equal(JSON.parse(output.pop() ?? '').created, 2)
    assert.equal(
      await desktopSessionsCommand(['list', '--json'], system, f.root, (s) => output.push(s)),
      0,
    )
    assert.equal(JSON.parse(output.pop() ?? '').length, 3)
    assert.equal(
      await desktopSessionsCommand(['off', '--json'], system, f.root, (s) => output.push(s)),
      0,
    )
    assert.equal(JSON.parse(output.pop() ?? '').removed, 2)
    assert.equal(readConfig(f.root).config.sessions.desktopAccounts, false)
    assert.equal(await desktopSessionsCommand(['sync', 'unexpected'], system, f.root, () => {}), 2)
  } finally {
    if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = old
  }
})

test('actual remote, sandbox, scheduled and staged Desktop records are excluded', async () => {
  const f = await fixture()
  setConfigValue(f.root, 'sessions.desktopAccounts', 'true')
  for (const field of [
    'sshConfig',
    'wslConfig',
    'movedToCloud',
    'ranInSandboxVm',
    'scheduledTaskId',
    'stagedTranscriptPath',
  ]) {
    write(f.source, { ...f.record, [field]: { fixture: true } })
    assert.equal(listDesktopSessions(f.home, f.configDir).length, 0, field)
    assert.equal(syncDesktopSessions(f.home, f.root, f.configDir).created, 0, field)
  }
})
