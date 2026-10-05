// Ported from EthanSK/claude-in-codex (MIT) src/claudeRunner.js @ e2adced, with changes; see THIRD_PARTY_NOTICES.md.
// Changes: restricted shared launch, scrubbed env, RouterLog codes only, split events,
// no computer-use proxy or permission mapping; scoped Codex MCP handoff.
import { spawn } from 'node:child_process'
import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ClaudeModelEntry } from './anyengine-config.mjs'
import { buildClaudeUserMessage, makeMarker, type ParsedCodexRequest } from './codex-input.mjs'
import { type ResponsesStream, rid } from './responses-stream.mjs'
import type { AdapterOwner } from './router-claim-client.mjs'
import type { RouterLog } from './router-log.mjs'
import { finishWebSearches, type TrampolineEvents, usageSoFar } from './trampoline-events.mjs'
import { TrampolineHandoff } from './trampoline-handoff.mjs'
import { claudeCapabilities, trampolineArgs, trampolineEnv } from './trampoline-launch.mjs'
import type { TrampolineState } from './trampoline-state.mjs'
import type { CodexToolEntry } from './trampoline-tools.mjs'

export interface TrampolineTurn {
  stream: ResponsesStream
  parsed: ParsedCodexRequest & { threadId: string | null; codexTurnId: string; fork: boolean }
  model: ClaudeModelEntry
  effort: string | null
  codexTools: unknown[]
  claudePath: string
  // Task 17 must take this from the owning adapter's thread, never parsed.cwd.
  trustedCwd: string | null
  engineRoot: string
  state: TrampolineState
  log: RouterLog
  owner?: AdapterOwner
  parentThreadId?: string | null
  parentTurnId?: string | null
  ownerTimeoutMs?: number
  signal?: AbortSignal
  // The one-shot smoke helper already owns and joins its entire detached group.
  ownedHelperGroup?: boolean
}
const sessionLocks = new Map<string, Promise<void>>()
async function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => next)
  sessionLocks.set(key, queued)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (sessionLocks.get(key) === queued) sessionLocks.delete(key)
  }
}
function canonicalCwd(trustedCwd: string | null, engineRoot: string): string {
  if (trustedCwd) {
    if (!isAbsolute(trustedCwd) || !statSync(trustedCwd).isDirectory())
      throw new Error('invalid owner cwd')
    return realpathSync(trustedCwd)
  }
  if (!isAbsolute(engineRoot)) throw new Error('engine root must be absolute')
  const cwd = join(engineRoot, 'router', 'trampoline-cwd')
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  if (lstatSync(cwd).isSymbolicLink() || readdirSync(cwd).length)
    throw new Error('fallback cwd must be an empty directory')
  return realpathSync(cwd)
}
const EFFORT: Record<string, string> = {
  none: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'max',
  persistent: 'max',
}
function systemPrompt(turn: TrampolineTurn, catalog: Map<string, CodexToolEntry>): string {
  const entries = [...catalog.entries()]
  const question =
    entries.find(([, entry]) => entry.name.endsWith('request_user_input_async')) ??
    entries.find(([, entry]) => entry.name.endsWith('request_user_input'))
  const questionNote = question
    ? `For decisions call mcp__codex__${question[0]} using Codex's question card. ${question[1].name.endsWith('request_user_input_async') ? 'The async card is accepted immediately; the answer arrives later in <send_user_message_question_reply>. Continue other work while waiting, and use that reply once it arrives.' : ''}`
    : 'You cannot show interactive permission prompts here. If you need a decision, ask in plain text and end your turn.'
  const skills = turn.parsed.skills
    ? `Read and follow relevant Codex SKILL.md instructions, especially when the user names a skill.\n\n${turn.parsed.skills}`
    : ''
  return [
    "You are running inside the Codex desktop app through a local bridge. Codex renders Markdown and shows tool summaries. Use Codex's own tools for actions; all file reads and actions must use Codex's own tools.",
    questionNote,
    turn.parsed.planMode
      ? 'Produce your plan as final text. Do not call a plan-completion tool.'
      : '',
    ...turn.parsed.agentsMd,
    skills,
    turn.parsed.codexMemory,
  ]
    .filter(Boolean)
    .join('\n\n')
}

