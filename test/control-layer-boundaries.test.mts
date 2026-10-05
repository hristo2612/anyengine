import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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
  type Layer,
  type LayerFile,
  LayerWriter,
  POPPED,
  readLayers,
  recoveryPaths,
  restoreChange,
  writeLayers,
} from '../src/control-layers.mjs'
import { rcPath, revertHunk, withRcBlock } from '../src/control-rc.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(killChildren)
after(removeTempDirs)
const STAMP = '20320101T000000Z'
function layerOf(file: LayerFile): Layer {
  const layer = file.layers[0]
  assert.ok(layer)
  return layer
}
function first(layer: Layer) {
  const change = layer.changes[0]
  assert.ok(change)
  return change
}

// A hard process death skips finally/catch. Re-enter using only the durable
// record after each script-publication boundary, for first and repeated writes.
for (const kind of ['file', 'link'] as const) {
  for (const repeated of [false, true]) {
    for (const cut of [
      'before-journal',
      'before-script',
      'after-script',
      'target',
      'settled',
    ] as const) {
      test(`crash: ${kind} ${repeated ? 'upgrade' : 'initial'} killed ${cut} remains recoverable`, async () => {
        const home = await tempDir('anyengine-layer-crash-')
        const root = join(home, 'engine root')
        const target = join(home, 'target')
        if (kind === 'file') writeFileSync(target, 'vanilla\n')
        else symlinkSync('vanilla', target)
        if (repeated) {
          const writer = new LayerWriter(root, null, 'router', STAMP)
          if (kind === 'file') writer.writeFile(target, 'last-good\n', 0o640)
          else writer.writeSymlink(target, 'last-good')
        }
        const module = new URL('../src/control-layers.mjs', import.meta.url).href
        const script = join(home, 'crash.mjs')
        writeFileSync(
          script,
          `import fs, { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { LayerWriter, readLayers } from ${JSON.stringify(module)};
const root = ${JSON.stringify(root)}, target = ${JSON.stringify(target)};
const rename = fs.renameSync;
fs.renameSync = (source, destination) => {
 if (${JSON.stringify(cut)} === 'before-journal' && destination === root + '/state/layers.json') process.kill(process.pid, 'SIGKILL');
 rename(source, destination);
 if (${JSON.stringify(cut)} === 'target' && destination === target) process.kill(process.pid, 'SIGKILL');
};
syncBuiltinESMExports();
const writer = new LayerWriter(root, readLayers(root).layers[0] ?? null, 'router', ${JSON.stringify(STAMP)}, (layer, phase) => {
 if (phase === 'intent') {
  if (${JSON.stringify(cut)} === 'before-script') process.kill(process.pid, 'SIGKILL');
  writeFileSync(layer.rollbackDir + '/script-snapshot.json', JSON.stringify(layer));
  if (${JSON.stringify(cut)} === 'after-script') process.kill(process.pid, 'SIGKILL');
 }
 if (phase === 'settled' && ${JSON.stringify(cut)} === 'settled') process.kill(process.pid, 'SIGKILL');
});
${kind === 'file' ? "writer.writeFile(target, 'next\\n', 0o640);" : "writer.writeSymlink(target, 'next');"}
`,
        )
        const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr?.on('data', (chunk) => {
          stderr += chunk
        })
        const [code, signal] = await once(child, 'exit')
        assert.equal(signal, 'SIGKILL', `${code}: ${stderr}`)
        const layer = readLayers(root).layers[0]
        const installed =
          cut === 'settled' || cut === 'target' ? 'next' : repeated ? 'last-good' : 'vanilla'
        if (!repeated && cut === 'before-journal') {
          assert.equal(layer, undefined)
          assert.equal(
            kind === 'file' ? readFileSync(target, 'utf8') : readlinkSync(target),
            kind === 'file' ? 'vanilla\n' : 'vanilla',
          )
          return
        }
        assert.ok(layer)
        const change = first(layer)
        assert.equal(
          kind === 'file' ? readFileSync(target, 'utf8') : readlinkSync(target),
          kind === 'file' ? `${installed}\n` : installed,
        )
        if (cut !== 'before-script' && cut !== 'before-journal') {
          const scriptRecord = JSON.parse(
            readFileSync(join(layer.rollbackDir, 'script-snapshot.json'), 'utf8'),
          ) as Layer
          assert.equal(
            restoreChange(first(scriptRecord), layer.rollbackDir, false).outcome,
            installed === 'vanilla' ? 'already' : 'restored',
            'pre-target script snapshot recovers either generation',
          )
        }
        restoreChange(change, layer.rollbackDir, false)
        assert.equal(
          kind === 'file' ? readFileSync(target, 'utf8') : readlinkSync(target),
          kind === 'file' ? 'vanilla\n' : 'vanilla',
        )
      })
    }
  }
}

