import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const load = () => import('../src/' + 'broker-standalone.mjs')

test('production standalone environment cannot inherit API credentials, OAuth overrides or proxies', async () => {
  const root = await tempDir('be-')
  const home = join(root, 'codex')
  mkdirSync(home)
  const poison = 'FAKE_SECRET_MUST_NOT_REACH_CHILD'
  const original = {
    HOME: root,
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    CODEX_HOME: '/wrong-home',
    OPENAI_API_KEY: poison,
    CODEX_API_KEY: poison,
    ANTHROPIC_API_KEY: poison,
    ANTHROPIC_AUTH_TOKEN: poison,
    CODEX_REFRESH_TOKEN_URL_OVERRIDE: poison,
    CODEX_REVOKE_TOKEN_URL_OVERRIDE: poison,
    CODEX_AUTHAPI_BASE_URL: poison,
    HTTP_PROXY: poison,
    HTTPS_PROXY: poison,
    ALL_PROXY: poison,
    http_proxy: poison,
    ANYENGINE_REAL_CODEX: poison,
    NODE_OPTIONS: poison,
  }
  const clean = (await load()).standaloneEnvironment(home, original)
  assert.equal(clean.CODEX_HOME, home)
  assert.equal(clean.HOME, root)
  assert.equal(JSON.stringify(clean).includes(poison), false)
  assert.equal(original.CODEX_HOME, '/wrong-home')
})

test('standalone uses only initialize/auth metadata RPCs and joins its owned child', async () => {
  const root = await tempDir('bc-')
  const home = join(root, 'codex'),
    binary = join(root, 'fake.mjs'),
    receipt = join(root, 'observed.json')
  mkdirSync(home)
  writeFileSync(
    binary,
    `
import {writeFileSync} from 'node:fs'
import readline from 'node:readline'
const rows=[]
const record=()=>writeFileSync(${JSON.stringify(receipt)},JSON.stringify({pid:process.pid,env:process.env,argv:process.argv.slice(2),methods:rows}))
record()
const rl=readline.createInterface({input:process.stdin})
rl.on('line',line=>{
 const {id,method}=JSON.parse(line);rows.push(method);record()
 if(id!=null)process.stdout.write(JSON.stringify({id,result:method==='getAuthStatus'?{authMethod:'chatgpt',authToken:'FAKE_RETURNED_RPC_ONLY',requiresOpenaiAuth:true}:{}})+'\\n')
})
rl.once('close',()=>process.exit(0))
`,
  )
  const source = await (await load()).createStandaloneAuthSource({
    home,
    binary,
    generation: 1,
    env: {
      HOME: root,
      PATH: '/usr/bin:/bin',
      OPENAI_API_KEY: 'POISON',
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'POISON',
    },
  })
  let pid = 0
  try {
    assert.equal(source.kind, 'standalone')
    const auth = await source.request('getAuthStatus', { includeToken: true, refreshToken: false })
    assert.equal(auth.authToken, 'FAKE_RETURNED_RPC_ONLY')
    const before = JSON.parse(readFileSync(receipt, 'utf8'))
    pid = before.pid
    const refused = source as { request(method: string, params: unknown): Promise<unknown> }
    await assert.rejects(refused.request('thread/start', {}), /broker\.source-unavailable/)
    const observed = JSON.parse(readFileSync(receipt, 'utf8'))
    assert.deepEqual(observed.methods, before.methods)
    assert.ok(observed.methods.includes('initialized'))
    assert.ok(observed.methods.includes('getAuthStatus'))
    assert.equal(
      observed.methods.some(
        (method: string) => method.startsWith('thread/') || method.startsWith('turn/'),
      ),
      false,
    )
    assert.equal(JSON.stringify(observed.env).includes('POISON'), false)
    assert.equal(JSON.stringify(observed.argv).includes('FAKE_RETURNED_RPC_ONLY'), false)
    assert.equal(observed.env.CODEX_HOME, home)
    assert.equal(existsSync(join(home, 'auth.json')), false)
  } finally {
    await source.close()
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
