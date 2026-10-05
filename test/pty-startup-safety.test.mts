import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { composerReady, parseStartupPrompt } from '../src/anyengine-screen.mjs'

const offer = readFileSync('test/fixtures/claude-auto-mode-2.1.287.txt', 'utf8').split('\n')
const rule = '─'.repeat(70)
const plain = (lines: string[]) => ({ lines, typed: lines })
const frame = (rows = ['❯'], footer = '⏸ manual mode on · ? for shortcuts') => [
  rule,
  ...rows,
  rule,
  footer,
]

test('real 2.1.287 late auto-mode offer is declined and is never composer readiness', () => {
  assert.deepEqual(parseStartupPrompt(offer), {
    label: 'No, keep manual mode',
    keystrokes: ['\x1b[B', '\r'],
  })
  assert.equal(composerReady(offer), false)
})

test('unknown dialogs cannot reuse a stale composer or shortcuts hint', () => {
  assert.equal(composerReady([...frame(), 'New feature?', '❯ Enable', '  Cancel']), false)
  assert.equal(composerReady([...frame(), 'Press Enter to enable new feature']), false)
  assert.equal(composerReady(['New feature?', '❯ Enable', '  Cancel']), false)
  assert.equal(
    composerReady(frame(['❯ normal pasted text'], '⏸ manual mode on'), 'normal pasted text'),
    true,
  )
  assert.equal(
    composerReady(
      frame(['❯ first line', '  second line'], '⏸ manual mode on'),
      'first line\nsecond line',
    ),
    true,
  )
  assert.equal(composerReady(frame()), true)
  assert.equal(
    composerReady(
      frame(['❯ quote', '? for shortcuts', 'more text'], '⏸ manual mode on'),
      'quote\n? for shortcuts\nmore text',
    ),
    true,
  )
  assert.equal(
    composerReady(
      frame(['❯ first line', '❯ second line'], '⏸ manual mode on'),
      'first line\n❯ second line',
    ),
    true,
  )
  assert.equal(
    composerReady(
      frame(['❯ https://example.', 'invalid/path'], '⏸ manual mode on'),
      'https://example.invalid/path',
    ),
    true,
  )
  assert.equal(composerReady(frame(['❯ Yes, enable new default'])), false)
  assert.equal(composerReady(frame(['❯ Yes, enable new default']), 'hello'), false)
  assert.equal(parseStartupPrompt(['Enable a new feature?', '❯ Yes, proceed', '  No']), null)
  assert.equal(parseStartupPrompt(['Unknown agreement', '❯ Yes, I accept', '  No']), null)
})

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after } from 'node:test'
import { AnyengineRuntime } from '../src/anyengine-runtime.mjs'
import { pasteAndSubmit } from '../src/anyengine-screen.mjs'
import { waitForComposer } from '../src/anyengine-startup.mjs'
import type { RuntimeTurnContext } from '../src/types.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

function context(): RuntimeTurnContext {
  return {
    threadId: 'startup-safety',
    turnId: 'turn',
    prompt: 'hello',
    cwd: process.cwd(),
    runtimeType: 'anyengine',
    model: null,
    effort: null,
    claudeSessionId: null,
    forkSession: false,
    mcpServers: null,
    allowedTools: null,
    addDirs: [],
    enableFileCheckpointing: false,
    outputFormat: null,
    approvalPolicy: null,
    sandboxMode: null,
    systemPromptAddendum: null,
    planMode: false,
    imageInputs: [],
  }
}

for (const modal of ['auto', 'unknown']) {
  test(`late ${modal} modal after paste never receives an affirmative Enter`, async () => {
    const dir = await tempDir('pty-startup-safety-')
    const selection = join(dir, 'selection')
    const runtime = new AnyengineRuntime({
      cli: resolve('test/fixtures/fake-claude.mjs'),
      cols: 120,
      rows: 30,
      turnTimeoutMs: 30_000,
      startupTimeoutMs: 10_000,
      asyncSubagentTimeoutMs: 0,
      streamProxy: false,
      hookTimeoutSec: 60,
      autoApproveSafetyPrompts: true,
      keepApiKey: false,
      stateDir: join(dir, 'state'),
      relayScript: resolve('scripts/anyengine-hook-relay.mjs'),
      nodeBinary: process.execPath,
      extraArgs: [
        '--fixture-env',
        JSON.stringify({
          FAKE_CLAUDE_LATE_OFFER: modal,
          FAKE_CLAUDE_SELECTION_FILE: selection,
          FAKE_CLAUDE_TRANSCRIPT_DIR: dir,
        }),
      ],
    })
    try {
      await assert.rejects(
        runtime.runTurn(context(), {
          onEvent: () => {},
          onPermissionRequest: async () => ({ decision: 'accept' }),
        }),
        /not safely ready|dialog interrupted|dialog is open/,
      )
      assert.equal(existsSync(selection), modal === 'auto')
      if (modal === 'auto') assert.equal(readFileSync(selection, 'utf8'), '1')
    } finally {
      await runtime.stop()
    }
  })
}

test('startup timeout fails closed even if hooks reported a session', async () => {
  const writes: string[] = []
  await assert.rejects(
    waitForComposer(
      { rows: async () => plain(['Session started', 'Unknown offer']) },
      { write: (text) => writes.push(text) },
      {
        timeoutMs: 1,
        stopped: () => false,
        refusal: () => null,
      },
    ),
    /not safely ready/,
  )
  assert.deepEqual(writes, [])
})

test('every retry Enter rechecks the current screen and stops at an unknown modal', async () => {
  const writes: string[] = []
  let viewport = frame()
  let fail!: (error: Error) => void
  const failed = new Promise<Error>((resolve) => {
    fail = resolve
  })
  const cancel = pasteAndSubmit(
    {
      write: (text) => {
        writes.push(text)
        if (text === '\r') viewport = [...frame(), 'Unknown dialog', '❯ Yes', ' No']
      },
    },
    'hello',
    { submitted: () => false, intervalMs: 1 },
    {
      beforeWrite: async () => {
        if (!composerReady(viewport)) throw new Error('dialog owns input')
      },
      onError: fail,
    },
  )
  const timer = setTimeout(() => fail(new Error('guard did not run')), 5000)
  try {
    assert.match((await failed).message, /dialog owns input/)
    assert.deepEqual(writes, ['\x1b[200~hello\x1b[201~', '\r'])
  } finally {
    clearTimeout(timer)
    cancel()
  }
})

test('steer rejects an unknown dialog before writing instead of reporting success', async () => {
  const writes: string[] = []
  const runtime = Object.create(AnyengineRuntime.prototype) as AnyengineRuntime
  const session = {
    exited: false,
    screen: {
      rows: async () => plain([...frame(), 'Unknown dialog', '❯ Enable', '? for shortcuts']),
    },
    proc: { write: (data: string) => writes.push(data) },
  }
  Reflect.set(runtime, 'sessions', new Map([['thread', session]]))
  Reflect.set(runtime, 'turns', new Map())
  Reflect.set(runtime, 'releaseSession', () => {})
  await assert.rejects(runtime.steer('thread', 'hello'), /dialog is open|not safely ready/)
  assert.deepEqual(writes, [])
})
