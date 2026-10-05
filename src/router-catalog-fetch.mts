// Catalog fetches use the relay's private agents and never follow redirects
// with a caller's bearer. Bound both the response and the total wait.
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import type { CatalogEntry } from './router-catalog.mjs'
import {
  decodeBody,
  forwardHeaders,
  MAX_HEADER_BYTES,
  relayAgent,
  upstreamTarget,
} from './router-relay.mjs'
import type { RouterContext } from './router-server.mjs'

const MAX_CATALOG_BYTES = 8 * 1024 * 1024
interface FetchedCatalog {
  models: CatalogEntry[]
  etag: string | null
}

export function fetchCatalog(
  ctx: RouterContext,
  req: IncomingMessage,
  res: ServerResponse,
  query: string,
): Promise<FetchedCatalog | null> {
  const target = upstreamTarget(ctx.upstream(), '/models', query)
  if (!target || res.destroyed) return Promise.resolve(null)
  const headers = forwardHeaders(req.headers)
  delete headers['content-length']
  delete headers['content-type']
  delete headers['if-none-match']
  delete headers['if-modified-since']
  delete headers['accept-encoding']
  return new Promise((resolve) => {
    let done = false
    const finish = (result: FetchedCatalog | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      res.off('close', onClose)
      resolve(result)
    }
    const fail = (code: string) => {
      if (done) return
      ctx.health.lastError = `models: ${code}`
      ctx.health.lastErrorAt = new Date().toISOString()
      ctx.log.error('models.upstream', { code })
      finish(null)
    }
    const transport = target.protocol === 'https:' ? https : http
    const upstream = transport.request(
      target,
      { headers, agent: relayAgent(target), maxHeaderSize: MAX_HEADER_BYTES },
      (answer) => {
        if (answer.statusCode !== 200) {
          fail(`HTTP_${answer.statusCode ?? 0}`)
          answer.destroy()
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        answer.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_CATALOG_BYTES) {
            fail('TOO_LARGE')
            answer.destroy()
          } else chunks.push(chunk)
        })
        answer.on('error', () => fail('INCOMPLETE'))
        answer.on('end', () => {
          if (done) return
          try {
            const raw = decodeBody(
              Buffer.concat(chunks),
              answer.headers['content-encoding'],
              MAX_CATALOG_BYTES,
            )
            const body = JSON.parse(raw.toString('utf8'))
            if (
              !Array.isArray(body?.models) ||
              !body.models.every(
                (m: unknown) =>
                  m && typeof m === 'object' && typeof (m as CatalogEntry).slug === 'string',
              )
            )
              throw new Error('shape')
            ctx.health.lastOkAt = new Date().toISOString()
            finish({ models: body.models, etag: answer.headers.etag ?? null })
          } catch {
            fail('INVALID_CATALOG')
          }
        })
      },
    )
    const onClose = () => {
      finish(null)
      upstream.destroy()
    }
    const timer = setTimeout(() => {
      fail('TIMEOUT')
      upstream.destroy()
    }, 8000)
    res.once('close', onClose)
    upstream.on('error', () => fail('CONNECTION_FAILED'))
    upstream.end()
  })
}
