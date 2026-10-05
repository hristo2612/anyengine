#!/usr/bin/env node
// Installed headless corroboration; native app rendering remains a separate observation.
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { receiptFields } from '../dist/src/smoke-evidence.mjs'
import {
  AcceptanceThreads,
  acceptanceFiles,
  FANOUT_PROMPT,
  verifyFanout,
  verifyUpstreamTurn,
} from './lib/acceptance-evidence.mjs'
import { settleAcceptance } from './lib/acceptance-lifecycle.mjs'
import { scratchNextTo } from './lib/claude-scratch.mjs'
import { probeProcesses } from './lib/probe-processes.mjs'

export { AcceptanceThreads, acceptanceFiles, FANOUT_PROMPT, verifyFanout }

const PONG = 'Reply with exactly the word PONG.'
const one = (rows, label) => {
  if (rows.length !== 1) throw new Error(`acceptance expected one ${label}`)
  return rows[0]
}
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512

async function installed(root) {
  const lib = realpathSync(join(root, 'lib/current'))
  if (resolve(dirname(fileURLToPath(import.meta.url)), '..') !== lib)
    throw new Error('run acceptance from the verified installed lib/current')
  const modules = await Promise.all(
    [
      'smoke',
      'smoke-client',
      'smoke-probes',
      'smoke-claude',
      'smoke-evidence',
      'control-system',
      'control-postflight-evidence',
      'control-status-evidence',
      'control-layer-state',
      'degraded',
      'router-link',
    ].map((name) => import(pathToFileURL(join(lib, 'dist/src', `${name}.mjs`)).href)),
  )
  const api = Object.assign({}, ...modules)
  const system = api.realSystem()
  const deps = api.realSmokeDeps(root, api.realFlipDeps(system, root, lib))
  return { lib, api, deps, system, ...api.admission(root, deps) }
}

