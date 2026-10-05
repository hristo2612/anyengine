import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { markDegraded, markProven, readDegraded, readProof } from '../src/degraded.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const load = () => import('../src/' + 'control-claude-update.mjs')
const authName = 'codex-auth-0.160.0.json'
const messagesName = 'claude-messages-2.1.289.json'
const selected = { codex: '/selected/codex', claude: '/selected/claude' }
const key = { lib: 'm2', appVersion: '26.930.1', codexVersion: '0.160.0', settings: 'fixture' }
const reason = 'Claude Code GPT update capture is incompatible'

async function setup() {
  const root = await tempDir('claude-update-')
  const lib = join(root, 'lib/m2')
  mkdirSync(join(lib, 'test/fixtures'), { recursive: true })
  for (const name of [authName, messagesName])
    cpSync(join('test/fixtures', name), join(lib, 'test/fixtures', name))
  const auth = JSON.parse(readFileSync(join(lib, 'test/fixtures', authName), 'utf8'))
  const messages = JSON.parse(readFileSync(join(lib, 'test/fixtures', messagesName), 'utf8'))
  markProven(root, 'router', 'prior M1 router', key)
  markProven(root, 'native-fanout', 'prior M1 native', key)
  const router = readProof(root, 'router')
  const native = readProof(root, 'native-fanout')
  const calls: Array<{ script: string; args: readonly string[] }> = []
  const capture = async (script: string, args: readonly string[]): Promise<unknown> => {
    calls.push({ script, args })
    if (script === 'capture-codex-auth.mjs') return auth
    assert.equal(script, 'capture-claude-messages.mjs')
    return messages
  }
  const preserved = () => {
    assert.deepEqual(readProof(root, 'router'), router)
    assert.deepEqual(readProof(root, 'native-fanout'), native)
    assert.equal(readDegraded(root).paths.router, undefined)
    assert.equal(readDegraded(root).paths['native-fanout'], undefined)
  }
  return { root, lib, auth, messages, calls, capture, preserved }
}

test('matching zero-spend captures use both selected binaries without clearing live-smoke degradation', async () => {
  const { verifyClaudeCodeUpdate } = await load()
  const s = await setup()
  markDegraded(s.root, 'claude-code-gpt', 'prior live Read smoke failed')
  const before = readFileSync(join(s.root, 'state/degraded.json'))
  assert.deepEqual(await verifyClaudeCodeUpdate(s.root, s.lib, selected, s.capture), {
    ok: true,
    reason: '',
  })
  assert.deepEqual(s.calls, [
    { script: 'capture-codex-auth.mjs', args: ['--codex', '/selected/codex'] },
    { script: 'capture-claude-messages.mjs', args: ['--claude', '/selected/claude'] },
  ])
  assert.deepEqual(readFileSync(join(s.root, 'state/degraded.json')), before)
  s.preserved()
})

test('auth RPC shape drift degrades only GPT in Claude and clears only that path proof', async () => {
  const { verifyClaudeCodeUpdate } = await load()
  const s = await setup()
  markProven(s.root, 'claude-code-gpt', 'prior live GPT smoke', key)
  s.auth.homes[1].calls[1].keys = ['authMethod', 'requiresOpenaiAuth']
  assert.deepEqual(await verifyClaudeCodeUpdate(s.root, s.lib, selected, s.capture), {
    ok: false,
    reason,
  })
  assert.equal(readProof(s.root, 'claude-code-gpt'), null)
  assert.equal(readDegraded(s.root).paths['claude-code-gpt']?.reason, reason)
  assert.deepEqual(Object.keys(readDegraded(s.root).paths), ['claude-code-gpt'])
  s.preserved()
})

for (const binary of ['codex', 'claude'] as const)
  test(`unrecorded ${binary} version cannot trust GPT in Claude`, async () => {
    const { verifyClaudeCodeUpdate } = await load()
    const s = await setup()
    if (binary === 'codex') s.auth.codexVersion = '0.161.0'
    else s.messages.claudeVersion = '2.1.290'
    assert.deepEqual(await verifyClaudeCodeUpdate(s.root, s.lib, selected, s.capture), {
      ok: false,
      reason,
    })
    assert.equal(readDegraded(s.root).paths['claude-code-gpt']?.reason, reason)
    s.preserved()
  })

