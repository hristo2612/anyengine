// One installed Claude harness turn. The gateway supplies models; Claude owns Read.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveGptModel } from './claude-models.mjs'
import { atomicFile, digest, regularBytes, sameState, stateAt } from './control-layer-state.mjs'
import { fetchGptSettingsView } from './router-messages.mjs'
import type { PathContext, PathResult } from './smoke.mjs'
import { joinDetachedGroup } from './smoke-client.mjs'

const MARKER = 'anyengine-smoke-marker.txt'
const PROMPT =
  'Read the file anyengine-smoke-marker.txt using Read once and reply with exactly PONG.'
const MAX_OUTPUT = 8 * 1024 * 1024
type Event = Record<string, any>

function marker(ctx: PathContext): { text: string; restore(): void } {
  const project = join(ctx.root, 'smoke/claude-project')
  if (ctx.deps.project !== project || realpathSync(project) !== project)
    throw new Error('fixed smoke project unavailable')
  const target = join(project, MARKER)
  const before = stateAt(target)
  if (before.kind !== 'absent' && before.kind !== 'file')
    throw new Error('smoke marker must be a regular file')
  const saved = before.kind === 'file' ? regularBytes(target, 2_000_000) : null
  if (saved) {
    writeFileSync(join(ctx.deps.runDir, 'claude-code-marker-before.bin'), saved, {
      flag: 'wx',
      mode: 0o600,
    })
    writeFileSync(
      join(ctx.deps.runDir, 'claude-code-marker-before.json'),
      JSON.stringify({ target, mode: before.mode, sha256: before.sha }),
      { flag: 'wx', mode: 0o600 },
    )
  }
  const text = `anyengine-smoke-marker:${randomUUID()}\n`
  const bytes = Buffer.from(text)
  if (!sameState(stateAt(target), before)) throw new Error('smoke marker changed before write')
  if (before.kind === 'absent') writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 })
  else atomicFile(target, bytes, before.mode!)
  return {
    text,
    restore() {
      const current = stateAt(target)
      if (current.kind !== 'file' || current.sha !== digest(bytes)) {
        ctx.uncertain = true
        throw new Error('smoke marker restoration conflicted; retain run backup')
      }
      if (saved) atomicFile(target, saved, before.mode!)
      else unlinkSync(target)
      if (!sameState(stateAt(target), before)) {
        ctx.uncertain = true
        throw new Error('smoke marker restoration unverified; retain run backup')
      }
    },
  }
}

