// Claude 2.1.287 removes shortcut hints after paste and uses different mode
// footers. The input belongs to the framed composer, never to a footer string.
const RULE = /^[─━]{8,}\s*$/u
const CURSOR = /^\s*❯\s*/u
const MODAL_MARKER =
  /(?:Enter|Return) to (?:confirm|continue|select|enable|accept)|Esc(?:ape)? to cancel/i

// What the terminal shows (`lines`), and the same rows with faint (SGR 2)
// cells blanked (`typed`). Inside an empty composer Claude draws faint
// placeholders: an example prompt (`Try "refactor <filepath>"`, on accounts
// with prompt suggestions), a queued-message hint, a suggested next prompt.
// Typed or pasted input is never faint. A plain row list has no faint cells.
export interface ScreenRows {
  lines: readonly string[]
  typed: readonly string[]
}

export type ScreenView = readonly string[] | ScreenRows

function rowsOf(view: ScreenView): ScreenRows {
  return 'typed' in view ? view : { lines: view, typed: view }
}

interface ComposerFrame {
  start: number
  end: number
  text: string
}

function composerFrame({ lines, typed }: ScreenRows): ComposerFrame | null {
  const rules = lines.flatMap((line, row) => (RULE.test(line) ? [row] : []))
  // A continuation line is indented; only column-zero horizontal rules frame
  // the real input. Quoted borders and option lists inside a paste stay text.
  for (let i = rules.length - 1; i > 0; i -= 1) {
    const start = rules[i - 1]!
    const end = rules[i]!
    const content: number[] = []
    for (let row = start + 1; row < end; row += 1) if (lines[row]!.trim()) content.push(row)
    if (!content.length || !CURSOR.test(lines[content[0]!]!)) continue
    // The frame is found on what is shown; its input is what is not faint.
    const text = content.map((row) => typed[row] ?? '')
    text[0] = text[0]!.replace(CURSOR, '')
    return { start, end, text: text.join('\n') }
  }
  return null
}

// Dialogs may replace the composer or appear below its stale frame. Text
// inside the composer and old transcript above it cannot grant consent.
export function dialogRows(viewport: readonly string[]): readonly string[] {
  const frame = composerFrame(rowsOf(viewport))
  return frame ? viewport.slice(frame.end + 1) : viewport
}

export function claudeDialog(view: ScreenView): string | null {
  const lines = dialogRows(rowsOf(view).lines)
    .map((line) => line.trim())
    .filter(Boolean)
  const selected = lines.findIndex((line) => /^❯\s*\S/u.test(line))
  const marker = lines.findIndex((line) => MODAL_MARKER.test(line))
  const numbered = lines.findIndex((line) => /^(?:❯\s*)?\d+[.)]\s+\S/u.test(line))
  if (selected < 0 && marker < 0 && numbered < 0) return null
  const heading = lines.find((line) =>
    /New MCP server|Make auto mode|Choose the text style|Quick safety check/i.test(line),
  )
  if (heading) return heading.slice(0, 180)
  const before = lines.slice(0, Math.max(selected, marker, numbered))
  return (
    before
      .find((line) => !RULE.test(line) && !/mode on|for shortcuts|^[▐▝]/u.test(line))
      ?.slice(0, 180) ?? 'unrecognized selection or confirmation'
  )
}

export function composerReady(view: ScreenView, expectedPrompt?: string): boolean {
  const rows = rowsOf(view)
  const frame = composerFrame(rows)
  if (!frame || claudeDialog(rows)) return false
  const rendered = frame.text.trim()
  if (!rendered) return true
  if (expectedPrompt === undefined) return false
  // Physical wrapping and indentation change whitespace. Claude may collapse
  // multiline paste into a single marker with no mode/footer line at all.
  return (
    rendered.replace(/\s+/g, '') === expectedPrompt.replace(/\s+/g, '') ||
    /^\[Pasted text #\d+(?: \+\d+ lines)?\]$/.test(rendered)
  )
}
