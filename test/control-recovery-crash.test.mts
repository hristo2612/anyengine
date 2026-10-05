import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { recoveryPaths } from '../src/control-layers.mjs'
import { shellQuote } from '../src/control-scripts.mjs'
import { configure, run, setup } from './helpers/recovery-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)

for (const kind of ['file', 'link'])
  for (const repeated of [false, true])
    for (const cut of ['journal', 'callback', 'private-script', 'target', 'settled']) {
      test(`actual SIGKILL ${kind} ${repeated ? 'upgrade' : 'initial'} at ${cut} recovers via existing Node-free entry`, async () => {
        const s = await setup(true),
          target = join(s.home, 'target'),
          child = join(s.home, 'crash.mjs')
        if (kind === 'file') writeFileSync(target, 'initial\n')
        else symlinkSync('initial lib', target)
        if (repeated) {
          if (kind === 'file') s.writer.writeFile(target, 'last-good\n', 0o600)
          else s.writer.writeSymlink(target, "last-good ' lib")
          s.writer.beginUpgrade()
        }
        writeFileSync(
          child,
          `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {LayerWriter,readLayers} from ${JSON.stringify(resolve('dist/src/control-layers.mjs'))};
import {publishRecovery} from ${JSON.stringify(resolve('dist/src/control-scripts.mjs'))};
const options=${JSON.stringify(s.options)}, target=${JSON.stringify(target)}, cut=${JSON.stringify(cut)};
const rename=fs.renameSync;
fs.renameSync=(from,to)=>{
  if(cut==='journal' && to===options.root+'/state/layers.json') process.kill(process.pid,'SIGKILL');
  rename(from,to);
  if(cut==='private-script' && to===options.root+'/recovery/anyengine-off') process.kill(process.pid,'SIGKILL');
  if(cut==='target' && to===target) process.kill(process.pid,'SIGKILL');
};
syncBuiltinESMExports();
const writer=new LayerWriter(options.root,readLayers(options.root).layers.find(l=>l.name==='router')||null,'router','crash',(layer,phase)=>{
  if(cut==='callback' || (cut==='settled' && phase==='settled')) process.kill(process.pid,'SIGKILL');
  publishRecovery(options);
});
${kind === 'file' ? 'writer.writeFile(target,"new\\n",0o600);' : 'writer.writeSymlink(target,"new lib");'}
`,
        )
        const result = spawnSync(process.execPath, [child], {
          env: process.env,
          encoding: 'utf8',
          timeout: 30000,
        })
        assert.equal(result.signal, 'SIGKILL', result.stdout + result.stderr)
        assert.ok(existsSync(recoveryPaths(s.root).entry))
        const recovered = run(s, ...(repeated ? ['--last-good'] : []), '--no-restart')
        assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr)
        const actual = kind === 'file' ? readFileSync(target, 'utf8') : readlinkSync(target)
        assert.equal(
          actual,
          repeated
            ? kind === 'file'
              ? 'last-good\n'
              : "last-good ' lib"
            : kind === 'file'
              ? 'initial\n'
              : 'initial lib',
        )
        if (repeated) {
          const off = run(s, '--no-restart')
          assert.equal(off.status, 0, off.stdout + off.stderr)
          assert.equal(
            kind === 'file' ? readFileSync(target, 'utf8') : readlinkSync(target),
            kind === 'file' ? 'initial\n' : 'initial lib',
          )
        }
      })
    }

test('TERM after confirmed quit attempts reopen and preserves recovery evidence', async () => {
  const s = await setup(),
    down = join(s.home, 'down')
  s.writer.addJob('dev.anyengine.router')
  s.env.ANYENGINE_PGREP = s.stub(
    'query',
    `if [ -e ${shellQuote(down)} ]; then exit 1; fi; echo 123`,
  )
  s.env.ANYENGINE_OSASCRIPT = s.stub(
    'quit-now',
    `: > ${shellQuote(down)}; echo quit >> ${shellQuote(s.calls)}`,
  )
  s.env.ANYENGINE_LAUNCHCTL = s.stub('signal', `if [ "$1" = bootout ]; then kill -TERM "$PPID"; fi`)
  configure(s)
  const result = run(s)
  assert.notEqual(result.status, 0)
  assert.match(readFileSync(s.calls, 'utf8'), /quit\nopen/)
  assert.ok(existsSync(recoveryPaths(s.root).entry))
})