interface ChildInput {
  claudePath: string
  args: string[]
  cwd: string
  input: string | null
  signal: AbortSignal
  onLine(line: string): void
  onStop?(): void
  descriptionLength?: number
  ownGroup?: boolean
  lifecycle?(event: string, fields: Record<string, unknown>): void
}
interface ChildResult {
  code: number | null
  stderr: string
}
async function groupJoined(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt <= 250; attempt++) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false
    }
    if (attempt < 250) await new Promise((done) => setTimeout(done, 20))
  }
  return false
}
// Every exit path waits for close (stdio drained), removes listeners and reaps
// the child. Escalation is idempotent even if a WebSocket sink closes twice.
function runChild(input: ChildInput): Promise<ChildResult> {
  return new Promise((resolve) => {
    const launchId = rid('group_')
    input.lifecycle?.('trampoline.group.launch', { launchId })
    const child = spawn(input.claudePath, input.args, {
      cwd: input.cwd,
      env: trampolineEnv(input.descriptionLength),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: input.ownGroup !== false,
    })
    let stopped = false
    let exited = false
    let stderr = ''
    let term: NodeJS.Timeout | undefined
    let kill: NodeJS.Timeout | undefined
    const signal = (value: NodeJS.Signals) => {
      try {
        if (input.ownGroup === false) child.kill(value)
        else if (child.pid) process.kill(-child.pid, value)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          stderr = 'Claude family signal failed.'
      }
    }
    const stop = () => {
      if (stopped || exited) return
      stopped = true
      input.onStop?.()
      signal('SIGINT')
      term = setTimeout(() => {
        if (!exited) signal('SIGTERM')
      }, 4000)
      kill = setTimeout(() => {
        if (!exited) signal('SIGKILL')
      }, 8000)
      term.unref()
      kill.unref()
    }
    input.signal.addEventListener('abort', stop, { once: true })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', input.onLine)
    child.stderr.on('data', (data) => {
      stderr = `${stderr}${data}`.slice(-20000)
    })
    child.stdin.on('error', () => {})
    child.on('error', () => {
      stderr = 'Could not start Claude Code.'
    })
    child.on('close', async (code) => {
      exited = true
      clearTimeout(term)
      clearTimeout(kill)
      input.signal.removeEventListener('abort', stop)
      lines.close()
      let joined = true
      if (input.ownGroup !== false && child.pid) {
        signal('SIGKILL')
        joined = await groupJoined(child.pid)
        if (!joined) {
          code = 1
          stderr = 'Claude family did not join.'
        }
      }
      try {
        input.lifecycle?.('trampoline.group.settled', {
          launchId,
          groupPid: child.pid ?? 0,
          joined,
        })
      } catch {
        code = 1
        stderr = 'Claude family cleanup publication failed.'
      }
      resolve({ code, stderr })
    })
    if (input.signal.aborted) stop()
    child.stdin.end(input.input ?? undefined)
  })
}
function parseLine(line: string): Record<string, any> | null {
  try {
    const event = JSON.parse(line)
    return event && typeof event === 'object' && !Array.isArray(event) ? event : null
  } catch {
    return null
  }
}
function finish(turn: TrampolineTurn, ctx: TrampolineEvents, exit: ChildResult): void {
  const { stream, state, parsed } = turn
  finishWebSearches(ctx, stream)
  const result = ctx.result
  if (!result || result.is_error || exit.code !== 0) {
    const reason =
      result?.result ||
      result?.errors?.join?.('\n') ||
      exit.stderr.trim().split('\n').slice(-6).join('\n') ||
      `claude exited with code ${exit.code}`
    stream.closeOpen('commentary')
    stream.textDelta(`**Claude Code stopped:** ${reason}`)
    stream.closeOpen('final_answer')
    turn.log.error('trampoline.failed', { code: exit.code })
    stream.fail(String(reason))
    return
  }
  if (parsed.planMode && typeof result.result === 'string' && result.result.trim()) {
    stream.closeOpen('commentary')
    stream.textDelta(`<proposed_plan>\n${result.result.trim()}\n</proposed_plan>`)
  }
  stream.closeOpen('final_answer')
  if (ctx.sid) {
    const turnId = rid('t')
    state.recordTurn(ctx.sid, turnId, parsed.threadId)
    stream.marker(makeMarker(ctx.sid, turnId))
  }
  for (const usage of Object.values(result.modelUsage ?? {}) as Array<{ contextWindow?: number }>) {
    if (usage?.contextWindow) state.setContextWindow(turn.model.id, usage.contextWindow)
  }
  stream.complete(usageSoFar(ctx))
  turn.log.info('trampoline.done', {
    threadId: parsed.threadId,
    turnId: parsed.codexTurnId,
    parentThreadId: turn.parentThreadId ?? null,
    parentTurnId: turn.parentTurnId ?? null,
    model: turn.model.id,
    cliModel: turn.model.claudeModel,
    sessionId: ctx.sid,
    owner: turn.owner?.socketPath ?? null,
    success: true,
    code: exit.code,
  })
}
async function runLocked(
  turn: TrampolineTurn,
  signal: AbortSignal,
  handoff: TrampolineHandoff,
): Promise<void> {
  if (signal.aborted || turn.stream.closed) return
  const caps = await claudeCapabilities(turn.claudePath)
  if (signal.aborted || turn.stream.closed) return
  const { parsed, model } = turn
  const effort = EFFORT[(turn.effort ?? '').toLowerCase()] ?? null
  const mcpConfig = await handoff.mcpConfig()
  if (signal.aborted) return
  const args = trampolineArgs({
    claudeModel: model.claudeModel,
    effort,
    planMode: parsed.planMode,
    resume: parsed.resume?.sid ?? null,
    fork: parsed.fork,
    mcpConfig,
    systemPrompt: systemPrompt(turn, handoff.catalog),
    codexToolsOffered: handoff.catalog.size > 0,
    liveWebSearch: turn.codexTools.some(
      (tool) =>
        !!tool &&
        typeof tool === 'object' &&
        (tool as Record<string, unknown>).type === 'web_search' &&
        (tool as Record<string, unknown>).external_web_access === true,
    ),
    caps,
  })
  const cwd = canonicalCwd(turn.trustedCwd, turn.engineRoot)
  turn.log.info('trampoline.turn', {
    model: model.id,
    mode: parsed.planMode ? 'plan' : 'default',
    effort,
    session: parsed.resume ? (parsed.fork ? 'fork' : 'resume') : 'new-session',
  })
  handoff.ctx.cwd = cwd
  const exit = await runChild({
    claudePath: turn.claudePath,
    args,
    cwd,
    signal,
    descriptionLength: handoff.descriptionLength,
    ownGroup: !turn.ownedHelperGroup,
    lifecycle: (event, fields) =>
      turn.log.info(event, {
        ...fields,
        threadId: parsed.threadId,
        turnId: parsed.codexTurnId,
      }),
    input: `${JSON.stringify(buildClaudeUserMessage(parsed, { newSession: !parsed.resume }))}\n`,
    onStop() {
      turn.log.info('trampoline.cancel')
    },
    onLine(line) {
      const event = parseLine(line)
      if (event && !signal.aborted) {
        handoff.handle(event, Buffer.byteLength(line))
        if (
          event.type === 'system' &&
          event.subtype === 'init' &&
          typeof event.session_id === 'string'
        )
          turn.log.info('trampoline.session', {
            threadId: parsed.threadId,
            turnId: parsed.codexTurnId,
            sessionId: event.session_id,
          })
      }
    },
  })
  if (!signal.aborted && handoff.stream && !handoff.stream.closed)
    finish({ ...turn, stream: handoff.stream }, handoff.ctx, exit)
}
export async function runTrampolineTurn(turn: TrampolineTurn): Promise<void> {
  const abort = new AbortController()
  const onAbort = () => abort.abort()
  turn.signal?.addEventListener('abort', onAbort, { once: true })
  if (turn.signal?.aborted) abort.abort()
  let handoff: TrampolineHandoff | undefined
  try {
    handoff = new TrampolineHandoff(turn, abort)
    if (abort.signal.aborted) return
    const { resume, fork } = turn.parsed
    const key = resume && !fork ? resume.sid : rid(fork ? 'fork_' : 'new_')
    const current = handoff
    await withSessionLock(key, async () => {
      try {
        await runLocked(turn, abort.signal, current)
      } catch (error) {
        const stream = current.stream
        if (stream && !stream.closed && !abort.signal.aborted)
          stream.fail(
            error instanceof Error && error.message.includes('socket path')
              ? error.message
              : 'Could not run Claude model mode. Check the CLI installation, --tools support and login.',
          )
        throw error
      } finally {
        await current.finish()
      }
    })
  } catch (error) {
    turn.log.error('trampoline.launch-failed')
    const stream = handoff?.stream ?? turn.stream
    if (!abort.signal.aborted && !stream.closed)
      stream.fail(
        error instanceof Error && error.message.includes('socket path')
          ? error.message
          : 'Could not run Claude model mode. Check the CLI installation, --tools support and login.',
      )
  } finally {
    turn.signal?.removeEventListener('abort', onAbort)
    await handoff?.finish()
  }
}

