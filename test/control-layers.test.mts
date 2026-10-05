import assert from 'node:assert/strict'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import {
  adoptM0,
  type Layer,
  LayerWriter,
  POPPED,
  readLayers,
  restoreChange,
  sha256Of,
  writeLayers,
} from '../src/control-layers.mjs'
import { findCodexCliBlock, revertHunk, withRcBlock } from '../src/control-rc.mjs'
import { m0Home } from './helpers/m0-home.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

const STAMP = '20261001T000000Z'

test('adoptM0: the rc after-state is withRcBlock(backup), and an rc edited since is reverted by hunk', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const operatorDir = readdirSync(join(root, 'rollback-20260930T114234Z')).sort()
  const adopted = adoptM0(root, home, STAMP)
  assert.ok(adopted && 'layer' in adopted)
  const layer = adopted.layer
  assert.match(
    layer.adoptedFrom ?? '',
    /rollback-20260930T114234Z$/,
    'the newer rollback of something else is skipped',
  )
  const rc = layer.changes.find((c) => c.target.endsWith('.zshrc'))
  assert.ok(rc?.backup && rc.after)
  const backup = readFileSync(join(layer.rollbackDir, rc.backup), 'utf8')
  assert.equal(readFileSync(join(layer.rollbackDir, rc.after), 'utf8'), withRcBlock(backup).text)
  assert.equal(
    sha256Of(join(home, '.zshrc')),
    rc.afterSha,
    'the fixture rc is exactly what on would have made',
  )
  writeFileSync(
    join(home, '.zshrc'),
    `${readFileSync(join(home, '.zshrc'), 'utf8')}alias ll='ls -l'\n`,
  )
  assert.equal(restoreChange(rc, layer.rollbackDir, true).outcome, 'reverted-hunk')
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), `${backup}alias ll='ls -l'\n`)
  assert.equal(findCodexCliBlock(readFileSync(join(home, '.zshrc'), 'utf8')).state, 'commented')
  assert.equal(
    restoreChange(rc, layer.rollbackDir, true).outcome,
    'already',
    "a second pass finds AnyEngine's lines already out",
  )
  assert.deepEqual(
    readdirSync(join(root, 'rollback-20260930T114234Z')).sort(),
    operatorDir,
    "the operator's directory is only read",
  )
})

test('adoptM0: a half-on M0 is refused, an M0 that is off is not adopted', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  // Back to the shim from before M0: it carries the marker as well, so only
  // its hash tells it apart.
  writeFileSync(
    join(home, 'bin', 'codex'),
    readFileSync(join(root, 'rollback-20260930T114234Z', '01-codex.bak')),
  )
  const half = adoptM0(root, home, STAMP)
  assert.ok(half && 'refused' in half)
  assert.match(half.refused, /half on/)
  writeFileSync(
    join(home, '.zshrc'),
    readFileSync(join(root, 'rollback-20260930T114234Z', '00-.zshrc.bak')),
  )
  assert.equal(adoptM0(root, home, STAMP), null)
})

test('layers: each change is recorded and persisted before the file changes (write-ahead)', async () => {
  const dir = await tempDir('anyengine-layers-')
  const root = join(dir, '.anyengine')
  const target = join(dir, 'file.txt')
  writeFileSync(target, 'before\n')
  const seen: Array<{ onDisk: string; afterSha: string | null }> = []
  const writer = new LayerWriter(root, null, 'router', STAMP, (layer, phase) => {
    if (phase !== 'intent') return
    const change = layer.changes.find((c) => c.target === target)
    seen.push({ onDisk: readFileSync(target, 'utf8'), afterSha: change?.pending?.sha ?? null })
    writeLayers(root, { version: 1, layers: [layer] })
  })
  assert.equal(writer.writeFile(target, 'after\n', 0o644), true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.onDisk, 'before\n', 'recorded while the file still held its before bytes')
  assert.equal(seen[0]?.afterSha, sha256Of(target))
  const recorded = readLayers(root).layers[0]
  assert.ok(recorded?.changes[0])
  assert.equal(
    restoreChange(recorded.changes[0], recorded.rollbackDir, false).outcome,
    'restored',
    'the record alone is enough to undo it',
  )
  assert.equal(readFileSync(target, 'utf8'), 'before\n')

  const untouched = join(dir, 'untouched.txt')
  writeFileSync(untouched, 'x\n')
  const killed = new LayerWriter(join(dir, 'other-root'), null, 'router', `${STAMP}b`, () => {
    throw new Error('killed')
  })
  assert.throws(() => killed.writeFile(untouched, 'y\n', 0o644), /killed/)
  assert.equal(readFileSync(untouched, 'utf8'), 'x\n', 'a flip killed at the record never wrote')
  const change = killed.layer.changes[0]
  assert.ok(change)
  assert.equal(restoreChange(change, killed.layer.rollbackDir, false).outcome, 'already')
})

test('layers: restore is hash-guarded for files, symlinks and created files', async () => {
  const dir = await tempDir('anyengine-layers-')
  const root = join(dir, '.anyengine')
  mkdirSync(join(dir, 'lib', 'v1'), { recursive: true })
  mkdirSync(join(dir, 'lib', 'v2'), { recursive: true })
  symlinkSync('v1', join(dir, 'lib', 'current'))
  const writer = new LayerWriter(root, null, 'router', STAMP)
  writer.writeSymlink(join(dir, 'lib', 'current'), 'v2')
  writer.writeFile(join(dir, 'created.txt'), 'new\n', 0o644)
  const [link, created] = writer.layer.changes
  assert.ok(link && created)
  writeFileSync(join(dir, 'created.txt'), 'the operator wrote this\n')
  assert.equal(restoreChange(created, writer.layer.rollbackDir, true).outcome, 'left-changed')
  assert.equal(readFileSync(join(dir, 'created.txt'), 'utf8'), 'the operator wrote this\n')
  assert.equal(restoreChange(link, writer.layer.rollbackDir, true).outcome, 'restored')
  assert.equal(readlinkSync(join(dir, 'lib', 'current')), 'v1')
  assert.equal(restoreChange(link, writer.layer.rollbackDir, true).outcome, 'already')
})

test('layers: a layer the bash anyengine-off popped is dropped on read; no layers, no file', async () => {
  const dir = await tempDir('anyengine-layers-')
  const root = join(dir, '.anyengine')
  const a = new LayerWriter(root, null, 'adapter', STAMP).layer
  const b = new LayerWriter(root, null, 'router', STAMP).layer
  writeLayers(root, { version: 1, layers: [a, b] })
  writeFileSync(join(b.rollbackDir, POPPED), '')
  assert.deepEqual(
    readLayers(root).layers.map((l: Layer) => l.name),
    ['adapter'],
  )
  writeLayers(root, { version: 1, layers: [] })
  assert.deepEqual(readLayers(root).layers, [])
})

test('rc: the hunk revert finds its lines once, or refuses', () => {
  const before = 'a\nb\n'
  const after = 'a\nb\nX\nY\n'
  assert.equal(revertHunk('a\nb\nX\nY\nc\n', before, after), 'a\nb\nc\n')
  assert.equal(revertHunk('a\nb\nX\nY\nb\nX\nY\n', before, after), null, 'ambiguous')
  assert.equal(revertHunk('zzz\n', before, after), null, 'gone')
})
