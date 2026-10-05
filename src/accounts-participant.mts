import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { type AccountControlHooks, startAccountControl } from './accounts-control.mjs'
import { createAccountFamily, type ManagedChildLifecycle } from './accounts-family.mjs'
import { privateDirectory } from './accounts-files.mjs'
import { AccountLedger } from './accounts-ledger.mjs'
import { type OverlayManifest, prepareOverlay } from './accounts-overlay.mjs'
import { reconcileOverlay } from './accounts-overlay-reconcile.mjs'
import { AccountRotationPolicy } from './accounts-policy.mjs'
import { identifyProcess } from './accounts-processes.mjs'
import { initializeAccounts } from './accounts-store.mjs'
import type { AccountPaths, Participant, WorkLease } from './accounts-types.mjs'
import { LimitsStore } from './limits-store.mjs'

export class AccountParticipant {
  readonly ledger: AccountLedger
  readonly participant: Participant
  readonly ready: Promise<void>
  readonly lifecycle: ManagedChildLifecycle
  readonly limits: LimitsStore
  readonly policy: AccountRotationPolicy
  private retired = false
  private quotaRecorder: (scope: string) => boolean = () => false
  manifest: OverlayManifest
  private control: Awaited<ReturnType<typeof startAccountControl>> | null = null
  private hooks: AccountControlHooks | null = null
  constructor(paths: AccountPaths, kind: Participant['kind']) {
    initializeAccounts(paths)
    this.ledger = new AccountLedger(paths)
    this.limits = new LimitsStore(this.ledger)
    if (this.ledger.state().phase !== 'open') {
      this.ledger.close()
      throw new Error('Account recovery required')
    }
    this.manifest = prepareOverlay(paths, this.ledger.registry())
    const processIdentity = identifyProcess(process.pid)
    if (!processIdentity) {
      this.ledger.close()
      throw new Error('Account participant identity unknown')
    }
    const directory = join(paths.root, 'run', 'a')
    privateDirectory(directory)
    const id = randomBytes(6).toString('hex')
    this.participant = {
      id,
      kind,
      process: processIdentity,
      socket: join(directory, `${id}.sock`),
      generation: this.ledger.state().generation,
    }
    this.ledger.register(this.participant)
    this.policy = new AccountRotationPolicy(this)
    let family = createAccountFamily(this.ledger, this.participant)
    this.lifecycle = {
      spawn: async (command, args, env) => {
        await this.ready
        if (this.retired) throw new Error('Account participant retired; restart this surface')
        this.manifest = prepareOverlay(paths, this.ledger.registry())
        return family.spawn(command, args, { ...env, CODEX_HOME: paths.overlay })
      },
      stop: (child) => {
        const holder = this.ledger.holders().find((f) => f.native?.pid === child.pid)
        if (holder) this.limits.revoke(holder.id)
        return family.stop(child)
      },
      stopAll: async () => {
        for (const f of this.ledger.holders().filter((f) => f.participant === this.participant.id))
          this.limits.revoke(f.id)
        await family.stopAll()
        family = createAccountFamily(this.ledger, this.participant)
      },
    }
    this.ready = startAccountControl(this.ledger, this.participant, {
      policy: () => {
        if (!this.retired) this.policy.configure()
      },
      retire: async () => {
        await this.policy.close()
        await this.lifecycle.stopAll?.()
        this.ledger.retireParticipant(this.participant.id, this.participant.process)
        this.retired = true
      },
      stop: async () => {
        if (!this.hooks) throw new Error('Account participant not ready')
        await this.hooks.stop()
      },
      restart: async () => {
        if (this.retired) throw new Error('Account participant retired')
        if (!this.hooks) throw new Error('Account participant not ready')
        this.ledger.rebaseParticipant(this.participant.id, this.participant.process)
        this.participant.generation = this.ledger.state().generation
        this.manifest = prepareOverlay(paths, this.ledger.registry())
        await this.hooks.restart()
      },
      reconcile: async () => {
        reconcileOverlay(paths, this.manifest, { familiesStopped: true })
      },
    }).then((control) => {
      this.control = control
      this.policy.configure()
    })
  }
  setHooks(hooks: AccountControlHooks): void {
    this.hooks = hooks
  }
  begin(): WorkLease {
    if (this.retired) throw new Error('Account participant retired; restart this surface')
    return this.ledger.begin(this.participant.id, this.participant.generation)
  }
  setQuotaRecorder(record: (scope: string) => boolean): void {
    this.quotaRecorder = record
  }
  recordQuota(scope: string): boolean {
    return this.quotaRecorder(scope)
  }
  account(): { home: string; generation: number } {
    const s = this.ledger.state()
    return { home: this.ledger.metadata.paths.overlay, generation: s.generation }
  }
  async close(): Promise<void> {
    await this.policy.close()
    await this.lifecycle.stopAll?.()
    await this.ready
    await this.control?.close()
    if (!this.retired) this.ledger.retireParticipant(this.participant.id, this.participant.process)
    this.ledger.close()
  }
}
