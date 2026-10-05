#!/usr/bin/env node
// anyengine-doctor-isolation: 1
// Published capability: version/schema probes use the packaged isolatedCommand
// and supervisor; control doctor checks this declaration and its required cohort
// without executing installed code. Change the version if that contract changes.
import { spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isolatedCommand } from './lib/codex-probe.mjs'
import { verifyLib } from './lib-verify.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const versionProbes = new Map()
let selectedVersion = null

const checks = []
// The shim runs the real codex without the adapter for these spellings (see
// its MODE case), so only the shim and doctor know them.
const NATIVE_CODEX = ['codex', 'native-codex', 'real-codex', 'native', 'real']
// The shim and the adapter copy the pre-rebrand CLAUDE_CODEX_* names onto
// ANYENGINE_* before they read anything (src/env-compat.mts); so does doctor,
// with the checked adapter's own module, before any check reads them.
await adoptLegacyEnv()
const runtimeType = await resolveRuntimeType()
// The adapter's own rule for which codex it and the shim run
// (src/bundled-codex.mts), from the adapter being checked, or why not.
const codexRule = await adapterExports('bundled-codex.mjs', [
  'bundledCodexCandidates',
  'resolveBundledCodex',
  'resolveNativeCodex',
]).catch((error) => ({ error }))

check('node >= 24 with stable node:sqlite', () => {
  // node:sqlite ships flag-gated on Node 22 and stable on Node 24+. The adapter
  // imports it without --experimental-sqlite, so anything older than 24 will
  // crash at runtime even if it advertises a sqlite module.
  const major = Number(process.versions.node.split('.')[0])
  if (major < 24) throw new Error(`Node ${process.versions.node} is too old; install Node 24+`)
  requireModule('node:sqlite')
})

check('built adapter exists', () => {
  const adapter = process.env.ANYENGINE_ADAPTER || join(repo, 'dist/src/adapter.mjs')
  if (!existsSync(adapter)) throw new Error(`${adapter} does not exist; run npm run build`)
})

check('adapter selfcheck (deep)', () => {
  // Loads every static import plus node-pty, @xterm/headless and the SDK: a
  // pruned node_modules fails here instead of in the app.
  const adapter = process.env.ANYENGINE_ADAPTER || join(repo, 'dist/src/adapter.mjs')
  run(process.env.ANYENGINE_NODE || process.execPath, [adapter, 'selfcheck', '--deep'])
})

check('no shim fallback recorded', () => {
  const marker = join(
    process.env.ANYENGINE_ROOT || join(homedir(), '.anyengine'),
    'shim-fallback.json',
  )
  if (!existsSync(marker)) return
  const event = JSON.parse(readFileSync(marker, 'utf8'))
  throw new Error(
    `${event.ts}: the shim fell back to the ${event.kind} codex (${event.reason}); ` +
      'fix the adapter, then run npm run install:lib (which clears this marker)',
  )
})

check('live adapter runs from a verified lib', () => {
  // The shim runs ANYENGINE_ADAPTER, else the installed lib. With neither (a
  // checkout before any `npm run install:lib`) there is nothing to check.
  const installed = join(
    process.env.ANYENGINE_ROOT || join(homedir(), '.anyengine'),
    'lib',
    'current',
  )
  const adapter = process.env.ANYENGINE_ADAPTER || join(installed, 'dist', 'src', 'adapter.mjs')
  if (!process.env.ANYENGINE_ADAPTER && !lstatSync(installed, { throwIfNoEntry: false })) return
  if (!existsSync(adapter)) throw new Error(`${adapter} does not exist; run npm run install:lib`)
  const lib = resolve(dirname(realpathSync(adapter)), '..', '..')
  if (!existsSync(join(lib, 'install-manifest.json'))) {
    throw new Error(
      `${adapter} is not an installed lib; dependency cleanup can prune a checkout's ` +
        'node_modules under it. Run npm run install:lib and point ANYENGINE_ADAPTER at ' +
        '~/.anyengine/lib/current/dist/src/adapter.mjs (or unset it)',
    )
  }
  const problems = verifyLib(lib)
  if (problems.length > 0) throw new Error(problems.slice(0, 5).join('; '))
})

check('shim version probe', () => {
  // Inspect the advertised pin without starting a second official process.
  // The selected executable's actual version is probed once below.
  const shim = readFileSync(join(repo, 'scripts/codex-shim'), 'utf8')
  if (!/DEFAULT_COMPAT_VERSION="[^"]+"/.test(shim))
    throw new Error('shim compatibility pin missing')
  if (process.env.CODEX_SHIM_VERSION && !/codex-cli/.test(process.env.CODEX_SHIM_VERSION))
    throw new Error('unexpected shim version output')
})