test('upgrade: immediate binary/file/link baseline survives recovery and the initial ladder remains intact', async () => {
  const home = await tempDir('anyengine-layer-boundary-')
  const root = join(home, 'engine root')
  const target = join(home, 'binary')
  const link = join(home, 'current')
  writeFileSync(target, Buffer.from([0, 1]))
  symlinkSync('m0', link)
  const writer = new LayerWriter(root, null, 'router', STAMP)
  writer.writeFile(target, Buffer.from([0, 2]), 0o640)
  writer.writeSymlink(link, 'm1-good')
  writer.addJob('dev.anyengine.router')
  writer.beginUpgrade()
  writer.writeFile(target, Buffer.from([0, 3]), 0o600)
  writer.writeSymlink(link, 'm1-new')
  const added = join(home, 'new-target')
  writer.writeFile(added, 'new', 0o644)
  let layer = readLayers(root).layers[0]
  assert.ok(layer)
  for (const change of layer.changes)
    assert.equal(restoreChange(change, layer.rollbackDir, false, 'last-good').outcome, 'restored')
  assert.deepEqual(readFileSync(target), Buffer.from([0, 2]))
  assert.equal(readlinkSync(link), 'm1-good')
  assert.equal(existsSync(added), false)
  const resumed = new LayerWriter(root, layer, 'router', STAMP)
  resumed.finishUpgrade('recovered')
  assert.doesNotThrow(
    () => resumed.beginUpgrade(),
    'recovered settlement is reusable as immediate last-good',
  )
  layer = readLayers(root).layers[0]
  assert.ok(layer)
  for (const change of layer.changes) restoreChange(change, layer.rollbackDir, false)
  assert.deepEqual(readFileSync(target), Buffer.from([0, 1]))
  assert.equal(readlinkSync(link), 'm0')
})

test('upgrade: pending publication can be recovered to last-good and terminal retirement verifies targets', async () => {
  const home = await tempDir('anyengine-layer-boundary-')
  const root = join(home, '.anyengine')
  const target = join(home, 'target')
  const firstWriter = new LayerWriter(root, null, 'router', STAMP)
  firstWriter.writeFile(target, 'good\n', 0o644)
  firstWriter.beginUpgrade()
  const writer = new LayerWriter(
    root,
    readLayers(root).layers[0] ?? null,
    'router',
    STAMP,
    (_layer, phase) => {
      if (phase === 'intent') throw new Error('script publication interrupted')
    },
  )
  assert.throws(() => writer.writeFile(target, 'next\n', 0o644), /interrupted/)
  const layer = readLayers(root).layers[0]
  assert.ok(layer)
  assert.equal(
    restoreChange(first(layer), layer.rollbackDir, false, 'last-good').outcome,
    'already',
  )
  const resumed = new LayerWriter(root, layer, 'router', STAMP)
  resumed.finishUpgrade('recovered')
  assert.equal(readLayers(root).layers[0]?.changes[0]?.pending, null)
  resumed.beginUpgrade()
  writeFileSync(target, 'operator\n')
  assert.throws(() => resumed.finishUpgrade(), /verif|changed|settle|recover/i)
  assert.ok(readLayers(root).layers[0]?.upgrade)
})

