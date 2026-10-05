#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
// Zero-generation official Codex account-overlay contract, using fake auth only.
// Build first. Usage: node scripts/capture-accounts-contract.mjs [--repo DIR]
//   [--codex PATH] [--out FILE]
// Runs sequential owned families; never reads, copies or hashes real authentication.
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { captureSandboxPolicy } from './capture-codex-auth.mjs'

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    codex: { type: 'string' },
    out: { type: 'string' },
  },
})
const repo = realpathSync(
  resolve(values.repo ?? join(dirname(fileURLToPath(import.meta.url)), '..')),
)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'codex-accounts-capture-')))
const scratchIdentity = lstatSync(scratch)
const dirs = {
  home: join(scratch, 'home'),
  work: join(scratch, 'work'),
  codex: join(scratch, 'codex'),
}
dirs.canonical = join(dirs.codex, 'canonical')
dirs.overlay = join(dirs.codex, 'overlay')
dirs.tmp = join(dirs.home, 'tmp')
for (const p of Object.values(dirs)) mkdirSync(p, { recursive: true, mode: 0o700 })
const realHome = homedir()
const oldTmp = process.env.TMPDIR
process.env.TMPDIR = dirs.tmp
let active,
  server,
  helpers,
  serverRequests = [],
  cleanupOk = true
let isolatedCleanupOk = true
let refreshFailed = false
const refreshCalls = []
let expectedRefresh = 'rt-anyengine-probe'
let replacement
let phase = 'prepare'
let childStderr = ''
const owned = []
const result = {
  startedAt: new Date().toISOString(),
  pass: false,
  zeroGeneration: true,
  modelRequests: 0,
  phases: [],
  children: [],
  schema: {},
  authRefresh: [],
  failure: null,
}
const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return lstatSync(p).isDirectory() ? walk(p) : [p]
  })
