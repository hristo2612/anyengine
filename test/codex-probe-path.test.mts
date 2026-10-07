import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  lstatSync,
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

function members(group: number) {
  const result = spawnSync('/bin/ps', ['-o', 'pid=,pgid=,stat=', '-g', String(group)], {
    encoding: 'utf8',
    timeout: 2000,
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
      const [pid, pgid, state] = line.trim().split(/\s+/)
      return { pid: Number(pid), pgid: Number(pgid), state: state ?? '' }
    })
}
async function until<T>(read: () => T, label: string) {
  const deadline = performance.now() + 5000
  for (;;) {
    const result = read()
    if (result) return result
    assert.ok(performance.now() < deadline, label)
    await new Promise((done) => setTimeout(done, 5))
  }
}

for (const [behavior, ownership] of [
  ['success', 'replacement'],
  ['timeout', 'replacement'],
  ['success', 'missing'],
  ['timeout', 'unreadable'],
  ['success', 'changed-by-read'],
] as const) {
  test(`normal probe ${behavior} retains ${ownership} ownership evidence`, async (t) => {
    const root = await tempDir('probe-path-')
    const tmp = join(root, 'tmp')
    mkdirSync(tmp)
    const fake = join(root, 'fake.mjs')
    writeFileSync(
      fake,
      `import {writeFileSync,existsSync,renameSync} from 'node:fs';
      writeFileSync('owner.json.tmp',JSON.stringify({pid:process.pid,group:process.ppid}));
      renameSync('owner.json.tmp','owner.json');
      console.log('codex-cli 0.159.0');
      setInterval(()=>{if(existsSync('release'))process.exit(0)},5);`,
    )
    const caller = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {isolatedCommand} from ${JSON.stringify(resolve('scripts/lib/codex-probe.mjs'))};
       import {renameSync,mkdirSync,writeFileSync} from 'node:fs';
       let readCalled=false;
       const result=isolatedCommand(${JSON.stringify(fake)},['--version'],{timeoutMs:2000,read:({probe})=>{
         readCalled=true;
         if(${JSON.stringify(ownership)}==='changed-by-read'){
           renameSync(probe,probe+'-original');mkdirSync(probe);writeFileSync(probe+'/foreign','must survive');
         }
         return 'directory-derived value';
       }});
       console.log(JSON.stringify({result,readCalled}));`,
      ],
      { env: { ...process.env, TMPDIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = '',
      stderr = ''
    caller.stdout?.on('data', (data) => (stdout += data))
    caller.stderr?.on('data', (data) => (stderr += data))
    const closed = once(caller, 'close')
    t.after(() => chmodSync(tmp, 0o700))
    const name = await until(
      () => readdirSync(tmp).find((name) => existsSync(join(tmp, name, 'work/owner.json'))),
      'fake startup',
    )
    const probe = join(tmp, name)
    const owner = JSON.parse(readFileSync(join(probe, 'work/owner.json'), 'utf8'))
    t.after(async () => {
      if (
        members(owner.group).some(
          (member) => member.pid === owner.group && member.pgid === owner.group,
        )
      ) {
        try {
          process.kill(-owner.group, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await until(
        () => members(owner.group).every((member) => member.state.startsWith('Z')),
        'owned group terminal',
      )
    })
    const original = join(tmp, 'original')
    const identity = lstatSync(probe).ino
    if (ownership === 'replacement' || ownership === 'missing') renameSync(probe, original)
    if (ownership === 'replacement') {
      mkdirSync(probe)
      writeFileSync(join(probe, 'foreign'), 'must survive')
      assert.notEqual(lstatSync(probe).ino, identity)
    }
    if (ownership === 'unreadable') chmodSync(tmp, 0)
    if (behavior === 'success')
      writeFileSync(join(ownership === 'changed-by-read' ? probe : original, 'work/release'), '')
    const exit = await closed
    chmodSync(tmp, 0o700)
    await until(
      () => members(owner.group).every((member) => member.state.startsWith('Z')),
      'owned group terminal',
    )
    const { result, readCalled } = JSON.parse(stdout.trim())
    t.diagnostic(
      JSON.stringify({
        behavior,
        ownership,
        caller: caller.pid,
        owner,
        exit,
        identity,
        result,
        readCalled,
        stderr,
        retained: readdirSync(tmp),
        terminal: members(owner.group),
      }),
    )
    assert.notEqual(result.status, 0, 'unknown directory ownership cannot certify success')
    assert.match(result.stderr, /ownership/)
    assert.equal(
      readCalled,
      ownership === 'changed-by-read',
      'directory callback needs positive ownership',
    )
    assert.equal(
      result.value,
      undefined,
      'failed ownership cannot return a directory-derived value',
    )
    if (ownership === 'replacement' || ownership === 'changed-by-read')
      assert.equal(readFileSync(join(probe, 'foreign'), 'utf8'), 'must survive')
    if (ownership === 'replacement' || ownership === 'missing') assert.ok(existsSync(original))
    if (ownership === 'unreadable') assert.ok(existsSync(join(probe, 'work/owner.json')))
    if (ownership === 'changed-by-read') assert.ok(existsSync(`${probe}-original`))
  })
}
