// One installed Claude harness turn. The gateway supplies models; Claude owns Read.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveGptModel } from './claude-models.mjs'
import { atomicFile, digest, regularBytes, sameState, stateAt } from './control-layer-state.mjs'
import { fetchGptSettingsView } from './router-messages.mjs'
import type { PathContext, PathResult } from './smoke.mjs'
import { joinDetachedGroup } from './smoke-client.mjs'

const MARKER = 'anyengine-smoke-marker.txt'
const PROMPT =
  'Read the file anyengine-smoke-marker.txt using Read once and reply with exactly PONG.'
const REAL_PROMPT = 'Reply with exactly PONG. Do not use any tool.'
const markerArgs = (model: string, router: string) => [
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
  '--settings',
  JSON.stringify({ env: { ANTHROPIC_BASE_URL: router } }),
]
// Every tool call in the real-settings turn is refused by a flag-scope hook:
// plan mode alone still lets a Bash allow rule run, and --max-turns 1 stops
// only the next model call, not the tools of the first reply.
const REFUSAL = 'anyengine smoke: this turn is read-only'
export const READ_ONLY_HOOKS = {
  hooks: {
    PreToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `echo '${JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: REFUSAL,
              },
            })}'`,
          },
        ],
      },
    ],
  },
}
// Flag settings outrank the user's, so the router URL is pinned here too: a
// user settings.json that sets ANTHROPIC_BASE_URL would otherwise decide where
// this turn goes.
export const readOnlySettings = (router: string) =>
  JSON.stringify({ ...READ_ONLY_HOOKS, env: { ANTHROPIC_BASE_URL: router } })
