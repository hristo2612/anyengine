import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { DEFAULT_CONFIG, enginePaths } from '../src/anyengine-config.mjs'
import { CatalogCache, modelsHook } from '../src/router-catalog.mjs'
import { FanoutMonitor } from '../src/router-fanout.mjs'
import { createRouterLog } from '../src/router-log.mjs'
import { startRouter } from '../src/router-server.mjs'
import { gptEntry } from './helpers/fake-backend.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

const closers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of closers.reverse()) await close()
  await removeTempDirs()
})

async function setup(requireProof = false) {
  const root = await tempDir('catalog-http-')
  let respond: http.RequestListener = (_req, res) =>
    res.end(JSON.stringify({ models: [gptEntry('gpt-a', 1)] }))
  const backend = http.createServer((req, res) => respond(req, res))
  await new Promise<void>((ok) => backend.listen(0, '127.0.0.1', ok))
  closers.push(
    () =>
      new Promise<void>((ok) => {
        backend.close(() => ok())
        backend.closeAllConnections()
      }),
  )
  const port = (backend.address() as import('node:net').AddressInfo).port
  let now = 0
  const fanout = new FanoutMonitor(
    () => DEFAULT_CONFIG,
    requireProof ? root : null,
    undefined,
    () => now,
  )
  const cache = new CatalogCache(join(enginePaths(root).router, 'catalogs.json'))
  const router = await startRouter({
    root,
    log: createRouterLog(join(root, 'test.log')),
    port: 0,
    upstream: `http://127.0.0.1:${port}`,
    hooks: { models: modelsHook(cache, fanout) },
  })
  closers.push(() => router.close(0))
  return {
    root,
    fanout,
    router,
    respond: (handler: http.RequestListener) => {
      respond = handler
    },
    advance: () => {
      now += 11 * 60_000
    },
  }
}

test('catalog HTTP: missing etags cannot hide upstream changes, malformed replies use only the matching cache', async () => {
  const f = await setup()
  const first = await fetch(`${f.router.baseUrl}/models?a=1`)
  const etag = first.headers.get('etag')!
  await first.text()
  f.respond((_req, res) => res.end(JSON.stringify({ models: [gptEntry('gpt-b', 1)] })))
  const changed = await fetch(`${f.router.baseUrl}/models?a=1`, {
    headers: { 'if-none-match': etag },
  })
  assert.equal(changed.status, 200)
  assert.match(await changed.text(), /gpt-b/)
  f.respond((_req, res) => res.end('{"models":[null]}'))
  assert.equal((await fetch(`${f.router.baseUrl}/models?a=2`)).status, 503)
  const cached = await fetch(`${f.router.baseUrl}/models?a=1`)
  assert.equal(cached.status, 200)
  assert.match(await cached.text(), /gpt-b/)
})

test('catalog HTTP: redirects never relay a bearer to another target and request secrets stay out of logs/cache', async () => {
  const f = await setup()
  let redirected = 0
  f.respond((req, res) => {
    if (req.url?.startsWith('/steal')) {
      redirected += 1
      res.end('{}')
      return
    }
    res.writeHead(302, { location: '/steal' })
    res.end()
  })
  const answer = await fetch(`${f.router.baseUrl}/models?opaque=private-query`, {
    headers: { authorization: 'Basic private-token', 'chatgpt-account-id': 'private-account' },
  })
  assert.equal(answer.status, 503)
  assert.equal(redirected, 0)
  f.respond((_req, res) => res.end(JSON.stringify({ models: [gptEntry('gpt-a', 1)] })))
  await (
    await fetch(`${f.router.baseUrl}/models?opaque=private-query`, {
      headers: { authorization: 'Basic private-token', 'chatgpt-account-id': 'private-account' },
    })
  ).text()
  const text = readFileSync(join(enginePaths(f.root).router, 'catalogs.json'), 'utf8')
  assert.ok(!/private-token|private-account|private-query/.test(text))
  assert.ok(
    !/private-token|private-account|private-query/.test(
      readFileSync(join(f.root, 'test.log'), 'utf8'),
    ),
  )
})

test('catalog HTTP: implicit v1 models count as served, including after a conditional response', async () => {
  const f = await setup()
  f.respond((_req, res) =>
    res.end(JSON.stringify({ models: [gptEntry('gpt-a', 1, { multi_agent_version: null })] })),
  )
  const first = await fetch(`${f.router.baseUrl}/models`)
  const etag = first.headers.get('etag')!
  await first.text()
  assert.equal(
    (await fetch(`${f.router.baseUrl}/models`, { headers: { 'if-none-match': etag } })).status,
    304,
  )
  f.advance()
  f.fanout.observeGptBody({
    model: 'gpt-a',
    tools: [{ name: 'collaboration.spawn_agent', parameters: { encrypted: true } }],
  })
  assert.equal(f.fanout.state.path, 'bridge')
})

test('review 4: models refuses GET bodies before touching the upstream', async () => {
  const f = await setup()
  let calls = 0
  f.respond((_req, res) => {
    calls += 1
    res.end(JSON.stringify({ models: [gptEntry('gpt-a', 1)] }))
  })
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      `${f.router.baseUrl}/models`,
      { method: 'GET', headers: { 'content-length': '2' } },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode!))
      },
    )
    req.on('error', reject)
    req.end('{}')
  })
  assert.equal(status, 400)
  assert.equal(calls, 0)
  const next = await fetch(`${f.router.baseUrl}/models`)
  assert.equal(next.status, 200)
  await next.text()
  assert.equal(calls, 1)
})

test('review 4: catalog fetch strips body framing headers even for an empty GET', async () => {
  const f = await setup()
  let seen: http.IncomingHttpHeaders = {}
  f.respond((req, res) => {
    seen = req.headers
    res.end(JSON.stringify({ models: [gptEntry('gpt-a', 1)] }))
  })
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      `${f.router.baseUrl}/models`,
      { headers: { 'content-length': '0', 'content-type': 'application/json' } },
      (res) => {
        res.resume()
        res.on('end', resolve)
      },
    )
    req.on('error', reject)
    req.end()
  })
  assert.equal(seen['content-length'], undefined)
  assert.equal(seen['content-type'], undefined)
})

test('review M10: an unproven router serves the upstream catalog unchanged over HTTP', async () => {
  const f = await setup(true)
  const body = JSON.stringify({ models: [gptEntry('gpt-a', 1)] })
  const answer = await fetch(`${f.router.baseUrl}/models`)
  assert.equal(answer.status, 200)
  assert.equal(await answer.text(), body)
})
