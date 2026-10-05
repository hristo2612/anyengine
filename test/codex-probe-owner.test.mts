import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(killChildren)
after(removeTempDirs)

function group(group: number) {
  const result = spawnSync('/bin/ps', ['-o', 'pid=,pgid=,stat=', '-g', String(group)], {
    encoding: 'utf8',
  })
  assert.ok(
    result.status === 0 || (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()),
    result.stderr,
  )
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/)
      return { pid: Number(parts[0]), group: Number(parts[1]), state: parts[2] ?? '' }
    })
}
for (const [signal, changedHome] of [
  ['SIGTERM', false],
  ['SIGKILL', false],
  ['SIGTERM', true],
] as const) {
  test(`caller ${signal} joins its probe family; changed home ${changedHome}`, async (t) => {
    const root = await tempDir('probe-owner-')
    const tmp = join(root, 'tmp')
    mkdirSync(tmp)
    const fake = join(root, 'fake.mjs')
    writeFileSync(
      fake,
      `import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';
      const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
      writeFileSync('owner.json',JSON.stringify({pid:process.pid,group:process.ppid,descendant:child.pid}));setInterval(()=>{},1000);`,
    )
    const caller = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {isolatedCommand} from ${JSON.stringify(resolve('scripts/lib/codex-probe.mjs'))};isolatedCommand(${JSON.stringify(fake)},['--version'],{timeoutMs:2000});`,
      ],
      { env: { ...process.env, TMPDIR: tmp }, stdio: 'ignore' },
    )
    const closed = once(caller, 'close')
    let path = ''
    const startup = performance.now() + 5000
    while (!path) {
      const name = readdirSync(tmp).find((name) => existsSync(join(tmp, name, 'work/owner.json')))
      if (name) path = join(tmp, name, 'work/owner.json')
      else {
        assert.ok(performance.now() < startup, 'probe startup')
        await new Promise((done) => setTimeout(done, 5))
      }
    }
    const owner = JSON.parse(readFileSync(path, 'utf8'))
    const probe = join(path, '../..')
    if (changedHome) {
      renameSync(probe, join(tmp, 'retained-original'))
      mkdirSync(probe)
      writeFileSync(join(probe, 'foreign'), 'must retain')
    }
    t.after(async () => {
      const members = group(owner.group)
      if (members.some((member) => member.pid === owner.group && member.group === owner.group)) {
        try {
          process.kill(-owner.group, 'SIGKILL')
        } catch {}
        const stop = performance.now() + 2000
        while (group(owner.group).some((member) => !member.state.startsWith('Z'))) {
          assert.ok(performance.now() < stop, 'test safety teardown joined group')
          await new Promise((done) => setTimeout(done, 5))
        }
      }
    })
    const started = performance.now()
    caller.kill(signal)
    const exit = await closed
    const end = performance.now() + 2500
    while (performance.now() < end) {
      const terminal = group(owner.group).every((member) => member.state.startsWith('Z'))
      if (terminal && (changedHome || readdirSync(tmp).length === 0)) break
      await new Promise((done) => setTimeout(done, 5))
    }
    const terminal = group(owner.group)
    const diagnosis = join(path, '../../cleanup-diagnostic.json')
    t.diagnostic(
      JSON.stringify({
        caller: caller.pid,
        exit,
        supervisor: owner.group,
        child: owner.pid,
        descendant: owner.descendant,
        probe: join(path, '../..'),
        elapsed: performance.now() - started,
        terminal,
        leftovers: readdirSync(tmp),
        diagnosis: existsSync(diagnosis) ? readFileSync(diagnosis, 'utf8') : null,
      }),
    )
    assert.ok(
      terminal.every((member) => member.state.startsWith('Z')),
      'no live owned member remains',
    )
    if (changedHome) {
      assert.equal(readFileSync(join(probe, 'foreign'), 'utf8'), 'must retain')
      assert.equal(readdirSync(tmp).length, 2, 'ambiguous home and original evidence retained')
    } else assert.deepEqual(readdirSync(tmp), [], 'exact owned probe home removed')
    assert.ok(performance.now() - started < 2600, 'total probe deadline with scheduling margin')
  })
}
