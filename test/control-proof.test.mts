import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { DEFAULT_CONFIG, writeJsonAtomic } from '../src/anyengine-config.mjs'
import { applyOnFiles, applySharedConfig } from '../src/control-install.mjs'
import { LayerWriter, readLayers } from '../src/control-layers.mjs'
import { proveRollback } from '../src/control-proof.mjs'
import { shellQuote } from '../src/control-scripts.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { strictJobs } from './helpers/flip-deps.mjs'
import { fakeLib, m0Home, pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

for (const record of ['config', 'pick', 'manifest', 'proof', 'known-good', 'smoke'])
  test(`proof rejects invalid UTF8 in ${record}, retains exact bytes and creates no scratch state`, async () => {
    const home = await m0Home()
    const root = join(home, '.anyengine')
    const plan = fakeLib(home)
    const path =
      record === 'config'
        ? join(root, 'config.json')
        : record === 'pick'
          ? pathsFor(home).pickFile
          : record === 'manifest'
            ? join(root, 'rollback-20260930T114234Z/manifest.json')
            : join(root, 'state', `${record === 'proof' ? 'proven' : record}.json`)
    mkdirSync(join(path, '..'), { recursive: true })
    const bad = Buffer.from('{"name":"X"}')
    bad[bad.indexOf('X')] = 0xff
    writeFileSync(path, bad)
    const scratchParent = await tempDir('proof-parent-')
    const result = proveRollback(fakeSystem(home), root, plan, {
      paths: pathsFor(home),
      scratchParent,
    })
    assert.equal(result.ok, false)
    assert.deepEqual(readFileSync(path), bad)
    assert.deepEqual(readdirSync(scratchParent), [])
  })

test('new install without M0 receipts restores initial absence and retains exact valid default preferences', async () => {
  const home = await tempDir('proof-new-')
  const plan = fakeLib(home)
  mkdirSync(join(home, '.codex'))
  const result = proveRollback(fakeSystem(home), join(home, '.anyengine'), plan, {
    paths: pathsFor(home),
    scratchParent: await tempDir('proof-parent-'),
  })
  assert.ok(result.ok, result.lines.join('\n'))
})

for (const target of [
  '.anyengine/bin/anyengine-off',
  '.anyengine/config.json',
  '.anyengine/recovery/anyengine-off',
])
  test(`proof detects unexpected retained ${target} edits`, async () => {
    const home = await m0Home()
    const result = proveRollback(fakeSystem(home), join(home, '.anyengine'), fakeLib(home), {
      paths: pathsFor(home),
      scratchParent: await tempDir('proof-parent-'),
      afterOn: (scratch) => writeFileSync(join(scratch, target), 'unexpected changed bytes\n'),
    })
    assert.equal(result.ok, false)
    assert.ok(
      result.lines.some((line) => line.includes(target)),
      result.lines.join('\n'),
    )
  })

test('source recovery pins, initial backup and immediate M1 last-good baseline survive proof', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  strictJobs(system)
  system.running = false
  const plan = fakeLib(home)
  const config = structuredClone(DEFAULT_CONFIG)
  config.smoke.enabled = false
  writeJsonAtomic(join(root, 'config.json'), { ...config, note: '\uFFFD' })
  applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
  applySharedConfig(system, root, plan, { dryRun: false, paths: pathsFor(home) })
  const before = readFileSync(join(root, 'state/layers.json'))
  const result = proveRollback(system, root, plan, {
    paths: pathsFor(home),
    scratchParent: await tempDir('proof-parent-'),
  })
  assert.ok(result.ok, result.lines.join('\n'))
  assert.deepEqual(readFileSync(join(root, 'state/layers.json')), before)
  assert.ok(readLayers(root).recovery?.pinnedLibs.length)
})

