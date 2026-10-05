import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeEnvironment } from './claude-environment.mjs'
import { contextPosture, isUnrestricted } from './posture.mjs'
import { claudeLaunchFor, headlessIsolation, relayDecision } from './posture-claude.mjs'
import type { ClaudeRuntime, RuntimeHandlers, RuntimeTurnContext } from './types.mjs'

export interface ClaudePRuntimeOptions {
  command: string
  extraArgs: string[]
  timeoutMs: number
  skipPermissions: boolean
  resume: boolean
  stopTimeoutRetries?: number
}

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'TodoWrite', 'Task']

export class ClaudePTranscriptRuntime implements ClaudeRuntime {
  private active = new Map<string, ChildProcess>()
  private readonly options: ClaudePRuntimeOptions

  constructor(options: ClaudePRuntimeOptions) {
    this.options = options
  }

  async runTurn(context: RuntimeTurnContext, handlers: RuntimeHandlers): Promise<void> {
    const tmp = await mkdtemp(join(tmpdir(), 'anyengine-claude-p-'))
    const inputFile = join(tmp, 'prompt.txt')
    await writeFile(inputFile, context.prompt, 'utf8')

    try {
      if (context.imageInputs.length > 0) {
        await handlers.onEvent({
          type: 'notice',
          level: 'warning',
          message:
            'claude-p runtime does not support direct multimodal attachments; sending the text prompt only.',
        })
      }

      const isolation = headlessIsolation(context)
      if (isolation)
        await handlers.onEvent({ type: 'notice', level: 'warning', message: isolation })
      const args = this.argsForContext(context, inputFile, isolation)
      const result = await this.runProcessWithRetry(context, args, handlers)
      const parsed = parseClaudePJson(result.stdout)
      const text = parsed?.result ?? result.stdout.trim()
      const sessionId = parsed?.sessionId
        ? `claude-p:${parsed.sessionId}`
        : (context.claudeSessionId ?? `claude-p:${context.threadId}`)

      await handlers.onEvent({ type: 'session', claudeSessionId: sessionId })
      if (parsed?.usage) await handlers.onEvent({ type: 'usage', usage: parsed.usage })
      if (parsed?.metrics) await handlers.onEvent({ type: 'metrics', ...parsed.metrics })
      if (text) await handlers.onEvent({ type: 'text_delta', delta: text })

      const success = result.exitCode === 0 && parsed?.isError !== true
      await handlers.onEvent({
        type: 'completed',
        success,
        result: success
          ? text
          : result.stderr.trim() || text || `claude-p exited ${result.exitCode}`,
        claudeSessionId: sessionId,
      })
      if (!success)
        throw new Error(result.stderr.trim() || text || `claude-p exited ${result.exitCode}`)
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  async steer(): Promise<void> {
    throw new Error('claude-p runtime does not support turn/steer; start a new turn instead')
  }

  async interrupt(threadId: string): Promise<void> {
    const child = this.active.get(threadId)
    if (!child) return
    terminateProcessTree(child, 'SIGINT')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        terminateProcessTree(child, 'SIGTERM')
    }, 1500).unref()
  }

  async stop(): Promise<void> {
    for (const child of this.active.values()) terminateProcessTree(child, 'SIGTERM')
    this.active.clear()
  }

  private argsForContext(
    context: RuntimeTurnContext,
    inputFile: string,
    isolation = headlessIsolation(context),
  ): string[] {
    const args = [
      ...this.options.extraArgs,
      '--output-format',
      'json',
      '--cwd',
      context.cwd,
      '--input-file',
      inputFile,
    ]
    if (context.model) args.push('--model', context.model)
    // claude-p is most reliable as a `claude -p`-style one-shot wrapper.
    // Its current `--resume + --input-file` path can run the new prompt but
    // still emit the previous assistant result in stdout, so keep resume
    // opt-in until that upstream behavior is stable.
    const resume = this.options.resume ? claudePResumeId(context.claudeSessionId) : null
    if (resume && !context.forkSession) args.push('--resume', resume)
    const allowedTools = allowedToolsForContext(context)
    if (allowedTools) args.push('--allowedTools', allowedTools)
    const refused = refusedTools(context)
    if (refused.length > 0) args.push('--disallowedTools', refused.join(','))
    // Only an unrestricted posture drops Claude's own prompts (spec 5.6, fix 4);
    // ANYENGINE_CLAUDE_P_SKIP_PERMISSIONS is the operator's explicit opt-in.
    const posture = contextPosture(context)
    const skip = this.options.skipPermissions || isUnrestricted(posture)
    if (skip) args.push('--dangerously-skip-permissions')
    args.push('--permission-mode', claudePPermissionMode(posture.plan, skip))
    // The PTY runtime's rule for project Claude config (src/posture-claude.mts):
    // claude-p takes --setting-sources and hands --strict-mcp-config to claude.
    if (isolation) {
      args.push('--setting-sources', 'user', '--strict-mcp-config')
    }
    args.push('--timeout', String(Math.max(1, Math.ceil(this.options.timeoutMs / 1000))))
    return args
  }

