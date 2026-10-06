// Which features the router daemon runs with. Each task that adds a face of
// the router (catalog, WebSocket relay, Claude turns) registers its hook here,
// so startRouter stays testable with any subset.
import { join } from 'node:path'
import { enginePaths, loadConfig } from './anyengine-config.mjs'
import { createRouterBroker } from './broker-runtime.mjs'
import { createGptCatalogs, type GptCatalogs } from './claude-catalog.mjs'
import { proofKey } from './degraded.mjs'
import { DesktopClaudeRuntime } from './desktop-claude-runtime.mjs'
import { CatalogCache, modelsHook } from './router-catalog.mjs'
import {
  AgentClaudeTurns,
  ModelClaudeTurns,
  OwnedClaudeTurns,
  pickClaudeTurns,
} from './router-claude.mjs'
import { FanoutMonitor, writeRouterStatus } from './router-fanout.mjs'
import type { RouterLog } from './router-log.mjs'
import { messagesHook } from './router-messages.mjs'
import { type RouterContext, type RouterHooks, routerVersion } from './router-server.mjs'
import { type ClaudeTurns, claudeHttpHook } from './router-turns.mjs'
import { wsUpgradeHook } from './router-ws.mjs'

export interface RouterRuntime {
  hooks: RouterHooks
  fanout: FanoutMonitor
  claude: { agent: ClaudeTurns | null; model: ClaudeTurns | null }
  gpt: ReturnType<typeof createRouterBroker>
  gptCatalogs: GptCatalogs
}

export function buildRouterRuntime(root: string, log: RouterLog): RouterRuntime {
  const config = () => loadConfig(root)
  const startedAt = new Date().toISOString()
  const record = () =>
    writeRouterStatus(root, {
      pid: process.pid,
      version: routerVersion(),
      port: config().router.port,
      startedAt,
      mode: config().modes.codexClaude,
      fanout: fanout.state,
      writtenAt: new Date().toISOString(),
    })
  const fanout = new FanoutMonitor(config, root, (state) => {
    log.info('fanout.changed', { ...state })
    record()
  })
  record()
  const cache = new CatalogCache(join(enginePaths(root).router, 'catalogs.json'))
  const runDir = enginePaths(root).run
  const model = new ModelClaudeTurns(root, log)
  const desktopClaude = new DesktopClaudeRuntime()
  const gpt = createRouterBroker({ root })
  const gptCatalogs = createGptCatalogs({
    root,
    broker: gpt.broker,
    owner: gpt.owner,
    upstream: new URL(config().router.upstream),
  })
  const claude = {
    agent: new AgentClaudeTurns(runDir) as ClaudeTurns | null,
    model: model as ClaudeTurns | null,
  }
  const turns = (ctx: RouterContext): ClaudeTurns | null => {
    const inner = pickClaudeTurns(ctx, claude)
    return inner
      ? new OwnedClaudeTurns(
          inner,
          runDir,
          (claimed) => fanout.observeClaim(claimed),
          (thread, owner, request, mode) => model.prepare(thread, owner, request, mode),
          (thread, request) => model.admit(thread, request),
        )
      : null
  }
  return {
    fanout,
    claude,
    gpt,
    gptCatalogs,
    hooks: {
      close: async () => {
        gptCatalogs.invalidate()
        await gpt.close()
        await model.close()
        await desktopClaude.close()
      },
      models: modelsHook(cache, fanout),
      messages: messagesHook({
        broker: gpt.broker,
        admission: gpt.admission,
        catalogs: gptCatalogs,
        desktopClaude: { runtime: desktopClaude, root },
      }),
      upgrade: wsUpgradeHook({ fanout, turns }),
      claudeHttp: claudeHttpHook(turns),
      status: (ctx) => ({
        mode: ctx.config().modes.codexClaude,
        fanout: fanout.state,
        proofKey: proofKey(root, { config: ctx.config }),
        gpt: { ...gpt.broker.status(), activeRequests: gpt.activeRequests() },
      }),
      observeGptBody: (body) => fanout.observeGptBody(body),
      observeUpstreamError: (status, text) => fanout.observeUpstreamError(status, text),
    },
  }
}

export function buildRouterHooks(root: string, log: RouterLog): RouterHooks {
  return buildRouterRuntime(root, log).hooks
}