// The user's own settings and whole tool surface, claude.ai connectors
// included. With `--tools` restricted Claude Code lists every tool up front;
// unrestricted it adds connector tools inline, a request shape only real
// setups send (it broke GPT on 2026-10-16). No tool runs (the hook above);
// plan mode, one turn and no saved session are extra margins. The user's own
// session hooks still run, as for any session.
const realArgs = (model: string, router: string) => [
  '-p',
  REAL_PROMPT,
  '--output-format',
  'stream-json',
  '--verbose',
  '--model',
  model,
  '--permission-mode',
  'plan',
  // Two turns: a model that tries a tool anyway gets the hook's refusal and
  // can still answer.
  '--max-turns',
  '2',
  '--no-session-persistence',
  // A second margin: the one tool plan mode lets an allow rule run, and the
  // sub-agent launcher. Neither is part of the connector request shape.
  '--disallowedTools',
  'Bash',
  'Agent',
  '--settings',
  readOnlySettings(router),
]
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
  args: string[],
  signal: AbortSignal,
): Promise<{ code: number | null; bytes: Buffer }> {
  if (signal.aborted) throw new Error('Claude Code smoke deadline exceeded')
  ctx.run.pending(ctx.cohort)
  const child = spawn(ctx.config.claude.cli!, args, {
    cwd: ctx.deps.project,
    detached: true,
    stdio: 'pipe',
    env: ctx.deps.adapterEnv({
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${ctx.config.router.port}`,
      CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
    }),
  })
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

// The read-only hook cannot load when settings switch hooks off. Claude Code
// 2.1.301 reads hook policy from the user's config dir, managed settings and
// their drop-ins, MDM plists and a cached server policy; safe and simple
// modes drop flag hooks too. Any of these, or any file it cannot read, skips
// the real-settings turn (fail closed).
export const CLAUDE_MANAGED_ROOT = '/Library/Application Support/ClaudeCode'
const MDM = '/Library/Managed Preferences'
const on = (value: string | undefined) =>
  value !== undefined && !['', '0', 'false', 'no'].includes(value.toLowerCase())
function policyOff(value: Event, managed: boolean): boolean {
  const strict = value?.strictPluginOnlyCustomization
  return (
    value?.disableAllHooks === true ||
    (managed &&
      (value?.allowManagedHooksOnly === true ||
        strict === true ||
        (Array.isArray(strict) && strict.includes('hooks'))))
  )
}
export function hooksDisabled(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  managedRoot = CLAUDE_MANAGED_ROOT,
  mdm = MDM,
): boolean {
  if (on(env.CLAUDE_CODE_SIMPLE) || on(env.CLAUDE_CODE_SAFE_MODE)) return true
  const config = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  const user = env.USER ?? ''
  for (const path of [
    join(config, 'remote-settings.json'),
    join(mdm, 'com.anthropic.claudecode.plist'),
    join(mdm, user, 'com.anthropic.claudecode.plist'),
  ])
    if (existsSync(path)) return true
  let dropIns: string[] = []
  try {
    dropIns = readdirSync(join(managedRoot, 'managed-settings.d'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(managedRoot, 'managed-settings.d', name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true
  }
  const files: Array<[string, boolean]> = [
    [join(config, 'settings.json'), false],
    [join(managedRoot, 'managed-settings.json'), true],
    ...dropIns.map((path): [string, boolean] => [path, true]),
  ]
  for (const [path, managed] of files) {
    try {
      if (policyOff(JSON.parse(readFileSync(path, 'utf8')), managed)) return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true
    }
  }
  return false
}

function events(bytes: Buffer): Event[] | null {
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim().split('\n')
  if (lines.length > 1024) return null
  const parsed: Event[] = lines.filter(Boolean).map((line) => JSON.parse(line))
  return parsed.every((event) => event && typeof event === 'object' && !Array.isArray(event))
    ? parsed
    : null
}
// PONG, and every tool the model tried was refused by the read-only hook;
// returns the connected MCP server count for the detail.
function verifiedReal(bytes: Buffer, model: string): number | null {
  const all = events(bytes)
  if (!all) return null
  const init = all.find((event) => event.type === 'system' && event.subtype === 'init')
  const tried = all.flatMap((event) =>
    event.type === 'assistant' ? content(event).filter((block) => block.type === 'tool_use') : [],
  )
  const outcomes = all.flatMap((event) =>
    event.type === 'user' ? content(event).filter((block) => block.type === 'tool_result') : [],
  )
  const used =
    outcomes.length !== tried.length ||
    outcomes.some(
      (block) =>
        block.is_error !== true ||
        !tried.some((call) => call.id === block.tool_use_id) ||
        !resultText(block.content).includes(REFUSAL),
    )
  const completed = all.filter((event) => event.type === 'result')
  const terminal = completed[0]
  if (
    !init ||
    init.model !== model ||
    used ||
    completed.length !== 1 ||
    terminal?.subtype !== 'success' ||
    terminal.is_error === true ||
    typeof terminal.result !== 'string' ||
    terminal.result.trim() !== 'PONG'
  )
    return null
  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : []
  return servers.filter((server: Event) => server?.status === 'connected').length
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
  // Two turns; the second connects the user's MCP servers and connectors first.
  const timer = setTimeout(() => controller.abort(), 120_000)
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
    const router = `http://127.0.0.1:${ctx.config.router.port}`
    const work = await cliTurn(ctx, markerArgs(model, router), controller.signal)
    const ok = work.code === 0 && verified(work.bytes, ctx.deps.project, owned.text, model)
    const restore = owned
    owned = undefined
    restore.restore()
    ctx.verify()
    if (!ok)
      return result(
        false,
        'Claude Code GPT tool/terminal evidence failed; codex login or anyengine off',
      )
    // Unknown, not passed: an existing degraded mark for this path is kept.
    // Judge the policy with the environment the CLI child gets.
    if (hooksDisabled(ctx.deps.claudeHome, ctx.deps.adapterEnv({})))
      return result(
        null,
        'Claude Code GPT one Read marker result then PONG verified; real-settings turn skipped: Claude settings can switch hooks off here, so it could not be kept read-only',
      )
    let servers: number | null = null
    try {
      const real = await cliTurn(ctx, realArgs(model, router), controller.signal)
      servers = real.code === 0 ? verifiedReal(real.bytes, model) : null
    } catch {
      servers = null
    }
    ctx.verify()
    return servers === null
      ? result(
          false,
          "Claude Code GPT with the user's real settings and connectors failed (the marker turn passed); see the router log",
        )
      : result(
          true,
          `Claude Code GPT one Read marker result then PONG verified; real settings with ${servers} connected MCP servers then PONG verified`,
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
