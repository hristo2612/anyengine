import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs, { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import test, { after } from 'node:test'
import {
  clearDegraded,
  inspectProof,
  markDegraded,
  markProven,
  readDegraded,
  readProof,
} from '../src/degraded.mjs'
import { withFileLock } from '../src/file-lock.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(() => killChildren())
after(removeTempDirs)
const key = { lib: 'lib', appVersion: 'app', codexVersion: 'codex', settings: 'settings' }
const module = new URL('../src/degraded.mjs', import.meta.url).href
const worker = `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const [module,root,operation,role,gate] = process.argv.slice(1)
const ready = root+'/'+role+'-ready', go=root+'/go'
const pause=new Int32Array(new SharedArrayBuffer(4))
const wait=()=>{const deadline=performance.now()+15000;while(!fs.existsSync(go)){if(performance.now()>deadline) throw Error('barrier timeout');Atomics.wait(pause,0,0,5)}}
const originalRename=fs.renameSync, originalRead=fs.readFileSync
let announced=false
if(role==='publisher') fs.renameSync=(from,to)=>{
 if(String(to).endsWith('/'+gate) && !announced){announced=true;fs.writeFileSync(ready,'');wait()}
 return originalRename(from,to)
}
else fs.readFileSync=(path,...args)=>{
 const data=originalRead(path,...args)
 if(String(path).endsWith('/degraded.json')&&!announced){announced=true;fs.writeFileSync(ready,'')}
 return data
}
syncBuiltinESMExports()
const api=await import(module)
try {
 const key={lib:'lib',appVersion:'app',codexVersion:'codex',settings:'settings'}
 if(operation==='markProven') api.markProven(root,'gpt','concurrent pass',key)
 if(operation==='markDegraded') api.markDegraded(root,'gpt','concurrent failure')
 if(operation==='clearProof') api.clearProof(root,'native-fanout')
 if(operation==='clearDegraded') api.clearDegraded(root,'native-fanout')
 fs.writeFileSync(root+'/'+role+'-done','ok')
} catch(error) {fs.writeFileSync(root+'/'+role+'-done',String(error));process.exitCode=1}
`
async function until(path: string) {
  const deadline = performance.now() + 15000
  while (!existsSync(path)) {
    if (performance.now() > deadline) throw new Error(`missing barrier ${path}`)
    await new Promise((done) => setTimeout(done, 5))
  }
}
for (const [publish, clear, record] of [
  ['markProven', 'clearProof', 'proven.json'],
  ['markDegraded', 'clearDegraded', 'degraded.json'],
] as const) {
  test(`producer ${publish}/${clear}: concurrent different paths serialize on the same stable gate`, async () => {
    const root = await tempDir('evidence-lock-')
    markProven(root, 'native-fanout', 'initial pass', key)
    markDegraded(root, 'native-fanout', 'initial failure')
    // Both records exist and native has the data the competing clear removes.
    markProven(root, 'native-fanout', 'fresh pass', key)
    withFileLock(join(root, 'state/proof-degraded.lock'), () => {})
    const gate = join(root, 'state/proof-degraded.lock.sqlite')
    const inode = statSync(gate).ino // stat only; never read/hash a coordination database.
    const first = spawn(
      process.execPath,
      ['--input-type=module', '-e', worker, module, root, publish, 'publisher', record],
      { stdio: 'ignore' },
    )
    const firstExit = once(first, 'exit')
    await until(join(root, 'publisher-ready'))
    const second = spawn(
      process.execPath,
      ['--input-type=module', '-e', worker, module, root, clear, 'clearer', record],
      { stdio: 'ignore' },
    )
    const secondExit = once(second, 'exit')
    try {
      await until(join(root, 'clearer-ready'))
      // Ready is emitted after the real preflight read, immediately before gate
      // acquisition. A bounded observation verifies it cannot finish while held.
      await new Promise((done) => setTimeout(done, 150))
      assert.equal(
        existsSync(join(root, 'clearer-done')),
        false,
        'clear entered while another public mutation held the gate',
      )
    } finally {
      writeFileSync(join(root, 'go'), '')
    }
    assert.equal((await firstExit)[0], 0)
    assert.equal((await secondExit)[0], 0)
    if (record === 'proven.json') {
      assert.equal(readProof(root, 'native-fanout'), null)
      assert.equal(readProof(root, 'gpt')?.detail, 'concurrent pass')
    } else {
      assert.equal(readDegraded(root).paths['native-fanout'], undefined)
      assert.equal(readDegraded(root).paths.gpt?.reason, 'concurrent failure')
    }
    assert.equal(statSync(gate).ino, inode)
  })
}

test('proof mutation rereads both raw records after waiting and refuses newly corrupt state', async () => {
  const root = await tempDir('evidence-reread-')
  mkdirSync(join(root, 'state'))
  markProven(root, 'native-fanout', 'pass', key)
  markDegraded(root, 'router', 'failure')
  const holderCode = `import {withFileLock} from ${JSON.stringify(new URL('../src/file-lock.mjs', import.meta.url).href)};
    import fs from 'node:fs'; const root=process.argv[1];
    withFileLock(root+'/state/proof-degraded.lock',()=>{
      fs.writeFileSync(root+'/held',''); const deadline=performance.now()+15000;
      while(!fs.existsSync(root+'/go')){if(performance.now()>deadline)throw Error('timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}
      fs.writeFileSync(root+'/state/degraded.json','{"paths":');
    });`
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderCode, root], {
    stdio: 'ignore',
  })
  const heldExit = once(holder, 'exit')
  await until(join(root, 'held'))
  const before = readFileSync(join(root, 'state/proven.json'))
  const publisher = spawn(
    process.execPath,
    ['--input-type=module', '-e', worker, module, root, 'markProven', 'clearer', 'proven.json'],
    { stdio: 'ignore' },
  )
  const publisherExit = once(publisher, 'exit')
  try {
    await until(join(root, 'clearer-ready'))
  } finally {
    writeFileSync(join(root, 'go'), '')
  }
  assert.equal((await heldExit)[0], 0)
  assert.equal((await publisherExit)[0], 1)
  assert.match(readFileSync(join(root, 'clearer-done'), 'utf8'), /degraded.*evidence/)
  assert.ok(readFileSync(join(root, 'state/proven.json')).equals(before))
  assert.equal(inspectProof(root)?.paths.gpt, undefined)
})

