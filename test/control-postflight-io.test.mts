import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { DEFAULT_CONFIG, writeJsonAtomic } from '../src/anyengine-config.mjs'
import { realFlipDeps } from '../src/control-postflight.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

test('real observation adapters pass explicit configured paths and preserve failures', async () => {
  const home = await tempDir('io-')
  const root = join(home, 'chosen-root')
  const lib = join(root, 'lib/v1')
  const files = ['dist/src/adapter.mjs', 'scripts/lib-verify.mjs']
  for (const file of files) {
    mkdirSync(join(lib, file, '..'), { recursive: true })
    writeFileSync(join(lib, file), '// admitted fixture\n')
  }
  writeJsonAtomic(join(lib, 'install-manifest.json'), {
    version: 'v1',
    links: {},
    files: Object.fromEntries(
      files.map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(join(lib, file)))
          .digest('hex'),
      ]),
    ),
  })
  const system = fakeSystem(home)
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = []
  system.exec = (command, args, options) => {
    calls.push({ command, args, env: options?.env })
    return { status: 1, stdout: 'observed failure', stderr: 'an app update is staged' }
  }
  const deps = realFlipDeps(system, root, lib)
  assert.deepEqual(deps.preflip(17), {
    quiet: false,
    staged: true,
    text: 'observed failurean app update is staged',
  })
  assert.match(deps.verifyLib(lib)[0] ?? '', /observed failure/)
  assert.deepEqual(calls[0]?.args.slice(0, 3), [
    join(lib, 'scripts/preflip-check.mjs'),
    '--quiet-seconds',
    '17',
  ])
  assert.equal(calls[0]?.env?.ANYENGINE_ROOT, root)
  assert.equal(calls[0]?.env?.ANYENGINE_CHATGPT_APP, system.app)
  assert.equal(calls[0]?.env?.ANYENGINE_ADAPTER, join(lib, 'dist/src/adapter.mjs'))
  assert.equal(typeof deps.mandatoryGate, 'function')
  assert.equal(typeof deps.smoke, 'function')
  await assert.rejects(deps.smoke!(['gpt']), /lib|identity|version|unknown/)
  await assert.rejects(
    deps.mandatoryGate!({} as never, () => {
      throw new Error('must not observe before admission')
    }),
    /lib|identity|version|unknown/,
  )
  assert.equal(
    calls.some((call) => call.args.includes('app-server')),
    false,
  )
})

test('real HTTP health distinguishes refusal from timeout, HTTP, byte and fatal UTF8 failures', async () => {
  const home = await tempDir('io-')
  const root = join(home, 'root')
  let response: Buffer | null = Buffer.from('{"ok":true}')
  let status = 200
  const server = http.createServer((_request, reply) => {
    if (response) {
      reply.writeHead(status)
      reply.end(response)
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const config = structuredClone(DEFAULT_CONFIG)
  config.router.port = address.port
  writeJsonAtomic(join(root, 'config.json'), config)
  const deps = realFlipDeps(fakeSystem(home), root, join(root, 'lib/v1'))
  try {
    assert.deepEqual(await deps.routerHealth(1000), { ok: true })
    status = 503
    await assert.rejects(deps.routerHealth(1000), /HTTP 503/)
    status = 200
    response = Buffer.from([0xff])
    await assert.rejects(deps.routerHealth(1000), /encoded data/)
    response = Buffer.alloc(128_001, 32)
    await assert.rejects(deps.routerHealth(1000), /byte limit/)
    response = null
    await assert.rejects(deps.routerHealth(30), /timeout/)
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
  }
  assert.equal(await deps.routerHealth(1000), null)
})

test('real claim ping validates current PID, rejects malformed/silent replies and joins socket close', async () => {
  const root = await tempDir('p-')
  mkdirSync(join(root, 'run'))
  const path = join(root, 'run/claim-7.sock')
  let response: string | null = '{"type":"pong","pid":7,"threads":0}\n'
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', () => {
      if (response) socket.end(response)
    })
  })
  await new Promise<void>((done) => server.listen(path, done))
  const deps = realFlipDeps(fakeSystem(root), root, join(root, 'lib/v1'))
  try {
    assert.equal(await deps.claimPing(7), true)
    response = '{"type":"pong","pid":8,"threads":0}\n'
    assert.equal(await deps.claimPing(7), false)
    response = 'malformed\n'
    assert.equal(await deps.claimPing(7), false)
    response = null
    assert.equal(await deps.claimPing(7), false)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((done) => server.close(() => done()))
  }
  assert.equal(await deps.claimPing(7), false)
})

test('real app logs select only the newest two files and requested timestamps', async () => {
  const home = await tempDir('io-')
  const dir = join(home, 'Library/Logs/com.openai.codex/2026/10/01')
  mkdirSync(dir, { recursive: true })
  for (const index of [1, 2, 3]) {
    const file = join(dir, `${index}.log`)
    writeFileSync(file, `2026-09-30T00:00:00Z old\n2026-10-01T00:00:00Z file-${index}\n`)
    utimesSync(file, index, index)
  }
  const deps = realFlipDeps(fakeSystem(home), join(home, 'root'), join(home, 'lib'))
  assert.deepEqual(deps.appLog(new Date('2026-10-01T00:00:00Z')), [
    '2026-10-01T00:00:00Z file-3',
    '2026-10-01T00:00:00Z file-2',
  ])
})

for (const bad of [Buffer.from([0xff]), Buffer.from('{}'), Buffer.alloc(2_000_001, 32)])
  test(`real current snapshot refuses invalid manifest bytes/schema (${bad.length}) unchanged`, async () => {
    const home = await tempDir('io-')
    const root = join(home, 'root')
    const lib = join(root, 'lib/v1')
    mkdirSync(lib, { recursive: true })
    symlinkSync('v1', join(root, 'lib/current'))
    const path = join(lib, 'install-manifest.json')
    writeFileSync(path, bad)
    const deps = realFlipDeps(fakeSystem(home), root, lib)
    assert.throws(() => deps.currentSnapshot())
    assert.deepEqual(readFileSync(path), bad)
  })
