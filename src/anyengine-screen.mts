import { createRequire } from 'node:module'
import { dialogRows, type ScreenRows } from './anyengine-composer.mjs'

export { claudeDialog, composerReady, type ScreenRows } from './anyengine-composer.mjs'

import type { Terminal as HeadlessTerminal, IBufferCell, IBufferLine } from '@xterm/headless'

// @xterm/headless publishes CommonJS at its Node `main`; a named ESM import
// would fail at runtime, so resolve the constructor through require.
const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless') as {
  Terminal: new (options: Record<string, unknown>) => HeadlessTerminal
}

const SCREEN_SCROLLBACK_LINES = 500

// What the PTY's environment sets so that the screen reads the way this module
// parses it. The main screen keeps scrollback, and with it Claude draws the
// default layout even under `"tui": "fullscreen"`. Prompt suggestions, which
// a server-side flag turns on for some accounts, draw faint text into the
// empty composer and cost a model request after every turn the app never shows.
export const PTY_SCREEN_ENV = {
  TERM: 'xterm-256color',
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
} as const

// Headless terminal emulator fed with the raw PTY output so the runtime can
// read the TUI the way a human sees it (needed for dialogs no hook covers).
export class PtyScreen {
  private readonly terminal: HeadlessTerminal
  private pending: Promise<void> = Promise.resolve()

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: SCREEN_SCROLLBACK_LINES,
      convertEol: true,
      allowProposedApi: true,
    })
  }

  write(data: string): void {
    this.pending = this.pending.then(
      () => new Promise<void>((resolve) => this.terminal.write(data, resolve)),
    )
  }

  resize(cols: number, rows: number): void {
    this.pending = this.pending.then(() => {
      this.terminal.resize(cols, rows)
    })
  }

  // Visible rows as of every byte written before this call, so a dialog is
  // never read mid-escape-sequence.
  viewport(): Promise<string[]> {
    return this.pending.then(() => {
      const buffer = this.terminal.buffer.active
      const first = buffer.baseY
      return Array.from(
        { length: this.terminal.rows },
        (_, offset) => buffer.getLine(first + offset)?.translateToString(true) ?? '',
      )
    })
  }

  // The same rows, read once, with faint cells blanked in `typed` (see
  // ScreenRows): the composer's input is what is not faint.
  rows(): Promise<ScreenRows> {
    return this.pending.then(() => {
      const buffer = this.terminal.buffer.active
      const cells = [buffer.getNullCell(), buffer.getNullCell()] as const
      const lines: string[] = []
      const typed: string[] = []
      for (let offset = 0; offset < this.terminal.rows; offset += 1) {
        const line = buffer.getLine(buffer.baseY + offset)
        lines.push(line?.translateToString(true) ?? '')
        typed.push(line ? withoutFaint(line, cells) : '')
      }
      return { lines, typed }
    })
  }

  dispose(): void {
    this.terminal.dispose()
  }
}

// Claude draws its cursor as one inverse cell. On an empty composer it sits on
// the placeholder's first letter (`[inverse]T[faint]ry "…"`), so an inverse
// cell directly followed by a faint one belongs to the faint text.
function withoutFaint(
  line: IBufferLine,
  [cell, next]: readonly [IBufferCell, IBufferCell],
): string {
  let text = ''
  for (let x = 0; x < line.length; x += 1) {
    const current = line.getCell(x, cell)
    const width = current?.getWidth() ?? 0
    // A wide character's second cell has width 0 and no text of its own.
    if (!current || width === 0) continue
    const faint =
      current.isDim() !== 0 ||
      (current.isInverse() !== 0 && (line.getCell(x + width, next)?.isDim() ?? 0) !== 0)
    text += faint ? ' '.repeat(width) : current.getChars() || ' '
  }
  return text.trimEnd()
}

// ---------------------------------------------------------------------------
// Claude Code hardcoded safety prompts ("circuit breakers"). Even a PreToolUse
// hook answering permissionDecision:"allow" does not dismiss these, so the only
// route is answering the TUI. They render as:
//
//     Dangerous rm operation on possibly-empty variable path: "$W4/$d"
//
//     Do you want to proceed?
//     ❯ 1. Yes
//       2. No
//
// The parser is deliberately strict: it would rather return null and let the
// turn time out than fire keystrokes at a dialog it does not fully recognise.

