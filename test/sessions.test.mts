import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { readConfig, setConfigValue } from '../src/anyengine-config.mjs'
import { runControl } from '../src/control-cli.mjs'
import { Sessions } from '../src/sessions.mjs'
import { claudeCopyBody, claudeProjectKey } from '../src/sessions-claude.mjs'
import { readCopies } from '../src/sessions-copies.mjs'
import { startSessionSync } from '../src/sessions-sync.mjs'
import type { SessionSnapshot } from '../src/sessions-types.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const fixture = resolve('test/fixtures/session-codex.mjs')
const sourceId = '3b59fbf2-0f59-4513-a4f7-f3a0bcbeb13a'
const codexId = '3b59fbf2-0f59-4513-a4f7-f3a0bcbeb13b'
async function setup() {
  const root = await tempDir('anyengine-sessions-')
  const cwd = join(root, 'project')
  mkdirSync(cwd)
  const claudeRoot = join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = claudeRoot
  process.env.ANYENGINE_REAL_CODEX = fixture
  const state = join(root, 'codex.json')
  process.env.SESSION_TEST_STATE = state
  delete process.env.SESSION_TEST_IMPORT_ERROR
  writeFileSync(
    state,
    JSON.stringify([
      {
        id: codexId,
        cwd,
        name: 'Codex source',
        updatedAt: 100,
        turns: [
          {
            items: [
              { type: 'userMessage', content: [{ type: 'text', text: 'codex question' }] },
              { type: 'agentMessage', text: 'codex history needle' },
            ],
          },
        ],
      },
    ]),
  )
  const source: SessionSnapshot = {
    key: `claude:${sourceId}`,
    id: sourceId,
    harness: 'claude',
    title: 'Claude source',
    cwd,
    updatedAt: 100000,
    copied: false,
    messages: [
      { role: 'user', text: 'claude question' },
      { role: 'assistant', text: 'claude answer' },
    ],
  }
  const dir = join(claudeRoot, 'projects', claudeProjectKey(cwd))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sourceId}.jsonl`)
  writeFileSync(file, claudeCopyBody(source, sourceId, source.title))
  utimesSync(file, 100, 100)
  const sessions = new Sessions(root)
  return { root, cwd, state, source, file, dir, sessions }
}

test('optional controls start off, off refuses copies, switches preserve other settings', async () => {
  const root = await tempDir('anyengine-sessions-off-')
  assert.deepEqual(readConfig(root).config.sessions, { enabled: false, sync: false })
  let out = ''
  const say = (s: string) => {
    out += s
  }
  assert.equal(
    await runControl(
      ['sessions', 'open', `claude:${sourceId}`, '--in', 'codex'],
      undefined,
      root,
      say,
    ),
    2,
  )
  assert.match(out, /features are off/)
  assert.equal(existsSync(join(root, 'sessions')), false)
  assert.equal(await runControl(['sessions', 'on'], undefined, root, say), 0)
  assert.equal(readConfig(root).config.sessions.sync, false)
  assert.equal(await runControl(['sessions', 'sync', 'on'], undefined, root, say), 0)
  assert.deepEqual(readConfig(root).config.sessions, { enabled: true, sync: true })
  assert.equal(await runControl(['sessions', 'off'], undefined, root, say), 0)
  assert.deepEqual(readConfig(root).config.sessions, { enabled: false, sync: false })
  assert.equal(readConfig(root).config.router.enabled, true)
})

test('unified catalog and content search read both originals without writing histories', async () => {
  const f = await setup()
  const before = readFileSync(f.file, 'utf8')
  const codexBefore = readFileSync(f.state, 'utf8')
  try {
    const list = await f.sessions.list(f.cwd)
    assert.ok(list.some((s) => s.key === f.source.key))
    assert.ok(list.some((s) => s.key === `codex:${codexId}`))
    assert.equal((await f.sessions.search('history needle', 5))[0]?.id, codexId)
    assert.equal((await f.sessions.search('claude answer', 5))[0]?.id, sourceId)
    assert.equal(readFileSync(f.file, 'utf8'), before)
    assert.equal(readFileSync(f.state, 'utf8'), codexBefore)
    assert.equal(existsSync(join(f.root, 'sessions')), false)
  } finally {
    await f.sessions.close()
  }
})

test('cross-open both ways carries history, reuses copies, fresh leaves continued branches alone', async () => {
  const f = await setup()
  const original = readFileSync(f.file, 'utf8')
  try {
    const copy = await f.sessions.open(f.source.key, 'codex')
    assert.match(copy.title, /^\[AnyEngine from Claude\]/)
    assert.equal((await f.sessions.open(f.source.key, 'codex')).target, copy.target)
    assert.deepEqual(
      (await f.sessions.read(await f.sessions.find(copy.target))).messages,
      f.source.messages,
    )
    const continued = JSON.parse(readFileSync(f.state, 'utf8'))
    continued
      .find((s: { id: string }) => `codex:${s.id}` === copy.target)
      .turns.push({ items: [{ type: 'agentMessage', text: 'continued branch' }] })
    writeFileSync(f.state, JSON.stringify(continued))
    const fresh = await f.sessions.open(f.source.key, 'codex', true)
    assert.notEqual(fresh.target, copy.target)
    assert.ok(
      (await f.sessions.read(await f.sessions.find(copy.target))).messages.some(
        (m) => m.text === 'continued branch',
      ),
    )
    const claude = await f.sessions.open(`codex:${codexId}`, 'claude')
    assert.deepEqual((await f.sessions.read(await f.sessions.find(claude.target))).messages, [
      { role: 'user', text: 'codex question' },
      { role: 'assistant', text: 'codex history needle' },
    ])
    assert.equal((await f.sessions.open(`codex:${codexId}`, 'claude')).target, claude.target)
    assert.equal(readFileSync(f.file, 'utf8'), original)
    assert.equal(readdirSync(f.dir).filter((s) => s.endsWith('.jsonl')).length, 2)
  } finally {
    await f.sessions.close()
  }
})

test('sync imports new conversations once, excludes marked copies, and respects cancellation', async () => {
  const f = await setup()
  try {
    assert.equal((await f.sessions.sync(10)).copied.length, 2)
    assert.equal((await f.sessions.sync(10)).copied.length, 0)
    assert.equal(readCopies(f.root).length, 2)
    const state = JSON.parse(readFileSync(f.state, 'utf8'))
    state.push({ ...state[0], id: randomUUID(), name: 'New conversation' })
    writeFileSync(f.state, JSON.stringify(state))
    assert.equal((await f.sessions.sync(10, undefined, () => false)).copied.length, 0)
    assert.equal((await f.sessions.sync(10)).copied.length, 1)
    assert.equal((await f.sessions.sync(10)).copied.length, 0)
  } finally {
    await f.sessions.close()
  }
})

test('failed vendor import leaves original untouched and reports failure without a success record', async () => {
  const f = await setup()
  const before = readFileSync(f.file, 'utf8')
  await f.sessions.close()
  process.env.SESSION_TEST_IMPORT_ERROR = '1'
  const sessions = new Sessions(f.root)
  try {
    await assert.rejects(sessions.open(f.source.key, 'codex'), /synthetic import refused/)
    assert.equal(readCopies(f.root).length, 0)
    assert.equal(readFileSync(f.file, 'utf8'), before)
    assert.equal(readdirSync(f.dir).filter((s) => s.endsWith('.jsonl')).length, 1)
  } finally {
    await sessions.close()
    delete process.env.SESSION_TEST_IMPORT_ERROR
  }
})

test('invalid session controls do not enable sync or execute a host', async () => {
  const root = await tempDir('anyengine-sessions-args-')
  setConfigValue(root, 'sessions.enabled', 'true')
  const say = () => {}
  for (const args of [
    ['list', '--limit', '0'],
    ['sync', 'yes'],
    ['sync', 'on', '--cwd', root],
    ['sync', 'on', '--limit', '1'],
    ['open', 'bad', '--in', 'other'],
    ['open', `claude:${sourceId}`, '--in', 'claude', '--json', '--launch'],
  ])
    assert.equal(await runControl(['sessions', ...args], undefined, root, say), 2)
  assert.equal(readConfig(root).config.sessions.sync, false)
})

test('archived paginated Codex histories retain every turn in cross-open', async () => {
  const f = await setup()
  const state = JSON.parse(readFileSync(f.state, 'utf8'))
  state[0].archived = true
  state[0].historyMode = 'paginated'
  state[0].turns.push({
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'second question' }] },
      { type: 'agentMessage', text: 'second answer' },
    ],
  })
  writeFileSync(f.state, JSON.stringify(state))
  try {
    const session = await f.sessions.find(`codex:${codexId}`)
    assert.equal(session.archived, true)
    const messages = (await f.sessions.read(session)).messages
    assert.equal(messages.length, 4)
    const copy = await f.sessions.open(session.key, 'claude')
    assert.deepEqual((await f.sessions.read(await f.sessions.find(copy.target))).messages, messages)
  } finally {
    await f.sessions.close()
  }
})

test('cross-open uses Claude’s native lookup for symlinked Unicode workspace paths', async () => {
  const f = await setup()
  const project = join(f.root, 'cafe\u0301')
  mkdirSync(project)
  const alias = join(f.root, 'linked-project')
  symlinkSync(project, alias)
  const state = JSON.parse(readFileSync(f.state, 'utf8'))
  state[0].cwd = alias
  writeFileSync(f.state, JSON.stringify(state))
  try {
    const copy = await f.sessions.open(`codex:${codexId}`, 'claude')
    const messages = (await f.sessions.read(await f.sessions.find(copy.target))).messages
    assert.equal(messages[0]?.text, 'codex question')
    assert.equal(claudeProjectKey(alias), claudeProjectKey(project))
  } finally {
    await f.sessions.close()
  }
})

test('background sync runs only with both opt-ins and closes its vendor child', async () => {
  const f = await setup()
  await f.sessions.close()
  setConfigValue(f.root, 'sessions.enabled', 'true')
  setConfigValue(f.root, 'sessions.sync', 'true')
  const loop = startSessionSync(f.root, { ...process.env, ANYENGINE_MOCK: '0' })
  try {
    const deadline = Date.now() + 10000
    while (readCopies(f.root).length < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(readCopies(f.root).length, 2)
  } finally {
    await loop.close()
  }
  const disabledRoot = await tempDir('anyengine-sessions-disabled-')
  const disabled = startSessionSync(disabledRoot, {
    ...process.env,
    ANYENGINE_MOCK: '0',
    ANYENGINE_REAL_CODEX: '/missing',
  })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await disabled.close()
  assert.equal(existsSync(join(disabledRoot, 'sessions')), false)
})

test('public CLI browses, searches, shows, cross-opens, and launches the selected native CLI', async () => {
  const f = await setup()
  await f.sessions.close()
  setConfigValue(f.root, 'sessions.enabled', 'true')
  setConfigValue(f.root, 'claude.cli', fixture)
  const launchFile = join(f.root, 'launched.json')
  process.env.SESSION_TEST_LAUNCH = launchFile
  async function command(args: string[], expected = 0) {
    let text = ''
    const code = await runControl(['sessions', ...args], undefined, f.root, (s) => {
      text += s
    })
    assert.equal(code, expected, text)
    return text
  }
  const before = readFileSync(f.file, 'utf8')
  const rows = JSON.parse(await command(['list', '--cwd', f.cwd, '--limit', '10', '--json']))
  assert.equal(rows.length, 2)
  assert.equal(JSON.parse(await command(['search', 'history needle', '--json']))[0].id, codexId)
  assert.deepEqual(
    JSON.parse(await command(['show', f.source.key, '--json'])).messages,
    f.source.messages,
  )
  const codexCopy = JSON.parse(await command(['open', f.source.key, '--in', 'codex', '--json']))
  assert.equal(codexCopy.args[0], 'resume')
  const claudeCopy = JSON.parse(
    await command(['open', `codex:${codexId}`, '--in', 'claude', '--model', 'gpt-6-sol', '--json']),
  )
  assert.deepEqual(claudeCopy.args, [
    '--resume',
    claudeCopy.target.split(':')[1],
    '--fork-session',
    '--model',
    'gpt-6-sol',
  ])
  assert.match(await command(['list']), /\[copy\]/)
  assert.match(await command(['show', f.source.key]), /assistant: claude answer/)
  assert.match(await command(['search', 'question']), /Claude source/)
  assert.match(await command(['open', f.source.key, '--in', 'chatgpt']), /Codex workspace history/)
  await command(['open', `codex:${codexId}`, '--in', 'claude', '--launch'])
  assert.ok(JSON.parse(readFileSync(launchFile, 'utf8')).argv.includes('--fork-session'))
  await command(['open', f.source.key, '--in', 'codex', '--launch'])
  assert.equal(JSON.parse(readFileSync(launchFile, 'utf8')).argv[0], 'resume')
  assert.equal(JSON.parse(await command(['sync', '--json'])).copied.length, 0)
  assert.match(await command(['sync']), /Copied 0/)
  assert.equal(JSON.parse(await command(['sync', 'on', '--json'])).sync, true)
  assert.equal(JSON.parse(await command(['sync', 'off', '--json'])).sync, false)
  assert.equal(JSON.parse(await command(['status', '--json'])).enabled, true)
  assert.match(await command(['status']), /Automatic sync: off/)
  await command(['open', f.source.key, '--in', 'chatgpt', '--model', 'sonnet'], 2)
  assert.equal(readFileSync(f.file, 'utf8'), before)
  delete process.env.SESSION_TEST_LAUNCH
})