test('an installed M1 public launcher survives M2 upgrade last-good proof unchanged', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const system = fakeSystem(home)
  strictJobs(system)
  system.running = false
  const plan = fakeLib(home)
  applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
  const adapter = readLayers(root).layers.find((layer) => layer.name === 'adapter')
  assert.ok(adapter)
  const oldLauncher = `#!/bin/bash\nexec /bin/bash ${shellQuote(join(root, 'recovery/anyengine-off'))} "$@"\n`
  new LayerWriter(root, adapter, 'adapter', 'm1-public').writeFile(
    join(root, 'bin/anyengine-off'),
    oldLauncher,
    0o755,
  )
  const before = readFileSync(join(root, 'state/layers.json'))
  const result = proveRollback(system, root, plan, {
    paths: pathsFor(home),
    scratchParent: await tempDir('proof-parent-'),
  })
  assert.ok(result.ok, result.lines.join('\n'))
  assert.deepEqual(readFileSync(join(root, 'state/layers.json')), before)
  assert.equal(readFileSync(join(root, 'bin/anyengine-off'), 'utf8'), oldLauncher)
})

test('generation-time recovery tools reject relative paths before files, preferences or recovery artifacts', async () => {
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const plan = fakeLib(home)
  const system = fakeSystem(home)
  strictJobs(system)
  const before = readdirSync(root)
  assert.throws(
    () =>
      applyOnFiles(
        system,
        root,
        { ...plan, recoveryCommands: { open: 'relative' } },
        { dryRun: false, paths: pathsFor(home) },
      ),
    /absolute/,
  )
  assert.deepEqual(readdirSync(root), before)
})

test('proof refuses external symlink targets, preserving the original link and outside bytes', async () => {
  const home = await m0Home()
  const outside = await tempDir('outside-proof-')
  const plan = fakeLib(home)
  const root = join(home, '.anyengine')
  const target = join(outside, 'original')
  writeFileSync(target, 'outside')
  mkdirSync(join(root, 'bin'), { recursive: true })
  symlinkSync(target, join(root, 'bin/anyengine-off'))
  const result = proveRollback(fakeSystem(home), root, plan, {
    paths: pathsFor(home),
    scratchParent: await tempDir('proof-parent-'),
  })
  assert.equal(result.ok, false)
  assert.match(result.lines.join('\n'), /unowned absolute target/)
  assert.equal(readFileSync(target, 'utf8'), 'outside')
})

test('mode changes after on are named without silently restoring or certifying success', async () => {
  const home = await m0Home()
  const result = proveRollback(fakeSystem(home), join(home, '.anyengine'), fakeLib(home), {
    paths: pathsFor(home),
    scratchParent: await tempDir('proof-parent-'),
    afterOn: (scratch) => chmodSync(join(scratch, 'bin/codex'), 0o600),
  })
  assert.equal(result.ok, false)
  assert.match(result.lines.join('\n'), /bin\/codex/)
})

test('indirect source parent is refused before reading outside target bytes', async () => {
  const { rmSync } = await import('node:fs')
  const home = await m0Home()
  const plan = fakeLib(home)
  const outside = await tempDir('outside-proof-')
  writeFileSync(join(outside, 'config.toml'), Buffer.from([0xff]))
  rmSync(join(home, '.codex'), { recursive: true })
  symlinkSync(outside, join(home, '.codex'))
  const scratchParent = await tempDir('proof-parent-')
  const result = proveRollback(fakeSystem(home), join(home, '.anyengine'), plan, {
    paths: pathsFor(home),
    scratchParent,
  })
  assert.equal(result.ok, false)
  assert.match(result.lines.join('\n'), /indirect scratch\/source parent/)
  assert.deepEqual(readdirSync(scratchParent), [])
})

test('indirect scratch parent cannot create a proof inside the observed source home', async () => {
  const home = await m0Home()
  const plan = fakeLib(home)
  const outside = await tempDir('proof-parent-')
  const parent = join(outside, 'indirect')
  symlinkSync(home, parent)
  const before = readdirSync(home)
  const result = proveRollback(fakeSystem(home), join(home, '.anyengine'), plan, {
    paths: pathsFor(home),
    scratchParent: parent,
  })
  assert.equal(result.ok, false)
  assert.match(result.lines.join('\n'), /indirect scratch\/source parent/)
  assert.deepEqual(readdirSync(home), before)
})

