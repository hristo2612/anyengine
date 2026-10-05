import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { CodexUpstream } from '../src/codex-upstream.mjs'
import { applyOnFiles } from '../src/control-install.mjs'
import { postflight, realFlipDeps } from '../src/control-postflight.mjs'
import { stopProcess } from './helpers/children.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { CODE, ROUTER, scripted } from './helpers/flip-deps.mjs'
import { fakeLib, m0Home, pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
async function relaunched() {
  const home = await m0Home()
  const system = fakeSystem(home)
  const fixture = scripted(system, { gate: true })
  const plan = fakeLib(home)
  applyOnFiles(system, join(home, '.anyengine'), plan, { dryRun: false, paths: pathsFor(home) })
  const snapshot = fixture.deps.currentSnapshot()
  const input = {
    expect: 'router' as const,
    since: system.now(),
    appVersionBefore: system.version ?? '',
    versionChangeExpected: false,
    libVersion: plan.version,
    routerUrl: ROUTER,
    baselineOther: [],
    frozen: { codeIdentity: CODE, key: snapshot.key, mode: snapshot.mode },
  }
  system.quitApp()
  system.openApp()
  return { home, system, input, ...fixture }
}

test('actual upstream/logger child PID satisfies current postflight and its owned child is reaped', async () => {
  const s = await relaunched()
  const binary = join(s.system.app, 'Contents/Resources/codex.mjs')
  mkdirSync(dirname(binary), { recursive: true })
  writeFileSync(binary, 'process.stdin.resume()\n')
  const args = ['app-server', '-c', `openai_base_url="${ROUTER}"`]
  const log = join(s.home, 'producer.jsonl')
  const previous = process.env.ANYENGINE_DEBUG_LOG
  process.env.ANYENGINE_DEBUG_LOG = log
  const upstream = new CodexUpstream({
    binary,
    args,
    env: { HOME: s.home, PATH: '/usr/bin:/bin' },
    onMessage: () => {},
    maxRestarts: 0,
  })
  let pid: number | null = null
  try {
    upstream.start()
    pid = upstream.pid
    assert.ok(pid)
    const event = JSON.parse(readFileSync(log, 'utf8').trim()) as Record<string, unknown>
    assert.equal(event.pid, pid)
    assert.notEqual(event.pid, process.pid)
    const child = s.system.procs.find((p) => p.command.startsWith(`${s.deps.bundledCodex()} `))
    assert.ok(child)
    const adapter = s.system.procs.find((p) => p.pid === child.ppid)
    assert.ok(adapter)
    const oldPid = adapter.pid
    adapter.pid = process.pid
    child.ppid = process.pid
    child.pid = pid
    child.command = `${binary} ${args.join(' ')}`
    s.events.splice(0, 1, event)
    for (const row of s.events) if (row.event === 'router.link') row.pid = adapter.pid
    for (const [index, line] of s.log.entries())
      s.log[index] = line.replace(`pid=${oldPid}`, `pid=${adapter.pid}`)
    s.deps.bundledCodex = () => binary
    const current = s.deps.currentSnapshot
    s.deps.currentSnapshot = () => ({ ...current(), bundled: binary })
    const result = await postflight(s.system, s.deps, s.input)
    assert.ok(
      result.every((check) => check.ok),
      JSON.stringify(result),
    )
  } finally {
    await upstream.stop()
    const ownedPid = pid
    if (ownedPid) {
      await stopProcess(ownedPid)
      assert.throws(() => process.kill(ownedPid, 0), { code: 'ESRCH' })
    }
    if (previous === undefined) delete process.env.ANYENGINE_DEBUG_LOG
    else process.env.ANYENGINE_DEBUG_LOG = previous
  }
})

for (const failure of [
  'wrong-parent',
  'wrong-pid',
  'stale-child',
  'stale-event',
  'non-bundled',
  'spawnError',
  'unavailable',
  'staleRealCodex',
  'missing',
])
  test(`production-shaped spawn rejects ${failure}`, async () => {
    const s = await relaunched()
    const child = s.system.procs.find((p) => p.ppid !== 1)
    const event = s.events.find((e) => e.event === 'codex.upstream.spawn')
    assert.ok(child && event)
    const adapter = s.system.procs.find((p) => p.pid === child.ppid)
    assert.ok(adapter)
    event.pid = child.pid
    if (failure === 'wrong-parent') child.ppid = 77
    if (failure === 'wrong-pid') event.pid = adapter.pid
    if (failure === 'stale-child') child.processStart = '2000-01-01T00:00:00Z'
    if (failure === 'stale-event')
      child.processStart = new Date(Date.parse(String(event.ts)) + 1000).toISOString()
    if (failure === 'non-bundled') event.binary = '/unrelated/codex'
    if (['spawnError', 'unavailable', 'staleRealCodex', 'missing'].includes(failure))
      s.events.push({
        ts: event.ts,
        pid: adapter.pid,
        event: `codex.upstream.${failure}`,
        message: 'observed failure',
      })
    const result = await postflight(s.system, s.deps, s.input)
    assert.equal(
      result.find((check) => check.name === 'GPT child')?.ok,
      false,
      JSON.stringify(result),
    )
  })

for (const bad of ['missing-verifier', 'unmanifested-file', 'indirect-parent', 'invalid-manifest'])
  test(`candidate ${bad} refuses without unchecked launch or evidence mutation`, async () => {
    const s = await candidate()
    if (bad === 'missing-verifier') unlinkSync(join(s.lib, 'scripts/lib-verify.mjs'))
    if (bad === 'unmanifested-file') writeFileSync(join(s.lib, 'extra.mjs'), '// unexpected\n')
    if (bad === 'indirect-parent') {
      renameSync(join(s.lib, 'dist'), join(s.home, 'external-dist'))
      symlinkSync(join(s.home, 'external-dist'), join(s.lib, 'dist'))
    }
    if (bad === 'invalid-manifest')
      writeFileSync(join(s.lib, 'install-manifest.json'), Buffer.from([0xff]))
    const before = readFileSync(join(s.lib, 'install-manifest.json'))
    const result = realFlipDeps(s.system, s.root, s.lib).verifyLib(s.lib)
    assert.ok(result.length)
    assert.equal(existsSync(s.marker), false)
    assert.deepEqual(readFileSync(join(s.lib, 'install-manifest.json')), before)
  })

async function candidate() {
  const home = await tempDir('manifest-contract-')
  const root = join(home, 'root')
  const lib = join(root, 'lib/v1')
  const marker = join(home, 'candidate-executed')
  const files = {
    'scripts/lib-verify.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran')\n`,
    'dist/src/adapter.mjs': '// inert candidate, never launched\n',
  }
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(lib, name)), { recursive: true })
    writeFileSync(join(lib, name), bytes)
  }
  symlinkSync('../dist/src/adapter.mjs', join(lib, 'scripts/adapter-link'))
  const manifest = Buffer.from(
    JSON.stringify({
      version: 'v1',
      files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])),
      links: { 'scripts/adapter-link': '../dist/src/adapter.mjs' },
    }),
  )
  writeFileSync(join(lib, 'install-manifest.json'), manifest)
  const system = fakeSystem(home)
  system.exec = (command, args) => {
    assert.equal(command, process.execPath)
    assert.deepEqual(args, [join(lib, 'scripts/lib-verify.mjs'), lib])
    const result = spawnSync(command, args, {
      cwd: home,
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      timeout: 2000,
      encoding: 'utf8',
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }
  return { home, root, lib, marker, manifest, system }
}

test('same controller/candidate library is byte-admitted before its valid verifier runs', async () => {
  const s = await candidate()
  assert.deepEqual(realFlipDeps(s.system, s.root, s.lib).verifyLib(s.lib), [])
  assert.equal(readFileSync(s.marker, 'utf8'), 'ran')
})

for (const changed of ['scripts/lib-verify.mjs', 'dist/src/adapter.mjs', 'scripts/adapter-link'])
  test(`changed candidate ${changed} fails before any candidate code executes`, async () => {
    const s = await candidate()
    if (changed === 'scripts/adapter-link') {
      unlinkSync(join(s.lib, changed))
      symlinkSync('../dist/src/moved.mjs', join(s.lib, changed))
    } else
      writeFileSync(
        join(s.lib, changed),
        `${readFileSync(join(s.lib, changed), 'utf8')}\n// replaced\n`,
      )
    const result = realFlipDeps(s.system, s.root, s.lib).verifyLib(s.lib)
    assert.ok(result.length, 'changed manifested bytes must fail')
    assert.equal(existsSync(s.marker), false, 'unchecked candidate must never run')
    assert.deepEqual(readFileSync(join(s.lib, 'install-manifest.json')), s.manifest)
  })