// 2026-09-30: an app update moved the bundled codex, runtime.env still named
// the old path, and the adapter served the app with no GPT engine while every
// check here passed. A named codex that is gone fails, and so does an
// expected codex child with nothing to run.
check('bundled codex resolves', () => {
  if (codexRule.error) throw codexRule.error
  const found = codexRule.resolveBundledCodex(process.env)
  if (found.stale) {
    throw new Error(
      `ANYENGINE_REAL_CODEX=${found.stale} is not an executable file (an app update moves ` +
        `the bundled codex); the adapter and the shim skip it for ${found.path ?? 'no codex at all'}. ` +
        'Remove it from runtime.env',
    )
  }
  const native = codexRule.resolveNativeCodex(process.env)
  // The shim's own native-codex mode runs the real codex with no adapter.
  if (runtimeType === 'codex' || !native.expected) return found.path ?? 'none (no codex child)'
  if (found.path) return found.path
  throw new Error(
    `no codex in ${codexRule.bundledCodexCandidates(process.env).join(', ')}: GPT threads would ` +
      (native.path ? `run on CODEX_REAL (${native.path}), a codex the app did not ship` : 'fail') +
      '. Point ANYENGINE_CHATGPT_APP at the app, or set ANYENGINE_NATIVE_CODEX=0 to run without GPT',
  )
})

check('compat pin matches the bundled codex', () => {
  const bundled = codexRule.error ? null : codexRule.resolveBundledCodex(process.env).path
  // Nothing to ask: 'bundled codex resolves' says why.
  if (!bundled) return
  const version = versionOf(bundled)
  selectedVersion = { path: bundled, version }
  // The shim advertises an explicit version over the bundled codex's, so a
  // stale one outlives every app update (run doctor with runtime.env sourced).
  const name = [
    'ANYENGINE_COMPAT_VERSION',
    'CLAUDE_CODEX_COMPAT_VERSION',
    'CODEX_SHIM_COMPAT_VERSION',
  ].find((key) => process.env[key])
  const explicit = name ? process.env[name] : null
  if (version && explicit && explicit !== version) {
    throw new Error(
      `${name}=${explicit} overrides the bundled codex ${version}; ` +
        'remove it so the shim advertises the bundled version',
    )
  }
  const shim = readFileSync(join(repo, 'scripts/codex-shim'), 'utf8')
  const pinned = /DEFAULT_COMPAT_VERSION="([^"]+)"/.exec(shim)?.[1]
  if (version && version !== pinned) {
    throw new Error(
      `bundled codex is ${version}, the repo pins ${pinned}; ` +
        'run node scripts/sync-codex-compat.mjs and commit the result',
    )
  }
})

if (runtimeType === 'agent-sdk-sidecar')
  check('@anthropic-ai/claude-agent-sdk installed', () => {
    // The native TS runtime imports the SDK dynamically; verify it resolves
    // from this package's node_modules.
    const pkgPath = join(repo, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json')
    if (!existsSync(pkgPath)) {
      throw new Error('run npm install - @anthropic-ai/claude-agent-sdk is missing')
    }
  })

if (runtimeType === 'agent-http' || runtimeType === 'agentapi')
  check(`${runtimeType} HTTP endpoint`, () => {
    const url = new URL('/status', httpBaseUrl())
    const result = run(process.execPath, [
      '-e',
      `fetch(${JSON.stringify(url.toString())}).then(async r => { if (!r.ok) throw new Error(await r.text()); console.log(await r.text()) })`,
    ])
    if (!/"status"\s*:/.test(result.stdout))
      throw new Error(`unexpected /status response: ${result.stdout.trim()}`)
  })

if (runtimeType === 'claude-p')
  check('claude-p command', () => {
    const command = process.env.ANYENGINE_CLAUDE_P_COMMAND || process.env.CLAUDE_P || 'claude-p'
    versionOf(command, false)
  })

// The interactive runtime drives the same claude CLI the claude-p wrapper wraps.
if (runtimeType === 'anyengine')
  check('claude CLI for the interactive runtime', () => {
    versionOf(resolveClaudeCommand(), false)
  })

// 'codex' hands the app-server to the real codex; 'codex-proxy' runs it per turn.
if (runtimeType === 'codex' || runtimeType === 'codex-proxy')
  check('real Codex passthrough', () => {
    const command = process.env.CODEX_REAL || 'codex'
    const version = versionOf(command)
    selectedVersion ??= { path: command, version }
  })

if (runtimeType === 'grok')
  check('grok CLI', () => {
    versionOf(process.env.ANYENGINE_GROK_BIN || process.env.GROK_BIN || 'grok', false)
  })

if (runtimeType === 'agent-sdk-sidecar')
  check('Claude auth surface for real smoke', () => {
    if (
      process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_CODE_USE_BEDROCK ||
      process.env.CLAUDE_CODE_USE_VERTEX
    )
      return
    versionOf(resolveClaudeCommand(), false)
  })

if (process.argv.includes('--schemas')) {
  for (const script of ['check-posture-schema.mjs', 'check-rust-protocol-fixtures.mjs'])
    check(script, () => {
      const binary = selectedVersion?.path
      if (!binary) throw new Error('selected Codex version unavailable; cannot inspect schema')
      return run(process.execPath, [join(repo, 'scripts', script)], {
        CODEX_REAL: binary,
      }).stdout.trim()
    })
}
if (process.argv.includes('--json')) console.log(JSON.stringify({ checks, codex: selectedVersion }))
else
  for (const item of checks) {
    const marker = item.ok ? 'ok' : 'fail'
    console.log(`${marker} - ${item.name}${item.message ? `: ${item.message}` : ''}`)
  }
if (checks.some((item) => !item.ok)) process.exitCode = 1

function versionOf(command, codex = true) {
  const binary = resolveCommand(command)
  if (!versionProbes.has(binary)) {
    versionProbes.set(binary, isolatedCommand(binary, ['--version'], { timeoutMs: 2000 }))
  }
  const result = versionProbes.get(binary)
  if (result.status !== 0) throw new Error(result.stderr || `version probe failed for ${command}`)
  const value = codex ? /^codex-cli\s+(\S+)\s*$/m.exec(result.stdout)?.[1] : result.stdout.trim()
  if (!value) throw new Error(`unrecognized version output from ${command}`)
  return value
}

function resolveCommand(command) {
  if (command.includes('/')) return realpathSync(resolve(command))
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const path = resolve(dir, command)
    try {
      accessSync(path, constants.X_OK)
      if (statSync(path).isFile()) return realpathSync(path)
    } catch {}
  }
  throw new Error(`cannot resolve executable ${command} on PATH`)
}