for (const state of ['up', 'unknown'])
  test(`scratch ${state} app observation refuses recovery and preserves source`, async () => {
    const home = await m0Home()
    const result = proveRollback(fakeSystem(home), join(home, '.anyengine'), fakeLib(home), {
      paths: pathsFor(home),
      scratchParent: await tempDir('proof-parent-'),
      afterOn: (scratch) => writeFileSync(join(scratch, '.proof-tools/app-state'), state),
    })
    assert.equal(result.ok, false)
    assert.match(result.lines.join('\n'), /app|running|unknown|query/)
  })

test('source SQLite coordination is opaque and scratch paths with spaces are fully relocated', async () => {
  const { statSync } = await import('node:fs')
  const { withFileLock } = await import('../src/file-lock.mjs')
  const { sourceSnapshot } = await import('../src/control-proof-snapshot.mjs')
  const home = await m0Home()
  const root = join(home, '.anyengine')
  const plan = fakeLib(home)
  withFileLock(join(root, 'config.json.lock'), () => {})
  const database = join(root, 'config.json.lock.sqlite')
  const before = statSync(database)
  const source = sourceSnapshot(fakeSystem(home), root, plan, pathsFor(home))
  assert.equal(
    [...source.files.keys()].some((path) => /\.(db|sqlite)(?:-|$)/.test(path)),
    false,
  )
  const result = proveRollback(fakeSystem(home), root, plan, {
    paths: pathsFor(home),
    scratchParent: await tempDir("proof space ' é-"),
  })
  assert.ok(result.ok, result.lines.join('\n'))
  const after = statSync(database)
  assert.deepEqual([after.dev, after.ino, after.size], [before.dev, before.ino, before.size])
})

for (const corrupt of ['pending', 'POPPED', 'backup'])
  test(`unsupported ${corrupt} authority remains byte-exact and cannot pass proof`, async () => {
    const home = await m0Home()
    const root = join(home, '.anyengine')
    const plan = fakeLib(home)
    const system = fakeSystem(home)
    strictJobs(system)
    applyOnFiles(system, root, plan, { dryRun: false, paths: pathsFor(home) })
    const layer = readLayers(root).layers.find((layer) => layer.name === 'router')
    assert.ok(layer)
    if (corrupt === 'pending') {
      const raw = JSON.parse(readFileSync(join(root, 'state/layers.json'), 'utf8'))
      raw.layers.find((item: { name: string }) => item.name === 'router').pending = 'after-quit'
      writeFileSync(join(root, 'state/layers.json'), JSON.stringify(raw))
    } else if (corrupt === 'POPPED')
      writeFileSync(join(layer.rollbackDir, 'POPPED'), 'invalid marker')
    else {
      const change = layer.changes.find((change) => change.after)
      assert.ok(change?.after)
      writeFileSync(join(layer.rollbackDir, change.after), 'changed backup')
    }
    const journal = readFileSync(join(root, 'state/layers.json'))
    const result = proveRollback(system, root, plan, {
      paths: pathsFor(home),
      scratchParent: await tempDir('proof-parent-'),
    })
    assert.equal(result.ok, false, result.lines.join('\n'))
    assert.deepEqual(readFileSync(join(root, 'state/layers.json')), journal)
  })

test('failed Bash recovery reaps its exact owned background family before scratch removal', async () => {
  const { existsSync } = await import('node:fs')
  const home = await m0Home()
  const scratchParent = await tempDir('proof-parent-')
  const children: number[] = []
  const result = proveRollback(fakeSystem(home), join(home, '.anyengine'), fakeLib(home), {
    paths: pathsFor(home),
    scratchParent,
    afterOn: (scratch) => {
      const index = Number(scratch.split('/').at(-1))
      for (const previous of [0, 2, 3].filter((previous) => previous < index)) {
        const pidFile = join(scratch, '..', String(previous), '.proof-tools/family.pid')
        if (existsSync(pidFile)) children.push(Number(readFileSync(pidFile, 'utf8')))
      }
      writeFileSync(
        join(scratch, '.anyengine/recovery/anyengine-off'),
        '#!/bin/bash\n/bin/sleep 60 >/dev/null 2>&1 &\necho $! > "$HOME/.proof-tools/family.pid"\nexit 42\n',
      )
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.lines.join('\n'), /Bash status 42/)
  assert.ok(children.length >= 3)
  for (const pid of children) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.deepEqual(readdirSync(scratchParent), [])
})
