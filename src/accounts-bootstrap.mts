import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { accountControl } from './accounts-control.mjs'
import { createAccountFamily } from './accounts-family.mjs'
import { entry } from './accounts-files.mjs'
import { finishTransition } from './accounts-journal.mjs'
import type { AccountLedger } from './accounts-ledger.mjs'
import { prepareOverlay, verifyOverlay } from './accounts-overlay.mjs'
import { reconcileOverlay } from './accounts-overlay-reconcile.mjs'
import { processAlive } from './accounts-processes.mjs'
import { accountOwner, retireExitedParticipants } from './accounts-rotation.mjs'
import type { OwnerToken, Participant } from './accounts-types.mjs'
import { CodexUpstream } from './codex-upstream.mjs'
import { asRecord, idOf } from './rpc-shape.mjs'

export function officialCodexVersion(binary: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(binary, ['--version'], {
    env,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 4096,
  })
  const match = /^codex-cli\s+(\d+(?:\.\d+)+(?:[^\s]*)?)\s*$/.exec(result.stdout ?? '')
  if (result.status !== 0 || result.error || !match?.[1])
    throw new Error('Official Codex version unknown')
  return match[1]
}
export function requireAccountBootstrap(ledger: AccountLedger, version: string): void {
  const table = ledger.metadata.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_bootstrap'")
    .get()
  if (
    !table ||
    !ledger.metadata.db
      .prepare('SELECT 1 FROM account_bootstrap WHERE version=? AND completed>0')
      .get(version)
  )
    throw new Error(
      'Canonical state bootstrap is required for this Codex version; run anyengine on',
    )
}

const pause = () => new Promise((done) => setTimeout(done, 25))
async function restart(ledger: AccountLedger, participants: Participant[]): Promise<void> {
  for (const p of participants) {
    if (processAlive(p.process) === 'dead') continue
    await accountControl(p, { command: 'restart', generation: ledger.state().generation })
  }
}
async function initialized(
  ledger: AccountLedger,
  owner: OwnerToken,
  binary: string,
  env: NodeJS.ProcessEnv,
  home: string,
  warm: boolean,
): Promise<void> {
  const paths = ledger.metadata.paths
  const participant: Participant = {
    id: owner.transaction,
    kind: 'maintenance',
    process: owner.process,
    socket: '',
    generation: ledger.state().generation,
  }
  const family = createAccountFamily(ledger, participant, {
    account: warm ? ledger.registry().home : ledger.state().active,
    purpose: 'bootstrap',
    owner,
  })
  const upstream = new CodexUpstream({
    binary,
    args: [
      '-c',
      'openai_base_url="https://chatgpt.com/backend-api/codex"',
      '-c',
      'mcp_servers={}',
      'app-server',
      '--listen',
      'stdio://',
    ],
    env: { ...env, CODEX_HOME: home },
    processLifecycle: family,
    reserveEnabled: false,
    maxRestarts: 0,
    onMessage() {},
  })
  let threadId: string | null = null
  try {
    upstream.start()
    await upstream.initialize({ clientInfo: { name: 'anyengine-state-bootstrap', version: '1' } })
    upstream.markInitialized()
    if (!warm) return
    const started = asRecord(
      await upstream.request('thread/start', { cwd: paths.canonical, ephemeral: false }, 15_000),
    )
    threadId = idOf(asRecord(started.thread))
    if (!threadId) throw new Error('Canonical warmup did not return a thread')
    // This initializes the history database without invoking a model or any tool.
    await upstream.request(
      'thread/inject_items',
      {
        threadId,
        items: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Initialize shared state; no model turn.' }],
          },
        ],
      },
      15_000,
    )
    const deadline = Date.now() + 5_000
    while (!entry(join(paths.canonical, 'shell_snapshots'))?.isDirectory()) {
      if (Date.now() >= deadline)
        throw new Error('Canonical shell snapshot state did not initialize')
      await pause()
    }
    await upstream.request('thread/archive', { threadId }, 15_000)
    threadId = null
  } finally {
    // Only the known warmup thread is eligible for cleanup, never a discovered user thread.
    if (threadId && upstream.running)
      await upstream.request('thread/archive', { threadId }, 5_000).catch(() => {})
    await upstream.stop()
    await family.stopAll()
  }
}

export async function bootstrapAccounts(
  ledger: AccountLedger,
  input: { binary: string; version: string; env: NodeJS.ProcessEnv },
  signal: AbortSignal = AbortSignal.timeout(120_000),
): Promise<void> {
  if (!input.version || input.version.length > 120)
    throw new Error('Official Codex version is required')
  if (ledger.state().phase !== 'open') throw new Error('Account recovery required before bootstrap')
  const db = ledger.metadata.db,
    paths = ledger.metadata.paths
  db.exec(
    'CREATE TABLE IF NOT EXISTS account_bootstrap(version TEXT PRIMARY KEY,completed INTEGER NOT NULL);',
  )
  if (
    db.prepare('SELECT 1 FROM account_bootstrap WHERE version=? AND completed>0').get(input.version)
  ) {
    const errors = verifyOverlay(paths, ledger.registry())
    if (errors.length) throw new Error(errors.join('; '))
    return
  }
  const owner = accountOwner()
  ledger.freeze(owner, ledger.state().active, 'bootstrap')
  const participants = ledger.participants()
  const stopped: Participant[] = []
  try {
    while (ledger.workCount()) {
      signal.throwIfAborted()
      await retireExitedParticipants(ledger)
      await pause()
    }
    for (const p of participants) {
      signal.throwIfAborted()
      if (processAlive(p.process) !== 'dead') {
        await accountControl(p, { command: 'stop', owner, generation: ledger.state().generation })
        stopped.push(p)
      }
    }
    await retireExitedParticipants(ledger)
    if (ledger.holders().length)
      throw new Error('Bootstrap requires all managed credential families stopped')
    ledger.phase(owner, 'draining', 'stopped')
    for (const p of ledger.participants())
      await accountControl(p, {
        command: 'reconcile',
        owner,
        generation: ledger.state().generation,
      })
    ledger.phase(owner, 'stopped', 'bootstrap')
    await initialized(ledger, owner, input.binary, input.env, paths.canonical, true)
    let manifest = prepareOverlay(paths, ledger.registry())
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted()
      await initialized(ledger, owner, input.binary, input.env, paths.overlay, false)
      const unshared = readdirSync(paths.overlay).filter(
        (name) => name !== 'auth.json' && !entry(join(paths.overlay, name))?.isSymbolicLink(),
      )
      if (!unshared.length) break
      if (attempt === 1) throw new Error('Official Codex repeatedly created unshared overlay state')
      manifest = reconcileOverlay(paths, manifest, { familiesStopped: true })
    }
    const errors = verifyOverlay(paths, ledger.registry())
    if (errors.length) throw new Error(errors.join('; '))
    ledger.metadata.tx(() =>
      db.prepare('INSERT INTO account_bootstrap VALUES(?,?)').run(input.version, Date.now()),
    )
    finishTransition(ledger, owner)
    await restart(ledger, participants)
  } catch (error) {
    if (ledger.state().phase !== 'open' && !ledger.holders().length && !ledger.workCount()) {
      finishTransition(ledger, owner)
      await restart(ledger, stopped)
    }
    throw error
  }
}
