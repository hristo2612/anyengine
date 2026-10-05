import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { after, type TestContext } from 'node:test'
import { registerAdapterBrokerSource } from '../src/broker-adapter.mjs'
import { connectBrokerSource, readBrokerSources } from '../src/broker-source.mjs'
import { CodexUpstream } from '../src/codex-upstream.mjs'
import type { WireMessage } from '../src/types.mjs'
import { stopProcess } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

type ChildEvent =
  | { type: 'ready'; childId: string; pid: number }
  | { type: 'exit'; childId: string }
type ChildBoundUpstream = CodexUpstream & {
  onChildLifecycle(listener: (event: ChildEvent) => void): () => void
  requestForChild(
    childId: string,
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown>
}

// Hold the actual stdio initialize/RPC boundary. No auth file, socket or model
// backend exists; each replacement is a new real Node child of CodexUpstream.
const fake = String.raw`
import readline from 'node:readline'
const send = message => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n')
const notice = method => send({method,params:{pid:process.pid}})
let initialize, held, ignoreStop=false
process.on('SIGTERM',()=>{if(!ignoreStop)process.exit(0)})
const rl = readline.createInterface({input:process.stdin})
rl.on('line', line => {
  const message = JSON.parse(line)
  const {id,method,params} = message
  if(method==='initialize') {initialize=message;notice('fake/initialize-seen');return}
  if(method==='fake/release-initialize') {
    if(initialize.params?.fail) send({id:initialize.id,error:{code:-32000,message:'fake initialization failed'}})
    else send({id:initialize.id,result:{pid:process.pid}})
    initialize=null;return
  }
  if(method==='initialized') {notice('fake/initialized-seen');return}
  if(method==='fake/hold') {held=message;notice('fake/held-seen');return}
  if(method==='getAuthStatus') {held=message;notice('fake/held-seen');return}
  if(method==='fake/release-held') {send({id:held.id,result:{pid:process.pid,marker:'held-result'}});held=null;return}
  if(method==='fake/release-auth') {send({id:held.id,result:{authMethod:'chatgpt',authToken:'fake-memory-only',requiresOpenaiAuth:true}});held=null;return}
  if(method==='fake/exit') {process.exit(0)}
  if(method==='fake/ignore-stop') {ignoreStop=true;setInterval(()=>{},1000);notice('fake/ignoring-stop');return}
  if(id!=null) send({id,result:method==='fake/echo'?{pid:process.pid,marker:params.marker}:{}})
})
rl.once('close',()=>{if(!ignoreStop)process.exit(0)})
notice('fake/started')
`

function waitFor<T>(
  bus: EventEmitter,
  name: string,
  records: T[],
  predicate: (value: T) => boolean,
): Promise<T> {
  const found = records.find(predicate)
  if (found) return Promise.resolve(found)
  return new Promise((resolve, reject) => {
    const done = (value: T) => {
      if (!predicate(value)) return
      clearTimeout(timer)
      bus.off(name, done)
      resolve(value)
    }
    const timer = setTimeout(() => {
      bus.off(name, done)
      reject(new Error(`fake child did not reach ${name}`))
    }, 30_000)
    bus.on(name, done)
  })
}

async function harness(t: TestContext) {
  const root = await tempDir('cl-')
  const binary = join(root, 'fake.mjs')
  await writeFile(binary, fake)
  const bus = new EventEmitter()
  const messages: WireMessage[] = [],
    events: ChildEvent[] = [],
    pids = new Set<number>()
  const upstream = new CodexUpstream({
    binary,
    args: ['app-server'],
    env: { ...process.env, ANYENGINE_MOCK: '1' },
    onMessage(message) {
      messages.push(message)
      if ('method' in message && message.method === 'fake/started' && 'params' in message) {
        const pid = (message.params as { pid: number }).pid
        pids.add(pid)
      }
      bus.emit('message', message)
    },
    maxRestarts: 1,
  }) as ChildBoundUpstream
  t.after(async () => {
    await upstream.stop()
    for (const pid of pids) {
      await stopProcess(pid)
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'owned fake child joined')
    }
  })
  assert.equal(
    typeof upstream.onChildLifecycle,
    'function',
    'real-child lifecycle subscription exists',
  )
  upstream.onChildLifecycle((event) => {
    events.push(event)
    bus.emit('lifecycle', event)
  })
  const message = (method: string, pid?: number, exceptPid?: number) =>
    waitFor(
      bus,
      'message',
      messages,
      (value) =>
        'method' in value &&
        value.method === method &&
        (pid == null || ('params' in value && (value.params as { pid: number }).pid === pid)) &&
        (exceptPid == null ||
          ('params' in value && (value.params as { pid: number }).pid !== exceptPid)),
    )
  const lifecycle = (predicate: (value: ChildEvent) => boolean) =>
    waitFor(bus, 'lifecycle', events, predicate)
  return {
    root,
    upstream,
    events,
    message,
    lifecycle,
    async start() {
      upstream.start()
      if (upstream.pid) pids.add(upstream.pid)
      await message('fake/started')
    },
    async initialize(params: unknown = {}) {
      const answer = upstream.initialize(params)
      await message('fake/initialize-seen', upstream.pid ?? undefined)
      upstream.notify('fake/release-initialize', {})
      await answer
    },
  }
}