export async function switchWork(ctx, model, parentId) {
  const { check, api, frozen, project, client, owner, events } = ctx
  const turns = []
  for (const selected of [model, 'opus', model]) {
    if (turns.length === 2)
      await client.request('thread/settings/update', { threadId: parentId, model: selected })
    const before = events().length
    const turn = await client.turn(
      parentId,
      PONG,
      120_000,
      turns.length === 1 ? selected : undefined,
    )
    const terminal = await client.terminal(
      parentId,
      turn.turnId,
      selected,
      project,
      undefined,
      true,
    )
    if (turn.threadId !== parentId || !api.successfulPong(turn) || !terminal.success)
      throw new Error('acceptance switched turn failed')
    if (selected === 'opus' && frozen.mode === 'agent')
      api.requirePtySession({ identity: owner, events }, parentId, turn.turnId, selected)
    if (selected !== 'opus') {
      verifyUpstreamTurn({
        events: events().slice(before),
        owner,
        threadId: parentId,
        turnId: turn.turnId,
      })
    }
    turns.push({
      threadId: parentId,
      turnId: turn.turnId,
      model: selected,
      status: turn.status,
    })
  }
  const receipt = switchReceipt(ctx, parentId, turns[1].turnId)
  return { check, turns, receipt, gui: 'pending separate native observation' }
}
function switchReceipt(ctx, threadId, turnId) {
  const { frozen, owner, events } = ctx
  if (frozen.mode === 'agent') {
    const rehome = events().find(
      (e) => e.event === 'thread.rehomed' && e.pid === owner.pid && e.threadId === threadId,
    )
    if (!rehome) throw new Error('acceptance same-thread rehome absent')
    return receiptFields(rehome)
  }
  if (frozen.mode !== 'model') throw new Error('acceptance switch mode unavailable')
  const socket = one(
    events().filter((e) => e.event === 'claim.listen' && e.pid === owner.pid),
    'switch owner',
  ).socketPath
  const done = one(
    events(ctx.routerLog).filter(
      (e) =>
        e.event === 'trampoline.done' &&
        e.threadId === threadId &&
        e.turnId === turnId &&
        e.model === 'opus',
    ),
    'switch trampoline',
  )
  if (
    socket !== join(ctx.root, 'run', `claim-${owner.pid}.sock`) ||
    done.owner !== socket ||
    done.success !== true ||
    done.code !== 0 ||
    !id(done.sessionId)
  )
    throw new Error('acceptance same-thread trampoline failed or owner mismatch')
  return receiptFields(done)
}
async function fanoutWork(ctx, model, parentId) {
  const {
    check,
    root,
    api,
    config,
    frozen,
    project,
    client,
    threads,
    owner,
    events,
    routerLog,
    link,
    collect,
  } = ctx
  const path = check === 'fanout7' ? 'native' : 'bridge'
  if (link.fanout !== path || (path === 'bridge' && config.router.multiAgentV1 !== false))
    throw new Error('acceptance configured fanout path mismatch')
  const parent = await client.turn(parentId, FANOUT_PROMPT, 600_000)
  if (
    (await client.terminal(parentId, parent.turnId, model, project, undefined, true)).status !==
    'completed'
  )
    throw new Error('acceptance stored parent terminal failed')
  collect()
  const children = []
  for (const [childId] of threads.owned) {
    if (childId === parentId) continue
    const { thread } = await client.request('thread/read', {
      threadId: childId,
      includeTurns: true,
    })
    const terminal = one(
      (thread.turns ?? []).filter((t) => t.status === 'completed'),
      'child terminal turn',
    )
    if (thread.turns.length !== 1) throw new Error('acceptance unexpected child turn history')
    const spawn = parent.items.find(
      (i) => i.tool === 'spawnAgent' && i.receiverThreadIds?.includes(childId),
    )
    const bridge = events().find(
      (e) => e.event === 'bridge.spawnSubagent' && e.childThreadId === childId,
    )
    const selected = spawn?.model ?? bridge?.model ?? thread.model
    await client.terminal(
      childId,
      terminal.id,
      selected,
      project,
      parentId,
      threads.owned.get(childId) === 'persistent',
    )
    if (selected === 'opus' && (path === 'bridge' || frozen.mode === 'agent'))
      api.requirePtySession({ identity: owner, events }, childId, terminal.id, selected)
    children.push({
      threadId: childId,
      parentThreadId:
        thread.parentThreadId ??
        thread.source?.subAgent?.thread_spawn?.parent_thread_id ??
        thread.source?.subagent?.thread_spawn?.parent_thread_id,
      turnId: terminal.id,
      model: thread.model ?? selected,
      cwd: thread.cwd,
      kind: threads.owned.get(childId),
      ephemeral: thread.ephemeral,
      status: terminal.status,
      error: terminal.error,
      text: (terminal.items ?? [])
        .filter((i) => i.type === 'agentMessage')
        .map((i) => i.text)
        .join('\n'),
    })
  }
  const socketPath = one(
    events().filter((e) => e.event === 'claim.listen' && e.pid === owner.pid),
    'claim listener',
  ).socketPath
  if (socketPath !== join(root, 'run', `claim-${owner.pid}.sock`))
    throw new Error('acceptance claim owner path mismatch')
  return {
    ...verifyFanout({
      path,
      mode: frozen.mode,
      parent,
      children,
      events: events(),
      routerEvents: events(routerLog),
      owner: { ...owner, socketPath },
      model,
      project,
    }),
    ...frozen,
    authority: 'corroboration; installed smoke owns native proof',
  }
}

