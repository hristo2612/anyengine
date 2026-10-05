// The login-shell rc and its one AnyEngine block. ChatGPT.app imports its
// login shell's environment with CODEX_SHELL=1, so a CODEX_SHELL-guarded
// `export CODEX_CLI_PATH=...` reaches only the app. M0 left that block in
// ~/.zshrc by hand (uncommented, unmarked); `on` recognises it in any of
// three states and never writes a second one: active (leave it), commented
// (uncomment its three lines) or absent (append a marked block).
//
// `off` restores the whole file when it is byte for byte what `on` left.
// When the operator edited it since, revertHunk takes out only the lines `on`
// changed, anchored on their neighbours, and refuses when it cannot find them
// exactly once.
import { join } from 'node:path'

export const RC_BEGIN =
  '# >>> anyengine >>> (managed by `anyengine on`; `anyengine off` removes it)'
export const RC_END = '# <<< anyengine <<<'
export type RcState = 'active' | 'commented' | 'absent'

const GUARD = /^\s*(#\s*)?if \[\[ -n "\$CODEX_SHELL" \]\]; then\s*$/
const EXPORT = /^\s*(#\s*)?export CODEX_CLI_PATH=/
const FI = /^\s*(#\s*)?fi\s*$/

export function rcPath(home: string, shell: string | undefined): string | null {
  const name = (shell ?? '').split('/').pop()
  if (name === 'zsh') return join(home, '.zshrc')
  if (name === 'bash') return join(home, '.bash_profile')
  return null
}

export function findCodexCliBlock(text: string): { state: RcState; start: number; end: number } {
  const lines = text.split('\n')
  const blocks: Array<{ state: RcState; start: number; end: number }> = []
  const ownedExport = /^\s*(#\s*)?export CODEX_CLI_PATH="\$HOME\/bin\/codex"\s*$/
  const consumed = new Set<number>()
  for (let i = 0; i + 2 < lines.length; i += 1) {
    const [a, b, c] = [lines[i] ?? '', lines[i + 1] ?? '', lines[i + 2] ?? '']
    if (!GUARD.test(a) || !EXPORT.test(b) || !FI.test(c)) continue
    const comments = [a, b, c].filter((line) => /^\s*#/.test(line)).length
    if ((comments !== 0 && comments !== 3) || !ownedExport.test(b))
      throw new Error('unsupported or mixed CODEX_CLI_PATH guard')
    blocks.push({ state: comments === 3 ? 'commented' : 'active', start: i, end: i + 2 })
    consumed.add(i + 1)
  }
  if (blocks.length > 1 || lines.some((line, i) => EXPORT.test(line) && !consumed.has(i)))
    throw new Error('ambiguous or unguarded CODEX_CLI_PATH block')
  if (blocks.length === 0 && lines.some((line) => line === RC_BEGIN || line === RC_END))
    throw new Error('incomplete marked AnyEngine rc block')
  return blocks[0] ?? { state: 'absent', start: -1, end: -1 }
}

export function withRcBlock(text: string): { text: string; changed: boolean; state: RcState } {
  const block = findCodexCliBlock(text)
  if (block.state === 'active') return { text, changed: false, state: 'active' }
  if (block.state === 'commented') {
    const lines = text.split('\n')
    for (let i = block.start; i <= block.end; i += 1)
      lines[i] = (lines[i] ?? '').replace(/^(\s*)#\s?/, '$1')
    return { text: lines.join('\n'), changed: true, state: 'commented' }
  }
  const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n'
  const block5 = [
    RC_BEGIN,
    'if [[ -n "$CODEX_SHELL" ]]; then',
    '  export CODEX_CLI_PATH="$HOME/bin/codex"',
    'fi',
    RC_END,
  ]
  return { text: `${text}${separator}${block5.join('\n')}\n`, changed: true, state: 'absent' }
}

export function withCliPath(text: string, bin: string | undefined): string {
  const block = findCodexCliBlock(text)
  if (block.state !== 'active') throw new Error('CLI PATH requires an active app guard')
  const path = bin
    ? `export PATH='${bin.replaceAll("'", "'\\''")}':"$PATH"`
    : 'export PATH="$HOME/.anyengine/bin:$PATH"'
  const lines = text.split('\n')
  const begin = lines.indexOf(RC_BEGIN)
  const end = lines.indexOf(RC_END)
  if (begin >= 0 || end >= 0) {
    if (begin < 0 || end !== block.end + 1 || begin >= block.start)
      throw new Error('unsupported marked AnyEngine rc block')
    const extra = lines.slice(begin + 1, block.start)
    if (extra.length === 1 && extra[0] === path) return text
    if (extra.length) throw new Error('changed AnyEngine PATH line; preserve the rc file')
    lines.splice(begin + 1, 0, path)
  } else {
    lines.splice(block.end + 1, 0, RC_END)
    lines.splice(block.start, 0, RC_BEGIN, path)
  }
  return lines.join('\n')
}

export function revertHunk(current: string, before: string, after: string): string | null {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  if (start === endA && start === endB) return current
  const lead = start > 0 ? [b[start - 1] ?? ''] : []
  const trail = endB < b.length ? [b[endB] ?? ''] : []
  const needle = [...lead, ...b.slice(start, endB), ...trail].join('\n')
  const replacement = [...lead, ...a.slice(start, endA), ...trail].join('\n')
  const first = current.indexOf(needle)
  if (first < 0 || current.indexOf(needle, first + 1) >= 0) return null
  if (first > 0 && current[first - 1] !== '\n') return null
  const end = first + needle.length
  if (!needle.endsWith('\n') && end < current.length && current[end] !== '\n') return null
  return current.slice(0, first) + replacement + current.slice(first + needle.length)
}
