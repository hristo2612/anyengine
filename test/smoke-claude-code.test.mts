import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import test, { after, type TestContext } from 'node:test'
import { DEFAULT_CONFIG } from '../src/anyengine-config.mjs'
import { realSystem } from '../src/control-system.mjs'
import type { PathContext } from '../src/smoke.mjs'
import { PATH_RUNNERS } from '../src/smoke-paths.mjs'
import { killChildren } from './helpers/children.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(killChildren)
after(removeTempDirs)
const load = () => import('../src/' + 'smoke-claude-code.mjs')
const id = 'gpt-smoke-fixture'
const privateMarker = 'FAKE_PRIVATE_STDERR_NEVER_PUBLISH'
async function fixture(t: TestContext, behavior = 'success') {
  const { runClaudeCodeSmoke } = await load()
  const home = await tempDir('sc-')
  const root = join(home, 'engine')
  const project = join(root, 'smoke/claude-project')
  const runDir = join(root, 'smoke/run-20261004T000000Z')
  mkdirSync(project, { recursive: true, mode: 0o700 })
  mkdirSync(runDir, { mode: 0o700 })
  const cli = join(home, 'fake-claude.mjs')
  const capture = join(home, 'argv.json')
  writeFileSync(
    cli,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
await new Promise((done) => { process.stdin.once('end', done); process.stdin.resume() })
const args = process.argv.slice(2), mode = ${JSON.stringify(behavior)}
const child = mode === 'descendant' ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'}) : null
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, cwd: process.cwd(), base: process.env.ANTHROPIC_BASE_URL, pid: process.pid, childPid:child?.pid }))
const marker = readFileSync(join(process.cwd(), 'anyengine-smoke-marker.txt'), 'utf8')
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
emit({type:'system',subtype:'init',model:${JSON.stringify(id)}})
const tool = {type:'tool_use',id:'read_fixture',name:'Read',input:{file_path:'anyengine-smoke-marker.txt'}}
const result = {type:'tool_result',tool_use_id:'read_fixture',content:marker}
if(mode !== 'no-read') emit({type:'assistant',message:{content:[tool]}})
if(mode === 'twice') emit({type:'assistant',message:{content:[tool]}})
if(mode === 'wrong-id') result.tool_use_id = 'foreign'
if(mode === 'wrong-marker') result.content = 'unrelated marker'
if(mode === 'denied') result.is_error = true
if(mode !== 'no-result') emit({type:'user',message:{content:[result]}})
emit({type:'assistant',message:{content:[{type:'text',text:'PONG'}]}})
emit({type:'result',subtype:'success',is_error:false,result:mode === 'wrong-pong' ? 'PONG extra' : 'PONG'})
process.stderr.write(${JSON.stringify(privateMarker)})
if(mode === 'exit-error') process.exitCode = 1
if(mode === 'descendant') child.unref()
`,
    { mode: 0o700 },
  )
  let models = [{ id, label: 'GPT smoke', contextWindow: 100000, lite: false, efforts: ['low'] }]
  let views = 0
  let unavailable = false
  const server = http.createServer((request, response) => {
    views++
    assert.equal(request.url, '/control/claude-code/models')
    assert.equal(request.headers.authorization, undefined)
    response.writeHead(unavailable ? 503 : 200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify(
        unavailable ? { error: privateMarker } : { generation: 1, fetchedAt: 4242, models },
      ),
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const config = structuredClone(DEFAULT_CONFIG)
  config.router.port = address.port
  config.claude.cli = cli
  config.smoke.gptModel = id
  const system = fakeSystem(home)
  system.processes = realSystem({ ...process.env, ANYENGINE_PS: '/bin/ps' }).processes
  const ctx = {
    system,
    root,
    config,
    deps: {
      project,
      runDir,
      claudeHome: home,
      adapterEnv: (extra: NodeJS.ProcessEnv) => ({ ...process.env, HOME: home, ...extra }),
    },
    verify: () => ({}),
    cohort: [],
    uncertain: false,
    sessions: new Set<string>(),
    run: { pending: () => {} },
  } as unknown as PathContext
  return {
    ctx,
    cli,
    capture,
    project,
    runDir,
    runClaudeCodeSmoke,
    views: () => views,
    unavailable: () => {
      unavailable = true
    },
    empty: () => {
      models = []
    },
  }
}

test('Claude Code smoke registers an independent degradation path', async () => {
  const { runClaudeCodeSmoke } = await load()
  assert.equal((PATH_RUNNERS as Record<string, unknown>)['claude-code-gpt'], runClaudeCodeSmoke)
})

test('Claude Code smoke proves one correlated Read, the fresh marker result and terminal PONG', async (t) => {
  const f = await fixture(t)
  const result = await f.runClaudeCodeSmoke(f.ctx)
  assert.equal(result.ok, true, result.detail)
  assert.match(result.detail, /Read.*PONG/)
  assert.equal(result.detail.includes(privateMarker), false)
  const launched = JSON.parse(readFileSync(f.capture, 'utf8'))
  assert.equal(launched.cwd, f.project)
  assert.equal(launched.base, `http://127.0.0.1:${f.ctx.config.router.port}`)
  for (const flag of ['--no-session-persistence', '--disable-slash-commands'])
    assert.ok(launched.args.includes(flag))
  for (const [flag, value] of [
    ['--tools', 'Read'],
    ['--allowedTools', 'Read'],
    ['--max-turns', '2'],
    ['--model', id],
  ])
    assert.equal(launched.args[launched.args.indexOf(flag) + 1], value)
  assert.ok(
    launched.args.includes(
      'Read the file anyengine-smoke-marker.txt using Read once and reply with exactly PONG.',
    ),
  )
  assert.equal(existsSync(join(f.project, 'anyengine-smoke-marker.txt')), false)
  assert.throws(() => process.kill(launched.pid, 0), { code: 'ESRCH' })
  assert.equal(f.ctx.sessions.size, 0)
  assert.equal(f.views(), 1)
})

