import assert from 'node:assert/strict'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { applyOnFiles, applySharedConfig, type OnPlan } from '../src/control-install.mjs'
import { readLayers } from '../src/control-layers.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { strictJobs } from './helpers/flip-deps.mjs'
import { fakeLib, m0Home, pathsFor } from './helpers/m0-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
function state(path: string): unknown {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return { absent: true }
  return {
    mode: stat.mode & 0o7777,
    value: stat.isDirectory()
      ? readdirSync(path)
          .sort()
          .map((name) => [name, state(join(path, name))])
      : stat.isSymbolicLink()
        ? readlinkSync(path)
        : readFileSync(path),
  }
}
for (const key of ['open', 'launchctl', 'osascript', 'pgrep', 'plutil', 'unsupported'])
  test(`direct shared config rejects ${key} tool before authority and allows corrected retry`, async () => {
    const home = await m0Home()
    const system = fakeSystem(home)
    system.running = false
    strictJobs(system)
    const root = join(home, '.anyengine')
    const plan = fakeLib(home)
    const paths = pathsFor(home)
    applyOnFiles(system, root, plan, { dryRun: false, paths })
    const router = readLayers(root).layers.find((layer) => layer.name === 'router')
    assert.ok(router)
    const config = join(paths.codexHome, 'config.toml')
    const watched = [
      join(root, 'state/layers.json'),
      router.rollbackDir,
      config,
      paths.pickFile,
      join(root, 'recovery'),
      join(root, 'bin/anyengine-off'),
    ]
    const before = watched.map(state)
    const configBefore = readFileSync(config)
    const commands = {
      [key]: key === 'unsupported' ? '/usr/bin/false' : 'relative',
    } as NonNullable<OnPlan['recoveryCommands']>
    assert.throws(
      () =>
        applySharedConfig(
          system,
          root,
          { ...plan, recoveryCommands: commands },
          { dryRun: false, paths },
        ),
      /absolute|unsupported/,
    )
    assert.deepEqual(watched.map(state), before)
    const result = applySharedConfig(system, root, plan, { dryRun: false, paths })
    assert.ok(result.removed.length)
    assert.deepEqual(readFileSync(join(router.rollbackDir, 'config.toml.bak')), configBefore)
    assert.ok(readLayers(root).layers.find((layer) => layer.name === 'router')?.sharedConfig)
  })
