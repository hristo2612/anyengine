import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { after, type TestContext, test } from 'node:test'
import { DEFAULT_CONFIG, setConfigValue } from '../src/anyengine-config.mjs'
import { desktopPickerCommand, desktopPickerStatus } from '../src/control-desktop-picker.mjs'
import { claudeCatalogModels, DESKTOP_CLAUDE_MODELS } from '../src/desktop-claude-catalog.mjs'
import {
  DESKTOP_MODEL_PREFIX,
  desktopGptModel,
  desktopModelId,
  desktopProfile,
} from '../src/desktop-models.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const model = {
  id: 'gpt-test-codex',
  label: 'GPT Test',
  contextWindow: 272000,
  lite: true,
  efforts: ['low', 'high', 'ultra'],
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const nativeModels = claudeCatalogModels(
  DEFAULT_CONFIG.claude.models.map((model) => ({
    value: model.id,
    resolvedModel: `claude-${model.id}-test`,
    displayName: model.displayName,
    description: 'Native model',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'max'],
  })),
)
function write(path: string, value: object) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}
async function fixture(t: TestContext) {
  const home = await tempDir('desktop-picker-')
  const root = join(home, '.anyengine')
  const dir = join(home, 'Library/Application Support/Claude-3p')
  const system = fakeSystem(home)
  system.version = '2.19675.1'
  let available = true
  let compatible = true
  let claudeModels = nativeModels
  const server = http.createServer((req, res) => {
    if (req.url === DESKTOP_CLAUDE_MODELS) {
      res.writeHead(available ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: claudeModels }))
      return
    }
    if (req.url === '/v1/messages/count_tokens') {
      const desktop =
        req.headers.authorization === 'Bearer anyengine-local' &&
        req.headers['sec-fetch-site'] === 'none' &&
        req.headers['sec-fetch-dest'] === 'empty' &&
        req.headers['sec-fetch-mode'] === 'no-cors'
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const name = JSON.parse(body).model as string
        const route = name.startsWith('claude-') || name.startsWith('anyengine/')
        res.writeHead(compatible && desktop && route ? 200 : 400, {
          'content-type': 'application/json',
        })
        res.end(JSON.stringify({ input_tokens: 1 }))
      })
      return
    }
    res.writeHead(available ? 200 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ generation: 1, fetchedAt: 1, models: [model] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  setConfigValue(root, 'router.port', String(address.port))
  return {
    home,
    root,
    system,
    dir,
    port: address.port,
    mode: join(dir, 'claude_desktop_config.json'),
    meta: join(dir, 'configLibrary/_meta.json'),
    receipt: join(root, 'recovery/claude-desktop/picker.json'),
    profile: (id: string) => join(dir, 'configLibrary', `${id}.json`),
    unavailable: () => {
      available = false
    },
    oldRouter: () => {
      compatible = false
    },
    models: (models: typeof nativeModels) => {
      claudeModels = models
    },
    run: (verb: string) => desktopPickerCommand([verb], system, root, () => {}),
  }
}
test('Desktop IDs remain Claude-compatible while decoding only canonical exact GPT IDs', () => {
  const alias = desktopModelId(model.id)
  assert.ok(alias.startsWith(DESKTOP_MODEL_PREFIX))
  assert.equal(alias.includes('codex'), false)
  assert.equal(desktopGptModel(alias), model.id)
  const longId = `gpt-${'a'.repeat(124)}`
  assert.equal(desktopGptModel(desktopModelId(longId)), longId)
  assert.equal(desktopGptModel(desktopModelId(`${longId}a`)), null)
  for (const bad of [
    alias.toUpperCase(),
    `${alias}f`,
    `${alias}/`,
    desktopModelId('claude-opus'),
    desktopModelId('gpt-test\n'),
    `${DESKTOP_MODEL_PREFIX}ff`.repeat(2),
  ])
    assert.equal(desktopGptModel(bad), null)
  const profile = desktopProfile(18790, [model])
  assert.deepEqual(profile.inferenceModels, [
    { name: alias, labelOverride: 'GPT Test', maxEffort: 'high' },
  ])
  assert.equal(profile.modelDiscoveryEnabled, false)
})
test('picker install/retry/removal preserves native login, unrelated settings and added profiles', async (t) => {
  const f = await fixture(t)
  const oldId = '11111111-1111-4111-8111-111111111111'
  const laterId = '22222222-2222-4222-8222-222222222222'
  const original = { appliedId: oldId, entries: [{ id: oldId, name: 'Work' }], keep: 'metadata' }
  write(f.meta, original)
  write(f.mode, { deploymentMode: '1p', preferences: { theme: 'dark' } })
  const native = join(f.home, 'Library/Application Support/Claude/config.json')
  write(native, { login: 'PRIVATE_NATIVE_LOGIN_MARKER' })
  const beforeNative = readFileSync(native)
  await f.run('on')
  const receipt = read(f.receipt)
  assert.equal(desktopPickerStatus(f.home, f.root).enabled, true)
  assert.deepEqual(desktopPickerStatus(f.home, f.root).models, [
    'opus',
    'sonnet',
    'haiku',
    model.id,
  ])
  assert.equal(receipt.version, 4)
  assert.deepEqual(receipt.claudeModels, nativeModels)
  assert.deepEqual(f.system.calls, ['quitApp', 'openApp'])
  await f.run('on')
  assert.deepEqual(f.system.calls, ['quitApp', 'openApp'])
  write(f.mode, { ...read(f.mode), keep: 'later preference' })
  write(f.meta, {
    ...read(f.meta),
    entries: [...read(f.meta).entries, { id: laterId, name: 'Later' }],
  })
  await f.run('off')
  assert.deepEqual(read(f.mode), {
    deploymentMode: '1p',
    preferences: { theme: 'dark' },
    keep: 'later preference',
  })
  assert.deepEqual(read(f.meta), {
    ...original,
    entries: [...original.entries, { id: laterId, name: 'Later' }],
  })
  assert.equal(existsSync(f.profile(receipt.id)), false)
  assert.equal(existsSync(f.receipt), false)
  assert.deepEqual(readFileSync(native), beforeNative)
})
test('picker resumes an interrupted install and restores initially absent files', async (t) => {
  const f = await fixture(t)
  await f.run('on')
  const receipt = read(f.receipt)
  rmSync(f.meta)
  rmSync(f.mode)
  rmSync(f.profile(receipt.id))
  await f.run('on')
  assert.equal(read(f.receipt).id, receipt.id)
  assert.equal(desktopPickerStatus(f.home, f.root).enabled, true)
  await f.run('off')
  assert.equal(existsSync(f.meta), false)
  assert.equal(existsSync(f.mode), false)
})
test('picker refuses edited profiles or foreign selections and leaves them intact', async (t) => {
  const f = await fixture(t)
  await f.run('on')
  const receipt = read(f.receipt)
  const changed = {
    ...read(f.profile(receipt.id)),
    inferenceGatewayBaseUrl: 'https://edited.example',
  }
  write(f.profile(receipt.id), changed)
  assert.equal(desktopPickerStatus(f.home, f.root).conflict, true)
  await assert.rejects(f.run('off'), /edited/)
  assert.deepEqual(read(f.profile(receipt.id)), changed)
  write(
    f.profile(receipt.id),
    desktopProfile(f.port, [model], receipt.claudeModels, receipt.version === 4),
  )
  write(f.meta, { ...read(f.meta), appliedId: '33333333-3333-4333-8333-333333333333' })
  await assert.rejects(f.run('on'), /edited/)
  assert.equal(read(f.meta).appliedId, '33333333-3333-4333-8333-333333333333')
})
test('unavailable models and refused quit do not switch Desktop; launch failure rolls back', async (t) => {
  const f = await fixture(t)
  f.system.quitResult = false
  await assert.rejects(f.run('on'), /Quit Claude/)
  assert.equal(existsSync(f.receipt), false)
  f.system.quitResult = true
  let opened = 0
  f.system.openApp = () => {
    if (opened++ === 0) throw new Error('launch failed')
    f.system.running = true
  }
  await assert.rejects(f.run('on'), /launch failed/)
  assert.equal(existsSync(f.receipt), false)
  assert.equal(existsSync(f.meta), false)
  assert.equal(existsSync(f.mode), false)
  assert.equal(f.system.running, true)
  f.unavailable()
  const calls = [...f.system.calls]
  await assert.rejects(f.run('on'), /models-unavailable/)
  assert.deepEqual(f.system.calls, calls)
})
test('an old router cannot switch Desktop into an unsupported native route', async (t) => {
  const f = await fixture(t)
  f.oldRouter()
  await assert.rejects(f.run('on'), /Restart or update/)
  assert.equal(existsSync(f.receipt), false)
  assert.equal(existsSync(f.meta), false)
  assert.deepEqual(f.system.calls, [])
})