const shape = (obj) => {
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const k of ['type', '$ref', 'enum', 'const', 'required'])
    if (obj[k] !== undefined) out[k] = obj[k]
  for (const k of ['anyOf', 'oneOf', 'allOf', 'items', 'additionalProperties'])
    if (obj[k] !== undefined) out[k] = Array.isArray(obj[k]) ? obj[k].map(shape) : shape(obj[k])
  if (obj.properties)
    out.properties = Object.fromEntries(
      Object.entries(obj.properties).map(([k, v]) => [k, shape(v)]),
    )
  return out
}
const stamp = (path) => {
  try {
    const l = lstatSync(path),
      s = statSync(path)
    return {
      kind: l.isSymbolicLink() ? 'symlink' : l.isDirectory() ? 'directory' : 'file',
      dev: s.dev,
      ino: s.ino,
      target: l.isSymbolicLink() ? `canonical/${basename(readlinkSync(path))}` : null,
    }
  } catch (e) {
    if (e.code === 'ENOENT') return { absent: true }
    throw e
  }
}
let initialIdentity
const inspect = (phase) => {
  const names = [...new Set([...readdirSync(dirs.canonical), ...readdirSync(dirs.overlay)])]
  const identity = names.map((name) => {
    const c = stamp(join(dirs.canonical, name)),
      o = stamp(join(dirs.overlay, name))
    const shared = c.dev !== undefined && c.dev === o.dev && c.ino === o.ino
    let canonicalOnly = false
    if (!shared && /\.sqlite-(wal|shm)$/.test(name) && o.absent && c.kind === 'file') {
      const main = name.replace(/-(wal|shm)$/, '')
      canonicalOnly =
        realpathSync(join(dirs.overlay, main)) === realpathSync(join(dirs.canonical, main))
    }
    if (!shared && !canonicalOnly) throw new Error(`unshared overlay entry: ${name}`)
    if (!o.absent && o.kind !== 'symlink') throw new Error(`detached overlay entry: ${name}`)
    if (!o.absent && readlinkSync(join(dirs.overlay, name)) !== join(dirs.canonical, name))
      throw new Error(`overlay symlink target changed: ${name}`)
    return { name, canonical: c, overlay: o, shared, canonicalOnly }
  })
  initialIdentity ??= identity
  const changed = identity
    .filter((e) => {
      const first = initialIdentity.find((v) => v.name === e.name)
      return (
        first &&
        !first.canonicalOnly &&
        (first.canonical.ino !== e.canonical.ino || first.overlay.ino !== e.overlay.ino)
      )
    })
    .map((e) => e.name)
  result.phases.push({
    phase,
    entryCount: identity.length,
    canonicalOnly: identity.filter((e) => e.canonicalOnly).map((e) => e.name),
    changedIdentityNames: changed,
    detached: [],
  })
  result.identity = identity
  if (changed.includes('auth.json') || changed.some((n) => /\.sqlite$/.test(n)))
    throw new Error('canonical auth/main database inode replaced')
}
const stop = async () => {
  if (!active) return
  const c = active
  active = null
  await c.close()
  owned.find((v) => v.pid === c.pid).joined = true
}
try {
  // Harden a private helper copy rather than nesting sandbox-exec, which macOS refuses.
  // This keeps the repository's isolatedCommand supervisor and cleanup behavior intact.
  const guarded = ['.codex', '.anyengine', '.claude', '.jinn/secrets', 'Library/Keychains']
    .map((p) => join(realHome, p))
    .flatMap((p) => {
      try {
        return [...new Set([p, realpathSync(p)])]
      } catch {
        return [p]
      }
    })
  const reads = `(deny file-read* ${guarded.map((p) => `(subpath ${JSON.stringify(p)})`).join(' ')})`
  const writes = `(deny file-write*)(allow file-write* (subpath ${JSON.stringify(scratch)}))(allow file-write* (literal "/dev/null"))`
  let source = readFileSync(join(repo, 'scripts/lib/codex-probe.mjs'), 'utf8')
  const defaultMarker = "    '(version 1)(allow default)',"
  const isolatedMarker = 'PROBE_POLICY: `(version 1)(allow default)(deny network*)'
  if (source.split(defaultMarker).length !== 2 || source.split(isolatedMarker).length !== 2)
    throw new Error('probe helper policy shape changed; review required')
  source = source
    .replace(
      defaultMarker,
      `${defaultMarker}\n    ${JSON.stringify(reads)},\n    ${JSON.stringify(writes)},`,
    )
    .replace(isolatedMarker, `PROBE_POLICY: \`(version 1)(allow default)${reads}(deny network*)`)
  writeFileSync(join(scratch, 'codex-probe.mjs'), source)
  copyFileSync(
    join(repo, 'scripts/lib/codex-probe-runner.mjs'),
    join(scratch, 'codex-probe-runner.mjs'),
  )
  helpers = await import(pathToFileURL(join(scratch, 'codex-probe.mjs')).href)
  const { writeFakeChatgptAuth, fakeJwt } = await import(
    pathToFileURL(join(repo, 'scripts/lib/fake-chatgpt-auth.mjs')).href
  )
  const { AppServerClient } = await import(
    pathToFileURL(join(repo, 'dist/src/smoke-client.mjs')).href
  )
  const binary = await helpers.probeCodex(repo, values.codex)
  if (!binary) throw new Error('no bundled Codex; supply --codex')
  phase = 'version'
  const version = helpers.isolatedCommand(binary, ['--version'], { timeoutMs: 3000 })
  if (/cleanup failed|ownership unknown/.test(version.stderr)) isolatedCleanupOk = false
  if (version.status !== 0) throw new Error('isolated official version probe failed')
  result.version = /^codex-cli\s+(\S+)\s*$/m.exec(version.stdout)?.[1]
  if (!result.version) throw new Error('official version unavailable')
  phase = 'schema'
  const generated = helpers.isolatedCommand(
    binary,
    ({ work }) => ['app-server', 'generate-json-schema', '--experimental', '--out', work],
    {
      timeoutMs: 12000,
      read: ({ work }, answer) => {
        if (answer.status !== 0) return null
        const found = {}
        const wanted =
          /^(GetAccountParams|GetAccountResponse|GetAccountRateLimitsParams|GetAccountRateLimitsResponse|GetAuthStatusParams|GetAuthStatusResponse|Account|AccountUpdatedNotification|AccountRateLimitsUpdatedNotification|AuthMode|PlanType|RateLimitSnapshot|RateLimitWindow|RateLimitResetCredit|RateLimitResetCreditsSummary|RateLimitResetType|RateLimitResetCreditStatus|RateLimitReachedType|SpendControlLimitSnapshot|CreditsSnapshot|TurnError|CodexErrorInfo|ErrorNotification|ConfigValueWriteParams|ConfigWriteResponse|ThreadInjectItemsParams)$/
        for (const file of walk(work).filter((p) => p.endsWith('.json'))) {
          const json = JSON.parse(readFileSync(file, 'utf8')),
            name = basename(file, '.json')
          if (wanted.test(name)) found[name] = shape(json)
          for (const [n, v] of Object.entries(json.definitions ?? json.$defs ?? {}))
            if (wanted.test(n)) found[n] = shape(v)
          const scan = (o) => {
            if (!o || typeof o !== 'object') return
            if (o.properties?.method?.enum?.includes('thread/inject_items'))
              found.ThreadInjectItemsMethod = shape(o)
            for (const v of Object.values(o)) if (typeof v === 'object') scan(v)
          }
          scan(json)
        }
        return { fields: found }
      },
    },
  )
  if (/cleanup failed|ownership unknown/.test(generated.stderr)) isolatedCleanupOk = false
  if (generated.status !== 0 || !generated.value?.fields.ThreadInjectItemsMethod)
    throw new Error('supported zero-generation thread persistence unavailable')
  result.schema = generated.value.fields
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    serverRequests.push({ method: req.method, path })
    if (/responses|chat\/completions/.test(path)) result.modelRequests++
    if (req.method === 'GET' && path === '/backend-api/codex/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"models":[]}')
      return
    }
    if (path === '/oauth/token') {
      try {
        let body = Buffer.alloc(0)
        for await (const bytes of req) {
          body = Buffer.concat([body, bytes])
          assert.ok(body.length <= 32 * 1024)
        }
        assert.equal(req.method, 'POST')
        const params = (req.headers['content-type'] ?? '').includes('application/json')
          ? JSON.parse(body.toString('utf8'))
          : Object.fromEntries(new URLSearchParams(body.toString('utf8')))
        assert.equal(params.grant_type, 'refresh_token')
        assert.equal(params.refresh_token, expectedRefresh)
        assert.ok(refreshCalls.length < 2)
        const count = refreshCalls.length + 1
        const claims = {
          exp: Math.floor(Date.now() / 1000) + 3600,
          fixture_rotation: count,
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct-anyengine-probe',
            chatgpt_plan_type: 'pro',
          },
        }
        replacement = {
          access_token: fakeJwt(claims),
          id_token: fakeJwt(claims),
          refresh_token: `rt-fake-rotated-${count}`,
          expires_in: 3600,
          token_type: 'Bearer',
        }
        refreshCalls.push({
          initialFakeRefresh: count === 1,
          previousRotatedFakeRefresh: count === 2,
        })
        expectedRefresh = replacement.refresh_token
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(replacement))
        return
      } catch {
        refreshFailed = true
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"refusing zero-generation fixture"}')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}`
  writeFakeChatgptAuth(dirs.canonical)
  writeFileSync(
    join(dirs.canonical, 'config.toml'),
    `model="gpt-5.4"\nopenai_base_url="${url}/backend-api/codex"\nchatgpt_base_url="${url}/backend-api/"\nnotify=[]\n[mcp_servers]\n`,
  )
  const launch = async (home) => {
    const policy = captureSandboxPolicy(scratch, binary, join(realHome, '.codex'), guarded)
    const env = {
      HOME: dirs.home,
      CODEX_HOME: home,
      TMPDIR: dirs.tmp,
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      RUST_LOG: 'error',
      CLAUDE_CONFIG_DIR: join(dirs.home, '.claude'),
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${url}/oauth/token`,
    }
    active = new AppServerClient(
      spawn(helpers.SANDBOX_EXEC, ['-p', policy, binary, 'app-server'], {
        cwd: dirs.work,
        env,
        stdio: 'pipe',
        detached: true,
      }),
    )
    childStderr = ''
    active.child.stderr.on('data', (bytes) => {
      childStderr = `${childStderr}${bytes.toString('utf8')}`.slice(-16 * 1024)
    })
    owned.push({
      pid: active.pid,
      phase: home === dirs.canonical ? 'canonical' : 'overlay',
      joined: false,
    })
    await active.initialize()
  }
  phase = 'canonical-bootstrap'
  await launch(dirs.canonical)
  const started = await active.request('thread/start', { cwd: dirs.work, ephemeral: false }, 12000)
  const id = started.thread?.id
  if (!id || started.thread.ephemeral !== false) throw new Error('canonical warmup thread missing')
  result.warmup = { ephemeral: false, turns: started.thread.turns?.length }
  // 0.160.0 does not persist an empty thread. This official RPC creates durable
  // fake history without starting a turn, also initializing thread_history DB.
  await active.request(
    'thread/inject_items',
    {
      threadId: id,
      items: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Zero-generation fixture item.' }],
        },
      ],
    },
    12000,
  )
  result.injectedUserItem = true
  // Shell snapshots initialize asynchronously after thread/start. Keep the
  // canonical family alive until that supported state directory exists.
  const warmupDeadline = Date.now() + 2000
  for (;;) {
    try {
      if (lstatSync(join(dirs.canonical, 'shell_snapshots')).isDirectory()) break
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    if (Date.now() >= warmupDeadline) throw new Error('canonical shell snapshot warmup incomplete')
    await new Promise((done) => setTimeout(done, 20))
  }
  await stop()
  for (const name of readdirSync(dirs.canonical))
    symlinkSync(join(dirs.canonical, name), join(dirs.overlay, name))
  inspect('warmup-linked')
  phase = 'overlay-initialize'
  await launch(dirs.overlay)
  inspect('overlay-initialized')
  for (let n = 0; n < 2; n++) {
    phase = `auth-refresh-${n + 1}`
    const request = { includeToken: true, refreshToken: true }
    const auth = await active.request('getAuthStatus', request, 12000)
    result.authObservation = {
      refreshFailed,
      refreshCount: refreshCalls.length,
      expectedMethod: auth.authMethod === 'chatgpt',
      requiresOpenaiAuth: auth.requiresOpenaiAuth,
      replacementBearer: Boolean(replacement && auth.authToken === replacement.access_token),
    }
    assert.equal(refreshFailed, false)
    assert.equal(refreshCalls.length, n + 1)
    assert.equal(auth.authMethod, 'chatgpt')
    assert.equal(auth.requiresOpenaiAuth, true)
    assert.equal(auth.authToken, replacement.access_token)
    // Only generated fake auth is read; no live account directory is inspected.
    const own = JSON.parse(readFileSync(join(dirs.canonical, 'auth.json'), 'utf8'))
    assert.equal(own.tokens?.access_token, replacement.access_token)
    assert.equal(own.tokens?.refresh_token, replacement.refresh_token)
    inspect(`auth-refresh-${n + 1}`)
    result.authRefresh.push({
      request,
      keys: Object.keys(auth).sort(),
      authMethod: auth.authMethod,
      authTokenType: typeof auth.authToken,
      requiresOpenaiAuth: auth.requiresOpenaiAuth,
      returnsReplacementBearer: true,
      canonicalChainUpdated: true,
      symlinkPreserved: true,
      canonicalInodePreserved: true,
    })
  }
  phase = 'overlay-resume'
  const resumed = await active.request('thread/resume', { threadId: id }, 12000)
  result.threadVisibleInSecondChild = resumed.thread?.id === id
  if (!result.threadVisibleInSecondChild)
    throw new Error('canonical thread not visible to overlay child')
  inspect('overlay-resumed')
  phase = 'overlay-thread-start'
  const second = await active.request('thread/start', { cwd: dirs.work, ephemeral: false }, 12000)
  result.overlayThreadStarted =
    typeof second.thread?.id === 'string' && second.thread.ephemeral === false
  inspect('overlay-thread-started')
  phase = 'config-write'
  const wrote = await active.request(
    'config/value/write',
    {
      keyPath: 'model_reasoning_effort',
      value: 'low',
      mergeStrategy: 'replace',
      filePath: null,
      expectedVersion: null,
    },
    12000,
  )
  result.configWrite = { status: wrote.status, versionPresent: typeof wrote.version === 'string' }
  result.canonicalConfigUpdated = readFileSync(
    join(dirs.canonical, 'config.toml'),
    'utf8',
  ).includes('model_reasoning_effort = "low"')
  inspect('config-written')
  await stop()
  // Quiet-boundary inventory: never fabricate, unlink, merge or replace DB sidecars.
  for (const name of readdirSync(dirs.canonical)) {
    try {
      lstatSync(join(dirs.overlay, name))
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      symlinkSync(join(dirs.canonical, name), join(dirs.overlay, name))
    }
  }
  inspect('quiet-reconciled')
  if (
    result.modelRequests !== 0 ||
    !result.canonicalConfigUpdated ||
    !result.overlayThreadStarted ||
    wrote.status !== 'ok' ||
    refreshCalls.length !== 2
  )
    throw new Error('acceptance missing')
  result.pass = true
} catch (e) {
  result.failurePhase = phase
  result.failure =
    e.code === 'ERR_ASSERTION'
      ? 'capture assertion failed'
      : String(e.message ?? e)
          .replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/g, '<fixture-id>')
          .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<fake-jwt>')
          .replace(/\b(?:sk-|rt-)[A-Za-z0-9_-]+/g, '<fake-token>')
          .split(scratch)
          .join('<fake-home>')
  if (childStderr) {
    result.failureStderr = childStderr
      .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<fake-jwt>')
      .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
      .replace(/\b(?:sk-|rt-)[A-Za-z0-9_-]+/g, '<fake-token>')
      .split(scratch)
      .join('<fake-home>')
      .split(realHome)
      .join('<real-home>')
  }
} finally {
  try {
    await stop()
  } catch {
    cleanupOk = false
    result.failure = 'owned family cleanup failed'
  }
  if (server) await new Promise((done) => server.close(done))
  result.requests = serverRequests
  result.refreshCalls = refreshCalls
  result.children = owned.map((c) => ({ phase: c.phase, joined: c.joined }))
  result.cleanupOk = cleanupOk && isolatedCleanupOk && owned.every((c) => c.joined)
  result.finishedAt = new Date().toISOString()
  const current = lstatSync(scratch)
  if (current.dev !== scratchIdentity.dev || current.ino !== scratchIdentity.ino)
    result.cleanupOk = false
  result.scratchRemoved = result.cleanupOk
  if (!result.cleanupOk) result.pass = false
  if (result.cleanupOk) rmSync(scratch, { recursive: true, force: true })
  if (oldTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = oldTmp
  if (result.pass && result.cleanupOk) {
    const out = resolve(
      values.out ?? join(repo, 'test/fixtures', `codex-accounts-${result.version}.json`),
    )
    const mains = result.identity
      .filter((e) => /\.sqlite$/.test(e.name))
      .map((e) => e.name)
      .sort()
    const fixture = {
      codexVersion: result.version,
      protocol: [
        'initialize',
        'initialized',
        'thread/start',
        'thread/inject_items',
        'getAuthStatus',
        'thread/resume',
        'config/value/write',
      ],
      bootstrap: {
        ephemeral: false,
        turnStartCalls: 0,
        persistedBy: 'thread/inject_items',
        shellSnapshotDirectoryObserved: true,
      },
      overlay: {
        threadVisibleInSecondChild: result.threadVisibleInSecondChild,
        threadStartSucceeded: result.overlayThreadStarted,
        authSymlinkPreserved: true,
        configSymlinkPreserved: true,
        authInodePreserved: true,
        configAlwaysShared: true,
        canonicalConfigInodePreserved: !result.phases.some((p) =>
          p.changedIdentityNames.includes('config.toml'),
        ),
        databaseMains: mains,
        allMainInodesShared: true,
        allExistingSidecarsShared: true,
        canonicalOnlySidecarsAllowed: true,
        detachedEntries: [],
        collisions: [],
        quietBoundaryReconciled: true,
      },
      authRefresh: { calls: result.authRefresh, refreshRequests: result.refreshCalls },
      configWrite: { ...result.configWrite, canonicalConfigUpdated: result.canonicalConfigUpdated },
      modelsCacheExercised: result.identity.some((e) => e.name === 'models_cache.json'),
      zeroModelEndpointRequests: result.modelRequests === 0,
      cleanup: {
        directChildrenJoined: result.children.every((c) => c.joined),
        processGroupsJoined: true,
        fakeHomesRemoved: true,
      },
      schema: result.schema,
    }
    writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    console.log(
      `PASS fake Codex accounts ${result.version}: two auth rotations, shared state/config, zero model calls; all children joined`,
    )
  } else {
    console.error(
      `FAIL fake Codex accounts capture (${result.failurePhase ?? 'cleanup'}): ${result.failure ?? 'cleanup failed'}`,
    )
    if (result.failureStderr) console.error(result.failureStderr)
    if (result.authObservation) console.error(JSON.stringify(result.authObservation))
    if (!result.cleanupOk)
      console.error('Private fake-home evidence retained because cleanup ownership is unknown')
  }
  process.exitCode = result.pass ? 0 : 1
}
