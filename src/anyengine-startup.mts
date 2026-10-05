import { setTimeout as delay } from 'node:timers/promises'
import {
  claudeDialog,
  composerReady,
  parseStartupPrompt,
  pasteAndSubmit,
  type ScreenRows,
} from './anyengine-screen.mjs'

interface StartupScreen {
  rows(): Promise<ScreenRows>
}
interface StartupWait {
  timeoutMs: number
  cwd?: string
  expectedPrompt?: string
  stopped: () => boolean
  refusal: (label: string) => Error | null
  onAnswer?: (label: string, attempt: number) => void
}

// SessionStart does not imply readiness: newer Claude versions can mount a
// modal later. The screen must still permit input before every paste/Enter.
export async function waitForComposer(
  screen: StartupScreen,
  proc: { write(data: string): void },
  options: StartupWait,
): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs
  let previous = ''
  let stable = 0
  let answers = 0
  let lastAnswerAt = 0
  let interrupted = false
  let dialogName: string | null = null
  while (Date.now() < deadline && !options.stopped()) {
    const rows = await screen.rows()
    if (options.stopped()) break
    dialogName = claudeDialog(rows)
    const dialog = parseStartupPrompt(rows.lines)
    if (dialog) {
      interrupted = true
      const refusal = options.refusal(dialog.label)
      if (refusal) throw refusal
      const identity = JSON.stringify(dialog)
      stable = identity === previous ? stable + 1 : 1
      previous = identity
      if (stable >= 2 && answers < 5 && Date.now() - lastAnswerAt >= 1500) {
        answers += 1
        lastAnswerAt = Date.now()
        options.onAnswer?.(dialog.label, answers)
        for (const key of dialog.keystrokes) proc.write(key)
      }
    } else {
      previous = ''
      stable = 0
      if (composerReady(rows, options.expectedPrompt)) return interrupted
      interrupted ||= dialogName !== null
    }
    await delay(250)
  }
  if (options.stopped()) return false
  throw composerBlockedError(dialogName, options.cwd)
}

export function composerBlockedError(dialogName: string | null, cwd?: string): Error {
  return new Error(
    dialogName
      ? `A Claude Code dialog is open (${dialogName}); run \`claude\` in ${cwd ?? 'the thread workspace'} once to answer it. Prompt was not submitted.`
      : 'anyengine: Claude Code composer is not safely ready; prompt was not submitted.',
  )
}

export function steerComposer(
  screen: StartupScreen,
  proc: { write(data: string): void },
  prompt: string,
  cwd: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    pasteAndSubmit(proc, prompt, undefined, {
      beforeWrite: async (phase) => {
        const rows = await screen.rows()
        if (!composerReady(rows, phase === 'submit' ? prompt : undefined)) {
          throw composerBlockedError(claudeDialog(rows), cwd)
        }
      },
      onSubmitted: resolve,
      onError: reject,
    })
  })
}