test('Claude Code smoke restores a colliding marker byte-for-byte with its prior mode', async (t) => {
  const f = await fixture(t)
  const marker = join(f.project, 'anyengine-smoke-marker.txt')
  const before = Buffer.from('operator marker\r\n\0retain')
  writeFileSync(marker, before, { mode: 0o640 })
  assert.equal((await f.runClaudeCodeSmoke(f.ctx)).ok, true)
  assert.deepEqual(readFileSync(marker), before)
  assert.equal(statSync(marker).mode & 0o777, 0o640)
})

test('Claude Code smoke joins a descendant retaining its parent stdout before publishing success', async (t) => {
  const f = await fixture(t, 'descendant')
  assert.equal((await f.runClaudeCodeSmoke(f.ctx)).ok, true)
  const launched = JSON.parse(readFileSync(f.capture, 'utf8'))
  assert.ok(launched.childPid > 0)
  assert.throws(() => process.kill(launched.pid, 0), { code: 'ESRCH' })
  assert.throws(() => process.kill(launched.childPid, 0), { code: 'ESRCH' })
})

for (const behavior of [
  'no-read',
  'twice',
  'wrong-id',
  'wrong-marker',
  'denied',
  'no-result',
  'wrong-pong',
  'exit-error',
])
  test(`Claude Code smoke rejects unmatched terminal tool evidence: ${behavior}`, async (t) => {
    const f = await fixture(t, behavior)
    const result = await f.runClaudeCodeSmoke(f.ctx)
    assert.equal(result.ok, false)
    assert.equal(result.detail.includes(privateMarker), false)
    const launched = JSON.parse(readFileSync(f.capture, 'utf8'))
    assert.throws(() => process.kill(launched.pid, 0), { code: 'ESRCH' })
    assert.equal(existsSync(join(f.project, 'anyengine-smoke-marker.txt')), false)
  })

test('Claude Code smoke does no lookup or process work when scheduled smoke is disabled', async (t) => {
  const f = await fixture(t)
  f.ctx.config.smoke.enabled = false
  assert.equal((await f.runClaudeCodeSmoke(f.ctx)).ok, null)
  assert.equal(f.views(), 0)
  assert.equal(existsSync(f.capture), false)
  assert.equal(existsSync(join(f.project, 'anyengine-smoke-marker.txt')), false)
})

test('Claude Code smoke refuses unavailable models before writing its marker or launching Claude', async (t) => {
  const f = await fixture(t)
  f.unavailable()
  const result = await f.runClaudeCodeSmoke(f.ctx)
  assert.equal(result.ok, false)
  assert.equal(result.detail.includes(privateMarker), false)
  assert.equal(existsSync(f.capture), false)
  assert.equal(existsSync(join(f.project, 'anyengine-smoke-marker.txt')), false)
})

test('Claude Code smoke never substitutes a missing configured GPT model', async (t) => {
  const f = await fixture(t)
  f.empty()
  const result = await f.runClaudeCodeSmoke(f.ctx)
  assert.equal(result.ok, false)
  assert.equal(existsSync(f.capture), false)
})

test('Claude Code smoke refuses a marker symlink without touching its target or launching a child', async (t) => {
  const f = await fixture(t)
  const outside = join(f.project, 'operator-file')
  writeFileSync(outside, 'retain')
  symlinkSync(outside, join(f.project, 'anyengine-smoke-marker.txt'))
  const result = await f.runClaudeCodeSmoke(f.ctx)
  assert.equal(result.ok, false)
  assert.equal(readFileSync(outside, 'utf8'), 'retain')
  assert.equal(existsSync(f.capture), false)
})
