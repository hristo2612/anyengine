// Catalog capabilities are authorized by the current in-memory broker lease.
// The one on-disk projection is diagnostic only and is never read for routing.
import http from 'node:http'
import https from 'node:https'
import { join } from 'node:path'
import { writeJsonAtomic } from './anyengine-config.mjs'
import type { AccountAdmission, BrokerLease, BrokerOwner, TokenBroker } from './broker-types.mjs'
import { type GptCatalogSnapshot, type GptSettingsView, selectGptModels } from './claude-models.mjs'
import { decodeBody, MAX_HEADER_BYTES, relayAgent } from './router-relay.mjs'
import type { Obj } from './vendor/claude-code-proxy/types.mjs'

export interface GptCatalogs {
  get(lease: BrokerLease, signal: AbortSignal): Promise<GptCatalogSnapshot>
  invalidate(): void
}
const MAX_BYTES = 8 * 1024 * 1024
const fail = (code = 'unavailable') => new Error(`catalog.${code}`)
const leaseKey = (lease: BrokerLease) =>
  JSON.stringify([lease.generation, lease.sourceId, lease.sourceRevision, lease.cacheRevision])

// A loopback origin is an explicit test seam, never an ambient proxy override.
export function gptTarget(upstream: URL, endpoint: 'models' | 'responses'): URL {
  if (
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    upstream.pathname.replace(/\/$/, '') !== '/backend-api/codex' ||
    !(
      (upstream.protocol === 'https:' && upstream.host === 'chatgpt.com') ||
      (upstream.protocol === 'http:' && upstream.hostname === '127.0.0.1')
    )
  )
    throw fail()
  const target = new URL(`${upstream.pathname.replace(/\/$/, '')}/${endpoint}`, upstream.origin)
  // Same query contract as the pinned bundled Codex capture.
  if (endpoint === 'models') target.searchParams.set('client_version', '0.160.0')
  return target
}

async function fetchModels(target: URL, lease: BrokerLease, signal: AbortSignal): Promise<Obj> {
  if (signal.aborted) throw fail('request-aborted')
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http
    const request = transport.request(
      target,
      {
        headers: {
          authorization: `Bearer ${lease.bearer}`,
          'chatgpt-account-id': lease.accountId,
          accept: 'application/json',
          'user-agent': 'anyengine',
          originator: 'codex_cli_rs',
        },
        agent: relayAgent(target),
        maxHeaderSize: MAX_HEADER_BYTES,
        signal,
      },
      async (response) => {
        try {
          if (response.statusCode !== 200) throw fail()
          const chunks: Buffer[] = []
          let size = 0
          for await (const raw of response) {
            const chunk = Buffer.from(raw)
            size += chunk.length
            if (size > MAX_BYTES) throw fail()
            chunks.push(chunk)
          }
          const bytes = decodeBody(
            Buffer.concat(chunks),
            response.headers['content-encoding'],
            MAX_BYTES,
          )
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            !Array.isArray((value as Obj).models)
          )
            throw fail()
          resolve(value as Obj)
        } catch {
          response.destroy()
          reject(signal.aborted ? fail('request-aborted') : fail())
        } finally {
          clearTimeout(timer)
        }
      },
    )
    const timer = setTimeout(() => request.destroy(fail()), 8_000)
    request.once('error', () => {
      clearTimeout(timer)
      reject(signal.aborted ? fail('request-aborted') : fail())
    })
    request.end()
  })
}

interface Flight {
  key: string
  epoch: number
  controller: AbortController
  promise: Promise<GptCatalogSnapshot>
  reject(error: Error): void
  waiters: number
}

