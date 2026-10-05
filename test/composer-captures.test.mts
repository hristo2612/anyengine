import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  claudeDialog,
  composerReady,
  PtyScreen,
  parseStartupPrompt,
  type ScreenRows,
} from '../src/anyengine-screen.mjs'

const fixture = JSON.parse(readFileSync('test/fixtures/claude-composer-2.1.287.json', 'utf8')) as {
  screens: Record<string, string[]>
}
for (const mode of ['manual', 'plan', 'acceptEdits', 'auto']) {
  test(`real ${mode} composer works before and after the shortcut hint disappears`, () => {
    assert.equal(composerReady(fixture.screens[`${mode}-idle`]!), true)
    assert.equal(composerReady(fixture.screens[`${mode}-pasted`]!, 'hello there'), true)
    assert.equal(composerReady(fixture.screens[`${mode}-pasted`]!), false)
  })
}
test('real wrapped and collapsed pastes retain composer ownership', () => {
  assert.equal(composerReady(fixture.screens['wrapped-pasted']!, 'longword'.repeat(40)), true)
  assert.equal(
    composerReady(
      fixture.screens['collapsed-pasted']!,
      Array.from({ length: 30 }, (_, i) => `line ${i} of the safe zero-spend probe`).join('\n'),
    ),
    true,
  )
})
test('real trust, auto offer, onboarding and new MCP dialogs cannot own composer input', () => {
  for (const name of ['trust', 'offer', 'theme', 'mcp'])
    assert.equal(composerReady(fixture.screens[name]!), false, name)
})

test('real dialog errors identify the visible offer rather than a missing shortcut hint', () => {
  for (const [name, title] of [
    ['mcp', /New MCP server found/],
    ['trust', /Quick safety check/],
    ['theme', /Choose the text style/],
    ['offer', /Make auto mode/],
  ] as const) {
    assert.match(claudeDialog(fixture.screens[name]!) ?? '', title)
  }
})

test('real auto-default offers preserve manual, plan and accept-edits modes', () => {
  for (const [name, label] of [
    ['offer', 'No, keep manual mode'],
    ['offer-plan', 'No, keep plan mode'],
    ['offer-acceptEdits', 'No, keep accept edits'],
  ]) {
    assert.deepEqual(parseStartupPrompt(fixture.screens[name!]!), {
      label,
      keystrokes: ['\x1b[B', '\r'],
    })
    assert.equal(composerReady(fixture.screens[name!]!), false)
  }
})

test('modal markers below a stale real composer block input, while quoted consent stays text', () => {
  const idle = fixture.screens['manual-idle']!
  for (const name of ['mcp', 'theme', 'trust', 'offer']) {
    assert.equal(composerReady([...idle, ...fixture.screens[name]!]), false, name)
  }
  const prompt =
    'Quick safety check?\n❯ No, exit\nYes, I trust this folder\nEnter to confirm · Esc to cancel'
  const view = [
    '─'.repeat(120),
    '❯ Quick safety check?',
    '  ❯ No, exit',
    '  Yes, I trust this folder',
    '  Enter to confirm · Esc to cancel',
    '─'.repeat(120),
    '⏸ manual mode on',
  ]
  assert.equal(composerReady(view, prompt), true)
  assert.equal(parseStartupPrompt(view), null)
})

