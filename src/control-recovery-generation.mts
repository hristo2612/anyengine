// Explicit immutable controller identity and normalized recovery generation data.
import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { absolute, digest, object, statAt } from './control-layer-state.mjs'
import { evidence } from './control-recovery-authority.mjs'
import type { RecoveryOptions } from './control-scripts.mjs'

const ownLib = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export function controllerIdentity(lib: string) {
  const manifest = join(lib, 'install-manifest.json')
  const path =
    lib === ownLib && !statAt(manifest) ? join(lib, 'dist/src/control-scripts.mjs') : manifest
  const frozen = evidence(path)
  return { path, mode: lstatSync(path).mode & 0o7777, sha: digest(frozen.bytes) }
}
export function sameControllerIdentity(value: unknown, lib: string): boolean {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'mode,path,sha') return false
  const actual = controllerIdentity(lib)
  return value.path === actual.path && value.mode === actual.mode && value.sha === actual.sha
}
const defaultCommands = {
  launchctl: '/bin/launchctl',
  osascript: '/usr/bin/osascript',
  open: '/usr/bin/open',
  pgrep: '/usr/bin/pgrep',
  plutil: '/usr/bin/plutil',
  curl: '/usr/bin/curl',
}
export function generationOptions(value: unknown) {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        !['root', 'app', 'bundleId', 'codexHome', 'commands', 'quitWaitSeconds'].includes(key),
    ) ||
    ![value.root, value.app, value.codexHome].every(absolute) ||
    typeof value.bundleId !== 'string' ||
    !/^[A-Za-z0-9.-]+$/.test(value.bundleId) ||
    (value.commands !== undefined &&
      (!object(value.commands) ||
        Object.keys(value.commands).some((key) => !Object.hasOwn(defaultCommands, key))))
  )
    throw new Error('invalid recovery publication generation options')
  const options = value as unknown as RecoveryOptions
  const quitWaitSeconds = options.quitWaitSeconds ?? 30
  const commands = { ...defaultCommands, ...options.commands }
  if (
    !Number.isInteger(quitWaitSeconds) ||
    quitWaitSeconds < 0 ||
    quitWaitSeconds > 3600 ||
    !Object.values(commands).every(absolute)
  )
    throw new Error('invalid recovery publication generation tools')
  return {
    root: options.root,
    app: options.app,
    bundleId: options.bundleId,
    codexHome: options.codexHome,
    commands,
    quitWaitSeconds,
  }
}
