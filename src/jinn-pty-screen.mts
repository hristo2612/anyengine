import { createRequire } from 'node:module'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'

// @xterm/headless publishes CommonJS at its Node `main`; a named ESM import
// would fail at runtime, so resolve the constructor through require.
const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless') as {
  Terminal: new (options: Record<string, unknown>) => HeadlessTerminal
}

const SCREEN_SCROLLBACK_LINES = 500

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

  dispose(): void {
    this.terminal.dispose()
  }
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

const STARTUP_AFFIRMATIVES = [
  /^Yes, I trust this folder\b/i,
  /^Yes, I accept\b/i,
  /^Yes, proceed\b/i,
]

export interface StartupPromptAnswer {
  label: string
  keystrokes: string[]
}

export function parseStartupPrompt(viewport: readonly string[]): StartupPromptAnswer | null {
  for (let row = 0; row < viewport.length; row += 1) {
    const text = (viewport[row] ?? '').replace(/^\s*❯?\s*/, '')
    if (!STARTUP_AFFIRMATIVES.some((pattern) => pattern.test(text))) continue
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

// The composer is ready when the empty prompt line is visible and no dialog
// owns the screen. Claude Code's shortcut hint doubles as a version-stable
// readiness marker.
export function composerReady(viewport: readonly string[]): boolean {
  return (
    viewport.some((line) => /^\s*❯\s*$/.test(line)) ||
    viewport.some((line) => /\? for shortcuts/.test(line))
  )
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

const SUBMIT_CONFIRM_INTERVAL_MS = 1500
const SUBMIT_CONFIRM_ATTEMPTS = 12

// Returns a cancel function the caller MUST invoke when the turn settles;
// otherwise the retry loop would keep writing CRs into a PTY that now belongs
// to a different turn.
export function pasteAndSubmit(
  proc: { write(data: string): void },
  text: string,
  confirm?: SubmitConfirmation,
): () => void {
  proc.write(`\x1b[200~${neutralizeForPaste(text)}\x1b[201~`)
  let retryTimer: NodeJS.Timeout | undefined
  const submitTimer = setTimeout(() => {
    proc.write('\r')
    if (!confirm) return
    const maxAttempts = confirm.attempts ?? SUBMIT_CONFIRM_ATTEMPTS
    let attempt = 0
    retryTimer = setInterval(() => {
      if (confirm.submitted()) {
        if (retryTimer) clearInterval(retryTimer)
        retryTimer = undefined
        return
      }
      if (confirm.busy?.()) return
      if (attempt >= maxAttempts) {
        if (retryTimer) clearInterval(retryTimer)
        retryTimer = undefined
        confirm.onUnconfirmed?.(attempt)
        return
      }
      attempt += 1
      confirm.onRetry?.(attempt)
      proc.write('\r')
    }, confirm.intervalMs ?? SUBMIT_CONFIRM_INTERVAL_MS)
    retryTimer.unref?.()
  }, 150)
  return () => {
    clearTimeout(submitTimer)
    if (retryTimer) clearInterval(retryTimer)
    retryTimer = undefined
  }
}
