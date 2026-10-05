import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { setConfigValue } from '../src/anyengine-config.mjs'
import { joinDetachedGroup } from '../src/smoke-client.mjs'
import { fakeCodexAt } from './helpers/adapter-client.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(killChildren)
after(removeTempDirs)
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!done()) {
    assert.ok(Date.now() < deadline, 'owned lifecycle condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('typed refusal after IPC loss still joins preparation and cannot authorize vendor fallback', async () => {
  const root = await tempDir('startup-channel-')
  const adapter = join(root, 'adapter.mjs')
  const marker = join(root, 'preparation-pid')
  const recordPath = join(root, 'result.json')
  writeFileSync(
    adapter,
    `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';import{startupFallback}from${JSON.stringify(pathToFileURL(resolve('dist/src/startup-compat.mjs')).href)};import{joinDetachedGroup}from${JSON.stringify(pathToFileURL(resolve('dist/src/smoke-client.mjs')).href)};const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();writeFileSync(${JSON.stringify(marker)},String(child.pid));process.disconnect();process.exitCode=await startupFallback({kind:'fallback',code:'selected-binary-changed',reason:'owned channel loss control',codexPath:null},[],'unix://',${JSON.stringify(root)},()=>joinDetachedGroup(child.pid,true));`,
  )
  const helper = resolve('scripts/lib/startup-schema.mjs')
  const child = spawn(
    process.execPath,
    [helper, '--launch', recordPath, Buffer.from(adapter).toString('base64')],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stderr = ''
  child.stderr?.on('data', (bytes) => {
    stderr += bytes
  })
  const closed = once(child, 'close')
  try {
    const [status] = await closed
    assert.equal(status, 1, stderr)
    assert.equal(alive(Number(readFileSync(marker, 'utf8'))), false)
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    assert.equal(record.status, 78)
    assert.equal(record.delegated, false)
    assert.equal(
      spawnSync(process.execPath, [helper, '--launch-result', recordPath, String(record.launcher)])
        .status,
      2,
    )
    assert.match(stderr, /selected-binary-changed/)
  } finally {
    if (existsSync(marker)) await joinDetachedGroup(Number(readFileSync(marker, 'utf8')), true)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await closed
  }
})

for (const variant of [
  'malformed',
  'partial',
  'oversized',
  'foreign',
  'invalid-utf8',
  'ordinary-78',
]) {
  test(`private current-child diagnostic stays conservative and byte-exact: ${variant}`, async () => {
    const root = await tempDir('startup-damaged-')
    const adapter = join(root, 'adapter.mjs')
    const original = join(root, 'stderr.bin')
    const recordPath = join(root, 'result.json')
    const prefix = '[anyengine] '
    const expressions: Record<string, string> = {
      malformed: `Buffer.from(${JSON.stringify(`${prefix}{broken\n`)})`,
      partial: `Buffer.from(${JSON.stringify(`${prefix}{"kind":`)})`,
      oversized: `Buffer.from(${JSON.stringify(`${prefix}{${'x'.repeat(4200)}\n`)})`,
      foreign: `Buffer.from(${JSON.stringify(prefix)}+JSON.stringify({kind:'anyengine-startup-failure',pid:process.pid+1,code:'selected-binary-changed',fallback:'refused',reason:'foreign'})+'\\n')`,
      'invalid-utf8': `Buffer.from([${[...Buffer.from(`${prefix}{"reason":"`), 255, ...Buffer.from('"}\n')].join(',')}])`,
      'ordinary-78': `Buffer.from(${JSON.stringify(`${prefix}refusing the app-server control socket\n`)})`,
    }
    writeFileSync(
      adapter,
      `import{writeFileSync}from'node:fs';const bytes=${expressions[variant]};writeFileSync(${JSON.stringify(original)},bytes);process.stderr.write(bytes);process.exitCode=78;`,
    )
    const helper = resolve('scripts/lib/startup-schema.mjs')
    const result = spawnSync(process.execPath, [
      helper,
      '--launch',
      recordPath,
      Buffer.from(adapter).toString('base64'),
    ])
    assert.deepEqual(
      result.stderr,
      readFileSync(original),
      'tee must preserve original raw stderr bytes',
    )
    const ordinary = variant === 'ordinary-78'
    assert.equal(result.status, ordinary ? 78 : 1)
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    assert.equal(record.status, 78)
    assert.equal(record.cleanup, ordinary ? 'complete' : 'unknown')
    assert.equal(alive(record.adapter), false)
    assert.equal(
      spawnSync(process.execPath, [helper, '--launch-result', recordPath, String(record.launcher)])
        .status,
      ordinary ? 1 : 2,
    )
  })
}

for (const [actualFallback, vendorStatus] of [
  [true, 0],
  [false, 0],
  [true, 78],
] as const) {
  test(`Unix zero-exit delegation joins descendants before completion; actual fallback=${actualFallback}; vendor status=${vendorStatus}`, async () => {
    const root = await tempDir('startup-family-')
    const vendor = join(root, 'vendor.mjs')
    const marker = join(root, 'pids.json')
    const adapter = join(root, 'adapter.mjs')
    const record = join(root, 'launch.json')
    writeFileSync(
      vendor,
      `#!${process.execPath}\nimport{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.unref();writeFileSync(${JSON.stringify(marker)},JSON.stringify({vendor:process.pid,descendant:c.pid,argv:process.argv.slice(2)}));process.exit(${vendorStatus});\n`,
      { mode: 0o755 },
    )
    writeFileSync(
      adapter,
      actualFallback
        ? `import{startupFallback}from${JSON.stringify(pathToFileURL(resolve('dist/src/startup-compat.mjs')).href)};process.exitCode=await startupFallback({kind:'fallback',code:'fixture-refusal',reason:'owned family control',codexPath:${JSON.stringify(vendor)}},process.argv.slice(2),'unix://',${JSON.stringify(root)});`
        : `import{spawn}from'node:child_process';process.send({kind:'anyengine-startup-delegation',phase:'pending'});const c=spawn(${JSON.stringify(vendor)},process.argv.slice(2),{detached:true,stdio:'ignore'});process.send({kind:'anyengine-startup-delegation',phase:'spawned',pid:c.pid});c.once('close',()=>process.send({kind:'anyengine-startup-delegation',phase:'complete'},()=>process.exit(0)));`,
    )
    const argv = ['app-server', '--listen', 'unix://']
    const child = spawn(
      process.execPath,
      [
        resolve('scripts/lib/startup-schema.mjs'),
        '--launch',
        record,
        Buffer.from(adapter).toString('base64'),
        ...argv,
      ],
      { env: { ...process.env, ANYENGINE_REAL_CODEX: vendor }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderr = ''
    child.stderr?.on('data', (bytes) => {
      stderr += bytes
    })
    const closed = once(child, 'close')
    let pids: { vendor: number; descendant: number; argv: string[] } | undefined
    try {
      const [status] = await closed
      pids = JSON.parse(readFileSync(marker, 'utf8'))
      assert.ok(pids)
      assert.equal(status, vendorStatus, stderr)
      assert.deepEqual(pids.argv, argv)
      const result = JSON.parse(readFileSync(record, 'utf8'))
      assert.equal(result.delegated, true)
      assert.equal(result.status, vendorStatus)
      assert.equal(
        spawnSync(process.execPath, [
          resolve('scripts/lib/startup-schema.mjs'),
          '--launch-result',
          record,
          String(result.launcher),
        ]).status,
        0,
        'completed vendor status remains delegated, including 78',
      )
      assert.equal(result.cleanup, 'complete')
      assert.equal(
        alive(pids.descendant),
        false,
        'complete must mean the owned descendant is absent',
      )
      if (actualFallback) assert.match(stderr, /anyengine-startup-failure/)
    } finally {
      if (!pids && existsSync(marker)) pids = JSON.parse(readFileSync(marker, 'utf8'))
      if (pids) await joinDetachedGroup(pids.vendor, true)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await closed
    }
  })
}

for (const timing of ['during-router', 'lazy', 'supervised-router', 'shim-router'] as const) {
  for (const transport of ['stdio', 'unix', 'ws'] as const) {
    if (timing === 'lazy' && transport === 'stdio') continue
    if ((timing === 'supervised-router' || timing === 'shim-router') && transport !== 'unix')
      continue
    test(`selected binary drift refuses ${transport} ${timing} without successful initialize or leaked readiness`, async (t) => {
      const root = await tempDir('startup-drift-')
      const home = join(root, 'home')
      const launchTmp = join(root, 'tmp')
      mkdirSync(home)
      mkdirSync(launchTmp)
      const binary = fakeCodexAt(root)
      const socket = join(root, 's')
      const debug = join(root, 'debug.jsonl')
      const argv = join(root, 'vendor-argv.json')
      let admissionObserved = false
      let healthCalls = 0
      const router = http.createServer((_req, response) => {
        healthCalls++
        admissionObserved = existsSync(join(root, 'state/startup-compat.json'))
        if (timing !== 'lazy') appendFileSync(binary, '\n// changed after admission\n')
        response.end('{}')
      })
      router.listen(0, '127.0.0.1')
      await once(router, 'listening')
      const address = router.address()
      assert.ok(address && typeof address === 'object')
      let port = 0
      if (transport === 'ws' && timing === 'lazy') {
        const reservation = http.createServer()
        reservation.listen(0, '127.0.0.1')
        await once(reservation, 'listening')
        const reserved = reservation.address()
        assert.ok(reserved && typeof reserved === 'object')
        port = reserved.port
        await new Promise<void>((resolve) => reservation.close(() => resolve()))
      }
      const listen =
        transport === 'unix'
          ? `unix://${socket}`
          : transport === 'ws'
            ? `ws://127.0.0.1:${port}`
            : 'stdio://'
      setConfigValue(root, 'router.enabled', 'true')
      let launchRecord = join(root, 'launch.json')
      const launchArgs =
        timing === 'supervised-router'
          ? [
              resolve('scripts/lib/startup-schema.mjs'),
              '--launch',
              launchRecord,
              Buffer.from(resolve('dist/src/adapter.mjs')).toString('base64'),
            ]
          : [resolve('dist/src/adapter.mjs')]
      const childArgs = ['-c', 'literal=$unexpanded', 'app-server', '--listen', listen]
      const child = spawn(
        timing === 'shim-router' ? resolve('scripts/codex-shim') : process.execPath,
        timing === 'shim-router' ? childArgs : [...launchArgs, ...childArgs],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            TMPDIR: launchTmp,
            ANYENGINE_REMOTE_NATIVE_CODEX: '1',
            ANYENGINE_NODE: process.execPath,
            ANYENGINE_ADAPTER: resolve('dist/src/adapter.mjs'),
            ANYENGINE_MOCK: '',
            ANYENGINE_ROOT: root,
            ANYENGINE_HOME: home,
            CODEX_HOME: join(root, 'codex'),
            ANYENGINE_ROUTER_URL: `http://127.0.0.1:${address.port}/backend-api/codex`,
            ANYENGINE_DEBUG_LOG: debug,
            ANYENGINE_REAL_CODEX: binary,
            ANYENGINE_RUNTIME_TYPE: 'mock',
            ANYENGINE_RUNTIME_ENV: join(home, 'missing.env'),
            ANYENGINE_NATIVE_CODEX: '',
            CLAUDE_CODEX_NATIVE_CODEX: '',
            ANYENGINE_BRIDGE: '0',
            FAKE_CODEX_ARGV_FILE: argv,
          },
        },
      )
      let out = ''
      let err = ''
      child.stdout?.on('data', (bytes) => {
        out += bytes
      })
      child.stderr?.on('data', (bytes) => {
        err += bytes
      })
      const closed = once(child, 'close')
      let ws: WebSocket | undefined
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: 55,
        method: 'initialize',
        params: { clientInfo: { name: 'lifecycle', version: '1' } },
      })
      try {
        if (timing === 'lazy') {
          await until(() => err.includes('listening on') || child.exitCode !== null)
          assert.equal(child.exitCode, null, err)
          appendFileSync(binary, '\n// changed before lazy initialize\n')
          ws =
            transport === 'unix'
              ? new WebSocket('ws://localhost/', {
                  createConnection: (() =>
                    net.createConnection(socket)) as typeof net.createConnection,
                })
              : new WebSocket(listen)
          ws.on('message', (bytes) => {
            out += bytes
          })
          await once(ws, 'open')
          ws.send(request)
        } else if (transport === 'stdio') child.stdin?.write(`${request}\n`)
        await until(
          () =>
            child.exitCode !== null ||
            out.includes('"id":55') ||
            (timing !== 'lazy' && err.includes('listening on')),
        )
        assert.equal(
          child.exitCode,
          timing === 'supervised-router' || timing === 'shim-router' ? 1 : 78,
          `${err}\n${out}`,
        )
        await closed
        if (timing === 'shim-router') {
          const retained = readdirSync(launchTmp).filter((name) =>
            name.startsWith('anyengine-startup.'),
          )
          assert.equal(retained.length, 1)
          launchRecord = join(launchTmp, retained[0] ?? '', 'result.json')
          assert.match(err, /launch cleanup remains unknown; retained/)
        }
        if (timing === 'supervised-router' || timing === 'shim-router') {
          const record = JSON.parse(readFileSync(launchRecord, 'utf8'))
          assert.equal(record.status, 78)
          assert.equal(record.delegated, true)
          assert.equal(record.cleanup, 'unknown')
          assert.equal(alive(record.adapter), false)
          assert.equal(alive(record.launcher), false)
          if (timing === 'shim-router')
            t.diagnostic(
              JSON.stringify({
                route: 'actual-shim',
                status: child.exitCode,
                argv: childArgs,
                result: record,
                stderr: err,
                stdout: out,
                changedVendorLaunched: existsSync(argv),
                ownedAdapterAndSupervisorAbsent: true,
              }),
            )
          assert.equal(
            spawnSync(process.execPath, [
              resolve('scripts/lib/startup-schema.mjs'),
              '--launch-result',
              launchRecord,
              String(record.launcher),
            ]).status,
            2,
            'refusal must never authorize a second vendor',
          )
        }
        assert.equal(healthCalls, 1)
        assert.equal(admissionObserved, true)
        assert.equal(out, '', 'refusal precedes local initialize responses and notifications')
        assert.equal(existsSync(argv), false, 'changed executable must never be launched')
        assert.equal(existsSync(socket), false)
        assert.equal(existsSync(`${socket}.pid`), false)
        assert.match(err, /anyengine-startup-failure/)
        if (transport === 'ws') assert.match(err, /direct-cli-required/)
        const fallback = JSON.parse(readFileSync(join(root, 'shim-fallback.json'), 'utf8'))
        assert.equal(fallback.code, 'selected-binary-changed')
        assert.equal(fallback.delegation, 'pending')
        const events = readFileSync(debug, 'utf8')
        assert.doesNotMatch(events, /codex\.mux\.initialize"/)
        if (timing !== 'lazy') assert.doesNotMatch(events, /adapter\.start"/)
      } finally {
        ws?.terminate()
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        await closed
        await new Promise<void>((resolve) => router.close(() => resolve()))
      }
    })
  }
}
