import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { after } from 'node:test'
import {
  anyengineRoot,
  DEFAULT_CONFIG,
  enginePaths,
  getConfigValue,
  loadConfig,
  readConfig,
  routerBaseUrl,
  setConfigValue,
  writeJsonAtomic,
} from '../src/anyengine-config.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(() => killChildren())
after(removeTempDirs)

async function rootWith(config: unknown): Promise<string> {
  const root = await tempDir('anyengine-config-')
  writeFileSync(
    enginePaths(root).config,
    typeof config === 'string' ? config : JSON.stringify(config),
  )
  return root
}

test('config: a missing file reads as the defaults, agent mode, port 18790', async () => {
  const root = await tempDir('anyengine-config-')
  const { config, errors } = readConfig(root)
  assert.deepEqual(config, DEFAULT_CONFIG)
  assert.deepEqual(errors, [])
  assert.equal(config.modes.codexClaude, 'agent')
  assert.equal(routerBaseUrl(config), 'http://127.0.0.1:18790/backend-api/codex')
  assert.deepEqual(
    config.claude.models.map((m) => m.id),
    ['opus', 'sonnet', 'haiku'],
  )
})

test('config: a bad value falls back to its default and is reported, never thrown', async () => {
  const root = await tempDir('anyengine-config-')
  writeFileSync(
    enginePaths(root).config,
    JSON.stringify({ router: { port: 'x', multiAgentV1: false }, modes: { codexClaude: 'weird' } }),
  )
  const { config, errors } = readConfig(root)
  assert.equal(config.router.port, 18790)
  assert.equal(config.router.multiAgentV1, false)
  assert.equal(config.modes.codexClaude, 'agent')
  assert.equal(errors.length, 2)
  writeFileSync(enginePaths(root).config, '{not json')
  assert.match(readConfig(root).errors[0] ?? '', /not valid JSON/)
})

test('config: set validates, writes atomically with mode 0600, and get reads it back', async () => {
  const root = await tempDir('anyengine-config-')
  const next = setConfigValue(root, 'modes.codexClaude', 'model')
  assert.equal(getConfigValue(next, 'modes.codexClaude'), 'model')
  assert.equal(statSync(enginePaths(root).config).mode & 0o777, 0o600)
  assert.equal(
    JSON.parse(readFileSync(enginePaths(root).config, 'utf8')).modes.codexClaude,
    'model',
  )
  assert.throws(() => setConfigValue(root, 'modes.codexClaude', 'both'), /agent or model/)
  assert.throws(() => setConfigValue(root, 'router.port', '80'), /1024/)
  assert.throws(() => setConfigValue(root, 'nope.key', '1'), /unknown setting/)
  assert.throws(
    () => setConfigValue(root, 'claude.spawnPriority', '["gpt-6-sol"]'),
    /not a configured Claude model/,
  )
  setConfigValue(root, 'router.multiAgentV1', 'false')
  assert.equal(loadConfig(root).router.multiAgentV1, false)
})

test('config: ANYENGINE_ROOT moves every path', () => {
  assert.equal(anyengineRoot({ ANYENGINE_ROOT: '/x/y' }), '/x/y')
  const paths = enginePaths('/x/y')
  assert.equal(paths.run, join('/x/y', 'run'))
  assert.equal(paths.layers, join('/x/y', 'state', 'layers.json'))
  assert.equal(paths.driftMarker, join('/x/y', 'state', 'drift-failed'))
})

test('config: set and get know only real settings, and set refuses blanks and repeats', async () => {
  const root = await tempDir('anyengine-config-')
  for (const key of ['toString', 'constructor', '__proto__', 'router.constructor']) {
    assert.throws(() => setConfigValue(root, key, 'x'), /unknown setting/)
    assert.throws(() => getConfigValue(DEFAULT_CONFIG, key), /unknown setting/)
  }
  assert.throws(() => setConfigValue(root, 'smoke.hour', ''), /whole number/)
  assert.throws(() => setConfigValue(root, 'claims.graceMs', ' '), /whole number/)
  assert.throws(
    () => setConfigValue(root, 'claude.spawnPriority', '["opus","opus"]'),
    /opus is listed more than once/,
  )
  assert.throws(
    () => setConfigValue(root, 'claude.models', '[{"id":"opus"},{"id":"opus"}]'),
    /opus is listed more than once/,
  )
  assert.throws(() => setConfigValue(root, 'claude.models', '[null]'), /every model needs an id/)
  assert.ok(!existsSync(enginePaths(root).config), 'a refused set writes nothing')
  assert.deepEqual(readdirSync(root), [], 'validation creates no coordination database')
  assert.deepEqual(getConfigValue(DEFAULT_CONFIG, 'claude.spawnPriority'), [
    'opus',
    'sonnet',
    'haiku',
  ])
})