// Captured with prompt suggestions on, as the operator's account has them: an
// empty composer shows a faint `Try "..."` example. Read as plain text, that
// placeholder is input, and a real deploy failed every Claude turn on it.
const tui = JSON.parse(readFileSync('test/fixtures/claude-composer-tui-2.1.287.json', 'utf8')) as {
  variants: Record<string, { screens: Record<string, ScreenRows> }>
}
const stack = (a: ScreenRows, b: ScreenRows): ScreenRows => ({
  lines: [...a.lines, ...b.lines],
  typed: [...a.typed, ...b.typed],
})
for (const [variant, { screens }] of Object.entries(tui.variants)) {
  const screen = (name: string) => {
    const found = screens[name]
    assert.ok(found, `${variant} ${name}`)
    return found
  }
  for (const mode of ['manual', 'plan', 'acceptEdits', 'auto']) {
    test(`real ${variant} TUI, ${mode}: the faint placeholder is not input`, () => {
      const idle = screen(`${mode}-idle`)
      assert.match(idle.lines.join('\n'), /❯\s+Try "/)
      assert.equal(composerReady(idle), true)
      assert.equal(composerReady(idle.lines), false)
      const pasted = screen(`${mode}-pasted`)
      assert.equal(composerReady(pasted, 'hello there'), true)
      assert.equal(composerReady(pasted), false)
      assert.equal(composerReady(pasted, 'something else'), false)
    })
  }
  test(`real ${variant} TUI: wrapped and collapsed pastes keep the composer`, () => {
    assert.equal(composerReady(screen('wrapped-idle')), true)
    assert.equal(composerReady(screen('wrapped-pasted'), 'longword'.repeat(40)), true)
    assert.equal(composerReady(screen('wrapped-pasted')), false)
    assert.equal(composerReady(screen('collapsed-idle')), true)
    assert.equal(
      composerReady(
        screen('collapsed-pasted'),
        Array.from({ length: 30 }, (_, i) => `line ${i} of the safe zero-spend probe`).join('\n'),
      ),
      true,
    )
  })
  test(`real ${variant} TUI: trust and auto-mode offers own the screen`, () => {
    const trust = screen('trust')
    assert.equal(composerReady(trust), false)
    assert.match(claudeDialog(trust) ?? '', /Quick safety check/)
    assert.deepEqual(parseStartupPrompt(trust.lines), {
      label: 'Yes, I trust this folder',
      keystrokes: ['\x1b[B', '\r'],
    })
    for (const [name, label] of [
      ['offer', 'No, keep manual mode'],
      ['offer-plan', 'No, keep plan mode'],
      ['offer-acceptEdits', 'No, keep accept edits'],
    ] as const) {
      const offer = screen(name)
      assert.equal(composerReady(offer), false, name)
      assert.match(claudeDialog(offer) ?? '', /Make auto mode/, name)
      assert.deepEqual(parseStartupPrompt(offer.lines), { label, keystrokes: ['\x1b[B', '\r'] })
      // Below a stale composer whose placeholder reads empty, it still blocks.
      assert.equal(composerReady(stack(screen('manual-idle'), offer)), false, name)
    }
  })
}

test('only faint text is dropped from the composer, and never a dialog below it', () => {
  const rule = '─'.repeat(70)
  const shown = [rule, '❯ Try "refactor <filepath>"', rule, '  ⏸ manual mode on']
  const blank = [rule, '❯', rule, '  ⏸ manual mode on']
  assert.equal(composerReady({ lines: shown, typed: blank }), true)
  // The same words drawn normally are typed input.
  assert.equal(composerReady({ lines: shown, typed: shown }), false)
  const dialog = ['Enable a new feature?', '❯ Enable', '  Cancel']
  assert.equal(composerReady({ lines: [...shown, ...dialog], typed: [...blank, ...dialog] }), false)
  // Faint rows are blanked, but the dialog check reads what is shown.
  const faintDialog = ['', '', '']
  assert.equal(
    composerReady({ lines: [...shown, ...dialog], typed: [...blank, ...faintDialog] }),
    false,
  )
})

test('PtyScreen.rows blanks faint cells and the cursor drawn on a faint placeholder', async () => {
  const read = async (bytes: string) => {
    const screen = new PtyScreen(60, 4)
    screen.write(bytes)
    const rows = await screen.rows()
    screen.dispose()
    return { line: rows.lines[0], typed: rows.typed[0] }
  }
  // Both as 2.1.287 drew them: the cursor on the first letter, and blinked off.
  assert.deepEqual(await read('❯\xa0\x1b[7mT\x1b[27m\x1b[2mry "refactor <filepath>"\x1b[22m'), {
    line: '❯\xa0Try "refactor <filepath>"',
    typed: '❯',
  })
  assert.deepEqual(await read('❯\xa0\x1b[2mTry "refactor <filepath>"\x1b[22m'), {
    line: '❯\xa0Try "refactor <filepath>"',
    typed: '❯',
  })
  // Typed text keeps every letter, with the cursor after it or on one of it.
  assert.deepEqual(await read('❯ hello there\x1b[7m \x1b[27m'), {
    line: '❯ hello there ',
    typed: '❯ hello there',
  })
  assert.deepEqual(await read('❯ hello ther\x1b[7me\x1b[27m'), {
    line: '❯ hello there',
    typed: '❯ hello there',
  })
  assert.deepEqual(await read('❯ 日本\x1b[2m語\x1b[22m'), { line: '❯ 日本語', typed: '❯ 日本' })
})
