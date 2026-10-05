import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { after } from 'node:test'
import {
  applyCodexParams,
  childStart,
  DEFAULT_POSTURE,
  threadPosture,
  turnWithPosture,
} from '../src/posture.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ThreadRecord } from '../src/types.mjs'
import { launchAdapter, type Wire } from './helpers/adapter-client.mjs'
import { killChildren } from './helpers/children.mjs'

after(() => killChildren())

function text(prompt: string): Wire {
  return { type: 'text', text: prompt, text_elements: [] }
}

function legacyThread(id: string, cwd: string): ThreadRecord {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    preview: '',
    name: null,
    archived: false,
    cwd,
    model: 'sonnet',
    reasoningEffort: null,
    modelProvider: 'claude-code',
    runtimeBackend: 'claude',
    claudeSessionId: null,
    codexSessionId: null,
    source: 'appServer',
    createdAt: 0,
    updatedAt: 0,
    status: { type: 'idle' },
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    ephemeral: false,
    threadSource: 'user',
    agentRole: null,
    agentNickname: null,
    baseInstructions: null,
    developerInstructions: null,
    personality: null,
  }
}

test('store: the posture column round-trips and rows without one read as null', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-store-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  try {
    const posture = applyCodexParams(DEFAULT_POSTURE, {
      approvalPolicy: {
        granular: { sandbox_approval: false, rules: true, mcp_elicitations: true },
      },
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/data'], networkAccess: true },
    })
    store.upsertThread({ ...legacyThread('with', home), posture })
    store.upsertThread(legacyThread('without', home))
    assert.deepEqual(store.getThread('with')?.posture, posture)
    assert.equal(store.getThread('without')?.posture, null)
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true })
  }
})

