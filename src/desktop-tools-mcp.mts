// Advertise Desktop's tools to the official Claude client. Desktop executes them;
// this server never performs actions, even if the client calls a tool early.
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { readBody, readJsonBody, sendJson } from './router-relay.mjs'
import type { Obj } from './vendor/claude-code-proxy/types.mjs'

export async function desktopTools(tools: readonly Obj[]) {
  const token = randomBytes(32).toString('hex')
  const names = new Set(tools.map((tool) => tool.name))
  if (
    names.size !== tools.length ||
    tools.some(
      (tool) =>
        typeof tool.name !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name) ||
        !tool.input_schema ||
        typeof tool.input_schema !== 'object' ||
        Array.isArray(tool.input_schema),
    )
  )
    throw new Error('Invalid Desktop tool definitions')
  const server = http.createServer(async (req, res) => {
    if (
      req.headers.authorization !== `Bearer ${token}` ||
      req.headers.origin ||
      req.url !== '/mcp'
    ) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const read = await readBody(req, 4 * 1024 * 1024)
    if ('refused' in read) {
      res.writeHead(413).end()
      return
    }
    const body = readJsonBody(read.raw, undefined)
    if (!body || typeof body.method !== 'string') {
      res.writeHead(400).end()
      return
    }
    if (!Object.hasOwn(body, 'id')) {
      res.writeHead(202).end()
      return
    }
    let result: unknown
    const params =
      body.params && typeof body.params === 'object' && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {}
    switch (body.method) {
      case 'initialize':
        result = {
          protocolVersion:
            typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'anyengine-desktop', version: '1' },
        }
        break
      case 'tools/list':
        result = {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.input_schema,
          })),
        }
        break
      case 'tools/call':
        result = {
          isError: true,
          content: [{ type: 'text', text: 'Tool execution belongs to Claude Desktop.' }],
        }
        break
      case 'ping':
        result = {}
        break
      default:
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32601, message: 'Method not found' },
        })
        return
    }
    sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Desktop tool server unavailable')
  return {
    config: {
      type: 'http' as const,
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
    },
    names,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
