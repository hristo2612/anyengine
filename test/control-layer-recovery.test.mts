import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { enginePaths } from '../src/anyengine-config.mjs'
import {
  type FileChange,
  type Layer,
  LayerWriter,
  readLayers,
  restoreChange,
  sha256Of,
  writeLayers,
} from '../src/control-layers.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const STAMP = '20300101T000000Z'
function changeAt(layer: Layer, index = 0): FileChange {
  const change = layer.changes[index]
  assert.ok(change)
  return change
}

// Removing write-ahead publication or replacing the settled after bytes would
// strand the already-installed generation when the next publication fails.
for (const kind of ['file', 'link'] as const) {
  test(`recovery: interrupted repeated ${kind} write retains the installed generation and initial baseline`, async () => {
    const home = await tempDir('anyengine-layer-recovery-')
    const root = join(home, '.anyengine')
    const target = join(home, 'target')
    if (kind === 'file') writeFileSync(target, 'initial\n')
    else symlinkSync('initial', target)
    let stop = false
    const writer = new LayerWriter(root, null, 'router', STAMP, (layer) => {
      writeLayers(root, { version: 1, layers: [layer] })
      if (stop) throw new Error('script publication failed')
    })
    if (kind === 'file') writer.writeFile(target, 'first\n', 0o644)
    else writer.writeSymlink(target, 'first')
    stop = true
    assert.throws(
      () =>
        kind === 'file'
          ? writer.writeFile(target, 'second\n', 0o644)
          : writer.writeSymlink(target, 'second'),
      /script publication failed/,
    )
    const layer = readLayers(root).layers[0]
    assert.ok(layer?.changes[0])
    assert.equal(restoreChange(layer.changes[0], layer.rollbackDir, false).outcome, 'restored')
    assert.equal(
      kind === 'file' ? readFileSync(target, 'utf8') : readlinkSync(target),
      kind === 'file' ? 'initial\n' : 'initial',
    )
  })
}

test('recovery: a writer without a script callback still publishes its journal', async () => {
  const home = await tempDir('anyengine-layer-recovery-')
  const root = join(home, '.anyengine')
  const target = join(home, 'target')
  const writer = new LayerWriter(root, null, 'router', STAMP)
  writer.writeFile(target, 'first\n', 0o640)
  const layer = readLayers(root).layers[0]
  assert.ok(layer?.changes[0], 'durable record exists without optional extra publication')
  assert.equal(restoreChange(layer.changes[0], layer.rollbackDir, false).outcome, 'restored')
  assert.equal(existsSync(target), false)
})

for (const invalid of ['json', 'null', 'version', 'shape', 'dangling', 'directory'] as const) {
  test(`recovery: present ${invalid} journal blocks read, replacement and removal without artifacts`, async () => {
    const home = await tempDir('anyengine-layer-recovery-')
    const root = join(home, '.anyengine')
    const path = enginePaths(root).layers
    mkdirSync(join(root, 'state'), { recursive: true })
    if (invalid === 'dangling') symlinkSync('missing', path)
    else if (invalid === 'directory') mkdirSync(path)
    else
      writeFileSync(
        path,
        invalid === 'null'
          ? 'null'
          : invalid === 'json'
            ? '{'
            : invalid === 'version'
              ? '{"version":2,"layers":[]}'
              : '{"version":1,"layers":[{}]}',
      )
    const original = invalid === 'directory' || invalid === 'dangling' ? null : readFileSync(path)
    assert.throws(() => readLayers(root), /layer|journal|recover/i)
    assert.throws(() => writeLayers(root, { version: 1, layers: [] }), /layer|journal|recover/i)
    assert.throws(() => new LayerWriter(root, null, 'router', STAMP), /layer|journal|recover/i)
    if (original) assert.deepEqual(readFileSync(path), original)
    assert.equal(existsSync(join(root, 'recovery')), false)
  })
}

test('recovery: absence and a genuinely encoded replacement character are valid', async () => {
  const home = await tempDir('anyengine-layer-recovery-')
  const root = join(home, '.anyengine')
  assert.deepEqual(readLayers(root), { version: 1, layers: [] })
  const target = join(home, 'real-�')
  const writer = new LayerWriter(root, null, 'router', STAMP)
  writer.writeFile(target, '�', 0o644)
  writeLayers(root, { version: 1, layers: [writer.layer] })
  assert.equal(readLayers(root).layers[0]?.changes[0]?.target, target)
})

test('recovery: file/link transitions and permission-only writes restore the exact original kind/mode', async () => {
  const home = await tempDir('anyengine-layer-recovery-')
  const root = join(home, '.anyengine')
  const file = join(home, 'file')
  writeFileSync(file, 'same\n', { mode: 0o600 })
  const writer = new LayerWriter(root, null, 'router', STAMP)
  writer.writeFile(file, 'same\n', 0o755)
  assert.equal(
    restoreChange(changeAt(writer.layer), writer.layer.rollbackDir, false).outcome,
    'restored',
  )
  assert.equal(lstatSync(file).mode & 0o777, 0o600)
  writer.writeSymlink(file, 'somewhere')
  assert.equal(
    restoreChange(changeAt(writer.layer), writer.layer.rollbackDir, false).outcome,
    'restored',
  )
  assert.equal(readFileSync(file, 'utf8'), 'same\n')
  const link = join(home, 'link')
  symlinkSync('elsewhere', link)
  writer.writeFile(link, 'new\n', 0o640)
  assert.equal(
    restoreChange(changeAt(writer.layer, 1), writer.layer.rollbackDir, false).outcome,
    'restored',
  )
  assert.equal(readlinkSync(link), 'elsewhere')
})