test('existing GPT-only installs upgrade to both subscriptions and keep their original rollback', async (t) => {
  const f = await fixture(t)
  write(f.mode, { deploymentMode: '1p', keep: 'native' })
  await f.run('on')
  const receipt = read(f.receipt)
  delete receipt.claudeModels
  receipt.version = 1
  write(f.receipt, receipt)
  write(f.profile(receipt.id), desktopProfile(f.port, [model]))
  await f.run('on')
  const next = read(f.receipt)
  assert.equal(next.version, 4)
  assert.deepEqual(desktopPickerStatus(f.home, f.root).models, [
    'opus',
    'sonnet',
    'haiku',
    model.id,
  ])
  assert.equal(existsSync(f.profile(receipt.id)), false)
  await f.run('off')
  assert.deepEqual(read(f.mode), { deploymentMode: '1p', keep: 'native' })
})

test('refresh includes newly available Claude choices and exact effort limits without losing rollback', async (t) => {
  const f = await fixture(t)
  write(f.mode, { deploymentMode: '1p', keep: 'original' })
  await f.run('on')
  const before = read(f.receipt)
  const fable = claudeCatalogModels([
    {
      value: 'fable',
      resolvedModel: 'claude-fable-5-1',
      displayName: 'Fable 5.1',
      description: 'Native Fable option',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
  ])[0]!
  f.models([...nativeModels, fable])
  await f.run('refresh')
  const after = read(f.receipt)
  assert.notEqual(before.id, after.id)
  assert.ok(desktopPickerStatus(f.home, f.root).models.includes('fable'))
  assert.equal(existsSync(f.profile(before.id)), false)
  const row = read(f.profile(after.id)).inferenceModels.find(
    (m: any) => m.labelOverride === 'Fable 5.1',
  )
  assert.equal(row.name, 'claude-fable-5-1')
  assert.equal(row.maxEffort, 'max')
  assert.equal(row.anthropicFamilyTier, 'fable')
  await f.run('off')
  assert.deepEqual(read(f.mode), { deploymentMode: '1p', keep: 'original' })
})

test('custom CLI aliases keep their local route when no native resolved ID is available', async (t) => {
  const f = await fixture(t)
  const custom = {
    ...nativeModels[0]!,
    id: 'custom-long',
    claudeModel: 'sonnet[1m]',
    resolvedModel: 'sonnet[1m]',
    displayName: 'Custom long context',
  }
  f.models([...nativeModels, custom])
  await f.run('on')
  const receipt = read(f.receipt)
  const row = read(f.profile(receipt.id)).inferenceModels.find(
    (m: any) => m.labelOverride === 'Custom long context',
  )
  assert.equal(row.name, 'anyengine/claude-subscription/custom-long')
  await f.run('off')
})
