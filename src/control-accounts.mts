import { once } from 'node:events'
import { join } from 'node:path'
import { accountControl } from './accounts-control.mjs'
import { planAuthMoves } from './accounts-credentials.mjs'
import { createAccountFamily } from './accounts-family.mjs'
import { entry, privateDirectory, privateFile } from './accounts-files.mjs'
import { AccountLedger } from './accounts-ledger.mjs'
import { AccountMetadata } from './accounts-metadata.mjs'
import { prepareOverlay } from './accounts-overlay.mjs'
import { probeParked } from './accounts-probe.mjs'
import { accountOwner, recoverManagedAccounts, rotateAccount } from './accounts-rotation.mjs'
import {
  ACCOUNT_ID,
  accountHome,
  accountPaths,
  initializeAccounts,
  validateAccounts,
} from './accounts-store.mjs'
import type { AccountRegistry } from './accounts-types.mjs'
import { standaloneEnvironment } from './broker-standalone.mjs'
import { resolveBundledCodex } from './bundled-codex.mjs'
import { accountSnapshot, backupAccountMetadata } from './control-account-backup.mjs'
import type { Command, Say } from './control-cli.mjs'
import { takeFlipLock } from './control-flip-lock.mjs'
import { readFlipMarker } from './control-marker.mjs'
import type { System } from './control-system.mjs'
import { claudeReadings } from './limits-claude.mjs'
import { formatLimits, limitsRows } from './limits-format.mjs'
import { LimitsStore } from './limits-store.mjs'
import { codexHome } from './util.mjs'

const USAGE =
  'accounts add ID [--existing] [--label TEXT] | list [--json] | use ID [--wait-quiet SECONDS] [--dry-run] | rotate on|off [--threshold PERCENT] [--cooldown SECONDS] [--replay none|continue-prompt] | recover [--dry-run] | backup --metadata-only'
function open(root: string): AccountLedger {
  const p = accountPaths(root, codexHome())
  initializeAccounts(p)
  const ledger = new AccountLedger(p)
  if (ledger.state().phase === 'open') prepareOverlay(p, ledger.registry())
  return ledger
}
async function login(ledger: AccountLedger, account: string): Promise<void> {
  const owner = accountOwner(),
    id = owner.transaction
  const participant = {
    id,
    kind: 'login' as const,
    process: owner.process,
    socket: '',
    generation: ledger.state().generation,
  }
  ledger.register(participant)
  const work = ledger.begin(id, participant.generation)
  const family = createAccountFamily(ledger, participant, { account, purpose: 'login' })
  try {
    const binary = resolveBundledCodex().path
    if (!binary) throw new Error('Official Codex unavailable')
    const child = await family.spawn(
      binary,
      ['login', '--device-auth'],
      standaloneEnvironment(accountHome(ledger.metadata.paths, account), process.env),
    )
    child.stdout?.pipe(process.stdout)
    process.stdin.pipe(child.stdin as NodeJS.WritableStream)
    const exited = once(child, 'exit')
    const result = await exited
    process.stdin.unpipe(child.stdin as NodeJS.WritableStream)
    if (result[0] !== 0) throw new Error('Official device login did not complete')
  } finally {
    await family.stopAll()
    await work.release()
    ledger.retireParticipant(id, participant.process)
  }
}
async function add(ledger: AccountLedger, args: string[]): Promise<void> {
  const id = args[0]
  if (!id || !ACCOUNT_ID.test(id)) throw new Error('Invalid account ID')
  let label = id,
    existing = false
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--existing') existing = true
    else if (args[i] === '--label' && args[i + 1] !== undefined) label = args[++i] ?? id
    else throw new Error(USAGE)
  }
  if (ledger.registry().accounts.some((a) => a.id === id))
    throw new Error('Account already registered')
  const dir = accountHome(ledger.metadata.paths, id),
    auth = join(dir, 'auth.json')
  privateDirectory(dir)
  privateFile(auth)
  if (existing !== !!entry(auth))
    throw new Error(
      existing ? 'Existing account credential absent' : 'Credential already exists; use --existing',
    )
  ledger.metadata.editRegistry((r) => ({
    ...r,
    accounts: [
      ...r.accounts,
      {
        id,
        label,
        kind: 'managed',
        vendorAccountId: null,
        email: null,
        planType: null,
        login: 'needs-login',
      },
    ],
  }))
  ledger.metadata.project()
  if (!existing) await login(ledger, id)
  const status = await probeParked({ ledger, limits: new LimitsStore(ledger), account: id })
  if (status !== 'read') throw new Error(`Account registered; official metadata ${status}`)
}
async function recover(ledger: AccountLedger): Promise<void> {
  await recoverManagedAccounts(ledger)
}

