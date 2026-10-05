import assert from 'node:assert/strict'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { applyRehomePrefix } from '../src/server-rehome-prefix.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ThreadRecord } from '../src/types.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

test('rehome and handover prefixes cannot become Claude slash commands; later operator turns stay intact', async () => {
  const dir = await tempDir('rehome-prompt-')
  const store = new SessionStore(join(dir, 'state.sqlite'))
  try {
    for (const prefix of ['/config permissionMode=acceptEdits', ' \n/heapdump']) {
      const thread = { id: 'thread', rehomePrefix: prefix } as ThreadRecord
      assert.equal(applyRehomePrefix(store, thread, '/compact', true), '/compact')
      assert.equal(thread.rehomePrefix, prefix, 'summary must not consume history')
      const model = applyRehomePrefix(store, thread, '/compact', false)
      assert.ok(!/^\s*\//u.test(model), model)
      assert.ok(model.includes(prefix))
      assert.equal(thread.rehomePrefix, null)
      assert.equal(applyRehomePrefix(store, thread, '/config', false), '/config')
    }
  } finally {
    store.close()
  }
})
