import assert from 'node:assert/strict'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { swapLink } from '../src/control-layer-state.mjs'
import { LayerWriter, readLayers, restoreChange } from '../src/control-layers.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
async function fixture() {
  const home = await tempDir('anyengine-leaf-')
  const root = join(home, 'root')
  const directory = join(home, 'referent')
  mkdirSync(directory)
  writeFileSync(join(directory, 'keep'), 'untouched\n')
  return { home, root, directory, target: join(home, 'link') }
}
const absent = (path: string) => lstatSync(path, { throwIfNoEntry: false }) === undefined
for (const destination of ['referent', 'missing']) {
  test(`restore initial absence removes only the ${destination} symlink leaf`, async () => {
    const s = await fixture()
    const writer = new LayerWriter(s.root, null, 'router', 'leaf')
    writer.writeSymlink(s.target, destination)
    const change = writer.layer.changes[0]
    assert.ok(change)
    const journal = readFileSync(join(s.root, 'state/layers.json'))
    assert.equal(restoreChange(change, writer.layer.rollbackDir, true).outcome, 'restored')
    assert.equal(absent(s.target), true)
    assert.equal(readFileSync(join(s.directory, 'keep'), 'utf8'), 'untouched\n')
    assert.deepEqual(readFileSync(join(s.root, 'state/layers.json')), journal)
  })
  test(`removeFile journals before unlink and settles actual absence of ${destination} link`, async () => {
    const s = await fixture()
    symlinkSync(destination, s.target)
    let intent = false
    const writer = new LayerWriter(s.root, null, 'router', 'leaf', (_layer, phase) => {
      if (phase !== 'intent') return
      intent = true
      assert.equal(lstatSync(s.target).isSymbolicLink(), true)
      assert.equal(readLayers(s.root).layers[0]?.changes[0]?.pending?.kind, 'absent')
    })
    assert.equal(writer.removeFile(s.target), true)
    assert.equal(intent, true)
    assert.equal(absent(s.target), true)
    assert.equal(writer.layer.changes[0]?.pending, null)
    assert.equal(writer.layer.changes[0]?.beforeLink, destination)
    assert.equal(readFileSync(join(s.directory, 'keep'), 'utf8'), 'untouched\n')
  })
  test(`failed link replacement cleans its temporary ${destination} link and preserves actual directory`, async () => {
    const s = await fixture()
    mkdirSync(s.target)
    writeFileSync(join(s.target, 'keep'), 'directory remains\n')
    const before = readdirSync(s.home).sort()
    assert.throws(() => swapLink(s.target, destination))
    assert.deepEqual(readdirSync(s.home).sort(), before)
    assert.equal(readFileSync(join(s.target, 'keep'), 'utf8'), 'directory remains\n')
    assert.equal(readFileSync(join(s.directory, 'keep'), 'utf8'), 'untouched\n')
  })
}
test('actual directory refuses removal/restoration before publishing destructive intent', async () => {
  const s = await fixture()
  const writer = new LayerWriter(s.root, null, 'router', 'leaf')
  writer.writeSymlink(s.target, 'referent')
  const change = writer.layer.changes[0]
  assert.ok(change)
  unlinkSync(s.target)
  mkdirSync(s.target)
  writeFileSync(join(s.target, 'keep'), 'directory remains\n')
  const journal = readFileSync(join(s.root, 'state/layers.json'))
  assert.throws(() => writer.removeFile(s.target), /unsupported recovery target kind/)
  assert.throws(
    () => restoreChange(change, writer.layer.rollbackDir, true),
    /unsupported recovery target kind/,
  )
  assert.deepEqual(readFileSync(join(s.root, 'state/layers.json')), journal)
  assert.equal(readFileSync(join(s.target, 'keep'), 'utf8'), 'directory remains\n')
})
test('unlink ENOENT after published intent remains an error with pending recovery and poisoned writer', async () => {
  const s = await fixture()
  writeFileSync(s.target, 'original\n')
  const writer = new LayerWriter(s.root, null, 'router', 'leaf', (_layer, phase) => {
    if (phase === 'intent') unlinkSync(s.target)
  })
  assert.throws(() => writer.removeFile(s.target), { code: 'ENOENT' })
  const layer = readLayers(s.root).layers[0]
  const change = layer?.changes[0]
  assert.ok(layer && change)
  assert.equal(change.pending?.kind, 'absent')
  assert.throws(() => writer.writeFile(s.target, 'new', 0o600), /incomplete/)
  assert.equal(restoreChange(change, layer.rollbackDir, true).outcome, 'restored')
  assert.equal(readFileSync(s.target, 'utf8'), 'original\n')
})