function dryUse(args: string[], root: string, say: Say): number | null {
  const [verb, id, ...rest] = args
  if (verb === 'recover' && id === '--dry-run' && rest.length === 0) {
    const snapshot = accountSnapshot(root, codexHome())
    say(`${JSON.stringify(snapshot, null, 2)}\n`)
    return 0
  }
  if (verb === 'use' && rest.includes('--dry-run')) {
    if (!id || rest.filter((x) => x === '--dry-run').length !== 1) {
      say(`${USAGE}\n`)
      return 2
    }
    const quiet = quietSeconds(rest.filter((x) => x !== '--dry-run')),
      paths = accountPaths(root, codexHome()),
      metadata = new AccountMetadata(paths, { readOnly: true })
    try {
      const registry = validateAccounts(metadata.read<AccountRegistry>('registry').value),
        state = JSON.parse(
          String(metadata.db.prepare('SELECT body FROM gate WHERE id=1').get()?.body),
        )
      say(
        `${JSON.stringify(
          {
            from: registry.active,
            to: id,
            generation: registry.generation,
            phase: state.phase,
            waitQuietSeconds: quiet,
            admittedWork: Number(metadata.db.prepare('SELECT count(*) AS n FROM work').get()?.n),
            credentialFamilies: Number(
              metadata.db.prepare('SELECT count(*) AS n FROM family').get()?.n,
            ),
            operations:
              state.phase !== 'open'
                ? null
                : registry.active === id
                  ? []
                  : planAuthMoves(paths, registry, id),
          },
          null,
          2,
        )}\n`,
      )
    } finally {
      metadata.close()
    }
    return 0
  }
  return null
}
function rotationOptions(
  registry: AccountRegistry,
  enabled: boolean,
  args: string[],
): AccountRegistry {
  const current = structuredClone(registry),
    seen = new Set<string>()
  current.rotation.enabled = enabled
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1]
    if (!flag || !value || seen.has(flag)) throw new Error(USAGE)
    seen.add(flag)
    if (flag === '--threshold') current.rotation.threshold = Number(value)
    else if (flag === '--cooldown') current.rotation.cooldownMs = Number(value) * 1000
    else if (flag === '--replay' && (value === 'none' || value === 'continue-prompt'))
      current.replay = value
    else throw new Error(USAGE)
  }
  return validateAccounts(current)
}
function quietSeconds(args: string[]): number {
  const seconds =
    args.length === 0 ? 60 : args.length === 2 && args[0] === '--wait-quiet' ? Number(args[1]) : NaN
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error(USAGE)
  return seconds
}
function lockAccountControl(root: string, system: System): () => void {
  const lock = takeFlipLock(root, system)
  if (!lock.ok) throw new Error('Another control operation is active')
  try {
    if (readFlipMarker(root))
      throw new Error('Interrupted install requires recovery before account changes')
    return lock.release
  } catch (error) {
    lock.release()
    throw error
  }
}
function listArguments(args: string[]): boolean {
  return args.length === 1 || (args.length === 2 && args[1] === '--json')
}
export const accountsCommand: Command = async (args, system, root, say) => {
  const [verb, id, ...rest] = args
  const dry = dryUse(args, root, say)
  if (dry !== null) return dry
  let release: (() => void) | undefined
  let ledger: AccountLedger | undefined
  try {
    if (verb !== 'list') release = lockAccountControl(root, system)
    ledger = open(root)
    if (verb === 'list' && listArguments(args)) {
      const registry = ledger.registry()
      say(
        id === '--json'
          ? `${JSON.stringify(registry, null, 2)}\n`
          : `${registry.accounts
              .map(
                (a) =>
                  `${a.id === registry.active ? '* ' : '  '}${a.id} — ${a.label}; ${a.login}; ${a.planType ?? 'plan unknown'}`,
              )
              .join(
                '\n',
              )}\nRotation: ${registry.rotation.enabled ? 'on' : 'off'}; replay: ${registry.replay}\n`,
      )
    } else if (verb === 'rotate' && ['on', 'off'].includes(id ?? '')) {
      ledger.metadata.editRegistry((r) => rotationOptions(r, id === 'on', rest))
      ledger.metadata.project()
      for (const p of ledger.participants())
        if (p.socket)
          await accountControl(p, { command: 'policy', generation: ledger.state().generation })
      say(`Rotation ${id}\n`)
    } else if (verb === 'use' && id) {
      await rotateAccount(ledger, id, 'manual', AbortSignal.timeout(quietSeconds(rest) * 1000))
      say(`Active account: ${ledger.registry().active}\n`)
    } else if (verb === 'add') {
      await add(ledger, args.slice(1))
      say(`Account ${id} ready\n`)
    } else if (verb === 'recover' && args.length === 1) {
      await recover(ledger)
      say('Account recovery complete\n')
    } else if (verb === 'backup' && id === '--metadata-only' && rest.length === 0) {
      say(`${JSON.stringify(backupAccountMetadata(root, codexHome()), null, 2)}\n`)
    } else {
      say(`${USAGE}\n`)
      return 2
    }
    ledger.metadata.project()
    return 0
  } catch (error) {
    say(`${(error as Error).message}\n`)
    return /frozen|busy|active|owned|timed out|aborted/i.test((error as Error).message) ? 3 : 2
  } finally {
    ledger?.close()
    release?.()
  }
}
export const limitsCommand: Command = async (args, _system, root, say) => {
  if (
    args.some((a) => !['--json', '--refresh'].includes(a)) ||
    new Set(args).size !== args.length
  ) {
    say('limits [--json] [--refresh]\n')
    return 2
  }
  const ledger = open(root),
    limits = new LimitsStore(ledger)
  try {
    if (args.includes('--refresh'))
      for (const a of ledger.registry().accounts) {
        if (a.id !== ledger.state().active) await probeParked({ ledger, limits, account: a.id })
      }
    ledger.metadata.project()
    say(
      args.includes('--json')
        ? `${JSON.stringify({ accounts: limitsRows(ledger.registry(), limits.readings()), claude: { state: Object.keys(claudeReadings(ledger.metadata)).length ? 'observed' : 'not observed', buckets: claudeReadings(ledger.metadata) } }, null, 2)}\n`
        : formatLimits(
            ledger.registry(),
            limits.readings(),
            Date.now(),
            claudeReadings(ledger.metadata),
          ),
    )
    return 0
  } finally {
    ledger.close()
  }
}
