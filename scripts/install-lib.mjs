#!/usr/bin/env node
// Install the built adapter and its production dependencies under
// ~/.anyengine/lib/<version>/ and point ~/.anyengine/lib/current at it.
//
// The live adapter must not run from a project checkout: a cleanup job that
// prunes node_modules in idle projects broke the live install on 2026-09-15.
// A lib is built once from a committed tree, verified (file hashes and a deep
// selfcheck) before `current` moves, and never touched by development work.
// The shim's default adapter is ~/.anyengine/lib/current/dist/src/adapter.mjs.
//
// Usage: node scripts/install-lib.mjs [--dest-root DIR] [--source DIR]
//          [--version V] [--npm CMD] [--keep N] [--allow-scripts]
//          [--no-activate | --activate VERSION]
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLayers, validateLayers } from '../dist/src/control-layer-journal.mjs'
import { jsonAt } from '../dist/src/control-layer-state.mjs'
import {
  needsMilestoneBaseline,
  prepareM2Upgrade,
  retainedM2Libraries,
} from '../dist/src/control-m2-upgrade.mjs'
import { realSystem } from '../dist/src/control-system.mjs'
import { suiteIdentity } from './lib/startup-schema.mjs'
import { verifyLib, writeManifest } from './lib-verify.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// What a lib holds: the compiled adapter, the scripts it runs (hook relay,
// shim, pty bridge, doctor), and what `npm ci` needs.
const COPY = [
  'dist/src',
  'scripts',
  'test/fixtures/claude-permission-modes.json',
  'test/fixtures/posture-schema.json',
  'test/fixtures/codex-auth-0.160.0.json',
  'test/fixtures/codex-accounts-0.160.0.json',
  'test/fixtures/claude-messages-2.1.289.json',
  'test/fixtures/claude-posture-2.1.289.json',
  'test/fixtures/raine-translation-v0.1.42.json',
  'crates/anyengine-protocol/fixtures',
  'vendor/claude-code-proxy',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
]

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function fail(message) {
  console.error(`install-lib: ${message}`)
  process.exit(1)
}

// `<package version>-<commit>`, from a clean tree only: a lib has to be
// something a commit can reproduce.
function versionFromGit(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (existsSync(join(dir, 'npm-shrinkwrap.json')) && !existsSync(join(dir, 'tsconfig.json')))
    return pkg.version
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  if (git('status', '--porcelain') !== '') {
    fail('the source tree has uncommitted changes; commit or stash them first')
  }
  return `${pkg.version}-${git('rev-parse', '--short=12', 'HEAD')}`
}

