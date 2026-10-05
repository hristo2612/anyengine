import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { adoptM0, restoreChange } from '../src/control-layers.mjs'
import { m0Home } from './helpers/m0-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
const RECEIPT = 'rollback-20260930T114234Z'
const STAMP = '20350101T010203Z'

test('adoption: equivalent receipts have one recovery baseline, conflicting complete receipts refuse', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const later = join(root, 'rollback-20300101T000000Z')
  cpSync(join(root, RECEIPT), later, { recursive: true })
  const equivalent = adoptM0(root, home, STAMP)
  assert.ok(equivalent && 'layer' in equivalent)
  writeFileSync(join(later, '02-runtime.env.bak'), 'different before\n')
  const conflict = adoptM0(root, home, `${STAMP}b`)
  assert.ok(
    conflict && 'refused' in conflict,
    'conflicting baselines cannot be chosen by timestamp',
  )
  assert.match(conflict.refused, /ambiguous|conflict/i)
})

test('adoption: discovers renamed receipts, numeric modes and dynamic library names; skips incomplete older backup', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const receipt = join(root, 'rollback-20340203T040506Z')
  renameSync(join(root, RECEIPT), receipt)
  const manifest = JSON.parse(readFileSync(join(receipt, 'manifest.json'), 'utf8'))
  for (const entry of manifest.entries) entry.mode = Number.parseInt(entry.mode, 8)
  writeFileSync(join(receipt, 'manifest.json'), JSON.stringify(manifest))
  const older = join(root, 'rollback-20280101T000000Z')
  cpSync(receipt, older, { recursive: true })
  rmSync(join(older, '01-codex.bak'))
  renameSync(join(root, 'lib/0.1.0-986ab707750e'), join(root, 'lib/synthetic-variant'))
  unlinkSync(join(root, 'lib/current'))
  symlinkSync('synthetic-variant', join(root, 'lib/current'))
  const result = adoptM0(root, home, STAMP)
  assert.ok(result && 'layer' in result)
  assert.equal(result.layer.adoptedFrom, receipt)
  assert.equal(result.layer.changes.find((change) => change.target.endsWith('/codex'))?.mode, 0o755)
})

for (const form of [
  'utf8',
  'malformed',
  'dangling',
  'traversal',
  'backup-link',
  'bad-mode',
] as const) {
  test(`adoption: ${form} evidence refuses without creating a recovery layer`, async () => {
    const home = await m0Home()
    const root = join(home, '.anyengine')
    const receipt = join(root, RECEIPT)
    const path = join(receipt, 'manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    if (form === 'utf8') {
      renameSync(join(receipt, manifest.entries[0].backup), join(receipt, '�-backup'))
      manifest.entries[0].backup = '�-backup'
      const good = Buffer.from(JSON.stringify(manifest))
      const offset = good.indexOf(Buffer.from('�'))
      writeFileSync(
        path,
        Buffer.concat([good.subarray(0, offset), Buffer.from([0xff]), good.subarray(offset + 3)]),
      )
    } else if (form === 'malformed') writeFileSync(path, '{')
    else if (form === 'dangling') {
      rmSync(path)
      symlinkSync('missing', path)
    } else if (form === 'backup-link') {
      rmSync(join(receipt, '01-codex.bak'))
      symlinkSync(join(home, 'bin/codex'), join(receipt, '01-codex.bak'))
    } else {
      manifest.entries[0][form === 'traversal' ? 'backup' : 'mode'] =
        form === 'traversal' ? '../outside' : '0644garbage'
      writeFileSync(path, JSON.stringify(manifest))
    }
    const original = form === 'dangling' ? null : readFileSync(path)
    const result = adoptM0(root, home, STAMP)
    assert.ok(result && 'refused' in result)
    assert.match(result.refused, /invalid|unsupported|evidence|manifest|backup|mode/i)
    if (original) assert.deepEqual(readFileSync(path), original)
    assert.equal(existsSync(join(root, 'recovery')), false)
  })
}

for (const form of ['duplicate', 'mixed', 'foreign'] as const) {
  test(`adoption: ${form} guarded rc does not certify active M0`, async () => {
    const home = await m0Home()
    const path = join(home, '.zshrc')
    const rc = readFileSync(path, 'utf8')
    writeFileSync(
      path,
      form === 'duplicate'
        ? `${rc}${rc}`
        : form === 'mixed'
          ? rc.replace('  export CODEX_CLI_PATH', '#   export CODEX_CLI_PATH')
          : rc.replace('$HOME/bin/codex', '$HOME/bin/unrelated'),
    )
    const result = adoptM0(join(home, '.anyengine'), home, STAMP)
    assert.ok(result && 'refused' in result)
  })
}

test('adoption: an rc changed outside the owned hunk keeps unrelated edits on rollback', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const path = join(home, '.zshrc')
  writeFileSync(path, `${readFileSync(path, 'utf8')}alias operator='true'\n`)
  const prior = readdirSync(join(root, RECEIPT)).sort()
  const result = adoptM0(root, home, STAMP)
  assert.ok(result && 'layer' in result)
  const change = result.layer.changes.find((row) => row.target === path)
  assert.ok(change)
  assert.equal(restoreChange(change, result.layer.rollbackDir, true).outcome, 'reverted-hunk')
  assert.equal(
    readFileSync(path, 'utf8'),
    `${readFileSync(join(root, RECEIPT, '00-.zshrc.bak'), 'utf8')}alias operator='true'\n`,
  )
  assert.deepEqual(readdirSync(join(root, RECEIPT)).sort(), prior)
})
