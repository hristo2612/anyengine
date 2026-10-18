// Retained recovery belongs to its journal-recorded controller, even when a
// newer controller is running. A validated interrupted publication can settle
// attribution without republishing any recovery bytes.
import { basename, dirname, join } from 'node:path'
import { executingLib, flipPaths } from './control-flip-options.mjs'
import type { FlipContext } from './control-flip-recovery.mjs'
import { object } from './control-layer-state.mjs'
import { type LayerFile, readLayers, recoveryPaths } from './control-layers.mjs'
import { directDirectory, evidence } from './control-recovery-authority.mjs'
import { generationOptions } from './control-recovery-generation.mjs'
import { inspectRecoveryPublication } from './control-recovery-publication.mjs'
import { offScript, type RecoveryOptions } from './control-scripts.mjs'

// A fresh process avoids accepting a cached module from an older manifest.
// Paths/options are argv/stdin data; no generated code or shell interpolation.
const generateRecorded = `import { pathToFileURL } from 'node:url'
let input = ''
for await (const chunk of process.stdin) input += chunk
const { layers, options } = JSON.parse(input)
const { offScript } = await import(pathToFileURL(process.argv[1]).href)
process.stdout.write(offScript(layers, options))
`
export function validateRetainedRecovery(
  ctx: Pick<FlipContext, 'root' | 'system' | 'deps'>,
  file: LayerFile,
): ((checkpoint: () => void) => void) | undefined {
  const { root, system, deps } = ctx
  const paths = recoveryPaths(root)
  const pending = inspectRecoveryPublication(root)
  const recorded = pending?.file ?? file
  for (const directory of [root, dirname(paths.journal), paths.directory])
    directDirectory(directory)
  const frozen = [
    [pending?.journalPath ?? paths.journal, 0o600],
    [paths.entry, 0o700],
    [paths.instructions, 0o600],
  ] as const
  const identities = frozen.map(([path, mode]) => evidence(path, mode).identity)
  const unchanged = () => {
    for (const directory of [root, dirname(paths.journal), paths.directory])
      directDirectory(directory)
    if (
      frozen.some(([path, mode], index) => evidence(path, mode).identity !== identities[index]) ||
      JSON.stringify(readLayers(root)) !== JSON.stringify(file)
    )
      throw new Error('retained recovery authority changed; preserve existing authority')
  }
  unchanged()
  const recovery = recorded.recovery
  if (!recovery) throw new Error('missing retained recovery authority')
  const options: RecoveryOptions = {
    root,
    app: system.app,
    bundleId: 'com.openai.codex',
    codexHome: flipPaths(system).codexHome,
  }
  if (pending && JSON.stringify(pending.generation) !== JSON.stringify(generationOptions(options)))
    throw new Error('recovery publication generation options changed; preserve evidence')
  const controlLib = pending?.controlLib ?? recovery.controlLib
  let expected: string
  if (controlLib === executingLib()) expected = offScript(recorded.layers, options)
  else {
    const lib = controlLib
    if (
      dirname(lib) !== join(root, 'lib') ||
      basename(lib) === 'current' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(basename(lib)) ||
      !recovery.pinnedLibs.includes(lib)
    )
      throw new Error('invalid recorded recovery library; preserve existing authority')
    directDirectory(dirname(lib))
    directDirectory(lib)
    const manifestPath = join(lib, 'install-manifest.json')
    const manifest = evidence(manifestPath)
    const value: unknown = JSON.parse(manifest.bytes.toString('utf8'))
    const generator = 'dist/src/control-scripts.mjs'
    if (!object(value) || !object(value.files) || !Object.hasOwn(value.files, generator))
      throw new Error('recorded recovery generator is not manifested')
    const verify = () => {
      directDirectory(lib)
      if (evidence(manifestPath).identity !== manifest.identity)
        throw new Error('recorded recovery manifest changed; preserve existing authority')
      const problems = deps.verifyLib(lib)
      if (problems.length) throw new Error(problems.join('; '))
      evidence(join(lib, generator))
      if (evidence(manifestPath).identity !== manifest.identity)
        throw new Error('recorded recovery manifest changed; preserve existing authority')
      unchanged()
    }
    verify() // Admit every immutable byte before executing recorded code.
    const result = system.exec(
      process.execPath,
      ['--input-type=module', '-e', generateRecorded, join(lib, generator)],
      {
        timeoutMs: 30_000,
        env: { HOME: system.home, PATH: '/usr/bin:/bin' },
        input: JSON.stringify({ layers: recorded.layers, options }),
      },
    )
    verify()
    if (result.status !== 0)
      throw new Error('recorded recovery generation failed; preserve existing authority')
    expected = result.stdout
  }
  unchanged()
  pending?.unchanged()
  if (!evidence(paths.entry, 0o700).bytes.equals(Buffer.from(expected)))
    throw new Error('private recovery entry changed; preserve existing authority')
  return pending
    ? (checkpoint) => {
        unchanged()
        pending.settle(checkpoint)
      }
    : undefined
}

// Called by the locked Node owner before its forward scratch proof. This only
// retires already-completed Bash authority; it never restores files or jobs.
export function settleTerminalRecovery(
  ctx: Pick<FlipContext, 'root' | 'system' | 'deps'>,
): boolean {
  const pending = inspectRecoveryPublication(ctx.root)
  if (!pending?.terminal) return false
  const settle = validateRetainedRecovery(ctx, readLayers(ctx.root))
  if (!settle) throw new Error('terminal publication settlement unavailable')
  settle(() => {})
  return true
}