function sourceCommit(dir) {
  if (existsSync(join(dir, 'npm-shrinkwrap.json')) && !existsSync(join(dir, 'tsconfig.json')))
    return null
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

const source = resolve(option('--source', repo))
const destRoot = resolve(option('--dest-root', join(homedir(), '.anyengine', 'lib')))
const npm = option('--npm', 'npm')
const keep = Math.max(2, Number(option('--keep', '2')) || 2)
const activate = option('--activate', null)
const noActivate = process.argv.includes('--no-activate')
if (activate && noActivate) fail('--activate and --no-activate are mutually exclusive')
const version = activate ?? option('--version', null) ?? versionFromGit(source)
if (!/^[A-Za-z0-9._-]+$/.test(version)) fail(`unusable version: ${version}`)
if (!activate && !existsSync(join(source, 'dist', 'src', 'adapter.mjs'))) {
  fail('dist/src/adapter.mjs is missing; run npm run build first')
}

function runNpmCi(cwd) {
  const args = ['ci', '--omit=dev', '--no-audit', '--no-fund']
  // Dependency install scripts stay off unless asked for; node-pty ships
  // prebuilt binaries, and the one script that matters here runs below.
  if (!process.argv.includes('--allow-scripts')) args.push('--ignore-scripts')
  const [command, prefix] = npm.endsWith('.mjs') ? [process.execPath, [npm]] : [npm, []]
  const result = spawnSync(command, [...prefix, ...args], { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${npm} ${args.join(' ')} exited ${result.status}`)
  const fixup = join(cwd, 'scripts', 'fix-node-pty-permissions.mjs')
  if (existsSync(fixup)) spawnSync(process.execPath, [fixup], { cwd, stdio: 'inherit' })
}

function stageAndInstall(target) {
  const staging = join(destRoot, `.staging-${version}-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  try {
    for (const entry of COPY) {
      if (!existsSync(join(source, entry))) continue
      mkdirSync(dirname(join(staging, entry)), { recursive: true })
      cpSync(join(source, entry), join(staging, entry), { recursive: true })
    }
    suiteIdentity(staging) // Every shipped startup validator and fixture is required.
    runNpmCi(staging)
    writeManifest(staging, { version, commit: sourceCommit(source) })
    const problems = verifyLib(staging)
    if (problems.length > 0) {
      throw new Error(`the staged lib does not verify:\n  ${problems.slice(0, 10).join('\n  ')}`)
    }
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    fail(error instanceof Error ? error.message : String(error))
  }
}

// Swap the link atomically: a shim starting mid-install sees the old version
// or the new one, never neither.
function pointCurrent(target) {
  const temp = join(destRoot, `.current-${process.pid}`)
  rmSync(temp, { force: true })
  symlinkSync(basename(target), temp)
  renameSync(temp, join(destRoot, 'current'))
}

// The command line of every running process, or null when ps cannot say.
// A live adapter's argv names the version directory it loads from, and that is
// the only evidence a version is in use: without it nothing may be removed.
function runningCommands() {
  // Agent sessions put whole prompts in argv: leave room for a long listing.
  const ps = spawnSync('ps', ['-axww', '-o', 'command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (ps.error || ps.status !== 0) return null
  return ps.stdout.split('\n')
}

// Keep `current`, the newest other version (the rollback target) and any
// version a running process uses; remove the rest. Removing one would pull the
// relay script and lazily loaded modules out from under the app's adapter. The
// shim starts the adapter from the resolved version directory, so a version is
// matched by its path as given and as the filesystem resolves it.
function prune(pins, protectedVersions) {
  const commands = runningCommands()
  if (commands === null) {
    console.warn('install-lib: cannot list running processes; keeping every installed version')
    return
  }
  const current = existsSync(join(destRoot, 'current'))
    ? basename(readlinkSync(join(destRoot, 'current')))
    : null
  const realRoot = realpathSync(destRoot)
  const others = readdirSync(destRoot)
    .filter((name) => !name.startsWith('.') && name !== 'current' && name !== current)
    .map((name) => ({ name, mtime: statSync(join(destRoot, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const [index, { name }] of others.entries()) {
    if (pins.has(name)) {
      console.log(`install-lib: kept ${name}: a layer rolls back to it`)
      continue
    }
    if (protectedVersions.has(name) || index < keep - 1) continue
    const spellings = [join(destRoot, name), join(realRoot, name)]
    if (commands.some((command) => spellings.some((dir) => command.includes(`${dir}/`)))) continue
    rmSync(join(destRoot, name), { recursive: true, force: true })
  }
}

// Read strict live authority including POPPED baselines; absence alone means no pins.
function recoveryPins() {
  const root = dirname(destRoot)
  const raw = jsonAt(join(root, 'state/layers.json'))
  if (raw !== undefined) {
    validateLayers(root, raw)
    readLayers(root) // Validate POPPED and directory evidence as well.
  }
  const pins = new Set()
  const add = (path) => {
    const resolved = resolve(path)
    if (dirname(resolved) === destRoot) pins.add(basename(resolved))
  }
  for (const path of [...retainedM2Libraries(root), ...retainedM2Libraries(root, 'm3')]) add(path)
  for (const path of raw?.recovery?.pinnedLibs ?? []) add(path)
  for (const layer of raw?.layers ?? [])
    for (const change of layer.changes) {
      if (change.target !== join(destRoot, 'current')) continue
      for (const link of [
        change.beforeLink,
        change.afterLink,
        change.pending?.link,
        change.lastGood?.link,
      ])
        if (link) add(resolve(destRoot, link))
    }
  return pins
}

let pins
try {
  const root = dirname(destRoot)
  // Pin the verified immediate M1 before stageAndInstall or pruning can run.
  if (
    existsSync(join(source, 'dist/src/control-claude-layer.mjs')) &&
    needsMilestoneBaseline(root, source)
  ) {
    const system = realSystem()
    prepareM2Upgrade(
      system,
      root,
      {
        version,
        libDir: join(destRoot, version),
        node: process.execPath,
        claudeCli: null,
        shimSource: join(source, 'scripts/codex-shim'),
        launcherSource: join(source, 'scripts/anyengine-launch'),
        stamp: 'm2-stage',
        app: system.app,
        bundleId: 'com.openai.codex',
        claudeCode: true,
      },
      existsSync(join(source, 'dist/src/accounts-bootstrap.mjs')) ? 'm3' : 'm2',
    )
  }
  pins = recoveryPins()
} catch (error) {
  fail(`invalid recovery evidence; preserving libraries: ${error.message}`)
}
mkdirSync(destRoot, { recursive: true, mode: 0o700 })
const target = join(destRoot, version)
if (lstatSync(target, { throwIfNoEntry: false })) {
  if (!lstatSync(target).isDirectory()) fail(`${target} is not an installed library directory`)
  const problems = verifyLib(target)
  if (problems.length > 0)
    fail(
      `${target} exists but does not verify:\n  ${problems.slice(0, 10).join('\n  ')}\nremove it and re-run`,
    )
  console.log(`install-lib: ${version} is already installed and verified`)
} else if (activate) fail(`staged library is missing: ${target}`)
else stageAndInstall(target)
// Activation protects its immediate previous version separately from initial pins.
const previous = existsSync(join(destRoot, 'current'))
  ? basename(readlinkSync(join(destRoot, 'current')))
  : null
if (!noActivate) pointCurrent(target)
prune(pins, new Set([version, ...(previous ? [previous] : [])]))
if (noActivate) console.log(`install-lib: staged ${target} (current unchanged)`)
else {
  rmSync(join(dirname(destRoot), 'shim-fallback.json'), { force: true })
  console.log(`install-lib: current -> ${target}`)
}
