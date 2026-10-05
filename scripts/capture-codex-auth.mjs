#!/usr/bin/env node
// Official auth RPCs against generated fake homes only. No real auth or model calls.
// Usage: node scripts/capture-codex-auth.mjs [--codex PATH] [--out FILE]
import assert from 'node:assert/strict'
import { fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeCodex, requireSandbox, SANDBOX_EXEC } from './lib/codex-probe.mjs'
import { fakeJwt, writeFakeChatgptAuth } from './lib/fake-chatgpt-auth.mjs'

const file = fileURLToPath(import.meta.url)
const repo = resolve(dirname(file), '..')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const matrix = [
  { includeToken: false, refreshToken: false },
  { includeToken: true, refreshToken: false },
  { includeToken: true, refreshToken: true },
]
const limit = 32 * 1024
const cleanEnv = (home, codex, temp) => ({
  HOME: home,
  CODEX_HOME: codex,
  TMPDIR: temp,
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  PATH: '/usr/bin:/bin',
  LANG: 'en_US.UTF-8',
  RUST_LOG: 'error',
})

// Only the new supervisor group is inspected; ps readers use separate groups.
async function members(group) {
  const reader = spawn('/bin/ps', ['-o', 'pid=,pgid=,lstart=,stat=', '-g', String(group)], {
    detached: true,
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '',
    stderr = '',
    failed = false
  const stop = () => {
    failed = true
    if (reader.exitCode === null) reader.kill('SIGKILL')
  }
  reader.on('error', () => {
    failed = true
  })
  reader.stdout.on('data', (bytes) => {
    stdout += bytes.toString('utf8')
    if (stdout.length > limit) stop()
  })
  reader.stderr.on('data', (bytes) => {
    stderr += bytes.toString('utf8')
    if (stderr.length > limit) stop()
  })
  const timer = setTimeout(stop, 1000)
  const code = await new Promise((done) => reader.once('close', done))
  clearTimeout(timer)
  if (failed) throw new Error('capture process observation failed')
  if (code === 1 && !stdout.trim() && !stderr.trim()) return []
  if (code !== 0) throw new Error('capture process observation failed')
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.+?)\s+(\S+)$/.exec(line.trim())
      if (!match || Number(match[2]) !== group)
        throw new Error('capture process observation failed')
      return { pid: Number(match[1]), start: match[3], zombie: match[4].startsWith('Z') }
    })
}

