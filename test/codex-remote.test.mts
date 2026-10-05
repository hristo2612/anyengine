import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmodSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import WebSocket from 'ws'
import { successfulPong } from '../src/smoke-client.mjs'
import { startWebSocketTransport } from '../src/transports.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(killChildren)
after(removeTempDirs)
const load = () => import('../src/' + 'codex-remote.mjs')
const adapterPath = resolve('dist/src/adapter.mjs')
async function environment() {
  const root = await tempDir('remote-')
  return {
    ...process.env,
    ANYENGINE_ROOT: root,
    ANYENGINE_HOME: join(root, 'adapter'),
    ANYENGINE_DEBUG_LOG: join(root, 'debug.jsonl'),
    ANYENGINE_RUNTIME_ENV: join(root, 'missing.env'),
    ANYENGINE_MOCK: '1',
    ANYENGINE_PS: '/bin/ps',
    ANYENGINE_RUNTIME_TYPE: 'mock',
    ANYENGINE_MODELS: 'haiku',
    ANYENGINE_NATIVE_CODEX: '',
    ANYENGINE_REAL_CODEX: resolve('test/fixtures/fake-codex-app-server.mjs'),
    FAKE_CODEX_NO_APPROVAL: '1',
  }
}
async function port(): Promise<number> {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const value = (server.address() as net.AddressInfo).port
  await new Promise<void>((done) => server.close(() => done()))
  return value
}
async function upgrade(url: string, headers: Record<string, string>): Promise<number> {
  const ws = new WebSocket(url, { headers, handshakeTimeout: 3000 })
  try {
    return await new Promise<number>((done, fail) => {
      ws.once('open', () => done(101))
      ws.once('unexpected-response', (request, response) => {
        response.resume()
        request.destroy()
        done(response.statusCode!)
      })
      ws.once('error', fail)
    })
  } finally {
    const closed = once(ws, 'close').catch(() => {})
    ws.terminate()
    await closed
  }
}
test('WS rejects every Origin, including empty, and exact bearer protects the run', async () => {
  const before = process.env.ANYENGINE_WS_TOKEN
  process.env.ANYENGINE_WS_TOKEN = 'run-only'
  const url = `ws://127.0.0.1:${await port()}`
  const server = await startWebSocketTransport(
    url,
    () => {},
    () => {},
  )
  try {
    for (const origin of ['', 'https://example.test', 'null'])
      assert.equal(await upgrade(url, { origin, authorization: 'Bearer run-only' }), 403)
    for (const authorization of ['', 'Bearer wrong', 'bearer run-only', 'Bearer run-only-extra'])
      assert.equal(await upgrade(url, { authorization }), 401)
    assert.equal(await upgrade(url, { authorization: 'Bearer run-only' }), 101)
  } finally {
    await server.close()
    if (before === undefined) delete process.env.ANYENGINE_WS_TOKEN
    else process.env.ANYENGINE_WS_TOKEN = before
  }
})
test('legacy unset token permits no-Origin only; explicit empty token never disables authentication', async () => {
  const before = process.env.ANYENGINE_WS_TOKEN
  try {
    for (const token of [undefined, '']) {
      if (token === undefined) delete process.env.ANYENGINE_WS_TOKEN
      else process.env.ANYENGINE_WS_TOKEN = token
      const url = `ws://127.0.0.1:${await port()}`
      const server = await startWebSocketTransport(
        url,
        () => {},
        () => {},
      )
      try {
        assert.equal(await upgrade(url, { origin: '' }), 403)
        assert.equal(await upgrade(url, {}), token === undefined ? 101 : 401)
        if (token === '') assert.equal(await upgrade(url, { authorization: 'Bearer ' }), 401)
      } finally {
        await server.close()
      }
    }
  } finally {
    if (before === undefined) delete process.env.ANYENGINE_WS_TOKEN
    else process.env.ANYENGINE_WS_TOKEN = before
  }
})
test('remote args retain user arguments and refuse remote endpoint or token overrides', async () => {
  const { codexRemoteArgs } = await load()
  assert.deepEqual(codexRemoteArgs('ws://127.0.0.1:5000', ['--model', 'opus', 'a b']), [
    '--remote',
    'ws://127.0.0.1:5000',
    '--remote-auth-token-env',
    'ANYENGINE_REMOTE_TOKEN',
    '--model',
    'opus',
    'a b',
  ])
  for (const args of [
    ['--remote', 'ws://elsewhere'],
    ['--remote=ws://elsewhere'],
    ['--remote-auth-token-env', 'OTHER'],
    ['--remote-auth-token-env=OTHER'],
  ])
    assert.throws(() => codexRemoteArgs('ws://127.0.0.1:5000', args), /reserved/)
})
test('launcher returns only a reachable guarded private adapter and closes its owned group', async () => {
  const { startRemoteAdapter } = await load()
  const launch = await startRemoteAdapter(adapterPath, await environment())
  try {
    assert.equal(await upgrade(launch.url, {}), 401)
    assert.equal(await upgrade(launch.url, { authorization: `Bearer ${launch.token}` }), 101)
  } finally {
    await launch.close()
  }
  assert.throws(() => process.kill(launch.adapter.pid, 0), { code: 'ESRCH' })
})
test('startup failure never accepts a readiness string without a listening owned endpoint', async () => {
  const { startRemoteAdapter } = await load()
  const env = await environment()
  const fake = join(env.ANYENGINE_ROOT, 'pretend.mjs')
  writeFileSync(
    fake,
    "process.stderr.write('[anyengine] listening on ws://127.0.0.1:1\\n');setInterval(()=>{},1000)\n",
  )
  await assert.rejects(startRemoteAdapter(fake, env), /startup|closed|listen|connect/)
})
test('startup abort and missing adapter reap the exact owned process', async () => {
  const { startRemoteAdapter } = await load()
  const env = await environment()
  await assert.rejects(
    startRemoteAdapter(join(env.ANYENGINE_ROOT, 'missing.mjs'), env),
    /startup|closed/,
  )
  const fake = join(env.ANYENGINE_ROOT, 'silent.mjs')
  writeFileSync(fake, "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\n")
  await assert.rejects(startRemoteAdapter(fake, env, { timeoutMs: 50 }), /timed out/)
  const controller = new AbortController()
  const launched = startRemoteAdapter(fake, env, { signal: controller.signal })
  const timer = setTimeout(() => controller.abort(), 500)
  await assert.rejects(launched, /abort/i).finally(() => clearTimeout(timer))
})
test('missing verified bearer support refuses launch', async () => {
  const { runCodexRemote } = await load()
  const env = await environment()
  const fake = join(env.ANYENGINE_ROOT, 'unsupported.mjs')
  writeFileSync(
    fake,
    `#!${process.execPath}\nconsole.log(process.argv.includes('--version')?'codex-cli 0.159.0':'--remote URL');\n`,
  )
  chmodSync(fake, 0o755)
  assert.equal(await runCodexRemote([], { adapterPath, codex: fake, env }), 1)
})

