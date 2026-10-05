import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { readlinkSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { AccountLedger } from '../src/accounts-ledger.mjs'
import { rotateAccount } from '../src/accounts-rotation.mjs'
import { m3RecoveryJxa } from '../src/control-m3-recovery-jxa.mjs'
import { accountFixture } from './helpers/accounts-fixture.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(() => killChildren())
after(removeTempDirs)

for (const from of ['home', 'b'])
  for (const point of ['renamed-0', 'renamed-1', 'published', 'cleanup-unlinked']) {
    test(`Node-free Home recovery after killed ${from} switch at ${point}`, async () => {
      const p = await accountFixture()
      const parked = (id: string) => join(p.root, 'accounts/openai', id, 'auth.json')
      const inodes = {
        home: statSync(join(p.canonical, 'auth.json')).ino,
        b: statSync(parked('b')).ino,
        c: statSync(parked('c')).ino,
      }
      if (from === 'b') {
        const ledger = new AccountLedger(p)
        try {
          await rotateAccount(ledger, 'b', 'manual')
        } finally {
          ledger.close()
        }
      }
      const child = spawn(
        process.execPath,
        [
          resolve('test/fixtures/accounts-switch-worker.mjs'),
          p.root,
          p.canonical,
          point,
          from === 'home' ? 'b' : 'c',
        ],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      )
      const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10000) })
      assert.equal(message.checkpoint, point)
      const closed = once(child, 'close')
      child.kill('SIGKILL')
      await closed
      const script = join(p.root, 'recover-account.js')
      writeFileSync(
        script,
        `${m3RecoveryJxa}\nfunction run(args) { recoverAccountHome(args[0],args[1],args[2],args[3],false) }\n`,
        { mode: 0o600 },
      )
      const result = spawnSync(
        '/usr/bin/osascript',
        [
          '-l',
          'JavaScript',
          script,
          p.root,
          p.canonical,
          String(process.getuid?.()),
          String(process.pid),
        ],
        {
          encoding: 'utf8',
          timeout: 30000,
          env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' },
        },
      )
      assert.equal(result.status, 0, result.stderr)
      const after = new AccountLedger(p)
      try {
        assert.equal(after.registry().active, 'home')
        assert.equal(after.registry().rotation.enabled, false)
        assert.equal(after.state().phase, 'open')
      } finally {
        after.close()
      }
      assert.equal(statSync(join(p.canonical, 'auth.json')).ino, inodes.home)
      assert.equal(statSync(parked('b')).ino, inodes.b)
      assert.equal(statSync(parked('c')).ino, inodes.c)
      assert.equal(readlinkSync(join(p.overlay, 'auth.json')), join(p.canonical, 'auth.json'))
    })
  }