async function joinGroup(group, cohort, exclude = 0) {
  const end = Date.now() + 3000
  while (Date.now() < end) {
    const live = (await members(group)).filter((p) => p.pid !== exclude && !p.zombie)
    if (!live.length) return
    for (const process of live) {
      if (cohort.get(process.pid) !== process.start)
        throw new Error('capture process ownership unknown')
      try {
        globalThis.process.kill(process.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw new Error('capture process cleanup failed')
      }
    }
    await delay(20)
  }
  throw new Error('capture process cleanup deadline exceeded')
}

function policy(probe, binary, protectedHome, protectedPaths) {
  const quote = JSON.stringify
  const ancestors = []
  for (const boundary of [probe, binary])
    for (let path = dirname(boundary); ; path = dirname(path)) {
      ancestors.push(path)
      if (dirname(path) === path) break
    }
  ancestors.push('/etc', '/var')
  return [
    '(version 1)(allow default)(deny network*)',
    '(allow network* (remote ip "localhost:*"))',
    '(deny file-write*)',
    `(allow file-write* (subpath ${quote(join(probe, 'home'))})`,
    ` (subpath ${quote(join(probe, 'codex'))}) (literal "/dev/null"))`,
    '(deny file-read*)',
    `(allow file-read* (subpath ${quote(probe)}) (subpath ${quote(dirname(binary))})`,
    ' (subpath "/System") (subpath "/usr") (subpath "/Library")',
    ' (subpath "/private/etc") (subpath "/dev") (literal "/"))',
    `(allow file-read-metadata ${[...new Set(ancestors)].map((path) => `(literal ${quote(path)})`).join(' ')})`,
    `(deny file-read* ${[protectedHome, ...protectedPaths, '/Library/Keychains']
      .map((path) => `(subpath ${quote(path)})`)
      .join(' ')})`,
    '(deny mach-lookup (global-name "com.apple.securityd")',
    ' (global-name "com.apple.secd") (global-name "com.apple.SecurityServer"))',
  ].join('')
}

function rpc(child, signal) {
  const pending = new Map()
  let buffer = Buffer.alloc(0),
    next = 0,
    failure
  const fail = () => {
    failure ??= new Error('capture RPC failed')
    for (const request of pending.values()) request.reject(failure)
    pending.clear()
  }
  child.on('error', fail)
  child.on('close', fail)
  signal.addEventListener('abort', fail, { once: true })
  child.stdout.on('data', (bytes) => {
    try {
      buffer = Buffer.concat([buffer, bytes])
      for (;;) {
        const end = buffer.indexOf(10)
        if ((end < 0 ? buffer.length : end) > limit) throw new Error('frame limit')
        if (end < 0) break
        const message = JSON.parse(
          new TextDecoder('utf8', { fatal: true }).decode(buffer.subarray(0, end)),
        )
        buffer = buffer.subarray(end + 1)
        const request = pending.get(message.id)
        if (request) {
          pending.delete(message.id)
          if (message.error) request.reject(new Error('capture RPC rejected'))
          else request.resolve(message.result)
        } else if (message.method && message.id != null) {
          child.stdin.write(
            `${JSON.stringify({ id: message.id, error: { code: -32601, message: 'capture refuses server requests' } })}\n`,
          )
        }
      }
    } catch {
      fail()
      child.stdin.destroy()
    }
  })
  return {
    notify: (method) => child.stdin.write(`${JSON.stringify({ method, params: {} })}\n`),
    async request(method, params) {
      if (failure || signal.aborted) throw new Error('capture RPC unavailable')
      const id = ++next
      const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
      const timer = setTimeout(fail, 10_000)
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
        return await answer
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

async function fakeRefresh() {
  const claims = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-anyengine-probe',
      chatgpt_plan_type: 'pro',
    },
  }
  const replacement = {
    access_token: fakeJwt(claims),
    id_token: fakeJwt(claims),
    refresh_token: 'rt-fake-rotated',
    expires_in: 3600,
    token_type: 'Bearer',
  }
  const calls = []
  const server = http.createServer(async (request, response) => {
    try {
      let body = Buffer.alloc(0)
      for await (const bytes of request) {
        body = Buffer.concat([body, bytes])
        if (body.length > limit) throw new Error('refresh body limit')
      }
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/oauth/token')
      const params = (request.headers['content-type'] ?? '').includes('application/json')
        ? JSON.parse(body.toString('utf8'))
        : Object.fromEntries(new URLSearchParams(body.toString('utf8')))
      assert.equal(params.grant_type, 'refresh_token')
      const initial = params.refresh_token === 'rt-anyengine-probe'
      const rotated = params.refresh_token === replacement.refresh_token
      assert.ok(initial || rotated)
      calls.push({ initialFakeRefresh: initial, rotatedFakeRefresh: rotated })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(replacement))
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end('{}')
    }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    server,
    calls,
    replacement,
    url: `http://127.0.0.1:${server.address().port}/oauth/token`,
  }
}

async function captureAuthRows(client, config, refresh, observations) {
  await client.request('initialize', {
    clientInfo: { name: 'anyengine_auth_capture', version: '0.0.0' },
    capabilities: { experimentalApi: true },
  })
  client.notify('initialized')
  const calls = []
  for (const params of matrix) {
    const value = await client.request('getAuthStatus', params)
    const expectedMethod = config.kind === 'empty' ? null : 'chatgpt'
    const hasAuthToken = typeof value.authToken === 'string' && value.authToken.length > 0
    observations.push({
      request: params,
      keys: Object.keys(value).sort(),
      authMethod: ['chatgpt', 'apikey', null].includes(value.authMethod)
        ? value.authMethod
        : 'other',
      authTokenType: value.authToken === null ? 'null' : typeof value.authToken,
      hasAuthToken,
      requiresOpenaiAuth: value.requiresOpenaiAuth,
    })
    assert.equal(value.authMethod, expectedMethod)
    assert.equal(value.requiresOpenaiAuth, true)
    assert.equal(hasAuthToken, config.kind !== 'empty' && params.includeToken)
    if (config.kind !== 'empty' && params.includeToken && params.refreshToken)
      assert.equal(value.authToken === refresh.replacement.access_token, true)
    calls.push({
      request: params,
      keys: Object.keys(value).sort(),
      authMethod: expectedMethod,
      authTokenType: value.authToken === null ? 'null' : typeof value.authToken,
      hasAuthToken,
      requiresOpenaiAuth: value.requiresOpenaiAuth,
    })
  }
  const result = { home: config.kind, calls, refreshCalls: refresh.calls.length }
  if (config.kind !== 'empty') {
    const own = JSON.parse(readFileSync(join(config.codex, 'auth.json'), 'utf8'))
    const rotatedChain = own.tokens?.refresh_token === 'rt-fake-rotated'
    const replacementBearer = own.tokens?.access_token === refresh.replacement.access_token
    assert.equal(refresh.calls.length, config.kind === 'stale-fake' ? 2 : 1)
    assert.deepEqual(refresh.calls, [
      { initialFakeRefresh: true, rotatedFakeRefresh: false },
      ...(config.kind === 'stale-fake'
        ? [{ initialFakeRefresh: false, rotatedFakeRefresh: true }]
        : []),
    ])
    assert.equal(rotatedChain, true)
    assert.equal(replacementBearer, true)
    result.refresh = {
      calls: refresh.calls,
      rotatedChain,
      replacementBearer,
      returnsReplacementBearer: true,
    }
  } else assert.equal(refresh.calls.length, 0)
  return result
}

async function closeChild(child, closed, sample, cohort) {
  let endedStatus
  if (child) {
    child.stdin.end()
    const ended = await Promise.race([closed.then(() => true), delay(1000).then(() => false)])
    if (!ended) {
      // The spawned direct child is still owned until its exit event.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await sample()
      await joinGroup(process.pid, cohort, process.pid)
    }
    endedStatus = await Promise.race([
      closed,
      delay(3000).then(() => {
        throw new Error('capture direct child join failed')
      }),
    ])
  }
  await sample()
  await joinGroup(process.pid, cohort, process.pid)
  return endedStatus
}

function sanitizedStderr(value, config) {
  return value
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-|rt-)[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(
      /((?:access_token|refresh_token|id_token|api_key|authorization)["']?\s*[:=]\s*)[^,\n]+/gi,
      '$1[redacted]',
    )
    .split(config.probe)
    .join('[fake-probe]')
}

async function worker(config) {
  const abort = new AbortController(),
    cohort = new Map(),
    observations = []
  let child,
    refresh,
    sampler,
    sampling = false,
    observationError
  let closed,
    result,
    failure,
    output = '',
    stderr = '',
    phase = 'prepare',
    failurePhase
  const stop = () => abort.abort()
  process.once('disconnect', stop)
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const timer = setTimeout(stop, 25_000)
  const sample = async () => {
    if (sampling) return
    sampling = true
    try {
      for (const p of await members(process.pid)) {
        if (cohort.has(p.pid) && cohort.get(p.pid) !== p.start)
          throw new Error('capture process identity changed')
        cohort.set(p.pid, p.start)
      }
    } catch (error) {
      observationError ??= error
      stop()
    } finally {
      sampling = false
    }
  }
  const receipt = (status) =>
    writeFileSync(
      join(config.probe, 'cleanup.json'),
      `${JSON.stringify({
        status,
        phase,
        failurePhase,
        failureKind: failure ? (failure.code === 'ERR_ASSERTION' ? 'assertion' : 'capture') : null,
        childExitCode: child?.exitCode ?? null,
        childSignal: child?.signalCode ?? null,
        cohort: [...cohort].map(([pid, start]) => ({ pid, start })),
      })}\n`,
      { mode: 0o600 },
    )
  try {
    await sample()
    if (observationError) throw observationError
    receipt('pending')
    sampler = setInterval(sample, 100)
    const env = cleanEnv(config.home, config.codex, config.temp)
    if (config.kind !== 'version') {
      refresh = await fakeRefresh()
      env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = refresh.url
      if (config.kind !== 'empty')
        writeFakeChatgptAuth(
          config.codex,
          config.kind === 'stale-fake' ? { now: new Date('2024-01-01T00:00:00Z') } : {},
        )
    }
    writeFileSync(
      join(config.codex, 'config.toml'),
      'openai_base_url="http://127.0.0.1:1"\nchatgpt_base_url="http://127.0.0.1:1"\nnotify=[]\n[mcp_servers]\n',
      { mode: 0o600 },
    )
    if (abort.signal.aborted) throw new Error('capture abandoned before launch')
    child = spawn(
      SANDBOX_EXEC,
      [
        '-p',
        config.policy,
        config.binary,
        ...(config.kind === 'version' ? ['--version'] : ['app-server']),
      ],
      { cwd: config.work, env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    closed = new Promise((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal })),
    )
    child.on('error', stop)
    child.stdin.on('error', stop)
    child.stderr.on('data', (bytes) => {
      stderr += bytes.toString('utf8')
      if (stderr.length > limit) {
        stderr = stderr.slice(0, limit)
        stop()
      }
    })
    if (config.kind === 'version')
      child.stdout.on('data', (bytes) => {
        output += bytes.toString('utf8')
        if (output.length > limit) stop()
      })
    const client = config.kind === 'version' ? null : rpc(child, abort.signal)
    await sample()
    receipt('pending')
    phase = config.kind === 'version' ? 'version' : 'auth-rpc'
    if (config.kind === 'version') {
      if (abort.signal.aborted) throw new Error('capture abandoned')
      const ended = await Promise.race([
        closed,
        once(abort.signal, 'abort').then(() => {
          throw new Error('capture deadline exceeded')
        }),
      ])
      assert.equal(ended.code, 0)
      const version = /^codex-cli\s+([0-9][a-zA-Z0-9.+_-]*)\s*$/m.exec(output)?.[1]
      assert.ok(version)
      result = { version }
    } else {
      result = await captureAuthRows(client, config, refresh, observations)
    }
  } catch (error) {
    failure = error
    failurePhase = phase
  } finally {
    phase = 'cleanup'
    clearInterval(sampler)
    while (sampling) await delay(10)
    try {
      const ended = await closeChild(child, closed, sample, cohort)
      writeFileSync(join(config.home, 'capture-stderr.txt'), sanitizedStderr(stderr, config), {
        flag: 'wx',
        mode: 0o600,
      })
      writeFileSync(
        join(config.home, 'observed-auth.json'),
        `${JSON.stringify({ calls: observations, refreshCalls: refresh?.calls.length ?? 0 })}\n`,
        {
          flag: 'wx',
          mode: 0o600,
        },
      )
      if (observationError) {
        failure = observationError
        receipt('unknown')
      } else {
        if (ended && (ended.code !== 0 || ended.signal)) {
          failure ??= new Error('capture official child failed')
          failurePhase ??= 'official-exit'
        }
        receipt('joined')
      }
    } catch (error) {
      failure = error
      failurePhase = phase
      receipt('unknown')
    } finally {
      clearTimeout(timer)
      refresh?.server.closeAllConnections()
      if (refresh) await new Promise((done) => refresh.server.close(done))
    }
  }
  if (failure) throw failure
  result.cleanup = { directChildJoined: true, processGroupJoined: true }
  return result
}

async function supervised(config) {
  const child = fork(file, ['--worker'], {
    cwd: config.work,
    env: {
      ...cleanEnv(config.home, config.codex, config.temp),
      CAPTURE_AUTH_CONFIG: JSON.stringify(config),
    },
    detached: true,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  child.stderr.resume()
  let answer
  child.on('message', (message) => {
    answer = message
  })
  const closed = once(child, 'close')
  const admitted = (await members(child.pid)).find((p) => p.pid === child.pid)
  let hardTimer
  const abort = () => {
    if (child.connected) child.disconnect()
  }
  process.once('SIGTERM', abort)
  process.once('SIGINT', abort)
  const timer = setTimeout(() => {
    abort()
    hardTimer = setTimeout(async () => {
      try {
        const current = (await members(child.pid)).find((p) => p.pid === child.pid)
        if (current && current.start === admitted?.start) process.kill(-child.pid, 'SIGKILL')
      } catch {} // Unknown identity preserves the private homes, never guesses.
    }, 4000)
  }, 27_000)
  try {
    const [code, signal] = await closed
    if (code !== 0 || signal || !answer?.ok) throw new Error('sandboxed auth capture failed')
    if ((await members(child.pid)).some((p) => !p.zombie))
      throw new Error('capture supervisor family did not join')
    assert.equal(
      JSON.parse(readFileSync(join(config.probe, 'cleanup.json'), 'utf8')).status,
      'joined',
    )
    return answer.value
  } finally {
    clearTimeout(timer)
    clearTimeout(hardTimer)
    process.removeListener('SIGTERM', abort)
    process.removeListener('SIGINT', abort)
  }
}

export async function captureCodexAuth(args = process.argv.slice(2)) {
  const options = {}
  for (let n = 0; n < args.length; n++) {
    const name = args[n]
    if (!['--codex', '--out'].includes(name) || options[name] || !args[n + 1])
      throw new Error('usage: capture-codex-auth.mjs [--codex PATH] [--out FILE]')
    options[name] = args[++n]
  }
  requireSandbox('capture-codex-auth')
  const binary = realpathSync(await probeCodex(repo, options['--codex']))
  const protectedHome = realpathSync(homedir())
  const protectedPaths = [
    process.env.CODEX_HOME,
    process.env.CLAUDE_CONFIG_DIR,
    join(protectedHome, 'Library/Keychains'),
  ]
    .filter(Boolean)
    .map((path) => {
      try {
        return realpathSync(path)
      } catch {
        return resolve(path)
      }
    })
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-auth-capture-')))
  const identity = lstatSync(root)
  let joined = false
  try {
    const run = async (kind) => {
      const probe = join(root, kind)
      const [home, codex, work] = ['home', 'codex', 'work'].map((name) => join(probe, name))
      const temp = join(home, 'tmp')
      for (const path of [home, codex, work, temp, join(home, '.claude')])
        mkdirSync(path, { recursive: true, mode: 0o700 })
      return supervised({
        kind,
        probe,
        home,
        codex,
        work,
        temp,
        binary,
        policy: policy(probe, binary, protectedHome, protectedPaths),
      })
    }
    const { version } = await run('version')
    const homes = []
    for (const kind of ['empty', 'fresh-fake', 'stale-fake']) homes.push(await run(kind))
    const fixture = {
      codexVersion: version,
      protocol: ['initialize', 'initialized', 'getAuthStatus'],
      homes,
    }
    const out = options['--out'] || join(repo, 'test/fixtures', `codex-auth-${version}.json`)
    writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    joined = true
    console.log(
      `PASS fake Codex auth ${version}: three homes, nine RPC rows, stale refresh twice; all children joined`,
    )
    return fixture
  } finally {
    const current = lstatSync(root)
    if (joined && current.dev === identity.dev && current.ino === identity.ino)
      rmSync(root, { recursive: true, force: true })
    else console.error(`capture retained private fake-home evidence: ${root}`)
  }
}

export {
  cleanEnv as captureCleanEnv,
  joinGroup as joinCaptureGroup,
  members as captureGroupMembers,
  policy as captureSandboxPolicy,
  rpc as captureRpc,
}

const direct = process.argv[1] && resolve(process.argv[1]) === file
if (direct && process.argv[2] === '--worker') {
  try {
    const value = await worker(JSON.parse(process.env.CAPTURE_AUTH_CONFIG))
    if (process.connected) {
      process.send({ ok: true, value })
      process.disconnect()
    }
  } catch {
    process.exitCode = 1
    if (process.connected) {
      process.send({ ok: false })
      process.disconnect()
    }
  }
} else if (direct) {
  try {
    await captureCodexAuth()
  } catch {
    console.error('FAIL fake Codex auth capture (no RPC or credential values logged)')
    process.exitCode = 1
  }
}
