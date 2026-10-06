// Claude Desktop delegates text to GPT; the existing router owns authentication.
import http, { type IncomingMessage } from 'node:http'
import type { Readable, Writable } from 'node:stream'
import { readConfig } from './anyengine-config.mjs'

const MAX_BYTES = 1024 * 1024
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
export const DESKTOP_TOOLS = [
  {
    name: 'list_models',
    description: 'List GPT models available through AnyEngine and your Codex subscription.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'ask_gpt',
    description:
      'Consult a GPT model when the user asks for GPT or another opinion. Send the question and only the relevant context. Returns a text answer, not an agent with file or shell access. Each call is independent; include prior context for follow-ups. This delegates to GPT; it does not change the Claude conversation model.',
    inputSchema: {
      type: 'object',
      required: ['model', 'prompt'],
      properties: {
        model: { type: 'string', description: 'An exact GPT model id from list_models.' },
        prompt: { type: 'string', description: 'The question or task for GPT.' },
        context: {
          type: 'string',
          description: 'Optional relevant context, sent to GPT with the question.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
] as const

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
export class DesktopClient {
  private readonly origin: string
  constructor(root: string) {
    const { config, errors } = readConfig(root)
    if (errors.length) throw new Error('Invalid AnyEngine configuration; run anyengine doctor.')
    this.origin = `http://127.0.0.1:${config.router.port}`
  }
  private async request(
    path: string,
    signal: AbortSignal,
    body?: object,
  ): Promise<Record<string, any>> {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = http.request(
        `${this.origin}${path}`,
        {
          method: body ? 'POST' : 'GET',
          agent: false,
          signal,
          maxHeaderSize: 16 * 1024,
          headers: body ? { 'content-type': 'application/json' } : {},
        },
        resolve,
      )
      request.once('error', () =>
        reject(
          new Error('AnyEngine router is unavailable; enable AnyEngine and run anyengine doctor.'),
        ),
      )
      request.end(body ? JSON.stringify(body) : undefined)
    })
    const chunks: Buffer[] = []
    let bytes = 0
    try {
      for await (const chunk of response) {
        bytes += chunk.length
        if (bytes > MAX_BYTES) throw new Error('AnyEngine response exceeds the 1 MiB limit.')
        chunks.push(Buffer.from(chunk))
      }
    } finally {
      response.destroy()
    }
    if (response.statusCode !== 200)
      throw new Error(
        `GPT request failed (HTTP ${response.statusCode}); run anyengine doctor or check anyengine limits.`,
      )
    try {
      return record(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
      )
    } catch {
      throw new Error('AnyEngine returned an invalid response.')
    }
  }

  async call(name: string, args: unknown, signal: AbortSignal): Promise<object> {
    const input = record(args)
    if (name === 'list_models') {
      if (Object.keys(input).length) throw new Error('list_models takes no arguments.')
      const result = await this.request('/control/claude-code/models', signal)
      if (!Array.isArray(result.models)) throw new Error('AnyEngine model catalog is unavailable.')
      return {
        models: result.models.map((model) => ({
          id: model.id,
          label: model.label,
          contextWindow: model.contextWindow,
        })),
      }
    }
    if (name !== 'ask_gpt') throw new Error('Unknown AnyEngine tool.')
    if (Object.keys(input).some((key) => !['model', 'prompt', 'context'].includes(key)))
      throw new Error('Unsupported ask_gpt argument.')
    if (typeof input.model !== 'string' || !/^gpt-[a-z0-9][a-z0-9._-]{0,100}$/.test(input.model))
      throw new Error('Choose an exact GPT model id from list_models.')
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 256_000)
      throw new Error('prompt must contain 1–256000 characters.')
    if (
      input.context !== undefined &&
      (typeof input.context !== 'string' || input.context.length > 256_000)
    )
      throw new Error('context must be text of at most 256000 characters.')
    const result = await this.request('/v1/messages', signal, {
      model: input.model,
      stream: false,
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: input.context
            ? `Context:\n${input.context}\n\nQuestion:\n${input.prompt}`
            : input.prompt,
        },
      ],
    })
    const text = Array.isArray(result.content)
      ? result.content
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
      : ''
    if (!text) throw new Error('GPT returned no text answer.')
    return {
      model: input.model,
      text,
      usage: result.usage,
      truncated: result.stop_reason === 'max_tokens',
    }
  }
}

export function runDesktopMcp(
  root: string,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): void {
  const client = new DesktopClient(root)
  const pending = new Map<string | number, AbortController>()
  let buffer = ''
  let closed = false
  const send = (id: unknown, payload: object) => {
    if (!closed) output.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`)
  }
  const stop = () => {
    if (closed) return
    closed = true
    buffer = ''
    for (const controller of pending.values()) controller.abort()
    pending.clear()
    input.destroy()
  }
  const handle = (request: Record<string, any>) => {
    if (request.method === 'notifications/cancelled') {
      pending.get(record(request.params).requestId)?.abort()
      return
    }
    if (request.id === undefined || request.id === null) return
    const id = request.id
    if (typeof id !== 'string' && typeof id !== 'number') return
    const params = record(request.params)
    if (request.method === 'initialize') {
      send(id, {
        result: {
          protocolVersion: PROTOCOLS.includes(params.protocolVersion)
            ? params.protocolVersion
            : '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'anyengine-desktop', version: '1' },
          instructions:
            'Use ask_gpt only when the user requests GPT or another opinion. Claude remains the main conversation model. Only provided text is sent; AnyEngine does not sync this conversation.',
        },
      })
    } else if (request.method === 'ping') send(id, { result: {} })
    else if (request.method === 'tools/list') send(id, { result: { tools: DESKTOP_TOOLS } })
    else if (request.method === 'tools/call') {
      if (pending.has(id) || pending.size >= 8) {
        send(id, {
          error: { code: -32600, message: 'Duplicate request id or too many concurrent calls.' },
        })
        return
      }
      const controller = new AbortController()
      pending.set(id, controller)
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
      void client
        .call(params.name, params.arguments, signal)
        .then(
          (result) =>
            send(id, { result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }),
          (error: unknown) =>
            send(id, {
              result: {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text:
                      error instanceof Error && !(error instanceof TypeError)
                        ? error.message
                        : 'AnyEngine router is unavailable; enable AnyEngine and run anyengine doctor.',
                  },
                ],
              },
            }),
        )
        .finally(() => pending.delete(id))
    } else send(id, { error: { code: -32601, message: 'Method not found.' } })
  }
  input.setEncoding('utf8')
  input.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (Buffer.byteLength(line) > MAX_BYTES) {
        stop()
        return
      }
      try {
        handle(record(JSON.parse(line)))
      } catch {
        send(null, { error: { code: -32700, message: 'Parse error.' } })
      }
    }
    if (Buffer.byteLength(buffer) > MAX_BYTES) stop()
  })
  input.once('close', stop)
  input.once('end', stop)
  input.once('error', stop)
  output.once('error', stop)
}
