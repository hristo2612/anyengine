import { randomUUID } from 'node:crypto'
import { entry } from './accounts-files.mjs'
import type { SealedCredentials } from './accounts-inventory.mjs'
import { AccountMetadata } from './accounts-metadata.mjs'
import { familyAlive, processAlive, sameProcess } from './accounts-processes.mjs'
import type {
  AccountPaths,
  AccountRegistry,
  Family,
  FamilyIntent,
  OwnerToken,
  Participant,
  ProcessIdentity,
  SwitchReason,
  WorkLease,
} from './accounts-types.mjs'

export type GatePhase =
  | 'open'
  | 'draining'
  | 'stopped'
  | 'sealed'
  | 'journal'
  | 'rolling-back'
  | 'cleanup-commit'
  | 'cleanup-rollback'
  | 'bootstrap'
export interface GateState {
  active: string
  generation: number
  phase: GatePhase
  owner: OwnerToken | null
  intent: { from: string; to: string; reason: SwitchReason | 'bootstrap' } | null
  sealed?: SealedCredentials
}
export function sameOwner(a: OwnerToken | null, b: OwnerToken): boolean {
  return (
    !!a &&
    a.transaction === b.transaction &&
    a.claim === b.claim &&
    sameProcess(a.process, b.process)
  )
}
export class AccountLedger {
  readonly metadata: AccountMetadata
  private readonly liveness: { process: typeof processAlive; family: typeof familyAlive }
  constructor(paths: AccountPaths, liveness = { process: processAlive, family: familyAlive }) {
    this.liveness = liveness
    this.metadata = new AccountMetadata(paths)
    const db = this.metadata.db
    db.exec(`CREATE TABLE IF NOT EXISTS gate(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS participant(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY,participant TEXT NOT NULL,generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS family(id TEXT PRIMARY KEY,account TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS probe(account TEXT PRIMARY KEY,attempted INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rotation_event(transaction_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL);`)
    this.metadata.tx(() => {
      const r = this.registry()
      db.prepare('INSERT OR IGNORE INTO gate VALUES (1,?)').run(
        JSON.stringify({
          active: r.active,
          generation: r.generation,
          phase: 'open',
          owner: null,
          intent: null,
        }),
      )
    })
  }
  registry(): AccountRegistry {
    return this.metadata.read<AccountRegistry>('registry').value
  }
  state(): GateState {
    const row = this.metadata.db.prepare('SELECT body FROM gate WHERE id=1').get() as {
      body: string
    }
    const s = JSON.parse(row.body) as GateState
    if (
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
      ].includes(s.phase) ||
      !Number.isSafeInteger(s.generation) ||
      s.generation < 0 ||
      !this.registry().accounts.some((a) => a.id === s.active)
    )
      throw new Error('Invalid account admission state')
    if (s.phase !== 'open' && (!s.owner || !s.intent)) throw new Error('Unowned account transition')
    return s
  }
  save(s: GateState): void {
    this.metadata.db.prepare('UPDATE gate SET body=? WHERE id=1').run(JSON.stringify(s))
  }
  requireOwner(owner: OwnerToken): GateState {
    const s = this.state()
    if (!sameOwner(s.owner, owner)) throw new Error('Stale account transition owner')
    return s
  }
  freeze(
    owner: OwnerToken,
    to: string,
    reason: SwitchReason | 'bootstrap',
    guard: () => boolean = () => true,
  ): GateState {
    return this.metadata.tx(() => {
      const s = this.state(),
        r = this.registry()
      if (s.phase !== 'open' || entry(this.metadata.paths.journal))
        throw new Error('Account admission frozen')
      if (r.active !== s.active || r.generation !== s.generation)
        throw new Error('Account registry and gate disagree')
      if (!guard()) throw new Error('Account rotation decision is stale')
      if (!r.accounts.some((a) => a.id === to && (a.login === 'ready' || a.id === r.home)))
        throw new Error('Target needs login')
      const next: GateState = {
        ...s,
        phase: 'draining',
        owner,
        intent: { from: s.active, to, reason },
      }
      delete next.sealed
      this.save(next)
      return next
    })
  }
  adopt(replacement: OwnerToken, expected: OwnerToken): void {
    if (this.liveness.process(expected.process) !== 'dead')
      throw new Error('Live or unknown transition owner')
    this.metadata.tx(() => {
      const s = this.requireOwner(expected)
      if (
        replacement.transaction !== expected.transaction ||
        replacement.claim !== expected.claim + 1
      )
        throw new Error('Invalid account recovery claim')
      this.save({ ...s, owner: replacement })
    })
  }
  cancelDrain(owner: OwnerToken, verify: () => void): void {
    this.metadata.tx(() => {
      const s = this.requireOwner(owner)
      if (s.phase !== 'draining' || entry(this.metadata.paths.journal))
        throw new Error('Account drain cannot be cancelled after a move')
      verify()
      this.save({ ...s, phase: 'open', owner: null, intent: null })
    })
  }
  phase(owner: OwnerToken, expected: GatePhase, next: GatePhase): void {
    this.metadata.tx(() => {
      const s = this.requireOwner(owner)
      if (s.phase !== expected) throw new Error('Account transition phase changed')
      this.save({ ...s, phase: next })
    })
  }
  register(p: Participant): void {
    this.metadata.tx(() => {
      const s = this.state()
      if (s.phase !== 'open' || s.generation !== p.generation || entry(this.metadata.paths.journal))
        throw new Error('Account participant registration frozen')
      this.metadata.db.prepare('INSERT INTO participant VALUES (?,?)').run(p.id, JSON.stringify(p))
    })
  }
  participants(): Participant[] {
    return this.metadata.db
      .prepare('SELECT body FROM participant')
      .all()
      .map((r) => JSON.parse(String(r.body)))
  }
  begin(participant: string, generation: number): WorkLease {
    const id = randomUUID()
    this.metadata.tx(() => {
      const s = this.state()
      const p = this.participants().find((p) => p.id === participant)
      if (
        s.phase !== 'open' ||
        s.generation !== generation ||
        !p ||
        p.generation !== generation ||
        entry(this.metadata.paths.journal)
      )
        throw new Error('Account work admission frozen')
      this.metadata.db.prepare('INSERT INTO work VALUES (?,?,?)').run(id, participant, generation)
    })
    return {
      id,
      generation,
      release: async () => {
        this.metadata.tx(() => this.metadata.db.prepare('DELETE FROM work WHERE id=?').run(id))
      },
    }
  }
  workCount(): number {
    return Number(this.metadata.db.prepare('SELECT count(*) AS n FROM work').get()?.n)
  }
  reserveFamily(f: FamilyIntent, owner?: OwnerToken): void {
    this.metadata.tx(() => {
      const s = this.state(),
        maintenance = f.purpose === 'bootstrap'
      if (maintenance) {
        if (!owner || !sameOwner(s.owner, owner) || !['stopped', 'bootstrap'].includes(s.phase))
          throw new Error('Account maintenance admission refused')
      } else if (s.phase !== 'open' || entry(this.metadata.paths.journal))
        throw new Error('Account credential admission frozen')
      if (
        f.generation !== s.generation ||
        !this.registry().accounts.some((a) => a.id === f.account)
      )
        throw new Error('Stale credential generation or unknown account')
      if (f.purpose === 'model' && f.account !== s.active) throw new Error('Inactive model account')
      if (f.purpose === 'probe' && f.account === s.active)
        throw new Error('Active readings are passive')
      this.validateLauncher(f, owner, maintenance)
      const old = this.holders(f.account)
      if (old.some((f) => f.purpose !== 'model') || (f.purpose !== 'model' && old.length))
        throw new Error('Account credential lease busy')
      this.metadata.db
        .prepare('INSERT INTO family VALUES (?,?,?)')
        .run(f.id, f.account, JSON.stringify({ ...f, native: null }))
    })
  }
  private validateLauncher(
    f: FamilyIntent,
    owner: OwnerToken | undefined,
    maintenance: boolean,
  ): void {
    const launcher = this.participants().find((p) => p.id === f.participant)
    if ((!launcher && !maintenance) || (launcher && !sameProcess(launcher.process, f.supervisor)))
      throw new Error('Unregistered or changed credential launcher')
    if (maintenance && (!owner || !sameProcess(owner.process, f.supervisor)))
      throw new Error('Maintenance launcher differs from its owner')
  }
  attachNativeFamily(id: string, native: ProcessIdentity): void {
    this.metadata.tx(() => {
      const f = this.holders().find((f) => f.id === id)
      if (!f || f.native) throw new Error('Account family launch changed')
      this.metadata.db
        .prepare('UPDATE family SET body=? WHERE id=?')
        .run(JSON.stringify({ ...f, native }), id)
    })
  }
  cancelUnlaunchedFamily(id: string, participant: string): void {
    this.metadata.tx(() => {
      const f = this.holders().find((f) => f.id === id)
      if (!f || f.native || f.participant !== participant)
        throw new Error('Account family cancellation refused')
      this.metadata.db.prepare('DELETE FROM family WHERE id=?').run(id)
    })
  }
  retireParticipant(id: string, process: ProcessIdentity): void {
    this.metadata.tx(() => {
      const p = this.participants().find((p) => p.id === id)
      if (
        !p ||
        !sameProcess(p.process, process) ||
        this.holders().some((f) => f.participant === id) ||
        this.metadata.db.prepare('SELECT 1 FROM work WHERE participant=?').get(id)
      )
        throw new Error('Account participant still owns work')
      this.metadata.db.prepare('DELETE FROM participant WHERE id=?').run(id)
    })
  }
  rebaseParticipant(id: string, process: ProcessIdentity): void {
    this.metadata.tx(() => {
      const p = this.participants().find((p) => p.id === id),
        s = this.state()
      if (
        !p ||
        !sameProcess(p.process, process) ||
        s.phase !== 'open' ||
        this.holders().some((f) => f.participant === id) ||
        this.metadata.db.prepare('SELECT 1 FROM work WHERE participant=?').get(id)
      )
        throw new Error('Account participant cannot change generation')
      this.metadata.db
        .prepare('UPDATE participant SET body=? WHERE id=?')
        .run(JSON.stringify({ ...p, generation: s.generation }), id)
    })
  }
  holders(account?: string): Family[] {
    const rows = account
      ? this.metadata.db.prepare('SELECT body FROM family WHERE account=?').all(account)
      : this.metadata.db.prepare('SELECT body FROM family').all()
    return rows.map((r) => JSON.parse(String(r.body)) as Family)
  }
  releaseFamily(id: string): void {
    this.metadata.tx(() => {
      const f = this.holders().find((f) => f.id === id)
      if (!f) return
      if (!f.native || this.liveness.family(f.native) !== 'dead')
        throw new Error('Credential family exit unproven')
      this.metadata.db.prepare('DELETE FROM family WHERE id=?').run(id)
    })
  }
  retireDeadParticipant(id: string): void {
    this.metadata.tx(() => {
      const p = this.participants().find((p) => p.id === id)
      if (
        !p ||
        this.liveness.process(p.process) !== 'dead' ||
        this.holders().some((f) => f.participant === id)
      )
        throw new Error('Account participant lifetime unproven')
      this.metadata.db.prepare('DELETE FROM work WHERE participant=?').run(id)
      this.metadata.db.prepare('DELETE FROM participant WHERE id=?').run(id)
    })
  }
  reserveProbe(account: string, now: number): boolean {
    return this.metadata.tx(() => {
      if (this.state().phase !== 'open') throw new Error('Account probe admission frozen')
      const last = this.probeAttempt(account)
      if (last && (now < last || now - last < 600_000)) return false
      this.metadata.db
        .prepare(
          'INSERT INTO probe VALUES (?,?) ON CONFLICT(account) DO UPDATE SET attempted=excluded.attempted',
        )
        .run(account, now)
      return true
    })
  }
  probeAttempt(account: string): number {
    return Number(
      this.metadata.db.prepare('SELECT attempted FROM probe WHERE account=?').get(account)
        ?.attempted ?? 0,
    )
  }
  publish(owner: OwnerToken, revision: number): void {
    this.metadata.tx(() => {
      const s = this.requireOwner(owner),
        current = this.metadata.read<AccountRegistry>('registry')
      if (
        s.phase !== 'journal' ||
        !s.intent ||
        current.revision !== revision ||
        current.value.active !== s.intent.from ||
        current.value.generation !== s.generation ||
        this.workCount() ||
        this.holders().length
      )
        throw new Error('Account publication state changed')
      const to = s.intent.to,
        generation = s.generation + 1
      this.metadata.mutate<AccountRegistry>('registry', (r) => ({ ...r, active: to, generation }))
      this.save({ ...s, active: to, generation, phase: 'cleanup-commit' })
      this.metadata.db
        .prepare('INSERT INTO rotation_event VALUES (?,?,?,?)')
        .run(
          owner.transaction,
          generation,
          Date.now(),
          JSON.stringify({ from: s.active, to, reason: s.intent.reason }),
        )
      if (
        this.metadata.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='observation_authority'",
          )
          .get()
      ) {
        this.metadata.db.exec('DELETE FROM observation_authority; DELETE FROM observation_sample;')
      }
    })
  }
  open(owner: OwnerToken, verifyInventory: () => void): void {
    this.metadata.tx(() => {
      this.requireOwner(owner)
      const r = this.registry()
      if (entry(this.metadata.paths.journal) || this.workCount() || this.holders().length)
        throw new Error('Account cleanup incomplete')
      verifyInventory()
      this.save({
        active: r.active,
        generation: r.generation,
        phase: 'open',
        owner: null,
        intent: null,
      })
    })
  }
  close(): void {
    this.metadata.close()
  }
}