// A check that returns a string passes with it as its detail.
function check(name, fn) {
  try {
    const detail = fn()
    checks.push({ name, ok: true, ...(typeof detail === 'string' ? { message: detail } : {}) })
  } catch (error) {
    checks.push({
      name,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} exited ${result.status}`).trim())
  }
  return result
}

function requireModule(name) {
  const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(name)})`], {
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

// Records the runtime-type line and returns the type, or null when it cannot be
// resolved (the checks that depend on it are then skipped). Never throws, so
// the other checks still print.
async function resolveRuntimeType() {
  try {
    const type = await selectRuntimeType()
    checks.push({ name: `runtime type: ${type}`, ok: true })
    return type
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    checks.push({ name: 'runtime type', ok: false, message })
    return null
  }
}

// Resolves the type exactly as the adapter does, by asking the adapter's own
// resolveRuntimeConfig (aliases, legacy variable precedence, provider and loop
// selection, mock), so none of that is copied here.
async function selectRuntimeType() {
  // The shim, not the adapter, reads ANYENGINE_ROUTE and decides these spellings
  // launch the real codex with no adapter in the process.
  const mode = process.env.ANYENGINE_ROUTE || process.env.ANYENGINE_RUNTIME_TYPE || ''
  if (NATIVE_CODEX.includes(mode)) return 'codex'
  const { resolveRuntimeConfig } = await adapterExports('runtime-config.mjs', [
    'resolveRuntimeConfig',
  ])
  return resolveRuntimeConfig(process.env).type
}

// Importing env-compat.mjs copies the names (its side effect). When it cannot
// load and a legacy name is set, doctor would check another configuration
// than the one that runs: that fails, instead of passing on the wrong one.
async function adoptLegacyEnv() {
  try {
    await adapterExports('env-compat.mjs', ['applyLegacyEnvNames'])
  } catch (error) {
    const legacy = Object.keys(process.env).filter((name) => name.startsWith('CLAUDE_CODEX_'))
    if (legacy.length === 0) return
    checks.push({
      name: 'legacy CLAUDE_CODEX_* settings applied',
      ok: false,
      message: `${legacy.join(', ')} not applied: ${error.message}`,
    })
  }
}

// Named functions from a module beside the adapter the shim would run. An
// installed lib older than the module is reported as such, not skipped.
async function adapterExports(file, names) {
  const path = join(dirname(adapterPath()), file)
  const label = file.replace(/\.mjs$/, '')
  try {
    const module = await import(pathToFileURL(path).href)
    const missing = names.find((name) => typeof module[name] !== 'function')
    if (missing) throw new Error(`no ${missing} export`)
    return module
  } catch (error) {
    const cause = error?.code ?? String(error?.message ?? error).split('\n')[0]
    throw new Error(`cannot load the adapter's ${label} (${path}: ${cause})`)
  }
}

// The adapter the shim would run: ANYENGINE_ADAPTER, else the installed lib,
// else (a checkout before any install:lib) this checkout's build.
function adapterPath() {
  if (process.env.ANYENGINE_ADAPTER) return resolve(process.env.ANYENGINE_ADAPTER)
  const installed = join(
    process.env.ANYENGINE_ROOT || join(homedir(), '.anyengine'),
    'lib',
    'current',
  )
  if (lstatSync(installed, { throwIfNoEntry: false })) {
    return join(installed, 'dist', 'src', 'adapter.mjs')
  }
  return join(repo, 'dist/src/adapter.mjs')
}

function httpBaseUrl() {
  const value =
    process.env.ANYENGINE_HTTP_BASE_URL ||
    process.env.ANYENGINE_AGENT_HTTP_URL ||
    process.env.ANYENGINE_AGENTAPI_URL ||
    'http://127.0.0.1:3284'
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function resolveClaudeCommand() {
  return process.env.ANYENGINE_CLI || 'claude'
}
