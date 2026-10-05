import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AnyengineRuntime } from '../src/anyengine-runtime.mjs'
import type { PtyScreen } from '../src/anyengine-screen.mjs'
import type { RuntimeTurnContext } from '../src/types.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

const MODES = ['default', 'plan', 'acceptEdits', 'auto'] as const
const FOOTERS = {
  default: /⏸ manual mode on/,
  plan: /⏸ plan mode on/,
  acceptEdits: /⏵⏵ accept edits on/,
  auto: /⏵⏵ auto mode on/,
}
const ROWS = 30
const PLACEHOLDER = /^❯\s+Try "/

function context(turnId: string, mode: (typeof MODES)[number]): RuntimeTurnContext {
  return {
    threadId: 'tui-modes',
    turnId,
    prompt: 'Reply with exactly the word PONG',
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
    planMode: mode === 'plan',
    imageInputs: [],
  }
}

// Two turns on one warm PTY in one permission mode and layout, with prompt
// suggestions on: the empty composer always shows the faint placeholder.
async function twoTurns(tui: string, mode: (typeof MODES)[number]) {
  const dir = await tempDir('pty-tui-modes-')
  const runtime = new AnyengineRuntime({
    cli: resolve('test/fixtures/fake-claude.mjs'),
    cols: 120,
    rows: ROWS,
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
        FAKE_CLAUDE_TUI: tui,
        FAKE_CLAUDE_PROMPT_SUGGESTION: '1',
        ...(mode === 'plan' ? {} : { FAKE_CLAUDE_DEFAULT_MODE: mode }),
        FAKE_CLAUDE_TRANSCRIPT_DIR: dir,
      }),
    ],
  })
  try {
    const replies: string[] = []
    for (const turnId of ['turn-1', 'turn-2']) {
      let text = ''
      await runtime.runTurn(context(turnId, mode), {
        onEvent: (event) => {
          if (event.type === 'text_delta') text += event.delta
        },
        onPermissionRequest: async () => ({ decision: 'accept' }),
      })
      replies.push(text)
    }
    // The idle composer as the CLI redraws it after its Stop hook.
    const sessions = Reflect.get(runtime, 'sessions') as Map<string, { screen: PtyScreen }>
    const pty = sessions.get('tui-modes')?.screen
    assert.ok(pty, `${tui} ${mode}: warm PTY`)
    let screen = await pty.rows()
    for (const end = Date.now() + 30_000; Date.now() < end; await delay(50)) {
      screen = await pty.rows()
      if (screen.lines.some((line) => PLACEHOLDER.test(line))) break
    }
    return { replies, screen }
  } finally {
    await runtime.stop()
  }
}

for (const tui of ['default', 'fullscreen']) {
  test(`${tui} TUI: turns complete in every permission mode under the faint placeholder`, async () => {
    const runs = await Promise.all(MODES.map((mode) => twoTurns(tui, mode)))
    for (const [index, { replies, screen }] of runs.entries()) {
      const mode = MODES[index]!
      assert.deepEqual(replies, Array(2).fill('PONG:Reply with exactly the word PONG'), mode)
      const cursor = screen.lines.findLastIndex((line) => PLACEHOLDER.test(line))
      assert.ok(cursor > 0, `${mode}: placeholder shown\n${screen.lines.join('\n')}`)
      assert.equal(screen.typed[cursor], '❯', mode)
      assert.match(screen.lines[cursor + 2] ?? '', FOOTERS[mode], mode)
      // Fullscreen pins the composer to the bottom rows.
      if (tui === 'fullscreen') assert.equal(cursor, ROWS - 3, mode)
    }
  })
}
