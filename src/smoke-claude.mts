import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCodexRequest } from './codex-input.mjs'
import { configAt } from './control-install-on.mjs'
import { digest, object, regularBytes, statAt } from './control-layer-state.mjs'
import { ResponsesStream } from './responses-stream.mjs'
import type { PathContext } from './smoke.mjs'
import { joinDetachedGroup, successfulResponse } from './smoke-client.mjs'
import type { GateTurn, ProbeIdentity } from './smoke-evidence.mjs'
import { probeRoot } from './smoke-probes.mjs'
import { trampolineEnv } from './trampoline-launch.mjs'
import { runTrampolineTurn } from './trampoline-runner.mjs'
import { TrampolineState } from './trampoline-state.mjs'

const SESSION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function claudeProjectFolder(claudeHome: string, project: string): string {
  return join(claudeHome, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'))
}
export function pruneOwnSessions(
  claudeHome: string,
  project: string,
  sessionIds: string[],
  configHome = join(claudeHome, '.claude'),
): { removed: string[]; missing: string[] } {
  if (
    !isAbsolute(project) ||
    resolve(project) !== project ||
    sessionIds.some((id) => !SESSION.test(id))
  )
    throw new Error('invalid smoke project/session identity')
  const folder = join(configHome, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'))
  const ids = [...new Set(sessionIds)]
  const result: { removed: string[]; missing: string[] } = { removed: [], missing: [] }
  if (!ids.length) return result
  for (const dir of [configHome, join(configHome, 'projects'), folder]) {
    const stat = statAt(dir)
    if (!stat) return { removed: [], missing: ids }
    if (!stat.isDirectory() || realpathSync(dir) !== dir)
      throw new Error('smoke session directory must be canonical and direct')
  }
  // Validate every target before the first unlink. Never enumerate the folder.
  const files = ids.map((id) => {
    const file = join(folder, `${id}.jsonl`)
    const stat = statAt(file)
    if (stat && !stat.isFile()) throw new Error('smoke session must be a regular file')
    return { id, file, stat }
  })
  for (const { id, file, stat } of files) {
    if (!stat) {
      result.missing.push(id)
      continue
    }
    const current = lstatSync(file)
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino)
      throw new Error('smoke session identity changed before cleanup')
    unlinkSync(file)
    result.removed.push(id)
  }
  return result
}

export interface OAuthSelection {
  loggedIn: true
  method: 'claude.ai'
  home: string
}
export interface OAuthObservation extends OAuthSelection {
  executable: string
  identity: string
  version: string
}
export function parseOAuthStatus(
  bytes: Buffer,
  status: number | null,
  home: string,
): OAuthSelection {
  if (bytes.length > 64_000) throw new Error('OAuth status exceeds byte limit')
  const value: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
  )
  // oauth_token selects an environment token, which the closed trampoline env excludes.
  if (
    status !== 0 ||
    !object(value) ||
    value.loggedIn !== true ||
    value.authMethod !== 'claude.ai' ||
    value.configDirectory !== home
  )
    throw new Error('OAuth status selection/home unavailable or unsupported')
  return { loggedIn: true, method: 'claude.ai', home }
}
export function observeOAuth(executable: string, env: NodeJS.ProcessEnv): OAuthObservation {
  const path = realpathSync(executable)
  const home = realpathSync(env.CLAUDE_CONFIG_DIR || join(env.HOME || '', '.claude'))
  const identity = digest(regularBytes(path, 512 * 1024 * 1024))
  const version = spawnSync(path, ['--version'], { env, timeout: 15_000, maxBuffer: 64_000 })
  const versionText = new TextDecoder('utf-8', { fatal: true })
    .decode(version.stdout ?? Buffer.alloc(0))
    .trim()
  const matched = /^(\d+)\.(\d+)\.(\d+) \(Claude Code\)$/.exec(versionText)
  if (
    version.status !== 0 ||
    !matched ||
    Number(matched[1]) < 2 ||
    (Number(matched[1]) === 2 &&
      (Number(matched[2]) < 1 || (Number(matched[2]) === 1 && Number(matched[3]) < 268)))
  )
    throw new Error('OAuth status requires a supported official Claude version')
  const result = spawnSync(path, ['auth', 'status'], { env, timeout: 15_000, maxBuffer: 64_000 })
  const selection = parseOAuthStatus(result.stdout ?? Buffer.alloc(0), result.status, home)
  if (
    realpathSync(executable) !== path ||
    digest(regularBytes(path, 512 * 1024 * 1024)) !== identity
  )
    throw new Error('OAuth executable identity drifted')
  return { ...selection, executable: path, identity, version: versionText }
}

