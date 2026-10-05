import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { AppModelPick } from '../src/config-writes.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const invalidBytes: Record<string, Buffer> = {
  malformed: Buffer.from('{bad'),
  'invalid-utf8': Buffer.from('{"model":"\xff"}', 'latin1'),
  array: Buffer.from('[]'),
  'invalid-model': Buffer.from('{"model":42}'),
  unreadable: Buffer.from('{"model":"opus"}'),
}
for (const kind of [...Object.keys(invalidBytes), 'dangling', 'directory'])
  test(`ordinary picker refuses present invalid state before writes/reset: ${kind}`, async () => {
    const work = await tempDir('app-pick-state-')
    const path = join(work, 'app-model-pick.json')
    if (kind === 'dangling') symlinkSync(join(work, 'absent-target'), path)
    else if (kind === 'directory') mkdirSync(path)
    else {
      writeFileSync(path, invalidBytes[kind] ?? Buffer.alloc(0), { mode: 0o600 })
      if (kind === 'unreadable') chmodSync(path, 0)
    }
    const before = lstatSync(path),
      names = readdirSync(work)
    try {
      const pick = new AppModelPick(path)
      for (const value of ['sonnet', null])
        assert.throws(
          () => pick.apply({ model: value }),
          /invalid|unsupported|UTF|encoded|EACCES|permission/i,
        )
      assert.equal(lstatSync(path).ino, before.ino)
      assert.deepEqual(readdirSync(work), names)
      if (kind === 'dangling') assert.equal(readlinkSync(path), join(work, 'absent-target'))
    } finally {
      if (kind === 'unreadable') chmodSync(path, 0o600)
    }
    if (before.isFile()) assert.deepEqual(readFileSync(path), invalidBytes[kind])
  })
test('ordinary picker accepts absence and encoded replacement data while ignoring unrelated keys', async () => {
  const work = await tempDir('app-pick-valid-')
  const path = join(work, 'app-model-pick.json')
  const pick = new AppModelPick(path)
  assert.deepEqual(pick.read(), {})
  pick.apply({ model: 'opus' })
  assert.equal(existsSync(path), true)
  writeFileSync(path, '{"model":"\ufffd","review_model":"opus","other":{"future":true}}')
  pick.apply({ review_model: 'sonnet' })
  assert.deepEqual(pick.read(), { model: '\ufffd', review_model: 'sonnet' })
  pick.apply({ model: null, review_model: null })
  assert.equal(existsSync(path), false)
})