test('adapter sockets unregister held A on actual exit and register B only after internal handshake', async (t) => {
  const h = await harness(t)
  const home = join(h.root, 'h')
  mkdirSync(home, { mode: 0o700 })
  const account = { home, generation: 1 }
  const registration = registerAdapterBrokerSource({
    root: h.root,
    account: () => account,
    upstream: h.upstream,
    enabled: true,
  })
  t.after(() => registration.close())
  await h.start()
  await h.initialize()
  assert.deepEqual(readBrokerSources(h.root, account), [])
  h.upstream.markInitialized()
  await registration.settled()
  const [a] = readBrokerSources(h.root, account)
  assert.ok(a)
  const client = await connectBrokerSource(a, () => {})
  t.after(() => client.close())
  const held = assert.rejects(
    client.request('getAuthStatus', { includeToken: true, refreshToken: false }),
    /broker\.source-unavailable/,
  )
  await h.message('fake/held-seen', a.pid)
  h.upstream.notify('fake/exit', {})
  await h.lifecycle((event) => event.type === 'exit' && event.childId === a.childId)
  await registration.settled()
  await held
  assert.deepEqual(readBrokerSources(h.root, account), [])
  const bStarted = await h.message('fake/started', undefined, a.pid)
  assert.ok('params' in bStarted)
  const bPid = (bStarted.params as { pid: number }).pid
  await h.message('fake/initialize-seen', bPid)
  assert.deepEqual(readBrokerSources(h.root, account), [])
  h.upstream.notify('fake/release-initialize', {})
  await h.lifecycle((event) => event.type === 'ready' && event.pid === bPid)
  await registration.settled()
  const [b] = readBrokerSources(h.root, account)
  assert.ok(b)
  assert.notEqual(a.id, b.id)
  assert.notEqual(a.childId, b.childId)
  const replacement = await connectBrokerSource(b, () => {})
  t.after(() => replacement.close())
  const response = replacement.request('getAuthStatus', { includeToken: true, refreshToken: true })
  await h.message('fake/held-seen', b.pid)
  h.upstream.notify('fake/release-auth', {})
  assert.deepEqual(await response, {
    authMethod: 'chatgpt',
    authToken: 'fake-memory-only',
    requiresOpenaiAuth: true,
  })
  await h.upstream.stop()
  await registration.settled()
  assert.deepEqual(readBrokerSources(h.root, account), [])
})

test('real-child readiness waits for successful initialize and initialized; stop invalidates synchronously', async (t) => {
  const h = await harness(t)
  await h.start()
  assert.deepEqual([...h.events], [])
  const initialized = h.upstream.initialize({
    clientInfo: { name: 'lifecycle-test', version: '0' },
  })
  await h.message('fake/initialize-seen')
  assert.deepEqual([...h.events], [], 'held initialize cannot publish a broker-ready child')
  h.upstream.notify('fake/release-initialize', {})
  await initialized
  assert.deepEqual([...h.events], [], 'initialize response alone cannot publish readiness')
  h.upstream.markInitialized()
  const ready = h.events[0]
  assert.equal(ready?.type, 'ready')
  assert.ok(ready && ready.type === 'ready' && ready.childId && ready.pid === h.upstream.pid)
  h.upstream.markInitialized()
  assert.equal(h.events.length, 1, 'a repeated initialized notification cannot register twice')
  const stopping = h.upstream.stop()
  assert.deepEqual(h.events[1], { type: 'exit', childId: ready.childId })
  await stopping
  assert.equal(h.events.length, 2, 'the OS exit cannot emit a second invalidation')
})

