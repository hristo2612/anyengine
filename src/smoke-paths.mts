// Each path returns matched terminal work, never a delta or an attempted spawn.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { routerHealthUrl } from './anyengine-config.mjs'
import { ClaimServer } from './claim-server.mjs'
import { sameKey } from './degraded.mjs'
import { STRICTEST_POSTURE } from './posture.mjs'
import { isAnyEngineEntry } from './router-catalog.mjs'
import { buildRouterRuntime } from './router-hooks.mjs'
import { appOpenaiBaseUrl } from './router-link.mjs'
import { type RunningRouter, startRouter } from './router-server.mjs'
import type { PathContext, PathResult, SmokePathName } from './smoke.mjs'
import { runClaudeCodeSmoke } from './smoke-claude-code.mjs'
import {
  responseText,
  routerCleanupLog,
  type SmokeTurn,
  successfulPong,
  successfulResponse,
} from './smoke-client.mjs'
import { type GateTurn, type NativeReceipt, receiptFields } from './smoke-evidence.mjs'
import {
  type AdapterProbe,
  probeRoot,
  requirePtySession,
  strictEvents,
  withAdapter,
} from './smoke-probes.mjs'
import { startProbeThread } from './smoke-starts.mjs'

export type { PathContext } from './smoke.mjs'
export { startProbeThread }

const PONG = 'Reply with exactly the word PONG.'
const one = <T,>(values: T[], label: string): T => {
  if (values.length !== 1) throw new Error(`expected one correlated ${label}`)
  return values[0]!
}
export async function gptModel(probe: AdapterProbe, ctx: PathContext): Promise<string> {
  const result = await probe.client.request('model/list', {})
  if (!Array.isArray(result.data)) throw new Error('GPT model catalog unavailable')
  const models = result.data.filter(
    (entry: any) =>
      !isAnyEngineEntry(entry) &&
      typeof entry.model === 'string' &&
      entry.model.startsWith('gpt-') &&
      entry.hidden !== true,
  )
  const selected = ctx.config.smoke.gptModel
    ? models.find((entry: any) => entry.model === ctx.config.smoke.gptModel)
    : models.at(-1)
  if (!selected) throw new Error('configured GPT smoke model unavailable')
  return selected.model
}
export function readTerminal(
  probe: AdapterProbe,
  ctx: PathContext,
  threadId: string,
  turnId: string,
  model: string,
  parent?: string,
) {
  return probe.client.terminal(
    threadId,
    turnId,
    model,
    ctx.deps.project,
    parent,
    probe.threads.get(threadId) === 'persistent',
  )
}

