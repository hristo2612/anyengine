import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
await new Promise((done) => { process.stdin.once('end', done); process.stdin.resume() })
const args = process.argv.slice(2), mode = ${JSON.stringify(behavior)}
const child = mode === 'descendant' ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'}) : null
const real = args.includes('plan')
const record = JSON.stringify({ args, cwd: process.cwd(), base: process.env.ANTHROPIC_BASE_URL, pid: process.pid, childPid:child?.pid, marker: existsSync(join(process.cwd(), 'anyengine-smoke-marker.txt')) })
if (real) appendFileSync(${JSON.stringify(capture)} + '.real', record)
else writeFileSync(${JSON.stringify(capture)}, record)
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
if (real) {
  emit({type:'system',subtype:'init',model:${JSON.stringify(id)},mcp_servers:[{name:'a',status:'connected'},{name:'b',status:'needs-auth'}]})
  if (['real-tool', 'real-refused', 'real-plain-error', 'real-wrong-id'].includes(mode)) emit({type:'assistant',message:{content:[{type:'tool_use',id:'t',name:'Read',input:{}}]}})
  if (mode === 'real-tool') emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t',content:'file contents'}]}})
  if (mode === 'real-refused') emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t',is_error:true,content:'PreToolUse:Read hook error: anyengine smoke: this turn is read-only'}]}})
  if (mode === 'real-plain-error') emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t',is_error:true,content:'some other failure'}]}})
  if (mode === 'real-wrong-id') emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'other',is_error:true,content:'anyengine smoke: this turn is read-only'}]}})
  emit({type:'result',subtype:mode === 'real-error' ? 'error_during_execution' : 'success',is_error:mode === 'real-error',result:'PONG'})
  process.exit(0)
}
const marker = readFileSync(join(process.cwd(), 'anyengine-smoke-marker.txt'), 'utf8')
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
      claudePolicy: { managedRoot: join(home, 'no-managed'), mdm: join(home, 'no-mdm'), user: 'u' },
      adapterEnv: (extra: NodeJS.ProcessEnv) => ({
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CLAUDE_CODE_SIMPLE: '',
        CLAUDE_CODE_SAFE_MODE: '',
        ...extra,
      }),
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
  // Then one read-only turn with the user's real settings and full tool surface.
  const real = JSON.parse(readFileSync(`${f.capture}.real`, 'utf8'))
  assert.match(result.detail, /real settings with 1 connected MCP servers then PONG/)
  assert.equal(real.base, `http://127.0.0.1:${f.ctx.config.router.port}`)
  for (const flag of ['--tools', '--allowedTools', '--disable-slash-commands'])
    assert.equal(real.args.includes(flag), false, flag)
  for (const [flag, value] of [
    ['--permission-mode', 'plan'],
    ['--max-turns', '2'],
    ['--disallowedTools', 'Bash'],
    ['--model', id],
  ])
    assert.equal(real.args[real.args.indexOf(flag) + 1], value)
  assert.ok(real.args.includes('--no-session-persistence'))
  // The marker is restored before this turn, and a flag-scope hook refuses every tool.
  assert.equal(real.marker, false)
  const hooks = JSON.parse(real.args[real.args.indexOf('--settings') + 1])
  const hook = hooks.hooks.PreToolUse[0]
  assert.equal(hook.matcher, '*')
  // Run the hook exactly as the CLI does (sh -c) and read its decision.
  const { execFileSync } = await import('node:child_process')
  const decision = JSON.parse(
    execFileSync('/bin/sh', ['-c', hook.hooks[0].command], { encoding: 'utf8' }),
  )
  assert.equal(decision.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
  // The marker turn is pinned to the configured router too.
  const markerSettings = JSON.parse(launched.args[launched.args.indexOf('--settings') + 1])
  assert.equal(
    markerSettings.env.ANTHROPIC_BASE_URL,
    `http://127.0.0.1:${f.ctx.config.router.port}`,
  )
  // The configured router wins over a base URL in the user's own settings.
  assert.equal(hooks.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${f.ctx.config.router.port}`)
})

test('Claude Code smoke judges hook policy with the child env and skips as unknown', async (t) => {
  const f = await fixture(t)
  const deps = f.ctx.deps as unknown as {
    claudeHome: string
    adapterEnv: (extra: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
  }
  // A config dir only the child env names, not the default under HOME.
  const config = join(deps.claudeHome, 'other-config')
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ disableAllHooks: true }))
  const inner = deps.adapterEnv
  deps.adapterEnv = (extra) => ({ ...inner(extra), CLAUDE_CONFIG_DIR: config })
  const result = await f.runClaudeCodeSmoke(f.ctx)
  // Unknown, not passed: an existing degraded mark is kept.
  assert.equal(result.ok, null, result.detail)
  assert.match(result.detail, /real-settings turn skipped/)
  assert.equal(existsSync(`${f.capture}.real`), false)
})

test('Claude Code smoke skips the real-settings turn when the marker turn fails', async (t) => {
  const f = await fixture(t, 'no-read')
  const result = await f.runClaudeCodeSmoke(f.ctx)
  assert.equal(result.ok, false)
  assert.match(result.detail, /tool\/terminal evidence failed/)
  assert.equal(existsSync(`${f.capture}.real`), false)
})

test('Claude Code smoke accepts a real-settings turn whose tool try the hook refused', async (t) => {
  const f = await fixture(t, 'real-refused')
  const result = await f.runClaudeCodeSmoke(f.ctx)
  assert.equal(result.ok, true, result.detail)
})

for (const mode of ['real-tool', 'real-error', 'real-plain-error', 'real-wrong-id'] as const)
  test(`Claude Code smoke fails when the real-settings turn shows ${mode}`, async (t) => {
    const f = await fixture(t, mode)
    const result = await f.runClaudeCodeSmoke(f.ctx)
    assert.equal(result.ok, false)
    assert.match(result.detail, /real settings and connectors failed/)
    assert.equal(existsSync(join(f.project, 'anyengine-smoke-marker.txt')), false)
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

test('hook policy detection covers every place Claude Code 2.1.301 reads it, failing closed', async () => {
  const { hooksDisabled } = await load()
  const base = await tempDir('hooks-policy-')
  const home = join(base, 'home'),
    config = join(home, '.claude'),
    managed = join(base, 'managed'),
    mdm = join(base, 'mdm'),
    project = join(base, 'project')
  mkdirSync(config, { recursive: true })
  mkdirSync(join(project, '.claude'), { recursive: true })
  mkdirSync(join(mdm, 'someone'), { recursive: true })
  const paths = { managedRoot: managed, mdm, user: 'someone', project }
  const env = { CLAUDE_CONFIG_DIR: config }
  const check = (extra: NodeJS.ProcessEnv = {}) => hooksDisabled(home, { ...env, ...extra }, paths)
  const toggle = (path: string, body: string, expect: boolean, label: string) => {
    writeFileSync(path, body)
    assert.equal(check(), expect, label)
  }
  assert.equal(check(), false)
  for (const flag of ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SAFE_MODE']) {
    assert.equal(check({ [flag]: '1' }), true, flag)
    assert.equal(check({ [flag]: '0' }), false, flag)
  }
  const settings = join(config, 'settings.json')
  toggle(settings, JSON.stringify({ allowManagedHooksOnly: true }), false, 'user scope ignores it')
  toggle(settings, JSON.stringify({ disableAllHooks: true }), true, 'user disableAllHooks')
  toggle(settings, '{ not json', true, 'unreadable fails closed')
  toggle(settings, '{}', false, 'clean user settings')
  for (const name of ['settings.json', 'settings.local.json']) {
    const path = join(project, '.claude', name)
    toggle(path, JSON.stringify({ disableAllHooks: true }), true, `project ${name}`)
    toggle(path, '{}', false, `clean project ${name}`)
  }
  writeFileSync(join(config, 'cowork_settings.json'), JSON.stringify({ disableAllHooks: true }))
  assert.equal(check(), false, 'cowork settings only count with Cowork plugins on')
  assert.equal(check({ CLAUDE_CODE_USE_COWORK_PLUGINS: '1' }), true)
  // Any managed, MDM or cached server policy may switch hooks off (a policy
  // helper's output is not visible in the file), so its presence alone skips.
  const present = [
    join(config, 'remote-settings.json'),
    join(mdm, 'com.anthropic.claudecode.plist'),
    join(mdm, 'someone', 'com.anthropic.claudecode.plist'),
  ]
  for (const path of present) {
    writeFileSync(path, '{}')
    assert.equal(check(), true, path)
    rmSync(path)
  }
  mkdirSync(managed)
  writeFileSync(join(managed, 'managed-settings.json'), '{}')
  assert.equal(check(), true, 'managed settings file')
  rmSync(join(managed, 'managed-settings.json'))
  mkdirSync(join(managed, 'managed-settings.d'))
  assert.equal(check(), true, 'managed drop-in directory')
})