test('config: a file that cannot be read, or holds no object, is reported', async () => {
  const root = await tempDir('anyengine-config-')
  mkdirSync(enginePaths(root).config)
  assert.match(readConfig(root).errors[0] ?? '', /config\.json could not be read \(EISDIR\)/)
  assert.throws(() => setConfigValue(root, 'router.port', '2000'), /could not be read/)
  assert.deepEqual(readdirSync(root), ['config.json'], 'a refused set leaves no lock or temp file')
  const other = await tempDir('anyengine-config-')
  for (const text of ['null', '[1]', '"x"']) {
    writeFileSync(enginePaths(other).config, text)
    assert.deepEqual(readConfig(other).errors, ['config.json does not hold a JSON object'])
  }
})

test('config: GPT traffic goes to chatgpt.com, or to 127.0.0.1 off the router port, as given', async () => {
  const root = await tempDir('anyengine-config-')
  const set = (url: string) => setConfigValue(root, 'router.upstream', url).router.upstream
  assert.equal(
    set('https://chatgpt.com/backend-api/codex/'),
    'https://chatgpt.com/backend-api/codex',
  )
  assert.equal(set('http://127.0.0.1:9/backend-api/codex'), 'http://127.0.0.1:9/backend-api/codex')
  for (const url of [
    'https://attacker.example/x',
    'https://chatgpt.com.evil.example/x',
    'https://chatgpt.com@evil.example/x',
    'https://user:secret@chatgpt.com/x',
    'https://chatgpt.com/x?x=1',
    'https://chatgpt.com/x?',
    'https://chatgpt.com/x#frag',
    'http://chatgpt.com/x',
    'http://localhost:9/x',
    'http://[::1]:9/x',
    'http://127.0.0.1:18790/x',
    'https://chatgpt.com:8443/backend-api/codex',
    'https://chatgpt.com:0/backend-api/codex',
    'not a url',
  ]) {
    assert.throws(() => set(url), Error, url)
  }
  assert.equal(readConfig(root).config.router.upstream, 'http://127.0.0.1:9/backend-api/codex')
  assert.equal(set('https://chatgpt.com:443/x'), 'https://chatgpt.com/x')
  set('http://127.0.0.1:20000/backend-api/codex')
  assert.throws(() => setConfigValue(root, 'router.port', '20000'), /router\.upstream/)
  const bad = readConfig(await rootWith({ router: { upstream: 'https://attacker.example/x' } }))
  assert.equal(bad.config.router.upstream, DEFAULT_CONFIG.router.upstream)
  assert.match(bad.errors.join('\n'), /^router\.upstream: /)
})

test('config: a file that cannot be used, or a bad router switch, detaches the router', async () => {
  const missing = readConfig(await tempDir('anyengine-config-'))
  assert.deepEqual(
    [missing.config.router.enabled, missing.config.router.multiAgentV1],
    [true, true],
  )
  const unreadable = await tempDir('anyengine-config-')
  mkdirSync(enginePaths(unreadable).config)
  for (const root of [unreadable, ...(await Promise.all(['{bad', 'null', '[]'].map(rootWith)))]) {
    const { config } = readConfig(root)
    assert.deepEqual([config.router.enabled, config.router.multiAgentV1], [false, false], root)
    assert.equal(loadConfig(root).router.multiAgentV1, false)
  }
  const switches = readConfig(await rootWith({ router: { enabled: 'no', multiAgentV1: 'off' } }))
  assert.deepEqual(
    [switches.config.router.enabled, switches.config.router.multiAgentV1],
    [false, false],
  )
  assert.equal(switches.errors.length, 2)
  const section = readConfig(await rootWith({ router: 'on' }))
  assert.deepEqual(
    [section.config.router.enabled, section.config.router.multiAgentV1],
    [false, false],
  )
  assert.deepEqual(section.errors, ['router: needs a JSON object'])
})

