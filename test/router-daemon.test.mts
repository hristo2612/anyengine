import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { DEFAULT_CONFIG, enginePaths, readConfig } from '../src/anyengine-config.mjs'
import { keepTrimmed, launchdLogOf, trimInPlace } from '../src/router-log.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { startFakeBackend } from './helpers/fake-backend.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const adapter = resolve('dist/src/adapter.mjs')
const closers: Array<() => Promise<void>> = []
after(async () => {
  await killChildren()
  for (const close of closers.splice(0).reverse()) await close()
  await removeTempDirs()
})

const SECRET = `Bearer ${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"sub":"fixture"}').toString('base64url')}.test-signature`

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const giveUp = Date.now() + 30_000
  while (!(await check())) {
    if (Date.now() > giveUp) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

// An ephemeral port nothing holds right now: the daemon never binds the
// real router port in a test.
async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((ok) => server.close(() => ok()))
  assert.notEqual(port, DEFAULT_CONFIG.router.port)
  return port
}

// A root whose config.json names that port and a loopback upstream.
async function rootFor(port: number, upstream: string): Promise<string> {
  const root = await tempDir('anyengine-routerd-')
  mkdirSync(enginePaths(root).logs, { recursive: true })
  writeFileSync(
    enginePaths(root).config,
    JSON.stringify({ version: 1, router: { port, upstream } }),
  )
  const { config, errors } = readConfig(root)
  assert.deepEqual(errors, [])
  assert.equal(config.router.port, port)
  return root
}

test('router daemon: serves its configured loopback port, relays GPT, bounds its launchd log, stops on SIGTERM', async () => {
  const backend = await startFakeBackend()
  closers.push(() => backend.close())
  const port = await freePort()
  const root = await rootFor(port, backend.url)
  const logs = enginePaths(root).logs
  const launchdLog = join(logs, 'router.launchd.log')
  writeFileSync(launchdLog, `${'an old crash line\n'.repeat(20_000)}LAST\n`)
  const inode = statSync(launchdLog).ino
  // Where the adapter would write if the router ever did: both stay empty.
  const elsewhere = await tempDir('anyengine-routerd-elsewhere-')
  const child = spawn(process.execPath, [adapter, 'router'], {
    env: {
      ...process.env,
      ANYENGINE_ROOT: root,
      ANYENGINE_LAUNCHD_LOG: launchdLog,
      CODEX_HOME: join(elsewhere, 'codex'),
      ANYENGINE_DEBUG_LOG: join(elsewhere, 'debug.jsonl'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk
  })
  const health = `http://127.0.0.1:${port}/health`
  await until(async () => {
    try {
      return (await fetch(health)).ok
    } catch {
      return false
    }
  }, 'the daemon to answer /health')
  const body = (await (await fetch(health)).json()) as { pid: number; ok: boolean }
  assert.equal(body.pid, child.pid)
  const answer = await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: SECRET },
    body: '{"model":"gpt-6-sol","input":[]}',
  })
  assert.equal(answer.status, 200)
  assert.match(await answer.text(), /response\.completed/)
  assert.equal(backend.requests[0]?.headers.authorization, SECRET)
  // Trimmed as the router started, in place, keeping the newest lines.
  assert.ok(statSync(launchdLog).size <= 204_800, 'launchd log bounded')
  assert.equal(statSync(launchdLog).ino, inode, 'same inode')
  assert.ok(readFileSync(launchdLog, 'utf8').endsWith('LAST\n'))
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const [code] = await exited
  assert.equal(code, 0, stderr)
  const log = readFileSync(join(logs, 'router.jsonl'), 'utf8')
  assert.match(log, /"event":"router\.start"/)
  assert.match(log, /"event":"router\.stop","signal":"SIGTERM"/)
  assert.ok(!log.includes('eyJ'), 'no credential in the router log')
  assert.deepEqual(readdirSync(elsewhere), [], 'the router wrote nothing outside its root')
  assert.deepEqual(readdirSync(root).sort(), ['broker', 'config.json', 'logs', 'state'])
  assert.deepEqual(readdirSync(join(root, 'broker')), ['sources'])
  assert.deepEqual(readdirSync(join(root, 'broker/sources')), [])
  assert.deepEqual(readdirSync(join(root, 'state')), ['router-status.json'])
  const status = JSON.parse(readFileSync(join(root, 'state/router-status.json'), 'utf8'))
  assert.equal(status.port, port)
  assert.equal(status.fanout.path, 'bridge')
  assert.match(status.fanout.reason, /not proven/)
})