test('a rejected initialize never publishes a broker-ready child', async (t) => {
  const h = await harness(t)
  await h.start()
  await assert.rejects(h.initialize({ fail: true }), /initialization failed/)
  h.upstream.markInitialized()
  assert.deepEqual([...h.events], [])
})

test('held A RPC rejects on internal restart; B receives a fresh ready identity after its handshake', async (t) => {
  const h = await harness(t)
  await h.start()
  await h.initialize()
  h.upstream.markInitialized()
  const a = h.events[0]
  assert.ok(a?.type === 'ready')
  const held = assert.rejects(
    h.upstream.requestForChild(a.childId, 'fake/hold', {}),
    /child|upstream|unavailable/i,
  )
  await h.message('fake/held-seen', a.pid)
  h.upstream.notify('fake/exit', {})
  await h.lifecycle((event) => event.type === 'exit' && event.childId === a.childId)
  await held
  const bStarted = await h.message('fake/started', undefined, a.pid)
  assert.ok('params' in bStarted)
  const bPid = (bStarted.params as { pid: number }).pid
  // Select replacement initialization by its PID, rather than a timing sleep.
  await h.message('fake/initialize-seen', bPid)
  assert.deepEqual(
    h.events.map((event) => event.type),
    ['ready', 'exit'],
  )
  h.upstream.notify('fake/release-initialize', {})
  const b = await h.lifecycle((event) => event.type === 'ready' && event.pid === bPid)
  assert.ok(b.type === 'ready')
  assert.notEqual(b.childId, a.childId)
  await assert.rejects(
    h.upstream.requestForChild(a.childId, 'fake/echo', { marker: 'wrong-child' }),
    /child|upstream|unavailable/i,
  )
  assert.deepEqual(await h.upstream.requestForChild(b.childId, 'fake/echo', { marker: 'B' }), {
    pid: bPid,
    marker: 'B',
  })
  assert.deepEqual(
    h.events.map((event) => event.type),
    ['ready', 'exit', 'ready'],
  )
})

test('a fulfilled A wire response is rejected if stop invalidates the child before the guarded await resumes', async (t) => {
  const h = await harness(t)
  await h.start()
  await h.initialize()
  h.upstream.markInitialized()
  const ready = h.events[0]
  assert.ok(ready?.type === 'ready')
  const request = h.upstream.request.bind(h.upstream)
  let stopping: Promise<void> | undefined
  t.mock.method(h.upstream, 'request', async (...args: Parameters<CodexUpstream['request']>) => {
    const result = await request(...args)
    if (args[0] === 'fake/hold') stopping = h.upstream.stop()
    return result
  })
  const held = assert.rejects(
    h.upstream.requestForChild(ready.childId, 'fake/hold', {}),
    /child|upstream|unavailable/i,
  )
  await h.message('fake/held-seen', ready.pid)
  h.upstream.notify('fake/release-held', {})
  await held
  await stopping
  assert.deepEqual(h.events[1], { type: 'exit', childId: ready.childId })
})

test('stop retains direct-child ownership until an escalated child actually closes', async (t) => {
  const h = await harness(t)
  await h.start()
  await h.initialize()
  h.upstream.markInitialized()
  const ready = h.events[0]
  assert.ok(ready?.type === 'ready')
  h.upstream.notify('fake/ignore-stop', {})
  await h.message('fake/ignoring-stop', ready.pid)
  const realKill = process.kill.bind(process)
  let requested!: () => void
  const killRequested = new Promise<void>((resolve) => {
    requested = resolve
  })
  // Hold only this owned child's escalation delivery. The real process stays
  // alive, so returning from stop before release is observably premature.
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === ready.pid && signal === 'SIGKILL') {
      requested()
      return true
    }
    return realKill(pid, signal)
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let completed = false
  const stopping = h.upstream.stop().then(() => {
    completed = true
  })
  try {
    t.mock.timers.tick(5_000)
    await killRequested
    await Promise.resolve()
    assert.equal(completed, false, 'sending SIGKILL is not direct-child closure')
    assert.equal(realKill(ready.pid, 0), true)
  } finally {
    t.mock.timers.reset()
    realKill(ready.pid, 'SIGKILL')
  }
  await stopping
  assert.throws(() => realKill(ready.pid, 0), { code: 'ESRCH' })
})