for (const change of ['body', 'agent-hint'] as const)
  test(`Messages ${change} contract drift cannot trust GPT in Claude`, async () => {
    const { verifyClaudeCodeUpdate } = await load()
    const s = await setup()
    if (change === 'body') {
      const main = s.messages.scenarios.read.requests.find(
        (request: { body?: unknown }) => request.body,
      )
      main.body.keys = main.body.keys.filter((name: string) => name !== 'tools')
    } else {
      const child = s.messages.scenarios['agent-default'].requests.find(
        (request: { headers: Record<string, unknown> }) =>
          request.headers['x-claude-code-agent-id'],
      )
      delete child.headers['x-claude-code-agent-id']
    }
    assert.deepEqual(await verifyClaudeCodeUpdate(s.root, s.lib, selected, s.capture), {
      ok: false,
      reason,
    })
    s.preserved()
  })

test('runtime headers, generated identities, prose sizes and repeated requests do not cause shape drift', async () => {
  const { verifyClaudeCodeUpdate } = await load()
  const s = await setup()
  for (const scenario of Object.values(s.messages.scenarios) as Array<{
    diagnostic?: { stderrBytes: number }
    requests: Array<{ headers: Record<string, unknown>; body?: { system: { bytes: number } } }>
  }>) {
    if (scenario.diagnostic) scenario.diagnostic.stderrBytes += 111
    for (const request of scenario.requests) {
      request.headers['x-stainless-runtime-version'] = 'v99.0.0'
      if (request.headers['x-claude-code-session-id'])
        request.headers['x-claude-code-session-id'] = 'different-generated-session'
      if (request.headers['x-claude-code-agent-id'])
        request.headers['x-claude-code-agent-id'] = 'different-generated-agent'
      if (request.body?.system?.bytes) request.body.system.bytes += 91
    }
  }
  s.messages.scenarios.read.requests.push(structuredClone(s.messages.scenarios.read.requests[1]))
  assert.deepEqual(await verifyClaudeCodeUpdate(s.root, s.lib, selected, s.capture), {
    ok: true,
    reason: '',
  })
  s.preserved()
})

test('capture lifetime failure returns a sanitized M2 failure without throwing into M1 rollback', async () => {
  const { verifyClaudeCodeUpdate } = await load()
  const s = await setup()
  const failure = async () => {
    throw new Error('private upstream detail FAKE_UNSAFE_VALUE')
  }
  assert.deepEqual(await verifyClaudeCodeUpdate(s.root, s.lib, selected, failure), {
    ok: false,
    reason,
  })
  assert.equal(readDegraded(s.root).paths['claude-code-gpt']?.reason, reason)
  assert.equal(
    readFileSync(join(s.root, 'state/degraded.json'), 'utf8').includes('FAKE_UNSAFE'),
    false,
  )
  s.preserved()
})

for (const failure of ['auth-join', 'messages-join', 'missing-read'] as const)
  test(`missing capture proof (${failure}) degrades GPT in Claude`, async () => {
    const { verifyClaudeCodeUpdate } = await load()
    const s = await setup()
    if (failure === 'auth-join') s.auth.homes[0].cleanup.processGroupJoined = false
    else if (failure === 'messages-join') s.messages.isolation.cleanup = 'unknown'
    else s.messages.observed.readRoundTrip = false
    assert.deepEqual(await verifyClaudeCodeUpdate(s.root, s.lib, selected, s.capture), {
      ok: false,
      reason,
    })
    s.preserved()
  })

test('missing installed capture fixture refuses trust before launching a capture', async () => {
  const { verifyClaudeCodeUpdate } = await load()
  const s = await setup()
  rmSync(join(s.lib, 'test/fixtures', authName))
  assert.deepEqual(await verifyClaudeCodeUpdate(s.root, s.lib, selected, s.capture), {
    ok: false,
    reason,
  })
  assert.deepEqual(s.calls, [])
  s.preserved()
})

test('Messages capture accepts a private output path and retains the default immutable fixture destination', () => {
  const { parseClaudeMessagesArgs } = createRequire(import.meta.url)(
    '../../scripts/lib/claude-capture-options.mjs',
  )
  assert.equal(typeof parseClaudeMessagesArgs, 'function')
  assert.deepEqual(parseClaudeMessagesArgs(['--claude', '/selected/claude']), {
    binary: '/selected/claude',
    out: null,
  })
  assert.deepEqual(
    parseClaudeMessagesArgs(['--claude', '/selected/claude', '--out', '/owned/messages.json']),
    { binary: '/selected/claude', out: '/owned/messages.json' },
  )
  for (const args of [
    ['--out', '/owned/messages.json'],
    ['--claude', '/selected/claude', '--out'],
    ['--claude', '/selected/claude', '--out', 'a', '--out', 'b'],
    ['--claude', '/selected/claude', '--unknown', 'a'],
  ])
    assert.throws(() => parseClaudeMessagesArgs(args), /usage|argument|option/)
})