test('headless RPC correlates early terminal events and rejects failed turns containing PONG', async () => {
  const { RemoteClient } = await import('../../scripts/' + 'probe-remote-headless.mjs')
  const { startRemoteAdapter } = await load()
  const launch = await startRemoteAdapter(adapterPath, await environment())
  let client: InstanceType<typeof RemoteClient> | undefined
  try {
    await assert.rejects(RemoteClient.connect(launch.url, 'wrong'), /connect|authentication/)
    client = await RemoteClient.connect(launch.url, launch.token)
    await client.initialize()
    const started = await client.request('thread/start', { model: 'haiku', cwd: process.cwd() })
    const turn = await client.turn(started.thread.id, 'Reply with exactly PONG')
    assert.equal(turn.threadId, started.thread.id)
    assert.equal(turn.status, 'completed')
    assert.ok(turn.items.some((item: { type: string }) => item.type === 'agentMessage'))
    await client.releaseThread(started.thread.id, false)
    const pending = client.request('unsupported/wait', {})
    const rejected = assert.rejects(pending, /closed|failed/)
    await client.close()
    await rejected
  } finally {
    await client?.close()
    await launch.close()
  }
  const url = `ws://127.0.0.1:${await port()}`
  const server = await startWebSocketTransport(
    url,
    (peer, m: any) => {
      if (m.method === 'turn/start') {
        peer.send({
          method: 'turn/completed',
          params: { threadId: 'other', turn: { id: 't', status: 'completed' } },
        })
        peer.send({
          method: 'item/completed',
          params: { threadId: 'owned', turnId: 't', item: { type: 'agentMessage', text: 'PONG' } },
        })
        peer.send({
          method: 'turn/completed',
          params: {
            threadId: 'owned',
            turn: { id: 't', status: 'failed', error: { message: 'rejected' } },
          },
        })
        peer.send({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 't' } } })
      }
    },
    () => {},
  )
  try {
    client = await RemoteClient.connect(url, 'unused-on-legacy-test-server')
    const turn = await client.turn('owned', 'PONG', 2000)
    assert.equal(turn.status, 'failed')
    assert.equal(turn.text, 'PONG')
    assert.equal(successfulPong(turn), false)
  } finally {
    await client?.close()
    await server.close()
  }
})

