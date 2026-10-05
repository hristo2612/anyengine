import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { AccountContinuity } from '../src/accounts-continuity.mjs'
import { AccountParticipant } from '../src/accounts-participant.mjs'
import { rotateAccount } from '../src/accounts-rotation.mjs'
import { upstreamThreadInfoFrom } from '../src/claude-project-guard.mjs'
import { CodexUpstream } from '../src/codex-upstream.mjs'
import { applyCodexParams, DEFAULT_POSTURE, toCodexTurn } from '../src/posture.mjs'
import { asRecord, idOf } from '../src/rpc-shape.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
test('next account lazily resumes exact context and keeps cold-resume instructions untouched', async () => {
  const paths = await accountFixture()
  const runtime = new AccountParticipant(paths, 'adapter')
  await runtime.ready
  const requests = join(paths.root, 'requests.jsonl')
  const upstream = new CodexUpstream({
    binary: resolve('test/fixtures/fake-codex-app-server.mjs'),
    args: ['app-server'],
    env: {
      ...process.env,
      FAKE_CODEX_REQUESTS_FILE: requests,
      FAKE_CODEX_NO_APPROVAL: '1',
      FAKE_CODEX_COLD_RESUME: '1',
    },
    reserveEnabled: false,
    processLifecycle: runtime.lifecycle,
    onMessage() {},
  })
  runtime.setHooks({ stop: () => upstream.stop(), restart: () => upstream.restartForAccounts() })
  const aliases: string[] = []
  const hooks = {
    info() {},
    alias(_app: string, native: string) {
      aliases.push(native)
    },
  }
  let continuity = new AccountContinuity(runtime, upstream, hooks)
  const peer = { id: 'app', send() {}, close() {} }
  try {
    upstream.start()
    await upstream.initialize({ clientInfo: { name: 'test', version: '1' } })
    upstream.markInitialized()
    const params = {
      model: 'gpt-6.1-sol',
      cwd: paths.root,
      developerInstructions: 'keep this instruction',
      baseInstructions: 'base',
      reasoningEffort: 'high',
    }
    const result = asRecord(await upstream.request('thread/start', params))
    const id = idOf(asRecord(result.thread))
    assert.ok(id)
    const info = {
      ...upstreamThreadInfoFrom(result),
      model: params.model,
      cwd: params.cwd,
      posture: applyCodexParams(DEFAULT_POSTURE, {
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      }),
    }
    continuity.record(id, id, info, params)
    await rotateAccount(runtime.ledger, 'b', 'manual')
    const prepared = await continuity.prepare(peer, id, id, {
      input: [{ type: 'text', text: 'continue' }],
    })
    assert.equal(prepared.firstAfterSwitch, true)
    assert.equal(prepared.params.model, params.model)
    assert.equal(prepared.params.cwd, params.cwd)
    assert.deepEqual(prepared.params.sandboxPolicy, toCodexTurn(info.posture).sandboxPolicy)
    assert.equal(prepared.params.approvalPolicy, 'never')
    assert.equal(prepared.params.effort, 'high')
    await continuity.prepare(peer, id, id, {})
    const messages = (await readFile(requests, 'utf8'))
      .trim()
      .split('\n')
      .map((v) => JSON.parse(v))
    const resumes = messages.filter((m) => m.method === 'thread/resume')
    assert.equal(resumes.length, 1)
    assert.equal(resumes[0].params.model, params.model)
    assert.equal(resumes[0].params.cwd, params.cwd)
    assert.equal(resumes[0].params.developerInstructions, undefined)
    assert.equal(resumes[0].params.baseInstructions, undefined)
    continuity = new AccountContinuity(runtime, upstream, hooks)
    assert.equal(
      (await continuity.prepare(peer, id, id, {})).firstAfterSwitch,
      false,
      'a process restart cannot grant another first-turn retry',
    )
    assert.deepEqual(aliases, [])
  } finally {
    await upstream.stop()
    await runtime.close()
  }
})