// The legacy strings are a projection that can be looser than the stored
// posture (a granular policy reads as on-request, an external sandbox as
// workspace-write), so a stored posture that cannot be read never falls back
// to them: it reads as the tight default, strings included.
test('store: a stored posture that cannot be read is the tight default, not the strings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-store-'))
  const path = join(home, 'state.sqlite')
  const store = new SessionStore(path)
  const raw = new DatabaseSync(path)
  try {
    const junk: Array<[string, string]> = [
      ['not-json', '{"fileSystem":'],
      ['partial', JSON.stringify({ fileSystem: { kind: 'full-access' }, network: true })],
    ]
    for (const [id, value] of junk) {
      store.upsertThread({ ...legacyThread(id, home), posture: DEFAULT_POSTURE })
      raw.prepare('UPDATE threads SET posture_json = ? WHERE id = ?').run(value, id)
      const thread = store.getThread(id)
      assert.deepEqual(thread?.posture, DEFAULT_POSTURE, id)
      assert.deepEqual(threadPosture(thread), DEFAULT_POSTURE, id)
      assert.equal(thread?.approvalPolicy, 'on-request', id)
      assert.equal(thread?.sandboxMode, 'read-only', id)
    }
  } finally {
    raw.close()
    store.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('posture: granular approval, writable roots and network survive a restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-wiring-'))
  let client = launchAdapter({ CODEX_HOME: home })
  let threadId = ''
  try {
    const start = await client.request('thread/start', {
      cwd: home,
      model: 'sonnet',
      approvalPolicy: {
        granular: { sandbox_approval: false, rules: true, mcp_elicitations: true },
      },
    })
    threadId = start.result.thread.id
    const turn = await client.request('turn/start', {
      threadId,
      input: [text('hi')],
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/data'], networkAccess: true },
    })
    await client.waitFor(
      (m) => m.method === 'turn/completed' && m.params?.turn?.id === turn.result.turn.id,
    )
  } finally {
    await client.close()
  }
  client = launchAdapter({ CODEX_HOME: home })
  try {
    const resumed = await client.request('thread/resume', { threadId })
    assert.deepEqual(resumed.result.approvalPolicy, {
      granular: {
        sandbox_approval: false,
        rules: true,
        mcp_elicitations: true,
        skill_approval: false,
        request_permissions: false,
      },
    })
    assert.deepEqual(resumed.result.sandbox, {
      type: 'workspaceWrite',
      writableRoots: [home, '/data'],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    })
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('posture: a custom profile resolves to read-only, never full access', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-wiring-'))
  const client = launchAdapter({ CODEX_HOME: home })
  try {
    const start = await client.request('thread/start', { cwd: home, permissions: 'team-profile' })
    assert.equal(start.result.approvalPolicy, 'on-request')
    assert.equal(start.result.sandbox.type, 'readOnly')
    assert.deepEqual(start.result.activePermissionProfile, { id: 'team-profile', extends: null })
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('posture: under never + workspace-write a command outside the sandbox is declined, unasked', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-wiring-'))
  const client = launchAdapter({ CODEX_HOME: home })
  try {
    const start = await client.request('thread/start', {
      cwd: home,
      model: 'sonnet',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    })
    const turn = await client.request('turn/start', {
      threadId: start.result.thread.id,
      input: [text('please run approval bash')],
    })
    await client.waitFor(
      (m) => m.method === 'turn/completed' && m.params?.turn?.id === turn.result.turn.id,
    )
    const methods = client.messages.map((m) => m.method)
    assert.ok(!methods.includes('item/commandExecution/requestApproval'), 'no card under never')
    const ran = client.messages.some(
      (m) =>
        m.method === 'item/commandExecution/outputDelta' && /mock approval/.test(m.params?.delta),
    )
    assert.equal(ran, false, 'the command did not run')
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('posture: a row stored before M0 keeps its strings until the app sends a posture', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-wiring-'))
  const adapterHome = join(home, 'adapter')
  mkdirSync(adapterHome, { recursive: true })
  const store = new SessionStore(join(adapterHome, 'state.sqlite'))
  store.upsertThread(legacyThread('legacy-thread', home))
  store.close()
  const client = launchAdapter({ CODEX_HOME: home, ANYENGINE_HOME: adapterHome })
  try {
    const resumed = await client.request('thread/resume', { threadId: 'legacy-thread' })
    assert.equal(resumed.result.approvalPolicy, 'never')
    assert.equal(resumed.result.sandbox.type, 'dangerFullAccess')
    const turn = await client.request('turn/start', {
      threadId: 'legacy-thread',
      input: [text('policy check')],
      permissions: ':workspace',
    })
    const delta = await client.waitFor(
      (m) => m.method === 'item/agentMessage/delta' && m.params?.turnId === turn.result.turn.id,
    )
    assert.equal(delta.params.delta, 'approvalPolicy=on-request sandboxMode=workspace-write')
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('turnWithPosture: a turn to the child fills only what it leaves out', () => {
  const posture = applyCodexParams(DEFAULT_POSTURE, {
    approvalPolicy: 'untrusted',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/data'], networkAccess: true },
  })
  const row = { ...legacyThread('t', '/w'), posture }
  const bare = { threadId: 't', input: [], approvalPolicy: null }
  assert.equal(turnWithPosture(bare, null), bare)
  assert.deepEqual(turnWithPosture(bare, row), {
    ...bare,
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: ['/data'],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  })
  // What the turn names wins; a profile names the approval and the sandbox,
  // so neither is added next to it (Codex refuses a sandbox named twice).
  const readOnly = { type: 'readOnly', networkAccess: false }
  assert.deepEqual(turnWithPosture({ sandboxPolicy: readOnly }, row).sandboxPolicy, readOnly)
  assert.deepEqual(turnWithPosture({ permissions: ':workspace' }, row), {
    permissions: ':workspace',
    approvalsReviewer: 'user',
  })
})

test('childStart: a bounded child gets one of its caller roots, by real path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-child-'))
  try {
    const work = join(home, 'work')
    const extra = join(home, 'extra')
    mkdirSync(join(work, 'sub'), { recursive: true })
    mkdirSync(extra)
    symlinkSync('/usr', join(work, 'out'))
    symlinkSync(join(work, 'loop'), join(work, 'loop'))
    symlinkSync(work, join(home, 'alias'))
    const bounded = applyCodexParams(DEFAULT_POSTURE, {
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [extra] },
    })
    const caller = { posture: bounded, cwd: work }
    assert.deepEqual(childStart(caller, undefined), { posture: bounded, cwd: work })
    assert.equal(childStart(caller, extra).cwd, extra)
    // Matched by real path, handed over as the caller holds it.
    assert.equal(childStart(caller, join(home, 'alias')).cwd, work)
    // A subdirectory (the caller could swap it for a link), anything outside,
    // a temp root (not one the caller names), a link loop: refused.
    const refused = ['sub', join(extra, 'x'), '/', '/usr', 'out', 'loop', '..', tmpdir()]
    for (const cwd of refused) {
      assert.throws(
        () => childStart(caller, cwd),
        /not the calling thread's cwd or one of its roots/,
      )
    }
    // An external sandbox has only its cwd; a caller with no known cwd has
    // only its explicit roots.
    const external = applyCodexParams(DEFAULT_POSTURE, {
      sandboxPolicy: { type: 'externalSandbox' },
    })
    assert.equal(childStart({ posture: external, cwd: work }, undefined).cwd, work)
    assert.throws(() => childStart({ posture: external, cwd: work }, 'sub'), /not the calling/)
    assert.throws(() => childStart({ posture: bounded, cwd: null }, work), /not the calling/)
    assert.equal(childStart({ posture: bounded, cwd: null }, extra).cwd, extra)
    // Read-only and full-access children do not write through their cwd.
    const full = applyCodexParams(DEFAULT_POSTURE, { sandbox: 'danger-full-access' })
    assert.equal(childStart({ posture: DEFAULT_POSTURE, cwd: work }, '/').cwd, '/')
    assert.equal(childStart({ posture: full, cwd: work }, '/').cwd, '/')
    assert.deepEqual(childStart(null, undefined), { posture: DEFAULT_POSTURE, cwd: process.cwd() })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