// /compact is also a Claude child: the same allowlist, hook/settings isolation,
// session lock and environment apply. Failure returns no session (never success).
export async function compactTrampolineSession(input: {
  claudePath: string
  sid: string
  trustedCwd: string | null
  engineRoot: string
  signal?: AbortSignal
}): Promise<{ sessionId: string | null }> {
  return withSessionLock(input.sid, async () => {
    const abort = new AbortController()
    const cancel = () => abort.abort()
    input.signal?.addEventListener('abort', cancel, { once: true })
    if (input.signal?.aborted) cancel()
    const timeout = setTimeout(() => abort.abort(), 10 * 60 * 1000)
    try {
      const caps = await claudeCapabilities(input.claudePath)
      if (abort.signal.aborted) return { sessionId: null }
      const args = trampolineArgs({
        claudeModel: 'haiku',
        effort: null,
        planMode: false,
        resume: input.sid,
        fork: false,
        mcpConfig: { mcpServers: {} },
        systemPrompt: '',
        codexToolsOffered: false,
        caps,
      })
      // Slash commands use the CLI's plain input / JSON output, not a stream
      // user message. All security flags still come from trampolineArgs.
      args[args.indexOf('--input-format') + 1] = 'text'
      args[args.indexOf('--output-format') + 1] = 'json'
      // Preserve the resumed session's model for compaction.
      args.splice(args.indexOf('--model'), 2)
      const partial = args.indexOf('--include-partial-messages')
      if (partial !== -1) args.splice(partial, 1)
      args.splice(args.indexOf('--disable-slash-commands'), 1)
      args.push('/compact')
      let output = ''
      const exit = await runChild({
        claudePath: input.claudePath,
        args,
        cwd: canonicalCwd(input.trustedCwd, input.engineRoot),
        input: null,
        signal: abort.signal,
        onLine(line) {
          if (output.length + line.length > 4 * 1024 * 1024) {
            abort.abort()
            return
          }
          output += `${line}\n`
        },
      })
      const decoded = JSON.parse(output)
      const final = Array.isArray(decoded)
        ? decoded.findLast((event) => event?.type === 'result')
        : decoded
      return {
        sessionId:
          !abort.signal.aborted && exit.code === 0 && final?.type === 'result' && !final.is_error
            ? typeof final.session_id === 'string'
              ? final.session_id
              : input.sid
            : null,
      }
    } catch {
      return { sessionId: null }
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', cancel)
    }
  })
}
