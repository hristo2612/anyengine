import { homedir } from 'node:os'
import { join } from 'node:path'
import { officialCodexVersion, requireAccountBootstrap } from './accounts-bootstrap.mjs'
import { entry } from './accounts-files.mjs'
import { AccountLedger } from './accounts-ledger.mjs'
import { AccountParticipant } from './accounts-participant.mjs'
import { accountPaths } from './accounts-store.mjs'
import type { Participant } from './accounts-types.mjs'
import { anyengineRoot } from './anyengine-config.mjs'
import { resolveBundledCodex } from './bundled-codex.mjs'

export function managedAccounts(
  env: NodeJS.ProcessEnv,
  kind: Participant['kind'],
): AccountParticipant | null {
  const root = anyengineRoot(env)
  if (env.ANYENGINE_MOCK === '1' || !entry(join(root, 'accounts.json'))) return null
  const paths = accountPaths(root, env.CODEX_HOME || join(env.HOME || homedir(), '.codex'))
  if (paths.canonical === paths.overlay)
    throw new Error('Managed account startup requires the canonical Codex home')
  const binary = resolveBundledCodex(env).path
  if (!binary) throw new Error('Official Codex unavailable for account admission')
  const ledger = new AccountLedger(paths)
  try {
    requireAccountBootstrap(ledger, officialCodexVersion(binary, env))
  } finally {
    ledger.close()
  }
  return new AccountParticipant(paths, kind)
}