test('recovery: corrupt backup cannot overwrite a target and remains pinned', async () => {
  const home = await tempDir('anyengine-layer-recovery-')
  const root = join(home, '.anyengine')
  const target = join(home, 'file')
  writeFileSync(target, 'before\n')
  const writer = new LayerWriter(root, null, 'router', STAMP)
  writer.writeFile(target, 'after\n', 0o644)
  writeLayers(root, { version: 1, layers: [writer.layer] })
  const change = changeAt(writer.layer)
  assert.ok(change.backup)
  const backup = join(writer.layer.rollbackDir, change.backup)
  writeFileSync(backup, 'corrupt\n')
  assert.throws(
    () => restoreChange(change, writer.layer.rollbackDir, false),
    /backup|evidence|hash/i,
  )
  assert.throws(() => readLayers(root), /backup|evidence|hash|layer/i)
  assert.throws(() => writeLayers(root, { version: 1, layers: [] }), /backup|evidence|hash|layer/i)
  assert.equal(readFileSync(target, 'utf8'), 'after\n')
  assert.equal(readFileSync(backup, 'utf8'), 'corrupt\n')
})

for (const suffix of ['sqlite', 'sqlite-wal', 'sqlite-shm', 'sqlite-journal', 'db', 'db-wal']) {
  test(`recovery: ${suffix} coordination objects are refused before ordinary reads or replacement`, async () => {
    const home = await tempDir('anyengine-layer-recovery-')
    const root = join(home, '.anyengine')
    const target = join(home, `coord.${suffix}`)
    writeFileSync(target, 'opaque')
    const inode = lstatSync(target).ino
    const writer = new LayerWriter(root, null, 'router', STAMP)
    assert.throws(() => sha256Of(target), /opaque|SQLite/)
    assert.throws(() => writer.writeFile(target, 'replacement', 0o600), /opaque|SQLite/)
    assert.throws(() => writer.writeSymlink(target, 'replacement'), /opaque|SQLite/)
    assert.equal(lstatSync(target).ino, inode)
    assert.equal(writer.layer.changes.length, 0)
  })
}

test('recovery: chmod after install is an operator change', async () => {
  const home = await tempDir('anyengine-layer-recovery-')
  const writer = new LayerWriter(join(home, '.anyengine'), null, 'router', STAMP)
  const target = join(home, 'file')
  writer.writeFile(target, 'new\n', 0o640)
  chmodSync(target, 0o600)
  assert.equal(
    restoreChange(changeAt(writer.layer), writer.layer.rollbackDir, false).outcome,
    'left-changed',
  )
  assert.equal(lstatSync(target).mode & 0o777, 0o600)
})

test('recovery: unsupported target kind is never recorded as absent', async () => {
  const home = await tempDir('anyengine-layer-recovery-')
  const target = join(home, 'directory')
  mkdirSync(target)
  const writer = new LayerWriter(join(home, '.anyengine'), null, 'router', STAMP)
  assert.throws(() => writer.track(target), /unsupported|regular|directory/i)
  assert.equal(writer.layer.changes.length, 0)
  rmSync(target, { recursive: true })
})

test('journal: invalid UTF-8 in an otherwise valid target retains bytes, backups and pins', async () => {
  const home = await tempDir('anyengine-layer-recovery-')
  const root = join(home, '.anyengine')
  const writer = new LayerWriter(root, null, 'router', STAMP)
  writer.writeFile(join(home, 'valid-�'), 'after\n', 0o644)
  const valid = readLayers(root)
  valid.recovery = {
    entry: join(root, 'recovery/anyengine-off'),
    controlLib: join(root, 'lib/pinned'),
    pinnedLibs: [join(root, 'lib/pinned')],
  }
  writeLayers(root, valid)
  const path = enginePaths(root).layers
  const good = readFileSync(path)
  const offset = good.indexOf(Buffer.from('�'))
  assert.ok(offset >= 0)
  const invalid = Buffer.concat([
    good.subarray(0, offset),
    Buffer.from([0xff]),
    good.subarray(offset + 3),
  ])
  writeFileSync(path, invalid)
  assert.throws(() => readLayers(root), /journal|recovery/)
  assert.throws(() => writeLayers(root, { version: 1, layers: [] }), /journal|recovery/)
  assert.deepEqual(readFileSync(path), invalid)
  assert.equal(existsSync(writer.layer.rollbackDir), true)
  writeFileSync(path, good)
  assert.deepEqual(readLayers(root).recovery, valid.recovery)
})