  private runProcess(
    context: RuntimeTurnContext,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const child = spawn(this.options.command, args, {
      cwd: context.cwd,
      env: claudeEnvironment(claudeLaunchFor(context).shell),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this.active.set(context.threadId, child)
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })

    return new Promise((resolve, reject) => {
      let timedOut = false
      let killTimer: NodeJS.Timeout | null = null
      const timeout = setTimeout(() => {
        timedOut = true
        terminateProcessTree(child, 'SIGTERM')
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null)
            terminateProcessTree(child, 'SIGKILL')
        }, 1500).unref()
      }, this.options.timeoutMs)
      child.once('error', (error) => {
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        this.active.delete(context.threadId)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        this.active.delete(context.threadId)
        if (timedOut) {
          reject(new Error(`claude-p timed out after ${this.options.timeoutMs}ms`))
          return
        }
        resolve({ stdout, stderr, exitCode: code ?? 1 })
      })
    })
  }

  private async runProcessWithRetry(
    context: RuntimeTurnContext,
    args: string[],
    handlers: RuntimeHandlers,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const attempts = 1 + Math.max(0, this.options.stopTimeoutRetries ?? 0)
    let last: { stdout: string; stderr: string; exitCode: number } | null = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let result: { stdout: string; stderr: string; exitCode: number }
      try {
        result = await this.runProcess(context, args)
      } catch (error) {
        if (isClaudePTimeoutError(error) && attempt < attempts) {
          await handlers.onEvent({
            type: 'notice',
            level: 'warning',
            message: `claude-p process timed out; retrying attempt ${attempt + 1}/${attempts}.`,
          })
          continue
        }
        throw error
      }
      if (!isClaudePStopTimeout(result) || attempt >= attempts) return result
      last = result
      await handlers.onEvent({
        type: 'notice',
        level: 'warning',
        message: `claude-p did not emit its Stop hook before timing out; retrying attempt ${attempt + 1}/${attempts}.`,
      })
    }
    return last ?? { stdout: '', stderr: 'claude-p retry exhausted', exitCode: 2 }
  }
}

function isClaudePStopTimeout(result: {
  stdout: string
  stderr: string
  exitCode: number
}): boolean {
  return result.stdout.trim() === '' && /(?:^|\b)StopTimeout(?:\b|$)/i.test(result.stderr)
}

function isClaudePTimeoutError(error: unknown): boolean {
  return error instanceof Error && /^claude-p timed out after \d+ms$/.test(error.message)
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  const childPids = child.pid ? descendantPids(child.pid) : []
  for (const pid of childPids.reverse()) {
    killPid(pid, signal)
  }
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
    } catch {}
  }
  killPid(child.pid, signal)
}

function killPid(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(pid, signal)
  } catch {}
}

function descendantPids(rootPid: number): number[] {
  if (process.platform === 'win32') return []
  try {
    const output = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000 })
    const children = new Map<number, number[]>()
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 2) continue
      const pid = Number(parts[0])
      const ppid = Number(parts[1])
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
      const siblings = children.get(ppid) ?? []
      siblings.push(pid)
      children.set(ppid, siblings)
    }
    const result: number[] = []
    const stack = [...(children.get(rootPid) ?? [])]
    while (stack.length > 0) {
      const pid = stack.pop()!
      result.push(pid)
      stack.push(...(children.get(pid) ?? []))
    }
    return result
  } catch {
    return []
  }
}

interface ParsedClaudePResult {
  result: string
  sessionId: string | null
  isError: boolean
  usage: Record<string, unknown> | null
  metrics: {
    durationMs: number | null
    apiDurationMs: number | null
    numTurns: number | null
    costUsd: number | null
  } | null
}

function parseClaudePJson(stdout: string): ParsedClaudePResult | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    const record = asRecord(parsed)
    return {
      result: typeof record.result === 'string' ? record.result : '',
      sessionId: typeof record.session_id === 'string' ? record.session_id : null,
      isError: record.is_error === true || record.subtype === 'error',
      usage: asOptionalRecord(record.usage),
      metrics: {
        durationMs: numberOrNull(record.duration_ms),
        apiDurationMs: numberOrNull(record.duration_api_ms),
        numTurns: numberOrNull(record.num_turns),
        costUsd: numberOrNull(record.total_cost_usd),
      },
    }
  } catch {
    return null
  }
}

// A pre-approval covers every call of a tool, so one the posture refuses in
// any call (a write judged at its widest, `Bash(git *)` as Bash) is dropped:
// claude-p takes no hook of ours to refuse that call later.
function allowedToolsForContext(context: RuntimeTurnContext): string | null {
  const posture = contextPosture(context)
  if (posture.plan || posture.fileSystem.kind === 'read-only') {
    return READ_ONLY_TOOLS.filter(
      (tool) => relayDecision(context, tool, {}).verdict !== 'deny',
    ).join(',')
  }
  const kept = (context.allowedTools ?? []).filter(
    (tool) => relayDecision(context, tool.replace(/\(.*$/s, ''), {}).verdict !== 'deny',
  )
  return kept.length > 0 ? kept.join(',') : null
}

// Tools the posture refuses in every call (a write even inside the cwd):
// denied outright, which beats an allow rule in the user's settings.
const PROBED_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Monitor',
  'WebFetch',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]

function refusedTools(context: RuntimeTurnContext): string[] {
  const probe = { file_path: join(context.cwd, 'anyengine-probe') }
  return [
    ...new Set([
      ...PROBED_TOOLS.filter((tool) => relayDecision(context, tool, probe).verdict === 'deny'),
      ...claudeLaunchFor(context).disallowedTools,
    ]),
  ]
}

// Pinned on every call, so no `defaultMode` in the settings (acceptEdits, say)
// applies. Nothing answers a prompt under claude-p, so what would ask is
// refused (`dontAsk`, deny < ask); allow rules still apply, and only the
// skip-permissions cases bypass. Names from `claude --help` 2.1.284, all in
// claude-p's own list.
function claudePPermissionMode(plan: boolean, skip: boolean): string {
  if (plan) return 'plan'
  return skip ? 'bypassPermissions' : 'dontAsk'
}

function claudePResumeId(value: string | null): string | null {
  if (!value) return null
  if (value.startsWith('claude-p:')) return value.slice('claude-p:'.length)
  return value.includes(':') ? null : value
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
