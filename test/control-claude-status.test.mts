import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import test, { after, type TestContext } from 'node:test'
import { setConfigValue } from '../src/anyengine-config.mjs'
import { applyClaudeLayer } from '../src/control-claude-layer.mjs'
import { runDoctor } from '../src/control-doctor.mjs'
import { LayerWriter } from '../src/control-layers.mjs'
import { formatStatus, gatherStatus } from '../src/control-status.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const SECRET = 'FAKE_CLAUDE_STATUS_PRIVATE_VALUE'
const START = '2026-10-04T00:00:00.000Z'
const model = {
  id: 'gpt-status-fixture',
  label: 'GPT status',
  contextWindow: 100000,
  lite: false,
  efforts: ['low'],
}
async function fixture(t: TestContext, createOwnedRow = false) {
  const home = await tempDir('cs-')
  const root = join(home, 'engine')
  const codex = join(home, '.codex')
  const lib = join(root, 'lib/v1')
  mkdirSync(join(lib, 'vendor/claude-code-proxy'), { recursive: true })
  mkdirSync(join(lib, 'test/fixtures'), { recursive: true })
  mkdirSync(join(root, 'router'))
  mkdirSync(codex)
  symlinkSync('v1', join(root, 'lib/current'))
  writeFileSync(
    join(lib, 'vendor/claude-code-proxy/LICENSE'),
    readFileSync('vendor/claude-code-proxy/LICENSE'),
  )
  writeFileSync(
    join(lib, 'vendor/claude-code-proxy/UPSTREAM.md'),
    readFileSync('vendor/claude-code-proxy/UPSTREAM.md'),
  )
  writeFileSync(join(lib, 'THIRD_PARTY_NOTICES.md'), readFileSync('THIRD_PARTY_NOTICES.md'))
  writeFileSync(
    join(lib, 'test/fixtures/claude-posture-2.1.289.json'),
    JSON.stringify({ version: 1, claudeVersion: '2.1.289' }),
  )
  const system = fakeSystem(home)
  const cli = join(home, 'fake-claude')
  writeFileSync(cli, 'controlled executable fixture', { mode: 0o700 })
  system.execs.set(`${cli} --version`, { status: 0, stdout: '2.1.289 (Claude Code)\n', stderr: '' })
  setConfigValue(root, 'claude.cli', cli)
  let ready = true
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/health')
    response.end(
      JSON.stringify({
        ok: true,
        pid: 42,
        version: 'v1',
        startedAt: START,
        mode: 'agent',
        fanout: { path: 'bridge', reason: 'unproven' },
        faults: { hookErrors: 0, unhandledRejections: 0 },
        upstream: {},
        inflight: {},
        gpt: {
          ready,
          source: 'adapter',
          generation: 1,
          reason: ready ? null : `broker.auth-failed ${SECRET}`,
          bearer: SECRET,
          accountId: SECRET,
          sourceId: SECRET,
          activeRequests: 0,
        },
      }),
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  setConfigValue(root, 'router.port', String(address.port))
  system.jobs.set('dev.anyengine.router', { plist: 'fixture', pid: 42 })
  system.procs = [
    { pid: 42, ppid: 1, processStart: START, command: `node ${lib}/dist/src/adapter.mjs router` },
  ]
  const settings = join(home, '.claude/settings.json')
  mkdirSync(join(home, '.claude'))
  const current = {
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
      CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
      ANTHROPIC_API_KEY: SECRET,
    },
    apiKeyHelper: SECRET,
    permissions: { deny: [SECRET] },
    modelPicker: {
      options: createOwnedRow
        ? []
        : [{ model: model.id, label: 'GPT fixture', description: SECRET }],
    },
  }
  const writer = new LayerWriter(root, null, 'claude-code', 'fixture')
  writeFileSync(settings, JSON.stringify(current), { mode: 0o600 })
  applyClaudeLayer({
    root,
    home,
    writer,
    catalog: { generation: 1, fetchedAt: 4242, models: [model] },
    baseUrl: `http://127.0.0.1:${address.port}`,
    haiku: 'claude-haiku-4-5-20251001',
  })
  writeFileSync(
    join(root, 'router/claude-gpt-catalog.json'),
    JSON.stringify({
      generation: 1,
      sourceId: SECRET,
      sourceRevision: 1,
      cacheRevision: 1,
      fetchedAt: 4242,
      models: [model],
      bearer: SECRET,
    }),
  )
  return {
    root,
    home,
    codex,
    lib,
    settings,
    system,
    current,
    unavailable: () => {
      ready = false
    },
  }
}
function secretFree(value: unknown) {
  assert.equal(JSON.stringify(value).includes(SECRET), false)
}
async function report(f: Awaited<ReturnType<typeof fixture>>) {
  return gatherStatus(f.system, f.root, { codexHome: f.codex })
}

test('Claude Code status projects settings/catalog/broker readiness without settings or credentials', async (t) => {
  const f = await fixture(t)
  const value = await report(f)
  const state = (
    value as unknown as {
      claudeCode: {
        enabled: boolean
        settingsInstalled: boolean
        models: string[]
        broker: { ready: boolean; generation: number }
        translationVersion: string
        health: string
      }
    }
  ).claudeCode
  assert.ok(state)
  assert.equal(state.enabled, true)
  assert.equal(state.settingsInstalled, true)
  assert.deepEqual(state.models, [model.id])
  assert.equal(state.broker.ready, true)
  assert.equal(state.broker.generation, 1)
  assert.equal(state.translationVersion, '0.1.42')
  assert.equal(state.health, 'ready')
  secretFree(value)
  secretFree(formatStatus(value))
  assert.deepEqual(JSON.parse(readFileSync(f.settings, 'utf8')), f.current)
})

