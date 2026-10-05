import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { InstallPaths, OnPlan } from '../../src/control-install.mjs'
import { tempDir } from './tmp.mjs'

export async function m0Home(): Promise<string> {
  const home = await tempDir('anyengine-layers-')
  cpSync('test/fixtures/m0-live-layout/home', home, { recursive: true })
  for (const dir of readdirSync(join(home, '.anyengine'))) {
    if (!dir.startsWith('rollback-')) continue
    const manifest = join(home, '.anyengine', dir, 'manifest.json')
    if (!existsSync(manifest)) continue
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replaceAll('@HOME@', home))
  }
  chmodSync(join(home, 'bin', 'codex'), 0o755)
  symlinkSync('0.1.0-986ab707750e', join(home, '.anyengine/lib/current'))
  return home
}

export function fakeLib(home: string, version = '0.1.0-m1test'): OnPlan {
  const libDir = join(home, '.anyengine', 'lib', version)
  mkdirSync(join(libDir, 'scripts'), { recursive: true })
  const shimSource = join(libDir, 'scripts', 'codex-shim')
  const launcherSource = join(libDir, 'scripts', 'anyengine-launch')
  const claudeCli = join(home, 'tools with space', "claude's cli")
  mkdirSync(join(claudeCli, '..'), { recursive: true })
  writeFileSync(claudeCli, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(shimSource, '#!/bin/bash\n# anyengine codex shim (marker: ANYENGINE_ADAPTER) m1\n')
  writeFileSync(launcherSource, '#!/bin/bash\nexit 0\n')
  return {
    version,
    libDir,
    node: process.execPath,
    claudeCli,
    shimSource,
    launcherSource,
    stamp: '20261001T000000Z',
    app: join(home, 'Applications/ChatGPT.app'),
    bundleId: 'com.openai.codex',
  }
}

export function pathsFor(home: string): InstallPaths {
  return {
    codexHome: join(home, '.codex'),
    pickFile: join(home, '.codex/anyengine/app-model-pick.json'),
  }
}
