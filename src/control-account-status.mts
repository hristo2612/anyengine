import { verifyCredentialLayout } from './accounts-credentials.mjs'
import { entry, metadataJson } from './accounts-files.mjs'
import { AccountMetadata } from './accounts-metadata.mjs'
import { verifyOverlay } from './accounts-overlay.mjs'
import { accountPaths, validateAccounts } from './accounts-store.mjs'
import type { Family, Participant } from './accounts-types.mjs'
import type { System } from './control-system.mjs'

export interface AccountStatus {
  active: string
  label: string
  home: string
  generation: number
  phase: string
  rotation: boolean
  replay: string
  possibleCanonicalPids: number[]
  owner: { pid: number; claim: number } | null
  holders: number
  work: number
  revisions: Record<string, { stored: number; projected: number | null }>
  conflicts: string[]
  staleLimits: string[]
}

export function readAccountStatus(
  root: string,
  canonical: string,
  system: System,
): AccountStatus | null {
  for (let attempt = 0; ; attempt++) {
    const status = readAccountSnapshot(root, canonical, system)
    if (
      attempt === 2 ||
      !status?.conflicts.some((conflict) => conflict.endsWith('projection drift'))
    )
      return status
    // A writer commits metadata and its JSON projection in adjacent transactions.
    // Reopen a bounded read snapshot before treating that publication gap as drift.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
}

function readAccountSnapshot(
  root: string,
  canonical: string,
  system: System,
): AccountStatus | null {
  const paths = accountPaths(root, canonical)
  if (!entry(paths.ledger)) {
    if (entry(paths.registry) || entry(paths.journal)) throw new Error('Account ledger missing')
    return null
  }
  const metadata = new AccountMetadata(paths, { readOnly: true })
  try {
    metadata.db.exec('BEGIN')
    const registry = validateAccounts(metadata.read('registry').value)
    const row = metadata.db.prepare('SELECT body FROM gate WHERE id=1').get()
    if (!row) throw new Error('Account gate missing')
    const gate = JSON.parse(String(row.body))
    if (
      !gate ||
      ![
        'open',
        'draining',
        'stopped',
        'sealed',
        'journal',
        'rolling-back',
        'cleanup-commit',
        'cleanup-rollback',
        'bootstrap',
      ].includes(gate.phase) ||
      gate.active !== registry.active ||
      gate.generation !== registry.generation
    )
      throw new Error('Account gate and registry disagree')
    const participants = metadata.db
      .prepare('SELECT body FROM participant')
      .all()
      .map((r) => JSON.parse(String(r.body)) as Participant)
    const families = metadata.db
      .prepare('SELECT body FROM family')
      .all()
      .map((r) => JSON.parse(String(r.body)) as Family)
    const conflicts: string[] = []
    if (
      gate.phase !== 'open' &&
      (!gate.owner ||
        !Number.isSafeInteger(gate.owner.claim) ||
        gate.owner.claim < 1 ||
        !Number.isSafeInteger(gate.owner.process?.pid) ||
        gate.owner.process.pid < 1 ||
        typeof gate.owner.transaction !== 'string' ||
        !Number.isFinite(Date.parse(gate.owner.process.start)))
    )
      conflicts.push('Invalid account transition owner')
    if (gate.phase === 'open' && (gate.owner || gate.intent || entry(paths.journal)))
      conflicts.push('Open admission has unfinished account recovery')
    const revisions: AccountStatus['revisions'] = {}
    for (const name of ['registry', 'limits'] as const) {
      const stored = metadata.read(name)
      const projection = metadata.db
        .prepare('SELECT revision,body FROM projection WHERE name=?')
        .get(name)
      revisions[name] = {
        stored: stored.revision,
        projected: projection ? Number(projection.revision) : null,
      }
      const value = metadataJson(name === 'registry' ? paths.registry : paths.limits)
      if (
        !projection ||
        projection.revision !== stored.revision ||
        JSON.stringify(value) !== String(projection.body)
      )
        conflicts.push(`${name} projection drift`)
    }
    if (gate.phase === 'open') {
      conflicts.push(...verifyOverlay(paths, registry))
      try {
        verifyCredentialLayout(paths, registry)
      } catch (error) {
        conflicts.push((error as Error).message)
      }
    }
    const readings =
      metadata.read<Record<string, { lastSuccessAt?: number | null }>>('limits').value
    const staleLimits = registry.accounts
      .filter(
        (a) =>
          !readings[a.id]?.lastSuccessAt ||
          Date.now() - Number(readings[a.id]?.lastSuccessAt) > 600_000,
      )
      .map((a) => a.id)
    const managed = new Set([
      ...participants.map((p) => p.process.pid),
      ...families.flatMap((f) => (f.native ? [f.native.pid] : [])),
    ])
    const processes = system.processes()
    const belongs = (pid: number): boolean => {
      const seen = new Set<number>()
      while (pid > 1 && !seen.has(pid)) {
        if (managed.has(pid)) return true
        seen.add(pid)
        pid = processes.find((p) => p.pid === pid)?.ppid ?? 0
      }
      return false
    }
    return {
      active: registry.active,
      label: registry.accounts.find((a) => a.id === registry.active)?.label ?? registry.active,
      home: registry.home,
      generation: registry.generation,
      phase: gate.phase,
      rotation: registry.rotation.enabled,
      replay: registry.replay,
      owner: gate.owner ? { pid: gate.owner.process?.pid, claim: gate.owner.claim } : null,
      holders: families.length,
      work: Number(metadata.db.prepare('SELECT count(*) AS n FROM work').get()?.n),
      revisions,
      conflicts,
      staleLimits,
      // ps does not establish CODEX_HOME. Report a possibility without reading environments.
      possibleCanonicalPids:
        registry.active === registry.home
          ? []
          : processes
              .filter(
                (p) =>
                  /(?:^|\/)codex\s+(?:app-server|exec|--remote)(?:\s|$)/.test(p.command) &&
                  !belongs(p.pid),
              )
              .map((p) => p.pid),
    }
  } finally {
    metadata.close()
  }
}

export function formatAccountStatus(account?: AccountStatus | null): string {
  return account
    ? `${'account'.padEnd(12)}${account.label} (${account.active}), generation ${account.generation}, ${account.phase}; rotation ${account.rotation ? 'on' : 'off'}, replay ${account.replay}; ${account.holders} families, ${account.work} work; owner ${account.owner ? `${account.owner.pid}/${account.owner.claim}` : 'none'}\n${account.conflicts.length ? `account conflicts: ${account.conflicts.join('; ')}\n` : ''}${account.staleLimits.length ? `limits stale or unknown: ${account.staleLimits.join(', ')}\n` : ''}`
    : ''
}