test('config: set changes one key, keeps names it does not know, and refuses over errors', async () => {
  const typo = await rootWith({ router: { multiagentV1: false }, later: { x: 1 } })
  const listed = readConfig(typo).errors
  assert.equal(listed.length, 2)
  assert.match(listed.join('\n'), /^router\.multiagentV1: unknown setting/m)
  assert.match(listed.join('\n'), /^later: unknown setting/m)
  setConfigValue(typo, 'modes.codexClaude', 'model')
  assert.deepEqual(JSON.parse(readFileSync(enginePaths(typo).config, 'utf8')), {
    version: 1,
    router: { multiagentV1: false },
    later: { x: 1 },
    modes: { codexClaude: 'model' },
  })
  const broken: Array<[string, RegExp]> = [
    ['{"router":{"multiAgentV1":"off"}}', /router\.multiAgentV1: needs true or false/],
    ['{"router":{"enabled":true,},}', /not valid JSON/],
    ['{"version":2}', /version: needs 1/],
    ['{"router":"on"}', /router: needs a JSON object/],
  ]
  for (const [text, reason] of broken) {
    const root = await rootWith(text)
    assert.throws(() => setConfigValue(root, 'smoke.hour', '4'), reason)
    assert.equal(readFileSync(enginePaths(root).config, 'utf8'), text, 'nothing was written')
  }
  const locked = await rootWith({ smoke: { hour: 4 } })
  chmodSync(enginePaths(locked).config, 0o000)
  assert.throws(() => setConfigValue(locked, 'smoke.hour', '5'), /could not be read \(EACCES\)/)
  chmodSync(enginePaths(locked).config, 0o600)
  assert.equal(readConfig(locked).config.smoke.hour, 4)
  const fixing = await rootWith({ router: { multiAgentV1: 'off' } })
  assert.equal(setConfigValue(fixing, 'router.multiAgentV1', 'true').router.multiAgentV1, true)
})

test('config: dropping a Claude model prunes the spawn order, never the smoke model', async () => {
  const root = await tempDir('anyengine-config-')
  const two = '[{"id":"opus"},{"id":"sonnet"}]'
  assert.throws(() => setConfigValue(root, 'claude.models', two), /set smoke\.claudeModel/)
  setConfigValue(root, 'smoke.claudeModel', 'opus')
  setConfigValue(root, 'claude.spawnPriority', '["sonnet","haiku","opus"]')
  assert.deepEqual(setConfigValue(root, 'claude.models', two).claude.spawnPriority, [
    'sonnet',
    'opus',
  ])
  const written = JSON.parse(readFileSync(enginePaths(root).config, 'utf8'))
  assert.deepEqual(written.claude.spawnPriority, ['sonnet', 'opus'])
  assert.deepEqual(readConfig(root).errors, [])
  const read = readConfig(
    await rootWith({
      claude: { models: [{ id: 'sonnet' }, { id: 'opus' }], spawnPriority: ['haiku', 'opus'] },
    }),
  )
  assert.deepEqual(read.config.claude.spawnPriority, ['opus'])
  assert.equal(read.config.smoke.claudeModel, 'sonnet')
  assert.deepEqual(
    read.errors.map((error) => error.split(':')[0]),
    ['claude.spawnPriority', 'smoke.claudeModel'],
  )
  const unordered = readConfig(await rootWith({ claude: { models: [{ id: 'sonnet' }] } }))
  assert.deepEqual(unordered.config.claude.spawnPriority, ['sonnet'])
  assert.equal(unordered.config.smoke.claudeModel, 'sonnet')
  assert.deepEqual(unordered.errors, [
    'smoke.claudeModel: haiku is not a configured Claude model; the smoke runs on sonnet',
  ])
})