test('router daemon: relays direct whatever proxy the environment names, and warns when TLS checks are off', async () => {
  const backend = await startFakeBackend()
  closers.push(() => backend.close())
  // A proxy that answers everything it gets: with Node's env proxy on, the
  // global agents would send the bearer through it.
  const proxied: string[] = []
  const proxy = http.createServer((req, res) => {
    proxied.push(`${req.method} ${req.url}`)
    res.end('via proxy')
  })
  proxy.on('connect', (req, socket) => {
    proxied.push(`CONNECT ${req.url}`)
    socket.destroy()
  })
  await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', ok))
  closers.push(() => new Promise<void>((ok) => proxy.close(() => ok())))
  const address = proxy.address()
  const proxyUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const port = await freePort()
  const root = await rootFor(port, backend.url)
  const child = spawn(process.execPath, [adapter, 'router'], {
    env: {
      ...process.env,
      ANYENGINE_ROOT: root,
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: '',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk
  })
  const health = `http://127.0.0.1:${port}/health`
  await until(async () => {
    try {
      return (await fetch(health)).ok
    } catch {
      return false
    }
  }, 'the daemon to answer /health')
  const answer = await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: SECRET },
    body: '{"model":"gpt-6-sol","input":[]}',
  })
  assert.equal(answer.status, 200)
  assert.match(await answer.text(), /response\.completed/)
  assert.equal(backend.requests.length, 1, 'the upstream got the request itself')
  assert.equal(backend.requests[0]?.headers.authorization, SECRET)
  const models = await fetch(`http://127.0.0.1:${port}/backend-api/codex/models`, {
    headers: { authorization: SECRET },
  })
  assert.equal(models.status, 200)
  assert.deepEqual(await models.json(), { models: backend.models })
  assert.equal(backend.requests[1]?.headers.authorization, SECRET)
  assert.deepEqual(proxied, [], 'neither responses nor models went through the proxy')
  const faults = ((await (await fetch(health)).json()) as { faults: unknown }).faults
  assert.deepEqual(faults, { unhandledRejections: 0, hookErrors: 0 })
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
  assert.match(stderr, /WARNING: NODE_TLS_REJECT_UNAUTHORIZED=0/)
  const log = readFileSync(join(enginePaths(root).logs, 'router.jsonl'), 'utf8')
  assert.match(log, /"level":"error","event":"router\.tls-verification-off"/)
  assert.match(log, /"event":"router\.proxy-env-ignored"/)
})

test('router daemon: a port it cannot take is a non-zero exit, logged', async () => {
  const holder = net.createServer()
  await new Promise<void>((ok) => holder.listen(0, '127.0.0.1', ok))
  closers.push(() => new Promise<void>((ok) => holder.close(() => ok())))
  const address = holder.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const root = await rootFor(port, 'https://chatgpt.com/backend-api/codex')
  const child = spawn(process.execPath, [adapter, 'router'], {
    env: { ...process.env, ANYENGINE_ROOT: root },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const [code] = await once(child, 'exit')
  assert.notEqual(code, 0)
  const log = readFileSync(join(enginePaths(root).logs, 'router.jsonl'), 'utf8')
  assert.match(log, /"event":"router\.start-failed","reason":"EADDRINUSE"/)
})

test('router daemon: a relative ANYENGINE_ROOT is one line on stderr and a non-zero exit', async () => {
  const cwd = await tempDir('anyengine-routerd-cwd-')
  for (const named of ['relative/root', '~/.anyengine']) {
    const child = spawn(process.execPath, [adapter, 'router'], {
      cwd,
      env: { ...process.env, ANYENGINE_ROOT: named },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    const [code] = await once(child, 'exit')
    assert.equal(code, 78, named)
    assert.match(stderr, /^anyengine router: ANYENGINE_ROOT must be an absolute path/, named)
    assert.doesNotMatch(stderr, /\n\s+at /, 'no stack trace')
  }
  assert.deepEqual(readdirSync(cwd), [], 'nothing made under a relative root')
})

test('router daemon: the launchd log stays bounded while the router runs', async () => {
  const dir = await tempDir('anyengine-routerd-trim-')
  const path = join(dir, 'router.launchd.log')
  writeFileSync(path, '')
  const inode = statSync(path).ino
  const stop = keepTrimmed(path, 1000, 20)
  try {
    for (let round = 0; round < 3; round += 1) {
      appendFileSync(path, `${'y'.repeat(4000)}R${round}\n`)
      await until(() => statSync(path).size <= 1000, `round ${round} to be trimmed`)
      assert.ok(readFileSync(path, 'utf8').endsWith(`R${round}\n`))
    }
    assert.equal(statSync(path).ino, inode, 'same inode')
  } finally {
    stop()
  }
})

test('router daemon: it trims only a plain file directly in <root>/logs', async () => {
  const root = '/r'
  const named = (value: string) => launchdLogOf({ ANYENGINE_LAUNCHD_LOG: value }, root)
  assert.equal(named('/r/logs/router.launchd.log'), '/r/logs/router.launchd.log')
  assert.equal(named(' /r/logs/router.launchd.log '), '/r/logs/router.launchd.log')
  for (const bad of [
    '',
    'logs/router.launchd.log',
    '~/.anyengine/logs/router.launchd.log',
    '/r/logs',
    '/r/logs/../config.json',
    '/r/logs/sub/router.launchd.log',
    '/r/logsx/router.launchd.log',
    '/elsewhere/.zshrc',
  ]) {
    assert.equal(named(bad), null, bad)
  }
  assert.equal(launchdLogOf({}, root), null)
  // A link in logs/ to a file elsewhere: that file is never rewritten.
  const dir = await tempDir('anyengine-routerd-link-')
  const target = join(dir, 'precious.txt')
  writeFileSync(target, 'z'.repeat(5000))
  const link = join(dir, 'router.launchd.log')
  symlinkSync(target, link)
  trimInPlace(link, 1000)
  assert.equal(statSync(target).size, 5000)
  assert.equal(existsSync(join(dir, 'missing.log')), false)
  trimInPlace(join(dir, 'missing.log'), 1000)
  assert.equal(existsSync(join(dir, 'missing.log')), false, 'a missing log is not created')
})
