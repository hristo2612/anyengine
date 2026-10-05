// Durable Bash 3.2 recovery, independent of public launchers and installed libs.
// A script consumes the current journal, so an interrupted next publication is
// recoverable through the previously published private entry.
import { mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { claudeRecoveryJxa, claudeRecoveryShell } from './control-claude-recovery.mjs'
import {
  absolute,
  atomicFile,
  digest,
  directoryAt,
  statAt,
  syncDirectory,
} from './control-layer-state.mjs'
import { type FileChange, type Layer, readLayers, recoveryPaths } from './control-layers.mjs'
import { m2RetirementJxa } from './control-m2-retirement.mjs'
import {
  activeUpgrade,
  recordM2ControlChanges,
  recordM2RecoveryIntent,
} from './control-m2-upgrade.mjs'
import { recoveryEvidence } from './control-recovery-evidence.mjs'
import { recoveryLifecycle } from './control-recovery-lifecycle.mjs'
import { recoveryShell } from './control-recovery-shell.mjs'
import { recoveryText } from './control-recovery-text.mjs'

export interface RecoveryOptions {
  root: string
  app: string
  bundleId: string
  codexHome: string
  commands?: Partial<
    Record<'launchctl' | 'osascript' | 'open' | 'pgrep' | 'plutil' | 'curl', string>
  >
  quitWaitSeconds?: number
}
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('NUL cannot be a shell argument')
  return `'${value.replaceAll("'", "'\\''")}'`
}
export function isRcChange(change: FileChange): boolean {
  return ['.zshrc', '.bash_profile'].includes(basename(change.target))
}
export function publicRecoveryScript(root: string): string {
  if (!absolute(root)) throw new Error('recovery wrapper requires an absolute root')
  return `#!/bin/bash\nexec /bin/bash ${shellQuote(recoveryPaths(root).entry)} "$@"\n`
}
// Keep the installed public wrapper stable across upgrades. The private entry
// execs the retained M2 dispatcher before recovery can restore either launcher.
function m2RecoveryDispatch(root: string): string {
  return `m3=0
m2=0
router=0
for arg in "$@"; do
  case "$arg" in
    --m3-only) m3=$((m3+1));;
    --m2-only) m2=$((m2+1));;
    --router-only) router=1;;
    --last-good|--no-restart|--files-only|--copy-only|--after-quit) ;;
    *) printf 'invalid recovery argument\\n' >&2; exit 2;;
  esac
done
[ "$m3" -le 1 ] && [ "$m2" -le 1 ] && [ $((m3+m2+router)) -le 1 ] || { printf 'recovery selectors are mutually exclusive\\n' >&2; exit 2; }
if [ "$m2" = 1 ]; then
  for arg in "$@"; do
    case "$arg" in --m2-only|--no-restart) ;; *) printf 'usage: anyengine-off --m2-only [--no-restart]\\n' >&2; exit 2;; esac
  done
fi
if [ "$m3" != 0 ]; then
  [ "$m3" = 1 ] && [ "$m2" = 0 ] && [ "$router" = 0 ] || { printf 'M3-only, M2-only and router-only are mutually exclusive\\n' >&2; exit 2; }
  args=()
  for arg in "$@"; do
    case "$arg" in --m3-only) ;; --no-restart) args[0]=--no-restart;; *) printf 'usage: anyengine-off --m3-only [--no-restart]\\n' >&2; exit 2;; esac
  done
  exec /bin/bash ${shellQuote(join(root, 'recovery/m3/recover.sh'))} "\${args[@]}"
fi
# Cross the M3 boundary before an older broad/M2 remover can touch launchers.
if [ -e ${shellQuote(join(root, 'm3-upgrade.json'))} ] || [ -L ${shellQuote(join(root, 'm3-upgrade.json'))} ]; then
  phase=$(/usr/bin/osascript -l JavaScript - ${shellQuote(join(root, 'm3-upgrade.json'))} <<'M3_DISPATCH_PHASE'
ObjC.import('Foundation')
function run(args) {
  var data=$.NSData.dataWithContentsOfFile($(args[0]))
  if (data.isNil() || Number(data.length)>2000000) throw new Error('invalid M3 reference')
  var value=JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding)))
  if (!value || ['prepared','activating','active','rolling-back','rolled-back','conflict'].indexOf(value.phase)<0) throw new Error('invalid M3 phase')
  return value.phase
}
M3_DISPATCH_PHASE
) || exit 1
  if [ "$phase" != rolled-back ]; then
    args=()
    for arg in "$@"; do case "$arg" in --no-restart) args[0]=--no-restart;; esac; done
    /bin/bash ${shellQuote(join(root, 'recovery/m3/recover.sh'))} "\${args[@]}" || exit 1
    exec /bin/bash ${shellQuote(join(root, 'recovery/anyengine-off'))} "$@"
  fi
fi
if [ "$m2" != 0 ]; then
  [ "$m2" = 1 ] && [ "$router" = 0 ] || { printf 'M2-only and router-only are mutually exclusive\\n' >&2; exit 2; }
  args=()
  for arg in "$@"; do
    case "$arg" in --m2-only) ;; --no-restart) args[0]=--no-restart;; *) printf 'usage: anyengine-off --m2-only [--no-restart]\\n' >&2; exit 2;; esac
  done
  exec /bin/bash ${shellQuote(join(root, 'recovery/m2/recover.sh'))} "\${args[@]}"
fi
`
}
function generate(options: RecoveryOptions, direct: string): string {
  for (const path of [options.root, options.app, options.codexHome]) {
    if (!absolute(path)) throw new Error('recovery requires normalized absolute paths')
  }
  if (!/^[A-Za-z0-9.-]+$/.test(options.bundleId)) throw new Error('invalid bundle id')
  const wait = options.quitWaitSeconds ?? 30
  if (!Number.isInteger(wait) || wait < 0 || wait > 3600) throw new Error('invalid quit wait')
  if (
    Object.keys(options.commands ?? {}).some(
      (key) => !['launchctl', 'osascript', 'open', 'pgrep', 'plutil', 'curl'].includes(key),
    )
  )
    throw new Error('unsupported recovery command')
  const commands = {
    launchctl: '/bin/launchctl',
    osascript: '/usr/bin/osascript',
    open: '/usr/bin/open',
    pgrep: '/usr/bin/pgrep',
    plutil: '/usr/bin/plutil',
    curl: '/usr/bin/curl',
    ...options.commands,
  }
  for (const command of Object.values(commands))
    if (!absolute(command)) throw new Error('recovery commands must be absolute paths')
  const paths = recoveryPaths(options.root)
  const values = {
    ROOT: options.root,
    APP: options.app,
    BUNDLE: options.bundleId,
    CODEX_HOME: options.codexHome,
    DIRECT: direct,
    RECOVERY: paths.directory,
    ENTRY: paths.entry,
    PUBLIC: join(options.root, 'bin', 'anyengine-off'),
    RECOVER: paths.instructions,
    PUBLIC_SHA: digest(Buffer.from(publicRecoveryScript(options.root))),
    QUIT_WAIT: String(wait),
    ...Object.fromEntries(
      Object.entries(commands).map(([key, value]) => [key.toUpperCase(), value]),
    ),
  }
  return `#!/bin/bash\n# AnyEngine recovery: system Bash + system JXA; no installed library required.\n${direct === 'all' ? m2RecoveryDispatch(options.root) : ''}${Object.entries(
    values,
  )
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(
      '\n',
    )}\n${recoveryShell}\n${claudeRecoveryShell}\njxa() { /usr/bin/osascript -l JavaScript - "$@" <<'RECOVERY_JXA_BODY'\n${recoveryEvidence}\n${claudeRecoveryJxa}\n${m2RetirementJxa}\n${recoveryText}\nRECOVERY_JXA_BODY\n}\n${recoveryLifecycle}`
}
export function rollbackScript(
  layer: Layer,
  options: Pick<RecoveryOptions, 'codexHome'> & Partial<RecoveryOptions>,
): string {
  const parent = dirname(layer.rollbackDir)
  const root = options.root ?? (basename(parent) === 'layers' ? dirname(dirname(parent)) : parent)
  return generate(
    {
      root,
      codexHome: options.codexHome,
      app: options.app ?? '/Applications/ChatGPT.app',
      bundleId: options.bundleId ?? 'com.openai.codex',
      ...(options.commands ? { commands: options.commands } : {}),
      ...(options.quitWaitSeconds !== undefined
        ? { quitWaitSeconds: options.quitWaitSeconds }
        : {}),
    },
    layer.rollbackDir,
  )
}
export function offScript(_layers: Layer[], options: RecoveryOptions): string {
  return generate(options, 'all')
}
function prepare(path: string): void {
  const missing: string[] = []
  let cursor = path
  while (!statAt(cursor)) {
    missing.push(cursor)
    cursor = dirname(cursor)
  }
  directoryAt(cursor)
  for (const dir of missing.reverse()) {
    mkdirSync(dir, { mode: 0o700 })
    syncDirectory(dirname(dir))
  }
  directoryAt(path)
}
// Invoke once before the first writer, then synchronously in every OnRecord.
// LayerWriter already durably published intent; throws here prevent its write.
// Task24 owns immutable control/lib pin collection in LayerFile.recovery.
export function publishRecovery(options: RecoveryOptions): void {
  const file = readLayers(options.root)
  const script = offScript(file.layers, options)
  const paths = recoveryPaths(options.root)
  prepare(paths.directory)
  const publish = (target: string, bytes: Buffer, mode: number) => {
    const settle = recordM2RecoveryIntent(
      options.root,
      target,
      bytes,
      mode,
      activeUpgrade(options.root),
    )
    atomicFile(target, bytes, mode)
    settle?.()
  }
  publish(paths.entry, Buffer.from(script), 0o700)
  publish(
    paths.instructions,
    Buffer.from(
      `Recover with system tools (works without Node or installed libraries):\n/bin/bash ${shellQuote(paths.entry)}\nUse --router-only for M0; --last-good for an interrupted M1 upgrade.\nUse --no-restart only after the configured app has exited.\nRetain this command and recovery evidence until all layers are verified complete.\n`,
    ),
    0o600,
  )
  for (const layer of file.layers)
    publish(
      join(layer.rollbackDir, 'ROLLBACK.sh'),
      Buffer.from(rollbackScript(layer, options)),
      0o700,
    )
  if (file.layers[0])
    recordM2ControlChanges(options.root, file.layers[0], 'checkpoint', activeUpgrade(options.root))
}
