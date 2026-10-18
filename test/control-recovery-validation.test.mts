import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { runOff } from '../src/control-flip.mjs'
import { executingLib } from '../src/control-flip-options.mjs'
import { prepareRecovery, retireUpgrade } from '../src/control-flip-recovery.mjs'
import { applyOnFiles } from '../src/control-install.mjs'
import { persistRecord } from '../src/control-install-on.mjs'
import { LayerWriter, readLayers, writeLayers } from '../src/control-layers.mjs'
import { offScript, publishRecovery } from '../src/control-scripts.mjs'
import { fakeLib, pathsFor } from './helpers/m0-home.mjs'
import {
  generations,
  type Retained,
  recordedScript,
  retained,
  tree,
} from './helpers/retained-recovery.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
async function refuses(s: Retained, before = tree(s.root)) {
  assert.equal(
    await runOff(s.ctx, {
      yes: true,
      waitQuietMinutes: 0,
      force: false,
      foreground: true,
      follow: false,
      routerOnly: false,
      noRestart: false,
    }),
    1,
  )
  assert.deepEqual(s.phases, [], 'refusal must precede off-files intent')
  assert.ok(!s.system.calls.includes('quitApp'), 'refusal must precede app quit')
  assert.deepEqual(
    tree(s.root),
    before,
    'every authority inode, pin and byte must remain unchanged',
  )
}
test('retained 0.1.1 entry is admitted by its verified recorded controller after version selection changed', async () => {
  const s = await retained()
  assert.equal(s.deps.currentSnapshot().libDir, s.plan.libDir)
  assert.notEqual(
    readFileSync(s.paths.entry, 'utf8'),
    offScript(readLayers(s.root).layers, s.options),
  )
  const before = tree(s.root)
  prepareRecovery(s.ctx)
  assert.deepEqual(tree(s.root), before)
  assert.equal(generations(s).length, 1)
  assert.equal(
    s.executions.length,
    3,
    'verify immutable bytes before and after recorded generation',
  )
  assert.deepEqual(s.phases, [])
  assert.ok(!s.system.calls.includes('quitApp'))
})
const badCases: Record<string, (s: Retained) => void> = {
  'changed entry': (s) => writeFileSync(s.paths.entry, '#!/bin/bash\nexit 0\n'),
  'missing entry': (s) => unlinkSync(s.paths.entry),
  'unsafe entry mode': (s) => chmodSync(s.paths.entry, 0o770),
  'setuid entry': (s) => chmodSync(s.paths.entry, 0o4700),
  'symlink entry': (s) => {
    renameSync(s.paths.entry, join(s.home, 'moved-entry'))
    symlinkSync(join(s.home, 'moved-entry'), s.paths.entry)
  },
  'unsafe recovery directory': (s) => chmodSync(s.paths.directory, 0o777),
  'missing instructions': (s) => unlinkSync(s.paths.instructions),
  'unsafe journal mode': (s) => chmodSync(s.paths.journal, 0o666),
  'malformed journal': (s) => writeFileSync(s.paths.journal, '{'),
  'unpinned controller': (s) => {
    const journal = readLayers(s.root)
    assert.ok(journal.recovery)
    journal.recovery.pinnedLibs = [s.plan.libDir]
    writeFileSync(s.paths.journal, JSON.stringify(journal))
  },
  'unrelated controller': (s) => {
    const outside = join(s.home, 'unrelated-controller')
    renameSync(s.lib, outside)
    const journal = readLayers(s.root)
    assert.ok(journal.recovery)
    journal.recovery.controlLib = outside
    journal.recovery.pinnedLibs.push(outside)
    writeLayers(s.root, journal)
  },
  'current alias': (s) => {
    const journal = readLayers(s.root)
    assert.ok(journal.recovery)
    journal.recovery.controlLib = join(s.root, 'lib/current')
    journal.recovery.pinnedLibs.push(journal.recovery.controlLib)
    writeLayers(s.root, journal)
  },
  'symlink controller': (s) => {
    renameSync(s.lib, join(s.home, 'moved-controller'))
    symlinkSync(join(s.home, 'moved-controller'), s.lib)
  },
  'unsafe controller directory': (s) => chmodSync(s.lib, 0o777),
  'missing manifest': (s) => unlinkSync(join(s.lib, 'install-manifest.json')),
  'invalid manifest': (s) => writeFileSync(join(s.lib, 'install-manifest.json'), '{}'),
  'missing controller': (s) => renameSync(s.lib, join(s.home, 'missing-controller')),
  'changed generator': (s) =>
    writeFileSync(join(s.lib, 'dist/src/control-scripts.mjs'), 'throw Error("must not load")'),
  'changed generator dependency': (s) =>
    writeFileSync(join(s.lib, 'dist/src/recovery-template.mjs'), 'throw Error("must not load")'),
  'missing generator dependency': (s) => unlinkSync(join(s.lib, 'dist/src/recovery-template.mjs')),
  'unmanifested file': (s) => writeFileSync(join(s.lib, 'unmanifested.mjs'), '// unexpected'),
  'unmanifested generator': (s) => {
    const path = join(s.lib, 'install-manifest.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    delete manifest.files['dist/src/control-scripts.mjs']
    writeFileSync(path, JSON.stringify(manifest))
  },
  'current template unrelated to recorded controller': (s) =>
    writeFileSync(s.paths.entry, offScript(readLayers(s.root).layers, s.options)),
}
for (const [name, change] of Object.entries(badCases))
  test(`${name} refuses before quit and preserves all retained authority`, async () => {
    const s = await retained()
    change(s)
    await refuses(s)
    if (!['changed entry', 'current template unrelated to recorded controller'].includes(name))
      assert.equal(generations(s).length, 0, 'unadmitted controller must not be imported')
  })
for (const changed of [
  'journal',
  'entry',
  'instructions',
  'manifest',
  'dependency',
  'directory',
] as const)
  test(`${changed} changed during generation refuses without overwriting the changed evidence`, async () => {
    const s = await retained()
    const execute = s.system.exec
    let afterChange: Record<string, unknown> | undefined
    s.system.exec = (command, args, options) => {
      const result = execute(command, args, options)
      if (args[0] === '--input-type=module') {
        if (changed === 'journal') {
          const journal = readLayers(s.root)
          assert.ok(journal.recovery)
          journal.recovery.pinnedLibs.push(join(s.root, 'lib/another-pin'))
          writeLayers(s.root, journal)
        } else if (changed === 'entry') {
          const bytes = readFileSync(s.paths.entry)
          unlinkSync(s.paths.entry)
          writeFileSync(s.paths.entry, bytes, { mode: 0o700 })
        } else if (changed === 'directory') {
          chmodSync(s.paths.directory, 0o777)
        } else {
          const path =
            changed === 'instructions'
              ? s.paths.instructions
              : changed === 'manifest'
                ? join(s.lib, 'install-manifest.json')
                : join(s.lib, 'dist/src/recovery-template.mjs')
          writeFileSync(path, `${readFileSync(path, 'utf8')}\n`)
        }
        afterChange = tree(s.root)
      }
      return result
    }
    const result = await runOff(s.ctx, {
      yes: true,
      waitQuietMinutes: 0,
      force: false,
      foreground: true,
      follow: false,
      routerOnly: false,
      noRestart: false,
    })
    assert.equal(result, 1)
    assert.ok(afterChange)
    assert.deepEqual(tree(s.root), afterChange)
    assert.deepEqual(s.phases, [])
    assert.ok(!s.system.calls.includes('quitApp'))
  })
test('manifest changed during initial verification is refused before importing recorded generator', async () => {
  const s = await retained()
  const verify = s.deps.verifyLib
  s.deps.verifyLib = (lib) => {
    const problems = verify(lib)
    const path = join(lib, 'install-manifest.json')
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n`)
    return problems
  }
  assert.throws(() => prepareRecovery(s.ctx), /manifest changed/)
  assert.equal(generations(s).length, 0)
})
test('recorded generation failure preserves authority and refuses before quit', async () => {
  const s = await retained()
  const execute = s.system.exec
  s.system.exec = (command, args, options) =>
    args[0] === '--input-type=module'
      ? { status: null, stdout: '', stderr: 'synthetic timeout' }
      : execute(command, args, options)
  await refuses(s)
  assert.ok(existsSync(s.paths.entry))
  assert.match(s.out.join(''), /recorded recovery generation failed/)
})

for (const option of ['app', 'codexHome'] as const)
  test(`changed generation option ${option} cannot authorize unrelated retained bytes`, async () => {
    const s = await retained()
    const options = { ...s.options, [option]: join(s.home, 'different-path') }
    writeFileSync(s.paths.entry, recordedScript(readLayers(s.root).layers, options))
    await refuses(s)
    assert.match(s.out.join(''), /recovery entry changed/)
  })

function currentAuthority(s: Retained, expectedPins: string[]): void {
  const journal = readLayers(s.root)
  assert.ok(journal.recovery)
  assert.equal(journal.recovery.controlLib, executingLib())
  for (const pin of [executingLib(), ...expectedPins])
    assert.ok(journal.recovery.pinnedLibs.includes(pin), `missing retained pin: ${pin}`)
  assert.equal(readFileSync(s.paths.entry, 'utf8'), offScript(journal.layers, s.options))
  const before = tree(s.root)
  prepareRecovery(s.ctx)
  assert.deepEqual(tree(s.root), before, 'new authority must validate without republishing')
}
for (const prepared of [false, true])
  test(`valid old journal to new On publishes current authority and retains prior pins; pre-quit preparation=${prepared}`, async () => {
    const s = await retained()
    prepareRecovery(s.ctx) // Establish that the old journal and entry really are admissible.
    const original = readLayers(s.root)
    assert.ok(original.recovery)
    const oldPins = [...original.recovery.pinnedLibs]
    const next = fakeLib(s.home, '0.1.2-new-on')
    if (prepared) {
      const current = readlinkSync(join(s.root, 'lib/current'))
      prepareRecovery(s.ctx, next.libDir)
      assert.equal(
        readlinkSync(join(s.root, 'lib/current')),
        current,
        'pre-quit preparation cannot select a library',
      )
      assert.ok(s.system.running)
      assert.ok(!s.system.calls.includes('quitApp'))
      currentAuthority(s, [...oldPins, next.libDir])
    }
    s.system.running = false
    const result = applyOnFiles(s.system, s.root, next, { dryRun: false, paths: pathsFor(s.home) })
    assert.equal(result.refused, null)
    assert.equal(readlinkSync(join(s.root, 'lib/current')), next.version)
    const router = readLayers(s.root).layers.find((layer) => layer.name === 'router')
    assert.ok(router?.upgrade, 'the immediate last-good baseline must survive publication')
    const selection = router.changes.find((change) => change.target === join(s.root, 'lib/current'))
    assert.equal(selection?.lastGood?.link, s.plan.version)
    currentAuthority(s, [...oldPins, next.libDir])
    assert.equal(
      generations(s).length,
      1,
      'completed new publication must not be validated with the old generator',
    )
  })
for (const publisher of ['direct', 'record callback', 'upgrade retirement'] as const)
  test(`${publisher} attributes replacement bytes to its current controller and preserves old pins`, async () => {
    const s = await retained()
    const original = readLayers(s.root)
    assert.ok(original.recovery)
    const oldPins = [...original.recovery.pinnedLibs]
    const layer = original.layers.find((layer) => layer.name === 'router')
    assert.ok(layer)
    if (publisher === 'direct') publishRecovery(s.options)
    else if (publisher === 'record callback')
      persistRecord(
        s.root,
        s.system,
        s.plan,
        pathsFor(s.home),
        original.layers,
      )(layer, 'checkpoint')
    else {
      new LayerWriter(s.root, layer, 'router', 'publication-upgrade').beginUpgrade()
      retireUpgrade(s.ctx, false)
      assert.equal(
        readLayers(s.root).layers.find((row) => row.name === 'router')?.upgrade,
        undefined,
      )
    }
    currentAuthority(s, oldPins)
    assert.equal(generations(s).length, 0)
  })
test('failed entry publication cannot advance the recorded controller or release old pins', async () => {
  const s = await retained()
  const journal = readFileSync(s.paths.journal)
  const saved = join(s.paths.directory, 'retained-entry')
  renameSync(s.paths.entry, saved)
  mkdirSync(s.paths.entry)
  assert.throws(() => publishRecovery(s.options))
  assert.deepEqual(readFileSync(s.paths.journal), journal)
  assert.equal(readFileSync(saved, 'utf8'), recordedScript(readLayers(s.root).layers, s.options))
})
