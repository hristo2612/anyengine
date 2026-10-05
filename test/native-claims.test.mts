import assert from 'node:assert/strict'
import test from 'node:test'
import type { UpstreamThreadInfo } from '../src/codex-mux.mjs'
import { CodexUpstream } from '../src/codex-upstream.mjs'
import { NativeClaims } from '../src/native-claims.mjs'
import { DEFAULT_POSTURE, type Posture, STRICTEST_POSTURE } from '../src/posture.mjs'

// The real claim tracker with only the external RPC boundary controlled.
function claimsForLineage() {
  const upstream = new CodexUpstream({ binary: process.execPath, args: [], onMessage: () => {} })
  const threads = new Map<string, UpstreamThreadInfo>()
  const claims = new NativeClaims(
    upstream,
    threads,
    () => {},
    (id) => threads.has(id),
  )
  const loose: Posture = {
    ...DEFAULT_POSTURE,
    approval: 'never',
    trust: 'trusted',
    fileSystem: {
      kind: 'workspace-write',
      writableRoots: [],
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
    },
  }
  threads.set('p', { cwd: process.cwd(), model: 'gpt-6-sol', posture: loose })
  const spawn = (child: string, parent: string) =>
    claims.observeItem({
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      senderThreadId: parent,
      receiverThreadIds: [child],
      model: 'opus',
    })
  return { claims, threads, upstream, loose, spawn }
}

for (const claimChildFirst of [false, true]) {
  test(`claims: three generations inherit effective tightening, child claimed first=${claimChildFirst}`, () => {
    const { claims, threads, loose, spawn } = claimsForLineage()
    spawn('c', 'p')
    threads.get('p')!.posture = { ...loose, fileSystem: { kind: 'read-only' } }
    if (claimChildFirst) assert.equal(claims.get('c')?.posture.fileSystem.kind, 'read-only')
    spawn('g', 'c')
    assert.equal(claims.get('g')?.posture.fileSystem.kind, 'read-only')
    threads.get('p')!.posture = loose
    assert.equal(
      claims.get('g')?.posture.fileSystem.kind,
      'read-only',
      'ancestor relaxation stays bounded',
    )
    assert.equal(claims.get('c')?.posture.fileSystem.kind, 'read-only')
  })
}

test('claims: deleted ancestors tighten existing and later descendants permanently', () => {
  const { claims, threads, loose, spawn } = claimsForLineage()
  spawn('c', 'p')
  spawn('g', 'c')
  claims.forget('p')
  assert.deepEqual(claims.get('g')?.posture, STRICTEST_POSTURE)
  spawn('later', 'c')
  assert.deepEqual(claims.get('later')?.posture, STRICTEST_POSTURE)
  threads.set('p', { cwd: process.cwd(), model: 'gpt-6-sol', posture: loose })
  assert.deepEqual(claims.get('g')?.posture, STRICTEST_POSTURE)
  assert.deepEqual(claims.get('later')?.posture, STRICTEST_POSTURE)
})

test('claims: cyclic lineage fails closed without recursion or restored permissions', () => {
  const { claims, spawn } = claimsForLineage()
  spawn('c', 'p')
  spawn('p', 'c')
  assert.deepEqual(claims.get('c')?.posture, STRICTEST_POSTURE)
  assert.deepEqual(claims.get('p')?.posture, STRICTEST_POSTURE)
})

test('claims: deletion cancels announcement waits before fallback discovery', async () => {
  const { claims, upstream } = claimsForLineage()
  let reads = 0
  upstream.request = async () => {
    reads++
    return {}
  }
  const waiting = claims.waitFor('deleted', 30_000)
  claims.forget('deleted')
  const settled = await Promise.race([
    waiting,
    new Promise<string>((done) => setImmediate(() => done('still pending'))),
  ])
  claims.stop()
  assert.equal(settled, null, 'deletion settles pending announcement discovery immediately')
  assert.equal(reads, 0, 'deleted waits cannot issue a fallback read')
})

test('claims: deletion invalidates pending fallback reads and prevents stale re-adoption', async () => {
  const { claims, upstream, threads } = claimsForLineage()
  let reply!: (value: unknown) => void
  const response = new Promise<unknown>((done) => {
    reply = done
  })
  let started!: () => void
  const requested = new Promise<void>((done) => {
    started = done
  })
  upstream.request = async (method, params) => {
    assert.equal(method, 'thread/read')
    assert.deepEqual(params, { threadId: 'deleted', includeTurns: false })
    started()
    return response
  }
  const waiting = claims.waitFor('deleted', 0)
  await requested
  claims.forget('deleted')
  const settled = await Promise.race([
    waiting,
    new Promise<string>((done) => setImmediate(() => done('still pending'))),
  ])
  reply({ thread: { id: 'deleted', parentThreadId: 'p', model: 'opus', cwd: process.cwd() } })
  await waiting
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(settled, null, 'deletion settles discovery without waiting for RPC')
  assert.equal(claims.get('deleted'), null)
  assert.equal(threads.has('deleted'), false, 'late RPC cannot recreate thread ownership')
})

test('claims: a response from before deletion cannot restore claimability', async () => {
  const { claims, upstream, threads } = claimsForLineage()
  let reply!: (value: unknown) => void
  const response = new Promise<unknown>((done) => {
    reply = done
  })
  let started!: () => void
  const requested = new Promise<void>((done) => {
    started = done
  })
  upstream.request = async () => {
    started()
    return response
  }
  const waiting = claims.waitFor('deleted', 0)
  await requested
  claims.forget('deleted')
  reply({ thread: { id: 'deleted', parentThreadId: 'p', model: 'opus', cwd: process.cwd() } })
  assert.equal(await waiting, null)
  assert.equal(claims.get('deleted'), null)
  assert.equal(threads.has('deleted'), false)
})

test('claims: tightening only ancestor trust bounds all generations after relaxation', () => {
  const { claims, threads, loose, spawn } = claimsForLineage()
  spawn('c', 'p')
  spawn('g', 'c')
  threads.get('p')!.posture = { ...loose, trust: 'untrusted' }
  assert.equal(claims.get('g')?.posture.trust, 'untrusted')
  threads.get('p')!.posture = loose
  assert.equal(claims.get('g')?.posture.trust, 'untrusted')
  assert.equal(claims.get('c')?.posture.trust, 'untrusted')
})
