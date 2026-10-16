import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import type { SourceSelection } from '../src/broker-types.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

import { createBrokerOwner } from '../src/broker-owner.mjs'

const refuse = {
  status: async (): Promise<never> => {
    throw new Error('the owner itself never asks the official client')
  },
}

async function setup() {
  const root = realpathSync(await tempDir('bo-'))
  const homes = { a: join(root, 'a'), b: join(root, 'b') }
  mkdirSync(homes.a, { mode: 0o700 })
  mkdirSync(homes.b, { mode: 0o700 })
  let account = { home: homes.a, generation: 1 }
  const owner = createBrokerOwner({ account: () => account, official: refuse })
  const seen: SourceSelection[] = []
  owner.onChange((selection: SourceSelection) => seen.push(selection))
  return {
    root,
    homes,
    owner,
    seen,
    switch: (next: typeof account) => {
      account = next
    },
  }
}

test('one file source per account generation; no process is launched or borrowed', async () => {
  const s = await setup()
  try {
    assert.equal(s.owner.current().source, null)
    const picks = await Promise.all(Array.from({ length: 7 }, () => s.owner.source()))
    assert.equal(new Set(picks.map((pick) => pick.source.id)).size, 1)
    const [pick] = picks
    assert.ok(pick)
    assert.equal(pick.source.kind, 'file')
    assert.equal(pick.source.home, s.homes.a)
    assert.equal(pick.source.generation, 1)
    assert.equal(s.owner.current().source, pick.source)
    assert.equal(s.seen.length, 1)
    // The router no longer creates or reads adapter source sockets.
    assert.deepEqual(readdirSync(s.root).sort(), ['a', 'b'])
  } finally {
    await s.owner.close()
  }
})

test('an account switch retires the source; stopSources pauses until the account moves', async () => {
  const s = await setup()
  try {
    const a = (await s.owner.source()).source
    await s.owner.stopSources()
    assert.equal(s.owner.current().source, null)
    await assert.rejects(s.owner.source(), /broker\.no-source/)
    s.switch({ home: s.homes.b, generation: 2 })
    const b = await s.owner.source()
    assert.notEqual(b.source.id, a.id)
    assert.equal(b.source.home, s.homes.b)
    assert.equal(b.source.generation, 2)
    // A generation change alone (same home) also retires the source.
    s.switch({ home: s.homes.b, generation: 3 })
    assert.equal(s.owner.current().source, null)
    const c = await s.owner.source()
    assert.equal(c.source.generation, 3)
    assert.ok(c.revision > b.revision)
  } finally {
    await s.owner.close()
  }
})

test('a missing Codex home has no source, and close stops handing them out', async () => {
  const s = await setup()
  s.switch({ home: join(s.root, 'missing'), generation: 1 })
  assert.equal(s.owner.current().source, null)
  await assert.rejects(s.owner.source(), /broker\.no-source/)
  s.switch({ home: s.homes.a, generation: 1 })
  assert.ok((await s.owner.source()).source)
  await s.owner.close()
  assert.equal(s.owner.current().source, null)
  await assert.rejects(s.owner.source(), /broker\.no-source/)
})
