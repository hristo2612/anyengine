import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'

// A stand-in for chatgpt.com/backend-api/codex: GET /models, POST /responses
// (SSE) and a WebSocket on /responses that answers every response.create
// frame with a PONG. Records everything it received, raw.

export interface RecordedRequest {
  method: string
  path: string
  query: string
  headers: IncomingHttpHeaders
  raw: Buffer
}

export interface FakeBackend {
  port: number
  url: string
  requests: RecordedRequest[]
  upgrades: { path: string; headers: IncomingHttpHeaders }[]
  frames: string[]
  models: unknown[]
  etag: string
  respond: ((req: RecordedRequest, res: ServerResponse) => void) | null
  failModels: number | null
  close(): Promise<void>
}

export function gptEntry(
  slug: string,
  priority: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: `${slug} upstream`,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'medium', description: 'm' }],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    context_window: 272000,
    multi_agent_version: 'v2',
    ...extra,
  }
}

export function ssePong(res: ServerResponse, model: string, text = 'PONG'): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const item = {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  const response = {
    id: 'resp_fake',
    object: 'response',
    status: 'completed',
    model,
    output: [item],
  }
  let seq = 0
  const send = (type: string, payload: Record<string, unknown>) =>
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`,
    )
  send('response.created', { response: { ...response, status: 'in_progress', output: [] } })
  send('response.output_item.done', { output_index: 0, item })
  send('response.completed', { response })
  res.end()
}

export async function startFakeBackend(): Promise<FakeBackend> {
  const state: Omit<FakeBackend, 'port' | 'url' | 'close'> = {
    requests: [],
    upgrades: [],
    frames: [],
    models: [gptEntry('gpt-6-astra', 2), gptEntry('gpt-6-sol', 5), gptEntry('gpt-6-luna', 9)],
    etag: '"upstream-1"',
    respond: null,
    failModels: null,
  }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x')
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.search,
        headers: req.headers,
        raw: Buffer.concat(chunks),
      }
      state.requests.push(recorded)
      if (url.pathname.endsWith('/models')) {
        if (state.failModels) {
          res.writeHead(state.failModels)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', etag: state.etag })
        res.end(JSON.stringify({ models: state.models }))
        return
      }
      if (state.respond) {
        state.respond(recorded, res)
        return
      }
      if (req.method === 'POST' && url.pathname.endsWith('/responses')) {
        let model = 'unknown'
        try {
          model = JSON.parse(recorded.raw.toString('utf8')).model ?? model
        } catch {}
        ssePong(res, model)
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x')
    state.upgrades.push({ path: url.pathname, headers: req.headers })
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, isBinary) => {
        const text = isBinary ? '' : data.toString()
        state.frames.push(text)
        let model = 'unknown'
        try {
          model = JSON.parse(text).model ?? model
        } catch {}
        for (const type of [
          'response.created',
          'response.output_item.done',
          'response.completed',
        ]) {
          ws.send(JSON.stringify({ type, response: { id: 'resp_ws', model, status: 'completed' } }))
        }
      })
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const fake = Object.assign(state, {
    port,
    url: `http://127.0.0.1:${port}/backend-api/codex`,
    close: async () => {
      for (const client of wss.clients) client.terminate()
      const closed = new Promise<void>((ok) => server.close(() => ok()))
      // A response a test left open (a held stream) must not hold up after().
      server.closeAllConnections()
      await closed
    },
  })
  return fake
}