test('config: Claude entries are Claude, named, and the smoke GPT model is no Claude id', async () => {
  const root = await tempDir('anyengine-config-')
  const models = (list: unknown) => () =>
    setConfigValue(root, 'claude.models', JSON.stringify(list))
  assert.throws(models([{ id: 'gpt-6.1-sol' }]), /gpt-6\.1-sol is a GPT model id/)
  assert.throws(models([{ id: 'o3' }]), /GPT model id/)
  assert.throws(models([{ id: 'haiku', claudeModel: '' }]), /claudeModel/)
  assert.throws(models([{ id: 'haiku', claudeModel: 'haiku; rm -rf' }]), /claudeModel/)
  assert.throws(models([{ id: 'haiku', displayName: ' ' }]), /displayName/)
  assert.throws(models([{ id: 'haiku', contextWindow: 5 }]), /^Error: haiku: contextWindow needs/)
  const entry = { id: 'haiku', displayName: 'Haiku', claudeModel: 'claude-haiku-4-5[1m]' }
  assert.deepEqual(models([entry])().claude.models, [{ ...entry, contextWindow: 200000 }])
  assert.throws(() => setConfigValue(root, 'smoke.gptModel', 'haiku'), /Claude model/)
  assert.throws(() => setConfigValue(root, 'smoke.gptModel', 'claude-sonnet-4-5'), /Claude model/)
  assert.equal(setConfigValue(root, 'smoke.gptModel', 'gpt-6-sol').smoke.gptModel, 'gpt-6-sol')
  assert.equal(setConfigValue(root, 'smoke.gptModel', 'null').smoke.gptModel, null)
})

test('config: claude.cli is an executable file, set as an absolute path without control characters', async () => {
  const root = await tempDir('anyengine-config-')
  const bin = await tempDir('anyengine-config-bin-')
  const cli = join(bin, 'claude')
  writeFileSync(cli, '#!/bin/sh\n', { mode: 0o644 })
  assert.throws(() => setConfigValue(root, 'claude.cli', cli), /not an executable file/)
  chmodSync(cli, 0o755)
  assert.equal(setConfigValue(root, 'claude.cli', cli).claude.cli, cli)
  assert.throws(() => setConfigValue(root, 'claude.cli', bin), /not an executable file/)
  assert.throws(() => setConfigValue(root, 'claude.cli', join(bin, 'gone')), /not an executable/)
  assert.throws(() => setConfigValue(root, 'claude.cli', `${cli}\n`), /control characters/)
  assert.throws(() => setConfigValue(root, 'claude.cli', 'claude'), /absolute path/)
  assert.equal(setConfigValue(root, 'claude.cli', 'null').claude.cli, null)
  const gone = readConfig(await rootWith({ claude: { cli: '/nowhere/claude' } }))
  assert.deepEqual([gone.config.claude.cli, gone.errors], ['/nowhere/claude', []])
  const bell = readConfig(await rootWith({ claude: { cli: '/x/cl\u0007aude' } }))
  assert.deepEqual([bell.config.claude.cli, bell.errors.length], [null, 1])
})

test('config: ANYENGINE_ROOT is an absolute path, and anything else is refused', () => {
  const fallback = join(homedir(), '.anyengine')
  for (const named of ['', '  ']) assert.equal(anyengineRoot({ ANYENGINE_ROOT: named }), fallback)
  assert.equal(anyengineRoot({}), fallback)
  assert.equal(anyengineRoot({ ANYENGINE_ROOT: ' /x/y/../z/ ' }), '/x/z')
  for (const named of ['relative/dir', '~', '~/x', './x']) {
    assert.throws(
      () => anyengineRoot({ ANYENGINE_ROOT: named }),
      /ANYENGINE_ROOT must be an absolute path/,
    )
  }
})

test('config: set keeps the root private and whole numbers in bounds', async () => {
  const root = await tempDir('anyengine-config-')
  chmodSync(root, 0o755)
  setConfigValue(root, 'smoke.hour', '23')
  assert.equal(statSync(root).mode & 0o777, 0o700)
  const fresh = join(await tempDir('anyengine-config-'), 'nested', 'root')
  setConfigValue(fresh, 'smoke.hour', '0')
  assert.equal(statSync(fresh).mode & 0o777, 0o700)
  for (const bad of ['24', '-1', '1.5', 'x']) {
    assert.throws(() => setConfigValue(root, 'smoke.hour', bad), /0 to 23/, bad)
  }
  for (const bad of ['0', '101']) {
    assert.throws(() => setConfigValue(root, 'claims.unclaimedFlipThreshold', bad), /1 to 100/)
  }
  for (const good of [1, 100]) {
    const next = setConfigValue(root, 'claims.unclaimedFlipThreshold', String(good))
    assert.equal(next.claims.unclaimedFlipThreshold, good)
  }
  assert.equal(readConfig(root).config.smoke.hour, 23)
})