test('oversize exact publication refuses before artifacts and keeps encoded replacement characters valid', async () => {
  const root = await tempDir('evidence-bound-')
  assert.throws(() => markProven(root, 'gpt', '\u0001'.repeat(400_000), key), /byte limit/)
  assert.deepEqual((await import('node:fs')).readdirSync(root), [])
  markDegraded(root, 'router', 'valid \uFFFD')
  const before = readFileSync(join(root, 'state/degraded.json'))
  assert.throws(() => markDegraded(root, 'gpt', '\u0001'.repeat(400_000)), /byte limit/)
  assert.ok(readFileSync(join(root, 'state/degraded.json')).equals(before))
  clearDegraded(root, 'router')
  const entry = { paths: { gpt: { at: new Date().toISOString(), detail: '', key } } }
  const detail = 'a'.repeat(2_000_000 - Buffer.byteLength(`${JSON.stringify(entry, null, 2)}\n`))
  markProven(root, 'gpt', detail, key)
  assert.equal(readFileSync(join(root, 'state/proven.json')).length, 2_000_000)
  assert.equal(readProof(root, 'gpt')?.detail, detail, 'exact writer boundary remains readable')
})

test('a partial degraded publication removes proof before retaining the previous failure record', async () => {
  const root = await tempDir('evidence-partial-')
  markDegraded(root, 'router', 'existing failure')
  markProven(root, 'gpt', 'existing pass', key)
  const path = join(root, 'state/degraded.json')
  const before = readFileSync(path)
  const original = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === path) throw new Error('fixture publication refused')
    return original(from, to)
  }
  syncBuiltinESMExports()
  try {
    assert.throws(() => markDegraded(root, 'gpt', 'new failure'), /fixture publication refused/)
  } finally {
    fs.renameSync = original
    syncBuiltinESMExports()
  }
  assert.equal(readProof(root, 'gpt'), null)
  assert.ok(readFileSync(path).equals(before))
})
