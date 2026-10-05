// Named rollback inputs only. Authentication and SQLite storage never enter a copy.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { enginePaths } from './anyengine-config.mjs'
import { withoutLines } from './codex-config-toml.mjs'
import { inspectModelsCache } from './control-cache.mjs'
import {
  configAt,
  type InstallPaths,
  type OnPlan,
  pickAt,
  readText,
} from './control-install-on.mjs'
import { validateLayers } from './control-layer-journal.mjs'
import {
  beforeState,
  digest,
  type FileState,
  jsonAt,
  keepBytes,
  type LayerFile,
  object,
  regularBytes,
  setSettled,
  settledState,
  statAt,
  stateAt,
} from './control-layer-state.mjs'
import { readLayers, writeLayers } from './control-layers.mjs'
import { rcPath } from './control-rc.mjs'
import { publishRecovery, shellQuote } from './control-scripts.mjs'
import { readStatusKnownGood, readStatusSmoke } from './control-status-evidence.mjs'
import type { ExecResult, System } from './control-system.mjs'
import { realSystem } from './control-system.mjs'
import { inspectDegraded, inspectProof } from './degraded.mjs'
import { withFileLock } from './file-lock.mjs'

export interface Saved {
  state: FileState
  bytes?: Buffer
}
export interface SourceSnapshot {
  home: string
  root: string
  paths: InstallPaths
  plan: OnPlan
  files: Map<string, Saved>
  targets: Set<string>
  journal: LayerFile
}
export function saved(path: string): Saved {
  admitRead(path)
  const state = stateAt(path)
  return { state, ...(state.kind === 'file' ? { bytes: regularBytes(path) } : {}) }
}
function add(snapshot: SourceSnapshot, path: string, target = false): void {
  admitRead(path)
  const roots = [snapshot.home, snapshot.root, snapshot.paths.codexHome]
  if (
    ![snapshot.paths.pickFile, snapshot.plan.shimSource, snapshot.plan.launcherSource].includes(
      path,
    ) &&
    !roots.some((root) => path.startsWith(`${root}/`))
  )
    throw new Error(`unowned source target: ${path}`)
  if (!snapshot.files.has(path)) snapshot.files.set(path, saved(path))
  if (target) snapshot.targets.add(path)
}
function receipt(snapshot: SourceSnapshot, dir: string): void {
  const path = join(dir, 'manifest.json')
  admitRead(path)
  const value = jsonAt(path)
  if (value === undefined) return
  if (!object(value) || !Array.isArray(value.entries)) throw new Error(`invalid manifest: ${path}`)
  add(snapshot, path)
  for (const row of value.entries) {
    if (
      !object(row) ||
      typeof row.target !== 'string' ||
      !isAbsolute(row.target) ||
      typeof row.backup !== 'string' ||
      basename(row.backup) !== row.backup ||
      ['.', '..'].includes(row.backup)
    )
      throw new Error(`invalid manifest target/backup: ${path}`)
    if (
      ![
        join(snapshot.home, '.zshrc'),
        join(snapshot.home, 'bin/codex'),
        join(snapshot.root, 'runtime.env'),
      ].includes(row.target)
    )
      throw new Error('unsupported M0 receipt target')
    add(snapshot, join(dir, row.backup))
    add(snapshot, row.target, true)
  }
}
function layerInputs(snapshot: SourceSnapshot): void {
  for (const layer of snapshot.journal.layers) {
    for (const change of layer.changes) {
      add(snapshot, change.target, true)
      for (const state of [
        beforeState(change),
        settledState(change),
        change.pending,
        change.lastGood,
      ])
        if (state?.bytes) add(snapshot, join(layer.rollbackDir, state.bytes))
    }
    for (const record of [layer.sharedConfig, layer.upgrade?.sharedConfig]) {
      if (!record) continue
      add(snapshot, record.target, true)
      add(snapshot, record.pickFile, true)
      pickAt(record.pickFile)
      withoutLines(readText(record.target), [])
      add(snapshot, join(layer.rollbackDir, record.backup))
    }
    for (const name of ['POPPED', 'ROLLBACK.sh', 'models_cache.json'])
      add(snapshot, join(layer.rollbackDir, name))
    for (const name of readdirSync(layer.rollbackDir))
      if (name.startsWith('cache-'))
        add(snapshot, join(layer.rollbackDir, name, 'models_cache.json'))
  }
}
export function sourceSnapshot(
  system: System,
  root: string,
  plan: OnPlan,
  paths: InstallPaths,
): SourceSnapshot {
  for (const path of [
    join(system.home, '.zshrc'),
    join(root, 'state/layers.json'),
    join(paths.codexHome, 'config.toml'),
    paths.pickFile,
    plan.shimSource,
    plan.launcherSource,
  ])
    admitRead(path)
  // Strict readers run before copying anything. Physical POPPED/pending evidence is authority too.
  readLayers(root)
  const journal = (jsonAt(enginePaths(root).layers) ?? { version: 1, layers: [] }) as LayerFile
  validateLayers(root, journal)
  configAt(root)
  pickAt(paths.pickFile)
  withoutLines(readText(join(paths.codexHome, 'config.toml')), [])
  inspectProof(root)
  inspectDegraded(root)
  readStatusKnownGood(root)
  readStatusSmoke(root)
  const cache = inspectModelsCache(
    paths.codexHome,
    new Set(configAt(root).claude.models.map((model) => model.id)),
  )
  if (cache.parseError) throw new Error(`models_cache.json: ${cache.parseError}`)
  const snapshot: SourceSnapshot = {
    home: system.home,
    root,
    paths,
    plan,
    files: new Map(),
    targets: new Set(),
    journal,
  }
  const rc = rcPath(system.home, process.env.SHELL)
  if (!rc) throw new Error('unsupported login shell')
  for (const path of [
    rc,
    join(system.home, 'bin/codex'),
    join(root, 'runtime.env'),
    join(root, 'bin/anyengine'),
    join(root, 'bin/anyengine-off'),
    join(root, 'lib/current'),
    ...['router', 'smoke'].map((n) =>
      join(system.home, `Library/LaunchAgents/dev.anyengine.${n}.plist`),
    ),
    join(paths.codexHome, 'config.toml'),
    join(paths.codexHome, 'models_cache.json'),
    paths.pickFile,
  ])
    add(snapshot, path, true)
  for (const path of [
    enginePaths(root).config,
    enginePaths(root).layers,
    plan.shimSource,
    plan.launcherSource,
    join(root, 'RECOVER.txt'),
    join(root, 'recovery/anyengine-off'),
  ])
    add(snapshot, path)
  for (const name of ['proven.json', 'degraded.json', 'known-good.json', 'smoke.json'])
    add(snapshot, join(root, 'state', name))
  if (statAt(root))
    for (const name of readdirSync(root))
      if (/^rollback-\d{8}T\d{6}Z$/.test(name)) receipt(snapshot, join(root, name))
  if (statAt(enginePaths(root).config)) snapshot.targets.add(enginePaths(root).config)
  layerInputs(snapshot)
  return snapshot
}
export function safeParents(path: string): void {
  let cursor = dirname(path)
  while (cursor !== dirname(cursor)) {
    const stat = statAt(cursor)
    if (stat && !stat.isDirectory()) throw new Error(`indirect scratch/source parent: ${cursor}`)
    cursor = dirname(cursor)
  }
}
function admitRead(path: string): void {
  if (['auth.json', 'credentials.json', '.claude.json'].includes(basename(path)))
    throw new Error('authentication files cannot enter a rollback proof')
  safeParents(path)
}
export interface Scratch extends ReturnType<typeof relocated> {
  home: string
  root: string
  paths: InstallPaths
  plan: OnPlan
  system: System
  targets: Map<string, Saved>
}
function relocated(source: SourceSnapshot, home: string) {
  const pairs = new Map<string, string>([
    [source.home, home],
    [source.root, join(home, '.anyengine')],
    [source.paths.codexHome, join(home, '.codex')],
    [source.plan.app, join(home, 'Applications/Proof.app')],
    [source.plan.node, join(home, '.proof-tools/node')],
  ])
  if (source.plan.claudeCli) pairs.set(source.plan.claudeCli, join(home, '.proof-tools/claude'))
  if (!source.paths.pickFile.startsWith(`${source.paths.codexHome}/`))
    pairs.set(source.paths.pickFile, join(home, '.proof-pick/app-model-pick.json'))
  for (const path of [source.plan.libDir, ...(source.journal.recovery?.pinnedLibs ?? [])])
    if (![...pairs.keys()].some((p) => path === p || path.startsWith(`${p}/`)))
      pairs.set(path, join(home, '.proof-references', digest(Buffer.from(path)).slice(0, 16)))
  const map = (path: string): string => {
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new Error(`invalid relocation path: ${path}`)
    const match = [...pairs]
      .sort(([a], [b]) => b.length - a.length)
      .find(([from]) => path === from || path.startsWith(`${from}/`))
    if (!match) throw new Error(`unowned absolute target cannot be relocated: ${path}`)
    return `${match[1]}${path.slice(match[0].length)}`
  }
  const transform = (bytes: Buffer): Buffer => {
    // File data remains opaque unless it is valid text containing a relocated reference.
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      return bytes
    }
    for (const [from, to] of [...pairs].sort(([a], [b]) => b.length - a.length))
      text = text.replaceAll(from, to)
    return Buffer.from(text)
  }
  return { map, transform }
}
function moveState(
  state: FileState,
  oldTarget: string,
  scratch: Pick<Scratch, 'map' | 'transform'>,
  bytes?: Buffer,
): Saved {
  const moved = { ...state }
  if (state.link)
    moved.link = isAbsolute(state.link)
      ? scratch.map(state.link)
      : relative(
          dirname(scratch.map(oldTarget)),
          scratch.map(resolve(dirname(oldTarget), state.link)),
        )
  if (bytes) {
    const transformed = scratch.transform(bytes)
    moved.sha = digest(transformed)
    return { state: moved, bytes: transformed }
  }
  return { state: moved }
}
function put(path: string, value: Saved): void {
  safeParents(path)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (value.bytes) {
    writeFileSync(path, value.bytes)
    chmodSync(path, value.state.mode ?? 0o600)
  } else if (value.state.link) symlinkSync(value.state.link, path)
}
function remapJournal(source: SourceSnapshot, scratch: Scratch): void {
  if (!statAt(enginePaths(source.root).layers)) {
    writeLayers(scratch.root, {
      version: 1,
      layers: [],
      recovery: {
        entry: join(scratch.root, 'recovery/anyengine-off'),
        controlLib: scratch.plan.libDir,
        pinnedLibs: [scratch.plan.libDir],
      },
    })
    return
  }
  const journal = structuredClone(source.journal)
  for (const layer of journal.layers) {
    const oldDir = layer.rollbackDir
    layer.rollbackDir = scratch.map(oldDir)
    mkdirSync(layer.rollbackDir, { recursive: true, mode: 0o700 })
    if (layer.adoptedFrom) layer.adoptedFrom = scratch.map(layer.adoptedFrom)
    if (layer.claudeCode)
      layer.claudeCode.settingsTarget = scratch.map(layer.claudeCode.settingsTarget)
    for (const change of layer.changes) {
      const oldTarget = change.target
      const move = (state: FileState): FileState => {
        const value = moveState(
          state,
          oldTarget,
          scratch,
          state.bytes ? source.files.get(join(oldDir, state.bytes))?.bytes : undefined,
        )
        if (value.bytes) value.state.bytes = keepBytes(layer.rollbackDir, value.bytes)
        return value.state
      }
      const before = move(beforeState(change))
      const settled = move(settledState(change))
      change.target = scratch.map(oldTarget)
      Object.assign(change, {
        before: before.kind,
        backup: before.bytes,
        mode: before.mode,
        beforeSha: before.sha,
        beforeLink: before.link,
      })
      setSettled(change, settled)
      if (change.pending) change.pending = move(change.pending)
      if (change.lastGood) change.lastGood = move(change.lastGood)
    }
    for (const record of [layer.sharedConfig, layer.upgrade?.sharedConfig])
      if (record) {
        record.target = scratch.map(record.target)
        record.pickFile = scratch.map(record.pickFile)
      }
  }
  if (journal.recovery) {
    journal.recovery.entry = scratch.map(journal.recovery.entry)
    journal.recovery.controlLib = scratch.map(journal.recovery.controlLib)
    journal.recovery.pinnedLibs = journal.recovery.pinnedLibs.map(scratch.map)
  }
  // A copied journal is published only after all relocated bytes validate.
  validateLayers(scratch.root, journal)
  writeFileSync(enginePaths(scratch.root).layers, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
  })
  readLayers(scratch.root)
}
function toolExec(home: string, command: string, args: string[]): ExecResult {
  const result = spawnSync('/bin/bash', [command, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    env: { HOME: home, PATH: '/usr/bin:/bin' },
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr || String(result.error ?? ''),
  }
}
function proofTools(home: string) {
  const dir = join(home, '.proof-tools')
  mkdirSync(dir, { recursive: true })
  const jobDir = join(dir, 'jobs')
  mkdirSync(jobDir)
  const tool = (name: string, body: string) => {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o700 })
    return path
  }
  const uid = process.getuid?.() ?? 0
  const launchctl = tool(
    'launchctl',
    `jobs=${shellQuote(jobDir)}
printf '%s\\n' "$*" >> ${shellQuote(join(dir, 'calls'))}
case "$1" in
print)
  [ "$2" = gui/${uid} ] && { echo domain; exit 0; }
  label="\${2##*/}"
  case "$label" in dev.anyengine.router|dev.anyengine.smoke) ;; *) exit 65;; esac
  [ -f "$jobs/$label" ] && { echo 'pid = 4242'; exit 0; }
  printf 'Bad request.\\nCould not find service "%s" in domain for user gui: ${uid}\\n' "$label" >&2; exit 113;;
bootstrap) label="\${3##*/}"; label="\${label%.plist}"; [ -f "$3" ] || exit 65; : > "$jobs/$label";;
bootout) label="\${2##*/}"; /bin/rm -f "$jobs/$label";;
kickstart) label="\${3##*/}"; [ -f "$jobs/$label" ];;
*) exit 65;; esac`,
  )
  const appState = join(dir, 'app-state')
  writeFileSync(appState, 'down')
  const commands = {
    launchctl,
    plutil: tool(
      'plutil',
      `[ "$6" = ${shellQuote(join(home, 'Applications/Proof.app/Contents/Info.plist'))} ] || exit 65; printf 'ProofExecutable\\n'`,
    ),
    pgrep: tool(
      'pgrep',
      `[ "$1" = -f ] || exit 65; case "$2" in *ProofExecutable*) ;; *) exit 65;; esac
state="$(/bin/cat ${shellQuote(appState)})"
case "$state" in down) exit 1;; up) echo 12345;; *) exit 2;; esac`,
    ),
    osascript: tool('osascript', 'exit 97'),
    open: tool('open', 'exit 97'),
  }

  tool('node', 'exit 98')
  tool('claude', 'exit 98')
  const execute = (args: string[]) => toolExec(home, launchctl, args)
  return { commands, execute, jobDir }
}
export function createScratch(source: SourceSnapshot, home: string): Scratch {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const { map, transform } = relocated(source, home)
  const tools = proofTools(home)
  const forbidden = (): never => {
    throw new Error('scratch proof cannot operate an app or external command')
  }
  const observed = realSystem(
    {
      HOME: home,
      ANYENGINE_CHATGPT_APP: map(source.plan.app),
      ANYENGINE_PLUTIL: tools.commands.plutil,
      ANYENGINE_PGREP: tools.commands.pgrep,
    },
    (command, args) => {
      if (![tools.commands.plutil, tools.commands.pgrep].includes(command)) return forbidden()
      return toolExec(home, command, args)
    },
  )
  const system: System = {
    ...observed,
    appVersion: () => null,
    processes: () => [],
    quitApp: forbidden,
    openApp: forbidden,
    notify: forbidden,
    exec: forbidden,
    sleep: async () => {},
    launchctl: tools.execute,
  }
  const plan = {
    ...source.plan,
    libDir: map(source.plan.libDir),
    node: map(source.plan.node),
    claudeCli: source.plan.claudeCli ? map(source.plan.claudeCli) : null,
    shimSource: map(source.plan.shimSource),
    launcherSource: map(source.plan.launcherSource),
    app: system.app,
    recoveryCommands: tools.commands,
  }
  const scratch: Scratch = {
    home,
    root: map(source.root),
    paths: { codexHome: map(source.paths.codexHome), pickFile: map(source.paths.pickFile) },
    plan,
    system,
    map,
    transform,
    targets: new Map(),
  }
  for (const [path, value] of source.files) {
    if (
      path === enginePaths(source.root).layers ||
      path.endsWith('/ROLLBACK.sh') ||
      path === join(source.root, 'recovery/anyengine-off') ||
      path === join(source.root, 'RECOVER.txt')
    )
      continue
    const moved = moveState(value.state, path, scratch, value.bytes)
    put(map(path), moved)
    if (source.targets.has(path)) scratch.targets.set(map(path), moved)
  }
  mkdirSync(plan.libDir, { recursive: true })
  for (const saved of scratch.targets.values())
    if (saved.state.link && !isAbsolute(saved.state.link) && !saved.state.link.includes('/'))
      mkdirSync(join(scratch.root, 'lib', saved.state.link), { recursive: true })
  mkdirSync(enginePaths(scratch.root).state, { recursive: true })
  remapJournal(source, scratch)
  withFileLock(join(scratch.root, 'config.json.lock'), () => {})
  for (const layer of readLayers(scratch.root).layers)
    for (const label of layer.jobs) {
      const change = layer.changes.find(
        (c) => c.target === join(home, `Library/LaunchAgents/${label}.plist`),
      )
      if (!change) throw new Error(`job ownership has no recorded plist: ${label}`)
      if (settledState(change).kind !== 'absent') writeFileSync(join(tools.jobDir, label), '')
    }
  publishRecovery({
    root: scratch.root,
    app: plan.app,
    bundleId: plan.bundleId,
    codexHome: scratch.paths.codexHome,
    commands: tools.commands,
  })
  return scratch
}
