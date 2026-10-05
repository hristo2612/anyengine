#!/usr/bin/env node
// Live official-process admission and installed smoke. No raw traffic evidence.
import { randomUUID } from 'node:crypto'
import { realpathSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const options = new Map()
for (let i = 1; i < args.length; i += 2) options.set(args[i], args[i + 1])
const tool = args[0] === '--tool-only'
const allowed = tool ? ['--lib', '--root'] : ['--lib', '--codex-home']
if (
  (!tool && args[0] !== '--bearer-only') ||
  args.length % 2 !== 1 ||
  options.size !== (args.length - 1) / 2 ||
  [...options].some(([key, value]) => !allowed.includes(key) || !value || /[\0\r\n]/.test(value)) ||
  (tool && (!options.has('--lib') || !options.has('--root')))
) {
  process.stderr.write(
    'usage: acceptance-claude-code.mjs --bearer-only [--lib DIR] [--codex-home DIR]\n       acceptance-claude-code.mjs --tool-only --root DIR --lib DIR\n',
  )
  process.exit(2)
}
const lib = tool
  ? options.get('--lib')
  : realpathSync(options.get('--lib') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
async function installed(root) {
  const selected = realpathSync(lib)
  if (
    dirname(selected) !== join(root, 'lib') ||
    realpathSync(join(root, 'lib/current')) !== selected
  )
    throw new Error('installed active library required')
  const api = Object.assign(
    {},
    ...(await Promise.all(
      [
        'smoke',
        'control-system',
        'control-postflight-evidence',
        'control-status-evidence',
        'control-layer-state',
        'router-messages',
        'claude-models',
      ].map((name) => import(pathToFileURL(join(selected, 'dist/src', `${name}.mjs`)).href)),
    )),
  )
  const system = api.realSystem()
  const capabilities = api.realFlipDeps(system, root, selected)
  const deps = api.realSmokeDeps(root, capabilities)
  return { api, system, deps, ...api.admission(root, deps) }
}
function removeResult(api, path, result) {
  const state = api.stateAt(path)
  if (
    state.kind !== 'file' ||
    state.mode !== 0o600 ||
    state.sha !== api.digest(Buffer.from(`${JSON.stringify(result)}\n`))
  )
    throw new Error('acceptance result ownership unavailable')
  unlinkSync(path)
  if (api.stateAt(path).kind !== 'absent') throw new Error('acceptance result cleanup unverified')
}
function routerIdentity(system, health, snapshot) {
  const process = system.processes().find((row) => row.pid === health.pid)
  if (
    health.version !== snapshot.key.lib ||
    health.mode !== snapshot.mode ||
    !process?.command.includes(`${lib}/dist/src/adapter.mjs router`)
  )
    throw new Error('selected installed router identity unavailable')
  return `${process.pid}:${process.processStart}`
}
async function toolOnly() {
  const observation = {
    gate: 'installed-claude-code-gpt-read',
    passed: false,
    attempted: false,
    readMarkerAndPong: false,
    model: null,
    libraryVersion: null,
    claudeVersion: null,
    codexVersion: null,
    sourceKind: 'none',
    generation: 0,
    cleanupJoined: false,
    reason: null,
  }
  try {
    if (process.env.ANYENGINE_MOCK === '1') throw new Error('mock cannot provide live acceptance')
    const root = realpathSync(options.get('--root'))
    const { api, system, deps, snapshot, verify } = await installed(root)
    observation.libraryVersion = snapshot.key.lib
    observation.codexVersion = snapshot.key.codexVersion
    if (!snapshot.config.smoke.enabled || !snapshot.config.claude.cli) {
      observation.reason = 'installed Claude Code smoke is disabled or its CLI is unavailable'
      return observation
    }
    const version = system.exec(snapshot.config.claude.cli, ['--version'], { timeoutMs: 15000 })
    observation.claudeVersion =
      /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/.exec(version.stdout)?.[1] ?? null
    if (version.status !== 0 || !observation.claudeVersion)
      throw new Error('CLI version unavailable')
    const origin = `http://127.0.0.1:${snapshot.config.router.port}`
    const view = await api.fetchGptSettingsView(origin, AbortSignal.timeout(8000))
    const beforeHealth = await api.readStatusHealth(`${origin}/health`)
    const beforeIdentity = routerIdentity(system, beforeHealth, snapshot)
    const before = beforeHealth.gpt
    const model = snapshot.config.smoke.gptModel ?? view.models.at(-1)?.id
    if (
      !model ||
      !api.resolveGptModel(model, view.models) ||
      !before?.ready ||
      before.source === 'none' ||
      before.generation !== view.generation
    )
      throw new Error('admitted GPT metadata unavailable')
    observation.model = model
    observation.sourceKind = before.source
    observation.generation = before.generation
    const out = join(root, 'smoke', `acceptance-claude-${randomUUID()}.json`)
    observation.attempted = true
    // The producer owns the fixed marker, one Read turn, 60 s budget and joins.
    // A fresh private output avoids publishing smoke/proof/degraded history.
    const result = await api.runSmoke(system, root, deps, {
      paths: ['claude-code-gpt'],
      notify: false,
      out,
    })
    removeResult(api, out, result)
    observation.cleanupJoined = Boolean(result.cleanup) && !api.statAt(deps.runDir)
    observation.readMarkerAndPong = result.paths['claude-code-gpt']?.ok === true
    verify()
    const afterView = await api.fetchGptSettingsView(origin, AbortSignal.timeout(8000))
    const afterHealth = await api.readStatusHealth(`${origin}/health`)
    const afterIdentity = routerIdentity(system, afterHealth, snapshot)
    const after = afterHealth.gpt
    const stable =
      afterIdentity === beforeIdentity &&
      after?.ready &&
      after.generation === before.generation &&
      afterView.generation === view.generation &&
      JSON.stringify(afterView.models.map((row) => row.id)) ===
        JSON.stringify(view.models.map((row) => row.id))
    observation.passed =
      observation.readMarkerAndPong && observation.cleanupJoined && Boolean(stable)
    if (!observation.passed)
      observation.reason = 'installed GPT Read/PONG, source identity or cleanup was not verified'
  } catch {
    observation.reason = 'installed GPT acceptance admission, Read/PONG or cleanup unavailable'
  }
  return observation
}
if (tool) {
  const observation = await toolOnly()
  process.stdout.write(`${JSON.stringify(observation)}\n`)
  process.exitCode = observation.passed && observation.cleanupJoined ? 0 : 1
} else {
  const { createStandaloneAuthSource } = await import(
    pathToFileURL(join(lib, 'dist/src/broker-standalone.mjs')).href
  )
  const observation = {
    gate: 'official-getAuthStatus-refresh',
    passed: false,
    bearerPresent: false,
    chatgptMethod: false,
    accountMetadataPresent: false,
    expiryPresent: false,
    expiryUsable: false,
    cleanupJoined: false,
    reason: null,
  }
  let source
  try {
    source = await createStandaloneAuthSource({
      home: realpathSync(options.get('--codex-home') ?? join(homedir(), '.codex')),
      generation: 1,
    })
    const status = await source.request('getAuthStatus', { includeToken: true, refreshToken: true })
    observation.chatgptMethod = status.authMethod === 'chatgpt'
    observation.bearerPresent = typeof status.authToken === 'string' && status.authToken.length > 0
    if (observation.bearerPresent && status.authToken.length <= 32768) {
      const parts = status.authToken.split('.')
      if (parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
        const claims = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(parts[1], 'base64url')),
        )
        const account = claims['https://api.openai.com/auth']?.chatgpt_account_id
        observation.accountMetadataPresent =
          typeof account === 'string' && account.trim().length > 0
        observation.expiryPresent =
          typeof claims.exp === 'number' && Number.isFinite(claims.exp * 1000)
        observation.expiryUsable =
          observation.expiryPresent && claims.exp * 1000 > Date.now() + 60000
      }
    }
    observation.passed =
      observation.chatgptMethod &&
      observation.bearerPresent &&
      observation.accountMetadataPresent &&
      observation.expiryUsable
    if (!observation.passed)
      observation.reason =
        'official process did not return a usable ChatGPT bearer with account/expiry metadata'
  } catch {
    observation.reason = 'official getAuthStatus refresh contract unavailable'
  } finally {
    try {
      await source?.close()
      observation.cleanupJoined = true
    } catch {
      observation.passed = false
      observation.reason = 'official source cleanup unverified'
    }
  }
  process.stdout.write(`${JSON.stringify(observation)}\n`)
  process.exitCode = observation.passed && observation.cleanupJoined ? 0 : 1
}
