// Text helpers for what the router reads from and writes to Codex, safe on
// hostile input: scans are linear (indexOf, never a backtracking regex), cuts
// never split a UTF-16 surrogate pair, and serialised JSON never carries a
// lone surrogate. JSON.stringify writes one as `\ud83d`, which Codex's
// serde_json rejects: it skips the event (response.completed included) and
// retries the stream, re-running the Claude turn.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

// Every lone surrogate replaced by U+FFFD (String.prototype.toWellFormed is
// not in the ES2023 lib).
export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, '�')
}

// A JSON.stringify replacer that makes every string value well formed.
export function wellFormedJson(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? wellFormed(value) : value
}

// The first `n` code units of `text`, one fewer when the cut would split a pair.
export function sliceStart(text: string, n: number): string {
  return text.slice(0, n > 0 && isHighSurrogate(text.charCodeAt(n - 1)) ? n - 1 : n)
}

// The last `n` code units of `text`, one fewer when the cut would split a pair.
export function sliceEnd(text: string, n: number): string {
  if (n <= 0) return ''
  const start = Math.max(0, text.length - n)
  return text.slice(start > 0 && isHighSurrogate(text.charCodeAt(start - 1)) ? start + 1 : start)
}

// What lies between the first `open` at or after `from` and the first `close`
// after it, as `/open([\s\S]*?)close/` would find it.
export function between(text: string, open: string, close: string, from = 0): string | undefined {
  const start = text.indexOf(open, from)
  if (start === -1) return undefined
  const end = text.indexOf(close, start + open.length)
  return end === -1 ? undefined : text.slice(start + open.length, end)
}

// What the last `open ... close` block holds, blocks taken in order as a
// global `/open([\s\S]*?)close/g` takes them.
export function lastBetween(text: string, open: string, close: string): string | undefined {
  let found: string | undefined
  let from = 0
  for (;;) {
    const start = text.indexOf(open, from)
    if (start === -1) return found
    const end = text.indexOf(close, start + open.length)
    if (end === -1) return found
    found = text.slice(start + open.length, end)
    from = end + close.length
  }
}