test('journal: unknown nested fields, escaping backups and foreign recovery directories retain raw bytes and pins', async () => {
  const home = await tempDir('anyengine-layer-boundary-')
  const root = join(home, '.anyengine')
  const writer = new LayerWriter(root, null, 'router', STAMP)
  writer.writeFile(join(home, 'target'), 'new\n', 0o644)
  const valid = readLayers(root)
  valid.recovery = {
    entry: recoveryPaths(root).entry,
    controlLib: join(root, 'lib/old-pinned'),
    pinnedLibs: [join(root, 'lib/old-pinned')],
  }
  writeLayers(root, valid)
  const path = enginePaths(root).layers
  const original = readFileSync(path)
  for (const alter of [
    (file: LayerFile) => {
      Object.assign(first(layerOf(file)), { unrecognizedPending: true })
    },
    (file: LayerFile) => {
      first(layerOf(file)).after = '../external'
    },
    (file: LayerFile) => {
      layerOf(file).rollbackDir = join(home, 'foreign')
    },
    (file: LayerFile) => {
      assert.ok(file.recovery)
      file.recovery.entry = join(root, 'bin/anyengine-off')
    },
  ]) {
    const invalid = JSON.parse(original.toString())
    alter(invalid)
    const raw = Buffer.from(JSON.stringify(invalid))
    writeFileSync(path, raw)
    assert.throws(() => readLayers(root), /invalid|unsupported|layer|recovery/)
    assert.throws(() => writeLayers(root, { version: 1, layers: [] }))
    assert.deepEqual(readFileSync(path), raw)
    writeFileSync(path, original)
  }
})

test('journal: symlinked state and recovery directories cannot redirect authority', async () => {
  const home = await tempDir('anyengine-layer-boundary-')
  const root = join(home, 'root')
  const outside = join(home, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'layers.json'), '{"version":1,"layers":[]}')
  symlinkSync(outside, join(root, 'state'))
  assert.throws(
    () => new LayerWriter(root, null, 'router', STAMP),
    /directory|journal|layer|recovery/i,
  )
  assert.equal(existsSync(join(root, 'recovery')), false)
})

test('recovery: target rename failure and settlement callback failure propagate and retain records', async () => {
  const home = await tempDir('anyengine-layer-boundary-')
  const root = join(home, '.anyengine')
  const target = join(home, 'target')
  const writer = new LayerWriter(root, null, 'router', STAMP, (_layer, phase) => {
    if (phase === 'intent') mkdirSync(target)
  })
  assert.throws(() => writer.writeFile(target, 'after\n', 0o644))
  assert.ok(readLayers(root).layers[0]?.changes[0]?.pending)
  rmSync(target, { recursive: true })
  const pending = readLayers(root).layers[0]
  assert.ok(pending)
  assert.equal(restoreChange(first(pending), pending.rollbackDir, false).outcome, 'already')
  const secondRoot = join(home, 'second')
  const settled = new LayerWriter(secondRoot, null, 'router', STAMP, (_layer, phase) => {
    if (phase === 'settled') throw new Error('settlement publication failed')
  })
  assert.throws(() => settled.writeFile(target, 'landed\n', 0o640), /settlement publication failed/)
  const record = readLayers(secondRoot).layers[0]
  assert.ok(record)
  assert.equal(readFileSync(target, 'utf8'), 'landed\n')
  assert.equal(restoreChange(first(record), record.rollbackDir, false).outcome, 'restored')
})

test('rc: shell selection, absent insertion, no duplicates and complete line hunk matching', () => {
  assert.equal(rcPath('/synthetic', '/bin/zsh'), '/synthetic/.zshrc')
  assert.equal(rcPath('/synthetic', '/bin/bash'), '/synthetic/.bash_profile')
  assert.equal(rcPath('/synthetic', undefined), null)
  const inserted = withRcBlock('prefix')
  assert.equal(inserted.changed, true)
  assert.equal(withRcBlock(inserted.text).changed, false)
  assert.equal(revertHunk('not-b\nX\nY\n', 'a\nb\n', 'a\nb\nX\nY\n'), null)
})

test('journal: a missing job-only recovery directory blocks journal clearing', async () => {
  const home = await tempDir('anyengine-layer-boundary-')
  const root = join(home, '.anyengine')
  const writer = new LayerWriter(root, null, 'router', STAMP)
  writer.addJob('dev.anyengine.router')
  const path = enginePaths(root).layers
  const journal = readFileSync(path)
  rmSync(writer.layer.rollbackDir, { recursive: true })
  assert.throws(() => readLayers(root), /recover|directory|layer/)
  assert.throws(() => writeLayers(root, { version: 1, layers: [] }), /recover|directory|layer/)
  assert.deepEqual(readFileSync(path), journal)
})

