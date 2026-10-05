// `exec`, the bridge tool a Claude or Grok child runs shell commands through
// (spec 5.6, E1). Outside full access the engine's own shell is off (Claude's
// Bash at launch, Grok's by the server's approval gate; src/posture-claude.mts)
// and each command runs in the real codex child via app-server
// `command/exec`, under the sandbox of the calling thread's posture: Codex's
// own sandbox, not a reimplementation.
import type { BridgeThreadInfo } from './bridge-control.mjs'
import type { CodexUpstream } from './codex-upstream.mjs'
import { isGrokModel } from './grok-acp.mjs'
import { sandboxedOutcome, toCodexExecSandboxPolicy } from './posture.mjs'

export const EXEC_DEFAULT_TIMEOUT_MS = 120_000

// The real codex child (server.mts#attachNativeCodex). None, or not running,
// means no sandbox: `exec` refuses, and outside full access the thread has no
// shell at all (shellMode, src/posture-claude.mts).
export type SandboxUpstream = Pick<CodexUpstream, 'running' | 'request'>
let upstream: SandboxUpstream | null = null

export function registerSandboxUpstream(next: SandboxUpstream | null): void {
  upstream = next
}

export function sandboxExecAvailable(): boolean {
  return upstream?.running === true
}

export interface BridgeExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export async function runBridgeExec(
  caller: BridgeThreadInfo | null,
  args: Record<string, unknown>,
): Promise<BridgeExecResult> {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) throw new Error('command is required')
  if (caller?.owner !== 'local') {
    throw new Error(
      'exec runs commands for Claude and Grok threads; GPT threads have their own shell',
    )
  }
  const child = upstream
  if (!child?.running) {
    throw new Error(
      'no sandbox is available (no native codex child is running), so exec runs nothing',
    )
  }
  const outcome = sandboxedOutcome(caller.posture)
  if (outcome === 'deny') throw new Error('the thread is in plan mode, which runs no commands')
  if (outcome !== 'allow') {
    throw new Error(
      `this thread's approval policy asks before every command, which exec cannot do; ${askingShell(caller)}`,
    )
  }
  // The thread's cwd is the sandbox root. A command that needs another
  // directory `cd`s there; it cannot move the root.
  const cwd = caller.cwd ?? process.cwd()
  const timeout = Number(args.timeoutMs)
  const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : EXEC_DEFAULT_TIMEOUT_MS
  const params = {
    command: ['/bin/bash', '-lc', command],
    cwd,
    sandboxPolicy: toCodexExecSandboxPolicy(caller.posture, cwd),
    timeoutMs,
  }
  const result = asRecord(await child.request('command/exec', params, timeoutMs + 10_000))
  return {
    exitCode: Number(result.exitCode ?? -1),
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  }
}

// Where a thread that asks before every command runs one: in the engine's own
// shell, which asks, under full access; nowhere otherwise.
function askingShell(caller: BridgeThreadInfo): string {
  if (caller.posture.fileSystem.kind !== 'full-access') return 'this thread runs no shell commands'
  return isGrokModel(caller.model)
    ? "use grok's own shell, which asks first"
    : 'use Bash, which asks first'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