test('GPT broker degradation remains separate from current transparent Claude router health', async (t) => {
  const f = await fixture(t)
  f.unavailable()
  const value = await report(f)
  assert.equal(value.router.health?.ok, true)
  assert.equal(value.router.fanout, 'bridge')
  const state = (value as unknown as { claudeCode: { health: string; broker: { ready: boolean } } })
    .claudeCode
  assert.equal(state.health, 'degraded')
  assert.equal(state.broker.ready, false)
  secretFree(value)
  const checks = await runDoctor(f.system, f.root, { codexHome: f.codex })
  const diagnostic = checks.find((check) => check.name === 'Claude Code GPT')
  assert.ok(diagnostic)
  assert.equal(diagnostic.level, 'warn')
  assert.match(diagnostic.detail, /codex login/)
  secretFree(checks)
})

test('Claude Code doctor diagnoses routing and credential/precedence uncertainty without values', async (t) => {
  const f = await fixture(t)
  f.current.env.ANTHROPIC_BASE_URL = 'https://foreign.invalid'
  writeFileSync(f.settings, JSON.stringify(f.current))
  writeFileSync(
    join(f.home, '.claude/managed-settings.json'),
    JSON.stringify({ env: { PRIVATE: SECRET } }),
  )
  const checks = await runDoctor(f.system, f.root, { codexHome: f.codex })
  const diagnostic = checks.find((check) => check.name === 'Claude Code GPT')
  assert.ok(diagnostic)
  assert.equal(diagnostic.level, 'warn')
  assert.match(diagnostic.detail, /routing|base URL/i)
  assert.match(diagnostic.detail, /credential|subscription/i)
  assert.match(diagnostic.detail, /precedence|managed/i)
  secretFree(checks)
})

test('invalid Claude user settings fail closed without echoing malformed private content', async (t) => {
  const f = await fixture(t)
  writeFileSync(f.settings, `{ "private":"${SECRET}", malformed }`)
  const value = await report(f)
  const state = (
    value as unknown as { claudeCode: { settingsInstalled: boolean | null; health: string } }
  ).claudeCode
  assert.equal(state.settingsInstalled, null)
  assert.equal(state.health, 'unknown')
  secretFree(value)
  const checks = await runDoctor(f.system, f.root, { codexHome: f.codex })
  const diagnostic = checks.find((check) => check.name === 'Claude Code GPT')
  assert.ok(diagnostic)
  assert.equal(diagnostic.level, 'fail')
  secretFree(checks)
})

test('diagnostic catalog source identifiers never authorize another generation model view', async (t) => {
  const f = await fixture(t)
  writeFileSync(
    join(f.root, 'router/claude-gpt-catalog.json'),
    JSON.stringify({ generation: 2, fetchedAt: 4242, models: [model], sourceId: SECRET }),
  )
  const value = await report(f)
  const state = (value as unknown as { claudeCode: { models: string[]; health: string } })
    .claudeCode
  assert.deepEqual(state.models, [])
  assert.equal(state.health, 'degraded')
  secretFree(value)
})

test('removed owned picker rows leave routing installed state degraded without publishing settings', async (t) => {
  const f = await fixture(t, true)
  f.current.modelPicker.options = []
  writeFileSync(f.settings, JSON.stringify(f.current))
  const value = await report(f)
  assert.equal(value.claudeCode.settingsInstalled, false)
  assert.equal(value.claudeCode.health, 'degraded')
  const diagnostic = (await runDoctor(f.system, f.root, { codexHome: f.codex })).find(
    (check) => check.name === 'Claude Code GPT',
  )
  assert.ok(diagnostic)
  assert.match(diagnostic.detail, /picker/)
  secretFree(value)
  secretFree(diagnostic)
})

test('Claude Code doctor fails missing MIT evidence and warns when the binary differs from its installed fixture', async (t) => {
  const f = await fixture(t)
  const cli = join(f.home, 'fake-claude')
  f.system.execs.set(`${cli} --version`, {
    status: 0,
    stdout: '2.1.999 (Claude Code)\n',
    stderr: SECRET,
  })
  const mismatch = (await runDoctor(f.system, f.root, { codexHome: f.codex })).find(
    (check) => check.name === 'Claude Code GPT',
  )
  assert.ok(mismatch)
  assert.equal(mismatch.level, 'warn')
  assert.match(mismatch.detail, /2\.1\.999.*fixture 2\.1\.289/)
  writeFileSync(join(f.lib, 'vendor/claude-code-proxy/LICENSE'), SECRET)
  const invalid = (await runDoctor(f.system, f.root, { codexHome: f.codex })).find(
    (check) => check.name === 'Claude Code GPT',
  )
  assert.ok(invalid)
  assert.equal(invalid.level, 'fail')
  assert.match(invalid.detail, /MIT/)
  secretFree(mismatch)
  secretFree(invalid)
})