class RestrictedSink extends EventEmitter {
  writableEnded = false
  destroyed = false
  completed: Record<string, any> | undefined
  write(chunk: string): boolean {
    if (Buffer.byteLength(chunk) > 1_000_000) throw new Error('restricted response exceeds bound')
    const line = chunk.split('\n').find((line) => line.startsWith('data: '))
    if (line) {
      const event = JSON.parse(line.slice(6))
      if (event.type === 'response.completed') this.completed = event.response
    }
    return true
  }
  end(): void {
    this.writableEnded = true
    this.emit('close')
  }
}
type RestrictedResult = Pick<
  GateTurn,
  'sessionId' | 'responseId' | 'exitCode' | 'oauth' | 'model' | 'completedAt' | 'success' | 'status'
>
export async function restrictedTurn(
  root: string,
  project: string,
  signal: AbortSignal,
): Promise<RestrictedResult> {
  const config = configAt(root)
  const model = config.claude.models.find((model) => model.id === config.smoke.claudeModel)
  if (!model || !config.claude.cli) throw new Error('restricted CLI/model not configured')
  const env = trampolineEnv()
  const before = observeOAuth(config.claude.cli, env)
  const sink = new RestrictedSink()
  const stream = new ResponsesStream(sink, { model: model.id })
  const events: Array<Record<string, any>> = []
  const record = (event: string, fields: Record<string, unknown> = {}) => {
    if (events.length > 64) throw new Error('restricted event bound')
    events.push({ event, ...fields })
  }
  stream.begin()
  await runTrampolineTurn({
    stream,
    parsed: {
      ...parseCodexRequest({
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Reply with exactly the word PONG.' }],
          },
        ],
      }),
      threadId: null,
      codexTurnId: stream.id,
      fork: false,
    },
    model,
    effort: 'low',
    codexTools: [],
    claudePath: before.executable,
    trustedCwd: project,
    engineRoot: root,
    state: new TrampolineState(join(root, 'restricted-state.json')),
    log: { path: '', info: record, error: record },
    signal,
    ownedHelperGroup: true,
  })
  const after = observeOAuth(config.claude.cli, trampolineEnv())
  if (!sameOAuth(before, after)) throw new Error('restricted OAuth/executable/home drifted')
  const done = events.filter((e) => e.event === 'trampoline.done' && e.turnId === stream.id)
  const response = sink.completed
  const session = done[0]?.sessionId
  if (
    done.length !== 1 ||
    done[0]?.code !== 0 ||
    !SESSION.test(session) ||
    response?.id !== stream.id ||
    !successfulResponse(response)
  )
    throw new Error('restricted turn has no matched successful terminal/session result')
  return {
    sessionId: session,
    responseId: stream.id,
    exitCode: 0,
    oauth: { before, after },
    model: model.id,
    completedAt: new Date().toISOString(),
    success: true,
    status: 'completed',
  }
}
function phase(value: unknown, attempt: string, expected: string): Record<string, any> {
  if (
    !object(value) ||
    Buffer.byteLength(JSON.stringify(value)) > 16_000 ||
    value.attempt !== attempt ||
    value.phase !== expected ||
    Object.keys(value).some((key) => !['attempt', 'phase', 'result', 'ok'].includes(key))
  )
    throw new Error('invalid/replayed restricted helper phase')
  return value
}
function restrictedResult(value: unknown): RestrictedResult {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !==
      'completedAt,exitCode,model,oauth,responseId,sessionId,status,success' ||
    !SESSION.test(String(value.sessionId)) ||
    typeof value.responseId !== 'string' ||
    value.exitCode !== 0 ||
    value.status !== 'completed' ||
    value.success !== true ||
    !object(value.oauth) ||
    Object.keys(value.oauth).sort().join(',') !== 'after,before'
  )
    throw new Error('invalid restricted helper result')
  for (const side of ['before', 'after']) {
    const oauth = value.oauth[side]
    if (
      !object(oauth) ||
      Object.keys(oauth).sort().join(',') !== 'executable,home,identity,loggedIn,method,version' ||
      oauth.loggedIn !== true ||
      oauth.method !== 'claude.ai' ||
      !/^[a-f0-9]{64}$/.test(String(oauth.identity))
    )
      throw new Error('invalid restricted helper OAuth attribution')
  }
  return value as unknown as RestrictedResult
}
export async function runRestrictedProbe(ctx: PathContext, timeoutMs = 150_000): Promise<GateTurn> {
  ctx.verify()
  const root = probeRoot(ctx, 'restricted', ctx.request.mode)
  const script = join(ctx.root, 'lib', ctx.request.key.lib!, 'dist/src/smoke-claude.mjs')
  ctx.run.pending(ctx.cohort)
  const child = spawn(process.execPath, [script, ctx.request.attempt, root, ctx.deps.project], {
    env: ctx.deps.adapterEnv({ ANYENGINE_ROOT: root }),
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  let identity: ProbeIdentity | undefined
  let result: RestrictedResult | undefined
  let expected = 'before'
  let failure: unknown
  const close = new Promise<number | null>((done) => child.once('close', done))
  const onMessage = (value: unknown) => {
    try {
      const message = phase(value, ctx.request.attempt, expected)
      if (expected === 'before') {
        if (message.result !== undefined) throw new Error('unexpected helper result')
        identity = ctx.observe('before', {
          pid: child.pid!,
          role: 'trampoline',
          root,
          mode: ctx.request.mode,
        })
        ctx.cohort.push({ pid: identity.pid, processStart: identity.processStart })
        ctx.run.pending(ctx.cohort)
        expected = 'after'
      } else {
        if (!identity || !object(message.result))
          throw new Error('missing restricted helper result')
        identity = ctx.observe('after', identity)
        result = restrictedResult(message.result)
        expected = 'closed'
      }
      child.send({ attempt: ctx.request.attempt, phase: message.phase, ok: true })
    } catch (error) {
      failure = error
      child.kill('SIGTERM')
    }
  }
  child.on('message', onMessage)
  child.on('error', (error) => {
    failure = error
  })
  const timeout = setTimeout(() => {
    failure = new Error('restricted helper timeout')
    child.kill('SIGTERM')
  }, timeoutMs)
  const kill = setTimeout(() => {
    failure ??= new Error('restricted helper did not join')
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch (error) {
      failure ??= error
    }
  }, timeoutMs + Math.min(timeoutMs, 15_000))
  try {
    const code = await close
    if (failure || code !== 0 || expected !== 'closed' || !identity || !result)
      throw (
        failure ?? new Error('restricted helper failed/disconnected before ordered acknowledgments')
      )
    await joinDetachedGroup(child.pid!)
    ctx.observe('closed', identity)
    if (result.sessionId) ctx.sessions.add(result.sessionId)
    return {
      ...result,
      path: 'restricted-oauth',
      role: 'trampoline',
      probeId: identity.id,
      processPid: identity.pid,
      processStart: identity.processStart,
      effectiveMode: identity.mode,
      effectiveSettings: identity.settings,
      restricted: true,
      allowlisted: true,
    }
  } catch (error) {
    ctx.uncertain = true
    throw error
  } finally {
    clearTimeout(timeout)
    clearTimeout(kill)
    child.off('message', onMessage)
    await joinDetachedGroup(child.pid!, true)
  }
}
async function restrictedMain(): Promise<void> {
  const [attempt, root, project] = process.argv.slice(2)
  if (!attempt || !root || !project || !process.send)
    throw new Error('private restricted helper requires an owned channel')
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.once('disconnect', stop)
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const acknowledge = (name: string, result?: RestrictedResult) =>
    new Promise<void>((done, fail) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer)
        process.off('message', listener)
        abort.signal.removeEventListener('abort', cancel)
        error ? fail(error) : done()
      }
      const cancel = () => finish(new Error('restricted caller closed'))
      const listener = (value: unknown) => {
        try {
          if (phase(value, attempt, name).ok !== true) throw new Error('negative acknowledgment')
          finish()
        } catch (error) {
          finish(error)
        }
      }
      const timer = setTimeout(() => finish(new Error('restricted acknowledgment timeout')), 5000)
      process.on('message', listener)
      abort.signal.addEventListener('abort', cancel, { once: true })
      process.send!({ attempt, phase: name, ...(result ? { result } : {}) })
      if (abort.signal.aborted) cancel()
    })
  try {
    await acknowledge('before')
    const result = await restrictedTurn(root, project, abort.signal)
    await acknowledge('after', result)
  } finally {
    abort.abort()
    process.off('disconnect', stop)
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
    if (process.connected) process.disconnect!()
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  restrictedMain().catch(() => {
    process.exitCode = 1
  })
}
export function sameOAuth(before: OAuthObservation, after: OAuthObservation): boolean {
  return (
    before.loggedIn &&
    after.loggedIn &&
    before.method === after.method &&
    before.home === after.home &&
    before.executable === after.executable &&
    before.identity === after.identity &&
    before.version === after.version
  )
}