async function fakeCli(env: Awaited<ReturnType<typeof environment>>, body = '') {
  const path = join(env.ANYENGINE_ROOT, 'vendor.mjs')
  writeFileSync(
    path,
    `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('codex-cli 0.159.0');process.exit(0)}\nif(process.argv.includes('--help')){console.log('--remote URL --remote-auth-token-env NAME');process.exit(0)}\nif(process.argv.some(a=>a.startsWith('generate-')))process.exit(0)\n${body}\n`,
  )
  chmodSync(path, 0o755)
  return path
}
async function runFixture(
  env: Awaited<ReturnType<typeof environment>>,
  codex: string,
  adapter: string,
  args: string[] = [],
) {
  const wrapper = join(env.ANYENGINE_ROOT, 'run.mjs')
  writeFileSync(
    wrapper,
    `import {runCodexRemote} from ${JSON.stringify(resolve('dist/src/codex-remote.mjs'))};process.exitCode=await runCodexRemote(${JSON.stringify(args)},{...${JSON.stringify({ adapterPath: adapter, codex })},env:process.env})\n`,
  )
  const child = spawn(process.execPath, [wrapper], { env, stdio: 'pipe' })
  const closed = once(child, 'close')
  let out = '',
    err = ''
  child.stdout!.on('data', (chunk) => {
    out += chunk
  })
  child.stderr!.on('data', (chunk) => {
    err += chunk
  })
  child.stdin!.end('original stdin\n')
  const timer = setTimeout(() => child.kill('SIGKILL'), 45_000)
  const [code] = await closed.finally(() => clearTimeout(timer))
  return { code, out, err }
}
test('typed schema rejection reaps private adapter then delegates unchanged argv/stdin exactly once', async () => {
  const env = { ...(await environment()), ANYENGINE_MOCK: '0', ANYENGINE_NATIVE_CODEX: '0' }
  const codex = await fakeCli(
    env,
    "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(2),input,token:!!process.env.ANYENGINE_REMOTE_TOKEN}));process.exitCode=23})",
  )
  const args = ['--model', 'gpt-literal', 'a b', '$unchanged']
  const result = await runFixture(env, codex, adapterPath, args)
  assert.equal(result.code, 23, result.err)
  assert.deepEqual(JSON.parse(result.out), { args, input: 'original stdin\n', token: false })
  assert.match(result.err, /schema admission failed/)
})
test('selected-identity refusal and unrelated exit 78 never authorize vendor fallback', async () => {
  const env = await environment()
  const codex = await fakeCli(env, "console.log('FORBIDDEN VENDOR LAUNCH')")
  for (const code of ['selected-binary-changed', 'ordinary']) {
    const fake = join(env.ANYENGINE_ROOT, `${code}.mjs`)
    writeFileSync(
      fake,
      `process.stderr.write('[anyengine] '+JSON.stringify({kind:'anyengine-startup-failure',pid:process.pid,code:${JSON.stringify(code)},codexPath:${JSON.stringify(codex)},fallback:'direct-cli-required'})+'\\n');process.exitCode=78`,
    )
    const result = await runFixture(env, codex, fake)
    assert.equal(result.code, 1, result.err)
    assert.equal(result.out, '')
  }
})

