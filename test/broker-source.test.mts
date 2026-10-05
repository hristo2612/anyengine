import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const load = () => import('../src/' + 'broker-source.mjs')
const auth = { authMethod: 'chatgpt', authToken: 'fake-in-memory-only', requiresOpenaiAuth: true }
async function setup() {
  const root = await tempDir('bs-')
  const home = join(root, 'codex')
  mkdirSync(home, { mode: 0o700 })
  const calls: unknown[] = []
  const source = await (await load()).startBrokerSource({
    root,
    home,
    generation: 1,
    childId: 'child-A',
    pid: process.pid,
    request: async (...args: unknown[]) => {
      calls.push(args)
      return auth
    },
  })
  return { root, home, calls, source }
}

test('broker source publishes private metadata and exposes only the bounded auth RPC', async () => {
  const s = await setup()
  let client: {
    close(): Promise<void>
    request(
      method: 'getAuthStatus',
      params: { includeToken: true; refreshToken: boolean },
    ): Promise<unknown>
  } | null = null
  try {
    const { readBrokerSources, connectBrokerSource } = await load()
    const [meta] = readBrokerSources(s.root, { home: s.home, generation: 1 })
    assert.equal(meta.childId, 'child-A')
    assert.equal(meta.pid, process.pid)
    assert.equal(lstatSync(join(s.root, 'broker/sources')).mode & 0o777, 0o700)
    assert.equal(lstatSync(meta.socket).mode & 0o777, 0o600)
    const files = readdirSync(join(s.root, 'broker/sources'))
    const registration = files.find((name: string) => name.endsWith('.json'))
    assert.ok(registration)
    const bytes = readFileSync(join(s.root, 'broker/sources', registration), 'utf8')
    assert.deepEqual(Object.keys(JSON.parse(bytes)).sort(), [
      'childId',
      'generation',
      'home',
      'id',
      'pid',
      'socket',
    ])
    assert.equal(bytes.includes(auth.authToken), false)
    client = await connectBrokerSource(meta, () => {})
    assert.ok(client)
    assert.deepEqual(
      await client.request('getAuthStatus', { includeToken: true, refreshToken: false }),
      auth,
    )
    assert.deepEqual(s.calls, [['getAuthStatus', { includeToken: true, refreshToken: false }]])
    assert.equal(existsSync(join(s.home, 'auth.json')), false)
  } finally {
    await client?.close()
    await s.source.close()
  }
})

async function rejectedFrame(path: string, frame: string): Promise<string> {
  const socket = net.connect(path)
  socket.on('error', () => {})
  let output = ''
  socket.on('data', (bytes) => {
    output += bytes.toString('utf8')
  })
  const closed = new Promise<void>((done) => socket.once('close', () => done()))
  socket.once('connect', () => socket.write(frame))
  await closed
  return output
}

test('broker source refuses general RPCs and oversized frames without invoking Codex', async () => {
  const s = await setup()
  try {
    const [meta] = (await load()).readBrokerSources(s.root, { home: s.home, generation: 1 })
    await rejectedFrame(
      meta.socket,
      `${JSON.stringify({ id: 1, method: 'thread/start', params: {} })}\n`,
    )
    await rejectedFrame(meta.socket, `${'x'.repeat(32 * 1024 + 1)}\n`)
    assert.equal(s.calls.length, 0)
  } finally {
    await s.source.close()
  }
})

test('source closure invalidates a held request before its late bearer can return', async () => {
  const root = await tempDir('bh-')
  const home = join(root, 'codex')
  mkdirSync(home)
  let settle: (value: typeof auth) => void = () => {}
  let entered: () => void = () => {}
  const started = new Promise<void>((done) => {
    entered = done
  })
  const held = new Promise<typeof auth>((done) => {
    settle = done
  })
  const { startBrokerSource, readBrokerSources, connectBrokerSource } = await load()
  const source = await startBrokerSource({
    root,
    home,
    generation: 1,
    childId: 'held',
    pid: process.pid,
    request: async () => {
      entered()
      return held
    },
  })
  let invalidated = false
  const client = await connectBrokerSource(
    readBrokerSources(root, { home, generation: 1 })[0],
    () => {
      invalidated = true
    },
  )
  try {
    const pending = client.request('getAuthStatus', { includeToken: true, refreshToken: false })
    const rejected = assert.rejects(pending, /broker\.source-unavailable/)
    await started
    await source.close()
    await rejected
    assert.equal(invalidated, true)
    settle(auth)
    assert.deepEqual(readBrokerSources(root, { home, generation: 1 }), [])
  } finally {
    settle(auth)
    await client.close()
    await source.close()
  }
})

test('registration refuses symlink directories and discovers only the active canonical home', async () => {
  const root = await tempDir('broker-symlink-')
  const outside = await tempDir('broker-outside-')
  const home = join(root, 'codex')
  mkdirSync(home)
  symlinkSync(outside, join(root, 'broker'))
  const { startBrokerSource } = await load()
  await assert.rejects(
    startBrokerSource({
      root,
      home,
      generation: 1,
      childId: 'bad',
      pid: process.pid,
      request: async () => auth,
    }),
    /broker\.unsafe-directory/,
  )
  assert.deepEqual(readdirSync(outside), [])
})

test('discovery rejects wrong generation, wrong home, symlink metadata and public socket modes', async () => {
  const s = await setup()
  try {
    const { readBrokerSources } = await load()
    assert.deepEqual(readBrokerSources(s.root, { home: s.home, generation: 2 }), [])
    const other = await tempDir('broker-other-home-')
    assert.deepEqual(readBrokerSources(s.root, { home: other, generation: 1 }), [])
    const [meta] = readBrokerSources(s.root, { home: s.home, generation: 1 })
    const dir = join(s.root, 'broker/sources')
    symlinkSync(join(dir, `${meta.id}.json`), join(dir, 'linked.json'))
    assert.equal(readBrokerSources(s.root, { home: s.home, generation: 1 }).length, 1)
    chmodSync(meta.socket, 0o666)
    assert.deepEqual(readBrokerSources(s.root, { home: s.home, generation: 1 }), [])
  } finally {
    await s.source.close()
  }
})