export async function checkWork(ctx) {
  const { check, project, client, threads, events, routerLog, link } = ctx
  let result
  const models = await client.request('model/list', { includeHidden: true, limit: 100 })
  const ids = (models.data ?? []).map((m) => m.model ?? m.id)
  if (check === 'picker') {
    if (
      !['opus', 'sonnet', 'haiku'].every((id) => ids.includes(id)) ||
      !events(routerLog).some((e) => e.event === 'models.served' && e.claude === 3)
    )
      throw new Error('acceptance router Claude picker catalog absent')
    result = { check, ids, router: link.fanout, gui: 'pending separate native observation' }
  } else {
    const model =
      models.data.find((m) => m.isDefault === true && (m.model ?? m.id).startsWith('gpt-'))
        ?.model ?? models.data.find((m) => m.isDefault === true && m.id?.startsWith('gpt-'))?.id
    if (!model) throw new Error('acceptance default GPT unavailable')
    const value = await threads.start({
      model,
      cwd: project,
      ephemeral: false,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    })
    const parentId = value.thread.id
    result =
      check === 'switch'
        ? await switchWork(ctx, model, parentId)
        : await fanoutWork(ctx, model, parentId)
  }
  return result
}

export async function runAcceptance(check) {
  if (!['picker', 'switch', 'fanout7', 'bridge-fanout'].includes(check))
    throw new Error('usage: probe-acceptance.mjs picker|switch|fanout7|bridge-fanout')
  const root = resolve(process.env.ANYENGINE_ROOT || join(homedir(), '.anyengine'))
  const { lib, api, deps, system, snapshot, verify } = await installed(root)
  const config = snapshot.config
  const frozen = verify()
  const project = deps.project
  mkdirSync(project, { recursive: true })
  if (!lstatSync(project).isDirectory() || realpathSync(project) !== project)
    throw new Error('acceptance project must be canonical and direct')
  const work = scratchNextTo(project, '.anyengine-accept-', 'acceptance probe')
  const workStamp = lstatSync(work)
  const processes = probeProcesses(api, system, work)
  const debug = join(work, 'debug.jsonl')
  writeFileSync(debug, '', { flag: 'wx', mode: 0o600 })
  const routerLog = join(root, 'logs/router.jsonl')
  const begin = Date.now()
  const pins = new Map()
  const events = (path = debug) => {
    const stat = api.statAt(path)
    if (!stat) {
      if (path === debug || pins.has(path)) throw new Error('acceptance log missing')
      return []
    }
    const bytes = api.regularBytes(path, 8_000_000)
    const old = pins.get(path)
    if (
      old &&
      (stat.ino !== old.ino ||
        stat.dev !== old.dev ||
        !bytes.subarray(0, old.bytes.length).equals(old.bytes))
    )
      throw new Error('acceptance log lost earlier evidence')
    pins.set(path, { ino: stat.ino, dev: stat.dev, bytes })
    return api.strictEvents(path).filter((e) => path === debug || Date.parse(e.ts) >= begin)
  }
  let client,
    threads,
    owner,
    cleanupFiles = () => {},
    result,
    error,
    settled = false
  const sessions = new Set()
  const stop = () => {
    void client?.close().catch(() => {})
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop)
  const collect = () => {
    const own = events()
    for (const e of own)
      if (e.event === 'bridge.spawnSubagent' && threads.owned.has(e.parentThreadId)) {
        if (!id(e.childThreadId)) throw new Error('acceptance bridge child identity unavailable')
        threads.owned.set(e.childThreadId, e.model === 'opus' ? 'local' : 'persistent')
      }
    for (const e of own)
      if (
        ['anyengine.session', 'claim.session'].includes(e.event) &&
        (!threads.owned.has(e.threadId) || !id(e.sessionId))
      )
        throw new Error('acceptance producer session ownership unavailable')
    const produced = [...own, ...events(routerLog)].filter(
      (e) =>
        ['anyengine.session', 'claim.session', 'trampoline.session'].includes(e.event) &&
        threads.owned.has(e.threadId),
    )
    produced.push(
      ...own.filter(
        (e) => e.event === 'claim.done' && threads.owned.has(e.threadId) && id(e.sessionId),
      ),
    )
    produced.push(
      ...events(routerLog).filter(
        (e) => e.event === 'trampoline.done' && threads.owned.has(e.threadId) && id(e.sessionId),
      ),
    )
    for (const e of produced) {
      if (!id(e.sessionId)) throw new Error('acceptance owned session identity unavailable')
      sessions.add(e.sessionId)
    }
  }
  const identity = () => {
    const actual = one(
      system.processes().filter((p) => p.pid === client.pid),
      'live adapter',
    )
    if (
      actual.ppid !== process.pid ||
      !actual.command.includes(join(lib, 'dist/src/adapter.mjs')) ||
      (owner && actual.processStart !== owner.processStart)
    )
      throw new Error('acceptance adapter identity drift')
    return actual
  }

  try {
    events()
    events(routerLog)
    if (['fanout7', 'bridge-fanout'].includes(check)) cleanupFiles = acceptanceFiles(project)
    processes.pending()
    client = api.AppServerClient.launch(
      process.execPath,
      [deps.adapter, 'app-server', '-c', 'mcp_servers={}', '-c', 'notify=[]'],
      deps.adapterEnv({
        CODEX_HOME: deps.codexHome,
        ANYENGINE_HOME: join(work, 'adapter'),
        ANYENGINE_DEBUG_LOG: debug,
        ANYENGINE_ROOT: root,
        ANYENGINE_PTY_STATE_DIR: join(work, 'pty'),
        ANYENGINE_REAL_CODEX: snapshot.bundled,
        ANYENGINE_CLI: config.claude.cli || undefined,
      }),
    )
    threads = new AcceptanceThreads(client)
    processes.add(client.pid)
    await client.initialize()
    owner = identity()
    const link = one(
      events().filter((e) => e.event === 'router.link' && e.pid === owner.pid),
      'router attachment',
    )
    if (!link.attached) throw new Error('acceptance router not attached')
    const launch = one(
      events().filter((e) => e.event === 'codex.upstream.spawn'),
      'vendor launch',
    )
    const vendor = one(
      system.processes().filter((p) => p.pid === launch.pid && p.ppid === owner.pid),
      'owned vendor',
    )
    if (
      launch.binary !== snapshot.bundled ||
      !vendor.command.includes(snapshot.bundled) ||
      api.appOpenaiBaseUrl(launch.args) !== link.url ||
      !vendor.command.includes(link.url)
    )
      throw new Error('acceptance vendor/router identity mismatch')
    const health = await api.readStatusHealth(
      `${link.url.replace(/\/backend-api\/codex\/?$/, '')}/health`,
    )
    if (
      health.version !== frozen.key.lib ||
      !api.sameKey(health.proofKey, frozen.key) ||
      health.mode !== frozen.mode ||
      health.fanout.path !== link.fanout ||
      (link.fanout === 'native' && !api.isProven(root, 'native-fanout', frozen.key))
    )
      throw new Error('acceptance current full-key/mode eligibility unavailable')
    result = await checkWork({
      check,
      root,
      api,
      config,
      frozen,
      project,
      client,
      threads,
      owner,
      events,
      routerLog,
      link,
      collect,
    })
    identity()
    verify()
    settled = true
  } catch (failure) {
    error = failure
  } finally {
    try {
      const cleanup = await settleAcceptance({
        client,
        threads,
        processes,
        collect,
        cleanupFiles,
        verify,
        work,
        stamp: workStamp,
        settled,
        error,
        pruneSessions: () => {
          const pruned = api.pruneOwnSessions(
            deps.claudeHome,
            project,
            [...sessions],
            process.env.CLAUDE_CONFIG_DIR || join(deps.claudeHome, '.claude'),
          )
          if (pruned.missing.length) throw new Error('acceptance owned session cleanup unknown')
        },
      })
      result = { ...result, ...frozen, cleanup }
    } catch (failure) {
      error = failure
      console.error(`acceptance evidence retained at ${work}`)
    }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop)
  }
  if (error) throw error
  return result
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  runAcceptance(process.argv[2])
    .then((result) => console.log(`ok ${JSON.stringify(result)}`))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