test('CLI pre-exec ownership gate refuses an aborted or changed target without executing it', async () => {
  const { startRemoteCli } = await load()
  const env = await environment()
  const fake = await fakeCli(env, "console.log('UNAUTHORIZED')")
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(
    startRemoteCli(fake, [], env, () => {}, abort.signal),
    /abort/,
  )
  await assert.rejects(
    startRemoteCli(
      fake,
      [],
      env,
      () => {
        throw new Error('identity changed')
      },
      new AbortController().signal,
    ),
    /identity changed/,
  )
})

test('fake PTY host preserves foreground/input/status and safely joins signal or stopped families', async () => {
  const env = await environment()
  const vendor = join(env.ANYENGINE_ROOT, 'terminal.py')
  writeFileSync(
    vendor,
    `#!/usr/bin/python3
import os,sys,json,signal,time,tty
if '--version' in sys.argv: print('codex-cli 0.159.0');sys.exit(0)
if '--help' in sys.argv: print('--remote URL --remote-auth-token-env NAME');sys.exit(0)
fd=os.open('/dev/tty',os.O_RDWR);os.close(fd)
print(json.dumps({'vendor':os.getpid(),'pgrp':os.getpgrp(),'session':os.getsid(0),'foreground':os.tcgetpgrp(0),'stdinTTY':os.isatty(0),'stdoutTTY':os.isatty(1),'args':sys.argv[1:]}),flush=True)
print('VENDOR_STDERR',file=sys.stderr,flush=True)
line=sys.stdin.readline().strip()
print(json.dumps({'input':line}),flush=True)
tty.setraw(0)
child=os.fork()
if child==0:
 signal.signal(signal.SIGTERM,signal.SIG_IGN)
 time.sleep(60)
 os._exit(0)
print(json.dumps({'descendant':child}),flush=True)
mode=os.environ['FAKE_TERMINAL_CASE']
if mode=='normal': os._exit(23)
if mode=='stopped': os.kill(os.getpid(),signal.SIGTSTP)
print('VENDOR_WAIT',flush=True)
while True: time.sleep(1)
`,
  )
  chmodSync(vendor, 0o755)
  const wrapper = join(env.ANYENGINE_ROOT, 'terminal.mjs')
  writeFileSync(
    wrapper,
    `import {spawnSync} from 'node:child_process';import {runCodexRemote} from ${JSON.stringify(resolve('dist/src/codex-remote.mjs'))};const code=await runCodexRemote(['--model','a b','$literal'],{adapterPath:${JSON.stringify(adapterPath)},codex:${JSON.stringify(vendor)},env:process.env});const r=spawnSync('/usr/bin/python3',['-c','import os;print(os.tcgetpgrp(0))'],{stdio:['inherit','pipe','pipe'],encoding:'utf8'});console.log(JSON.stringify({restored:Number(r.stdout),wrapper:process.pid,exit:code}));process.exitCode=code;`,
  )
  const driver = join(env.ANYENGINE_ROOT, 'terminal-control.py')
  writeFileSync(
    driver,
    `import os,pty,select,signal,sys,time,json,subprocess,termios
for mode,expected in [('normal',23),('SIGINT',130),('SIGTERM',143),('SIGHUP',129),('stopped',1)]:
 os.environ['FAKE_TERMINAL_CASE']=mode
 pid,fd=pty.fork()
 if pid==0:os.execv(sys.argv[1],[sys.argv[1],sys.argv[2]])
 terminal=termios.tcgetattr(fd)
 data=b'';sent=False;signalled=False;status=None;groups={pid};owned={pid};deadline=time.monotonic()+15
 try:
  while time.monotonic()<deadline:
   rows=[r.split() for r in subprocess.check_output(['/bin/ps','-axo','pid=,ppid=,pgid='],text=True).splitlines()]
   assert all(len(row)==3 and all(v.isdecimal() for v in row) for row in rows),'invalid numeric process row'
   for _ in range(5):
    for row in rows:
     p,parent,group=map(int,row[:3])
     if p in owned or parent in owned:
      owned.add(p)
      if group in owned:groups.add(group)
   if select.select([fd],[],[],.05)[0]:
    try:chunk=os.read(fd,65536)
    except OSError:chunk=b''
    data+=chunk
    if b'stdinTTY' in data and not sent:os.write(fd,b'original input\\n');sent=True
    if b'VENDOR_WAIT' in data and mode.startswith('SIG') and not signalled:os.kill(pid,getattr(signal,mode));signalled=True
   ended,value=os.waitpid(pid,os.WNOHANG)
   if ended:status=value;break
  assert status is not None,'terminal deadline'
  # Drain bytes already written before the process reaped.
  while select.select([fd],[],[],0)[0]:
   try:chunk=os.read(fd,65536)
   except OSError:break
   if not chunk:break
   data+=chunk
  text=data.decode();print(json.dumps({'case':mode,'status':status,'output':text}),flush=True)
  assert os.WIFEXITED(status) and os.WEXITSTATUS(status)==expected
  assert termios.tcgetattr(fd)==terminal,'terminal modes not restored'
  assert 'VENDOR_STDERR' in text and '[1]' not in text
  found=set()
  for line in text.splitlines():
   if not line.startswith('{'):continue
   row=json.loads(line)
   if 'vendor' in row:
    found.add('vendor');owned.add(row['vendor']);groups.add(row['pgrp'])
    assert row['stdinTTY'] and row['stdoutTTY'] and row['pgrp']==row['foreground'] and row['session']==pid
    assert row['args'][-3:]==['--model','a b','$literal']
   if 'input' in row:found.add('input');assert row['input']=='original input'
   if 'descendant' in row:owned.add(row['descendant'])
   if 'restored' in row:found.add('restored');assert row['restored']==pid and row['exit']==expected
  assert found=={'vendor','input','restored'}
  if mode=='stopped':assert 'without a confirmed vendor exit' in text and 'VENDOR_WAIT' not in text
  for p in owned:
   try:os.kill(p,0);raise AssertionError('surviving owned pid '+str(p))
   except ProcessLookupError:pass
 finally:
  for group in groups:
   try:os.killpg(group,signal.SIGKILL)
   except ProcessLookupError:pass
  if status is None:
   try:os.waitpid(pid,0)
   except ChildProcessError:pass
  os.close(fd)
`,
  )
  const child = spawn('/usr/bin/python3', [driver, process.execPath, wrapper], {
    env,
    stdio: 'pipe',
  })
  let output = ''
  child.stdout?.on('data', (bytes) => {
    output += bytes
  })
  child.stderr?.on('data', (bytes) => {
    output += bytes
  })
  const closed = once(child, 'close')
  const timer = setTimeout(() => child.kill('SIGKILL'), 85_000)
  const [code] = await closed.finally(() => clearTimeout(timer))
  assert.equal(code, 0, output)
})

test('confirmed vendor exits 1 and 78 preserve status without replay or false guardian diagnosis', async () => {
  const env = await environment()
  for (const code of [1, 78]) {
    const codex = await fakeCli(env, `console.log('VENDOR_ONCE');process.exitCode=${code}`)
    const result = await runFixture(env, codex, adapterPath)
    assert.equal(result.code, code, result.err)
    assert.equal(result.out, 'VENDOR_ONCE\n')
    assert.doesNotMatch(result.err, /without a confirmed|running the selected vendor CLI/)
  }
})