export function createGptCatalogs(input: {
  broker: TokenBroker
  owner: BrokerOwner
  upstream: URL
  root: string
  now?: () => number
}): GptCatalogs {
  const now = input.now ?? Date.now
  let epoch = 0
  let cached: { key: string; snapshot: GptCatalogSnapshot } | null = null
  let inflight: Flight | null = null
  function invalidate() {
    epoch++
    cached = null
    const previous = inflight
    inflight = null
    previous?.reject(fail('source-changed'))
    previous?.controller.abort()
  }
  input.owner.onChange(invalidate)
  function current(lease: BrokerLease, started: number): boolean {
    return epoch === started && input.broker.isCurrent(lease)
  }
  function start(lease: BrokerLease): Flight {
    let resolve!: (snapshot: GptCatalogSnapshot) => void
    let reject!: (error: Error) => void
    const flight: Flight = {
      key: leaseKey(lease),
      epoch,
      controller: new AbortController(),
      waiters: 0,
      promise: new Promise((yes, no) => {
        resolve = yes
        reject = no
      }),
      reject: (error) => reject(error),
    }
    inflight = flight
    void (async () => {
      if (!current(lease, flight.epoch)) throw fail('source-changed')
      const models = selectGptModels(
        await fetchModels(gptTarget(input.upstream, 'models'), lease, flight.controller.signal),
      )
      if (!current(lease, flight.epoch) || inflight !== flight) throw fail('source-changed')
      const snapshot: GptCatalogSnapshot = Object.freeze({
        generation: lease.generation,
        sourceId: lease.sourceId,
        sourceRevision: lease.sourceRevision,
        cacheRevision: lease.cacheRevision,
        fetchedAt: now(),
        models: Object.freeze(
          models.map((model) => {
            Object.freeze(model.efforts)
            return Object.freeze(model)
          }),
        ),
      })
      writeJsonAtomic(join(input.root, 'router/claude-gpt-catalog.json'), snapshot)
      if (!current(lease, flight.epoch)) throw fail('source-changed')
      cached = { key: flight.key, snapshot }
      resolve(snapshot)
    })()
      .catch(() => reject(current(lease, flight.epoch) ? fail() : fail('source-changed')))
      .finally(() => {
        if (inflight === flight) inflight = null
      })
    return flight
  }
  function wait(flight: Flight, signal: AbortSignal): Promise<GptCatalogSnapshot> {
    flight.waiters++
    let abort = () => {}
    return new Promise<GptCatalogSnapshot>((resolve, reject) => {
      abort = () => reject(fail('request-aborted'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      flight.promise.then(resolve, reject)
    }).finally(() => {
      signal.removeEventListener('abort', abort)
      // One disconnected caller must not cancel another caller's catalog.
      flight.waiters--
      if (flight.waiters === 0 && inflight === flight && signal.aborted) {
        inflight = null
        flight.controller.abort()
      }
    })
  }
  return {
    invalidate,
    async get(lease, signal) {
      if (signal.aborted) throw fail('request-aborted')
      if (!input.broker.isCurrent(lease)) throw fail('source-changed')
      const key = leaseKey(lease)
      const age = cached ? now() - cached.snapshot.fetchedAt : -1
      if (cached?.key === key && age >= 0 && age < 300_000) return cached.snapshot
      if (inflight && inflight.key !== key) invalidate()
      const selected = inflight ?? start(lease)
      const snapshot = await wait(selected, signal)
      if (!current(lease, selected.epoch) || signal.aborted) throw fail('source-changed')
      return snapshot
    },
  }
}

export async function readGptSettingsView(input: {
  admission: AccountAdmission
  broker: TokenBroker
  catalogs: GptCatalogs
  signal: AbortSignal
}): Promise<GptSettingsView> {
  const admitted = await input.admission.begin(input.signal)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const lease = await input.broker.get()
        if (lease.generation !== admitted.generation) throw fail('source-changed')
        const snapshot = await input.catalogs.get(lease, input.signal)
        if (
          input.signal.aborted ||
          !input.broker.isCurrent(lease) ||
          snapshot.generation !== admitted.generation ||
          snapshot.sourceId !== lease.sourceId ||
          snapshot.sourceRevision !== lease.sourceRevision ||
          snapshot.cacheRevision !== lease.cacheRevision
        )
          throw fail('source-changed')
        return {
          generation: snapshot.generation,
          fetchedAt: snapshot.fetchedAt,
          models: snapshot.models,
        }
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof Error &&
          ['broker.source-changed', 'catalog.source-changed'].includes(error.message) &&
          !input.signal.aborted
        )
          continue
        throw error
      }
    }
    throw fail('source-changed')
  } finally {
    await admitted.release()
  }
}
