import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { DEFAULT_CONFIG } from '../src/anyengine-config.mjs'
import { digest } from '../src/control-layer-state.mjs'
import { realSystem } from '../src/control-system.mjs'
import { settingsHash } from '../src/degraded.mjs'
import { runSmoke, type SmokeDeps } from '../src/smoke.mjs'
import { joinDetachedGroup } from '../src/smoke-client.mjs'
import { startProbeThread } from '../src/smoke-paths.mjs'
import { withAdapter } from '../src/smoke-probes.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
for (const order of ['normal', 'late', 'withheld', 'after-snapshot', 'conflict'])
  test(`mandatory smoke exact start ownership and retained cleanup: ${order}`, async () => {
    assert.ok(process.env.HERMETIC_TEST_ROOT)
    const root = await tempDir('smoke-start-owned-')
    const lib = join(root, 'lib/fixture'),
      project = join(root, 'smoke/claude-project'),
      runDir = join(root, 'smoke/run-20261004T060000Z')
    const state = join(root, 'persisted-owned.json'),
      foreign = join(root, 'persisted-unrelated.json'),
      requests = join(root, 'requests.jsonl')
    writeFileSync(foreign, 'unrelated state')
    mkdirSync(join(lib, 'dist/src'), { recursive: true })
    const manifest = Buffer.from('{"fixture":"mandatory smoke start ownership"}')
    writeFileSync(join(lib, 'install-manifest.json'), manifest)
    const adapter = join(lib, 'dist/src/adapter.mjs')
    writeFileSync(
      adapter,
      `
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const order = ${JSON.stringify(order)}
const input = createInterface({input:process.stdin}); let pending
const send = m => process.stdout.write(JSON.stringify(m)+'\\n')
const reply = conflict => send({id:pending.id,result:{model:pending.params.model,thread:{id:conflict?'conflicting':'owned',cwd:pending.params.cwd,ephemeral:false}}})
appendFileSync(process.env.ANYENGINE_DEBUG_LOG,JSON.stringify({ts:new Date().toISOString(),pid:process.pid,event:'adapter.start'})+'\\n')
input.on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return
 appendFileSync(${JSON.stringify(requests)},JSON.stringify({method:m.method,threadId:m.params?.threadId,prearmed:m.method==='thread/start'?readdirSync(process.env.ANYENGINE_ROOT).some(name=>/^thread-starts-/.test(name)):undefined})+'\\n')
 if(m.method==='thread/start'){
   pending=m;writeFileSync(${JSON.stringify(state)},'owned committed thread');
   send({method:'thread/started',params:{thread:{id:'unrelated',cwd:m.params.cwd}}})
   if(['normal','conflict'].includes(order))reply(false)
   return
 }
 if(m.method==='fixture/reply')reply(m.params.conflict)
 if(m.method==='thread/unsubscribe')return send({id:m.id,result:{status:'unsubscribed'}})
 if(m.method==='thread/delete'){
  if(m.params.threadId!=='owned')throw new Error('unowned deletion')
  unlinkSync(${JSON.stringify(state)});send({method:'thread/deleted',params:{threadId:'owned'}})
 }
 send({id:m.id,result:{}})
})
const stop=()=>{if(order==='after-snapshot'&&pending)reply(false);setTimeout(()=>process.exit(0),30)}
input.on('close',stop);process.on('SIGTERM',stop)
`,
    )
    const config = structuredClone(DEFAULT_CONFIG)
    const snapshot = {
      root,
      libDir: lib,
      codeIdentity: digest(manifest),
      key: {
        lib: 'fixture',
        appVersion: '26.930.10000',
        codexVersion: '0.159.0',
        settings: settingsHash(config),
      },
      config,
      mode: config.modes.codexClaude,
      bundled: adapter,
      nativeProof: null,
      degraded: [],
    }
    const system = realSystem({ ...process.env, ANYENGINE_PS: '/bin/ps' })
    const home = process.env.HOME
    assert.ok(home)
    let pid: number | undefined
    const deps: SmokeDeps = {
      adapter,
      executingLib: lib,
      codexHome: join(root, 'codex'),
      claudeHome: home,
      project,
      runDir,
      adapterEnv: (extra) => ({ ...process.env, ...extra }),
      verifyLib: () => [],
      currentSnapshot: () => structuredClone(snapshot),
      runners: {
        gpt: async (ctx) => {
          ctx.observe = (_phase, value) => ({
            id: 'fake-probe',
            ppid: process.pid,
            processStart: '2026-10-04T06:00:00.000Z',
            command: 'controlled admission',
            settings: settingsHash(config),
            ...value,
          })
          return withAdapter(ctx, 'direct', 'agent', async (probe) => {
            pid = probe.client.pid
            const request = probe.client.request.bind(probe.client)
            probe.client.request = (method, params, timeout, observer) =>
              request(method, params, method === 'thread/start' ? 500 : timeout, observer)
            if (['normal', 'conflict'].includes(order))
              await startProbeThread(probe, ctx, 'gpt-fake', false, true)
            else
              await assert.rejects(
                startProbeThread(probe, ctx, 'gpt-fake', false, true),
                /timed out/,
              )
            if (order === 'late') await probe.client.request('fixture/reply', {})
            if (order === 'conflict')
              await probe.client.request('fixture/reply', { conflict: true })
            return { ok: false, ms: 0, detail: 'fake work; cleanup still required' }
          })
        },
      },
    }
    try {
      const promise = runSmoke(system, root, deps, {
        paths: ['gpt'],
        notify: false,
        out: join(root, 'result.json'),
      })
      if (['normal', 'late'].includes(order)) {
        await promise
        assert.equal(existsSync(runDir), false)
        assert.equal(existsSync(state), false)
      } else {
        await assert.rejects(promise, /cleanup uncertain/)
        assert.equal(existsSync(runDir), true)
        assert.equal(JSON.parse(readFileSync(join(runDir, 'owner.json'), 'utf8')).pending, true)
        const record = JSON.parse(readFileSync(join(runDir, 'direct/thread-starts-1.json'), 'utf8'))
        assert.equal(record.starts.length, 1)
        assert.equal(record.cleanup.status, 'unknown')
        assert.deepEqual(record.cleanup.releasedReplyIds, order === 'conflict' ? [['owned']] : [[]])
        assert.equal(existsSync(state), order !== 'conflict')
        assert.equal(JSON.stringify(record).includes('unrelated'), false)
      }
      const calls = readFileSync(requests, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.equal(calls.find((call) => call.method === 'thread/start').prearmed, true)
      assert.equal(
        calls.some((call) => call.threadId === 'unrelated' || call.threadId === 'conflicting'),
        false,
      )
      assert.equal(readFileSync(foreign, 'utf8'), 'unrelated state')
      assert.ok(pid)
      const admittedPid = pid
      assert.throws(() => process.kill(admittedPid, 0), { code: 'ESRCH' })
    } finally {
      if (pid) await joinDetachedGroup(pid, true)
    }
  })