test('config: loadConfig re-reads a changed file and hands out frozen settings', async () => {
  const root = await tempDir('anyengine-config-')
  const path = enginePaths(root).config
  const then = new Date(1_700_000_000_000)
  writeJsonAtomic(path, { router: { port: 20000 } })
  utimesSync(path, then, then)
  const first = loadConfig(root)
  assert.equal(first.router.port, 20000)
  assert.equal(loadConfig(root), first, 'an unchanged file is not read again')
  assert.ok(Object.isFrozen(first.router) && Object.isFrozen(first.claude.models[0]))
  assert.throws(() => {
    ;(first.router as { port: number }).port = 1
  }, TypeError)
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.claude.models))
  writeJsonAtomic(path, { router: { port: 20001 } })
  utimesSync(path, then, then)
  assert.equal(loadConfig(root).router.port, 20001, 'replaced: same size and mtime, new inode')
  writeFileSync(path, readFileSync(path, 'utf8').replace('20001', '20002'))
  utimesSync(path, then, then)
  assert.equal(loadConfig(root).router.port, 20002, 'rewritten in place: same size and mtime')
  writeFileSync(path, '{"router":{"port":3000}}')
  assert.equal(loadConfig(root).router.port, 3000)
  assert.equal(loadConfig(root).router.port, 3000)
  setConfigValue(root, 'router.port', '3001')
  assert.equal(loadConfig(root).router.port, 3001, 'a set is seen at once')
})