function gateTurn(
  probe: AdapterProbe,
  work: SmokeTurn,
  model: string,
  path: GateTurn['path'],
): GateTurn {
  const p = probe.identity
  return {
    path,
    probeId: p.id,
    role: p.role,
    processPid: p.pid,
    processStart: p.processStart,
    threadId: work.threadId,
    turnId: work.turnId,
    model,
    completedAt: work.completedAt,
    status: work.status,
    success: successfulPong(work),
    effectiveMode: p.mode,
    effectiveSettings: p.settings,
  }
}
function attached(probe: AdapterProbe, ctx: PathContext): boolean {
  const link = one(
    probe
      .events()
      .filter((event) => event.event === 'router.link' && event.pid === probe.identity.pid),
    'router link',
  )
  const spawn = one(
    probe.events().filter((event) => event.event === 'codex.upstream.spawn'),
    'bundled child launch',
  )
  const child = ctx.system
    .processes()
    .find((p) => p.pid === spawn.pid && p.ppid === probe.identity.pid)
  if (
    !child ||
    spawn.binary !== ctx.snapshot.bundled ||
    !Array.isArray(spawn.args) ||
    !child.command.includes(ctx.snapshot.bundled!)
  )
    throw new Error('bundled child launch not independently observed')
  const base = appOpenaiBaseUrl(spawn.args)
  if (link.attached === true) {
    if (!base || base !== link.url || !child.command.includes(base))
      throw new Error('router attachment/argv mismatch')
  } else if (link.attached !== false || base !== null || /openai_base_url\s*=/.test(child.command))
    throw new Error('direct child carries a router override')
  return link.attached
}
async function gptAttempt(ctx: PathContext, direct: boolean): Promise<PathResult> {
  return withAdapter(ctx, direct ? 'direct' : 'agent', 'agent', async (probe) => {
    const model = await gptModel(probe, ctx)
    const linked = attached(probe, ctx)
    const thread = await startProbeThread(probe, ctx, model)
    let work: SmokeTurn
    try {
      work = await probe.client.turn(thread, PONG)
    } catch {
      return {
        ok: false,
        ms: 0,
        detail: `${linked ? 'router' : 'direct'} GPT terminal request failed`,
        routed: { success: false, attached: linked },
      }
    }
    const ok = successfulPong(work)
    const turn = gateTurn(probe, work, model, 'gpt')
    turn.transport = linked ? 'router' : 'adapter'
    return {
      ok,
      ms: 0,
      detail: `${linked ? 'router' : 'direct'} GPT ${work.status}; final PONG ${ok}`,
      turn,
      routed: { success: ok, attached: linked },
    }
  })
}
async function gpt(ctx: PathContext): Promise<PathResult> {
  const result = await gptAttempt(ctx, false)
  if (result.ok === false && result.routed?.attached) {
    const direct = await gptAttempt(ctx, true)
    if (direct.routed) result.direct = direct.routed
    result.detail += `; ${direct.detail}`
  }
  return result
}
async function agent(ctx: PathContext): Promise<PathResult> {
  return withAdapter(ctx, 'agent', 'agent', async (probe) => {
    const model = ctx.request.models.claude
    const work = await probe.client.turn(await startProbeThread(probe, ctx, model, true), PONG)
    requirePtySession(probe, work.threadId, work.turnId, model)
    const turn = { ...gateTurn(probe, work, model, 'claude-pty'), operatorConfig: true }
    return {
      ok: turn.success,
      ms: 0,
      detail: `Claude PTY ${work.status}; final PONG ${turn.success}`,
      turn,
    }
  })
}
async function bridge(ctx: PathContext): Promise<PathResult> {
  return withAdapter(ctx, 'agent', 'agent', async (probe) => {
    const gpt = await gptModel(probe, ctx)
    const model = ctx.request.models.claude
    const thread = await startProbeThread(probe, ctx, model, true)
    const work = await probe.client.turn(
      thread,
      `Use the anyengine spawn_subagents tool to start exactly one sub-agent with model "${gpt}" whose task is: ${PONG} Wait for it, then reply with its answer only.`,
      300_000,
    )
    requirePtySession(probe, work.threadId, work.turnId, model)
    const event = one(
      probe
        .events()
        .filter(
          (event) =>
            event.event === 'bridge.subagent.done' &&
            event.pid === probe.identity.pid &&
            event.parentThreadId === thread &&
            event.parentTurnId === work.turnId,
        ),
      'bridge terminal event',
    )
    probe.threads.set(event.threadId, 'persistent')
    const selected = one(
      probe
        .events()
        .filter(
          (e) =>
            e.event === 'bridge.thread.started' &&
            e.pid === probe.identity.pid &&
            e.threadId === event.threadId,
        ),
      'bridge child selection',
    )
    if (selected.model !== gpt) throw new Error('bridge child selected model mismatch')
    const parent = await readTerminal(probe, ctx, thread, work.turnId, model)
    const child = await readTerminal(probe, ctx, event.threadId, event.turnId, gpt)
    const turn: GateTurn = {
      ...gateTurn(probe, work, model, 'bridge'),
      operatorConfig: true,
      parent,
      child,
      bridge: {
        parentThreadId: thread,
        parentTurnId: work.turnId,
        threadId: event.threadId,
        turnId: event.turnId,
        model: event.model,
        success: event.success,
        status: event.status,
      },
    }
    const ok =
      successfulPong(work) &&
      parent.success &&
      child.success &&
      event.model === gpt &&
      event.success === true &&
      event.status === 'completed'
    return { ok, ms: 0, detail: `bridge parent/child terminal correlation ${ok}`, turn }
  })
}
async function native(ctx: PathContext): Promise<PathResult> {
  if (!ctx.config.router.multiAgentV1)
    return { ok: null, ms: 0, detail: 'not applicable: native fan-out disabled' }
  return withAdapter(ctx, 'native', ctx.request.mode, async (probe) => {
    if (
      !attached(probe, ctx) ||
      !probe.events().some((e) => e.event === 'router.link' && e.fanout === 'native')
    )
      throw new Error('native probe did not attach its private proven-bootstrap router')
    const model = await gptModel(probe, ctx)
    const thread = await startProbeThread(probe, ctx, model, false, true)
    const work = await probe.client.turn(
      thread,
      `Use spawn_agent to start exactly one sub-agent with model "${ctx.request.models.claude}" whose task is: ${PONG} Wait for it, then reply with its answer only.`,
      300_000,
    )
    const spawn = one(
      work.items.filter(
        (item) => item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent',
      ),
      'native spawn',
    )
    if (
      spawn.status !== 'completed' ||
      spawn.senderThreadId !== thread ||
      spawn.model !== ctx.request.models.claude ||
      !Array.isArray(spawn.receiverThreadIds) ||
      spawn.receiverThreadIds.length !== 1
    )
      throw new Error('native spawn result mismatch')
    const childId = spawn.receiverThreadIds[0]
    probe.threads.set(childId, 'persistent')
    const completion = one(
      probe
        .routerEvents()
        .filter(
          (event) =>
            event.event === (ctx.request.mode === 'agent' ? 'claim.done' : 'trampoline.done') &&
            event.threadId === childId &&
            event.parentThreadId === thread &&
            event.parentTurnId === work.turnId,
        ),
      'native router terminal receipt',
    )
    const parent = await readTerminal(probe, ctx, thread, work.turnId, model)
    const child = await readTerminal(
      probe,
      ctx,
      childId,
      completion.turnId,
      ctx.request.models.claude,
      thread,
    )
    const claim =
      ctx.request.mode === 'agent'
        ? one(
            probe
              .events()
              .filter(
                (e) =>
                  e.event === 'claim.done' &&
                  e.pid === probe.identity.pid &&
                  e.threadId === childId &&
                  e.turnId === child.turnId,
              ),
            'actual adapter claim',
          )
        : undefined
    if (claim) requirePtySession(probe, childId, child.turnId, ctx.request.models.claude)
    const native: NativeReceipt = {
      version: 1,
      kind: 'anyengine-native-fanout',
      codeIdentity: ctx.request.codeIdentity,
      key: ctx.request.key,
      mode: ctx.request.mode,
      attempt: ctx.request.attempt,
      startedAt: ctx.request.startedAt,
      completedAt: ctx.system.now().toISOString(),
      effectiveSettings: probe.identity.settings,
      parent,
      child,
      owner: {
        pid: probe.identity.pid,
        processStart: probe.identity.processStart,
        root: probe.root,
        mode: probe.identity.mode,
        settings: probe.identity.settings,
        after: false,
        closed: false,
      },
      spawn: receiptFields(spawn),
      completion: receiptFields(completion),
      ...(claim ? { claim: receiptFields(claim) } : {}),
      cleanup: { threads: false, sessions: false, processes: false },
    }
    return {
      ok: successfulPong(work) && parent.success && child.success,
      ms: 0,
      detail: 'native configured-mode parent/child matched terminal work',
      native,
    }
  })
}
async function router(ctx: PathContext): Promise<PathResult> {
  if (!ctx.config.router.enabled)
    return { ok: null, ms: 0, detail: 'not applicable: router disabled' }
  const response = await fetch(routerHealthUrl(ctx.config), { signal: AbortSignal.timeout(2000) })
  const value: any = JSON.parse(await responseText(response, 64_000))
  const ok =
    response.ok &&
    value.ok === true &&
    value.version === ctx.request.key.lib &&
    value.mode === ctx.request.mode &&
    sameKey(value.proofKey, ctx.request.key) &&
    value.faults?.hookErrors === 0 &&
    value.faults?.unhandledRejections === 0
  return { ok, ms: 0, detail: `router health/frozen identity ${ok}` }
}
function userInput(text: string) {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
}
async function model(ctx: PathContext): Promise<PathResult> {
  if (ctx.request.mode === 'agent')
    return { ok: null, ms: 0, detail: 'not applicable: mode is agent' }
  ctx.verify()
  const root = probeRoot(ctx, 'model', 'model')
  const threadId = randomUUID()
  const turnId = randomUUID()
  const thread = {
    threadId,
    parentThreadId: null,
    parentCwd: null,
    cwd: ctx.deps.project,
    model: ctx.request.models.claude,
    posture: STRICTEST_POSTURE,
  }
  const runtime = {
    async runTurn() {
      throw new Error('stand-in ownership cannot execute a claimed turn')
    },
    async interrupt() {},
    async steer() {},
    async stop() {},
  }
  const claims = new ClaimServer(
    {
      claimThread: (id) => (id === threadId ? thread : null),
      waitForClaimThread: async (id) => (id === threadId ? thread : null),
      knowsThread: (id) => id === threadId,
      mcpServersFor: () => null,
      runtime,
    },
    { runDir: join(root, 'run'), graceMs: 0, idleReleaseMs: 60_000 },
  )
  const logPath = join(root, 'model.jsonl')
  const lifecycle = routerCleanupLog(ctx, logPath, () => strictEvents(logPath))
  const log = lifecycle.log
  let router: RunningRouter | undefined
  const cleanup = async () => {
    try {
      const closed = await Promise.allSettled([router?.close(), claims.stop()])
      const failed = closed.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      lifecycle.joined()
      for (const event of strictEvents(log.path))
        if (
          event.event === 'trampoline.session' &&
          event.threadId === threadId &&
          event.turnId === turnId
        )
          ctx.sessions.add(event.sessionId)
      ctx.verify()
    } catch (error) {
      ctx.uncertain = true
      throw error
    }
  }
  ctx.run.pending(ctx.cohort)
  try {
    await claims.start()
    router = await startRouter({ root, port: 0, log, hooks: buildRouterRuntime(root, log).hooks })
    const response = await fetch(`${router.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'thread-id': threadId,
        'x-codex-turn-metadata': JSON.stringify({ turn_id: turnId }),
      },
      body: JSON.stringify({
        model: ctx.request.models.claude,
        tools: [],
        input: [
          userInput(
            `<environment_context>\n<cwd>${ctx.deps.project}</cwd>\n</environment_context>`,
          ),
          userInput(PONG),
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    })
    const text = await responseText(response, 1_000_000)
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
    const completed = one(
      events.filter((event) => event.type === 'response.completed'),
      'model response',
    ).response
    const done = one(
      strictEvents(log.path).filter(
        (event) =>
          event.event === 'trampoline.done' &&
          event.threadId === threadId &&
          event.turnId === turnId &&
          event.model === ctx.request.models.claude &&
          event.owner === claims.socketPath &&
          event.success === true &&
          event.code === 0,
      ),
      'owned model terminal',
    )
    const ok = successfulResponse(completed) && typeof done.sessionId === 'string'
    return { ok, ms: 0, detail: `stand-in ownership model diagnostic ${ok}; no native proof` }
  } finally {
    await cleanup()
  }
}
export const PATH_RUNNERS: Record<SmokePathName, (ctx: PathContext) => Promise<PathResult>> = {
  router,
  gpt,
  'claude-agent': agent,
  'native-fanout': native,
  bridge,
  'claude-model': model,
  'claude-code-gpt': runClaudeCodeSmoke,
}