for (const initial of ['symlink', 'absent'] as const) {
  test(`restore: missing link-only recovery directory refuses ${initial} baseline and retains journal/jobs`, async () => {
    const home = await tempDir('anyengine-layer-boundary-')
    const root = join(home, 'engine root')
    const target = join(home, 'current')
    if (initial === 'symlink') symlinkSync('old-lib', target)
    const writer = new LayerWriter(root, null, 'router', STAMP)
    writer.writeSymlink(target, 'new-lib')
    writer.addJob('dev.anyengine.router')
    const layer = layerOf(readLayers(root))
    const journal = readFileSync(enginePaths(root).layers)
    const targetInode = lstatSync(target).ino
    rmSync(layer.rollbackDir, { recursive: true })
    assert.throws(() => readLayers(root), /directory/)
    assert.throws(() => writeLayers(root, { version: 1, layers: [] }), /directory/)
    assert.throws(() => restoreChange(first(layer), layer.rollbackDir, false), /directory/)
    assert.equal(readlinkSync(target), 'new-lib')
    assert.equal(lstatSync(target).ino, targetInode)
    assert.deepEqual(readFileSync(enginePaths(root).layers), journal)
  })
}

function markerSnapshot(path: string) {
  const stat = lstatSync(path)
  const contents = stat.isSymbolicLink()
    ? readlinkSync(path)
    : stat.isDirectory()
      ? readdirSync(path)
      : readFileSync(path)
  return { inode: stat.ino, mode: stat.mode, contents }
}
for (const kind of ['nonempty', 'dangling', 'symlink', 'directory'] as const) {
  for (const operation of ['overwrite', 'clear'] as const) {
    test(`journal: invalid ${kind} POPPED refuses ${operation} and retains exact journal/pins/marker`, async () => {
      const home = await tempDir('anyengine-layer-boundary-')
      const root = join(home, 'engine root')
      const writer = new LayerWriter(root, null, 'router', STAMP)
      writer.addJob('dev.anyengine.router')
      const file = readLayers(root)
      file.recovery = {
        entry: recoveryPaths(root).entry,
        controlLib: join(root, 'lib/pinned'),
        pinnedLibs: [join(root, 'lib/pinned')],
      }
      writeLayers(root, file)
      const path = enginePaths(root).layers
      const journal = readFileSync(path)
      const marker = join(writer.layer.rollbackDir, POPPED)
      if (kind === 'directory') mkdirSync(marker)
      else if (kind === 'dangling') symlinkSync('missing-marker-target', marker)
      else if (kind === 'symlink') {
        const empty = join(home, 'empty-file')
        writeFileSync(empty, '')
        symlinkSync(empty, marker)
      } else writeFileSync(marker, 'unfinished marker')
      const originalMarker = markerSnapshot(marker)
      assert.throws(() => readLayers(root), /invalid layer POPPED/)
      const replacement = structuredClone(file)
      layerOf(replacement).jobs.push('dev.anyengine.smoke')
      assert.throws(
        () => writeLayers(root, operation === 'clear' ? { version: 1, layers: [] } : replacement),
        /invalid layer POPPED/,
      )
      assert.deepEqual(readFileSync(path), journal)
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).recovery, file.recovery)
      assert.deepEqual(markerSnapshot(marker), originalMarker)
    })
  }
}

test('journal: valid empty POPPED stays supported for logical reads and explicit journal writes', async () => {
  const home = await tempDir('anyengine-layer-boundary-')
  const root = join(home, 'engine root')
  const writer = new LayerWriter(root, null, 'router', STAMP)
  writer.addJob('dev.anyengine.router')
  const file = readLayers(root)
  file.recovery = {
    entry: recoveryPaths(root).entry,
    controlLib: join(root, 'lib/pinned'),
    pinnedLibs: [join(root, 'lib/pinned')],
  }
  writeLayers(root, file)
  const path = enginePaths(root).layers
  const journal = readFileSync(path)
  const marker = join(writer.layer.rollbackDir, POPPED)
  writeFileSync(marker, '')
  const filtered = readLayers(root)
  assert.deepEqual(filtered.layers, [])
  assert.deepEqual(filtered.recovery, file.recovery)
  assert.deepEqual(readFileSync(path), journal, 'logical filtering leaves the journal untouched')
  writeLayers(root, filtered)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), filtered)
  writeLayers(root, { version: 1, layers: [] })
  assert.equal(existsSync(path), false)
  assert.equal(readFileSync(marker).length, 0)
})