async function cliTurn(
  ctx: PathContext,
  model: string,
  signal: AbortSignal,
): Promise<{ code: number | null; bytes: Buffer }> {
  if (signal.aborted) throw new Error('Claude Code smoke deadline exceeded')
  ctx.run.pending(ctx.cohort)
  const child = spawn(
    ctx.config.claude.cli!,
    [
      '-p',
      PROMPT,
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      model,
      '--tools',
      'Read',
      '--allowedTools',
      'Read',
      '--max-turns',
      '2',
      '--no-session-persistence',
      '--disable-slash-commands',
    ],
    {
      cwd: ctx.deps.project,
      detached: true,
      stdio: 'pipe',
      env: ctx.deps.adapterEnv({
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${ctx.config.router.port}`,
        CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
      }),
    },
  )
  let failure: string | null = null
  let size = 0
  const chunks: Buffer[] = []
  let exited!: (code: number | null) => void
  const exit = new Promise<number | null>((done) => {
    exited = done
  })
  const close = new Promise<void>((done) => child.once('close', () => done()))
  child.once('exit', exited)
  child.once('error', () => {
    failure = 'Claude Code smoke process failed'
    exited(null)
  })
  child.stdin.on('error', () => {})
  child.stderr.resume()
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') ctx.uncertain = true
    }
  }
  const abort = () => {
    failure = 'Claude Code smoke deadline exceeded'
    stop()
  }
  signal.addEventListener('abort', abort, { once: true })
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > MAX_OUTPUT) {
      chunks.length = 0
      failure = 'Claude Code smoke output exceeds bound'
      stop()
    } else chunks.push(chunk)
  })
  let outcome:
    | { ok: true; work: { code: number | null; bytes: Buffer } }
    | { ok: false; error: unknown }
  let cleanupError: Error | undefined
  try {
    await new Promise<void>((done, reject) => {
      child.once('spawn', done)
      child.once('error', () => reject(new Error('Claude Code smoke process failed')))
    })
    if (signal.aborted) abort()
    const actual = ctx.system.processes().find((process) => process.pid === child.pid)
    if (!actual) throw new Error('Claude Code smoke process identity unavailable')
    ctx.cohort.push({ pid: actual.pid, processStart: actual.processStart })
    ctx.run.pending(ctx.cohort)
    child.stdin.end()
    const code = await exit
    // A descendant retaining stdout cannot hold the join after its parent exits.
    await joinDetachedGroup(child.pid!, true)
    await close
    if (failure) throw new Error(failure)
    outcome = { ok: true, work: { code, bytes: Buffer.concat(chunks) } }
  } catch (error) {
    outcome = { ok: false, error }
  } finally {
    signal.removeEventListener('abort', abort)
    stop()
    try {
      await joinDetachedGroup(child.pid ?? 0, true)
      await close
    } catch {
      ctx.uncertain = true
      cleanupError = new Error('Claude Code smoke child cleanup unverified')
    }
  }
  if (cleanupError) throw cleanupError
  if (!outcome.ok) throw outcome.error
  return outcome.work
}

function content(event: Event): Event[] {
  return Array.isArray(event.message?.content) ? event.message.content : []
}
function resultText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}
function verified(bytes: Buffer, project: string, markerText: string, model: string): boolean {
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim().split('\n')
  if (lines.length > 1024) return false
  const events: Event[] = lines.filter(Boolean).map((line) => JSON.parse(line))
  if (events.some((event) => !event || typeof event !== 'object' || Array.isArray(event)))
    return false
  const calls = events.flatMap((event, index) =>
    event.type === 'assistant'
      ? content(event)
          .filter((block) => block.type === 'tool_use')
          .map((block) => ({ block, index }))
      : [],
  )
  const call = calls[0]
  if (
    calls.length !== 1 ||
    !call ||
    call.block.name !== 'Read' ||
    typeof call.block.id !== 'string' ||
    typeof call.block.input?.file_path !== 'string' ||
    resolve(project, call.block.input.file_path) !== join(project, MARKER)
  )
    return false
  const results = events.flatMap((event, index) =>
    event.type === 'user'
      ? content(event)
          .filter((block) => block.type === 'tool_result')
          .map((block) => ({ block, index }))
      : [],
  )
  const result = results[0]
  if (
    results.length !== 1 ||
    !result ||
    result.index <= call.index ||
    result.block.tool_use_id !== call.block.id ||
    result.block.is_error === true ||
    !resultText(result.block.content).includes(markerText.trim())
  )
    return false
  const completed = events.flatMap((event, index) =>
    event.type === 'result' ? [{ event, index }] : [],
  )
  const terminal = completed[0]
  return (
    completed.length === 1 &&
    !!terminal &&
    terminal.index > result.index &&
    terminal.event.subtype === 'success' &&
    terminal.event.is_error !== true &&
    typeof terminal.event.result === 'string' &&
    terminal.event.result.trim() === 'PONG' &&
    !events.some(
      (event) => event.type === 'system' && event.subtype === 'init' && event.model !== model,
    )
  )
}

export async function runClaudeCodeSmoke(ctx: PathContext): Promise<PathResult> {
  const started = Date.now()
  const result = (ok: boolean | null, detail: string): PathResult => ({
    ok,
    detail,
    ms: Date.now() - started,
  })
  if (!ctx.config.smoke.enabled) return result(null, 'Claude Code GPT smoke disabled')
  if (!ctx.config.router.enabled || !ctx.config.claude.cli)
    return result(null, 'Claude Code GPT routing/CLI is not installed')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  let owned: ReturnType<typeof marker> | undefined
  try {
    ctx.verify()
    const view = await fetchGptSettingsView(
      `http://127.0.0.1:${ctx.config.router.port}`,
      controller.signal,
    )
    const model = ctx.config.smoke.gptModel ?? view.models.at(-1)?.id
    if (!model || !resolveGptModel(model, view.models))
      return result(false, 'Configured GPT smoke model unavailable; codex login or anyengine off')
    owned = marker(ctx)
    const work = await cliTurn(ctx, model, controller.signal)
    const ok = work.code === 0 && verified(work.bytes, ctx.deps.project, owned.text, model)
    ctx.verify()
    return result(
      ok,
      ok
        ? 'Claude Code GPT one Read marker result then PONG verified'
        : 'Claude Code GPT tool/terminal evidence failed; codex login or anyengine off',
    )
  } catch {
    return result(
      false,
      'Claude Code GPT smoke unavailable or failed; codex login or anyengine off',
    )
  } finally {
    clearTimeout(timer)
    controller.abort()
    owned?.restore()
  }
}