test('config: writeJsonAtomic leaves no temp file when a step fails', async () => {
  const dir = await tempDir('anyengine-config-')
  assert.throws(() => writeJsonAtomic(join(dir, 'a.json'), { n: 1n }), TypeError)
  mkdirSync(join(dir, 'busy.json'))
  writeFileSync(join(dir, 'busy.json', 'keep'), '')
  assert.throws(() => writeJsonAtomic(join(dir, 'busy.json'), {}))
  assert.deepEqual(readdirSync(dir), ['busy.json'])
  writeJsonAtomic(join(dir, 'a.json'), { ok: true })
  assert.equal(statSync(join(dir, 'a.json')).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')), { ok: true })
})

// Each writer waits at a barrier, then sets its own key over and over.
const WRITER = `
import { existsSync } from 'node:fs'
const [module, root, go, key, from, count] = process.argv.slice(1)
const { setConfigValue } = await import(module)
process.stdout.write('ready\\n')
const giveUp = Date.now() + 30000
while (!existsSync(go) && Date.now() < giveUp) await new Promise((r) => setTimeout(r, 5))
for (let i = 0; i < Number(count); i++) setConfigValue(root, key, String(Number(from) + i))
`

async function ready(child: ChildProcess): Promise<void> {
  let seen = ''
  await new Promise<void>((resolve, reject) => {
    const giveUp = setTimeout(() => reject(new Error(`no ready line: ${seen}`)), 30_000)
    child.stdout?.on('data', (chunk) => {
      seen += String(chunk)
      if (seen.includes('ready')) {
        clearTimeout(giveUp)
        resolve()
      }
    })
  })
}

test('config: sets from several processes at once all land', async () => {
  const root = await tempDir('anyengine-config-')
  const go = join(root, 'go')
  const module = new URL('../src/anyengine-config.mjs', import.meta.url).href
  const count = 8
  const writers: Array<[string, number]> = [
    ['claims.graceMs', 100],
    ['claims.idleReleaseMinutes', 100],
    ['claims.unclaimedFlipThreshold', 10],
    ['smoke.hour', 1],
    ['smoke.minute', 1],
    ['router.port', 20000],
  ]
  const children = writers.map(([key, from]) =>
    spawn(
      process.execPath,
      ['--input-type=module', '-e', WRITER, module, root, go, key, String(from), String(count)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  )
  const stderr: string[] = children.map(() => '')
  children.forEach((child, i) => {
    child.stderr?.on('data', (chunk) => {
      stderr[i] += String(chunk)
    })
  })
  const exits = children.map((child) => once(child, 'exit'))
  await Promise.all(children.map(ready))
  writeFileSync(go, '')
  const codes = (await Promise.all(exits)).map(([code]) => code)
  assert.deepEqual(
    codes,
    writers.map(() => 0),
    stderr.join('\n'),
  )
  const { config, errors } = readConfig(root)
  assert.deepEqual(errors, [])
  for (const [key, from] of writers)
    assert.equal(getConfigValue(config, key), from + count - 1, key)
})

// Round after round, every writer sets its key once, all at once, while a
// lock and a takeover lock a dead process left (pid 99999999 never exists on
// macOS) are in the way.
const ROUNDS_WRITER = `
import { existsSync } from 'node:fs'
import { join } from 'node:path'
const [module, root, key, from, rounds] = process.argv.slice(1)
const { setConfigValue } = await import(module)
process.stdout.write('ready\\n')
for (let r = 1; r <= Number(rounds); r++) {
  const giveUp = Date.now() + 30000
  while (!existsSync(join(root, 'go-' + r)) && Date.now() < giveUp) await new Promise((res) => setTimeout(res, 2))
  if (!existsSync(join(root, 'go-' + r))) throw new Error('round barrier timed out: ' + r)
  setConfigValue(root, key, String(Number(from) + r))
  process.stdout.write('done ' + r + '\\n')
}
`

async function untilOutput(child: ChildProcess, seen: () => string, text: string): Promise<void> {
  const giveUp = Date.now() + 30_000
  while (!seen().includes(text)) {
    if (child.exitCode !== null || Date.now() > giveUp)
      throw new Error(`no "${text.trim()}" (exit ${child.exitCode}): ${seen()}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('config: sets from several processes get past a lock a dead process left', async () => {
  const root = await tempDir('anyengine-config-')
  const lock = `${enginePaths(root).config}.lock`
  const module = new URL('../src/anyengine-config.mjs', import.meta.url).href
  const rounds = 20
  const writers: Array<[string, number]> = [
    ['claims.graceMs', 100],
    ['claims.idleReleaseMinutes', 100],
    ['claims.unclaimedFlipThreshold', 0],
    ['smoke.hour', 0],
    ['smoke.minute', 0],
    ['router.port', 20000],
  ]
  const out = writers.map(() => '')
  const children = writers.map(([key, from], i) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', ROUNDS_WRITER, module, root, key, String(from), String(rounds)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    child.stdout?.on('data', (chunk) => {
      out[i] += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      out[i] += String(chunk)
    })
    return child
  })
  const exits = children.map((child) => once(child, 'exit'))
  await Promise.all(children.map((child, i) => untilOutput(child, () => out[i] ?? '', 'ready\n')))
  const lost: string[] = []
  const leaked: string[] = []
  let gateInode: number | undefined
  for (let r = 1; r <= rounds; r++) {
    for (const left of [lock, `${lock}.takeover`]) {
      if (existsSync(left)) leaked.push(`before round ${r}: ${left}`)
    }
    writeFileSync(lock, '99999999\n')
    writeFileSync(`${lock}.takeover`, '99999999\n')
    writeFileSync(join(root, `go-${r}`), '')
    await Promise.all(
      children.map((child, i) => untilOutput(child, () => out[i] ?? '', `done ${r}\n`)),
    )
    const { config } = readConfig(root)
    const gate = statSync(`${lock}.sqlite`)
    gateInode ??= gate.ino
    assert.equal(gate.ino, gateInode, 'every round uses the same coordination inode')
    assert.equal(gate.size, 0, 'coordination never grows with rounds')
    for (const [key, from] of writers) {
      if (getConfigValue(config, key) !== from + r) lost.push(`round ${r}: ${key}`)
    }
  }
  assert.deepEqual(
    (await Promise.all(exits)).map(([code]) => code),
    writers.map(() => 0),
  )
  assert.deepEqual(lost, [])
  assert.deepEqual(leaked, [])
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith('config.json.')),
    ['config.json.lock.sqlite'],
    'only the bounded persistent gate remains; no lock, aside, temp or journal',
  )
  const db = new DatabaseSync(`${lock}.sqlite`, { timeout: 0 })
  try {
    db.exec('BEGIN IMMEDIATE; ROLLBACK')
  } finally {
    db.close()
  }
})

test('config: a problem in a setting the native proof depends on turns native fan-out off', async () => {
  const dropped = await tempDir('anyengine-config-')
  setConfigValue(dropped, 'claude.spawnPriority', '["sonnet","haiku"]')
  setConfigValue(dropped, 'claude.models', '[{"id":"sonnet"},{"id":"haiku"}]')
  assert.equal(readConfig(dropped).config.router.multiAgentV1, true)
  const file = JSON.parse(readFileSync(enginePaths(dropped).config, 'utf8'))
  file.claude.models[0].contextWindow = 5
  writeFileSync(enginePaths(dropped).config, JSON.stringify(file))
  const damaged = readConfig(dropped)
  assert.ok(
    damaged.config.claude.models.some((m) => m.id === 'opus'),
    'the default models are back',
  )
  assert.equal(damaged.config.router.multiAgentV1, false, 'so native fan-out is off')
  assert.equal(loadConfig(dropped).router.multiAgentV1, false)
  const shaping: unknown[] = [
    { claude: 'x' },
    { modes: 1 },
    { claims: [] },
    { modes: { codexClaude: 'both' } },
    { modes: { codexGrok: 'agent' } },
    { claims: { graceMs: -1 } },
    { claims: { graceMS: 1 } },
    { claude: { spawnPriority: ['nope'] } },
    { claude: { models: [{ id: 'gpt-6-sol' }] } },
    { version: 2 },
    // A name AnyEngine does not know, anywhere but under smoke: a typo may
    // be the setting the operator meant to change.
    { router: { multiagentV1: false } },
    { router: { MultiAgentV1: false } },
    { router: { enable: false } },
    { claude: { Models: [{ id: 'sonnet' }] } },
    { claude: { spawnpriority: ['haiku'] } },
    { claude: { clii: '/x' } },
    { Claude: { models: [{ id: 'sonnet' }] } },
    { Router: { multiAgentV1: false } },
    { mode: { codexClaude: 'model' } },
    { later: {} },
  ]
  const withV1 = (config: Record<string, unknown>) =>
    rootWith({ ...config, router: { multiAgentV1: true, ...(config.router as object) } })
  for (const config of shaping) {
    const root = await withV1(config as Record<string, unknown>)
    assert.equal(readConfig(root).config.router.multiAgentV1, false, JSON.stringify(config))
  }
  const elsewhere: unknown[] = [
    { smoke: { hour: 99 } },
    { smoke: { hours: 4 } },
    { claude: { cli: 'relative' } },
    { router: { port: 'x' } },
    { version: 1 },
  ]
  for (const config of elsewhere) {
    const root = await withV1(config as Record<string, unknown>)
    assert.equal(readConfig(root).config.router.multiAgentV1, true, JSON.stringify(config))
  }
})

test('config: a refused set leaves the root as it was, and a stale lock does not block', async () => {
  const parent = await tempDir('anyengine-config-')
  const missing = join(parent, 'root')
  assert.throws(() => setConfigValue(missing, 'smoke.hour', '99'), /0 to 23/)
  assert.throws(() => setConfigValue(missing, 'router.upstream', 'https://x.example/'), /chatgpt/)
  assert.equal(existsSync(missing), false, 'a refused set creates no root')
  const open = await tempDir('anyengine-config-')
  chmodSync(open, 0o755)
  assert.throws(() => setConfigValue(open, 'claims.graceMs', '-1'), /0 to 30000/)
  assert.equal(statSync(open).mode & 0o777, 0o755, 'a refused set does not chmod the root')
  assert.deepEqual(readdirSync(open), [], 'a refused set creates no gate or other artifact')
  writeFileSync(`${enginePaths(open).config}.lock`, '1\n')
  const then = new Date(Date.now() - 120_000)
  utimesSync(`${enginePaths(open).config}.lock`, then, then)
  assert.equal(setConfigValue(open, 'smoke.hour', '5').smoke.hour, 5, 'a lock from long ago')
  assert.equal(statSync(open).mode & 0o777, 0o700)
  assert.equal(existsSync(`${enginePaths(open).config}.lock`), false)
})

// Lossy UTF-8 decoding would accept this absolute path and recode it on set.
test('invalid UTF-8 in an accepted config string disables routing and refuses before artifacts', async () => {
  const root = await tempDir('config-encoding-')
  const path = enginePaths(root).config
  const bytes = Buffer.concat([
    Buffer.from('{"version":1,"claude":{"cli":"/private/fixture-'),
    Buffer.from([0xff]),
    Buffer.from('"},"smoke":{"hour":3}}'),
  ])
  assert.doesNotThrow(() => JSON.parse(bytes.toString('utf8')))
  writeFileSync(path, bytes)
  chmodSync(root, 0o755)
  const before = readdirSync(root)
  const read = readConfig(root)
  assert.ok(read.errors.length > 0)
  assert.equal(read.config.router.enabled, false)
  assert.equal(read.config.router.multiAgentV1, false)
  assert.throws(() => setConfigValue(root, 'smoke.hour', '4'), /UTF-8|encoding/i)
  assert.deepEqual(readFileSync(path), bytes)
  assert.deepEqual(readdirSync(root), before, 'no lock, SQLite gate or temp artifacts')
  assert.equal(statSync(root).mode & 0o777, 0o755, 'root was not tightened')
})

test('valid encoded replacement character survives unrelated config set', async () => {
  const root = await rootWith({ version: 1, claude: { cli: '/private/fixture-\uFFFD' } })
  assert.deepEqual(readConfig(root).errors, [])
  setConfigValue(root, 'smoke.hour', '4')
  assert.equal(
    JSON.parse(readFileSync(enginePaths(root).config, 'utf8')).claude.cli,
    '/private/fixture-\uFFFD',
  )
})

test('oversized config are present errors and cannot create mutation artifacts', async () => {
  const root = await tempDir('config-bounds-')
  const path = enginePaths(root).config
  const bytes = Buffer.from(`{"smoke":{"gptModel":"${'x'.repeat(2_000_000)}"}}`)
  writeFileSync(path, bytes)
  assert.ok(readConfig(root).errors.length)
  assert.throws(() => setConfigValue(root, 'smoke.hour', '4'))
  assert.deepEqual(readFileSync(path), bytes)
  assert.deepEqual(readdirSync(root), ['config.json'])
})

test('invalid UTF-8 setter independently refuses recoding before root/lock/temp changes', async () => {
  const root = await tempDir('config-encoding-set-')
  const path = enginePaths(root).config
  const bytes = Buffer.concat([
    Buffer.from('{"claude":{"cli":"/private/'),
    Buffer.from([0xff]),
    Buffer.from('"}}'),
  ])
  writeFileSync(path, bytes)
  chmodSync(root, 0o755)
  assert.throws(() => setConfigValue(root, 'smoke.hour', '4'), /UTF-8|encoding/i)
  assert.deepEqual(readFileSync(path), bytes)
  assert.deepEqual(readdirSync(root), ['config.json'])
  assert.equal(statSync(root).mode & 0o777, 0o755)
})

test('set refuses a compact valid unknown payload whose published pretty bytes exceed read limit', async () => {
  const root = await tempDir('config-published-size-')
  const path = enginePaths(root).config
  const bytes = Buffer.from(
    JSON.stringify({ version: 1, future: { payload: Array(300_000).fill(0) } }),
  )
  assert.ok(bytes.length < 2_000_000)
  writeFileSync(path, bytes)
  chmodSync(root, 0o755)
  assert.throws(() => setConfigValue(root, 'smoke.hour', '4'), /byte|size|limit/i)
  assert.deepEqual(readFileSync(path), bytes)
  assert.deepEqual(readdirSync(root), ['config.json'])
  assert.equal(statSync(root).mode & 0o777, 0o755)
})

test('dangling config is an error and cannot authorize creation of a root or gate', async () => {
  const root = await tempDir('config-dangling-')
  const path = enginePaths(root).config
  symlinkSync(join(root, 'absent'), path)
  assert.ok(readConfig(root).errors.length)
  assert.throws(() => setConfigValue(root, 'smoke.hour', '4'))
  assert.deepEqual(readdirSync(root), ['config.json'])
  assert.equal(existsSync(join(root, 'absent')), false)
})
