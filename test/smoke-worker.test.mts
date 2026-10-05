import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { DEFAULT_CONFIG, writeJsonAtomic } from '../src/anyengine-config.mjs'
import { observeOAuth } from '../src/smoke-claude.mjs'
import { joinDetachedGroup } from '../src/smoke-client.mjs'
import { killChildren, spawn } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(killChildren)
after(removeTempDirs)
// Controlled CLI schema/terminal fixture: never reads real auth or calls a vendor.
async function fixture(version = '2.1.288') {
  const root = await tempDir('smoke-worker-')
  const cli = join(root, 'controlled-claude')
  const calls = join(root, 'calls.jsonl')
  const auth = join(root, 'auth')
  const project = join(root, 'smoke/claude-project')
  mkdirSync(auth)
  mkdirSync(project, { recursive: true })
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, env: Object.keys(process.env), pid: process.pid}) + '\\n')
if (args.includes('--version')) console.log(${JSON.stringify(version + ' (Claude Code)')})
else if (args[0] === 'auth') console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', configDirectory: process.env.CLAUDE_CONFIG_DIR }))
else if (args.includes('--help')) console.log('--print --tools --restricted --disable-slash-commands --permission-prompts --effort --include-partial-messages')
else {
 process.stdin.resume()
 process.stdin.on('end', () => {
  for (const event of [{ type: 'system', subtype: 'init', session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, { type: 'assistant', message: { content: [{ type: 'text', text: 'PONG' }] } }, { type: 'result', subtype: 'success', is_error: false, result: 'PONG', session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }]) console.log(JSON.stringify(event))
 })
}
`,
  )
  chmodSync(cli, 0o700)
  const config = structuredClone(DEFAULT_CONFIG)
  config.claude.cli = cli
  writeJsonAtomic(join(root, 'config.json'), config)
  return {
    root,
    cli,
    calls,
    project,
    env: {
      ...process.env,
      HOME: root,
      CLAUDE_CONFIG_DIR: auth,
      ANTHROPIC_API_KEY: 'controlled-secret-must-be-stripped',
      CLAUDE_CODE_OAUTH_TOKEN: 'controlled-token-must-be-stripped',
    },
  }
}
for (const mode of ['success', 'negative', 'disconnect'] as const)
  test(`actual one-shot helper ${mode} waits for owner and closes its CLI lifetime`, async () => {
    const f = await fixture()
    const child = spawn(
      process.execPath,
      [resolve('dist/src/smoke-claude.mjs'), 'attempt', f.root, f.project],
      { env: f.env, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    )
    let errors = ''
    child.stderr!.on('data', (bytes) => {
      errors += String(bytes)
    })
    const closed = once(child, 'exit')
    const nextMessage = () =>
      new Promise<any[]>((done, fail) => {
        const finish = (value?: any[]) => {
          clearTimeout(wait)
          child.off('message', message)
          child.off('close', ended)
          value
            ? done(value)
            : fail(new Error(`helper exited or timed out before phase: ${errors}`))
        }
        const message = (value: any) => finish([value])
        const ended = () => finish()
        const wait = setTimeout(ended, 5000)
        child.once('message', message)
        child.once('close', ended)
      })
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {}
    }, 15_000)
    try {
      const [before] = await nextMessage()
      assert.deepEqual(before, { attempt: 'attempt', phase: 'before' })
      assert.equal(existsSync(f.calls), false, 'vendor work waits for before acknowledgment')
      if (mode === 'disconnect') child.disconnect()
      else {
        const after = mode === 'success' ? nextMessage() : null
        child.send({ attempt: 'attempt', phase: 'before', ok: mode === 'success' })
        if (after) {
          const [message] = await after
          assert.equal(message.phase, 'after')
          assert.equal(message.result.success, true, errors)
          assert.equal(message.result.model, 'haiku')
          assert.equal(child.exitCode, null)
          assert.doesNotThrow(() => process.kill(child.pid!, 0))
          child.send({ attempt: 'attempt', phase: 'after', ok: true })
        }
      }
      const [code] = await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          const wait = setTimeout(() => reject(new Error('owned helper exit not observed')), 10000)
          closed.finally(() => clearTimeout(wait)).catch(() => {})
        }),
      ])
      assert.equal(code, mode === 'success' ? 0 : 1, errors)
      await joinDetachedGroup(child.pid!)
      if (mode === 'success') {
        const rows = readFileSync(f.calls, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        assert.equal(rows.filter((r) => r.args[0] === 'auth').length, 2)
        assert.ok(
          rows.every(
            (r) =>
              !r.env.includes('ANTHROPIC_API_KEY') && !r.env.includes('CLAUDE_CODE_OAUTH_TOKEN'),
          ),
        )
        for (const row of rows) assert.throws(() => process.kill(row.pid, 0), { code: 'ESRCH' })
      } else assert.equal(existsSync(f.calls), false)
    } finally {
      clearTimeout(timer)
      await joinDetachedGroup(child.pid!, true)
    }
  })
test('OAuth version selection rejects older major/minor status schemas', async () => {
  for (const version of ['1.9.999', '2.0.999', '2.1.267']) {
    const f = await fixture(version)
    assert.throws(() => observeOAuth(f.cli, f.env), /supported official/)
  }
})