export interface PermissionPromptOption {
  // Position in the option list, 0-based. Navigation is positional.
  position: number
  printed: number
  label: string
  selected: boolean
}

export interface ParsedPermissionPrompt {
  reason?: string
  options: PermissionPromptOption[]
  selectedPosition: number
}

const QUESTION = /^\s*Do you want to proceed\?\s*$/
const OPTION = /^\s*(❯)?\s*(\d+)\.\s+(\S.*?)\s*$/
const AFFIRMATIVE = /^yes\b/i
const NEGATIVE = /^(no|cancel|exit|abort|stop|don'?t|do not|reject|deny)\b/i

export function parsePermissionPrompt(viewport: readonly string[]): ParsedPermissionPrompt | null {
  const questionRow = viewport.findIndex((line) => QUESTION.test(line))
  if (questionRow === -1) return null

  const options: PermissionPromptOption[] = []
  for (let row = questionRow + 1; row < viewport.length; row += 1) {
    const line = viewport[row] ?? ''
    const match = OPTION.exec(line)
    if (!match) {
      if (line.trim() === '') {
        if (options.length > 0) break
        continue
      }
      break
    }
    options.push({
      position: options.length,
      printed: Number(match[2]),
      label: match[3] ?? '',
      selected: match[1] === '❯',
    })
  }

  if (options.length < 2) return null
  const selected = options.filter((option) => option.selected)
  const cursor = selected[0]
  if (selected.length !== 1 || !cursor) return null

  let reason: string | undefined
  for (let row = questionRow - 1; row >= 0; row -= 1) {
    const text = (viewport[row] ?? '').trim()
    if (text) {
      reason = text
      break
    }
  }
  const result: ParsedPermissionPrompt = { options, selectedPosition: cursor.position }
  if (reason) result.reason = reason
  return result
}

// Exactly one affirmative must be on offer; with several ("Yes" plus "Yes, and
// don't ask again") only a verbatim "Yes" is taken.
export function chooseApproval(prompt: ParsedPermissionPrompt): PermissionPromptOption | null {
  const affirmative = prompt.options.filter(
    (option) => AFFIRMATIVE.test(option.label) && !NEGATIVE.test(option.label),
  )
  if (affirmative.length === 1) return affirmative[0] ?? null
  if (affirmative.length === 0) return null
  const verbatim = affirmative.filter((option) => option.label.toLowerCase() === 'yes')
  return verbatim.length === 1 ? (verbatim[0] ?? null) : null
}

export function chooseRejection(prompt: ParsedPermissionPrompt): PermissionPromptOption | null {
  const negative = prompt.options.filter((option) => NEGATIVE.test(option.label))
  return negative[0] ?? null
}

// Arrow-then-Enter rather than typing the digit: digit handling differs between
// select widgets, and a stray trailing CR would land in whatever replaced the
// dialog. Arrows are unambiguous and a no-op if the cursor is already home.
export function keystrokesToSelect(from: number, to: number): string[] {
  const step = to > from ? '\x1b[B' : '\x1b[A'
  return [...Array(Math.abs(to - from)).fill(step), '\r']
}

// ---------------------------------------------------------------------------
// Startup dialogs that block the composer before any hook can fire. The
// workspace-trust dialog (claude 2.1.263) defaults its cursor to "No, exit":
//
//     Quick safety check: Is this a project you created or one you trust? ...
//     ❯ No, exit
//       Yes, I trust this folder
//     Enter to confirm · Esc to cancel
//
// The bypass-permissions consent ("Yes, I accept") has the same shape.

const STARTUP_AFFIRMATIVES = [/^Yes, I trust this folder\b/i, /^Yes, I accept\b/i]

export interface StartupPromptAnswer {
  label: string
  keystrokes: string[]
}

export function parseStartupPrompt(viewport: readonly string[]): StartupPromptAnswer | null {
  viewport = dialogRows(viewport)
  for (let row = 0; row < viewport.length; row += 1) {
    const text = (viewport[row] ?? '').replace(/^\s*❯?\s*/, '')
    const declineAuto =
      /^No, keep (?:manual mode|plan mode|accept edits)$/.test(text) &&
      viewport.some((line) =>
        /^Make auto mode your default permission mode\?\s*$/.test(line.trim()),
      )
    const knownConsent = viewport.some((line) =>
      /bypass(?:ing)? permissions|dangerously-skip-permissions/i.test(line),
    )
    const acceptKnown =
      STARTUP_AFFIRMATIVES.some((pattern) => pattern.test(text)) &&
      (!/^Yes, I accept/i.test(text) || knownConsent)
    if (!declineAuto && !acceptKnown) continue
    // Find the cursor among the option rows immediately around the affirmative.
    let cursorRow = -1
    for (
      let probe = Math.max(0, row - 3);
      probe <= Math.min(viewport.length - 1, row + 3);
      probe += 1
    ) {
      if (/^\s*❯\s*\S/.test(viewport[probe] ?? '')) {
        cursorRow = probe
        break
      }
    }
    if (cursorRow === -1) return null
    return { label: text.trim(), keystrokes: keystrokesToSelect(cursorRow, row) }
  }
  return null
}

// ---------------------------------------------------------------------------
// Prompt submission. Bracketed paste keeps multi-line prompts from being
// submitted line by line; the CR follows after a short beat. Bracketed paste does
// NOT neutralize a leading `/`, `@` or `!` (slash-command / mention / bash-mode
// handlers still fire), so a leading space is prepended for those.

export function neutralizeForPaste(text: string): string {
  return /^[/@!]/.test(text) ? ` ${text}` : text
}

export interface SubmitConfirmation {
  // True once the CLI acknowledged the prompt (UserPromptSubmit or any in-turn hook).
  submitted: () => boolean
  // True while the CLI is demonstrably busy — the prompt is queued, not lost.
  busy?: () => boolean
  onRetry?: (attempt: number) => void
  onUnconfirmed?: (attempts: number) => void
  intervalMs?: number
  attempts?: number
}

export interface PasteGuard {
  beforeWrite: (phase: 'paste' | 'submit') => Promise<void>
  onError: (error: Error) => void
  onSubmitted?: () => void
}

const SUBMIT_CONFIRM_INTERVAL_MS = 1500
const SUBMIT_CONFIRM_ATTEMPTS = 12

// Returns a cancel function the caller MUST invoke when the turn settles;
// otherwise the retry loop would keep writing CRs into a PTY that now belongs
// to a different turn.
export function pasteAndSubmit(
  proc: { write(data: string): void },
  text: string,
  confirm?: SubmitConfirmation,
  guard?: PasteGuard,
): () => void {
  let cancelled = false
  let writing = false
  let retryTimer: NodeJS.Timeout | undefined
  let submitTimer: NodeJS.Timeout | undefined
  const cancel = () => {
    cancelled = true
    clearTimeout(submitTimer)
    clearInterval(retryTimer)
  }
  const write = async (phase: 'paste' | 'submit') => {
    if (cancelled || writing) return
    writing = true
    try {
      await guard?.beforeWrite(phase)
      if (!cancelled)
        proc.write(phase === 'paste' ? `\x1b[200~${neutralizeForPaste(text)}\x1b[201~` : '\r')
    } catch (error) {
      cancel()
      guard?.onError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      writing = false
    }
  }
  void write('paste').then(() => {
    if (cancelled) return
    submitTimer = setTimeout(() => {
      void write('submit').then(() => {
        if (cancelled) return
        guard?.onSubmitted?.()
        if (!confirm) return
        const maxAttempts = confirm.attempts ?? SUBMIT_CONFIRM_ATTEMPTS
        let attempt = 0
        retryTimer = setInterval(() => {
          if (confirm.submitted()) return cancel()
          if (confirm.busy?.() || writing) return
          if (attempt >= maxAttempts) {
            cancel()
            confirm.onUnconfirmed?.(attempt)
            return
          }
          attempt += 1
          confirm.onRetry?.(attempt)
          void write('submit')
        }, confirm.intervalMs ?? SUBMIT_CONFIRM_INTERVAL_MS)
        retryTimer.unref?.()
      })
    }, 150)
  })
  return cancel
}
